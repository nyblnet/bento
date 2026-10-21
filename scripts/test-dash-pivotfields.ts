#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash pivot field editor rig — the spec operations behind the editor,
// and the pivot COMPUTED over configured fields.
//
//   node scripts/test-dash-pivotfields.ts
//
// WHAT THIS PROVES. The field editor (dash/src/pivotfields.ts) turns drags and
// picks into a new PivotSpec; runPivot turns the spec into numbers. Both halves
// fail silently: a drag that leaves Region in Rows AND Columns draws a diagonal
// of one-cell groups that look like data, and a filter stored in the wrong
// spelling reopens matching nothing — a pivot of zero rows, which reads as "no
// sales" rather than as a broken file.
//
//   1. Every operation returns a NEW spec and never touches its input (the input
//      is the spec inside store.doc; mutating it is a change undo never saw).
//   2. A grouping field is in ONE of Filters / Columns / Rows; Values may repeat
//      a column but never the same column and function.
//   3. Configured pivots compute what a hand count says: sum, average, count,
//      min, max and DISTINCT, per group and in the grand total.
//   4. The pivot's own filters, in the JSON spelling the editor writes, survive
//      the file (JSON round trip + parseDoc) and still filter: the checklist,
//      "(All)", a "(Blanks)" box, and a filter on a column that is gone.
//
// The old engine read `spec.filters` as live filter.ts filters, so the stored
// `values` array arrived where a `Set` was expected — section 4 is the check that
// goes red on it.

import { registerHooks } from 'node:module'

registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { runPivot, drillDown, readPivotSpec, newPivotSheet } = await import('../dash/src/pivot.ts')
const F = await import('../dash/src/pivotfields.ts')
const { parseDoc } = await import('../dash/src/model.ts')
const { listLabel } = await import('../dash/src/format.ts')
type PivotSpec = import('../dash/src/pivot.ts').PivotSpec
type PivotResult = import('../dash/src/pivot.ts').PivotResult
type TableSheet = import('../dash/src/model.ts').TableSheet

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

// The starter workbook's Pipeline, plus one blank Region so "(Blanks)" exists.
const REGION = ['North', 'South', 'North', 'East', 'South', 'North', 'East', 'South', null]
const OWNER = ['Priya', 'Sam', 'Priya', 'Lee', 'Sam', 'Lee', 'Priya', 'Sam', 'Lee']
const STAGE = ['Won', 'Open', 'Won', 'Open', 'Lost', 'Won', 'Open', 'Won', 'Open']
const VALUE = [12400, 8200, 15600, 4300, 9100, 22750, 6400, 18300, 1000]

const source = (): TableSheet => ({
  id: 'src', name: 'Pipeline', kind: 'table',
  rids: [[1, 9]],
  columns: [
    { id: 'region', name: 'Region', type: 'text' },
    { id: 'owner', name: 'Owner', type: 'text' },
    { id: 'stage', name: 'Stage', type: 'text' },
    { id: 'value', name: 'Value', type: 'money', format: '£#,##0' },
  ],
  data: {
    region: { enc: 'raw', v: REGION },
    owner: { enc: 'raw', v: OWNER },
    stage: { enc: 'raw', v: STAGE },
    value: { enc: 'raw', v: VALUE },
  },
  steps: [],
} as unknown as TableSheet)

const base = (over: Partial<PivotSpec> = {}): PivotSpec => ({
  from: 'src', rows: ['region'], cols: [], values: [{ col: 'value', fn: 'sum' }], ...over,
})

const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v) }
  return o
}

const row = (res: PivotResult, kind: string, label?: string) =>
  res.rows.find((r) => r.kind === kind && (label === undefined || String(r.path[0] ?? '') === label))
const cell = (res: PivotResult, kind: string, label: string | undefined, vi: number) =>
  row(res, kind, label)?.cells[vi]?.v ?? null

const money = { type: 'money' as const }
const text = { type: 'text' as const }

