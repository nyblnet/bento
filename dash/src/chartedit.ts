// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The chart editor — in the properties panel while the chart is the thing being
// worked on, the way slides' panel becomes a chart's when a chart is selected
// (slides panels.ts `buildChartProps`): Type, then the series list with a colour
// and a remove each, then what slides calls the axis.
//
// THE DIFFERENCE FROM SLIDES IS THE DATA, and it is the whole of dash's chart
// argument. A slides chart owns a grid of numbers; a dash chart owns COLUMN IDS
// and reads the numbers from the sheet (chart.ts, top of file). So there is no
// data grid here, and a series is added by picking a COLUMN, never by typing a
// value — the chart cannot disagree with the sheet beside it.
//
// Every control writes a whole new binding through `set`, which main.ts mirrors
// into `doc.chart` as one patch: one change, one undo.

import type { TableSheet } from './model.ts'
import './chartedit.css'
import type { PanelKit } from './cellprops.ts'
import { axisFormat, chartHeading, isOrdered, lineRefused, type ChartBinding } from './chart.ts'
import { t } from './i18n.ts'

const PALETTE = ['#F7A600', '#5B8DEF', '#2FB47C', '#E1616C', '#8B6FD3', '#3FA9B8']

const MEASURE = new Set(['number', 'money', 'percent'])

export interface ChartEditHost {
  host: HTMLElement
  kit: PanelKit
  sheet: TableSheet
  binding: ChartBinding
  readOnly: boolean
  /** write the next binding */
  set(next: ChartBinding): void
}

const kindLabel = (k: ChartBinding['kind']): string =>
  k === 'bar' ? t('Bar') : k === 'line' ? t('Line') : k === 'pie' ? t('Pie') : t('Scatter')

const aggLabel = (a: NonNullable<ChartBinding['aggregate']>): string =>
  a === 'sum' ? t('Sum') : a === 'avg' ? t('Average') : a === 'count' ? t('Count') : t('None — one point per row')

/** Draw the editor. Rebuilt whole from the binding on every document event. */
export function buildChartEditor(o: ChartEditHost): void {
  const { host, kit, sheet } = o
  const b = o.binding
  const ro = o.readOnly
  const nameOf = (id: string): string => sheet.columns.find((c) => c.id === id)?.name ?? id
  const set = (patch: Partial<ChartBinding>, drop: Array<keyof ChartBinding> = []): void => {
    if (ro) return
    const next: ChartBinding = { ...b, series: [...b.series], ...patch }
    for (const k of drop) delete next[k]
    o.set(next)
  }
  const disable = <E extends HTMLInputElement | HTMLSelectElement>(e: E): E => { e.disabled = ro; return e }

  kit.section(host, t('Chart'))
  const kinds: Array<ChartBinding['kind']> = ['bar', 'line', 'pie', 'scatter']
  const type = disable(kit.select(kinds.map((k) => [k, kindLabel(k)] as const), b.kind, (v) => {
    // Choosing another type forgets a permission given for the line: "draw a
    // line anyway" was said about a line, and a pie that later becomes a line
    // again has to be asked again.
    set({ kind: v as ChartBinding['kind'] }, ['allowLine'])
  }))
  type.classList.add('dce-type')
  kit.row(host, t('Type'), type)
  if (lineRefused(sheet, b)) {
    // The ACTION is on the chart itself ("Draw a line anyway", chart.ts), where
    // the bars it explains are — and where it still is with the panel shut.
    kit.note(host, t('{col} has no order, so a line between its categories would draw a trend that is not there. Drawn as bars.', { col: nameOf(b.x) }))
  }

  const title = disable(kit.text(b.title ?? '', (v) => {
    const s = v.trim()
    if (s) set({ title: s }); else set({}, ['title'])
  }))
  title.placeholder = chartHeading(sheet, { ...b, title: undefined })
  title.classList.add('dce-title')
  kit.row(host, t('Title'), title)

  const cats = disable(kit.select(
    sheet.columns.filter((c) => !b.series.includes(c.id)).map((c) => [c.id, c.name] as const),
    b.x,
    (v) => set({ x: v }, ['allowLine'])))
  cats.classList.add('dce-x')
  kit.row(host, t('Categories'), cats)

  const aggs: Array<NonNullable<ChartBinding['aggregate']>> = ['sum', 'avg', 'count', 'none']
  const agg = disable(kit.select(aggs.map((a) => [a, aggLabel(a)] as const), b.aggregate ?? 'sum',
    (v) => set({ aggregate: v as ChartBinding['aggregate'] })))
  agg.classList.add('dce-agg')
  kit.row(host, t('Summarise'), agg)

  const legend = kit.check(b.legend ?? b.series.length > 1, (v) => set({ legend: v }))
  legend.disabled = ro
  legend.classList.add('dce-legend')
  kit.row(host, t('Legend'), legend)

  // --- series -----------------------------------------------------------------
  kit.section(host, t('Series'))
  if (b.kind === 'pie' && b.series.length > 1) {
    kit.note(host, t('A pie shows one series — the first.'))
  }
  b.series.forEach((id, i) => {
    const row = document.createElement('div')
    row.className = 'dce-series'
    row.dataset.col = id
    const name = document.createElement('span')
    name.className = 'dce-series-name'
    name.textContent = nameOf(id)
    const colour = document.createElement('input')
    colour.type = 'color'
    colour.className = 'dce-colour'
    colour.value = b.colors?.[id] ?? PALETTE[i % PALETTE.length]
    colour.disabled = ro || b.kind === 'pie'
    colour.title = t('Colour of {name}', { name: nameOf(id) })
    colour.setAttribute('aria-label', colour.title)
    colour.addEventListener('change', () => set({ colors: { ...(b.colors ?? {}), [id]: colour.value } }))
    const rm = document.createElement('button')
    rm.type = 'button'
    rm.className = 'dce-rm'
    rm.textContent = '✕'
    rm.title = t('Remove {name}', { name: nameOf(id) })
    rm.setAttribute('aria-label', rm.title)
    // The last series stays: a chart of no series is an axis with nothing on
    // it, which reads as a chart of zeroes. Closing the chart is the way out.
    rm.disabled = ro || b.series.length < 2
    rm.addEventListener('click', () => {
      const colors = { ...(b.colors ?? {}) }
      delete colors[id]
      const next: Partial<ChartBinding> = { series: b.series.filter((s) => s !== id) }
      if (Object.keys(colors).length) set({ ...next, colors }); else set(next, ['colors'])
    })
    row.append(colour, name, rm)
    host.append(row)
  })
  if (!ro) {
    const left = sheet.columns.filter((c) => MEASURE.has(c.type) && !b.series.includes(c.id) && c.id !== b.x)
    if (left.length) {
      const add = kit.select([['', t('＋ Add series')], ...left.map((c) => [c.id, c.name] as const)], '', (v) => {
        if (v) set({ series: [...b.series, v] })
      })
      add.className = 'dce-add'
      add.setAttribute('aria-label', t('＋ Add series'))
      host.append(add)
    }
  }

  // --- axis -------------------------------------------------------------------
  if (b.kind !== 'pie') {
    kit.section(host, t('Axis'))
    const ax = axisFormat(sheet, b.series)
    kit.readonlyRow(host, t('Values'), ax.mixed
      ? t('Plain numbers — the series do not share a format')
      : ax.pattern ? t('{pattern}, from the column', { pattern: ax.pattern }) : t('Plain numbers'))
    kit.readonlyRow(host, t('Categories'), isOrdered(sheet.columns.find((c) => c.id === b.x))
      ? t('In order')
      : t('No order — as they appear in the sheet'))
  }
}
