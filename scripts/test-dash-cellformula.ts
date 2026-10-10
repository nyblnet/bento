#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash per-cell formula rig.
//
//   node scripts/test-dash-cellformula.ts
//
// WHAT THIS PROVES. A per-cell formula produces a number that a reader will
// trust without being able to check it, which makes every failure here a
// SILENT one. The three that matter:
//
//   ORDER      `=A1*2` computed before `A1` itself reads a stale value and
//              writes it into the document looking authoritative.
//   CYCLES     a cycle resolved by "whatever we had last time" reports a
//              different answer on each recalculation and nothing says so.
//   ERRORS     an error that becomes a zero is the same sin as a gap drawn as
//              a zero in a chart — an absence rendered as a fact.
//
// Every check below is a NEGATIVE control on one of those: it constructs the
// case where a plausible-looking implementation gets it wrong.

import {
  bindRefs, cellDeps, cellKey, evalCell, isFormula, recalcCells, formulaBody,
  translateCellFormula, shiftSheetFormulas, type CellSource,
} from '../dash/src/cellformula.ts'
import { isErr, type Cell, type Vec } from '../dash/src/formula.ts'
import { parseRef } from '../dash/src/a1.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** A grid literal: `null` is empty, a leading `=` is a formula. */
function grid(cells: (string | number | null)[][]): CellSource {
  const rows = cells.length
  const cols = Math.max(...cells.map((r) => r.length))
  return {
    rows,
    cols,
    formulaAt: (r, c) => {
      const v = cells[r]?.[c]
      return isFormula(v) ? v : undefined
    },
    valueAt: (r, c) => {
      const v = cells[r]?.[c]
      return isFormula(v) ? null : (v ?? null) as Cell
    },
  }
}

const val = (g: CellSource, ref: string): Cell => {
  const r = parseRef(ref)!
  return recalcCells(g).values.get(cellKey(r.row, r.col)) ?? null
}
const code = (v: Cell): string => (isErr(v) ? String(v) : `not an error (${JSON.stringify(v)})`)

// ------------------------------------------------------------- binding
{
  const { expr, deps } = bindRefs('B4*1.2')
  ok(expr === '_a1_0*1.2', 'a reference is rewritten to a bound name')
  ok(deps.length === 1 && deps[0].cells.length === 1 && deps[0].cells[0].row === 3,
    'and the name carries the position it points at (B4 = row 3, 0-based)')
}
{
  const { deps } = bindRefs('SUM(A1:A4)')
  ok(deps[0].cells.length === 4, 'a range binds to every cell it covers')
}
{
  // the whole reason the scanner is shared with a1.ts rather than re-written
  const { expr } = bindRefs('"A1 is " & A1')
  ok(expr.includes('"A1 is "') && expr.includes('_a1_0'),
    'a reference inside a string literal is TEXT, and only the real one is bound')
  ok(bindRefs('LOG10(2)').deps.length === 0,
    'LOG10 is a call, not a reference to cell LOG10 — the name is followed by (')
  ok(bindRefs('[A1] * 2').deps.length === 0,
    'and [A1] is the escape for a COLUMN named like a cell')
}

// --------------------------------------------------- evaluation, in isolation
{
  const read = (r: { row: number; col: number }): Cell =>
    ([[10, 20], [30, 40]] as Cell[][])[r.row]?.[r.col] ?? null
  ok(evalCell('=A1+B2', read) === 50, 'a formula reads the cells it names')
  ok(evalCell('=SUM(A1:B2)', read) === 100, 'and a range aggregates without `:` being an operator')
  ok(evalCell('A1+1', read) === 11, 'the leading = is optional at this level')
}

