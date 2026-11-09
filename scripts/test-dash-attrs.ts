#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash: strings from a document reach markup only as values.
//
//   node scripts/test-dash-attrs.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. A column's width and id, a sheet's row-id runs, a
// dashboard tile's layout and a story step's id and caption are all written
// into attributes of markup built as strings. The file is untrusted input, so
// each is held at BOTH ends:
//
//   1. parseDoc repairs it on open — a width that is not a finite number in
//      range becomes one, an id that cannot sit in markup is re-minted and its
//      data moves with it, a row-id run becomes whole numbers. Never a dropped
//      column, never a file that no longer opens.
//   2. the paint site still escapes or coerces it, because a frozen file is
//      never repaired and a live edit never passes through parseDoc.
//
// Every row has a CONTROL (an ordinary value that must come through untouched)
// so a guard that refused everything could not pass. The grid's own attribute
// sites are driven in a browser by test-dash-attrs-browser.mjs.

import { registerHooks } from 'node:module'

registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { parseDoc, colW, isSafeId, COL_W } = await import('../dash/src/model.ts')
const { _internals: dash } = await import('../dash/src/dashboard.ts')
const { _internals: story } = await import('../dash/src/story.ts')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const MARK = 'zqmark'
const HOSTILE = [
  `1px" onmouseover="${MARK}()`,
  `x' onmouseover='${MARK}()`,
  `<img src=x onerror=${MARK}()>`,
  `a&quot;${MARK}`,
  `tab\there${MARK}`,
  `back\`tick${MARK}`,
]
const clean = (s: string): boolean => !s.includes(MARK)

// --- 1. a column width is a number ---------------------------------------------
ok(colW({ w: 200 }) === 200 && colW({ w: 64.5 }) === 64.5, 'colW: control — a real width is kept as it is')
ok(colW({}) === COL_W && colW(null) === COL_W, 'colW: no width is the default')
ok(colW({ w: 5 }) === 10 && colW({ w: 1e9 }) === 4000, 'colW: a width out of range is clamped')
for (const w of [...HOSTILE, '200', NaN, Infinity, -Infinity, null, true, { valueOf: () => 200 }, [200]]) {
  ok(colW({ w }) === COL_W, `colW: not a finite number → default: ${String(w)}`)
}

// --- 2. an id that can sit in markup -------------------------------------------
for (const id of ['col-1', 'value', 'c1', 'sh-1a2b3c', 'café', 'Revenue (net) 2026', 'a:b/c.d_e']) {
  ok(isSafeId(id), `isSafeId: control — ${id}`)
}
for (const id of [...HOSTILE, '', 'x'.repeat(129), 'nul\u0000', 'del\u007f', 'back\\slash', 42, null]) {
  ok(!isSafeId(id), `isSafeId refuses: ${JSON.stringify(id)}`)
}

