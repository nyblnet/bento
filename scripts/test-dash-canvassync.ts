#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash SPREADSHEET convergence rig — the canvas kind's own rig.
//
//   node scripts/test-dash-canvassync.ts
//   SEEDS=200 STEPS=400 ACTORS=5 node scripts/test-dash-canvassync.ts
//   SEED_ONLY=137 node scripts/test-dash-canvassync.ts
//
// WHY THIS IS NOT scripts/test-dash-sync.ts. That rig exercises the DATASET
// kind, whose cells hang off row nodes keyed by a `rid` the FILE carries. A
// spreadsheet has no rids: its cells are a sparse A1 map, so they hang off the
// SHEET node keyed by their ADDRESS, and a write carries the whole cell object
// rather than one value. Different node space, different op, different failure
// modes — docs/dash-sheet-kinds.md says in as many words that this "needs its
// own convergence rig, not a reused one". This is it.
//
// The shape is the other rig's, because that shape has earned it: N replicas
// mutate their own document through the SAME patches the grid commits, ops
// travel over per-(from,to) FIFO queues in random interleavings, and at
// quiescence every replica's workbook AND its sync state must be identical.
//
// WHAT IT IS LOOKING FOR, specifically:
//   - two people editing DIFFERENT cells of one spreadsheet both keep their
//     edit (the thing that was broken: whole-document snapshots made every
//     spreadsheet keystroke last-writer-wins over the entire workbook);
//   - a value edit and a FORMATTING edit to the SAME cell both survive, since
//     they claim different halves of the cell;
//   - `v` and `f` never split — a formula and a cached value from two
//     different replicas would be a cell that never existed anywhere;
//   - clearing a cell REMOVES it (sparseness is semantics here, not a size
//     trick) and does so on every replica;
//   - column widths and row heights converge, containers and all;
//   - the snapshot fallback still fires for a patch the engine does not map.
//
// ROW AND COLUMN INSERTS ARE NOT EXERCISED, because they do not exist: the
// only spreadsheet patches in store.ts are `setCanvasCells` and
// `setCanvasSizes`, and neither moves an address. The header of crdt.ts states
// what a future insert has to do instead of being minted over positions, and
// the fallback case at the foot of this file pins the behaviour any unmapped
// patch gets in the meantime.

import { DashSync, committable } from '../dash/src/sync/crdt.ts'
import type { Op, SyncStateJSON } from '../dash/src/sync/crdt.ts'
import { applyPatch } from '../dash/src/store.ts'
import type { Patch } from '../dash/src/store.ts'
import type { CanvasCell, CanvasSheet, DashDoc } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) {
    failures++
    console.error(`  ✗ ${msg}`)
  }
}

function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

// ---------------------------------------------------------------------------
// simulated replicas
// ---------------------------------------------------------------------------

/**
 * Two spreadsheets and one dataset.
 *
 * The dataset is not scenery: the two kinds share a document, a sheet-node key
 * space and a `sheets` array, so a canvas key leaking into a sheet property (or
 * the reverse) has to be visible here rather than in a workbook that only ever
 * holds one kind.
 */
function baseDoc(): DashDoc {
  return {
    format: 'bento/dash',
    version: 1,
    docId: 'doc-1',
    title: 'Rig workbook',
    sheets: [
      {
        id: 'c1',
        name: 'Model',
        kind: 'canvas',
        cells: {
          A1: { v: 'Region' }, B1: { v: 'Amount', bold: true },
          A2: { v: 'EMEA' }, B2: { v: 1200 },
          A3: { v: 'AMER' }, B3: { v: 800 },
          B4: { f: '=SUM(B2:B3)', v: 2000 },
        },
        cols: { B: 140 },
      } as unknown as CanvasSheet,
      {
        id: 'c2',
        name: 'Scratch',
        kind: 'canvas',
        cells: { A1: { v: 'note' } },
      } as unknown as CanvasSheet,
      {
        id: 't1',
        name: 'Data',
        kind: 'table',
        rids: [[1, 3]],
        columns: [{ id: 'k', name: 'K', type: 'text' }, { id: 'n', name: 'N', type: 'number' }],
        data: { k: { enc: 'dict', dict: ['a', 'b', 'c'], idx: [0, 1, 2] }, n: { enc: 'raw', v: [1, 2, 3] } },
        steps: [],
      } as never,
    ],
    modified: 'never',
  } as unknown as DashDoc
}

