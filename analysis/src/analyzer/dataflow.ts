import type { Node } from 'web-tree-sitter'
import type { Cfg, CfgNode } from './cfg.js'
import { declaratorName } from './cfg.js'
import type { Graph, GraphEdge, GraphNode } from './graph-types.js'

/**
 * Abstract memory locations (access paths):
 *   x, x.f.g           a variable or one of its fields
 *   *p, *p.f           what parameter p points to on entry (caller memory)
 *   *(*p.next)         memory reached by loading a pointer from caller memory;
 *                      nested loads collapse into the first one (k-limit 1)
 *   heap@a.c:7         one object per allocation site, or
 *   heap@a.c:7@m.c:20  the same site cloned for the call made at m.c:20 (1-call-site context)
 * Fields append `.name`. Array elements are not distinguished from their array.
 */
type Loc = string

export interface Summary {
  /** Locations the function writes / reads that its callers can name: parameter-relative,
   * global, or heap. Mapped onto each call site's arguments. */
  mod: Set<Loc>
  ref: Set<Loc>
  /** What a returned pointer may point to. */
  returns: Set<Loc>
  /** Pointers the function stores into caller-visible memory: key → targets. */
  stores: Map<Loc, Set<Loc>>
  /** Allocation sites created during a call (directly or in callees); cloned per call site. */
  owned: Set<string>
}

export interface FunctionInput {
  id: string
  cfg: Cfg
  /** Resolve a callee name to a defined function id (respecting static linkage). */
  resolve: (name: string) => string | undefined
  /** `file:line` of a syntax node, for naming heap objects and call contexts. */
  site: (node: Node) => string
}

interface CallFact { node: string; callee: string | undefined; args: Node[]; resultUsed: boolean }
interface Facts { defs: Set<Loc>; weak: Set<Loc>; uses: Set<Loc>; unresolved: Set<string>; calls: CallFact[] }

interface Context {
  input: FunctionInput
  params: string[]
  variables: Set<string>
  arrays: Set<string>
  globals: Set<string>
  /** Points-to for locals, parameter-relative, and heap locations of this function. */
  pts: Map<Loc, Set<Loc>>
  allocs: Set<string>
}

const ALLOCATORS = new Set(['malloc', 'calloc', 'realloc', 'aligned_alloc', 'strdup', 'strndup', 'reallocarray'])

/** Library effects by argument index. `modFrom`/`refFrom` cover variadic tails. Unknown
 * externals are assumed to read, not write, through pointer arguments. */
const LIBRARY: Record<string, { mod?: number[]; modFrom?: number; ref?: number[]; refFrom?: number }> = {
  scanf: { modFrom: 1, ref: [0] }, fscanf: { modFrom: 2, ref: [0, 1] }, sscanf: { modFrom: 2, ref: [0, 1] },
  fgets: { mod: [0], ref: [2] }, gets: { mod: [0] }, fread: { mod: [0], ref: [3] }, read: { mod: [1] },
  memcpy: { mod: [0], ref: [1] }, memmove: { mod: [0], ref: [1] }, memset: { mod: [0] },
  strcpy: { mod: [0], ref: [1] }, strncpy: { mod: [0], ref: [1] }, strcat: { mod: [0], ref: [0, 1] }, strncat: { mod: [0], ref: [0, 1] },
  sprintf: { mod: [0], refFrom: 1 }, snprintf: { mod: [0], refFrom: 2 }, vsprintf: { mod: [0], refFrom: 1 }, vsnprintf: { mod: [0], refFrom: 2 },
  free: {},
}

/** Fortified/builtin spellings produced by system headers: __builtin___memset_chk → memset. */
export function libraryName(name: string): string {
  return name.replace(/^__builtin___(\w+)_chk$/, '$1').replace(/^__builtin_/, '')
}

/** Compiler intrinsics that are not calls in the user's program. */
export const INTRINSICS = new Set(['__builtin_object_size', '__builtin_expect', '__builtin_constant_p', '__builtin_va_start',
  '__builtin_va_end', '__builtin_va_arg', '__builtin_va_copy', '__builtin_offsetof', '__builtin_dynamic_object_size'])

