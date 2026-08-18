#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash row + column structure rig.
//
//   node scripts/test-dash-rowcol.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Structural edits are the operations where a spreadsheet
// silently changes what a number MEANS, and every failure below looks like a
// working grid:
//
//   1. A RID THAT COMES BACK. Row ids are what hand corrections, notes and
//      (soon) CRDT identity attach to. Mint a fresh row the number of a deleted
//      one and the deleted row's override lands on it — an attributed human
//      correction, with an author and a reason, applied to data nobody checked.
//   2. A DELETE THAT LEAVES SOMETHING BEHIND. `removeColumn` drops the column
//      and its values and stops; the `"<colId>:<rid>"` overrides survive. Import
//      derives column ids by slugging the header, so the next import of the same
//      CSV re-creates the id and the ghosts attach to fresh data.
//   3. AN OFF-BY-ONE IN A MOVE. Remove-then-insert lands one short in one
//      direction and exactly right in the other, so the bug only shows when a
//      column is dragged leftwards — or rightwards, depending on which half of
//      the mistake you made.
//   4. A ROW COUNT THAT DRIFTS FROM A COLUMN. `insertRows` splices `raw` and
//      `dict` columns and skips `pack` entirely, so one packed column shifts
//      every other column by one against it — invisibly, and forever. A column
//      added with too few values is the quieter half: it reads correctly inside
//      this build and is malformed to everything that reads the FILE.
//
// So the checks below assert the WRONG answer is refused, not merely that a
// right one is possible.

import { parseDoc, type Column, type DashDoc, type TableSheet } from '../dash/src/model.ts'
import { RID_BLOCK, RID_BLOCKS, ridBase, ridBlockFor } from '../dash/src/model.ts'
import { Store, applyPatch, readCell, _internals as store_, type Patch } from '../dash/src/store.ts'
import { insertRowsAt, deleteRowsAt, insertColumn, deleteColumn, moveColumn, resizeColumn,
  autoFitWidth, freezeAt, readFrozen, applySheetProps, hiddenSet, setHidden,
  _internals, type SetSheetProps, setRidBlock } from '../dash/src/rowcol.ts'

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
        { id: 'region', name: 'Region', type: 'text' },
        { id: 'amount', name: 'Amount', type: 'number' },
        { id: 'note', name: 'Note', type: 'text' },
      ],
      data: {
        region: { enc: 'dict', dict: ['North', 'South'], idx: [0, 1, 0, 1] },
        amount: { enc: 'raw', v: [10, 20, 30, 40] },
        note: { enc: 'raw', v: ['a', 'b', 'c', 'd'] },
      },
      // a hand correction on the SECOND row — the thing every check below is
      // ultimately protecting
      cells: { 'amount:2': { v: 21, was: 20, by: 'andy', why: 'invoice 4471' } },
      steps: [{ op: 'import', from: 'q3.csv', at: '2026-08-03T00:00:00Z', rows: 4 }],
    }],
  }))
  if (!r.ok) throw new Error('fixture does not parse')
  return r.doc
}

const sheetOf = (d: DashDoc): TableSheet => d.sheets[0] as TableSheet

/**
 * The document minus `modified`, with keys sorted.
 *
 * `modified` legitimately moves — undo IS an edit. Key ORDER is sorted because
 * it is not document meaning: deleting `cells` and restoring it puts the key
 * back at the end of the object, and asserting on that would be asserting on
 * JavaScript's insertion order rather than on the round trip.
 */
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

/** every value of one column, in row order */
const vals = (s: TableSheet, col: string): unknown[] => {
  const n = s.rids.reduce((a, [, c]) => a + c, 0)
  return Array.from({ length: n }, (_, i) => readCell(s.data[col], i))
}
const ridList = (s: TableSheet): number[] => _internals.ridsInOrder(s)
const j = (v: unknown): string => JSON.stringify(v)

const throws = (fn: () => unknown): boolean => {
  try { fn(); return false } catch { return true }
}

/**
 * The rid watermark is the one field undo may NOT restore: a rid that has
 * existed must never be minted again, because overrides, comments and a peer's
 * CRDT node all assume a rid names one row forever. Comparing it would assert
 * the opposite of what the format requires, so it is excluded here and checked
 * directly in the store rig instead. Everything else is compared byte for byte.
 */
