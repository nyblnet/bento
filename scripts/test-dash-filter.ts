#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash filter + multi-key sort rig.
//
//   node scripts/test-dash-filter.ts
//
// WHAT THIS PROVES. Filtering and sorting never touch the document — they build
// an order vector — so nothing here can corrupt a file. What they can do is
// show the reader the WRONG ROWS, confidently, with no error state anywhere on
// screen. Every failure in this file is of that shape:
//
//   1. LEXICAL COMPARISON OF NUMBERS. "9" < "10" is false as text. A column of
//      digits that arrived as strings then sorts 1, 10, 100, 2 and a "less than
//      10" filter hides the 9 — and the grid looks perfectly sorted.
//   2. A BLANK TREATED AS A VALUE. `null < 5` is TRUE in JavaScript and
//      `Number(null)` is 0, so the naive implementation files every empty cell
//      under "less than 5" and stacks them at the top of an ascending sort.
//   3. A SECOND SORT KEY THAT IS SILENTLY DROPPED. A single-key comparator
//      returns 0 on a tie and lets the engine decide; the dialog says "then by
//      Date" and the rows are in insertion order.
//   4. A TOP-N THAT RANKED THE WRONG POPULATION. Rank before filter and "top 3
//      in the North" is the top 3 overall intersected with the North — usually
//      fewer than three rows, sometimes none, never an error.
//   5. A CHECKBOX THAT WILL NOT TICK. `Set.has(10)` does not match the cell
//      holding "10", so a box the user just ticked filters its own rows away.
//   6. AN AGGREGATE OVER THE ROWS THAT ARE NOT SHOWN. The status bar must total
//      the visible rows; totalling the column is a real number that answers a
//      question nobody asked.

import {
  passes, buildOrder, distinctValues, summarize, compare, isBlank,
  needsWholeColumn, type Get, type Predicate,
} from '../dash/src/filter.ts'
import type { TableSheet } from '../dash/src/model.ts'
import { readCell } from '../dash/src/store.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** A `get` over plain columns — the same shape the grid builds from readCell. */
const over = (cols: Record<string, unknown[]>): Get =>
  (c, r) => (cols[c] ? cols[c][r] : undefined)

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// The working set. `qty` is the case that matters: digits that arrived as TEXT,
// which is every CSV column import declined to type.
const cols: Record<string, unknown[]> = {
  region: ['North', 'South', 'north', 'South', null, 'North'],
  rep: ['Ada', 'Bob', 'Cara', 'Ada', 'Dan', 'Bob'],
  amount: [10, 9, 100, 2, 1000, null],
  qty: ['9', '10', '100', '2', '', '3'],
  when: ['2026-01-15', '2026-02-03', '2026-10-01', null, '2026-03-30', '2026-01-15'],
}
const get = over(cols)
const N = 6
const order = (f: Parameters<typeof buildOrder>[2], s: Parameters<typeof buildOrder>[3]) =>
  buildOrder(N, get, f, s)

// ------------------------------------------------- 1. numbers are numbers
ok(passes('9', { op: 'less', v: '10' }) === true,
  '"9" < "10" is TRUE — a column of digits compares numerically')
ok(('9' < '10') === false,
  'and that is NOT what text comparison says: the bug this exists to prevent')
ok(passes(9, { op: 'less', v: '10' }) === true,
  'a number cell against the string a menu hands back still compares numerically')
ok(passes('1,200', { op: 'greater', v: 999 }) === true,
  'a grouped "1,200" reads as 1200, not as text beginning with 1')
ok(passes('50%', { op: 'greater', v: 1 }) === false,
  '"50%" is NOT read as 50 — a percent column stores the fraction 0.5, so ' +
  'reading the notation as a number would be wrong by 100x')
ok(('50%' > '1') === true && ('1 unit' < '10') === true,
  'as TEXT, "50%" is greater than 1 and "1 unit" is less than 10: both arbitrary')
ok(passes('1 unit', { op: 'less', v: 10 }) === false,
  'so a NUMBER filter refuses a TEXT cell rather than answering arbitrarily')
