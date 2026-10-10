// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bridge between the two kinds of sheet — a range of a spreadsheet becomes
// a dataset, and a dataset becomes a flat spreadsheet copy.
//
// docs/dash-sheet-kinds.md calls this "the actual product", and the reason is
// in the two sentences either side of it: a spreadsheet with no way OUT is a
// dead end (no chart, no pivot, no filter, no SQL — all of those bind typed
// COLUMNS, and a spreadsheet types each cell on its own), and a dataset with no
// way out is the reason people abandon BI tools for Excel the first time they
// need one weird number in the corner.
//
// FOUR DECISIONS ARE MADE HERE AND EACH IS A JUDGEMENT, so each one says why.
//
// 1. INFERENCE IS import.ts's, NOT A SECOND COPY. `inferColumn` decides per
//    COLUMN from the whole column, reports what would not coerce, and REFUSES
//    to decide a day/month order the data cannot settle. Writing a second
//    inference for this path would mean the same CSV typed differently
//    depending on which door it came through — and only one of the two would
//    have the refusal, which is the part that matters.
//
//    The one thing that is NOT routed through it: a column whose values are
//    ALREADY typed. A spreadsheet cell holds a real JS number or boolean, and
//    stringifying `1e21` to run a string inference over it would read as text.
//    That is not a second inference, it is the absence of a question.
//
// 2. PROMOTION COPIES; IT DOES NOT CONSUME THE RANGE. The tempting alternative
//    is to move the cells out, so there is only ever one copy. It is wrong
//    here, and destructively so: a spreadsheet's own formulas point INTO the
//    range by position — `=SUM(D4:D6)` under the block is the idiom the kind
//    exists for — and so do other sheets' `Invoice!D4` references. Emptying the
//    cells turns every one of them into a blank or a `#REF!`, which is a wrong
//    number that looks like a right one, silently, on a sheet nobody was
//    looking at. Nothing in the format can rewrite a reference ACROSS kinds.
//    So a promotion is a derivation, like a pivot or a chart: it names its
//    source in `steps[0]`, and the drift is stated rather than hidden. The
//    reverse direction is a copy for the same reason, and says so in its name.
//
// 3. A CELL FORMULA IS CARRIED, TRANSLATED, OR DROPPED — never silently kept
//    pointing somewhere else. A dataset addresses per-cell formulas by POSITION
//    too (`cellformula.tableCellSource`: column index by order, row index by
//    row), so a formula inside the range is the same expression against a
//    different origin, and rebasing it is arithmetic. Three outcomes, in order:
//      a. every body cell of the column carries the same formula modulo its own
//         row, and every reference in it is a same-row cell inside the range →
//         it LIFTS to one column expression (`Column.formula`), which is the
//         whole structural win of the dataset kind: one node in the graph
//         instead of one per row.
//      b. otherwise it stays per-cell, in `CellOverride.f`, rebased.
//      c. a reference that leaves the range has no home in the new sheet. The
//         VALUE is kept and the formula is dropped, with a finding naming the
//         cell — the spreadsheet still has the original, because of decision 2.
//    Refusing the whole promotion (the third option) was rejected: the person
//    with a rate cell above their block would never get past it, and they came
//    here to chart the block.
//
// 4. THE HEADER ROW IS DETECTED AND THE DETECTION IS SHOWN, never assumed. A
//    row of text over columns that are not text is a header; anything else is
//    data until someone says otherwise. `detectHeader` returns its reasoning so
//    the caller can put the answer in front of the reader with a way to say no.
//
// Nothing here touches the DOM — the same discipline import.ts keeps, and for
// the same reason: this is where the refusals live, so this is what a rig has
// to be able to run (`scripts/test-dash-promote.ts`).

import {
  formatRef, formatRange, mapRefs, parseRef, qualify, REF_ERR,
  type CellRef, type RefUnit,
} from './a1.ts'
import {
  canvasCellSource, cellKey, formulaBody, isFormula, recalcCells,
} from './cellformula.ts'
import { isErr } from './formula.ts'
import { coerce, encodeColumn, inferColumn, type Inference } from './import.ts'
import { readCell } from './store.ts'
import type {
  CanvasCell, CanvasSheet, CellOverride, Column, ColumnData, TableSheet,
} from './model.ts'

// --- shared shapes ------------------------------------------------------------

/** A rectangle of a spreadsheet, in 0-based positions, inclusive both ends. */
export interface CellBox { top: number; left: number; bottom: number; right: number }

