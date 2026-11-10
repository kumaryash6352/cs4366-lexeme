import Fastify from 'fastify'
import { readFile, realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import loaderRoutes from './routes/loader.ts'
import { projectRoutes } from './routes/project.ts'
import { ProjectStore } from './projects.ts'
import { ContainerAnalysisRunner } from './analysis.ts'
import type { AnalysisRunner } from './analysis.ts'

export function createApplication(options: {
  logger?: boolean
  frontendDir?: string
  store?: ProjectStore
  analysis?: AnalysisRunner
} = {}) {
  const app = Fastify({ logger: options.logger ?? false })
  const store = options.store ?? new ProjectStore()
  const analysis = options.analysis ?? new ContainerAnalysisRunner()
  app.register(loaderRoutes, { prefix: '/api' })
  app.register(projectRoutes, { prefix: '/api', store, analysis })
  app.addHook('onReady', () => analysis.start())
  app.addHook('onClose', async () => { await Promise.all([store.close(), analysis.close()]) })
  if (options.frontendDir) {
    const root = resolve(options.frontendDir)
    const contentTypes: Record<string, string> = {
      '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
    }
    app.get<{ Params: { '*': string } }>('/*', async (request, reply) => {
      try {
        const path = await realpath(resolve(root, request.params['*'] || 'index.html'))
        const child = relative(root, path)
        if (child.startsWith('..') || isAbsolute(child)) return reply.code(404).send()
        return reply.type(contentTypes[extname(path)] ?? 'application/octet-stream').send(await readFile(path))
      } catch { return reply.code(404).send() }
    })
  } else app.get('/', () => ({ hello: 'world' }))
  return app
}
