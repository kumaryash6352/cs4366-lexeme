import { spawn } from 'node:child_process'

export interface CommandOptions {
  timeoutMs?: number
  signal?: AbortSignal
  onStdout?: (text: string) => void
  onStderr?: (text: string) => void
}
export interface CommandResult { code: number; stdout: string; stderr: string }
export type Command = (program: string, args: string[], options?: CommandOptions) => Promise<CommandResult>

// Keep bounded tails for diagnostics; stream callbacks still receive every chunk.
export const runCommand: Command = (program, args, options = {}) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { reject(new Error('Operation cancelled')); return }
  const child = spawn(program, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
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
  child.stdout.on('data', (text: string) => { stdout = (stdout + text).slice(-65536); options.onStdout?.(text) })
  child.stderr.on('data', (text: string) => { stderr = (stderr + text).slice(-65536); options.onStderr?.(text) })
  child.on('error', error => { cleanup(); reject(error) })
  child.on('close', code => {
    cleanup()
    if (interrupted) reject(new Error(interrupted))
    else resolve({ code: code ?? 1, stdout, stderr })
  })
})

export function assertSuccess(result: CommandResult, action: string): void {
  if (result.code !== 0) throw new Error(`${action} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`)
}
