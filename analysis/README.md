# Analysis

Internal backend module that manages Podman containers and runs C syntax checks
and preprocessing. It accepts inline C, an explicitly selected C file in a
project directory, or a CMake project. AST parsing is not implemented yet.

Requires Linux, local rootless Podman, and Node.js >=22.12.0 on the host.
Run commands from the repository root.

## Runtime

`AnalysisService.start()` pulls the image configured in `runtime.config.json`.
The default image is `ghcr.io/mmaa304603/analysiscontainer:v1`.
Jobs run serially, each in a fresh container. Requested Debian packages are
installed in that container before analysis; the container is removed afterward.
Job inputs, logs, and outputs remain in `analysis/.jobs/<session-id>/<job-id>/`.

The developer maintains and publishes the image using `Containerfile`. Rebuild
and publish it after changing `worker/`, then configure the new image reference.
The image includes GCC, CMake, Make, Python 3, and Node.js. Python's standard
`shlex` module splits CMake compiler commands into arguments without a shell.

## Backend usage

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
    console.log(artifact.source, analysis.artifactPath(job.id, artifact.path))
  }
} finally {
  await analysis.shutdown()
}
```

A directory request without `entryFile` uses its root `CMakeLists.txt`. The worker
configures an out-of-source Unix Makefiles build with compilation-command export,
then checks and preprocesses every C translation unit with its own compiler flags
and working directory. Outputs are `unit-1.i`, `unit-2.i`, etc.; each artifact
identifies its source. The same source can have multiple outputs when targets
compile it differently. See CMake's [compilation database documentation](https://cmake.org/cmake/help/latest/variable/CMAKE_EXPORT_COMPILE_COMMANDS.html).

This initial CMake path analyzes C only and does not run a full build. Headers or
sources generated only during a build must already be available. Target
selection, custom configure options/presets, and C++ analysis are not supported.
Specify includes and macros in `CMakeLists.txt`; request-level `includeDirs` and
`defines` are for explicit single-file requests.

For inline C, use `source` instead of `projectDir`; `entryFile` defaults to
`main.c` and can be a custom relative filename. To analyze just one file in a
directory, pass `projectDir` and an explicit `entryFile`, such as `src/parser.c`.
Both single-file forms use C11 and produce `main.i`. `artifactPath(id)` returns
the first artifact; pass its path as the second argument to select another.

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

The existing project-copy, session, container, and timeout budgets are configured
in the same file. CMake-derived flags are not subject to the request-array limits.
Package names are validated before deduplication; the count limit applies afterward.
Package count does not cap transitive dependencies or installation disk usage.

Worker stdout and stderr stream to `worker.log` with backpressure. Space is reserved
within the file budget for a truncation marker; output beyond that budget is drained
and discarded. Short diagnostic tails remain available separately for errors.

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
