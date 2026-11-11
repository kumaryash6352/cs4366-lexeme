import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let control
function interruption() {
  if (control && existsSync(control.cancelPath)) return 'Job cancelled'
  if (control && Date.now() >= control.deadline) return 'Job timed out'
  return ''
}

function execute(program, args, cwd) {
  return new Promise((resolve, reject) => {
    const before = interruption()
    if (before) { reject(new Error(before)); return }
    const child = spawn(program, args, { shell: false, detached: true, ...(cwd ? { cwd } : {}), stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let diagnostics = ''
    let interrupted = ''
    let killTimer
    const killGroup = signal => {
      if (!child.pid) return
      try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') child.kill(signal) }
    }
    const monitor = setInterval(() => {
      const reason = interruption()
      if (reason && !interrupted) {
        interrupted = reason
        killGroup('SIGTERM')
        killTimer = setTimeout(() => killGroup('SIGKILL'), 250)
      }
    }, 25)
    const cleanup = () => { clearInterval(monitor); if (killTimer) clearTimeout(killTimer) }
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-32768) })
    child.stderr.on('data', chunk => {
      diagnostics = (diagnostics + chunk.toString()).slice(-32768)
      process.stderr.write(chunk)
    })
    child.on('error', error => { cleanup(); reject(error) })
    child.on('close', code => {
      cleanup()
      if (interrupted) reject(new Error(interrupted))
      else resolve({ code: code ?? 1, output, diagnostics })
    })
  })
}

/** The analyzer is copied next to the worker in the image (/app/analyzer); in a
 * checkout it is analysis/dist/analyzer. */
async function loadAnalyzer() {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [process.env.LEXEME_ANALYZER, join(here, '../analyzer/index.js'), join(here, '../dist/analyzer/index.js')].filter(Boolean)
  const path = candidates.find(c => existsSync(c))
  if (!path) throw new Error('Analyzer module not found in the worker image')
  return import(path)
}

const SOURCE_FILE = /\.(c|h)$|(^|\/)compile_commands\.json$/
async function projectFiles(root, dir = root, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await projectFiles(root, path, out)
    else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !entry.name.startsWith('.lexeme-unit-')) {
      out.push({ path: relative(root, path).split(sep).join('/'), text: await readFile(path, 'utf8') })
    }
  }
  return out
}

