#!/usr/bin/env node
// Inserting and deleting rows and columns on a grid, tables riding along.
//
//   node scripts/test-dash-gridshift.ts
//
// docs/dash-unified.md. Every plan is APPLIED with the store's own
// `applyPatch` and the workbook recalculated, so what is checked is what a
// reader sees; and every plan is UNDONE (inverses in reverse) and compared with
// where it started, because one insert is one undo step. Compared CANONICALLY
// (keys sorted): an undone delete puts its cells back at the end of the map, as
// every existing undo that re-adds a key does, and object key order carries no
// meaning in the format.

import { applyPatch } from '../dash/src/store.ts'
import { cellKey, recalcWorkbook, workbookSources } from '../dash/src/cellformula.ts'
import { parseRef } from '../dash/src/a1.ts'
import { planShift, roomToGrow } from '../dash/src/gridshift.ts'
import { isTab } from '../dash/src/placement.ts'
import type { CanvasSheet, DashDoc, TableSheet } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const J = JSON.stringify
const clone = <T,>(x: T): T => JSON.parse(J(x))
const canon = (x: unknown): string => J(x, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v))

/** Apply patches; return the doc and a function that undoes them all. */
function run(d: DashDoc, patches: unknown[]): DashDoc {
  for (const p of patches) applyPatch(d, p as never)
  return d
}
function roundTrip(d0: DashDoc, patches: unknown[]): boolean {
  const d = clone(d0)
  const inv: unknown[] = []
  for (const p of patches) inv.push(applyPatch(d, p as never).inverse)
  for (const p of inv.reverse()) applyPatch(d, p as never)
  return canon(d) === canon(d0)
}
const val = (d: DashDoc, sheet: string, a1: string) => {
  const r = parseRef(a1)!
  return recalcWorkbook(workbookSources(d)).get(sheet)?.values.get(cellKey(r.row, r.col))
}
const g = (d: DashDoc, id = 'g') => d.sheets.find((s) => s.id === id) as CanvasSheet
const tbl = (d: DashDoc, id: string) => d.sheets.find((s) => s.id === id) as TableSheet

// A grid with numbers in A1:A3, a total in A5, a width, a height, and a table
// placed at C8 (header) with two rows; another sheet that points in.
function book(): DashDoc {
  return {
    format: 'bento/dash', version: 1, docId: 'd', title: 't',
    names: { top: { ref: 'Grid!$A$1' } },
    sheets: [
      { id: 'g', name: 'Grid', kind: 'canvas', cols: { B: 120 }, rows: { '3': 40 },
        cells: { A1: { v: 1 }, A2: { v: 2 }, A3: { v: 3 }, A5: { f: '=SUM(A1:A3)' }, B2: { f: '=A3*10' } } },
      { id: 'o', name: 'Other', kind: 'canvas', cells: { A1: { f: '=Grid!A3+Grid!A5' } } },
      { id: 't', name: 'T', kind: 'table', rids: [[1, 2]], nextRid: 3, steps: [], placed: { on: 'g', r: 7, c: 2 },
        columns: [{ id: 'x', name: 'X', type: 'number' }], data: { x: { enc: 'raw', v: [7, 9] } } },
    ],
  } as unknown as DashDoc
}

console.log('\ninsert a row above the data')
{
  const d0 = book()
  const plan = planShift(d0, 'g', 'row', 1, 1) // before row 2
  ok(plan.ok, 'planned')
  const d = run(clone(d0), plan.ok ? plan.patches : [])
  ok(g(d).cells.A3?.v === 2 && g(d).cells.A4?.v === 3 && !g(d).cells.A2, 'cells below moved down; the new row is empty')
  ok(g(d).cells.A6?.f === '=SUM(A1:A4)', `the total widened to the moved range (got ${g(d).cells.A6?.f})`)
  ok(g(d).cells.B3?.f === '=A4*10', `a formula that moved still points at its moved cell (got ${g(d).cells.B3?.f})`)
  ok(g(d).rows?.['4'] === 40, 'row 3\'s height moved to row 4')
  ok(g(d).cols?.B === 120, 'column widths are untouched by a row insert')
  ok(g(d, 'o').cells.A1?.f === '=Grid!A4+Grid!A6', `another sheet's references follow (got ${g(d, 'o').cells.A1?.f})`)
  ok(J(tbl(d, 't').placed) === '{"on":"g","r":8,"c":2}', 'the table below moved down with the grid')
  ok(val(d, 'o', 'A1') === 9 && val(d, 'g', 'A6') === 6, 'and every answer is the same as before')
  ok(roundTrip(d0, plan.ok ? plan.patches : []), 'undo restores the workbook exactly')
}

