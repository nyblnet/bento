#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The writing surface's two decisions that are pure enough to assert:
// WHICH SEAT an arrow key lands in, and WHAT Tab resolves to.
//
//   node scripts/test-spaces-caret.ts
//
// Caret MOVEMENT cannot be asserted here — where a line wraps is the browser's
// answer and there is no browser in this process. What can be asserted, and is
// the part that was actually wrong, is the arithmetic underneath it:
//
//  - `onEdgeLine` decides whether ↓ means "the next line of this paragraph" or
//    "the next block". Get it wrong in one direction and a wrapped paragraph
//    traps the caret; wrong in the other and its second line is unreachable.
//  - `indentTarget` decides what Tab does. THE FAILING CASE IS THE FIRST ITEM,
//    and a test written against the second item passes just as happily against
//    the code that shipped with the bug — which is how the bug shipped. Every
//    edge here is a case a happy-path test skips: the only block, the first
//    block, a block whose siblings are all nested elsewhere, a block that is
//    not on the page at all.

import { onEdgeLine, stepSeat, tableStep, nearestByX, mergeLines, type Box } from '../spaces/src/caret.ts'
import { indentTarget, canOutdent, type Nestable } from '../spaces/src/nesting.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
}

const box = (top: number, bottom: number, left = 0, right = 100): Box => ({ top, bottom, left, right })

// ---- onEdgeLine -------------------------------------------------------------
// A three-line paragraph: lines at y 0–20, 20–40, 40–60.
const para = [box(0, 20), box(20, 40), box(40, 60)]

console.log('\nonEdgeLine — within the block before leaving it')
ok(onEdgeLine(box(2, 18), para, -1), 'caret on line 1: ↑ leaves the block')
ok(!onEdgeLine(box(2, 18), para, 1), '…and ↓ stays in it')
ok(!onEdgeLine(box(22, 38), para, -1), 'caret on line 2: ↑ stays in the block')
ok(!onEdgeLine(box(22, 38), para, 1), '…and so does ↓')
ok(onEdgeLine(box(42, 58), para, 1), 'caret on line 3: ↓ leaves the block')
ok(!onEdgeLine(box(42, 58), para, -1), '…and ↑ stays in it')

console.log('\nonEdgeLine — the cases a single-line test never sees')
const one = [box(0, 20)]
ok(onEdgeLine(box(2, 18), one, -1) && onEdgeLine(box(2, 18), one, 1),
  'a ONE-line block is both edges at once')
ok(onEdgeLine(box(0, 0), [], -1) && onEdgeLine(box(0, 0), [], 1),
  'an EMPTY block has no lines and is crossed in either direction')
// a caret next to a taller inline is SHORTER than its line box: comparing tops
// for equality would call this "not on the first line" and trap the caret
ok(onEdgeLine(box(6, 14), para, -1), 'a short caret on a tall first line still counts as on it')
// and the reverse: a caret on the last line must not read as being on the first
ok(!onEdgeLine(box(46, 54), para, -1), '…while one on the last line does not')

// ---- mergeLines -------------------------------------------------------------
// getClientRects() gives a rect per inline BOX, not per line. The starter
// space's first paragraph is two visual lines and FIVE rects, because of the
// <strong> in the middle of the first one — measured in the built shell.
console.log('\nmergeLines — fragments of one line are one line')
const frags: Box[] = [
  { top: 182, bottom: 201, left: 555, right: 983 },   // line 1, before the bold
  { top: 182, bottom: 201, left: 983, right: 1089 },  // the bold run
  { top: 182, bottom: 201, left: 983, right: 1089 },  // …reported twice
  { top: 182, bottom: 201, left: 1089, right: 1261 }, // after it
  { top: 209, bottom: 228, left: 555, right: 678 },   // line 2
]
const merged = mergeLines(frags)
ok(merged.length === 2, `five rects over two lines merge to two (got ${merged.length})`)
ok(merged[0].left === 555 && merged[0].right === 1261,
  'the first line spans the UNION of its fragments — clamping a goal column into')
ok(merged[1].top === 209 && merged[1].right === 678, '…and the second line keeps its own extent')
// a taller inline (a code span, a bigger font) shares the line it sits on
ok(mergeLines([{ top: 10, bottom: 30, left: 0, right: 50 }, { top: 6, bottom: 34, left: 50, right: 90 }]).length === 1,
  'a taller fragment joins the line it overlaps, not a line of its own')
ok(mergeLines([]).length === 0, 'nothing measures as nothing')
// and ordering: rects can arrive out of visual order
ok(mergeLines([{ top: 50, bottom: 70, left: 0, right: 9 }, { top: 10, bottom: 30, left: 0, right: 9 }])[0].top === 10,
  'lines come back top-first whatever order the rects arrived in')

