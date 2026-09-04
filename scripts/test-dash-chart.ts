#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash chart-binding rig.
//
//   node scripts/test-dash-chart.ts
//
// WHAT THIS PROVES. A tile NAMES a sheet and columns; the series arrays are
// derived at render and never stored. That is what stops a chart disagreeing
// with the table beside it — slides learned it the expensive way. So the whole
// surface worth testing is the DERIVATION, and it is pure, so it is testable
// here rather than by squinting at an SVG.
//
// The failure that matters most is a missing value drawn as a zero. charts-lite
// coerces with `num(v, 0)`, so a gap becomes a plunge to the axis: "we sold
// nothing in March" instead of "we do not know about March". One is a fact and
// the other is an absence, and a chart must not turn the second into the first.
//
// AND THE VIEW VECTOR. A filter changes which rows exist for this reading and a
// sort does not, and the derivation has to tell them apart: same code path,
// opposite obligations. Measured before the fix, on the starter workbook
// filtered to Value > 10000 — grid 4 rows, footer £69,050, chart £97,050 with an
// East bar for rows the filter had removed. Everything from `--- the view
// vector` down exists so that cannot come back without a red line here.

import {
  optionFor, defaultBinding, missingColumns, chartPlan, chartHeading,
  type ChartBinding,
} from '../dash/src/chart.ts'
import type { TableSheet } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const sheet = (): TableSheet => ({
  id: 'sh', name: 'S', kind: 'table',
  rids: [[1, 6]],
  columns: [
    { id: 'region', name: 'Region', type: 'text' },
    { id: 'value', name: 'Value', type: 'money' },
    { id: 'prob', name: 'Probability', type: 'percent' },
  ],
  data: {
    region: { enc: 'dict', dict: ['North', 'South'], idx: [0, 1, 0, 1, 0, 1] },
    value: { enc: 'raw', v: [10, 20, 30, 40, null, 60] },
    prob: { enc: 'raw', v: [1, 0.5, 1, 0.25, 1, 0.5] },
  },
  steps: [],
})

const S = (o: Record<string, unknown>) => o.series as Array<{ name: string; data: unknown[] }>

// ------------------------------------------------------------- aggregation
{
  const o = optionFor(sheet(), { x: 'region', series: ['value'], kind: 'bar', aggregate: 'sum' })
  ok(JSON.stringify((o.xAxis as { data: string[] }).data) === JSON.stringify(['North', 'South']),
    'rows group by the x column')
  // North = 10+30 (+null skipped) = 40; South = 20+40+60 = 120
  ok(JSON.stringify(S(o)[0].data) === JSON.stringify([40, 120]), 'and the series sums each group')
  ok(S(o)[0].name === 'Value', 'the series is named after the column, not its id')
}
{
  const o = optionFor(sheet(), { x: 'region', series: ['value'], kind: 'bar', aggregate: 'avg' })
  ok(JSON.stringify(S(o)[0].data) === JSON.stringify([20, 40]),
    'avg divides by the values PRESENT, not by the row count (North: 40/2, not 40/3)')
}
{
  const o = optionFor(sheet(), { x: 'region', series: ['value'], kind: 'bar', aggregate: 'none' })
  ok(S(o)[0].data.length === 6, 'aggregate:none charts one point per row')
}

// ------------------------------------------------- categories keep DATA order
{
  const s = sheet()
  s.data.region = { enc: 'dict', dict: ['Zulu', 'Alpha'], idx: [0, 1, 0, 1, 0, 1] }
  const o = optionFor(s, { x: 'region', series: ['value'], kind: 'bar', aggregate: 'sum' })
  ok(JSON.stringify((o.xAxis as { data: string[] }).data) === JSON.stringify(['Zulu', 'Alpha']),
    'categories appear in first-seen order, NOT alphabetically — a chart should read like its data')
}

