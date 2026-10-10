#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash GRID MENUS rig — what a real right-click produces, on all three
// surfaces, and what each item does when it is clicked.
//
//   node scripts/test-dash-menu.ts        (Node ≥ 23.6 strips types natively)
//
// WHY THIS EXISTS, AND WHY IT DRIVES EVENTS RATHER THAN CALLING BUILDERS.
// Two features have now shipped complete, correct and UNREACHABLE: the
// conditional-format rules (finding 5) and the gutter menus (finding 8) — the
// row-number and column-letter strips, which in Excel are where row and column
// work lives, did nothing at all on a right-click. In both cases a rig could
// have been green over the whole thing, because "the builder returns the right
// items" and "the items appear when a person right-clicks" are different facts
// and only the first was ever checked. So every assertion below starts from a
// `contextmenu` event on a real element of a real mounted Grid and reads the
// `.dx-pop` that ends up in the document — the same path a hand takes.
//
// That is also why the menus live in `dash/src/gridmenu.ts` and not in main.ts:
// main.ts boots on evaluation and can never be imported, so while the wiring
// was there NOTHING could test it. `installGridMenus` is both the app's wiring
// and this file's, which is the point — a menu wired only in the rig would be
// the same defect wearing a passing test.
//
// WHAT EACH GROUP GUARDS:
//
//   1. THE THREE MENUS EXIST AND DIFFER. A cell menu, a row menu and a column
//      menu, each opened from its own gutter, each carrying the clipboard verbs
//      (the other reason people right-click, and absent from all of them
//      before). The row menu must NOT offer Fill down or the conditional
//      formats — a fill runs down a column and dash's rules are stored per
//      column, so both would act on something other than the row that was
//      clicked. One shared menu is the failure this checks against.
//   2. THE NEGATIVE CONTROL. A grid with the menus NOT installed must produce
//      NOTHING on the same right-click. Without this the group above passes on
//      a build where `installGridMenus` is never called — which is exactly the
//      state finding 8 describes.
//   3. THE LABELS COUNT THE SELECTION, and the ops act on what the labels say.
//      "Insert 3 rows above" that inserts one is worse than no label.
//   4. ESCAPE CLOSES. Finding 13. The menu opens under the pointer and leaves
//      the hand nowhere near a safe place to click.
//   5. THE COLUMN APPENDER EXISTS. Rows grew a `+` frontier and columns did
//      not, so the app taught a convention and then broke it. It follows the
//      frontier rig's rules: absent in a read-only workbook, and CLICKING IT
//      COSTS NOTHING until the dialog it opens is answered.
//   6. FINDING 11 — an imported per-cell formula and a new row. The formula is
//      carried only when the column PROVES it repeats, and either way the
//      reader is told. Silence is the state this replaces, so the assertion is
//      on the MESSAGE as much as on the cell.

import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const { installDom, mousedown, contextmenu, fireDoc } = await import('./lib/dash-dom.ts')
type El = import('./lib/dash-dom.ts').El

const dom = installDom()

