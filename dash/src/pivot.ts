// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Pivot tables — grouped aggregation over the columnar store, and the drill-down
// back to the rows behind a number.
//
// A PIVOT IS A DOCUMENT, NOT A VIEW, and the whole file hangs off that call.
// dash has already drawn this line twice, in opposite directions:
//
//   - SORTING AND FILTERING ARE VIEW STATE (filter.ts:3, store.ts:531). They
//     belong to the reader, they must not dirty the file, and two people looking
//     at one workbook may legitimately have different rows on screen.
//   - HIDING A COLUMN IS DOCUMENT STATE (rowcol.ts:526). It is an EDITORIAL act
//     — the author decided the working column is not part of the story — and two
//     people opening one file have to see the same grid or they are reading
//     different documents.
//
// "Revenue by region by quarter" is the second kind. It is a thing somebody
// BUILT: the fields, the aggregations and the subtotal policy are an argument
// about what the data means, and an argument that evaporated when the reader
// closed the tab would not be worth making. It is also the thing a reader is
// sent — "look at the pivot on sheet 3" has to name something that exists in the
// file. So a pivot is a SHEET (`kind: 'pivot'`), it saves, it travels, and every
// reader of the file sees the same one.
//
// WHAT THE SHEET STORES IS THE SPEC AND NEVER THE NUMBERS. That is chart.ts's
// rule promoted again (chart.ts:5 — "a tile NAMES a sheet and columns"; slides
// learned it the expensive way with `syncLinkedChart`): there is no code path
// here that writes a computed cell into the document. A stored pivot could
// disagree with the sheet beside it, go stale without saying so, and would
// double the file for the privilege. A derived one cannot be wrong about its own
// data — edit a cell and the pivot moves.
//
// The reader's own filters are deliberately NOT applied by default. The pivot
// carries its own `filters` in the spec, because a document that changed shape
// with each reader's grid filter would stop being one thing everybody sees —
// exactly the property that made it a document. `runPivot`'s `rows` option is
// the opt-in for "pivot what I am looking at", and it is the caller's choice.
//
// SEVEN THINGS ARE WRONG IN EVERY NAIVE PIVOT, and every one of them prints a
// number that looks like an answer:
//
//   1. AN EMPTY GROUP THAT READS AS A ZERO. No rows for (South, Q3) is a GAP.
//      Printing 0 there says "South sold nothing in Q3", which is a claim about
//      the world made out of the absence of data. Cells carry `rows`, and a cell
//      with `rows: 0` has `v: null` and renders empty — never `0`, never `—`
//      beside a real zero.
//   2. AN AVERAGE DIVIDED BY THE ROW COUNT. chart.ts:96 already settled it: the
//      divisor is the values PRESENT, not the rows in the group. Twelve rows
//      with four measurements average over four.
//   3. TEXT COERCED TO ZERO. `Number('n/a')` is NaN, `Number('')` is 0, and the
//      convenient `|| 0` turns both into a silent deduction from the sum. This
//      is the bug filter.ts was written around (filter.ts:98) and it is worse in
//      a pivot, because the number is aggregated: nobody can see the row that
//      did it. Non-numeric values are COUNTED (`skipped`) and never summed.
//   4. SUBTOTALS SUMMED FROM CHILDREN. Right for sum and count, WRONG for
//      average (an average of averages weights small groups equally), wrong for
//      median, wrong for count-distinct (distincts do not add — the same
//      customer in two regions counts twice). Every subtotal here is computed
//      from the source rows, not from the cells above it.
//   5. ALPHABETICAL CATEGORIES. The first-seen order is the order the data is
//      in, which is usually the order that means something (a fiscal calendar
//      sorts to Apr, Aug, Dec). chart.ts:79 made this call; this file matches it.
//   6. MATERIALISING THE ROWS. The whole storage argument is 4.8 bytes/cell
//      against 15.9 for array-of-objects (model.ts:17). A pivot that starts by
//      building an array of row objects spends the format's entire advantage in
//      the first ten lines. Nothing here allocates per row: grouping runs on
//      dictionary CODES, and a dictionary-encoded numeric column is parsed once
//      per DISTINCT VALUE rather than once per row.
//   7. A DRILL-DOWN THAT DISAGREES WITH ITS OWN CELL. If the click re-derives
//      the group membership by some other route — re-parsing labels, matching
//      formatted strings — it will eventually return a different set of rows
//      than the ones that made the number. `drillDown` matches on the same
//      integer code planes the aggregation walked, so the two cannot drift.
//
// The engine half is pure and runs in node; the DOM half is at the bottom.

import './pivot.css'
import type { Column, ColumnData, Sheet, TableSheet } from './model.ts'
import { readCell } from './store.ts'
import { buildOrder, isBlank, type ColumnFilter, type Get } from './filter.ts'
import { formatValue } from './format.ts'
import { t } from './i18n.ts'

// --- the spec --------------------------------------------------------------

export type AggFn = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'median' | 'countDistinct'

export const AGG_FNS: AggFn[] = ['sum', 'avg', 'count', 'min', 'max', 'median', 'countDistinct']

/** English labels. Localised for DISPLAY only — the stored `fn` stays a model
 *  word, which is the rule `select()` follows across the suite (PLATFORM §8). */
export const AGG_LABEL: Record<AggFn, string> = {
  sum: 'Sum', avg: 'Average', count: 'Count', min: 'Min', max: 'Max',
  median: 'Median', countDistinct: 'Distinct',
}

export interface PivotValue {
  /** source column id */
  col: string
  fn: AggFn
  /** display name override; absent means "Sum of Revenue" is generated */
  as?: string
  [extra: string]: unknown
}

/**
 * What the author built. This is the whole of what a pivot sheet stores.
 *
 * Fields are COLUMN IDS, never names and never positions — the same identity
 * every formula, override and tile keys off (model.ts:61), so renaming a column
 * or dragging it somewhere else never breaks a pivot.
 */
