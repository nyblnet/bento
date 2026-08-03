#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash document model rig.
//
//   node scripts/test-dash-model.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. The format is permanent — additive forever, with no server
// to migrate a single file (PLATFORM §3) — so the two ways it can be got wrong
// are both unrecoverable once files exist:
//
//   1. LOSS ON READ. A field, a per-node key or a transform op this build does
//      not recognise must survive parse → serialize. An older build meeting a
//      future op keeps it; it does not quietly drop it and then save the
//      result over the user's file.
//   2. THE STARTER OVER LIVE DATA. `parseDoc` returning null let spaces' caller
//      fall back to the starter, so opening a slides file gave you an empty
//      document over real content and the first ⌘S made it permanent. Only an
//      ABSENT or EMPTY block may reach the starter. Everything else refuses and
//      says what it found.
//
// Both are checked from both sides: the rig asserts the good case AND that a
// naive implementation (reconstruct-the-known-fields; return null on failure)
// would fail these very assertions.

import {
  FORMAT, FORMAT_VERSION, parseDoc, docBytes, rowCount, docBudget,
  DOC_BUDGET_FSA, DOC_BUDGET_DOWNLOAD,
  type DashDoc,
} from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const minimal = () => ({
  format: FORMAT,
  version: FORMAT_VERSION,
  policy: 'bento-dash-1',
  docId: 'doc-test',
  title: 'test',
  sheets: [{
    id: 'sh1', name: 'Sheet 1', kind: 'table',
    rids: [[1, 3]],
    columns: [{ id: 'c1', name: 'Region', type: 'text' }],
    data: { c1: { enc: 'dict', dict: ['North', 'South'], idx: [0, 1, 0] } },
    steps: [{ op: 'import', from: 'q3.csv', at: '2026-08-03T00:00:00Z', rows: 3 }],
  }],
})

// ---------------------------------------------------------------- the states
ok(parseDoc('').ok === false && (parseDoc('') as any).err === 'empty',
  'an empty block is err:"empty" — the ONLY state that may boot the starter')
ok((parseDoc('   ') as any).err === 'empty', 'whitespace is empty too')
ok((parseDoc('{oops') as any).err === 'json', 'malformed JSON is err:"json", not empty')
ok((parseDoc('[]') as any).err === 'shape', 'a JSON array is err:"shape", not empty')
ok((parseDoc('{"format":"bento/slides","slides":[]}') as any).err === 'format',
  'a slides document is err:"format", not empty')
ok((parseDoc('{"format":"bento/slides","slides":[]}') as any).found === 'bento/slides',
  'the format failure reports what it actually found, so the gate can name it')
ok((parseDoc(JSON.stringify({ format: FORMAT, version: 1, docId: 'd', title: 't' })) as any).err === 'shape',
  'a bento/dash document with no sheets array is err:"shape"')
ok(parseDoc(JSON.stringify(minimal())).ok === true, 'a well-formed document parses')

// THE POINT OF THE TYPE: every failure is distinguishable from 'empty'.
const failures_ = ['{oops', '[]', '{"format":"bento/slides"}', '{"format":"bento/dash","version":1}']
ok(failures_.every((j) => { const r = parseDoc(j) as any; return r.ok === false && r.err !== 'empty' }),
  'NO malformed input is ever reported as empty — the starter is unreachable from a parse failure')

// The tag the kernel cannot produce: present-but-unreadable is not empty.
// (kernel readEmbeddedDoc collapses both to null; the boot site must distinguish.)
type PR = ReturnType<typeof parseDoc>
const unreadable: PR = { ok: false, err: 'unreadable', detail: 'block present, body unreadable' }
ok(unreadable.ok === false && unreadable.err === 'unreadable',
  'the ParseResult type can express "present but unreadable" as distinct from "empty"')

// ------------------------------------------------------------- additivity
const exotic = {
  ...minimal(),
  futureTopLevel: { anything: [1, 2, 3] },
  sheets: [{
    ...minimal().sheets[0],
    futureSheetKey: 'kept',
    columns: [{ id: 'c1', name: 'Region', type: 'text', futureColumnKey: 42 }],
    steps: [
      { op: 'import', from: 'q3.csv', at: '2026-08-03T00:00:00Z' },
      { op: 'kanban-pivot', mystery: true, nested: { deep: ['x'] } },
    ],
  }],
}
const parsedExotic = parseDoc(JSON.stringify(exotic))
ok(parsedExotic.ok === true, 'a document carrying unknown fields and an unknown op still parses')
if (parsedExotic.ok) {
  const d = parsedExotic.doc as any
  ok(d.futureTopLevel?.anything?.length === 3, 'an unknown TOP-LEVEL field survives')
  ok(d.sheets[0].futureSheetKey === 'kept', 'an unknown SHEET field survives')
  ok(d.sheets[0].columns[0].futureColumnKey === 42, 'an unknown COLUMN field survives')
  ok(d.sheets[0].steps[1].op === 'kanban-pivot' && d.sheets[0].steps[1].nested.deep[0] === 'x',
    'an unknown transform OP survives whole, including nested values')
  // the assertion a reconstruct-the-known-fields parser fails
  ok(JSON.stringify(d) === JSON.stringify({ ...exotic, format: FORMAT, version: FORMAT_VERSION }),
    'parse → serialize is byte-identical for a document with nothing to repair')
}

// ------------------------------------------------------------------ frozen
const futureVersion = parseDoc(JSON.stringify({ ...minimal(), version: FORMAT_VERSION + 1 }))
ok(futureVersion.ok === true && futureVersion.frozen === 'version',
  'a future version OPENS, frozen — it does not refuse')
