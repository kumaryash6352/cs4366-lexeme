import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnalysisService } from '../dist/index.js'
import { PodmanRuntime } from '../dist/environment.js'
import { parseRequest, parseResult } from '../dist/contracts.js'
import { getAnalysisRequest } from './mock-backend.mjs'
import { loadRuntimeConfig, parseRuntimeConfig } from '../dist/config.js'

const request = fields => ({ schemaVersion: 1, operation: 'parse', ...fields })
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
const runtimeInfo = JSON.stringify({ host: { serviceIsRemote: false, security: { rootless: true } } })
const registryConfig = () => ({ ...loadRuntimeConfig(), image: 'ghcr.io/your-owner/analysiscontainer:v1', localDevelopment: false })
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
  assert.equal(await runtime.ensureReady(undefined, registryConfig()), image)
  assert.deepEqual(fake.calls, [
    ['podman', '--version'], ['podman', 'info', '--format', 'json'], ['podman', 'pull', image],
  ])
})

test('default image comes from the supplied runtime configuration', async () => {
  const savedImage = process.env.LEXEME_ANALYSIS_IMAGE
  delete process.env.LEXEME_ANALYSIS_IMAGE
  try {
    const config = registryConfig()
    const fake = fakePodman()
    const runtime = new PodmanRuntime({ command: fake.command, platform: 'linux' })
    assert.equal(await runtime.ensureReady(undefined, config), config.image)
    assert.deepEqual(fake.calls.at(-1), ['podman', 'pull', config.image])
  } finally {
    if (savedImage === undefined) delete process.env.LEXEME_ANALYSIS_IMAGE
    else process.env.LEXEME_ANALYSIS_IMAGE = savedImage
  }
})

test('registry failures stop startup without falling back to a cached image', async () => {
  const fake = fakePodman({ command: async (_program, args) => args[0] === 'pull'
    ? { code: 125, stdout: '', stderr: 'registry access denied' } : undefined })
  const runtime = new PodmanRuntime({ command: fake.command, platform: 'linux' })
  await assert.rejects(runtime.ensureReady(undefined, registryConfig()), /registry access denied/)
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
  await assert.rejects(new PodmanRuntime({ command: unsupported.command, platform: 'darwin' }).ensureReady(), /Linux/)
  assert.equal(unsupported.calls.length, 0)
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
    await assert.rejects(new PodmanRuntime({ command: fake.command, platform: 'linux' }).ensureReady(undefined, registryConfig()), /storage unavailable/)
    assert.deepEqual(fake.calls.map(call => call[1]), stage === 'info' ? ['--version', 'info'] : ['--version', 'info', 'pull'])
  }
})

