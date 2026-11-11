import type { AnalysisResult, SourceFile } from '../shared/graph.ts'

/** Project inputs sent to the backend and stored in sessions. */
export interface Project {
  /** Absolute folder the files were read from. */
  root?: string
  files: SourceFile[]
  /** Translation units to analyze; empty means compile_commands.json entries or every .c file. */
  units: string[]
  includeDirs: string
  defines: string
  std: string
}

export interface SessionSummary { id: string; name: string; savedAt: string }
export interface Session extends SessionSummary { project: Project; result?: AnalysisResult }

// The packaged app loads from file://, where relative URLs cannot reach the backend.
const BASE = import.meta.env.VITE_LEXEME_API ?? (location.protocol === 'file:' ? 'http://127.0.0.1:3000' : '')

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}/api${path}`, {
    ...init,
    ...(init?.body ? { headers: { 'Content-Type': 'application/json' } } : {}),
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw new Error(body.error ?? body.message ?? `Backend returned ${response.status}`)
  return body
}

const list = (value: string) => value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)

export const api = {
  health: () => call<{ ok: boolean }>('/health'),
  open: (path: string) => call<{ root: string; files: SourceFile[]; skipped: number }>('/open', { method: 'POST', body: JSON.stringify({ path }) }),
  analyze: (project: Project) => call<AnalysisResult>('/analyze', {
    method: 'POST',
    body: JSON.stringify({
      files: project.files, ...(project.units.length ? { units: project.units } : {}),
      includeDirs: list(project.includeDirs), defines: list(project.defines), std: project.std,
    }),
  }),
  sessions: () => call<SessionSummary[]>('/sessions'),
  session: (id: string) => call<Session>(`/sessions/${id}`),
  save: (session: { id?: string; name: string; project: Project; result?: AnalysisResult }) =>
    call<SessionSummary>('/sessions', { method: 'POST', body: JSON.stringify(session) }),
  remove: (id: string) => call<{ ok: boolean }>(`/sessions/${id}`, { method: 'DELETE' }),
}