const noMark = (d: DashDoc): string => {
  const { modified: _m, ...rest } = d
  // through `canon`, like `content` — key ORDER changes freely when a delete's
  // inverse re-inserts a property, and comparing raw JSON would fail on that
  // rather than on anything anybody could observe.
  return JSON.stringify(canon(rest), (k, v) => (k === 'nextRid' ? undefined : v))
}

/** mint → commit → undo → is the document semantically where it started? */
function roundTrip(name: string, make: (s: TableSheet) => Patch | Patch[]) {
  const st = new Store(fresh())
  const before = content(st.doc)
  const beforeMark = noMark(st.doc)
  const patches = make(sheetOf(st.doc))
  st.commit(patches)
  const changed = content(st.doc) !== before
  const undone = st.undo()
  ok(changed, `${name}: the patch actually changed something`)
  ok(undone && noMark(st.doc) === beforeMark,
    `${name}: undo restores the document exactly (bar the monotonic rid watermark)`)
}

// ============================================================ INSERT ROWS

{
  const st = new Store(fresh())
  st.commit(insertRowsAt(sheetOf(st.doc), 2, 2))
  const s = sheetOf(st.doc)
  ok(j(vals(s, 'amount')) === j([10, 20, null, null, 30, 40]),
    'inserting in the MIDDLE opens a gap and shifts nothing above it')
  ok(j(vals(s, 'region')) === j(['North', 'South', null, null, 'North', 'South']),
    'and a dict-encoded column splices with it, not beside it')
  ok(j(ridList(s)) === j([1, 2, 5, 6, 3, 4]),
    'the new rows take fresh rids at the insert POSITION — position and identity are different things')
  ok(new Set(ridList(s)).size === 6, 'every rid in the sheet is still unique')
  ok(readCell(s.data.amount, store_.ridIndex(s, 2)) === 20,
    'rid 2 still names the value it named before the insert')
  ok(s.cells?.['amount:2']?.v === 21,
    "and the override attached to rid 2 still lands on rid 2's row")
}

// THE ONE THE COMMENT IN rowcol.ts IS ABOUT: a row deleted by some other path
// (a raw patch, an older build, a merge) leaves its override behind. Minting
// that rid again would re-apply a stranger's correction to a brand-new row.
{
  const st = new Store(fresh())
  const s0 = sheetOf(st.doc)
  s0.cells!['amount:9'] = { v: 999, by: 'someone', why: 'a row that was deleted' }
  const p = insertRowsAt(s0, 4, 1)[0] as Extract<Patch, { op: 'insertRows' }>
  ok(p.rids[0] === 10,
    'a rid is minted above every rid an ORPHANED override still names (9 → 10)')
  ok(p.rids[0] !== 5,
    'and NOT above the live rows alone, which would hand the new row rid 5 and then 9 next time')
  st.commit([p])
  ok(sheetOf(st.doc).cells!['amount:9'].v === 999,
    'the orphan is left alone — it is evidence, and deleting it here would hide the problem')
}
{
  // the durable path: a stamped water mark wins even when nothing else shows it
  const st = new Store(fresh())
  const s = sheetOf(st.doc)
  s.nextRid = 500
  ok(_internals.nextRidFloor(s) === 500, 'an explicit nextRid stamp is honoured when the file carries one')
  s.nextRid = 2
  ok(_internals.nextRidFloor(s) === 5, 'a stale stamp never LOWERS the floor below the live rows')
}
{
  const st = new Store(fresh())
  st.commit(insertRowsAt(sheetOf(st.doc), 999, 1))
  ok(j(vals(sheetOf(st.doc), 'amount')) === j([10, 20, 30, 40, null]),
    'a position past the end appends rather than throwing — a drag can run off the sheet')
  st.commit(insertRowsAt(sheetOf(st.doc), -3, 1))
  ok(vals(sheetOf(st.doc), 'amount')[0] === null, 'and a negative position clamps to the top')
}
{
  const s = sheetOf(fresh())
  ok(insertRowsAt(s, 1, 0).length === 0 && insertRowsAt(s, 1, -2).length === 0,
    'inserting zero rows produces NO patch — an empty commit is an undo step that does nothing visible')
}
{
  const st = new Store(fresh())
  const s = sheetOf(st.doc)
  s.data.packed = { enc: 'pack', b64: 'AAAA', n: 4 }
  ok(throws(() => insertRowsAt(s, 1, 1)),
    'inserting a row into a sheet with a PACKED column is refused, not silently misaligned')
  ok(throws(() => deleteRowsAt(s, 1, 1)), 'and so is deleting one')
}

