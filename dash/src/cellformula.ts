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
//
// THE GRAPH SPANS SHEETS (v0.3). `Sheet1!A1` is a reference like any other, so
// the ordering problem and the cycle problem are both WORKBOOK-wide: A1 on one
// sheet feeding B1 on another has to settle first, and a circle drawn through
// three sheets is exactly as circular as one drawn in a single cell. So
// `recalcWorkbook` is the real entry point and `recalcCells` is the one-sheet
// case of it. A reference to a sheet that is NOT THERE is `#REF!` for the whole
// formula — never a blank, which would read as an empty cell somebody had not
// filled in yet, and never a zero.
//
// SPARSE IS THE POINT OF THE SPREADSHEET KIND, so a range is never expanded
// over a rectangle the sheet does not occupy. `SUM(A1:A100000)` on a sheet with
// three filled cells binds three cells, because the source clips the rectangle
// to what it actually holds before anything is allocated (`CellSource.clipRange`,
// and `canvasCellSource` implements it off the sparse map's own index). The
// head of a range is NEVER moved, only its tail: two ranges of the same shape
// must stay index-aligned or `SUMIF(A1:A100, ">5", B1:B100)` pairs the wrong
// rows together, and that is a wrong number that looks like a right one.

import {
  evaluate, isErr, recalc, spillError, vecShape, FormulaError,
  type Cell, type Shaped, type Vec,
} from './formula.ts'
import {
  expandRange, formatRef, isNameLike, mapNames, mapRefs, rewriteFormulaRefs,
  shiftRefsForInsert, parseRef, sheetQualifiers, RANGE_CELL_MAX, REF_ERR,
  type CellRef, type RangeRef, type ShiftScope,
} from './a1.ts'
import { readCell } from './store.ts'
import type { CanvasCell, CanvasSheet, DefinedName, Sheet, TableSheet } from './model.ts'

/** A position, plus the sheet it is on when the reference named one. */
export type ScopedRef = CellRef & { sheet?: string }

/**
 * The sheet as a plain grid of positions, so this module never has to know
 * about columns, rids, dictionary encoding or overrides. Whoever calls it owns
 * that translation — and the rig can hand over a literal array.
 *
 * `rows`/`cols` are the sheet's EXTENT: a position outside them reads blank,
 * which is what `A50` on a ten-row sheet has always meant here.
 */
export interface CellSource {
  rows: number
  cols: number
  /** The formula source at a position (with or without its leading `=`), if it has one. */
  formulaAt(row: number, col: number): string | undefined
  /** The STORED value at a position — never a formula's result. */
  valueAt(row: number, col: number): Cell
  /**
   * OPTIONAL. Every position that holds a formula.
   *
   * Without it the recalculation walks `rows × cols`, which is right for a
   * dataset and ruinous for a sparse sheet: two cells at A1 and Z10000 would
   * cost 260,000 `formulaAt` calls to find. A sparse source knows its own
   * formulas and hands them over.
   */
  formulaCells?(): Iterable<{ row: number; col: number; src: string }>
  /**
   * OPTIONAL. Trim a rectangle to the part of it this sheet occupies, or `null`
   * when it occupies none of it.
   *
   * ONLY THE TAIL MAY MOVE. The first cell of the returned rectangle must be
   * the first cell of the one asked for, because a bound range is a vector and
   * two vectors from two ranges are paired BY INDEX.
   */
  clipRange?(range: RangeRef): RangeRef | null
  /**
   * OPTIONAL. Set when this sheet exists but its cells cannot be addressed —
   * a pivot's numbers are derived from a spec and live nowhere a position can
   * name. Every read returns this as `#N/A`, because the honest answer is "not
   * available", and a blank would say the cell is empty when it plainly is not.
   */
  unavailable?: string
  /**
   * OPTIONAL. May an array result SPILL across this sheet?
   *
   * True for the SPREADSHEET kind and nothing else — see the SPILL block below
   * for the argument, which is docs/dash-sheet-kinds.md's own: a dataset is
   * typed per COLUMN and is exactly as long as the rows it has, so there is
   * nowhere for a rectangle of arbitrary shape to land, and the columnar answer
   * to the same need — one expression down a whole column — already exists.
   */
  spill?: boolean
}

/**
 * One sheet of a workbook, under the name references use to reach it.
 *
 * `vectors` is a FUNCTION because building it materialises every column of a
 * dataset sheet, and a workbook where nothing references a sheet must not pay
 * for it. It is called at most once per recalculation, and only for a sheet
 * that actually evaluates something.
 */
export interface SheetSource {
  /**
   * What the result is keyed by — the sheet's id, which the document guarantees
   * is unique. Defaults to the name, which it does NOT: renaming a tab to an
   * existing name is allowed (tabs.ts refuses only an EMPTY name), and two
   * sheets called "Sales" must still both compute.
   */
  id?: string
  name: string
  source: CellSource
  /** Column names visible to a formula ON this sheet — `SUM(amount)` in a cell. */
  vectors?(): Map<string, Vec>
  /** The document's defined names as this sheet sees them (columns shadow). */
  names?: NameScope
  /**
   * OPTIONAL. Which KIND of sheet this is, and therefore what the `1` of `A1`
   * counts on it. See the ROW BASE block below — a reference that crosses from
   * one kind to the other is the one place the two answers meet.
   */
  kind?: RowBase
  /**
   * OPTIONAL. This sheet is being computed ON ITS OWN, not as part of a
   * document — `recalcCells`, and a promotion previewing a detached range.
   *
   * A one-sheet list is indistinguishable from a one-sheet workbook, so without
   * this the failed qualifier says "there is no sheet called Jan in this
   * workbook" about a sheet that is sitting in the tab strip of the workbook
   * the caller declined to pass. See `ERR_SHEET`.
   */
  detached?: boolean
}

// --- what the `1` of `A1` counts --------------------------------------------
//
// THE TRAP. `Contacts!D2` on a DATASET is the second row of the DATA. `D2` in
// the spreadsheet COPY of that same dataset is the second row INCLUDING the
// header, which is the first row of the data. Both are internally consistent,
// and side by side on one screen they are off by one — a wrong number with no
// symptom, which is the failure this codebase names everywhere else.
//
// WHAT IS TRUE, and it is one rule rather than two:
//
//   AN A1 ROW NUMBER IS THE ROW NUMBER THE ADDRESSED SHEET PAINTS IN ITS OWN
//   GUTTER.
//
// That rule is already satisfied by both kinds and is the only one a reader can
// CHECK — look at the sheet, read the number beside the row. On a dataset the
// gutter counts data rows, because a dataset has exactly the rows it has and
// its header is chrome rather than a row (docs/dash-excel-gap.md finding 14
// files that under DELIBERATE DIFFERENCE). On a spreadsheet the gutter counts
// every row, because a spreadsheet has no headers — only cells, one of which
// happens to hold a word.
//
// THE ALTERNATIVE WAS REJECTED. Making a dataset's A1 count the header — which
// is what Excel does, and would make the two kinds agree — puts the formula's
// row numbers out of step with the row numbers printed down the side of the
// very same sheet. That is a worse mismatch: the cross-kind one needs two
// sheets to be seen, this one needs none. It would also silently change what
// every `Pipeline!A2` in every saved file already means.
//
// SO THE OFFSET IS NOT REMOVED, IT IS OWNED. `promote.flattenToSpreadsheet`
// already does the only thing that makes the two bases safe to coexist: it
// shifts a copied sheet's LOCAL formulas by the header row and leaves QUALIFIED
// references exactly as written, so nothing is re-pointed at a different row by
// the conversion. `rowMeaning` is the sentence for the other half — the reader
// who has both sheets on screen and is about to type an address at one of them.

/** Which of the two answers a sheet gives to "what does row 1 mean". */
export type RowBase = 'dataset' | 'spreadsheet'

export const rowBaseOf = (sheet: Sheet): RowBase | undefined =>
  sheet.kind === 'table' ? 'dataset' : sheet.kind === 'canvas' ? 'spreadsheet' : undefined

/**
 * What an address AT this sheet counts, in one sentence, for a reader who has
 * two kinds of sheet in front of them.
 *
 * Plain English and no i18n, the convention this file, a1.ts and formula.ts all
 * keep: the panel that shows it owns the translation, the engine owns the fact.
 */
export function rowMeaning(sheet: Sheet): string | undefined {
  const base = rowBaseOf(sheet)
  if (base === 'dataset') {
    return `"${sheet.name}" is a dataset, so ${sheet.name}!A1 is its first DATA row. ` +
      'The header is not a row — the address matches the row number beside it.'
  }
  if (base === 'spreadsheet') {
    return `"${sheet.name}" is a spreadsheet, so ${sheet.name}!A1 is the top row of the grid. ` +
      'A header there is an ordinary cell that happens to hold a word, and it is row 1.'
  }
  return undefined
}

