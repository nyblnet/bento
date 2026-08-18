// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento-sync for dash — the CRDT engine. Pure data, no DOM, no imports beyond
// the model types and the store's own writer, so the same file runs in the
// browser session layer and in the node convergence rig
// (scripts/test-dash-sync.ts, node --experimental-strip-types).
//
// Design, rationale and the honest list of what LOSES DATA: docs/dash-collab.md.
// Read that before changing anything here.
//
// WHY THIS IS NOT slides/src/sync/crdt.ts
//
// Slides' engine keys per-element nodes and diffs two whole-document snapshots.
// Neither transfers. A dash workbook is COLUMNAR and dictionary-encoded: cell
// values live in per-column arrays addressed by ROW POSITION, and the document
// is routinely 10-25 MB. Two consequences set the whole shape of this file:
//
//   1. NO SNAPSHOT DIFFING. `JSON.stringify(doc)` costs ~10 ms on a 12 MB
//      workbook (store.ts measured it, which is why history here is typed
//      inverses rather than snapshots) and a shadow copy doubles resident
//      memory. So ops are minted from the store's `Patch` objects, which are
//      already a complete, position-independent description of every mutation.
//      The store's comment predicted this: "The same Patch objects are the undo
//      entries, the future CRDT ops and the agent API."
//
//   2. STATE MUST BE O(EDITS), NEVER O(ROWS). Anything per-row — an order key,
//      a birth stamp, a shadow value — is multiplied by a million. The saved
//      state also rides in the FILE (`collab.sync`), so O(rows) state would
//      undo the entire point of the 4.8-bytes-per-cell encoding. Therefore a
//      row that nobody has touched costs ZERO bytes here: rows get state only
//      when an op inserts or deletes them, and cells only when an op writes
//      them.
//
// THE ALGEBRA
//
//   - Node identity. `@doc`; `s␟<sheet>`; `c␟<sheet>␟<col>`; `r␟<sheet>␟<rid>`.
//     Column ids are SHEET-scoped (model.ts:478 — two sheets may both call a
//     column `c1`) and so are rids, so both are composite. This is slides'
//     lesson (bare ids collapsed the morph idiom) applied before it could bite.
//
//   - Cells are PROPERTIES OF THE ROW NODE, keyed by column id: register
//     `r␟s1␟7 ⟹ v␟price`. That is per-cell last-writer-wins for free, out of
//     exactly the same (lamport, actor) register machinery slides uses for
//     `x`/`fill`. Cell overrides (the `cells` overlay) are a second key space
//     on the same node, `o␟price`.
//
//   - Row ORDER is a FRACTIONAL INDEX over rids, and the trick that makes it
//     affordable is that most rows never get one. rids are minted at insert
//     and NEVER reused (rowcol.ts is emphatic about this), which is what makes
//     them usable as identity at all. A row that came with the file takes its
//     key from its position in the adopted baseline sequence (`base`, one
//     run-length list per sheet — 20 bytes for 4200 rows), so it costs
//     nothing; only an INSERTED row stores an explicit key, minted between its
//     neighbours' keys. Order is then `sort by (key, rid)`, a pure function of
//     converged state. Cost: O(inserts) + O(sheets).
//
//     Two earlier designs failed here and the rig caught both, which is why
//     the third is spelled out. (1) An LWW register over the whole `rids`
//     list: concurrent structural edits silently drop one side's rows.
//     (2) An RGA whose inserts name an ANCHOR RID, with deleted anchors
//     resolved by walking back to the anchor's own anchor — that walk lands a
//     row ahead of rows which used to sit in between, and two replicas that
//     applied the deletes in different orders disagreed (seed 16 of 20).
//     A fractional key needs neither tombstone nor chain: neighbours may die
//     without moving anything, because the key already sits between them.
//
//   - Sheets and columns are few, so they get slides' fractional `pos` keys
//     verbatim (keyBetween/spreadKey copied below — dash cannot import from
//     slides/, and PLATFORM §9 says genericizing the engine is its own
//     project).
//
//   - Liveness is births vs tombs, highest (l,a) wins — delete beats
//     concurrent edits, an insert is a whole-node assignment that resurrects
//     by out-stamping the tomb. Values displaced during a node's dead window
//     park in `stash` and replay on resurrection only while their register is
//     still the winner. All three rules are slides', which earned them.
//
//   - Delivery is per-actor contiguous `s` with a gap buffer, plus a `pending`
//     buffer for ops naming a node we have not seen yet. Also slides'.
//
// WHAT WRITES THE DOCUMENT. Structural changes and cell writes go through the
// store's own `applyPatch` — deliberately, because rowcol.ts already names the
// failure: "Two copies of one op is how the inverse and the forward drift
// apart." A second row-splicer here would have to know about run-length rids,
// dictionary interning and dictLen truncation, and would silently diverge from
// the local path the first time either changed. Plain property sets are
// assigned directly (there is no patch that can express "delete this key" —
// `setSheetProps` refuses `undefined` on purpose — and the CRDT must be able
// to.)

import { applyPatch, readCell, type Patch } from '../store.ts'
import type { CellOverride, Column, ColumnData, DashDoc, Sheet, TableSheet } from '../model.ts'

/**
 * Sync format version — stamped into SyncStateJSON (`v`) and every wire frame
 * (`pv`). Mismatched state and frames are DISCARDED on sight rather than
 * misread: the file still opens, it simply rejoins as a fresh adopt. Same rule
 * as slides' SYNC_V and model.ts's frozen-policy handling.
 */
export const SYNC_V = 1

export const DOC_NODE = '@doc'

/** node-id separator. U+001F cannot appear in a sheet/column id: import mints
 *  them by slugging (import.ts) and the parser repairs anything else. */
const NS = '\u001f'

export const shNode = (sheet: string): string => `s${NS}${sheet}`
export const colNode = (sheet: string, col: string): string => `c${NS}${sheet}${NS}${col}`
export const rowNode = (sheet: string, rid: number): string => `r${NS}${sheet}${NS}${rid}`
/** cell-value key on a row node */
const vKey = (col: string): string => `v${NS}${col}`
/** cell-override key on a row node */
const oKey = (col: string): string => `o${NS}${col}`
const isVKey = (k: string): boolean => k.charCodeAt(0) === 118 /* 'v' */ && k[1] === NS
const keyCol = (k: string): string => k.slice(2)

/** sheet id out of a sheet/column/row node id */
const nodeSheet = (node: string): string => {
  const i = node.indexOf(NS)
  const j = node.indexOf(NS, i + 1)
  return j < 0 ? node.slice(i + 1) : node.slice(i + 1, j)
}
const nodeTail = (node: string): string => node.slice(node.indexOf(NS, node.indexOf(NS) + 1) + 1)

/* eslint-disable no-console */
const dbg = (id: string, msg: string) => {
  const g = globalThis as unknown as { __dbgNode?: string; __dbgTag?: string }
  // comma-separated so one run can watch a row and the column that fights it
  if (g.__dbgNode && g.__dbgNode.split(',').includes(id)) console.log(`      [dbg ${g.__dbgTag ?? ''} ${msg}]`)
}

// ---------------------------------------------------------------------------
// fractional order keys — base-62 midstrings (copied from slides/src/sync/crdt.ts;
// pure functions, no behaviour change, and the two engines must agree on
// nothing so the duplication is inert)
// ---------------------------------------------------------------------------

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const D = (c: string) => DIGITS.indexOf(c)

/** A key strictly between `a` and `b` ('' = unbounded on that side). */
export function keyBetween(a: string, b: string): string {
  let out = ''
  for (let i = 0; ; i++) {
    const da = i < a.length ? D(a[i]) : 0
    const db = i < b.length ? D(b[i]) : 62
    if (da === db) { out += DIGITS[da]; continue }
    if (db - da > 1) return out + DIGITS[Math.floor((da + db) / 2)]
    out += DIGITS[da]
    for (let j = i + 1; ; j++) {
      const ta = j < a.length ? D(a[j]) : 0
      if (62 - ta > 1) return out + DIGITS[Math.floor((ta + 62) / 2)]
      out += DIGITS[ta]
    }
  }
}

/** Deterministic evenly-spread key for index i of n (file adoption). */
export function spreadKey(i: number, n: number): string {
  let v = (i + 1) / (n + 1)
  let out = ''
  const need = Math.max(2, Math.ceil(Math.log(n + 2) / Math.log(62)) + 1)
  for (let k = 0; k < need; k++) {
    v *= 62
    const d = Math.min(61, Math.floor(v))
    out += DIGITS[d]
    v -= d
  }
  while (out.length > 1 && out.endsWith('0')) out = out.slice(0, -1)
  return out === '0' ? '1' : out
}

// ---------------------------------------------------------------------------
// run-length rid helpers
// ---------------------------------------------------------------------------

export type Rle = Array<[number, number]>

const rleCount = (rle: Rle): number => rle.reduce((n, [, c]) => n + c, 0)

const rleExpand = (rle: Rle): number[] => {
  const out: number[] = []
  for (const [start, count] of rle) for (let i = 0; i < count; i++) out.push(start + i)
  return out
}

const rleCompress = (flat: number[]): Rle => {
  const out: Rle = []
  for (const rid of flat) {
    const tail = out[out.length - 1]
    if (tail && tail[0] + tail[1] === rid) tail[1]++
    else out.push([rid, 1])
  }
  return out
}

/** position of `rid`, or -1. Walks runs, so it is O(runs) not O(rows). */
const rleIndex = (rle: Rle, rid: number): number => {
  let i = 0
  for (const [start, count] of rle) {
    if (rid >= start && rid < start + count) return i + (rid - start)
    i += count
  }
  return -1
}

/** rid at position `i`, or 0. */
const rleAt = (rle: Rle, i: number): number => {
  if (i < 0) return 0
  let seen = 0
  for (const [start, count] of rle) {
    if (i < seen + count) return start + (i - seen)
    seen += count
  }
  return 0
}

const rleHas = (rle: Rle, rid: number): boolean => rleIndex(rle, rid) >= 0

// ---------------------------------------------------------------------------
// ops
// ---------------------------------------------------------------------------

export type Reg = [number, string] // [lamport, actor]

const newer = (l: number, a: string, r: Reg | undefined): boolean =>
  !r || l > r[0] || (l === r[0] && a > r[1])
/**
 * Strictly older than the register — the test a property write must use.
 *
 * Not `!newer(...)`: that also rejects the register's OWN op, and an op can be
 * re-applied legitimately. A value gated behind a dead node advances the
 * register and parks, and when the node comes back the parked op replays with
 * exactly the stamp already recorded. `!newer` swallowed it, so the value
 * arrived nowhere while a replica that saw the resurrection first kept it.
 * Re-applying an op is idempotent by construction — same stamp, same value.
 */
const older = (l: number, a: string, r: Reg | undefined): boolean =>
  !!r && (l < r[0] || (l === r[0] && a < r[1]))
const regNewer = (x: Reg, y: Reg | undefined): boolean => newer(x[0], x[1], y)
const cmpReg = (x: Reg, y: Reg): number => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0)

export interface OpBase {
  a: string // actor
  s: number // per-actor contiguous sequence (delivery / version vector)
  l: number // lamport (conflict order)
}

/** per-(node, key) LWW register. `n` absent = the document node. `v` absent =
 *  delete the key — the one spelling of a delete, because `JSON.stringify`
 *  erases `{k: undefined}` and a delete that evaporates on the wire lands on
 *  one replica only (rowcol.ts met this hazard twice and says so). */
export interface SetOp extends OpBase { op: 'set'; n?: string; k: string; v?: unknown }

/** cell VALUES for one column: per-(row, column) LWW. Many rids per op because
 *  a paste or a fill-down is one gesture and must be one undo step, one op. */
export interface CellOp extends OpBase { op: 'cell'; sh: string; col: string; rids: number[]; v: unknown[] }

/** cell OVERRIDES (the `cells` overlay), keys `<colId>:<rid>` exactly as the
 *  document stores them. `null` deletes (and is what survives JSON). */
export interface OvrOp extends OpBase { op: 'ovr'; sh: string; keys: string[]; v: Array<CellOverride | null> }

/**
 * Row insert. `ord[i]` is the row's fractional key, never a position:
 * positions shift under concurrency and a key does not. `vals` is colId → one
 * value per rid, the shape store.ts's insertRows patch already carries.
 */
export interface RinsOp extends OpBase {
  op: 'rins'; sh: string; rids: number[]; ord: string[]
  vals?: Record<string, unknown[]>
}

/** Row delete. Carries nothing but the rids: a fractional key needs no
 *  tombstone to stay meaningful, so a dead row leaves nothing behind but its
 *  tombstone stamp. */
export interface RdelOp extends OpBase { op: 'rdel'; sh: string; rids: number[] }

/**
 * Sheet or column insert (the node id says which).
 *
 * A COLUMN insert carries metadata only — never its values. Its values follow
 * as an ordinary `cell` op, minted in the same commit. That is a deliberate
 * narrowing: while a column payload assigned cells, every cell in the sheet
 * had TWO possible owners (the column's payload and the row's), the answer
 * depended on which insert out-stamped the other, and the rig kept finding
 * orderings where two replicas disagreed about a number. With values riding as
 * cell ops there is exactly one writer per cell and the register decides, as
 * it does for everything else.
 *
 * The price, stated plainly: adding a fully-populated column mints one
 * register per cell, so a 100k-row column costs ~100k register entries in the
 * sync state (and in `collab.sync` if the file is saved mid-session). Adding
 * columns in bulk is what IMPORT does, and import creates a whole SHEET, whose
 * insert does carry its rows wholesale. See docs/dash-collab.md.
 */
