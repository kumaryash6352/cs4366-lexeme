import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import type { AnalysisResult, Graph, GraphNode } from '../shared/graph.ts'
import { api } from './api.ts'
import type { Project, SessionSummary } from './api.ts'
import { GraphView } from './graph/GraphView.tsx'
import { NodeShape } from './graph/Shape.tsx'
import { exportJson, exportPng, exportSvg } from './graph/export.ts'
import { DATA_EDGES, styleOf, VIEW_KINDS } from './graph/style.ts'
import { lastPath, pickEntry, rememberPath } from './project.ts'
import { SourcePane } from './SourcePane.tsx'
import { FileTree } from './FileTree.tsx'
import { ContextMenu } from './ContextMenu.tsx'
import { buildIndex, menuForFile, callGraphGroups, expandCallGraph, inlineCalls, inlineKey, menuForLine, menuForNode, PROGRAM } from './navigation.ts'
import type { BlockMode, MenuItem, Target, View } from './navigation.ts'

const VIEWS: { id: View; label: string }[] = [
  { id: 'cfg', label: 'Control flow' },
  { id: 'calls', label: 'Calls' },
  { id: 'includes', label: 'Includes' },
  { id: 'data', label: 'Data deps' },
]
const STDS = ['c89', 'c99', 'c11', 'c17', 'c23', 'gnu11', 'gnu17']
const SLOW_MS = 500

const emptyProject: Project = { files: [], units: [], includeDirs: '', defines: '', std: 'c11' }
const NONE: ReadonlySet<string> = new Set()

function graphFor(result: AnalysisResult | undefined, view: View, fnName: string | undefined): Graph | undefined {
  if (result && view === 'data' && fnName === PROGRAM) return result.program
  if (!result) return undefined
  if (view === 'calls') return result.calls
  if (view === 'includes') return result.includes
  const fn = result.functions.find(f => f.id === fnName) ?? result.functions[0]
  return fn?.[view]
}

