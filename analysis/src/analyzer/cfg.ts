import type { Node } from 'web-tree-sitter'
import type { Graph, GraphEdge, GraphNode, Region } from './graph-types.js'
import type { MappedSource } from './source-map.js'
import { spanOf } from './source-map.js'

/** A CFG node plus the syntax it stands for, used later for def/use analysis. */
export interface CfgNode extends GraphNode { syntax: Node | undefined; params?: string[] }
export interface Cfg { graph: Graph; nodes: CfgNode[]; preds: Map<string, string[]> }

interface Exit { from: string; kind?: string; label?: string }
interface Scope { breaks: Exit[]; continues: Exit[] | undefined }

const NORETURN = new Set(['exit', '_Exit', 'quick_exit', 'abort', 'longjmp', 'siglongjmp', '__assert_fail', '__assert_rtn', '__builtin_unreachable', '__builtin_trap'])
const LABEL_CHARS = 60

export function compact(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > LABEL_CHARS ? `${flat.slice(0, LABEL_CHARS - 1)}…` : flat
}

/** Unwrap `(expr)` so condition labels read `x < 3` rather than `(x < 3)`. */
function inner(node: Node): Node {
  return node.type === 'parenthesized_expression' && node.namedChildCount === 1 ? node.namedChild(0)! : node
}

function calledName(statement: Node): string | undefined {
  const expr = statement.type === 'expression_statement' ? statement.namedChild(0) : undefined
  if (expr?.type !== 'call_expression') return undefined
  const fn = expr.childForFieldName('function')
  return fn?.type === 'identifier' ? fn.text : undefined
}

export function declaratorName(declarator: Node | null): string | undefined {
  let node = declarator
  while (node && node.type !== 'identifier') {
    node = node.childForFieldName('declarator') ?? node.namedChildren.find(c => c !== null && c.type.endsWith('declarator')) ?? null
  }
  return node?.text
}

