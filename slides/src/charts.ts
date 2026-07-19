// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// charts-lite: Bento's own chart engine (replaces ECharts — see git history).
//
// A `chart` element stores a plain-JSON option in the ECharts option SHAPE —
// the format is unchanged; this module interprets the subset Bento uses:
//   bar / line / pie / scatter · category+value axes with nice ticks ·
//   legend · axis/item tooltips · inside wheel-zoom + drag-pan · transitions
//   between options (same-type data tweens; cross-type staged sweep).
// Unknown option keys are ignored gracefully. Rendering is pure SVG on the
// same substrate as the rest of Bento (anim.ts drives all motion), so the
// whole engine is ~one file and every byte of it is ours (MIT).
//
// Two render paths, same API as always:
//   - chartSnapshotSvg(el): static SVG string — editor canvas, thumbs, print.
//   - mountChart(el, host, fromOption?): live instance — present mode
//     (tooltips, zoom); with fromOption, animates from that option to its own.

import { anim } from './anim'
import type { ChartElement } from './model'

type Opt = Record<string, any>

/** Presets seed new charts and let the panel swap types without data loss. */
export const CHART_PRESETS: Record<string, () => Record<string, unknown>> = {
  bar: () => ({
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0 },
    grid: { left: 56, right: 20, top: 24, bottom: 56 },
    xAxis: { type: 'category', data: ['Q1', 'Q2', 'Q3', 'Q4'] },
    yAxis: { type: 'value' },
    dataZoom: [{ type: 'inside' }],
    series: [
      { type: 'bar', name: 'Series A', data: [12, 20, 15, 28] },
      { type: 'bar', name: 'Series B', data: [8, 14, 19, 21] },
    ],
  }),
  line: () => ({
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0 },
    grid: { left: 56, right: 20, top: 24, bottom: 56 },
    xAxis: { type: 'category', data: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'] },
    yAxis: { type: 'value' },
    dataZoom: [{ type: 'inside' }],
    series: [{ type: 'line', name: 'Trend', smooth: true, areaStyle: {}, data: [4, 7, 6, 11, 14, 18] }],
  }),
  pie: () => ({
    tooltip: { trigger: 'item' },
    legend: { bottom: 0 },
    series: [{
      type: 'pie', radius: ['38%', '68%'],
      label: { formatter: '{b}: {d}%' },
      data: [
        { name: 'Alpha', value: 42 }, { name: 'Beta', value: 28 },
        { name: 'Gamma', value: 18 }, { name: 'Delta', value: 12 },
      ],
    }],
  }),
  scatter: () => ({
    tooltip: { trigger: 'item' },
    grid: { left: 56, right: 20, top: 24, bottom: 40 },
    xAxis: { type: 'value' },
    yAxis: { type: 'value' },
    dataZoom: [{ type: 'inside' }],
    series: [{
      type: 'scatter', symbolSize: 14,
      data: [[10, 8], [15, 12], [22, 10], [28, 19], [34, 15], [41, 25], [48, 22]],
    }],
  }),
}

const PALETTE = ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4']
const SVG_NS = 'http://www.w3.org/2000/svg'

// --- option digestion -------------------------------------------------------

interface YAxisCfg { name?: string; min?: number; max?: number; formatter?: string }

interface Digest {
  w: number; h: number
  font: string
  colors: string[]
  series: Array<Opt>
  categories: string[]
  isPie: boolean
  grid: { x: number; y: number; w: number; h: number }
  legend: null | { color: string }
  axisLabel: string; axisLine: string; splitLine: string
  yAxes: YAxisCfg[]      // 1 or 2 value axes; series pick one via yAxisIndex
  tooltipTrigger: 'axis' | 'item' | null
  zoomable: boolean
  labelColor: string
}

