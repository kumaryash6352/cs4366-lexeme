import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import Parser from 'tree-sitter'
import C from 'tree-sitter-c'

const DISPLAY_NODES = new Set([
  'break_statement', 'continue_statement', 'declaration', 'do_statement',
  'expression_statement', 'for_statement', 'goto_statement', 'if_statement',
  'return_statement', 'switch_statement', 'while_statement',
])

const parser = new Parser()
parser.setLanguage(C)

function compact(text) {
  return text.replace(/\s+/g, ' ').trim()
}

function fieldText(node, field) {
  return node.childForFieldName(field)?.text
}

function display(node) {
  switch (node.type) {
    case 'if_statement': return { kind: 'condition', text: `if ${compact(fieldText(node, 'condition') ?? '')}` }
    case 'switch_statement': return { kind: 'condition', text: `switch ${compact(fieldText(node, 'condition') ?? '')}` }
    case 'while_statement': return { kind: 'loop', text: `while ${compact(fieldText(node, 'condition') ?? '')}` }
    case 'do_statement': return { kind: 'loop', text: `do … while ${compact(fieldText(node, 'condition') ?? '')}` }
    case 'for_statement': {
      const initializer = compact(fieldText(node, 'initializer') ?? '').replace(/;$/, '')
      const condition = compact(fieldText(node, 'condition') ?? '')
      const update = compact(fieldText(node, 'update') ?? '')
      return { kind: 'loop', text: `for (${initializer}; ${condition}; ${update})` }
    }
    case 'return_statement': return { kind: 'return', text: compact(node.text) }
    case 'break_statement':
    case 'continue_statement':
    case 'goto_statement': return { kind: 'jump', text: compact(node.text) }
    case 'declaration': return { kind: 'declaration', text: compact(node.text) }
    case 'expression_statement': {
      const call = findDescendant(node, 'call_expression')
      return { kind: call ? 'call' : 'statement', text: compact(node.text) }
    }
    default: return { kind: 'statement', text: compact(node.text) }
  }
}

function findDescendant(node, type) {
  if (node.type === type) return node
  for (const child of node.namedChildren) {
    const match = findDescendant(child, type)
    if (match) return match
  }
}

function sourceSpan(file, node) {
  return {
    file,
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
    text: compact(node.text),
  }
}

/** Tree-sitter index over original project sources, keyed by compiler locations. */
export class SourceIndex {
  constructor(sourceRoot, maxBytes) {
    this.sourceRoot = resolve(sourceRoot)
    this.maxBytes = maxBytes
    this.files = new Map()
  }

  projectPath(file) {
    if (!file || file.startsWith('@') || file.startsWith('<') || isAbsolute(file)) return undefined
    const path = resolve(this.sourceRoot, file)
    if (path !== this.sourceRoot && !path.startsWith(this.sourceRoot + sep)) return undefined
    return path
  }

  async tree(file) {
    if (this.files.has(file)) return this.files.get(file)
    const promise = (async () => {
      const path = this.projectPath(file)
      if (!path || (await stat(path)).size > this.maxBytes) return undefined
      return parser.parse(await readFile(path, 'utf8'))
    })().catch(() => undefined)
    this.files.set(file, promise)
    return promise
  }

  async statementAt(location) {
    const tree = await this.tree(location.file)
    if (!tree || !Number.isInteger(location.line) || location.line < 1) return undefined
    const point = { row: location.line - 1, column: Math.max(0, (location.column ?? 1) - 1) }
    let node = tree.rootNode.descendantForPosition(point)
    while (node && !DISPLAY_NODES.has(node.type)) node = node.parent
    if (!node) return undefined
    return { ...display(node), source: sourceSpan(location.file, node) }
  }
}

/** Preserve GCC topology while replacing compiler-oriented labels with source syntax. */
export async function enrichControlFlow(graphs, sourceIndex) {
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      if (node.kind !== 'block') continue
      const statements = []
      for (const location of node.locations) {
        const statement = await sourceIndex.statementAt(location)
        if (statement && !statements.some(item => item.source.file === statement.source.file &&
          item.source.startLine === statement.source.startLine && item.source.startColumn === statement.source.startColumn)) {
          statements.push(statement)
        }
      }
      if (!statements.length) continue
      node.rawLabel = node.label
      node.label = statements.slice(0, 4).map(statement => statement.text).join('\n')
      node.semanticKind = statements.find(statement => ['condition', 'loop', 'return'].includes(statement.kind))?.kind ?? statements[0].kind
      node.source = statements[0].source
      node.sourceSpans = statements.map(statement => statement.source)
    }
  }
}