// ---- access paths ----

const HEAP = /^(heap@.+?:\d+)(?:@(.+?:\d+))?((?:\.\w+)*)$/
const isHeap = (loc: Loc) => loc.startsWith('heap@')
const isCallerRelative = (loc: Loc) => loc.startsWith('*')
/** `a` covers `b` when b is a or one of its fields. */
const covers = (a: Loc, b: Loc) => a === b || b.startsWith(`${a}.`)
const overlaps = (a: Loc, b: Loc) => covers(a, b) || covers(b, a)

function symbolic(loc: Loc): { inner: Loc; head: Loc; rest: string } | undefined {
  if (!loc.startsWith('*(')) return undefined
  let depth = 0
  for (let i = 1; i < loc.length; i++) {
    if (loc[i] === '(') depth++
    else if (loc[i] === ')' && --depth === 0) return { inner: loc.slice(2, i), head: loc.slice(0, i + 1), rest: loc.slice(i + 1) }
  }
  return undefined
}

function rootName(loc: Loc): string | undefined {
  if (isHeap(loc) || isCallerRelative(loc)) return undefined
  return /^[A-Za-z_]\w*/.exec(loc)?.[0]
}

const shortFile = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function displayLoc(loc: Loc): string {
  return loc.replace(/heap@([^@:]+):(\d+)(?:@([^@:]+):(\d+))?/g, (_m, f: string, l: string, cf?: string, cl?: string) =>
    cf ? `heap@${shortFile(f)}:${l}[${shortFile(cf)}:${cl}]` : `heap@${shortFile(f)}:${l}`)
}

export const emptySummary = (): Summary => ({ mod: new Set(), ref: new Set(), returns: new Set(), stores: new Map(), owned: new Set() })

function summaryKey(s: Summary): string {
  const sorted = (set: Set<string>) => [...set].sort()
  return JSON.stringify([sorted(s.mod), sorted(s.ref), sorted(s.returns), sorted(s.owned),
    [...s.stores].map(([k, v]) => [k, sorted(v)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))])
}

function unwrap(node: Node | null): Node | null {
  while (node && (node.type === 'parenthesized_expression' || node.type === 'cast_expression')) {
    node = node.type === 'cast_expression' ? node.childForFieldName('value') : node.namedChild(0)
  }
  return node
}

function declaredNames(fn: Node): { locals: Set<string>; arrays: Set<string> } {
  const locals = new Set<string>()
  const arrays = new Set<string>()
  for (const decl of fn.descendantsOfType('declaration')) {
    for (const child of decl?.namedChildren ?? []) {
      const target = child?.type === 'init_declarator' ? child.childForFieldName('declarator') : child
      if (!target || !/declarator$|^identifier$/.test(target.type) || target.type === 'function_declarator') continue
      const name = declaratorName(target)
      if (!name) continue
      locals.add(name)
      if (target.type === 'array_declarator') arrays.add(name)
    }
  }
  return { locals, arrays }
}

function argumentsOf(call: Node): Node[] {
  return (call.childForFieldName('arguments')?.namedChildren ?? []).filter((a): a is Node => a !== null && a.type !== 'comment')
}

const add = (set: Set<Loc>, items: Iterable<Loc>) => { for (const i of items) set.add(i) }

/** Analyses every function together so summaries can flow across calls. */
export class ProgramDataflow {
  private contexts = new Map<string, Context>()
  private summaries = new Map<string, Summary>()
  private facts = new Map<string, Map<string, Facts>>()
  /** Points-to for global-rooted locations, shared by all functions. */
  private globalPts = new Map<Loc, Set<Loc>>()

