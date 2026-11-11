import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MenuItem, Target } from './navigation.ts'

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onGo: (target: Target) => void
  onAction: (item: Extract<MenuItem, { kind: 'action' }>) => void
  onClose: () => void
}

/** Right-click menu: jump targets grouped by section. Closes on outside click, Escape, or scroll. */
export function ContextMenu({ x, y, items, onGo, onAction, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - height - 4)) })
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [x, y])

  useEffect(() => {
    const away = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      const buttons = [...ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []]
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[(i + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }
    window.addEventListener('mousedown', away, true)
    window.addEventListener('wheel', onClose, { passive: true })
    window.addEventListener('resize', onClose)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', away, true)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])

  return (
    <div ref={ref} className="context-menu" role="menu" style={pos} onContextMenu={e => e.preventDefault()}>
      {items.map((item, i) => item.kind === 'section'
        ? <div key={i} className="context-section" role="presentation">{item.label}</div>
        : item.kind === 'go'
          ? <button key={i} role="menuitem" disabled={item.current} onClick={() => onGo(item.target)}>{item.label}{item.current ? ' (here)' : ''}</button>
          : <button key={i} role="menuitem" onClick={() => onAction(item)}>{item.label}</button>)}
    </div>
  )
}
