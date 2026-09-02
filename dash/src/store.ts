// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Document state, undo history, and the TYPING RUN.
//
// THE TYPING RUN and THE BYTE CAP are spaces' (spaces/src/store.ts:6-13, :20-23),
// taken deliberately and unchanged. Slides sidesteps commit granularity because
// canvas text commits on blur; a grid may never blur, so this one policy sets
// undo granularity, autosave churn, the dirty flag and later the collab op rate.
// A run is consecutive input in ONE cell with no structural op between: one
// checkpoint at its first input, later inputs mutate in place, closing on idle,
// on the caret leaving the cell, on any structural change, on save and on
// replaceDoc.
//
// THE ENTRY BODY IS WHERE DASH DIVERGES, and it is the sharpest divergence in
// the app. spaces snapshots `JSON.stringify(doc minus assets)` per checkpoint
// (store.ts:137-142) — the right instinct, since it forked slides' MAX_UNDO=100
// entry cap into a byte cap precisely because whole-document snapshots do not
// scale, but an incomplete fork: it still stringifies the whole document.
// Measured on a 12.2 MB workbook: 10 ms per checkpoint — most of a 16 ms frame,
// paid in the frame the user starts typing — and 1.19 GB of live strings for a
// full stack. Unusable at 50k-100k cells, OOM before 500k.
//
// So history here is a list of TYPED INVERSES, each carrying only what it
// touched, minted at the edit site. A 10,000-cell paste is one entry holding
// 10,000 values, not 100 copies of the workbook.
//
// The same Patch objects are the undo entries, the future CRDT ops and the
// agent API. That is why this lands at commit one: retrofitting op-minting
// means rewriting the store.

import { t } from './i18n.ts'
import { applySheetProps } from './rowcol.ts'
// The one definition of "what counts as a number" — import's. A second
// implementation here is how a value converts on import and refuses on a
// type change, or the other way round.
import { coerce, encodeColumn, inferColumn } from './import.ts'
import { PROVENANCE_OPS } from './steps.ts'
import type { CellOverride, Comment, View, Column, ColumnData, ColumnType, DashDoc, Measure, Sheet, Step, TableSheet, CanvasCell, CanvasSheet } from './model.ts'

type Listener = () => void
export type StoreEvent = 'doc' | 'view' | 'selection'

/** Idle that closes a run. Autosave debounces longer, so no snapshot lands mid-run. */
const RUN_IDLE_MS = 600

/**
 * Undo is bounded by BYTES, not entries — spaces' correction to slides'
 * MAX_UNDO = 100, and the right one. What differs is what the bytes measure:
 * here it is the size of the patches themselves, not of document copies.
 */
const UNDO_BYTES = 24 * 1024 * 1024

// --- Patches ---------------------------------------------------------------

/**
 * One undoable change, carrying only what it touched.
 *
 * Every variant is INVERTIBLE: `applyPatch` returns the patch that undoes it,
 * built from the values it displaced. Nothing here reads the whole document.
 */
