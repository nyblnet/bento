#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The BRIDGE between the two kinds of sheet — a spreadsheet range promoted to a
// dataset, and a dataset flattened back to a spreadsheet copy.
//
//   node scripts/test-dash-promote.ts     (Node ≥ 23.6 strips types natively)
//
// WHY THIS RIG AND NOT A CLICK TEST. Everything that can be silently wrong
// about the bridge is decided before any pixel: what type a column is, whether
// the first row was a header, and where a formula points after the cells it
// names have moved to a different origin. All three fail INVISIBLY — a promoted
// column that read as text still draws, a header eaten as data still draws, and
// a formula rebased one row short still shows a number. So the checks are:
//
//   1. THE INFERENCE IS import.ts's. A promoted column and the same values
//      arriving as a CSV must type identically, refusals included — the
//      date-order refusal above all, because that is the one whose guess moves
//      a quarter's numbers by a month.
//   2. THE HEADER IS DETECTED, AND THE DETECTION CAN BE OVERRULED. Text over
//      numbers is a header; text over text is not, and says why.
//   3. A FORMULA IS LIFTED, CARRIED, OR DROPPED — and the numbers are checked
//      by RE-EVALUATING the promoted sheet, not by reading the formula text.
//      A rebase that is one row out produces a perfectly plausible number.
//   4. THE RESULT VALIDATES. `validateDoc` is the same check the app runs on a
//      file it opens, so a promotion that produces a column one value short, an
//      override keyed to a rid that does not exist, or a formula naming a
//      column that is not there, fails here rather than in somebody's file.
//   5. ONE PROMOTION IS ONE UNDO STEP, AND ITS INVERSE IS EXACT. The forward
//      patch and its inverse must leave the document byte-identical, and the
//      spreadsheet must be untouched either way — promotion copies.
//   6. THE ROUND TRIP HOLDS. dataset → spreadsheet → dataset returns the values
//      that went in.

import { applyPatch, type Patch } from '../dash/src/store.ts'
import { validateDoc } from '../dash/src/validate.ts'
import { recalcCells, tableCellSource } from '../dash/src/cellformula.ts'
import { recalc } from '../dash/src/formula.ts'
import { inferColumn } from '../dash/src/import.ts'
import {
  promoteRange, flattenToSpreadsheet, detectHeader, trimBox, computeCanvas, currentRegion,
  describeBox, rebaseFormula, inferValues,
} from '../dash/src/promote.ts'
import type { CanvasCell, CanvasSheet, DashDoc, TableSheet } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** A spreadsheet written the way a person types one: rows of cells, A1 down. */
function sheetOf(rows: Array<Array<string | number | boolean | null | CanvasCell>>): CanvasSheet {
  const cells: Record<string, CanvasCell> = {}
  rows.forEach((row, r) => {
    row.forEach((v, c) => {
      if (v === null) return
      const key = `${String.fromCharCode(65 + c)}${r + 1}`
      cells[key] = typeof v === 'object' ? v : { v }
    })
  })
  return { id: 'sp', name: 'Invoice', kind: 'canvas', cells }
}

const view = (s: CanvasSheet) => ({ cells: s.cells, computed: computeCanvas(s.cells) })

const box = (top: number, left: number, bottom: number, right: number) =>
  ({ top, left, bottom, right })

/** The values a dataset column holds, formulas evaluated, as the grid shows them. */
function columnValues(sheet: TableSheet, colId: string): unknown[] {
  const rows = sheet.rids.reduce((n, [, c]) => n + c, 0)
  const src = tableCellSource(sheet)
  const values = recalcCells(src).values
  const ci = sheet.columns.findIndex((c) => c.id === colId)
  const out: unknown[] = []
  for (let r = 0; r < rows; r++) {
    const computed = values.get(`${ci},${r}`)
    out.push(computed === undefined ? src.valueAt(r, ci) : computed)
  }
  return out
}

