import { copyFile, lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { AnalysisRequest } from './contracts.js'
import { MAX_PROJECT_BYTES, MAX_PROJECT_DEPTH, MAX_PROJECT_FILES } from './limits.js'

export async function stageRequest(request: AnalysisRequest, jobId: string, jobDir: string, signal: AbortSignal, excludedRoot = dirname(jobDir)): Promise<void> {
  const source = join(jobDir, 'input', 'source')
  await Promise.all(['input/source', 'work', 'output'].map(dir => mkdir(join(jobDir, dir), { recursive: true })))
  if (request.source !== undefined) {
    const target = join(source, request.entryFile)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, request.source)
  } else {
    const root = resolve(request.projectDir!)
    let files = 0
    let bytes = 0
    const copy = async (from: string, to: string, depth: number): Promise<void> => {
      signal.throwIfAborted()
      // A source project may contain the configured jobs root; never copy jobs into themselves.
      if (from === resolve(excludedRoot)) return
      if (depth > MAX_PROJECT_DEPTH) throw new Error(`Project nesting exceeds ${MAX_PROJECT_DEPTH} directories`)
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
        if (files > MAX_PROJECT_FILES || bytes > MAX_PROJECT_BYTES) throw new Error(`Prototype project limit: ${MAX_PROJECT_FILES} files and ${MAX_PROJECT_BYTES / 1024 / 1024} MiB`)
        await copyFile(from, to)
      } else throw new Error('Project input contains a non-regular file')
    }
    if (!(await lstat(root)).isDirectory()) throw new Error('projectDir must be a directory')
    await copy(root, source, 0)
  }
  signal.throwIfAborted()
  for (const file of request.units?.map(u => u.file) ?? [request.entryFile]) {
    if (!(await lstat(join(source, file)).catch(() => undefined))?.isFile()) throw new Error(`Entry file ${file} does not exist`)
  }
  const body = request.operation === 'analyze'
    ? { schemaVersion: 1, jobId, operation: 'analyze', units: request.units }
    : { schemaVersion: 1, jobId, operation: 'preprocess', languageStandard: 'c11', entryFile: request.entryFile, includeDirs: request.includeDirs, defines: request.defines }
  await writeFile(join(jobDir, 'input', 'request.json'), JSON.stringify(body, null, 2))
}
