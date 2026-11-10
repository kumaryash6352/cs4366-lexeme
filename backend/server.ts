import { createApplication } from './app.ts'

const app = createApplication({ logger: true, ...(process.env.LEXEME_FRONTEND_DIR ? { frontendDir: process.env.LEXEME_FRONTEND_DIR } : {}) })
await app.listen({ host: '127.0.0.1', port: 3000 })
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close() })
}
