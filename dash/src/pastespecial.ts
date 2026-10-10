// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// PASTE SPECIAL — values only, formulas, formats only, transpose.
//
// Nothing here touches the DOM, and nothing here imports grid.ts. The grid and
// main.ts hand in what a cell HOLDS and where it is going; this decides what is
// written. That is what makes every rule below provable in node, which matters
// because a paste is a bulk overwrite: it is the one gesture where getting the
// answer wrong destroys a screenful of somebody's work in one keystroke, with
// no evidence left of what was there.
//
// ═══ THE RULE THIS FILE EXISTS TO HOLD ════════════════════════════════════
//
//   VALUES ONLY LANDS A VALUE. NOT A FORMULA, AND NEVER AN ERROR OBJECT.
//
// There is prior art in this codebase for getting exactly that wrong. Fill
// seeded from the COMPUTED value, so a filled formula came out as the constant
// it happened to evaluate to and a FAILED one came out as the error OBJECT,
// written into a typed column as though somebody had typed `{code:'#VALUE!'}`
// into it (scripts/test-dash-fill.ts records the measurement). Paste special
// walks the same ground from the other side: values-only DOES want the computed
// number — that is the whole command — so the fill fix ("read the source, never
// the result") is not the answer here. The answer is the second half of the
// same lesson: an error is not a value, so a cell whose formula failed pastes
// as BLANK and is COUNTED, and `plan.dropped` is what the caller reports.
// `refusesValue` is the one gate, and it refuses anything that is not a
// primitive — an error object, a Date, a stray `{}` — because a typed column
// can hold none of them.
//
// ═══ FOUR MODES, AND WHAT EACH ONE MAY TOUCH ══════════════════════════════
//
//   'all'      — what ⌘V already does; here so that transpose can compose.
//   'values'   — the computed value, and nothing else. Formulas are DISCARDED
//                (that is the command: "strip the formulas, keep the numbers",
//                the most-used clipboard verb in finance).
//   'formulas' — the formula SOURCE, with relative references translated by how
//                far the cell moved and `$A$1` left alone. A constant cell
//                pastes as its constant, which is what Excel does: a block of
//                formulas usually has literal inputs in it and dropping them
//                would paste a formula pointing at nothing.
//   'formats'  — appearance and NOTHING else. `looksOnly` says so on every
//                planned cell, and the writers honour it: a formats paste over
//                a column of totals must not change a number by one digit.
//
// APPEARANCE IS `APPEARANCE_FIELDS` AND ONLY THAT. model.ts owns the one
// runtime list (cellfmt.ts re-exports it, sync/crdt.ts reads it); a second list
// here is how "format" comes to mean two different things in two files, and
// how `v` eventually leaks through a formats-only paste. `pickLook` filters
// through the list rather than spreading an object, which is `appearancePatch`'s
// own discipline.
//
// ═══ TRANSPOSE ON A DATASET IS REFUSED, AND HERE IS WHY ═══════════════════
//
// A spreadsheet (`kind:'canvas'`) is typed by the CELL, so transposing it is a
// pure rearrangement: every cell carries its own type and lands intact. A
// dataset (`kind:'table'`) is typed by the COLUMN — that is the whole reason
// the kind exists (docs/dash-sheet-kinds.md) and it is what earns the column
// formula, the chart binding, the pivot, and the refusal to guess on import.
// Transposing a row of (text, money, date) makes ONE column that must have ONE
// type, so the operation can only complete by coercing all of it to text.
//
// The two ways to "allow" it are both worse than refusing:
//
//   * coerce silently to text — destroys the types that make the sheet a
//     dataset, on a keystroke, with no dialog;
//   * transpose into a NEW sheet — a different command wearing paste's name.
//
// And the dataset already HAS a reshape, which is the honest thing to point at:
// `unpivot` (columns → rows) and `pivot` (rows → columns) are declared in the
// step vocabulary and are what "transpose" means for a table. So the refusal
// names them. Refusing with a reason is the house behaviour (import.ts's
// date-order ambiguity, steps.ts's join fanout); allowing it with a conversion
// is the behaviour those two exist to argue against.

import { formatRef } from './a1.ts'
import { translateCellFormula } from './cellformula.ts'
import { coerce } from './import.ts'
import { APPEARANCE_FIELDS, type AppearanceField } from './model.ts'
import type { CanvasCell, CellOverride, ColumnType } from './model.ts'
import type { Patch } from './store.ts'

// --- what a clip holds ---------------------------------------------------------

/** Appearance, and nothing else — structurally a subset of both cell shapes. */
export type Look = Partial<Record<AppearanceField, unknown>>

