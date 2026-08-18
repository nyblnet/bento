// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Row and column STRUCTURE: insert, delete, move, resize, freeze, hide.
//
// EVERY FUNCTION HERE IS A PATCH FACTORY. It reads a sheet and returns what the
// store should commit — it never writes. That is not tidiness: the same Patch
// objects are the undo entries, the future CRDT ops and the agent API
// (store.ts:26-29), so a structural edit that mutated the document directly
// would be an edit with no inverse, no op and no way to undo it. The one
// function that writes is `applySheetProps`, and it is a store CASE BODY rather
// than a helper — it says so where it is declared.
//
// A RID IS NEVER REUSED. Row ids are what overrides (`cells["<colId>:<rid>"]`),
// notes and — soon — CRDT node identity attach to, so handing a fresh row the
// number of a deleted one resurrects the deleted row's corrections onto data
// that has nothing to do with them. That is a wrong number wearing a right
// number's clothes, which is the failure class this app exists to refuse. The
// same reasoning runs down the COLUMN axis and is sharper there, because column
// ids are not random: import mints them by slugging the header (import.ts:270),
// so re-importing a CSV after deleting a column produces the SAME id — and any
// override left behind by that delete lands on the fresh column silently. So a
// delete here takes its overrides with it, in the same commit, so undo restores
// both.
//
// BOUNDS CLAMP, IDENTITY REFUSES. A drag can legitimately run past the end of
// the sheet, so positions, counts and widths are clamped rather than thrown —
// an exception mid-gesture is a broken UI. A duplicate column id, a missing
// column, or column data whose length disagrees with the row count are caller
// bugs that corrupt the file quietly, so those throw. `applyPatch` takes the
// same line ("refusing loudly is the point").

import { RID_BLOCK } from './model.ts'
import type { Column, ColumnData, ColumnType, TableSheet } from './model.ts'
import type { Patch, Touched } from './store.ts'
import { formatValue, TYPE_LABEL } from './format.ts'

// --- shared -----------------------------------------------------------------

const rowsOf = (sheet: TableSheet): number => sheet.rids.reduce((n, [, c]) => n + c, 0)

/**
 * Every rid in row order. The run-length encoding is what makes 4200 rows cost
 * 20 bytes, but structural edits are far easier to get RIGHT on a flat list and
 * they are rare (an import, an insert, a delete) rather than per-keystroke —
 * store.ts expands for the same reason.
 */
const ridsInOrder = (sheet: TableSheet): number[] => {
  const out: number[] = []
  for (const [start, count] of sheet.rids) for (let i = 0; i < count; i++) out.push(start + i)
  return out
}

// An override key is "<colId>:<rid>", split at the FIRST colon — the same split
// applyPatch uses, so a colon in a column id cannot make these two disagree.
const colOfKey = (k: string): string => {
  const i = k.indexOf(':')
  return i < 0 ? k : k.slice(0, i)
}
const ridOfKey = (k: string): number => {
  const i = k.indexOf(':')
  return i < 0 ? NaN : Number(k.slice(i + 1))
}

const clamp = (v: number, lo: number, hi: number): number =>
  !Number.isFinite(v) ? lo : v < lo ? lo : v > hi ? hi : v

const clampInt = (v: number, lo: number, hi: number): number => Math.floor(clamp(v, lo, hi))

/**
 * `pack` is an opaque archive encoding, and applyPatch's row splices skip it
 * (store.ts:263-270 handles `raw` and `dict` only). A row inserted into a sheet
 * holding a packed column therefore shifts every OTHER column by one against
 * it: every value below the insert reads off the wrong row, invisibly, forever.
 * So this refuses at mint time. The call site promotes to `raw` first, which is
 * the policy `writeCell` already states for single-cell writes.
 */
