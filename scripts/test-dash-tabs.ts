#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash worksheet-tab rig — the sheet-list operations, with no DOM.
//
//   node scripts/test-dash-tabs.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. The strip itself is chrome and you can see whether it is
// drawn. What you CANNOT see is what its gestures write into the document, and
// every failure below leaves a workbook that looks entirely reasonable:
//
//   1. A REORDER THAT UNDOES TO THE WRONG PLACE. Sheet order is DOCUMENT data —
//      it is the tab order and every reader has to agree on it. A move is two
//      patches in one commit (remove, re-insert), and if the inverse does not
//      carry the ORIGINAL index then ⌘Z puts the sheet back at the END. The
//      workbook is intact, the tabs are in an order nobody chose, and the
//      operation that did it was the one meant to take a change back.
//   2. AN OFF-BY-ONE IN THE DROP. `dropIndex` converts "the gap I dropped into"
//      into "the index in the list without me". Wrong by one and a tab dropped
//      on its right-hand neighbour either does not move or jumps two — which
//      reads as a clumsy drag, so nobody ever reports it.
//   3. A DELETE THAT SHOWS THE WRONG SHEET. When the sheet on screen is the one
//      deleted, the grid has to land somewhere — and it can only land on a
//      TABLE, because `Grid.sheet` throws on anything else. Landing on the
//      first sheet in the file (the old behaviour) means deleting sheet 9 of 12
//      throws you back to sheet 1.
//   4. A DUPLICATE THAT SHARES STATE WITH ITS ORIGINAL. A shallow copy gives
//      two tabs pointing at ONE set of column arrays: typing in the copy edits
//      the original, and the file has one sheet's data written twice.
//   5. A KEYBOARD THAT LANDS ON A SHEET IT CANNOT OPEN. ctrl+PgDn onto a pivot
//      would throw out of `Grid.sheet`, so the walk steps over non-tables.
//
// The round-trip checks are the load-bearing ones: commit → undo has to leave
// the document BYTE-identical, which is the only statement that catches a
// position quietly dropped from an inverse.

import { registerHooks } from 'node:module'

// tabs.ts imports its stylesheet, which is Vite's job and not Node's. Stub the
// extension rather than moving the import out of the module — the same stub
// test-dash-panels.ts uses, and for the same reason.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const {
  dropIndex, moveSheetPatches, nudgeSheetPatches, duplicateSheetPatches,
  deleteSheetPlan, sheetAfterDelete, stepSheet, blankSheet, mintSheetId,
  mintSheetName, renameSheetPatch, describeKind, isTable,
} = await import('../dash/src/tabs.ts')

const { parseDoc } = await import('../dash/src/model.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc
type TableSheet = import('../dash/src/model.ts').TableSheet

const { Store } = await import('../dash/src/store.ts')
type Patch = import('../dash/src/store.ts').Patch

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// --------------------------------------------------------------- fixtures

/**
 * Four sheets, and the third is a PIVOT. Every check about stepping, deleting
 * and landing is only a real check because something in the middle of the list
 * cannot be shown in the grid.
 */
const fresh = (): DashDoc => {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1',
    docId: 'd', title: 'test',
    sheets: [
      {
        id: 'a', name: 'Alpha', kind: 'table',
        rids: [[1, 3]],
        columns: [{ id: 'x', name: 'X', type: 'number' }],
        data: { x: { enc: 'raw', v: [1, 2, 3] } },
        cells: { 'x:2': { note: 'hand-checked' } },
        comments: [{
          id: 'cm1', anchor: { kind: 'sheet' }, author: 'Ada',
          at: '2026-08-01T00:00:00Z', text: 'looks right',
        }],
        steps: [{ op: 'import', from: 'a.csv', at: '2026-08-01T00:00:00Z', rows: 3 }],
      },
      {
        id: 'b', name: 'Beta', kind: 'table',
        rids: [[1, 1]], columns: [{ id: 'y', name: 'Y', type: 'text' }],
        data: { y: { enc: 'raw', v: ['q'] } }, steps: [],
      },
      { id: 'p', name: 'Summary', kind: 'pivot', spec: { from: 'a' } },
      {
        id: 'c', name: 'Gamma', kind: 'table',
        rids: [[1, 2]], columns: [{ id: 'z', name: 'Z', type: 'text' }],
        data: { z: { enc: 'raw', v: ['m', 'n'] } }, steps: [],
      },
    ],
  }))
  if (!r.ok) throw new Error('fixture does not parse')
  return r.doc
}

