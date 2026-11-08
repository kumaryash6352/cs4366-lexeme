import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runCommand } from '../dist/command.js'
import { openWorkerLog } from '../dist/worker-log.js'

test('command logging preserves output beyond 64K while keeping a small error tail', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lexeme-log-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'worker.log')
  const log = await openWorkerLog(path, 200000)
  const result = await runCommand(process.execPath, ['-e', 'process.stderr.write("x".repeat(100000) + "END")'], {
    tailBytes: 16, onStderr: text => log.write(text),
  })
  await log.close()
  assert.equal(result.code, 0)
  assert.equal(result.stderr, 'x'.repeat(13) + 'END')
  assert.equal(await readFile(path, 'utf8'), 'x'.repeat(100000) + 'END')
})

test('log byte budget is shared across stdout/stderr and records truncation once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lexeme-log-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'worker.log')
  const log = await openWorkerLog(path, 100)
  await Promise.all([log.write('é'.repeat(40)), log.write('x'.repeat(40))])
  await log.write('ignored')
  await log.close()
  const data = await readFile(path)
  assert.equal(data.length, 100)
  assert.ok(data.toString().endsWith('\n[worker log truncated]\n'))
  assert.equal(data.toString().match(/worker log truncated/g).length, 1)
})

test('command awaits asynchronous output consumers and reports write failures', async () => {
  let received = ''
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("done")'], {
    onStdout: async text => {
      await new Promise(resolve => setTimeout(resolve, 10))
      received += text
    },
  })
  assert.equal(result.code, 0)
  assert.equal(received, 'done')
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stderr.write("data"); setInterval(() => {}, 1000)'], {
    onStderr: async () => { throw new Error('disk full') },
  }), /disk full/)
})
