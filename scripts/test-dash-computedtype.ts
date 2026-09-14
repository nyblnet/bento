#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A formula column is typed by what its expression RETURNS.
//
//   node scripts/test-dash-computedtype.ts     (Node ≥ 23.6 strips types natively)
//
// WHY THIS EXISTS. `main.ts` created every computed column with a hardcoded
// `type: 'number'`. Measured in the running app: splitting a "Lastname,
// Firstname" column with `TRIM(LEFT(Name, FIND(",", Name) - 1))` produced a
// column of surnames badged NUMBER, right-aligned, offering numeric filter
// operators, sorted as numbers, exported as numbers, and totalling to nothing.
// Everything downstream of a column's type was wrong at once and none of it
// said so — a type is a claim about data, and this one was made by a constant.
//
// FIVE PROPERTIES, and the middle three are the ones that rot quietly:
//
//   1. THE REPORTED BUG. The surname split is a TEXT column. Asserted on the
//      real expression against a real sheet, not on a contrived vector.
//   2. NUMERIC STAYS NUMERIC. The fix is worthless if it wins the text case by
//      giving up the common one — `Value * Rate` must still be a number column,
//      with its right alignment, its number pattern and its total.
//   3. A NUMERIC-LOOKING STRING IS NOT A NUMBER. This is the check that keeps
//      finding 1 of the bounce test from coming back through a new door:
//      `aggregate` (grid.ts) skips anything that is not `typeof v === 'number'`,
//      so a column DECLARED number whose values are the strings "1,240.00"
//      reads as numeric everywhere and totals `SUM 0`. An inference that looked
//      at how values PRINT would manufacture exactly that state.
//   4. WHAT CANNOT BE DECIDED IS TEXT. Mixed values, all-error values and
//      import.ts's own documented `ambiguous` refusal all land on text, the one
//      type that makes no claim. Errors mixed INTO numbers are not evidence and
//      must not flip the column.
//   5. THE CALLER ACTUALLY CALLS IT. A rig can prove a function correct while
//      the feature is invisible on screen because nothing checks the call site.
//      `main.ts` and `panels.ts` are read for the constant that used to be
//      there and for the call that replaced it.
//
// And the interaction with the type/storage invariant is asserted rather than
// assumed: a computed column has no stored bytes, so `validate.ts` exempts it
// from `type-storage-mismatch` — which means an inference here can never make a
// document that trips it, in EITHER direction (a computed text column and a
// computed number column are both clean), while the same column without a
// formula is reported.

import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { parseDoc } = await import('../dash/src/model.ts')
const { validateDoc } = await import('../dash/src/validate.ts')
const { inferComputedType, judgeComputed } = await import('../dash/src/computedtype.ts')

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A sheet of named raw columns — the shape every check below asks about. */
const sheetOf = (cols: Record<string, unknown[]>, formulas: Array<[string, string]> = []): any => {
  const names = Object.keys(cols)
  const n = names.length ? cols[names[0]].length : 0
  return parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
    sheets: [{
      id: 's1', name: 'S', kind: 'table', rids: [[1, n]], nextRid: n + 1,
      columns: [
        ...names.map((k) => ({ id: k, name: k, type: 'text' })),
        ...formulas.map(([id, f]) => ({ id, name: id, type: 'number', formula: f })),
      ],
      data: Object.fromEntries(names.map((k) => [k, { enc: 'raw', v: cols[k] }])),
      steps: [],
    }],
  })).doc.sheets[0]
}

console.log('1 · the reported bug: a formula that returns text')
{
  // The exact expression from the bounce test, over the exact shape of data.
  const sheet = sheetOf({
    Name: ['Ashworth, Dean', 'Bell, Priya', '', 'Okonkwo, Ada'],
  })
  const got = inferComputedType(sheet, 'TRIM(LEFT(Name, FIND(",", Name) - 1))')
  ok(got.type === 'text',
    'splitting "Lastname, Firstname" makes a TEXT column (it was hardcoded to number)')
  ok(got.judged === 3,
    'and the blank row is not evidence either way — 3 values judged, not 4')
}

console.log('\n2 · a numeric formula is still a number column')
{
  const sheet = sheetOf({ Value: [10, 20, 30], Rate: [0.1, 0.2, 0.3] })
  ok(inferComputedType(sheet, 'Value * Rate').type === 'number',
    'Value * Rate is a number column — the common case is not sacrificed to the text one')
  ok(inferComputedType(sheet, 'Value > 15').type === 'bool',
    'a comparison is a bool column, which is a tick box rather than 0 and 1')
}

