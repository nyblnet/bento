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
// A FILTER IS NOT A SORT, and conflating them is what made the sentence above
// half wrong. A sort is a PERMUTATION: the same rows in a different order, and
// every aggregate over a permutation is the same aggregate, so a chart that
// ignores a sort is right. A FILTER changes which rows exist for this reading,
// and a chart that ignores one asserts a total nobody on screen can see.
// Measured on the starter workbook, Value > 10000: the grid painted 4 rows, the
// footer said £69,050 — and the chart beside it drew North, South AND East
// totalling £97,050, including an East bar for two rows the filter had just
// removed. Same failure as the footer totals (grid.ts `aggregate`), same fix:
// read the view vector, and say so on screen when it excludes rows.
//
// A CHART IS ABOUT A SHEET, so it is PINNED to the one it was built from and
// never follows the tab bar. `StoryStep` already spells this out in the format —
// a step carries `sheet` AND `chart`, because "revenue by region" is an argument
// about a particular table. Following the shown sheet would silently re-point
// the chart on every tab click, which is the same class of lie as a stale one,
// only faster; and the bound columns almost never exist on the next sheet, so
// what actually arrived was an empty axis (measured: title " · value", one
// category "", one null bar, a 0-to-1 y axis, no message). Instead the chart
// keeps drawing its own sheet, SAYS which sheet that is, and offers one button
// to re-point at the sheet in front of the reader. Nothing silent, nothing
// blank.
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
import { t } from './i18n.ts'

export interface ChartBinding {
  /** category axis — usually a text column */
  x: string
  /** one series per column id */
  series: string[]
  kind: 'bar' | 'line' | 'pie' | 'scatter'
  /** group rows by the x value and total the series, rather than one bar per row */
  aggregate?: 'sum' | 'avg' | 'count' | 'none'
}

/**
 * How to READ the sheet — never what to draw.
 *
 * `rows` is the view vector, `store.order[sheet.id]`: the canonical row indices
 * the reader can see, in the order they see them, or null/undefined for "every
 * row". It is exactly the argument grid.ts's `aggregate` takes for the footer
 * totals, and for exactly the same reason — the two readouts sit on one screen
 * and must not disagree.
 *
 * IT APPLIES TO EVERY BOUND COLUMN OR TO NONE, which is why it lives here
 * rather than at the call site. `optionFor` zips the x column against each
 * series column BY INDEX; project one of them and not another and the chart
 * pairs the wrong label with the wrong number, looking entirely plausible while
 * doing it. Passing an index vector makes that unrepresentable — the projection
 * happens once, inside `colVals`, for whatever a column's values came from.
 *
 * The indices are CANONICAL sheet rows, so a `computed` map must be canonical
 * too (grid.computed is: `recalc` runs over the whole sheet, ignoring the view).
 * Callers that project the columns themselves — story.ts's `viewColumns`,
 * dashboard.ts's cross-filter — pass no `rows` and are unaffected.
 */
export interface ChartViewOpts {
  rows?: number[] | null
  palette?: string[]
}

const PALETTE = ['#F7A600', '#5B8DEF', '#2FB47C', '#E1616C', '#8B6FD3', '#3FA9B8']

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
 *
 * `opts.rows` restricts it to the rows the reader can see — see `ChartViewOpts`.
 */
export function optionFor(
  sheet: TableSheet,
  bind: ChartBinding,
  computed?: Map<string, unknown[]>,
  opts: ChartViewOpts = {},
): Record<string, unknown> {
  const palette = opts.palette ?? PALETTE
  const rows = opts.rows ?? null
  const all = sheet.rids.reduce((a, [, c]) => a + c, 0)
  const colVals = (id: string): unknown[] => {
    const c = computed?.get(id)
    // ONE projection, applied to whatever the values came from. A raw column and
    // a computed one must not take different paths here: that is how half a
    // chart ends up filtered.
    if (rows) {
      const at = c ? (i: number) => c[i] : (i: number) => readCell(sheet.data[id], i)
      return rows.map(at)
    }
    // NO VECTOR MEANS DO NOT TOUCH THE LENGTHS. story.ts and dashboard.ts hand
    // in a map that is ALREADY the visible slice against a full-length sheet;
    // re-expanding it to `all` here padded every projected column with
    // `undefined` and broke both. (It did, for one commit: 8 red lines in
    // test-dash-story.ts.)
    if (c) return c
    const d = sheet.data[id]
    return Array.from({ length: all }, (_, i) => readCell(d, i))
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

/**
 * The bound columns that are not in the sheet any more.
 *
 * A binding names columns by id, and ids outlive nothing: switch sheets and the
 * whole binding is missing; delete one column and one series is. Both used to
 * arrive as an axis with no bars — the worst possible answer, because an empty
 * chart is indistinguishable from a chart of nothing, and the reader is left to
 * guess which.
 */
export function missingColumns(sheet: TableSheet, bind: ChartBinding): string[] {
  const have = new Set(sheet.columns.map((c) => c.id))
  return [bind.x, ...bind.series].filter((id) => id && !have.has(id))
}

/**
 * The panel's heading: what this chart is of, and — when the reader is looking
 * at some other sheet — which sheet it is about.
 *
 * The sheet name is in front ONLY when it differs from the shown one. A label
 * that always says "Pipeline · Region · Value" is read once and then never
 * again, which is exactly what a warning must not be.
 */
export function chartHeading(
  sheet: TableSheet, bind: ChartBinding, showing?: string | null,
): string {
  const nameOf = (id: string) => sheet.columns.find((c) => c.id === id)?.name ?? id
  const of = `${nameOf(bind.x)} · ${bind.series.map(nameOf).join(', ')}`
  return showing && showing !== sheet.id ? `${sheet.name} · ${of}` : of
}

/**
 * What can honestly be drawn from this binding against this sheet.
 *
 * Separated from `renderChart` so it can be asserted without a browser — the
 * three outcomes below are a decision about truthfulness, and a decision like
 * that should not be verifiable only by squinting at a panel.
 */
export interface ChartPlan {
  /** bound column ids the sheet does not have */
  missing: string[]
  /** false when there is nothing truthful to draw: no x, or no series left */
  drawable: boolean
  /** the binding minus the columns that are gone */
  bind: ChartBinding
}

export function chartPlan(sheet: TableSheet, bind: ChartBinding): ChartPlan {
  const missing = missingColumns(sheet, bind)
  const live = { ...bind, series: bind.series.filter((id) => !missing.includes(id)) }
  return { missing, bind: live, drawable: !missing.includes(bind.x) && live.series.length > 0 }
}

export interface ChartHostOpts extends ChartViewOpts {
  /**
   * The sheet the reader is looking at, when it is NOT this chart's sheet.
   * Null/absent means the chart and the grid are showing the same table.
   */
  showing?: { id: string; name: string } | null
  /**
   * Re-point the chart at the sheet in front of the reader. Given, the panel
   * offers it as a button; absent, the panel still SAYS what is wrong.
   *
   * It is a button and not an automatic rebind on purpose. Re-deriving a
   * binding silently changes what the chart asserts without anyone asking, and
   * the whole complaint this file answers is a chart that changed its mind
   * quietly.
   */
  onRebind?: () => void
}

/** A line of chrome above or below the plot. Text only — never innerHTML: a
 *  sheet name is user data and a column id can be anything. */
function noteBar(text: string, action?: { label: string; run: () => void }): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'dx-chart-note'
  bar.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:8px;' +
    'padding:6px 8px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--line)'
  const span = document.createElement('span')
  span.style.cssText = 'flex:1 1 auto;min-width:0'
  span.textContent = text
  bar.append(span)
  if (action) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'dx-btn'
    b.style.cssText = 'flex:0 0 auto;padding:3px 8px;font-size:12px'
    b.textContent = action.label
    b.addEventListener('click', action.run)
    bar.append(b)
  }
  return bar
}

