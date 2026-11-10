import { useMemo, useRef, useState } from 'react'
import type { GraphDocument, ProjectAnalysis } from '../shared/analysis.ts'

const NODE_WIDTH = 240
const NODE_HEIGHT = 112
const COLUMN_GAP = 70
const ROW_GAP = 72
const MARGIN = 70
const GRAPH_VIEWS = [
  { id: 'control-flow', label: 'Control flow' },
  { id: 'calls', label: 'Calls' },
  { id: 'includes', label: 'Includes' },
  { id: 'data-dependencies', label: 'Data dependencies' },
] as const
type GraphView = typeof GRAPH_VIEWS[number]['id']

type ControlFlow = GraphDocument['controlFlow'][number]

type PositionedNode = ControlFlow['nodes'][number] & { x: number; y: number }

function layout(flow: ControlFlow) {
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
  const rows = new Map<number, ControlFlow['nodes']>()
  for (const node of flow.nodes) {
    const rank = ranks.get(node.id) ?? 0
    rows.set(rank, [...(rows.get(rank) ?? []), node])
  }
  const widest = Math.max(1, ...[...rows.values()].map(row => row.length))
  const width = MARGIN * 2 + widest * NODE_WIDTH + (widest - 1) * COLUMN_GAP
  const rowWidth = (count: number) => count * NODE_WIDTH + (count - 1) * COLUMN_GAP
  const nodes: PositionedNode[] = []
  for (const [rank, row] of [...rows].sort(([a], [b]) => a - b)) {
    const offset = MARGIN + (width - MARGIN * 2 - rowWidth(row.length)) / 2
    row.forEach((node, index) => nodes.push({
      ...node,
      x: offset + index * (NODE_WIDTH + COLUMN_GAP),
      y: MARGIN + rank * (NODE_HEIGHT + ROW_GAP),
    }))
  }
  const height = MARGIN * 2 + rows.size * NODE_HEIGHT + Math.max(0, rows.size - 1) * ROW_GAP
  return { nodes, width, height }
}

function nodeLines(label: string): string[] {
  const lines = label.split('\n')
    .map(line => line.trim().replace(/\s*\[INV\]/g, ''))
    .filter(line => line && !line.startsWith('// predicted'))
    .slice(0, 4)
  return (lines.length ? lines : ['Basic block']).map(line => line.length > 34 ? `${line.slice(0, 33)}…` : line)
}

function edgePath(source: PositionedNode, target: PositionedNode): string {
  const startX = source.x + NODE_WIDTH / 2
  const startY = source.y + NODE_HEIGHT
  const endX = target.x + NODE_WIDTH / 2
  const endY = target.y
  if (endY > startY) {
    const middle = (startY + endY) / 2
    return `M ${startX} ${startY} C ${startX} ${middle}, ${endX} ${middle}, ${endX} ${endY}`
  }
  const bend = Math.max(source.x + NODE_WIDTH, target.x + NODE_WIDTH) + 48
  return `M ${startX} ${startY} C ${bend} ${startY}, ${bend} ${endY}, ${endX} ${endY}`
}

function fittedView(diagram: ReturnType<typeof layout> | undefined) {
  if (!diagram) return { x: 0, y: 0, zoom: 1000 }
  const zoom = Math.max(620, diagram.width, diagram.height)
  return { x: (diagram.width - zoom) / 2, y: 0, zoom }
}

