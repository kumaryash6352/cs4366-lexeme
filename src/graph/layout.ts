import type { Graph, GraphEdge, GraphNode } from '../../shared/graph.ts'

export interface PlacedNode { node: GraphNode; x: number; y: number; width: number; height: number; label: string }
export interface PlacedEdge { edge: GraphEdge; path: string; back: boolean; labelAt?: { x: number; y: number } }
/** A box drawn behind a set of nodes. `key` identifies it to the caller (e.g. to collapse it). */
export interface PlacedGroup { id: string; key: string; label: string; x: number; y: number; width: number; height: number }
export interface Layout { nodes: Map<string, PlacedNode>; edges: PlacedEdge[]; width: number; height: number; groups?: PlacedGroup[] }

const NODE_HEIGHT = 34
const ROW_GAP = 50
const COL_GAP = 26
const CHAR_WIDTH = 7.3
const MAX_CHARS = 40
const MARGIN = 32

/** Label text and box size shared by every layout engine. */
export function nodeBox(node: GraphNode): { label: string; width: number; height: number } {
  const label = shorten(node.label)
  return { label, width: Math.max(84, label.length * CHAR_WIDTH + (node.kind === 'condition' ? 44 : 26)), height: NODE_HEIGHT }
}

function shorten(text: string): string {
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text
}

/** Layered top-down layout: DFS splits back edges, longest-path ranks, parent-barycenter x. */
export function layoutGraph(graph: Graph): Layout {
  const out = new Map<string, GraphEdge[]>()
  for (const edge of graph.edges) out.set(edge.source, [...(out.get(edge.source) ?? []), edge])
  const byId = new Map(graph.nodes.map(node => [node.id, node]))

  const back = new Set<GraphEdge>()
  const order: string[] = []
  const state = new Map<string, 'open' | 'done'>()
  // Iterative DFS so deep graphs cannot overflow the stack.
  const visit = (root: string) => {
    const stack: { id: string; edges: GraphEdge[]; i: number }[] = []
    const enter = (id: string) => {
      state.set(id, 'open')
      // DFS order is reversed into ranks, so visit siblings last-to-first; true branches end up left.
      const edges = [...(out.get(id) ?? [])].reverse().sort((a, b) => Number(a.kind === 'true') - Number(b.kind === 'true'))
      stack.push({ id, edges, i: 0 })
    }
    enter(root)
    while (stack.length) {
      const top = stack[stack.length - 1]!
      const edge = top.edges[top.i++]
      if (!edge) { state.set(top.id, 'done'); order.unshift(top.id); stack.pop(); continue }
      if (!byId.has(edge.target)) continue
      const seen = state.get(edge.target)
      if (seen === 'open') back.add(edge)
      else if (!seen) enter(edge.target)
    }
  }
  if (graph.entry && byId.has(graph.entry)) visit(graph.entry)
  for (const node of graph.nodes) if (!state.has(node.id)) visit(node.id)

  const rank = new Map<string, number>(order.map(id => [id, 0]))
  for (const id of order) {
    for (const edge of out.get(id) ?? []) {
      if (!back.has(edge) && byId.has(edge.target)) rank.set(edge.target, Math.max(rank.get(edge.target) ?? 0, (rank.get(id) ?? 0) + 1))
    }
  }
  const parents = new Map<string, string[]>()
  for (const edge of graph.edges) if (!back.has(edge)) parents.set(edge.target, [...(parents.get(edge.target) ?? []), edge.source])
  const rows: string[][] = []
  for (const id of order) (rows[rank.get(id) ?? 0] ??= []).push(id)

  const placed = new Map<string, PlacedNode>()
  rows.forEach((row, r) => {
    const items = (row ?? []).flatMap(id => {
      const node = byId.get(id)
      if (!node) return []
      const label = shorten(node.label)
      const width = Math.max(84, label.length * CHAR_WIDTH + (node.kind === 'condition' ? 44 : 26))
      const xs = (parents.get(id) ?? []).map(p => placed.get(p)?.x).filter((x): x is number => x !== undefined)
      const want = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
      return [{ node, label, width, want }]
    })
    items.sort((a, b) => a.want - b.want)
    // Push right only, so single-parent chains stay vertical.
    let right = -Infinity
    for (const item of items) {
      const x = Math.max(item.want, right + COL_GAP + item.width / 2)
      right = x + item.width / 2
      placed.set(item.node.id, { node: item.node, label: item.label, width: item.width, height: NODE_HEIGHT, x, y: r * (NODE_HEIGHT + ROW_GAP) })
    }
  })

  let minX = Infinity, maxX = -Infinity, maxY = 0
  for (const p of placed.values()) {
    minX = Math.min(minX, p.x - p.width / 2)
    maxX = Math.max(maxX, p.x + p.width / 2)
    maxY = Math.max(maxY, p.y + p.height)
  }
  if (!Number.isFinite(minX)) { minX = 0; maxX = 0 }
  for (const p of placed.values()) { p.x += MARGIN - minX; p.y += MARGIN }

  let loopLane = maxX - minX + MARGIN + 24
  const edges = graph.edges.flatMap((edge): PlacedEdge[] => {
    const s = placed.get(edge.source)
    const t = placed.get(edge.target)
    if (!s || !t) return []
    const isBack = back.has(edge)
    let path: string
    let labelAt: PlacedEdge['labelAt']
    if (s === t) {
      const x = s.x + s.width / 2, y = s.y + s.height / 2
      path = `M${x},${y - 8} C${x + 40},${y - 30} ${x + 40},${y + 30} ${x},${y + 8}`
      labelAt = { x: x + 38, y }
    } else if (isBack) {
      // Loops leave on the right, rise beside the graph, and re-enter from the right.
      const sx = s.x + s.width / 2, sy = s.y + s.height / 2
      const tx = t.x + t.width / 2, ty = t.y + t.height / 2
      const lane = Math.max(sx, tx) + 30
      loopLane = Math.max(loopLane, lane + 30)
      path = `M${sx},${sy} C${lane},${sy} ${lane},${ty} ${tx},${ty}`
      labelAt = { x: lane - 4, y: (sy + ty) / 2 }
    } else {
      const sx = s.x, sy = s.y + s.height, tx = t.x, ty = t.y
      const mid = (sy + ty) / 2
      path = `M${sx},${sy} C${sx},${mid} ${tx},${mid} ${tx},${ty}`
      labelAt = edge.kind === 'true' || edge.kind === 'false' || edge.kind === 'case'
        ? { x: sx + (tx - sx) * 0.25 + (tx > sx ? 10 : tx < sx ? -10 : -12), y: sy + 14 }
        : { x: (sx + tx) / 2 + 6, y: mid }
    }
    return [{ edge, path, back: isBack, ...(edge.label ? { labelAt } : {}) }]
  })

  return { nodes: placed, edges, width: loopLane + MARGIN, height: maxY + MARGIN * 2 }
}

