#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash function-pack rig — lookups, multi-criteria, finance, statistics.
//
//   node scripts/test-dash-functions.ts
//
// WHAT THIS PROVES. These are the functions people reach for when the answer
// MATTERS — a loan payment, an internal rate of return, a lookup joining two
// tables, a two-condition total in a board pack. Nobody re-derives them by
// hand, which means a wrong one is not caught by the person using it.
//
// So the checks below are mostly not "does it compute" but "does it REFUSE".
// The three failure shapes that actually bite:
//
//   AN APPROXIMATE MATCH ON UNSORTED DATA. VLOOKUP's legacy 4th argument
//   defaults to TRUE in Excel and returns a confidently wrong row. Ours
//   defaults to exact, and that difference is tested.
//   A MULTI-CRITERIA FILTER THAT ORs INSTEAD OF ANDs. The total still looks
//   like a total; it is just the wrong population.
//   AN IRR THAT CONVERGED ON NOTHING. Newton-Raphson returns a number for cash
//   flows that have no root. A refusal beats a plausible rate.

import { evaluate, isErr, FUNCTIONS, type Cell, type Vec } from '../dash/src/formula.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** Evaluate `src` over named columns; returns the first row's value. */
const ev = (src: string, cols: Record<string, Vec> = {}): Cell => {
  const map = new Map<string, Vec>()
  let n = 1
  for (const [k, v] of Object.entries(cols)) { map.set(k, v); n = Math.max(n, v.length) }
  return evaluate(src, { cols: map, n })[0] ?? null
}
const code = (v: Cell): string => (isErr(v) ? String(v) : `not an error (${JSON.stringify(v)})`)
const near = (v: Cell, want: number, eps = 1e-6): boolean =>
  typeof v === 'number' && Math.abs(v - want) < eps

const REGION = ['North', 'South', 'North', 'East', 'South']
const STAGE = ['Won', 'Open', 'Won', 'Open', 'Won']
const VALUE = [10, 20, 30, 40, 50]
const T = { region: REGION, stage: STAGE, value: VALUE }

// --------------------------------------------------------------- lookups
{
  ok(ev('XLOOKUP("East", region, value)', T) === 40, 'XLOOKUP finds the row and returns from the other column')
  ok(code(ev('XLOOKUP("West", region, value)', T)) === '#N/A', 'a miss is #N/A, not a nearby row')
  ok(ev('XLOOKUP("West", region, value, 0)', T) === 0, 'unless a not-found value was supplied')
  ok(ev('MATCH("North", region)', T) === 1, 'MATCH is 1-based, as Excel reports it')
  ok(code(ev('MATCH("West", region)', T)) === '#N/A', 'and a miss is #N/A')
  ok(ev('INDEX(value, 3)', T) === 30, 'INDEX takes the nth value')
  ok(code(ev('INDEX(value, 99)', T)) === '#REF!', 'past the end is #REF!, not the last row')
}
{
  // THE ONE THAT MATTERS. Excel's VLOOKUP defaults to an APPROXIMATE match, so
  // on unsorted data it returns whatever row the binary search lands on and
  // reports no problem at all.
  const unsorted = { k: ['Zebra', 'Apple', 'Mango'] as Vec, v: [1, 2, 3] as Vec }
  ok(code(ev('VLOOKUP("Cherry", k, 1)', unsorted)) === '#N/A',
    'a VLOOKUP miss on UNSORTED data is #N/A — exact is the default here, unlike Excel')
  ok(ev('VLOOKUP("Mango", k, 1)', unsorted) === 'Mango', 'an exact hit still works')
  ok(code(ev('VLOOKUP("Apple", k, 5)', unsorted)) === '#REF!',
    'a column index past the range is #REF!')
}

// ------------------------------------------------------- multi-criteria
{
  // North AND Won = rows 1 and 3 = 10 + 30 = 40.
  // An implementation that ORs gets 10+20+30+50 = 110 and looks just as tidy.
  ok(ev('SUMIFS(value, region, "North", stage, "Won")', T) === 40,
    'SUMIFS requires EVERY criterion — North AND Won, not North OR Won')
  ok(ev('COUNTIFS(region, "North", stage, "Won")', T) === 2, 'COUNTIFS counts the same population')
  ok(ev('AVERAGEIFS(value, region, "North")', T) === 20, 'AVERAGEIFS averages it')
  ok(ev('MINIFS(value, stage, "Won")', T) === 10, 'MINIFS takes the smallest of the matches')
  ok(ev('MAXIFS(value, stage, "Won")', T) === 50, 'and MAXIFS the largest')
  ok(ev('SUMIFS(value, value, ">25")', T) === 120, 'a comparison criterion works too (30+40+50)')
  ok(ev('SUMIFS(value, region, "Nowhere")', T) === 0, 'no matches sums to 0')
  ok(code(ev('AVERAGEIFS(value, region, "Nowhere")', T)) === '#DIV/0!',
    'but AVERAGING no matches is #DIV/0!, never 0 — an average of nothing is not zero')
}

// -------------------------------------------------------------- finance
{
  // £10,000 over 12 periods at 1% per period. Excel: PMT(0.01,12,10000)
  ok(near(ev('PMT(0.01, 12, 10000)'), -888.487887, 1e-4),
    'PMT matches Excel, and is NEGATIVE — a payment leaves the account')
  ok(near(ev('PMT(0, 12, 1200)'), -100), 'a zero rate divides evenly rather than dividing by zero')
  ok(near(ev('FV(0.01, 12, -100)'), 1268.250301, 1e-4), 'FV compounds a series of payments')
  ok(near(ev('PV(0.01, 12, -100)'), 1125.507747, 1e-4), 'PV discounts one')
  ok(near(ev('NPV(0.1, 100, 200, 300)'), 481.592787, 1e-4),
    'NPV discounts the first flow by ONE period, as Excel does')
}
{
  const flows = { f: [-1000, 300, 400, 500] as Vec }
  const r = ev('IRR(f)', flows)
  ok(near(r as Cell, 0.0885, 1e-3), 'IRR finds the rate where NPV is zero')
  // and the case that makes Newton-Raphson invent an answer
  const noRoot = { f: [100, 200, 300] as Vec }
  ok(isErr(ev('IRR(f)', noRoot)),
    'cash flows that never change sign have NO rate — that is #NUM!, not a number')
}

