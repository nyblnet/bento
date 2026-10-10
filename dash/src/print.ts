// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Print and PDF export — the whole view on paper, not the window.
//
// WHY THIS IS NOT A STYLESHEET. The grid is WINDOWED (grid.ts): forty-odd rows
// of a five-thousand-row sheet exist in the DOM at any moment, and the two
// spacer rows that hold the scrollbar honest hold nothing a printer can read.
// A `@media print` block over that surface prints whatever happened to be
// scrolled into view and omits the rest — and it omits it INVISIBLY, because
// the page that comes out has a header row, a body and a totals line and looks
// finished. A spreadsheet that quietly drops rows is a wrong answer wearing a
// right answer's clothes, which is the failure this whole application exists to
// refuse. So printing builds a SECOND, un-windowed rendering of the view and
// prints that.
//
// ═══ WHAT THE PRINTOUT IS OF ═════════════════════════════════════════════════
//
// THE VIEW VECTOR, and nothing else. `store.order[sheetId]` is the single
// source of truth for which rows are showing and in what order (store.ts
// `view()`); the footer totals, the chart, Find and the status bar all read it.
// A printout that read `sheet.rids` instead would disagree with every one of
// them the moment somebody filtered — and it would disagree in the direction
// that hands a reader rows they had just excluded. So the row loop indexes
// `order`, the totals pass `order` to the same `aggregate` the footer calls,
// and the caption is `viewStatusText`, which is the exact sentence in the
// status bar. Three readouts, one function each, no second opinion.
//
// This is also why print takes the grid's `computed` map rather than
// recalculating behind it: a formula column is derived, and two derivations of
// one column is how the paper and the screen start to differ.
//
// ═══ THE WIDE-SHEET ANSWER ═══════════════════════════════════════════════════
//
// A column must never be silently clipped off the right edge — that is the same
// class of loss as the missing rows, and worse, because a clipped column takes
// its heading with it and the page looks complete. Two answers exist and
// `planColumns` uses BOTH, in this order:
//
//   1. SHRINK, but only as far as reading survives. Everything scales from one
//      number, applied to the emitted widths and font size — never a CSS
//      `transform`, which paginates as one unbreakable box and would slice the
//      table at the first page boundary. `MIN_SCALE` is 0.7 because the base
//      type is 11px: 70% is 7.7px, a shade under 6pt, and a shrink past that
//      is not reading, it is evidence that the page was the wrong shape.
//   2. CONTINUE ON LATER PAGES. Past the floor the columns are split into
//      BLOCKS, each block a whole table of its own with the full row set, its
//      own repeated header and its own totals — and each carrying the row
//      gutter and the sheet's FROZEN columns again, so a continuation page can
//      still be read against its labels. Every block is captioned "Columns
//      9–14 of 22", so a reader holding page 40 knows what they are holding.
//
// The invariant, which the rig pins: every visible column appears in at least
// one block, and no block is wider than the page. Nothing is ever dropped and
// nothing ever runs off the edge.
//
// ═══ PAGINATION IS THE BROWSER'S ════════════════════════════════════════════
//
// Rows are not paginated here. `thead { display: table-header-group }` is what
// repeats a column header on every page, and it is the ONLY mechanism that
// gets it right across engines; hand-cut pages of N rows each are wrong the
// moment a row wraps, a printer's margins differ or the reader picks a
// different paper size in the system dialog. What this file owns is that the
// row set is COMPLETE and the columns FIT; where the paper is torn is the
// renderer's job, helped by `break-inside: avoid` on every row.
//
// The totals row is the last row of `<tbody>`, deliberately NOT a `<tfoot>`:
// a footer group repeats on every page, and a page-3-of-40 line reading
// "SUM £4,182,900" under a partial column of numbers is a total of something
// nobody asked for.
//
// ═══ WHAT IS NOT HERE ════════════════════════════════════════════════════════
//
// No page numbers, and that decision is UNCHANGED after being re-argued.
// `@page { @bottom-right { content: counter(page) } }` is CSS Paged Media and
// no browser implements the margin boxes; the system print dialog's own
// headers and footers are where page numbers come from, and inventing a second
// set that disagrees with them is worse than none. What was wrong was not the
// decision but the SILENCE around it — a reader who wants "Page 3 of 40" was
// left to conclude the feature is missing rather than that it lives one dialog
// along, so the Print dialog now says where to find it.
//
// WHAT THE PAGE HEADER DOES CARRY, on every page rather than once per sheet:
// the sheet name, the workbook title, the view sentence and the DATE. It is
// the first row of the `<thead>`, which is to say it repeats by the same
// `table-header-group` mechanism that repeats the column names — Excel's "rows
// to repeat at top", built out of the one thing that works across engines.
// A caption in a `<div>` above the table, which is what this used to be,
// appears on page one and is never seen again.
//
// Table-sheet per-cell colours (`CellOverride.color/bg/bold`) are NOT painted,
// because the grid does not paint them either (grid.ts's table path applies
// conditional formats only). Printing something the screen does not show is the
// same defect as printing less than the screen shows, pointed the other way.
// Spreadsheet cells DO carry theirs, because there the grid paints them.
//
// Everything down to `openPrintDialog` is pure and DOM-free, which is what
// `scripts/test-dash-print.ts` drives: the row completeness, the column
// planning and the totals arithmetic are all decisions, and a decision checked
// by eye in a print preview is a decision nobody checks twice.

