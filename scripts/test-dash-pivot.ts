#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash pivot rig.
//
//   node scripts/test-dash-pivot.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. A pivot is the one surface in a spreadsheet where being
// wrong is invisible: the rows that made the number are not on screen, so there
// is nothing to check it against by eye. Every failure below prints a full,
// well-aligned table of plausible figures.
//
//   1. A GAP THAT READS AS A ZERO. "North sold nothing in Q3" is a claim about
//      the world; "we have no rows for North in Q3" is a claim about the data.
//      A pivot that prints 0 for both makes the second one into the first.
//   2. AN AVERAGE OVER THE WRONG DENOMINATOR. Dividing by rows instead of by
//      values present drags every average toward zero in exact proportion to
//      how patchy the column is — so the patchier the data, the more confident
//      and the more wrong the number.
//   3. TEXT SUMMED AS ZERO. `Number('n/a') || 0`. The sum is short by an unknown
//      amount and nothing on screen says which rows did it.
//   4. SUBTOTALS ADDED UP FROM THE CELLS ABOVE THEM. Right for sum, wrong for
//      average, median and distinct-count — and the wrongness is small enough
//      to look like rounding.
//   5. ALPHABETICAL CATEGORIES. A fiscal year that starts in April sorts to
//      Apr, Aug, Dec and the trend line becomes noise.
//   6. A DRILL-DOWN THAT DOES NOT MATCH ITS CELL. The one feature here that
//      Excel cannot do honestly, and useless the moment it can disagree with
//      the number it is explaining.
//   7. THE DICTIONARY PATH DISAGREEING WITH THE RAW PATH. The engine reads
//      dictionary-encoded columns through a different code path than raw ones
//      — that is the whole performance argument — so the two have to be proved
//      identical on identical data or the encoding silently changes answers.
//
// The load-bearing checks are the CROSS-CHECKS, not the literals: a grand total
// that equals the sum of its leaves, a subtotal that equals a re-aggregation of
// its own drill-down, `scanned` that equals the grand-total cell's row count.
// A literal can be updated to match a bug; those cannot.

import { registerHooks } from 'node:module'

// pivot.ts imports its stylesheet, which is Vite's job and not Node's — the
// same stub test-dash-panels.ts uses, for the same reason.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const {
  runPivot, drillDown, readPivotSpec, isPivotSheet, defaultPivot, newPivotSheet,
  valueName, label, mountPivot, _internals,
} = await import('../dash/src/pivot.ts')
type PivotSpec = import('../dash/src/pivot.ts').PivotSpec
type PivotResult = import('../dash/src/pivot.ts').PivotResult
type AggFn = import('../dash/src/pivot.ts').AggFn

const { parseDoc } = await import('../dash/src/model.ts')
type TableSheet = import('../dash/src/model.ts').TableSheet
type ColumnData = import('../dash/src/model.ts').ColumnData

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const near = (a: number | null, b: number, eps = 1e-9): boolean =>
  a !== null && Math.abs(a - b) < eps

// --------------------------------------------------------------- fixtures
//
// Twelve rows carrying, on purpose, every shape that breaks a naive pivot:
// a blank grouping value, a blank measure, a measure that is TEXT, a measure
// written as a numeric STRING, two spellings of one category, and two spellings
// of one customer. The category order is deliberately NOT alphabetical.

const REGION = ['North', 'North', 'North', 'south', 'South', 'South', 'East', 'East', 'North', '', 'East', 'East']
const QUARTER = ['Q1', 'Q1', 'Q2', 'Q1', 'Q1', 'Q2', 'Q1', 'Q1', 'Q2', 'Q3', 'Q3', 'Q3']
const AMOUNT: Array<string | number | null> = [10, 20, 30, 5, 'n/a', null, 100, 9, '40', 7, 1, 3]
const CUSTOMER = ['alpha', 'beta', 'alpha', 'gamma', 'delta', 'alpha', 'alpha', 'beta', 'alpha', 'epsilon', 'alpha', ' Alpha ']
const FLAG = [true, false, true, true, false, false, true, true, false, true, false, true]

/** Dictionary-encode a column the way import.ts would. */
function dict(vals: Array<string | number | null>): ColumnData {
  const d: string[] = []
  const idx: Array<number | null> = vals.map((v) => {
    if (v == null) return null
    const s = String(v)
    let k = d.indexOf(s)
    if (k < 0) { k = d.length; d.push(s) }
    return k
  })
  return { enc: 'dict', dict: d, idx }
}

const raw = (vals: unknown[]): ColumnData =>
  ({ enc: 'raw', v: vals as Array<number | string | boolean | null> })

