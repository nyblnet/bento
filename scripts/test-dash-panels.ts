#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash side-panel patch-factory rig.
//
//   node scripts/test-dash-panels.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. The panel is chrome, so almost none of it is testable and
// almost none of it needs to be — a chevron that points the wrong way is a
// thing you can see. What is NOT visible is what the controls WRITE, and every
// failure below leaves a workbook that looks exactly right on screen:
//
//   1. A SETTING THAT WILL NOT SWITCH OFF. `sheet.totals` and `sheet.frozen`
//      are additive fields where ABSENT means "no". Clearing the last one by
//      storing `{}` leaves the file changed after a round trip: every reader
//      diffs it, and collab ships an op for a document that is back where it
//      started. The same clear spelled `props: {totals: undefined}` is worse —
//      applySheetProps refuses it outright, because JSON.stringify drops the
//      key and the delete would reach every other replica as a no-op.
//   2. A FREEZE THAT COUNTS THE WRONG COLUMNS. "Freeze to here" counts VISIBLE
//      position — what the reader pointed at. Counting stored position freezes
//      one column too many the moment anything to the left is hidden, and the
//      pane looks plausible either way. Frozen ROWS must survive the write, or
//      one setting silently resets another.
//   3. A SHEET NOBODY CAN OPEN. Two sheets sharing an id makes `sheets.find`
//      answer with the first one forever: the second sheet's data is in the
//      file and nothing in the app can reach it.
//   4. A NEW SHEET THAT IS MALFORMED TO EVERYONE ELSE. A column whose stored
//      values are shorter than the sheet has rows READS correctly inside this
//      build (`readCell` answers `?? null` past the end) and is ragged to every
//      other reader of that JSON — an agent, a chart binding, a re-encode to
//      `pack`, whose `n` is authoritative. rowcol.ts pads for this reason; a
//      sheet minted whole has to be born right.
//
// So the checks assert the WRONG answer is refused, not merely that a right one
// is reachable. The round-trip check is the load-bearing one: mint → commit →
// undo has to leave the document BYTE-identical, which is the only statement
// that catches an orphaned `{}` or a key left holding undefined.

import { registerHooks } from 'node:module'

// panels.ts imports its stylesheet, which is Vite's job and not Node's. Stub
// the extension rather than moving the import out of the module: `import
// './panels.css'` is how every other Bento app co-locates a panel with its
// styles, and a rig is not a reason to break the pattern.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const {
  totalsPatch, freezeThroughPatch, renameSheetPatch, mintSheetId, mintSheetName, blankSheet,
} = await import('../dash/src/panels.ts')

const { parseDoc } = await import('../dash/src/model.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc
type TableSheet = import('../dash/src/model.ts').TableSheet

const { Store } = await import('../dash/src/store.ts')
type Patch = import('../dash/src/store.ts').Patch

const { readFrozen, hiddenSet } = await import('../dash/src/rowcol.ts')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// --------------------------------------------------------------- fixtures

const fresh = (): DashDoc => {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1',
    docId: 'd', title: 'test',
    sheets: [{
      id: 'sh1', name: 'S', kind: 'table',
      rids: [[1, 4]],
      columns: [
        // `region` is HIDDEN: every visible-position check below is only a real
        // check because something to the left of the target is not on screen.
        { id: 'region', name: 'Region', type: 'text', hidden: true },
        { id: 'amount', name: 'Amount', type: 'number' },
        { id: 'note', name: 'Note', type: 'text' },
      ],
      data: {
        region: { enc: 'dict', dict: ['North', 'South'], idx: [0, 1, 0, 1] },
        amount: { enc: 'raw', v: [10, 20, 30, 40] },
        note: { enc: 'raw', v: ['a', 'b', 'c', 'd'] },
      },
      totals: { amount: 'sum' },
      frozen: { rows: 2, cols: 0 },
      steps: [{ op: 'import', from: 'q3.csv', at: '2026-08-03T00:00:00Z', rows: 4 }],
    }, {
      id: 'sh2', name: 'Sheet', kind: 'table',
      rids: [[1, 1]], columns: [{ id: 'x', name: 'X', type: 'text' }],
      data: { x: { enc: 'raw', v: ['q'] } }, steps: [],
    }],
  }))
  if (!r.ok) throw new Error('fixture does not parse')
  return r.doc
}