import './print.css'
import { t } from './i18n.ts'
import { formatValue, alignFor, TYPE_LABEL } from './format.ts'
import { readCell, type Store } from './store.ts'
import { hiddenSet, readFrozen } from './rowcol.ts'
import { colToLetters } from './a1.ts'
import { recalc, isErr, type Vec } from './formula.ts'
import { evaluateRules, type CellStyle } from './condfmt.ts'
import {
  aggregate, NO_TOTAL, canvasAlign, canvasKey, canvasShown, canvasUsed, viewStatusText,
  type TotalSpec,
} from './grid.ts'
import { cellKey, recalcWorkbook, workbookSources } from './cellformula.ts'
import type {
  CanvasCell, CanvasSheet, Column, DashDoc, Sheet, TableSheet,
} from './model.ts'

// --- paper -------------------------------------------------------------------

export interface Paper {
  id: string
  label: string
  /** millimetres, PORTRAIT — orientation swaps them at use */
  w: number
  h: number
}

/** The two everybody has, plus the one a wide model actually wants. */
export const PAPERS: readonly Paper[] = [
  { id: 'a4', label: 'A4', w: 210, h: 297 },
  { id: 'letter', label: 'Letter', w: 215.9, h: 279.4 },
  { id: 'a3', label: 'A3', w: 297, h: 420 },
] as const

/**
 * Millimetres of margin on every edge, by choice. 10mm is the floor: under it
 * consumer printers clip, and a margin that loses the last column is the same
 * defect as a column planner that drops one.
 *
 * The choice is real work rather than decoration — `pageBox` shrinks with it,
 * so a narrow margin puts more columns in a block, changes the shrink factor
 * and moves the page estimate. It is the one knob a reader has when a sheet is
 * one column wider than the paper.
 */
export const MARGINS: Readonly<Record<string, number>> = {
  narrow: 10, normal: 12, wide: 20,
}

/** The default, and the number the `@page` rule used to be fixed at. */
export const MARGIN_MM = MARGINS.normal

/** CSS px per millimetre: 96 dpi over 25.4mm to the inch, which is the pixel
 *  the `@page` box is measured in whatever the printer's real dots are. */
export const PX_PER_MM = 96 / 25.4

export type Orientation = 'portrait' | 'landscape'
/** How a sheet wider than the paper is dealt with — see the header. */
export type WideMode = 'auto' | 'fit' | 'split'
export type Scope = 'sheet' | 'workbook'
export type MarginChoice = 'narrow' | 'normal' | 'wide'

export interface PrintOptions {
  paper: string
  orientation: Orientation
  wide: WideMode
  scope: Scope
  margin: MarginChoice
  /** the repeating page header — see `captionRow` */
  header: boolean
}

export const DEFAULT_OPTIONS: PrintOptions = {
  paper: 'a4', orientation: 'landscape', wide: 'auto', scope: 'sheet',
  // The header defaults ON because the caption it replaces was unconditional:
  // a printout that lost its sheet name in an upgrade is a regression, not a
  // new default.
  margin: 'normal', header: true,
}

const marginOf = (o: PrintOptions): number => MARGINS[o.margin] ?? MARGIN_MM

const paperOf = (id: string): Paper => PAPERS.find((p) => p.id === id) ?? PAPERS[0]

/** The printable box, in CSS px. */
export function pageBox(opts: PrintOptions): { w: number; h: number } {
  const p = paperOf(opts.paper)
  const w = opts.orientation === 'landscape' ? p.h : p.w
  const h = opts.orientation === 'landscape' ? p.w : p.h
  const m = marginOf(opts)
  return {
    w: (w - m * 2) * PX_PER_MM,
    h: (h - m * 2) * PX_PER_MM,
  }
}

// --- geometry ----------------------------------------------------------------

/** Base metrics at scale 1. Denser than the screen: paper has no scrollbar and
 *  a row you can see all of is worth more than a row you can click. */
const FONT_PX = 11
const ROW_H = 18
const HEAD_H = 24
/** The row-number gutter. Narrower than the grid's 52px — no selection to show. */
const GUTTER_W = 34
/** The sheet caption block above each table, for the page-count estimate. */
const CAPTION_H = 46

/**
 * How far the type may shrink before splitting is the better answer.
 * 0.7 × 11px is 7.7px, a shade under 6pt. See the header.
 */
export const MIN_SCALE = 0.7

/** A column width safe to compute with — `Column.w` is `unknown` in a file.
 *  preview.ts's `colW`, and for the same reason: one NaN reaches the layout
 *  and takes the whole printout with it. */
const colW = (c: Column): number =>
  typeof c.w === 'number' && Number.isFinite(c.w)
    ? Math.min(600, Math.max(40, Math.round(c.w)))
    : 130

/** A spreadsheet column's width. `cols` is keyed by LETTER (model.ts). */
const canvasColW = (s: CanvasSheet, ci: number): number => {
  const v = s.cols?.[colToLetters(ci)]
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(600, Math.max(24, Math.round(v)))
    : 100
}

const canvasRowH = (s: CanvasSheet, r: number): number => {
  const v = s.rows?.[String(r + 1)]
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(400, Math.max(10, Math.round(v)))
    : ROW_H
}

export interface ColumnPlan {
  /** One multiplier for every emitted width and font size. Never a transform. */
  scale: number
  /** Column INDEXES (into the visible column list) per printed block. */
  blocks: number[][]
  /** Frozen columns repeated on continuation blocks, if they were cheap enough. */
  repeated: number[]
}

/**
 * Fit `widths` into `avail`, by shrinking, splitting, or both.
 *
 * PURE, and the reason the wide-sheet promise is checkable at all: the two
 * things that must hold — every column placed, no block wider than the page —
 * are properties of this return value and of nothing else.
 *
 * `keep` is the frozen-column prefix. It is repeated on every continuation
 * block so a page of numbers still has its labels, but only while it costs
 * under `KEEP_BUDGET` of the page: past that the repetition IS the page and
 * the reader is worse off than with bare numbers.
 */
const KEEP_BUDGET = 0.4

