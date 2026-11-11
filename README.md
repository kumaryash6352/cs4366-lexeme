# Lexeme

Interactive C11 explorer for whole projects: control-flow, call, include, and
data-dependency graphs linked to the source. Electron + React renderer, Fastify
backend, and a TypeScript/Tree-sitter analyzer fed by GCC. Analysis runs on the
host or entirely inside a Podman container. Design: `../main.tex`. Status: `TODO.md`.

## Run

Requires Node.js 22.18+ and, for macro expansion, `gcc` (or Clang as `gcc`) on PATH.
Without a compiler the source is parsed unexpanded.

```sh
npm install
npm run dev       # backend + Vite + Electron with live reload
npm run build && npm start   # built app (also starts the backend)
npm run dev:web   # renderer only; run `npm run backend` alongside
npm test          # analyzer, container service, worker, and API tests
npm run image     # build the analysis image (localhost/lexeme-analysis:dev)
npm run test:container   # full analysis inside that image (needs Podman)
scripts/fetch-codebases.sh   # pinned cJSON + Collections-C for analysis/test/codebases.test.mjs
npm run typecheck && npm run lint
```

## Using it

- Layout: file browser | source | graph, with draggable splitters (widths are remembered).
  The browser marks analyzed units (●), counts errors/warnings per file, dims and collapses
  folders the analysis never touched (e.g. build output), filters by name, and right-click
  lists a file's functions and include-graph node. The window opens maximized.
- Nothing opens at startup. Type a project folder's absolute (or `~/…`) path and press
  **Open**, or use **Browse…** in the desktop app; **Reload** re-reads it from disk. The
  backend reads `.c`, `.h`, and `compile_commands.json` under that folder.
  Every translation unit is analyzed together: the `compile_commands.json` entries,
  else every `.c` file (or the units you tick under *Build settings*). Each unit gets
  its own flags from `compile_commands.json` plus the shared include dirs/defines/`-std`.
  Calls resolve across files; `static` functions stay private to their file.
- **Analyze** (⌘/Ctrl+Enter) re-runs the pipeline. Edits mark the graph *Source changed*.
- Click a node to highlight its source; click a source line to select its node.
- **Right-click** any node (or source line) to jump to the same place in another view:
  control flow, data dependencies, whole-program data, call graph, includes, or source,
  plus the functions a statement calls and the call sites of a function. Double-click a
  call statement to step into the callee.
- *Calls*: **+** on a function (or double-click) expands it in place into its control
  flow, drawn in its own box with call edges leaving from the statements that make them;
  **−** on the node or the box header collapses it.
- *Control flow*: **+** on a call statement (or double-click, or right-click → *Expand
  f() here*) inlines the callee's control flow at that call, in a collapsible box: the
  call flows into the callee's entry and its returns flow on to the call's successors.
  Inlined calls can be expanded further (recursion is not re-inlined). Right-click →
  *Refocus on f()* makes that function the whole view.
- *Control flow* blocks: loops, branches, switches, and straight-line runs of statements
  are drawn as nested boxes (staggered like code blocks). **Complex blocks** (default)
  boxes those scoring ≥ 8 (nodes + 2 × conditions inside) and runs of 4+ statements;
  **All blocks** boxes every one; **No blocks** turns them off. **−** on a box header
  collapses it to one node (**+** or double-click expands it again). An expanded block is
  drawn like an inlined function: an entry node with the block's header receives the flow
  into the block, inside its box. Right-click → *Refocus on block* shows only that block
  (rooted at its entry, with an *exit block* node); the breadcrumb returns to the function.
- Zoom: ⌘/Ctrl+scroll or pinch, **+ / − / 0 / F** on the canvas, **Z** or *Focus* to zoom
  to the selected node. Drag the background to pan.
- Source is syntax-highlighted (Prism C grammar).
- Data dependencies and includes use an automatic layered layout (ELK, in a web worker):
  crossing minimization, orthogonal edges, and placed edge labels. Includes run left to
  right with edges into shared headers bundled; data graphs pick the orientation that
  fits the panel; the whole-program view boxes each function and lays the boxes out by
  calls. *Program order* switches data back to statements-in-order with arcs. Graphs over
  2,500 nodes keep the built-in layout. Hover an edge for its full label.
  Search dims non-matching nodes; Enter steps through matches.
- *Calls*: double-click a function to open its control flow (the tooltip lists what it
  writes/reads through pointer parameters and globals). *Includes*: double-click a
  project file to view it.
- *Data deps*: def→use arcs in program order for one function, or **Whole program**,
  which adds argument, return-value, write-via-pointer, and global-variable flows
  between functions. Global flows follow the call graph (call site → callee for globals
  it reads, writer → call site for globals it writes), so a write in one function reaches
  a read in a sibling through their common caller. Calls through function pointers are
  not resolved. Pointers are tracked (address-of, copies, `malloc` sites, library
  calls such as `scanf`/`memset`/`memcpy`); writes through pointers that cannot be
  resolved are marked as unresolved aliases.
- Drag to pan, ⌘/Ctrl+scroll or pinch to zoom. **Export** writes SVG, PNG, or graph JSON.
- **Save / Open saved** keeps sessions (files, settings, graphs) in `~/.lexeme/sessions`.
  The current project is also kept as a local draft across reloads.
- Compiler and parse diagnostics appear under the source; click one to jump to it.

## Backend

| Route | Purpose |
| --- | --- |
| `POST /api/analyze` | `{ files, units?, includeDirs?, defines?, std? }` → `AnalysisResult` |
| `POST /api/open` | `{ path }` → `{ root, files }` read from that local folder |
| `GET/POST /api/sessions`, `GET/DELETE /api/sessions/:id` | Saved sessions |
| `GET /api/health` | Liveness and preprocessor mode |

Environment: `LEXEME_PORT` (3000), `LEXEME_DATA_DIR` (`~/.lexeme`),
`LEXEME_CC` (`gcc`), `LEXEME_PREPROCESSOR` = `auto` | `gcc` | `container` | `none`.

### Container mode

`container` runs GCC **and the analyzer** in the Podman worker. Linux uses local
rootless Podman; macOS/Windows use a rootless Podman machine (it mounts your home
directory, where job files live).

```sh
npm run image
LEXEME_PREPROCESSOR=container LEXEME_ANALYSIS_IMAGE=localhost/lexeme-analysis:dev \
LEXEME_ANALYSIS_PULL=missing npm run dev
```

Add `CONTAINER_CONNECTION=<machine>` if the machine is not Podman's default.
Without `LEXEME_ANALYSIS_PULL=missing`, the image in `analysis/runtime.config.json`
is pulled from its registry at startup.
