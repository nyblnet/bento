#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Magic notes — the evaluator.
//
//   node scripts/test-spaces-calc.ts
//   TZ=Pacific/Kiritimati node scripts/test-spaces-calc.ts
//
// TWO FAILURE MODES, and the second is the one that would make the feature
// worse than not having it:
//
//  1. A WRONG ANSWER. Silent, confident, and in somebody's notes — the number
//     they then act on. Float dust (0.1+0.2), a bad conversion, a percentage
//     read the wrong way round.
//
//  2. AN ANSWER WHERE THERE SHOULD BE NONE. "Meet Ana at 3" is a sentence.
//     "We shipped 3 of 7" is a sentence. A calculator that answers those has
//     made the app noisier for everyone who is only writing. So the parser
//     must consume the WHOLE line or return nothing — a partial parse is a
//     refusal, not a result.
//
// Dates run under several TZ values in CI for the reasons journal.ts records:
// a date test that only runs in one timezone has not been run.

import { evaluate, answer, format, definition, asksForAnswer, feed, freshContext, type Val, type CalcCtx } from '../spaces/src/calc.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
}
/** `expr` → formatted answer, with an en-GB locale so the digits are stable */
const A = (src: string, ctx: CalcCtx = {}) => {
  const v = evaluate(src, ctx)
  return v ? format(v, 'en-GB') : null
}
const is = (src: string, want: string, ctx: CalcCtx = {}) =>
  ok(A(src, ctx) === want, `${src} → ${want}   (got ${A(src, ctx)})`)
const none = (src: string, ctx: CalcCtx = {}) =>
  ok(A(src, ctx) === null, `${src} → no answer   (got ${A(src, ctx)})`)

console.log(`magic notes — the evaluator   (TZ=${process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone})\n`)

// ---- arithmetic -------------------------------------------------------------
is('2 + 2', '4')
is('1200 * 1.2', '1,440')
is('(3 + 4) / 2', '3.5')
is('2 ^ 10', '1,024')
is('-5 + 12', '7')
is('10 / 4', '2.5')
is('1,250 + 1,250', '2,500')          // thousands separators, as pasted
is('1_000 * 3', '3,000')
// float dust is the classic wrong-looking-right answer
is('0.1 + 0.2', '0.3')
is('1.1 * 3', '3.3')
none('5 / 0')                          // not Infinity in someone's notes

// ---- percentages ------------------------------------------------------------
is('20% of 340', '68')
is('340 + 15%', '391')
is('340 - 15%', '289')
is('12.5% of 80', '10')
// the reading everybody means: "+15%" is an increase, not "plus 0.15"
ok(A('200 + 10%') === '220', 'a trailing percentage increases rather than adds')

// ---- units ------------------------------------------------------------------
// The decimals are the ones a NOTE wants: 2 places above 100, 4 above 1, 6
// below. "584.088921 mi" is noise around 584.09, and a page of notes reads
// worse for it.
is('10 km in miles', '6.2137 mi')
is('26.2 miles in km', '42.1648 km')
is('5 ft in cm', '152.4 cm')
is('2.5 GB in MB', '2,560 MB')
is('1 hour in minutes', '60 min')
is('90 min in hours', '1.5 h')
is('72 f in c', '22.2222 °C')
is('100 c in f', '212 °F')
is('0 c in k', '273.15 K')
is('1 kg in lb', '2.2046 lb')
none('10 km in kg')                    // families do not mix
none('10 km in wombats')

// ---- unit arithmetic --------------------------------------------------------
is('2 km + 300 m', '2.3 km')
is('1 h + 30 min', '1.5 h')
is('3 kg * 2', '6 kg')
none('2 km + 3 kg')

// ---- clock times ------------------------------------------------------------
is('9:30 + 45 min', '10:15')            // a time, not "10.25 h"
is('17:00 - 9:30', '7.5 h')             // …and the gap between two times is a duration
is('23:30 + 45 min', '0:15')            // wrapping midnight beats a 25th hour
none('9:30 + 17:00')                    // two times of day do not add
none('9:70')                            // nor does a 70th minute exist