/**
 * One copied cell.
 *
 * `v` is the value the cell SHOWED — a formula's result, an override's
 * correction, or the stored value — because that is what "values only" means.
 * `f` is the source beside it, kept separately so no mode has to reconstruct
 * one from the other. `r`/`c` are the CANONICAL position it came from, not the
 * visible one: A1 addresses name the document, so a block copied while a sort
 * is on has to translate by the distance the cells actually moved.
 */
export interface ClipCell {
  v?: unknown
  f?: string
  look?: Look
  r: number
  c: number
}

export interface Clip {
  kind: 'table' | 'canvas'
  rows: ClipCell[][]
  /** a CUT: a moved formula still means what it did, so it does not translate */
  cut?: boolean
}

export type PasteWhat = 'all' | 'values' | 'formulas' | 'formats'

export interface PasteSpecialOpts {
  what: PasteWhat
  transpose?: boolean
}

// --- the gate ------------------------------------------------------------------

/**
 * Is this something a cell may STORE?
 *
 * Only primitives. An error is an object (`FormulaError`), and so is a Date, a
 * `{}` from a mangled paste, and an array. The fill rig records what happens
 * when one gets through: `#VALUE!` sitting in a money column as though a person
 * typed it. This is the same gate stated positively, and it is deliberately a
 * whitelist — a blacklist of "not an error" would have let the Date through.
 */
export const refusesValue = (v: unknown): boolean => {
  if (v === null || v === undefined) return false
  const t = typeof v
  return !(t === 'number' || t === 'string' || t === 'boolean')
}

/** Appearance, filtered through the ONE runtime list. Never a spread. */
export function pickLook(cell: Record<string, unknown> | undefined | null): Look | undefined {
  if (!cell) return undefined
  let out: Look | undefined
  for (const k of APPEARANCE_FIELDS) {
    const v = cell[k]
    if (v === undefined) continue
    ;(out ??= {})[k] = v
  }
  return out
}

// --- the plan ------------------------------------------------------------------

export interface PlannedCell {
  /** destination, as an offset from the paste anchor */
  dr: number
  dc: number
  /** canonical source position — the writer translates a formula by dest − src */
  sr: number
  sc: number
  v?: unknown
  f?: string
  look?: Look
  /** write the appearance and LEAVE the value and formula exactly as they are */
  looksOnly?: boolean
}

export interface PastePlan {
  cells: PlannedCell[]
  rows: number
  cols: number
  /**
   * The clip was CUT. A copied formula makes a second formula that should mean
   * the same thing in its new place, so its references move; a cut moves the
   * ONE formula, and a formula that travelled with its cells still means
   * exactly what it did. Excel agrees, and getting this backwards silently
   * re-points a moved formula at the wrong data.
   */
  cut?: boolean
  /** values refused by `refusesValue` — pasted blank, and reported */
  dropped: number
  /** set when the plan is empty because the operation is not meaningful here */
  refusal?: PasteRefusal
}

/**
 * Reshape and filter a clip into what will actually be written.
 *
 * TRANSPOSE IS APPLIED TO THE DESTINATION AND NOT TO THE SOURCE COORDINATES.
 * Each planned cell keeps the canonical position it was copied FROM, so a
 * formula is translated by how far that particular cell moved. A block shift
 * would be wrong the moment the block is transposed — every cell moves by a
 * different amount — and per-cell offsets are right in both cases, so there is
 * one rule instead of two.
 */
export function planPasteSpecial(
  clip: Clip, opts: PasteSpecialOpts,
): PastePlan {
  const what = opts.what
  const transpose = opts.transpose === true
  if (transpose && clip.kind === 'table') {
    return {
      cells: [], rows: 0, cols: 0, dropped: 0,
      refusal: 'transpose-typed-columns' as PasteRefusal,
    }
  }
  const src = clip.rows
  const h = src.length
  const w = src.reduce((m, r) => Math.max(m, r.length), 0)
  const cells: PlannedCell[] = []
  let dropped = 0
  for (let i = 0; i < h; i++) {
    for (let j = 0; j < w; j++) {
      const cell = src[i]?.[j]
      if (!cell) continue
      const dr = transpose ? j : i
      const dc = transpose ? i : j
      const at: PlannedCell = { dr, dc, sr: cell.r, sc: cell.c }
      if (what === 'formats') {
        at.looksOnly = true
        at.look = cell.look
        cells.push(at)
        continue
      }
      if (what === 'all') at.look = cell.look
      const wantsFormula = (what === 'formulas' || what === 'all') && cell.f !== undefined
      if (wantsFormula) {
        at.f = cell.f
      } else {
        // values-only, or a constant inside a formulas paste
        const v = cell.v
        if (refusesValue(v)) { dropped++; at.v = null } else at.v = v ?? null
      }
      cells.push(at)
    }
  }
  return {
    cells, rows: transpose ? w : h, cols: transpose ? h : w, dropped,
    ...(clip.cut ? { cut: true } : {}),
  }
}