/** One table sheet, nothing else — the floor case. */
const lonely = (): DashDoc => {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1',
    docId: 'd', title: 'test',
    sheets: [
      {
        id: 'a', name: 'Alpha', kind: 'table',
        rids: [[1, 1]], columns: [{ id: 'x', name: 'X', type: 'text' }],
        data: { x: { enc: 'raw', v: ['q'] } }, steps: [],
      },
      { id: 'p', name: 'Summary', kind: 'pivot', spec: { from: 'a' } },
    ],
  }))
  if (!r.ok) throw new Error('fixture does not parse')
  return r.doc
}

/** Sorted keys, `modified` dropped — see test-dash-panels.ts for why both. */
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
const order = (d: DashDoc): string => d.sheets.map((s) => s.id).join('')
const j = (v: unknown): string => JSON.stringify(v)

/** commit → undo → is the document byte-identical again? */
function roundTrip(name: string, make: (d: DashDoc) => Patch | Patch[]) {
  const st = new Store(fresh())
  const before = content(st.doc)
  const patches = make(st.doc)
  st.commit(patches)
  const changed = content(st.doc) !== before
  st.undo()
  ok(changed && content(st.doc) === before,
    `${name}: applies, and undo puts the document back byte-for-byte`)
}

// ============================================================ dropIndex

console.log('\ndrop index — the gap a tab was dropped into, minus the tab itself')
{
  // [A,B,C,D], dragging A (index 0). Gaps are 0..4.
  ok(dropIndex(0, 0) === 0, 'dropped in its own left gap: stays put')
  ok(dropIndex(0, 1) === 0, 'dropped in its own right gap: also stays put — the gap either side of a tab is the same place')
  ok(dropIndex(0, 2) === 1, 'dropped past one neighbour: one place right')
  ok(dropIndex(0, 4) === 3, 'dropped after the last tab: the end of a list it is no longer in')
  // dragging D (index 3) leftwards — the gaps below `from` do not shift
  ok(dropIndex(3, 0) === 0, 'dragging right-to-left, the target gap is unchanged')
  ok(dropIndex(3, 3) === 3, 'and its own left gap still means "stay"')
}

// ============================================================ reorder

console.log('\nreorder — order is data, so a move is a patch and undo is exact')
{
  const st = new Store(fresh())
  ok(order(st.doc) === 'abpc', 'fixture order')
  st.commit(moveSheetPatches(st.doc, 'a', 2))
  ok(order(st.doc) === 'bpac', 'moving the first sheet to index 2 lands it third')
  st.undo()
  ok(order(st.doc) === 'abpc', 'and one undo puts it back at the FRONT — not at the end')
}
{
  const st = new Store(fresh())
  st.commit(moveSheetPatches(st.doc, 'c', 0))
  ok(order(st.doc) === 'cabp', 'moving the last sheet to index 0 lands it first')
  st.undo()
  ok(order(st.doc) === 'abpc', 'undone exactly')
  st.redo()
  ok(order(st.doc) === 'cabp', 'and redone exactly')
}
{
  const d = fresh()
  ok(moveSheetPatches(d, 'a', 0).length === 0, 'a move to where it already is mints nothing — no undo entry for a gesture that changed nothing')
  ok(moveSheetPatches(d, 'nope', 1).length === 0, 'an unknown sheet mints nothing rather than throwing')
  ok(order(d) === 'abpc', 'minting a patch never touches the document')
  ok(moveSheetPatches(d, 'a', 99).length === 1, 'an out-of-range destination is CLAMPED, not refused — a drag past the end is an ordinary gesture')
  const st = new Store(fresh())
  st.commit(moveSheetPatches(st.doc, 'a', 99))
  ok(order(st.doc) === 'bpca', 'and it lands at the end')
}
{
  // ONE PATCH, and it names every sheet. A move used to be two `setSheet`
  // patches (remove, re-insert) because `setSheet` on a sheet already present
  // REPLACES it in place. That shape is what made the inverse expensive.
  const d = fresh()
  const [p] = moveSheetPatches(d, 'a', 2)
  ok(p.op === 'reorderSheets', 'a move is ONE reorderSheets, not a remove-and-re-insert pair')
  ok(p.op === 'reorderSheets' && j(p.order) === j(['b', 'p', 'a', 'c']),
    'and it carries the whole resulting order, by id')
  ok(!JSON.stringify(p).includes('"columns"'),
    'the patch carries no sheet BODY at all — which is the point of the op')
}
{
  // A REORDER THAT DOES NOT NAME EVERY SHEET IS A DELETE. `reorderColumns`
  // drops ids it cannot find, which is survivable for a column list; here it
  // would remove a sheet from the workbook inside an operation that claims
  // only to change an order, so applyPatch refuses all three malformed shapes
  // rather than doing something reasonable-looking with them.
  const bad = (order: string[]): boolean => {
    const st = new Store(fresh())
    try { st.commit({ op: 'reorderSheets', order }); return false } catch { return true }
  }
  ok(bad(['a', 'b', 'p']), 'an order that leaves a sheet out is refused — that is a delete, not a reorder')
  ok(bad(['a', 'b', 'p', 'c', 'zz']), 'an order naming a sheet that is not there is refused')
  ok(bad(['a', 'a', 'p', 'c']), 'and an order naming one sheet twice is refused — two tabs would share one sheet\'s arrays')
  const st = new Store(fresh())
  st.commit({ op: 'reorderSheets', order: ['a', 'b', 'p', 'c'] })
  ok(order(st.doc) === 'abpc', 'a reorder to the order it is already in is legal and changes nothing')
}

