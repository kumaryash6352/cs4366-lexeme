import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeUnit, assembleGraphs } from '../worker/graphs/model.mjs'
import { lineMarker } from '../worker/graphs/source-map.mjs'

const compilerAvailable = spawnSync('gcc', ['--version']).status === 0 && spawnSync('nm', ['--version']).status === 0
const compilerTest = { skip: compilerAvailable ? false : 'Requires GCC and nm' }

async function analyze(t, files, entries = ['main.c']) {
  const root = await mkdtemp(join(tmpdir(), 'lexeme-worker-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = join(root, 'source'), workRoot = join(root, 'work'), output = join(root, 'output')
  await Promise.all([sourceRoot, workRoot, output].map(path => mkdir(path)))
  for (const [name, text] of Object.entries(files)) await writeFile(join(sourceRoot, name), text)
  const execute = async (program, args, cwd, capture = {}) => {
    const result = spawnSync(program, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    if (result.error) throw result.error
    if (capture.stdoutFile) await writeFile(capture.stdoutFile, result.stdout)
    if (capture.stderrFile) await writeFile(capture.stderrFile, result.stderr)
    return { code: result.status, output: result.stdout, diagnostics: result.stderr }
  }
  const units = []
  for (const [index, entry] of entries.entries()) {
    units.push(await analyzeUnit({ args: ['gcc', '-std=c11', '-I.', entry], directory: sourceRoot, file: entry }, index,
      { sourceRoot, workRoot, output, single: entries.length === 1, maxBytes: 32 * 1024 * 1024 }, execute, () => {}))
  }
  return assembleGraphs(units, {})
}

function callNames(graphs) {
  const names = new Map(graphs.calls.nodes.map(node => [node.id, node.name]))
  return graphs.calls.edges.map(edge => `${names.get(edge.source)} -> ${names.get(edge.target)}`)
}

test('GCC filenames support literal controls, C escapes, and UTF-8 octal bytes', () => {
  for (const [quoted, expected] of [
    ['"tab\tname.h"', 'tab\tname.h'],
    [String.raw`"tab\011name.h"`, 'tab\tname.h'],
    [String.raw`"tab\tname.h"`, 'tab\tname.h'],
    [String.raw`"quote\"slash\\name.h"`, 'quote"slash\\name.h'],
    [String.raw`"caf\303\251.h"`, 'café.h'],
    ['"café.h"', 'café.h'],
  ]) {
    assert.deepEqual(lineMarker(`# 12 ${quoted} 1 3`), { line: 12, file: expected, flags: [1, 3] })
  }
  assert.equal(lineMarker('int value;'), undefined)
})

test('calls in C11 for declarations, recursion, and unused functions are retained', compilerTest, async t => {
  const graphs = await analyze(t, { 'main.c': `
extern int external(int);
static int unused(int x) { return external(x); }
int helper(int x) { return x ? helper(x - 1) : 0; }
int main(void) {
  int total = 0;
  for (int i = 0; i < 3; i++) total += helper(i);
  return total;
}
` })
  const calls = callNames(graphs)
  for (const edge of ['main -> helper', 'helper -> helper', 'unused -> external']) assert.ok(calls.includes(edge), edge)
  assert.equal(graphs.calls.nodes.find(node => node.name === 'unused').linkage, 'internal')
})

test('cross-file calls resolve without merging same-named static functions', compilerTest, async t => {
  const graphs = await analyze(t, {
    'main.c': 'int helper(void); static int local(void) { return 1; } int main(void) { return helper() + local(); }',
    'helper.c': 'static int local(void) { return 2; } int helper(void) { return local(); }',
  }, ['main.c', 'helper.c'])
  assert.ok(callNames(graphs).includes('main -> helper'))
  const locals = graphs.calls.nodes.filter(node => node.name === 'local')
  assert.equal(locals.length, 2)
  assert.notEqual(locals[0].id, locals[1].id)
  assert.ok(locals.every(node => node.linkage === 'internal'))
  for (const edge of graphs.calls.edges.filter(edge => locals.some(node => node.id === edge.target))) {
    const caller = graphs.calls.nodes.find(node => node.id === edge.source)
    const callee = graphs.calls.nodes.find(node => node.id === edge.target)
    assert.equal(caller.unitId, callee.unitId)
  }
})

test('a header with a tab in its filename survives preprocessing and graph generation', compilerTest, async t => {
  const graphs = await analyze(t, {
    'main.c': '#include "tab\tname.h"\nint main(void) { return value(); }\n',
    'tab\tname.h': 'static int value(void) { return 1; }\n',
  })
  assert.ok(graphs.includes.edges.some(edge => edge.target === 'tab\tname.h' && edge.resolved))
  assert.ok(graphs.files.some(file => file.path === 'tab\tname.h'))
  assert.ok(callNames(graphs).includes('main -> value'))
})

test('a translation unit containing only data produces no function graphs', compilerTest, async t => {
  const graphs = await analyze(t, { 'main.c': 'int value = 1;\n' })
  assert.equal(graphs.controlFlow.length, 0)
  assert.equal(graphs.calls.nodes.length, 0)
  assert.equal(graphs.calls.edges.length, 0)
})