// ----------------------------------------------------------- statistics
{
  const s = { v: [2, 4, 4, 4, 5, 5, 7, 9] as Vec }
  ok(near(ev('VARP(v)', s), 4), 'VARP is the population variance')
  ok(near(ev('VAR(v)', s), 4.571428, 1e-5), 'VAR is the sample one (n−1) — a different number, not a rounding')
  ok(near(ev('STDEVP(v)', s), 2), 'STDEVP is its square root')
  ok(ev('MODE(v)', s) === 4, 'MODE is the most common value')
  ok(code(ev('MODE(v)', { v: [1, 2, 3] })) === '#N/A', 'with no repeat there is no mode — #N/A, not the first value')
  ok(ev('COUNTUNIQUE(region)', T) === 3, 'COUNTUNIQUE counts distinct values')
  ok(near(ev('PERCENTILE(v, 0.5)', s), 4.5), 'PERCENTILE interpolates, matching PERCENTILE.INC')
  ok(isErr(ev('PERCENTILE(v, 90)', s)),
    'and takes a FRACTION — 90 is #NUM! rather than being clamped to the maximum, which would answer a question nobody asked')
  ok(near(ev('CORREL(a, b)', { a: [1, 2, 3, 4], b: [2, 4, 6, 8] }), 1), 'CORREL of a perfect line is 1')
  ok(near(ev('CORREL(a, b)', { a: [1, 2, 3, 4], b: [8, 6, 4, 2] }), -1), 'and −1 inverted')
  ok(ev('RANK(30, value)', T) === 3, 'RANK is 1-based and descending by default')
}

// ---------------------------------------------------------------- logic
{
  ok(ev('TRUE()') === true && ev('FALSE()') === false,
    'TRUE() and FALSE() are functions — without them `IF(TRUE(), …)` took the FALSE branch, silently')
  ok(ev('IFS(FALSE(), "a", TRUE(), "b")') === 'b', 'IFS returns the first branch whose test holds')
  ok(code(ev('IFS(1>2, "a")')) === '#N/A', 'and #N/A when none does, rather than blank')
  ok(ev('SWITCH("b", "a", 1, "b", 2)') === 2, 'SWITCH matches a value')
  ok(ev('SWITCH("z", "a", 1, "b", 2, 99)') === 99, 'with a trailing default')
  ok(ev('XOR(1>0, 2>1)') === false, 'XOR of two truths is false')
  ok(ev('XOR(1>0, 2>3)') === true, 'and of one truth, true')
}

// ----------------------------------------------------------------- text
{
  ok(ev('PROPER("hello WORLD")') === 'Hello World', 'PROPER title-cases')
  ok(ev('REPT("ab", 3)') === 'ababab', 'REPT repeats')
  ok(isErr(ev('REPT("ab", -1)')), 'a negative count is an error rather than an empty string')
  ok(ev('TEXTJOIN(", ", TRUE(), region)', T) === 'North, South, North, East, South', 'TEXTJOIN joins a column')
  ok(ev('TEXTJOIN("-", TRUE(), a)', { a: ['x', '', 'y'] }) === 'x-y', 'and skips blanks when asked')
  ok(ev('TEXTJOIN("-", FALSE(), a)', { a: ['x', '', 'y'] }) === 'x--y', 'or keeps them when not')
}

// ---------------------------------------------------------------- dates
//
// Dates are ISO strings in dash, and every one of these computes in UTC. A
// local-timezone implementation moves a date across midnight for half the
// world, which is the kind of bug that only shows up in other people's files.
{
  ok(ev('DATE(2026, 2, 3)') === '2026-02-03', 'DATE builds an ISO date')
  ok(ev('DATE(2026, 13, 1)') === '2027-01-01', 'and rolls a 13th month into the next year')
  ok(ev('EOMONTH("2026-02-10", 0)') === '2026-02-28', 'EOMONTH finds the last day')
  ok(ev('EOMONTH("2024-02-10", 0)') === '2024-02-29', 'including a leap February')
  ok(ev('EDATE("2026-01-31", 1)') === '2026-03-03',
    'EDATE adds months arithmetically — 31 Jan + 1 month overflows, as JavaScript dates do')
  ok(ev('DAYS("2026-03-01", "2026-02-01")') === 28, 'DAYS counts between two dates')
  ok(ev('WEEKDAY("2026-08-05")') === 4, 'WEEKDAY is 1-based from Sunday')
  ok(isErr(ev('EOMONTH("not a date", 0)')), 'a non-date is an error rather than 1970')
}

// ---------------------------------------------------------- registration
{
  for (const f of ['XLOOKUP', 'VLOOKUP', 'MATCH', 'INDEX', 'SUMIFS', 'COUNTIFS',
    'IRR', 'NPV', 'PMT', 'PERCENTILE', 'CORREL', 'IFS', 'SWITCH', 'TEXTJOIN', 'EOMONTH',
    'TRUE', 'FALSE']) {
    ok(FUNCTIONS.includes(f), `${f} is in FUNCTIONS, so the editor can offer it`)
  }
  ok(new Set(FUNCTIONS).size === FUNCTIONS.length, 'and no name is registered twice')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
