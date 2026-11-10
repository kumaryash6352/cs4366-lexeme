import { useEffect, useMemo, useRef, useState } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'
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
type FlowNode = {
  name: string
  kind: 'endpoint' | 'process' | 'conditional' | 'io'
  selection?: Selection
  children: { target: number; label?: string }[]
}
type SourceFile = { name: string; path: string; content: string }
type Position = { x: number; y: number }

function FlowBox({ block, x, y, onSelect }: { block: FlowNode; x: number; y: number; onSelect: (selection: Selection) => void }) {
  const highlightColour = '#77B', normalColour = '#559'
  const shape = {
    endpoint: [[-80, -75], [80, -75], [100, -55], [100, 55], [80, 75], [-80, 75], [-100, 55], [-100, -55]],
    process: [[-100, -75], [100, -75], [100, 75], [-100, 75]],
    conditional: [[-100, 0], [0, -75], [100, 0], [0, 75]],
    io: [[-80, -75], [120, -75], [80, 75], [-120, 75]],
  }[block.kind]
  const points = shape.map(([pointX, pointY]) => `${pointX! + x},${pointY! + y}`).join(' ')
  const label = block.name.length > 30 ? `${block.name.slice(0, 29)}…` : block.name

  return <g className="box" fill={normalColour} stroke="white" strokeWidth="1.5">
    <polygon points={points}
      onMouseOver={event => event.currentTarget.setAttribute('fill', highlightColour)}
      onMouseOut={event => event.currentTarget.setAttribute('fill', normalColour)}
      onClick={() => { if (block.selection) onSelect(block.selection) }} />
    <text className="noselect" x={x} y={y} textAnchor="middle">{label}</text>
  </g>
}