export interface PivotSpec {
  /** id of the source TABLE sheet */
  from: string
  /** row fields, outermost first */
  rows: string[]
  /** column fields, outermost first */
  cols: string[]
  values: PivotValue[]
  /** the pivot's OWN filters — document state, unlike the grid's (filter.ts:3) */
  filters?: ColumnFilter[]
  /** default true */
  subtotals?: boolean
  /** default true */
  grandTotals?: boolean
  /**
   * Include rows whose grouping field is blank, as a "(blank)" group. Default
   * true, and the default matters: switching it off DROPS THE ROW ENTIRELY
   * rather than merely hiding its group, because a grand total that no longer
   * equals the sum of what is on screen is a worse lie than a "(blank)" label.
   */
  blanks?: boolean
  [extra: string]: unknown
}

/**
 * A pivot sheet.
 *
 * NOT YET A MEMBER OF `model.ts`'s `Sheet` UNION, and until it is, `parseDoc`
 * rewrites `kind` to `'table'` for every sheet that is not `'canvas'`
 * (model.ts:529) — so a saved pivot sheet comes back from a round trip
 * kind-coerced, with empty `rids`/`columns`/`data` bolted on. That is why
 * `isPivotSheet` below keys off the PRESENCE OF A WELL-FORMED `pivot` FIELD and
 * not off `kind`: unknown top-level sheet fields survive the parse (the spread
 * at model.ts:530 is the additivity promise of PLATFORM §3), so the spec makes
 * it through intact and the pivot still opens. When model.ts adopts the kind,
 * nothing here changes.
 */
export interface PivotSheet {
  id: string
  name: string
  kind: 'pivot'
  pivot: PivotSpec
  [extra: string]: unknown
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/**
 * Read a spec out of whatever is actually in the file, defensively — the same
 * posture `readFrozen` takes (rowcol.ts:489). This is an additive field, so an
 * older build, a hand edit or a newer one can put anything there, and anything
 * unreadable has to mean "not a pivot" rather than throwing on open.
 *
 * `from` is required and the field lists are not: a pivot with no rows, no
 * columns and one value is the legitimate degenerate case (one grand total),
 * and it must open.
 */
export function readPivotSpec(sheet: unknown): PivotSpec | null {
  if (!isObj(sheet)) return null
  const p = sheet.pivot
  if (!isObj(p)) return null
  if (typeof p.from !== 'string' || !p.from) return null
  const values = Array.isArray(p.values)
    ? p.values.filter(isObj)
      .filter((v) => typeof v.col === 'string')
      .map((v) => ({
        ...v,
        col: v.col as string,
        // an unrecognised fn is NOT silently a sum: it is preserved for a build
        // that knows it, and `runPivot` reports it rather than answering
        fn: v.fn as AggFn,
      }))
    : []
  return {
    ...p,
    from: p.from,
    rows: strings(p.rows),
    cols: strings(p.cols),
    values,
  }
}

export function isPivotSheet(s: Sheet | PivotSheet | unknown): s is PivotSheet {
  return readPivotSpec(s) !== null
}

// --- planes ----------------------------------------------------------------
//
// A "plane" is one column, prepared for one job, WITHOUT ever building a row
// object. Two jobs, two shapes:
//
//   GROUPING wants an integer per row, because grouping is a tree walk keyed by
//   that integer. For a dictionary column the integer already exists — `idx` IS
//   the code vector — so the whole preparation is an O(distinct-values) pass to
//   fold codes that mean the same thing onto one representative. Zero string
//   work per row, which is the point of the encoding.
//
//   AGGREGATING wants a number per row, and here the dictionary pays twice: a
//   dict column of 100k rows over 40 distinct values is parsed FORTY TIMES, not
//   a hundred thousand. That parse is the expensive part (`asNumber` runs a
//   regex), so this is the difference between a pivot that lands in a frame and
//   one that does not.

/** Blank has no code of its own in the source encoding, so it gets one here. */
const BLANK = -1

interface GroupPlane {
  /** code per row; BLANK for an empty cell */
  code: Int32Array
  /** the value as it appears in the column, for labelling */
  orig: (row: number) => unknown
}

interface ValuePlane {
  /** the number in this cell, or null when there is not one */
  num: (row: number) => number | null
  /** is there anything here at all? (`count` counts these) */
  present: (row: number) => boolean
  /** canonical identity for `countDistinct`; null when blank */
  key: (row: number) => string | null
}

/**
 * The digit shape a string must have to be READ as a number. Copied verbatim
 * from filter.ts:112 rather than imported, because filter.ts does not export it
 * — and copied rather than loosened, which matters: `Number('')` is 0 (a blank
 * becomes a zero), `Number('2026-01-15')` is NaN (an ISO date stays text, which
 * is what makes it sort chronologically), and "50%" is refused because a percent
 * column stores the FRACTION (import.ts:281), so reading it as 50 would be wrong
 * by a factor of a hundred in every cell.
 *
 * ONE DELIBERATE DIVERGENCE: a boolean reads as 1/0 here and as null there. A
 * bool column IS a measure in a pivot — "how many are flagged" is the obvious
 * question to ask of one — and `count` cannot answer it, because `false` is a
 * value that is present. filter.ts has no such use (it compares, it does not
 * total) and its `rankable` already treats booleans as rankable, so the two are
 * consistent in spirit. Every OTHER rule below is filter.ts's, unchanged.
 *
 * IF filter.ts EVER EXPORTS `asNumber`, TAKE IT AND KEEP ONLY THE BOOL CASE.
 * Two copies of one rule is how a status bar and a pivot come to disagree about
 * what a number is.
 */
const NUMERIC = /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)$/

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (s === '' || !NUMERIC.test(s)) return null
  const n = Number(s.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * The one canonical key, matching filter.ts:146. Two values collapse into one
 * pivot group exactly when they would collapse into one checkbox in the filter
 * menu — so a reader who ticks "North" in the filter and sees "North" in the
 * pivot is looking at the same set of rows both times. Numbers canonicalise
 * through their value (10, "10" and " 10.0 " are one group); text
 * canonicalises case- and whitespace-insensitively.
 */
function matchKey(v: unknown): string {
  if (isBlank(v)) return ' blank'
  const n = asNumber(v)
  return n === null ? `t:${String(v).trim().toLowerCase()}` : `n:${n}`
}

/**
 * `pack` is an opaque archive encoding and `readCell` answers null for every row
 * of one (store.ts:196). Pivoting through that would silently produce ONE
 * "(blank)" group holding the whole sheet and a grand total of nothing — a
 * wrong answer with no symptom. rowcol.ts refuses packed columns for structural
 * edits for the same reason; this refuses them for reads.
 */
function refusePacked(d: ColumnData | undefined, col: string): void {
  if (d && d.enc === 'pack') {
    throw new Error(`column "${col}" is packed and cannot be pivoted — promote it to raw first`)
  }
}

function groupPlane(d: ColumnData | undefined, computed: unknown[] | undefined, n: number, col: string): GroupPlane {
  const code = new Int32Array(n)
  if (!computed && d && d.enc === 'dict') {
    refusePacked(d, col)
    // O(distinct), not O(rows): fold every dictionary entry onto the first entry
    // sharing its canonical key, so the row loop below is an array index and a
    // null test. This is the entire reason the format is dictionary-encoded.
    const rep = new Int32Array(d.dict.length)
    const seen = new Map<string, number>()
    for (let k = 0; k < d.dict.length; k++) {
      const s = d.dict[k]
      if (isBlank(s)) { rep[k] = BLANK; continue }
      const mk = matchKey(s)
      const first = seen.get(mk)
      if (first === undefined) { seen.set(mk, k); rep[k] = k } else rep[k] = first
    }
    for (let i = 0; i < n; i++) {
      const k = d.idx[i]
      code[i] = k == null ? BLANK : (rep[k] ?? BLANK)
    }
    return { code, orig: (row) => readCell(d, row) }
  }

  refusePacked(d, col)
  // `raw` and computed columns have no dictionary to lean on, so this interns
  // one — the same cost `buildOrder`'s column cache already pays per sort.
  const read = computed
    ? (row: number) => computed[row] ?? null
    : (row: number) => readCell(d, row)
  const seen = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    const v = read(i)
    if (isBlank(v)) { code[i] = BLANK; continue }
    const mk = matchKey(v)
    let c = seen.get(mk)
    if (c === undefined) { c = seen.size; seen.set(mk, c) }
    code[i] = c
  }
  return { code, orig: read }
}