function sheet(enc: 'dict' | 'raw'): TableSheet {
  const pick = (v: Array<string | number | null>): ColumnData => (enc === 'dict' ? dict(v) : raw(v))
  return {
    id: 'src', name: 'Sales', kind: 'table',
    rids: [[1, 12]],
    columns: [
      { id: 'region', name: 'Region', type: 'text' },
      { id: 'quarter', name: 'Quarter', type: 'text' },
      { id: 'amount', name: 'Amount', type: 'money', format: '$#,##0' },
      { id: 'customer', name: 'Customer', type: 'text' },
      { id: 'flag', name: 'Flag', type: 'bool' },
    ],
    data: {
      region: pick(REGION),
      quarter: pick(QUARTER),
      amount: pick(AMOUNT),
      customer: pick(CUSTOMER),
      // a bool column stays raw in both fixtures: dictionary-encoding booleans
      // is not something import.ts does, and pretending otherwise would test a
      // shape no file contains
      flag: raw(FLAG),
    },
    steps: [],
  }
}

const spec = (over: Partial<PivotSpec> = {}): PivotSpec => ({
  from: 'src', rows: ['region'], cols: [], values: [{ col: 'amount', fn: 'sum' }], ...over,
})

/** The one row whose kind and path match. */
const findRow = (res: PivotResult, kind: string, ...path: string[]) =>
  res.rows.find((r) => r.kind === kind && r.path.map((p) => String(p ?? '')).join('|') === path.join('|'))

const findCol = (res: PivotResult, kind: string, ...path: string[]) =>
  res.columns.findIndex((c) => c.kind === kind && c.path.map((p) => String(p ?? '')).join('|') === path.join('|'))

// ============================================================ grouping order

console.log('\ncategories come out in DATA order, not alphabetically')
{
  const res = runPivot(sheet('dict'), spec())
  const got = res.rows.filter((r) => r.kind === 'leaf').map((r) => String(r.path[0] ?? '(blank)'))
  ok(JSON.stringify(got) === JSON.stringify(['North', 'south', 'East', '(blank)']),
    `first-seen order is kept — got ${JSON.stringify(got)}, and the alphabetical answer would be East, North, south`)
  ok(got[1] === 'south',
    'the label is the FIRST-SEEN original: "south" appears before "South" in the data, and they are one group')
  ok(res.rows.filter((r) => r.kind === 'leaf').length === 4,
    '"south" and "South" merged into one group — the same canonical key the filter menu ticks by')
}

console.log('\na blank grouping value is its own group, and it is labelled')
{
  const res = runPivot(sheet('dict'), spec())
  const blank = res.rows.find((r) => r.kind === 'leaf' && r.path[0] === null)
  ok(!!blank, 'the row with no region is grouped under a blank, not dropped and not merged into another region')
  ok(label(blank!.path[0]) === '(blank)',
    'and it renders as "(blank)" — an unlabelled line in an outline reads as a rendering bug')
  ok(near(blank!.cells[0].v, 7), 'its 7 is in the table where a reader can see it')
}

// ============================================================ gap vs zero

console.log('\nan empty group and a zero never look the same')
{
  const res = runPivot(sheet('dict'), spec({ cols: ['quarter'] }))
  const q3 = findCol(res, 'leaf', 'Q3')
  const north = findRow(res, 'leaf', 'North')!
  const gap = north.cells[q3]
  ok(gap.v === null && gap.rows === 0,
    'North × Q3 has no rows at all: v is null and rows is 0 — a GAP, never a 0')

  // South × Q2 is the other half of the same distinction: the rows exist, the
  // measure is blank in all of them. That is a different fact and has to read
  // differently from both a gap and a zero.
  const q2 = findCol(res, 'leaf', 'Q2')
  const south = findRow(res, 'leaf', 'south')!
  const present = south.cells[q2]
  ok(present.rows === 1 && present.present === 0 && present.v === null,
    'south × Q2 HAS a row and no value: rows 1, present 0, sum null — distinguishable from the gap by `rows`')

  const counted = runPivot(sheet('dict'), spec({ cols: ['quarter'], values: [{ col: 'amount', fn: 'count' }] }))
  ok(counted.rows.find((r) => r.path[0] === 'south')!.cells[q2].v === 0,
    'the same cell COUNTED is 0, which is an answer — count is the one function whose zero is a fact')
  ok(counted.rows.find((r) => r.path[0] === 'North')!.cells[q3].v === null,
    'and the true gap still counts null, not 0 — otherwise count would erase the distinction the others keep')
}

// ============================================================ text and averages

console.log('\ntext in a numeric aggregation is counted, never coerced to 0')
{
  const res = runPivot(sheet('dict'), spec({ values: [{ col: 'amount', fn: 'sum' }, { col: 'amount', fn: 'avg' }, { col: 'amount', fn: 'count' }] }))
  const s = findRow(res, 'leaf', 'south')!
  // rows 3,4,5 hold 5, "n/a", (blank)
  ok(near(s.cells[0].v, 5),
    'sum of [5, "n/a", blank] is 5 — the naive `Number(v)||0` answer is also 5, so the shape below is what proves it')
  ok(s.cells[0].skipped === 1 && s.cells[0].present === 2 && s.cells[0].numeric === 1,
    'and the cell REPORTS it: 2 values present, 1 numeric, 1 skipped — model.ts\'s `failed` at the aggregate level')
  ok(near(s.cells[1].v, 5),
    'the average is 5 (5 ÷ 1 numeric), not 2.5 (5 ÷ 2 present) and not 1.67 (5 ÷ 3 rows)')
  ok(s.cells[2].v === 2,
    'count is 2 — non-blank values, which includes the text: it is present, it is just not a number')
}