export type Patch =
  /** `dictLen` truncates a dictionary that this edit grew. Without it, undo
   *  restores the values and leaves the orphaned strings behind — the document
   *  is semantically right and no longer byte-identical, and the dictionary
   *  grows forever under editing. */
  | { op: 'setCells'; sheet: string; col: string; rids: number[]; v: unknown[]; dictLen?: number }
  /** `dropEmpty` removes the `cells` container the forward patch created. An
   *  apply-then-undo that leaves `"cells": {}` behind is not a round trip. */
  | {
      op: 'setOverrides'; sheet: string; keys: string[]
      /** `null` and `undefined` both DELETE; null is the one that survives JSON. */
      v: Array<CellOverride | null | undefined>; dropEmpty?: boolean
    }
  /**
   * `at[i]` is the row POSITION rids[i] takes; omitted means append.
   * `values` is colId → one value per rid.
   *
   * `overrides` puts a deleted row's `cells` entries back with it. Without it
   * the inverse of a delete restored the row's VALUES and dropped every hand
   * correction, note and per-cell formula attached to it.
   *
   * Both exist because this is the inverse of a delete, and a delete has to be
   * undoable exactly. Without `values` the rows come back EMPTY; without `at`
   * they come back at the END — and in a spreadsheet, order is data. Measured
   * before this was fixed: deleting row 2 of [10,20,30,40] and undoing gave
   * [10,30,40,20].
   */
  | {
      op: 'insertRows'; sheet: string; rids: number[]
      at?: number[]; values?: Record<string, unknown[]>
      /**
       * A deleted row's `cells` entries, put back with it. Without this the
       * inverse of a delete restored the row's VALUES and silently dropped
       * every hand correction, note and per-cell formula attached to it.
       */
      overrides?: Record<string, CellOverride>
      /** the sheet had no `cells` container before; do not leave one behind */
      dropEmptyCells?: boolean
    }
  | { op: 'deleteRows'; sheet: string; rids: number[] }
  | { op: 'setColumn'; sheet: string; col: string; patch: Record<string, unknown>;
      /** the pre-conversion bytes, set only on the INVERSE of a type change */
      data?: ColumnData }
  /** `at` is the position; omitted appends. `data` is omitted for a FORMULA
   *  column, which has no stored values — its numbers are derived from its
   *  expression, so storing them would let a file carry a number that
   *  disagrees with the formula that produced it. */
  | { op: 'addColumn'; sheet: string; column: Column; at?: number; data?: ColumnData }
  | { op: 'removeColumn'; sheet: string; col: string }
  | { op: 'reorderColumns'; sheet: string; order: string[] }
  | { op: 'setMeasure'; name: string; measure?: Measure; dropEmpty?: boolean }
  | { op: 'setTitle'; title: string }
  /**
   * Sheet-level properties — conditional formats, frozen panes, the sheet name.
   *
   * Needed because nothing else in this union can write above the column: the
   * row/column helpers had to declare their own patch type for want of one.
   * Keyed like `setColumn` so the inverse is the displaced values, and a key
   * whose new value is `undefined` is REMOVED rather than set — the un-hide
   * hazard, met once already in rowcol.ts.
   */
  /**
   * Sheet-level fields (frozen panes, conditional formats, filters) — the only
   * op that writes ABOVE the column level.
   *
   * Deletes are a LISTED `drop`, never `props: {k: undefined}`, because these
   * objects are also the collab wire format and `JSON.stringify` drops an
   * undefined value entirely: the delete would arrive at every other replica as
   * a no-op, and one editor would be looking at frozen panes nobody else has.
   * The same trap sits on the INVERSE — undoing a newly-added key has to say
   * "remove it", which is a `drop`, not a `props` entry that vanishes in
   * transit. `props: {k: undefined}` is REFUSED rather than treated as a
   * second spelling of delete.
   */
  | { op: 'setSheetProps'; sheet: string; props: Record<string, unknown>; drop?: string[] }
  /**
   * Top-level document fields — the story, a dashboard layout, anything
   * additive that belongs to the WORKBOOK rather than to a sheet.
   *
   * Same discipline as `setSheetProps`, for the same reason: deletes are a
   * listed `drop`, and `props: {k: undefined}` is refused rather than accepted
   * as a second spelling, because `JSON.stringify` erases it and the delete
   * would reach no other replica.
   */
  | { op: 'setDocProps'; props: Record<string, unknown>; drop?: string[] }
  /**
   * One dashboard view, by id. `view: undefined` removes it.
   *
   * Per-view rather than a whole-`views` write, so editing one tile carries an
   * inverse the size of one view instead of every dashboard in the workbook —
   * the same argument the byte-capped history makes everywhere else. `views` is
   * an ARRAY (order is the tab order and readers must agree on it), so a
   * replacement keeps its position and only a genuinely new id appends.
   */
  | { op: 'setView'; id: string; view?: View; at?: number; dropEmpty?: boolean }
  /**
   * Add or remove a whole sheet. `sheet: undefined` removes the one named.
   *
   * Adding and deleting a sheet used to go through `replaceDoc`, because
   * nothing in this union reached the sheet LIST — and `replaceDoc` CLEARS THE
   * UNDO STACK. So creating a pivot, or importing a CSV, silently threw away
   * every edit you could previously take back, and deleting a sheet could not
   * be undone at all. It is a whole-sheet assignment either way, so the inverse
   * carries the sheet and its POSITION: sheet order is the tab order, and
   * readers must agree on it.
   */
  | { op: 'setSheet'; id: string; sheet?: Sheet; at?: number }
  /**
   * Sheet ORDER, as a permutation of the ids. The tab strip's drag, and
   * `Move left` / `Move right`.
   *
   * WHY THIS EXISTS RATHER THAN TWO `setSheet`s. A move used to be a remove
   * followed by a re-insert, which is correct — `setSheet` on a sheet already
   * in the document REPLACES it in place, so one patch could not express a
   * move — and its inverse was correct too, carrying the sheet and its original
   * index so one ⌘Z put the tab back where it was rather than at the end.
   *
   * What it was not is CHEAP. This history is bounded by BYTES (see the header
   * and `UNDO_BYTES`), and the accounting is `JSON.stringify` of the inverse —
   * so the inverse of a re-insert stringified the WHOLE SHEET. Dragging a tab
   * on a 12MB workbook spent 12MB of a 24MB budget and evicted every earlier
   * entry: two drags and the undo stack was two drags long. O(sheet) for an
   * operation that changes an ARRAY ORDER, which is O(number of sheets) —
   * twenty ids, about 200 bytes, whatever the workbook weighs.
   *
   * MUST BE A PERMUTATION. `reorderColumns` drops ids it cannot find, which is
   * survivable for a column list; here an id left out of `order` would DELETE
   * a sheet, and a delete arriving inside a reorder is the kind of data loss
   * nobody thinks to look for. It is refused loudly instead, and
   * `crdt.committable` refuses it BEFORE the commit when a collaborator has
   * changed the sheet list underneath it.
   */
  | { op: 'reorderSheets'; order: string[] }
  /**
   * One comment thread, by id. `comment: undefined` removes it.
   *
   * Per-thread rather than rewriting `Sheet.comments` through `setSheetProps`:
   * that carried the WHOLE array in the inverse — about 75KB per keystroke at
   * five hundred threads, against a 24MB history cap — and under collaboration
   * it is a single LWW register, so two people adding a thread in the same
   * moment keep one of them. Keyed by id, exactly as `setView` is.
   */
  | { op: 'setComment'; sheet: string; id: string; comment?: Comment; at?: number }
  /**
   * Cells on a SPREADSHEET sheet (`kind: 'canvas'` — the sparse A1 map that has
   * been in the format since commit one).
   *
   * Keyed by **A1 address** — `A1`, `B7` — which is the format's key for this
   * kind and not a choice made here. model.ts calls it "the classic sparse A1
   * map"; `validate.ts` raises `bad-canvas-key` for anything else; `preview.ts`
   * parses A1 to find the used range for a file-manager thumbnail. It is NOT
   * `cellformula.cellKey(row, col)` — that is an internal computation key for a
   * recalc map, and writing it into the document would have made every cell
   * this op wrote invisible to the validator, the thumbnail and any other build.
   *
   * One op carries MANY cells because a paste, a fill and a delete are each one
   * edit to a reader and must be one undo step.
   *
   * A `null` or `undefined` entry REMOVES the cell rather than storing an empty
   * object — a sparse sheet whose cleared cells linger as `{}` is neither sparse
   * nor equal to the same sheet reached another way. `null` is the spelling that
   * survives JSON, which is what a collaborator receives.
   */
  | { op: 'setCanvasCells'; sheet: string; cells: Record<string, CanvasCell | null> }
  /**
   * Column widths and row heights on a SPREADSHEET sheet.
   *
   * `cols` is keyed by column LETTER and `rows` by the 1-based row number — the
   * two halves of an A1 address, so `"C": 180` reads as the column a reader can
   * see. A `null` removes the key, for the reason `setCanvasCells` gives.
   *
   * A SEPARATE OP from `setCanvasCells` rather than two more fields on it,
   * because the containers differ in the one way an inverse cares about:
   * `cells` is required on the kind and always exists, while `cols`/`rows` are
   * optional — so this op creates a container on the first write and deletes it
   * with the last key, or an apply-then-undo leaves `"cols": {}` in the file
   * for every other reader to diff.
   */
  | {
      op: 'setCanvasSizes'; sheet: string
      cols?: Record<string, number | null>; rows?: Record<string, number | null>
    }
  /**
   * RESERVED. Both need the transform engine, which does not exist yet. They
   * are in the union now because the discriminant cannot be retrofitted once
   * patches are also CRDT ops. `applyPatch` refuses them loudly rather than
   * pretending — a silent no-op here would be an edit the user believes landed.
   */
  | { op: 'applySteps'; sheet: string; steps: Step[] }
  | { op: 'refreshBinding'; sheet: string; cols: Record<string, ColumnData> }

/**
 * Document keys `setDocProps` refuses. `sheets` and `measures` have typed
 * patches that know how to invert them; `docId` is identity and must never be
 * rewritten by a props op (PLATFORM: it is the merge key).
 */
const STRUCTURAL_DOC_KEYS = new Set([
  'sheets', 'measures', 'docId', 'format', 'version', 'policy',
])

/**
 * Raise a sheet's rid watermark past every rid in `rids`.
 *
 * MONOTONIC, and never lowered — not by undo either. A rid that has existed
 * must never be minted again, because everything that attaches to one
 * (overrides, comments, a peer's CRDT node) assumes it names one row forever.
 * This is why insert and delete are the ops whose apply→undo is not
 * byte-identical: the watermark is precisely the part that must survive.
 */
function raiseWatermark(sheet: TableSheet, rids: number[]): void {
  const hi = rids.reduce((m, r) => Math.max(m, r), 0) + 1
  const cur = (sheet as { nextRid?: number }).nextRid
  if (typeof cur !== 'number' || !Number.isFinite(cur) || cur < hi) sheet.nextRid = hi
}

/**
 * What a patch touched, so undo can invalidate precisely.
 *
 * If undo emitted a document-wide invalidation the patch log's entire win would
 * be thrown away at undo time — spaces' `restore` emits `doc`+`tree`+`page` and
 * the editor rebuilds the page, which is correct for a page of prose and wrong
 * for 100k rows. A patch knows which cells it touched; the invalidation carries
 * that.
 */