  constructor(functions: FunctionInput[], globals: Set<string>) {
    for (const fn of functions) {
      const syntax = fn.cfg.nodes[0]?.syntax
      const params = fn.cfg.nodes[0]?.params ?? []
      const { locals, arrays } = syntax ? declaredNames(syntax) : { locals: new Set<string>(), arrays: new Set<string>() }
      const ownGlobals = new Set([...globals].filter(g => !locals.has(g) && !params.includes(g)))
      const variables = new Set([...params.filter(Boolean), ...locals, ...ownGlobals])
      this.contexts.set(fn.id, { input: fn, params, variables, arrays, globals: ownGlobals, pts: new Map(), allocs: new Set() })
      this.summaries.set(fn.id, emptySummary())
    }
    this.solve()
  }

  summary(id: string): Summary { return this.summaries.get(id) ?? emptySummary() }

  // ---- points-to ----

  private ptsMap(ctx: Context, loc: Loc): Map<Loc, Set<Loc>> {
    const root = rootName(loc)
    return root !== undefined && ctx.globals.has(root) ? this.globalPts : ctx.pts
  }

  private ptsOf(ctx: Context, loc: Loc): Set<Loc> {
    return this.ptsMap(ctx, loc).get(loc) ?? new Set()
  }

  private addPts(ctx: Context, loc: Loc, targets: Iterable<Loc>): boolean {
    const map = this.ptsMap(ctx, loc)
    const set = map.get(loc) ?? new Set<Loc>()
    const before = set.size
    for (const t of targets) if (t !== loc) set.add(t)
    if (set.size !== before) { map.set(loc, set); return true }
    return false
  }

  /** Objects a pointer stored at `loc` may refer to. Unknown pointers in caller memory
   * become symbolic objects so callee effects can be mapped back at each call site. */
  private load(ctx: Context, loc: Loc): Set<Loc> {
    const known = this.ptsOf(ctx, loc)
    if (known.size) return known
    const root = rootName(loc)
    if (isCallerRelative(loc) || (root !== undefined && ctx.globals.has(root))) {
      const sym = symbolic(loc)
      return new Set([sym ? sym.head : `*(${loc})`])
    }
    return new Set()
  }

  /** Locations an lvalue denotes, and whether a write there is a strong (killing) update. */
  private lval(ctx: Context, expr: Node | null): { locs: Set<Loc>; strong: boolean } {
    const node = unwrap(expr)
    const none = { locs: new Set<Loc>(), strong: false }
    if (!node) return none
    const single = (locs: Set<Loc>) => locs.size === 1 && rootName([...locs][0]!) !== undefined
    switch (node.type) {
      case 'identifier':
        return ctx.variables.has(node.text) ? { locs: new Set([node.text]), strong: true } : none
      case 'pointer_expression': {
        if (node.childForFieldName('operator')?.text !== '*') return none
        const locs = this.targets(ctx, node.childForFieldName('argument'))
        return { locs, strong: single(locs) }
      }
      case 'subscript_expression': {
        const base = unwrap(node.childForFieldName('argument'))
        if (base?.type === 'identifier' && ctx.arrays.has(base.text)) return { locs: new Set([base.text]), strong: false }
        return { locs: this.targets(ctx, base), strong: false }
      }
      case 'field_expression': {
        const field = node.childForFieldName('field')?.text
        if (!field) return none
        if (node.childForFieldName('operator')?.text === '->') {
          const locs = new Set([...this.targets(ctx, node.childForFieldName('argument'))].map(t => `${t}.${field}`))
          return { locs, strong: single(locs) }
        }
        const inner = this.lval(ctx, node.childForFieldName('argument'))
        return { locs: new Set([...inner.locs].map(l => `${l}.${field}`)), strong: inner.strong }
      }
      default:
        return none
    }
  }

