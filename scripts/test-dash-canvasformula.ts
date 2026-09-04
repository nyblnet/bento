#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash formulas on a SPREADSHEET sheet (`kind: 'canvas'`), and across
// sheets.
//
//   node scripts/test-dash-canvasformula.ts
//
// scripts/test-dash-cellformula.ts already proves the engine — order, cycles,
// errors — against a dense grid literal. This rig is about the two things that
// are different once the sheet is a SPARSE A1 map inside a WORKBOOK, and each
// of them has a way of being wrong that produces a number rather than a
// complaint:
//
//   BLANK IS NOT ZERO      most of a spreadsheet is empty. `=A1+1` on an empty
//                          cell is 1 — blank is zero in ARITHMETIC — but
//                          `AVERAGE` and `MIN` and `COUNT` over a mostly-empty
//                          range must ignore the emptiness, or a 3-number
//                          average silently divides by 100.
//   THE SHEET IS NAMED     `Sheet1!A1` used to bind the LOCAL A1: the scanner
//                          dropped the qualifier. That reports one sheet's
//                          number under another sheet's name, and nothing about
//                          the result looks wrong. A sheet that is not there is
//                          `#REF!`, never a blank; a cycle drawn through
//                          another sheet is `#CYCLE!`, never a settled value.
//   SPARSE STAYS SPARSE    `SUM(A1:A100000)` on a sheet holding three numbers
//                          must cost three cells, not a hundred thousand. That
//                          is measured here, not asserted.

import {
  bindRefs, canvasCellSource, cellKey, evalCell, recalcCells, recalcWorkbook,
  shiftSheetFormulas, tableCellSource, translateCellFormula, workbookSources,
  type CellSource, type SheetSource,
} from '../dash/src/cellformula.ts'
import { isErr, type Cell, type Vec } from '../dash/src/formula.ts'
import { parseRef, rewriteFormulaRefs } from '../dash/src/a1.ts'
import type { CanvasCell, CanvasSheet, DashDoc, TableSheet } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// --- fixtures ----------------------------------------------------------------

/**
 * A spreadsheet sheet from an A1 literal. The KEYS in the file are
 * `cellKey(row, col)` — what `setCanvasCells` writes (store.ts) — so this
 * translates, which is also the check that the two spellings line up.
 */
function canvas(name: string, at: Record<string, string | number | null>): CanvasSheet {
  const cells: Record<string, CanvasCell> = {}
  for (const [a1, v] of Object.entries(at)) {
    const r = parseRef(a1)
    if (!r) throw new Error(`not an address: ${a1}`)
    cells[cellKey(r.row, r.col)] =
      typeof v === 'string' && v.startsWith('=') ? { f: v } : { v }
  }
  return { id: name.toLowerCase(), name, kind: 'canvas', cells }
}

const table = (name: string, cols: string[], rows: unknown[][]): TableSheet => ({
  id: name.toLowerCase(),
  name,
  kind: 'table',
  rids: [[1, rows.length]],
  columns: cols.map((c) => ({ id: c.toLowerCase(), name: c, type: 'number' })),
  data: Object.fromEntries(cols.map((c, i) => [
    c.toLowerCase(), { enc: 'raw', v: rows.map((r) => r[i]) },
  ])),
  steps: [],
} as unknown as TableSheet)

const doc = (...sheets: unknown[]): DashDoc => ({ sheets } as unknown as DashDoc)

const book = (...sheets: unknown[]): Map<string, ReturnType<typeof recalcCells>> =>
  recalcWorkbook(workbookSources(doc(...sheets)))

/**
 * One sheet's result. Keyed by sheet ID, which the document keeps unique —
 * names are not, and every fixture here gives a sheet the id `name.toLowerCase()`.
 */
const res = (b: Map<string, ReturnType<typeof recalcCells>>, sheet: string) =>
  b.get(sheet.toLowerCase())!

/** The computed value at an A1 address on a named sheet of a recalculated book. */
const cell = (b: Map<string, ReturnType<typeof recalcCells>>, sheet: string, a1: string): Cell => {
  const r = parseRef(a1)!
  return res(b, sheet)?.values.get(cellKey(r.row, r.col)) ?? null
}

const code = (v: Cell): string => (isErr(v) ? String(v) : `not an error (${JSON.stringify(v)})`)

