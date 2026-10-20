// Inserting and deleting rows and columns on a grid — Excel's most basic edit.
//
// docs/dash-unified.md. Until this existed nothing moved a grid cell at all
// (the sync engine's notes say so, and lean on it). Three things have to move
// TOGETHER, in one undo step, or the workbook is wrong in a way that looks
// right:
//
//   1. the cells, and the row heights / column widths, of the grid;
//   2. every formula and defined name in the WORKBOOK that points at the grid
//      (cellformula's `shiftSheetFormulas`, the same rewrite datasets use —
//      a reference into a deleted row becomes #REF!, never the row that slid
//      up into the gap);
//   3. the tables placed on it, which ride along like cells.
//
// An insert or delete that would cut THROUGH a table is refused with a reason:
// the table's own rows are added and removed from the table, so a sheet-wide
// cut cannot half-delete one.
//
// SYNC: `shiftCanvas` has no op of its own in the CRDT yet. It falls through the
// engine's default arm, which ships a whole-state snapshot — "slower and always
// correct", in the engine's own words. A real shift op is an engine change of
// its own (crdt.ts explains why cell moves cannot be minted as cell writes).

import { colToLetters, formatRef, lettersToCol } from './a1.ts'
import { shiftDefinedNames, shiftSheetFormulas } from './cellformula.ts'
import type { CanvasCell, CanvasSheet, CellOverride, DashDoc, TableSheet } from './model.ts'
import { contains, judgePlacements, tableRect, type Rect } from './placement.ts'
import type { Patch } from './store.ts'

export interface CanvasShift {
  op: 'shiftCanvas'
  sheet: string
  axis: 'row' | 'col'
  /** 0-based index of the first row/column inserted or removed */
  at: number
  /** positive inserts, negative deletes */
  count: number
  /** cells to put back after an insert — what undoing a delete carries */
  restore?: Record<string, CanvasCell>
  /** sizes to put back, keyed as `cols`/`rows` are */
  restoreSizes?: { cols?: Record<string, number>; rows?: Record<string, number> }
}

const key = (row: number, col: number): string => formatRef({ row, col, absRow: false, absCol: false })

/** Either key spelling the format allows — `B7` (canonical) or `1,6` (col,row). */
function posOf(k: string): { row: number; col: number } | null {
  const a1 = /^([A-Z]+)(\d+)$/.exec(k)
  if (a1) return { row: Number(a1[2]) - 1, col: lettersToCol(a1[1]) }
  const cr = /^(\d+),(\d+)$/.exec(k)
  if (cr) return { col: Number(cr[1]), row: Number(cr[2]) - 0 }
  return null
}

/** Apply a shift to one grid IN PLACE; returns the patch that undoes it. */
export function applyCanvasShift(sheet: CanvasSheet, p: CanvasShift): CanvasShift {
  const along = (pos: { row: number; col: number }) => (p.axis === 'row' ? pos.row : pos.col)
  const moved: Record<string, CanvasCell> = {}
  const removed: Record<string, CanvasCell> = {}
  const delFrom = p.at, delTo = p.at - p.count - 1 // inclusive, for count < 0
  for (const [k, cell] of Object.entries(sheet.cells)) {
    const pos = posOf(k)
    if (!pos) { moved[k] = cell; continue }
    const i = along(pos)
    if (p.count < 0 && i >= delFrom && i <= delTo) { removed[key(pos.row, pos.col)] = cell; continue }
    const shift = i >= p.at ? p.count : 0
    const next = p.axis === 'row' ? { row: pos.row + shift, col: pos.col } : { row: pos.row, col: pos.col + shift }
    moved[key(next.row, next.col)] = cell
  }
  for (const [k, cell] of Object.entries(p.restore ?? {})) moved[k] = cell
  sheet.cells = moved

  // Sizes: `cols` keyed by letters, `rows` by the 1-based row number.
  const sizes = p.axis === 'row' ? 'rows' : 'cols'
  const idx = (k: string) => (p.axis === 'row' ? Number(k) - 1 : lettersToCol(k))
  const name = (i: number) => (p.axis === 'row' ? String(i + 1) : colToLetters(i))
  const removedSizes: Record<string, number> = {}
  const bag = sheet[sizes]
  if (bag || p.restoreSizes?.[sizes]) {
    const next: Record<string, number> = {}
    for (const [k, v] of Object.entries(bag ?? {})) {
      const i = idx(k)
      if (!(i >= 0)) { next[k] = v; continue }
      if (p.count < 0 && i >= delFrom && i <= delTo) { removedSizes[k] = v; continue }
      next[name(i >= p.at ? i + p.count : i)] = v
    }
    for (const [k, v] of Object.entries(p.restoreSizes?.[sizes] ?? {})) next[k] = v
    if (Object.keys(next).length) sheet[sizes] = next
    else delete sheet[sizes]
  }

  return {
    op: 'shiftCanvas', sheet: p.sheet, axis: p.axis, at: p.at, count: -p.count,
    ...(Object.keys(removed).length ? { restore: removed } : {}),
    ...(Object.keys(removedSizes).length ? { restoreSizes: { [sizes]: removedSizes } } : {}),
  }
}

export type ShiftPlan = { ok: true; patches: Patch[] } | { ok: false; message: string }

/**
 * Everything one row/column insert or delete on grid `sheetId` must change,
 * as one list of patches to commit as ONE step.
 */
