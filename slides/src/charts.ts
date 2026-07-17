// ECharts integration. A `chart` element stores a plain-JSON ECharts option in
// the document; this module renders it two ways:
//   - chartSnapshotSvg(el): a static SVG string (SSR mode) — used by the
//     editor canvas, sidebar thumbnails and print, so those surfaces stay
//     cheap, crisp at any scale, and drag-friendly.
//   - mountChart(el, host): a live instance — used in present mode, where
//     tooltips, dataZoom and legend interactivity actually run.
// Only the SVG renderer and a curated set of charts/components are bundled;
// options must stay pure JSON (template-string formatters, no functions).

import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import {
  DatasetComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { ChartElement } from './model'

echarts.use([
  BarChart, LineChart, PieChart, ScatterChart,
  DatasetComponent, DataZoomComponent, GridComponent,
  LegendComponent, TitleComponent, TooltipComponent,
  SVGRenderer,
])

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
    dataZoom: [{ type: 'inside' }, { type: 'inside', orient: 'vertical' }],
    series: [{
      type: 'scatter', symbolSize: 14,
      data: [[10, 8], [15, 12], [22, 10], [28, 19], [34, 15], [41, 25], [48, 22]],
    }],
  }),
}

/** Live instance for present mode. Returns a dispose handle. */
export function mountChart(el: ChartElement, host: HTMLElement): () => void {
  host.innerHTML = ''
  const inst = echarts.init(host, undefined, { renderer: 'svg', width: el.w, height: el.h })
  try {
    inst.setOption(el.option as never)
  } catch {
    host.textContent = '⚠ invalid chart option'
  }
  // scripting/diagnostics hook, like window.bento.anim
  ;(host as HTMLElement & { __bentoChart?: unknown }).__bentoChart = inst
  return () => {
    delete (host as HTMLElement & { __bentoChart?: unknown }).__bentoChart
    inst.dispose()
  }
}

// Snapshots are pure functions of (option, w, h) — cache across re-renders
// (thumbnails re-render often). Keep the cache bounded.
const snapCache = new Map<string, string>()

/** Static SVG markup for editor canvas / thumbnails / print. */
export function chartSnapshotSvg(el: ChartElement): string {
  const key = `${el.w}x${el.h}:${JSON.stringify(el.option)}`
  const hit = snapCache.get(key)
  if (hit) return hit
  let svg = ''
  try {
    const inst = echarts.init(null as never, undefined, {
      renderer: 'svg', ssr: true, width: el.w, height: el.h,
    })
    inst.setOption({ ...(el.option as object), animation: false } as never)
    svg = inst.renderToSVGString()
    inst.dispose()
  } catch {
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${el.w}" height="${el.h}"><text x="12" y="24" fill="#c9302c" font-size="14">⚠ invalid chart option</text></svg>`
  }
  if (snapCache.size > 100) snapCache.clear()
  snapCache.set(key, svg)
  return svg
}
