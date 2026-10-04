#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Follow mode rig (live broadcast, audience side).
//
//   node scripts/test-broadcast-follow.ts
//
// WHAT THIS PROVES. The audience overlay's decisions — which slide a
// presenter's nav names, whether the viewer follows or browses, what the
// presenter's lock does, when a laser sample is due — live in
// slides/src/follow.ts, pure, so they can be driven here without a DOM.
// Three properties matter and each has bitten a design before:
//
//   1. Navigation is by slide ID, index only as a fallback. The design this
//      replaced navigated by index; inserting a slide mid-talk sent every
//      viewer to the wrong slide, silently. Here an insert BEFORE the current
//      slide changes nothing for the viewer.
//   2. Lock is the presenter's, follow is the viewer's, and lock wins: it
//      forces follow on and makes the toggle inert — but it never hides a
//      slide (the viewer holds the deck), so unlocking restores browsing
//      without any state to repair.
//   3. Laser samples are rate-limited at the SOURCE (≤ 20 fps) and pen-up
//      always goes, or a viewer's dot could stick on after the presenter
//      stopped pointing.

import { FollowState, laserDue, resolveNav } from '../slides/src/follow.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const slides = [
  { id: 'a' }, { id: 'b' }, { id: 'b1', stateOf: 'b' }, { id: 'c' }, { id: 'd' },
]

console.log('resolveNav — ID first, visible index as fallback\n')
ok(resolveNav(slides, { id: 'c', i: 1 }) === 3, 'the ID wins over a contradicting index')
ok(resolveNav(slides, { i: 3 }) === 3, 'visible index 3 → slide c (the state is uncounted)')
ok(resolveNav(slides, { i: 2 }) === 1, 'visible index 2 → slide b')
ok(resolveNav(slides, { id: 'zz', i: 4 }) === 4, 'an unknown ID falls back to the index')
ok(resolveNav(slides, { id: 'zz' }) === -1, 'an unknown ID with no index resolves to nothing')
ok(resolveNav(slides, { i: 99 }) === -1 && resolveNav(slides, { i: 0 }) === -1, 'out-of-range and zero indices resolve to nothing')

console.log('\ninsert mid-talk — the viewer does not move\n')
{
  const f = new FollowState(true)
  ok(f.nav(slides, { id: 'c', i: 3 }) === 3, 'presenter on c: viewer jumps to index 3')
  const inserted = [{ id: 'new' }, ...slides] // a slide inserted at the front
  ok(f.nav(inserted, { id: 'c', i: 4 }) === 4, 'after the insert, c is index 4 and the viewer follows the ID there')
  ok(resolveNav(inserted, { i: 3 }) === 2, '(control) the OLD index alone would have landed on b — the bug the ID removes')
}

console.log('\nfollow ⇄ browse\n')
{
  const f = new FollowState(true)
  f.nav(slides, { id: 'b' })
  ok(f.label() === 'following', 'starts following')
  ok(f.toggle() === null && f.label() === 'browsing', 'toggle → browsing, no jump')
  ok(f.nav(slides, { id: 'd' }) === null, 'while browsing a nav is remembered but not applied')
  ok(f.presenterIndex === 4, '…remembered as the presenter\'s slide')
  ok(f.toggle() === 4 && f.label() === 'following', 'toggle back → following, snaps to the presenter\'s slide')
}

console.log('\nlock — the presenter\'s, and it wins\n')
{
  const f = new FollowState(true)
  f.toggle() // browsing
  ok(f.nav(slides, { id: 'c', lock: true }) === 3, 'a locked nav forces follow on and applies')
  ok(f.label() === 'locked', 'the chip reads locked')
  ok(f.toggle() === null && f.following === true, 'the toggle is inert under lock')
  ok(f.nav(slides, { id: 'd', lock: false }) === 4, 'an unlocked nav still applies (follow stayed on)')
  ok(f.label() === 'following', '…and the chip reads following, not locked')
  ok(f.toggle() === null && f.label() === 'browsing', 'browsing is available again the moment lock lifts')
  f.applyLock(true)
  ok(f.following && f.locked, 'lock via black also forces follow')
  f.applyLock(false)
  ok(!f.locked && f.following, 'unlock keeps whatever follow state lock forced — nothing to repair')
}

console.log('\nlaser rate limit at the source\n')
ok(laserDue('0.5,0.5', 100, 0), 'first sample goes')
ok(!laserDue('0.5,0.5', 130, 100), 'a sample 30 ms later is dropped (≤ 20 fps)')
ok(laserDue('0.5,0.5', 150, 100), 'a sample 50 ms later goes')
ok(laserDue(null, 101, 100), 'pen-up ALWAYS goes, whatever the clock says')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