export interface InsOp extends OpBase {
  op: 'ins'; n: string; ord: string
  node: Sheet | Column
  /**
   * A column's storage ENCODING (never its values). The receiver creates the
   * column empty in this encoding and the cell op fills it. Without it a
   * re-created column could come back `raw` on one replica and `dict` on
   * another, and then the same write lands as the number 5795 here and the
   * string "5795" there — dictionary storage interns through String().
   */
  enc?: 'raw' | 'dict'
}
export interface DelOp extends OpBase { op: 'del'; n: string }
export interface OrdOp extends OpBase { op: 'ord'; n: string; ord: string }

export type Op = SetOp | CellOp | OvrOp | RinsOp | RdelOp | InsOp | DelOp | OrdOp

// ---------------------------------------------------------------------------
// serializable state
// ---------------------------------------------------------------------------

interface PosEntry { p: string; o: string; r: Reg }

export interface SyncStateJSON {
  v: number
  lamport: number
  vv: Record<string, number>
  /** NESTED by node, so a row's twelve cell registers name the row once. The
   *  flat `"<node> <key>"` map slides uses would repeat a 40-byte composite
   *  row-node id per cell — measurable in a file, not in a deck. */
  regs: Record<string, Record<string, Reg>>
  pos: Record<string, PosEntry>
  births: Record<string, Reg>
  tombs: Record<string, Reg>
  /** inserted row node → its fractional order key. Baseline rows are absent
   *  and derive theirs from `base`, which is the whole scaling trick. */
  rpos: Record<string, string>
  /**
   * inserted row node → the columns its insert actually carried.
   *
   * One entry per inserted ROW (a dozen short ids), not one per cell, which is
   * what keeps this O(inserts). It is what makes "the insert supersedes older
   * writes" precise: an insert minted before a column existed says nothing
   * about that column, and must not out-stamp a value written into it.
   */
  rnamed: Record<string, string[]>
  /** sheet id → the row sequence as ADOPTED (from the file, or from a sheet
   *  insert's payload). Gives baseline rows the anchor they never had an op
   *  for. Run-length encoded: 20 bytes for 4200 rows. */
  base: Record<string, Rle>
  stash: Record<string, Record<string, { v?: unknown; r: Reg }>>
}

export interface ApplyResult {
  changed: boolean
  /** rows/columns/sheets appeared or moved — the grid must relayout, not repaint */
  structure: boolean
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T)

// ---------------------------------------------------------------------------

export class DashSync {
  actor: string
  lamport = 0
  vv: Record<string, number> = {}
  private seq = 0
  regs: Record<string, Record<string, Reg>> = {}
  pos: Record<string, PosEntry> = {}
  births: Record<string, Reg> = {}
  tombs: Record<string, Reg> = {}
  rpos: Record<string, string> = {}
  rnamed: Record<string, string[]> = {}
  base: Record<string, Rle> = {}
  stash: Record<string, Record<string, { v?: unknown; r: Reg }>> = {}
  /** ops naming a node we have not seen yet, keyed by node id */
  private pending: Record<string, Op[]> = {}
  /** out-of-order ops per actor awaiting their gap to fill */
  private gap: Record<string, Op[]> = {}
  /**
   * Per-sheet row order as of the last mutation we know about — the PRE-state
   * a local delete needs (it has to read the cell values it displaces before
   * the store removes them) and the list an insert's anchors are read off.
   * Run-length encoded, so a 4200-row sheet is 20 bytes here too.
   */
  private rids: Record<string, Rle> = {}
  /**
   * Local structural changes waiting for the store to apply them.
   *
   * `local()` runs BEFORE the store mutates the document, so it cannot do the
   * reclaiming that the remote paths do inline. The session calls settle()
   * straight after the commit and these are replayed there.
   */
  private localRows: Array<{ sh: string; rid: number; birth: Reg; named: string[]; vals: Record<string, unknown> }> = []
  private localCols: Array<{ sh: string; col: string; birth: Reg; enc?: 'raw' | 'dict'; rids: number[]; vals: unknown[] }> = []
  /**
   * A local patch this engine cannot express as ops (a future patch op, or one
   * of the store's reserved `applySteps`/`refreshBinding`). The session ships a
   * state snapshot instead of silently dropping the change — an edit the user
   * believes landed is the one failure mode worth extra machinery.
   */
  unsynced = false

  /** base-62-safe form of the actor id, appended to every minted order key */
  private keySuffix: string

  constructor(actor: string) {
    this.actor = actor
    this.keySuffix = actor.replace(/[^0-9A-Za-z]/g, '') || '1'
  }

  /** actors with buffered out-of-order ops → catch-up should be requested */
  get gappedActors(): string[] {
    return Object.keys(this.gap).filter((a) => this.gap[a].length)
  }

  /** dead iff the latest delete out-stamps the latest insert */
  dead(node: string): boolean {
    const t = this.tombs[node]
    if (!t) return false
    const b = this.births[node]
    return !b || !regNewer(b, t)
  }

  /** did the insert that created this row carry a value for `col`? */
  private rowNames(node: string, col: string): boolean {
    const l = this.rnamed[node]
    return !!l && l.includes(col)
  }

  private reg(node: string, key: string): Reg | undefined {
    return this.regs[node]?.[key]
  }
  private setReg(node: string, key: string, r: Reg): void {
    ;(this.regs[node] ??= {})[key] = r
  }

  toJSON(): SyncStateJSON {
    return {
      v: SYNC_V,
      lamport: this.lamport,
      vv: this.vv,
      regs: this.regs,
      pos: this.pos,
      births: this.births,
      tombs: this.tombs,
      rpos: this.rpos,
      rnamed: this.rnamed,
      base: this.base,
      stash: this.stash,
    }
  }

  static fromJSON(actor: string, j: SyncStateJSON): DashSync {
    const s = new DashSync(actor)
    if (!j || j.v !== SYNC_V) return s // unreadable state: rejoin as a fresh adopt
    s.lamport = j.lamport ?? 0
    s.vv = j.vv ?? {}
    s.seq = s.vv[actor] ?? 0
    s.regs = j.regs ?? {}
    s.pos = j.pos ?? {}
    s.births = j.births ?? {}
    s.tombs = j.tombs ?? {}
    s.rpos = j.rpos ?? {}
    s.rnamed = j.rnamed ?? {}
    s.base = j.base ?? {}
    s.stash = j.stash ?? {}
    return s
  }

  // --- adoption ------------------------------------------------------------

  /**
   * Adopt a document that has never synced: deterministic pos keys from the
   * current array order (two readers of one file derive the same keys) with
   * the null register [0,''] that loses to every real op.
   *
   * ROWS GET NOTHING, and that is the whole scaling decision. Their order is
   * the file's own `rids`, which every replica of that file already agrees on,
   * so an untouched row costs zero bytes of sync state.
   */
  adopt(doc: DashDoc): void {
    const ns = doc.sheets.length
    doc.sheets.forEach((s, i) => {
      const sn = shNode(s.id)
      if (!this.pos[sn]) this.pos[sn] = { p: DOC_NODE, o: spreadKey(i, ns), r: [0, ''] }
      if (s.kind !== 'table') return
      // the baseline sequence: what every replica of THIS file agrees the row
      // order was before anybody edited it
      this.base[s.id] ??= clone(s.rids)
      this.seedColumnPos(s)
    })
    this.snapRids(doc)
  }

  /**
   * Give a table sheet's columns their deterministic order keys.
   *
   * Every replica must do this for every sheet it ever holds, however the
   * sheet arrived — from the file, from a peer's insert, or from a snapshot.
   * Miss one and the column order stops being a function of the keys: the
   * replica that MINTED an addColumn keeps the store's array position while
   * everyone else sorts by keys the payload's columns never got, and the two
   * show the same columns in different orders.
   */
  private seedColumnPos(sheet: Sheet): void {
    if (sheet.kind !== 'table') return
    const sn = shNode(sheet.id)
    const n = sheet.columns.length
    sheet.columns.forEach((c, j) => {
      const cn = colNode(sheet.id, c.id)
      if (!this.pos[cn]) this.pos[cn] = { p: sn, o: spreadKey(j, n), r: [0, ''] }
    })
  }

  /**
   * Refresh the row-order shadow, and drop an override overlay that has been
   * emptied.
   *
   * `cells: {}` is not a state the document should ever be in: an empty
   * overlay is the absence of an overlay. It arises because `setOverrides`'s
   * INVERSE only carries `dropEmpty` when the container did not exist before
   * the patch, so undoing the removal of the last override leaves the empty
   * object behind — on the undoing replica alone, since every peer receives
   * the op through a path that always drops it. A twelve-byte difference in
   * the saved file, and a diverged fingerprint. (The real fix is one flag in
   * store.ts; see docs/dash-collab.md.)
   */
  private snapRids(doc: DashDoc): void {
    const seen = new Set<string>()
    for (const s of doc.sheets) {
      if (s.kind !== 'table') continue
      seen.add(s.id)
      if (s.cells && !Object.keys(s.cells).length) delete s.cells
      // The watermark joins here, on every settle point, because it is
      // document data that a plain monotonic counter cannot converge — see
      // settleWatermark.
      settleWatermark(s, this.births)
      this.rids[s.id] = clone(s.rids)
    }
    for (const id of Object.keys(this.rids)) if (!seen.has(id)) delete this.rids[id]
  }

  // --- local op minting ----------------------------------------------------

  private stamp(): OpBase {
    this.lamport++
    this.seq++
    this.vv[this.actor] = this.seq
    return { a: this.actor, s: this.seq, l: this.lamport }
  }

  /**
   * Mint ops for patches the store is ABOUT TO APPLY.
   *
   * Pre-apply, deliberately, and it is the one ordering subtlety in this file:
   * a delete has to read what it displaces (the row's registered cell values
   * park in the stash so a later resurrection can lose to them) and a delete's
   * `prev` anchors have to be read before the rows go. Everything else is
   * indifferent. The engine keeps its own run-length row shadow so it never
   * needs to look at a post-state.
   */
  local(doc: DashDoc, patches: Patch[]): Op[] {
    const ops: Op[] = []
    for (const p of patches) this.localOne(doc, p, ops)
    return ops
  }

