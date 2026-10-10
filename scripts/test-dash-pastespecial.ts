#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash PASTE SPECIAL rig — values only, formulas, formats only, transpose.
//
//   node scripts/test-dash-pastespecial.ts
//
// WHY THIS EXISTS. A paste is a BULK OVERWRITE: it is the one gesture where a
// wrong answer destroys a screenful of somebody's work on one keystroke, and
// leaves nothing behind saying what was there. Four separate ways to get it
// wrong are checked here, and three of them have precedent in this repo.
//
//   1. AN ERROR OBJECT WRITTEN INTO A TYPED COLUMN. scripts/test-dash-fill.ts
//      records the measurement: fill seeded from the computed value and wrote
//      `{code:'#VALUE!'}` into a money column as though a person had typed it.
//      Paste special approaches the same cliff from the other side — "values
//      only" WANTS the computed value, so "read the source, never the result"
//      is not available as a fix. The rule is the other half: an error is not a
//      value, so it pastes BLANK and is COUNTED. Checked on the document
//      AFTER the commit, not on the plan.
//   2. A "FORMATS ONLY" PASTE THAT MOVED A NUMBER. The whole promise of the
//      command. Checked by summing a column before and after — the same shape
//      scripts/test-dash-cellfmt.ts uses to prove bolding cannot change a
//      total — and by checking the written keys against APPEARANCE_FIELDS,
//      which is the ONE runtime list of what "format" means. A second list is
//      how `v` eventually leaks through.
//   3. A FORMULA THAT DID NOT MOVE, OR MOVED WHEN IT SHOULD NOT. A COPIED
//      formula's relative references shift by how far the cell went and `$A$1`
//      does not; a CUT one does not shift at all, because the one formula
//      travelled with its cells. Getting that backwards silently re-points a
//      moved formula at the wrong data.
//   4. A FEATURE THAT IS CORRECT AND UNREACHABLE. The last round of this work
//      shipped a rig that proved a pure function while nothing on screen
//      called it. So the last section reads main.ts and select.ts and checks
//      the WIRING: that the chord exists in the one key map, that main.ts
//      dispatches it, that the clip is snapshotted BEFORE the grid handles the
//      key (⌘X clears the selection — a snapshot after it is a rectangle of
//      blanks), and that the menu is in the cell menu too.
//
// Everything else drives the real `Store`: patches are committed and the
// DOCUMENT is read back, because the document is the outcome.

import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'

// a1.ts and cellformula.ts are DOM-free; pastespecial.ts imports nothing that
// is not, and this stub is here only because model.ts's neighbours can pull a
// stylesheet in through a type-only path in some resolutions.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const {
  planPasteSpecial, pasteSpecialItems, pickLook, refusesValue,
  canvasPastePatches, tablePastePatches,
} = await import('../dash/src/pastespecial.ts')
const { APPEARANCE_FIELDS, parseDoc } = await import('../dash/src/model.ts')
const { Store, readCell } = await import('../dash/src/store.ts')
const { keyToAction } = await import('../dash/src/select.ts')
const { FormulaError } = await import('../dash/src/formula.ts')

type Patch = import('../dash/src/store.ts').Patch
type DashDoc = import('../dash/src/model.ts').DashDoc
type TableSheet = import('../dash/src/model.ts').TableSheet
type CanvasSheet = import('../dash/src/model.ts').CanvasSheet
type Clip = import('../dash/src/pastespecial.ts').Clip
type ClipCell = import('../dash/src/pastespecial.ts').ClipCell
type PastePlan = import('../dash/src/pastespecial.ts').PastePlan

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

