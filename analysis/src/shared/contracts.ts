export interface AnalysisRequest {
  schemaVersion: 1
  operation: 'parse'
  source?: string
  projectDir?: string
  entryFile: string
  includeDirs: string[]
  defines: string[]
}

export interface WorkerResult {
  schemaVersion: 1
  jobId: string
  status: 'succeeded' | 'failed'
  artifacts: { kind: 'preprocessed-source'; path: 'main.i' }[]
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
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 ||
      value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.startsWith('-') ||
      value.includes(':') || value.split('/').some(part => part === '..' || part === '') ||
      (!allowDot && value === '.')) {
    throw new Error('Expected a project-relative path without .., backslashes, or drive letters')
  }
  return value
}

export function parseRequest(value: unknown): AnalysisRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request must be an object')
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== 1 || input.operation !== 'parse') {
    throw new Error('Expected schemaVersion: 1 and operation: "parse"')
  }
  if ((input.source === undefined) === (input.projectDir === undefined)) {
    throw new Error('Provide exactly one of source or projectDir')
  }
  const entryFile = relativePath(input.entryFile ?? 'main.c')
  if (!entryFile.endsWith('.c')) throw new Error('entryFile must be a .c file')
  const dirs = input.includeDirs ?? ['.']
  const defines = input.defines ?? []
  if (!Array.isArray(dirs) || dirs.length > 32) throw new Error('includeDirs must be an array of at most 32 paths')
  if (!Array.isArray(defines) || defines.length > 32 || defines.some(value =>
    typeof value !== 'string' || value.length > 256 || !/^[A-Za-z_]\w*(=[^\r\n\0]*)?$/.test(value))) {
    throw new Error('defines must contain at most 32 NAME or NAME=value strings')
  }
  const request: AnalysisRequest = { schemaVersion: 1, operation: 'parse', entryFile, includeDirs: dirs.map(value => relativePath(value, true)), defines }
  if (input.source !== undefined) {
    if (typeof input.source !== 'string' || Buffer.byteLength(input.source) > 1024 * 1024) {
      throw new Error('source must be a string of at most 1 MiB')
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

export function parseResult(value: unknown, jobId: string): WorkerResult {
  if (!value || typeof value !== 'object') throw new Error('Worker returned invalid result JSON')
  const result = value as Record<string, unknown>
  if (result.schemaVersion !== 1 || result.jobId !== jobId ||
      !['succeeded', 'failed'].includes(String(result.status)) ||
      !Array.isArray(result.artifacts) || !Array.isArray(result.diagnostics)) {
    throw new Error('Worker result does not match protocol version 1 or this job')
  }
  for (const artifact of result.artifacts) {
    if (!artifact || artifact.kind !== 'preprocessed-source' || artifact.path !== 'main.i') {
      throw new Error('Worker returned an unsupported artifact')
    }
  }
  for (const diagnostic of result.diagnostics) {
    if (!diagnostic || typeof diagnostic.stage !== 'string' || typeof diagnostic.message !== 'string') {
      throw new Error('Worker returned invalid diagnostics')
    }
  }
  if (result.status === 'succeeded' && result.artifacts.length !== 1) throw new Error('Successful result is missing main.i')
  return result as unknown as WorkerResult
}