  private localOne(doc: DashDoc, p: Patch, ops: Op[]): void {
    const push = <T extends Op>(o: T): T => { ops.push(o); return o }
    switch (p.op) {
      case 'setCells': {
        // dictLen is a local undo artefact (it truncates a dictionary this edit
        // grew); shipping it would truncate the RECEIVER's dictionary, which
        // has a different length. Values are the wire format, never indices.
        //
        // It also has to be DISARMED HERE, on the patch the store is about to
        // apply, and that is not tidiness — it is a silent data loss.
        //
        // A dictionary column's `idx` array points into a dictionary SHARED by
        // every cell in the column, and `applyPatch` honours `dictLen` with a
        // blunt `data.dict.length = p.dictLen`. That is sound for one writer:
        // the only entries above the watermark are the ones this patch interned,
        // and undo unwinds edits in the order they were made, so the dictionary
        // is always exactly the length the inverse expects. Under collaboration
        // it is false. A remote `cell` op that lands BETWEEN a local commit and
        // its undo interns its own strings into the same dictionary, above the
        // watermark the inverse recorded — so the undo drops them, and every
        // cell pointing at them reads back null. It is asymmetric by
        // construction: only the undoing replica truncates, only the values it
        // did not author are lost, and NOTHING in the sync state changes — no
        // register moves, no birth, no tomb — so the two replicas end up with
        // identical sync states and different workbooks. That is exactly the
        // shape of rig seeds 124 (ACTORS=4, STEPS=250) and 307 (ACTORS=5,
        // STEPS=300): a text column with two blanks where a peer's values were,
        // and every other field in agreement.
        //
        // The neighbouring guess — that the loss was in the column dead-window
        // path (resetColumnValues/parkColumn) — was wrong; the column in both
        // seeds was never deleted at all. The undo that loses the values need
        // not even name the affected rows.
        //
        // Disarming costs the orphaned strings (the dictionary no longer shrinks
        // back), which store.ts already calls "semantically right and no longer
        // byte-identical". A live session has given that up regardless: two
        // replicas intern in the order their ops arrive, so their dictionaries
        // never matched byte-for-byte — which is why the rig's fingerprint
        // compares materialized values, not encodings.
        delete p.dictLen
        const o = push<CellOp>({ ...this.stamp(), op: 'cell', sh: p.sheet, col: p.col, rids: p.rids.slice(), v: clone(p.v) })
        p.rids.forEach((rid) => this.setReg(rowNode(p.sheet, rid), vKey(p.col), [o.l, o.a]))
        break
      }
      case 'setOverrides': {
        const o = push<OvrOp>({
          ...this.stamp(), op: 'ovr', sh: p.sheet, keys: p.keys.slice(),
          v: p.keys.map((_, i) => (p.v[i] ?? null) as CellOverride | null),
        })
        p.keys.forEach((k) => {
          const col = k.slice(0, k.indexOf(':'))
          const rid = Number(k.slice(k.indexOf(':') + 1))
          this.setReg(rowNode(p.sheet, rid), oKey(col), [o.l, o.a])
        })
        break
      }
      case 'insertRows': {
        const before = this.rids[p.sheet] ?? []
        // Simulate the store's own splice (store.ts insertRows: ascending by
        // position, each `at` a position in the GROWING list) so the keys are
        // minted between the right neighbours — including rows inserted
        // earlier in this same patch, which is why the keys are assigned in
        // the same ascending pass rather than up front.
        const flat = rleExpand(before)
        const order = p.rids.map((rid, i) => ({ rid, at: p.at?.[i] ?? flat.length + i, i }))
          .sort((a, b) => a.at - b.at)
        const ord: string[] = new Array(p.rids.length).fill('')
        for (const { rid, at, i } of order) {
          const pos = Math.min(at, flat.length)
          const lo = pos > 0 ? this.rowKey(p.sheet, flat[pos - 1]) : ''
          const hi = pos < flat.length ? this.rowKey(p.sheet, flat[pos]) : ''
          // The actor suffix is not decoration. Two replicas inserting between
          // the same neighbours compute the SAME midstring, and then the list
          // each one materialises depends on which rows it happened to have —
          // one replica's sequence stops being sorted by key and every later
          // binary search lands somewhere else (rig seed 42). Suffixing makes
          // every key unique, so the sequence is sorted by construction on
          // every replica. Safe to append: keyBetween never returns a key that
          // is a prefix of its upper bound, so extending it cannot overshoot.
          const key = keyBetween(lo, hi) + this.keySuffix
          ord[i] = key
          this.rpos[rowNode(p.sheet, rid)] = key
          flat.splice(pos, 0, rid)
        }
        const o = push<RinsOp>({
          ...this.stamp(), op: 'rins', sh: p.sheet, rids: p.rids.slice(), ord,
          ...(p.values ? { vals: clone(p.values) } : {}),
        })
        p.rids.forEach((rid) => {
          const n = rowNode(p.sheet, rid)
          dbg(n, `local rins@${o.l} vals=${JSON.stringify(Object.fromEntries(Object.entries(p.values ?? {}).map(([c, a]) => [c, a[p.rids.indexOf(rid)]])))}`)
          this.births[n] = [o.l, o.a]
          this.rnamed[n] = Object.keys(p.values ?? {})
          // NOT `delete this.stash[n]`: values parked for columns this insert
          // does not carry still belong to the row, and settle() is what puts
          // them back. Dropping them here left the author of an undo showing a
          // blank cell that every collaborator could see filled in.
          const at = p.rids.indexOf(rid)
          const vals: Record<string, unknown> = {}
          for (const [col, arr] of Object.entries(p.values ?? {})) vals[col] = arr[at]
          this.localRows.push({ sh: p.sheet, rid, birth: [o.l, o.a], named: this.rnamed[n], vals })
        })
        this.rids[p.sheet] = rleCompress(flat)
        break
      }
      case 'deleteRows': {
        const before = this.rids[p.sheet] ?? []
        const sheet = tableOf(doc, p.sheet)
        const o = push<RdelOp>({ ...this.stamp(), op: 'rdel', sh: p.sheet, rids: p.rids.slice() })
        p.rids.forEach((rid) => {
          const n = rowNode(p.sheet, rid)
          dbg(n, `local rdel@${o.l}`)
          if (sheet) this.stashRow(sheet, p.sheet, rid)
          this.tombs[n] = [o.l, o.a]
        })
        const flat = rleExpand(before).filter((r) => !p.rids.includes(r))
        this.rids[p.sheet] = rleCompress(flat)
        break
      }
      case 'addColumn': {
        const sheet = tableOf(doc, p.sheet)
        const ids = sheet ? sheet.columns.map((c) => c.id) : []
        const at = p.at ?? ids.length
        ids.splice(at, 0, p.column.id)
        const ord = this.keyAround(shNode(p.sheet), ids.map((id) => colNode(p.sheet, id)), at)
        const n = colNode(p.sheet, p.column.id)
        const o = push<InsOp>({
          ...this.stamp(), op: 'ins', n, ord, node: clone(p.column),
          // `pack` is an author-chosen archive encoding that cannot be written
          // into (store.ts refuses); a synced column comes back writable.
          ...(p.data ? { enc: p.data.enc === 'dict' ? 'dict' as const : 'raw' as const } : {}),
        })
        // The values follow as a cell op — see InsOp. Nulls are skipped: a
        // blank needs no register, and a fresh column is blank everywhere.
        const keep: number[] = []
        const vals: unknown[] = []
        if (p.data) {
          const rids = rleExpand(this.rids[p.sheet] ?? [])
          rids.forEach((rid, i) => {
            const v = readCell(p.data!, i)
            if (v === null || v === undefined) return
            keep.push(rid)
            vals.push(v)
          })
          if (keep.length) {
            const c = push<CellOp>({ ...this.stamp(), op: 'cell', sh: p.sheet, col: p.column.id, rids: keep, v: clone(vals) })
            keep.forEach((rid) => this.setReg(rowNode(p.sheet, rid), vKey(p.column.id), [c.l, c.a]))
          }
        }
        this.births[n] = [o.l, o.a]
        this.pos[n] = { p: shNode(p.sheet), o: ord, r: [o.l, o.a] }
        delete this.stash[n]
        this.localCols.push({
          sh: p.sheet, col: p.column.id, birth: [o.l, o.a],
          ...(p.data ? { enc: p.data.enc === 'dict' ? 'dict' as const : 'raw' as const } : {}),
          rids: keep, vals: clone(vals),
        })
        break
      }
      case 'removeColumn': {
        const n = colNode(p.sheet, p.col)
        const sheet = tableOf(doc, p.sheet)
        const col = sheet?.columns.find((c) => c.id === p.col)
        const o = push<DelOp>({ ...this.stamp(), op: 'del', n })
        if (sheet) this.parkColumn(sheet, p.col)
        if (col) this.stashNode(col as unknown as Record<string, unknown>, n)
        this.tombs[n] = [o.l, o.a]
        break
      }
      case 'reorderColumns': {
        this.diffOrder(p.order.map((id) => colNode(p.sheet, id)), shNode(p.sheet), push)
        break
      }
      case 'setColumn': {
        const n = colNode(p.sheet, p.col)
        for (const [k, v] of Object.entries(p.patch)) {
          const o = push<SetOp>({ ...this.stamp(), op: 'set', n, k, ...(v === undefined ? {} : { v: clone(v) }) })
          this.setReg(n, k, [o.l, o.a])
        }
        break
      }
      case 'setSheetProps': {
        const n = shNode(p.sheet)
        for (const [k, v] of Object.entries(p.props)) {
          const o = push<SetOp>({ ...this.stamp(), op: 'set', n, k, v: clone(v) })
          this.setReg(n, k, [o.l, o.a])
        }
        for (const k of p.drop ?? []) {
          const o = push<SetOp>({ ...this.stamp(), op: 'set', n, k })
          this.setReg(n, k, [o.l, o.a])
        }
        break
      }
      case 'setMeasure': {
        const k = `measures.${p.name}`
        const o = push<SetOp>({ ...this.stamp(), op: 'set', k, ...(p.measure === undefined ? {} : { v: clone(p.measure) }) })
        this.setReg(DOC_NODE, k, [o.l, o.a])
        break
      }
      case 'setTitle': {
        const o = push<SetOp>({ ...this.stamp(), op: 'set', k: 'title', v: p.title })
        this.setReg(DOC_NODE, 'title', [o.l, o.a])
        break
      }
      default:
        // applySteps / refreshBinding (the store refuses both today), or a
        // patch op a future build minted. Never silently dropped: the session
        // ships a whole-state snapshot, which is slower and always correct.
        this.unsynced = true
        break
    }
  }

  /** Sheets are added by `replaceDoc` today (there is no addSheet patch), so
   *  their ops are minted explicitly by the session's structural reconciler. */
  sheetIns(doc: DashDoc, sheet: Sheet): InsOp {
    const ids = doc.sheets.map((s) => shNode(s.id))
    const at = doc.sheets.findIndex((s) => s.id === sheet.id)
    const ord = this.keyAround(DOC_NODE, ids, at < 0 ? ids.length : at)
    const n = shNode(sheet.id)
    const o: InsOp = { ...this.stamp(), op: 'ins', n, ord, node: clone(sheet) }
    this.births[n] = [o.l, o.a]
    this.pos[n] = { p: DOC_NODE, o: ord, r: [o.l, o.a] }
    delete this.stash[n]
    if (sheet.kind === 'table') {
      this.rids[sheet.id] = clone(sheet.rids)
      this.base[sheet.id] ??= clone(sheet.rids)
      this.seedColumnPos(sheet)
    }
    return o
  }

  sheetDel(sheetId: string): DelOp {
    const n = shNode(sheetId)
    const o: DelOp = { ...this.stamp(), op: 'del', n }
    this.tombs[n] = [o.l, o.a]
    delete this.rids[sheetId]
    return o
  }

  /** ord key for position i within `nodes` under parent `p` */
  private keyAround(p: string, nodes: string[], i: number): string {
    const ordOf = (n: string | undefined) =>
      n && this.pos[n] && this.pos[n].p === p ? this.pos[n].o : undefined
    let lo = ''
    for (let k = i - 1; k >= 0; k--) { const o = ordOf(nodes[k]); if (o) { lo = o; break } }
    let hi = ''
    for (let k = i + 1; k < nodes.length; k++) {
      const o = ordOf(nodes[k])
      if (o && (!lo || o > lo)) { hi = o; break }
    }
    return keyBetween(lo, hi)
  }

  /** Emit ord ops for nodes whose relative order changed: keep a longest
   *  increasing run (by current pos key) untouched, re-key the rest. */
  private diffOrder(nodes: string[], parent: string, push: <T extends Op>(o: T) => T): void {
    if (nodes.some((n) => !this.pos[n])) return // unknown — keyed elsewhere
    const keys = nodes.map((n) => this.pos[n].o + ' ' + n)
    const keep = new Set(longestIncreasing(keys))
    for (let i = 0; i < nodes.length; i++) {
      if (keep.has(i) && this.pos[nodes[i]].p === parent) continue
      let lo = ''
      for (let k = i - 1; k >= 0; k--) {
        const e = this.pos[nodes[k]]
        if (e && e.p === parent) { lo = e.o; break }
      }
      let hi = ''
      for (let k = i + 1; k < nodes.length; k++) {
        if (!keep.has(k)) continue
        const e = this.pos[nodes[k]]
        if (e && e.p === parent && e.o > lo) { hi = e.o; break }
      }
      const ord = keyBetween(lo, hi)
      const o = push<OrdOp>({ ...this.stamp(), op: 'ord', n: nodes[i], ord })
      this.pos[nodes[i]] = { p: parent, o: ord, r: [o.l, o.a] }
    }
  }

  // --- applying remote ops -------------------------------------------------

  apply(doc: DashDoc, ops: Op[]): ApplyResult {
    const res: ApplyResult = { changed: false, structure: false }
    for (const op of ops) this.applyOne(doc, op, res)
    this.reconcileParked(doc)
    if (res.structure) this.rematerialize(doc)
    this.snapRids(doc)
    return res
  }

  private applyOne(doc: DashDoc, op: Op, res: ApplyResult): void {
    if (op.a === this.actor) return // our own ops are pre-applied at mint time
    const seen = this.vv[op.a] ?? 0
    if (op.s <= seen) return // duplicate
    if (op.s > seen + 1) {
      const g = (this.gap[op.a] ??= [])
      if (!g.some((o) => o.s === op.s)) { g.push(op); g.sort((x, y) => x.s - y.s) }
      return
    }
    this.vv[op.a] = op.s
    this.lamport = Math.max(this.lamport, op.l)
    this.applyEffect(doc, op, res)
    const g = this.gap[op.a]
    while (g && g.length && g[0].s === this.vv[op.a] + 1) {
      const next = g.shift()!
      this.vv[op.a] = next.s
      this.lamport = Math.max(this.lamport, next.l)
      this.applyEffect(doc, next, res)
    }
  }

  private applyEffect(doc: DashDoc, op: Op, res: ApplyResult): void {
    switch (op.op) {
      case 'set': this.applySet(doc, op, res); break
      case 'cell': this.applyCell(doc, op, res); break
      case 'ovr': this.applyOvr(doc, op, res); break
      case 'rins': this.applyRins(doc, op, res); break
      case 'rdel': this.applyRdel(doc, op, res); break
      case 'ins': this.applyIns(doc, op, res); break
      case 'del': this.applyDel(doc, op, res); break
      case 'ord': this.applyOrd(doc, op, res); break
    }
  }

  private pend(node: string, op: Op): void {
    dbg(node, `PEND ${op.op}@${op.l},${op.a}`)
    ;(this.pending[node] ??= []).push(op)
  }

  /**
   * Drain everything parked on a sheet's members.
   *
   * A row that arrives INSIDE a sheet payload has no insert op of its own, so
   * nothing ever fires the per-row drain for it — an override that raced ahead
   * of the sheet stayed parked forever on the replicas that received it early,
   * and only the author kept it. Sheet-level events therefore have to sweep
   * the whole namespace, not just their own node.
   */
  private drainSheet(doc: DashDoc, sheetId: string): void {
    const rows = rowNode(sheetId, 0).slice(0, -1)
    const cols = colNode(sheetId, '')
    for (const node of Object.keys(this.pending)) {
      if (node.startsWith(rows) || node.startsWith(cols)) this.drainPending(doc, node)
    }
  }

