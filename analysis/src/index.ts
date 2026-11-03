// Backend API for running jobs with a registry worker image and per-request dependencies.
export { AnalysisService } from './service.js'
export type { ServiceOptions } from './service.js'
export { parseRequest } from './contracts.js'
export type { AnalysisRequest, JobSnapshot, WorkerResult } from './contracts.js'
