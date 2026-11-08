import { spawn } from 'node:child_process'

export interface CommandOptions {
  timeoutMs?: number
  signal?: AbortSignal
  tailBytes?: number
  onStdout?: (text: string) => void | Promise<void>
  onStderr?: (text: string) => void | Promise<void>
}
export interface CommandResult { code: number; stdout: string; stderr: string }
export type Command = (program: string, args: string[], options?: CommandOptions) => Promise<CommandResult>

// Keep bounded tails for diagnostics; stream callbacks still receive every chunk.
export const runCommand: Command = (program, args, options = {}) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { reject(new Error('Operation cancelled')); return }
  const child = spawn(program, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = Buffer.alloc(0)
  let stderr = Buffer.alloc(0)
  // Preserve capture capacity for structured output such as `podman info` JSON.
  // Worker jobs supply their smaller, configured diagnostic budget explicitly.
  const tailBytes = options.tailBytes ?? 64 * 1024
  let interrupted = ''
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const interrupt = (reason: string) => {
    if (interrupted) return
    interrupted = reason
    child.kill('SIGTERM')
    killTimer = setTimeout(() => child.kill('SIGKILL'), 3000)
  }
  const abort = () => interrupt('Operation cancelled')
  const timer = setTimeout(() => interrupt(`${program} timed out`), options.timeoutMs ?? 60_000)
  options.signal?.addEventListener('abort', abort, { once: true })
  const cleanup = () => {
    clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
    options.signal?.removeEventListener('abort', abort)
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  // Await consumers so a slow log file applies backpressure to the child pipes.
  const consume = async (stream: typeof child.stdout, isStderr: boolean) => {
    for await (const text of stream) {
      const chunk = Buffer.from(text)
      if (isStderr) {
        stderr = Buffer.from(Buffer.concat([stderr, chunk]).subarray(-tailBytes))
        await options.onStderr?.(String(text))
      } else {
        stdout = Buffer.from(Buffer.concat([stdout, chunk]).subarray(-tailBytes))
        await options.onStdout?.(String(text))
      }
    }
  }
  const consumed = Promise.all([consume(child.stdout, false), consume(child.stderr, true)])
  consumed.catch(() => interrupt('Output handling failed'))
  child.on('error', error => { cleanup(); reject(error) })
  child.on('close', async code => {
    cleanup()
    try {
      await consumed
      if (interrupted) reject(new Error(interrupted))
      else resolve({ code: code ?? 1, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') })
    } catch (error) { reject(error) }
  })
})

export function assertSuccess(result: CommandResult, action: string): void {
  if (result.code !== 0) throw new Error(`${action} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`)
}