/** Four rows, a text column and a money column with a per-cell formula in it. */
const freshTable = (): DashDoc => parseDoc(JSON.stringify({
  format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 'test',
  sheets: [{
    id: 'sh1', name: 'S', kind: 'table',
    rids: [[1, 4]], nextRid: 5,
    columns: [
      { id: 'region', name: 'Region', type: 'text' },
      { id: 'amount', name: 'Amount', type: 'money' },
      { id: 'note', name: 'Note', type: 'text' },
    ],
    data: {
      region: { enc: 'raw', v: ['North', 'South', 'North', 'South'] },
      amount: { enc: 'raw', v: [10, 20, 30, 40] },
      note: { enc: 'raw', v: ['a', 'b', 'c', 'd'] },
    },
    steps: [{ op: 'import', from: 'q3.csv', at: '2026-08-03T00:00:00Z', rows: 4 }],
  }],
})).doc

const freshCanvas = (): DashDoc => parseDoc(JSON.stringify({
  format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 'test',
  sheets: [{
    id: 'cv1', name: 'Sheet', kind: 'canvas',
    cells: {
      A1: { v: 1, bold: true }, B1: { v: 2 }, C1: { v: 3 },
      A2: { v: 4 }, B2: { v: 5 }, C2: { v: 6 },
    },
  }],
})).doc

const table = (d: DashDoc): TableSheet => d.sheets[0] as TableSheet
const canvas = (d: DashDoc): CanvasSheet => d.sheets[0] as CanvasSheet

/** The dataset target, as main.ts builds it from the grid — no view, no sort. */
function targetFor(s: TableSheet, row: number, col: number) {
  return {
    sheetId: s.id,
    colAt: (dc: number) => {
      const c = s.columns[col + dc]
      return c
        ? { id: c.id, type: c.type, formula: c.formula, parsed: c.parsed, index: col + dc }
        : null
    },
    ridAt: (dr: number) => {
      const i = row + dr
      let seen = 0
      for (const [start, count] of s.rids) {
        if (i < seen + count) return start + (i - seen)
        seen += count
      }
      return -1
    },
    rowOf: (rid: number) => {
      let i = 0
      for (const [start, count] of s.rids) {
        if (rid >= start && rid < start + count) return i + (rid - start)
        i += count
      }
      return -1
    },
    overrideAt: (k: string) => s.cells?.[k],
  }
}

const canvasTarget = (s: CanvasSheet) => ({
  sheetId: s.id,
  cellAt: (r: number, c: number) => s.cells[`${String.fromCharCode(65 + c)}${r + 1}`],
  maxRows: 1_048_576,
  maxCols: 16_384,
})

const cell = (over: Partial<ClipCell>, r: number, c: number): ClipCell =>
  ({ r, c, ...over } as ClipCell)

const colValue = (s: TableSheet, colId: string, row: number): unknown => {
  const rid = row + 1
  const over = s.cells?.[`${colId}:${rid}`]
  if (over && 'v' in over) return over.v
  return readCell(s.data[colId], row)
}

// ============================================================ the value gate

console.log('\n-- an error is not a value, and never becomes one')
{
  // The fill rig's lesson, restated as the gate this file runs EVERY value
  // through. A whitelist, not "is it an error": a Date and a bare `{}` are
  // equally unstorable and a blacklist would have let both past.
  ok(refusesValue(new FormulaError('#VALUE!', 'nope')), 'a FormulaError is refused')
  ok(refusesValue(new Date()), 'and so is a Date')
  ok(refusesValue({}), 'and a stray object')
  ok(refusesValue([1, 2]), 'and an array')
  ok(!refusesValue(0) && !refusesValue('') && !refusesValue(false) && !refusesValue(null),
    'while 0, empty string, false and null are all perfectly good cell values')

  const clip: Clip = {
    kind: 'table',
    rows: [[cell({ v: new FormulaError('#VALUE!', 'not a number'), f: '=Amount*2' }, 0, 1)]],
  }
  const plan = planPasteSpecial(clip, { what: 'values' })
  eq(plan.dropped, 1, 'a failed formula pasted as VALUES is counted as dropped')
  eq(plan.cells[0].v, null, 'and lands as a blank')
  ok(!j(plan).includes('#VALUE!'), 'no error text survives anywhere in the plan')
}

