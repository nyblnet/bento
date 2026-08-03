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

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
