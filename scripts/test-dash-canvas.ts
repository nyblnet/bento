#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash SPREADSHEET-kind rig — the sparse A1 canvas sheet.
//
//   node scripts/test-dash-canvas.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. The kind's whole claim is three words — unbounded, typed by
// cell, sparse — and each of them is a promise that fails INVISIBLY:
//
//   1. UNBOUNDED, BUT NOT ALLOCATED. Clicking twenty rows below the data and
//      typing `=SUM(A1:A5)` has to land, compute, and leave a document holding
//      ONE cell. A frontier that materialised its rows would look identical on
//      screen and quietly write twenty thousand of them into the file — and
//      nothing would ever remove them, because nothing knows they were never
//      wanted. So the check is on `Object.keys(sheet.cells).length`, which is
//      the only number that cannot be fooled by how the grid looks.
//   2. A CLEARED CELL IS GONE, not `{}`. Delete over an empty selection must
//      leave the file byte-identical. An empty object per touched cell is the
//      same failure as (1) wearing different clothes: it survives a save, it
//      re-reads as a cell that exists, and a sheet reached by clearing differs
//      from the same sheet reached by never typing.
//   3. THE KEY IS AN A1 ADDRESS. `validate.ts` raises `bad-canvas-key` for
//      anything else and `preview.ts` parses A1 to find the used range for a
//      file-manager thumbnail — so a sheet keyed `"col,row"` would be flagged
//      by dash's own validator and thumbnail blank. The rig runs the real
//      validator over a sheet this code wrote, which is the only check that
//      cannot drift from what the validator actually says.
//   4. STYLE OUTLIVES CONTENT. `CanvasCell` has carried colour, background,
//      bold and alignment since commit one. Clearing a cell's VALUE must not
//      take them with it, and writing a value must not take a formula's place
//      without removing the formula (a file carrying both can carry a number
//      that disagrees with its own expression).
//
// The DOM is not tested here — a grid that draws in the wrong place is a thing
// you can see, and it was seen, in a browser, against the built single file.
// What is tested is every decision the drawing is made from.

import { registerHooks } from 'node:module'

// grid.ts pulls in find.ts, which imports its stylesheet — Vite's job, not
// Node's. Same stub every other dash rig with a UI import uses.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const {
  canvasKey, canvasPos, canvasUsed, canvasValue, canvasCellEdit, canvasCellClear,
  canvasType, canvasShown, canvasAlign, canvasHasFormulas,
  CANVAS_MAX_ROWS, CANVAS_MAX_COLS,
} = await import('../dash/src/grid.ts')

const { parseDoc } = await import('../dash/src/model.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc
type CanvasSheet = import('../dash/src/model.ts').CanvasSheet
type CanvasCell = import('../dash/src/model.ts').CanvasCell

const { Store } = await import('../dash/src/store.ts')
type Patch = import('../dash/src/store.ts').Patch

const { canvasCellSource, recalcWorkbook, workbookSources, cellKey } =
  await import('../dash/src/cellformula.ts')
const { validateDoc } = await import('../dash/src/validate.ts')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// --------------------------------------------------------------- fixtures

const fresh = (cells: Record<string, CanvasCell> = {}): DashDoc => {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1',
    docId: 'd', title: 'test',
    sheets: [{ id: 'cv1', name: 'Sheet1', kind: 'canvas', cells }],
  }))
  if (!r.ok) throw new Error('fixture does not parse')
  return r.doc
}

const sheetOf = (doc: DashDoc): CanvasSheet => doc.sheets[0] as CanvasSheet
const bodyOf = (doc: DashDoc): string =>
  JSON.stringify({ ...doc, modified: undefined })

/** What the grid commits for one typed cell — the same decision `editCanvas`
 *  makes, expressed as the patch it hands the store. */