const canvases = (d: DashDoc): CanvasSheet[] => d.sheets.filter((s) => s.kind === 'canvas') as CanvasSheet[]
const cv = (d: DashDoc, id: string): CanvasSheet | undefined =>
  d.sheets.find((s) => s.id === id && s.kind === 'canvas') as CanvasSheet | undefined

/**
 * A spreadsheet is SPARSE, and the sparseness is the invariant.
 *
 * A cleared cell that lingers as `{}` is not equal to the same sheet reached
 * another way: it changes the file, the used range preview.ts computes for a
 * thumbnail, and every later comparison. Checked after every apply, on every
 * replica, because the engine writes cells through a merge that can legitimately
 * empty one.
 */
function checkSparse(r: Replica, where: string): void {
  for (const s of canvases(r.doc)) {
    for (const [k, cell] of Object.entries(s.cells)) {
      if (cell && typeof cell === 'object' && Object.keys(cell).length) continue
      ok(false, `${where} @${r.actor}: ${s.id}!${k} is an empty cell rather than absent`)
      return
    }
    for (const axis of ['cols', 'rows'] as const) {
      const bag = s[axis]
      if (bag && !Object.keys(bag).length) {
        ok(false, `${where} @${r.actor}: ${s.id}.${axis} is an empty container rather than absent`)
        return
      }
    }
  }
}

class Replica {
  doc: DashDoc
  state: DashSync
  log: Op[] = []
  undoStack: Patch[][] = []
  actor: string
  counter = 0

  constructor(actor: string) {
    this.actor = actor
    this.doc = baseDoc()
    this.state = new DashSync(actor)
    this.state.adopt(this.doc)
  }

  /** the grid's commit path: mint ops for the patches, then apply them */
  commit(patches: Patch[]): Op[] {
    const list = patches.filter((p) => committable(this.doc, p))
    if (!list.length) return []
    const ops = this.state.local(this.doc, list)
    const inverse: Patch[] = []
    for (const p of list) inverse.unshift(applyPatch(this.doc, p).inverse)
    this.state.settle(this.doc)
    checkSparse(this, 'commit')
    this.undoStack.push(inverse)
    this.log.push(...ops)
    return ops
  }

  undo(): Op[] {
    const e = this.undoStack.pop()
    if (!e) return []
    const list = e.filter((p) => committable(this.doc, p))
    if (!list.length) return []
    const ops = this.state.local(this.doc, list)
    for (const p of list) applyPatch(this.doc, p)
    this.state.settle(this.doc)
    checkSparse(this, 'undo')
    this.log.push(...ops)
    return ops
  }

  /** sheet structure has no patch op the engine maps (see the design doc) */
  addSheet(id: string): Op[] {
    const sheet = { id, name: id, kind: 'canvas', cells: { A1: { v: id } } } as unknown as CanvasSheet
    this.doc.sheets.push(sheet)
    const op = this.state.sheetIns(this.doc, sheet)
    this.state.settle(this.doc)
    this.log.push(op)
    return [op]
  }

  delSheet(id: string): Op[] {
    const i = this.doc.sheets.findIndex((s) => s.id === id)
    if (i < 0) return []
    const op = this.state.sheetDel(id)
    this.doc.sheets.splice(i, 1)
    this.state.settle(this.doc)
    this.log.push(op)
    return [op]
  }

  receive(ops: Op[]) {
    this.state.apply(this.doc, ops)
    checkSparse(this, 'receive')
    for (const o of ops) if (!this.log.some((x) => x.a === o.a && x.s === o.s)) this.log.push(o)
  }

  snapshot(): { doc: DashDoc; state: SyncStateJSON } {
    return { doc: clone(this.doc), state: clone(this.state.toJSON()) }
  }

  fingerprint(): string {
    const d = clone(this.doc) as unknown as Record<string, unknown>
    delete d.modified
    return stable(d)
  }

  stateFingerprint(): string {
    const j = this.state.toJSON() as unknown as Record<string, unknown>
    // `stash` is excluded for the reason the dataset rig excludes it: it is a
    // dead-window holding area whose contents legitimately differ.
    return stable({ regs: j.regs, pos: j.pos, births: j.births, tombs: j.tombs, base: j.base, vv: j.vv })
  }
}

