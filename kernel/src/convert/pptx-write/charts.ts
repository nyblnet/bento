// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento chart → a NATIVE c:chart part + the graphicFrame that references it.
//
// PR #88 mapped charts through PptxGenJS's addChart and fell back to an SVG
// image for anything the library didn't cover. This rework writes the
// DrawingML Charts part directly and changes the fallback: out-of-subset
// charts become a TABLE of their data, never a picture and never a wrong
// chart. The spike's finding stands — a clustered rendering of a stacked
// option destroys the totals the author built the slide around, and a chart
// that lies is worse than no chart. The data table keeps every number
// editable and the fidelity report says what happened.
//
// The subset (everything charts-lite actually renders, which the bento format
// guarantees): single-type bar/line/pie/scatter series with plain-number
// data, plus the DUAL-AXIS pattern — series split over yAxisIndex 0/1, each
// axis group single-type (tableToChart emits exactly this: bars left, one
// odd-scale column as a line on the right). #88 skipped dual axis; the shape
// is common enough in real bento decks that it is mapped here as two plot
// groups sharing the category axis, the second pair of axes deleted/right —
// the same wiring PowerPoint itself writes for a combo chart.
//
// NO EMBEDDED WORKBOOK, BY DESIGN. A chart part may carry an externalData rel
// to an xlsx with the source table; ours carries none. PowerPoint renders
// entirely from the literal caches (c:strCache/c:numCache) below, and "Edit
// Data" generates a fresh sheet FROM those caches — the c:f formulas give
// that rebuild sensible cell addresses. Embedding a real workbook would mean
// writing a second OOXML package inside this one for zero rendering benefit.
//
// Data coercion mirrors the RENDERER, not the raw JSON: charts-lite coerces
// non-numeric bar/line data ({value,itemStyle} objects, blanks) to 0, so the
// export does too — the .pptx shows what the slide showed. Each coercion is
// still reported ('chart-data-coerced'): a blank that became a zero changes
// what the chart asserts, whether or not bento already rendered it that way.

import { scrubC0, serialize, x, type XChild, type XNode } from '../xmlout.ts'
import { EMU_PER_PX, type OutChart, type OutTable } from '../types.ts'
import type { Report } from '../report.ts'
import { tableFrame } from './tables.ts'

/** The a:graphicData uri that marks a graphicFrame as a chart reference. */
export const CHART_GRAPHIC_URI = 'http://schemas.openxmlformats.org/drawingml/2006/chart'

const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export interface ChartExport {
  /** the spTree node — a chart-referencing graphicFrame, or (fallback) a table */
  frame: XNode
  /**
   * The serialized c:chartSpace part. Present → the integrator must emit it
   * as ppt/charts/chartN.xml, register a REL.chart rel with the `relId`
   * passed in, and add a CT.chart [Content_Types] override. ABSENT → the
   * frame is a data table, `relId` was NOT used, and no part/rel/override
   * may be emitted (a dangling chart rel is a repair dialog).
   */
  chartXml?: string
}

// --- option access -----------------------------------------------------------
// The option is ECharts-shaped free JSON (charts-lite ignores unknown keys
// gracefully; so does this reader — absent/odd keys fall to defaults).

