import { readFile, stat, writeFile, mkdir, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { filePath, stableId } from './source-map.mjs'
import { parseIncludes } from './includes.mjs'
import { parseCfg } from './cfg.mjs'
import { applyLinkage, mergeCalls, parseCalls } from './calls.mjs'

export async function readArtifact(path, maxBytes) {
  if ((await stat(path)).size > maxBytes) throw new Error(`Analysis artifact exceeds ${maxBytes} bytes: ${basename(path)}`)
  return readFile(path, 'utf8')
}

export function stageFlags(command) {
  const flags = []
  for (let i = 1; i < command.args.length; i++) {
    const arg = command.args[i]
    if (['-o', '-MF', '-MT', '-MQ', '-MJ', '-dumpbase', '-dumpdir'].includes(arg)) { i++; continue }
    if (['-c', '-S', '-E', '-fsyntax-only', '-MD', '-MMD', '-MP', '-MG', '-M', '-MM'].includes(arg) ||
        /^(-o.|-MF.|-MT.|-MQ.|-MJ.|-fdump-|-save-temps)/.test(arg)) continue
    if (!arg.startsWith('-') && resolve(command.directory, arg) === resolve(command.directory, command.file)) continue
    if (arg.startsWith('@')) throw new Error('Compiler response files are not supported by graph analysis yet')
    flags.push(arg)
  }
  return flags
}

/** Ignore build output names, but retain different compilers, flags, and directories. */
export function uniqueCommands(commands) {
  const seen = new Set()
  const unique = []
  for (const command of commands) {
    const directory = resolve(command.directory)
    const file = resolve(directory, command.file)
    const normalized = { args: [command.args[0], ...stageFlags(command), file], directory, file }
    const key = JSON.stringify(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(normalized)
  }
  return unique
}

function cfgFlags(flags) {
  const result = []
  // Preprocessing has already happened with the original build's macros/settings.
  for (let i = 0; i < flags.length; i++) {
    const arg = flags[i]
    if (arg === '-Werror') continue
    if (arg.startsWith('-Werror=')) {
      result.push(`-W${arg.slice('-Werror='.length)}`)
      continue
    }
    if (['-I', '-D', '-U', '-include', '-imacros', '-isystem', '-iquote', '-idirafter', '-iprefix', '-iwithprefix', '-iwithprefixbefore', '-x'].includes(arg)) { i++; continue }
    if (/^(-[IDU].|-O|-flto|-fwhole-program|-Wp,|-include.|-imacros.)/.test(arg)) continue
    result.push(arg)
  }
  return result
}

export async function analyzeUnit(command, index, paths, execute, progress) {
  const { sourceRoot, workRoot, output, maxBytes } = paths
  const source = resolve(command.directory, command.file)
  const context = { source, directory: command.directory, sourceRoot, workRoot }
  const canonical = value => value.replaceAll(sourceRoot, '@project').replaceAll(workRoot, '@work')
  context.id = stableId(filePath(source, context), canonical(command.directory), command.args.map(canonical))
  const work = join(workRoot, `unit-${index + 1}`)
  await mkdir(work, { recursive: true })
  const flags = stageFlags(command)
  const compiler = command.args[0]
  const diagnostics = []
  if (!/^(gcc|cc)(-\d+)?$/.test(basename(compiler)) && !basename(compiler).endsWith('-gcc')) {
    throw new Error(`Graph analysis requires GCC; unsupported compiler: ${compiler}`)
  }
  const run = async (program, args, options = {}) => {
    // GCC writes -o outputs and version-dependent dump filenames directly here.
    const result = await execute(program, args, command.directory, { ...options, watchDirectories: [work] })
    if (result.code !== 0) throw new Error(result.diagnostics || result.output || `${program} failed (${result.code})`)
    if (!options.stderrFile && result.diagnostics.trim()) diagnostics.push({ stage: `${basename(program)}-warning`, message: result.diagnostics.trim() })
    return result
  }
  progress('preprocessing')
  const includesPath = join(work, 'includes.i'), tracePath = join(work, 'includes.trace')
  await run(compiler, [...flags, '-E', '-dI', '-H', '-v', source, '-o', includesPath], { stderrFile: tracePath })
  const trace = await readArtifact(tracePath, maxBytes)
  const warnings = trace.split('\n').filter(line => /\bwarning:/.test(line))
  if (warnings.length) diagnostics.push({ stage: 'preprocessor-warning', message: warnings.join('\n') })
  const includes = parseIncludes(await readArtifact(includesPath, maxBytes), trace, context)
  const preprocessedPath = join(output, paths.single ? 'main.i' : `unit-${index + 1}.i`)
  await writeFile(preprocessedPath, includes.text)

  progress('extracting-cfg')
  const objectPath = join(work, 'unit.o')
  await run(compiler, [
    ...cfgFlags(flags), '-Wno-error', '-O0',
    '-x', 'cpp-output', '-c', preprocessedPath,
    '-fdump-tree-cfg-graph-lineno', '-fdump-ipa-cgraph',
    '-o', objectPath,
  ])
  const symbolsPath = join(work, 'symbols.txt')
  await run('nm', ['--defined-only', '--format=posix', objectPath], { stdoutFile: symbolsPath })
  const symbols = await readArtifact(symbolsPath, maxBytes)
  const dumpFiles = (await readdir(work)).filter(name => name.endsWith('.cfg'))
  if (dumpFiles.length > 1 || (!dumpFiles.length && /^\S+ [tTwW] /m.test(symbols))) {
    throw new Error('GCC did not produce the expected CFG dump; check compiler compatibility')
  }
  // A translation unit containing only declarations/data has no function CFGs.
  const cfg = dumpFiles.length ? parseCfg(await readArtifact(join(work, dumpFiles[0]), maxBytes),
    await readArtifact(join(work, dumpFiles[0] + '.dot'), maxBytes), context) : { functions: [], graphs: [] }

  progress('extracting-calls')
  const callFiles = (await readdir(work)).filter(name => name.endsWith('.cgraph'))
  if (callFiles.length !== 1) throw new Error('GCC did not produce the expected call graph dump')
  const calls = parseCalls(await readArtifact(join(work, callFiles[0]), maxBytes), context, cfg.functions)
  applyLinkage(calls.nodes, symbols)

  progress('extracting-includes')
  return {
    unit: { id: context.id, source: filePath(source, context), command: command.args.map(canonical), directory: canonical(command.directory) },
    cfg: cfg.graphs, calls, includes, diagnostics,
    artifact: { kind: 'preprocessed-source', path: basename(preprocessedPath), source: filePath(source, context) },
  }
}

export function assembleGraphs(results, tools) {
  const calls = mergeCalls(results.map(result => result.calls))
  const includeEdges = results.flatMap(result => result.includes.edges)
  const systemFiles = new Set(results.flatMap(result => result.includes.systemFiles))
  const files = new Set(results.map(result => result.unit.source))
  for (const edge of includeEdges) { files.add(edge.source); files.add(edge.target) }
  for (const fn of calls.nodes) if (fn.location) files.add(fn.location.file)
  const document = {
    schemaVersion: 1, tools,
    translationUnits: results.map(result => result.unit),
    files: [...files].sort().map(path => ({ id: path, path, kind: path.startsWith('@unresolved/') ? 'unresolved'
      : systemFiles.has(path) ? 'system' : path.startsWith('@generated/') ? 'generated' : path.startsWith('/') ? 'external' : 'project' })),
    includes: { edges: includeEdges },
    calls,
    controlFlow: results.flatMap(result => result.cfg),
    limitations: ['CFGs describe early GCC basic blocks, not exact original statement ranges.',
      'Graphs cover the selected preprocessing configuration. Macro source positions may be approximate.',
      'Unique external definitions are matched by name across selected units; this is not linker-level resolution.'],
  }
  validateGraphs(document)
  return document
}

export function validateGraphs(graphs) {
  const files = new Set(graphs.files.map(file => file.id))
  const functions = new Set(graphs.calls.nodes.map(fn => fn.id))
  for (const edge of graphs.includes.edges) if (!files.has(edge.source) || !files.has(edge.target)) throw new Error('Invalid include edge')
  for (const edge of graphs.calls.edges) if (!functions.has(edge.source) || !functions.has(edge.target)) throw new Error('Invalid call edge')
  for (const cfg of graphs.controlFlow) {
    if (!functions.has(cfg.functionId)) throw new Error('Invalid CFG function reference')
    const nodes = new Set(cfg.nodes.map(node => node.id))
    if (nodes.size !== cfg.nodes.length) throw new Error('Duplicate CFG node')
    for (const edge of cfg.edges) if (!nodes.has(edge.source) || !nodes.has(edge.target)) throw new Error('Invalid CFG edge')
  }
}
