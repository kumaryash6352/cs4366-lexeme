import { assertSuccess, runCommand } from './command.js'
import type { Command } from './command.js'
import { loadRuntimeConfig, selectedImage } from './config.js'
import type { Notify, RuntimeConfig } from './config.js'

export interface RuntimeOptions {
  command?: Command
  image?: string
  platform?: NodeJS.Platform
}

/** Check local rootless Podman, then pull the configured registry image. */
export class PodmanRuntime {
  readonly command: Command
  private options: RuntimeOptions
  constructor(options: RuntimeOptions = {}) {
    this.options = options
    this.command = options.command ?? runCommand
  }

  async ensureReady(notify: Notify = () => {}, config: RuntimeConfig = loadRuntimeConfig()): Promise<string> {
    if ((this.options.platform ?? process.platform) !== 'linux') {
      throw new Error('Run the backend on Linux with local rootless Podman.')
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
    if (runtime.host?.serviceIsRemote || runtime.host?.security?.rootless !== true) {
      throw new Error('Use local rootless Podman as your normal user for this prototype')
    }
    const image = selectedImage(this.options.image, config.image)
    notify('pulling-image', image)
    assertSuccess(await this.command('podman', ['pull', image], { timeoutMs: config.timeouts.imagePullMs }), `Pulling analysis image ${image}`)
    return image
  }

}