/**
 * What a formula's references are resolved against: which sheets exist, and
 * how big a rectangle each of them really occupies.
 *
 * The DEFAULT refuses every qualified name. That is deliberate: `bindRefs` and
 * `evalCell` can be called with one sheet and no workbook at all, and the
 * honest answer to `Sheet1!A1` in that setting is `#REF!` — the alternative,
 * which this module shipped until the scanner learned about qualifiers, is
 * silently reading the LOCAL A1 and reporting another sheet's number.
 */
export interface RefScope {
  /** Is there a sheet by this name? Case-insensitively, as Excel matches. */
  has(sheet: string): boolean
  /** Trim a rectangle on that sheet (`undefined` = the formula's own sheet). */
  clip(range: RangeRef, sheet: string | undefined): RangeRef | null
  /** OPTIONAL. The document's defined names, minus anything this sheet's own
   *  columns claim. Absent = no names, and every word is a column or `#NAME?`. */
  names?: NameScope
  /**
   * OPTIONAL. Was this scope assembled from a WHOLE workbook?
   *
   * It decides which of two different sentences a failed qualifier gets, and
   * the difference matters to the person reading it. With a workbook, `has()`
   * returning false is a FACT: there is no sheet by that name, go and check the
   * spelling on the tab. Without one, `has()` returns false for every name
   * including the ones sitting in the tab strip, and telling the reader their
   * sheet does not exist is a lie that sends them looking for a deleted sheet
   * that was never deleted.
   */
  workbook?: boolean
}

const NO_SHEETS: RefScope = { has: () => false, clip: (r) => r, workbook: false }

/**
 * The separator between a sheet key and a cell key in a workbook graph node.
 * U+001F, the composite-key trick the CRDT already uses — written as an escape
 * because a literal control character in source survives no copy and no edit.
 */
const NODE_SEP = String.fromCharCode(0x1f)

const sheetKey = (name: string): string => name.toLowerCase()

/** `col,row`, both 0-based — the key a computed-cell map is keyed by. */
export const cellKey = (row: number, col: number): string => `${col},${row}`

export interface CellRecalc {
  /**
   * position key → computed value.
   *
   * Every cell that holds a formula, AND every cell a spill covers. A spilled
   * value is a computed value like any other — it is here and it is nowhere
   * else, because it is never written into the document (see SPILL below).
   */
  values: Map<string, Cell>
  /** the cells that could not be ordered, reported rather than guessed at */
  cycles: string[]
  /** evaluation order, for tests and for explaining a result to a reader */
  order: string[]
  /**
   * Every cell a spill covers — the ANCHOR included — under the anchor that
   * produced it and the rectangle's shape.
   *
   * Whoever paints the sheet reads this to know that a cell holding nothing is
   * nonetheless showing something, and whoever edits it reads it to know that
   * the cell is output rather than input.
   */
  spills: Map<string, SpillClaim>
}

export interface SpillClaim {
  /** the cell key of the formula that produced this value */
  anchor: string
  rows: number
  cols: number
}

/** Is this cell text a formula? The one place the `=` convention is decided. */
export const isFormula = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 1 && v.startsWith('=')

/** The expression inside a formula, without the `=`. */
export const formulaBody = (src: string): string =>
  src.startsWith('=') ? src.slice(1) : src

// --- defined names -----------------------------------------------------------
//
// `=B4*TaxRate` instead of `=B4*0.2`, and `=SUM(Q3Sales)` instead of
// `=SUM('Q3 pipeline'!B2:B41)`.
//
// WHY THEY MATTER MORE HERE THAN IN EXCEL. dash's claim is that a number can be
// traced to where it came from; `=B4*0.2` cannot be traced anywhere, because
// 0.2 is not written down as anything and the next person has to guess whether
// it is VAT, a discount or a typo. A name is the place the guess is answered,
// and one edit moves every use of it at once.
//
// THE MECHANISM IS SUBSTITUTION, AND THAT IS THE WHOLE DESIGN. A name is
// replaced by its TEXT before a reference is bound, so `SUM(Q3Sales)` becomes
// `SUM('Q3 pipeline'!B2:B41)` and every part of this module that already
// works — the binder, the clipper, the workbook-wide dependency ordering, the
// cycle detector — sees a formula it already understands. A name does not need
// its own node kind, its own vector binding, or its own edges: the cells a name
// reaches ARE the cells the formula depends on, and `cellDeps` reports them for
// free. The alternative (bind the name straight to a vector) would have made a
// named range invisible to the ordering, so `TaxRate` pointing at a cell that
// is itself computed would read a stale value.
//
// SCOPE IS THE DOCUMENT, and only the document — see the DEFINED NAMES block in
// model.ts for why one namespace instead of Excel's two, and why a column name
// on a dataset sheet wins over a document name.
//
// A NAME THAT IS NOT DEFINED IS LEFT ALONE, and formula.ts then reports
// `#NAME?`. That is already the right answer and already the one it gives.

/** What a defined name resolves to, for the walk that substitutes it. */
export interface NameScope {
  /** Substitution TEXT for a name, case-insensitively. `undefined` = unknown. */
  lookup(name: string): string | undefined
}

const NO_NAMES: NameScope = { lookup: () => undefined }

/**
 * How many times an expansion may go round before it is called a cycle.
 *
 * A name may be written in terms of another name — Excel allows it and a rate
 * card built out of named parts is the reason to — so one pass is not enough.
 * Eight is far past any chain a person writes and small enough that a
 * pathological document cannot spend a frame here.
 */
export const NAME_DEPTH = 8

/** What `expandNames` reports instead of a name when the chain never settles. */
export const TOO_DEEP = 'a chain of names too deep to resolve'

/**
 * The text a definition substitutes, or `undefined` when it defines nothing.
 *
 * A REFERENCE goes in verbatim: parenthesising `A1:A5` would still work, and
 * would also make every trace of the expansion read worse than the thing the
 * author typed. A LITERAL is parenthesised, because a negative constant
 * substituted into `=2^Rate` has to bind as a value and not as an operator, and
 * a text constant is re-quoted with Excel's doubled-quote escape so a name
 * holding `He said "no"` cannot terminate its own string.
 *
 * `ref` WINS over `v`. Both being set is a document that contradicts itself,
 * and picking the more specific of the two is the only reading that cannot
 * quietly turn a range into a number.
 */
export function nameText(d: DefinedName | undefined): string | undefined {
  if (!d) return undefined
  if (typeof d.ref === 'string' && d.ref.trim() !== '') return d.ref.trim()
  if (typeof d.v === 'number') return Number.isFinite(d.v) ? `(${d.v})` : undefined
  if (typeof d.v === 'string') return `"${d.v.replace(/"/g, '""')}"`
  return undefined
}

/**
 * Substitute every defined name in an expression, repeatedly, until nothing
 * changes.
 *
 * `cycle` names the definition that came back round. A name defined in terms of
 * itself is not resolvable and must not be answered with the partial expansion
 * eight rounds got to — that is a number, and it would look like one.
 *
 * A name is tracked per ROUND, not per occurrence: `=Alpha+Alpha` expands both
 * occurrences of one name at one depth, which is not a cycle. `Alpha` appearing
 * again in the NEXT round means the expansion put it back, which is.
 */
export function expandNames(
  src: string,
  scope: NameScope = NO_NAMES,
): { expr: string; cycle?: string } {
  // A document with no names pays NOTHING: no walk, no allocation. The scanner
  // is one pass over the source per round and a workbook recalculates every
  // formula on every keystroke, so "free when unused" is the price of putting
  // this in the hot path at all.
  if (scope === NO_NAMES) return { expr: src }
  let text = src
  let cycle: string | undefined
  const done = new Set<string>()
  // NAME_DEPTH + 1 rounds: a chain that deep needs one round per link, plus
  // one that finds nothing left to do. Without the confirming round a
  // legitimate chain of exactly NAME_DEPTH would be reported as a cycle.
  for (let pass = 0; pass <= NAME_DEPTH && !cycle; pass++) {
    const round = new Set<string>()
    let hit = false
    text = mapNames(text, (w) => {
      const sub = scope.lookup(w)
      if (sub === undefined) return w
      const k = w.toLowerCase()
      if (done.has(k)) { cycle = w; return w }
      round.add(k)
      hit = true
      return sub
    })
    if (!hit) return { expr: text, cycle }
    for (const k of round) done.add(k)
  }
  // Still expanding after NAME_DEPTH rounds without a name repeating: a chain
  // longer than anything a person writes, and indistinguishable from a cycle
  // built out of enough distinct names. Refused rather than truncated — a
  // partial expansion evaluates to a NUMBER, and it would look like one.
  return { expr: text, cycle: cycle ?? TOO_DEEP }
}

