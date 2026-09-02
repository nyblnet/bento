#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Collaborative text on a PARENT node.
//
//   node scripts/test-sync-parent-text.ts
//
// WHY THIS EXISTS. The token RGA — the thing that lets two people type in one
// paragraph without destroying each other's work — was reachable only on CHILD
// nodes, because both shipped apps put their text there (a slide's elements, a
// page's blocks). bento/type does not: a block IS the paragraph, so its text
// lives one level up. Bound naively, type would have got a last-writer-wins
// register for prose, and the loss would be SILENT — the document stays valid,
// converges, and simply contains one of the two edits.
//
// The other four sync rigs stayed green throughout this change, which proves
// only that nothing broke. Nothing there declares text on a parent, so nothing
// there exercises the new path at all. This is that evidence.
//
// The negative control is the point of the second half: the same scenario run
// with the RGA disabled MUST lose an edit. A rig that has never been seen
// failing is not a gate.

import { SyncEngine, shape } from '../slides/src/sync/crdt.ts'
import type { DocShape } from '../slides/src/sync/crdt.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const H = (s: string) => console.log(`\n=== ${s} ===`)

console.log('bento-sync — collaborative text on a parent node\n')

/**
 * Text declared on the PARENT. This is not yet type's shape (type's body is
 * flat, which needs `children` to become optional) — it isolates ONE variable:
 * the level the text sits at. Children still exist and are still synced, so a
 * regression in the child path shows up here as well.
 */
const PARENT_TEXT: DocShape = shape('pages', 'blocks', 'text')
class ParentTextSync extends SyncEngine {
  constructor(actor: string) { super(actor, PARENT_TEXT) }
}

type Doc = { pages: Array<{ id: string; text: string; blocks: unknown[] }> }
const mk = (text: string): Doc => ({
  format: 'bento/parent-text', version: 1, docId: 'd', title: 'T',
  pages: [{ id: 'p1', text, blocks: [] }],
} as unknown as Doc)

/** the composite-key separator, written as an escape: a literal here is invisible and does not survive editing */
const SEP = '\u001f'
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

const BASE = 'The parties agree.'
const ALICE = 'The parties hereby agree.'   // inserts in the MIDDLE
const BOB = 'The parties agree. Signed.'    // appends at the END

/** Both replicas edit the same parent's text from the same base, then swap. */
function race(text: boolean) {
  const A = new ParentTextSync('alice')
  const B = new ParentTextSync('bob')
  const dA = mk(BASE)
  A.adopt(dA as never)
  const dB = clone(dA)
  B.adopt(dB as never)

  const beforeA = clone(dA)
  dA.pages[0].text = ALICE
  const opsA = A.diff(beforeA as never, dA as never, { text })

  const beforeB = clone(dB)
  dB.pages[0].text = BOB
  const opsB = B.diff(beforeB as never, dB as never, { text })

  A.apply(dA as never, opsB)
  B.apply(dB as never, opsA)
  return { dA, dB, opsA, opsB }
}

H('a text edit on a parent mints an RGA delta, not a whole-value set')
{
  const { opsA } = race(true)
  ok(opsA.length === 1 && opsA[0].op === 'txt',
    `one token delta (got ${opsA.map(o => o.op).join(',') || 'nothing'})`)
  ok(String(opsA[0].el) === 'p1',
    `keyed by the BARE parent id — no composite key, because there is no child (got ${JSON.stringify(String(opsA[0].el))})`)
  ok(!String(opsA[0].el).includes(SEP),
    'and specifically carries no separator, which is what routes it to the parent lookup')
}

H('two people typing in one paragraph both survive')
{
  const { dA, dB } = race(true)
  ok(JSON.stringify(dA) === JSON.stringify(dB), 'the replicas converge')
  const merged = dA.pages[0].text
  console.log(`      alice: ${JSON.stringify(ALICE)}`)
  console.log(`      bob:   ${JSON.stringify(BOB)}`)
  console.log(`      merged:${JSON.stringify(merged)}`)
  ok(merged.includes('hereby'), "alice's insertion survives")
  ok(merged.includes('Signed'), "bob's insertion survives")
  ok(merged === 'The parties hereby agree. Signed.',
    'and they merge in document order rather than concatenating')
}

H('negative control — with the RGA off, an edit IS lost')
{
  // Same scenario, same code path, `text: false`. If this does NOT lose an
  // edit, the test above proves nothing: it would pass under plain LWW too.
  const { dA, dB, opsA } = race(false)
  ok(opsA.length === 1 && opsA[0].op === 'set',
    `the edit degrades to a whole-value set (got ${opsA[0].op})`)
  ok(JSON.stringify(dA) === JSON.stringify(dB), 'it still converges — which is exactly why the loss is silent')
  const merged = dA.pages[0].text
  const lost = !merged.includes('hereby') || !merged.includes('Signed')
  ok(lost, `one author's work is gone: ${JSON.stringify(merged)}`)
}

H('children still work — the child path is not collateral damage')
{
  const A = new ParentTextSync('alice')
  const B = new ParentTextSync('bob')
  const dA = mk(BASE)
  dA.pages[0].blocks = [{ id: 'b1', text: 'a note' }]
  A.adopt(dA as never)
  const dB = clone(dA)
  B.adopt(dB as never)

  const beforeA = clone(dA)
  ;(dA.pages[0].blocks[0] as { text: string }).text = 'a longer note'
  const opsA = A.diff(beforeA as never, dA as never, { text: true })

  const beforeB = clone(dB)
  dB.pages[0].text = BOB
  const opsB = B.diff(beforeB as never, dB as never, { text: true })

  ok(opsA.length === 1 && opsA[0].op === 'txt' && String(opsA[0].el) === 'p1' + SEP + 'b1',
    'a CHILD text edit still keys on the composite key')
  A.apply(dA as never, opsB)
  B.apply(dB as never, opsA)
  ok(JSON.stringify(dA) === JSON.stringify(dB), 'parent and child text edits converge together')
  ok((dA.pages[0].blocks[0] as { text: string }).text === 'a longer note' &&
     dA.pages[0].text === BOB,
    'and both land')
}

H('a whole-value set still beats a stale generation')
{
  // The reset path (someone pastes over the paragraph) has to out-stamp the
  // token history at parent level too, or the paste would be swallowed.
  const A = new ParentTextSync('alice')
  const dA = mk(BASE)
  A.adopt(dA as never)
  let before = clone(dA)
  dA.pages[0].text = ALICE
  const typed = A.diff(before as never, dA as never, { text: true })   // seeds a generation

  before = clone(dA)
  dA.pages[0].text = 'Replaced wholesale.'
  const pasted = A.diff(before as never, dA as never, { text: false })
  ok(pasted.length === 1 && pasted[0].op === 'set', 'the paste mints a set')

  const B = new ParentTextSync('bob')
  const dB = mk(BASE)
  B.adopt(dB as never)
  // BOTH ops, in order. Delivering only the paste leaves a per-actor sequence
  // gap and the engine correctly holds it in the buffer — an earlier version of
  // this fixture did exactly that and read the result as a bug in the code.
  B.apply(dB as never, [...typed, ...pasted])
  ok(dB.pages[0].text === 'Replaced wholesale.',
    `the set out-stamps the generation it arrives behind (got ${JSON.stringify(dB.pages[0].text)})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
