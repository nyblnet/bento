#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash find + replace rig.
//
//   node scripts/test-dash-find.ts
//
// WHAT THIS PROVES, and why each of these is a bug you cannot see:
//
//   1. THE VIEW VECTOR IS THE ROW LIST. `store.order[sheetId]` is what the grid
//      paints through, so it is what a search must walk. A find that ignores it
//      returns positions in the SHEET's order and hands them to a selection
//      that thinks in VISIBLE positions — so on a sorted sheet the highlight
//      lands on a different row than the one that matched, and on a filtered
//      sheet it lands on a row the reader cannot see at all. Visible and
//      canonical are the same number right up until somebody clicks a column
//      header, which is exactly why this ships wrong so often.
//   2. THE SCREEN AND THE FILE ARE TWO HAYSTACKS. A money cell holding 12400
//      shows "£12,400.00". "12,400" is only in the display; "12400" is only in
//      the stored value. Matching one of the two makes the search answer "not
//      found" about something the user is looking at.
//   3. WRAP-AROUND IS THE FIND BAR'S WHOLE CONTRACT, and the off-by-one is at
//      the START: with nothing selected yet, forward must land on the first
//      match and backward on the LAST.
//   4. REPLACE MUST NAME RIDS, NOT ROWS. A patch built from a visible index
//      rewrites whichever row happens to sit there — under a filter, a
//      different row entirely, silently, with the view re-sorting over the
//      evidence.
//   5. REPLACE MUST REFUSE, AND COUNT. A computed column, a per-cell formula
//      and a match that exists only in the FORMATTED text are three things that
//      cannot be rewritten honestly. Skipping them quietly is a Replace all
//      that reports success and did four-fifths of the job.
//   6. NO MATCHES IS AN ANSWER. Zero hits, a cleared index, and nothing thrown.

import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

// find.ts imports its stylesheet, which is Vite's job and not Node's —
// panels.ts, comments.ts and their rigs settled this pattern; co-locating a
// component with its styles is not something a rig gets to break.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const {
  matchText, replaceIn, stepIndex, searchTarget, displayOf, planReplace, buildTarget,
} = await import('../dash/src/find.ts')
type FindQuery = import('../dash/src/find.ts').FindQuery
type SearchTarget = import('../dash/src/find.ts').SearchTarget

const { keyToAction, actionSig, describeBindings } = await import('../dash/src/select.ts')
// THE REAL COERCION, out of the grid — so the replace checks below prove what
// a replacement actually becomes in a money column, not what a stand-in in
// this file would make of it.
const { coerceForColumn } = await import('../dash/src/grid.ts')
const { FormulaError } = await import('../dash/src/formula.ts')
type Column = import('../dash/src/model.ts').Column
type DashDoc = import('../dash/src/model.ts').DashDoc
type TableSheet = import('../dash/src/model.ts').TableSheet

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const j = (v: unknown): string => JSON.stringify(v)
function eq(got: unknown, want: unknown, msg: string) {
  const same = j(got) === j(want)
  ok(same, same ? msg : `${msg} — got ${j(got)}, wanted ${j(want)}`)
}

// ------------------------------------------------------------------ matching
{
  const q = (o: Partial<FindQuery>): FindQuery => ({ query: 'ac', ...o })
  ok(matchText('Acme Ltd', q({})), 'a lowercase query matches mixed-case text by default')
  ok(!matchText('Acme Ltd', q({ caseSensitive: true })), '…and does not when case matters')
  ok(matchText('Acme Ltd', q({ query: 'Ac', caseSensitive: true })), 'case-sensitive matches the right case')
  ok(!matchText('Acme Ltd', q({ query: 'acme', wholeCell: true })), 'whole-cell refuses a prefix')
  ok(matchText('Acme Ltd', q({ query: 'acme ltd', wholeCell: true })), 'whole-cell matches the whole cell, case-folded')
  ok(matchText(' Acme Ltd ', q({ query: 'Acme Ltd', wholeCell: true })),
    'whole-cell trims BOTH sides — a stray import space is not a different value')
  ok(!matchText('Acme Ltd', q({ query: 'me L' })) === false,
    'a substring spanning a space matches (no tokenising)')
  // The empty query is not "match everything". A find bar with an empty field
  // that lit every cell in the sheet would be unusable, and its count would be
  // the row count.
  ok(!matchText('anything', { query: '' }), 'an EMPTY query matches nothing, not everything')
}