function refusePacked(sheet: TableSheet, doing: string): void {
  for (const [id, d] of Object.entries(sheet.data)) {
    if (d.enc === 'pack') {
      throw new Error(
        `cannot ${doing} sheet "${sheet.id}": column "${id}" is packed — promote it to raw first`,
      )
    }
  }
}

// --- rows -------------------------------------------------------------------

/**
 * The next rid this sheet may mint, as a floor over everything the file can
 * still be shown to have used:
 *
 *   - the live rows;
 *   - every rid still NAMED by an override, even if its row is gone. A row
 *     deleted by a raw `deleteRows` patch (or by an older build) leaves its
 *     `cells` entries behind, and that orphan is exactly the override a reused
 *     rid would resurrect. Reading it is what makes reuse safe rather than
 *     merely unlikely;
 *   - an explicit `nextRid` stamp, if the document carries one.
 *
 * `deleteRowsAt` clears the overrides it orphans, so after a delete through
 * this module there is nothing left to resurrect and the numbers may be minted
 * again without harm. That is a TODAY argument, not a forever one: once row
 * identity is also a CRDT node key, two replicas must never mint the same rid
 * for different rows, and the water mark has to be durable. `nextRid` is read
 * here so that stamping it is a one-line change at the call site the moment a
 * patch op can write a sheet field — see SetSheetProps below.
 */
/**
 * This replica's rid block while a collaborative session is live, or `null`
 * when the document is solo.
 *
 * Module state rather than a threaded argument because minting happens deep
 * inside patch construction and the block belongs to the SESSION, not to any
 * one sheet or edit — the same shape the kernel uses for the encryption
 * password. `setRidBlock(null)` restores the solo numbering exactly.
 */
let ridBlock: { base: number; high: number } | null = null

/**
 * Point minting at an actor's block. See model.ts's rid-partitioning note.
 *
 * `high` is an in-memory high-water mark for THIS session, and it is what stops
 * a rid being reused after a delete inside the block: the durable
 * `sheet.nextRid` watermark cannot serve here, because it is a maximum across
 * every actor's rids and would push this replica straight out of its own block
 * and into someone else's.
 *
 * Across sessions the question does not arise — an actor id is fresh per
 * session instance, so a reconnecting replica gets a different block and cannot
 * collide with what it minted before.
 */
export function setRidBlock(base: number | null): void {
  ridBlock = base === null || base <= 1 ? null : { base, high: base - 1 }
}

function nextRidFloor(sheet: TableSheet): number {
  const blk = ridBlock
  if (blk) {
    // The maximum WITHIN this block. Other replicas' rids live in other blocks
    // and are irrelevant — taking a global maximum is exactly what would break
    // the partition.
    const top = blk.base + RID_BLOCK - 1
    let hi = blk.high
    const inBlock = (rid: number) => rid >= blk.base && rid <= top
    for (const [start, count] of sheet.rids) {
      const last = start + count - 1
      if (inBlock(last)) hi = Math.max(hi, last)
      else if (inBlock(start)) hi = Math.max(hi, start)
    }
    for (const k of Object.keys(sheet.cells ?? {})) {
      const rid = ridOfKey(k)
      if (Number.isFinite(rid) && inBlock(rid)) hi = Math.max(hi, rid)
    }
    blk.high = hi
    return hi + 1
  }

  let hi = 0
  for (const [start, count] of sheet.rids) hi = Math.max(hi, start + count - 1)
  for (const k of Object.keys(sheet.cells ?? {})) {
    const rid = ridOfKey(k)
    if (Number.isFinite(rid)) hi = Math.max(hi, rid)
  }
  const stamped = sheet.nextRid
  if (typeof stamped === 'number' && Number.isFinite(stamped)) hi = Math.max(hi, stamped - 1)
  return hi + 1
}

/**
 * Insert `count` blank rows so the first lands at row position `at`.
 *
 * `at` is a DATA position, not a screen row: when a sort is active the grid
 * reads through `store.order`, and "insert above the row I am looking at" has
 * to be mapped through that vector by the caller. Inserting at the position the
 * user is scrolled to would otherwise put the row somewhere else entirely.
 */