/**
 * Mount a live chart into a host element. Returns a teardown.
 *
 * THREE OUTCOMES, and only one of them used to exist:
 *
 *  1. The binding resolves — draw it, from `opts.rows` if a filter is on, and
 *     say underneath how many rows that is. The count is the honest part: a
 *     screenshot of a filtered chart otherwise claims to be the whole table.
 *  2. Some series columns are gone but the category column and at least one
 *     series survive — draw what survives and name what did not. Refusing the
 *     whole chart because one series was deleted throws away data the reader
 *     still has.
 *  3. The category column is gone, or every series is — there is nothing
 *     truthful to draw. Say what it lost and offer one button, instead of the
 *     empty 0-to-1 axis this used to paint.
 */
export function renderChart(
  host: HTMLElement,
  sheet: TableSheet,
  bind: ChartBinding,
  computed?: Map<string, unknown[]>,
  opts: ChartHostOpts = {},
): () => void {
  host.innerHTML = ''
  host.style.display = 'flex'
  host.style.flexDirection = 'column'

  const away = opts.showing && opts.showing.id !== sheet.id ? opts.showing : null
  const { missing, bind: live, drawable } = chartPlan(sheet, bind)
  const rebind = opts.onRebind
    ? { label: t('Chart {sheet} instead', { sheet: away?.name ?? sheet.name }), run: opts.onRebind }
    : undefined

  if (away) {
    host.append(noteBar(
      t('This chart is about {sheet}. You are looking at {other}.',
        { sheet: sheet.name, other: away.name }),
      rebind))
  }
  if (missing.length) {
    host.append(noteBar(
      drawable
        ? t('{sheet} no longer has {cols}, so it is not drawn.',
          { sheet: sheet.name, cols: missing.join(', ') })
        : t('This chart was drawn from {cols}, and {sheet} does not have {n} of them any more.',
          { cols: [bind.x, ...bind.series].join(', '), sheet: sheet.name, n: missing.length }),
      away ? undefined : rebind))
  }

  if (!drawable) {
    // No plot at all. An axis with no bars is not a lesser version of a chart,
    // it is a different and false claim.
    const pad = document.createElement('div')
    pad.style.cssText = 'flex:1 1 auto;min-height:0'
    host.append(pad)
    return () => { host.innerHTML = '' }
  }

  const plot = document.createElement('div')
  plot.style.cssText = 'flex:1 1 auto;min-height:0;position:relative'
  host.append(plot)

  const all = sheet.rids.reduce((a, [, c]) => a + c, 0)
  const shown = opts.rows ? opts.rows.length : all
  // ONLY when rows are actually excluded. A caption that says "8 of 8" on every
  // unfiltered chart is read as decoration and then not read at all — the same
  // argument the footer's `dg-part` marker makes in grid.ts.
  if (shown < all) {
    const cap = document.createElement('div')
    cap.className = 'dx-chart-rows'
    cap.style.cssText = 'flex:0 0 auto;padding:4px 8px 2px;font-size:11px;color:var(--muted);text-align:right'
    cap.textContent = t('{n} of {all} rows — a filter is hiding the rest.',
      { n: shown, all })
    host.append(cap)
  }

  const el: ChartLike = {
    // measured AFTER the notes and the caption are in the flow, so the plot
    // gets the space it actually has rather than the panel's full height
    w: plot.clientWidth || 640,
    h: plot.clientHeight || 320,
    option: optionFor(sheet, live, computed, { rows: opts.rows, palette: opts.palette }),
  }
  const down = mountChart(el, plot)
  return () => { down(); host.innerHTML = '' }
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
