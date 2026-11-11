import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { analyze, flagsFromCompileCommands, parseCompilerOutput, runPipeline, selectUnits } from '../dist/index.js'
import { mapPreprocessed } from '../dist/analyzer/source-map.js'

const one = text => analyze({ entryFile: 'main.c', files: [{ path: 'main.c', text }] })
const fnOf = async (text, name) => (await one(text)).functions.find(f => f.name === name)
const labels = graph => graph.nodes.map(n => n.label)
const edge = (graph, from, to) => {
  const id = label => graph.nodes.find(n => n.label === label)?.id
  return graph.edges.find(e => e.source === id(from) && e.target === id(to))
}
const hasGcc = spawnSync('gcc', ['--version']).status === 0

test('if/else produces labelled true and false branches that rejoin', async () => {
  const f = await fnOf('int f(int x) { if (x > 0) x = 1; else x = 2; return x; }', 'f')
  assert.deepEqual(labels(f.cfg), ['int f(int x)', 'x > 0', 'x = 1;', 'x = 2;', 'return x;'])
  assert.equal(edge(f.cfg, 'x > 0', 'x = 1;').kind, 'true')
  assert.equal(edge(f.cfg, 'x > 0', 'x = 2;').kind, 'false')
  assert.ok(edge(f.cfg, 'x = 1;', 'return x;') && edge(f.cfg, 'x = 2;', 'return x;'))
})

test('loops get back edges; break and continue jump to the right targets', async () => {
  const f = await fnOf('int f(int n) { int s = 0; for (int i = 0; i < n; i++) { if (i == 3) continue; if (i == 7) break; s += i; } while (s) s--; return s; }', 'f')
  assert.ok(edge(f.cfg, 'i++', 'for (i < n)'), 'update returns to the condition')
  assert.ok(edge(f.cfg, 'continue', 'i++'), 'continue goes to the update')
  assert.ok(edge(f.cfg, 'break', 'while (s)'), 'break leaves the loop')
  assert.ok(edge(f.cfg, 's--;', 'while (s)'))
  assert.equal(edge(f.cfg, 'for (i < n)', 'while (s)').kind, 'false')
})

test('do-while loops back from its condition to the body', async () => {
  const f = await fnOf('void f(int x) { do { x--; } while (x > 0); }', 'f')
  assert.equal(edge(f.cfg, 'do … while (x > 0)', 'x--;').kind, 'true')
})

test('switch models case edges, fallthrough, and an implicit default', async () => {
  const f = await fnOf('int f(int x) { switch (x) { case 1: x++; case 2: x += 2; break; case 3: return 0; } return x; }', 'f')
  assert.equal(edge(f.cfg, 'switch (x)', 'x++;').label, 'case 1')
  assert.ok(edge(f.cfg, 'x++;', 'x += 2;'), 'case 1 falls through')
  assert.ok(edge(f.cfg, 'break', 'return x;'))
  assert.equal(edge(f.cfg, 'switch (x)', 'return x;').label, 'default')
})

test('goto reaches its label; exit() ends the path', async () => {
  const f = await fnOf('void exit(int); int f(int x) { if (x) goto out; exit(1); out: return x; }', 'f')
  assert.equal(edge(f.cfg, 'goto out;', 'out:').kind, 'goto')
  assert.equal(f.cfg.edges.filter(e => e.source === f.cfg.nodes.find(n => n.label === 'exit(1);').id).length, 0)
})

test('reaching definitions: redefinition kills and loops carry', async () => {
  const f = await fnOf('int f(int a) { int x = a; x = 2; for (int i = 0; i < a; i++) x += i; return x; }', 'f')
  const dep = (from, to) => edge(f.data, from, to)?.label
  assert.equal(dep('int x = a;', 'x = 2;'), undefined, 'x = 2 does not use x')
  assert.equal(dep('int f(int a)', 'int x = a;'), 'a')
  assert.equal(dep('x = 2;', 'return x;'), 'x')
  assert.equal(dep('int x = a;', 'return x;'), undefined, 'killed by x = 2')
  assert.equal(dep('x += i;', 'x += i;'), 'x', 'loop-carried')
  assert.equal(dep('i++', 'for (i < a)'), 'i')
})

