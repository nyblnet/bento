#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash formula rig.
//
//   node scripts/test-dash-formula.ts
//
// WHAT THIS PROVES. A spreadsheet's job is arithmetic, so a wrong answer here
// is the worst failure the app has — and the dangerous ones are not crashes,
// they are plausible numbers:
//
//   1. AN ERROR THAT BECOMES A ZERO. Divide by zero, reference a name that does
//      not exist, put text in a number column — every one must surface as an
//      error the reader can see. Zero is a number; a total containing silent
//      zeros is wrong and looks right.
//   2. A CYCLE THAT RESOLVES. A refers to B refers to A must report #CYCLE!,
//      not settle on whatever the evaluator happened to compute first.
//   3. STALE ORDER. If a formula column is computed before the column it
//      depends on, it reads that column's OLD values — right shape, wrong
//      numbers, and only on some recalculations.

import { evaluate, recalc, dependencies, isErr, FUNCTIONS, type EvalCtx, type Vec } from '../dash/src/formula.ts'
import type { TableSheet } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const ctx = (cols: Record<string, Vec>, n: number): EvalCtx => {
  const m = new Map<string, Vec>()
  for (const [k, v] of Object.entries(cols)) { m.set(k, v); m.set(k.toLowerCase(), v) }
  return { cols: m, n, now: '2026-08-03T00:00:00.000Z' }
}
const one = (src: string, cols: Record<string, Vec> = {}, n = 1) => evaluate(src, ctx(cols, n))[0]

// ------------------------------------------------------------- arithmetic
ok(one('1+2*3') === 7, 'precedence: 1+2*3 is 7')
ok(one('(1+2)*3') === 9, 'parentheses group')
ok(one('2^3^2') === 512, '^ is right-associative (2^(3^2)), as in Excel')
ok(one('-3+5') === 2, 'unary minus')
ok(one('10/4') === 2.5, 'division')
ok(one('"a"&"b"') === 'ab', '& concatenates')
ok(one('1=1') === true && one('1<>2') === true, 'comparisons')
ok(one('2<10') === true, 'numeric comparison is numeric, not lexical')

// ------------------------------------------------- errors, never zeroes
ok(isErr(one('1/0')), 'divide by zero is an ERROR, not Infinity and not 0')
ok(String(one('1/0')) === '#DIV/0!', 'and it says which error')
ok(isErr(one('NOPE(1)')), 'an unknown function is #NAME?')
ok(isErr(one('Missing+1')), 'an unknown column reference is an error')
ok(isErr(one('1+"abc"')), 'text where a number is required is #VALUE!')
ok(String(one('1/0+5')) === '#DIV/0!', 'errors PROPAGATE through arithmetic')
ok(one('IFERROR(1/0, 99)') === 99, 'IFERROR catches one')
ok(one('SUM(a)', { a: [1, 2, 3] }, 3) === 6, 'and a clean SUM still works')

// the assertion an implementation that coerces errors to 0 fails
ok(!(one('1/0') === 0), 'a division by zero is NOT silently zero')

// ------------------------------------------------------------- vectorised
{
  const v = evaluate('Price * Qty', ctx({ Price: [10, 20, 30], Qty: [1, 2, 3] }, 3), )
  ok(JSON.stringify(v) === JSON.stringify([10, 40, 90]), 'column * column is elementwise')
  const w = evaluate('Price * 2', ctx({ Price: [10, 20] }, 2))
  ok(JSON.stringify(w) === JSON.stringify([20, 40]), 'column * scalar broadcasts')
  // the one that needs both: a share-of-total
  const s = evaluate('Value / SUM(Value)', ctx({ Value: [25, 75] }, 2))
  ok(JSON.stringify(s) === JSON.stringify([0.25, 0.75]),
    'a column divided by an AGGREGATE of itself — the mix vectorisation exists for')
}

