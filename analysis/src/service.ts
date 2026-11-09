import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseRequest, parseResult } from './contracts.js'
import type { NormalizedAnalysisRequest, JobSnapshot } from './contracts.js'
import { analysisRoot, analysisTimeout, loadRuntimeConfig } from './config.js'
import type { RuntimeConfig } from './config.js'
import { assertSuccess, installPackages, PodmanRuntime } from './environment.js'
import { openWorkerLog, stageRequest } from './staging.js'

interface Job { snapshot: JobSnapshot; controller: AbortController; done: Promise<void>; finished: boolean }
export interface ServiceOptions {
  environment?: PodmanRuntime
  jobsRoot?: string
  timeoutMs?: number
  configPath?: string
}

/** One application session owns a serial queue; each job gets a fresh container. */
export class AnalysisService {
  readonly environment: PodmanRuntime
  readonly jobsRoot: string
  private jobs = new Map<string, Job>()
  private queue: Promise<void> = Promise.resolve()
  private startup: Promise<void> | undefined
  private shutdownPromise: Promise<void> | undefined
  private timeoutMs: number
  private config: RuntimeConfig
  private closed = false
  private image: string | undefined
  private containers = new Set<string>()
  private runtimeFailure: string | undefined

  constructor(options: ServiceOptions = {}) {
    this.config = loadRuntimeConfig(options.configPath)
    this.environment = options.environment ?? new PodmanRuntime()
    const sessionId = randomUUID()
    this.jobsRoot = resolve(options.jobsRoot ?? join(analysisRoot, '.jobs'), sessionId)
    if (/[:,\n\r]/.test(this.jobsRoot)) throw new Error('jobsRoot cannot contain colon, comma, or newline characters')
    this.timeoutMs = analysisTimeout(options.timeoutMs ?? this.config.timeouts.analysisMs)
  }