/**
 * One thing the conversion decided on the reader's behalf.
 *
 * The same contract `ImportFinding` keeps: a code a caller can branch on and a
 * SENTENCE, because the reader is the audience. Never localised here — this
 * module runs in node, and import.ts's findings are English strings for exactly
 * the same reason.
 */
export interface PromoteFinding {
  /**
   * `suspicious` is validate.ts's and steps.ts's word for "it ran, and
   * something about it deserves a reader's attention", and it is the right one
   * for every decision here that could be WRONG about the reader's data: a
   * guessed header row, a value that would not coerce, a formula that had to be
   * dropped. `note` is the other kind — true, worth saying once, and impossible
   * to be wrong about ("the range is still on the spreadsheet"). There is no
   * `fatal`: a refusal is not a finding, it is `{ok: false, message}`, because a
   * finding is something the caller SHOWS and a refusal is something it must
   * not paper over by adding a sheet anyway.
   */
  severity: 'suspicious' | 'note'
  code:
    | 'blank-trimmed' | 'header-guessed' | 'duplicate-header' | 'empty-header'
    | 'empty-column' | 'blank-rows' | 'date-ambiguous' | 'coerce-failed'
    | 'formula-lifted' | 'formula-per-cell' | 'formula-dropped' | 'formula-error'
    | 'copy-not-move' | 'column-formula-flattened' | 'overrides-flattened'
  column?: string
  message: string
}

const blank = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

/** `A3:E12` — how a range is named to a reader, through the one minter of addresses. */
export const describeBox = (b: CellBox): string => formatRange({
  from: { row: b.top, col: b.left, absRow: false, absCol: false },
  to: { row: b.bottom, col: b.right, absRow: false, absCol: false },
})

const addr = (row: number, col: number): string =>
  formatRef({ row, col, absRow: false, absCol: false })

/**
 * A column id nothing else in the sheet has taken.
 *
 * Ids are what `data`, `cells` and `totals` are keyed by (model.ts), so a
 * collision does not rename a column, it makes two columns share one set of
 * values. Same slug shape import.ts uses, so a CSV and a promoted range that
 * carry the same headers produce the same ids and a later union lines up.
 */