async function serviceFixture(t, behavior = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lexeme-test-'))
  const containers = new Map()
  const removed = []
  const calls = []
  const packageCalls = []
  const installed = new Map()
  const workerPackages = []
  const environmentConfigs = []
  let starts = 0
  let preparations = 0
  let executions = 0
  let active = 0
  let maxActive = 0
  const environment = {
    ensureReady: async (notify, config) => { preparations++; environmentConfigs.push(config); await behavior.beforeReady?.(); notify?.('image-ready', config.image); return config.image },
    command: async (_program, args, options = {}) => {
      calls.push(args)
      if (args[0] === 'run') {
        starts++
        const name = args[args.indexOf('--name') + 1]
        const mount = args[args.indexOf('--volume') + 1]
        const [host, target] = mount.split(':')
        assert.equal(target, `/jobs/${name.slice('lexeme-job-'.length)}`)
        containers.set(name, host)
        installed.set(name, new Set())
        if (behavior.afterRun) await behavior.afterRun()
        if (behavior.failRun) return { code: 125, stdout: '', stderr: 'container startup failed' }
        return ok('container-id')
      }
      if (args[0] === 'rm') {
        await behavior.beforeRemove?.()
        if (behavior.failRemoveOnce) {
          behavior.failRemoveOnce = false
          return { code: 125, stdout: '', stderr: 'cleanup unavailable' }
        }
        removed.push(args.at(-1))
        containers.delete(args.at(-1))
        installed.delete(args.at(-1))
        return ok()
      }
      if (args[0] === 'exec' && args.includes('apt-get')) {
        packageCalls.push(args)
        assert.equal(args[args.indexOf('--user') + 1], '0:0')
        assert.ok(containers.has(args[args.indexOf('apt-get') - 1]))
        assert.equal(options.timeoutMs, behavior.config?.timeouts.packageCommandMs ?? 300_000)
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
        if (args.includes('install')) {
          const packages = installed.get(args[args.indexOf('apt-get') - 1])
          for (const name of args.slice(args.indexOf('--') + 1)) packages.add(name)
        }
        return ok()
      }
      if (args[0] === 'exec' && args.includes('--self-check')) {
        return behavior.failSelfCheck ? { ...ok(), code: 1, stderr: 'self-check failure' } : ok(JSON.stringify({ graphProtocol: behavior.oldWorker ? 0 : 1 }))
      }
      if (args[0] === 'exec') {
        if (behavior.execThrows) throw new Error('exec disconnected')
        assert.ok(containers.has(args[1]), 'job must use the existing container')
        const jobId = args[args.indexOf('--job') + 1]
        assert.equal(args[1], `lexeme-job-${jobId}`)
        const dir = containers.get(args[1])
        workerPackages.push([...installed.get(args[1])])
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
          await options.onStdout?.('{"type":"progress","sta')
          await options.onStdout?.('ge":"checking-syntax"}\n{"type":"progress","stage":"preprocessing"}\n')
          if (behavior.stderr) await options.onStderr?.(behavior.stderr)
          const failed = cancelled || behavior.failure
          if (!behavior.noResult) {
            const artifacts = [{ kind: 'graphs', path: 'graphs.json' }, { kind: 'preprocessed-source', path: 'main.i' }]
            if (behavior.reverseArtifacts) artifacts.reverse()
            await writeFile(join(dir, 'output/result.json'), JSON.stringify({
              schemaVersion: 1, jobId: input.jobId, status: failed ? 'failed' : 'succeeded',
              artifacts: failed ? [] : artifacts,
              diagnostics: failed ? [{ stage: 'checking-syntax', message: cancelled ? 'cancelled' : 'bad C syntax' }] : [],
            }))
            if (!failed) await writeFile(join(dir, 'output/graphs.json'), JSON.stringify({ schemaVersion: 1, translationUnits: [], files: [], includes: { edges: [] }, calls: { nodes: [], edges: [] }, controlFlow: [] }))
            if (!failed) await writeFile(join(dir, 'output/main.i'), '# 1 "main.c"\nint main(void) { return 0; }')
          }
          return { code: failed ? 1 : 0, stdout: behavior.stdout ?? '', stderr: behavior.stderr ?? '' }
        } finally { active-- }
      }
      throw new Error(`Unexpected fake command: ${args.join(' ')}`)
    },
  }
  const configPath = join(root, 'runtime.config.json')
  if (behavior.config) await writeFile(configPath, JSON.stringify(behavior.config))
  const service = new AnalysisService({
    environment, jobsRoot: root,
    ...(behavior.config ? { configPath } : {}),
    ...(behavior.timeoutMs !== undefined || !behavior.config ? { timeoutMs: behavior.timeoutMs ?? 1000 } : {}),
  })
  t.after(async () => { await service.shutdown(); await rm(root, { recursive: true, force: true }) })
  return { service, removed, containers, calls, packageCalls, workerPackages, environmentConfigs, configPath, starts: () => starts, preparations: () => preparations, executions: () => executions, maxActive: () => maxActive }
}

