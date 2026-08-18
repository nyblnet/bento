// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Per-cell formulas: `=B4*1.2` in one cell, evaluated in dependency order.
//
// WHY THIS EXISTS WHEN COLUMN FORMULAS ALREADY DO. A column expression is the
// better tool and stays the default — it names columns by identity, so it
// survives every structural edit (formula.ts's header makes that case, and a1.ts
// explains the price of admitting positions back). But a spreadsheet that
// cannot put a number in one cell is not a spreadsheet. A total under a block,
// a fudge factor, an invoice line: these are single cells, and the person
// typing `=B4*1.2` is not going to be argued out of it.
//
// THE WHOLE MODULE IS A BRIDGE, and deliberately owns no engine of its own:
//
//   a1.ts       decides what is a reference and where it points
//   formula.ts  parses and evaluates the expression, and owns the error values
//   here        binds one to the other, and orders the cells
//
// The binding trick is that formula.ts's `ref` node resolves a NAME against
// `ctx.cols`. So a reference does not need parser support at all: rewrite `B4`
// to a generated name, bind that name to a one-element vector holding B4's
// value, and evaluate over `n = 1`. A RANGE binds the same way to a longer
// vector, which is why `SUM(A1:A5)` works without `:` ever becoming an operator
// — `SUM` already aggregates a vector.
//
// Generated names are `_a1_<i>`, which formula.ts's lexer reads as one
// identifier and a1.ts's scanner will not mistake for a reference on a later
// pass (it starts with `_`, and a reference must start with a letter). A column
// genuinely called `_a1_0` would collide; it also cannot be typed as a column
// name in the UI, and `[_a1_0]` still reaches it.
//
// ORDER IS THE CORRECTNESS PROBLEM, not evaluation. `=B1+1` in A1 and `=A1*2`
// in C1 have to compute in that order or C1 reads a stale value — and unlike a
// stale value in a cache, this one is written into the document and looks
// authoritative. Kahn again (formula.ts does it over columns; this does it over
// cells), and anything still in the graph when the queue drains is in a cycle
// and gets `#CYCLE!`. Never a plausible number: a cycle resolved by "whatever we
// had last time" is the failure mode where a model quietly reports a different
// answer on every recalculation and nobody can tell which one was right.

import { evaluate, isErr, FormulaError, type Cell, type Vec } from './formula.ts'
import {
  expandRange, formatRef, mapRefs, rewriteFormulaRefs, shiftRefsForInsert,
  REF_ERR, type CellRef,
} from './a1.ts'

/**
 * The sheet as a plain grid of positions, so this module never has to know
 * about columns, rids, dictionary encoding or overrides. Whoever calls it owns
 * that translation — and the rig can hand over a literal array.
 */
export interface CellSource {
  rows: number
  cols: number
  /** The formula source at a position (with or without its leading `=`), if it has one. */
  formulaAt(row: number, col: number): string | undefined
  /** The STORED value at a position — never a formula's result. */
  valueAt(row: number, col: number): Cell
}

/** `col,row`, both 0-based — the key a computed-cell map is keyed by. */
export const cellKey = (row: number, col: number): string => `${col},${row}`

export interface CellRecalc {
  /** position key → computed value, for every cell that holds a formula */
  values: Map<string, Cell>
  /** the cells that could not be ordered, reported rather than guessed at */
  cycles: string[]
  /** evaluation order, for tests and for explaining a result to a reader */
  order: string[]
}

/** Is this cell text a formula? The one place the `=` convention is decided. */
export const isFormula = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 1 && v.startsWith('=')

/** The expression inside a formula, without the `=`. */
export const formulaBody = (src: string): string =>
  src.startsWith('=') ? src.slice(1) : src

// --- dependencies -----------------------------------------------------------

interface Dep {
  /** the generated name this reference was bound to */
  name: string
  /** the positions it covers — one for a reference, many for a range */
  cells: CellRef[]
  /** the range was too large to expand, so the whole formula is an error */
  tooBig?: boolean
  /** the source already carried a `#REF!` from an earlier structural edit */
  dead?: boolean
}

