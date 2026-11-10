import type { FastifyInstance } from 'fastify'
import { ProjectStore } from '../projects.ts'

export async function projectRoutes(app: FastifyInstance, options: { store: ProjectStore }) {
  app.get('/project', () => options.store.get())
  app.post('/project', { bodyLimit: 16 * 1024 * 1024 }, request => options.store.replace(request.body))
  app.get<{ Params: { id: string }; Querystring: { path: string } }>('/project/:id/file', {
    schema: { querystring: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
  }, request => options.store.read(request.params.id, request.query.path))
}
