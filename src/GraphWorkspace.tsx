import { useRef, useState } from 'react'

/** Remounted when the active project changes so viewport/selection cannot leak between projects. */
export function GraphWorkspace({ projectName }: { projectName?: string }) {
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1000 })
  const drag = useRef<{ x: number; y: number } | null>(null)
  return (
    <section className="pane graph-pane" aria-labelledby="graph-title">
      <div className="pane-header"><h2 id="graph-title">Graph workspace</h2><span className="muted">Control flow</span></div>
      <div className="graph-canvas">
        <svg aria-label="Graph canvas" viewBox={`${view.x} ${view.y} ${view.zoom} ${view.zoom}`}
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
            if (event.ctrlKey) setView(old => ({ ...old, zoom: Math.max(10, Math.min(1000, old.zoom + event.deltaY / 10)) }))
          }} />
        <div className="empty-state graph-placeholder">
          <div className="graph-mark" aria-hidden="true">◇</div>
          <h3>No graph generated</h3>
          <p className="muted">{projectName ? `${projectName} is open. Browse its source files on the left.` : 'Open a repository or paste C source to begin.'}</p>
          {projectName && <p className="muted">Graph analysis is not connected to this workspace yet.</p>}
        </div>
      </div>
      <div className="graph-modes" aria-label="Planned graph views">Control flow · Calls · Includes · Data dependencies</div>
    </section>
  )
}
