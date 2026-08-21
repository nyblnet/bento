#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash step-engine rig.
//
//   node scripts/test-dash-steps.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. The step engine is where a workbook stops being a grid and
// starts being an ANSWER, so every failure here is a plausible number rather
// than a crash:
//
//   1. A JOIN THAT FANS OUT. A join declared `card: 'one'` meeting a key that
//      is not unique duplicates left rows, and every total below doubles. There
//      is nothing on screen to see. dash holds the declaration, so the engine
//      REFUSES; the check below is that it refuses rather than warns, and that
//      the frame it hands back is the one from BEFORE the join.
//   2. A FILTER THAT MISSPELLED A COLUMN. `regoin = "North"` matches nothing
//      and looks exactly like "there were no northern rows". One is data, the
//      other is a typo, and only a fatal tells them apart.
//   3. TWO GROUP KEYS COLLIDING. Concatenating group keys without a separator
//      merges ("ab","c") with ("a","bc") into one row — a subtotal over rows
//      that have nothing to do with each other, and a grand total that still
//      adds up, so the cross-check cannot see it either.
//   4. AN AGGREGATE THAT DISAGREES WITH THE CELL. `{fn:'sum'}` in a step and
//      `=SUM(col)` in a cell must be the same number on the SAME awkward data —
//      blanks, booleans, "2,000", "50%", text. Two implementations of SUM is
//      how a KPI tile and a total row come to disagree by a rounding error that
//      is not a rounding error.
//   5. THE PIPELINE GOING ROW-SHAPED. The whole design is an index vector: a
//      filter allocates an `Int32Array` and NOT a column. That is not asserted
//      here, it is MEASURED — `_internals.stats` counts base materialisations,
//      index entries, transient gathers and retained cells, and a filter chain
//      that copied a column per step could not pass the counts below.
//
// The load-bearing checks are the CROSS-CHECKS and the COUNTERS, not the
// literals: a literal can be updated to match a bug.

import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/**
 * The memory probe, run in a child with --expose-gc.
 *
 * It does the SAME work twice: once through the step engine, and once the way
 * a pipeline that had never heard of an index vector would do it — a `{v, f}`
 * object per cell, `Array.filter` per step, a Map keyed by a joined string.
 * Both answers are checked to agree before either heap number is believed,
 * because a cheaper wrong pipeline is not a comparison.
 */
const PROBE = `
const url = process.env.STEPS_URL
const { sourceOf, frameOf, runSteps } = await import(url)
const N = 100000
const R = ['North','South','East','West'], O = ['ana','bo','cy','dee','eve']
const region = new Array(N), owner = new Array(N), value = new Array(N)
for (let i = 0; i < N; i++) { region[i] = R[i%4]; owner[i] = O[i%5]; value[i] = (i*37)%1000 }
const mk = () => ({
  id:'big', name:'big', kind:'table', rids:[[1,N]], nextRid:N+1,
  columns:[{id:'region',name:'region',type:'text'},{id:'owner',name:'owner',type:'text'},{id:'value',name:'value',type:'number'}],
  data:{ region:{enc:'raw',v:region}, owner:{enc:'raw',v:owner}, value:{enc:'raw',v:value} },
  steps:[],
})
const steps = []
for (let i = 0; i < 20; i++) steps.push({ op:'filter', where:'value > ' + i })
steps.push({ op:'group', by:['region','owner'], agg:[{fn:'sum',of:'value',as:'t'},{fn:'count',as:'c'}] })

// Both sides are measured holding WHAT THEY MUST HOLD to answer another
// question about the same sheet: the columnar side its source and result, the
// row side its row objects and result. Measuring what each DISCARDS would
// flatter the row pipeline, which throws its intermediates away and keeps the
// same 44 MB of rows it started with.
const keep = []
globalThis.__keep = keep

global.gc(); const c0 = process.memoryUsage().heapUsed
const src = sourceOf(mk())
const r = runSteps(frameOf(src), steps, {})
keep.push(src, r)
const colTotal = [...r.frame.src.vec('t')].reduce((a,b)=>a+b,0)
global.gc(); const columnar = process.memoryUsage().heapUsed - c0

global.gc(); const r0 = process.memoryUsage().heapUsed
const all = new Array(N)
for (let i = 0; i < N; i++) all[i] = { region:{v:region[i],f:null}, owner:{v:owner[i],f:null}, value:{v:value[i],f:null} }
let rows = all
for (let i = 0; i < 20; i++) rows = rows.filter((x) => x.value.v > i)
const g = new Map()
for (const x of rows) {
  const k = x.region.v + '\\u001f' + x.owner.v
  let b = g.get(k); if (!b) { b = { s:0, c:0 }; g.set(k, b) }
  b.s += x.value.v; b.c++
}
let rowTotal = 0; for (const b of g.values()) rowTotal += b.s
keep.push(all, g)
global.gc(); const rowsHeap = process.memoryUsage().heapUsed - r0

if (colTotal !== rowTotal) { console.log('MISMATCH ' + colTotal + ' vs ' + rowTotal); process.exit(2) }
console.log(JSON.stringify({ columnar, rows: rowsHeap }))
`


// pivot.ts imports its stylesheet, which is Vite's job and not Node's. The
// engine itself imports no CSS; the stub is here because this rig cross-checks
// its group key against pivot.ts's, which is the point of having one.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const {
  runSteps, runSheet, sourceOf, frameOf, values, columnOf, materialize,
  PROVENANCE_OPS, _internals,
} = await import('../dash/src/steps.ts')
type StepResult = import('../dash/src/steps.ts').StepResult

const { evaluate } = await import('../dash/src/formula.ts')
const { compare } = await import('../dash/src/filter.ts')
const { _internals: pivotInternals } = await import('../dash/src/pivot.ts')
const { validateDoc } = await import('../dash/src/validate.ts')