console.log('--- a spreadsheet cell computes ----------------------------------')
{
  const s = canvas('Sheet1', { A1: 2, A2: 3, B1: '=A1*A2', B2: '=B1+1' })
  const b = book(s)
  ok(cell(b, 'Sheet1', 'B1') === 6, 'a formula in a sparse cell computes from the cells it names')
  ok(cell(b, 'Sheet1', 'B2') === 7, 'and one that reads it settles after it')
  ok(recalcCells(canvasCellSource(s)).values.get(cellKey(0, 1)) === 6,
    'the same through recalcCells — one sheet is the one-sheet case of a workbook')
}
{
  // The document is keyed by position, and the source has to agree with the
  // store about which position. A row/column transposition here reads a
  // DIFFERENT cell and still produces a number.
  const s = canvas('S', { B3: 41, A1: '=B3+1' })
  ok(s.cells['1,2'] !== undefined, 'B3 is stored at cellKey(row 2, col 1) — `col,row`')
  ok(cell(book(s), 'S', 'A1') === 42, 'and the source reads it back at the same position')
}
{
  const s = canvas('S', { A1: 5, A2: '=A1*2' })
  const src = canvasCellSource(s)
  ok(src.rows === 2 && src.cols === 1, 'the extent is the used range, not a guess')
  ok(src.valueAt(1, 0) === null,
    'a cell holding only a formula stores NO value — its number is computed, and a stale one written back would look authoritative')
}

console.log('\n--- blank is not zero --------------------------------------------')
{
  const s = canvas('S', { A1: 4, A3: 6, B1: '=A2+1', B2: '=SUM(A1:A3)', B3: '=COUNT(A1:A3)',
    B4: '=AVERAGE(A1:A3)', B5: '=MIN(A1:A3)', B6: '=ISBLANK(A2)', B7: '=COUNTBLANK(A1:A3)' })
  const b = book(s)
  ok(cell(b, 'S', 'B1') === 1,
    'blank IS zero in arithmetic: =A2+1 over an empty cell is 1, as in every spreadsheet ever written')
  ok(cell(b, 'S', 'B2') === 10, 'and contributes nothing to a SUM')
  ok(cell(b, 'S', 'B3') === 2,
    'blank is NOT zero in a COUNT — counting it would report three numbers where there are two')
  ok(cell(b, 'S', 'B4') === 5,
    'nor in an AVERAGE: the mean of 4 and 6 is 5, not 10/3 — dividing by the blanks is how a sparse sheet reports a third of the truth')
  ok(cell(b, 'S', 'B5') === 4,
    'nor in a MIN: the smallest number here is 4, and 0 is not on this sheet at all')
  ok(cell(b, 'S', 'B6') === true, 'ISBLANK says so')
  ok(cell(b, 'S', 'B7') === 1, 'and COUNTBLANK counts it')
}
{
  const s = canvas('S', { A1: 1, A2: '=1/0', A3: 3, B1: '=SUM(A1:A3)', B2: '=COUNT(A1:A3)' })
  const b = book(s)
  ok(code(cell(b, 'S', 'B1')) === '#DIV/0!',
    'an ERROR inside a range poisons the aggregate — a total of the cells that happened to work is a number with a piece missing and no way to see it')
  ok(cell(b, 'S', 'B2') === 2, 'COUNT still counts, because counting is not computing')
}

