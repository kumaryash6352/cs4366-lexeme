import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnalysisService } from '../dist/index.js'
import { AnalysisSetup } from '../dist/setup/prepare.js'
import { PodmanRuntime } from '../dist/runtime/environment.js'
import { parseRequest, parseResult } from '../dist/shared/contracts.js'

const request = fields => ({ schemaVersion: 1, operation: 'parse', ...fields })
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
const runtimeInfo = JSON.stringify({ host: { serviceIsRemote: false, security: { rootless: true } } })
function fakePodman(overrides = {}) {
  const calls = []
  const command = async (program, args, options) => {
    calls.push([program, ...args])
    if (overrides.command) {
      const result = await overrides.command(program, args, options)
      if (result !== undefined) return result
    }
    if (args[0] === 'info') return ok(runtimeInfo)
    if (args[0] === 'image' && args[1] === 'inspect') return ok('a'.repeat(64))
    if (args[0] === 'image') return { code: 1, stdout: '', stderr: '' }
    return ok()
  }
  return { calls, command }
}

test('request boundary rejects traversal and ambiguous input; result must belong to the job', () => {
  for (const entryFile of ['../secret.c', '/tmp/main.c', 'C:\\main.c', '-main.c']) {
    assert.throws(() => parseRequest(request({ source: 'x', entryFile })))
  }
  assert.throws(() => parseRequest(request({ source: 'x', projectDir: '/tmp' })))
  assert.throws(() => parseRequest(request({ source: 'x', defines: ['-fplugin=evil'] })))
  assert.throws(() => parseResult({ schemaVersion: 1, jobId: 'other', status: 'succeeded', artifacts: [], diagnostics: [] }, 'job'))
  assert.equal(parseRequest(request({ source: 'int main(void) { return 0; }' })).entryFile, 'main.c')
})

test('simultaneous setup requests share one image build', async () => {
  const fake = fakePodman()
  const environment = new AnalysisSetup({ command: fake.command, platform: 'linux' })
  const images = await Promise.all([environment.prepare(), environment.prepare()])
  assert.equal(images[0], images[1])
  assert.equal(fake.calls.filter(call => call[1] === 'build').length, 1)
  assert.equal(fake.calls.filter(call => call[1] === '--version').length, 1)
})

test('missing executable triggers Ubuntu installation, but failed runtime checks never reinstall', async () => {
  let installed = false
  const fake = fakePodman({ command: async (program, args) => {
    if (program === 'podman' && args[0] === '--version' && !installed) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    if (program === 'sudo' && args.includes('install')) installed = true
  } })
  await new AnalysisSetup({ command: fake.command, platform: 'linux', readOsRelease: async () => 'ID=ubuntu\n' }).prepare()
  assert.ok(installed)
  const broken = fakePodman({ command: async (_program, args) => args[0] === 'info' ? { code: 125, stdout: '', stderr: 'runtime broken' } : undefined })
  await assert.rejects(new AnalysisSetup({ command: broken.command, platform: 'linux' }).prepare(), /runtime broken/)
  assert.ok(!broken.calls.some(call => call[0] === 'sudo'))
})

test('installation requires noninteractive authorization and image storage errors do not trigger builds', async () => {
  const fake = fakePodman({ command: async (program, args) => {
    if (program === 'podman' && args[0] === '--version') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    if (program === 'sudo') return { code: 1, stdout: '', stderr: 'password required' }
  } })
  await assert.rejects(new AnalysisSetup({ command: fake.command, platform: 'linux', readOsRelease: async () => 'ID=ubuntu' }).prepare(), /sudo apt-get/)
  assert.ok(!fake.calls.some(call => call.includes('apt-get')))
  const broken = fakePodman({ command: async (_program, args) => args[0] === 'image' ? { code: 125, stdout: '', stderr: 'storage broken' } : undefined })
  await assert.rejects(new AnalysisSetup({ command: broken.command, platform: 'linux' }).prepare(), /storage broken/)
  assert.ok(!broken.calls.some(call => call[1] === 'build'))
})

