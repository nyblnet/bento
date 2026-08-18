#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash: what a formula may reach ACROSS sheets, and what row 1 means when
// it gets there.
//
//   node scripts/test-dash-xsheet.ts
//
// Two questions, and the second is the one that rots silently.
//
// 1. WHICH KINDS REACH ACROSS. `=SUM(Jan!B1:B6)` resolved on a SPREADSHEET
//    sheet and came back `#REF!` on a DATASET sheet in the same workbook —
//    not because the kinds decided anything, but because the dataset's grid
//    called the one-sheet entry point. The decision recorded in
//    docs/dash-sheet-kinds.md is:
//
//      · a per-CELL formula on a dataset DOES reach another sheet. It is the
//        cellular escape hatch inside the columnar kind, it is bound by the
//        module that is already workbook-wide, and the other direction has
//        worked since the workbook graph landed. Refusing only the outbound
//        direction made the dataset the lesser kind.
//      · a COLUMN formula does NOT, and now says why. A column expression is
//        defined over the columns of one sheet by identity; reaching another
//        sheet is either a POSITION that moves when somebody edits a tab the
//        author is not looking at, or a JOIN with no key — and dash has `join`.
//
//    Both halves are checked as OUTCOMES — a number, or an error whose `why`
//    a reader could act on — never as "the function exists".
//
// 2. WHAT ROW 1 MEANS. `Contacts!D2` is the dataset's second DATA row; `D2` in
//    the spreadsheet COPY of that dataset is the second row INCLUDING the
//    header. Both are internally consistent and side by side they are off by
//    one, which is a wrong number with no symptom. The rule this file pins is
//    the only one a reader can check: AN A1 ROW NUMBER IS THE ROW NUMBER THE
//    ADDRESSED SHEET PAINTS IN ITS OWN GUTTER. The offset between the kinds is
//    therefore real and permanent, and what makes it SAFE is that the
//    conversion shifts local references by the header and leaves qualified ones
//    exactly as written. That last sentence is the check that would rot
//    silently, so it is measured against both sheets rather than asserted.
//
// The cost of asking the whole workbook on every keystroke is also measured
// here, because "correct but unaffordable" is how this ends up reverted.

import {
  cellKey, columnVectors, recalcCells, recalcSheetCells, recalcWorkbook,
  rowMeaning, tableCellSource, workbookSources,
} from '../dash/src/cellformula.ts'
import { readFileSync } from 'node:fs'
import { recalc, isErr, type Cell } from '../dash/src/formula.ts'
import { sheetQualifiers, parseRef } from '../dash/src/a1.ts'
import { flattenToSpreadsheet } from '../dash/src/promote.ts'
import type { CanvasCell, CanvasSheet, DashDoc, TableSheet } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// --- fixtures ----------------------------------------------------------------

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

const canvas = (name: string, at: Record<string, string | number | null>): CanvasSheet => {
  const cells: Record<string, CanvasCell> = {}
  for (const [a1, v] of Object.entries(at)) {
    const r = parseRef(a1)
    if (!r) throw new Error(`not an address: ${a1}`)
    cells[cellKey(r.row, r.col)] =
      typeof v === 'string' && v.startsWith('=') ? { f: v } : { v }
  }
  return { id: name.toLowerCase(), name, kind: 'canvas', cells }
}

const doc = (...sheets: unknown[]): DashDoc => ({ sheets } as unknown as DashDoc)

/** A per-cell override on a dataset, addressed the way the file does. */
const put = (t: TableSheet, col: string, rid: number, f: string): void => {
  ;(t as unknown as { cells: Record<string, unknown> }).cells ??= {}
  ;(t as unknown as { cells: Record<string, unknown> }).cells[`${col}:${rid}`] = { f }
}

/** The computed value at an A1 address of a named sheet of a whole document. */
const at = (d: DashDoc, sheet: string, a1: string): Cell => {
  const r = parseRef(a1)!
  return recalcSheetCells(d, sheet.toLowerCase()).values.get(cellKey(r.row, r.col)) ?? null
}

const why = (v: Cell): string => (isErr(v) ? v.why ?? '' : `not an error: ${String(v)}`)
const code = (v: Cell): string => (isErr(v) ? v.code : `not an error: ${String(v)}`)

