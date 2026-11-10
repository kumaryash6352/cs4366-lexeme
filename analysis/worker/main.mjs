import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { analyzeUnit, assembleGraphs, readArtifact, uniqueCommands } from './graphs/model.mjs'
import { fileURLToPath } from 'node:url'
import { workerConfig } from './config.mjs'

// Per-process job state; request limits replace the defaults after validation.
let control
let errorTailBytes = workerConfig.errorTailBytes
let artifactBytes = workerConfig.artifactBytes
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
  const outputLimitError = () => {
    try {
      if (handles.some(fd => fstatSync(fd).size > artifactBytes)) return 'Analysis artifact byte limit exceeded'
      const paths = [...(capture.watchFiles ?? [])]
      for (const directory of capture.watchDirectories ?? []) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.isFile()) paths.push(join(directory, entry.name))
        }
      }
      for (const path of paths) {
        try {
          if (statSync(path).size > artifactBytes) return `Analysis artifact byte limit exceeded: ${path}`
        } catch (error) {
          // Compiler outputs may not exist yet, or may be replaced between checks.
          if (error.code !== 'ENOENT') throw error
        }
      }
      return ''
    } catch (error) { return `Cannot monitor analysis artifacts: ${error.message}` }
  }
  try {
    const stdout = file(capture.stdoutFile), stderr = file(capture.stderrFile)
    return await new Promise((resolve, reject) => {
      const before = interruption() || outputLimitError()
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
        const reason = interruption() || outputLimitError()
        if (reason && !interrupted) {
          interrupted = reason
          killGroup('SIGTERM')
          killTimer = setTimeout(() => killGroup('SIGKILL'), workerConfig.killGraceMs)
        }
      }, workerConfig.monitorIntervalMs)
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
        // Also catch commands that finish between monitor ticks.
        const reason = interrupted || interruption() || outputLimitError()
        if (reason) { reject(new Error(reason)); return }
        try {
          resolve({ code: code ?? 1, output: typeof stdout === 'number' ? tail(stdout) : output.toString('utf8'), diagnostics: typeof stderr === 'number' ? tail(stderr) : diagnostics.toString('utf8') })
        } catch (error) { reject(error) }
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

function readJobArguments(args) {
  const jobIndex = args.indexOf('--job')
  const id = jobIndex >= 0 ? args[jobIndex + 1] : undefined
  if (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Supply --job with a job UUID')
  const timeoutIndex = args.indexOf('--timeout-ms')
  const timeoutMs = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : workerConfig.analysisTimeoutMs
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('Invalid job timeout')
  const directory = join(process.env.LEXEME_WORKER_JOBS ?? workerConfig.jobsRoot, id)
  return { id, timeoutMs, directory, sourceRoot: resolve(directory, 'input', 'source'),
    workRoot: join(directory, 'work'), output: join(directory, 'output') }
}

function projectPath(value, sourceRoot) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.includes(':') || value.startsWith('/') || value.split('/').includes('..')) {
    throw new Error('Invalid project-relative path')
  }
  const path = resolve(sourceRoot, value)
  if (path !== sourceRoot && !path.startsWith(sourceRoot + sep)) throw new Error('Path escapes source directory')
  return path
}

async function readRequest(job) {
  const request = JSON.parse(await readFile(join(job.directory, 'input', 'request.json'), 'utf8'))
  if (request.schemaVersion !== 1 || request.jobId !== job.id || request.operation !== 'analyze' || request.languageStandard !== 'c11') {
    throw new Error('Unsupported request protocol')
  }
  if (!Number.isSafeInteger(request.errorTailBytes) || request.errorTailBytes < 1) throw new Error('Invalid diagnostic limit')
  if (!Number.isSafeInteger(request.artifactBytes) || request.artifactBytes < 1) throw new Error('Invalid artifact limit')
  return request
}