console.log('\nmin and max of a group with no numbers are nothing, not zero')
{
  const res = runPivot(sheet('dict'), spec({
    rows: ['region'], cols: ['quarter'],
    values: [{ col: 'amount', fn: 'min' }, { col: 'amount', fn: 'max' }],
  }))
  const q2 = findCol(res, 'leaf', 'Q2')
  const south = findRow(res, 'leaf', 'south')!
  ok(south.cells[q2].v === null && south.cells[q2 + 1].v === null,
    'south × Q2 has a row whose amount is blank: min and max are null — `Math.min()` of an empty list is Infinity and `?? 0` is a zero nobody measured')
  ok(south.cells[q2].rows === 1,
    'and the row is still counted, so the cell is not a gap either')

  const q1 = findCol(res, 'leaf', 'Q1')
  ok(south.cells[q1].v === 5 && south.cells[q1 + 1].v === 5,
    'south × Q1 holds 5 and "n/a": both min and max are 5 — text has no magnitude, so it cannot be the smallest thing in the group')
}

console.log('\naverages divide by values PRESENT, as chart.ts already established')
{
  const res = runPivot(sheet('dict'), spec({ values: [{ col: 'amount', fn: 'avg' }] }))
  const grand = findRow(res, 'grand')!
  ok(near(grand.cells[0].v, 22.5),
    'grand average is 225 ÷ 10 numerics = 22.5 — dividing by the 12 rows would give 18.75')
  ok(grand.cells[0].numeric === 10 && grand.cells[0].rows === 12,
    'the divisor and the row count are both carried, and they differ')
}

// ============================================================ subtotals

console.log('\nsubtotals are COMPUTED from the rows, never summed from the cells')
{
  const res = runPivot(sheet('dict'), spec({
    values: [{ col: 'amount', fn: 'avg' }, { col: 'customer', fn: 'countDistinct' }, { col: 'amount', fn: 'median' }],
  }))
  const leaves = res.rows.filter((r) => r.kind === 'leaf')
  const grand = findRow(res, 'grand')!

  const meanOfMeans = leaves.reduce((a, r) => a + (r.cells[0].v ?? 0), 0) / leaves.length
  ok(!near(grand.cells[0].v, meanOfMeans),
    `an average of averages is a DIFFERENT number (${meanOfMeans.toFixed(4)} vs ${grand.cells[0].v}) — this check exists to make sure we are not computing it`)
  ok(near(grand.cells[0].v, 22.5), 'the grand average is the one over the source rows')

  const sumOfDistincts = leaves.reduce((a, r) => a + (r.cells[1].v ?? 0), 0)
  ok(grand.cells[1].v === 5 && sumOfDistincts === 8,
    `distinct customers overall is 5 while the per-region counts add to ${sumOfDistincts} — the same customer buys in two regions, and distincts do not add`)

  ok(near(grand.cells[2].v, 9.5),
    'the grand median is 9.5 over [1,3,5,7,9,10,20,30,40,100] — a median of medians would not be')
  const east = findRow(res, 'leaf', 'East')!
  ok(near(east.cells[2].v, 6),
    'East median over [1,3,9,100] is 6 — a LEXICAL sort would answer 51.5, which is the default Array.sort behaviour')
}

console.log('\nsubtotals appear after their children, grand total last')
{
  const res = runPivot(sheet('dict'), spec({ rows: ['region', 'quarter'] }))
  const shape = res.rows.map((r) => `${r.kind}:${r.path.map((p) => String(p ?? '_')).join('/')}`)
  ok(JSON.stringify(shape) === JSON.stringify([
    'leaf:North/Q1', 'leaf:North/Q2', 'subtotal:North',
    'leaf:south/Q1', 'leaf:south/Q2', 'subtotal:south',
    'leaf:East/Q1', 'leaf:East/Q3', 'subtotal:East',
    'leaf:_/Q3', 'subtotal:_',
    'grand:',
  ]), `outline order is children-then-subtotal, grand total last — got ${JSON.stringify(shape)}`)

  const sub = findRow(res, 'subtotal', 'North')!
  ok(near(sub.cells[0].v, 100) && sub.cells[0].rows === 4,
    'the North subtotal is 100 over its own 4 rows')
}