/**
 * Why an option is not available, as a CODE rather than a sentence.
 *
 * The English lives at the call site in main.ts, as a literal inside `t()`.
 * That is not squeamishness about strings in a pure module: the i18n sweep
 * reads t() ARGUMENTS out of the source, so a sentence reached through a
 * variable is one the extractor cannot see and one that would ship
 * untranslated in all seven locales (scripts/test-dash-i18n.ts, failure mode
 * 3). A code also makes the rig's assertion exact — it can check WHICH refusal
 * without matching prose.
 */
export type PasteRefusal = 'transpose-typed-columns'

// --- the menu ------------------------------------------------------------------

export interface PasteSpecialItem {
  id: 'values' | 'formulas' | 'formats' | 'transpose' | 'values-transpose'
  what: PasteWhat
  transpose: boolean
  /** false on this kind of sheet — shown greyed, with `why` said out loud */
  enabled: boolean
  why?: PasteRefusal
}

/**
 * The menu, decided here rather than in the markup, so that "is transpose
 * available" has ONE answer and the rig can read it. A greyed item with a
 * reason teaches; a missing item leaves the reader looking for it.
 */
export function pasteSpecialItems(kind: 'table' | 'canvas'): PasteSpecialItem[] {
  const canTranspose = kind === 'canvas'
  const why: PasteRefusal | undefined = canTranspose ? undefined : 'transpose-typed-columns'
  return [
    { id: 'values', what: 'values', transpose: false, enabled: true },
    { id: 'formulas', what: 'formulas', transpose: false, enabled: true },
    { id: 'formats', what: 'formats', transpose: false, enabled: true },
    { id: 'transpose', what: 'all', transpose: true, enabled: canTranspose, why },
    { id: 'values-transpose', what: 'values', transpose: true, enabled: canTranspose, why },
  ]
}

// --- writing: the spreadsheet kind ---------------------------------------------

export interface CanvasTarget {
  sheetId: string
  cellAt(row: number, col: number): CanvasCell | undefined
  maxRows: number
  maxCols: number
}

/**
 * A plan into `setCanvasCells` — ONE patch, so it is ONE undo step however many
 * cells it covers.
 *
 * A formats-only write REBUILDS the cell from what is there: the existing `v`
 * and `f` are carried across untouched and only the appearance keys change.
 * Spreading the clip's cell over the target instead is how a "formats" paste
 * quietly replaces a number.
 */
export function canvasPastePatches(
  target: CanvasTarget, row: number, col: number, plan: PastePlan,
): Patch[] {
  const cells: Record<string, CanvasCell | null> = {}
  for (const p of plan.cells) {
    const r = row + p.dr
    const c = col + p.dc
    if (r < 0 || c < 0 || r >= target.maxRows || c >= target.maxCols) continue
    const key = formatRef({ row: r, col: c, absRow: false, absCol: false })
    const had = target.cellAt(r, c)
    if (p.looksOnly) {
      if (!p.look) continue
      const next = { ...(had ?? {}), ...p.look } as CanvasCell
      cells[key] = next
      continue
    }
    // Keep everything that is NOT value, formula or appearance — a note, a
    // number format someone set. A paste replaces content, not annotation.
    const { v: _v, f: _f, ...rest } = (had ?? {}) as Record<string, unknown>
    for (const k of APPEARANCE_FIELDS) delete rest[k]
    const look = p.look ?? pickLook(had as Record<string, unknown> | undefined)
    if (p.f !== undefined) {
      const dRow = plan.cut ? 0 : r - p.sr
      const dCol = plan.cut ? 0 : c - p.sc
      cells[key] = { ...rest, ...(look ?? {}), f: translateCellFormula(p.f, dRow, dCol) } as CanvasCell
    } else {
      const blank = p.v == null || p.v === ''
      const body = blank ? {} : { v: p.v }
      const next = { ...rest, ...(look ?? {}), ...body } as CanvasCell
      cells[key] = Object.keys(next).length ? next : null
      if (cells[key] === null && had === undefined) delete cells[key]
    }
  }
  return Object.keys(cells).length
    ? [{ op: 'setCanvasCells', sheet: target.sheetId, cells }]
    : []
}

// --- writing: the dataset kind ---------------------------------------------------