function valuePlane(d: ColumnData | undefined, computed: unknown[] | undefined, col: string): ValuePlane {
  if (!computed && d && d.enc === 'dict') {
    refusePacked(d, col)
    const nums = d.dict.map(asNumber)
    const pres = d.dict.map((s) => !isBlank(s))
    const keys = d.dict.map((s) => (isBlank(s) ? null : matchKey(s)))
    const at = (row: number): number | null => {
      const k = d.idx[row]
      return k == null ? null : k
    }
    return {
      num: (row) => { const k = at(row); return k == null ? null : (nums[k] ?? null) },
      present: (row) => { const k = at(row); return k == null ? false : (pres[k] ?? false) },
      key: (row) => { const k = at(row); return k == null ? null : (keys[k] ?? null) },
    }
  }
  refusePacked(d, col)
  const read = computed
    ? (row: number) => computed[row] ?? null
    : (row: number) => readCell(d, row)
  return {
    num: (row) => asNumber(read(row)),
    present: (row) => !isBlank(read(row)),
    key: (row) => { const v = read(row); return isBlank(v) ? null : matchKey(v) },
  }
}

// --- accumulators ----------------------------------------------------------

interface Acc {
  /** non-blank values seen — what `count` reports */
  present: number
  /** how many of those were numbers — the DIVISOR of `avg` (chart.ts:96) */
  numeric: number
  /** present values that are not numbers. Recorded, never coerced to zero. */
  skipped: number
  sum: number
  min: number | null
  max: number | null
  /** median is not a streaming aggregate; allocated only when one is asked for */
  vals: number[] | null
  /** distinct is not a streaming aggregate either */
  keys: Set<string> | null
}

/** A (row group × column group) intersection. ABSENT means the pair never
 *  occurred, which is a gap — the reason the map is sparse rather than a dense
 *  matrix filled with zeroes. */
interface Bucket {
  rows: number
  accs: Acc[]
}

const newAcc = (fn: AggFn): Acc => ({
  present: 0, numeric: 0, skipped: 0, sum: 0, min: null, max: null,
  vals: fn === 'median' ? [] : null,
  keys: fn === 'countDistinct' ? new Set<string>() : null,
})

interface Node {
  id: number
  depth: number
  code: number
  label: unknown
  kids: Map<number, Node>
  /** first-seen order, which is the order the data is in (chart.ts:79) */
  order: Node[]
  parent: Node | null
  /** column-node id → bucket. Only ROW nodes use this. */
  cells: Map<number, Bucket>
}

// --- the result ------------------------------------------------------------

export interface PivotCell {
  /**
   * NULL IS NOT ZERO. `rows === 0` means the combination does not occur — a gap.
   * `rows > 0` with `v === null` means the rows are there and hold nothing this
   * function can answer (a text column asked for a sum). Both render empty; a
   * real zero renders "0".
   */
  v: number | null
  /** source rows behind this cell — the number the drill-down will show */
  rows: number
  /** non-blank values among them */
  present: number
  /** how many of those were numbers */
  numeric: number
  /** present values that could not be read as numbers, and were NOT summed */
  skipped: number
}

export type GroupKind = 'leaf' | 'subtotal' | 'grand'

export interface PivotGroup {
  /** one code per level pinned, root-relative. Shorter than the field list for
   *  a subtotal; empty for the grand total. */
  codes: number[]
  /** first-seen ORIGINAL values, one per pinned level — what the reader sees */
  path: unknown[]
  kind: GroupKind
}

export interface PivotColumn extends PivotGroup {
  value: PivotValue
  /** index into `spec.values` */
  vi: number
}

export interface PivotRow extends PivotGroup {
  /** one per entry in `columns`, same order */
  cells: PivotCell[]
}