// --- 3. parseDoc repairs a column's id and width, and keeps its data -------------
const docWith = (cols: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => JSON.stringify({
  format: 'bento/dash', version: 1, docId: 'd-attrs',
  sheets: [{
    id: 'sh1', name: 'S', kind: 'table', rids: [[1, 3]], steps: [],
    columns: cols,
    data: Object.fromEntries(cols.map((c, i) => [c.id, { enc: 'raw', v: [i + 1, i + 2, i + 3] }])),
    cells: Object.fromEntries(cols.map((c) => [`${c.id}:2`, { v: 99, note: 'kept' }])),
    totals: Object.fromEntries(cols.map((c) => [c.id, 'sum'])),
  }],
  ...extra,
})
const sheet0 = (r: ReturnType<typeof parseDoc>) => (r as any).doc.sheets[0]
{
  const r = parseDoc(docWith([{ id: 'a', name: 'A', type: 'number', w: 180 }, { id: 'b', name: 'B', type: 'number' }]))
  const s = sheet0(r)
  ok(r.ok && (r as any).repairs.length === 0, 'parseDoc: control — a clean file reports no repair')
  ok(s.columns[0].id === 'a' && s.columns[0].w === 180 && !('w' in s.columns[1]),
    'parseDoc: control — ids and widths are kept, and an absent width stays absent')
}
for (const bad of HOSTILE) {
  const r = parseDoc(docWith([{ id: bad, name: 'A', type: 'number', w: 120 }, { id: 'b', name: 'B', type: 'number', w: 90 }]))
  const s = sheet0(r)
  const id = s.columns[0].id
  ok(r.ok && s.columns.length === 2, `parseDoc keeps the column whose id was ${JSON.stringify(bad)}`)
  ok(isSafeId(id) && clean(id) && id !== bad, `  …under a fresh id (${id})`)
  ok(JSON.stringify(s.data[id]?.v) === '[1,2,3]' && !(bad in s.data), '  …and its data moved with it')
  ok(s.cells[`${id}:2`]?.note === 'kept' && s.totals[id] === 'sum', '  …and its cells and total')
  ok(s.columns[1].id === 'b', '  …and the column beside it is untouched')
  ok((r as any).repairs.some((x: any) => x.what === 'column-id' && x.id === bad), '  …and the repair is reported')
}
for (const bad of [...HOSTILE, '130', NaN, null, { a: 1 }]) {
  const raw = docWith([{ id: 'a', name: 'A', type: 'number', w: bad }])
  const r = parseDoc(raw)
  const s = sheet0(r)
  ok(r.ok && s.columns.length === 1 && s.columns[0].w === COL_W && s.columns[0].id === 'a',
    `parseDoc gives a width of ${JSON.stringify(bad)} the default, column kept`)
  ok((r as any).repairs.some((x: any) => x.what === 'column-width'), '  …and reports it')
}
{
  const s = sheet0(parseDoc(docWith([{ id: 'a', name: 'A', type: 'number', w: 9000 }])))
  ok(s.columns[0].w === 4000, 'parseDoc clamps a width past the maximum')
}
{
  // A frozen file is never rewritten; the paint sites carry it (browser rig).
  const r = parseDoc(docWith([{ id: HOSTILE[0], name: 'A', type: 'number', w: HOSTILE[0] }], { policy: 'some-later-policy' }))
  const s = sheet0(r)
  ok(r.ok && (r as any).frozen && s.columns[0].id === HOSTILE[0] && s.columns[0].w === HOSTILE[0],
    'parseDoc: a frozen file is left exactly as written')
}

// --- 4. row-id runs are whole numbers --------------------------------------------
const ridsOf = (rids: unknown) => sheet0(parseDoc(JSON.stringify({
  format: 'bento/dash', version: 1, docId: 'd-rids',
  sheets: [{ id: 'sh1', name: 'S', kind: 'table', rids, steps: [], columns: [], data: {} }],
}))).rids
ok(JSON.stringify(ridsOf([[1, 3], [10, 2]])) === '[[1,3],[10,2]]', 'rids: control — whole-number runs are kept')
{
  const r = ridsOf([[1, 3], [`7" onmouseover="${MARK}()`, 2], [20, 1]])
  ok(clean(JSON.stringify(r)) && r.every((x: unknown[]) => x.every((n) => Number.isSafeInteger(n))),
    `rids: a start that is not a number gets a fresh one (${JSON.stringify(r)})`)
  ok(r[1][0] === 21 && r[1][1] === 2 && r[0][0] === 1 && r[2][0] === 20,
    '  …past every other run, its count kept, the others untouched')
}
ok(JSON.stringify(ridsOf([[1, '2'], [5, 'x']])) === '[[1,2],[5,0]]', 'rids: a count reads as the number it says, or 0')
ok(JSON.stringify(ridsOf('nope')) === '[]', 'rids: not a list is no rows')

// --- 5. a dashboard tile's layout --------------------------------------------------
ok(dash.tileStyle({ x: 2, y: 1, w: 4, h: 3 }) === 'grid-column:3/span 4;grid-row:2/span 3',
  `tileStyle: control — a placed tile (${dash.tileStyle({ x: 2, y: 1, w: 4, h: 3 })})`)
for (const bad of HOSTILE) {
  for (const k of ['x', 'y', 'w', 'h']) {
    const st = dash.tileStyle({ x: 0, y: 0, w: 2, h: 2, [k]: bad })
    ok(clean(st) && !st.includes('"'), `tileStyle: a ${k} of ${JSON.stringify(bad)} draws as a number`)
  }
}

// --- 6. a story step's id and caption (data-id="…", value="…") ---------------------
ok(story.esc('Q3 — North & South') === 'Q3 — North &amp; South', 'story esc: control — text comes through')
for (const bad of HOSTILE) {
  const e = story.esc(bad)
  ok(!/["'<>]/.test(e), `story esc leaves no quote or bracket in: ${JSON.stringify(bad)}`)
}

console.log(`\n${checks - failures}/${checks} passed${failures ? `, ${failures} FAILED` : ''}`)
process.exit(failures ? 1 : 0)
