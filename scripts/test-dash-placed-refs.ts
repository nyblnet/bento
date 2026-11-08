#!/usr/bin/env node
// A1 references into a table placed on a grid.
//
//   node scripts/test-dash-placed-refs.ts
//
// docs/dash-unified.md: an `A1` ref into a placed table's rectangle reads the
// table — header names, values (calculated columns computed), the totals row —
// in STORED row order. Every row runs through the real workbook recalculation
// (`recalcWorkbook(workbookSources(doc))`), and each has a CONTROL: the same
// formula with the table NOT placed, which must read the grid's own cells —
// so a pass cannot come from the formula engine ignoring placement entirely.

import { cellKey, recalcWorkbook, workbookSources } from '../dash/src/cellformula.ts'
import { parseRef } from '../dash/src/a1.ts'
import type { CanvasCell, DashDoc } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const at = (a1: string) => { const r = parseRef(a1)!; return cellKey(r.row, r.col) }
function grid(id: string, cells: Record<string, string | number>) {
  const out: Record<string, CanvasCell> = {}
  for (const [a1, v] of Object.entries(cells)) out[at(a1)] = typeof v === 'string' && v.startsWith('=') ? { f: v } : { v }
  return { id, name: id === 'g' ? 'Grid' : id, kind: 'canvas', cells: out }
}
// Sales: Amount 10/20/30, Qty 1/2/3, Total = Amount * Qty (a calculated column).
const sales = (placed?: { on: string; r: number; c: number }, totals = true) => ({
  id: 'sales', name: 'Sales', kind: 'table', rids: [[1, 3]], nextRid: 4, steps: [],
  columns: [
    { id: 'amount', name: 'Amount', type: 'number' },
    { id: 'qty', name: 'Qty', type: 'number' },
    { id: 'total', name: 'Total', type: 'number', formula: 'Amount * Qty' },
  ],
  data: { amount: { enc: 'raw', v: [10, 20, 30] }, qty: { enc: 'raw', v: [1, 2, 3] }, total: { enc: 'raw', v: [null, null, null] } },
  ...(totals ? { totals: { amount: 'sum', qty: 'max' } } : {}),
  ...(placed ? { placed } : {}),
})
const doc = (...sheets: unknown[]) => ({ format: 'bento/dash', version: 1, docId: 'd', title: 't', sheets } as unknown as DashDoc)
const value = (d: DashDoc, a1: string) => recalcWorkbook(workbookSources(d)).get('g')?.values.get(at(a1))

// The grid's OWN cells under where the table sits, so the control has
// something distinguishable to read: 900s everywhere under B2:D6.
const under: Record<string, number> = {}
for (const col of ['B', 'C', 'D']) for (let r = 2; r <= 6; r++) under[`${col}${r}`] = 900 + r

// Sales placed with its header at B2: B2:D2 header, B3:D5 rows, B6:D6 totals.
const P = { on: 'g', r: 1, c: 1 }

console.log('\nheader, data and calculated cells read the table')
for (const [f, want, label] of [
  ['=B2', 'Amount', 'the header cell reads the column name'],
  ['=C4', 2, 'a data cell reads the stored value (Qty, row 2)'],
  ['=D5', 90, 'a calculated column reads its computed value (30 × 3)'],
  ['=SUM(B3:B5)', 60, 'a range over the data rows sums the table'],
  ['=SUM(D3:D5)', 140, 'a range over a calculated column sums computed values'],
] as const) {
  const placed = value(doc(grid('g', { ...under, F1: f }), sales(P)), 'F1')
  const control = value(doc(grid('g', { ...under, F1: f }), sales()), 'F1')
  ok(placed === want, `${label}: ${f} = ${JSON.stringify(placed)}`)
  ok(control !== want, `CONTROL ${f}: with the table NOT placed it reads the grid's own cells (${JSON.stringify(control)})`)
}

console.log('\nthe totals row reads the totals')
{
  const d = doc(grid('g', { ...under, F1: '=B6', F2: '=C6' }), sales(P))
  ok(value(d, 'F1') === 60, `=B6 is Amount's sum (got ${JSON.stringify(value(d, 'F1'))})`)
  ok(value(d, 'F2') === 3, `=C6 is Qty's max (got ${JSON.stringify(value(d, 'F2'))})`)
  const noTotals = doc(grid('g', { ...under, F1: '=B6' }), sales(P, false))
  ok(value(noTotals, 'F1') === 906, 'CONTROL: without a totals row, the row below the data is the grid again')
}

console.log('\ngrid cells hidden under a table do not compute')
{
  const d = doc(grid('g', { ...under, C4: '=100+1', F1: '=C4' }), sales(P))
  const r = recalcWorkbook(workbookSources(d)).get('g')!
  ok(!r.values.has(at('C4')), 'a formula hidden under the table produces no value')
  ok(r.values.get(at('F1')) === 2, 'and a reference to that position reads the TABLE (Qty row 2 = 2), not the hidden formula (101)')
  const c = recalcWorkbook(workbookSources(doc(grid('g', { ...under, C4: '=100+1' }), sales()))).get('g')!
  ok(c.values.get(at('C4')) === 101, 'CONTROL: unplaced, the same formula computes')
}

console.log('\nstored order, not view order')
{
  // A view sort lives in steps/view state, never in rids; A1 reads rids order.
  const t = sales(P)
  ;(t as { view?: unknown }).view = { sort: [{ col: 'amount', dir: 'desc' }] }
  ok(value(doc(grid('g', { ...under, F1: '=B3' }), t), 'F1') === 10, '=B3 is the first STORED row (10), whatever a view shows first')
}

console.log('\nthe table\'s own sheet is still reachable by name')
{
  const d = doc(grid('g', { ...under, F1: '=Sales!A1' }), sales(P))
  const v = value(d, 'F1')
  ok(v !== undefined && v !== null, `=Sales!A1 still resolves through the table's own sheet (got ${JSON.stringify(v)})`)
}

console.log('\na merged overlap reads the EARLIER table, like the grid draws it')
{
  const other = { ...sales({ on: 'g', r: 2, c: 2 }), id: 'other', name: 'Other', data: { amount: { enc: 'raw', v: [7, 7, 7] }, qty: { enc: 'raw', v: [7, 7, 7] }, total: { enc: 'raw', v: [null, null, null] } } }
  ok(value(doc(grid('g', { ...under, F1: '=C4' }), sales(P), other), 'F1') === 2, 'the overlapped cell reads Sales (sheet order), not Other')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