console.log('\nthe grand total equals the sum of the leaves — for sum, which is the one function where it must')
{
  const res = runPivot(sheet('dict'), spec({ rows: ['region', 'quarter'] }))
  const leaves = res.rows.filter((r) => r.kind === 'leaf')
  const total = leaves.reduce((a, r) => a + (r.cells[0].v ?? 0), 0)
  const grand = findRow(res, 'grand')!
  ok(near(grand.cells[0].v, total) && near(grand.cells[0].v, 225),
    `every leaf adds to ${total} and the grand total says ${grand.cells[0].v} — a reader who adds the column up by hand has to be right`)
  ok(grand.cells[0].rows === res.scanned,
    'and the grand total covers exactly the rows the footer claims were scanned')
}

console.log('\nrow and column totals cross-foot')
{
  const res = runPivot(sheet('dict'), spec({ rows: ['region'], cols: ['quarter'] }))
  const gi = findCol(res, 'grand')
  ok(gi >= 0, 'a column grand total exists when there are column fields')
  const grandRow = findRow(res, 'grand')!
  const leafCols = res.columns.map((c, i) => (c.kind === 'leaf' ? i : -1)).filter((i) => i >= 0)
  for (const r of res.rows) {
    const across = leafCols.reduce((a, i) => a + (r.cells[i].v ?? 0), 0)
    if (!near(r.cells[gi].v, across)) {
      ok(false, `row [${r.path}] adds across to ${across} but its total column says ${r.cells[gi].v}`)
      break
    }
  }
  ok(near(grandRow.cells[gi].v, 225), 'the corner cell is the grand total both ways')
  checks++; console.log('  ok    every row adds across to its own total column')
}

// ============================================================ no column fields

console.log('\nno column fields is a legitimate pivot, not a degenerate one')
{
  const res = runPivot(sheet('dict'), spec({ cols: [] }))
  ok(res.columns.length === 1 && res.columns[0].kind === 'leaf',
    'one column group, and it is a LEAF — emitting a grand total there too would print the same numbers twice')
  ok(res.header.length === 1 && res.header[0].length === 1,
    'the value name is still shown, or a reader cannot tell a sum from a count')
  ok(String(res.header[0][0].label).includes('Amount'), 'and it names the column it summarises')
}

console.log('\nno row fields either: one grand number, correctly')
{
  const res = runPivot(sheet('dict'), spec({ rows: [], cols: [] }))
  ok(res.rows.length === 1 && res.rows[0].kind === 'leaf', 'exactly one row, and no phantom grand total beside it')
  ok(near(res.rows[0].cells[0].v, 225), 'and it is the whole sheet')
}

// ============================================================ header shape

console.log('\nthe header spans the columns exactly')
{
  const res = runPivot(sheet('dict'), spec({
    rows: ['region'], cols: ['quarter'],
    values: [{ col: 'amount', fn: 'sum' }, { col: 'amount', fn: 'count' }],
  }))
  for (const hrow of res.header) {
    const span = hrow.reduce((a, h) => a + h.span, 0)
    if (span !== res.columns.length) {
      ok(false, `a header row spans ${span} of ${res.columns.length} columns — the table would shear`)
      break
    }
  }
  checks++; console.log(`  ok    every header row spans exactly ${res.columns.length} columns`)
  ok(res.header.length === 2, 'one row per column field plus a value row, because there are two values')
  const top = res.header[0]
  ok(top.filter((h) => h.total).length === 1 && top[top.length - 1].total,
    'the grand-total caption is one cell, at the end, and it is marked as a total rather than as a category')
  ok(top[0].span === 2, 'Q1 spans its two value columns')

  // The span sum alone cannot catch a MERGE — merging two header cells keeps
  // the total. So walk the covered columns and prove every one of them really
  // does belong under the caption above it.
  let bad = ''
  res.header.forEach((hrow, l) => {
    let at = 0
    for (const h of hrow) {
      const under = res.columns.slice(at, at + h.span)
      at += h.span
      if (l >= res.colFields.length) return // the value row spans one each
      const keys = new Set(under.map((c) => (l >= c.codes.length
        ? `T${c.kind}`
        : c.codes.slice(0, l + 1).join(','))))
      if (keys.size > 1) bad ||= `"${String(h.label)}" at level ${l} spans ${keys.size} different groups`
    }
  })
  ok(bad === '', bad || 'and every header cell covers exactly the columns that belong to it — a merged caption keeps the span sum right and lies about the table')
}

// ============================================================ blanks policy

console.log('\nexcluding blanks excludes the ROW, so the totals still foot')
{
  const kept = runPivot(sheet('dict'), spec({ rows: ['region'] }))
  const dropped = runPivot(sheet('dict'), spec({ rows: ['region'], blanks: false }))
  ok(near(kept.rows.find((r) => r.kind === 'grand')!.cells[0].v, 225), 'with blanks, the grand total is 225')
  ok(dropped.rows.filter((r) => r.kind === 'leaf').length === 3,
    'without blanks the "(blank)" group is gone')
  const grand = dropped.rows.find((r) => r.kind === 'grand')!
  ok(near(grand.cells[0].v, 218),
    'and its 7 left the GRAND TOTAL too (225 → 218) — hiding the group while still totalling its rows is the failure this guards')
  const leaves = dropped.rows.filter((r) => r.kind === 'leaf')
    .reduce((a, r) => a + (r.cells[0].v ?? 0), 0)
  ok(near(grand.cells[0].v, leaves), 'the visible leaves still add to the grand total')
  ok(dropped.scanned === 11 && grand.cells[0].rows === 11,
    '`scanned` reports the rows that reached an accumulator (11), not the 12 the filters admitted — the footer must not disagree with the total above it')
}