export function planColumns(
  widths: number[], avail: number, mode: WideMode, keep: number[] = [],
): ColumnPlan {
  const all = widths.map((_, i) => i)
  if (!widths.length) return { scale: 1, blocks: [[]], repeated: [] }
  const sum = (list: number[]): number =>
    list.reduce((n, i) => n + widths[i], 0)
  const natural = GUTTER_W + sum(all)

  if (natural <= avail && mode !== 'split') return { scale: 1, blocks: [all], repeated: [] }
  if (mode === 'fit') {
    // Asked for one page wide, and no floor: the reader said so. Still never
    // clipped — the scale is exact, so the last column lands on the paper.
    return { scale: Math.min(1, avail / natural), blocks: [all], repeated: [] }
  }

  // AUTO shrinks to the floor first and splits only if that was not enough.
  // SPLIT never shrinks: the reader asked for actual size.
  const scale = mode === 'split'
    ? 1
    : Math.max(MIN_SCALE, Math.min(1, avail / natural))
  if (mode === 'auto' && natural * scale <= avail) {
    return { scale, blocks: [all], repeated: [] }
  }

  // Blocks, measured at the chosen scale.
  const keepSet = new Set(keep.filter((i) => i >= 0 && i < widths.length))
  const repeated = sum([...keepSet]) * scale <= avail * KEEP_BUDGET
    ? [...keepSet].sort((a, b) => a - b)
    : []
  const fixed = (GUTTER_W + sum(repeated)) * scale

  const blocks: number[][] = []
  let cur: number[] = []
  let width = GUTTER_W * scale
  for (const i of all) {
    const w = widths[i] * scale
    // A repeated column rides every block; it must not also be placed on its
    // own, or it would print twice on the block it belongs to.
    if (repeated.includes(i)) continue
    if (cur.length && width + w > avail) {
      blocks.push(cur)
      cur = []
      width = fixed
    }
    cur.push(i)
    width += w
  }
  if (cur.length) blocks.push(cur)
  if (!blocks.length) blocks.push([])

  // Put the repeated columns back at the head of every block, in column order.
  const withKeep = blocks.map((b) => [...repeated, ...b].sort((a, b2) => a - b2))

  // THE LAST GUARANTEE. One column can be wider than the page all by itself —
  // a 600px note column on portrait A4 — and a block holding it would print
  // off the edge. Nothing may be clipped, so the whole job shrinks until the
  // widest block fits. Rare, deliberate, and it is why the promise is
  // unconditional.
  let widest = 0
  for (const b of withKeep) widest = Math.max(widest, GUTTER_W + sum(b))
  const fitted = widest * scale <= avail ? scale : avail / widest
  return { scale: fitted, blocks: withKeep, repeated }
}

// --- reading a sheet ----------------------------------------------------------

/**
 * One sheet as the reader is seeing it.
 *
 * `order` is `store.order[sheet.id]` verbatim — null/undefined means "no filter
 * and no sort", which is not the same as an empty view and must not be confused
 * with one.
 */
export interface SheetView {
  sheet: Sheet
  order?: number[] | null
  /** the grid's formula columns, or freshly recalculated for an off-screen sheet */
  computed?: Map<string, Vec>
  /** per-cell formula results, keyed `cellKey(canonicalRow, columnIndex)` */
  cellValues?: ReadonlyMap<string, unknown>
  /** the status bar's own sentence about this view */
  status?: string
}

const rowsOf = (s: TableSheet): number => s.rids.reduce((n, [, c]) => n + c, 0)

/** Canonical row index → rid, expanded ONCE. The row loop then indexes it. */
function expandRids(sheet: TableSheet): number[] {
  const out: number[] = []
  for (const [start, count] of sheet.rids) {
    for (let i = 0; i < count; i++) out.push(start + i)
  }
  return out
}

const hasCellFormulas = (sheet: Sheet): boolean => {
  if (sheet.kind === 'table') {
    const cells = (sheet as TableSheet).cells
    for (const k in cells) if (typeof cells[k]?.f === 'string' && cells[k]!.f !== '') return true
    return false
  }
  if (sheet.kind === 'canvas') {
    const cells = (sheet as CanvasSheet).cells
    for (const k in cells) if (typeof cells[k]?.f === 'string' && cells[k]!.f !== '') return true
  }
  return false
}

/**
 * The views to print, assembled from the store.
 *
 * DOM-FREE, so the rig drives the same path the button does. `shown` supplies
 * the grid's already-computed formula columns for the sheet on screen: the grid
 * has them, they cost a full pass to rebuild, and a second derivation of one
 * column is how the paper and the screen start to disagree.
 */
export function collectViews(
  store: Store,
  scope: Scope,
  shown: { id: string; computed?: Map<string, Vec> } | null,
): SheetView[] {
  const doc = store.doc
  const wanted = (doc.sheets ?? []).filter((s) =>
    (s.kind === 'table' || s.kind === 'canvas')
    && (scope === 'workbook' || s.id === shown?.id))

  // Column formulas first: the cell-formula pass reads them for `=B4*Margin`.
  const computed = new Map<string, Map<string, Vec>>()
  for (const s of wanted) {
    if (s.kind !== 'table') continue
    const table = s as TableSheet
    if (shown && s.id === shown.id && shown.computed) { computed.set(s.id, shown.computed); continue }
    if (!table.columns.some((c) => c.formula)) continue
    // Never throws: a broken expression is an error VALUE in a cell, and a
    // printout is not the place to discover the engine can decline.
    try {
      computed.set(s.id, recalc(table, doc.modified).values)
    } catch { /* the column prints from its stored data, which is honest */ }
  }

  // Per-cell formulas are a WORKBOOK graph (`=Sales!C2`), so they are computed
  // once for the file rather than once per sheet — the same call main.ts makes
  // for the promote bridge.
  let cells: Map<string, { values: ReadonlyMap<string, unknown> }> | null = null
  if ((doc.sheets ?? []).some(hasCellFormulas)) {
    try {
      cells = recalcWorkbook(
        workbookSources(doc, (tb) => computed.get(tb.id)),
        doc.modified,
      ) as unknown as Map<string, { values: ReadonlyMap<string, unknown> }>
    } catch { cells = null }
  }

  return wanted.map((sheet) => {
    const order = store.order[sheet.id] ?? null
    const status = sheet.kind === 'table'
      ? viewStatusText(order ? order.length : null, rowsOf(sheet as TableSheet), [])
      : ''
    return {
      sheet,
      order,
      computed: computed.get(sheet.id),
      cellValues: cells?.get(sheet.id)?.values,
      status,
    }
  })
}

