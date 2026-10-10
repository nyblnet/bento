#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash column-menu rig — the value checklist and the operator builder.
//
//   node scripts/test-dash-filterui.ts
//
// WHY THIS EXISTS SEPARATELY FROM test-dash-filter.ts. That rig proves the
// ENGINE: given a predicate, which rows survive. This one proves the MENU
// actually reaches the engine — and that is a different failure, because a menu
// can be perfectly correct and never be called. Four times this month a rig has
// been green over a feature that did nothing on screen, so the load-bearing
// assertions below are all of one shape: mount a REAL grid, dispatch a REAL
// click on a REAL checkbox, and then read `store.order[sheetId]` and assert the
// ROW INDICES it holds. Nothing here asserts that a predicate function returned
// true.
//
// WHAT CAN GO WRONG, and every one of these leaves a grid that looks right:
//
//   1. A TICKED BOX THAT FILTERS NOTHING. The list is built from the column's
//      values and matched with `Set.has`, which is identity — a set holding the
//      number 10 does not match the cell holding "10". The whole round trip
//      (build the list → tick a box → read the surviving rows) is asserted, so
//      a break anywhere along it fails here.
//   2. A LIST THAT IGNORES THE OTHER COLUMNS. Excel builds a column's value
//      list from the rows the OTHER filters left. Building it from the whole
//      sheet offers values that cannot appear, and ticking one empties the
//      grid. Its mirror is worse: including THIS column's own filter deletes
//      the box you just unticked, and the value can never be ticked back.
//   3. A TRUNCATED LIST THAT PRE-TICKS ITSELF. With 50,000 distinct values the
//      list stops at 1,000. If those arrive ticked, the first UNTICK applies an
//      `isOneOf` of the 999 that remain visible and silently hides the 49,000
//      values that were never on screen — one click, tens of thousands of rows,
//      no error state anywhere.
//   4. A FILTER THAT DIRTIES THE FILE. Filtering is view state: no patch, no
//      checkpoint, no dirty flag. A `commit` here means a workbook that saves
//      itself every time somebody ticks a box.
//   5. AN OPERAND READ WRONG. "50%" against a percent column, whose stored
//      value is the FRACTION, must be 0.5 and not 50 — the menu this replaces
//      stripped the sign and kept the digits, so every comparison in a percent
//      column was wrong by a factor of a hundred and looked reasonable.

import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

// The menu co-locates its stylesheet (filterui.ts → filter.css) and reaches
// grid.ts, which reaches find.css. Resolving CSS is Vite's job and not Node's —
// the same stub every other dash rig installs.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const { installDom } = await import('./lib/dash-dom.ts')
type El = import('./lib/dash-dom.ts').El
const dom = installDom()

const { parseDoc } = await import('../dash/src/model.ts')
const { Store } = await import('../dash/src/store.ts')
const { Grid } = await import('../dash/src/grid.ts')
const {
  opsFor, opArity, filterOpLabel, parseOperand, buildPredicate, readPredicate,
  checklistPredicate, describeFilter, listRows, columnMenuReason, openColumnMenu,
  LIST_CAP,
} = await import('../dash/src/filterui.ts')
const { distinctValues, matchKey, BLANK_KEY, buildOrder } = await import('../dash/src/filter.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc
type Predicate = import('../dash/src/filter.ts').Predicate

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// --------------------------------------------------------------- the fixture
//
// Eleven rows, which is the sheet the bounce test was driving when it wrote
// "Stage contains Open + Value greater than 50000 gave '4 of 11 rows', correct".
// The same two filters are rebuilt below through the new menu and must give the
// same four rows.
//
// `region` is arranged so that EAST OCCURS ONLY ON NON-OPEN ROWS: that is what
// makes check 2 discriminating. A region list built from the whole sheet holds
// East; one built from the rows "Stage = Open" left does not, and a fixture
// where every value occurs everywhere would pass either way.

const STAGE = ['Open', 'Won', 'Open', 'Lost', 'Open', 'Won', 'Open', 'Lost', 'Open', 'Won', 'Open']
const VALUE = [10000, 60000, 70000, 5000, 80000, 90000, 20000, 1000, 55000, 30000, 65000]
const REGION = ['North', 'East', 'South', 'East', 'South', 'East', '', 'East', 'North', 'East', 'North']

function pipeline(): DashDoc {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 'Pipeline',
    sheets: [{
      id: 's1', name: 'Pipeline', kind: 'table',
      columns: [
        { id: 'stage', name: 'Stage', type: 'text' },
        { id: 'value', name: 'Value', type: 'number' },
        { id: 'region', name: 'Region', type: 'text' },
      ],
      rids: [[1, 11]],
      data: {
        stage: { enc: 'raw', v: STAGE },
        value: { enc: 'raw', v: VALUE },
        region: { enc: 'raw', v: REGION },
      },
    }],
  }))
  if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.findings)}`)
  return r.doc
}

/** A column of `n` distinct values — the shape no checklist can show. */
function wide(n: number): DashDoc {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 'Wide',
    sheets: [{
      id: 's1', name: 'Ids', kind: 'table',
      columns: [{ id: 'id', name: 'Id', type: 'text' }],
      rids: [[1, n]],
      data: { id: { enc: 'raw', v: Array.from({ length: n }, (_, i) => `id-${i}`) } },
    }],
  }))
  if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.findings)}`)
  return r.doc
}