// ================================================================ 1 + 2
console.log('\nthe operations: new specs, inputs untouched')
{
  const s0 = deepFreeze(base())
  let threw = ''
  let s1: PivotSpec = s0
  try {
    s1 = F.addField(s0, 'stage', 'cols')
    s1 = F.addField(s1, 'owner', 'values', { column: text })
    s1 = F.setAgg(s1, 1, 'countDistinct')
    s1 = F.setFilterValues(s1, 'region', ['North'])
    s1 = F.moveField(s1, { area: 'cols', index: 0 }, { area: 'rows', index: 0 })
    s1 = F.removeField(s1, 'values', 0)
    s1 = F.toggleField(s1, 'value', money)
  } catch (e) { threw = e instanceof Error ? e.message : String(e) }
  ok(threw === '', threw || 'seven operations run against a deep-frozen spec without writing to it')
  ok(JSON.stringify(s0) === JSON.stringify(base()), 'and the frozen input is exactly as it was')
  ok(s1 !== s0, 'each edit hands back a new object')
}

console.log('\na grouping field is in one place')
{
  let s = F.addField(base(), 'region', 'cols')
  ok(s.rows.length === 0 && s.cols[0] === 'region', 'Region dragged from Rows to Columns MOVES — it is not in both')
  s = F.addField(s, 'region', 'filters')
  ok(s.cols.length === 0 && F.filterCols(s)[0] === 'region', 'and from Columns to Filters, likewise')
  s = F.setFilterValues(s, 'region', ['North'])
  s = F.addField(s, 'region', 'rows')
  ok(!s.filters && s.rows[0] === 'region',
    'a filtered field dragged into Rows leaves Filters and drops its checklist — the author is asking to see every region now')
  const two = F.addField(F.addField(base({ rows: [] }), 'region', 'rows'), 'stage', 'rows', { at: 0 })
  ok(JSON.stringify(two.rows) === '["stage","region"]', 'a field dropped at position 0 goes FIRST — outermost grouping')
  const re = F.addField(two, 'stage', 'rows', { at: 2 })
  ok(JSON.stringify(re.rows) === '["region","stage"]',
    'reordering within an area: dropping the first field after the last moves it to the end, not one past it')
}

console.log('\nvalues may repeat a column, never a column AND function')
{
  let s = F.addField(base(), 'value', 'values', { fn: 'avg' })
  ok(s.values.length === 2 && s.values[1].fn === 'avg', 'Sum AND Average of Value side by side is allowed')
  const same = F.addField(s, 'value', 'values', { fn: 'sum' })
  ok(same === s, 'a second Sum of Value is refused — the spec comes back unchanged')
  ok(F.setAgg(s, 1, 'sum') === s, 'and switching the Average to Sum is refused for the same reason')
  s = F.addField(s, 'region', 'values', { column: text })
  ok(s.values[2].fn === 'count', 'a TEXT field dropped into Values is counted, never summed')
  ok(F.addField(base({ values: [] }), 'value', 'values', { column: money }).values[0].fn === 'sum',
    'a measure dropped into Values is summed')
  const r = F.addField(base(), 'region', 'values', { column: text })
  ok(r.rows[0] === 'region' && r.values.some((v) => v.col === 'region'),
    'a field can be a row AND a value — "Count of Region by Region" is a fair question')
  const moved = F.moveField(F.addField(base(), 'value', 'values', { fn: 'max' }), { area: 'values', index: 1 }, { area: 'values', index: 0 })
  ok(moved.values[0].fn === 'max' && moved.values[1].fn === 'sum', 'a value dragged to the top keeps its function')
  const toRows = F.moveField(base(), { area: 'values', index: 0 }, { area: 'rows', index: 1 }, money)
  ok(toRows.values.length === 0 && toRows.rows[1] === 'value', 'a value dragged into Rows stops being a value')
}

console.log('\nthe field-list tick')
{
  const s = F.toggleField(base({ rows: [], values: [] }), 'stage', text)
  ok(s.rows[0] === 'stage', 'ticking a text field puts it in Rows')
  const t2 = F.toggleField(s, 'value', money)
  ok(t2.values[0]?.col === 'value' && t2.values[0].fn === 'sum', 'ticking a money field sums it in Values')
  const off = F.toggleField(F.addField(t2, 'value', 'values', { fn: 'avg' }), 'value', money)
  ok(off.values.length === 0, 'unticking takes the field out of EVERY area it is in')
}

