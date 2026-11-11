import { posix } from 'node:path'
import type { AnalysisResult, Diagnostic, SourceFile } from './graph-types.js'
import { analyze } from './index.js'
import type { UnitInput } from './index.js'

/** Compiler settings for one translation unit. */
export interface UnitSpec { file: string; includeDirs: string[]; defines: string[]; std: string }

/** Runs the compiler in the staged project directory. `read` returns a file it wrote. */
export interface Compiler {
  run: (args: string[]) => Promise<{ code: number; stderr: string }>
  read: (path: string) => Promise<string>
}

export interface ProjectInput {
  files: SourceFile[]
  units: UnitSpec[]
  /** Omit to parse without preprocessing. */
  compiler?: Compiler
  runtime?: AnalysisResult['runtime']
  diagnostics?: Diagnostic[]
}

const DIAGNOSTIC = /^(.+?):(\d+):(?:(\d+):)? (fatal error|error|warning|note): (.*)$/

/** Turn GCC/Clang `file:line:col: severity: message` lines into diagnostics. */
export function parseCompilerOutput(output: string, stage: Diagnostic['stage'] = 'preprocess'): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const line of output.split('\n')) {
    const match = DIAGNOSTIC.exec(line)
    if (!match) continue
    const [, file, row, col, severity, message] = match
    const lineNo = Number(row), column = Number(col ?? 1)
    out.push({
      severity: severity === 'note' ? 'note' : severity === 'warning' ? 'warning' : 'error',
      stage, message: message!,
      span: { file: posix.normalize(file!), line: lineNo, column, endLine: lineNo, endColumn: column },
    })
  }
  if (out.length === 0 && output.trim()) out.push({ severity: 'error', stage, message: output.trim().slice(-2000) })
  return out
}

/** Split a shell-style command line (compile_commands.json `command`). */
function splitCommand(command: string): string[] {
  return [...command.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map(m => (m[1]?.replace(/\\(.)/g, '$1') ?? m[2] ?? m[3])!)
}

interface DbEntry { directory?: string; file?: string; arguments?: string[]; command?: string }

function compileDatabase(files: SourceFile[]): { root: string; entries: DbEntry[] } | undefined {
  const db = files.filter(f => posix.basename(f.path) === 'compile_commands.json').sort((a, b) => a.path.length - b.path.length)[0]
  if (!db) return undefined
  try {
    const entries = JSON.parse(db.text)
    if (!Array.isArray(entries)) return undefined
    return { root: posix.dirname(db.path) === '.' ? '' : posix.dirname(db.path), entries }
  } catch { return undefined }
}

/** Absolute path an entry refers to, if it can be known (relative paths resolve against `directory`). */
function absolute(entry: DbEntry, path: string): string | undefined {
  if (path.startsWith('/')) return posix.normalize(path)
  return entry.directory?.startsWith('/') ? posix.normalize(posix.join(entry.directory, path)) : undefined
}

/** Where the project root lived on the machine that wrote the database: the prefix left
 * when an entry's absolute file path ends with a known project path. Most common wins. */
function originalRoot(entries: DbEntry[], known: Set<string>): string | undefined {
  const byBase = new Map<string, string[]>()
  for (const k of known) byBase.set(posix.basename(k), [...(byBase.get(posix.basename(k)) ?? []), k])
  const votes = new Map<string, number>()
  for (const entry of entries) {
    const abs = typeof entry.file === 'string' ? absolute(entry, entry.file) : undefined
    if (!abs) continue
    // Prefer the longest matching project path, so `src/a.c` beats a stray `a.c`.
    const match = (byBase.get(posix.basename(abs)) ?? []).filter(k => abs.endsWith(`/${k}`)).sort((a, b) => b.length - a.length)[0]
    if (match) { const root = abs.slice(0, abs.length - match.length - 1) || '/'; votes.set(root, (votes.get(root) ?? 0) + 1) }
  }
  return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0]
}

/** Map a path from the database into the project: via the original root when known,
 * otherwise relative to where compile_commands.json sits. Undefined if it is outside. */
