# Analysis

Run from the repository root on Ubuntu.

## Structure

```text
analysis/
  Containerfile
  src/
    setup.ts                Image preparation command
    prepare.ts              Build/pull and verify image
    installation.ts         Install Podman with apt
    environment.ts          Check Podman and image
    service.ts              Container and job lifecycle
    staging.ts              Prepare job files
    config.ts               Image name and paths
    podman.ts               Runtime checks
    command.ts              Command execution
    contracts.ts            Request/result validation
    index.ts                Backend API
  worker/main.mjs           Container worker
  test/                     Tests and sample inputs
  tsconfig.json
  dist/                     Compiled code
  .jobs/                    Job inputs and results
```

Host-side modules live directly in `src/`. The container worker remains in
`worker/`, which the Containerfile copies into the image.

With a published worker image, the backend host needs Podman and a local copy of
that image; it does not need to build the toolchain image. Set
`LEXEME_ANALYSIS_IMAGE` and run the preparation command to pull and verify it
(see Optional configuration below). `setup.ts` remains a maintenance command for
local image builds or pulling published images, separate from runtime startup.
This layout change does not add dependency-specific images or CMake build jobs.

## Setup

```sh
# This project requires Node.js >=22.12.0
curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh
sudo -E bash nodesource_setup.sh
sudo apt install -y nodejs

npm ci
npx --no-install tsc -p analysis/tsconfig.json
node analysis/dist/setup.js
```

Image: `localhost/podmananalysiscontainer` (implicit `:latest`).
Base: `docker.io/library/node:22-bookworm-slim`.
Includes GCC, Make, CMake, Python, certificates, and the worker.
Each setup run builds/verifies the image and attempts to remove the replaced image.

Setup passes the cgroup manager reported by `podman info` explicitly to the image
build. This handles older Podman/Buildah versions on WSL or terminals without a
systemd user session, where the automatic `cgroupfs` fallback can otherwise fail
at a `RUN` step with `sd-bus call: Input/output error`. If running an older compiled
setup, recompile with `npx --no-install tsc -p analysis/tsconfig.json` and rerun
`node analysis/dist/setup.js` as your normal user.

The structure covers image preparation, host-side job coordination, and container-side
execution for the current prototype. The worker currently checks C11 syntax and
preprocesses source with GCC; it does not yet produce an AST or perform further analysis.
Choose additional packages based on the analysis operations you implement.

To extend the image, edit `analysis/Containerfile`: add system packages to
`apt-get install`, other installation steps with `RUN`, and files with `COPY`.
Implement the operations that use those tools in `analysis/worker/main.mjs`.
`src/prepare.ts` orchestrates the build; `src/installation.ts` installs
Podman on the host. Installing a background service in the image does not start it:
the current worker's `--serve` mode only keeps the container alive. Any additional
service needs startup/shutdown logic. Runtime containers have networking disabled.

After Containerfile or worker changes, rerun setup and restart the analysis service
to create a container from the rebuilt image.

Manual Podman installation, if needed:

```sh
sudo apt-get update
sudo apt-get install -y podman
```

## Build and test

See [the test README](test/README.md) for coverage, prerequisites, and expected results.

```sh
# Recompile after host code changes
npx --no-install tsc -p analysis/tsconfig.json

# Rebuild after Containerfile or worker changes
node analysis/dist/setup.js

node --test analysis/test/*.test.mjs
node analysis/test/smoke.mjs
npx --no-install tsc -p analysis/tsconfig.json --noEmit
npx --no-install oxlint -c .oxlintrc.json analysis/src analysis/worker analysis/test
```

## Run the runtime

After setup, run this from the repository root. Runtime is a JavaScript API, with
no standalone runtime CLI or HTTP endpoint. This shell example invokes the API
using the supplied JSON request:

```sh
node --input-type=module <<'EOF'
import { readFile } from 'node:fs/promises'
import { AnalysisService } from './analysis/dist/index.js'

const analysis = new AnalysisService()
try {
  await analysis.start()
  const request = JSON.parse(await readFile('analysis/test/parse-request.json', 'utf8'))
  const job = analysis.submit(request)
  const completed = await analysis.wait(job.id)
  console.log(JSON.stringify(completed, null, 2))
  if (completed.status === 'succeeded') {
    console.log('Preprocessed source:', analysis.artifactPath(job.id))
  } else {
    process.exitCode = 1
  }
} finally {
  await analysis.shutdown()
}
EOF
```

For backend integration, import the same `AnalysisService`, await `start()` on app
startup, call `submit()` per request, and await `shutdown()` on exit. One session
owns one persistent container and processes jobs serially. Runtime checks the
prepared environment, stages files, invokes the worker, and collects results;
it never installs packages, builds, or pulls images.

