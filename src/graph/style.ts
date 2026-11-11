// Graph styling lives in the SVG itself so exported SVG/PNG files look the same as the app.

export type Shape = 'rect' | 'hexagon' | 'pill' | 'tag'

export interface KindStyle { label: string; shape: Shape; dashed?: boolean }

export const KINDS: Record<string, KindStyle> = {
  entry: { label: 'Entry', shape: 'pill' },
  statement: { label: 'Statement', shape: 'rect' },
  condition: { label: 'Condition', shape: 'hexagon' },
  return: { label: 'Return', shape: 'pill' },
  jump: { label: 'Jump', shape: 'tag' },
  label: { label: 'Label', shape: 'tag', dashed: true },
  block: { label: 'Collapsed block', shape: 'rect' },
  alias: { label: 'Unresolved alias', shape: 'rect', dashed: true },
  function: { label: 'Defined function', shape: 'rect' },
  external: { label: 'External', shape: 'rect', dashed: true },
  indirect: { label: 'Indirect call', shape: 'hexagon', dashed: true },
  file: { label: 'Project file', shape: 'rect' },
  system: { label: 'System header', shape: 'rect', dashed: true },
}

export const VIEW_KINDS = {
  cfg: ['entry', 'statement', 'condition', 'return', 'jump', 'label', 'block'],
  calls: ['function', 'external', 'indirect'],
  includes: ['file', 'system'],
  data: ['entry', 'statement', 'condition', 'return', 'alias'],
} as const

export const styleOf = (kind: string): KindStyle => KINDS[kind] ?? { label: kind, shape: 'rect' }

export const GRAPH_CSS = `
.bg { fill: transparent; }
.group rect { fill: #151d2b; stroke: #33435c; stroke-width: 1; }
.group text { font: 600 11px ui-monospace, Menlo, Consolas, monospace; fill: #8fa3c2; }
.group.collapsible > rect { fill: #17233a; stroke: #4f6d9e; stroke-dasharray: 5 3; }
.group.block-loop > rect { stroke: #7f95c8; }
.group.block-branch > rect, .group.block-switch > rect { stroke: #b08d4c; }
.group.block-lines > rect { stroke: #4a5a78; }
.group .toggle text { font: 700 13px ui-monospace, Menlo, monospace; fill: #e8f0ff; }
.edge-call path { stroke: #7fa7e8; stroke-dasharray: 4 3; }
.edge path { fill: none; stroke: #5f6f88; stroke-width: 1.4; }
.edge:hover path { stroke-width: 2.6; }
.edge text { font: 600 11px ui-monospace, Menlo, Consolas, monospace; fill: #9aa8bc; paint-order: stroke; stroke: #10141c; stroke-width: 3px; }
.edge-true path { stroke: #6fbf8e; } .edge-true text { fill: #6fbf8e; }
.edge-false path { stroke: #d68b8b; } .edge-false text { fill: #d68b8b; }
.edge-case path { stroke: #c49a4c; } .edge-case text { fill: #d8b46e; }
.edge-goto path { stroke: #b48ce0; stroke-dasharray: 5 4; }
.edge-data path { stroke: #9a83d9; } .edge-data text { fill: #b9a6ef; }
.edge-param path { stroke: #4fb3bf; stroke-width: 1.8; } .edge-param text { fill: #7fd3dc; }
.edge-return path { stroke: #6fbf8e; stroke-width: 1.8; } .edge-return text { fill: #8fd6a8; }
.edge-mod path { stroke: #e08a5f; stroke-width: 1.8; } .edge-mod text { fill: #f0a882; }
.edge-global path { stroke: #d8b46e; stroke-dasharray: 6 4; } .edge-global text { fill: #e3c88c; }
.edge.dim { opacity: .25; }
.edge.hot path { stroke-width: 2.4; }
.arrow { fill: #8494ad; }
.node { cursor: pointer; outline: none; }
.node .shape { stroke-width: 1.3; fill: #1b2840; stroke: #4f6d9e; }
.node text { font: 12px ui-monospace, Menlo, Consolas, monospace; fill: #dfe7f5; pointer-events: none; }
.node.dashed .shape { stroke-dasharray: 4 3; }
.k-entry .shape { fill: #22314d; stroke: #a8c7fa; }
.k-condition .shape { fill: #33291a; stroke: #c49a4c; }
.k-return .shape { fill: #1d3326; stroke: #5fae7c; }
.k-jump .shape, .k-label .shape { fill: #2a2140; stroke: #9a7fd1; }
.k-alias .shape { fill: #3a1f24; stroke: #d06d7a; }
.k-block .shape { fill: #1f2a44; stroke: #8fb0e8; stroke-width: 2.2; }
.k-function .shape, .k-file .shape { fill: #1b2840; stroke: #6f93d0; }
.k-external .shape, .k-system .shape, .k-indirect .shape { fill: #181e29; stroke: #66758c; }
.k-external text, .k-system text { fill: #a9b5c8; }
.node:hover .shape { filter: brightness(1.35); }
.node.match .shape { stroke: #f2d675; stroke-width: 2; }
.node.dim { opacity: .35; }
.node.selected .shape, .node:focus-visible .shape { stroke: #ffffff; stroke-width: 2.6; }
.toggle { cursor: pointer; }
.toggle circle { fill: #2c4a7a; stroke: #a8c7fa; stroke-width: 1.2; }
.toggle text { font: 700 13px ui-monospace, Menlo, monospace; fill: #e8f0ff; }
.toggle:hover circle { fill: #3d64a3; }
text { user-select: none; -webkit-user-select: none; }
`

/** Edge kinds explained in the data view legend. */
export const DATA_EDGES = [
  { kind: 'data', label: 'def → use' },
  { kind: 'param', label: 'argument' },
  { kind: 'return', label: 'return value' },
  { kind: 'mod', label: 'write via pointer' },
  { kind: 'global', label: 'global' },
]
