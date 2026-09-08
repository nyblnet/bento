// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The grid.
//
// WINDOWED, not because 100k rows is slow to compute — a full scan is 5.9 ms —
// but because 100k × 6 is 600,000 DOM nodes, and that is what actually stops
// the browser. Only the visible slice exists; two spacer rows hold the
// scrollbar honest. This is the whole reason the grid can claim the row target
// the format was sized for.
//
// IT READS THROUGH AN ORDER VECTOR. Sorting sorts the vector, not the data:
// `store.view()` mutates it, emits an invalidation, and takes no checkpoint —
// so a sort does not dirty the file and does not produce an op. Writing the
// first sort as a `commit` is the easy mistake, and nobody notices until a
// workbook saves itself every time somebody clicks a column header.
//
// THE TYPE ROW IS THE DEMO. Import guesses, and where it cannot decide — a date
// column that fits both DD/MM and MM/DD — it refuses and says so. That refusal
// is only honest if changing the type is one click away, so the header carries
// the type as a control, not a label.

import { formatValue, alignFor, TYPE_LABEL } from './format.ts'
import type { CanvasCell, CanvasSheet, Column, ColumnType, Sheet, TableSheet } from './model.ts'
import { appearanceCss } from './cellfmt.ts'
import { readCell, type Patch, type Store } from './store.ts'
import { recalc, isErr, type Vec } from './formula.ts'
import {
  Selection, keyToAction, applyMotion, contains, tsvFromRange, parseTsv,
  fillCells, type Box, type FillCell, type FillMode, type Range,
} from './select.ts'
import { buildOrder, type ColumnFilter } from './filter.ts'
import { evaluateRules, type CellStyle } from './condfmt.ts'
import { colToLetters, formatRef, parseRef } from './a1.ts'
import { t } from './i18n.ts'
import { resizeColumn, autoFitWidth, hiddenSet, readFrozen, insertRowsAt } from './rowcol.ts'
import {
  cellKey, isFormula, recalcSheetCells, recalcWorkbook, spillExtent, translateCellFormula,
  shiftSheetFormulas, workbookSources,
} from './cellformula.ts'
import { mountFind, type FindUI, type Hit } from './find.ts'
// The data-validation stylesheet is imported HERE rather than in datavalid.ts,
// because this is the file that emits the markup it styles and because
// datavalid.ts is also read by xlsx.ts, whose rig runs in node with no css
// loader at all.
import './datavalid.css'
import {
  DROPDOWN_HTML, INVALID_CLASS, canvasRuleAt, canvasRules, closeListMenu, columnRule,
  hasDropdown, listOptions, openListMenu, violationOf, type DataRule,
} from './datavalid.ts'

/**
 * Row height, in px — SPREADSHEET density, not web-table density.
 *
 * Excel's default row is exactly this at 96dpi; Google Sheets' is 21px. dash
 * sat at 30, which is why the grid read as a table on a web page: a third fewer
 * rows on screen, and the eye has to travel further for every comparison a
 * spreadsheet exists to make. 22 was an intermediate step; 20 is the target,
 * chosen with the 'dense pro' direction.
 *
 * THIS CONSTANT AND THE `--row-h` CUSTOM PROPERTY MUST AGREE. They are two
 * declarations of one number — the rows are absolutely positioned at
 * `top: i * ROW_H` from here while their height comes from the stylesheet — so
 * a change to one alone perforates the grid: the cells shrink and the row
 * boxes do not. That drift is not hypothetical; it is what stopped the density
 * fix the first time it was tried. So the grid WRITES the property from this
 * constant at build time, and the value in styles.css is only a fallback for
 * anything that renders before the grid mounts.
 */
const ROW_H = 20
const GUTTER_W = 52
const OVERSCAN = 8
/**
 * Cells the status bar will read before it stops adding up.
 *
 * A dataset's ⌘A is bounded by the file. A SPREADSHEET's is not — the sheet is
 * ruled past its data by design — so selecting a column means selecting a
 * million cells, and summing them on every arrow key is a frozen tab.
 */
const SUMMARY_MAX = 200_000

export interface GridHost {
  el: HTMLElement
  store: Store
  sheetId: string
}

const cols = (s: TableSheet) => {
  const hidden = hiddenSet(s)
  return s.columns.filter((c) => !hidden.has(c.id))
}
const rowCount = (s: TableSheet) => s.rids.reduce((n, [, c]) => n + c, 0)

/** Shared empty map, so "no cell formulas" costs no allocation on every paint. */
const EMPTY_CELLS: ReadonlyMap<string, unknown> = new Map()

/** Canonical row index → rid. The inverse of `dataRow`, ignoring the view. */
function ridForDataRow(sheet: TableSheet, r: number): number {
  let i = 0
  for (const [start, count] of sheet.rids) {
    if (r < i + count) return start + (r - i)
    i += count
  }
  return -1
}

/** Row index → rid, honouring the view's order vector when one exists. */
function ridAt(store: Store, sheet: TableSheet, i: number): number {
  const order = store.order[sheet.id]
  const idx = order ? order[i] : i
  let seen = 0
  for (const [start, count] of sheet.rids) {
    if (idx < seen + count) return start + (idx - seen)
    seen += count
  }
  return -1
}

const dataRow = (sheet: TableSheet, rid: number): number => {
  let i = 0
  for (const [start, count] of sheet.rids) {
    if (rid >= start && rid < start + count) return i + (rid - start)
    i += count
  }
  return -1
}

/**
 * One footer aggregate, over the rows a `rows` vector selects.
 *
 * Pulled out of the grid's private `totalsRow` for one reason: this is the
 * arithmetic that was wrong, and while it lived inside a DOM method the only
 * way to check it was to open a browser and read a number off the screen. Now
 * `scripts/test-dash-filter.ts` can assert it directly.
 *
 * `rows` is `store.order` — the view vector — or null for "every row". A SORT
 * writes a permutation, and summing a permutation gives the same answer, so the
 * one case this changes is the one that was broken: a FILTER, where the vector
 * is shorter than the sheet.
 *
 * Non-numbers are skipped rather than counted as zero; `avg` divides by what it
 * actually saw. An average over a column of five numbers and three blanks is an
 * average of five things, and dividing by eight answers a question nobody
 * asked.
 *
 * A `{ f }` custom-formula total is summed, which is what the DOM method did
 * before this was lifted out — preserved deliberately rather than corrected,
 * because changing it here would be a silent change of meaning in an unrelated
 * fix. It is a separate question, and it is written down in the audit.
 */
export type TotalSpec = 'sum' | 'avg' | 'count' | 'min' | 'max' | { f: string }

/**
 * Can a total be OFFERED on this column?
 *
 * `aggregate` skips every non-number, so a sum over a text column is not wrong
 * so much as vacuous: it paints `SUM 0` under a column of names, and a control
 * that offers it teaches the reader something false about their data. Dates are
 * out for the same reason — they are stored as strings here and aggregate to
 * nothing. A column that ALREADY carries a total still shows it whatever its
 * type: the file is allowed to say things this menu would not have suggested.
 */
export const canTotal = (type: ColumnType): boolean =>
  type === 'number' || type === 'money' || type === 'percent'

/**
 * What the status bar says about the current view — the whole of it, so that
 * every caller says the same thing.
 *
 * It was one closure inside the filter menu, which is why it was right exactly
 * once: sort from a column header, switch sheets, or clear from the properties
 * panel and the label kept describing a view that had gone. "4 of 8 rows" was
 * observed sitting under a DIFFERENT SHEET. A readout that is right only when
 * you reached it through one particular door is worse than no readout, because
 * it is trusted.
 *
 * ROWS ARE ONLY COUNTED WHEN SOME ARE MISSING. An unfiltered sheet said "8 of 8
 * rows", which is true, uninformative, and trains people to stop reading the
 * line — so the count is reserved for the case it exists to report. A sort
 * hides nothing, so it says what it did instead, and a sheet that is both
 * filtered and sorted says both.
 *
 * `n` is the length of the view vector, or null when there is none.
 */
export function viewStatusText(
  n: number | null, all: number, sorts: Array<{ name: string; dir: 'asc' | 'desc' }>,
): string {
  const parts: string[] = []
  if (n !== null && n < all) {
    parts.push(t('{n} of {all} rows').replace('{n}', String(n)).replace('{all}', String(all)))
  }
  if (sorts.length) {
    parts.push(t('Sorted by {cols}').replace('{cols}',
      sorts.map((k) => `${k.name} ${k.dir === 'asc' ? '▲' : '▼'}`).join(', ')))
  }
  return parts.join('  ·  ')
}

// --- the dataset's frontier --------------------------------------------------
//
// WHAT IS BELOW THE LAST ROW OF A DATASET? Exactly one row, and it is a control.
//
// The complaint this answers: an 8-row sheet had no row 9, ArrowDown from the
// last row did nothing, and the ruled lines under the total — which look
// exactly like empty spreadsheet rows — were BACKGROUND PAINT on `.dg-table`
// that selected nothing when clicked. So the grid looked like Excel's infinite
// canvas and behaved like a table, with nothing on screen saying which.
//
// REJECTED — real appendable empty rows past the data (Sheets' answer). It was
// the right answer when it was written down, and the spreadsheet kind
// (`kind: 'canvas'`) has since been built and IS that answer: unbounded, sparse,
// typed per cell, `=SUM(` anywhere. Giving the dataset a second unbounded
// frontier would leave two half-spreadsheets and would cost the dataset the one
// thing it is for. Every derived surface here is defined over "the rows there
// are": the order vector is a permutation of them, the footer is `SUBTOTAL` over
// them, `rid` identity anchors comments and per-cell formulas to them, the CRDT
// keys nodes by them, and export writes them as an xlsx ListObject. Twenty
// phantom rows would have to be excluded from every one of those, one by one,
// forever — and the first one missed is a wrong number that looks right.
//
// REJECTED — leaving the lattice and calling it decoration. That is the present
// state and it is the actual defect: a lie told in paint.
//
// CHOSEN — the frontier is honest in BOTH directions at once:
//   • the ruled lattice now STOPS at the last row (`paintEmptyGrid` clips both
//     background layers to the content height). Below it is plain background,
//     which is the truthful picture of "there is nothing there";
//   • and one real row sits at the bottom, a DOM row you can click, arrow onto
//     and type into. Typing appends a real row (`insertRowsAt`) and continues
//     the edit into it, so the universal gesture — click below the numbers,
//     type — now lands where the reader aimed instead of overwriting the last
//     data cell. `=SUM(D1:D8)` typed there becomes a per-cell formula on a real
//     row, which is what the reader meant.
//
// Excel agrees, and this is the same agreement that already governs the totals
// row: dash's dataset maps to an xlsx ListObject, and a ListObject does not
// have an infinite frontier either — it has ONE insert row that extends the
// table when you type in it.
//
// SUPPRESSED WHILE FILTERED. A blank row appended into a filtered view fails
// the filter and vanishes on the spot, which is a control that appears to do
// nothing. A SORT is fine and is allowed: `buildOrder` sinks blanks in both
// directions, so the new row lands at the bottom, where it was typed.

/**
 * Which VIEW ROW is the appender, or -1 when there is none.
 *
 * Pure, and exported, because this one number decides the selection's height,
 * the sizer's height, where the lattice stops and whether a keystroke appends —
 * five call sites that must not each re-derive it slightly differently.
 */
export function frontierRow(opts: {
  rows: number          // rowCount(sheet) — the rows the file has
  viewRows: number      // the order vector's length, or `rows` when there is none
  cols: number          // visible columns; a sheet with none has nothing to type into
  readOnly: boolean
}): number {
  if (opts.readOnly || opts.cols < 1) return -1
  if (opts.viewRows < opts.rows) return -1      // filtered: see above
  return opts.viewRows
}

// --- ARIA coordinates ---------------------------------------------------------
//
// THE GRID IS VIRTUALISED, so a painted row's position in the DOM is not its
// position in the sheet: about forty rows of a 5,000-row view exist at any
// moment. `aria-rowindex` must describe the FULL VIEW — that is the entire
// reason the attribute exists — and getting it wrong tells a screen-reader user
// that a 5,000-row sheet has 40 rows, which is worse than saying nothing at
// all, because it is a confident wrong answer.
//
// Both indices are 1-BASED and both count the furniture: row 1 is the column
// header, column 1 is the row-number gutter. So a body row at view index 0 is
// aria-rowindex 2, and the first data column is aria-colindex 2.

/** View row index (0-based) → `aria-rowindex`. Row 1 is the header. */
export const ariaRowIndex = (viewRow: number): number => viewRow + 2
/** Visible column index (0-based) → `aria-colindex`. Column 1 is the gutter. */
export const ariaColIndex = (visCol: number): number => visCol + 2

/**
 * `aria-rowcount` for a dataset — every row a reader can land on, header and
 * furniture included, whether or not it is in the DOM.
 *
 * The appender and the totals row are rows: they carry an `aria-rowindex`, so a
 * count that left them out would be smaller than the largest index in the grid,
 * which is the one arithmetic error a screen reader cannot recover from.
 */
export function ariaRowCount(
  viewRows: number, hasAppender: boolean, hasTotals: boolean,
): number {
  return 1 + viewRows + (hasAppender ? 1 : 0) + (hasTotals ? 1 : 0)
}

/** `aria-colcount`: the gutter, then the visible columns. */
export const ariaColCount = (visCols: number): number => 1 + visCols

/**
 * A SPREADSHEET REPORTS ITS SIZE AS UNKNOWN, which is what -1 means in ARIA.
 *
 * The canvas kind's extent is a frontier, not a fact: it grows with the cursor
 * and with the window, so `aria-rowcount="40"` would be announced as the size
 * of a sheet that is unbounded by definition, and would go stale on the next
 * scroll. -1 is the value ARIA defines for "the total is not known", and it is
 * the honest one here — the indices are still exact.
 */
export const ARIA_UNKNOWN = -1

/**
 * `null` MEANS THERE IS NO ANSWER, and that is the whole point of the type.
 *
 * This returned a plain number, so a total over nothing returned 0 — and 0 is a
 * value, drawn in the column's own format, indistinguishable from a real
 * result. Filter the starter sheet to a stage that matches no deal and the
 * footer said `sum £0` and `avg 0%` under an empty grid: a confident answer to
 * a question with no answer, which is the same failure as the footer that
 * ignored the filter (see `totalsRow`) wearing different clothes. Someone
 * filters to a rep with no closed deals and reads off a £0 pipeline.
 *
 * COUNT IS THE EXCEPTION and keeps returning a number: "how many did I see" has
 * the answer 0, truthfully, and an empty view honestly counts zero rows.
 *
 * NOT A CHANGE TO `SUM()`. Excel's SUM over an empty range is 0 and dash's
 * formula function agrees — that lives in `formula.ts` and is untouched. This
 * is the footer READOUT, where the reader cannot see the range and 0 is
 * therefore unreadable as "nothing to add up".
 */
export function aggregate(
  spec: TotalSpec,
  read: (i: number) => unknown,
  n: number,
  rows: number[] | null,
): number | null {
  let acc = 0
  let seen = 0
  for (let j = 0; j < n; j++) {
    const v = read(rows ? rows[j] : j)
    if (typeof v !== 'number') continue
    seen++
    if (spec === 'min') acc = seen === 1 ? v : Math.min(acc, v)
    else if (spec === 'max') acc = seen === 1 ? v : Math.max(acc, v)
    else acc += v
  }
  if (spec === 'count') return seen
  if (!seen) return null
  return spec === 'avg' ? acc / seen : acc
}

/** What a total with nothing to total looks like. One spelling, two readouts. */
export const NO_TOTAL = '—'

// --- the spreadsheet kind (`kind: 'canvas'`) ---------------------------------
//
// A CANVAS SHEET IS UNBOUNDED, and that is the whole difference. A dataset ends
// where its data ends — `rowCount` is a fact about the file — so `=SUM(` below a
// column had nowhere to go, and the ruled lines the table path paints under the
// last row are BACKGROUND (`paintEmptyGrid`), a picture of rows that do not
// exist. Here the rows past the data are real: you can select them, type in
// them, and typing is what brings them into being.
//
// TYPED BY CELL, NOT BY COLUMN. There is no `Column`, so there is no column
// type to format against and no column formula to defer to. A cell's type is
// its value's (`canvasType`) plus its own optional `format`, which is exactly
// what `CanvasCell` has carried since commit one.
//
// SPARSE. `cells` holds only what somebody touched. A sheet with A1 and Z10000
// is two entries, and the frontier below is arithmetic, not storage — the whole
// claim of the kind (docs/dash-sheet-kinds.md, "Consequences worth stating").
//
// THE KEY IS AN A1 ADDRESS, not `cellformula.ts`'s `cellKey`. Those are two
// different keys for two different maps and both are already in this codebase:
//   • the DOCUMENT keys `cells` by A1 — `validate.ts` raises `bad-canvas-key`
//     for anything `parseRef` refuses, and `preview.ts` reads
//     `sheet.cells[`${colToLetters(c)}${r + 1}`]` to draw a thumbnail. Writing
//     `"3,7"` would fail dash's own validator on every sheet dash created and
//     thumbnail every spreadsheet blank.
//   • the COMPUTED-VALUE map is keyed by `cellKey(row, col)` — that is what
//     `recalcCells` returns, and `cellFormulaValue` already reads it that way.
// So both are used, unchanged, at the layer each belongs to.

/** Excel's bounds, and a1.ts cannot address past them (3 letters, 7 digits). */
export const CANVAS_MAX_ROWS = 1_048_576
export const CANVAS_MAX_COLS = 16_384
/** How far past the used range (and past the cursor) the sheet is ruled. */
const FRONTIER_ROWS = 20
const FRONTIER_COLS = 4
/** A column with no stored width. Sheets' default; Excel's is 64px. */
const CANVAS_COL_W = 100
const MIN_COL_W = 32
const MIN_ROW_H = 14

/** Two grids on one page must not share a `aria-describedby` target. */
let DESC_SEQ = 0

/**
 * A cell's address. `A1`, `Z10000` — the key the document is written with.
 *
 * Through `formatRef`, which is the ONLY place an address is minted: it answers
 * `#REF!` for a position that cannot exist rather than spelling something
 * plausible, and a key this file assembled by hand would be a second spelling
 * to keep in step with a1.ts's.
 */
export const canvasKey = (row: number, col: number): string =>
  formatRef({ row, col, absRow: false, absCol: false })

/** The inverse, tolerant of the `$A$1` a hand-edited file may hold. */
export function canvasPos(key: string): { row: number; col: number } | null {
  const r = parseRef(key)
  return r ? { row: r.row, col: r.col } : null
}

/**
 * One past the last row and column any cell occupies — the USED range.
 *
 * From the keys themselves, because a canvas sheet has no row count to read.
 * Keys that are not addresses are skipped rather than guessed at; validate.ts
 * reports them, and a sheet is not made shorter by junk somebody hand-edited in.
 */
export function canvasUsed(sheet: CanvasSheet): { rows: number; cols: number } {
  let rows = 0
  let cols = 0
  for (const k in sheet.cells) {
    const p = canvasPos(k)
    if (!p) continue
    if (p.row + 1 > rows) rows = p.row + 1
    if (p.col + 1 > cols) cols = p.col + 1
  }
  return { rows, cols }
}

/** A cell's type, read from the VALUE. There is no column to ask. */
export const canvasType = (v: unknown): ColumnType =>
  typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'text'

/**
 * What the user typed, as a stored value.
 *
 * DELIBERATELY NARROW. A number only when the whole field is one, and a boolean
 * only for the two words; everything else is text, including `2026-01-01` (the
 * table path stores dates as strings too) and `50%`. Excel would turn `50%`
 * into 0.5 wearing a percent format, which means typing invents a FORMAT — and
 * this pass does not write formats (that is the next one). Storing the text is
 * the answer that cannot be wrong about what the author meant.
 *
 * `1,200` is 1200: a thousands separator is how people type numbers into
 * spreadsheets, and `coerceForColumn` already strips them on the table side.
 */
