# Analysis

Analyzer and container runtime for Lexeme. `runPipeline()` stages a project and
analyzes every translation unit together: GCC preprocessing, Tree-sitter parsing,
and graph building (control flow, calls, includes, and intra- and inter-procedural
data dependencies with points-to). It runs on the host, or entirely inside the
Podman worker as an `analyze` job that returns `analysis.json`
(see `src/analyzer/graph-types.ts`).
CMake builds are not run; supply flags directly or via `compile_commands.json`.

The container path needs rootless Podman: local on Linux, a Podman machine on
macOS/Windows. The host path needs only `gcc`. Node.js >=22.18.0.

Build the image with `npm run image` (from the repository root); it packages
`dist/analyzer/`, `worker/`, and the pinned runtime deps in `image/package.json`.
`PodmanRuntime({ pull: 'missing' })` or `LEXEME_ANALYSIS_PULL=missing` uses a local
image instead of pulling.
Run commands from the repository root.

## Structure

```text
analysis/
  Containerfile          Developer-maintained image recipe
  src/
    analyzer/            Tree-sitter parsing, CFG, data deps, calls, includes, source maps
    pipeline.ts          Staging, compile_commands.json, preprocessing, analysis
    index.ts             Backend API
    service.ts           Container and job lifecycle
    environment.ts       Podman and image checks
    staging.ts           Copy project inputs
    contracts.ts         Request/result validation
    command.ts           Run commands
    config.ts            Image selection and paths
    limits.ts            Input limits and container defaults
    packages.ts          Per-job Debian dependency installation
  worker/main.mjs        GCC worker inside the container
  test/                  Tests and sample C projects
  tsconfig.json          TypeScript configuration
  dist/                  Generated host code
  .jobs/                 Job inputs, logs, and outputs
```

## Runtime

The backend calls `AnalysisService` to start a container, submit source or a
project directory, collect compiler output, and shut down the container.
One container serves queued jobs during an application session.

The worker image is built from `Containerfile` and pulled at startup. Set it in
`runtime.config.json` (`image`) or with `LEXEME_ANALYSIS_IMAGE`; it must be a
fully qualified registry reference. Container memory, PID limit, and job timeout
default to 512m, 128, and 60 s and can be changed through `ServiceOptions`
(`memory`, `pidsLimit`, `timeoutMs`).

## Development commands

```sh
npm ci
npx --no-install tsc -p analysis/tsconfig.json
node --test analysis/test/*.test.mjs
npx --no-install oxlint -c .oxlintrc.json analysis/src analysis/worker analysis/test

# Run one real job against local Podman (Linux only)
node analysis/test/backend-call.mjs
```

## Backend usage

```sh
node --input-type=module <<'EOF'
import { AnalysisService } from './analysis/dist/index.js'

const analysis = new AnalysisService()
try {
  await analysis.start()
  const job = analysis.submit({
    schemaVersion: 1,
    operation: 'parse',
    projectDir: 'analysis/test/project',
    entryFile: 'main.c',
  })
  const result = await analysis.wait(job.id)
  console.log(result)
  console.log('Output:', analysis.artifactPath(job.id))
  if (result.status !== 'succeeded') process.exitCode = 1
} finally {
  await analysis.shutdown()
}
EOF
```

Use `source` for inline C instead of `projectDir`. Optional `includeDirs` and
`defines` supply header paths and macros. Outputs remain in
`analysis/.jobs/<session-id>/<job-id>/output/` after shutdown.

See [request contracts](src/contracts.ts) and [test instructions](test/README.md).