export interface Touched {
  sheet?: string
  cols?: string[]
  rids?: number[]
  /** structure changed (rows added/removed, columns reordered) — relayout, not repaint */
  structural?: boolean
  /** genuinely everything: replaceDoc, and nothing else */
  all?: boolean
}

interface Entry {
  /** the patches that undo this step, in reverse application order */
  inverse: Patch[]
  touched: Touched
  bytes: number
}

// --- Column encoding -------------------------------------------------------
// Reading and writing one cell has to understand the encoding, because the
// encoding is what makes the format fit (4.8 bytes/cell dictionary-columnar
// against 15.9 array-of-objects). `pack` is an author-chosen archive encoding
// and is READ-ONLY here: writing to it would mean inflating a whole column on
// a keystroke, so an edit promotes it to `raw` at the call site instead.

/**
 * Row ids are run-length encoded — `[[1, 4200]]` is 20 bytes for 4200 rows —
 * but structural edits are far easier to get RIGHT on a flat list, and they are
 * rare (an import, an insert, a delete) rather than per-keystroke. So structural
 * ops expand, manipulate and re-compress; only reads walk the runs.
 */
const expandRids = (sheet: TableSheet): number[] => {
  const out: number[] = []
  for (const [start, count] of sheet.rids) for (let i = 0; i < count; i++) out.push(start + i)
  return out
}

const compressRids = (flat: number[]): Array<[number, number]> => {
  const out: Array<[number, number]> = []
  for (const rid of flat) {
    const tail = out[out.length - 1]
    if (tail && tail[0] + tail[1] === rid) tail[1]++
    else out.push([rid, 1])
  }
  return out
}

const ridIndex = (sheet: TableSheet, rid: number): number => {
  let i = 0
  for (const [start, count] of sheet.rids) {
    if (rid >= start && rid < start + count) return i + (rid - start)
    i += count
  }
  return -1
}

/**
 * Change a column's type, and SAY SO when it will not go.
 *
 * The `setColumn` case throws when a value cannot be read as the new type,
 * which is the right thing — refusing beats zeroing. But a throw is only half
 * an answer, and the missing half was measured on screen: the reader picked
 * "Money", the commit threw into the console, and the dropdown went on
 * displaying **money** while the column header chip beside it displayed
 * **Text**. Two controls disagreeing, no message, nothing to act on.
 *
 * That is the same shape as the bug this whole change exists to fix — the app
 * knowing something and not saying it — and it is the second time this exact
 * pattern has appeared in this codebase, after the Offline switch that stayed
 * ticked over a preference that had not persisted.
 *
 * So both call sites go through here: it commits, and on refusal it reports the
 * reason and returns false so the caller can put its control back. A third call
 * site that forgets is the failure mode this function exists to remove.
 */
export function setColumnType(
  store: Store,
  sheetId: string,
  colId: string,
  next: ColumnType,
  report: (message: string) => void,
): boolean {
  try {
    store.commit({ op: 'setColumn', sheet: sheetId, col: colId, patch: { type: next } })
    return true
  } catch (e) {
    report(e instanceof Error ? e.message : String(e))
    return false
  }
}

export function readCell(data: ColumnData | undefined, row: number): unknown {
  if (!data || row < 0) return null
  if (data.enc === 'raw') return data.v[row] ?? null
  if (data.enc === 'dict') {
    const k = data.idx[row]
    return k == null ? null : (data.dict[k] ?? null)
  }
  return null // `pack` is opaque until inflated
}

function writeCell(data: ColumnData, row: number, v: unknown): void {
  if (data.enc === 'raw') {
    data.v[row] = v as never
    return
  }
  if (data.enc === 'dict') {
    if (v == null) { data.idx[row] = null; return }
    const s = String(v)
    let k = data.dict.indexOf(s)
    if (k < 0) { k = data.dict.length; data.dict.push(s) }
    data.idx[row] = k
    return
  }
  throw new Error('cannot write into a packed column; promote it to raw first')
}

const totalRows = (sheet: TableSheet): number =>
  sheet.rids.reduce((n, [, c]) => n + c, 0)

// --- Apply -----------------------------------------------------------------

const table = (doc: DashDoc, id: string): TableSheet => {
  const s = doc.sheets.find((x: Sheet) => x.id === id)
  if (!s || s.kind !== 'table') throw new Error(`no table sheet ${id}`)
  return s
}

/**
 * The sheet by id, WHATEVER ITS KIND — for the ops that are about a sheet
 * rather than about a dataset. `setSheetProps` is the one today (a name, and
 * later anything else every kind has); `setComment` says the same thing inline
 * because a remark on a pivot is a remark.
 *
 * Still throws when the id names nothing: an op that cannot find its target is
 * an edit the user believes landed, and applyPatch's rule is to refuse loudly.
 */
const anySheet = (doc: DashDoc, id: string): Sheet => {
  const s = doc.sheets.find((x: Sheet) => x.id === id)
  if (!s) throw new Error(`no sheet ${id}`)
  return s
}

const canvas = (doc: DashDoc, id: string): CanvasSheet => {
  const s = doc.sheets.find((x: Sheet) => x.id === id)
  if (!s || s.kind !== 'canvas') throw new Error(`no spreadsheet sheet ${id}`)
  return s
}

/**
 * Apply one patch, and return the patch that undoes it.
 *
 * The inverse is built from the values actually displaced, so it costs what the
 * edit costs — never what the document costs.
 */