type TableSheet = import('../dash/src/model.ts').TableSheet
type Step = import('../dash/src/model.ts').Step
type DashDoc = import('../dash/src/model.ts').DashDoc
type Cell = import('../dash/src/formula.ts').Cell

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// ----------------------------------------------------------------- fixtures

interface ColSpec { id: string; name?: string; type?: string; formula?: string; dict?: boolean }

function sheet(id: string, specs: ColSpec[], data: Record<string, unknown[]>): TableSheet {
  const n = Math.max(0, ...Object.values(data).map((v) => v.length))
  const out: TableSheet = {
    id, name: id, kind: 'table',
    rids: n ? [[1, n]] : [],
    nextRid: n + 1,
    columns: specs.map((s) => ({
      id: s.id, name: s.name ?? s.id, type: (s.type ?? 'text') as never,
      ...(s.formula ? { formula: s.formula } : {}),
    })) as never,
    data: {},
    steps: [{ op: 'import', from: 'rig', at: '2026-08-12T00:00:00.000Z' }],
  }
  for (const s of specs) {
    if (s.formula) continue
    const v = data[s.id] ?? new Array(n).fill(null)
    if (s.dict) {
      const dict: string[] = []
      const idx: Array<number | null> = v.map((x) => {
        if (x == null) return null
        const t = String(x)
        let k = dict.indexOf(t)
        if (k < 0) { k = dict.length; dict.push(t) }
        return k
      })
      out.data[s.id] = { enc: 'dict', dict, idx }
    } else {
      out.data[s.id] = { enc: 'raw', v: v as never }
    }
  }
  return out
}

const col = (r: StepResult, id: string): Cell[] => {
  const v = values(r.frame, id)
  return v ? [...v] : []
}
const codes = (r: StepResult): string[] => r.issues.map((i) => i.code)
const near = (a: unknown, b: number, eps = 1e-9): boolean =>
  typeof a === 'number' && Math.abs(a - b) < eps

// The running fixture: a small pipeline of deals, and a dimension to join to.
const PIPELINE = sheet('deals',
  [
    { id: 'region', type: 'text', dict: true }, { id: 'owner', type: 'text', dict: true },
    { id: 'stage', type: 'text', dict: true }, { id: 'value', type: 'number' },
  ],
  {
    region: ['North', 'north', 'South', 'South', null, 'North', 'East'],
    owner: ['ana', 'bo', 'ana', 'cy', 'bo', 'cy', 'zz'],
    stage: ['Won', 'Won', 'Lost', 'Won', 'Won', 'Lost', 'Won'],
    value: [100, 200, 50, 400, 25, 75, 10],
  },
)
const OWNERS = sheet('owners',
  [{ id: 'name', type: 'text', dict: true }, { id: 'team', type: 'text', dict: true }],
  { name: ['ana', 'bo', 'cy'], team: ['Alpha', 'Beta', 'Alpha'] },
)
const DOC = {
  format: 'bento/dash', version: 1, docId: 'rig', title: 'rig',
  sheets: [PIPELINE, OWNERS],
} as unknown as DashDoc

const run = (steps: Step[], from: TableSheet = PIPELINE): StepResult =>
  runSteps(from, steps, { doc: DOC, now: '2026-08-12T00:00:00.000Z' })

console.log('\n--- filter ------------------------------------------------------')
{
  const r = run([{ op: 'filter', where: 'value > 60' }])
  ok(r.ok && r.frame.n === 4, 'filter keeps the matching rows (4 of 7)')
  ok(col(r, 'value').join() === '100,200,400,75', 'and keeps them in order')
  ok(r.frame.rows instanceof Int32Array, 'the surviving rows are an Int32Array index vector')
  ok(sourceOf(PIPELINE) !== sourceOf(PIPELINE), 'two sourceOf calls are two stores (each memoises its own)')
}
{
  // THE POINT OF THE WHOLE FILE: the identity frame hands back the source's own
  // array, not a copy of it.
  const src = sourceOf(PIPELINE)
  const f = frameOf(src)
  ok(values(f, 'value') === src.vec('value'),
    'on the identity frame a column IS the source array — not a copy, the same object')
  const r = runSteps(f, [{ op: 'filter', where: 'value > 60' }], { doc: DOC })
  ok(r.frame.src === f.src, 'a filtered frame SHARES the parent column store')
}
{
  const r = run([{ op: 'filter', where: 'value > 0' }])
  ok(r.frame.rows === null && r.frame.n === 7,
    'a filter that filters nothing hands back the same identity frame — no allocation at all')
}
{
  const r = run([{ op: 'filter', where: 'AND(stage = "Won", value >= 100)' }])
  ok(r.frame.n === 3 && col(r, 'value').join() === '100,200,400',
    'a compound predicate uses formula.ts operators, not a second dialect')
}
{
  const r = run([{ op: 'filter', where: 'value > AVERAGE(value)' }])
  // mean of 100,200,50,400,25,75,10 = 122.857…
  ok(r.frame.n === 2 && col(r, 'value').join() === '200,400',
    'an AGGREGATE inside a predicate is evaluated over the frame (value > AVERAGE(value))')
}
{
  const r = run([{ op: 'filter', where: 'region = "North"' }])
  ok(r.frame.n === 3, 'text comparison is case-insensitive — "North" matches "north" too')
}
{
  const r = run([{ op: 'filter', where: 'regoin = "North"' }])
  ok(!r.ok && codes(r).includes('filter-unresolved'),
    'REFUSAL: a predicate that errored on every row is FATAL, not an empty result')
  ok(r.frame.n === 7 && r.ran === 0,
    'and the frame handed back is the one from BEFORE the filter, not an empty one')
}
{
  // one row errors, six do not: MOD by a value that is zero on exactly one row
  const s = sheet('mixed', [{ id: 'a', type: 'number' }, { id: 'b', type: 'number' }],
    { a: [1, 2, 3], b: [1, 0, 1] })
  const r = runSteps(s, [{ op: 'filter', where: 'MOD(a, b) = 0' }], {})
  ok(r.ok && r.frame.n === 2, 'rows whose predicate errored are dropped')
  ok(codes(r).includes('filter-errors') && r.issues.find((i) => i.code === 'filter-errors')!.rows === 1,
    'and COUNTED — a total below is short by exactly those rows, and says so')
}
{
  const s = sheet('blanks', [{ id: 'a', type: 'text' }], { a: ['x', null, '', 'y'] })
  const r = runSteps(s, [{ op: 'filter', where: 'a' }], {})
  ok(r.frame.n === 2, 'a blank is not a match (a blank cell is not a silent yes)')
}
{
  const r = run([{ op: 'filter' } as never])
  ok(r.ok && codes(r).includes('filter-empty'), 'a filter with no condition keeps everything, and says so')
}