const codes = (fs: Array<{ code: string }>) => fs.map((f) => f.code)

/**
 * EVERY finding carries a severity, and the ones that could be WRONG about the
 * reader's data carry the loud one.
 *
 * A banner where every line looks identical is a banner nobody reads to the
 * end, and the two kinds are not comparable: "3 values could not be read as a
 * number" is a decision waiting to be made, "the range is still on the
 * spreadsheet" is reassurance. This asserts the split rather than trusting each
 * call site to have thought about it — a new finding added with the wrong one
 * fails here.
 */
const LOUD = new Set([
  'blank-trimmed', 'header-guessed', 'empty-header', 'duplicate-header',
  'formula-error', 'date-ambiguous', 'coerce-failed', 'empty-column',
  'formula-dropped', 'column-formula-flattened', 'overrides-flattened',
])
const severityOk = (fs: Array<{ code: string; severity: string }>): boolean =>
  fs.every((f) => (LOUD.has(f.code) ? f.severity === 'suspicious' : f.severity === 'note'))

// ============================================================ types and refusals

console.log('the inference is import.ts\'s, refusals included')
{
  const s = sheetOf([
    ['Region', 'Amount', 'When', 'Open'],
    ['North', 1200, '2026-01-14', true],
    ['South', 980.5, '2026-02-01', false],
    ['East', 4000, '2026-03-30', true],
  ])
  const r = promoteRange(view(s), box(0, 0, 3, 3), { sheetId: 'ds', name: 'Data', at: '' })
  ok(r.ok, 'a plain block promotes')
  if (r.ok) {
    const types = r.sheet.columns.map((c) => `${c.name}:${c.type}`).join(' ')
    ok(types === 'Region:text Amount:number When:date Open:bool',
      `a type per column, from the whole column (${types})`)
    ok(r.sheet.rids[0][1] === 3 && r.sheet.columns.length === 4,
      'three rows and four columns — the header row is not one of the rows')
    ok(columnValues(r.sheet, r.sheet.columns[1].id).join(',') === '1200,980.5,4000',
      'numbers arrive as numbers, not as their spelling')
    ok(columnValues(r.sheet, r.sheet.columns[2].id)[0] === '2026-01-14',
      'an ISO date column keeps the ISO date')
  }
}
{
  // THE REFUSAL THAT MATTERS. Every value fits both DD/MM and MM/DD, so no
  // single order fits the column — import.ts refuses to decide, and so must
  // this door into the same inference.
  const s = sheetOf([
    ['Paid'],
    ['03/04/2026'],
    ['05/06/2026'],
    ['07/08/2026'],
  ])
  const r = promoteRange(view(s), box(0, 0, 3, 0), { sheetId: 'ds', name: 'D', at: '' })
  ok(r.ok && r.sheet.columns[0].type === 'text',
    'an undecidable date column is TEXT — it is not guessed at')
  ok(r.ok && codes(r.findings).includes('date-ambiguous'),
    'and the refusal is reported, with the reason the file cannot say which order it is')
  // the same values through the CSV door reach the same answer
  const viaCsv = inferColumn(['03/04/2026', '05/06/2026', '07/08/2026'])
  ok(r.ok && viaCsv.type === r.sheet.columns[0].type && !!viaCsv.ambiguous,
    'and a CSV of the same column agrees — one inference, two doors')
}
{
  const s = sheetOf([['n'], [1], [2], ['oops'], [4], [5], [6], [7], [8], [9], [10]])
  const r = promoteRange(view(s), box(0, 0, 10, 0), { sheetId: 'ds', name: 'D', at: '' })
  ok(r.ok && r.sheet.columns[0].type === 'number' && r.sheet.columns[0].failed === 1,
    'a column that is 90% numbers is a number column, and what would not coerce is COUNTED on the column')
  ok(r.ok && codes(r.findings).includes('coerce-failed'),
    'and said out loud rather than left as a silent blank')
}
{
  // A typed value must not be re-read through a string inference: 1e21
  // stringifies to "1e+21", which no number grammar accepts.
  const inf = inferValues([1e21, 2e21])
  ok(inf.type === 'number', 'a column of real JS numbers is a number column whatever it stringifies to')
}