function typeInto(doc: DashDoc, row: number, col: number, text: string): Patch | null {
  const s = sheetOf(doc)
  const key = canvasKey(row, col)
  const next = canvasCellEdit(s.cells[key], text)
  if (next === null && s.cells[key] === undefined) return null   // nothing to say
  return { op: 'setCanvasCells', sheet: s.id, cells: { [key]: next } }
}

/** Every formula's computed value, keyed by A1 — what the grid paints. */
function computedOf(doc: DashDoc): Map<string, unknown> {
  const s = sheetOf(doc)
  const out = new Map<string, unknown>()
  const r = recalcWorkbook(workbookSources(doc), doc.modified).get(s.id)
  for (const [k, v] of r?.values ?? []) {
    const [c, row] = k.split(',').map(Number)
    out.set(canvasKey(row, c), v)
  }
  return out
}

// --------------------------------------------------------------- 1. the key

console.log('\nthe key is an A1 address')

ok(canvasKey(0, 0) === 'A1', 'row 0, col 0 is A1')
ok(canvasKey(6, 1) === 'B7', 'row 6, col 1 is B7')
ok(canvasKey(102, 26) === 'AA103', 'row 102, col 26 is AA103 — bijective base 26')
ok(canvasKey(1999, 25) === 'Z2000', 'row 1999, col 25 is Z2000')
// The one that would have been silently wrong. `cellKey` is the RECALC map's
// key and looks plausible in a file; it is not the format's.
ok(canvasKey(6, 1) !== cellKey(6, 1), 'the document key is NOT cellformula.cellKey')
ok(cellKey(6, 1) === '1,6', "…which is `col,row` and stays that way for recalcCells")

const round = [[0, 0], [6, 1], [102, 26], [1999, 25], [999999, 16383]]
ok(round.every(([r, c]) => {
  const p = canvasPos(canvasKey(r, c))
  return p !== null && p.row === r && p.col === c
}), 'every address round-trips through canvasPos')
ok(canvasPos('not a ref') === null, 'a key that is not an address parses as null')
ok(canvasPos('$A$1')?.row === 0, 'an absolute key still reads — a file may hold one')

// --------------------------------------------------------------- 2. typing

console.log('\nwhat typing becomes')

ok(canvasValue('42') === 42, '"42" is the number 42')
ok(canvasValue('-3.5') === -3.5, '"-3.5" is a negative number')
ok(canvasValue('1,200') === 1200, '"1,200" is 1200 — people type separators')
ok(canvasValue('1e3') === 1000, 'exponent notation is a number')
ok(canvasValue('TRUE') === true, '"TRUE" is a boolean')
ok(canvasValue('false') === false, '"false" is a boolean, any case')
ok(canvasValue('2026-01-01') === '2026-01-01', 'an ISO date stays text, as the dataset path stores it')
ok(canvasValue('50%') === '50%', 'a percent stays text — coercing it would invent a FORMAT')
ok(canvasValue('N/A') === 'N/A', 'text is text')
ok(canvasValue('.') === '.', '"." is not the number 0')
ok(canvasValue('+') === '+', '"+" is not the number 0')
ok(canvasValue('0x10') === '0x10', 'hex is not silently 16')

{
  const cell = canvasCellEdit(undefined, '=SUM(A1:A5)')
  ok(cell?.f === '=SUM(A1:A5)', 'a leading = is stored as a FORMULA, = included')
  ok(cell !== null && !('v' in cell), '…and stores no value beside it')
}
{
  const cell = canvasCellEdit({ f: '=1+1' }, '7')
  ok(cell?.v === 7 && cell?.f === undefined, 'typing a value over a formula REMOVES the formula')
}
{
  const cell = canvasCellEdit({ v: 3, bold: true, bg: '#eee' }, '=A1')
  ok(cell?.f === '=A1' && cell?.bold === true && cell?.bg === '#eee',
    'style survives a rewrite; the value it replaced does not')
  ok(cell !== null && !('v' in cell), '…and the stale value is gone, not kept as a cache')
}

// --------------------------------------------------------------- 3. sparse

console.log('\nsparse: a cell nobody wrote does not exist')