roundTrip('insertRowsAt', (s) => insertRowsAt(s, 2, 3))

// ============================================================ DELETE ROWS

{
  const st = new Store(fresh())
  st.commit(deleteRowsAt(sheetOf(st.doc), 1, 2))
  const s = sheetOf(st.doc)
  ok(j(vals(s, 'amount')) === j([10, 40]), 'deleteRowsAt removes the rows at the positions asked for')
  ok(j(ridList(s)) === j([1, 4]), 'and the surviving rows keep their own rids')
  ok(s.cells === undefined,
    'the override attached to a deleted row goes with it, and the empty container goes too')
}
{
  // The same delete through the RAW patch. This check has flipped: it used to
  // assert that a bare `deleteRows` stranded the override — the ghost
  // `deleteRowsAt` existed to sweep up — and that stranding was a real
  // divergence, because `insertRows`' own inverse is a bare `deleteRows`, so
  // undoing an insert took the raw path and left the orphan behind on the
  // undoing replica only. applyPatch takes the overrides with the row now, and
  // hands them to the inverse, so both routes agree.
  const st = new Store(fresh())
  st.commit({ op: 'deleteRows', sheet: 'sh1', rids: [2, 3] })
  ok(sheetOf(st.doc).cells?.['amount:2'] === undefined,
    'a bare deleteRows patch takes the override with it too — both routes agree now')
  st.undo()
  ok(sheetOf(st.doc).cells?.['amount:2']?.v === 21,
    'and undoing it brings the override back, not just the values')
}
{
  const st = new Store(fresh())
  const before = vals(sheetOf(st.doc), 'amount')
  st.commit(deleteRowsAt(sheetOf(st.doc), 1, 2))
  st.undo()
  const s = sheetOf(st.doc)
  ok(j(vals(s, 'amount')) === j(before), 'undoing a delete brings the VALUES back, not empty rows')
  ok(s.cells?.['amount:2']?.v === 21 && s.cells?.['amount:2']?.why === 'invoice 4471',
    'and brings the hand correction back with its author and its reason')
}
{
  const st = new Store(fresh())
  st.commit(deleteRowsAt(sheetOf(st.doc), 3, 99))
  ok(j(vals(sheetOf(st.doc), 'amount')) === j([10, 20, 30]),
    'a count past the end deletes what exists rather than throwing')
  const s = sheetOf(st.doc)
  ok(deleteRowsAt(s, 9, 1).length === 0, 'and a start past the end deletes nothing at all')
}

roundTrip('deleteRowsAt', (s) => deleteRowsAt(s, 0, 2))

// =========================================================== INSERT COLUMN

{
  const st = new Store(fresh())
  const qty: Column = { id: 'qty', name: 'Qty', type: 'number' }
  st.commit(insertColumn(sheetOf(st.doc), 1, qty, { enc: 'raw', v: [1, 2, 3, 4] }))
  const s = sheetOf(st.doc)
  ok(s.columns[1].id === 'qty', 'insertColumn lands at the index asked for')
  ok(j(vals(s, 'qty')) === j([1, 2, 3, 4]), 'and its data comes with it')
}
{
  // A short `raw` column READS like a padded one (readCell answers `?? null`
  // past the end), so the check has to be on the stored LENGTH — which is what
  // every other reader of the file sees.
  const st = new Store(fresh())
  st.commit(insertColumn(sheetOf(st.doc), 0, { id: 'short', name: 'Short', type: 'text' },
    { enc: 'raw', v: ['x', 'y'] }))
  const len = (s: TableSheet, c: string): number => {
    const d = s.data[c]
    return d.enc === 'raw' ? d.v.length : d.enc === 'dict' ? d.idx.length : d.n
  }
  ok(len(sheetOf(st.doc), 'short') === 4,
    'a short column is PADDED to the row count — 2 values on a 4-row sheet is a malformed file')
  ok(j(vals(sheetOf(st.doc), 'short')) === j(['x', 'y', null, null]), 'and the values it had are where it had them')
  st.commit(insertRowsAt(sheetOf(st.doc), 0, 1))
  const s = sheetOf(st.doc)
  ok([...s.columns].every((c) => len(s, c.id) === 5),
    'so every column still stores exactly one value per row after a later insert — including the padded one')
}
{
  const s = sheetOf(fresh())
  ok(throws(() => insertColumn(s, 0, { id: 'amount', name: 'Dup', type: 'number' })),
    'a duplicate column id is REFUSED — two columns sharing one data key is silent overwriting')
  ok(throws(() => insertColumn(s, 0, { id: 'f', name: 'F', type: 'number', formula: 'amount*2' },
    { enc: 'raw', v: [1, 2, 3, 4] })),
    'a formula column may not also carry stored values — the file could then disagree with itself')
  ok(throws(() => insertColumn(s, 0, { id: 'long', name: 'L', type: 'number' },
    { enc: 'raw', v: [1, 2, 3, 4, 5] })),
    'data LONGER than the sheet is refused rather than trimmed to an arbitrary prefix')
  ok(insertColumn(s, 0, { id: 'f2', name: 'F', type: 'number', formula: 'amount*2' }).length === 1,
    'a formula column with no data is fine')
  const at = insertColumn(s, 99, { id: 'z', name: 'Z', type: 'text' })[0] as Extract<Patch, { op: 'addColumn' }>
  ok(at.at === 3, 'an index past the end appends')
}