// --------------------------------------------------------------- ORDER
{
  // C1 depends on A1, which depends on B1. Any implementation that evaluates
  // in document order gets C1 wrong, and gets it wrong QUIETLY.
  const g = grid([['=B1*2', 5, '=A1+1']])
  const r = recalcCells(g)
  ok(val(g, 'A1') === 10, 'A1 = B1*2 = 10')
  ok(val(g, 'C1') === 11,
    'C1 = A1+1 = 11 — computed AFTER A1 even though it comes first in no useful order')
  ok(r.order.indexOf(cellKey(0, 0)) < r.order.indexOf(cellKey(0, 2)),
    'and the reported order says so')
}
{
  // THE ORDERING TEST THAT BITES. Above, A1 happens to sit left of the cell
  // that needs it, so plain document order gets the right answer by luck and
  // the check proves nothing. Here the dependency chain runs BACKWARDS against
  // the document: A1 needs C1, which needs B1. Anything that walks the grid in
  // order computes A1 from an unsettled C1.
  const g = grid([['=C1+1', 5, '=B1*2']])
  ok(val(g, 'C1') === 10, 'C1 = B1*2 = 10')
  ok(val(g, 'A1') === 11,
    'A1 = C1+1 = 11, with the chain running right-to-left against document order')
}
{
  // and the same, downwards, since a row walk and a column walk fail differently
  const g = grid([['=A3+1'], ['=A1*10'], [4]])
  ok(val(g, 'A2') === 50, 'A2 = A1*10 = 50, where A1 itself waits on a row BELOW it')
}
{
  // a chain long enough that a single pass cannot fake it
  const row: (string | number)[] = [1]
  for (let i = 1; i < 12; i++) row.push(`=${String.fromCharCode(65 + i - 1)}1+1`)
  const g = grid([row])
  ok(val(g, 'L1') === 12, 'a twelve-deep chain settles to the right number in one recalculation')
}

// --------------------------------------------------------------- CYCLES
{
  const g = grid([['=B1', '=A1']])
  ok(code(val(g, 'A1')) === '#CYCLE!', 'a two-cell cycle is #CYCLE!')
  ok(code(val(g, 'B1')) === '#CYCLE!', 'on BOTH cells, not just the one we noticed second')
  ok(recalcCells(g).cycles.length === 2, 'and it is reported, not just rendered')
}
{
  const g = grid([['=A1+1']])
  ok(code(val(g, 'A1')) === '#CYCLE!',
    'a cell that reads ITSELF is a cycle of one — the case a plain edge count misses entirely')
}
{
  const g = grid([['=B1', '=C1', '=A1', '=A1+100']])
  ok(code(val(g, 'D1')) === '#CYCLE!',
    'a cell DOWNSTREAM of a cycle is an error too, never a number computed from a guess')
}
{
  // the check that a cycle does not poison the whole sheet
  const g = grid([['=B1', '=A1'], [7, '=A2*3']])
  ok(val(g, 'B2') === 21, 'a cell unrelated to the cycle still computes')
}

// --------------------------------------------------------------- ERRORS
{
  const g = grid([[0, '=1/A1']])
  ok(code(val(g, 'B1')) === '#DIV/0!', 'division by zero is an error')
  const g2 = grid([[0, '=1/A1', '=B1+5']])
  ok(code(val(g2, 'C1')) === '#DIV/0!',
    'and it PROPAGATES — a formula reading an error is an error, not 5')
}
{
  const g = grid([[null, '=A1+1']])
  ok(val(g, 'B1') === 1, 'an EMPTY cell reads as nothing and arithmetic treats it as 0')
}
{
  const g = grid([[1, '=A50+1']])
  ok(val(g, 'B1') === 1,
    'a reference past the end of the sheet is EMPTY, not #REF! — #REF! means "deleted", and spending it here would make the informative error indistinguishable from a typo')
}
{
  const g = grid([['=#REF!+1']])
  ok(code(val(g, 'A1')) === '#REF!',
    'a #REF! left by an earlier deletion stays #REF!, rather than degrading to a parse failure')
}
{
  const g = grid([['=SUM(A1:XFD1048576)']])
  ok(isErr(val(g, 'A1')), 'a range too large to expand is an error rather than an attempt')
}
{
  const g = grid([['=NOSUCH(1)']])
  ok(isErr(val(g, 'A1')), 'an unknown function is an error')
}

