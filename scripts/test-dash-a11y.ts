#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash grid ACCESSIBILITY rig — the semantics a screen reader reads.
//
//   node scripts/test-dash-a11y.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Before this, grid.ts contained not one `role` and not one
// `aria-` attribute, and after clicking a cell `document.activeElement` was
// BODY. The keyboard model was complete and good the whole time, which is what
// makes the gap fixable — and also what makes it invisible, because everything
// works when you can see it. Every check below guards a failure that is silent
// to a sighted developer:
//
//   1. THE ROW NUMBER A VIRTUALISED GRID REPORTS. This is the one that matters.
//      About forty rows of a 5,000-row view exist in the DOM, so a row's
//      position among its SIBLINGS is meaningless — `aria-rowindex` has to be
//      its position in the whole view. Get it wrong and a screen reader
//      confidently announces "row 3 of 40" in a five-thousand-row sheet, which
//      is worse than announcing nothing, because it is trusted. The same
//      applies across: a spreadsheet windows its COLUMNS too, so a painted
//      column's `aria-colindex` must be its position on the sheet and not its
//      offset in the painted strip.
//   2. AN UNBOUNDED SHEET WITH A FINITE COUNT. The spreadsheet kind's extent is
//      a frontier that grows with the cursor and the window. Publishing it as
//      `aria-rowcount` would announce a size that is both wrong and stale on
//      the next scroll; ARIA's answer for "not known" is -1, and that is the
//      honest one.
//   3. FOCUS THAT GOES NOWHERE. Every paint replaces the body's innerHTML, so
//      the focused cell is destroyed roughly forty times a second while an
//      arrow key is held. Without restoration, focus lands on BODY on the first
//      keystroke, the roving tabindex has no owner, and the grid stops being
//      something a keyboard user is INSIDE. The check is on
//      `document.activeElement` after a click and after a move, because that is
//      the exact thing the audit measured.
//   4. MORE THAN ONE TAB STOP. A grid where every cell is focusable takes three
//      hundred Tab presses to escape, and Tab already means "next cell" here.
//      Exactly one element in the grid may carry `tabindex="0"`.
//   5. A SORT NOBODY IS TOLD ABOUT. The ▲ in the header is the only sort
//      indicator there was. `aria-sort` has to track `this.sorts` — including
//      the second key of a shift-click — and unsorted-but-sortable columns must
//      say `none` rather than omit the attribute, which would claim they cannot
//      be sorted at all.
//   6. A CHATTY LIVE REGION. The view status ("4 of 8 rows · Sorted by Value ▼")
//      has to reach assistive technology, and the lazy way is `aria-live`,
//      which would then interrupt the reader on every sort, filter, sheet
//      switch and structural edit. It is an `aria-describedby` target instead,
//      and this rig fails if anything in the grid ever grows an `aria-live`.
//
// The DOM is `scripts/lib/dash-dom.ts` — a parser and a node tree, not a
// browser. It cannot tell you whether the grid LOOKS right; it can tell you
// exactly what markup the grid emitted, which is all an accessibility tree is
// built from.

import { registerHooks } from 'node:module'

// grid.ts reaches find.ts, which imports its own stylesheet — Vite's job, not
// Node's. The same stub every dash rig with a UI import uses.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const { installDom, mousedown } = await import('./lib/dash-dom.ts')
type El = import('./lib/dash-dom.ts').El

const dom = installDom()

const { parseDoc } = await import('../dash/src/model.ts')
const { Store } = await import('../dash/src/store.ts')
const { Grid, ariaRowIndex, ariaColIndex, ariaRowCount, ariaColCount, ARIA_UNKNOWN } =
  await import('../dash/src/grid.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// --------------------------------------------------------------- fixtures

/** A dataset of `n` rows — big enough that the window is a small fraction. */
function dataset(n: number): DashDoc {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
    sheets: [{
      id: 's1', name: 'Sales', kind: 'table',
      columns: [
        { id: 'region', name: 'Region', type: 'text' },
        { id: 'value', name: 'Value', type: 'number' },
      ],
      rids: [[1, n]],
      data: {
        region: { enc: 'raw', v: Array.from({ length: n }, (_, i) => `R${i % 4}`) },
        value: { enc: 'raw', v: Array.from({ length: n }, (_, i) => i) },
      },
    }],
  }))
  if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.findings)}`)
  return r.doc
}

function spreadsheet(cells: Record<string, unknown>): DashDoc {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
    sheets: [{ id: 'cv1', name: 'Scratch', kind: 'canvas', cells }],
  }))
  if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.findings)}`)
  return r.doc
}