const NUMERIC = /^[-+]?(?:\d+|\d{1,3}(?:,\d{3})+)?(?:\.\d+)?(?:[eE][-+]?\d+)?$/
export function canvasValue(text: string): unknown {
  const s = text.trim()
  if (s === '') return ''
  if (/^true$/i.test(s)) return true
  if (/^false$/i.test(s)) return false
  // the regex admits `.` and `+` alone, which `Number` reads as NaN/0 — so the
  // digit test is separate rather than folded into an even hairier pattern
  if (!/\d/.test(s) || !NUMERIC.test(s)) return s
  const n = Number(s.replace(/,/g, ''))
  return Number.isFinite(n) ? n : s
}

/**
 * Writing `text` into a cell: the cell to store, or `null` to REMOVE the key.
 *
 * Null rather than `{}`, and this is the sparseness promise kept at the one
 * place it can be broken. Clearing forty cells that were never written must
 * leave the file exactly as it found it, or a Delete over an empty selection
 * grows the document — silently, and forever, since nothing later would ever
 * remove them.
 *
 * A cell's STYLE outlives its contents: clearing a bolded red cell leaves the
 * bold and the red, exactly as `clearSelection` on the table side keeps
 * everything but `f`. And a value and a formula are alternatives — writing one
 * drops the other, because a file that carries a number beside the formula that
 * produced it can carry a number that disagrees with it.
 */
export function canvasCellEdit(prev: CanvasCell | undefined, text: string): CanvasCell | null {
  const { v: _v, f: _f, ...rest } = prev ?? {}
  const s = text.trim()
  if (s === '') return Object.keys(rest).length ? rest : null
  if (isFormula(s)) return { ...rest, f: s }
  return { ...rest, v: canvasValue(s) }
}

/** Clearing a cell — the same rule, with no text to store. */
export const canvasCellClear = (prev: CanvasCell | undefined): CanvasCell | null =>
  canvasCellEdit(prev, '')

/** Does this sheet hold any formula at all? Skips the recalculation if not. */
export function canvasHasFormulas(sheet: CanvasSheet): boolean {
  for (const k in sheet.cells) {
    const f = sheet.cells[k]?.f
    if (typeof f === 'string' && f !== '') return true
  }
  return false
}

/** A cell's displayed text — the cell's own `format`, over the value's type. */
export function canvasShown(cell: CanvasCell | undefined, v: unknown): string {
  if (isErr(v)) return String(v)
  if (v === undefined || v === null || v === '') return ''
  return formatValue(v, { type: canvasType(v), format: cell?.format })
}

export const canvasAlign = (cell: CanvasCell | undefined, v: unknown): string =>
  cell?.align ?? alignFor(canvasType(v))

export class Grid {
  private host: HTMLElement
  private store: Store
  private sheetId: string
  private scroller!: HTMLElement
  private table!: HTMLElement
  private editing: { rid: number; col: string } | null = null
  /**
   * The canvas cell being edited. A separate field because the table path keys
   * an edit by (rid, colId) and a canvas sheet has neither — and because both
   * guards have to be checked before a keystroke is treated as navigation.
   */
  private cvEditing: { row: number; col: number } | null = null
  /** The canvas sheet's used range, recomputed on `doc` and not on every scroll. */
  private cvUsed = { rows: 0, cols: 0 }
  private cvDirty = true
  private sort: { col: string; dir: 'asc' | 'desc' } | null = null
  /** formula columns, recomputed on every document change. Never stored: the
   *  document holds the EXPRESSION, and the values are derived from it, so a
   *  file cannot carry a number that disagrees with its own formula. */
  computed = new Map<string, Vec>()
  cycles: string[] = []
  /** per-cell formula results, keyed by CANONICAL position (see cellformula.ts) */
  private cellValues: ReadonlyMap<string, unknown> = EMPTY_CELLS
  /** the selection model — visible positions, never rids (see select.ts) */
  sel!: Selection
  filters: ColumnFilter[] = []
  sorts: Array<{ col: string; dir: 'asc' | 'desc' }> = []
  /** conditional-format styles for the painted window, keyed colId */
  private styles = new Map<string, Array<CellStyle | null>>()
  /** the find bar — see the constructor for why the grid owns it */
  finder!: FindUI
  /**
   * Find's matches on THIS sheet, as `row:col` in VISIBLE coordinates.
   *
   * Visible, not rid, because that is what a paint indexes by — and because
   * the marks have to move with the view: filter the sheet and the same cell is
   * on a different row, so a rid-keyed mark would light the wrong row.
   */
  private findHits = new Set<string>()
  private findCur = ''
  onSelectionChange?: (summary: string, ref: string, value: string) => void
  onContextMenu?: (row: number, col: number, x: number, y: number) => void
  onFilterMenu?: (colId: string, x: number, y: number) => void
  /**
   * THE TWO GUTTERS, right-clicked. Separate hooks from `onContextMenu`, and
   * deliberately so: the cell menu is a menu about a CELL and these are menus
   * about a whole row and a whole column, which is the distinction Excel makes
   * and the reason a hand goes to the gutter in the first place. One shared
   * hook would have meant one menu, and a menu offering "Fill down" for a row
   * or "Insert row above" for a column is the same silence in a longer form.
   *
   * The column hook carries the column ID, not the visible index: `ci` counts
   * SHOWN columns and every structural op counts all of them, so a sheet with
   * one hidden column would insert against the wrong one.
   */
  onRowMenu?: (row: number, x: number, y: number) => void
  onColMenu?: (colId: string, x: number, y: number) => void
  /**
   * The `+` at the right end of the header strip — the column counterpart of
   * the appender row. Routed out rather than handled here because a new column
   * needs a NAME, and asking for one is the app's dialog, not the grid's.
   */
  onAddColumn?: () => void
  /**
   * Something the grid did that the reader has to be told about, in the words
   * the grid chose. Appending a row is the whole of it today: what happened to
   * the formulas in that row is a fact only `appendRows` knows.
   */
  onNotice?: (messages: string[]) => void
  /**
   * A footer cell was clicked — the totals row is the CONTROL now.
   *
   * The rect, not a point: this menu opens from the bottom of the window, so
   * the thing placing it has to know the whole cell in order to flip the menu
   * above it. panels.ts answers this, because panels.ts is where a total is
   * written (`totalsPatch`), and a second writer of one model field is how the
   * two ways of setting it start to disagree.
   */
  onTotalsMenu?: (colId: string, rect: DOMRect) => void
  /** The status bar's description of the view — see `viewStatusText`. */
  onViewChange?: (text: string) => void
  /** set by the app so a type change can be routed through one place */
  onRetype?: (col: Column, x: number, y: number) => void
  /** double-clicking a computed cell edits the FORMULA, not the value */
  onEditFormula?: (col: Column) => void

  constructor(opts: GridHost) {
    this.host = opts.el
    this.store = opts.store
    this.sheetId = opts.sheetId
    this.sel = this.freshSelection()
    this.build()
    // FIND IS THE GRID'S, and it is mounted here rather than from main.ts for
    // one reason: the reason find exists is that this grid is WINDOWED. The
    // browser's ⌘F searches the ~55 rows that happen to be in the DOM and
    // reports "not found" for values that are in the file, so a windowed grid
    // that does not claim ⌘F is a grid that lies. Owning it here means no
    // build of dash can ship the window without the search that makes it
    // honest. (find.ts claims the keystroke in the CAPTURE phase, exactly as
    // help.ts claims '?'; select.ts is still the one place that says what the
    // key MEANS.)
    this.finder = mountFind({
      store: this.store, grid: this, el: this.host, coerce: coerceForColumn,
    })
    this.store.on('doc', () => {
      // A canvas sheet has no order vector and no columns to count — its extent
      // comes out of its own keys, and `paintCanvas` sizes the selection from
      // it. All this listener owes it is "the cells changed, look again".
      // …and ANNOUNCE. The formula bar is written only from a selection change,
      // so a document swapped underneath the grid (an agent's `loadDoc`, a
      // recovery, an undo of the edit the bar is describing) left the bar
      // holding the OLD sheet's cell — observed reading "North" over an empty
      // spreadsheet. The value under the cursor is a fact about the document,
      // so it is re-read whenever the document changes.
      if (this.canvas) { this.cvDirty = true; this.paint(); this.announce(); return }
      // A structural edit invalidates the order VECTOR: it holds row indices,
      // and insert/delete renumber the rows underneath them. Leaving it alone
      // left the grid drawing blanks and rows in an order matching nothing.
      if (this.store.lastTouched.structural || this.store.lastTouched.all) this.applyView()
      this.sel.resize(this.selRows(), cols(this.sheet).length)
      this.paint()
    })
    this.store.on('view', () => this.paint())
  }

  /**
   * The patch that keeps every cell formula pointing at the right cells after
   * `count` rows or columns are inserted at canonical index `at` (removed, if
   * negative). Returns nothing when no formula moved.
   *
   * This must be committed IN THE SAME step as the structural patch. Two steps
   * would put a document on screen — and on the undo stack, and over collab —
   * in which the rows have moved and the formulas have not, which is a workbook
   * of wrong numbers that each look perfectly reasonable.
   */
  shiftFormulas(axis: 'row' | 'col', at: number, count: number): Patch[] {
    const s = this.sheet
    const cells = s.cells
    if (!cells) return []
    const pairs: Array<[string, string]> = []
    for (const k in cells) {
      const f = cells[k]?.f
      if (typeof f === 'string') pairs.push([k, f])
    }
    const moved = shiftSheetFormulas(pairs, axis, at, count)
    if (!moved.length) return []
    return [{
      op: 'setOverrides', sheet: s.id,
      keys: moved.map(([k]) => k),
      v: moved.map(([k, f]) => ({ ...cells[k], f })),
    }]
  }

  /**
   * A VISIBLE row index → the sheet's own row index.
   *
   * These are the same number until somebody sorts or filters, and then they
   * are not. Every structural op in rowcol.ts takes a CANONICAL index — it has
   * to, because a document edit cannot be expressed in one reader's view — so
   * anything acting on "the row the user clicked" has to convert here first.
   * It did not, and right-clicking the top row of a Value-sorted grid and
   * choosing Delete row deleted a DIFFERENT row: measured, £22,750 selected and
   * £12,400 destroyed, with the re-sorted view hiding the evidence.
   */
  canonicalRow(visible: number): number {
    const rid = ridAt(this.store, this.sheet, visible)
    return rid < 0 ? -1 : dataRow(this.sheet, rid)
  }

  /** Fires whenever the grid points at a different sheet — the sheet list follows it. */
  onSheetChange?: (id: string) => void

  /** Point the grid at a different sheet — an import adds one and shows it. */
  /** The id of the sheet on screen, whatever its kind — `sheet` narrows to a
   *  table and throws on a spreadsheet, which is not what a caller asking
   *  "which tab am I on" wants. */
  showingId(): string { return this.sheetId }

  setSheet(id: string): void {
    // ANY OPEN MENU BELONGS TO THE SHEET YOU WERE ON. A column menu is about a
    // column, and after this line that column may not exist — switching from a
    // dataset to a spreadsheet left "Sort A → Z / Hide this column / Freeze up
    // to this column" hanging over a sheet that has no columns at all, still
    // wired to the sheet behind it. Measured in a browser after both menus
    // landed; neither rig could see it, because each mounts one sheet.
    document.querySelector('.dx-pop')?.remove()
    this.sheetId = id
    this.sort = null
    this.filters = []
    this.sorts = []
    this.scroller.scrollTop = 0
    this.scroller.scrollLeft = 0
    this.cvDirty = true
    this.cvEditing = null
    this.sel = this.freshSelection()
    this.findHits.clear()
    this.findCur = ''
    // THE ORDER VECTOR IS PART OF THE VIEW, and clearing `filters`/`sorts`
    // without it left the other half behind: come back to a sheet you had
    // filtered and `store.order[id]` still hid the rows, under a filter menu
    // that said nothing was set. Everything downstream reads that vector — the
    // footer totals, the chart, Find — so they all agreed with each other and
    // all were wrong together. `applyView` derives it from the (now empty)
    // filters and sorts, which is the one place that decides what it should be.
    this.applyView()
    this.paint()
    this.onSheetChange?.(id)
    // NOT through `onSheetChange`: panels.ts and comments.ts both CHAIN that
    // callback, and a third subscriber assigned from here would either be
    // overwritten by them or overwrite one of them depending on mount order.
    // Find is the grid's own, so the grid calls it directly.
    this.finder?.sheetChanged()
  }

  /**
   * The DATASET on screen.
   *
   * It still throws for anything else, and that is not an oversight now that a
   * second kind renders. Half the app is written against `TableSheet` — column
   * types, the filter menu, the totals row, the chart binding — and every one of
   * those callers already guards this in a `try`, reading the throw as "not a
   * sheet I can describe" (panels.ts `currentSheet`, comments.ts `sheet`,
   * tabs.ts `showing`). Widening it to return a `Sheet` would turn each of those
   * guards into a silent wrong answer about a sheet with no columns.
   */
  get sheet(): TableSheet {
    const s = this.store.doc.sheets.find((x) => x.id === this.sheetId)
    if (!s || s.kind !== 'table') throw new Error('grid needs a table sheet')
    return s
  }

  /** The sheet on screen WHATEVER its kind. Throws only if it has gone. */
  get anySheet(): Sheet {
    const s = this.store.doc.sheets.find((x) => x.id === this.sheetId)
    if (!s) throw new Error(`grid points at no sheet ${this.sheetId}`)
    return s
  }

  /** The SPREADSHEET on screen, or null when a dataset is showing. */
  get canvas(): CanvasSheet | null {
    const s = this.store.doc.sheets.find((x) => x.id === this.sheetId)
    return s && s.kind === 'canvas' ? s : null
  }

  /** Is this grid showing a spreadsheet? The branch every shared verb takes. */
  get isCanvas(): boolean { return this.canvas !== null }

  /**
   * The columns a reader can SEE, in the order the header draws them.
   *
   * Every `ci` in this file counts these and not `sheet.columns`, and the two
   * differ the moment a column is hidden. Exported as a method so the menus
   * (gridmenu.ts) index the same list the header does rather than keeping a
   * second copy of the hidden-column rule.
   */
  visibleColumns(): Column[] { return cols(this.sheet) }

  /** A selection sized to whichever kind is on screen. */
  private freshSelection(): Selection {
    const cv = this.canvas
    if (cv) {
      const e = this.canvasExtent(cv, { row: 0, col: 0 })
      return new Selection(e.rows, e.cols)
    }
    return new Selection(rowCount(this.sheet), cols(this.sheet).length)
  }

  private head!: HTMLElement
  private foot!: HTMLElement
  /** `.dg-table` — the element carrying `role="grid"` and the aria counts. */
  private gridEl!: HTMLElement
  /** `.dg-note` — the empty state, a sibling of the grid. See `paintNote`. */
  private noteEl!: HTMLElement
  /** the visually-hidden span the grid is `aria-describedby` */
  private descEl!: HTMLElement

  /**
   * Header and totals are in normal FLOW and stick to the scroller; only the
   * body rows are absolutely positioned, inside a sizer between them.
   *
   * Mixing the two in one stacking context was the first attempt and it hid
   * the first two rows behind the header — `position: sticky` resolves against
   * the scroll container, and an absolutely-positioned sibling at `top: 0`
   * lands underneath it.
   */
  private build(): void {
    // ARIA STRUCTURE, declared once here rather than re-stamped by every paint:
    // `grid` → `row` (the header) / `rowgroup` (the windowed body) / `row` (the
    // totals). The sizer has to carry `rowgroup` because it sits BETWEEN the
    // grid and its rows, and a `grid` whose children are plain divs is a grid
    // with no rows in it as far as assistive technology is concerned.
    //
    // `.dg-desc` is the view status — "4 of 8 rows · Sorted by Value ▼" — in a
    // visually-hidden span the grid POINTS AT with `aria-describedby`. It is
    // deliberately NOT a live region: the line changes on every sort, filter,
    // sheet switch and structural edit, and a polite live region would read the
    // row count over the top of whatever the reader was actually doing. Pointed
    // at, it is read when the grid is entered and whenever the reader asks —
    // which is when a description is wanted and not before.
    const descId = `dg-desc-${++DESC_SEQ}`
    this.host.innerHTML =
      '<div class="dg-scroll" tabindex="-1">' +
      `<div class="dg-table" role="grid" aria-describedby="${descId}">` +
      '<div class="dg-head-row" role="row" aria-rowindex="1"></div>' +
      '<div class="dg-sizer" role="rowgroup"></div>' +
      '<div class="dg-foot-row" role="row"></div>' +
      '</div>' +
      // THE EMPTY STATE lives OUTSIDE `.dg-table`, and that placement is the
      // whole of its correctness. `.dg-table` carries `role="grid"` and the
      // aria row/column counts; a paragraph inside it is a child of a grid
      // that is neither a row nor a rowgroup, which is exactly the shape
      // assistive technology drops on the floor. Out here it is ordinary prose
      // in the scroller, beside the object rather than inside it — which is
      // also where it belongs visually, because on the dataset kind it sits on
      // the DESK below the table's bottom edge.
      //
      // ONE node, created once, updated in place. It must never be built per
      // row: the grid windows ~46 rows of a 5,000-row sheet and anything that
      // scales with the sheet rather than with the window is the virtualiser
      // undone. `paintNote` is O(1) and writes nothing when the state has not
      // changed.
      '<div class="dg-note" hidden></div>' +
      '</div>' +
      `<span class="dg-a11y" id="${descId}"></span>`
    // One number, written where the stylesheet can see it. See ROW_H.
    this.host.style.setProperty('--row-h', `${ROW_H}px`)
    this.scroller = this.host.querySelector('.dg-scroll')!
    this.table = this.host.querySelector('.dg-sizer')!
    this.head = this.host.querySelector('.dg-head-row')!
    this.foot = this.host.querySelector('.dg-foot-row')!
    this.gridEl = this.host.querySelector('.dg-table')!
    this.noteEl = this.host.querySelector('.dg-note')!
    this.descEl = this.host.querySelector('.dg-a11y')!
    this.scroller.addEventListener('scroll', () => this.paint(), { passive: true })
    // A WINDOW THAT CHANGES SIZE IS A DIFFERENT WINDOW, and until this the grid
    // only ever repainted on a scroll, an edit or a sheet switch. Two ways to
    // see it, and the second is why this is not a nicety:
    //   • resize the browser taller and the new space stays blank until you
    //     scroll — the virtualiser painted for the old height;
    //   • paint while the scroller measures ZERO (a tab that is not
    //     compositing, a pane laid out after boot) and a SPREADSHEET comes out
    //     a stub, because on that kind the viewport is one of the terms that
    //     decides how far the sheet is ruled. Measured exactly that: nine rows
    //     and one column, on a sheet with a cell at Z2000.
    // Guarded on the measurement actually changing, so this cannot become a
    // repaint loop with a layout that paint() itself provokes.
    if (typeof ResizeObserver !== 'undefined') {
      let seen = ''
      new ResizeObserver(() => {
        const now = `${this.scroller.clientWidth}x${this.scroller.clientHeight}`
        if (now === seen) return
        seen = now
        this.paint()
      }).observe(this.scroller)
    }
    this.paint()
  }

  /** Header: the corner box, then a letter, name, type control and sort mark. */
  /**
   * Sticky offsets for the frozen columns, indexed by visible position.
   *
   * Frozen COLUMNS only. Frozen rows would need a second pane — the rows are
   * absolutely positioned by index so a subset cannot simply stick — and they
   * buy much less here, because the header is sticky already. Losing the label
   * column when you scroll right is the gap a reader actually hits.
   */
  private frozenLefts(): number[] {
    const n = readFrozen(this.sheet).cols
    const out: number[] = []
    let left = GUTTER_W
    const vis = cols(this.sheet)
    for (let i = 0; i < n && i < vis.length; i++) {
      out.push(left)
      left += vis[i].w ?? 130
    }
    return out
  }

  /** `style`/`class` fragments that stick column `ci` if it is frozen. */
  private freeze(ci: number): { st: string; cls: string } {
    const lefts = this.frozenLefts()
    if (lefts[ci] === undefined) return { st: '', cls: '' }
    const last = ci === lefts.length - 1 ? ' dg-freeze-edge' : ''
    return { st: `position:sticky;left:${lefts[ci]}px;`, cls: ` dg-frozen${last}` }
  }

