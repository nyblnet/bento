#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash chart binding rig — the chart from the SELECTION, the line it
// refuses, and the axis that wears the column's format.
//
//   node scripts/test-dash-chartbind.ts
//
// WHAT THIS PROVES, each against a failure measured in the 2026-10-20 review:
//   1. "Chart the selected columns" charts the selected columns. With Value
//      selected it charted Value, Weighted and Computed — the selection was
//      never read. `bindingFromSelection` is the decision; the browser rig
//      (test-dash-pivotchart-browser.mjs) proves the button calls it.
//   2. A line is not drawn through categories that have no order. The type
//      toggle drew a line from North to South to East; a line claims the space
//      between two points means something, and between two regions it does not.
//      Refused unless the author asked (`allowLine`).
//   3. The value axis says £ when the series are money, % when percent (scaled
//      ×100, because percent columns store the fraction), and nothing when the
//      series do not share a format.
//   4. The editor's additive fields reach the option: per-series colours keyed
//      by COLUMN (not position), the legend switch, and a binding without any of
//      them draws exactly what it always drew.

import {
  optionFor, bindingFromSelection, lineRefused, axisFormat, isOrdered, defaultBinding,
  type ChartBinding,
} from '../dash/src/chart.ts'
import type { TableSheet } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const sheet = (): TableSheet => ({
  id: 's', name: 'Pipeline', kind: 'table',
  rids: [[1, 4]],
  columns: [
    { id: 'region', name: 'Region', type: 'text' },
    { id: 'owner', name: 'Owner', type: 'text' },
    { id: 'value', name: 'Value', type: 'money', format: '£#,##0' },
    { id: 'closed', name: 'Closed', type: 'date' },
    { id: 'prob', name: 'Probability', type: 'percent', format: '0%' },
    { id: 'weighted', name: 'Weighted', type: 'money', format: '£#,##0' },
    { id: 'qty', name: 'Qty', type: 'number' },
  ],
  data: {
    region: { enc: 'raw', v: ['North', 'South', 'North', 'East'] },
    owner: { enc: 'raw', v: ['Priya', 'Sam', 'Lee', 'Lee'] },
    value: { enc: 'raw', v: [100, 200, 300, 400] },
    closed: { enc: 'raw', v: ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'] },
    prob: { enc: 'raw', v: [0.5, 0.25, 1, 0] },
    weighted: { enc: 'raw', v: [50, 50, 300, 0] },
    qty: { enc: 'raw', v: [1, 2, 3, 4] },
  },
  steps: [],
} as unknown as TableSheet)

type Opt = { series: Array<{ type: string; name: string; data: Array<number | null> }>; color: string[]; legend?: unknown; yAxis: { axisLabel?: { formatter?: string } }; xAxis: { data: string[] } }

console.log('\n1. the selection is the chart')
{
  const s = sheet()
  const b = bindingFromSelection(s, ['value'])!
  ok(JSON.stringify(b.series) === '["value"]',
    `Value selected → ONE series, Value (got ${JSON.stringify(b.series)}; the old button charted ${JSON.stringify(defaultBinding(s)!.series)})`)
  ok(b.x === 'region' && b.aggregate === 'sum', 'with no text column in the selection, the sheet\'s first one is the categories, summed')
  const two = bindingFromSelection(s, ['owner', 'value', 'weighted'])!
  ok(two.x === 'owner' && JSON.stringify(two.series) === '["value","weighted"]',
    'Owner, Value, Weighted selected → Owner is the categories (the first TEXT column in the selection), the two money columns the series')
  const none = bindingFromSelection(s, ['region'])!
  ok(JSON.stringify(none) === JSON.stringify(defaultBinding(s)),
    'a selection with nothing numeric in it falls back to the sheet default rather than an empty axis')
  ok(bindingFromSelection(s, ['ghost', 'value'])!.series.length === 1, 'an id that is not a column is ignored, never charted as an empty series')
  const noText: TableSheet = { ...s, columns: s.columns.filter((c) => c.type !== 'text') } as TableSheet
  const nt = bindingFromSelection(noText, ['value'])!
  ok(nt.aggregate === 'none' && nt.x !== 'value', 'no text column anywhere → one point per row, and the series is never its own category axis')
}

console.log('\n2. a line through unordered categories is refused unless asked')
{
  const s = sheet()
  const line: ChartBinding = { x: 'region', series: ['value'], kind: 'line', aggregate: 'sum' }
  ok(!isOrdered(s.columns[0]) && isOrdered(s.columns[3]) && isOrdered(s.columns[2]), 'text has no order; dates and numbers do')
  ok(lineRefused(s, line), 'Line over Region is refused')
  const o = optionFor(s, line) as unknown as Opt
  ok(o.series.every((x) => x.type === 'bar'), `…and DRAWN AS BARS (series types: ${o.series.map((x) => x.type).join(',')})`)
  const asked = optionFor(s, { ...line, allowLine: true }) as unknown as Opt
  ok(!lineRefused(s, { ...line, allowLine: true }) && asked.series.every((x) => x.type === 'line'),
    '"Draw a line anyway" (allowLine) draws the line')
  const dated = optionFor(s, { ...line, x: 'closed' }) as unknown as Opt
  ok(!lineRefused(s, { ...line, x: 'closed' }) && dated.series[0].type === 'line', 'a line over DATES is drawn without asking')
  ok(!lineRefused(s, { ...line, kind: 'bar' }), 'bars are never refused')
}

console.log('\n3. the axis wears the column\'s format')
{
  const s = sheet()
  const money = optionFor(s, { x: 'region', series: ['value', 'weighted'], kind: 'bar', aggregate: 'sum' }) as unknown as Opt
  ok(money.yAxis.axisLabel?.formatter === '£{value}', `two £ series → axis "£{value}" (${money.yAxis.axisLabel?.formatter})`)
  const pct = optionFor(s, { x: 'region', series: ['prob'], kind: 'bar', aggregate: 'avg' }) as unknown as Opt
  ok(pct.yAxis.axisLabel?.formatter === '{value}%', `a percent series → "{value}%" (${pct.yAxis.axisLabel?.formatter})`)
  ok(pct.series[0].data[0] === 75, `…and its data is scaled to percent: North avg (0.5+1)/2 = 75, not 0.75 (${pct.series[0].data[0]})`)
  const mixed = optionFor(s, { x: 'region', series: ['value', 'prob'], kind: 'bar', aggregate: 'sum' }) as unknown as Opt
  ok(mixed.yAxis.axisLabel === undefined && axisFormat(s, ['value', 'prob']).mixed,
    'money and percent on one axis share no unit → bare numbers, never a £ on a probability')
  ok(mixed.series[1].data[0] === 1.5, 'and nothing is scaled when the axis is not a percent axis')
  const plain = optionFor(s, { x: 'region', series: ['qty'], kind: 'bar', aggregate: 'sum' }) as unknown as Opt
  ok(plain.yAxis.axisLabel === undefined && !axisFormat(s, ['qty']).mixed, 'an unformatted number column → plain labels, not "mixed"')
}

console.log('\n4. the editor\'s fields reach the option, additively')
{
  const s = sheet()
  const b: ChartBinding = { x: 'region', series: ['value', 'weighted'], kind: 'bar', aggregate: 'sum' }
  const plain = optionFor(s, b) as unknown as Opt
  ok(plain.color[0] === '#F7A600' && plain.color[1] === '#5B8DEF', 'no colours set → the palette, in order')
  ok(!!plain.legend, 'two series → a legend by default')
  const one = optionFor(s, { ...b, series: ['value'] }) as unknown as Opt
  ok(one.legend === undefined, 'one series → no legend by default (charts-lite drew `{show:false}` anyway, so absent is the off switch)')
  const painted = optionFor(s, { ...b, colors: { weighted: '#112233' } }) as unknown as Opt
  ok(painted.color[1] === '#112233' && painted.color[0] === '#F7A600', 'a colour set on Weighted paints Weighted')
  const dropped = optionFor(s, { ...b, series: ['weighted'], colors: { weighted: '#112233' } }) as unknown as Opt
  ok(dropped.color[0] === '#112233', 'and STAYS on Weighted when Value is removed — colours follow the column, not the position')
  ok((optionFor(s, { ...b, legend: false }) as unknown as Opt).legend === undefined, 'the legend switch turns it off')
  ok(!!(optionFor(s, { ...b, series: ['value'], legend: true }) as unknown as Opt).legend, 'and on, for one series')
  const json = JSON.parse(JSON.stringify({ ...b, title: 'Deals', colors: { value: '#000000' }, allowLine: true, future: 1 }))
  ok(json.title === 'Deals' && json.future === 1, 'every new field is plain JSON, and an unknown one rides along')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
