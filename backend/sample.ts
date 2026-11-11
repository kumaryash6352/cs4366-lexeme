import { readFile } from 'node:fs/promises'

/** Example program shown on first launch. */
export const sampleCode = await readFile(new URL('../shared/sample.c', import.meta.url), 'utf8')