// ============================================================ dict vs raw

console.log('\nthe dictionary path and the raw path answer identically')
{
  // `codes` are deliberately NOT compared: they are opaque handles into the
  // encoding — dictionary indices on one side, intern positions on the other —
  // and requiring them to match would be requiring the fast path not to be a
  // fast path. Everything a reader can see is compared.
  const drop = (o: unknown): unknown => {
    if (Array.isArray(o)) return o.map(drop)
    if (o && typeof o === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(o)) if (k !== 'codes') out[k] = drop(v)
      return out
    }
    return o
  }
  const strip = (r: PivotResult) => JSON.stringify(drop({
    rows: r.rows, columns: r.columns, header: r.header, scanned: r.scanned, findings: r.findings,
  }))
  for (const s of [
    spec({ rows: ['region'], cols: ['quarter'] }),
    spec({ rows: ['region', 'quarter'], values: [{ col: 'amount', fn: 'avg' }, { col: 'customer', fn: 'countDistinct' }, { col: 'amount', fn: 'median' }] }),
    spec({ rows: ['customer'], values: [{ col: 'amount', fn: 'max' }, { col: 'amount', fn: 'min' }] }),
    spec({ rows: ['region'], blanks: false }),
  ]) {
    const a = strip(runPivot(sheet('dict'), s))
    const b = strip(runPivot(sheet('raw'), s))
    if (a !== b) {
      ok(false, `encoding changed the answer for ${JSON.stringify(s.rows)}×${JSON.stringify(s.cols)} — the dictionary fast path has drifted from the general one`)
      break
    }
  }
  checks++
  console.log('  ok    four specs give byte-identical results under dict and raw encoding')
}

// ============================================================ drill-down

console.log('\na drill-down reproduces the number it explains')
{
  const s = sheet('dict')
  const res = runPivot(s, spec({
    rows: ['region', 'quarter'], cols: ['quarter'],
    values: [{ col: 'amount', fn: 'sum' }, { col: 'amount', fn: 'count' }],
  }))
  const amounts = AMOUNT.map((v) => _internals.asNumber(v))
  let worst = ''
  for (let ri = 0; ri < res.rows.length && !worst; ri++) {
    for (let ci = 0; ci < res.columns.length; ci++) {
      const cell = res.rows[ri].cells[ci]
      const d = drillDown(res, ri, ci)
      if (d.total !== cell.rows) {
        worst = `[${res.rows[ri].path}]×[${res.columns[ci].path}] cell claims ${cell.rows} rows, the drill-down finds ${d.total}`
        break
      }
      if (res.columns[ci].value.fn !== 'sum') continue
      const nums = d.rows.map((r) => amounts[r]).filter((n): n is number => n !== null)
      const re = nums.length ? nums.reduce((a, b) => a + b, 0) : null
      if (!(re === null ? cell.v === null : near(cell.v, re))) {
        worst = `[${res.rows[ri].path}]×[${res.columns[ci].path}] shows ${cell.v}, its own rows add to ${re}`
        break
      }
    }
  }
  ok(worst === '', worst || 'every cell in a 12×8 pivot — leaf, subtotal and grand alike — re-aggregates from its own drill-down')

  const north = res.rows.findIndex((r) => r.kind === 'subtotal' && r.path[0] === 'North')
  const gi = findCol(res, 'grand')
  ok(JSON.stringify(drillDown(res, north, gi).rows) === JSON.stringify([0, 1, 2, 8]),
    'the North subtotal drills to source rows 0,1,2,8 — indices into the LIVE sheet, not a copied snapshot the way Excel does it')

  const gapRow = res.rows.findIndex((r) => r.kind === 'leaf' && r.path[0] === 'North' && r.path[1] === 'Q1')
  const q3 = findCol(res, 'leaf', 'Q3')
  ok(drillDown(res, gapRow, q3).total === 0,
    'a gap drills to nothing rather than to the whole sheet — an unpinned code would match everything')

  const capped = drillDown(res, res.rows.length - 1, gi, 3)
  ok(capped.rows.length === 3 && capped.total === 12 && capped.truncated,
    'the cap TRUNCATES and says so, rather than quietly showing the first three of twelve')
}

