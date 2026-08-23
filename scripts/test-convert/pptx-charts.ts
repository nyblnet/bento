#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// pptx-write chart-mapper rig: charts.ts.
//
//   node scripts/test-convert/pptx-charts.ts     (Node ≥ 23.6 strips types natively)
//
// The emitted c:chartSpace part is re-read with the convert engine's parser.
// The claims checked — series counts, numCache values VERBATIM, dual-axis
// wiring, the deleted secondary category axis — are the ones PowerPoint
// validates before rendering a chart. The NEGATIVE controls pin the fallback
// contract: a stacked or mixed-type option must NOT produce a c:chart (a
// clustered rendering of a stacked series misstates the totals — the spike's
// core finding), it must produce a data TABLE and a 'chart-approximated'
// report entry.

import { parseXml, kids, kid, attr, textOf, descendants, NS, type XElem } from '../../kernel/src/convert/xml.ts'
import { serialize, x } from '../../kernel/src/convert/xmlout.ts'
import { Report } from '../../kernel/src/convert/report.ts'
import type { OutChart } from '../../kernel/src/convert/types.ts'
import { chartExport, CHART_GRAPHIC_URI } from '../../kernel/src/convert/pptx-write/charts.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const chartEl = (option: Record<string, unknown>): OutChart => ({
  id: 'c1', type: 'chart', preset: 'bar',
  x: 400, y: 190, w: 800, h: 520, rotation: 0, opacity: 1,
  option,
})

const parseFrame = (frame: ReturnType<typeof x>): XElem =>
  kids(parseXml(serialize(x('root', { 'xmlns:a': NS.a, 'xmlns:p': NS.p, 'xmlns:r': NS.r }, [frame]))))[0]

const PALETTE = ['#E8A87C', '#5C7A8A']

// --- native bar + dual-axis line ---------------------------------------------
console.log('bar/line with a secondary axis')