export function buildCfg(fn: Node, name: string, signature: string, map: MappedSource, textOf: (node: Node) => string = n => n.text): Cfg {
  const nodes: CfgNode[] = []
  const edges: GraphEdge[] = []
  const labels = new Map<string, string>()
  const gotos: { from: string; label: string }[] = []
  const scopes: Scope[] = []

  const add = (kind: string, syntax: Node | undefined, label: string, at: Node = syntax!): string => {
    const node: CfgNode = { id: `${name}:${nodes.length}`, kind, label: compact(label), syntax }
    // Keep the macro-expanded form available when the label shows the original text.
    if (syntax && kind !== 'entry' && textOf(syntax) !== syntax.text) node.detail = `expands to ${compact(syntax.text)}`
    const span = spanOf(map, at.startPosition, at.endPosition)
    if (span) {
      // Expanded macros shift end columns; measure the original text instead.
      const original = textOf(at)
      if (original !== at.text && !original.includes('\n')) { span.endLine = span.line; span.endColumn = span.column + original.length }
      node.span = span
    }
    nodes.push(node)
    return node.id
  }
  const link = (exits: Exit[], to: string) => {
    for (const exit of exits) {
      const edge: GraphEdge = { source: exit.from, target: to }
      if (exit.kind) edge.kind = exit.kind
      if (exit.label) edge.label = exit.label
      edges.push(edge)
    }
  }
  const flow = (at: string, exits: Exit[]): Exit[] => { link(exits, at); return [{ from: at }] }
  const loop = (body: () => Exit[]) => {
    const scope: Scope = { breaks: [], continues: [] }
    scopes.push(scope)
    const exits = body()
    scopes.pop()
    return { exits, scope }
  }

  // Structured statements become regions: every CFG node created while building one.
  const regions: Omit<Region, 'parent' | 'score'>[] = []
  const STRUCTURED: Record<string, Region['kind']> = {
    if_statement: 'branch', while_statement: 'loop', do_statement: 'loop', for_statement: 'loop', switch_statement: 'switch',
  }
  const header = (node: Node): string => {
    const cond = node.childForFieldName('condition')
    switch (node.type) {
      case 'if_statement': return `if ${cond ? textOf(cond) : ''}`
      case 'while_statement': return `while ${cond ? textOf(cond) : ''}`
      case 'do_statement': return `do … while ${cond ? textOf(cond) : ''}`
      case 'switch_statement': return `switch ${cond ? textOf(cond) : ''}`
      default: {
        const body = node.childForFieldName('body')
        return textOf(node).slice(0, body ? body.startIndex - node.startIndex : undefined).trim()
      }
    }
  }
  const statement = (node: Node, exits: Exit[]): Exit[] => {
    const kind = STRUCTURED[node.type]
    if (!kind) return build(node, exits)
    const start = nodes.length
    const out = build(node, exits)
    if (nodes.length > start) regions.push({ id: `${name}#r${regions.length}`, kind, label: compact(header(node)), nodes: nodes.slice(start).map(n => n.id) })
    return out
  }

  const build = (node: Node, exits: Exit[]): Exit[] => {
    switch (node.type) {
      case 'compound_statement':
        return node.namedChildren.reduce<Exit[]>((acc, child) => child ? statement(child, acc) : acc, exits)
      case 'comment':
        return exits
      case 'expression_statement': {
        if (node.namedChildCount === 0) return exits
        const id = add('statement', node, textOf(node))
        link(exits, id)
        const callee = calledName(node)
        return callee && NORETURN.has(callee) ? [] : [{ from: id }]
      }
      case 'if_statement': {
        const cond = node.childForFieldName('condition')!
        const id = add('condition', inner(cond), textOf(inner(cond)))
        link(exits, id)
        const then = statement(node.childForFieldName('consequence')!, [{ from: id, kind: 'true', label: 'T' }])
        let alt = node.childForFieldName('alternative')
        if (alt?.type === 'else_clause') alt = alt.namedChild(0)
        const otherwise: Exit[] = [{ from: id, kind: 'false', label: 'F' }]
        return [...then, ...(alt ? statement(alt, otherwise) : otherwise)]
      }
      case 'while_statement': {
        const cond = node.childForFieldName('condition')!
        const id = add('condition', inner(cond), `while ${textOf(cond)}`, cond)
        link(exits, id)
        const { exits: body, scope } = loop(() => statement(node.childForFieldName('body')!, [{ from: id, kind: 'true', label: 'T' }]))
        link([...body, ...scope.continues!], id)
        return [{ from: id, kind: 'false', label: 'F' }, ...scope.breaks]
      }
      case 'do_statement': {
        const first = nodes.length
        const { exits: body, scope } = loop(() => statement(node.childForFieldName('body')!, exits))
        const cond = node.childForFieldName('condition')!
        const id = add('condition', inner(cond), `do … while ${textOf(cond)}`, cond)
        link([...body, ...scope.continues!], id)
        // Body entry is the first node created while building the body.
        const entry = nodes[first]?.id !== id ? nodes[first]?.id : undefined
        link([{ from: id, kind: 'true', label: 'T' }], entry ?? id)
        return [{ from: id, kind: 'false', label: 'F' }, ...scope.breaks]
      }
      case 'for_statement': {
        let current = exits
        const init = node.childForFieldName('initializer')
        if (init) current = flow(add('statement', init, textOf(init)), current)
        const cond = node.childForFieldName('condition')
        const condId = cond ? add('condition', cond, `for (${textOf(cond)})`) : undefined
        if (condId) current = flow(condId, current).map(e => ({ ...e, kind: 'true', label: 'T' }))
        const first = nodes.length
        const { exits: body, scope } = loop(() => statement(node.childForFieldName('body')!, current))
        const update = node.childForFieldName('update')
        let tail = [...body, ...scope.continues!]
        if (update) tail = flow(add('statement', update, textOf(update)), tail)
        const head = condId ?? nodes[first]?.id
        if (head) link(tail, head)
        return [...(condId ? [{ from: condId, kind: 'false', label: 'F' }] : []), ...scope.breaks]
      }
      case 'switch_statement': {
        const cond = node.childForFieldName('condition')!
        const id = add('condition', inner(cond), `switch ${textOf(cond)}`, cond)
        link(exits, id)
        const scope: Scope = { breaks: [], continues: scopes.at(-1)?.continues }
        scopes.push(scope)
        let fall: Exit[] = []
        let hasDefault = false
        for (const child of node.childForFieldName('body')?.namedChildren ?? []) {
          if (!child) continue
          if (child.type !== 'case_statement') { fall = statement(child, fall); continue }
          const value = child.childForFieldName('value')
          if (!value) hasDefault = true
          fall = [...fall, { from: id, kind: 'case', label: value ? `case ${textOf(value)}` : 'default' }]
          for (const part of child.namedChildren) if (part && part.startIndex !== value?.startIndex) fall = statement(part, fall)
        }
        scopes.pop()
        return [...fall, ...scope.breaks, ...(hasDefault ? [] : [{ from: id, kind: 'case', label: 'default' }])]
      }
      case 'break_statement': {
        const id = add('jump', node, 'break')
        link(exits, id)
        scopes.at(-1)?.breaks.push({ from: id })
        return []
      }
      case 'continue_statement': {
        const id = add('jump', node, 'continue')
        link(exits, id)
        ;[...scopes].reverse().find(s => s.continues)?.continues?.push({ from: id })
        return []
      }
      case 'return_statement': {
        link(exits, add('return', node, textOf(node)))
        return []
      }
      case 'goto_statement': {
        const id = add('jump', node, textOf(node))
        link(exits, id)
        gotos.push({ from: id, label: node.childForFieldName('label')?.text ?? '' })
        return []
      }
      case 'labeled_statement': {
        const label = node.childForFieldName('label')?.text ?? ''
        const id = add('label', node, `${label}:`, node.childForFieldName('label') ?? node)
        labels.set(label, id)
        link(exits, id)
        const body = node.namedChildren.filter(c => c !== null && c.type !== 'statement_identifier')
        return body.reduce<Exit[]>((acc, c) => statement(c!, acc), [{ from: id }])
      }
      default: {
        // Declarations and anything else run straight through.
        if (!node.isNamed || node.type.startsWith('preproc')) return exits
        const id = add('statement', node, textOf(node))
        link(exits, id)
        return [{ from: id }]
      }
    }
  }

  const declarator = fn.childForFieldName('declarator')
  const entry = add('entry', fn, signature, declarator ?? fn)
  const paramList = declarator?.descendantsOfType('parameter_list')[0]
  nodes[0]!.params = (paramList?.namedChildren ?? [])
    .filter(p => p?.type === 'parameter_declaration')
    // Keep positions (unnamed parameters become '') so argument i maps to parameter i.
    .map(p => declaratorName(p!.childForFieldName('declarator')) ?? '')
  const body = fn.childForFieldName('body')
  if (body) statement(body, [{ from: entry }])
  for (const jump of gotos) {
    const target = labels.get(jump.label)
    if (target) edges.push({ source: jump.from, target, kind: 'goto' })
  }

  const preds = new Map<string, string[]>()
  for (const edge of edges) preds.set(edge.target, [...(preds.get(edge.target) ?? []), edge.source])
  const graph: Graph = {
    regions: finishRegions(name, regions, nodes, edges),
    id: `cfg:${name}`, title: `Control flow: ${name}`, entry,
    nodes: nodes.map(({ syntax: _syntax, params: _params, ...node }) => node), edges,
  }
  return { graph, nodes, preds }
}