// ============================================ what a reorder COSTS the history
//
// THE WHOLE POINT OF THE OP. Undo here is bounded by BYTES, not by entries
// (store.ts `UNDO_BYTES`), and the accounting is `JSON.stringify` of the
// inverse. A move's inverse used to be [remove, re-insert at the original
// index] — and the re-insert carried the SHEET, so dragging a tab on a 12MB
// workbook spent 12MB of a 24MB budget and evicted every earlier undo entry.
// Two drags and the history was two drags long.
//
// So the cost is checked as a cost, not just as a behaviour: an inverse that
// scales with the sheet would still pass every correctness check above.
console.log('\na reorder costs its ID LIST, not its sheets')
{
  /** A sheet whose stringified body is unmistakably large. */
  const heavy = (id: string, name: string, rows: number): unknown => ({
    id, name, kind: 'table',
    rids: [[1, rows]],
    columns: [{ id: `${id}-v`, name: 'V', type: 'number' }],
    data: { [`${id}-v`]: { enc: 'raw', v: Array.from({ length: rows }, (_, i) => i * 1.5) } },
    steps: [],
  })
  const bulky = (): DashDoc => {
    const r = parseDoc(JSON.stringify({
      format: 'bento/dash', version: 1, policy: 'bento-dash-1',
      docId: 'd', title: 'test',
      sheets: [heavy('a', 'Alpha', 20_000), heavy('b', 'Beta', 20_000), heavy('c', 'Gamma', 20_000)],
    }))
    if (!r.ok) throw new Error('fixture does not parse')
    return r.doc
  }

  const st = new Store(bulky())
  const sheetBytes = JSON.stringify(st.doc.sheets[0]).length
  st.commit(moveSheetPatches(st.doc, 'a', 2))
  const cost = st.historyBytes
  ok(order(st.doc) === 'bca', 'the heavy fixture reorders')
  ok(sheetBytes > 100_000, `each sheet is genuinely bulky (${sheetBytes} bytes stringified)`)
  // Generous by two orders of magnitude on purpose: this is an assertion about
  // the SHAPE of the inverse, not a byte-exact measurement that would have to
  // be edited every time a comment moves.
  ok(cost < 1000,
    `and one undo entry costs ${cost} bytes — the id list, not the ${sheetBytes}-byte sheet it moved`)
  ok(cost < sheetBytes / 100,
    'which is under a hundredth of one sheet: the cost does not scale with the workbook')

  // And it is still EXACT, which is the property the cheap inverse must not
  // have bought its way out of.
  st.undo()
  ok(order(st.doc) === 'abc', 'one undo puts the dragged tab back where it was, not at the end')
  st.redo()
  ok(order(st.doc) === 'bca', 'and redo re-applies it')

  // The cost is flat in the SIZE of the workbook, which a single measurement
  // cannot show. Ten times the rows must not mean ten times the entry.
  const bigger = new Store((() => {
    const r = parseDoc(JSON.stringify({
      format: 'bento/dash', version: 1, policy: 'bento-dash-1',
      docId: 'd', title: 'test',
      sheets: [heavy('a', 'Alpha', 200_000), heavy('b', 'Beta', 20_000), heavy('c', 'Gamma', 20_000)],
    }))
    if (!r.ok) throw new Error('fixture does not parse')
    return r.doc
  })())
  bigger.commit(moveSheetPatches(bigger.doc, 'a', 2))
  ok(bigger.historyBytes === cost,
    `a ten-times-larger sheet reorders for the SAME ${cost} bytes — flat in the workbook, linear only in the number of tabs`)
}
{
  // A PIVOT REORDERS TOO. It is a sheet like any other in the list; only
  // OPENING one is beyond this build.
  const st = new Store(fresh())
  st.commit(moveSheetPatches(st.doc, 'p', 0))
  ok(order(st.doc) === 'pabc', 'a non-table sheet reorders like any other')
}
{
  const d = fresh()
  ok(j(nudgeSheetPatches(d, 'b', -1)) === j(moveSheetPatches(d, 'b', 0)), 'move-left is a move to from-1')
  ok(nudgeSheetPatches(d, 'a', -1).length === 0, 'move-left at the front does nothing')
  ok(nudgeSheetPatches(d, 'c', 1).length === 0, 'move-right at the end does nothing')
}
roundTrip('reorder right', (d) => moveSheetPatches(d, 'a', 2))
roundTrip('reorder left', (d) => moveSheetPatches(d, 'c', 0))

