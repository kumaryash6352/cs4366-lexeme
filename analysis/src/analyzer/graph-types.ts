// Graph contract shared by the analyzer, backend, and renderer.

export interface SourceSpan {
  file: string
  /** 1-based. */
  line: number
  /** 1-based. */
  column: number
  endLine: number
  endColumn: number
}

export interface GraphNode {
  id: string
  /** CFG: entry | statement | condition | return | jump | label. Calls: function | external | indirect.
   * Includes: file | system. Data: same kinds as CFG. */
  kind: string
  label: string
  span?: SourceSpan
  /** Extra text shown on hover, e.g. def/use sets. */
  detail?: string
  /** Statement nodes: call-graph ids of the functions this statement calls. */
  calls?: string[]
}

export interface GraphEdge {
  source: string
  target: string
  /** true | false | case | goto | call | include | data | param | return | mod | global */
  kind?: string
  label?: string
}

/** A structured block of a control-flow graph (loop, branch, switch) or a straight-line
 * run of statements. Regions nest via `parent`. */
export interface Region {
  id: string
  kind: 'loop' | 'branch' | 'switch' | 'lines'
  label: string
  nodes: string[]
  parent?: string
  /** Rough complexity: node count + 2 × decisions (conditions) inside the region. */
  score: number
}

export interface Graph {
  id: string
  title: string
  entry?: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Control-flow graphs only. */
  regions?: Region[]
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'note'
  stage: 'preprocess' | 'parse' | 'analysis'
  message: string
  span?: SourceSpan
}

export interface SourceFile { path: string; text: string }

export interface FunctionAnalysis {
  /** Unique across the program: the name, or `name (file)` for clashing static functions. */
  id: string
  name: string
  signature: string
  file: string
  static: boolean
  span?: SourceSpan
  cfg: Graph
  /** Intra-procedural data dependencies, including effects of calls via summaries. */
  data: Graph
  /** Locations this function writes or reads through pointer parameters and globals. */
  summary: { writes: string[]; reads: string[] }
}

export interface UnitResult {
  /** The translation unit's .c file. */
  file: string
  preprocessed: boolean
  flags: string[]
}

export interface AnalysisResult {
  schemaVersion: 3
  /** Where GCC and the analyzer ran. */
  runtime: 'host' | 'container'
  units: UnitResult[]
  files: SourceFile[]
  functions: FunctionAnalysis[]
  calls: Graph
  includes: Graph
  /** Whole-program data dependencies: intra-procedural edges plus argument, return,
   * pointer side-effect, and global-variable flows between functions. */
  program: Graph
  diagnostics: Diagnostic[]
}