/** Parents by containment, straight-line runs, and the complexity score. */
function finishRegions(name: string, structured: Omit<Region, 'parent' | 'score'>[], nodes: CfgNode[], edges: GraphEdge[]): Region[] {
  const kindOf = new Map(nodes.map(n => [n.id, n.kind]))
  const score = (ids: string[]) => ids.length + 2 * ids.filter(id => kindOf.get(id) === 'condition').length
  const regions: Region[] = structured.map(r => ({ ...r, score: score(r.nodes) }))
  const sets = new Map(regions.map(r => [r.id, new Set(r.nodes)]))
  const innermost = (id: string, except?: string) => regions
    .filter(r => r.id !== except && sets.get(r.id)!.has(id))
    .sort((a, b) => a.nodes.length - b.nodes.length)[0]

  // Straight-line runs: single entry, single exit, plain statements, same innermost block.
  const preds = new Map<string, string[]>(), succs = new Map<string, string[]>()
  for (const e of edges) {
    preds.set(e.target, [...(preds.get(e.target) ?? []), e.source])
    succs.set(e.source, [...(succs.get(e.source) ?? []), e.target])
  }
  const plain = (id: string) => kindOf.get(id) === 'statement'
  const seen = new Set<string>()
  for (const n of nodes) {
    if (!plain(n.id) || seen.has(n.id)) continue
    const p = preds.get(n.id) ?? []
    // Start a run only where it cannot extend backwards.
    if (p.length === 1 && plain(p[0]!) && (succs.get(p[0]!) ?? []).length === 1 && innermost(p[0]!)?.id === innermost(n.id)?.id) continue
    const run = [n.id]
    let at = n.id
    for (;;) {
      const next = succs.get(at) ?? []
      if (next.length !== 1) break
      const to = next[0]!
      if (!plain(to) || (preds.get(to) ?? []).length !== 1 || innermost(to)?.id !== innermost(n.id)?.id || run.includes(to)) break
      run.push(to)
      at = to
    }
    run.forEach(id => seen.add(id))
    if (run.length >= 3) {
      const lines = run.map(id => nodes.find(m => m.id === id)?.span?.line).filter((l): l is number => l !== undefined)
      const label = lines.length ? `lines ${Math.min(...lines)}–${Math.max(...lines)}` : `${run.length} statements`
      const region: Region = { id: `${name}#l${regions.length}`, kind: 'lines', label, nodes: run, score: run.length }
      regions.push(region)
      sets.set(region.id, new Set(run))
    }
  }
  for (const r of regions) {
    const parent = regions
      .filter(o => o.id !== r.id && o.nodes.length > r.nodes.length && r.nodes.every(id => sets.get(o.id)!.has(id)))
      .sort((a, b) => a.nodes.length - b.nodes.length)[0]
    if (parent) r.parent = parent.id
  }
  return regions
}
