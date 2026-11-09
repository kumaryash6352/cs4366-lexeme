import { stableId } from './source-map.mjs'

/** Read the initial GCC call graph, before unused functions or calls are removed. */
export function parseCalls(text, context, functions) {
  const table = /^Initial Symbol table:\n([\s\S]*?)(?=^Removing unused symbols:)/m.exec(text)?.[1]
  if (table === undefined) throw new Error('Unsupported GCC call graph format')
  const locations = new Map(functions.map(fn => [fn.name, fn.location]))
  const symbols = new Map()
  for (const record of table.matchAll(/^(\S+)\/(\d+) \((.*)\) @[^\n]*\n((?:[ \t].*\n|\n)*)/gm)) {
    const [, , number, name, body] = record
    if (!/^  Type: function\b/m.test(body)) continue
    const defined = /^  Type: function definition\b/m.test(body)
    symbols.set(number, {
      node: { id: stableId(context.id, defined ? 'function' : 'external', name), name, unitId: context.id,
        defined, linkage: 'unknown', location: locations.get(name) ?? null },
      calls: [...(/^  Calls:(.*)$/m.exec(body)?.[1] ?? '').matchAll(/\S+\/(\d+)(?=\s|$)/g)].map(match => match[1]),
    })
  }
  for (const fn of functions) {
    if (![...symbols.values()].some(symbol => symbol.node.name === fn.name)) throw new Error(`GCC call graph omitted ${fn.name}`)
  }
  const edges = []
  for (const { node, calls } of symbols.values()) {
    for (const number of new Set(calls)) {
      const target = symbols.get(number)?.node
      if (!target) throw new Error('Invalid GCC call graph reference')
      edges.push({ source: node.id, target: target.id, kind: 'call' })
    }
  }
  return { nodes: [...symbols.values()].map(symbol => symbol.node), edges }
}

export function applyLinkage(nodes, symbols) {
  const linkage = new Map()
  for (const line of symbols.split('\n')) {
    const match = /^(\S+)\s+([tTwW])\s/.exec(line)
    if (match) linkage.set(match[1], match[2] === 't' ? 'internal' : 'external')
  }
  for (const node of nodes) if (node.defined) node.linkage = linkage.get(node.name) ?? 'unknown'
}

// Cross-TU resolution remains conservative: variants/multiple definitions stay ambiguous.
export function mergeCalls(results) {
  const nodes = results.flatMap(result => result.nodes)
  const edges = results.flatMap(result => result.edges)
  const redirects = new Map()
  for (const node of nodes.filter(item => !item.defined)) {
    const candidates = nodes.filter(item => item.defined && item.linkage === 'external' && item.name === node.name && item.unitId !== node.unitId)
    if (candidates.length === 1) redirects.set(node.id, candidates[0].id)
    else node.resolution = candidates.length > 1 ? 'ambiguous' : 'external-or-indirect'
  }
  return {
    nodes: nodes.filter(node => !redirects.has(node.id)),
    edges: edges.map(edge => ({ ...edge, target: redirects.get(edge.target) ?? edge.target })),
    limitations: ['Static call relationships, not runtime call targets. Function-pointer targets and exact call-site spans are not resolved.'],
  }
}