function mintColId(name: string, i: number, taken: Set<string>): string {
  const base = (name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || `col-${i + 1}`).slice(0, 40)
  if (!taken.has(base)) { taken.add(base); return base }
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`
    if (!taken.has(id)) { taken.add(id); return id }
  }
}

// --- reading a spreadsheet range ----------------------------------------------

/**
 * What a cell SHOWS: a formula's result where it has one, the stored value
 * otherwise.
 *
 * The distinction is the whole reason `computed` is a parameter. A formula cell
 * stores no value (`canvasCellSource` says so, and reading a stale `v` back is
 * the cache-that-looks-authoritative failure), so promoting the stored side of
 * a column of formulas would produce a dataset of nulls that validates
 * perfectly.
 */
export interface CanvasView {
  cells: Record<string, CanvasCell>
  /** keyed by `cellformula.cellKey(row, col)`; absent = compute one sheet's own */
  computed?: ReadonlyMap<string, unknown>
}

/**
 * The computed map for a lone sheet.
 *
 * Callers with a whole workbook should pass `recalcWorkbook`'s answer instead —
 * `Sheet1!A1` is a reference like any other and this cannot see the other
 * sheets. Convenience for the rig and for a caller that has only the sheet.
 */
export const computeCanvas = (
  cells: Record<string, CanvasCell>, now?: string,
): ReadonlyMap<string, unknown> => recalcCells(canvasCellSource({ cells }), now).values

const cellOf = (v: CanvasView, row: number, col: number): CanvasCell | undefined =>
  v.cells[addr(row, col)]

/** The displayed value at a position — an error stays an error, and is refused later. */
function shownAt(v: CanvasView, row: number, col: number): unknown {
  const cell = cellOf(v, row, col)
  if (!cell) return null
  if (cell.f !== undefined) {
    const got = v.computed?.get(cellKey(row, col))
    return got === undefined ? null : got
  }
  return 'v' in cell ? cell.v : null
}

/**
 * Shrink a box to the cells that hold something.
 *
 * A selection is a drag, and a drag overshoots: two blank rows under the block
 * and one blank column beside it are not two rows of data and a column with no
 * name. Only the EDGES are trimmed — a blank row in the MIDDLE is kept, because
 * a dataset has exactly the rows there are and a reader who counted twelve rows
 * must still count twelve.
 */
export function trimBox(v: CanvasView, box: CellBox): CellBox | null {
  let { top, left, bottom, right } = box
  const rowEmpty = (r: number): boolean => {
    for (let c = left; c <= right; c++) if (!blank(shownAt(v, r, c))) return false
    return true
  }
  const colEmpty = (c: number): boolean => {
    for (let r = top; r <= bottom; r++) if (!blank(shownAt(v, r, c))) return false
    return true
  }
  while (top <= bottom && rowEmpty(top)) top++
  while (bottom >= top && rowEmpty(bottom)) bottom--
  if (top > bottom) return null
  while (left <= right && colEmpty(left)) left++
  while (right >= left && colEmpty(right)) right--
  if (left > right) return null
  return { top, left, bottom, right }
}

/**
 * The block of cells a single click is standing in — Excel's "current region",
 * and for Excel's reason.
 *
 * NOBODY DRAGS OVER FOUR HUNDRED ROWS. The gesture people actually make is to
 * click inside a table and ask for the table, so a one-cell selection that
 * promoted a one-cell dataset would be a correct answer to a question nobody
 * asked. This grows the box while the ring of cells immediately outside it
 * holds anything, which is the same rule ⌘/ctrl+A follows in every spreadsheet
 * ever shipped: a blank row or column is the edge of a block, and two blocks
 * with a gap between them stay two blocks.
 *
 * A RANGE THE READER DREW IS NEVER SECOND-GUESSED — the caller only asks this
 * when the selection is one cell. And a click on an empty cell gets that empty
 * cell back, which `promoteRange` then refuses by name.
 *
 * Bounded by the sheet's own keys, so this cannot walk out across the
 * unbounded frontier the spreadsheet kind rules past its data.
 */
export function currentRegion(v: CanvasView, at: { row: number; col: number }): CellBox {
  let maxRow = 0
  let maxCol = 0
  for (const k in v.cells) {
    const p = parseRef(k)
    if (!p) continue
    if (p.row > maxRow) maxRow = p.row
    if (p.col > maxCol) maxCol = p.col
  }
  const box: CellBox = { top: at.row, left: at.col, bottom: at.row, right: at.col }
  if (blank(shownAt(v, at.row, at.col))) return box
  const rowHas = (r: number, from: number, to: number): boolean => {
    for (let c = from; c <= to; c++) if (!blank(shownAt(v, r, c))) return true
    return false
  }
  const colHas = (c: number, from: number, to: number): boolean => {
    for (let r = from; r <= to; r++) if (!blank(shownAt(v, r, c))) return true
    return false
  }
  for (let grew = true; grew;) {
    grew = false
    // The ring is tested against the CURRENT box each time, so a block that
    // widens as it goes down (a header narrower than its body) is still one
    // block: growing down exposes new columns to the sideways test.
    if (box.top > 0 && rowHas(box.top - 1, box.left, box.right)) { box.top--; grew = true }
    if (box.bottom < maxRow && rowHas(box.bottom + 1, box.left, box.right)) { box.bottom++; grew = true }
    if (box.left > 0 && colHas(box.left - 1, box.top, box.bottom)) { box.left--; grew = true }
    if (box.right < maxCol && colHas(box.right + 1, box.top, box.bottom)) { box.right++; grew = true }
  }
  return box
}

// --- the header question ------------------------------------------------------

export interface HeaderGuess {
  header: boolean
  /** the sentence shown beside the checkbox, so the guess can be argued with */
  why: string
}

/**
 * Is the first row of this box a header?
 *
 * THE ONE RULE THAT IS SAFE: a header is text over columns that are NOT text.
 * `Region | Q1 | Q2` above `North | 12 | 40` is unmistakable — every cell of
 * row one is a word and the columns beneath at least one of them are numbers,
 * dates or booleans. A block that is text all the way down cannot be told
 * apart from a header by any rule, and guessing there is how a row of data
 * becomes a set of column names nobody typed.
 *
 * So: yes only when something CHANGES between the first row and the rest. A
 * single-row box is data (there is nothing under it to be the header OF).
 */
export function detectHeader(v: CanvasView, box: CellBox): HeaderGuess {
  const rows = box.bottom - box.top + 1
  if (rows < 2) {
    return { header: false, why: 'One row is data — a header needs something underneath it to name.' }
  }
  let textish = 0
  let changed = 0
  let cols = 0
  for (let c = box.left; c <= box.right; c++) {
    const head = shownAt(v, box.top, c)
    if (blank(head)) continue
    cols++
    if (typeof head !== 'string') continue
    textish++
    // the body of THIS column, as a type: a number/date/bool column under a
    // word is the signal, and it is per column so one stray text column does
    // not veto a header
    const body: unknown[] = []
    for (let r = box.top + 1; r <= box.bottom; r++) body.push(shownAt(v, r, c))
    const inf = inferValues(body)
    // `ambiguous` counts as a change, and finding that out cost a rig failure:
    // an undecidable date column imports as TEXT, so a body of `03/04/2026`
    // under the word `Paid` read as "text over text" and the header was eaten.
    // The column is not text, it is dates nobody can order — which is exactly
    // as different from a word as a number is.
    if (inf.type !== 'text' || inf.ambiguous) changed++
  }
  if (!cols) return { header: false, why: 'The first row of the selection is empty.' }
  if (textish === cols && changed > 0) {
    return {
      header: true,
      why: `The first row is text over ${changed} column(s) of numbers or dates, which is what a header looks like.`,
    }
  }
  return {
    header: false,
    why: textish === cols
      ? 'Every column is text all the way down, so nothing marks the first row out as a header. Tick the box if it is one.'
      : 'The first row holds values of the same kind as the rows below it, so it reads as data.',
  }
}

// --- inference ----------------------------------------------------------------

/**
 * One column's type, from its DISPLAYED values.
 *
 * Typed values short-circuit (see the header note); everything else is handed
 * to import.ts as text, which is the path that carries the decimal-comma
 * decision, the coercion count and the date refusal.
 */
export function inferValues(values: unknown[]): Inference {
  const present = values.filter((x) => !blank(x))
  if (!present.length) return { type: 'text', failed: 0 }
  if (present.every((x) => typeof x === 'number')) return { type: 'number', parsed: 'dot', failed: 0 }
  if (present.every((x) => typeof x === 'boolean')) return { type: 'bool', failed: 0 }
  return inferColumn(values.map(asText))
}

const asText = (v: unknown): string =>
  v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v)

/** The stored value for one cell, under the type the column settled on. */
function valueUnder(raw: unknown, inf: Inference): unknown {
  if (blank(raw)) return null
  // Already the right shape: a JS number under a numeric column is the number,
  // not the number's spelling read back through a locale.
  if (typeof raw === 'number') {
    return inf.type === 'text' ? String(raw) : Number.isFinite(raw) ? raw : null
  }
  if (typeof raw === 'boolean') return inf.type === 'bool' ? raw : String(raw)
  return coerce(String(raw), inf)
}

// --- formulas ------------------------------------------------------------------

/**
 * Rebase one cell formula from the spreadsheet's origin onto the dataset's.
 *
 * THE INSERT/DELETE RULE, NOT THE COPY RULE: the cells physically moved, so
 * every reference moves with them — `$` included. `$` means "do not renumber me
 * when I am COPIED", and nothing here is a copy of a formula, it is the same
 * formula looking at the same numbers from a new origin (a1.ts's header makes
 * this distinction and it is the one people get backwards).
 *
 * A reference naming ANOTHER SHEET is left exactly as it is: `Pipeline!D2`
 * resolves against that sheet's own grid and the promotion did not move it.
 *
 * Returns null when the formula cannot come along — a reference that leaves the
 * promoted box has no cell to point at in a sheet that does not contain it, and
 * silently re-pointing it at whatever now sits at those coordinates is the
 * wrong-number-wearing-a-right-number's-clothes failure this codebase names
 * everywhere else.
 */
export function rebaseFormula(src: string, box: CellBox, dRow: number, dCol: number): string | null {
  if (!isFormula(src)) return null
  let escaped = false
  const inside = (r: CellRef): boolean =>
    r.row >= box.top && r.row <= box.bottom && r.col >= box.left && r.col <= box.right
  const move = (r: CellRef): string => formatRef({
    row: r.row - dRow, col: r.col - dCol, absRow: false, absCol: false,
  })
  const out = mapRefs(formulaBody(src), (u: RefUnit) => {
    if (u.sheet !== undefined) {
      // another sheet: untouched, and re-qualified exactly as it was written
      return qualify(u.sheet, u.to
        ? `${formatRef(u.from)}:${formatRef(u.to)}`
        : formatRef(u.from))
    }
    if (!inside(u.from) || (u.to && !inside(u.to))) { escaped = true; return REF_ERR }
    return u.to ? `${move(u.from)}:${move(u.to)}` : move(u.from)
  })
  return escaped || out.includes(REF_ERR) ? null : `=${out}`
}

/**
 * Can this column's per-cell formulas become ONE column expression?
 *
 * The fill-down idiom — `=B4*C4`, `=B5*C5`, … — is a column formula that a
 * spreadsheet had no way to say. Lifting it is the single largest thing
 * promotion can hand back, because a column expression is one node in the
 * dependency graph rather than one per row, and it keeps working when rows are
 * added.
 *
 * The conditions are strict, and each one is a way to be wrong:
 *   · EVERY body cell has a formula. One constant among them means the author
 *     overrode a row deliberately, and a column expression would overwrite it.
 *   · They are row-translations of ONE formula. Compared as text after rebasing
 *     each to the first body row, so `=B4*C4` and `=B5*C5` are the same and
 *     `=B4*C4` and `=B5*C4` are not.
 *   · Every reference is a single cell on the formula's OWN row, inside the
 *     box. A range, an absolute row or a reference to another row is a
 *     statement about POSITIONS, and positions are what a column expression
 *     does not have.
 * Anything else stays per-cell, which is always available and never wrong.
 */
function liftable(
  sources: string[], box: CellBox, firstBodyRow: number, colOf: (col: number) => string | null,
): string | null {
  if (!sources.length) return null
  let lifted: string | null = null
  for (let i = 0; i < sources.length; i++) {
    const row = firstBodyRow + i
    let bad = false
    const expr = mapRefs(formulaBody(sources[i]), (u: RefUnit) => {
      if (u.sheet !== undefined || u.to) { bad = true; return REF_ERR }
      if (u.from.absRow || u.from.row !== row) { bad = true; return REF_ERR }
      if (u.from.col < box.left || u.from.col > box.right) { bad = true; return REF_ERR }
      const name = colOf(u.from.col)
      if (!name) { bad = true; return REF_ERR }
      return name
    })
    if (bad) return null
    if (lifted === null) lifted = expr
    else if (lifted !== expr) return null
  }
  return lifted
}

/** How a column formula must spell a name — `[Unit price]` when it is not a word. */
const nameInFormula = (name: string): string =>
  /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `[${name}]`

// --- promote: spreadsheet range → dataset -------------------------------------

export interface PromoteOptions {
  /** the id the new sheet takes — minted by the caller (`tabs.mintSheetId`) */
  sheetId: string
  name: string
  /** `'auto'` runs `detectHeader`; a boolean is the reader overruling it */
  header?: boolean | 'auto'
  /** the source sheet's display name, for the provenance record */
  from?: string
  /** ISO 8601. A parameter so the rig is deterministic. */
  at?: string
}

export type PromoteResult =
  | {
      ok: true
      sheet: TableSheet
      findings: PromoteFinding[]
      /** the box actually used, after the edges were trimmed */
      used: CellBox
      header: boolean
      /** what `detectHeader` said, whether or not it was overruled */
      guess: HeaderGuess
    }
  | { ok: false; message: string; findings: PromoteFinding[] }

/**
 * A range of a spreadsheet, as a dataset sheet.
 *
 * PURE: cells in, sheet out. The caller commits it (`setSheet`, one patch, one
 * undo step) and the spreadsheet is not touched — see decision 2 at the top.
 */
export function promoteRange(v: CanvasView, box: CellBox, opts: PromoteOptions): PromoteResult {
  const findings: PromoteFinding[] = []
  const asked = box
  const used = trimBox(v, box)
  if (!used) {
    return {
      ok: false,
      findings,
      message: `Every cell in ${describeBox(asked)} is empty, so there is nothing to make a dataset of.`,
    }
  }
  if (used.top !== asked.top || used.bottom !== asked.bottom
    || used.left !== asked.left || used.right !== asked.right) {
    findings.push({
      severity: 'suspicious',
      code: 'blank-trimmed',
      message: `The selection ${describeBox(asked)} had empty rows or columns around its edge; ${describeBox(used)} was used.`,
    })
  }

  const guess = detectHeader(v, used)
  const header = opts.header === undefined || opts.header === 'auto' ? guess.header : opts.header
  if (opts.header === undefined || opts.header === 'auto') {
    findings.push({
      severity: 'suspicious',
      code: 'header-guessed',
      message: header
        ? `Row ${used.top + 1} was read as the header row. ${guess.why}`
        : `No header row was read, so the columns are named after the letters they came from. ${guess.why}`,
    })
  }

  const firstBody = header ? used.top + 1 : used.top
  if (firstBody > used.bottom) {
    return {
      ok: false,
      findings,
      message: `${describeBox(used)} is one row, and it was read as a header — a dataset of no rows is not what anybody meant. Untick the header box to promote it as data.`,
    }
  }
  const rows = used.bottom - firstBody + 1
  const dRow = firstBody
  const dCol = used.left

  // Names first, and all of them, because lifting a formula needs to know what
  // to call the column a reference points at.
  const taken = new Set<string>()
  const names: string[] = []
  const ids: string[] = []
  for (let c = used.left; c <= used.right; c++) {
    const raw = header ? shownAt(v, used.top, c) : null
    const name = header && !blank(raw) ? String(raw).trim() : `Column ${colLetters(c)}`
    if (header && blank(raw)) {
      findings.push({
        severity: 'suspicious',
        code: 'empty-header',
        column: name,
        message: `Column ${colLetters(c)} has no name in the header row, so it is called "${name}".`,
      })
    }
    if (names.includes(name)) {
      findings.push({
        severity: 'suspicious',
        code: 'duplicate-header',
        column: name,
        message: `Two columns are called "${name}"; they are kept apart, and the second one's id is not the first one's.`,
      })
    }
    names.push(name)
    ids.push(mintColId(name, c - used.left, taken))
  }
  const colName = (c: number): string | null => {
    const i = c - used.left
    return i >= 0 && i < names.length ? nameInFormula(names[i]) : null
  }

  const columns: Column[] = []
  const data: Record<string, ColumnData> = {}
  const cells: Record<string, CellOverride> = {}
  let blankRows = 0
  for (let r = firstBody; r <= used.bottom; r++) {
    let empty = true
    for (let c = used.left; c <= used.right && empty; c++) if (!blank(shownAt(v, r, c))) empty = false
    if (empty) blankRows++
  }
  if (blankRows) {
    findings.push({
      severity: 'note',
      code: 'blank-rows',
      message: `${blankRows} row(s) inside the range are empty. They are kept — a dataset has exactly the rows there are, and dropping them would change what the numbers are divided by.`,
    })
  }

  for (let c = used.left; c <= used.right; c++) {
    const i = c - used.left
    const id = ids[i]
    const name = names[i]

    const shown: unknown[] = []
    const sources: Array<string | null> = []
    let errors = 0
    for (let r = firstBody; r <= used.bottom; r++) {
      const cell = cellOf(v, r, c)
      const raw = shownAt(v, r, c)
      // AN ERROR IS NOT A VALUE. `#DIV/0!` in a promoted cell becomes a blank
      // and is reported: storing the error's TEXT would type the column as text
      // and hide a broken formula inside a name; storing 0 would be a number
      // nobody computed.
      if (isErr(raw)) { errors++; shown.push(null) } else shown.push(raw)
      sources.push(cell && isFormula(cell.f) ? (cell.f as string) : null)
    }
    if (errors) {
      findings.push({
        severity: 'suspicious',
        code: 'formula-error',
        column: name,
        message: `${errors} cell(s) in "${name}" compute an error on the spreadsheet. They are blank in the dataset — the error is still on the sheet they came from.`,
      })
    }

    const inf = inferValues(shown)
    if (inf.ambiguous) {
      findings.push({
        severity: 'suspicious',
        code: 'date-ambiguous',
        column: name,
        message: `"${name}" looks like dates, but ${inf.ambiguous.detail}. It is a text column — set its type to choose.`,
      })
    }
    if (inf.failed) {
      findings.push({
        severity: 'suspicious',
        code: 'coerce-failed',
        column: name,
        message: `${inf.failed} value(s) in "${name}" could not be read as ${inf.type} and are blank; the originals are still on the spreadsheet.`,
      })
    }
    if (shown.every(blank)) {
      findings.push({
        severity: 'suspicious',
        code: 'empty-column',
        column: name,
        message: `"${name}" has no values under it. It is kept as an empty text column rather than dropped — a column somebody named is a column they meant.`,
      })
    }

    const allFormulas = sources.length > 0 && sources.every((s) => s !== null)
    const lift = allFormulas
      ? liftable(sources as string[], used, firstBody, colName)
      : null

    const column: Column = { id, name, type: inf.type }
    if (inf.parsed) column.parsed = inf.parsed
    if (inf.failed) column.failed = inf.failed
    // ONE format mask, only when the whole column agrees on one. A mask taken
    // from the first cell would print half a column in a currency nobody chose.
    const mask = uniformFormat(v, c, firstBody, used.bottom)
    if (mask) column.format = mask

    if (lift) {
      // NO LEADING `=`, AND THIS COST A BUILD TO FIND. A spreadsheet cell marks
      // a formula with `=` (`isFormula`), but a COLUMN expression is a bare
      // expression — formula.ts's `recalc` hands `column.formula` straight to
      // `evaluate`, which reads a leading `=` as a token it has no rule for and
      // returns `#VALUE!` down the whole column. Nothing refused it on the way:
      // validate.ts strips a `=` before checking, so the sheet validated, and
      // the rig asserted the formula's TEXT rather than its numbers. The rig
      // evaluates it now.
      column.formula = lift
      // NO `data` FOR A FORMULA COLUMN (store.ts, validate.ts `formula-column-data`):
      // stored values beside an expression are a second answer to one question.
      columns.push(column)
      findings.push({
        severity: 'note',
        code: 'formula-lifted',
        column: name,
        message: `Every cell of "${name}" held the same formula, so it became one column formula: ${column.formula}. Add a row and it computes.`,
      })
      continue
    }

    const values: unknown[] = []
    let perCell = 0
    let dropped = 0
    for (let k = 0; k < shown.length; k++) {
      const src = sources[k]
      if (src) {
        const moved = rebaseFormula(src, used, dRow, dCol)
        if (moved) {
          // The formula computes the value, so the column stores nothing here —
          // the same rule a formula COLUMN follows, one cell at a time.
          cells[`${id}:${k + 1}`] = { f: moved }
          values.push(null)
          perCell++
          continue
        }
        dropped++
      }
      values.push(valueUnder(shown[k], inf))
    }
    if (perCell) {
      findings.push({
        severity: 'note',
        code: 'formula-per-cell',
        column: name,
        message: `${perCell} cell(s) of "${name}" keep their own formula, because the column does not have one shape. They are per-cell formulas in the dataset, rewritten to its rows.`,
      })
    }
    if (dropped) {
      findings.push({
        severity: 'suspicious',
        code: 'formula-dropped',
        column: name,
        message: `${dropped} formula(s) in "${name}" refer to cells outside ${describeBox(used)}. The value each one computed was kept and the formula was not — the original is still on the spreadsheet.`,
      })
    }
    columns.push(column)
    data[id] = encodeColumn(values, inf.type)
  }

  findings.push({
    severity: 'note',
    code: 'copy-not-move',
    message: `${describeBox(used)} is unchanged on the spreadsheet. This dataset is a copy of it, taken now — formulas there that point into the range still work.`,
  })

  const sheet: TableSheet = {
    id: opts.sheetId,
    name: opts.name,
    kind: 'table',
    rids: rows ? [[1, rows]] : [],
    nextRid: rows + 1,
    columns,
    data,
    ...(Object.keys(cells).length ? { cells } : {}),
    // steps[0] is the provenance record and is never re-run (model.ts). "Where
    // did this come from?" has an answer even when the answer is another sheet
    // in the same file.
    steps: [{
      op: 'import',
      from: opts.from ? `${opts.from}!${describeBox(used)}` : describeBox(used),
      at: opts.at ?? '',
      rows,
      note: 'Promoted from a spreadsheet range. The range is still there; this is a copy of it.',
    }],
  }
  return { ok: true, sheet, findings, used, header, guess }
}

