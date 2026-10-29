import { assertSuccess } from './command.js'
import type { Command } from './command.js'

export function assertSupportedPlatform(platform = process.platform): void {
  if (platform !== 'linux') throw new Error('Run setup and the backend on Ubuntu with local Podman.')
}

export async function checkRuntime(command: Command): Promise<void> {
  const result = await command('podman', ['info', '--format', 'json'])
  assertSuccess(result, 'Podman runtime check')
  const runtime = JSON.parse(result.stdout)
  if (runtime.host?.serviceIsRemote || runtime.host?.security?.rootless !== true) {
    throw new Error('Use local rootless Podman as your normal user for this prototype')
  }
}
