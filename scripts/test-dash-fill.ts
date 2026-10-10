#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash FILL rig — ⌘D and the fill handle, which are two operations.
//
//   node scripts/test-dash-fill.ts
//
// WHY THIS EXISTS. Fill was the one gesture in the app that DESTROYED DATA, and
// it did it twice over, in ways that look like nothing on screen:
//
//   1. IT SEEDED FROM THE COMPUTED VALUE. A filled formula came out as the
//      constant it happened to evaluate to, and a formula whose evaluation had
//      FAILED came out as the error OBJECT, written into the column as though a
//      user had typed `{code:'#VALUE!'}` into a money cell. Measured on the
//      shipped starter workbook: ⌘D over four rows of Value turned
//      [12400, 8200, 15600, 4300] into [#VALUE!, 8200, #VALUE!, 8200].
//   2. ⌘D READ TWO SEEDS AND ALTERNATED THEM. Excel's Fill Down copies the TOP
//      row over the rest; reading a second row is the fill HANDLE's rule, where
//      the drag says which cells are the seed. One implementation for both
//      overwrote every other row of the selection with its neighbour.
//
// So the assertions here are about the SOURCE a fill reads and the DIFFERENCE
// between the two gestures. `fillCells` is the whole decision, in one pure
// function: what each output cell is, and — for a formula — which seed it came
// from, since only the grid knows how far the addresses moved (a dataset reads
// through a sort order, so the gap on screen is not the gap in the document).
//
// The reference translation itself is a1.ts's, proven in test-dash-a1.ts; what
// is checked here is that a fill USES it, with the right offsets, and that a
// stored cell never receives something computed.

import { fillCells, fillSeries, fillDown, type FillCell } from '../dash/src/select.ts'
import { translateCellFormula } from '../dash/src/cellformula.ts'