console.log('\n--- derive ------------------------------------------------------')
{
  const r = run([{ op: 'derive', col: 'net', name: 'Net', expr: 'value * 0.9' }])
  ok(r.ok && near(col(r, 'net')[0], 90), 'derive computes a column')
  ok(columnOf(r.frame, 'Net')!.id === 'net', 'and it resolves by name as well as id')
  ok(columnOf(r.frame, 'net')!.type === 'number', 'the type is inferred when the step does not say')
}
{
  const r = run([
    { op: 'derive', col: 'share', name: 'Share', expr: 'value / SUM(value)' },
  ])
  const sum = col(r, 'share').reduce((a, b) => (a as number) + (b as number), 0)
  ok(near(sum, 1), 'a column and an aggregate mix by broadcasting (value / SUM(value) sums to 1)')
}
{
  const r = run([
    { op: 'derive', col: 'net', name: 'Net', expr: 'value * 2' },
    { op: 'filter', where: 'net > 200' },
  ])
  ok(r.ok && col(r, 'net').join() === '400,800', 'a derived column survives a later filter, re-indexed')
  ok(col(r, 'value').join() === '200,400', 'and the source columns re-index with it')
}
{
  const r = run([{ op: 'derive', col: 'x', name: 'x', expr: 'value / 0' }])
  ok(String(col(r, 'x')[0]) === '#DIV/0!', 'a derive error stays VISIBLE in the cell — never a zero')
  ok(codes(r).includes('derive-unresolved'), 'and is reported with a count')
}
{
  const r = run([{ op: 'derive', col: '', name: '', expr: '' } as never])
  ok(!r.ok && codes(r).includes('derive-incomplete'), 'a derive with no expression is fatal')
}

console.log('\n--- sort --------------------------------------------------------')
{
  const r = run([{ op: 'sort', by: 'value', dir: 'desc' }])
  ok(col(r, 'value').join() === '400,200,100,75,50,25,10', 'sort desc')
  const a = run([{ op: 'sort', by: 'value', dir: 'asc' }])
  ok(col(a, 'value').join() === '10,25,50,75,100,200,400', 'sort asc')
}
{
  // ties must keep their original order, and must do so because the comparator
  // is total — not because the engine's sort happens to be stable today
  const s = sheet('ties', [{ id: 'k', type: 'text' }, { id: 'v', type: 'number' }],
    { k: ['a', 'b', 'c', 'd'], v: [1, 1, 1, 1] })
  const r = runSteps(s, [{ op: 'sort', by: 'v', dir: 'asc' }], {})
  ok(col(r, 'k').join() === 'a,b,c,d', 'ties keep document order (the comparator tie-breaks on position)')
}
{
  const s = sheet('mix', [{ id: 'v', type: 'text' }], { v: ['10', '9', 'apple', '1 unit', null] })
  const r = runSteps(s, [{ op: 'sort', by: 'v', dir: 'asc' }], {})
  const mine = col(r, 'v')
  const theirs = ['10', '9', 'apple', '1 unit', null].slice().sort((a, b) => compare(a, b))
  ok(JSON.stringify(mine) === JSON.stringify(theirs),
    'step sort order IS filter.ts compare — a step-sorted result and a header sort agree')
}
{
  // The sort is stable because its comparator is a TOTAL order, not because
  // %TypedArray%.sort happens to be stable. Assert the property itself: a
  // comparator that dropped its position tie-break would return 0 here, and no
  // amount of sorting on a conformant engine could reveal it.
  const vals = [5, 5, 5, 1] as Cell[]
  for (const desc of [false, true]) {
    const cmp = _internals.sortComparator(vals, desc)
    let zeros = 0
    for (let i = 0; i < vals.length; i++) {
      for (let j = 0; j < vals.length; j++) if (i !== j && cmp(i, j) === 0) zeros++
      if (cmp(i, i) !== 0) zeros = -1
    }
    ok(zeros === 0, `the sort comparator is a TOTAL order over positions (${desc ? 'desc' : 'asc'}) — stability by construction`)
  }
}
{
  const r = run([{ op: 'sort', by: 'nope', dir: 'asc' }])
  ok(!r.ok && codes(r).includes('sort-missing-column'), 'sorting by a column that is not there is fatal')
}

console.log('\n--- limit -------------------------------------------------------')
{
  const r = run([{ op: 'sort', by: 'value', dir: 'desc' }, { op: 'limit', n: 3 } as never])
  ok(col(r, 'value').join() === '400,200,100', 'top-3 is sort + limit')
}
{
  const r = run([{ op: 'sort', by: 'value', dir: 'desc' }, { op: 'limit', n: 2, offset: 2 } as never])
  ok(col(r, 'value').join() === '100,75', 'limit takes an offset')
}
{
  const r = run([{ op: 'limit', n: 999 } as never])
  ok(r.frame.n === 7 && r.frame.rows === null, 'a limit past the end costs nothing')
}
{
  const r = run([{ op: 'limit' } as never])
  ok(!r.ok && codes(r).includes('limit-missing-n'), 'a limit with no count is fatal')
}