// -------------------------------------------------------------- functions
ok(one('ROUND(2.345, 2)') === 2.35, 'ROUND to 2dp')
ok(one('ROUND(2.5, 0)') === 3, 'ROUND(2.5) is 3, not 2 — Excel rounds half away from zero')
ok(one('ABS(-4)') === 4, 'ABS')
ok(one('MOD(7,3)') === 1, 'MOD')
ok(isErr(one('MOD(7,0)')), 'MOD by zero is an error')
ok(one('IF(1>2,"y","n")') === 'n', 'IF')
ok(one('AND(TRUE,FALSE)') === false && one('OR(TRUE,FALSE)') === true, 'AND / OR')
ok(one('LEN("hello")') === 5, 'LEN')
ok(one('UPPER("ab")') === 'AB' && one('LEFT("hello",2)') === 'he', 'text functions')
ok(one('RIGHT("hello",2)') === 'lo', 'RIGHT')
ok(one('TRIM("  a   b ")') === 'a b', 'TRIM collapses internal runs too')
ok(one('SUBSTITUTE("a-b","-","+")') === 'a+b', 'SUBSTITUTE')
ok(one('YEAR("2026-08-03")') === 2026 && one('MONTH("2026-08-03")') === 8, 'date parts')
ok(one('MEDIAN(a)', { a: [1, 3, 2] }, 3) === 2, 'MEDIAN')
ok(one('MEDIAN(a)', { a: [1, 2, 3, 4] }, 4) === 2.5, 'MEDIAN of an even count averages the middle two')
ok(one('COUNTA(a)', { a: [1, null, 'x', ''] }, 4) === 2, 'COUNTA ignores blanks')
ok(one('SUMIF(r,">10",v)', { r: [5, 20, 30], v: [1, 2, 3] }, 3) === 5, 'SUMIF with a comparison')
ok(one('COUNTIF(r,"North")', { r: ['North', 'South', 'North'] }, 3) === 2, 'COUNTIF with a literal')
ok(one('AVERAGEIF(r,">1",v)', { r: [1, 2, 3], v: [10, 20, 30] }, 3) === 25, 'AVERAGEIF')
ok(FUNCTIONS.length >= 45, `the library covers ${FUNCTIONS.length} functions`)

// ------------------------------------------------------------- volatiles
ok(one('TODAY()') === '2026-08-03',
  'TODAY() is FROZEN from the context — a saved file shows the same date to everyone')

// -------------------------------------------------------------- bracketed
ok(one('[Unit Price] * 2', { 'Unit Price': [21] }, 1) === 42,
  'a column whose name has spaces is referenced with [brackets]')

// ----------------------------------------------------------- dependencies
{
  const d = dependencies('Price * Qty + SUM(Tax)')
  ok(d.includes('Price') && d.includes('Qty') && d.includes('Tax') && d.length === 3,
    'dependencies finds every referenced column and nothing else')
  ok(!dependencies('1 + 2').length, 'a constant expression depends on nothing')
}

// ------------------------------------------------------- recalc ORDERING
const sheet = (cols: Array<{ id: string; name: string; formula?: string }>, data: Record<string, number[]>): TableSheet => ({
  id: 'sh', name: 'S', kind: 'table',
  rids: [[1, Object.values(data)[0]?.length ?? 0]],
  columns: cols.map((c) => ({ ...c, type: 'number' as const })),
  data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { enc: 'raw' as const, v }])),
  steps: [],
})

{
  // net depends on gross, gross depends on price — declared in the WRONG order
  const s = sheet(
    [
      { id: 'net', name: 'net', formula: 'gross * 0.8' },
      { id: 'gross', name: 'gross', formula: 'price * 2' },
      { id: 'price', name: 'price' },
    ],
    { price: [10, 20] },
  )
  const r = recalc(s)
  ok(r.order.indexOf('gross') < r.order.indexOf('net'),
    'recalc orders dependencies first, regardless of declaration order')
  ok(JSON.stringify(r.values.get('gross')) === JSON.stringify([20, 40]), 'gross computes')
  ok(JSON.stringify(r.values.get('net')) === JSON.stringify([16, 32]),
    'and net uses the FRESH gross — not the stale column, which would give 0')
  ok(r.cycles.length === 0, 'no cycles reported')
}

// --------------------------------------------------------------- cycles
{
  const s = sheet(
    [{ id: 'a', name: 'a', formula: 'b + 1' }, { id: 'b', name: 'b', formula: 'a + 1' }],
    { seed: [1] },
  )
  const r = recalc(s)
  ok(r.cycles.length === 2, 'a two-column cycle is detected')
  ok(isErr(r.values.get('a')![0]) && String(r.values.get('a')![0]) === '#CYCLE!',
    'and both columns read #CYCLE! rather than a plausible number')
}
{
  // self-reference
  const s = sheet([{ id: 'a', name: 'a', formula: 'a + 1' }], { seed: [1] })
  ok(recalc(s).cycles.length === 1, 'a self-reference is a cycle')
}
{
  // a long chain must NOT be mistaken for a cycle
  const s = sheet(
    [
      { id: 'd', name: 'd', formula: 'c + 1' }, { id: 'c', name: 'c', formula: 'b + 1' },
      { id: 'b', name: 'b', formula: 'a + 1' }, { id: 'a', name: 'a' },
    ],
    { a: [0] },
  )
  const r = recalc(s)
  ok(r.cycles.length === 0 && r.values.get('d')![0] === 3,
    'a four-deep chain resolves to 3, and is not reported as a cycle')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