test('normal startup only checks the prepared image and never installs, builds, or pulls', async () => {
  const fake = fakePodman({ command: async (_program, args) => args[0] === 'image' && args[1] === 'exists' ? ok() : undefined })
  const runtime = new PodmanRuntime({ command: fake.command, platform: 'linux', image: 'localhost/podmananalysiscontainer' })
  assert.equal(await runtime.ensureReady(), 'localhost/podmananalysiscontainer')
  assert.deepEqual(fake.calls.map(call => call[1]), ['--version', 'info', 'image'])
})

test('missing image or executable requires initial setup without changing the host', async () => {
  const missingImage = fakePodman()
  await assert.rejects(new PodmanRuntime({ command: missingImage.command, platform: 'linux' }).ensureReady(), /one-time setup/)
  assert.ok(!missingImage.calls.some(call => ['build', 'pull', 'run'].includes(call[1])))
  const missingPodman = fakePodman({ command: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } })
  await assert.rejects(new PodmanRuntime({ command: missingPodman.command, platform: 'linux' }).ensureReady(), /one-time setup/)
  assert.equal(missingPodman.calls.length, 1)
  assert.equal(missingPodman.calls[0][0], 'podman')
})

test('every setup invocation prepares and verifies the image even when it exists', async () => {
  const fake = fakePodman({ command: async (_program, args) => args[0] === 'image' && args[1] === 'exists' ? ok() : undefined })
  const setup = new AnalysisSetup({ command: fake.command, platform: 'linux' })
  await setup.prepare()
  await setup.prepare()
  assert.equal(fake.calls.filter(call => call[1] === 'build').length, 2)
  assert.equal(fake.calls.filter(call => call.includes('--self-check')).length, 2)
  const custom = new AnalysisSetup({ command: fake.command, platform: 'linux', image: 'registry.example.com/analysis' })
  await custom.prepare()
  assert.equal(fake.calls.filter(call => call[1] === 'pull').length, 1)
})

async function serviceFixture(t, behavior = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lexeme-test-'))
  const containers = new Map()
  const removed = []
  let starts = 0
  let preparations = 0
  let executions = 0
  let active = 0
  let maxActive = 0
  const environment = {
    ensureReady: async notify => { preparations++; notify?.('image-ready', 'test-image'); return 'test-image' },
    command: async (_program, args, options = {}) => {
      if (args[0] === 'run') {
        starts++
        const name = args[args.indexOf('--name') + 1]
        const mount = args.find(arg => arg.endsWith(':/jobs:Z'))
        containers.set(name, mount.slice(0, -':/jobs:Z'.length))
        if (behavior.afterRun) await behavior.afterRun()
        return ok('container-id')
      }
      if (args[0] === 'rm') { removed.push(args.at(-1)); containers.delete(args.at(-1)); return ok() }
      if (args[0] === 'exec' && args.includes('--self-check')) {
        return behavior.failSelfCheck ? { ...ok(), code: 1, stderr: 'self-check failure' } : ok()
      }
      if (args[0] === 'exec') {
        if (behavior.execThrows) throw new Error('exec disconnected')
        assert.ok(containers.has(args[1]), 'job must use the existing container')
        const jobId = args[args.indexOf('--job') + 1]
        const dir = join(containers.get(args[1]), jobId)
        executions++
        active++
        maxActive = Math.max(maxActive, active)
        try {
          let cancelled = false
          if (behavior.hangFirst && executions === 1) {
            const deadline = Date.now() + 2000
            while (!cancelled) {
              try { await readFile(join(dir, 'cancel')); cancelled = true }
              catch {
                if (Date.now() > deadline) throw new Error('Cancellation marker was not written')
                await new Promise(resolve => setTimeout(resolve, 5))
              }
            }
          }
          const input = JSON.parse(await readFile(join(dir, 'input/request.json'), 'utf8'))
          options.onStdout?.('{"type":"progress","sta')
          options.onStdout?.('ge":"checking-syntax"}\n{"type":"progress","stage":"preprocessing"}\n')
          const failed = cancelled || behavior.failure
          if (!behavior.noResult) {
            await writeFile(join(dir, 'output/result.json'), JSON.stringify({
              schemaVersion: 1, jobId: input.jobId, status: failed ? 'failed' : 'succeeded',
              artifacts: failed ? [] : [{ kind: 'preprocessed-source', path: 'main.i' }],
              diagnostics: failed ? [{ stage: 'checking-syntax', message: cancelled ? 'cancelled' : 'bad C syntax' }] : [],
            }))
            if (!failed) await writeFile(join(dir, 'output/main.i'), '# 1 "main.c"\nint main(void) { return 0; }')
          }
          return { ...ok(), code: failed ? 1 : 0 }
        } finally { active-- }
      }
      throw new Error(`Unexpected fake command: ${args.join(' ')}`)
    },
  }
  const service = new AnalysisService({ environment, jobsRoot: root, timeoutMs: behavior.timeoutMs ?? 1000 })
  t.after(async () => { await service.shutdown(); await rm(root, { recursive: true, force: true }) })
  return { service, removed, containers, starts: () => starts, preparations: () => preparations, executions: () => executions, maxActive: () => maxActive }
}

