import type { Shape } from './style.ts'

export function NodeShape({ shape, width, height }: { shape: Shape; width: number; height: number }) {
  if (shape === 'hexagon') {
    const inset = Math.min(14, width / 4)
    return <polygon className="shape" points={`${inset},0 ${width - inset},0 ${width},${height / 2} ${width - inset},${height} ${inset},${height} 0,${height / 2}`} />
  }
  if (shape === 'tag') {
    const notch = Math.min(10, width / 5)
    return <polygon className="shape" points={`0,0 ${width - notch},0 ${width},${height / 2} ${width - notch},${height} 0,${height}`} />
  }
  return <rect className="shape" width={width} height={height} rx={shape === 'pill' ? height / 2 : 4} />
}