console.log('\n3 · a string that LOOKS numeric is not a number')
{
  // THE SUM 0 TRAP, arriving by a new door. If this inference read the
  // APPEARANCE of the values it would declare a number column whose every
  // value is a string, and `aggregate` would skip all of them.
  ok(judgeComputed(['1,240.00', '742.10', '980.5']).type === 'text',
    'numeric-looking STRINGS make a text column — declaring number here is the SUM 0 bug')
  ok(judgeComputed(['1240', '742', '980']).type === 'text',
    'and so do strings that need no cleaning at all: the JS type decides, not the digits')
  ok(judgeComputed([1240, 742, 980]).type === 'number',
    'while the same values as real numbers are a number column — the difference is the storage, ' +
    'which is exactly what totals read')
}

console.log('\n4 · what cannot be decided is text')
{
  ok(judgeComputed([1, 'two', 3]).why === 'mixed' && judgeComputed([1, 'two', 3]).type === 'text',
    'mixed numbers and strings have no single right answer, so: text')
  ok(judgeComputed([null, '', '   ']).type === 'text' && judgeComputed([null, '']).judged === 0,
    'nothing to judge is text, and says it judged nothing')

  // Errors are not evidence. Three #N/A rows in a numeric column do not make it
  // a text column — the plausible wrong answer, and the one that would retype a
  // working column the day a lookup misses.
  const sheet = sheetOf({ n: [4, 0, 5, 2] })
  const withErrs = inferComputedType(sheet, '10 / n')
  ok(withErrs.type === 'number',
    'a division by zero among the numbers leaves it a NUMBER column — errors are skipped, not counted')

  // import.ts's own "cannot decide": every value fits both DD/MM and MM/DD.
  ok(judgeComputed(['03/04/2026', '05/06/2026', '07/08/2026']).type === 'text',
    'import.ts’s ambiguous date refusal is honoured here too, rather than re-guessed')
  ok(judgeComputed(['2026-03-04', '2026-05-06', '2026-08-11']).type === 'date',
    'ISO date strings ARE a date column — the one date shape whose stored form is the string itself')
}

console.log('\n5 · the caller calls it')
{
  // THE CHECK THAT MAKES THE OTHERS MEAN SOMETHING. Everything above holds of a
  // pure function; none of it is visible on screen unless the two places that
  // create a formula column ask.
  const main = readFileSync(new URL('../dash/src/main.ts', import.meta.url), 'utf8')
  const panels = readFileSync(new URL('../dash/src/panels.ts', import.meta.url), 'utf8')
  ok(!/type: 'number', formula:/.test(main),
    'main.ts no longer hardcodes `type: \'number\', formula:` — the line the bug was')
  ok(/inferComputedType\(sheet, got\.expr\)\.type/.test(main),
    'the New-formula-column dialog types the column from the expression')
  ok(/inferComputedType\(sheet, got\.expr, col\.id\)/.test(main),
    'and editing an existing expression re-asks the question')
  ok(/inferComputedType\(sheet, next, col\.id\)/.test(panels),
    'as does the panel’s Formula field, which is the other way in')
}

console.log('\n6 · a computed column never trips the type/storage check')
{
  // BOTH DIRECTIONS. `validate.ts` skips any column carrying a formula, so no
  // inference this file can make is able to create the state it reports — and
  // the same column WITHOUT a formula is the negative control proving the check
  // is awake rather than that this document is uninteresting.
  const codes = (doc: any): string[] => validateDoc(doc).findings.map((f: any) => f.code)

  const computedText = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
    sheets: [{
      id: 's1', name: 'S', kind: 'table', rids: [[1, 2]], nextRid: 3,
      columns: [
        { id: 'a', name: 'A', type: 'text' },
        { id: 'f', name: 'F', type: 'number', formula: 'UPPER(A)' },
      ],
      data: { a: { enc: 'raw', v: ['x', 'y'] }, f: { enc: 'raw', v: ['X', 'Y'] } },
      steps: [],
    }],
  })).doc
  ok(!codes(computedText).includes('type-storage-mismatch'),
    'a COMPUTED column is exempt whatever its type says — it has no stored bytes to disagree with')

  const stored = JSON.parse(JSON.stringify(computedText))
  delete stored.sheets[0].columns[1].formula
  ok(codes(parseDoc(JSON.stringify(stored)).doc).includes('type-storage-mismatch'),
    'and the SAME column without the formula is reported — the check is awake, not asleep')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
