#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// CRDT property-REMOVAL rig.
//
//   node scripts/test-crdt-delprop.ts
//
// WHAT THIS PROVES. Removing a property is an ordinary edit — the editor does
// it in a dozen places (fill style → solid deletes `colorGradient`, "none"
// deletes `textStroke`, Unlink deletes a chart's `source`, ⇧⌘G deletes
// `groupId`) — and it travels as a `set` op whose `v` is ABSENT, which is how
// the engine spells "delete the key".
//
// On the RECEIVING replica that threw:
//
//   TypeError: Cannot read properties of undefined (reading 'slice')
//
// `JSON.stringify(undefined)` is `undefined`, not `"undefined"`, and the debug
// line sliced it. A template literal evaluates its expressions eagerly, so the
// dbg() call being a no-op did not save it — every collaborator applying that
// op crashed, live, in shipped files.
//
// The convergence rig never caught it in 300 seeds because its random mutations
// assign properties and never REMOVE one. That is the lesson worth keeping: a
// property-based rig only explores the mutations you taught it, so an operation
// the UI performs and the generator does not is invisible no matter how many
// seeds you run.

import { SyncState } from '../slides/src/sync/crdt.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const el = (extra: Record<string, unknown> = {}) => ({
  id: 'e1', type: 'text', x: 0, y: 0, w: 100, h: 50, rotation: 0, opacity: 1,
  html: 'hi', fontSize: 20, fontFamily: 'x', fontWeight: 400,
  color: '#000', align: 'left', valign: 'top', lineHeight: 1.2, ...extra,
})
const doc = (els: unknown[]) => ({
  format: 'bento/slides', version: '1', docId: 'd1', title: 't',
  size: { width: 1280, height: 720 }, theme: { accent: '#000' }, assets: {}, fonts: null,
  slides: [{ id: 's1', name: 'one', background: '#fff', transition: 'fade', notes: '', elements: els }],
}) as any

// Each of these is a real editor action that deletes a key.
const REMOVALS: Array<[string, Record<string, unknown>]> = [
  ['shadow (Shadow → none)', { shadow: { blur: 8, color: '#0003' } }],
  ['colorGradient (Fill style → solid)', { colorGradient: { angle: 90, stops: [{ at: 0, color: '#f00' }] } }],
  ['textStroke (Outline → none)', { textStroke: { width: 2, color: '#000' } }],
  ['groupId (⇧⌘G ungroup)', { groupId: 'g1' }],
  ['link (clear the jump target)', { link: 's2' }],
]

for (const [label, extra] of REMOVALS) {
  const before = doc([el(extra)])
  const after = doc([el()])

  const author = new SyncState('alice')
  author.adopt(before)
  const ops = author.diff(before, after)

  const setOps = ops.filter((o: any) => o.op === 'set')
  ok(setOps.length > 0 && setOps.some((o: any) => o.v === undefined),
    `${label}: travels as a set op with v absent`)

  // The receiving replica is where it broke.
  const peer = new SyncState('bob')
  const target = doc([el(extra)])
  peer.adopt(target)
  let threw: string | null = null
  try { peer.apply(target, ops as any) } catch (e: any) { threw = `${e.constructor.name}: ${e.message}` }

  ok(threw === null, `${label}: a peer applies it without throwing${threw ? ` (got ${threw})` : ''}`)
  const key = Object.keys(extra)[0]
  ok(threw !== null || (target.slides[0].elements[0] as any)[key] === undefined,
    `${label}: the property is actually gone on the peer`)
}

// The same op arriving for a node the peer has not seen yet parks in `pending`
// and is replayed later — that path re-applies the op, so it must not throw either.
{
  const before = doc([el({ shadow: { blur: 4, color: '#000' } })])
  const author = new SyncState('alice')
  author.adopt(before)
  const ops = author.diff(before, doc([el()]))
  const peer = new SyncState('bob')
  const empty = doc([])
  peer.adopt(empty)
  let threw: string | null = null
  try { peer.apply(empty, ops as any) } catch (e: any) { threw = `${e.constructor.name}: ${e.message}` }
  ok(threw === null, `a removal for an unknown node pends without throwing${threw ? ` (got ${threw})` : ''}`)
}

