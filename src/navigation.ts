import type { AnalysisResult, FunctionAnalysis, Graph, GraphNode, Region } from '../shared/graph.ts'

export type View = 'cfg' | 'calls' | 'includes' | 'data'
export const PROGRAM = '__program__'

/** A place to jump to: a view (with function and node), or a source line. */
export interface Target {
  view: View | 'source'
  fn?: string
  node?: string
  file?: string
  line?: number
}

export type MenuItem =
  | { kind: 'go'; label: string; target: Target; current?: boolean }
  | { kind: 'action'; label: string; action: 'expand' | 'collapse' | 'zoom' | 'fit' | 'focus-block'; id: string }
  | { kind: 'section'; label: string }

/** Lookup tables over one analysis result. */
export interface Index {
  result: AnalysisResult
  fnOfNode: Map<string, FunctionAnalysis>
  fnById: Map<string, FunctionAnalysis>
  /** callee call-graph id → call sites (statement nodes) that call it */
  callers: Map<string, { fn: FunctionAnalysis; node: GraphNode }[]>
  programIds: Set<string>
}

export function buildIndex(result: AnalysisResult): Index {
  const fnOfNode = new Map<string, FunctionAnalysis>()
  const callers = new Map<string, { fn: FunctionAnalysis; node: GraphNode }[]>()
  for (const fn of result.functions) {
    for (const node of fn.cfg.nodes) {
      fnOfNode.set(node.id, fn)
      for (const callee of node.calls ?? []) callers.set(callee, [...(callers.get(callee) ?? []), { fn, node }])
    }
  }
  return {
    result, fnOfNode, callers,
    fnById: new Map(result.functions.map(f => [f.id, f])),
    programIds: new Set(result.program.nodes.map(n => n.id)),
  }
}

const where = (node: GraphNode) => node.span ? ` · ${node.span.file.split('/').pop()}:${node.span.line}` : ''
const short = (text: string, max = 48) => text.length > max ? `${text.slice(0, max - 1)}…` : text

function entryOf(fn: FunctionAnalysis): string | undefined { return fn.cfg.entry }

/** Everywhere a CFG/data node can be shown. */
function statementTargets(ix: Index, fn: FunctionAnalysis, node: GraphNode, here: Target): MenuItem[] {
  const items: MenuItem[] = [{ kind: 'section', label: short(node.label) }]
  const is = (t: Target) => t.view === here.view && (t.fn ?? '') === (here.fn ?? '') && t.node === here.node
  const go = (label: string, target: Target) => items.push({ kind: 'go', label, target, current: is(target) })
  go('Control flow', { view: 'cfg', fn: fn.id, node: node.id })
  if (fn.data.nodes.some(n => n.id === node.id)) go('Data dependencies', { view: 'data', fn: fn.id, node: node.id })
  if (ix.programIds.has(node.id)) go('Whole-program data', { view: 'data', fn: PROGRAM, node: node.id })
  go(`Call graph: ${fn.id}`, { view: 'calls', node: fn.id })
  const file = node.span?.file ?? fn.file
  if (ix.result.includes.nodes.some(n => n.id === file)) go(`Includes: ${file}`, { view: 'includes', node: file })
  if (node.span) go(`Source${where(node)}`, { view: 'source', file: node.span.file, line: node.span.line })
  const callees = node.calls ?? []
  if (callees.length) {
    items.push({ kind: 'section', label: 'Calls from here' })
    for (const id of callees) {
      const callee = ix.fnById.get(id)
      if (callee) go(`${callee.signature}`, { view: 'cfg', fn: callee.id, ...(entryOf(callee) ? { node: entryOf(callee)! } : {}) })
      else go(`${id} (external)`, { view: 'calls', node: id })
    }
  }
  if (node.kind === 'entry') items.push(...callerItems(ix, fn.id))
  return items
}

function callerItems(ix: Index, calleeId: string): MenuItem[] {
  const sites = ix.callers.get(calleeId) ?? []
  if (!sites.length) return []
  const items: MenuItem[] = [{ kind: 'section', label: `Called from (${sites.length})` }]
  for (const { fn, node } of sites.slice(0, 30)) {
    items.push({ kind: 'go', label: `${fn.id}: ${short(node.label, 36)}${where(node)}`, target: { view: 'cfg', fn: fn.id, node: node.id } })
  }
  return items
}

