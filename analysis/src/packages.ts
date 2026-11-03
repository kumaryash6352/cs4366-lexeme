import { assertSuccess } from './command.js'
import type { Command } from './command.js'
import type { Notify } from './config.js'
import { parseDependencies } from './contracts.js'

/** Install into the running container's writable layer, never into the host or registry image.
 * The caller must remove the container on failure/abort: stopping podman exec alone
 * does not guarantee the package manager inside it has stopped.
 */
export async function installPackages(command: Command, container: string, dependencies: string[], signal: AbortSignal, notify: Notify = () => {}): Promise<void> {
  const packages = parseDependencies(dependencies)
  signal.throwIfAborted()
  if (packages.length === 0) return
  const exec = ['exec', '--user', '0:0', '--env', 'DEBIAN_FRONTEND=noninteractive', container, 'apt-get']
  const options = { signal, timeoutMs: 300_000 }
  notify('updating-packages', 'Refreshing Debian package indexes')
  assertSuccess(await command('podman', [...exec, 'update', '--error-on=any'], options), 'Package index update')
  signal.throwIfAborted()
  notify('installing-packages', packages.join(', '))
  assertSuccess(await command('podman', [...exec, 'install', '-y', '--no-install-recommends', '--', ...packages], options), 'Dependency installation')
  signal.throwIfAborted()
}
