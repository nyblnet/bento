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

/**
 * The rid watermark is the ONE field undo may not restore.
 *
 * A rid that has existed must never be minted again — overrides, comments and
 * a peer's CRDT node all assume a rid names one row forever. So insert and
 * delete leave `nextRid` raised, deliberately, and comparing it would assert
 * the opposite of what the format requires. Everything else in the sheet is
 * still compared byte for byte.
 */
const withoutWatermark = (d: DashDoc): string => {
  const { modified: _m, ...rest } = d
  return JSON.stringify(rest, (k, v) => (k === 'nextRid' ? undefined : v))
}

/** apply → undo → is the document exactly where it started? */
function roundTrip(name: string, patches: Patch | Patch[]) {
  const s = new Store(fresh())
  const before = content(s.doc)
  const beforeW = withoutWatermark(s.doc)
  s.commit(patches)
  const changed = content(s.doc) !== before
  const undone = s.undo()
  ok(changed, `${name}: the patch actually changed something`)
  ok(undone && withoutWatermark(s.doc) === beforeW,
    `${name}: undo restores the document exactly (bar the monotonic rid watermark)`)
  const afterUndo = content(s.doc)
  s.redo()
  ok(content(s.doc) !== afterUndo, `${name}: redo re-applies it`)
}

// an override delete has to survive a JSON round trip: the patch is also the
// collab wire format, and an array cannot carry `undefined`
{
  const s = new Store(fresh())
  s.commit({ op: 'setOverrides', sheet: 'sh1', keys: ['amount:2'], v: [{ note: 'x' }] })
  ok(!!(s.doc.sheets[0] as any).cells['amount:2'], 'an override is set')
  const del = { op: 'setOverrides', sheet: 'sh1', keys: ['amount:2'], v: [undefined] } as Patch
  const overWire = JSON.parse(JSON.stringify(del)) as Patch
  ok(JSON.stringify(overWire).includes('null'),
    'a delete sent over the wire arrives as null, because JSON has no undefined in an array')
  s.commit(overWire)
  ok(!('amount:2' in ((s.doc.sheets[0] as any).cells ?? {})),
    'and it still DELETES rather than writing a null override the other replica would not have')
}