/** Context menu for a node in the current graph. */
export function menuForNode(ix: Index, view: View, fnSelection: string | undefined, graph: Graph, nodeId: string, expanded: Set<string>): MenuItem[] {
  const node = graph.nodes.find(n => n.id === nodeId)
  if (!node) return []
  const here: Target = { view, ...(fnSelection ? { fn: fnSelection } : {}), node: nodeId }
  const zoom: MenuItem = { kind: 'action', label: 'Zoom to node', action: 'zoom', id: nodeId }
  const owner = ix.fnOfNode.get(nodeId)
  if (owner) return [...statementTargets(ix, owner, node, here), { kind: 'section', label: 'View' }, zoom]

  if (view === 'calls') {
    const fn = ix.fnById.get(nodeId)
    const items: MenuItem[] = [{ kind: 'section', label: node.label }]
    if (fn) {
      const entry = entryOf(fn)
      items.push(
        { kind: 'action', label: expanded.has(fn.id) ? 'Collapse here' : 'Expand here', action: expanded.has(fn.id) ? 'collapse' : 'expand', id: fn.id },
        { kind: 'go', label: 'Control flow', target: { view: 'cfg', fn: fn.id, ...(entry ? { node: entry } : {}) } },
        { kind: 'go', label: 'Data dependencies', target: { view: 'data', fn: fn.id } },
      )
      if (entry && ix.programIds.has(entry)) items.push({ kind: 'go', label: 'Whole-program data', target: { view: 'data', fn: PROGRAM, node: entry } })
      if (ix.result.includes.nodes.some(n => n.id === fn.file)) items.push({ kind: 'go', label: `Includes: ${fn.file}`, target: { view: 'includes', node: fn.file } })
      if (fn.span) items.push({ kind: 'go', label: `Source${where(node)}`, target: { view: 'source', file: fn.span.file, line: fn.span.line } })
    }
    return [...items, ...callerItems(ix, nodeId), { kind: 'section', label: 'View' }, zoom]
  }

  if (view === 'includes') {
    const items: MenuItem[] = [{ kind: 'section', label: node.label }]
    if (ix.result.files.some(f => f.path === nodeId)) items.push({ kind: 'go', label: 'Source', target: { view: 'source', file: nodeId, line: 1 } })
    const defined = ix.result.functions.filter(f => f.file === nodeId)
    if (defined.length) {
      items.push({ kind: 'section', label: `Functions defined here (${defined.length})` })
      for (const fn of defined.slice(0, 40)) {
        const entry = entryOf(fn)
        items.push({ kind: 'go', label: fn.signature, target: { view: 'cfg', fn: fn.id, ...(entry ? { node: entry } : {}) } })
      }
    }
    return [...items, { kind: 'section', label: 'View' }, zoom]
  }
  return [zoom]
}

/** Context menu for a source line: every view that has something at that line. */
export function menuForLine(ix: Index, file: string, line: number): MenuItem[] {
  const covering = (nodes: GraphNode[]) => nodes
    .filter(n => n.span && n.span.file === file && line >= n.span.line && line <= n.span.endLine)
    .sort((a, b) => (a.span!.endLine - a.span!.line) - (b.span!.endLine - b.span!.line) || Number(a.kind === 'entry') - Number(b.kind === 'entry'))[0]
  const items: MenuItem[] = [{ kind: 'section', label: `${file.split('/').pop()}:${line}` }]
  let best: { fn: FunctionAnalysis; node: GraphNode } | undefined
  for (const fn of ix.result.functions) {
    const node = covering(fn.cfg.nodes)
    if (node && (!best || (node.span!.endLine - node.span!.line) < (best.node.span!.endLine - best.node.span!.line))) best = { fn, node }
  }
  if (best) items.push(...statementTargets(ix, best.fn, best.node, { view: 'source' }).slice(1).filter(i => !(i.kind === 'go' && i.target.view === 'source')))
  else if (ix.result.includes.nodes.some(n => n.id === file)) items.push({ kind: 'go', label: `Includes: ${file}`, target: { view: 'includes', node: file } })
  return items.length > 1 ? items : [...items, { kind: 'section', label: 'Nothing analyzed on this line' }]
}

/** Call graph with some functions expanded in place into their control flow. Calls made
 * by an expanded function start at the statements that make them; calls into it land on
 * its entry. */
