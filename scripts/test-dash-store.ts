#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash store + undo rig.
//
//   node scripts/test-dash-store.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Undo here is a list of TYPED INVERSES rather than whole
// document snapshots, because snapshots were measured at 10 ms per checkpoint
// on a 12.2 MB workbook and 1.19 GB of live strings for a full stack. That
// mechanism buys two things and risks two:
//
//   BUYS   history that costs what the EDIT costs, not what the DOCUMENT costs;
//          and an invalidation that names the cells it touched, so undo can
//          repaint precisely instead of rebuilding the grid.
//   RISKS  an inverse that does not actually restore what it displaced — the
//          failure mode a snapshot cannot have, and the reason for this file.
//          Undoing a delete that brings the rows back EMPTY is worse than the
//          delete, and it is silent.
//
// So every operation is checked round-trip: apply, undo, and assert the
// document is byte-identical to where it started.

import { parseDoc, type DashDoc } from '../dash/src/model.ts'
import { Store, applyPatch, readCell, type Patch, _internals } from '../dash/src/store.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const fresh = (): DashDoc => {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1',
    docId: 'd', title: 'test',
    sheets: [{
      id: 'sh1', name: 'S', kind: 'table',
      rids: [[1, 4]],
      columns: [
        { id: 'region', name: 'Region', type: 'text' },
        { id: 'amount', name: 'Amount', type: 'number' },
      ],
      data: {
        region: { enc: 'dict', dict: ['North', 'South'], idx: [0, 1, 0, 1] },
        amount: { enc: 'raw', v: [10, 20, 30, 40] },
      },
      steps: [{ op: 'import', from: 'q3.csv', at: '2026-08-03T00:00:00Z', rows: 4 }],
    }],
  }))
  if (!r.ok) throw new Error('fixture does not parse')
  return r.doc
}

/**
 * The document minus `modified`. Undo IS an edit — the file has changed since
 * it was last saved — so the timestamp legitimately moves and comparing it
 * would assert the wrong thing.
 */
const content = (d: DashDoc): string => {
  const { modified: _m, ...rest } = d
  return JSON.stringify(rest)
}

/** apply → undo → is the document exactly where it started? */
function roundTrip(name: string, patches: Patch | Patch[]) {
  const s = new Store(fresh())
  const before = content(s.doc)
  s.commit(patches)
  const changed = content(s.doc) !== before
  const undone = s.undo()
  ok(changed, `${name}: the patch actually changed something`)
  ok(undone && content(s.doc) === before, `${name}: undo restores the document exactly`)
  const afterUndo = content(s.doc)
  s.redo()
  ok(content(s.doc) !== afterUndo, `${name}: redo re-applies it`)
}

// ------------------------------------------------------------ round trips
roundTrip('setCells (raw)', { op: 'setCells', sheet: 'sh1', col: 'amount', rids: [2, 3], v: [99, 98] })
roundTrip('setCells (dict)', { op: 'setCells', sheet: 'sh1', col: 'region', rids: [1], v: ['East'] })
roundTrip('setOverrides', {
  op: 'setOverrides', sheet: 'sh1', keys: ['amount:2'],
  v: [{ note: 'checked', by: 'andy' }],
})
roundTrip('insertRows', { op: 'insertRows', sheet: 'sh1', rids: [5, 6] })
roundTrip('deleteRows', { op: 'deleteRows', sheet: 'sh1', rids: [2] })
roundTrip('setColumn', { op: 'setColumn', sheet: 'sh1', col: 'amount', patch: { format: '$#,##0', unit: 'USD' } })
roundTrip('reorderColumns', { op: 'reorderColumns', sheet: 'sh1', order: ['amount', 'region'] })
roundTrip('setMeasure', {
  op: 'setMeasure', name: 'Revenue',
  measure: { name: 'Revenue', expr: 'SUM(amount)', grain: 'sh1', additive: true },
})
roundTrip('setTitle', { op: 'setTitle', title: 'renamed' })
roundTrip('a multi-patch commit', [
  { op: 'setCells', sheet: 'sh1', col: 'amount', rids: [1], v: [1] },
  { op: 'setColumn', sheet: 'sh1', col: 'amount', patch: { unit: 'EUR' } },
])

// THE ONE A SNAPSHOT CANNOT GET WRONG, and a patch log can: deleting rows and
// undoing must bring the VALUES back, not empty rows.
{
  const s = new Store(fresh())
  const sheet = s.doc.sheets[0] as any
  const beforeVals = [0, 1, 2, 3].map((r) => readCell(sheet.data.amount, r))
  s.commit({ op: 'deleteRows', sheet: 'sh1', rids: [2, 3] })
  ok(JSON.stringify([0, 1].map((r) => readCell(sheet.data.amount, r))) === JSON.stringify([10, 40]),
    'deleteRows removes the right rows')
  s.undo()
  const afterVals = [0, 1, 2, 3].map((r) => readCell((s.doc.sheets[0] as any).data.amount, r))
  ok(JSON.stringify(afterVals) === JSON.stringify(beforeVals),
    'undoing a delete restores the VALUES, not empty rows')
}

