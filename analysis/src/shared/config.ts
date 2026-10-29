import { fileURLToPath } from 'node:url'

export const analysisRoot = fileURLToPath(new URL('../../', import.meta.url))
// Central image name; Podman uses the implicit latest tag.
export const defaultImage = 'localhost/podmananalysiscontainer'
export const setupInstruction = 'Run the one-time setup: node analysis/dist/setup/cli.js'
export type Notify = (stage: string, message: string) => void

export function selectedImage(image?: string): string {
  return image ?? process.env.LEXEME_ANALYSIS_IMAGE ?? defaultImage
}
