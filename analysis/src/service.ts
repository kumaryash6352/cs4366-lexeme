import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { assertSuccess } from './command.js'
import { parseRequest, parseResult } from './contracts.js'
import type { AnalysisRequest, JobSnapshot } from './contracts.js'
import { analysisRoot } from './config.js'
import { PodmanRuntime } from './environment.js'
import { stageRequest } from './staging.js'
import { installPackages } from './packages.js'
import { DEFAULT_MEMORY, DEFAULT_PIDS_LIMIT, DEFAULT_TIMEOUT_MS, MAX_JOBS_PER_SESSION, MAX_RESULT_BYTES, MAX_TIMEOUT_MS, WORKER_LOG_CHARS } from './limits.js'

interface Job { snapshot: JobSnapshot; controller: AbortController; done: Promise<void>; finished: boolean }
export interface ServiceOptions {
  environment?: PodmanRuntime
  jobsRoot?: string
  /** Per-job compiler deadline in milliseconds (1 to 600000). */
  timeoutMs?: number
  /** Podman --memory value for the session container, e.g. '512m' or '2g'. */
  memory?: string
  /** Podman --pids-limit for the session container. */
  pidsLimit?: number
}

/** One application session owns one persistent container and a serial job queue. */
export class AnalysisService {
  readonly environment: PodmanRuntime
  readonly jobsRoot: string
  readonly containerName: string
  private jobs = new Map<string, Job>()
  private queue: Promise<void> = Promise.resolve()
  private startup: Promise<void> | undefined
  private shutdownPromise: Promise<void> | undefined
  private timeoutMs: number
  private memory: string
  private pidsLimit: number
  private closed = false
  /** True from `podman run` until `podman rm` succeeds. */
  private containerNeedsCleanup = false
  private runtimeFailure: string | undefined