  /** Call once at application startup, before accepting parsing requests. */
  start(notify: (stage: string, message: string) => void = () => {}): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Analysis service is shutting down'))
    this.startup ??= this.prepare(notify)
    return this.startup
  }

  private async prepare(notify: (stage: string, message: string) => void): Promise<void> {
    this.image = await this.environment.ensureReady(notify, this.config)
    if (this.closed) throw new Error('Application shut down during analysis startup')
    await mkdir(this.jobsRoot, { recursive: true })
    notify('ready', this.image)
  }

  private async startContainer(containerName: string, jobDir: string, job: Job): Promise<void> {
    const { signal } = job.controller
    signal.throwIfAborted()
    // Track before run: Podman can create a container even if the command fails.
    this.containers.add(containerName)
    this.event(job, 'starting-container', containerName)
    assertSuccess(await this.environment.command('podman', [
      // Each run starts from the pulled base image, with only this job mounted.
      'run', '--detach', '--name', containerName, '--pull=never',
      '--userns=keep-id', '--security-opt=no-new-privileges',
      `--memory=${this.config.container.memory}`, `--pids-limit=${this.config.container.pidsLimit}`,
      '--volume', `${jobDir}:/jobs/${job.snapshot.id}:Z`,
      ...(this.config.localDevelopment ? ['--volume', `${join(analysisRoot, 'worker')}:/app/worker:ro,Z`] : []),
      this.image!, '--serve',
    ]), 'Job container startup')
    signal.throwIfAborted()
    this.event(job, 'verifying-worker', 'Checking the worker in the job container')
    const checked = await this.environment.command('podman', [
      'exec', containerName, 'node', '/app/worker/main.mjs', '--self-check',
    ])
    assertSuccess(checked, 'Worker self-check (rebuild the image if graph tools are missing)')
    let graphProtocol
    try { graphProtocol = JSON.parse(checked.stdout).graphProtocol } catch {  }
    if (graphProtocol !== 1) throw new Error('Worker image lacks graph protocol 1; rebuild the image or enable localDevelopment with a current toolchain image')
    signal.throwIfAborted()
  }

  /** Accepts a backend request with source/projectDir and optional Debian dependencies. */
  submit(value: unknown): JobSnapshot {
    if (this.closed) throw new Error('Analysis service is shutting down')
    if (!this.startup) throw new Error('Call analysis.start() at application startup before submitting requests')
    if (this.runtimeFailure) throw new Error(this.runtimeFailure)
    const request = parseRequest(value, this.config.limits)
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

  artifactPath(id: string, path?: string): string | undefined {
    const snapshot = this.get(id)
    if (snapshot?.status !== 'succeeded') return undefined
    const artifact = path === undefined ? snapshot.result?.artifacts.find(artifact => artifact.kind === 'graphs')
      : snapshot.result?.artifacts.find(artifact => artifact.path === path)
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
    // Retry any cleanup that failed at the end of a job.
    for (const containerName of this.containers) await this.removeContainer(containerName)
  }

  private async removeContainer(containerName: string): Promise<void> {
    assertSuccess(await this.environment.command('podman', ['rm', '--force', '--ignore', containerName]), 'Job container cleanup')
    this.containers.delete(containerName)
  }

  private event(job: Job, stage: string, message: string): void {
    job.snapshot.events.push({ at: new Date().toISOString(), stage, message: message.slice(-2000) })
    if (job.snapshot.events.length > 100) job.snapshot.events.shift()
  }

  private async execute(job: Job, request: NormalizedAnalysisRequest): Promise<void> {
    const { signal } = job.controller
    const jobDir = join(this.jobsRoot, job.snapshot.id)
    const containerName = `lexeme-job-${job.snapshot.id}`
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let log: Awaited<ReturnType<typeof openWorkerLog>> | undefined
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
      await stageRequest(request, job.snapshot.id, jobDir, signal, this.config.limits, dirname(this.jobsRoot))
      signal.throwIfAborted()
      await this.startContainer(containerName, jobDir, job)
      if (request.dependencies.length > 0) {
        await installPackages(this.environment.command, containerName, request.dependencies, signal, this.config.timeouts.packageCommandMs,
          (stage, message) => this.event(job, stage, message))
      }
      signal.throwIfAborted()
      signal.addEventListener('abort', requestCancellation, { once: true })
      job.snapshot.status = 'running'
      timer = setTimeout(() => { timedOut = true; job.controller.abort() }, this.timeoutMs)
      log = await openWorkerLog(join(jobDir, 'worker.log'), this.config.limits.workerLogBytes)
      let pending = ''
      let oversizedLine = false
      const run = await this.environment.command('podman', [
        'exec', containerName, 'node', '/app/worker/main.mjs',
        '--job', job.snapshot.id, '--timeout-ms', String(this.timeoutMs),
      ], {
        // The worker observes cancellation and kills its compiler process group.
        // Killing only the host exec client could leave the compiler running.
        timeoutMs: this.timeoutMs + 10_000,
        tailBytes: this.config.limits.errorTailBytes,
        onStderr: text => log!.write(text),
        onStdout: async text => {
          await log!.write(text)
          // Progress messages are tiny. Oversized lines are logged but not parsed.
          const parts = text.split('\n')
          for (let index = 0; index < parts.length; index++) {
            if (!oversizedLine) {
              pending += parts[index]
              if (pending.length > 4096) { pending = ''; oversizedLine = true }
            }
            if (index === parts.length - 1) break
            try {
              const event = JSON.parse(pending)
              if (event.type === 'progress' && typeof event.stage === 'string') this.event(job, event.stage, event.stage)
            } catch { /* Non-progress output is already in worker.log. */ }
            pending = ''
            oversizedLine = false
          }
        },
      })
      signal.throwIfAborted()
      const resultPath = join(jobDir, 'output', 'result.json')
      const resultFile = await stat(resultPath).catch(error => {
        if (error.code === 'ENOENT') {
          assertSuccess(run, 'Worker process')
          throw new Error('Worker did not produce result.json')
        }
        throw error
      })
      if (resultFile.size > 1024 * 1024) throw new Error('Worker result exceeds 1 MiB')
      const result = parseResult(JSON.parse(await readFile(resultPath, 'utf8')), job.snapshot.id)
      if (result.status === 'succeeded') {
        assertSuccess(run, 'Worker process')
        for (const artifact of result.artifacts) {
          const file = await stat(join(jobDir, 'output', artifact.path))
          if (!file.isFile()) throw new Error(`Worker omitted ${artifact.path}`)
          if (file.size > this.config.limits.artifactBytes) throw new Error(`Worker artifact ${artifact.path} exceeds configured byte limit`)
        }
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
      if (this.containers.has(containerName)) {
        try {
          await this.removeContainer(containerName)
          this.event(job, 'container-removed', containerName)
        } catch (error) {
          // Do not start another job while processes from this one may still exist.
          this.runtimeFailure = 'Job container cleanup failed; shut down and restart the analysis service'
          job.snapshot.status = 'failed'
          const message = error instanceof Error ? error.message : String(error)
          job.snapshot.error = [job.snapshot.error, message].filter(Boolean).join('; ')
          this.event(job, 'cleanup-error', message)
        }
      }
      if (log) {
        try { await log.close() }
        catch (error) { this.event(job, 'log-error', String(error)) }
      }
      this.event(job, job.snapshot.status, job.snapshot.error ?? 'Job finished')
      job.finished = true
    }
  }
}