{
  // The tableToChart pattern: bars on the left axis, a percent line on the
  // right — the dual-axis shape #88 skipped and the rework must carry.
  const report = new Report()
  const out = chartExport(chartEl({
    legend: { bottom: 0 },
    xAxis: { type: 'category', data: ['Q1', 'Q2', 'Q3'] },
    yAxis: [{ type: 'value' }, { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } }],
    series: [
      { type: 'bar', name: 'Revenue', data: [12, 4.25, 0] },
      { type: 'bar', name: 'Cost', data: [8, 3, 1] },
      { type: 'line', name: 'Margin', yAxisIndex: 1, smooth: true, data: [33, 29, 41] },
    ],
  }), 5, 'rId9', PALETTE, report, 'slide 4')

  ok(out.chartXml !== undefined, 'in-subset chart emits a native part')
  const space = parseXml(out.chartXml!)
  ok(space.ns === NS.c && space.local === 'chartSpace', 'root is c:chartSpace in the chart namespace')
  const chart = kid(space, NS.c, 'chart')!
  const plot = kid(chart, NS.c, 'plotArea')!

  const barChart = kid(plot, NS.c, 'barChart')!
  const lineChart = kid(plot, NS.c, 'lineChart')!
  ok(kids(barChart, NS.c, 'ser').length === 2, 'two bar series in the primary group')
  ok(kids(lineChart, NS.c, 'ser').length === 1, 'one line series in the secondary group')

  // numCache values VERBATIM — 4.25 must not reformat, 0 must survive.
  const barSer0 = kids(barChart, NS.c, 'ser')[0]
  const cache = kid(kid(kid(barSer0, NS.c, 'val')!, NS.c, 'numRef')!, NS.c, 'numCache')!
  ok(attr(kid(cache, NS.c, 'ptCount')!, 'val') === '3', 'ptCount matches the data length')
  const vals = kids(cache, NS.c, 'pt').map((p) => textOf(kid(p, NS.c, 'v')!))
  ok(vals.join(',') === '12,4.25,0', 'numCache values are verbatim (4.25 not reformatted, 0 kept)')
  ok(kids(cache, NS.c, 'pt').map((p) => attr(p, 'idx')).join(',') === '0,1,2', 'pt idx sequence intact')

  // Category cache + series name references (the edit-time rebuild addresses).
  const catCache = kid(kid(kid(barSer0, NS.c, 'cat')!, NS.c, 'strRef')!, NS.c, 'strCache')!
  ok(kids(catCache, NS.c, 'pt').map((p) => textOf(p)).join(',') === 'Q1,Q2,Q3', 'category strCache carries the x labels')
  ok(textOf(kid(kid(kid(barSer0, NS.c, 'tx')!, NS.c, 'strRef')!, NS.c, 'f')!) === 'Sheet1!$B$1', 'series name ref addresses column B row 1')

  // idx/order globally unique across the two plot groups.
  const allIdx = descendants(plot, NS.c, 'ser').map((s) => attr(kid(s, NS.c, 'idx')!, 'val'))
  ok(new Set(allIdx).size === 3 && allIdx.join(',') === '0,1,2', 'c:idx unique and global across plot groups')

  // Dual-axis wiring: primary pair on the bars, secondary pair on the line,
  // secondary catAx deleted, secondary valAx on the right crossing at max.
  const axIdsOf = (g: XElem) => kids(g, NS.c, 'axId').map((a) => attr(a, 'val'))
  ok(axIdsOf(barChart).join(',') === '1001,1002', 'bar group references the primary axis pair')
  ok(axIdsOf(lineChart).join(',') === '1003,1004', 'line group references the secondary axis pair')
  const catAxes = kids(plot, NS.c, 'catAx')
  const valAxes = kids(plot, NS.c, 'valAx')
  ok(catAxes.length === 2 && valAxes.length === 2, 'two category + two value axes present')
  const cat1 = catAxes.find((a) => attr(kid(a, NS.c, 'axId')!, 'val') === '1003')!
  ok(attr(kid(cat1, NS.c, 'delete')!, 'val') === '1', 'secondary category axis is deleted (hidden)')
  const val1 = valAxes.find((a) => attr(kid(a, NS.c, 'axId')!, 'val') === '1004')!
  ok(attr(kid(val1, NS.c, 'axPos')!, 'val') === 'r', 'secondary value axis sits on the right')
  ok(attr(kid(val1, NS.c, 'crosses')!, 'val') === 'max', 'secondary value axis crosses at max')
  ok(attr(kid(val1, NS.c, 'numFmt')!, 'formatCode') === '0"%"', "'{value}%' formatter → quoted-literal percent format (not Excel's ×100 percent)")
  ok(attr(kid(kid(val1, NS.c, 'scaling')!, NS.c, 'max')!, 'val') === '100', 'per-axis max carried into c:scaling')
  const val0 = valAxes.find((a) => attr(kid(a, NS.c, 'axId')!, 'val') === '1002')!
  ok(kid(val0, NS.c, 'majorGridlines') !== undefined, 'primary value axis keeps gridlines (charts-lite draws them)')
  ok(attr(kid(cat1, NS.c, 'crossAx')!, 'val') === '1004', 'axis pairs cross-reference each other')

  // Series colouring: first bar takes the deck palette, line styles its outline.
  ok(attr(kid(kid(kid(barSer0, NS.c, 'spPr')!, NS.a, 'solidFill')!, NS.a, 'srgbClr')!, 'val') === 'E8A87C',
    'series colour from the deck palette')
  const lineSer = kids(lineChart, NS.c, 'ser')[0]
  ok(kid(kid(kid(lineSer, NS.c, 'spPr')!, NS.a, 'ln')!, NS.a, 'solidFill') !== undefined, 'line series colour lives on the outline')
  ok(attr(kid(lineSer, NS.c, 'smooth')!, 'val') === '1', 'smooth carried onto the line series')

  ok(attr(kid(kid(chart, NS.c, 'legend')!, NS.c, 'legendPos')!, 'val') === 'b', 'legend bottom (the house preset position)')
  ok(attr(kid(chart, NS.c, 'autoTitleDeleted')!, 'val') === '1', 'no title in the option → autoTitleDeleted (no phantom "Chart Title")')
  ok(kid(chart, NS.c, 'plotVisOnly') !== undefined && attr(kid(chart, NS.c, 'dispBlanksAs')!, 'val') === 'gap',
    'plotVisOnly + dispBlanksAs gap (census shape)')
  ok(report.build().entries.length === 0, 'clean chart adds no report entries')

  // The frame references the part by the integrator's rel id.
  const frame = parseFrame(out.frame)
  const gd = kid(kid(frame, NS.a, 'graphic')!, NS.a, 'graphicData')!
  ok(attr(gd, 'uri') === CHART_GRAPHIC_URI, 'graphicData carries the chart uri')
  ok(attr(kid(gd, NS.c, 'chart')!, 'r:id') === 'rId9', 'c:chart reference carries the reserved rel id')
  ok(attr(kid(kid(frame, NS.p, 'nvGraphicFramePr')!, NS.p, 'cNvPr')!, 'id') === '5', 'cNvPr id from the caller')
}