ok(passes('Cara', { op: 'greater', v: 'Bob' }) === true,
  'while text against text still orders — that is how "after M" works on names')
{
  const m = over({ mix: [10, 'n/a', 2, 'abc'] })
  ok(eq(buildOrder(4, m, [], [{ col: 'mix', dir: 'asc' }]), [2, 0, 3, 1]),
    'a column holding both sorts numbers first, then text — Excel\'s order, and ' +
    'the only stable one: comparing 10 against "n/a" as strings drops the ' +
    'number wherever its digits happen to fall')
}
ok(eq(order([], [{ col: 'qty', dir: 'asc' }]), [3, 5, 0, 1, 2, 4]),
  'sorting text digits gives 2, 3, 9, 10, 100 — and the blank last')
ok(order([], [{ col: 'qty', dir: 'asc' }])[0] !== 1,
  'a lexical sort would have put "10" first; this one does not')

// -------------------------------------------------------------- 2. dates
ok(passes('2026-02-03', { op: 'less', v: '2026-10-01' }) === true,
  'ISO dates compare chronologically as text — which is why import stores them so')
ok(compare('2026-10-01', '2026-02-03') > 0, 'October sorts after February, not before')
ok(eq(order([], [{ col: 'when', dir: 'asc' }]), [0, 5, 1, 4, 2, 3]),
  'a date sort is chronological, ties keep document order, and the blank sinks')

// --------------------------------------------------------------- 3. text
ok(passes('North', { op: 'equals', v: 'north' }) === true, 'text equality ignores case')
ok(passes(10, { op: 'equals', v: '10' }) === true,
  'and equality is type-aware: the cell 10 equals the typed "10"')
ok(passes('Ada', { op: 'contains', v: 'A' }) === true, 'contains ignores case')
ok(passes('Bob', { op: 'contains', v: 'a' }) === false, 'and still says no when it means no')
ok(passes('Bob', { op: 'notContains', v: 'a' }) === true, 'notContains is its complement')
ok(passes(null, { op: 'notContains', v: 'a' }) === true, 'a blank does not contain anything')
ok(passes('Cara', { op: 'startsWith', v: 'ca' }) === true
  && passes('Cara', { op: 'endsWith', v: 'RA' }) === true, 'startsWith / endsWith')
ok(passes('Cara', { op: 'startsWith', v: 'ra' }) === false, 'startsWith is not contains')

// ----------------------------------------------- 4. blanks are not values
ok(((null as unknown as number) < 5) === true,
  'JavaScript says null < 5, which is where the whole blank problem comes from')
ok(passes(null, { op: 'less', v: 5 }) === false,
  'but a blank cell is NOT less than 5 — it is not a value at all')
ok(passes(null, { op: 'greater', v: 5 }) === false, 'nor greater than 5')
ok(passes('   ', { op: 'greaterOrEqual', v: 0 }) === false,
  'whitespace is blank too, and Number("   ") being 0 is not a reason to show it')
ok(passes(0, { op: 'isBlank' }) === false && isBlank(0) === false,
  'ZERO IS NOT BLANK — it is an answer the author entered')
ok(passes(false, { op: 'isBlank' }) === false, 'and neither is false')
ok(passes(null, { op: 'isBlank' }) === true && passes('', { op: 'isBlank' }) === true,
  'null and "" are blank')
ok(passes(null, { op: 'notEquals', v: 5 }) === true,
  'a blank cell DOES "not equal" 5, or equals/notEquals fail to partition the rows')
ok(passes(null, { op: 'equals', v: null }) === true,
  'and equals against nothing is how a menu asks for the empties')
ok(eq(order([], [{ col: 'amount', dir: 'asc' }]), [3, 1, 0, 2, 4, 5]),
  'ascending: blanks SINK to the bottom')
ok(eq(order([], [{ col: 'amount', dir: 'desc' }]), [4, 2, 0, 1, 3, 5]),
  'descending: blanks sink to the bottom AGAIN — a blank is not "smallest"')