function toProject(entry: DbEntry, path: string, db: { root: string; origin: string | undefined }): string | undefined {
  const abs = absolute(entry, path)
  let rel: string
  if (abs && db.origin) {
    if (abs !== db.origin && !abs.startsWith(`${db.origin === '/' ? '' : db.origin}/`)) return undefined
    rel = posix.relative(db.origin, abs) || '.'
  } else {
    rel = posix.normalize(posix.join(db.root, path.startsWith('/') && entry.directory ? posix.relative(entry.directory, path) : path))
  }
  return rel.startsWith('..') || rel.startsWith('/') ? undefined : rel
}

function projectPath(entry: DbEntry, db: { root: string; origin: string | undefined }, known: Set<string>): string | undefined {
  if (typeof entry.file !== 'string') return undefined
  const mapped = toProject(entry, entry.file, db)
  return mapped !== undefined && known.has(mapped) ? mapped : undefined
}

/** Read -I/-D/-std for one unit from a compile_commands.json in the project. */
export function flagsFromCompileCommands(files: SourceFile[], unit: string): Omit<UnitSpec, 'file'> | undefined {
  const db = compileDatabase(files)
  if (!db) return undefined
  const known = new Set(files.map(f => f.path))
  const where = { root: db.root, origin: originalRoot(db.entries, known) }
  const entry = db.entries.find(e => projectPath(e, where, known) === unit)
  if (!entry) return undefined
  const args = Array.isArray(entry.arguments) ? entry.arguments : splitCommand(entry.command ?? '')
  const dirs = new Set(files.map(f => posix.dirname(f.path)))
  const flags = { includeDirs: [] as string[], defines: [] as string[], std: '' }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const value = (prefix: string) => arg === prefix ? args[++i] : arg.startsWith(prefix) ? arg.slice(prefix.length) : undefined
    const include = value('-I') ?? value('-iquote') ?? value('-isystem')
    const define = value('-D')
    if (include !== undefined) {
      // Keep include directories that exist inside the project; others are system paths.
      const dir = toProject(entry, include, where)
      if (dir !== undefined && (dir === '.' || [...dirs].some(k => k === dir || k.startsWith(`${dir}/`)))) flags.includeDirs.push(dir)
    } else if (define !== undefined) flags.defines.push(define)
    else if (arg.startsWith('-std=')) flags.std = arg.slice(5)
  }
  return flags
}

/** Units to analyze: those requested, else compile_commands.json entries, else every .c file. */
export function selectUnits(files: SourceFile[], requested?: string[]): string[] {
  const known = new Set(files.map(f => f.path))
  if (requested?.length) return requested
  const db = compileDatabase(files)
  const where = db ? { root: db.root, origin: originalRoot(db.entries, known) } : undefined
  const fromDb = db && where ? [...new Set(db.entries.map(e => projectPath(e, where, known)).filter((p): p is string => !!p && p.endsWith('.c')))] : []
  return fromDb.length ? fromDb : files.filter(f => f.path.endsWith('.c')).map(f => f.path)
}

/** Preprocess every unit (falling back to unexpanded parsing on failure) and analyze them together. */
export async function analyzeProject(input: ProjectInput): Promise<AnalysisResult> {
  const diagnostics: Diagnostic[] = [...(input.diagnostics ?? [])]
  const units: UnitInput[] = []
  for (const [i, unit] of input.units.entries()) {
    const flags = [`-std=${unit.std}`, ...unit.includeDirs.flatMap(d => ['-I', d]), ...unit.defines.map(d => `-D${d}`)]
    if (!input.compiler) { units.push({ file: unit.file, flags }); continue }
    const checked = await input.compiler.run([...flags, '-fsyntax-only', unit.file])
    diagnostics.push(...parseCompilerOutput(checked.stderr))
    const output = `.lexeme-unit-${i}.i`
    const expanded = await input.compiler.run([...flags, '-E', unit.file, '-o', output])
    if (expanded.code !== 0) {
      diagnostics.push(...parseCompilerOutput(expanded.stderr), { severity: 'warning', stage: 'preprocess', message: `Preprocessing ${unit.file} failed; its graphs come from the unexpanded source` })
      units.push({ file: unit.file, flags })
    } else {
      units.push({ file: unit.file, flags, preprocessed: await input.compiler.read(output) })
    }
  }
  const seen = new Set<string>()
  const unique = diagnostics.filter(d => {
    const key = JSON.stringify([d.message, d.span?.file, d.span?.line, d.span?.column])
    return !seen.has(key) && seen.add(key)
  })
  return analyze({ files: input.files, units, runtime: input.runtime ?? 'host', diagnostics: unique })
}
