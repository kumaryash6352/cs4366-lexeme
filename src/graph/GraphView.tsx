import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Ref } from 'react'
import type { Graph, GraphNode } from '../../shared/graph.ts'
import { layoutGraph, layoutSequence } from './layout.ts'
import type { Layout } from './layout.ts'
import { ELK_MAX_NODES, layoutElk, shortLabel } from './elk.ts'
import { NodeShape } from './Shape.tsx'
import { GRAPH_CSS, styleOf } from './style.ts'

interface Props {
  graph: Graph
  selected: string | undefined
  /** Search hits; when set, other nodes are dimmed. */
  matches: Set<string> | undefined
  onSelect: (id: string | undefined) => void
  onOpen?: (id: string) => void
  /** Right-click on a node, with viewport coordinates for the menu. */
  onContext?: (id: string, x: number, y: number) => void
  /** Nodes that can be expanded in place (call graph functions), and those already open. */
  expandable?: Set<string>
  expanded?: Set<string>
  onToggle?: (id: string) => void
  /** Bump `at` to zoom to (at least 100%) and center a node. */
  focus?: { id: string; at: number } | undefined
  svgRef: Ref<SVGSVGElement>
  /** `sequence` stacks nodes in source order with dependency arcs; `auto` runs ELK
   * (showing `fallback` until it finishes, or if the graph is too large). */
  layout?: 'layered' | 'sequence' | 'auto'
  fallback?: 'layered' | 'sequence'
  /** ELK grouping: boxes by function, directory, …; `groupKey` identifies the grouping. */
  groupOf?: (node: GraphNode) => string | undefined
  groupKey?: string
  /** Nested boxes (outermost first) per node, for in-place expansions. */
  groupPath?: (node: GraphNode) => string[]
  groupLabel?: (key: string) => string
  /** Collapse button in a box header. */
  onGroupToggle?: (key: string) => void
  /** Extra CSS classes for a box (e.g. block kind). */
  groupClass?: (key: string) => string
  modelOrder?: boolean
  merge?: boolean
  direction?: 'DOWN' | 'RIGHT'
}

const MIN_ZOOM = 0.2
const MAX_ZOOM = 3
const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

const autoCache = new WeakMap<Graph, Map<string, Layout>>()