/**
 * Rewrite a formula's references to bound names, and report what it read.
 *
 * A `#REF!` already sitting in the source is carried through as `dead` rather
 * than parsed: a1.ts minted it because the cell it named was deleted, and the
 * only honest result is the same error again. Letting it reach formula.ts would
 * turn a precise "that cell is gone" into `#VALUE! could not parse`.
 */
export function bindRefs(src: string): { expr: string; deps: Dep[] } {
  const deps: Dep[] = []
  const expr = mapRefs(src, (u) => {
    const name = `_a1_${deps.length}`
    if (!u.to) {
      deps.push({ name, cells: [u.from] })
      return name
    }
    const cells = expandRange({ from: u.from, to: u.to })
    deps.push(cells === null
      ? { name, cells: [], tooBig: true }
      : { name, cells })
    return name
  })
  // The scanner leaves `#REF!` alone (it is not a reference), so look for it in
  // the ORIGINAL text — the rewrite may have introduced names around it.
  return { expr, deps: src.includes(REF_ERR) ? [{ name: '', cells: [], dead: true }] : deps }
}

/** Every position a formula reads, for the dependency graph. */
export const cellDeps = (src: string): CellRef[] =>
  bindRefs(src).deps.flatMap((d) => d.cells)

// --- evaluation -------------------------------------------------------------

const ERR_REF = (): FormulaError => new FormulaError(REF_ERR, 'the referenced cell was deleted')
const ERR_BIG = (): FormulaError =>
  new FormulaError('#VALUE!', 'the range covers too many cells to evaluate')
const ERR_CYCLE = (): FormulaError => new FormulaError('#CYCLE!')

/**
 * Evaluate one cell's formula, reading other cells through `read`.
 *
 * `read` returns what a reference SEES — a computed value if that cell is
 * itself a formula, a stored value otherwise — which is why ordering happens
 * outside this function and not inside it.
 *
 * A reference off the edge of the sheet is EMPTY, not an error. `A50` on a
 * ten-row sheet is a blank cell in every spreadsheet ever written; `#REF!` means
 * something specific and narrower — the cell you named was deleted — and
 * spending it on "you pointed past the end" would make the one error that
 * carries real information indistinguishable from a typo.
 */
export function evalCell(
  src: string,
  read: (r: CellRef) => Cell,
  opts: { now?: string; cols?: Map<string, Vec> } = {},
): Cell {
  const { expr, deps } = bindRefs(formulaBody(src))
  if (deps.some((d) => d.dead)) return ERR_REF()
  if (deps.some((d) => d.tooBig)) return ERR_BIG()

  // Column names stay visible, so a cell formula can also say `SUM(amount)`.
  // The generated names are added on top and cannot collide with them.
  const cols = new Map<string, Vec>(opts.cols ?? [])
  for (const d of deps) cols.set(d.name, d.cells.map(read))

  const out = evaluate(expr, { cols, n: 1, now: opts.now })
  return out[0] ?? null
}

// --- ordering ---------------------------------------------------------------

/**
 * Compute every formula cell in the grid, in dependency order.
 *
 * Kahn's algorithm over CELLS. The edges run dependency → dependent, so the
 * queue holds cells whose inputs are all settled; anything left when it drains
 * is in a cycle. A cell that reads a non-formula position has no edge at all,
 * because a stored value is already settled.
 */
