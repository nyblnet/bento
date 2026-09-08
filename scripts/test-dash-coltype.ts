#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Changing a column's TYPE converts its STORAGE — or refuses and changes nothing.
//
//   node scripts/test-dash-coltype.ts     (Node ≥ 23.6 strips types natively)
//
// WHY THIS EXISTS. This guards a shipped bug that produced a WRONG NUMBER at
// the end of a path dash itself recommends, which is the worst shape a defect
// can have: not a crash, not an error cell, a confident total that is wrong.
//
// Found by doing a real job with a real .xlsx. Import lands a mixed column as
// `text` and advises "set the column type once you have decided what it is".
// Follow that advice and — before this fix — only `col.type` changed. The grid
// began right-aligning the values and formatting them as numbers, so the column
// LOOKED converted, while `aggregate` (grid.ts) skips anything that is not
// already `typeof v === 'number'` and totalled the lot as ZERO. Measured on the
// real file: footer `SUM 0` against a true total of 10,308.85 — a number dash
// returns correctly from `=SUM(D2:D10)` on a spreadsheet copy of the same rows,
// so the two halves of the app disagreed and only one of them said so.
//
// THREE PROPERTIES, and the second and third are the ones that rot quietly:
//
//   1. Converting works. The bytes become numbers and the total is right.
//   2. Undo restores the BYTES, not just the declaration. An inverse that puts
//      back `type: 'text'` over converted storage recreates the same
//      disagreement pointing the other way, and every check on property 1
//      still passes while it does.
//   3. What will not convert is REFUSED, not zeroed. `coerce` answers null for
//      a value it cannot read, and committing those nulls would delete data on
//      a dropdown change. Refusing is the house rule import already follows.
//
// The validator is checked too, because store.ts can only stop this state being
// CREATED. It still ARRIVES: from a file saved by a build that had the bug, and
// from hand-edited or model-generated JSON, which PLATFORM §7 makes a
// first-class way in. Both look completely normal on screen.

import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { parseDoc } = await import('../dash/src/model.ts')
const { Store, readCell } = await import('../dash/src/store.ts')
const { aggregate } = await import('../dash/src/grid.ts')
const { validateDoc } = await import('../dash/src/validate.ts')

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const mk = (v: unknown[], type = 'text'): any => parseDoc(JSON.stringify({
  format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
  sheets: [{
    id: 's1', name: 'S', kind: 'table', rids: [[1, v.length]], nextRid: v.length + 1,
    columns: [{ id: 'amt', name: 'Amount', type }],
    data: { amt: { enc: 'raw', v } }, steps: [],
  }],
})).doc

const sumOf = (st: any, n: number): number | null =>
  aggregate('sum', (i: number) => readCell((st.doc.sheets[0] as any).data.amt, i), n, null)

console.log('1 · the reported bug: the total after a type change')
{
  const rows = ['1200.50', '3000', '6108.35', '0']
  const st = new Store(mk(rows))
  // `null`, NOT 0 — and this rig is the reason the difference matters. The
  // point here has always been that four numeric-looking STRINGS have no total,
  // because nothing in the column is a number. `0` said that badly: it is a
  // quantity, drawn in the column's format, and a reader sees "SUM £0" under
  // rows plainly containing £1200.50. `—` says the true thing, that there is
  // nothing here to add up.
  ok(sumOf(st, 4) === null, 'a TEXT column of numeric strings has NO total — they are text, and none of them is a number')
  st.commit({ op: 'setColumn', sheet: 's1', col: 'amt', patch: { type: 'number' } })
  ok(sumOf(st, 4) === 10308.85,
    'and after setting the type to number the footer total is RIGHT (10308.85, was 0)')
  const stored = (st.doc.sheets[0] as any).data.amt.v
  ok(stored.every((x: unknown) => typeof x === 'number'),
    'because the STORAGE was converted, not just the declaration — the bug was that only col.type moved')
  ok(validateDoc(st.doc).findings.every((f: any) => f.code !== 'type-storage-mismatch'),
    'and the document no longer disagrees with itself')
}