test('points-to: writes through known pointers define their targets; unknown pointers are alias boundaries', async () => {
  const f = await fnOf('int *get(void); int f(void) { int x = 1; int *p = &x; *p = 5; int *q = get(); *q = 7; return x; }', 'f')
  const dep = (from, to) => edge(f.data, from, to)?.label
  assert.equal(dep('*p = 5;', 'return x;'), 'x', '*p = 5 strongly defines x')
  assert.equal(dep('int x = 1;', 'return x;'), undefined, 'and kills the earlier definition')
  assert.equal(f.data.nodes.find(n => n.label === '*q = 7;').kind, 'alias')
})

test('heap objects carry values through library calls and pointer copies', async () => {
  const f = await fnOf('int scanf(const char *, ...); void *malloc(unsigned long);\nint f(void) {\n  int *a = malloc(4);\n  int *b = a;\n  scanf("%d", b);\n  return *a;\n}', 'f')
  assert.equal(edge(f.data, 'scanf("%d", b);', 'return *a;')?.label, 'heap@main.c:3')
})

test('function summaries propagate writes through pointer parameters across calls', async () => {
  const r = await one('void set(int *p) { *p = 1; }\nvoid twice(int *q) { set(q); set(q); }\nint main(void) { int v = 0; twice(&v); return v; }')
  const twice = r.functions.find(f => f.id === 'twice')
  assert.deepEqual(twice.summary.writes, ['*q'])
  const main = r.functions.find(f => f.id === 'main')
  assert.equal(edge(main.data, 'twice(&v);', 'return v;')?.label, 'v')
  const lab = id => r.program.nodes.find(n => n.id === id)?.label
  const inter = r.program.edges.filter(e => e.kind !== 'data').map(e => `${e.kind} ${lab(e.source)} -> ${lab(e.target)}`)
  assert.ok(inter.includes('mod set(q); -> twice(&v);'))
  assert.ok(inter.includes('mod *p = 1; -> set(q);'))
  assert.ok(inter.includes('param twice(&v); -> void twice(int *q)'))
})

test('multiple translation units link calls, keep statics per file, and share globals', async () => {
  const r = await analyze({
    files: [
      { path: 'a.c', text: 'int g;\nstatic int h(void) { return 1; }\nvoid put(void) { g = h(); }\nint main(void) { put(); return get(); }' },
      { path: 'b.c', text: 'extern int g;\nstatic int h(void) { return 2; }\nint get(void) { return g + h(); }' },
    ],
    units: [{ file: 'a.c' }, { file: 'b.c' }],
  })
  assert.deepEqual(r.functions.map(f => f.id).sort(), ['get', 'h (a.c)', 'h (b.c)', 'main', 'put'])
  const calls = r.calls.edges.map(e => `${e.source} -> ${e.target}`).sort()
  assert.deepEqual(calls, ['get -> h (b.c)', 'main -> get', 'main -> put', 'put -> h (a.c)'])
  // Globals travel along the call graph: put() writes g, main sees it after the call,
  // passes it into get(), where it reaches the read.
  const lab = id => r.program.nodes.find(n => n.id === id)?.label
  const has = (kind, from, to) => r.program.edges.some(e => e.kind === kind && lab(e.source) === from && lab(e.target) === to && e.label.includes('g'))
  assert.ok(has('global', 'g = h();', 'put();'), 'writer → call site')
  assert.ok(has('data', 'put();', 'return get();'), 'within main')
  assert.ok(has('global', 'return get();', 'int get(void)'), 'call site → callee entry')
  assert.ok(has('data', 'int get(void)', 'return g + h();'), 'within get')
})

test('call graph separates defined, external, and indirect callees', async () => {
  const r = await one('int g(void) { return 1; } int f(int (*h)(void), int (**t)(void)) { return g() + h() + (*t)() + puts("x") + g(); }')
  assert.deepEqual(r.calls.nodes.map(n => [n.id, n.kind]).sort(), [['(indirect) h', 'indirect'], ['(indirect)', 'indirect'], ['f', 'function'], ['g', 'function'], ['puts', 'external']])
  assert.equal(r.calls.edges.find(e => e.target === 'g').label, '×2')
})

test('unpreprocessed includes resolve against project files', async () => {
  const r = await analyze({ entryFile: 'src/main.c', files: [
    { path: 'src/main.c', text: '#include "util.h"\n#include "../include/api.h"\n#include <stdio.h>\nint main(void) { return 0; }' },
    { path: 'src/util.h', text: '#include "../include/api.h"\n' },
    { path: 'include/api.h', text: '' },
  ] })
  assert.deepEqual(r.includes.edges.map(e => `${e.source} -> ${e.target}`).sort(), [
    'src/main.c -> include/api.h', 'src/main.c -> src/util.h', 'src/main.c -> stdio.h', 'src/util.h -> include/api.h',
  ])
  assert.equal(r.includes.nodes.find(n => n.id === 'stdio.h').kind, 'system')
})

