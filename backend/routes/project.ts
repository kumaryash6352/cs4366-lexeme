import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FastifyPluginAsync } from 'fastify'

const SOURCE = /\.(c|h)$/
const SKIP = new Set(['.git', '.hg', '.svn', 'node_modules'])
const MAX_FILES = 5000
const MAX_FILE_BYTES = 4 * 1024 * 1024

/** Read a project's C sources (and any compile_commands.json) from a local directory. */
export async function readProject(dir: string): Promise<{ root: string; files: { path: string; text: string }[]; skipped: number }> {
  const root = resolve(dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir)
  if (!(await stat(root)).isDirectory()) throw new Error(`${root} is not a directory`)
  const files: { path: string; text: string }[] = []
  let skipped = 0
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) { if (!SKIP.has(entry.name)) await walk(full); continue }
      if (!entry.isFile() || !(SOURCE.test(entry.name) || entry.name === 'compile_commands.json')) continue
      if ((await stat(full)).size > MAX_FILE_BYTES) { skipped++; continue }
      if (files.length >= MAX_FILES) throw new Error(`More than ${MAX_FILES} source files under ${root}; open a subdirectory`)
      files.push({ path: relative(root, full).split(sep).join('/'), text: await readFile(full, 'utf8') })
    }
  }
  await walk(root)
  if (files.length === 0) throw new Error(`No .c or .h files under ${root}`)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { root, files, skipped }
}

const projectRoutes: FastifyPluginAsync = async fastify => {
  fastify.post<{ Body: { path: string } }>('/open', {
    schema: { body: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } } } },
  }, async (request, reply) => {
    const path = request.body.path.trim()
    if (!isAbsolute(path) && !path.startsWith('~')) return reply.code(400).send({ error: 'Enter an absolute path (or one starting with ~)' })
    try {
      return await readProject(path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.code(400).send({ error: /ENOENT/.test(message) ? `No such directory: ${path}` : message })
    }
  })
}

export default projectRoutes
