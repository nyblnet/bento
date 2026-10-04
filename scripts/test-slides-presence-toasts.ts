#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// "X joined" / "X left" said once per REAL arrival and departure
// (slides/src/editor/presencetoasts.ts):
//
//   node scripts/test-slides-presence-toasts.ts
//
// WHAT THIS PROVES, on a manual clock. A peer dropped by the presence TTL
// and back on the next heartbeat — the once-a-minute flap of a tab Chrome
// has throttled — is announced NEITHER as left NOR as joined. A departure
// that lasts past the grace is announced once, and a return after the
// quiet window is a real join again. A genuine first arrival is announced
// at once. A crowded room says nothing. dispose() cancels what is pending.

import { PresenceToasts } from '../slides/src/editor/presencetoasts.ts'

let failures = 0, checks = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }

// a manual clock with timers
let now = 1_000_000
const timers: Array<{ at: number; fn: () => void; id: number }> = []
let seq = 0
const setTimer = (fn: () => void, ms: number) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id }
const clearTimer = (id: unknown) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) }
const advance = (ms: number) => { now += ms; for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) { if (t.at <= now) t.fn(); else timers.push(t) } }
const said: string[] = []
const mk = (initial: Array<{ actor: string; name: string }> = []) => new PresenceToasts({ toast: (k, n) => said.push(`${n} ${k}`), leaveGraceMs: 45_000, rejoinQuietMs: 300_000, maxRoom: 8, now: () => now, setTimer, clearTimer }, initial)
const A = { actor: 'a', name: 'Ana' }, B = { actor: 'b', name: 'Ben' }

console.log('\nthe throttled-tab flap')
{
  const p = mk([A, B])
  p.update([A])                      // Ben's beat is late: the TTL dropped him
  ok(said.length === 0, 'a departure is not announced at once')
  advance(20_000)
  p.update([A, B])                   // his next beat lands (a throttled tab beats once a minute)
  advance(60_000)
  ok(said.length === 0, 'back within the grace: neither "left" nor "joined" — the flap is silent')
  for (let i = 0; i < 5; i++) { p.update([A]); advance(20_000); p.update([A, B]); advance(40_000) }
  ok(said.length === 0, 'five flaps in five minutes: still nothing said')
}

console.log('\na real departure, and a return')
{
  said.length = 0
  const p = mk([A, B])
  p.update([A])
  advance(44_000); ok(said.length === 0, 'not yet at 44 s')
  advance(2_000); ok(said.join() === 'Ben left', 'announced once, after the grace')
  advance(100_000)
  p.update([A, B])
  ok(said.join() === 'Ben left', 'back 2 minutes later: within the quiet window, not announced as a join')
  p.update([A]); advance(46_000)
  ok(said.join() === 'Ben left,Ben left', 'and gone again for good: left, once more')
  advance(400_000)
  p.update([A, B])
  ok(said.join() === 'Ben left,Ben left,Ben joined', 'back after the quiet window: a real join')
}

console.log('\na first arrival, a crowded room, dispose')
{
  said.length = 0
  const p = mk([A])
  p.update([A, B]); ok(said.join() === 'Ben joined', 'someone never seen: joined, at once')
  said.length = 0
  const many = Array.from({ length: 9 }, (_, i) => ({ actor: `m${i}`, name: `M${i}` }))
  p.update([A, B, ...many]); ok(said.length === 0, 'a room past 8 says nothing on the way in')
  p.update([A, B]); advance(60_000); ok(said.length === 0, 'nor on the way out')
  const q = mk([A, B])
  q.update([A]); q.dispose(); advance(60_000)
  ok(said.length === 0, 'dispose cancels a pending "left"')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
