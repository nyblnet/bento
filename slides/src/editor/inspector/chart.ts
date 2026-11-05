// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Charts: type, series, axes, pies.
import type { PropsPanel } from '../panels'
import { type ChartElement, applyChartPalette } from '../../model'
import { section, row, toggle, opBtn, segmented } from './fields'
import { ICONS } from '../../icons'
import { t } from '../../i18n'
import { CHART_PRESETS } from '../../charts'
import { color } from './color'
import { SCRUB, unitHandle, numeric } from './controls'

/** Edit the live chart option in place; final=false while typing. */
export function editOption(p: PropsPanel, id: string, fn: (o: Record<string, any>) => void, final = true) {
  p.mutate(id, (e) => { fn((e as ChartElement).option as Record<string, any>) }, final)
}

export function buildChartProps(p: PropsPanel, el: ChartElement) {
  const opt = el.option as Record<string, any>
  const series: any[] = Array.isArray(opt.series) ? opt.series : opt.series ? [opt.series] : []
  const isPie = series.some((s) => s?.type === 'pie')
  const isScatter = series.some((s) => s?.type === 'scatter')

  section(p, t('Chart'))
  // live table binding banner (if this chart tracks a table)
  if (el.source?.tableId) {
    const linkRow = document.createElement('div')
    linkRow.className = 'ed-chart-link'
    const label = document.createElement('span')
    const stillThere = p.store.slide.elements.some((e) => e.id === el.source!.tableId && e.type === 'table')
    label.textContent = stillThere ? t('🔗 Live-linked to a table') : t('🔗 Linked table not on this slide')
    const unlink = document.createElement('button')
    unlink.className = 'ed-btn'
    unlink.textContent = t('Unlink')
    unlink.title = t('Stop tracking the table; the chart keeps its current data')
    unlink.addEventListener('click', () => p.mutate(el.id, (e) => { delete (e as ChartElement).source }, true))
    linkRow.append(label, unlink)
    p.host.appendChild(linkRow)
  }
  const kinds = Object.keys(CHART_PRESETS)
  row(p, 'Type', segmented(kinds, el.preset ?? 'bar', (v) =>
    p.mutate(el.id, (e) => {
      const c = e as ChartElement
      c.preset = v
      c.option = applyChartPalette(CHART_PRESETS[v](), p.store.doc.theme)
    }, true),
    Object.fromEntries(kinds.map((k) => [k, t(CHART_WORDS[k] ?? k)])),
    kinds.every((k) => CHART_GLYPHS[k]) ? CHART_GLYPHS : undefined))

  if (!isPie && !isScatter) buildChartCartesian(p, el, opt, series)
  else if (isPie) buildChartPie(p, el, series)

  // The escape hatch: the full option as JSON, for anything the UI omits.
  section(p, t('Advanced (JSON)'))
  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  hint.innerHTML = t('The full <b>chart option</b> as JSON (pure data — use template-string formatters like <code>{b}: {c}</code>, never functions). Tooltips and zoom run while presenting.')
  p.host.appendChild(hint)
  const ta = document.createElement('textarea')
  ta.className = 'ed-chart-json'
  ta.rows = 12
  ta.spellcheck = false
  ta.value = JSON.stringify(el.option, null, 2)
  ta.addEventListener('change', () => {
    try {
      const parsed = JSON.parse(ta.value)
      ta.classList.remove('ed-invalid')
      p.mutate(el.id, (e) => { (e as ChartElement).option = parsed }, true)
    } catch { ta.classList.add('ed-invalid') }
  })
  p.host.appendChild(ta)
}

export function seriesColor(s: any, palette: string[] | undefined, i: number): string {
  const c = s?.type === 'line' ? s?.lineStyle?.color : s?.itemStyle?.color
  if (typeof c === 'string') return c
  const p = palette && palette.length ? palette : ['#5470c6', '#91cc75', '#fac858', '#ee6666']
  return p[i % p.length]
}

export function setSeriesColor(s: any, v: string) {
  if (s?.type === 'line') s.lineStyle = { ...(s.lineStyle ?? {}), color: v }
  else s.itemStyle = { ...(s.itemStyle ?? {}), color: v }
}