  /** Objects the value of `expr` may point to. */
  private targets(ctx: Context, expr: Node | null): Set<Loc> {
    const node = unwrap(expr)
    const out = new Set<Loc>()
    if (!node) return out
    switch (node.type) {
      case 'identifier':
        if (!ctx.variables.has(node.text)) return out
        if (ctx.arrays.has(node.text)) out.add(node.text)
        add(out, this.load(ctx, node.text))
        return out
      case 'pointer_expression':
        if (node.childForFieldName('operator')?.text === '&') return this.lval(ctx, node.childForFieldName('argument')).locs
        // A pointer loaded from memory: *pp
        for (const l of this.lval(ctx, node).locs) add(out, this.load(ctx, l))
        return out
      case 'field_expression': case 'subscript_expression':
        // A pointer stored in a struct field or array element (heap-stored pointers).
        for (const l of this.lval(ctx, node).locs) add(out, this.load(ctx, l))
        return out
      case 'binary_expression':
        for (const side of ['left', 'right']) add(out, this.targets(ctx, node.childForFieldName(side)))
        return out
      case 'conditional_expression':
        for (const side of ['consequence', 'alternative']) add(out, this.targets(ctx, node.childForFieldName(side)))
        return out
      case 'assignment_expression':
        return this.targets(ctx, node.childForFieldName('right'))
      case 'comma_expression':
        return this.targets(ctx, node.childForFieldName('right'))
      case 'call_expression': {
        const callee = node.childForFieldName('function')
        if (callee?.type !== 'identifier' || ctx.variables.has(callee.text)) return out
        if (ALLOCATORS.has(libraryName(callee.text))) {
          const site = `heap@${ctx.input.site(node)}`
          ctx.allocs.add(site)
          out.add(site)
          return out
        }
        const id = ctx.input.resolve(callee.text)
        const calleeCtx = id ? this.contexts.get(id) : undefined
        if (!id || !calleeCtx) return out
        for (const r of this.summary(id).returns) add(out, this.mapLoc(ctx, r, argumentsOf(node), calleeCtx, this.summary(id), ctx.input.site(node)))
        return out
      }
      default:
        return out
    }
  }

  /** Translate a callee-side location into the caller's terms at one call site. */
  private mapLoc(ctx: Context, loc: Loc, args: Node[], callee: Context, summary: Summary, site: string, depth = 0): Set<Loc> {
    const out = new Set<Loc>()
    if (depth > 8) return out
    const sym = symbolic(loc)
    if (sym) {
      for (const m of this.mapLoc(ctx, sym.inner, args, callee, summary, site, depth + 1)) {
        for (const l of this.load(ctx, m)) out.add(`${l}${sym.rest}`)
      }
      return out
    }
    const param = /^\*([A-Za-z_]\w*)((?:\.\w+)*)$/.exec(loc)
    if (param) {
      const i = callee.params.indexOf(param[1]!)
      const arg = i >= 0 ? args[i] : undefined
      if (arg) for (const t of this.targets(ctx, arg)) out.add(`${t}${param[2]}`)
      return out
    }
    const heap = HEAP.exec(loc)
    if (heap) {
      // Objects allocated during this call get a per-call-site name (1-call-site cloning).
      out.add(summary.owned.has(heap[1]!) ? `${heap[1]}@${site}${heap[3]}` : loc)
      return out
    }
    const root = rootName(loc)
    if (root !== undefined && callee.globals.has(root)) out.add(loc)
    return out
  }

  private callSites(ctx: Context): { call: Node; id: string; callee: Context; args: Node[] }[] {
    const syntax = ctx.input.cfg.nodes[0]?.syntax
    const out: { call: Node; id: string; callee: Context; args: Node[] }[] = []
    for (const call of syntax?.descendantsOfType('call_expression') ?? []) {
      const fn = call?.childForFieldName('function')
      if (!call || fn?.type !== 'identifier' || ctx.variables.has(fn.text)) continue
      const id = ctx.input.resolve(fn.text)
      const callee = id ? this.contexts.get(id) : undefined
      if (id && callee) out.push({ call, id, callee, args: argumentsOf(call) })
    }
    return out
  }

