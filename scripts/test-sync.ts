#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento-sync M0 convergence rig.
//
//   node scripts/test-sync.ts        (Node ≥ 23.6 strips types natively)
//
// Property-based: N simulated actors mutate their own replica through the
// same differ the editor uses, ops travel through per-(from,to) FIFO queues
// delivered in random interleavings, and at quiescence every replica's
// materialized document AND sync state must be identical. Plus targeted
// cases: delete-wins, undo-resurrection, move-vs-delete, RGA text merge,
// gap buffering, snapshot merge (file forks), and same-element-id on many
// slides (the morph idiom — baseDoc carries a duplicated 'cast' id so every
// random run exercises composite element identity).

import { SyncState, keyBetween, spreadKey, tokenize, materialize } from '../slides/src/sync/crdt.ts'
import type { Op } from '../slides/src/sync/crdt.ts'
// Generator + fixtures are SHARED with scripts/test-sync-equiv.ts (the
// byte-equivalence rig) — one opinion about what a document and an edit are.
import { mulberry32, stable, baseDoc, randomMutation } from './lib/sync-fixtures.ts'
import type { Doc } from './lib/sync-fixtures.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) {
    failures++
    console.error(`  ✗ ${msg}`)
  }
}

// ---------------------------------------------------------------------------
// keyBetween / spreadKey / tokenize unit properties
// ---------------------------------------------------------------------------
{
  console.log('keyBetween properties…')
  const rnd = mulberry32(1)
  const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const randKey = () => {
    let k = ''
    const n = 1 + Math.floor(rnd() * 6)
    for (let i = 0; i < n; i++) k += DIGITS[Math.floor(rnd() * 62)]
    while (k.endsWith('0') && k.length > 1) k = k.slice(0, -1)
    return k === '0' ? '1' : k
  }
  for (let i = 0; i < 20000; i++) {
    let a = randKey()
    let b = randKey()
    if (a === b) continue
    if (a > b) [a, b] = [b, a]
    const m = keyBetween(a, b)
    ok(a < m && m < b, `between(${a},${b}) = ${m} out of range`)
    ok(!m.endsWith('0'), `between(${a},${b}) = ${m} ends in 0`)
  }
  for (let i = 0; i < 2000; i++) {
    const a = randKey()
    const lo = keyBetween('', a)
    const hi = keyBetween(a, '')
    ok(lo < a, `before(${a}) = ${lo} not lower`)
    ok(hi > a, `after(${a}) = ${hi} not higher`)
  }
  // chains: repeated prepend/append stay ordered and reasonably short
  let k = keyBetween('', '')
  let prev = k
  for (let i = 0; i < 200; i++) {
    const n = keyBetween(prev, '')
    ok(n > prev, `append chain broke at ${i}`)
    prev = n
  }
  ok(prev.length < 60, `append chain key grew to ${prev.length} chars`)
  prev = k
  for (let i = 0; i < 200; i++) {
    const n = keyBetween('', prev)
    ok(n < prev, `prepend chain broke at ${i}`)
    prev = n
  }
  for (let n = 1; n <= 40; n++) {
    for (let i = 0; i + 1 < n; i++) {
      ok(spreadKey(i, n) < spreadKey(i + 1, n), `spreadKey(${i},${n}) not increasing`)
    }
  }
  const t = tokenize('a<b>x&amp;y</b> ok')
  ok(t.join('|') === 'a|<b>|x|&amp;|y|</b>| |o|k', `tokenize: ${t.join('|')}`)
  ok(t.join('') === 'a<b>x&amp;y</b> ok', 'tokenize round-trip')
}

// ---------------------------------------------------------------------------
// simulated replicas
// ---------------------------------------------------------------------------