// ------------------------------------------------------------- wrap-around
{
  eq(stepIndex(3, -1, 1), 0, 'first forward step from nowhere lands on match 1')
  eq(stepIndex(3, -1, -1), 2, 'first BACKWARD step from nowhere lands on the LAST match')
  eq(stepIndex(3, 2, 1), 0, 'forward past the end wraps to the start')
  eq(stepIndex(3, 0, -1), 2, 'backward past the start wraps to the end')
  eq(stepIndex(1, 0, 1), 0, 'a single match steps to itself rather than to -1')
  eq(stepIndex(0, -1, 1), -1, 'no matches: the index stays cleared')
  eq(stepIndex(0, 4, -1), -1, '…even from a stale index left over from a previous query')
}

// ------------------------------------------------------------------ replaceIn
{
  eq(replaceIn('a-b-a', 'a', 'Z'), 'Z-b-Z', 'every occurrence in the cell is replaced')
  eq(replaceIn('A-b-a', 'a', 'Z'), 'Z-b-Z', '…case-insensitively by default')
  eq(replaceIn('A-b-a', 'a', 'Z', true), 'A-b-Z', '…and only the exact case when asked')
  eq(replaceIn('anything', 'x', 'y', false, true), 'y', 'whole-cell replace rewrites the cell outright')
  eq(replaceIn('a', '', 'Z'), 'a', 'an empty needle changes nothing (never an infinite loop)')
  // The needle is USER TEXT, and a spreadsheet is full of it. A RegExp-based
  // implementation eats these, and it eats them as a WRITE.
  eq(replaceIn('gross (net)', '(net)', '[net]'), 'gross [net]', 'regex metacharacters are literal: parentheses')
  eq(replaceIn('12.50', '.', ','), '12,50', '…a dot is a dot, not "any character"')
  eq(replaceIn('a$b', '$b', '!'), 'a!', '…and $ is not an anchor')
}

// -------------------------------------------------------------- the display
{
  const money: Column = { id: 'v', name: 'Value', type: 'money', format: '£#,##0.00' }
  eq(displayOf(12400, money), '£12,400.00', 'a money cell displays formatted')
  eq(displayOf(null, money), '', 'a blank displays as nothing, not as "null"')
  const text: Column = { id: 't', name: 'Name', type: 'text' }
  eq(displayOf('Acme', text), 'Acme', 'text displays as itself')
  // The error branch mirrors grid.ts. Cells showing #CYCLE! are the ones a
  // reader is most likely to go hunting for — and a formatter would render the
  // error OBJECT as "[object Object]", which is findable by nobody.
  eq(displayOf(new FormulaError('#CYCLE!'), money), '#CYCLE!', 'an error cell displays its error text')
}

// ------------------------------------------------------- searching a target
//
// One fixture, walked three ways: unfiltered, filtered, sorted.

const COLS = [
  { id: 'name', name: 'Customer', type: 'text' as const },
  { id: 'val', name: 'Value', type: 'money' as const, format: '£#,##0.00' },
]
const NAMES = ['Acme Ltd', 'Beta Co', 'acme holdings', 'Delta']
const VALS = [12400, 500, 22750, 12400]

const target = (order: number[] | null): SearchTarget => ({
  sheetId: 's1',
  sheetName: 'Deals',
  columns: COLS,
  order,
  rows: 4,
  valueAt: (col, row) => (col === 'name' ? NAMES[row] : VALS[row]),
  storedAt: (col, row) => (col === 'name' ? NAMES[row] : VALS[row]),
  ridAt: (vis) => 100 + (order ? order[vis] : vis),
})

