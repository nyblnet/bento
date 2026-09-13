#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash DATA-ENTRY rig — the keys a typist presses, through the real editor.
//
//   node scripts/test-dash-entry.ts        (Node ≥ 23.6 strips types natively)
//
// WHY THIS EXISTS. select.ts records a "Tab run" so that Enter after
// Widget⇥12⇥4.50 comes home to column A, and test-dash-select.ts proves the
// MODEL does that — it even names the failure, "the bug that walks a typist
// diagonally across their table". It passed, and the typist was walked
// diagonally anyway: the editor's `finish()` moved with a bare `sel.move()`
// for every direction and never called `tab()` or `enter()`, so the run was
// never recorded on the one path real entry takes — type, then Tab. A feature
// complete, correct and UNREACHABLE, which is the shape this repo keeps
// finding. So this rig drives the EDITOR: `typeInto` opens it exactly as a
// keypress does, and the cell's own onkeydown finishes it exactly as Tab and
// Enter do.

import { registerHooks } from 'node:module'
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { installDom } = await import('./lib/dash-dom.ts')
const dom = installDom()
const { parseDoc } = await import('../dash/src/model.ts')
const { Store } = await import('../dash/src/store.ts')
const { Grid } = await import('../dash/src/grid.ts')

let checks = 0, failures = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const doc = parseDoc(JSON.stringify({
  format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
  sheets: [{
    id: 's1', name: 'S', kind: 'table', rids: [[1, 4]], nextRid: 5,
    columns: [
      { id: 'a', name: 'Item', type: 'text' },
      { id: 'b', name: 'Qty', type: 'number' },
      { id: 'c', name: 'Price', type: 'number' },
    ],
    data: { a: { enc: 'raw', v: [null, null, null, null] }, b: { enc: 'raw', v: [null, null, null, null] }, c: { enc: 'raw', v: [null, null, null, null] } },
    steps: [],
  }],
})).doc

dom.doc.body.children = []
const host = dom.doc.createElement('div')
dom.doc.body.appendChild(host)
const store = new Store(doc)
const grid = new Grid({ el: host as never, store, sheetId: 's1' })
const scroll = host.querySelector('.dg-scroll')!
scroll.clientHeight = 600; scroll.clientWidth = 900
grid.setSheet('s1')

/** Type a value into the cursor cell through the real editor, then press `key`. */
function typeThen(text: string, key: 'Tab' | 'Enter', shift = false) {
  ok(grid.typeInto(text[0]), `typing "${text[0]}" opens the editor on the cursor cell`)
  const cell = host.querySelector('.dg-editing') as unknown as { textContent: string; onkeydown: (e: unknown) => void } | null
  if (!cell) { ok(false, 'an editing cell exists'); return }
  cell.textContent = text
  cell.onkeydown({ key, shiftKey: shift, preventDefault() {}, stopPropagation() {} })
}
const at = () => [grid.sel.cursor.row, grid.sel.cursor.col] as const
const eq = (a: readonly [number, number], b: readonly [number, number], m: string) =>
  ok(a[0] === b[0] && a[1] === b[1], `${m} — cursor at [${a}], wanted [${b}]`)
const cellVal = (col: string, row: number) => (doc.sheets[0] as { data: Record<string, { v: unknown[] }> }).data[col].v[row]

console.log('a row typed with Tab between the fields, then Enter')
{
  grid.sel.moveTo(0, 0)
  typeThen('Widget', 'Tab');  eq(at(), [0, 1], 'Tab commits and moves right')
  typeThen('12', 'Tab');      eq(at(), [0, 2], 'Tab again')
  typeThen('4.50', 'Enter');  eq(at(), [1, 0], 'ENTER COMES HOME to the column the run started in, one row down')
  ok(cellVal('a', 0) === 'Widget' && cellVal('b', 0) === 12 && cellVal('c', 0) === 4.5,
    'and all three values landed in row 1 — Widget, 12, 4.5')
  // the landing cell is the new run start
  typeThen('Gadget', 'Tab');  typeThen('3', 'Enter')
  eq(at(), [2, 0], 'the next row does the same: Gadget⇥3⏎ lands on row 3 column A')
  ok(cellVal('a', 1) === 'Gadget' && cellVal('b', 1) === 3, 'with both values in row 2')
}

console.log('\nEnter with no Tab since is a plain move down')
{
  grid.sel.moveTo(0, 1)
  typeThen('7', 'Enter');     eq(at(), [1, 1], 'no run, so Enter stays in its column')
}

console.log('\nshift reverses both')
{
  grid.sel.moveTo(2, 2)
  typeThen('x', 'Tab', true); eq(at(), [2, 1], 'shift+Tab commits and moves LEFT')
  // the run started at column C (where shift+Tab was pressed), so home is C —
  // the mirror of Tab from A then Enter coming back to A
  typeThen('y', 'Enter', true); eq(at(), [1, 2], 'shift+Enter comes home one row UP, to the column the reverse run started in')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