// ---- variables --------------------------------------------------------------
{
  const vars = new Map<string, Val>()
  const def = definition('budget = 5000')
  ok(def?.name === 'budget' && def.val.n === 5000, 'a bare `name = value` line defines a name')
  if (def) vars.set(def.name, def.val)
  is('budget * 0.3', '1,500', { vars })
  is('budget - 1200', '3,800', { vars })
  is('20% of budget', '1,000', { vars })

  // a definition can use one already defined
  const d2 = definition('spent = budget * 0.4', { vars })
  ok(d2?.val.n === 2000, 'a definition can build on an earlier one')
  if (d2) vars.set(d2.name, d2.val)
  is('budget - spent', '3,000', { vars })

  // …and a unit survives the round trip
  const d3 = definition('trip = 120 km')
  if (d3) vars.set(d3.name, d3.val)
  is('trip in miles', '74.5645 mi', { vars })

  // a name that is a unit, or a keyword, is NOT a definition — `in = 5` would
  // quietly break every conversion on the page
  ok(definition('in = 5') === null, 'a unit name cannot be redefined')
  ok(definition('today = 5') === null, 'nor can a keyword')
  // and a line that ASKS for an answer is not a definition
  ok(definition('budget * 2 =') === null, 'a question is not a definition')
}

// ---- sum of the lines above -------------------------------------------------
is('sum above', '60', { above: [10, 20, 30] })
is('total', '6', { above: [1, 2, 3] })
is('sum above / 3', '20', { above: [10, 20, 30] })
is('sum above', '0', { above: [] })

// …and what "above" MEANS, which is the run of figures directly above and not
// every number on the page. Summing the page was the first behaviour, and on a
// page with a budget, three expenses and two other answers it reported 78,732
// where the reader means 515.
{
  const ctx = freshContext()
  for (const line of [
    'budget = 2400',           // a definition — not a figure, and it ends any run
    'Trip costs',              // prose — ends the run
    '120', '340', '55',        // THE run
  ]) feed(ctx, line)
  ok(A('sum above =', ctx) === '515',
    `sum above is the run directly above (got ${A('sum above =', ctx)})`)

  // a sentence between the figures and the sum breaks the run, which is what
  // somebody reading the page would expect
  const broken = freshContext()
  for (const line of ['120', '340', 'and then we stopped counting']) feed(broken, line)
  ok(A('sum above =', broken) === '0', 'prose ends the run')

  // an answered line is not itself a figure — otherwise a running total would
  // count its own subtotals
  const subtotals = freshContext()
  for (const line of ['10', '20', 'sum above =', '30']) feed(subtotals, line)
  ok(A('sum above =', subtotals) === '30', 'an answer does not join the run it summarises')
}

// ---- dates ------------------------------------------------------------------
{
  const ctx = { today: '2026-08-10' }
  is('today', '2026-08-10', ctx)
  is('tomorrow', '2026-08-11', ctx)
  is('yesterday', '2026-08-09', ctx)
  is('today + 3 weeks', '2026-08-31', ctx)
  is('today + 90 days', '2026-11-08', ctx)
  is('2026-12-25 - today', '137 days', ctx)
  is('2026-08-31 - 2026-08-10', '21 days', ctx)
  is('2026-08-10 + 1 day', '2026-08-11', ctx)
  // across a year end, a leap day, and a DST boundary
  is('2026-12-31 + 1 day', '2027-01-01', ctx)
  is('2024-02-28 + 1 day', '2024-02-29', ctx)
  is('2026-03-28 + 1 day', '2026-03-29', ctx)
  is('2026-10-24 + 2 days', '2026-10-26', ctx)
  none('2026-13-99 + 1 day')            // not a date, so not an answer
  none('today + today')                 // two dates do not add
  none('today * 2')                     // nor scale
}

// ---- THE REFUSALS, which matter as much as the answers ----------------------
// Every one of these is a sentence somebody would write in a note.
none('Meet Ana at 3')
none('We shipped 3 of 7')
none('call Bob')
none('')
none('   ')
none('3 apples and 4 pears')
none('v2 launch')
none('$5 for coffee')                  // a bare currency symbol is not a unit here
none('12 of 60')
none('the 5th')
ok(A('2026') === '2,026', 'a bare number is a number when asked')
none('a + b')                           // undefined names
none('budget * 2')                      // …including when nothing is defined
// a very long line is refused rather than parsed, so a pasted wall of text
// cannot become a calculation
none('1 + '.repeat(80) + '1')

// ---- the marker -------------------------------------------------------------
ok(asksForAnswer('2 + 2 ='), 'a trailing = asks for an answer')
ok(asksForAnswer('2 + 2 =   '), '…with trailing space')
ok(!asksForAnswer('2 + 2'), 'and without it, nothing happens')
ok(!asksForAnswer('a = b'), 'a definition does not ask')
ok(answer('2 + 2 =') === '4', 'answer() drives off the marker')
ok(answer('2 + 2') === null, '…and only the marker')
ok(answer('hello =') === null, 'a line that asks but does not parse gets nothing')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