// ---- stepSeat ---------------------------------------------------------------
console.log('\nstepSeat — the ends of the page')
ok(stepSeat(5, 2, 1) === 3, 'forward from the middle')
ok(stepSeat(5, 2, -1) === 1, 'back from the middle')
ok(stepSeat(5, 4, 1) === -1, 'off the LAST seat: nowhere to go')
ok(stepSeat(5, 0, -1) === -1, 'off the FIRST seat: nowhere to go')
ok(stepSeat(1, 0, 1) === -1 && stepSeat(1, 0, -1) === -1, 'a page with one seat goes nowhere')

// ---- tableStep --------------------------------------------------------------
// Cells are row-major in the DOM and column-major on the screen, so a table is
// stepped by the grid and never by document order.
console.log('\ntableStep — the grid, not the DOM order')
const size = { w: 3, h: 3 }
ok(JSON.stringify(tableStep({ r: 1, c: 2 }, size, -1)) === '{"r":0,"c":2}',
  '↑ from (1,2) stays in column 2 — document order would give (1,1)')
ok(JSON.stringify(tableStep({ r: 1, c: 2 }, size, 1)) === '{"r":2,"c":2}', '↓ likewise')
ok(tableStep({ r: 0, c: 1 }, size, -1) === null, '↑ off the top row leaves the table')
ok(tableStep({ r: 2, c: 1 }, size, 1) === null, '↓ off the bottom row leaves the table')
ok(tableStep({ r: 0, c: 0 }, { w: 1, h: 1 }, 1) === null, 'a 1×1 table is all edge')

// ---- nearestByX -------------------------------------------------------------
console.log('\nnearestByX — entering a table lands under the goal column')
const cols = [box(0, 20, 0, 50), box(0, 20, 50, 80), box(0, 20, 80, 300)]
ok(nearestByX(cols, 10) === 0, 'a column the caret is inside wins')
ok(nearestByX(cols, 65) === 1, '…including a narrow one')
ok(nearestByX(cols, 200) === 2, '…including a wide one')
ok(nearestByX(cols, -40) === 0, 'left of everything: the first')
ok(nearestByX(cols, 999) === 2, 'right of everything: the last')
ok(nearestByX([], 10) === -1, 'no columns at all: no answer')
// distance to the BOX, not to its centre. A caret sitting inside a wide first
// column, near its right edge, belongs to that column — measuring to centres
// hands it to the narrow one next door, which is the whole reason for the
// clamp-to-zero above.
const lopsided = [box(0, 20, 0, 300), box(0, 20, 300, 320)]
ok(nearestByX(lopsided, 299) === 0, 'a point INSIDE a wide column stays in it')
ok(nearestByX(lopsided, 305) === 1, '…and a point inside the narrow one stays there')

// ---- indentTarget — THE CASE THE BUG WAS IN ---------------------------------
console.log('\nindentTarget — Tab, including every case a happy path skips')
const page = (...rows: Array<[string, string?]>): Nestable[] =>
  rows.map(([id, parent]) => (parent === undefined ? { id } : { id, parent }))

const list = page(['a'], ['b'], ['c'])
ok(indentTarget(list, 'b').ok && (indentTarget(list, 'b') as any).parent === 'a',
  'the SECOND item nests under the first — the case that always worked')
const first = indentTarget(list, 'a')
ok(!first.ok && (first as any).why === 'first',
  'the FIRST item refuses, and says WHY — this returned silently before')
const only = indentTarget(page(['solo']), 'solo')
ok(!only.ok && (only as any).why === 'first', 'the ONLY block refuses the same way')
const absent = indentTarget(list, 'nope')
ok(!absent.ok && (absent as any).why === 'gone', 'a block not on the page is a caller bug, not a refusal')

// nesting is by LEVEL: the preceding block must be a sibling, not any block
const nested = page(['a'], ['b', 'a'], ['c', 'a'], ['d'])
ok(indentTarget(nested, 'd').ok && (indentTarget(nested, 'd') as any).parent === 'a',
  'a top-level block skips past the nested run above it to the last top-level one')
ok(indentTarget(nested, 'c').ok && (indentTarget(nested, 'c') as any).parent === 'b',
  'a nested block nests under its preceding SIBLING')
const firstChild = indentTarget(nested, 'b')
ok(!firstChild.ok && (firstChild as any).why === 'first',
  'the first child of a container refuses too — it is first at its level')

// the first block on a page whose every other block is nested elsewhere
const buried = page(['x', 'ghost'], ['y'])
ok(indentTarget(buried, 'y').ok === false,
  'a block whose only predecessor is at another level has nothing to nest under')

// ---- canOutdent -------------------------------------------------------------
console.log('\ncanOutdent — by the EFFECTIVE parent')
const eff = new Map<string, string | undefined>([['a', undefined], ['b', 'a'], ['c', undefined]])
ok(canOutdent(eff, 'b'), 'a nested block outdents')
ok(!canOutdent(eff, 'a'), 'a top-level block does not')
ok(!canOutdent(eff, 'missing'), 'nor does one the map has never heard of')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
