# C Analysis Engine

A Node.js backend module that analyzes C source and produces three graphs:

- **Control flow:** basic blocks and execution paths within each function.
- **Function calls:** caller-to-callee relationships.
- **Includes:** source and header dependencies for the selected build configuration.

The engine returns graph data for a frontend to render. See the
[backend interface](BACKEND_INTERFACE.md) for request types and API methods.

## Setup

Requires Linux, local rootless Podman, and Node.js 22.12 or newer.
Run these commands from the repository root:

```sh
npm ci
npx --no-install tsc -p analysis/tsconfig.json
podman build -f analysis/Containerfile -t localhost/lexeme-analysis:dev analysis
```

The included [runtime configuration](runtime.config.json) uses this local image
with `localDevelopment: true`, which mounts `analysis/worker/` into each container.
For a packaged worker image, set `image` to its registry reference and
`localDevelopment` to `false`; startup then pulls the image and uses its bundled worker.

The same configuration controls timeouts, container resources, input limits,
and artifact sizes. The service reads it when constructed.

## Usage

```js
import { readFile } from 'node:fs/promises'
import { AnalysisService } from './analysis/dist/index.js'

const analysis = new AnalysisService()
try {
  await analysis.start()
  const submitted = analysis.submit({
    schemaVersion: 1,
    operation: 'parse',
    source: 'int main(void) { return 0; }',
  })
  const job = await analysis.wait(submitted.id)

  if (job.status === 'succeeded') {
    const path = analysis.artifactPath(job.id, 'graphs.json')
    const graphs = JSON.parse(await readFile(path, 'utf8'))
    console.log(graphs)
  } else {
    console.error(job.status, job.error, job.result?.diagnostics)
  }
} finally {
  await analysis.shutdown()
}
```

In a backend application, share one service instance: start it when the backend
starts and shut it down when the backend stops. Jobs run serially.

| Input | Request fields |
| --- | --- |
| Inline C | `source`; optional `entryFile` defaults to `main.c` |
| One project file | `projectDir` and `entryFile` |
| CMake project | `projectDir` containing a root `CMakeLists.txt` |

Project paths refer to the backend host. Single-file requests may specify
`includeDirs` and `defines`; CMake projects obtain these from their build settings.
Optional `dependencies` lists Debian packages to install in the job container.

## Results

Each job uses a fresh container, removed after completion. Files remain under
`analysis/.jobs/<session-id>/<job-id>/` until removed by the application or operator.

| File | Contents |
| --- | --- |
| `output/result.json` | Status, artifact references, and diagnostics |
| `output/graphs.json` | `controlFlow`, `calls`, `includes`, `files`, compilation metadata, and limitations |
| `output/main.i` or `output/unit-N.i` | Preprocessed C source |
| `worker.log` | Bounded worker output |

`wait()` returns job metadata. The backend reads graph data using `artifactPath()`;
there is no automatic HTTP response. The output type is
[`GraphDocument`](src/contracts.ts).

## Scope and limitations

- Intended for trusted local source projects; this is not a hardened service for untrusted uploads.
- C and GCC are supported. Single-file requests use C11. C++, compiler launchers,
  and compiler response files are unsupported.
- CMake is configured without a full project build. Files generated only during
  a build must already be available; custom presets and target selection are unsupported.
- CFGs describe GCC basic blocks, not exact source statement ranges. Function-pointer
  call targets are unresolved, and inactive preprocessor branches are omitted.
- GCC output formats vary by version; graph parsing has been tested with GCC 11/12.
