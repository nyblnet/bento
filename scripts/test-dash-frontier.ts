#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash DATASET FRONTIER rig — what is below the last row, and what it does.
//
//   node scripts/test-dash-frontier.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. An 8-row dataset had no row 9: ArrowDown from the last row
// did nothing, pressing `=` there opened the editor on the LAST DATA CELL, and
// the ruled lines under the totals — which look exactly like empty spreadsheet
// rows — were background paint that selected nothing when clicked. The grid
// looked like Excel's infinite canvas and behaved like a table, with nothing on
// screen saying which.
//
// The decision (grid.ts, `frontierRow`) is that the dataset's frontier is
// EXACTLY ONE ROW and it is a control: the lattice stops at the data, and one
// real appender row sits below it that becomes a row when you type in it. The
// unbounded frontier belongs to the spreadsheet kind, which is built and is the
// honest home for `=SUM(` anywhere. Each check below guards a way that decision
// can rot back into the thing it replaced:
//
//   1. THE ROW HAS TO BE REAL. If the appender is paint, or a row with no
//      `data-row`, everything downstream silently reverts: the cursor cannot
//      reach it, a click selects nothing, and we are back to a picture of a row.
//      So the check is that it is in the DOM, that the selection is one row
//      taller than the view, and that ArrowDown from the last data row lands
//      on it.
//   2. TYPING MUST APPEND, AND APPEND ONCE. The whole gesture is "click below
//      the numbers and type". If the append does not fire, the keystroke lands
//      on the last data cell — the original defect, restored. If it fires twice
//      (say from both `typeInto` and the editor's commit) the sheet grows a
//      blank row nobody asked for, per keystroke.
//   3. CLICKING MUST NOT APPEND. A control that grows the file when you look at
//      it is worse than one that does nothing. Selection is free; only writing
//      costs a row.
//   4. THE FRONTIER MUST NOT EXIST UNDER A FILTER. A blank row appended into a
//      filtered view fails the filter and vanishes on the spot: a button that
//      appears to do nothing, and a row the author cannot find afterwards. A
//      SORT is different and is allowed — `buildOrder` sinks blanks to the end
//      in both directions, so the new row stays where it was typed.
//   5. AND NOT IN A READ-ONLY WORKBOOK, where an invitation is a lie. The
//      totals row already follows this rule; the frontier follows it too.
//   6. THE LATTICE MUST STOP. Half the original complaint was drawn, not coded:
//      `background-repeat: repeat-y` ruled rows to the bottom of the viewport
//      forever. Both layers are now sized to the content, and a sheet that
//      grows by a row must grow its lattice by exactly one row.
//   7. NOTHING MAY READ THROUGH THE APPENDER AS IF IT WERE DATA. It has no rid,
//      so a value read there must be null and a Delete over it must write
//      nothing — a clear that appended rows would be the sparseness failure of
//      the canvas kind wearing a dataset's clothes.