console.log('\n2 · undo restores the bytes, not only the declaration')
{
  const st = new Store(mk(['1200.50', '3000']))
  st.commit({ op: 'setColumn', sheet: 's1', col: 'amt', patch: { type: 'number' } })
  st.undo()
  const sh = st.doc.sheets[0] as any
  ok(sh.columns[0].type === 'text', 'undo puts the declared type back')
  // BYTE FOR BYTE, and the assertion has to say so literally. An earlier
  // version of this check tested `typeof x === 'string'` and a negative control
  // walked straight through it: with the inverse's bytes ignored, undo re-runs
  // the conversion in reverse and text→number→text is LOSSY — `"1200.50"` comes
  // back as `"1200.5"`. Every value is still a string, so a typeof check is
  // green while a trailing zero has been silently deleted. That is the whole
  // failure for an amount, an account number, or a version string like "1.10".
  ok(sh.data.amt.v.join('|') === '1200.50|3000',
    'AND the original strings BYTE FOR BYTE — text→number→text loses "1200.50" to "1200.5", ' +
    'which a typeof check cannot see')
  ok(sumOf(st, 2) === null, 'so the total is blank again, which is what a text column should total — nothing')
  ok(validateDoc(st.doc).findings.every((f: any) => f.code !== 'type-storage-mismatch'),
    'and undo does not leave the document disagreeing with itself either')
}

console.log('\n3 · what will not convert is refused, and nothing changes')
{
  const st = new Store(mk(['1200.50', 'n/a', '6108.35']))
  let why = ''
  try { st.commit({ op: 'setColumn', sheet: 's1', col: 'amt', patch: { type: 'number' } }) }
  catch (e) { why = e instanceof Error ? e.message : String(e) }
  const sh = st.doc.sheets[0] as any
  ok(/cannot be read as number/.test(why), 'the commit is refused, with a reason')
  ok(why.includes('n/a'), 'naming a value that would not convert, so the reader can go and look at it')
  ok(sh.columns[0].type === 'text', 'the declared type is unchanged')
  ok(sh.data.amt.v.join('|') === '1200.50|n/a|6108.35',
    'and NOT ONE VALUE was written — zeroing the unreadable ones would be data loss on a dropdown change')
}

console.log('\n4 · the validator catches a document that already arrived broken')
{
  // store.ts can only stop this being CREATED. A file saved by the buggy build
  // has it on disk, and PLATFORM §7 makes hand-edited JSON a first-class way in.
  const f = (d: any) => validateDoc(d).findings.filter((x: any) => x.code === 'type-storage-mismatch')
  ok(f(mk(['1', '2'], 'number')).length === 1, 'a number column holding strings is reported')
  ok(/SUM 0/.test(f(mk(['1'], 'number'))[0].message),
    'and the message names the symptom the reader actually saw, not just the shape')
  ok(f(mk([1, 2, 3], 'number')).length === 0, 'a number column holding numbers is silent')
  ok(f(mk([1, null, 3], 'number')).length === 0, 'and a blank is not a violation — null is a legitimate empty cell')
  ok(f(mk(['a', 'b'], 'text')).length === 0, 'a text column holding text is silent')
  ok(f(mk(['1', '2'], 'money')).length === 1, 'money is checked too — it is a number with a format')
}

console.log('\n5 · a refusal is REPORTED, and both call sites report it')
{
  // Measured on screen before this existed: the reader picked "Money", the
  // commit threw into the CONSOLE, and the dropdown went on displaying `money`
  // while the header chip beside it displayed `Text`. Two controls disagreeing,
  // no message, nothing to act on — the same shape as the bug this whole file
  // guards, and the second time this codebase has had it (the Offline switch
  // stayed ticked over a preference that had not persisted).
  const { setColumnType } = await import('../dash/src/store.ts')

  const good = new Store(mk(['1', '2']))
  const said: string[] = []
  ok(setColumnType(good, 's1', 'amt', 'number', (m: string) => said.push(m)) === true,
    'a conversion that works returns true')
  ok(said.length === 0, 'and says nothing, because there is nothing to say')

  const bad = new Store(mk(['1', 'n/a']))
  const heard: string[] = []
  ok(setColumnType(bad, 's1', 'amt', 'number', (m: string) => heard.push(m)) === false,
    'a refusal returns false, so the caller can put its control back')
  ok(heard.length === 1 && /cannot be read as number/.test(heard[0]),
    'and REPORTS the reason rather than throwing past the UI into the console')
  ok((bad.doc.sheets[0] as any).columns[0].type === 'text', 'with the column still untouched')

  // Both call sites must route through it. A third that forgets is the failure
  // this helper exists to remove, so the check is on the source.
  const src = (f: string) => readFileSync(new URL(`../dash/src/${f}`, import.meta.url), 'utf8')
  for (const f of ['panels.ts', 'main.ts']) {
    const code = src(f)
    ok(code.includes('setColumnType('),
      `${f} changes a column type through setColumnType, so its refusal is reported`)
    ok(!/commit\(\{ op: 'setColumn'[^}]*patch: \{ type:/.test(code),
      `and ${f} has no bare setColumn type commit left to swallow one`)
  }
  ok(src('panels.ts').includes('render(true)'),
    'and the panel rebuilds on refusal, so the dropdown cannot keep showing a type the column does not have')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
