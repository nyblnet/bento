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

import type { CellOverride, Column, ColumnData, DashDoc, Measure, Sheet, Step, TableSheet } from './model.ts'

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
      v: Array<CellOverride | undefined>; dropEmpty?: boolean
    }
  /**
   * `at[i]` is the row POSITION rids[i] takes; omitted means append.
   * `values` is colId → one value per rid.
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
    }
  | { op: 'deleteRows'; sheet: string; rids: number[] }
  | { op: 'setColumn'; sheet: string; col: string; patch: Record<string, unknown> }
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
   * RESERVED. Both need the transform engine, which does not exist yet. They
   * are in the union now because the discriminant cannot be retrofitted once
   * patches are also CRDT ops. `applyPatch` refuses them loudly rather than
   * pretending — a silent no-op here would be an edit the user believes landed.
   */
  | { op: 'applySteps'; sheet: string; steps: Step[] }
  | { op: 'refreshBinding'; sheet: string; cols: Record<string, ColumnData> }

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

    case 'setOverrides': {
      const sheet = table(doc, p.sheet)
      const existed = sheet.cells !== undefined
      sheet.cells ??= {}
      const was: Array<CellOverride | undefined> = []
      p.keys.forEach((k, i) => {
        was.push(sheet.cells![k])
        const v = p.v[i]
        if (v === undefined) delete sheet.cells![k]
        else sheet.cells![k] = v
      })
      if (p.dropEmpty && Object.keys(sheet.cells).length === 0) delete sheet.cells
      return {
        inverse: {
          op: 'setOverrides', sheet: p.sheet, keys: p.keys, v: was,
          dropEmpty: !existed,
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
      // ascending, so each splice index stays valid as earlier ones land
      const order = p.rids.map((rid, i) => ({ rid, at: p.at?.[i] ?? flat.length + i, i }))
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
      return {
        inverse: { op: 'deleteRows', sheet: p.sheet, rids: p.rids },
        touched: { sheet: p.sheet, rids: p.rids, structural: true },
      }
    }

    case 'deleteRows': {
      const sheet = table(doc, p.sheet)
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
      return {
        inverse: {
          op: 'insertRows', sheet: p.sheet,
          rids: taken.map((r) => r.rid), at: taken.map((r) => r.at), values: restore,
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
      Object.assign(col, p.patch)
      return {
        inverse: { op: 'setColumn', sheet: p.sheet, col: p.col, patch: was },
        touched: { sheet: p.sheet, cols: [p.col] },
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

  /** The last invalidation, for a listener that wants to repaint precisely. */
  lastTouched: Touched = {}

  /**
   * One undoable step: apply patches, record their inverses as ONE entry.
   * Closes any open typing run first, so a run's text and a structural edit
   * never merge into one entry.
   */
  commit(patches: Patch | Patch[]): void {
    if (this.readOnly) return
    this.endRun()
    const list = Array.isArray(patches) ? patches : [patches]
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
    this.emit('doc')
  }

  /**
   * An edit inside a typing run. The FIRST edit in a cell opens the entry;
   * every later one extends it in place, so a cell typed into forty times is
   * one undo step carrying one inverse — not forty.
   */
  runEdit(cellKey: string, patch: Patch): void {
    if (this.readOnly) return
    if (this.runCell !== cellKey) {
      this.endRun()
      this.runCell = cellKey
      this.pending = { inverse: [], touched: {}, bytes: 0 }
    }
    const r = applyPatch(this.doc, patch)
    // keep only the FIRST inverse for this cell: it holds the value the run
    // started from, which is what undo must restore
    if (this.pending!.inverse.length === 0) {
      this.pending!.inverse.push(r.inverse)
      this.pending!.bytes = patchBytes(r.inverse)
    }
    merge(this.pending!.touched, r.touched)
    this.touch()
    this.lastTouched = r.touched
    this.emit('doc')
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
   * OPEN QUESTION: Excel users press ⌘Z after a sort and expect it undone. That
   * needs a separate view-history, not the document's undo stack — deliberately
   * not built here, because guessing it wrong is worse than leaving it.
   */
  view(mutate: () => void): void {
    mutate()
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
    for (const p of e.inverse) {
      const r = applyPatch(this.doc, p)
      inverse.unshift(r.inverse)
      bytes += patchBytes(r.inverse)
      merge(touched, r.touched)
    }
    this.touch()
    this.lastTouched = touched
    this.emit('doc')
    return { inverse, touched, bytes }
  }

  undo(): boolean {
    if (this.readOnly) return false
    this.endRun()
    const e = this.undoStack.pop()
    if (!e) return false
    this.redoStack.push(this.invert(e))
    return true
  }

  redo(): boolean {
    if (this.readOnly) return false
    this.endRun()
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
    this.lastTouched = { all: true }
    this.emit('doc')
    this.emit('view')
  }
}

function merge(into: Touched, from: Touched): void {
  if (from.all) { into.all = true; return }
  if (from.sheet) into.sheet = from.sheet
  if (from.structural) into.structural = true
  if (from.cols) into.cols = [...new Set([...(into.cols ?? []), ...from.cols])]
  if (from.rids) into.rids = [...new Set([...(into.rids ?? []), ...from.rids])]
}

export const _internals = { RUN_IDLE_MS, UNDO_BYTES, totalRows, ridIndex }