function digest(option: Opt, w: number, h: number): Digest {
  const series: Opt[] = Array.isArray(option?.series) ? option.series : option?.series ? [option.series] : []
  const isPie = series.some((s) => s?.type === 'pie')
  const g = option?.grid ?? {}
  const legend = option?.legend ? { color: option.legend?.textStyle?.color ?? '#6B7280' } : null
  const legendH = legend ? 24 : 0
  const yRaw: Opt[] = Array.isArray(option?.yAxis) ? option.yAxis : option?.yAxis ? [option.yAxis] : [{}]
  const yAxes: YAxisCfg[] = yRaw.slice(0, 2).map((a: Opt) => ({
    name: typeof a?.name === 'string' ? a.name : undefined,
    min: typeof a?.min === 'number' ? a.min : undefined,
    max: typeof a?.max === 'number' ? a.max : undefined,
    formatter: typeof a?.axisLabel?.formatter === 'string' ? a.axisLabel.formatter : undefined,
  }))
  if (!yAxes.length) yAxes.push({})
  const twoAxes = !isPie && yAxes.length > 1
  const grid = isPie
    ? { x: 0, y: 0, w, h: h - legendH }
    : {
        x: num(g.left, 48),
        y: num(g.top, 24),
        w: w - num(g.left, 48) - num(g.right, twoAxes ? 56 : 16),
        h: h - num(g.top, 24) - num(g.bottom, 44),
      }
  return {
    w, h,
    font: option?.textStyle?.fontFamily ?? 'sans-serif',
    colors: Array.isArray(option?.color) && option.color.length ? option.color : PALETTE,
    series, isPie,
    categories: (option?.xAxis?.data ?? []).map(String),
    grid,
    legend,
    axisLabel: option?.xAxis?.axisLabel?.color ?? yRaw[0]?.axisLabel?.color ?? '#6B7280',
    axisLine: option?.xAxis?.axisLine?.lineStyle?.color ?? 'rgba(110,120,135,0.45)',
    splitLine: yRaw[0]?.splitLine?.lineStyle?.color ?? 'rgba(110,120,135,0.15)',
    yAxes,
    tooltipTrigger: option?.tooltip ? (option.tooltip.trigger === 'item' ? 'item' : 'axis') : null,
    zoomable: Array.isArray(option?.dataZoom) && option.dataZoom.length > 0,
    labelColor: series.find((s) => s?.type === 'pie')?.label?.color ?? '#6B7280',
  }
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** Nice tick values for a 0..max (or min..max) range. */
function niceTicks(min: number, max: number, target = 5): number[] {
  if (max === min) max = min + 1
  const span = max - min
  const step0 = Math.pow(10, Math.floor(Math.log10(span / target)))
  const err = span / target / step0
  const step = step0 * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1)
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const out: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6)
  return out
}

const fmt = (v: number): string =>
  Math.abs(v) >= 1000 ? String(Math.round(v * 100) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(Math.round(v * 100) / 100)

/** Nearest "nice" number (1/2/5 × 10^n) to x. */
function niceNum(x: number, round: boolean): number {
  if (!(x > 0)) return 1
  const exp = Math.floor(Math.log10(x))
  const f = x / Math.pow(10, exp)
  const nf = round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10)
  return nf * Math.pow(10, exp)
}

const linspace = (a: number, b: number, n: number): number[] =>
  Array.from({ length: n }, (_, i) => a + (b - a) * (i / (n - 1)))

/** Exactly `intervals`+1 evenly spaced nice ticks covering lo0..hi0 (lo0 kept as base). */
function fixedTicks(lo0: number, hi0: number, intervals: number): number[] {
  const iv = Math.max(1, intervals)
  let step = niceNum((hi0 - lo0) / iv, false) || 1
  let guard = 0
  while (lo0 + step * iv < hi0 && guard++ < 20) step = niceNum(step * 1.5, false)
  return Array.from({ length: iv + 1 }, (_, i) => Math.round((lo0 + step * i) * 1e6) / 1e6)
}

