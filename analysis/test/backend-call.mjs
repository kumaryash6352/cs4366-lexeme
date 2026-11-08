// From the repository root:
// npx --no-install tsc -p analysis/tsconfig.json
// node analysis/test/backend-call.mjs
// node analysis/test/backend-call.mjs ~/cJSON
// Optional remaining arguments are Debian dependency package names.
import { AnalysisService } from '../dist/index.js'
import { getAnalysisRequest } from './mock-backend.mjs'

const service = new AnalysisService()
try {
  const [projectDir, ...dependencies] = process.argv.slice(2)
  const request = await getAnalysisRequest(projectDir === undefined ? undefined : { projectDir, dependencies })
  await service.start((stage, message) => console.log(`[${stage}] ${message}`))
  const job = service.submit(request)
  const completed = await service.wait(job.id)
  console.log(JSON.stringify(completed, null, 2))
  for (const artifact of completed.result?.artifacts ?? []) {
    console.log(artifact.source, '->', service.artifactPath(job.id, artifact.path))
  }
  if (completed.status !== 'succeeded') process.exitCode = 1
} finally {
  await service.shutdown()
}