const sheetOf = (d: DashDoc, i = 0): TableSheet => d.sheets[i] as TableSheet

/** Sorted keys, `modified` dropped — see test-dash-rowcol.ts for why both. */
const canon = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canon)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o).sort()) out[k] = canon(o[k])
    return out
  }
  return v
}
const content = (d: DashDoc): string => {
  const { modified: _m, ...rest } = d
  return JSON.stringify(canon(rest))
}
const j = (v: unknown): string => JSON.stringify(v)

/** mint → commit → undo → is the document byte-identical again? */
function roundTrip(name: string, make: (s: TableSheet) => Patch) {
  const st = new Store(fresh())
  const before = content(st.doc)
  st.commit(make(sheetOf(st.doc)))
  const changed = content(st.doc) !== before
  st.undo()
  ok(changed && content(st.doc) === before,
    `${name}: applies, and undo puts the document back byte-for-byte`)
}

// ============================================================ totals

console.log('\ntotals — an additive field where absent means "no"')
{
  const s = sheetOf(fresh())
  const p = totalsPatch(s, 'note', 'count')
  ok(j((p.props as { totals: unknown }).totals) === j({ amount: 'sum', note: 'count' }),
    'adding an aggregate keeps the ones already there')
  ok(p.drop === undefined, 'adding never drops')
  ok(j(s.totals) === j({ amount: 'sum' }), 'minting the patch did not touch the sheet')
}
{
  const s = sheetOf(fresh())
  const p = totalsPatch(s, 'amount', null)
  ok(j(p.drop) === j(['totals']) && j(p.props) === j({}),
    'clearing the LAST aggregate drops `totals` rather than storing {} — an absent field is what "no totals" looks like')
  ok(!('totals' in (p.props as Record<string, unknown>)),
    'and it is spelled `drop`, never `props: {totals: undefined}` — that spelling evaporates in JSON and applySheetProps refuses it')
}
{
  const st = new Store(fresh())
  st.commit(totalsPatch(sheetOf(st.doc), 'note', 'max'))
  const p = totalsPatch(sheetOf(st.doc), 'note', null)
  ok(j((p.props as { totals: unknown }).totals) === j({ amount: 'sum' }) && p.drop === undefined,
    'clearing one of two keeps the other and leaves the field in place')
}
roundTrip('totals set', (s) => totalsPatch(s, 'note', 'avg'))
roundTrip('totals cleared to empty', (s) => totalsPatch(s, 'amount', null))

// ============================================================ freeze

console.log('\nfreeze to here — visible position, and the other axis survives')
{
  const s = sheetOf(fresh())
  ok(hiddenSet(s).has('region'), 'fixture really does hide a column to the left')
  const p = freezeThroughPatch(s, 'amount')
  const f = (p.props as { frozen?: { rows: number; cols: number } }).frozen
  ok(f?.cols === 1,
    'freezing through the FIRST VISIBLE column freezes one column — not two, which is what counting stored position would give')
  ok(f?.rows === 2, 'and the frozen ROWS are carried through, not reset to zero')
}
{
  const st = new Store(fresh())
  st.commit(freezeThroughPatch(sheetOf(st.doc), 'note'))
  ok(readFrozen(sheetOf(st.doc)).cols === 2, 'through the second visible column freezes two')
  const off = freezeThroughPatch(sheetOf(st.doc), 'note')
  st.commit(off)
  const f = readFrozen(sheetOf(st.doc))
  ok(f.cols === 0 && f.rows === 2,
    'asking again at the same column unfreezes the columns and leaves the rows alone')
}
{
  // Every column hidden but one, and that one is the LAST stored column: the
  // arithmetic that reads `columns.indexOf` would freeze three.
  const d = fresh()
  const s = sheetOf(d)
  s.columns[1].hidden = true
  const p = freezeThroughPatch(s, 'note')
  ok((p.props as { frozen?: { cols: number } }).frozen?.cols === 1,
    'with two of three columns hidden, the only visible one freezes exactly one')
}
roundTrip('freeze to here', (s) => freezeThroughPatch(s, 'amount'))

