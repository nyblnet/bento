// A grid's cells as formulas see them once tables are placed on it.
//
// docs/dash-unified.md: `A1` into a placed table resolves to the table cell at
// that position, in STORED row order — a view sort or filter never changes what
// `A1` means. This wraps a grid's own `CellSource` so that inside each placed
// table's rectangle a formula reads the TABLE:
//
//   header row  → the column's name, as Excel's table header cells hold
//   data rows   → the stored value, or a calculated column's computed one
//   totals row  → the column's total
//
// and the grid's own cells hidden under a table neither compute nor spill: a
// formula nobody can see must not write a number into the workbook either.
//
// KNOWN LIMIT, stated rather than hidden: a PER-CELL formula inside a placed
// table (an override with `f`) is addressed in the table's own coordinates, so
// from the grid it reads as its stored value, not a fresh result. Calculated
// COLUMNS — the table idiom, and the only thing Excel's tables have — compute.

import type { Cell, Vec } from './formula.ts'
import type { RangeRef } from './a1.ts'
import type { CellSource } from './cellformula.ts'
import type { TableSheet } from './model.ts'
import { contains, hasTotals, type Judged } from './placement.ts'

/** One placed table, with how to read it. */
export interface PlacedRead {
  judged: Judged
  /** The table's own source — the same one its sheet computes through. */
  source: CellSource
  /** Its column vectors, computed columns resolved; for the totals row. */
  vectors: () => Map<string, Vec>
}

const num = (v: Cell): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** A totals cell's value: the five aggregates Excel's totals row offers. */
export function totalOf(t: TableSheet, colId: string, vec: Vec | undefined): Cell {
  const spec = t.totals?.[colId]
  if (!spec || !vec) return null
  // A custom total `{ f }` is computed by the table's own surface; from the
  // grid it reads blank rather than a guess.
  if (typeof spec !== 'string') return null
  const ns = vec.map(num).filter((n): n is number => n !== null)
  switch (spec) {
    case 'sum': return ns.reduce((a, b) => a + b, 0)
    case 'count': return ns.length
    case 'avg': return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null
    case 'min': return ns.length ? Math.min(...ns) : null
    case 'max': return ns.length ? Math.max(...ns) : null
  }
  return null
}

/** `base`, with every table in `placed` read in place of the cells under it. */
export function overlaySource(base: CellSource, placed: PlacedRead[]): CellSource {
  if (!placed.length) return base
  const hit = (r: number, c: number): PlacedRead | undefined =>
    placed.find((p) => contains(p.judged.rect, r, c))
  const rows = Math.max(base.rows, ...placed.map((p) => p.judged.rect.r1 + 1))
  const cols = Math.max(base.cols, ...placed.map((p) => p.judged.rect.c1 + 1))
  const totalsMemo = new Map<string, Map<string, Vec>>()
  return {
    ...base,
    rows,
    cols,
    formulaAt: (r, c) => (hit(r, c) ? undefined : base.formulaAt(r, c)),
    valueAt: (r, c) => {
      const p = hit(r, c)
      if (!p) return base.valueAt(r, c)
      const { table, rect } = p.judged
      const ci = c - rect.c0
      const col = table.columns[ci]
      if (!col) return null
      const ri = r - rect.r0 - 1
      if (ri < 0) return col.name
      const n = table.rids.reduce((a, [, k]) => a + k, 0)
      if (ri < n) return p.source.valueAt(ri, ci)
      if (!hasTotals(table)) return null
      let vecs = totalsMemo.get(table.id)
      if (!vecs) { vecs = p.vectors(); totalsMemo.set(table.id, vecs) }
      return totalOf(table, col.id, vecs.get(col.id))
    },
    formulaCells: () => {
      const all = base.formulaCells
        ? [...base.formulaCells()]
        : []
      return all.filter((f) => !hit(f.row, f.col))
    },
    clipRange: (range: RangeRef) => {
      // The base clips to the cells IT holds; a table can sit past them, so
      // widen the tail to cover every rectangle — never move the head (a bound
      // range is paired with its neighbours by index).
      const from = range.from
      const to = {
        ...range.to,
        row: Math.min(range.to.row, rows - 1),
        col: Math.min(range.to.col, cols - 1),
      }
      if (to.row < from.row || to.col < from.col) return null
      return { from, to }
    },
  }
}
