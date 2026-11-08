import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { loadRuntimeConfig } from '../dist/config.js'
import { parseRequest, parseResult } from '../dist/contracts.js'
import { stageRequest } from '../dist/staging.js'

const execute = promisify(execFile)
const worker = fileURLToPath(new URL('../worker/main.mjs', import.meta.url))
const has = program => spawnSync(program, ['--version']).status === 0

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lexeme-worker-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const id = randomUUID()
  const jobs = join(root, 'jobs')
  const jobDir = join(jobs, id)
  return {
    root, id, jobDir,
    async run(input) {
      const config = loadRuntimeConfig()
      const request = parseRequest({ schemaVersion: 1, operation: 'parse', ...input }, config.limits)
      await stageRequest(request, id, jobDir, new AbortController().signal, config.limits)
      let code = 0
      try {
        await execute(process.execPath, [worker, '--job', id, '--timeout-ms', '10000'], {
          env: { ...process.env, LEXEME_WORKER_JOBS: jobs }, timeout: 15000,
        })
      } catch (error) { code = error.code }
      const result = parseResult(JSON.parse(await readFile(join(jobDir, 'output/result.json'), 'utf8')), id)
      return { code, result }
    },
  }
}

test('worker accepts a custom filename and more than 32 defines/include paths', { skip: !has('gcc') }, async t => {
  const job = await fixture(t)
  const { code, result } = await job.run({
    source: 'int answer = VALUE_39;', entryFile: 'src/answer.c',
    defines: Array.from({ length: 40 }, (_, i) => `VALUE_${i}=${i}`),
    includeDirs: Array(40).fill('.'),
  })
  assert.equal(code, 0)
  assert.deepEqual(result.artifacts, [{ kind: 'preprocessed-source', path: 'main.i', source: 'src/answer.c' }])
  assert.match(await readFile(join(job.jobDir, 'output/main.i'), 'utf8'), /int answer = 39;/)
})

test('CMake discovers translation units and preserves each target’s flags and quoted paths', {
  skip: !has('gcc') || !has('cmake') || !has('python3'),
}, async t => {
  const job = await fixture(t)
  const project = join(job.root, 'project with spaces')
  await mkdir(join(project, 'headers with spaces'), { recursive: true })
  await writeFile(join(project, 'headers with spaces', 'value.h'), '#define EXTRA 7\n')
  await writeFile(join(project, 'answer.c'), '#include "value.h"\nconst char *label = LABEL;\nint answer = VALUE + EXTRA;\n')
  await writeFile(join(project, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.16)
project(Example C)
${[11, 22].map(value => `
add_library(answer_${value} OBJECT answer.c)
target_include_directories(answer_${value} PRIVATE "headers with spaces")
target_compile_definitions(answer_${value} PRIVATE VALUE=${value} [=[LABEL="hello world"]=])
`).join('\n')}
`)
  const { code, result } = await job.run({ projectDir: project })
  assert.equal(code, 0, JSON.stringify(result.diagnostics))
  assert.equal(result.artifacts.length, 2)
  assert.deepEqual(result.artifacts.map(artifact => artifact.source), ['answer.c', 'answer.c'])
  const outputs = await Promise.all(result.artifacts.map(artifact => readFile(join(job.jobDir, 'output', artifact.path), 'utf8')))
  assert.ok(outputs.some(text => /int answer = 11 \+ 7;/.test(text)))
  assert.ok(outputs.some(text => /int answer = 22 \+ 7;/.test(text)))
  assert.ok(outputs.every(text => /"hello world"/.test(text)))
})

test('CMake configuration failures produce a failed worker result', { skip: !has('cmake') }, async t => {
  const job = await fixture(t)
  const project = join(job.root, 'invalid')
  await mkdir(project)
  await writeFile(join(project, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.16)\nmessage(FATAL_ERROR "deliberate failure")\n')
  const { code, result } = await job.run({ projectDir: project })
  assert.equal(code, 1)
  assert.equal(result.status, 'failed')
  assert.equal(result.diagnostics[0].stage, 'configuring-cmake')
  assert.match(result.diagnostics[0].message, /deliberate failure/)
})