console.log('\n-- and the DOCUMENT after the commit holds no error either')
{
  const store = new Store(freshTable())
  const s = table(store.doc)
  const clip: Clip = {
    kind: 'table',
    rows: [[cell({ v: new FormulaError('#VALUE!', 'bad'), f: '=Amount*2' }, 0, 1)]],
  }
  const plan = planPasteSpecial(clip, { what: 'values' })
  const w = tablePastePatches(targetFor(s, 2, 1), plan)
  store.commit(w.patches as Patch[])
  const after = table(store.doc)
  eq(colValue(after, 'amount', 2), null, 'the money cell it landed on is BLANK, not an error object')
  ok(!j(store.doc).includes('#VALUE!'), 'and the whole document holds no #VALUE! anywhere')
  ok(typeof colValue(after, 'amount', 3) === 'number',
    'the row below is untouched — a paste of one cell writes one cell')
}

// ============================================================ values only

console.log('\n-- VALUES ONLY lands the computed number and drops the formula')
{
  const store = new Store(freshTable())
  const s = table(store.doc)
  // Row 1 of Amount carries a per-cell formula whose result is 999.
  store.commit({
    op: 'setOverrides', sheet: 'sh1', keys: ['amount:1'], v: [{ f: '=Amount*2' }],
  } as Patch)
  const clip: Clip = { kind: 'table', rows: [[cell({ v: 999, f: '=Amount*2' }, 0, 1)]] }
  const plan = planPasteSpecial(clip, { what: 'values' })
  ok(plan.cells[0].f === undefined, 'the plan carries NO formula — that is the command')
  eq(plan.cells[0].v, 999, 'it carries the number the formula printed')
  const w = tablePastePatches(targetFor(table(store.doc), 2, 1), plan)
  store.commit(w.patches as Patch[])
  const after = table(store.doc)
  eq(colValue(after, 'amount', 2), 999, 'and 999 is what the target cell now holds')
  ok(after.cells?.['amount:3']?.f === undefined,
    'with no formula behind it — pasting a value over a formula must remove the formula, or it just recomputes')
  ok(after.cells?.['amount:1']?.f === '=Amount*2',
    'the cell it was COPIED from still has its formula: a paste is not a move')
}

console.log('\n-- and it coerces through import.ts to the target column\'s type')
{
  // Clipboard text is strings. Writing "1.234" into a money column without the
  // convention the column was read with is import.ts's decimal-comma mistake,
  // one layer down.
  const store = new Store(freshTable())
  const clip: Clip = { kind: 'table', rows: [[cell({ v: '1,250' }, 0, 1)]] }
  const w = tablePastePatches(
    targetFor(table(store.doc), 0, 1), planPasteSpecial(clip, { what: 'values' }))
  store.commit(w.patches as Patch[])
  eq(colValue(table(store.doc), 'amount', 0), 1250,
    '"1,250" into a money column is the NUMBER 1250, not the string')
}

// ============================================================ formulas

console.log('\n-- FORMULAS translate relative references and leave $ANCHORED ones alone')
{
  const store = new Store(freshTable())
  const s = table(store.doc)
  const clip: Clip = {
    kind: 'table',
    rows: [[cell({ v: 20, f: '=B1*2' }, 0, 1), cell({ v: 'x', f: '=$B$1+C1' }, 0, 2)]],
  }
  const plan = planPasteSpecial(clip, { what: 'formulas' })
  ok(plan.dropped === 0, 'nothing is dropped')
  // pasted two rows down and in the same columns
  const w = tablePastePatches(targetFor(s, 2, 1), plan)
  store.commit(w.patches as Patch[])
  const after = table(store.doc)
  eq(after.cells?.['amount:3']?.f, '=B3*2', '=B1*2 pasted two rows down is =B3*2')
  eq(after.cells?.['note:3']?.f, '=$B$1+C3', 'and the $-anchored half of =$B$1+C1 did not move')
}