// --- pie / doughnut ----------------------------------------------------------
console.log('pie')

{
  const report = new Report()
  const out = chartExport(chartEl({
    legend: { bottom: 0 },
    series: [{
      type: 'pie', radius: ['38%', '68%'],
      data: [{ name: 'Alpha', value: 42 }, { name: 'Beta', value: 28 }, { name: 'Gamma', value: 18 }],
    }],
  }), 2, 'rId2', PALETTE, report, 'slide 5')
  ok(out.chartXml !== undefined, 'pie is in-subset')
  const space = parseXml(out.chartXml!)
  const dough = descendants(space, NS.c, 'doughnutChart')[0]
  ok(dough !== undefined, "charts-lite's ['38%','68%'] radius → doughnutChart")
  ok(attr(kid(dough, NS.c, 'holeSize')!, 'val') === '56', 'holeSize = inner/outer share (38/68 → 56%)')
  const ser = kid(dough, NS.c, 'ser')!
  ok(kids(ser, NS.c, 'dPt').length === 3, 'one dPt per slice')
  ok(attr(descendants(kids(ser, NS.c, 'dPt')[1], NS.a, 'srgbClr')[0], 'val') === '5C7A8A',
    'slice colours walk the palette per data point')
  ok(kids(kid(kid(kid(ser, NS.c, 'cat')!, NS.c, 'strRef')!, NS.c, 'strCache')!, NS.c, 'pt').map((p) => textOf(p)).join(',') === 'Alpha,Beta,Gamma',
    'slice names in the category cache')
  ok(attr(kid(dough, NS.c, 'varyColors')!, 'val') === '1', 'pie varies colours by point')

  const plain = chartExport(chartEl({ series: [{ type: 'pie', radius: '70%', data: [{ name: 'A', value: 1 }] }] }),
    2, 'rId2', PALETTE, new Report(), 'slide 5')
  ok(descendants(parseXml(plain.chartXml!), NS.c, 'pieChart').length === 1, 'zero inner radius → pieChart, not doughnut')
}

// --- scatter -----------------------------------------------------------------
console.log('scatter')

{
  const out = chartExport(chartEl({
    xAxis: { type: 'value' }, yAxis: { type: 'value' },
    series: [{ type: 'scatter', name: 'Pts', data: [[1, 2], [3, 4.5], [5, 6]] }],
  }), 2, 'rId3', PALETTE, new Report(), 'slide 6')
  ok(out.chartXml !== undefined, 'scatter is in-subset')
  const space = parseXml(out.chartXml!)
  const sc = descendants(space, NS.c, 'scatterChart')[0]
  ok(sc !== undefined && attr(kid(sc, NS.c, 'scatterStyle')!, 'val') === 'lineMarker', 'scatterChart with lineMarker style')
  const ser = kid(sc, NS.c, 'ser')!
  const xs = kids(kid(kid(kid(ser, NS.c, 'xVal')!, NS.c, 'numRef')!, NS.c, 'numCache')!, NS.c, 'pt').map((p) => textOf(p))
  const ys = kids(kid(kid(kid(ser, NS.c, 'yVal')!, NS.c, 'numRef')!, NS.c, 'numCache')!, NS.c, 'pt').map((p) => textOf(p))
  ok(xs.join(',') === '1,3,5' && ys.join(',') === '2,4.5,6', 'pairs split into xVal/yVal caches verbatim')
  ok(descendants(kid(ser, NS.c, 'spPr')!, NS.a, 'noFill').length === 1, 'series outline noFill (markers only, no joining line)')
  ok(kids(descendants(space, NS.c, 'plotArea')[0], NS.c, 'valAx').length === 2, 'scatter carries two VALUE axes (no category axis)')
}

// --- the fallback contract ---------------------------------------------------
console.log('out-of-subset → data table (never a wrong chart)')