/**
 * The document's name table as a scope, minus anything a column already claims.
 *
 * `shadowed` is the sheet's own column names. It is asked LAST and costs one
 * set lookup per candidate word, so a workbook with no names pays nothing —
 * the table is empty and `lookup` returns on the first line.
 */
export function documentNames(
  names: Record<string, DefinedName> | undefined,
  shadowed?: ReadonlySet<string>,
): NameScope {
  const table = new Map<string, string>()
  for (const [k, d] of Object.entries(names ?? {})) {
    const text = nameText(d)
    // A name spelled like a cell is unreachable — a1.ts resolves `TAX1` as an
    // address long before the word reaches this table — so it is dropped here
    // rather than sitting in the file looking as if it applies.
    if (text !== undefined && isNameLike(k)) table.set(k.toLowerCase(), text)
  }
  if (!table.size) return NO_NAMES
  return {
    lookup: (w) => (shadowed?.has(w.toLowerCase()) ? undefined : table.get(w.toLowerCase())),
  }
}

/** Why a proposed name is refused. `null` = it is fine. Panels localise these. */
export type NameProblem = 'empty' | 'shape' | 'cellshaped' | 'taken'

export const NAME_PROBLEM_EN: Record<NameProblem, string> = {
  empty: 'A name cannot be blank.',
  shape: 'A name must start with a letter or underscore, and hold only letters, digits, "_" and ".".',
  cellshaped: 'That is a cell address, so a formula would read the cell and never the name.',
  taken: 'There is already a name spelled that way.',
}

/**
 * Is this a name a formula could actually reach?
 *
 * The `cellshaped` refusal is the load-bearing one and the one a naive
 * implementation skips: `TAX1` parses as a cell address, so a definition under
 * that spelling would be accepted, saved, and never once consulted. Refusing at
 * the point of definition is the only place a person can be told.
 */
export function validateDefinedName(
  name: string,
  existing?: Record<string, DefinedName>,
): NameProblem | null {
  const n = name.trim()
  if (!n) return 'empty'
  if (parseRef(n)) return 'cellshaped'
  if (!isNameLike(n)) return 'shape'
  const k = n.toLowerCase()
  for (const have of Object.keys(existing ?? {})) {
    if (have !== n && have.toLowerCase() === k) return 'taken'
  }
  return null
}

/**
 * Move every defined name's `ref` because rows or columns were inserted or
 * removed — the same rewrite `shiftSheetFormulas` does for formulas, and it has
 * to happen at the same moment or a name goes on pointing at a row that is now
 * somebody else's.
 *
 * Returns only the entries that CHANGED, so an edit that touched nothing does
 * not land the whole name table in an undo step.
 *
 * A name whose target is entirely deleted comes back as `#REF!` and STAYS IN
 * THE TABLE. Dropping it would report `#NAME?` at every use — "you never
 * defined that" — for an event that was "the cells you named were deleted".
 * The first is a lie about what happened and gives the reader nothing to fix;
 * the second leaves the definition sitting there to be re-pointed.
 */
export function shiftDefinedNames(
  names: Record<string, DefinedName> | undefined,
  axis: 'row' | 'col',
  at: number,
  count: number,
  scope?: ShiftScope,
): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [k, d] of Object.entries(names ?? {})) {
    const ref = typeof d?.ref === 'string' ? d.ref : undefined
    if (ref === undefined || ref.trim() === '' || ref.includes(REF_ERR)) continue
    const next = shiftRefsForInsert(ref, axis, at, count, scope)
    if (next !== ref) out.push([k, next])
  }
  return out
}

// --- dependencies -----------------------------------------------------------

interface Dep {
  /** the generated name this reference was bound to */
  name: string
  /** the sheet it names, when it named one */
  sheet?: string
  /** the positions it covers — one for a reference, many for a range */
  cells: ScopedRef[]
  /** how wide the (clipped) rectangle is, so a lookup can read its shape */
  width?: number
  /** the range was too large to expand, so the whole formula is an error */
  tooBig?: boolean
  /** the source already carried a `#REF!` from an earlier structural edit */
  dead?: boolean
  /** it names a sheet this workbook does not have */
  missing?: boolean
  /** a defined name that expands into itself — the offending spelling */
  nameCycle?: string
}

/** Cells in a rectangle, without building it — the check the cap is made of. */
const rectSize = (a: CellRef, b: CellRef): number =>
  (Math.abs(a.col - b.col) + 1) * (Math.abs(a.row - b.row) + 1)

/**
 * Rewrite a formula's references to bound names, and report what it read.
 *
 * A `#REF!` already sitting in the source is carried through as `dead` rather
 * than parsed: a1.ts minted it because the cell it named was deleted, and the
 * only honest result is the same error again. Letting it reach formula.ts would
 * turn a precise "that cell is gone" into `#VALUE! could not parse`.
 *
 * `scope` decides two things and refuses rather than guessing at both: whether
 * a named sheet exists (it does not ⇒ `missing`, and the formula is `#REF!`),
 * and how much of a rectangle that sheet occupies. The size cap is checked on
 * the rectangle AS WRITTEN, before any clipping — `A1:XFD1048576` is a typo
 * whichever sheet it lands on, and answering it with a clipped handful of cells
 * would be answering a question nobody asked.
 */
export function bindRefs(src: string, scope: RefScope = NO_SHEETS): { expr: string; deps: Dep[] } {
  const deps: Dep[] = []
  // NAMES FIRST, then references. A name substitutes TEXT, so by the time the
  // reference scanner runs there is nothing left that it has not always known
  // how to read — see the DEFINED NAMES block above for why that ordering is
  // the entire design rather than an implementation detail.
  const named = expandNames(src, scope.names)
  if (named.cycle !== undefined) {
    return { expr: named.expr, deps: [{ name: '', cells: [], nameCycle: named.cycle }] }
  }
  src = named.expr
  const expr = mapRefs(src, (u) => {
    const name = `_a1_${deps.length}`
    const sheet = u.sheet
    if (sheet !== undefined && !scope.has(sheet)) {
      deps.push({ name, sheet, cells: [], missing: true })
      return name
    }
    if (!u.to) {
      deps.push({ name, sheet, cells: [{ ...u.from, sheet }] })
      return name
    }
    if (rectSize(u.from, u.to) > RANGE_CELL_MAX) {
      deps.push({ name, sheet, cells: [], tooBig: true })
      return name
    }
    const box = scope.clip({ from: u.from, to: u.to }, sheet)
    const cells = box === null ? [] : expandRange(box)
    if (cells === null) {
      deps.push({ name, sheet, cells: [], tooBig: true })
      return name
    }
    if (sheet !== undefined) for (const c of cells as ScopedRef[]) c.sheet = sheet
    const width = box === null ? 0 : Math.abs(box.to.col - box.from.col) + 1
    deps.push({ name, sheet, cells, width })
    return name
  })
  // The scanner leaves `#REF!` alone (it is not a reference), so look for it in
  // the ORIGINAL text — the rewrite may have introduced names around it.
  return { expr, deps: src.includes(REF_ERR) ? [{ name: '', cells: [], dead: true }] : deps }
}

/** Every position a formula reads, for the dependency graph. */
export const cellDeps = (src: string, scope?: RefScope): ScopedRef[] =>
  bindRefs(src, scope).deps.flatMap((d) => d.cells)

// --- evaluation -------------------------------------------------------------

const ERR_REF = (why = 'the referenced cell was deleted'): FormulaError =>
  new FormulaError(REF_ERR, why)
/**
 * A qualified reference that did not land, and the two reasons it can fail.
 *
 * `#REF!` is the right code for the FIRST one only. To a spreadsheet reader
 * `#REF!` means "the thing this pointed at was deleted" — their file, their
 * mistake — so spending it on "this evaluation was not given the workbook"
 * blames the reader for the caller's limit. The code has to stay `#REF!` in
 * both (it is what Excel gives for a deleted sheet, and the grid has one column
 * of space to say it in), so the whole difference lives in `why`, which is what
 * the panel actually shows.
 */
const ERR_SHEET = (name: string, workbook = true): FormulaError =>
  new FormulaError(REF_ERR, workbook
    ? `there is no sheet called "${name}" in this workbook`
    : `"${name}" is another sheet, and this formula is being computed on its ` +
      'own — outside the workbook that would resolve it')
