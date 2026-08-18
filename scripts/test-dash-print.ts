#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash print + PDF rig.
//
//   node scripts/test-dash-print.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Printing is the one output of this application that nobody
// checks twice: it leaves the screen, it lands on paper or in a PDF somebody
// forwards, and by the time a number on it is questioned the view that produced
// it is gone. Every failure below is silent by construction — the page that
// comes out has a header, a body and a total, and looks finished.
//
//   1. THE WINDOW MUST NOT REACH THE PAPER. The grid holds ~40 rows of a
//      5,000-row sheet in the DOM (grid.ts); a `@media print` block over that
//      surface prints those forty and omits the rest, with nothing on the page
//      to say so. This is the check that matters most, and it is the first one
//      below: build a sheet far larger than any window and count the rows that
//      come out.
//   2. THE VIEW VECTOR IS THE VIEW. `store.order` is the single source of truth
//      for which rows are showing and in what order (store.ts `view()`), and
//      the footer, the chart, Find and the status bar all read it. A printout
//      that read `sheet.rids` instead would hand a reader the rows they had
//      just filtered away — in the direction that looks like more data, which
//      is the direction nobody questions.
//   3. THE TOTAL MUST BE THE FILTERED TOTAL. dash matches Excel's *table*
//      semantics (`SUBTOTAL(109,…)` ignores filtered-out rows) and the grid's
//      footer already had this bug once: four rows worth £69,050 on screen and
//      £97,050 in bold underneath them. Printing it would put that wrong number
//      somewhere it cannot be corrected.
//   4. A COLUMN MUST NEVER RUN OFF THE RIGHT EDGE. Clipping loses a column
//      heading and all its numbers at once and leaves a page that looks whole.
//      `planColumns` is the whole answer — shrink to a legibility floor, then
//      continue on later pages — so the two properties it must have (every
//      column placed, no block wider than the page) are asserted directly.
//   5. BOTH KINDS PRINT. A spreadsheet (`kind: 'canvas'`) is typed by cell and
//      has no column list at all; a print path written against the dataset kind
//      alone would print it empty, which is the same silence as (1).
//   6. FORMATS, COLOURS AND CONDITIONAL FORMATS ARE THE DATA. A red cell that
//      prints white has lost what the red was saying — and a colour reaching a
//      `style` attribute is CSS, where `;` and `}` matter and HTML escaping
//      does not help (preview.ts hit this first).
//   7. NOTHING BLOWS THE STACK OR THE CLOCK. `Math.min(...vals)` over a column
//      is a RangeError at a few hundred thousand rows (dashboard.ts:741 carries
//      one). Nothing here may spread a row-length array, and a large view must
//      build in a time a human will wait through.
//
// Pagination itself is the renderer's — `thead { display: table-header-group }`
// is what repeats a column header on page 40 and cannot be checked without a
// print engine. What IS checked here is that the markup gives it the chance:
// one `<thead>` per printed table, and the totals row in `<tbody>` rather than
// a `<tfoot>` that would repeat on every page.

import { registerHooks } from 'node:module'

