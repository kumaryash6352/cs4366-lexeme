import { posix } from 'node:path'
import type { Graph, SourceSpan } from './graph-types.js'

export interface Origin { file: string; line: number; system: boolean }

export interface MappedSource {
  /** Parser input: marker lines replaced by blank lines so rows are preserved. */
  text: string
  /** Original location of each row of `text`. */
  rows: Origin[]
  /** Include edges recorded from GCC enter-file markers (flag 1). */
  includes: { from: string; to: string; system: boolean }[]
}

const MARKER = /^#\s*(?:line\s+)?(\d+)\s+"((?:[^"\\]|\\.)*)"((?:\s+\d+)*)\s*$/
const isPseudo = (file: string) => file.startsWith('<')

/** Read GCC/Clang line markers (https://gcc.gnu.org/onlinedocs/cpp/Preprocessor-Output.html). */
export function mapPreprocessed(text: string, entryFile: string): MappedSource {
  const lines = text.split('\n')
  const rows: Origin[] = []
  const includes: MappedSource['includes'] = []
  let file = entryFile
  let line = 1
  let system = false
  const stack: string[] = []
  const out = lines.map(raw => {
    const marker = MARKER.exec(raw)
    if (!marker) {
      rows.push({ file, line, system })
      line++
      return raw
    }
    // GCC reports paths as spelled in #include ("tests/../a.c"); normalize so one file has one name.
    const spelled = marker[2]!.replace(/\\(.)/g, '$1')
    const next = spelled.startsWith('<') ? spelled : posix.normalize(spelled)
    const flags = (marker[3] ?? '').trim().split(/\s+/).filter(Boolean)
    if (flags.includes('1')) {
      if (!isPseudo(file) && !isPseudo(next)) includes.push({ from: file, to: next, system: flags.includes('3') })
      stack.push(file)
    } else if (flags.includes('2')) {
      stack.pop()
    }
    file = next
    line = Number(marker[1])
    system = flags.includes('3')
    rows.push({ file, line: 0, system })
    return ''
  })
  return { text: out.join('\n'), rows, includes }
}

/** Identity mapping for source parsed without preprocessing. */
export function mapRaw(text: string, file: string): MappedSource {
  return { text, rows: text.split('\n').map((_, i) => ({ file, line: i + 1, system: false })), includes: [] }
}

export function spanOf(map: MappedSource, start: { row: number; column: number }, end: { row: number; column: number }): SourceSpan | undefined {
  const a = map.rows[start.row]
  if (!a || isPseudo(a.file)) return undefined
  const b = map.rows[end.row]
  const sameFile = b && b.file === a.file && b.line >= a.line
  return {
    file: a.file, line: a.line, column: start.column + 1,
    endLine: sameFile ? b.line : a.line, endColumn: sameFile ? end.column + 1 : start.column + 1,
  }
}

/** Shorten system header paths to what a user would write in #include <...>. */
export function displayPath(path: string): string {
  const i = path.lastIndexOf('/include/')
  return i >= 0 ? path.slice(i + '/include/'.length) : path
}

export function includeGraph(edges: MappedSource['includes'], entryFile: string, userFiles: Set<string>): Graph {
  const nodes = new Map<string, Graph['nodes'][number]>()
  const add = (path: string, system: boolean) => {
    if (!nodes.has(path)) {
      const node: Graph['nodes'][number] = { id: path, kind: system ? 'system' : 'file', label: system ? `<${displayPath(path)}>` : path }
      if (userFiles.has(path)) node.span = { file: path, line: 1, column: 1, endLine: 1, endColumn: 1 }
      if (system) node.detail = path
      nodes.set(path, node)
    }
  }
  add(entryFile, false)
  const seen = new Set<string>()
  const out: Graph['edges'] = []
  for (const edge of edges) {
    // Headers pulled in by system headers are toolchain detail; keep edges out of user files.
    if (!userFiles.has(edge.from) && edge.from !== entryFile) continue
    add(edge.from, false)
    add(edge.to, edge.system && !userFiles.has(edge.to))
    const key = `${edge.from}\n${edge.to}`
    if (!seen.has(key)) { seen.add(key); out.push({ source: edge.from, target: edge.to, kind: 'include' }) }
  }
  return { id: 'includes', title: 'Include graph', entry: entryFile, nodes: [...nodes.values()], edges: out }
}

const OPEN = '([{'
const CLOSE = ')]}'

/** True when `text` is a single bracketed group: its first bracket closes at the end. */
function wholeGroup(text: string): boolean {
  const trimmed = text.trim()
  if (!OPEN.includes(trimmed[0] ?? '')) return false
  let depth = 0
  let quote = ''
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (OPEN.includes(ch)) depth++
    else if (CLOSE.includes(ch) && --depth === 0) return i === trimmed.length - 1
  }
  return false
}

/** Recover what the user wrote for a node: preprocessed text shows expanded macros
 * (NULL becomes ((void *)0)), so re-read the original file from the node's start and
 * scan to the matching end. Falls back to the expanded text when unsure. */
export function originalTextReader(map: MappedSource, files: Map<string, string[]>) {
  const expandedLines = map.text.split('\n')
  return (node: { text: string; startPosition: { row: number; column: number } }): string => {
    const origin = map.rows[node.startPosition.row]
    const lines = origin && !origin.system ? files.get(origin.file) : undefined
    const first = lines?.[origin!.line - 1]
    if (!lines || first === undefined) return node.text
    if (!node.text.includes('\n') && expandedLines[node.startPosition.row] === first) return node.text
    // Stop at the matching close only when the whole node is one bracketed group, e.g. a
    // condition `(x)`. A statement that merely starts with one, `(*p)->f = v;`, goes on.
    const startsGroup = wholeGroup(node.text)
    const endsStatement = node.text.trimEnd().endsWith(';')
    let depth = 0
    let out = ''
    let quote = ''
    for (let l = origin!.line - 1, c = node.startPosition.column; l < Math.min(lines.length, origin!.line + 20); l++, c = 0) {
      const text = lines[l]!
      if (l !== origin!.line - 1) out += '\n'
      for (; c < text.length; c++) {
        const ch = text[c]!
        if (quote) { out += ch; if (ch === '\\') { out += text[++c] ?? '' } else if (ch === quote) quote = ''; continue }
        if (ch === '"' || ch === "'") { quote = ch; out += ch; continue }
        if (OPEN.includes(ch)) depth++
        else if (CLOSE.includes(ch)) {
          if (depth === 0) return out.trim() || node.text
          depth--
          if (depth === 0 && startsGroup) return out + ch
        } else if (depth === 0 && (ch === ';' || ch === ',') ) {
          return endsStatement && ch === ';' ? out + ch : out.trim() || node.text
        }
        out += ch
      }
    }
    return node.text
  }
}
