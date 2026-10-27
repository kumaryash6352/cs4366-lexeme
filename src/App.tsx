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

export default function App() {
  const [source, setSource] = useState(example)
  return (
    <main className="app">
      <header className="toolbar">
        <div className="brand"><span className="logo">🐟</span><h1>lexeme</h1></div>
        <span className="subtitle">code explorer</span>
        <span className="badge">Workspace starter</span>
      </header>
      <div className="workspace">
        <section className="pane" aria-labelledby="source-title">
          <div className="pane-header">
            <h2 id="source-title">Source</h2>
            <button onClick={() => setSource(example)}>Reset example</button>
          </div>
          <label className="file-label" htmlFor="source">main.c <span>C11</span></label>
          <textarea id="source" value={source} onChange={(event) => setSource(event.target.value)} spellCheck={false} aria-label="C source code" />
        </section>
        <section className="pane graph-pane" aria-labelledby="graph-title">
          <div className="pane-header"><h2 id="graph-title">Graph workspace</h2><span className="muted">Control flow</span></div>
          <div className="empty-state">
            <div className="graph-mark" aria-hidden="true">◇</div>
            <h3>flowchart here</h3>
            <p className="muted">i didn\'t do this part</p>
          </div>
          <div className="graph-modes" aria-label="Planned graph views">Control flow · Calls · Includes · Data dependencies</div>
        </section>
      </div>
      <footer><span>Local workspace</span><span>{source.trimEnd().split('\n').length} lines · React + TypeScript</span></footer>
    </main>
  )
}
