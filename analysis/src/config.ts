import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const analysisRoot = fileURLToPath(new URL('../', import.meta.url))
export type Notify = (stage: string, message: string) => void

export async function selectedImage(image?: string): Promise<string> {
  let selected: unknown = image ?? process.env.LEXEME_ANALYSIS_IMAGE
  if (selected === undefined) {
    const config = JSON.parse(await readFile(join(analysisRoot, 'runtime.config.json'), 'utf8'))
    selected = config?.image
  }
  if (typeof selected !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*\/[a-zA-Z0-9._:/@-]+$/.test(selected)) {
    throw new Error('Configure a fully qualified registry image in analysis/runtime.config.json')
  }
  return selected
}