if (process.argv.includes('--serve')) {
  // Keep the application container alive. Each request uses a separate exec process, while the container and its toolchain persist for the session.
  const heartbeat = setInterval(() => {}, 60_000)
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => clearInterval(heartbeat))
  console.log(JSON.stringify({ type: 'ready', schemaVersion: 1 }))
} else if (process.argv.includes('--self-check')) {
  const gcc = await execute('gcc', ['--version'])
  if (gcc.code !== 0) throw new Error('GCC is unavailable')
  const analyzer = await loadAnalyzer()
  console.log(JSON.stringify({ schemaVersion: 1, node: process.version, gcc: gcc.output.split('\n')[0], analyzer: typeof analyzer.analyzeProject === 'function' }))
} else {
  const jobIndex = process.argv.indexOf('--job')
  const id = jobIndex >= 0 ? process.argv[jobIndex + 1] : undefined
  if (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Supply --job with a job UUID')
  const timeoutIndex = process.argv.indexOf('--timeout-ms')
  const timeoutMs = timeoutIndex >= 0 ? Number(process.argv[timeoutIndex + 1]) : 60_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('Invalid job timeout')
  const jobDir = join(process.env.LEXEME_WORKER_JOBS ?? '/jobs', id)
  const input = join(jobDir, 'input')
  const output = join(jobDir, 'output')
  control = { cancelPath: join(jobDir, 'cancel'), deadline: Date.now() + timeoutMs }
  const sourceRoot = resolve(input, 'source')
  let jobId = 'unknown'
  let stage = 'validating'
  const progress = value => { stage = value; console.log(JSON.stringify({ type: 'progress', stage })) }
  const projectPath = value => {
    if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.includes(':') || value.startsWith('/') || value.split('/').includes('..')) {
      throw new Error('Invalid project-relative path')
    }
    const path = resolve(sourceRoot, value)
    if (path !== sourceRoot && !path.startsWith(sourceRoot + sep)) throw new Error('Path escapes source directory')
    return path
  }
  await mkdir(output, { recursive: true })
  let result
  try {
    progress('validating')
    const request = JSON.parse(await readFile(join(input, 'request.json'), 'utf8'))
    if (request.schemaVersion !== 1 || request.jobId !== id) throw new Error('Unsupported request protocol')
    jobId = request.jobId
    if (request.operation === 'analyze') {
      if (!Array.isArray(request.units) || request.units.length === 0) throw new Error('No units to analyze')
      const units = request.units.map(unit => {
        projectPath(unit.file)
        for (const dir of unit.includeDirs ?? []) projectPath(dir === '.' ? '.' : dir)
        for (const define of unit.defines ?? []) if (typeof define !== 'string' || !/^[A-Za-z_]\w*(=[^\r\n\0]*)?$/.test(define)) throw new Error('Invalid macro definition')
        if (!/^(c|gnu)(89|90|99|11|17|18|23|2x)$/.test(unit.std ?? 'c11')) throw new Error('Invalid C standard')
        return { file: unit.file, includeDirs: unit.includeDirs ?? [], defines: unit.defines ?? [], std: unit.std ?? 'c11' }
      })
      progress('loading-analyzer')
      const analyzer = await loadAnalyzer()
      const files = await projectFiles(sourceRoot)
      progress('analyzing')
      const analysis = await analyzer.analyzeProject({
        files, units, runtime: 'container',
        compiler: {
          run: async args => { const r = await execute('gcc', args, sourceRoot); return { code: r.code, stderr: r.diagnostics } },
          read: path => readFile(projectPath(path), 'utf8'),
        },
      })
      await writeFile(join(output, 'analysis.json'), JSON.stringify(analysis))
      result = { schemaVersion: 1, jobId, status: 'succeeded', artifacts: [{ kind: 'analysis', path: 'analysis.json' }], diagnostics: [] }
    } else {
      if (request.operation !== 'preprocess' || request.languageStandard !== 'c11') throw new Error('Unsupported request protocol')
      const entry = projectPath(request.entryFile)
      if (!entry.endsWith('.c')) throw new Error('Entry file must be C source')
      if (!Array.isArray(request.includeDirs) || request.includeDirs.length > 32 || !Array.isArray(request.defines) || request.defines.length > 32) {
        throw new Error('Invalid compiler settings')
      }
      const flags = ['-std=c11', ...request.includeDirs.flatMap(dir => ['-I', projectPath(dir)])]
      for (const define of request.defines) {
        if (typeof define !== 'string' || define.length > 256 || !/^[A-Za-z_]\w*(=[^\r\n\0]*)?$/.test(define)) throw new Error('Invalid macro definition')
        flags.push(`-D${define}`)
      }
      progress('checking-syntax')
      const checked = await execute('gcc', [...flags, '-fsyntax-only', entry])
      if (checked.code !== 0) throw new Error(checked.diagnostics || 'GCC syntax check failed')
      progress('preprocessing')
      const preprocessed = await execute('gcc', [...flags, '-E', entry, '-o', join(output, 'main.i')])
      if (preprocessed.code !== 0) throw new Error(preprocessed.diagnostics || 'GCC preprocessing failed')
      result = {
        schemaVersion: 1, jobId, status: 'succeeded',
        artifacts: [{ kind: 'preprocessed-source', path: 'main.i' }],
        diagnostics: [checked.diagnostics, preprocessed.diagnostics].filter(Boolean).map(message => ({ stage: 'compiler-warning', message })),
      }
    }
  } catch (error) {
    result = { schemaVersion: 1, jobId, status: 'failed', artifacts: [], diagnostics: [{ stage, message: String(error.message ?? error) }] }
    process.exitCode = 1
  }
  await writeFile(join(output, 'result.json.tmp'), JSON.stringify(result, null, 2))
  await rename(join(output, 'result.json.tmp'), join(output, 'result.json'))
}
