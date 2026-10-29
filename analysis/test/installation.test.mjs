import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installPodman } from '../dist/setup/installation.js'
const ok = () => ({ code: 0, stdout: '', stderr: '' })

test('Ubuntu installation uses apt and stops on failure', async () => {
  const calls = []
  await installPodman(async (program, args) => { calls.push([program, ...args]); return ok() }, () => {}, async () => 'ID=ubuntu')
  assert.deepEqual(calls, [
    ['sudo', '-n', 'true'],
    ['sudo', '-n', 'apt-get', 'update'],
    ['sudo', '-n', 'apt-get', 'install', '-y', 'podman'],
  ])
  await assert.rejects(installPodman(async () => ({ ...ok(), code: 1 }), () => {}, async () => 'ID=ubuntu'), /sudo authorization/)
  await assert.rejects(installPodman(async () => { throw new Error('Must not run') }, () => {}, async () => 'ID=unknown'), /requires Ubuntu/)
})
