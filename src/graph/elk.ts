// Automatic layered layout with ELK (Eclipse Layout Kernel), run in a web worker.
// Used for include and data-dependency graphs: crossing minimization, orthogonal edges,
// placed edge labels, and optional grouping (boxes) by function or directory.
import ELK from 'elkjs/lib/elk-api.js'
import type { ElkExtendedEdge, ElkNode, ElkPoint } from 'elkjs/lib/elk-api.js'
import workerUrl from 'elkjs/lib/elk-worker.min.js?url'
import type { Graph, GraphEdge, GraphNode } from '../../shared/graph.ts'
import { nodeBox } from './layout.ts'
import type { Layout, PlacedEdge, PlacedGroup, PlacedNode } from './layout.ts'

export interface ElkOptions {
  /** Group (box) a node belongs to, if any. */
  groupOf?: (node: GraphNode) => string | undefined
  /** Keep the input order where it does not cost crossings (program order). */
  modelOrder?: boolean
  /** Bundle edges that share an endpoint (many files including one header). */
  merge?: boolean
  /** RIGHT suits graphs with many roots and short chains (include graphs). */
  direction?: 'DOWN' | 'RIGHT'
  /** Nested boxes: outermost-first group keys for each node. Laid out in one hierarchical
   * pass with edges routed across boxes; suits graphs whose edges mostly run downward
   * (inlined calls). Takes precedence over `groupOf`. */
  groupPath?: (node: GraphNode) => string[]
  groupLabel?: (key: string) => string
}

/** Larger graphs use the built-in layout: ELK's cost grows quickly past this. */
export const ELK_MAX_NODES = 2500
const TIMEOUT_MS = 20_000
const LABEL_CHAR = 6.6
const LABEL_MAX = 26
/** Edge labels are shortened on the canvas; the full text is in the tooltip. */
export const shortLabel = (text: string) => text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text

let engine: InstanceType<typeof ELK> | undefined
const elk = () => (engine ??= new ELK({ workerFactory: () => new Worker(workerUrl) }))

function rounded(points: ElkPoint[], radius = 6): string {
  if (points.length < 3) return `M${points.map(p => `${p.x},${p.y}`).join(' L')}`
  let d = `M${points[0]!.x},${points[0]!.y}`
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1]!, points[i]!, points[i + 1]!]
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2)
    const toward = (from: ElkPoint, to: ElkPoint) => {
      const len = Math.hypot(to.x - from.x, to.y - from.y) || 1
      return { x: from.x + (to.x - from.x) / len * r, y: from.y + (to.y - from.y) / len * r }
    }
    const p1 = toward(b, a), p2 = toward(b, c)
    d += ` L${p1.x},${p1.y} Q${b.x},${b.y} ${p2.x},${p2.y}`
  }
  const last = points[points.length - 1]!
  return `${d} L${last.x},${last.y}`
}

const BASE_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '40',
  'elk.spacing.nodeNode': '22',
  'elk.spacing.edgeNode': '14',
  'elk.spacing.edgeEdge': '8',
  'elk.spacing.componentComponent': '40',
  'elk.edgeLabels.placement': 'CENTER',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.json.edgeCoords': 'ROOT',
  'elk.json.shapeCoords': 'ROOT',
}