function spreadsheet(): DashDoc {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
    sheets: [{ id: 'cv1', name: 'Scratch', kind: 'canvas', cells: { A1: { v: 1 } } }],
  }))
  if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.findings)}`)
  return r.doc
}

function mount(doc: DashDoc, sheetId: string) {
  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const store = new Store(doc)
  const grid = new Grid({ el: host as never, store, sheetId })
  const scroll = host.querySelector('.dg-scroll')!
  scroll.clientHeight = 600
  scroll.clientWidth = 900
  grid.paint()
  return { host, store, grid }
}

/** Open the menu into a fresh detached root, so two menus never collide. */
function open(store: unknown, grid: unknown, colId: string) {
  const root = dom.doc.createElement('div')
  dom.doc.body.appendChild(root)
  const el = openColumnMenu({
    store: store as never, grid: grid as never, colId, x: 0, y: 0, root: root as never,
  })
  return el as unknown as El | null
}

/** The labels the checklist is offering, in the order it offers them. */
const labels = (el: El): string[] =>
  el.querySelectorAll('.dfx-list .dfx-item').map((i) => i.textContent)

const boxes = (el: El): El[] => el.querySelectorAll('.dfx-list input[data-k]')
const boxFor = (el: El, label: string): El =>
  boxes(el)[labels(el).indexOf(label)]
const click = (el: El): void => el.dispatchEvent({ type: 'click', target: el })
const press = (el: El, sel: string): void => {
  const b = el.querySelector(sel)!
  ;(b as unknown as { onclick?: () => void }).onclick?.()
}
const view = (store: { order: Record<string, number[] | undefined> }): number[] | undefined =>
  store.order.s1

// =========================================== 1. the operator vocabulary
//
// The report asked for these to REUSE condfmt.ts's twelve rather than invent a
// second, differently-spelled set. `FilterOp` is `CompareOp` widened by three,
// so this is checked by the type system — what is checked here is that the menu
// OFFERS them, and offers each one the right number of boxes.

console.log('\nthe operators')
{
  const text = opsFor('text')
  const num = opsFor('number')
  const date = opsFor('date')
  const all = new Set([...text, ...num, ...date])

  ok(['>', '>=', '<', '<=', '=', '<>', 'between', 'contains', 'startsWith', 'endsWith',
    'blank', 'notBlank'].every((op) => all.has(op as never)),
  'every one of condfmt.ts\'s twelve CompareOps is offered — one vocabulary, not two')
  ok(all.has('notContains' as never) && all.has('topN' as never) && all.has('bottomN' as never),
    'plus the three a FILTER has that a highlight does not: does-not-contain, top N, bottom N')
  ok(num.length === text.length && text.length === date.length && num.length === 15,
    'and EVERY column offers all fifteen — a text column full of digits is the ' +
    'commonest imported shape there is, and hiding "greater than" from it hides ' +
    'the operator from the column that needs it most')
  ok(num[0] === '>' && text[0] === '=' && date[0] === 'between',
    'the column type reorders them (a date filter is a range) — a good guess ' +
    'about what will be asked, not a rule about what may be')

  ok(opArity('blank') === 0 && opArity('notBlank') === 0,
    '"is empty" takes no operand — a box that accepts a value and ignores it is ' +
    'the defect this menu exists to stop repeating')
  ok(opArity('between') === 2 && opArity('>') === 1 && opArity('topN') === 1,
    'between takes two bounds; everything else takes one')
  ok(filterOpLabel('>') === 'greater than' && filterOpLabel('startsWith') === 'starts with',
    'and the labels are condfmtui.ts\'s labels, character for character — one ' +
    'catalog entry, one translation, and the same words in both features')
}

// =========================================== 2. reading what the reader typed

console.log('\nthe operand')
{
  ok(parseOperand('50%', 'percent') === 0.5,
    '"50%" against a percent column is the FRACTION 0.5 — the stored value is a ' +
    'fraction, and the menu this replaces stripped the % and kept the 50, so ' +
    'every comparison in a percent column was out by a factor of a hundred')
  ok(parseOperand('50', 'percent') === 0.5,
    'and a bare 50 typed against a percent column means the same thing, because ' +
    '"50%" is what the reader can see in the cell')
  ok(parseOperand('50', 'number') === 50,
    'a bare 50 against a NUMBER column is fifty and nothing else')
  ok(parseOperand('£50,000', 'money') === 50000,
    'currency glyphs and thousands separators are things people type and do not mean')
  ok(parseOperand('', 'number') === '',
    'an empty box is NOT zero. `Number("")` is 0, and "greater than 0" is a ' +
    'filter nobody asked for')
  ok(parseOperand('n/a', 'number') === 'n/a',
    'and text that is not a number stays TEXT rather than becoming NaN: ' +
    'filter.ts refuses a kind mismatch, where NaN would silently match nothing')
}

// =========================================== 3. the condition, as a predicate

console.log('\nthe condition')
{
  const p = (op: string, a = '', b = ''): Predicate | null =>
    buildPredicate(op as never, a, b, 'number')

  ok(p('>', '') === null && p('contains', '  ') === null,
    'an op with an empty operand is NOT a filter — it is one being written, and ' +
    'applying it would empty the grid and read as a broken application')
  ok(p('between') === null,
    'and a between with both bounds empty constrains nothing, so it is not one either')
  const bt = p('between', '20000', '') as { op: string; lo: unknown; hi: unknown }
  ok(bt.op === 'between' && bt.lo === 20000 && bt.hi === null,
    'ONE empty bound is an OPEN END, though — that is how "20,000 and up" is written')
  ok(p('topN', '0') === null && p('topN', '-2') === null && p('topN', '2.5') === null,
    '"top 0" is nothing, "top -2" is not a question and "top 2.5" is not a rank — ' +
    'all three would otherwise reach rankFilter and answer with an empty grid')
  ok(JSON.stringify(p('topN', '3')) === '{"op":"topN","n":3}', 'a real top-N passes through')
  ok(JSON.stringify(p('blank')) === '{"op":"isBlank"}'
    && JSON.stringify(p('notBlank')) === '{"op":"notBlank"}',
  'the nullary ops need no operand at all')
  ok(JSON.stringify(p('<>', '5')) === '{"op":"notEquals","v":5}',
    'condfmt\'s "<>" is filter.ts\'s "notEquals" — the bridge is here and nowhere else')

  // Re-opening a menu onto a filter that is already applied.
  for (const op of ['>', '>=', '<', '<=', '=', '<>', 'contains', 'notContains',
    'startsWith', 'endsWith', 'blank', 'notBlank', 'between', 'topN', 'bottomN']) {
    const made = buildPredicate(op as never, op === 'topN' || op === 'bottomN' ? '3' : '5', '9', 'number')
    const back = made ? readPredicate(made) : null
    if (!back || back.op !== op) {
      ok(false, `a "${op}" filter re-opens onto its own operator`)
    }
  }
  ok(true, 'every operator round-trips out of an applied filter and back into the ' +
    'menu — otherwise the commonest edit there is (nudge the threshold) becomes ' +
    'a re-authoring from memory')
  ok(readPredicate({ op: 'isOneOf', set: new Set(['a']) }) === null,
    'except the checklist, which is shown as ticks and not as an operator')
  ok(describeFilter({ op: 'greater', v: 50000 }) === 'greater than 50000'
    && describeFilter({ op: 'isOneOf', set: new Set(['a', 'b']) }) === '2 values ticked',
  'and the banner names the live filter where the question is asked — the status ' +
  'bar says how many rows survived, never which column did it')
}

// =========================================== 4. the checklist, as a predicate

console.log('\nthe checklist')
{
  const known = new Map<string, unknown>([['t:open', 'Open'], ['t:won', 'Won'], ['t:lost', 'Lost']])
  const keys = new Set(known.keys())

  ok(checklistPredicate(new Set(keys), known, { keys, complete: true }) === null,
    'EVERYTHING ticked is not a filter: it is normalised away, so the column\'s ' +
    'caret does not light up for a filter that filters nothing')
  ok(checklistPredicate(new Set(keys), known, { keys, complete: false }) !== null,
    'but "everything VISIBLE ticked" on a partial list says nothing about the ' +
    'column and must NOT be read as "no filter" — that is the truncated case, ' +
    'and reading it the other way shows rows the reader excluded')

  const one = checklistPredicate(new Set(['t:open']), known, { keys, complete: true })
  ok(one !== null && one.op === 'isOneOf' && [...one.set][0] === 'Open',
    'a ticked box carries the ORIGINAL value into the set, not its canonical key: ' +
    '`isOneOf` re-keys what it is given, so a set holding "t:open" would match ' +
    'only a cell containing the literal text "t:open"')

  // Ticked across two different searches.
  const acc = new Map<string, unknown>([['t:north', 'North']])
  const t2 = new Set(['t:north'])
  acc.set('t:south', 'South'); t2.add('t:south')
  const both = checklistPredicate(t2, acc, { keys: new Set(['t:north', 't:south', 't:east']), complete: true })
  ok(both !== null && both.set.size === 2,
    'ticks ACCUMULATE across searches — tick North under "nor", type "sou", tick ' +
    'South, and both are still in the filter the reader watched themselves build')

  ok(matchKey(null) === BLANK_KEY,
    'and the blank box has ONE spelling, shared by the list and by the matcher')
}

// =========================================== 5. which rows the list comes from

console.log('\nthe rows a list is built from')
{
  const get = (col: string, row: number): unknown =>
    (col === 'stage' ? STAGE : col === 'region' ? REGION : VALUE)[row]

  ok(listRows(11, get, [], 'region') === null,
    'with no other filters the list is built from every row — and says so with ' +
    'null rather than materialising 0..n, which at 10M rows is the whole point ' +
    'of a columnar engine')

  const openOnly = { col: 'stage', pred: { op: 'isOneOf', set: new Set(['Open']) } as Predicate }
  const rows = listRows(11, get, [openOnly], 'region')
  ok(JSON.stringify(rows) === '[0,2,4,6,8,10]',
    'with Stage=Open applied, the Region list is built from those six rows')
  const seen = distinctValues(get, 'region', 11, LIST_CAP, { rows: rows ?? undefined })
  ok(!seen.values.includes('East') && seen.values.includes('North') && seen.values.includes('South'),
    'so East — which occurs ONLY on rows Stage=Open excluded — is not offered. A ' +
    'list built from the whole sheet offers a value that cannot appear, and ' +
    'ticking it empties the grid')
  ok(seen.values[seen.values.length - 1] === null,
    'and the blank cell on row 6 is still offered, last, as its own box')

  const ownFilter = { col: 'region', pred: { op: 'isOneOf', set: new Set(['North']) } as Predicate }
  const own = listRows(11, get, [ownFilter], 'region')
  ok(own === null,
    'THIS column\'s own filter is dropped before its own list is built. Include ' +
    'it and unticking South deletes the South box, and South can never be ' +
    'ticked back — the filter becomes a one-way door')

  const both = listRows(11, get, [openOnly, ownFilter], 'region')
  ok(JSON.stringify(both) === '[0,2,4,6,8,10]',
    'with both applied, the Region list still honours Stage and still ignores Region')
}

// =========================================== 6. the search, past the cap

console.log('\nthe search, and the cap')
{
  const ids = Array.from({ length: 50_000 }, (_, i) => `id-${i}`)
  const get = (_c: string, row: number): unknown => ids[row]

  const d = distinctValues(get, 'id', ids.length, LIST_CAP)
  ok(d.truncated && d.values.length === LIST_CAP,
    '50,000 distinct values do not fit a checklist: the list stops at 1,000 and ' +
    'REPORTS that it did, rather than presenting a thousand as if it were all')
  const hit = distinctValues(get, 'id', ids.length, LIST_CAP, { match: 'id-49999' })
  ok(hit.values.length === 1 && hit.values[0] === 'id-49999',
    'and the search RE-SCANS the column rather than filtering the visible ' +
    'thousand, so the value at position 49,999 is reachable by typing it. A ' +
    'capped list that cannot be searched past tells the reader their data is ' +
    'not in the column')
  const none = distinctValues(get, 'id', ids.length, LIST_CAP, { match: 'zzz' })
  ok(none.values.length === 0 && !none.truncated,
    'a search that matches nothing says nothing matched — it does not fall back ' +
    'to the unsearched list')
}
{
  const v = ['North', '', 'South', null, 'North']
  const get = (_c: string, row: number): unknown => v[row]
  const d = distinctValues(get, 'r', 5)
  ok(d.values.length === 3 && d.values[2] === null,
    'blanks — empty string and null alike — collapse into ONE box, offered last')
  const s = distinctValues(get, 'r', 5, LIST_CAP, { match: 'nor' })
  ok(s.values.length === 1 && s.values[0] === 'North',
    'and a SEARCH drops that box: a blank contains no substring, so offering it ' +
    'under a search hands back rows the search did not ask for')
}

{
  // The memo `distinctValues` uses to stay affordable at 10M rows tests the RAW
  // value first and only computes a canonical key on a miss. That is only sound
  // because the memo can never SUPPRESS a value the map has not got: "North"
  // and "north" are two raw values and one entry, 10 and "10" are two raw
  // values and one entry. A memo consulted INSTEAD of the map (rather than
  // before it) would show each of those twice, and both boxes would filter
  // identically — which is the list the canonical key exists to prevent.
  const v = ['North', 'north', ' NORTH ', 10, '10', '10.0', 'South']
  const get = (_c: string, row: number): unknown => v[row]
  const d = distinctValues(get, 'x', v.length)
  ok(d.values.length === 3 && d.values[0] === 10,
    'a raw-value memo in front of the canonical map does not defeat it: three ' +
    'spellings of North are one box, three of ten are one box, and the number ' +
    'sorts before the text')
}

// =========================================== 7. THE ROWS. A real grid, real clicks.
//
// Everything above is a function returning a value. What follows is the only
// thing that proves the feature exists: the menu is opened on a mounted grid,
// a checkbox is CLICKED, and `store.order` — the one view vector, which the
// footer totals, the chart, Find and print all read — is asserted to hold
// exactly the right row indices.

console.log('\nthe view vector, after a real click')
{
  const { store, grid } = mount(pipeline(), 's1')
  const before = JSON.stringify(store.doc)

  const el = open(store, grid, 'stage')!
  ok(labels(el).join('|') === 'Lost|Open|Won',
    'the menu opens showing every distinct value in the column, sorted — which ' +
    'is the whole finding: a free-text Contains box cannot tell you what is in a ' +
    'column you have not read')

  click(boxFor(el, 'Won'))
  click(boxFor(el, 'Lost'))
  ok(JSON.stringify(view(store)) === '[0,2,4,6,8,10]',
    'unticking Won and Lost leaves the six Open rows IN THE VIEW VECTOR — not a ' +
    'predicate that would have returned true, the actual row indices the grid, ' +
    'the footer and the chart all read through')
  ok(grid.viewStatus() === '6 of 11 rows',
    'and the status line names the view it produced')

  click(boxFor(el, 'Won'))
  ok(JSON.stringify(view(store)) === '[0,1,2,4,5,6,8,9,10]',
    'ticking Won back RESTORES its rows — the list is computed once at open, so ' +
    'a box cannot vanish under the pointer that just unticked it')
  click(boxFor(el, 'Lost'))
  ok(view(store) === undefined,
    'and with everything ticked again there is NO view vector at all: all-ticked ' +
    'is normalised to no filter rather than to an isOneOf of the whole column')

  ok(JSON.stringify(store.doc) === before && !store.canUndo,
    'through all of that the DOCUMENT IS BYTE-IDENTICAL and the undo stack is ' +
    'empty. Filtering is view state: no patch, no checkpoint, no dirty flag — a ' +
    'commit here is a workbook that saves itself when somebody ticks a box')
}

// =========================================== 8. the bounce test's own sentence

console.log('\ncomposing across columns')
{
  const { store, grid } = mount(pipeline(), 's1')

  const stage = open(store, grid, 'stage')!
  click(boxFor(stage, 'Won'))
  click(boxFor(stage, 'Lost'))

  const value = open(store, grid, 'value')!
  const opEl = value.querySelector('.dfx-op')!
  opEl.value = '>'
  opEl.dispatchEvent({ type: 'change', target: opEl })
  value.querySelector('.dfx-a')!.value = '50000'
  press(value, '[data-a="apply"]')

  ok(JSON.stringify(view(store)) === '[2,4,8,10]' && grid.viewStatus() === '4 of 11 rows',
    'Stage ticked to Open + Value greater than 50000 gives the same four rows the ' +
    'bounce test measured through the old one-box menu — the reach widened and ' +
    'the composition did not change')

  // The list the SECOND column offers, now that the first has filtered.
  const region = open(store, grid, 'region')!
  ok(!labels(region).includes('East'),
    'and the Region menu, opened under those filters, does not offer East: it ' +
    'occurs only on rows Stage=Open has already removed')
  // Now give Region a filter of its own and re-open it: the cheap path (reuse
  // the view vector) is no longer valid, and `listRows` has to rebuild the base
  // without Region's own filter but with Stage's.
  click(boxFor(region, 'South'))
  const again = open(store, grid, 'region')!
  ok(labels(again).join('|') === 'North|South',
    're-opening a column that is ALREADY filtered still offers every value the ' +
    'OTHER columns leave: South is still there to tick back although it was just ' +
    'unticked (its own filter is dropped), while East and the blank are still ' +
    'absent because Stage and Value still exclude the rows carrying them')
  ok(region.querySelector('.dfx-note') !== null,
    'the menu SAYS the list is narrowed by the other columns, rather than ' +
    'leaving the reader to notice a value has gone missing')
}

// =========================================== 9. blanks are a state you can pick

console.log('\nblanks')
{
  const { store, grid } = mount(pipeline(), 's1')
  const el = open(store, grid, 'region')!
  ok(labels(el).join('|') === 'East|North|South|(Blanks)',
    'an empty cell is a value you can filter FOR, offered last and named — ' +
    '"Contains" could never express it')

  press(el, '[data-a="clearcol"]')
  for (const b of boxes(el)) if (b.dataset.k !== BLANK_KEY) click(b)
  ok(JSON.stringify(view(store)) === '[6]',
    'ticking only (Blanks) leaves exactly the row whose Region cell is empty')

  click(boxFor(el, '(Blanks)'))
  ok(JSON.stringify(view(store)) === '[]' && grid.viewStatus() === '0 of 11 rows',
    'and unticking every box shows NO rows and says so. That is the honest ' +
    'reading of a deliberate act — "keep none" — and it is one click to undo, ' +
    'where an empty grid under a silent status line is where a reader concludes ' +
    'the data is gone')
}

// =========================================== 10. fifty thousand distinct values

console.log('\na column no checklist can show')
{
  const { store, grid } = mount(wide(3000), 's1')
  const el = open(store, grid, 'id')!

  ok(boxes(el).length === LIST_CAP && el.querySelector('.dfx-note') !== null,
    'the list stops at 1,000 boxes and carries the note saying so')
  ok(boxes(el).every((b) => !(b as unknown as { checked?: boolean }).checked),
    'AND THEY ARRIVE UNTICKED. Pre-ticking the 1,000 that fit reads as ' +
    '"everything is showing" — and the first untick then applies an isOneOf of ' +
    'the 999 still visible, silently hiding the 2,000 values that were never on ' +
    'screen. A partial list can only honestly mean "keep these"')
  ok(view(store) === undefined,
    'and opening the menu has applied nothing at all')

  click(boxFor(el, 'id-7'))
  ok(JSON.stringify(view(store)) === '[7]',
    'ticking one value keeps exactly its rows — an explicit include list, which ' +
    'is the only thing a truncated list can express')
}

// =========================================== 11. the other sheet kind

console.log('\nthe sheet kind that has no columns')
{
  const { store, grid } = mount(spreadsheet(), 'cv1')
  const why = columnMenuReason(grid as never)
  ok(why !== '' && why.length > 40,
    'a SPREADSHEET refuses, with a reason: it is typed per cell and unbounded, ' +
    'it has no columns to filter by, and `A4` in a formula means the fourth row ' +
    'by POSITION — so hiding rows underneath the addresses would make one ' +
    'reader\'s =SUM(B2:B9) cover different cells than another\'s')
  ok(open(store, grid, 'anything') === null,
    'and the menu does not open on one. (It is unreachable through the UI ' +
    'anyway — a canvas header draws letters with no filter caret — so this is ' +
    'the belt to that braces, in the shape tabs.ts states its refusals)')
  ok(store.order.cv1 === undefined,
    'a canvas sheet is left with NO view vector, which is grid.applyView\'s own ' +
    'rule and the reason nothing here can give it one')
}

// =========================================== 12. top-N ranks the survivors

console.log('\nrank, over what is left')
{
  const { store, grid } = mount(pipeline(), 's1')
  const stage = open(store, grid, 'stage')!
  click(boxFor(stage, 'Won'))
  click(boxFor(stage, 'Lost'))

  const value = open(store, grid, 'value')!
  const opEl = value.querySelector('.dfx-op')!
  opEl.value = 'topN'
  opEl.dispatchEvent({ type: 'change', target: opEl })
  value.querySelector('.dfx-a')!.value = '2'
  press(value, '[data-a="apply"]')

  ok(JSON.stringify(view(store)) === '[2,4]',
    '"top 2" under Stage=Open is the top 2 OF THE OPEN ROWS (80,000 and 70,000) ' +
    '— not the top 2 of the column intersected with them, which is 90,000 and ' +
    '80,000 and would have left ONE row for a filter that asked for two')
  ok(JSON.stringify(buildOrder(11, (c, r) =>
    (c === 'stage' ? STAGE : c === 'region' ? REGION : VALUE)[r],
  [{ col: 'value', pred: { op: 'topN', n: 2 } }], [])) === '[4,5]',
  'and the whole-column top 2 really is a different pair, so the check above ' +
  'discriminates rather than agreeing with itself')
}

console.log('\nboth doors into the column menu reach THIS menu')
{
  // The caret in the column header and the column context menu's "Sort and
  // filter…" are two ways to one thing. This codebase has been bitten three
  // times by giving one door a capability the other lacks — import findings
  // rendered as bullets through one door and a paragraph through the other,
  // defined names carried by one importer and not the other, and the column
  // menu itself, which only ever existed on the caret.
  //
  // Comments are stripped before matching: a check a comment can satisfy is a
  // check that certifies documentation, and one of mine already was.
  const main = readFileSync(new URL('../dash/src/main.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  const doors = [...main.matchAll(/openColumnMenu\(/g)].length
  ok(doors >= 2, `both doors call openColumnMenu (found ${doors})`)
  ok(!/openFilterMenu/.test(main),
    'and the old one-box menu is gone entirely — leaving it is how one door keeps the old behaviour')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