/**
 * `Jan!Amount` — a sheet, and then something that is not an address on it.
 *
 * The spelling a DATASET author reaches for, because on their own sheet a
 * column name is exactly how you say which column. It bound as nothing, so
 * formula.ts used to report the bare word `Jan` as an unknown name — and once
 * the column language learned to name the cross-sheet boundary, a CELL formula
 * would have inherited that sentence and been told to put it in a cell, which
 * is where it already was. A cell formula CAN reach another sheet; what it
 * cannot do is address a column there, because a column name is not a position
 * and the other sheet is reached by position.
 */
const ERR_NOT_ADDRESS = (sheet: string, after: string): FormulaError =>
  new FormulaError('#NAME?',
    `"${sheet}" is a sheet, but "${after}" is not a cell address on it. ` +
    `A formula reaches another sheet by position — ${sheet}!B2, or ${sheet}!B1:B6 — ` +
    'and a column name only names a column on its own sheet.')
const ERR_BIG = (): FormulaError =>
  new FormulaError('#VALUE!', 'the range covers too many cells to evaluate')
const ERR_CYCLE = (): FormulaError => new FormulaError('#CYCLE!')
const ERR_NAME_CYCLE = (name: string): FormulaError =>
  new FormulaError('#CYCLE!', name.startsWith('a chain')
    ? name
    : `the name "${name}" is defined in terms of itself`)

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
 *
 * A reference to a SHEET that is not there is the deleted case, not the past-
 * the-end case, so it is `#REF!` for the whole formula. That is what Excel does
 * with a deleted sheet, and it is the only answer that cannot be mistaken for
 * data: `Pipeline!D2` reading blank would put an empty cell where a number was
 * supposed to be, and `=Pipeline!D2*1.2` would then report 0.
 */
export function evalCell(
  src: string,
  read: (r: ScopedRef) => Cell,
  opts: { now?: string; cols?: Map<string, Vec>; scope?: RefScope } = {},
): Cell {
  return evalCellArray(src, read, opts).value
}

/**
 * What a formula's result IS, before it is squeezed into one cell.
 *
 * `evalCell` has always thrown everything past the first value away, which is
 * why `=A1:A10*2` reported one number and looked like a mistake. It is not a
 * mistake — it is an ARRAY, and the modern answer is to let it SPILL. See the
 * SPILL block further down for the geometry and the collision rule; this
 * function's only job is to say what shape came back.
 *
 * `cells` is present only when there is more than one, so the scalar path
 * allocates nothing new and every existing caller is unaffected.
 */
export interface CellResult {
  /** what the ANCHOR cell shows: the top-left value, or the error */
  value: Cell
  rows: number
  cols: number
  /** row-major, set only when `rows * cols > 1` */
  cells?: Vec
}

export function evalCellArray(
  src: string,
  read: (r: ScopedRef) => Cell,
  opts: { now?: string; cols?: Map<string, Vec>; scope?: RefScope } = {},
): CellResult {
  const one = (v: Cell): CellResult => ({ value: v, rows: 1, cols: 1 })
  const { expr, deps } = bindRefs(formulaBody(src), opts.scope)
  const circular = deps.find((d) => d.nameCycle !== undefined)
  if (circular) return one(ERR_NAME_CYCLE(circular.nameCycle!))
  if (deps.some((d) => d.dead)) return one(ERR_REF())
  const gone = deps.find((d) => d.missing)
  if (gone) return one(ERR_SHEET(gone.sheet ?? '', opts.scope?.workbook !== false))
  // A qualifier still in the REWRITTEN expression is one that bound to no
  // reference — every real one has become a generated name by now, and a
  // missing sheet was caught on the line above.
  const stray = expr.indexOf('!') < 0 ? undefined : sheetQualifiers(expr)[0]
  if (stray) return one(ERR_NOT_ADDRESS(stray.sheet, stray.after))
  if (deps.some((d) => d.tooBig)) return one(ERR_BIG())

  // Column names stay visible, so a cell formula can also say `SUM(amount)`.
  // The generated names are added on top and cannot collide with them.
  const cols = new Map<string, Vec>(opts.cols ?? [])
  for (const d of deps) {
    const vec: Vec = d.cells.map(read)
    // A range knows its own shape, which is what VLOOKUP and INDEX(r, row, col)
    // read to tell a 2-column table from a 20-row one.
    if (d.width !== undefined) (vec as Vec & Shaped).__cols = d.width
    cols.set(d.name, vec)
  }

  const out = evaluate(expr, { cols, n: 1, now: opts.now })
  if (out.length <= 1) return one(out[0] ?? null)
  const shape = vecShape(out)
  return { value: out[0] ?? null, rows: shape.rows, cols: shape.cols, cells: out }
}

// --- ordering ---------------------------------------------------------------

/** How much of a rectangle a source occupies, when it has no opinion of its own. */
function extentClip(src: CellSource, r: RangeRef): RangeRef | null {
  if (src.unavailable) return null
  const c0 = Math.min(r.from.col, r.to.col)
  const c1 = Math.max(r.from.col, r.to.col)
  const r0 = Math.min(r.from.row, r.to.row)
  const r1 = Math.max(r.from.row, r.to.row)
  if (c0 < 0 || r0 < 0 || c0 >= src.cols || r0 >= src.rows) return null
  return {
    from: { col: c0, row: r0, absCol: false, absRow: false },
    to: {
      col: Math.min(c1, src.cols - 1),
      row: Math.min(r1, src.rows - 1),
      absCol: false,
      absRow: false,
    },
  }
}

const clipTo = (src: CellSource, r: RangeRef): RangeRef | null =>
  src.clipRange ? src.clipRange(r) : extentClip(src, r)

/** Every formula on a sheet — from its own index when it keeps one. */
function formulasOf(src: CellSource): Array<{ row: number; col: number; src: string }> {
  if (src.formulaCells) return [...src.formulaCells()]
  const out: Array<{ row: number; col: number; src: string }> = []
  for (let r = 0; r < src.rows; r++) {
    for (let c = 0; c < src.cols; c++) {
      const f = src.formulaAt(r, c)
      if (f !== undefined) out.push({ row: r, col: c, src: f })
    }
  }
  return out
}

// --- SPILL --------------------------------------------------------------------
//
// `=A1:A10*2` in ONE cell, and ten values appear. Muscle memory for anyone who
// has used Excel since 2019, and the single most jarring absence for them.
//
// A SPILLED RANGE IS COMPUTED, NOT STORED, and everything below follows from
// that one sentence. Only the ANCHOR holds a formula; the other cells are
// OUTPUT. They are written into `CellRecalc.values` and into nothing else —
// never into `sheet.cells`, so they cannot be saved as if someone typed them,
// cannot be edited independently, and vanish the instant the anchor changes,
// because the next recalculation simply does not produce them. Materialising
// them into the document would be the same failure as caching a formula's
// result next to the formula: two answers to one question, and the stale one
// looks exactly as authoritative as the live one.
//
// COLLISION BLOCKS, IT NEVER OVERWRITES. Anything already in the spill area —
// a typed value, another formula, another spill — stops the whole spill and the
// anchor reads `#SPILL!`. Overwriting is data loss, and it is data loss of the
// worst kind: silent, and to a cell the author was looking at. The anchor keeps
// its formula and starts working again the moment the obstruction is cleared.
//
// WHICH KIND: THE SPREADSHEET, AND DELIBERATELY NOT THE DATASET.
// docs/dash-sheet-kinds.md draws the line and this lands on the right side of
// it. A dataset is typed per COLUMN and is "exactly the rows there are"; a
// spill is a rectangle of arbitrary shape arriving at an arbitrary position, so
// on a dataset it would have to either invent rows (breaking the extent rule)
// or write cells of its own type into a typed column (breaking the type rule).
// And the columnar answer to the same need is already there and is better: a
// COLUMN FORMULA is one expression that fills a whole column by construction,
// survives every structural edit, and cannot collide with anything. `=A1:A10*2`
// spilling down a dataset would be a worse spelling of a feature that kind
// already has. So `CellSource.spill` is true for the spreadsheet kind alone,
// and on a dataset a cell formula keeps returning its first value as it always
// has.
//
// ORDERING IS THE HARD PART, and it is why this runs to a FIXED POINT. A cell
// reading `D2` where D2 is spill output has a dependency on the ANCHOR at D1 —
// but the footprint is not known until the anchor has been evaluated, and the
// evaluation order is decided by the dependencies. That is circular, so the
// recalculation is run again with the footprints the previous run discovered,
// until the footprints stop changing. In practice that is two passes: one to
// find them, one to use them. A workbook with no spills does one pass and pays
// nothing. A spill whose own size depends on its own output never settles, and
// after SPILL_PASSES those anchors are told so rather than being handed
// whichever answer the last iteration happened to hold.
//
// CONFLICTS ARE RESOLVED IN READING ORDER, not in evaluation order. Two spills
// that want the same cell have to produce the same winner on every machine and
// after every reload, and evaluation order depends on the dependency graph and
// on the order a sparse cell map happens to enumerate. Top-most then left-most
// wins; the other reads `#SPILL!`.