  private drainPending(doc: DashDoc, node: string, res?: ApplyResult): void {
    const ps = this.pending[node]
    if (!ps) return
    delete this.pending[node]
    const r: ApplyResult = res ?? { changed: false, structure: false }
    for (const p of ps) this.applyEffect(doc, p, r)
  }

  /**
   * Retry every parked op after a LOCAL change has been applied.
   *
   * Remote ops park on nodes we have not seen; the drains that release them
   * all hang off remote events. A row brought back by the user's own undo
   * fires none of them, so an override or a cell edit waiting on that row
   * stayed parked forever — on the peers that received it early, and only
   * there (rig seed 57). The session calls this right after the store has
   * applied a local commit; the queue is O(edits) and an op that still cannot
   * land simply parks again.
   */
  settle(doc: DashDoc): ApplyResult {
    const res: ApplyResult = { changed: false, structure: false }
    // (snapRids at the foot of this method performs the watermark join)
    for (const { sh, rid, birth, named, vals } of this.localRows.splice(0)) {
      const sheet = tableOf(doc, sh)
      if (!sheet || !rleHas(sheet.rids, rid)) continue
      this.replayStashRow(doc, sheet, sh, rid, birth, new Set(named))
      // The remote path's park, for the local one: a value the insert carried
      // for a column that does not exist here has nowhere to go, and applyPatch
      // simply drops it. Park it against the row's birth so the column's
      // arrival can claim it — the author of an insert must end up with the
      // same cells as everyone who received it.
      for (const col of named) {
        if (sheet.data[col]) continue
        const st = (this.stash[rowNode(sh, rid)] ??= {})
        // Same rule as the remote path: a parked write NEWER than this insert
        // out-stamps the insert's claim on the column and must survive it.
        const cur = st[vKey(col)]
        if (cur && regNewer(cur.r, birth)) continue
        st[vKey(col)] = { v: clone(vals[col] ?? null), r: clone(birth) }
      }
    }
    for (const { sh, col, birth, enc, rids, vals } of this.localCols.splice(0)) {
      const sheet = tableOf(doc, sh)
      if (!sheet || !sheet.columns.some((c) => c.id === col)) continue
      // The author of a column insert takes the SAME path as everyone who
      // receives it: reset to the encoding, then apply the values the op
      // carries. The store has already written `p.data` here, and if that
      // snapshot was stale (undo of a delete, rows changed since) the author
      // would otherwise be the only participant holding the stale version.
      this.resetColumnValues(doc, sheet, col, birth, enc)
      const live = rids.filter((rid) => rleHas(sheet.rids, rid))
      if (live.length && sheet.data[col]) {
        applyPatch(doc, {
          op: 'setCells', sheet: sh, col, rids: live,
          v: live.map((rid) => clone(vals[rids.indexOf(rid)])),
        })
      }
    }
    for (const node of Object.keys(this.pending)) this.drainPending(doc, node, res)
    this.reconcileParked(doc)
    if (res.structure) this.rematerialize(doc)
    this.snapRids(doc)
    return res
  }

  // --- property sets --------------------------------------------------------

  private applySet(doc: DashDoc, op: SetOp, res: ApplyResult): void {
    const node = op.n ?? DOC_NODE
    if (older(op.l, op.a, this.reg(node, op.k))) return
    if (node === DOC_NODE) {
      this.setReg(node, op.k, [op.l, op.a])
      writeDocKey(doc, op.k, op.v)
      res.changed = true
      return
    }
    // birth gate: an ins is a whole-node assignment, so sets older than the
    // node's (re)birth are superseded everywhere (the register still advances)
    const birth = this.births[node]
    if (birth && !newer(op.l, op.a, birth)) { this.setReg(node, op.k, [op.l, op.a]); return }
    if (this.dead(node)) {
      this.setReg(node, op.k, [op.l, op.a])
      ;(this.stash[node] ??= {})[op.k] =
        op.v === undefined ? { r: [op.l, op.a] } : { v: clone(op.v), r: [op.l, op.a] }
      return
    }
    const sheetId = nodeSheet(node)
    if (this.dead(shNode(sheetId))) {
      // The sheet is gone, so there is nothing to write — but the register
      // must still advance, or the replica that applied this op BEFORE the
      // sheet died would carry a register its peers never learn and the two
      // states would disagree forever about a value neither can see.
      this.setReg(node, op.k, [op.l, op.a])
      ;(this.stash[node] ??= {})[op.k] =
        op.v === undefined ? { r: [op.l, op.a] } : { v: clone(op.v), r: [op.l, op.a] }
      return
    }
    const sheet = doc.sheets.find((s) => s.id === sheetId)
    if (!sheet) { this.pend(shNode(sheetId), op); return }
    let target: Record<string, unknown> | undefined
    if (node[0] === 's') target = sheet as unknown as Record<string, unknown>
    else {
      if (sheet.kind !== 'table') return
      target = sheet.columns.find((c) => c.id === nodeTail(node)) as unknown as Record<string, unknown> | undefined
      if (!target) { this.pend(node, op); return }
    }
    this.setReg(node, op.k, [op.l, op.a])
    writeKey(target, op.k, op.v)
    res.changed = true
    if (node[0] === 's') res.structure = true // sheet name/frozen/condfmt all relayout
  }

  // --- cells ----------------------------------------------------------------

  private applyCell(doc: DashDoc, op: CellOp, res: ApplyResult): void {
    const sheet = tableOf(doc, op.sh)
    // A missing sheet is two different situations and they must not be
    // conflated: DEAD means every replica will agree it is gone, so the op is
    // book-kept and dropped; ABSENT means its insert is still in flight, so
    // the op waits (applyDel/applyIns both drain this queue).
    if (!sheet && !this.dead(shNode(op.sh))) { this.pend(shNode(op.sh), op); return }
    // A formula column stores no values (model.ts: storing them would let a
    // file carry a number that disagrees with the formula) — nothing to write,
    // and applyPatch would throw. The register still advances so state converges.
    // The COLUMN is the other half of a cell's identity, so it gates the op the
    // same way the sheet does. Absent-and-not-dead means its insert is still in
    // flight: pend WITHOUT advancing any register, or the drained op would find
    // its own register already recorded and skip itself — the value would be
    // dropped on this replica and kept on the sender's, which is how one
    // workbook ends up with a number the other has never heard of.
    if (sheet && !sheet.columns.some((c) => c.id === op.col)) {
      if (!this.dead(colNode(op.sh, op.col))) { this.pend(colNode(op.sh, op.col), op); return }
    }
    // A column insert carries the whole column's values, so it is a whole-node
    // assignment for every cell in it: writes older than the (re)birth lose,
    // exactly as they do against a row's birth.
    const colBirth = this.births[colNode(op.sh, op.col)]
    const colDead = this.dead(colNode(op.sh, op.col))
    // A column insert is a whole-column event: writes minted before it are
    // superseded, exactly as a row insert supersedes writes to the row.
    const superseded = colBirth !== undefined && !newer(op.l, op.a, colBirth)
    const hasData = !!sheet?.data[op.col]
    const live: number[] = []
    const liveV: unknown[] = []
    for (let i = 0; i < op.rids.length; i++) {
      const rid = op.rids[i]
      const node = rowNode(op.sh, rid)
      const key = vKey(op.col)
      if (older(op.l, op.a, this.reg(node, key))) continue
      // The row's insert supersedes older writes ONLY into the columns it
      // carried; a write into any other column is untouched by it.
      const birth = this.births[node]
      if (birth && !newer(op.l, op.a, birth) && this.rowNames(node, op.col)) {
        this.setReg(node, key, [op.l, op.a])
        continue
      }
      if (this.dead(node)) {
        this.setReg(node, key, [op.l, op.a])
        ;(this.stash[node] ??= {})[key] = { v: clone(op.v[i]), r: [op.l, op.a] }
        continue
      }
      if (!sheet || superseded) { this.setReg(node, key, [op.l, op.a]); continue }
      if (colDead) {
        // Buried HERE — but an undo may already have revived it elsewhere, and
        // this write may out-stamp that revival, in which case the replicas
        // that got them the other way round keep it. So advance the register
        // (states converge) and PARK the op on the column: if the column comes
        // back the write replays, and if it does not the op simply never runs.
        // Dropping it instead cost exactly one replica exactly one number.
        this.setReg(node, key, [op.l, op.a])
        this.pend(colNode(op.sh, op.col), { ...op, rids: [rid], v: [op.v[i]] })
        continue
      }
      if (!rleHas(sheet!.rids, rid)) {
        // the row's insert has not arrived yet (cross-actor delivery race)
        this.pend(node, { ...op, rids: [rid], v: [op.v[i]] })
        continue
      }
      this.setReg(node, key, [op.l, op.a])
      live.push(rid)
      liveV.push(op.v[i])
    }
    if (!live.length || !hasData) return
    applyPatch(doc, { op: 'setCells', sheet: op.sh, col: op.col, rids: live, v: clone(liveV) })
    res.changed = true
  }

  private applyOvr(doc: DashDoc, op: OvrOp, res: ApplyResult): void {
    const sheet = tableOf(doc, op.sh)
    if (!sheet && !this.dead(shNode(op.sh))) { this.pend(shNode(op.sh), op); return }
    const cols = new Set(op.keys.map((k) => k.slice(0, k.indexOf(':'))))
    for (const c of cols) {
      if (sheet && !sheet.columns.some((x) => x.id === c) && !this.dead(colNode(op.sh, c))) {
        this.pend(colNode(op.sh, c), op)
        return
      }
    }
    const keys: string[] = []
    const vals: Array<CellOverride | null> = []
    for (let i = 0; i < op.keys.length; i++) {
      const k = op.keys[i]
      const col = k.slice(0, k.indexOf(':'))
      const rid = Number(k.slice(k.indexOf(':') + 1))
      const node = rowNode(op.sh, rid)
      const key = oKey(col)
      if (older(op.l, op.a, this.reg(node, key))) continue
      // Overrides are not carried by a row insert, but a row's DEATH takes
      // them with it (killRowOverrides), so a rebirth does supersede an older
      // one — no `rnamed` exception here, unlike cell values.
      const birth = this.births[node]
      if (birth && !newer(op.l, op.a, birth)) { this.setReg(node, key, [op.l, op.a]); continue }
      if (this.dead(node)) {
        this.setReg(node, key, [op.l, op.a])
        ;(this.stash[node] ??= {})[key] = { v: clone(op.v[i]), r: [op.l, op.a] }
        continue
      }
      if (!sheet) { this.setReg(node, key, [op.l, op.a]); continue } // the sheet is gone
      const cb = this.births[colNode(op.sh, col)]
      if (cb && !newer(op.l, op.a, cb)) { this.setReg(node, key, [op.l, op.a]); continue } // superseded
      if (this.dead(colNode(op.sh, col))) { // buried here — park it, see applyCell
        this.setReg(node, key, [op.l, op.a])
        this.pend(colNode(op.sh, col), { ...op, keys: [k], v: [op.v[i]] })
        continue
      }
      if (!rleHas(sheet.rids, rid)) { this.pend(node, { ...op, keys: [k], v: [op.v[i]] }); continue }
      this.setReg(node, key, [op.l, op.a])
      keys.push(k)
      vals.push(op.v[i])
    }
    if (!keys.length) return
    applyPatch(doc, { op: 'setOverrides', sheet: op.sh, keys, v: clone(vals), dropEmpty: true })
    res.changed = true
  }

  // --- rows -----------------------------------------------------------------

  /**
   * A row's fractional order key.
   *
   * Explicit for inserted rows; DERIVED for the rows that came with the sheet,
   * from their position in the adopted baseline. That derivation is the reason
   * a million-row workbook costs nothing to sync until somebody edits it.
   */
  /** Exposed for the convergence rig's sortedness invariant — not an app
   *  surface. The rig asserts, after every apply, that a sheet's `rids` really
   *  is sorted by (key, rid); a binary search over a list that is not sorted
   *  lands anywhere, which is how row order diverges while every register
   *  agrees. */
  rowOrderKey(sh: string, rid: number): string { return this.rowKey(sh, rid) }

  private rowKey(sh: string, rid: number): string {
    const explicit = this.rpos[rowNode(sh, rid)]
    if (explicit !== undefined) return explicit
    const b = this.base[sh]
    if (b) {
      const i = rleIndex(b, rid)
      if (i >= 0) return spreadKey(i, rleCount(b))
    }
    // No baseline (state discarded, or a hand-built sheet): fall back to the
    // rid itself so the order is at least stable and total. Padded so that 9
    // sorts before 10 — an unpadded number sorts lexicographically and would
    // put row 10 before row 9.
    return `~${String(rid).padStart(12, '0')}`
  }