export function insertRowsAt(sheet: TableSheet, at: number, count: number): Patch[] {
  const n = Math.floor(count)
  // Nothing to do returns NOTHING, rather than an empty patch: `commit([])`
  // still pushes an undo entry, and a ⌘Z that visibly does nothing is a bug
  // report.
  if (!(n > 0)) return []
  refusePacked(sheet, 'insert rows into')

  const pos = clampInt(at, 0, rowsOf(sheet))
  const first = nextRidFloor(sheet)
  if (ridBlock) ridBlock.high = Math.max(ridBlock.high, first + n - 1)
  const rids: number[] = []
  const ats: number[] = []
  // Contiguous and ascending, so `at[i]` stays valid as earlier splices land
  // (applyPatch sorts by position) and the run-length encoding stays one run.
  for (let i = 0; i < n; i++) { rids.push(first + i); ats.push(pos + i) }
  return [{ op: 'insertRows', sheet: sheet.id, rids, at: ats }]
}

/**
 * Delete `count` rows starting at data position `at`, and every cell override
 * attached to them.
 *
 * The overrides go in the SAME commit, before the rows, so undo (which applies
 * inverses in reverse) puts the rows back first and then their corrections.
 * Leaving them behind would keep a deleted row's note, `was` value and author
 * in the shared file, and would leave a live orphan for a later rid to inherit.
 */
export function deleteRowsAt(sheet: TableSheet, at: number, count: number): Patch[] {
  const rows = rowsOf(sheet)
  const from = clampInt(at, 0, rows)
  const n = Math.min(Math.floor(count), rows - from)
  if (!(n > 0)) return []
  refusePacked(sheet, 'delete rows from')

  const rids = ridsInOrder(sheet).slice(from, from + n)
  const doomed = new Set(rids)
  const keys = Object.keys(sheet.cells ?? {}).filter((k) => doomed.has(ridOfKey(k)))

  const out: Patch[] = []
  if (keys.length) {
    out.push({
      op: 'setOverrides', sheet: sheet.id, keys,
      v: keys.map(() => undefined),
      // an apply-then-undo that leaves `"cells": {}` behind is not a round trip
      dropEmpty: true,
    })
  }
  out.push({ op: 'deleteRows', sheet: sheet.id, rids })
  return out
}

// --- columns ----------------------------------------------------------------

const dataLength = (d: ColumnData): number =>
  d.enc === 'raw' ? d.v.length : d.enc === 'dict' ? d.idx.length : d.n

/**
 * A column's stored values must be exactly as long as the sheet has rows.
 *
 * Short is ordinary — a column added to an existing sheet is blank in the rows
 * that already exist — so it is padded. Measured, a short `raw` column READS
 * the same as a padded one inside this build, because `readCell` answers `??
 * null` past the end and `splice` past the end appends; the length is what
 * differs, and the length is what leaves the building. The file is the product:
 * a column with 2 values on a 4-row sheet is malformed to every other reader of
 * that JSON — an agent, a chart binding, a re-encode to `pack`, whose `n` is
 * authoritative — and each of them has to guess whether the tail is missing or
 * blank. Padding here means nothing downstream ever has to guess.
 *
 * LONG is refused rather than trimmed. It means the values came from a
 * different sheet, a different sort or a stale read, and trimming would pick an
 * arbitrary prefix of someone's data and call it the column.
 */
function fitToRows(d: ColumnData, rows: number, colId: string): ColumnData {
  const len = dataLength(d)
  if (len === rows) return d
  if (len > rows) {
    throw new Error(`column "${colId}" carries ${len} values for a sheet with ${rows} rows`)
  }
  if (d.enc === 'pack') {
    throw new Error(`packed column "${colId}" is ${len} values short; promote it to raw first`)
  }
  const pad = Array.from({ length: rows - len }, () => null)
  // copied, never appended in place — the caller's object is not ours to grow
  return d.enc === 'raw'
    ? { enc: 'raw', v: [...d.v, ...pad] }
    : { enc: 'dict', dict: [...d.dict], idx: [...d.idx, ...pad] }
}