console.log('\n--- sparse ranges cost what the sheet holds ----------------------')
{
  // Three filled cells, and a range naming a hundred thousand. The stray cell
  // in column Z is the point: the sheet's EXTENT is fifty thousand rows, so
  // clipping to the extent is not enough — the clip has to be per column band,
  // or one far-away note costs every range on the sheet.
  const s = canvas('S', { A1: 1, A2: 2, A3: 3, Z50000: 'a note', C1: '=SUM(A1:A100000)' })
  let reads = 0
  const base = canvasCellSource(s)
  const counted: CellSource = { ...base, valueAt: (r, c) => { reads++; return base.valueAt(r, c) } }
  const out = recalcCells(counted)
  ok(out.values.get(cellKey(0, 2)) === 6, 'the sum is right')
  ok(reads <= 3, `and it read ${reads} cells, not 100000 — a sparse range is clipped to what the sheet holds`)
  const deps = bindRefs('SUM(A1:A100000)', {
    has: () => false,
    clip: (r) => base.clipRange!(r),
  }).deps
  ok(deps[0].cells.length === 3, `the binding itself allocates ${deps[0].cells.length} references, not 100000`)
}
{
  // The clip may only move the TAIL. If it moved the head, two ranges of the
  // same shape would stop lining up and SUMIF would pair the wrong rows — so
  // the two columns deliberately START at different rows.
  const s = canvas('S', { A4: 20, B3: 1, B4: 2, D1: '=SUMIF(A1:A5,">15",B1:B5)' })
  ok(cell(book(s), 'S', 'D1') === 2,
    'SUMIF pairs by index across two clipped ranges — the row with 20 in A is the row with 2 in B')
}
{
  // FINDING the formulas must be sparse too. Two cells 50,000 rows apart span
  // 1.3M positions, and a recalculation that walks the rectangle to find them
  // is the same mistake in a different place.
  const s = canvas('S', { A1: 2, Z50000: '=A1*3' })
  let probes = 0
  const base = canvasCellSource(s)
  const counted: CellSource = { ...base, formulaAt: (r, c) => { probes++; return base.formulaAt(r, c) } }
  const out = recalcCells(counted)
  ok(out.values.get(cellKey(49999, 25)) === 6, 'the far-away formula computes')
  ok(probes === 0,
    `and finding it probed the grid ${probes} times instead of walking all 1,300,000 positions — the sheet knows its own formulas`)
}
{
  const s = canvas('S', { A1: 1, A2: '=SUM(A1:XFD1048576)' })
  ok(isErr(cell(book(s), 'S', 'A2')),
    'a range far past any sheet is still refused rather than clipped into an answer — it is a typo whichever sheet it lands on')
}

console.log('\n--- across sheets ------------------------------------------------')
{
  const a = canvas('Data', { A1: 10, A2: 20, A3: 30 })
  const b = canvas('Report', { A1: '=Data!A2', A2: '=SUM(Data!A1:A3)', A3: '=data!a1*2' })
  const r = book(a, b)
  ok(cell(r, 'Report', 'A1') === 20, 'Sheet!A1 reads the cell on THAT sheet')
  ok(cell(r, 'Report', 'A2') === 60, 'a qualified RANGE aggregates over that sheet')
  ok(cell(r, 'Report', 'A3') === 20, 'and the sheet name matches case-insensitively, as Excel matches it')
}
{
  // THE ONE THAT USED TO REPORT ANOTHER SHEET'S NUMBER. Both sheets have an A1
  // and they hold different values, so a scanner that drops the qualifier
  // computes 1 and looks entirely healthy.
  const a = canvas('Data', { A1: 99 })
  const b = canvas('Report', { A1: 1, B1: '=Data!A1' })
  ok(cell(book(a, b), 'Report', 'B1') === 99,
    'a qualified reference reads the OTHER sheet, not the local cell of the same address')
}
{
  const a = canvas('Q3 pipeline', { B2: 7 })
  const b = canvas('Report', { A1: "='Q3 pipeline'!B2 * 2" })
  ok(cell(book(a, b), 'Report', 'A1') === 14, 'a quoted sheet name carries spaces')
  const c = canvas("Ann's deck", { A1: 3 })
  const d = canvas('R', { A1: "='Ann''s deck'!A1" })
  ok(cell(book(c, d), 'R', 'A1') === 3, "and '' inside the quotes is one apostrophe")
}
{
  // A DATASET sheet is addressable by position too, because a workbook holding
  // both kinds is the whole design.
  const t = table('Pipeline', ['Region', 'Value'], [[1, 100], [2, 250], [3, 400]])
  const s = canvas('Report', { A1: '=Pipeline!B2', A2: '=SUM(Pipeline!B1:B3)' })
  const r = book(t, s)
  ok(cell(r, 'Report', 'A1') === 250, 'Pipeline!B2 is the second row of the second column of that table')
  ok(cell(r, 'Report', 'A2') === 750, 'and a range over it sums the column')
}
{
  // A hand correction overlays the column, and a reference must see the
  // correction — it is what the sheet SHOWS.
  const t = table('Pipeline', ['Value'], [[100], [250]])
  t.cells = { 'value:2': { v: 999 } }
  const s = canvas('R', { A1: '=Pipeline!A2' })
  ok(cell(book(t, s), 'R', 'A1') === 999, 'a per-cell override is what a cross-sheet reference reads')
}
{
  // A COMPUTED column (formula.ts owns those) reaches a cross-sheet reference
  // only if the caller hands the computed values over.
  const t = table('Pipeline', ['Value'], [[100], [250]])
  t.columns.push({ id: 'dbl', name: 'Double', type: 'number', formula: 'Value*2' } as never)
  const s = canvas('R', { A1: '=Pipeline!B1' })
  const comp = new Map<string, Vec>([['dbl', [200, 500]]])
  const sources = workbookSources(doc(t, s), (sheet) => (sheet.id === 'pipeline' ? comp : undefined))
  const r = recalcWorkbook(sources)
  ok(cell(r, 'R', 'A1') === 200, 'a computed column is visible across sheets when its values are supplied')
}
{
  const s = canvas('R', { A1: '=Nope!A1', A2: '=Nope!A1+1', A3: '=SUM(Nope!A1:A9)' })
  const b = book(s)
  ok(code(cell(b, 'R', 'A1')) === '#REF!',
    'a reference to a sheet that is not there is #REF! — NOT a blank, which would read as a cell nobody had filled in yet')
  ok(code(cell(b, 'R', 'A2')) === '#REF!',
    'and it takes the whole formula with it rather than becoming a zero inside the arithmetic')
  ok(code(cell(b, 'R', 'A3')) === '#REF!',
    'a range on a missing sheet is #REF! too, not an empty sum of nothing')
}
{
  const s = canvas('R', { A1: '=Data!A1' })
  ok(code(recalcCells(canvasCellSource(s)).values.get(cellKey(0, 0))!) === '#REF!',
    'recalcCells alone sees ONE sheet, so a qualified name there is honestly #REF! rather than quietly local')
}
{
  const p = { id: 'p1', name: 'Pivot', kind: 'pivot', pivot: {} }
  const s = canvas('R', { A1: '=Pivot!B4' })
  ok(code(cell(book(p, s), 'R', 'A1')) === '#N/A',
    'a pivot sheet exists but its cells are derived: #N/A, because a blank would say the sheet is empty when it is visibly full of numbers')
}

