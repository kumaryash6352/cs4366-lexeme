import { assertSuccess, runCommand } from '../shared/command.js'
import type { Command } from '../shared/command.js'
import { selectedImage, setupInstruction } from '../shared/config.js'
import type { Notify } from '../shared/config.js'
import { assertSupportedPlatform, checkRuntime } from '../shared/podman.js'

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
    assertSupportedPlatform(this.options.platform)
    notify('checking-podman', 'Checking the prepared Podman environment')
    try {
      assertSuccess(await this.command('podman', ['--version']), 'Podman executable check')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`Podman is not installed. ${setupInstruction}`)
      }
      throw error
    }
    await checkRuntime(this.command)
    const image = selectedImage(this.options.image)
    notify('checking-image', image)
    const exists = await this.command('podman', ['image', 'exists', image])
    if (exists.code === 1) throw new Error(`Analysis image ${image} is not prepared. ${setupInstruction}`)
    assertSuccess(exists, 'Image lookup')
    return image
  }

}