test('line markers map rows back to files and drop system-header internals', () => {
  const map = mapPreprocessed([
    '# 1 "main.c"', '# 1 "/usr/include/stdio.h" 1 3 4', 'int printf(const char *, ...);',
    '# 1 "/usr/include/bits.h" 1 3 4', '# 2 "/usr/include/stdio.h" 2 3 4', '# 2 "main.c" 2', 'int main(void) { return 0; }',
  ].join('\n'), 'main.c')
  assert.deepEqual(map.rows[2], { file: '/usr/include/stdio.h', line: 1, system: true })
  assert.deepEqual(map.rows[6], { file: 'main.c', line: 2, system: false })
  assert.equal(map.text.split('\n')[0], '', 'markers become blank lines')
  assert.deepEqual(map.includes.map(e => e.to), ['/usr/include/stdio.h', '/usr/include/bits.h'])
})

test('syntax errors in user code become parse diagnostics with spans', async () => {
  const r = await one('int main(void) {\n  int x = ;\n  return x\n}\n')
  const errors = r.diagnostics.filter(d => d.stage === 'parse')
  assert.ok(errors.length >= 1)
  assert.ok(errors.every(d => d.span?.file === 'main.c' && d.span.line >= 2))
})

test('compiler output and compile_commands.json are parsed', () => {
  const [d] = parseCompilerOutput("src/a.c:3:9: fatal error: 'x.h' file not found")
  assert.deepEqual(d, { severity: 'error', stage: 'preprocess', message: "'x.h' file not found", span: { file: 'src/a.c', line: 3, column: 9, endLine: 3, endColumn: 9 } })
  const flags = flagsFromCompileCommands([
    { path: 'src/a.c', text: '' }, { path: 'include/a.h', text: '' },
    { path: 'compile_commands.json', text: JSON.stringify([{ directory: '/w', file: 'src/a.c', arguments: ['cc', '-I', '/w/include', '-DX=1', '-std=gnu17', '-I/elsewhere', '-c', 'src/a.c'] }]) },
  ], 'src/a.c')
  assert.deepEqual(flags, { includeDirs: ['include'], defines: ['X=1'], std: 'gnu17' })
})

test('units default to compile_commands.json entries, else every .c file', () => {
  const files = [{ path: 'a.c', text: '' }, { path: 'b.c', text: '' }, { path: 'h.h', text: '' }]
  assert.deepEqual(selectUnits(files), ['a.c', 'b.c'])
  assert.deepEqual(selectUnits([...files, { path: 'compile_commands.json', text: JSON.stringify([{ directory: '/x', file: '/x/b.c', command: 'cc -c b.c' }]) }]), ['b.c'])
  assert.deepEqual(selectUnits(files, ['a.c']), ['a.c'])
})

test('pipeline expands macros with GCC but labels show the original source', { skip: !hasGcc && 'gcc not installed' }, async () => {
  const r = await runPipeline({ entryFile: 'main.c', defines: ['LIMIT=3'], files: [
    { path: 'main.c', text: '#include "lim.h"\nint f(int *p) {\n  if (p == NULL || *p > LIMIT) return 0;\n  return 1;\n}\n' },
    { path: 'lim.h', text: '#define NULL ((void *)0)\n' },
  ] })
  assert.deepEqual(r.units.map(u => u.preprocessed), [true])
  assert.equal(r.runtime, 'host')
  const cond = r.functions[0].cfg.nodes.find(n => n.kind === 'condition')
  assert.equal(cond.label, 'p == NULL || *p > LIMIT')
  assert.match(cond.detail, /\(\(void \*\)0\).*3/)
  assert.deepEqual(cond.span, { file: 'main.c', line: 3, column: 7, endLine: 3, endColumn: 30 })
  assert.deepEqual(r.includes.edges, [{ source: 'main.c', target: 'lim.h', kind: 'include' }])
})

test('pipeline falls back to the raw source with diagnostics when a header is missing', { skip: !hasGcc && 'gcc not installed' }, async () => {
  const r = await runPipeline({ entryFile: 'main.c', files: [{ path: 'main.c', text: '#include "nope.h"\nint main(void) { return 0; }\n' }] })
  assert.deepEqual(r.units.map(u => u.preprocessed), [false])
  assert.ok(r.diagnostics.some(d => d.severity === 'error' && d.span?.line === 1 && /nope\.h/.test(d.message)))
  assert.deepEqual(r.functions.map(f => f.name), ['main'])
})