/** Mount a grid into a fresh host with a viewport of a stated size. */
function mount(doc: DashDoc, sheetId: string, view = { h: 600, w: 900 }) {
  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const store = new Store(doc)
  const grid = new Grid({ el: host as never, store, sheetId })
  const scroll = host.querySelector('.dg-scroll')!
  scroll.clientHeight = view.h
  scroll.clientWidth = view.w
  grid.paint()
  return { host, store, grid, scroll }
}

const rowsOf = (host: El): El[] => host.querySelectorAll('.dg-sizer .dg-row')
const ariaRow = (el: El): number => Number(el.getAttribute('aria-rowindex'))
const gridOf = (host: El): El => host.querySelector('.dg-table')!

// --------------------------------------------------- 1. the coordinate maths

console.log('\nthe aria coordinate system')

ok(ariaRowIndex(0) === 2 && ariaColIndex(0) === 2,
  'both axes are 1-based and both count the furniture: the header is row 1 and ' +
  'the row-number gutter is column 1, so the first data cell is (2, 2)')
ok(ariaRowCount(8, false, false) === 9,
  'a plain 8-row view is 8 rows plus the header')
ok(ariaRowCount(8, true, true) === 11,
  'the appender and the totals row are rows too — they carry an aria-rowindex, ' +
  'so a count that omitted them would be SMALLER than the largest index in the ' +
  'grid, which is the one arithmetic error a reader cannot recover from')
ok(ariaColCount(2) === 3, 'the gutter is a column, so two data columns make three')

// ------------------------------------- 2. THE HEADLINE: indices under a window

console.log('\nthe row index describes the view, not the DOM window')

{
  const N = 5000
  const { host, grid, scroll } = mount(dataset(N), 's1')
  scroll.scrollTop = 3000 * 20        // ROW_H is 20; park the window at row 3000
  grid.paint()

  const rows = rowsOf(host)
  ok(rows.length > 0 && rows.length < 100,
    `the window is small — ${rows.length} of ${N} rows are in the DOM, which is ` +
    'the entire reason aria-rowindex has to be stated explicitly')
  // The first painted row is `data-row` in view coordinates; aria has to be
  // that number plus the header, and NOT its position among its siblings.
  const first = rows[0]
  const viewRow = Number(first.getAttribute('data-row'))
  ok(viewRow > 2900,
    'the painted window really is deep in the sheet (guarding the guard: a ' +
    'window stuck at row 0 would pass the next check for the wrong reason)')
  ok(ariaRow(first) === ariaRowIndex(viewRow),
    `the first painted row reports aria-rowindex ${ariaRow(first)} for view row ` +
    `${viewRow} — its place in the FULL view`)
  ok(ariaRow(first) !== 2,
    'and it is emphatically not 2, which is what indexing by DOM position gives')
  ok(rows.every((r, i) => ariaRow(r) === ariaRow(rows[0]) + i),
    'the indices run contiguously through the window, so stepping down a row ' +
    'steps the announced number by one')
  ok(Number(gridOf(host).getAttribute('aria-rowcount')) === ariaRowCount(N, true, true),
    `aria-rowcount is ${N} rows + header + appender + totals, not the ${rows.length} ` +
    'rows that happen to exist — "40 rows" in a 5,000-row sheet is a confident lie')
  ok(Number(gridOf(host).getAttribute('aria-colcount')) === 3,
    'aria-colcount counts the gutter and the two columns')
}

// ------------------------------------------- 3. the same thing, sideways

console.log('\nand the column index describes the sheet, not the painted strip')

{
  // A spreadsheet windows COLUMNS as well as rows — it has 16,384 of them —
  // so the horizontal case is a real one and not a symmetry argument.
  const { host, grid, scroll } = mount(spreadsheet({ A1: { v: 1 }, BA2: { v: 2 } }), 'cv1')
  scroll.scrollLeft = 40 * 100        // CANVAS_COL_W is 100; scroll past column AN
  grid.paint()
  const head = host.querySelectorAll('.dg-head-row .dg-h')
  ok(head.length > 0 && head.length < 60, `${head.length} column headers painted, not 16,384`)
  const ci = Number(head[0].getAttribute('data-ci'))
  ok(ci > 30, 'the painted strip really does start well to the right')
  ok(Number(head[0].getAttribute('aria-colindex')) === ariaColIndex(ci),
    'the leftmost painted column reports its position on the SHEET, not its ' +
    'position in the strip — the DOM to its left is one spacer div')
  const cells = host.querySelectorAll('.dg-sizer .dg-row .dg-cell[data-ci]')
  ok(cells.length > 0 &&
    cells.every((c) => Number(c.getAttribute('aria-colindex')) === ariaColIndex(Number(c.getAttribute('data-ci')))),
    'and every painted cell agrees with its own data-ci')
}

// ----------------------------------------- 4. an unbounded sheet says so

console.log('\na spreadsheet reports its size as unknown')

