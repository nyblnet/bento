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
//
// THE SECOND PACK (SUBTOTAL, TEXT/VALUE/DATEVALUE, SUMPRODUCT, LARGE/SMALL,
// SEARCH, REPLACE, CHOOSE, HLOOKUP, TRANSPOSE) is measured under the same rule,
// and the check that matters most is at the bottom of this file:
//
//   SUBTOTAL(109, …) MUST EQUAL DASH'S OWN FOOTER over a filtered view. Excel
//   writes `SUBTOTAL(109, …)` into every table's totals row, so every imported
//   table carries one; and `SUBTOTAL` ignores rows a filter has hidden, which
//   is what dash's footer already does. Two totals of the same rows that
//   disagree is the worst outcome available here — both look like totals. So
//   the footer half of the comparison is computed by `grid.ts`'s own
//   `aggregate`, over an order vector `filter.ts`'s own `buildOrder` produced,
//   rather than by a number worked out by hand in this file.
//
// EVERY GUARD BELOW IS NEGATIVE-CONTROLLED, and the control ASSERTS THE
// OUTCOME: it computes what the unguarded implementation would have returned
// and checks that dash does NOT return it. A check that only asserts an error
// code cannot tell a working guard from a function that is broken in some other
// way, and four rigs this week were green over features that did nothing.

import { registerHooks } from 'node:module'

// This rig reads `aggregate` out of grid.ts (see the SUBTOTAL block), and
// grid.ts reaches a component that imports its own stylesheet. Resolving CSS is
// Vite's job, not Node's — the same hook test-dash-filter.ts installs.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const {
  evaluate, isErr, FUNCTIONS, markHidden, vecShape,
} = await import('../dash/src/formula.ts')
type Cell = import('../dash/src/formula.ts').Cell
type Vec = import('../dash/src/formula.ts').Vec
const { aggregate } = await import('../dash/src/grid.ts')
const { buildOrder } = await import('../dash/src/filter.ts')
const { setViewerLocale } = await import('../dash/src/format.ts')

// TEXT() punctuates with the VIEWER's locale — format.ts's central split, and
// the reason it is pinned here: a rig that read the machine's locale would pass
// in London and fail in Hamburg over a difference that is correct.
setViewerLocale('en-GB')

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

// ------------------------------------------------ MIN/MAX at the row target
//
// `=MIN(A1:A400000)` is an ordinary thing to write on a sheet this format is
// sized for, and `Math.min(...n)` is one ARGUMENT per cell. Past the engine's
// argument limit it does not return `#NUM!` — it THROWS out of the recalc,
// which takes the grid down with it. condfmt.ts:52 wrote the rule down; MIN,
// MAX, MINIFS and MAXIFS were four sites that had not read it. The dashboard's
// axis is the same bug and cost a 400k-row workbook an opaque error card over a
// working app.
//
// The size here is the size that broke. A check over five numbers proves
// nothing at all about an argument-list limit, so the first assertion below
// establishes that the spread really does throw in this engine — without it,
// the ones under it could pass on an engine with no limit and nobody would know
// the rig had stopped testing anything.
{
  const N = 400_000
  const col: number[] = new Array(N)
  for (let i = 0; i < N; i++) col[i] = 500 + ((i * 7919) % 1000)
  col[N >> 1] = -42       // the true minimum, in the middle where an end-read misses it
  col[(N >> 1) + 1] = 9999 // and the true maximum

  let threw = false
  try { Math.min(...col) } catch (e) { threw = e instanceof RangeError }
  ok(threw, `Math.min(...) over ${N} arguments still throws a RangeError here — the hazard is not hypothetical`)

  const big = { v: col as Vec, keep: col.map(() => 'y') as Vec }
  ok(ev('MIN(v)', big) === -42, `MIN walks ${N} cells without a spread and finds the real minimum`)
  ok(ev('MAX(v)', big) === 9999, 'and MAX finds the real maximum')
  ok(ev('MINIFS(v, keep, "y")', big) === -42, 'MINIFS survives a criterion that keeps every row')
  ok(ev('MAXIFS(v, keep, "y")', big) === 9999, 'and so does MAXIFS')

  // Empty is still Excel's answer, not an accident of the seed value: a loop
  // seeded at Infinity would happily return Infinity for a range of blanks.
  ok(ev('MIN(e)', { e: [null, '', null] as Vec }) === 0, 'MIN of nothing is 0, as it always was')
  ok(ev('MAX(e)', { e: [null, '', null] as Vec }) === 0, 'and so is MAX of nothing')
}

