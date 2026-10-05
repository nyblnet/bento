#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Several slides selected in the sidebar and moved as a block
// (slides/src/editor/slidesel.ts) — discussion #514:
//
//   node scripts/test-slides-multiselect.ts
//
// WHAT THIS PROVES. The unit is a parent with its states. Select 1, 3 and 5
// (0-based; slide 3 has two states) and drop on 7: the block lands before
// the slide that was at 7, in its original relative order, states right
// behind their parent, one array out. A range and a toggle are parent-only.
// A drop onto the selection is a no-op. Deleting a selection plans the
// cascade the single delete does. And the old single-index splice is shown
// to have LEFT STATES BEHIND, which is requirement 3.

import { deletePlan, expand, moveBlock, parents, range, toggle, unitOf } from '../slides/src/editor/slidesel.ts'

let failures = 0, checks = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }

type S = { id: string; stateOf?: string; elements: Array<{ link?: string }> }
const mk = (): S[] => [
  { id: 'a', elements: [] },                         // 0
  { id: 'b', elements: [{ link: 'd' }] },            // 1  ← selected
  { id: 'c', elements: [] },                         // 2
  { id: 'd', elements: [] },                         // 3  ← selected, a parent
  { id: 'd1', stateOf: 'd', elements: [] },          // 4     its state
  { id: 'd2', stateOf: 'd', elements: [] },          // 5     its state  (index 5 is a STATE — selecting it means its parent)
  { id: 'e', elements: [] },                         // 6
  { id: 'f', elements: [] },                         // 7  ← drop target
  { id: 'g', elements: [] },                         // 8
]
const ids = (s: S[]) => s.map((x) => x.id).join(' ')

console.log('\nunits')
{
  const s = mk()
  ok(unitOf(s, 3).join(',') === '3,4,5', 'a parent with its two states is one unit')
  ok(unitOf(s, 1).join(',') === '1', 'a plain slide is a unit of one')
  ok(parents(s, [5, 1, 3, 3]).join(',') === '1,3', 'a selection normalises to parents, unique, in order (a state selects its parent)')
  ok(expand(s, [1, 3]).join(',') === '1,3,4,5', 'expanding a selection lists the states too')
  ok(range(s, 1, 6).join(',') === '1,2,3,6', 'a Shift range covers the parents between, never a state')
  ok(range(s, 6, 1).join(',') === '1,2,3,6', 'in either direction')
  ok(toggle(s, [1], 3).join(',') === '1,3' && toggle(s, [1, 3], 3).join(',') === '1' && toggle(s, [1], 4).join(',') === '1,3', 'Cmd-click toggles a unit; on a state it toggles the parent')
}

console.log('\nthe move — select 1, 3, 5 and drop on 7')
{
  const s = mk()
  const out = moveBlock(s, [1, 3, 5], 7)
  ok(ids(out) === 'a c e b d d1 d2 f g', `the block lands before the slide that was at 7, relative order kept, states behind their parent → ${ids(out)}`)
  ok(out !== s && ids(s) === 'a b c d d1 d2 e f g', 'a new array; the input untouched')
  ok(out.length === s.length && new Set(out.map((x) => x.id)).size === 9, 'nothing lost, nothing doubled')
  const end = moveBlock(s, [1, 3], s.length)
  ok(ids(end) === 'a c e f g b d d1 d2', `drop past the end appends → ${ids(end)}`)
  const front = moveBlock(s, [3, 7], 0)
  ok(ids(front) === 'd d1 d2 f a b c e g', `drop on 0 leads → ${ids(front)}`)
  const up = moveBlock(s, [7], 1)
  ok(ids(up) === 'a f b c d d1 d2 e g', 'moving one slide up works as the old single drag did')
  ok(moveBlock(s, [1, 3], 4) === s && moveBlock(s, [1, 3], 3) === s, 'a drop onto the selection (a parent or its state) is a no-op — the same array back')
  ok(moveBlock(s, [], 2) === s && moveBlock(s, [99], 2) === s, 'nothing selected, or out of range: no-op')
  ok(moveBlock(s, [1], 2) === s, 'a drop just after itself changes nothing — the same array back')
}

console.log('\nrequirement 3 — what the single-index splice did')
{
  const s = mk()
  const old = [...s]; const [moved] = old.splice(3, 1); old.splice(7, 0, moved)
  ok(ids(old) === 'a b c d1 d2 e f d g', `the old drag moved the parent alone and LEFT ITS STATES BEHIND, nested under c → ${ids(old)}`)
  const now = moveBlock(s, [3], 7)
  ok(ids(now) === 'a b c e d d1 d2 f g', `the block move carries them → ${ids(now)}`)
  const back = moveBlock(now, [4], 1)
  ok(ids(back) === 'a d d1 d2 b c e f g', 'and back again, states still behind')
}

console.log('\ndeleting a selection')
{
  const s = mk()
  const p = deletePlan(s, [3, 1])
  ok([...p.doomed].join(',') === 'b,d,d1,d2' && p.states === 2 && p.links === 0 && p.survives, 'doomed: the parents and their states; links from doomed slides do not count')
  const q = deletePlan(s, [3])
  ok(q.links === 1 && q.states === 2, 'a link into the doomed from a survivor is counted')
  const all = deletePlan(s, [0, 1, 2, 3, 6, 7, 8])
  ok(!all.survives, 'deleting every linear slide is refused (a deck needs one)')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