{
  const { host } = mount(spreadsheet({ A1: { v: 1 } }), 'cv1')
  ok(Number(gridOf(host).getAttribute('aria-rowcount')) === ARIA_UNKNOWN &&
    Number(gridOf(host).getAttribute('aria-colcount')) === ARIA_UNKNOWN,
    'aria-rowcount and aria-colcount are -1, which is ARIA\'s "the total is not ' +
    'known" — publishing the frontier instead would announce a size that grows ' +
    'when the reader scrolls')
  ok(host.querySelectorAll('.dg-head-row .dg-h[aria-sort]').length === 0,
    'and its columns carry no aria-sort at all: a spreadsheet column cannot be ' +
    'sorted, and "none" would claim it can be but is not')
}

// --------------------------------------------------- 5. the structure itself

console.log('\nthe grid is a grid')

{
  const { host } = mount(dataset(12), 's1')
  ok(gridOf(host).getAttribute('role') === 'grid', '.dg-table is role="grid"')
  ok(host.querySelector('.dg-head-row')!.getAttribute('role') === 'row' &&
    host.querySelector('.dg-head-row')!.getAttribute('aria-rowindex') === '1',
    'the header is row 1')
  ok(host.querySelector('.dg-sizer')!.getAttribute('role') === 'rowgroup',
    'the sizer is a rowgroup — it sits BETWEEN the grid and its rows, and a ' +
    'grid whose children are plain divs has no rows at all as far as a screen ' +
    'reader is concerned')
  const body = rowsOf(host)
  ok(body.every((r) => r.getAttribute('role') === 'row'), 'every body row is a row')
  ok(body.every((r) => r.querySelector('.dg-gutter')!.getAttribute('role') === 'rowheader' &&
    r.querySelector('.dg-gutter')!.getAttribute('aria-colindex') === '1'),
    'the row number is the row\'s header, at column 1')
  ok(host.querySelectorAll('.dg-sizer .dg-cell[data-ci]')
    .every((c) => c.getAttribute('role') === 'gridcell'),
    'every data cell is a gridcell')
  ok(host.querySelectorAll('.dg-head-row .dg-h')
    .every((c) => c.getAttribute('role') === 'columnheader'),
    'every column header is a columnheader')
  ok(host.querySelector('.dg-corner')!.getAttribute('role') === 'columnheader' &&
    host.querySelector('.dg-corner')!.getAttribute('aria-colindex') === '1',
    'the corner box is the gutter column\'s header')
  const foot = host.querySelector('.dg-foot-row')!
  ok(foot.getAttribute('role') === 'row' &&
    Number(foot.getAttribute('aria-rowindex')) > Number(body[body.length - 1].getAttribute('aria-rowindex')),
    'the totals row is a row, and it comes after the last body row')
  ok(gridOf(host).getAttribute('aria-label') === 'Sales',
    'the grid is named by its sheet — data, not a UI string, so nothing to translate')
}

// ------------------------------------------------------- 6. sort and filter

console.log('\nsorted and filtered state is announced')

{
  const { host, grid } = mount(dataset(12), 's1')
  const headOf = (col: string): El =>
    host.querySelector(`.dg-head-row .dg-h[data-col="${col}"]`)!
  ok(headOf('value').getAttribute('aria-sort') === 'none' &&
    headOf('region').getAttribute('aria-sort') === 'none',
    'an unsorted column says "none" — SORTABLE but not sorted. Omitting the ' +
    'attribute would say the column cannot be sorted')

  grid.addSort('value', 'asc')
  grid.paint()
  ok(headOf('value').getAttribute('aria-sort') === 'ascending',
    'sorting ascending says so')
  ok(headOf('region').getAttribute('aria-sort') === 'none',
    'and the other column is untouched')

  grid.addSort('region', 'desc')
  grid.paint()
  ok(headOf('value').getAttribute('aria-sort') === 'ascending' &&
    headOf('region').getAttribute('aria-sort') === 'descending',
    'a shift-click\'s SECOND key is announced too — aria-sort is read off the ' +
    'whole `sorts` list, not off the single `sort` the ▲ is drawn from')

  grid.clearView()
  grid.setFilter('region', { col: 'region', pred: { op: 'isOneOf', set: new Set(['R0']) } })
  grid.paint()
  const label = headOf('region').getAttribute('aria-label') ?? ''
  ok(label.includes('Region') && label !== 'Region',
    `the filtered column's accessible NAME says it is filtered ("${label}") — ARIA ` +
    'has no attribute for it, and without this the one column hiding rows ' +
    'sounds exactly like the ones that are not')
  ok((headOf('value').getAttribute('aria-label') ?? null) === null,
    'and an unfiltered column keeps its plain text name')
}

// ------------------------------------------------------- 7. the description