// --- markup ------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/**
 * A colour safe to put in a `style` attribute. preview.ts's `cssColor`, and the
 * same reason: conditional-format and cell colours are author data, an
 * attribute is CSS, and `;` and `}` are what matter there rather than `<`.
 * Re-stated rather than imported so print carries no dependency on the
 * thumbnail's byte budgeting.
 */
export function styleColor(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || s.length > 32) return null
  if (!/^[#a-zA-Z0-9(),.%\s/-]+$/.test(s)) return null
  if (/url|expression|@|\\/i.test(s)) return null
  return s
}

const AGG_LABEL: Record<string, string> = {
  sum: 'SUM', avg: 'AVG', count: 'COUNT', min: 'MIN', max: 'MAX',
}

const nf = (n: number): string => n.toLocaleString()

/** One `<td>`'s inline style, from a conditional format. */
function cellStyle(cf: CellStyle | null | undefined): string {
  if (!cf) return ''
  let out = ''
  const bg = styleColor(cf.bg)
  const fg = styleColor(cf.color)
  if (bg) out += `background:${bg};`
  if (fg) out += `color:${fg};`
  if (cf.bold) out += 'font-weight:600;'
  if (cf.italic) out += 'font-style:italic;'
  return out
}

interface Metrics {
  scale: number
  font: number
  row: number
  head: number
  gutter: number
}

const metricsFor = (scale: number): Metrics => ({
  scale,
  font: Math.round(FONT_PX * scale * 10) / 10,
  row: Math.max(9, Math.round(ROW_H * scale)),
  head: Math.max(12, Math.round(HEAD_H * scale)),
  gutter: Math.max(16, Math.round(GUTTER_W * scale)),
})

/** The caption over one table: sheet name, what the view is, which columns. */
function caption(
  doc: DashDoc, name: string, status: string, block: string, when?: string,
): string {
  const bits = [status, block].filter(Boolean).join('  ·  ')
  return `<div class="dxpr-cap">` +
    `<span class="dxpr-name">${esc(name || t('(untitled sheet)'))}</span>` +
    `<span class="dxpr-title">${esc(doc.title || '')}</span>` +
    (bits ? `<span class="dxpr-view">${esc(bits)}</span>` : '') +
    (when ? `<span class="dxpr-when">${esc(when)}</span>` : '') +
    `</div>`
}

/**
 * The date on the printout, in the VIEWER's locale.
 *
 * Taken from an argument rather than from `new Date()` inside the builder, so
 * `buildPrintable` stays a pure function of its inputs: a rig that could not
 * pin the date could not assert on the markup at all, and a printout is not the
 * place to discover the one impure line.
 */
const stamp = (when: Date): string => {
  try {
    return when.toLocaleString(undefined,
      { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return when.toISOString().slice(0, 16).replace('T', ' ') }
}

/**
 * THE PAGE HEADER: the caption, as the first row of the `<thead>`.
 *
 * That one move is the whole of "repeat rows at top". A `<div>` above the table
 * prints once, on the page the table starts on; a `<thead>` row prints on every
 * page the table reaches, by the same `table-header-group` rule that repeats
 * the column names, which is the only mechanism that behaves across engines
 * (see the file header). So page 27 of a budget now names the sheet, the
 * workbook, the view it is a view OF, and the day it was printed.
 *
 * It is a `th` spanning the whole table because a header row that did not span
 * would be laid out against the column widths and hyphenate the workbook title
 * into the row-number gutter.
 */
function captionRow(cols: number, inner: string): string {
  return `<tr class="dxpr-caprow"><th colspan="${cols + 1}">${inner}</th></tr>`
}

/** "Columns 9–14 of 22", or '' when the sheet fitted in one block. */
const blockLabel = (from: number, to: number, total: number, split: boolean): string =>
  split ? t('Columns {from}–{to} of {total}', { from: from + 1, to: to + 1, total }) : ''

/**
 * A dataset sheet, as one table per column block.
 *
 * THE ROW LOOP IS THE POINT. It runs the whole view vector, once per block,
 * with no window anywhere in it.
 */
function tableMarkup(
  doc: DashDoc, view: SheetView, opts: PrintOptions, box: { w: number }, when: string,
): { html: string; rows: number; blocks: number } {
  const sheet = view.sheet as TableSheet
  const hidden = hiddenSet(sheet)
  const vis = sheet.columns.filter((c) => !hidden.has(c.id))
  const all = rowsOf(sheet)
  const order = view.order ?? null
  const n = order ? order.length : all

  if (!vis.length || !n) {
    return {
      html: `<section class="dxpr-sheet">${opts.header ? caption(doc, sheet.name, view.status ?? '', '', when) : ''}` +
        `<p class="dxpr-empty">${esc(t('Nothing to print — this sheet is empty.'))}</p></section>`,
      rows: 0, blocks: 1,
    }
  }

  const plan = planColumns(
    vis.map(colW), box.w, opts.wide,
    // The frozen columns are the sheet's own answer to "which columns must stay
    // in view when the rest scrolls away", so they are the right ones to repeat
    // when the rest goes onto another page.
    Array.from({ length: Math.min(readFrozen(sheet).cols, vis.length) }, (_, i) => i),
  )
  const m = metricsFor(plan.scale)
  const rids = expandRids(sheet)

  // Conditional formats over the WHOLE column, exactly as the grid evaluates
  // them: a colour scale needs the real min and max, so evaluating only the
  // rows the filter leaves would recolour the same data on every click.
  const styles = new Map<string, Array<CellStyle | null>>()
  const rules = (sheet as unknown as { condfmt?: Record<string, unknown[]> }).condfmt
  if (rules) {
    for (const c of vis) {
      const rs = rules[c.id]
      if (!Array.isArray(rs) || !rs.length) continue
      const comp = view.computed?.get(c.id)
      const vals: unknown[] = new Array(all)
      for (let i = 0; i < all; i++) vals[i] = comp ? comp[i] : readCell(sheet.data[c.id], i)
      try {
        styles.set(c.id, evaluateRules(rs as never, vals))
      } catch { /* a rule this build cannot run leaves the column plain */ }
    }
  }

  /** The grid's own precedence: cell formula, then column formula, then a hand
   *  override, then the stored value (grid.ts `paint`). */
  const valueAt = (c: Column, ci: number, r: number, rid: number): unknown => {
    if (view.cellValues) {
      const k = cellKey(r, ci)
      if (view.cellValues.has(k)) return view.cellValues.get(k)
    }
    const comp = view.computed?.get(c.id)
    if (comp) return comp[r]
    const over = sheet.cells?.[`${c.id}:${rid}`]
    if (over && 'v' in over) return over.v
    return readCell(sheet.data[c.id], r)
  }

  const out: string[] = []
  const multi = plan.blocks.length > 1
  plan.blocks.forEach((block) => {
    const columns = block.map((i) => vis[i])
    // The ABSOLUTE index in `sheet.columns`, which is what a cell formula's
    // position is counted in — hidden columns included (grid.ts says why).
    const absolute = block.map((i) => sheet.columns.indexOf(vis[i]))
    const width = m.gutter + columns.reduce((w, c) => w + Math.round(colW(c) * m.scale), 0)

    const parts: string[] = []
    parts.push(`<section class="dxpr-sheet">`)
    parts.push(`<table class="dxpr-t" style="width:${width}px;font-size:${m.font}px">`)
    parts.push(`<colgroup><col style="width:${m.gutter}px">` +
      columns.map((c) => `<col style="width:${Math.round(colW(c) * m.scale)}px">`).join('') +
      `</colgroup>`)

    parts.push('<thead>')
    if (opts.header) {
      parts.push(captionRow(columns.length, caption(doc, sheet.name, view.status ?? '',
        blockLabel(block[0], block[block.length - 1], vis.length, multi), when)))
    }
    parts.push(`<tr style="height:${m.head}px"><th class="dxpr-g"></th>` +
      columns.map((c) =>
        `<th><span class="dxpr-h">${esc(c.name || c.id)}</span>` +
        // The same argument expression grid.ts's header uses, deliberately: the
        // i18n rig cannot see through a t() whose argument is not a literal, so
        // each indirect call site is DECLARED by its expression, and a second
        // spelling of this one would be a second declaration to keep in step.
        `<span class="dxpr-type">${esc(t(TYPE_LABEL[c.type]))}</span>` +
        (c.formula ? `<span class="dxpr-fx">fx</span>` : '') +
        `</th>`).join('') + `</tr></thead>`)

    parts.push('<tbody>')
    for (let i = 0; i < n; i++) {
      const r = order ? order[i] : i
      const rid = rids[r] ?? -1
      const cells: string[] = []
      for (let k = 0; k < columns.length; k++) {
        const c = columns[k]
        const v = valueAt(c, absolute[k], r, rid)
        const cf = styles.get(c.id)?.[r] ?? null
        const over = sheet.cells?.[`${c.id}:${rid}`]
        const st = `text-align:${alignFor(c.type)};${cellStyle(cf)}`
        const shown = isErr(v) ? String(v) : formatValue(v, c)
        cells.push(`<td style="${st}"${isErr(v) ? ' class="dxpr-err"' : ''}>` +
          `${esc(shown)}${over?.note ? '<span class="dxpr-note">•</span>' : ''}</td>`)
      }
      // The gutter carries the VISIBLE row number, which is what the grid shows
      // and what a reader would call out — not the rid, which is identity.
      parts.push(`<tr style="height:${m.row}px"><td class="dxpr-g">${i + 1}</td>${cells.join('')}</tr>`)
    }

    // THE TOTALS ROW, over the rows the filter leaves showing. Same `aggregate`
    // the footer calls, same `order` vector, so the paper cannot say a number
    // the screen does not (grid.ts `totalsRow` for the bug this repeats).
    if (sheet.totals) {
      const tds = columns.map((c) => {
        const spec = sheet.totals?.[c.id] as TotalSpec | undefined
        if (!spec) return `<td></td>`
        const comp = view.computed?.get(c.id)
        const value = aggregate(spec, (idx) => (comp ? comp[idx] : readCell(sheet.data[c.id], idx)), n, order)
        const label = typeof spec === 'string' ? (AGG_LABEL[spec] ?? spec.toUpperCase()) : 'ƒ'
        // `null` = nothing in view to total. Paper has no tooltip to explain the
        // dash, but printing a fabricated 0 that the screen no longer shows
        // would break this row's one promise: the paper cannot say a number the
        // screen does not.
        const shown = value === null ? NO_TOTAL : spec === 'count' ? nf(value) : formatValue(value, c)
        return `<td style="text-align:${alignFor(c.type)}">` +
          `<span class="dxpr-agg">${esc(label)}</span> ${esc(shown)}</td>`
      })
      parts.push(`<tr class="dxpr-tot" style="height:${m.row}px">` +
        `<td class="dxpr-g"></td>${tds.join('')}</tr>`)
    }
    parts.push('</tbody></table></section>')
    out.push(parts.join(''))
  })

  return { html: out.join(''), rows: n, blocks: plan.blocks.length }
}

/**
 * A spreadsheet sheet — the sparse A1 map.
 *
 * THE USED RANGE, not the ruled frontier. On screen the rows past the data are
 * real (you can type in them); on paper twenty empty ruled rows are twenty
 * empty ruled rows. A cell's own colour, weight and alignment DO print here,
 * because here the grid paints them.
 */
function canvasMarkup(
  doc: DashDoc, view: SheetView, opts: PrintOptions, box: { w: number }, when: string,
): { html: string; rows: number; blocks: number } {
  const sheet = view.sheet as CanvasSheet
  const used = canvasUsed(sheet)
  if (!used.rows || !used.cols) {
    return {
      html: `<section class="dxpr-sheet">${opts.header ? caption(doc, sheet.name, '', '', when) : ''}` +
        `<p class="dxpr-empty">${esc(t('Nothing to print — this sheet is empty.'))}</p></section>`,
      rows: 0, blocks: 1,
    }
  }

  const widths = Array.from({ length: used.cols }, (_, c) => canvasColW(sheet, c))
  const plan = planColumns(widths, box.w, opts.wide)
  const m = metricsFor(plan.scale)
  const multi = plan.blocks.length > 1

  const valueAt = (r: number, c: number, cell: CanvasCell | undefined): unknown => {
    const computed = view.cellValues?.get(cellKey(r, c))
    if (computed !== undefined) return computed
    return cell && 'v' in cell ? cell.v : null
  }

  const out: string[] = []
  plan.blocks.forEach((block) => {
    const width = m.gutter + block.reduce((w, c) => w + Math.round(widths[c] * m.scale), 0)
    const parts: string[] = []
    parts.push(`<section class="dxpr-sheet">`)
    parts.push(`<table class="dxpr-t dxpr-cv" style="width:${width}px;font-size:${m.font}px">`)
    parts.push(`<colgroup><col style="width:${m.gutter}px">` +
      block.map((c) => `<col style="width:${Math.round(widths[c] * m.scale)}px">`).join('') +
      `</colgroup>`)
    parts.push('<thead>')
    if (opts.header) {
      parts.push(captionRow(block.length, caption(doc, sheet.name, '',
        blockLabel(block[0], block[block.length - 1], used.cols, multi), when)))
    }
    parts.push(`<tr style="height:${m.head}px"><th class="dxpr-g"></th>` +
      block.map((c) => `<th class="dxpr-g">${esc(colToLetters(c))}</th>`).join('') +
      `</tr></thead><tbody>`)

    for (let r = 0; r < used.rows; r++) {
      const cells = block.map((c) => {
        const cell = sheet.cells[canvasKey(r, c)]
        const v = valueAt(r, c, cell)
        let st = `text-align:${canvasAlign(cell, v)};`
        const bg = styleColor(cell?.bg)
        const fg = styleColor(cell?.color)
        if (bg) st += `background:${bg};`
        if (fg) st += `color:${fg};`
        if (cell?.bold) st += 'font-weight:600;'
        return `<td style="${st}"${isErr(v) ? ' class="dxpr-err"' : ''}>` +
          `${esc(canvasShown(cell, v))}${cell?.note ? '<span class="dxpr-note">•</span>' : ''}</td>`
      })
      const h = Math.max(9, Math.round(canvasRowH(sheet, r) * m.scale))
      parts.push(`<tr style="height:${h}px"><td class="dxpr-g">${r + 1}</td>${cells.join('')}</tr>`)
    }
    parts.push('</tbody></table></section>')
    out.push(parts.join(''))
  })

  return { html: out.join(''), rows: used.rows, blocks: plan.blocks.length }
}

export interface Printable {
  /** the `#dx-print` subtree, markup only — no `<html>`, no `<body>` */
  html: string
  /** the `@page` rule this job needs */
  pageCss: string
  /** rows that will be printed, summed over sheets — never a window */
  rows: number
  /** column blocks, summed over sheets. More than one sheet means continuation. */
  blocks: number
  sheets: number
  /** an ESTIMATE, for the dialog's warning. The renderer paginates, not us. */
  pages: number
}

/**
 * The whole printout, as one string.
 *
 * A STRING, not built DOM: it is measurable, it is what the rig asserts on, and
 * on a 250,000-row view a hundred thousand `createElement` calls cost more than
 * the concatenation and the single `innerHTML` that follows it.
 */
export function buildPrintable(
  doc: DashDoc, views: SheetView[], opts: PrintOptions = DEFAULT_OPTIONS,
  /** the moment on the page header. An ARGUMENT so this stays pure — see `stamp`. */
  now: Date = new Date(),
): Printable {
  const box = pageBox(opts)
  const when = opts.header ? stamp(now) : ''
  const parts: string[] = []
  let rows = 0
  let blocks = 0
  let pages = 0

  for (const view of views) {
    const built = view.sheet.kind === 'canvas'
      ? canvasMarkup(doc, view, opts, box, when)
      : tableMarkup(doc, view, opts, box, when)
    parts.push(built.html)
    rows += built.rows
    blocks += built.blocks
    // Rows that fit under the caption and the repeated header. A floor of one:
    // a page that holds no rows would divide by zero and report Infinity pages.
    // The caption is subtracted per PAGE because it now prints per page — it
    // rides the thead. With the header off it costs nothing and the estimate
    // says so, which is the difference between an estimate and a constant.
    const perPage = Math.max(1,
      Math.floor((box.h - (opts.header ? CAPTION_H : 0) - HEAD_H) / ROW_H))
    pages += built.blocks * Math.max(1, Math.ceil(built.rows / perPage))
  }

  const p = paperOf(opts.paper)
  const size = opts.orientation === 'landscape' ? `${p.h}mm ${p.w}mm` : `${p.w}mm ${p.h}mm`
  return {
    html: parts.join(''),
    pageCss: `@page{size:${size};margin:${marginOf(opts)}mm}`,
    rows,
    blocks,
    sheets: views.length,
    pages,
  }
}

// --- the DOM half -------------------------------------------------------------

const ROOT_ID = 'dx-print'

/**
 * Past this many rows the beforeprint FALLBACK declines to build a table.
 *
 * The fallback exists because a reader can reach the browser's own Print
 * without touching our button (File ▸ Print, ⌘P intercepted by an extension, a
 * "save as PDF" from the OS), and what that used to produce was one page of
 * application chrome with the grid crushed into a column. It now produces the
 * real printout — but it has no dialog, so nobody consented to five thousand
 * pages, and it runs INSIDE the print event where a long build stalls the
 * browser's own dialog. Past the ceiling it prints a card that says which
 * control to use. It never prints SOME of the rows: a short table is the exact
 * lie this whole file exists to refuse.
 */
const FALLBACK_ROW_MAX = 20_000

/** Where the reader's choices live. VIEWER state — paper size is a fact about
 *  the printer in the room, not about the workbook, so it never enters the
 *  document (the rule locale and reduced motion already follow). */
const PREF_KEY = 'bento-dash-print'

export function loadOptions(): PrintOptions {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    if (!raw) return { ...DEFAULT_OPTIONS }
    const got = JSON.parse(raw) as Partial<PrintOptions>
    return {
      paper: PAPERS.some((p) => p.id === got.paper) ? got.paper! : DEFAULT_OPTIONS.paper,
      orientation: got.orientation === 'portrait' ? 'portrait' : 'landscape',
      wide: got.wide === 'fit' || got.wide === 'split' ? got.wide : 'auto',
      scope: got.scope === 'workbook' ? 'workbook' : 'sheet',
      margin: got.margin === 'narrow' || got.margin === 'wide' ? got.margin : 'normal',
      // Only an explicit false turns it off: a preference file written by the
      // build before this option existed carries no key, and that reader's
      // printouts must not silently lose the sheet name they have always had.
      header: got.header !== false,
    }
  } catch { return { ...DEFAULT_OPTIONS } }
}

const saveOptions = (o: PrintOptions): void => {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(o)) } catch { /* private mode */ }
}