export function applyPatch(doc: DashDoc, p: Patch): { inverse: Patch; touched: Touched } {
  switch (p.op) {
    case 'setCells': {
      const sheet = table(doc, p.sheet)
      const data = sheet.data[p.col]
      if (!data) throw new Error(`no column data ${p.col}`)
      const dictLen = data.enc === 'dict' ? data.dict.length : undefined
      const was: unknown[] = []
      p.rids.forEach((rid, i) => {
        const row = ridIndex(sheet, rid)
        if (row < 0) { was.push(null); return }
        was.push(readCell(data, row))
        writeCell(data, row, p.v[i])
      })
      if (p.dictLen !== undefined && data.enc === 'dict' && data.dict.length > p.dictLen) {
        data.dict.length = p.dictLen
      }
      return {
        inverse: { op: 'setCells', sheet: p.sheet, col: p.col, rids: p.rids, v: was, dictLen },
        touched: { sheet: p.sheet, cols: [p.col], rids: p.rids },
      }
    }

    case 'applySteps': {
      const sheet = table(doc, p.sheet)
      // The leading PROVENANCE ops are the attested head and are never re-run
      // (model.ts). `applySteps` owns the RE-EXECUTABLE tail and nothing above
      // it, so the inverse is bounded by the STEPS rather than by the data they
      // produce — a whole-sheet inverse would put document-sized snapshots into
      // a byte-capped history.
      let cut = sheet.steps.findIndex(
        (s) => !PROVENANCE_OPS.has((s as { op?: string }).op ?? ''),
      )
      if (cut < 0) cut = sheet.steps.length
      const was = sheet.steps.slice(cut)
      sheet.steps = [...sheet.steps.slice(0, cut), ...p.steps]
      return {
        inverse: { op: 'applySteps', sheet: p.sheet, steps: was },
        touched: { sheet: p.sheet, structural: true },
      }
    }
    case 'setCanvasCells': {
      const sheet = canvas(doc, p.sheet)
      // No `dropEmpty` twin of `setOverrides`: `cells` is REQUIRED on a
      // CanvasSheet and `parseDoc` always materialises it, so there is no
      // container to leave behind and no divergence to create.
      const was: Record<string, CanvasCell | null> = {}
      for (const [k, v] of Object.entries(p.cells)) {
        // the PREVIOUS value, or null for "there was nothing here" — so the
        // inverse of creating a cell REMOVES it rather than blanking it
        was[k] = sheet.cells[k] ?? null
        if (v === undefined || v === null) delete sheet.cells[k]
        else sheet.cells[k] = v
      }
      return {
        inverse: { op: 'setCanvasCells', sheet: p.sheet, cells: was },
        touched: { sheet: p.sheet },
      }
    }

    case 'setCanvasSizes': {
      const sheet = canvas(doc, p.sheet)
      const axis = (
        which: 'cols' | 'rows', want: Record<string, number | null> | undefined,
      ): Record<string, number | null> | undefined => {
        if (!want) return undefined
        const bag = (sheet[which] ??= {})
        const was: Record<string, number | null> = {}
        for (const [k, v] of Object.entries(want)) {
          was[k] = bag[k] ?? null
          if (v === undefined || v === null) delete bag[k]
          else bag[k] = v
        }
        // THE CONTAINER GOES WITH ITS LAST KEY, in both directions. `cols` and
        // `rows` are OPTIONAL on the kind, so absent and `{}` say the same
        // thing — and if only the forward patch dropped it, undoing the FIRST
        // width ever set would leave `"cols": {}` behind, which is a file that
        // differs from the one the edit started with and a diff every other
        // reader has to explain.
        if (!Object.keys(bag).length) delete sheet[which]
        return was
      }
      const cols = axis('cols', p.cols)
      const rows = axis('rows', p.rows)
      return {
        inverse: {
          op: 'setCanvasSizes', sheet: p.sheet,
          ...(cols ? { cols } : {}), ...(rows ? { rows } : {}),
        },
        touched: { sheet: p.sheet },
      }
    }
    case 'setOverrides': {
      const sheet = table(doc, p.sheet)
      const existed = sheet.cells !== undefined
      sheet.cells ??= {}
      const was: Array<CellOverride | undefined> = []
      p.keys.forEach((k, i) => {
        was.push(sheet.cells![k])
        const v = p.v[i]
        // `null` deletes as well as `undefined`, and it is the spelling that
        // SURVIVES: this is an array, and `JSON.stringify([undefined])` is
        // `[null]`, so a delete sent over collab arrives as a null. Checking
        // only for undefined would write that null in as an override — junk in
        // the file, `dropEmpty` never firing, and the two replicas disagreeing
        // about whether the cell has one.
        if (v === undefined || v === null) delete sheet.cells![k]
        else sheet.cells![k] = v
      })
      if (p.dropEmpty && Object.keys(sheet.cells).length === 0) delete sheet.cells
      return {
        inverse: {
          op: 'setOverrides', sheet: p.sheet, keys: p.keys, v: was,
          // `dropEmpty` BOTH WAYS. Undoing the removal of the last override used
          // to leave `cells: {}` behind on the undoing replica, while every peer
          // received the change through a path that drops the container. Twelve
          // bytes in the file, and a document that no longer matches its own
          // collaborators — the engine normalised it afterwards, but the store
          // should not create the divergence in the first place.
          dropEmpty: !existed || p.dropEmpty === true,
        },
        touched: {
          sheet: p.sheet,
          cols: [...new Set(p.keys.map((k) => k.slice(0, k.indexOf(':'))))],
          rids: p.keys.map((k) => Number(k.slice(k.indexOf(':') + 1))),
        },
      }
    }

    case 'insertRows': {
      const sheet = table(doc, p.sheet)
      const flat = expandRids(sheet)
      // ascending, so each splice index stays valid as earlier ones land.
      //
      // CLAMPED, and it has to be. `splice` past the end APPENDS, but the
      // `writeCell` below writes at the literal index — so an `at` beyond the
      // sheet put the row at position 3 and its value at position 10, leaving
      // the column longer than the sheet has rows with a hole of nulls
      // between. Measured on a 3-row sheet: rids said 4 rows, the column held
      // 11 entries. rowcol.ts clamps before it builds the patch, so the UI
      // never produced this — but `window.bento.commit` is a public API and a
      // remote op is another producer, and applyPatch is where the invariant
      // has to hold.
      const order = p.rids
        .map((rid, i) => ({ rid, at: Math.max(0, Math.min(p.at?.[i] ?? flat.length + i, flat.length + i)), i }))
        .sort((a, b) => a.at - b.at)
      for (const { rid, at, i } of order) {
        flat.splice(at, 0, rid)
        for (const [col, d] of Object.entries(sheet.data)) {
          const v = p.values?.[col]?.[i] ?? null
          if (d.enc === 'raw') d.v.splice(at, 0, null)
          else if (d.enc === 'dict') d.idx.splice(at, 0, null)
          // through writeCell, so a dict column re-interns rather than growing
          // a second encoding beside itself
          if (v !== null) writeCell(d, at, v)
        }
      }
      sheet.rids = compressRids(flat)
      raiseWatermark(sheet, p.rids)
      // put back whatever the delete took with it
      if (p.overrides) {
        sheet.cells ??= {}
        for (const [k, v] of Object.entries(p.overrides)) sheet.cells[k] = v
      }
      return {
        inverse: { op: 'deleteRows', sheet: p.sheet, rids: p.rids },
        touched: { sheet: p.sheet, rids: p.rids, structural: true },
      }
    }

    case 'deleteRows': {
      const sheet = table(doc, p.sheet)
      // ON DELETE TOO — this is the half that matters. Raising the mark only on
      // insert leaves nothing remembering that a DELETED rid ever existed, so
      // the floor (derived from the current maximum) drops back and the next
      // insert mints it again. Measured before this line: rid 3 deleted, then
      // minted for a different row.
      raiseWatermark(sheet, p.rids)
      // capture position AND value before anything moves — the inverse has to
      // put each row back exactly where it was, because order is data
      const taken = p.rids
        .map((rid) => ({ rid, at: ridIndex(sheet, rid) }))
        .filter((r) => r.at >= 0)
        .sort((a, b) => a.at - b.at)
      const restore: Record<string, unknown[]> = {}
      for (const [col, d] of Object.entries(sheet.data)) {
        restore[col] = taken.map((r) => readCell(d, r.at))
      }
      // descending, so each splice leaves the remaining indices valid
      const flat = expandRids(sheet)
      for (let i = taken.length - 1; i >= 0; i--) {
        flat.splice(taken[i].at, 1)
        for (const d of Object.values(sheet.data)) {
          if (d.enc === 'raw') d.v.splice(taken[i].at, 1)
          else if (d.enc === 'dict') d.idx.splice(taken[i].at, 1)
        }
      }
      sheet.rids = compressRids(flat)

      // TAKE THE ROW'S OVERRIDES WITH IT, and hand them to the inverse.
      //
      // A deleted row's `cells` entries used to be left behind — orphaned, keyed
      // to a rid that no longer names anything, and resurrected on top of
      // whatever came back. rowcol.deleteRowsAt clears them, so the UI path was
      // safe; but `insertRows`' own inverse is a BARE deleteRows, so undoing an
      // insert went through here and stranded any override added to that row in
      // the meantime — on the undoing replica only, since the sync engine strips
      // them everywhere else. That is a divergence, and it is invisible.
      const doomed = new Set(taken.map((r) => r.rid))
      const overKeys: string[] = []
      const overWas: Array<CellOverride | null> = []
      for (const k of Object.keys(sheet.cells ?? {})) {
        const i = k.indexOf(':')
        if (i < 0 || !doomed.has(Number(k.slice(i + 1)))) continue
        overKeys.push(k)
        overWas.push(sheet.cells![k])
        delete sheet.cells![k]
      }
      const hadCells = sheet.cells !== undefined
      if (sheet.cells && !Object.keys(sheet.cells).length) delete sheet.cells

      const overrides: Record<string, CellOverride> = {}
      overKeys.forEach((k, i) => { const v = overWas[i]; if (v) overrides[k] = v })
      return {
        inverse: {
          op: 'insertRows', sheet: p.sheet,
          rids: taken.map((r) => r.rid), at: taken.map((r) => r.at), values: restore,
          ...(overKeys.length ? { overrides, dropEmptyCells: !hadCells } : {}),
        },
        touched: { sheet: p.sheet, rids: p.rids, structural: true },
      }
    }

    case 'addColumn': {
      const sheet = table(doc, p.sheet)
      const at = p.at ?? sheet.columns.length
      sheet.columns.splice(at, 0, p.column)
      if (p.data) sheet.data[p.column.id] = p.data
      return {
        inverse: { op: 'removeColumn', sheet: p.sheet, col: p.column.id },
        touched: { sheet: p.sheet, cols: [p.column.id], structural: true },
      }
    }

    case 'removeColumn': {
      const sheet = table(doc, p.sheet)
      const at = sheet.columns.findIndex((c) => c.id === p.col)
      if (at < 0) throw new Error(`no column ${p.col}`)
      const [column] = sheet.columns.splice(at, 1)
      const data = sheet.data[p.col]
      delete sheet.data[p.col]
      // the inverse carries the column AND its data, or undoing a delete
      // returns an empty column — the same failure deleteRows had
      return {
        inverse: { op: 'addColumn', sheet: p.sheet, column, at, ...(data ? { data } : {}) },
        touched: { sheet: p.sheet, cols: [p.col], structural: true },
      }
    }

    case 'setColumn': {
      const sheet = table(doc, p.sheet)
      const col = sheet.columns.find((c) => c.id === p.col)
      if (!col) throw new Error(`no column ${p.col}`)
      const was: Record<string, unknown> = {}
      for (const k of Object.keys(p.patch)) was[k] = (col as Record<string, unknown>)[k]

      // A TYPE CHANGE MUST CONVERT THE STORAGE, or the column's declared type
      // and its bytes disagree and every reader downstream believes the
      // declaration.
      //
      // This shipped, and it produced a WRONG NUMBER at the end of a path dash
      // itself recommends. Import lands a mixed column as `text` and advises
      // "set the column type once you have decided what it is". Doing that used
      // to rewrite only `col.type`: the grid began right-aligning and
      // number-formatting the values, and `aggregate` (grid.ts) — which skips
      // anything not already `typeof v === 'number'` — totalled them as
      // **zero**. Measured on a real import: footer `SUM 0` against a true
      // total of 10,308.85, which dash returns correctly from `=SUM(D2:D10)`
      // on a spreadsheet copy of the same rows. A confident wrong total is
      // worse than a refusal and much worse than an error.
      //
      // The conversion reuses IMPORT's own coercion (`inferColumn`/`coerce`/
      // `encodeColumn`) rather than a second implementation, so "what counts as
      // a number" has one answer here, on import, and on paste.
      //
      // WHAT WILL NOT CONVERT IS REFUSED, NOT ZEROED. `coerce` answers null for
      // a value it cannot read, and writing those nulls would silently delete
      // data on a dropdown change. So the patch throws with a count and an
      // example, the commit is abandoned, and the column keeps both its old
      // type and its old bytes. That matches the house rule import already
      // follows: refuse where you cannot decide.
      let dataWas: ColumnData | undefined

      // AN INVERSE CARRYING BYTES RESTORES THEM. Undo of a type change has to
      // put back the storage as well as the declaration; restoring only the
      // declaration leaves exactly the disagreement this case exists to
      // prevent, pointing the other way.
      if (p.data !== undefined) {
        dataWas = sheet.data[p.col]
        sheet.data[p.col] = p.data
        Object.assign(col, p.patch)
        return {
          inverse: { op: 'setColumn', sheet: p.sheet, col: p.col, patch: was, data: dataWas },
          touched: { sheet: p.sheet, cols: [p.col], structural: true },
        }
      }

      const nextType = p.patch.type as ColumnType | undefined
      if (nextType !== undefined && nextType !== col.type) {
        const n = totalRows(sheet)
        const src = sheet.data[p.col]
        const rawText: string[] = []
        for (let i = 0; i < n; i++) {
          const v = readCell(src, i)
          rawText.push(v == null ? '' : String(v))
        }
        const inf = { ...inferColumn(rawText), type: nextType }
        const out: unknown[] = []
        let lost = 0
        let firstLost = ''
        for (let i = 0; i < n; i++) {
          const t = rawText[i]
          if (t.trim() === '') { out.push(null); continue }
          const c = coerce(t, inf)
          if (c === null) { lost++; if (!firstLost) firstLost = t }
          out.push(c)
        }
        if (lost) {
          throw new Error(
            `${lost} value${lost === 1 ? '' : 's'} in “${col.name}” cannot be read as ${nextType}` +
            `${firstLost ? ` (for example “${firstLost}”)` : ''}. The column was left as it was.`,
          )
        }
        dataWas = src
        sheet.data[p.col] = encodeColumn(out, nextType)
      }

      Object.assign(col, p.patch)
      return {
        inverse: {
          op: 'setColumn', sheet: p.sheet, col: p.col, patch: was,
          ...(dataWas !== undefined ? { data: dataWas } : {}),
        },
        touched: { sheet: p.sheet, cols: [p.col], ...(dataWas !== undefined ? { structural: true } : {}) },
      }
    }

    case 'reorderColumns': {
      const sheet = table(doc, p.sheet)
      const was = sheet.columns.map((c) => c.id)
      const by = new Map(sheet.columns.map((c) => [c.id, c]))
      sheet.columns = p.order.map((id) => by.get(id)!).filter(Boolean)
      return {
        inverse: { op: 'reorderColumns', sheet: p.sheet, order: was },
        touched: { sheet: p.sheet, structural: true },
      }
    }

    case 'setMeasure': {
      const existed = doc.measures !== undefined
      doc.measures ??= {}
      const was = doc.measures[p.name]
      if (p.measure === undefined) delete doc.measures[p.name]
      else doc.measures[p.name] = p.measure
      if (p.dropEmpty && Object.keys(doc.measures).length === 0) delete doc.measures
      return {
        inverse: { op: 'setMeasure', name: p.name, measure: was, dropEmpty: !existed },
        touched: {},
      }
    }

    case 'setComment': {
      // ANY sheet kind, not just a table: a remark on a pivot is a remark.
      const sheet = doc.sheets.find((sh) => sh.id === p.sheet) as
        (Sheet & { comments?: Comment[] }) | undefined
      if (!sheet) throw new Error(`no sheet "${p.sheet}"`)
      const existed = sheet.comments !== undefined
      sheet.comments ??= []
      const at = sheet.comments.findIndex((c) => c.id === p.id)
      const was = at < 0 ? undefined : sheet.comments[at]
      if (p.comment === undefined) { if (at >= 0) sheet.comments.splice(at, 1) }
      else if (at >= 0) sheet.comments[at] = p.comment
      else if (typeof p.at === 'number' && p.at >= 0 && p.at <= sheet.comments.length) {
        sheet.comments.splice(p.at, 0, p.comment)
      } else sheet.comments.push(p.comment)
      // add-then-remove must not leave `comments: []` behind — a round trip
      // that changes the file is a diff every other reader has to explain
      if (!existed && sheet.comments.length === 0) delete sheet.comments
      return {
        inverse: { op: 'setComment', sheet: p.sheet, id: p.id, comment: was, at: at < 0 ? undefined : at },
        touched: { sheet: p.sheet },
      }
    }

    case 'setSheet': {
      const at = doc.sheets.findIndex((sh) => sh.id === p.id)
      const was = at < 0 ? undefined : doc.sheets[at]
      if (p.sheet === undefined) { if (at >= 0) doc.sheets.splice(at, 1) }
      else if (at >= 0) doc.sheets[at] = p.sheet
      else if (typeof p.at === 'number' && p.at >= 0 && p.at <= doc.sheets.length) {
        doc.sheets.splice(p.at, 0, p.sheet)
      } else doc.sheets.push(p.sheet)
      return {
        inverse: { op: 'setSheet', id: p.id, sheet: was, at: at < 0 ? undefined : at },
        touched: { all: true },
      }
    }

    case 'reorderSheets': {
      const was = doc.sheets.map((s) => s.id)
      const by = new Map(doc.sheets.map((s) => [s.id, s]))
      // A PERMUTATION, checked all three ways — same length, every id known,
      // no id twice. Anything else and the map below would silently drop or
      // duplicate a sheet, which is a delete (or a second tab sharing one
      // sheet's arrays) arriving inside an operation that only claims to
      // change an order.
      if (
        p.order.length !== was.length ||
        new Set(p.order).size !== p.order.length ||
        p.order.some((id) => !by.has(id))
      ) {
        throw new Error('reorderSheets must name every sheet in the workbook exactly once')
      }
      doc.sheets = p.order.map((id) => by.get(id)!)
      // `all`, as `setSheet` is: the tab strip, the grid and every panel read
      // the sheet list. The INVERSE is what this op exists for — a list of ids,
      // not a sheet.
      return { inverse: { op: 'reorderSheets', order: was }, touched: { all: true } }
    }

    case 'setView': {
      const existed = doc.views !== undefined
      doc.views ??= []
      const at = doc.views.findIndex((v) => v.id === p.id)
      const was = at < 0 ? undefined : doc.views[at]
      if (p.view === undefined) { if (at >= 0) doc.views.splice(at, 1) }
      else if (at >= 0) doc.views[at] = p.view
      // `at` on the way IN is how the inverse of a removal restores POSITION.
      // Without it undo appended the view to the end, so undoing the deletion
      // of the first dashboard silently reordered the tabs — a change nobody
      // asked for, arriving inside the operation meant to undo one.
      else if (typeof p.at === 'number' && p.at >= 0 && p.at <= doc.views.length) {
        doc.views.splice(p.at, 0, p.view)
      } else doc.views.push(p.view)
      if (p.dropEmpty && doc.views.length === 0) delete doc.views
      return {
        inverse: { op: 'setView', id: p.id, view: was, at: at < 0 ? undefined : at, dropEmpty: !existed },
        touched: { all: true },
      }
    }

    case 'setDocProps': {
      const bag = doc as unknown as Record<string, unknown>
      const props: Record<string, unknown> = {}
      const drop: string[] = []
      const dropping = new Set(p.drop ?? [])
      const displace = (k: string): void => {
        if (STRUCTURAL_DOC_KEYS.has(k)) {
          throw new Error(`setDocProps may not write "${k}" — structure moves through typed patches`)
        }
        if (k in bag) props[k] = bag[k]
        else drop.push(k)
      }
      for (const k of Object.keys(p.props)) {
        if (dropping.has(k)) throw new Error(`setDocProps sets and drops "${k}" in one patch`)
        if (p.props[k] === undefined) {
          throw new Error(`setDocProps: to remove "${k}" list it in \`drop\`, not props`)
        }
        displace(k)
        bag[k] = p.props[k]
      }
      for (const k of dropping) { displace(k); delete bag[k] }
      return {
        inverse: { op: 'setDocProps', props, ...(drop.length ? { drop } : {}) },
        touched: { all: true },
      }
    }

    case 'setSheetProps':
      // The writer lives in rowcol.ts beside `freezeAt`, which is what emits
      // these, and is covered there. Two copies of one op is how the inverse
      // and the forward drift apart.
      //
      // `anySheet`, NOT `table`. This narrowed to a dataset and threw on
      // everything else, which made the SHEET NAME — the one property every
      // kind has — writable on datasets alone: renaming a spreadsheet tab built
      // a valid patch and died here with `no table sheet`, and the tab strip
      // shipped a disabled Rename for the kinds it could not reach. The op's
      // own writer never looked at a column or a rid; the narrowing was the
      // whole of the restriction. (`applySheetProps` still refuses every
      // structural key, so widening the kind does not widen what can be
      // written.)
      return applySheetProps(anySheet(doc, p.sheet), p)

    case 'setTitle': {
      const was = doc.title
      doc.title = p.title
      return { inverse: { op: 'setTitle', title: was }, touched: {} }
    }

    default:
      // applySteps / refreshBinding, and anything a future build sends us.
      // Refusing loudly is the point: a silent no-op is an edit the user
      // believes landed.
      throw new Error(`patch op "${(p as { op: string }).op}" is not implemented yet`)
  }
}

