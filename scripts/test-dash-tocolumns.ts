#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash TEXT TO COLUMNS rig — splitting one column into several.
//
//   node scripts/test-dash-tocolumns.ts
//
// WHY THIS EXISTS. Splitting a column is a bulk write into cells nobody chose:
// the number of output columns comes out of the DATA, so the author cannot see
// how far right it will reach before it goes. Five things have to hold, and
// each one is a way the feature could look fine and be wrong.
//
//   1. THE DELIMITER IS import.ts's, not a second parser. `"Smith, John",Acme`
//      is two fields, and the moment there are two implementations of "where
//      does a field end" they disagree on exactly the values nobody tests —
//      doubled quotes, a quote mid-field, an embedded newline. So `splitField`
//      hands the value to `parseDelimited` as a one-line file. Checked against
//      that parser's own behaviour, not against a hand-written expectation.
//   2. THE TYPES ARE import.ts's INFERENCE, AND IT REFUSES. A column of
//      `03/04/2026` is 3 April or 4 March and the data does not say; import
//      reports `ambiguous` and lands TEXT rather than moving a quarter by a
//      month. A split's outputs are a fresh column each and must make the same
//      refusal. `derive`'s own `inferType` guesses, which is one of the four
//      reasons this is not N derives (tocolumns.ts header).
//   3. THE OVERWRITE IS ANNOUNCED. Excel asks; so must this. `splitCollisions`
//      names the columns, and the caller may not commit without asking.
//   4. IT LANDS IN THE DOCUMENT. Nothing in this build runs a base sheet's
//      pipeline, so a `split` STEP alone would be a command that changes
//      nothing on screen — the exact failure the last round shipped. So the
//      command writes columns AND records the step, and this rig applies the
//      patches to a real `Store` and reads the sheet back.
//   5. THE TWO CANNOT DISAGREE, AND THE STEP IS IDEMPOTENT. The bytes and the
//      pipeline both come from `planSplit`; running the recorded step through
//      `runSteps` must reproduce the columns exactly. It can only do that
//      because the SOURCE COLUMN IS KEPT — Excel eats it, which makes the
//      operation non-re-runnable, and a step that has consumed its own input
//      is not a step.
//
// The last section reads main.ts and select.ts: a correct planner that nothing
// calls is the failure this project has already shipped once.

import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'

registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const {
  splitOne, splitWidth, proposedColumns, splitCollisions, planSplit,
  splitStep, deriveStepsForWidths, planTableSplit, planCanvasSplit,
} = await import('../dash/src/tocolumns.ts')
const { splitField, cutField, parseDelimited } = await import('../dash/src/import.ts')
const { parseDoc } = await import('../dash/src/model.ts')
const { Store, readCell } = await import('../dash/src/store.ts')
const { runSheet, sourceOf, frameOf, runSteps, values } = await import('../dash/src/steps.ts')
const { keyToAction } = await import('../dash/src/select.ts')

type Patch = import('../dash/src/store.ts').Patch
type Step = import('../dash/src/model.ts').Step
type DashDoc = import('../dash/src/model.ts').DashDoc
type TableSheet = import('../dash/src/model.ts').TableSheet
type CanvasSheet = import('../dash/src/model.ts').CanvasSheet