/**
 * Insert a column at index `at`.
 *
 * The id is refused if the sheet already has it, because `data`, `cells` and
 * `totals` are all keyed by column id: a duplicate does not collide loudly, it
 * makes two columns share one set of values and one set of overrides, and the
 * second one to be edited overwrites the first.
 */
export function insertColumn(
  sheet: TableSheet, at: number, col: Column, data?: ColumnData,
): Patch[] {
  if (sheet.columns.some((c) => c.id === col.id)) {
    throw new Error(`sheet "${sheet.id}" already has a column "${col.id}"`)
  }
  // A formula column has no stored values by design (store.ts:83-85): storing
  // them would let the file carry a number that disagrees with the expression
  // that is supposed to produce it.
  if (col.formula && data) {
    throw new Error(`column "${col.id}" has a formula, so it cannot also carry stored data`)
  }
  const pos = clampInt(at, 0, sheet.columns.length)
  const fitted = data ? fitToRows(data, rowsOf(sheet), col.id) : undefined
  return [{
    op: 'addColumn', sheet: sheet.id, column: col, at: pos,
    ...(fitted ? { data: fitted } : {}),
  }]
}

/**
 * Delete a column, its values AND its cell overrides.
 *
 * `removeColumn` alone drops `columns[i]` and `data[colId]` and stops there, so
 * every `"<colId>:<rid>"` override survives the column that gave them meaning.
 * They are not merely dead bytes: import derives column ids from the header
 * text (import.ts:270), so the very next import of the same CSV re-creates the
 * id — and the ghosts attach to fresh data as hand-made corrections, complete
 * with an author and a reason. Clearing them here, in the same commit, makes
 * the delete undoable as a whole.
 *
 * KNOWN GAP: `totals[colId]` cannot be cleared, because no patch op reaches
 * `sheet.totals`. An orphan there is invisible (the grid iterates columns) but
 * would come back with a re-imported id, so it wants the same treatment once
 * there is an op that can write it.
 */
export function deleteColumn(sheet: TableSheet, colId: string): Patch[] {
  if (!sheet.columns.some((c) => c.id === colId)) {
    throw new Error(`no column "${colId}" on sheet "${sheet.id}"`)
  }
  const keys = Object.keys(sheet.cells ?? {}).filter((k) => colOfKey(k) === colId)
  const out: Patch[] = []
  if (keys.length) {
    out.push({
      op: 'setOverrides', sheet: sheet.id, keys,
      v: keys.map(() => undefined), dropEmpty: true,
    })
  }
  out.push({ op: 'removeColumn', sheet: sheet.id, col: colId })
  return out
}

/**
 * Move a column so that it ENDS UP at index `toIndex`.
 *
 * The off-by-one lives here. Moving right and moving left are not symmetric if
 * you think in terms of the original array — remove-then-insert-at-toIndex on
 * the ORIGINAL indices lands one short when the column came from the left of
 * the target. Taking the column out FIRST and splicing into the shortened list
 * makes `toIndex` mean the same thing in both directions: the index the column
 * occupies when the move is done, which is the only definition a drag can
 * express.
 *
 * The emitted order is always a FULL permutation. `reorderColumns` rebuilds
 * `sheet.columns` from the ids it is given and filters out what it cannot find
 * (store.ts:353), so an order that omits a column DELETES it — its data stays
 * behind orphaned, and undo cannot bring it back, because the inverse is
 * rebuilt from the columns that survived.
 */