{
  const hits = searchTarget(target(null), { query: 'acme' })
  eq(hits.map((h) => [h.row, h.col]), [[0, 0], [2, 0]],
    'two case-folded matches, in reading order (top to bottom, left to right)')
  eq(hits.map((h) => h.rid), [100, 102], 'each hit carries the RID of the row it landed on')

  eq(searchTarget(target(null), { query: 'zzz' }), [], 'a search with no matches returns an empty list')
  eq(searchTarget(target(null), { query: '' }), [], 'an empty query returns nothing rather than everything')
}

// THE HEADLINE: the display and the file are two different strings, and a
// reader may type either.
{
  const seen = searchTarget(target(null), { query: '12,400' })
  eq(seen.map((h) => [h.row, h.col]), [[0, 1], [3, 1]],
    'typing what is ON SCREEN ("12,400") finds the money cells')
  eq(seen.map((h) => h.locked), ['display-only', 'display-only'],
    '…and those matches are marked display-only, because Replace cannot rewrite a rendering')

  const stored = searchTarget(target(null), { query: '12400' })
  eq(stored.map((h) => [h.row, h.col]), [[0, 1], [3, 1]],
    'typing what is IN THE FILE ("12400") finds the same cells')
  eq(stored.map((h) => h.locked), [undefined, undefined],
    '…and those ARE replaceable, because the query matched the stored value')

  eq(searchTarget(target(null), { query: '£' }).length, 4,
    'the currency symbol exists only in the display, and is findable')
}

// THE VIEW VECTOR. A filter keeps rows 1 and 2; a sort reverses them.
{
  const filtered = searchTarget(target([1, 2]), { query: 'acme' })
  eq(filtered.map((h) => [h.row, h.col]), [[1, 0]],
    'under a FILTER, only the surviving row matches — and at its VISIBLE index')
  eq(filtered.map((h) => h.canonRow), [2], '…while it still knows the canonical row it came from')
  eq(filtered.map((h) => h.rid), [102], '…and the rid, which is what a write must name')

  const sorted = searchTarget(target([3, 2, 1, 0]), { query: 'acme' })
  eq(sorted.map((h) => [h.row, h.canonRow]), [[1, 2], [3, 0]],
    'under a SORT, matches come back in the order the reader sees them')
  // The negative form of the same claim: the canonical positions are 0 and 2,
  // so an implementation that ignored the vector would report rows 0 and 2 —
  // which under this sort hold Delta and acme holdings.
  ok(sorted[0].row !== sorted[0].canonRow,
    'visible and canonical genuinely differ here, so the previous check is not vacuous')
}

// FORMULAS mode looks at the source, not the result.
{
  const withF: SearchTarget = {
    ...target(null),
    columns: [
      COLS[0],
      { id: 'val', name: 'Value', type: 'money', format: '£#,##0.00' },
      { id: 'net', name: 'Net', type: 'number', formula: 'Value * 0.8' },
    ],
    valueAt: (col, row) => (col === 'name' ? NAMES[row] : col === 'val' ? VALS[row] : VALS[row] * 0.8),
    storedAt: (col, row) => (col === 'name' ? NAMES[row] : col === 'val' ? VALS[row] : null),
    sourceAt: (col, row) => (col === 'val' && row === 1 ? '=SUM(1,2)' : undefined),
  }
  const f = searchTarget(withF, { query: '0.8', look: 'formulas' })
  eq(f.map((h) => [h.row, h.col]), [[0, 2], [1, 2], [2, 2], [3, 2]],
    'Formulas mode finds the column expression on every row of a computed column')
  eq(f[0].locked, 'computed', '…and marks them computed, so Replace leaves them alone')

  const cell = searchTarget(withF, { query: 'SUM', look: 'formulas' })
  eq(cell.map((h) => [h.row, h.col]), [[1, 1]], 'a PER-CELL formula is found by its source')
  eq(cell[0].locked, 'formula', '…and is locked for the same reason')

  eq(searchTarget(withF, { query: 'SUM', look: 'values' }), [],
    'Values mode does NOT find a formula source — the two modes are genuinely different')
  ok(searchTarget(withF, { query: '9920', look: 'values' }).length > 0,
    'Values mode DOES find the computed result 12400 * 0.8')
}