console.log('\n-- a CUT formula does not translate: it is the same formula, moved')
{
  const store = new Store(freshTable())
  const clip: Clip = { kind: 'table', cut: true, rows: [[cell({ v: 20, f: '=B1*2' }, 0, 1)]] }
  const plan = planPasteSpecial(clip, { what: 'formulas' })
  ok(plan.cut === true, 'the plan remembers it was a cut')
  const w = tablePastePatches(targetFor(table(store.doc), 2, 1), plan)
  store.commit(w.patches as Patch[])
  eq(table(store.doc).cells?.['amount:3']?.f, '=B1*2',
    'two rows down, and still =B1*2 — a cut moves the ONE formula and it still means what it did')
}

console.log('\n-- a CONSTANT inside a formulas paste pastes as its constant')
{
  // Excel's behaviour, and the reason for it: a block of formulas nearly always
  // has literal inputs in it, and dropping them pastes formulas pointing at
  // empty cells.
  const clip: Clip = {
    kind: 'table', rows: [[cell({ v: 7 }, 0, 1), cell({ v: 14, f: '=B1*2' }, 0, 2)]],
  }
  const plan = planPasteSpecial(clip, { what: 'formulas' })
  eq(plan.cells.map((c) => (c.f !== undefined ? c.f : c.v)), [7, '=B1*2'],
    'the literal rides along beside the formula')
}

// ============================================================ formats only

console.log('\n-- FORMATS ONLY changes how a cell is drawn and nothing about what it is')
{
  const store = new Store(freshTable())
  const before = table(store.doc).data.amount
  const sum = (s: TableSheet): number =>
    [0, 1, 2, 3].reduce((a, r) => a + (Number(colValue(s, 'amount', r)) || 0), 0)
  const was = sum(table(store.doc))
  const clip: Clip = {
    kind: 'table',
    rows: [[cell({ v: 999, f: '=B1*2', look: { bold: true, bg: '#fff3cd' } }, 0, 1)]],
  }
  const plan = planPasteSpecial(clip, { what: 'formats' })
  ok(plan.cells.every((c) => c.looksOnly === true), 'every planned cell says it is appearance-only')
  ok(plan.cells.every((c) => c.v === undefined && c.f === undefined),
    'and carries neither a value nor a formula')
  const w = tablePastePatches(targetFor(table(store.doc), 0, 1), plan)
  store.commit(w.patches as Patch[])
  const after = table(store.doc)
  eq(after.cells?.['amount:1']?.bold, true, 'the bold landed')
  eq(sum(after), was, 'and the column totals exactly what it totalled before — to the digit')
  eq(after.data.amount, before, 'the stored column is byte-identical')
}

console.log('\n-- and it may only write APPEARANCE_FIELDS — the one runtime list')
{
  // `pickLook` filters through model.ts's list rather than spreading the cell.
  // A second list here is how "format" comes to mean two things in two files.
  const got = pickLook({
    bold: true, bg: '#eee', align: 'right',
    v: 42, f: '=A1', was: 1, xlsxF: 'SUM(A:A)', note: 'hi', by: 'me',
  })
  eq(Object.keys(got ?? {}).sort(), ['align', 'bg', 'bold'],
    'v, f, was, xlsxF, note and by are all left behind')
  ok(Object.keys(got ?? {}).every((k) => (APPEARANCE_FIELDS as readonly string[]).includes(k)),
    'and every key that came through is in APPEARANCE_FIELDS')

  const clip: Clip = {
    kind: 'table',
    rows: [[cell({ look: got, v: 999 }, 0, 1)]],
  }
  const plan = planPasteSpecial(clip, { what: 'formats' })
  const w = tablePastePatches(targetFor(table(freshTable()), 0, 1), plan)
  const over = (w.patches.find((p) => p.op === 'setOverrides') as {
    v: Array<Record<string, unknown>>
  }).v[0]
  ok(Object.keys(over).every((k) => (APPEARANCE_FIELDS as readonly string[]).includes(k)),
    'the override the patch writes holds nothing but appearance')
}

