import { fileURLToPath } from 'node:url'

export const analysisRoot = fileURLToPath(new URL('../', import.meta.url))
// Prepared worker image; override with LEXEME_ANALYSIS_IMAGE when needed.
export const defaultImage = 'ghcr.io/mmaa304603/analysiscontainer:v1'
export type Notify = (stage: string, message: string) => void

export function selectedImage(image?: string): string {
  return image ?? process.env.LEXEME_ANALYSIS_IMAGE ?? defaultImage
}