export interface PivotHeaderCell {
  label: unknown
  span: number
  kind: GroupKind
  /** true for the generated "… total" caption above a subtotal column */
  total: boolean
}

/**
 * Something the reader has to be told, rather than silently absorbed. The model
 * takes this line everywhere (a mistyped value is `Column.failed`, an unknown
 * step marks its descendants unresolved) and the reason is always the same: a
 * pivot that quietly dropped a field still prints a full set of numbers.
 */
export interface PivotFinding {
  kind: 'missing-column' | 'unknown-agg' | 'no-values' | 'empty-source'
  detail: string
}

export interface PivotResult {
  spec: PivotSpec
  /** the fields that SURVIVED — a field naming a deleted column is dropped and
   *  reported, never grouped as one big blank */
  rowFields: string[]
  colFields: string[]
  values: PivotValue[]
  /** one row per column FIELD, plus a value-name row when it is needed */
  header: PivotHeaderCell[][]
  columns: PivotColumn[]
  rows: PivotRow[]
  /**
   * Source rows that actually reached an accumulator — the denominator of
   * everything on screen, and NOT simply the count the filters admitted. With
   * `blanks: false` those two differ, and reporting the larger one would put a
   * footer under the table that disagrees with the grand total directly above
   * it. Invariant: with any row field, this equals the grand-total cell's `rows`.
   */
  scanned: number
  findings: PivotFinding[]
  /** retained so a drill-down cannot disagree with the number it explains */
  source: PivotScan
}

/** The prepared source, kept on the result so `drillDown` re-uses the very code
 *  planes the aggregation walked instead of re-deriving membership some other
 *  way (see failure 7 in the header). */
export interface PivotScan {
  sheetId: string
  /** the source row indices the filters admitted, in sheet order */
  rows: number[]
  rowPlanes: GroupPlane[]
  colPlanes: GroupPlane[]
}

// --- the engine ------------------------------------------------------------

export interface PivotOpts {
  /** formula columns the grid just recomputed, as chart.ts takes them: a pivot
   *  over a derived column must show the numbers on screen, not the empty
   *  storage underneath them */
  computed?: Map<string, unknown[]>
  /**
   * Restrict to these source row indices — the grid's order vector, if the
   * caller wants "pivot what I am looking at". OFF by default and deliberately:
   * a document whose numbers changed with each reader's grid filter would stop
   * being one thing everyone sees, which is the property that made it a
   * document in the first place (see the header).
   */
  rows?: number[]
}

const rowsOf = (sheet: TableSheet): number => sheet.rids.reduce((n, [, c]) => n + c, 0)

const KNOWN_AGG = new Set<string>(AGG_FNS)

/**
 * Run a pivot.
 *
 * Cost is one pass over the admitted rows, touching (rowDepth + 1) ×
 * (colDepth + 1) buckets each — nine map operations per row for the common
 * two-by-two pivot. No row object is ever built.
 *
 * Measured: 200,000 rows, two row fields × one column field × two value fields
 * (dictionary-encoded groups, raw measure with 2% text in it) — 74 ms to build,
 * 18 MB heap, 2 ms to drill 2,062 rows out of a grand-total cell. A click, not
 * a frame, which is the trade filter.ts:352 already made for sorting.
 */
