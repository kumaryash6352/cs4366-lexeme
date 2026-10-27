// Require the framework and instantiate it

// ESM
import Fastify from 'fastify'
import analysisRoutes from './routes/analyze.ts'
import loaderRoutes from './routes/loader.ts'

const fastify = Fastify({
  logger: true
})

// Declare a route
fastify.get('/', function (request, reply) {
  reply.send({ hello: 'world' })
})

// example:
// fastify.register(userRoutes, { prefix: '/v1/users' }) 

fastify.register(analysisRoutes, {prefix: '/api'})
fastify.register(loaderRoutes, {prefix: '/api'})

// Run the server!
fastify.listen({ port: 3000 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  // Server is now listening on ${address}
})
