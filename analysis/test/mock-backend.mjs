import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Replace this mock with your backend's project lookup or HTTP response.
// projectDir must be accessible on the host running AnalysisService.
export async function getAnalysisRequest(project = {
  projectDir: fileURLToPath(new URL('./project/', import.meta.url)),
  dependencies: ['zlib1g-dev'],
}) {
  return {
    schemaVersion: 1,
    operation: 'parse',
    projectDir: resolve(project.projectDir),
    ...(project.entryFile === undefined ? {} : { entryFile: project.entryFile }),
    dependencies: project.dependencies ?? [],
  }
}
