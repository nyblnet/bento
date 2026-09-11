// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// BURNDOWN, BURNUP AND CUMULATIVE FLOW — charts of the trail.
//
// WHY THESE ARE A `chart` BLOCK AND NOT A `view` LAYOUT. Gantt and workload are
// view layouts and that is right: they read the pages LIVE, and `source`,
// `filter`, `sort` and `groupBy` genuinely narrow them at read time. These
// three are different in kind. They read `doc.trail`, whose rows are counts
// written at aggregation time — you cannot retroactively filter "project =
// Apollo" out of a stored count of 47, because the pages that made it are
// deliberately not in the record. A view layout would therefore give them
// `source` and `filter` keys that LOOK like they narrow the chart and silently
// do not, which is the exact failure mode this codebase keeps hitting.
//
//     THE HOST FOLLOWS THE DATA SOURCE.
//     Charts of pages are view layouts. Charts of the trail are chart blocks.
//
// The scope a trail chart IS narrowed by is frozen onto its PERIOD at commit
// time, where it cannot be edited into a lie afterwards.
//
// WHY THIS DRAWS ITS OWN SVG RATHER THAN CALLING `kernel/src/charts.ts`. That
// was the intended host and it was read first. Charts-lite interprets the
// ECharts option SHAPE but implements a subset, and three things these charts
// are ABOUT are outside it — measured against the source, not assumed:
//
//   1. A GAP WOULD DRAW AS ZERO. `renderCartesian` maps every datum through
//      `num(v, 0)`, so an absent day is a point at the origin. "Absent must
//      look different from zero" is the load-bearing requirement here, and the
//      one engine we have coerces one into the other.
//   2. NO STACKING. There is no `stack` support anywhere in the file, and a
//      cumulative flow diagram is stacked bands by definition.
//   3. NO PER-SEGMENT LINE STYLE. `stroke-dasharray` is set only to animate a
//      sweep, so a thinned weekly sample could not be drawn as a dashed
//      segment and would be indistinguishable from a daily reading.
//
// Kernel is a serialized zone and this is not a kernel change; the honest
// answer was to draw these three in the app that needs them, exactly as
// `graph.ts` already draws the graph view rather than shipping d3. The
// arithmetic below is about a hundred lines, and the parts that matter — where
// a gap is, what a sample covers — are pure functions with a rig on them.

import type { SpacesDoc } from './model'
import { t, locale } from './i18n.ts'
import { phaseField, type FieldOption } from './fields.ts'
import { observe } from './observe.ts'
import { periodOf, periodList, scopeOf, startPeriod, type Period } from './periods.ts'
import {
  slots, seriesRows, wasCut, countOf, estimateOf, hasEstimates,
  isDay, daysBetween, addDays, type Trail, trailOf,
} from './trail.ts'

export const CHART_KINDS = ['burndown', 'burnup', 'cfd'] as const
export type ChartKind = (typeof CHART_KINDS)[number]

export const chartKind = (raw: unknown): ChartKind => {
  const s = String(raw ?? 'burndown')
  return (CHART_KINDS as readonly string[]).includes(s) ? (s as ChartKind) : 'burndown'
}

/** What each kind is called. A function with literal t() calls, never a map
 *  read back through t(MAP[k]) — the extractor sweeps LITERALS, and the packer
 *  would still report 100% while shipping English (fields.ts learned this). */
export function chartKindLabel(kind: ChartKind): string {
  switch (kind) {
    case 'burnup': return t('Burnup')
    case 'cfd': return t('Cumulative flow')
    default: return t('Burndown')
  }
}

// ---- the data --------------------------------------------------------------

/** One stacked band or one line. */
export interface Band {
  id: string
  label: string
  color: string
  /** an option id no schema in this document declares */
  unknown?: boolean
}

/** One drawn point. `sample` means it stands for more than the day it sits on. */
export interface Point {
  day: string
  kind: 'day' | 'sample'
  /** one value per band, in band order */
  v: number[]
  /** derived from live state rather than read from the trail */
  live?: boolean
}