console.log('\n--- the finding: one workbook, two kinds, one answer ----------------')
{
  // THE BOUNCE-TEST JOB, verbatim: a formula on one sheet totalling another.
  // 1+2+3+4+5+6 = 21. On the dataset this was `#REF!` and the job could not be
  // done at all; on the spreadsheet beside it, it worked.
  const jan = table('Jan', ['Amount'], [[1], [2], [3], [4], [5], [6]])
  const sales = table('Sales', ['Region', 'Total'], [['North', 0]])
  put(sales, 'total', 1, '=SUM(Jan!A1:A6)')
  const scratch = canvas('Scratch', { A1: '=SUM(Jan!A1:A6)' })
  const d = doc(jan, sales, scratch)

  ok(at(d, 'Sales', 'B1') === 21,
    'a DATASET cell formula totals another sheet — the job the tester could not do')
  ok(at(d, 'Scratch', 'A1') === 21,
    'and the SPREADSHEET beside it gives the same number, which it always did')
  ok(at(d, 'Sales', 'B1') === at(d, 'Scratch', 'A1'),
    'the two kinds agree: the kind of sheet you are standing on is not part of the answer')
}
{
  // ASSERT THE ENTRY POINT A GRID WOULD CALL, not an inner function. The whole
  // defect was a caller reaching for the one-sheet path, so the thing that has
  // to be true is that ONE call, given a document and a sheet id, resolves.
  const jan = table('Jan', ['Amount'], [[10], [20]])
  const sales = table('Sales', ['A'], [[0]])
  put(sales, 'a', 1, '=Jan!A2*2')
  const r = recalcSheetCells(doc(jan, sales), 'sales')
  ok(r.values.get(cellKey(0, 0)) === 40,
    'recalcSheetCells(doc, sheetId) is the one call a grid makes, for either kind')
}
{
  // A CROSS-SHEET REFERENCE INTO A CALCULATED COLUMN. Before the lazy default,
  // every sheet but the one on screen handed over no computed columns, so this
  // read the STORED value of a column that stores nothing — blank — and
  // `=Sales!B1*2` reported a confident 0. An error becoming a zero is the
  // failure this codebase refuses everywhere else.
  const sales = table('Sales', ['Qty', 'Doubled'], [[7, null], [9, null]])
  sales.columns[1].formula = 'Qty * 2'
  const scratch = canvas('Scratch', { A1: '=Sales!B1', A2: '=Sales!B2*10' })
  const d = doc(sales, scratch)
  ok(at(d, 'Scratch', 'A1') === 14 && at(d, 'Scratch', 'A2') === 180,
    'a reference into a CALCULATED column reads its computed number, not a blank and not 0')
}
{
  // ONE GRAPH, so a circle drawn through two kinds of sheet is still a circle.
  // Two half-graphs each look perfectly settled, and would have produced a
  // number that changed on every recalculation.
  const t = table('T', ['A'], [[0]])
  put(t, 'a', 1, '=Scratch!A1+1')
  const s = canvas('Scratch', { A1: '=T!A1' })
  const d = doc(t, s)
  ok(code(at(d, 'T', 'A1')) === '#CYCLE!' && code(at(d, 'Scratch', 'A1')) === '#CYCLE!',
    'a cycle drawn from a dataset through a spreadsheet and back is #CYCLE!, never a number')
}

console.log('\n--- the boundary that stays: a COLUMN formula ------------------------')
{
  // A COLUMN EXPRESSION IS DEFINED OVER ITS OWN SHEET'S COLUMNS. Reaching
  // another sheet by position reintroduces the address class the kind exists to
  // avoid; reaching another sheet's COLUMN is a positional join with no key,
  // and dash has `join`. The refusal has to be readable, because the reader's
  // next move depends on which of the two they meant.
  const t = table('Sales', ['A', 'B'], [[10, 0], [20, 0]])
  t.columns[1].formula = 'A * Jan!A1'
  const v = recalc(t).values.get('b')![0]
  ok(code(v) === '#NAME?', 'a column formula reaching another sheet is refused')
  ok(why(v).includes('Jan') && why(v).includes('sheet'),
    'and the refusal NAMES the sheet — `unknown name "Jan"` was false twice over')
  ok(!why(v).includes('unknown name'),
    'it no longer calls a sheet in the tab strip an unknown name, which sent the reader to fix a spelling that was right')
  ok(why(v).toLowerCase().includes('cell') && why(v).toLowerCase().includes('join'),
    'and it names both ways across the boundary: a cell formula, or a join step')
}
{
  // THE JOIN SPELLING, which is the one a dataset author reaches for: a sheet
  // and a COLUMN NAME rather than an address. A reference-shaped scan misses it
  // — `Amount` is not cell-shaped — and formula.ts would report the bare word
  // `Jan` as an unknown name.
  const t = table('Sales', ['A', 'B'], [[10, 0]])
  t.columns[1].formula = 'A + Jan!Amount'
  const v = recalc(t).values.get('b')![0]
  ok(code(v) === '#NAME?' && why(v).includes('Jan') && why(v).includes('join'),
    'Jan!Amount — a sheet and a column, which is a join — is refused by name too')
}
{
  // A `!` INSIDE A STRING IS NOT A SHEET. If it were, `="done!" & A` would stop
  // computing for everyone who ever typed an exclamation mark in a label — a
  // refusal is only worth having if it cannot fire on innocent text.
  ok(sheetQualifiers('"not a sheet!" & A1').length === 0,
    'a `!` inside a quoted string is text, not a qualifier')
  ok(sheetQualifiers('#REF!+1').length === 0,
    'and the `REF` of an error literal is not a sheet name either')
  const t = table('Sales', ['A', 'B'], [[10, 0]])
  t.columns[1].formula = '"done!" & A'
  ok(recalc(t).values.get('b')![0] === 'done!10',
    'so a column formula with an exclamation mark in a label still computes')
}