  private solvePointsTo(ctx: Context) {
    const syntax = ctx.input.cfg.nodes[0]?.syntax
    if (!syntax) return
    ctx.params.forEach(p => { if (p) this.addPts(ctx, p, [`*${p}`]) })
    const pairs: [Node, Node][] = []
    for (const decl of syntax.descendantsOfType('init_declarator')) {
      const target = decl?.childForFieldName('declarator')
      const value = decl?.childForFieldName('value')
      if (target && value) pairs.push([target, value])
    }
    for (const assign of syntax.descendantsOfType('assignment_expression')) {
      const left = assign?.childForFieldName('left')
      const right = assign?.childForFieldName('right')
      if (left && right && assign!.childForFieldName('operator')?.text === '=') pairs.push([left, right])
    }
    const calls = this.callSites(ctx)
    for (let changed = true, rounds = 0; changed && rounds < 50; rounds++) {
      changed = false
      for (const [lhs, rhs] of pairs) {
        const name = lhs.type.endsWith('declarator') ? declaratorName(lhs) : undefined
        const dest = name ? new Set([name]) : this.lval(ctx, lhs).locs
        const value = this.targets(ctx, rhs)
        // Struct copies carry the pointers held in their fields.
        const source = this.lval(ctx, rhs).locs
        for (const d of dest) {
          if (this.addPts(ctx, d, value)) changed = true
          for (const s of source) {
            for (const map of [ctx.pts, this.globalPts]) {
              for (const [k, v] of [...map]) if (k !== s && covers(s, k) && this.addPts(ctx, `${d}${k.slice(s.length)}`, v)) changed = true
            }
          }
        }
      }
      // Pointers a callee stores into memory reachable from its arguments.
      for (const { call, id, callee, args } of calls) {
        const summary = this.summary(id)
        const site = ctx.input.site(call)
        for (const [k, vs] of summary.stores) {
          const values = new Set<Loc>()
          for (const v of vs) add(values, this.mapLoc(ctx, v, args, callee, summary, site))
          for (const m of this.mapLoc(ctx, k, args, callee, summary, site)) if (this.addPts(ctx, m, values)) changed = true
        }
      }
    }
  }

  // ---- effects of one CFG node ----