export interface ChartData {
  kind: ChartKind
  from: string
  to: string
  bands: Band[]
  /** contiguous runs of points; the space BETWEEN two runs is a gap */
  runs: Point[][]
  /** day ranges with no observation at all, inclusive, in order */
  gaps: Array<[string, string]>
  /** the burndown guide: full at `from`, zero at `to` */
  ideal?: number
  /** the burnup's committed scope, and the day it was committed */
  committed?: { v: number; at: string }
  /** older rows were dropped: the left edge is "recording starts here" */
  cut: boolean
  /** issues with no estimate on the most recent point */
  unestimated: number
  /** whether the numbers are summed estimates or issue counts */
  units: 'points' | 'issues'
  /** is there anything to draw at all? */
  empty: boolean
}

const OPEN = (o: FieldOption | undefined): boolean =>
  o?.group !== 'done' && o?.group !== 'cancelled'

const UNKNOWN_COLOR = '#98A2B3'

/**
 * The status options in force, as bands.
 *
 * Option ids appearing in the trail that the schema no longer declares are kept
 * and marked unknown — the rule `ViewFilter` states for a value this build does
 * not know: carry it literally rather than match nothing. An option deleted
 * next month must not silently delete a band out of last month's chart.
 */
function optionBands(doc: SpacesDoc, seen: Set<string>): Band[] {
  const pf = phaseField(doc)
  const declared = pf?.options ?? []
  const bands: Band[] = []
  const used = new Set<string>()
  for (const o of declared) {
    if (!o || typeof o.id !== 'string') continue
    used.add(o.id)
    bands.push({ id: o.id, label: String(o.label ?? o.id), color: String(o.color ?? UNKNOWN_COLOR) })
  }
  for (const id of [...seen].sort()) {
    if (used.has(id)) continue
    bands.push({
      id,
      label: id ? t('{id} (unknown)', { id }) : t('No status'),
      color: UNKNOWN_COLOR,
      unknown: true,
    })
  }
  return bands
}

const optionById = (doc: SpacesDoc, id: string): FieldOption | undefined =>
  phaseField(doc)?.options?.find((o) => o?.id === id)

/**
 * The points, the runs and the gaps for one period.
 *
 * TODAY IS DERIVED, EVERY OTHER DAY IS READ. The falsifiable half of the
 * derivation rule: change an estimate now and today's point moves immediately,
 * because it is counted from live state rather than read from a stored copy.
 * Strictly-earlier days come from the trail, where there is nothing left to
 * disagree with.
 */
