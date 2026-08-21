#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A FLAT document shape — one level deep, no element layer.
//
//   node scripts/test-sync-flat.ts
//
// WHAT THIS PROVES. bento/slides and bento/spaces are both two levels deep: a
// slide holds elements, a page holds blocks. The engine assumed that depth —
// `children` was required, and the child accessor called `.length/.forEach/
// .push/.splice` on whatever key it named. bento/type is one level: `body` is
// an array of blocks and a block IS the paragraph, so there is nothing beneath
// it and no honest key to point `children` at.
//
// This rig binds type's ACTUAL shape — `shape('body', null, 'text')` — and
// checks the two things a flat binding has to get right:
//
//   1. text still merges token-by-token, because the text is on the parent
//      (scripts/test-sync-parent-text.ts isolates that variable with children
//      still present; here they are genuinely absent);
//   2. the document keeps its shape. An engine that quietly wrote an empty
//      `elements: []` onto every block would still converge, and would still
//      pass every convergence check, while corrupting the format — so the
//      structural assertion is made directly.
//
// It also covers the receiving side: an element-scoped op has nowhere to land
// in a flat document, and must be dropped rather than throw or invent a key.

import { SyncEngine, shape } from '../slides/src/sync/crdt.ts'
import type { DocShape, Op } from '../slides/src/sync/crdt.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const H = (s: string) => console.log(`\n=== ${s} ===`)

console.log('bento-sync — a flat document shape\n')

/** bento/type: a document is a list of blocks, and a block carries its text. */
const TYPE_SHAPE: DocShape = shape('body', null, 'text')
class TypeSync extends SyncEngine {
  constructor(actor: string) { super(actor, TYPE_SHAPE) }
}

type Block = { id: string; kind: string; text: string }
type Doc = { body: Block[] }
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

const mk = (): Doc => ({
  format: 'bento/type', version: 1, docId: 'd', title: 'Master Services Agreement',
  body: [
    { id: 'p1', kind: 'para', text: 'The parties agree as follows.' },
    { id: 'p2', kind: 'para', text: 'Payment is due within 30 days.' },
  ],
} as unknown as Doc)

/** two replicas of the same document, each having adopted it independently */
function pair() {
  const A = new TypeSync('alice')
  const B = new TypeSync('bob')
  const dA = mk()
  A.adopt(dA as never)
  const dB = clone(dA)
  B.adopt(dB as never)
  return { A, B, dA, dB }
}

H('the shape binds at all')
{
  ok(TYPE_SHAPE.children === null, 'children is null — a flat document declares no element layer')
  ok(TYPE_SHAPE.parents === 'body' && TYPE_SHAPE.text === 'text',
    'blocks live in body, and their text is the collaboratively-merged property')
  ok(TYPE_SHAPE.skipDoc.has('body'),
    'the container is skipped as a doc property — syncing it as a value would make the whole document one register')
  const { dA } = pair()
  ok(Array.isArray(dA.body) && dA.body.length === 2, 'a flat document adopts without throwing')
}

H('two authors typing in the same paragraph both survive')
{
  const { A, B, dA, dB } = pair()
  const beforeA = clone(dA)
  dA.body[1].text = 'Payment is due within sixty (60) days.'
  const opsA = A.diff(beforeA as never, dA as never, { text: true })

  const beforeB = clone(dB)
  dB.body[1].text = 'Payment is due within 30 days of invoice.'
  const opsB = B.diff(beforeB as never, dB as never, { text: true })

  ok(opsA.length === 1 && opsA[0].op === 'txt',
    `a paragraph edit is one token delta (got ${opsA.map(o => o.op).join(',') || 'nothing'})`)
  ok(String(opsA[0].el) === 'p2', `keyed by the block id itself (got ${JSON.stringify(String(opsA[0].el))})`)

  A.apply(dA as never, opsB)
  B.apply(dB as never, opsA)
  ok(JSON.stringify(dA) === JSON.stringify(dB), 'the replicas converge')
  const merged = dA.body[1].text
  console.log(`      merged: ${JSON.stringify(merged)}`)
  ok(merged.includes('sixty (60)'), "the payment term one author changed survives")
  ok(merged.includes('of invoice'), "and so does the clause the other appended")
}