// ------------------------------------------------- text, booleans, and types
{
  const g = grid([['north', '=A1 & " region"']])
  ok(val(g, 'B1') === 'north region', 'text concatenates')
  const g2 = grid([[5, '=IF(A1>3,"big","small")']])
  ok(val(g2, 'B1') === 'big', 'IF picks a branch on a cell value')
}

// ------------------------------------------------- column names still resolve
{
  const g = grid([[1], [2], [3]])
  const cols = new Map<string, Vec>([['amount', [1, 2, 3]]])
  ok(evalCell('=SUM(amount)', () => null, { cols }) === 6,
    'a cell formula can also name a COLUMN — the two systems share one evaluator')
}

// ------------------------------------------------------------ dependencies
{
  const d = cellDeps(formulaBody('=A1+SUM(B1:B3)'))
  ok(d.length === 4, 'cellDeps reports every position read, ranges expanded')
  ok(cellDeps('"B2" & 1').length === 0, 'and none from a string literal')
}

// -------------------------------------------------------------- the classic
{
  // quantity × price down a column, then a total — the thing a person actually
  // types into a spreadsheet on the first day
  const g = grid([
    [2, 3.5, '=A1*B1'],
    [4, 1.25, '=A2*B2'],
    [1, 10, '=A3*B3'],
    [null, null, '=SUM(C1:C3)'],
  ])
  ok(val(g, 'C1') === 7 && val(g, 'C2') === 5 && val(g, 'C3') === 10, 'line totals')
  ok(val(g, 'C4') === 22,
    'and the total sums the COMPUTED line totals, which only works if the sum runs last')
}

// ------------------------------------- moving formulas, and moving the cells
//
// TWO RULES, and conflating them is the classic spreadsheet bug. Copying moves
// the FORMULA and leaves the cells; inserting moves the CELLS and leaves the
// formula. `$` is the tell: it pins against the first and not the second.
{
  ok(translateCellFormula('=A1*2', 1, 0) === '=A2*2',
    'copied one row down, a relative reference follows')
  ok(translateCellFormula('=A1*2', 0, 1) === '=B1*2', 'and one column right')
  ok(translateCellFormula('=$A$1*2', 5, 5) === '=$A$1*2',
    '$ PINS against a copy — that is the whole meaning of $')
  ok(translateCellFormula('=$A1*2', 1, 1) === '=$A2*2',
    'and it pins per-axis: $A holds the column, the row still moves')
  ok(translateCellFormula('12', 3, 0) === '12', 'a plain value is not a formula and does not move')
  ok(translateCellFormula('=A1', 0, 0) === '=A1', 'a zero offset is left exactly alone')
}
{
  const shift = (f: string, axis: 'row' | 'col', at: number, n: number) =>
    shiftSheetFormulas([['k', f]], axis, at, n)[0]?.[1] ?? f
  ok(shift('=$A$5*2', 'row', 0, 1) === '=$A$6*2',
    'inserting a row above $A$5 moves it to $A$6 — $ does NOT pin here, because the cell itself moved')
  ok(shift('=A5', 'row', 9, 1) === '=A5', 'a row inserted BELOW a reference leaves it alone')
  ok(shift('=A5', 'row', 4, -1) === '=#REF!',
    'a reference INTO a deleted row is #REF! — never the row that slid up into the gap, which would be a wrong number wearing a right one\'s clothes')
  ok(shift('=SUM(A1:A10)', 'row', 3, -3) === '=SUM(A1:A7)',
    'a RANGE spanning the hole shrinks: the numbers under the heading are still there, there are just fewer of them')
  ok(shift('=B1', 'col', 0, 1) === '=C1', 'and the same on the column axis')
}
{
  // the pair that proves they are different rules and not one rule twice
  const copied = translateCellFormula('=$A$1+B2', 2, 0)
  const shifted = shiftSheetFormulas([['k', '=$A$1+B2']], 'row', 0, 2)[0][1]
  ok(copied === '=$A$1+B4', 'copying two rows down: $A$1 pinned, B2 followed')
  ok(shifted === '=$A$3+B4', 'inserting two rows at the top: BOTH moved')
  ok(copied !== shifted, 'so the two operations genuinely differ on the same input')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
