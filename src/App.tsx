import { useState } from 'react'
import './App.css'

const example = `
#include <stdio.h>
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
    printf("\nThe result is: %d\n", result);

    free(a);
    free(b);
    return 0;
}

int calculate(int *a, int *b) {
    return *a + *b;
}
`


import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

type Node = {
	name: string;
	kind: 'statement' | 'conditional' | 'loop';
	file: string;
	index: number;
	children?: Node[];
};
const graphExample : Node = {name: "Start", kind:'statement', children:[{name: "something something", kind:'statement', children:[{name: "End", kind:'statement', children:null}]}]}

const isPanning = false;
const flowchart_viewbox = {x:0, y:0, zoom:1000};
const viewboxBoundaries = {xMin: -500, xMax: 500, yMin: -500, yMax: 500, zoomMin: 10, zoomMax: 1000, elementLength: 618.5};

function panViewbox(dx : number, dy : number) : void {
	flowchart_viewbox.x -= dx * flowchart_viewbox.zoom / 1000;
	flowchart_viewbox.y -= dy * flowchart_viewbox.zoom / 1000;
	
	if (viewboxBoundaries.xMin > flowchart_viewbox.x) flowchart_viewbox.x = viewboxBoundaries.xMin;
	else if (viewboxBoundaries.xMax < flowchart_viewbox.x) flowchart_viewbox.x = viewboxBoundaries.xMax;
	if (viewboxBoundaries.yMin > flowchart_viewbox.y) flowchart_viewbox.y = viewboxBoundaries.yMin;
	else if (viewboxBoundaries.yMax < flowchart_viewbox.y) flowchart_viewbox.y = viewboxBoundaries.yMax;
}
function zoomViewbox(cx : number, cy : number, zm : number) : void {
	zm /= 10;
	let zmOffset = flowchart_viewbox.zoom;
	flowchart_viewbox.zoom += zm;
	
	if (viewboxBoundaries.zoomMin > flowchart_viewbox.zoom) flowchart_viewbox.zoom = viewboxBoundaries.zoomMin;
	else if (viewboxBoundaries.zoomMax < flowchart_viewbox.zoom) flowchart_viewbox.zoom = viewboxBoundaries.zoomMax;
	zmOffset -= flowchart_viewbox.zoom;
	
	flowchart_viewbox.x += (cx / viewboxBoundaries.elementLength) * zmOffset;
	flowchart_viewbox.y += (cy / viewboxBoundaries.elementLength) * zmOffset;
	
	if (viewboxBoundaries.xMin > flowchart_viewbox.x) flowchart_viewbox.x = viewboxBoundaries.xMin;
	else if (viewboxBoundaries.xMax < flowchart_viewbox.x) flowchart_viewbox.x = viewboxBoundaries.xMax;
	if (viewboxBoundaries.yMin > flowchart_viewbox.y) flowchart_viewbox.y = viewboxBoundaries.yMin;
	else if (viewboxBoundaries.yMax < flowchart_viewbox.y) flowchart_viewbox.y = viewboxBoundaries.yMax;
}

// TO-DO list:
// 1) (Un)Highlight hovered boxes
// 2) Clicking boxes jumps to selection in text
// 3) Selections jumps to boxes
// 4) Build tree
// 5) Allow subtree expansion (and closing)
// 6) Allow multiple source files in tree
// (3-5) finalize data formating
// (...) exporting and importing

export default function App() {
  const [source, setSource] = useState(example);
  const [selectionIndex, setSelectionIndex] = useState(0);
  const [panning, setPanning] = useState(isPanning);
  const [flowchartViewbox, setViewbox] = useState([flowchart_viewbox.x, flowchart_viewbox.y, flowchart_viewbox.zoom, flowchart_viewbox.zoom]);
  return (
    <main className="app" onMouseUp={(event)=> setPanning(false)}>
      <header className="toolbar noselect" >
        <div className="brand"><span className="logo">🐟</span><h1>lexeme</h1></div>
        <span className="subtitle">code explorer</span>
        <span className="badge">Workspace starter</span>
      </header>
      <div className="workspace">
        <section className="pane" aria-labelledby="source-title" >
          <div className="pane-header">
            <h2 id="source-title" className="noselect">Source</h2>
            <button onClick={() => setSource(example)}>Reset example</button>
          </div>
          <label className="file-label noselect" htmlFor="source">main.c <span>C11</span></label>
          <textarea id="source1" value={source} onChange={(event) => setSource(event.target.value)} onSelect={(event)=> setSelectionIndex(event.target.selectionStart)} spellCheck={false} aria-label="C source code" />
        </section>
        <section className="pane graph-pane" aria-labelledby="graph-title">
          <div className="pane-header noselect"><h2 id="graph-title">Graph workspace</h2><span className="muted">Control flow</span></div>
          <div className="empty-state">
            <div className="graph-mark noselect" aria-hidden="true">◇</div>
            <h3 className="noselect">flowchart here</h3>
<svg id="FLOWCHART" viewBox={flowchartViewbox}
	onMouseDown={(event)=> setPanning(true)}
	onMouseMove={(event)=>{if (panning) { panViewbox(event.movementX, event.movementY); setViewbox([flowchart_viewbox.x,flowchart_viewbox.y,flowchart_viewbox.zoom,flowchart_viewbox.zoom]);}}}
	onWheel={(event)=>{if (event.ctrlKey) {zoomViewbox(event.nativeEvent.offsetX, event.nativeEvent.offsetY, event.deltaY); setViewbox([flowchart_viewbox.x,flowchart_viewbox.y,flowchart_viewbox.zoom,flowchart_viewbox.zoom]);}}}
>

<g fill="gray" stroke="white" strokeWidth="1.5" x="250">
<rect y="250" width="250" height="250" onMouseOver={(event)=> console.log("Here!")}/>
<text className="noselect" x="250" y="250" font="30px sans-serif" >Hello</text>
</g>

</svg>
            <p className="muted">nothing</p>
			<textarea id="source2" value={selectionIndex} disabled />
          </div>
          <div className="graph-modes" aria-label="Planned graph views">Control flow · Calls · Includes · Data dependencies</div>
        </section>
      </div>
      <footer><span>Local workspace</span><span>{source.trimEnd().split('\n').length} lines · React + TypeScript</span></footer>
    </main>
  )
}