console.log('\nthe view status reaches assistive technology, quietly')

{
  const { host, grid } = mount(dataset(12), 's1')
  const id = gridOf(host).getAttribute('aria-describedby')
  ok(!!id, 'the grid is aria-describedby something')
  const desc = host.querySelector(`#${id}`)
  ok(!!desc, 'and that something exists in the same subtree')
  grid.setFilter('value', { col: 'value', pred: { op: 'greater', v: 5 } })
  grid.paint()
  ok((desc!.textContent ?? '').includes('of 12 rows'),
    `the filtered row count is in the description ("${desc!.textContent}") — a ` +
    'sighted reader gets it from the status bar and a screen-reader user got it ' +
    'from nowhere at all')
  // Scoped to the grid and its description. The find bar's result count IS a
  // polite live region and should be — it answers a question the reader just
  // asked, once, on demand. The view status is not that: it changes on its own.
  ok(gridOf(host).querySelectorAll('[aria-live]').length === 0 &&
    !desc!.hasAttribute('aria-live'),
    'and NOTHING in the grid is a live region. The status changes on every sort, ' +
    'filter, sheet switch and structural edit; a polite live region would read ' +
    'the row count over the top of whatever the reader was doing. Described, it ' +
    'is read on entering the grid and whenever the reader asks')
}

// ----------------------------------------------------- 8. focus and tab stops

console.log('\nfocus is a real thing that lands on a real cell')

{
  const { host, grid, scroll } = mount(dataset(40), 's1')
  ok(dom.doc.activeElement === dom.doc.body, 'nothing is focused before the click')

  const cell = host.querySelector('.dg-row[data-row="3"] .dg-cell[data-ci="1"]')!
  mousedown(cell)
  const active = dom.doc.activeElement
  ok(active !== dom.doc.body,
    'after clicking a cell, document.activeElement is NOT body — which is ' +
    'exactly what the audit measured, and why the grid was invisible to AT')
  ok(active.getAttribute('role') === 'gridcell' &&
    active.getAttribute('data-ci') === '1' &&
    active.parentElement!.getAttribute('data-row') === '3',
    'it is the cell that was clicked, identified by its own coordinates — the ' +
    'paint that the click triggers destroys the node, so this is the FRESH one')

  const one = (): El[] => host.querySelectorAll('[tabindex="0"]')
  ok(one().length === 1 && one()[0] === dom.doc.activeElement,
    'exactly one tab stop in the whole grid, and it is the cursor cell (roving ' +
    'tabindex). 300 focusable cells is 300 Tab presses to get past the grid')

  // Now the case that actually killed it: a repaint.
  const moved = grid.handleKey({
    key: 'ArrowDown', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false,
    preventDefault() {}, stopPropagation() {},
  } as never)
  ok(moved, 'ArrowDown is still handled — the keyboard model is not regressed')
  ok(dom.doc.activeElement !== dom.doc.body,
    'and focus SURVIVED the repaint. Every paint replaces the body innerHTML, so ' +
    'without restoration the first keystroke drops focus to body and never gets ' +
    'it back')
  ok(dom.doc.activeElement.parentElement!.getAttribute('data-row') === '4',
    'focus followed the cursor down one row rather than staying on a detached node')
  ok(host.querySelectorAll('[tabindex="0"]').length === 1,
    'and the tab stop moved with it — still exactly one')

  // Scroll the cursor clean out of the window. Focus must not fall to BODY.
  scroll.scrollTop = 30 * 20
  grid.paint()
  ok(!host.querySelector('.dg-row[data-row="4"]'),
    'the cursor row is no longer painted (guarding the guard)')
  ok(dom.doc.activeElement !== dom.doc.body,
    'focus falls back to the scroller, never to BODY — a virtualised grid can ' +
    'always scroll its cursor out of existence, and dropping the reader out of ' +
    'the grid when they scroll is not an option')
  ok(host.querySelectorAll('[tabindex="0"]').length === 1,
    'and there is still exactly one tab stop, so Tab can get back in')
}

// ---------------------------------------------------------- 9. selected state

console.log('\nselection is a state, not just a colour')

{
  const { host, grid } = mount(dataset(12), 's1')
  grid.sel.moveTo(2, 0)
  grid.sel.extendTo(4, 1)
  grid.paint()
  const sel = host.querySelectorAll('.dg-sizer .dg-cell[aria-selected="true"]')
  ok(sel.length === 6,
    `a 3x2 selection reports six aria-selected cells (got ${sel.length}) — the ` +
    'tint on screen is invisible to a reader who is not looking at it')
  ok(host.querySelectorAll('.dg-sizer .dg-cell[aria-selected="false"]').length > 0,
    'and the unselected cells say so explicitly rather than omitting the attribute')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