import { registerHooks } from 'node:module'

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
const { Grid, frontierRow } = await import('../dash/src/grid.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc
type TableSheet = import('../dash/src/model.ts').TableSheet

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// --------------------------------------------------------------- fixtures

function dataset(n: number, readOnly = false): DashDoc {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
    readonly: readOnly || undefined,
    sheets: [{
      id: 's1', name: 'Sales', kind: 'table',
      columns: [
        { id: 'region', name: 'Region', type: 'text' },
        { id: 'value', name: 'Value', type: 'number' },
      ],
      rids: [[1, n]],
      data: {
        region: { enc: 'raw', v: Array.from({ length: n }, (_, i) => `R${i % 3}`) },
        value: { enc: 'raw', v: Array.from({ length: n }, (_, i) => (i + 1) * 100) },
      },
    }],
  }))
  if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.findings)}`)
  return r.doc
}

function mount(doc: DashDoc, opts: { readOnly?: boolean } = {}) {
  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const store = new Store(doc)
  if (opts.readOnly) store.readOnly = true
  const grid = new Grid({ el: host as never, store, sheetId: 's1' })
  const scroll = host.querySelector('.dg-scroll')!
  scroll.clientHeight = 600
  scroll.clientWidth = 900
  grid.paint()
  return { host, store, grid, scroll }
}

const sheetOf = (store: { doc: DashDoc }): TableSheet => store.doc.sheets[0] as TableSheet
const rowsIn = (s: TableSheet): number => s.rids.reduce((n, [, c]) => n + c, 0)
const addRow = (host: El): El | null => host.querySelector('.dg-add-row')

/** A bare printable keystroke, the way main.ts hands one to the grid. */
const key = (k: string) => ({
  key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false,
  preventDefault() {}, stopPropagation() {},
}) as never

// ------------------------------------------------- 1. the decision, in the pure

console.log('\nwhich view row is the appender')

ok(frontierRow({ rows: 8, viewRows: 8, cols: 2, readOnly: false }) === 8,
  'an unfiltered 8-row sheet offers row 8 (0-based) — one past the last row')
ok(frontierRow({ rows: 8, viewRows: 4, cols: 2, readOnly: false }) === -1,
  'a FILTERED view has none: an appended blank fails the filter and disappears ' +
  'on the spot, which is a control that appears to do nothing')
ok(frontierRow({ rows: 8, viewRows: 8, cols: 2, readOnly: true }) === -1,
  'a read-only workbook has none — the same rule the totals row already follows: ' +
  'an invitation that refuses is worse than no invitation')
ok(frontierRow({ rows: 8, viewRows: 8, cols: 0, readOnly: false }) === -1,
  'a sheet with no visible columns has nothing to type into')
ok(frontierRow({ rows: 0, viewRows: 0, cols: 2, readOnly: false }) === 0,
  'an EMPTY sheet is all frontier — row 0 is the appender, which is the only ' +
  'way a dataset with no rows can ever get one')

// ----------------------------------------------- 2. the row is real, not paint

console.log('\nthe appender is a row in the DOM, not a picture of one')

{
  const { host, grid } = mount(dataset(8))
  const add = addRow(host)
  ok(!!add, 'there is a .dg-add-row below the data')
  ok(add!.getAttribute('data-row') === '8',
    'at view row 8 — one past the eighth row, which is where the reader aims')
  ok(add!.getAttribute('data-rid') === null,
    'and it has NO rid, because it is not a row of the file. That is also what ' +
    'keeps it out of comments.ts\'s rid lookup and the grid\'s own data-rid sweep')
  ok(add!.querySelector('.dg-gutter')!.textContent.includes('+'),
    'its gutter shows + rather than "9" — the row it would be numbered is not ' +
    'there yet, and that is the visual difference between an invitation and data')
  ok(add!.querySelectorAll('.dg-cell[data-ci]').length === 2,
    'one cell per column, each clickable')
  ok(grid.sel.rows === 9,
    'the SELECTION is nine rows tall for an eight-row sheet, so the cursor can ' +
    'reach the appender at all — without this ArrowDown at the bottom is a floor')

  // The gesture from the audit, exactly: arrow down off the last data row.
  grid.sel.moveTo(7, 0)
  const moved = grid.handleKey(key('ArrowDown'))
  ok(moved && grid.sel.cursor.row === 8,
    'ArrowDown from the last data row MOVES — it did nothing at all before')
}

// ------------------------------------------------- 3. typing makes it a row

console.log('\ntyping is what brings the row into being')

{
  const { host, store, grid } = mount(dataset(8))
  ok(rowsIn(sheetOf(store)) === 8, 'eight rows to start')

  // Click the appender first, which is the real gesture and must cost nothing.
  const cell = addRow(host)!.querySelectorAll('.dg-cell[data-ci]')[1]
  mousedown(cell)
  ok(rowsIn(sheetOf(store)) === 8,
    'CLICKING the appender appends nothing. A control that grows the file when ' +
    'you look at it is worse than one that does nothing')
  ok(grid.sel.cursor.row === 8 && grid.sel.cursor.col === 1,
    'it selects, and the cursor is on the column that was clicked')

  const typed = grid.typeInto('9')
  ok(typed, 'a printable key over the appender is handled')
  ok(rowsIn(sheetOf(store)) === 9,
    'and the sheet now has NINE rows — the universal gesture ("click below the ' +
    'numbers and start typing") lands where the reader aimed')
  ok(grid.sel.cursor.row === 8,
    'the cursor stays put, and row 8 is now a real row rather than the appender')
  ok(!!addRow(host) && addRow(host)!.getAttribute('data-row') === '9',
    'and a fresh appender has appeared below it — the frontier is always one row')

}

{
  // The same keystroke on a row that already exists must NOT append. If the
  // append fired on every keystroke rather than only on the frontier, a sheet
  // would gain a blank row per character typed anywhere in it.
  const { store, grid } = mount(dataset(8))
  grid.sel.moveTo(3, 1)
  grid.typeInto('5')
  ok(rowsIn(sheetOf(store)) === 8,
    'typing into an ordinary row appends nothing: the append is a property of ' +
    'the FRONTIER, not of typing')
}

{
  // The other doors into the same behaviour. Each was a separate call site and
  // each could rot separately.
  const { store, grid } = mount(dataset(8))
  grid.sel.moveTo(8, 1)
  grid.setActiveCell('4200')
  ok(rowsIn(sheetOf(store)) === 9 &&
    (sheetOf(store).data.value as { v: unknown[] }).v[8] === 4200,
    'the FORMULA BAR over the appender appends a row and writes into it')
}

{
  const { store, grid } = mount(dataset(8))
  grid.sel.moveTo(8, 0)
  grid.pasteTsv('North\t10\nSouth\t20\nEast\t30')
  ok(rowsIn(sheetOf(store)) === 11,
    'a PASTE onto the appender appends as many rows as the block has lines. ' +
    'Without this the write finds no rid under any line and lands nowhere — a ' +
    'paste that silently does nothing')
  ok((sheetOf(store).data.region as { v: unknown[] }).v[10] === 'East',
    'and the last pasted line is in the last row')
}

{
  const { store, grid } = mount(dataset(8))
  grid.sel.moveTo(8, 0)
  grid.sel.extendTo(8, 1)
  grid.clearSelection()
  ok(rowsIn(sheetOf(store)) === 8,
    'DELETE over the appender appends nothing. Clearing what was never written ' +
    'must leave the file exactly as it found it — a clear that grew the sheet ' +
    'is the sparseness failure of the canvas kind wearing a dataset\'s clothes')
}

// ------------------------------------------- 4. it is absent where it would lie

console.log('\nand it is absent wherever it would be dishonest')

{
  const { host, grid } = mount(dataset(8))
  grid.setFilter('value', { col: 'value', pred: { op: 'greater', v: 400 } })
  grid.paint()
  ok(!addRow(host),
    'FILTERED: no appender. The row would fail the filter and vanish as it was ' +
    'created, and the author would then have a blank row they cannot see')
  ok(grid.sel.rows === 4, 'and the selection is exactly the four rows on screen')

  grid.clearView()
  grid.paint()
  ok(!!addRow(host), 'clearing the filter brings it back')

  grid.addSort('value', 'desc')
  grid.paint()
  ok(!!addRow(host),
    'SORTED is different and keeps it: a sort hides nothing, and buildOrder ' +
    'sinks a blank row to the end in both directions, so a row typed at the ' +
    'bottom stays at the bottom')
  ok(addRow(host)!.getAttribute('data-row') === '8', 'still one past the data')
}

{
  const { host, grid } = mount(dataset(8), { readOnly: true })
  ok(!addRow(host), 'READ-ONLY: no appender, and no invitation that would refuse')
  ok(grid.sel.rows === 8, 'the selection ends at the data')
}

{
  const { host, store, grid } = mount(dataset(0))
  ok(!!addRow(host) && addRow(host)!.getAttribute('data-row') === '0',
    'an EMPTY dataset is one appender and nothing else')
  grid.sel.moveTo(0, 0)
  grid.typeInto('x')
  ok(rowsIn(sheetOf(store)) === 1,
    'and typing in it is the only way a dataset with no rows ever gets one')
}

// ----------------------------------------- 5. the lattice stops at the content

console.log('\nthe ruled lines stop where the sheet does')

{
  const { host, store, grid } = mount(dataset(8))
  const surface = host.querySelector('.dg-table')!
  ok(surface.style.backgroundRepeat === 'no-repeat, no-repeat',
    'NEITHER background layer repeats. `repeat-y` is what ruled empty rows all ' +
    'the way down the viewport — the drawn half of the original complaint, and ' +
    'the reason clicking them selected nothing')
  // ROW_H is 20 and the header is ROW_H + 20; nine rows (eight plus the
  // appender) is 180px of lattice.
  ok(surface.style.backgroundSize.includes('180px'),
    'the lattice is sized to the content, not to the window ' +
    `(got "${surface.style.backgroundSize}")`)

  grid.sel.moveTo(8, 0)
  grid.typeInto('9')
  ok(host.querySelector('.dg-table')!.style.backgroundSize.includes('200px'),
    'and it grows by exactly one row when the sheet does — nine data rows plus ' +
    'one appender is 200px. A lattice that did not track the content would be ' +
    'the same lie a few pixels further down')
}

// --------------------------------------- 6. nothing reads through it as data

console.log('\nnothing reads through the appender as if it held data')

{
  const { host, grid } = mount(dataset(8))
  grid.sel.moveTo(8, 1)
  const tsv = grid.copyTsv()
  ok(tsv === '',
    `copying the appender yields nothing (got ${JSON.stringify(tsv)}) — reading ` +
    'through a -1 rid asks every column for index -1, and undefined dressed up ' +
    'as a value is exactly the kind of number this app exists to refuse')
  const foot = host.querySelector('.dg-foot-row')!
  ok(!foot.textContent.includes('900'),
    'and the footer still totals the eight rows the sheet has: the appender is ' +
    'not a row of the file, so it is not in the sum')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