/** Range + tick labels for one value axis. `forceCount` aligns a 2nd axis to the 1st. */
function axisRange(values: number[], cfg: YAxisCfg, forceCount?: number): { lo: number; hi: number; labels: string[] } {
  let minV = 0, maxV = 0
  for (const v of values) { if (v > maxV) maxV = v; if (v < minV) minV = v }
  const loBase = cfg.min != null ? cfg.min : Math.min(0, minV)
  const hiBase = cfg.max != null ? cfg.max : (maxV || 1)
  const overridden = cfg.min != null || cfg.max != null
  let ticks: number[]
  if (forceCount) ticks = overridden ? linspace(loBase, hiBase, forceCount) : fixedTicks(loBase, hiBase, forceCount - 1)
  else ticks = overridden ? linspace(loBase, hiBase, 6) : niceTicks(loBase, hiBase)
  const apply = (v: number) => (cfg.formatter ? cfg.formatter.replace('{value}', fmt(v)) : fmt(v))
  return { lo: ticks[0], hi: ticks[ticks.length - 1], labels: ticks.map(apply) }
}

// --- svg helpers ------------------------------------------------------------

function elNS<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v))
  return n
}

function text(x: number, y: number, s: string, fill: string, font: string, size = 12, anchor = 'middle'): SVGTextElement {
  const t = elNS('text', { x, y, fill, 'font-size': size, 'text-anchor': anchor, 'font-family': font })
  t.textContent = s
  return t
}

let gradSeq = 0
function seriesFill(svg: SVGSVGElement, s: Opt, fallback: string): string {
  const c = s?.areaStyle?.color ?? s?.itemStyle?.color
  if (c && typeof c === 'object' && Array.isArray(c.colorStops)) {
    const id = `bc-g${++gradSeq}`
    const lg = elNS('linearGradient', {
      id, x1: num(c.x, 0), y1: num(c.y, 0), x2: num(c.x2, 0), y2: num(c.y2, 1),
    })
    for (const st of c.colorStops) {
      lg.appendChild(elNS('stop', { offset: num(st.offset, 0), 'stop-color': st.color ?? fallback }))
    }
    let defs = svg.querySelector('defs')
    if (!defs) { defs = elNS('defs', {}); svg.prepend(defs) }
    defs.appendChild(lg)
    return `url(#${id})`
  }
  return typeof c === 'string' ? c : fallback
}

// --- core renderer ----------------------------------------------------------

interface View { start: number; end: number } // x-domain window, 0..1

/**
 * Render `option` into a fresh <svg>. `sweep` (0..1) grows series in — used
 * by entrance/cross-type transitions. `view` is the zoom window.
 */
function renderChart(option: Opt, w: number, h: number, sweep = 1, view: View = { start: 0, end: 1 }): SVGSVGElement {
  const d = digest(option, w, h)
  const svg = elNS('svg', { xmlns: SVG_NS, viewBox: `0 0 ${w} ${h}`, width: w, height: h })
  svg.style.cssText = 'width:100%;height:100%;display:block'

  if (d.isPie) renderPie(svg, d, option, sweep)
  else renderCartesian(svg, d, sweep, view)

  if (d.legend && d.series.some((s) => s?.name || s?.type === 'pie')) renderLegend(svg, d)
  return svg
}

function renderLegend(svg: SVGSVGElement, d: Digest) {
  const pie = d.series.find((s) => s?.type === 'pie')
  const items: Array<{ name: string; color: string }> = pie
    ? (pie.data ?? []).map((p: Opt, i: number) => ({ name: String(p?.name ?? i), color: d.colors[i % d.colors.length] }))
    : d.series.map((s, i) => ({ name: String(s?.name ?? `Series ${i + 1}`), color: typeof s?.itemStyle?.color === 'string' ? s.itemStyle.color : typeof s?.lineStyle?.color === 'string' ? s.lineStyle.color : d.colors[i % d.colors.length] }))
  const iw = items.map((it) => 14 + 5 + it.name.length * 6.6 + 16)
  const total = iw.reduce((a, b) => a + b, 0)
  let x = Math.max(8, (d.w - total) / 2)
  const y = d.h - 12
  for (let i = 0; i < items.length; i++) {
    svg.appendChild(elNS('rect', { x, y: y - 9, width: 14, height: 10, rx: 3, fill: items[i].color }))
    svg.appendChild(text(x + 19, y, items[i].name, d.legend!.color, d.font, 12, 'start'))
    x += iw[i]
  }
}