// ============================================================ the header question

console.log('\nthe header row is detected, and the detection can be overruled')
{
  const s = sheetOf([['Region', 'Amount'], ['North', 12], ['South', 40]])
  const g = detectHeader(view(s), box(0, 0, 2, 1))
  ok(g.header, 'text over numbers is a header')
  ok(/header/.test(g.why) && g.why.length > 30, 'and it says why, in a sentence')
}
{
  const s = sheetOf([['North', 'East'], ['South', 'West']])
  const g = detectHeader(view(s), box(0, 0, 1, 1))
  ok(!g.header, 'text over text is NOT assumed to be a header — nothing marks the first row out')
  const r = promoteRange(view(s), box(0, 0, 1, 1), { sheetId: 'ds', name: 'D', at: '' })
  ok(r.ok && r.sheet.columns[0].name === 'Column A',
    'so the columns are named after the letters they came from, and no row is eaten')
  ok(r.ok && r.sheet.rids[0][1] === 2, 'and both rows are rows')
}
{
  const s = sheetOf([['Region', 'Amount'], ['North', 12], ['South', 40]])
  const r = promoteRange(view(s), box(0, 0, 2, 1), { sheetId: 'ds', name: 'D', header: false, at: '' })
  ok(r.ok && r.sheet.rids[0][1] === 3 && r.sheet.columns[0].name === 'Column A',
    'the reader can overrule the guess, and then the header row is data')
  ok(r.ok && !codes(r.findings).includes('header-guessed'),
    'and nothing is reported as guessed when nothing was guessed')
}
{
  const s = sheetOf([['A', 'B'], ['x', 'y']])
  const one = promoteRange(view(s), box(0, 0, 0, 1), { sheetId: 'ds', name: 'D', header: true, at: '' })
  ok(!one.ok, 'one row read as a header would be a dataset of no rows, and is refused with a way out')
}

// ============================================================ edges and ragged

