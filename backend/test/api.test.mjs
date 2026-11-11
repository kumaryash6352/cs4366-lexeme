import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const port = 3900 + Math.floor(Math.random() * 90)
const base = `http://127.0.0.1:${port}/api`
let server, dataDir

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'lexeme-api-'))
  server = spawn(process.execPath, ['backend/app.ts'], { env: { ...process.env, LEXEME_PORT: String(port), LEXEME_DATA_DIR: dataDir }, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('backend did not start')
})
after(async () => { server?.kill(); await rm(dataDir, { recursive: true, force: true }) })

const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('sample analyzes into all four graph kinds', async () => {
  const sample = await (await fetch(`${base}/sample`)).json()
  const result = await (await post('/analyze', sample)).json()
  assert.equal(result.schemaVersion, 3)
  assert.deepEqual(result.functions.map(f => f.id), ['main', 'calculate'])
  assert.ok(result.program.edges.some(e => e.kind === 'param'))
  assert.ok(result.functions[0].cfg.nodes.length > 10 && result.functions[0].data.edges.length > 0)
  assert.ok(result.calls.edges.some(e => e.source === 'main' && e.target === 'calculate'))
  assert.equal(result.includes.entry, 'main.c')
})

test('invalid requests return 400 with a message', async () => {
  const response = await post('/analyze', { units: ['../etc/passwd.c'], files: [{ path: '../etc/passwd.c', text: '' }] })
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /path/)
})

test('sessions save, list, load, and delete', async () => {
  const saved = await (await post('/sessions', { name: 'demo', project: { files: [] } })).json()
  assert.deepEqual((await (await fetch(`${base}/sessions`)).json()).map(s => s.name), ['demo'])
  assert.equal((await (await fetch(`${base}/sessions/${saved.id}`)).json()).name, 'demo')
  await post('/sessions', { id: saved.id, name: 'renamed' })
  assert.equal((await (await fetch(`${base}/sessions`)).json())[0].name, 'renamed', 'saving with an id overwrites')
  await fetch(`${base}/sessions/${saved.id}`, { method: 'DELETE' })
  assert.equal((await fetch(`${base}/sessions/${saved.id}`)).status, 404)
})

test('CORS preflight is answered for the packaged app', async () => {
  const response = await fetch(`${base}/analyze`, { method: 'OPTIONS' })
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
})

test('projects open from a local folder path', async () => {
  const dir = new URL('../../analysis/test/fixtures/pointers/', import.meta.url).pathname
  const opened = await (await post('/open', { path: dir })).json()
  assert.deepEqual(opened.files.map(f => f.path), ['list.c', 'list.h', 'main.c'])
  const result = await (await post('/analyze', { files: opened.files })).json()
  assert.deepEqual(result.units.map(u => u.file).sort(), ['list.c', 'main.c'])
  assert.equal((await post('/open', { path: 'relative/dir' })).status, 400)
  assert.match((await (await post('/open', { path: '/definitely/not/here' })).json()).error, /No such directory/)
})