  /** where a key belongs in a sheet's live sequence (binary search: the list is
   *  always sorted by (key, rid), and rleAt walks runs, not rows) */
  private rowIndexFor(sheet: TableSheet, sh: string, key: string, rid: number): number {
    const after = (at: number): boolean => {
      const other = rleAt(sheet.rids, at)
      const k = this.rowKey(sh, other)
      return k < key || (k === key && other < rid)
    }
    let lo = 0
    let hi = rleCount(sheet.rids)
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (after(mid)) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /**
   * Move a row that is already in the sheet to where its (new) key says it
   * belongs.
   *
   * Only a resurrection can change a live row's key, so this is rare — but it
   * has to rebuild the column arrays, because a row's VALUES are addressed by
   * position and moving the rid alone would hand every row below the move
   * somebody else's numbers. `permuteRows` is the same routine the snapshot
   * merge uses: one pass per column, dictionaries kept intact, `pack` columns
   * left alone.
   */
  private relocateRow(sheet: TableSheet, sh: string, rid: number): void {
    const flat = rleExpand(sheet.rids)
    const at = flat.indexOf(rid)
    if (at < 0) return
    flat.splice(at, 1)
    const key = this.rowKey(sh, rid)
    let lo = 0
    let hi = flat.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const other = flat[mid]
      const k = this.rowKey(sh, other)
      if (k < key || (k === key && other < rid)) lo = mid + 1
      else hi = mid
    }
    if (lo === at) return
    flat.splice(lo, 0, rid)
    permuteRows(sheet, flat)
  }

  private applyRins(doc: DashDoc, op: RinsOp, res: ApplyResult): void {
    const sheet = tableOf(doc, op.sh)
    const stamp: Reg = [op.l, op.a]
    if (!sheet && !this.dead(shNode(op.sh))) { this.pend(shNode(op.sh), op); return }
    for (let i = 0; i < op.rids.length; i++) {
      const rid = op.rids[i]
      const node = rowNode(op.sh, rid)
      const birth = this.births[node]
      if (birth && !newer(op.l, op.a, birth)) continue // an older create
      const wasKey = this.rpos[node]
      this.births[node] = stamp
      this.rpos[node] = op.ord[i]
      this.rnamed[node] = Object.keys(op.vals ?? {})
      res.changed = true
      res.structure = true
      // A delete still out-stamps this insert. The key is recorded above
      // regardless, so ops waiting on this row can resolve now.
      if (!sheet || this.dead(node)) { this.drainPending(doc, node); continue }
      if (rleHas(sheet.rids, rid)) {
        // ALREADY HERE — and the winning insert has just given the row a NEW
        // key, so the row has to MOVE to match it. Recording the key and
        // leaving the row where it sat is what broke row order at six actors
        // (rig seed 116).
        //
        // The asymmetry is exact and invisible in the sync state, because the
        // key both replicas end up holding is the same one. A row deleted and
        // then resurrected by TWO actors gets two competing `rins`, and the
        // higher (lamport, actor) wins the key everywhere. But a replica that
        // received the loser FIRST already has the row in the document, so the
        // winner arrives down this branch and only updated `rpos`; a replica
        // that received the winner first placed the row by binary search at the
        // winning key and then discarded the loser at the "an older create"
        // gate. Same `rpos`, same births, same tombs — two different sequences.
        //
        // Worse than one row in the wrong place: `rids` is now no longer sorted
        // by (key, rid), and `rowIndexFor` is a BINARY SEARCH that assumes it
        // is. Every later insert on that replica lands somewhere arbitrary, so
        // one stale key spreads into a wholly different row order. That is why
        // it took six actors to see — it needs two concurrent resurrections of
        // one row plus a later insert to amplify.
        if (wasKey !== op.ord[i]) this.relocateRow(sheet, op.sh, rid)
        continue
      }
      const idx = this.rowIndexFor(sheet, op.sh, op.ord[i], rid)
      const vals: Record<string, unknown[]> = {}
      for (const [col, arr] of Object.entries(op.vals ?? {})) vals[col] = [clone(arr[i])]
      const named = new Set(Object.keys(vals))
      // Where a row insert and a column insert cross, the newer one owns the
      // cell. The column's payload is empty by construction, so "the column
      // wins" means the cell is left blank for its own cell op to fill.
      for (const col of named) {
        const cb = this.births[colNode(op.sh, col)]
        if (cb && !regNewer(stamp, cb)) { delete vals[col]; named.delete(col) }
      }
      dbg(node, `rins@${op.l},${op.a} ord=${op.ord[i]} at=${idx} vals=${JSON.stringify(vals)}`)
      applyPatch(doc, { op: 'insertRows', sheet: op.sh, rids: [rid], at: [idx], values: vals })
      this.replayStashRow(doc, sheet, op.sh, rid, stamp, named)
      // A value for a column whose insert has not arrived has nowhere to go —
      // applyPatch writes only into columns that exist — so park it against
      // this row's birth and let the column's arrival claim it. AFTER the
      // replay, which clears the stash it just consumed. Nulls are parked too:
      // the parked entry is also the RECORD that this row's insert claimed the
      // column, which is what tells the arriving column to stand down.
      for (const col of named) {
        if (sheet.data[col]) continue
        const st = (this.stash[node] ??= {})
        // NEVER clobber a parked entry that is NEWER than this insert. The
        // insert claims the column, but a write minted after it out-stamps the
        // claim, and the parked copy may be the only one left: on the author of
        // that write the value was applied straight to a live document and was
        // never pended anywhere, so overwriting it here deleted it outright,
        // while every replica that received the write while the column was
        // buried still had it queued on the column node and replayed it when
        // the column came back. Rig seed 163 (ACTORS=6, STEPS=250): five
        // replicas holding a number and its own author holding a blank.
        // parkColumn has always carried the equivalent rule.
        const cur = st[vKey(col)]
        if (cur && regNewer(cur.r, stamp)) continue
        st[vKey(col)] = { v: clone(vals[col]?.[0] ?? null), r: clone(stamp) }
      }
      this.drainPending(doc, node)
    }
  }

  private applyRdel(doc: DashDoc, op: RdelOp, res: ApplyResult): void {
    const sheet = tableOf(doc, op.sh)
    if (!sheet && !this.dead(shNode(op.sh))) { this.pend(shNode(op.sh), op); return }
    const gone: number[] = []
    for (let i = 0; i < op.rids.length; i++) {
      const rid = op.rids[i]
      const node = rowNode(op.sh, rid)
      if (!this.tombs[node] || newer(op.l, op.a, this.tombs[node])) this.tombs[node] = [op.l, op.a]
      if (!this.dead(node)) continue
      if (sheet && rleHas(sheet.rids, rid)) {
        this.stashRow(sheet, op.sh, rid)
        gone.push(rid)
      }
      this.drainPending(doc, node)
    }
    if (gone.length) {
      dropRowOverrides(doc, sheet!, gone)
      applyPatch(doc, { op: 'deleteRows', sheet: op.sh, rids: gone })
    }
    res.changed = true
    res.structure = true
  }

  /**
   * Who currently owns a cell's value?
   *
   * A cell sits in the intersection of TWO whole-node assignments — the row's
   * insert payload and the COLUMN's insert payload — so the authority is
   * max(cell register, column birth, row birth). But an assignment only claims
   * the cells it actually NAMES: a row insert minted before a column existed
   * says nothing about that column, and must not blank it. `fromRow` is that
   * distinction — the caller knows whether the row's payload carried this
   * column, because it is holding the payload. Without this the answer depended on arrival order, both ways round:
   * a replica that got the column insert after a row's resurrection wrote the
   * row payload's blank over a number all its peers could see (seed 18), and a
   * replica that got a row insert before the column existed dropped the value
   * the row was carrying for it (seed 36). Neither is recoverable later, which
   * is why both are parked rather than resolved on the spot.
   */
  private cellAuth(sh: string, rid: number, key: string, fromRow = true): Reg | undefined {
    const r = this.reg(rowNode(sh, rid), key)
    if (!isVKey(key) || !fromRow) return r
    const b = this.births[rowNode(sh, rid)]
    return r && (!b || regNewer(r, b)) ? r : b
  }

  /**
   * Park a dying row's cell values so a later resurrection can lose to them.
   *
   * Registered cells (somebody typed in them) and cells owned by a column that
   * was created after the row — everything whose authority might out-stamp the
   * insert that brings the row back. Cells nobody has touched, in columns older
   * than the row, have no authority to record and cost nothing here: that is
   * what keeps the state O(edits) on a sheet with a million untouched rows.
   */
  private stashRow(sheet: TableSheet, sh: string, rid: number): void {
    const node = rowNode(sh, rid)
    const at = rleIndex(sheet.rids, rid)
    if (at < 0) return
    const keys = new Set(Object.keys(this.regs[node] ?? {}))
    for (const c of this.rnamed[node] ?? []) keys.add(vKey(c))
    if (!keys.size) return
    const st = (this.stash[node] ??= {})
    for (const k of keys) {
      // `rnamed` again: the row's birth is only an authority over the columns
      // its insert carried. Parking a value under the row's stamp when the row
      // never claimed that column made the stamp unrecognisable at the next
      // resurrection, and the value was quietly dropped on that replica alone.
      const r = this.cellAuth(sh, rid, k, !isVKey(k) || this.rowNames(node, keyCol(k)))
      if (!r) continue
      const v = isVKey(k) ? readCell(sheet.data[keyCol(k)], at) : sheet.cells?.[`${keyCol(k)}:${rid}`]
      if (!(k in st) || cmpReg(st[k].r, r) !== 0) {
        st[k] = v === undefined ? { r: clone(r) } : { v: clone(v), r: clone(r) }
      }
    }
  }

  /**
   * Replay parked values over a row that has just (re)appeared.
   *
   * `named` is the set of columns the insert's payload carried. For those, the
   * row is a competing assignment and only a NEWER authority may overwrite it.
   * For every other column the row makes no claim at all, so whatever the
   * column last said still stands and is restored unconditionally — otherwise
   * `applyPatch`'s blank for an uncarried column silently becomes the value.
   */
  private replayStashRow(doc: DashDoc, sheet: TableSheet, sh: string, rid: number, birth: Reg, named: Set<string>): void {
    const node = rowNode(sh, rid)
    const st = this.stash[node]
    if (!st) return
    const keep: Record<string, { v?: unknown; r: Reg }> = {}
    for (const [k, ent] of Object.entries(st)) {
      const col = keyCol(k)
      // The column is not here — buried, or its insert has not landed yet.
      // Either way the value STAYS PARKED rather than being written (it would
      // go into a column that does not exist) or dropped (deadness is a
      // transient view; an undo that revives the column is exactly the case
      // where a peer still holds this value, and assignColumnData reclaims
      // parked entries when the column comes back).
      if (this.dead(colNode(sh, col)) || (isVKey(k) && !sheet.data[col])) { keep[k] = ent; continue }
      const claims = !isVKey(k) || named.has(col)
      const r = this.cellAuth(sh, rid, k, claims)
      // The authority the value is being weighed under.
      //
      // When the row's payload CLAIMS this column the two are competing
      // assignments and only a strictly newer one may survive the rebirth.
      //
      // When it does NOT claim it, the parked entry IS the last word for the
      // cell, and asking `cellAuth(…, fromRow:false)` for a verdict was the
      // seed-374/184 bug. `rnamed` records only the CURRENT birth's claim, so a
      // row resurrected TWICE — the first insert naming the column, the second
      // (from a peer who did not have the column yet) not naming it —
      // overwrites the record that the first insert ever claimed anything.
      // After that the parked entry's stamp is the older birth, `cellAuth`
      // returns the bare cell register (or undefined, when the value only ever
      // arrived in a row payload), the stale guard below sees two different
      // stamps and drops the value — while the author of the second
      // resurrection, which never held a parked copy because it never processed
      // the first insert, keeps the number it already had in the document. The
      // MINORITY replica was right: an insert that does not name a column makes
      // no claim on it, so nothing has superseded the parked value and it must
      // come back. Only something strictly NEWER than the parked stamp can
      // displace it.
      const auth = claims ? r : (r && regNewer(r, ent.r) ? r : ent.r)
      if (!auth) continue
      if (claims && !regNewer(auth, birth)) continue
      // THE COLUMN'S OWN BIRTH IS THE OTHER ASSIGNMENT, and it has to be
      // weighed here as well as in reconcileParked — this is where the two
      // readers of the stash disagreed.
      //
      // A cell sits under two whole-node assignments (cellAuth says so), yet
      // this replay only ever compared the parked authority against the ROW's
      // rebirth. So a value parked during the COLUMN's dead window was written
      // back the moment its row reappeared, no matter how much newer the
      // column's resurrection was. The asymmetry that follows is exact: the
      // replica that had the value in hand (parked at delete time, or stashed
      // because the write arrived while the row was dead) restored it, while
      // every replica that reached the column's rebirth through
      // resetColumnValues — which DOES apply the rule, `!regNewer(auth, birth)`
      // — correctly blanked it. Same registers, same births, same tombs on both
      // sides; one number more on one workbook. Rig seed 307 (ACTORS=5,
      // STEPS=300): a column removed and re-added by undo at lamport 23/24, a
      // value written to it at lamport 2 and parked, and the row carrying that
      // cell resurrected at lamport 8 by a peer's own undo. The [24] rebirth
      // supersedes both, and only the replay thought otherwise.
      //
      // reconcileParked has carried this rule from the start ("The column's own
      // birth beats anything parked before it"); it simply never got the chance
      // to apply it, because replayStashRow runs inside applyRins and has
      // already written the document by the time the batch reconciles.
      const cb = this.births[colNode(sh, col)]
      if (cb && !regNewer(auth, cb)) continue
      // stale guard: the parked value must belong to the CURRENT authority — a
      // newer write that landed elsewhere supersedes it
      if (cmpReg(ent.r, auth) !== 0) continue
      dbg(node, `stash-replay ${k} := ${JSON.stringify(ent.v)}`)
      if (isVKey(k)) {
        if (sheet.data[col]) applyPatch(doc, { op: 'setCells', sheet: sh, col, rids: [rid], v: [clone(ent.v ?? null)] })
      } else {
        applyPatch(doc, {
          op: 'setOverrides', sheet: sh, keys: [`${col}:${rid}`],
          v: ['v' in ent ? clone(ent.v) as CellOverride : null], dropEmpty: true,
        })
      }
    }
    if (Object.keys(keep).length) this.stash[node] = keep
    else delete this.stash[node]
  }