export function runPivot(sheet: TableSheet, spec: PivotSpec, opts: PivotOpts = {}): PivotResult {
  const n = rowsOf(sheet)
  const findings: PivotFinding[] = []
  const has = (id: string): boolean =>
    sheet.columns.some((c) => c.id === id) || opts.computed?.has(id) === true
  const nameOf = (id: string): string => sheet.columns.find((c) => c.id === id)?.name ?? id

  // A field naming a column that is gone is DROPPED and reported. Keeping it
  // would group every row under one "(blank)", which looks like a pivot and is
  // a pivot of nothing; grouping silently by the remaining fields would change
  // every number on screen without saying so.
  const keep = (ids: string[], where: string): string[] => ids.filter((id) => {
    if (has(id)) return true
    findings.push({
      kind: 'missing-column',
      detail: `the ${where} field "${id}" names a column this sheet no longer has, so it is not being grouped by`,
    })
    return false
  })

  const rowFields = keep(spec.rows, 'row')
  const colFields = keep(spec.cols, 'column')
  const values = spec.values.filter((v) => {
    if (!has(v.col)) {
      findings.push({
        kind: 'missing-column',
        detail: `the value "${v.col}" names a column this sheet no longer has`,
      })
      return false
    }
    if (!KNOWN_AGG.has(v.fn)) {
      // Preserved in the document (readPivotSpec spreads it through) and refused
      // HERE, because inventing an answer for a function this build cannot
      // perform is the "unresolved" failure model.ts:174 exists to prevent.
      findings.push({
        kind: 'unknown-agg',
        detail: `"${String(v.fn)}" is not an aggregation this build knows, so ${nameOf(v.col)} is not summarised`,
      })
      return false
    }
    return true
  })
  if (!values.length) {
    findings.push({ kind: 'no-values', detail: 'this pivot has nothing to summarise yet' })
  }
  if (!n) findings.push({ kind: 'empty-source', detail: 'the source sheet has no rows' })

  const col = (id: string): ColumnData | undefined => sheet.data[id]
  const comp = (id: string): unknown[] | undefined => opts.computed?.get(id)

  const rowPlanes = rowFields.map((id) => groupPlane(col(id), comp(id), n, id))
  const colPlanes = colFields.map((id) => groupPlane(col(id), comp(id), n, id))
  const valPlanes = values.map((v) => valuePlane(col(v.col), comp(v.col), v.col))

  // The pivot's OWN filters, through filter.ts — one implementation of "less
  // than 10", not two. `topN` works here too, and ranks the whole source.
  let rows: number[]
  if (spec.filters?.length) {
    const get: Get = (c, row) => {
      const cv = comp(c)
      return cv ? cv[row] ?? null : readCell(col(c), row)
    }
    rows = buildOrder(n, get, spec.filters, [])
  } else {
    rows = Array.from({ length: n }, (_, i) => i)
  }
  if (opts.rows) {
    const allowed = new Set(opts.rows)
    rows = rows.filter((r) => allowed.has(r))
  }

  let nextId = 0
  const mkNode = (depth: number, code: number, label: unknown, parent: Node | null): Node => ({
    id: nextId++, depth, code, label, kids: new Map(), order: [], parent, cells: new Map(),
  })
  const rowRoot = mkNode(0, BLANK, null, null)
  const colRoot = mkNode(0, BLANK, null, null)

  const descend = (node: Node, code: number, label: unknown): Node => {
    let k = node.kids.get(code)
    if (!k) {
      // The label is captured HERE, at first sight, so it is the original as it
      // appears in the first row of the group — matching the order the groups
      // come out in. Reading it off the dictionary instead would show whichever
      // spelling happened to be interned first, which is not always the same.
      k = mkNode(node.depth + 1, code, label, node)
      node.kids.set(code, k)
      node.order.push(k)
    }
    return k
  }

  const includeBlanks = spec.blanks !== false
  const rowChain: Node[] = new Array(rowFields.length + 1)
  const colChain: Node[] = new Array(colFields.length + 1)
  let scanned = 0

  scan: for (const r of rows) {
    // EXCLUDING BLANKS EXCLUDES THE ROW, not merely its group. Hiding the group
    // while still feeding its rows into the totals leaves a grand total that
    // does not equal the sum of what is on screen, and a reader who adds the
    // column up by hand is right and the pivot is wrong.
    if (!includeBlanks) {
      for (const p of rowPlanes) if (p.code[r] === BLANK) continue scan
      for (const p of colPlanes) if (p.code[r] === BLANK) continue scan
    }
    scanned++
    rowChain[0] = rowRoot
    for (let l = 0; l < rowPlanes.length; l++) {
      const c = rowPlanes[l].code[r]
      rowChain[l + 1] = descend(rowChain[l], c, c === BLANK ? null : rowPlanes[l].orig(r))
    }
    colChain[0] = colRoot
    for (let l = 0; l < colPlanes.length; l++) {
      const c = colPlanes[l].code[r]
      colChain[l + 1] = descend(colChain[l], c, c === BLANK ? null : colPlanes[l].orig(r))
    }

    // EVERY ancestor pair, not just the leaf pair. This is what makes subtotals
    // computed rather than summed (failure 4): the (region, ·) bucket sees the
    // same rows the leaves do, so its average divides by its own values and its
    // distinct count is a distinct count.
    for (const rn of rowChain) {
      for (const cn of colChain) {
        let b = rn.cells.get(cn.id)
        if (!b) { b = { rows: 0, accs: values.map((v) => newAcc(v.fn)) }; rn.cells.set(cn.id, b) }
        b.rows++
        for (let vi = 0; vi < valPlanes.length; vi++) {
          const p = valPlanes[vi]
          if (!p.present(r)) continue
          const a = b.accs[vi]
          a.present++
          if (a.keys) { const k = p.key(r); if (k !== null) a.keys.add(k) }
          const num = p.num(r)
          if (num === null) { a.skipped++; continue }
          a.numeric++
          a.sum += num
          if (a.min === null || num < a.min) a.min = num
          if (a.max === null || num > a.max) a.max = num
          if (a.vals) a.vals.push(num)
        }
      }
    }
  }

  const subtotals = spec.subtotals !== false
  const grand = spec.grandTotals !== false
  const rowGroups = flatten(rowRoot, rowFields.length, subtotals, grand)
  const colGroups = flatten(colRoot, colFields.length, subtotals, grand)

  const columns: PivotColumn[] = []
  const colNodes: Node[] = []
  for (const g of colGroups) {
    for (let vi = 0; vi < values.length; vi++) {
      columns.push({ codes: g.codes, path: g.path, kind: g.kind, value: values[vi], vi })
      colNodes.push(g.node)
    }
  }

  const out: PivotRow[] = rowGroups.map((g) => ({
    codes: g.codes,
    path: g.path,
    kind: g.kind,
    cells: columns.map((c, i) => finish(g.node.cells.get(colNodes[i].id), c.value.fn, c.vi)),
  }))

  return {
    spec,
    rowFields,
    colFields,
    values,
    header: buildHeader(columns, colFields.length, values, nameOf),
    columns,
    rows: out,
    scanned,
    findings,
    source: { sheetId: sheet.id, rows, rowPlanes, colPlanes },
  }
}

interface FlatGroup extends PivotGroup { node: Node }

/**
 * Depth-first, children before their own subtotal, grand total last — Excel's
 * outline order, and the only one where a subtotal reads as summarising the
 * lines above it.
 *
 * A node at full depth is a LEAF even if `depth` is 0: a pivot with no column
 * fields has exactly one column group, which is the root, and it is a leaf
 * rather than a grand total. Emitting a grand total there as well would print
 * the same numbers twice under two different captions.
 */
function flatten(root: Node, depth: number, subtotals: boolean, grand: boolean): FlatGroup[] {
  const out: FlatGroup[] = []
  const codes: number[] = []
  const path: unknown[] = []
  const walk = (node: Node): void => {
    if (node.depth === depth) {
      out.push({ codes: codes.slice(), path: path.slice(), kind: 'leaf', node })
      return
    }
    for (const k of node.order) {
      codes.push(k.code)
      path.push(k.label)
      walk(k)
      codes.pop()
      path.pop()
    }
    // A node with one child gets a subtotal identical to that child's row. Excel
    // prints it anyway and so does this: suppressing it makes the outline depth
    // depend on the data, so two regions of the same report indent differently.
    if (node.depth > 0 && subtotals) {
      out.push({ codes: codes.slice(), path: path.slice(), kind: 'subtotal', node })
    }
  }
  walk(root)
  if (depth > 0 && grand) out.push({ codes: [], path: [], kind: 'grand', node: root })
  return out
}

/** Shared and FROZEN: it is returned by reference for every gap in the table,
 *  so a caller that decorated it in place would decorate all of them. */