const COLS = ['A', 'B', 'C', 'D']
const FORMATS = ['#,##0', '0.00%', undefined]
const COLORS = ['#B33', '#39F', undefined]

/** every entry is a patch the grid really commits (grid.ts writeCanvas /
 *  setCanvasSize, cellprops.ts's formatting patches) */
function randomMutation(r: Replica, rnd: () => number): Patch[] {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
  const sheets = canvases(r.doc)
  if (!sheets.length) return []
  const sh = pick(sheets)
  const addr = () => `${pick(COLS)}${1 + Math.floor(rnd() * 6)}`
  switch (Math.floor(rnd() * 8)) {
    case 0: case 1: {
      // type a value into one or more cells (grid.editCanvas / a paste)
      const cells: Record<string, CanvasCell | null> = {}
      const n = 1 + Math.floor(rnd() * 3)
      for (let i = 0; i < n; i++) {
        const k = addr()
        const was = sh.cells[k]
        cells[k] = { ...(was ?? {}), v: rnd() < 0.4 ? pick(['EMEA', 'AMER', 'APAC']) : Math.floor(rnd() * 9999) }
      }
      return [{ op: 'setCanvasCells', sheet: sh.id, cells }]
    }
    case 2: {
      // a FORMULA cell: `f` and its cached `v` must travel as one fact
      const k = addr()
      const was = sh.cells[k]
      const n = Math.floor(rnd() * 99)
      return [{ op: 'setCanvasCells', sheet: sh.id, cells: { [k]: { ...(was ?? {}), f: `=A1+${n}`, v: n } } }]
    }
    case 3: {
      // formatting only — cellprops.ts writes the WHOLE cell back with one
      // presentation field changed, which is exactly what the claim mask is for
      const k = addr()
      const was = sh.cells[k]
      const next: CanvasCell = { ...(was ?? {}) }
      const field = pick(['bold', 'format', 'color', 'align'] as const)
      const value = field === 'bold' ? (rnd() < 0.5 ? true : undefined)
        : field === 'format' ? pick(FORMATS)
          : field === 'color' ? pick(COLORS) : pick(['right', undefined])
      if (value === undefined) delete next[field]
      else next[field] = value
      if (!Object.keys(next).length) return []
      return [{ op: 'setCanvasCells', sheet: sh.id, cells: { [k]: next } }]
    }
    case 4: {
      // clear cells (the Delete key)
      const cells: Record<string, CanvasCell | null> = {}
      const n = 1 + Math.floor(rnd() * 2)
      for (let i = 0; i < n; i++) cells[addr()] = null
      return [{ op: 'setCanvasCells', sheet: sh.id, cells }]
    }
    case 5: {
      // drag a column width or a row height, or clear one
      const drop = rnd() < 0.25
      return [rnd() < 0.5
        ? { op: 'setCanvasSizes', sheet: sh.id, cols: { [pick(COLS)]: drop ? null : 60 + Math.floor(rnd() * 200) } }
        : { op: 'setCanvasSizes', sheet: sh.id, rows: { [String(1 + Math.floor(rnd() * 6))]: drop ? null : 20 + Math.floor(rnd() * 30) } }]
    }
    case 6:
      return [{ op: 'setTitle', title: `Workbook ${Math.floor(rnd() * 1000)}` }]
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// random convergence runs
// ---------------------------------------------------------------------------
{
  console.log('random convergence runs…')
  const SEEDS = parseInt(process.env.SEEDS ?? '60', 10)
  const SEED_ONLY = process.env.SEED_ONLY ? parseInt(process.env.SEED_ONLY, 10) : 0
  const STEPS = parseInt(process.env.STEPS ?? '160', 10)
  const W = parseInt(process.env.DIFF_WIDTH ?? '120', 10)
  const ACTORS = parseInt(process.env.ACTORS ?? '3', 10)
  for (let seed = SEED_ONLY || 1; seed <= (SEED_ONLY || SEEDS); seed++) {
    const rnd = mulberry32(seed * 7919)
    const N = ACTORS
    const reps = Array.from({ length: N }, (_, i) => new Replica(`a${i}`))
    const queues = new Map<string, Op[][]>()
    const qk = (f: number, t: number) => `${f}>${t}`
    for (let f = 0; f < N; f++) for (let t = 0; t < N; t++) if (f !== t) queues.set(qk(f, t), [])

    for (let s = 0; s < STEPS; s++) {
      if (rnd() < 0.45) {
        const i = Math.floor(rnd() * N)
        const r = reps[i]
        const dice = rnd()
        const ops = dice < 0.08 ? r.undo()
          : dice < 0.11 ? r.addSheet(`${r.actor}s${r.counter++}`)
            : dice < 0.13 ? (canvases(r.doc).length > 1 ? r.delSheet(canvases(r.doc)[Math.floor(rnd() * canvases(r.doc).length)].id) : [])
              : r.commit(randomMutation(r, rnd))
        if (ops.length) for (let t = 0; t < N; t++) if (t !== i) queues.get(qk(i, t))!.push(ops)
      } else {
        const edges = [...queues.entries()].filter(([, q]) => q.length)
        if (!edges.length) continue
        const [key, q] = edges[Math.floor(rnd() * edges.length)]
        reps[parseInt(key.split('>')[1], 10)].receive(q.shift()!)
      }
    }
    let moved = true
    while (moved) {
      moved = false
      for (const [key, q] of queues) {
        if (!q.length) continue
        moved = true
        reps[parseInt(key.split('>')[1], 10)].receive(q.shift()!)
      }
    }
    const fp0 = reps[0].fingerprint()
    const st0 = reps[0].stateFingerprint()
    let bad = false
    for (let i = 1; i < N; i++) {
      ok(reps[i].fingerprint() === fp0, `seed ${seed}: workbook diverged (replica ${i})`)
      ok(reps[i].stateFingerprint() === st0, `seed ${seed}: sync state diverged (replica ${i})`)
      if (reps[i].fingerprint() !== fp0 || reps[i].stateFingerprint() !== st0) bad = true
    }
    if (bad) {
      for (const part of ['regs', 'pos', 'births', 'tombs', 'vv'] as const) {
        const p0 = stable((reps[0].state.toJSON() as unknown as Record<string, unknown>)[part])
        for (let i = 1; i < N; i++) {
          const pi = stable((reps[i].state.toJSON() as unknown as Record<string, unknown>)[part])
          if (pi === p0) continue
          let d = 0
          while (d < p0.length && p0[d] === pi[d]) d++
          console.error(`    seed ${seed} ${part} differs @${d}:\n      r0: …${p0.slice(Math.max(0, d - 60), d + 140)}\n      r${i}: …${pi.slice(Math.max(0, d - 60), d + 140)}`)
        }
      }
      for (let i = 1; i < N; i++) {
        const fi = reps[i].fingerprint()
        if (fi === fp0) continue
        let d = 0
        while (d < fp0.length && fp0[d] === fi[d]) d++
        console.error(`    seed ${seed} workbook differs @${d}:\n      r0: …${fp0.slice(Math.max(0, d - W), d + W * 2)}\n      r${i}: …${fi.slice(Math.max(0, d - W), d + W * 2)}`)
      }
      break
    }
  }
}

// ---------------------------------------------------------------------------
// targeted semantics
// ---------------------------------------------------------------------------

const pair = () => [new Replica('A'), new Replica('B')] as const
const cell = (r: Replica, a1: string, sheet = 'c1'): CanvasCell | undefined => cv(r.doc, sheet)?.cells[a1]

{
  // THE FAILURE THIS WORK EXISTS TO FIX. Whole-document snapshots made this
  // last-writer-wins over the entire workbook: one of the two edits vanished.
  console.log('two people edit DIFFERENT cells of one spreadsheet — both survive…')
  const [A, B] = pair()
  const oa = A.commit([{ op: 'setCanvasCells', sheet: 'c1', cells: { B2: { v: 5555 } } }])
  const ob = B.commit([{ op: 'setCanvasCells', sheet: 'c1', cells: { B3: { v: 7777 } } }])
  A.receive(ob)
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'different-cell edits converged')
  ok(cell(A, 'B2')?.v === 5555 && cell(A, 'B3')?.v === 7777, `both edits kept on A: ${JSON.stringify(cell(A, 'B2'))} / ${JSON.stringify(cell(A, 'B3'))}`)
  ok(cell(B, 'B2')?.v === 5555 && cell(B, 'B3')?.v === 7777, 'both edits kept on B')
}
{
  console.log('…and the two edits are ONE op each, not a workbook snapshot…')
  const A = new Replica('A')
  const ops = A.state.local(A.doc, [{ op: 'setCanvasCells', sheet: 'c1', cells: { B2: { v: 1 } } }])
  ok(ops.length === 1 && ops[0].op === 'cvc', `one cell op minted: ${JSON.stringify(ops.map((o) => o.op))}`)
  ok(!A.state.unsynced, 'and the snapshot fallback is NOT armed for a spreadsheet write')
  const sizes = A.state.local(A.doc, [{ op: 'setCanvasSizes', sheet: 'c1', cols: { C: 180 } }])
  ok(sizes.length === 1 && sizes[0].op === 'cvz', 'a size drag mints a size op')
  ok(!A.state.unsynced, 'and does not arm the fallback either')
}
{
  console.log('same cell, same half: one wins and both agree…')
  const [A, B] = pair()
  const oa = A.commit([{ op: 'setCanvasCells', sheet: 'c1', cells: { B2: { v: 111 } } }])
  const ob = B.commit([{ op: 'setCanvasCells', sheet: 'c1', cells: { B2: { v: 222 } } }])
  A.receive(ob)
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'same-cell race converged')
  ok(cell(A, 'B2')?.v === cell(B, 'B2')?.v, 'one value on both sides')
}
{
  console.log('value vs FORMATTING on the same cell: both halves survive…')
  const [A, B] = pair()
  // B2 starts as {v:1200}. A retypes it; B bolds it — cellprops.ts writes the
  // whole cell back, so without the claim mask B's write would re-assert 1200.
  const oa = A.commit([{ op: 'setCanvasCells', sheet: 'c1', cells: { B2: { v: 4242 } } }])
  const ob = B.commit([{ op: 'setCanvasCells', sheet: 'c1', cells: { B2: { v: 1200, bold: true } } }])
  A.receive(ob)
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'value-vs-format converged')
  ok(cell(A, 'B2')?.v === 4242 && cell(A, 'B2')?.bold === true, `both halves kept: ${JSON.stringify(cell(A, 'B2'))}`)
}
{
  console.log('a formula and its cached value are ONE fact, never split…')
  const [A, B] = pair()
  // A makes B4 a different formula; B retypes B4 as a plain number. Whichever
  // wins, the cell must be one replica's whole content — never A's `f` beside
  // B's `v`, which is a cell that existed nowhere.
  const oa = A.commit([{ op: 'setCanvasCells', sheet: 'c1', cells: { B4: { f: '=B2*2', v: 2400 } } }])
  const ob = B.commit([{ op: 'setCanvasCells', sheet: 'c1', cells: { B4: { v: 99 } } }])
  A.receive(ob)
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'formula-vs-value converged')
  const c = cell(A, 'B4')!
  ok((c.f === '=B2*2' && c.v === 2400) || (c.f === undefined && c.v === 99),
    `content stayed coherent: ${JSON.stringify(c)}`)
}
{
  // The case above passes even if `f` were filed under PRESENTATION, because
  // both writes there happen to claim both halves. This one does not: it is
  // the negative control for the content/presentation SPLIT itself, and it
  // fails the moment `f` leaves the content half.
  console.log('…and the formula lives in the CONTENT half, not the presentation one…')
  const [A, B] = pair()
  // A rewrites the formula and leaves the cached value alone (a formula edit
  // before the recalculation lands); B bolds the same cell.
  const oa = A.commit([{ op: 'setCanvasCells', sheet: 'c1', cells: { B4: { f: '=B2*2', v: 2000 } } }])
  const ob = B.commit([{ op: 'setCanvasCells', sheet: 'c1', cells: { B4: { f: '=SUM(B2:B3)', v: 2000, bold: true } } }])
  A.receive(ob)
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'formula-vs-bold converged')
  ok(cell(A, 'B4')?.f === '=B2*2' && cell(A, 'B4')?.bold === true,
    `the formula edit and the bold both survived: ${JSON.stringify(cell(A, 'B4'))}`)
}
{
  console.log('clearing a cell removes it everywhere, and beats an older write…')
  const [A, B] = pair()
  const oa = A.commit([{ op: 'setCanvasCells', sheet: 'c1', cells: { A2: null } }])
  A.receive(B.commit([{ op: 'setCanvasCells', sheet: 'c2', cells: { A1: null } }]))
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'clears converged')
  ok(!('A2' in cv(A.doc, 'c1')!.cells) && !('A2' in cv(B.doc, 'c1')!.cells), 'the key is gone, not blanked')
  ok(!('A1' in cv(A.doc, 'c2')!.cells), 'and the other sheet cleared too')
  ok(!('cells' in cv(A.doc, 'c2')!) === false, 'the required `cells` container itself stays (the kind requires it)')
}
{
  console.log('a clear and a concurrent format: the survivor is a formatted empty cell, identically…')
  const [A, B] = pair()
  const oa = A.commit([{ op: 'setCanvasCells', sheet: 'c1', cells: { B2: null } }])
  const ob = B.commit([{ op: 'setCanvasCells', sheet: 'c1', cells: { B2: { v: 1200, color: '#B33' } } }])
  A.receive(ob)
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'clear-vs-format converged')
  ok(stable(cell(A, 'B2')) === stable(cell(B, 'B2')), 'the same cell on both sides')
}
{
  console.log('column widths and row heights converge, containers included…')
  const [A, B] = pair()
  const oa = A.commit([{ op: 'setCanvasSizes', sheet: 'c1', cols: { C: 180 } }])
  const ob = B.commit([{ op: 'setCanvasSizes', sheet: 'c1', rows: { '3': 44 } }])
  A.receive(ob)
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'sizes converged')
  ok(cv(A.doc, 'c1')!.cols!.C === 180 && cv(A.doc, 'c1')!.rows!['3'] === 44, 'both sizes landed')
  // and clearing the LAST entry takes the container with it, on both sides
  const oc = A.commit([{ op: 'setCanvasSizes', sheet: 'c1', rows: { '3': null } }])
  B.receive(oc)
  ok(!('rows' in cv(A.doc, 'c1')!) && !('rows' in cv(B.doc, 'c1')!), 'the emptied container is gone on both')
  ok(A.fingerprint() === B.fingerprint(), 'container removal converged')
}
{
  console.log('an op that arrives before its sheet waits, then lands…')
  const [A, B] = pair()
  const ins = A.addSheet('cX')
  const write = A.commit([{ op: 'setCanvasCells', sheet: 'cX', cells: { C3: { v: 7 } } }])
  B.receive(write) // out of order: the sheet is not here yet
  ok(!cv(B.doc, 'cX'), 'the write did not fabricate a sheet')
  B.receive(ins)
  ok(cell(B, 'C3', 'cX')?.v === 7, 'and landed once the sheet arrived')
  ok(A.fingerprint() === B.fingerprint(), 'late-sheet delivery converged')
}
{
  console.log('a sheet delete beats a concurrent cell write, both orders…')
  const [A, B] = pair()
  const del = A.delSheet('c2')
  const write = B.commit([{ op: 'setCanvasCells', sheet: 'c2', cells: { Z9: { v: 1 } } }])
  A.receive(write)
  B.receive(del)
  ok(A.fingerprint() === B.fingerprint(), 'delete-vs-write converged')
  ok(!cv(A.doc, 'c2') && !cv(B.doc, 'c2'), 'the sheet is gone on both')
}
{
  console.log('undo of a spreadsheet edit ships as ops, and converges…')
  const [A, B] = pair()
  const oa = A.commit([{ op: 'setCanvasCells', sheet: 'c1', cells: { A2: { v: 'LATAM' }, B2: { v: 1 } } }])
  B.receive(oa)
  const back = A.undo()
  ok(back.length > 0 && back.every((o) => o.op === 'cvc'), 'the undo minted cell ops, not a snapshot')
  B.receive(back)
  ok(A.fingerprint() === B.fingerprint(), 'undo converged')
  ok(cell(A, 'A2')?.v === 'EMEA' && cell(B, 'A2')?.v === 'EMEA', 'the original value is back on both')
}
{
  console.log('offline forks merge two-way through a snapshot…')
  const [A, B] = pair()
  A.commit([{ op: 'setCanvasCells', sheet: 'c1', cells: { A2: { v: 'FORK-A' }, C5: { v: 5 } } }])
  A.commit([{ op: 'setCanvasSizes', sheet: 'c1', cols: { D: 99 } }])
  B.commit([{ op: 'setCanvasCells', sheet: 'c1', cells: { A3: { v: 'FORK-B' }, B2: { bold: true, v: 1200 } } }])
  const sa = A.snapshot()
  const sb = B.snapshot()
  A.state.mergeSnapshot(A.doc, sb.doc, sb.state)
  B.state.mergeSnapshot(B.doc, sa.doc, sa.state)
  ok(A.fingerprint() === B.fingerprint(), 'two-way snapshot merge converged')
  ok(cell(A, 'A2')?.v === 'FORK-A' && cell(A, 'A3')?.v === 'FORK-B', `both forks' edits survived: ${JSON.stringify(cell(A, 'A2'))} / ${JSON.stringify(cell(A, 'A3'))}`)
  ok(cell(A, 'B2')?.bold === true && cv(A.doc, 'c1')!.cols!.D === 99, 'formatting and a width crossed too')
  // and no canvas register leaked out as a property of the sheet object
  const junk = Object.keys(cv(A.doc, 'c1')!).filter((k) => k.includes('\u001f'))
  ok(!junk.length, `no register key written onto the sheet object: ${junk}`)
}
{
  console.log('a spreadsheet write into a sheet a collaborator deleted is refused, not thrown…')
  const A = new Replica('A')
  const p: Patch = { op: 'setCanvasCells', sheet: 'gone', cells: { A1: { v: 1 } } }
  ok(committable(A.doc, p) === false, 'committable refuses a missing sheet (applyPatch would throw)')
  ok(committable(A.doc, { op: 'setCanvasCells', sheet: 't1', cells: { A1: { v: 1 } } }) === false,
    'and refuses a DATASET sheet, which this patch cannot address')
  ok(committable(A.doc, { op: 'setCanvasSizes', sheet: 'c1', cols: { A: 10 } }) === true,
    'while a real spreadsheet passes')
}
{
  // The fallback is the safety net for everything this engine does not map,
  // and narrowing it must never remove it.
  console.log('an unmapped patch still raises the snapshot flag…')
  const A = new Replica('A')
  const ops = A.state.local(A.doc, [{ op: 'setSheet', id: 'c9', sheet: { id: 'c9', name: 'x', kind: 'canvas', cells: {} } } as unknown as Patch])
  ok(ops.length === 0 && A.state.unsynced, 'setSheet — which no arm handles — flags a whole-state snapshot')
  A.state.unsynced = false
  A.state.local(A.doc, [{ op: 'setCanvasCells', sheet: 'c1', cells: { A1: { v: 'x' } } }])
  ok(!A.state.unsynced, 'and a handled spreadsheet patch does not')
}
{
  // A ROW INSERT ON A SPREADSHEET, which is the case this rig cannot exercise
  // because the patch does not exist: `setCanvasCells` and `setCanvasSizes`
  // are the only two spreadsheet patches in store.ts and neither moves an
  // address. What CAN be pinned today is the behaviour whoever adds it will
  // inherit on day one — the snapshot fallback, not a dropped op and not
  // `cvc` ops minted over the addresses the shift lands on. Two replicas
  // shifting cells concurrently renumber each other's writes, and no register
  // ordering repairs that (crdt.ts's header states the rule and what a real
  // implementation has to do instead).
  console.log('a spreadsheet row insert — which does not exist yet — falls to the snapshot, not to cell ops…')
  const A = new Replica('A')
  const rowIns = { op: 'insertCanvasRows', sheet: 'c1', at: 2, n: 1 } as unknown as Patch
  const ops = A.state.local(A.doc, [rowIns])
  ok(ops.length === 0, 'no cvc ops were minted over the addresses it would move')
  ok(A.state.unsynced, 'and the whole-state snapshot is armed instead — coarse and correct')
}

console.log(`\n${failures ? `${failures} FAILURES` : 'ALL PASS'} (${checks} checks)`)
if (failures) process.exit(1)