test('pipeline rejects paths outside the project', async () => {
  await assert.rejects(runPipeline({ entryFile: '../x.c', files: [{ path: '../x.c', text: '' }] }))
})

test('worker runs the analyze operation end to end (container protocol, on the host)', { skip: !hasGcc && 'gcc not installed' }, async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const jobs = await mkdtemp(join(tmpdir(), 'lexeme-worker-'))
  const id = '00000000-0000-4000-8000-000000000001'
  try {
    await mkdir(join(jobs, id, 'input', 'source', 'inc'), { recursive: true })
    await writeFile(join(jobs, id, 'input', 'source', 'm.c'), '#include "v.h"\nint main(void) { return twice(V); }\n')
    await writeFile(join(jobs, id, 'input', 'source', 't.c'), 'int twice(int x) { return 2 * x; }\n')
    await writeFile(join(jobs, id, 'input', 'source', 'inc', 'v.h'), 'int twice(int);\n#define V 21\n')
    await writeFile(join(jobs, id, 'input', 'request.json'), JSON.stringify({ schemaVersion: 1, jobId: id, operation: 'analyze',
      units: [{ file: 'm.c', includeDirs: ['inc'], defines: [], std: 'c11' }, { file: 't.c', includeDirs: [], defines: [], std: 'c11' }] }))
    const run = spawnSync(process.execPath, [new URL('../worker/main.mjs', import.meta.url).pathname, '--job', id, '--timeout-ms', '60000'],
      { env: { ...process.env, LEXEME_WORKER_JOBS: jobs }, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const result = JSON.parse(await readFile(join(jobs, id, 'output', 'result.json'), 'utf8'))
    assert.deepEqual(result.artifacts, [{ kind: 'analysis', path: 'analysis.json' }])
    const analysis = JSON.parse(await readFile(join(jobs, id, 'output', 'analysis.json'), 'utf8'))
    assert.equal(analysis.runtime, 'container')
    assert.deepEqual(analysis.calls.edges.map(e => `${e.source} -> ${e.target}`), ['main -> twice'])
    assert.equal(analysis.functions.find(f => f.id === 'main').cfg.nodes[1].label, 'return twice(V);')
  } finally { await rm(jobs, { recursive: true, force: true }) }
})

test('multi-unit fixture on the host matches the container expectations', { skip: !hasGcc && 'gcc not installed' }, async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const { join, relative } = await import('node:path')
  const root = new URL('./fixtures/multi/', import.meta.url).pathname
  const files = []
  const walk = async dir => { for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) await walk(p); else files.push({ path: relative(root, p), text: await readFile(p, 'utf8') }) } }
  await walk(root)
  const r = await runPipeline({ files })
  assert.deepEqual(r.units.map(u => [u.file, u.preprocessed]), [['src/main.c', true], ['src/counter.c', true]])
  assert.deepEqual(r.functions.map(f => f.id).sort(), ['bump', 'helper (src/counter.c)', 'helper (src/main.c)', 'main', 'report'])
  assert.ok(r.calls.edges.some(e => e.source === 'main' && e.target === 'memset'), 'fortified builtins map back to memset')
})

async function pointersFixture() {
  const { readdir, readFile } = await import('node:fs/promises')
  const dir = new URL('./fixtures/pointers/', import.meta.url).pathname
  const files = await Promise.all((await readdir(dir)).map(async f => ({ path: f, text: await readFile(dir + f, 'utf8') })))
  return runPipeline({ files })
}
const deps = fn => {
  const lab = id => fn.cfg.nodes.find(n => n.id === id)?.label ?? ''
  return fn.data.edges.map(e => ({ from: lab(e.source), to: lab(e.target), label: e.label }))
}

test('field sensitivity: writes to one field do not reach reads of another', { skip: !hasGcc && 'gcc not installed' }, async () => {
  const main = (await pointersFixture()).functions.find(f => f.id === 'main')
  const d = deps(main)
  assert.ok(d.some(e => e.from === 'p.x = 1;' && e.to === 'int dx = p.x;' && e.label === 'p.x'))
  assert.ok(!d.some(e => e.from === 'p.x = 1;' && e.to.startsWith('printf')), 'p.x is not read by printf')
  assert.ok(d.some(e => e.from === 'p.y = 2;' && e.to.startsWith('printf') && e.label === 'p.y'))
})