  /**
   * A column insert assigns the whole column: it blanks the values and keeps
   * only the cells that out-stamp it — a `set` register, or the birth of a row
   * created after the column and carrying it. The blanked cells are filled by
   * the cell op that accompanies the insert.
   *
   * Runs on BOTH paths, including the one where the column is still present.
   * A replica that received the resurrect before the delete never removes
   * anything, and if the rebirth left its values alone it would keep numbers
   * every replica that processed the delete has lost.
   *
   * O(edits) to find the survivors, O(rows) to rebuild the array — which is
   * what the store's own addColumn costs anyway.
   */
  private resetColumnValues(doc: DashDoc, sheet: TableSheet, col: string, birth: Reg, enc: 'raw' | 'dict' | undefined): void {
    const key = vKey(col)
    const prefix = rowNode(sheet.id, 0).slice(0, -1) // `r␟<sheet>␟`
    const keeps: Array<[number, unknown]> = []
    for (const node of new Set([...Object.keys(this.births), ...Object.keys(this.regs).filter((n) => key in this.regs[n])])) {
      if (!node.startsWith(prefix)) continue
      const rid = Number(nodeTail(node))
      const at = rleIndex(sheet.rids, rid)
      if (at < 0) continue
      const r = this.reg(node, key)
      const b = this.rowNames(node, col) ? this.births[node] : undefined
      const auth = r && (!b || regNewer(r, b)) ? r : b
      if (!auth || !regNewer(auth, birth)) continue
      // the document if the column is still here, otherwise what its death parked
      const ent = this.stash[node]?.[key]
      const v = sheet.data[col] ? readCell(sheet.data[col], at)
        : (ent && cmpReg(ent.r, auth) === 0 ? (ent.v ?? null) : null)
      if (ent) {
        delete this.stash[node][key]
        if (!Object.keys(this.stash[node]).length) delete this.stash[node]
      }
      keeps.push([rid, v])
    }
    const n = rleCount(sheet.rids)
    if (enc === undefined) delete sheet.data[col] // a formula column stores nothing
    else if (enc === 'dict') sheet.data[col] = { enc: 'dict', dict: [], idx: new Array(n).fill(null) }
    else sheet.data[col] = { enc: 'raw', v: new Array(n).fill(null) }
    if (!sheet.data[col]) return
    for (const [rid, v] of keeps) {
      if (v === null || v === undefined) continue
      applyPatch(doc, { op: 'setCells', sheet: sheet.id, col, rids: [rid], v: [clone(v)] })
    }
  }

  /**
   * Park what a column removal destroys, so a resurrection can weigh it.
   *
   * Cell values live in the document, not here, so once the column is gone the
   * only replicas that can still produce them are the ones that kept a copy. A
   * replica that had the write PENDING (the column was already buried when it
   * arrived) replays it after the rebirth; this is the same guarantee for the
   * replica that had already applied it. With only one of the two halves, the
   * same cell came back filled on one side and empty on the other.
   */
  private parkColumn(sheet: TableSheet, col: string): void {
    const key = vKey(col)
    const ok = oKey(col)
    const prefix = rowNode(sheet.id, 0).slice(0, -1) // `r␟<sheet>␟`
    const park = (node: string, k: string, v: unknown, r: Reg | undefined) => {
      if (!r) return
      const st = (this.stash[node] ??= {})
      // Never clobber an entry that already holds this authority: it is the
      // one with the value, and ours may be the blank it is waiting to fill.
      if (!(k in st) || cmpReg(st[k].r, r) !== 0) st[k] = { v: clone(v), r: clone(r) }
    }
    for (const node of new Set([...Object.keys(this.births), ...Object.keys(this.regs).filter((n) => key in this.regs[n])])) {
      if (!node.startsWith(prefix)) continue
      const rid = Number(nodeTail(node))
      const at = rleIndex(sheet.rids, rid)
      if (at < 0) continue
      park(node, key, readCell(sheet.data[col], at), this.cellAuth(sheet.id, rid, key, this.rowNames(node, col)))
    }
    for (const k of Object.keys(sheet.cells ?? {})) {
      if (k.slice(0, k.indexOf(':')) !== col) continue
      const rid = Number(k.slice(k.indexOf(':') + 1))
      park(rowNode(sheet.id, rid), ok, sheet.cells![k], this.reg(rowNode(sheet.id, rid), ok))
    }
  }

  private killColumn(doc: DashDoc, sheet: TableSheet, col: string): void {
    dbg(colNode(sheet.id, col), `killColumn`)
    this.parkColumn(sheet, col)
    const keys = Object.keys(sheet.cells ?? {}).filter((k) => k.slice(0, k.indexOf(':')) === col)
    if (keys.length) applyPatch(doc, { op: 'setOverrides', sheet: sheet.id, keys, v: keys.map(() => null), dropEmpty: true })
    applyPatch(doc, { op: 'removeColumn', sheet: sheet.id, col })
  }

  // --- sheets and columns ---------------------------------------------------

  private applyIns(doc: DashDoc, op: InsOp, res: ApplyResult): void {
    const stamp: Reg = [op.l, op.a]
    const node = op.n
    const isSheet = node[0] === 's'
    // Resolve the host sheet BEFORE stamping the birth. Stamping first and
    // pending afterwards looks harmless and is not: the drained op then finds
    // its own birth already recorded, fails the "an older create" gate, and
    // returns — the column silently never appears.
    let host: TableSheet | undefined
    let sheetGone = false
    if (!isSheet) {
      const sheetId = nodeSheet(node)
      sheetGone = this.dead(shNode(sheetId))
      if (!sheetGone) {
        host = tableOf(doc, sheetId)
        if (!host) { this.pend(shNode(sheetId), op); return }
      }
    }
    const birth = this.births[node]
    if (birth && !newer(op.l, op.a, birth)) return // an older create
    this.births[node] = stamp
    if (!this.pos[node] || regNewer(stamp, this.pos[node].r)) {
      this.pos[node] = { p: isSheet ? DOC_NODE : shNode(nodeSheet(node)), o: op.ord, r: stamp }
    }
    res.changed = true
    res.structure = true
    if (isSheet) {
      // Derived from the payload, so every replica computes the same thing —
      // and must, even when the sheet is already dead here. A replica that
      // learned of the death first would otherwise be missing order keys its
      // peers hold, and the two sync states would never match again.
      const seed = op.node as Sheet
      if (seed.kind === 'table') this.base[seed.id] ??= clone(seed.rids)
      this.seedColumnPos(seed)
    }
    if (this.dead(node) || sheetGone) { this.drainPending(doc, node); return }
    if (isSheet) {
      const src = op.node as Sheet
      const existing = doc.sheets.find((s) => s.id === src.id)
      if (existing) {
        this.assignNode(existing as unknown as Record<string, unknown>, src as unknown as Record<string, unknown>, node, stamp, SHEET_STRUCTURAL)
      } else {
        doc.sheets.push(clone(src))
        this.replayStash(doc.sheets[doc.sheets.length - 1] as unknown as Record<string, unknown>, node, stamp)
      }
      const landed = doc.sheets.find((s) => s.id === src.id)
      if (landed && landed.kind === 'table') {
        // A payload can carry columns and rows that somebody else has already
        // buried. Adopting them wholesale would resurrect the dead on whichever
        // replica happened to receive the sheet last.
        this.pruneDead(doc, landed)
        this.rids[src.id] = clone(landed.rids)
      }
      this.drainSheet(doc, src.id)
    } else {
      const sheet = host!
      const src = op.node as Column
      const existing = sheet.columns.find((c) => c.id === src.id)
      if (existing) {
        this.assignNode(existing as unknown as Record<string, unknown>, src as unknown as Record<string, unknown>, node, stamp, ['id'])
      } else {
        applyPatch(doc, { op: 'addColumn', sheet: sheet.id, column: clone(src) })
        this.replayStash(sheet.columns[sheet.columns.length - 1] as unknown as Record<string, unknown>, node, stamp)
      }
      // BOTH paths reset the values, including the one where the column is
      // already here. A replica that received the resurrect before the delete
      // never removes anything, and if the rebirth left its values alone it
      // would keep numbers that every replica which processed the delete has
      // lost. Same event, same effect, whatever order it arrives in.
      this.resetColumnValues(doc, sheet, src.id, stamp, op.enc)
      dbg(node, `cins@${op.l},${op.a} ${src.id}`)
    }
    this.drainPending(doc, node)
  }

  /** drop members of a freshly-adopted sheet that are dead under our liveness */
  private pruneDead(doc: DashDoc, sheet: TableSheet): void {
    for (let i = sheet.columns.length - 1; i >= 0; i--) {
      if (!this.dead(colNode(sheet.id, sheet.columns[i].id))) continue
      this.killColumn(doc, sheet, sheet.columns[i].id)
    }
    const dead = rleExpand(sheet.rids).filter((rid) => this.dead(rowNode(sheet.id, rid)))
    if (dead.length) {
      dropRowOverrides(doc, sheet, dead)
      applyPatch(doc, { op: 'deleteRows', sheet: sheet.id, rids: dead })
    }
  }

  private applyDel(doc: DashDoc, op: DelOp, res: ApplyResult): void {
    const node = op.n
    if (!this.tombs[node] || newer(op.l, op.a, this.tombs[node])) this.tombs[node] = [op.l, op.a]
    if (this.dead(node)) {
      if (node[0] === 's') {
        const i = doc.sheets.findIndex((s) => s.id === nodeSheet(node))
        if (i >= 0) {
          this.stashNode(doc.sheets[i] as unknown as Record<string, unknown>, node)
          doc.sheets.splice(i, 1)
          delete this.rids[nodeSheet(node)]
        }
        this.drainSheet(doc, nodeSheet(node))
      } else {
        const sheetId = nodeSheet(node)
        const sheet = tableOf(doc, sheetId)
        const colId = nodeTail(node)
        const col = sheet?.columns.find((c) => c.id === colId)
        if (sheet && col) {
          this.stashNode(col as unknown as Record<string, unknown>, node)
          this.killColumn(doc, sheet, colId)
        }
      }
    }
    this.drainPending(doc, node)
    res.changed = true
    res.structure = true
  }

  private applyOrd(_doc: DashDoc, op: OrdOp, res: ApplyResult): void {
    const cur = this.pos[op.n]
    if (cur && !newer(op.l, op.a, cur.r)) return
    const parent = op.n[0] === 's' ? DOC_NODE : shNode(nodeSheet(op.n))
    this.pos[op.n] = { p: parent, o: op.ord, r: [op.l, op.a] }
    // a move never resurrects, and rematerialize (run once per apply batch)
    // is what turns the pos registers back into array order
    if (this.dead(op.n)) return
    res.changed = true
    res.structure = true
  }

  /**
   * Whole-node assignment from an insert payload: every property whose register
   * is OLDER than the (re)birth takes the payload's value; properties with
   * newer registers keep the set-winner. Runs identically on every replica —
   * including ones where the node never died — which is what makes
   * resurrection convergent.
   */
  private assignNode(node: Record<string, unknown>, payload: Record<string, unknown>, id: string, birth: Reg, skip: readonly string[]): void {
    for (const k of new Set([...Object.keys(node), ...Object.keys(payload)])) {
      if (skip.includes(k)) continue
      const r = this.reg(id, k)
      if (r && regNewer(r, birth)) continue // a newer set beats the assignment
      writeKey(node, k, payload[k] === undefined ? undefined : clone(payload[k]))
    }
    this.replayStash(node, id, birth)
  }

  /** park a to-be-removed node's registered property values (see replayStash) */
  private stashNode(node: Record<string, unknown>, id: string): void {
    const keys = this.regs[id]
    if (!keys) return
    const st = (this.stash[id] ??= {})
    for (const [k, r] of Object.entries(keys)) {
      if (!(k in st) || cmpReg(st[k].r, r) !== 0) {
        st[k] = node[k] === undefined ? { r: clone(r) } : { v: clone(node[k]), r: clone(r) }
      }
    }
  }

  /** replay dead-window property values that out-rank a resurrecting insert */
  private replayStash(node: Record<string, unknown>, id: string, birth: Reg): void {
    const st = this.stash[id]
    if (!st) return
    for (const [k, ent] of Object.entries(st)) {
      const r = this.reg(id, k)
      if (!r || !regNewer(r, birth)) continue
      if (cmpReg(ent.r, r) !== 0) continue
      writeKey(node, k, 'v' in ent ? clone(ent.v) : undefined)
    }
    delete this.stash[id]
  }