export function buildChartCartesian(p: PropsPanel, el: ChartElement, opt: Record<string, any>, series: any[]) {
  const yAxis: any[] = Array.isArray(opt.yAxis) ? opt.yAxis : opt.yAxis ? [opt.yAxis] : [{ type: 'value' }]
  const twoAxes = yAxis.length > 1

  row(p, 'Legend', toggle(!!opt.legend, (on) =>
    editOption(p, el.id, (o) => { if (on) o.legend = { bottom: 0 }; else delete o.legend })))

  row(p, 'Second axis', toggle(twoAxes, (on) => editOption(p, el.id, (o) => {
    const ss: any[] = Array.isArray(o.series) ? o.series : o.series ? [o.series] : []
    if (on) {
      const first = Array.isArray(o.yAxis) ? (o.yAxis[0] ?? {}) : (o.yAxis ?? {})
      o.yAxis = [{ type: 'value', ...first }, { type: 'value', name: t('Axis {n}', { n: 2 }) }]
      ss.forEach((s, i) => { if (s) s.yAxisIndex = i === 0 ? 0 : 1 })
    } else {
      o.yAxis = { type: 'value', ...(Array.isArray(o.yAxis) ? o.yAxis[0] : o.yAxis) }
      ss.forEach((s) => { if (s) delete s.yAxisIndex })
    }
  })))

  // --- series list --------------------------------------------------------
  section(p, t('Series'))
  const palette: string[] | undefined = Array.isArray(opt.color) ? opt.color : undefined
  series.forEach((s, i) => {
    const row = document.createElement('div')
    row.className = 'ed-series-row'
    const name = document.createElement('input')
    name.type = 'text'; name.className = 'ed-series-name'; name.value = s?.name ?? ''
    name.placeholder = t('Series {n}', { n: i + 1 })
    name.addEventListener('input', () => editOption(p, el.id, (o) => { o.series[i].name = name.value }, false))
    name.addEventListener('change', () => editOption(p, el.id, (o) => { o.series[i].name = name.value }, true))
    const type = segmented(['bar', 'line'], s?.type === 'line' ? 'line' : 'bar',
      (v) => editOption(p, el.id, (o) => { o.series[i].type = v }), { bar: t('Bar'), line: t('Line') },
      { bar: CHART_GLYPHS.bar, line: CHART_GLYPHS.line })
    row.append(name, type)
    if (twoAxes) {
      row.append(segmented(['0', '1'], String(Math.round(s?.yAxisIndex ?? 0)),
        (v) => editOption(p, el.id, (o) => { o.series[i].yAxisIndex = parseInt(v) }), { 0: t('Left'), 1: t('Right') }))
    }
    row.append(color(p, seriesColor(s, palette, i), (v, final) =>
      editOption(p, el.id, (o) => setSeriesColor(o.series[i], v), final)))
    const rm = opBtn('✕', t('Remove'), () => editOption(p, el.id, (o) => {
      o.series.splice(i, 1)
      if (o.series.length <= 1) { o.series.forEach((x: any) => x && delete x.yAxisIndex); if (Array.isArray(o.yAxis)) o.yAxis = o.yAxis[0] ?? { type: 'value' } }
    }))
    rm.classList.add('ed-series-rm')
    row.append(rm)
    p.host.appendChild(row)
  })
  const addRow = document.createElement('div')
  addRow.className = 'ed-chart-add'
  const addBtn = document.createElement('button')
  addBtn.className = 'ed-btn ed-addlayer' // the panel's one "add" look
  addBtn.innerHTML = ICONS.plus
  addBtn.append(t('＋ Add series').replace(/^＋\s*/, ''))
  addBtn.addEventListener('click', () => editOption(p, el.id, (o) => {
    const ss: any[] = Array.isArray(o.series) ? o.series : o.series ? [o.series] : []
    const n = (o.xAxis?.data?.length) || 4
    ss.push({ type: 'bar', name: t('Series {n}', { n: ss.length + 1 }), data: Array(n).fill(0) })
    o.series = ss
  }))
  addRow.appendChild(addBtn)
  p.host.appendChild(addRow)

  // --- per-axis min/max ---------------------------------------------------
  yAxis.forEach((ax, ai) => {
    const label = twoAxes ? (ai === 0 ? t('Left axis') : t('Right axis')) : t('Y axis')
    const wrap = document.createElement('div')
    wrap.className = 'ed-axis-range'
    const mk = (key: 'min' | 'max', ph: string) => {
      const inp = document.createElement('input')
      inp.placeholder = ph
      numeric(inp)
      inp.value = typeof ax?.[key] === 'number' ? String(ax[key]) : ''
      const commit = (final: boolean) => editOption(p, el.id, (o) => {
        const a = Array.isArray(o.yAxis) ? o.yAxis[ai] : o.yAxis
        const raw = inp.value.trim()
        if (raw === '' || Number.isNaN(parseFloat(raw))) delete a[key]
        else a[key] = parseFloat(raw)
      }, final)
      // live only while the entry is a plain number: `+12` means nothing until Enter
      inp.addEventListener('input', () => { if (/^-?\d*\.?\d+$/.test(inp.value.trim())) commit(false) })
      inp.addEventListener('change', () => commit(true))
      inp.addEventListener(SCRUB, () => commit(false))
      return inp
    }
    // a placeholder is no label once a value is typed: say min/max beside
    // the fields, and let those words scrub them
    const lo = mk('min', t('min')), hi = mk('max', t('max'))
    wrap.append(unitHandle(t('min'), lo), lo, unitHandle(t('max'), hi), hi)
    row(p, label, wrap)
  })

  // --- data grid ----------------------------------------------------------
  buildChartGrid(p, el, opt, series)
}