/** Mount the printout and hand it to the browser. Cleans up after itself. */
export function renderAndPrint(built: Printable): void {
  const root = mount(built)
  // A beat for layout, matching slides' exportPdf: `print()` fired in the same
  // task as the insertion can measure a table the engine has not laid out.
  setTimeout(() => window.print(), 120)
  const done = (): void => {
    root.remove()
    window.removeEventListener('afterprint', done)
  }
  window.addEventListener('afterprint', done)
}

function mount(built: Printable): HTMLElement {
  document.getElementById(ROOT_ID)?.remove()
  const root = document.createElement('div')
  root.id = ROOT_ID
  // RUNTIME-OWNED. `capturePristine` clones the live document, so a save while
  // the printout is mounted would write the whole table into the file — every
  // row, in plaintext, in the shell. The kernel strips marked nodes from every
  // serialization (kernel/src/save.ts).
  root.setAttribute('data-bento-transient', '')
  const style = document.createElement('style')
  style.textContent = built.pageCss
  root.appendChild(style)
  const body = document.createElement('div')
  body.className = 'dxpr-body'
  body.innerHTML = built.html
  root.appendChild(body)
  document.body.appendChild(root)
  return root
}

export interface PrintHost {
  store: Store
  /** the sheet the grid is showing, and its computed columns */
  shown: () => { id: string; computed?: Map<string, Vec> } | null
}

