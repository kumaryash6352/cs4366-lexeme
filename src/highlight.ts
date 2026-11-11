// C syntax highlighting with Prism, split per line so the source view can keep its
// per-line gutter, linking, and diagnostics. Block comments and strings that span
// lines keep their token class on every line they cover.
import Prism from 'prismjs'
import 'prismjs/components/prism-c'

export interface Piece { text: string; cls: string }

const grammar = () => Prism.languages['c'] ?? Prism.languages['clike']!

export function highlightLines(source: string): Piece[][] {
  const lines: Piece[][] = [[]]
  const push = (text: string, cls: string) => {
    const parts = text.split('\n')
    parts.forEach((part, i) => {
      if (i > 0) lines.push([])
      if (part) lines[lines.length - 1]!.push({ text: part, cls })
    })
  }
  const walk = (stream: Prism.TokenStream, cls: string) => {
    if (typeof stream === 'string') { push(stream, cls); return }
    if (Array.isArray(stream)) { for (const s of stream) walk(s, cls); return }
    const token = stream as Prism.Token
    const own = ['tok', token.type, ...(token.alias ? [token.alias].flat() : [])].map(c => `tok-${c}`).join(' ')
    walk(token.content, cls ? `${cls} ${own}` : own)
  }
  walk(Prism.tokenize(source, grammar()), '')
  return lines
}