export function recalcCells(src: CellSource, now?: string, cols?: Map<string, Vec>): CellRecalc {
  const formulas = new Map<string, { row: number; col: number; src: string }>()
  for (let r = 0; r < src.rows; r++) {
    for (let c = 0; c < src.cols; c++) {
      const f = src.formulaAt(r, c)
      if (f !== undefined) formulas.set(cellKey(r, c), { row: r, col: c, src: f })
    }
  }

  // edges, counted only between cells that BOTH hold formulas
  const needs = new Map<string, Set<string>>()
  const feeds = new Map<string, Set<string>>()
  for (const [k, f] of formulas) {
    const n = new Set<string>()
    for (const ref of cellDeps(formulaBody(f.src))) {
      const dk = cellKey(ref.row, ref.col)
      if (dk === k || !formulas.has(dk)) {
        // A self-reference is a cycle of one. It cannot be an edge (Kahn would
        // never dequeue it and it would look like an unrelated cycle), so it is
        // recorded as a dependency on itself and caught by the drain below.
        if (dk === k) n.add(k)
        continue
      }
      n.add(dk)
      if (!feeds.has(dk)) feeds.set(dk, new Set())
      feeds.get(dk)!.add(k)
    }
    needs.set(k, n)
  }

  const values = new Map<string, Cell>()
  const order: string[] = []
  const left = new Map<string, number>()
  const queue: string[] = []
  for (const [k, n] of needs) {
    left.set(k, n.size)
    if (n.size === 0) queue.push(k)
  }

  /** What a reference sees: a computed value if we have one, else what is stored. */
  const read = (r: CellRef): Cell => {
    if (r.row < 0 || r.col < 0 || r.row >= src.rows || r.col >= src.cols) return null
    const k = cellKey(r.row, r.col)
    if (values.has(k)) return values.get(k)!
    // BACKSTOP, and currently unreachable: every formula dependency is an edge,
    // so Kahn settles it before this cell is dequeued, and a formula inside a
    // cycle is never dequeued at all. It stays because the failure it prevents
    // is silent — a future change to the edge rules would otherwise let a
    // reference read a stored value that a formula was about to overwrite, and
    // the result would be a plausible number nobody could tell was stale.
    // Deliberately not covered by the rig: a check that cannot fail is worse
    // than no check, and this line's whole job is to be redundant.
    if (formulas.has(k)) return ERR_CYCLE()
    return src.valueAt(r.row, r.col)
  }

  while (queue.length) {
    const k = queue.shift()!
    const f = formulas.get(k)!
    order.push(k)
    values.set(k, evalCell(f.src, read, { now, cols }))
    for (const d of feeds.get(k) ?? []) {
      const rem = (left.get(d) ?? 1) - 1
      left.set(d, rem)
      if (rem === 0) queue.push(d)
    }
  }

  const cycles: string[] = []
  for (const k of formulas.keys()) {
    if (!values.has(k)) { cycles.push(k); values.set(k, ERR_CYCLE()) }
  }
  return { values, cycles, order }
}

/** A computed value as the grid should show it. Errors print as their code. */
export const displayCell = (v: Cell): string =>
  v === null || v === undefined ? '' : isErr(v) ? String(v) : String(v)

export const _internals = { formatRef, ERR_REF, ERR_BIG, ERR_CYCLE }

// --- keeping references pointing at the right cells --------------------------
//
// The two halves of the problem a1.ts's header sets out, wired to the two
// events that cause them. They are DIFFERENT rules and the difference is the
// thing people get wrong:
//
//   COPY/FILL   the formula moved, the cells did not. References move WITH it,
//               except the `$`-pinned ones. `=A1*2` copied a row down is
//               `=A2*2` — that is the whole point of copying a formula.
//   INSERT/DEL  the CELLS moved, the formula did not. Every reference moves,
//               `$` included, because the cell it names physically moved. A
//               reference INTO a deleted row becomes `#REF!`, never the row
//               that slid up into the gap — a reference silently re-pointed at
//               someone else's data is a wrong number wearing a right one's
//               clothes.

/**
 * A formula moved by (dRow, dCol) — copy, paste and fill.
 *
 * Returns the source unchanged when it holds no references, so a workbook of
 * constants pays nothing.
 */
export function translateCellFormula(src: string, dRow: number, dCol: number): string {
  if (!isFormula(src) || (dRow === 0 && dCol === 0)) return src
  return `=${rewriteFormulaRefs(formulaBody(src), dRow, dCol)}`
}

/**
 * Every cell formula in a sheet, rewritten because `count` rows or columns were
 * inserted at 0-based index `at` (or removed, when `count` is negative).
 *
 * Returns the keys whose source CHANGED, and their new text. Rewriting the
 * unchanged ones too would work and would also put the whole sheet's formulas
 * into one undo step's inverse for an edit that touched three of them.
 */
export function shiftSheetFormulas(
  formulas: Iterable<[string, string]>,
  axis: 'row' | 'col',
  at: number,
  count: number,
): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [key, src] of formulas) {
    if (!isFormula(src)) continue
    const next = `=${shiftRefsForInsert(formulaBody(src), axis, at, count)}`
    if (next !== src) out.push([key, next])
  }
  return out
}
