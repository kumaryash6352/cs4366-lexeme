import { useMemo, useState } from 'react'
import type { Diagnostic, SourceFile } from '../shared/graph.ts'

interface Props {
  files: SourceFile[]
  active: string
  onOpen: (path: string) => void
  onContext?: (path: string, x: number, y: number) => void
  /** Translation units that were analyzed. */
  units: Set<string>
  /** Files the analysis touched (units and the project headers they include). */
  used: Set<string>
  diagnostics: Diagnostic[]
}

interface Dir { name: string; path: string; dirs: Map<string, Dir>; files: SourceFile[] }

function buildTree(files: SourceFile[]): Dir {
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let dir = root
    for (const part of parts.slice(0, -1)) {
      const path = dir.path ? `${dir.path}/${part}` : part
      if (!dir.dirs.has(part)) dir.dirs.set(part, { name: part, path, dirs: new Map(), files: [] })
      dir = dir.dirs.get(part)!
    }
    dir.files.push(file)
  }
  return root
}

const anyUsed = (dir: Dir, used: Set<string>): boolean =>
  dir.files.some(f => used.has(f.path)) || [...dir.dirs.values()].some(d => anyUsed(d, used))

/** Project files as a collapsible tree. Folders the analysis never touches (e.g. build
 * output) start collapsed and dimmed. */
export function FileTree({ files, active, onOpen, onContext, units, used, diagnostics }: Props) {
  const tree = useMemo(() => buildTree(files), [files])
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const counts = useMemo(() => {
    const map = new Map<string, { errors: number; warnings: number }>()
    for (const d of diagnostics) {
      if (!d.span) continue
      const c = map.get(d.span.file) ?? { errors: 0, warnings: 0 }
      if (d.severity === 'error') c.errors++
      else if (d.severity === 'warning') c.warnings++
      map.set(d.span.file, c)
    }
    return map
  }, [diagnostics])

  const q = filter.trim().toLowerCase()
  const open = (dir: Dir) => {
    const byDefault = anyUsed(dir, used) || used.size === 0
    return q ? true : toggled.has(dir.path) ? !byDefault : byDefault
  }
  const visibleFile = (f: SourceFile) => !q || f.path.toLowerCase().includes(q)
  const hasVisible = (dir: Dir): boolean => dir.files.some(visibleFile) || [...dir.dirs.values()].some(hasVisible)
  const toggle = (path: string) => setToggled(t => { const n = new Set(t); if (!n.delete(path)) n.add(path); return n })

  const render = (dir: Dir, depth: number): React.ReactNode[] => {
    const rows: React.ReactNode[] = []
    for (const sub of [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!hasVisible(sub)) continue
      const isOpen = open(sub)
      rows.push(
        <li key={`d:${sub.path}`} className={`tree-dir${anyUsed(sub, used) ? '' : ' unused'}`} style={{ paddingLeft: 4 + depth * 12 }}
          onClick={() => toggle(sub.path)} role="treeitem" aria-expanded={isOpen} title={sub.path}>
          <span className="twisty" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>{sub.name}
        </li>,
      )
      if (isOpen) rows.push(...render(sub, depth + 1))
    }
    for (const file of [...dir.files].sort((a, b) => a.path.localeCompare(b.path))) {
      if (!visibleFile(file)) continue
      const name = file.path.slice(file.path.lastIndexOf('/') + 1)
      const c = counts.get(file.path)
      rows.push(
        <li key={file.path} role="treeitem" aria-selected={file.path === active} title={file.path}
          className={['tree-file', file.path === active ? 'active' : '', used.size && !used.has(file.path) ? 'unused' : ''].filter(Boolean).join(' ')}
          style={{ paddingLeft: 16 + depth * 12 }}
          onClick={() => onOpen(file.path)}
          onContextMenu={e => { if (!onContext) return; e.preventDefault(); onContext(file.path, e.clientX, e.clientY) }}>
          <span className={`ext ext-${name.split('.').pop()}`} aria-hidden="true">{name.endsWith('.json') ? '{}' : name.split('.').pop()}</span>
          <span className="name">{name}</span>
          {units.has(file.path) && <span className="unit" title="Analyzed translation unit">●</span>}
          {c?.errors ? <span className="count err" title={`${c.errors} error(s)`}>{c.errors}</span> : null}
          {c?.warnings ? <span className="count warn" title={`${c.warnings} warning(s)`}>{c.warnings}</span> : null}
        </li>,
      )
    }
    return rows
  }

  return (
    <div className="file-tree">
      <input className="tree-filter" type="search" placeholder="Filter files" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter files" />
      {files.length === 0
        ? <p className="muted tree-empty">No project open.</p>
        : <ul role="tree" aria-label="Project files">{render(tree, 0)}</ul>}
    </div>
  )
}
