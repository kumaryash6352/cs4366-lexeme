import { spawn } from 'node:child_process'
import { createServer } from 'vite'

for (const config of ['analysis/tsconfig.json', 'backend/tsconfig.json']) {
  const compile = spawn(process.execPath, ['node_modules/typescript/bin/tsc', '-p', config], { stdio: 'inherit' })
  const compileCode = await new Promise(resolve => compile.once('exit', resolve))
  if (compileCode !== 0) process.exit(compileCode ?? 1)
}

const backend = spawn(process.execPath, ['dist-backend/backend/server.js'], { stdio: 'inherit' })
const frontend = await createServer({ server: { host: '127.0.0.1', port: 5173, strictPort: true } })
await frontend.listen()
frontend.printUrls()

let closing = false
async function close(code = 0) {
  if (closing) return
  closing = true
  backend.kill('SIGTERM')
  await frontend.close()
  process.exitCode = code
}
backend.on('error', error => { console.error(error); void close(1) })
backend.on('exit', code => { if (!closing) void close(code ?? 1) })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close() })