/** Remounted when the active project changes so viewport/selection cannot leak between projects. */
export function GraphWorkspace({ projectName, analysis }: { projectName?: string; analysis?: ProjectAnalysis }) {
  const [graphView, setGraphView] = useState<GraphView>('control-flow')
  const graph = analysis?.status === 'succeeded' ? analysis.graph : undefined
  const functions = useMemo(() => {
    if (!graph) return []
    const byId = new Map(graph.calls.nodes.map(node => [node.id, node]))
    return graph.controlFlow.map(flow => ({ flow, name: byId.get(flow.functionId)?.name ?? flow.functionId }))
      .sort((a, b) => a.name === 'main' ? -1 : b.name === 'main' ? 1 : a.name.localeCompare(b.name))
  }, [graph])
  const [functionId, setFunctionId] = useState(() => functions[0]?.flow.functionId ?? '')
  const selected = functions.find(item => item.flow.functionId === functionId) ?? functions[0]
  const diagram = useMemo(() => selected ? layout(selected.flow) : undefined, [selected])
  const [view, setView] = useState(() => fittedView(diagram))
  const drag = useRef<{ x: number; y: number } | null>(null)
  const graphViewIndex = GRAPH_VIEWS.findIndex(view => view.id === graphView)
  const zoomBy = (factor: number) => setView(old => {
    const zoom = Math.max(280, Math.min(4000, old.zoom * factor))
    const offset = (old.zoom - zoom) / 2
    return { x: old.x + offset, y: old.y + offset, zoom }
  })

  const positions = new Map(diagram?.nodes.map(node => [node.id, node]) ?? [])
  return (
    <section className="pane graph-pane" aria-labelledby="graph-title">
      <div className="pane-header graph-header">
        <div><h2 id="graph-title">{GRAPH_VIEWS[graphViewIndex]?.label}</h2>{graphView === 'control-flow' && selected && <span className="project-summary">{selected.flow.nodes.length} blocks · {selected.flow.edges.length} edges</span>}</div>
        {graphView === 'control-flow' && functions.length > 0 && <div className="graph-controls">
          <label className="function-picker">Function
            <select value={selected?.flow.functionId ?? ''} onChange={event => {
              const next = functions.find(item => item.flow.functionId === event.target.value)
              setFunctionId(event.target.value)
              setView(fittedView(next ? layout(next.flow) : undefined))
            }}>
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
        {graphView === 'control-flow' && (selected && diagram ? <svg aria-label={`Control flow graph for ${selected.name}`}
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
              const labelY = (source.y + target.y + NODE_HEIGHT) / 2
              return <g key={`${edge.source}-${edge.target}-${index}`} className={`cfg-edge ${edge.kind}`}>
                <path d={edgePath(source, target)} markerEnd="url(#cfg-arrow)" />
                {edge.kind !== 'flow' && <text x={labelX} y={labelY}>{edge.label ?? edge.kind}</text>}
              </g>
            })}
          </g>
          <g className="cfg-nodes">
            {diagram.nodes.map(node => {
              const lines = nodeLines(node.label)
              const location = node.locations[0]
              return <g key={node.id} className={`cfg-node ${node.kind}`} transform={`translate(${node.x} ${node.y})`}>
                <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx="10" />
                <text className="cfg-node-kind" x="14" y="20">{node.kind}</text>
                <text className="cfg-node-label" x="14" y="42">{lines.map((line, index) => <tspan key={index} x="14" dy={index ? 16 : 0}>{line}</tspan>)}</text>
                {location && <text className="cfg-node-location" x="14" y="100">{location.file}:{location.line}</text>}
              </g>
            })}
          </g>
        </svg> : <div className="empty-state graph-placeholder">
          <div className="graph-mark" aria-hidden="true">◇</div>
          <h3>{analysis?.status === 'failed' ? 'Analysis failed' : 'No graph generated'}</h3>
          <p className="muted">{analysis?.status === 'failed' ? analysis.error : projectName ? `${projectName} has no control flow data yet.` : 'Open a repository to generate a control flow graph.'}</p>
        </div>)}
      </div>
      <div className="graph-modes">
        <div className="graph-view-slider" role="group" aria-label="Graph views">
          <span className="graph-view-indicator" aria-hidden="true" style={{ transform: `translateX(${graphViewIndex * 100}%)` }} />
          {GRAPH_VIEWS.map(view => <button key={view.id} className={graphView === view.id ? 'active' : ''}
            aria-pressed={graphView === view.id} onClick={() => setGraphView(view.id)}>{view.label}</button>)}
        </div>
      </div>
    </section>
  )
}
