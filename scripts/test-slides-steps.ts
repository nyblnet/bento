#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Reveal-steps rig (fx.step, "animate on click" — discussion #282).
//
//   node scripts/test-slides-steps.ts
//
// WHAT THIS PROVES. The decisions behind → and ← on a slide with stepped
// elements live in slides/src/steps.ts, pure, so they can be driven here:
// which press advances a step and which leaves the slide, what appears and
// disappears on each, that arriving backward lands fully revealed, that gaps
// in the numbering are pressed through in one go, and that a presenter's
// step reaches an audience copy through `set`. present.ts is the DOM around
// these answers and is pinned by shape at the end.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { StepState, maxStep, stepOf, stepsOf, shownAt } from '../slides/src/steps.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const el = (id: string, step?: number) => ({ id, ...(step !== undefined ? { fx: { step } } : {}) })
const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join(',')

console.log('stepOf / maxStep / stepsOf\n')
ok(stepOf(el('a')) === 0 && stepOf(el('b', 0)) === 0, 'no step, or 0 → shown with the slide')
ok(stepOf(el('c', 2)) === 2 && stepOf(el('d', 2.7)) === 2, 'a step is a positive integer; fractions floor')
ok(stepOf(el('e', -3)) === 0 && stepOf({ id: 'f', fx: { step: NaN } }) === 0, 'negatives and NaN are 0, not trusted')
const slide = [el('title'), el('r1', 1), el('r2', 2), el('r2b', 2), el('r5', 5)]
ok(maxStep(slide) === 5, 'maxStep is the last step present')
ok(stepsOf(slide).join(',') === '1,2,5', 'stepsOf lists the steps present, ascending, once each')
ok(shownAt(el('r2', 2), 1) === false && shownAt(el('r2', 2), 2) === true && shownAt(el('title'), 0), 'shownAt: step ≤ current')

console.log('\nforward through a slide\n')
{
  const st = new StepState()
  st.enter(slide, true)
  ok(st.step === 0 && st.hasNext() && !st.hasPrev(), 'arriving forward: step 0, → available, ← leaves the slide')
  let r = st.next()
  ok(r.kind === 'step' && r.step === 1 && ids(r.reveal) === 'r1', '→ reveals step 1: r1')
  r = st.next()
  ok(r.kind === 'step' && r.step === 2 && ids(r.reveal) === 'r2,r2b', '→ reveals step 2: both elements sharing it, together')
  r = st.next()
  ok(r.kind === 'step' && r.step === 5 && ids(r.reveal) === 'r5', '→ jumps the gap 3–4 and reveals step 5')
  ok(!st.hasNext(), 'every step shown: → would now leave the slide')
  ok(st.next().kind === 'slide', '…and does')
}

console.log('\nbackward through a slide\n')
{
  const st = new StepState()
  st.enter(slide, false)
  ok(st.step === 5 && !st.hasNext() && st.hasPrev(), 'arriving backward: every step shown, ← available')
  let r = st.prev()
  ok(r.kind === 'step' && r.step === 2 && ids(r.hide) === 'r5', '← hides step 5 and lands on step 2 (the gap is skipped backward too)')
  r = st.prev()
  ok(r.kind === 'step' && r.step === 1 && ids(r.hide) === 'r2,r2b', '← hides step 2')
  r = st.prev()
  ok(r.kind === 'step' && r.step === 0 && ids(r.hide) === 'r1', '← hides step 1')
  ok(st.prev().kind === 'slide', '← at step 0 leaves the slide')
}

console.log('\na slide with no steps, and the audience\n')
{
  const st = new StepState()
  st.enter([el('a'), el('b')], true)
  ok(!st.hasNext() && st.next().kind === 'slide' && st.prev().kind === 'slide', 'no steps: → and ← are plain slide navigation')
  st.enter(slide, true)
  st.set(2)
  ok(st.step === 2, 'set(2): the audience lands on the presenter\'s step')
  st.set(99)
  ok(st.step === 5, 'set clamps to the last step')
  st.set(-1)
  ok(st.step === 0, '…and to 0')
  st.set(3)
  ok(st.step === 3 && !stepsOf(slide).includes(3), 'set accepts a step with no elements (between 2 and 5): shows through 2, hides 5')
  ok(shownAt(el('r2', 2), st.step) && !shownAt(el('r5', 5), st.step), '…which shownAt resolves correctly')
}

console.log('\npresent.ts asks steps.ts, and the wire carries the step\n')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const present = readFileSync(join(root, 'slides/src/present.ts'), 'utf8')
ok(/const goNext = \(\) => \{\s*const r = steps\.next\(\)/.test(present), 'goNext asks steps.next() before moving to the next slide')
ok(/const goPrev = \(\) => \{\s*const r = steps\.prev\(\)/.test(present), 'goPrev asks steps.prev() before moving to the previous slide')
ok(/steps\.enter\(doc\.slides\[toIdx\]\?\.elements \?\? \[\], forward\)/.test(present), 'slidechanged enters the slide\'s steps with the direction')
ok(/nav\(\{[^}]*step: steps\.step/.test(present), 'the presenter\'s nav payload carries the step')
ok(/followStep\(jump, /.test(present), 'the audience applies the presenter\'s step')
ok(/\.bento-step-hidden/.test(readFileSync(join(root, 'slides/src/styles.css'), 'utf8')), 'the hidden-step class is styled (visibility, not display)')
ok(/step: num\(0, 1e4\)/.test(readFileSync(join(root, 'slides/src/untrusted.ts'), 'utf8')), 'the shape gate bounds fx.step')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