/** Editable categories × series grid. Adding/removing rows keeps every
 *  series data array and the x-axis categories in lockstep. */
export function buildChartGrid(p: PropsPanel, el: ChartElement, opt: Record<string, any>, series: any[]) {
  const cats: any[] = opt.xAxis?.data ?? []
  section(p, t('Data'))
  const scroll = document.createElement('div')
  scroll.className = 'ed-chart-grid-wrap'
  const table = document.createElement('table')
  table.className = 'ed-chart-grid'
  const thead = document.createElement('tr')
  const corner = document.createElement('th'); corner.textContent = ''
  thead.appendChild(corner)
  series.forEach((s, i) => {
    const th = document.createElement('th')
    th.textContent = s?.name || t('Series {n}', { n: i + 1 })
    thead.appendChild(th)
  })
  thead.appendChild(document.createElement('th'))
  table.appendChild(thead)

  const cellInput = (value: string, onCommit: (v: string, final: boolean) => void, numeric: boolean) => {
    const inp = document.createElement('input')
    inp.type = numeric ? 'number' : 'text'
    inp.value = value
    inp.addEventListener('input', () => onCommit(inp.value, false))
    inp.addEventListener('change', () => onCommit(inp.value, true))
    return inp
  }

  const rowCount = Math.max(cats.length, ...series.map((s) => (s?.data?.length ?? 0)))
  for (let r = 0; r < rowCount; r++) {
    const tr = document.createElement('tr')
    const cat = document.createElement('td')
    cat.appendChild(cellInput(String(cats[r] ?? ''), (v, final) => editOption(p, el.id, (o) => {
      if (!Array.isArray(o.xAxis?.data)) { o.xAxis = { ...(o.xAxis ?? { type: 'category' }), data: [] } }
      o.xAxis.data[r] = v
    }, final), false))
    tr.appendChild(cat)
    series.forEach((s, i) => {
      const td = document.createElement('td')
      td.appendChild(cellInput(String(s?.data?.[r] ?? ''), (v, final) => editOption(p, el.id, (o) => {
        const arr = o.series[i].data ?? (o.series[i].data = [])
        const n = parseFloat(v)
        arr[r] = Number.isNaN(n) ? 0 : n
      }, final), true))
      tr.appendChild(td)
    })
    const rmTd = document.createElement('td')
    rmTd.appendChild(opBtn('✕', t('Remove row'), () => editOption(p, el.id, (o) => {
      if (Array.isArray(o.xAxis?.data)) o.xAxis.data.splice(r, 1)
      o.series.forEach((s: any) => { if (Array.isArray(s?.data)) s.data.splice(r, 1) })
    })))
    tr.appendChild(rmTd)
    table.appendChild(tr)
  }
  scroll.appendChild(table)
  p.host.appendChild(scroll)

  const addRow = document.createElement('div')
  addRow.className = 'ed-chart-add'
  const addBtn = document.createElement('button')
  addBtn.className = 'ed-btn ed-addlayer'
  addBtn.innerHTML = ICONS.plus
  addBtn.append(t('＋ Add row').replace(/^＋\s*/, ''))
  addBtn.addEventListener('click', () => editOption(p, el.id, (o) => {
    if (!Array.isArray(o.xAxis?.data)) o.xAxis = { ...(o.xAxis ?? { type: 'category' }), data: [] }
    o.xAxis.data.push(t('Item {n}', { n: o.xAxis.data.length + 1 }))
    const ss: any[] = Array.isArray(o.series) ? o.series : [o.series]
    ss.forEach((s) => { if (s) (s.data ?? (s.data = [])).push(0) })
  }))
  addRow.appendChild(addBtn)
  p.host.appendChild(addRow)
}