console.log('\nthe edges of a selection, and the awkward columns')
{
  const s = sheetOf([
    [null, null, null],
    [null, 'Region', 'Amount'],
    [null, 'North', 12],
    [null, null, null],
    [null, 'South', 40],
  ])
  const t = trimBox(view(s), box(0, 0, 5, 4))
  ok(!!t && describeBox(t) === 'B2:C5', `blank rows and columns at the EDGE are trimmed (${t && describeBox(t)})`)
  const r = promoteRange(view(s), box(0, 0, 5, 4), { sheetId: 'ds', name: 'D', at: '' })
  ok(r.ok && r.sheet.rids[0][1] === 3, 'a blank row in the MIDDLE is kept — a dataset has exactly the rows there are')
  ok(r.ok && codes(r.findings).includes('blank-rows') && codes(r.findings).includes('blank-trimmed'),
    'and both decisions are reported')
}
{
  const s = sheetOf([['Amount', 'Amount', 'Note'], [1, 2, null], [3, 4, null]])
  const r = promoteRange(view(s), box(0, 0, 2, 2), { sheetId: 'ds', name: 'D', at: '' })
  ok(r.ok && r.sheet.columns[0].id !== r.sheet.columns[1].id,
    'two columns with one name get two ids — sharing one would make them share their values')
  ok(r.ok && codes(r.findings).includes('duplicate-header'), 'and it is reported')
  ok(r.ok && r.sheet.columns[2].type === 'text' && codes(r.findings).includes('empty-column'),
    'a wholly empty column is kept as text, not dropped — a column somebody named is one they meant')
}
{
  const s = sheetOf([['a'], [null]])
  const r = promoteRange(view(s), box(5, 5, 9, 9), { sheetId: 'ds', name: 'D', at: '' })
  ok(!r.ok && /empty/.test(r.message), 'an empty selection is refused, and says so')
}
{
  // ONE CLICK INSIDE THE BLOCK IS THE GESTURE PEOPLE MAKE. Nobody drags over
  // four hundred rows, so a single-cell selection asks for the block it is
  // standing in — and a gap is still an edge, or two tables under each other
  // would promote as one.
  const s = sheetOf([
    ['Region', 'Amount'],
    ['North', 12],
    ['South', 40],
    [null, null],
    ['Other', 'Block'],
  ])
  ok(describeBox(currentRegion(view(s), { row: 1, col: 1 })) === 'A1:B3',
    'a click inside a block grows to the block, ring by ring')
  ok(describeBox(currentRegion(view(s), { row: 4, col: 0 })) === 'A5:B5',
    'and the blank row is an edge — the block below it is its own block')
  ok(describeBox(currentRegion(view(s), { row: 9, col: 9 })) === 'J10:J10',
    'a click on empty sheet is one empty cell, which promotion then refuses by name')
  const r = promoteRange(view(s), currentRegion(view(s), { row: 2, col: 0 }),
    { sheetId: 'ds', name: 'D', at: '' })
  ok(r.ok && r.sheet.rids[0][1] === 2 && r.sheet.columns[0].name === 'Region',
    'so one click promotes the table, header and all')
}
{
  // A header narrower than its body: growing DOWN must expose the extra column
  // to the sideways test, or the region stops at the header's width.
  const s = sheetOf([
    ['Region', 'Amount', null],
    ['North', 12, 'note'],
    ['South', 40, 'note'],
  ])
  ok(describeBox(currentRegion(view(s), { row: 0, col: 0 })) === 'A1:C3',
    'a block that widens below its first row is still one block')
}

// ============================================================ formulas