// ------------------------------------------------ a gap is never a zero
{
  const s = sheet()
  // an entire category with no values at all
  s.data.region = { enc: 'dict', dict: ['A', 'B'], idx: [0, 1, 0, 1, 0, 1] }
  s.data.value = { enc: 'raw', v: [10, null, 30, null, 50, null] }
  const o = optionFor(s, { x: 'region', series: ['value'], kind: 'bar', aggregate: 'sum' })
  const d = S(o)[0].data
  ok(d[0] === 90, 'A sums its three values')
  ok(d[1] === null, 'B has NO values, so it is null — a gap')
  ok(d[1] !== 0, 'and specifically NOT zero, which would read as "B sold nothing"')
}

// ------------------------------------------------------ computed columns
{
  // a formula column has no stored data; the grid hands its computed values in
  const s = sheet()
  s.columns.push({ id: 'w', name: 'Weighted', type: 'money', formula: 'value * prob' })
  const computed = new Map<string, unknown[]>([['w', [10, 10, 30, 10, 0, 30]]])
  const o = optionFor(s, { x: 'region', series: ['w'], kind: 'bar', aggregate: 'sum' }, computed)
  ok(JSON.stringify(S(o)[0].data) === JSON.stringify([40, 50]),
    'a formula column charts from the COMPUTED values, which are never stored')
}

// ------------------------------------------------------------------- pie
{
  const o = optionFor(sheet(), { x: 'region', series: ['value'], kind: 'pie', aggregate: 'sum' })
  const d = S(o)[0].data as Array<{ name: string; value: number }>
  ok(d.length === 2 && d[0].name === 'North' && d[0].value === 40, 'pie takes {name,value} slices')
}

// --- the view vector ---------------------------------------------------------
//
// The starter workbook, exactly: eight deals, three regions. This is the sheet
// the failure was measured on, so the numbers below are the numbers on screen.
const REGION = ['North', 'South', 'North', 'East', 'South', 'North', 'East', 'South']
const VALUE = [12400, 8200, 15600, 4300, 9100, 22750, 6400, 18300]
const pipeline = (): TableSheet => ({
  id: 'sheet-pipeline', name: 'Pipeline', kind: 'table',
  rids: [[1, 8]],
  columns: [
    { id: 'region', name: 'Region', type: 'text' },
    { id: 'value', name: 'Value', type: 'money' },
  ],
  data: {
    region: { enc: 'dict', dict: ['North', 'South', 'East'], idx: REGION.map((r) => ['North', 'South', 'East'].indexOf(r)) },
    value: { enc: 'raw', v: [...VALUE] },
  },
  steps: [],
})
const BIND: ChartBinding = { x: 'region', series: ['value'], kind: 'bar', aggregate: 'sum' }
const total = (o: Record<string, unknown>) =>
  (S(o)[0].data as Array<number | null>).reduce<number>((a, b) => a + (b ?? 0), 0)
const cats = (o: Record<string, unknown>) => (o.xAxis as { data: string[] }).data

