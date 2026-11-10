import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { analyzeUnit, assembleGraphs } from './graphs/model.mjs'
import { fileURLToPath } from 'node:url'

let control
let errorTailBytes = 4096
let artifactBytes = 32 * 1024 * 1024
function interruption() {
  if (control && existsSync(control.cancelPath)) return 'Job cancelled'
  if (control && Date.now() >= control.deadline) return 'Job timed out'
  return ''
}

async function execute(program, args, cwd, capture = {}) {
  const handles = []
  const file = path => { if (!path) return 'pipe'; const fd = openSync(path, 'w+'); handles.push(fd); return fd }
  const tail = fd => {
    const size = fstatSync(fd).size
    const buffer = Buffer.alloc(Math.min(size, errorTailBytes))
    readSync(fd, buffer, 0, buffer.length, size - buffer.length)
    return buffer.toString('utf8')
  }
  try {
    const stdout = file(capture.stdoutFile), stderr = file(capture.stderrFile)
    return await new Promise((resolve, reject) => {
      const before = interruption()
      if (before) { reject(new Error(before)); return }
      const child = spawn(program, args, { cwd, shell: false, detached: true, stdio: ['ignore', stdout, stderr] })
      let output = Buffer.alloc(0)
      let diagnostics = Buffer.alloc(0)
      let interrupted = ''
      let killTimer
      const killGroup = signal => {
        if (!child.pid) return
        try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') child.kill(signal) }
      }
      const monitor = setInterval(() => {
        const reason = interruption() || (handles.some(fd => fstatSync(fd).size > artifactBytes) ? 'Analysis artifact byte limit exceeded' : '')
        if (reason && !interrupted) {
          interrupted = reason
          killGroup('SIGTERM')
          killTimer = setTimeout(() => killGroup('SIGKILL'), 250)
        }
      }, 25)
      const cleanup = () => { clearInterval(monitor); if (killTimer) clearTimeout(killTimer) }
      child.stdout?.on('data', chunk => { output = Buffer.from(Buffer.concat([output, chunk]).subarray(-errorTailBytes)) })
      child.stderr?.on('data', chunk => {
        diagnostics = Buffer.from(Buffer.concat([diagnostics, chunk]).subarray(-errorTailBytes))
      })
      child.stdout?.pipe(process.stderr, { end: false })
      child.stderr?.pipe(process.stderr, { end: false })
      let spawnFailed = false
      child.on('error', error => { spawnFailed = true; cleanup(); reject(error) })
      child.on('close', code => {
        cleanup()
        if (spawnFailed) return
        if (interrupted) reject(new Error(interrupted))
        else resolve({ code: code ?? 1, output: typeof stdout === 'number' ? tail(stdout) : output.toString('utf8'), diagnostics: typeof stderr === 'number' ? tail(stderr) : diagnostics.toString('utf8') })
      })
    })
  } finally { for (const fd of handles) closeSync(fd) }
}

async function toolVersions() {
  const versions = {}
  for (const program of ['gcc', 'cmake', 'python3', 'nm']) {
    const result = await execute(program, ['--version'])
    if (result.code !== 0) throw new Error(`${program} is unavailable`)
    versions[program] = result.output.split('\n')[0]
  }
  for (const packageName of ['tree-sitter', 'tree-sitter-c']) {
    const manifest = JSON.parse(await readFile(fileURLToPath(new URL(`../node_modules/${packageName}/package.json`, import.meta.url)), 'utf8'))
    versions[packageName] = manifest.version
  }
  return versions
}

