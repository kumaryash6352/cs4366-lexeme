import { useMemo, useRef, useState } from 'react'
import type { GraphDocument, ProjectAnalysis, SourceSpan } from '../shared/analysis.ts'

const NODE_WIDTH = 260
const COLLAPSED_HEIGHT = 112
const STATEMENT_HEIGHT = 58
const COLUMN_GAP = 76
const ROW_GAP = 76
const MARGIN = 70
type ControlFlow = GraphDocument['controlFlow'][number]
type FlowNode = ControlFlow['nodes'][number]
type FunctionItem = { flow: ControlFlow; name: string }
type PositionedNode = FlowNode & { x: number; y: number; width: number; height: number }

function cleanLines(label: string): string[] {
  return label.split('\n').map(line => line.trim().replace(/\s*\[INV\]/g, ''))
    .filter(line => line && !line.startsWith('// predicted'))
}

function nodeStatements(node: FlowNode): SourceSpan[] {
  if (node.sourceSpans?.length) return node.sourceSpans
  if (node.source) return [node.source]
  return cleanLines(node.rawLabel ?? node.label).map((text, index) => ({
    file: node.locations[index]?.file ?? node.locations[0]?.file ?? '',
    startLine: node.locations[index]?.line ?? node.locations[0]?.line ?? 0,
    startColumn: node.locations[index]?.column ?? 1,
    endLine: node.locations[index]?.line ?? node.locations[0]?.line ?? 0,
    endColumn: node.locations[index]?.column ?? 1,
    text,
  }))
}

function nodeHeight(node: FlowNode, expanded: Set<string>): number {
  if (!expanded.has(node.id) || node.kind !== 'block') return COLLAPSED_HEIGHT
  return 50 + Math.max(1, nodeStatements(node).length) * STATEMENT_HEIGHT + 10
}

function layout(flow: ControlFlow, expanded: Set<string>) {
  const outgoing = new Map<string, string[]>()
  for (const edge of flow.edges) outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
  const entry = flow.nodes.find(node => node.kind === 'entry') ?? flow.nodes[0]
  const ranks = new Map<string, number>()
  const queue = entry ? [entry.id] : []
  if (entry) ranks.set(entry.id, 0)
  while (queue.length) {
    const source = queue.shift()!
    const nextRank = (ranks.get(source) ?? 0) + 1
    for (const target of outgoing.get(source) ?? []) {
      if (ranks.has(target)) continue
      ranks.set(target, nextRank)
      queue.push(target)
    }
  }
  let lastRank = Math.max(0, ...ranks.values())
  for (const node of flow.nodes) if (!ranks.has(node.id)) ranks.set(node.id, ++lastRank)
  const rows = new Map<number, FlowNode[]>()
  for (const node of flow.nodes) {
    const rank = ranks.get(node.id) ?? 0
    rows.set(rank, [...(rows.get(rank) ?? []), node])
  }
  const widest = Math.max(1, ...[...rows.values()].map(row => row.length))
  const width = MARGIN * 2 + widest * NODE_WIDTH + (widest - 1) * COLUMN_GAP
  const rowWidth = (count: number) => count * NODE_WIDTH + (count - 1) * COLUMN_GAP
  const nodes: PositionedNode[] = []
  let y = MARGIN
  for (const [, row] of [...rows].sort(([a], [b]) => a - b)) {
    const offset = MARGIN + (width - MARGIN * 2 - rowWidth(row.length)) / 2
    const height = Math.max(...row.map(node => nodeHeight(node, expanded)))
    row.forEach((node, index) => nodes.push({
      ...node,
      x: offset + index * (NODE_WIDTH + COLUMN_GAP), y,
      width: NODE_WIDTH, height: nodeHeight(node, expanded),
    }))
    y += height + ROW_GAP
  }
  return { nodes, width, height: Math.max(620, y - ROW_GAP + MARGIN) }
}

function shortLines(label: string, width = 34): string[] {
  const lines = cleanLines(label).slice(0, 4)
  return (lines.length ? lines : ['Basic block']).map(line => line.length > width ? `${line.slice(0, width - 1)}…` : line)
}

function edgePath(source: PositionedNode, target: PositionedNode): string {
  const startX = source.x + source.width / 2
  const startY = source.y + source.height
  const endX = target.x + target.width / 2
  const endY = target.y
  if (endY > startY) {
    const middle = (startY + endY) / 2
    return `M ${startX} ${startY} C ${startX} ${middle}, ${endX} ${middle}, ${endX} ${endY}`
  }
  const bend = Math.max(source.x + source.width, target.x + target.width) + 48
  return `M ${startX} ${startY} C ${bend} ${startY}, ${bend} ${endY}, ${endX} ${endY}`
}