console.log('\n--- group -------------------------------------------------------')
{
  const r = run([{
    op: 'group', by: ['region'],
    agg: [{ fn: 'sum', of: 'value', as: 'total' }, { fn: 'count', as: 'deals' }],
  }])
  ok(r.ok && r.frame.n === 4, 'group by one key: North/South/(blank)/East')
  ok(col(r, 'region').join() === 'North,South,,East', 'groups appear in first-seen order, labelled as typed')
  ok(col(r, 'total').join() === '375,450,25,10', '"North" and "north" are ONE group — the filter menu\'s rule')
  ok(col(r, 'deals').join() === '3,2,1,1', 'count with no `of` is COUNT(*), the number of rows')
}
{
  const r = run([{ op: 'group', by: ['region'], agg: [{ fn: 'sum', of: 'value', as: 't' }] }])
  const total = (col(r, 't') as number[]).reduce((a, b) => a + b, 0)
  ok(total === 860, 'CROSS-CHECK: the group totals sum to the sheet total (100+200+50+400+25+75+10)')
}
{
  const r = run([{
    op: 'group', by: ['region', 'stage'],
    agg: [{ fn: 'sum', of: 'value', as: 't' }],
  }])
  const total = (col(r, 't') as number[]).reduce((a, b) => a + b, 0)
  ok(r.frame.n === 6 && total === 860, 'two-dimension group-by, and it still sums to the sheet total')
}
{
  // NEGATIVE CONTROL, in the rig itself: keys that would collide under bare
  // concatenation must NOT be merged.
  // The values are CHOSEN to collide: the canonical keys are "t:at:b"+"t:c"
  // and "t:a"+"t:bt:c", which are the same string when concatenated and
  // different when separated. A fixture that does not collide proves nothing
  // — the first version of this check used ("ab","c") vs ("a","bc") and passed
  // against a deliberately broken engine, because matchKey's "t:" prefix
  // happened to disambiguate it.
  const s = sheet('collide', [{ id: 'a', type: 'text' }, { id: 'b', type: 'text' }, { id: 'v', type: 'number' }],
    { a: ['at:b', 'a'], b: ['c', 'bt:c'], v: [1, 2] })
  const r = runSteps(s, [{ op: 'group', by: ['a', 'b'], agg: [{ fn: 'sum', of: 'v', as: 't' }] }], {})
  ok(r.frame.n === 2 && col(r, 't').join() === '1,2',
    'two key pairs whose canonical keys CONCATENATE identically stay TWO groups — the parts are separated, not glued')
}
{
  const r = run([{ op: 'group', by: ['region'], agg: [{ fn: 'sum', of: 'nope', as: 't' }] }])
  ok(!r.ok && codes(r).includes('group-missing-measure'),
    'aggregating a column that is not there is fatal — it would total to a believable zero')
  const g = run([{ op: 'group', by: ['nope'], agg: [{ fn: 'count', as: 'c' }] }])
  ok(!g.ok && codes(g).includes('group-missing-column'),
    'grouping by a column that is not there is fatal — it would collapse everything into one row')
}
{
  const r = run([{ op: 'group', by: ['region'], agg: [{ fn: 'median', of: 'value', as: 'm' }] }])
  ok(r.ok && near(col(r, 'm')[0], 100), 'MEDIAN comes free through formula.ts — one expression language')
  const d = run([{ op: 'group', by: ['stage'], agg: [{ fn: 'countDistinct', of: 'owner', as: 'k' }] }])
  ok(col(d, 'k').join() === '4,2', 'countDistinct maps onto COUNTUNIQUE')
  const u = run([{ op: 'group', by: ['region'], agg: [{ fn: 'wibble', of: 'value', as: 'w' }] }])
  ok(String(col(u, 'w')[0]) === '#NAME?' && codes(u).includes('group-unknown-agg'),
    'an aggregate nobody has heard of reads #NAME?, not a plausible total')
}
{
  ok(_internals.matchKey('North') === pivotInternals.matchKey('North')
    && _internals.matchKey(' north ') === pivotInternals.matchKey(' north ')
    && _internals.matchKey(null) === pivotInternals.matchKey(null)
    && _internals.matchKey('10.0') === pivotInternals.matchKey('10.0')
    && _internals.matchKey(10) === pivotInternals.matchKey(10),
    'the step engine\'s group key IS pivot.ts\'s group key — one answer to "what is a category"')
}