if (process.argv.includes('--serve')) {
  // Keep this job's container alive for dependency installation and worker exec.
  // AnalysisService removes the container when the job finishes.
  const heartbeat = setInterval(() => {}, 60_000)
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => clearInterval(heartbeat))
  console.log(JSON.stringify({ type: 'ready', schemaVersion: 1 }))
} else if (process.argv.includes('--self-check')) {
  console.log(JSON.stringify({ schemaVersion: 1, graphProtocol: 1, node: process.version, tools: await toolVersions() }))
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
    if (request.schemaVersion !== 1 || request.jobId !== id || request.operation !== 'analyze' || request.languageStandard !== 'c11') {
      throw new Error('Unsupported request protocol')
    }
    jobId = request.jobId
    if (!Number.isSafeInteger(request.errorTailBytes) || request.errorTailBytes < 1) throw new Error('Invalid diagnostic limit')
    errorTailBytes = request.errorTailBytes
    if (!Number.isSafeInteger(request.artifactBytes) || request.artifactBytes < 1) throw new Error('Invalid artifact limit')
    artifactBytes = request.artifactBytes
    let commands
    if (request.entryFile === undefined) {
      progress('configuring-cmake')
      const build = join(jobDir, 'work', 'build')
      const configured = await execute('cmake', [
        '-S', sourceRoot, '-B', build, '-G', 'Unix Makefiles',
        '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON', '-DCMAKE_UNITY_BUILD=OFF',
      ])
      if (configured.code !== 0) throw new Error(configured.diagnostics || configured.output || 'CMake configuration failed')
      const commandsPath = join(jobDir, 'work', 'commands.json')
      const converted = await execute('python3', [
        fileURLToPath(new URL('./compile_commands.py', import.meta.url)),
        join(build, 'compile_commands.json'), commandsPath,
      ])
      if (converted.code !== 0) throw new Error(converted.diagnostics || 'Cannot read CMake compilation commands')
      commands = JSON.parse(await readFile(commandsPath, 'utf8'))
      if (commands.length === 0) throw new Error('CMake project has no C translation units')
    } else {
      const entry = projectPath(request.entryFile)
      if (!entry.endsWith('.c')) throw new Error('Entry file must be C source')
      if (!Array.isArray(request.includeDirs) || !Array.isArray(request.defines)) throw new Error('Invalid compiler settings')
      const flags = ['-std=c11', ...request.includeDirs.flatMap(dir => ['-I', projectPath(dir)])]
      for (const define of request.defines) {
        if (typeof define !== 'string' || define.length > 256 || !/^[A-Za-z_]\w*(=[^\r\n\0]*)?$/.test(define)) throw new Error('Invalid macro definition')
        flags.push(`-D${define}`)
      }
      commands = [{ args: ['gcc', ...flags, entry], directory: sourceRoot, file: entry }]
    }
    const tools = await toolVersions()
    const units = []
    for (const [index, command] of commands.entries()) {
      const unit = await analyzeUnit(command, index, {
        sourceRoot, workRoot: join(jobDir, 'work'), output,
        single: request.entryFile !== undefined, maxBytes: artifactBytes,
      }, execute, progress)
      if (!units.some(previous => previous.unit.id === unit.unit.id)) units.push(unit)
    }
    progress('writing-graphs')
    const graphs = JSON.stringify(assembleGraphs(units, tools), null, 2)
    if (Buffer.byteLength(graphs) > artifactBytes) throw new Error('Graph JSON exceeds configured artifact byte limit')
    await writeFile(join(output, 'graphs.json.tmp'), graphs)
    await rename(join(output, 'graphs.json.tmp'), join(output, 'graphs.json'))
    const artifacts = [{ kind: 'graphs', path: 'graphs.json' }, ...units.map(unit => unit.artifact)]
    const diagnostics = units.flatMap(unit => unit.diagnostics)
    result = {
      schemaVersion: 1, jobId, status: 'succeeded',
      artifacts, diagnostics,
    }
  } catch (error) {
    result = { schemaVersion: 1, jobId, status: 'failed', artifacts: [], diagnostics: [{ stage, message: String(error.message ?? error) }] }
    process.exitCode = 1
  }
  await writeFile(join(output, 'result.json.tmp'), JSON.stringify(result, null, 2))
  await rename(join(output, 'result.json.tmp'), join(output, 'result.json'))
}