// print.ts owns a stylesheet, and reaches grid.ts, which reaches find.ts, which
// owns another. Resolving CSS is Vite's job and not Node's — the pattern
// scripts/test-dash-filter.ts settled, and co-locating a component with its
// styles is not something a rig gets to break.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const {
  buildPrintable, collectViews, planColumns, pageBox, styleColor,
  MIN_SCALE, PAPERS, DEFAULT_OPTIONS, _internals,
} = await import('../dash/src/print.ts')
type PrintOptions = import('../dash/src/print.ts').PrintOptions
type SheetView = import('../dash/src/print.ts').SheetView
const { Store } = await import('../dash/src/store.ts')
const { aggregate } = await import('../dash/src/grid.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc
type Sheet = import('../dash/src/model.ts').Sheet
type TableSheet = import('../dash/src/model.ts').TableSheet
type CanvasSheet = import('../dash/src/model.ts').CanvasSheet
const { FORMAT, FORMAT_VERSION } = await import('../dash/src/model.ts')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// --- fixtures ----------------------------------------------------------------

const wb = (sheets: Sheet[], extra: Partial<DashDoc> = {}): DashDoc => ({
  format: FORMAT,
  version: FORMAT_VERSION,
  docId: 'doc-print',
  title: 'Q3 pipeline',
  sheets,
  ...extra,
} as DashDoc)

/** A dataset of `n` rows: a text column, a money column, a computed one. */
function bigSheet(n: number): TableSheet {
  const region: Array<number | null> = []
  const value: Array<number | null> = []
  for (let i = 0; i < n; i++) {
    region.push(i % 3)
    value.push(i + 1)
  }
  return {
    id: 'sh1',
    name: 'Pipeline',
    kind: 'table',
    rids: [[1, n]],
    columns: [
      { id: 'region', name: 'Region', type: 'text' },
      { id: 'value', name: 'Value', type: 'money', format: '£#,##0' },
    ],
    data: {
      region: { enc: 'dict', dict: ['North', 'South', 'East'], idx: region },
      value: { enc: 'raw', v: value },
    },
    totals: { value: 'sum' },
    steps: [],
  } as TableSheet
}

const view = (sheet: Sheet, order?: number[] | null, extra: Partial<SheetView> = {}): SheetView =>
  ({ sheet, order: order ?? null, ...extra })

const opts = (over: Partial<PrintOptions> = {}): PrintOptions => ({ ...DEFAULT_OPTIONS, ...over })

/** The VISIBLE row numbers in the printout, in the order they were emitted.
 *  Only body rows carry a numbered gutter cell — a header is a `<th>` and the
 *  totals gutter is empty — so this counts exactly the rows a reader gets. */
const printedRows = (html: string): number[] =>
  [...html.matchAll(/<td class="dxpr-g">(\d+)<\/td>/g)].map((m) => Number(m[1]))

/** Every `<td>`'s text, per body row, for the first table in the output. */
function cellsOf(html: string): string[][] {
  const rows: string[][] = []
  for (const tr of html.matchAll(/<tr(?: class="([^"]*)")? style="height[^>]*>(.*?)<\/tr>/g)) {
    if (tr[1]?.includes('dxpr-tot')) continue
    const tds = [...tr[2].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) =>
      m[1].replace(/<[^>]*>/g, ''))
    if (tds.length) rows.push(tds)
  }
  return rows
}

/** The totals row's cell texts, or null. */
function totalsOf(html: string): string[] | null {
  const m = /<tr class="dxpr-tot"[^>]*>(.*?)<\/tr>/.exec(html)
  if (!m) return null
  return [...m[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]*>/g, '').trim())
}

// --- 1. the window must not reach the paper ----------------------------------
//
// 5,000 rows is two orders of magnitude past the ~40 the grid keeps in the DOM
// and past every overscan constant in it. If the print path ever grows a
// window, a viewport or a "first N rows" tier, this is the check that goes red.

const N = 5_000
const big = bigSheet(N)
const whole = buildPrintable(wb([big]), [view(big)], opts())
const rows = printedRows(whole.html)
ok(rows.length === N, `a ${N}-row sheet prints ${N} rows, not the window (got ${rows.length})`)
ok(whole.rows === N, 'the reported row count is the printed row count')
ok(rows[0] === 1 && rows[rows.length - 1] === N, 'the row numbers run 1…N with nothing missing')
ok(rows.every((r, i) => r === i + 1), 'the row numbers are contiguous — no gap anywhere in the middle')
ok(whole.html.includes('£5,000'), 'the LAST row’s value is on the page, not just the first screenful')

// --- 2. the view vector is the view -------------------------------------------

const small = bigSheet(8)
// A filter leaves rows 0, 2 and 5 (values 1, 3, 6); a sort would write a
// permutation of the same length. Both are one vector, and print reads it.
const filtered = buildPrintable(wb([small]), [view(small, [0, 2, 5])], opts())
const fRows = cellsOf(filtered.html)
ok(fRows.length === 3, 'a filtered view prints exactly the rows the filter left')
ok(fRows.map((r) => r[2]).join('|') === '£1|£3|£6',
  'and prints THOSE rows — the filtered-out values are nowhere on the page')