{
  // AND THE SAME SPELLING IN A CELL FORMULA GETS A DIFFERENT SENTENCE, because
  // a cell formula CAN reach another sheet. Inheriting the column refusal would
  // tell the reader to put it in a cell, which is where they already were.
  const jan = table('Jan', ['Amount'], [[1], [2]])
  const t = table('Sales', ['A'], [[0]])
  put(t, 'a', 1, '=SUM(Jan!Amount)')
  const v = at(doc(jan, t), 'Sales', 'A1')
  ok(code(v) === '#NAME?' && why(v).includes('not a cell address'),
    'Jan!Amount in a CELL formula says a column name is not an address, not "put it in a cell"')
  ok(why(v).includes('Jan!B2') && !why(v).includes('join step'),
    'and it shows the spelling that does work, rather than the column formula\'s advice')
}

console.log('\n--- what a failed reference is allowed to claim ----------------------')
{
  // `#REF!` MEANS "THE THING THIS POINTED AT WAS DELETED" — the reader's file,
  // the reader's mistake. Spending it on a caller's limit blames the reader for
  // something they did not do, and sends them looking for a sheet that was
  // never deleted.
  const d = doc(table('Jan', ['Amount'], [[1]]), canvas('S', { A1: '=Feb!A1' }))
  const gone = at(d, 'S', 'A1')
  ok(code(gone) === '#REF!' && why(gone).includes('no sheet called "Feb"'),
    'a sheet that really is not in the workbook is #REF!, and says so')

  // The DETACHED evaluation — one sheet, no document (promotion previewing a
  // range, and the old dataset grid). A one-sheet list is indistinguishable
  // from a one-sheet workbook, so this used to report a sheet sitting in the
  // tab strip as missing from the workbook it is in.
  const t = table('Sales', ['A'], [[0]])
  put(t, 'a', 1, '=SUM(Jan!A1:A6)')
  const lone = recalcCells(tableCellSource(t), undefined, columnVectors(t))
    .values.get(cellKey(0, 0))!
  ok(code(lone) === '#REF!', 'a formula computed outside its workbook still cannot resolve')
  ok(!why(lone).includes('no sheet called'),
    'but it no longer says the sheet does not exist, which was false whenever it did exist')
  ok(why(lone).includes('outside the workbook'),
    'it names the boundary instead: the formula is being computed on its own')
}

