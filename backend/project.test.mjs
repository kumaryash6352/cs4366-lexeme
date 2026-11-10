import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { test } from 'node:test'
import { createApplication } from '../dist-backend/backend/app.js'
import { ProjectStore } from '../dist-backend/backend/projects.js'

const encoded = text => Buffer.from(text).toString('base64')
const upload = (name, path, content) => ({ name, files: [{ path, content: encoded(content) }] })

test('a successful project upload replaces the active workspace atomically', async t => {
  const store = new ProjectStore()
  const app = createApplication({ store })
  t.after(() => app.close())

  const firstResponse = await app.inject({ method: 'POST', url: '/api/project', payload: upload('first', 'src/main.c', 'int first;') })
  assert.equal(firstResponse.statusCode, 200)
  const first = firstResponse.json()
  const firstDirectory = store.activeDirectory
  assert.ok(firstDirectory)

  const secondResponse = await app.inject({ method: 'POST', url: '/api/project', payload: upload('second', 'second.c', 'int second;') })
  assert.equal(secondResponse.statusCode, 200)
  const second = secondResponse.json()
  assert.notEqual(first.id, second.id)
  await assert.rejects(stat(firstDirectory))

  const stale = await app.inject({ method: 'GET', url: `/api/project/${first.id}/file?path=src%2Fmain.c` })
  assert.equal(stale.statusCode, 404)
  const current = await app.inject({ method: 'GET', url: `/api/project/${second.id}/file?path=second.c` })
  assert.equal(current.statusCode, 200)
  assert.equal(current.json().content, 'int second;')

  const invalid = await app.inject({ method: 'POST', url: '/api/project', payload: upload('invalid', 'README.md', 'no C source') })
  assert.equal(invalid.statusCode, 400)
  const stillCurrent = await app.inject({ method: 'GET', url: '/api/project' })
  assert.equal(stillCurrent.json().id, second.id)
})