console.log('\n--- one meaning for SUM -----------------------------------------')
{
  // The awkward data, on purpose: a blank, an empty string, text, booleans, a
  // grouped number and a percent-notated one.
  const nasty: unknown[] = [1, null, '', 'n/a', true, false, '2,000', '50%', 0, -3]
  const s = sheet('nasty', [{ id: 'v', type: 'number' }], { v: nasty })
  const cells = new Map<string, Cell[]>([['v', nasty as Cell[]], ['V', nasty as Cell[]]])
  for (const [fn, expr] of [
    ['sum', 'SUM(v)'], ['count', 'COUNT(v)'], ['avg', 'AVERAGE(v)'],
    ['min', 'MIN(v)'], ['max', 'MAX(v)'],
  ] as const) {
    const stepped = runSteps(s, [{ op: 'group', by: [], agg: [{ fn, of: 'v', as: 'a' }] }] as never, {})
    const mine = values(stepped.frame, 'a')![0]
    const cell = evaluate(expr, { cols: cells, n: nasty.length })[0]
    ok(String(mine) === String(cell),
      `the fast path for ${fn} is BIT-IDENTICAL to ${expr} in a cell (${String(cell)})`)
  }
}
{
  // An ERROR inside a group. formula.ts propagates it out of every aggregate
  // that computes and ignores it in every aggregate that counts; a fast path
  // that quietly totalled the rows that worked would report a number with a
  // piece missing and no way to tell.
  const s = sheet('err', [{ id: 'v', type: 'number' }, { id: 'z', type: 'number' }], { v: [1, 2, 3], z: [1, 0, 1] })
  const r = runSteps(s, [
    { op: 'derive', col: 'q', name: 'q', expr: 'v / z' },
    { op: 'group', by: [], agg: [{ fn: 'sum', of: 'q', as: 's' }, { fn: 'count', of: 'q', as: 'c' }] },
  ] as never, {})
  ok(String(col(r, 's')[0]) === '#DIV/0!',
    'SUM over a group holding an error IS the error — not the total of the rows that worked')
  ok(col(r, 'c')[0] === 2, 'and COUNT is not poisoned by it, exactly as in a cell')
}
{
  const s = sheet('empty', [{ id: 'v', type: 'number' }], { v: ['x'] })
  const r = runSteps(s, [{ op: 'group', by: [], agg: [
    { fn: 'sum', of: 'v', as: 's' }, { fn: 'min', of: 'v', as: 'n' }, { fn: 'avg', of: 'v', as: 'a' },
  ] }] as never, {})
  ok(col(r, 's')[0] === 0 && col(r, 'n')[0] === 0 && String(col(r, 'a')[0]) === '#DIV/0!',
    'and the EMPTY cases match formula.ts too (SUM 0, MIN 0, AVERAGE #DIV/0!)')
}
{
  // A BLANK IS NOT A ZERO in an aggregate — the failure that drags every
  // average toward zero in exact proportion to how sparse the column is.
  const s = sheet('sparse', [{ id: 'v', type: 'number' }], { v: [3, null, null, 9, '', null] })
  const r = runSteps(s, [{ op: 'group', by: [], agg: [
    { fn: 'avg', of: 'v', as: 'a' }, { fn: 'min', of: 'v', as: 'n' }, { fn: 'count', of: 'v', as: 'c' },
  ] }] as never, {})
  ok(col(r, 'a')[0] === 6 && col(r, 'n')[0] === 3 && col(r, 'c')[0] === 2,
    'AVERAGE of [3,,,9,,] is 6 and MIN is 3 — blanks are absent, not zeroes')
}

console.log('\n--- join, and the refusal ---------------------------------------')
{
  const r = run([{ op: 'join', with: 'owners', on: ['owner', 'name'], card: 'one', fields: ['team'] }])
  ok(r.ok && r.frame.n === 7, 'a card:"one" join keeps exactly the rows it started with')
  ok(col(r, 'team').join() === 'Alpha,Beta,Alpha,Alpha,Beta,Alpha,',
    'and brings the dimension column across, blank where nothing matched')
  ok(codes(r).includes('join-unmatched'),
    'an unmatched key is REPORTED — a row is never silently dropped by a join')
}
{
  // the dimension is no longer a dimension: two rows for "ana"
  const dupes = sheet('owners2',
    [{ id: 'name', type: 'text' }, { id: 'team', type: 'text' }],
    { name: ['ana', 'ana', 'bo', 'cy'], team: ['Alpha', 'Gamma', 'Beta', 'Alpha'] })
  const doc = { ...DOC, sheets: [PIPELINE, dupes] } as DashDoc
  const r = runSteps(PIPELINE,
    [{ op: 'join', with: 'owners2', on: ['owner', 'name'], card: 'one', fields: ['team'] }], { doc })
  ok(!r.ok, 'REFUSAL: a card:"one" join whose data holds two rows for a key does NOT run')
  const f = r.issues.find((i) => i.code === 'join-fanout')!
  ok(f !== undefined && f.severity === 'fatal', 'it is a fatal `join-fanout`, not a warning beside a doubled total')
  ok(f.message.includes('"ana"') && f.rows === 2,
    'and it names the offending key and how many duplicate rows it would have added')
  ok(r.frame.n === 7 && !values(r.frame, 'team'),
    'the frame handed back is the one from BEFORE the join — no fanned rows exist anywhere')

  // the same data, declared honestly, DOES run
  const m = runSteps(PIPELINE,
    [{ op: 'join', with: 'owners2', on: ['owner', 'name'], card: 'many', fields: ['team'] }], { doc })
  ok(m.ok && m.frame.n === 9, 'declared card:"many" performs the fanout (7 rows become 9)')
  ok(codes(m).includes('join-fanned'), 'and says out loud that the grain changed')
  const doubled = (values(m.frame, 'value') as number[]).reduce((a, b) => a + b, 0)
  ok(doubled === 1010 && doubled !== 860,
    'the fanned total IS different from the true total — which is exactly why card:"one" refuses')
}
{
  const r = run([{ op: 'join', with: 'nope', on: ['owner', 'name'], card: 'one', fields: [] }])
  ok(!r.ok && codes(r).includes('join-missing-sheet'), 'joining to a sheet that is not there is fatal')
  const c = run([{ op: 'join', with: 'owners', on: ['owner', 'nope'], card: 'one', fields: [] }])
  ok(!c.ok && codes(c).includes('join-missing-column'), 'joining on a column that is not there is fatal')
  const f = run([{ op: 'join', with: 'owners', on: ['owner', 'name'], card: 'one', fields: ['nope'] }])
  ok(!f.ok && codes(f).includes('join-missing-field'), 'taking a field that is not there is fatal')
}
{
  const twin = sheet('twin', [{ id: 'name', type: 'text' }, { id: 'value', type: 'number' }],
    { name: ['ana', 'bo', 'cy'], value: [1, 2, 3] })
  const doc = { ...DOC, sheets: [PIPELINE, twin] } as DashDoc
  const r = runSteps(PIPELINE,
    [{ op: 'join', with: 'twin', on: ['owner', 'name'], card: 'one', fields: ['value'] }], { doc })
  ok(r.ok && codes(r).includes('join-name-clash'), 'a name that exists on both sides is renamed, and reported')
  ok(values(r.frame, 'twin.value') !== undefined && (values(r.frame, 'value') as Cell[])[0] === 100,
    'and the LEFT column keeps its name and its values')
}