ok(order([], [{ col: 'amount', dir: 'desc' }])[0] !== 5,
  'specifically, the blank is not the largest value either')

// ------------------------------------------------------------- 5. between
ok(passes(10, { op: 'between', lo: 10, hi: 20 }) === true
  && passes(20, { op: 'between', lo: 10, hi: 20 }) === true, 'between includes both ends')
ok(passes(9.99, { op: 'between', lo: 10, hi: 20 }) === false, 'and excludes just outside')
ok(passes(15, { op: 'between', lo: 20, hi: 10 }) === true,
  'bounds typed in the wrong order still mean the range between them')
ok(passes(1e6, { op: 'between', lo: 10, hi: null }) === true,
  'an empty upper box is an OPEN end, not an empty grid')
ok(passes(null, { op: 'between', lo: 10, hi: 20 }) === false, 'a blank is in no range')

// ----------------------------------------------- 6. the checkbox list ticks
ok(new Set<unknown>([10]).has('10') === false,
  'Set.has is identity: a set holding 10 does not contain "10" — the checkbox bug')
ok(passes('10', { op: 'isOneOf', set: new Set([10]) }) === true,
  'so isOneOf matches on a canonical key instead, and the box ticks its own rows')
ok(passes('North', { op: 'isOneOf', set: new Set(['north']) }) === true,
  'and matches text case-insensitively, as the list deduped it')
ok(passes(null, { op: 'isOneOf', set: new Set([null]) }) === true,
  'null in the set is the "(Blanks)" box')
ok(passes('North', { op: 'isOneOf', set: new Set(['south']) }) === false,
  'and a value nobody ticked is still filtered out')
ok(eq(order([{ col: 'region', pred: { op: 'isOneOf', set: new Set(['north']) } }], []),
  [0, 2, 5]),
'buildOrder\'s pre-keyed fast path agrees with passes(), case-folding and all')

// ------------------------------------------------------ 7. filters AND
ok(eq(order([
  { col: 'region', pred: { op: 'isOneOf', set: new Set(['North', 'South']) } },
  { col: 'amount', pred: { op: 'greater', v: 9 } },
], []), [0, 2]),
'two filters intersect: North/South AND over 9')

// ------------------------------------------------------ 8. multi-key sort
{
  const m = over({
    a: ['x', 'x', 'x', 'y', 'y'],
    b: [2, 1, 2, 1, 1],
    c: ['q', 'r', 'p', 's', 't'],
  })
  const three = buildOrder(5, m, [], [
    { col: 'a', dir: 'asc' }, { col: 'b', dir: 'asc' }, { col: 'c', dir: 'asc' },
  ])
  ok(eq(three, [1, 2, 0, 3, 4]),
    'three keys: a, then b breaks its ties, then c breaks b\'s')
  const one = buildOrder(5, m, [], [{ col: 'a', dir: 'asc' }])
  ok(eq(one, [0, 1, 2, 3, 4]) && !eq(one, three),
    'and the one-key answer is DIFFERENT — which is what a dropped second key looks like')
  ok(eq(buildOrder(5, m, [], [{ col: 'a', dir: 'asc' }, { col: 'b', dir: 'desc' }]),
    [0, 2, 1, 3, 4]),
  'each key carries its OWN direction: a ascending, b descending')
  ok(eq(buildOrder(5, m, [], [{ col: 'b', dir: 'asc' }, { col: 'a', dir: 'asc' }]),
    [1, 3, 4, 0, 2]),
  'and key ORDER matters — b then a is a different sort from a then b')
}
{
  // blanks tie on the first key, so the second key still has to order them
  const m = over({ p: ['x', null, null, 'w'], q: [2, 5, 1, 1] })
  ok(eq(buildOrder(4, m, [], [{ col: 'p', dir: 'asc' }, { col: 'q', dir: 'asc' }]),
    [3, 0, 2, 1]),
  'rows blank on the first key sink together, and the second key orders them')
  ok(eq(buildOrder(4, m, [], [{ col: 'p', dir: 'desc' }, { col: 'q', dir: 'asc' }]),
    [0, 3, 2, 1]),
  'reversing the first key does not float the blanks to the top')
}
{
  const m = over({ same: ['a', 'a', 'a', 'a'] })
  ok(eq(buildOrder(4, m, [], [{ col: 'same', dir: 'desc' }]), [0, 1, 2, 3]),
    'rows equal on every key keep document order — the sort is deterministic')
}