/** How far a spill may reach before it is refused. Excel's own sheet bounds. */
const SPILL_MAX_ROWS = 1_048_576
const SPILL_MAX_COLS = 16_384
/**
 * Cells one spill may place.
 *
 * A range binds up to RANGE_CELL_MAX (a million), and a million cells the grid
 * has to paint is a dead tab rather than an answer. `#SPILL!` is answerable.
 */
export const SPILL_CELL_MAX = 100_000
/** Iterations before a spill that resizes itself is called circular. */
const SPILL_PASSES = 6

/**
 * Compute every formula cell in a WORKBOOK, in dependency order.
 *
 * Kahn's algorithm over cells, exactly as the single-sheet version always did —
 * the only difference is that a node is now `<sheet>U+001F<col>,<row>` and an
 * edge may cross a sheet boundary. That is what makes a cycle drawn THROUGH
 * another sheet detectable at all: `Sheet1!A1 = Sheet2!A1 + 1` and
 * `Sheet2!A1 = Sheet1!A1` is a circle, and per-sheet ordering can only see two
 * halves of it, each of which looks perfectly settled on its own.
 *
 * A NODE IS NAMESPACED BY THE SHEET'S POSITION, not by its name, and every
 * sheet computes. Names are not unique — renaming a tab to one already in use
 * is allowed — so keying the graph by name would make the second "Sales" a
 * sheet whose formulas silently never ran. What names DO decide is where a
 * reference lands: `Sales!A1` resolves to the FIRST sheet of that name,
 * case-insensitively as Excel matches, which is at least predictable.
 *
 * SPILLED OUTPUT IS PART OF THE GRAPH, which is why the whole thing may run
 * more than once — see the SPILL block above.
 *
 * Returns one result per sheet, keyed by `id` where it has one and by `name`
 * otherwise.
 */
