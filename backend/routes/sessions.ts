import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyPluginAsync } from 'fastify'

interface Session { id: string; name: string; savedAt: string; [key: string]: unknown }
const ID = /^[0-9a-f-]{36}$/

/** Saved workspaces (source, settings, and graphs) as JSON files on the server. */
const sessionRoutes: FastifyPluginAsync<{ dir: string }> = async (fastify, { dir }) => {
  await mkdir(dir, { recursive: true })
  const path = (id: string) => join(dir, `${id}.json`)

  fastify.get('/sessions', async () => {
    const out: Pick<Session, 'id' | 'name' | 'savedAt'>[] = []
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const { id, name: title, savedAt } = JSON.parse(await readFile(join(dir, name), 'utf8')) as Session
        out.push({ id, name: title, savedAt })
      } catch { /* skip unreadable files */ }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  })

  fastify.get<{ Params: { id: string } }>('/sessions/:id', async (request, reply) => {
    if (!ID.test(request.params.id)) return reply.code(404).send({ error: 'Unknown session' })
    try { return JSON.parse(await readFile(path(request.params.id), 'utf8')) }
    catch { return reply.code(404).send({ error: 'Unknown session' }) }
  })

  fastify.post<{ Body: Record<string, unknown> }>('/sessions', async request => {
    const requested = typeof request.body.id === 'string' && ID.test(request.body.id) ? request.body.id : undefined
    const session: Session = {
      ...request.body,
      id: requested ?? randomUUID(),
      name: typeof request.body.name === 'string' && request.body.name.trim() ? request.body.name.trim() : 'Untitled',
      savedAt: new Date().toISOString(),
    }
    await writeFile(path(session.id), JSON.stringify(session))
    return { id: session.id, name: session.name, savedAt: session.savedAt }
  })

  fastify.delete<{ Params: { id: string } }>('/sessions/:id', async (request, reply) => {
    if (!ID.test(request.params.id)) return reply.code(404).send({ error: 'Unknown session' })
    await rm(path(request.params.id), { force: true })
    return { ok: true }
  })
}

export default sessionRoutes