export function moveColumn(sheet: TableSheet, colId: string, toIndex: number): Patch[] {
  const ids = sheet.columns.map((c) => c.id)
  const from = ids.indexOf(colId)
  if (from < 0) throw new Error(`no column "${colId}" on sheet "${sheet.id}"`)
  // `splice` clamps its own index, so this is not what makes the move land —
  // it is what stops `to === from` being compared against NaN or a fraction,
  // which would emit a patch that reorders nothing.
  const to = clampInt(toIndex, 0, ids.length - 1)
  if (to === from) return []
  // spliced by POSITION, not filtered by id: a frozen document is never id-
  // repaired (model.ts:470), so duplicate ids exist and a filter would remove
  // both of them.
  const order = ids.slice()
  order.splice(from, 1)
  order.splice(to, 0, colId)
  return [{ op: 'reorderColumns', sheet: sheet.id, order }]
}

/** Below this a column cannot show its own sort arrow; above it, nothing fits beside it. */
const MIN_W = 56
const MAX_W = 420

/**
 * Set a column's rendered width.
 *
 * Clamped and rounded rather than validated: this arrives from a live drag, so
 * a value out of range is normal and an exception is a broken gesture. A
 * non-finite width from a drag computation is clamped for a sharper reason —
 * `JSON.stringify(NaN)` is `null`, so it would reach the file as `"w": null`
 * and the grid would emit `width:nullpx`. Integers keep the JSON small and make
 * a resize idempotent.
 */
export function resizeColumn(sheet: TableSheet, colId: string, w: number): Patch {
  if (!sheet.columns.some((c) => c.id === colId)) {
    throw new Error(`no column "${colId}" on sheet "${sheet.id}"`)
  }
  return {
    op: 'setColumn', sheet: sheet.id, col: colId,
    patch: { w: Math.round(clamp(w, MIN_W, MAX_W)) },
  }
}

// --- auto-fit ---------------------------------------------------------------
//
// THIS IS AN ESTIMATE, and deliberately a pure one. There is no DOM here — the
// rigs run in node and this file is the half of the app that has to stay
// testable — so width is counted in characters against a per-type weight
// instead of measured. The UI may and should refine it with a real measurement
// (a canvas `measureText` over the visible rows costs nothing at 40 rows); it
// is one number and nothing downstream depends on how it was arrived at.
// Weights are biased HIGH by roughly a character, because a column a few pixels
// too wide looks fine and a column a few pixels too narrow clips a digit — and
// a clipped digit is a wrong number.

/** px per character at the grid's body size. Digits are wider than lowercase. */
const CHAR_W: Record<ColumnType, number> = {
  text: 7.2, enum: 7.2, date: 7.4, bool: 8, number: 8, money: 8, percent: 8,
}
/** The header is the name plus the type control, and it must not clip either. */
const HEAD_CHAR_W = 7.6
const HEAD_CHROME = 34
/** left + right cell padding, plus a character of slack */
const CELL_PAD = 20
/**
 * Rows read per column. A full pass over 250k rows to fit one column is a
 * visible stall, and the sample is spread by STRIDE rather than taken off the
 * top: a CSV sorted by date or name keeps its longest values at the end, and a
 * first-N sample gets those columns wrong every time. The last row is always
 * read, because that is where an appended total or a "grand total" label sits.
 */
const SAMPLE = 500

export function autoFitWidth(
  get: (row: number) => unknown,
  col: Column,
  rows: number,
  opts?: { max?: number },
): number {
  // TYPE_LABEL is the English label; a localized one is a few px different and
  // that is inside the slack this estimate already carries.
  let widest = col.name.length * HEAD_CHAR_W
    + (TYPE_LABEL[col.type] ?? String(col.type ?? '')).length * 6.2 + HEAD_CHROME
    + (col.formula ? 18 : 0) + (col.failed ? 14 : 0)

  const n = Math.max(0, Math.floor(rows))
  const stride = Math.max(1, Math.ceil(n / SAMPLE))
  const w = CHAR_W[col.type] ?? CHAR_W.text
  const measure = (row: number): void => {
    const v = get(row)
    if (v == null) return
    // formatted, not raw: the reader sees "$1,234.50" where the model holds
    // 1234.5, and it is the rendered string that has to fit
    const s = formatValue(v, col)
    const px = s.length * w + CELL_PAD
    if (px > widest) widest = px
  }
  for (let i = 0; i < n; i += stride) measure(i)
  if (n > 0) measure(n - 1)

  return Math.ceil(clamp(widest, MIN_W, Math.max(MIN_W, opts?.max ?? MAX_W)))
}