class Replica {
  doc: Doc
  state: SyncState
  shadow: string
  log: Op[] = []
  undoStack: string[] = []
  counter = 0
  actor: string
  constructor(actor: string) {
    this.actor = actor
    this.doc = baseDoc()
    this.state = new SyncState(actor)
    this.state.adopt(this.doc)
    this.shadow = JSON.stringify(this.doc)
  }
  /** run an editor-like mutation, diff, return the minted ops */
  mutate(fn: (doc: Doc) => void): Op[] {
    this.undoStack.push(this.shadow)
    fn(this.doc)
    return this.flush()
  }
  undo(): Op[] {
    const prev = this.undoStack.pop()
    if (!prev) return []
    this.doc = JSON.parse(prev)
    return this.flush()
  }
  flush(): Op[] {
    const ops = this.state.diff(JSON.parse(this.shadow), this.doc, { text: true })
    this.shadow = JSON.stringify(this.doc)
    this.log.push(...ops)
    return ops
  }
  receive(ops: Op[]) {
    this.state.apply(this.doc, ops)
    this.log.push(...ops)
    this.shadow = JSON.stringify(this.doc)
  }
  fingerprint(): string {
    const d = JSON.parse(JSON.stringify(this.doc))
    delete d.modified
    return stable(d)
  }
  stateFingerprint(): string {
    const j = this.state.toJSON() as any
    // txt of DEAD nodes is invisible and intentionally asymmetric (kept on
    // one side, buffered as pending ops on the other) — excluded here
    const txt = Object.fromEntries(Object.entries(j.txt).filter(([id]) => !this.state.dead(id)))
    return stable({ regs: j.regs, pos: j.pos, births: j.births, tombs: j.tombs, txt, vv: j.vv })
  }
}

// ---------------------------------------------------------------------------
// random convergence runs
// ---------------------------------------------------------------------------
{
  console.log('random convergence runs…')
  const SEEDS = parseInt(process.env.SEEDS ?? '40', 10)
  const SEED_ONLY = process.env.SEED_ONLY ? parseInt(process.env.SEED_ONLY, 10) : 0
  if (process.env.DBG_EL) (globalThis as any).__dbgEl = process.env.DBG_EL
  const STEPS = parseInt(process.env.STEPS ?? '140', 10)
  const ACTORS = parseInt(process.env.ACTORS ?? '3', 10)
  for (let seed = SEED_ONLY || 1; seed <= (SEED_ONLY || SEEDS); seed++) {
    const rnd = mulberry32(seed * 7919)
    const N = ACTORS
    const reps = Array.from({ length: N }, (_, i) => new Replica(`a${i}`))
    // per-(from,to) FIFO queues of op batches
    const queues = new Map<string, Op[][]>()
    const qk = (f: number, t: number) => `${f}>${t}`
    for (let f = 0; f < N; f++) for (let t = 0; t < N; t++) if (f !== t) queues.set(qk(f, t), [])

    for (let s = 0; s < STEPS; s++) {
      const dice = rnd()
      if (dice < 0.45) {
        const i = Math.floor(rnd() * N)
        const r = reps[i]
        ;(globalThis as any).__dbgTag = `mut@${r.actor}`
        const ops = rnd() < 0.06 ? r.undo() : r.mutate(randomMutation(r, rnd))
        if (ops.length) for (let t = 0; t < N; t++) if (t !== i) queues.get(qk(i, t))!.push(ops)
      } else {
        // deliver one pending batch on a random edge
        const edges = [...queues.entries()].filter(([, q]) => q.length)
        if (!edges.length) continue
        const [key, q] = edges[Math.floor(rnd() * edges.length)]
        const to = parseInt(key.split('>')[1], 10)
        ;(globalThis as any).__dbgTag = `recv@${reps[to].actor}`
        reps[to].receive(q.shift()!)
      }
    }
    // drain
    let moved = true
    while (moved) {
      moved = false
      for (const [key, q] of queues) {
        if (!q.length) continue
        moved = true
        const to = parseInt(key.split('>')[1], 10)
        ;(globalThis as any).__dbgTag = `drain@${reps[to].actor}`
        reps[to].receive(q.shift()!)
      }
    }
    const fp0 = reps[0].fingerprint()
    const st0 = reps[0].stateFingerprint()
    let bad = false
    for (let i = 1; i < N; i++) {
      ok(reps[i].fingerprint() === fp0, `seed ${seed}: doc diverged (replica ${i})`)
      ok(reps[i].stateFingerprint() === st0, `seed ${seed}: state diverged (replica ${i})`)
      if (reps[i].fingerprint() !== fp0 || reps[i].stateFingerprint() !== st0) bad = true
    }
    if (bad) {
      // componentwise blame
      for (const part of ['regs', 'pos', 'births', 'tombs', 'txt', 'vv'] as const) {
        const p0 = stable((reps[0].state.toJSON() as any)[part])
        for (let i = 1; i < N; i++) {
          const pi = stable((reps[i].state.toJSON() as any)[part])
          if (pi !== p0) {
            let d = 0
            while (d < p0.length && p0[d] === pi[d]) d++
            console.error(`    seed ${seed} ${part} differs @${d}:\n      r0: …${p0.slice(Math.max(0, d - 60), d + 120)}\n      r${i}: …${pi.slice(Math.max(0, d - 60), d + 120)}`)
          }
        }
      }
      for (let i = 1; i < N; i++) {
        const fi = reps[i].fingerprint()
        if (fi === fp0) continue
        let d = 0
        while (d < fp0.length && fp0[d] === fi[d]) d++
        console.error(`    seed ${seed} doc differs @${d}:\n      r0: …${fp0.slice(Math.max(0, d - 80), d + 160)}\n      r${i}: …${fi.slice(Math.max(0, d - 80), d + 160)}`)
      }
      break
    }
  }
}

