import { useState, useRef } from 'react'
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

type Selection = {
	filename: string;
	start: number;
	end: number;
};
type Node = {
	name: string;
	kind: 'endpoint' | 'process' | 'conditional' | 'io';
	index: Selection;
	children?: number[];
};
const graphExample : Node[] = [
	{name: "Start", kind:'endpoint', index:{filename:"main.c", start:0, end:93}, children:[1]},
	{name: "something something", kind:'process', index:{filename:"main.c", start:94, end:299}, children:[2]},
	{name: "something something", kind:'conditional', index:{filename:"main.c", start:300, end:676}, children:[3,4]},
	{name: "something something", kind:'io', index:{filename:"main.c", start:300, end:676}, children:[5]},
	{name: "something something", kind:'io', index:{filename:"main.c", start:300, end:676}, children:[5,2]},
	{name: "End", kind:'endpoint', index:{filename:"main.c", start:677, end:740}, children:null}
];

function FlowBox({block, x, y} : ReactNode) {
	const highlightColour="#77B", normalColour="#559";
	const sourceCode = document.getElementById("SOURCECODE");
	
	const points = [
		[[-80,-75], [80,-75], [100,-55], [100,55], [80,75], [-80,75], [-100,55], [-100,-55]],
		[[-100,-75], [100,-75], [100,75], [-100,75]],
		[[-100,0], [0,-75], [100,0], [0,75]],
		[[-80,-75], [120,-75], [80,75], [-120,75]]
	][['endpoint', 'process', 'conditional', 'io'].indexOf(block.kind)];
	for (let i = 0; i < points.length; i++) {
		points[i][0] += x;
		points[i][1] += y;
	}
	
	return (
		<g className="box" fill={normalColour} stroke="white" strokeWidth="1.5">
			<polygon points={points}
				onMouseOver={(event) => {event.currentTarget.setAttribute("fill", highlightColour);}}
				onMouseOut={(event) => {event.currentTarget.setAttribute("fill", normalColour);}}
				onClick={(event) => {
					sourceCode.focus();
					sourceCode.setAttribute("file", block.index.filename);
					sourceCode.setSelectionRange(block.index.start,block.index.end);
				}}
			/>
			<text className="noselect" x={x} y={y} font="sans-serif" textAnchor="middle">{block.name}</text>
		</g>
	);
};
function Arrow({x1,y1,x2,y2, text} : ReactNode) {
	const arrow = [];
	const targetOffset_x = (x1 == x2) ? 0 : (x1 > x2) ? 35 : -35;
	const targetOffset_y = (y1 == y2) ? 0 : (y1 > y2) ? 85 : -85;
	
	arrow.push(<path key="1"
		d= {`M ${x1} ${y1} L ${x2+targetOffset_x} ${y2+targetOffset_y}`}
		strokeWidth="2"
		stroke="white"
		fill="none"
		markerEnd="url(#arrow)"
	/>);
	if (text != undefined)
		arrow.push(<text key="2" stroke="white" className="noselect" x={(x1+x2)/2} y={(y1+y2)/2}>{text}</text>);
	return arrow;
}

function FlowChart({graph, startNode} : ReactNode) {
	const nodes = [], arrows = [];
	const queue = [graph[startNode]], visited = new Array(graph.length);
	let i = 0;
	visited[startNode] = {x:0,y:100,i:i};
	while (queue.length > 0) {
		let node = queue.pop();
		let position = visited[graph.indexOf(node)];
		nodes.push(<FlowBox key={position.i} block={node} x={position.x} y={position.y}/>);
		if (node.children != null) for (let child = node.children.length-1; child >= 0; child--) {
			if (visited[node.children[child]] == undefined) {
				visited[node.children[child]] = {x:position.x+child*300,y:position.y+200,i:++i};
				queue.push(graph[node.children[child]]);
				arrows.push(<Arrow key={++i} x1={position.x} y1={position.y} x2={position.x+child*300} y2={position.y+200}/>);
			}
			else 
				arrows.push(<Arrow key={++i} x1={position.x} y1={position.y} x2={visited[node.children[child]].x} y2={visited[node.children[child]].y}/>);
		}
	}
	
	
	return [...arrows, ...nodes];
};