function Arrow({ x1, y1, x2, y2, text }: { x1: number; y1: number; x2: number; y2: number; text?: string }) {
  const targetOffsetX = x1 === x2 ? 0 : x1 > x2 ? 35 : -35
  const targetOffsetY = y1 === y2 ? 0 : y1 > y2 ? 85 : -85
  return <g>
    <path d={`M ${x1} ${y1} L ${x2 + targetOffsetX} ${y2 + targetOffsetY}`}
      strokeWidth="2" stroke="white" fill="none" markerEnd="url(#arrow)" />
    {text && <text stroke="white" className="noselect edge-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2}>{text}</text>}
  </g>
}

function FlowChart({ graph, startNode, onSelect }: { graph: FlowNode[]; startNode: number; onSelect: (selection: Selection) => void }): ReactNode {
  const positions: (Position | undefined)[] = new Array(graph.length)
  const queue = [startNode]
  const nodes: ReactNode[] = [], arrows: ReactNode[] = []
  positions[startNode] = { x: 0, y: 100 }
  let key = 0

  while (queue.length) {
    const index = queue.pop()!
    const node = graph[index], position = positions[index]
    if (!node || !position) continue
    nodes.push(<FlowBox key={`node-${index}`} block={node} x={position.x} y={position.y} onSelect={onSelect} />)
    node.children.forEach((child, childIndex) => {
      if (!graph[child.target]) return
      if (!positions[child.target]) {
        positions[child.target] = {
          x: position.x + (childIndex - (node.children.length - 1) / 2) * 300,
          y: position.y + 220,
        }
        queue.push(child.target)
      }
      const target = positions[child.target]!
      arrows.push(<Arrow key={`edge-${key++}`} x1={position.x} y1={position.y}
        x2={target.x} y2={target.y} {...(child.label ? { text: child.label } : {})} />)
    })
  }
  return <>{arrows}{nodes}</>
}

function backendFlow(analysis: ProjectAnalysis | null) {
  if (!analysis || analysis.status !== 'succeeded') return undefined
  const names = new Map(analysis.graph.calls.nodes.map(node => [node.id, node.name]))
  const flow = analysis.graph.controlFlow.find(item => names.get(item.functionId) === 'main') ?? analysis.graph.controlFlow[0]
  if (!flow) return undefined
  const indexes = new Map(flow.nodes.map((node, index) => [node.id, index]))
  const graph: FlowNode[] = flow.nodes.map(node => {
    const semantic = node.semanticKind
    const kind: FlowNode['kind'] = node.kind === 'entry' || node.kind === 'exit' ? 'endpoint'
      : semantic === 'condition' || semantic === 'loop' ? 'conditional'
      : semantic === 'call' ? 'io' : 'process'
    const source = node.source
    const location = node.locations[0]
    const selection = source ? {
      file: source.file, startLine: source.startLine, startColumn: source.startColumn,
      endLine: source.endLine, endColumn: source.endColumn,
    } : location ? {
      file: location.file, startLine: location.line, startColumn: location.column ?? 1,
      endLine: location.line, endColumn: (location.column ?? 1) + 1,
    } : undefined
    return {
      name: node.label || node.kind,
      kind,
      ...(selection ? { selection } : {}),
      children: flow.edges.filter(edge => edge.source === node.id).flatMap(edge => {
        const target = indexes.get(edge.target)
        return target === undefined ? [] : [{ target, ...(edge.kind === 'flow' ? {} : { label: edge.label ?? edge.kind }) }]
      }),
    }
  })
  return { graph, startNode: flow.nodes.findIndex(node => node.kind === 'entry'), functionName: names.get(flow.functionId) ?? flow.functionId }
}

const viewboxBoundaries = { xMin: -1000, xMax: 200, yMin: -800, yMax: 1000, zoomMin: 300, zoomMax: 1800 }
const flowchartView = { x: (viewboxBoundaries.xMax + viewboxBoundaries.xMin) / 2, y: 0, zoom: 1000 }

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
  const [panning, setPanning] = useState(false)
  const [flowchartViewbox, setViewbox] = useState([flowchartView.x, flowchartView.y, flowchartView.zoom, flowchartView.zoom])
  const flowchartRef = useRef<SVGSVGElement | null>(null)
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
  const controlFlow = useMemo(() => backendFlow(analysisResult), [analysisResult])

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

  function panViewbox(dx: number, dy: number) {
    flowchartView.x = Math.max(viewboxBoundaries.xMin, Math.min(viewboxBoundaries.xMax, flowchartView.x - dx * flowchartView.zoom / 1000))
    flowchartView.y = Math.max(viewboxBoundaries.yMin, Math.min(viewboxBoundaries.yMax, flowchartView.y - dy * flowchartView.zoom / 1000))
  }

  function zoomViewbox(cx: number, cy: number, amount: number) {
    if (!flowchartRef.current) return
    const oldZoom = flowchartView.zoom
    flowchartView.zoom = Math.max(viewboxBoundaries.zoomMin, Math.min(viewboxBoundaries.zoomMax, oldZoom + amount / 3))
    const offset = oldZoom - flowchartView.zoom
    flowchartView.x += cx / flowchartRef.current.getBoundingClientRect().width * offset
    flowchartView.y += cy / flowchartRef.current.getBoundingClientRect().height * offset
  }

  function selectGraphSource(selection: Selection) {
    const file = files.find(item => item.path === selection.file)
    if (!file) return
    pendingSelection.current = selection
    setActiveFile(file.path)
  }

  return <main className="app" onMouseUp={() => setPanning(false)}>
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

      <section className="pane graph-pane" aria-labelledby="graph-title">
        <div className="pane-header noselect">
          <h2 id="graph-title">Graph workspace</h2>
          <span className="muted">{controlFlow ? `Control flow · ${controlFlow.functionName}` : 'Control flow'}</span>
        </div>
        <div className="graph-stage">
          {controlFlow ? <svg id="FLOWCHART" viewBox={flowchartViewbox.join(' ')} ref={flowchartRef}
            onMouseDown={() => setPanning(true)}
            onMouseMove={event => {
              if (!panning) return
              panViewbox(event.movementX, event.movementY)
              setViewbox([flowchartView.x, flowchartView.y, flowchartView.zoom, flowchartView.zoom])
            }}
            onWheel={event => {
              zoomViewbox(event.nativeEvent.offsetX, event.nativeEvent.offsetY, event.deltaY)
              setViewbox([flowchartView.x, flowchartView.y, flowchartView.zoom, flowchartView.zoom])
            }}>
            <defs><marker id="arrow" viewBox="-5 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M -5 0 L 5 5 L -5 10 z" fill="white" />
            </marker></defs>
            <FlowChart graph={controlFlow.graph} startNode={Math.max(0, controlFlow.startNode)} onSelect={selectGraphSource} />
          </svg> : <div className="empty-state">
            <div className="graph-mark noselect" aria-hidden="true">◇</div>
            <h3 className="noselect">Control flow will appear here</h3>
            <p className="muted">Import or edit a C project, then select Analyze Project.</p>
          </div>}
        </div>
      </section>
    </div>
    <footer><span>{projectName}</span><span>{currentFile?.content.trimEnd().split('\n').length ?? 0} lines · cursor {selectionIndex} · React + TypeScript</span></footer>
  </main>
}