// ============================================================ transpose

console.log('\n-- TRANSPOSE is refused on a DATASET, with the reason and the alternative')
{
  const clip: Clip = { kind: 'table', rows: [[cell({ v: 1 }, 0, 0), cell({ v: 'x' }, 0, 1)]] }
  const plan = planPasteSpecial(clip, { what: 'all', transpose: true })
  eq(plan.refusal, 'transpose-typed-columns', 'the plan refuses, with a code')
  eq(plan.cells, [], 'and produces nothing to write')

  const items = pasteSpecialItems('table')
  const tr = items.filter((i) => i.transpose)
  ok(tr.length === 2 && tr.every((i) => !i.enabled),
    'both transposing menu items are DISABLED on a dataset')
  ok(tr.every((i) => i.why === 'transpose-typed-columns'),
    'each carrying the refusal code, so the menu can say why rather than hide the row')
  ok(items.filter((i) => !i.transpose).every((i) => i.enabled),
    'and nothing else is disabled — the refusal is about transpose, not about datasets')
}

console.log('\n-- and ALLOWED on a spreadsheet, where the type is on the cell')
{
  ok(pasteSpecialItems('canvas').every((i) => i.enabled),
    'every option is available on a spreadsheet sheet')
  const store = new Store(freshCanvas())
  // A1:C2 — two rows of three — copied, then pasted transposed at A4.
  const rows: ClipCell[][] = [
    [cell({ v: 1 }, 0, 0), cell({ v: 2 }, 0, 1), cell({ v: 3 }, 0, 2)],
    [cell({ v: 4 }, 1, 0), cell({ v: 5 }, 1, 1), cell({ v: 6 }, 1, 2)],
  ]
  const plan = planPasteSpecial({ kind: 'canvas', rows }, { what: 'all', transpose: true })
  eq([plan.rows, plan.cols], [3, 2], '2×3 becomes 3×2')
  const patches = canvasPastePatches(canvasTarget(canvas(store.doc)), 3, 0, plan)
  store.commit(patches as Patch[])
  const c = canvas(store.doc).cells
  eq([c.A4?.v, c.B4?.v, c.A5?.v, c.B5?.v, c.A6?.v, c.B6?.v], [1, 4, 2, 5, 3, 6],
    'and the cells land rotated — row 1,2,3 reads down column A')
}

console.log('\n-- transpose composes with values-only')
{
  const rows: ClipCell[][] = [[
    cell({ v: 10, f: '=Z1' }, 0, 0), cell({ v: 20, f: '=Z2' }, 0, 1),
  ]]
  const plan = planPasteSpecial({ kind: 'canvas', rows }, { what: 'values', transpose: true })
  eq(plan.cells.map((p) => [p.dr, p.dc, p.v]), [[0, 0, 10], [1, 0, 20]],
    'a row becomes a column, holding numbers')
  ok(plan.cells.every((p) => p.f === undefined), 'and no formula came with it')
}

// ============================================================ what will not land

console.log('\n-- a paste that cannot land says so instead of quietly doing less')
{
  const store = new Store(freshTable())
  const s = table(store.doc)
  // four rows in the sheet, pasting six from row 2: two fall off the end
  const rows: ClipCell[][] = Array.from({ length: 6 }, (_, i) => [cell({ v: i }, i, 1)])
  const plan = planPasteSpecial({ kind: 'table', rows }, { what: 'values' })
  const w = tablePastePatches(targetFor(s, 2, 1), plan)
  eq(w.skipped, 4, 'four of six had nowhere to go — a dataset has exactly the rows it has')
  store.commit(w.patches as Patch[])
  eq(colValue(table(store.doc), 'amount', 3), 1, 'the two that fitted did land')
}