const isPanning = false;
const viewboxBoundaries = {xMin: -1000, xMax: 200, yMin: -800, yMax: 1000, zoomMin: 10, zoomMax: 1000};
const flowchart_viewbox = {x:(viewboxBoundaries.xMax + viewboxBoundaries.xMin) / 2, y:0, zoom:1000};
export default function App() {
	const [source, setSource] = useState(example);
	const [selectionIndex, setSelectionIndex] = useState(0);
	const [panning, setPanning] = useState(isPanning);
	const [flowchartViewbox, setViewbox] = useState([flowchart_viewbox.x, flowchart_viewbox.y, flowchart_viewbox.zoom, flowchart_viewbox.zoom]);
	
	const flowchartRef = useRef(null);
	
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
		
		flowchart_viewbox.x += (cx / flowchartRef.current.getBoundingClientRect().width) * zmOffset;
		flowchart_viewbox.y += (cy / flowchartRef.current.getBoundingClientRect().height) * zmOffset;
		
		if (viewboxBoundaries.xMin > flowchart_viewbox.x) flowchart_viewbox.x = viewboxBoundaries.xMin;
		else if (viewboxBoundaries.xMax < flowchart_viewbox.x) flowchart_viewbox.x = viewboxBoundaries.xMax;
		if (viewboxBoundaries.yMin > flowchart_viewbox.y) flowchart_viewbox.y = viewboxBoundaries.yMin;
		else if (viewboxBoundaries.yMax < flowchart_viewbox.y) flowchart_viewbox.y = viewboxBoundaries.yMax;
	}
	
	
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
						<button onClick={() => {setSource(example); genFlowchart();}}>Reset example</button>
					</div>
					<label className="file-label noselect" htmlFor="source">main.c <span>C11</span></label>
					<textarea id="SOURCECODE" value={source} onChange={(event) => setSource(event.target.value)} onSelect={(event)=> setSelectionIndex(event.target.selectionStart)} spellCheck={false} aria-label="C source code" />
				</section>
				<section className="pane graph-pane" aria-labelledby="graph-title">
					<div className="pane-header noselect"><h2 id="graph-title">Graph workspace</h2><span className="muted">Control flow</span></div>
					<div className="empty-state"	>
						<svg id="FLOWCHART" viewBox={flowchartViewbox} ref={flowchartRef}
							onMouseDown={(event)=> setPanning(true)}
							onMouseMove={(event)=>{if (panning) { panViewbox(event.movementX, event.movementY); setViewbox([flowchart_viewbox.x,flowchart_viewbox.y,flowchart_viewbox.zoom,flowchart_viewbox.zoom]);}}}
							onWheel={(event)=>{if (event.ctrlKey) {zoomViewbox(event.nativeEvent.offsetX, event.nativeEvent.offsetY, event.deltaY); setViewbox([flowchart_viewbox.x,flowchart_viewbox.y,flowchart_viewbox.zoom,flowchart_viewbox.zoom]);}}}
						>
						<defs>
							<marker
								id="arrow"
								viewBox="-5 0 10 10"
								refX="5"
								refY="5"
								markerWidth="6"
								markerHeight="6"
								orient="auto-start-reverse"
							>
							<path d="M -5 0 L 5 5 L -5 10 z" fill="white"/>
							</marker>
						</defs>
						<FlowChart graph={graphExample} startNode={0}/>
							
							
						</svg>
					</div>
					<div className="graph-modes" aria-label="Planned graph views">Control flow · Calls · Includes · Data dependencies</div>
				</section>
			</div>
			<footer><span>Local workspace</span><span>{source.trimEnd().split('\n').length} lines · React + TypeScript</span></footer>
		</main>
	)
}