test('normalized requests can be submitted in all three input modes', async t => {
  const fixture = await serviceFixture(t)
  await fixture.service.start()
  const project = getAnalysisRequest()
  for (const input of [
    request({ source: 'int x;' }),
    { ...project, entryFile: 'main.c', defines: ['VALUE=1'] },
    project,
  ]) {
    const normalized = parseRequest(input)
    assert.deepEqual(parseRequest(normalized), normalized)
    const job = fixture.service.submit(normalized)
    assert.equal((await fixture.service.wait(job.id)).status, 'succeeded')
    const staged = JSON.parse(await readFile(join(fixture.service.jobsRoot, job.id, 'input/request.json'), 'utf8'))
    if (normalized.entryFile === undefined) {
      for (const field of ['entryFile', 'includeDirs', 'defines']) {
        assert.equal(Object.hasOwn(normalized, field), false)
        assert.equal(Object.hasOwn(staged, field), false)
      }
    } else {
      assert.deepEqual(staged.includeDirs, ['.'])
      assert.deepEqual(staged.defines, input.defines ?? [])
    }
  }
  assert.deepEqual(fixture.workerPackages, [[], ['zlib1g-dev'], ['zlib1g-dev']])
})

test('queued jobs retain the compiler settings supplied at submission', async t => {
  const fixture = await serviceFixture(t)
  await fixture.service.start()
  const defines = ['VALUE=1']
  const job = fixture.service.submit(request({ source: 'int x = VALUE;', defines }))
  defines[0] = 'VALUE=2'
  defines.push('EXTRA=1')
  assert.equal((await fixture.service.wait(job.id)).status, 'succeeded')
  const staged = JSON.parse(await readFile(join(fixture.service.jobsRoot, job.id, 'input/request.json'), 'utf8'))
  assert.deepEqual(staged.defines, ['VALUE=1'])
})

test('mock backend request is accepted; missing or unsupported protocol is rejected', async () => {
  const example = await getAnalysisRequest()
  assert.equal(parseRequest(example).operation, 'parse')
  assert.throws(() => parseRequest({ source: 'int x;' }), /schemaVersion/)
  assert.throws(() => parseRequest({ ...example, schemaVersion: 2 }), /schemaVersion/)
})

test('startup prepares the image once; queued jobs each create and remove a distinct container', async t => {
  const fixture = await serviceFixture(t)
  assert.throws(() => fixture.service.submit(request({ source: 'int x;' })), /start/)
  await Promise.all([fixture.service.start(), fixture.service.start()])
  assert.equal(fixture.starts(), 0)
  const first = fixture.service.submit(request({ source: 'int first;' }))
  const second = fixture.service.submit(request({ source: 'int second;' }))
  const results = await Promise.all([fixture.service.wait(first.id), fixture.service.wait(second.id)])
  assert.ok(results.every(job => job.status === 'succeeded'))
  assert.ok(results[0].events.some(event => event.stage === 'checking-syntax'))
  assert.equal(fixture.starts(), 2)
  assert.equal(fixture.preparations(), 1)
  assert.equal(fixture.containers.size, 0)
  assert.equal(fixture.removed.length, 2)
  assert.equal(fixture.maxActive(), 1)
  assert.equal(new Set(fixture.removed).size, 2)
  assert.deepEqual(fixture.calls.filter(args => ['run', 'rm'].includes(args[0])).map(args => args[0]), ['run', 'rm', 'run', 'rm'])
  assert.equal(await readFile(join(fixture.service.jobsRoot, first.id, 'input/source/main.c'), 'utf8'), 'int first;')
  assert.equal(await readFile(join(fixture.service.jobsRoot, second.id, 'input/source/main.c'), 'utf8'), 'int second;')
  await Promise.all([fixture.service.shutdown(), fixture.service.shutdown()])
  assert.equal(fixture.removed.length, 2)
  assert.equal(fixture.containers.size, 0)
})