roundTrip('insertColumn', (s) => insertColumn(s, 1, { id: 'qty', name: 'Qty', type: 'number' },
  { enc: 'raw', v: [1, 2, 3, 4] }))

// =========================================================== DELETE COLUMN

{
  const st = new Store(fresh())
  st.commit(deleteColumn(sheetOf(st.doc), 'amount'))
  const s = sheetOf(st.doc)
  ok(s.columns.length === 2 && !s.columns.some((c) => c.id === 'amount'), 'deleteColumn removes the column')
  ok(!('amount' in s.data), 'and its data goes with it')
  ok(!Object.keys(s.cells ?? {}).some((k) => k.startsWith('amount:')),
    'and every override keyed to it goes with it — the bug class this helper exists for')
}
{
  const st = new Store(fresh())
  st.commit({ op: 'removeColumn', sheet: 'sh1', col: 'amount' })
  ok(sheetOf(st.doc).cells?.['amount:2']?.v === 21,
    'a bare removeColumn leaves the override orphaned — so this check can fail, and once did')
}
{
  // THE RESURRECTION. Column ids are slugged from the CSV header, so the next
  // import of the same file re-creates the id exactly.
  const raw = new Store(fresh())
  raw.commit({ op: 'removeColumn', sheet: 'sh1', col: 'amount' })
  raw.commit({ op: 'addColumn', sheet: 'sh1', column: { id: 'amount', name: 'Amount', type: 'number' },
    data: { enc: 'raw', v: [7, 7, 7, 7] } })
  ok(sheetOf(raw.doc).cells?.['amount:2']?.v === 21,
    "re-importing after a bare delete re-applies a stranger's correction to fresh data (21 over 7)")

  const st = new Store(fresh())
  st.commit(deleteColumn(sheetOf(st.doc), 'amount'))
  st.commit(insertColumn(sheetOf(st.doc), 1, { id: 'amount', name: 'Amount', type: 'number' },
    { enc: 'raw', v: [7, 7, 7, 7] }))
  ok(sheetOf(st.doc).cells?.['amount:2'] === undefined,
    'through deleteColumn there is nothing left to resurrect')
}
{
  const s = sheetOf(fresh())
  ok(throws(() => deleteColumn(s, 'nope')), 'deleting a column that is not there is refused')
}

roundTrip('deleteColumn', (s) => deleteColumn(s, 'amount'))

// ============================================================= MOVE COLUMN
// columns start as [region, amount, note]

const order = (s: TableSheet): string[] => s.columns.map((c) => c.id)