test('heap-stored pointers: list nodes linked through fields are followed across calls', { skip: !hasGcc && 'gcc not installed' }, async () => {
  const r = await pointersFixture()
  const sum = r.functions.find(f => f.id === 'sum')
  assert.deepEqual(sum.summary.reads.sort(), ['*(*l.head).next', '*(*l.head).value', '*l.head'])
  const push = r.functions.find(f => f.id === 'push')
  assert.ok(push.summary.writes.includes('*l.head'))
  const d = deps(r.functions.find(f => f.id === 'main'))
  for (const [call, line] of [['push(&l, 3);', 15], ['push(&l, 4);', 16]]) {
    const edge = d.find(e => e.from === call && e.to === 'int total = sum(&l);')
    assert.ok(edge?.label.includes(`heap@list.c:5[main.c:${line}].value`), `${call} node value reaches sum: ${edge?.label}`)
  }
})

test('context sensitivity: identity and allocator calls are kept apart per call site', { skip: !hasGcc && 'gcc not installed' }, async () => {
  const main = (await pointersFixture()).functions.find(f => f.id === 'main')
  const d = deps(main)
  assert.match(main.data.nodes.find(n => n.label === '*pa = 10;').detail, /defines a\b/)
  assert.ok(!d.some(e => e.from === '*pa = 10;' && e.to === 'int seen_b = b;'), 'pick(&a) result does not alias b')
  assert.ok(!d.some(e => e.from === 'first->value = 7;' && e.to === 'int second_value = second->value;'), 'separate make_node() objects')
  assert.ok(d.some(e => e.from === 'struct node *second = make_node(6);' && e.label.includes('heap@list.c:5[main.c:28].value')))
})

test('compile_commands.json from an out-of-tree build maps include paths back into the project', () => {
  const files = [
    { path: 'src/a.c', text: '' }, { path: 'src/include/a.h', text: '' }, { path: 'include/b.h', text: '' },
    { path: 'build/compile_commands.json', text: JSON.stringify([{
      directory: '/home/dev/proj/build/src',
      file: '/home/dev/proj/src/a.c',
      command: 'cc -I/home/dev/proj/src/./include -I../../include -I/usr/local/include -DX -c /home/dev/proj/src/a.c',
    }]) },
  ]
  assert.deepEqual(selectUnits(files), ['src/a.c'])
  assert.deepEqual(flagsFromCompileCommands(files, 'src/a.c'), { includeDirs: ['src/include', 'include'], defines: ['X'], std: '' })
})

test('line-marker paths are normalized so one file has one name', () => {
  const map = mapPreprocessed(['# 1 "tests/t.c"', '# 1 "tests/../lib.c" 1', 'int f(void) { return 1; }', '# 2 "tests/t.c" 2'].join('\n'), 'tests/t.c')
  assert.equal(map.rows[2].file, 'lib.c')
  assert.deepEqual(map.includes, [{ from: 'tests/t.c', to: 'lib.c', system: false }])
})

test('a .c file included by another unit is analyzed once', { skip: !hasGcc && 'gcc not installed' }, async () => {
  const r = await runPipeline({ files: [
    { path: 'lib.c', text: 'int f(int x) { return x + 1; }\n' },
    { path: 'tests/t.c', text: '#include "../lib.c"\nint main(void) { return f(1); }\n' },
  ] })
  assert.deepEqual(r.functions.map(f => `${f.id} @${f.file}`).sort(), ['f @lib.c', 'main @tests/t.c'])
  assert.deepEqual(r.calls.edges.map(e => `${e.source} -> ${e.target}`), ['main -> f'])
})

test('labels of statements that start with a parenthesis keep the whole statement', { skip: !hasGcc && 'gcc not installed' }, async () => {
  const r = await runPipeline({ entryFile: 'm.c', files: [{ path: 'm.c', text: `#define NIL 0
struct e { int key; }; struct n { struct e *data; int eow; };
int add(struct n **last, int key) {
    if (*last) {
        if (!(*last)->eow) {
            (*last)->data = NIL;
            if (!(*last)->data)
                return 1;
        }
        (*last)->data->key = key;
        return 0;
    }
    return 2;
}
` }] })
  const labels = r.functions[0].cfg.nodes.map(n => n.label)
  assert.ok(labels.includes('(*last)->data->key = key;'), labels.join(' | '))
  assert.ok(labels.includes('(*last)->data = NIL;'), 'macro line keeps original text')
  assert.ok(labels.includes('!(*last)->data') && labels.includes('!(*last)->eow'), 'conditions unwrap their parentheses')
})