// --- sheet-level state: freeze --------------------------------------------
//
// THE ONE OP THIS MODULE NEEDS THAT `Patch` DOES NOT HAVE. Freeze is sheet
// state — frozen ROWS cannot be expressed as a column field — and `Patch`
// reaches exactly four places in the document: cell values, cell overrides,
// column objects and `doc.measures`/`doc.title`. Nothing writes a sheet field.
//
// So `setSheetProps` is declared here rather than faked. It is one case in
// `applyPatch`, whose whole body is `applySheetProps` below:
//
//     case 'setSheetProps': return applySheetProps(table(doc, p.sheet), p)
//
// and one member on the `Patch` union. Until it lands, `SheetPatch` is the
// honest return type — a union that COLLAPSES to `Patch` the moment store.ts
// adopts the op, so nothing has to change here or at the call sites. The
// alternative was casting a foreign op to `Patch`, which compiles and then
// throws at commit time: an edit the user believes landed.

export interface SetSheetProps {
  op: 'setSheetProps'
  sheet: string
  /** keys to SET */
  props: Record<string, unknown>
  /**
   * keys to DELETE, listed rather than set to `undefined`, because these
   * objects are also the wire format: `JSON.stringify({frozen: undefined})`
   * drops the key entirely and the delete would arrive as a no-op.
   */
  drop?: string[]
}

export type SheetPatch = Patch | SetSheetProps

/**
 * Sheet keys `setSheetProps` refuses. Structure moves through the typed patches
 * that know how to invert it — a props op that could rewrite `data` or `rids`
 * would be an unbounded edit carrying an unbounded inverse, and the byte-capped
 * history exists precisely to prevent that.
 */
const STRUCTURAL = new Set(['id', 'kind', 'columns', 'data', 'rids', 'cells', 'steps'])

/**
 * The store case body for `setSheetProps` — the ONLY function in this file that
 * writes, and it writes because `applyPatch` does. Returns the inverse, built
 * from what it displaced, in the shape `applyPatch` returns.
 */
export function applySheetProps(
  sheet: TableSheet, p: SetSheetProps,
): { inverse: SetSheetProps; touched: Touched } {
  const s = sheet as unknown as Record<string, unknown>
  const props: Record<string, unknown> = {}
  const drop: string[] = []
  const dropping = new Set(p.drop ?? [])

  const displace = (k: string): void => {
    if (STRUCTURAL.has(k)) {
      throw new Error(`setSheetProps may not write "${k}" — structure moves through typed patches`)
    }
    // absent, so the inverse must DELETE rather than restore `undefined`:
    // apply-then-undo has to leave the file byte-identical, and a key holding
    // undefined is a key the next writer sees
    if (k in s) props[k] = s[k]
    else drop.push(k)
  }

  for (const k of Object.keys(p.props)) {
    if (dropping.has(k)) throw new Error(`setSheetProps sets and drops "${k}" in one patch`)
    if (p.props[k] === undefined) {
      // Deleting has exactly ONE spelling, and it is `drop`. Accepting this as
      // a delete too would mean the same intent travels two ways, one of which
      // (`JSON.stringify({k: undefined})`) evaporates on the wire — the delete
      // would land locally and reach no other replica. Refusing is how that
      // stays impossible rather than merely discouraged.
      throw new Error(`setSheetProps: to remove "${k}" list it in \`drop\`, not props`)
    }
    displace(k)
    s[k] = p.props[k]
  }
  for (const k of dropping) {
    displace(k)
    delete s[k]
  }
  return {
    inverse: { op: 'setSheetProps', sheet: p.sheet, props, ...(drop.length ? { drop } : {}) },
    touched: { sheet: p.sheet, structural: true },
  }
}