/** `A`, `B`, … `AA`. Through a1.ts, so there is one speller of a column letter. */
const colLetters = (c: number): string => {
  const ref = formatRef({ row: 0, col: c, absRow: false, absCol: false })
  return ref === REF_ERR ? '?' : ref.slice(0, -1)
}

/** The format mask every cell of the column agrees on, or none. */
function uniformFormat(v: CanvasView, col: number, top: number, bottom: number): string | undefined {
  let mask: string | undefined
  for (let r = top; r <= bottom; r++) {
    const cell = cellOf(v, r, col)
    const f = cell?.format
    if (blank(shownAt(v, r, col))) continue
    if (typeof f !== 'string' || !f) return undefined
    if (mask === undefined) mask = f
    else if (mask !== f) return undefined
  }
  return mask
}

// --- the other direction: dataset → spreadsheet copy --------------------------

export interface FlattenOptions {
  sheetId: string
  name: string
  /** formula.ts's `recalc` output for this sheet — a computed column has no
   *  stored values, so without it a calculated column flattens to blanks */
  computed?: ReadonlyMap<string, unknown[]>
  /** write the column names into row 1. Default true. */
  header?: boolean
}

export interface FlattenResult {
  sheet: CanvasSheet
  findings: PromoteFinding[]
}

/**
 * A dataset as a flat, cell-typed spreadsheet COPY.
 *
 * This is the half of the bridge that answers "I have a table but I need one
 * weird number in the corner" — the reason people leave a BI tool for Excel.
 * The copy is for the corner; the live thing stays the dataset, and every
 * finding here says so rather than leaving the reader to discover it.
 *
 * WHAT CANNOT COME ACROSS, stated instead of silently flattened:
 *   · a COLUMN formula. It names columns, and a spreadsheet has none — there is
 *     nothing to translate it into. The values it produced are written, and the
 *     expression is put in the header cell's note so the copy still says how
 *     the numbers were made.
 *   · steps, filters, sorts, totals, conditional formats and comments. They are
 *     all properties of a dataset's columns.
 * A PER-CELL formula does come across: both kinds address those by position, so
 * it is the same rebase promotion does, one row the other way.
 */
