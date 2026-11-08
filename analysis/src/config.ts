import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const analysisRoot = fileURLToPath(new URL('../', import.meta.url))
export type Notify = (stage: string, message: string) => void

export interface RuntimeConfig {
  image: string
  container: { memory: string; pidsLimit: number }
  timeouts: { analysisMs: number; imagePullMs: number; packageCommandMs: number }
  limits: {
    jobsPerSession: number; projectFiles: number; projectBytes: number; projectDepth: number
    sourceBytes: number; includeDirs: number; defines: number; maxRequestedDependencies: number
    workerLogBytes: number; errorTailBytes: number
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function positiveInteger(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`)
  }
  return value
}

// Match the worker's accepted range; the host forwards this value via --timeout-ms.
export function analysisTimeout(value: unknown): number {
  return positiveInteger(value, 'timeouts.analysisMs / timeoutMs', 600_000)
}

function imageName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*\/[a-zA-Z0-9._:/@-]+$/.test(value)) {
    throw new Error('image must be a fully qualified registry image')
  }
  return value
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  const config = object(value, 'Runtime configuration')
  const container = object(config.container, 'container')
  const timeouts = object(config.timeouts, 'timeouts')
  const limits = object(config.limits, 'limits')
  if (typeof container.memory !== 'string' || !/^[1-9][0-9]*[bkmg]?$/i.test(container.memory)) {
    throw new Error('container.memory must be a positive size such as "512m" or "1g"')
  }
  return {
    image: imageName(config.image),
    container: {
      memory: container.memory,
      pidsLimit: positiveInteger(container.pidsLimit, 'container.pidsLimit'),
    },
    timeouts: {
      analysisMs: analysisTimeout(timeouts.analysisMs),
      // Node timers cannot represent delays above this value.
      imagePullMs: positiveInteger(timeouts.imagePullMs, 'timeouts.imagePullMs', 2_147_483_647),
      packageCommandMs: positiveInteger(timeouts.packageCommandMs, 'timeouts.packageCommandMs', 2_147_483_647),
    },
    limits: {
      jobsPerSession: positiveInteger(limits.jobsPerSession, 'limits.jobsPerSession'),
      projectFiles: positiveInteger(limits.projectFiles, 'limits.projectFiles'),
      projectBytes: positiveInteger(limits.projectBytes, 'limits.projectBytes'),
      projectDepth: positiveInteger(limits.projectDepth, 'limits.projectDepth'),
      sourceBytes: positiveInteger(limits.sourceBytes, 'limits.sourceBytes'),
      includeDirs: positiveInteger(limits.includeDirs, 'limits.includeDirs'),
      defines: positiveInteger(limits.defines, 'limits.defines'),
      maxRequestedDependencies: positiveInteger(limits.maxRequestedDependencies, 'limits.maxRequestedDependencies'),
      workerLogBytes: positiveInteger(limits.workerLogBytes, 'limits.workerLogBytes'),
      errorTailBytes: positiveInteger(limits.errorTailBytes, 'limits.errorTailBytes'),
    },
  }
}

/** Read once when a service is constructed, before accepting or starting jobs. */
export function loadRuntimeConfig(path = join(analysisRoot, 'runtime.config.json')): RuntimeConfig {
  return parseRuntimeConfig(JSON.parse(readFileSync(path, 'utf8')))
}

export function selectedImage(image: string | undefined, configuredImage: string): string {
  return imageName(image ?? process.env.LEXEME_ANALYSIS_IMAGE ?? configuredImage)
}
