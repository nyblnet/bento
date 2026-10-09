#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash CROSS-SHEET STRUCTURE rig — a row inserted on one sheet moves the
// formulas on every OTHER sheet that name its rows.
//
//   node scripts/test-dash-xshift.ts        (Node ≥ 23.6 strips types natively)
//
// WHY THIS EXISTS. `shiftRefsForInsert` has carried a `scope` — "which sheet
// the edit was on, which sheet the formula lives on" — and the rule that a
// reference moves only when the two agree. test-dash-a1.ts proves it. And the
// grid never passed it: `Grid.shiftFormulas` walked the formulas of the sheet
// being edited and no other, so `=SUM(Pipeline!D1:D8)` on Scratch stayed
// `D1:D8` after a ninth deal was inserted into the middle of Pipeline. The
// starter workbook's own cross-sheet total was one insert away from being
// wrong — silently, a number that looks right. The same shape as the Tab-run
// bug in test-dash-entry.ts: a correct engine and an interface that did not
// call it. So this rig drives the GRID's patch factory over a real workbook.

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
const { insertRowsAt, deleteRowsAt } = await import('../dash/src/rowcol.ts')
const { recalcWorkbook, workbookSources, cellKey } = await import('../dash/src/cellformula.ts')
const { parseRef } = await import('../dash/src/a1.ts')
type CanvasSheet = import('../dash/src/model.ts').CanvasSheet
type TableSheet = import('../dash/src/model.ts').TableSheet

let checks = 0, failures = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const fresh = () => parseDoc(JSON.stringify({
  format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
  names: { Third: { ref: 'Pipeline!D3' }, Local: { ref: 'D3' } },
  sheets: [
    {
      id: 'p', name: 'Pipeline', kind: 'table', rids: [[1, 4]], nextRid: 5,
      columns: [
        { id: 'a', name: 'Region', type: 'text' }, { id: 'b', name: 'Owner', type: 'text' },
        { id: 'c', name: 'Stage', type: 'text' }, { id: 'd', name: 'Value', type: 'number' },
      ],
      data: {
        a: { enc: 'raw', v: ['N', 'S', 'E', 'W'] }, b: { enc: 'raw', v: ['p', 'q', 'r', 's'] },
        c: { enc: 'raw', v: ['Won', 'Open', 'Won', 'Lost'] }, d: { enc: 'raw', v: [10, 20, 30, 40] },
      },
      cells: { 'd:3': { f: '=D2*2' } },
      steps: [],
    },
    {
      id: 'o', name: 'Other', kind: 'table', rids: [[1, 3]], nextRid: 4,
      columns: [{ id: 'x', name: 'X', type: 'number' }],
      data: { x: { enc: 'raw', v: [1, 2, 3] } },
      cells: { 'x:1': { f: '=Pipeline!D4' }, 'x:2': { f: '=X1+1' } },
      steps: [],
    },
    {
      id: 's', name: 'Scratch', kind: 'canvas',
      cells: {
        A1: { f: '=SUM(Pipeline!D1:D4)' },
        A2: { f: '=Pipeline!D3' },
        A3: { f: '=SUM(A1:A2)' },
        A4: { f: "='Pipeline'!$D$4" },
        B1: { v: 5 }, B2: { v: 6 }, B3: { f: '=SUM(B1:B2)' },
      },
    },
  ],
})).doc

const mount = () => {
  dom.doc.body.children = []
  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const store = new Store(fresh())
  const grid = new Grid({ el: host as never, store, sheetId: 'p' })
  const scroll = host.querySelector('.dg-scroll')!
  scroll.clientHeight = 600; scroll.clientWidth = 900
  grid.setSheet('p')
  return { store, grid }
}
const scratch = (store: InstanceType<typeof Store>) => (store.doc.sheets.find((s) => s.id === 's') as CanvasSheet).cells
const other = (store: InstanceType<typeof Store>) => (store.doc.sheets.find((s) => s.id === 'o') as TableSheet).cells ?? {}
const pipe = (store: InstanceType<typeof Store>) => (store.doc.sheets.find((s) => s.id === 'p') as TableSheet).cells ?? {}
const valueOf = (store: InstanceType<typeof Store>, addr: string): unknown => {
  const r = recalcWorkbook(workbookSources(store.doc))
  const ref = parseRef(addr)!
  return r.get('s')?.values.get(cellKey(ref.row, ref.col))
}

