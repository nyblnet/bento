// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The STEP ENGINE — the relational pipeline the format has described since
// commit one, and which until now nothing executed.
//
// `TableSheet.steps` says how the numbers were arrived at:
//
//     import | bind | type | filter | derive | sort | group | join | union
//           | pivot | unpivot | limit | patch
//
// That is SQL's shape, already in the file, already collaborative, already
// undoable — and `applySteps` in store.ts threw "not implemented yet" while the
// grid's filtering and sorting were VIEW state that never touched it. This
// module closes that gap. docs/dash-sql.md then compiles SQL to `Step[]` and
// hands it here; that surface is step two and this is step one, owed regardless.
//
// THE ROW REPRESENTATION IS AN INDEX VECTOR, AND THAT IS THE WHOLE DESIGN.
// A `filter` does not copy a column and does not build row objects: it produces
// an `Int32Array` of positions, and every step downstream indexes through it.
// The concepting measured why — 1M `{v, f}` cell objects cost 44 MB of heap
// against 8 bytes per cell for a typed array — and the budgets this has to hit
// are stated in bytes-per-row terms it cannot reach any other way (single
// threaded, from `file://`, 10,000,000 rows: full scan sum 5.9 ms, filter + sum
// 10.6 ms, two-dimension group-by 11.5 ms, top-100 8.9 ms). A row-shaped
// pipeline is not a slower version of this; it is a different product.
//
// So there are exactly four allocations in this file that scale with rows:
//
//   1. the BASE materialisation of a column, once per column per source, cached
//      on the source and shared by every frame that descends from it;
//   2. an `Int32Array` per step that changes which rows are in play — one entry
//      per row that SURVIVES, not per row considered;
//   3. one BYTE per row while a filter is deciding, freed when it has decided;
//   4. a TRANSIENT gather of a referenced column, and only when the frame has
//      shrunk far enough that gathering beats reading the source through the
//      index vector (see `evalRowwise`) — one column, dropped when the step ends.
//
// Nothing here retains a per-step copy of a column. `_internals.stats` counts
// all four, so scripts/test-dash-steps.ts PROVES it: twenty chained filters over
// 100,000 rows gather zero cells and retain zero, and the engine holds 2.5 MB
// where the same answer computed row-shaped holds 16.8 MB.
//
// ONE EXPRESSION LANGUAGE. `filter.where` and `derive.expr` go through
// formula.ts's `evaluate` — the same 91 functions, the same coercions, the same
// visible errors — so `SUM` in a step means what `SUM` in a cell means. There
// is no second dialect here and there must never be one; `dependencies()`
// tells us which columns an expression touches so only those are materialised.
//
// ERRORS ARE VISIBLE, NEVER ZERO. formula.ts's rule, inherited whole. A row
// whose predicate could not be evaluated is DROPPED AND COUNTED, never silently
// swept; a predicate that failed on EVERY row halts the pipeline, because
// "no rows matched" and "your column name is misspelt" look identical on screen
// and only one of them is true.
//
// AND THE REFUSAL THIS ENGINE EXISTS TO MAKE: `join-fanout`. A join whose
// declared cardinality the data contradicts silently multiplies every measure
// downstream, and that failure has been printing confidently doubled totals in
// production tooling for a decade. dash holds the declaration (`Step.join.card`),
// so it can check it. It checks it, and it REFUSES — it does not produce the
// doubled total with a warning beside it.

import type {
  CellOverride, Column, ColumnData, ColumnType, DashDoc, Sheet, Step, TableSheet,
} from './model.ts'
import { readCell } from './store.ts'
import { compare, isBlank } from './filter.ts'
import { planSplit, type SplitSpec } from './tocolumns.ts'
import { dependencies, evaluate, isErr, recalc, type Cell, type EvalCtx, type Vec } from './formula.ts'

// --- what a step run reports --------------------------------------------------
//
// FINDINGS, NOT EXCEPTIONS — validate.ts's shape (validate.ts:59) and for the
// same reason: the caller decides what to show, and `showFindings` renders a
// `{code, severity, message}` without a translation layer. Nothing in this file
// throws at the caller; a throw from deeper down (a packed column, a malformed
// step) is caught and converted into a `fatal` finding naming the step.

export type StepSeverity =
  /** the pipeline stopped here. There is no result to show, and that is the point. */
  | 'fatal'
  /** this build cannot run the step. Show the last known values with a badge,
   *  NEVER zero — an empty bar chart reads as ZERO, which is a number, which is
   *  a lie (model.ts:183). */
  | 'unresolved'
  /** it ran, and something about it deserves a reader's attention. */
  | 'suspicious'

export interface StepIssue {
  /** stable machine-readable code, e.g. 'join-fanout' */
  code: string
  severity: StepSeverity
  /** one line, actionable on its own — it must name WHICH step and WHAT. */
  message: string
  /** index into the step list */
  at?: number
  op?: string
  column?: string
  /** rows affected, when a count is what makes the finding legible */
  rows?: number
}

/** Steps that are PROVENANCE: they record where data came from and are never
 *  re-run by recalculation (model.ts:156). Exported because store.ts's
 *  `applySteps` has to know where the re-executable tail begins, and two
 *  definitions of that seam is how a patch and its inverse drift apart. */
export const PROVENANCE_OPS: ReadonlySet<string> = new Set(['import', 'bind'])

/** Steps whose effect is already in the sheet's own bytes by the time the
 *  pipeline runs, so re-running them here would apply them twice.
 *  `type` coerced at import and wrote `Column.type`/`failed`; `patch` wrote the
 *  hand corrections into `cells`. They are carried for lineage, not replay. */
const SETTLED_OPS: ReadonlySet<string> = new Set(['type', 'patch'])

/** Declared in the format and deliberately NOT in this cut. Saying so is the
 *  point: a half-implemented pivot that silently drops a dimension is worse
 *  than one that refuses. */
const DEFERRED_OPS: ReadonlySet<string> = new Set(['pivot', 'unpivot'])

// --- the column store ---------------------------------------------------------

/**
 * A source: the columns of one sheet, materialised ONCE and shared by every
 * frame descended from it.
 *
 * `vec` is lazy and memoised, so a pipeline that filters on one column of a
 * forty-column sheet materialises one column. That is not an optimisation, it
 * is the difference between opening the file and not.
 */
export interface Source {
  /** sheet id, for lineage and for naming joined columns */
  id: string
  name: string
  /** rows in the source, before any step */
  n: number
  columns: Column[]
  /** colId → dense values, length `n`. Memoised. Throws on a packed column. */
  vec(colId: string): Vec | undefined
}

/**
 * A frame: a source, plus WHICH of its rows are in play and in what order.
 *
 * `rows === null` means "every row of the source, in order" — the identity
 * frame, which costs nothing and which lets the first `filter` in a pipeline
 * read the source's own vector with no copy at all.
 *
 * `derived` holds columns a `derive` step computed. They are in FRAME space
 * (one value per frame position), because they exist only for this frame;
 * source columns are in SOURCE space and are reached through `rows`.
 */
export interface Frame {
  src: Source
  rows: Int32Array | null
  n: number
  /** metadata for every column visible here, in order */
  columns: Column[]
  /** colId → values in FRAME space, for columns this frame computed */
  derived: Map<string, Vec>
}

export interface StepResult {
  /** false when a step refused or could not be run */
  ok: boolean
  /** the last frame produced. ON REFUSAL this is the frame BEFORE the failing
   *  step — never a partial or a fabricated one. */
  frame: Frame
  /** how many steps ran to completion */
  ran: number
  issues: StepIssue[]
  /** a step this build cannot execute stopped the run (unknown op, pivot) */
  unresolved: boolean
}