export interface Frozen {
  rows: number
  cols: number
}

/**
 * Read the frozen panes, defensively: this is an additive field, so an older
 * build, a hand edit or a future one can put anything there and the grid still
 * has to draw. Anything unreadable means "not frozen", which is the state every
 * reader can agree on.
 */
export function readFrozen(sheet: TableSheet): Frozen {
  const f = sheet.frozen
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return { rows: 0, cols: 0 }
  const o = f as Record<string, unknown>
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
  return { rows: num(o.rows), cols: num(o.cols) }
}

/**
 * Freeze `rows` rows and `cols` columns of this sheet.
 *
 * Clamped to leave at least one row and one column FREE, which is Excel's rule
 * and, here, a correctness fix rather than politeness: a pane that freezes
 * everything leaves nothing to scroll, so a stray `frozen.rows` of 1e9 (a bad
 * drag, a hand-edited file) would render a grid that cannot move.
 *
 * Freezing nothing DROPS the field instead of storing zeroes. An additive field
 * that means "no" should be absent — otherwise freezing and unfreezing leaves
 * the file changed, every reader diffs it, and collab ships an op for a
 * document that is back where it started.
 */
export function freezeAt(sheet: TableSheet, rows: number, cols: number): SheetPatch {
  const r = clampInt(rows, 0, Math.max(0, rowsOf(sheet) - 1))
  const c = clampInt(cols, 0, Math.max(0, sheet.columns.length - 1))
  return r === 0 && c === 0
    ? { op: 'setSheetProps', sheet: sheet.id, props: {}, drop: ['frozen'] }
    : { op: 'setSheetProps', sheet: sheet.id, props: { frozen: { rows: r, cols: c } } }
}

// --- hidden columns ---------------------------------------------------------
//
// Hiding is DOCUMENT data, not view state, and that is the opposite call from
// sorting. A sort belongs to the reader (store.ts's `view()`), but hiding a
// column is an editorial act — the author decided the working column is not
// part of the story — and two people opening one file have to see the same
// grid or they are reading different documents. It rides on the COLUMN, where
// unknown fields survive a round trip (model.ts:90), so a build that has never
// heard of hiding still preserves it.

export function hiddenSet(sheet: TableSheet): Set<string> {
  const out = new Set<string>()
  for (const c of sheet.columns) if (c.hidden === true) out.add(c.id)
  return out
}

/**
 * Show or hide one column.
 *
 * Showing writes `undefined`, not `false`: `JSON.stringify` omits an undefined
 * value, so a column that was hidden and shown again leaves the file exactly as
 * it found it. `false` would be honest in memory and would accumulate a dead
 * flag on every column anyone ever touched, in every saved copy, forever.
 */
export function setHidden(sheet: TableSheet, colId: string, hidden: boolean): Patch {
  if (!sheet.columns.some((c) => c.id === colId)) {
    throw new Error(`no column "${colId}" on sheet "${sheet.id}"`)
  }
  // `undefined` is NOT a value JSON can carry: JSON.stringify drops the key,
  // so `{hidden: undefined}` arrives as `{}` and the un-hide becomes a silent
  // no-op over any wire — a saved file, a collaboration op, the agent API.
  // Send `false`. (This file solves the identical hazard for `w` above.)
  return {
    op: 'setColumn', sheet: sheet.id, col: colId,
    patch: { hidden },
  }
}

/** Exposed for the rig, as store.ts does — not part of the app's surface. */
export const _internals = {
  nextRidFloor, ridsInOrder, fitToRows, MIN_W, MAX_W, SAMPLE, CHAR_W,
}