  private effects(ctx: Context, node: CfgNode): Facts {
    const facts: Facts = { defs: new Set(), weak: new Set(), uses: new Set(), unresolved: new Set(), calls: [] }
    const syntax = node.kind === 'label' || node.kind === 'entry' ? undefined : node.syntax
    if (!syntax) return facts

    const define = (locs: Set<Loc>, strong: boolean) => {
      if (strong && locs.size === 1) facts.defs.add([...locs][0]!)
      else add(facts.weak, locs)
    }
    const addUses = (locs: Iterable<Loc>) => add(facts.uses, locs)

    /** Read the pointers and indices needed to reach an lvalue, not the lvalue itself. */
    const readPath = (expr: Node | null): void => {
      const n = unwrap(expr)
      if (!n) return
      switch (n.type) {
        case 'identifier': return
        case 'field_expression':
          if (n.childForFieldName('operator')?.text === '->') read(n.childForFieldName('argument'))
          else readPath(n.childForFieldName('argument'))
          return
        case 'pointer_expression': read(n.childForFieldName('argument')); return
        case 'subscript_expression': {
          const base = unwrap(n.childForFieldName('argument'))
          if (!(base?.type === 'identifier' && ctx.arrays.has(base.text))) read(base)
          read(n.childForFieldName('index'))
          return
        }
        default: read(n)
      }
    }

    const write = (target: Node | null, alsoRead: boolean) => {
      const lhs = unwrap(target)
      if (!lhs) return
      if (lhs.type === 'identifier' && !ctx.variables.has(lhs.text)) return
      const { locs, strong } = this.lval(ctx, lhs)
      if (locs.size === 0) facts.unresolved.add(lhs.text.replace(/\s+/g, ''))
      else { define(locs, strong); if (alsoRead) addUses(locs) }
      readPath(lhs)
    }

    const call = (n: Node) => {
      const callee = n.childForFieldName('function')
      const args = argumentsOf(n)
      const name = callee?.type === 'identifier' ? callee.text : undefined
      if (!name || ctx.variables.has(name)) read(callee)
      for (const arg of args) {
        const a = unwrap(arg)
        if (a?.type === 'pointer_expression' && a.childForFieldName('operator')?.text === '&') readPath(a.childForFieldName('argument'))
        else read(arg)
      }
      const id = name && !ctx.variables.has(name) ? ctx.input.resolve(name) : undefined
      const calleeCtx = id ? this.contexts.get(id) : undefined
      if (id && calleeCtx) {
        const summary = this.summary(id)
        const site = ctx.input.site(n)
        for (const l of summary.mod) add(facts.weak, this.mapLoc(ctx, l, args, calleeCtx, summary, site))
        for (const l of summary.ref) addUses(this.mapLoc(ctx, l, args, calleeCtx, summary, site))
      } else if (name) {
        const lib = LIBRARY[libraryName(name)]
        args.forEach((arg, i) => {
          const writes = lib ? (lib.mod?.includes(i) || (lib.modFrom !== undefined && i >= lib.modFrom)) : false
          const reads = lib ? (lib.ref?.includes(i) || (lib.refFrom !== undefined && i >= lib.refFrom)) : true
          const locs = this.targets(ctx, arg)
          if (writes) add(facts.weak, locs)
          if (reads) addUses(locs)
        })
      }
      facts.calls.push({ node: node.id, callee: calleeCtx ? id : undefined, args, resultUsed: n.parent?.type !== 'expression_statement' })
    }

    const read = (n: Node | null): void => {
      if (!n) return
      switch (n.type) {
        case 'assignment_expression':
          read(n.childForFieldName('right'))
          write(n.childForFieldName('left'), n.childForFieldName('operator')?.text !== '=')
          return
        case 'update_expression': write(n.childForFieldName('argument'), true); return
        case 'init_declarator': {
          read(n.childForFieldName('value'))
          const name = declaratorName(n.childForFieldName('declarator'))
          if (name) facts.defs.add(name)
          return
        }
        case 'call_expression': call(n); return
        case 'pointer_expression':
          if (n.childForFieldName('operator')?.text === '&') { readPath(n.childForFieldName('argument')); return }
          addUses(this.lval(ctx, n).locs)
          read(n.childForFieldName('argument'))
          return
        case 'subscript_expression': case 'field_expression': {
          const { locs } = this.lval(ctx, n)
          if (locs.size) { addUses(locs); readPath(n) } else for (const c of n.namedChildren) read(c)
          return
        }
        case 'identifier':
          if (ctx.variables.has(n.text)) facts.uses.add(n.text)
          return
        case 'sizeof_expression': case 'field_identifier': case 'type_identifier': case 'statement_identifier':
        case 'compound_statement': case 'type_descriptor':
          return
      }
      for (const child of n.namedChildren) read(child)
    }

    read(syntax)
    return facts
  }

  /** Entry defines parameters, globals, and every caller-visible object the body touches. */
  private entryFacts(ctx: Context, others: Facts[]): Facts {
    const facts: Facts = { defs: new Set(), weak: new Set(), uses: new Set(), unresolved: new Set(), calls: [] }
    ctx.params.forEach(p => { if (p) { facts.defs.add(p); facts.defs.add(`*${p}`) } })
    add(facts.defs, ctx.globals)
    for (const f of others) {
      for (const l of [...f.uses, ...f.defs, ...f.weak]) {
        const sym = symbolic(l)
        if (sym) facts.defs.add(sym.head)
      }
    }
    return facts
  }

  // ---- fixpoint over summaries ----

  private visible(ctx: Context, loc: Loc): boolean {
    const root = rootName(loc)
    return isCallerRelative(loc) || isHeap(loc) || (root !== undefined && ctx.globals.has(root))
  }

