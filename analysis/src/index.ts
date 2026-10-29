// Public API for the future backend. Initial setup is a separate CLI/module.
export { AnalysisService } from './runtime/service.js'
export type { ServiceOptions } from './runtime/service.js'
export { parseRequest } from './shared/contracts.js'
export type { AnalysisRequest, JobSnapshot, WorkerResult } from './shared/contracts.js'