console.log('insert a row INSIDE the range, on the sheet the others reference')
{
  const { store, grid } = mount()
  // D3 is the per-cell formula =D2*2 = 40, so the four deals are 10+20+40+40
  ok(valueOf(store, 'A1') === 110 && valueOf(store, 'A2') === 40, `the cross-sheet total is 110 and D3 is 40 before anything moves — ${valueOf(store, 'A1')}, ${valueOf(store, 'A2')}`)
  // `nextRid` is monotonic by design (a row id is never reused) and `modified` is a clock
  const shape = (d: typeof store.doc) => JSON.stringify({ ...d, modified: undefined, sheets: d.sheets.map((x) => ({ ...x, nextRid: undefined })) })
  const before = shape(store.doc)
  // a row at canonical index 1 — between the first and second deal
  store.commit([...insertRowsAt(grid.sheet, 1, 1), ...grid.shiftFormulas('row', 1, 1)])
  ok(scratch(store).A1?.f === '=SUM(Pipeline!D1:D5)', `the range on Scratch WIDENS to take the new row in — ${scratch(store).A1?.f}`)
  ok(scratch(store).A2?.f === '=Pipeline!D4', `a single reference past the insert moves down — ${scratch(store).A2?.f}`)
  // (a reference that MOVED is respelled canonically — the quotes go because
  // `Pipeline` never needed them; one that did not move keeps its spelling)
  ok(scratch(store).A4?.f === '=Pipeline!$D$5', `\`$\` does not pin it: the cell moved — ${scratch(store).A4?.f}`)
  ok(scratch(store).A3?.f === '=SUM(A1:A2)' && scratch(store).B3?.f === '=SUM(B1:B2)', 'Scratch\'s OWN references do not move — nothing was inserted on Scratch')
  ok(other(store)['x:1']?.f === '=Pipeline!D5' && other(store)['x:2']?.f === '=X1+1', `a dataset on a third sheet follows the same rule — ${other(store)['x:1']?.f}, ${other(store)['x:2']?.f}`)
  ok(pipe(store)['d:3']?.f === '=D3*2', `Pipeline's own local formula still moves as it always did — ${pipe(store)['d:3']?.f}`)
  ok(store.doc.names?.Third?.ref === 'Pipeline!D4', `a defined name INTO Pipeline moves — ${store.doc.names?.Third?.ref}`)
  ok(store.doc.names?.Local?.ref === 'D3', 'an unqualified defined name has no sheet to have moved on, and stays')
  ok(valueOf(store, 'A1') === 110 && valueOf(store, 'A2') === 40, `and the numbers are the SAME numbers: total still 110, the deal that was 40 is still 40 — ${valueOf(store, 'A1')}, ${valueOf(store, 'A2')}`)
  store.undo()
  ok(shape(store.doc) === before, 'one undo puts every sheet back')
}

console.log('\ndelete a row the others point at')
{
  const { store, grid } = mount()
  store.commit([...deleteRowsAt(grid.sheet, 2, 1), ...grid.shiftFormulas('row', 2, -1)])
  ok(scratch(store).A1?.f === '=SUM(Pipeline!D1:D3)', `the range SHRINKS — ${scratch(store).A1?.f}`)
  ok(scratch(store).A2?.f === '=#REF!', `a reference to the deleted row is #REF!, never the row that slid into its place — ${scratch(store).A2?.f}`)
  ok(scratch(store).A4?.f === '=Pipeline!$D$3', `a reference below it moves up — ${scratch(store).A4?.f}`)
  ok(other(store)['x:1']?.f === '=Pipeline!D3', `on the third sheet too — ${other(store)['x:1']?.f}`)
  ok(valueOf(store, 'A1') === 70, `the total is the three deals that remain — ${valueOf(store, 'A1')}`)
}

console.log('\nan edit on a sheet nobody references touches nothing else')
{
  const { store, grid } = mount()
  grid.setSheet('o')
  const ps = grid.shiftFormulas('row', 0, 1)
  ok(ps.every((p) => (p as { sheet?: string }).sheet === 'o'), `every patch is for Other itself — ${ps.map((p) => (p as { sheet?: string }).sheet ?? p.op).join(',')}`)
  ok(ps.length === 1, 'and it is one patch: Other\'s own X1+1')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
