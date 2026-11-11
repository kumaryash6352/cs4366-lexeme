# TODO

Status against `../main.tex`.

## Done
- [x] Multi-file projects: every translation unit (from `compile_commands.json`, else all `.c`, or a chosen subset) is preprocessed with its own flags and analyzed as one program; calls resolve across files with `static` linkage respected; headers and globals are shared.
- [x] Analysis inside the container: the worker image ships the compiled analyzer; `analyze` jobs run GCC and Tree-sitter in the container and return `analysis.json`. Verified on a rootless Podman machine (`npm run test:container`).
- [x] Data dependencies: reaching definitions over abstract locations, with flow-insensitive points-to (address-of, pointer copies, allocation sites, pointer arithmetic), library effect models (`scanf`, `memset`, `memcpy`, `strcpy`, …, including fortified `__builtin___*_chk`), and per-function mod/ref summaries iterated to a fixpoint over the call graph.
- [x] Whole-program data graph: argument → parameter, return value → call site, write-via-pointer → call site, and global-variable flows between functions.
- [x] Statement-level CFG, call graph, include graph, source maps with original (unexpanded) labels, diagnostics, fallback to unexpanded parsing.
- [x] Renderer: four views plus whole-program data view, unit selection, bidirectional linking, search, pan/zoom, export (SVG/PNG/JSON), sessions, local draft.
- [x] Tests: 50 host tests (`npm test`) plus the container integration test.

## Open (lower priority)
- [ ] Field-sensitive and heap-stored pointers (pointers inside structs/arrays, linked structures).
- [ ] Context sensitivity: summaries merge all call sites of a function.
- [ ] Publish the worker image to a registry and set `analysis/runtime.config.json` (currently a placeholder; use `npm run image` + `LEXEME_ANALYSIS_PULL=missing`).
- [ ] Stretch: Canvas renderer and measured 60/30 fps at 1,000 nodes (SVG now).
- [ ] Stretch: Content-Security-Policy for the packaged renderer.
- [ ] Stretch: installers/signing; bundling the backend into the Electron app.