console.log('\nthe Filters area stores the JSON spelling')
{
  const s = F.setFilterValues(base(), 'stage', ['Won', 'Open'])
  const f = s.filters![0] as { col: string; pred: { op: string; values?: unknown[]; set?: unknown } }
  ok(f.pred.op === 'isOneOf' && Array.isArray(f.pred.values) && f.pred.set === undefined,
    'a checklist is stored as `values`, an ARRAY — a Set would serialize as {} and match nothing')
  const all = F.setFilterValues(s, 'stage', null)
  ok(all.filters![0].col === 'stage' && all.filters![0].pred === undefined,
    '"(All)" keeps the field in the area with NO predicate rather than a list of today\'s values')
  ok(F.removeField(all, 'filters', 0).filters === undefined,
    'removing the last filter field drops `filters` entirely — the file goes back to what it was')
}

// ================================================================ 3
console.log('\nconfigured fields compute what a hand count says')
{
  const spec = base({
    rows: ['stage'],
    values: [
      { col: 'value', fn: 'sum' }, { col: 'value', fn: 'avg' }, { col: 'owner', fn: 'countDistinct' },
      { col: 'value', fn: 'min' }, { col: 'value', fn: 'max' }, { col: 'region', fn: 'count' },
    ],
  })
  const res = runPivot(source(), spec)
  ok(res.findings.length === 0, `no findings (${res.findings.map((f) => f.detail).join('; ')})`)
  ok(cell(res, 'leaf', 'Won', 0) === 69050, `Sum of Value, Won = 12400+15600+22750+18300 = 69,050 (${cell(res, 'leaf', 'Won', 0)})`)
  ok(cell(res, 'leaf', 'Open', 0) === 19900, `Sum of Value, Open = 8200+4300+6400+1000 = 19,900 (${cell(res, 'leaf', 'Open', 0)})`)
  ok(cell(res, 'leaf', 'Won', 1) === 17262.5, 'Average of Value, Won = 69050 / 4 = 17,262.5')
  ok(cell(res, 'leaf', 'Won', 2) === 3, 'Distinct Owner, Won = {Priya, Lee, Sam} = 3, not the 4 rows')
  ok(cell(res, 'leaf', 'Open', 2) === 3, 'Distinct Owner, Open = {Sam, Lee, Priya} = 3 (Lee twice)')
  ok(cell(res, 'grand', undefined, 2) === 3,
    'Distinct Owner in the GRAND total = 3 — computed from rows, not the 3+3+1 = 7 a summed subtotal would print')
  ok(cell(res, 'leaf', 'Won', 3) === 12400 && cell(res, 'leaf', 'Won', 4) === 22750, 'Min and Max of Value, Won = 12,400 and 22,750')
  ok(cell(res, 'leaf', 'Open', 5) === 3, 'Count of Region, Open = 3 — the blank region is not a value, so it is not counted')
  ok(cell(res, 'grand', undefined, 0) === VALUE.reduce((a, b) => a + b, 0), 'the grand Sum equals the column total, 98,050')
  ok(cell(res, 'grand', undefined, 1) === 98050 / 9, 'and the grand Average divides by the nine values present')

  const two = runPivot(source(), base({ rows: ['region'], cols: ['stage'], values: [{ col: 'value', fn: 'sum' }] }))
  const ci = two.columns.findIndex((c) => c.kind === 'leaf' && c.path[0] === 'Won')
  ok(row(two, 'leaf', 'North')!.cells[ci].v === 50750, 'Region × Stage: North, Won = 12400+15600+22750 = 50,750')
  const drill = drillDown(two, two.rows.findIndex((r) => r.kind === 'leaf' && r.path[0] === 'North'), ci)
  ok(drill.total === 3 && drill.rows.reduce((a, r) => a + VALUE[r], 0) === 50750,
    'and its drill-down is the three rows that make it')
}