function catWindow(d: Digest, view: View): { cats: string[]; i0: number } {
  const n = Math.max(1, d.categories.length)
  const i0 = Math.min(n - 1, Math.floor(view.start * n))
  const i1 = Math.max(i0 + 1, Math.ceil(view.end * n))
  return { cats: d.categories.slice(i0, i1), i0 }
}

function renderCartesian(svg: SVGSVGElement, d: Digest, sweep: number, view: View) {
  const G = d.grid
  const bars = d.series.filter((s) => s?.type === 'bar')
  const lines = d.series.filter((s) => s?.type === 'line')
  const scatters = d.series.filter((s) => s?.type === 'scatter')

  const { cats, i0 } = catWindow(d, view)
  const nCat = Math.max(1, cats.length)

  // ----- value axes (1 or 2); gridlines align, labels on left & right --------
  const nAxes = d.yAxes.length
  const axisOf = (s: Opt) => Math.min(nAxes - 1, Math.max(0, Math.round(num(s?.yAxisIndex, 0))))
  const perAxis: number[][] = Array.from({ length: nAxes }, () => [])
  for (const s of [...bars, ...lines]) {
    const data: number[] = (s.data ?? []).slice(i0, i0 + nCat).map((v: unknown) => num(v, 0))
    perAxis[axisOf(s)].push(...data)
  }
  let sMinX = Infinity, sMaxX = -Infinity
  for (const s of scatters) {
    for (const p of s.data ?? []) {
      const [px, py] = Array.isArray(p) ? p : [0, 0]
      if (px < sMinX) sMinX = px
      if (px > sMaxX) sMaxX = px
      perAxis[0].push(py)
    }
  }
  const r0 = axisRange(perAxis[0], d.yAxes[0])
  const k = r0.labels.length
  const ranges: Array<ReturnType<typeof axisRange> | null> = [r0, nAxes > 1 ? axisRange(perAxis[1], d.yAxes[1], k) : null]
  const yOf = (v: number, a = 0) => {
    const r = ranges[a] ?? r0
    return G.y + G.h - ((v - r.lo) / (r.hi - r.lo || 1)) * G.h
  }
  const baseOf = (a = 0) => yOf((ranges[a] ?? r0).lo, a)

  // shared gridlines at k evenly spaced rows; labels on the matching side(s)
  for (let j = 0; j < k; j++) {
    const y = G.y + G.h - (j / Math.max(1, k - 1)) * G.h
    svg.appendChild(elNS('line', { x1: G.x, y1: y, x2: G.x + G.w, y2: y, stroke: d.splitLine, 'stroke-width': 1 }))
    svg.appendChild(text(G.x - 8, y + 4, r0.labels[j], d.axisLabel, d.font, 12, 'end'))
    if (ranges[1]) svg.appendChild(text(G.x + G.w + 8, y + 4, ranges[1].labels[j], d.axisLabel, d.font, 12, 'start'))
  }
  if (d.yAxes[0]?.name) svg.appendChild(text(G.x - 8, G.y - 9, d.yAxes[0].name, d.axisLabel, d.font, 11, 'end'))
  if (ranges[1] && d.yAxes[1]?.name) svg.appendChild(text(G.x + G.w + 8, G.y - 9, d.yAxes[1].name, d.axisLabel, d.font, 11, 'start'))

  // x axis line
  svg.appendChild(elNS('line', { x1: G.x, y1: G.y + G.h, x2: G.x + G.w, y2: G.y + G.h, stroke: d.axisLine, 'stroke-width': 1 }))

  if (scatters.length && !d.categories.length) {
    // value x-axis (scatter)
    const xt = niceTicks(sMinX === Infinity ? 0 : Math.min(0, sMinX), sMaxX === -Infinity ? 1 : sMaxX)
    const span = xt[xt.length - 1] - xt[0]
    const vx0 = xt[0] + span * view.start
    const vx1 = xt[0] + span * view.end
    const xOf = (v: number) => G.x + ((v - vx0) / (vx1 - vx0)) * G.w
    for (const tv of xt) {
      if (tv < vx0 || tv > vx1) continue
      svg.appendChild(text(xOf(tv), G.y + G.h + 18, fmt(tv), d.axisLabel, d.font, 12))
    }
    scatters.forEach((s, si) => {
      const color = typeof s?.itemStyle?.color === 'string' ? s.itemStyle.color : d.colors[si % d.colors.length]
      const r = num(s.symbolSize, 10) / 2
      for (const p of s.data ?? []) {
        const [px, py] = Array.isArray(p) ? p : [0, 0]
        const cx = xOf(px)
        if (cx < G.x - r || cx > G.x + G.w + r) continue
        const c = elNS('circle', { cx, cy: yOf(py), r: r * sweep, fill: color, opacity: 0.85 })
        ;(c as any).__tip = { title: '', rows: [{ name: `${fmt(px)}, ${fmt(py)}`, color }] }
        svg.appendChild(c)
      }
    })
    return
  }

  // category x labels (thinned)
  const band = G.w / nCat
  const step = Math.ceil(nCat / Math.max(1, Math.floor(G.w / 56)))
  cats.forEach((c, i) => {
    if (i % step) return
    svg.appendChild(text(G.x + band * (i + 0.5), G.y + G.h + 18, c, d.axisLabel, d.font, 12))
  })

  // bars
  const m = bars.length
  if (m) {
    const groupW = band * 0.62
    const barW = groupW / m
    bars.forEach((s, si) => {
      const ax = axisOf(s)
      const base = baseOf(ax)
      const color = typeof s?.itemStyle?.color === 'string' ? s.itemStyle.color : d.colors[d.series.indexOf(s) % d.colors.length]
      const radius = Array.isArray(s?.itemStyle?.borderRadius) ? num(s.itemStyle.borderRadius[0], 0) : num(s?.itemStyle?.borderRadius, 0)
      const data: number[] = (s.data ?? []).slice(i0, i0 + nCat).map((v: unknown) => num(v, 0))
      data.forEach((v, i) => {
        const x = G.x + band * i + (band - groupW) / 2 + barW * si
        const hv = (base - yOf(v, ax)) * sweep
        const r = elNS('rect', {
          x: x + 1, y: base - hv, width: Math.max(1, barW - 2), height: Math.max(0, hv),
          rx: Math.min(radius, barW / 2), fill: color,
        })
        ;(r as any).__cat = i
        ;(r as any).__tip = { title: cats[i], rows: [{ name: String(s.name ?? ''), value: fmt(v), color }] }
        svg.appendChild(r)
      })
    })
  }

  // lines
  lines.forEach((s) => {
    const si = d.series.indexOf(s)
    const ax = axisOf(s)
    const stroke = typeof s?.lineStyle?.color === 'string' ? s.lineStyle.color : d.colors[si % d.colors.length]
    const width = num(s?.lineStyle?.width, 2)
    const data: number[] = (s.data ?? []).slice(i0, i0 + nCat).map((v: unknown) => num(v, 0))
    const pts = data.map((v, i) => [G.x + band * (i + 0.5), yOf(v, ax)] as [number, number])
    if (pts.length < 2) return
    let path = `M ${pts[0][0]} ${pts[0][1]}`
    if (s.smooth) {
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)]
        const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6
        const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6
        path += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2[0]} ${p2[1]}`
      }
    } else {
      for (let i = 1; i < pts.length; i++) path += ` L ${pts[i][0]} ${pts[i][1]}`
    }
    if (s.areaStyle) {
      const fill = seriesFill(svg, s, stroke)
      const area = elNS('path', {
        d: `${path} L ${pts[pts.length - 1][0]} ${baseOf(ax)} L ${pts[0][0]} ${baseOf(ax)} Z`,
        fill, opacity: s.areaStyle.color ? 1 : 0.25,
      })
      svg.appendChild(area)
    }
    const line = elNS('path', { d: path, fill: 'none', stroke, 'stroke-width': width, 'stroke-linecap': 'round' })
    if (sweep < 1) {
      const len = 2000
      line.setAttribute('stroke-dasharray', String(len))
      line.setAttribute('stroke-dashoffset', String(len * (1 - sweep)))
    }
    svg.appendChild(line)
    if (s.symbol !== 'none') {
      pts.forEach(([cx, cy], i) => {
        const c = elNS('circle', { cx, cy, r: 3.5, fill: stroke, opacity: sweep })
        ;(c as any).__cat = i
        ;(c as any).__tip = { title: cats[i], rows: [{ name: String(s.name ?? ''), value: fmt(data[i]), color: stroke }] }
        svg.appendChild(c)
      })
    }
  })

  // invisible per-category hit bands for axis tooltips
  if (d.tooltipTrigger === 'axis') {
    for (let i = 0; i < nCat; i++) {
      const band_ = elNS('rect', { x: G.x + band * i, y: G.y, width: band, height: G.h, fill: 'transparent' })
      ;(band_ as any).__cat = i
      svg.appendChild(band_)
    }
  }
}

function renderPie(svg: SVGSVGElement, d: Digest, _option: Opt, sweep: number) {
  const s = d.series.find((x) => x?.type === 'pie')!
  const data: Array<{ name: string; value: number }> = (s.data ?? []).map((p: Opt, i: number) => ({
    name: String(p?.name ?? i), value: Math.max(0, num(p?.value, 0)),
  }))
  const total = data.reduce((a, b) => a + b.value, 0) || 1
  const cx = d.grid.w / 2
  const cy = d.grid.h / 2
  const R = Math.min(d.grid.w, d.grid.h) / 2
  const [ri, ro] = (Array.isArray(s.radius) ? s.radius : ['0%', s.radius ?? '70%']).map(
    (r: string | number) => (typeof r === 'string' ? (parseFloat(r) / 100) * R : r),
  )
  const border = s?.itemStyle?.borderColor
  const bw = num(s?.itemStyle?.borderWidth, 0)
  const labelFmt: string | null = s?.label === false ? null : (s?.label?.formatter ?? '{b}')

  let a0 = -Math.PI / 2
  const sweepEnd = -Math.PI / 2 + Math.PI * 2 * sweep
  data.forEach((p, i) => {
    const frac = p.value / total
    let a1 = a0 + frac * Math.PI * 2
    const clip0 = Math.min(a0, sweepEnd)
    const clip1 = Math.min(a1, sweepEnd)
    const color = d.colors[i % d.colors.length]
    if (clip1 > clip0 + 0.0001) {
      svg.appendChild(arcPath(cx, cy, ri, ro, clip0, clip1, color, border, bw, {
        title: '', rows: [{ name: p.name, value: `${fmt(p.value)} (${Math.round((frac) * 1000) / 10}%)`, color }],
      }))
    }
    // labels only at full sweep
    if (sweep >= 1 && labelFmt) {
      const mid = (a0 + a1) / 2
      const lx = cx + Math.cos(mid) * (ro + 12)
      const ly = cy + Math.sin(mid) * (ro + 12)
      const right = Math.cos(mid) >= 0
      const label = labelFmt
        .replaceAll('{b}', p.name)
        .replaceAll('{c}', fmt(p.value))
        .replaceAll('{d}', String(Math.round(frac * 1000) / 10))
      svg.appendChild(elNS('line', {
        x1: cx + Math.cos(mid) * ro, y1: cy + Math.sin(mid) * ro, x2: lx, y2: ly,
        stroke: color, 'stroke-width': 1,
      }))
      svg.appendChild(text(lx + (right ? 4 : -4), ly + 4, label, d.labelColor, d.font, 12, right ? 'start' : 'end'))
    }
    a0 = a1
  })
}

function arcPath(
  cx: number, cy: number, ri: number, ro: number, a0: number, a1: number,
  fill: string, border: string | undefined, bw: number, tip: unknown,
): SVGPathElement {
  const large = a1 - a0 > Math.PI ? 1 : 0
  const p = (r: number, a: number) => `${cx + Math.cos(a) * r} ${cy + Math.sin(a) * r}`
  const dstr =
    `M ${p(ro, a0)} A ${ro} ${ro} 0 ${large} 1 ${p(ro, a1)} ` +
    (ri > 0 ? `L ${p(ri, a1)} A ${ri} ${ri} 0 ${large} 0 ${p(ri, a0)} Z` : `L ${cx} ${cy} Z`)
  const path = elNS('path', { d: dstr, fill })
  if (border && bw) { path.setAttribute('stroke', border); path.setAttribute('stroke-width', String(bw)) }
  ;(path as any).__tip = tip
  return path
}

// --- public API -------------------------------------------------------------

const snapshotCache = new Map<string, string>()

/** Static SVG snapshot (string) for canvas/thumbnails/print. */
export function chartSnapshotSvg(el: ChartElement): string {
  const key = `${el.w}x${el.h}:${JSON.stringify(el.option)}`
  const hit = snapshotCache.get(key)
  if (hit) return hit
  let out: string
  try {
    out = new XMLSerializer().serializeToString(renderChart(el.option as Opt, el.w, el.h))
  } catch {
    out = `<svg xmlns="${SVG_NS}"></svg>`
  }
  if (snapshotCache.size > 60) snapshotCache.clear()
  snapshotCache.set(key, out)
  return out
}

/** Numeric-leaf interpolation between two same-shape options. */
function lerpOption(a: any, b: any, t: number): any {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return b.map((v, i) => lerpOption(a[i], v, t))
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Opt = { ...b }
    for (const k of Object.keys(b)) if (k in a) out[k] = lerpOption(a[k], b[k], t)
    return out
  }
  return t < 1 ? a ?? b : b
}

const sameShape = (a: Opt, b: Opt): boolean => {
  const ta = (a?.series ?? []).map((s: Opt) => s?.type).join()
  const tb = (b?.series ?? []).map((s: Opt) => s?.type).join()
  return ta === tb
}

/**
 * Live chart for present mode. Returns a dispose handle. With `fromOption`,
 * the chart animates from that state to its own: same series types tween
 * their values in place; a type change (bar⇄pie) plays a staged sweep.
 */
export function mountChart(el: ChartElement, host: HTMLElement, fromOption?: Record<string, unknown>): () => void {
  host.innerHTML = ''
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
  const w = el.w, h = el.h
  const option = el.option as Opt
  const view: View = { start: 0, end: 1 }
  let disposed = false
  const clock = { t: 0 } // tween target — killed via killTweensOf(clock)

  const draw = (opt: Opt, sweep = 1) => {
    if (disposed) return
    host.querySelector('svg')?.remove()
    const svg = renderChart(opt, w, h, sweep, view)
    host.prepend(svg)
    wireTooltips(svg, opt)
  }

  // tooltip overlay — FIXED to the viewport and parented to <body>, so it is
  // immune to the slide's transform scale and to sibling stacking order
  const tipEl = document.createElement('div')
  tipEl.style.cssText =
    'position:fixed;pointer-events:none;z-index:10000;display:none;background:rgba(18,26,40,0.92);color:#fff;' +
    'font-size:12px;line-height:1.5;padding:6px 10px;border-radius:6px;white-space:nowrap;transform:translate(-50%,-110%)'
  document.body.appendChild(tipEl)

  const digestNow = () => digest(option, w, h)

  function wireTooltips(svg: SVGSVGElement, opt: Opt) {
    const d = digest(opt, w, h)
    if (!d.tooltipTrigger) return
    svg.addEventListener('mousemove', (ev) => {
      const target = ev.target as Element & { __tip?: any; __cat?: number }
      if (d.tooltipTrigger === 'axis' && typeof target.__cat === 'number') {
        const { cats, i0 } = catWindow(d, view)
        const i = target.__cat
        const rows = d.series
          .filter((s) => s.type !== 'pie')
          .map((s, si) => ({
            name: String(s.name ?? `#${si + 1}`),
            value: fmt(num((s.data ?? [])[i0 + i], 0)),
            color: typeof s?.itemStyle?.color === 'string' ? s.itemStyle.color : d.colors[si % d.colors.length],
          }))
        showTip(cats[i] ?? '', rows, ev.clientX, ev.clientY)
      } else if (target.__tip) {
        showTip(target.__tip.title, target.__tip.rows, ev.clientX, ev.clientY)
      } else if (d.tooltipTrigger === 'item') {
        tipEl.style.display = 'none'
      }
    })
    svg.addEventListener('mouseleave', () => { tipEl.style.display = 'none' })
  }

  function showTip(title: string, rows: Array<{ name: string; value?: string; color: string }>, x: number, y: number) {
    // in fullscreen, only the fullscreened element's subtree paints — the
    // tip must live inside it (fixed coords stay viewport-correct)
    const tipHost = document.fullscreenElement ?? document.body
    if (tipEl.parentElement !== tipHost) tipHost.appendChild(tipEl)
    tipEl.innerHTML =
      (title ? `<b>${escapeHtml(title)}</b><br>` : '') +
      rows.map((r) =>
        `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${r.color};margin-right:5px"></span>` +
        `${escapeHtml(r.name)}${r.value !== undefined ? `: <b>${escapeHtml(r.value)}</b>` : ''}`,
      ).join('<br>')
    tipEl.style.display = 'block'
    // clamp within the viewport; flip below the cursor near the top edge
    const tw = tipEl.offsetWidth
    const cx = Math.max(tw / 2 + 6, Math.min(window.innerWidth - tw / 2 - 6, x))
    const th = tipEl.offsetHeight
    const above = y - th - 14 >= 4
    tipEl.style.transform = above ? 'translate(-50%,-110%)' : 'translate(-50%,14px)'
    tipEl.style.left = `${cx}px`
    tipEl.style.top = `${y - (above ? 6 : 0)}px`
  }

  // inside dataZoom: wheel to zoom, drag to pan
  if (digestNow().zoomable && !digestNow().isPie) {
    host.addEventListener('wheel', (ev) => {
      ev.preventDefault()
      const span = view.end - view.start
      const rect = host.getBoundingClientRect()
      const fx = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width))
      const factor = ev.deltaY > 0 ? 1.18 : 1 / 1.18
      const newSpan = Math.min(1, Math.max(0.1, span * factor))
      const anchor = view.start + span * fx
      view.start = Math.max(0, anchor - newSpan * fx)
      view.end = Math.min(1, view.start + newSpan)
      view.start = Math.max(0, view.end - newSpan)
      draw(option)
    }, { passive: false })
    let panFrom: { x: number; s: number; e: number } | null = null
    host.addEventListener('mousedown', (ev) => { panFrom = { x: ev.clientX, s: view.start, e: view.end } })
    window.addEventListener('mousemove', (ev) => {
      if (!panFrom || disposed) return
      const rect = host.getBoundingClientRect()
      const dx = (ev.clientX - panFrom.x) / rect.width
      const span = panFrom.e - panFrom.s
      let s = panFrom.s - dx * span
      s = Math.max(0, Math.min(1 - span, s))
      view.start = s
      view.end = s + span
      draw(option)
    })
    window.addEventListener('mouseup', () => { panFrom = null })
  }

  // entrance / transition
  if (fromOption && JSON.stringify(fromOption) !== JSON.stringify(option)) {
    if (sameShape(fromOption as Opt, option)) {
      anim.to(clock, {
        t: 1, duration: 0.65, ease: 'power2.inOut',
        onUpdate: () => draw(lerpOption(fromOption, option, clock.t)),
      } as any)
    } else {
      // staged: hold old frame briefly, then sweep the new type in
      draw(fromOption as Opt)
      anim.to(clock, {
        t: 1, duration: 0.8, delay: 0.05, ease: 'power2.inOut',
        onUpdate: () => {
          const t = clock.t
          if (t < 0.3) {
            const s = host.querySelector('svg')
            if (s) (s as SVGElement).style.opacity = String(1 - t / 0.3)
          } else {
            draw(option, (t - 0.3) / 0.7)
          }
        },
      } as any)
    }
  } else {
    draw(option)
  }

  ;(host as HTMLElement & { __bentoChart?: unknown }).__bentoChart = { option, redraw: () => draw(option), view }

  return () => {
    disposed = true
    anim.killTweensOf(clock)
    tipEl.remove()
    delete (host as HTMLElement & { __bentoChart?: unknown }).__bentoChart
    host.innerHTML = ''
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
