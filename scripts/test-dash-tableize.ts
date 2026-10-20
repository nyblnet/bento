#!/usr/bin/env node
// Format as table / Convert to range, in place.
//
//   node scripts/test-dash-tableize.ts
//
// docs/dash-unified.md. Every row APPLIES the returned patches with the store's
// own `applyPatch` and then recalculates the whole workbook, so what is checked
// is the outcome a reader sees — never the shape of the patch list. The proof
// that matters most: formulas that pointed at the range before keep giving the
// SAME answer after it becomes a table, and after it becomes a range again.

import { applyPatch } from '../dash/src/store.ts'
import { cellKey, recalcWorkbook, workbookSources } from '../dash/src/cellformula.ts'
import { parseRef } from '../dash/src/a1.ts'
import { convertToRange, formatAsTable } from '../dash/src/tableize.ts'
import { judgePlacements, isTab } from '../dash/src/placement.ts'
import type { CanvasCell, CanvasSheet, DashDoc, TableSheet } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))
const apply = (d: DashDoc, patches: unknown[]): DashDoc => {
  const out = clone(d)
  for (const p of patches) applyPatch(out, p as never)
  return out
}
const byId = (d: DashDoc, id: string) => d.sheets.find((s) => s.id === id) as CanvasSheet
const val = (d: DashDoc, sheet: string, a1: string) => {
  const r = parseRef(a1)!
  return recalcWorkbook(workbookSources(d)).get(sheet)?.values.get(cellKey(r.row, r.col))
}
const box = (a: string, b: string) => {
  const x = parseRef(a)!, y = parseRef(b)!
  return { top: x.row, left: x.col, bottom: y.row, right: y.col }
}

// An invoice on a grid: header in B2:C2, three lines, and formulas OUTSIDE the
// range pointing in by address — the idiom promote.ts refused to break.
function invoice(): DashDoc {
  const cells: Record<string, CanvasCell> = {
    B2: { v: 'Item' }, C2: { v: 'Price' },
    B3: { v: 'Tea' }, C3: { v: 3 },
    B4: { v: 'Cake' }, C4: { v: 5 },
    B5: { v: 'Jam' }, C5: { v: 7 },
    E2: { f: '=SUM(C3:C5)' },
    E3: { f: '=C4*10' },
    E4: { f: '=B2' },
  }
  return {
    format: 'bento/dash', version: 1, docId: 'd', title: 't',
    sheets: [
      { id: 'g', name: 'Invoice', kind: 'canvas', cells } as CanvasSheet,
      { id: 'other', name: 'Other', kind: 'canvas', cells: { A1: { f: '=Invoice!C5+1' } } } as CanvasSheet,
    ],
  } as unknown as DashDoc
}

console.log('\nFormat as table: the range becomes a table where it stood')
const before = invoice()
const answers = (d: DashDoc) => [val(d, 'g', 'E2'), val(d, 'g', 'E3'), val(d, 'g', 'E4'), val(d, 'other', 'A1')]
ok(JSON.stringify(answers(before)) === '[15,50,"Item",8]', `CONTROL: before, the formulas read 15, 50, "Item", 8 (got ${JSON.stringify(answers(before))})`)
const made = formatAsTable(before, 'g', box('B2', 'C5'), { sheetId: 'inv', name: 'Lines', at: '2026-10-20' })
ok(made.ok, `formatAsTable succeeds (${made.ok ? '' : made.message})`)
const tabled = apply(before, made.ok ? made.patches : [])
const t = tabled.sheets.find((s) => s.id === 'inv') as TableSheet
ok(!!t && JSON.stringify(t.placed) === '{"on":"g","r":1,"c":1}', `the table sits on the grid with its header at B2 (got ${JSON.stringify(t?.placed)})`)
ok(t?.columns.map((c) => c.name).join() === 'Item,Price' && t.columns[1].type === 'number', 'columns are named from the header row and typed from the data')
ok(!isTab(tabled, t), 'it is not a tab of its own')
ok(['B2', 'C3', 'B5'].every((k) => !byId(tabled, 'g').cells[k]), 'the grid no longer holds the range\'s cells: the table does')
ok(JSON.stringify(answers(tabled)) === '[15,50,"Item",8]', `every formula pointing in by address gives the SAME answer (got ${JSON.stringify(answers(tabled))})`)
ok(t?.steps.length === 0, 'no "copied from" provenance: the table IS the range')

console.log('\nFormat as table refuses what it cannot do in place')
{
  // Data only in B3:C5; the row above (B2:C2) is cleared, then blocked or not.
  const headless = () => { const d = invoice(); const c = (d.sheets[0] as CanvasSheet).cells; delete c.B2; delete c.C2; return d }
  const noHeader = headless()
  ;(noHeader.sheets[0] as CanvasSheet).cells.C2 = { v: 'blocked' }
  const r = formatAsTable(noHeader, 'g', box('B3', 'C5'), { sheetId: 'x', name: 'X', header: false })
  ok(!r.ok && /row above/.test(r.message), 'no header and the row above is occupied: refused, and says why')
  const r2 = formatAsTable(headless(), 'g', box('B3', 'C5'), { sheetId: 'x', name: 'X', header: false })
  ok(r2.ok && r2.placed.r === 1, 'CONTROL: no header but the row above is free — the header goes there')
  const clash = formatAsTable(tabled, 'g', box('C4', 'E6'), { sheetId: 'y', name: 'Y' })
  ok(!clash.ok, 'a range overlapping an existing table is refused')
}

