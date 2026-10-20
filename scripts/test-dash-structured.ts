#!/usr/bin/env node
// Structured references: Excel's table syntax, resolved through placement.
//
//   node scripts/test-dash-structured.ts
//
// docs/dash-unified.md. `Sales[Amount]`, `Sales[@Amount]`, `Sales[#Totals]`…
// are desugared to A1 just before binding, from where each table is NOW. Rows
// run through the real recalculation. The answers are chosen so a wrong
// resolution cannot coincide with a right one (Amount 10/20/30, Qty 1/2/3).

import { cellKey, recalcWorkbook, workbookSources } from '../dash/src/cellformula.ts'
import { parseRef } from '../dash/src/a1.ts'
import { parseSpec } from '../dash/src/structured.ts'
import type { CanvasCell, DashDoc } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const at = (a1: string) => { const r = parseRef(a1)!; return cellKey(r.row, r.col) }
function grid(cells: Record<string, string | number>) {
  const out: Record<string, CanvasCell> = {}
  for (const [a1, v] of Object.entries(cells)) out[at(a1)] = typeof v === 'string' && v.startsWith('=') ? { f: v } : { v }
  return { id: 'g', name: 'My Grid', kind: 'canvas', cells: out }
}
const sales = (placed?: { on: string; r: number; c: number }) => ({
  id: 'sales', name: 'Sales', kind: 'table', rids: [[1, 3]], nextRid: 4, steps: [],
  columns: [
    { id: 'amount', name: 'Amount', type: 'number' },
    { id: 'qty', name: 'Qty', type: 'number' },
    { id: 'total', name: 'Line total', type: 'number', formula: 'Amount * Qty' },
  ],
  data: { amount: { enc: 'raw', v: [10, 20, 30] }, qty: { enc: 'raw', v: [1, 2, 3] }, total: { enc: 'raw', v: [null, null, null] } },
  totals: { amount: 'sum', qty: 'max' },
  ...(placed ? { placed } : {}),
})
const doc = (...sheets: unknown[]) => ({ format: 'bento/dash', version: 1, docId: 'd', title: 't', sheets } as unknown as DashDoc)
const calc = (d: DashDoc, sheet: string, a1: string) => recalcWorkbook(workbookSources(d)).get(sheet)?.values.get(at(a1))
const errOf = (v: unknown) => (v && typeof v === 'object' && 'code' in (v as object) ? (v as { code: string }).code : v)

console.log('\nthe spec parser')
for (const [spec, want] of [
  ['Amount', { item: 'data', from: 'Amount', to: 'Amount' }],
  ['', { item: 'data' }],
  ['@Qty', { item: 'thisrow', from: 'Qty', to: 'Qty' }],
  ['@[Line total]', { item: 'thisrow', from: 'Line total', to: 'Line total' }],
  ['#Totals', { item: 'totals' }],
  ['[#Totals],[Amount]', { item: 'totals', from: 'Amount', to: 'Amount' }],
  ['[#Headers],[Qty]', { item: 'headers', from: 'Qty', to: 'Qty' }],
  ['[Amount]:[Qty]', { item: 'data', from: 'Amount', to: 'Qty' }],
] as const) {
  ok(JSON.stringify(parseSpec(spec)) === JSON.stringify(want), `[${spec}] parses as ${JSON.stringify(want)}`)
}
ok(parseSpec('#Nonsense') === null, 'an unknown #item is refused, not guessed')

const P = { on: 'g', r: 1, c: 1 } // header at B2, rows B3:D5, totals B6:D6

console.log('\nplaced and unplaced give the SAME answers — only the address differs')
for (const [label, mk] of [['placed', () => sales(P)], ['unplaced', () => sales()]] as const) {
  for (const [f, want] of [
    ['=SUM(Sales[Amount])', 60],
    ['=SUM(Sales[Line total])', 140],
    ['=SUM(Sales[[Amount]:[Qty]])', 66],
    ['=Sales[[#Totals],[Amount]]', 60],
    ['=Sales[[#Totals],[Qty]]', 3],
    ['=Sales[[#Headers],[Qty]]', 'Qty'],
    ['=COUNT(Sales[])', 9],
  ] as const) {
    const v = calc(doc(grid({ H1: f }), mk()), 'g', 'H1')
    ok(v === want, `${label}: ${f} = ${JSON.stringify(want)} (got ${JSON.stringify(v)})`)
  }
}

console.log('\n[@Col] reads the formula\'s own row, and only a row the table has')
{
  // Beside the placed table, row 4 is Sales' second data row (Qty 2).
  const d = doc(grid({ F4: '=Sales[@Qty]*100', F2: '=Sales[@Qty]', F9: '=Sales[@Qty]' }), sales(P))
  ok(calc(d, 'g', 'F4') === 200, `on a data row: =Sales[@Qty]*100 = 200 (got ${JSON.stringify(calc(d, 'g', 'F4'))})`)
  ok(errOf(calc(d, 'g', 'F2')) === '#VALUE!', `on the header row: #VALUE! (got ${JSON.stringify(calc(d, 'g', 'F2'))})`)
  ok(errOf(calc(d, 'g', 'F9')) === '#VALUE!', 'below the table: #VALUE!')
}

console.log('\nwhat is not there is #REF!, never a guess')
{
  const d = doc(grid({ H1: '=SUM(Sales[Nope])', H2: '=Sales[#All]' }), sales())
  ok(errOf(calc(d, 'g', 'H1')) === '#REF!', `a column the table does not have: #REF! (got ${JSON.stringify(calc(d, 'g', 'H1'))})`)
  ok(errOf(calc(d, 'g', 'H2')) === '#REF!', 'the whole of an UNPLACED table (header + data) has no address: #REF!')
}

console.log('\nan error a reference resolves to is a VALUE — IFERROR catches it, as in Excel')
{
  const d = doc(grid({ F9: '=IFERROR(Sales[@Qty], -1)' }), sales(P))
  ok(calc(d, 'g', 'F9') === -1, `=IFERROR(Sales[@Qty], -1) below the table is -1 (got ${JSON.stringify(calc(d, 'g', 'F9'))})`)
}

console.log('\nExcel error literals are values, not names')
{
  const d = doc(grid({ H1: '=#N/A', H2: '=IF(1>2, 1, #DIV/0!)' }))
  ok(errOf(calc(d, 'g', 'H1')) === '#N/A', `=#N/A is #N/A, not #NAME? (got ${JSON.stringify(calc(d, 'g', 'H1'))})`)
  ok(errOf(calc(d, 'g', 'H2')) === '#DIV/0!', `=IF(1>2, 1, #DIV/0!) is #DIV/0! (got ${JSON.stringify(calc(d, 'g', 'H2'))})`)
}

console.log('\nquoted text and other brackets are left alone')
{
  const d = doc(grid({ H1: '="Sales[Amount]"' }), sales(P))
  ok(calc(d, 'g', 'H1') === 'Sales[Amount]', 'inside a string literal it is text')
}

console.log('\nmoving the table moves every answer with it — nothing stored goes stale')
{
  const f = '=SUM(Sales[Amount])+Sales[[#Totals],[Qty]]'
  const a = calc(doc(grid({ A20: f }), sales({ on: 'g', r: 1, c: 1 })), 'g', 'A20')
  const b = calc(doc(grid({ A20: f }), sales({ on: 'g', r: 8, c: 5 })), 'g', 'A20')
  ok(a === 63 && b === 63, `the same formula gives 63 at both placements (got ${a}, ${b})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