export interface RunOpts {
  /** for `join` and `union`, which name another sheet */
  doc?: DashDoc
  /** override sheet lookup (id first, then name) — the SQL surface will want
   *  to resolve a CTE name to a frame it built rather than to a saved sheet */
  sheets?: (ref: string) => TableSheet | undefined
  /** frozen `TODAY()`/`NOW()`, exactly as `recalc` takes it */
  now?: string
}

// --- allocation accounting ----------------------------------------------------
//
// The performance claim in this file's header is checkable, so it is CHECKED.
// These counters are how scripts/test-dash-steps.ts proves the pipeline is
// index-shaped instead of taking its word for it: a row-object implementation
// cannot keep `gatherCells` sublinear in the number of steps, and a
// column-copying one cannot keep `retainedCells` at zero.

const stats = {
  /** cells materialised from the SHEET — the unavoidable base cost, once per column */
  sourceCells: 0,
  /** Int32Array entries allocated by steps that change the row set */
  indexCells: 0,
  /** cells gathered TRANSIENTLY to evaluate an expression; garbage after the step */
  gatherCells: 0,
  /** one byte per row while a filter decides — transient, and a quarter of what
   *  a full-width candidate vector would cost */
  maskBytes: 0,
  /** cells a step RETAINED in a frame: derived columns and group/union output.
   *  A filter, a sort and a limit must never move this. */
  retainedCells: 0,
  frames: 0,
}
const resetStats = (): void => {
  stats.sourceCells = 0; stats.indexCells = 0; stats.gatherCells = 0
  stats.retainedCells = 0; stats.frames = 0; stats.maskBytes = 0
}

// --- values -------------------------------------------------------------------

/**
 * The digit shape a string must have to be READ as a number.
 *
 * The THIRD copy of this rule (filter.ts:112, pivot.ts:260), and copied for the
 * same reason pivot.ts states: filter.ts does not export it. It is copied
 * rather than loosened — `Number('')` is 0, which is how a blank becomes a
 * zero, and a percent column stores the FRACTION so reading "50%" as 50 is
 * wrong by a factor of a hundred.
 *
 * Used ONLY for grouping keys and sort order, where it must agree with the
 * filter menu and the pivot or the same click gives two answers. Aggregate
 * ARITHMETIC deliberately does not use it — see `aggregate` below, which is
 * formula.ts's rule so that SUM means one thing in this app.
 *
 * IF filter.ts EVER EXPORTS `asNumber`, TAKE IT AND DELETE THIS.
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
 * The ONE canonical group key — pivot.ts:277's, deliberately identical.
 *
 * Two values collapse into one group here exactly when they collapse into one
 * checkbox in the filter menu and one row in a pivot. A reader who ticks
 * "North" in the filter, sees "North" in the pivot and groups by region in a
 * step is looking at the same set of rows all three times, or the app has three
 * opinions about what a category is.
 */
function matchKey(v: unknown): string {
  if (isBlank(v)) return ' blank'
  const n = asNumber(v)
  return n === null ? `t:${String(v).trim().toLowerCase()}` : `n:${n}`
}

/**
 * Build a source from a table sheet.
 *
 * Formula columns come from `recalc`, computed once on first demand and in
 * dependency order — the alternative is a step reading a formula column's stale
 * values, which is the right shape and the wrong numbers.
 *
 * Cell OVERRIDES are applied. They are the hand corrections somebody made to
 * imported data, and a pipeline that ignored them would total the numbers the
 * author already said were wrong. Per-cell FORMULAS (`CellOverride.f`) are
 * cellformula.ts's and are not evaluated here; the stored `v` beside them is.
 */
export function sourceOf(sheet: TableSheet): Source {
  const n = sheet.rids.reduce((a, [, c]) => a + c, 0)
  const byId = new Map<string, Column>()
  for (const c of sheet.columns) byId.set(c.id, c)

  const cache = new Map<string, Vec>()
  let computed: Map<string, Vec> | null = null

  /** rid → row position, built ONLY when there are overrides to place. At 10M
   *  rows this map is expensive and almost always unnecessary. */
  let ridRow: Map<number, number> | null = null
  const rowOfRid = (rid: number): number => {
    if (!ridRow) {
      ridRow = new Map()
      let i = 0
      for (const [start, count] of sheet.rids) {
        for (let k = 0; k < count; k++) ridRow.set(start + k, i++)
      }
    }
    return ridRow.get(rid) ?? -1
  }

  const applyOverrides = (colId: string, out: Vec): void => {
    const cells = sheet.cells
    if (!cells) return
    const prefix = `${colId}:`
    for (const key of Object.keys(cells)) {
      if (!key.startsWith(prefix)) continue
      const o = cells[key] as CellOverride
      if (!o || !('v' in o)) continue
      const row = rowOfRid(Number(key.slice(prefix.length)))
      if (row >= 0 && row < n) out[row] = o.v as Cell
    }
  }

  return {
    id: sheet.id,
    name: sheet.name,
    n,
    columns: sheet.columns,
    vec(colId: string): Vec | undefined {
      const hit = cache.get(colId)
      if (hit) return hit
      const col = byId.get(colId)
      if (!col) return undefined
      let out: Vec
      if (col.formula) {
        if (!computed) computed = recalc(sheet, undefined).values
        out = computed.get(colId) ?? new Array<Cell>(n).fill(null)
      } else {
        const d: ColumnData | undefined = sheet.data[colId]
        // `pack` is an opaque archive encoding and `readCell` answers null for
        // every row of one (store.ts:274). Running a pipeline through that
        // gives one "(blank)" group holding the whole sheet and a grand total
        // of nothing — a wrong answer with no symptom. rowcol.ts refuses packed
        // columns for edits and pivot.ts for reads; this refuses them for steps.
        if (d && d.enc === 'pack') {
          throw new Error(`column "${col.name || colId}" is packed and cannot be stepped over — promote it to raw first`)
        }
        out = new Array<Cell>(n)
        for (let i = 0; i < n; i++) out[i] = readCell(d, i) as Cell
      }
      applyOverrides(colId, out)
      stats.sourceCells += n
      cache.set(colId, out)
      return out
    },
  }
}

/** The whole sheet, unfiltered and in order. Costs one object. */
export function frameOf(src: Source): Frame {
  stats.frames++
  return { src, rows: null, n: src.n, columns: src.columns.slice(), derived: new Map() }
}

/** Resolve a column reference — id first, then name, then either case-folded. */
export function columnOf(frame: Frame, ref: string): Column | undefined {
  const lower = ref.toLowerCase()
  let byName: Column | undefined
  let byFold: Column | undefined
  for (const c of frame.columns) {
    if (c.id === ref) return c
    if (!byName && c.name === ref) byName = c
    if (!byFold && (c.id.toLowerCase() === lower || (c.name ?? '').toLowerCase() === lower)) byFold = c
  }
  return byName ?? byFold
}

/**
 * The values of one column IN FRAME ORDER.
 *
 * THE IDENTITY CASE RETURNS THE SOURCE'S OWN ARRAY — not a copy, not a view,
 * the same object. That is the property the whole design rests on, and the rig
 * asserts it with `===` rather than believing this comment.
 *
 * When the frame is a subset the values are GATHERED, and that gather is
 * transient by design: it is not cached on the frame, so a twenty-step pipeline
 * does not retain twenty copies of a column. `evalRowwise` avoids it entirely
 * for the ordinary predicate — see there, because a gather per step is exactly
 * the cost this file exists to not pay.
 */