console.log('\nConvert to range: the cells come back where they were')
{
  // Give the table a calculated column, a totals row, and outside formulas in
  // every spelling that names it.
  const d = clone(tabled)
  const tt = d.sheets.find((s) => s.id === 'inv') as TableSheet
  tt.columns.push({ id: 'dbl', name: 'Double', type: 'number', formula: 'Price * 2' })
  ;(tt.data as Record<string, unknown>).dbl = { enc: 'raw', v: [null, null, null] }
  tt.totals = { price: 'sum' } as never
  const g = byId(d, 'g')
  g.cells.G1 = { f: '=SUM(Lines[Price])' }
  g.cells.G2 = { f: '=Lines[[#Totals],[Price]]' }
  g.cells.G3 = { f: '=D4' }
  byId(d, 'other').cells.A2 = { f: '=Lines!B2*100' }
  const pre = [val(d, 'g', 'E2'), val(d, 'g', 'G1'), val(d, 'g', 'G2'), val(d, 'other', 'A2'), val(d, 'g', 'G3')]
  ok(JSON.stringify(pre) === '[15,15,15,500,10]', `CONTROL: on the table, the answers are 15, 15, 15, 500, 10 (got ${JSON.stringify(pre)})`)

  const back = convertToRange(d, 'inv')
  ok(back.ok, 'convertToRange succeeds')
  const after = apply(d, back.ok ? back.patches : [])
  ok(!after.sheets.some((s) => s.id === 'inv'), 'the table is gone')
  const post = [val(after, 'g', 'E2'), val(after, 'g', 'G1'), val(after, 'g', 'G2'), val(after, 'other', 'A2'), val(after, 'g', 'G3')]
  ok(JSON.stringify(post) === JSON.stringify(pre), `every answer is unchanged after converting back (got ${JSON.stringify(post)})`)
  const gg = byId(after, 'g')
  ok(gg.cells.G1?.f === '=SUM(Invoice!C3:C5)', `a structured reference became the cells it meant (G1 is ${gg.cells.G1?.f})`)
  ok(byId(after, 'other').cells.A2?.f === '=Invoice!C4*100', `a dataset address became the grid address of the same cell (got ${byId(after, 'other').cells.A2?.f})`)
  ok(gg.cells.D4?.f === '=C4 * 2', `the calculated column became a formula in each row (D4 is ${gg.cells.D4?.f})`)
  ok(gg.cells.C6?.f === '=SUM(C3:C5)', `the totals row became a formula over the cells above (C6 is ${gg.cells.C6?.f})`)
}

console.log('\nan UNPLACED table converts on its own sheet, header in row 1')
{
  const d = {
    format: 'bento/dash', version: 1, docId: 'd', title: 't',
    sheets: [
      { id: 's', name: 'Sales', kind: 'table', rids: [[1, 2]], nextRid: 3, steps: [],
        columns: [{ id: 'a', name: 'Amount', type: 'number' }], data: { a: { enc: 'raw', v: [4, 6] } } },
      { id: 'o', name: 'Out', kind: 'canvas', cells: { A1: { f: '=Sales!A2' }, A2: { f: '=SUM(Sales[Amount])' } } },
    ],
  } as unknown as DashDoc
  const pre = [val(d, 'o', 'A1'), val(d, 'o', 'A2')]
  const r = convertToRange(d, 's')
  const after = apply(d, r.ok ? r.patches : [])
  const s = after.sheets.find((x) => x.id === 's')!
  ok(s.kind === 'canvas' && after.sheets.indexOf(s) === 0, 'the sheet keeps its id and its place in the tabs, as a grid')
  ok(JSON.stringify([val(after, 'o', 'A1'), val(after, 'o', 'A2')]) === JSON.stringify(pre) && pre[0] === 6,
    `=Sales!A2 (second DATA row, 6) still reads 6 once row 1 is the header (got ${JSON.stringify([val(after, 'o', 'A1'), val(after, 'o', 'A2')])})`)
}

console.log('\nround trip: table → range → table leaves the workbook answering the same')
{
  const back = convertToRange(tabled, 'inv')
  const ranged = apply(tabled, back.ok ? back.patches : [])
  const again = formatAsTable(ranged, 'g', box('B2', 'C5'), { sheetId: 'inv2', name: 'Lines' })
  const re = apply(ranged, again.ok ? again.patches : [])
  ok(JSON.stringify(answers(re)) === '[15,50,"Item",8]', `same answers after a full round trip (got ${JSON.stringify(answers(re))})`)
  ok(judgePlacements(re).honoured.has('inv2'), 'and the new table is placed')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
