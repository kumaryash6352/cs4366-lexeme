import type { FastifyPluginAsync } from 'fastify'
import { runPipeline } from '../../analysis/dist/index.js'
import type { PipelineOptions, PipelineRequest } from '../../analysis/dist/index.js'
import { sampleCode } from '../sample.ts'

const analysisRoutes: FastifyPluginAsync<{ pipeline: () => Promise<PipelineOptions> }> = async (fastify, { pipeline }) => {
  fastify.get('/sample', async () => ({ units: [], files: [{ path: 'main.c', text: sampleCode }] }))

  fastify.post<{ Body: PipelineRequest }>('/analyze', {
    schema: {
      body: {
        type: 'object',
        required: ['files'],
        properties: {
          units: { type: 'array', items: { type: 'string' } },
          entryFile: { type: 'string' },
          files: { type: 'array', items: { type: 'object', required: ['path', 'text'], properties: { path: { type: 'string' }, text: { type: 'string' } } } },
          includeDirs: { type: 'array', items: { type: 'string' } },
          defines: { type: 'array', items: { type: 'string' } },
          std: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      return await runPipeline(request.body, await pipeline())
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}

export default analysisRoutes