// ============================================================ sheets

console.log('\nsheet identity and naming')
{
  const d = fresh()
  ok(mintSheetId(d, 0) === 'sheet-0', 'a seed with no collision is used as-is (deterministic under test)')
  d.sheets.push({ ...sheetOf(d), id: 'sheet-0' })
  ok(mintSheetId(d, 0) === 'sheet-1',
    'a taken id walks on — two sheets sharing one id makes the second unreachable forever')
  ok(!d.sheets.some((s) => s.id === mintSheetId(d)),
    'and the unseeded mint is unused too')
}
{
  const d = fresh()
  ok(mintSheetName(d, 'Sheet') === 'Sheet 2', 'a taken name gets the first free suffix')
  ok(mintSheetName(d, 'Pipeline') === 'Pipeline', 'a free name is left alone')
}
{
  const s = sheetOf(fresh())
  ok(renameSheetPatch(s, '  ') === null, 'a blank rename is refused — a nameless sheet is unclickable')
  ok(renameSheetPatch(s, 'S') === null, 'renaming to the same name mints nothing rather than an empty undo step')
  ok(renameSheetPatch(s, ' Q3 ')?.props.name === 'Q3', 'and a real one is trimmed')
}
roundTrip('rename', (s) => renameSheetPatch(s, 'Renamed')!)

// ============================================================ new sheet

console.log('\na new sheet is born well-formed')
{
  const s = blankSheet('sheet-new', 'Sheet 2', '2026-08-05T00:00:00Z')
  const rows = s.rids.reduce((n, [, c]) => n + c, 0)
  const lengths = s.columns.map((c) => {
    const dcol = s.data[c.id]
    return dcol.enc === 'raw' ? dcol.v.length : dcol.enc === 'dict' ? dcol.idx.length : dcol.n
  })
  ok(lengths.every((n) => n === rows),
    'every column carries exactly as many values as the sheet has rows — short reads fine here and is ragged to every other reader of the JSON')
  ok(new Set(s.columns.map((c) => c.id)).size === s.columns.length,
    'column ids are unique — a duplicate makes two columns share one set of values and overrides')
  ok(s.columns.every((c) => c.id.startsWith('sheet-new')),
    'and they are namespaced by the sheet, so an id cannot collide across a copy-paste')
  ok(s.steps.length === 1 && s.steps[0].op === 'import',
    'steps[0] is the provenance record even for a hand-made sheet — a dash file always answers where its rows came from')
  ok(s.kind === 'table' && rows > 0, 'it opens with rows to type into')
}
{
  // the round trip that matters for a new sheet: it has to survive parse
  const d = fresh()
  d.sheets.push(blankSheet(mintSheetId(d, 7), mintSheetName(d, 'Sheet'), '2026-08-05T00:00:00Z'))
  const r = parseDoc(JSON.stringify(d))
  ok(r.ok && r.repairs.length === 0,
    'a workbook with a freshly minted sheet parses with NO id repairs — the mint is the thing that keeps repair off')
}

// ============================================================ purity

console.log('\nthe factories are factories')
{
  const d = fresh()
  const s = sheetOf(d)
  const before = content(d)
  totalsPatch(s, 'note', 'sum')
  totalsPatch(s, 'amount', null)
  freezeThroughPatch(s, 'note')
  renameSheetPatch(s, 'Other')
  mintSheetId(d, 3)
  mintSheetName(d, 'Sheet')
  ok(content(d) === before,
    'minting six patches from one document mutates nothing — the same rule rowcol.ts holds itself to, and the reason a patch has an inverse at all')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