console.log('\n--- order and cycles span the workbook ---------------------------')
{
  // The chain runs BACKWARDS against sheet order: the first sheet's cell needs
  // the last sheet's, which needs the middle one's. Anything that recalculates
  // sheet by sheet computes the first from an unsettled value.
  const a = canvas('A', { A1: '=C!A1+1' })
  const b = canvas('B', { A1: 5 })
  const c = canvas('C', { A1: '=B!A1*2' })
  const r = book(a, b, c)
  ok(cell(r, 'C', 'A1') === 10, 'C!A1 = B!A1*2 = 10')
  ok(cell(r, 'A', 'A1') === 11,
    'A!A1 = C!A1+1 = 11 — settled in dependency order even though the dependency runs against sheet order')
}
{
  const a = canvas('A', { A1: '=B!A1' })
  const b = canvas('B', { A1: '=A!A1' })
  const r = book(a, b)
  ok(code(cell(r, 'A', 'A1')) === '#CYCLE!', 'a cycle THROUGH another sheet is a cycle')
  ok(code(cell(r, 'B', 'A1')) === '#CYCLE!', 'on both ends of it, not just the one noticed second')
  ok(res(r, 'A').cycles.length === 1 && res(r, 'B').cycles.length === 1,
    'and each sheet reports its own half rather than the workbook shrugging')
}
{
  const a = canvas('A', { A1: '=B!A1' })
  const b = canvas('B', { A1: '=C!A1' })
  const c = canvas('C', { A1: '=A!A1', B1: 7, B2: '=B1*3' })
  const r = book(a, b, c)
  ok(code(cell(r, 'B', 'A1')) === '#CYCLE!', 'a three-sheet circle is caught too')
  ok(cell(r, 'C', 'B2') === 21, 'and a cell that is not in it still computes — a cycle does not poison the workbook')
}
{
  // A sheet referring to ITSELF by name is the same node as the bare address.
  // Two nodes for one cell would make this circle invisible.
  const s = canvas('S', { A1: '=S!A1+1' })
  ok(code(cell(book(s), 'S', 'A1')) === '#CYCLE!',
    'a self-qualified reference is the SAME cell, so =S!A1+1 on sheet S is a cycle of one')
}
{
  const a = canvas('Data', { A1: 3 })
  const b = canvas('R', { A1: '=Data!A1*2' })
  ok(cell(book(b, a), 'R', 'A1') === 6, 'sheet order in the file decides nothing')
}

