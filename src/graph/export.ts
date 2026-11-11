import type { Graph } from '../../shared/graph.ts'

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Serialize the rendered graph at 100% scale; styles are embedded in the SVG. */
export function svgText(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement
  const [, , w, h] = (svg.getAttribute('viewBox') ?? '0 0 0 0').split(' ')
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', w ?? '0')
  clone.setAttribute('height', h ?? '0')
  clone.querySelector('.bg')?.setAttribute('style', 'fill:#10141c')
  clone.querySelectorAll('.dim, .selected, .match').forEach(el => el.classList.remove('dim', 'selected', 'match'))
  return `<?xml version="1.0" encoding="UTF-8"?>\n${clone.outerHTML}`
}

export const exportSvg = (svg: SVGSVGElement, name: string) =>
  download(new Blob([svgText(svg)], { type: 'image/svg+xml' }), `${name}.svg`)

export const exportJson = (graph: Graph, name: string) =>
  download(new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' }), `${name}.json`)

export async function exportPng(svg: SVGSVGElement, name: string, scale = 2) {
  const text = svgText(svg)
  const [, , w, h] = (svg.getAttribute('viewBox') ?? '0 0 0 0').split(' ').map(Number)
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil((w ?? 0) * scale)
  canvas.height = Math.ceil((h ?? 0) * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas is unavailable')
  context.scale(scale, scale)
  context.drawImage(image, 0, 0)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('PNG encoding failed')
  download(blob, `${name}.png`)
}