// ------------------------------------------------------------ 9. rank filters
ok(needsWholeColumn({ op: 'topN', n: 3 }) === true
  && needsWholeColumn({ op: 'greater', v: 3 }) === false,
'needsWholeColumn tells a per-row caller which predicates it cannot evaluate')
{
  let threw = false
  try { passes(1, { op: 'topN', n: 3 } as Predicate) } catch { threw = true }
  ok(threw,
    'passes() REFUSES topN rather than answering: true would show every row and ' +
    'false would show none, and both look like a working filter')
}
ok(eq(order([{ col: 'amount', pred: { op: 'topN', n: 2 } }], []), [2, 4]),
  'top 2 by amount is 100 and 1000, returned in row order')
ok(eq(order([{ col: 'amount', pred: { op: 'bottomN', n: 2 } }], []), [1, 3]),
  'bottom 2 is 2 and 9 — the BLANK is not the bottom, it has no rank')
ok(eq(order([
  { col: 'region', pred: { op: 'isOneOf', set: new Set(['north']) } },
  { col: 'amount', pred: { op: 'topN', n: 1 } },
], []), [2]),
'"top 1 in the North" ranks what SURVIVED the other filters — ranking first ' +
  'would intersect 1000 (region blank) with North and return nothing')
ok(order([
  { col: 'region', pred: { op: 'isOneOf', set: new Set(['north']) } },
  { col: 'amount', pred: { op: 'topN', n: 1 } },
], []).length !== 0, 'and specifically it is not empty')
ok(eq(order([{ col: 'amount', pred: { op: 'topN', n: 99 } }], []), [0, 1, 2, 3, 4]),
  'a top-N larger than the column keeps every ranked row — still not the blank')
ok(eq(order([{ col: 'amount', pred: { op: 'topN', n: 0 } }], []), []),
  '"top 0" is nothing, not everything')
{
  const m = over({ v: [5, 5, 5, 1] })
  const r = buildOrder(4, m, [{ col: 'v', pred: { op: 'topN', n: 2 } }], [])
  ok(r.length === 3 && eq(r, [0, 1, 2]),
    'the cut is a THRESHOLD, so three tied values all survive a top 2 — ' +
    'dropping one of them would be a coin flip the reader cannot see')
}

// ------------------------------------------------------- 10. distinct values
{
  const d = distinctValues(get, 'region', N)
  ok(d.values.length === 3 && d.values[2] === null,
    '"North"/"north" dedupe to one entry, and "(Blanks)" is one box at the end')
  ok(d.values[0] === 'North',
    'the entry shown is the first-seen ORIGINAL, not a normalised copy')
  ok(d.truncated === false, 'and nothing is claimed to be truncated when it is not')
}
{
  const m = over({ n: ['10', 10, ' 10 ', '9'] })
  const d = distinctValues(m, 'n', 4)
  ok(d.values.length === 2, '10, "10" and " 10 " are ONE checkbox, not three')
  ok(d.values[0] === '9', 'and the list is in value order: 9 before 10, not "10" before "9"')
}
{
  const m = over({ n: ['a', 'b', 'c', 'd', 'e'] })
  const d = distinctValues(m, 'n', 5, 3)
  ok(d.truncated === true && d.values.length === 3,
    'past the cap the list SAYS it is partial rather than showing three as if they were five')
}
{
  // the blank arrives after the cap is already reached
  const m = over({ n: ['a', 'b', 'c', 'd', null] })
  const d = distinctValues(m, 'n', 5, 2)
  ok(d.truncated === true && d.values.length === 3 && d.values[2] === null,
    'a truncated list still reports its "(Blanks)" box — otherwise that filter ' +
    'cannot be expressed at all')
}
{
  // the round trip the whole canonical-key design exists for
  const d = distinctValues(get, 'region', N)
  const all = buildOrder(N, get, [
    { col: 'region', pred: { op: 'isOneOf', set: new Set(d.values) } },
  ], [])
  ok(all.length === N,
    'ticking every box the list offered shows every row — list and filter agree by construction')
  const some = buildOrder(N, get, [
    { col: 'region', pred: { op: 'isOneOf', set: new Set([d.values[1]]) } },
  ], [])
  ok(eq(some, [1, 3]), 'and unticking all but one leaves exactly that value\'s rows')
}

