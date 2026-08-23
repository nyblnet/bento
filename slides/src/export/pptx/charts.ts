// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors

import type PptxGenJS from 'pptxgenjs'
import type { BentoDoc, ChartElement } from '../../model'
import { chartSnapshotSvg } from '../../charts'
import { pptxColor } from './color'
import type { PptxGeometry } from './geometry'
import type { ReportBuilder } from './report'
import { svgDataUri } from './svg'

type Opt = Record<string, any>

const numbers = (data: unknown) => Array.isArray(data) ? data.map((v) => Number(typeof v === 'object' && v ? (v as Opt).value : v) || 0) : []

export function addChart(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  el: ChartElement,
  _doc: BentoDoc,
  geometry: PptxGeometry,
  report: ReportBuilder,
  slideIndex: number,
) {
  const option = el.option as Opt
  const series: Opt[] = Array.isArray(option.series) ? option.series : option.series ? [option.series] : []
  const types = new Set(series.map((s) => s.type ?? 'bar'))
  const frame = geometry.frame(el)
  const common: PptxGenJS.IChartOpts = {
    ...frame,
    objectName: `bento:${el.morphId || el.id}`,
    showLegend: !!option.legend,
    legendPos: option.legend?.bottom !== undefined ? 'b' : option.legend?.top !== undefined ? 't' : 'r',
    chartColors: (option.color ?? docPalette(series.length)).map((c: string) => pptxColor(c).color),
    chartArea: { fill: { color: 'FFFFFF', transparency: 100 }, border: { color: 'FFFFFF', pt: 0 } },
    showTitle: !!option.title?.text,
    title: option.title?.text,
  }
  try {
    if (types.size === 1 && ['bar', 'line'].includes([...types][0])) {
      const labels = (option.xAxis?.data ?? []).map(String)
      const data = series.map((s) => ({ name: s.name ?? 'Series', labels, values: numbers(s.data) }))
      slide.addChart([...types][0] === 'line' ? pptx.ChartType.line : pptx.ChartType.bar, data, {
        ...common, barDir: 'col', lineSmooth: !!series[0]?.smooth,
      })
      report.editable++
      return
    }
    if (types.size === 1 && [...types][0] === 'pie' && series.length === 1) {
      const items = Array.isArray(series[0].data) ? series[0].data : []
      slide.addChart(pptx.ChartType.doughnut, [{
        name: series[0].name ?? 'Series',
        labels: items.map((v: any, i: number) => String(v?.name ?? i + 1)),
        values: numbers(items),
      }], { ...common, showPercent: true, holeSize: 50 })
      report.editable++
      return
    }
  } catch (error) {
    console.warn('Native PPTX chart export failed; using SVG.', error)
  }
  slide.addImage({ data: svgDataUri(chartSnapshotSvg(el)), ...frame, objectName: `bento:${el.morphId || el.id}` })
  report.vectorFallbacks++
  report.warn(slideIndex, 'chart-vector-fallback', el.id)
}

const docPalette = (n: number) => Array.from({ length: Math.max(n, 1) }, (_, i) => ['#5470c6', '#91cc75', '#fac858', '#ee6666'][i % 4])