console.log('\n--- union -------------------------------------------------------')
{
  const more = sheet('more',
    [{ id: 'region', type: 'text' }, { id: 'owner', type: 'text' }, { id: 'stage', type: 'text' }, { id: 'value', type: 'number' }],
    { region: ['West'], owner: ['dee'], stage: ['Won'], value: [500] })
  const doc = { ...DOC, sheets: [PIPELINE, more] } as DashDoc
  const r = runSteps(PIPELINE, [{ op: 'union', with: 'more' } as never], { doc })
  ok(r.ok && r.frame.n === 8, 'union appends the other sheet\'s rows')
  ok((values(r.frame, 'value') as number[]).reduce((a, b) => a + b, 0) === 1360,
    'and the totals add up')
}
{
  const partial = sheet('partial', [{ id: 'region', type: 'text' }, { id: 'note', type: 'text' }],
    { region: ['West'], note: ['hi'] })
  const doc = { ...DOC, sheets: [PIPELINE, partial] } as DashDoc
  const r = runSteps(PIPELINE, [{ op: 'union', with: 'partial' } as never], { doc })
  ok(r.ok && codes(r).includes('union-shape'), 'a column present on one side only is filled blank and REPORTED')
  ok((values(r.frame, 'value') as Cell[])[7] === null,
    'and the missing values are BLANK, not zero — nothing below will total them as zero')
}
{
  const alien = sheet('alien', [{ id: 'x', type: 'text' }], { x: ['q'] })
  const doc = { ...DOC, sheets: [PIPELINE, alien] } as DashDoc
  const r = runSteps(PIPELINE, [{ op: 'union', with: 'alien' } as never], { doc })
  ok(!r.ok && codes(r).includes('union-disjoint'), 'unioning two sheets that share no columns is fatal')
}
{
  const dup = sheet('dup',
    [{ id: 'region', type: 'text' }, { id: 'owner', type: 'text' }, { id: 'stage', type: 'text' }, { id: 'value', type: 'number' }],
    { region: ['North'], owner: ['ana'], stage: ['Won'], value: [100] })
  const doc = { ...DOC, sheets: [PIPELINE, dup] } as DashDoc
  const all = runSteps(PIPELINE, [{ op: 'union', with: 'dup' } as never], { doc })
  ok(all.frame.n === 8, 'UNION ALL is the default, as in SQL')
  const one = runSteps(PIPELINE, [{ op: 'union', with: 'dup', all: false } as never], { doc })
  ok(one.frame.n === 7 && codes(one).includes('union-deduped'), 'all:false dedupes whole rows, and says how many')
}

console.log('\n--- the pipeline composed ---------------------------------------')
{
  // docs/dash-sql.md's worked example, minus HAVING's dependency on a name the
  // group produced — which is the whole point of running filter AFTER group.
  //
  //   SELECT region, SUM(value) AS pipeline, COUNT(*) AS deals
  //   FROM Pipeline JOIN Owners ON owner = name
  //   WHERE stage <> 'Lost' GROUP BY region HAVING SUM(value) > 100
  //   ORDER BY pipeline DESC LIMIT 2
  const r = run([
    { op: 'filter', where: 'stage <> "Lost"' },
    { op: 'join', with: 'owners', on: ['owner', 'name'], card: 'one', fields: ['team'] },
    { op: 'group', by: ['region'], agg: [{ fn: 'sum', of: 'value', as: 'pipeline' }, { fn: 'count', as: 'deals' }] },
    { op: 'filter', where: 'pipeline > 100' },
    { op: 'sort', by: 'pipeline', dir: 'desc' },
    { op: 'limit', n: 2 } as never,
  ])
  ok(r.ok, 'filter → join → group → having → sort → limit runs clean')
  ok(col(r, 'region').join() === 'South,North', 'and produces the right groups in the right order')
  ok(col(r, 'pipeline').join() === '400,300', 'with the right totals')
  ok(col(r, 'deals').join() === '1,2', 'and the right counts')
  ok(r.ran === 6, 'every step ran')
}
{
  // grouping AFTER a join at the wrong grain is the classic wrong number; this
  // asserts the engine at least never gets there quietly
  const dupes = sheet('owners2', [{ id: 'name', type: 'text' }, { id: 'team', type: 'text' }],
    { name: ['ana', 'ana', 'bo', 'cy'], team: ['Alpha', 'Gamma', 'Beta', 'Alpha'] })
  const doc = { ...DOC, sheets: [PIPELINE, dupes] } as DashDoc
  const r = runSteps(PIPELINE, [
    { op: 'join', with: 'owners2', on: ['owner', 'name'], card: 'one', fields: ['team'] },
    { op: 'group', by: ['region'], agg: [{ fn: 'sum', of: 'value', as: 't' }] },
  ], { doc })
  ok(!r.ok && r.ran === 0 && codes(r).includes('join-fanout'),
    'a fanning join stops the pipeline BEFORE the group-by that would have doubled the totals')
}

console.log('\n--- ops this build does not run ---------------------------------')
{
  const r = run([{ op: 'filter', where: 'value > 60' }, { op: 'pivot', by: ['region'] } as never, { op: 'limit', n: 1 } as never])
  ok(!r.ok && r.unresolved && codes(r).includes('step-not-implemented'),
    'pivot/unpivot are DEFERRED and say so rather than half-running')
  ok(r.frame.n === 4 && r.ran === 1, 'the pipeline stops there — the limit below it never ran')
}
{
  const r = run([{ op: 'filter', where: 'value > 60' }, { op: 'teleport', to: 'mars' } as never])
  ok(!r.ok && r.unresolved && codes(r).includes('unknown-op'),
    'an op from a NEWER build marks its descendants unresolved — never zero, never skipped')
}
{
  const r = run([
    { op: 'import', from: 'x.csv', at: '2026-01-01' },
    { op: 'type', col: 'value', as: 'number' },
    { op: 'patch', key: ['owner'], edits: [] },
    { op: 'filter', where: 'value > 60' },
  ])
  ok(r.ok && r.ran === 4 && r.frame.n === 4,
    'import/bind/type/patch are provenance and settled elsewhere — carried, not re-run')
  ok(PROVENANCE_OPS.has('import') && PROVENANCE_OPS.has('bind') && !PROVENANCE_OPS.has('filter'),
    'PROVENANCE_OPS names the seam store.ts needs for applySteps')
}
{
  const packed = sheet('packed', [{ id: 'v', type: 'number' }], { v: [1] })
  packed.data.v = { enc: 'pack', b64: 'AAAA', n: 1 }
  const r = runSteps(packed, [{ op: 'filter', where: 'v > 0' }], {})
  ok(!r.ok && codes(r).includes('step-threw'),
    'a PACKED column refuses loudly — reading it as null would group the whole sheet into "(blank)"')
}