console.log('\nwhat happens to a cell formula')
{
  // The fill-down idiom: one formula, every row. It lifts.
  const s = sheetOf([
    ['Item', 'Qty', 'Price', 'Line'],
    ['Bolt', 4, 2.5, { f: '=B2*C2' }],
    ['Nut', 10, 0.4, { f: '=B3*C3' }],
    ['Washer', 3, 1.5, { f: '=B4*C4' }],
  ])
  const r = promoteRange(view(s), box(0, 0, 3, 3), { sheetId: 'ds', name: 'D', at: '' })
  ok(r.ok && r.sheet.columns[3].formula === 'Qty*Price',
    `a uniform fill-down becomes ONE column expression (${r.ok ? r.sheet.columns[3].formula : ''})`)
  ok(r.ok && r.sheet.data[r.sheet.columns[3].id] === undefined,
    'and it stores no values beside the expression — that would be a second answer to one question')
  ok(r.ok && codes(r.findings).includes('formula-lifted'), 'and the lift is reported')
  // THE CHECK THIS RIG WAS MISSING, AND A BUILD FOUND INSTEAD. Asserting the
  // formula's TEXT is not asserting that it computes: the lifted expression
  // shipped with a leading `=`, which validate.ts strips before checking and
  // formula.ts's `evaluate` does not, so every promoted fill-down column read
  // `#VALUE!` in the app while every check here passed. A COLUMN formula is a
  // bare expression; only running it says so.
  {
    const got = r.ok ? (recalc(r.sheet).values.get(r.sheet.columns[3].id) ?? []) : []
    ok(got.join(',') === '10,4,4.5',
      `and formula.ts computes it down the column, exactly as the app does (${got.join(',')})`)
  }
  // The other half of the same lesson: the lift must survive a ROW BEING ADDED,
  // which is the whole reason a column expression beats a column of formulas.
  if (r.ok) {
    const grown: TableSheet = {
      ...r.sheet,
      rids: [[1, 4]],
      nextRid: 5,
      data: Object.fromEntries(Object.entries(r.sheet.data).map(([k, d]) =>
        [k, { ...d, v: [...(d as { v: unknown[] }).v, k === r.sheet.columns[1].id ? 2 : k === r.sheet.columns[2].id ? 5 : 'Screw'] }])) as typeof r.sheet.data,
    }
    const got = recalc(grown).values.get(r.sheet.columns[3].id) ?? []
    ok(got[3] === 10, `add a row and it computes — ${String(got[3])} for 2 × 5`)
  }
}
{
  // Not uniform: one row was overridden by hand. Per-cell, rebased.
  const s = sheetOf([
    ['Qty', 'Price', 'Line'],
    [4, 2.5, { f: '=A2*B2' }],
    [10, 0.4, 9],
    [3, 1.5, { f: '=A4*B4' }],
  ])
  const r = promoteRange(view(s), box(0, 0, 3, 2), { sheetId: 'ds', name: 'D', at: '' })
  ok(r.ok && r.sheet.columns[2].formula === undefined,
    'one hand-typed row among the formulas means the column has no single expression')
  const f = r.ok ? r.sheet.cells?.[`${r.sheet.columns[2].id}:1`]?.f : undefined
  ok(f === '=A1*B1', `so each formula stays its own, rebased onto the dataset's origin (${String(f)})`)
  // THE CHECK THAT MATTERS: the numbers, re-evaluated on the new sheet.
  const got = r.ok ? columnValues(r.sheet, r.sheet.columns[2].id) : []
  ok(got.join(',') === '10,9,4.5',
    `and they compute what they computed on the spreadsheet (${got.join(',')})`)
}
{
  // A reference OUT of the range: there is no cell to point at in a sheet that
  // does not contain it. Value kept, formula dropped, said out loud.
  const s = sheetOf([
    ['Rate', 0.2, null],
    ['Qty', 'Price', 'Vat'],
    [4, 2.5, { f: '=A3*B3*$B$1' }],
    [10, 0.4, { f: '=A4*B4*$B$1' }],
  ])
  const r = promoteRange(view(s), box(1, 0, 3, 2), { sheetId: 'ds', name: 'D', at: '' })
  ok(r.ok && r.sheet.cells === undefined,
    'a formula reaching outside the promoted range is not carried')
  const got = r.ok ? columnValues(r.sheet, r.sheet.columns[2].id) : []
  ok(got.join(',') === '2,0.8', `but the value it computed is (${got.join(',')})`)
  ok(r.ok && codes(r.findings).includes('formula-dropped'),
    'and the cell it happened in is named, so nobody discovers it later')
}
{
  const s = sheetOf([['x'], [{ f: '=Pipeline!D2' }]])
  const moved = rebaseFormula('=Pipeline!D2', box(0, 0, 1, 0), 1, 0)
  ok(moved === '=Pipeline!D2', 'a reference to ANOTHER sheet is left exactly as it is — the promotion did not move that sheet')
  void s
}
{
  const s = sheetOf([['n', 'd'], [10, { f: '=A2/0' }], [20, { f: '=A3/0' }]])
  const r = promoteRange(view(s), box(0, 0, 2, 1), { sheetId: 'ds', name: 'D', at: '' })
  ok(r.ok && codes(r.findings).includes('formula-error'),
    'a cell computing #DIV/0! is reported rather than typed into the column')
}

// ============================================================ the sheet validates