console.log('\na drill-down honours the pivot\'s own filters')
{
  const s = sheet('dict')
  const res = runPivot(s, spec({
    rows: ['region'], filters: [{ col: 'quarter', pred: { op: 'equals', v: 'Q1' } }],
  }))
  ok(res.scanned === 6, 'six rows are in Q1')
  ok(near(res.rows.find((r) => r.kind === 'grand')!.cells[0].v, 144),
    'and they total 10+20+5+100+9 = 144 — "n/a" is not among them, and not a zero either')
  const north = res.rows.findIndex((r) => r.kind === 'leaf' && r.path[0] === 'North')
  ok(JSON.stringify(drillDown(res, north, 0).rows) === JSON.stringify([0, 1]),
    'the drill-down shows only filtered rows — offering row 2 (a Q2 row) would be offering evidence for a number it is not part of')
}

console.log('\nthe reader\'s row set is opt-in, never the default')
{
  const s = sheet('dict')
  const all = runPivot(s, spec())
  const some = runPivot(s, spec(), { rows: [0, 1, 2] })
  ok(all.scanned === 12, 'by default a pivot is over the whole sheet — it is a document, and a document does not change shape per reader')
  ok(some.scanned === 3 && near(some.rows[0].cells[0].v, 60),
    'and `opts.rows` narrows it when the caller explicitly asks')
}

// ============================================================ aggregations

console.log('\nthe aggregations themselves')
{
  const fns: AggFn[] = ['sum', 'avg', 'count', 'min', 'max', 'median', 'countDistinct']
  const res = runPivot(sheet('dict'), spec({ rows: [], values: fns.map((fn) => ({ col: 'amount', fn })) }))
  const c = res.rows[0].cells
  const want: Array<[AggFn, number]> = [
    ['sum', 225], ['avg', 22.5], ['count', 11], ['min', 1], ['max', 100], ['median', 9.5], ['countDistinct', 11],
  ]
  want.forEach(([fn, v], i) => {
    ok(near(c[i].v, v), `${fn} over the whole sheet is ${v} (got ${c[i].v})`)
  })
  ok(c[2].v === 11 && c[0].numeric === 10,
    'count is 11 and the numeric divisor is 10 — the "n/a" is present but not a number, and only one of those two numbers is allowed to include it')
  ok(c[6].v === 11,
    'distinct counts the "n/a" as a value: it is a distinct thing that was recorded, which is a different question from what it sums to')
}

console.log('\nnumbers written as text group and total as numbers')
{
  const res = runPivot(sheet('dict'), spec({ rows: ['region'] }))
  const north = findRow(res, 'leaf', 'North')!
  ok(near(north.cells[0].v, 100),
    'North includes the row whose amount is the STRING "40" — 10+20+30+40')
  ok(_internals.asNumber('40') === 40 && _internals.asNumber('1,234') === 1234,
    'the strict numeric shape reads "40" and "1,234"')
  ok(_internals.asNumber('') === null && _internals.asNumber('  ') === null,
    'and refuses the empty string, which is how `Number(v)` turns a blank into a zero')
  ok(_internals.asNumber('50%') === null && _internals.asNumber('2026-01-15') === null,
    'and refuses a percent (a percent column stores the fraction) and an ISO date (which must stay text to sort chronologically)')
  ok(_internals.asNumber(true) === 1 && _internals.asNumber(false) === 0,
    'booleans DO read as 1/0 — the one deliberate divergence from filter.ts, because "how many are flagged" is what a bool column is for')
}

console.log('\nsumming a bool column answers the question it is asked')
{
  const res = runPivot(sheet('dict'), spec({ rows: [], values: [{ col: 'flag', fn: 'sum' }, { col: 'flag', fn: 'count' }] }))
  ok(near(res.rows[0].cells[0].v, 7), '7 of the 12 rows are flagged')
  ok(res.rows[0].cells[1].v === 12,
    'and `false` counts as present — a checkbox that is off is an answer, not a blank')
}

console.log('\ncountDistinct canonicalises the way the filter menu does')
{
  const res = runPivot(sheet('dict'), spec({ rows: [], values: [{ col: 'customer', fn: 'countDistinct' }] }))
  ok(res.rows[0].cells[0].v === 5,
    'alpha / " Alpha " are one customer, so the answer is 5 — a set keyed on the raw string would say 6')
  ok(_internals.matchKey(10) === _internals.matchKey('10') && _internals.matchKey('North') === _internals.matchKey(' north '),
    'the key is filter.ts\'s: a box the reader ticks in the filter menu selects the same rows the pivot grouped')
}

// ============================================================ findings

console.log('\na field naming a column that is gone is reported, never silently grouped')
{
  const res = runPivot(sheet('dict'), spec({ rows: ['region', 'ghost'] }))
  ok(res.rowFields.length === 1 && res.rowFields[0] === 'region', 'the dead field is dropped')
  ok(res.findings.some((f) => f.kind === 'missing-column' && f.detail.includes('ghost')),
    'and reported — grouping the whole sheet under one "(blank)" would look like a pivot of nothing')
  ok(res.rows.filter((r) => r.kind === 'leaf').length === 4,
    'the surviving field still groups normally')
}