ok(canvasCellEdit(undefined, '') === null, 'typing nothing into nothing is nothing')
ok(canvasCellEdit(undefined, '   ') === null, 'whitespace is nothing')
ok(canvasCellClear({ v: 5 }) === null, 'clearing a plain cell REMOVES it, never {}')
{
  const kept = canvasCellClear({ v: 5, bold: true, note: 'why' })
  ok(kept !== null && kept.bold === true && kept.note === 'why' && !('v' in kept),
    'clearing a STYLED cell keeps the style and drops the value')
}

{
  // THE HEADLINE. An empty sheet, a cell twenty rows below anything.
  const doc = fresh()
  const store = new Store(doc)
  const before = bodyOf(doc)
  const p = typeInto(doc, 24, 0, '=SUM(A1:A5)')
  ok(p !== null, 'A25 on an empty sheet is a cell you can type into')
  store.commit(p!)
  const s = sheetOf(store.doc)
  ok(Object.keys(s.cells).length === 1,
    'the sheet holds ONE cell — the twenty-four rows above it were never allocated')
  ok(s.cells.A25?.f === '=SUM(A1:A5)', '…keyed A25, holding the formula')
  ok(computedOf(store.doc).get('A25') === 0,
    '=SUM(A1:A5) over five empty cells is 0 — it computed, it did not throw')

  // and it computes over real numbers
  for (let i = 0; i < 5; i++) store.commit(typeInto(store.doc, i, 0, String((i + 1) * 10))!)
  ok(computedOf(store.doc).get('A25') === 150, 'fill A1:A5 with 10..50 and A25 says 150')
  ok(Object.keys(sheetOf(store.doc).cells).length === 6, 'six cells stored, not 125')

  store.undo()
  ok(computedOf(store.doc).get('A25') === 100, 'one ⌘Z takes the last value back out')
  while (store.canUndo) store.undo()
  ok(bodyOf(store.doc) === before, 'undoing everything leaves the document byte-identical')
  ok(Object.keys(sheetOf(store.doc).cells).length === 0,
    '…including the cell count: an undone cell is GONE, not blank')
}

{
  // Delete over a selection that was never written must write nothing at all.
  const doc = fresh({ A1: { v: 1 } })
  const store = new Store(doc)
  const before = bodyOf(doc)
  const s = sheetOf(doc)
  const cells: Record<string, CanvasCell | null> = {}
  for (let r = 0; r < 20; r++) {
    for (let c = 0; c < 20; c++) {
      const k = canvasKey(r, c)
      if (s.cells[k] === undefined) continue
      cells[k] = canvasCellClear(s.cells[k])
    }
  }
  ok(Object.keys(cells).length === 1,
    'clearing a 400-cell selection touches the ONE cell that exists')
  store.commit({ op: 'setCanvasCells', sheet: s.id, cells })
  ok(Object.keys(sheetOf(store.doc).cells).length === 0, 'and it is removed')
  store.undo()
  ok(bodyOf(store.doc) === before, 'undo restores it exactly')
}

// --------------------------------------------------------------- 4. far apart

console.log('\nsparse at a distance: A1 and Z2000')

{
  const doc = fresh({ A1: { v: 'top left' }, Z2000: { v: 99 } })
  const s = sheetOf(doc)
  const used = canvasUsed(s)
  ok(used.rows === 2000 && used.cols === 26, 'the used range is read off the keys')
  ok(Object.keys(s.cells).length === 2, 'two cells — not 52,000')
  ok(JSON.stringify(doc).length < 400, `the whole workbook is ${JSON.stringify(doc).length} bytes`)

  const t0 = performance.now()
  for (let i = 0; i < 50; i++) canvasUsed(s)
  const perExtent = (performance.now() - t0) / 50
  ok(perExtent < 1, `the extent costs ${perExtent.toFixed(4)}ms — it is per CELL, not per row`)

  // The recalculation must not walk the rectangle either. `canvasCellSource`
  // hands its formulas over (`formulaCells`), so a formula 2,000 rows below the
  // data costs what the formula costs.
  const doc2 = fresh({ A1: { v: 10 }, A2: { v: 20 }, Z2000: { f: '=SUM(A1:A2)*2' } })
  const t1 = performance.now()
  const vals = computedOf(doc2)
  const ms = performance.now() - t1
  ok(vals.get('Z2000') === 60, 'a formula at Z2000 reading A1:A2 computes: 60')
  ok(ms < 50, `…in ${ms.toFixed(2)}ms, without scanning 52,000 positions`)

  const src = canvasCellSource(sheetOf(doc2))
  ok(Array.from(src.formulaCells?.() ?? []).length === 1,
    'the source reports exactly one formula rather than being searched for it')
}

