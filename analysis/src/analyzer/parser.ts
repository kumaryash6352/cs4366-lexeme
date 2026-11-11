import { createRequire } from 'node:module'
import { Language, Parser } from 'web-tree-sitter'

let ready: Promise<Parser> | undefined

/** Shared Tree-sitter parser for the C grammar (WebAssembly; no native build). */
export function cParser(): Promise<Parser> {
  ready ??= (async () => {
    const require = createRequire(import.meta.url)
    await Parser.init()
    const language = await Language.load(require.resolve('tree-sitter-c/tree-sitter-c.wasm'))
    const parser = new Parser()
    parser.setLanguage(language)
    return parser
  })()
  return ready
}