export function values(frame: Frame, ref: string): Vec | undefined {
  const col = columnOf(frame, ref)
  if (!col) return undefined
  const own = frame.derived.get(col.id)
  if (own) return own
  const base = frame.src.vec(col.id)
  if (!base) return undefined
  if (frame.rows === null) return base
  const rows = frame.rows
  const out = new Array<Cell>(frame.n)
  for (let i = 0; i < frame.n; i++) out[i] = base[rows[i]] ?? null
  stats.gatherCells += frame.n
  return out
}

/**
 * A child frame holding `pos` — positions IN THE PARENT'S FRAME SPACE.
 *
 * One helper for filter, sort, limit and the fanout side of join, because they
 * differ only in how they choose `pos`. Source columns re-index for free (the
 * index vector composes); derived columns are gathered, because they are
 * genuinely this pipeline's own data and live nowhere else.
 *
 * `pos` MAY BE CONSUMED — composed into source space in place. Every caller
 * allocates it fresh for this call, and the alternative is a second index
 * vector per step for no gain.
 */
function reindex(frame: Frame, pos: Int32Array): Frame {
  let rows: Int32Array
  if (frame.rows === null) {
    // Frame positions ARE source rows here, so the index vector is already right.
    rows = pos
  } else if (frame.derived.size === 0) {
    const parent = frame.rows
    for (let i = 0; i < pos.length; i++) pos[i] = parent[pos[i]]
    rows = pos
  } else {
    // Derived columns are addressed by FRAME position, so `pos` has to survive
    // the gather below; compose into a second vector instead.
    rows = new Int32Array(pos.length)
    for (let i = 0; i < pos.length; i++) rows[i] = frame.rows[pos[i]]
    stats.indexCells += pos.length
  }
  const derived = new Map<string, Vec>()
  for (const [k, v] of frame.derived) {
    const out = new Array<Cell>(pos.length)
    for (let i = 0; i < pos.length; i++) out[i] = v[pos[i]] ?? null
    stats.retainedCells += pos.length
    derived.set(k, out)
  }
  stats.frames++
  return { src: frame.src, rows, n: pos.length, columns: frame.columns.slice(), derived }
}

/** An expression's context: ONLY the columns it names get materialised. */
function ctxFor(frame: Frame, src: string, now?: string): EvalCtx {
  const cols = new Map<string, Vec>()
  for (const ref of dependencies(src)) {
    const v = values(frame, ref)
    if (!v) continue
    cols.set(ref, v)
    cols.set(ref.toLowerCase(), v)
  }
  return { cols, n: frame.n, now }
}

/**
 * An expression's values, evaluated the cheap way when the cheap way is
 * IDENTICAL.
 *
 * The problem this solves is the whole performance story of a filter chain. A
 * frame that is a subset has to hand its columns to `evaluate` in FRAME order,
 * which means gathering them — and a gather per step is a column copy per step,
 * which is precisely the shape this file promises not to have.
 *
 * A ROW-WISE expression does not need frame order. `value > 60` gives the same
 * answer for row 4,000 whether or not rows 1 to 3,999 are still in play, so it
 * can be evaluated over the SOURCE's own arrays — which are already
 * materialised and shared — and read back through the index vector. No gather,
 * no allocation, no copy, at any depth of chaining.
 *
 * WHAT MAKES AN EXPRESSION ROW-WISE HERE: it contains no `(`. That is a blunt
 * test and a deliberately conservative one — it is not trying to be clever, it
 * is trying to be UNABLE to be wrong. `SUM(value)`, `AVERAGE(value)`,
 * `COUNTIF(...)` and every other whole-column function must see the frame and
 * only the frame (a `HAVING`-shaped filter is exactly that), and all of them
 * need a bracket to be written. An expression with a bracket in a string
 * literal takes the slow path for nothing, which costs a gather and never costs
 * an answer.
 *
 * The other two guards: a DERIVED column exists only in frame space, and a
 * frame that has shrunk to a fraction of its source is cheaper to gather than
 * to evaluate whole. Both fall back, and falling back is always correct.
 */
interface Evaluated {
  out: Vec
  /** true when `out` is indexed by SOURCE row rather than by frame position */
  sourceSpace: boolean
}

function evalRowwise(frame: Frame, src: string, now?: string): Evaluated {
  const rows = frame.rows
  if (rows !== null && !src.includes('(') && frame.n * 2 >= frame.src.n) {
    const cols = new Map<string, Vec>()
    let usable = true
    for (const ref of dependencies(src)) {
      const c = columnOf(frame, ref)
      if (c && frame.derived.has(c.id)) { usable = false; break }
      const v = c ? frame.src.vec(c.id) : undefined
      if (!v) continue // an unknown name errors identically on either path
      cols.set(ref, v)
      cols.set(ref.toLowerCase(), v)
    }
    if (usable) return { out: evaluate(src, { cols, n: frame.src.n, now }), sourceSpace: true }
  }
  return { out: evaluate(src, ctxFor(frame, src, now)), sourceSpace: false }
}

// --- the steps ----------------------------------------------------------------

/** What a step handler answers with. A `fatal` or `unresolved` issue stops the run. */
interface StepOut {
  frame?: Frame
  issues?: StepIssue[]
}

const issue = (
  code: string, severity: StepSeverity, message: string, extra: Partial<StepIssue> = {},
): StepIssue => ({ code, severity, message, ...extra })

/**
 * `filter` — a predicate over the frame, producing an INDEX VECTOR.
 *
 * TWO REFUSALS LIVE HERE, and they are the difference between a filter and a
 * disappearance:
 *
 *   - a predicate that errored on EVERY row is FATAL. `region = "Nort"` matching
 *     nothing and `regoin = "North"` matching nothing look identical on screen
 *     — an empty grid — and only one of them is the data's fault.
 *   - a predicate that errored on SOME rows drops them and SAYS SO. Those rows
 *     are not a matter of opinion; they are rows the pipeline could not judge,
 *     and a total computed without them is short by an amount nobody can see.
 */
function stepFilter(frame: Frame, step: { where?: unknown }, at: number, now?: string): StepOut {
  const where = typeof step.where === 'string' ? step.where : ''
  if (!where.trim()) {
    return { issues: [issue('filter-empty', 'suspicious', `Step ${at + 1} is a filter with no condition, so it kept every row.`, { at, op: 'filter' })] }
  }
  const { out, sourceSpace } = evalRowwise(frame, where, now)
  const rows = frame.rows
  // ONE BYTE PER ROW while deciding, then ONE Int32Array of exactly the rows
  // that survived. Writing candidates into a full-width Int32Array first costs
  // four times the transient memory for a filter that keeps a tenth of the rows.
  const mask = new Uint8Array(frame.n)
  stats.maskBytes += frame.n
  let k = 0
  let errors = 0
  for (let i = 0; i < frame.n; i++) {
    const v = (sourceSpace ? out[rows![i]] : out[i]) ?? null
    if (isErr(v)) { errors++; continue }
    // A blank is not a match. Excel's rule, SQL's rule, and the only one that
    // does not turn an empty cell into a silent yes.
    if (v === false || v === null || v === '' || v === 0) continue
    mask[i] = 1
    k++
  }
  if (errors === frame.n && frame.n > 0) {
    const why = out.length ? String(out[0]) : '#VALUE!'
    return {
      issues: [issue('filter-unresolved', 'fatal',
        `Step ${at + 1}: the condition ${JSON.stringify(where)} could not be evaluated on any row (${why}). That is not an empty result — it is a condition this workbook cannot answer, so the pipeline stopped rather than show you nothing and call it data.`,
        { at, op: 'filter', rows: frame.n })],
    }
  }
  const issues: StepIssue[] = []
  if (errors) {
    issues.push(issue('filter-errors', 'suspicious',
      `Step ${at + 1}: ${errors} row(s) were dropped because ${JSON.stringify(where)} could not be evaluated on them. Anything totalled below is short by those rows.`,
      { at, op: 'filter', rows: errors }))
  }
  // Everything survived: hand back the SAME frame. A filter that filters
  // nothing should cost nothing.
  if (k === frame.n) return { frame, issues }
  const pos = new Int32Array(k)
  stats.indexCells += k
  let w = 0
  for (let i = 0; i < frame.n; i++) if (mask[i]) pos[w++] = i
  return { frame: reindex(frame, pos), issues }
}