// ---------------------------------------------------------------------------
// targeted semantics
// ---------------------------------------------------------------------------
{
  console.log('delete-wins vs concurrent edit…')
  const A = new Replica('A')
  const B = new Replica('B')
  const opsA = A.mutate((d) => d.slides.splice(1, 1)) // A deletes s2
  const opsB = B.mutate((d) => {
    d.slides[1].elements[0].html = 'edited concurrently'
  })
  A.receive(opsB)
  B.receive(opsA)
  ok(A.fingerprint() === B.fingerprint(), 'delete-wins converged')
  ok(!A.doc.slides.some((s: any) => s.id === 's2'), 'slide gone on A')
  ok(!B.doc.slides.some((s: any) => s.id === 's2'), 'slide gone on B')
}
{
  console.log('undo resurrects a deleted slide…')
  const A = new Replica('A')
  const B = new Replica('B')
  const del = A.mutate((d) => d.slides.splice(1, 1))
  B.receive(del)
  ok(!B.doc.slides.some((s: any) => s.id === 's2'), 'B saw the delete')
  const res = A.undo()
  ok(res.length > 0, 'undo produced ops')
  B.receive(res)
  ok(B.doc.slides.some((s: any) => s.id === 's2'), 'B saw the resurrection')
  ok(A.fingerprint() === B.fingerprint(), 'resurrection converged')
  ok(B.doc.slides.find((s: any) => s.id === 's2').elements.length === 2, 'slide content restored')
}
{
  console.log('move-out vs slide-delete cascade…')
  const A = new Replica('A')
  const B = new Replica('B')
  // A moves s1-r1 to s3; B deletes s1 (saw r1 inside → cascades it)
  const mv = A.mutate((d) => {
    const s1 = d.slides.find((s: any) => s.id === 's1')
    const s3 = d.slides.find((s: any) => s.id === 's3')
    const i = s1.elements.findIndex((e: any) => e.id === 's1-r1')
    const [el] = s1.elements.splice(i, 1)
    s3.elements.push(el)
  })
  const del = B.mutate((d) => d.slides.splice(0, 1))
  A.receive(del)
  B.receive(mv)
  ok(A.fingerprint() === B.fingerprint(), 'move-vs-delete converged')
}
{
  console.log('concurrent inserts keep both…')
  const A = new Replica('A')
  const B = new Replica('B')
  const ia = A.mutate((d) => d.slides[0].elements.push({ id: 'A-new', type: 'shape', shape: 'rect', x: 1, y: 1, w: 10, h: 10, rotation: 0, opacity: 1, fill: '#111', stroke: 'none', strokeWidth: 0, radius: 0 }))
  const ib = B.mutate((d) => d.slides[0].elements.push({ id: 'B-new', type: 'shape', shape: 'rect', x: 2, y: 2, w: 10, h: 10, rotation: 0, opacity: 1, fill: '#222', stroke: 'none', strokeWidth: 0, radius: 0 }))
  A.receive(ib)
  B.receive(ia)
  ok(A.fingerprint() === B.fingerprint(), 'concurrent inserts converged')
  const ids = A.doc.slides[0].elements.map((e: any) => e.id)
  ok(ids.includes('A-new') && ids.includes('B-new'), 'both inserts present')
}
{
  console.log('RGA: concurrent text edits merge…')
  const A = new Replica('A')
  const B = new Replica('B')
  const ea = A.mutate((d) => {
    const el = d.slides[0].elements[0]
    el.html = 'START ' + el.html // prepend
  })
  const eb = B.mutate((d) => {
    const el = d.slides[0].elements[0]
    el.html = el.html + ' END' // append
  })
  A.receive(eb)
  B.receive(ea)
  ok(A.fingerprint() === B.fingerprint(), 'text merge converged')
  const html = A.doc.slides[0].elements[0].html
  ok(html.startsWith('START ') && html.endsWith(' END') && html.includes('<b>world</b>'), `merged text kept both edits: "${html}"`)
}
{
  console.log('RGA: same-position concurrent inserts stay whole…')
  const A = new Replica('A')
  const B = new Replica('B')
  const ea = A.mutate((d) => (d.slides[0].elements[0].html = 'Hello ABC <b>world</b>'))
  const eb = B.mutate((d) => (d.slides[0].elements[0].html = 'Hello XYZ <b>world</b>'))
  A.receive(eb)
  B.receive(ea)
  ok(A.fingerprint() === B.fingerprint(), 'same-position insert converged')
  const html = A.doc.slides[0].elements[0].html as string
  ok(html.includes('ABC') && html.includes('XYZ'), `both runs present: "${html}"`)
  ok(/ABC/.test(html) && !/A.*B.*C/.test(html.replace(/ABC/, '')), `runs not interleaved: "${html}"`)
}
{
  console.log('gap buffering + catch-up…')
  const A = new Replica('A')
  const B = new Replica('B')
  const b1 = A.mutate((d) => (d.title = 'one'))
  const b2 = A.mutate((d) => (d.title = 'two'))
  const b3 = A.mutate((d) => (d.title = 'three'))
  B.receive(b3) // arrives first — must buffer
  ok(B.doc.title === 'Rig deck', 'gapped op held back')
  ok(B.state.gappedActors.includes('A'), 'gap detected for catch-up')
  B.receive(b1)
  ok(B.doc.title === 'one', 'first op applied, gap persists')
  B.receive(b2) // fills the gap → drains b3
  ok(B.doc.title === 'three', 'gap drained in order')
  ok(A.fingerprint() === B.fingerprint(), 'gap run converged')
}
{
  console.log('snapshot merge (file fork / late joiner)…')
  const A = new Replica('A')
  const B = new Replica('B')
  A.mutate((d) => (d.title = 'A says'))
  A.mutate((d) => d.slides[0].elements.push({ id: 'A-x', type: 'shape', shape: 'rect', x: 5, y: 5, w: 10, h: 10, rotation: 0, opacity: 1, fill: '#333', stroke: 'none', strokeWidth: 0, radius: 0 }))
  B.mutate((d) => (d.slides[2].background = '#654321'))
  B.mutate((d) => d.slides.splice(1, 1)) // B deletes s2
  // exchange snapshots both ways (no op log)
  const aDoc = JSON.parse(JSON.stringify(A.doc))
  const aState = JSON.parse(JSON.stringify(A.state.toJSON()))
  const bDoc = JSON.parse(JSON.stringify(B.doc))
  const bState = JSON.parse(JSON.stringify(B.state.toJSON()))
  A.state.mergeSnapshot(A.doc, bDoc, bState)
  A.shadow = JSON.stringify(A.doc)
  B.state.mergeSnapshot(B.doc, aDoc, aState)
  B.shadow = JSON.stringify(B.doc)
  ok(A.fingerprint() === B.fingerprint(), 'snapshot fork merge converged')
  ok(A.doc.title === 'A says', 'A title survived')
  ok(!A.doc.slides.some((s: any) => s.id === 's2'), 'B delete survived')
  ok(A.doc.slides[0].elements.some((e: any) => e.id === 'A-x'), 'A insert survived')
  // late joiner from pristine file
  const C = new Replica('C')
  C.state.mergeSnapshot(C.doc, JSON.parse(JSON.stringify(A.doc)), A.state.toJSON())
  C.shadow = JSON.stringify(C.doc)
  ok(C.fingerprint() === A.fingerprint(), 'late joiner converged from snapshot')
}
{
  console.log('op-log catch-up (missingFor)…')
  const A = new Replica('A')
  const B = new Replica('B')
  const batches = [
    A.mutate((d) => (d.title = 'x1')),
    A.mutate((d) => (d.slides[0].background = '#222222')),
    A.mutate((d) => d.slides[0].elements.push({ id: 'A-q', type: 'shape', shape: 'rect', x: 9, y: 9, w: 10, h: 10, rotation: 0, opacity: 1, fill: '#444', stroke: 'none', strokeWidth: 0, radius: 0 })),
  ]
  B.receive(batches[0])
  const missing = B.state.missingFor(A.log, B.state.toJSON().vv)
  ok(missing.length === batches[1].length + batches[2].length, `missingFor found ${missing.length} ops`)
  B.receive(missing)
  ok(A.fingerprint() === B.fingerprint(), 'log catch-up converged')
}