console.log('\n--- results are real sheets -------------------------------------')
{
  const r = run([
    { op: 'filter', where: 'stage = "Won"' },
    { op: 'derive', col: 'net', name: 'Net', expr: 'value * 0.9' },
    { op: 'group', by: ['region'], agg: [{ fn: 'sum', of: 'net', as: 'total' }] },
  ])
  const out = materialize(r.frame, { id: 'result', name: 'Result', from: 'deals' })
  ok(out.kind === 'table' && out.rids[0][1] === r.frame.n, 'materialize produces a table sheet with matching rids')
  const doc = { ...DOC, sheets: [PIPELINE, OWNERS, out] } as DashDoc
  const v = validateDoc(doc)
  ok(v.counts.fatal === 0, 'and validate.ts finds nothing fatal in it — it is a sheet like any other')
  const again = runSteps(out, [{ op: 'sort', by: 'total', dir: 'desc' }], {})
  ok(again.ok, 'and the pipeline runs over it again')
}
{
  const r = run([{ op: 'derive', col: 'x', name: 'x', expr: 'value / 0' }])
  const out = materialize(r.frame, { id: 'e', name: 'e' })
  ok((out.data.x as { v: unknown[] }).v[0] === '#DIV/0!',
    'an error cell materialises as its CODE — a saved result never hides one as a blank')
}
{
  const r = runSheet(DOC, 'deals')
  ok(r !== undefined && r.ok && r.frame.n === 7, 'runSheet runs a sheet\'s own step list')
  ok(runSheet(DOC, 'nope') === undefined, 'and answers undefined for a sheet that is not there')
}

console.log('\n--- overrides ---------------------------------------------------')
{
  const s = sheet('ov', [{ id: 'v', type: 'number' }], { v: [1, 2, 3] })
  s.cells = { 'v:2': { v: 99, why: 'corrected' } }
  const r = runSteps(s, [{ op: 'group', by: [], agg: [{ fn: 'sum', of: 'v', as: 't' }] }] as never, {})
  ok(values(r.frame, 't')![0] === 103,
    'a hand correction is part of the data — the pipeline totals 1+99+3, not 1+2+3')
}
{
  const s = sheet('fx', [{ id: 'a', type: 'number' }, { id: 'b', type: 'number', formula: 'a * 2' }], { a: [1, 2, 3] })
  const r = runSteps(s, [{ op: 'filter', where: 'b > 2' }], {})
  ok(r.frame.n === 2 && values(r.frame, 'b')!.join() === '4,6',
    'a FORMULA column is computed by recalc and steps over it like any other')
}

// --------------------------------------------------- the shape of the engine
//
// Everything above proves the ANSWERS. This proves the SHAPE — that the answers
// were reached with an index vector rather than by copying columns or building
// row objects. It is measured, not asserted, because a comment claiming O(1)
// survives the change that makes it O(n).

console.log('\n--- the index vector, measured ----------------------------------')
const N = 100_000
function bigSheet(n: number): TableSheet {
  const region = new Array(n)
  const owner = new Array(n)
  const value = new Array(n)
  const REGIONS = ['North', 'South', 'East', 'West']
  const OWNERS_ = ['ana', 'bo', 'cy', 'dee', 'eve']
  for (let i = 0; i < n; i++) {
    region[i] = REGIONS[i % 4]
    owner[i] = OWNERS_[i % 5]
    value[i] = (i * 37) % 1000
  }
  return sheet('big',
    [{ id: 'region', type: 'text', dict: true }, { id: 'owner', type: 'text', dict: true }, { id: 'value', type: 'number' }],
    { region, owner, value })
}
const BIG = bigSheet(N)

