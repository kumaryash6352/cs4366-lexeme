import { readFile } from 'node:fs/promises'
import { assertSuccess } from '../shared/command.js'
import type { Command } from '../shared/command.js'
import type { Notify } from '../shared/config.js'

export async function installPodman(
  command: Command,
  notify: Notify,
  readOsRelease = () => readFile('/etc/os-release', 'utf8'),
): Promise<void> {
  if (!/^ID=["']?ubuntu["']?$/m.test(await readOsRelease())) throw new Error('Automatic Podman installation requires Ubuntu')
  const sudo = await command('sudo', ['-n', 'true'])
  if (sudo.code !== 0) throw new Error('Run sudo apt-get update && sudo apt-get install -y podman, then rerun setup. Automatic installation needs sudo authorization.')
  for (const args of [['update'], ['install', '-y', 'podman']]) {
    notify('installing-podman', `apt-get ${args.join(' ')}`)
    assertSuccess(await command('sudo', ['-n', 'apt-get', ...args], {
      timeoutMs: 900_000,
      onStdout: text => notify('installing-podman', text.slice(-2000)),
      onStderr: text => notify('installing-podman', text.slice(-2000)),
    }), 'Podman installation')
  }
}
