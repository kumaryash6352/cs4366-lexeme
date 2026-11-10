/** Worker defaults; staged request limits and CLI/environment overrides take precedence. */
export const workerConfig = Object.freeze({
  jobsRoot: '/jobs',
  errorTailBytes: 4096,
  artifactBytes: 32 * 1024 * 1024,
  analysisTimeoutMs: 60_000,
  monitorIntervalMs: 25,
  killGraceMs: 250,
  heartbeatIntervalMs: 60_000,
})
