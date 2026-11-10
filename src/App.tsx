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
	children?: number[] | null;
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


//Each file stores file name and content
type SourceFile = {
  name: string;
  path: string;
  content: string;
};


const isPanning = false;
const viewboxBoundaries = {xMin: -1000, xMax: 200, yMin: -800, yMax: 1000, zoomMin: 10, zoomMax: 1000};
const flowchart_viewbox = {x:(viewboxBoundaries.xMax + viewboxBoundaries.xMin) / 2, y:0, zoom:1000};

export default function App() {
  //const [source, setSource] = useState(example);  //will not be needed when managing through files, but keeping for now

  const [selectionIndex, setSelectionIndex] = useState(0);
	const [panning, setPanning] = useState(isPanning);
	const [flowchartViewbox, setViewbox] = useState([flowchart_viewbox.x, flowchart_viewbox.y, flowchart_viewbox.zoom, flowchart_viewbox.zoom]);

  const flowchartRef = useRef<SVGSVGElement | null>(null);

  //stores source files loaded in workspace
  const [files, setFiles] = useState<SourceFile[]>([
    { name: "main.c", path: "main.c", content: example },
    { name: "calculate.c", path: "calculate.c", content: "//Example code" },
  ]);

  //Tracks which file is curretnly selected (default is main.c)
  const [activeFile, setActiveFile] = useState("main.c");

  //Finds currently selected
  const currentFile = files.find(file => file.path === activeFile);
  
  //Tracks is backend is currently analyzing project
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  //Stores error returned by backend or network request
  const [analysisError, setAnalysisError] = useState("");

  //Stores graoh data returned by backend
  const [analysisResult, setAnalysisResult] = useState<unknown>(null);

  async function analyzeProject() {
    setIsAnalyzing(true);
    setAnalysisError("");
    setAnalysisResult(null);

    try {
      const response = await fetch("http://localhost:3000/analyze", { //Example endpoint. Replace endpoint when known
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        //Sends every file with name, path, and content
        body: JSON.stringify({
          files: files
        })
      });
      //Check if backend successfully processed request
      if (!response.ok) {
        throw new Error( `Backend error: ${response.status}`);
      }
      //Read graoh data returned by backend
      const result = await response.json();
      setAnalysisResult(result);
      console.log("Analysis result: ", result);
    } catch (error) {
      console.error("Analysis failed:", error);
      setAnalysisError(
        error instanceof Error ? error.message : "Unknown anaysis error"
      );
    } finally {
      //Stop displaying loading state
      setIsAnalyzing(false);
    }
  }

  function createNewFile() {
    const fileName = window.prompt("Enter a filename");
    
    if (!fileName || !fileName.trim()) return;
    const cleanName = fileName.trim();
    //Prevent duplicate filenames in workspace
    if (files.some(file => file.path === cleanName)) {
      alert("A file with this name already exists");
      return;
    }

    const newFile: SourceFile = {
      name: cleanName,
      path: cleanName,
      content: ""
    };
    //Automatically selects created file
    setFiles(previousFiles => [...previousFiles, newFile]);
    setActiveFile(newFile.path);
  }

  //Reads selected file and adds to workspace
  async function importFiles(selectedFiles: FileList | null) {
    if (!selectedFiles) return;

    const importedFiles: SourceFile[] = await Promise.all(
      Array.from(selectedFiles).map(async file => ({
        name: file.name,
        //Preserves folder structure
        //Individual file uses filename
        path: (file as any).webkitRelativePath || file.name,
        //Reads from selected file
        content: await file.text()
      }))
    );

    //Add imported files and replace existing files that have same path
    setFiles(previousFiles => {
      const updatedFiles = [...previousFiles];

      importedFiles.forEach(importedFile => {
        const existingIndex = updatedFiles.findIndex(
          file => file.path === importedFile.path
        );

        if (existingIndex >= 0) {
          updatedFiles[existingIndex] = importedFile;
        } else {
          updatedFiles.push(importedFile);
        }
      });
      return updatedFiles;
    });
    //Automatically open
    if (importedFiles.length > 0) {
      setActiveFile(importedFiles[0].path);
    }
  }

  //Downloads current workspace as JSON project file
  function exportProject() {
    const project = {
      projectName: "My Lexeme Project",
      files: files
    };
    //Convert project object into formatted JSON text
    const json = JSON.stringify(project, null, 2);
    //Create downloadable file
    const blob = new Blob([json], {
      type: "application/json"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "lexeme-project.json";
    link.click();
    //Release URL
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
    
  }

  //Loads previously exported Lexeme JSON project
  async function importProject(file: File | undefined) {
    if(!file) return;
    try {
      const text = await file.text();
      const project = JSON.parse(text);

      //Basic validation of imprted project
      if (
        !project ||
        !Array.isArray(project.files) ||
        !project.files.every((item: any) =>
          typeof item.name === "string" &&
          typeof item.path === "string" &&
          typeof item.content === "string"
        )
      ) {
        throw new Error("Invalid Lexeme project file");
      }
      //Replace current workpace with imported project
      setFiles(project.files);
      //Select first file in imported project
      setActiveFile(project.files[0]?.path ?? "");
    } catch (error) {
      alert("Could not import project");
      console.error(error);
    }
  }
  function panViewbox(dx : number, dy : number) : void {
		flowchart_viewbox.x -= dx * flowchart_viewbox.zoom / 1000;
		flowchart_viewbox.y -= dy * flowchart_viewbox.zoom / 1000;
		
		if (viewboxBoundaries.xMin > flowchart_viewbox.x) flowchart_viewbox.x = viewboxBoundaries.xMin;
		else if (viewboxBoundaries.xMax < flowchart_viewbox.x) flowchart_viewbox.x = viewboxBoundaries.xMax;
		if (viewboxBoundaries.yMin > flowchart_viewbox.y) flowchart_viewbox.y = viewboxBoundaries.yMin;
		else if (viewboxBoundaries.yMax < flowchart_viewbox.y) flowchart_viewbox.y = viewboxBoundaries.yMax;
	}
	function zoomViewbox(cx : number, cy : number, zm : number) : void {
		if (!flowchartRef.current) return;
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
            {/*Restores main.c to original content*/}
            <button onClick={() => {
              setFiles(previousFiles =>
                previousFiles.map(file => 
                  file.path === "main.c"
                  ? {... file, content: example }
                  : file
                )
              );
            }}>
              Reset example
            </button>
            <button onClick={createNewFile}>
              + New File
            </button>
          </div>
          
          <div className="file-tabs"> {/*creates a selectable tab for each file*/}
            {files.map(file => (
              <button
                key={file.path}
                className={activeFile === file.path ? "active-tab" : ""} 
                onClick={() => setActiveFile(file.path)}
              >
                {file.name}
              </button>
            ))}
          </div>

          <div className="file-actions">
            {/* Import individual .c and .h files */}
            <label>
              Import Files
              <input
                type="file"
                multiple
                accept=".c,.h"
                onChange={event => {
                  void importFiles(event.target.files);
                  event.target.value = "";
                }}
                />
            </label>

            {/*Import and entire project folder */}
            <label>
              Import Folder
              <input
                type="file"
                multiple
                accept=".c,.h"
                {...({webkitdirectory: ""} as any)}
                onChange={event => {
                  void importFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
          </div>

          <div className="project-actions">
            <button onClick={exportProject}>
              Export Project
            </button>
            <label>
              Import Project
              <input
                type="file"
                accept=".json,application/json"
                onChange={event => {
                  void importProject(event.target.files?.[0]);
                  event.target.value = "";
                }}
                />
            </label>
          </div>

          <button
            onClick={analyzeProject}
            disabled={isAnalyzing || files.length === 0}
          >
            {isAnalyzing ? "Analyzing..." : "Analyze Project"}
          </button>

          {analysisError && (
            <p className="error-message">
              Analysis failed: {analysisError}
            </p>
          )}
          {analysisResult != null && (
            <p className="success-message">
              Analysis completed successfully
            </p>
          )}

            {/* Displays the filename of selected or no file selected*/}
          <label className="file-label noselect" htmlFor="source1">
            {currentFile?.name ?? "No file sleected"} <span>C11</span>
          </label>

          {/*Displays contents of current file*/}
          {/*Updates file object when code is edited*/}
          {/*Tracks selected text position for interactive code-to-graph*/}
          <textarea
            id="source1"
            value={currentFile?.content ?? ""}
            onChange={(event) => {
              const newContent = event.target.value;

              {/*Creates updated file array*/}
              setFiles(previousFiles =>
                previousFiles.map(file =>
                  file.path === activeFile
                  ? {...file, content: newContent }
                  : file
                )
              );
            }}
            onSelect={(event) => setSelectionIndex(event.target.selectionStart)}
            spellCheck={false}
            aria-label="C source code"
          />
        </section>
        <section className="pane graph-pane" aria-labelledby="graph-title">
          <div className="pane-header noselect"><h2 id="graph-title">Graph workspace</h2><span className="muted">Control flow</span></div>
          <div className="empty-state">
            <div className="graph-mark noselect" aria-hidden="true">◇</div>
            <h3 className="noselect">flowchart here</h3>
            <svg id="FLOWCHART" viewBox={flowchartViewbox.join(" ")} ref={flowchartRef}
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


</svg>
            <p className="muted">nothing</p>
			<textarea id="source2" value={selectionIndex} disabled />
          </div>
          <div className="graph-modes" aria-label="Planned graph views">Control flow · Calls · Includes · Data dependencies</div>
        </section>
      </div>
      {/*Displays number of lines in file and updates line count*/}
      <footer>
        <span>Local workspace</span>
        <span>{currentFile?.content.trimEnd().split('\n').length ?? 0} lines · React + TypeScript</span>
      </footer>
    </main>
  )
}

