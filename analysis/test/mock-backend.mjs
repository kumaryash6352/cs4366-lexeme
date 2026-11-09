// From the repository root:
// npx --no-install tsc -p analysis/tsconfig.json
// node analysis/test/mock-backend.mjs
// node analysis/test/mock-backend.mjs ~/cJSON
// Optional remaining arguments are Debian dependency package names.
// No arguments: use ./project/ with zlib1g-dev. Custom projects default to no dependencies.
// Results go to stdout as JSON; progress, artifact paths, and errors go to stderr.
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { AnalysisService } from '../dist/index.js'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let service
  try {
    const [projectDir, ...dependencies] = process.argv.slice(2)
    const request = getAnalysisRequest(projectDir === undefined ? undefined : { projectDir, dependencies })
    let projectStat
    try {
      projectStat = await stat(request.projectDir)
    } catch (error) {
      throw new Error(`Cannot access project directory "${request.projectDir}": ${error.message}`)
    }
    if (!projectStat.isDirectory()) throw new Error(`Project path is not a directory: ${request.projectDir}`)

    service = new AnalysisService()
    await service.start((stage, message) => console.error(`[${stage}] ${message}`))
    const job = service.submit(request)
    const completed = await service.wait(job.id)
    console.log(JSON.stringify(completed, null, 2))
    for (const artifact of completed.result?.artifacts ?? []) {
      console.error(artifact.kind === 'preprocessed-source' ? (artifact.source ?? artifact.kind) : artifact.kind, '->', service.artifactPath(job.id, artifact.path))
    }
    if (completed.status !== 'succeeded') process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } finally {
    try {
      await service?.shutdown()
    } catch (error) {
      console.error('Shutdown failed:', error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}

export function getAnalysisRequest(project = {
  projectDir: fileURLToPath(new URL('./project/', import.meta.url)),
  dependencies: ['zlib1g-dev'],
}) {
  return {
    schemaVersion: 1,
    operation: 'parse',
    projectDir: resolve(project.projectDir),
    dependencies: project.dependencies ?? [],
  }
}