// ------------------------------------------------------------- typing run
{
  const s = new Store(fresh())
  const before = content(s.doc)
  for (let i = 0; i < 40; i++) {
    s.runEdit('amount:1', { op: 'setCells', sheet: 'sh1', col: 'amount', rids: [1], v: [i] })
  }
  s.endRun()
  ok(readCell((s.doc.sheets[0] as any).data.amount, 0) === 39, 'the run left the last value')
  s.undo()
  ok(content(s.doc) === before,
    'forty edits in one cell are ONE undo step, back to the value the run started from')
}
{
  const s = new Store(fresh())
  s.runEdit('amount:1', { op: 'setCells', sheet: 'sh1', col: 'amount', rids: [1], v: [7] })
  s.runEdit('amount:2', { op: 'setCells', sheet: 'sh1', col: 'amount', rids: [2], v: [8] })
  s.endRun()
  s.undo()
  ok(readCell((s.doc.sheets[0] as any).data.amount, 1) === 20 &&
     readCell((s.doc.sheets[0] as any).data.amount, 0) === 7,
    'moving to another cell closes the run — the two edits are separate steps')
}
{
  const s = new Store(fresh())
  s.runEdit('amount:1', { op: 'setCells', sheet: 'sh1', col: 'amount', rids: [1], v: [7] })
  s.commit({ op: 'setColumn', sheet: 'sh1', col: 'amount', patch: { unit: 'GBP' } })
  s.undo()
  ok((s.doc.sheets[0] as any).columns.find((c: any) => c.id === 'amount').unit === undefined &&
     readCell((s.doc.sheets[0] as any).data.amount, 0) === 7,
    'a structural commit closes the run first — text and structure never merge')
}

// ------------------------------------------ history costs the EDIT, not the doc
{
  const s = new Store(fresh())
  // grow the document without touching history
  const sheet = s.doc.sheets[0] as any
  sheet.data.amount.v = Array.from({ length: 50_000 }, (_, i) => i)
  sheet.rids = [[1, 50_000]]
  const docSize = JSON.stringify(s.doc).length
  s.commit({ op: 'setCells', sheet: 'sh1', col: 'amount', rids: [1], v: [0] })
  ok(docSize > 100_000, `the fixture document is genuinely large (${docSize} bytes)`)
  ok(s.historyBytes < 200,
    `one cell edit costs ${s.historyBytes} bytes of history, not a copy of the document`)
  // this is the assertion a snapshot implementation fails
  ok(s.historyBytes * 100 < docSize,
    'history for one edit is <1% of the document — the property snapshots cannot have')
}

// --------------------------------------------------------------- byte cap
{
  const s = new Store(fresh())
  const wide = Array.from({ length: 20_000 }, (_, i) => `value-${i}`)
  const rids = Array.from({ length: 20_000 }, (_, i) => i + 1)
  ;(s.doc.sheets[0] as any).rids = [[1, 20_000]]
  ;(s.doc.sheets[0] as any).data.region = { enc: 'raw', v: wide.slice() }
  for (let i = 0; i < 200; i++) {
    s.commit({ op: 'setCells', sheet: 'sh1', col: 'region', rids, v: wide })
  }
  ok(s.historyBytes <= _internals.UNDO_BYTES,
    `history stays inside the ${(_internals.UNDO_BYTES / 1024 / 1024) | 0} MB cap (${(s.historyBytes / 1024 / 1024).toFixed(1)} MB)`)
  ok(s.canUndo, 'and the most recent entries survive the trim')
}

// ------------------------------------------------------- precise invalidation
{
  const s = new Store(fresh())
  s.commit({ op: 'setCells', sheet: 'sh1', col: 'amount', rids: [2], v: [5] })
  ok(s.lastTouched.sheet === 'sh1' && s.lastTouched.cols?.[0] === 'amount'
     && s.lastTouched.rids?.[0] === 2 && !s.lastTouched.all,
    'a commit reports WHICH cells it touched')
  s.undo()
  ok(s.lastTouched.cols?.[0] === 'amount' && !s.lastTouched.all,
    'and so does undo — otherwise the patch log is thrown away at undo time')
  s.replaceDoc(fresh())
  ok(s.lastTouched.all === true, 'only replaceDoc invalidates everything')
}

// ------------------------------------------------------------- view state
{
  const s = new Store(fresh())
  const before = content(s.doc)
  let viewEvents = 0
  s.on('view', () => { viewEvents++ })
  s.view(() => { s.order.sh1 = [3, 2, 1, 0] })
  ok(content(s.doc) === before, 'view() does NOT touch the document — a sort never dirties the file')
  ok(!s.canUndo, 'view() takes no checkpoint')
  ok(viewEvents === 1, 'view() emits an invalidation so the grid repaints')
}

// ----------------------------------------------------------------- refusals
{
  const s = new Store(fresh())
  let threw = ''
  try { s.commit({ op: 'applySteps', sheet: 'sh1', steps: [] }) } catch (e) { threw = String(e) }
  ok(threw.includes('not implemented'),
    'a reserved op REFUSES loudly rather than silently doing nothing')
  s.readOnly = true
  const before = content(s.doc)
  s.commit({ op: 'setTitle', title: 'nope' })
  ok(content(s.doc) === before, 'a read-only store accepts no commits')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