// ================================================================ 4
console.log('\nthe pivot\'s own filters, as the editor writes them, through the file')
{
  // Through the EDITOR's operation and a real JSON round trip — the spelling on
  // disk is what has to work, not an in-memory Set.
  const edited = F.setFilterValues(base({ rows: ['stage'] }), 'region', ['North', 'South'])
  const doc = {
    format: 'bento/dash', version: 1, docId: 'd', title: 'w',
    sheets: [source(), newPivotSheet('pv', 'By stage', edited)],
  }
  const parsed = parseDoc(JSON.stringify(doc))
  ok(parsed.ok, 'the workbook with a filtered pivot parses')
  const spec = parsed.ok ? readPivotSpec(parsed.doc.sheets[1])! : edited
  const f0 = spec.filters?.[0] as { pred?: { values?: unknown[] } } | undefined
  ok(JSON.stringify(f0?.pred?.values) === '["North","South"]', 'the checklist comes back as the two regions it was')

  let res: PivotResult | null = null
  let threw = ''
  try { res = runPivot(source(), spec) } catch (e) { threw = e instanceof Error ? e.message : String(e) }
  ok(threw === '', threw ? `runPivot threw on a stored filter: ${threw}` : 'runPivot reads the stored filter without throwing')
  if (res) {
    ok(res.scanned === 6, `six rows are North or South (${res.scanned})`)
    ok(cell(res, 'leaf', 'Won', 0) === 69050 && cell(res, 'leaf', 'Open', 0) === 8200 && cell(res, 'leaf', 'Lost', 0) === 9100,
      `Won 69,050 · Open 8,200 · Lost 9,100 — East's two Open deals are out (${cell(res, 'leaf', 'Open', 0)})`)
    ok(cell(res, 'grand', undefined, 0) === 86350, `the grand total is 86,350 (${cell(res, 'grand', undefined, 0)})`)
  }

  const blanks = runPivot(source(), F.setFilterValues(base({ rows: ['stage'] }), 'region', [null]))
  ok(blanks.scanned === 1 && cell(blanks, 'grand', undefined, 0) === 1000,
    'a "(Blanks)" tick (null in the list) admits exactly the row with no region')

  const allSpec = JSON.parse(JSON.stringify(F.setFilterValues(edited, 'region', null))) as PivotSpec
  const all = runPivot(source(), allSpec)
  ok(all.scanned === 9 && cell(all, 'grand', undefined, 0) === 98050,
    '"(All)" — the field in the area with no predicate — filters nothing')

  const none = runPivot(source(), F.setFilterValues(base(), 'region', []))
  ok(none.scanned === 0, 'an empty checklist admits nothing — it is not read as "(All)"')

  const gone = runPivot(source(), base({ filters: [{ col: 'quarter', pred: { op: 'isOneOf', values: ['Q1'] } }] }))
  ok(gone.scanned === 9 && gone.findings.some((f) => f.kind === 'missing-column' && f.detail.includes('quarter')),
    'a filter on a column that is gone is DROPPED and REPORTED — it does not empty the pivot')

  const live = runPivot(source(), base({ rows: ['stage'], filters: [{ col: 'stage', pred: { op: 'isOneOf', set: new Set(['Won']) } }] }))
  ok(live.scanned === 4, 'a live filter.ts filter (a Set) still works for a caller holding one')

  const unknown = runPivot(source(), base({ filters: [{ col: 'region', pred: { op: 'fuzzy', v: 'nor' } }] }))
  ok(unknown.scanned === 9, 'a predicate this build does not know filters nothing rather than throwing')
  ok(readPivotSpec({ pivot: { ...base(), filters: [{ col: 'region', pred: { op: 'fuzzy', v: 'nor' } }] } })!
    .filters![0].pred !== undefined, '…and is kept in the document for the build that does')
}

console.log('\nthe checklist shows a value as its column does')
{
  ok(listLabel(4300, { type: 'money', format: '£#,##0' }) === '£4,300', `money: £4,300 (${listLabel(4300, { type: 'money', format: '£#,##0' })})`)
  ok(listLabel(0.25, { type: 'percent', format: '0%' }) === '25%', 'percent: 25%, not the stored 0.25')
  ok(listLabel('North', { type: 'text' }) === 'North', 'text prints as stored')
  ok(listLabel(false, { type: 'bool' }) === 'false',
    'a Yes/No false is NOT blanked — "" is the label the (Blanks) box owns')
  ok(listLabel('n/a', { type: 'money', format: '£#,##0' }) === 'n/a', 'a word in a money column prints as the word')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