console.log('\nthe sheet it makes is a sheet the app would accept')
{
  const s = sheetOf([
    ['Item', 'Qty', 'Price', 'Line'],
    ['Bolt', 4, 2.5, { f: '=B2*C2' }],
    ['Nut', 10, 0.4, 4],
    ['Washer', 3, 1.5, { f: '=B4*C4' }],
  ])
  const r = promoteRange(view(s), box(0, 0, 3, 3), { sheetId: 'ds', name: 'Lines', at: '' })
  ok(r.ok, 'a mixed block promotes')
  if (r.ok) {
    const doc = {
      format: 'bento/dash', version: 1, docId: 'd', title: 'T',
      sheets: [s, r.sheet],
    } as unknown as DashDoc
    const report = validateDoc(doc)
    const bad = report.findings.filter((f) => f.sheet === 'ds')
    ok(bad.length === 0,
      `the promoted sheet raises nothing in the validator${bad.length ? ` — ${bad.map((f) => f.code).join(', ')}` : ''}`)
  }
}

// ============================================================ one undo step

console.log('\none promotion is one undo step, and it copies rather than moves')
{
  const s = sheetOf([['Region', 'Amount'], ['North', 12], ['South', 40]])
  const doc = {
    format: 'bento/dash', version: 1, docId: 'd', title: 'T', sheets: [s],
  } as unknown as DashDoc
  const before = JSON.stringify(doc)
  // SNAPSHOT, not the live object. Comparing `doc.sheets[0]` to `s` after the
  // fact compares one object with itself and passes however badly promotion
  // mutated it — measured as a negative control: emptying a cell inside
  // `promoteRange` left that check green.
  const spBefore = JSON.stringify(s)
  const r = promoteRange(view(s), box(0, 0, 2, 1), { sheetId: 'ds', name: 'Data', from: 'Invoice', at: '2026-08-14' })
  ok(r.ok, 'promoted')
  if (r.ok) {
    const p: Patch = { op: 'setSheet', id: 'ds', sheet: r.sheet, at: 1 }
    const { inverse } = applyPatch(doc, p)
    ok(doc.sheets.length === 2 && doc.sheets[1].id === 'ds', 'ONE patch adds the sheet, in position')
    ok(JSON.stringify(doc.sheets[0]) === spBefore,
      'and the spreadsheet range is untouched — a promotion copies, so the formulas pointing into it still work')
    applyPatch(doc, inverse as Patch)
    ok(JSON.stringify(doc) === before,
      'and its inverse puts the document back byte for byte')
  }
}
{
  const s = sheetOf([['Region'], ['North']])
  const r = promoteRange(view(s), box(0, 0, 1, 0), { sheetId: 'ds', name: 'D', from: 'Invoice', at: '2026-08-14' })
  const step = r.ok ? r.sheet.steps[0] as { op: string; from: string } : { op: '', from: '' }
  ok(step.op === 'import' && step.from === 'Invoice!A1:A2',
    `the dataset says where it came from, by sheet and range (${step.from})`)
}

// ============================================================ the other direction

