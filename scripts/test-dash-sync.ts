#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash convergence rig — the check that matters.
//
//   node scripts/test-dash-sync.ts                  (Node >= 23.6 strips types)
//   SEEDS=200 STEPS=300 ACTORS=4 node scripts/test-dash-sync.ts
//   SEED_ONLY=137 DBG_NODE='r<US>s1<US>7' node scripts/test-dash-sync.ts
//
// Property-based, modelled on scripts/test-sync.ts (which caught 15+ ordering
// bugs in slides): N simulated actors mutate their own replica through the SAME
// patches the editor commits, ops travel over per-(from,to) FIFO queues in
// random interleavings, and at quiescence every replica's materialized workbook
// AND sync state must be identical.
//
// Plus targeted cases for everything dash does that slides does not: per-cell
// LWW inside a columnar sheet, the row RGA over rids (concurrent inserts at one
// anchor, an insert anchored to a row someone else deleted), delete-vs-edit,
// undo resurrection with stashed cell values, column add/remove/reorder, sheet
// delete, dictionary columns surviving a re-ordering, and two-way snapshot
// merge of offline forks.

import { DashSync, committable, mergeOrder, keyBetween, spreadKey, rowNode, _internals } from '../dash/src/sync/crdt.ts'
import type { Op } from '../dash/src/sync/crdt.ts'
import { applyPatch } from '../dash/src/store.ts'
import type { Patch } from '../dash/src/store.ts'
import type { DashDoc, TableSheet } from '../dash/src/model.ts'

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
// order-key + merge-order unit properties
// ---------------------------------------------------------------------------
{
  console.log('order keys and the symmetric row-order merge…')
  const rnd = mulberry32(3)
  const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const randKey = () => {
    let k = ''
    const n = 1 + Math.floor(rnd() * 6)
    for (let i = 0; i < n; i++) k += DIGITS[Math.floor(rnd() * 62)]
    while (k.endsWith('0') && k.length > 1) k = k.slice(0, -1)
    return k === '0' ? '1' : k
  }
  for (let i = 0; i < 10000; i++) {
    let a = randKey()
    let b = randKey()
    if (a === b) continue
    if (a > b) [a, b] = [b, a]
    const m = keyBetween(a, b)
    ok(a < m && m < b, `between(${a},${b}) = ${m} out of range`)
  }
  for (let n = 1; n <= 40; n++) {
    for (let i = 0; i + 1 < n; i++) ok(spreadKey(i, n) < spreadKey(i + 1, n), `spreadKey(${i},${n}) not increasing`)
  }
  // SYMMETRY is the whole requirement: two forks that swap snapshots must land
  // on one order, so mergeOrder(a,b) === mergeOrder(b,a) for every input.
  for (let i = 0; i < 4000; i++) {
    const universe = [1, 2, 3, 4, 5, 6, 7, 8]
    const pick = (p: number) => universe.filter(() => rnd() < p)
    const a = pick(0.7)
    const b = pick(0.7)
    const births = new Map<number, [number, string]>()
    for (const r of universe) if (rnd() < 0.5) births.set(r, [Math.floor(rnd() * 5), rnd() < 0.5 ? 'A' : 'B'])
    const bo = (r: number) => births.get(r)
    const x = mergeOrder(a, b, bo)
    const y = mergeOrder(b, a, bo)
    ok(x.join(',') === y.join(','), `mergeOrder asymmetric: ${a} / ${b} → ${x} vs ${y}`)
    ok(new Set(x).size === x.length, `mergeOrder duplicated: ${x}`)
    ok(x.length === new Set([...a, ...b]).size, `mergeOrder lost rows: ${a} / ${b} → ${x}`)
  }
}

// ---------------------------------------------------------------------------
// simulated replicas
// ---------------------------------------------------------------------------

function baseDoc(): DashDoc {
  return {
    format: 'bento/dash',
    version: 1,
    docId: 'doc-1',
    title: 'Rig workbook',
    theme: { background: '#0D1B2E', color: '#F2F0EA', accent: '#FF9E8A', fontFamily: 'x' },
    measures: { Revenue: { name: 'Revenue', expr: 'SUM(amount)', grain: 's1', additive: true } },
    sheets: [
      {
        id: 's1',
        name: 'Deals',
        kind: 'table',
        // one dict column (the default encoding, and the one with an interning
        // hazard) and two raw ones, so every random run exercises both writers
        rids: [[1, 6]],
        columns: [
          { id: 'region', name: 'Region', type: 'text' },
          { id: 'amount', name: 'Amount', type: 'money', scale: 2 },
          { id: 'prob', name: 'Probability', type: 'percent' },
        ],
        data: {
          region: { enc: 'dict', dict: ['EMEA', 'AMER', 'APAC'], idx: [0, 1, 2, 0, 1, 2] },
          amount: { enc: 'raw', v: [1200, 800, 4400, 150, 990, 2000] },
          prob: { enc: 'raw', v: [0.4, 0.9, 0.25, 1, 0.6, 0.75] },
        },
        cells: { 'amount:3': { v: 4400, was: 4000, why: 'restated', by: 'rig' } },
        totals: { amount: 'sum' },
        steps: [{ op: 'import', from: 'rig.csv', at: '2026-08-01T00:00:00.000Z', rows: 6 }],
      } as unknown as TableSheet,
      {
        id: 's2',
        name: 'Rates',
        kind: 'table',
        rids: [[1, 3]],
        columns: [
          { id: 'ccy', name: 'Currency', type: 'text' },
          { id: 'rate', name: 'Rate', type: 'number' },
        ],
        data: {
          ccy: { enc: 'dict', dict: ['USD', 'EUR', 'GBP'], idx: [0, 1, 2] },
          rate: { enc: 'raw', v: [1, 0.92, 0.79] },
        },
        steps: [],
      } as unknown as TableSheet,
    ],
    modified: 'never',
  } as unknown as DashDoc
}