export function flattenToSpreadsheet(sheet: TableSheet, opts: FlattenOptions): FlattenResult {
  const findings: PromoteFinding[] = []
  const header = opts.header !== false
  const cells: Record<string, CanvasCell> = {}
  const cols: Record<string, number> = {}
  const rows = sheet.rids.reduce((n, [, c]) => n + c, 0)
  const rowOfRid = new Map<number, number>()
  {
    let i = 0
    for (const [start, count] of sheet.rids) {
      for (let k = 0; k < count; k++) rowOfRid.set(start + k, i++)
    }
  }
  const top = header ? 1 : 0

  sheet.columns.forEach((col, ci) => {
    if (header) {
      const cell: CanvasCell = { v: col.name, bold: true }
      // The one place a flattened column formula can still be read.
      if (typeof col.formula === 'string' && col.formula.trim()) {
        cell.note = `Computed by: ${col.formula}`
      }
      cells[addr(0, ci)] = cell
    }
    if (typeof col.w === 'number' && col.w > 0) cols[colLetters(ci)] = col.w
    const comp = opts.computed?.get(col.id)
    if (typeof col.formula === 'string' && col.formula.trim()) {
      findings.push({
        severity: 'suspicious',
        code: 'column-formula-flattened',
        column: col.name,
        message: `"${col.name}" is computed by ${col.formula}. A spreadsheet has no column formulas, so this copy holds the values it produced${comp ? '' : ' — and this build could not compute them, so they are blank'}. The expression is in the header cell's note.`,
      })
    }
    for (let r = 0; r < rows; r++) {
      const rid = ridAtRow(sheet, r)
      const over = sheet.cells?.[`${col.id}:${rid}`]
      const value = over && 'v' in over ? over.v
        : comp ? comp[r] ?? null
          : readCell(sheet.data[col.id], r)
      const cell: CanvasCell = {}
      if (over && isFormula(over.f)) {
        // one row down when there is a header, and the columns do not move
        const moved = rebaseFormula(over.f as string,
          { top: 0, left: 0, bottom: rows - 1, right: sheet.columns.length - 1 },
          -top, 0)
        if (moved) cell.f = moved
      }
      if (cell.f === undefined && !(value === null || value === undefined)) {
        cell.v = isErr(value) ? String(value) : value
      }
      if (col.format) cell.format = col.format
      for (const k of ['color', 'bg', 'bold', 'align', 'note'] as const) {
        const got = over?.[k]
        if (got !== undefined) (cell as Record<string, unknown>)[k] = got
      }
      if (Object.keys(cell).length) cells[addr(r + top, ci)] = cell
    }
  })

  const flattened = countFlattened(sheet)
  if (flattened.length) {
    findings.push({
      severity: 'suspicious',
      code: 'overrides-flattened',
      message: `${flattened.join(', ')} belong to the dataset and are not in this copy. The dataset still has them.`,
    })
  }
  findings.push({
    severity: 'note',
    code: 'copy-not-move',
    message: `This is a copy of "${sheet.name}" as it is now. Editing it does not change the dataset, and the dataset does not update it.`,
  })

  return {
    sheet: {
      id: opts.sheetId,
      name: opts.name,
      kind: 'canvas',
      cells,
      ...(Object.keys(cols).length ? { cols } : {}),
    },
    findings,
  }
}

/** Row index → rid, walking the runs rather than expanding them. */
function ridAtRow(sheet: TableSheet, row: number): number {
  let seen = 0
  for (const [start, count] of sheet.rids) {
    if (row < seen + count) return start + (row - seen)
    seen += count
  }
  return -1
}

/** What a reader would notice missing from the copy, named rather than dropped. */
function countFlattened(sheet: TableSheet): string[] {
  const out: string[] = []
  const steps = sheet.steps.filter((s) => s.op !== 'import' && s.op !== 'bind')
  if (steps.length) out.push(`${steps.length} transform step(s)`)
  if (sheet.totals && Object.keys(sheet.totals).length) out.push('the totals row')
  const cf = (sheet as { condfmt?: Record<string, unknown> }).condfmt
  if (cf && Object.keys(cf).length) out.push('conditional formats')
  if (sheet.comments?.length) out.push(`${sheet.comments.length} comment thread(s)`)
  return out
}

export const _internals = { mintColId, liftable, uniformFormat, asText, valueUnder }