// ============================================================ add

console.log('\nadd — a patch, so it is undoable, and a sheet born well-formed')
{
  const st = new Store(fresh())
  const id = mintSheetId(st.doc, 7)
  ok(!st.doc.sheets.some((s) => s.id === id), 'a minted id is free')
  const sheet = blankSheet(id, mintSheetName(st.doc, 'Sheet'), '2026-08-09T00:00:00Z')
  st.commit({ op: 'setSheet', id, sheet })
  ok(order(st.doc) === 'abpc' + id, 'a new sheet appends')
  const added = st.doc.sheets.find((s) => s.id === id) as TableSheet
  const rows = added.rids.reduce((n, [, c]) => n + c, 0)
  ok(added.columns.every((col) => {
    const dcol = added.data[col.id]
    return dcol.enc === 'raw' && dcol.v.length === rows
  }), 'every column holds exactly as many values as the sheet has rows — a short column is malformed to every OTHER reader of the JSON')
  st.undo()
  ok(order(st.doc) === 'abpc', 'and it undoes away')
}
{
  const d = fresh()
  ok(mintSheetName(d, 'Alpha') === 'Alpha 2', 'a taken name gets the first free suffix')
  ok(mintSheetName(d, 'Delta') === 'Delta', 'a free name is used as-is')
}
roundTrip('add sheet', (d) => {
  const id = mintSheetId(d, 11)
  return { op: 'setSheet', id, sheet: blankSheet(id, mintSheetName(d, 'Sheet'), '2026-08-09T00:00:00Z') }
})

// ============================================================ duplicate

console.log('\nduplicate — a copy, not a second reference')
{
  const st = new Store(fresh())
  const r = duplicateSheetPatches(st.doc, 'a', { at: '2026-08-09T00:00:00Z', seed: 5 })!
  ok(r.id !== 'a', 'the copy has an id of its own')
  st.commit(r.patches)
  ok(order(st.doc) === 'a' + r.id + 'bpc', 'and lands immediately after its original, not at the end')
  const src = st.doc.sheets[0] as TableSheet
  const copy = st.doc.sheets[1] as TableSheet
  ok(copy.name !== src.name && copy.name.includes(src.name), 'the name is derived from the original and is not the original')
  ok(!st.doc.sheets.some((s, i) => st.doc.sheets.findIndex((o) => o.name === s.name) !== i),
    'no two sheets end up sharing a name')

  // THE ONE THAT MATTERS: a shallow copy shares the column arrays, so typing in
  // the duplicate would edit its original.
  const dcol = copy.data.x
  if (dcol.enc === 'raw') dcol.v[0] = 999
  const scol = src.data.x
  ok(scol.enc === 'raw' && scol.v[0] === 1, 'writing a cell in the copy does not reach the original')

  ok(copy.cells?.['x:2'] !== undefined, 'per-cell overrides come with it — a copy that silently drops hand corrections is a copy of the wrong thing')
  ok((copy as { comments?: unknown }).comments === undefined,
    'discussion threads do NOT — a copy of the data is not a second copy of a conversation, under the same ids')
  const last = copy.steps[copy.steps.length - 1] as { op: string; from?: string }
  ok(last.op === 'import' && String(last.from).includes('Alpha'),
    'and the copy records where it came from — a dash sheet always answers that')
  st.undo()
  ok(order(st.doc) === 'abpc', 'undone in one step')
}
{
  // A PIVOT DUPLICATES. `setSheet` does not care about kind, and neither should
  // the tab that offers it.
  const st = new Store(fresh())
  const r = duplicateSheetPatches(st.doc, 'p', { seed: 21 })!
  st.commit(r.patches)
  ok(order(st.doc) === 'abp' + r.id + 'c', 'a pivot copies too, and lands after itself')
  ok(!isTable(st.doc.sheets[3]), 'and stays a pivot')
}
ok(duplicateSheetPatches(fresh(), 'nope') === null, 'duplicating a sheet that is not there returns null rather than throwing')
roundTrip('duplicate', (d) => duplicateSheetPatches(d, 'a', { at: '2026-08-09T00:00:00Z', seed: 5 })!.patches)