export function chartData(doc: SpacesDoc, period: Period, kind: ChartKind, today: string): ChartData {
  const series = typeof period.series === 'string' ? period.series : ''
  const trail: Trail = trailOf(doc)

  // the drawn window stops at today: a burndown does not draw the future.
  const last = isDay(today) && daysBetween(today, period.to) > 0 ? today : period.to
  const all = slots(trail, period.from, last, series)

  // which option ids the window actually mentions
  const seen = new Set<string>()
  for (const s of all) if (s.row) for (const k of Object.keys(s.row.n ?? {})) seen.add(k)
  const live = isDay(today) && daysBetween(period.from, today) >= 0 && daysBetween(today, period.to) >= 0
    ? observe(doc, scopeOf(period))
    : null
  if (live) for (const k of Object.keys(live.n)) seen.add(k)

  const options = optionBands(doc, seen)
  const bands: Band[] =
    kind === 'cfd' ? options
      : kind === 'burnup'
        ? [
          { id: '#done', label: t('Completed'), color: '#2FA37C' },
          { id: '#scope', label: t('Scope'), color: '#5B8DEF' },
        ]
        : [{ id: '#open', label: t('Remaining'), color: '#F7A600' }]

  // POINTS MODE, decided once for the whole chart. A chart that switched
  // between summed estimates and issue counts halfway along its own x axis
  // would be two charts drawn on one pair of axes.
  const rows = all.filter((s) => s.anchor && s.row).map((s) => s.row!)
  const points = rows.length > 0 && rows.every(hasEstimates) && (!live || !!live.e)
  const units: ChartData['units'] = points ? 'points' : 'issues'

  const valueFor = (id: string, row: { n: Record<string, number>; e?: Record<string, number> }): number => {
    if (points) {
      const e = estimateOf(row as never, id)
      return e ?? 0
    }
    return countOf(row as never, id)
  }

  const vector = (row: { n: Record<string, number>; e?: Record<string, number> }): number[] => {
    if (kind === 'cfd') return bands.map((b) => valueFor(b.id, row))
    let open = 0, done = 0
    for (const id of Object.keys(row.n ?? {})) {
      const v = valueFor(id, row)
      if (OPEN(optionById(doc, id))) open += v
      else done += v
    }
    if (kind === 'burnup') return [done, open + done]
    return [open]
  }

  // ---- runs and gaps -------------------------------------------------------
  const runs: Point[][] = []
  const gaps: Array<[string, string]> = []
  let run: Point[] = []
  let gapFrom: string | null = null
  const closeGap = (endDay: string) => {
    if (gapFrom) { gaps.push([gapFrom, endDay]); gapFrom = null }
  }
  for (const s of all) {
    if (s.kind === 'gap') {
      if (run.length) { runs.push(run); run = [] }
      gapFrom ??= s.day
      continue
    }
    closeGap(addDays(s.day, -1))
    if (!s.anchor) continue
    run.push({ day: s.day, kind: s.kind === 'sample' ? 'sample' : 'day', v: vector(s.row!) })
  }
  if (gapFrom) gaps.push([gapFrom, all[all.length - 1]?.day ?? gapFrom])
  if (run.length) runs.push(run)

  // TODAY, derived. It replaces a trail row for the same day rather than
  // sitting beside it — there is only one today.
  if (live) {
    const p: Point = { day: today, kind: 'day', v: vector(live), live: true }
    const tail = runs[runs.length - 1]
    if (tail && tail[tail.length - 1].day === today) tail[tail.length - 1] = p
    else if (tail && daysBetween(tail[tail.length - 1].day, today) === 1) tail.push(p)
    else runs.push([p])
    // a live point ends any gap that was running up to today
    if (gaps.length && gaps[gaps.length - 1][1] >= today) {
      const g = gaps[gaps.length - 1]
      if (g[0] >= today) gaps.pop()
      else g[1] = addDays(today, -1)
    }
  }

  // ---- the guides ----------------------------------------------------------
  const first = runs[0]?.[0]
  const base = period.base
  let ideal: number | undefined
  let committed: ChartData['committed']
  if (kind === 'burndown') {
    const start = points ? base?.e : base?.n
    ideal = typeof start === 'number' && Number.isFinite(start) && start > 0
      ? start
      : first ? first.v[0] : undefined
  }
  if (kind === 'burnup' && base) {
    const v = points ? base.e : base.n
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) committed = { v, at: base.at }
  }

  const lastPoint = runs[runs.length - 1]?.slice(-1)[0]
  const unestimated = lastPoint?.live
    ? (live?.x ?? 0)
    : (all.filter((s) => s.anchor && s.day === lastPoint?.day)[0]?.row?.x ?? 0)

  return {
    kind,
    from: period.from,
    to: period.to,
    bands,
    runs,
    gaps,
    ...(ideal !== undefined ? { ideal } : {}),
    ...(committed ? { committed } : {}),
    cut: wasCut(trail, series) && seriesRows(trail, series)[0]?.day >= period.from,
    unestimated: typeof unestimated === 'number' && unestimated > 0 ? unestimated : 0,
    units,
    empty: !runs.length,
  }
}

// ---- drawing ---------------------------------------------------------------

const NS = 'http://www.w3.org/2000/svg'

const el = <K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] => {
  const n = document.createElementNS(NS, tag)
  for (const k of Object.keys(attrs)) n.setAttribute(k, String(attrs[k]))
  return n
}

/**
 * A short day label — "6 Aug" — in the READER'S language.
 *
 * Through `Intl`, never a hand-written month table: the file is locale-neutral
 * and the label is rendered, exactly as `journal.ts` renders its dates. The
 * Date is built component-wise for the reason journal.ts states —
 * `new Date('2026-08-06')` is UTC midnight, i.e. the previous day for every
 * reader west of Greenwich.
 */
export function dayLabel(iso: string, loc?: string): string {
  if (!isDay(iso)) return iso
  const [y, m, d] = iso.split('-').map(Number)
  try {
    return new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric' }).format(new Date(y, m - 1, d))
  } catch {
    return iso
  }
}

