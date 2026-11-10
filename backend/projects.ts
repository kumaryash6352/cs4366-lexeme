import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isIgnoredPath, isSourceFile, PROJECT_LIMITS } from '../shared/project.ts'
import type { Project, SourceFile } from '../shared/project.ts'

export class ProjectError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

function validateUpload(value: unknown) {
  if (!value || typeof value !== 'object') throw new ProjectError('Choose a repository folder.')
  const input = value as Record<string, unknown>
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 255) {
    throw new ProjectError('The repository needs a name of at most 255 characters.')
  }
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > PROJECT_LIMITS.files) {
    throw new ProjectError(`Choose a repository with 1–${PROJECT_LIMITS.files} files.`)
  }
  const paths = new Set<string>()
  let bytes = 0
  const files = input.files.map((file: unknown) => {
    if (!file || typeof file !== 'object') throw new ProjectError('Invalid project file.')
    const { path, content } = file as Record<string, unknown>
    if (typeof path !== 'string' || path.length > 512 || path.includes('\\') || path.includes(':') ||
        [...path].some(character => character < ' ') ||
        path.split('/').some(part => !part || part === '.' || part === '..') ||
        path.split('/').length > PROJECT_LIMITS.depth || isIgnoredPath(path)) {
      throw new ProjectError('Project files must have safe, relative paths.')
    }
    if (paths.has(path)) throw new ProjectError(`Duplicate project file: ${path}`)
    paths.add(path)
    if (typeof content !== 'string' || content.length > Math.ceil(PROJECT_LIMITS.bytes / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
      throw new ProjectError(`Invalid file contents: ${path}`)
    }
    const data = Buffer.from(content, 'base64')
    bytes += data.length
    if (bytes > PROJECT_LIMITS.bytes) throw new ProjectError('The repository exceeds the 10 MiB upload limit.', 413)
    return { path, data }
  }).sort((a, b) => a.path.localeCompare(b.path))
  for (const path of paths) {
    const parts = path.split('/')
    parts.pop()
    while (parts.length) {
      if (paths.has(parts.join('/'))) throw new ProjectError('A project path is both a file and a directory.')
      parts.pop()
    }
  }
  const first = files.find(file => /(^|\/)main\.c$/i.test(file.path)) ??
    files.find(file => /\.c$/i.test(file.path)) ?? files.find(file => isSourceFile(file.path))
  if (!first) throw new ProjectError('The repository must contain at least one .c or .h file.')
  return { name: input.name.trim(), files, first }
}

/** One active workspace per application; serialize reads/replacements to avoid stale files. */
export class ProjectStore {
  private root: Promise<string> | undefined
  private current: { project: Project; directory: string } | undefined
  private queue: Promise<unknown> = Promise.resolve()

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => {})
    return result
  }

  get activeDirectory(): string | undefined { return this.current?.directory }

  get(): Promise<Project | null> {
    return this.serial(async () => this.current ? structuredClone(this.current.project) : null)
  }

  replace(value: unknown): Promise<Project> {
    return this.serial(async () => {
      const upload = validateUpload(value)
      this.root ??= mkdtemp(join(tmpdir(), 'lexeme-workspace-'))
      const root = await this.root
      const id = randomUUID()
      const directory = join(root, id)
      try {
        for (const file of upload.files) {
          const destination = join(directory, file.path)
          await mkdir(dirname(destination), { recursive: true })
          await writeFile(destination, file.data, { flag: 'wx' })
        }
        const project: Project = {
          id, name: upload.name,
          files: upload.files.map(file => ({ path: file.path, size: file.data.length })),
          initialFile: { path: upload.first.path, content: upload.first.data.toString('utf8') },
        }
        // Only application-owned copies are removed; the selected repository is untouched.
        if (this.current) await rm(this.current.directory, { recursive: true, force: true })
        this.current = { project, directory }
        return structuredClone(project)
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
      }
    })
  }

  read(id: string, path: string): Promise<SourceFile> {
    return this.serial(async () => {
      const active = this.current
      if (!active || active.project.id !== id) throw new ProjectError('This project is no longer open.', 404)
      if (!isSourceFile(path) || !active.project.files.some(file => file.path === path)) {
        throw new ProjectError('Source file not found in the active project.', 404)
      }
      return { path, content: await readFile(join(active.directory, path), 'utf8') }
    })
  }

  close(): Promise<void> {
    return this.serial(async () => {
      if (this.root) await rm(await this.root, { recursive: true, force: true })
      this.current = undefined
      this.root = undefined
    })
  }
}