/** Everything the dialog needs to describe a job, without building it. */
function summarize(host: PrintHost, opts: PrintOptions): Printable {
  const views = collectViews(host.store, opts.scope, host.shown())
  return buildPrintable(host.store.doc, views, opts)
}

/**
 * The Print dialog: `.dx-ask` furniture, because this is the same object as
 * askForm at the same size and a second dialog style is a second thing to keep
 * in step with the theme.
 */
export function openPrintDialog(host: PrintHost): void {
  document.querySelector('.dx-ask-back')?.remove()
  const opts = loadOptions()

  const back = document.createElement('div')
  back.className = 'dx-ask-back'
  const card = document.createElement('div')
  card.className = 'dx-ask dx-print-card'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')

  const h = document.createElement('h2')
  h.className = 'dx-ask-title'
  h.textContent = t('Print')
  card.append(h)

  const select = (
    label: string, options: Array<[string, string]>, value: string,
    onChange: (v: string) => void,
  ): void => {
    const row = document.createElement('label')
    row.className = 'dx-ask-row'
    const lab = document.createElement('span')
    lab.textContent = label
    const sel = document.createElement('select')
    sel.className = 'dx-ask-in'
    for (const [v, text] of options) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = text
      sel.append(o)
    }
    sel.value = value
    sel.addEventListener('change', () => onChange(sel.value))
    row.append(lab, sel)
    card.append(row)
  }

  const note = document.createElement('p')
  note.className = 'dx-ask-hint'
  const warn = document.createElement('p')
  warn.className = 'dx-ask-err'
  warn.hidden = true

  const ok = document.createElement('button')
  ok.type = 'button'
  ok.className = 'dx-btn dx-ask-go'
  ok.textContent = t('Print')

  const refresh = (): void => {
    // Summarising builds the markup and throws it away, which is honest about
    // the cost and is what makes the page estimate the real one. It is also the
    // only way the warning can be true before the reader commits.
    const built = summarize(host, opts)
    note.textContent = t('{rows} row(s) across {sheets} sheet(s) · about {pages} page(s)', {
      rows: nf(built.rows), sheets: nf(built.sheets), pages: nf(built.pages),
    })
    const big = built.pages > 200
    warn.hidden = !big
    if (big) {
      warn.textContent = t('That is {pages} pages. Check the printer before sending it.', {
        pages: nf(built.pages),
      })
    }
    ok.disabled = built.rows === 0
  }

  select(t('Sheets'), [
    ['sheet', t('The sheet on screen')],
    ['workbook', t('Every sheet')],
  ], opts.scope, (v) => { opts.scope = v as Scope; refresh() })

  select(t('Paper'), PAPERS.map((p) => [p.id, p.label] as [string, string]), opts.paper,
    (v) => { opts.paper = v; refresh() })

  select(t('Orientation'), [
    ['landscape', t('Landscape')],
    ['portrait', t('Portrait')],
  ], opts.orientation, (v) => { opts.orientation = v as Orientation; refresh() })

  select(t('Wide sheets'), [
    ['auto', t('Shrink a little, then continue on later pages')],
    ['fit', t('Shrink until the sheet fits the page width')],
    ['split', t('Full size — continue the columns on later pages')],
  ], opts.wide, (v) => { opts.wide = v as WideMode; refresh() })

  // The margin is not decoration: it changes the printable width, so it feeds
  // the column planner and moves the page estimate under the reader's hand.
  select(t('Margins'), [
    ['normal', t('Normal — 12mm')],
    ['narrow', t('Narrow — 10mm, for one more column')],
    ['wide', t('Wide — 20mm, room to bind or annotate')],
  ], opts.margin, (v) => { opts.margin = v as MarginChoice; refresh() })

  select(t('Page header'), [
    ['on', t('Sheet name, workbook and date on every page')],
    ['off', t('No page header')],
  ], opts.header ? 'on' : 'off', (v) => { opts.header = v === 'on'; refresh() })

  card.append(note, warn)

  // WHERE PAGE NUMBERS COME FROM, said out loud. dash cannot print them: the
  // CSS that would (`@page { @bottom-right { content: counter(page) } }`) is
  // unimplemented in every browser, and a second set of numbers disagreeing
  // with the ones the system dialog can already print is worse than none. What
  // was wrong was leaving a reader to guess that from an absence.
  const pageNums = document.createElement('p')
  pageNums.className = 'dx-ask-hint'
  pageNums.textContent = t('Page numbers come from your browser’s own print dialog — turn on its headers and footers there.')
  card.append(pageNums)

  const foot = document.createElement('div')
  foot.className = 'dx-ask-foot'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'dx-btn'
  cancel.textContent = t('Cancel')
  foot.append(cancel, ok)
  card.append(foot)

  const close = (): void => {
    back.remove()
    document.removeEventListener('keydown', onKey, true)
  }
  // CAPTURE, and stopped here: the grid turns a bare keystroke into a cell edit
  // (askForm carries the same note and the same reason).
  const onKey = (e: KeyboardEvent): void => {
    if (!back.contains(e.target as Node)) return
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'Enter') { e.preventDefault(); go() }
  }
  const go = (): void => {
    const built = summarize(host, opts)
    if (!built.rows) return
    saveOptions(opts)
    close()
    renderAndPrint(built)
  }
  document.addEventListener('keydown', onKey, true)
  cancel.addEventListener('click', close)
  ok.addEventListener('click', go)
  back.addEventListener('mousedown', (e) => { if (e.target === back) close() })

  back.append(card)
  document.body.append(back)
  refresh()
  ok.focus()
}