/** Program-order column with def→use arcs on the right; reads like annotated source.
 * Arcs get lanes by interval coloring so overlapping ranges do not share a track. */
export function layoutSequence(graph: Graph): Layout {
  // Group by file (whole-program view spans several), then program order.
  const ordered = [...graph.nodes].sort((a, b) =>
    (a.span?.file ?? '').localeCompare(b.span?.file ?? '') ||
    (a.span?.line ?? 0) - (b.span?.line ?? 0) || (a.span?.column ?? 0) - (b.span?.column ?? 0))
  const labels = ordered.map(n => shorten(n.label))
  const width = Math.max(120, ...labels.map((l, i) => l.length * CHAR_WIDTH + (ordered[i]!.kind === 'condition' ? 44 : 26)))
  const rowHeight = NODE_HEIGHT + 14
  const nodes = new Map<string, PlacedNode>()
  ordered.forEach((node, i) => nodes.set(node.id, {
    node, label: labels[i]!, width, height: NODE_HEIGHT, x: MARGIN + width / 2, y: MARGIN + i * rowHeight,
  }))
  const index = new Map(ordered.map((n, i) => [n.id, i]))
  const spans = graph.edges
    .filter(e => index.has(e.source) && index.has(e.target))
    .map(edge => {
      const a = index.get(edge.source)!, b = index.get(edge.target)!
      return { edge, lo: Math.min(a, b), hi: Math.max(a, b), lane: 0 }
    })
    .sort((p, q) => (p.hi - p.lo) - (q.hi - q.lo))
  const lanes: { lo: number; hi: number }[][] = []
  for (const s of spans) {
    let lane = lanes.findIndex(used => used.every(u => s.hi <= u.lo || s.lo >= u.hi))
    if (lane < 0) { lane = lanes.length; lanes.push([]) }
    lanes[lane]!.push(s)
    s.lane = lane
  }
  const right = MARGIN + width
  const edges: PlacedEdge[] = spans.map(({ edge, lane }) => {
    const s = nodes.get(edge.source)!, t = nodes.get(edge.target)!
    const sy = s.y + s.height / 2, ty = t.y + t.height / 2
    const x = right + 26 + lane * 26
    const path = s === t
      ? `M${right},${sy - 6} C${right + 30},${sy - 20} ${right + 30},${sy + 20} ${right},${sy + 6}`
      : `M${right},${sy} C${x},${sy} ${x},${ty} ${right + 4},${ty}`
    return { edge, path, back: index.get(edge.source)! > index.get(edge.target)!, ...(edge.label ? { labelAt: { x: x - 4, y: (sy + ty) / 2 } } : {}) }
  })
  return { nodes, edges, width: right + 40 + lanes.length * 26 + MARGIN, height: MARGIN * 2 + ordered.length * rowHeight }
}