{
  _internals.resetStats()
  // TWENTY chained filters. A pipeline that copied a column per step would
  // retain 20 × 100,000 cells; this one retains none, and gathers only the rows
  // still in play — which shrink.
  const steps: Step[] = []
  for (let i = 0; i < 20; i++) steps.push({ op: 'filter', where: `value > ${i}` })
  const r = runSteps(BIG, steps, {})
  const s = _internals.stats
  ok(r.ok && r.frame.n < N, `20 chained filters over ${N} rows ran (${r.frame.n} rows survive)`)
  ok(s.retainedCells === 0,
    'RETAINED cells across all 20 filters: 0 — a filter never keeps a copy of a column')
  ok(s.sourceCells === N,
    `the column was materialised from the sheet ONCE (${s.sourceCells} cells, not ${20 * N})`)
  ok(s.gatherCells === 0,
    `transient gathers across all 20 filters: ${s.gatherCells} cells — a row-wise predicate reads the source arrays through the index vector and copies NOTHING`)
  ok(s.indexCells < 21 * N && r.frame.rows instanceof Int32Array,
    `and everything else the steps allocated was Int32Array index entries (${s.indexCells}, one per surviving row per step)`)
  ok(s.maskBytes < 21 * N, `plus one BYTE per row per step while deciding (${s.maskBytes})`)
}
{
  // AND THE HEAP, WHICH IS THE MEASUREMENT THAT ACTUALLY DISCRIMINATES.
  //
  // Wall-clock does not: measured, a naive row-object pipeline over 100k rows
  // takes about the same MILLISECONDS as this one. What it does not do is fit
  // in memory — the concepting's number is 44 MB per million {v,f} cells — and
  // that is what decides whether a ten-million-row workbook opens at all. So
  // the rig builds the row-shaped equivalent alongside and compares the two,
  // as a RATIO, which no machine's speed can flatter.
  //
  // It runs in a child with --expose-gc, because a heapUsed delta without a
  // forced collection is noise of the same order as the thing being measured.
  const probe = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', PROBE], {
    encoding: 'utf8',
    env: { ...process.env, STEPS_URL: pathToFileURL(new URL('../dash/src/steps.ts', import.meta.url).pathname).href },
  })
  const line = (probe.stdout || '').trim().split('\n').pop() ?? ''
  let m: { columnar: number; rows: number } | null = null
  try { m = JSON.parse(line) } catch { m = null }
  ok(m !== null, `the memory probe ran (${probe.status === 0 ? 'ok' : (probe.stderr || '').trim().split('\n').pop()})`)
  if (m) {
    const cMB = (m.columnar / 1048576).toFixed(1)
    const rMB = (m.rows / 1048576).toFixed(1)
    ok(m.columnar * 5 < m.rows,
      `the engine holds ${cMB} MB to answer over ${N} rows, against ${rMB} MB for the same answer row-shaped — 5× is the floor, and it is the number that decides whether 10M rows opens at all`)
    ok(m.columnar < 8 * 1024 * 1024,
      `and ${cMB} MB in absolute terms, over ${N} rows (budget 8 MB)`)
  }
}
{
  const src = sourceOf(BIG)
  const f = frameOf(src)
  ok(values(f, 'value') === src.vec('value'),
    `and at ${N} rows the identity frame still hands back the source array itself`)
}
{
  // The other side of the crossover. Once the frame is a small fraction of the
  // source, evaluating over the whole source is the wasteful choice — so it
  // gathers, and the gather costs the SURVIVING rows and not the sheet.
  _internals.resetStats()
  const r = runSteps(BIG, [
    { op: 'sort', by: 'value', dir: 'desc' }, { op: 'limit', n: 100 } as never,
    { op: 'filter', where: 'value > 900' },
  ], {})
  ok(r.ok && _internals.stats.gatherCells === 100,
    `a filter over a 100-row frame of a ${N}-row sheet gathers 100 cells, not ${N} (${_internals.stats.gatherCells})`)
}
{
  // A HAVING-shaped predicate — one with an aggregate in it — must see the
  // FRAME and not the sheet, so it takes the gather path on purpose.
  _internals.resetStats()
  const r = runSteps(BIG, [
    { op: 'filter', where: 'value > 500' },
    { op: 'filter', where: 'value > AVERAGE(value)' },
  ], {})
  const half = r.frame.n
  ok(r.ok && _internals.stats.gatherCells > 0 && half > 0,
    'an aggregate inside a predicate falls back to the gather path — it must see the frame, not the sheet')
}

console.log('\n--- performance floors ------------------------------------------')
//
// BUDGETS, not measurements. They sit far enough above what this machine does
// that ordinary variance cannot trip them, and far enough below a row-shaped
// implementation that a regression to one cannot pass. The concepting's numbers
// are for 10M rows on the columnar kernel; these are 100k through the shared
// expression engine, which is the honest comparison for what this file does.
const timed = (label: string, budget: number, f: () => unknown): void => {
  f() // warm
  const t0 = performance.now()
  const out = f()
  const ms = performance.now() - t0
  ok(ms < budget, `${label}: ${ms.toFixed(1)} ms (budget ${budget} ms)`)
  void out
}
{
  const src = sourceOf(BIG)
  timed(`filter + two-key group-by with sum and count over ${N} rows`, 250, () => {
    const r = runSteps(frameOf(src), [
      { op: 'filter', where: 'value > 400' },
      { op: 'group', by: ['region', 'owner'], agg: [{ fn: 'sum', of: 'value', as: 't' }, { fn: 'count', as: 'c' }] },
    ], {})
    if (!r.ok) throw new Error('the perf pipeline did not run')
    return r
  })
  timed(`top-100 of ${N} rows`, 250, () => {
    const r = runSteps(frameOf(src), [
      { op: 'sort', by: 'value', dir: 'desc' }, { op: 'limit', n: 100 } as never,
    ], {})
    if (r.frame.n !== 100) throw new Error('top-100 did not produce 100 rows')
    return r
  })
  timed('FK join into a 5-row dimension plus a group-by', 250, () => {
    const dim = sheet('dim', [{ id: 'name', type: 'text' }, { id: 'team', type: 'text' }],
      { name: ['ana', 'bo', 'cy', 'dee', 'eve'], team: ['A', 'B', 'A', 'B', 'A'] })
    const doc = { ...DOC, sheets: [BIG, dim] } as DashDoc
    const r = runSteps(frameOf(src), [
      { op: 'join', with: 'dim', on: ['owner', 'name'], card: 'one', fields: ['team'] },
      { op: 'group', by: ['team'], agg: [{ fn: 'sum', of: 'value', as: 't' }] },
    ], { doc })
    if (!r.ok) throw new Error('the join pipeline did not run')
    return r
  })
}
{
  // and the join-fanout check must not cost the join: the detection is the same
  // hash pass the join already makes
  const dupes = sheet('dupes', [{ id: 'name', type: 'text' }, { id: 'team', type: 'text' }],
    { name: ['ana', 'ana'], team: ['A', 'B'] })
  const doc = { ...DOC, sheets: [BIG, dupes] } as DashDoc
  const t0 = performance.now()
  const r = runSteps(BIG, [{ op: 'join', with: 'dupes', on: ['owner', 'name'], card: 'one', fields: ['team'] }], { doc })
  const ms = performance.now() - t0
  ok(!r.ok && codes(r).includes('join-fanout') && ms < 250,
    `the fanout refusal fires on ${N} rows in ${ms.toFixed(1)} ms — detection is not a second pass`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
