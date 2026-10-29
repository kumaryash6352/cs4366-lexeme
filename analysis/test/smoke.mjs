// Real Podman integration: build the component, then run node analysis/test/smoke.mjs.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AnalysisService } from '../dist/index.js'
import { runCommand } from '../dist/shared/command.js'

const service = new AnalysisService()
const request = fields => ({ schemaVersion: 1, operation: 'parse', ...fields })
async function identity() {
  const result = await runCommand('podman', ['inspect', '--format', '{{.Id}} {{.State.Running}}', service.containerName])
  assert.equal(result.code, 0)
  assert.match(result.stdout.trim(), / true$/)
  return result.stdout.trim()
}
try {
  await service.start((stage, message) => console.log(`[${stage}] ${message}`))
  const originalIdentity = await identity()
  for (const [name, expected] of [['hello', 'succeeded'], ['local-header', 'succeeded'], ['missing-header', 'failed'], ['syntax-error', 'failed']]) {
    const projectDir = fileURLToPath(new URL(`./test_cfiles/${name}/`, import.meta.url))
    const job = service.submit(request({ projectDir }))
    const completed = await service.wait(job.id)
    assert.equal(completed.status, expected, JSON.stringify(completed))
    if (expected === 'succeeded') assert.match(await readFile(service.artifactPath(job.id), 'utf8'), /int main/)
    else assert.ok(completed.result?.diagnostics.length > 0)
    assert.equal(await identity(), originalIdentity)
    console.log(`${name}: ${completed.status}; same container still running`)
  }
  const longSource = `int values[] = {${Array(200000).fill('1').join(',')}};\nint main(void) { return values[0]; }`
  const job = service.submit(request({ source: longSource }))
  const deadline = Date.now() + 30_000
  while (!service.get(job.id).events.some(event => event.stage === 'checking-syntax')) {
    if (Date.now() > deadline || ['failed', 'succeeded'].includes(service.get(job.id).status)) throw new Error('Could not observe compiler startup for cancellation')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  service.cancel(job.id)
  assert.equal((await service.wait(job.id)).status, 'cancelled')
  assert.equal(await identity(), originalIdentity)
  const example = JSON.parse(await readFile(new URL('./parse-request.json', import.meta.url), 'utf8'))
  const next = service.submit(example)
  assert.equal((await service.wait(next.id)).status, 'succeeded')
  assert.equal(await identity(), originalIdentity)
  console.log('Cancellation and subsequent example request passed in the same container.')
} finally {
  await service.shutdown()
}
const container = await runCommand('podman', ['container', 'exists', service.containerName])
assert.equal(container.code, 1, 'Session container must be removed on shutdown')
console.log('Application shutdown removed the persistent container.')