{
  const o = optionFor(pipeline(), BIND)
  ok(JSON.stringify(cats(o)) === JSON.stringify(['North', 'South', 'East']),
    'unfiltered, the chart draws all three regions')
  ok(total(o) === 97050, 'and totals £97,050 — the same number the footer shows')
}
{
  // THE MEASURED FAILURE. Value > 10000 leaves rows 0, 2, 5, 7.
  const o = optionFor(pipeline(), BIND, undefined, { rows: [0, 2, 5, 7] })
  ok(total(o) === 69050,
    'filtered to Value > 10000 the chart totals £69,050 — what the four visible rows are worth')
  ok(total(o) !== 97050,
    'and NOT £97,050, which is the total including the rows the filter just removed')
  ok(!cats(o).includes('East'),
    'East has no surviving row, so it is not a category — a bar for rows the reader cannot see is the bug')
  ok(JSON.stringify(S(o)[0].data) === JSON.stringify([50750, 18300]),
    'North keeps its three big deals; South keeps one')
}
{
  // A SORT IS A PERMUTATION and must not change a single number. This is the
  // half chart.ts already had right, and the half that is easy to break while
  // fixing the other one.
  const asc = [3, 6, 1, 5, 0, 2, 7, 4]                    // Value ascending
  const o = optionFor(pipeline(), BIND, undefined, { rows: asc })
  ok(total(o) === 97050, 'a SORT leaves the total at £97,050 — every row is still there')
  const byCat = new Map(cats(o).map((c, i) => [c, S(o)[0].data[i]]))
  ok(byCat.get('North') === 50750 && byCat.get('South') === 35600 && byCat.get('East') === 10700,
    'and every category keeps its own total, whatever order the rows arrive in')
  ok(cats(o)[0] === 'East',
    'only the READING ORDER moves: categories still appear in first-seen order, which is now the sorted one')
}
{
  // The projection must reach the x column and the series TOGETHER. Zipping a
  // filtered series against an unfiltered x is the plausible-looking disaster.
  const o = optionFor(pipeline(), BIND, undefined, { rows: [3] })
  ok(cats(o)[0] === 'East' && S(o)[0].data[0] === 4300,
    'one surviving row is labelled with ITS OWN category, not the first row\'s')
}
{
  const o = optionFor(pipeline(), { ...BIND, aggregate: 'avg' }, undefined, { rows: [0, 2, 5, 7] })
  const byCat = new Map(cats(o).map((c, i) => [c, S(o)[0].data[i]]))
  ok(byCat.get('North') === 50750 / 3,
    'avg divides by the rows the filter left, not by the rows the sheet holds')
}
{
  const o = optionFor(pipeline(), { ...BIND, aggregate: 'none' }, undefined, { rows: [0, 2, 5, 7] })
  ok(S(o)[0].data.length === 4, 'aggregate:none draws one point per VISIBLE row')
}
{
  const o = optionFor(pipeline(), { ...BIND, kind: 'pie' }, undefined, { rows: [0, 2, 5, 7] })
  const d = S(o)[0].data as Array<{ name: string; value: number }>
  ok(d.length === 2 && d.every((s) => s.name !== 'East'),
    'a pie is filtered too — a slice for hidden rows is a share of a total nobody can see')
}
{
  // A computed column is handed in whole and canonical; the vector must project
  // it exactly as it projects a stored one, or one series ends up filtered and
  // the other does not.
  const s = pipeline()
  s.columns.push({ id: 'half', name: 'Half', type: 'money', formula: 'value / 2' })
  const computed = new Map<string, unknown[]>([['half', VALUE.map((v) => v / 2)]])
  const o = optionFor(s, { ...BIND, series: ['value', 'half'] }, computed, { rows: [0, 2, 5, 7] })
  ok(total(o) === 69050, 'the stored column is filtered')
  ok((S(o)[1].data as Array<number | null>).reduce<number>((a, b) => a + (b ?? 0), 0) === 69050 / 2,
    'and the COMPUTED column is filtered by the same vector, on the same rows')
}
{
  const o = optionFor(pipeline(), BIND, undefined, { rows: null })
  ok(total(o) === 97050, 'a null vector means no filter, not no rows')
}
{
  // THE OTHER PROJECTION, and this rig earned it: story.ts and dashboard.ts do
  // the slicing themselves and hand in a SHORT map against a full-length sheet.
  // A first cut of the vector work re-expanded every column to the sheet's row
  // count and padded theirs with `undefined` — 8 red lines in test-dash-story.
  const s = pipeline()
  const sliced = new Map<string, unknown[]>([
    ['region', ['North', 'South']],
    ['value', [1, 2]],
  ])
  const o = optionFor(s, BIND, sliced)
  ok(JSON.stringify(cats(o)) === JSON.stringify(['North', 'South']) && total(o) === 3,
    'a caller that pre-sliced the columns is left alone: no vector, no re-expansion')
}