function niceTop(max: number): { top: number; step: number } {
  if (!(max > 0)) return { top: 1, step: 1 }
  const raw = max / 4
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw) ?? 10 * mag
  return { top: Math.ceil(max / step) * step, step }
}

const W = 640
const H = 300
const PAD = { l: 44, r: 14, t: 14, b: 34 }

let hatchSeq = 0

export interface DrawOpts {
  /** the reader's locale, for axis labels */
  loc?: string
}

/**
 * Draw one chart.
 *
 * The svg scales to its box (`viewBox` + `width: 100%`), so the same picture
 * serves the editor, the reading view, the printed page and the file-manager
 * still — one renderer, like everything else here.
 *
 * PATTERN IDS ARE DOCUMENT-GLOBAL. `url(#…)` resolves against the whole
 * document, so two charts on one page sharing an id would paint each other's
 * hatching. Every instance mints its own, the way slides mints per-instance
 * gradient ids.
 */
export function drawChart(data: ChartData, opts: DrawOpts = {}): SVGSVGElement {
  const loc = opts.loc ?? locale()
  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'sp-chart-svg',
    role: 'img',
    preserveAspectRatio: 'xMidYMid meet',
  })
  svg.setAttribute('width', '100%')

  const days = Math.max(1, daysBetween(data.from, data.to))
  const x = (day: string) => PAD.l + (daysBetween(data.from, day) / days) * (W - PAD.l - PAD.r)

  // the top of the value axis covers every drawn value, the ideal line and the
  // committed line — a guide drawn off the top of its own chart is worse than
  // no guide.
  let max = 0
  for (const run of data.runs) {
    for (const p of run) {
      const v = data.kind === 'cfd' ? p.v.reduce((a, b) => a + b, 0) : Math.max(...p.v)
      if (v > max) max = v
    }
  }
  if (data.ideal && data.ideal > max) max = data.ideal
  if (data.committed && data.committed.v > max) max = data.committed.v
  const { top, step } = niceTop(max)
  const y = (v: number) => H - PAD.b - (v / top) * (H - PAD.t - PAD.b)

  // ---- gridlines and axes --------------------------------------------------
  for (let v = 0; v <= top + 1e-9; v += step) {
    const gy = y(v)
    svg.appendChild(el('line', {
      x1: PAD.l, y1: gy, x2: W - PAD.r, y2: gy, class: 'sp-chart-grid',
    }))
    const label = el('text', { x: PAD.l - 6, y: gy + 4, class: 'sp-chart-axis', 'text-anchor': 'end' })
    label.textContent = String(Math.round(v * 100) / 100)
    svg.appendChild(label)
  }

  // x labels, thinned so they never collide
  const every = Math.max(1, Math.ceil((days + 1) / 8))
  for (let i = 0; i <= days; i += every) {
    const day = addDays(data.from, i)
    const label = el('text', { x: x(day), y: H - PAD.b + 16, class: 'sp-chart-axis', 'text-anchor': 'middle' })
    label.textContent = dayLabel(day, loc)
    svg.appendChild(label)
  }

  // ---- gaps, drawn as gaps -------------------------------------------------
  //
  // A HATCHED BAND, not a skipped day and not a zero. A chart that quietly
  // steps over missing days implies a continuity it does not have, and a
  // carried-forward value looks exactly like data. Weekends land here too,
  // which is the other half of the argument against interpolating: an
  // interpolated weekend shows work happening on Sunday.
  if (data.gaps.length) {
    const id = `sp-hatch-${++hatchSeq}`
    const defs = el('defs')
    const pat = el('pattern', {
      id, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
    })
    pat.appendChild(el('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'sp-chart-hatch' }))
    defs.appendChild(pat)
    svg.appendChild(defs)
    for (const [a, b] of data.gaps) {
      const x0 = x(a)
      const x1 = x(b)
      const band = el('rect', {
        x: Math.min(x0, x1) - (W - PAD.l - PAD.r) / days / 2,
        y: PAD.t,
        width: Math.max(2, Math.abs(x1 - x0) + (W - PAD.l - PAD.r) / days),
        height: H - PAD.t - PAD.b,
        fill: `url(#${id})`,
        class: 'sp-chart-gap',
      })
      const title = el('title')
      title.textContent = t('Not recorded')
      band.appendChild(title)
      svg.appendChild(band)
    }
  }

  // ---- the data ------------------------------------------------------------
  if (data.kind === 'cfd') drawStacks(svg, data, x, y)
  else drawLines(svg, data, x, y)

  // ---- guides --------------------------------------------------------------
  if (data.ideal !== undefined && data.ideal > 0) {
    const line = el('line', {
      x1: x(data.from), y1: y(data.ideal), x2: x(data.to), y2: y(0), class: 'sp-chart-ideal',
    })
    const title = el('title')
    title.textContent = t('Ideal')
    line.appendChild(title)
    svg.appendChild(line)
  }
  if (data.committed) {
    const line = el('line', {
      x1: PAD.l, y1: y(data.committed.v), x2: W - PAD.r, y2: y(data.committed.v), class: 'sp-chart-committed',
    })
    const title = el('title')
    title.textContent = t('Committed on {date}', { date: dayLabel(data.committed.at, loc) })
    line.appendChild(title)
    svg.appendChild(line)
  }

  // the left edge, when older rows were dropped
  if (data.cut) {
    svg.appendChild(el('line', {
      x1: PAD.l, y1: PAD.t, x2: PAD.l, y2: H - PAD.b, class: 'sp-chart-cut',
    }))
    const label = el('text', { x: PAD.l + 4, y: PAD.t + 10, class: 'sp-chart-note' })
    label.textContent = t('Recording starts here')
    svg.appendChild(label)
  }

  // the x axis last, over the bands
  svg.appendChild(el('line', {
    x1: PAD.l, y1: H - PAD.b, x2: W - PAD.r, y2: H - PAD.b, class: 'sp-chart-axisline',
  }))
  return svg
}

/** A run's path, and whether any segment of it is a sample. */
function runPath(run: Point[], i: number, x: (d: string) => number, y: (v: number) => number): string {
  return run.map((p, j) => `${j ? 'L' : 'M'} ${x(p.day).toFixed(2)} ${y(p.v[i]).toFixed(2)}`).join(' ')
}

function drawLines(
  svg: SVGSVGElement,
  data: ChartData,
  x: (d: string) => number,
  y: (v: number) => number,
): void {
  data.bands.forEach((band, i) => {
    for (const run of data.runs) {
      if (run.length === 1) {
        // A RUN OF ONE IS STILL A READING — a day surrounded by gaps, or today
        // on its own. It gets a dot and the same tooltip every other point has;
        // it must not be the one point a reader cannot interrogate.
        const only = el('circle', { cx: x(run[0].day), cy: y(run[0].v[i]), r: 3, fill: band.color, class: 'sp-chart-dot' })
        const t0 = el('title')
        t0.textContent = `${dayLabel(run[0].day)} — ${band.label}: ${run[0].v[i]}`
        only.appendChild(t0)
        svg.appendChild(only)
        continue
      }
      // ONE PATH PER SEGMENT, because a segment's style says what its right-hand
      // point IS: a dashed segment means the reading it arrives at stands for
      // more than one day, so a weekly sample can never be mistaken for a daily
      // reading. A single path for the whole run could not say that.
      for (let j = 1; j < run.length; j++) {
        const seg = [run[j - 1], run[j]]
        const p = el('path', {
          d: runPath(seg, i, x, y),
          fill: 'none',
          stroke: band.color,
          class: seg[1].kind === 'sample' ? 'sp-chart-line sp-chart-sampled' : 'sp-chart-line',
        })
        svg.appendChild(p)
      }
      for (const p of run) {
        const dot = el('circle', {
          cx: x(p.day), cy: y(p.v[i]), r: p.kind === 'sample' ? 3.5 : 2.5, fill: band.color,
          class: p.kind === 'sample' ? 'sp-chart-dot sp-chart-sampledot' : 'sp-chart-dot',
        })
        const title = el('title')
        title.textContent = `${dayLabel(p.day)} — ${band.label}: ${p.v[i]}`
        dot.appendChild(title)
        svg.appendChild(dot)
      }
    }
  })
}

function drawStacks(
  svg: SVGSVGElement,
  data: ChartData,
  x: (d: string) => number,
  y: (v: number) => number,
): void {
  // BOTTOM-UP IN REVERSE SCHEMA ORDER, so the finished work is the floor and
  // the backlog is the ceiling — the shape every CFD is read in, where the
  // vertical distance between two boundaries is the work in that state and the
  // horizontal distance is how long it stays there.
  const order = [...data.bands].reverse()
  for (const run of data.runs) {
    if (run.length < 2) continue
    const acc = run.map(() => 0)
    for (const band of order) {
      const i = data.bands.indexOf(band)
      const lower = acc.slice()
      run.forEach((p, j) => { acc[j] += p.v[i] })
      const up = run.map((p, j) => `${j ? 'L' : 'M'} ${x(p.day).toFixed(2)} ${y(acc[j]).toFixed(2)}`).join(' ')
      const down = run
        .map((p, j) => ({ p, j }))
        .reverse()
        .map(({ p, j }) => `L ${x(p.day).toFixed(2)} ${y(lower[j]).toFixed(2)}`)
        .join(' ')
      const area = el('path', { d: `${up} ${down} Z`, fill: band.color, class: 'sp-chart-band' })
      const title = el('title')
      title.textContent = band.label
      area.appendChild(title)
      svg.appendChild(area)
    }
  }
}

// ---- the block -------------------------------------------------------------

/**
 * Render a `chart` block.
 *
 * A DANGLING `period` RENDERS AS "this chart's period is gone" AND NEVER AS AN
 * EMPTY GRAPH. Slides drops a dangling connector; here the block is kept and
 * says so, because a chart silently drawing nothing is precisely the failure
 * this whole design is about.
 */
export function renderChartBlock(
  host: HTMLElement,
  block: { kind?: unknown; period?: unknown; html?: unknown },
  doc: SpacesDoc,
  today: string,
  opts: { editable?: boolean } = {},
): void {
  const kind = chartKind(block.kind)
  const id = typeof block.period === 'string' ? block.period : ''
  const head = document.createElement('div')
  head.className = 'sp-chart-head'
  const name = document.createElement('span')
  name.className = 'sp-chart-title'
  head.appendChild(name)
  host.appendChild(head)

  const period = id ? periodOf(doc, id) : undefined

  if (!id || !period) {
    name.textContent = chartKindLabel(kind)
    const note = document.createElement('p')
    note.className = 'sp-chart-empty'
    note.textContent = id
      ? t("This chart's period is gone.")
      : t('This chart has no period yet — a chart needs a window to draw.')
    host.appendChild(note)
    if (opts.editable) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'sp-btn'
      btn.dataset.chartPeriod = ''
      btn.textContent = t('Choose a period…')
      host.appendChild(btn)
    }
    return
  }

  name.textContent = `${chartKindLabel(kind)} — ${period.label || t('Period')}`
  const range = document.createElement('span')
  range.className = 'sp-chart-range'
  range.textContent = `${dayLabel(period.from)} – ${dayLabel(period.to)}`
  head.appendChild(range)

  const data = chartData(doc, period, kind, today)
  if (data.empty) {
    const note = document.createElement('p')
    note.className = 'sp-chart-empty'
    note.textContent = t('Nothing recorded yet for this period.')
    host.appendChild(note)
    return
  }
  host.appendChild(drawChart(data))
  host.appendChild(legend(data))
  if (opts.editable) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'sp-btn sp-chart-pick'
    btn.dataset.chartPeriod = id
    btn.textContent = t('Change period…')
    host.appendChild(btn)
  }
}