{
  // The pathological address, measured rather than assumed.
  const doc = fresh({ A1: { v: 1 }, A1000000: { f: '=A1+1' } })
  const t0 = performance.now()
  const v = computedOf(doc).get('A1000000')
  const ms = performance.now() - t0
  ok(v === 2, 'a formula a million rows down still computes')
  ok(ms < 100, `…in ${ms.toFixed(2)}ms — sparse, not proportional to the address`)
}

// --------------------------------------------------------------- 5. formulas

console.log('\nformulas, ordered')

{
  const doc = fresh({
    A1: { v: 2 }, A2: { f: '=A1*3' }, A3: { f: '=A2+1' }, B1: { f: '=SUM(A1:A3)' },
  })
  const v = computedOf(doc)
  ok(v.get('A2') === 6, 'A2 = A1*3')
  ok(v.get('A3') === 7, 'A3 = A2+1 — it read the COMPUTED A2, not a blank')
  ok(v.get('B1') === 15, 'B1 sums the column including two computed cells')
}
{
  const doc = fresh({ A1: { f: '=B1' }, B1: { f: '=A1' } })
  const v = computedOf(doc)
  ok(String(v.get('A1')) === '#CYCLE!', 'a cycle is #CYCLE!, never a plausible number')
}
{
  const doc = fresh({ A1: { v: 5 }, B1: { f: '=A1/0' } })
  ok(String(computedOf(doc).get('B1')).startsWith('#'), 'an error is an error code')
}
ok(canvasHasFormulas(sheetOf(fresh({ A1: { v: 1 } }))) === false,
  'a sheet of constants declares no formulas — the recalculation is skipped')
ok(canvasHasFormulas(sheetOf(fresh({ A1: { f: '=1' } }))) === true, '…and one with a formula does')

// --------------------------------------------------------------- 6. display

console.log('\ntyped by cell, not by column')

ok(canvasType(1) === 'number', 'a number is a number')
ok(canvasType('x') === 'text', 'a string is text')
ok(canvasType(true) === 'bool', 'a boolean is a boolean')
// Through `formatValue` — the app's ONE formatter, shared with the dataset
// path, so a number reads the same in both kinds. Its unformatted rule is two
// decimals for a fraction and grouping from 10,000 up, which is not Excel's
// General (1234.5) and is not this file's to change: a second rule here would
// make the same number read differently on two sheets of one workbook.
ok(canvasShown({ v: 1234.5 }, 1234.5) === '1234.50', 'a bare fraction takes the shared default')
ok(canvasShown({ v: 1234 }, 1234) === '1234', 'a whole number keeps no decimals')
ok(canvasShown({ v: 0.42, format: '0%' }, 0.42) === '42%', "the CELL's own format is honoured")
ok(canvasShown({ v: 1234, format: '£#,##0' }, 1234) === '£1,234', 'a currency pattern too')
ok(canvasShown(undefined, null) === '', 'an empty cell shows nothing — never 0')
ok(canvasShown({ f: '=1/0' }, '#DIV/0!') === '#DIV/0!', 'an error prints its code')
// The column a value sits in decides nothing: two cells one above the other,
// one text and one number, align differently. That is the KIND's whole point.
ok(canvasAlign({ v: 1 }, 1) === 'right' && canvasAlign({ v: 'a' }, 'a') === 'left',
  'alignment follows the VALUE, not a column type')