  private solve() {
    for (let round = 0; round < 30; round++) {
      let changed = false
      for (const [id, ctx] of this.contexts) {
        this.solvePointsTo(ctx)
        const entry = ctx.input.cfg.graph.entry
        const perNode = new Map<string, Facts>()
        for (const n of ctx.input.cfg.nodes) if (n.id !== entry) perNode.set(n.id, this.effects(ctx, n))
        if (entry) perNode.set(entry, this.entryFacts(ctx, [...perNode.values()]))
        this.facts.set(id, perNode)

        const next = emptySummary()
        add(next.owned, ctx.allocs)
        for (const { id: callee } of this.callSites(ctx)) add(next.owned, this.summary(callee).owned)
        for (const [nodeId, f] of perNode) {
          if (nodeId === entry) continue
          for (const l of [...f.defs, ...f.weak]) if (this.visible(ctx, l)) next.mod.add(l)
          for (const l of f.uses) if (this.visible(ctx, l)) next.ref.add(l)
          const node = ctx.input.cfg.nodes.find(n => n.id === nodeId)
          if (node?.kind === 'return') {
            for (const t of this.targets(ctx, node.syntax?.namedChild(0) ?? null)) if (this.visible(ctx, t)) next.returns.add(t)
          }
        }
        for (const [k, vs] of ctx.pts) {
          if (!isCallerRelative(k) && !isHeap(k)) continue
          const values = [...vs].filter(v => this.visible(ctx, v))
          if (values.length) next.stores.set(k, new Set(values))
        }
        if (summaryKey(next) !== summaryKey(this.summaries.get(id)!)) { this.summaries.set(id, next); changed = true }
      }
      if (!changed) break
    }
  }

  // ---- graphs ----

  /** Reaching definitions over access paths: a strong write kills paths it covers;
   * a definition reaches a use when their paths overlap (a struct and its fields). */
  private reaching(id: string): { edges: Map<string, Set<Loc>>; exposed: Map<string, Set<Loc>> } {
    const ctx = this.contexts.get(id)!
    const facts = this.facts.get(id)!
    const { cfg } = ctx.input
    type Def = { node: string; loc: Loc }
    const key = (d: Def) => `${d.node}\n${d.loc}`
    const inSet = new Map<string, Map<string, Def>>()
    const outSet = new Map<string, Map<string, Def>>(cfg.nodes.map(n => [n.id, new Map()]))
    for (let changed = true; changed;) {
      changed = false
      for (const node of cfg.nodes) {
        const incoming = new Map<string, Def>()
        for (const pred of cfg.preds.get(node.id) ?? []) for (const [k, d] of outSet.get(pred) ?? []) incoming.set(k, d)
        inSet.set(node.id, incoming)
        const f = facts.get(node.id)!
        const result = new Map([...incoming].filter(([, d]) => ![...f.defs].some(s => covers(s, d.loc))))
        for (const loc of [...f.defs, ...f.weak]) { const d = { node: node.id, loc }; result.set(key(d), d) }
        const previous = outSet.get(node.id)!
        if (result.size !== previous.size || [...result.keys()].some(k => !previous.has(k))) { outSet.set(node.id, result); changed = true }
      }
    }
    const edges = new Map<string, Set<Loc>>()
    const exposed = new Map<string, Set<Loc>>()
    for (const node of cfg.nodes) {
      for (const use of facts.get(node.id)!.uses) {
        for (const d of inSet.get(node.id)?.values() ?? []) {
          if (!overlaps(d.loc, use)) continue
          const k = `${d.node}\n${node.id}`
          edges.set(k, (edges.get(k) ?? new Set()).add(use))
          if (d.node === cfg.graph.entry) exposed.set(node.id, (exposed.get(node.id) ?? new Set()).add(use))
        }
      }
    }
    return { edges, exposed }
  }

  private describe(id: string, node: GraphNode): GraphNode {
    const f = this.facts.get(id)?.get(node.id)
    if (!f || node.kind === 'entry') return node
    const list = (s: Set<string>) => [...s].map(displayLoc).join(', ')
    const detail = [
      f.defs.size ? `defines ${list(f.defs)}` : '',
      f.weak.size ? `may define ${list(f.weak)}` : '',
      f.uses.size ? `uses ${list(f.uses)}` : '',
      f.unresolved.size ? `writes through ${[...f.unresolved].join(', ')} (unresolved alias)` : '',
      node.detail?.startsWith('expands to') ? node.detail : '',
    ].filter(Boolean).join('; ')
    return { ...node, ...(detail ? { detail } : {}), ...(f.unresolved.size ? { kind: 'alias' } : {}) }
  }