const patchBytes = (p: Patch): number => JSON.stringify(p).length

// --- Store -----------------------------------------------------------------

export class Store {
  doc: DashDoc
  readOnly = false
  /** view state: never in the document, never synced, never undoable by default */
  order: Record<string, number[] | undefined> = {}
  private undoStack: Entry[] = []
  private redoStack: Entry[] = []
  private listeners = new Map<StoreEvent, Set<Listener>>()
  private runCell: string | null = null
  private runTimer: ReturnType<typeof setTimeout> | undefined
  private pending: { inverse: Patch[]; touched: Touched; bytes: number } | null = null
  /**
   * Set while a document change is being applied and broadcast.
   *
   * The grid re-derives its order vector from inside the `doc` listener
   * (grid.ts: a structural edit renumbers the rows the vector holds), so a
   * `view()` call arriving here is DERIVED — the consequence of an edit, not
   * something the reader did. `viewBarrier` exists to tell those two apart and
   * this counter is the only honest way to do it.
   */
  private inDocChange = 0
  /**
   * THE READER'S LAST ACTION WAS A VIEW ACTION — see `view()` and `undo()`.
   *
   * Null means the last thing they did was a document edit (or nothing).
   */
  private viewBarrier = false
  /**
   * How the store speaks to the reader, when refusing.
   *
   * A FIELD RATHER THAN AN IMPORT, and the same shape `setColumnType` takes its
   * `report` in: this module runs in the node rigs and must not reach the DOM.
   * Default swallows, so a build that never lends it a voice is quieter than it
   * should be but never wrong. panels.ts lends it `toast` today.
   */
  say: (message: string) => void = () => {}

