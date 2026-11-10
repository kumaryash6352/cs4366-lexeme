import { useEffect, useRef, useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import { GraphWorkspace } from './GraphWorkspace.tsx'
import { getProject, openRepository, readSource } from './project-api.ts'
import { isSourceFile } from '../shared/project.ts'
import type { Project, SourceFile } from '../shared/project.ts'
import type { ProjectAnalysis } from '../shared/analysis.ts'
import './App.css'

const starter = `#include <stdio.h>\n\nint main(void) {\n    puts("Hello, Lexeme!");\n    return 0;\n}\n`

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The repository could not be opened.'
}

export default function App() {
  const picker = useRef<HTMLInputElement>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [activeFile, setActiveFile] = useState<SourceFile>({ path: 'main.c', content: starter })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [, setAnalysis] = useState<ProjectAnalysis | null>(null)

  useEffect(() => {
    let mounted = true
    void getProject().then(open => {
      if (mounted && open) { setProject(open); setActiveFile(open.initialFile) }
    }).catch(() => {})
    return () => { mounted = false }
  }, [])

  async function selectRepository(files: FileList | null) {
    if (!files?.length) return
    setBusy(true)
    setError('')
    try {
      const opened = await openRepository(Array.from(files))
      setProject(opened.project)
      setActiveFile(opened.project.initialFile)
      setAnalysis(opened.analysis)
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
      if (picker.current) picker.current.value = ''
    }
  }

  async function selectFile(path: string) {
    if (!project || path === activeFile.path) return
    setError('')
    try { setActiveFile(await readSource(project.id, path)) }
    catch (reason) { setError(message(reason)) }
  }

  const sourceFiles = project?.files.filter(file => isSourceFile(file.path)) ?? []
  const lineCount = activeFile.content.trimEnd().split('\n').length
  return (
    <main className="app">
      <header className="toolbar">
        <div className="brand"><span className="logo" aria-hidden="true">◇</span><h1>lexeme</h1></div>
        <span className="subtitle">code explorer</span>
        <span className="badge">{project ? project.name : 'Local workspace'}</span>
      </header>
      <div className="workspace">
        <section className="pane source-pane" aria-labelledby="source-title">
          <div className="pane-header">
            <div><h2 id="source-title">Source</h2>{project && <span className="project-summary">{project.files.length} files</span>}</div>
            <div className="source-actions">
              <input ref={picker} className="visually-hidden" type="file" multiple
                {...({ webkitdirectory: '' } as InputHTMLAttributes<HTMLInputElement>)}
                onChange={event => { void selectRepository(event.currentTarget.files) }} />
              <button className="primary-button" disabled={busy} onClick={() => picker.current?.click()}>
                {busy ? <><span className="spinner" aria-hidden="true" />Opening…</> : project ? 'Open another' : 'Open repository'}
              </button>
            </div>
          </div>
          {error && <div className="notice error-notice" role="alert">{error}</div>}
          {!project && <div className="notice">Paste C source below or open a repository folder. Opening a repository stages one workspace for analysis.</div>}
          {project && <div className="project-browser" aria-label={`${project.name} source files`}>
            {sourceFiles.map(file => <button key={file.path} className={file.path === activeFile.path ? 'file-item active' : 'file-item'}
              title={file.path} onClick={() => { void selectFile(file.path) }}>
              <span aria-hidden="true">{file.path.endsWith('.h') ? 'H' : 'C'}</span>{file.path}
            </button>)}
          </div>}
          <label className="file-label" htmlFor="source-editor"><span>{activeFile.path}</span><span>C source</span></label>
          <textarea id="source-editor" value={activeFile.content}
            onChange={event => setActiveFile(current => ({ ...current, content: event.target.value }))}
            spellCheck={false} aria-label={`${activeFile.path} source code`} />
        </section>
        <GraphWorkspace key={project?.id ?? 'scratch'} {...(project ? { projectName: project.name } : {})} />
      </div>
      <footer><span>{project ? `${project.name} · active project` : 'No repository open'}</span><span>{lineCount} lines · React + TypeScript</span></footer>
    </main>
  )
}
