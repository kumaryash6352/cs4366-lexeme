import { join } from 'node:path'
import { assertSuccess, runCommand } from '../shared/command.js'
import type { Command } from '../shared/command.js'
import { analysisRoot, selectedImage } from '../shared/config.js'
import type { Notify } from '../shared/config.js'
import { assertSupportedPlatform, checkRuntime } from '../shared/podman.js'
import { installPodman } from './installation.js'

export interface SetupOptions {
  command?: Command
  autoInstall?: boolean
  image?: string
  platform?: NodeJS.Platform
  readOsRelease?: () => Promise<string>
}

export class AnalysisSetup {
  readonly command: Command
  private pending: Promise<string> | undefined
  private listeners = new Set<Notify>()
  private options: SetupOptions

  constructor(options: SetupOptions = {}) {
    this.options = options
    this.command = options.command ?? runCommand
  }

  // Concurrent callers share installation and image preparation.
  async prepare(notify: Notify = () => {}): Promise<string> {
    this.listeners.add(notify)
    if (!this.pending) this.pending = this.prepareImage().finally(() => { this.pending = undefined })
    try { return await this.pending } finally { this.listeners.delete(notify) }
  }

  private emit(stage: string, message: string) {
    for (const listener of this.listeners) listener(stage, message)
  }

  private async prepareImage(): Promise<string> {
    const platform = this.options.platform ?? process.platform
    assertSupportedPlatform(platform)
    this.emit('checking-podman', 'Checking the Podman executable')
    try {
      assertSuccess(await this.command('podman', ['--version']), 'Podman executable check')
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      if (!(this.options.autoInstall ?? true)) throw new Error('Podman is missing; install it or enable automatic installation')
      await installPodman(this.command, (stage, message) => this.emit(stage, message), this.options.readOsRelease)
      try {
        assertSuccess(await this.command('podman', ['--version']), 'Podman executable check after installation')
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error('Podman installation finished but is not on this terminal PATH. Open a new terminal and rerun setup.')
        throw error
      }
    }
    this.emit('checking-runtime', 'Checking rootless Podman runtime')
    await checkRuntime(this.command)
    const configuredImage = this.options.image ?? process.env.LEXEME_ANALYSIS_IMAGE
    const image = selectedImage(this.options.image)
    this.emit('checking-image', image)
    const exists = await this.command('podman', ['image', 'exists', image])
    if (exists.code !== 0 && exists.code !== 1) assertSuccess(exists, 'Image lookup')
    let previousId: string | undefined
    if (exists.code === 0) previousId = await this.imageId(image)
    this.emit('preparing-image', configuredImage ? `Pulling ${image}` : `Building ${image}`)
    const args = configuredImage ? ['pull', image] : ['build', '--tag', image, '--file', join(analysisRoot, 'Containerfile'), analysisRoot]
    assertSuccess(await this.command('podman', args, {
      timeoutMs: 900_000,
      onStdout: text => this.emit('preparing-image', text.slice(-2000)),
      onStderr: text => this.emit('preparing-image', text.slice(-2000)),
    }), 'Image preparation')
    this.emit('verifying-image', 'Checking Node.js and GCC in the prepared image')
    assertSuccess(await this.command('podman', [
      'run', '--rm', '--pull=never', '--network=none', image, '--self-check',
    ]), 'Image self-check')
    if (previousId && previousId !== await this.imageId(image)) {
      // Never force removal: Podman must preserve images still used by containers
      // or other tags. Only target the image replaced by this build.
      const removed = await this.command('podman', ['rmi', previousId])
      if (removed.code !== 0) {
        this.emit('cleanup-pending', `Updated ${image}, but previous image ${previousId} could not be removed: ${removed.stderr.trim() || removed.stdout.trim()}. After releasing its containers or tags, run: podman rmi ${previousId}`)
      } else {
        this.emit('removed-previous-image', previousId)
      }
    }
    this.emit('image-ready', image)
    return image
  }

  private async imageId(image: string): Promise<string> {
    const result = await this.command('podman', ['image', 'inspect', '--format', '{{.Id}}', image])
    assertSuccess(result, 'Image inspection')
    const id = result.stdout.trim()
    if (!/^(sha256:)?[a-f0-9]{64}$/.test(id)) throw new Error('Image inspection returned an invalid image ID')
    return id
  }
}