export function planShift(doc: DashDoc, sheetId: string, axis: 'row' | 'col', at: number, count: number): ShiftPlan {
  const grid = doc.sheets.find((s) => s.id === sheetId)
  if (!grid || grid.kind !== 'canvas' || !count || at < 0) return { ok: false, message: 'Rows and columns can be inserted on a sheet.' }
  const along = (r: Rect) => (axis === 'row' ? [r.r0, r.r1] : [r.c0, r.c1])
  const placed = [...judgePlacements(doc).honoured.values()].filter((j) => j.at.on === sheetId)

  // Refuse a cut through a table: an insert strictly inside it, or a delete
  // that takes some of it but not all of it.
  for (const j of placed) {
    const [lo, hi] = along(j.rect)
    const cut = count > 0
      ? at > lo && at <= hi
      : !(at + -count - 1 < lo || at > hi) && !(at <= lo && at + -count - 1 >= hi)
    if (cut) {
      return {
        ok: false,
        message: `That would cut through the table "${j.table.name}". Add or remove its rows from the table itself.`,
      }
    }
  }

  const patches: Patch[] = [{ op: 'shiftCanvas', sheet: sheetId, axis, at, count } as unknown as Patch]

  // Tables after the cut move with it; a table wholly inside a deleted band is
  // removed from the grid — kept as its own sheet, never silently destroyed.
  for (const j of placed) {
    const [lo, hi] = along(j.rect)
    if (count < 0 && lo >= at && hi <= at + -count - 1) {
      patches.push({ op: 'setSheetProps', sheet: j.table.id, props: {}, drop: ['placed'] })
      continue
    }
    if (lo >= at) {
      const nextPlaced = axis === 'row' ? { ...j.at, r: j.at.r + count } : { ...j.at, c: j.at.c + count }
      patches.push({ op: 'setSheetProps', sheet: j.table.id, props: { placed: nextPlaced } })
    }
  }

  // Every formula and name in the workbook that names this grid.
  const name = grid.name
  for (const s of doc.sheets) {
    const cells = (s as { cells?: Record<string, { f?: unknown }> }).cells
    if (!cells) continue
    const pairs: Array<[string, string]> = []
    for (const k in cells) { const f = cells[k]?.f; if (typeof f === 'string') pairs.push([k, f]) }
    // On the grid itself the formulas are ALSO moving cells; their rewrite is
    // keyed by where they will be AFTER the shift, so it lands on the moved cell.
    const rewritten = shiftSheetFormulas(pairs, axis, at, count, { on: name, self: s.name })
    if (!rewritten.length) continue
    if (s.kind === 'canvas') {
      const next: Record<string, CanvasCell> = {}
      for (const [k, f] of rewritten) {
        const target = s.id === sheetId ? movedKey(k, axis, at, count) : k
        if (target) next[target] = { ...(cells[k] as CanvasCell), f }
      }
      if (Object.keys(next).length) patches.push({ op: 'setCanvasCells', sheet: s.id, cells: next })
    } else if (s.kind === 'table') {
      patches.push({
        op: 'setOverrides', sheet: s.id,
        keys: rewritten.map(([k]) => k),
        v: rewritten.map(([k, f]) => ({ ...(cells[k] as CellOverride), f })),
      })
    }
  }
  const names = shiftDefinedNames(doc.names, axis, at, count, { on: name })
  if (names.length) {
    const next = { ...doc.names }
    for (const [k, ref] of names) next[k] = { ...next[k], ref }
    patches.push({ op: 'setDocProps', props: { names: next } })
  }
  return { ok: true, patches }
}

/** Where a grid cell key lands after the shift; null when its row/column was deleted. */
function movedKey(k: string, axis: 'row' | 'col', at: number, count: number): string | null {
  const pos = posOf(k)
  if (!pos) return k
  const i = axis === 'row' ? pos.row : pos.col
  if (count < 0 && i >= at && i <= at + -count - 1) return null
  const d = i >= at ? count : 0
  return axis === 'row' ? key(pos.row + d, pos.col) : key(pos.row, pos.col + d)
}

/**
 * The patches that make room for table `tableId` to grow by `rows` rows.
 *
 * Empty when the rows below the table are free across its columns. Otherwise
 * WHOLE sheet rows are inserted below it, so everything underneath moves down
 * as a unit and every reference moves with it by the ordinary insert rules —
 * rather than shifting only the cells under the table's columns, which splits
 * ranges that straddle the table's edge.
 */
export function roomToGrow(doc: DashDoc, tableId: string, rows: number): Patch[] {
  const j = judgePlacements(doc).honoured.get(tableId)
  if (!j || rows <= 0) return []
  const grid = doc.sheets.find((s) => s.id === j.at.on) as CanvasSheet
  const below = { r0: j.rect.r1 + 1, r1: j.rect.r1 + rows, c0: j.rect.c0, c1: j.rect.c1 }
  const busyCell = Object.keys(grid.cells).some((k) => {
    const pos = posOf(k)
    return pos && contains(below, pos.row, pos.col)
  })
  const busyTable = [...judgePlacements(doc).honoured.values()].some((o) =>
    o.table.id !== tableId && o.at.on === j.at.on && !(o.rect.r1 < below.r0 || o.rect.r0 > below.r1 || o.rect.c1 < below.c0 || o.rect.c0 > below.c1))
  if (!busyCell && !busyTable) return []
  const plan = planShift(doc, j.at.on, 'row', j.rect.r1 + 1, rows)
  return plan.ok ? plan.patches : []
}

/** For tests: the rectangle a table will have. */
export const rectOf = (t: TableSheet, at: { r: number; c: number }): Rect => tableRect(t, at)
