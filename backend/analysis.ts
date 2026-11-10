import { readFile } from 'node:fs/promises'
import { AnalysisService } from '#analysis'
import type { GraphDocument as AnalyzerGraphDocument } from '#analysis'
import type { GraphDocument, ProjectAnalysis } from '../shared/analysis.ts'

export interface AnalysisRunner {
  start(): Promise<void>
  analyze(projectDir: string, entryFile?: string): Promise<ProjectAnalysis>
  close(): Promise<void>
}

function graphDocument(value: unknown): GraphDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Analyzer returned an invalid graph document.')
  const graph = value as Partial<AnalyzerGraphDocument>
  if (graph.schemaVersion !== 1 || !Array.isArray(graph.translationUnits) || !Array.isArray(graph.files) ||
      !graph.includes || !Array.isArray(graph.includes.edges) || !graph.calls ||
      !Array.isArray(graph.calls.nodes) || !Array.isArray(graph.calls.edges) || !Array.isArray(graph.controlFlow)) {
    throw new Error('Analyzer graph does not match graph contract version 1.')
  }
  return graph as AnalyzerGraphDocument
}

export class ContainerAnalysisRunner implements AnalysisRunner {
  private service = new AnalysisService()

  start(): Promise<void> {
    return this.service.start((stage, message) => console.info(`[analysis:${stage}] ${message}`))
  }

  async analyze(projectDir: string, entryFile?: string): Promise<ProjectAnalysis> {
    const mode = entryFile === undefined ? 'cmake-project' : 'single-file'
    const submitted = this.service.submit({
      schemaVersion: 1,
      operation: 'parse',
      projectDir,
      ...(entryFile === undefined ? {} : { entryFile }),
      dependencies: [],
    })
    const completed = await this.service.wait(submitted.id)
    const diagnostics = completed.result?.diagnostics ?? []
    if (completed.status !== 'succeeded') {
      return {
        status: 'failed', jobId: completed.id, mode, events: completed.events, diagnostics,
        error: completed.error ?? diagnostics.at(-1)?.message ?? `Analysis ${completed.status}.`,
      }
    }
    const path = this.service.artifactPath(completed.id)
    if (!path) throw new Error('Successful analysis did not provide graphs.json.')
    return {
      status: 'succeeded', jobId: completed.id, mode, events: completed.events, diagnostics,
      graph: graphDocument(JSON.parse(await readFile(path, 'utf8'))),
    }
  }

  close(): Promise<void> {
    return this.service.shutdown()
  }
}