function fittedView(diagram: ReturnType<typeof layout> | undefined) {
  if (!diagram) return { x: 0, y: 0, zoom: 1000 }
  const zoom = Math.max(620, diagram.width, diagram.height)
  return { x: (diagram.width - zoom) / 2, y: 0, zoom }
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function statementCalls(statement: SourceSpan, callerId: string, graph: GraphDocument, functions: FunctionItem[]): FunctionItem[] {
  const targets = new Set(graph.calls.edges.filter(edge => edge.source === callerId).map(edge => edge.target))
  return functions.filter(item => targets.has(item.flow.functionId) &&
    new RegExp(`\\b${escaped(item.name)}\\s*\\(`).test(statement.text))
}

/** Interactive flowchart with browser-local progressive disclosure, as specified by the UI design. */
export function GraphWorkspace({ projectName, analysis, onOpenSource }: {
  projectName?: string
  analysis?: ProjectAnalysis
  onOpenSource?: (span: SourceSpan) => void
}) {
  const graph = analysis?.status === 'succeeded' ? analysis.graph : undefined
  const functions = useMemo(() => {
    if (!graph) return []
    const byId = new Map(graph.calls.nodes.map(node => [node.id, node]))
    return graph.controlFlow.map(flow => ({ flow, name: byId.get(flow.functionId)?.name ?? flow.functionId }))
      .sort((a, b) => a.name === 'main' ? -1 : b.name === 'main' ? 1 : a.name.localeCompare(b.name))
  }, [graph])
  const [functionId, setFunctionId] = useState(() => functions[0]?.flow.functionId ?? '')
  const [history, setHistory] = useState<string[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const selected = functions.find(item => item.flow.functionId === functionId) ?? functions[0]
  const diagram = useMemo(() => selected ? layout(selected.flow, expanded) : undefined, [selected, expanded])
  const [view, setView] = useState(() => fittedView(diagram))
  const drag = useRef<{ x: number; y: number } | null>(null)
  const positions = new Map(diagram?.nodes.map(node => [node.id, node]) ?? [])
  const zoomBy = (factor: number) => setView(old => {
    const zoom = Math.max(280, Math.min(4000, old.zoom * factor))
    const offset = (old.zoom - zoom) / 2
    return { x: old.x + offset, y: old.y + offset, zoom }
  })

  function chooseFunction(nextId: string, rememberCurrent = false) {
    const next = functions.find(item => item.flow.functionId === nextId)
    if (!next) return
    if (rememberCurrent && selected) setHistory(old => [...old, selected.flow.functionId])
    else if (!rememberCurrent) setHistory([])
    setFunctionId(nextId)
    setExpanded(new Set())
    setView(fittedView(layout(next.flow, new Set())))
  }

  function goBack() {
    const nextHistory = history.slice(0, -1)
    const nextId = history.at(-1)
    if (!nextId) return
    setHistory(nextHistory)
    setFunctionId(nextId)
    setExpanded(new Set())
    const next = functions.find(item => item.flow.functionId === nextId)
    setView(fittedView(next ? layout(next.flow, new Set()) : undefined))
  }

  function toggleNode(node: FlowNode) {
    if (node.kind !== 'block' || !selected) return
    const next = new Set(expanded)
    if (next.has(node.id)) next.delete(node.id)
    else next.add(node.id)
    setExpanded(next)
    setView(fittedView(layout(selected.flow, next)))
  }

  return (
    <section className="pane graph-pane" aria-labelledby="graph-title">
      <div className="pane-header graph-header">
        <div><h2 id="graph-title">Graph workspace</h2>{selected && <span className="project-summary">Control flow · {selected.flow.nodes.length} blocks · {selected.flow.edges.length} edges</span>}</div>
        {functions.length > 0 && <div className="graph-controls">
          <label className="function-picker">Function
            <select value={selected?.flow.functionId ?? ''} onChange={event => chooseFunction(event.target.value)}>
              {functions.map(item => <option key={item.flow.functionId} value={item.flow.functionId}>{item.name}</option>)}
            </select>
          </label>
          <div className="zoom-controls" aria-label="Graph zoom controls">
            <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(1.2)}>−</button>
            <button type="button" aria-label="Fit graph" title="Fit graph" onClick={() => setView(fittedView(diagram))}>Fit</button>
            <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(0.8)}>+</button>
          </div>
        </div>}
      </div>
      <div className="graph-canvas">
        {history.length > 0 && selected && <div className="graph-breadcrumb">
          <button type="button" onClick={goBack} aria-label="Return to calling function">← Back</button>
          <span>{history.map(id => functions.find(item => item.flow.functionId === id)?.name ?? id).join(' / ')} / <strong>{selected.name}</strong></span>
        </div>}
        {selected && diagram ? <svg aria-label={`Control flow graph for ${selected.name}`}
          viewBox={`${view.x} ${view.y} ${view.zoom} ${view.zoom}`}
          onPointerDown={event => {
            drag.current = { x: event.clientX, y: event.clientY }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={event => {
            if (!drag.current) return
            const dx = event.clientX - drag.current.x, dy = event.clientY - drag.current.y
            drag.current = { x: event.clientX, y: event.clientY }
            setView(old => ({ ...old, x: old.x - dx * old.zoom / 1000, y: old.y - dy * old.zoom / 1000 }))
          }}
          onPointerUp={() => { drag.current = null }}
          onPointerCancel={() => { drag.current = null }}
          onWheel={event => {
            event.preventDefault()
            zoomBy(event.deltaY > 0 ? 1.12 : 0.88)
          }}>
          <defs><marker id="cfg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
          <g className="cfg-edges">
            {selected.flow.edges.map((edge, index) => {
              const source = positions.get(edge.source), target = positions.get(edge.target)
              if (!source || !target) return null
              const labelX = (source.x + target.x) / 2 + NODE_WIDTH / 2
              const labelY = (source.y + source.height + target.y) / 2
              return <g key={`${edge.source}-${edge.target}-${index}`} className={`cfg-edge ${edge.kind}`}>
                <path d={edgePath(source, target)} markerEnd="url(#cfg-arrow)" />
                {edge.kind !== 'flow' && <text x={labelX} y={labelY}>{edge.label ?? edge.kind}</text>}
              </g>
            })}
          </g>
          <g className="cfg-nodes">
            {diagram.nodes.map(node => {
              const isExpanded = expanded.has(node.id) && node.kind === 'block'
              const lines = shortLines(node.label)
              const location = node.source ? { file: node.source.file, line: node.source.startLine } : node.locations[0]
              const statements = isExpanded ? nodeStatements(node) : []
              return <g key={node.id} className={`cfg-node ${node.kind}${isExpanded ? ' expanded' : ''}`} transform={`translate(${node.x} ${node.y})`}
                role={node.kind === 'block' ? 'button' : undefined} tabIndex={node.kind === 'block' ? 0 : undefined}
                aria-label={node.kind === 'block' ? `${isExpanded ? 'Collapse' : 'Expand'} ${node.semanticKind ?? 'basic block'}` : node.label}
                onPointerDown={event => event.stopPropagation()}
                onClick={() => toggleNode(node)}
                onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleNode(node) } }}>
                <rect className="cfg-node-frame" width={node.width} height={node.height} rx="10" />
                <text className="cfg-node-kind" x="14" y="20">{node.semanticKind ?? node.kind}</text>
                {node.kind === 'block' && <g className="cfg-expand-control">
                  <title>{isExpanded ? 'Collapse block' : 'Expand block'}</title>
                  <circle cx={node.width - 19} cy="18" r="11" />
                  <text x={node.width - 19} y="22" textAnchor="middle">{isExpanded ? '−' : '+'}</text>
                </g>}
                {!isExpanded && <>
                  <text className="cfg-node-label" x="14" y="42">{lines.map((line, index) => <tspan key={index} x="14" dy={index ? 16 : 0}>{line}</tspan>)}</text>
                  {location && <text className="cfg-node-location" x="14" y="100">{location.file}:{location.line}</text>}
                </>}
                {isExpanded && statements.map((statement, index) => {
                  const y = 42 + index * STATEMENT_HEIGHT
                  const calls = graph ? statementCalls(statement, selected.flow.functionId, graph, functions) : []
                  const statementLines = shortLines(statement.text, calls.length ? 25 : 31).slice(0, 2)
                  return <g key={`${statement.file}:${statement.startLine}:${statement.startColumn}:${index}`} className="cfg-statement"
                    onClick={event => event.stopPropagation()}>
                    <rect x="10" y={y} width={node.width - 20} height={STATEMENT_HEIGHT - 8} rx="7" />
                    <text className="cfg-statement-label" x="20" y={y + 18}
                      role={statement.file ? 'button' : undefined} tabIndex={statement.file ? 0 : undefined}
                      onClick={() => { if (statement.file) onOpenSource?.(statement) }}
                      onKeyDown={event => { if (statement.file && (event.key === 'Enter' || event.key === ' ')) { event.stopPropagation(); onOpenSource?.(statement) } }}>
                      <title>{statement.text}</title>
                      {statementLines.map((line, lineIndex) => <tspan key={lineIndex} x="20" dy={lineIndex ? 15 : 0}>{line}</tspan>)}
                    </text>
                    {calls.map((callee, callIndex) => <g key={callee.flow.functionId} className="cfg-inline-call"
                      transform={`translate(${node.width - 91} ${y + 27 + callIndex * 16})`} role="button" tabIndex={0}
                      aria-label={`Expand function ${callee.name}`} onClick={event => { event.stopPropagation(); chooseFunction(callee.flow.functionId, true) }}
                      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); chooseFunction(callee.flow.functionId, true) } }}>
                      <title>Expand function {callee.name}</title>
                      <rect width="72" height="17" rx="8" /><text x="36" y="12" textAnchor="middle">{callee.name.length > 9 ? `${callee.name.slice(0, 8)}…` : callee.name} →</text>
                    </g>)}
                    {statement.file && <text className="cfg-statement-location" x="20" y={y + 44}>{statement.file}:{statement.startLine}</text>}
                  </g>
                })}
              </g>
            })}
          </g>
        </svg> : <div className="empty-state graph-placeholder">
          <div className="graph-mark" aria-hidden="true">◇</div>
          <h3>{analysis?.status === 'failed' ? 'Analysis failed' : 'No graph generated'}</h3>
          <p className="muted">{analysis?.status === 'failed' ? analysis.error : projectName ? `${projectName} has no control flow data yet.` : 'Open a repository to generate a control flow graph.'}</p>
        </div>}
      </div>
    </section>
  )
}
