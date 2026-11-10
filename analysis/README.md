# Analysis

Internal backend module that manages Podman containers and produces three graph
views for C: control flow (GCC basic blocks), function calls (GCC call graph), and
include relationships (GCC preprocessor evidence). It accepts inline C, an
explicitly selected C file in a project directory, or a CMake project.

Requires Linux, local rootless Podman, and Node.js >=22.12.0 on the host.
Run commands from the repository root.

## Runtime

`AnalysisService.start()` pulls the image configured in `runtime.config.json`.
The configured registry image must contain the current graph-capable worker; older images are rejected by self-check.
Jobs run serially, each in a fresh container. Requested Debian packages are
installed in that container before analysis; the container is removed afterward.
Job inputs, logs, and outputs remain in `analysis/.jobs/<session-id>/<job-id>/`.

The developer maintains and publishes the image using `Containerfile`. Rebuild
and publish it after changing `worker/`, then configure the new image reference.
The image includes GCC, CMake, Make, binutils, Python 3, and Node.js. Python's standard
`shlex` module splits CMake compiler commands into arguments without a shell.

## Backend usage

See [Backend interface](BACKEND_INTERFACE.md) for request modes, job results,
graph output fields, failure handling, and a backend adapter example.

```js
import { AnalysisService } from './analysis/dist/index.js'

const analysis = new AnalysisService()
try {
  await analysis.start()
  const job = analysis.submit({
    schemaVersion: 1,
    operation: 'parse',
    projectDir: '/path/to/cmake-project',
    dependencies: ['zlib1g-dev'],
  })
  const completed = await analysis.wait(job.id)
  for (const artifact of completed.result?.artifacts ?? []) {
    console.log(artifact.kind, analysis.artifactPath(job.id, artifact.path))
  }
} finally {
  await analysis.shutdown()
}
```

A directory request without `entryFile` uses its root `CMakeLists.txt`. The worker
configures an out-of-source Unix Makefiles build with compilation-command export,
then analyzes every C translation unit with its own compiler flags
and working directory. Outputs include `graphs.json` and `unit-1.i`, `unit-2.i`, etc.; each source artifact
identifies its source. The same source can have multiple outputs when targets
compile it differently. See CMake's [compilation database documentation](https://cmake.org/cmake/help/latest/variable/CMAKE_EXPORT_COMPILE_COMMANDS.html).

This initial CMake path analyzes C only and does not run a full build. Headers or
sources generated only during a build must already be available. Target
selection, custom configure options/presets, and C++ analysis are not supported.
Specify includes and macros in `CMakeLists.txt`; request-level `includeDirs` and
`defines` are for explicit single-file requests.

The exported `AnalysisRequest` type describes caller input for these three modes:
inline source, a selected project file, or a CMake project. `dependencies` is
optional in every mode. `parseRequest()` returns a `NormalizedAnalysisRequest`
with an independent dependencies array and, for single-file requests, default
include paths and macros. CMake requests omit those compiler-setting fields.
You can pass either the original input or the normalized request to `submit()`;
submission always validates the request.

For inline C, use `source` instead of `projectDir`; `entryFile` defaults to
`main.c` and can be a custom relative filename. To analyze just one file in a
directory, pass `projectDir` and an explicit `entryFile`, such as `src/parser.c`.
Both single-file forms use C11 and produce `graphs.json` plus `main.i`.
`artifactPath(id)` returns `graphs.json`; pass an artifact path as the second
argument to select a preprocessed source instead.

The application backend also writes the most recent successful graph document to
`analysis/latest-graphs.json` for local inspection. Set `LEXEME_ANALYSIS_OUTPUT`
to use a different path. This inspection file is replaced after each successful
analysis and is ignored by Git.

## Limits and logs

Adjust budgets in `runtime.config.json`; the service reads it once at construction.
These defaults are application policy, not CMake, GCC, or Debian restrictions.

