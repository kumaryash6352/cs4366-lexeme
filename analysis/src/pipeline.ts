import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { analyzeProject, flagsFromCompileCommands, selectUnits } from './analyzer/index.js'
import type { AnalysisResult, Diagnostic, SourceFile, UnitSpec } from './analyzer/index.js'
import { runCommand } from './command.js'
import type { Command } from './command.js'
import { relativePath } from './contracts.js'
import type { AnalysisService } from './service.js'

export type Preprocessor = 'auto' | 'gcc' | 'container' | 'none'

export interface PipelineRequest {
  files: SourceFile[]
  /** Translation units. Default: compile_commands.json entries, else every .c file. */
  units?: string[]
  /** Single-unit shorthand (older clients). */
  entryFile?: string
  includeDirs?: string[]
  defines?: string[]
  /** C dialect for -std, e.g. c11 (default), c17, gnu11. */
  std?: string
}

export interface PipelineOptions {
  preprocessor?: Preprocessor
  /** Host compiler for the gcc preprocessor (default `gcc`). */
  compiler?: string
  /** Required for the container mode; must already be started. */
  service?: AnalysisService
  command?: Command
}

let gccAvailable: Promise<boolean> | undefined

/** Per-unit flags: request flags plus that unit's compile_commands.json entry. */
export function unitSpecs(request: PipelineRequest, files: SourceFile[]): { specs: UnitSpec[]; notes: Diagnostic[] } {
  const requested = request.units?.length ? request.units : request.entryFile ? [request.entryFile] : undefined
  const names = selectUnits(files, requested?.map(u => relativePath(u)))
  if (names.length === 0) throw new Error('No .c files to analyze')
  const known = new Set(files.map(f => f.path))
  const notes: Diagnostic[] = []
  let fromDb = 0
  const specs = names.map(file => {
    if (!known.has(file)) throw new Error(`Unit ${file} is not among the submitted files`)
    const db = flagsFromCompileCommands(files, file)
    if (db) fromDb++
    const spec: UnitSpec = {
      file,
      includeDirs: [...new Set([...(request.includeDirs ?? []), ...(db?.includeDirs ?? [])].map(d => relativePath(d, true)))],
      defines: [...new Set([...(request.defines ?? []), ...(db?.defines ?? [])])],
      std: request.std || db?.std || 'c11',
    }
    if (!/^(c|gnu)(89|90|99|11|17|18|23|2x)$/.test(spec.std)) throw new Error(`Unsupported C standard ${spec.std}`)
    for (const d of spec.defines) if (!/^[A-Za-z_]\w*(=[^\r\n\0]*)?$/.test(d)) throw new Error(`Invalid macro definition ${d}`)
    return spec
  })
  if (fromDb) notes.push({ severity: 'note', stage: 'preprocess', message: `Applied compile_commands.json flags to ${fromDb} of ${specs.length} unit${specs.length === 1 ? '' : 's'}` })
  return { specs, notes }
}

async function stage(files: SourceFile[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lexeme-'))
  for (const file of files) {
    await mkdir(dirname(join(dir, file.path)), { recursive: true })
    await writeFile(join(dir, file.path), file.text)
  }
  return dir
}

/** Expand and analyze every translation unit on the host or inside the analysis container. */
export async function runPipeline(request: PipelineRequest, options: PipelineOptions = {}): Promise<AnalysisResult> {
  const files = request.files.map(f => ({ path: relativePath(f.path), text: String(f.text) }))
  const { specs, notes } = unitSpecs(request, files)
  const command = options.command ?? runCommand
  const compiler = options.compiler ?? 'gcc'
  let mode = options.preprocessor ?? 'auto'
  if (mode === 'auto') {
    gccAvailable ??= command(compiler, ['--version']).then(r => r.code === 0, () => false)
    mode = await gccAvailable ? 'gcc' : 'none'
    if (mode === 'none') notes.push({ severity: 'warning', stage: 'preprocess', message: `${compiler} not found; parsed the source without preprocessing` })
  }
  if (mode === 'none') return analyzeProject({ files, units: specs, diagnostics: notes })

  const dir = await stage(files)
  try {
    if (mode === 'container') {
      const service = options.service
      if (!service) throw new Error('Container analysis requires a started AnalysisService')
      const job = service.submit({ schemaVersion: 1, operation: 'analyze', projectDir: dir, units: specs })
      const done = await service.wait(job.id)
      const artifact = service.artifactPath(job.id)
      if (!artifact) throw new Error(`Container analysis ${done.status}: ${done.error ?? done.result?.diagnostics.map(d => d.message).join('; ') ?? ''}`)
      const result = JSON.parse(await readFile(artifact, 'utf8')) as AnalysisResult
      return { ...result, diagnostics: [...notes, ...result.diagnostics] }
    }
    return await analyzeProject({
      files, units: specs, diagnostics: notes,
      compiler: {
        run: args => command(compiler, args, { cwd: dir, timeoutMs: 60_000 }),
        read: path => readFile(join(dir, relativePath(path)), 'utf8'),
      },
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
