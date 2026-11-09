import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { filePath, lineMarker, stableId } from './source-map.mjs'

export function includeSearchPaths(stderr, directory) {
  const quote = [], system = []
  let list
  for (const line of stderr.split('\n')) {
    if (line === '#include "..." search starts here:') list = quote
    else if (line === '#include <...> search starts here:') list = system
    else if (line === 'End of search list.') list = undefined
    else if (list && /^ /.test(line)) list.push(resolve(directory, line.trim()))
  }
  return { quote, system }
}

/** -dI records directives that -H can omit when include guards skip a header. */
export function parseIncludes(text, stderr, context) {
  const search = includeSearchPaths(stderr, context.directory)
  const edges = []
  const systemFiles = new Set()
  let file = context.source, number = 1, pending
  const clean = []
  const add = (from, target, spelling, line, kind) => {
    const source = filePath(from, context)
    const resolved = target ? filePath(target, context) : undefined
    const edge = { id: stableId(context.id, source, resolved, spelling, line, kind), unitId: context.id,
      source, target: resolved ?? `@unresolved/${stableId(source, spelling)}`, spelling, kind,
      resolved: Boolean(target), location: { file: source, line: Math.max(1, line), precision: 'line' } }
    edges.push(edge)
    return edge
  }
  for (const line of text.split('\n')) {
    const marker = lineMarker(line)
    if (marker) {
      if (marker.flags.includes(3)) systemFiles.add(filePath(marker.file, context))
      if (marker.flags.includes(1)) {
        if (pending) {
          pending.target = filePath(marker.file, context)
          pending.resolved = true
          pending = undefined
        } else if (file.startsWith('<') && !marker.file.startsWith('<')) {
          add(context.source, marker.file, marker.file, 1, 'forced')
        }
      }
      // A return without entering means a guarded directive was skipped.
      if (marker.flags.includes(2)) pending = undefined
      file = marker.file
      number = marker.line
      clean.push(line)
      continue
    }
    const directive = /^#\s*(include|include_next)\s+([<"])(.*)[>"]\s*(?:\/\*.*\*\/)?$/.exec(line)
    if (directive) {
      const [, kind, delimiter, spelling] = directive
      const dirs = delimiter === '"' ? [dirname(resolve(context.directory, file)), ...search.quote, ...search.system] : search.system
      // include_next depends on the exact search-chain entry. Only trust a compiler entry event.
      const target = kind === 'include' ? dirs.map(dir => resolve(dir, spelling)).find(path => existsSync(path)) : undefined
      pending = add(file, target, spelling, number, kind)
      clean.push('')
    } else {
      if (line.trim()) pending = undefined
      clean.push(line)
    }
    number++
  }
  return { text: clean.join('\n'), edges, systemFiles: [...systemFiles] }
}
