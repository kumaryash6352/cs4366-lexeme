// From the repository root:
// npx --no-install tsc -p analysis/tsconfig.json
// node analysis/test/backend-call.mjs
// node analysis/test/backend-call.mjs ~/cJSON cJSON.c
// Optional remaining arguments are Debian dependency package names.
import { AnalysisService } from '../dist/index.js'
import { getAnalysisRequest } from './mock-backend.mjs'

const service = new AnalysisService()
try {
  const [projectDir, entryFile, ...dependencies] = process.argv.slice(2)
  if ((projectDir === undefined) !== (entryFile === undefined)) {
    throw new Error('Usage: node analysis/test/backend-call.mjs [projectDir entryFile [package ...]]')
  }
  const request = await getAnalysisRequest(projectDir === undefined ? undefined : { projectDir, entryFile, dependencies })
  await service.start((stage, message) => console.log(`[${stage}] ${message}`))
  const job = service.submit(request)
  const completed = await service.wait(job.id)
  console.log(JSON.stringify(completed, null, 2))
  console.log('Output:', service.artifactPath(job.id))
  if (completed.status !== 'succeeded') process.exitCode = 1
} finally {
  await service.shutdown()
}