// ============================================================ delete

console.log('\ndelete — and what is on screen afterwards')
{
  const st = new Store(fresh())
  const plan = deleteSheetPlan(st.doc, 'b', 'b')
  ok(!('refuse' in plan) && plan.show === 'c',
    'deleting the sheet you are looking at shows the next TABLE — stepping over the pivot between them')
  if (!('refuse' in plan)) st.commit(plan.patch)
  ok(order(st.doc) === 'apc', 'and the sheet is gone')
  st.undo()
  ok(order(st.doc) === 'abpc', 'undone, back in its own position')
}
{
  const d = fresh()
  ok(sheetAfterDelete(d, 'c', 'c') === 'b', 'deleting the LAST table falls back to the one on its left')
  ok(sheetAfterDelete(d, 'b', 'a') === 'a', 'deleting a sheet you are not looking at leaves the view alone')
  ok(sheetAfterDelete(d, 'p', 'a') === 'a', 'and deleting a pivot never moves the grid')
  ok(sheetAfterDelete(d, 'nope', 'a') === 'a', 'an unknown id leaves the view alone')
}
{
  const d = lonely()
  const plan = deleteSheetPlan(d, 'a', 'a')
  ok('refuse' in plan, 'the LAST table sheet is refused — the grid has to have something to point at')
  const other = deleteSheetPlan(d, 'p', 'a')
  ok(!('refuse' in other),
    'but a pivot beside it deletes freely: the floor is one TABLE, not one sheet')
  ok(!('refuse' in other) && other.show === 'a', 'and the grid stays where it was')
}
{
  const d = fresh()
  ok('refuse' in deleteSheetPlan(d, 'nope', 'a'), 'deleting a sheet that is not there is refused, not silently applied')
}
roundTrip('delete a table', (d) => (deleteSheetPlan(d, 'b', 'b') as { patch: Patch }).patch)
roundTrip('delete a pivot', (d) => (deleteSheetPlan(d, 'p', 'a') as { patch: Patch }).patch)

// ============================================================ the keyboard walk

console.log('\nctrl+PgUp / ctrl+PgDn — a walk that never lands where it cannot stand')
{
  const d = fresh()
  ok(stepSheet(d, 'a', 1) === 'b', 'forward one')
  ok(stepSheet(d, 'b', 1) === 'c', 'forward STEPS OVER the pivot — landing on one would throw out of Grid.sheet')
  ok(stepSheet(d, 'c', 1) === null, 'and stops at the end rather than wrapping')
  ok(stepSheet(d, 'c', -1) === 'b', 'back steps over it too')
  ok(stepSheet(d, 'a', -1) === null, 'and stops at the front')
  ok(stepSheet(d, 'nope', 1) === null, 'an unknown id goes nowhere')
}
{
  const d = lonely()
  ok(stepSheet(d, 'a', 1) === null && stepSheet(d, 'a', -1) === null,
    'with one table there is nowhere to walk to, in either direction')
}

// ============================================================ rename

console.log('\nrename')
{
  const d = fresh()
  const s = d.sheets[0] as TableSheet
  ok(renameSheetPatch(s, '  Renamed  ')?.props.name === 'Renamed', 'a name is trimmed')
  ok(renameSheetPatch(s, '   ') === null, 'an empty name is refused — a nameless tab is unclickable')
  ok(renameSheetPatch(s, 'Alpha') === null, 'and renaming to the same name mints nothing')
}
roundTrip('rename', (d) => renameSheetPatch(d.sheets[0] as TableSheet, 'Renamed')!)

