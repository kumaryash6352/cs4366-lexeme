import { loadRuntimeConfig } from './config.js'
import type { RuntimeConfig } from './config.js'

interface RequestBase {
  schemaVersion: 1
  operation: 'parse'
  dependencies?: string[]
}

interface CompilerSettings {
  includeDirs?: string[]
  defines?: string[]
}

type SingleFileRequest = CompilerSettings & (
  | { source: string; projectDir?: never; entryFile?: string }
  | { source?: never; projectDir: string; entryFile: string }
)

type CMakeRequest = {
  source?: never
  projectDir: string
  entryFile?: never
  includeDirs?: never
  defines?: never
}

/** Caller input: inline C, a selected project file, or a CMake project. */
export type AnalysisRequest = RequestBase & (SingleFileRequest | CMakeRequest)

/** Validated input with defaults applied only where the selected mode uses them. */
export type NormalizedAnalysisRequest = Required<RequestBase> & (
  | (SingleFileRequest & Required<CompilerSettings> & { entryFile: string })
  | CMakeRequest
)

export type AnalysisArtifact =
  | { kind: 'preprocessed-source'; path: string; source?: string }
  | { kind: 'graphs'; path: 'graphs.json' }

export interface WorkerResult {
  schemaVersion: 1
  jobId: string
  status: 'succeeded' | 'failed'
  artifacts: AnalysisArtifact[]
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

export function parseRequest(value: unknown, limits: RuntimeConfig['limits'] = loadRuntimeConfig().limits): NormalizedAnalysisRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request must be an object')
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== 1 || input.operation !== 'parse') {
    throw new Error('Expected schemaVersion: 1 and operation: "parse"')
  }
  if ((input.source === undefined) === (input.projectDir === undefined)) {
    throw new Error('Provide exactly one of source or projectDir')
  }
  const entryFile = input.entryFile !== undefined ? relativePath(input.entryFile)
    : input.source !== undefined ? 'main.c' : undefined
  if (entryFile !== undefined && !entryFile.endsWith('.c')) throw new Error('entryFile must be a .c file')
  if (entryFile === undefined && (input.includeDirs !== undefined || input.defines !== undefined)) {
    throw new Error('CMake projects obtain includeDirs and defines from CMakeLists.txt')
  }
  const dependencies = parseDependencies(input.dependencies ?? [])
  if (dependencies.length > limits.maxRequestedDependencies) {
    throw new Error(`dependencies must contain at most ${limits.maxRequestedDependencies} unique Debian package names`)
  }
  const base: Required<RequestBase> = { schemaVersion: 1, operation: 'parse', dependencies }
  let origin: { source: string; projectDir?: never } | { source?: never; projectDir: string }
  if (input.source !== undefined) {
    if (typeof input.source !== 'string' || Buffer.byteLength(input.source) > limits.sourceBytes) {
      throw new Error(`source must be a string of at most ${limits.sourceBytes} bytes`)
    }
    origin = { source: input.source }
  } else {
    if (typeof input.projectDir !== 'string' || input.projectDir.length === 0 || input.projectDir.includes('\0')) {
      throw new Error('projectDir must be a directory path on the backend host')
    }
    if (entryFile === undefined) return { ...base, projectDir: input.projectDir }
    origin = { projectDir: input.projectDir }
  }

  const dirs = input.includeDirs ?? ['.']
  const defines = input.defines ?? []
  if (!Array.isArray(dirs) || dirs.length > limits.includeDirs) throw new Error(`includeDirs must be an array of at most ${limits.includeDirs} paths`)
  if (!Array.isArray(defines) || defines.length > limits.defines || defines.some(value =>
    typeof value !== 'string' || value.length > 256 || !/^[A-Za-z_]\w*(=[^\r\n\0]*)?$/.test(value))) {
    throw new Error(`defines must contain at most ${limits.defines} NAME or NAME=value strings`)
  }
  return { ...base, ...origin, entryFile: entryFile!, includeDirs: dirs.map(value => relativePath(value, true)), defines: [...defines] }
}

/** Debian package names only; reject options, paths, and apt's trailing +/- actions. */
export function parseDependencies(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(name =>
    typeof name !== 'string' || name.length > 128 || !/^[a-z0-9][a-z0-9+.-]*[a-z0-9]$/.test(name))) {
    throw new Error('dependencies must contain Debian package names, without options or trailing +/-')
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
    if (artifact?.kind === 'graphs' && artifact.path === 'graphs.json') continue
    if (!artifact || artifact.kind !== 'preprocessed-source' || typeof artifact.path !== 'string' ||
        !/^(main|unit-[0-9]+)\.i$/.test(artifact.path) ||
        (artifact.source !== undefined && typeof artifact.source !== 'string')) {
      throw new Error('Worker returned an unsupported artifact')
    }
  }
  for (const diagnostic of result.diagnostics) {
    if (!diagnostic || typeof diagnostic.stage !== 'string' || typeof diagnostic.message !== 'string') {
      throw new Error('Worker returned invalid diagnostics')
    }
  }
  if (result.status === 'succeeded' && result.artifacts.filter(artifact => artifact.kind === 'graphs').length !== 1) {
    throw new Error('Successful result must contain one graphs.json artifact')
  }
  return result as unknown as WorkerResult
}

/** Version 1 graph artifact; all positions refer to original source where available. */
export interface SourceLocation {
  file: string
  line: number
  column?: number
  precision: 'line' | 'compiler'
}
export interface GraphEdge { source: string; target: string; kind: string; label?: string }
export interface SourceSpan { file: string; startLine: number; startColumn: number; endLine: number; endColumn: number; text: string }
export interface GraphDocument {
  schemaVersion: 1
  tools: Record<string, string>
  translationUnits: { id: string; source: string; command: string[]; directory: string }[]
  files: { id: string; path: string; kind: 'project' | 'system' | 'external' | 'generated' | 'unresolved' }[]
  includes: { edges: (GraphEdge & { id: string; unitId: string; spelling: string; resolved: boolean; location: SourceLocation })[] }
  calls: {
    nodes: { id: string; name: string; unitId: string; defined: boolean; linkage: 'internal' | 'external' | 'unknown'; location: SourceLocation | null; resolution?: string }[]
    edges: GraphEdge[]
    limitations: string[]
  }
  controlFlow: {
    functionId: string; unitId: string
    nodes: { id: string; kind: 'entry' | 'exit' | 'block'; label: string; locations: SourceLocation[];
      semanticKind?: 'statement' | 'condition' | 'loop' | 'return' | 'call' | 'declaration' | 'jump';
      source?: SourceSpan; sourceSpans?: SourceSpan[]; rawLabel?: string }[]
    edges: GraphEdge[]
  }[]
  limitations: string[]
}