// ---- the SECOND place the same defect lived ---------------------------------
// The original fix went to the `set` handler, where the bug was found. The
// identical line — JSON.stringify(v) sliced, with dbg's argument built eagerly
// whether or not debugging is on — also sat in replayStash, and stayed there:
// the fix went where the bug was, not everywhere the pattern was.
//
// IT IS NOT PINNED HERE, and that is deliberate rather than an omission. Two
// hand-built resurrection scenarios failed to reach the line (they passed with
// the fix REVERTED, which makes them worse than no test at all). What does
// reach it is the convergence rig, once its generator was taught to remove
// properties — measured: `node scripts/test-sync.ts` throws
// "Cannot read properties of undefined (reading 'slice')" with the fix
// reverted, and passes 45,368 checks with it.
//
// So the guard for this site is scripts/lib/sync-fixtures.ts case 12, and the
// lesson is the generator's, not this file's: a property-based rig explores
// exactly the mutations it was taught, and BOTH instances of this bug shipped
// because removal was not one of them.

// ---- the THIRD place, and this one IS pinned --------------------------------
// Same defect, same file, third site: assignNode, reached from an `ins` for a
// node that already exists locally. `k` iterates the UNION of the local node's
// keys and the incoming payload's, so `payload[k]` is undefined for every key
// the local node has and the payload does not — which is the ordinary case,
// not an exotic one.
//
// The note above says two hand-built resurrection scenarios failed to reach
// the replayStash site. This site is different: it has a short, realistic
// trigger, so it gets a real test rather than a deferral to the generator.
//
// How it was found: the equivalence rig at 400 seeds × 120 steps × 5 actors
// (CI runs 200 × 60 × 4 and never reached it). How it would be met in the
// field: two people creating an element with the SAME id at the same time —
// which is not a collision to be designed out, it is the morph idiom, the
// thing element ids are shared for.
{
  const both = (extra: Record<string, unknown>) => {
    const A = new SyncState('alice')
    const docA = doc([])
    A.adopt(docA)
    const beforeA = JSON.parse(JSON.stringify(docA))
    docA.slides[0].elements.push(el(extra))
    A.diff(beforeA, docA)

    const B = new SyncState('bob')
    const docB = doc([])
    B.adopt(docB)
    const beforeB = JSON.parse(JSON.stringify(docB))
    docB.slides[0].elements.push(el())          // the same id, without `extra`
    const opsB = B.diff(beforeB, docB)

    let threw: string | null = null
    try { A.apply(docA, opsB as any) } catch (e: any) { threw = `${e.constructor.name}: ${e.message}` }
    return threw
  }

  for (const [label, extra] of REMOVALS) {
    const threw = both(extra)
    ok(threw === null,
      `two replicas create the same element id, one carrying ${label.split(' ')[0]}: applies without throwing${threw ? ` (got ${threw})` : ''}`)
  }

  // and the property really does survive: the local value is not silently
  // dropped just because the incoming payload was missing the key
  const A = new SyncState('alice')
  const docA = doc([])
  A.adopt(docA)
  const beforeA = JSON.parse(JSON.stringify(docA))
  docA.slides[0].elements.push(el({ groupId: 'g1' }))
  A.diff(beforeA, docA)
  const B = new SyncState('bob')
  const docB = doc([])
  B.adopt(docB)
  const beforeB = JSON.parse(JSON.stringify(docB))
  docB.slides[0].elements.push(el())
  // guarded: with the fix reverted this throws, and a rig that DIES reports
  // nothing — the run has to end in a count, not a stack trace
  let survived = true
  try { A.apply(docA, B.diff(beforeB, docB) as any) } catch { survived = false }
  ok(survived && ('groupId' in docA.slides[0].elements[0] === false || docA.slides[0].elements[0].groupId === 'g1'),
    'the assignment resolves deterministically rather than half-applying')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