const { parseDoc } = await import('../dash/src/model.ts')
const { Store } = await import('../dash/src/store.ts')
const { Grid } = await import('../dash/src/grid.ts')
const { installGridMenus, rowSpan, colSpan } = await import('../dash/src/gridmenu.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc
type TableSheet = import('../dash/src/model.ts').TableSheet
type MenuHooks = import('../dash/src/gridmenu.ts').MenuHooks

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string): void {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// --------------------------------------------------------------- fixtures

/** `cells` is the per-cell override map — `"colId:rid"` → `{ f }`. */
function dataset(opts: {
  rows?: number
  readOnly?: boolean
  cells?: Record<string, { f: string }>
  extraCol?: boolean
} = {}): DashDoc {
  const n = opts.rows ?? 4
  const columns: Array<Record<string, unknown>> = [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'mon', name: 'Mon', type: 'number' },
    { id: 'tue', name: 'Tue', type: 'number' },
  ]
  if (opts.extraCol) columns.push({ id: 'total', name: 'Total', type: 'number' })
  const data: Record<string, unknown> = {
    name: { enc: 'raw', v: Array.from({ length: n }, (_, i) => `P${i + 1}`) },
    mon: { enc: 'raw', v: Array.from({ length: n }, (_, i) => i + 1) },
    tue: { enc: 'raw', v: Array.from({ length: n }, (_, i) => (i + 1) * 2) },
  }
  if (opts.extraCol) data.total = { enc: 'raw', v: Array.from({ length: n }, () => null) }
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
    readonly: opts.readOnly || undefined,
    sheets: [{
      id: 's1', name: 'Hours', kind: 'table',
      columns, rids: [[1, n]], data,
      ...(opts.cells ? { cells: opts.cells } : {}),
    }],
  }))
  if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.findings)}`)
  return r.doc
}

interface Seen {
  asked: number
  notices: string[]
  toasts: string[]
  copies: boolean[]
  pastes: number
  pasteSpecial: number
  splits: number
  condFmt: number
  filterMenu: string[]
}

function mount(doc: DashDoc, opts: { readOnly?: boolean; install?: boolean } = {}) {
  dom.doc.body.children = []
  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const store = new Store(doc)
  if (opts.readOnly) store.readOnly = true
  const grid = new Grid({ el: host as never, store, sheetId: 's1' })
  const scroll = host.querySelector('.dg-scroll')!
  scroll.clientHeight = 600
  scroll.clientWidth = 900
  const seen: Seen = {
    asked: 0, notices: [], toasts: [], copies: [], pastes: 0,
    pasteSpecial: 0, splits: 0, condFmt: 0, filterMenu: [],
  }
  // The dialog is RESOLVED BY THE TEST, not automatically: "clicking Insert
  // column opens a dialog" and "answering that dialog adds a column" are the
  // two halves of check 5, and an auto-answering stub would collapse them.
  let answer: ((v: Record<string, string> | null) => void) | null = null
  const hooks: MenuHooks = {
    askForm: () => { seen.asked++; return new Promise((res) => { answer = res }) },
    notice: (m) => seen.notices.push(...m),
    toast: (m) => seen.toasts.push(m),
    copy: (cut) => seen.copies.push(cut),
    paste: () => { seen.pastes++ },
    pasteSpecial: () => { seen.pasteSpecial++ },
    split: () => { seen.splits++ },
    condFmt: () => { seen.condFmt++ },
    filterMenu: (id) => seen.filterMenu.push(id),
  }
  if (opts.install !== false) installGridMenus(store, grid, hooks)
  grid.onNotice = (m) => seen.notices.push(...m)
  grid.paint()
  return { host, store, grid, seen, answer: (v: Record<string, string> | null) => answer?.(v) }
}

const sheetOf = (store: { doc: DashDoc }): TableSheet => store.doc.sheets[0] as TableSheet
const rowsIn = (s: TableSheet): number => s.rids.reduce((n, [, c]) => n + c, 0)

/** The menu currently on the document, or null. */
const menu = (): El | null => dom.doc.querySelector('.dx-pop')
/** Its item labels, in order — what a reader would see. */
const items = (): string[] =>
  (menu()?.querySelectorAll('button') ?? []).map((b) => b.textContent)
/** Click the item whose `data-a` is `a`. Returns false when there is no such item. */
function pick(a: string): boolean {
  const b = menu()?.querySelectorAll('button').find((x) => x.getAttribute('data-a') === a)
  if (!b) return false
  b.dispatchEvent({ type: 'click' })
  return true
}
const has = (a: string): boolean =>
  !!menu()?.querySelectorAll('button').some((x) => x.getAttribute('data-a') === a)

const rowGutter = (host: El, row: number): El =>
  host.querySelector(`.dg-row[data-rid] [data-rowhead="${row}"]`)!
const colHeader = (host: El, id: string): El =>
  host.querySelector(`.dg-head-row .dg-h[data-col="${id}"]`)!
const cellAt = (host: El, row: number, ci: number): El =>
  host.querySelector(`.dg-row[data-rid][data-row="${row}"] .dg-cell[data-ci="${ci}"]`)!

// ============================================ 1. three menus, and they differ

console.log('\n1 · a right-click on each surface produces its own menu')

{
  const { host } = mount(dataset())

  contextmenu(cellAt(host, 1, 1))
  ok(!!menu(), 'right-clicking a CELL opens a menu')
  ok(has('cut') && has('copy') && has('paste'),
    'and it carries Cut, Copy and Paste — "the other reason people right-click", ' +
    'and missing from every menu in the app before this')
  ok(has('irow-above') && has('dcol') && has('fill') && has('cf-gt'),
    'along with what it always had: rows, columns, fill and the conditional formats')
  ok(items()[0] === 'Cut' && items()[1] === 'Copy' && items()[2] === 'Paste',
    'the clipboard verbs are FIRST, where every other application in the world ' +
    'puts them — a reader scanning for Copy who meets Insert row concludes this ' +
    'is not the menu they wanted')
  menu()!.remove()

  contextmenu(rowGutter(host, 1))
  ok(!!menu(), 'right-clicking the ROW NUMBER GUTTER opens a menu — it did nothing at all')
  ok(has('cut') && has('copy') && has('paste'), 'the row menu has the clipboard verbs too')
  ok(has('above') && has('below') && has('del') && has('clear'),
    'and insert above / insert below / delete / clear contents, which IS row work')
  ok(!has('fill'),
    'but NOT Fill down: a fill runs down a COLUMN, so a fill offered from a row ' +
    'would act on an axis the reader did not click')
  ok(!has('cf-gt') && !has('cf-scale'),
    'and NOT the conditional formats: dash stores a rule per COLUMN, so a rule ' +
    'added from a row menu would silently colour something else')
  ok(!has('split'), 'and not Split into columns, which is a column operation')
  menu()!.remove()

  contextmenu(colHeader(host, 'mon'))
  ok(!!menu(), 'right-clicking the COLUMN HEADER opens a menu — it did nothing at all')
  ok(has('cut') && has('copy') && has('paste'), 'the column menu has the clipboard verbs too')
  ok(has('left') && has('right') && has('del'),
    'insert left / insert right / delete, which names the axis the reader clicked')
  ok(has('cf-gt') && has('cf-scale') && has('cf-more'),
    'the conditional formats ARE here: they are stored per column, and this is ' +
    'the surface that means a column')
  ok(has('sort') && has('hide'),
    'and the sort/filter menu and Hide, which the caret in the same header owns — ' +
    'reached, not reimplemented')
  ok(!has('above') && !has('below'),
    'and no row inserts, which would be the one-menu-for-everything this splits')
  menu()!.remove()
}

console.log('\n1b · the whole-header target, and the appender\'s gutter')

{
  const { host } = mount(dataset())
  // The letter strip is 19px of a 130px header. A menu that only opened over
  // the letter would miss two clicks in three.
  const head = colHeader(host, 'tue')
  ok(head.querySelector('.dg-letter') !== null,
    'the header cell carries the letter strip, the name and the type badge…')
  contextmenu(head)
  ok(!!menu(), '…and the right-click target is the WHOLE cell, not just the letter')
  menu()!.remove()

  // The appender row has a `+` where a number goes, because the row is not
  // there yet. "Delete row" over a row that does not exist is how a reader
  // learns to stop trusting a menu.
  const add = host.querySelector('.dg-add-row [data-rowhead]')!
  contextmenu(add)
  ok(menu() === null,
    'the APPENDER\'s gutter opens no menu — there is no row there to insert ' +
    'above, delete, or clear')
}

// ================================================== 2. the negative control

console.log('\n2 · negative control — the menus are not free')

{
  // SABOTAGE: the same grid, the same events, `installGridMenus` NOT called.
  // If group 1 still passed here it would be testing a builder and not a
  // feature, which is the exact shape of the two unreachable-feature findings.
  const { host, grid } = mount(dataset(), { install: false })
  ok(grid.onRowMenu === undefined && grid.onColMenu === undefined
    && grid.onContextMenu === undefined,
    'sabotage applied: no menu hook is assigned on this grid')
  contextmenu(cellAt(host, 1, 1))
  ok(menu() === null, 'and a right-click on a cell now produces NOTHING')
  contextmenu(rowGutter(host, 1))
  ok(menu() === null, 'nor on the row gutter')
  contextmenu(colHeader(host, 'mon'))
  ok(menu() === null, 'nor on the column header — so group 1 is a test of the wiring')
}

{
  // The second half of the control: the ITEMS have to come from the click, not
  // from a menu left over from a previous one. `popover` replaces.
  const { host } = mount(dataset())
  contextmenu(colHeader(host, 'mon'))
  const cols = items().length
  contextmenu(rowGutter(host, 1))
  ok(dom.doc.querySelectorAll('.dx-pop').length === 1,
    'a second right-click leaves exactly ONE menu on the document')
  ok(items().length !== cols && has('above'),
    'and it is the row menu, not the column menu still hanging there')
  menu()!.remove()
}

// ============================================ 3. the labels count, and act

console.log('\n3 · the label says how many rows, and the op does that many')

{
  const { host, store, grid } = mount(dataset({ rows: 6 }))
  grid.sel.selectRow(1)
  grid.sel.extendTo(3, 2)
  grid.paint()
  ok(JSON.stringify(rowSpan(grid, 2)) === JSON.stringify({ at: 1, count: 3 }),
    'three selected rows are three canonical rows starting at 1')
  contextmenu(rowGutter(host, 2))
  ok(items().some((s) => s.includes('3 rows')),
    'the menu says "3 rows", so the reader knows what it is about BEFORE clicking')
  ok(pick('above'), 'Insert 3 rows above is there to click')
  ok(rowsIn(sheetOf(store)) === 9,
    'and the sheet grows by THREE — a label that says 3 and inserts 1 is worse ' +
    'than no label at all')
  store.undo()
  ok(rowsIn(sheetOf(store)) === 6, 'one ⌘Z puts all three back — it is one commit')
}

{
  const { host, store, grid } = mount(dataset({ rows: 6 }))
  grid.sel.selectRow(4)
  grid.paint()
  contextmenu(rowGutter(host, 4))
  ok(items().some((s) => s === 'Delete row'),
    'one selected row is spelled "row", singular — the count is read off the selection')
  ok(pick('del') && rowsIn(sheetOf(store)) === 5, 'and Delete row deletes one')
}

{
  // RIGHT-CLICKING OUTSIDE THE SELECTION is about the row under the pointer.
  const { host, store, grid } = mount(dataset({ rows: 6 }))
  grid.sel.selectRow(0)
  grid.sel.extendTo(2, 2)
  grid.paint()
  contextmenu(rowGutter(host, 5))
  ok(items().some((s) => s === 'Delete row'),
    'right-clicking a row OUTSIDE the selection re-selects it, and the menu is ' +
    'about that one row rather than the three the reader has moved away from')
  pick('del')
  ok(rowsIn(sheetOf(store)) === 5 && sheetOf(store).data.name.v.at(-1) === 'P5',
    'and it is the clicked row that goes')
}

console.log('\n3b · the same for columns, in POSITIONS and not visible indexes')

{
  const { host, store, grid } = mount(dataset())
  grid.sel.selectCol(1)
  grid.sel.extendTo(2, 2)
  grid.paint()
  ok(JSON.stringify(colSpan(grid, 'tue').ids) === JSON.stringify(['mon', 'tue']),
    'two selected columns are Mon and Tue')
  contextmenu(colHeader(host, 'tue'))
  ok(items().some((s) => s.includes('2 columns')), 'and the menu says "2 columns"')
  ok(pick('del'), 'Delete 2 columns is there to click')
  ok(sheetOf(store).columns.length === 1 && sheetOf(store).columns[0].id === 'name',
    'and BOTH go — deleted right to left, because each deletion is computed ' +
    'against the sheet as it is at that moment')
  store.undo()
  ok(sheetOf(store).columns.length === 3, 'one ⌘Z brings both back')
}

console.log('\n3c · the items that route out to the app reach it')

{
  const { host, seen } = mount(dataset())
  contextmenu(cellAt(host, 1, 1))
  pick('copy')
  ok(JSON.stringify(seen.copies) === JSON.stringify([false]),
    'Copy calls the app\'s copy — the same path ⌘C takes, so a cut cannot forget ' +
    'to snapshot before the selection is cleared')
  contextmenu(cellAt(host, 1, 1))
  pick('cut')
  ok(JSON.stringify(seen.copies) === JSON.stringify([false, true]), 'and Cut says it is a cut')
  contextmenu(cellAt(host, 1, 1))
  pick('paste')
  ok(seen.pastes === 1, 'Paste asks the app to paste')
  contextmenu(cellAt(host, 1, 1))
  pick('paste-special')
  ok(seen.pasteSpecial === 1, 'Paste special… opens the paste-special menu')
  contextmenu(colHeader(host, 'mon'))
  pick('sort')
  ok(JSON.stringify(seen.filterMenu) === JSON.stringify(['mon']),
    'and Sort and filter… opens the caret\'s OWN menu, for that column — one ' +
    'implementation of hide/sort/filter, reached from two places')
  contextmenu(colHeader(host, 'mon'))
  pick('cf-more')
  ok(seen.condFmt === 1, 'More conditional formatting… still reaches the panel')
}

// =============================================== 4. Escape closes the menu

console.log('\n4 · Escape closes it (finding 13)')

{
  const { host } = mount(dataset())
  contextmenu(rowGutter(host, 1))
  ok(!!menu(), 'a menu is open')
  let defaulted = false
  fireDoc(dom.doc, 'keydown', {
    key: 'Escape',
    preventDefault() { defaulted = true },
    stopPropagation() {},
  })
  ok(menu() === null,
    'Escape closes it. It did not, and a menu that opens under the pointer leaves ' +
    'the hand nowhere near a safe place to click instead')
  ok(defaulted, 'and it claims the key rather than letting it also cancel something else')

  contextmenu(rowGutter(host, 1))
  fireDoc(dom.doc, 'keydown', { key: 'a', preventDefault() {}, stopPropagation() {} })
  ok(!!menu(), 'any OTHER key leaves it open — Escape is the dismissal, not every key')
  menu()!.remove()

  // The listener must not outlive the menu, or the NEXT Escape (meant for a
  // cell editor, or the help card) is swallowed by a menu that is already gone.
  let after = false
  fireDoc(dom.doc, 'keydown', {
    key: 'Escape', preventDefault() { after = true }, stopPropagation() {},
  })
  ok(!after, 'and once the menu is gone its Escape listener is gone with it')
}

// ========================================== 5. the column appender exists

console.log('\n5 · the + past the last column (finding 13)')

{
  const { host, store, seen, answer } = mount(dataset())
  const plus = host.querySelector('.dg-head-row .dg-add-col')
  ok(!!plus, 'there is a + at the right end of the header strip')
  ok(plus!.getAttribute('aria-label') === 'Add a column',
    'and it says what it is, for a reader who cannot see a glyph')
  ok(plus!.getAttribute('role') === 'button' && plus!.className.split(/\s+/).indexOf('dg-h') < 0,
    'it is a BUTTON and not a column header — `aria-colcount` does not count it, ' +
    'so claiming to head a column would announce a column the sheet does not have')

  const before = sheetOf(store).columns.length
  plus!.dispatchEvent({ type: 'click' })
  ok(seen.asked === 1,
    'clicking it asks for a NAME. That is the difference from the row appender: ' +
    'a row is brought into being by typing in it, and a column has nowhere to type')
  ok(sheetOf(store).columns.length === before,
    'and nothing has been added yet — the frontier rule is that selection is free ' +
    'and only writing costs, and the dialog has not been answered')
  answer({ name: 'Wed' })
}

{
  const { host, store, answer } = mount(dataset())
  const plus = host.querySelector('.dg-head-row .dg-add-col')!
  plus.dispatchEvent({ type: 'click' })
  answer({ name: 'Wed' })
  await Promise.resolve()
  await Promise.resolve()
  const s = sheetOf(store)
  ok(s.columns.length === 4 && s.columns[3].name === 'Wed',
    'answering the dialog appends the column, at the END — the only position the ' +
    'control\'s own position on screen could mean')
}

{
  const { host } = mount(dataset({ readOnly: true }), { readOnly: true })
  ok(host.querySelector('.dg-head-row .dg-add-col') === null,
    'a READ-ONLY workbook has no +, the same rule the row appender and the totals ' +
    'row already follow: an invitation that refuses is worse than no invitation')
  ok(host.querySelector('.dg-add-row') === null, 'and no row appender either, unchanged')
}

// ================================= 6. finding 11 — a formula and a new row

console.log('\n6 · an imported per-cell formula, and the row that follows it')

{
  // The timesheet shape: =SUM(B2:C2) down a Total column, one per row, and
  // NOTHING in the model marking the column as formulaic.
  const cells: Record<string, { f: string }> = {}
  for (let i = 0; i < 4; i++) cells[`total:${i + 1}`] = { f: `=SUM(B${i + 1}:C${i + 1})` }
  const { store, grid, seen } = mount(dataset({ cells, extraCol: true }))
  grid.sel.moveTo(4, 0)
  ok(grid.typeInto('P5'), 'typing on the appender makes the row — the "add a person" gesture')
  const s = sheetOf(store)
  ok(rowsIn(s) === 5, 'the sheet has five rows')
  ok(s.cells?.['total:5']?.f === '=SUM(B5:C5)',
    'and Total on the new row holds =SUM(B5:C5) — the formula CARRIED, with its ' +
    'references translated one row exactly as a fill translates them')
  ok(seen.notices.some((m) => m.includes('Total') && m.includes('column formula')),
    'and the reader is TOLD, and pointed at the column formula that would fill ' +
    'every future row without being asked. The silence was the finding')
  store.undo()
  ok(rowsIn(sheetOf(store)) === 4 && sheetOf(store).cells?.['total:5'] === undefined,
    'one ⌘Z takes back the row AND the formula — one commit')
}

{
  // THE TOTALS-ROW TRAP, and the reason this is not "copy the last row's
  // formula". An imported sheet very often ends in a day/grand total, which the
  // import cannot know about (finding 7). Translating THAT down a row is a
  // wrong number that looks exactly like a right one.
  const cells: Record<string, { f: string }> = {
    'total:1': { f: '=SUM(B1:C1)' },
    'total:2': { f: '=SUM(B2:C2)' },
    'total:3': { f: '=SUM(B3:C3)' },
    'total:4': { f: '=SUM(D1:D3)' },        // the day total, sitting under the run
  }
  const { store, grid, seen } = mount(dataset({ cells, extraCol: true }))
  grid.sel.moveTo(4, 0)
  grid.typeInto('P5')
  ok(sheetOf(store).cells?.['total:5'] === undefined,
    'a GRAND TOTAL in the last row is not carried down — the last two rows do not ' +
    'hold the same formula one row apart, so the column has not proved it repeats')
  ok(seen.notices.some((m) => m.includes('Total') && m.includes('empty')),
    'and the refusal SAYS SO, naming the column and why the cell is empty. Any of ' +
    'fill / offer / explain was defensible; silence was not')
}

{
  const { store, grid, seen } = mount(dataset())
  grid.sel.moveTo(4, 0)
  grid.typeInto('P5')
  ok(rowsIn(sheetOf(store)) === 5, 'a sheet with NO cell formulas still appends a row')
  ok(seen.notices.length === 0,
    'and says nothing, because there is nothing to say — a message on every ' +
    'appended row would train the reader to stop reading them')
}

{
  // The other door to a new row: Insert row below, from the gutter menu.
  const cells: Record<string, { f: string }> = {}
  for (let i = 0; i < 4; i++) cells[`total:${i + 1}`] = { f: `=SUM(B${i + 1}:C${i + 1})` }
  const { host, store, grid } = mount(dataset({ cells, extraCol: true }))
  grid.sel.selectRow(3)
  grid.paint()
  contextmenu(rowGutter(host, 3))
  ok(pick('below'), 'Insert row below is on the gutter menu')
  const s = sheetOf(store)
  ok(rowsIn(s) === 5, 'the row is there')
  ok(s.cells?.['total:5']?.f === '=SUM(B5:C5)',
    'and it carries the formula too — the two doors to a new row give one answer')
}

{
  const { host, store, grid } = mount(dataset({
    cells: { 'total:1': { f: '=SUM(B1:C1)' } }, extraCol: true,
  }))
  grid.sel.selectRow(0)
  grid.paint()
  contextmenu(rowGutter(host, 0))
  pick('above')
  ok(sheetOf(store).cells?.['total:1'] === undefined
    || sheetOf(store).cells?.['total:5'] === undefined,
    'inserting at the TOP carries nothing: there is no row above it to read a ' +
    'pattern from, and one row is not a pattern anyway')
}

console.log('\nevery .dx-pop behaves like a .dx-pop')
{
  // TWO DEFECTS, BOTH FOUND IN A BROWSER AND NEITHER VISIBLE TO A RIG THAT
  // MOUNTS ONE MENU ON ONE SHEET.
  //
  // 1. `filterui.ts` builds its own element — `el.className = 'dx-pop dfx'` —
  //    so it took the STYLING of a popover and none of the behaviour. Escape
  //    did nothing on the column menu while working on every other menu in the
  //    app. One class name, two builders, one of them with listeners.
  // 2. A menu survived a SHEET SWITCH. A column menu is about a column, and
  //    after the switch that column may not exist: going from a dataset to a
  //    spreadsheet left "Sort A → Z / Hide this column / Freeze up to this
  //    column" hanging over a sheet with no columns, still wired to the sheet
  //    behind it.
  //
  // Source checks, because both are about which code path a builder took, and
  // comments are stripped so prose about `.dx-pop` cannot satisfy them.
  const src = (f: string) => readFileSync(new URL(`../dash/src/${f}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  const filterui = src('filterui.ts')
  ok(/dismissable\(el\)/.test(filterui),
    'the column menu takes gridmenu’s dismissal wiring, so Escape closes it like every other menu')
  ok(/className = 'dx-pop/.test(filterui) === /dismissable\(/.test(filterui),
    'and anything wearing the .dx-pop class in that file is wired, not just styled')

  ok(/dismissable/.test(src('gridmenu.ts')),
    'gridmenu exports one dismissal implementation rather than keeping it private to popover()')

  ok(/setSheet\(id: string\): void \{\s*document\.querySelector\('\.dx-pop'\)\?\.remove\(\)/.test(src('grid.ts')),
    'and switching sheets closes any open menu — it belonged to the sheet you left')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