export function recalcWorkbook(sheets: SheetSource[], now?: string): Map<string, CellRecalc> {
  /** name → the sheet POSITION a reference to that name resolves to. */
  const byName = new Map<string, number>()
  sheets.forEach((s, i) => {
    const k = sheetKey(s.name)
    if (!byName.has(k)) byName.set(k, i)
  })

  const node = (at: number, row: number, col: number): string =>
    `${at}${NODE_SEP}${cellKey(row, col)}`

  /** Which sheet a reference lands on: the one it named, or the one it is on. */
  const targetAt = (ref: ScopedRef, self: number): number =>
    ref.sheet === undefined ? self : byName.get(sheetKey(ref.sheet)) ?? -1

  // every formula in the workbook, and the one graph they all live in
  const formulas = new Map<string, { at: number; row: number; col: number; src: string }>()
  sheets.forEach((s, i) => {
    for (const f of formulasOf(s.source)) {
      formulas.set(node(i, f.row, f.col), { at: i, row: f.row, col: f.col, src: f.src })
    }
  })

  /**
   * Is there something at this position that a spill must not write over?
   *
   * A stored value or a formula. NOT formatting: a coloured empty cell is still
   * empty, and Excel spills through one. Past the sheet's stored extent there
   * is by definition nothing.
   */
  const occupied = (at: number, row: number, col: number): boolean => {
    const s = sheets[at]
    if (!s) return true
    if (row >= s.source.rows || col >= s.source.cols) return false
    if (s.source.formulaAt(row, col) !== undefined) return true
    const v = s.source.valueAt(row, col)
    return v !== null && v !== undefined && v !== ''
  }

  interface Attempt {
    k: string; at: number; row: number; col: number
    rows: number; cols: number; cells: Vec
  }
  interface Pass {
    values: Map<string, Cell>
    order: string[]
    cycles: string[]
    claims: Map<string, SpillClaim>
  }

  const anySpill = sheets.some((s) => s.source.spill)

  const runPass = (prior: Map<string, SpillClaim>): Pass => {
    // How far each sheet reaches once the PREVIOUS pass's spills are counted.
    // A range over spilled cells must bind them — `SUM(A1:A20)` under a spill
    // that fills A1:A10 on a sheet that stores only A1 would otherwise clip to
    // one cell and total one number. The head of a range is never moved, only
    // its tail, so this can only over-include, and an over-included empty cell
    // reads as empty.
    const reach = new Map<number, { rows: number; cols: number }>()
    for (const key of prior.keys()) {
      const sep = key.indexOf(NODE_SEP)
      const at = Number(key.slice(0, sep))
      const p = posOf(key.slice(sep + 1))
      if (!p) continue
      const r = reach.get(at) ?? { rows: 0, cols: 0 }
      if (p.row + 1 > r.rows) r.rows = p.row + 1
      if (p.col + 1 > r.cols) r.cols = p.col + 1
      reach.set(at, r)
    }

    const clipOn = (at: number, r: RangeRef): RangeRef | null => {
      const s = sheets[at]
      if (!s) return null
      const base = clipTo(s.source, r)
      const far = reach.get(at)
      if (!far || s.source.unavailable) return base
      const c0 = Math.min(r.from.col, r.to.col)
      const c1 = Math.max(r.from.col, r.to.col)
      const r0 = Math.min(r.from.row, r.to.row)
      const r1 = Math.max(r.from.row, r.to.row)
      if (c0 < 0 || r0 < 0) return base
      const lastRow = Math.min(r1, far.rows - 1)
      const lastCol = Math.min(c1, far.cols - 1)
      if (lastRow < r0 || lastCol < c0) return base
      const abs = { absCol: false, absRow: false }
      if (base === null) {
        return { from: { col: c0, row: r0, ...abs }, to: { col: lastCol, row: lastRow, ...abs } }
      }
      return {
        from: base.from,
        to: {
          col: Math.max(base.to.col, lastCol),
          row: Math.max(base.to.row, lastRow),
          ...abs,
        },
      }
    }

    const scopeFor = (self: number): RefScope => ({
      workbook: !sheets[self]?.detached,
      has: (name) => byName.has(sheetKey(name)),
      clip: (r, name) => {
        const at = name === undefined ? self : byName.get(sheetKey(name)) ?? -1
        return at < 0 ? null : clipOn(at, r)
      },
      names: sheets[self]?.names,
    })

    const scopes = new Map<number, RefScope>()
    const scopeOf = (at: number): RefScope => {
      let sc = scopes.get(at)
      if (!sc) { sc = scopeFor(at); scopes.set(at, sc) }
      return sc
    }

    // Edges, counted between cells that hold formulas — and now also from a
    // SPILL ANCHOR to whoever reads a cell it covers. Without that edge the
    // reader is ordered before the anchor and sees the stored (empty) cell.
    const needs = new Map<string, Set<string>>()
    const feeds = new Map<string, Set<string>>()
    for (const [k, f] of formulas) {
      const n = new Set<string>()
      for (const ref of cellDeps(formulaBody(f.src), scopeOf(f.at))) {
        const at = targetAt(ref, f.at)
        if (at < 0) continue
        const dk = node(at, ref.row, ref.col)
        const owner = formulas.has(dk) ? dk : prior.get(dk)?.anchor
        if (owner === undefined) continue
        if (owner === k) {
          // A self-reference is a cycle of one, and so is a formula reading its
          // own spill. Neither can be an edge (Kahn would never dequeue it and
          // it would look like an unrelated cycle), so it is recorded as a
          // dependency on itself and caught by the drain below.
          n.add(k)
          continue
        }
        n.add(owner)
        if (!feeds.has(owner)) feeds.set(owner, new Set())
        feeds.get(owner)!.add(k)
      }
      needs.set(k, n)
    }

    const values = new Map<string, Cell>()
    const left = new Map<string, number>()
    const queue: string[] = []
    for (const [k, n] of needs) {
      left.set(k, n.size)
      if (n.size === 0) queue.push(k)
    }

    /**
     * What a reference sees: a computed value if we have one, else what is
     * stored.
     *
     * The COMPUTED lookup happens before the bounds check, and only when this
     * pass knows about spills: a spilled cell is routinely past the sheet's
     * stored extent (that is what an unbounded sheet is for), so a bounds check
     * first would answer "empty" for a cell that is plainly showing a number.
     *
     * The unqualified case is otherwise the hot one — a range over ten thousand
     * cells on this sheet is ten thousand calls — so it resolves without a
     * lookup.
     */
    const spillsKnown = prior.size > 0
    const readFrom = (self: number) => {
      const own = sheets[self]
      return (r: ScopedRef): Cell => {
        const at = r.sheet === undefined ? self : byName.get(sheetKey(r.sheet)) ?? -1
        const s = r.sheet === undefined ? own : sheets[at]
        if (!s) return ERR_SHEET(r.sheet ?? '', !own?.detached)
        if (s.source.unavailable) return new FormulaError('#N/A', s.source.unavailable)
        if (r.row < 0 || r.col < 0) return null
        if (spillsKnown) {
          const sk = node(at, r.row, r.col)
          if (values.has(sk)) return values.get(sk)!
        }
        if (r.row >= s.source.rows || r.col >= s.source.cols) return null
        const k = node(at, r.row, r.col)
        if (values.has(k)) return values.get(k)!
        // BACKSTOP, and currently unreachable: every formula dependency is an
        // edge, so Kahn settles it before this cell is dequeued, and a formula
        // inside a cycle is never dequeued at all. It stays because the failure
        // it prevents is silent — a future change to the edge rules would
        // otherwise let a reference read a stored value that a formula was
        // about to overwrite, and the result would be a plausible number nobody
        // could tell was stale. Deliberately not covered by the rig: a check
        // that cannot fail is worse than no check, and this line's job is
        // redundancy.
        if (formulas.has(k)) return ERR_CYCLE()
        return s.source.valueAt(r.row, r.col)
      }
    }

    // The column vectors a sheet's own formulas can name (`SUM(amount)`), built
    // at most once per sheet and only for a sheet that computes something.
    const vecs = new Map<number, Map<string, Vec> | undefined>()
    const vectorsOf = (at: number): Map<string, Vec> | undefined => {
      if (!vecs.has(at)) vecs.set(at, sheets[at]?.vectors?.())
      return vecs.get(at)
    }
    const readers = new Map<number, (r: ScopedRef) => Cell>()
    const readerOf = (at: number): (r: ScopedRef) => Cell => {
      let rd = readers.get(at)
      if (!rd) { rd = readFrom(at); readers.set(at, rd) }
      return rd
    }

    /** Why this array result cannot land here, or `null` if it can. */
    const blocked = (a: Attempt): string | null => {
      if (a.rows * a.cols > SPILL_CELL_MAX) {
        return `the result is ${a.rows * a.cols} cells, more than one formula may place`
      }
      if (a.row + a.rows > SPILL_MAX_ROWS || a.col + a.cols > SPILL_MAX_COLS) {
        return 'the result runs off the edge of the sheet'
      }
      for (let r = 0; r < a.rows; r++) {
        for (let c = 0; c < a.cols; c++) {
          if (r === 0 && c === 0) continue
          const row = a.row + r
          const col = a.col + c
          if (occupied(a.at, row, col)) {
            return `${formatRef({ col, row, absCol: false, absRow: false })} is not empty`
          }
          const held = prior.get(node(a.at, row, col))
          if (held && held.anchor !== a.k) {
            return `${formatRef({ col, row, absCol: false, absRow: false })} already holds another formula's result`
          }
        }
      }
      return null
    }

    const attempts: Attempt[] = []
    const write = (a: Attempt, claims: Map<string, SpillClaim>): void => {
      const shape = { anchor: a.k, rows: a.rows, cols: a.cols }
      claims.set(a.k, shape)
      for (let r = 0; r < a.rows; r++) {
        for (let c = 0; c < a.cols; c++) {
          if (r === 0 && c === 0) continue
          const nk = node(a.at, a.row + r, a.col + c)
          values.set(nk, a.cells[r * a.cols + c] ?? null)
          claims.set(nk, shape)
        }
      }
    }

    const order: string[] = []
    const live = new Map<string, SpillClaim>()
    while (queue.length) {
      const k = queue.shift()!
      const f = formulas.get(k)!
      order.push(k)
      const res = evalCellArray(f.src, readerOf(f.at), {
        now, cols: vectorsOf(f.at), scope: scopeOf(f.at),
      })
      values.set(k, res.value)
      if (res.cells && sheets[f.at]?.source.spill) {
        const a: Attempt = {
          k, at: f.at, row: f.row, col: f.col, rows: res.rows, cols: res.cols, cells: res.cells,
        }
        const why = blocked(a)
        if (why) values.set(k, spillError(why))
        else { attempts.push(a); write(a, live) }
      }
      for (const d of feeds.get(k) ?? []) {
        const rem = (left.get(d) ?? 1) - 1
        left.set(d, rem)
        if (rem === 0) queue.push(d)
      }
    }

    // Two spills that both got this far want the same cell. Reading order
    // decides, never evaluation order — see the SPILL block. The loser's values
    // are removed and the winners are re-written, because the loser may have
    // clobbered an overlapping cell on its way past.
    let claims = live
    if (attempts.length > 1) {
      const sorted = [...attempts].sort((x, y) =>
        x.at - y.at || x.row - y.row || x.col - y.col)
      const kept: Attempt[] = []
      const taken = new Set<string>()
      const losers: Attempt[] = []
      for (const a of sorted) {
        let clash = false
        for (let r = 0; r < a.rows && !clash; r++) {
          for (let c = 0; c < a.cols && !clash; c++) {
            if (taken.has(node(a.at, a.row + r, a.col + c))) clash = true
          }
        }
        if (clash) { losers.push(a); continue }
        kept.push(a)
        for (let r = 0; r < a.rows; r++) {
          for (let c = 0; c < a.cols; c++) taken.add(node(a.at, a.row + r, a.col + c))
        }
      }
      if (losers.length) {
        claims = new Map()
        for (const a of losers) {
          for (let r = 0; r < a.rows; r++) {
            for (let c = 0; c < a.cols; c++) {
              if (r === 0 && c === 0) continue
              values.delete(node(a.at, a.row + r, a.col + c))
            }
          }
          values.set(a.k, spillError("another formula's result already covers these cells"))
        }
        for (const a of kept) write(a, claims)
      }
    }

    // Never dequeued ⇒ never evaluated ⇒ in a cycle. A formula node cannot be
    // in `values` for any other reason: a spill only ever writes to cells that
    // the occupancy check proved hold neither a value nor a formula.
    const cycles: string[] = []
    const settled = new Set(order)
    for (const k of formulas.keys()) {
      if (!settled.has(k)) { cycles.push(k); values.set(k, ERR_CYCLE()) }
    }

    return { values, order, cycles, claims }
  }

  /** Do two passes agree about where every spill landed? */
  const same = (a: Map<string, SpillClaim>, b: Map<string, SpillClaim>): boolean => {
    if (a.size !== b.size) return false
    for (const [k, v] of a) {
      const w = b.get(k)
      if (!w || w.anchor !== v.anchor || w.rows !== v.rows || w.cols !== v.cols) return false
    }
    return true
  }

  let pass = runPass(new Map())
  if (anySpill && pass.claims.size) {
    let settled = false
    for (let i = 0; i < SPILL_PASSES; i++) {
      const next = runPass(pass.claims)
      if (same(next.claims, pass.claims)) { pass = next; settled = true; break }
      pass = next
    }
    if (!settled) {
      // A spill whose footprint depends on its own output. Told, not guessed
      // at: the alternative is handing the reader whichever size the last
      // iteration happened to hold, which is a different number on a different
      // day and nothing on screen says so.
      const anchors = new Set<string>()
      for (const c of pass.claims.values()) anchors.add(c.anchor)
      for (const k of anchors) {
        pass.values.set(k, spillError('the size of this result depends on where it lands'))
      }
      for (const [k, c] of [...pass.claims]) {
        if (k !== c.anchor) pass.values.delete(k)
      }
      pass.claims = new Map()
    }
  }

  // split back out, per sheet, in the keys the callers already use
  const out = new Map<string, CellRecalc>()
  const keyed = sheets.map((s) => s.id ?? s.name)
  for (const k of keyed) {
    if (!out.has(k)) {
      out.set(k, { values: new Map(), cycles: [], order: [], spills: new Map() })
    }
  }
  const bucket = (id: string): CellRecalc | undefined =>
    out.get(keyed[Number(id.slice(0, id.indexOf(NODE_SEP)))])
  const cellOf = (id: string): string => id.slice(id.indexOf(NODE_SEP) + 1)
  for (const [id, v] of pass.values) bucket(id)?.values.set(cellOf(id), v)
  for (const id of pass.order) bucket(id)?.order.push(cellOf(id))
  for (const id of pass.cycles) bucket(id)?.cycles.push(cellOf(id))
  for (const [id, c] of pass.claims) {
    bucket(id)?.spills.set(cellOf(id), { anchor: cellOf(c.anchor), rows: c.rows, cols: c.cols })
  }
  return out
}

