# Backend interface

Import `AnalysisService` from `analysis/dist/index.js`.
Types: [AnalysisRequest, JobSnapshot, GraphDocument](src/contracts.ts).

**Input** — include `schemaVersion: 1` and `operation: 'parse'`:

- Inline C: `source`.
- One project file: `projectDir` + `entryFile`.
- CMake project: `projectDir` only; requires `CMakeLists.txt`.

Optional: `dependencies` (Debian packages). Single-file requests also accept
`includeDirs` and `defines`; CMake supplies its own compiler settings.
Project directories must exist on the backend host.

**Usage** (imports relative to the repository root):

```js
import { readFile } from 'node:fs/promises'
import { AnalysisService } from './analysis/dist/index.js'

const analysis = new AnalysisService()
await analysis.start() // Once at backend startup.

const submitted = analysis.submit({
  schemaVersion: 1,
  operation: 'parse',
  source: 'int main(void) { return 0; }',
})
const job = await analysis.wait(submitted.id)

if (job.status === 'succeeded') {
  const graphs = JSON.parse(await readFile(analysis.artifactPath(job.id), 'utf8'))
  // Send graphs to the frontend.
} else {
  // Report job.error and job.result?.diagnostics.
}

// await analysis.shutdown() when the backend stops.
```

**Output:** `job` contains status, events, an optional result manifest, and an
optional error. `graphs.json` contains `files`, `translationUnits`, `controlFlow`,
`calls`, `includes`, tool versions, and limitations. Graph data is read separately;
there is no automatic HTTP response.

Use `get(id)` to poll and `cancel(id)` to request cancellation. Terminal statuses
are `succeeded`, `failed`, `cancelled`, and `timed-out`. Invalid submissions and
startup failures throw; accepted job failures normally arrive in `job`.

Each job container is removed afterward. Files remain in `analysis/.jobs/`;
job records are in memory. See [README](README.md) for runtime setup and limits.