Use `get(id)` to inspect progress, `wait(id)` to await completion, `cancel(id)` to
request cancellation, and `artifactPath(id)` to get the successful output's host
path. The default job timeout is 60 seconds; configure it with
`new AnalysisService({ timeoutMs: 120_000 })` (allowed range: 1–600,000 ms).

### Runtime input

`submit()` accepts a JavaScript object with this JSON shape. The full validation
contract is in `analysis/src/contracts.ts`.

```json
{
  "schemaVersion": 1,
  "operation": "parse",
  "source": "int main(void) { return 0; }",
  "entryFile": "main.c",
  "includeDirs": ["."],
  "defines": ["DEBUG", "LIMIT=10"]
}
```

| Field | Requirement |
| --- | --- |
| `schemaVersion` | Required; must be `1`. |
| `operation` | Required; must be `"parse"` (currently syntax checking and preprocessing). |
| `source` | Inline source string, at most 1 MiB. Provide exactly one of `source` or `projectDir`. |
| `projectDir` | Alternative to `source`: directory on the backend host, copied into the job directory. Relative paths resolve from the host process's working directory. |
| `entryFile` | Project-relative `.c` path; defaults to `"main.c"`. |
| `includeDirs` | Up to 32 project-relative include paths; defaults to `["."]`. |
| `defines` | Up to 32 `NAME` or `NAME=value` strings, each at most 256 characters; defaults to `[]`. |

For example, to analyze the bundled project with a local header:

```json
{
  "schemaVersion": 1,
  "operation": "parse",
  "projectDir": "analysis/test/test_cfiles/local-header",
  "entryFile": "main.c"
}
```

Project-relative paths cannot escape the source directory with `..` or use absolute
paths or backslashes. Project copying skips `.git`, `node_modules`, and the jobs
root; rejects symbolic links and non-regular files; and limits input to 1,000 files,
10 MiB, and 32 directory levels. Invalid request objects throw from `submit()`;
staging or execution failures appear in the job snapshot.

### Runtime output

`submit()` immediately returns a queued `JobSnapshot`. `wait(id)` returns the
completed snapshot, for example (IDs and timestamps vary):

```json
{
  "id": "2c63858d-e617-4e4e-87fa-c0799471549d",
  "status": "succeeded",
  "events": [
    {
      "at": "2026-10-28T12:00:00.000Z",
      "stage": "staging",
      "message": "Writing the backend request into this job directory"
    }
  ],
  "result": {
    "schemaVersion": 1,
    "jobId": "2c63858d-e617-4e4e-87fa-c0799471549d",
    "status": "succeeded",
    "artifacts": [{ "kind": "preprocessed-source", "path": "main.i" }],
    "diagnostics": []
  }
}
```

The example abbreviates `events`; actual snapshots include additional progress
and completion events. Job statuses are `queued`, `preparing`, `running`,
`succeeded`, `failed`, `cancelled`, and `timed-out`. `result` is optional and contains
the worker's result when available; its status is only `succeeded` or `failed`.
Worker failures report diagnostics as `{ "stage": "...", "message": "..." }`.
Host-side failures, cancellations, and timeouts can instead have an `error` string
without a `result`. Check the snapshot's `status` to determine the overall outcome.

Files are retained under `analysis/.jobs/<session-id>/<job-id>/` by default:

```text
input/source/       Copied project files or the inline source
input/request.json Internal worker request
work/              Reserved working directory
output/result.json Worker result, if produced
output/main.i      Preprocessed C source on success
worker.log         Captured diagnostics/logs, when present
```

Artifact paths in `result` are relative to the job's `output/` directory.
`artifactPath(id)` returns the host path to `main.i` for a successful job, or
`undefined` otherwise. Shutdown removes the container but retains the job files.

The internal worker request differs from the public input: staging writes
`schemaVersion`, `jobId`, `operation: "preprocess"`, `languageStandard: "c11"`,
`entryFile`, `includeDirs`, and `defines`. The session's jobs directory is mounted
at `/jobs`; runtime invokes the worker with `--job <job-id> --timeout-ms <timeout>`.
Callers should use the public `submit()` contract above.

## Manual container

```sh
podman --version
podman info
podman images
mkdir -p analysis/.jobs/manual
podman run -d --name analysis-dev --pull=never --network=none \
  --userns=keep-id -v "$PWD/analysis/.jobs/manual:/jobs:Z" \
  localhost/podmananalysiscontainer
podman ps
podman exec analysis-dev node /app/worker/main.mjs --self-check
podman logs analysis-dev
podman stop analysis-dev
podman rm analysis-dev
```

## Optional configuration

```sh
LEXEME_AUTO_INSTALL_PODMAN=0 node analysis/dist/setup.js

# Custom worker image (setup pulls instead of building)
export LEXEME_ANALYSIS_IMAGE=registry.example.com/team/analysis:latest
node analysis/dist/setup.js
```
