import { homedir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { AnalysisService } from '../analysis/dist/index.js'
import type { PipelineOptions, Preprocessor } from '../analysis/dist/index.js'
import analysisRoutes from './routes/analyze.ts'
import projectRoutes from './routes/project.ts'
import sessionRoutes from './routes/sessions.ts'

const port = Number(process.env.LEXEME_PORT ?? 3000)
const preprocessor = (process.env.LEXEME_PREPROCESSOR ?? 'auto') as Preprocessor
const dataDir = process.env.LEXEME_DATA_DIR ?? join(homedir(), '.lexeme')
const fastify = Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024, forceCloseConnections: true })

// The packaged Electron app loads from file://, so allow cross-origin calls to this local-only server.
fastify.addHook('onRequest', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*')
  if (request.method === 'OPTIONS') {
    reply.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    reply.header('Access-Control-Allow-Headers', 'Content-Type')
    return reply.code(204).send()
  }
})

// Container mode starts one Podman session lazily and keeps it for the server lifetime.
let service: AnalysisService | undefined
const pipeline = async (): Promise<PipelineOptions> => {
  if (preprocessor !== 'container') return { preprocessor, ...(process.env.LEXEME_CC ? { compiler: process.env.LEXEME_CC } : {}) }
  if (!service) {
    service = new AnalysisService()
    await service.start((stage, message) => fastify.log.info({ stage }, message))
  }
  return { preprocessor, service }
}

fastify.get('/api/health', async () => ({ ok: true, preprocessor }))
await fastify.register(analysisRoutes, { prefix: '/api', pipeline })
await fastify.register(projectRoutes, { prefix: '/api' })
await fastify.register(sessionRoutes, { prefix: '/api', dir: join(dataDir, 'sessions') })
fastify.addHook('onClose', async () => { await service?.shutdown() })
// Exit promptly on SIGINT/SIGTERM: keep-alive connections from the window can otherwise
// hold fastify.close() open, leaving an orphaned server on the port.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    setTimeout(() => process.exit(0), 1000).unref()
    void fastify.close().then(() => process.exit(0))
  })
}

try {
  await fastify.listen({ host: '127.0.0.1', port })
} catch (error) {
  fastify.log.error(error)
  process.exit(1)
}
