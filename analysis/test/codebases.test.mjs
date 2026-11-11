// Whole-project checks over real codebases fetched by scripts/fetch-codebases.sh.
// Generic invariants only: nothing here knows about a particular project.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runPipeline } from '../dist/index.js'

const root = fileURLToPath(new URL('./codebases/', import.meta.url))
const hasGcc = spawnSync('gcc', ['--version']).status === 0
const names = existsSync(root) ? (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name) : []

async function load(dir) {
  const files = []
  const walk = async path => {
    for (const e of await readdir(path, { withFileTypes: true })) {
      const full = join(path, e.name)
      if (e.name === '.git') continue
      if (e.isDirectory()) await walk(full)
      else if (/\.(c|h)$/.test(e.name) || e.name === 'compile_commands.json') files.push({ path: relative(dir, full), text: await readFile(full, 'utf8') })
    }
  }
  await walk(dir)
  return files
}

if (names.length === 0) test('real codebases', { skip: 'run scripts/fetch-codebases.sh first' }, () => {})

for (const name of names) {
  test(`${name}: every unit preprocesses and analyzes cleanly`, { skip: !hasGcc && 'gcc not installed', timeout: 300_000 }, async () => {
    const files = await load(join(root, name))
    const known = new Set(files.map(f => f.path))
    const r = await runPipeline({ files })
    assert.ok(r.units.length > 0)
    assert.deepEqual(r.units.filter(u => !u.preprocessed).map(u => u.file), [], 'units that failed to preprocess')
    assert.deepEqual(r.diagnostics.filter(d => d.severity === 'error').map(d => `${d.span?.file}:${d.span?.line} ${d.message}`), [])
    // Each definition appears once and points at a real project file.
    const sites = r.functions.map(f => `${f.file}:${f.span?.line}:${f.name}`)
    assert.equal(new Set(sites).size, sites.length, 'duplicate function definitions')
    assert.deepEqual(r.functions.filter(f => !known.has(f.file)).map(f => f.file), [], 'functions outside the project')
    // Calls resolve: every call-graph edge from a defined function lands on a node.
    const ids = new Set(r.calls.nodes.map(n => n.id))
    assert.ok(r.calls.edges.every(e => ids.has(e.source) && ids.has(e.target)))
    assert.ok(r.calls.edges.some(e => r.functions.some(f => f.id === e.target)), 'some calls resolve to project functions')
    // Spans in every graph point into project files.
    for (const f of r.functions) for (const n of f.cfg.nodes) if (n.span) assert.ok(known.has(n.span.file), `${n.span.file} not in project`)
  })
}
