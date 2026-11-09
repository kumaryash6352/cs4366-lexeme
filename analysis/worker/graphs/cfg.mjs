import { filePath, stableId } from './source-map.mjs'

/** Parse GCC's emitted CFG subset, not arbitrary DOT labels or layout attributes. */
export function parseCfg(text, dot, context) {
  const graphs = []
  const functions = []
  for (const match of text.matchAll(/^;; Function (\S+) \([^\n]*funcdef_no=(\d+)[^\n]*\)\n([\s\S]*?)(?=^;; Function |$(?![\s\S]))/gm)) {
    const [, name, compilerId, body] = match
    const functionId = stableId(context.id, 'function', name)
    const nodeId = block => `${functionId}:bb${block}`
    const nodes = [{ id: nodeId(0), kind: 'entry', label: 'ENTRY', locations: [] }, { id: nodeId(1), kind: 'exit', label: 'EXIT', locations: [] }]
    for (const block of body.matchAll(/^\s*<bb (\d+)>[^\n]*\n([\s\S]*?)(?=^\s*<bb \d+>|$(?![\s\S]))/gm)) {
      const locations = []
      for (const location of block[2].matchAll(/\[([^\]\n]+):(\d+):(\d+)\]/g)) {
        const record = { file: filePath(location[1], context), line: Number(location[2]), column: Number(location[3]), precision: 'compiler' }
        if (!locations.some(item => JSON.stringify(item) === JSON.stringify(record))) locations.push(record)
      }
      const label = block[2].replace(/\[[^\]\n]+:\d+:\d+\]\s*/g, '').replace(/\n}\s*$/, '').trim()
      nodes.push({ id: nodeId(block[1]), kind: 'block', label, locations })
    }
    const edges = []
    const edgePattern = /fn_(\d+)_basic_block_(\d+):\w+\s*->\s*fn_(\d+)_basic_block_(\d+):\w+\s*\[([^\]]*)\];/g
    for (const edge of dot.matchAll(edgePattern)) {
      if (edge[1] !== compilerId || edge[3] !== compilerId || /\binvis\b/.test(edge[5])) continue
      const source = nodeId(edge[2]), target = nodeId(edge[4])
      const node = nodes.find(item => item.id === source)
      if (!node || !nodes.some(item => item.id === target)) throw new Error(`Unsupported GCC CFG block reference in ${name}`)
      let kind = 'flow', label
      const branch = /\bif\s*\([\s\S]*?\)\s*goto <bb (\d+)>;[^\n]*\n\s*else\s*goto <bb (\d+)>;/.exec(node.label)
      if (branch) kind = edge[4] === branch[1] ? 'true' : edge[4] === branch[2] ? 'false' : 'flow'
      const cases = [...node.label.matchAll(/(case [^:]+|default):\s*<([^>]+)>/g)]
      if (/\bswitch\s*\(/.test(node.label)) {
        kind = 'switch'
        const destination = nodes.find(item => item.id === target)
        const labels = cases.filter(item => item[2] === `bb ${edge[4]}` || destination.label.includes(`<${item[2]}>:`))
        if (labels.length) { kind = 'case'; label = labels.map(item => item[1]).join(', ') }
      }
      edges.push({ source, target, kind, ...(label ? { label } : {}) })
    }
    if (!edges.some(edge => edge.source === nodeId(0))) throw new Error(`Missing GCC CFG entry for ${name}`)
    graphs.push({ functionId, unitId: context.id, nodes, edges })
    functions.push({ id: functionId, name, unitId: context.id, linkage: 'unknown', location: nodes.flatMap(node => node.locations)[0] ?? null })
  }
  if (/^;; Function /m.test(text) && !graphs.length) throw new Error('Unsupported GCC CFG format')
  return { functions, graphs }
}