export function GraphView({ graph, selected, matches, onSelect, onOpen, onContext, expandable, expanded, onToggle, focus, svgRef,
  layout: mode = 'layered', fallback = 'layered', groupOf, groupKey = '', groupPath, groupLabel, onGroupToggle, groupClass, modelOrder = false, merge = false, direction }: Props) {
  const base = mode === 'auto' ? fallback : mode
  const builtIn = useMemo(() => base === 'sequence' ? layoutSequence(graph) : layoutGraph(graph), [graph, base])
  const cacheKey = `${groupKey}|${modelOrder}|${merge}|${direction ?? 'auto'}`
  const [auto, setAuto] = useState<{ graph: Graph; key: string; layout?: Layout; note?: string }>()
  const cached = mode === 'auto' ? autoCache.get(graph)?.get(cacheKey) : undefined
  const tooLarge = mode === 'auto' && graph.nodes.length > ELK_MAX_NODES
  useEffect(() => {
    if (mode !== 'auto' || autoCache.get(graph)?.has(cacheKey) || graph.nodes.length > ELK_MAX_NODES) return
    let live = true
    layoutElk(graph, { ...(groupOf ? { groupOf } : {}), ...(groupPath ? { groupPath } : {}), ...(groupLabel ? { groupLabel } : {}), modelOrder, merge, ...(direction ? { direction } : {}) })
      .then(result => {
        const perGraph = autoCache.get(graph) ?? new Map<string, Layout>()
        perGraph.set(cacheKey, result)
        autoCache.set(graph, perGraph)
        if (live) setAuto({ graph, key: cacheKey, layout: result })
      })
      .catch(error => { if (live) setAuto({ graph, key: cacheKey, note: error instanceof Error ? error.message : String(error) }) })
    return () => { live = false }
  }, [graph, mode, cacheKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const current = mode === 'auto' && auto?.graph === graph && auto.key === cacheKey ? auto : undefined
  const ready = cached ?? current?.layout
  const note = tooLarge ? `${graph.nodes.length} nodes: too many for automatic layout` : current?.note
  const layout = ready ?? builtIn
  const pending = mode === 'auto' && !ready && !note
  const viewport = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | undefined>(undefined)

  const fit = () => {
    const el = viewport.current
    if (!el) return
    // Fit the width; tall graphs scroll vertically rather than shrinking to illegibility.
    const byWidth = (el.clientWidth - 16) / layout.width
    const byBoth = Math.min(byWidth, (el.clientHeight - 16) / layout.height)
    setZoom(clamp(Math.min(1, Math.max(byBoth, Math.min(byWidth, 0.75)))))
  }
  // Fit each newly shown graph (not when the same graph grows, e.g. expanding in place).
  useLayoutEffect(fit, [graph.id, mode, ready]) // eslint-disable-line react-hooks/exhaustive-deps

  const center = (id: string, atLeast: number) => {
    const el = viewport.current
    const placed = layout.nodes.get(id)
    if (!el || !placed) return
    setZoom(z => {
      const next = clamp(Math.max(z, atLeast))
      requestAnimationFrame(() => {
        // The SVG is centered by margin:auto when smaller than the viewport.
        const svg = el.querySelector('svg.graph')
        const offsetX = svg ? (svg as SVGSVGElement).getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft : 0
        const offsetY = svg ? (svg as SVGSVGElement).getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop : 0
        el.scrollTo({ left: offsetX + placed.x * next - el.clientWidth / 2, top: offsetY + (placed.y + placed.height / 2) * next - el.clientHeight / 2, behavior: 'smooth' })
      })
      return next
    })
  }
  useEffect(() => { if (focus) center(focus.id, 1) }, [focus?.at]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the selected node visible when selection comes from the source pane.
  useEffect(() => {
    if (!selected) return
    const el = viewport.current?.querySelector(`[data-id="${CSS.escape(selected)}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [selected, layout])

  // Ctrl/Cmd + wheel (and trackpad pinch) zooms around the pointer.
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      setZoom(z => {
        const next = clamp(z * Math.exp(-event.deltaY * 0.01))
        const rect = el.getBoundingClientRect()
        const px = event.clientX - rect.left + el.scrollLeft
        const py = event.clientY - rect.top + el.scrollTop
        requestAnimationFrame(() => {
          el.scrollLeft = px * (next / z) - (event.clientX - rect.left)
          el.scrollTop = py * (next / z) - (event.clientY - rect.top)
        })
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const hot = selected ? new Set(graph.edges.filter(e => e.source === selected || e.target === selected).map(e => `${e.source}\n${e.target}`)) : undefined

  return (
    <div className="graph-view">
      <div
        className="viewport"
        ref={viewport}
        tabIndex={0}
        aria-label="Graph canvas. Drag to pan; + and - zoom, 0 resets, F fits."
        onKeyDown={event => {
          if ((event.target as Element).closest('input, select, textarea')) return
          if (event.key === '+' || event.key === '=') setZoom(z => clamp(z * 1.25))
          else if (event.key === '-' || event.key === '_') setZoom(z => clamp(z / 1.25))
          else if (event.key === '0') setZoom(1)
          else if (event.key === 'f' || event.key === 'F') fit()
          else if ((event.key === 'z' || event.key === 'Z') && selected) center(selected, 1.5)
          else return
          event.preventDefault()
        }}
        onPointerDown={event => {
          if (event.button !== 0 || (event.target as Element).closest('.node, .toggle')) return
          // Without this, dragging selects SVG text and the page highlights.
          event.preventDefault()
          const el = viewport.current!
          el.focus({ preventScroll: true })
          drag.current = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false }
          el.setPointerCapture(event.pointerId)
        }}
        onPointerMove={event => {
          const d = drag.current
          if (!d) return
          const el = viewport.current!
          if (Math.abs(event.clientX - d.x) + Math.abs(event.clientY - d.y) > 3) d.moved = true
          el.scrollLeft = d.left - (event.clientX - d.x)
          el.scrollTop = d.top - (event.clientY - d.y)
        }}
        onPointerUp={() => {
          if (drag.current && !drag.current.moved) onSelect(undefined)
          drag.current = undefined
        }}
      >
        <svg
          ref={svgRef}
          className="graph"
          width={layout.width * zoom}
          height={layout.height * zoom}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label={graph.title}
        >
          <style>{GRAPH_CSS}</style>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="arrow" />
            </marker>
          </defs>
          <rect className="bg" width={layout.width} height={layout.height} />
          {layout.groups?.map(g => (
            <g key={g.id} className={`group${onGroupToggle ? ' collapsible' : ''} ${groupClass?.(g.key) ?? ''}`}>
              <rect x={g.x} y={g.y} width={g.width} height={g.height} rx={8} />
              <text x={g.x + (onGroupToggle ? 30 : 10)} y={g.y + 17}><title>{g.label}</title>{g.label.length > 60 ? `${g.label.slice(0, 59)}…` : g.label}</text>
              {onGroupToggle && (
                <g className="toggle" transform={`translate(${g.x + 15},${g.y + 13})`} role="button" aria-label={`Collapse ${g.label}`}
                  onClick={event => { event.stopPropagation(); onGroupToggle(g.key) }}>
                  <title>Collapse</title>
                  <circle r="8" />
                  <text textAnchor="middle" dominantBaseline="central">−</text>
                </g>
              )}
            </g>
          ))}
          {layout.edges.map((placed, i) => {
            const key = `${placed.edge.source}\n${placed.edge.target}`
            const dim = matches !== undefined || (hot !== undefined && !hot.has(key))
            return (
              <g key={i} className={`edge edge-${placed.edge.kind ?? 'plain'}${hot?.has(key) ? ' hot' : ''}${dim ? ' dim' : ''}`}>
                {placed.edge.label && <title>{placed.edge.label}</title>}
                <path d={placed.path} markerEnd="url(#arrow)" />
                {placed.labelAt && placed.edge.label && <text x={placed.labelAt.x} y={placed.labelAt.y} textAnchor="middle" dominantBaseline="central">
                  <title>{placed.edge.label}</title>{shortLabel(placed.edge.label)}
                </text>}
              </g>
            )
          })}
          {[...layout.nodes.values()].map(({ node, x, y, width, height, label }) => {
            const style = styleOf(node.kind)
            const isMatch = matches?.has(node.id) ?? false
            const classes = ['node', `k-${node.kind}`, style.dashed ? 'dashed' : '', node.id === selected ? 'selected' : '',
              isMatch ? 'match' : '', matches && !isMatch ? 'dim' : ''].filter(Boolean).join(' ')
            const where = node.span ? `, ${node.span.file} line ${node.span.line}` : ''
            return (
              <g
                key={node.id}
                data-id={node.id}
                className={classes}
                transform={`translate(${x - width / 2},${y})`}
                onClick={() => onSelect(node.id)}
                onDoubleClick={() => onOpen?.(node.id)}
                onMouseDown={event => { if (event.detail > 1) event.preventDefault() }}
                onContextMenu={event => { event.preventDefault(); onSelect(node.id); onContext?.(node.id, event.clientX, event.clientY) }}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id) }
                }}
                role="button"
                tabIndex={0}
                aria-pressed={node.id === selected}
                aria-label={`${style.label}: ${node.label}${where}`}
              >
                <title>{[node.label, node.detail].filter(Boolean).join('\n')}</title>
                <NodeShape shape={style.shape} width={width} height={height} />
                <text x={width / 2} y={height / 2} dominantBaseline="central" textAnchor="middle">{label}</text>
                {expandable?.has(node.id) && (
                  <g className="toggle" transform={`translate(${width},0)`} role="button" aria-label={`${expanded?.has(node.id) ? 'Collapse' : 'Expand'} ${node.label}`}
                    onClick={event => { event.stopPropagation(); onToggle?.(node.id) }}>
                    <title>{expanded?.has(node.id) ? 'Collapse' : 'Expand control flow here'}</title>
                    <circle r="9" />
                    <text textAnchor="middle" dominantBaseline="central">{expanded?.has(node.id) ? '−' : '+'}</text>
                  </g>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      {(pending || note) && <div className="layout-status" role="status">{pending ? 'Arranging…' : `Built-in layout (${note})`}</div>}
      <div className="zoom-controls" aria-label="Zoom">
        <button onClick={() => setZoom(z => clamp(z / 1.25))} aria-label="Zoom out">−</button>
        <button onClick={() => setZoom(1)} aria-label="Actual size">{Math.round(zoom * 100)}%</button>
        <button onClick={() => setZoom(z => clamp(z * 1.25))} aria-label="Zoom in">+</button>
        <button onClick={fit} aria-label="Fit to view">Fit</button>
        <button onClick={() => selected && center(selected, 1.5)} disabled={!selected} aria-label="Zoom to selected node" title="Zoom to selected (Z)">Focus</button>
      </div>
    </div>
  )
}