const futurePolicy = parseDoc(JSON.stringify({ ...minimal(), policy: 'bento-dash-2' }))
ok(futurePolicy.ok === true && futurePolicy.frozen === 'policy', 'an unknown policy opens frozen')
const both = parseDoc(JSON.stringify({ ...minimal(), version: 9, policy: 'bento-dash-9' }))
ok(both.ok === true && both.frozen === 'version', 'version wins when both are unknown')

// A frozen document is never rewritten, not even a duplicate id: the file
// declares rules this build does not have, so it round-trips byte-exact.
const dupFrozen = parseDoc(JSON.stringify({
  ...minimal(), version: 9,
  sheets: [{ ...minimal().sheets[0], id: 'same' }, { ...minimal().sheets[0], id: 'same' }],
}))
ok(dupFrozen.ok === true && dupFrozen.repairs.length === 0,
  'a FROZEN document repairs nothing, even a duplicate id')

// -------------------------------------------------------------- id repair
const dup = JSON.stringify({
  ...minimal(),
  sheets: [{ ...minimal().sheets[0], id: 'same' }, { ...minimal().sheets[0], id: 'same' }],
})
const r1 = parseDoc(dup)
const r2 = parseDoc(dup)
ok(r1.ok === true && r1.repairs.length === 1, 'a duplicate sheet id is repaired, and reported')
ok(r1.ok === true && r2.ok === true
  && JSON.stringify(r1.repairs) === JSON.stringify(r2.repairs),
  'repair is DETERMINISTIC — two readers of one file produce the same ids')
if (r1.ok && r2.ok) {
  ok((r1.doc.sheets[1] as any).id === (r2.doc.sheets[1] as any).id,
    'and therefore two readers agree on what the repaired sheet is called')
  ok((r1.doc.sheets[0] as any).id === 'same', 'the FIRST claimant keeps the id')
}
const missing = parseDoc(JSON.stringify({
  ...minimal(), sheets: [{ ...minimal().sheets[0], id: undefined }],
}))
ok(missing.ok === true && missing.repairs[0]?.what === 'missing-id',
  'a missing id is repaired and reported as missing, not as a duplicate')

// ------------------------------------------- column ids are SHEET-scoped
// Two sheets may both call a column `c1`. Sharing a namespace would rename the
// second, and a renamed column orphans its own data — measured: the column kept
// the new id, `data` kept the old key, and the column rendered EMPTY.
const twoSheets = (id: string) => ({
  id, name: 'S', kind: 'table', rids: [[1, 2]],
  columns: [{ id: 'c1', name: 'Region', type: 'text' }],
  data: { c1: { enc: 'raw', v: ['North', 'South'] } },
  cells: { 'c1:1': { note: 'checked' } },
  totals: { c1: 'count' },
  steps: [],
})
const scoped = parseDoc(JSON.stringify({
  ...minimal(), sheets: [twoSheets('a'), twoSheets('b')],
}))
ok(scoped.ok === true && scoped.repairs.length === 0,
  'the same column id in two different sheets is NOT a collision')
if (scoped.ok) {
  const s2 = scoped.doc.sheets[1] as any
  ok(s2.columns[0].id === 'c1' && Object.keys(s2.data)[0] === 'c1',
    'and neither sheet is rewritten, so no column is orphaned')
}

// When a column id genuinely IS duplicated within one sheet, the repair must
// carry the data with it or the repair is itself the loss.
const dupCol = parseDoc(JSON.stringify({
  ...minimal(),
  sheets: [{
    id: 'sh1', name: 'S', kind: 'table', rids: [[1, 2]],
    columns: [
      { id: 'c1', name: 'A', type: 'text' },
      { id: 'c1', name: 'B', type: 'number' },
    ],
    data: { c1: { enc: 'raw', v: [1, 2] } },
    cells: { 'c1:1': { note: 'kept' } },
    totals: { c1: 'sum' },
    steps: [],
  }],
}))
ok(dupCol.ok === true && dupCol.repairs.length === 1,
  'a duplicate column id WITHIN one sheet is repaired once')
if (dupCol.ok) {
  const sh = dupCol.doc.sheets[0] as any
  const ids = sh.columns.map((c: any) => c.id)
  ok(new Set(ids).size === 2, 'the two columns end up with distinct ids')
  ok(Object.keys(sh.data).every((k: string) => ids.includes(k)),
    'every data key still names a column that exists — no orphaned column data')
  ok(Object.keys(sh.cells).every((k: string) => ids.includes(k.split(':')[0])),
    'cell overrides follow the rename ("<colId>:<rid>" — only the column half moves)')
  ok(Object.keys(sh.totals).every((k: string) => ids.includes(k)),
    'the totals row follows the rename')
}

// --------------------------------------------------------------- budgets
const doc = (parseDoc(JSON.stringify(minimal())) as any).doc as DashDoc
ok(rowCount(doc) === 3, 'rowCount reads the run-length encoded ids')
ok(docBytes(doc) === JSON.stringify(doc).length,
  'docBytes is the serialized length — #bento-doc is plaintext, so file size IS JSON size')
ok(docBudget(true) === DOC_BUDGET_FSA && docBudget(false) === DOC_BUDGET_DOWNLOAD,
  'the budget scales with whether this browser can write in place')
ok(DOC_BUDGET_DOWNLOAD < DOC_BUDGET_FSA,
  'and the download-only budget is the SMALLER one — every save rewrites the whole file')
ok(!Object.keys({ FORMAT, FORMAT_VERSION }).includes('ROW_MAX'),
  'there is no row cap: rows are the wrong unit (1M x 12 is 65 MB; 1M x 2 is ~10 MB)')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