  private header(): string {
    const s = this.sheet
    return `<div class="dg-cell dg-corner" role="columnheader" aria-colindex="1" tabindex="-1" data-all="1" title="${esc(t('Select every cell in the sheet'))}"></div>` +
      `${cols(s).map((c, ci) => {
      const arrow = this.sort?.col === c.id ? (this.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''
      const filtered = this.filters.some((f) => f.col === c.id)
      const fz = this.freeze(ci)
      // `aria-sort` IS THE SORT INDICATOR for anyone not looking at the ▲.
      // Every dataset column is sortable (clicking the name sorts it), and
      // `none` is ARIA's word for "sortable, not currently sorted" — omitting
      // it entirely would say the column cannot be sorted at all. The sorted
      // one is read off `this.sorts`, not `this.sort`, so a shift-click's
      // second key is announced as well as the first.
      const sk = this.sorts.find((k) => k.col === c.id)
      const sortAttr = ` aria-sort="${sk ? (sk.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"`
      // Filtered is not a state ARIA has an attribute for, so it goes into the
      // accessible NAME — otherwise the one column hiding rows sounds exactly
      // like the seven that are not.
      const label = filtered
        ? ` aria-label="${esc(t('{name} (filtered)').replace('{name}', c.name))}"`
        : ''
      // The COLUMN header lights with the selection, as the row gutter already
      // did. Excel and Sheets both mark the selected row AND column headers,
      // and with only one of the two the eye keeps losing which column it is
      // in on a wide sheet — the header is the only thing still on screen once
      // the cursor has scrolled away.
      const box = this.sel.bounds()
      const on = ci >= box.left && ci <= box.right ? ' dg-h-on' : ''
      return `<div class="dg-cell dg-h${filtered ? ' dg-filtered' : ''}${on}${fz.cls}" ` +
        `role="columnheader" aria-colindex="${ariaColIndex(ci)}" tabindex="-1"${sortAttr}${label} ` +
        `style="${fz.st}width:${c.w ?? 130}px" data-col="${c.id}" data-ci="${ci}">` +
        // TWO LINES, because one could not hold them: the letter, the name,
        // the type control, the filter arrow and the resize grip were sharing
        // 130px and the NAME lost — every column read "A R", "B O", "C :".
        // A spreadsheet whose column names are unreadable is not a spreadsheet.
        // The letter goes on its own strip, where Excel puts it and where it is
        // also the obvious click target for selecting the column.
        // The TYPE rides on the letter strip, which has room going spare, and
        // not beside the name, which does not: a full-width `PERCENT` badge is
        // what clipped `Probability` down to `P.`. It stays a button — the type
        // being one click away is what makes import's refusal to guess honest.
        `<span class="dg-hstrip">` +
        `<span class="dg-letter" title="${esc(t('Select column'))}">${colToLetters(ci)}</span>` +
        `<button class="dg-type" data-retype="${c.id}" title="${esc(t('{type} — click to change').replace('{type}', t(TYPE_LABEL[c.type])))}">${esc(t(TYPE_LABEL[c.type]))}</button>` +
        `</span>` +
        `<span class="dg-hmain">` +
        `<span class="dg-name" title="${esc(c.formula ? `= ${c.formula}` : c.name)}">${esc(c.name)}${arrow}</span>` +
        (c.formula ? `<span class="dg-fx" title="${esc('= ' + c.formula)}">fx</span>` : '') +
        (c.failed ? `<span class="dg-warn" title="${esc(t('{n} value(s) could not be read as {type}').replace('{n}', String(c.failed)).replace('{type}', t(TYPE_LABEL[c.type])))}">!</span>` : '') +
        `<span class="dg-filter" data-filter="${c.id}" title="${esc(t('Filter and sort this column'))}">▾</span>` +
        `</span>` +
        `<span class="dg-grip" data-grip="${c.id}" title="${esc(t('Drag to resize, double-click to fit the widest value'))}"></span>` +
        `</div>`
    }).join('')}${this.headerAppender()}`
  }

  /**
   * THE COLUMN APPENDER — the `+` at the right end of the header strip.
   *
   * The row appender (`frontierRowHtml`) is the argument for this one: the
   * dataset's frontier was invisible in both directions, one half of it was
   * fixed, and a reader who has learned that the `+` under the last row adds a
   * row has every reason to look for the same mark past the last column. There
   * was nothing there, and Insert column lived only in a right-click nobody had
   * a reason to try. Half a convention is worse than none — it teaches the rule
   * and then breaks it.
   *
   * WHERE IT DIFFERS FROM THE ROW, and it has to. A row is brought into being
   * by TYPING in it, which is why clicking the row appender costs nothing:
   * a row's content is what a row is. A column is not — it needs a NAME and a
   * type before it holds anything, and there is nowhere on the header strip to
   * type one. So the click opens the same New-column dialog the menu opens, and
   * the file still only grows when that dialog is submitted. The invariant the
   * frontier rig states — SELECTION IS FREE, ONLY WRITING COSTS — is kept; it
   * is the gesture in between that differs, because the two things being
   * appended differ.
   *
   * Absent in a read-only workbook, where an invitation is a lie, and on the
   * spreadsheet kind, which has an unbounded grid and needs no invitation.
   */
  private headerAppender(): string {
    if (this.canvas || this.store.readOnly) return ''
    // NOT `.dg-h`, and not `role="columnheader"`. It heads no column: giving it
    // either would put a cell in the header row that `aria-colcount` does not
    // count and that a screen reader would announce as a column the sheet does
    // not have. A button is what it is.
    return `<div class="dg-cell dg-add-col" role="button" tabindex="-1" ` +
      `title="${esc(t('Add a column'))}" aria-label="${esc(t('Add a column'))}">+</div>`
  }

