// Runs the full analysis inside the Podman worker image. Opt-in: needs Podman and the image.
//   npm run test:container   # builds localhost/lexeme-analysis:dev on first use
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AnalysisService, runPipeline } from '../dist/index.js'
import { PodmanRuntime } from '../dist/environment.js'

const root = fileURLToPath(new URL('./fixtures/multi/', import.meta.url))
async function load(dir = root, out = [], base = dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await load(path, out, base)
    else out.push({ path: relative(base, path), text: await readFile(path, 'utf8') })
  }
  return out
}

const image = process.env.LEXEME_ANALYSIS_IMAGE ?? 'localhost/lexeme-analysis:dev'
// localhost/ images are built on demand by PodmanRuntime if missing.
const service = new AnalysisService({ environment: new PodmanRuntime({ image }) })
before(() => service.start())
after(() => service.shutdown())

test('multi-unit project analyzed in the container', async () => {
  const r = await runPipeline({ files: await load() }, { preprocessor: 'container', service })
  assert.equal(r.runtime, 'container')
  assert.deepEqual(r.units.map(u => [u.file, u.preprocessed]), [['src/main.c', true], ['src/counter.c', true]])
  assert.deepEqual(r.diagnostics.filter(d => d.severity === 'error'), [])
  assert.deepEqual(r.functions.map(f => f.id).sort(), ['bump', 'helper (src/counter.c)', 'helper (src/main.c)', 'main', 'report'])
  const calls = r.calls.edges.map(e => `${e.source} -> ${e.target}`)
  for (const c of ['main -> bump', 'main -> memset', 'main -> helper (src/main.c)', 'report -> helper (src/counter.c)']) assert.ok(calls.includes(c), c)
  const lab = id => r.program.nodes.find(n => n.id === id)?.label
  const inter = r.program.edges.filter(e => e.kind !== 'data').map(e => `${e.kind} ${lab(e.source)} -> ${lab(e.target)}`)
  assert.ok(inter.includes('mod *p += 1; -> bump(&n);'))
  assert.ok(inter.includes('global total = helper(n) + *heap; -> return total;'))
  const main = r.functions.find(f => f.id === 'main')
  const dep = (a, b) => main.data.edges.find(e => main.cfg.nodes.find(n => n.id === e.source)?.label === a && main.cfg.nodes.find(n => n.id === e.target)?.label === b)?.label
  assert.equal(dep('bump(heap);', 'total = helper(n) + *heap;'), 'heap@main.c:10')
  assert.equal(dep('memset(buf, 0, sizeof buf);', 'return n + buf[0];'), 'buf')
})

test('pointer, field, and context-sensitive results match the host', async () => {
  const r = await runPipeline({ files: await load(fileURLToPath(new URL('./fixtures/pointers/', import.meta.url))) }, { preprocessor: 'container', service })
  const main = r.functions.find(f => f.id === 'main')
  const lab = id => main.cfg.nodes.find(n => n.id === id)?.label
  const d = main.data.edges.map(e => `${lab(e.source)} -> ${lab(e.target)} [${e.label}]`)
  assert.ok(d.includes('p.x = 1; -> int dx = p.x; [p.x]'))
  assert.ok(!d.some(e => e.startsWith('*pa = 10; -> int seen_b')))
  assert.ok(!d.some(e => e.startsWith('first->value = 7; -> int second_value')))
  assert.deepEqual(r.functions.find(f => f.id === 'sum').summary.reads.sort(), ['*(*l.head).next', '*(*l.head).value', '*l.head'])
})