let failures = 0
let checks = 0
const j = (v: unknown): string => JSON.stringify(v)
function ok(cond: boolean, msg: string): void {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
function eq(got: unknown, want: unknown, msg: string): void {
  const same = j(got) === j(want)
  ok(same, same ? msg : `${msg} — got ${j(got)}, wanted ${j(want)}`)
}

// --- fixtures ----------------------------------------------------------------

const NAMES = ['Ada, Lovelace', 'Grace, Hopper', 'Alan, Turing', 'Katherine, Johnson']

const freshTable = (col: unknown[] = NAMES): DashDoc => parseDoc(JSON.stringify({
  format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 'test',
  sheets: [{
    id: 'sh1', name: 'S', kind: 'table',
    rids: [[1, col.length]], nextRid: col.length + 1,
    columns: [
      { id: 'who', name: 'Who', type: 'text' },
      { id: 'amount', name: 'Amount', type: 'number' },
    ],
    data: {
      who: { enc: 'raw', v: col },
      amount: { enc: 'raw', v: col.map((_, i) => (i + 1) * 10) },
    },
    steps: [{ op: 'import', from: 'people.csv', at: '2026-08-03T00:00:00Z', rows: col.length }],
  }],
})).doc

const table = (d: DashDoc): TableSheet => d.sheets[0] as TableSheet
const canvas = (d: DashDoc): CanvasSheet => d.sheets[0] as CanvasSheet
const colOf = (s: TableSheet, id: string): unknown[] =>
  s.rids.flatMap(([, n]) => Array.from({ length: n }, (_, i) => readCell(s.data[id], i)))
const cvKey = (r: number, c: number): string => `${String.fromCharCode(65 + c)}${r + 1}`

// ============================================================ the delimiter

console.log('\n-- the delimiter is import.ts\'s parser, not a second one')
{
  eq(splitField('Ada, Lovelace', ','), ['Ada', 'Lovelace'], 'a comma splits, and the fields are trimmed')
  eq(splitField('"Smith, John",Acme', ','), ['Smith, John', 'Acme'],
    'a QUOTED comma does not split — the whole reason not to write a second parser')
  eq(splitField('"say ""hi""",there', ','), ['say "hi"', 'there'],
    'and a doubled quote INSIDE a quoted field is one literal quote')
  eq(splitField('5" pipe,brass', ','), ['5" pipe', 'brass'],
    'a quote that does not OPEN a field is just a character — Excel writes 5" pipe unquoted')
  eq(splitField('a,b', ',', { trim: false }), ['a', 'b'], 'trim can be turned off')
  eq(splitField(' a , b ', ',', { trim: false }), [' a ', ' b '], 'and then the spaces survive')
  eq(splitField('', ','), [''], 'an empty value is ONE empty field, not none — a blank row still occupies its columns')
  eq(splitField('"a,b",c', ',', { quoted: false }), ['"a', 'b"', 'c'],
    'quoted:false is the escape hatch for data that CONTAINS quotes as text')

  // Not a hand-written expectation: the same bytes through the FILE parser.
  const viaFile = parseDelimited('"Smith, John",Acme', ',').rows[0]
  eq(splitField('"Smith, John",Acme', ','), viaFile,
    'and the answer is byte-identical to what the CSV importer would produce')
}

console.log('\n-- fixed width cuts at character positions')
{
  eq(cutField('2026-08-14', [4, 7]), ['2026', '-08', '-14'], 'two cut points give three fields')
  eq(cutField('ab', [4, 7]), ['ab', '', ''],
    'a SHORT value gives empty fields rather than fewer — the column count belongs to the split')
  eq(cutField('abcdef', [3]), ['abc', 'def'], 'one cut point, two fields')
  eq(splitOne('2026-08-14', { widths: [4, 7] }), ['2026', '-08', '-14'],
    'splitOne routes to the fixed-width arm when widths are given')
}

console.log('\n-- the width is the WIDEST row, not the first')
{
  // Excel's wizard previews the first row; a middle name in row 40 then loses
  // its surname, silently.
  eq(splitWidth(['a,b', 'c,d,e', 'f'], { by: ',' }), 3,
    'three, because one row has three fields')
  eq(splitWidth(NAMES, { by: ',' }), 2, 'two for a clean name column')
  eq(splitWidth([], { by: ',' }), 1, 'and never zero — an empty column still produces one')
  eq(splitWidth(['x'], { widths: [2, 5] }), 3, 'fixed width does not measure: the cut points are the answer')
}

// ============================================================ inference

console.log('\n-- the output types come from import.ts, and it REFUSES where it cannot decide')
{
  const into = proposedColumns('Pair', 'pair', 2)
  const numeric = planSplit(['1,10', '2,20', '3,30'], { by: ',' }, into)
  eq(numeric.columns.map((c) => c.type), ['number', 'number'], 'two numeric halves are typed number')
  eq(numeric.values[1], [10, 20, 30], 'and the values are NUMBERS, not the strings they were cut from')

  // THE ONE THAT MATTERS. Every value fits both DD/MM and MM/DD.
  const dates = planSplit(['03/04/2026,x', '05/06/2026,y'], { by: ',' }, into)
  eq(dates.columns[0].type, 'text',
    'an undecidable date column lands as TEXT rather than as dates eleven months out')
  ok(dates.findings.some((f) => f.code === 'split-ambiguous'),
    'and says so — the refusal is reported, not swallowed')

  const iso = planSplit(['2026-01-05|a', '2026-02-06|b'], { by: '|' }, into)
  eq(iso.columns[0].type, 'date', 'an ISO column, which IS decidable, is typed date')

  const ragged = planSplit(['a,b,c', 'd,e'], { by: ',' }, into)
  ok(ragged.findings.some((f) => f.code === 'split-ragged'),
    'a row with more fields than columns loses its tail, and that is said out loud')

  const short = planSplit(['a', 'b'], { by: ',' }, into)
  ok(short.findings.some((f) => f.code === 'split-empty'),
    'a column that came out empty on every row is reported too')
}

// ============================================================ the overwrite

console.log('\n-- an overwrite is named before it happens')
{
  const doc = freshTable()
  const s = table(doc)
  const into = proposedColumns('Who', 'who', 2)
  eq(splitCollisions(into, s.columns, 'who'), [],
    'the default names collide with nothing on a fresh sheet')
  eq(splitCollisions([{ id: 'amount', name: 'Amount' }], s.columns, 'who'), ['Amount'],
    'and a target that IS an existing column is named, by the name a reader sees')
  eq(splitCollisions([{ id: 'who', name: 'Who' }], s.columns, 'who'), [],
    'the source is never a collision with itself — the split keeps it')

  const out = planTableSplit(s, 'who', { by: ',' },
    { into: [{ id: 'amount', name: 'Amount' }] })
  eq(out.collisions, ['Amount'], 'planTableSplit reports the collision to the caller')
  ok(out.patches.length > 0, 'and still produces the patches, because the caller decides')
  // An existing column is rewritten IN PLACE. Removing and re-adding would take
  // its position, its width, its conditional formats and its comments with it.
  ok(!out.patches.some((p) => p.op === 'addColumn' && (p as { column: { id: string } }).column.id === 'amount'),
    'an existing column is retyped and rewritten, never removed and re-added')
  ok(out.patches.some((p) => p.op === 'setColumn'), 'via setColumn')
}

// ============================================================ the outcome

console.log('\n-- the columns actually land in the document')
{
  const store = new Store(freshTable())
  const out = planTableSplit(table(store.doc), 'who', { by: ',' })
  eq(out.into.map((c) => c.name), ['Who 1', 'Who 2'], 'two columns, numbered from the source name')
  store.commit(out.patches as Patch[])
  const s = table(store.doc)
  eq(s.columns.map((c) => c.id), ['who', 'who-1', 'who-2', 'amount'],
    'they are inserted straight after the column they came from, and the SOURCE IS KEPT')
  eq(colOf(s, 'who-1'), ['Ada', 'Grace', 'Alan', 'Katherine'], 'the first field is there')
  eq(colOf(s, 'who-2'), ['Lovelace', 'Hopper', 'Turing', 'Johnson'], 'and the second')
  eq(colOf(s, 'who'), NAMES, 'and the original column is untouched')
  eq(colOf(s, 'amount'), [10, 20, 30, 40], 'as is everything else on the sheet')

  store.undo()
  eq(table(store.doc).columns.map((c) => c.id), ['who', 'amount'],
    'and undo takes the whole split back')
}

console.log('\n-- the lineage is recorded, and the step reproduces the bytes')
{
  const store = new Store(freshTable())
  const out = planTableSplit(table(store.doc), 'who', { by: ',' })
  store.commit(out.patches as Patch[])
  const s = table(store.doc)
  const split = s.steps.find((st) => (st as { op: string }).op === 'split') as
    { op: string; col: string; by: string; into: Array<{ id: string }> } | undefined
  ok(!!split, 'a `split` step is in the sheet\'s step list')
  eq(split?.col, 'who', 'naming the column it cut')
  eq(split?.by, ',', 'and the delimiter, ONCE — not once per output column')
  eq(s.steps[0], { op: 'import', from: 'people.csv', at: '2026-08-03T00:00:00Z', rows: 4 },
    'the provenance head is untouched: applySteps owns the re-executable tail only')

  // THE BYTES AND THE PIPELINE MUST AGREE. Both come from `planSplit`; if they
  // ever stopped, a re-run would change a column nobody edited.
  const r = runSheet(store.doc, 'sh1')
  ok(r !== undefined && r.ok, 'and the sheet\'s own pipeline runs it without a fatal finding')
  eq(values(r!.frame, 'who-1'), ['Ada', 'Grace', 'Alan', 'Katherine'],
    'producing exactly the values that are already in the sheet')

  // IDEMPOTENT, which is only possible because the source column survives.
  const again = runSteps(frameOf(sourceOf(s)), [split as Step, split as Step], {})
  eq(values(again.frame, 'who-2'), ['Lovelace', 'Hopper', 'Turing', 'Johnson'],
    'running the step twice produces the same answer as running it once')
}

console.log('\n-- fixed width, and the `derive` alternative that was rejected and why')
{
  // `derive` expresses the CUT perfectly — this is the pipeline saying so.
  const alt = deriveStepsForWidths('Who', { widths: [4, 7] },
    proposedColumns('Who', 'who', 3))
  eq(alt.map((s) => (s as { op: string }).op), ['derive', 'derive', 'derive'],
    'three cuts really are three ordinary derives')
  eq((alt[0] as { expr: string }).expr, 'MID([Who], 1, 4)', 'the first four characters')
  eq((alt[1] as { expr: string }).expr, 'MID([Who], 5, 3)', 'then the next three')
  eq((alt[2] as { expr: string }).expr, 'MID([Who], 8, LEN([Who]))',
    'and the last field runs to the end, however long the value is')
  eq(deriveStepsForWidths('Who', { widths: [] }, [{ id: 'a', name: 'A' }]).length, 1,
    'no cut points is one field, which is the whole value')

  // WHAT IT CANNOT EXPRESS, and the measurement that settled it: MID returns
  // TEXT, so a derive pipeline types every output text while the command's own
  // bytes are typed by import.ts's inference. Bytes and pipeline disagreeing
  // about a column's type is the failure the whole design prevents.
  const store = new Store(freshTable(['2026-08-14', '2025-01-02']))
  const viaDerive = runSteps(frameOf(sourceOf(table(store.doc))), alt, {})
  eq(values(viaDerive.frame, 'who-1'), ['2026', '2025'],
    'through derives the first field is the STRING "2026"')

  const out = planTableSplit(table(store.doc), 'who', { widths: [4, 7] })
  eq(out.steps.map((s) => (s as { op: string }).op), ['split'],
    'so the command records ONE split step for this arm too, not three derives')
  eq((out.steps[0] as { widths: number[] }).widths, [4, 7], 'carrying the cut points')
  store.commit(out.patches as Patch[])
  eq(colOf(table(store.doc), 'who-1'), [2026, 2025],
    'and the committed column is the NUMBER 2026, because inferColumn read the whole column')
  const r = runSheet(store.doc, 'sh1')
  eq(values(r!.frame, 'who-1'), [2026, 2025],
    'and re-running the sheet\'s pipeline gives the same number — bytes and pipeline agree')
  // And the inference is import.ts's, warts and all: a column of "-08"/"-01"
  // reads as numbers there too, so it reads as numbers here. That is the point
  // of reusing it rather than writing a kinder one — one answer to "what is
  // this column", right or wrong, in every place the app asks.
  eq(values(r!.frame, 'who-2'), [-8, -1],
    'the middle field is typed by the same inference the CSV importer uses, not a second one')
  eq(colOf(table(store.doc), 'who-2'), [-8, -1], 'and the bytes say exactly the same thing')
}

console.log('\n-- what the command refuses')
{
  const doc = freshTable()
  const s = table(doc)
  s.columns[1].formula = 'Amount * 2'
  eq(planTableSplit(s, 'amount', { by: ',' }).refusal, 'computed-column',
    'a computed column has nothing STORED in it to split')
  eq(planTableSplit(s, 'nope', { by: ',' }).refusal, 'no-column', 'and a column that is not there')
  eq(planTableSplit(s, 'who', {}).refusal, 'no-delimiter', 'and a split with no rule to split by')
  eq(planTableSplit(s, 'who', {}).patches, [], 'each refusal produces no patches at all')
}

// ============================================================ the spreadsheet

console.log('\n-- on a SPREADSHEET it is a one-off write, in Excel\'s place')
{
  const doc = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
    sheets: [{
      id: 'cv1', name: 'Sheet', kind: 'canvas',
      cells: {
        A1: { v: 'Ada, Lovelace', bold: true }, A2: { v: 'Alan, Turing' },
        B1: { v: 'keep me' },
        A3: { f: '=A1' },
      },
    }],
  })).doc
  const store = new Store(doc)
  const out = planCanvasSplit(canvas(store.doc), { top: 0, bottom: 2, col: 0 }, { by: ',' }, cvKey)
  eq(out.width, 2, 'two fields')
  eq(out.overwrites, 1, 'and B1 already holds something — counted, so the caller can ask')
  ok(out.findings.some((f) => f.message.includes('formula')),
    'the formula cell A3 is left alone, and said so')
  store.commit(out.patches as Patch[])
  const c = canvas(store.doc).cells
  eq(c.A1?.v, 'Ada', 'the first field REPLACES the cell that was split — Excel\'s placement')
  eq(c.B1?.v, 'Lovelace', 'and the second spills right, over what was there')
  eq(c.A1?.bold, true, 'appearance survives: a split moves CONTENT')
  eq(c.A2?.v, 'Alan', 'row two too')
  eq(c.B2?.v, 'Turing', 'both fields')
  eq(c.A3?.f, '=A1', 'and the formula cell still holds its formula, not slices of its own output')
}