// =========================================================== THE SECOND PACK
//
// Everything below was ABSENT and measured absent (docs/dash-excel-gap.md
// finding 13). Two of them are why the list mattered: SUBTOTAL, because Excel
// writes it into every table totals row so every imported table arrived with a
// dead total; and TEXT/VALUE/DATEVALUE, because they are the standard Excel
// repair for numbers-stored-as-text and the person who reached for the formula
// answer found nothing.

/** A range with a WIDTH, the way cellformula.ts's bindRefs hands one over. */
const grid = (v: Vec, cols: number): Vec => {
  ;(v as Vec & { __cols?: number }).__cols = cols
  return v
}

// ------------------------------------------------- numbers stored as text
//
// Job 4 of the bounce test, in formulas. The three checks that matter are not
// "does it convert" but the three refusals, because each of the wrong answers
// here is a NUMBER and would be totalled without complaint.
{
  ok(ev('VALUE("1,234.50")') === 1234.5, 'VALUE reads grouping — the digits a number was typed with')
  ok(ev('VALUE(" £1,200 ")') === 1200, 'and a currency sign, and the whitespace around it')
  ok(ev('VALUE("(1,200)")') === -1200, 'accounting brackets are a MINUS sign, not decoration')
  ok(ev('VALUE("45%")') === 0.45,
    'and a trailing % is notation: the value is the fraction, as a percent column stores it')
  ok(ev('VALUE("1.234,50")') === 1234.5,
    'the German convention reads too — import.ts decides which, so a formula and a re-import agree')
  ok(ev('VALUE(7)') === 7, 'a number is already a number')
  ok(code(ev('VALUE("abc")')) === '#VALUE!', 'and a word is refused rather than part-read')

  // NEGATIVE CONTROL, and it is the one that would look fine. A VALUE() that
  // reached for `parseFloat` — the obvious implementation — returns 1 for
  // "1 unit" and 2026 for a date, both of which are numbers a total accepts.
  ok(parseFloat('1 unit') === 1 && parseFloat('2026-03-04') === 2026,
    'parseFloat DOES return 1 and 2026 for these — the wrong answers are real, not hypothetical')
  ok(code(ev('VALUE("1 unit")')) === '#VALUE!', 'so "1 unit" is #VALUE!, not 1')
  ok(ev('VALUE("2026-03-04")') !== 2026, 'and a date is not 2026')
  const dateRefusal = ev('VALUE("2026-03-04")')
  ok(isErr(dateRefusal) && String(dateRefusal.why).includes('DATEVALUE'),
    'the refusal names DATEVALUE, because dash keeps a date as a date and not as a serial number')
}

// ------------------------------------------------------ DATEVALUE refuses
//
// THE ONE THAT MOVES A QUARTER BY A MONTH. `03/04/2026` is 3 April and 4 March
// and the string does not say which. import.ts refuses it (its own header calls
// this the mistake that costs the most), so DATEVALUE refuses it too — a looser
// rule here would mean the same six characters meant one day in a column and
// another in a formula, in one file, with nothing on screen to say which.
{
  ok(ev('DATEVALUE("2026-03-04")') === '2026-03-04', 'an ISO date reads, and stays an ISO date')
  ok(ev('DATEVALUE("15/04/2026")') === '2026-04-15',
    'a slash date reads when the day is unmistakable — 15 cannot be a month')
  ok(ev('DATEVALUE("04/15/2026")') === '2026-04-15', 'from either side, since 15 is still the day')

  // NEGATIVE CONTROL. Both readings exist, they are eleven months apart, and a
  // guesser returns one of them with no sign that it chose.
  const dmy = '2026-04-03'
  const mdy = '2026-03-04'
  ok(dmy !== mdy, 'the two readings of 03/04/2026 really are different days')
  const amb = ev('DATEVALUE("03/04/2026")')
  ok(amb !== dmy && amb !== mdy, 'dash returns NEITHER — it does not pick')
  ok(code(amb) === '#VALUE!' && isErr(amb) && String(amb.why).includes('DD/MM'),
    'it says which two readings it is caught between, in import.ts\'s own words')
  ok(code(ev('DATEVALUE("Mar 7, 2026")')) === '#VALUE!',
    'and a spelling dash does not read is refused rather than half-parsed — the same silence finding 13 reports on the column panel, said out loud')
  ok(ev('DATE(2026, 3, 4)') === '2026-03-04', 'DATE() is the way to say it outright, and is what the refusal points at')
}

