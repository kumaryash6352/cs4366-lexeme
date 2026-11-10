/** Source coordinates produced by the compiler-backed analyzer. */
export interface SourceLocation {
  file: string
  line: number
  column?: number
  precision: 'line' | 'compiler'
}

export interface GraphEdge {
  source: string
  target: string
  kind: string
  label?: string
}

export interface SourceSpan {
  file: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  text: string
}

/** Versioned graph artifact returned by the backend and accepted by the frontend. */
export interface GraphDocument {
  schemaVersion: 1
  tools: Record<string, string>
  translationUnits: { id: string; source: string; command: string[]; directory: string }[]
  files: {
    id: string
    path: string
    kind: 'project' | 'system' | 'external' | 'generated' | 'unresolved'
  }[]
  includes: {
    edges: (GraphEdge & {
      id: string
      unitId: string
      spelling: string
      resolved: boolean
      location: SourceLocation
    })[]
  }
  calls: {
    nodes: {
      id: string
      name: string
      unitId: string
      defined: boolean
      linkage: 'internal' | 'external' | 'unknown'
      location: SourceLocation | null
      resolution?: string
    }[]
    edges: GraphEdge[]
    limitations: string[]
  }
  controlFlow: {
    functionId: string
    unitId: string
    nodes: {
      id: string
      kind: 'entry' | 'exit' | 'block'
      label: string
      locations: SourceLocation[]
      /** Source-oriented metadata added by Tree-sitter when a compiler location can be matched. */
      semanticKind?: 'statement' | 'condition' | 'loop' | 'return' | 'call' | 'declaration' | 'jump'
      source?: SourceSpan
      sourceSpans?: SourceSpan[]
      rawLabel?: string
    }[]
    edges: GraphEdge[]
  }[]
  limitations: string[]
}

export interface AnalysisEvent {
  at: string
  stage: string
  message: string
}

export interface AnalysisDiagnostic {
  stage: string
  message: string
}

export type ProjectAnalysis = {
  status: 'succeeded'
  jobId: string
  mode: 'cmake-project' | 'single-file'
  events: AnalysisEvent[]
  diagnostics: AnalysisDiagnostic[]
  graph: GraphDocument
} | {
  status: 'failed'
  jobId: string
  mode: 'cmake-project' | 'single-file'
  events: AnalysisEvent[]
  diagnostics: AnalysisDiagnostic[]
  error: string
}
