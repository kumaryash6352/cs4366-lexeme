import { useEffect, useRef, useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import { GraphWorkspace } from './GraphWorkspace.tsx'
import { openWorkspace } from './project-api.ts'
import type { ProjectAnalysis, SourceSpan } from '../shared/analysis.ts'
import './App.css'

const example = `#include <stdio.h>
#include <stdlib.h>

int calculate(int *a, int *b);

int main(void) {
    int *a = malloc(sizeof(int));
    int *b = malloc(sizeof(int));

    if (a == NULL || b == NULL) {
        free(a);
        free(b);
        return 1;
    }

    printf("Please enter the value for a: ");
    if (scanf("%d", a) != 1) {
        free(a);
        free(b);
        return 1;
    }

    printf("Please enter the value for b: ");
    if (scanf("%d", b) != 1) {
        free(a);
        free(b);
        return 1;
    }

    int result = calculate(a, b);
    printf("\\nThe result is: %d\\n", result);

    free(a);
    free(b);
    return 0;
}

int calculate(int *a, int *b) {
    return *a + *b;
}
`

type Selection = Pick<SourceSpan, 'file' | 'startLine' | 'startColumn' | 'endLine' | 'endColumn'>
type SourceFile = { name: string; path: string; content: string }

function sourceOffset(content: string, line: number, column: number) {
  const lines = content.split('\n')
  let offset = 0
  for (let index = 0; index < Math.max(0, line - 1) && index < lines.length; index++) offset += lines[index]!.length + 1
  return Math.min(content.length, offset + Math.max(0, column - 1))
}

function validProject(value: unknown): value is { projectName?: string; files: SourceFile[] } {
  if (!value || typeof value !== 'object' || !('files' in value) || !Array.isArray(value.files)) return false
  return value.files.every(item => item && typeof item === 'object' &&
    'name' in item && typeof item.name === 'string' && 'path' in item && typeof item.path === 'string' &&
    'content' in item && typeof item.content === 'string')
}

export default function App() {
  const [selectionIndex, setSelectionIndex] = useState(0)
  const sourceRef = useRef<HTMLTextAreaElement | null>(null)
  const pendingSelection = useRef<Selection | null>(null)
  const [projectName, setProjectName] = useState('My Lexeme Project')
  const [files, setFiles] = useState<SourceFile[]>([
    { name: 'main.c', path: 'main.c', content: example },
    { name: 'calculate.c', path: 'calculate.c', content: '// Example code' },
  ])
  const [activeFile, setActiveFile] = useState('main.c')
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [analysisError, setAnalysisError] = useState('')
  const [analysisResult, setAnalysisResult] = useState<ProjectAnalysis | null>(null)
  const currentFile = files.find(file => file.path === activeFile)

  useEffect(() => {
    const selection = pendingSelection.current
    if (!selection || selection.file !== activeFile || !currentFile || !sourceRef.current) return
    const start = sourceOffset(currentFile.content, selection.startLine, selection.startColumn)
    const end = sourceOffset(currentFile.content, selection.endLine, selection.endColumn)
    sourceRef.current.focus()
    sourceRef.current.setSelectionRange(start, Math.max(start + 1, end))
    pendingSelection.current = null
  }, [activeFile, currentFile])

  async function analyzeProject(workspaceName = projectName, workspaceFiles = files) {
    setIsAnalyzing(true)
    setAnalysisError('')
    setAnalysisResult(null)
    try {
      const opened = await openWorkspace(workspaceName, workspaceFiles)
      setAnalysisResult(opened.analysis)
      if (opened.analysis.status === 'failed') setAnalysisError(opened.analysis.error)
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : 'Unknown analysis error')
    } finally {
      setIsAnalyzing(false)
    }
  }

  function createNewFile() {
    const cleanName = window.prompt('Enter a filename')?.trim()
    if (!cleanName) return
    if (files.some(file => file.path === cleanName)) { window.alert('A file with this name already exists'); return }
    setFiles(previous => [...previous, { name: cleanName.split('/').at(-1) ?? cleanName, path: cleanName, content: '' }])
    setActiveFile(cleanName)
    setAnalysisResult(null)
  }

  async function importFiles(selectedFiles: FileList | null, replaceWorkspace = false) {
    if (!selectedFiles) return
    const selected = Array.from(selectedFiles)
    const root = selected.find(file => file.webkitRelativePath)?.webkitRelativePath.split('/')[0]
    const importedFiles: SourceFile[] = await Promise.all(selected.map(async file => {
      const parts = file.webkitRelativePath.split('/').filter(Boolean)
      const path = parts.length > 1 ? parts.slice(1).join('/') : file.name
      return { name: file.name, path, content: await file.text() }
    }))
    if (!importedFiles.length) return
    const firstFile = importedFiles.find(file => /(^|\/)main\.c$/i.test(file.path)) ??
      importedFiles.find(file => /\.[ch]$/i.test(file.path)) ?? importedFiles[0]
    if (!firstFile) return
    if (replaceWorkspace) {
      const importedName = root || 'Imported Repository'
      setProjectName(importedName)
      setFiles(importedFiles)
      setActiveFile(firstFile.path)
      await analyzeProject(importedName, importedFiles)
      return
    }
    setFiles(previous => {
      const updated = [...previous]
      for (const imported of importedFiles) {
        const index = updated.findIndex(file => file.path === imported.path)
        if (index >= 0) updated[index] = imported
        else updated.push(imported)
      }
      return updated
    })
    setActiveFile(firstFile.path)
    setAnalysisResult(null)
  }

  function exportProject() {
    const blob = new Blob([JSON.stringify({ projectName, files }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'lexeme-project.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function importProject(file: File | undefined) {
    if (!file) return
    try {
      const project: unknown = JSON.parse(await file.text())
      if (!validProject(project)) throw new Error('Invalid Lexeme project file')
      setFiles(project.files)
      setProjectName(project.projectName?.trim() || 'Lexeme Project')
      setActiveFile(project.files[0]?.path ?? '')
      setAnalysisResult(null)
    } catch (error) {
      window.alert('Could not import project')
      console.error(error)
    }
  }

  function selectGraphSource(selection: Selection) {
    const file = files.find(item => item.path === selection.file)
    if (!file) return
    pendingSelection.current = selection
    setActiveFile(file.path)
  }

  return <main className="app">
    <header className="toolbar noselect">
      <div className="brand"><span className="logo">🐟</span><h1>lexeme</h1></div>
      <span className="subtitle">code explorer</span>
      <span className="badge">Workspace starter</span>
    </header>
    <div className="workspace">
      <section className="pane" aria-labelledby="source-title">
        <div className="pane-header">
          <h2 id="source-title" className="noselect">Source</h2>
          <div className="header-actions">
            <button onClick={() => {
              setFiles(previous => previous.map(file => file.path === 'main.c' ? { ...file, content: example } : file))
              setAnalysisResult(null)
            }}>Reset example</button>
            <button onClick={createNewFile}>+ New File</button>
          </div>
        </div>

        <div className="file-tabs">
          {files.map(file => <button key={file.path} className={activeFile === file.path ? 'active-tab' : ''}
            onClick={() => setActiveFile(file.path)}>{file.name}</button>)}
        </div>

        <div className="file-actions">
          <label>Import Files<input type="file" multiple accept=".c,.h" onChange={event => {
            void importFiles(event.target.files); event.target.value = ''
          }} /></label>
          <label>Import Folder<input type="file" multiple
            {...({ webkitdirectory: '' } as InputHTMLAttributes<HTMLInputElement>)} onChange={event => {
              void importFiles(event.target.files, true); event.target.value = ''
            }} /></label>
        </div>

        <div className="project-actions">
          <button onClick={exportProject}>Export Project</button>
          <label>Import Project<input type="file" accept=".json,application/json" onChange={event => {
            void importProject(event.target.files?.[0]); event.target.value = ''
          }} /></label>
        </div>

        <button className="analyze-button" onClick={() => void analyzeProject()} disabled={isAnalyzing || files.length === 0}>
          {isAnalyzing ? 'Analyzing...' : 'Analyze Project'}
        </button>
        {analysisError && <p className="error-message">Analysis failed: {analysisError}</p>}
        {analysisResult?.status === 'succeeded' && <p className="success-message">Analysis completed successfully</p>}

        <label className="file-label noselect" htmlFor="SOURCECODE">
          {currentFile?.name ?? 'No file selected'} <span>C11</span>
        </label>
        <textarea ref={sourceRef} id="SOURCECODE" value={currentFile?.content ?? ''}
          onChange={event => {
            const content = event.target.value
            setFiles(previous => previous.map(file => file.path === activeFile ? { ...file, content } : file))
            setAnalysisResult(null)
          }}
          onSelect={event => setSelectionIndex(event.currentTarget.selectionStart)}
          spellCheck={false} aria-label="C source code" />
      </section>

      <GraphWorkspace key={analysisResult?.jobId ?? 'empty'} projectName={projectName}
        {...(analysisResult ? { analysis: analysisResult } : {})} onOpenSource={selectGraphSource} />
    </div>
    <footer><span>{projectName}</span><span>{currentFile?.content.trimEnd().split('\n').length ?? 0} lines · cursor {selectionIndex} · React + TypeScript</span></footer>
  </main>
}