// THE WATERMARK ITSELF: a rid must never be minted twice, and undo must not
// hand one back. This is the precondition collaboration needs — two replicas
// minting the same rid for two different rows merge them into one row.
{
  const s = new Store(fresh())
  const sheet = () => s.doc.sheets[0] as any
  s.commit({ op: 'deleteRows', sheet: 'sh1', rids: [4] })
  ok(sheet().nextRid === 5, 'deleting the last row RAISES the watermark past it')
  s.commit({ op: 'insertRows', sheet: 'sh1', rids: [5] })
  ok(!sheet().rids.some(([st, c]: [number, number]) => 4 >= st && 4 < st + c),
    'so the next insert does not mint the deleted rid again')
  s.undo(); s.undo()
  ok(sheet().nextRid >= 5,
    'and undo does NOT hand the rid back — a peer may already have attached to it')
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
roundTrip('setSheetProps', {
  op: 'setSheetProps', sheet: 'sh1',
  props: { condfmt: { amount: [{ kind: 'dataBar', color: '#F7A600' }] } },
})
{
  // a property whose new value is `undefined` is REMOVED, not set to undefined
  const s = new Store(fresh())
  s.commit({ op: 'setSheetProps', sheet: 'sh1', props: { condfmt: { a: 1 } } })
  ok('condfmt' in (s.doc.sheets[0] as any), 'a sheet property is set')
  s.commit({ op: 'setSheetProps', sheet: 'sh1', props: {}, drop: ['condfmt'] })
  ok(!('condfmt' in (s.doc.sheets[0] as any)),
    'and a listed `drop` REMOVES the key rather than leaving a dead one')
  let refused = ''
  try { s.commit({ op: 'setSheetProps', sheet: 'sh1', props: { condfmt: undefined } }) }
  catch (e) { refused = String(e) }
  ok(refused.includes('drop'),
    'while props:{k:undefined} is REFUSED — it evaporates in JSON.stringify, so the delete would never reach another replica')
  s.undo()
  ok('condfmt' in (s.doc.sheets[0] as any), 'undo brings it back')
}
// SHEETS ARE PATCHES NOW, so adding or deleting one is undoable. Both used to
// go through `replaceDoc`, which CLEARS the undo stack — so creating a pivot or
// importing a CSV silently threw away every edit you could previously take back.
{
  const s = new Store(fresh())
  const blank = { id: 'sh2', name: 'Second', kind: 'table', rids: [], columns: [], data: {}, steps: [] }
  s.commit({ op: 'setCells', sheet: 'sh1', col: 'amount', rids: [1], v: [111] })
  s.commit({ op: 'setSheet', id: 'sh2', sheet: blank as never })
  ok(s.doc.sheets.length === 2, 'a sheet can be added by patch')
  s.undo()
  ok(s.doc.sheets.length === 1, 'and removed again by undo')
  ok(s.canUndo, 'AND the edit before it is still on the stack — replaceDoc would have cleared it')
  s.undo()
  ok(readCell((s.doc.sheets[0] as any).data.amount, 0) === 10,
    'so the earlier edit is still reachable')

  // position, because sheet order is the tab order
  const t = new Store(fresh())
  const mk = (id: string) => ({ id, name: id, kind: 'table', rids: [], columns: [], data: {}, steps: [] })
  t.commit({ op: 'setSheet', id: 'a', sheet: mk('a') as never })
  t.commit({ op: 'setSheet', id: 'b', sheet: mk('b') as never })
  t.commit({ op: 'setSheet', id: 'a', sheet: undefined })
  ok(JSON.stringify(t.doc.sheets.map((x) => x.id)) === JSON.stringify(['sh1', 'b']), 'deleting removes it')
  t.undo()
  ok(JSON.stringify(t.doc.sheets.map((x) => x.id)) === JSON.stringify(['sh1', 'a', 'b']),
    'and undo puts it back WHERE IT WAS, not at the end — sheet order is the tab order')
}

roundTrip('setView', {
  op: 'setView', id: 'v1',
  view: { id: 'v1', name: 'Overview', w: 12, h: 8, tiles: [] },
})
{
  // views is an ARRAY — order is the tab order, so a replacement must keep its
  // place rather than moving to the end
  const s = new Store(fresh())
  const mk = (id: string, name: string) => ({ id, name, w: 12, h: 8, tiles: [] })
  s.commit({ op: 'setView', id: 'a', view: mk('a', 'A') })
  s.commit({ op: 'setView', id: 'b', view: mk('b', 'B') })
  s.commit({ op: 'setView', id: 'a', view: mk('a', 'A2') })
  ok(JSON.stringify(s.doc.views?.map((v) => v.id)) === JSON.stringify(['a', 'b']),
    'replacing a view keeps its position, rather than moving it to the end')
  ok(s.doc.views?.[0].name === 'A2', 'and it is the new one')
  s.commit({ op: 'setView', id: 'a', view: undefined })
  ok(JSON.stringify(s.doc.views?.map((v) => v.id)) === JSON.stringify(['b']), 'undefined removes it')
  s.undo()
  ok(s.doc.views?.[0].id === 'a', 'and undo puts it back where it was')
}

roundTrip('setDocProps', { op: 'setDocProps', props: { story: { steps: [] } } })
{
  // the document-level twin of setSheetProps, with the same wire discipline
  const s = new Store(fresh())
  s.commit({ op: 'setDocProps', props: { story: { steps: [{ id: 'a' }] } } })
  ok('story' in (s.doc as any), 'a document field is set')
  s.commit({ op: 'setDocProps', props: {}, drop: ['story'] })
  ok(!('story' in (s.doc as any)), 'and a listed `drop` removes it')
  s.undo()
  ok('story' in (s.doc as any), 'undo brings it back')

  let refused = ''
  try { s.commit({ op: 'setDocProps', props: { story: undefined } }) } catch (e) { refused = String(e) }
  ok(refused.includes('drop'),
    'props:{k:undefined} is REFUSED — JSON.stringify erases it, so the delete would reach no other replica')

  for (const k of ['sheets', 'docId', 'format']) {
    let threw = ''
    try { s.commit({ op: 'setDocProps', props: { [k]: 1 } }) } catch (e) { threw = String(e) }
    ok(threw.includes(k),
      `setDocProps refuses "${k}" — structure and identity move through typed patches, not an unbounded props write`)
  }
}

roundTrip('addColumn', {
  op: 'addColumn', sheet: 'sh1',
  column: { id: 'computed', name: 'Computed', type: 'number', formula: 'amount * 2' },
})
roundTrip('removeColumn', { op: 'removeColumn', sheet: 'sh1', col: 'amount' })
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

// A single EDIT may be several patches — the grid writes a value and clears the
// formula it replaced — and they have to undo as ONE step, in reverse.
{
  const s = new Store(fresh())
  const before = content(s.doc)
  s.commit({ op: 'setOverrides', sheet: 'sh1', keys: ['amount:1'], v: [{ f: '=A1*2' }] })
  const withFormula = content(s.doc)
  s.runEdit('amount:1', [
    { op: 'setCells', sheet: 'sh1', col: 'amount', rids: [1], v: [42] },
    { op: 'setOverrides', sheet: 'sh1', keys: ['amount:1'], v: [null], dropEmpty: true },
  ])
  s.endRun()
  ok(readCell((s.doc.sheets[0] as any).data.amount, 0) === 42 &&
     !((s.doc.sheets[0] as any).cells?.['amount:1']),
    'typing over a formula writes the value AND removes the formula')
  s.undo()
  ok(content(s.doc) === withFormula,
    'and ONE undo restores both — the value and the formula, which only works if the inverses replay in reverse')
  s.undo()
  ok(content(s.doc) === before, 'the step before that is still there')
}
{
  // AND THE ORDER HAS TO BE REVERSED, which the check above cannot show: those
  // two patches write different structures, so their inverses commute and a
  // forward replay passes by luck. These two write the SAME key, so replaying
  // the inverses forward re-creates what the first one deleted.
  const s = new Store(fresh())
  const before = content(s.doc)
  s.runEdit('amount:1', [
    { op: 'setOverrides', sheet: 'sh1', keys: ['amount:1'], v: [{ note: 'a' }] },
    { op: 'setOverrides', sheet: 'sh1', keys: ['amount:1'], v: [{ note: 'b' }] },
  ])
  s.endRun()
  ok((s.doc.sheets[0] as any).cells['amount:1'].note === 'b', 'the last write wins going forward')
  s.undo()
  ok(content(s.doc) === before,
    'and undo leaves NO override — replaying the inverses forward would restore the first one instead')
}
{
  // the multi-patch run must still collapse repeated typing into one step
  const s = new Store(fresh())
  const before = content(s.doc)
  for (let i = 0; i < 5; i++) {
    s.runEdit('amount:1', [
      { op: 'setCells', sheet: 'sh1', col: 'amount', rids: [1], v: [i] },
      { op: 'setColumn', sheet: 'sh1', col: 'amount', patch: { unit: `U${i}` } },
    ])
  }
  s.endRun()
  s.undo()
  ok(content(s.doc) === before, 'five multi-patch edits in one cell are still ONE undo step')
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