/**
 * How far a sheet is occupied once its spills are counted.
 *
 * The grid rules its sheet from the USED range outward, and a spill's output is
 * used range that is in no cell map. Without this a `=A1:A100*2` on a
 * three-row sheet would paint its first forty rows and stop, and the reader
 * would have no way to tell a spill that ended from one that ran out of paper.
 */
export function spillExtent(r: CellRecalc): { rows: number; cols: number } {
  let rows = 0
  let cols = 0
  for (const key of r.spills.keys()) {
    const p = posOf(key)
    if (!p) continue
    if (p.row + 1 > rows) rows = p.row + 1
    if (p.col + 1 > cols) cols = p.col + 1
  }
  return { rows, cols }
}

/**
 * Is this cell OUTPUT rather than input — a value that arrived from an anchor
 * somewhere else?
 *
 * The anchor itself is not spilled output: it holds the formula, and it is the
 * one cell of the rectangle a person may edit.
 */
export function spilledFrom(r: CellRecalc, row: number, col: number): string | undefined {
  const k = cellKey(row, col)
  const c = r.spills.get(k)
  return c && c.anchor !== k ? c.anchor : undefined
}

/**
 * Compute every formula cell in ONE sheet, in dependency order.
 *
 * The single-sheet case of `recalcWorkbook`, and the shape every caller used
 * before sheets could reference each other. A qualified reference here names a
 * sheet this call cannot see, so it reads `#REF!` — pass the whole workbook to
 * resolve one.
 */
export function recalcCells(
  src: CellSource,
  now?: string,
  cols?: Map<string, Vec>,
  names?: NameScope,
): CellRecalc {
  const one: SheetSource = {
    name: '', source: src, vectors: cols && (() => cols), names, detached: true,
  }
  return recalcWorkbook([one], now).get('')!
}

/**
 * One sheet's cell formulas, computed THROUGH ITS WORKBOOK — the call a grid
 * painting a sheet should make, of EITHER kind.
 *
 * THIS EXISTS BECAUSE THE TWO KINDS HAD TWO DIFFERENT ANSWERS TO ONE QUESTION.
 * A spreadsheet sheet went through `recalcWorkbook`, so `=Contacts!D2` resolved.
 * A dataset sheet went through `recalcCells`, which is one sheet and no
 * workbook, so the identical formula in the identical workbook came back
 * `#REF!` — and, worse, `#REF! there is no sheet called "Contacts" in this
 * workbook` about a sheet sitting in the tab strip. That was never a decision
 * about the kinds; it was two call sites, and a kind is not a place to keep an
 * accident.
 *
 * A DATASET RESOLVES CROSS-SHEET REFERENCES IN A CELL FORMULA. It already
 * resolves them in the other direction (a spreadsheet has read `Pipeline!A1`
 * since the workbook graph landed), a per-cell override is already the CELLULAR
 * escape hatch inside the columnar kind, and it is already bound by this module,
 * which is already workbook-wide. The boundary that actually exists between the
 * kinds is where the TYPE lives, and a cell override is on the cellular side of
 * it either way. Refusing only the outbound direction made the dataset the
 * lesser kind, which docs/dash-sheet-kinds.md says in as many words it is not.
 *
 * A COLUMN FORMULA STILL DOES NOT, and that refusal is `formula.ts`'s —
 * see `crossSheetRefusal` there for why a column expression reaching another
 * sheet is either a position that will move or a join with no key.
 *
 * `own` supplies the caller's already-computed column formulas for a sheet it
 * has painted, so they are not evaluated twice; every other sheet resolves
 * lazily and only if something reads it.
 */
export function recalcSheetCells(
  doc: { sheets?: Sheet[]; names?: Record<string, DefinedName>; modified?: string },
  sheetId: string,
  own?: (sheet: TableSheet) => Map<string, Vec> | undefined,
): CellRecalc {
  return recalcWorkbook(workbookSources(doc, own), doc.modified).get(sheetId)
    ?? { values: new Map(), cycles: [], order: [], spills: new Map() }
}

// --- the sheets themselves ---------------------------------------------------
//
// One `CellSource` per sheet KIND, so that the workbook a formula resolves
// against is assembled in one place rather than three. The grid, Find and the
// validator each built their own view of a dataset sheet before this, which was
// survivable while a formula could only see its own sheet and is not now: a
// reference across sheets means every sheet has to be addressable by whoever
// happens to be recalculating, including the one that is not on screen.

/** The canonical key of a spreadsheet cell, and the A1 spelling read as well. */
function posOf(key: string): { row: number; col: number } | null {
  const i = key.indexOf(',')
  if (i > 0) {
    const col = Number(key.slice(0, i))
    const row = Number(key.slice(i + 1))
    if (Number.isInteger(col) && Number.isInteger(row) && col >= 0 && row >= 0) return { row, col }
    return null
  }
  const r = parseRef(key)
  return r ? { row: r.row, col: r.col } : null
}

/**
 * A SPREADSHEET sheet (`kind: 'canvas'`) as a grid of positions.
 *
 * Keyed by `cellKey(row, col)` — what `setCanvasCells` writes (store.ts) — and
 * an A1 key is read too, because `preview.ts` and `validate.ts` were written
 * against that spelling and files exist with it. Reading both is tolerance at
 * the edge, not a second convention: nothing here ever writes a key.
 *
 * NOTHING IS SCANNED TWICE. The sparse map is walked ONCE, into the three
 * things a recalculation asks for — the cells, the formulas, and how far each
 * column reaches. Without that last index `SUM(A1:A100000)` on a sheet holding
 * three numbers would expand a hundred thousand references to find them, which
 * is the whole cost this kind exists to avoid.
 */
export function canvasCellSource(sheet: Pick<CanvasSheet, 'cells'>): CellSource {
  const cells = new Map<string, CanvasCell>()
  const formulas: Array<{ row: number; col: number; src: string }> = []
  /** column → the last row of it that holds anything */
  const reach = new Map<number, number>()
  let rows = 0
  let cols = 0

  for (const [key, cell] of Object.entries(sheet.cells ?? {})) {
    const p = posOf(key)
    // A key that names no position is left alone: it is somebody else's data or
    // a typo, and inventing a position for it would put a value on the sheet
    // that the file does not say is there. validate.ts reports it.
    if (!p || !cell) continue
    cells.set(cellKey(p.row, p.col), cell)
    if (p.row >= rows) rows = p.row + 1
    if (p.col >= cols) cols = p.col + 1
    const far = reach.get(p.col)
    if (far === undefined || p.row > far) reach.set(p.col, p.row)
    const f = cell.f
    if (typeof f === 'string' && f.trim() !== '') formulas.push({ row: p.row, col: p.col, src: f })
  }

  return {
    rows,
    cols,
    // THE SPREADSHEET KIND, and the only one. See the SPILL block above.
    spill: true,
    formulaAt: (r, c) => {
      const f = cells.get(cellKey(r, c))?.f
      return typeof f === 'string' && f.trim() !== '' ? f : undefined
    },
    valueAt: (r, c) => {
      const cell = cells.get(cellKey(r, c))
      // A cell holding only a formula stores no value: its number is computed,
      // and reading a stale `v` back would be the cache-that-looks-authoritative
      // failure the header warns about.
      return cell === undefined || cell.v === undefined ? null : (cell.v as Cell)
    },
    formulaCells: () => formulas,
    clipRange: (r) => {
      const c0 = Math.min(r.from.col, r.to.col)
      const c1 = Math.max(r.from.col, r.to.col)
      const r0 = Math.min(r.from.row, r.to.row)
      const r1 = Math.max(r.from.row, r.to.row)
      if (c0 < 0 || r0 < 0 || c0 >= cols || r0 >= rows) return null
      // How far down this BAND of columns anything reaches — not how far the
      // sheet reaches, so a stray cell in column Z costs column A nothing.
      let last = -1
      for (const [col, far] of reach) {
        if (col >= c0 && col <= c1 && far > last) last = far
      }
      if (last < r0) return null
      return {
        from: { col: c0, row: r0, absCol: false, absRow: false },
        to: {
          col: Math.min(c1, cols - 1),
          row: Math.min(r1, last),
          absCol: false,
          absRow: false,
        },
      }
    },
  }
}

/** Row index → rid, walking the run-length runs rather than expanding them. */
const ridAtRow = (sheet: TableSheet, row: number): number => {
  let seen = 0
  for (const [start, count] of sheet.rids) {
    if (row < seen + count) return start + (row - seen)
    seen += count
  }
  return -1
}