{
  const st = new Store(fresh())
  st.commit(moveColumn(sheetOf(st.doc), 'region', 2))   // leftmost, rightwards
  const got = order(sheetOf(st.doc))
  ok(got.indexOf('region') === 2, 'moving RIGHT lands at the requested index')
  ok(j(got) === j(['amount', 'note', 'region']), 'and the others close the gap in order')
  ok(j(got) !== j(['amount', 'region', 'note']),
    'not one short of it — the remove-then-insert off-by-one, which only shows in this direction')
}
{
  const st = new Store(fresh())
  st.commit(moveColumn(sheetOf(st.doc), 'note', 0))     // rightmost, leftwards
  const got = order(sheetOf(st.doc))
  ok(got.indexOf('note') === 0, 'moving LEFT lands at the requested index too')
  ok(j(got) === j(['note', 'region', 'amount']), 'and it means the same index in both directions')
}
{
  const st = new Store(fresh())
  st.commit(moveColumn(sheetOf(st.doc), 'region', 1))
  ok(j(order(sheetOf(st.doc))) === j(['amount', 'region', 'note']), 'a one-step move right')
  st.commit(moveColumn(sheetOf(st.doc), 'region', 0))
  ok(j(order(sheetOf(st.doc))) === j(['region', 'amount', 'note']), 'and back again — the move is its own inverse')
}
{
  const s = sheetOf(fresh())
  const p = moveColumn(s, 'region', 99)[0] as Extract<Patch, { op: 'reorderColumns' }>
  ok(p.order.length === 3 && new Set(p.order).size === 3,
    'the emitted order is a FULL permutation: reorderColumns DELETES any column an order omits')
  ok(p.order.indexOf('region') === 2, 'an index past the end lands at the last position')
  // `splice` truncates a fractional index by itself, so the clamp earns its
  // keep at the NO-OP test: 1.7 against a column already at index 1 has to
  // compare equal, or the move commits an undo step that reorders nothing.
  ok(moveColumn(s, 'amount', 1.7).length === 0 && moveColumn(s, 'region', NaN).length === 0,
    'a fractional or non-finite index resolves BEFORE the "already there" test')
  ok(moveColumn(s, 'region', 0).length === 0, 'moving a column where it already is produces no patch')
  ok(throws(() => moveColumn(s, 'nope', 0)), 'moving a column that is not there is refused')
}
{
  // A frozen document is never id-repaired (it declares rules this build does
  // not have, so it round-trips byte-exact) — duplicate column ids therefore
  // reach this code, and removing "the column with this id" by FILTER would
  // remove both of them.
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-99', docId: 'd', title: 't',
    sheets: [{
      id: 'sh1', name: 'S', kind: 'table', rids: [[1, 1]],
      columns: [{ id: 'dup', name: 'A', type: 'text' }, { id: 'dup', name: 'B', type: 'text' },
        { id: 'note', name: 'N', type: 'text' }],
      data: {}, steps: [],
    }],
  }))
  const frozen = r.ok ? sheetOf(r.doc) : sheetOf(fresh())
  ok(r.ok && r.frozen === 'policy' && frozen.columns.length === 3,
    'a frozen document keeps its duplicate column ids, unrepaired')
  const p = moveColumn(frozen, 'dup', 2)[0] as Extract<Patch, { op: 'reorderColumns' }>
  ok(p.order.length === 3 && p.order.filter((i) => i === 'dup').length === 2,
    'and moving one of them moves ONE — a filter by id would drop the twin and its data with it')
}
{
  // why the permutation matters, demonstrated against the store itself
  const st = new Store(fresh())
  st.commit({ op: 'reorderColumns', sheet: 'sh1', order: ['region'] })
  const lost = order(sheetOf(st.doc)).length === 1
  st.undo()
  ok(lost && order(sheetOf(st.doc)).length === 1,
    'a PARTIAL order drops columns and undo cannot bring them back — moveColumn never emits one')
}

roundTrip('moveColumn', (s) => moveColumn(s, 'region', 2))

// =========================================================== RESIZE COLUMN

{
  const s = sheetOf(fresh())
  const w = (px: number) => (resizeColumn(s, 'amount', px) as Extract<Patch, { op: 'setColumn' }>).patch.w
  ok(w(10) === _internals.MIN_W, 'a width below the minimum clamps rather than throwing mid-drag')
  ok(w(9999) === _internals.MAX_W, 'and above the maximum')
  ok(w(130.6) === 131, 'widths are integers — fractional px bloat the JSON and never render differently')
  ok(Number.isFinite(w(NaN) as number),
    'a NaN from a drag computation clamps: JSON.stringify(NaN) is null, and width:nullpx renders nothing')
  ok(throws(() => resizeColumn(s, 'nope', 100)), 'resizing a column that is not there is refused')
}

roundTrip('resizeColumn', (s) => resizeColumn(s, 'amount', 240))

// ============================================================== AUTO-FIT

const col = (over: Partial<Column>): Column =>
  ({ id: 'c', name: 'C', type: 'text', ...over } as Column)