console.log('\n--- what row 1 means, on each kind ----------------------------------')
{
  // THE RULE: an A1 row number is the row number the addressed sheet paints in
  // its own gutter. A dataset's gutter counts DATA rows (its header is chrome);
  // a spreadsheet's counts every row (its header is a cell holding a word).
  const contacts = table('Contacts', ['Name', 'Spend'], [
    ['Ada', 100.5], ['Bo', 980.5], ['Cy', 12],
  ])
  const s = canvas('S', { A1: '=Contacts!B2' })
  ok(at(doc(contacts, s), 'S', 'A1') === 980.5,
    'Contacts!B2 is the SECOND DATA row of the dataset — the header is not a row')

  // AND THE SAME DATA AS A SPREADSHEET COPY IS OFF BY ONE, measured rather than
  // asserted, because this is the number that would rot silently. If a future
  // change makes a dataset address count the header, this flips and says so.
  const flat = flattenToSpreadsheet(contacts, { sheetId: 'copy', name: 'Copy' }).sheet
  // A canvas cell map is keyed by whichever spelling its writer used — `posOf`
  // reads both — so the rig reads both rather than pinning one writer's choice.
  const cellOf = (sheet: CanvasSheet, a1: string): CanvasCell | undefined => {
    const r = parseRef(a1)!
    return sheet.cells[a1] ?? sheet.cells[cellKey(r.row, r.col)]
  }
  const cellAt = (a1: string) => cellOf(flat, a1)?.v
  ok(cellAt('B1') === 'Spend', 'in the spreadsheet copy, row 1 is the HEADER')
  ok(cellAt('B2') === 100.5, 'so B2 is the FIRST data row…')
  ok(cellAt('B3') === 980.5,
    '…and the value at Contacts!B2 sits at B3 in the copy: the two bases differ by exactly the header row')

  ok((rowMeaning(contacts) ?? '').includes('DATA row'),
    'the dataset says what its row 1 is, in a sentence a panel can show')
  ok((rowMeaning(flat) ?? '').includes('top row of the grid'),
    'and so does the spreadsheet, because the danger only exists when both are on screen')
}
{
  // WHAT MAKES THE TWO BASES SAFE TO COEXIST. The conversion moves the rows, so
  // it must move the references that point at those rows — and must NOT move
  // the ones pointing at another sheet, which did not move. Getting the second
  // half wrong turns `Jan!A2` into `Jan!A3` inside a copy nobody re-reads: a
  // wrong number wearing a right number's clothes.
  const t = table('T', ['A', 'B'], [[1, 0], [2, 0]])
  put(t, 'b', 1, '=A1*2')
  put(t, 'b', 2, '=Jan!A2+A2')
  const copy = flattenToSpreadsheet(t, { sheetId: 'c', name: 'C' }).sheet
  const fAt = (a1: string) => {
    const r = parseRef(a1)!
    return (copy.cells[a1] ?? copy.cells[cellKey(r.row, r.col)])?.f
  }
  ok(fAt('B2') === '=A2*2',
    'a LOCAL reference is shifted by the header row, because the cell it names moved')
  ok(fAt('B3') === '=Jan!A2+A3',
    'a QUALIFIED reference is left exactly as written, because that sheet did not move')
}

console.log('\n--- the cost of asking the whole workbook ----------------------------')
{
  // ASKING THE WORKBOOK HAPPENS ON EVERY KEYSTROKE. If assembling it evaluated
  // every dataset's column formulas, a workbook holding one 100k-row dataset
  // would pay for it to re-letter a label — and this would be reverted rather
  // than fixed. So the property measured is DEMAND: was this sheet's computed
  // columns asked for at all? A sheet nothing references must never be asked.
  const big = table('Big', ['Qty', 'Doubled'], Array.from({ length: 500 }, (_, i) => [i, null]))
  big.columns[1].formula = 'Qty * 2'
  const other = canvas('S', { A1: 1, A2: '=A1+1' })

  let asked = 0
  const spy = (t: TableSheet) => { if (t.id === 'big') asked++; return undefined }
  recalcWorkbook(workbookSources(doc(big, other), spy))
  ok(asked === 0,
    'a dataset no formula reaches is never asked for its computed columns — assembling the workbook is free')

  // …and one that IS reached does compute, so the cheapness is not merely the
  // absence of the feature.
  let asked2 = 0
  const spy2 = (t: TableSheet) => { if (t.id === 'big') asked2++; return undefined }
  const reader = canvas('R', { A1: '=Big!B10 + SUM(Big!B1:B4)' })
  const r = recalcWorkbook(workbookSources(doc(big, reader), spy2)).get('r')!
  ok(r.values.get(cellKey(0, 0)) === 18 + 0 + 2 + 4 + 6,
    'and the moment something references it, its calculated column is there')
  ok(asked2 === 1,
    'asked exactly once, however many cells of it a formula reads — the resolution is memoised')
}

console.log('\nthe dataset grid actually recalculates through the workbook')
{
  // THE CALLER CHECK. Everything above proves the engine crosses sheets. None
  // of it proves the DATASET GRID asks it to — and that was the entire defect:
  // `recalcWorkbook` had crossed sheets since the workbook graph landed, and
  // `cvRefresh` already called it for the canvas kind. The dataset path called
  // the one-sheet `recalcCells`. Two call sites, never two kinds.
  //
  // So without this, all 31 checks above pass over a feature that is still
  // #REF! on screen. That failure has happened three times in this codebase in
  // one week, which is why it gets its own check rather than a comment.
  const grid = readFileSync(new URL('../dash/src/grid.ts', import.meta.url), 'utf8')
  ok(grid.includes('recalcSheetCells('),
    'grid.ts recalculates the dataset kind through the workbook, so a cross-sheet reference resolves on screen')
  ok(!/\brecalcCells\(/.test(grid),
    'and the one-sheet recalc is gone from it entirely — leaving it is how the two kinds drift apart again')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