// -------------------------------------------------- a real sheet, and Replace

function sheet(): TableSheet {
  return {
    id: 's1', name: 'Deals', kind: 'table',
    rids: [[100, 4]],
    columns: [
      { id: 'name', name: 'Customer', type: 'text' },
      { id: 'val', name: 'Value', type: 'money', format: '£#,##0.00' },
      { id: 'net', name: 'Net', type: 'number', formula: 'Value * 0.8' },
    ],
    data: {
      name: { enc: 'raw', v: [...NAMES] },
      val: { enc: 'raw', v: [...VALS] },
    },
    cells: { 'name:102': { f: '="acme " & "x"' } },
    steps: [],
  }
}

const doc = (s: TableSheet): DashDoc => ({
  format: 'bento/dash', version: 1, docId: 'd', title: 'T', sheets: [s],
} as unknown as DashDoc)

{
  const s = sheet()
  // The view the reader is looking at: rows 2 and 0, in that order — a filter
  // AND a sort at once, which is the case that catches an implementation that
  // handles only one of them.
  const tg = buildTarget(doc(s), s, [2, 0])
  eq(tg.columns.map((c) => c.id), ['name', 'val', 'net'], 'buildTarget lists the visible columns in order')
  eq(tg.order, [2, 0], '…and carries the view vector it was handed')
  eq(tg.ridAt(0), 102, 'visible row 0 is rid 102 under this view')
  eq(tg.ridAt(1), 100, 'visible row 1 is rid 100')
  // `valueAt` takes a CANONICAL row — the two indexings are kept apart
  // deliberately, and this pair says which is which.
  eq(tg.valueAt('net', 0), 12400 * 0.8, 'a formula column is recomputed, not read as blank')
  eq(tg.valueAt('net', tg.order![0]), 22750 * 0.8,
    'and the view vector is what turns a visible row into that canonical one')

  const hits = searchTarget(tg, { query: 'acme' })
  // rid 102's `name` cell holds a per-cell formula whose RESULT is "acme x",
  // so it matches in Values mode and is locked against rewriting.
  eq(hits.map((h) => [h.row, h.col, h.rid, h.locked ?? null]),
    [[0, 0, 102, 'formula'], [1, 0, 100, null]],
    'a filtered+sorted sheet gives visible rows, real rids, and a lock on the formula cell')
}

{
  // REPLACE THROUGH A FILTER. Only rid 100 is replaceable; the formula cell and
  // the computed column must be refused and counted.
  const s = sheet()
  const tg = buildTarget(doc(s), s, [2, 0])
  const q: FindQuery = { query: 'Acme' }
  const hits = searchTarget(tg, q)
  const plan = planReplace(hits, new Map([["s1", s]]), q, 'Zeta', coerceForColumn)
  eq(plan.done, 1, 'one cell is rewritten')
  eq(plan.skipped, { computed: 0, formula: 1, 'display-only': 0 },
    'the per-cell formula is refused and COUNTED, not skipped in silence')
  eq(plan.patches, [{ op: 'setCells', sheet: 's1', col: 'name', rids: [100], v: ['Zeta Ltd'] }],
    'the patch names the RID — so a filter cannot re-target the write')
}

{
  // The display-only refusal, which is the subtle one: "12,400" is on screen
  // and is nowhere in the file, so there is nothing to substitute into.
  const s = sheet()
  const tg = buildTarget(doc(s), s, null)
  const q: FindQuery = { query: '12,400' }
  const hits = searchTarget(tg, q)
  ok(hits.length === 2, 'the formatted text is findable on both £12,400.00 cells')
  const plan = planReplace(hits, new Map([["s1", s]]), q, '99', coerceForColumn)
  eq(plan.done, 0, 'and none of it is rewritten')
  eq(plan.skipped['display-only'], 2, '…with both refusals reported to the reader')
  eq(plan.patches, [], 'no patch is minted at all')
}