console.log('\n-- a COMPUTED column refuses a paste, as every other writer does')
{
  const doc = freshTable()
  ;(doc.sheets[0] as TableSheet).columns[1].formula = 'Amount * 2'
  const store = new Store(doc)
  const clip: Clip = { kind: 'table', rows: [[cell({ v: 5 }, 0, 1)]] }
  const w = tablePastePatches(
    targetFor(table(store.doc), 0, 1), planPasteSpecial(clip, { what: 'values' }))
  eq(w.patches, [], 'nothing is written into a column defined by its expression')
  eq(w.skipped, 1, 'and it is counted, not silently dropped')
}

// ============================================================ the wiring

console.log('\n-- the key map, and the chord actually reaching the command')
{
  // A rig that proves a pure function while nothing calls it is the failure
  // this section exists to prevent.
  const ps = keyToAction({ key: 'V', metaKey: true, shiftKey: true })
  eq(ps, { kind: 'pasteSpecial' }, '⌘⇧V is paste special')
  eq(keyToAction({ key: 'v', metaKey: true, ctrlKey: true }), { kind: 'pasteSpecial' },
    'and so is Excel\'s own ⌘⌃V')
  eq(keyToAction({ key: 'v', metaKey: true }), { kind: 'paste' },
    'while plain ⌘V is still an ordinary paste')

  const main = readFileSync(new URL('../dash/src/main.ts', import.meta.url), 'utf8')
  ok(/kind === 'pasteSpecial'[\s\S]{0,120}openPasteSpecial\(\)/.test(main),
    'main.ts dispatches the action to the menu')
  // THE MENU MOVED to gridmenu.ts, so a rig can drive a real right-click at it
  // (scripts/test-dash-menu.ts). main.ts still owns the chord and the hook.
  const menu = readFileSync(new URL('../dash/src/gridmenu.ts', import.meta.url), 'utf8')
  ok(menu.includes('data-a="paste-special"') && menu.includes('hooks.pasteSpecial('),
    'and the cell menu offers it too, for the reader who never learns a chord')

  // THE ORDERING BUG THIS CATCHES: ⌘X clears the selection, so a clip taken
  // after `grid.handleKey` has run is a rectangle of blanks. The snapshot has
  // to be earlier in the same listener.
  const snap = main.indexOf('rememberClip(clipAct.kind === \'cut\')')
  const handle = main.indexOf('if (grid.handleKey(e)) e.preventDefault()')
  ok(snap > 0 && handle > 0 && snap < handle,
    'the clip is snapshotted BEFORE grid.handleKey — a cut would otherwise copy blanks')
  ok(/kind === 'copy' \|\| clipAct\.kind === 'cut'/.test(main),
    'and on a CUT as well as a copy')
  ok(main.includes('pickLook(') && main.includes('cellKey('),
    'the snapshot reads appearance and per-cell formula results, which is what the modes need')
}

console.log('\n-- one commit, one undo')
{
  const store = new Store(freshTable())
  const before = j({ ...store.doc, modified: undefined })
  const rows: ClipCell[][] = [
    [cell({ v: 1 }, 0, 1), cell({ v: 'p' }, 0, 2)],
    [cell({ v: 2 }, 1, 1), cell({ v: 'q' }, 1, 2)],
  ]
  const plan = planPasteSpecial({ kind: 'table', rows }, { what: 'values' })
  const w = tablePastePatches(targetFor(table(store.doc), 0, 1), plan)
  store.commit(w.patches as Patch[])
  ok(colValue(table(store.doc), 'amount', 1) === 2, 'four cells pasted')
  store.undo()
  eq(j({ ...store.doc, modified: undefined }), before,
    'and ONE undo puts every one of them back')
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'} — ${checks - failures}/${checks} checks`)
process.exit(failures ? 1 : 0)