console.log('\na dataset opens as a spreadsheet copy, and says it is one')
{
  const ds: TableSheet = {
    id: 'ds', name: 'Pipeline', kind: 'table',
    rids: [[1, 3]], nextRid: 4,
    columns: [
      { id: 'region', name: 'Region', type: 'text' },
      { id: 'amount', name: 'Amount', type: 'money', format: '£#,##0.00', w: 140 },
      { id: 'double', name: 'Double', type: 'number', formula: '=Amount*2' },
    ],
    data: {
      region: { enc: 'raw', v: ['North', 'South', 'East'] },
      amount: { enc: 'raw', v: [1200, 980, 4000] },
    },
    cells: { 'amount:2': { v: 1000, note: 'corrected' } },
    totals: { amount: 'sum' },
    steps: [{ op: 'import', from: 'x', at: '' }],
  }
  const flat = flattenToSpreadsheet(ds, {
    sheetId: 'cp', name: 'Pipeline (copy)',
    computed: new Map([['double', [2400, 2000, 8000]]]),
  })
  ok(flat.sheet.cells.A1?.v === 'Region' && flat.sheet.cells.A1?.bold === true,
    'the column names are row 1, and they are bold')
  ok(flat.sheet.cells.B2?.v === 1200 && flat.sheet.cells.B3?.v === 1000,
    'the values come across, hand corrections included')
  ok(flat.sheet.cells.B2?.format === '£#,##0.00', 'and the column format becomes a cell format')
  ok(flat.sheet.cells.C2?.v === 2400, 'a computed column flattens to the numbers it produced')
  ok(/Computed by: =Amount\*2/.test(String(flat.sheet.cells.C1?.note)),
    'and the expression is kept in the header cell\'s note, so the copy still says how the numbers were made')
  ok(flat.sheet.cols?.B === 140, 'column widths follow')
  ok(codes(flat.findings).includes('copy-not-move')
    && codes(flat.findings).includes('column-formula-flattened'),
    'and both the copy and the flattening are stated, not discovered')
  ok(codes(flat.findings).includes('overrides-flattened'),
    'as is what belongs to the dataset and cannot come along')

  // the round trip
  const back = promoteRange(view(flat.sheet), box(0, 0, 3, 2), { sheetId: 'ds2', name: 'Back', at: '' })
  ok(back.ok && back.sheet.columns.map((c) => c.name).join(',') === 'Region,Amount,Double',
    'promoting the copy back finds the same columns')
  ok(back.ok && columnValues(back.sheet, back.sheet.columns[1].id).join(',') === '1200,1000,4000',
    'with the same values')
}
{
  // A dataset's PER-CELL formula addresses positions, and so does a
  // spreadsheet's. One row down for the header, columns unmoved.
  const ds: TableSheet = {
    id: 'ds', name: 'S', kind: 'table',
    rids: [[1, 2]], nextRid: 3,
    columns: [
      { id: 'a', name: 'A', type: 'number' },
      { id: 'b', name: 'B', type: 'number' },
    ],
    data: { a: { enc: 'raw', v: [2, 3] }, b: { enc: 'raw', v: [null, null] } },
    cells: { 'b:1': { f: '=A1*10' } },
    steps: [{ op: 'import', from: 'x', at: '' }],
  }
  const flat = flattenToSpreadsheet(ds, { sheetId: 'cp', name: 'C' })
  ok(flat.sheet.cells.B2?.f === '=A2*10',
    `a per-cell formula moves down with the header row (${String(flat.sheet.cells.B2?.f)})`)
  const values = computeCanvas(flat.sheet.cells)
  ok(values.get('1,1') === 20, 'and it computes the number it computed on the dataset')
}

// ============================================================ the banner's two kinds

console.log('\nevery finding says how loudly it should be read')
{
  // A promotion that emits BOTH kinds at once: a trimmed edge, a guessed
  // header, a column that would not fully coerce, and the reassurance that the
  // range is still where it was.
  const s = sheetOf([
    [null, null, null],
    [null, 'Region', 'Amount'],
    // enough numbers that one 'n/a' is a FAILED COERCION rather than a text
    // column — the loud finding this case exists to produce
    ...[12, 40, 25, 'n/a', 18, 22, 31, 9, 14, 27].map((v, i) => [null, `R${i}`, v]),
  ])
  const r = promoteRange(view(s), box(0, 0, 11, 4), { sheetId: 'ds', name: 'D', at: '' })
  ok(r.ok && codes(r.findings).includes('coerce-failed') && r.findings.length > 3,
    `a messy range emits several findings (${r.ok ? codes(r.findings).join(' ') : ''})`)
  ok(r.ok && severityOk(r.findings),
    'and each is loud or quiet according to whether it could be wrong about the data')
  ok(r.ok && r.findings.some((f) => f.severity === 'suspicious')
    && r.findings.some((f) => f.severity === 'note'),
    'with both kinds present, so the caller has something to sort by')
  const flat = flattenToSpreadsheet(
    (r as { sheet: TableSheet }).sheet, { sheetId: 'cv', name: 'C' })
  ok(severityOk(flat.findings), 'and the other direction keeps the same discipline')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