// ============================================ rename reaches EVERY sheet kind
//
// A NAME IS THE ONE PROPERTY EVERY KIND HAS, and until this commit it was
// writable on a dataset alone. `applyPatch`'s `setSheetProps` case narrowed
// through `table(doc, id)`, so a rename of a spreadsheet or a pivot built a
// perfectly valid patch and then THREW `no table sheet` at commit. The strip
// hid the throw by refusing first — a disabled Rename item whose stated reason
// ("the rename box is drawn on the tab") was not the real one and was not even
// true, since a pivot has a tab.
//
// This is checked through the STORE rather than against `renameSheetPatch`,
// because the patch factory was never the broken half: it is kind-agnostic
// already and always was. Asserting on it would have passed throughout the
// whole life of the bug, which is why nothing caught this.
console.log('\na name belongs to a SHEET, not to a dataset')
{
  const withKinds = (): DashDoc => {
    const d = fresh()
    const r = parseDoc(JSON.stringify({
      ...d,
      sheets: [...d.sheets, { id: 'ss', name: 'Scratch', kind: 'canvas', cells: { A1: { v: 1 } } }],
    }))
    if (!r.ok) throw new Error('fixture does not parse')
    return r.doc
  }
  const nameOf = (d: DashDoc, id: string): string | undefined =>
    d.sheets.find((s) => s.id === id)?.name

  for (const [id, kind] of [['ss', 'spreadsheet'], ['p', 'pivot'], ['a', 'dataset']] as const) {
    const st = new Store(withKinds())
    const sheet = st.doc.sheets.find((s) => s.id === id)!
    const p = renameSheetPatch(sheet, 'Renamed')!
    let threw: unknown = null
    try { st.commit(p) } catch (e) { threw = e }
    ok(threw === null && nameOf(st.doc, id) === 'Renamed',
      `a ${kind} sheet renames${threw ? ` — threw ${(threw as Error).message}` : ''}`)
    st.undo()
    ok(nameOf(st.doc, id) === (kind === 'spreadsheet' ? 'Scratch' : kind === 'pivot' ? 'Summary' : 'Alpha'),
      `and one undo puts the ${kind}'s old name back`)
  }

  // The widening is of the KIND, not of what may be written. Every structural
  // key is still refused, and `cells` is the one that matters here: it is the
  // spreadsheet's whole content, it was only ever unreachable because the op
  // could not name a spreadsheet at all, and a props write of it would put a
  // document-sized inverse into a byte-capped history.
  const st = new Store(withKinds())
  const refuses = (p: Patch): boolean => {
    try { st.commit(p); return false } catch { return true }
  }
  ok(refuses({ op: 'setSheetProps', sheet: 'ss', props: { cells: {} } }),
    'a spreadsheet\'s `cells` is still refused — the kind widened, the key list did not')
  ok(refuses({ op: 'setSheetProps', sheet: 'ss', props: { cols: { A: 200 } } }),
    'and so are its column widths, which have a typed patch of their own (setCanvasSizes)')
  ok(refuses({ op: 'setSheetProps', sheet: 'ss', props: { rows: { 1: 40 } } }),
    'and its row heights, for the same reason')
  ok(refuses({ op: 'setSheetProps', sheet: 'ss', props: { kind: 'table' } }),
    'and a sheet cannot change kind through a props write')
  ok(refuses({ op: 'setSheetProps', sheet: 'nope', props: { name: 'X' } }),
    'a sheet that is not in the workbook is still refused LOUDLY — a silent no-op is an edit the user believes landed')
}

// ============================================================ what a tab says

console.log('\nnon-table sheets are named as what they are')
{
  ok(describeKind('pivot').chip === 'Pivot' && describeKind('pivot').why.includes('pivot'),
    'a pivot says pivot')
  // "Canvas" is the WIRE word and stays in the format (PLATFORM §3); what a
  // reader sees is "Spreadsheet". The chip used to say Canvas and the tooltip
  // said "not editable in this build", which was true until the kind was
  // implemented and is the sort of label that outlives its own truth.
  ok(describeKind('canvas').chip === 'Spreadsheet',
    'a canvas sheet calls itself a Spreadsheet — the wire word is not the reader\'s word')
  ok(!/not editable/.test(describeKind('canvas').why),
    'and it no longer claims to be unopenable, because it opens')
  // The failure this replaced: everything non-table was labelled a canvas
  // sheet, so a pivot the app itself created described itself as something
  // else. A future kind must carry its own name through.
  ok(describeKind('timeline').chip === 'timeline' && describeKind('timeline').why.includes('timeline'),
    'a kind this build has never heard of is reported by NAME, not guessed at')
}

// ============================================================

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
