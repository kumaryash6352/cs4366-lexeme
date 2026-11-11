import { MAX_DEFINE_CHARS, MAX_DEFINES, MAX_DEPENDENCIES, MAX_DEPENDENCY_CHARS, MAX_INCLUDE_DIRS, MAX_PATH_CHARS, MAX_SOURCE_BYTES } from './limits.js'

/** One translation unit for the `analyze` operation. */
export interface UnitRequest { file: string; includeDirs: string[]; defines: string[]; std: string }

export interface AnalysisRequest {
  schemaVersion: 1
  /** `parse`: syntax check + preprocess entryFile to main.i. `analyze`: preprocess every
   * unit and run the graph analyzer in the container, producing analysis.json. */
  operation: 'parse' | 'analyze'
  units?: UnitRequest[]
  source?: string
  projectDir?: string
  entryFile: string
  includeDirs: string[]
  defines: string[]
  dependencies: string[]
}

export interface WorkerResult {
  schemaVersion: 1
  jobId: string
  status: 'succeeded' | 'failed'
  artifacts: ({ kind: 'preprocessed-source'; path: 'main.i' } | { kind: 'analysis'; path: 'analysis.json' })[]
  diagnostics: { stage: string; message: string }[]
}

export type JobStatus = 'queued' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out'
export interface JobEvent { at: string; stage: string; message: string }
export interface JobSnapshot {
  id: string
  status: JobStatus
  events: JobEvent[]
  result?: WorkerResult
  error?: string
}

export function relativePath(value: unknown, allowDot = false): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_CHARS ||
      value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.startsWith('-') ||
      value.includes(':') || value.split('/').some(part => part === '..' || part === '') ||
      (!allowDot && value === '.')) {
    throw new Error('Expected a project-relative path without .., backslashes, or drive letters')
  }
  return value
}

export function parseRequest(value: unknown): AnalysisRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request must be an object')
  let input = value as Record<string, unknown>
  if (input.schemaVersion !== 1 || (input.operation !== 'parse' && input.operation !== 'analyze')) {
    throw new Error('Expected schemaVersion: 1 and operation: "parse" or "analyze"')
  }
  if ((input.source === undefined) === (input.projectDir === undefined)) {
    throw new Error('Provide exactly one of source or projectDir')
  }
  let units: UnitRequest[] | undefined
  if (input.operation === 'analyze') {
    if (!Array.isArray(input.units) || input.units.length === 0) throw new Error('analyze requires a non-empty units array')
    units = input.units.map(parseUnit)
    input = { ...input, entryFile: units[0]!.file }
  }
  // The entry file is compiled as one C translation unit. Headers are reached
  // through #include; preprocessing a header alone yields a different graph.
  const entryFile = relativePath(input.entryFile ?? 'main.c')
  if (!entryFile.endsWith('.c')) throw new Error('entryFile must be a .c file')
  const dirs = input.includeDirs ?? ['.']
  const defines = input.defines ?? []
  if (!Array.isArray(dirs) || dirs.length > MAX_INCLUDE_DIRS) throw new Error(`includeDirs must be an array of at most ${MAX_INCLUDE_DIRS} paths`)
  if (!Array.isArray(defines) || defines.length > MAX_DEFINES || defines.some(value =>
    typeof value !== 'string' || value.length > MAX_DEFINE_CHARS || !/^[A-Za-z_]\w*(=[^\r\n\0]*)?$/.test(value))) {
    throw new Error(`defines must contain at most ${MAX_DEFINES} NAME or NAME=value strings`)
  }
  const dependencies = parseDependencies(input.dependencies ?? [])
  const request: AnalysisRequest = { schemaVersion: 1, operation: input.operation as AnalysisRequest['operation'], ...(units ? { units } : {}), entryFile, includeDirs: dirs.map(value => relativePath(value, true)), defines, dependencies }
  if (input.source !== undefined) {
    if (typeof input.source !== 'string' || Buffer.byteLength(input.source) > MAX_SOURCE_BYTES) {
      throw new Error('source must be a string of at most 1 MiB; send larger inputs as projectDir')
    }
    request.source = input.source
  } else {
    if (typeof input.projectDir !== 'string' || input.projectDir.length === 0 || input.projectDir.includes('\0')) {
      throw new Error('projectDir must be a directory path on the backend host')
    }
    request.projectDir = input.projectDir
  }
  return request
}

const DEFINE = /^[A-Za-z_]\w*(=[^\r\n\0]*)?$/
const STD = /^(c|gnu)(89|90|99|11|17|18|23|2x)$/

function parseUnit(value: unknown): UnitRequest {
  const unit = (value ?? {}) as Record<string, unknown>
  const file = relativePath(unit.file)
  if (!file.endsWith('.c')) throw new Error('Each unit must be a .c file')
  const includeDirs = unit.includeDirs ?? []
  const defines = unit.defines ?? []
  const std = unit.std ?? 'c11'
  if (!Array.isArray(includeDirs) || includeDirs.length > MAX_INCLUDE_DIRS) throw new Error(`includeDirs must be an array of at most ${MAX_INCLUDE_DIRS} paths`)
  if (!Array.isArray(defines) || defines.length > MAX_DEFINES || defines.some(d => typeof d !== 'string' || d.length > MAX_DEFINE_CHARS || !DEFINE.test(d))) {
    throw new Error(`defines must contain at most ${MAX_DEFINES} NAME or NAME=value strings`)
  }
  if (typeof std !== 'string' || !STD.test(std)) throw new Error(`Unsupported C standard ${String(std)}`)
  return { file, includeDirs: includeDirs.map(d => relativePath(d, true)), defines: defines as string[], std }
}

/** Debian package names only. Names are passed to `apt-get install` as root, so
 * reject anything apt would read as something else: a leading `-` is an option,
 * `/` or `.deb` is a local file, and a trailing `+`/`-` means install/remove. */
export function parseDependencies(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_DEPENDENCIES || value.some(name =>
    typeof name !== 'string' || name.length > MAX_DEPENDENCY_CHARS || !/^[a-z0-9][a-z0-9+.-]*[a-z0-9]$/.test(name))) {
    throw new Error(`dependencies must contain at most ${MAX_DEPENDENCIES} Debian package names, without options or trailing +/-`)
  }
  return [...new Set(value as string[])]
}

export function parseResult(value: unknown, jobId: string): WorkerResult {
  if (!value || typeof value !== 'object') throw new Error('Worker returned invalid result JSON')
  const result = value as Record<string, unknown>
  if (result.schemaVersion !== 1 || result.jobId !== jobId ||
      !['succeeded', 'failed'].includes(String(result.status)) ||
      !Array.isArray(result.artifacts) || !Array.isArray(result.diagnostics)) {
    throw new Error('Worker result does not match protocol version 1 or this job')
  }
  for (const artifact of result.artifacts) {
    if (!artifact || !((artifact.kind === 'preprocessed-source' && artifact.path === 'main.i') || (artifact.kind === 'analysis' && artifact.path === 'analysis.json'))) {
      throw new Error('Worker returned an unsupported artifact')
    }
  }
  for (const diagnostic of result.diagnostics) {
    if (!diagnostic || typeof diagnostic.stage !== 'string' || typeof diagnostic.message !== 'string') {
      throw new Error('Worker returned invalid diagnostics')
    }
  }
  if (result.status === 'succeeded' && result.artifacts.length !== 1) throw new Error('Successful result must name exactly one artifact')
  return result as unknown as WorkerResult
}