/** rid → row index. The inverse, and just as cheap. */
const rowOfRid = (sheet: TableSheet, rid: number): number => {
  let seen = 0
  for (const [start, count] of sheet.rids) {
    if (rid >= start && rid < start + count) return seen + (rid - start)
    seen += count
  }
  return -1
}

/**
 * A DATASET sheet (`kind: 'table'`) as a grid of positions, so `Pipeline!D2`
 * means what a reader plainly thinks it means: the cell two rows down the
 * fourth column of that table.
 *
 * Column ORDER is the sheet's own, hidden columns included. A reference is a
 * position and the position must not move because somebody hid a column — the
 * grid draws a subset, the file has all of them, and the file is what a formula
 * addresses.
 *
 * `computed` is that sheet's column formulas, already evaluated (formula.ts's
 * `recalc`). Without it a computed column reads as its stored value, which is
 * usually nothing at all.
 */
export function tableCellSource(
  sheet: TableSheet,
  computed?: Map<string, Vec> | (() => Map<string, Vec> | undefined),
): CellSource {
  const rows = sheet.rids.reduce((n, [, count]) => n + count, 0)
  const columns = sheet.columns
  // A FUNCTION is how a workbook says "only if somebody reads this sheet". A
  // workbook recalculates on every keystroke and most of its sheets are not
  // referenced by anything, so evaluating a 100k-row dataset's column formulas
  // to build a source nobody reads is the whole cost of making the graph
  // workbook-wide. Resolved at most once, here.
  let memo: Map<string, Vec> | undefined
  let asked = false
  const comp = (): Map<string, Vec> | undefined => {
    if (typeof computed !== 'function') return computed
    if (!asked) { asked = true; memo = computed() }
    return memo
  }
  return {
    rows,
    cols: columns.length,
    formulaAt: (r, c) => {
      const col = columns[c]
      if (!col) return undefined
      const f = sheet.cells?.[`${col.id}:${ridAtRow(sheet, r)}`]?.f
      return typeof f === 'string' && f.trim() !== '' ? f : undefined
    },
    valueAt: (r, c) => {
      const col = columns[c]
      if (!col) return null
      const over = sheet.cells?.[`${col.id}:${ridAtRow(sheet, r)}`]
      if (over && 'v' in over) return over.v as Cell
      // Only a COMPUTED column pays for the resolution. A plain stored column
      // is read straight out of the dictionary, which is what keeps a reference
      // into an ordinary dataset free.
      const vec = col.formula ? comp()?.get(col.id) : undefined
      return (vec ? vec[r] ?? null : readCell(sheet.data[col.id], r) as Cell)
    },
    formulaCells: () => {
      const out: Array<{ row: number; col: number; src: string }> = []
      const index = new Map(columns.map((c, i) => [c.id, i]))
      for (const [key, over] of Object.entries(sheet.cells ?? {})) {
        const f = over?.f
        if (typeof f !== 'string' || f.trim() === '') continue
        const i = key.indexOf(':')
        if (i < 0) continue
        const col = index.get(key.slice(0, i))
        const row = rowOfRid(sheet, Number(key.slice(i + 1)))
        // A formula whose column or row is gone is not a formula anywhere: it
        // has no position, so it computes nothing and is reported by the
        // validator rather than evaluated against a cell it does not occupy.
        if (col === undefined || row < 0) continue
        out.push({ row, col, src: f })
      }
      return out
    },
  }
}

/** The column names a formula on a dataset sheet may use, id and name alike. */
export function columnVectors(
  sheet: TableSheet,
  computed?: Map<string, Vec> | (() => Map<string, Vec> | undefined),
): Map<string, Vec> {
  const n = sheet.rids.reduce((a, [, c]) => a + c, 0)
  const resolved = typeof computed === 'function' ? computed() : computed
  const out = new Map<string, Vec>()
  const put = (k: string, v: Vec) => { out.set(k, v); out.set(k.toLowerCase(), v) }
  for (const c of sheet.columns) {
    const v = resolved?.get(c.id)
      ?? Array.from({ length: n }, (_, i) => readCell(sheet.data[c.id], i) as Cell)
    put(c.id, v)
    put(c.name, v)
  }
  return out
}

/**
 * A sheet whose cells exist but cannot be addressed — a pivot's numbers come
 * from a spec, not from positions.
 *
 * `#N/A` and not a blank. The sheet is plainly full of numbers on screen, so
 * "there is nothing there" would be a lie, and `=Pivot!B4*12` would report a
 * confident zero. `#N/A` says the value is not available, which is exactly the
 * situation.
 */
export const unaddressableSource = (why: string): CellSource => ({
  rows: 0,
  cols: 0,
  formulaAt: () => undefined,
  valueAt: () => null,
  formulaCells: () => [],
  clipRange: () => null,
  unavailable: why,
})

/**
 * Every sheet of a workbook, under the name a reference reaches it by.
 *
 * This is what turns `recalcWorkbook` from an interface into a feature: hand it
 * the document and cross-sheet references resolve. `computed` supplies a table
 * sheet's already-evaluated column formulas, because this module does not run
 * them — formula.ts's `recalc` does, and doing it again here would be a second
 * answer to the same question.
 *
 * Results come back keyed by SHEET ID, which the document keeps unique, rather
 * than by the name a reference uses to reach it, which it does not.
 */
export function workbookSources(
  doc: { sheets?: Sheet[]; names?: Record<string, DefinedName>; modified?: string },
  computed?: (sheet: TableSheet) => Map<string, Vec> | undefined,
): SheetSource[] {
  // The document's defined names, per sheet, with that sheet's own column
  // names removed — a column wins, see the DEFINED NAMES block in model.ts.
  // Only the column NAMES are read, never their values, so a workbook of
  // hundred-thousand-row datasets pays a set of strings and nothing else.
  const namesFor = (shadow?: ReadonlySet<string>): NameScope =>
    documentNames(doc.names, shadow)
  return (doc.sheets ?? []).map((s): SheetSource => {
    if (s.kind === 'table') {
      const t = s as TableSheet
      // THE CALLER'S CACHE FIRST, THEN OUR OWN, AND ONLY IF ASKED.
      //
      // `computed` exists because the sheet on screen has already been
      // recalculated by whoever is painting it, and running formula.ts's
      // `recalc` over it a second time would be a second answer to one
      // question. But every OTHER dataset in the workbook used to get
      // `undefined`, which meant a calculated column read as its STORED value —
      // usually nothing at all. So `=Sales!C2` into a calculated column
      // answered blank, and `=Sales!C2*1.2` answered a confident 0: the exact
      // error-becomes-a-zero failure this codebase refuses everywhere else.
      //
      // Falling back to a real recalculation closes that, and it is affordable
      // only because `tableCellSource` resolves this LAZILY — a workbook of
      // 100k-row datasets pays nothing for the ones no formula reaches, which
      // is nearly all of them, and pays once for the ones it does.
      const comp = () => computed?.(t) ?? (t.columns.some((c) => c.formula)
        ? recalc(t, doc.modified).values
        : undefined)
      const shadow = new Set<string>()
      for (const c of t.columns) {
        shadow.add(c.id.toLowerCase())
        shadow.add(c.name.toLowerCase())
      }
      return {
        id: t.id,
        name: t.name,
        source: tableCellSource(t, comp),
        vectors: () => columnVectors(t, comp),
        kind: 'dataset',
        names: namesFor(shadow),
      }
    }
    if (s.kind === 'canvas') {
      // A spreadsheet has no columns to shadow anything: nothing is named but
      // the cells, and a cell address can never be a defined name.
      return {
        id: s.id,
        name: s.name,
        source: canvasCellSource(s as CanvasSheet),
        names: namesFor(),
        kind: 'spreadsheet',
      }
    }
    return {
      id: s.id,
      name: s.name,
      source: unaddressableSource(
        `the cells of ${s.kind} sheet "${s.name}" are derived and cannot be referenced by position`,
      ),
    }
  })
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
 *
 * `scope` is how a workbook says WHICH sheet the rows were inserted into, so
 * that the formulas on every OTHER sheet can be rewritten by the same call: a
 * reference is moved only when it points at the sheet that changed shape. With
 * no scope the edit is taken to be on the sheet whose formulas these are, which
 * is what the single-sheet callers have always meant.
 */
export function shiftSheetFormulas(
  formulas: Iterable<[string, string]>,
  axis: 'row' | 'col',
  at: number,
  count: number,
  scope?: ShiftScope,
): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [key, src] of formulas) {
    if (!isFormula(src)) continue
    const next = `=${shiftRefsForInsert(formulaBody(src), axis, at, count, scope)}`
    if (next !== src) out.push([key, next])
  }
  return out
}