ok(fRows.map((r) => r[0]).join('|') === '1|2|3',
  'the gutter numbers the printed rows 1,2,3 — what the grid shows, not the rid')

const sorted = buildPrintable(wb([small]), [view(small, [7, 6, 5, 4, 3, 2, 1, 0])], opts())
ok(cellsOf(sorted.html).map((r) => r[2]).join('|') === '£8|£7|£6|£5|£4|£3|£2|£1',
  'a sort is a permutation of the same vector, and the paper is in that order')

const unsorted = buildPrintable(wb([small]), [view(small, null)], opts())
ok(cellsOf(unsorted.html).length === 8,
  'no vector means no filter — all eight rows, not zero (null is not an empty view)')

// --- 3. the total is the FILTERED total ---------------------------------------

const tot = totalsOf(filtered.html)
ok(tot !== null, 'a sheet that declares a total prints one')
ok(tot?.[2] === 'SUM £10',
  `the total covers the filtered rows only (1+3+6=10), not the column (36) — got ${tot?.[2]}`)
ok(totalsOf(whole.html)?.[2] === `SUM £${(N * (N + 1) / 2).toLocaleString()}`,
  'an unfiltered total is the whole column, and it is computed over every row')
// The same function the footer calls, over the same vector: two answers to one
// question is how the paper and the screen begin to differ.
const bySameMath = aggregate('sum', (i) => (i + 1), 3, [0, 2, 5])
ok(bySameMath === 10, 'the arithmetic is grid.ts `aggregate`, unchanged and shared with the footer')
ok(!/<tfoot/.test(filtered.html),
  'the totals row is in <tbody>: a <tfoot> repeats on every page and would total a partial column')
ok((filtered.html.match(/dxpr-tot/g) ?? []).length === 1,
  'and it appears exactly once per printed table')

// --- headers, which are the other half of a usable page -----------------------

ok((whole.html.match(/<thead>/g) ?? []).length === 1,
  'one <thead> per table — the group the renderer repeats on every page')
ok(/<tr[^>]*><th class="dxpr-g"><\/th><th>/.test(whole.html),
  'the header carries the columns, so page 40 still says what it is a column of')
ok(whole.html.includes('Region') && whole.html.includes('Value'),
  '…by name')

// --- 3b. THE PAGE HEADER REPEATS, which is what puts a date on page 27 --------
//
// A caption in a <div> above the table prints on page one and is never seen
// again; the same caption as the FIRST ROW of the thead prints on every page
// the table reaches, because `table-header-group` is what repeats a thead. That
// one structural fact is the whole of "repeat rows at top", so it is asserted
// structurally rather than by eye in a print preview.

const stamped = buildPrintable(wb([small]), [view(small)], opts(),
  new Date('2026-03-09T14:05:00Z'))
ok(stamped.html.includes('dxpr-caprow'),
  'the sheet caption is a row of the <thead>, so it repeats on every page')
ok(stamped.html.indexOf('dxpr-caprow') < stamped.html.indexOf('dxpr-g'),
  '…and it is the FIRST row, above the column names rather than below them')
ok(/<thead><tr class="dxpr-caprow"><th colspan="3">/.test(stamped.html),
  '…spanning the gutter and both columns, so a long title is not hyphenated into the gutter')
ok(/2026/.test(stamped.html) && /dxpr-when/.test(stamped.html),
  'the page header carries the date the printout was made — the thing a printed budget had no way to say')
ok(stamped.html.includes('dxpr-name">Pipeline'),
  '…beside the sheet name it has always carried')

// NEGATIVE CONTROL for the date: the SAME build with the header off must lose
// it. Without this the check above passes on any markup containing "2026",
// including a cell value that happens to be a year.
const bare = buildPrintable(wb([small]), [view(small)], opts({ header: false }),
  new Date('2026-03-09T14:05:00Z'))