const from = (v: unknown[]) => (row: number) => v[row]

{
  const short = autoFitWidth(from(['a', 'b']), col({}), 2)
  const long = autoFitWidth(from(['a', 'antidisestablishmentarianism']), col({}), 2)
  ok(long > short, 'a column with longer content fits wider')
  ok(Number.isInteger(long) && long >= _internals.MIN_W, 'the answer is a whole number of px, never below the minimum')
  ok(autoFitWidth(from(['x'.repeat(400)]), col({}), 1) === _internals.MAX_W, 'and never above the maximum')
  ok(autoFitWidth(from(['x'.repeat(400)]), col({}), 1, { max: 200 }) === 200, 'opts.max caps it')
}
{
  // the header is a floor: a wide name with empty cells must still show
  const wide = autoFitWidth(from([]), col({ name: 'Gross margin before rebates' }), 0)
  const narrow = autoFitWidth(from([]), col({ name: 'A' }), 0)
  ok(wide > narrow + 100, 'a long column NAME widens the column even when every cell is empty')
  // Digits are wider than lowercase in the grid's font, which is the whole
  // reason for the per-type weight table. The numbers are literal on purpose:
  // asserting against CHAR_W would read the same constant the code reads and
  // pass whatever it said. 8 chars x 7.2 + 20 padding = 78; x 8.0 = 84.
  ok(autoFitWidth(from(['12345678']), col({ name: 'A', type: 'text' }), 1) === 78,
    'eight characters of text get a lowercase weight')
  ok(autoFitWidth(from([12345678]), col({ name: 'A', type: 'number', format: '0' }), 1) === 84,
    'and eight DIGITS get a wider one — a clipped digit is a wrong number')
  ok(autoFitWidth(from([12345678]), col({ name: 'A', type: 'number' }), 1) === 100,
    'while the same number GROUPED is ten glyphs, not eight — the separators need room too')
}
{
  // FORMATTED, not raw: the reader sees the formatted string and that is what
  // has to fit. 1234.5 is 6 characters; "$1,234.50" is 9.
  const money = col({ name: 'Amt', type: 'money', format: '$#,##0.00' })
  const fitted = autoFitWidth(from([1234.5]), money, 1)
  ok(fitted === 92, 'auto-fit measures the FORMATTED value ($1,234.50), not the stored number')
  ok(fitted !== 88, 'a String(v) implementation gets 6 characters, falls under the header floor, and clips')
}
{
  // stride sampling, spread across the column rather than taken off the top
  const many: unknown[] = Array.from({ length: 5000 }, () => 'ab')
  const flat = autoFitWidth(from(many), col({ name: 'A' }), 5000)
  many[4999] = 'a very long value that only appears in the last row of the file'
  const tail = autoFitWidth(from(many), col({ name: 'A' }), 5000)
  ok(tail > flat,
    'the last row is always read — a CSV sorted by name keeps its longest value at the end')
  many[4999] = 'ab'
  many[2500] = 'a value in the middle that a first-500 sample would miss entirely'
  ok(autoFitWidth(from(many), col({ name: 'A' }), 5000) > flat,
    'and the sample is spread by stride, not taken off the top')
}

// ================================================================= FREEZE

