// Starts the backend (unless one is already running), then Electron.
// `node scripts/dev.mjs` also starts Vite with live reload; `--built` opens dist/ instead.
import { spawn } from 'node:child_process'
import electron from 'electron'

const built = process.argv.includes('--built')
const port = process.env.LEXEME_PORT ?? '3000'
const children = []
// Never leave a spawned backend behind, whatever ends this script.
const killChildren = () => { for (const c of children) if (c.exitCode === null) c.kill('SIGTERM') }
process.on('exit', killChildren)

async function backendRunning() {
  try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok } catch { return false }
}

if (!(await backendRunning())) {
  const backend = spawn(process.execPath, ['backend/app.ts'], { stdio: 'inherit', env: { ...process.env, LEXEME_PORT: port } })
  children.push(backend)
  for (let i = 0; i < 50 && !(await backendRunning()); i++) await new Promise(resolve => setTimeout(resolve, 100))
}

let server
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
if (!built) {
  const { createServer } = await import('vite')
  server = await createServer({ server: { host: '127.0.0.1', port: 5173, strictPort: true } })
  try {
    await server.listen()
  } catch (error) {
    console.error(`${error.message} (is another \`npm run dev\` still running?)`)
    killChildren()
    await server.close()
    process.exit(1)
  }
  server.printUrls()
  env.LEXEME_DEV_URL = 'http://127.0.0.1:5173'
}

const child = spawn(electron, ['.'], { stdio: 'inherit', env })
const stop = async code => {
  killChildren()
  await server?.close()
  process.exitCode = code
}
child.on('error', error => { console.error(error); void stop(1) })
child.on('exit', code => { void stop(code ?? 0) })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