// ------------------------------------------------------------- 11. summarize
{
  const all = buildOrder(N, get, [], [])
  const s = summarize(get, 'amount', all)
  ok(s.count === 5 && s.blanks === 1, 'count is the values present; blanks are reported apart')
  ok(s.sum === 1121 && s.min === 2 && s.max === 1000, 'sum / min / max')
  ok(s.avg === 224.2, 'avg')
}
{
  const visible = buildOrder(N, get, [{ col: 'amount', pred: { op: 'less', v: 11 } }], [])
  const s = summarize(get, 'amount', visible)
  ok(eq(visible, [0, 1, 3]), 'a filter leaves three rows visible')
  ok(s.sum === 21,
    'and the status bar totals THOSE rows — 1121 would be the honest answer to a ' +
    'question nobody asked')
}
{
  const m = over({ mix: [10, 'n/a', null, 20] })
  const s = summarize(m, 'mix', [0, 1, 2, 3])
  ok(s.count === 3 && s.numeric === 2 && s.blanks === 1,
    'a mixed column counts values, numbers and blanks separately')
  ok(s.avg === 15,
    'avg divides by the NUMBERS (30/2), not by the visible rows (30/4) or the values (30/3)')
}
{
  const s = summarize(get, 'rep', [0, 1, 2, 3, 4, 5])
  ok(s.count === 6 && s.numeric === 0, 'a text column still counts its values')
  ok(s.sum === null, 'but its sum is null — 0 would read as "these add up to nothing"')
  ok(s.min === null && s.max === null,
    'and min/max are null, NOT the Infinity that Math.min() of an empty list returns')
  ok(s.avg === null, 'and avg is null, not NaN')
}
{
  const s = summarize(get, 'amount', [])
  ok(s.count === 0 && s.blanks === 0 && s.sum === null,
    'an empty selection aggregates to nothing at all')
}

// -------------------------------------------- 12. wired to a real sheet
{
  const sheet: TableSheet = {
    id: 'sh', name: 'S', kind: 'table',
    rids: [[1, 4]],
    columns: [
      { id: 'region', name: 'Region', type: 'text' },
      { id: 'amount', name: 'Amount', type: 'money' },
    ],
    data: {
      region: { enc: 'dict', dict: ['North', 'South'], idx: [0, 1, null, 0] },
      amount: { enc: 'raw', v: [10, 9, 100, 2] },
    },
    steps: [],
  }
  const sget: Get = (c, r) => readCell(sheet.data[c], r)
  ok(eq(buildOrder(4, sget, [], [{ col: 'region', dir: 'asc' }]), [0, 3, 1, 2]),
    'reading through readCell, a dictionary column sorts and its null sinks')
  ok(eq(buildOrder(4, sget,
    [{ col: 'region', pred: { op: 'isOneOf', set: new Set(['north']) } }],
    [{ col: 'amount', dir: 'desc' }]), [0, 3]),
  'and filter + sort compose over the encoded column the grid actually reads')
  ok(JSON.stringify(sheet.data.amount) === JSON.stringify({ enc: 'raw', v: [10, 9, 100, 2] })
    && sheet.rids.length === 1,
  'THE DOCUMENT IS UNTOUCHED: sorting and filtering are view state, so no ' +
    'checkpoint, no dirty flag, no collab op')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