ok(!bare.html.includes('dxpr-caprow') && !bare.html.includes('dxpr-when'),
  'Page header: None removes the header row and the date with it')
ok(bare.html.includes('Region'),
  '…and takes nothing else with it — the column names stay')
ok(buildPrintable(wb([small]), [view(small)], opts(), new Date('2026-03-09T14:05:00Z')).html
  === buildPrintable(wb([small]), [view(small)], opts(), new Date('2026-03-09T14:05:00Z')).html,
  'the builder is PURE: the date is an argument, so the same inputs give the same bytes')
ok(buildPrintable(wb([small]), [view(small)], opts(), new Date('2020-01-01T00:00:00Z')).html
  !== stamped.html,
  '…and a different date really does reach the markup (the control for the line above)')

// --- 3c. MARGINS are a choice, and one that does real work -------------------

const narrow = buildPrintable(wb([small]), [view(small)], opts({ margin: 'narrow' }))
const widem = buildPrintable(wb([small]), [view(small)], opts({ margin: 'wide' }))
ok(narrow.pageCss.includes('margin:10mm') && widem.pageCss.includes('margin:20mm'),
  'the margin choice reaches the @page rule, which is the only thing the renderer reads')
ok(pageBox(opts({ margin: 'narrow' })).w > pageBox(opts({ margin: 'wide' })).w,
  '…and the printable box follows it, so a narrow margin really does fit more column')
ok(Math.round(pageBox(opts({ margin: 'narrow' })).w - pageBox(opts({ margin: 'normal' })).w)
   === Math.round(2 * 2 * 96 / 25.4),
  '…by exactly twice the difference — a margin is on both edges')

// --- 4. no column may run off the right edge ----------------------------------

const A4P = pageBox(opts({ orientation: 'portrait', paper: 'a4' }))
const A4L = pageBox(opts({ orientation: 'landscape', paper: 'a4' }))
ok(Math.round(A4P.w) === Math.round((210 - 24) / 25.4 * 96),
  'the printable box is the paper less its margins, in CSS px')
ok(A4L.w > A4P.w, 'landscape is wider than portrait')

const widths = Array.from({ length: 40 }, () => 130)   // 40 columns of 130px
for (const mode of ['auto', 'fit', 'split'] as const) {
  const plan = planColumns(widths, A4P.w, mode)
  const placed = new Set<number>(plan.blocks.flat())
  ok(placed.size === widths.length,
    `${mode}: every column is placed on some page — none is silently dropped`)
  const widest = Math.max(...plan.blocks.map((b) =>
    _internals.GUTTER_W + b.reduce((n, i) => n + widths[i], 0)))
  ok(widest * plan.scale <= A4P.w + 0.5,
    `${mode}: no block is wider than the page — nothing is clipped off the right edge`)
}
ok(planColumns(widths, A4P.w, 'fit').blocks.length === 1,
  '“fit” is one page wide, however small that makes the type — the reader asked')
ok(planColumns(widths, A4P.w, 'auto').scale >= MIN_SCALE,
  '“auto” never shrinks past the legibility floor; it continues on later pages instead')
ok(planColumns(widths, A4P.w, 'split').scale === 1,
  '“split” is full size — the reader asked for that too')
ok(planColumns([130, 130], A4L.w, 'auto').blocks.length === 1
  && planColumns([130, 130], A4L.w, 'auto').scale === 1,
  'a sheet that already fits is printed at 1:1 and on one page across')

// A single column wider than the whole page: it cannot be split, so the job
// shrinks until it fits. Unconditional is the point — "nothing is clipped" with
// an exception is not a promise anybody can rely on.
const monster = planColumns([600, 600, 600], 300, 'split')
ok(Math.max(...monster.blocks.map((b) =>
  (_internals.GUTTER_W + b.reduce((n, i) => n + [600, 600, 600][i], 0)))) * monster.scale <= 300.5,
'one column wider than the paper shrinks the job rather than hanging off the edge')
ok(new Set(monster.blocks.flat()).size === 3, '…and still prints all three of them')

