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

import { optionFor, defaultBinding, type ChartBinding } from '../dash/src/chart.ts'
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

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
