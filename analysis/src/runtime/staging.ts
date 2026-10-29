import { copyFile, lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { AnalysisRequest } from '../shared/contracts.js'

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
      if (depth > 32) throw new Error('Project nesting exceeds 32 directories')
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
        if (files > 1000 || bytes > 10 * 1024 * 1024) throw new Error('Prototype project limit: 1000 files and 10 MiB')
        await copyFile(from, to)
      } else throw new Error('Project input contains a non-regular file')
    }
    if (!(await lstat(root)).isDirectory()) throw new Error('projectDir must be a directory')
    await copy(root, source, 0)
  }
  signal.throwIfAborted()
  if (!(await lstat(join(source, request.entryFile))).isFile()) throw new Error('Entry file does not exist')
  await writeFile(join(jobDir, 'input', 'request.json'), JSON.stringify({
    schemaVersion: 1, jobId, operation: 'preprocess', languageStandard: 'c11',
    entryFile: request.entryFile, includeDirs: request.includeDirs, defines: request.defines,
  }, null, 2))
}