/** True when the frame is a TABLE graphicFrame with zero chart traces. */
function isDataTable(out: { frame: ReturnType<typeof x>; chartXml?: string }): boolean {
  if (out.chartXml !== undefined) return false
  const frame = parseFrame(out.frame)
  return descendants(frame, NS.a, 'tbl').length === 1 && descendants(frame, NS.c, 'chart').length === 0
}

{
  // NEGATIVE CONTROL (the spike's core case): a stacked option must not emit
  // a c:chart — a clustered read of stacked bars destroys the totals.
  const report = new Report()
  const out = chartExport(chartEl({
    xAxis: { data: ['a', 'b'] },
    series: [
      { type: 'bar', name: 'North', stack: 'total', data: [3, 4] },
      { type: 'bar', name: 'South', stack: 'total', data: [5, 6] },
    ],
  }), 2, 'rId4', PALETTE, report, 'slide 7')
  ok(out.chartXml === undefined, 'NEGATIVE: stacked option emits NO c:chart part')
  ok(isDataTable(out), 'stacked option renders as a table graphicFrame instead')
  const entry = report.build().entries.find((e) => e.code === 'chart-approximated')
  ok(entry !== undefined && entry.verdict === 'approximated', "fallback reports 'chart-approximated'")

  // The table carries the actual numbers: header row of series names, labels
  // down the first column.
  const tbl = descendants(parseFrame(out.frame), NS.a, 'tbl')[0]
  const trs = kids(tbl, NS.a, 'tr')
  ok(trs.length === 3, 'header + one row per category')
  const rowText = (r: number) => kids(trs[r], NS.a, 'tc').map((tc) => descendants(tc, NS.a, 't').map(textOf).join(''))
  ok(rowText(0).join('|') === '|North|South', 'header row carries the series names')
  ok(rowText(1).join('|') === 'a|3|5', 'data rows carry label + every series value')
}

{
  // Mixed types on ONE axis is outside the subset (dual-axis mixing is not).
  const mixed = chartExport(chartEl({
    xAxis: { data: ['a'] },
    series: [{ type: 'bar', data: [1] }, { type: 'line', data: [2] }],
  }), 2, 'rId5', PALETTE, new Report(), 'slide 8')
  ok(isDataTable(mixed), 'NEGATIVE: bar+line on the SAME axis falls back to a table')

  const radar = chartExport(chartEl({ series: [{ type: 'radar', data: [1] }] }),
    2, 'rId5', PALETTE, new Report(), 'slide 8')
  ok(isDataTable(radar), 'NEGATIVE: unknown series type falls back to a table')

  const twoPies = chartExport(chartEl({ series: [{ type: 'pie', data: [] }, { type: 'pie', data: [] }] }),
    2, 'rId5', PALETTE, new Report(), 'slide 8')
  ok(isDataTable(twoPies), 'NEGATIVE: multi-series pie falls back to a table')

  const pieFallback = chartExport(chartEl({
    series: [{ type: 'pie', stack: 'x', name: 'Share', data: [{ name: 'A', value: 7 }] }],
  }), 2, 'rId5', PALETTE, new Report(), 'slide 8')
  const tbl = descendants(parseFrame(pieFallback.frame), NS.a, 'tbl')[0]
  const row1 = kids(kids(tbl, NS.a, 'tr')[1], NS.a, 'tc').map((tc) => descendants(tc, NS.a, 't').map(textOf).join(''))
  ok(row1.join('|') === 'A|7', 'pie fallback tables slice names and values')
}

// --- data coercion mirrors the renderer --------------------------------------
console.log('data coercion')

{
  const report = new Report()
  const out = chartExport(chartEl({
    xAxis: { data: ['a', 'b', 'c'] },
    series: [{ type: 'bar', name: 'S', data: [1, null, { value: 5 }] }],
  }), 2, 'rId6', PALETTE, report, 'slide 9')
  // One bar series = exactly one numCache (names and categories are strCache).
  const cache = descendants(parseXml(out.chartXml!), NS.c, 'numCache')[0]
  const vals = kids(cache, NS.c, 'pt').map((p) => textOf(p))
  ok(vals.join(',') === '1,0,0', 'null and {value} objects coerce to 0 — exactly what charts-lite rendered')
  ok(report.build().entries.some((e) => e.code === 'chart-data-coerced' && e.verdict === 'approximated'),
    'coercion is reported even though the render already showed zeros')
}

console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) process.exit(1)