const EMPTY_CELL: PivotCell = Object.freeze({ v: null, rows: 0, present: 0, numeric: 0, skipped: 0 })

/**
 * One accumulator into one cell.
 *
 * `count` and `countDistinct` return 0 when the group HAS rows and none of them
 * carry a value — that zero is an answer ("nothing was recorded here"), and it
 * is distinguishable from the gap because the gap has `rows: 0` and no bucket at
 * all. Every other function returns null instead of 0, for filter.ts's reason
 * (filter.ts:498): a sum of nothing printed as `0` reads as "these add up to
 * nothing", `Math.min()` of an empty list is Infinity, and 0/0 is NaN.
 */
function finish(b: Bucket | undefined, fn: AggFn, vi: number): PivotCell {
  if (!b) return EMPTY_CELL
  const a = b.accs[vi]
  const base = { rows: b.rows, present: a.present, numeric: a.numeric, skipped: a.skipped }
  switch (fn) {
    case 'count': return { ...base, v: a.present }
    case 'countDistinct': return { ...base, v: a.keys ? a.keys.size : 0 }
    case 'sum': return { ...base, v: a.numeric ? a.sum : null }
    case 'avg': return { ...base, v: a.numeric ? a.sum / a.numeric : null }
    case 'min': return { ...base, v: a.min }
    case 'max': return { ...base, v: a.max }
    case 'median': return { ...base, v: a.numeric && a.vals ? median(a.vals) : null }
  }
}

/** Numeric sort, then the middle — `Array.sort`'s default is LEXICAL, which
 *  would put 100 before 9 and hand back a median that is not one. */