const tables = (d: DashDoc): TableSheet[] => d.sheets.filter((s) => s.kind === 'table') as TableSheet[]

/**
 * Every column array must be exactly as long as the sheet has rows.
 *
 * Columnar storage addresses cells by POSITION, so a column that is one entry
 * short does not report an error — it silently returns the next row's number
 * for every row below the gap. That is the single worst failure this app can
 * have, and it is invisible in a diff of the two documents until the values
 * happen to differ. Checked after every single apply, on every replica.
 */
function checkShape(r: Replica, where: string): void {
  for (const s of tables(r.doc)) {
    const n = ridsOf(s).length
    for (const [col, d] of Object.entries(s.data)) {
      const len = d.enc === 'raw' ? d.v.length : d.enc === 'dict' ? d.idx.length : n
      if (len !== n) {
        ok(false, `${where} @${r.actor}: ${s.id}.${col} holds ${len} values for ${n} rows`)
        return
      }
    }
  }
}
/**
 * A sheet's `rids` must be SORTED by (order key, rid), always.
 *
 * That is the fractional index's whole contract: order is a pure function of
 * the keys, and `rowIndexFor` binary-searches the live list on the strength of
 * it. Let the list fall out of sort once and every later insert lands somewhere
 * arbitrary — the row order diverges while every register, birth and tomb still
 * agrees, which is exactly what class 1 looked like from the outside.
 * TRACE_ORDER=1 asserts it after every apply and names the first inversion.
 */
function checkOrder(r: Replica, where: string): void {
  for (const s of tables(r.doc)) {
    const rids = ridsOf(s)
    for (let i = 1; i < rids.length; i++) {
      const ka = r.state.rowOrderKey(s.id, rids[i - 1])
      const kb = r.state.rowOrderKey(s.id, rids[i])
      if (ka < kb || (ka === kb && rids[i - 1] < rids[i])) continue
      ok(false, `${where} @${r.actor}: ${s.id} out of order at ${i}: rid ${rids[i - 1]} (${ka}) before rid ${rids[i]} (${kb})`)
      return
    }
  }
}
const ridsOf = (s: TableSheet): number[] => _internals.rleExpand(s.rids)
const dataCols = (s: TableSheet): string[] => s.columns.filter((c) => s.data[c.id]).map((c) => c.id)

/**
 * Take a deleted row's or column's overrides with it.
 *
 * rowcol.deleteRowsAt / deleteColumn do exactly this, in the same commit, and
 * the rig has to model it or it is testing a patch the app never sends. It
 * lives HERE rather than in the mutation menu because the store's inverses
 * need it too: undoing an insertRows produces a bare `deleteRows`, and if the
 * row picked up an override in the meantime the undo orphans it — on the
 * undoing replica only, since every peer's engine strips it. That asymmetry is
 * the one store.ts change this design actually needs (see docs/dash-collab.md).
 */
function normalize(doc: DashDoc, patches: Patch[]): Patch[] {
  const out: Patch[] = []
  for (const p of patches) {
    const sheet = tables(doc).find((s) => s.id === (p as { sheet?: string }).sheet)
    const keys = !sheet ? [] : Object.keys(sheet.cells ?? {}).filter((k) => {
      if (p.op === 'deleteRows') return p.rids.includes(Number(k.slice(k.indexOf(':') + 1)))
      if (p.op === 'removeColumn') return k.slice(0, k.indexOf(':')) === p.col
      return false
    })
    if (keys.length) out.push({ op: 'setOverrides', sheet: sheet!.id, keys, v: keys.map(() => null), dropEmpty: true })
    out.push(p)
  }
  return out
}

class Replica {
  doc: DashDoc
  state: DashSync
  log: Op[] = []
  undoStack: Patch[][] = []
  actor: string
  counter = 0
  ridBase: number

  constructor(actor: string, ridBase: number) {
    this.actor = actor
    this.ridBase = ridBase
    this.doc = baseDoc()
    this.state = new DashSync(actor)
    this.state.adopt(this.doc)
  }

  /** the editor's commit path: mint ops for the patches, then apply them */
  commit(patches: Patch[]): Op[] {
    const list = normalize(this.doc, patches).filter((p) => committable(this.doc, p))
    if (!list.length) return []
    const ops = this.state.local(this.doc, list)
    const inverse: Patch[] = []
    for (const p of list) {
      inverse.unshift(applyPatch(this.doc, p).inverse)
      if (process.env.TRACE_SHAPE) {
        const before = failures
        checkShape(this, 'patch')
        if (failures !== before) console.error(`      patch was: ${JSON.stringify(p).slice(0, 300)}`)
      }
    }
    if (process.env.TRACE_SHAPE) checkShape(this, 'pre-settle')
    // a local change can be what a parked remote op was waiting for
    this.state.settle(this.doc)
    checkShape(this, 'commit')
    if (process.env.TRACE_ORDER) checkOrder(this, 'commit')
    this.undoStack.push(inverse)
    this.log.push(...ops)
    return ops
  }

  undo(): Op[] {
    const e = this.undoStack.pop()
    if (!e) return []
    // NOT pushed back as a redo entry — the rig only needs the forward/inverse
    // pair to exercise resurrection (undo of a delete = insert with values).
    const list = normalize(this.doc, e).filter((p) => committable(this.doc, p))
    if (!list.length) return []
    const ops = this.state.local(this.doc, list)
    for (const p of list) {
      applyPatch(this.doc, p)
      if (process.env.TRACE_SHAPE) {
        const before = failures
        checkShape(this, 'undo-patch')
        if (failures !== before) console.error(`      undo patch was: ${JSON.stringify(p).slice(0, 400)}`)
      }
    }
    this.state.settle(this.doc)
    checkShape(this, 'undo')
    if (process.env.TRACE_ORDER) checkOrder(this, 'undo')
    this.log.push(...ops)
    return ops
  }