test('example parsing request is accepted; missing or unsupported protocol is rejected', async () => {
  const example = JSON.parse(await readFile(new URL('./parse-request.json', import.meta.url), 'utf8'))
  assert.equal(parseRequest(example).operation, 'parse')
  assert.throws(() => parseRequest({ source: 'int x;' }), /schemaVersion/)
  assert.throws(() => parseRequest({ ...example, schemaVersion: 2 }), /schemaVersion/)
})

test('startup creates one container reused by multiple queued requests until shutdown', async t => {
  const fixture = await serviceFixture(t)
  assert.throws(() => fixture.service.submit(request({ source: 'int x;' })), /start/)
  await Promise.all([fixture.service.start(), fixture.service.start()])
  const first = fixture.service.submit(request({ source: 'int first;' }))
  const second = fixture.service.submit(request({ source: 'int second;' }))
  const results = await Promise.all([fixture.service.wait(first.id), fixture.service.wait(second.id)])
  assert.ok(results.every(job => job.status === 'succeeded'))
  assert.ok(results[0].events.some(event => event.stage === 'checking-syntax'))
  assert.equal(fixture.starts(), 1)
  assert.equal(fixture.preparations(), 1)
  assert.equal(fixture.containers.size, 1)
  assert.equal(fixture.removed.length, 0)
  assert.equal(fixture.maxActive(), 1)
  assert.equal(await readFile(join(fixture.service.jobsRoot, first.id, 'input/source/main.c'), 'utf8'), 'int first;')
  assert.equal(await readFile(join(fixture.service.jobsRoot, second.id, 'input/source/main.c'), 'utf8'), 'int second;')
  await Promise.all([fixture.service.shutdown(), fixture.service.shutdown()])
  assert.equal(fixture.removed.length, 1)
  assert.equal(fixture.containers.size, 0)
})

test('compiler failures and missing result files fail the job without removing the session', async t => {
  for (const behavior of [{ failure: true }, { noResult: true }]) {
    const fixture = await serviceFixture(t, behavior)
    await fixture.service.start()
    const job = fixture.service.submit(request({ source: 'bad C' }))
    const result = await fixture.service.wait(job.id)
    assert.equal(result.status, 'failed')
    assert.equal(fixture.removed.length, 0)
    assert.equal(fixture.containers.size, 1)
  }
})

test('timed-out job leaves the container available for a subsequent successful request', async t => {
  const fixture = await serviceFixture(t, { hangFirst: true, timeoutMs: 30 })
  await fixture.service.start()
  const first = fixture.service.submit(request({ source: 'int x;' }))
  assert.equal((await fixture.service.wait(first.id)).status, 'timed-out')
  const second = fixture.service.submit(request({ source: 'int y;' }))
  assert.equal((await fixture.service.wait(second.id)).status, 'succeeded')
  assert.equal(fixture.removed.length, 0)
  assert.equal(fixture.starts(), 1)
})