  /**
   * Settle parked cell values whose row and column are both live again.
   *
   * The stash is written by four different events (a row dies, a column dies,
   * a write lands on something dead, a column payload covers a row we lack)
   * and read by four more, and making every pair agree on WHO reclaims WHAT
   * was where the ordering bugs lived. This is the single rule instead: a
   * parked value belongs to the document as soon as its row and its column are
   * both there, provided it still holds the cell's authority. If it does not,
   * something newer won and the parked copy is forgotten.
   *
   * Runs after every batch. Costs O(parked), which is O(edits) and shrinks as
   * entries are consumed — never O(rows).
   */
  private reconcileParked(doc: DashDoc): void {
    for (const node of Object.keys(this.stash)) {
      if (node[0] !== 'r') continue // sheet/column property stashes settle on rebirth
      const sh = nodeSheet(node)
      const rid = Number(nodeTail(node))
      const sheet = tableOf(doc, sh)
      if (!sheet || this.dead(node) || !rleHas(sheet.rids, rid)) continue
      const st = this.stash[node]
      for (const k of Object.keys(st)) {
        const col = keyCol(k)
        if (this.dead(colNode(sh, col))) continue // may yet be dug up
        const live = isVKey(k) ? !!sheet.data[col] : sheet.columns.some((c) => c.id === col)
        if (!live) continue // the column's insert has not landed here yet
        const claims = !isVKey(k) || this.rowNames(node, col)
        const r = this.cellAuth(sh, rid, k, claims)
        // Same rule replayStashRow applies, and it has to be the same rule or
        // the two readers of the stash disagree again: when the row's current
        // birth does not CLAIM this column, the parked entry is the cell's last
        // word and only something strictly newer displaces it. Asking for a
        // register that may never have existed (the value arrived in an earlier
        // insert's payload, and `rnamed` has since been overwritten by a second
        // resurrection) dropped the value here too — on every replica except
        // the second resurrector. Seeds 374 and 184.
        const auth = claims ? r : (r && regNewer(r, st[k].r) ? r : st[k].r)
        // The column's own birth beats anything parked before it: a value a
        // row was holding for a column that has since been (re)created belongs
        // to the creation, not to the row.
        const cb = this.births[colNode(sh, col)]
        if (auth && cmpReg(st[k].r, auth) === 0 && !(cb && !regNewer(st[k].r, cb))) {
          dbg(node, `settle parked ${k} := ${JSON.stringify(st[k].v)}`)
          if (isVKey(k)) applyPatch(doc, { op: 'setCells', sheet: sh, col, rids: [rid], v: [clone(st[k].v ?? null)] })
          else {
            applyPatch(doc, {
              op: 'setOverrides', sheet: sh, keys: [`${col}:${rid}`],
              v: [st[k].v === undefined ? null : clone(st[k].v) as CellOverride], dropEmpty: true,
            })
          }
        }
        delete st[k] // consumed, or superseded by something newer
      }
      if (!Object.keys(st).length) delete this.stash[node]
    }
  }

  /** rebuild sheet and column order from pos registers (rows are maintained
   *  incrementally by the RGA — a global row sort would be O(rows) per op) */
  private rematerialize(doc: DashDoc): void {
    const ord = (n: string) => (this.pos[n] ? this.pos[n].o : '')
    const cmp = (x: string, y: string) => {
      const a = ord(x)
      const b = ord(y)
      if (a !== b) return a < b ? -1 : 1
      return x < y ? -1 : 1
    }
    doc.sheets.sort((s1, s2) => cmp(shNode(s1.id), shNode(s2.id)))
    for (const s of doc.sheets) {
      if (s.kind !== 'table') continue
      s.columns.sort((c1, c2) => cmp(colNode(s.id, c1.id), colNode(s.id, c2.id)))
    }
  }

  // --- state-based merge (file forks, late joiners, catch-up beyond the log) -

  /**
   * Merge a remote (doc, state) pair into ours. Register-wise LWW with value
   * adoption from the winning side, liveness max, and a symmetric row-order
   * interleave. merge(A←B) followed by merge(B←A) must leave both identical,
   * which is why nothing here may consult "which side is local".
   */
  mergeSnapshot(doc: DashDoc, rdoc: DashDoc, rstate: SyncStateJSON): ApplyResult {
    const res: ApplyResult = { changed: false, structure: false }
    if (!rstate || rstate.v !== SYNC_V) return res
    this.lamport = Math.max(this.lamport, rstate.lamport ?? 0)
    for (const [a, s] of Object.entries(rstate.vv ?? {})) {
      if ((this.vv[a] ?? 0) < s) {
        this.vv[a] = s
        if (a === this.actor) this.seq = s
        this.gap[a] = (this.gap[a] ?? []).filter((o) => o.s > s)
        res.changed = true
      }
    }
    const rebirths: string[] = []
    for (const [id, r] of Object.entries(rstate.births ?? {})) {
      if (!this.births[id] || regNewer(r, this.births[id])) { this.births[id] = clone(r); rebirths.push(id) }
    }
    for (const [id, r] of Object.entries(rstate.tombs ?? {})) {
      if (!this.tombs[id] || regNewer(r, this.tombs[id])) { this.tombs[id] = clone(r); res.changed = true }
    }
    // A row's key is minted once and never changes, so first-wins is exact.
    for (const [id, k] of Object.entries(rstate.rpos ?? {})) {
      if (!(id in this.rpos)) this.rpos[id] = k
    }
    // Baselines: identical for two copies of one file, but two copies adopted
    // at DIFFERENT points in a file's history disagree about which rows were
    // there to begin with. Union them symmetrically so both sides derive the
    // same keys — the alternative is two forks that each think the other's
    // rows belong somewhere else.
    for (const [id, b] of Object.entries(rstate.base ?? {})) {
      const mine = this.base[id]
      if (!mine) { this.base[id] = clone(b); continue }
      const merged = mergeOrder(rleExpand(mine), rleExpand(b), () => undefined)
      if (merged.length !== rleCount(mine)) this.base[id] = rleCompress(merged)
    }
    for (const [id, rp] of Object.entries(rstate.pos ?? {})) {
      const cur = this.pos[id]
      if (!cur || regNewer(rp.r, cur.r)) { this.pos[id] = clone(rp); res.changed = true; res.structure = true }
    }

    // --- structure: sheets, then per-sheet rows and columns
    for (let i = doc.sheets.length - 1; i >= 0; i--) {
      const s = doc.sheets[i]
      if (this.dead(shNode(s.id))) {
        this.stashNode(s as unknown as Record<string, unknown>, shNode(s.id))
        doc.sheets.splice(i, 1)
        delete this.rids[s.id]
        res.changed = res.structure = true
      }
    }
    for (const rs of rdoc.sheets) {
      if (this.dead(shNode(rs.id))) continue
      if (doc.sheets.some((s) => s.id === rs.id)) continue
      doc.sheets.push(clone(rs))
      this.seedColumnPos(rs)
      if (rs.kind === 'table') {
        this.rids[rs.id] = clone(rs.rids)
        this.base[rs.id] ??= clone(rs.rids)
      }
      res.changed = res.structure = true
    }
    const rById = new Map(rdoc.sheets.map((s) => [s.id, s]))
    for (const s of doc.sheets) {
      if (s.kind !== 'table') continue
      const rsheet = rById.get(s.id)
      const rt = rsheet && rsheet.kind === 'table' ? rsheet : undefined
      this.mergeColumns(doc, s, rt, res)
      this.mergeRows(doc, s, rt, res)
    }

    // --- whole-node assignments the remote saw and we did not
    for (const id of rebirths) {
      if (this.dead(id) || id[0] === 'r') continue // rows assign through mergeRows
      const src = remoteNode(rdoc, id)
      const dst = localNode(doc, id)
      if (!src || !dst) continue
      this.assignNode(dst, src, id, this.births[id], id[0] === 's' ? SHEET_STRUCTURAL : ['id'])
      res.changed = true
      if (id[0] === 's') res.structure = true
    }

    // --- property registers: the winning side's value lives in its document
    for (const [node, keys] of Object.entries(rstate.regs ?? {})) {
      for (const [key, rr] of Object.entries(keys)) {
        if (!regNewer(rr, this.reg(node, key))) continue
        this.setReg(node, key, clone(rr))
        if (node !== DOC_NODE) {
          const b = this.births[node]
          if (b && !regNewer(rr, b)) continue // superseded by a whole-node assignment
        }
        if (node[0] === 'r') { this.mergeCellReg(doc, rdoc, rstate, node, key, rr); continue }
        if (node !== DOC_NODE && this.dead(node)) {
          const src = remoteNode(rdoc, node)
          const rstash = rstate.stash?.[node]?.[key]
          if (src && src[key] !== undefined) (this.stash[node] ??= {})[key] = { v: clone(src[key]), r: clone(rr) }
          else if (rstash) (this.stash[node] ??= {})[key] = clone(rstash)
          continue
        }
        const src = node === DOC_NODE ? (rdoc as unknown as Record<string, unknown>) : remoteNode(rdoc, node)
        const dst = node === DOC_NODE ? (doc as unknown as Record<string, unknown>) : localNode(doc, node)
        if (!src || !dst) continue
        if (node === DOC_NODE) writeDocKey(doc, key, readDocKey(rdoc, key))
        else writeKey(dst, key, src[key])
        res.changed = true
        if (node === DOC_NODE || node[0] === 's') res.structure = true
      }
    }
    this.reconcileParked(doc)
    if (res.structure) this.rematerialize(doc)
    this.snapRids(doc)
    return res
  }

  /** one cell register during a snapshot merge: read the winner's value out of
   *  the remote's columnar arrays and write it into ours by rid */
  private mergeCellReg(doc: DashDoc, rdoc: DashDoc, rstate: SyncStateJSON, node: string, key: string, rr: Reg): void {
    const sh = nodeSheet(node)
    const rid = Number(nodeTail(node))
    const col = keyCol(key)
    const sheet = tableOf(doc, sh)
    const rsheet = tableOf(rdoc, sh)
    const rAt = rsheet ? rleIndex(rsheet.rids, rid) : -1
    const value = isVKey(key)
      ? (rAt >= 0 && rsheet ? readCell(rsheet.data[col], rAt) : rstate.stash?.[node]?.[key]?.v)
      : (rsheet?.cells?.[`${col}:${rid}`] ?? rstate.stash?.[node]?.[key]?.v)
    if (this.dead(node) || !sheet || !rleHas(sheet.rids, rid)) {
      ;(this.stash[node] ??= {})[key] = { v: clone(value), r: clone(rr) }
      return
    }
    if (isVKey(key)) {
      if (sheet.data[col]) applyPatch(doc, { op: 'setCells', sheet: sh, col, rids: [rid], v: [clone(value ?? null)] })
    } else {
      applyPatch(doc, {
        op: 'setOverrides', sheet: sh, keys: [`${col}:${rid}`],
        v: [value === undefined ? null : clone(value) as CellOverride], dropEmpty: true,
      })
    }
  }

  private mergeColumns(doc: DashDoc, sheet: TableSheet, rsheet: TableSheet | undefined, res: ApplyResult): void {
    for (let i = sheet.columns.length - 1; i >= 0; i--) {
      const n = colNode(sheet.id, sheet.columns[i].id)
      if (!this.dead(n)) continue
      this.stashNode(sheet.columns[i] as unknown as Record<string, unknown>, n)
      this.killColumn(doc, sheet, sheet.columns[i].id)
      res.changed = res.structure = true
    }
    if (!rsheet) return
    const myRids = rleExpand(sheet.rids)
    for (const rc of rsheet.columns) {
      if (this.dead(colNode(sheet.id, rc.id))) continue
      if (sheet.columns.some((c) => c.id === rc.id)) continue
      sheet.columns.push(clone(rc))
      const rd = rsheet.data[rc.id]
      if (rd) sheet.data[rc.id] = alignColumnData(rd, rleExpand(rsheet.rids), myRids)
      res.changed = res.structure = true
    }
  }

  /**
   * Reconcile two row sequences.
   *
   * Rows only one side knows about are adopted with their values; rows dead
   * under merged liveness leave. The ORDER is a symmetric interleave (see
   * mergeOrder) rather than a winner-takes-all — which is the honest limit of
   * merging two sequences from state alone, since neither side kept the op log
   * that produced the other's order.
   */
  private mergeRows(doc: DashDoc, sheet: TableSheet, rsheet: TableSheet | undefined, res: ApplyResult): void {
    const mine = rleExpand(sheet.rids)
    const dropped = mine.filter((rid) => this.dead(rowNode(sheet.id, rid)))
    if (dropped.length) {
      for (const rid of dropped) this.stashRow(sheet, sheet.id, rid)
      dropRowOverrides(doc, sheet, dropped)
      applyPatch(doc, { op: 'deleteRows', sheet: sheet.id, rids: dropped })
      res.changed = res.structure = true
    }
    if (!rsheet) return
    const live = rleExpand(sheet.rids)
    const theirs = rleExpand(rsheet.rids).filter((rid) => !this.dead(rowNode(sheet.id, rid)))
    const order = mergeOrder(live, theirs, (rid) => this.births[rowNode(sheet.id, rid)])
    // adopt rows only they have, in the merged order, one splice each
    for (let i = 0; i < order.length; i++) {
      const rid = order[i]
      if (rleHas(sheet.rids, rid)) continue
      const at = rleIndex(rsheet.rids, rid)
      const vals: Record<string, unknown[]> = {}
      for (const col of Object.keys(sheet.data)) {
        const rd = rsheet.data[col]
        vals[col] = [rd ? readCell(rd, at) : null]
      }
      applyPatch(doc, { op: 'insertRows', sheet: sheet.id, rids: [rid], at: [Math.min(i, rleCount(sheet.rids))], values: vals })
      for (const [k, ov] of Object.entries(rsheet.cells ?? {})) {
        if (Number(k.slice(k.indexOf(':') + 1)) !== rid) continue
        applyPatch(doc, { op: 'setOverrides', sheet: sheet.id, keys: [k], v: [clone(ov)], dropEmpty: true })
      }
      res.changed = res.structure = true
    }
    // then settle the order itself
    const now = rleExpand(sheet.rids)
    if (now.length === order.length && now.every((r, i) => r === order[i])) return
    permuteRows(sheet, order)
    res.changed = res.structure = true
  }