/**
 * The legend, which is also where the chart says what it could NOT see.
 *
 * "Not recorded" is listed with the same weight as a band. A chart whose gaps
 * are only visible as hatching is a chart whose reader has to guess what the
 * hatching means.
 */
function legend(data: ChartData): HTMLElement {
  const box = document.createElement('div')
  box.className = 'sp-chart-legend'
  const chip = (label: string, cls: string, color?: string) => {
    const s = document.createElement('span')
    s.className = `sp-chart-key ${cls}`
    const sw = document.createElement('i')
    if (color) sw.style.background = color
    const tx = document.createElement('span')
    tx.textContent = label
    s.append(sw, tx)
    box.appendChild(s)
  }
  for (const b of data.bands) chip(b.label, 'sp-chart-keyband', b.color)
  if (data.gaps.length) chip(t('Not recorded'), 'sp-chart-keygap')
  if (data.runs.some((r) => r.some((p) => p.kind === 'sample'))) {
    chip(t('Sampled, not daily'), 'sp-chart-keysample')
  }
  const units = document.createElement('span')
  units.className = 'sp-chart-units'
  units.textContent = data.units === 'points' ? t('Estimate points') : t('Issue count')
  box.appendChild(units)
  if (data.unestimated > 0) {
    const warn = document.createElement('span')
    warn.className = 'sp-chart-units'
    warn.textContent = t('{n} with no estimate', { n: String(data.unestimated) })
    box.appendChild(warn)
  }
  return box
}