test('cancelling a running request waits for worker acknowledgement and preserves the container', async t => {
  const fixture = await serviceFixture(t, { hangFirst: true })
  await fixture.service.start()
  const job = fixture.service.submit(request({ source: 'int x;' }))
  while (fixture.service.get(job.id).status !== 'running') await new Promise(resolve => setTimeout(resolve, 1))
  fixture.service.cancel(job.id)
  assert.equal((await fixture.service.wait(job.id)).status, 'cancelled')
  assert.equal(fixture.containers.size, 1)
  assert.equal(fixture.removed.length, 0)
})

test('shutdown during startup removes the session and never executes queued requests', async t => {
  let release
  let notify
  const started = new Promise(resolve => { notify = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const fixture = await serviceFixture(t, { afterRun: async () => { notify(); await gate } })
  const startup = fixture.service.start()
  const rejected = assert.rejects(startup, /shut down/)
  const job = fixture.service.submit(request({ source: 'int x;' }))
  await started
  const shutdown = fixture.service.shutdown()
  release()
  await Promise.all([rejected, shutdown])
  assert.equal((await fixture.service.wait(job.id)).status, 'cancelled')
  assert.equal(fixture.executions(), 0)
  assert.equal(fixture.containers.size, 0)
})

test('startup verification failure cleans up the container', async t => {
  const fixture = await serviceFixture(t, { failSelfCheck: true })
  await assert.rejects(fixture.service.start(), /self-check failure/)
  assert.equal(fixture.containers.size, 0)
})

test('unresponsive exec retires the session rather than risking overlapping compiler processes', async t => {
  const fixture = await serviceFixture(t, { execThrows: true })
  await fixture.service.start()
  const job = fixture.service.submit(request({ source: 'int x;' }))
  assert.equal((await fixture.service.wait(job.id)).status, 'failed')
  assert.equal(fixture.containers.size, 0)
  assert.throws(() => fixture.service.submit(request({ source: 'int y;' })), /restart/)
})

test('staging rejects symbolic links without executing a job', async t => {
  const fixture = await serviceFixture(t)
  await fixture.service.start()
  const root = await mkdtemp(join(tmpdir(), 'lexeme-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await symlink('/etc/passwd', join(root, 'main.c'))
  const job = fixture.service.submit(request({ projectDir: root }))
  const result = await fixture.service.wait(job.id)
  assert.equal(result.status, 'failed')
  assert.match(result.error, /symbolic links/)
  assert.equal(fixture.executions(), 0)
})


test('rebuild removes only the replaced image after verification; preserves it on failure or unchanged build', async () => {
  for (const scenario of ['changed', 'unchanged', 'build-failed', 'check-failed', 'in-use']) {
    let built = false
    const oldId = 'a'.repeat(64)
    const newId = 'b'.repeat(64)
    const events = []
    const fake = fakePodman({ command: async (_program, args) => {
      if (args[0] === 'image' && args[1] === 'exists') return ok()
      if (args[0] === 'image' && args[1] === 'inspect') return ok(built && scenario !== 'unchanged' ? newId : oldId)
      if (args[0] === 'build') {
        if (scenario === 'build-failed') return { ...ok(), code: 1, stderr: 'build failed' }
        built = true
      }
      if (args.includes('--self-check') && scenario === 'check-failed') return { ...ok(), code: 1, stderr: 'check failed' }
      if (args[0] === 'rmi' && scenario === 'in-use') return { ...ok(), code: 1, stderr: 'image is in use' }
    } })
    const setup = new AnalysisSetup({ command: fake.command, platform: 'linux' })
    const preparation = setup.prepare((stage, message) => events.push([stage, message]))
    if (scenario.endsWith('failed')) await assert.rejects(preparation)
    else await preparation
    const removals = fake.calls.filter(call => call[1] === 'rmi')
    assert.deepEqual(removals, ['changed', 'in-use'].includes(scenario) ? [['podman', 'rmi', oldId]] : [])
    if (removals.length) assert.ok(fake.calls.findIndex(call => call.includes('--self-check')) < fake.calls.findIndex(call => call[1] === 'rmi'))
    assert.equal(events.some(([stage]) => stage === 'cleanup-pending'), scenario === 'in-use')
  }
})
