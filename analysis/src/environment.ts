import { assertSuccess, runCommand } from './command.js'
import type { Command } from './command.js'
import { selectedImage } from './config.js'
import type { Notify } from './config.js'

export interface RuntimeOptions {
  command?: Command
  image?: string
  platform?: NodeJS.Platform
}

/** Readiness checks only. Application startup never installs, builds, or pulls. */
export class PodmanRuntime {
  readonly command: Command
  private options: RuntimeOptions
  constructor(options: RuntimeOptions = {}) {
    this.options = options
    this.command = options.command ?? runCommand
  }

  async ensureReady(notify: Notify = () => {}): Promise<string> {
    if ((this.options.platform ?? process.platform) !== 'linux') {
      throw new Error('Run the backend on Linux with local rootless Podman.')
    }
    notify('checking-podman', 'Checking the prepared Podman environment')
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
    if (runtime.host?.serviceIsRemote || runtime.host?.security?.rootless !== true) {
      throw new Error('Use local rootless Podman as your normal user for this prototype')
    }
    const image = selectedImage(this.options.image)
    notify('checking-image', image)
    const exists = await this.command('podman', ['image', 'exists', image])
    if (exists.code === 1) {
      throw new Error(`Analysis image ${image} is not available locally. Load the prepared image with podman load or pull it from its registry, and set LEXEME_ANALYSIS_IMAGE to its tag; see analysis/README.md.`)
    }
    assertSuccess(exists, 'Image lookup')
    return image
  }

}