// ---- the editor's one affordance -------------------------------------------

export interface ChartWiring {
  block: (id: string) => { kind?: unknown; period?: unknown; html?: unknown } | undefined
  doc: () => SpacesDoc
  commit: (fn: () => void) => void
  repaint: () => void
  today: () => string
  /** mint an id for a new period */
  uid: () => string
}

/**
 * Wire the period button on every chart in a painted page.
 *
 * ONE affordance, and it is the only one a chart needs to be usable: which
 * window am I about? Everything else a chart could be configured with is either
 * frozen onto the period (the scope) or not a choice at all (what a burndown
 * draws). The kind is set when the block is inserted.
 *
 * Kept in this file rather than in editor.ts for the reason the canvas keeps its
 * own wiring in canvas.ts: the block, its data and its one control are one
 * feature, and editor.ts is contended by everybody.
 */
export function wireCharts(root: HTMLElement, w: ChartWiring): void {
  for (const btn of root.querySelectorAll<HTMLElement>('[data-chart-period]')) {
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      const host = btn.closest<HTMLElement>('[data-block-id]')
      const id = host?.dataset.blockId
      if (!id) return
      openPeriodMenu(btn, id, w)
    })
  }
}

function openPeriodMenu(anchor: HTMLElement, blockId: string, w: ChartWiring): void {
  document.querySelector('.sp-chart-menu')?.remove()
  const menu = document.createElement('div')
  menu.className = 'sp-chart-menu'
  const rect = anchor.getBoundingClientRect()
  menu.style.left = `${Math.round(rect.left + window.scrollX)}px`
  menu.style.top = `${Math.round(rect.bottom + window.scrollY + 4)}px`

  const pick = (periodId: string) => {
    w.commit(() => {
      const b = w.block(blockId) as { period?: string } | undefined
      if (b) b.period = periodId
    })
    menu.remove()
    w.repaint()
  }

  for (const { id, period } of periodList(w.doc())) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'sp-chart-menuitem'
    row.textContent = `${period.label || t('Period')} · ${dayLabel(period.from)} – ${dayLabel(period.to)}`
    row.addEventListener('click', () => pick(id))
    menu.appendChild(row)
  }

  const fresh = document.createElement('button')
  fresh.type = 'button'
  fresh.className = 'sp-chart-menuitem sp-chart-menunew'
  fresh.textContent = t('New two-week period from today')
  fresh.addEventListener('click', () => {
    const today = w.today()
    const id = w.uid()
    w.commit(() => {
      // The baseline is taken RIGHT NOW, from live state, and `base.at` records
      // that — so a period started on day 4 of a sprint says "committed on the
      // 4th" rather than pretending it was the 1st. No past trail key is ever
      // fabricated: the days before the record existed are gaps.
      startPeriod(w.doc(), id, {
        label: t('Period from {date}', { date: dayLabel(today) }),
        from: today,
        to: addDays(today, 13),
        today,
      })
      const b = w.block(blockId) as { period?: string } | undefined
      if (b) b.period = id
    })
    menu.remove()
    w.repaint()
  })
  menu.appendChild(fresh)

  document.body.appendChild(menu)
  const away = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener('mousedown', away) }
  }
  setTimeout(() => document.addEventListener('mousedown', away), 0)
}