ok(canvasAlign({ v: 1, align: 'left' }, 1) === 'left', "…unless the cell says otherwise")

// --------------------------------------------------------------- 7. bounds

console.log('\nthe bounds are the ones a1.ts can spell')

ok(CANVAS_MAX_COLS === 16_384 && CANVAS_MAX_ROWS === 1_048_576, "Excel's limits")
ok(canvasKey(CANVAS_MAX_ROWS - 1, CANVAS_MAX_COLS - 1) === 'XFD1048576',
  'the last cell is XFD1048576 and it formats')
ok(canvasPos('XFD1048576') !== null, '…and reads back')

// --------------------------------------------------------------- 8. validator

console.log('\nthe validator agrees with what this code writes')

{
  const doc = fresh()
  const store = new Store(doc)
  store.commit(typeInto(doc, 0, 0, 'Revenue')!)
  store.commit(typeInto(store.doc, 0, 1, '1200')!)
  store.commit(typeInto(store.doc, 24, 1, '=SUM(B1:B5)')!)
  const v = validateDoc(store.doc)
  const bad = v.findings.filter((f) => f.code === 'bad-canvas-key')
  ok(bad.length === 0, 'no bad-canvas-key finding on a sheet this code wrote')
  ok(v.counts.fatal === 0, `no fatal findings (${JSON.stringify(v.counts)})`)

  // NEGATIVE CONTROL for the check above: the key format the brief first named
  // must be REFUSED, or the check proves nothing.
  const wrong = fresh()
  ;(wrong.sheets[0] as CanvasSheet).cells[cellKey(6, 1)] = { v: 1 }
  const wv = validateDoc(wrong)
  ok(wv.findings.some((f) => f.code === 'bad-canvas-key'),
    'control: a `col,row` key IS flagged bad-canvas-key — the check can fail')
}

// --------------------------------------------------------------- 9. 100 cells

console.log('\na hundred cells')

{
  const doc = fresh()
  const store = new Store(doc)
  const cells: Record<string, CanvasCell | null> = {}
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) cells[canvasKey(r, c)] = { v: r * 10 + c }
  }
  cells.A12 = { f: '=SUM(A1:A10)' }
  const before = bodyOf(doc)
  store.commit({ op: 'setCanvasCells', sheet: 'cv1', cells })
  ok(Object.keys(sheetOf(store.doc).cells).length === 101, '101 cells stored')
  ok(computedOf(store.doc).get('A12') === 450, 'the total under the block is 450')
  const bytes = JSON.stringify(store.doc).length
  ok(bytes < 3500, `101 cells is ${bytes} bytes (~${Math.round(bytes / 101)}/cell)`)
  store.undo()
  ok(bodyOf(store.doc) === before, 'a hundred-cell paste is ONE undo step')
}

// --------------------------------------------------------------- 10. sizes

console.log('\ncolumn widths and row heights')

{
  const doc = fresh({ A1: { v: 1 } })
  const store = new Store(doc)
  const before = bodyOf(doc)
  store.commit({ op: 'setCanvasSizes', sheet: 'cv1', cols: { C: 180 } })
  ok(sheetOf(store.doc).cols?.C === 180, 'a column width lands under its LETTER')
  store.commit({ op: 'setCanvasSizes', sheet: 'cv1', rows: { '4': 44 } })
  ok(sheetOf(store.doc).rows?.['4'] === 44, 'a row height lands under its 1-based NUMBER')
  store.undo()
  store.undo()
  ok(bodyOf(store.doc) === before,
    'undoing both leaves no `"cols": {}` behind — the container goes with its last key')
  ok(sheetOf(store.doc).cols === undefined && sheetOf(store.doc).rows === undefined,
    '…checked directly, because an empty container is invisible in a diff of values')
}

// ---------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.log(`${failures} FAILED`)
  process.exit(1)
}
