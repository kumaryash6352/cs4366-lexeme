import { useEffect, useMemo, useRef } from 'react'
import type { Diagnostic, SourceFile, SourceSpan } from '../shared/graph.ts'
import { highlightLines } from './highlight.ts'

interface Props {
  files: SourceFile[]
  active: string
  editing: boolean
  onEdit: (path: string, text: string) => void
  highlight: SourceSpan | undefined
  /** Lines in the active file that map to a node in the current graph. */
  linked: Set<number>
  onLine: (file: string, line: number) => void
  /** Right-click on a line: client coordinates for a context menu. */
  onLineContext?: (file: string, line: number, x: number, y: number) => void
  diagnostics: Diagnostic[]
  /** Bumped to scroll to a line even when it is already highlighted. */
  focus: { file: string; line: number; at: number } | undefined
}

export function SourcePane({ files, active, editing, onEdit, highlight, linked, onLine, onLineContext, diagnostics, focus }: Props) {
  const file = files.find(f => f.path === active) ?? files[0]
  const lines = useMemo(() => (file?.text ?? '').split('\n'), [file])
  const tokens = useMemo(() => highlightLines(file?.text ?? ''), [file])
  const rows = useRef(new Map<number, HTMLElement>())
  const marks = useMemo(() => {
    const map = new Map<number, Diagnostic['severity']>()
    for (const d of diagnostics) {
      if (!d.span || d.span.file !== file?.path) continue
      if (map.get(d.span.line) !== 'error') map.set(d.span.line, d.severity)
    }
    return map
  }, [diagnostics, file])

  const target = highlight?.file === file?.path ? highlight?.line : undefined
  useEffect(() => {
    if (target !== undefined) rows.current.get(target)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [target])
  useEffect(() => {
    if (focus && focus.file === file?.path) rows.current.get(focus.line)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focus, file])

  return (
    <>
      {!file ? <p className="muted empty">No project open. Enter a folder path above.</p>
        : editing ? (
          <textarea key={file.path} value={file.text} onChange={event => onEdit(file.path, event.target.value)} spellCheck={false} aria-label={`Edit ${file.path}`} autoFocus />
        ) : (
          <ol className="code" aria-label={`${file.path}; select a linked line to find its graph node`}>
            {lines.map((text, i) => {
              const line = i + 1
              const inRange = highlight?.file === file.path && line >= highlight.line && line <= highlight.endLine
              const mark = marks.get(line)
              return (
                <li
                  key={line}
                  ref={el => { if (el) rows.current.set(line, el); else rows.current.delete(line) }}
                  className={[linked.has(line) ? 'linked' : '', inRange ? 'selected' : '', mark ? `diag-${mark}` : '',
                    focus?.file === file.path && focus.line === line ? 'focus' : ''].filter(Boolean).join(' ')}
                  onClick={() => onLine(file.path, line)}
                  onContextMenu={event => { if (!onLineContext) return; event.preventDefault(); onLine(file.path, line); onLineContext(file.path, line, event.clientX, event.clientY) }}
                >
                  <span className="ln" aria-hidden="true">{line}</span><code>{text ? (tokens[i] ?? [{ text, cls: '' }]).map((t, k) => <span key={k} className={t.cls || undefined}>{t.text}</span>) : ' '}</code>
                </li>
              )
            })}
          </ol>
        )}
    </>
  )
}
