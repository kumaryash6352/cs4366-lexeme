import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnalysisService } from '../dist/index.js'
import { PodmanRuntime } from '../dist/environment.js'
import { parseRequest, parseResult } from '../dist/contracts.js'
import { getAnalysisRequest } from './mock-backend.mjs'

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

test('startup pulls the configured registry image before creating a container', async () => {
  const fake = fakePodman()
  const image = 'ghcr.io/your-owner/analysiscontainer:v1'
  const runtime = new PodmanRuntime({ command: fake.command, platform: 'linux', image })
  assert.equal(await runtime.ensureReady(), image)
  assert.deepEqual(fake.calls, [
    ['podman', '--version'], ['podman', 'info', '--format', 'json'], ['podman', 'pull', image],
  ])
})

test('default image comes from the independent configuration file', async () => {
  const savedImage = process.env.LEXEME_ANALYSIS_IMAGE
  delete process.env.LEXEME_ANALYSIS_IMAGE
  try {
    const config = JSON.parse(await readFile(new URL('../runtime.config.json', import.meta.url), 'utf8'))
    const fake = fakePodman()
    const runtime = new PodmanRuntime({ command: fake.command, platform: 'linux', buildContext: '/nonexistent' })
    assert.equal(await runtime.ensureReady(), config.image)
    // The default image is local, so it is built on demand rather than pulled.
    const build = fake.calls.at(-1)
    assert.deepEqual([build[1], build[2], build.at(-3), build.at(-2), build.at(-1)], ['build', '--label', '-t', config.image, '/nonexistent'])
    assert.match(build[3], /^lexeme\.inputs=[0-9a-f]{16}$/)
  } finally {
    if (savedImage === undefined) delete process.env.LEXEME_ANALYSIS_IMAGE
    else process.env.LEXEME_ANALYSIS_IMAGE = savedImage
  }
})

test('registry failures stop startup without falling back to a cached image', async () => {
  const fake = fakePodman({ command: async (_program, args) => args[0] === 'pull'
    ? { code: 125, stdout: '', stderr: 'registry access denied' } : undefined })
  const runtime = new PodmanRuntime({ command: fake.command, platform: 'linux', image: 'ghcr.io/example/analysis:v1' })
  await assert.rejects(runtime.ensureReady(), /registry access denied/)
  assert.ok(!fake.calls.some(call => ['run', 'image', 'build'].includes(call[1])))
})

test('missing Podman reports host preparation instructions', async () => {
  const missingPodman = fakePodman({ command: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } })
  await assert.rejects(new PodmanRuntime({ command: missingPodman.command, platform: 'linux' }).ensureReady(), /Install Podman on the backend host/)
  assert.equal(missingPodman.calls.length, 1)
  assert.equal(missingPodman.calls[0][0], 'podman')
})

test('unsupported hosts and nonlocal or rootful Podman fail before image lookup', async () => {
  const unsupported = fakePodman()
  await assert.rejects(new PodmanRuntime({ command: unsupported.command, platform: 'freebsd' }).ensureReady(), /Linux/)
  assert.equal(unsupported.calls.length, 0)
  const rootfulMachine = fakePodman({ command: async (_program, args) => args[0] === 'info' ? ok(JSON.stringify({ host: { serviceIsRemote: true, security: { rootless: false } } })) : undefined })
  await assert.rejects(new PodmanRuntime({ command: rootfulMachine.command, platform: 'darwin' }).ensureReady(), /rootless Podman machine/)
  for (const host of [
    { serviceIsRemote: true, security: { rootless: true } },
    { serviceIsRemote: false, security: { rootless: false } },
  ]) {
    const fake = fakePodman({ command: async (_program, args) => args[0] === 'info' ? ok(JSON.stringify({ host })) : undefined })
    await assert.rejects(new PodmanRuntime({ command: fake.command, platform: 'linux' }).ensureReady(), /local rootless Podman/)
    assert.deepEqual(fake.calls.map(call => call[1]), ['--version', 'info'])
  }
})

test('Podman failures preserve diagnostics', async () => {
  for (const stage of ['info', 'pull']) {
    const fake = fakePodman({ command: async (_program, args) => args[0] === stage ? { code: 125, stdout: '', stderr: 'storage unavailable' } : undefined })
    await assert.rejects(new PodmanRuntime({ command: fake.command, platform: 'linux', image: 'ghcr.io/example/analysis:v1' }).ensureReady(), /storage unavailable/)
    assert.deepEqual(fake.calls.map(call => call[1]), stage === 'info' ? ['--version', 'info'] : ['--version', 'info', 'pull'])
  }
})