export interface TargetColumn {
  id: string
  type: ColumnType
  /** a COMPUTED column is its expression; a paste must not write into one */
  formula?: string
  parsed?: string
  /** canonical index in `sheet.columns`, for translating a formula sideways */
  index: number
}

export interface TableTarget {
  sheetId: string
  /** visible column offset from the anchor → the column there, or null */
  colAt(dc: number): TargetColumn | null
  /** visible row offset from the anchor → the rid there, or −1 past the end */
  ridAt(dr: number): number
  /** rid → canonical data row, for translating a formula downward */
  rowOf(rid: number): number
  overrideAt(key: string): CellOverride | undefined
}

/**
 * A plan into a dataset: `setCells` for values, `setOverrides` for formulas and
 * appearance, all in ONE commit so one ⌘Z puts back the whole paste.
 *
 * TWO REFUSALS ARE BUILT IN, and both are the dataset kind showing through:
 *
 *   * a COMPUTED column is skipped, because it is defined by its expression and
 *     a pasted constant underneath it would be a number the file's own formula
 *     disagrees with (the same guard `writeBlock` and `fillVertical` make);
 *   * a value is COERCED THROUGH import.ts to the target column's type, using
 *     the convention that column was read with. Writing the clipboard's string
 *     straight into a money column is how "1.234" ends up meaning two different
 *     numbers in one column.
 */
export interface TableWrite {
  patches: Patch[]
  /**
   * Cells that had nowhere to land: past the last row of the dataset, or in a
   * COMPUTED column. A dataset has exactly the rows it has, so a paste can run
   * off the end — and a paste that silently does less than it was asked is an
   * edit the user believes happened. The caller reports this.
   */
  skipped: number
}

export function tablePastePatches(
  target: TableTarget, plan: PastePlan,
): TableWrite {
  const byCol = new Map<string, { rids: number[]; v: unknown[] }>()
  const keys: string[] = []
  const overs: Array<Record<string, unknown> | null> = []
  let skipped = 0
  for (const p of plan.cells) {
    const col = target.colAt(p.dc)
    if (!col || col.formula) { skipped++; continue }
    const rid = target.ridAt(p.dr)
    if (rid < 0) { skipped++; continue }
    const key = `${col.id}:${rid}`
    const had = target.overrideAt(key)
    if (p.looksOnly) {
      if (!p.look) continue
      keys.push(key)
      overs.push({ ...(had ?? {}), ...p.look })
      continue
    }
    if (p.f !== undefined) {
      const dRow = plan.cut ? 0 : target.rowOf(rid) - p.sr
      const dCol = plan.cut ? 0 : col.index - p.sc
      keys.push(key)
      overs.push({ ...(had ?? {}), ...(p.look ?? {}), f: translateCellFormula(p.f, dRow, dCol) })
      continue
    }
    const e = byCol.get(col.id) ?? { rids: [], v: [] }
    e.rids.push(rid)
    e.v.push(coerceInto(p.v, col))
    byCol.set(col.id, e)
    // A pasted VALUE over a formula cell has to remove the formula, or the
    // formula simply recomputes and the paste appears to have done nothing.
    if (had?.f !== undefined || p.look) {
      const { f: _f, ...rest } = (had ?? {}) as Record<string, unknown>
      const next = { ...rest, ...(p.look ?? {}) }
      keys.push(key)
      overs.push(Object.keys(next).length ? next : null)
    }
  }
  const patches: Patch[] = []
  for (const [col, e] of byCol) {
    patches.push({ op: 'setCells', sheet: target.sheetId, col, rids: e.rids, v: e.v })
  }
  if (keys.length) {
    patches.push({
      op: 'setOverrides', sheet: target.sheetId, keys, v: overs as never, dropEmpty: true,
    })
  }
  return { patches, skipped }
}

/**
 * One value into what the target column can hold.
 *
 * import.ts's `coerce` and not a second reader: the convention a column was
 * imported with is recorded on it (`parsed`), and reading "1.234" without it is
 * the decimal-comma mistake import.ts's header opens with. A value that is
 * already the right primitive is passed through untouched — coercing a number
 * by way of its own string is a round trip that can lose a digit.
 */
function coerceInto(v: unknown, col: TargetColumn): unknown {
  if (v == null || v === '') return null
  if (refusesValue(v)) return null
  const t = col.type
  if (t === 'text' || t === 'enum') return typeof v === 'string' ? v : String(v)
  if (typeof v === 'number' && (t === 'number' || t === 'money' || t === 'percent')) return v
  if (typeof v === 'boolean' && t === 'bool') return v
  return coerce(String(v), { type: t, ...(col.parsed ? { parsed: col.parsed } : {}), failed: 0 })
}