// --- a binding whose columns are gone ----------------------------------------
//
// Switch sheets and every bound column is missing; delete a column and one is.
// Both used to paint an axis with no bars, which claims "nothing here" when the
// truth is "I cannot find what I was drawing".
{
  const other: TableSheet = {
    id: 'sheet-new', name: 'Sheet', kind: 'table', rids: [[1, 3]],
    columns: [{ id: 'c1', name: 'Column A', type: 'text' }],
    data: { c1: { enc: 'raw', v: [null, null, null] } }, steps: [],
  }
  ok(JSON.stringify(missingColumns(other, BIND)) === JSON.stringify(['region', 'value']),
    'a chart pointed at another sheet knows exactly which columns it lost')
  ok(!chartPlan(other, BIND).drawable,
    'and refuses to draw — an empty axis is a claim about the data, not an absence of one')
}
{
  // one of two series deleted: draw what survives, name what did not
  const s = pipeline()
  const bind: ChartBinding = { ...BIND, series: ['value', 'cost'] }
  const plan = chartPlan(s, bind)
  ok(plan.drawable && JSON.stringify(plan.bind.series) === JSON.stringify(['value']),
    'one deleted series does not cost the reader the series that is still there')
  ok(JSON.stringify(plan.missing) === JSON.stringify(['cost']), 'and the missing one is named')
}
{
  const s = pipeline()
  s.columns = s.columns.filter((c) => c.id !== 'region')
  ok(!chartPlan(s, BIND).drawable,
    'losing the CATEGORY column stops the chart: bars with no labels are unreadable, not partial')
}

// --- which sheet is this about -----------------------------------------------
//
// The chart is PINNED to the sheet it was built from (StoryStep carries `sheet`
// beside `chart` for the same reason). Pinning is only honest if it is legible.
{
  const s = pipeline()
  ok(chartHeading(s, BIND, 'sheet-pipeline') === 'Region · Value',
    'looking at the chart\'s own sheet, the heading is just the columns')
  ok(chartHeading(s, BIND, 'sheet-new') === 'Pipeline · Region · Value',
    'looking at a DIFFERENT sheet, the heading names the sheet the chart is about')
  ok(chartHeading(s, BIND) === 'Region · Value', 'and no shown sheet means no claim either way')
}

// -------------------------------------------------------- default binding
{
  const b = defaultBinding(sheet())!
  ok(b.x === 'region', 'the default x is the first text column')
  ok(b.series.includes('value'), 'and a numeric column is charted')
  ok(!b.series.includes('prob'),
    'a PERCENT column is excluded: 0-to-1 beside money draws no visible bar, so the legend would name a series the reader cannot see')
  ok(b.aggregate === 'sum', 'and it groups, because a text x column means repeated categories')
}
{
  // nothing but percentages — then charting them is better than charting nothing
  const s = sheet()
  s.columns = s.columns.filter((c) => c.id !== 'value')
  delete s.data.value
  ok(defaultBinding(s)!.series.includes('prob'),
    'unless percent is ALL there is, in which case it is used')
}
{
  const s = sheet()
  s.columns = [s.columns[0]]
  ok(defaultBinding(s) === null, 'a sheet with no numeric column has no default chart')
}