console.log('\n--- moving formulas that name a sheet ----------------------------')
{
  ok(translateCellFormula('=Data!A1*2', 1, 0) === '=Data!A2*2',
    'copied a row down, a qualified reference follows — the formula moved, and its row is relative')
  ok(translateCellFormula("='Q3 pipeline'!A1", 1, 0) === "='Q3 pipeline'!A2",
    'a quoted name survives the rewrite exactly, quotes and all')
  ok(translateCellFormula('=Data!$A$1*2', 5, 5) === '=Data!$A$1*2', '$ still pins against a copy')
  ok(rewriteFormulaRefs('=SUM(Data!A1:B2)', 1, 1) === '=SUM(Data!B2:C3)', 'a qualified range moves whole')
  ok(rewriteFormulaRefs('=A1+#REF!', 1, 0) === '=A2+#REF!',
    'a #REF! left by an earlier edit is still not a sheet qualifier, though it ends in !')
  ok(rewriteFormulaRefs('=IFERROR(A1,#DIV/0!)', 1, 0) === '=IFERROR(A2,#DIV/0!)',
    'and neither is any other error literal')
}
{
  const shift = (f: string, scope?: { on?: string; self?: string }) =>
    shiftSheetFormulas([['k', f]], 'row', 0, 1, scope)[0]?.[1] ?? f
  ok(shift('=A5') === '=A6', 'inserting a row still moves a local reference')
  ok(shift('=Other!A5') === '=Other!A5',
    'but NOT a reference to another sheet — nothing moved over there, and moving it would repoint it at a hole in this one')
  ok(shift('=Other!A5', { on: 'Other', self: 'Here' }) === '=Other!A6',
    'when the rows were inserted on THAT sheet, that is exactly the reference that moves')
  ok(shift('=A5', { on: 'Other', self: 'Here' }) === '=A5',
    'and the local one does not, because its own sheet did not change shape')
  ok(shift('=Here!A5', { on: 'Here', self: 'Here' }) === '=Here!A6',
    'a self-qualified reference moves with its own sheet')
}
{
  const { deps } = bindRefs('Data!A1 + B2', { has: () => true, clip: (r) => r })
  ok(deps.length === 2 && deps[0].sheet === 'Data' && deps[1].sheet === undefined,
    'the binding reports WHICH sheet each reference named, and undefined means this one')
  ok(deps[0].cells[0].sheet === 'Data', 'and every position it covers carries the sheet with it')
}

{
  // TWO SHEETS, ONE NAME. tabs.ts refuses only an EMPTY rename, so this is a
  // workbook a person can make. Keying the graph by name would leave the second
  // one's formulas silently uncomputed — a sheet of blanks with no complaint.
  const a = canvas('Sales', { A1: 1, B1: '=A1+10' })
  const b = { ...canvas('Sales', { A1: 2, B1: '=A1+20' }), id: 'sales2' }
  const c = canvas('R', { A1: '=Sales!A1' })
  const r = book(a, b, c)
  ok(cell(r, 'sales', 'B1') === 11 && r.get('sales2')!.values.get(cellKey(0, 1)) === 22,
    'both sheets of a duplicated name compute — results are keyed by sheet id, which is unique')
  ok(cell(r, 'R', 'A1') === 1,
    'and a reference to the shared name resolves to the FIRST of them: predictable, since it cannot be right')
}

console.log('\n--- the workbook a document describes ----------------------------')
{
  const t = table('Pipeline', ['Value'], [[100], [250]])
  const s = canvas('Scratch', { A1: '=Pipeline!A1+Pipeline!A2' })
  const sources: SheetSource[] = workbookSources(doc(t, s))
  ok(sources.length === 2 && sources[0].name === 'Pipeline' && sources[1].name === 'Scratch',
    'workbookSources names every sheet the way a reference reaches it')
  ok(sources[0].source.rows === 2 && sources[0].source.cols === 1,
    'a dataset sheet is exactly the rows it has')
  ok(cell(recalcWorkbook(sources), 'Scratch', 'A1') === 350, 'and the whole thing recalculates together')
}
{
  // The dataset side keeps working the way the 50-check rig pins it: a per-cell
  // formula on a table sheet, found through its own overrides map.
  const t = table('T', ['A', 'B'], [[2, 0], [4, 0]])
  t.cells = { 'b:1': { f: '=A1*10' }, 'b:2': { f: '=A2*10' } }
  const src = tableCellSource(t)
  const out = recalcCells(src)
  ok(out.values.get(cellKey(0, 1)) === 20 && out.values.get(cellKey(1, 1)) === 40,
    'a dataset sheet finds its per-cell formulas through the rid keys, not by scanning the grid')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