test('compiler failures and missing result files remove the job container', async t => {
  for (const behavior of [{ failure: true }, { noResult: true }]) {
    const fixture = await serviceFixture(t, behavior)
    await fixture.service.start()
    const job = fixture.service.submit(request({ source: 'bad C' }))
    const result = await fixture.service.wait(job.id)
    assert.equal(result.status, 'failed')
    if (behavior.noResult) assert.match(result.error, /Worker did not produce result.json/)
    else assert.equal(result.result.diagnostics[0].message, 'bad C syntax')
    assert.equal(fixture.removed.length, 1)
    assert.equal(fixture.containers.size, 0)
  }
})

test('worker crashes without a result preserve exit diagnostics and remove the container', async t => {
  for (const output of [
    { stderr: 'Cannot find worker module', stdout: 'earlier progress' },
    { stdout: 'Worker startup failed' },
  ]) {
    const fixture = await serviceFixture(t, { failure: true, noResult: true, ...output })
    await fixture.service.start()
    const job = fixture.service.submit(request({ source: 'int x;' }))
    const result = await fixture.service.wait(job.id)
    assert.equal(result.status, 'failed')
    assert.equal(result.error, `Worker process failed (1): ${output.stderr ?? output.stdout}`)
    assert.equal(fixture.removed.length, 1)
    assert.equal(fixture.containers.size, 0)
  }
})

test('default artifact is graphs.json regardless of worker artifact order', async t => {
  const fixture = await serviceFixture(t, { reverseArtifacts: true })
  await fixture.service.start()
  const job = fixture.service.submit(request({ source: 'int x;' }))
  const result = await fixture.service.wait(job.id)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.result.artifacts[0].path, 'main.i')
  const output = join(fixture.service.jobsRoot, job.id, 'output')
  assert.equal(fixture.service.artifactPath(job.id), join(output, 'graphs.json'))
  assert.equal(fixture.service.artifactPath(job.id, 'main.i'), join(output, 'main.i'))
  assert.equal(fixture.service.artifactPath(job.id, 'missing.i'), undefined)
})

test('timed-out job is removed before the next request uses a fresh container', async t => {
  const fixture = await serviceFixture(t, { hangFirst: true, timeoutMs: 30 })
  await fixture.service.start()
  const first = fixture.service.submit(request({ source: 'int x;' }))
  assert.equal((await fixture.service.wait(first.id)).status, 'timed-out')
  const second = fixture.service.submit(request({ source: 'int y;' }))
  assert.equal((await fixture.service.wait(second.id)).status, 'succeeded')
  assert.equal(fixture.removed.length, 2)
  assert.equal(fixture.starts(), 2)
})

test('cancelling a running request waits for the worker and removes its container', async t => {
  const fixture = await serviceFixture(t, { hangFirst: true })
  await fixture.service.start()
  const job = fixture.service.submit(request({ source: 'int x;' }))
  while (fixture.service.get(job.id).status !== 'running') await new Promise(resolve => setTimeout(resolve, 1))
  fixture.service.cancel(job.id)
  assert.equal((await fixture.service.wait(job.id)).status, 'cancelled')
  assert.equal(fixture.containers.size, 0)
  assert.equal(fixture.removed.length, 1)
})