/** `derive` — one expression, one new column, one vectorised pass. */
function stepDerive(
  frame: Frame,
  step: { col?: unknown; name?: unknown; expr?: unknown; type?: unknown; unit?: unknown },
  at: number,
  now?: string,
): StepOut {
  const expr = typeof step.expr === 'string' ? step.expr : ''
  const id = typeof step.col === 'string' && step.col ? step.col : ''
  const name = typeof step.name === 'string' && step.name ? step.name : id
  if (!id || !expr.trim()) {
    return {
      issues: [issue('derive-incomplete', 'fatal',
        `Step ${at + 1} is a derive without ${!id ? 'a column id' : 'an expression'}, so there is nothing to compute.`,
        { at, op: 'derive' })],
    }
  }
  const out = evaluate(expr, ctxFor(frame, expr, now))
  const vals: Vec = new Array<Cell>(frame.n)
  let errors = 0
  for (let i = 0; i < frame.n; i++) {
    const v = out[i] ?? null
    if (isErr(v)) errors++
    vals[i] = v
  }
  stats.retainedCells += frame.n
  const derived = new Map(frame.derived)
  derived.set(id, vals)
  const columns = frame.columns.filter((c) => c.id !== id)
  columns.push({
    id,
    name,
    type: (typeof step.type === 'string' ? step.type : inferType(vals)) as ColumnType,
    ...(typeof step.unit === 'string' ? { unit: step.unit } : {}),
  } as Column)
  stats.frames++
  const next: Frame = { src: frame.src, rows: frame.rows, n: frame.n, columns, derived }
  const issues: StepIssue[] = []
  if (errors) {
    // NOT fatal, and not silently zeroed: the error cells stay in the column so
    // a reader sees #NAME? where a number should be. formula.ts's rule.
    issues.push(issue(errors === frame.n ? 'derive-unresolved' : 'derive-errors', 'suspicious',
      `Step ${at + 1}: ${JSON.stringify(expr)} could not be computed on ${errors} of ${frame.n} row(s); those cells read as an error rather than as a number.`,
      { at, op: 'derive', column: id, rows: errors }))
  }
  return { frame: next, issues }
}

/**
 * `split` — one text column into several. Text to Columns, as a declaration.
 *
 * Three things make it an op rather than N `derive`s, and they are argued in
 * full in tocolumns.ts's header: there is no SPLIT in the expression language,
 * the delimiter must live in ONE place rather than N that can disagree, and the
 * output types have to come from import.ts's whole-column inference — which
 * REFUSES on an ambiguous date column — rather than from `derive`'s per-value
 * guess.
 *
 * THE SOURCE COLUMN SURVIVES. Excel replaces it with field one; that makes the
 * step non-idempotent, and a step that has eaten its own input cannot be
 * re-run, which is the entire point of putting it in the pipeline. Running this
 * pipeline twice produces the same frame.
 */
function stepSplit(
  frame: Frame,
  step: { col?: unknown; by?: unknown; widths?: unknown; into?: unknown; quoted?: unknown; trim?: unknown },
  at: number,
): StepOut {
  const ref = typeof step.col === 'string' ? step.col : ''
  const into = Array.isArray(step.into)
    ? (step.into as unknown[]).filter((t): t is { id: string; name: string } =>
      !!t && typeof (t as { id?: unknown }).id === 'string' && (t as { id: string }).id !== '')
      .map((t) => ({ id: t.id, name: typeof t.name === 'string' && t.name ? t.name : t.id }))
    : []
  const widths = Array.isArray(step.widths)
    ? (step.widths as unknown[]).filter((n): n is number => typeof n === 'number') : []
  const spec: SplitSpec = {
    ...(widths.length ? { widths } : { by: typeof step.by === 'string' ? step.by : '' }),
    ...(step.quoted === false ? { quoted: false } : {}),
    ...(step.trim === false ? { trim: false } : {}),
  }
  if (!ref || !into.length || (!widths.length && !spec.by)) {
    return {
      issues: [issue('split-incomplete', 'fatal',
        `Step ${at + 1} is a split without ${!ref ? 'a column' : !into.length ? 'any output columns' : 'a delimiter or widths'}, so there is nothing to cut.`,
        { at, op: 'split' })],
    }
  }
  const col = columnOf(frame, ref)
  const src = values(frame, ref)
  if (!col || !src) {
    return {
      issues: [issue('split-no-column', 'fatal',
        `Step ${at + 1} splits ${JSON.stringify(ref)}, and this sheet has no such column.`,
        { at, op: 'split', column: ref })],
    }
  }
  // ONE plan for the app and the pipeline. The grid's Text to Columns command
  // calls `planSplit` directly to write the columns into a base sheet's bytes;
  // if this re-derived them a second way the two would drift, and the drift
  // would show up as a re-run changing a column nobody edited.
  const plan = planSplit(src.slice(0, frame.n), spec, into)
  const derived = new Map(frame.derived)
  plan.columns.forEach((c, i) => {
    derived.set(c.id, plan.values[i] as Vec)
    stats.retainedCells += frame.n
  })
  const made = new Set(plan.columns.map((c) => c.id))
  const columns = frame.columns.filter((c) => !made.has(c.id)).concat(plan.columns)
  stats.frames++
  const issues = plan.findings.map((f) => issue(f.code, 'suspicious',
    `Step ${at + 1}: ${f.message}`, { at, op: 'split', column: f.column }))
  return { frame: { src: frame.src, rows: frame.rows, n: frame.n, columns, derived }, issues }
}

function inferType(vals: Vec): ColumnType {
  let seen = false
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]
    if (v == null || v === '' || isErr(v)) continue
    seen = true
    if (typeof v !== 'number') return typeof v === 'boolean' ? 'bool' : 'text'
  }
  return seen ? 'number' : 'text'
}

/**
 * `sort` — a permutation of the index vector, and no column moves.
 *
 * Ordering is filter.ts's `compare`, so a step-sorted result and a
 * column-header sort put the rows in the SAME order. Two orderings of one
 * column is how a story step and a grid come to show different top tens.
 *
 * The comparator TIE-BREAKS ON POSITION, which makes the order total. Stability
 * is then a property of the comparator rather than of whichever sort the engine
 * happens to use, so `group` after `sort` is reproducible everywhere.
 */
function stepSort(frame: Frame, step: { by?: unknown; dir?: unknown }, at: number): StepOut {
  const by = typeof step.by === 'string' ? step.by : ''
  const vals = by ? values(frame, by) : undefined
  if (!vals) {
    return {
      issues: [issue('sort-missing-column', 'fatal',
        `Step ${at + 1} sorts by ${JSON.stringify(by)}, which is not a column here. Sorting by nothing would leave the rows in an order that only looks deliberate.`,
        { at, op: 'sort', column: by })],
    }
  }
  const pos = new Int32Array(frame.n)
  for (let i = 0; i < frame.n; i++) pos[i] = i
  stats.indexCells += frame.n
  pos.sort(sortComparator(vals, step.dir === 'desc'))
  return { frame: reindex(frame, pos) }
}