// ============================================================ the wiring

console.log('\n-- the command is reachable, on both kinds of sheet')
{
  eq(keyToAction({ key: 'D', metaKey: true, shiftKey: true }), { kind: 'textToColumns' },
    '⌘⇧D is Text to Columns')
  eq(keyToAction({ key: 'd', metaKey: true }), { kind: 'fill' },
    'and plain ⌘D is still fill down — the key beside it, deliberately')

  const main = readFileSync(new URL('../dash/src/main.ts', import.meta.url), 'utf8')
  ok(/kind === 'textToColumns'[\s\S]{0,120}textToColumns\(\)/.test(main),
    'main.ts dispatches the action')
  // gridmenu.ts owns the three grid menus now — see scripts/test-dash-menu.ts,
  // which asserts the items a real right-click produces rather than the source.
  const menu = readFileSync(new URL('../dash/src/gridmenu.ts', import.meta.url), 'utf8')
  ok(menu.includes('data-a="split"') && menu.includes('hooks.split()'),
    'and the dataset cell menu offers it')
  // A SPREADSHEET HAS NO CELL MENU (grid.ts declines to open the dataset one
  // over a canvas), so the chord is the only route there and it must not be
  // gated behind the dataset branch.
  ok(/async function textToColumns[\s\S]{0,2000}planCanvasSplit\(/.test(main),
    'and the one command handles the spreadsheet kind, which has no menu at all')
  // The gate is `if (<overwrite> && !confirm(...)) return` STANDING BETWEEN the
  // plan and the commit. Matched as a whole so that neutering the condition —
  // the cheapest way to break this — cannot leave the check green.
  ok(/if \(out\.collisions\.length && !window\.confirm\([\s\S]{0,240}?\)\) return\n\s*store\.commit\(out\.patches/.test(main),
    'the caller ASKS before committing a split that overwrites existing columns, and the ask gates the commit')
  ok(/if \(out\.overwrites && !window\.confirm\([\s\S]{0,240}?\)\) return\n\s*store\.commit\(out\.patches/.test(main),
    'and the same gate stands in front of the spreadsheet commit')
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'} — ${checks - failures}/${checks} checks`)
process.exit(failures ? 1 : 0)