// ---------------------------------------------------------------------------
// duplicated element ids across slides (the morph idiom) — regression for
// the v1 bare-id identity collapse that dropped one copy per replica
// ---------------------------------------------------------------------------
const castCount = (d: Doc) =>
  d.slides.filter((s: any) => s.elements.some((e: any) => e.id === 'cast')).length
{
  console.log('dup id across slides: adopt + structural op keeps every copy…')
  // the launch-blocker repro: both replicas adopt the same file with 'cast'
  // on s1 AND s2; any structural op must not evict either copy anywhere
  const A = new Replica('A')
  const B = new Replica('B')
  const ops = A.mutate((d) =>
    d.slides[0].elements.push({ id: 'A-extra', type: 'shape', shape: 'rect', x: 3, y: 3, w: 10, h: 10, rotation: 0, opacity: 1, fill: '#123', stroke: 'none', strokeWidth: 0, radius: 0 }),
  )
  B.receive(ops)
  ok(A.fingerprint() === B.fingerprint(), 'adopt-dup structural op converged')
  ok(castCount(A.doc) === 2, `A keeps cast on both slides (${castCount(A.doc)})`)
  ok(castCount(B.doc) === 2, `B keeps cast on both slides (${castCount(B.doc)})`)
}
{
  console.log('dup id: concurrent edits land on the right copy…')
  const A = new Replica('A')
  const B = new Replica('B')
  const castOn = (d: Doc, sid: string) =>
    d.slides.find((s: any) => s.id === sid).elements.find((e: any) => e.id === 'cast')
  const ea = A.mutate((d) => (castOn(d, 's1').x = 111))
  const eb = B.mutate((d) => (castOn(d, 's2').x = 222))
  A.receive(eb)
  B.receive(ea)
  ok(A.fingerprint() === B.fingerprint(), 'per-copy edits converged')
  ok(castOn(A.doc, 's1').x === 111 && castOn(A.doc, 's2').x === 222, 'each copy took its own edit on A')
  ok(castOn(B.doc, 's1').x === 111 && castOn(B.doc, 's2').x === 222, 'each copy took its own edit on B')
}
{
  console.log('dup id: concurrent RGA text edits stay per-copy…')
  const A = new Replica('A')
  const B = new Replica('B')
  const castOn = (d: Doc, sid: string) =>
    d.slides.find((s: any) => s.id === sid).elements.find((e: any) => e.id === 'cast')
  const ea = A.mutate((d) => (castOn(d, 's1').html = 'ONE ' + castOn(d, 's1').html))
  const eb = B.mutate((d) => (castOn(d, 's2').html = castOn(d, 's2').html + ' TWO'))
  A.receive(eb)
  B.receive(ea)
  ok(A.fingerprint() === B.fingerprint(), 'per-copy text edits converged')
  ok(castOn(A.doc, 's1').html === 'ONE Morph <b>me</b>', `s1 copy text: "${castOn(A.doc, 's1').html}"`)
  ok(castOn(A.doc, 's2').html === 'Morph <b>me</b> TWO', `s2 copy text: "${castOn(A.doc, 's2').html}"`)
}
{
  console.log('dup id: created by diff (paste-with-same-id) replicates…')
  const A = new Replica('A')
  const B = new Replica('B')
  const mk = () => ({ id: 'dup-x', type: 'shape', shape: 'rect', x: 7, y: 7, w: 20, h: 20, rotation: 0, opacity: 1, fill: '#777', stroke: 'none', strokeWidth: 0, radius: 0 })
  const o1 = A.mutate((d) => d.slides[0].elements.push(mk()))
  const o2 = A.mutate((d) => d.slides[1].elements.push({ ...mk(), x: 77 }))
  B.receive(o1)
  B.receive(o2)
  ok(A.fingerprint() === B.fingerprint(), 'diff-created dup converged')
  const on = (d: Doc, sid: string) =>
    d.slides.find((s: any) => s.id === sid).elements.find((e: any) => e.id === 'dup-x')
  ok(on(B.doc, 's1')?.x === 7 && on(B.doc, 's2')?.x === 77, 'both copies present on B with their own props')
}
{
  console.log('dup id: delete one copy, edit the other concurrently…')
  const A = new Replica('A')
  const B = new Replica('B')
  const del = A.mutate((d) => {
    const s1 = d.slides.find((s: any) => s.id === 's1')
    s1.elements = s1.elements.filter((e: any) => e.id !== 'cast')
  })
  const edit = B.mutate((d) => {
    const c = d.slides.find((s: any) => s.id === 's2').elements.find((e: any) => e.id === 'cast')
    c.fill = undefined
    c.x = 999
  })
  A.receive(edit)
  B.receive(del)
  ok(A.fingerprint() === B.fingerprint(), 'delete-one-copy converged')
  ok(!A.doc.slides.find((s: any) => s.id === 's1').elements.some((e: any) => e.id === 'cast'), 's1 copy gone')
  ok(A.doc.slides.find((s: any) => s.id === 's2').elements.find((e: any) => e.id === 'cast').x === 999, 's2 copy edited')
}
{
  console.log('dup id: concurrent moves onto one slide converge…')
  // A moves s1's cast → s3 while B moves s2's cast → s3: both replicas must
  // agree (the two copies collapse to one under the within-slide id
  // invariant — documented degradation, never divergence)
  const A = new Replica('A')
  const B = new Replica('B')
  const mv = (d: Doc, from: string) => {
    const f = d.slides.find((s: any) => s.id === from)
    const s3 = d.slides.find((s: any) => s.id === 's3')
    const i = f.elements.findIndex((e: any) => e.id === 'cast')
    const [el] = f.elements.splice(i, 1)
    s3.elements.push(el)
  }
  const ma = A.mutate((d) => mv(d, 's1'))
  const mb = B.mutate((d) => mv(d, 's2'))
  A.receive(mb)
  B.receive(ma)
  ok(A.fingerprint() === B.fingerprint(), 'colliding moves converged')
  ok(
    A.doc.slides.find((s: any) => s.id === 's3').elements.filter((e: any) => e.id === 'cast').length === 1,
    'exactly one cast on s3 after collision',
  )
}
{
  console.log('dup id: snapshot fork merge keeps both copies…')
  const A = new Replica('A')
  const B = new Replica('B')
  A.mutate((d) => (d.slides.find((s: any) => s.id === 's1').elements.find((e: any) => e.id === 'cast').y = 41))
  B.mutate((d) => (d.slides.find((s: any) => s.id === 's2').elements.find((e: any) => e.id === 'cast').y = 42))
  const aDoc = JSON.parse(JSON.stringify(A.doc))
  const aState = JSON.parse(JSON.stringify(A.state.toJSON()))
  const bDoc = JSON.parse(JSON.stringify(B.doc))
  const bState = JSON.parse(JSON.stringify(B.state.toJSON()))
  A.state.mergeSnapshot(A.doc, bDoc, bState)
  A.shadow = JSON.stringify(A.doc)
  B.state.mergeSnapshot(B.doc, aDoc, aState)
  B.shadow = JSON.stringify(B.doc)
  ok(A.fingerprint() === B.fingerprint(), 'dup-id fork merge converged')
  ok(castCount(A.doc) === 2, 'both copies survive the fork merge')
  const y = (sid: string) =>
    A.doc.slides.find((s: any) => s.id === sid).elements.find((e: any) => e.id === 'cast').y
  ok(y('s1') === 41 && y('s2') === 42, 'fork edits landed on their own copies')
}