export function expandCallGraph(ix: Index, expanded: Set<string>): Graph {
  const calls = ix.result.calls
  if (!expanded.size) return calls
  const open = [...expanded].map(id => ix.fnById.get(id)).filter((f): f is FunctionAnalysis => !!f)
  const openIds = new Set(open.map(f => f.id))
  const into = (id: string) => openIds.has(id) ? ix.fnById.get(id)!.cfg.entry! : id
  const nodes: GraphNode[] = calls.nodes.filter(n => !openIds.has(n.id))
  const edges = calls.edges.filter(e => !openIds.has(e.source)).map(e => ({ ...e, target: into(e.target) }))
  for (const fn of open) {
    nodes.push(...fn.cfg.nodes)
    edges.push(...fn.cfg.edges)
    for (const node of fn.cfg.nodes) {
      for (const callee of node.calls ?? []) if (calls.nodes.some(n => n.id === callee)) edges.push({ source: node.id, target: into(callee), kind: 'call' })
    }
  }
  const entry = calls.entry && openIds.has(calls.entry) ? into(calls.entry) : calls.entry
  return { ...calls, ...(entry ? { entry } : {}), nodes, edges }
}

/** Group boxes for an expanded call graph: each expanded function's nodes share a box. */
export function callGraphGroups(ix: Index, expanded: Set<string>): Groups {
  const path = new Map<string, string[]>()
  const label = new Map<string, string>()
  for (const id of expanded) {
    const fn = ix.fnById.get(id)
    if (!fn) continue
    label.set(id, fn.signature)
    for (const n of fn.cfg.nodes) path.set(n.id, [id])
  }
  return { path, label }
}

export interface Groups { path: Map<string, string[]>; label: Map<string, string> }

/** Which structured blocks to box: none, only complex ones, or all. */
export type BlockMode = 'off' | 'complex' | 'all'

/** Rough complexity heuristic. Score = nodes + 2 × conditions inside the block. */
export function showRegion(region: Region, mode: BlockMode): boolean {
  if (mode === 'off') return false
  if (region.kind === 'lines') return region.nodes.length >= (mode === 'all' ? 3 : 4)
  return mode === 'all' || region.score >= 8
}

/** A control-flow graph with some calls inlined in place. */
export interface InlinedCfg {
  graph: Graph
  groups: Groups
  /** Group keys that are blocks (collapsible to one node), as opposed to inlined calls. */
  blocks: Set<string>
  /** Collapsed blocks currently shown as a single node (node id = block key). */
  collapsed: Set<string>
  /** Entry node of each expanded block (blocks are drawn like inlined functions). */
  blockEntry: Map<string, string>
  /** Set when the view is refocused on one block. */
  focused?: { key: string; label: string }
  blockKind: Map<string, Region['kind']>
  /** Composite node id → the function and node it came from. */
  origin: Map<string, { fn: FunctionAnalysis; node: GraphNode }>
  /** Call statements whose callees can be inlined, with those callees. */
  sites: Map<string, FunctionAnalysis[]>
}

/** Expansion key for inlining `callee` at composite call statement `site`. */
export const inlineKey = (site: string, callee: string) => `${site}|${callee}`

/** Inline expanded calls into a function's control flow. Inlined nodes get ids prefixed
 * with their call site (`site>node`), so a callee can be expanded at several sites and
 * inside other expansions. Like an interprocedural CFG: the call statement flows into
 * the callee's entry, and the callee's returns flow on to the call's successors.
 * Recursive calls are not inlined again. */