type Dict = Record<string, unknown>
const dict = (v: unknown): Dict => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const numOr = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** option.series may be one object or an array (ECharts allows both). */
const seriesList = (v: unknown): Dict[] =>
  (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(dict)

/** option.yAxis: object or array of up to two value-axis configs. */
const yAxisList = (v: unknown): Dict[] => (Array.isArray(v) ? v.map(dict) : [dict(v)])

// --- colours -----------------------------------------------------------------
// Series colour resolution order = charts-lite's: explicit option.color array,
// else the deck palette the integrator passes (doc.theme.chartPalette or
// slides' deriveChartPalette(accent) — that derivation lives in the app, the
// kernel only consumes the result), else the ECharts stock four #88 fell back
// to. Local hex-only conversion: chart colours are opaque fills; the css
// parsing lives in tables.ts's cssSolid but here only the hex is wanted.

const STOCK = ['#5470c6', '#91cc75', '#fac858', '#ee6666'] // #88's docPalette

function hex6(css: string | undefined, fallback: string): string {
  const raw = (css ?? '').trim()
  const rgb = raw.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
  if (rgb) {
    return [rgb[1], rgb[2], rgb[3]]
      .map((n) => Math.min(255, Math.max(0, Math.round(Number(n)))).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  }
  let hex = raw.replace(/^#/, '')
  if (/^[0-9a-f]{3,4}$/i.test(hex)) hex = [...hex].map((c) => c + c).join('')
  if (/^[0-9a-f]{6,8}$/i.test(hex)) return hex.slice(0, 6).toUpperCase()
  return fallback
}

const srgbFill = (hex: string): XNode =>
  x('a:solidFill', undefined, [x('a:srgbClr', { val: hex })])

// --- literal data references -------------------------------------------------
// c:f addresses are for the edit-time rebuild only (see header): categories
// live in column A, series i in column B+i, row 1 is the header row.

const colLetter = (i: number): string => {
  let n = i + 1
  let s = ''
  while (n > 0) {
    n--
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26)
  }
  return s
}

// scrubC0: category labels and series names are author-typed strings that
// land verbatim in c:v — a control char must cost a character, not the export.
const ptNodes = (vals: string[]): XChild[] =>
  vals.map((v, i) => x('c:pt', { idx: i }, [x('c:v', undefined, [scrubC0(v)])]))

const strRef = (f: string, vals: string[]): XNode =>
  x('c:strRef', undefined, [
    x('c:f', undefined, [f]),
    x('c:strCache', undefined, [x('c:ptCount', { val: vals.length }), ...ptNodes(vals)]),
  ])

/** Values go through String() verbatim — 4.25 stays "4.25"; the cache must
 *  hold exactly what the deck showed, not a reformatted number. */
const numRef = (f: string, vals: number[]): XNode =>
  x('c:numRef', undefined, [
    x('c:f', undefined, [f]),
    x('c:numCache', undefined, [
      x('c:formatCode', undefined, ['General']),
      x('c:ptCount', { val: vals.length }),
      ...ptNodes(vals.map((v) => String(v))),
    ]),
  ])

const catRange = (n: number): string => `Sheet1!$A$2:$A$${n + 1}`
const serRange = (si: number, n: number): string => `Sheet1!$${colLetter(si + 1)}$2:$${colLetter(si + 1)}$${n + 1}`
const serNameRef = (si: number, name: string): XNode => strRef(`Sheet1!$${colLetter(si + 1)}$1`, [name])

// --- axes --------------------------------------------------------------------
// Fixed ids, unique within the part: 1001/1002 primary cat/val, 1003/1004
// the secondary pair. Child order inside cat/valAx is schema-fixed (axId,
// scaling, delete, axPos, [gridlines], [numFmt], crossAx, crosses) — a
// reordered axis is a repair dialog.

const AX = { cat0: 1001, val0: 1002, cat1: 1003, val1: 1004 } as const

function catAx(id: number, crossId: number, deleted: boolean): XNode {
  return x('c:catAx', undefined, [
    x('c:axId', { val: id }),
    x('c:scaling', undefined, [x('c:orientation', { val: 'minMax' })]),
    // The secondary category axis exists only to complete the axis pair the
    // schema demands — delete=1 hides it, exactly as PowerPoint writes it.
    x('c:delete', { val: deleted ? 1 : 0 }),
    x('c:axPos', { val: 'b' }),
    x('c:crossAx', { val: crossId }),
  ])
}

interface ValAxOpts {
  pos: 'l' | 'r' | 'b'
  min?: number
  max?: number
  /** axisLabel.formatter carries '{value}%' → percent tick labels */
  pct?: boolean
  gridlines?: boolean
  /** secondary axis crosses at the far side */
  crossesMax?: boolean
  deleted?: boolean
}

function valAx(id: number, crossId: number, o: ValAxOpts): XNode {
  const scaling: XChild[] = [x('c:orientation', { val: 'minMax' })]
  if (o.max !== undefined) scaling.push(x('c:max', { val: o.max }))
  if (o.min !== undefined) scaling.push(x('c:min', { val: o.min }))
  return x('c:valAx', undefined, [
    x('c:axId', { val: id }),
    x('c:scaling', undefined, scaling),
    x('c:delete', { val: o.deleted ? 1 : 0 }),
    x('c:axPos', { val: o.pos }),
    ...(o.gridlines ? [x('c:majorGridlines')] : []),
    // '{value}%' appends a literal percent sign; the format code must quote
    // it — a bare "0%" is Excel's percent FORMAT and multiplies by 100.
    ...(o.pct ? [x('c:numFmt', { formatCode: '0"%"', sourceLinked: 0 })] : []),
    x('c:crossAx', { val: crossId }),
    ...(o.crossesMax ? [x('c:crosses', { val: 'max' })] : []),
  ])
}

// --- series ------------------------------------------------------------------

interface SerData {
  /** global series index (c:idx/c:order must be unique across plot groups) */
  gi: number
  name: string
  color: string
  values: number[]
  smooth: boolean
}

function barSer(s: SerData, labels: string[]): XNode {
  return x('c:ser', undefined, [
    x('c:idx', { val: s.gi }),
    x('c:order', { val: s.gi }),
    x('c:tx', undefined, [serNameRef(s.gi, s.name)]),
    x('c:spPr', undefined, [srgbFill(s.color)]),
    x('c:cat', undefined, [strRef(catRange(labels.length), labels)]),
    x('c:val', undefined, [numRef(serRange(s.gi, s.values.length), s.values)]),
  ])
}

function lineSer(s: SerData, labels: string[]): XNode {
  return x('c:ser', undefined, [
    x('c:idx', { val: s.gi }),
    x('c:order', { val: s.gi }),
    x('c:tx', undefined, [serNameRef(s.gi, s.name)]),
    // A line's colour lives on its OUTLINE (28575 EMU = 2.25pt, PowerPoint's
    // default line-chart weight), not a shape fill.
    x('c:spPr', undefined, [x('a:ln', { w: 28575 }, [srgbFill(s.color)])]),
    x('c:marker', undefined, [
      x('c:symbol', { val: 'circle' }),
      x('c:size', { val: 5 }),
      x('c:spPr', undefined, [srgbFill(s.color)]),
    ]),
    x('c:cat', undefined, [strRef(catRange(labels.length), labels)]),
    x('c:val', undefined, [numRef(serRange(s.gi, s.values.length), s.values)]),
    x('c:smooth', { val: s.smooth ? 1 : 0 }),
  ])
}

// --- the mapper --------------------------------------------------------------

/**
 * One bento chart element. `shapeId` is the cNvPr id; `relId` is the r:id the
 * INTEGRATOR reserved for this chart in the slide's rels — used only when the
 * result carries `chartXml` (see ChartExport). `palette` is the deck's chart
 * palette (doc.theme.chartPalette, or the accent-derived set slides computes);
 * omit and the ECharts stock colours apply.
 */
export function chartExport(
  el: OutChart,
  shapeId: number,
  relId: string,
  palette: string[] | undefined,
  report: Report,
  where: string,
): ChartExport {
  const option = dict(el.option)
  const series = seriesList(option.series)
  const optColors = Array.isArray(option.color) ? (option.color as unknown[]).map((c) => str(c) ?? '') : []
  const colorFor = (i: number): string =>
    hex6(optColors[i] || palette?.[i % (palette.length || 1)] || STOCK[i % STOCK.length], '5470C6')

  let coerced = 0
  const num = (v: unknown): number => {
    // charts-lite's coercion: Number() of the leaf, non-finite (objects,
    // blanks, text) → 0. See header — faithful to the render, but reported.
    const n = Number(v)
    if (Number.isFinite(n) && (typeof v === 'number' || typeof v === 'string' && v.trim() !== '')) return n
    coerced++
    return 0
  }

  if (el.rotation) {
    report.add('dropped', 'chart-rotation-dropped', where, 'PowerPoint cannot rotate chart frames; the chart exports axis-aligned')
  }

  // --- subset gate: anything outside becomes the data table ------------------
  const types = series.map((s) => str(s.type) ?? 'bar')
  const fallback = (reason: string): ChartExport => {
    report.add('approximated', 'chart-approximated', where,
      `chart outside the native-export subset (${reason}) rendered as a table of its data — a wrong chart (e.g. a clustered read of a stacked series) would misstate the numbers`)
    return { frame: dataTableFrame(el, series, option, num, shapeId, report, where) }
  }

  if (series.length === 0) return fallback('no series')
  if (series.some((s) => s.stack !== undefined && s.stack !== null && s.stack !== false)) return fallback('stacked series')
  const unknown = types.find((t) => !['bar', 'line', 'pie', 'scatter'].includes(t))
  if (unknown) return fallback(`unsupported series type '${unknown}'`)

  const isPie = types.includes('pie')
  const isScatter = types.includes('scatter')
  if (isPie && (series.length > 1 || types.length > 1)) return fallback('pie mixed with other series')
  if (isScatter && types.some((t) => t !== 'scatter')) return fallback('scatter mixed with other series')
  if ((isPie || isScatter) && series.some((s) => numOr(s.yAxisIndex) === 1)) return fallback('secondary axis on a non-cartesian chart')

  // Split bar/line series over the two value axes (yAxisIndex 0/1); each
  // group must be single-type — that is the whole subset for combos.
  const groups: Array<{ axis: 0 | 1; type: 'bar' | 'line'; sers: SerData[] }> = []
  if (!isPie && !isScatter) {
    for (const axis of [0, 1] as const) {
      const members = series
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => (numOr(s.yAxisIndex) === 1 ? 1 : 0) === axis)
      if (members.length === 0) continue
      const groupTypes = new Set(members.map(({ i }) => types[i]))
      if (groupTypes.size > 1) return fallback('mixed series types on one axis')
      groups.push({
        axis,
        type: [...groupTypes][0] as 'bar' | 'line',
        sers: members.map(({ s, i }) => ({
          gi: i,
          name: str(s.name) ?? `Series ${i + 1}`,
          color: colorFor(i),
          values: (Array.isArray(s.data) ? s.data : []).map(num),
          smooth: s.smooth === true,
        })),
      })
    }
  }

  // --- chart body ------------------------------------------------------------
  const labels = (Array.isArray(dict(option.xAxis).data) ? (dict(option.xAxis).data as unknown[]) : []).map(String)
  const yAxes = yAxisList(option.yAxis)
  const axOpts = (i: number): { min?: number; max?: number; pct?: boolean } => ({
    min: numOr(yAxes[i]?.min),
    max: numOr(yAxes[i]?.max),
    pct: (str(dict(yAxes[i]?.axisLabel).formatter) ?? '').includes('%'),
  })

  const plot: XChild[] = [x('c:layout')]

  if (isPie) {
    const s = series[0]
    const items = (Array.isArray(s.data) ? s.data : []).map(dict)
    const names = items.map((it, i) => str(it.name) ?? String(i + 1))
    const values = items.map((it) => num(it.value))
    const ser = x('c:ser', undefined, [
      x('c:idx', { val: 0 }),
      x('c:order', { val: 0 }),
      x('c:tx', undefined, [serNameRef(0, str(s.name) ?? 'Series 1')]),
      // Slice colours as data points — pie colour is per-slice, walking the
      // same palette charts-lite walks.
      ...items.map((_, i) =>
        x('c:dPt', undefined, [
          x('c:idx', { val: i }),
          x('c:bubble3D', { val: 0 }),
          x('c:spPr', undefined, [srgbFill(colorFor(i))]),
        ]),
      ),
      x('c:cat', undefined, [strRef(catRange(names.length), names)]),
      x('c:val', undefined, [numRef(serRange(0, values.length), values)]),
    ])
    // charts-lite's pie preset is a donut (radius ['38%','68%']); a plain
    // radius (or inner 0) is a full pie. holeSize = inner/outer share of the
    // diameter, the same visual PowerPoint's doughnut draws.
    const radius = s.radius
    const [inner, outer] = Array.isArray(radius)
      ? [parseFloat(String(radius[0])) || 0, parseFloat(String(radius[1])) || 70]
      : [0, parseFloat(String(radius ?? '70%')) || 70]
    if (inner > 0 && outer > 0) {
      plot.push(x('c:doughnutChart', undefined, [
        x('c:varyColors', { val: 1 }), ser, x('c:firstSliceAng', { val: 0 }),
        x('c:holeSize', { val: Math.min(90, Math.max(1, Math.round((inner / outer) * 100))) }),
      ]))
    } else {
      plot.push(x('c:pieChart', undefined, [x('c:varyColors', { val: 1 }), ser, x('c:firstSliceAng', { val: 0 })]))
    }
  } else if (isScatter) {
    // Scatter: two VALUE axes, series as x/y pairs. lineMarker style with a
    // noFill outline per series is how PowerPoint itself writes a
    // markers-only scatter (scatterStyle 'marker' renders, but Edit-Data
    // round-trips shakily in older builds).
    plot.push(x('c:scatterChart', undefined, [
      x('c:scatterStyle', { val: 'lineMarker' }),
      x('c:varyColors', { val: 0 }),
      ...series.map((s, i) => {
        // A scalar datum in a scatter series reads as (index, value) — the
        // same shape a category series would have plotted it at.
        const pairs = (Array.isArray(s.data) ? s.data : []).map((d, di) => (Array.isArray(d) ? d : [di, d]))
        const color = colorFor(i)
        return x('c:ser', undefined, [
          x('c:idx', { val: i }),
          x('c:order', { val: i }),
          x('c:tx', undefined, [serNameRef(i, str(s.name) ?? `Series ${i + 1}`)]),
          x('c:spPr', undefined, [x('a:ln', { w: 28575 }, [x('a:noFill')])]),
          x('c:marker', undefined, [
            x('c:symbol', { val: 'circle' }),
            x('c:size', { val: 5 }),
            x('c:spPr', undefined, [srgbFill(color)]),
          ]),
          x('c:xVal', undefined, [numRef(catRange(pairs.length), pairs.map((p) => num(p[0])))]),
          x('c:yVal', undefined, [numRef(serRange(i, pairs.length), pairs.map((p) => num(p[1])))]),
        ])
      }),
      x('c:axId', { val: AX.cat0 }),
      x('c:axId', { val: AX.val0 }),
    ]))
    plot.push(valAx(AX.cat0, AX.val0, { pos: 'b' }))
    plot.push(valAx(AX.val0, AX.cat0, { pos: 'l', gridlines: true, ...axOpts(0) }))
  } else {
    // bar/line, possibly dual-axis: one plot group per axis, category axis
    // shared, the secondary pair deleted-cat + right-val crossing at max —
    // the combo wiring PowerPoint writes natively.
    for (const g of groups) {
      const catId = g.axis === 0 ? AX.cat0 : AX.cat1
      const valId = g.axis === 0 ? AX.val0 : AX.val1
      const sers = g.sers.map((s) => (g.type === 'bar' ? barSer(s, labels) : lineSer(s, labels)))
      plot.push(
        g.type === 'bar'
          ? x('c:barChart', undefined, [
              x('c:barDir', { val: 'col' }),
              x('c:grouping', { val: 'clustered' }),
              x('c:varyColors', { val: 0 }),
              ...sers,
              x('c:axId', { val: catId }),
              x('c:axId', { val: valId }),
            ])
          : x('c:lineChart', undefined, [
              x('c:grouping', { val: 'standard' }),
              x('c:varyColors', { val: 0 }),
              ...sers,
              x('c:marker', { val: 1 }),
              x('c:axId', { val: catId }),
              x('c:axId', { val: valId }),
            ]),
      )
    }
    const dual = groups.some((g) => g.axis === 1)
    if (groups.some((g) => g.axis === 0)) {
      plot.push(catAx(AX.cat0, AX.val0, false))
      plot.push(valAx(AX.val0, AX.cat0, { pos: 'l', gridlines: true, ...axOpts(0) }))
    }
    if (dual) {
      plot.push(catAx(AX.cat1, AX.val1, true))
      plot.push(valAx(AX.val1, AX.cat1, { pos: 'r', crossesMax: true, ...axOpts(1) }))
    }
  }

  // --- legend, title, chartSpace ---------------------------------------------
  // legend: falsy (absent/false) = none; legend: {show:false} = none; any
  // other object/true = shown.
  const legendCfg = option.legend && dict(option.legend).show !== false ? dict(option.legend) : undefined
  // Position from the ECharts anchor keys; bento's presets all say bottom,
  // so bottom is also the default when the option is silent about position.
  const legendPos = legendCfg
    ? legendCfg.bottom !== undefined ? 'b'
      : legendCfg.top !== undefined ? 't'
        : legendCfg.left !== undefined ? 'l'
          : legendCfg.right !== undefined ? 'r' : 'b'
    : undefined

  const titleText = str(dict(option.title).text)
  const chartKids: XChild[] = [
    ...(titleText
      ? [
          x('c:title', undefined, [
            x('c:tx', undefined, [
              x('c:rich', undefined, [
                x('a:bodyPr'),
                x('a:p', undefined, [x('a:r', undefined, [x('a:t', undefined, [scrubC0(titleText)])])]),
              ]),
            ]),
            x('c:overlay', { val: 0 }),
          ]),
          x('c:autoTitleDeleted', { val: 0 }),
        ]
      // No title in the option = no title in the export: without this flag
      // PowerPoint helpfully invents a "Chart Title" placeholder.
      : [x('c:autoTitleDeleted', { val: 1 })]),
    x('c:plotArea', undefined, plot),
    ...(legendPos
      ? [x('c:legend', undefined, [x('c:legendPos', { val: legendPos }), x('c:overlay', { val: 0 })])]
      : []),
    x('c:plotVisOnly', { val: 1 }),
    x('c:dispBlanksAs', { val: 'gap' }),
  ]

  const chartXml = serialize(
    x('c:chartSpace', { 'xmlns:c': NS_C, 'xmlns:a': NS_A, 'xmlns:r': NS_R }, [
      x('c:chart', undefined, chartKids),
    ]),
  )

  if (coerced > 0) {
    report.add('approximated', 'chart-data-coerced', where,
      `${coerced === 1 ? 'a non-numeric datum' : 'non-numeric data'} coerced to 0 — matching what charts-lite rendered, but the cache now asserts zeros`)
  }

  const morphId = (el as OutChart & { morphId?: string }).morphId
  const frame = x('p:graphicFrame', undefined, [
    x('p:nvGraphicFramePr', undefined, [
      x('p:cNvPr', { id: shapeId, name: `bento:${morphId || el.id}` }),
      x('p:cNvGraphicFramePr', undefined, [x('a:graphicFrameLocks', { noGrp: 1 })]),
      x('p:nvPr'),
    ]),
    x('p:xfrm', undefined, [
      x('a:off', { x: Math.round(el.x * EMU_PER_PX), y: Math.round(el.y * EMU_PER_PX) }),
      x('a:ext', { cx: Math.round(el.w * EMU_PER_PX), cy: Math.round(el.h * EMU_PER_PX) }),
    ]),
    x('a:graphic', undefined, [
      x('a:graphicData', { uri: CHART_GRAPHIC_URI }, [
        // The reference element re-declares c: and r: — the slide root only
        // declares a/p/r, and PowerPoint writes the chart ref exactly so.
        x('c:chart', { 'xmlns:c': NS_C, 'xmlns:r': NS_R, 'r:id': relId }),
      ]),
    ]),
  ])

  return { frame, chartXml }
}

// --- the fallback: a table of the data ---------------------------------------

/**
 * Build the out-of-subset fallback: labels down the first column, one column
 * per series, header row from series names — the same table→chart columns
 * bento derives, inverted. Rendered through tables.ts so it inherits the
 * drift-free grid and reporting. Neutral styling on purpose: this table is a
 * stand-in the user will restyle or re-chart, not deck furniture.
 */
function dataTableFrame(
  el: OutChart,
  series: Dict[],
  option: Dict,
  num: (v: unknown) => number,
  shapeId: number,
  report: Report,
  where: string,
): XNode {
  const firstPie = series.find((s) => str(s.type) === 'pie')
  let labels: string[]
  let cols: Array<{ name: string; values: number[] }>
  if (firstPie) {
    const items = (Array.isArray(firstPie.data) ? firstPie.data : []).map(dict)
    labels = items.map((it, i) => str(it.name) ?? String(i + 1))
    cols = [{ name: str(firstPie.name) ?? 'Value', values: items.map((it) => num(it.value)) }]
  } else {
    const data = series.map((s) => (Array.isArray(s.data) ? s.data : []))
    const n = Math.max(0, ...data.map((d) => d.length))
    const xLabels = (Array.isArray(dict(option.xAxis).data) ? (dict(option.xAxis).data as unknown[]) : []).map(String)
    labels = Array.from({ length: n }, (_, i) => xLabels[i] ?? String(i + 1))
    cols = series.map((s, i) => ({
      name: str(s.name) ?? `Series ${i + 1}`,
      // Scatter pairs collapse to their y value in the table read-out.
      values: data[i].map((d) => num(Array.isArray(d) ? d[1] : d)),
    }))
  }

  const table: OutTable = {
    id: el.id,
    type: 'table',
    x: el.x, y: el.y, w: el.w, h: el.h,
    rotation: el.rotation,
    opacity: el.opacity,
    columns: [{ w: 1.4 }, ...cols.map(() => ({ w: 1 }))],
    header: true,
    rows: [
      { cells: [{ html: '' }, ...cols.map((c) => ({ html: c.name }))] },
      ...labels.map((label, ri) => ({
        cells: [{ html: label }, ...cols.map((c) => ({ html: c.values[ri] !== undefined ? String(c.values[ri]) : '' }))],
      })),
    ],
    style: {
      headerBg: '#EFF2F5', headerColor: '#1E2A3A', color: '#1E2A3A',
      borderColor: '#C9CFD6', borderWidth: 1,
      cellPadX: 10, cellPadY: 6, fontSize: 14, radius: 0,
    },
  }
  return tableFrame(table, shapeId, report, where)
}