  constructor(options: ServiceOptions = {}) {
    this.environment = options.environment ?? new PodmanRuntime()
    const sessionId = randomUUID()
    this.containerName = `lexeme-session-${sessionId}`
    this.jobsRoot = resolve(options.jobsRoot ?? join(analysisRoot, '.jobs'), sessionId)
    if (/[:,\n\r]/.test(this.jobsRoot)) throw new Error('jobsRoot cannot contain colon, comma, or newline characters')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`)
    }
    this.memory = options.memory ?? DEFAULT_MEMORY
    if (!/^\d+[bkmg]?$/i.test(this.memory)) throw new Error('memory must be a Podman size such as 512m or 2g')
    this.pidsLimit = options.pidsLimit ?? DEFAULT_PIDS_LIMIT
    if (!Number.isInteger(this.pidsLimit) || this.pidsLimit < 16) throw new Error('pidsLimit must be an integer of at least 16')
  }

  /** Call once at application startup, before accepting parsing requests. */
  start(notify: (stage: string, message: string) => void = () => {}): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Analysis service is shutting down'))
    this.startup ??= this.startContainer(notify)
    return this.startup
  }

  private async startContainer(notify: (stage: string, message: string) => void): Promise<void> {
    try {
      const image = await this.environment.ensureReady(notify)
      if (this.closed) throw new Error('Application shut down during analysis startup')
      await mkdir(this.jobsRoot, { recursive: true })
      this.containerNeedsCleanup = true
      notify('starting-container', this.containerName)
      assertSuccess(await this.environment.command('podman', [
        // ensureReady pulled the registry image. Default networking and capabilities
        // allow apt to download packages and set ownership inside this rootless container.
        'run', '--detach', '--name', this.containerName, '--pull=never',
        '--userns=keep-id', '--security-opt=no-new-privileges',
        `--memory=${this.memory}`, `--pids-limit=${this.pidsLimit}`, '--volume', `${this.jobsRoot}:/jobs:Z`, image, '--serve',
      ]), 'Persistent container startup')
      if (this.closed) throw new Error('Application shut down during analysis startup')
      notify('verifying-worker', 'Checking the worker in the persistent container')
      assertSuccess(await this.environment.command('podman', [
        'exec', this.containerName, 'node', '/app/worker/main.mjs', '--self-check',
      ]), 'Worker self-check')
      notify('ready', this.containerName)
    } catch (error) {
      if (this.containerNeedsCleanup) await this.removeContainer()
      throw error
    }
  }

  /** Accepts a backend request with source/projectDir and optional Debian dependencies. */
  submit(value: unknown): JobSnapshot {
    if (this.closed) throw new Error('Analysis service is shutting down')
    if (!this.startup) throw new Error('Call analysis.start() at application startup before submitting requests')
    if (this.runtimeFailure) throw new Error(this.runtimeFailure)
    const request = parseRequest(value)
    if (this.jobs.size >= MAX_JOBS_PER_SESSION) throw new Error(`Prototype session limit reached (${MAX_JOBS_PER_SESSION} jobs); start a new application session`)
    const id = randomUUID()
    const job: Job = { snapshot: { id, status: 'queued', events: [] }, controller: new AbortController(), done: Promise.resolve(), finished: false }
    this.jobs.set(id, job)
    job.done = this.queue.then(() => this.execute(job, request))
    this.queue = job.done.catch(() => {})
    return this.get(id)!
  }

  get(id: string): JobSnapshot | undefined {
    const job = this.jobs.get(id)
    if (!job) return undefined
    const snapshot = structuredClone(job.snapshot)
    if (!job.finished && ['succeeded', 'failed', 'cancelled', 'timed-out'].includes(snapshot.status)) snapshot.status = 'running'
    return snapshot
  }

  /** The job's output file: main.i for `parse`, analysis.json for `analyze`. */
  artifactPath(id: string): string | undefined {
    const job = this.get(id)
    const artifact = job?.status === 'succeeded' ? job.result?.artifacts[0] : undefined
    return artifact ? join(this.jobsRoot, id, 'output', artifact.path) : undefined
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job) return false
    if (['queued', 'preparing', 'running'].includes(job.snapshot.status)) {
      job.controller.abort()
      this.event(job, 'cancelling', 'Cancellation requested for this job')
    }
    return true
  }

  async wait(id: string): Promise<JobSnapshot> {
    const job = this.jobs.get(id)
    if (!job) throw new Error('Unknown job')
    await job.done
    return this.get(id)!
  }

  shutdown(): Promise<void> {
    this.closed = true
    this.shutdownPromise ??= this.finishShutdown()
    return this.shutdownPromise
  }

  private async finishShutdown(): Promise<void> {
    for (const id of this.jobs.keys()) this.cancel(id)
    await this.startup?.catch(() => {})
    await this.queue
    if (this.containerNeedsCleanup) await this.removeContainer()
  }

  private async removeContainer(): Promise<void> {
    assertSuccess(await this.environment.command('podman', ['rm', '--force', '--ignore', this.containerName]), 'Session container cleanup')
    this.containerNeedsCleanup = false
  }

  private event(job: Job, stage: string, message: string): void {
    job.snapshot.events.push({ at: new Date().toISOString(), stage, message: message.slice(-2000) })
    if (job.snapshot.events.length > 100) job.snapshot.events.shift()
  }

  private async execute(job: Job, request: AnalysisRequest): Promise<void> {
    const { signal } = job.controller
    const jobDir = join(this.jobsRoot, job.snapshot.id)
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let log = ''
    let cancellationWrite = Promise.resolve()
    const requestCancellation = () => {
      cancellationWrite = writeFile(join(jobDir, 'cancel'), 'cancel\n').catch(error => {
        this.event(job, 'cancel-error', String(error))
      })
    }
    try {
      signal.throwIfAborted()
      job.snapshot.status = 'preparing'
      await this.startup
      signal.throwIfAborted()
      if (this.runtimeFailure) throw new Error(this.runtimeFailure)
      this.event(job, 'staging', 'Writing the backend request into this job directory')
      await stageRequest(request, job.snapshot.id, jobDir, signal, dirname(this.jobsRoot))
      signal.throwIfAborted()
      if (request.dependencies.length > 0) {
        try {
          await installPackages(this.environment.command, this.containerName, request.dependencies, signal,
            (stage, message) => this.event(job, stage, message))
        } catch (error) {
          // A failed or interrupted apt transaction can leave dpkg locked or partially
          // configured. Retire the session before any queued compiler job can run.
          this.runtimeFailure = 'Dependency installation failed or was interrupted; restart the analysis service'
          await this.removeContainer()
          throw error
        }
      }
      signal.throwIfAborted()
      signal.addEventListener('abort', requestCancellation, { once: true })
      job.snapshot.status = 'running'
      timer = setTimeout(() => { timedOut = true; job.controller.abort() }, this.timeoutMs)
      let pending = ''
      let run
      try {
        run = await this.environment.command('podman', [
          'exec', this.containerName, 'node', '/app/worker/main.mjs',
          '--job', job.snapshot.id, '--timeout-ms', String(this.timeoutMs),
        ], {
          // The worker observes cancellation and kills its compiler process group.
          // Killing only the host exec client could leave the compiler running.
          timeoutMs: this.timeoutMs + 10_000,
          onStderr: text => { log = (log + text).slice(-WORKER_LOG_CHARS) },
          onStdout: text => {
            pending += text
            if (pending.length > WORKER_LOG_CHARS) { pending = ''; return }
            let end: number
            while ((end = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0, end)
              pending = pending.slice(end + 1)
              try {
                const event = JSON.parse(line)
                if (event.type === 'progress' && typeof event.stage === 'string') this.event(job, event.stage, event.stage)
              } catch { log = (log + line + '\n').slice(-WORKER_LOG_CHARS) }
            }
          },
        })
      } catch (error) {
        // Retire an unresponsive session so a surviving child cannot overlap the next job.
        this.runtimeFailure = 'Worker connection failed; restart the analysis service before submitting more requests'
        await this.removeContainer()
        throw error
      }
      signal.throwIfAborted()
      const resultPath = join(jobDir, 'output', 'result.json')
      if ((await stat(resultPath)).size > MAX_RESULT_BYTES) throw new Error('Worker result exceeds 1 MiB')
      const result = parseResult(JSON.parse(await readFile(resultPath, 'utf8')), job.snapshot.id)
      if (result.status === 'succeeded') {
        assertSuccess(run, 'Worker process')
        const artifact = result.artifacts[0]!.path
        if (!(await stat(join(jobDir, 'output', artifact))).isFile()) throw new Error(`Worker omitted ${artifact}`)
      } else if (run.code === 0) throw new Error('Worker reported failure but exited successfully')
      job.snapshot.result = result
      job.snapshot.status = result.status
    } catch (error) {
      job.snapshot.status = timedOut ? 'timed-out' : signal.aborted ? 'cancelled' : 'failed'
      job.snapshot.error = error instanceof Error ? error.message : String(error)
    } finally {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', requestCancellation)
      await cancellationWrite
      if (log) {
        try { await appendFile(join(jobDir, 'worker.log'), log) }
        catch (error) { this.event(job, 'log-error', String(error)) }
      }
      this.event(job, job.snapshot.status, job.snapshot.error ?? 'Job finished')
      job.finished = true
    }
  }
}