  /** sheet structure has no patch op in store.ts yet (see the design doc) */
  addSheet(id: string, rid: number): Op[] {
    const sheet = {
      id, name: id, kind: 'table', rids: [[rid, 2]],
      columns: [{ id: 'k', name: 'K', type: 'text' }, { id: 'n', name: 'N', type: 'number' }],
      data: { k: { enc: 'dict', dict: ['a', 'b'], idx: [0, 1] }, n: { enc: 'raw', v: [1, 2] } },
      steps: [],
    } as unknown as TableSheet
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
    checkShape(this, 'receive')
    if (process.env.TRACE_ORDER) checkOrder(this, 'receive')
    for (const o of ops) if (!this.log.some((x) => x.a === o.a && x.s === o.s)) this.log.push(o)
  }

  fingerprint(): string {
    const d = clone(this.doc) as unknown as Record<string, unknown>
    delete d.modified
    // Dictionary ORDER is a local artefact: two replicas that interned the same
    // strings in a different sequence hold the same values. Normalise to the
    // materialized cell values, which is what the user and the file's readers
    // see. (The saved file differs byte-for-byte; it does not differ in data.)
    for (const s of (d.sheets as TableSheet[])) {
      if (s.kind !== 'table') continue
      const rids = ridsOf(s)
      const flat: Record<string, unknown[]> = {}
      for (const col of Object.keys(s.data)) {
        const enc = s.data[col]
        flat[col] = rids.map((_, i) =>
          enc.enc === 'dict' ? (enc.idx[i] == null ? null : enc.dict[enc.idx[i]!] ?? null)
            : enc.enc === 'raw' ? (enc.v[i] ?? null) : null)
      }
      ;(s as unknown as Record<string, unknown>).data = flat
    }
    return stable(d)
  }

  stateFingerprint(): string {
    const j = this.state.toJSON() as unknown as Record<string, unknown>
    // `stash` is deliberately excluded: it is a dead-window holding area whose
    // contents legitimately differ (one replica parks a value at delete time,
    // another never had it) and is only ever read through a register that both
    // sides agree on. Same call slides' rig makes for dead-node text state.
    return stable({ regs: j.regs, pos: j.pos, births: j.births, tombs: j.tombs, anchors: j.anchors, base: j.base, vv: j.vv })
  }
}