/**
 * Wire ⌘P and the browser's own print.
 *
 * TWO ENTRY POINTS, because there are two ways to reach a printer. ⌘P opens the
 * dialog (and is taken from the browser, whose raw print of this app is a page
 * of chrome). `beforeprint` covers everything else — the File menu, an
 * extension, the OS — by building the real printout in place, so no route into
 * the printer produces the crushed-chrome page any more.
 */
export function installPrint(host: PrintHost): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'p' || e.altKey) return
    e.preventDefault()
    openPrintDialog(host)
  }
  const onBefore = (): void => {
    if (document.getElementById(ROOT_ID)) return   // our own dialog got here first
    const opts = loadOptions()
    const views = collectViews(host.store, opts.scope, host.shown())
    const rows = views.reduce((n, v) => n + (v.order ? v.order.length
      : v.sheet.kind === 'table' ? rowsOf(v.sheet as TableSheet) : canvasUsed(v.sheet as CanvasSheet).rows), 0)
    const built = rows > FALLBACK_ROW_MAX
      ? {
        ...buildPrintable(host.store.doc, [], opts),
        html: `<section class="dxpr-sheet"><p class="dxpr-empty">` +
          `${esc(t('This view has {rows} rows. Use Print… in the Data menu to print it.', { rows: nf(rows) }))}` +
          `</p></section>`,
      }
      : buildPrintable(host.store.doc, views, opts)
    const root = mount(built)
    const after = (): void => {
      root.remove()
      window.removeEventListener('afterprint', after)
    }
    window.addEventListener('afterprint', after)
  }
  document.addEventListener('keydown', onKey)
  window.addEventListener('beforeprint', onBefore)
  return () => {
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('beforeprint', onBefore)
  }
}

export const _internals = { FONT_PX, ROW_H, GUTTER_W, CAPTION_H, FALLBACK_ROW_MAX, colW }