/**
 * The comparator, as its own function so its one load-bearing property is
 * TESTABLE: it is a TOTAL order — it returns 0 only when comparing a position
 * with itself.
 *
 * That is what makes the sort stable, and it makes it stable BY CONSTRUCTION
 * rather than by relying on the engine's sort being stable. %TypedArray%.sort
 * has been required to be stable since ES2019, so the difference is invisible
 * on a conformant engine and a rig cannot catch its removal by sorting — which
 * is exactly why the property is asserted on the comparator directly.
 */
function sortComparator(vals: Vec, desc: boolean): (a: number, b: number) => number {
  const sign = desc ? -1 : 1
  return (a, b) => {
    const c = compare(vals[a] ?? null, vals[b] ?? null)
    return c !== 0 ? c * sign : a - b
  }
}

/** `limit` — a window of the index vector. Top-100 of ten million rows is this. */
function stepLimit(frame: Frame, step: { n?: unknown; offset?: unknown }, at: number): StepOut {
  const want = typeof step.n === 'number' && Number.isFinite(step.n) ? Math.max(0, Math.floor(step.n)) : -1
  const off = typeof step.offset === 'number' && Number.isFinite(step.offset) ? Math.max(0, Math.floor(step.offset)) : 0
  if (want < 0) {
    return {
      issues: [issue('limit-missing-n', 'fatal',
        `Step ${at + 1} is a limit with no row count.`, { at, op: 'limit' })],
    }
  }
  const start = Math.min(off, frame.n)
  const end = Math.min(start + want, frame.n)
  if (start === 0 && end === frame.n) return { frame }
  const pos = new Int32Array(end - start)
  for (let i = 0; i < pos.length; i++) pos[i] = start + i
  stats.indexCells += pos.length
  return { frame: reindex(frame, pos) }
}

// --- aggregation --------------------------------------------------------------
//
// ONE MEANING FOR SUM. The aggregate names in `Step.group.agg` dispatch to
// formula.ts, so `{fn:'sum'}` in a step and `=SUM(col)` in a cell produce the
// same number on the same column — including on the awkward inputs, which is
// where two implementations diverge and where the divergence is invisible.
//
// The five hot ones are open-coded because a group-by over ten million rows
// cannot afford `evaluate` per group; they reproduce formula.ts's coercion
// (`num`) EXACTLY rather than approximately, and scripts/test-dash-steps.ts
// cross-checks every one of them against `evaluate` on adversarial data. If
// that rig ever fails, this fast path is wrong and formula.ts is right.
//
// Everything else — MEDIAN, STDEV, PRODUCT, COUNTUNIQUE, MODE, VAR — routes
// through `evaluate` and costs nothing to support, which is the whole argument
// for having one expression language instead of two.

/** formula.ts's `num`, reproduced (it is not exported). Non-numeric → null.
 *  The blank cases are handled by the CALLER, matching formula.ts's split
 *  between `num` (a blank is 0, because `=A1+1` on an empty cell is 1) and
 *  `numbersIn` (a blank is absent, because AVERAGE over three numbers and seven
 *  empty cells is the mean of three). Getting that split wrong is a wrong
 *  answer in exact proportion to how sparse the column is. */
