import type { Node } from 'web-tree-sitter'
import { buildCfg, compact, declaratorName } from './cfg.js'
import { callGraph } from './calls.js'
import type { CallSite } from './calls.js'
import { INTRINSICS, libraryName, ProgramDataflow } from './dataflow.js'
import type { FunctionInput } from './dataflow.js'
import type { AnalysisResult, Diagnostic, FunctionAnalysis, SourceFile, SourceSpan } from './graph-types.js'
import { cParser } from './parser.js'
import { includeGraph, mapPreprocessed, mapRaw, originalTextReader, spanOf } from './source-map.js'
import type { MappedSource } from './source-map.js'

export type * from './graph-types.js'
export { analyzeProject, flagsFromCompileCommands, parseCompilerOutput, selectUnits } from './project.js'
export type { Compiler, UnitSpec, ProjectInput } from './project.js'

export interface UnitInput {
  /** Translation unit (.c file). */
  file: string
  /** GCC -E output with line markers; omit to parse the file unexpanded. */
  preprocessed?: string
  flags?: string[]
}

export interface AnalyzeInput {
  files: SourceFile[]
  units?: UnitInput[]
  /** Shorthand for a single unparsed unit. */
  entryFile?: string
  runtime?: AnalysisResult['runtime']
  diagnostics?: Diagnostic[]
}

const MAX_SYNTAX_ERRORS = 20

interface FoundFunction {
  syntax: Node
  name: string
  file: string
  static: boolean
  units: Set<string>
  span: SourceSpan | undefined
  map: MappedSource
  textOf: (node: Node) => string
}

function signatureOf(fn: Node): string {
  const type = fn.childForFieldName('type')?.text ?? ''
  const declarator = fn.childForFieldName('declarator')?.text ?? ''
  return compact(`${type} ${declarator}`)
}

const isStatic = (fn: Node) => fn.namedChildren.some(c => c?.type === 'storage_class_specifier' && c.text === 'static')

/** Includes in unpreprocessed source: resolve quoted names against the project. */
function rawIncludes(files: SourceFile[], entryFile: string, parse: (text: string) => Node): MappedSource['includes'] {
  const known = new Set(files.map(f => f.path))
  const dir = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
  const normalize = (path: string) => {
    const parts: string[] = []
    for (const part of path.split('/')) {
      if (part === '..') parts.pop()
      else if (part && part !== '.') parts.push(part)
    }
    return parts.join('/')
  }
  const edges: MappedSource['includes'] = []
  const seen = new Set<string>()
  const queue = [entryFile]
  while (queue.length) {
    const from = queue.shift()!
    if (seen.has(from)) continue
    seen.add(from)
    const text = files.find(f => f.path === from)?.text
    if (text === undefined) continue
    for (const include of parse(text).descendantsOfType('preproc_include')) {
      const path = include?.childForFieldName('path')
      if (!path) continue
      const name = path.text.slice(1, -1)
      if (path.type === 'system_lib_string') { edges.push({ from, to: name, system: true }); continue }
      const to = [normalize(dir(from) + name), normalize(name)].find(c => known.has(c)) ?? name
      edges.push({ from, to, system: false })
      if (known.has(to)) queue.push(to)
    }
  }
  return edges
}

