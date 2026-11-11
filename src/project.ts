import type { SourceFile } from '../shared/graph.ts'

/** File to show first: the one defining main(), else the first .c file. */
export function pickEntry(files: SourceFile[]): string {
  const sources = files.filter(f => f.path.endsWith('.c'))
  return sources.find(f => /\bint\s+main\s*\(/.test(f.text))?.path
    ?? sources.find(f => /(^|\/)main\.c$/.test(f.path))?.path
    ?? sources[0]?.path ?? files[0]?.path ?? ''
}

const PATH_KEY = 'lexeme.lastPath'

/** The last opened folder, offered in the path box (not opened automatically). */
export function lastPath(): string {
  try { return localStorage.getItem(PATH_KEY) ?? '' } catch { return '' }
}

export function rememberPath(path: string) {
  try { localStorage.setItem(PATH_KEY, path) } catch { /* storage unavailable */ }
}