  constructor(doc: DashDoc) {
    this.doc = doc
  }

  on(ev: StoreEvent, fn: Listener): () => void {
    const set = this.listeners.get(ev) ?? new Set()
    this.listeners.set(ev, set)
    set.add(fn)
    return () => set.delete(fn)
  }

  private emit(ev: StoreEvent): void {
    for (const fn of this.listeners.get(ev) ?? []) fn()
  }

  /**
   * The document changed UNDERNEATH this store — a collaborator's edit applied
   * surgically, not an edit made here.
   *
   * It is deliberately not `commit`: somebody else's change is not an entry in
   * your undo history, and routing it through the undo stack would let you
   * "undo" a keystroke you never made. But every listener still has to repaint,
   * so this stamps `modified`, invalidates everything and emits the same events
   * an edit does.
   *
   * The alternative, which is what the sync session did before this existed,
   * was to reach through `unknown` and call the PRIVATE `emit`. That works
   * until the day the event names change, and nothing tells you.
   */
  changedRemotely(touched: Touched = { all: true }): void {
    this.doc.modified = new Date().toISOString()
    this.lastTouched = touched
    // NOT a barrier reset: somebody else's edit is not the reader's last
    // action, exactly as it is not an entry in their undo history.
    this.inDocChange++
    try {
      this.emit('doc')
      this.emit('view')
    } finally { this.inDocChange-- }
  }