{
  // LARGE TEXT. The rig only ever generated short strings, which is how a
  // stack overflow in applyTxtToState survived 46k checks: tokenize() is
  // per-character, so ~200KB of text is ~200k tokens, and inserting them with
  // splice(idx, 0, ...toks) spread them as CALL ARGUMENTS and blew the stack.
  // The throw happened inside diff(), so session.flush() failed and NOTHING
  // synced for the rest of the session. Guard the whole class here.
  console.log('large text: 300KB element diffs, merges and converges…')
  const A = new Replica('A')
  const B = new Replica('B')
  const big = 'word '.repeat(60_000) // ~300KB
  const ea = A.mutate((d) => { d.slides[0].elements[0].html = big + ' AAA' })
  const eb = B.mutate((d) => { d.slides[0].elements[0].html = d.slides[0].elements[0].html + ' BBB' })
  A.receive(eb)
  B.receive(ea)
  ok(A.fingerprint() === B.fingerprint(), 'large-text merge converged')
  const html = A.doc.slides[0].elements[0].html
  ok(html.includes('AAA') && html.includes('BBB'), 'large-text merge kept both edits')
  ok(html.length > 200_000, `large text survived the merge (${html.length} chars)`)
}
{
  // DIFF FAILURE RECOVERY. A differ bug must not wedge the session: the shadow
  // only advances after a successful diff, so an uncaught throw re-diffs the
  // same delta forever. session.ts recovers by advancing the shadow and
  // shipping a snapshot — but those discarded ops CONSUMED sequence numbers,
  // leaving a permanent hole that stalls peers on the gap buffer. This asserts
  // the snapshot actually clears that stall.
  console.log('diff failure: seq gap from discarded ops recovers via snapshot…')
  const A = new Replica('A')
  const B = new Replica('B')
  B.receive(A.mutate((d) => { d.title = 't1' }))
  // ops A mints then DISCARDS, exactly as a mid-diff throw would: seqs spent,
  // ops never broadcast
  A.mutate((d) => { d.title = 't2' })
  A.mutate((d) => { d.title = 't3' })
  const later = A.mutate((d) => { d.title = 't4' })
  B.receive(later)
  ok(B.doc.title === 't1', 'peer stalls on the sequence gap (as designed)')
  // the recovery session.ts performs
  B.state.mergeSnapshot(B.doc, JSON.parse(JSON.stringify(A.doc)), JSON.parse(JSON.stringify(A.state.toJSON())))
  ok(B.doc.title === 't4', 'snapshot cleared the gap and caught the peer up')
  ok(A.fingerprint() === B.fingerprint(), 'diff-failure recovery converged')
}
{
  console.log('pre-v2 saved state and snapshots are discarded…')
  const A = new Replica('A')
  const legacy = { lamport: 9, vv: { Z: 4 }, regs: { 'cast x': [9, 'Z'] }, pos: {}, births: {}, tombs: {}, txt: {}, stash: {}, limbo: {} }
  const s = SyncState.fromJSON('A', legacy as any)
  ok(s.lamport === 0 && Object.keys(s.regs).length === 0, 'v1 state ignored by fromJSON')
  const before = A.fingerprint()
  const r = A.state.mergeSnapshot(A.doc, baseDoc(), legacy as any)
  ok(!r.changed && A.fingerprint() === before, 'v1 snapshot ignored by mergeSnapshot')
}

console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILURES of ${checks} checks`)
process.exit(failures ? 1 : 0)