console.log('\nan aggregation this build does not know refuses rather than inventing a number')
{
  const res = runPivot(sheet('dict'), spec({ values: [{ col: 'amount', fn: 'mode' as AggFn }] }))
  ok(res.values.length === 0 && res.columns.length === 0, 'no column is produced for it')
  ok(res.findings.some((f) => f.kind === 'unknown-agg'),
    'and the reader is told — model.ts:174\'s rule: unresolved shows no number, never a zero')
  const back = readPivotSpec({ pivot: spec({ values: [{ col: 'amount', fn: 'mode' as AggFn }] }) })
  ok(back!.values[0].fn === 'mode',
    'while the spec still ROUND-TRIPS it, so a build that knows "mode" gets its pivot back (PLATFORM §3)')
}

console.log('\na packed column is refused rather than pivoted as one blank group')
{
  const s = sheet('dict')
  s.data.region = { enc: 'pack', b64: 'AAAA', n: 12 }
  let threw = ''
  try { runPivot(s, spec()) } catch (e) { threw = e instanceof Error ? e.message : String(e) }
  ok(threw.includes('packed'),
    'readCell answers null for every row of a packed column, so pivoting one would silently produce ONE group holding the whole sheet')
}

// ============================================================ the spec

console.log('\nreading a spec out of a file is defensive')
{
  ok(readPivotSpec(null) === null && readPivotSpec({}) === null && readPivotSpec({ pivot: 7 }) === null,
    'garbage is not a pivot')
  ok(readPivotSpec({ pivot: { rows: ['a'] } }) === null,
    'and neither is a spec with no source sheet — everything else is optional')
  const p = readPivotSpec({ pivot: { from: 'src', rows: ['a', 3, null], values: 'nope' } })!
  ok(JSON.stringify(p.rows) === '["a"]' && JSON.stringify(p.values) === '[]',
    'a hand-edited field list keeps what is readable and drops what is not, rather than throwing on open')
  const keep = readPivotSpec({ pivot: { from: 'src', rows: [], cols: [], values: [], future: 42 } })!
  ok(keep.future === 42, 'unknown spec fields survive the read — the format is additive forever (PLATFORM §3)')
}

console.log('\na pivot sheet survives today\'s parseDoc, which rewrites its kind')
{
  const doc = {
    format: 'bento/dash', version: 1, docId: 'd', title: 'w',
    sheets: [
      { id: 'src', name: 'Sales', kind: 'table', rids: [[1, 1]], columns: [], data: {}, steps: [] },
      newPivotSheet('pv', 'By region', spec()),
    ],
  }
  const r = parseDoc(JSON.stringify(doc))
  ok(r.ok, 'the workbook parses')
  if (r.ok) {
    const pv = r.doc.sheets[1] as unknown as Record<string, unknown>
    ok(pv.kind === 'pivot',
      'parseDoc PRESERVES the pivot kind — the additivity hook landed, so this check has flipped from asserting the coercion to asserting its absence')
    ok(isPivotSheet(pv),
      'and the pivot is still found, because detection keys off the surviving `pivot` field rather than off `kind`')
    ok(readPivotSpec(pv)!.rows[0] === 'region', 'with its fields intact')
  }
}