  /** The last invalidation, for a listener that wants to repaint precisely. */
  lastTouched: Touched = {}

  /**
   * One undoable step: apply patches, record their inverses as ONE entry.
   * Closes any open typing run first, so a run's text and a structural edit
   * never merge into one entry.
   */
  /**
   * Listeners that see every patch BEFORE it is applied, and may replace the
   * list — collaboration's entry point.
   *
   * WHY A HOOK RATHER THAN WRAPPING THE VERBS. The sync session used to
   * decorate `commit` and `runEdit` on the instance, which covers every edit
   * the UI makes and cannot see UNDO and REDO — those apply their inverses
   * through a private path. Undo therefore fell back to broadcasting a whole
   * state snapshot: correct, and enormously heavier than the two ops it
   * stands in for. `invert` calls this too, so an undo now ships as ops.
   *
   * The listener runs BEFORE the document changes because the CRDT reads what
   * a delete is about to displace; `afterPatch` is the other half.
   */
  beforePatch(fn: (patches: Patch[]) => Patch[] | void): () => void {
    this.patchHooks.push(fn)
    return () => { this.patchHooks = this.patchHooks.filter((f) => f !== fn) }
  }

  /** Listeners that run once the document HAS changed. */
  afterPatch(fn: () => void): () => void {
    this.appliedHooks.push(fn)
    return () => { this.appliedHooks = this.appliedHooks.filter((f) => f !== fn) }
  }

  private patchHooks: Array<(p: Patch[]) => Patch[] | void> = []
  private appliedHooks: Array<() => void> = []

  /**
   * Run the before-hooks. `substitute` is false for undo/redo: a hook may
   * REFUSE a patch it cannot express, and dropping one there would apply half
   * an inverse and leave the undo stack describing a document that no longer
   * exists. An undo must land whole or not at all.
   */
  private runBefore(list: Patch[], substitute = true): Patch[] {
    let out = list
    for (const fn of this.patchHooks) {
      const next = fn(out)
      if (substitute && Array.isArray(next)) out = next
    }
    return out
  }

  private runAfter(): void {
    for (const fn of this.appliedHooks) fn()
  }

  commit(patches: Patch | Patch[]): void {
    if (this.readOnly) return
    this.endRun()
    const list = this.runBefore(Array.isArray(patches) ? patches : [patches])
    if (!list.length) return
    const inverse: Patch[] = []
    const touched: Touched = {}
    let bytes = 0
    for (const p of list) {
      const r = applyPatch(this.doc, p)
      inverse.unshift(r.inverse) // undo in reverse application order
      bytes += patchBytes(r.inverse)
      merge(touched, r.touched)
    }
    this.push({ inverse, touched, bytes })
    this.touch()
    this.lastTouched = touched
    // The reader's last action is a document edit again, so undo has something
    // of theirs to reverse and no reason to hesitate.
    this.viewBarrier = false
    this.inDocChange++
    try {
      this.emit('doc')
      this.runAfter()
    } finally { this.inDocChange-- }
  }

  /**
   * An edit inside a typing run. The FIRST edit in a cell opens the entry;
   * every later one extends it in place, so a cell typed into forty times is
   * one undo step carrying one inverse — not forty.
   */
  runEdit(cellKey: string, patch: Patch | Patch[]): void {
    if (this.readOnly) return
    if (this.runCell !== cellKey) {
      this.endRun()
      this.runCell = cellKey
      this.pending = { inverse: [], touched: {}, bytes: 0 }
    }
    // Keep only the FIRST edit's inverse for this cell: it holds the value the
    // run started from, which is what undo must restore. Forty keystrokes are
    // one step back to where the typing began.
    const first = this.pending!.inverse.length === 0
    // One EDIT may be several patches — writing a value and clearing the
    // formula it replaced is two, and they have to undo as ONE step. Their
    // inverses go on REVERSED, because `invert` replays the list forward.
    const list = this.runBefore(Array.isArray(patch) ? patch : [patch])
    if (!list.length) return
    const inverses: Patch[] = []
    const r = { touched: {} as Touched }
    for (const p of list) {
      const one = applyPatch(this.doc, p)
      if (first) inverses.push(one.inverse)
      merge(r.touched, one.touched)
      this.lastTouched = one.touched
    }
    if (first) {
      inverses.reverse()
      this.pending!.inverse.push(...inverses)
      this.pending!.bytes = inverses.reduce((n, p) => n + patchBytes(p), 0)
    }
    merge(this.pending!.touched, r.touched)
    this.touch()
    this.viewBarrier = false
    this.inDocChange++
    try {
      this.emit('doc')
      this.runAfter()
    } finally { this.inDocChange-- }
    clearTimeout(this.runTimer)
    this.runTimer = setTimeout(() => this.endRun(), RUN_IDLE_MS)
  }

