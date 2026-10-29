import { AnalysisSetup } from './prepare.js'

try {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node analysis/dist/setup/cli.js')
  } else {
    if (args.length) throw new Error('Usage: node analysis/dist/setup/cli.js')
    const setup = new AnalysisSetup({ autoInstall: process.env.LEXEME_AUTO_INSTALL_PODMAN !== '0' })
    const image = await setup.prepare((stage, message) => console.log(`[${stage}] ${message}`))
    console.log(`Image setup complete: ${image}.`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