export function inlineCalls(ix: Index, fnId: string, keys: Set<string>, mode: BlockMode = 'off', collapsedKeys: Set<string> = new Set(), focusBlock?: string): InlinedCfg | undefined {
  const root = ix.fnById.get(fnId)
  if (!root) return undefined
  const nodes: GraphNode[] = []
  const edges: Graph['edges'] = []
  const origin = new Map<string, { fn: FunctionAnalysis; node: GraphNode }>()
  const path = new Map<string, string[]>()
  const label = new Map<string, string>()
  const sites = new Map<string, FunctionAnalysis[]>()
  const blocks = new Set<string>()
  const blockKind = new Map<string, Region['kind']>()

  /** Visible blocks containing a node, outermost first. */
  const blockChain = (fn: FunctionAnalysis) => {
    const visible = (fn.cfg.regions ?? []).filter(r => showRegion(r, mode))
    const byId = new Map((fn.cfg.regions ?? []).map(r => [r.id, r]))
    const shown = new Set(visible.map(r => r.id))
    const innermost = new Map<string, Region>()
    for (const r of [...visible].sort((a, b) => b.nodes.length - a.nodes.length)) for (const n of r.nodes) innermost.set(n, r)
    return (nodeId: string): Region[] => {
      const chain: Region[] = []
      for (let r = innermost.get(nodeId); r; r = r.parent ? byId.get(r.parent) : undefined) if (shown.has(r.id)) chain.unshift(r)
      return chain
    }
  }

  const inline = (fn: FunctionAnalysis, prefix: string, groups: string[], stack: string[]) => {
    const id = (raw: string) => prefix + raw
    const chainOf = blockChain(fn)
    for (const n of fn.cfg.nodes) {
      nodes.push({ ...n, id: id(n.id) })
      origin.set(id(n.id), { fn, node: n })
      const chain = chainOf(n.id)
      for (const r of chain) { blocks.add(prefix + r.id); blockKind.set(prefix + r.id, r.kind); label.set(prefix + r.id, r.label) }
      path.set(id(n.id), [...groups, ...chain.map(r => prefix + r.id)])
    }
    for (const n of fn.cfg.nodes) {
      const site = id(n.id)
      const callees = (n.calls ?? []).map(c => ix.fnById.get(c)).filter((g): g is FunctionAnalysis => !!g && !stack.includes(g.id))
      if (callees.length) sites.set(site, callees)
      const outs = fn.cfg.edges.filter(e => e.source === n.id)
      const open = callees.filter(g => keys.has(inlineKey(site, g.id)))
      let exits = [site]
      for (const g of open) {
        const key = inlineKey(site, g.id)
        const childPrefix = `${site}>`
        label.set(key, g.signature)
        inline(g, childPrefix, [...(path.get(site) ?? groups), key], [...stack, g.id])
        for (const from of exits) edges.push({ source: from, target: childPrefix + g.cfg.entry, kind: 'call' })
        const returns = g.cfg.nodes.filter(m => m.kind === 'return').map(m => childPrefix + m.id)
        // Void functions may fall off the end: their exits are nodes without successors.
        const ends = returns.length ? returns : g.cfg.nodes.filter(m => !g.cfg.edges.some(e => e.source === m.id)).map(m => childPrefix + m.id)
        exits = ends
      }
      for (const e of outs) {
        for (const from of exits) {
          edges.push(from === site ? { ...e, source: site, target: id(e.target) } : { ...e, source: from, target: id(e.target), kind: e.kind ?? 'return' })
        }
      }
    }
  }
  inline(root, '', [], [root.id])

  // Collapse blocks into single nodes, outermost first (inner ones vanish with them).
  const collapsed = new Set<string>()
  let shownNodes = nodes
  let shownEdges = edges
  const depth = (key: string) => Math.min(...shownNodes.filter(n => path.get(n.id)?.includes(key)).map(n => path.get(n.id)!.indexOf(key)))
  for (const key of [...collapsedKeys].filter(k => blocks.has(k)).sort((a, b) => depth(a) - depth(b))) {
    const members = shownNodes.filter(n => path.get(n.id)?.includes(key))
    if (!members.length) continue
    collapsed.add(key)
    const memberIds = new Set(members.map(n => n.id))
    const first = [...members].sort((a, b) => (a.span?.line ?? 0) - (b.span?.line ?? 0))[0]!
    const outer = path.get(first.id)!.slice(0, path.get(first.id)!.indexOf(key))
    const lines = members.map(n => n.span?.line).filter((l): l is number => l !== undefined)
    const summary: GraphNode = {
      id: key, kind: 'block', label: `${label.get(key) ?? 'block'} ⋯ ${members.length}`,
      ...(first.span ? { span: { ...first.span, line: Math.min(...lines), endLine: Math.max(...lines) } } : {}),
      detail: `${members.length} nodes collapsed${lines.length ? ` (lines ${Math.min(...lines)}–${Math.max(...lines)})` : ''}`,
    }
    path.set(key, outer)
    origin.set(key, origin.get(first.id)!)
    const remap = (n: string) => memberIds.has(n) ? key : n
    const seen = new Set<string>()
    shownEdges = shownEdges.flatMap(e => {
      const edge = { ...e, source: remap(e.source), target: remap(e.target) }
      if (edge.source === key && edge.target === key) return []
      const k = `${edge.source}\n${edge.target}\n${edge.label ?? ''}`
      if (seen.has(k)) return []
      seen.add(k)
      return [edge]
    })
    shownNodes = [...shownNodes.filter(n => !memberIds.has(n.id)), summary]
    for (const m of memberIds) sites.delete(m)
  }
  // Expanded blocks act like inlined functions: an entry node (the block's header) inside
  // the box receives every edge entering the block, and flows to the block's first nodes.
  // Edges leaving the block leave from inside it, like returns. Outer blocks go first, so
  // nested entries chain: outer entry → inner entry → first statement.
  const blockEntry = new Map<string, string>()
  const depthOf = (key: string) => Math.min(...shownNodes.filter(n => path.get(n.id)?.includes(key)).map(n => path.get(n.id)!.indexOf(key)))
  const open = [...blocks].filter(k => !collapsed.has(k) && shownNodes.some(n => path.get(n.id)?.includes(k))).sort((a, b) => depthOf(a) - depthOf(b))
  for (const key of open) {
    const members = new Set(shownNodes.filter(n => path.get(n.id)?.includes(key)).map(n => n.id))
    const entryId = `${key}@entry`
    const first = shownNodes.filter(n => members.has(n.id) && n.span).sort((a, b) => a.span!.line - b.span!.line || a.span!.column - b.span!.column)[0]
    const lines = shownNodes.filter(n => members.has(n.id)).map(n => n.span?.line).filter((l): l is number => l !== undefined)
    const memberPath = path.get([...members][0]!)!
    path.set(entryId, memberPath.slice(0, memberPath.indexOf(key) + 1))
    if (first) origin.set(entryId, origin.get(first.id)!)
    shownNodes = [...shownNodes, {
      id: entryId, kind: 'entry', label: label.get(key) ?? 'block',
      ...(first?.span && lines.length ? { span: { ...first.span, line: Math.min(...lines), endLine: Math.max(...lines) } } : {}),
      detail: `block · ${members.size} nodes`,
    }]
    const targets = new Set<string>()
    shownEdges = shownEdges.map(e => {
      if (!members.has(e.target) || members.has(e.source)) return e
      targets.add(e.target)
      return { ...e, target: entryId }
    })
    for (const t of targets) shownEdges.push({ source: entryId, target: t })
    blockEntry.set(key, entryId)
  }

  // Refocus on one block: just its nodes, rooted at its entry, with leaving edges ending
  // at an exit node.
  let focused: InlinedCfg['focused']
  if (focusBlock && blockEntry.has(focusBlock)) {
    const inside = new Set(shownNodes.filter(n => path.get(n.id)?.includes(focusBlock)).map(n => n.id))
    const exitId = `${focusBlock}@exit`
    const leaving = shownEdges.filter(e => inside.has(e.source) && !inside.has(e.target))
    shownNodes = [...shownNodes.filter(n => inside.has(n.id)), ...(leaving.length ? [{ id: exitId, kind: 'return', label: 'exit block' }] : [])]
    const seen = new Set<string>()
    shownEdges = [
      ...shownEdges.filter(e => inside.has(e.source) && inside.has(e.target)),
      ...leaving.flatMap(e => {
        const k = `${e.source}\n${e.label ?? ''}`
        if (seen.has(k)) return []
        seen.add(k)
        return [{ ...e, target: exitId }]
      }),
    ]
    // The whole view is this block: drop its own box and everything outside it.
    for (const id of inside) { const p = path.get(id)!; path.set(id, p.slice(p.indexOf(focusBlock) + 1)) }
    path.set(exitId, [])
    focused = { key: focusBlock, label: label.get(focusBlock) ?? 'block' }
  }

  const entry = focused ? blockEntry.get(focused.key)! : root.cfg.entry
  // Same id as the plain graph, so expanding keeps the current zoom instead of refitting.
  return {
    graph: { ...root.cfg, ...(entry ? { entry } : {}), nodes: shownNodes, edges: shownEdges },
    groups: { path, label }, blocks, blockKind, collapsed, blockEntry, ...(focused ? { focused } : {}), origin, sites,
  }
}

/** Context menu for a file in the file browser. */
export function menuForFile(ix: Index, file: string): MenuItem[] {
  const items: MenuItem[] = [{ kind: 'section', label: file }]
  items.push({ kind: 'go', label: 'Source', target: { view: 'source', file, line: 1 } })
  if (ix.result.includes.nodes.some(n => n.id === file)) items.push({ kind: 'go', label: 'Include graph', target: { view: 'includes', node: file } })
  const defined = ix.result.functions.filter(f => f.file === file)
  if (defined.length) {
    items.push({ kind: 'section', label: `Functions (${defined.length})` })
    for (const fn of defined.slice(0, 60)) items.push({ kind: 'go', label: fn.signature, target: { view: 'cfg', fn: fn.id, ...(fn.cfg.entry ? { node: fn.cfg.entry } : {}) } })
  }
  return items
}
