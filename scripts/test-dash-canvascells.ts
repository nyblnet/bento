#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The `setCanvasCells` patch — writes to a SPREADSHEET sheet (`kind: 'canvas'`,
// the sparse A1 map that has been in the format since commit one).
//
// WHAT THIS PROVES. A spreadsheet is sparse, and sparseness is not a size
// optimisation here — it is the difference between a cleared cell being GONE
// and being an empty object that every later comparison, save and merge has to
// agree about. So the checks below are mostly about absence: that a delete
// removes the key, that undoing a create removes it rather than blanking it,
// and that none of it allocates the rectangle it spans.
//
// It also pins the KEY, which was got wrong once: the format's key for this
// kind is an A1 ADDRESS, not `cellformula.cellKey(row, col)`. model.ts calls
// this "the classic sparse A1 map", validate.ts raises `bad-canvas-key` for
// anything else, and preview.ts parses A1 to find the used range for a
// thumbnail — so a document written with computation keys would have been
// invisible to all three.
//
// It also pins the collaboration fallback. The CRDT is driven by patch ops and
// has never heard of this one; `localOne`'s default arm sets `unsynced`, which
// makes the session ship a whole-state snapshot — "slower and always correct",
// in its own words. That is the behaviour spreadsheet editing relies on until
// the engine grows cell nodes, so a later change that makes the default arm
// silently drop the op would take spreadsheet collaboration with it.

import { applyPatch } from '../dash/src/store.ts'
import { committable } from '../dash/src/sync/crdt.ts'
import { formatRef, parseRef } from '../dash/src/a1.ts'
import type { Patch } from '../dash/src/store.ts'
import type { DashDoc, CanvasSheet } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const fresh = (): DashDoc => ({
  docId: 'doc-1', title: 'T', version: 1,
  sheets: [{ id: 'c1', name: 'Sheet', kind: 'canvas', cells: {} } as CanvasSheet],
} as unknown as DashDoc)

const sheet = (d: DashDoc) => d.sheets[0] as CanvasSheet
const keys = (d: DashDoc) => Object.keys(sheet(d).cells).sort()

// ------------------------------------------------------------ writing
{
  const d = fresh()
  const p: Patch = { op: 'setCanvasCells', sheet: 'c1', cells: { A1: { v: 'A' } } }
  const { inverse } = applyPatch(d, p)
  ok(sheet(d).cells.A1.v === 'A', 'a cell is written at its A1 address — the format\'s key for this kind')
  ok(!!parseRef(Object.keys(sheet(d).cells)[0]),
    'and every key parses as an A1 reference, which is exactly what validate.ts checks for')
  applyPatch(d, inverse as Patch)
  ok(keys(d).length === 0,
    'undoing a CREATE removes the key — it does not leave a blank cell behind, which would make an undone sheet unequal to a fresh one')
}
{
  const d = fresh()
  applyPatch(d, { op: 'setCanvasCells', sheet: 'c1', cells: { A1: { v: 1 }, F10: { v: 2 } } })
  ok(keys(d).length === 2, 'two distant cells cost two entries')
  ok(!('B2' in sheet(d).cells),
    'and nothing between them exists — a sparse sheet does not allocate the rectangle it spans')
}
{
  // one op, many cells: a paste is one edit to a reader and must be one undo step
  const d = fresh()
  const many: Record<string, { v: number }> = {}
  for (let i = 0; i < 50; i++) many[formatRef({ row: i, col: 0 })] = { v: i }
  const { inverse } = applyPatch(d, { op: 'setCanvasCells', sheet: 'c1', cells: many })
  ok(keys(d).length === 50, 'fifty cells land in ONE patch')
  applyPatch(d, inverse as Patch)
  ok(keys(d).length === 0, 'and ONE undo takes all fifty back — a paste is one edit, not fifty')
}

// ------------------------------------------------------------ deleting
{
  const d = fresh()
  applyPatch(d, { op: 'setCanvasCells', sheet: 'c1', cells: { A1: { v: 'x' }, B1: { v: 'y' } } })
  const { inverse } = applyPatch(d, { op: 'setCanvasCells', sheet: 'c1', cells: { A1: null } })
  ok(keys(d).join(',') === 'B1', 'null REMOVES the cell rather than storing an empty object')
  applyPatch(d, inverse as Patch)
  ok(sheet(d).cells.A1.v === 'x', 'and undo puts the value back, not a blank')
}
{
  // `null` and not `undefined`: this is what survives JSON, so it is what a
  // collaborator receives. Both must delete.
  const d = fresh()
  applyPatch(d, { op: 'setCanvasCells', sheet: 'c1', cells: { A1: { v: 'x' } } })
  applyPatch(d, { op: 'setCanvasCells', sheet: 'c1', cells: { A1: undefined as unknown as null } })
  ok(keys(d).length === 0, 'undefined deletes too — the spelling differs across a JSON round trip, the meaning must not')
}

// ------------------------------------------------------------ refusals
{
  const d = fresh()
  // `cells: {}` ON PURPOSE. A TableSheet's own `cells` (the CellOverride map)
  // is optional, so a version of `canvas()` that checked only existence still
  // threw here — on `undefined[k]` — and a try/catch counted that as a refusal.
  // The guard passed while testing nothing. Giving the table a real `cells`
  // removes the accident, so the only thing left that can refuse is the KIND
  // check, and the message is asserted rather than the mere fact of throwing.
  d.sheets.push({ id: 't1', name: 'Data', kind: 'table', rids: [], columns: [], data: {}, cells: {}, steps: [] } as never)
  let why = ''
  try { applyPatch(d, { op: 'setCanvasCells', sheet: 't1', cells: { A1: { v: 1 } } }) } catch (e) { why = String(e) }
  ok(/no spreadsheet sheet/.test(why),
    'writing spreadsheet cells to a DATASET sheet is refused BY KIND, not silently coerced')
  ok(!(d.sheets[1] as { cells?: Record<string, unknown> }).cells?.A1,
    'and the dataset sheet is untouched by the attempt')
  let why2 = ''
  try { applyPatch(d, { op: 'setCanvasCells', sheet: 'nope', cells: { A1: { v: 1 } } }) } catch (e) { why2 = String(e) }
  ok(/no spreadsheet sheet/.test(why2), 'and so is writing to a sheet that is not there')
}

// ------------------------------------------- the collaboration fallback
{
  const d = fresh()
  const p: Patch = { op: 'setCanvasCells', sheet: 'c1', cells: { A1: { v: 1 } } }
  ok(committable(d, p) === true,
    'the op reaches the CRDT rather than being filtered out — `committable`\'s default arm passes it, and that is what triggers the snapshot fallback')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