/** Analyze one or more translation units as a single program. */
export async function analyze(input: AnalyzeInput): Promise<AnalysisResult> {
  const parser = await cParser()
  const parse = (text: string) => {
    const tree = parser.parse(text)
    if (!tree) throw new Error('Tree-sitter failed to parse the input')
    return tree.rootNode
  }
  const units = input.units ?? (input.entryFile ? [{ file: input.entryFile }] : [])
  const diagnostics: Diagnostic[] = [...(input.diagnostics ?? [])]
  const seenDiagnostics = new Set<string>()
  const userFiles = new Set(input.files.map(f => f.path))
  const fileLines = new Map(input.files.map(f => [f.path, f.text.split('\n')]))
  const includeEdges: MappedSource['includes'] = []
  const globals = new Set<string>()
  const found = new Map<string, FoundFunction>()

  for (const unit of units) {
    const entryText = input.files.find(f => f.path === unit.file)?.text ?? ''
    const map = unit.preprocessed !== undefined ? mapPreprocessed(unit.preprocessed, unit.file) : mapRaw(entryText, unit.file)
    const root = parse(map.text)
    const textOf = originalTextReader(map, fileLines)
    const inUserCode = (node: Node) => {
      const origin = map.rows[node.startPosition.row]
      return origin !== undefined && !origin.system && !origin.file.startsWith('<')
    }

    // Tree-sitter recovers from errors; report those in user code and keep going.
    let reported = 0
    const walk = (node: Node) => {
      if (reported >= MAX_SYNTAX_ERRORS || !node.hasError && !node.isMissing) return
      if ((node.type === 'ERROR' || node.isMissing) && inUserCode(node)) {
        const span = spanOf(map, node.startPosition, node.endPosition)
        const key = `${span?.file}:${span?.line}:${span?.column}`
        if (!seenDiagnostics.has(key)) {
          seenDiagnostics.add(key)
          reported++
          diagnostics.push({
            severity: 'error', stage: 'parse',
            message: node.isMissing ? `Missing ${node.type}` : `Unexpected syntax: ${compact(node.text) || '(empty)'}`,
            ...(span ? { span } : {}),
          })
        }
        return
      }
      for (const child of node.children) if (child) walk(child)
    }
    walk(root)

    includeEdges.push(...(unit.preprocessed !== undefined ? map.includes : rawIncludes(input.files, unit.file, parse)))

    for (const child of root.namedChildren) {
      if (child?.type !== 'declaration' || !inUserCode(child)) continue
      for (const d of child.namedChildren) {
        const target = d?.type === 'init_declarator' ? d.childForFieldName('declarator') : d
        if (!target || !/declarator$|^identifier$/.test(target.type) || target.descendantsOfType('function_declarator').length || target.type === 'function_declarator') continue
        const name = declaratorName(target)
        if (name) globals.add(name)
      }
    }

    for (const fn of root.descendantsOfType('function_definition')) {
      if (!fn || !inUserCode(fn)) continue
      const name = declaratorName(fn.childForFieldName('declarator'))
      if (!name) continue
      const span = spanOf(map, fn.startPosition, fn.endPosition)
      // A function defined in a header appears in every unit that includes it.
      const key = `${span?.file ?? unit.file}:${span?.line ?? fn.startPosition.row}:${name}`
      const existing = found.get(key)
      if (existing) { existing.units.add(unit.file); continue }
      found.set(key, { syntax: fn, name, file: span?.file ?? unit.file, static: isStatic(fn), units: new Set([unit.file]), span, map, textOf })
    }
  }

  // Function ids: plain names, qualified by file where static functions clash.
  const byName = new Map<string, FoundFunction[]>()
  for (const f of found.values()) byName.set(f.name, [...(byName.get(f.name) ?? []), f])
  const ids = new Map<FoundFunction, string>()
  for (const [name, list] of byName) for (const f of list) ids.set(f, list.length > 1 ? `${name} (${f.file})` : name)
  const resolver = (caller: FoundFunction) => (name: string): string | undefined => {
    const candidates = byName.get(name) ?? []
    const local = candidates.find(c => c.static && [...c.units].some(u => caller.units.has(u)))
    return ids.get(local ?? candidates.find(c => !c.static) ?? candidates[0]!)
  }

  const inputs: (FunctionInput & { found: FoundFunction })[] = []
  for (const f of found.values()) {
    const id = ids.get(f)!
    const cfg = buildCfg(f.syntax, id, signatureOf(f.syntax), f.map, f.textOf)
    inputs.push({
      id, cfg, found: f, resolve: resolver(f),
      site: node => {
        const origin = f.map.rows[node.startPosition.row]
        return origin ? `${origin.file}:${origin.line}` : `${f.file}:?`
      },
    })
  }
  // Record each statement's callees (call-graph ids) for navigation between views.
  for (const { cfg, resolve } of inputs) {
    const variables = new Set((cfg.nodes[0]?.params ?? []).filter(Boolean))
    cfg.nodes.forEach((node, i) => {
      if (node.kind === 'entry' || node.kind === 'label' || !node.syntax) return
      const callees = new Set<string>()
      const calls = node.syntax.type === 'call_expression' ? [node.syntax, ...node.syntax.descendantsOfType('call_expression')] : node.syntax.descendantsOfType('call_expression')
      for (const call of calls) {
        const callee = call?.childForFieldName('function')
        if (callee?.type !== 'identifier' || INTRINSICS.has(callee.text) || variables.has(callee.text)) continue
        callees.add(resolve(callee.text) ?? libraryName(callee.text))
      }
      const graphNode = cfg.graph.nodes[i]
      if (callees.size && graphNode) graphNode.calls = [...callees]
    })
  }
  const dataflow = new ProgramDataflow(inputs, globals)

  const functions: FunctionAnalysis[] = inputs.map(({ id, cfg, found: f }) => ({
    id, name: f.name, signature: signatureOf(f.syntax), file: f.file, static: f.static,
    ...(f.span ? { span: f.span } : {}),
    cfg: cfg.graph, data: dataflow.functionGraph(id), summary: dataflow.summaryText(id),
  }))

  const sites: CallSite[] = []
  for (const { id, found: f, cfg } of inputs) {
    const variables = new Set([...(cfg.nodes[0]?.params ?? []).filter(Boolean),
      ...f.syntax.descendantsOfType('init_declarator').map(d => declaratorName(d?.childForFieldName('declarator') ?? null)).filter((n): n is string => n !== undefined)])
    const resolve = resolver(f)
    for (const call of f.syntax.descendantsOfType('call_expression')) {
      const callee = call?.childForFieldName('function')
      if (!callee) continue
      const name = callee.type === 'identifier' ? callee.text : undefined
      if (name && INTRINSICS.has(name)) continue
      const target = !name ? { kind: 'indirect' as const }
        : variables.has(name) ? { kind: 'indirect' as const, name }
        : resolve(name) ? { kind: 'function' as const, id: resolve(name)! }
        : { kind: 'external' as const, name: libraryName(name) }
      sites.push({ caller: id, target })
    }
  }
  const defined = new Map(functions.map(f => [f.id, {
    label: f.id, ...(f.span ? { span: f.span } : {}),
    ...(f.summary.writes.length || f.summary.reads.length ? { detail: `writes ${f.summary.writes.join(', ') || 'nothing shared'}; reads ${f.summary.reads.join(', ') || 'nothing shared'}` } : {}),
  }]))
  if (functions.length === 0) diagnostics.push({ severity: 'warning', stage: 'analysis', message: 'No function definitions found' })

  const primary = units[0]?.file ?? ''
  const includes = includeGraph(includeEdges, primary, userFiles)
  for (const unit of units.slice(1)) if (!includes.nodes.some(n => n.id === unit.file)) includes.nodes.push({ id: unit.file, kind: 'file', label: unit.file, span: { file: unit.file, line: 1, column: 1, endLine: 1, endColumn: 1 } })

  return {
    schemaVersion: 3,
    runtime: input.runtime ?? 'host',
    units: units.map(u => ({ file: u.file, preprocessed: u.preprocessed !== undefined, flags: u.flags ?? [] })),
    files: input.files,
    functions,
    calls: callGraph(defined, sites),
    includes,
    program: dataflow.programGraph(),
    diagnostics,
  }
}