// ------------------------------------------------- the chart the FILE remembers
//
// `doc.chart` (model.ts `OpenChart`). The binding and the sheet it is pinned to
// lived in two module-local `let`s in main.ts and nowhere else, so the choice
// of what to chart was lost on reload, on closing the tab, and on saving the
// file and sending it — the reader opened a workbook with no chart in it and
// nothing to say one had ever been drawn.
//
// main.ts BOOTS ON EVALUATION and can never be imported, so what is provable
// here is the mechanism: the field round-trips, the commit that writes it has a
// working inverse, it is stored by VALUE, and a stale one is reported rather
// than drawn. The wiring itself is exercised in a browser against the built
// shell, which is the only place it can be.
{
  const { registerHooks } = await import('node:module')
  registerHooks({
    load(url: string, context: unknown, next: (u: string, c: unknown) => unknown) {
      if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
      return next(url, context)
    },
  } as never)
  const { parseDoc } = await import('../dash/src/model.ts')
  const { Store } = await import('../dash/src/store.ts')
  const { validateDoc } = await import('../dash/src/validate.ts')

  const bind: ChartBinding = { x: 'region', series: ['value'], kind: 'bar', aggregate: 'sum' }
  const base = () => ({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
    sheets: [sheet()],
  })

  // ADDITIVITY (PLATFORM §3): a build that has never heard of the field keeps
  // it. `parseDoc` is that build for this purpose — it must not drop it.
  const withChart = { ...base(), chart: { sheet: 'sh', binding: bind } }
  const parsed = parseDoc(JSON.stringify(withChart)).doc
  ok(JSON.stringify(parsed.chart) === JSON.stringify(withChart.chart),
    'a saved chart survives parseDoc unchanged — the field is additive, not a field parseDoc knows')

  // THE COMMIT, AND ITS INVERSE. Writing it through `setDocProps` is what makes
  // switching the chart to a pie an undoable change to the document rather than
  // a thing that happens to the screen.
  const st = new Store(parseDoc(JSON.stringify(base())).doc)
  ok(st.doc.chart === undefined, 'a workbook with no chart has no field — absent, not an empty object')
  st.commit({ op: 'setDocProps', props: { chart: { sheet: 'sh', binding: { ...bind } } } })
  ok(st.doc.chart?.sheet === 'sh' && st.doc.chart?.binding.kind === 'bar', 'opening a chart records it')
  st.commit({ op: 'setDocProps', props: { chart: { sheet: 'sh', binding: { ...bind, kind: 'pie' } } } })
  ok(st.doc.chart?.binding.kind === 'pie', 'switching kind records the new kind')
  st.undo()
  ok(st.doc.chart?.binding.kind === 'bar', 'and ONE undo puts the bar chart back')
  st.undo()
  ok(st.doc.chart === undefined,
    'a second undo removes the field entirely rather than leaving an empty chart behind')

  // BY VALUE, NOT BY REFERENCE — the quiet one. main.ts keeps a live `binding`
  // object and cycles `binding.kind` in place. Store the reference and that
  // mutation edits the DOCUMENT with no commit: no op, no undo entry, nothing
  // for a collaborator to receive, and a file that is dirty without being
  // marked dirty. `rememberChart` clones for exactly this reason.
  const live: ChartBinding = { ...bind }
  const st2 = new Store(parseDoc(JSON.stringify(base())).doc)
  st2.commit({ op: 'setDocProps', props: { chart: structuredClone({ sheet: 'sh', binding: live }) } })
  live.kind = 'line'
  ok(st2.doc.chart?.binding.kind === 'bar',
    'mutating the live binding does NOT reach into the document — a change with no op behind it is a file dirty in secret')

  // A STALE ONE IS REPORTED. main.ts declines to reopen the panel when the
  // sheet or a column is gone, which is right and also silent; validate is
  // where the silence gets a sentence.
  const gone = parseDoc(JSON.stringify({ ...base(), chart: { sheet: 'nope', binding: bind } })).doc
  ok(validateDoc(gone).findings.some((f) => f.code === 'chart-missing-sheet'),
    'a chart naming a sheet that is not in the workbook is reported')
  const noCol = parseDoc(JSON.stringify({
    ...base(), chart: { sheet: 'sh', binding: { ...bind, series: ['value', 'ghost'] } },
  })).doc
  ok(validateDoc(noCol).findings.some((f) => f.code === 'chart-missing-column'),
    'and so is one binding a column the sheet no longer has')
  const fine = parseDoc(JSON.stringify(withChart)).doc
  ok(!validateDoc(fine).findings.some((f) => f.code.startsWith('chart-')),
    'while a chart that still resolves is reported as nothing at all')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