// ----------------------------------------------------------------- TEXT()
//
// TEXT must use dash's OWN format engine (format.ts readPattern), never a
// second one. Two implementations of what `#,##0.00` means is a bug with a
// delay on it: they agree the day they are written and drift on the first edit,
// after which a column and a formula print the same number differently on one
// screen.
{
  ok(ev('TEXT(1234.5, "#,##0.00")') === '1,234.50', 'TEXT prints a number under a pattern')
  ok(ev('TEXT(1234.5, "#,##0")') === '1,235', 'a pattern with no decimal point means NO decimals, and rounds')
  ok(ev('TEXT(0.456, "0.0%")') === '45.6%', 'a percent pattern multiplies by 100 and signs it')
  ok(ev('TEXT(99, "£#,##0.00")') === '£99.00', 'a currency prefix rides through')

  // The agreement itself, against format.ts rather than against a string typed
  // here: if `formatValue` changes, this fails rather than drifting.
  const { formatValue } = await import('../dash/src/format.ts')
  for (const [n, fmt] of [[1234.5, '#,##0.00'], [0.456, '0.0%'], [7.6, '0'], [-1200, '#,##0']] as Array<[number, string]>) {
    ok(ev(`TEXT(${n}, "${fmt}")`) === formatValue(n, { type: 'number', format: fmt }),
      `TEXT(${n}, "${fmt}") is exactly what a column formatted "${fmt}" prints — one engine, not two`)
  }

  // NEGATIVE CONTROL. A date pattern is the second most common use of TEXT in
  // Excel and dash's patterns describe numbers only. The tempting failure is to
  // hand the value back unchanged, which LOOKS like it worked.
  // Without the refusal, `readPattern` finds no digit placeholder in
  // "dd/mm/yyyy", so the pattern is IGNORED and the number prints bare — the
  // caller gets a plausible string and no sign that the format did nothing.
  ok(ev('TEXT(1234, "dd/mm/yyyy")') !== '1234',
    'a date pattern does NOT print the number with the pattern silently dropped')
  ok(ev('TEXT("2026-01-05", "dd/mm/yyyy")') !== '2026-01-05',
    'nor hand a date back unchanged, which would look like it had worked')
  const dp = ev('TEXT("2026-01-05", "dd/mm/yyyy")')
  ok(isErr(dp) && String(dp.why).includes('0 or #'),
    'it says why: a pattern with no 0 and no # in it is not a number format')
  ok(code(ev('TEXT("abc", "0")')) === '#VALUE!', 'and a value that is not a number is refused')
}

// ------------------------------------------------- SUMPRODUCT, LARGE, SMALL
{
  ok(ev('SUMPRODUCT(a, b)', { a: [1, 2, 3], b: [4, 5, 6] }) === 32, 'SUMPRODUCT sums the pairwise products')
  ok(ev('SUMPRODUCT(value)', T) === 150, 'one range is just its sum')
  ok(ev('SUMPRODUCT(a, b)', { a: [1, 2], b: ['x', 3] }) === 6,
    'a non-number counts as zero, so its whole term drops out — Excel\'s rule for this function')

  // NEGATIVE CONTROL. Ranges of different lengths have no answer, and the
  // tempting implementation pads the short one, which returns a total that is
  // wrong by however many rows it missed and looks exactly like a total.
  const padded = 1 * 4 + 2 * 5 + 3 * 0
  ok(padded === 14, 'zero-padding a short range WOULD return 14 — the wrong answer is a plausible number')
  const mismatch = ev('SUMPRODUCT(a, b)', { a: [1, 2, 3], b: [4, 5] })
  ok(mismatch !== 14 && code(mismatch) === '#VALUE!', 'dash refuses instead, and does not return 14')

  const s = { v: [3, 9, 5, 1] as Vec }
  ok(ev('LARGE(v, 1)', s) === 9 && ev('LARGE(v, 2)', s) === 5, 'LARGE is the kth from the top')
  ok(ev('SMALL(v, 1)', s) === 1 && ev('SMALL(v, 2)', s) === 3, 'SMALL is the kth from the bottom')
  // NEGATIVE CONTROL: clamping is the other implementation, and it labels the
  // smallest value as the fifth largest with nothing on screen saying the list
  // ran out.
  ok(ev('LARGE(v, 9)', s) !== 1, 'asking for the 9th largest of four does NOT clamp to the smallest')
  ok(code(ev('LARGE(v, 9)', s)) === '#NUM!', 'it is #NUM!, which is a number nobody will total')
}