async function run(root: ElkNode): Promise<ElkNode> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Automatic layout timed out')), TIMEOUT_MS) })
  try {
    return await Promise.race([elk().layout(root), timeout])
  } catch (error) {
    // A stuck worker would block later layouts; start a fresh one next time.
    engine?.terminateWorker()
    engine = undefined
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Lay out nodes and the edges among them; coordinates start at (0,0) plus padding. */
async function flat(nodes: GraphNode[], edges: GraphEdge[], modelOrder: boolean, padding: number, merge = false, direction: 'DOWN' | 'RIGHT' = 'DOWN'): Promise<Layout> {
  const boxes = new Map(nodes.map(n => [n.id, nodeBox(n)]))
  const out = await run({
    id: 'root',
    children: nodes.map(n => ({ id: n.id, width: boxes.get(n.id)!.width, height: boxes.get(n.id)!.height })),
    edges: edges.map((e, i) => ({
      id: `e${i}`, sources: [e.source], targets: [e.target],
      ...(e.label ? { labels: [{ text: shortLabel(e.label), width: shortLabel(e.label).length * LABEL_CHAR + 6, height: 14 }] } : {}),
    })),
    layoutOptions: {
      ...BASE_OPTIONS,
      ...(modelOrder ? { 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES' } : {}),
      ...(merge ? { 'elk.layered.mergeEdges': 'true' } : {}),
      'elk.direction': direction,
      ...(direction === 'RIGHT' ? { 'elk.layered.spacing.nodeNodeBetweenLayers': '70', 'elk.spacing.nodeNode': '10' } : {}),
      'elk.padding': `[top=${padding},left=${padding},bottom=${padding},right=${padding}]`,
    },
  })
  const byId = new Map(nodes.map(n => [n.id, n]))
  const placed = new Map<string, PlacedNode>()
  for (const child of out.children ?? []) {
    const node = byId.get(child.id)!
    const box = boxes.get(child.id)!
    placed.set(child.id, { node, label: box.label, width: box.width, height: box.height, x: (child.x ?? 0) + box.width / 2, y: child.y ?? 0 })
  }
  const placedEdges: PlacedEdge[] = []
  for (const e of (out.edges ?? []) as ElkExtendedEdge[]) {
    const edge = edges[Number(e.id.slice(1))]
    const section = e.sections?.[0]
    if (!edge || !section) continue
    const label = e.labels?.[0]
    placedEdges.push({
      edge, back: false,
      path: rounded([section.startPoint, ...(section.bendPoints ?? []), section.endPoint]),
      ...(label && edge.label ? { labelAt: { x: (label.x ?? 0) + (label.width ?? 0) / 2, y: (label.y ?? 0) + (label.height ?? 0) / 2 } } : {}),
    })
  }
  return { nodes: placed, edges: placedEdges, width: out.width ?? 0, height: out.height ?? 0 }
}

/** One hierarchical ELK run with (possibly nested) compound nodes. */
async function nested(nodes: GraphNode[], edges: GraphEdge[], groupPath: (n: GraphNode) => string[], groupLabel: (key: string) => string, modelOrder: boolean): Promise<Layout> {
  const boxes = new Map(nodes.map(n => [n.id, nodeBox(n)]))
  const root: ElkNode = { id: 'root', children: [] }
  const compound = new Map<string, ElkNode>()
  for (const n of nodes) {
    let parent = root
    for (const key of groupPath(n)) {
      let box = compound.get(key)
      if (!box) {
        box = { id: `group:${key}`, children: [], layoutOptions: { 'elk.padding': `[top=${HEADER + 6},left=${GROUP_PAD},bottom=${GROUP_PAD},right=${GROUP_PAD}]` } }
        compound.set(key, box)
        parent.children!.push(box)
      }
      parent = box
    }
    parent.children!.push({ id: n.id, width: boxes.get(n.id)!.width, height: boxes.get(n.id)!.height })
  }
  root.edges = edges.map((e, i) => ({
    id: `e${i}`, sources: [e.source], targets: [e.target],
    ...(e.label ? { labels: [{ text: shortLabel(e.label), width: shortLabel(e.label).length * LABEL_CHAR + 6, height: 14 }] } : {}),
  }))
  root.layoutOptions = {
    ...BASE_OPTIONS,
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    ...(modelOrder ? { 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES' } : {}),
    'elk.padding': '[top=24,left=24,bottom=24,right=24]',
  }
  const out = await run(root)
  const byId = new Map(nodes.map(n => [n.id, n]))
  const placed = new Map<string, PlacedNode>()
  const groups: PlacedGroup[] = []
  const visit = (n: ElkNode) => {
    for (const child of n.children ?? []) {
      const node = byId.get(child.id)
      if (node) {
        const box = boxes.get(child.id)!
        placed.set(child.id, { node, label: box.label, width: box.width, height: box.height, x: (child.x ?? 0) + box.width / 2, y: child.y ?? 0 })
      } else {
        const key = child.id.slice('group:'.length)
        groups.push({ id: child.id, key, label: groupLabel(key), x: child.x ?? 0, y: child.y ?? 0, width: child.width ?? 0, height: child.height ?? 0 })
        visit(child)
      }
    }
  }
  visit(out)
  const placedEdges: PlacedEdge[] = []
  const collect = (n: ElkNode) => {
    for (const e of (n.edges ?? []) as ElkExtendedEdge[]) {
      const edge = edges[Number(e.id.slice(1))]
      const section = e.sections?.[0]
      if (!edge || !section) continue
      const label = e.labels?.[0]
      placedEdges.push({ edge, back: false, path: rounded([section.startPoint, ...(section.bendPoints ?? []), section.endPoint]),
        ...(label && edge.label ? { labelAt: { x: (label.x ?? 0) + (label.width ?? 0) / 2, y: (label.y ?? 0) + (label.height ?? 0) / 2 } } : {}) })
    }
    for (const child of n.children ?? []) collect(child)
  }
  collect(out)
  return { nodes: placed, edges: placedEdges, groups, width: out.width ?? 0, height: out.height ?? 0 }
}

/** Offset every coordinate in an SVG path made of M/L/Q/C commands. */
function shiftPath(path: string, dx: number, dy: number): string {
  return path.replace(/(-?[\d.]+),(-?[\d.]+)/g, (_m, x: string, y: string) => `${Number(x) + dx},${Number(y) + dy}`)
}

/** Edges that run back up the call structure: returns, write-backs, globals coming out. */
const upward = (e: GraphEdge, entries: Set<string>) => e.kind === 'return' || e.kind === 'mod' || (e.kind === 'global' && !entries.has(e.target))

/** Width:height of the graph panel the layout should suit. */
const TARGET_ASPECT = 1.3
const HEADER = 26
const GROUP_PAD = 12

/** Ungrouped: one layered layout. Grouped: each group laid out on its own, groups arranged
 * as blocks, and edges between groups drawn as direct curves; a single hierarchical run
 * routes backward edges (returns, write-backs) around the whole drawing instead. */
export async function layoutElk(graph: Graph, options: ElkOptions = {}): Promise<Layout> {
  const ids = new Set(graph.nodes.map(n => n.id))
  const valid = graph.edges.filter(e => ids.has(e.source) && ids.has(e.target))
  const groupOf = options.groupOf
  const modelOrder = options.modelOrder ?? false
  if (options.groupPath) return nested(graph.nodes, valid, options.groupPath, options.groupLabel ?? (k => k), modelOrder)
  if (!groupOf) {
    if (options.direction) return flat(graph.nodes, valid, modelOrder, 24, options.merge, options.direction)
    // No preferred direction: try both and keep the one closest to the panel's shape.
    // Stars (one definition used everywhere) are far wider than tall when laid out downward.
    const down = await flat(graph.nodes, valid, modelOrder, 24, options.merge, 'DOWN')
    if (graph.nodes.length < 8 || down.width <= down.height * TARGET_ASPECT * 2) return down
    const right = await flat(graph.nodes, valid, modelOrder, 24, options.merge, 'RIGHT')
    const misfit = (l: Layout) => Math.abs(Math.log((l.width / Math.max(1, l.height)) / TARGET_ASPECT))
    return misfit(right) < misfit(down) ? right : down
  }

  // Phase 1: each group on its own. Ungrouped nodes become single-node groups.
  const members = new Map<string, GraphNode[]>()
  const groupName = new Map<string, string>()
  for (const node of graph.nodes) {
    const name = groupOf(node)
    const key = name === undefined ? `node:${node.id}` : `group:${name}`
    groupName.set(node.id, key)
    members.set(key, [...(members.get(key) ?? []), node])
  }
  const keys = [...members.keys()]
  const inner = await Promise.all(keys.map(key => {
    const nodes = members.get(key)!
    const own = new Set(nodes.map(n => n.id))
    return flat(nodes, valid.filter(e => own.has(e.source) && own.has(e.target)), modelOrder, GROUP_PAD)
  }))
  const innerOf = new Map(keys.map((k, i) => [k, inner[i]!]))

  // Phase 2: groups as blocks, connected by the downward edges between them.
  const entries = new Set(graph.nodes.filter(n => n.kind === 'entry').map(n => n.id))
  const between = new Set<string>()
  for (const e of valid) {
    const [a, b] = [groupName.get(e.source)!, groupName.get(e.target)!]
    if (a !== b && !upward(e, entries)) between.add(`${a}\n${b}`)
  }
  const isGroup = (k: string) => k.startsWith('group:')
  const top = await run({
    id: 'root',
    children: keys.map(k => ({ id: k, width: innerOf.get(k)!.width, height: innerOf.get(k)!.height + (isGroup(k) ? HEADER : 0) })),
    edges: [...between].map((pair, i) => { const [a, b] = pair.split('\n') as [string, string]; return { id: `g${i}`, sources: [a], targets: [b] } }),
    layoutOptions: { ...BASE_OPTIONS, 'elk.spacing.nodeNode': '40', 'elk.layered.spacing.nodeNodeBetweenLayers': '70', 'elk.padding': '[top=24,left=24,bottom=24,right=24]',
      ...(modelOrder ? { 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES' } : {}) },
  })

  const nodes = new Map<string, PlacedNode>()
  const edges: PlacedEdge[] = []
  const groups: PlacedGroup[] = []
  for (const block of top.children ?? []) {
    const layout = innerOf.get(block.id)!
    const [bx, by] = [block.x ?? 0, block.y ?? 0]
    const dy = by + (isGroup(block.id) ? HEADER : 0)
    if (isGroup(block.id)) groups.push({ id: block.id, key: block.id.slice('group:'.length), label: block.id.slice('group:'.length), x: bx, y: by, width: block.width ?? 0, height: block.height ?? 0 })
    for (const [id, p] of layout.nodes) nodes.set(id, { ...p, x: p.x + bx, y: p.y + dy })
    for (const e of layout.edges) edges.push({ ...e, path: shiftPath(e.path, bx, dy), ...(e.labelAt ? { labelAt: { x: e.labelAt.x + bx, y: e.labelAt.y + dy } } : {}) })
  }
  // Edges between groups: direct curves from the source node to the target node.
  for (const e of valid) {
    if (groupName.get(e.source) === groupName.get(e.target)) continue
    const s = nodes.get(e.source), t = nodes.get(e.target)
    if (!s || !t) continue
    const down = t.y >= s.y + s.height
    const [sx, sy] = [s.x, down ? s.y + s.height : s.y]
    const [tx, ty] = [t.x, down ? t.y : t.y + t.height]
    const bend = Math.max(40, Math.abs(ty - sy) / 2) * (down ? 1 : -1)
    // Unlabelled on the canvas (they bunch up between groups); the label shows on hover.
    edges.push({ edge: e, back: !down, path: `M${sx},${sy} C${sx},${sy + bend} ${tx},${ty - bend} ${tx},${ty}` })
  }
  return { nodes, edges, groups, width: top.width ?? 0, height: top.height ?? 0 }
}