| Setting in `limits` | Default | Meaning |
| --- | ---: | --- |
| `sourceBytes` | 10485760 | Inline source size in UTF-8 bytes (10 MiB) |
| `includeDirs` | 128 | Explicit single-file include paths |
| `defines` | 256 | Explicit single-file macro definitions |
| `maxRequestedDependencies` | 128 | Unique requested Debian package names |
| `workerLogBytes` | 10485760 | Maximum per-job worker log size (10 MiB) |
| `errorTailBytes` | 4096 | Retained worker diagnostic and worker-command error tail |
| `artifactBytes` | 33554432 | Maximum accepted graph or intermediate file size (32 MiB) |

The existing project-copy, container, and timeout budgets are configured
in the same file. CMake-derived flags are not subject to the request-array limits.
Package names are validated before deduplication; the count limit applies afterward.
Package count does not cap transitive dependencies or installation disk usage.

Worker stdout and stderr stream to `worker.log` with backpressure. Space is reserved
within the file budget for a truncation marker; output beyond that budget is drained
and discarded. Short diagnostic tails remain available separately for errors.

## Graph output

`output/graphs.json` contains `schemaVersion: 1`, tool versions,
`translationUnits`, `files`, `includes.edges`, `calls.nodes`, `calls.edges`, and
`controlFlow` (one graph per function/compilation variant). The TypeScript shape
is exported as `GraphDocument` from [src/contracts.ts](src/contracts.ts).

Each CFG has entry, exit, and basic-block nodes. Edges represent execution flow,
including true/false branches and switch destinations where GCC supplies them.
Invisible DOT layout edges are excluded. Tree-sitter maps GCC locations back to
original C syntax and adds readable labels, semantic kinds, exact source spans,
and the original GCC label as `rawLabel`. Blocks that cannot be mapped retain their
compiler label. Function locations use available CFG locations. Exact
call-site spans and statement-level UI highlighting are not implemented.

Calls come from GCC's initial call graph, before unused functions are removed.
Calls include static and otherwise unreferenced functions. Static function IDs
are distinct across translation units. A unique external definition can resolve
a cross-file call by name; multiple definitions remain ambiguous. This is not
linker-level analysis, and function-pointer targets are not resolved. Graph
metadata records these limitations. Different build variants are retained.

Includes combine active directives from `-dI` with file-entry markers and GCC's
ordered search paths. This preserves guarded relationships that `-H` alone can
omit. Unresolved targets remain explicit; system headers can be filtered using
`files.kind`. Inactive preprocessing branches are not included.

Preprocessing uses the original build flags. CFG compilation consumes that
expanded source at `-O0`, so it does not change the project's preprocessing macros.
Tool output is captured in per-unit files under `work/`, separately from bounded
logs. GCC dumps are compiler-version-dependent: the implementation has been tested
with GCC 11/12. Other versions need fixture validation. Compiler
launchers, response files, non-GCC compilers, and C++ are currently unsupported.

## Local worker development (no GHCR push)

Build the toolchain image once from the repository root:

```sh
podman build -f analysis/Containerfile -t localhost/lexeme-analysis:dev analysis
```

If this host reports a systemd/cgroup permission failure during the build, use
`podman --cgroup-manager=cgroupfs build` with the same arguments.

Set these fields in `runtime.config.json`, retaining the other settings:

```json
{
  "image": "localhost/lexeme-analysis:dev",
  "localDevelopment": true
}
```

This mode checks the local image without pulling and mounts `analysis/worker/`
at `/app/worker` read-only. Changes to `.mjs` or the Python helper are used on the
next job: no rebuild and no push. Finish editing before submitting a job.
Rebuild the local image when installed tools or the Containerfile change.

For deployment, set `localDevelopment` to false, build/publish a new registry tag,
and configure that tag. Deployment uses the worker baked into the image.
Host-side TypeScript changes always require recompiling `analysis/src`; they do
not require a worker-image rebuild.

## Development

```sh
npm ci
npx --no-install tsc -p analysis/tsconfig.json
node --test analysis/test/*.test.mjs
npx --no-install oxlint -c .oxlintrc.json analysis/src analysis/worker analysis/test

# End-to-end request using the configured container image
node analysis/test/backend-call.mjs
```

See [request contracts](src/contracts.ts) and [test instructions](test/README.md).