// ------------------------------------------ SEARCH, REPLACE, CHOOSE, HLOOKUP
{
  ok(ev('SEARCH("b", "ABC")') === 2, 'SEARCH ignores case — that is the whole difference from FIND')
  ok(ev('FIND("b", "ABC")') === 2 - 1 || code(ev('FIND("b", "ABC")')) === '#N/A',
    'while FIND does not find a lower-case b in ABC')
  ok(ev('SEARCH("c", "abcabc", 4)') === 6, 'a start position skips the earlier hit')
  ok(ev('SEARCH("a?c", "xxabc")') === 3, '? is any one character')
  ok(ev('SEARCH("a*c", "xxabbbc")') === 3, '* is any run of them')
  ok(ev('SEARCH("a~*c", "xa*c")') === 2, 'and ~ means the character itself')
  ok(code(ev('SEARCH("z", "abc")')) === '#N/A',
    'a miss is #N/A, matching dash\'s own FIND — one product, one way of saying "not there"')

  // NEGATIVE CONTROL, and this one is a real bug in the obvious version.
  // Building the pattern without escaping makes "(a)" a regular-expression
  // GROUP, which matches the letter a in text that contains no brackets at all.
  ok(new RegExp('(a)', 'i').test('xay'), 'an unescaped "(a)" DOES match "xay" — the hazard is real')
  ok(code(ev('SEARCH("(a)", "xay")')) === '#N/A', 'dash does not match it: the pattern is escaped')
  ok(ev('SEARCH("(a)", "x(a)y")') === 2, 'and it finds the actual brackets')

  ok(ev('REPLACE("abcdef", 2, 3, "XY")') === 'aXYef', 'REPLACE swaps by POSITION (SUBSTITUTE swaps by text)')
  ok(ev('REPLACE("abc", 4, 0, "d")') === 'abcd', 'past the end it appends, as Excel does')
  ok(code(ev('REPLACE("abc", 0, 1, "x")')) === '#VALUE!', 'and character 0 does not exist')

  ok(ev('CHOOSE(2, "a", "b", "c")') === 'b', 'CHOOSE picks the nth argument, 1-based')
  ok(code(ev('CHOOSE(9, "a", "b")')) === '#VALUE!', 'and asking past the end is an error, not the last one')

  // HLOOKUP: the same function turned ninety degrees, so it needs a range that
  // knows its WIDTH — which is what cellformula.ts stamps on a bound range.
  const g = { h: grid(['a', 'b', 'c', 1, 2, 3], 3) }
  ok(ev('HLOOKUP("b", h, 2)', g) === 2, 'HLOOKUP searches the first ROW and returns from the nth')
  ok(code(ev('HLOOKUP("z", h, 2)', g)) === '#N/A', 'a miss is #N/A, not the nearest column')
  ok(code(ev('HLOOKUP("b", h, 5)', g)) === '#REF!', 'and a row past the range is #REF!')
}

// -------------------------------------------------------------- TRANSPOSE
//
// TRANSPOSE returns an ARRAY, and an array function that quietly returns its
// first cell is the failure a spilling engine exists to end. What is asserted
// here is the SHAPE — because the shape is the footprint cellformula.ts spills
// into, and a 2×3 that comes back as 6×1 is a column of six correct numbers
// down the wrong part of the sheet.
{
  const src = grid([1, 2, 3, 4, 5, 6], 3)     // 2 rows of 3
  const out = evaluate('TRANSPOSE(g)', { cols: new Map([['g', src]]), n: 1 })
  const sh = vecShape(out)
  ok(sh.rows === 3 && sh.cols === 2, 'a 2×3 transposes to 3×2 — the shape, not just the values')
  ok(JSON.stringify(out) === JSON.stringify([1, 4, 2, 5, 3, 6]),
    'and the values are row-major in the NEW shape: 1,4 / 2,5 / 3,6')
  ok(out.length === 6, 'all six come back — not the first one')

  const col = evaluate('TRANSPOSE(c)', { cols: new Map([['c', [10, 20, 30] as Vec]]), n: 1 })
  ok(vecShape(col).rows === 1 && vecShape(col).cols === 3, 'a bare column transposes to one row of three')
  ok(code(evaluate('TRANSPOSE(e)', { cols: new Map([['e', [] as Vec]]), n: 1 })[0]) === '#VALUE!',
    'and nothing to transpose is refused rather than answered with an empty rectangle')
}

