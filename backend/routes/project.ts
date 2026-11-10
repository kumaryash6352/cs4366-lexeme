import type { FastifyInstance } from 'fastify'
import { ProjectStore } from '../projects.ts'
import type { AnalysisRunner } from '../analysis.ts'

export async function projectRoutes(app: FastifyInstance, options: { store: ProjectStore; analysis: AnalysisRunner }) {
  app.get('/project', () => options.store.get())
  app.post('/project', { bodyLimit: 16 * 1024 * 1024 }, async request => {
    const project = await options.store.replace(request.body)
    const directory = options.store.activeDirectory
    if (!directory) throw new Error('The active project was not staged for analysis.')
    const hasCMake = project.files.some(file => file.path === 'CMakeLists.txt')
    const entryFile = hasCMake ? undefined :
      (project.files.find(file => /(^|\/)main\.c$/i.test(file.path)) ??
        project.files.find(file => /\.c$/i.test(file.path)))?.path
    if (!hasCMake && !entryFile) throw new Error('Analysis requires a root CMakeLists.txt or at least one C source file.')
    const analysis = await options.analysis.analyze(directory, entryFile)
    return { project, analysis }
  })
  app.get<{ Params: { id: string }; Querystring: { path: string } }>('/project/:id/file', {
    schema: { querystring: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
  }, request => options.store.read(request.params.id, request.query.path))
}