// mutation menu — every entry is a patch the editor really commits
function randomMutation(r: Replica, rnd: () => number): Patch[] {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
  const doc = r.doc
  const sheets = tables(doc)
  if (!sheets.length) return []
  const sh = pick(sheets)
  const rids = ridsOf(sh)
  const kind = Math.floor(rnd() * 13)
  switch (kind) {
    case 0:
      return [{ op: 'setTitle', title: `Workbook ${Math.floor(rnd() * 1000)}` }]
    case 1: {
      const name = pick(['Revenue', 'Margin', 'Pipeline'])
      return rnd() < 0.3
        ? [{ op: 'setMeasure', name }]
        : [{ op: 'setMeasure', name, measure: { name, expr: `SUM(x${Math.floor(rnd() * 9)})`, grain: sh.id, additive: true } }]
    }
    case 2:
      return [{ op: 'setSheetProps', sheet: sh.id, props: { name: `Sheet ${Math.floor(rnd() * 99)}` } }]
    case 3: {
      if (!sh.columns.length) return []
      const c = pick(sh.columns)
      return [{ op: 'setColumn', sheet: sh.id, col: c.id, patch: rnd() < 0.5 ? { name: `C${Math.floor(rnd() * 99)}` } : { w: 60 + Math.floor(rnd() * 200) } }]
    }
    case 4: {
      const cols = dataCols(sh)
      if (!cols.length || !rids.length) return []
      const col = pick(cols)
      const n = 1 + Math.floor(rnd() * Math.min(3, rids.length))
      const chosen: number[] = []
      while (chosen.length < n) {
        const rid = pick(rids)
        if (!chosen.includes(rid)) chosen.push(rid)
      }
      return [{ op: 'setCells', sheet: sh.id, col, rids: chosen, v: chosen.map(() => (rnd() < 0.3 ? pick(['EMEA', 'AMER', 'APAC', 'LATAM']) : Math.floor(rnd() * 9999))) }]
    }
    case 5: {
      const cols = dataCols(sh)
      if (!cols.length || !rids.length) return []
      const key = `${pick(cols)}:${pick(rids)}`
      return [{ op: 'setOverrides', sheet: sh.id, keys: [key], v: [rnd() < 0.35 ? null : { note: `n${Math.floor(rnd() * 99)}`, bg: '#eef' }], dropEmpty: true }]
    }
    case 6: {
      const n = 1 + Math.floor(rnd() * 2)
      const fresh = Array.from({ length: n }, () => r.ridBase + r.counter++)
      const at = Math.floor(rnd() * (rids.length + 1))
      const values: Record<string, unknown[]> = {}
      for (const col of dataCols(sh)) values[col] = fresh.map(() => Math.floor(rnd() * 500))
      return [{ op: 'insertRows', sheet: sh.id, rids: fresh, at: fresh.map((_, i) => at + i), values }]
    }
    case 7: {
      if (rids.length < 2) return []
      const n = 1 + Math.floor(rnd() * Math.min(2, rids.length - 1))
      const chosen: number[] = []
      while (chosen.length < n) {
        const rid = pick(rids)
        if (!chosen.includes(rid)) chosen.push(rid)
      }
      return [{ op: 'deleteRows', sheet: sh.id, rids: chosen }]
    }
    case 8: {
      const id = `${r.actor}c${r.counter++}`
      return [{
        op: 'addColumn', sheet: sh.id, at: Math.floor(rnd() * (sh.columns.length + 1)),
        column: { id, name: id, type: 'number' },
        data: { enc: 'raw', v: rids.map(() => Math.floor(rnd() * 100)) },
      }]
    }
    case 9: {
      if (sh.columns.length < 2) return []
      return [{ op: 'removeColumn', sheet: sh.id, col: pick(sh.columns).id }]
    }
    case 10: {
      if (sh.columns.length < 2) return []
      const order = sh.columns.map((c) => c.id)
      const i = Math.floor(rnd() * order.length)
      const [m] = order.splice(i, 1)
      order.splice(Math.floor(rnd() * (order.length + 1)), 0, m)
      return [{ op: 'reorderColumns', sheet: sh.id, order }]
    }
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
  if (process.env.DBG_NODE) (globalThis as Record<string, unknown>).__dbgNode = process.env.DBG_NODE
  for (let seed = SEED_ONLY || 1; seed <= (SEED_ONLY || SEEDS); seed++) {
    const rnd = mulberry32(seed * 7919)
    const N = ACTORS
    // rid spaces never overlap between actors: rids are minted at insert and
    // NEVER reused (rowcol.ts), and two actors minting the same number would be
    // two different rows claiming one identity — the exact failure this whole
    // scheme rests on not happening.
    const reps = Array.from({ length: N }, (_, i) => new Replica(`a${i}`, 1000 * (i + 1)))
    const queues = new Map<string, Op[][]>()
    const qk = (f: number, t: number) => `${f}>${t}`
    for (let f = 0; f < N; f++) for (let t = 0; t < N; t++) if (f !== t) queues.set(qk(f, t), [])

    for (let s = 0; s < STEPS; s++) {
      if (rnd() < 0.45) {
        const i = Math.floor(rnd() * N)
        const r = reps[i]
        ;(globalThis as Record<string, unknown>).__dbgTag = `mut@${r.actor}`
        const dice = rnd()
        const ops = dice < 0.06 ? r.undo()
          : dice < 0.09 ? r.addSheet(`${r.actor}s${r.counter++}`, r.ridBase + 500 + r.counter)
            : dice < 0.11 ? (tables(r.doc).length > 1 ? r.delSheet(tables(r.doc)[Math.floor(rnd() * tables(r.doc).length)].id) : [])
              : r.commit(randomMutation(r, rnd))
        if (ops.length) for (let t = 0; t < N; t++) if (t !== i) queues.get(qk(i, t))!.push(ops)
      } else {
        const edges = [...queues.entries()].filter(([, q]) => q.length)
        if (!edges.length) continue
        const [key, q] = edges[Math.floor(rnd() * edges.length)]
        const to = parseInt(key.split('>')[1], 10)
        ;(globalThis as Record<string, unknown>).__dbgTag = `recv@${reps[to].actor}`
        reps[to].receive(q.shift()!)
      }
    }
    let moved = true
    while (moved) {
      moved = false
      for (const [key, q] of queues) {
        if (!q.length) continue
        moved = true
        const to = parseInt(key.split('>')[1], 10)
        ;(globalThis as Record<string, unknown>).__dbgTag = `drain@${reps[to].actor}`
        reps[to].receive(q.shift()!)
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
      for (const part of ['regs', 'pos', 'births', 'tombs', 'anchors', 'vv'] as const) {
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

const pair = () => [new Replica('A', 1000), new Replica('B', 2000)] as const
const sheet1 = (r: Replica) => tables(r.doc)[0]
const cellAt = (r: Replica, col: string, rid: number): unknown => {
  const s = sheet1(r)
  const i = ridsOf(s).indexOf(rid)
  const d = s.data[col]
  if (i < 0 || !d) return undefined
  return d.enc === 'dict' ? (d.idx[i] == null ? null : d.dict[d.idx[i]!]) : d.enc === 'raw' ? d.v[i] : null
}

{
  console.log('per-cell LWW: different cells in one row both survive…')
  const [A, B] = pair()
  const oa = A.commit([{ op: 'setCells', sheet: 's1', col: 'amount', rids: [2], v: [999] }])
  const ob = B.commit([{ op: 'setCells', sheet: 's1', col: 'prob', rids: [2], v: [0.11] }])
  A.receive(ob)
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'per-cell converged')
  ok(cellAt(A, 'amount', 2) === 999 && cellAt(A, 'prob', 2) === 0.11, 'both edits kept')
}
{
  console.log('same cell concurrently: one wins, both agree…')
  const [A, B] = pair()
  const oa = A.commit([{ op: 'setCells', sheet: 's1', col: 'amount', rids: [1], v: [111] }])
  const ob = B.commit([{ op: 'setCells', sheet: 's1', col: 'amount', rids: [1], v: [222] }])
  A.receive(ob)
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'same-cell race converged')
  ok(cellAt(A, 'amount', 1) === cellAt(B, 'amount', 1), 'one value on both sides')
}
{
  console.log('dictionary column: concurrent writes of new strings both intern…')
  const [A, B] = pair()
  const oa = A.commit([{ op: 'setCells', sheet: 's1', col: 'region', rids: [1], v: ['LATAM'] }])
  const ob = B.commit([{ op: 'setCells', sheet: 's1', col: 'region', rids: [4], v: ['JAPAN'] }])
  A.receive(ob)
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'dict writes converged')
  ok(cellAt(A, 'region', 1) === 'LATAM' && cellAt(A, 'region', 4) === 'JAPAN', 'both strings landed')
  ok(cellAt(B, 'region', 1) === 'LATAM' && cellAt(B, 'region', 4) === 'JAPAN', 'both strings landed on B')
}
{
  console.log('row RGA: concurrent inserts at the same anchor converge…')
  const [A, B] = pair()
  const oa = A.commit([{ op: 'insertRows', sheet: 's1', rids: [1001], at: [3], values: { amount: [7] } }])
  const ob = B.commit([{ op: 'insertRows', sheet: 's1', rids: [2001], at: [3], values: { amount: [8] } }])
  A.receive(ob)
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'same-anchor inserts converged')
  const order = ridsOf(sheet1(A))
  ok(order.includes(1001) && order.includes(2001), 'both rows kept')
  ok(Math.abs(order.indexOf(1001) - order.indexOf(2001)) === 1, `both landed at the anchor: ${order}`)
  ok(order.indexOf(1001) === 3 || order.indexOf(2001) === 3, `first of the two sits at the anchor: ${order}`)
}
{
  console.log('row RGA: insert anchored to a row the peer deleted…')
  const [A, B] = pair()
  // A inserts after rid 3; B deletes rid 3 concurrently. The insert must still
  // land where rid 3 WAS — that is what the anchor chain is for.
  const oa = A.commit([{ op: 'insertRows', sheet: 's1', rids: [1001], at: [3], values: { amount: [7] } }])
  const ob = B.commit([{ op: 'deleteRows', sheet: 's1', rids: [3] }]) // normalize() adds the override sweep
  A.receive(ob)
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'insert-vs-delete-anchor converged')
  const order = ridsOf(sheet1(A))
  ok(!order.includes(3), 'deleted row gone')
  ok(order.indexOf(1001) === 2, `insert kept its place: ${order}`)
}
{
  console.log('delete-wins over a concurrent cell edit…')
  const [A, B] = pair()
  const oa = A.commit([{ op: 'deleteRows', sheet: 's1', rids: [2] }])
  const ob = B.commit([{ op: 'setCells', sheet: 's1', col: 'amount', rids: [2], v: [5555] }])
  A.receive(ob)
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'delete-wins converged')
  ok(!ridsOf(sheet1(A)).includes(2), 'row gone on A')
  ok(!ridsOf(sheet1(B)).includes(2), 'row gone on B')
}
{
  console.log('undo of a row delete resurrects it, and a dead-window edit wins…')
  const [A, B] = pair()
  const del = A.commit([{ op: 'deleteRows', sheet: 's1', rids: [2] }])
  const edit = B.commit([{ op: 'setCells', sheet: 's1', col: 'amount', rids: [2], v: [5555] }])
  B.receive(del)
  const back = A.undo() // resurrect with A's values
  A.receive(edit)
  B.receive(back)
  ok(A.fingerprint() === B.fingerprint(), 'resurrection converged')
  ok(ridsOf(sheet1(A)).includes(2), 'row is back')
  // B's edit carries a higher (lamport, actor) than the resurrection on both
  // sides, so the stash has to replay it — otherwise the two replicas show
  // different numbers for the same cell, which is the whole nightmare.
  ok(cellAt(A, 'amount', 2) === cellAt(B, 'amount', 2), 'one value after resurrection')
}
{
  // Regression for the divergence random seeds 124/307 found, built by hand so
  // it can be read. TWO independent asymmetries lived under the same symptom
  // (identical sync state, workbooks differing by one or two cells) and each
  // one gets its own case, because each one fails on its own.
  console.log('a column re-added by undo out-stamps a value parked in its dead window…')
  // The interleaving, minimal (three replicas because it needs a delete and a
  // write from DIFFERENT actors — per-actor delivery is contiguous, so one
  // actor cannot hand B its write after its own delete):
  //
  //   C  deletes row 2                       [1,C]
  //   A  writes amount:2 = 5555              [1,A]
  //   B  hears the delete, then the write  → the value PARKS (its row is dead)
  //   C  undoes the delete                   [2,C]  (row 2 comes back)
  //   B  removes the amount column           [2,B]
  //   B  undoes that                         [3,B]  ← the column's REBIRTH
  //   B  finally hears C's resurrection      [2,C]
  //
  // A column insert is a whole-column assignment, so [3,B] supersedes the [1,A]
  // write. Every replica that reaches the rebirth through resetColumnValues
  // says so. B reaches it through replayStashRow instead — the row reappears
  // after the column does — and that path used to weigh the parked value only
  // against the ROW's birth, so B alone restored a number nobody else had.
  const A = new Replica('A', 1000)
  const B = new Replica('B', 2000)
  const C = new Replica('C', 3000)
  const cDel = C.commit([{ op: 'deleteRows', sheet: 's1', rids: [2] }])
  const aWrite = A.commit([{ op: 'setCells', sheet: 's1', col: 'amount', rids: [2], v: [5555] }])
  B.receive(cDel)
  B.receive(aWrite) // row 2 is dead here: 5555 parks against [1,A]
  const cBack = C.undo() // row 2 returns, carrying C's own values
  const bDel = B.commit([{ op: 'removeColumn', sheet: 's1', col: 'amount' }])
  const bBack = B.undo() // the column returns at a lamport ABOVE the parked write
  B.receive(cBack)
  for (const ops of [cDel, aWrite, cBack, bDel, bBack]) {
    for (const r of [A, B, C]) r.receive(ops.filter((o) => o.a !== r.actor))
  }
  ok(A.fingerprint() === B.fingerprint(), 'column-rebirth vs parked value converged (A/B)')
  ok(A.fingerprint() === C.fingerprint(), 'column-rebirth vs parked value converged (A/C)')
  ok(sheet1(B).columns.some((c) => c.id === 'amount'), 'the column came back')
  ok(ridsOf(sheet1(B)).includes(2), 'the row came back')
  // The rebirth blanks it. What matters is that ALL THREE say the same thing;
  // the value is asserted too so a future change cannot make them agree on the
  // wrong answer by dropping the column entirely.
  ok(cellAt(B, 'amount', 2) === null, `parked value loses to the column rebirth: ${cellAt(B, 'amount', 2)}`)
  ok(cellAt(A, 'amount', 2) === null && cellAt(C, 'amount', 2) === null, 'and loses on every replica')
}
{
  console.log('undo does not truncate a dictionary a collaborator grew…')
  // The other half of the same symptom, and it needs no dead node at all.
  //
  // `setCells`'s inverse carries `dictLen`, the length the column's dictionary
  // had before the edit, and store.ts honours it with `dict.length = dictLen`.
  // Sound for one writer. Under collab a peer's write interns ITS strings into
  // the same dictionary above that watermark, so the undo drops them and every
  // cell pointing at them reads back null — on the undoing replica only, with
  // not one register, birth or tomb moving. `local()` therefore disarms
  // `dictLen` on the patch before the store sees it.
  const [A, B] = pair()
  const bWrite = B.commit([{ op: 'setCells', sheet: 's1', col: 'region', rids: [1], v: ['LATAM'] }])
  const aWrite = A.commit([{ op: 'setCells', sheet: 's1', col: 'region', rids: [4], v: ['JAPAN'] }])
  B.receive(aWrite) // 'JAPAN' interns ABOVE the watermark B's inverse recorded
  const bUndo = B.undo() // restores region:1, and used to take 'JAPAN' with it
  A.receive(bWrite)
  A.receive(bUndo)
  ok(A.fingerprint() === B.fingerprint(), 'undo-vs-interning converged')
  ok(cellAt(B, 'region', 4) === 'JAPAN', `the collaborator's string survived the undo: ${cellAt(B, 'region', 4)}`)
  ok(cellAt(B, 'region', 1) === 'EMEA', `the undo still restored its own cell: ${cellAt(B, 'region', 1)}`)
}
{
  // Regression for the row-ORDER divergence that random seed 116 found at six
  // actors, built by hand so the interleaving can be read.
  console.log('a row resurrected twice takes the WINNING insert\'s place…')
  //
  // Baseline s1 is rids 1…6 with order keys 8r Hi QZ ZQ iH r8 (spreadKey(i,6)).
  //
  //   C  inserts row 3001 between rid 2 and rid 3       [1,C]  key 'LC'
  //   A  deletes rid 3, having never heard of 3001      [1,A]
  //   B  deletes rid 3, having never heard of 3001      [1,B]
  //   A  undoes  → rins rid 3 at index 2                [2,A]  key 'QA'
  //        A's shadow is 1,2,4,5,6 — no 3001 — so the key is minted against
  //        rid 4, and 'QA' lands AFTER 3001.
  //   B  hears 3001, THEN undoes → rins rid 3 at index 2 [2,B] key 'JB'
  //        B's shadow is 1,2,3001,4,5,6, so the key is minted against 3001 and
  //        lands BEFORE it.
  //
  // [2,B] out-stamps [2,A] on the actor tiebreak, so rid 3 belongs at 'JB',
  // before 3001, on every replica. D hears A's insert first and therefore has
  // the row in the document ALREADY when B's winning insert arrives; E hears
  // B's first and discards A's at the "an older create" gate. Both end holding
  // the same `rpos`, the same births and the same tombs — and, before the fix,
  // two different row sequences, because the already-here branch recorded the
  // new key without moving the row. Worse, D's `rids` was then no longer sorted
  // by (key, rid), so every later insert's binary search landed arbitrarily.
  const A = new Replica('A', 1000)
  const B = new Replica('B', 2000)
  const C = new Replica('C', 3000)
  const D = new Replica('D', 4000)
  const E = new Replica('E', 5000)
  const cIns = C.commit([{ op: 'insertRows', sheet: 's1', rids: [3001], at: [2], values: { amount: [55] } }])
  const aDel = A.commit([{ op: 'deleteRows', sheet: 's1', rids: [3] }])
  const bDel = B.commit([{ op: 'deleteRows', sheet: 's1', rids: [3] }])
  const aIns = A.undo()
  B.receive(cIns)
  const bIns = B.undo()
  // D: the loser's insert first, so the row is already present when the winner
  // arrives. E: the winner's insert first.
  for (const ops of [cIns, aDel, aIns, bDel, bIns]) D.receive(ops)
  for (const ops of [cIns, bDel, bIns, aDel, aIns]) E.receive(ops)
  for (const ops of [cIns, aDel, aIns, bDel, bIns]) for (const r of [A, B, C]) r.receive(ops.filter((o) => o.a !== r.actor))
  const want = [1, 2, 3, 3001, 4, 5, 6].join(',')
  for (const r of [A, B, C, D, E]) {
    ok(ridsOf(sheet1(r)).join(',') === want, `${r.actor} row order: ${ridsOf(sheet1(r))}`)
    checkOrder(r, 'twice-resurrected')
  }
  ok(D.fingerprint() === E.fingerprint(), 'loser-first and winner-first replicas agree')
  ok(A.fingerprint() === D.fingerprint(), 'and so does every other replica')
}
{
  // Regression for the value loss random seeds 374 and 184 found. Same
  // symptom as 307 (identical sync state, one cell different) and a different
  // asymmetry: nothing is deleted twice here except the ROW.
  console.log('a second resurrection that does not name a column keeps its value…')
  //
  //   A  adds column `note`, values n1…n6            [1,A] ins + [2,A] cell
  //   B  hears it
  //   A  deletes rid 2                               [3,A]
  //   A  undoes → rins rid 2, payload NAMES `note`   [4,A]  (note = 'n2')
  //   C  edits its own title three times             [1,C]…[3,C]
  //   C  deletes rid 2 — C has never heard of `note` [4,C]
  //   C  undoes → rins rid 2, payload does NOT name `note` [5,C]  ← wins
  //
  // C's insert wins the birth race, so `rnamed` for the row is rewritten to
  // C's three columns and the record that [4,A] ever claimed `note` is gone.
  // On every replica that processed A's pair first, 'n2' was parked under the
  // [4,A] authority at C's delete; the replay then asked
  // `cellAuth(…, fromRow:false)` for a verdict, got the bare cell register
  // [2,A], failed the stale guard and dropped the value — leaving a blank.
  // C itself never held a parked copy (it discards [4,A] as an older create
  // and gets 'n2' straight from the pended cell op when the column finally
  // lands), so the MINORITY replica was the correct one: an insert that does
  // not name a column makes no claim on it, and nothing superseded the value.
  const A = new Replica('A', 1000)
  const B = new Replica('B', 2000)
  const C = new Replica('C', 3000)
  const D = new Replica('D', 4000)
  const E = new Replica('E', 5000)
  const aCol = A.commit([{ op: 'addColumn', sheet: 's1', column: { id: 'note', name: 'Note', type: 'text' }, data: { enc: 'raw', v: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'] } }])
  B.receive(aCol)
  const aDel = A.commit([{ op: 'deleteRows', sheet: 's1', rids: [2] }])
  const aIns = A.undo()
  const cT: Op[] = []
  for (let i = 0; i < 3; i++) cT.push(...C.commit([{ op: 'setTitle', title: `t${i}` }]))
  const cDel = C.commit([{ op: 'deleteRows', sheet: 's1', rids: [2] }])
  const cIns = C.undo() // [5,C] — out-stamps A's [4,A] resurrection
  // D takes A's pair before C's; E takes C's first. Neither may lose 'n2'.
  for (const ops of [aCol, aDel, aIns, cT, cDel, cIns]) D.receive(ops)
  for (const ops of [cT, cDel, cIns, aCol, aDel, aIns]) E.receive(ops)
  for (const ops of [aCol, aDel, aIns, cT, cDel, cIns]) for (const r of [A, B, C]) r.receive(ops.filter((o) => o.a !== r.actor))
  for (const r of [A, B, C, D, E]) {
    ok(ridsOf(sheet1(r)).includes(2), `${r.actor}: the row is back`)
    ok(cellAt(r, 'note', 2) === 'n2', `${r.actor}: the uncarried column keeps its value: ${cellAt(r, 'note', 2)}`)
  }
  ok(D.fingerprint() === E.fingerprint(), 'both delivery orders agree')
  ok(C.fingerprint() === D.fingerprint(), 'and the second resurrector agrees with them')
}
{
  // Regression for the third asymmetry of the same family, found by random
  // seed 163 at six actors while sweeping the two above.
  console.log('a row insert does not clobber a NEWER value parked for a buried column…')
  //
  //   B  deletes rid 2                                  [1,B]
  //   B  undoes  → rins rid 2, payload names `region`    [2,B]
  //   C  removes the `region` column                     [1,C]
  //   C  undoes  → the column comes back                 [2,C]
  //   A  (hearing none of it) types four titles          [1,A]…[4,A]
  //   A  writes region:2 = '9917'                        [5,A]  ← newest
  //   A  then receives, in this order: B's delete, C's column removal,
  //      B's resurrection, C's column undo.
  //
  // A's write out-stamps everything, so '9917' is the answer on every replica.
  // Every OTHER replica gets there without trying: the write reaches them while
  // the column is buried, `applyCell` parks the op on the column node, and the
  // column's return replays it. A is the author — its write went straight into
  // a live document and was never queued anywhere, so the parked copy made at
  // the row's death is the only record it has. B's resurrection then walked the
  // columns its payload named and overwrote that copy with the payload's own
  // (older) value, and the column's return read a stash entry whose stamp no
  // longer matched the cell's authority and blanked the cell. Five replicas
  // with a number, its author with a blank.
  const A = new Replica('A', 1000)
  const B = new Replica('B', 2000)
  const C = new Replica('C', 3000)
  const D = new Replica('D', 4000)
  const bDel = B.commit([{ op: 'deleteRows', sheet: 's1', rids: [2] }])
  const bIns = B.undo()
  const cDel = C.commit([{ op: 'removeColumn', sheet: 's1', col: 'region' }])
  const cAdd = C.undo()
  const aOps: Op[] = []
  for (let i = 0; i < 4; i++) aOps.push(...A.commit([{ op: 'setTitle', title: `t${i}` }]))
  const aWrite = A.commit([{ op: 'setCells', sheet: 's1', col: 'region', rids: [2], v: ['9917'] }])
  // the order that leaves A holding nothing but the parked copy
  for (const ops of [bDel, cDel, bIns, cAdd]) A.receive(ops)
  for (const ops of [bDel, bIns, cDel, cAdd, aOps, aWrite]) D.receive(ops)
  for (const ops of [bDel, bIns, cDel, cAdd, aOps, aWrite]) for (const r of [A, B, C]) r.receive(ops.filter((o) => o.a !== r.actor))
  for (const r of [A, B, C, D]) {
    ok(sheet1(r).columns.some((c) => c.id === 'region'), `${r.actor}: the column came back`)
    ok(cellAt(r, 'region', 2) === '9917', `${r.actor}: the newest write survived: ${cellAt(r, 'region', 2)}`)
  }
  ok(A.fingerprint() === D.fingerprint(), 'the write\'s author agrees with a replica that only received it')
  ok(B.fingerprint() === C.fingerprint(), 'and the row and column undoers agree too')
}
{
  console.log('column add/remove and reorder converge…')
  const [A, B] = pair()
  const oa = A.commit([{ op: 'addColumn', sheet: 's1', at: 1, column: { id: 'newA', name: 'New A', type: 'number' }, data: { enc: 'raw', v: [1, 2, 3, 4, 5, 6] } }])
  const ob = B.commit([{ op: 'removeColumn', sheet: 's1', col: 'prob' }])
  A.receive(ob)
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'column add/remove converged')
  ok(sheet1(A).columns.some((c) => c.id === 'newA'), 'added column present')
  ok(!sheet1(A).columns.some((c) => c.id === 'prob'), 'removed column gone')
  const oc = A.commit([{ op: 'reorderColumns', sheet: 's1', order: sheet1(A).columns.map((c) => c.id).reverse() }])
  B.receive(oc)
  ok(A.fingerprint() === B.fingerprint(), 'reorder converged')
}
{
  console.log('column data arrives aligned by rid, not by position…')
  const [A, B] = pair()
  // B's row order diverges FIRST, so a positionally-copied column would land
  // its values on the wrong rows — the silent-wrong-number failure.
  const ob = B.commit([{ op: 'insertRows', sheet: 's1', rids: [2001], at: [0], values: { amount: [42] } }])
  const oa = A.commit([{ op: 'addColumn', sheet: 's1', column: { id: 'tag', name: 'Tag', type: 'text' }, data: { enc: 'raw', v: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'] } }])
  A.receive(ob)
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'column-align converged')
  ok(cellAt(B, 'tag', 1) === 'r1' && cellAt(B, 'tag', 6) === 'r6', 'values follow their rids')
  ok(cellAt(B, 'tag', 2001) === null, 'the row A never saw gets a blank, not a shifted value')
}
{
  console.log('sheet delete beats concurrent edits inside it…')
  const [A, B] = pair()
  const oa = A.delSheet('s2')
  const ob = B.commit([{ op: 'setCells', sheet: 's2', col: 'rate', rids: [2], v: [1.11] }])
  A.receive(ob)
  B.receive(oa)
  ok(A.fingerprint() === B.fingerprint(), 'sheet delete converged')
  ok(!A.doc.sheets.some((s) => s.id === 's2'), 'sheet gone on A')
  ok(!B.doc.sheets.some((s) => s.id === 's2'), 'sheet gone on B')
}
{
  console.log('gap buffering + catch-up…')
  const [A, B] = pair()
  const b1 = A.commit([{ op: 'setTitle', title: 'one' }])
  const b2 = A.commit([{ op: 'setTitle', title: 'two' }])
  const b3 = A.commit([{ op: 'setTitle', title: 'three' }])
  B.receive(b3)
  ok(B.doc.title === 'Rig workbook', 'gapped op held back')
  ok(B.state.gappedActors.includes('A'), 'gap detected for catch-up')
  B.receive(b1)
  ok(B.doc.title === 'one', 'first op applied, gap persists')
  B.receive(b2)
  ok(B.doc.title === 'three', 'gap drained in order')
  ok(A.fingerprint() === B.fingerprint(), 'gap run converged')
}
{
  console.log('op-log catch-up (missingFor)…')
  const [A, B] = pair()
  const first = A.commit([{ op: 'setTitle', title: 'x1' }])
  A.commit([{ op: 'setCells', sheet: 's1', col: 'amount', rids: [1], v: [17] }])
  A.commit([{ op: 'insertRows', sheet: 's1', rids: [1005], at: [1], values: { amount: [3] } }])
  B.receive(first)
  const missing = B.state.missingFor(A.log, B.state.toJSON().vv)
  B.receive(missing)
  ok(A.fingerprint() === B.fingerprint(), 'log catch-up converged')
}
{
  console.log('snapshot merge: two offline forks, both ways…')
  const [A, B] = pair()
  A.commit([{ op: 'setTitle', title: 'A says' }])
  A.commit([{ op: 'setCells', sheet: 's1', col: 'amount', rids: [1], v: [10] }])
  A.commit([{ op: 'insertRows', sheet: 's1', rids: [1001], at: [2], values: { amount: [77] } }])
  B.commit([{ op: 'setCells', sheet: 's1', col: 'prob', rids: [5], v: [0.05] }])
  B.commit([{ op: 'deleteRows', sheet: 's1', rids: [6] }])
  B.commit([{ op: 'addColumn', sheet: 's1', column: { id: 'owner', name: 'Owner', type: 'text' }, data: { enc: 'raw', v: ['a', 'b', 'c', 'd', 'e'] } }])
  const aDoc = clone(A.doc)
  const aState = clone(A.state.toJSON())
  const bDoc = clone(B.doc)
  const bState = clone(B.state.toJSON())
  A.state.mergeSnapshot(A.doc, bDoc, bState)
  B.state.mergeSnapshot(B.doc, aDoc, aState)
  ok(A.fingerprint() === B.fingerprint(), 'fork merge converged')
  ok(A.doc.title === 'A says', 'A title survived')
  ok(!ridsOf(sheet1(A)).includes(6), 'B delete survived')
  ok(ridsOf(sheet1(A)).includes(1001), 'A insert survived')
  ok(sheet1(A).columns.some((c) => c.id === 'owner'), 'B column survived')
  ok(cellAt(A, 'amount', 1) === 10 && cellAt(A, 'prob', 5) === 0.05, 'both cell edits survived')
  // a pristine third copy catches up from one snapshot alone
  const C = new Replica('C', 3000)
  C.state.mergeSnapshot(C.doc, clone(A.doc), clone(A.state.toJSON()))
  ok(C.fingerprint() === A.fingerprint(), 'late joiner converged from a snapshot')
}
{
  console.log('unsupported patches raise the snapshot flag rather than vanishing…')
  const A = new Replica('A', 1000)
  const ops = A.state.local(A.doc, [{ op: 'applySteps', sheet: 's1', steps: [] }] as unknown as Patch[])
  ok(ops.length === 0 && A.state.unsynced, 'unmapped patch flagged for a state snapshot')
}
{
  console.log('a foreign sync-state version is discarded, not misread…')
  const A = new Replica('A', 1000)
  const before = A.fingerprint()
  const r = A.state.mergeSnapshot(A.doc, baseDoc(), { v: 99 } as never)
  ok(!r.changed && A.fingerprint() === before, 'future-version snapshot ignored')
  const s = DashSync.fromJSON('A', { v: 99, lamport: 5 } as never)
  ok(s.lamport === 0, 'future-version state ignored by fromJSON')
}
{
  console.log('row node ids stay composite (sheet-scoped rids)…')
  ok(rowNode('s1', 7) !== rowNode('s2', 7), 'the same rid on two sheets is two nodes')
}

console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILURES of ${checks} checks`)
process.exit(failures ? 1 : 0)