export default function App() {
  const [project, setProject] = useState<Project>(emptyProject)
  const [pathInput, setPathInput] = useState(lastPath)
  const [active, setActive] = useState(() => pickEntry(project.files))
  const [editing, setEditing] = useState(false)
  const [result, setResult] = useState<AnalysisResult>()
  const [analyzed, setAnalyzed] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [slow, setSlow] = useState(false)
  const [error, setError] = useState<string>()
  // `#calls`, `#includes`, `#data` open a view directly (handy for links and screenshots).
  const [view, setView] = useState<View>(() => VIEWS.find(v => `#${v.id}` === location.hash)?.id ?? 'cfg')
  const [fnName, setFnName] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [query, setQuery] = useState('')
  const [focus, setFocus] = useState<{ file: string; line: number; at: number }>()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [session, setSession] = useState<{ id?: string; name: string }>({ name: 'Untitled' })
  const [notice, setNotice] = useState<string>()
  /** Call-graph functions expanded in place into their control flow. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>()
  const [graphFocus, setGraphFocus] = useState<{ id: string; at: number }>()
  /** Data view arrangement: automatic (ELK) or program order with arcs. */
  const [dataLayout, setDataLayout] = useState<'auto' | 'order'>('auto')
  /** Calls inlined into a function's control flow, per function: `site|callee` keys. */
  const [inlined, setInlined] = useState<Map<string, Set<string>>>(new Map())
  /** Control-flow block boxes: which to show, and which are collapsed (per function). */
  const [blockMode, setBlockMode] = useState<BlockMode>('complex')
  const [collapsedBlocks, setCollapsedBlocks] = useState<Map<string, Set<string>>>(new Map())
  /** Control flow refocused on one block of a function (like refocusing on a function). */
  const [blockFocus, setBlockFocus] = useState<{ fn: string; key: string }>()
  const svg = useRef<SVGSVGElement>(null)
  /** Column widths (px) for the file browser and source pane; the graph takes the rest. */
  const [widths, setWidths] = useState<{ tree: number; source: number }>(() => {
    try { return { tree: 220, source: 560, ...JSON.parse(localStorage.getItem('lexeme.widths') ?? '{}') } } catch { return { tree: 220, source: 560 } }
  })
  useEffect(() => { try { localStorage.setItem('lexeme.widths', JSON.stringify(widths)) } catch { /* unavailable */ } }, [widths])
  const drag = (which: 'tree' | 'source') => (event: React.PointerEvent) => {
    event.preventDefault()
    const start = event.clientX
    const initial = widths[which]
    const move = (e: PointerEvent) => setWidths(w => ({ ...w, [which]: Math.max(which === 'tree' ? 140 : 280, Math.min(900, initial + e.clientX - start)) }))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.classList.remove('resizing') }
    document.body.classList.add('resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const projectKey = JSON.stringify(project)
  const stale = result !== undefined && analyzed !== projectKey

  const run = useCallback(async (input: Project) => {
    setBusy(true)
    setError(undefined)
    const timer = setTimeout(() => setSlow(true), SLOW_MS)
    try {
      const next = await api.analyze(input)
      setResult(next)
      setAnalyzed(JSON.stringify(input))
      setFnName(name => name === PROGRAM || next.functions.some(f => f.id === name) ? name : (next.functions.find(f => f.name === 'main') ?? next.functions[0])?.id)
      setExpanded(open => new Set([...open].filter(id => next.functions.some(f => f.id === id))))
      setSelected(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      clearTimeout(timer)
      setBusy(false)
      setSlow(false)
    }
  }, [])

  // Nothing opens automatically; only check that the backend is reachable.
  useEffect(() => {
    api.health().catch(() => setError('Cannot reach the Lexeme backend. Start it with `npm run backend`.'))
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void run(project) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [project, run])

  const refreshSessions = useCallback(() => { api.sessions().then(setSessions, () => setSessions([])) }, [])
  useEffect(refreshSessions, [refreshSessions])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(undefined), 2500)
    return () => clearTimeout(timer)
  }, [notice])

  const index = useMemo(() => result ? buildIndex(result) : undefined, [result])
  const callGraph = useMemo(() => index ? expandCallGraph(index, expanded) : undefined, [index, expanded])
  const callGroups = useMemo(() => index && expanded.size ? callGraphGroups(index, expanded) : undefined, [index, expanded])
  const fn = result?.functions.find(f => f.id === fnName) ?? result?.functions[0]
  const cfgKeys = (fn && inlined.get(fn.id)) || NONE
  const blockKeys = (fn && collapsedBlocks.get(fn.id)) || NONE
  const focusKey = blockFocus && fn && blockFocus.fn === fn.id ? blockFocus.key : undefined
  const inline = useMemo(() => index && fn && view === 'cfg' ? inlineCalls(index, fn.id, cfgKeys as Set<string>, blockMode, blockKeys as Set<string>, focusKey) : undefined,
    [index, fn, view, cfgKeys, blockMode, blockKeys, focusKey])
  const graph = view === 'calls' ? callGraph : view === 'cfg' && inline ? inline.graph : graphFor(result, view, fnName)
  const selectedNode = graph?.nodes.find(n => n.id === selected)
  const file = project.files.find(f => f.path === active) ?? project.files[0]

  const q = query.trim().toLowerCase()
  const matches = q && graph
    ? new Set(graph.nodes.filter(n => `${n.label}\n${n.detail ?? ''}`.toLowerCase().includes(q)).map(n => n.id))
    : undefined
  const linked = new Set((graph?.nodes ?? []).filter(n => n.span?.file === file?.path).map(n => n.span!.line))

  const select = (node: GraphNode | undefined) => {
    setSelected(node?.id)
    const span = node?.span
    if (span && project.files.some(f => f.path === span.file)) setActive(span.file)
  }

  const graphsForLines = (): { graph: Graph; fn?: string }[] => {
    if (!result) return []
    if (view === 'calls' || view === 'includes' || (view === 'data' && fnName === PROGRAM)) return graph ? [{ graph }] : []
    return result.functions.map(f => ({ graph: f[view], fn: f.id }))
  }

  const onLine = (path: string, line: number) => {
    let best: { node: GraphNode; fn?: string; size: number } | undefined
    for (const { graph: g, fn: name } of graphsForLines()) {
      for (const node of g.nodes) {
        const s = node.span
        if (!s || s.file !== path || line < s.line || line > s.endLine) continue
        // Prefer the tightest span; entry nodes stand for the whole function signature.
        const size = (s.endLine - s.line) * 1000 + (node.kind === 'entry' ? 500 : 0) + (s.endColumn - s.column)
        if (!best || size < best.size) best = { node, size, ...(name ? { fn: name } : {}) }
      }
    }
    if (!best) { setSelected(undefined); return }
    if (best.fn) setFnName(best.fn)
    setSelected(best.node.id)
  }

  // Automatic layout (ELK) for data and include graphs; whole-program data is grouped by function.
  const groupOf = useMemo(() => {
    if (view === 'data' && fnName === PROGRAM && index) return (n: GraphNode) => index.fnOfNode.get(n.id)?.id
    return undefined
  }, [view, fnName, index])
  const layoutProps = view === 'includes'
    ? { layout: 'auto' as const, fallback: 'layered' as const, merge: true, direction: 'RIGHT' as const }
    : view === 'data'
      ? dataLayout === 'auto'
        ? { layout: 'auto' as const, fallback: 'sequence' as const, modelOrder: true, ...(groupOf ? { groupOf, groupKey: 'fn' } : {}) }
        : { layout: 'sequence' as const }
      : view === 'cfg' && inline && (cfgKeys.size || inline.blocks.size)
        ? { layout: 'auto' as const, fallback: 'layered' as const, modelOrder: true,
            groupKey: [blockMode, focusKey ?? '', ...[...cfgKeys].sort(), '|', ...[...inline.collapsed].sort()].join(','),
            onGroupToggle: (key: string) => inline.blocks.has(key) ? toggleBlock(key) : toggleInline(key),
            groupClass: (k: string) => inline.blocks.has(k) ? `call block-${inline.blockKind.get(k)}` : 'call',
            groupPath: (n: GraphNode) => inline.groups.path.get(n.id) ?? [], groupLabel: (k: string) => inline.groups.label.get(k) ?? k }
        : view === 'calls' && callGroups
          ? { layout: 'auto' as const, fallback: 'layered' as const, groupKey: [...expanded].sort().join(','), onGroupToggle: (key: string) => toggleExpanded(key),
              groupPath: (n: GraphNode) => callGroups.path.get(n.id) ?? [], groupLabel: (k: string) => callGroups.label.get(k) ?? k }
          : { layout: 'layered' as const }

  /** Inline (or remove) one callee at one call site; collapsing also drops expansions inside it. */
  const toggleInline = (key: string) => {
    if (!fn) return
    setInlined(all => {
      const next = new Map(all)
      const keys = new Set(next.get(fn.id) ?? [])
      if (keys.has(key)) {
        const site = key.slice(0, key.lastIndexOf('|'))
        for (const k of [...keys]) if (k === key || k.startsWith(`${site}>`)) keys.delete(k)
      } else keys.add(key)
      next.set(fn.id, keys)
      return next
    })
  }
  /** Collapse a block to one node, or expand it again. */
  const toggleBlock = (key: string) => {
    if (!fn) return
    setCollapsedBlocks(all => {
      const next = new Map(all)
      const keys = new Set(next.get(fn.id) ?? [])
      if (!keys.delete(key)) keys.add(key)
      next.set(fn.id, keys)
      return next
    })
  }

  /** + on a call statement: inline all its callees, or collapse them if all are open. */
  const toggleSite = (site: string) => {
    const callees = inline?.sites.get(site) ?? []
    const open = callees.filter(c => cfgKeys.has(inlineKey(site, c.id)))
    for (const c of open.length === callees.length ? open : callees.filter(c => !cfgKeys.has(inlineKey(site, c.id)))) toggleInline(inlineKey(site, c.id))
  }

  const toggleExpanded = (id: string) => setExpanded(open => {
    const next = new Set(open)
    if (!next.delete(id)) next.add(id)
    return next
  })

  /** Jump to a node in any view (or a source line), keeping the source pane in step. */
  const goTo = (target: Target) => {
    setMenu(undefined)
    if (target.view === 'source') {
      if (target.file) { setActive(target.file); setEditing(false); setFocus({ file: target.file, line: target.line ?? 1, at: Date.now() }) }
      return
    }
    setView(target.view)
    if (target.fn) setFnName(target.fn)
    setSelected(target.node)
    if (!target.node || !index) return
    setGraphFocus({ id: target.node, at: Date.now() })
    const node = index.fnOfNode.get(target.node)?.cfg.nodes.find(n => n.id === target.node)
      ?? index.result.calls.nodes.find(n => n.id === target.node) ?? index.result.includes.nodes.find(n => n.id === target.node)
    if (node?.span && project.files.some(f => f.path === node.span!.file)) {
      setActive(node.span.file); setEditing(false)
      setFocus({ file: node.span.file, line: node.span.line, at: Date.now() })
    }
  }

  /** Double-click: expand in place (call graph functions, call statements), or open a header. */
  const openNode = (id: string) => {
    const node = graph?.nodes.find(n => n.id === id)
    if (!node || !index) return
    if (view === 'calls' && index.fnById.has(id)) { toggleExpanded(id); return }
    if (view === 'cfg' && inline?.collapsed.has(id)) { toggleBlock(id); return }
    if (view === 'cfg' && inline?.sites.has(id)) { toggleSite(id); return }
    if (view === 'includes' && project.files.some(f => f.path === id)) { goTo({ view: 'source', file: id, line: 1 }); return }
    const callee = (node.calls ?? []).map(c => index.fnById.get(c)).find(Boolean)
    if (callee) goTo({ view: 'cfg', fn: callee.id, ...(callee.cfg.entry ? { node: callee.cfg.entry } : {}) })
  }

  /** Show only one block, rooted at its entry (or return to the whole function). */
  const refocusBlock = (key: string | undefined) => {
    if (!fn) return
    if (key && blockKeys.has(key)) toggleBlock(key)
    setBlockFocus(key ? { fn: fn.id, key } : undefined)
    const entry = key ? `${key}@entry` : fn.cfg.entry
    setSelected(entry)
    if (entry) setGraphFocus({ id: entry, at: Date.now() })
  }
  const runMenuAction = (item: Extract<MenuItem, { kind: 'action' }>) => {
    setMenu(undefined)
    if (item.action === 'expand' || item.action === 'collapse') {
      if (view !== 'cfg') toggleExpanded(item.id)
      else if (inline?.blocks.has(item.id)) toggleBlock(item.id)
      else toggleInline(item.id)
    }
    else if (item.action === 'zoom') setGraphFocus({ id: item.id, at: Date.now() })
    else if (item.action === 'focus-block') refocusBlock(item.id || undefined)
  }



  /** Right-click menu: jump targets plus in-graph expansion and refocusing. */
  const nodeMenu = (id: string): MenuItem[] => {
    if (!index || !graph) return []
    const fnSel = view === 'cfg' || view === 'data' ? (fnName === PROGRAM && view === 'data' ? PROGRAM : fn?.id) : undefined
    if (view === 'cfg' && inline) {
      const o = inline.origin.get(id)
      if (!o) return []
      const base = menuForNode(index, 'cfg', o.fn.id, o.fn.cfg, o.node.id, expanded)
        .map(i => i.kind === 'action' && i.action === 'zoom' ? { ...i, id } : i)
      const here: MenuItem[] = []
      for (const c of inline.sites.get(id) ?? []) {
        const key = inlineKey(id, c.id)
        here.push({ kind: 'action', label: `${cfgKeys.has(key) ? 'Collapse' : 'Expand'} ${c.name}() here`, action: cfgKeys.has(key) ? 'collapse' : 'expand', id: key })
        here.push({ kind: 'go', label: `Refocus on ${c.name}()`, target: { view: 'cfg', fn: c.id, ...(c.cfg.entry ? { node: c.cfg.entry } : {}) } })
      }
      if (inline.collapsed.has(id)) {
        here.push({ kind: 'action', label: `Expand block: ${inline.groups.label.get(id) ?? ''}`, action: 'expand', id })
        here.push({ kind: 'action', label: `Refocus on block: ${inline.groups.label.get(id) ?? ''}`, action: 'focus-block', id })
      }
      const chain = inline.groups.path.get(id) ?? []
      const block = [...chain].reverse().find(k => inline.blocks.has(k))
      if (block && !inline.collapsed.has(id)) {
        here.push({ kind: 'action', label: `Refocus on block: ${inline.groups.label.get(block) ?? ''}`, action: 'focus-block', id: block })
        here.push({ kind: 'action', label: `Collapse block: ${inline.groups.label.get(block) ?? ''}`, action: 'collapse', id: block })
      }
      if (inline.focused) here.push({ kind: 'action', label: `Back to ${fn?.name ?? 'function'}()`, action: 'focus-block', id: '' })
      if (o.fn.id !== fn?.id) {
        here.push({ kind: 'go', label: `Refocus on ${o.fn.name}()`, target: { view: 'cfg', fn: o.fn.id, node: o.node.id } })
        const box = [...chain].reverse().find(k => !inline.blocks.has(k))
        if (box) here.push({ kind: 'action', label: `Collapse ${o.fn.name}()`, action: 'collapse', id: box })
      }
      return here.length ? [base[0]!, { kind: 'section', label: 'In this graph' }, ...here, ...base.slice(1)] : base
    }
    const items = menuForNode(index, view, fnSel, graph, id, expanded)
    const owner = view === 'calls' ? index.fnOfNode.get(id) : undefined
    if (owner && expanded.has(owner.id)) {
      return [items[0]!, { kind: 'section', label: 'In this graph' }, { kind: 'action', label: `Collapse ${owner.name}()`, action: 'collapse', id: owner.id },
        { kind: 'go', label: `Refocus on ${owner.name}()`, target: { view: 'cfg', fn: owner.id, node: id } }, ...items.slice(1)]
    }
    return items
  }

  /** Read a project folder from disk (by absolute path) and analyze it. */
  const openPath = async (path: string, keepSettings = false) => {
    if (!path.trim()) return
    setError(undefined)
    try {
      const opened = await api.open(path)
      const next: Project = { ...(keepSettings ? project : emptyProject), root: opened.root, files: opened.files, ...(keepSettings ? {} : { units: [] }) }
      setProject(next)
      setPathInput(opened.root)
      rememberPath(opened.root)
      setActive(a => keepSettings && opened.files.some(f => f.path === a) ? a : pickEntry(opened.files))
      if (!keepSettings) { setSession({ name: opened.root.split('/').filter(Boolean).pop() ?? 'Untitled' }); setSelected(undefined) }
      setEditing(false)
      if (opened.skipped) setNotice(`Skipped ${opened.skipped} file${opened.skipped === 1 ? '' : 's'} over 4 MiB`)
      await run(next)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const browse = async () => {
    const picked = await window.lexeme?.pickDirectory()
    if (picked) { setPathInput(picked); await openPath(picked) }
  }

  const exportName = `${session.name.replace(/[^\w.-]+/g, '_')}-${view}${view === 'cfg' || view === 'data' ? `-${fn?.name ?? ''}` : ''}`
  const doExport = async (format: 'svg' | 'png' | 'json') => {
    if (!graph || !svg.current) return
    try {
      if (format === 'svg') exportSvg(svg.current, exportName)
      else if (format === 'png') await exportPng(svg.current, exportName)
      else exportJson(graph, exportName)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const save = async () => {
    try {
      const saved = await api.save({ ...(session.id ? { id: session.id } : {}), name: session.name, project, ...(result ? { result } : {}) })
      setSession({ id: saved.id, name: saved.name })
      setNotice(`Saved “${saved.name}”`)
      refreshSessions()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const open = async (id: string) => {
    try {
      const loaded = await api.session(id)
      setProject(loaded.project)
      if (loaded.project.root) setPathInput(loaded.project.root)
      setActive(pickEntry(loaded.project.files))
      setSession({ id: loaded.id, name: loaded.name })
      setSelected(undefined)
      if (loaded.result) {
        setResult(loaded.result)
        setAnalyzed(JSON.stringify(loaded.project))
        setFnName((loaded.result.functions.find(f => f.name === 'main') ?? loaded.result.functions[0])?.id)
      } else await run(loaded.project)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const sources = project.files.filter(f => f.path.endsWith('.c'))
  const errors = result?.diagnostics.filter(d => d.severity === 'error').length ?? 0
  const kinds = new Set(graph?.nodes.map(n => n.kind))

  return (
    <main className="app">
      <header className="toolbar">
        <form className="open-path" onSubmit={e => { e.preventDefault(); void openPath(pathInput) }}>
          <input value={pathInput} onChange={e => setPathInput(e.target.value)} placeholder="/path/to/c/project" aria-label="Project folder path" spellCheck={false} />
          <span className="joined">
            {window.lexeme && <button type="button" onClick={() => void browse()} title="Choose a folder">Browse…</button>}
            <button type="submit" disabled={!pathInput.trim() || busy} title="Open this folder">Open</button>
            <button type="button" onClick={() => project.root && void openPath(project.root, true)} disabled={!project.root || busy} title="Re-read files from disk and analyze" aria-label="Reload">↻</button>
          </span>
        </form>
        <span className="spacer" />
        {notice && <span className="notice" role="status">{notice}</span>}
        {(() => {
          const tone = busy ? 'busy' : stale ? 'stale' : error ? 'error' : result ? 'ok' : 'idle'
          const short = busy ? 'Analyzing…' : stale ? 'Source changed' : result
            ? `${result.units.length} unit${result.units.length === 1 ? '' : 's'} · ${errors} error${errors === 1 ? '' : 's'}`
            : error ? 'Not analyzed' : 'No project'
          const full = result
            ? `${result.units.length} unit${result.units.length === 1 ? '' : 's'}, ${result.units.every(u => u.preprocessed) ? 'preprocessed' : result.units.some(u => u.preprocessed) ? 'partly preprocessed' : 'unexpanded'}, analyzed on the ${result.runtime}, ${errors} error${errors === 1 ? '' : 's'}${stale ? ' (source changed since)' : ''}`
            : short
          return <span className={`status status-${tone}`} role="status" title={full}><span className="dot" aria-hidden="true" />{short}</span>
        })()}
        <details className="menu menu-right">
          <summary onClick={refreshSessions} title="Save or open sessions">{session.name === 'Untitled' ? 'Sessions' : session.name} ▾</summary>
          <div className="menu-body">
            <form className="menu-row" onSubmit={e => { e.preventDefault(); void save() }}>
              <input className="session-name" value={session.name} onChange={e => setSession(s => ({ ...s, name: e.target.value }))} aria-label="Session name" />
              <button type="submit" disabled={!project.files.length}>Save</button>
            </form>
            <div className="menu-label">Saved</div>
            {sessions.length === 0 && <p className="muted">No saved sessions.</p>}
            {sessions.map(s => (
              <div key={s.id} className="menu-row">
                <button className="link" onClick={e => { (e.currentTarget.closest('details') as HTMLDetailsElement).open = false; void open(s.id) }}>
                  {s.name}<span className="muted"> · {new Date(s.savedAt).toLocaleString()}</span>
                </button>
                <button aria-label={`Delete ${s.name}`} onClick={() => void api.remove(s.id).then(refreshSessions)}>✕</button>
              </div>
            ))}
          </div>
        </details>
        <button className="primary" onClick={() => void run(project)} disabled={busy || !project.files.length} title="Analyze (⌘/Ctrl+Enter)">
          {busy && slow ? <span className="spinner" aria-hidden="true" /> : null}Analyze
        </button>
      </header>
      {error && <div className="error-bar" role="alert"><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Dismiss">✕</button></div>}

      <div className="workspace" style={{ gridTemplateColumns: `${widths.tree}px 4px ${widths.source}px 4px minmax(0, 1fr)` }}>
        <aside className="pane tree-pane" aria-label="Files">
          <div className="pane-header">
            <h2>Files</h2>
            <span className="muted">{project.files.length || ''}</span>
          </div>
          <FileTree
            files={project.files}
            active={file?.path ?? ''}
            onOpen={path => { setActive(path); setEditing(false) }}
            onContext={(path, x, y) => { if (index) setMenu({ x, y, items: menuForFile(index, path) }) }}
            units={new Set(result?.units.map(u => u.file))}
            used={new Set([...(result?.units.map(u => u.file) ?? []), ...(result?.includes.nodes.filter(n => n.kind === 'file').map(n => n.id) ?? [])])}
            diagnostics={result?.diagnostics ?? []}
          />
        </aside>
        <div className="splitter" onPointerDown={drag('tree')} role="separator" aria-orientation="vertical" aria-label="Resize file browser" />
        <section className="pane" aria-labelledby="source-title">
          <div className="pane-header">
            <h2 id="source-title" className="file-path" title={file?.path}>{file ? file.path : 'Source'}</h2>
            <div className="actions">
              <button onClick={() => setEditing(!editing)} aria-pressed={editing} disabled={!file}>{editing ? 'Done' : 'Edit'}</button>
            </div>
          </div>
          <details className="settings">
            <summary>Build settings <span className="muted">· {project.units.length ? `${project.units.length} selected unit${project.units.length === 1 ? '' : 's'}` : 'all units'} · -std={project.std}</span></summary>
            <div className="settings-grid">
              <fieldset className="units">
                <legend>Translation units <span className="muted">(none checked: compile_commands.json, else every .c)</span></legend>
                {sources.map(f => (
                  <label key={f.path} className="check">
                    <input type="checkbox" checked={project.units.includes(f.path)}
                      onChange={e => setProject(p => ({ ...p, units: e.target.checked ? [...p.units, f.path] : p.units.filter(u => u !== f.path) }))} />
                    {f.path}
                  </label>
                ))}
              </fieldset>
              <label>Standard
                <select value={project.std} onChange={e => setProject(p => ({ ...p, std: e.target.value }))}>
                  {STDS.map(s => <option key={s}>{s}</option>)}
                </select>
              </label>
              <label>Include dirs <input value={project.includeDirs} placeholder="include src" onChange={e => setProject(p => ({ ...p, includeDirs: e.target.value }))} /></label>
              <label>Defines <input value={project.defines} placeholder="DEBUG LEVEL=2" onChange={e => setProject(p => ({ ...p, defines: e.target.value }))} /></label>
            </div>
            <p className="muted hint">A compile_commands.json in the project is applied automatically.</p>
          </details>
          <SourcePane
            files={project.files}
            active={file?.path ?? ''}
            editing={editing}
            onEdit={(path, text) => setProject(p => ({ ...p, files: p.files.map(f => f.path === path ? { ...f, text } : f) }))}
            highlight={selectedNode?.span}
            linked={linked}
            onLine={onLine}
            onLineContext={(path, line, x, y) => { if (index) setMenu({ x, y, items: menuForLine(index, path, line) }) }}
            diagnostics={result?.diagnostics ?? []}
            focus={focus}
          />
          {result && result.diagnostics.length > 0 && (
            <details className="diagnostics" open={errors > 0}>
              <summary>Diagnostics ({result.diagnostics.length})</summary>
              <ul>
                {result.diagnostics.map((d, i) => (
                  <li key={i} className={`diag diag-${d.severity}`}>
                    <button className="link" disabled={!d.span} onClick={() => {
                      if (!d.span) return
                      setActive(d.span.file); setEditing(false); setFocus({ file: d.span.file, line: d.span.line, at: Date.now() })
                    }}>
                      <b>{d.severity}</b> <span className="muted">{d.stage}{d.span ? ` · ${d.span.file}:${d.span.line}:${d.span.column}` : ''}</span>
                      <span className="diag-message">{d.message}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
        <div className="splitter" onPointerDown={drag('source')} role="separator" aria-orientation="vertical" aria-label="Resize source pane" />

        <section className="pane graph-pane" aria-labelledby="graph-title">
          <div className="pane-header">
            <h2 id="graph-title" className="sr-only">Graph</h2>
            <div className="tabs" role="tablist" aria-label="Graph view">
              {VIEWS.map(v => (
                <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? 'active' : ''}
                  onClick={() => { setView(v.id); setSelected(undefined) }}>{v.label}</button>
              ))}
            </div>
            <div className="actions">
              {(view === 'cfg' || view === 'data') && result && result.functions.length > 0 && (
                <select value={view === 'data' && fnName === PROGRAM ? PROGRAM : fn?.id} onChange={e => { setFnName(e.target.value); setSelected(undefined) }} aria-label="Function">
                  {view === 'data' && <option value={PROGRAM}>Whole program</option>}
                  {result.functions.map(f => <option key={f.id} value={f.id}>{f.signature}{result.units.length > 1 || f.static ? ` · ${f.file}` : ''}</option>)}
                </select>
              )}
              {view === 'cfg' && inline?.focused && (
                <span className="crumb" title="Control flow refocused on one block">
                  <button className="link" onClick={() => refocusBlock(undefined)}>{fn?.name}()</button> › <code>{inline.focused.label}</code>
                  <button onClick={() => refocusBlock(undefined)} aria-label="Back to the whole function">✕</button>
                </span>
              )}
              {view === 'cfg' && (
                <div className="segmented" role="group" aria-label="Block grouping" title="Box loops, branches, switches, and straight-line runs. Complex: blocks scoring ≥ 8 (nodes + 2 × conditions) and runs of 4+ statements.">
                  {(['off', 'complex', 'all'] as const).map(m => (
                    <button key={m} aria-pressed={blockMode === m} onClick={() => setBlockMode(m)}>{m === 'off' ? 'No blocks' : m === 'complex' ? 'Complex blocks' : 'All blocks'}</button>
                  ))}
                </div>
              )}
              {view === 'data' && (
                <div className="segmented" role="group" aria-label="Data layout">
                  <button aria-pressed={dataLayout === 'auto'} onClick={() => setDataLayout('auto')} title="Automatic layered layout (ELK)">Auto</button>
                  <button aria-pressed={dataLayout === 'order'} onClick={() => setDataLayout('order')} title="Statements in program order with dependency arcs">Program order</button>
                </div>
              )}
              <input className="search" type="search" placeholder="Search nodes" value={query} onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key !== 'Enter' || !matches?.size || !graph) return
                  const ids = graph.nodes.filter(n => matches.has(n.id)).map(n => n.id)
                  const next = ids[(ids.indexOf(selected ?? '') + 1) % ids.length]
                  select(graph.nodes.find(n => n.id === next))
                }}
                aria-label="Search nodes; Enter selects the next match" />
              <details className="menu menu-right">
                <summary aria-disabled={!graph}>Export</summary>
                <div className="menu-body" onClick={e => { (e.currentTarget.closest('details') as HTMLDetailsElement).open = false }}>
                  <button className="link" onClick={() => void doExport('svg')} disabled={!graph}>SVG image</button>
                  <button className="link" onClick={() => void doExport('png')} disabled={!graph}>PNG image</button>
                  <button className="link" onClick={() => void doExport('json')} disabled={!graph}>Graph JSON</button>
                </div>
              </details>
            </div>
          </div>
          <div className="canvas">
            {graph && graph.nodes.length > 0
              ? <GraphView graph={graph} selected={selected} matches={matches} svgRef={svg} {...layoutProps}
                  onSelect={id => select(graph.nodes.find(n => n.id === id))} onOpen={openNode}
                  onContext={(id, x, y) => setMenu({ x, y, items: nodeMenu(id) })}
                  focus={graphFocus}
                  {...(view === 'calls' ? { expandable: new Set(result?.functions.map(f => f.id)), expanded, onToggle: toggleExpanded } : {})}
                  {...(view === 'cfg' && inline ? {
                    expandable: new Set([...inline.sites.keys(), ...inline.collapsed]),
                    expanded: new Set([...inline.sites].filter(([site, cs]) => cs.every(c => cfgKeys.has(inlineKey(site, c.id)))).map(([site]) => site)),
                    onToggle: (id: string) => inline.collapsed.has(id) ? toggleBlock(id) : toggleSite(id),
                  } : {})} />
              : <div className="empty">
                  <p className="muted">{busy ? 'Analyzing…' : !result ? 'Open a project folder by path to begin.' : view === 'data' ? 'No data dependencies between local variables in this function.' : 'Nothing to show for this view.'}</p>
                </div>}
          </div>
          <div className="detail-bar">
            {selectedNode ? (
              <>
                <span className="kind">{styleOf(selectedNode.kind).label}</span>
                <code className="detail-code">{selectedNode.label}</code>
                {selectedNode.span && <span className="muted">{selectedNode.span.file}:{selectedNode.span.line}</span>}
                {selectedNode.detail && <span className="muted">{selectedNode.detail}</span>}
                {view === 'calls' && index?.fnById.has(selectedNode.id) && <>
                  <button onClick={() => toggleExpanded(selectedNode.id)}>{expanded.has(selectedNode.id) ? 'Collapse' : 'Expand here'}</button>
                  <button onClick={() => goTo({ view: 'cfg', fn: selectedNode.id, ...(index.fnById.get(selectedNode.id)?.cfg.entry ? { node: index.fnById.get(selectedNode.id)!.cfg.entry! } : {}) })}>Open control flow</button>
                </>}
                <span className="muted hint">Right-click for more</span>
              </>
            ) : (
              <span className="legend" aria-label="Legend">
                {VIEW_KINDS[view].filter(k => kinds.has(k)).map(kind => (
                  <span key={kind} className="legend-item">
                    <svg width="26" height="14" aria-hidden="true"><style>{'.shape{fill:#1b2840;stroke:#6f93d0}'}</style>
                      <g className={`node k-${kind}`}><NodeShape shape={styleOf(kind).shape} width={26} height={14} /></g></svg>
                    {styleOf(kind).label}
                  </span>
                ))}
                {view === 'data' && DATA_EDGES.filter(e => graph?.edges.some(g => g.kind === e.kind)).map(e => (
                  <span key={e.kind} className="legend-item"><svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" className={`legend-edge edge-${e.kind}`} /></svg>{e.label}</span>
                ))}
                <span className="muted hint">{view === 'calls'
                  ? <>Double-click or <b>+</b> expands a function in place{expanded.size ? <> · <button className="inline" onClick={() => setExpanded(new Set())}>collapse all</button></> : null}. Right-click to jump to other views.</>
                  : view === 'includes' ? 'Double-click a project file to view it. Right-click to jump.'
                  : view === 'cfg' ? <>Double-click or <b>+</b> on a call inlines the callee here{cfgKeys.size ? <> · <button className="inline" onClick={() => fn && setInlined(m => new Map(m).set(fn.id, new Set()))}>collapse all</button></> : null}. Right-click to refocus or jump. Drag to pan; ⌘/Ctrl+scroll, +/−, F, Z to zoom.</>
                  : 'Right-click a node or source line to jump between views. Drag to pan; ⌘/Ctrl+scroll, +/−, F, Z to zoom.'}</span>
              </span>
            )}
          </div>
        </section>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onGo={goTo} onAction={runMenuAction} onClose={() => setMenu(undefined)} />}
      <footer>
        <span>{graph ? `${graph.title}: ${graph.nodes.length} nodes, ${graph.edges.length} edges` : 'No graph'}</span>
        <span>{project.files.length} file{project.files.length === 1 ? '' : 's'}{file ? ` · ${file.path} · ${file.text.split('\n').length} lines` : ''}</span>
      </footer>
    </main>
  )
}