test('shutdown during image preparation never creates a container or executes queued requests', async t => {
  let release
  let notify
  const started = new Promise(resolve => { notify = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const fixture = await serviceFixture(t, { beforeReady: async () => { notify(); await gate } })
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

test('worker self-check failure cleans up the job container', async t => {
  const fixture = await serviceFixture(t, { failSelfCheck: true })
  await fixture.service.start()
  const job = fixture.service.submit(request({ source: 'int x;' }))
  const result = await fixture.service.wait(job.id)
  assert.equal(result.status, 'failed')
  assert.match(result.error, /self-check failure/)
  assert.equal(fixture.containers.size, 0)
  assert.equal(fixture.removed.length, 1)
})

test('unresponsive exec removes only its job container; subsequent requests can run', async t => {
  const behavior = { execThrows: true }
  const fixture = await serviceFixture(t, behavior)
  await fixture.service.start()
  const job = fixture.service.submit(request({ source: 'int x;' }))
  assert.equal((await fixture.service.wait(job.id)).status, 'failed')
  assert.equal(fixture.containers.size, 0)
  behavior.execThrows = false
  const next = fixture.service.submit(request({ source: 'int y;' }))
  assert.equal((await fixture.service.wait(next.id)).status, 'succeeded')
  assert.equal(fixture.removed.length, 2)
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
  for (const dependencies of ['zlib1g-dev', ['--allow-unauthenticated'], ['foo;id'], ['/tmp/package.deb'], ['foo-'], ['foo+'], ['foo bar'], [null]]) {
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

test('package failures discard partial installations and the next queued job succeeds', async t => {
  for (const packageFailure of ['update', 'install']) {
    const fixture = await serviceFixture(t, { packageFailure })
    await fixture.service.start()
    const first = fixture.service.submit(request({ source: 'int x;', dependencies: ['missing-package'] }))
    const second = fixture.service.submit(request({ source: 'int y;' }))
    const failed = await fixture.service.wait(first.id)
    assert.equal(failed.status, 'failed')
    assert.match(failed.error, /Unable to install/)
    assert.equal((await fixture.service.wait(second.id)).status, 'succeeded')
    assert.equal(fixture.executions(), 1)
    assert.equal(fixture.containers.size, 0)
    assert.equal(fixture.removed.length, 2)
    assert.deepEqual(fixture.workerPackages, [[]])
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

test('package execution timeout removes its job container before GCC runs', async t => {
  const fixture = await serviceFixture(t, { packageTimeout: true })
  await fixture.service.start()
  const job = fixture.service.submit(request({ source: 'int x;', dependencies: ['zlib1g-dev'] }))
  const completed = await fixture.service.wait(job.id)
  assert.equal(completed.status, 'failed')
  assert.match(completed.error, /timed out/)
  assert.equal(fixture.containers.size, 0)
  assert.equal(fixture.executions(), 0)
})


test('package dependencies never carry over to another trial', async t => {
  const fixture = await serviceFixture(t)
  await fixture.service.start()
  const jobs = [
    ['zlib1g-dev'], ['libssl-dev'], [],
  ].map(dependencies => fixture.service.submit(request({ source: 'int x;', dependencies })))
  for (const job of jobs) assert.equal((await fixture.service.wait(job.id)).status, 'succeeded')
  assert.deepEqual(fixture.workerPackages, [['zlib1g-dev'], ['libssl-dev'], []])
  assert.equal(new Set(fixture.removed).size, 3)
  assert.equal(fixture.containers.size, 0)
})

test('shutdown during container creation cleans it up and skips queued jobs', async t => {
  let release
  let notify
  const started = new Promise(resolve => { notify = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const fixture = await serviceFixture(t, { afterRun: async () => { notify(); await gate } })
  await fixture.service.start()
  const first = fixture.service.submit(request({ source: 'int x;' }))
  const second = fixture.service.submit(request({ source: 'int y;' }))
  await started
  const shutdown = fixture.service.shutdown()
  release()
  await shutdown
  assert.equal((await fixture.service.wait(first.id)).status, 'cancelled')
  assert.equal((await fixture.service.wait(second.id)).status, 'cancelled')
  assert.equal(fixture.executions(), 0)
  assert.equal(fixture.starts(), 1)
  assert.equal(fixture.removed.length, 1)
  assert.equal(fixture.containers.size, 0)
})

test('failed container startup still attempts removal', async t => {
  const fixture = await serviceFixture(t, { failRun: true })
  await fixture.service.start()
  const job = fixture.service.submit(request({ source: 'int x;' }))
  assert.equal((await fixture.service.wait(job.id)).status, 'failed')
  assert.equal(fixture.removed.length, 1)
  assert.equal(fixture.containers.size, 0)
})

test('cleanup failure fails the job, blocks further trials, and is retried at shutdown', async t => {
  const fixture = await serviceFixture(t, { failRemoveOnce: true })
  await fixture.service.start()
  const first = fixture.service.submit(request({ source: 'int x;' }))
  const second = fixture.service.submit(request({ source: 'int y;' }))
  const result = await fixture.service.wait(first.id)
  assert.equal(result.status, 'failed')
  assert.match(result.error, /cleanup unavailable/)
  assert.equal(fixture.service.artifactPath(first.id), undefined)
  assert.equal((await fixture.service.wait(second.id)).status, 'failed')
  assert.equal(fixture.starts(), 1)
  assert.throws(() => fixture.service.submit(request({ source: 'int z;' })), /cleanup failed/)
  await fixture.service.shutdown()
  assert.equal(fixture.containers.size, 0)
})

test('wait and successful status are withheld until container removal finishes', async t => {
  let release
  let notify
  const removing = new Promise(resolve => { notify = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const fixture = await serviceFixture(t, { beforeRemove: async () => { notify(); await gate } })
  await fixture.service.start()
  const job = fixture.service.submit(request({ source: 'int x;' }))
  let finished = false
  const completion = fixture.service.wait(job.id).then(result => { finished = true; return result })
  await removing
  assert.equal(finished, false)
  assert.equal(fixture.service.get(job.id).status, 'running')
  assert.equal(fixture.service.artifactPath(job.id), undefined)
  release()
  assert.equal((await completion).status, 'succeeded')
  assert.equal(fixture.containers.size, 0)
})


test('runtime configuration rejects malformed settings and unsupported worker timeouts', () => {
  const defaults = loadRuntimeConfig()
  for (const section of ['container', 'timeouts', 'limits']) {
    assert.throws(() => parseRuntimeConfig({ ...defaults, [section]: null }), /must be an object/)
  }
  for (const [section, keys] of [
    ['container', ['pidsLimit']],
    ['timeouts', ['analysisMs', 'imagePullMs', 'packageCommandMs']],
    ['limits', Object.keys(defaults.limits)],
  ]) {
    for (const key of keys) {
      for (const invalid of [undefined, '10', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const config = structuredClone(defaults)
        config[section][key] = invalid
        assert.throws(() => parseRuntimeConfig(config), /must be an integer/)
      }
    }
  }
  for (const memory of ['0', '-512m', '512m --privileged', 512]) {
    assert.throws(() => parseRuntimeConfig({ ...defaults, container: { ...defaults.container, memory } }), /container.memory/)
  }
  assert.throws(() => parseRuntimeConfig({ ...defaults, timeouts: { ...defaults.timeouts, analysisMs: 600001 } }), /analysisMs/)
  for (const key of ['imagePullMs', 'packageCommandMs']) {
    assert.throws(() => parseRuntimeConfig({ ...defaults, timeouts: { ...defaults.timeouts, [key]: 2147483648 } }), /must be an integer/)
  }
  assert.throws(() => new AnalysisService({ timeoutMs: 600001 }), /timeoutMs/)
})

test('configured image pull timeout reaches Podman', async () => {
  const config = registryConfig()
  config.timeouts.imagePullMs = 43210
  const fake = fakePodman({ command: async (_program, args, options) => {
    if (args[0] === 'pull') assert.equal(options.timeoutMs, 43210)
  } })
  await new PodmanRuntime({ command: fake.command, platform: 'linux' }).ensureReady(undefined, config)
  assert.ok(fake.calls.some(call => call[1] === 'pull'))
})

test('configuration is read once and controls job resources and timeouts', async t => {
  const config = loadRuntimeConfig()
  config.container = { memory: '1g', pidsLimit: 64 }
  config.timeouts = { analysisMs: 1234, imagePullMs: 2345, packageCommandMs: 3456 }
  const fixture = await serviceFixture(t, { config })
  // Editing the file after construction must not alter this service's settings.
  await writeFile(fixture.configPath, 'invalid JSON')
  await fixture.service.start()
  const job = fixture.service.submit(request({ source: 'int x;', dependencies: ['zlib1g-dev'] }))
  assert.equal((await fixture.service.wait(job.id)).status, 'succeeded')
  assert.deepEqual(fixture.environmentConfigs, [config])
  const run = fixture.calls.find(args => args[0] === 'run')
  assert.ok(run.includes('--memory=1g'))
  assert.ok(run.includes('--pids-limit=64'))
  const worker = fixture.calls.find(args => args.includes('--job'))
  assert.equal(worker[worker.indexOf('--timeout-ms') + 1], '1234')
  assert.equal(fixture.packageCalls.length, 2)
})

test('constructor timeout override takes precedence over the configuration', async t => {
  const config = loadRuntimeConfig()
  config.timeouts.analysisMs = 1234
  const fixture = await serviceFixture(t, { config, timeoutMs: 2345 })
  await fixture.service.start()
  const job = fixture.service.submit(request({ source: 'int x;' }))
  assert.equal((await fixture.service.wait(job.id)).status, 'succeeded')
  const worker = fixture.calls.find(args => args.includes('--job'))
  assert.equal(worker[worker.indexOf('--timeout-ms') + 1], '2345')
})

test('configured file, size and nesting limits reject projects before container creation', async t => {
  const source = await mkdtemp(join(tmpdir(), 'lexeme-limits-'))
  t.after(() => rm(source, { recursive: true, force: true }))
  await mkdir(join(source, 'include'))
  await writeFile(join(source, 'main.c'), 'int x;')
  await writeFile(join(source, 'include/value.h'), '#define VALUE 1')
  for (const limit of ['projectFiles', 'projectBytes', 'projectDepth']) {
    const config = loadRuntimeConfig()
    config.limits[limit] = 1
    const fixture = await serviceFixture(t, { config })
    await fixture.service.start()
    const job = fixture.service.submit(request({ projectDir: source }))
    const result = await fixture.service.wait(job.id)
    assert.equal(result.status, 'failed', limit)
    assert.match(result.error, /Project (limit|nesting)/)
    assert.equal(fixture.starts(), 0)
  }
  const fixture = await serviceFixture(t)
  await fixture.service.start()
  const job = fixture.service.submit(request({ projectDir: source, entryFile: 'main.c' }))
  assert.equal((await fixture.service.wait(job.id)).status, 'succeeded')
})

test('request budgets are configurable, count source bytes, and deduplicate dependencies', () => {
  const limits = { ...loadRuntimeConfig().limits, sourceBytes: 4, includeDirs: 1, defines: 1, maxRequestedDependencies: 1 }
  assert.equal(parseRequest(request({ source: 'éé' }), limits).source, 'éé')
  assert.throws(() => parseRequest(request({ source: 'ééx' }), limits), /4 bytes/)
  assert.throws(() => parseRequest(request({ source: '', includeDirs: ['.', 'include'] }), limits), /1 paths/)
  assert.throws(() => parseRequest(request({ source: '', defines: ['ONE', 'TWO'] }), limits), /1 NAME/)
  assert.deepEqual(parseRequest(request({ source: '', dependencies: Array(200).fill('zlib1g-dev') }), limits).dependencies, ['zlib1g-dev'])
  assert.throws(() => parseRequest(request({ source: '', dependencies: ['zlib1g-dev', 'libssl-dev'] }), limits), /1 unique/)
  const large = { ...limits, includeDirs: 40, defines: 40, maxRequestedDependencies: 70 }
  assert.equal(parseRequest(request({ source: '', includeDirs: Array(40).fill('.'), defines: Array(40).fill('ONE'), dependencies: Array.from({ length: 70 }, (_, i) => `package-${i}`) }), large).dependencies.length, 70)
  assert.equal(parseRequest(request({ projectDir: '/project' })).entryFile, undefined)
  assert.throws(() => parseRequest(request({ projectDir: '/project', defines: ['IGNORED'] })), /CMakeLists.txt/)
  assert.throws(() => parseRequest(request({ projectDir: '/project', includeDirs: ['include'] })), /CMakeLists.txt/)
})

test('service uses configured request and log budgets, including installation above 64 packages', async t => {
  const config = loadRuntimeConfig()
  config.limits.sourceBytes = 10
  config.limits.workerLogBytes = 200
  const fixture = await serviceFixture(t, { config, stderr: 'x'.repeat(1000) })
  await fixture.service.start()
  assert.throws(() => fixture.service.submit(request({ source: 'x'.repeat(11) })), /10 bytes/)
  const dependencies = Array.from({ length: 70 }, (_, i) => `package-${i}`)
  const job = fixture.service.submit(request({ source: 'int x;', dependencies }))
  assert.equal((await fixture.service.wait(job.id)).status, 'succeeded')
  assert.deepEqual(fixture.workerPackages, [dependencies])
  const log = await readFile(join(fixture.service.jobsRoot, job.id, 'worker.log'))
  assert.equal(log.length, 200)
  assert.ok(log.toString().endsWith('[worker log truncated]\n'))
})

test('result accepts multiple translation units while rejecting unsafe artifact paths', () => {
  const result = { schemaVersion: 1, jobId: 'job', status: 'succeeded', diagnostics: [], artifacts: [
    { kind: 'preprocessed-source', path: 'unit-1.i', source: 'src/first.c' },
    { kind: 'preprocessed-source', path: 'unit-2.i', source: 'src/second.c' },
  ] }
  result.artifacts.unshift({ kind: 'graphs', path: 'graphs.json' })
  assert.equal(parseResult(result, 'job').artifacts.length, 3)
  for (const path of ['../main.i', '/tmp/main.i', 'sub/main.i']) {
    assert.throws(() => parseResult({ ...result, artifacts: [{ kind: 'preprocessed-source', path }] }, 'job'), /unsupported artifact/)
  }
})

test('local development uses an existing image without pulling', async () => {
  const config = loadRuntimeConfig()
  config.localDevelopment = true
  const fake = fakePodman({ command: async (_program, args) => args[0] === 'image' ? ok() : undefined })
  await new PodmanRuntime({ command: fake.command, platform: 'linux' }).ensureReady(undefined, config)
  assert.deepEqual(fake.calls.at(-1), ['podman', 'image', 'exists', config.image])
  assert.ok(!fake.calls.some(call => call[1] === 'pull'))
  const absent = fakePodman()
  await assert.rejects(new PodmanRuntime({ command: absent.command, platform: 'linux' }).ensureReady(undefined, config), /build analysis\/Containerfile first/)
})

test('local development mounts repository worker read-only and returns graphs.json', async t => {
  const config = loadRuntimeConfig()
  config.localDevelopment = true
  // The generic fixture expects the first mount to be the job; local worker is added second.
  const fixture = await serviceFixture(t, { config })
  await fixture.service.start()
  const job = fixture.service.submit(request({ source: 'int x;' }))
  assert.equal((await fixture.service.wait(job.id)).status, 'succeeded')
  assert.ok(fixture.calls.find(args => args[0] === 'run').some(arg => arg.endsWith(':/app/worker:ro,Z')))
  assert.equal(fixture.service.artifactPath(job.id), join(fixture.service.jobsRoot, job.id, 'output', 'graphs.json'))
})

test('old workers fail before dependency installation with a rebuild instruction', async t => {
  const fixture = await serviceFixture(t, { oldWorker: true })
  await fixture.service.start()
  const job = fixture.service.submit(request({ source: 'int x;', dependencies: ['zlib1g-dev'] }))
  const result = await fixture.service.wait(job.id)
  assert.equal(result.status, 'failed')
  assert.match(result.error, /graph protocol 1; rebuild/)
  assert.equal(fixture.packageCalls.length, 0)
  assert.equal(fixture.removed.length, 1)
})

test('successful worker results require the graph artifact', () => {
  const result = { schemaVersion: 1, jobId: 'job', status: 'succeeded', artifacts: [{ kind: 'preprocessed-source', path: 'main.i' }], diagnostics: [] }
  assert.throws(() => parseResult(result, 'job'), /graphs.json/)
})
