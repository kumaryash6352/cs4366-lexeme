import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Replace this mock with your backend's project lookup or HTTP response.
// projectDir must be accessible on the host running AnalysisService.
export async function getAnalysisRequest(project = {
  projectDir: fileURLToPath(new URL('./project/', import.meta.url)),
  entryFile: 'main.c',
  dependencies: ['zlib1g-dev'],
}) {
  return {
    schemaVersion: 1,
    operation: 'parse',
    projectDir: resolve(project.projectDir),
    entryFile: project.entryFile ?? 'main.c',
    dependencies: project.dependencies ?? [],
    includeDirs: ['.'],
    defines: [],
  }
}