{
  const s = sheetOf(fresh())
  const before = JSON.stringify(canon(s))
  const p = freezeAt(s, 1, 1) as SetSheetProps
  ok(p.op === 'setSheetProps' && p.sheet === 'sh1', 'freezeAt names the sheet it applies to')
  ok(readFrozen(s).rows === 0, 'and mints WITHOUT touching the sheet — every helper here is a factory')

  const { inverse } = applySheetProps(s, p)
  ok(j(readFrozen(s)) === j({ rows: 1, cols: 1 }), 'applying it freezes one row and one column')
  applySheetProps(s, inverse)
  ok(JSON.stringify(canon(s)) === before,
    'and the inverse removes the KEY, not just its value — a first freeze must undo to no field at all')
  ok(!('frozen' in s), 'so the sheet is exactly as it was found')
}
{
  const s = sheetOf(fresh())        // 4 rows, 3 columns
  applySheetProps(s, freezeAt(s, 1e9, 1e9) as SetSheetProps)
  ok(j(readFrozen(s)) === j({ rows: 3, cols: 2 }),
    'freezing more than exists clamps to leave something to scroll')
  ok(j(readFrozen(s)) !== j({ rows: 4, cols: 3 }),
    'and NOT to the full sheet, which would render a grid that cannot move')
  applySheetProps(s, freezeAt(s, -5, 0) as SetSheetProps)
  ok(!('frozen' in s), 'freezing nothing DROPS the field rather than storing zeroes')
}
{
  const s = sheetOf(fresh())
  ok(j(readFrozen(s)) === j({ rows: 0, cols: 0 }), 'an unfrozen sheet reads as zero/zero')
  s.frozen = 3
  ok(j(readFrozen(s)) === j({ rows: 0, cols: 0 }), 'junk in an additive field reads as NOT frozen')
  s.frozen = { rows: 'two', cols: -1 }
  ok(j(readFrozen(s)) === j({ rows: 0, cols: 0 }), 'and so does a half-written one')
  s.frozen = { rows: 2.7, cols: 1 }
  ok(j(readFrozen(s)) === j({ rows: 2, cols: 1 }), 'a fractional count floors — you cannot freeze 0.7 of a row')
}
{
  const s = sheetOf(fresh())
  ok(throws(() => applySheetProps(s, { op: 'setSheetProps', sheet: 'sh1', props: { data: {} } })),
    'setSheetProps refuses to write `data` — structure moves through patches that can invert it')
  ok(throws(() => applySheetProps(s, { op: 'setSheetProps', sheet: 'sh1', props: {}, drop: ['rids'] })),
    'and refuses to drop `rids`')
  ok(throws(() => applySheetProps(s, { op: 'setSheetProps', sheet: 'sh1', props: { frozen: 1 }, drop: ['frozen'] })),
    'and refuses to set and drop one key in the same patch')
  ok(j(vals(s, 'amount')) === j([10, 20, 30, 40]), 'a refused props patch changed nothing on the way out')
}
{
  // the round trip that matters for a field that already exists
  const s = sheetOf(fresh())
  applySheetProps(s, freezeAt(s, 2, 1) as SetSheetProps)
  const mid = JSON.stringify(canon(s))
  const { inverse } = applySheetProps(s, freezeAt(s, 1, 0) as SetSheetProps)
  ok(j(readFrozen(s)) === j({ rows: 1, cols: 0 }), 'a second freeze replaces the first')
  applySheetProps(s, inverse)
  ok(JSON.stringify(canon(s)) === mid, 'and its inverse restores the previous freeze, not the absence of one')
}

// ================================================================= HIDDEN

{
  const st = new Store(fresh())
  ok(hiddenSet(sheetOf(st.doc)).size === 0, 'nothing is hidden in a fresh sheet')
  st.commit(setHidden(sheetOf(st.doc), 'note', true))
  const s = sheetOf(st.doc)
  ok(hiddenSet(s).has('note') && hiddenSet(s).size === 1, 'setHidden hides exactly one column, by id')
  ok(s.columns.length === 3 && j(vals(s, 'note')) === j(['a', 'b', 'c', 'd']),
    'hiding is a view flag on the column — the data is still there')

  st.commit(setHidden(sheetOf(st.doc), 'note', false))
  ok(hiddenSet(sheetOf(st.doc)).size === 0, 'and showing it again unhides it')
  // The original assertion here was that showing a column leaves NO `hidden`
  // key, achieved by patching `{hidden: undefined}`. That is tidier in the
  // file and WRONG on the wire: JSON.stringify drops an undefined value, so
  // the patch arrives as `{}` and the un-hide silently does nothing — for a
  // collaborator, for the agent API, for anything that serializes a patch.
  // A dead `"hidden": false` costs 16 bytes on a column somebody has touched.
  // An un-hide that does not travel costs the user their action.
  ok(JSON.parse(JSON.stringify(setHidden(sheetOf(st.doc), 'note', false))).patch.hidden === false,
    'the un-hide SURVIVES a JSON round trip — `undefined` would arrive as an empty patch and do nothing')
}
{
  const s = sheetOf(fresh())
  s.columns[0].hidden = 1
  ok(!hiddenSet(s).has('region'),
    'a foreign truthy value is not hidden: a column that shows is recoverable, a column that vanishes is not')
  ok(throws(() => setHidden(s, 'nope', true)), 'hiding a column that is not there is refused')
}

roundTrip('setHidden', (s) => setHidden(s, 'note', true))

