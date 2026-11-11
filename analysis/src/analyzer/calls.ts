import type { Graph, GraphEdge, GraphNode, SourceSpan } from './graph-types.js'

export type CallTarget =
  | { kind: 'function'; id: string }
  | { kind: 'external'; name: string }
  | { kind: 'indirect'; name?: string }

export interface CallSite { caller: string; target: CallTarget }

/** Call graph over defined functions, with external and indirect (function pointer) callees. */
export function callGraph(defined: Map<string, { label: string; span?: SourceSpan; detail?: string }>, sites: CallSite[], entry?: string): Graph {
  const nodes = new Map<string, GraphNode>()
  for (const [id, fn] of defined) nodes.set(id, { id, kind: 'function', label: fn.label, ...(fn.span ? { span: fn.span } : {}), ...(fn.detail ? { detail: fn.detail } : {}) })
  const counts = new Map<string, number>()
  for (const site of sites) {
    const t = site.target
    const id = t.kind === 'function' ? t.id : t.kind === 'external' ? t.name : `(indirect)${t.name ? ` ${t.name}` : ''}`
    if (!nodes.has(id)) {
      nodes.set(id, t.kind === 'indirect'
        ? { id, kind: 'indirect', label: `${t.name ?? 'function pointer'} (indirect)` }
        : { id, kind: 'external', label: id })
    }
    const key = `${site.caller}\n${id}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const edges: GraphEdge[] = [...counts].map(([key, count]) => {
    const [source, target] = key.split('\n') as [string, string]
    return { source, target, kind: 'call', ...(count > 1 ? { label: `×${count}` } : {}) }
  })
  const root = entry ?? (defined.has('main') ? 'main' : [...defined.keys()][0])
  return { id: 'calls', title: 'Call graph', ...(root ? { entry: root } : {}), nodes: [...nodes.values()], edges }
}