// The frozen columns are repeated on continuation blocks, because a page of
// bare numbers cannot be read against labels that are two pages back.
const keepPlan = planColumns(widths, A4P.w, 'split', [0])
ok(keepPlan.repeated.length === 1 && keepPlan.blocks.every((b) => b.includes(0)),
  'a frozen column repeats on every continuation page')
ok(keepPlan.blocks.reduce((n, b) => n + b.filter((i) => i === 0).length, 0) === keepPlan.blocks.length,
  '…once per block, never twice on the same one')
const greedyKeep = planColumns(widths, A4P.w, 'split', [0, 1, 2, 3, 4, 5])
ok(greedyKeep.repeated.length === 0,
  'a frozen prefix that would eat the page is not repeated — the repetition would BE the page')

// The whole-printout path, on a genuinely wide sheet.
const wide: TableSheet = {
  ...bigSheet(3),
  columns: Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, name: `Column ${i}`, type: 'number' as const })),
  data: Object.fromEntries(Array.from({ length: 30 }, (_, i) =>
    [`c${i}`, { enc: 'raw' as const, v: [i, i, i] }])),
  totals: undefined,
} as unknown as TableSheet
const wideOut = buildPrintable(wb([wide]), [view(wide)], opts({ orientation: 'portrait' }))
ok(wideOut.blocks > 1, 'a 30-column sheet on portrait A4 continues onto more pages')
for (let i = 0; i < 30; i++) {
  if (!wideOut.html.includes(`Column ${i}<`)) {
    ok(false, `column ${i} reached the paper`)
    break
  }
  if (i === 29) ok(true, 'every one of the 30 column headings reached the paper')
}
ok(/Columns 1–\d+ of 30/.test(wideOut.html),
  'each block says which columns it holds, so page 40 is identifiable')
ok(printedRows(wideOut.html).length === 3 * wideOut.blocks,
  'every block carries the WHOLE row set — a continuation page is columns, not rows')

// --- 5. both kinds print -------------------------------------------------------

const canvas: CanvasSheet = {
  id: 'cv1',
  name: 'Invoice',
  kind: 'canvas',
  cells: {
    A1: { v: 'Item', bold: true },
    B1: { v: 'Amount', bold: true },
    A2: { v: 'Design' },
    B2: { v: 1200, format: '$#,##0.00', color: '#a11' },
    A3: { v: 'Build' },
    B3: { v: 4300, bg: '#ffe9a8' },
    B4: { f: '=SUM(B2:B3)' },
  },
  cols: { B: 160 },
} as CanvasSheet
const cvOut = buildPrintable(wb([canvas]), [view(canvas)], opts())
ok(printedRows(cvOut.html).length === 4,
  'a spreadsheet prints its USED range — four rows, not the twenty the grid rules below them')
ok(cvOut.html.includes('Design') && cvOut.html.includes('$1,200.00'),
  '…with each cell’s own format applied, since a canvas cell is typed by cell')
ok(cvOut.html.includes('color:#a11') && cvOut.html.includes('background:#ffe9a8'),
  'a spreadsheet cell’s own colour reaches the paper — the grid paints it, so print must')
ok(cvOut.html.includes('font-weight:600'), '…and so does its weight')
ok(/<th class="dxpr-g">A<\/th>/.test(cvOut.html),
  'the column letters are the header, which is how a reader tells the kind apart')

// The formula cell. Without the workbook recalculation it is blank, which is
// the honest answer; with it, the number prints.
const withValues = buildPrintable(wb([canvas]), [view(canvas, null, {
  // cellKey is `col,row` (cellformula.ts) — B4 is column 1, row 3.
  cellValues: new Map([['1,3', 5500]]),
})], opts())
ok(withValues.html.includes('5500') || withValues.html.includes('5,500'),
  'a spreadsheet formula prints its computed value when one was supplied')
ok(!cvOut.html.includes('5500'),
  '…and prints EMPTY, never a zero, when it was not — a blank reads as unknown, a 0 is a lie')

