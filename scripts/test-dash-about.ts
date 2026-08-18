#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash About-surface rig — the decisions, not the dialog.
//
//   node scripts/test-dash-about.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Three of About's buttons hand a WHOLE NEW WORKBOOK to the
// running app — replace-from-JSON, restore-a-version, duplicate — and each has
// a failure that looks like nothing at all until much later:
//
//   1. A SWAP THAT TAKES THE APP DOWN. `Grid.sheet` throws when the sheet id it
//      holds is missing, and it reads it from a `doc` listener registered
//      before all the others. So a workbook arriving with different sheet ids
//      throws mid-emit and the chart, the 3D panel and THE DIRTY FLAG never
//      run: the app looks fine, and the next tab-close is silent data loss.
//   2. A DUPLICATE THAT IS NOT A DUPLICATE. Share the docId and the copy
//      inherits the original's version timeline and overwrites its recovery
//      snapshot — two files restoring each other's work. Share the mutable
//      objects and editing the copy edits the original in memory, so the fork
//      that was supposed to be independent saves the original's changes.
//   3. A COPY THAT PHONES HOME. The file IS the capability (PLATFORM §5): a
//      fork keeping `collab` joins the room it forked away from.
//
// Only the pure half is exercised here. The dialog itself is DOM wiring, and
// the two document-level handlers it has to survive (main.ts's bare-key grid
// typing and its CSV paste sniffer) need a real browser to prove.

import { registerHooks } from 'node:module'

// about.ts imports its own stylesheet — Vite's job, and a file extension Node
// refuses outright. Stub it here rather than splitting the module: the logic
// under test is what the dialog is FOR, and it belongs beside it.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { planReplace, duplicateWorkbook, workbookStats } =
  await import('../dash/src/about.ts')
const { parseDoc } = await import('../dash/src/model.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// --------------------------------------------------------------- fixtures

const workbook = (sheetIds: string[], extra: Record<string, unknown> = {}): DashDoc => {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1',
    docId: 'doc-original', title: 'test',
    sheets: sheetIds.map((id) => ({
      id, name: id, kind: 'table',
      rids: [[1, 3]],
      columns: [
        { id: 'region', name: 'Region', type: 'text' },
        { id: 'amount', name: 'Amount', type: 'number' },
      ],
      data: {
        region: { enc: 'dict', dict: ['North', 'South'], idx: [0, 1, 0] },
        amount: { enc: 'raw', v: [10, 20, 30] },
      },
      steps: [],
    })),
    theme: { background: '#FFFFFF', color: '#1E2A3A', accent: '#F7A600', fontFamily: 'sans-serif' },
    ...extra,
  }))
  if (!r.ok) throw new Error('fixture does not parse')
  return r.doc
}

// ========================================================= planReplace

{
  const next = workbook(['sh1', 'sh2'])
  const plan = planReplace(next, 'sh2')
  ok(plan !== null && plan.show === 'sh2' && !plan.carry,
    'a workbook that still has the sheet on screen swaps in one step and stays put')
}
{
  // the round trip an agent makes: same ids, different values
  const plan = planReplace(workbook(['sh1']), 'sh1')
  ok(plan !== null && !plan.carry,
    'an edited copy of the SAME workbook never needs the carry — the reader is not moved')
}
{
  const plan = planReplace(workbook(['other']), 'sh1')
  ok(plan !== null && plan.show === 'other' && plan.carry,
    'a workbook with different sheet ids carries the outgoing sheet through, or the grid throws mid-emit')
}
{
  const plan = planReplace(workbook(['a', 'b', 'c']), 'gone')
  ok(plan !== null && plan.show === 'a',
    'the first table sheet is where a moved reader lands')
}
{
  const canvasOnly = workbook([])
  canvasOnly.sheets = [{ id: 'cv', name: 'Canvas', kind: 'canvas', cells: {} } as never]
  ok(planReplace(canvasOnly, 'sh1') === null,
    'a workbook with no TABLE sheet is refused — the grid has nothing to show, and a blank screen reads as data loss')
}
{
  ok(planReplace(workbook([]), 'sh1') === null,
    'a workbook with no sheets at all is refused rather than swapped in')
}

// ========================================================= duplicateWorkbook

{
  const src = workbook(['sh1'], { collab: { room: 'w-abc', key: 'secret' }, template: true })
  const copy = duplicateWorkbook(src)
  ok(copy.docId !== src.docId && copy.docId.length > 8,
    'a duplicate mints a fresh docId — sharing it would make the copy overwrite the original’s recovery snapshot')
  ok(copy.collab === undefined,
    'a duplicate drops collab: the file is the capability, so a copy carrying it writes into the room it forked from')
  ok(copy.template === undefined,
    'a duplicate drops template — a duplicate is a document, not a thing that spawns fresh documents')
  ok(src.docId === 'doc-original' && (src as { collab?: unknown }).collab !== undefined,
    'the original is not touched by being duplicated')
}
{
  const src = workbook(['sh1'])
  const copy = duplicateWorkbook(src)
  ok(copy.sheets[0] !== src.sheets[0] && copy.theme !== src.theme,
    'the clone is DEEP — a shared sheet object means editing the fork edits the original in memory')
  const sheet = copy.sheets[0] as { data: Record<string, { enc: string; v?: unknown[] }> }
  ;(sheet.data.amount.v as number[])[0] = 999
  const orig = src.sheets[0] as { data: Record<string, { v: number[] }> }
  ok(orig.data.amount.v[0] === 10,
    'writing a cell in the fork leaves the original’s column alone')
}
{
  ok(duplicateWorkbook(workbook(['sh1']), 'fixed-id').docId === 'fixed-id',
    'the docId can be supplied, so a caller that has to mint it elsewhere still round-trips')
}

// ========================================================= workbookStats

{
  const doc = workbook(['sh1', 'sh2'])
  const s = workbookStats(doc)
  ok(s.sheets === 2 && s.tables === 2 && s.rows === 6 && s.columns === 4,
    'the counts read the run-length encoded row ids, not a flattened copy of them')
  ok(s.bytes === JSON.stringify(doc).length,
    'size is the JSON length, because #bento-doc is plaintext forever — file size IS document size')
}
{
  const mixed = workbook(['sh1'])
  mixed.sheets.push({ id: 'cv', name: 'Canvas', kind: 'canvas', cells: {} } as never)
  const s = workbookStats(mixed)
  ok(s.sheets === 2 && s.tables === 1 && s.rows === 3,
    'a canvas sheet counts as a sheet and contributes no rows or columns')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