function fnum(v: Cell): number | null {
  if (isErr(v)) return null
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = Number(String(v).replace(/[,\s£$€¥%]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** Aggregate names this file open-codes, lowercased. */
const FAST = new Set(['sum', 'count', 'avg', 'average', 'min', 'max'])

/** Aggregates that COUNT rather than compute, and so are not poisoned by an
 *  error cell — formula.ts's `COUNTING`. Everything else propagates the first
 *  error it meets: a SUM over a range holding `#REF!` is `#REF!`, never the
 *  total of the cells that happened to work, which is a number with a piece
 *  missing and no way to tell. */
const FAST_COUNTING = new Set(['count'])

/** What a step's `fn` is called in formula.ts. */
const AGG_ALIAS: Record<string, string> = {
  avg: 'AVERAGE',
  average: 'AVERAGE',
  countdistinct: 'COUNTUNIQUE',
  countunique: 'COUNTUNIQUE',
  counta: 'COUNTA',
  countblank: 'COUNTBLANK',
}

/**
 * Aggregate `vals[pos[i]]` for `i` in `[from, to)`.
 *
 * `null` for `of` on a `count` is COUNT(*) — the number of rows in the group,
 * which is a different question from "how many numbers are in this column" and
 * the one people mean when they write `COUNT(*)`.
 */
function aggregate(fn: string, vals: Vec | null, pos: Int32Array, from: number, to: number): Cell {
  const key = fn.toLowerCase()
  if (!vals) return to - from
  if (FAST.has(key)) {
    const counting = FAST_COUNTING.has(key)
    let sum = 0
    let count = 0
    let min = Infinity
    let max = -Infinity
    for (let i = from; i < to; i++) {
      const raw = vals[pos[i]] ?? null
      // A BLANK IS NOT A ZERO in an aggregate (formula.ts `numbersIn`).
      if (raw === null || raw === '') continue
      if (isErr(raw)) {
        if (!counting) return raw
        continue
      }
      const n = fnum(raw)
      if (n === null) continue
      count++
      sum += n
      if (n < min) min = n
      if (n > max) max = n
    }
    switch (key) {
      case 'sum': return sum
      // formula.ts's MIN/MAX answer 0 for an empty set and AVERAGE answers
      // #DIV/0!. Both are reproduced deliberately: a step that disagreed with a
      // cell about the empty case is exactly the drift this file exists to avoid.
      case 'min': return count ? min : 0
      case 'max': return count ? max : 0
      case 'count': return count
      default: return count ? sum / count : evaluate('1/0', { cols: new Map(), n: 1 })[0]
    }
  }
  // The general path: hand the group's values to formula.ts under a name no
  // column can collide with, and let the one expression language answer.
  const slice: Vec = new Array<Cell>(to - from)
  for (let i = from; i < to; i++) slice[i - from] = vals[pos[i]] ?? null
  const name = AGG_ALIAS[key] ?? fn.toUpperCase()
  const cols = new Map<string, Vec>([['_g', slice], ['_G', slice]])
  return evaluate(`${name}(_g)`, { cols, n: slice.length })[0] ?? null
}

/**
 * `group` — the one step that MATERIALISES, because an aggregate is new data.
 *
 * Grouping is by the canonical key (`matchKey`), so a group here holds exactly
 * the rows the filter menu's checkbox for that value would hold. Group ORDER is
 * first appearance, which makes `sort → group` produce sorted groups and makes
 * two readers of one file see the same table — SQL guarantees no order at all,
 * and "no order" in a saved document means "a different order for each of you".
 */
function stepGroup(
  frame: Frame,
  step: { by?: unknown; agg?: unknown },
  at: number,
): StepOut {
  const by = Array.isArray(step.by) ? (step.by as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const aggs = Array.isArray(step.agg)
    ? (step.agg as Array<{ fn?: unknown; of?: unknown; as?: unknown }>)
    : []
  if (!by.length && !aggs.length) {
    return { issues: [issue('group-empty', 'fatal', `Step ${at + 1} is a group with neither keys nor aggregates.`, { at, op: 'group' })] }
  }
  const issues: StepIssue[] = []

  const keyVecs: Vec[] = []
  const keyCols: Column[] = []
  for (const ref of by) {
    const v = values(frame, ref)
    const col = columnOf(frame, ref)
    if (!v || !col) {
      return {
        issues: [issue('group-missing-column', 'fatal',
          `Step ${at + 1} groups by ${JSON.stringify(ref)}, which is not a column here. Grouping by a column that is not there would silently collapse every row into one total.`,
          { at, op: 'group', column: ref })],
      }
    }
    keyVecs.push(v)
    keyCols.push(col)
  }

  // Bucket by canonical key, remembering first appearance. `order` holds the
  // frame positions grouped together, so aggregation is one contiguous walk.
  const seen = new Map<string, number>()
  const members: number[][] = []
  const firstRow: number[] = []
  for (let i = 0; i < frame.n; i++) {
    let k = ''
    for (let d = 0; d < keyVecs.length; d++) {
    // U+001F between the parts, and NOT bare concatenation: without a separator
    // ("ab", "c") and ("a", "bc") are ONE group — two dimensions merged into
    // one row, showing a total nobody can trace. The same separator the CRDT
    // uses for its composite node keys, for the same reason.
      k += (d ? '' : '') + matchKey(keyVecs[d][i] ?? null)
    }
    let g = seen.get(k)
    if (g === undefined) { g = members.length; seen.set(k, g); members.push([]); firstRow.push(i) }
    members[g].push(i)
  }
  const groups = members.length
  const pos = new Int32Array(frame.n)
  const starts = new Int32Array(groups + 1)
  let w = 0
  for (let g = 0; g < groups; g++) {
    starts[g] = w
    for (const i of members[g]) pos[w++] = i
  }
  starts[groups] = w
  stats.indexCells += frame.n + groups + 1

  // ---- the output table
  const columns: Column[] = []
  const data: Record<string, Vec> = {}
  for (let d = 0; d < keyCols.length; d++) {
    const src = keyCols[d]
    const out: Vec = new Array<Cell>(groups)
    // The FIRST value seen, not the canonical key: "North" is what the author
    // typed and what the reader should read, even though "north" grouped with it.
    for (let g = 0; g < groups; g++) out[g] = keyVecs[d][firstRow[g]] ?? null
    columns.push({ id: src.id, name: src.name, type: src.type, ...(src.format ? { format: src.format } : {}) } as Column)
    data[src.id] = out
    stats.retainedCells += groups
  }
  for (let a = 0; a < aggs.length; a++) {
    const spec = aggs[a]
    const fn = typeof spec.fn === 'string' ? spec.fn : 'count'
    const of = typeof spec.of === 'string' && spec.of ? spec.of : null
    const id = typeof spec.as === 'string' && spec.as ? spec.as : `${fn}_${of ?? 'rows'}`
    let vals: Vec | null = null
    if (of) {
      const v = values(frame, of)
      if (!v) {
        return {
          issues: [issue('group-missing-measure', 'fatal',
            `Step ${at + 1} aggregates ${JSON.stringify(of)}, which is not a column here. An aggregate over a column that is not there totals to zero, and zero is a number a reader will believe.`,
            { at, op: 'group', column: of })],
        }
      }
      vals = v
    }
    const out: Vec = new Array<Cell>(groups)
    for (let g = 0; g < groups; g++) out[g] = aggregate(fn, vals, pos, starts[g], starts[g + 1])
    stats.retainedCells += groups
    if (out.length && isErr(out[0]) && String(out[0]) === '#NAME?') {
      issues.push(issue('group-unknown-agg', 'suspicious',
        `Step ${at + 1}: no aggregate named ${JSON.stringify(fn)} — the column ${JSON.stringify(id)} reads #NAME? rather than a plausible total.`,
        { at, op: 'group', column: id }))
    }
    columns.push({ id, name: id, type: 'number' } as Column)
    data[id] = out
  }
  return { frame: tableFrame(`${frame.src.id}+group`, frame.src.name, groups, columns, data), issues }
}

/** A frame over freshly computed columns — what `group`, `join` and `union` make. */
function tableFrame(
  id: string, name: string, n: number, columns: Column[], data: Record<string, Vec>,
): Frame {
  const src: Source = {
    id, name, n, columns,
    vec: (colId: string) => data[colId],
  }
  stats.frames++
  return { src, rows: null, n, columns: columns.slice(), derived: new Map() }
}

// --- join ---------------------------------------------------------------------

/**
 * `join` — and THE REFUSAL.
 *
 * `card` is the author's DECLARATION of what one row of the other sheet means:
 * `'one'` says "at most one match per row here", which is the ordinary
 * fact-to-dimension lookup, and `'many'` says "this will multiply rows, and I
 * mean it". The failure this guards against is the first declaration meeting
 * data that contradicts it: every left row that matches two right rows is
 * silently duplicated, and every measure downstream doubles. The total looks
 * fine. It is the single most expensive quiet bug in analytics tooling, and it
 * has been printing wrong numbers for a decade because the declaration was
 * never written down anywhere a tool could check it.
 *
 * dash writes it down. So this checks it, and REFUSES — it does not produce
 * the doubled total with a warning next to it, because a number on screen wins
 * every argument with a warning beside it.
 *
 * Both cardinalities LEFT JOIN: an unmatched row is kept with blanks and
 * COUNTED, never dropped. Dropping unmatched rows is the other way to make a
 * total quietly wrong, and it is even harder to see.
 */
function stepJoin(
  frame: Frame,
  step: { with?: unknown; on?: unknown; card?: unknown; fields?: unknown },
  at: number,
  opts: RunOpts,
): StepOut {
  const withRef = typeof step.with === 'string' ? step.with : ''
  const on = Array.isArray(step.on) ? step.on : []
  const leftRef = typeof on[0] === 'string' ? on[0] : ''
  const rightRef = typeof on[1] === 'string' ? on[1] : ''
  const card = step.card === 'many' ? 'many' : 'one'
  const fields = Array.isArray(step.fields)
    ? (step.fields as unknown[]).filter((x): x is string => typeof x === 'string')
    : []

  const other = resolveSheet(withRef, opts)
  if (!other) {
    return {
      issues: [issue('join-missing-sheet', 'fatal',
        `Step ${at + 1} joins to ${JSON.stringify(withRef)}, which is not a table sheet in this workbook.`,
        { at, op: 'join' })],
    }
  }
  const leftVals = leftRef ? values(frame, leftRef) : undefined
  if (!leftVals) {
    return {
      issues: [issue('join-missing-column', 'fatal',
        `Step ${at + 1} joins on ${JSON.stringify(leftRef)}, which is not a column here.`,
        { at, op: 'join', column: leftRef })],
    }
  }
  const rsrc = sourceOf(other)
  const rframe = frameOf(rsrc)
  const rightVals = rightRef ? values(rframe, rightRef) : undefined
  if (!rightVals) {
    return {
      issues: [issue('join-missing-column', 'fatal',
        `Step ${at + 1} joins on ${JSON.stringify(rightRef)}, which is not a column of ${JSON.stringify(other.name || other.id)}.`,
        { at, op: 'join', column: rightRef })],
    }
  }

  // ---- index the right side, and check the declaration while doing it
  const index = new Map<string, number[]>()
  let worstKey = ''
  let worst = 1
  for (let r = 0; r < rsrc.n; r++) {
    const k = matchKey(rightVals[r] ?? null)
    const bucket = index.get(k)
    if (bucket) {
      bucket.push(r)
      if (bucket.length > worst) { worst = bucket.length; worstKey = String(rightVals[r] ?? '') }
    } else index.set(k, [r])
  }
  if (card === 'one' && worst > 1) {
    // How bad it would have been, said in the only unit that matters.
    let fanned = 0
    for (let i = 0; i < frame.n; i++) {
      const b = index.get(matchKey(leftVals[i] ?? null))
      if (b && b.length > 1) fanned += b.length - 1
    }
    return {
      issues: [issue('join-fanout', 'fatal',
        `Step ${at + 1} declares one match per row (card: "one"), but ${JSON.stringify(other.name || other.id)} holds ${worst} rows for ${JSON.stringify(worstKey)} on ${JSON.stringify(rightRef)}. Running it would add ${fanned} duplicate row(s) and multiply every total below by that much, with nothing on screen to show it. The join was refused instead. Either make ${JSON.stringify(rightRef)} unique, or declare card: "many" and mean it.`,
        { at, op: 'join', column: rightRef, rows: fanned })],
    }
  }

  // ---- the added columns
  const rcols: Column[] = []
  const taken = new Set(frame.columns.map((c) => c.id))
  for (const f of fields) {
    const col = columnOf(rframe, f)
    if (!col) {
      return {
        issues: [issue('join-missing-field', 'fatal',
          `Step ${at + 1} takes ${JSON.stringify(f)} from ${JSON.stringify(other.name || other.id)}, which has no such column.`,
          { at, op: 'join', column: f })],
      }
    }
    rcols.push(col)
  }

  const issues: StepIssue[] = []

  // ---- the row mapping
  let out = frame
  let matchOf: Int32Array
  if (card === 'one') {
    matchOf = new Int32Array(frame.n).fill(-1)
    let unmatched = 0
    for (let i = 0; i < frame.n; i++) {
      const b = index.get(matchKey(leftVals[i] ?? null))
      if (b) matchOf[i] = b[0]
      else unmatched++
    }
    stats.indexCells += frame.n
    if (unmatched) {
      issues.push(issue('join-unmatched', 'suspicious',
        `Step ${at + 1}: ${unmatched} of ${frame.n} row(s) found no match in ${JSON.stringify(other.name || other.id)}; their joined columns are blank. A key that misses is data telling you something.`,
        { at, op: 'join', rows: unmatched }))
    }
  } else {
    // The DECLARED fanout. Rows multiply, and that was the author's intent.
    const pos: number[] = []
    const hits: number[] = []
    let unmatched = 0
    for (let i = 0; i < frame.n; i++) {
      const b = index.get(matchKey(leftVals[i] ?? null))
      if (!b) { pos.push(i); hits.push(-1); unmatched++; continue }
      for (const r of b) { pos.push(i); hits.push(r) }
    }
    stats.indexCells += pos.length * 2
    out = reindex(frame, Int32Array.from(pos))
    matchOf = Int32Array.from(hits)
    if (pos.length !== frame.n) {
      issues.push(issue('join-fanned', 'suspicious',
        `Step ${at + 1} multiplied ${frame.n} row(s) into ${pos.length} (card: "many", as declared). Every measure below is now at the grain of ${JSON.stringify(other.name || other.id)}.`,
        { at, op: 'join', rows: pos.length - frame.n }))
    }
    if (unmatched) {
      issues.push(issue('join-unmatched', 'suspicious',
        `Step ${at + 1}: ${unmatched} row(s) found no match in ${JSON.stringify(other.name || other.id)}; their joined columns are blank.`,
        { at, op: 'join', rows: unmatched }))
    }
  }

  const derived = new Map(out.derived)
  const columns = out.columns.slice()
  for (const col of rcols) {
    const rv = rsrc.vec(col.id)!
    const id = taken.has(col.id) ? `${other.id}.${col.id}` : col.id
    const name = taken.has(col.id) ? `${other.name || other.id}.${col.name}` : col.name
    const vals: Vec = new Array<Cell>(out.n)
    for (let i = 0; i < out.n; i++) vals[i] = matchOf[i] < 0 ? null : (rv[matchOf[i]] ?? null)
    stats.retainedCells += out.n
    derived.set(id, vals)
    columns.push({ ...col, id, name } as Column)
    if (id !== col.id) {
      issues.push(issue('join-name-clash', 'suspicious',
        `Step ${at + 1}: ${JSON.stringify(col.name)} exists on both sides, so the joined one is named ${JSON.stringify(name)}.`,
        { at, op: 'join', column: id }))
    }
  }
  stats.frames++
  return { frame: { src: out.src, rows: out.rows, n: out.n, columns, derived }, issues }
}

// --- union --------------------------------------------------------------------

/**
 * `union` — rows from another sheet, appended.
 *
 * MATCHED BY COLUMN IDENTITY, not by position. SQL unions positionally because
 * a result set has no stable column identity to match on; dash's columns DO
 * have one (`Column.id` is the whole reason a rename cannot break a formula),
 * so matching positionally here would mean two sheets with the same columns in
 * a different order silently interleaving amounts with dates.
 *
 * A column present on only one side is filled blank and REPORTED. No overlap at
 * all is fatal: that is not a union, it is two tables stacked by accident.
 *
 * This step materialises, because a union genuinely is two column stores and
 * one index vector cannot address both.
 */
function stepUnion(
  frame: Frame, step: { with?: unknown; all?: unknown }, at: number, opts: RunOpts,
): StepOut {
  const refs = Array.isArray(step.with)
    ? (step.with as unknown[]).filter((x): x is string => typeof x === 'string')
    : typeof step.with === 'string' ? [step.with] : []
  if (!refs.length) {
    return { issues: [issue('union-missing-sheet', 'fatal', `Step ${at + 1} is a union with nothing to union.`, { at, op: 'union' })] }
  }
  const issues: StepIssue[] = []
  const parts: Array<{ frame: Frame; label: string }> = [{ frame, label: frame.src.name || frame.src.id }]
  for (const ref of refs) {
    const other = resolveSheet(ref, opts)
    if (!other) {
      return {
        issues: [issue('union-missing-sheet', 'fatal',
          `Step ${at + 1} unions with ${JSON.stringify(ref)}, which is not a table sheet in this workbook.`,
          { at, op: 'union' })],
      }
    }
    parts.push({ frame: frameOf(sourceOf(other)), label: other.name || other.id })
  }

  // Which columns the result has, in this frame's order, then anything new.
  const columns: Column[] = frame.columns.map((c) => ({ ...c }))
  const has = new Map<string, number>()
  frame.columns.forEach((c, i) => { has.set(unionKey(c), i) })
  for (const p of parts.slice(1)) {
    for (const c of p.frame.columns) {
      if (has.has(unionKey(c))) continue
      has.set(unionKey(c), columns.length)
      columns.push({ ...c })
    }
  }
  let shared = 0
  for (const c of parts[1].frame.columns) if (has.get(unionKey(c))! < frame.columns.length) shared++
  if (!shared) {
    return {
      issues: [issue('union-disjoint', 'fatal',
        `Step ${at + 1} unions ${JSON.stringify(parts[0].label)} with ${JSON.stringify(parts[1].label)}, and they share no columns. Stacking them would produce a table where every row is blank in half its columns.`,
        { at, op: 'union' })],
    }
  }

  const total = parts.reduce((a, p) => a + p.frame.n, 0)
  const data: Record<string, Vec> = {}
  for (const c of columns) data[c.id] = new Array<Cell>(total).fill(null)
  let w = 0
  const missing = new Set<string>()
  for (const p of parts) {
    for (const c of columns) {
      const v = values(p.frame, c.id) ?? (c.name ? values(p.frame, c.name) : undefined)
      if (!v) { missing.add(`${p.label}.${c.name || c.id}`); continue }
      const dst = data[c.id]
      for (let i = 0; i < p.frame.n; i++) dst[w + i] = v[i] ?? null
    }
    w += p.frame.n
  }
  stats.retainedCells += total * columns.length
  if (missing.size) {
    issues.push(issue('union-shape', 'suspicious',
      `Step ${at + 1}: ${[...missing].slice(0, 4).join(', ')}${missing.size > 4 ? ` and ${missing.size - 4} more` : ''} — column(s) missing on one side of the union, filled blank. Blank is not zero, and nothing below will total them as zero.`,
      { at, op: 'union' }))
  }

  // UNION ALL is the default, matching SQL. `all: false` dedupes on the whole row.
  if (step.all === false) {
    const seen = new Set<string>()
    const keep: number[] = []
    for (let i = 0; i < total; i++) {
      let k = ''
      for (const c of columns) k += matchKey(data[c.id][i]) + ''
      if (seen.has(k)) continue
      seen.add(k)
      keep.push(i)
    }
    if (keep.length !== total) {
      const out: Record<string, Vec> = {}
      for (const c of columns) {
        const src = data[c.id]
        const dst: Vec = new Array<Cell>(keep.length)
        for (let i = 0; i < keep.length; i++) dst[i] = src[keep[i]]
        out[c.id] = dst
      }
      stats.retainedCells += keep.length * columns.length
      issues.push(issue('union-deduped', 'suspicious',
        `Step ${at + 1} removed ${total - keep.length} duplicate row(s) (union, not union all).`,
        { at, op: 'union', rows: total - keep.length }))
      return { frame: tableFrame(`${frame.src.id}+union`, frame.src.name, keep.length, columns, out), issues }
    }
  }
  return { frame: tableFrame(`${frame.src.id}+union`, frame.src.name, total, columns, data), issues }
}

const unionKey = (c: Column): string => (c.name ? c.name.trim().toLowerCase() : c.id)

function resolveSheet(ref: string, opts: RunOpts): TableSheet | undefined {
  if (opts.sheets) {
    const hit = opts.sheets(ref)
    if (hit) return hit
  }
  const sheets = opts.doc?.sheets ?? []
  const byId = sheets.find((s: Sheet) => s.id === ref)
  if (byId && byId.kind === 'table') return byId
  const byName = sheets.find((s: Sheet) => s.name === ref)
  if (byName && byName.kind === 'table') return byName
  return undefined
}

// --- the runner ---------------------------------------------------------------

/**
 * Run a step list over a sheet.
 *
 * STOPS AT THE FIRST STEP IT CANNOT RUN, and hands back the frame from BEFORE
 * that step together with the finding that explains it. It never skips a step
 * and carries on: a pipeline missing its middle is not a partial answer, it is
 * a different question, and the answer to a different question looks exactly
 * like the answer to yours.
 */
export function runSteps(
  input: TableSheet | Frame, steps: readonly Step[], opts: RunOpts = {},
): StepResult {
  let frame = isFrame(input) ? input : frameOf(sourceOf(input))
  const issues: StepIssue[] = []
  let ran = 0
  let unresolved = false

  for (let at = 0; at < steps.length; at++) {
    const step = steps[at] as { op?: unknown } & Record<string, unknown>
    const op = typeof step?.op === 'string' ? step.op : ''

    if (PROVENANCE_OPS.has(op) || SETTLED_OPS.has(op)) { ran++; continue }
    if (DEFERRED_OPS.has(op)) {
      issues.push(issue('step-not-implemented', 'unresolved',
        `Step ${at + 1} is a "${op}", which this build cannot run yet. Everything below it is unresolved — the values you can see are the ones from before this step, not a result.`,
        { at, op }))
      unresolved = true
      break
    }

    let out: StepOut
    try {
      switch (op) {
        case 'filter': out = stepFilter(frame, step as never, at, opts.now); break
        case 'derive': out = stepDerive(frame, step as never, at, opts.now); break
        case 'split': out = stepSplit(frame, step as never, at); break
        case 'sort': out = stepSort(frame, step as never, at); break
        case 'limit': out = stepLimit(frame, step as never, at); break
        case 'group': out = stepGroup(frame, step as never, at); break
        case 'join': out = stepJoin(frame, step as never, at, opts); break
        case 'union': out = stepUnion(frame, step as never, at, opts); break
        default:
          // An op a NEWER build wrote. The file keeps it (PLATFORM §3) and this
          // build must not pretend to have run it — descendants are unresolved,
          // and views show last known values with a badge, never zero.
          issues.push(issue('unknown-op', 'unresolved',
            `Step ${at + 1} is a "${op || '(no op)'}", which this build does not know. It was kept in the file and NOT run; anything below it is unresolved rather than wrong.`,
            { at, op }))
          unresolved = true
          out = {}
      }
    } catch (e) {
      // A packed column, a malformed step, anything deeper. A throw reaching the
      // caller would take the whole grid down; a finding names the step.
      out = {
        issues: [issue('step-threw', 'fatal',
          `Step ${at + 1} ("${op}") could not run: ${e instanceof Error ? e.message : String(e)}`,
          { at, op })],
      }
    }
    if (out.issues) issues.push(...out.issues)
    if (unresolved) break
    const stopped = (out.issues ?? []).some((i) => i.severity === 'fatal' || i.severity === 'unresolved')
    if (stopped) {
      if ((out.issues ?? []).some((i) => i.severity === 'unresolved')) unresolved = true
      return { ok: false, frame, ran, issues, unresolved }
    }
    if (out.frame) frame = out.frame
    ran++
  }
  const ok = !unresolved && !issues.some((i) => i.severity === 'fatal')
  return { ok, frame, ran, issues, unresolved }
}

const isFrame = (v: TableSheet | Frame): v is Frame =>
  typeof (v as Frame).src === 'object' && (v as Frame).src !== null && 'vec' in (v as Frame).src

/** Run a sheet's own step list. The ordinary call. */
export function runSheet(doc: DashDoc, sheetId: string, opts: RunOpts = {}): StepResult | undefined {
  const s = doc.sheets.find((x: Sheet) => x.id === sheetId)
  if (!s || s.kind !== 'table') return undefined
  return runSteps(s, s.steps ?? [], { doc, ...opts })
}

// --- materialisation ----------------------------------------------------------

/**
 * A frame as a real sheet — what "the result is a sheet with a tab like any
 * other" means in practice.
 *
 * `enc: 'raw'`, deliberately. Dictionary encoding is what makes the FORMAT fit
 * and belongs to whatever writes this into a document; a derived sheet that has
 * not been saved yet has no such obligation, and re-interning on the way out is
 * a decision for the call site, not a hidden one here.
 *
 * ERROR CELLS ARE WRITTEN AS THEIR CODE. A `#DIV/0!` becomes the string
 * "#DIV/0!", so a saved result shows the error that produced it rather than a
 * blank the next reader will total as zero.
 */
export function materialize(frame: Frame, meta: { id: string; name: string; from?: string; steps?: Step[] }): TableSheet {
  const data: Record<string, ColumnData> = {}
  for (const c of frame.columns) {
    const v = values(frame, c.id)
    const out = new Array<number | string | boolean | null>(frame.n)
    for (let i = 0; i < frame.n; i++) {
      const x = v ? (v[i] ?? null) : null
      out[i] = isErr(x) ? String(x) : (x as number | string | boolean | null)
    }
    data[c.id] = { enc: 'raw', v: out }
  }
  return {
    id: meta.id,
    name: meta.name,
    kind: 'table',
    rids: frame.n ? [[1, frame.n]] : [],
    nextRid: frame.n + 1,
    columns: frame.columns.map((c) => ({ ...c })),
    data,
    steps: meta.steps ?? [],
    ...(meta.from ? { from: meta.from } : {}),
  }
}

export const _internals = {
  stats, resetStats, asNumber, matchKey, aggregate, fnum, reindex,
  FAST, FAST_COUNTING, AGG_ALIAS, SETTLED_OPS, DEFERRED_OPS, sortComparator,
}
