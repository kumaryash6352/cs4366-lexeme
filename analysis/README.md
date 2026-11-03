# Analysis

Internal backend module that manages Podman containers and runs GCC.
Currently performs C11 syntax checks and preprocessing. Output is
`main.i`; automatic dependency installation, CMake builds, and AST parsing are
not implemented yet.

Requires Linux, local rootless Podman, and Node.js >=22.12.0 on the host.
Run commands from the repository root.

## Structure

```text
analysis/
  Containerfile          Developer-maintained image recipe
  src/
    index.ts             Backend API
    service.ts           Container and job lifecycle
    environment.ts       Podman and image checks
    staging.ts           Copy project inputs
    contracts.ts         Request/result validation
    command.ts           Run commands
    config.ts            Image name and paths
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

Developer-maintained image: `ghcr.io/mmaa304603/analysiscontainer:v1`, configured
in `src/config.ts`. The backend deployment must have this image in local Podman
storage; image distribution is handled by the developer.

## Development commands

```sh
npm ci
npx --no-install tsc -p analysis/tsconfig.json
node --test analysis/test/*.test.mjs
npx --no-install oxlint -c .oxlintrc.json analysis/src analysis/worker analysis/test

# Integration test against the deployed container environment
node analysis/test/smoke.mjs
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
    projectDir: 'analysis/test/test_cfiles/local-header',
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