function median(vals: number[]): number {
  const s = vals.slice().sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * The column header, one row per column field plus a value row.
 *
 * The value row exists when there is more than one value field — or when there
 * are no column fields at all, because otherwise the table would have a header
 * with nothing in it and the reader could not tell a sum from a count.
 */
function buildHeader(
  columns: PivotColumn[], depth: number, values: PivotValue[], nameOf: (id: string) => string,
): PivotHeaderCell[][] {
  const out: PivotHeaderCell[][] = []
  for (let l = 0; l < depth; l++) {
    const row: PivotHeaderCell[] = []
    let key: string | null = null
    for (const c of columns) {
      // A subtotal column pins fewer levels than the header is deep, so past
      // its own depth it carries the "… total" caption. Its identity at level
      // `l` is just its pinned prefix — a subtotal DOES belong under its
      // parent's caption at the levels above it, and it can never merge with a
      // sibling leaf at the level where the two differ, because one prefix is
      // then a strict prefix of the other. An earlier draft also appended a
      // total marker here; it turned out to change no output for any shape,
      // and dead defence that nothing can distinguish is how a file rots.
      //
      // SEPARATED, not concatenated: codes are integers, so `[1,2]` and `[12]`
      // join to the same string without a separator, and two unrelated groups
      // sharing a header key would merge into one cell whose colspan then lies
      // about what is under it. Codes are handed out in first-seen order, so
      // adjacent groups get adjacent numbers and the collision is probably not
      // reachable today — but this is a comma, and the alternative is re-running
      // that reachability argument every time the coding changes.
      const k = c.codes.slice(0, Math.min(l + 1, c.codes.length)).join(',')
      if (k === key && row.length) { row[row.length - 1].span++; continue }
      key = k
      const total = l >= c.codes.length
      row.push({
        label: total
          ? (c.kind === 'grand' ? t('Grand total') : totalCaption(c.path))
          : c.path[l],
        span: 1,
        kind: c.kind,
        total,
      })
    }
    out.push(row)
  }
  if (values.length > 1 || depth === 0) {
    out.push(columns.map((c) => ({
      label: valueName(c.value, nameOf),
      span: 1,
      kind: c.kind,
      total: false,
    })))
  }
  return out
}

const totalCaption = (path: unknown[]): string =>
  t('{name} total').replace('{name}', label(path[path.length - 1]))

/** The caption for a value field. Generated rather than stored, so renaming the
 *  source column renames the pivot's header with it. */
export const valueName = (v: PivotValue, nameOf: (id: string) => string): string =>
  v.as ?? `${t(AGG_LABEL[v.fn] ?? String(v.fn))} ${t('of')} ${nameOf(v.col)}`

/** A group label for display. A blank group is "(blank)" and NOT an empty
 *  string: an unlabelled row in the middle of an outline reads as a rendering
 *  bug, and the reader cannot tell it from the subtotal above it. */
export const label = (v: unknown): string =>
  isBlank(v) ? t('(blank)') : String(v)

// --- drill-down ------------------------------------------------------------

export interface Drill {
  /** source row indices, in sheet order */
  rows: number[]
  /** how many there are in total, when `rows` was capped */
  total: number
  truncated: boolean
}

/**
 * The rows behind one number.
 *
 * This is the thing dash can do that Excel cannot do honestly: the source rows
 * are in the same file, so "why is this 4,812?" is a click rather than an export
 * and a VLOOKUP. Excel's own drill-down materialises a COPY of the rows onto a
 * new sheet — a snapshot that is wrong the moment anything upstream changes, and
 * that quietly doubles the workbook. This returns indices into the live sheet.
 *
 * MATCHED ON THE CODE PLANES, not on labels and not on formatted text. Anything
 * that re-derives group membership by a second route will eventually disagree
 * with the aggregation that produced the number — the rig checks that summing a
 * drill-down reproduces its own cell, which is the check that would catch it.
 *
 * O(admitted rows) per click, with no state kept per cell. At 100k rows that is
 * a few milliseconds: a click, not a frame — the same trade filter.ts:352 makes.
 */
export function drillDown(
  res: PivotResult, rowIndex: number, colIndex: number, cap = 500,
): Drill {
  const r = res.rows[rowIndex]
  const c = res.columns[colIndex]
  if (!r || !c) return { rows: [], total: 0, truncated: false }
  const { rows, rowPlanes, colPlanes } = res.source
  const includeBlanks = res.spec.blanks !== false
  const out: number[] = []
  let total = 0
  scan: for (const i of rows) {
    if (!includeBlanks) {
      for (const p of rowPlanes) if (p.code[i] === BLANK) continue scan
      for (const p of colPlanes) if (p.code[i] === BLANK) continue scan
    }
    for (let l = 0; l < r.codes.length; l++) if (rowPlanes[l].code[i] !== r.codes[l]) continue scan
    for (let l = 0; l < c.codes.length; l++) if (colPlanes[l].code[i] !== c.codes[l]) continue scan
    total++
    if (out.length < cap) out.push(i)
  }
  return { rows: out, total, truncated: total > out.length }
}

// --- authoring -------------------------------------------------------------

/**
 * A first pivot that takes no configuration, the way `defaultBinding`
 * (chart.ts:154) gives the first chart one. The first low-cardinality text
 * column becomes the rows, the second becomes the columns, and the first
 * magnitude column is summed.
 *
 * Returns null rather than an empty pivot when the sheet cannot support one:
 * an empty pivot is indistinguishable from a broken one.
 */
export function defaultPivot(sheet: TableSheet): PivotSpec | null {
  const n = rowsOf(sheet)
  const cat = sheet.columns.filter((c) => c.type === 'text' || c.type === 'enum' || c.type === 'bool')
  // A near-unique column (an id, a note) makes one group per row, which is the
  // source table with extra lines. Cardinality is measured off the DICTIONARY
  // where there is one — free, and the reason the encoding is worth having.
  const wide = (c: Column): boolean => {
    const d = sheet.data[c.id]
    const distinct = d && d.enc === 'dict' ? d.dict.length : n
    // The floor keeps a small sheet groupable at all — at eight rows, eight
    // groups is still a table you can read, and refusing it would leave a new
    // workbook with no default pivot for no reason a user could see.
    return n >= 8 && distinct > Math.max(8, n / 2)
  }
  const usable = cat.filter((c) => !wide(c))
  const nums = sheet.columns.filter((c) => c.type === 'number' || c.type === 'money' || c.type === 'percent')
  if (!usable.length || !nums.length) return null
  return {
    from: sheet.id,
    rows: [usable[0].id],
    cols: usable[1] ? [usable[1].id] : [],
    values: [{ col: nums[0].id, fn: 'sum' }],
  }
}

/**
 * Mint a pivot sheet.
 *
 * NOT A PATCH FACTORY, unlike every other authoring helper in this codebase
 * (rowcol.ts:5), and not by choice: `Patch` reaches cells, columns, sheet props
 * and `doc.title` — never the sheet LIST (store.ts:55). panels.ts hit the same
 * wall and routes `addSheet` through `replaceDoc`, which clears the undo stack.
 * This returns the object; the call site pushes it and calls `replaceDoc`, and
 * adding a pivot is therefore not undoable. See the report — an `addSheet` patch
 * op is the hook this file wants.
 */
export function newPivotSheet(id: string, name: string, spec: PivotSpec): PivotSheet {
  return { id, name, kind: 'pivot', pivot: spec }
}

// --- rendering -------------------------------------------------------------
//
// One table, drawn whole. There is no virtualisation here and that is a
// deliberate limit rather than an oversight: a pivot with more rows than fit on
// screen has failed as a pivot — it is a summary, and a summary you have to
// scroll for a minute is the source table wearing a hat. The renderer caps and
// SAYS SO instead of quietly drawing the first thousand.

/** Past this a pivot has stopped summarising. Rendered, then capped with a note. */
export const PIVOT_ROW_CAP = 2000

export interface PivotViewOpts {
  /** the source sheet, for column names, number formats and the drill-down table */
  sheet: TableSheet
  /** formula columns, as `runPivot` takes them */
  computed?: Map<string, unknown[]>
  /** clicked a cell — the host may take over instead of the built-in drawer */
  onDrill?: (drill: Drill, row: PivotRow, col: PivotColumn) => void
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/**
 * Format an aggregated number.
 *
 * A COUNT IS NOT MONEY. Counting a currency column and printing "$14.00" for
 * fourteen rows is the kind of wrong that a reader believes, so counts take a
 * plain integer format and everything else inherits the source column's — an
 * average of a money column is money, a sum of a percent column is a percent.
 */
function formatAgg(v: number | null, fn: AggFn, source: Column | undefined): string {
  if (v === null) return ''
  if (fn === 'count' || fn === 'countDistinct') {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(v)
  }
  return formatValue(v, source ?? { type: 'number' })
}

/**
 * Draw a pivot into a host element. Returns a teardown, as `renderChart` does.
 *
 * Re-renders whole. The tables here are small by construction (see the cap
 * above), and a diffing renderer would be a lot of machinery guarding a repaint
 * that costs under a millisecond.
 */
export function mountPivot(host: HTMLElement, res: PivotResult, opts: PivotViewOpts): () => void {
  const { sheet } = opts
  const colOf = (id: string): Column | undefined => sheet.columns.find((c) => c.id === id)
  const nameOf = (id: string): string => colOf(id)?.name ?? id

  host.textContent = ''
  const wrap = el('div', 'dxp')

  if (res.findings.length) {
    const box = el('div', 'dxp-findings')
    for (const f of res.findings) box.append(el('div', 'dxp-finding', f.detail))
    wrap.append(box)
  }

  if (!res.values.length) {
    wrap.append(el('p', 'dxp-empty', t('Add a value field to summarise.')))
    host.append(wrap)
    return () => { host.textContent = '' }
  }

  const scroll = el('div', 'dxp-scroll')
  const table = el('table', 'dxp-table')
  const thead = el('thead')
  const rowSpan = res.header.length || 1

  // The row-field captions sit in the top-left corner block, spanning every
  // header row — the one place in the table where the ROW axis gets named at
  // all. Without it a two-level pivot is two columns of words with no clue
  // which is which.
  const corner = el('th', 'dxp-corner')
  corner.rowSpan = rowSpan
  corner.colSpan = Math.max(1, res.rowFields.length)
  corner.textContent = res.rowFields.map(nameOf).join(' · ')

  res.header.forEach((hrow, i) => {
    const tr = el('tr')
    if (i === 0) tr.append(corner)
    for (const cell of hrow) {
      const th = el('th', `dxp-h dxp-${cell.kind}${cell.total ? ' dxp-total' : ''}`)
      th.colSpan = cell.span
      th.textContent = cell.total ? String(cell.label) : label(cell.label)
      tr.append(th)
    }
    thead.append(tr)
  })
  if (!res.header.length) {
    const tr = el('tr')
    tr.append(corner)
    thead.append(tr)
  }
  table.append(thead)

  const tbody = el('tbody')
  const shown = Math.min(res.rows.length, PIVOT_ROW_CAP)
  for (let ri = 0; ri < shown; ri++) {
    const row = res.rows[ri]
    const tr = el('tr', `dxp-r dxp-${row.kind}`)

    // Row headers: one cell per row field, with the ancestors that repeat from
    // the previous line left blank. Repeating "North" down forty lines is how a
    // pivot stops looking like an outline and starts looking like a export.
    const prev = ri > 0 ? res.rows[ri - 1] : null
    if (row.kind === 'grand') {
      const th = el('th', 'dxp-rh dxp-total')
      th.colSpan = Math.max(1, res.rowFields.length)
      th.textContent = t('Grand total')
      tr.append(th)
    } else if (row.kind === 'subtotal') {
      const th = el('th', 'dxp-rh dxp-total')
      th.colSpan = Math.max(1, res.rowFields.length)
      th.textContent = totalCaption(row.path)
      tr.append(th)
    } else {
      for (let l = 0; l < Math.max(1, res.rowFields.length); l++) {
        const same = prev && prev.kind === 'leaf' && prev.codes[l] === row.codes[l]
          && prev.codes.slice(0, l).join(',') === row.codes.slice(0, l).join(',')
        tr.append(el('th', 'dxp-rh', same ? '' : label(row.path[l])))
      }
    }

    row.cells.forEach((cell, ci) => {
      const c = res.columns[ci]
      const td = el('td', `dxp-c dxp-${c.kind}${row.kind !== 'leaf' ? ' dxp-total' : ''}`)
      td.textContent = formatAgg(cell.v, c.value.fn, colOf(c.value.col))
      if (cell.rows === 0) {
        td.classList.add('dxp-gap')
        // A gap is titled, because an empty cell and a cell holding an empty
        // string look identical and mean opposite things.
        td.title = t('no rows')
      } else {
        td.title = t('{n} source rows').replace('{n}', String(cell.rows))
        if (cell.skipped) {
          // Never folded into the number and never hidden: this is `Column.failed`
          // (model.ts:87) at the aggregate level.
          td.classList.add('dxp-skipped')
          td.title += ` · ${t('{n} value(s) are not numbers and were not counted').replace('{n}', String(cell.skipped))}`
        }
        td.tabIndex = 0
        td.addEventListener('click', () => openDrill(ri, ci))
        td.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrill(ri, ci) }
        })
      }
      tr.append(td)
    })
    tbody.append(tr)
  }
  table.append(tbody)
  scroll.append(table)
  wrap.append(scroll)

  if (res.rows.length > shown) {
    wrap.append(el('p', 'dxp-note',
      t('{n} more rows are not shown — this pivot has stopped summarising.')
        .replace('{n}', String(res.rows.length - shown))))
  }
  wrap.append(el('p', 'dxp-note',
    t('{n} source rows').replace('{n}', String(res.scanned))))

  const drawer = el('div', 'dxp-drawer')
  drawer.hidden = true
  wrap.append(drawer)
  host.append(wrap)

  function openDrill(ri: number, ci: number): void {
    const d = drillDown(res, ri, ci)
    const row = res.rows[ri]
    const c = res.columns[ci]
    if (opts.onDrill) { opts.onDrill(d, row, c); return }
    drawer.textContent = ''
    drawer.hidden = false

    const head = el('div', 'dxp-drawer-head')
    const parts = [
      ...row.path.map(label),
      ...c.path.map(label),
      valueName(c.value, nameOf),
    ]
    head.append(el('span', 'dxp-drawer-title', parts.join(' · ')))
    head.append(el('span', 'dxp-drawer-count',
      t('{n} rows').replace('{n}', String(d.total))))
    const close = el('button', 'dxp-drawer-close', '✕')
    close.title = t('Close')
    close.addEventListener('click', () => { drawer.hidden = true })
    head.append(close)
    drawer.append(head)

    const dt = el('table', 'dxp-drill')
    const htr = el('tr')
    // The source ROW NUMBER is shown, because the whole point is to be able to
    // go and look at it. Positions are 1-based here to match the grid gutter.
    htr.append(el('th', 'dxp-drill-n', '#'))
    for (const sc of sheet.columns) htr.append(el('th', '', sc.name))
    const dhead = el('thead')
    dhead.append(htr)
    dt.append(dhead)
    const body = el('tbody')
    for (const r of d.rows) {
      const tr = el('tr')
      tr.append(el('td', 'dxp-drill-n', String(r + 1)))
      for (const sc of sheet.columns) {
        const v = opts.computed?.get(sc.id)?.[r] ?? readCell(sheet.data[sc.id], r)
        tr.append(el('td', '', formatValue(v, sc)))
      }
      body.append(tr)
    }
    dt.append(body)
    const dscroll = el('div', 'dxp-drill-scroll')
    dscroll.append(dt)
    drawer.append(dscroll)
    if (d.truncated) {
      drawer.append(el('p', 'dxp-note',
        t('Showing the first {n} of {total}.')
          .replace('{n}', String(d.rows.length))
          .replace('{total}', String(d.total))))
    }
    drawer.scrollIntoView({ block: 'nearest' })
  }

  return () => { host.textContent = '' }
}

/** Exposed for the rig, as store.ts and rowcol.ts do — not part of the app's surface. */
export const _internals = { asNumber, matchKey, median, groupPlane, valuePlane, flatten, BLANK }