async function resolveCommands(request, job, progress) {
  if (request.entryFile !== undefined) {
    const entry = projectPath(request.entryFile, job.sourceRoot)
    if (!entry.endsWith('.c')) throw new Error('Entry file must be C source')
    if (!Array.isArray(request.includeDirs) || !Array.isArray(request.defines)) throw new Error('Invalid compiler settings')
    const flags = ['-std=c11', ...request.includeDirs.flatMap(dir => ['-I', projectPath(dir, job.sourceRoot)])]
    for (const define of request.defines) {
      if (typeof define !== 'string' || define.length > 256 || !/^[A-Za-z_]\w*(=[^\r\n\0]*)?$/.test(define)) throw new Error('Invalid macro definition')
      flags.push(`-D${define}`)
    }
    return [{ args: ['gcc', ...flags, entry], directory: job.sourceRoot, file: entry }]
  }

  progress('configuring-cmake')
  const build = join(job.workRoot, 'build')
  const databasePath = join(build, 'compile_commands.json')
  const configured = await execute('cmake', [
    '-S', job.sourceRoot, '-B', build, '-G', 'Unix Makefiles',
    '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON', '-DCMAKE_UNITY_BUILD=OFF',
  ], undefined, { watchFiles: [databasePath] })
  if (configured.code !== 0) throw new Error(configured.diagnostics || configured.output || 'CMake configuration failed')
  const commandsPath = join(job.workRoot, 'commands.json')
  const converted = await execute('python3', [
    fileURLToPath(new URL('./compile_commands.py', import.meta.url)), databasePath, commandsPath,
  ], undefined, { watchFiles: [commandsPath] })
  if (converted.code !== 0) throw new Error(converted.diagnostics || 'Cannot read CMake compilation commands')
  const commands = JSON.parse(await readArtifact(commandsPath, artifactBytes))
  if (commands.length === 0) throw new Error('CMake project has no C translation units')
  return commands
}

async function analyzeCommands(commands, request, job, progress) {
  const units = []
  // Normalize and deduplicate before creating unit directories or running GCC.
  for (const [index, command] of uniqueCommands(commands).entries()) {
    units.push(await analyzeUnit(command, index, {
      sourceRoot: job.sourceRoot, workRoot: job.workRoot, output: job.output,
      single: request.entryFile !== undefined, maxBytes: artifactBytes,
    }, execute, progress))
  }
  return units
}

async function writeJson(output, filename, value, maxBytes = Infinity) {
  const json = JSON.stringify(value, null, 2)
  if (Buffer.byteLength(json) > maxBytes) throw new Error(`${filename} exceeds configured artifact byte limit`)
  await writeFile(join(output, filename + '.tmp'), json)
  await rename(join(output, filename + '.tmp'), join(output, filename))
}

async function runJob(job) {
  control = { cancelPath: join(job.directory, 'cancel'), deadline: Date.now() + job.timeoutMs }
  let stage = 'validating'
  const progress = value => { stage = value; console.log(JSON.stringify({ type: 'progress', stage })) }
  await mkdir(job.output, { recursive: true })
  let result
  try {
    progress('validating')
    const request = await readRequest(job)
    errorTailBytes = request.errorTailBytes
    artifactBytes = request.artifactBytes
    const commands = await resolveCommands(request, job, progress)
    const tools = await toolVersions()
    const units = await analyzeCommands(commands, request, job, progress)
    progress('writing-graphs')
    await writeJson(job.output, 'graphs.json', assembleGraphs(units, tools), artifactBytes)
    result = {
      schemaVersion: 1, jobId: job.id, status: 'succeeded',
      artifacts: [{ kind: 'graphs', path: 'graphs.json' }, ...units.map(unit => unit.artifact)],
      diagnostics: units.flatMap(unit => unit.diagnostics),
    }
  } catch (error) {
    result = { schemaVersion: 1, jobId: job.id, status: 'failed', artifacts: [], diagnostics: [{ stage, message: String(error.message ?? error) }] }
    process.exitCode = 1
  }
  await writeJson(job.output, 'result.json', result)
}

if (process.argv.includes('--serve')) {
  // Keep this job's container alive for dependency installation and worker exec.
  // AnalysisService removes the container when the job finishes.
  const heartbeat = setInterval(() => {}, workerConfig.heartbeatIntervalMs)
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => clearInterval(heartbeat))
  console.log(JSON.stringify({ type: 'ready', schemaVersion: 1 }))
} else if (process.argv.includes('--self-check')) {
  console.log(JSON.stringify({ schemaVersion: 1, graphProtocol: 1, node: process.version, tools: await toolVersions() }))
} else {
  await runJob(readJobArguments(process.argv.slice(2)))
}