// ================================================== the patches still apply
// Everything above goes through Store.commit, which is applyPatch — but the
// helpers claim to be pure factories, so check that too.
{
  const s = sheetOf(fresh())
  const before = j(s.columns.map((c) => c.id))
  const minted: (Patch | Patch[])[] = [
    insertRowsAt(s, 1, 2), deleteRowsAt(s, 0, 1), insertColumn(s, 0, { id: 'n', name: 'N', type: 'text' }),
    deleteColumn(s, 'note'), moveColumn(s, 'region', 2), resizeColumn(s, 'amount', 200),
    setHidden(s, 'note', true),
  ]
  ok(minted.length === 7 && j(s.columns.map((c) => c.id)) === before && j(vals(s, 'amount')) === j([10, 20, 30, 40]),
    'minting seven patches from one sheet mutates nothing — they are factories, not edits')
}
{
  // and a patch built from a stale read still applies cleanly to a live doc
  const st = new Store(fresh())
  const patches: Patch[] = [
    ...insertColumn(sheetOf(st.doc), 3, { id: 'qty', name: 'Qty', type: 'number' }, { enc: 'raw', v: [1, 2, 3, 4] }),
  ]
  const r = applyPatch(st.doc, patches[0])
  ok(r.touched.structural === true && r.touched.cols?.includes('qty') === true,
    'the store reports a structural invalidation naming the column, so the grid relayouts instead of repainting')
}

// RID PARTITIONING — the correctness precondition collaboration rests on.
//
// The watermark stops a rid being REUSED after a delete. It cannot touch the
// concurrent case: two people insert at the same moment, both compute "one past
// the highest I know about", and both get the same number. rid is IDENTITY — the
// CRDT keys a row node on it — so two different rows sharing one merge into a
// single row and one of them is silently lost.
{
  const A = 'actor-aaaa'
  const B = 'actor-bbbb'
  ok(ridBlockFor(A) !== ridBlockFor(B), 'two actors derive different rid blocks')
  ok(ridBlockFor(A) === ridBlockFor(A), 'and the derivation is deterministic')
  ok(ridBlockFor(A) > 0 && ridBlockFor(B) > 0,
    'never block 0, which is reserved for solo documents')
  ok(ridBase(0) === 1, 'so an unshared workbook still numbers its rows from 1')
  ok(ridBase(RID_BLOCKS - 1) + RID_BLOCK - 1 <= Number.MAX_SAFE_INTEGER,
    'and the very top block still lands inside exact integer arithmetic')

  /** Mint `n` rows as `actor`, from the same starting document. */
  const mintAs = (actor: string | null, n: number): number[] => {
    setRidBlock(actor === null ? null : ridBase(ridBlockFor(actor)))
    const st = new Store(fresh())
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      const p = insertRowsAt(sheetOf(st.doc), 0, 1) as Patch[]
      st.commit(p)
      out.push((p[0] as { rids: number[] }).rids[0])
    }
    setRidBlock(null)
    return out
  }

  // THE CASE THAT MATTERS: both replicas start from the SAME document and both
  // insert. Without partitioning they mint the identical numbers.
  const fromA = mintAs(A, 25)
  const fromB = mintAs(B, 25)
  const clash = fromA.filter((r) => fromB.includes(r))
  ok(clash.length === 0,
    `two replicas inserting concurrently from the same document share NO rid (${clash.length} collisions)`)
  ok(new Set(fromA).size === fromA.length, 'and one replica never repeats itself')

  // reuse after a delete, INSIDE a block — the watermark cannot help here,
  // because it is a maximum across every actor and would push this replica out
  // of its own block entirely
  setRidBlock(ridBase(ridBlockFor(A)))
  {
    const st = new Store(fresh())
    const seen: number[] = []
    for (let i = 0; i < 6; i++) {
      const p = insertRowsAt(sheetOf(st.doc), 0, 1) as Patch[]
      st.commit(p)
      const rid = (p[0] as { rids: number[] }).rids[0]
      seen.push(rid)
      st.commit(deleteRowsAt(sheetOf(st.doc), 0, 1))   // delete it again at once
    }
    ok(new Set(seen).size === seen.length,
      'a rid deleted inside a block is never minted again in that session')
  }
  setRidBlock(null)

  // and the solo path is byte-for-byte what it always was
  const solo = mintAs(null, 3)
  ok(JSON.stringify(solo) === JSON.stringify([5, 6, 7]),
    `a solo document still mints small consecutive rids (${solo.join(',')})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