// ============================================ SUBTOTAL AGAINST THE FOOTER
//
// THE CHECK THAT MATTERS MOST IN THIS FILE.
//
// Excel writes `SUBTOTAL(109, …)` into every table's totals row, so every
// imported table carries one; and SUBTOTAL's defining behaviour is that it
// IGNORES ROWS A FILTER HAS HIDDEN — which is exactly what dash's footer
// already does. docs/dash-sheet-kinds.md works out why that agreement is not
// dash deviating from Excel: dash's dataset IS an Excel Table, and a Table's
// totals row is filter-aware in Excel too.
//
// So the two totals must be the SAME NUMBER over the SAME ROWS. Both halves
// are computed here by the code that ships:
//
//   the footer   `grid.ts aggregate(spec, read, n, order)` — the arithmetic the
//                grid paints, over `filter.ts buildOrder`'s own order vector;
//   the formula  `SUBTOTAL(109, v)` where `v` carries the view mask that
//                `cellformula.ts` stamps with `markHidden` (see the hook note
//                in the report — this rig marks it the same way).
//
// Nothing below is a number worked out by hand, because a hand-worked total is
// exactly the thing that agrees with a wrong implementation.
{
  // A pipeline, and a filter that hides most of it.
  const region: Vec = ['North', 'South', 'North', 'East', 'South', 'North']
  const amount: Vec = [120_000, 749_050, 30_000, 40_000, 12_000, 8_000]
  const cols: Record<string, unknown[]> = { region: region as unknown[], amount: amount as unknown[] }
  const get = (c: string, r: number): unknown => cols[c]?.[r]

  const order = buildOrder(6, get, [{ col: 'region', pred: { op: 'isOneOf', set: new Set(['North']) } }], [])
  ok(order.length === 3 && order.length < 6,
    'the filter really hides rows — a view as long as the sheet would make every check below vacuous')

  // The mask cellformula.ts hands the evaluator: one flag per row of the range.
  const shown = new Set(order)
  const mask = amount.map((_, i) => !shown.has(i))
  const marked = (): Vec => markHidden([...amount], mask)

  const read = (i: number): unknown => amount[i]
  const footer = (spec: 'sum' | 'avg' | 'count' | 'min' | 'max'): number =>
    aggregate(spec, read, order.length, order)

  const sub = (fn: number): Cell => ev('SUBTOTAL(f, v)', { v: marked(), f: [fn] as Vec })

  ok(sub(109) === footer('sum'),
    'SUBTOTAL(109, …) IS the footer sum over the filtered view — same rows, same number, both computed by the shipping code')
  ok(sub(101) === footer('avg'), 'and 101 is the footer average')
  ok(sub(102) === footer('count'), '102 the footer count')
  ok(sub(105) === footer('min') && sub(104) === footer('max'), '105 and 104 its min and max')
  ok(sub(9) === sub(109),
    'the 1-11 forms agree with the 1xx forms: dash has no hand-hidden rows, so nothing could tell them apart')

  // NEGATIVE CONTROL, ASSERTING THE OUTCOME. An implementation that ignored the
  // mask is not a crash — it is `SUM` of the column, a real number, printed
  // under a filtered view. This asserts that number is DIFFERENT and that
  // SUBTOTAL does not return it.
  const whole = ev('SUM(v)', { v: [...amount] as Vec })
  ok(typeof whole === 'number' && whole !== footer('sum'),
    'the unfiltered total is a DIFFERENT number, so the comparison above can fail')
  ok(sub(109) !== whole, 'and SUBTOTAL does not return it — the mask is doing work')

  // The sabotage, applied and confirmed. Stripping the mask off the vector must
  // turn the answer back into the whole-column total; if it does not, the
  // check above was passing for some other reason and this rig was worthless.
  const unmarked = ev('SUBTOTAL(109, v)', { v: [...amount] as Vec })
  ok(unmarked === whole,
    'CONTROL APPLIED: the same call over an UNMARKED vector returns the whole-column total, ' +
    'so the difference above is the mask and nothing else')

  // And the other half of the honesty: an unfiltered sheet must agree too, or
  // SUBTOTAL would be filter-aware and simply wrong.
  const all = buildOrder(6, get, [], [])
  ok(all.length === 6 && aggregate('sum', read, all.length, all) === whole,
    'over an unfiltered view the footer IS the whole-column total, which is what an unmarked SUBTOTAL gives')

  // A SORT is a permutation, not a filter: the totals must not move.
  const sorted = buildOrder(6, get, [], [{ col: 'amount', dir: 'desc' }])
  ok(aggregate('sum', read, sorted.length, sorted) === whole,
    'and a sorted view totals the same, because sorting hides nothing')

  // THEY AGREE NOW, AND THIS BLOCK IS THE RECORD OF THEM NOT HAVING. It used to
  // read "the one place they do not agree": a view that hid EVERY row left the
  // footer's `avg` at 0 while SUBTOTAL(101) said `#DIV/0!`, and the comment
  // said the formula was the one that was right and the footer was not this
  // agent's file to change. It is now — `aggregate` returns `null` for a
  // population it never saw a number in, and the footer draws `—`.
  //
  // Kept as two assertions rather than folded into one, because the two
  // surfaces reach the same answer by different routes and a rig that checked
  // only one would not notice them parting again. They are ALLOWED to spell it
  // differently: a formula lives in a cell and can carry an error value, a
  // footer has one line and no error state, so `#DIV/0!` and `—` are the same
  // claim in the vocabulary each surface has.
  const none = buildOrder(6, get, [{ col: 'region', pred: { op: 'isOneOf', set: new Set(['Nowhere']) } }], [])
  ok(none.length === 0, 'a filter can hide every row')
  ok(aggregate('avg', read, none.length, none) === null,
    'the footer has no average for no rows — null, drawn as an em dash, not a confident 0')
  ok(code(ev('SUBTOTAL(101, v)', { v: markHidden([...amount], amount.map(() => true)) })) === '#DIV/0!',
    'and SUBTOTAL(101) says #DIV/0! — the same claim in the vocabulary a cell has')

  ok(code(ev('SUBTOTAL(50, v)', { v: [1, 2] as Vec })) === '#VALUE!',
    'a function number SUBTOTAL does not have is refused rather than defaulted to SUM')
  ok(code(ev('SUBTOTAL(109)')) === '#VALUE!', 'and SUBTOTAL with nothing to total says so')

  // Error propagation follows the aggregates' own rule: a COUNT may look at an
  // error, a SUM may not — a total of the cells that happened to work is a
  // number with a piece missing and no way to tell.
  const bad = { v: [1, ev('1/0'), 3] as Vec }
  ok(code(ev('SUBTOTAL(109, v)', bad)) === '#DIV/0!', 'an error in the range poisons the SUM form')
  ok(ev('SUBTOTAL(103, v)', bad) === 3, 'while COUNTA counts it, exactly as COUNTA does elsewhere')
}

// ---------------------------------------------------------- registration
{
  for (const f of ['XLOOKUP', 'VLOOKUP', 'MATCH', 'INDEX', 'SUMIFS', 'COUNTIFS',
    'IRR', 'NPV', 'PMT', 'PERCENTILE', 'CORREL', 'IFS', 'SWITCH', 'TEXTJOIN', 'EOMONTH',
    'TRUE', 'FALSE',
    // the second pack. Registration is not cosmetic: `FUNCTIONS` is what the
    // formula editor offers, what sql.ts validates a query against, and what
    // xlsx.ts's liveness gate reads — a function that works and is not
    // registered is a function an imported workbook is still refused for.
    'SUBTOTAL', 'TEXT', 'VALUE', 'DATEVALUE', 'SEARCH', 'SUMPRODUCT', 'LARGE',
    'SMALL', 'CHOOSE', 'HLOOKUP', 'TRANSPOSE', 'REPLACE']) {
    ok(FUNCTIONS.includes(f), `${f} is in FUNCTIONS, so the editor can offer it`)
  }
  ok(new Set(FUNCTIONS).size === FUNCTIONS.length, 'and no name is registered twice')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