  /** Close the current run, if any. Idempotent. */
  endRun(): void {
    clearTimeout(this.runTimer)
    if (!this.runCell) return
    this.runCell = null
    if (this.pending && this.pending.inverse.length) this.push(this.pending)
    this.pending = null
  }

  /**
   * VIEW STATE — the third write verb, and the one nothing in spaces suggests.
   *
   * The grid reads through an order vector: sorting sorts the index, filtering
   * builds a mask. NEITHER touches the document, so neither takes a checkpoint,
   * sets the dirty flag, or produces an op. Writing the first sort as a
   * `commit` is the easy mistake, and nobody notices until a file saves itself
   * every time someone clicks a column header.
   *
   * A SORT IS STILL NOT UNDOABLE, AND UNDO NO LONGER PRETENDS OTHERWISE.
   *
   * The open question this comment used to hold was whether ⌘Z should reverse a
   * sort. Measured while it was open: sort a column, press ⌘Z, and the sort
   * stayed while the NUMBER FORMAT set two actions earlier came off. The reader
   * keeps the thing they asked to reverse and loses a thing they were not
   * thinking about, with nothing said either way. "Sort is not undoable" is
   * defensible; silently undoing something else is not.
   *
   * A real view history still belongs to the grid, not here — `docs/DECISIONS.md`
   * ("one view vector") puts the filters and sorts in grid.ts and the store owns
   * only the vector they produce, so a stack kept here would restore the row
   * order while the header arrow, the status line and the filter menu went on
   * describing the sort that had just been undone, and the next `applyView()`
   * would put it back. Half an undo that lies is worse than none.
   *
   * So the store does the one thing it CAN see and CAN promise: it notices that
   * the reader's last action changed the rows on screen without changing the
   * document, and makes the next undo REFUSE and say so, instead of reaching
   * past the sort for an edit nobody asked about. One press to be told; a
   * second press to undo the edit anyway.
   *
   * THE TEST FOR "THE READER DID THIS" is that the order map changed and no
   * document change was in flight. That is deliberately about the VECTOR rather
   * than about sorts and filters by name: the store cannot see grid.ts's
   * `filters`/`sorts` (nor should it), and filter.ts is free to widen what a
   * filter is without this having to hear about it. It errs towards arming —
   * switching to a sheet that still holds a stale vector clears it here, and
   * that arms the barrier too. Costing one keypress after a tab switch is the
   * right side to be wrong on, and undoing an edit on the sheet you just left
   * is the same surprise anyway.
   */
  view(mutate: () => void): void {
    if (this.inDocChange) { mutate(); this.emit('view'); return }
    const before = { ...this.order }
    mutate()
    if (orderChanged(before, this.order)) this.viewBarrier = true
    this.emit('view')
  }

  /** Model changed without a new undo entry (mid-run). */
  touch(): void {
    this.doc.modified = new Date().toISOString()
  }

  private push(e: Entry): void {
    this.undoStack.push(e)
    this.redoStack.length = 0
    // Walk backwards dropping the OLDEST entries once the budget is exceeded —
    // spaces' splice, unchanged (store.ts:144-152).
    let bytes = 0
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      bytes += this.undoStack[i].bytes
      if (bytes > UNDO_BYTES) { this.undoStack.splice(0, i + 1); break }
    }
  }

  private invert(e: Entry): Entry {
    const inverse: Patch[] = []
    const touched: Touched = {}
    let bytes = 0
    // THE POINT OF THE HOOK. Undo and redo change the document exactly as an
    // edit does, and a collaborator has to hear about it. Without this the
    // session could not see them at all and fell back to broadcasting a whole
    // state snapshot. `substitute: false` — see runBefore.
    this.runBefore(e.inverse, false)
    for (const p of e.inverse) {
      const r = applyPatch(this.doc, p)
      inverse.unshift(r.inverse)
      bytes += patchBytes(r.inverse)
      merge(touched, r.touched)
    }
    this.touch()
    this.lastTouched = touched
    this.inDocChange++
    try {
      this.emit('doc')
      this.runAfter()
    } finally { this.inDocChange-- }
    return { inverse, touched, bytes }
  }

  /**
   * The refusal, once. Returns true when this press was spent saying no.
   *
   * ONLY WHEN THERE IS SOMETHING TO REVERSE: with an empty stack the next press
   * would do nothing either, so "press it again" would be a lie and the barrier
   * is simply dropped. Redo is guarded on the same footing — after a sort,
   * ⇧⌘Z reaching past it for a document edit is the same surprise pointing the
   * other way.
   */
  private blocked(has: boolean): boolean {
    if (!this.viewBarrier) return false
    this.viewBarrier = false
    if (!has) return false
    // ONE LITERAL, not a concatenation: the i18n rig sweeps t() calls out of the
    // source and cannot see through a `+`, and an unswept string is one that
    // silently never gets translated.
    this.say(t('Sorting and filtering are not changes to the data, so undo cannot take them back — clear them from the column’s ▾ menu. Nothing was undone; press undo again to undo the last change to the data.'))
    this.emit('view')
    return true
  }

  undo(): boolean {
    if (this.readOnly) return false
    this.endRun()
    if (this.blocked(this.undoStack.length > 0)) return false
    const e = this.undoStack.pop()
    if (!e) return false
    this.redoStack.push(this.invert(e))
    return true
  }

  redo(): boolean {
    if (this.readOnly) return false
    this.endRun()
    if (this.blocked(this.redoStack.length > 0)) return false
    const e = this.redoStack.pop()
    if (!e) return false
    this.undoStack.push(this.invert(e))
    return true
  }

  get canUndo(): boolean { return this.undoStack.length > 0 }
  get canRedo(): boolean { return this.redoStack.length > 0 }
  /** live bytes held by history — the number the cap is enforced against */
  get historyBytes(): number { return this.undoStack.reduce((n, e) => n + e.bytes, 0) }

  /** Wholesale replacement (agent load, version restore). The one `all` case. */
  replaceDoc(next: DashDoc): void {
    this.endRun()
    this.doc = next
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.order = {}
    this.viewBarrier = false
    this.lastTouched = { all: true }
    this.emit('doc')
    this.emit('view')
  }
}

/**
 * Did the rows on screen change?
 *
 * BY CONTENT, not by reference: `applyView` builds a fresh array every time it
 * runs, so reference equality would call re-applying an identical filter a
 * change. The walk costs a pass over a vector that was just built by a pass
 * over the same rows, and it only runs on a view change the reader made.
 */
function orderChanged(
  a: Record<string, number[] | undefined>, b: Record<string, number[] | undefined>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    const x = a[k]
    const y = b[k]
    if (x === y) continue
    if (!x || !y) return true          // one of them says "no filter, no sort"
    if (x.length !== y.length) return true
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return true
  }
  return false
}

function merge(into: Touched, from: Touched): void {
  if (from.all) { into.all = true; return }
  if (from.sheet) into.sheet = from.sheet
  if (from.structural) into.structural = true
  if (from.cols) into.cols = [...new Set([...(into.cols ?? []), ...from.cols])]
  if (from.rids) into.rids = [...new Set([...(into.rids ?? []), ...from.rids])]
}

export const _internals = { RUN_IDLE_MS, UNDO_BYTES, totalRows, ridIndex }