  /**
   * The footer totals — over the rows the reader can SEE.
   *
   * This used to loop `0..rowCount(s)` and ignore `store.order` entirely. Filter
   * the starter sheet to deals over £10,000 and the grid showed four rows worth
   * £69,050 while the footer said, in bold, directly underneath them, £97,050 —
   * the total including the four rows the filter had just removed. The status
   * bar got it right ("4 of 8 rows") the whole time, so the two readouts on the
   * same screen disagreed, and the bigger one was wrong.
   *
   * That is the exact failure this app claims to exist to prevent: a wrong
   * answer that looks right. Someone filters to closed-won and reads off the
   * pipeline.
   *
   * A SORT also writes `store.order` — the same rows in a different order — and
   * summing a permutation gives the same answer, so reading the order vector is
   * right for both and only the label distinguishes them. `dg-part` is set
   * only when rows are actually excluded, because a footer that says "visible"
   * on an unfiltered sheet trains people to stop reading it.
   */
  private totalsRow(): string {
    const s = this.sheet
    const vis = cols(s)
    // THE FOOTER CELL IS THE CONTROL. It used to be a readout with no way in:
    // the row displayed SUM £97,050 and the only thing that could change it was
    // a dropdown in the properties panel, one column at a time — which is why
    // the first person to use dash asked how to click the total. So the row
    // also exists wherever a total COULD be set, and each empty cell under a
    // numeric column invites one rather than sitting blank and dead.
    //
    // It still disappears entirely on a sheet with nothing to add up, and in a
    // read-only workbook, where an invitation would be a lie — that is the
    // original rule ("hide the row rather than the border") kept, not dropped:
    // the border IS the row's whole appearance when it has nothing to say.
    const offer = !this.store.readOnly && vis.some((c) => canTotal(c.type))
    if (!s.totals && !offer) return ''
    const all = rowCount(s)
    const order = this.store.order[s.id]
    const rows = order ?? null
    const n = rows ? rows.length : all
    const filtered = n < all
    return `<div class="dg-cell dg-gutter" role="rowheader" aria-colindex="1" aria-label="${esc(t('Totals'))}"` +
      `${filtered ? ` title="${esc(t('Totals cover the {n} row(s) the filter leaves showing, not all {all}.')
        .replace('{n}', String(n)).replace('{all}', String(all)))}"` : ''}>${filtered ? '⌄' : ''}</div>` +
      `${vis.map((c, ci) => {
      const spec = s.totals?.[c.id]
      const fz = this.freeze(ci)
      const aria = ` role="gridcell" aria-colindex="${ariaColIndex(ci)}" tabindex="-1"`
      const w = `${fz.st}width:${c.w ?? 130}px`
      if (!spec) {
        if (!offer || !canTotal(c.type)) return `<div class="dg-cell${fz.cls}"${aria} style="${w}"></div>`
        return `<div class="dg-cell dg-tot dg-tot-add${fz.cls}"${aria} data-tcol="${c.id}" ` +
          `title="${esc(t('Add a total to this column'))}" ` +
          `style="${w};text-align:${alignFor(c.type)}"><span class="dg-agg-add">${esc(t('Total'))}</span></div>`
      }
      const comp = this.computed.get(c.id)
      const out = aggregate(spec, (i) => comp ? comp[i] : readCell(s.data[c.id], i), n, rows)
      // A `{ f }` custom total is SUMMED (see `aggregate`) and used to label
      // itself `[object Object]` — `String(spec)` on an object. The arithmetic
      // is deliberately left alone; only the label is repaired, because a
      // footer reading "[object Object] £97,050" is not a statement about
      // anything.
      const label = typeof spec === 'string' ? spec : 'fx'
      const hint = out === null
        // The dash is not an error and must not read as one. It says the
        // population is empty, which is a fact about the VIEW — so the hint
        // names the filter, the only thing that can have emptied it.
        ? t('No rows to total — the filter leaves none showing.')
        : typeof spec === 'string' ? t('Click to change or remove this total') : `= ${spec.f}`
      // A COUNT IS NOT MONEY. `formatValue` dresses the answer in the column's
      // own format, which is right for sum/avg/min/max — they are quantities of
      // the same thing — and wrong for a count, which is a number of ROWS:
      // eight deals in a £ column rendered as "count £8.00". Nobody hit this
      // while the only way to choose `count` was a dropdown in a side panel;
      // it is one click from the number now.
      const shown = out === null ? NO_TOTAL : spec === 'count' ? fmtNum(out) : formatValue(out, c)
      return `<div class="dg-cell${fz.cls}${filtered ? ' dg-part' : ''}${this.store.readOnly ? '' : ' dg-tot'}"${aria} ` +
        `${this.store.readOnly ? '' : `data-tcol="${c.id}" title="${esc(hint)}" `}` +
        `style="${w};text-align:${alignFor(c.type)}">` +
        `<span class="dg-agg">${esc(label)}</span> ${esc(shown)}</div>`
    }).join('')}`
  }

  /**
   * Rebuild the view order from the current filters and sorts.
   *
   * VIEW state: it writes `store.order`, which `store.view()` mutates without
   * a checkpoint — so filtering and sorting never dirty the file and never
   * produce an op. Formula columns are read through `computed`, so you can
   * sort by a calculated column that is nowhere in the document.
   */
  applyView(): void {
    // A CANVAS SHEET HAS NO VIEW VECTOR, and must not be given one. Filtering
    // and sorting reorder ROWS OF A DATASET; on a sheet where a formula names
    // `B4` by position, permuting the rows underneath the addresses would make
    // every reference mean something different for one reader than for another.
    // The one thing owed here is that the readouts describing the last sheet
    // stop describing this one.
    if (this.canvas) {
      this.store.view(() => { this.store.order[this.sheetId] = undefined })
      this.announce()
      this.onViewChange?.('')
      return
    }
    const s = this.sheet
    const n = rowCount(s)
    const get = (col: string, row: number): unknown => {
      const comp = this.computed.get(col)
      return comp ? comp[row] : readCell(s.data[col], row)
    }
    const order = this.filters.length || this.sorts.length
      ? buildOrder(n, get, this.filters, this.sorts)
      : undefined
    this.store.view(() => { this.store.order[s.id] = order })
    // EVERY view change ends here — a sort, a filter, a clear, a sheet switch,
    // a structural edit that renumbered the rows — so this is the one place
    // that can promise the three readouts describing the view are still true.
    // They were not: `announce` (the name box and the formula bar) fired only
    // on a selection change, and the row count fired only from inside the
    // filter menu, so sorting moved the cursor onto a different row and all
    // three kept describing the row it had left.
    this.announce()
    this.announceView()
  }

  /** What the status bar should say about this sheet's view, right now. */
  viewStatus(): string {
    if (this.canvas) return ''
    const s = this.sheet
    return viewStatusText(this.store.order[s.id]?.length ?? null, rowCount(s),
      this.sorts.map((k) => ({
        name: s.columns.find((c) => c.id === k.col)?.name ?? k.col, dir: k.dir,
      })))
  }

  /**
   * The view status, to the status bar AND to assistive technology.
   *
   * The same sentence in two places, because a sighted reader gets it from the
   * footer and a screen-reader user got it from nowhere at all. `.dg-a11y` is
   * the grid's `aria-describedby` target and is NOT a live region — see
   * `build()` for why a polite one would be the wrong shape here.
   */
  private announceView(): void {
    const text = this.viewStatus()
    this.onViewChange?.(text)
    if (this.descEl) this.descEl.textContent = text
  }

  /**
   * How many rows the SELECTION spans — the view's rows, plus the appender when
   * there is one.
   *
   * One function, because the `doc` listener and `paint` both size the selection
   * and a disagreement between them is a cursor that can sit on a row the paint
   * does not draw.
   */
  private selRows(): number {
    if (this.canvas) return this.sel.rows
    const s = this.sheet
    const n = this.store.order[s.id]?.length ?? rowCount(s)
    return this.frontier() >= 0 ? n + 1 : n
  }

  /** The appender's view-row index on the DATASET showing, or -1. See `frontierRow`. */
  private frontier(): number {
    if (this.canvas) return -1
    const s = this.sheet
    const rows = rowCount(s)
    return frontierRow({
      rows,
      viewRows: this.store.order[s.id]?.length ?? rows,
      cols: cols(s).length,
      readOnly: this.store.readOnly,
    })
  }

  /** Is this view row the appender rather than a row the file has? */
  private isFrontier(row: number): boolean {
    const f = this.frontier()
    return f >= 0 && row === f
  }

  /**
   * Make the appender real: `count` rows on the end of the DATA, one commit.
   *
   * Returns the view index the first new row occupies, or -1 if nothing was
   * appended. It is the old view length in both orderings — unsorted the row
   * goes last, and under a sort `buildOrder` sinks blanks to the end in both
   * directions — so the cursor is already on it and does not have to be moved.
   */
  private appendRows(count = 1, carry = false): number {
    const at = this.frontier()
    if (at < 0) return -1
    const s = this.sheet
    const patches = insertRowsAt(s, rowCount(s), count)
    if (!patches.length) return -1
    // ONLY WHEN A PERSON IS ADDING ONE ROW. A paste that appends rows is about
    // to write every one of those cells itself, and a formula carried in
    // underneath it would be a second author of the same cell — the value
    // lands, the formula wins the paint, and the paste looks like it failed.
    const rid = (patches[0] as { rids?: number[] }).rids?.[0]
    const carried = carry && count === 1 && rid !== undefined
      ? this.carryFormulas(rid, rowCount(s) - 1)
      : { patches: [] as Patch[], messages: [] as string[] }
    this.store.commit([...patches, ...carried.patches])
    if (carried.messages.length) this.onNotice?.(carried.messages)
    // The `doc` listener repaints, but only if the store emits synchronously;
    // painting again is cheap and makes the new row's cell findable by the
    // caller that is about to open an editor on it.
    this.paint()
    return at
  }

  /**
   * WHAT HAPPENS TO A PER-CELL FORMULA WHEN A ROW IS APPENDED, and — either
   * way — what the reader is told about it.
   *
   * THE FINDING. `timesheet.xlsx` carries `=SUM(B2:F2)` down a Total column.
   * Add a person and the Total cell for the new row is empty; Excel's table
   * would have filled it. dash's own answer to this is a COLUMN formula, which
   * propagates and is better, but an IMPORTED sheet's per-cell formulas stay
   * per-cell forever and nothing said so at the moment the hole appeared. The
   * silence was the defect, not the emptiness.
   *
   * THE RULE, and why it is not "copy the last row's formula". A dataset does
   * not know which of its rows are data: an imported sheet's last row is very
   * often a TOTALS row (finding 7 — the import cannot know, because the file
   * does not say), and `=SUM(B2:B8)` translated down a row is a wrong number
   * that looks exactly like a right one. So a formula is carried only when the
   * column PROVES it repeats: the last two rows must hold the same formula one
   * row apart — `translate(f[n-2], +1) === f[n-1]`. A run of one is not a
   * pattern, and a day-total sitting under a run of row-totals fails the test
   * on the spot.
   *
   * The translation is a1.ts's, through `translateCellFormula` — the same call
   * a fill makes, so relative and absolute references move by the rules
   * `scripts/test-dash-fill.ts` guards, and a fill never seeds from a computed
   * value (that was the shipped data-loss bug; nothing here reads a value at
   * all — only the stored `f`).
   *
   * AND WHEN IT REFUSES IT SAYS SO. A column that has per-cell formulas but no
   * proven pattern produces a sentence naming the column and pointing at the
   * column formula, which is the thing that would have filled every future row.
   * Silence is the one outcome this function does not have.
   *
   * `rid` is the new row's rid and `below` is the DATA position of the row it
   * follows — `rowCount - 1` for an append, `at - 1` for an insert in the
   * middle, so both doors to a new row get the same answer. Public for that
   * second door, which is gridmenu.ts's.
   */
  carryFormulas(rid: number, below: number): { patches: Patch[]; messages: string[] } {
    const s = this.sheet
    if (!s.cells || below < 0) return { patches: [], messages: [] }
    const keys: string[] = []
    const overs: Array<Record<string, unknown>> = []
    const carried: string[] = []
    const stranded: string[] = []
    for (const col of cols(s)) {
      // A COMPUTED COLUMN already fills every row from its expression — there
      // is nothing per-cell to carry and nothing to warn about.
      if (col.formula) continue
      const at = (r: number): string | undefined => {
        if (r < 0) return undefined
        const f = s.cells?.[`${col.id}:${ridForDataRow(s, r)}`]?.f
        return typeof f === 'string' && f !== '' ? f : undefined
      }
      const last = at(below)
      if (last === undefined) continue
      const prev = at(below - 1)
      if (prev === undefined || translateCellFormula(prev, 1, 0) !== last) {
        stranded.push(col.name)
        continue
      }
      keys.push(`${col.id}:${rid}`)
      overs.push({ f: translateCellFormula(last, 1, 0) })
      carried.push(col.name)
    }
    const messages: string[] = []
    if (carried.length) {
      messages.push(t('The formula in {cols} was carried down to the new row. A column formula would fill every new row, without being asked.')
        .replace('{cols}', carried.join(', ')))
    }
    if (stranded.length) {
      messages.push(t('{cols} holds formulas on single cells that do not repeat down the column, so the new row is empty there. An imported formula stays on the cell it arrived on; give the column a formula and every new row fills itself.')
        .replace('{cols}', stranded.join(', ')))
    }
    return {
      patches: keys.length
        ? [{ op: 'setOverrides', sheet: s.id, keys, v: overs as never, dropEmpty: true } as Patch]
        : [],
      messages,
    }
  }

  /**
   * The cursor is on the appender and something is about to write there — turn
   * it into a real row first. False means the write must not happen.
   */
  private materialiseCursorRow(): boolean {
    if (!this.isFrontier(this.sel.cursor.row)) return true
    // `carry: true` — this is the "add a person" gesture, and finding 11 is
    // about the row it makes. See `carryFormulas`.
    return this.appendRows(1, true) >= 0
  }

  paint(): void {
    // A repaint detaches the arrow the menu was dropped from, and the menu is
    // mounted on the body — so it would hang there over a grid that has moved.
    closeListMenu()
    // Captured BEFORE any innerHTML is replaced: afterwards the previously
    // focused node is detached and `contains` answers false for it, so this is
    // the only moment the question "did the grid have focus?" can be asked.
    const hadFocus = this.hasFocus()
    const cv = this.canvas
    if (cv) { this.paintCanvas(cv, hadFocus); return }
    // …and put back what the spreadsheet path borrowed. A grid that had shown a
    // canvas kept its 16,000-column width and its single-line header CSS the
    // moment it was pointed back at a dataset.
    this.host.classList.remove('dg-canvas')
    this.table.style.width = ''
    const s = this.sheet
    const all = rowCount(s)
    if (s.columns.some((c) => c.formula)) {
      // `now` is frozen from the document so TODAY() shows every reader the
      // same date rather than each reader's own
      const r = recalc(s, this.store.doc.modified)
      this.computed = r.values
      this.cycles = r.cycles
    } else if (this.computed.size) { this.computed = new Map(); this.cycles = [] }

    // Per-cell formulas, over CANONICAL positions.
    //
    // A1 addressing counts `s.columns` (every column, hidden included) and the
    // sheet's own row order — NOT the visible grid. Sorting and filtering are
    // view state (store.view()), so a formula must not change meaning when a
    // reader sorts: `=B4*1.2` names a cell in the document, and two people
    // looking at the same file through different sorts have to see the same
    // number. Hiding a column is document state but still editorial, and
    // renumbering every reference behind it would be a silent rewrite.
    // THROUGH THE WORKBOOK, not this sheet alone. This line was the whole of
    // the cross-sheet defect: `recalcWorkbook` has crossed sheets since the
    // workbook graph landed, and `cvRefresh` calls it for the canvas kind —
    // this call site handed the dataset kind the one-sheet `recalcCells`, so
    // `=SUM(Jan!B1:B6)` answered #REF! on a dataset and resolved on a
    // spreadsheet in the same workbook. Two call sites, never two kinds.
    // `own` hands back this sheet's already-computed columns so a calculated
    // column is not evaluated twice.
    this.cellValues = this.hasCellFormulas()
      ? recalcSheetCells(this.store.doc, s.id, (tb) => (tb.id === s.id ? this.computed : undefined)).values
      : EMPTY_CELLS

    // Conditional formats are evaluated over the WHOLE column, not the painted
    // window: a colour scale needs the real min and max, and top-N needs every
    // candidate. Evaluating the ~40 visible rows would rescale the ramp on every
    // scroll — the same data would change colour as you moved.
    this.styles.clear()
    const rules = (s as unknown as { condfmt?: Record<string, unknown[]> }).condfmt
    if (rules) {
      for (const c of cols(s)) {
        const rs = rules[c.id]
        if (!Array.isArray(rs) || !rs.length) continue
        const comp = this.computed.get(c.id)
        const vals = Array.from({ length: all }, (_, i) => comp ? comp[i] : readCell(s.data[c.id], i))
        this.styles.set(c.id, evaluateRules(rs as never, vals))
      }
    }
    const order = this.store.order[s.id]
    const n = order ? order.length : all
    const front = this.frontier()
    // The appender is a row of the grid: the selection reaches it, the sizer is
    // tall enough for it, and the lattice stops after it.
    const gridN = front >= 0 ? n + 1 : n
    this.sel.resize(gridN, cols(s).length)
    this.table.style.height = `${gridN * ROW_H}px`

    // Only the visible slice exists. 100k x 6 would be 600,000 nodes, and that
    // — not the arithmetic — is what stops the browser.
    const top = Math.max(0, Math.floor(this.scroller.scrollTop / ROW_H) - OVERSCAN)
    const visible = Math.ceil(this.scroller.clientHeight / ROW_H) + OVERSCAN * 2
    const end = Math.min(gridN, top + visible)

    // Data validation rules, read ONCE per paint rather than per cell: a rule
    // is a column property and re-reading it forty times a row would be forty
    // untrusted-input guards run over the same object. `violationOf` below is
    // called for the PAINTED WINDOW only — the mark is derived, never stored,
    // because a stored flag is stale the instant the value or the rule moves
    // (datavalid.ts's header argues this at length).
    const dvRules = new Map<string, DataRule>()
    for (const c of cols(s)) {
      const rule = columnRule(c)
      if (rule) dvRules.set(c.id, rule)
    }

    const body: string[] = []
    for (let i = top; i < end; i++) {
      if (i === front) { body.push(this.frontierRowHtml(i)); continue }
      const rid = ridAt(this.store, s, i)
      const r = dataRow(s, rid)
      const box = this.sel.bounds()
      const rowSelected = i >= box.top && i <= box.bottom
      body.push(`<div class="dg-row" role="row" aria-rowindex="${ariaRowIndex(i)}" data-rid="${rid}" data-row="${i}" style="top:${i * ROW_H}px">` +
        `<div class="dg-cell dg-gutter${rowSelected ? ' dg-gutter-on' : ''}" role="rowheader" aria-colindex="1" data-rowhead="${i}">${i + 1}</div>` +
        cols(s).map((c, ci) => {
          const over = s.cells?.[`${c.id}:${rid}`]
          const comp = this.computed.get(c.id)
          const fv = this.cellFormulaValue(r, c.id)
          const v = fv !== undefined ? fv
            : comp ? comp[r]
              : over && 'v' in over ? over.v
                : readCell(s.data[c.id], r)
          const note = over?.note ? ' dg-noted' : ''
          const bad = isErr(v) ? ' dg-err' : ''
          const inSel = this.sel.ranges().some((rg) => contains(rg, i, ci))
          const isCursor = this.sel.cursor.row === i && this.sel.cursor.col === ci
          const cf = this.styles.get(c.id)?.[r] ?? null
          let st = `width:${c.w ?? 130}px;text-align:${alignFor(c.type)}`
          if (cf?.bg) st += `;background:${cf.bg}`
          if (cf?.color) st += `;color:${cf.color}`
          if (cf?.bold) st += ';font-weight:600'
          // The cell's OWN appearance, LAST so it wins the tie — a hand-set
          // colour is a decision and a conditional format is a rule, and the
          // reader who bolded this cell should see it bold. Additive: an
          // override that sets nothing emits nothing, so a conditional
          // format's background survives untouched.
          st += appearanceCss(over)
          const bar = cf?.bar
            ? `<span class="dg-bar" style="left:${bar0(cf)}%;width:${cf.bar.pct}%;background:${cf.bar.color}"></span>`
            : ''
          const shown = isErr(v) ? String(v) : formatValue(v, c)
          const fz = this.freeze(ci)
          // Find's marks. Every match is tinted, the current one is filled: a
          // find that highlights only where it jumped tells you nothing about
          // whether the next one is two rows down or two thousand.
          const fk = `${i}:${ci}`
          const hit = this.findHits.has(fk)
            ? (this.findCur === fk ? ' dg-find dg-find-cur' : ' dg-find')
            : ''
          // Data validation. A value that breaks its column's rule is MARKED
          // (never changed, never dropped — the rule arrived after the data and
          // the data is what somebody actually has), and a `list` rule puts a
          // real dropdown arrow in the cell.
          const rule = dvRules.get(c.id)
          const why = rule ? violationOf(rule, v) : null
          const dvCls = (why !== null ? ` ${INVALID_CLASS}` : '') + (rule && hasDropdown(rule) ? ' dv-list' : '')
          const dvArrow = rule && hasDropdown(rule) ? DROPDOWN_HTML : ''
          const dvTitle = why !== null ? ` title="${esc(why)}"` : ''
          return `<div class="dg-cell${note}${bad}${inSel ? ' dg-sel' : ''}${isCursor ? ' dg-cursor' : ''}${hit}${fz.cls}${dvCls}"${dvTitle} ` +
            `role="gridcell" aria-colindex="${ariaColIndex(ci)}" aria-selected="${inSel}" ` +
            // THE ROVING TABINDEX. Exactly one cell in the grid is in the tab
            // order and it is the cursor — 300 focusable cells would mean 300
            // Tab presses to get past the grid, and Tab already means "next
            // cell" inside it (select.ts owns that key).
            `tabindex="${isCursor ? 0 : -1}" ` +
            `data-col="${c.id}" data-ci="${ci}" style="${fz.st}${st}">${bar}<span class="dg-v">${esc(shown)}</span>${dvArrow}</div>`
        }).join('') + '</div>')
    }
    this.paintEmptyGrid(gridN * ROW_H)
    this.head.innerHTML = this.header()
    this.table.innerHTML = body.join('') + this.outline()
    // `totalsRow()` returns '' when the sheet declares no totals, but the
    // element keeps its 2px top rule and its 20px of height — so a sheet with
    // no totals drew a heavy line across the grid under nothing at all. Hide
    // the row rather than the border: the border IS the row's whole appearance
    // when it is empty.
    const totals = this.totalsRow()
    this.foot.hidden = totals === ''
    this.foot.innerHTML = totals
    if (totals === '') this.foot.removeAttribute('aria-rowindex')
    else this.foot.setAttribute('aria-rowindex', String(ariaRowIndex(gridN)))
    this.gridEl.setAttribute('aria-rowcount', String(ariaRowCount(n, front >= 0, totals !== '')))
    this.gridEl.setAttribute('aria-colcount', String(ariaColCount(cols(s).length)))
    // The grid's accessible name is the SHEET's name — data, not a UI string,
    // so there is nothing here to translate.
    if (s.name) this.gridEl.setAttribute('aria-label', s.name)
    if (this.store.readOnly) this.gridEl.setAttribute('aria-readonly', 'true')
    else this.gridEl.removeAttribute('aria-readonly')
    this.paintNote()
    this.wire()
    this.restoreFocus(hadFocus)
    // AFTER wire(), so anything decorating cells finds the real nodes. The
    // comments overlay used a MutationObserver on the sizer before this
    // existed — correct, and a microtask on every paint for something the
    // grid already knows.
    this.onPaint?.()
  }

  
  /** The formula stored at a canonical position, if any. */
  private formulaAtPos(row: number, col: number): string | undefined {
    const s = this.sheet
    const c = s.columns[col]
    if (!c) return undefined
    const rid = ridForDataRow(s, row)
    const f = s.cells?.[`${c.id}:${rid}`]?.f
    return typeof f === 'string' && f !== '' ? f : undefined
  }

  private hasCellFormulas(): boolean {
    const cells = this.sheet.cells
    if (!cells) return false
    for (const k in cells) if (typeof cells[k]?.f === 'string') return true
    return false
  }

  
  /** The computed value of a cell formula at a canonical position, if it has one. */
  private cellFormulaValue(row: number, colId: string): unknown {
    if (this.cellValues === EMPTY_CELLS) return undefined
    const ci = this.sheet.columns.findIndex((c) => c.id === colId)
    if (ci < 0) return undefined
    const k = cellKey(row, ci)
    return this.cellValues.has(k) ? this.cellValues.get(k) : undefined
  }

  /**
   * The appender — the one row past the data, and the whole of the dataset's
   * frontier. See the `frontierRow` note for why it is one row and not twenty.
   *
   * It is a REAL DOM ROW, which is the entire point: it can be clicked,
   * arrowed onto, and typed into, and each of those is something the painted
   * lattice it replaces could not do. Its gutter shows `+` rather than a
   * number, because the row it would be numbered is not there yet — that is
   * the visual difference between an invitation and a row of data, and it is
   * the signal that was missing.
   *
   * No `data-rid`: it has no row identity because it is not a row of the file.
   * That also keeps it out of `wire()`'s `.dg-row[data-rid]` sweep and out of
   * comments.ts's rid lookup, neither of which has anything to say about it.
   */
  private frontierRowHtml(i: number): string {
    const box = this.sel.bounds()
    const rowSelected = i >= box.top && i <= box.bottom
    const hint = esc(t('This sheet has exactly the rows it has. Type here to add one.'))
    return `<div class="dg-row dg-add-row" role="row" aria-rowindex="${ariaRowIndex(i)}" ` +
      `data-row="${i}" data-addrow="1" title="${hint}" style="top:${i * ROW_H}px">` +
      `<div class="dg-cell dg-gutter dg-add-gutter${rowSelected ? ' dg-gutter-on' : ''}" ` +
      `role="rowheader" aria-colindex="1" aria-label="${esc(t('Add a row'))}" data-rowhead="${i}">+</div>` +
      cols(this.sheet).map((c, ci) => {
        const inSel = this.sel.ranges().some((rg) => contains(rg, i, ci))
        const isCursor = this.sel.cursor.row === i && this.sel.cursor.col === ci
        const fz = this.freeze(ci)
        return `<div class="dg-cell dg-add-cell${inSel ? ' dg-sel' : ''}${isCursor ? ' dg-cursor' : ''}${fz.cls}" ` +
          `role="gridcell" aria-colindex="${ariaColIndex(ci)}" aria-selected="${inSel}" ` +
          `tabindex="${isCursor ? 0 : -1}" aria-label="${esc(t('Add a row'))}" ` +
          `data-col="${c.id}" data-ci="${ci}" style="${fz.st}width:${c.w ?? 130}px"></div>`
      }).join('') + '</div>'
  }

  /** Does the keyboard currently live inside this grid? */
  private hasFocus(): boolean {
    const a = typeof document === 'undefined' ? null : document.activeElement
    return !!a && a !== document.body && this.host.contains(a)
  }

  /**
   * Put focus back where it was — on the CURSOR cell, which the paint has just
   * replaced.
   *
   * Every paint rebuilds `.dg-sizer`'s innerHTML, so the focused cell is
   * destroyed roughly forty times a second while somebody holds an arrow key
   * down. Without this, `document.activeElement` falls to BODY on the first
   * keystroke and the grid stops being a focusable thing at all — which is
   * exactly the state the audit found.
   *
   * The scroller is the fallback, never BODY: the cursor can be scrolled clean
   * out of the window (it is virtualised), and focus landing on the document
   * body would drop the reader out of the grid entirely.
   */
  private restoreFocus(had: boolean): void {
    const cur = this.sel.cursor
    const cell = this.cellEl(cur.row, cur.col)
    // The tab stop, whether or not the grid is focused: exactly one thing in
    // here answers Tab from outside, and it is the cursor cell when that cell
    // is painted and the scroller when it is not.
    if (cell) { cell.tabIndex = 0; this.scroller.tabIndex = -1 } else this.scroller.tabIndex = 0
    if (!had) return
    if (cell) cell.focus({ preventScroll: true })
    else this.scroller.focus({ preventScroll: true })
  }

  /**
   * Rule the EMPTY space past the last row and the last column.
   *
   * A spreadsheet's grid does not stop where the data stops — Excel and Sheets
   * both rule the whole window, and that continuing lattice is a good part of
   * what makes a grid read as a sheet rather than as a table someone put on a
   * web page. dash drew rows only where rows existed, so an eight-row workbook
   * ended in a large white rectangle.
   *
   * Painted as a BACKGROUND on the scrolling element rather than as filler
   * rows: empty rows would be real DOM, would have to be virtualised, and would
   * be selectable and editable — a grid you can type into a thousand rows below
   * your data is a different product decision, and not one to make by accident.
   * The background costs nothing and cannot be clicked.
   *
   * It lives on `.dg-table`, which scrolls WITH the content, so the lines stay
   * aligned to the rows. `background-position` steps it down past the header,
   * which is in normal flow above the sizer.
   *
   * AND IT STOPS AT `contentH`. It used to `repeat-y` forever, which drew ruled
   * rows below the last row of the sheet that looked exactly like empty
   * spreadsheet rows and selected nothing when clicked — the visual half of the
   * lie the appender fixes the other half of. Both layers are now sized to the
   * content and told not to repeat, so what is below the data is plain
   * background: the truthful picture of a sheet that ends. The row lattice is
   * offset past the header; the column rules start at the top of `.dg-table`
   * and so have to be that much taller.
   */
  private paintEmptyGrid(contentH: number): void {
    const vis = cols(this.sheet)
    const line = 'var(--grid-line, #edf0f4)'
    // vertical rules at each column boundary, starting after the gutter
    const stops: string[] = []
    let x = GUTTER_W
    stops.push(`transparent 0 ${x - 1}px`, `${line} ${x - 1}px ${x}px`)
    for (const c of vis) {
      const w = c.w ?? 130
      stops.push(`transparent ${x}px ${x + w - 1}px`, `${line} ${x + w - 1}px ${x + w}px`)
      x += w
    }
    const headH = ROW_H + 20
    this.table.parentElement!.style.backgroundImage =
      `repeating-linear-gradient(to bottom, transparent 0 ${ROW_H - 1}px, ${line} ${ROW_H - 1}px ${ROW_H}px),` +
      `linear-gradient(to right, ${stops.join(',')}, transparent ${x}px)`
    this.table.parentElement!.style.backgroundPosition = `0 ${headH}px, 0 0`
    // The ruled area is exactly as WIDE as the sheet. Excel rules to the window
    // edge because its columns go on forever; dash's do not, and ruling past
    // the last one draws cells that cannot be typed into. So the row rules tile
    // down within the sheet's width and stop, and past the final column is
    // plain background — which is the truthful answer to "is there anything
    // over there".
    this.table.parentElement!.style.backgroundSize =
      `${x}px ${contentH}px, ${x}px ${headH + contentH}px`
    this.table.parentElement!.style.backgroundRepeat = 'no-repeat, no-repeat'
  }

  // --- the empty states ------------------------------------------------------
  //
  // A SHEET WITH NOTHING IN IT IS THE ONE SCREEN THAT CANNOT EXPLAIN ITSELF by
  // showing its contents, and dash had three of them that each showed a
  // rectangle of nothing: a dataset with no rows (a heading strip and a `+`),
  // a dataset with no columns (a corner box and a `+`, and no appender at all
  // because `frontierRow` correctly refuses one when there is nothing to type
  // into), and a brand-new spreadsheet (a lattice, and no reason to believe
  // clicking it would do anything).
  //
  // Each note says WHICH KIND you are in and WHAT THE NEXT GESTURE IS, because
  // those are the two facts a reader is missing and they are the two facts that
  // differ between the kinds. This is the cheapest place in the app to teach
  // the column/cell distinction: it is the only moment the reader has nothing
  // else to look at.
  //
  // NOT SHOWN IN A READ-ONLY WORKBOOK — or rather, shown without its
  // invitation. "Type here to add one" in a file that refuses every keystroke
  // is the same lie the frontier rules already refuse to tell (see
  // `frontierRow`: no appender in a read-only workbook), so the heading stays
  // and the gesture is replaced by the reason there is not one.

  /** What this sheet has to say when it is empty, or null when it is not. */
  private noteFor(): { head: string; body: string } | null {
    const ro = this.store.readOnly
    const cv = this.canvas
    if (cv) {
      // O(1): the question is "is there ANY cell", never "how many". A
      // spreadsheet is sparse and may be one entry or a hundred thousand.
      for (const _k in cv.cells) return null
      return {
        head: t('This sheet is empty'),
        body: ro
          ? t('This workbook is read-only, so there is nothing to add here.')
          : t('Click any cell and type. A spreadsheet is typed by cell and its grid does not end, so =SUM( works anywhere.'),
      }
    }
    const s = this.sheet
    if (cols(s).length === 0) {
      return {
        head: t('This dataset has no columns'),
        body: ro
          ? t('This workbook is read-only, so there is nothing to add here.')
          : t('A dataset is typed by column: each one has a name and a type. Add the first with the + at the end of the heading row.'),
      }
    }
    if (rowCount(s) > 0) return null
    return {
      head: t('This dataset has no rows'),
      body: ro
        ? t('This workbook is read-only, so there is nothing to add here.')
        : t('Type in the row marked + above to write the first one, or paste a block of rows into it.'),
    }
  }

  /**
   * Put the empty state on screen, or take it off. Called once per paint.
   *
   * The DATASET's note is in NORMAL FLOW under `.dg-table`, so it lands on the
   * desk immediately below the object's bottom edge — the desk is what says
   * "the table ended here" and the note is what says why there is so little of
   * it. The SPREADSHEET's floats over the lattice near A1 instead
   * (`.dg-note-float`, pointer-events: none), because that kind has no desk to
   * put anything on: its grid runs to the window edge by design and a note
   * below the content would be a thousand rows down.
   */
  private paintNote(): void {
    const el = this.noteEl
    const n = this.noteFor()
    if (!n) {
      if (!el.hidden) { el.hidden = true; el.innerHTML = '' }
      return
    }
    const cls = this.canvas ? 'dg-note dg-note-float' : 'dg-note'
    const html = `<b>${esc(n.head)}</b><span>${esc(n.body)}</span>`
    if (el.className !== cls) el.className = cls
    if (el.innerHTML !== html) el.innerHTML = html
    el.hidden = false
  }

  /** Value at a VISIBLE position — what the clipboard and the status bar read. */
  private valueAt(row: number, ci: number): unknown {
    if (this.canvas) return this.cvValueAt(row, ci)
    const s = this.sheet
    const c = cols(s)[ci]
    if (!c) return null
    const rid = ridAt(this.store, s, row)
    // The appender has no rid, and reading through a -1 asks every column for
    // index -1 — `undefined` dressed up as a value the sheet does not hold.
    if (rid < 0) return null
    const r = dataRow(s, rid)
    const fv = this.cellFormulaValue(r, c.id)
    if (fv !== undefined) return fv
    const over = s.cells?.[`${c.id}:${rid}`]
    if (over && 'v' in over) return over.v
    const comp = this.computed.get(c.id)
    return comp ? comp[r] : readCell(s.data[c.id], r)
  }

  /** Write a block of values starting at a visible position. One undo step. */
  private writeBlock(row: number, ci: number, block: unknown[][], extra: Patch[] = []): void {
    if (this.canvas) { this.writeCanvasBlock(row, ci, block); return }
    const s = this.sheet
    const vis = cols(s)
    const patches: Patch[] = [...extra]
    const byCol = new Map<string, { rids: number[]; v: unknown[] }>()
    block.forEach((line, dr) => {
      line.forEach((val, dc) => {
        const c = vis[ci + dc]
        if (!c || c.formula) return          // a computed column is defined by
        const rid = ridAt(this.store, s, row + dr)  // its expression, not by a paste
        if (rid < 0) return
        const e = byCol.get(c.id) ?? { rids: [], v: [] }
        e.rids.push(rid); e.v.push(val)
        byCol.set(c.id, e)
      })
    })
    for (const [col, e] of byCol) patches.push({ op: 'setCells', sheet: s.id, col, rids: e.rids, v: e.v })
    if (patches.length) this.store.commit(patches)
  }

  /** Clear every selected cell — one undo step, formula COLUMNS untouched. */
  clearSelection(): void {
    if (this.canvas) { this.clearCanvasSelection(); return }
    const s = this.sheet
    const b = this.sel.bounds()
    const block: unknown[][] = []
    for (let r = b.top; r <= b.bottom; r++) block.push(new Array(b.right - b.left + 1).fill(null))
    // Clearing a cell has to drop its FORMULA too, not just blank the stored
    // value underneath it. Writing nulls alone left the formula in place and it
    // simply recomputed, so a cut appeared to do nothing and Delete on a
    // formula cell was a no-op.
    const keys: string[] = []
    const overs: Array<Record<string, unknown> | null> = []
    const vis = cols(s)
    for (let r = b.top; r <= b.bottom; r++) {
      for (let c = b.left; c <= b.right; c++) {
        const col = vis[c]
        if (!col) continue
        const rid = ridAt(this.store, s, r)
        const key = `${col.id}:${rid}`
        const had = s.cells?.[key]
        if (had?.f === undefined) continue
        const { f: _f, ...rest } = had
        keys.push(key)
        overs.push(Object.keys(rest).length ? rest : null)
      }
    }
    // ONE commit, so one ⌘Z puts back both the values and the formulas.
    this.writeBlock(b.top, b.left, block, keys.length
      ? [{ op: 'setOverrides', sheet: s.id, keys, v: overs as never, dropEmpty: true }]
      : [])
  }

  /** Write the formula bar's contents into the active cell. */
  setActiveCell(text: string): void {
    // On a SPREADSHEET a leading `=` is a cell formula, full stop. The dataset
    // path sends it to the COLUMN's expression because that is where a dataset
    // keeps one; here there is no column to own it, which is the whole reason
    // this kind exists — `=SUM(A1:A5)` under a block of numbers had nowhere to
    // land.
    if (this.canvas) {
      if (this.store.readOnly) return
      const cur = this.sel.cursor
      const key = canvasKey(cur.row, cur.col)
      const had = this.canvas.cells[key]
      const next = canvasCellEdit(had, text)
      if (next !== null || had !== undefined) this.writeCanvas({ [key]: next })
      return
    }
    const s = this.sheet
    const c = cols(s)[this.sel.cursor.col]
    if (!c || this.store.readOnly) return
    if (text.trim().startsWith('=')) {
      // a leading = in the formula bar sets the COLUMN's expression: dash's
      // formulas are per column, so this is the honest place for it to land
      this.store.commit({ op: 'setColumn', sheet: s.id, col: c.id, patch: { formula: text.trim().slice(1).trim() } })
      return
    }
    if (c.formula) return  // typing a value over a computed column would be
    // A VALUE needs a row to live in, so the formula bar over the appender
    // appends one — the same rule as typing into the cell directly. (The `=`
    // branch above does not: a column formula is a property of the column and
    // wants no new row.)
    if (!this.materialiseCursorRow()) return
    this.writeBlock(this.sel.cursor.row, this.sel.cursor.col, [[coerceForColumn(text, c.type)]])
  }

  /**
   * The clip this grid last copied — formulas and all.
   *
   * The SYSTEM clipboard carries values, because that is what every other
   * application expects to receive: paste into Numbers or a mail message and
   * `=D1*3` is not useful there, £37,200 is. But pasting back into a
   * spreadsheet has to preserve the formula, so the copy is remembered here and
   * a paste whose text still MATCHES what we wrote is recognised as our own.
   * That is how Excel and Sheets behave, and the text comparison is what makes
   * it honest: copy something else in between and the match fails, so a stale
   * internal clip can never be pasted in place of what the user actually
   * copied.
   */
  private clip: {
    tsv: string
    block: Array<Array<{ v: unknown; f?: string }>>
    /** a CUT, not a copy — see writeClip for why that changes the answer */
    cut?: boolean
  } | null = null

  /**
   * ⌘C and ⌘X, as one method — because the gutter menus' Copy and Cut are the
   * SAME gesture reached with a mouse, and two implementations of a cut is how
   * one of them forgets to set `clip.cut` and pastes a copy instead.
   */
  copyToClipboard(cut: boolean): void {
    void navigator.clipboard?.writeText(this.copyTsv())
    if (!cut) return
    if (this.clip) this.clip.cut = true
    this.clearSelection()
  }

  copyTsv(): string {
    const b = this.sel.bounds()
    const tsv = tsvFromRange((r, c) => this.valueAt(r, c),
      { anchor: { row: b.top, col: b.left }, head: { row: b.bottom, col: b.right } } as Range)
    const cv = this.canvas
    if (cv) {
      // Visible IS canonical here — there is no order vector to see through —
      // so the offset a paste translates by is measured straight off the
      // selection.
      const block: Array<Array<{ v: unknown; f?: string }>> = []
      for (let r = b.top; r <= b.bottom; r++) {
        const line: Array<{ v: unknown; f?: string }> = []
        for (let c = b.left; c <= b.right; c++) {
          line.push({ v: this.cvValueAt(r, c), f: cv.cells[canvasKey(r, c)]?.f })
        }
        block.push(line)
      }
      this.clip = { tsv, block }
      this.clipTop = b.top
      this.clipLeft = b.left
      return tsv
    }
    const s = this.sheet
    const block: Array<Array<{ v: unknown; f?: string }>> = []
    for (let r = b.top; r <= b.bottom; r++) {
      const line: Array<{ v: unknown; f?: string }> = []
      for (let c = b.left; c <= b.right; c++) {
        const col = cols(s)[c]
        const dr = dataRow(s, ridAt(this.store, s, r))
        line.push({
          v: this.valueAt(r, c),
          f: col ? this.formulaAtPos(dr, s.columns.findIndex((x) => x.id === col.id)) : undefined,
        })
      }
      block.push(line)
    }
    this.clip = { tsv, block }
    this.clipTop = dataRow(s, ridAt(this.store, s, b.top))
    this.clipLeft = s.columns.findIndex((x) => x.id === cols(s)[b.left]?.id)
    return tsv
  }

  pasteTsv(text: string): void {
    const cur = this.sel.cursor
    // A PASTE ONTO THE APPENDER APPENDS. Without this the write would find no
    // rid under any of its lines and land nowhere — a paste that silently does
    // nothing, which is the same class of failure the appender exists to fix.
    // The rows go in first, in their own commit, so the values have somewhere
    // to go; only `pasteTsv` does this, and not `writeBlock`, because
    // `clearSelection` also goes through `writeBlock` and a Delete over the
    // appender must not grow the sheet.
    if (this.isFrontier(cur.row)) {
      const lines = this.clip && this.clip.tsv === text
        ? this.clip.block.length : parseTsv(text).length
      if (lines > 0) this.appendRows(lines)
    }
    // our own clip, still intact on the system clipboard? then formulas ride
    // along, TRANSLATED by how far the block moved
    if (this.clip && this.clip.tsv === text) {
      if (this.canvas) this.writeCanvasClip(cur.row, cur.col, this.clip.block)
      else this.writeClip(cur.row, cur.col, this.clip.block)
      return
    }
    const grid = parseTsv(text)
    if (!grid.length) return
    this.writeBlock(cur.row, cur.col, grid)
  }

  /**
   * Paste a remembered block, translating each formula by the offset it moved.
   *
   * The offset is measured in CANONICAL positions, not visible ones: A1
   * addresses name the document, so a block copied and pasted while a sort is
   * on must shift by the distance the cells actually moved, not by the distance
   * they appear to have moved.
   */
  private writeClip(
    row: number, ci: number, block: Array<Array<{ v: unknown; f?: string }>>,
  ): void {
    const s = this.sheet
    const vis = cols(s)
    const srcTop = this.clipTop ?? row
    const srcLeft = this.clipLeft ?? ci
    const cut = this.clip?.cut === true
    const patches: Patch[] = []
    const byCol = new Map<string, { rids: number[]; v: unknown[] }>()
    const keys: string[] = []
    const overs: Array<Record<string, unknown> | null> = []
    block.forEach((line, dr) => {
      line.forEach((cellv, dc) => {
        const c = vis[ci + dc]
        if (!c || c.formula) return
        const rid = ridAt(this.store, s, row + dr)
        if (rid < 0) return
        const key = `${c.id}:${rid}`
        if (cellv.f !== undefined) {
          // A CUT does not translate. Copying makes a second formula that
          // should mean the same thing in its new place, so its references
          // move; cutting moves the ONE formula, and a formula that travels
          // with its cells still means exactly what it did. Excel agrees, and
          // getting this backwards silently re-points a moved formula at the
          // wrong data.
          //
          // NOT DONE, and a real limitation: formulas ELSEWHERE that referenced
          // the cut cells should follow them to the new location. They do not —
          // they keep pointing at the old, now-empty positions.
          const dRow = cut ? 0 : dataRow(s, rid) - (srcTop + dr)
          const dColIdx = cut ? 0 : s.columns.findIndex((x) => x.id === c.id) - (srcLeft + dc)
          keys.push(key)
          overs.push({ ...(s.cells?.[key] ?? {}), f: translateCellFormula(cellv.f, dRow, dColIdx) })
        } else {
          const e = byCol.get(c.id) ?? { rids: [], v: [] }
          e.rids.push(rid); e.v.push(cellv.v)
          byCol.set(c.id, e)
          // pasting a plain value over a formula cell must REMOVE the formula
          const had = s.cells?.[key]
          if (had?.f !== undefined) {
            const { f: _f, ...rest } = had
            keys.push(key)
            overs.push(Object.keys(rest).length ? rest : null)
          }
        }
      })
    })
    for (const [col, e] of byCol) patches.push({ op: 'setCells', sheet: s.id, col, rids: e.rids, v: e.v })
    if (keys.length) {
      patches.push({ op: 'setOverrides', sheet: s.id, keys, v: overs as never, dropEmpty: true })
    }
    if (patches.length) this.store.commit(patches)
  }

  /**
   * The same paste on a spreadsheet: a COPIED formula's references move with
   * it, a CUT one's do not. Excel's rule, and getting it backwards silently
   * re-points a moved formula at the wrong data.
   */
  private writeCanvasClip(
    row: number, col: number, block: Array<Array<{ v: unknown; f?: string }>>,
  ): void {
    const s = this.canvas
    if (!s) return
    const cut = this.clip?.cut === true
    const dRow = cut ? 0 : row - (this.clipTop ?? row)
    const dCol = cut ? 0 : col - (this.clipLeft ?? col)
    const cells: Record<string, CanvasCell | null> = {}
    block.forEach((line, dr) => {
      line.forEach((cellv, dc) => {
        const r = row + dr
        const c = col + dc
        if (r >= CANVAS_MAX_ROWS || c >= CANVAS_MAX_COLS) return
        const key = canvasKey(r, c)
        const had = s.cells[key]
        const { v: _v, f: _f, ...rest } = had ?? {}
        if (cellv.f !== undefined) {
          cells[key] = { ...rest, f: translateCellFormula(cellv.f, dRow, dCol) }
        } else {
          const next: CanvasCell | null = cellv.v == null || cellv.v === ''
            ? (Object.keys(rest).length ? rest : null)
            : { ...rest, v: cellv.v }
          if (next !== null || had !== undefined) cells[key] = next
        }
      })
    })
    this.writeCanvas(cells)
  }

  /** Canonical top-left of the remembered clip, for measuring the paste offset. */
  private clipTop: number | null = null
  private clipLeft: number | null = null

  /**
   * What a cell IS, for a fill — its formula source, or its STORED value.
   *
   * Deliberately not `valueAt`, which answers what the cell SHOWS. Seeding a
   * fill from the shown value writes a formula's result back as a constant, and
   * — when the formula errored — writes the error OBJECT into the column, which
   * is not a value any column can hold. Both destroy the cell they copied, and
   * the file afterwards holds no evidence of what was there.
   */
  private sourceAt(row: number, ci: number): FillCell {
    const cv = this.canvas
    if (cv) {
      const cell = cv.cells[canvasKey(row, ci)]
      if (typeof cell?.f === 'string' && cell.f !== '') return { f: cell.f }
      return { v: cell && 'v' in cell ? cell.v : null }
    }
    const s = this.sheet
    const c = cols(s)[ci]
    if (!c) return { v: null }
    const rid = ridAt(this.store, s, row)
    const r = dataRow(s, rid)
    const f = this.formulaAtPos(r, s.columns.findIndex((x) => x.id === c.id))
    if (f !== undefined) return { f }
    const over = s.cells?.[`${c.id}:${rid}`]
    if (over && 'v' in over) return { v: over.v }
    // A COMPUTED column is defined by its expression: the write path refuses to
    // touch one, so what is read here can only ever be a seed for its own
    // column and never lands anywhere.
    const comp = this.computed.get(c.id)
    return { v: comp ? comp[r] : readCell(s.data[c.id], r) }
  }

  /**
   * ⌘D — the TOP row of the selection, copied down over the rest.
   *
   * Excel's Fill Down, and one seed row exactly: reading a second row and
   * detecting a series between them is the fill HANDLE's job, where the drag
   * says which cells are the seed. Conflating them made ⌘D over four rows
   * alternate rows one and two down the column, overwriting the other two.
   */
  fillDownSelection(): void {
    const b = this.sel.bounds()
    if (b.bottom <= b.top) return
    this.fillVertical(b, b.top, 'copy')
  }

  /**
   * The fill HANDLE, released. `seed` is the block that was selected when the
   * drag began — that block is the seed, and everything the drag added below it
   * continues the series it reads out of them.
   */
  fillHandleTo(seed: Box): void {
    const b = this.sel.bounds()
    if (b.bottom <= seed.bottom) return
    this.fillVertical({ ...b, left: seed.left, right: seed.right }, seed.bottom, 'series')
  }

  /**
   * One fill, both kinds, one undo step.
   *
   * `seedBottom` is the last row of the seed band (rows `b.top..seedBottom`);
   * everything below it is written. The seed rows themselves are never
   * rewritten — a fill must leave what it copied byte-identical, and rewriting
   * a formula cell "unchanged" is a chance to get the translation wrong by
   * zero.
   */
  private fillVertical(b: Box, seedBottom: number, mode: FillMode): void {
    if (this.store.readOnly) return
    const rows = b.bottom - b.top + 1
    const seedRows = seedBottom - b.top + 1
    if (seedRows < 1 || rows <= seedRows) return
    // per column: the filled cells, and the seed row each formula came from
    const out = new Map<number, FillCell[]>()
    for (let c = b.left; c <= b.right; c++) {
      const seeds: FillCell[] = []
      for (let r = b.top; r <= seedBottom; r++) seeds.push(this.sourceAt(r, c))
      out.set(c, fillCells(seeds, rows, mode))
    }
    if (this.canvas) this.writeCanvasFill(b, seedRows, out)
    else this.writeTableFill(b, seedRows, out)
  }

  /** The filled cells, written into a DATASET — values and formulas together. */
  private writeTableFill(b: Box, seedRows: number, out: Map<number, FillCell[]>): void {
    const s = this.sheet
    const vis = cols(s)
    const patches: Patch[] = []
    const byCol = new Map<string, { rids: number[]; v: unknown[] }>()
    const keys: string[] = []
    const overs: Array<Record<string, unknown> | null> = []
    for (const [c, filled] of out) {
      const col = vis[c]
      if (!col || col.formula) continue        // a computed column is its expression
      for (let i = seedRows; i < filled.length; i++) {
        const rid = ridAt(this.store, s, b.top + i)
        if (rid < 0) continue
        const key = `${col.id}:${rid}`
        const cell = filled[i]
        if (cell.f !== undefined) {
          // Translated by the distance in CANONICAL rows: the grid reads
          // through a sort order, so a fill down the screen under a sort moves
          // the addresses by however far the rows actually are apart.
          const srcRid = ridAt(this.store, s, b.top + (cell.src ?? 0))
          const dRow = dataRow(s, rid) - dataRow(s, srcRid)
          keys.push(key)
          overs.push({ ...(s.cells?.[key] ?? {}), f: translateCellFormula(cell.f, dRow, 0) })
          continue
        }
        // THE LAST GATE. An error is a computed thing and has no business in
        // storage — nothing upstream produces one any more, and if anything
        // ever does again it stops here rather than in somebody's file.
        if (isErr(cell.v)) continue
        const e = byCol.get(col.id) ?? { rids: [], v: [] }
        e.rids.push(rid); e.v.push(cell.v)
        byCol.set(col.id, e)
        // filling a plain value over a formula cell removes the formula
        const had = s.cells?.[key]
        if (had?.f !== undefined) {
          const { f: _f, ...rest } = had
          keys.push(key)
          overs.push(Object.keys(rest).length ? rest : null)
        }
      }
    }
    for (const [col, e] of byCol) patches.push({ op: 'setCells', sheet: s.id, col, rids: e.rids, v: e.v })
    if (keys.length) patches.push({ op: 'setOverrides', sheet: s.id, keys, v: overs as never, dropEmpty: true })
    if (patches.length) this.store.commit(patches)
  }

  /** The same fill on a SPREADSHEET: one cell is `{v}` or `{f}` at an A1 key. */
  private writeCanvasFill(b: Box, seedRows: number, out: Map<number, FillCell[]>): void {
    const cv = this.canvas
    if (!cv) return
    const cells: Record<string, CanvasCell | null> = {}
    for (const [c, filled] of out) {
      if (c >= CANVAS_MAX_COLS) continue
      for (let i = seedRows; i < filled.length; i++) {
        const r = b.top + i
        if (r >= CANVAS_MAX_ROWS) continue
        const key = canvasKey(r, c)
        const had = cv.cells[key]
        const { v: _v, f: _f, ...rest } = had ?? {}
        const cell = filled[i]
        if (cell.f !== undefined) {
          cells[key] = { ...rest, f: translateCellFormula(cell.f, r - (b.top + (cell.src ?? 0)), 0) }
          continue
        }
        if (isErr(cell.v)) continue
        const next: CanvasCell | null = cell.v == null || cell.v === ''
          ? (Object.keys(rest).length ? rest : null)
          : { ...rest, v: cell.v }
        if (next !== null || had !== undefined) cells[key] = next
      }
    }
    this.writeCanvas(cells)
  }

  /** Fires after every repaint — how an overlay knows to re-place its markers. */
  onPaint?: () => void

  /**
   * The status bar's aggregate over the selection — the number people select
   * cells specifically to see.
   *
   * Shared by both kinds, because it asks nothing about how a cell is stored:
   * `valueAt` already answers for either, and a second copy of the arithmetic
   * would be a second chance to disagree about whether blanks count.
   *
   * A SELECTION ON A SPREADSHEET CAN BE ENORMOUS — the sheet is unbounded, and
   * ⌘A selects the ruled area — so the scan is capped. Past the cap it reports
   * the cell count alone rather than freezing the tab to add up a million
   * blanks.
   */
  private selectionSummary(): string {
    const b = this.sel.bounds()
    if (b.bottom <= b.top && b.right <= b.left) return ''
    const cells = (b.bottom - b.top + 1) * (b.right - b.left + 1)
    if (cells > SUMMARY_MAX) return `Cells ${fmtNum(cells)}`
    const nums: number[] = []
    for (let r = b.top; r <= b.bottom; r++) {
      for (let cc = b.left; cc <= b.right; cc++) {
        const x = this.valueAt(r, cc)
        if (typeof x === 'number' && Number.isFinite(x)) nums.push(x)
      }
    }
    return nums.length
      ? `Sum ${fmtNum(nums.reduce((a, x) => a + x, 0))}  ·  Avg ${fmtNum(nums.reduce((a, x) => a + x, 0) / nums.length)}  ·  Count ${nums.length}  ·  Cells ${cells}`
      : `Cells ${cells}`
  }

  /** Tell the app what is selected, for the formula bar and the status bar. */
  announce(): void {
    if (!this.onSelectionChange) return
    const cv = this.canvas
    if (cv) {
      const cur = this.sel.cursor
      this.onSelectionChange(this.selectionSummary(), canvasKey(cur.row, cur.col),
        this.cvSourceAt(cur.row, cur.col))
      return
    }
    const s = this.sheet
    const vis = cols(s)
    const cur = this.sel.cursor
    const c = vis[cur.col]
    const ref = c ? `${colToLetters(cur.col)}${cur.row + 1}` : ''
    const v = this.valueAt(cur.row, cur.col)
    const raw = v == null ? '' : isErr(v) ? String(v) : String(v)
    const summary = this.selectionSummary()
    // The formula bar shows the SOURCE when there is one — a per-cell formula
    // first, then the column's expression, then the value. A bar that shows the
    // computed number for a formula cell is the one place a spreadsheet user
    // looks to find out whether a number was typed or derived.
    const cellSrc = c
      ? this.formulaAtPos(dataRow(s, ridAt(this.store, s, cur.row)),
          s.columns.findIndex((x) => x.id === c.id))
      : undefined
    this.onSelectionChange(summary, ref,
      cellSrc !== undefined ? cellSrc : c?.formula ? `= ${c.formula}` : raw)
  }

  /** The full keyboard set, routed through select.ts's typed actions. */
  handleKey(e: KeyboardEvent): boolean {
    if (this.editing || this.cvEditing) return false
    const a = keyToAction(e)
    if (!a) return false
    if (a.kind === 'edit') return this.editActive()
    if (a.kind === 'clear') { this.clearSelection(); return true }
    if (a.kind === 'copy' || a.kind === 'cut') {
      this.copyToClipboard(a.kind === 'cut')
      return true
    }
    if (a.kind === 'paste') return false          // the document paste listener has the data
    if (a.kind === 'undo') { this.store.undo(); return true }
    if (a.kind === 'redo') { this.store.redo(); return true }

    const moved = applyMotion(this.sel, a, {
      page: Math.max(1, Math.floor(this.scroller.clientHeight / ROW_H) - 1),
      filled: (row, col) => {
        const v = this.valueAt(row, col)
        return v != null && v !== ''
      },
    })
    if (!moved) return false
    this.scrollIntoView()
    this.paint()
    this.announce()
    return true
  }

  private cellEl(row: number, ci: number): HTMLElement | null {
    return this.table.querySelector<HTMLElement>(`.dg-row[data-row="${row}"] .dg-cell[data-ci="${ci}"]`)
  }

  private scrollIntoView(): void {
    const cv = this.canvas
    const cur = this.sel.cursor
    if (cv) {
      const rs = this.rowSizes(cv, this.canvasExtent(cv, cur).rows)
      const y = rs.top(cur.row)
      const rowH = rs.height(cur.row)
      const head = this.head.offsetHeight || ROW_H
      const top = this.scroller.scrollTop
      if (y < top + head) this.scroller.scrollTop = Math.max(0, y - head)
      else if (y + rowH > top + this.scroller.clientHeight) {
        this.scroller.scrollTop = y + rowH - this.scroller.clientHeight
      }
      // …and sideways, which the dataset path never needed: its columns end.
      const lefts = this.colLefts(cv, cur.col + 2)
      const x = lefts[cur.col]
      const w = lefts[cur.col + 1] - x
      if (x < this.scroller.scrollLeft + GUTTER_W) {
        this.scroller.scrollLeft = Math.max(0, x - GUTTER_W)
      } else if (x + w > this.scroller.scrollLeft + this.scroller.clientWidth) {
        this.scroller.scrollLeft = x + w - this.scroller.clientWidth
      }
      return
    }
    const y = cur.row * ROW_H
    const top = this.scroller.scrollTop
    const h = this.scroller.clientHeight - ROW_H * 2
    if (y < top) this.scroller.scrollTop = y
    else if (y + ROW_H > top + h) this.scroller.scrollTop = y + ROW_H - h
  }

  /**
   * Put a VISIBLE position on screen and select it — the whole of what Find
   * needs from the grid, and the whole reason Find can exist at all.
   *
   * The row is very likely NOT IN THE DOM: the body is windowed to about 55
   * rows, so on a 5,000-row sheet a match in the last row is not an element
   * that could be scrolled to. It is arithmetic instead — rows are absolutely
   * positioned at `top: i * ROW_H`, so the scroll offset of any row is known
   * without the row existing — and the paint that follows materialises it.
   *
   * CENTRED rather than nudged to the edge, and only when it is not already
   * comfortably in view: a match that lands on the last visible line reads as
   * "the end of the data", and a reader stepping through matches needs the
   * next one to appear where the last one was.
   *
   * `focus` defaults to FALSE. Find calls this while the reader is still
   * typing in its field, and taking focus back to the grid would eat the next
   * character of the query.
   */
  revealCell(row: number, col: number, opts: { focus?: boolean } = {}): void {
    const cv = this.canvas
    if (cv) {
      const ext = this.canvasExtent(cv, { row, col })
      if (row < 0 || row >= ext.rows || col < 0 || col >= ext.cols) return
      this.sel.resize(ext.rows, ext.cols)
      this.sel.moveTo(row, col)
      this.scrollIntoView()
      this.paint()
      this.announce()
      if (opts.focus) this.focusGrid()
      return
    }
    const n = this.store.order[this.sheet.id]?.length ?? rowCount(this.sheet)
    if (row < 0 || row >= n || col < 0 || col >= cols(this.sheet).length) return
    this.sel.moveTo(row, col)

    const headH = this.head.offsetHeight || ROW_H + 20
    const vh = this.scroller.clientHeight
    const band = Math.max(ROW_H, vh - headH)
    const y = row * ROW_H
    if (y < this.scroller.scrollTop || y + ROW_H > this.scroller.scrollTop + band) {
      this.scroller.scrollTop = Math.max(0, y - Math.floor((band - ROW_H) / 2))
    }

    // Horizontally, the frozen columns are a band that is always painted over
    // the scroller's left edge, so a cell scrolled to `x` can still be hidden
    // underneath them.
    const vis = cols(this.sheet)
    const lefts = this.frozenLefts()
    const frozenEnd = lefts.length
      ? lefts[lefts.length - 1] + (vis[lefts.length - 1]?.w ?? 130)
      : 0
    let x = GUTTER_W
    for (let i = 0; i < col; i++) x += vis[i]?.w ?? 130
    const w = vis[col]?.w ?? 130
    const vw = this.scroller.clientWidth
    if (x < this.scroller.scrollLeft + frozenEnd) {
      this.scroller.scrollLeft = Math.max(0, x - frozenEnd)
    } else if (x + w > this.scroller.scrollLeft + vw) {
      this.scroller.scrollLeft = x + w - vw
    }

    this.paint()
    this.announce()
    if (opts.focus) this.focusGrid()
  }

  /**
   * Light the cells Find matched on THIS sheet. `hits` carry visible
   * coordinates; anything on another sheet is the caller's to filter out.
   */
  setFindMarks(hits: Iterable<Pick<Hit, 'row' | 'col'>>, cur?: Pick<Hit, 'row' | 'col'> | null): void {
    this.findHits = new Set()
    for (const h of hits) this.findHits.add(`${h.row}:${h.col}`)
    this.findCur = cur ? `${cur.row}:${cur.col}` : ''
    this.paint()
  }

  clearFindMarks(): void {
    if (!this.findHits.size && !this.findCur) return
    this.findHits = new Set()
    this.findCur = ''
    this.paint()
  }

  /**
   * The selection's outline and its fill handle, as ONE absolutely-positioned
   * box over the rows.
   *
   * A per-cell tint alone does not read as a selection — the eye needs the
   * rectangle. And the handle is how a spreadsheet user expects to fill: not a
   * menu item, a square in the corner you drag.
   */
  private outline(): string {
    const b = this.sel.bounds()
    const vis = cols(this.sheet)
    if (!vis.length) return ''
    const w = (i: number) => vis[i]?.w ?? 130
    let left = GUTTER_W
    for (let i = 0; i < b.left; i++) left += w(i)
    let width = 0
    for (let i = b.left; i <= b.right && i < vis.length; i++) width += w(i)
    const top = b.top * ROW_H
    const height = (b.bottom - b.top + 1) * ROW_H
    return `<div class="dg-outline" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px">` +
      `<span class="dg-handle" title="${esc(t('Drag to fill the selection down or across'))}"></span></div>`
  }

  // --- the spreadsheet path --------------------------------------------------
  //
  // Everything below paints and edits a `kind: 'canvas'` sheet. It shares the
  // scroller, the row height, the selection model and the key map with the
  // dataset path above — a second key handler is how two grids in one app start
  // disagreeing about what Tab does — and diverges exactly where the kinds do:
  // no columns, no rids, no order vector, no end.

  /**
   * Recompute what only a document change can alter: the used range and the
   * formulas.
   *
   * THROUGH THE WORKBOOK, not through this sheet alone. `recalcWorkbook` is
   * what makes `Sheet1!A1` resolve, and a spreadsheet that cannot reach another
   * sheet is half a spreadsheet (docs/dash-sheet-kinds.md says so in as many
   * words). `workbookSources` assembles every sheet — including this one, as
   * the SPARSE `canvasCellSource`, which walks the cell map once and hands over
   * its formulas rather than being scanned rows × cols for them.
   *
   * A table sheet's COLUMN formulas are not supplied, so a cross-sheet
   * reference into a calculated column reads blank rather than its number.
   * That is a gap in this call site, not in the engine: `workbookSources` takes
   * a `computed` callback, and it is eager per sheet, so filling it means
   * running formula.ts's `recalc` over every table sheet in the workbook on
   * every keystroke. It wants a cache that does not exist yet.
   *
   * CACHED, because `paint` runs on every scroll event and a recalculation does
   * not depend on where the window is.
   */
  private cvRefresh(s: CanvasSheet): void {
    if (!this.cvDirty) return
    this.cvDirty = false
    // A SPILLED CELL HOLDS NOTHING IN THE DOCUMENT — only the anchor carries
    // the formula — so the used range has to be ruled past the last STORED
    // cell as well. The frontier is only +20 rows past the used range, so a
    // 100-row spill would otherwise paint 40 rows and stop, with no sign
    // that the rest of the answer exists.
    const rc = canvasHasFormulas(s)
      ? recalcWorkbook(workbookSources(this.store.doc), this.store.doc.modified).get(s.id)
      : undefined
    this.cellValues = rc?.values ?? EMPTY_CELLS
    const used = canvasUsed(s)
    const sp = rc ? spillExtent(rc) : { rows: 0, cols: 0 }
    this.cvUsed = { rows: Math.max(used.rows, sp.rows), cols: Math.max(used.cols, sp.cols) }
  }

  /**
   * How far the sheet is ruled: past the data, past the cursor, past the window.
   *
   * THIS IS THE UNBOUNDEDNESS, and it is arithmetic rather than storage. The
   * frontier past the CURSOR is the load-bearing term: it guarantees at least
   * one empty row below wherever the cursor is, so ArrowDown at the bottom
   * always has somewhere to go — `Selection.clamp` stops at `rows - 1`, and
   * without slack the last row would be a floor you cannot step off. Every move
   * is followed by a paint, so the slack is restored before the next keystroke.
   *
   * The window term is why SCROLLING keeps finding sheet: reaching the bottom
   * adds another frontier, and the next scroll adds another, up to the address
   * space a1.ts can spell.
   */
  private canvasExtent(s: CanvasSheet, cursor: { row: number; col: number }): { rows: number; cols: number } {
    this.cvRefresh(s)
    const used = this.cvUsed
    const sc = this.scroller as HTMLElement | undefined
    const seenRows = sc ? Math.ceil((sc.scrollTop + sc.clientHeight) / ROW_H) : 0
    const seenCols = sc ? Math.ceil((sc.scrollLeft + sc.clientWidth) / CANVAS_COL_W) : 0
    return {
      rows: Math.min(CANVAS_MAX_ROWS,
        Math.max(used.rows, cursor.row + 1, seenRows) + FRONTIER_ROWS),
      cols: Math.min(CANVAS_MAX_COLS,
        Math.max(used.cols, cursor.col + 1, seenCols) + FRONTIER_COLS),
    }
  }

  /**
   * Row geometry, with the sparse `rows` height map folded in.
   *
   * The rows are absolutely positioned, so a variable height means every row's
   * top depends on every override above it. That is a prefix sum over the
   * OVERRIDES — a handful of entries — not over the rows, so a sheet with two
   * tall rows and a million ordinary ones costs two additions.
   */
  private rowSizes(s: CanvasSheet, n: number): {
    top: (i: number) => number; height: (i: number) => number
    total: number; first: (y: number) => number
  } {
    const at: number[] = []
    const hs: number[] = []
    for (const k in s.rows ?? {}) {
      const i = Number(k) - 1
      const h = Number(s.rows![k])
      if (!Number.isInteger(i) || i < 0 || i >= n) continue
      if (!Number.isFinite(h) || h <= 0 || h === ROW_H) continue
      at.push(i)
      hs.push(h)
    }
    if (at.length > 1) {
      const order = at.map((_, j) => j).sort((a, b) => at[a] - at[b])
      const a2 = order.map((j) => at[j])
      const h2 = order.map((j) => hs[j])
      for (let j = 0; j < order.length; j++) { at[j] = a2[j]; hs[j] = h2[j] }
    }
    const prefix = new Array<number>(at.length + 1).fill(0)
    for (let j = 0; j < at.length; j++) prefix[j + 1] = prefix[j] + (hs[j] - ROW_H)
    /** how many overrides sit strictly above row `i` */
    const before = (i: number): number => {
      let lo = 0
      let hi = at.length
      while (lo < hi) {
        const m = (lo + hi) >> 1
        if (at[m] < i) lo = m + 1
        else hi = m
      }
      return lo
    }
    const height = (i: number): number => {
      const j = before(i)
      return j < at.length && at[j] === i ? hs[j] : ROW_H
    }
    const top = (i: number): number => i * ROW_H + prefix[before(i)]
    const first = (y: number): number => {
      let lo = 0
      let hi = n
      while (lo < hi) {
        const m = (lo + hi) >> 1
        if (top(m) + height(m) <= y) lo = m + 1
        else hi = m
      }
      return Math.max(0, Math.min(lo, n - 1))
    }
    return { top, height, total: n * ROW_H + prefix[at.length], first }
  }

  /** One column's stored width, or the default. */
  private canvasColW(s: CanvasSheet, c: number): number {
    const v = s.cols?.[colToLetters(c)]
    return typeof v === 'number' && Number.isFinite(v) && v >= MIN_COL_W ? v : CANVAS_COL_W
  }

  /** Left edge of every column, gutter included, indexed 0..n (n = the right edge). */
  private colLefts(s: CanvasSheet, n: number): number[] {
    const out = new Array<number>(n + 1)
    let x = GUTTER_W
    for (let c = 0; c < n; c++) { out[c] = x; x += this.canvasColW(s, c) }
    out[n] = x
    return out
  }

  /** The computed value of a canvas cell, if it holds a formula. */
  private cvComputed(row: number, col: number): unknown {
    if (this.cellValues === EMPTY_CELLS) return undefined
    const k = cellKey(row, col)
    return this.cellValues.has(k) ? this.cellValues.get(k) : undefined
  }

  /** What a canvas cell SHOWS — a formula's result, else the stored value. */
  private cvValueAt(row: number, col: number): unknown {
    const s = this.canvas
    if (!s) return null
    const cell = s.cells[canvasKey(row, col)]
    if (cell?.f !== undefined) {
      const v = this.cvComputed(row, col)
      return v === undefined ? null : v
    }
    return this.cvComputed(row, col) ?? (cell && 'v' in cell ? cell.v : null)
  }

  /** What a canvas cell IS — the formula source when it has one. The formula bar. */
  private cvSourceAt(row: number, col: number): string {
    const s = this.canvas
    if (!s) return ''
    const cell = s.cells[canvasKey(row, col)]
    if (typeof cell?.f === 'string') return cell.f
    const v = cell && 'v' in cell ? cell.v : null
    return v == null ? '' : String(v)
  }

  private paintCanvas(s: CanvasSheet, hadFocus = false): void {
    this.host.classList.add('dg-canvas')
    const ext = this.canvasExtent(s, this.sel.cursor)
    this.sel.resize(ext.rows, ext.cols)
    const rs = this.rowSizes(s, ext.rows)
    const lefts = this.colLefts(s, ext.cols)
    // BOTH AXES have to be declared, and only one of them was. The sizer's
    // HEIGHT is what gives the scrollbar something to run down; without a WIDTH
    // the scroller's extent is whatever the painted window happens to measure,
    // so scrolling right stopped four columns past the edge of the screen and
    // the sheet appeared to end at K. The dataset path never needed it — every
    // column it has is in the DOM — and that is exactly why it was missing.
    this.table.style.height = `${rs.total}px`
    this.table.style.width = `${lefts[ext.cols]}px`

    // The window, both ways. Vertically because a sheet is a million rows deep;
    // HORIZONTALLY too, which the dataset path never needed — it has as many
    // columns as the file has, and this one has 16,384.
    const sc = this.scroller
    const y0 = Math.max(0, sc.scrollTop - OVERSCAN * ROW_H)
    const r0 = rs.first(y0)
    const r1 = Math.min(ext.rows, rs.first(sc.scrollTop + sc.clientHeight) + OVERSCAN + 1)
    let c0 = 0
    while (c0 < ext.cols - 1 && lefts[c0 + 1] <= sc.scrollLeft + GUTTER_W) c0++
    let c1 = c0
    while (c1 < ext.cols && lefts[c1] < sc.scrollLeft + sc.clientWidth) c1++
    c1 = Math.min(ext.cols, c1 + 1)
    // The columns to the left of the window are ONE spacer, not 500 empty divs.
    const padLeft = lefts[c0] - GUTTER_W
    const pad = padLeft > 0 ? `<div class="dg-cell dg-pad" style="width:${padLeft}px"></div>` : ''

    // Data validation, read once per paint. On THIS kind there is no column to
    // hang a rule on, so a rule covers an A1 RANGE and the sheet carries the
    // list — Excel's `sqref`, and model.ts's DATA VALIDATION block says why it
    // is not a field on the cell.
    const dvRules = canvasRules(s)

    const box = this.sel.bounds()
    const body: string[] = []
    for (let i = r0; i < r1; i++) {
      const h = rs.height(i)
      const hst = h === ROW_H ? '' : `;height:${h}px`
      const rowSel = i >= box.top && i <= box.bottom
      const cells: string[] = []
      for (let c = c0; c < c1; c++) {
        const key = canvasKey(i, c)
        const cell = s.cells[key]
        const v = this.cvValueAt(i, c)
        const inSel = this.sel.ranges().some((rg) => contains(rg, i, c))
        const isCursor = this.sel.cursor.row === i && this.sel.cursor.col === c
        const fk = `${i}:${c}`
        const hit = this.findHits.has(fk)
          ? (this.findCur === fk ? ' dg-find dg-find-cur' : ' dg-find')
          : ''
        let st = `width:${this.canvasColW(s, c)}px;text-align:${canvasAlign(cell, v)}${hst}`
        // A TALL ROW CENTRES ITS TEXT — unless the cell WRAPS, and then this
        // same line hides it. `line-height` set to the row height is how one
        // line sits in the middle of a tall row; on a wrapped cell it becomes
        // the height of EVERY line, so a three-line sentence in a 56px row
        // measured 165px of content in a 55px box and lines two and three were
        // simply not on screen. Nothing looked broken: the first line rendered
        // and stopped mid-sentence, which reads as a text that was too long
        // rather than a layout that swallowed it.
        //
        // Two features that never met — row heights predate wrapping, and each
        // is correct alone. A wrapped cell gets normal leading and sits at the
        // top, which is what wrapping is for.
        if (h !== ROW_H && !cell?.wrap) st += `;line-height:${h - 1}px`
        else if (cell?.wrap) st += ';line-height:1.35;align-self:start;padding-top:3px'
        // The cell's OWN appearance. These were three hand-written lines for
        // the three fields `CanvasCell` carried since commit one; both kinds
        // now share one vocabulary, so this is `appearanceCss` and the dataset
        // loop above calls the same function. Two paint sites with two ideas
        // of what "bold" means is how they drifted the first time.
        st += appearanceCss(cell)
        const rule = dvRules.length ? canvasRuleAt(dvRules, i, c) : null
        const why = rule ? violationOf(rule, v) : null
        const dvCls = (why !== null ? ` ${INVALID_CLASS}` : '') + (rule && hasDropdown(rule) ? ' dv-list' : '')
        const dvArrow = rule && hasDropdown(rule) ? DROPDOWN_HTML : ''
        const dvTitle = why !== null ? ` title="${esc(why)}"` : ''
        cells.push(
          `<div class="dg-cell${cell?.note ? ' dg-noted' : ''}${isErr(v) ? ' dg-err' : ''}` +
          `${inSel ? ' dg-sel' : ''}${isCursor ? ' dg-cursor' : ''}${hit}${dvCls}"${dvTitle} ` +
          `role="gridcell" aria-colindex="${ariaColIndex(c)}" aria-selected="${inSel}" ` +
          `tabindex="${isCursor ? 0 : -1}" ` +
          `data-ci="${c}" data-key="${key}" style="${st}">` +
          `<span class="dg-v">${esc(canvasShown(cell, v))}</span>${dvArrow}</div>`)
      }
      body.push(
        `<div class="dg-row" role="row" aria-rowindex="${ariaRowIndex(i)}" data-row="${i}" style="top:${rs.top(i)}px${hst}">` +
        `<div class="dg-cell dg-gutter${rowSel ? ' dg-gutter-on' : ''}" role="rowheader" aria-colindex="1" data-rowhead="${i}"` +
        `${hst ? ` style="${hst.slice(1)};line-height:${h - 1}px"` : ''}>${i + 1}` +
        `<span class="dg-rgrip" data-rgrip="${i}" title="${esc(t('Drag to resize the row'))}"></span>` +
        `</div>${pad}${cells.join('')}</div>`)
    }

    // No background lattice: on a spreadsheet the rows past the data are REAL —
    // selectable, typeable — so painting them as a picture (`paintEmptyGrid`,
    // which the dataset path needs precisely because its rows end) would draw a
    // second set of lines underneath the first.
    const surface = this.table.parentElement!
    surface.style.backgroundImage = ''
    this.head.innerHTML = this.canvasHeader(c0, c1, lefts, padLeft, box)
    this.table.innerHTML = body.join('') + this.canvasOutline(rs, lefts, ext)
    this.foot.hidden = true
    this.foot.innerHTML = ''
    this.foot.removeAttribute('aria-rowindex')
    // UNKNOWN, not "the frontier". See ARIA_UNKNOWN: the extent grows with the
    // cursor and the window, so any number here would be both wrong and stale.
    this.gridEl.setAttribute('aria-rowcount', String(ARIA_UNKNOWN))
    this.gridEl.setAttribute('aria-colcount', String(ARIA_UNKNOWN))
    if (s.name) this.gridEl.setAttribute('aria-label', s.name)
    if (this.store.readOnly) this.gridEl.setAttribute('aria-readonly', 'true')
    else this.gridEl.removeAttribute('aria-readonly')
    this.paintNote()
    this.wireCanvas(s, rs)
    this.restoreFocus(hadFocus)
    this.onPaint?.()
  }

  /** Letters, and a grip between each pair. No type, no filter, no sort: a
   *  spreadsheet's columns are not typed and cannot be — see the header note. */
  private canvasHeader(
    c0: number, c1: number, lefts: number[], padLeft: number,
    box: { left: number; right: number },
  ): string {
    const pad = padLeft > 0 ? `<div class="dg-cell dg-pad" style="width:${padLeft}px"></div>` : ''
    let out = `<div class="dg-cell dg-corner" role="columnheader" aria-colindex="1" tabindex="-1" data-all="1" title="${esc(t('Select every cell in the sheet'))}"></div>${pad}`
    for (let c = c0; c < c1; c++) {
      const on = c >= box.left && c <= box.right ? ' dg-h-on' : ''
      // NO `aria-sort`: a spreadsheet's columns are not sortable, and `none`
      // would say they are but are not sorted, which is a different claim.
      out += `<div class="dg-cell dg-h dg-ch${on}" role="columnheader" aria-colindex="${ariaColIndex(c)}" tabindex="-1" data-ci="${c}" style="width:${lefts[c + 1] - lefts[c]}px">` +
        `<span class="dg-letter" title="${esc(t('Select column'))}">${colToLetters(c)}</span>` +
        `<span class="dg-grip" data-cgrip="${c}" title="${esc(t('Drag to resize the column'))}"></span>` +
        `</div>`
    }
    return out
  }

  private canvasOutline(
    rs: { top: (i: number) => number; height: (i: number) => number },
    lefts: number[], ext: { rows: number; cols: number },
  ): string {
    const b = this.sel.bounds()
    if (b.left >= ext.cols || b.top >= ext.rows) return ''
    const right = Math.min(b.right, ext.cols - 1)
    const bottom = Math.min(b.bottom, ext.rows - 1)
    const left = lefts[b.left]
    const width = lefts[right + 1] - left
    const top = rs.top(b.top)
    const height = rs.top(bottom) + rs.height(bottom) - top
    return `<div class="dg-outline" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px">` +
      `<span class="dg-handle" title="${esc(t('Drag to fill the selection down or across'))}"></span></div>`
  }

  private wireCanvas(s: CanvasSheet, rs: { height: (i: number) => number }): void {
    this.wireDropdowns()
    const handle = this.table.querySelector<HTMLElement>('.dg-handle')
    if (handle) {
      handle.onmousedown = (e) => {
        e.preventDefault(); e.stopPropagation()
        const start = this.sel.bounds()
        const move = (m: MouseEvent) => {
          const el = (m.target as HTMLElement)?.closest?.('.dg-row[data-row]') as HTMLElement | null
          if (!el) return
          const r2 = Number(el.dataset.row)
          if (Number.isFinite(r2) && r2 >= start.top) {
            this.sel.moveTo(start.top, start.left)
            this.sel.extendTo(r2, start.right)
            this.paint()
          }
        }
        const up = () => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          // The block that was selected when the drag began IS the seed — so
          // two cells holding 1 and 2 continue 3, 4, 5. ⌘D is the other
          // gesture and copies one row; they must not share a call.
          this.fillHandleTo(start)
          this.announce()
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }
    }
    this.head.querySelectorAll<HTMLElement>('.dg-letter').forEach((el) => {
      el.onclick = () => {
        const ci = Number(el.closest<HTMLElement>('[data-ci]')?.dataset.ci)
        if (!Number.isFinite(ci)) return
        this.sel.selectCol(ci)
        this.paint(); this.announce()
      }
    })
    const corner = this.head.querySelector<HTMLElement>('.dg-corner')
    if (corner) corner.onclick = () => { this.sel.selectAll(); this.paint(); this.announce() }
    this.table.querySelectorAll<HTMLElement>('[data-rowhead]').forEach((el) => {
      el.onmousedown = (e) => {
        if ((e.target as HTMLElement).dataset.rgrip !== undefined) return
        this.sel.selectRow(Number(el.dataset.rowhead))
        this.paint(); this.announce(); this.focusGrid()
      }
    })
    // COLUMN WIDTH and ROW HEIGHT: live on the DOM through the drag, one commit
    // on release. A commit per mousemove is one undo entry per pixel — the same
    // rule the dataset path's grip follows, and the reason both need a real
    // mouse to QA rather than a synthetic drag.
    this.head.querySelectorAll<HTMLElement>('[data-cgrip]').forEach((el) => {
      const c = Number(el.dataset.cgrip)
      el.onmousedown = (e) => {
        e.preventDefault(); e.stopPropagation()
        const startX = e.clientX
        const startW = this.canvasColW(s, c)
        const cell = el.parentElement as HTMLElement
        const at = (m: MouseEvent) => Math.max(MIN_COL_W, Math.round(startW + m.clientX - startX))
        const move = (m: MouseEvent) => {
          const w = at(m)
          cell.style.width = `${w}px`
          this.table.querySelectorAll<HTMLElement>(`.dg-cell[data-ci="${c}"]`)
            .forEach((x) => { x.style.width = `${w}px` })
        }
        const up = (m: MouseEvent) => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          const w = at(m)
          if (w !== startW) this.setCanvasSize('col', c, w)
          else this.paint()
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }
    })
    this.table.querySelectorAll<HTMLElement>('[data-rgrip]').forEach((el) => {
      const i = Number(el.dataset.rgrip)
      el.onmousedown = (e) => {
        e.preventDefault(); e.stopPropagation()
        const startY = e.clientY
        const startH = rs.height(i)
        const row = el.closest<HTMLElement>('.dg-row')
        const at = (m: MouseEvent) => Math.max(MIN_ROW_H, Math.round(startH + m.clientY - startY))
        const move = (m: MouseEvent) => {
          const h = at(m)
          if (!row) return
          row.style.height = `${h}px`
          row.querySelectorAll<HTMLElement>('.dg-cell')
            .forEach((x) => { x.style.height = `${h}px`; x.style.lineHeight = `${h - 1}px` })
        }
        const up = (m: MouseEvent) => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          const h = at(m)
          if (h !== startH) this.setCanvasSize('row', i, h)
          else this.paint()
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }
    })
    this.table.querySelectorAll<HTMLElement>('.dg-row[data-row] .dg-cell[data-key]').forEach((el) => {
      const row = Number(el.parentElement!.dataset.row)
      const ci = Number(el.dataset.ci)
      el.onmousedown = (e) => {
        if (e.button !== 0) return
        if (e.shiftKey) this.sel.extendTo(row, ci)
        else this.sel.moveTo(row, ci)
        this.paint(); this.announce(); this.focusGrid()
        const move = (m: MouseEvent) => {
          const x = (m.target as HTMLElement)?.closest?.('.dg-cell[data-ci]') as HTMLElement | null
          if (!x || !x.parentElement?.dataset.row) return
          const r2 = Number(x.parentElement.dataset.row)
          const c2 = Number(x.dataset.ci)
          if (Number.isFinite(r2) && Number.isFinite(c2)) {
            this.sel.extendTo(r2, c2); this.paint(); this.announce()
          }
        }
        const up = () => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }
      // NO `onContextMenu` HERE, deliberately. The cell menu (main.ts
      // `openCellMenu`) is a menu about a DATASET — insert row, delete row,
      // add a note keyed by rid — and it opens by reading `grid.sheet`, which
      // throws on this kind. Handing it a spreadsheet would crash the menu;
      // pretending with a menu of items that cannot work would be worse. The
      // browser's own menu is left in place until this kind has one of its own.
      el.ondblclick = () => this.editCanvas(row, ci, el)
    })
  }

  /** A stored column width or row height. `cols` is keyed by LETTER, `rows` by
   *  the 1-based number — the same spelling as an A1 address, so a reader of the
   *  JSON can see which column `"C": 180` is about. */
  private setCanvasSize(axis: 'col' | 'row', i: number, px: number): void {
    const s = this.canvas
    if (!s || this.store.readOnly) return
    const key = axis === 'col' ? colToLetters(i) : String(i + 1)
    this.store.commit(axis === 'col'
      ? { op: 'setCanvasSizes', sheet: s.id, cols: { [key]: px } }
      : { op: 'setCanvasSizes', sheet: s.id, rows: { [key]: px } })
  }

  /** Write cells into a canvas sheet. One patch, one undo step. */
  private writeCanvas(cells: Record<string, CanvasCell | null>, run?: string): void {
    const s = this.canvas
    if (!s || this.store.readOnly || !Object.keys(cells).length) return
    const p: Patch = { op: 'setCanvasCells', sheet: s.id, cells }
    if (run) this.store.runEdit(run, p)
    else this.store.commit(p)
  }

  /**
   * Open a canvas cell for editing. `seed` is the character that started it.
   *
   * The same shape as the dataset path's `edit`, and deliberately so: the two
   * differ only in what a cell IS, so anything else that differed — where Enter
   * goes, whether Escape writes — would be a second answer to a question the
   * app has already answered.
   */
  private editCanvas(row: number, col: number, cell: HTMLElement, seed?: string): void {
    const s = this.canvas
    if (!s || this.store.readOnly || this.cvEditing) return
    this.cvEditing = { row, col }
    const key = canvasKey(row, col)
    cell.classList.add('dg-editing')
    cell.contentEditable = 'true'
    // A formula cell edits its SOURCE. Showing the computed value would make
    // every edit of a formula silently replace it with its own last result.
    cell.textContent = seed !== undefined ? seed : this.cvSourceAt(row, col)
    cell.focus()
    const range = document.createRange()
    range.selectNodeContents(cell)
    if (seed !== undefined) range.collapse(false)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)

    let done = false
    const finish = (write: boolean, move?: 'down' | 'up' | 'right' | 'left') => {
      if (done || !this.cvEditing) return
      const typed = cell.textContent ?? ''
      // The refusal, on this kind. Same shape as the dataset path's, and
      // deliberately so — the two editors differ only in what a cell IS.
      if (write && !isFormula(typed)) {
        const rule = canvasRuleAt(canvasRules(this.canvas ?? s), row, col)
        const why = this.refusal(rule, canvasValue(typed))
        if (why !== null) { this.refuse(cell, why); return }
      }
      cell.classList.remove('dv-refused')
      cell.removeAttribute('title')
      done = true
      this.cvEditing = null
      const text = typed
      cell.contentEditable = 'false'
      cell.classList.remove('dg-editing')
      cell.onblur = null
      if (write) {
        const live = this.canvas
        const next = canvasCellEdit(live?.cells[key], text)
        // Nothing to say: typing nothing into a cell that holds nothing must
        // not write a key — that is the sparseness promise, and the one place
        // the frontier could start costing bytes.
        if (next !== null || live?.cells[key] !== undefined) {
          this.writeCanvas({ [key]: next }, key)
          this.store.endRun()
        }
      }
      if (move) {
        const d = move === 'down' ? [1, 0] : move === 'up' ? [-1, 0] : move === 'right' ? [0, 1] : [0, -1]
        this.sel.move(d[0], d[1], {})
        this.scrollIntoView()
      }
      this.paint()
      this.announce()
      this.focusGrid()
    }
    cell.onblur = () => finish(true)
    cell.onkeydown = (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); finish(true, e.shiftKey ? 'up' : 'down'); return }
      if (e.key === 'Tab') { e.preventDefault(); finish(true, e.shiftKey ? 'left' : 'right'); return }
      if (e.key === 'Escape') { e.preventDefault(); finish(false) }
    }
  }

  /** Every selected canvas cell, emptied — one undo step, styles kept. */
  private clearCanvasSelection(): void {
    const s = this.canvas
    if (!s) return
    const b = this.sel.bounds()
    const cells: Record<string, CanvasCell | null> = {}
    for (let r = b.top; r <= b.bottom; r++) {
      for (let c = b.left; c <= b.right; c++) {
        const key = canvasKey(r, c)
        const had = s.cells[key]
        if (had === undefined) continue      // never written: writing a delete
        cells[key] = canvasCellClear(had)    // for it would be a key to remove
      }
    }
    this.writeCanvas(cells)
  }

  /** A block of text laid down from a visible position — paste, and fill. */
  private writeCanvasBlock(row: number, col: number, block: unknown[][]): void {
    const s = this.canvas
    if (!s) return
    const cells: Record<string, CanvasCell | null> = {}
    block.forEach((line, dr) => {
      line.forEach((val, dc) => {
        const r = row + dr
        const c = col + dc
        if (r >= CANVAS_MAX_ROWS || c >= CANVAS_MAX_COLS) return
        const key = canvasKey(r, c)
        const had = s.cells[key]
        // A pasted value is already typed when it came from this grid; text
        // from another application arrives as a string and is read the same way
        // a typed cell is, so `1,200` from Numbers means what it does here.
        const text = val == null ? '' : String(val)
        const next = canvasCellEdit(had, text)
        if (next !== null || had !== undefined) cells[key] = next
      })
    })
    this.writeCanvas(cells)
  }

  /**
   * The in-cell dropdown arrows, on BOTH kinds — one wiring, called from each
   * paint's own wire step.
   *
   * `onmousedown` with `stopPropagation`, not `onclick`: the grid starts a
   * SELECTION on mousedown over a cell, so a click handler alone would move
   * the cursor, repaint, destroy the node under the pointer and never see the
   * click. The same reason the fill handle and the column grips do it.
   */
  private wireDropdowns(): void {
    this.table.querySelectorAll<HTMLElement>('.dv-arrow').forEach((arrow) => {
      arrow.onmousedown = (e) => {
        e.preventDefault(); e.stopPropagation()
        const cell = arrow.closest<HTMLElement>('.dg-cell')
        if (!cell || this.store.readOnly) return
        const cv = this.canvas
        if (cv) {
          const key = cell.dataset.key
          const pos = key ? canvasPos(key) : null
          if (!pos) return
          const rule = canvasRuleAt(canvasRules(cv), pos.row, pos.col)
          if (!rule) return
          openListMenu({
            anchor: cell,
            options: listOptions(rule),
            current: this.cvValueAt(pos.row, pos.col),
            onPick: (v) => {
              const had = this.canvas?.cells[key!]
              const next = canvasCellEdit(had, v)
              if (next !== null || had !== undefined) this.writeCanvas({ [key!]: next })
              this.paint(); this.announce()
            },
          })
          return
        }
        const s = this.sheet
        const colId = cell.dataset.col
        const rid = Number(cell.parentElement?.dataset.rid)
        const col = s.columns.find((c) => c.id === colId)
        if (!col || !Number.isFinite(rid) || rid < 0) return
        const rule = columnRule(col)
        if (!rule) return
        openListMenu({
          anchor: cell,
          options: listOptions(rule),
          current: readCell(s.data[col.id], dataRow(s, rid)),
          onPick: (v) => {
            // Through `coerceForColumn`, exactly as a typed entry is: a list on
            // a number column stores numbers, or the dropdown would be the one
            // door into the sheet that writes the wrong type.
            this.store.commit({
              op: 'setCells', sheet: s.id, col: col.id, rids: [rid],
              v: [coerceForColumn(v, col.type)],
            })
            this.paint(); this.announce()
          },
        })
      }
    })
  }

  /**
   * Does a rule REFUSE this entry, here, now?
   *
   * `reject` is scoped to the keyboard — see datavalid.ts's header. This is
   * called from the two cell editors and from nowhere else on purpose: a
   * paste, a fill, an import, an undo and a remote collaborator's op all land
   * and are MARKED. A refusal on a remote op would either diverge the replicas
   * or discard somebody else's committed work.
   */
  private refusal(rule: DataRule | null, v: unknown): string | null {
    if (!rule || rule.on !== 'reject') return null
    return violationOf(rule, v)
  }

  /** Paint a refusal into the open editor and keep it open. Nothing is
   *  committed, so nothing the author typed is lost; Escape abandons it. */
  private refuse(cell: HTMLElement, why: string): void {
    cell.classList.add('dv-refused')
    cell.title = why
    if (this.descEl) this.descEl.textContent = why
    cell.focus()
  }

  private wire(): void {
    this.wireDropdowns()
    // the fill handle: drag down to extend the selection and fill it
    const handle = this.table.querySelector<HTMLElement>('.dg-handle')
    if (handle) {
      handle.onmousedown = (e) => {
        e.preventDefault(); e.stopPropagation()
        const start = this.sel.bounds()
        const move = (m: MouseEvent) => {
          const t = (m.target as HTMLElement)?.closest?.('.dg-row[data-row]') as HTMLElement | null
          if (!t) return
          const r2 = Number(t.dataset.row)
          if (Number.isFinite(r2) && r2 >= start.top) {
            this.sel.moveTo(start.top, start.left)
            this.sel.extendTo(r2, start.right)
            this.paint()
          }
        }
        const up = () => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          this.fillHandleTo(start)   // the selected block seeds the series
          this.announce()
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }
    }
    this.head.querySelectorAll<HTMLElement>('.dg-name').forEach((el) => {
      el.onclick = () => {
        const col = el.closest<HTMLElement>('[data-col]')?.dataset.col
        if (col) this.toggleSort(col)
      }
    })
    // select a whole column by its letter, the whole sheet by the corner
    this.head.querySelectorAll<HTMLElement>('.dg-letter').forEach((el) => {
      el.onclick = () => {
        // `closest`, not `parentElement`: the letter sits inside a strip now,
        // and reading `ci` off the immediate parent gave NaN the moment the
        // header grew a second line.
        const ci = Number(el.closest<HTMLElement>('[data-ci]')?.dataset.ci)
        if (!Number.isFinite(ci)) return
        this.sel.selectCol(ci)
        this.paint(); this.announce()
      }
    })
    // THE COLUMN GUTTER, right-clicked. On the WHOLE header cell and not just
    // the letter strip: the reader aiming at "this column" aims at the name,
    // the type badge or the letter without distinguishing between them, and a
    // menu that appears over one third of the target is a menu that does
    // nothing twice out of three.
    this.head.querySelectorAll<HTMLElement>('.dg-h[data-col]').forEach((el) => {
      el.oncontextmenu = (e) => {
        e.preventDefault()
        const ci = Number(el.dataset.ci)
        // SELECT FIRST, unless this column is already inside the selection —
        // the same rule the cell menu follows, and the reason right-clicking
        // one of three selected columns still means all three.
        const box = this.sel.bounds()
        if (!(ci >= box.left && ci <= box.right)) {
          this.sel.selectCol(ci)
          this.paint(); this.announce()
        }
        this.onColMenu?.(el.dataset.col!, e.clientX, e.clientY)
      }
    })
    // THE COLUMN APPENDER. A click, not a right-click: it is an invitation, and
    // the file only grows when the dialog it opens is submitted (see
    // `headerAppender` for why a column cannot be typed into being).
    const addCol = this.head.querySelector<HTMLElement>('.dg-add-col')
    if (addCol) addCol.onclick = () => this.onAddColumn?.()
    const corner = this.head.querySelector<HTMLElement>('.dg-corner')
    if (corner) corner.onclick = () => { this.sel.selectAll(); this.paint(); this.announce() }
    // filter caret
    this.head.querySelectorAll<HTMLElement>('[data-filter]').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation()
        const r = el.getBoundingClientRect()
        this.onFilterMenu?.(el.dataset.filter!, r.left, r.bottom)
      }
    })
    // THE TOTALS ROW, clicked. Every spreadsheet puts this menu on the cell —
    // Excel's total row and Sheets' both — and dash put it in a side panel,
    // which is the one place a reader looking at the number is not looking.
    // `.dg-foot-row` is sticky INSIDE the scroller and sits at the bottom of
    // the window, so the menu it opens has to be placed against the cell's
    // rect and flipped above it; that is panels.ts's job, and it is handed the
    // whole rect for exactly that reason.
    this.foot.querySelectorAll<HTMLElement>('[data-tcol]').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation()
        this.onTotalsMenu?.(el.dataset.tcol!, el.getBoundingClientRect())
      }
    })
    // column resize: drag the grip, double-click to fit the content
    this.head.querySelectorAll<HTMLElement>('[data-grip]').forEach((el) => {
      const id = el.dataset.grip!
      el.onmousedown = (e) => {
        e.preventDefault(); e.stopPropagation()
        const col = this.sheet.columns.find((c) => c.id === id)!
        const startX = e.clientX
        const startW = col.w ?? 130
        const cell = el.parentElement as HTMLElement
        const move = (m: MouseEvent) => {
          // live width during the drag, committed once on release — a commit
          // per mousemove would be one undo entry per pixel
          const w = Math.max(48, Math.round(startW + m.clientX - startX))
          cell.style.width = `${w}px`
          this.table.querySelectorAll<HTMLElement>(`.dg-cell[data-col="${id}"]`)
            .forEach((c) => { c.style.width = `${w}px` })
        }
        const up = (m: MouseEvent) => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          const w = Math.max(48, Math.round(startW + m.clientX - startX))
          if (w !== startW) this.store.commit(resizeColumn(this.sheet, id, w))
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }
      el.ondblclick = (e) => {
        e.stopPropagation()
        const s2 = this.sheet
        const col = s2.columns.find((c) => c.id === id)!
        const comp = this.computed.get(id)
        const w = autoFitWidth(
          (row) => comp ? comp[row] : readCell(s2.data[id], row),
          col, rowCount(s2))
        this.store.commit(resizeColumn(s2, id, w))
      }
    })
    // row header selects the row
    this.table.querySelectorAll<HTMLElement>('[data-rowhead]').forEach((el) => {
      const row = Number(el.dataset.rowhead)
      el.onmousedown = (e) => {
        // A RIGHT BUTTON MUST NOT COLLAPSE THE SELECTION. mousedown fires
        // before contextmenu, so without this guard right-clicking inside a
        // three-row selection re-selected one row and the menu that opened a
        // moment later described a selection the reader never made.
        if ((e as MouseEvent).button !== 0) return
        this.sel.selectRow(row)
        this.paint(); this.announce(); this.focusGrid()
      }
      el.oncontextmenu = (e) => {
        e.preventDefault()
        // THE APPENDER HAS NO MENU. Its gutter is a `+`, not a row number,
        // because the row is not there yet — and "Delete row" over a row that
        // does not exist is exactly the kind of item that teaches a reader to
        // stop trusting the menu. Typing is still how it becomes a row.
        if (this.isFrontier(row)) return
        const box = this.sel.bounds()
        if (!(row >= box.top && row <= box.bottom)) {
          this.sel.selectRow(row)
          this.paint(); this.announce()
        }
        this.onRowMenu?.(row, e.clientX, e.clientY)
      }
    })
    this.head.querySelectorAll<HTMLElement>('[data-retype]').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation()
        const col = this.sheet.columns.find((c) => c.id === el.dataset.retype)
        const r = el.getBoundingClientRect()
        if (col) this.onRetype?.(col, r.left, r.bottom)
      }
    })
    // THE APPENDER'S CELLS. Selecting one is all a click does — the row is not
    // created until something is typed, so clicking around below the data
    // cannot grow the file. Double-click means the same as F2 there: make the
    // row, then edit it.
    this.table.querySelectorAll<HTMLElement>('.dg-add-row .dg-cell[data-ci]').forEach((el) => {
      const row = Number(el.parentElement!.dataset.row)
      const ci = Number(el.dataset.ci)
      el.onmousedown = (e) => {
        if (e.button !== 0) return
        this.sel.moveTo(row, ci)
        this.paint(); this.announce(); this.focusGrid()
      }
      el.ondblclick = () => { this.sel.moveTo(row, ci); this.editActive() }
    })
    this.table.querySelectorAll<HTMLElement>('.dg-row[data-rid] .dg-cell[data-ci]').forEach((el) => {
      const row = Number(el.parentElement!.dataset.row)
      const ci = Number(el.dataset.ci)
      el.onmousedown = (e) => {
        if (e.button !== 0) return
        if (e.shiftKey) this.sel.extendTo(row, ci)
        else this.sel.moveTo(row, ci)
        this.paint(); this.announce()
        // A CLICKED CELL TAKES FOCUS. It did not, and `document.activeElement`
        // was BODY after every click — so a screen reader had no cursor to
        // report and the roving tabindex had no owner. `paint()` runs first so
        // the cell this focuses is the freshly-painted one.
        this.focusGrid()
        // drag to extend
        const move = (m: MouseEvent) => {
          const t = (m.target as HTMLElement)?.closest?.('.dg-cell[data-ci]') as HTMLElement | null
          if (!t) return
          const r2 = Number(t.parentElement!.dataset.row)
          const c2 = Number(t.dataset.ci)
          if (Number.isFinite(r2) && Number.isFinite(c2)) {
            this.sel.extendTo(r2, c2); this.paint(); this.announce()
          }
        }
        const up = () => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }
      el.oncontextmenu = (e) => {
        e.preventDefault()
        if (!this.sel.ranges().some((rg) => contains(rg, row, ci))) {
          this.sel.moveTo(row, ci); this.paint()
        }
        this.onContextMenu?.(row, ci, e.clientX, e.clientY)
      }
      el.ondblclick = () => this.edit(Number(el.parentElement!.dataset.rid), el.dataset.col!, el)
    })
  }

  /**
   * Sorting is VIEW state. It sorts the order vector and never the data, so it
   * takes no checkpoint, sets no dirty flag and produces no op.
   */
  private toggleSort(colId: string): void {
    const dir = this.sort?.col === colId && this.sort.dir === 'asc' ? 'desc' : 'asc'
    this.sort = { col: colId, dir }
    // Shift-click accumulates keys; a plain click replaces them. filter.ts's
    // buildOrder does the multi-key comparison and sinks blanks in BOTH
    // directions, which the hand-rolled single-key sort here did not.
    this.sorts = [{ col: colId, dir }]
    this.applyView()
  }

  /** Add or replace a sort key without clearing the others — shift-click. */
  addSort(colId: string, dir: 'asc' | 'desc'): void {
    this.sorts = this.sorts.filter((k) => k.col !== colId).concat({ col: colId, dir })
    this.sort = { col: colId, dir }
    this.applyView()
  }

  setFilter(colId: string, f: ColumnFilter | null): void {
    this.filters = this.filters.filter((x) => x.col !== colId)
    if (f) this.filters.push(f)
    this.applyView()
  }

  clearView(): void { this.filters = []; this.sorts = []; this.sort = null; this.applyView() }

  /**
   * Open a cell for editing.
   *
   * `seed` is the character that STARTED the edit. Typing over a selected cell
   * replaces its contents in every spreadsheet ever made — it is the single
   * most-used interaction in the whole application, and requiring a
   * double-click first is the difference between "a grid" and "a spreadsheet".
   * When seed is undefined the existing value is loaded and selected, which is
   * what F2 and a double-click do instead.
   */
  private edit(rid: number, colId: string, cell: HTMLElement, seed?: string): void {
    const s = this.sheet
    const col = s.columns.find((c) => c.id === colId)
    if (!col || this.store.readOnly) return
    // a computed column is defined by its expression; typing over one cell
    // would be a value the formula immediately contradicts
    if (col.formula) { this.onEditFormula?.(col); return }
    this.editing = { rid, col: colId }
    const r = dataRow(s, rid)
    const raw = readCell(s.data[colId], r)
    cell.classList.add('dg-editing')
    cell.contentEditable = 'true'
    // A formula cell edits its SOURCE. Showing the computed value would make
    // every edit of a formula silently replace it with its own last result —
    // the cell would look unchanged and the formula would be gone.
    const src = this.formulaAtPos(dataRow(s, rid), s.columns.findIndex((c) => c.id === colId))
    cell.textContent = seed !== undefined ? seed
      : src !== undefined ? src
        : (raw == null ? '' : String(raw))
    cell.focus()
    const range = document.createRange()
    range.selectNodeContents(cell)
    if (seed !== undefined) range.collapse(false)   // caret AFTER the typed char
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)

    let done = false
    const finish = (write: boolean, move?: 'down' | 'up' | 'right' | 'left') => {
      if (done || !this.editing) return
      const typed = cell.textContent ?? ''
      // THE REFUSAL, and the only place in the app that has one. Checked
      // BEFORE anything is torn down, so a refused entry leaves the editor
      // exactly as it was with the author's own text still in it.
      if (write && !isFormula(typed)) {
        const why = this.refusal(columnRule(col), coerceForColumn(typed, col.type))
        if (why !== null) { this.refuse(cell, why); return }
      }
      cell.classList.remove('dv-refused')
      cell.removeAttribute('title')
      done = true
      this.editing = null
      const text = typed
      cell.contentEditable = 'false'
      cell.classList.remove('dg-editing')
      cell.onblur = null
      if (write) {
        const key = `${colId}:${rid}`
        const had = s.cells?.[key]
        if (isFormula(text)) {
          // A formula rides on the cell OVERRIDE (`CellOverride.f`), which the
          // format reserved for exactly this. The stored value is left alone:
          // the document holds the expression and the number is derived, so a
          // file can never carry a result that disagrees with its own formula.
          this.store.runEdit(key, {
            op: 'setOverrides', sheet: s.id, keys: [key], v: [{ ...had, f: text }],
          })
        } else {
          const v = coerceForColumn(text, col.type)
          const patches: Patch[] = [
            { op: 'setCells', sheet: s.id, col: colId, rids: [rid], v: [v] },
          ]
          // Typing over a formula REMOVES it. Leaving `f` in place would show
          // the typed number for one paint and then quietly recompute over it.
          if (had?.f !== undefined) {
            const { f: _f, ...rest } = had
            patches.push({
              op: 'setOverrides', sheet: s.id, keys: [key],
              v: [Object.keys(rest).length ? rest : null], dropEmpty: true,
            })
          }
          this.store.runEdit(key, patches)
        }
        this.store.endRun()
      }
      // COMMIT AND MOVE. Enter goes down, Tab goes right — a spreadsheet that
      // leaves the cursor where it was makes you reach for the mouse between
      // every value, which is most of what data entry is.
      if (move) {
        const d = move === 'down' ? [1, 0] : move === 'up' ? [-1, 0] : move === 'right' ? [0, 1] : [0, -1]
        this.sel.move(d[0], d[1], {})
        this.scrollIntoView()
      }
      this.paint()
      this.announce()
      this.focusGrid()
    }
    cell.onblur = () => finish(true)
    cell.onkeydown = (e) => {
      // stopPropagation on EVERY branch, including the ones that close the
      // editor. finish() clears contentEditable synchronously, so by the time
      // the event reaches the document the "is something being edited?" guard
      // there no longer sees an editor — and Enter moved the cursor twice.
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); finish(true, e.shiftKey ? 'up' : 'down'); return }
      if (e.key === 'Tab') { e.preventDefault(); finish(true, e.shiftKey ? 'left' : 'right'); return }
      if (e.key === 'Escape') { e.preventDefault(); finish(false) }
    }
  }

  /**
   * Keep keystrokes coming to the grid after an edit closes — and after Find
   * closes.
   *
   * FOCUS LANDS ON THE CURSOR CELL, not on the scroller. Both keep the keyboard
   * working (the key handler is on `document`), but only one of them tells a
   * screen reader WHERE the reader is: focusing the scroller announces "grid"
   * and nothing else, and after a click it announced nothing at all because
   * nothing was focused. The scroller stays as the fallback for the moments the
   * cursor is outside the painted window.
   */
  focusGrid(): void {
    const cur = this.sel.cursor
    const cell = this.cellEl(cur.row, cur.col)
    if (cell) { cell.tabIndex = 0; cell.focus({ preventScroll: true }); return }
    if (this.scroller.tabIndex < 0) this.scroller.tabIndex = 0
    this.scroller.focus({ preventScroll: true })
  }

  /**
   * A printable key over a selected cell starts an edit with that character.
   * Called from the app's keydown handler BEFORE keyToAction, because
   * keyToAction deliberately returns null for bare printable keys so that
   * typing can reach exactly here.
   */
  typeInto(ch: string): boolean {
    if (this.editing || this.cvEditing || this.store.readOnly) return false
    if (this.canvas) {
      const cur = this.sel.cursor
      const cell = this.cellEl(cur.row, cur.col)
      if (!cell) return false
      this.editCanvas(cur.row, cur.col, cell, ch)
      return true
    }
    // TYPING ON THE APPENDER IS WHAT MAKES IT A ROW. This is the gesture the
    // whole frontier decision is about: click below the numbers, start typing,
    // and a real row appears under the caret instead of the last data cell
    // being silently overwritten. The append is its own commit and the edit
    // that follows is another, so ⌘Z takes back the text and a second ⌘Z takes
    // back the row — which is what "I did two things" should undo as.
    if (!this.materialiseCursorRow()) return false
    const vis = cols(this.sheet)
    const col = vis[this.sel.cursor.col]
    if (!col) return false
    const rid = ridAt(this.store, this.sheet, this.sel.cursor.row)
    if (rid < 0) return false
    const cell = this.cellEl(this.sel.cursor.row, this.sel.cursor.col)
    if (!cell) return false
    this.edit(rid, col.id, cell, ch)
    return true
  }

  /** F2 / double-click: edit the existing value rather than replacing it. */
  editActive(): boolean {
    if (this.editing || this.cvEditing) return false
    if (this.canvas) {
      const cur = this.sel.cursor
      const cell = this.cellEl(cur.row, cur.col)
      if (!cell) return false
      this.editCanvas(cur.row, cur.col, cell)
      return true
    }
    // F2 on the appender means the same as typing on it — see `typeInto`.
    if (!this.materialiseCursorRow()) return false
    const vis = cols(this.sheet)
    const col = vis[this.sel.cursor.col]
    const rid = ridAt(this.store, this.sheet, this.sel.cursor.row)
    const cell = this.cellEl(this.sel.cursor.row, this.sel.cursor.col)
    if (!col || rid < 0 || !cell) return false
    this.edit(rid, col.id, cell)
    return true
  }
}

/**
 * What the user typed, under the column's declared type.
 *
 * EXPORTED for find.ts's Replace, which is the same question asked by a
 * different door: a replacement lands in a cell exactly as a typed value does,
 * and a second copy of this coercion is a second set of rules for what "1,200"
 * means in a money column.
 */
export function coerceForColumn(text: string, type: ColumnType): unknown {
  const s = text.trim()
  if (s === '') return null
  if (type === 'number' || type === 'money' || type === 'percent') {
    const n = Number(s.replace(/[,\s£$€¥%]/g, ''))
    if (!Number.isFinite(n)) return s        // keep what they typed rather than
    return type === 'percent' && s.includes('%') ? n / 100 : n  // silently zeroing
  }
  if (type === 'bool') return /^(y|yes|true|1|✓)$/i.test(s)
  return s
}

/** Where a data bar starts, as a percentage — negatives run left of the axis. */
const bar0 = (cf: CellStyle): number =>
  cf.bar ? (cf.bar.negative ? Math.max(0, (cf.bar as { axis?: number }).axis ?? 0) - cf.bar.pct : (cf.bar as { axis?: number }).axis ?? 0) : 0

const fmtNum = (n: number): string =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n)

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