  private label(locs: Set<Loc>): string {
    return [...locs].map(displayLoc).join(', ')
  }

  functionGraph(id: string): Graph {
    const { cfg } = this.contexts.get(id)!.input
    const edges: GraphEdge[] = [...this.reaching(id).edges].map(([k, locs]) => {
      const [source, target] = k.split('\n') as [string, string]
      return { source, target, kind: 'data', label: this.label(locs) }
    })
    const involved = new Set(edges.flatMap(e => [e.source, e.target]))
    const nodes = cfg.graph.nodes.map(n => this.describe(id, n)).filter(n => involved.has(n.id) || n.kind === 'alias')
    return { id: `data:${id}`, title: `Data dependencies: ${id}`, entry: cfg.graph.entry ?? '', nodes, edges }
  }

  summaryText(id: string): { writes: string[]; reads: string[] } {
    const s = this.summary(id)
    return { writes: [...s.mod].map(displayLoc), reads: [...s.ref].map(displayLoc) }
  }

  /** Whole-program graph: intra edges of every function plus inter-procedural flows.
   * Globals travel along the call graph like pointer side effects (call site → callee entry
   * for globals the callee reads; writer → call site for globals it writes), so the edge
   * count grows with call sites rather than writes × reads. Flows between functions that
   * never call each other (e.g. two callbacks) are not drawn. */
  programGraph(): Graph {
    const nodes = new Map<string, GraphNode>()
    const edges: GraphEdge[] = []
    const addNode = (fnId: string, nodeId: string) => {
      if (nodes.has(nodeId)) return
      const node = this.contexts.get(fnId)?.input.cfg.graph.nodes.find(n => n.id === nodeId)
      if (node) nodes.set(nodeId, this.describe(fnId, node))
    }
    const link = (fnFrom: string, from: string, fnTo: string, to: string, kind: string, label: string) => {
      addNode(fnFrom, from); addNode(fnTo, to)
      edges.push({ source: from, target: to, kind, label })
    }
    for (const id of this.contexts.keys()) {
      for (const [k, locs] of this.reaching(id).edges) {
        const [s, t] = k.split('\n') as [string, string]
        link(id, s, id, t, 'data', this.label(locs))
      }
    }
    for (const id of this.contexts.keys()) {
      for (const [, f] of this.facts.get(id)!) {
        for (const call of f.calls) {
          if (!call.callee) continue
          const callee = this.contexts.get(call.callee)!
          const entry = callee.input.cfg.graph.entry!
          const params = callee.params.slice(0, call.args.length).filter(Boolean)
          if (params.length) link(id, call.node, call.callee, entry, 'param', params.join(', '))
          const summary = this.summary(call.callee)
          const globalsIn = new Set([...summary.ref].filter(l => rootName(l) !== undefined))
          if (globalsIn.size) link(id, call.node, call.callee, entry, 'global', this.label(globalsIn))
          for (const [nodeId, cf] of this.facts.get(call.callee)!) {
            if (nodeId === entry) continue
            const wrote = [...cf.defs, ...cf.weak].filter(l => summary.mod.has(l))
            const viaPointer = new Set(wrote.filter(l => rootName(l) === undefined))
            const globalsOut = new Set(wrote.filter(l => rootName(l) !== undefined))
            if (viaPointer.size) link(call.callee, nodeId, id, call.node, 'mod', this.label(viaPointer))
            if (globalsOut.size) link(call.callee, nodeId, id, call.node, 'global', this.label(globalsOut))
            const node = callee.input.cfg.nodes.find(n => n.id === nodeId)
            if (call.resultUsed && node?.kind === 'return' && node.syntax?.namedChildCount) link(call.callee, nodeId, id, call.node, 'return', 'return')
          }
        }
      }
    }
    return { id: 'program', title: 'Data dependencies: whole program', nodes: [...nodes.values()], edges }
  }
}
