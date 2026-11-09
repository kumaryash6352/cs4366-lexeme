import { copyFile, lstat, mkdir, open, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { NormalizedAnalysisRequest } from './contracts.js'
import type { RuntimeConfig } from './config.js'

export async function stageRequest(request: NormalizedAnalysisRequest, jobId: string, jobDir: string, signal: AbortSignal, limits: RuntimeConfig['limits'], excludedRoot = dirname(jobDir)): Promise<void> {
  const source = join(jobDir, 'input', 'source')
  await Promise.all(['input/source', 'work', 'output'].map(dir => mkdir(join(jobDir, dir), { recursive: true })))
  if (request.source !== undefined) {
    const target = join(source, request.entryFile)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, request.source)
  } else {
    const root = resolve(request.projectDir)
    let files = 0
    let bytes = 0
    const copy = async (from: string, to: string, depth: number): Promise<void> => {
      signal.throwIfAborted()
      // A source project may contain the configured jobs root; never copy jobs into themselves.
      if (from === resolve(excludedRoot)) return
      if (depth > limits.projectDepth) throw new Error(`Project nesting exceeds ${limits.projectDepth} directories`)
      const stat = await lstat(from)
      if (stat.isSymbolicLink()) throw new Error('Prototype project inputs must not contain symbolic links')
      if (stat.isDirectory()) {
        await mkdir(to, { recursive: true })
        for (const entry of await readdir(from)) {
          if (['.git', 'node_modules'].includes(entry)) continue
          await copy(join(from, entry), join(to, entry), depth + 1)
        }
      } else if (stat.isFile()) {
        files++
        bytes += stat.size
        if (files > limits.projectFiles || bytes > limits.projectBytes) {
          throw new Error(`Project limit: ${limits.projectFiles} files and ${limits.projectBytes} bytes`)
        }
        await copyFile(from, to)
      } else throw new Error('Project input contains a non-regular file')
    }
    if (!(await lstat(root)).isDirectory()) throw new Error('projectDir must be a directory')
    await copy(root, source, 0)
  }
  signal.throwIfAborted()
  const requiredFile = request.entryFile ?? 'CMakeLists.txt'
  if (!(await lstat(join(source, requiredFile))).isFile()) throw new Error(`Missing input file: ${requiredFile}`)
  await writeFile(join(jobDir, 'input', 'request.json'), JSON.stringify({
    schemaVersion: 1, jobId, operation: 'analyze', languageStandard: 'c11',
    entryFile: request.entryFile, includeDirs: request.includeDirs, defines: request.defines,
    errorTailBytes: limits.errorTailBytes,
    artifactBytes: limits.artifactBytes,
  }, null, 2))
}

/** Stream a bounded log to disk; callers await writes to avoid buffering output. */
export async function openWorkerLog(path: string, maxBytes: number) {
  const file = await open(path, 'w')
  const marker = Buffer.from('\n[worker log truncated]\n').subarray(0, maxBytes)
  const contentLimit = maxBytes - marker.length
  let written = 0
  let truncated = false
  let pending = Promise.resolve()
  return {
    write(text: string): Promise<void> {
      pending = pending.then(async () => {
        if (truncated) return
        const bytes = Buffer.from(text)
        const kept = bytes.subarray(0, contentLimit - written)
        if (kept.length) await file.writeFile(kept)
        written += kept.length
        if (kept.length < bytes.length) {
          await file.writeFile(marker)
          truncated = true
        }
      })
      return pending
    },
    async close(): Promise<void> {
      try { await pending } finally { await file.close() }
    },
  }
}
