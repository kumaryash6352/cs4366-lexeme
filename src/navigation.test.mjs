// Navigation logic over a real analysis result (runs with Node's TypeScript stripping).
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runPipeline } from '../analysis/dist/index.js'
import { buildIndex, expandCallGraph, menuForLine, menuForNode } from './navigation.ts'

const dir = new URL('../analysis/test/fixtures/pointers/', import.meta.url).pathname
const result = await runPipeline({ files: readdirSync(dir).map(f => ({ path: f, text: readFileSync(dir + f, 'utf8') })) })
const ix = buildIndex(result)
const main = result.functions.find(f => f.id === 'main')
const node = label => main.cfg.nodes.find(n => n.label === label)
const gos = items => items.filter(i => i.kind === 'go').map(i => `${i.target.view}|${i.target.fn ?? ''}|${i.target.node ?? ''}`)

test('a statement links to every view and to its callees', () => {
  const n = node('int *pa = pick(&a);')
  const items = gos(menuForNode(ix, 'cfg', 'main', main.cfg, n.id, new Set()))
  assert.ok(items.includes(`cfg|main|${n.id}`))
  assert.ok(items.includes(`data|main|${n.id}`))
  assert.ok(items.includes('calls||main'))
  assert.ok(items.includes('includes||main.c'))
  assert.ok(items.includes('source||'))
  const pick = result.functions.find(f => f.id === 'pick')
  assert.ok(items.includes(`cfg|pick|${pick.cfg.entry}`), 'callee entry')
})

test('call-graph functions link back to their call sites', () => {
  const items = gos(menuForNode(ix, 'calls', undefined, result.calls, 'pick', new Set()))
  assert.ok(items.includes(`cfg|main|${node('int *pa = pick(&a);').id}`))
  assert.ok(items.includes(`cfg|main|${node('int *pb = pick(&b);').id}`))
})

test('source lines resolve to the tightest statement', () => {
  const items = gos(menuForLine(ix, 'main.c', node('first->value = 7;').span.line))
  assert.ok(items.includes(`cfg|main|${node('first->value = 7;').id}`))
})

test('expanding a function replaces it with its control flow, wired to callees', () => {
  const g = expandCallGraph(ix, new Set(['main']))
  assert.ok(!g.nodes.some(n => n.id === 'main'))
  assert.ok(g.nodes.some(n => n.id === main.cfg.entry))
  const site = node('int total = sum(&l);').id
  assert.ok(g.edges.some(e => e.source === site && e.target === 'sum' && e.kind === 'call'))
  const both = expandCallGraph(ix, new Set(['main', 'sum']))
  const sumEntry = result.functions.find(f => f.id === 'sum').cfg.entry
  assert.ok(both.edges.some(e => e.source === site && e.target === sumEntry), 'call lands on expanded callee entry')
})

test('blocks: heuristic picks complex regions, nesting follows the code, collapse makes one node', async () => {
  const { analyze } = await import('../analysis/dist/index.js')
  const { inlineCalls, buildIndex: build } = await import('./navigation.ts')
  const r = await analyze({ entryFile: 'x.c', files: [{ path: 'x.c', text: `int f(int n) {
  int s = 0;
  for (int i = 0; i < n; i++) {
    if (i % 2) { s += i; s *= 2; }
    else s -= 1;
    while (s > 100) s /= 3;
  }
  if (n) s++;
  return s;
}` }] })
  const ix2 = build(r)
  const all = inlineCalls(ix2, 'f', new Set(), 'all')
  const complex = inlineCalls(ix2, 'f', new Set(), 'complex')
  const label = (cfg, key) => cfg.groups.label.get(key)
  const labels = cfg => [...cfg.blocks].map(k => label(cfg, k)).sort()
  assert.deepEqual(labels(complex), ['for (int i = 0; i < n; i++)'], 'only the loop is complex enough')
  assert.ok(labels(all).includes('if (n)') && labels(all).includes('while (s > 100)'))
  const loop = [...all.blocks].find(k => label(all, k).startsWith('for'))
  const inner = [...all.blocks].find(k => label(all, k).startsWith('while'))
  const nodeInWhile = all.graph.nodes.find(n => n.label === 's /= 3;')
  assert.deepEqual(all.groups.path.get(nodeInWhile.id), [loop, inner], 'nested outermost first')
  const folded = inlineCalls(ix2, 'f', new Set(), 'all', new Set([loop]))
  const summary = folded.graph.nodes.find(n => n.id === loop)
  assert.equal(summary.kind, 'block')
  assert.ok(!folded.graph.nodes.some(n => n.label === 's /= 3;'))
  assert.ok(folded.graph.edges.some(e => e.target === loop) && folded.graph.edges.some(e => e.source === loop))
  assert.ok(!folded.graph.edges.some(e => e.source === loop && e.target === loop))
})

test('expanded blocks behave like functions: entry node inside the box, refocus shows only the block', async () => {
  const { analyze } = await import('../analysis/dist/index.js')
  const { inlineCalls, buildIndex: build } = await import('./navigation.ts')
  const r = await analyze({ entryFile: 'x.c', files: [{ path: 'x.c', text: `int f(int n) {
  int s = 0;
  for (int i = 0; i < n; i++) {
    if (i % 2) { s += i; s *= 2; }
    while (s > 100) s /= 3;
  }
  return s;
}` }] })
  const ix2 = build(r)
  const cfg = inlineCalls(ix2, 'f', new Set(), 'all')
  const loop = [...cfg.blocks].find(k => cfg.groups.label.get(k).startsWith('for'))
  const entry = cfg.blockEntry.get(loop)
  const byLabel = l => cfg.graph.nodes.find(n => n.label === l).id
  assert.deepEqual(cfg.groups.path.get(entry), [loop], 'entry sits inside its box')
  assert.ok(cfg.graph.edges.some(e => e.source === byLabel('int s = 0;') && e.target === entry), 'flow enters through the entry')
  assert.ok(!cfg.graph.edges.some(e => e.source === byLabel('int s = 0;') && e.target === byLabel('int i = 0;')))
  assert.ok(cfg.graph.edges.some(e => e.source === entry && e.target === byLabel('int i = 0;')))

  const focused = inlineCalls(ix2, 'f', new Set(), 'all', new Set(), loop)
  assert.equal(focused.graph.entry, entry)
  const labels = focused.graph.nodes.map(n => n.label)
  assert.ok(!labels.includes('int s = 0;') && !labels.includes('return s;'), 'only the block')
  assert.ok(labels.includes('exit block'))
  assert.deepEqual(focused.groups.path.get(entry), [], 'no box around the focused block itself')
})