console.log('\ndefaultPivot refuses what it cannot summarise')
{
  ok(defaultPivot(sheet('dict'))!.rows[0] === 'region', 'the first category column becomes the rows')
  ok(defaultPivot(sheet('dict'))!.cols[0] === 'quarter', 'the second becomes the columns')
  ok(defaultPivot(sheet('dict'))!.values[0].col === 'amount', 'and the first magnitude column is summed')

  // A near-unique text column makes one group per row: the source table with
  // extra lines and a worse layout.
  const wide = sheet('dict')
  wide.columns = wide.columns.filter((c) => c.id === 'customer' || c.id === 'amount')
  wide.data.customer = dict(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'])
  ok(defaultPivot(wide) === null,
    'a column with one distinct value per row is refused as a default grouping — one group per row is the source table with extra lines')
  wide.data.customer = dict(['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b', 'a', 'b', 'a', 'b'])
  ok(defaultPivot(wide)?.rows[0] === 'customer',
    'and the SAME column with two distinct values is accepted, so the refusal is about cardinality and not about the column')

  const nonums = sheet('dict')
  nonums.columns = nonums.columns.filter((c) => c.type === 'text')
  ok(defaultPivot(nonums) === null, 'and a sheet with nothing to measure gets no default pivot at all')
}

console.log('\nvalue captions are generated, so renaming a column renames the header')
{
  const nameOf = (id: string) => (id === 'amount' ? 'Revenue' : id)
  ok(valueName({ col: 'amount', fn: 'sum' }, nameOf) === 'Sum of Revenue', 'generated from the live column name')
  ok(valueName({ col: 'amount', fn: 'sum', as: 'Take' }, nameOf) === 'Take', 'unless the author named it')
}

// ============================================================ purity

console.log('\nrunning a pivot changes nothing')
{
  const s = sheet('dict')
  const before = JSON.stringify(s)
  const res = runPivot(s, spec({ rows: ['region', 'quarter'], cols: ['quarter'], values: [{ col: 'amount', fn: 'median' }] }))
  drillDown(res, 0, 0)
  ok(JSON.stringify(s) === before,
    'the source sheet is untouched — the numbers are DERIVED, and nothing here can write one into the document (chart.ts\'s rule)')

  const again = runPivot(sheet('dict'), spec({ rows: ['region', 'quarter'] }))
  const once = runPivot(sheet('dict'), spec({ rows: ['region', 'quarter'] }))
  ok(JSON.stringify(again.rows) === JSON.stringify(once.rows),
    'and two runs agree, so a repaint cannot change a number')
}

console.log('\na gap cell cannot be decorated into every other gap')
{
  const res = runPivot(sheet('dict'), spec({ rows: ['region'], cols: ['quarter'] }))
  const gap = res.rows.find((r) => r.path[0] === 'North')!.cells[findCol(res, 'leaf', 'Q3')]
  let threw = false
  try { (gap as { v: number | null }).v = 0 } catch { threw = true }
  ok(threw || gap.v === null,
    'the shared empty cell is frozen — it is returned by reference for every gap in the table')
}

// ============================================================ the renderer
//
// Not a layout test — a chevron that points the wrong way is a thing you can
// see. What is NOT visible is whether a GAP is clickable: a cell with no rows
// behind it that opens a drill-down showing every row in the sheet is the
// failure mode this whole file exists to refuse, and it looks like a working
// feature. Twelve lines of DOM is enough to ask.

console.log('\nthe renderer draws, and a gap is not clickable')
{
  interface Node { tag: string; cls: string; text: string; kids: Node[]; attrs: Record<string, unknown>; listeners: string[] }
  const mk = (tag: string): Node => {
    const n: Node = { tag, cls: '', text: '', kids: [], attrs: {}, listeners: [] }
    return new Proxy(n, {
      get(o, k) {
        if (k === 'className') return o.cls
        if (k === 'textContent') return o.text
        if (k === 'append') return (...xs: Node[]) => { for (const x of xs) { o.kids.push(x); o.text += x.text } }
        if (k === 'classList') return { add: (c: string) => { o.cls += ` ${c}` }, contains: (c: string) => o.cls.includes(c) }
        if (k === 'addEventListener') return (ev: string) => o.listeners.push(ev)
        if (k === 'scrollIntoView') return () => {}
        if (k in o) return (o as unknown as Record<string, unknown>)[k as string]
        return o.attrs[k as string]
      },
      set(o, k, v) {
        if (k === 'className') o.cls = String(v)
        else if (k === 'textContent') { o.text = String(v); if (v === '') o.kids.length = 0 }
        else o.attrs[k as string] = v
        return true
      },
    }) as unknown as Node
  }
  ;(globalThis as unknown as { document: unknown }).document = { createElement: (tag: string) => mk(tag) }

  const s = sheet('dict')
  const res = runPivot(s, spec({ rows: ['region'], cols: ['quarter'] }))
  const host = mk('div')
  let down: (() => void) | null = null
  let threw = ''
  try { down = mountPivot(host as unknown as HTMLElement, res, { sheet: s }) } catch (e) {
    threw = e instanceof Error ? e.message : String(e)
  }
  ok(threw === '', threw || 'mountPivot renders a two-axis pivot without throwing')

  const all: Node[] = []
  const walk = (n: Node) => { all.push(n); for (const k of n.kids) walk(k) }
  walk(host)
  // by TOKEN, not by substring: 'dxp-corner' contains 'dxp-c', and a matcher
  // that counted the corner would have made the two counts below agree for the
  // wrong reason
  const has = (n: Node, c: string) => n.cls.trim().split(/\s+/).includes(c)
  const cells = all.filter((n) => has(n, 'dxp-c'))
  ok(cells.length === res.rows.length * res.columns.length,
    `every cell reaches the DOM (${cells.length} of ${res.rows.length * res.columns.length})`)
  const gaps = cells.filter((n) => has(n, 'dxp-gap'))
  ok(gaps.length > 0, 'the fixture has gaps to check')
  ok(gaps.every((n) => n.listeners.length === 0 && n.attrs.tabIndex === undefined),
    'and NONE of them is clickable or focusable — a gap has nothing to drill into, and offering the whole sheet instead would be the worst possible answer')
  ok(cells.filter((n) => !has(n, 'dxp-gap')).every((n) => n.listeners.includes('click')),
    'every cell that does have rows behind it opens them')
  ok(all.some((n) => has(n, 'dxp-skipped')),
    'the cell holding "n/a" is marked, so a short sum says so on screen')
  down?.()
  ok(host.text === '', 'the teardown empties the host, as renderChart\'s does')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