{
  // A replacement lands through the SAME coercion a typed value does, so a
  // money column keeps holding a number.
  const s = sheet()
  const tg = buildTarget(doc(s), s, null)
  const q: FindQuery = { query: '500' }
  const plan = planReplace(searchTarget(tg, q), new Map([["s1", s]]), q, '750', coerceForColumn)
  eq(plan.patches, [{ op: 'setCells', sheet: 's1', col: 'val', rids: [101], v: [750] }],
    'a numeric replacement is coerced back to a NUMBER, not left as the string "750"')
}

{
  // A hand correction (`cells[k].v`) is the layer that wins on screen, so it is
  // the layer a replace has to change. Writing the column underneath it would
  // be an edit that appears to do nothing.
  const s = sheet()
  s.cells!['name:101'] = { v: 'Beta Corp', was: 'Beta Co' }
  const tg = buildTarget(doc(s), s, null)
  const q: FindQuery = { query: 'Beta' }
  const hits = searchTarget(tg, q)
  eq(hits.map((h) => h.viaOverride ?? false), [true], 'the match is recognised as living in an override')
  const plan = planReplace(hits, new Map([["s1", s]]), q, 'Gamma', coerceForColumn)
  eq(plan.patches, [{
    op: 'setOverrides', sheet: 's1', keys: ['name:101'],
    v: [{ v: 'Gamma Corp', was: 'Beta Co' }], dropEmpty: true,
  }], 'the OVERRIDE is rewritten, and its other fields survive')
}

// ------------------------------------------------------------- the key map
{
  const press = (key: string, mod = true, shift = false) =>
    keyToAction({ key, metaKey: mod, ctrlKey: false, shiftKey: shift, altKey: false })
  eq(press('f')?.kind, 'find', '⌘F is claimed by the map — the browser must never get it')
  eq(press('f', true, true)?.kind, 'find', '⇧⌘F is the same verb')
  eq(press('f', false), null, 'a bare "f" still types an "f" into the cell')
  eq(press('g')?.kind, 'findNext', '⌘G steps to the next match')
  eq(actionSig(press('g', true, true)!), 'findNext.back', '…and ⇧⌘G to the previous one')
  eq(keyToAction({ key: 'f', metaKey: true, altKey: true }), null,
    'a modifier the map does not own is not the modified key it does')

  const sigs = new Set(describeBindings().map((r) => r.sig))
  ok(sigs.has('find'), 'the generated shortcut card will carry Find')
  ok(sigs.has('findNext') && sigs.has('findNext.back'),
    '…and both directions of Find next, because the map distinguishes them')
}

// --------------------------------------------------- the wiring, at source
//
// Three claims that are true in the source or nowhere, in the style the other
// dash rigs use: a DOM assertion needs a browser, and these are exactly the
// lines a refactor silently drops.
{
  const grid = readFileSync(new URL('../dash/src/grid.ts', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../dash/src/find.css', import.meta.url), 'utf8')
  ok(/revealCell\(/.test(grid),
    'grid.ts exposes revealCell — the scroll-and-select a windowed grid cannot do with scrollIntoView')
  ok(/mountFind\(/.test(grid),
    'the grid MOUNTS find itself, so no build can ship the virtualiser without the search that makes it honest')
  ok(/dg-find-cur/.test(grid) && /dg-find-cur/.test(css),
    'the current-match class is both painted and styled')
  // styles.css sets `.dg-cell.dg-sel { background: … !important }`. An equally
  // specific rule here would be decided by which file vite emitted first.
  ok(/\.dg-row \.dg-cell\.dg-find\b/.test(css),
    'the find marks out-rank the selection fill by SPECIFICITY, not by source order')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
