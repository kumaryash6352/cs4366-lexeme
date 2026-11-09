import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'

export function stableId(...parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)
}

export function filePath(path, context) {
  if (path.startsWith('<')) return path
  const absolute = resolve(context.directory, path)
  const project = relative(context.sourceRoot, absolute)
  if (project !== '..' && !project.startsWith('../') && !isAbsolute(project)) return project || '.'
  const generated = relative(context.workRoot, absolute)
  if (generated !== '..' && !generated.startsWith('../') && !isAbsolute(generated)) return `@generated/${generated}`
  return absolute
}

export function lineMarker(line) {
  const match = /^#\s+(\d+)\s+("(?:[^"\\]|\\.)*")(.*)$/.exec(line)
  if (!match) return undefined
  return { line: Number(match[1]), file: decodeFilename(match[2].slice(1, -1)), flags: match[3].trim().split(/\s+/).filter(Boolean).map(Number) }
}

// GCC filenames use C escapes (including octal bytes), not JSON string syntax.
function decodeFilename(text) {
  const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 }
  const chunks = []
  let offset = 0
  for (const match of text.matchAll(/\\([0-7]{1,3}|[abfnrtv"\\])/g)) {
    chunks.push(Buffer.from(text.slice(offset, match.index)))
    chunks.push(Buffer.from([escapes[match[1]] ?? Number.parseInt(match[1], 8)]))
    offset = match.index + match[0].length
  }
  chunks.push(Buffer.from(text.slice(offset)))
  return Buffer.concat(chunks).toString('utf8')
}
