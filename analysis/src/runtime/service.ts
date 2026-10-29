import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { assertSuccess } from '../shared/command.js'
import { parseRequest, parseResult } from '../shared/contracts.js'
import type { AnalysisRequest, JobSnapshot } from '../shared/contracts.js'
import { analysisRoot } from '../shared/config.js'
import { PodmanRuntime } from './environment.js'
import { stageRequest } from './staging.js'

interface Job { snapshot: JobSnapshot; controller: AbortController; done: Promise<void>; finished: boolean }
export interface ServiceOptions {
  environment?: PodmanRuntime
  jobsRoot?: string
  timeoutMs?: number
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
  private closed = false
  private containerMayExist = false
  private runtimeFailure: string | undefined

  constructor(options: ServiceOptions = {}) {
    this.environment = options.environment ?? new PodmanRuntime()
    const sessionId = randomUUID()
    this.containerName = `lexeme-session-${sessionId}`
    this.jobsRoot = resolve(options.jobsRoot ?? join(analysisRoot, '.jobs'), sessionId)
    if (/[:,\n\r]/.test(this.jobsRoot)) throw new Error('jobsRoot cannot contain colon, comma, or newline characters')
    this.timeoutMs = options.timeoutMs ?? 60_000
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 600_000) {
      throw new Error('timeoutMs must be an integer between 1 and 600000')
    }
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
      this.containerMayExist = true
      notify('starting-container', this.containerName)
      assertSuccess(await this.environment.command('podman', [
        'run', '--detach', '--name', this.containerName, '--pull=never', '--network=none',
        '--userns=keep-id', '--cap-drop=all', '--security-opt=no-new-privileges',
        '--memory=512m', '--pids-limit=128', '--volume', `${this.jobsRoot}:/jobs:Z`, image, '--serve',
      ]), 'Persistent container startup')
      if (this.closed) throw new Error('Application shut down during analysis startup')
      notify('verifying-worker', 'Checking the worker in the persistent container')
      assertSuccess(await this.environment.command('podman', [
        'exec', this.containerName, 'node', '/app/worker/main.mjs', '--self-check',
      ]), 'Worker self-check')
      notify('ready', this.containerName)
    } catch (error) {
      if (this.containerMayExist) await this.removeContainer()
      throw error
    }
  }

  /** Accepts the backend JSON object described in examples/parse-request.json. */
  submit(value: unknown): JobSnapshot {
    if (this.closed) throw new Error('Analysis service is shutting down')
    if (!this.startup) throw new Error('Call analysis.start() at application startup before submitting requests')
    if (this.runtimeFailure) throw new Error(this.runtimeFailure)
    const request = parseRequest(value)
    if (this.jobs.size >= 100) throw new Error('Prototype session limit reached (100 jobs); start a new application session')
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

  artifactPath(id: string): string | undefined {
    return this.get(id)?.status === 'succeeded' ? join(this.jobsRoot, id, 'output', 'main.i') : undefined
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job) return false
    if (['queued', 'preparing', 'running'].includes(job.snapshot.status)) {
      job.controller.abort()
      this.event(job, 'cancelling', 'Cancellation requested for this job; the session container remains running')
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
    if (this.containerMayExist) await this.removeContainer()
  }

  private async removeContainer(): Promise<void> {
    assertSuccess(await this.environment.command('podman', ['rm', '--force', '--ignore', this.containerName]), 'Session container cleanup')
    this.containerMayExist = false
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
          onStderr: text => { log = (log + text).slice(-65536) },
          onStdout: text => {
            pending += text
            if (pending.length > 65536) { pending = ''; return }
            let end: number
            while ((end = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0, end)
              pending = pending.slice(end + 1)
              try {
                const event = JSON.parse(line)
                if (event.type === 'progress' && typeof event.stage === 'string') this.event(job, event.stage, event.stage)
              } catch { log = (log + line + '\n').slice(-65536) }
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
      if ((await stat(resultPath)).size > 1024 * 1024) throw new Error('Worker result exceeds 1 MiB')
      const result = parseResult(JSON.parse(await readFile(resultPath, 'utf8')), job.snapshot.id)
      if (result.status === 'succeeded') {
        assertSuccess(run, 'Worker process')
        if (!(await stat(join(jobDir, 'output', 'main.i'))).isFile()) throw new Error('Worker omitted main.i')
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
      this.event(job, job.snapshot.status, job.snapshot.error ?? 'Job finished; session container remains available')
      job.finished = true
    }
  }
}
