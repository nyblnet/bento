// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Charts, bound to columns.
//
// A TILE NAMES A SHEET AND COLUMNS. The series arrays are DERIVED at render and
// never stored — slides learned this the expensive way with `syncLinkedChart`,
// where a chart that carried its own copy of the numbers could disagree with
// the table beside it, go stale without saying so, and doubled the file.
// Promoted here from a special case to the rule: there is no code path that
// writes series data into the document.
//
// So a chart cannot be wrong about its own data. Edit a cell and the chart
// moves; sort the grid and the chart does not, because sorting is view state.
//
// NULLS ARE GAPS, NOT ZEROES. charts-lite's `num(v, 0)` turns a missing value
// into a plunge to the axis, which reads as "we sold nothing that month"
// rather than "we do not know". Missing values are dropped from the category
// entirely, and a series with nothing in it renders as absent rather than as a
// flat line at zero.

import { CHART_PRESETS, mountChart, type ChartLike } from '../../kernel/src/charts.ts'
import type { TableSheet } from './model.ts'
import { isErr } from './formula.ts'
import { readCell } from './store.ts'

export interface ChartBinding {
  /** category axis — usually a text column */
  x: string
  /** one series per column id */
  series: string[]
  kind: 'bar' | 'line' | 'pie' | 'scatter'
  /** group rows by the x value and total the series, rather than one bar per row */
  aggregate?: 'sum' | 'avg' | 'count' | 'none'
}

const asNumber = (v: unknown): number | null => {
  if (v == null || v === '' || isErr(v)) return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s£$€¥%]/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * Build a charts-lite option from a sheet and a binding.
 *
 * `computed` lets a formula column be charted without being stored: the grid
 * hands in what it just recalculated, so the chart shows the same numbers the
 * reader is looking at rather than the raw column underneath them.
 */
export function optionFor(
  sheet: TableSheet,
  bind: ChartBinding,
  computed?: Map<string, unknown[]>,
  palette: string[] = ['#F7A600', '#5B8DEF', '#2FB47C', '#E1616C', '#8B6FD3', '#3FA9B8'],
): Record<string, unknown> {
  const n = sheet.rids.reduce((a, [, c]) => a + c, 0)
  const colVals = (id: string): unknown[] => {
    const c = computed?.get(id)
    if (c) return c
    const d = sheet.data[id]
    return Array.from({ length: n }, (_, i) => readCell(d, i))
  }
  const nameOf = (id: string) => sheet.columns.find((c) => c.id === id)?.name ?? id

  const xs = colVals(bind.x).map((v) => (v == null ? '' : String(v)))
  const agg = bind.aggregate ?? 'sum'

  let cats: string[]
  let series: Array<{ name: string; data: Array<number | null> }>

  if (agg === 'none') {
    cats = xs
    series = bind.series.map((id) => ({
      name: nameOf(id),
      data: colVals(id).map(asNumber),
    }))
  } else {
    // group by x, in first-seen order — a chart's categories should appear in
    // the order the data does, not alphabetically
    const order: string[] = []
    const buckets = new Map<string, number[][]>()
    xs.forEach((k, i) => {
      if (!buckets.has(k)) { buckets.set(k, bind.series.map(() => [])); order.push(k) }
      const b = buckets.get(k)!
      bind.series.forEach((id, si) => {
        const v = asNumber(colVals(id)[i])
        if (v !== null) b[si].push(v)
      })
    })
    cats = order
    series = bind.series.map((id, si) => ({
      name: nameOf(id),
      data: order.map((k) => {
        const vals = buckets.get(k)![si]
        if (!vals.length) return null            // a gap, never a zero
        if (agg === 'count') return vals.length
        const sum = vals.reduce((a, b) => a + b, 0)
        return agg === 'avg' ? sum / vals.length : sum
      }),
    }))
  }

  if (bind.kind === 'pie') {
    const first = series[0]
    return {
      ...CHART_PRESETS.pie(),
      color: palette,
      series: [{
        type: 'pie',
        radius: '68%',
        data: cats
          .map((c, i) => ({ name: c, value: first?.data[i] }))
          .filter((d) => d.value != null),
      }],
    }
  }

  const base = CHART_PRESETS[bind.kind]?.() ?? CHART_PRESETS.bar()
  return {
    ...base,
    color: palette,
    legend: { bottom: 0, show: series.length > 1 },
    xAxis: { type: 'category', data: cats },
    yAxis: { type: 'value' },
    series: series.map((s) => ({
      type: bind.kind,
      name: s.name,
      data: s.data,
      ...(bind.kind === 'line' ? { smooth: false, symbolSize: 6 } : {}),
    })),
  }
}

/** Mount a live chart into a host element. Returns a teardown. */
export function renderChart(
  host: HTMLElement,
  sheet: TableSheet,
  bind: ChartBinding,
  computed?: Map<string, unknown[]>,
): () => void {
  const el: ChartLike = {
    w: host.clientWidth || 640,
    h: host.clientHeight || 320,
    option: optionFor(sheet, bind, computed),
  }
  host.innerHTML = ''
  return mountChart(el, host)
}

/**
 * A sensible default binding for a sheet: the first text column against every
 * numeric one. This is what "＋ Chart" produces, so the first chart takes no
 * configuration at all.
 */
export function defaultBinding(sheet: TableSheet): ChartBinding | null {
  const text = sheet.columns.find((c) => c.type === 'text' || c.type === 'enum')
  // PERCENT columns are excluded unless there is nothing else. A 0-to-1 series
  // on the same axis as money renders as no bar at all, so the legend names a
  // series the reader cannot see — which is worse than leaving it out, because
  // it looks like the data is missing rather than the scale being wrong.
  // (A second axis is the real fix; it is not in v0.1.)
  const magnitude = sheet.columns.filter((c) => c.type === 'number' || c.type === 'money')
  const pct = sheet.columns.filter((c) => c.type === 'percent')
  const nums = magnitude.length ? magnitude : pct
  if (!nums.length) return null
  return {
    x: text?.id ?? sheet.columns[0].id,
    series: nums.slice(0, 3).map((c) => c.id),
    kind: 'bar',
    aggregate: text ? 'sum' : 'none',
  }
}