H('the document keeps its shape')
{
  // The failure this catches converges perfectly and still corrupts the file.
  const { A, B, dA, dB } = pair()
  const beforeA = clone(dA)
  dA.body[0].text = 'The parties hereby agree as follows.'
  const opsA = A.diff(beforeA as never, dA as never, { text: true })
  B.apply(dB as never, opsA)

  const keys = new Set(dB.body.flatMap(b => Object.keys(b)))
  ok(!keys.has('elements') && !keys.has('blocks') && !keys.has('children'),
    `no child array is invented on a block (keys: ${[...keys].sort().join(', ')})`)
  ok(JSON.stringify(Object.keys(dB.body[0]).sort()) === JSON.stringify(['id', 'kind', 'text']),
    'a block round-trips with exactly the properties it started with')
}

H('structure — blocks insert, delete and reorder')
{
  const { A, B, dA, dB } = pair()
  const beforeA = clone(dA)
  dA.body.splice(1, 0, { id: 'p3', kind: 'h2', text: 'Payment' })   // insert in the MIDDLE
  const opsA = A.diff(beforeA as never, dA as never, { text: true })

  const beforeB = clone(dB)
  dB.body[0].text = 'The parties agree as set out below.'
  const opsB = B.diff(beforeB as never, dB as never, { text: true })

  A.apply(dA as never, opsB)
  B.apply(dB as never, opsA)
  ok(JSON.stringify(dA) === JSON.stringify(dB), 'a concurrent insert and edit converge')
  ok(dA.body.map(b => b.id).join(',') === 'p1,p3,p2',
    `the new heading lands where it was put (${dA.body.map(b => b.id).join(',')})`)
  ok(dA.body[0].text === 'The parties agree as set out below.', 'and the concurrent edit is not lost')

  // delete
  const beforeD = clone(dA)
  dA.body.splice(0, 1)
  const opsD = A.diff(beforeD as never, dA as never, { text: true })
  B.apply(dB as never, opsD)
  ok(JSON.stringify(dA) === JSON.stringify(dB) && dB.body.length === 2,
    'a deleted block is gone on both replicas')

  // reorder
  const beforeR = clone(dA)
  dA.body.reverse()
  const opsR = A.diff(beforeR as never, dA as never, { text: true })
  B.apply(dB as never, opsR)
  ok(JSON.stringify(dA) === JSON.stringify(dB), 'a reorder converges')
}

H('an element-scoped op has nowhere to land, and is dropped')
{
  // Peers in a room share a shape, so this should never arrive — but it came
  // off the wire. Materializing it would throw against the frozen empty child
  // array, or invent a key the format does not have.
  const { A, dA } = pair()
  const before = clone(dA)
  const foreign = [
    { a: 'mallory', s: 1, l: 99, op: 'set', sl: 'p1', el: 'p1x1', k: 'text', v: 'injected' },
    { a: 'mallory', s: 2, l: 100, op: 'ins', kind: 'element', id: 'p1x2', sl: 'p1', ord: 'a', node: { id: 'x2' } },
  ] as unknown as Op[]
  let threw = false
  try { A.apply(dA as never, foreign) } catch { threw = true }
  ok(!threw, 'applying it does not throw')
  ok(JSON.stringify(dA) === JSON.stringify(before), 'and leaves the document untouched')
}

H('a saved state restores as the same flat binding')
{
  const { A, dA } = pair()
  const before = clone(dA)
  dA.body[0].text = 'Edited.'
  const first = A.diff(before as never, dA as never, { text: true })
  const back = TypeSync.fromJSON('alice', A.toJSON())
  ok(back instanceof TypeSync, 'a restored type engine is a type engine')
  ok(back.S.children === null && back.S.text === 'text',
    '…and still flat, with its text property intact')

  // it must still converge after the round trip
  const B = new TypeSync('bob')
  const dB = clone(dA)
  B.adopt(dB as never)
  const b2 = clone(dA)
  dA.body[1].text = 'Payment is due within 45 days.'
  const ops = back.diff(b2 as never, dA as never, { text: true })
  // both ops, in order: the restored engine continues alice's sequence, so
  // delivering only the later one leaves a per-actor gap and the engine
  // rightly holds it — that is delivery working, not a merge failure
  B.apply(dB as never, [...first, ...ops])
  ok(dB.body[1].text === 'Payment is due within 45 days.',
    'and a replica applies edits minted by the restored engine')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
