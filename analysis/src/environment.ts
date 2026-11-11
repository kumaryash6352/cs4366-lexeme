import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { assertSuccess, runCommand } from './command.js'
import type { Command } from './command.js'
import { analysisRoot, selectedImage } from './config.js'
import type { Notify } from './config.js'

export interface RuntimeOptions {
  command?: Command
  image?: string
  platform?: NodeJS.Platform
  /** Registry images: `always` (default) pulls at startup; `missing` uses a local copy
   * when present. `localhost/` images are never pulled: they are built on demand. */
  pull?: 'always' | 'missing'
  /** Build context for on-demand builds (default: the analysis/ directory). */
  buildContext?: string
}

/** Hash of everything that goes into the image, so a stale local build is rebuilt. */
export async function imageInputsHash(context: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (path: string): Promise<void> => {
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) } catch { return }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && !entry.name.endsWith('.d.ts')) hash.update(relative(context, full)).update(await readFile(full))
    }
  }
  for (const part of ['Containerfile', 'image/package.json', 'image/package-lock.json']) {
    hash.update(part).update(await readFile(join(context, part)).catch(() => Buffer.alloc(0)))
  }
  await walk(join(context, 'worker'))
  await walk(join(context, 'dist', 'analyzer'))
  return hash.digest('hex').slice(0, 16)
}

/** Check local rootless Podman, then pull the configured registry image.
 * Holds no container state, so several AnalysisService instances (one container
 * each) can share one runtime. */
export class PodmanRuntime {
  readonly command: Command
  private options: RuntimeOptions
  constructor(options: RuntimeOptions = {}) {
    this.options = options
    this.command = options.command ?? runCommand
  }

  async ensureReady(notify: Notify = () => {}): Promise<string> {
    const platform = this.options.platform ?? process.platform
    if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') {
      throw new Error('Run the backend on Linux (rootless Podman) or macOS/Windows (Podman machine).')
    }
    notify('checking-podman', 'Checking the Podman environment')
    try {
      assertSuccess(await this.command('podman', ['--version']), 'Podman executable check')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error('Podman is not installed. Install Podman on the backend host before starting analysis; see analysis/README.md.')
      }
      throw error
    }
    const info = await this.command('podman', ['info', '--format', 'json'])
    assertSuccess(info, 'Podman runtime check')
    const runtime = JSON.parse(info.stdout)
    // Linux talks to local rootless Podman. macOS/Windows always go through a Podman
    // machine (a VM that mounts the user's home directory), so remote is expected there.
    const remote = runtime.host?.serviceIsRemote === true
    if (runtime.host?.security?.rootless !== true || (platform === 'linux' && remote)) {
      throw new Error(platform === 'linux'
        ? 'Use local rootless Podman as your normal user for this prototype'
        : 'Use a rootless Podman machine (podman machine init && podman machine start)')
    }
    const image = await selectedImage(this.options.image)
    if (image.startsWith('localhost/')) {
      // Locally built image: build on demand, and rebuild when its inputs change.
      const context = this.options.buildContext ?? analysisRoot
      const wanted = await imageInputsHash(context)
      const inspect = await this.command('podman', ['image', 'inspect', '--format', '{{index .Labels "lexeme.inputs"}}', image])
      if (inspect.code === 0 && inspect.stdout.trim() === wanted) {
        notify('using-local-image', image)
        return image
      }
      notify('building-image', `${image} (${inspect.code === 0 ? 'analyzer changed' : 'first run'}; may take a few minutes)`)
      assertSuccess(await this.command('podman', ['build', '--label', `lexeme.inputs=${wanted}`, '-t', image, context], { timeoutMs: 900_000 }), `Building analysis image ${image}`)
      return image
    }
    const pull = this.options.pull ?? (process.env.LEXEME_ANALYSIS_PULL === 'missing' ? 'missing' : 'always')
    if (pull === 'missing' && (await this.command('podman', ['image', 'exists', image])).code === 0) {
      notify('using-local-image', image)
      return image
    }
    notify('pulling-image', image)
    assertSuccess(await this.command('podman', ['pull', image], { timeoutMs: 300_000 }), `Pulling analysis image ${image}`)
    return image
  }

}