async function serviceFixture(t, behavior = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lexeme-test-'))
  const containers = new Map()
  const removed = []
  const calls = []
  const packageCalls = []
  let starts = 0
  let preparations = 0
  let executions = 0
  let active = 0
  let maxActive = 0
  const environment = {
    ensureReady: async notify => { preparations++; notify?.('image-ready', 'test-image'); return 'test-image' },
    command: async (_program, args, options = {}) => {
      calls.push(args)
      if (args[0] === 'run') {
        starts++
        const name = args[args.indexOf('--name') + 1]
        const mount = args.find(arg => arg.endsWith(':/jobs:Z'))
        containers.set(name, mount.slice(0, -':/jobs:Z'.length))
        if (behavior.afterRun) await behavior.afterRun()
        return ok('container-id')
      }
      if (args[0] === 'rm') { removed.push(args.at(-1)); containers.delete(args.at(-1)); return ok() }
      if (args[0] === 'exec' && args.includes('apt-get')) {
        packageCalls.push(args)
        assert.equal(args[args.indexOf('--user') + 1], '0:0')
        assert.ok(containers.has(args[args.indexOf('apt-get') - 1]))
        assert.equal(options.timeoutMs, 300_000)
        if (behavior.packageTimeout) throw new Error('podman timed out')
        if (behavior.packageHang) {
          await new Promise((resolve, reject) => {
            options.signal.throwIfAborted()
            options.signal.addEventListener('abort', () => reject(new Error('Package installation cancelled')), { once: true })
          })
        }
        if (behavior.packageFailure === args[args.indexOf('apt-get') + 1]) {
          return { code: 100, stdout: '', stderr: 'Unable to install requested dependency' }
        }
        return ok()
      }
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
  return { service, removed, containers, calls, packageCalls, starts: () => starts, preparations: () => preparations, executions: () => executions, maxActive: () => maxActive }
}

test('mock backend request is accepted; missing or unsupported protocol is rejected', async () => {
  const example = await getAnalysisRequest()
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

test('dependency requests reject options, paths and apt removal actions', () => {
  for (const dependencies of ['zlib1g-dev', ['--allow-unauthenticated'], ['foo;id'], ['/tmp/package.deb'], ['foo-'], ['foo+'], ['foo bar'], [null], Array(65).fill('zlib1g-dev')]) {
    assert.throws(() => parseRequest(request({ source: 'int x;', dependencies })), /dependencies/)
  }
  assert.deepEqual(parseRequest(request({ source: 'int x;' })).dependencies, [])
  assert.deepEqual(parseRequest(request({ source: 'int x;', dependencies: ['zlib1g-dev', 'zlib1g-dev'] })).dependencies, ['zlib1g-dev'])
})

test('mock backend folder and dependencies reach staging and container installation before GCC', async t => {
  const fixture = await serviceFixture(t)
  const backendRequest = await getAnalysisRequest()
  await fixture.service.start()
  const job = fixture.service.submit(backendRequest)
  const completed = await fixture.service.wait(job.id)
  assert.equal(completed.status, 'succeeded')
  assert.match(await readFile(join(fixture.service.jobsRoot, job.id, 'input/source/main.c'), 'utf8'), /#include <zlib.h>/)
  assert.deepEqual(fixture.packageCalls.map(args => args.slice(args.indexOf('apt-get'))), [
    ['apt-get', 'update', '--error-on=any'],
    ['apt-get', 'install', '-y', '--no-install-recommends', '--', 'zlib1g-dev'],
  ])
  const installIndex = fixture.calls.findIndex(args => args.includes('install'))
  const workerIndex = fixture.calls.findIndex(args => args.includes('--job'))
  assert.ok(installIndex >= 0 && installIndex < workerIndex)
  assert.ok(completed.events.some(event => event.stage === 'installing-packages'))
  const run = fixture.calls.find(args => args[0] === 'run')
  assert.ok(!run.includes('--network=none'))
  assert.ok(!run.includes('--cap-drop=all'))
  assert.ok(run.includes('--userns=keep-id'))
  assert.equal(fixture.starts(), 1)
})

test('requests without dependencies do not invoke the package manager', async t => {
  const fixture = await serviceFixture(t)
  await fixture.service.start()
  const job = fixture.service.submit(request({ source: 'int x;' }))
  assert.equal((await fixture.service.wait(job.id)).status, 'succeeded')
  assert.equal(fixture.packageCalls.length, 0)
})

test('package failures retire the container and prevent queued analysis from using partial installations', async t => {
  for (const packageFailure of ['update', 'install']) {
    const fixture = await serviceFixture(t, { packageFailure })
    await fixture.service.start()
    const first = fixture.service.submit(request({ source: 'int x;', dependencies: ['missing-package'] }))
    const second = fixture.service.submit(request({ source: 'int y;' }))
    const failed = await fixture.service.wait(first.id)
    assert.equal(failed.status, 'failed')
    assert.match(failed.error, /Unable to install/)
    assert.equal((await fixture.service.wait(second.id)).status, 'failed')
    assert.equal(fixture.executions(), 0)
    assert.equal(fixture.containers.size, 0)
    assert.equal(fixture.removed.length, 1)
    assert.throws(() => fixture.service.submit(request({ source: 'int z;' })), /restart/)
  }
})

test('cancelling package preparation removes its container before accepting further work', async t => {
  const fixture = await serviceFixture(t, { packageHang: true })
  await fixture.service.start()
  const job = fixture.service.submit(request({ source: 'int x;', dependencies: ['zlib1g-dev'] }))
  while (fixture.packageCalls.length === 0) await new Promise(resolve => setTimeout(resolve, 1))
  fixture.service.cancel(job.id)
  assert.equal((await fixture.service.wait(job.id)).status, 'cancelled')
  assert.equal(fixture.containers.size, 0)
  assert.equal(fixture.executions(), 0)
})

test('package execution timeout retires the session before GCC runs', async t => {
  const fixture = await serviceFixture(t, { packageTimeout: true })
  await fixture.service.start()
  const job = fixture.service.submit(request({ source: 'int x;', dependencies: ['zlib1g-dev'] }))
  const completed = await fixture.service.wait(job.id)
  assert.equal(completed.status, 'failed')
  assert.match(completed.error, /timed out/)
  assert.equal(fixture.containers.size, 0)
  assert.equal(fixture.executions(), 0)
})

test('container memory and PID limits are configurable and validated', async t => {
  const fake = fakePodman()
  const environment = new PodmanRuntime({ command: fake.command, platform: 'linux', image: 'ghcr.io/example/analysis:v1' })
  const jobsRoot = await mkdtemp(join(tmpdir(), 'lexeme-limits-'))
  t.after(() => rm(jobsRoot, { recursive: true, force: true }))
  const service = new AnalysisService({ environment, jobsRoot, memory: '2g', pidsLimit: 256 })
  await service.start()
  const run = fake.calls.find(call => call[1] === 'run')
  assert.ok(run.includes('--memory=2g') && run.includes('--pids-limit=256'))
  await service.shutdown()
  assert.throws(() => new AnalysisService({ environment, jobsRoot, memory: '2 gigs' }))
  assert.throws(() => new AnalysisService({ environment, jobsRoot, pidsLimit: 1 }))
})

test('macOS uses a rootless Podman machine; pull=missing reuses a local image', async () => {
  const machineInfo = JSON.stringify({ host: { serviceIsRemote: true, security: { rootless: true } } })
  const fake = fakePodman({ command: async (_program, args) => args[0] === 'info' ? ok(machineInfo) : args[0] === 'image' ? ok() : undefined })
  const image = 'ghcr.io/example/analysis:v1'
  const runtime = new PodmanRuntime({ command: fake.command, platform: 'darwin', image, pull: 'missing' })
  assert.equal(await runtime.ensureReady(), image)
  assert.deepEqual(fake.calls.map(call => call[1]), ['--version', 'info', 'image'])
})

test('analyze requests validate every unit and stage an analyze job', async t => {
  assert.throws(() => parseRequest(request({ operation: 'analyze', source: 'x' })), /units/)
  assert.throws(() => parseRequest(request({ operation: 'analyze', source: 'x', units: [{ file: '../a.c' }] })))
  assert.throws(() => parseRequest(request({ operation: 'analyze', source: 'x', units: [{ file: 'a.c', std: 'c++17' }] })), /standard/)
  const parsed = parseRequest(request({ operation: 'analyze', source: 'int main(void){}', units: [{ file: 'main.c', defines: ['X=1'] }] }))
  assert.deepEqual(parsed.units, [{ file: 'main.c', includeDirs: [], defines: ['X=1'], std: 'c11' }])
  assert.equal(parsed.entryFile, 'main.c')
  const fake = fakePodman()
  const environment = new PodmanRuntime({ command: fake.command, platform: 'linux', image: 'ghcr.io/example/analysis:v1' })
  const jobsRoot = await mkdtemp(join(tmpdir(), 'lexeme-analyze-'))
  t.after(() => rm(jobsRoot, { recursive: true, force: true }))
  const service = new AnalysisService({ environment, jobsRoot })
  await service.start()
  const job = service.submit(request({ operation: 'analyze', source: 'int main(void){return 0;}', units: [{ file: 'main.c' }] }))
  await service.wait(job.id)
  const staged = JSON.parse(await readFile(join(service.jobsRoot, job.id, 'input', 'request.json'), 'utf8'))
  assert.equal(staged.operation, 'analyze')
  assert.deepEqual(staged.units, [{ file: 'main.c', includeDirs: [], defines: [], std: 'c11' }])
  await service.shutdown()
})

test('local images are reused while their inputs are unchanged, rebuilt otherwise, never pulled', async () => {
  const { imageInputsHash } = await import('../dist/environment.js')
  const context = new URL('..', import.meta.url).pathname
  const current = await imageInputsHash(context)
  for (const [label, rebuilt] of [[current, false], ['stale', true]]) {
    const fake = fakePodman({ command: async (_program, args) => args[0] === 'image' ? ok(`${label}\n`) : undefined })
    const runtime = new PodmanRuntime({ command: fake.command, platform: 'linux', image: 'localhost/lexeme-analysis:dev', buildContext: context })
    await runtime.ensureReady()
    assert.equal(fake.calls.some(call => call[1] === 'build'), rebuilt)
    assert.ok(!fake.calls.some(call => call[1] === 'pull'))
  }
})