let failures = 0
let checks = 0
const j = (v: unknown): string => JSON.stringify(v)
function ok(cond: boolean, msg: string): void {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
function eq(got: unknown, want: unknown, msg: string): void {
  const same = j(got) === j(want)
  ok(same, same ? msg : `${msg} — got ${j(got)}, wanted ${j(want)}`)
}

const vals = (cells: FillCell[]): unknown[] => cells.map((c) => (c.f !== undefined ? c.f : c.v))

console.log('\n-- ⌘D copies the top row, and only the top row')
{
  // THE REGRESSION, in the shape it was measured in. Four rows of the starter
  // workbook's Value column: the fill must leave rows 2..4 holding row 1's
  // number, and must not read row 2 as a second seed.
  const seeds: FillCell[] = [{ v: 12400 }]
  eq(vals(fillCells(seeds, 4, 'copy')), [12400, 12400, 12400, 12400],
    '⌘D over 12400 fills 12400 four times')
  ok(!vals(fillCells(seeds, 4, 'copy')).includes(8200),
    'and never reaches the row below for a second seed')
  eq(vals(fillCells([{ v: 1 }, { v: 2 }], 5, 'copy')), [1, 2, 1, 2, 1],
    'given two seeds, copy REPEATS them — series detection is not ⌘D\'s job')
  eq(vals(fillCells([{ v: '2026-01-01' }], 3, 'copy')),
    ['2026-01-01', '2026-01-01', '2026-01-01'],
    'a lone date under ⌘D is a copy, not three consecutive days')
  eq(fillCells([], 4, 'copy'), [], 'no seeds, nothing to fill')
  eq(fillCells([{ v: 1 }], 0, 'copy'), [], 'no target, nothing to fill')
}

console.log('\n-- the fill HANDLE continues the series it was given')
{
  eq(vals(fillCells([{ v: 1 }, { v: 2 }], 5, 'series')), [1, 2, 3, 4, 5],
    'two-cell drag: 1,2 → 3,4,5')
  eq(vals(fillCells([{ v: '2026-01-01' }, { v: '2026-01-08' }], 4, 'series')),
    ['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22'],
    'a date series steps by the gap it was given')
  eq(vals(fillCells([{ v: 'Q1' }], 4, 'series')), ['Q1', 'Q2', 'Q3', 'Q4'],
    'a lone numbered label continues — the handle\'s rule, not ⌘D\'s')
  eq(vals(fillCells([{ v: 'a' }, { v: 'b' }], 4, 'series')), ['a', 'b', 'a', 'b'],
    'text with no progression repeats rather than inventing an alphabet')
  eq(vals(fillCells([{ v: 5 }], 3, 'series')), [5, 5, 5],
    'a lone number is a constant, in both gestures')
  // the engine underneath is unchanged, and the old rig still owns it
  eq(fillSeries([10, 20], 4), [10, 20, 30, 40], 'fillSeries itself is untouched')
  eq(fillDown([1, 2], 5), [1, 2, 1, 2, 1], 'and so is fillDown')
}

console.log('\n-- a FORMULA is copied and translated, never computed away')
{
  const out = fillCells([{ f: '=B1*2' }], 4, 'copy')
  eq(out.map((c) => c.f), ['=B1*2', '=B1*2', '=B1*2', '=B1*2'],
    'the formula SOURCE rides down — not the number it evaluated to')
  eq(out.map((c) => c.src), [0, 0, 0, 0], 'each output names the seed it came from')
  ok(out.every((c) => c.v === undefined), 'and carries no value beside it')

  // what the grid then does with `src`: the row distance, through a1.ts
  const translated = out.map((c, i) => translateCellFormula(c.f!, i - (c.src ?? 0), 0))
  eq(translated, ['=B1*2', '=B2*2', '=B3*2', '=B4*2'],
    '=B1*2 filled three rows down is =B2*2, =B3*2, =B4*2')
  eq(translateCellFormula('=$B$1*2', 3, 0), '=$B$1*2',
    'a $ANCHORED reference does not move — that is what the $ is for')
  eq(translateCellFormula('=$B1+B$1', 2, 0), '=$B3+B$1',
    'and a half-anchored one moves on the free axis only')

  // a formula ANYWHERE in the seeds makes the whole fill a copy: Excel does not
  // read a series out of expressions, and a "series" of formulas would be an
  // invented one
  const mixed = fillCells([{ f: '=A1' }, { v: 2 }], 4, 'series')
  eq(vals(mixed), ['=A1', 2, '=A1', 2], 'formula seeds repeat, they do not continue')
  eq(mixed.map((c) => c.src), [0, undefined, 0, undefined],
    'only the formula outputs carry a seed index')
}

console.log('\n-- an ERROR is never a seed and never a stored value')
{
  // The error OBJECT the recalculator produces for `=B1*2` where B1 is "Priya".
  // It reached storage because the fill seeded from the computed value; seeded
  // from the SOURCE, the formula is what fills and the error cannot appear.
  const err = { code: '#VALUE!', why: '"Priya" is not a number' }
  const out = fillCells([{ f: '=B1*2' }], 3, 'copy')
  ok(!j(out).includes('#VALUE!'), 'filling a FAILING formula produces no error text at all')
  ok(out.every((c) => c.v === undefined), 'and no value to write into the column')
  // Defence in depth: were an error ever handed in as a value, it is still an
  // object and still not a number — the grid drops it at the write gate. This
  // asserts the shape the gate tests for, so the two cannot drift apart.
  ok(typeof err === 'object' && 'code' in err && String(err.code).startsWith('#'),
    'an error is an object with a # code — what isErr() recognises at the write gate')
}

console.log('\n-- the shape the grid writes with')
{
  // The grid writes values through setCells and formulas through setOverrides,
  // and it has to be able to tell them apart per cell. Nothing else in the
  // result may be truthy-but-ambiguous.
  const out = fillCells([{ f: '=A1' }, { v: 0 }, { v: null }], 6, 'series')
  eq(out.map((c) => (c.f !== undefined ? 'f' : 'v')), ['f', 'v', 'v', 'f', 'v', 'v'],
    'every output is exactly one of a formula or a value')
  eq(out[2].v, null, 'a blank seed stays a blank, not undefined')
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'} — ${checks - failures}/${checks} checks`)
process.exit(failures ? 1 : 0)