console.log('\ndelete rows: references into them become #REF!, never the row that slid up')
{
  const d0 = book()
  const plan = planShift(d0, 'g', 'row', 2, -1) // delete row 3
  const d = run(clone(d0), plan.ok ? plan.patches : [])
  ok(!Object.values(g(d).cells).some((c) => c.v === 3), 'the deleted row\'s cell is gone')
  ok(g(d).cells.A4?.f === '=SUM(A1:A2)', `a range shrinks around the deleted row (got ${g(d).cells.A4?.f})`)
  ok(/#REF!/.test(g(d, 'o').cells.A1?.f ?? ''), `a reference INTO the deleted row is #REF! (got ${g(d, 'o').cells.A1?.f})`)
  ok(!g(d).rows, 'the deleted row\'s height went with it')
  ok(roundTrip(d0, plan.ok ? plan.patches : []), 'undo brings back the cells, the height and the formulas')
}

console.log('\ninsert a column: names and widths follow')
{
  const d0 = book()
  const plan = planShift(d0, 'g', 'col', 0, 1)
  const d = run(clone(d0), plan.ok ? plan.patches : [])
  ok(g(d).cells.B1?.v === 1 && g(d).cells.C2?.f === '=B3*10', 'cells moved right, and a moved formula points at its moved cell')
  ok(g(d).cols?.C === 120 && !g(d).cols?.B, 'column B\'s width moved to C')
  ok(d.names?.top?.ref === 'Grid!$B$1', `an absolute defined name still moves — its cell moved (got ${d.names?.top?.ref})`)
  ok(J(tbl(d, 't').placed) === '{"on":"g","r":7,"c":3}', 'the table moved right')
  ok(roundTrip(d0, plan.ok ? plan.patches : []), 'undo restores it')
}

console.log('\nno cutting through a table')
{
  const d0 = book() // T covers rows 8..10 (0-based 7..9), columns C (2)
  const inside = planShift(d0, 'g', 'row', 8, 1)
  ok(!inside.ok && /cut through the table "T"/.test(inside.message), 'an insert between a table\'s rows is refused, by name')
  const partial = planShift(d0, 'g', 'row', 8, -5)
  ok(!partial.ok, 'a delete that takes part of a table is refused')
  const edge = planShift(d0, 'g', 'row', 7, 1)
  ok(edge.ok, 'CONTROL: inserting directly above the header is fine — the table moves down')
  const whole = planShift(d0, 'g', 'row', 6, -5)
  ok(whole.ok, 'a delete that takes the WHOLE table is allowed…')
  const d = run(clone(d0), whole.ok ? whole.patches : [])
  ok(!tbl(d, 't').placed && isTab(d, tbl(d, 't')) && tbl(d, 't').rids.length === 1, '…and the table is kept as its own sheet, rows intact, not destroyed')
  ok(roundTrip(d0, whole.ok ? whole.patches : []), 'and undo puts it back on the grid')
}

console.log('\nroom to grow')
{
  const d0 = book()
  ok(J(roomToGrow(d0, 't', 1)) === '[]', 'the row under the table is free: no shift needed')
  const busy = clone(d0)
  g(busy).cells.C11 = { v: 'note under the table' }
  g(busy).cells.F11 = { v: 'beside, outside its columns' }
  const room = roomToGrow(busy, 't', 1)
  ok(room.length > 0, 'something sits under the table: make room')
  const d = run(clone(busy), room)
  ok(g(d).cells.C12?.v === 'note under the table', 'the cell under it moved down a row')
  ok(g(d).cells.F12?.v === 'beside, outside its columns', 'a WHOLE row was inserted: a cell beside the table moved too, so no range is split')
  ok(J(tbl(d, 't').placed) === '{"on":"g","r":7,"c":2}', 'the table itself did not move')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