const emptyCanvas = buildPrintable(
  wb([{ id: 'e', name: 'Blank', kind: 'canvas', cells: {} } as CanvasSheet]),
  [view({ id: 'e', name: 'Blank', kind: 'canvas', cells: {} } as CanvasSheet)], opts())
ok(emptyCanvas.rows === 0 && emptyCanvas.html.includes('Nothing to print'),
  'an empty sheet says so rather than printing an empty ruled grid')

// --- 6. formats, colours and conditional formats -------------------------------

const cf: TableSheet = {
  ...bigSheet(4),
  condfmt: {
    value: [{ kind: 'cellValue', op: '>', value: 2, style: { bg: '#fde2e2', bold: true } }],
  },
} as unknown as TableSheet
const cfOut = buildPrintable(wb([cf]), [view(cf)], opts())
ok((cfOut.html.match(/background:#fde2e2/g) ?? []).length === 2,
  'a conditional format reaches the paper on exactly the cells it applies to')
// Evaluated over the WHOLE column even when the view is filtered — a colour
// scale needs the real min and max, so a rescaled ramp would recolour the same
// data every time somebody clicked a filter.
const cfFiltered = buildPrintable(wb([cf]), [view(cf, [3])], opts())
ok((cfFiltered.html.match(/background:#fde2e2/g) ?? []).length === 1,
  '…and is evaluated over the whole column, so a filter does not repaint the data')

ok(styleColor('#fff}body{display:none') === null,
  'a colour that would close the rule and write new ones is refused, not "cleaned"')
ok(styleColor('url(https://x/y)') === null,
  'a colour that would phone home from a self-contained file is refused (PLATFORM §1)')
ok(styleColor('rgb(1, 2, 3)') === 'rgb(1, 2, 3)', 'an ordinary colour is kept verbatim')
const hostile: TableSheet = {
  ...bigSheet(1),
  condfmt: { value: [{ kind: 'cellValue', op: '>', value: 0, style: { bg: '#fff;position:fixed' } }] },
} as unknown as TableSheet
ok(!buildPrintable(wb([hostile]), [view(hostile)], opts()).html.includes('position:fixed'),
  'a hostile colour never reaches the style attribute')

// Author text is markup-escaped: a cell value is data, and the printout is HTML.
const nasty: TableSheet = {
  ...bigSheet(1),
  columns: [{ id: 'region', name: '<b>Region</b>', type: 'text' }],
  data: { region: { enc: 'raw', v: ['<img src=x onerror=alert(1)>'] } },
  totals: undefined,
} as unknown as TableSheet
const nastyOut = buildPrintable(wb([nasty]), [view(nasty)], opts()).html
ok(!nastyOut.includes('<img') && nastyOut.includes('&lt;img'),
  'a cell value is escaped — the printout is markup and the value is data')
ok(!nastyOut.includes('<b>Region</b>') && nastyOut.includes('&lt;b&gt;Region'),
  '…and so is a column name')

// A hidden column is hidden on paper too: the printout shows the VIEW.
const hiddenCol: TableSheet = {
  ...bigSheet(2),
  columns: [
    { id: 'region', name: 'Region', type: 'text' },
    { id: 'value', name: 'Value', type: 'money', hidden: true },
  ],
} as unknown as TableSheet
ok(!buildPrintable(wb([hiddenCol]), [view(hiddenCol)], opts()).html.includes('Value'),
  'a hidden column stays hidden — print shows what the grid shows')

// A formula column has no stored values. Given the grid's computed map it
// prints the numbers; without one it must not print zeros.
const formulaSheet: TableSheet = {
  ...bigSheet(3),
  columns: [
    { id: 'value', name: 'Value', type: 'money' },
    { id: 'dbl', name: 'Double', type: 'number', formula: 'Value * 2' },
  ],
  totals: undefined,
} as unknown as TableSheet
const computed = new Map([['dbl', [2, 4, 6]]])
const fOut = buildPrintable(wb([formulaSheet]), [view(formulaSheet, null, { computed })], opts()).html
ok(fOut.includes('>2<') && fOut.includes('>6<'), 'a formula column prints the grid’s computed values')
ok(fOut.includes('fx'), '…and is marked computed, so an empty one reads as derived rather than blank')

// A per-cell override beats the stored value, exactly as the grid orders it.
const over: TableSheet = {
  ...bigSheet(2),
  cells: { 'value:1': { v: 999, note: 'corrected' } },
} as unknown as TableSheet
const overOut = buildPrintable(wb([over]), [view(over)], opts()).html
ok(overOut.includes('£999'), 'a hand correction prints, not the value it replaced')
ok(overOut.includes('dxpr-note'), '…and the fact that somebody left a note on it is visible')

// --- the page box --------------------------------------------------------------

ok(buildPrintable(wb([small]), [view(small)], opts({ paper: 'a4', orientation: 'landscape' }))
  .pageCss === '@page{size:297mm 210mm;margin:12mm}',
'the @page rule is generated per job — the paper the reader picked, landscape')
ok(buildPrintable(wb([small]), [view(small)], opts({ paper: 'letter', orientation: 'portrait' }))
  .pageCss.includes('215.9mm 279.4mm'), 'Letter portrait, likewise')
ok(PAPERS.length >= 2 && PAPERS.some((p) => p.id === 'a4') && PAPERS.some((p) => p.id === 'letter'),
  'both of the papers most of the world prints on are offered')

// --- collectViews reads the store, and the scope ---------------------------------

const two = wb([bigSheet(4), { ...bigSheet(3), id: 'sh2', name: 'Costs' } as TableSheet])
const store = new Store(two)
store.order.sh1 = [1, 2]
ok(collectViews(store, 'sheet', { id: 'sh1' }).length === 1, 'scope “sheet” prints one sheet')
ok(collectViews(store, 'workbook', { id: 'sh1' }).length === 2, 'scope “workbook” prints them all')
ok(collectViews(store, 'sheet', { id: 'sh1' })[0].order?.length === 2,
  'the view vector comes from store.order — the same object the footer and Find read')
ok(collectViews(store, 'workbook', { id: 'sh1' })[1].order === null,
  'a sheet nobody filtered has no vector, which is not the same as an empty one')
ok(collectViews(store, 'sheet', { id: 'sh1' })[0].status?.includes('2 of 4'),
  'the caption is `viewStatusText` — the status bar’s own sentence, word for word')
const both = buildPrintable(two, collectViews(store, 'workbook', { id: 'sh1' }), opts())
ok(both.sheets === 2 && printedRows(both.html).length === 2 + 3,
  'printing the workbook prints each sheet’s own view: 2 filtered rows + 3')
ok(both.html.includes('Pipeline') && both.html.includes('Costs'), '…each under its own name')

// A pivot sheet holds a SPEC and no numbers (model.ts), so there is nothing to
// print; it must be skipped rather than crash the job or print an empty table.
const withPivot = new Store(wb([bigSheet(2), { id: 'p1', name: 'P', kind: 'pivot', pivot: {} } as Sheet]))
ok(collectViews(withPivot, 'workbook', null).length === 1,
  'a pivot sheet is skipped — it holds a spec, not rows')

// --- 7. size ---------------------------------------------------------------------
//
// 50,000 rows is a fifth of ROW_WARN and comfortably past where an accidental
// `Math.min(...vals)` or a per-row array spread stops being slow and starts
// being a RangeError (dashboard.ts:741 carries exactly that hazard).

const huge = bigSheet(50_000)
const t0 = Date.now()
const hugeOut = buildPrintable(wb([huge]), [view(huge)], opts())
const ms = Date.now() - t0
ok(printedRows(hugeOut.html).length === 50_000,
  `50,000 rows all reach the paper, with no stack overflow (built in ${ms}ms)`)
ok(totalsOf(hugeOut.html)?.[2] === `SUM £${(50_000 * 50_001 / 2).toLocaleString()}`,
  'and the total over 50,000 rows is right')
ok(ms < 10_000, `the build is a wait, not a hang (${ms}ms)`)
ok(hugeOut.pages > 100 && Number.isFinite(hugeOut.pages),
  'the page estimate is a finite number the dialog can warn with')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