/** Pie: one row per slice (name · value · colour · remove) + add. */
export function buildChartPie(p: PropsPanel, el: ChartElement, series: any[]) {
  const s = series.find((x) => x?.type === 'pie') ?? series[0]
  const data: any[] = s?.data ?? []
  const palette: string[] | undefined = Array.isArray((el.option as any).color) ? (el.option as any).color : undefined
  section(p, t('Slices'))
  data.forEach((d, i) => {
    const row = document.createElement('div')
    row.className = 'ed-series-row'
    const name = document.createElement('input')
    name.type = 'text'; name.className = 'ed-series-name'; name.value = d?.name ?? ''
    name.addEventListener('input', () => editPieDatum(p, el.id, i, (x) => { x.name = name.value }, false))
    name.addEventListener('change', () => editPieDatum(p, el.id, i, (x) => { x.name = name.value }, true))
    const val = document.createElement('input')
    val.type = 'number'; val.className = 'ed-pie-val'; val.value = String(d?.value ?? 0)
    const commitVal = (final: boolean) => editPieDatum(p, el.id, i, (x) => { const n = parseFloat(val.value); x.value = Number.isNaN(n) ? 0 : n }, final)
    val.addEventListener('input', () => commitVal(false))
    val.addEventListener('change', () => commitVal(true))
    const swatch = color(p, (palette && palette[i]) || seriesColor({ type: 'pie' }, palette, i), (v, final) =>
      editOption(p, el.id, (o) => { if (!Array.isArray(o.color)) o.color = []; o.color[i] = v }, final))
    const rm = opBtn('✕', t('Remove'), () => editPieDatum(p, el.id, i, null, true))
    rm.classList.add('ed-series-rm')
    row.append(name, val, swatch, rm)
    p.host.appendChild(row)
  })
  const addRow = document.createElement('div')
  addRow.className = 'ed-chart-add'
  const addBtn = document.createElement('button')
  addBtn.className = 'ed-btn'
  addBtn.textContent = t('＋ Add slice')
  addBtn.addEventListener('click', () => editOption(p, el.id, (o) => {
    const ps = (Array.isArray(o.series) ? o.series : [o.series]).find((x: any) => x?.type === 'pie') ?? o.series[0]
    ps.data = ps.data ?? []
    ps.data.push({ name: t('Item {n}', { n: ps.data.length + 1 }), value: 0 })
  }))
  addRow.appendChild(addBtn)
  p.host.appendChild(addRow)
}

export function editPieDatum(p: PropsPanel, id: string, i: number, fn: ((d: any) => void) | null, final: boolean) {
  editOption(p, id, (o) => {
    const ps = (Array.isArray(o.series) ? o.series : [o.series]).find((x: any) => x?.type === 'pie') ?? o.series[0]
    if (!ps?.data) return
    if (fn === null) ps.data.splice(i, 1)
    else fn(ps.data[i])
  }, final)
}

const CHART_WORDS: Record<string, string> = { bar: 'Bar', line: 'Line', pie: 'Pie', scatter: 'Scatter' }
const CHART_GLYPHS: Record<string, string> = { bar: ICONS.chart, line: ICONS.chartLine, pie: ICONS.chartPie, scatter: ICONS.chartScatter }