  /** ops from our log this version vector is missing (peer catch-up) */
  missingFor(log: Op[], vv: Record<string, number>): Op[] {
    return log.filter((o) => o.s > (vv[o.a] ?? 0))
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** sheet-node keys that the payload owns wholesale: structure moves through
 *  row/column ops, never through a property register. Mirrors store.ts's
 *  `STRUCTURAL` refusal set in rowcol.ts, deliberately. */
const SHEET_STRUCTURAL = ['id', 'kind', 'columns', 'data', 'rids', 'cells'] as const

const tableOf = (doc: DashDoc, id: string): TableSheet | undefined => {
  const s = doc.sheets.find((x) => x.id === id)
  return s && s.kind === 'table' ? s : undefined
}

/**
 * Take a removed row's cell overrides with it.
 *
 * `rowcol.deleteRowsAt` does this in the app, in the same commit, because an
 * override keyed to a rid nobody can reach is garbage that the next writer
 * inherits. The CRDT has to do it too, and not merely as tidiness: a replica
 * that wrote the override BEFORE the delete arrived would otherwise keep it
 * while a replica that got the delete first never writes it at all, and two
 * workbooks would differ by a note pinned to a row that no longer exists.
 * Deterministic given liveness, and safe because a rid is never reused.
 */
/** the row-axis twin of DashSync.killColumn (see rowcol.deleteRowsAt) */
function dropRowOverrides(doc: DashDoc, sheet: TableSheet, rids: number[]): void {
  if (!sheet.cells) return
  const doomed = new Set(rids)
  const keys = Object.keys(sheet.cells).filter((k) => doomed.has(Number(k.slice(k.indexOf(':') + 1))))
  if (!keys.length) return
  applyPatch(doc, { op: 'setOverrides', sheet: sheet.id, keys, v: keys.map(() => null), dropEmpty: true })
}

function writeKey(target: Record<string, unknown>, k: string, v: unknown): void {
  if (v === undefined) delete target[k]
  else target[k] = v
}

/** doc-level keys support dotted per-entry registers for the map fields, so two
 *  people adding different measures (or assets) both keep theirs. */
function writeDocKey(doc: DashDoc, k: string, v: unknown): void {
  const dot = k.indexOf('.')
  const field = dot > 0 ? k.slice(0, dot) : ''
  if (field === 'measures' || field === 'assets' || field === 'blobs' || field === 'names') {
    const map = ((doc as unknown as Record<string, Record<string, unknown>>)[field] ??= {})
    const key = k.slice(dot + 1)
    if (v === undefined) delete map[key]
    else map[key] = clone(v)
    return
  }
  writeKey(doc as unknown as Record<string, unknown>, k, v === undefined ? undefined : clone(v))
}

function readDocKey(doc: DashDoc, k: string): unknown {
  const dot = k.indexOf('.')
  const field = dot > 0 ? k.slice(0, dot) : ''
  if (field === 'measures' || field === 'assets' || field === 'blobs' || field === 'names') {
    return (doc as unknown as Record<string, Record<string, unknown> | undefined>)[field]?.[k.slice(dot + 1)]
  }
  return (doc as unknown as Record<string, unknown>)[k]
}

const remoteNode = (rdoc: DashDoc, node: string): Record<string, unknown> | undefined => {
  if (node === DOC_NODE) return rdoc as unknown as Record<string, unknown>
  const sheet = rdoc.sheets.find((s) => s.id === nodeSheet(node))
  if (!sheet) return undefined
  if (node[0] === 's') return sheet as unknown as Record<string, unknown>
  if (sheet.kind !== 'table') return undefined
  return sheet.columns.find((c) => c.id === nodeTail(node)) as unknown as Record<string, unknown> | undefined
}
const localNode = remoteNode

/**
 * Re-align a column's encoded values from the sender's row order to ours.
 *
 * A column travels with the rid list it was encoded against, because the two
 * replicas' row orders need not match — and reading a column at the wrong
 * offsets is the silent-wrong-number failure this whole app is built to
 * refuse. Rows we do not have are dropped; rows the sender lacked come out null.
 */
export function alignColumnData(data: ColumnData, from: number[], to: number[]): ColumnData {
  if (data.enc === 'pack') return data // opaque archive encoding — cannot re-index
  const at = new Map<number, number>()
  from.forEach((rid, i) => at.set(rid, i))
  if (data.enc === 'dict') {
    return { enc: 'dict', dict: data.dict.slice(), idx: to.map((rid) => { const i = at.get(rid); return i === undefined ? null : (data.idx[i] ?? null) }) }
  }
  return { enc: 'raw', v: to.map((rid) => { const i = at.get(rid); return i === undefined ? null : (data.v[i] ?? null) }) }
}

/**
 * Permute a sheet's rows into `order`.
 *
 * Rebuilds each column's index array rather than writing values one at a time:
 * a dict column keeps its dictionary (no re-interning, no dictionary growth)
 * and a raw column is one map. `pack` columns are opaque and are left ALONE —
 * store.ts refuses to write them for the same reason, and silently re-indexing
 * an archive column would misalign every value in it.
 */
/**
 * Settle a sheet's rid watermark to a value every replica agrees on.
 *
 * `nextRid` is DOCUMENT data (store.ts raises it on every insert and delete so
 * a rid is never minted twice), and a plain monotonic counter does not
 * converge: two replicas that each did a different number of structural edits
 * hold different numbers, and the documents differ forever. Measured before
 * this existed: seed 12 diverged on `nextRid` 4002 against 4001 and on nothing
 * else.
 *
 * A monotonic counter's join is MAX, and this engine already knows every rid
 * that has ever existed for a sheet — `births` keeps a register for each row
 * node whether or not it is still alive. So the converged watermark is one past
 * the largest of them, which both replicas compute identically once their
 * states agree, and which can never go below a rid that existed.
 */
function settleWatermark(sheet: TableSheet, births: Record<string, Reg>): void {
  const prefix = rowNode(sheet.id, 0).slice(0, -1)
  let hi = 0
  for (const [start, count] of sheet.rids) hi = Math.max(hi, start + count - 1)
  for (const k of Object.keys(births)) {
    if (!k.startsWith(prefix)) continue
    const rid = Number(k.slice(prefix.length))
    if (Number.isFinite(rid)) hi = Math.max(hi, rid)
  }
  sheet.nextRid = hi + 1
}

function permuteRows(sheet: TableSheet, order: number[]): void {
  const from = rleExpand(sheet.rids)
  const at = new Map<number, number>()
  from.forEach((rid, i) => at.set(rid, i))
  for (const [col, d] of Object.entries(sheet.data)) {
    if (d.enc === 'raw') sheet.data[col] = { enc: 'raw', v: order.map((rid) => { const i = at.get(rid); return i === undefined ? null : (d.v[i] ?? null) }) }
    else if (d.enc === 'dict') sheet.data[col] = { enc: 'dict', dict: d.dict, idx: order.map((rid) => { const i = at.get(rid); return i === undefined ? null : (d.idx[i] ?? null) }) }
  }
  sheet.rids = rleCompress(order)
}

/**
 * Symmetric two-sequence interleave.
 *
 * The rule may never ask which side is "local" — merge(A,B) and merge(B,A)
 * have to produce the same list, or two forks that exchange snapshots settle on
 * different row orders and never converge. So at every step the choice is made
 * from the elements themselves: an element the other list does not contain goes
 * first, and a genuine tie breaks on (birth stamp, rid), which both sides agree
 * on.
 */
export function mergeOrder(a: number[], b: number[], birthOf: (rid: number) => Reg | undefined): number[] {
  const inB = new Set(b)
  const inA = new Set(a)
  const out: number[] = []
  const taken = new Set<number>()
  let i = 0
  let j = 0
  const rank = (rid: number): string => {
    const r = birthOf(rid)
    return r ? `1${String(r[0]).padStart(12, '0')}${r[1]}${rid}` : `0${String(rid).padStart(12, '0')}`
  }
  const take = (rid: number) => { if (!taken.has(rid)) { taken.add(rid); out.push(rid) } }
  while (i < a.length || j < b.length) {
    while (i < a.length && taken.has(a[i])) i++
    while (j < b.length && taken.has(b[j])) j++
    if (i >= a.length) { if (j < b.length) take(b[j++]) ; continue }
    if (j >= b.length) { take(a[i++]); continue }
    const x = a[i]
    const y = b[j]
    if (x === y) { take(x); i++; j++; continue }
    const xShared = inB.has(x)
    const yShared = inA.has(y)
    if (xShared && !yShared) { take(y); j++; continue }
    if (!xShared && yShared) { take(x); i++; continue }
    // both exclusive, or both shared but out of order: decide from the rows
    if (rank(x) <= rank(y)) { take(x); i++ } else { take(y); j++ }
  }
  return out
}

/** indices of a longest strictly-increasing subsequence */
function longestIncreasing(keys: string[]): number[] {
  const tails: number[] = []
  const prev = new Array<number>(keys.length).fill(-1)
  for (let i = 0; i < keys.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (keys[tails[mid]] < keys[i]) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]
    tails[lo] = i
  }
  const out: number[] = []
  let k = tails.length ? tails[tails.length - 1] : -1
  while (k >= 0) { out.push(k); k = prev[k] }
  return out.reverse()
}

/**
 * Is this patch safe to commit into a LIVE session?
 *
 * The asymmetry this closes is easy to miss and impossible to see afterwards.
 * A locally committed patch is applied by the store unconditionally — it has no
 * idea what a peer deleted — while the very same change, arriving as an op, is
 * gated by liveness on every other replica. So an edit naming a row or column
 * that is gone lands HERE and nowhere else, and the workbooks differ by a value
 * only one person can see. `applyPatch` makes it worse for cells specifically:
 * a `setCells` naming an unknown rid is silently skipped rather than refused,
 * so nothing surfaces at the call site either.
 *
 * The rule is the honest one: you cannot edit what is not there. Undo is where
 * this actually bites (its inverses were built against a document state that a
 * collaborator has since changed), which is why the session filters rather than
 * throws — a refused inverse is a lost undo step, and a divergent workbook is
 * worse.
 */
export function committable(doc: DashDoc, p: Patch): boolean {
  const table = (id: string): TableSheet | undefined => tableOf(doc, id)
  const ridOf = (k: string) => Number(k.slice(k.indexOf(':') + 1))
  const colOf = (k: string) => k.slice(0, k.indexOf(':'))
  switch (p.op) {
    case 'setCells': {
      const s = table(p.sheet)
      return !!s && !!s.data[p.col] && p.rids.every((r) => rleHas(s.rids, r))
    }
    case 'setOverrides': {
      const s = table(p.sheet)
      return !!s && p.keys.every((k) =>
        rleHas(s.rids, ridOf(k)) && s.columns.some((c) => c.id === colOf(k)))
    }
    case 'insertRows': {
      const s = table(p.sheet)
      if (!s || !p.rids.every((r) => !rleHas(s.rids, r))) return false
      // Every position must be reachable AT THE MOMENT it is spliced.
      // store.ts's insertRows splices `rids` and the column arrays at `at`
      // (which Array.splice clamps) but then writes the value at the RAW
      // index, so an `at` past the end leaves a hole and a column one entry
      // longer than the sheet has rows — after which every cell below the gap
      // reads the next row's number. It is reachable exactly here: undo of a
      // row delete carries the positions the rows had, and a collaborator may
      // have removed rows since. Refusing costs one undo step.
      let n = rleCount(s.rids)
      for (const at of (p.at ?? []).slice().sort((x, y) => x - y)) {
        if (at > n) return false
        n++
      }
      return true
    }
    case 'deleteRows': return !!table(p.sheet)
    case 'addColumn': {
      const s = table(p.sheet)
      if (!s || s.columns.some((c) => c.id === p.column.id)) return false
      // A column's values are addressed by POSITION, so an array that is not
      // exactly as long as the sheet has rows shifts every cell below the gap
      // — silently, and identically on every replica, which is worse than a
      // crash. It happens for real: `removeColumn`'s inverse carries the data
      // snapshot taken at removal, and rows may have come or gone since, so an
      // undo can restore a column that no longer fits the sheet it is going
      // back into. Refusing costs one undo step; accepting costs the numbers.
      if (!p.data) return true
      const len = p.data.enc === 'raw' ? p.data.v.length : p.data.enc === 'dict' ? p.data.idx.length : -1
      return len < 0 || len === rleCount(s.rids)
    }
    case 'removeColumn':
    case 'setColumn': return !!table(p.sheet)?.columns.some((c) => c.id === p.col)
    case 'reorderColumns': {
      const s = table(p.sheet)
      return !!s && p.order.length === s.columns.length && p.order.every((id) => s.columns.some((c) => c.id === id))
    }
    case 'setSheetProps': return !!table(p.sheet)
    default: return true
  }
}

/** Exposed for the convergence rig, as store.ts does — not an app surface. */
export const _internals = { rleExpand, rleCompress, rleIndex, rleAt, permuteRows, longestIncreasing }
