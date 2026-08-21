#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash ARRAY FORMULAS — `=A1:A10*2` in one cell, ten values on the sheet.
//
//   node scripts/test-dash-spill.ts
//
// WHAT THIS PROVES. Spill is not "return more than one number" — that part is
// four lines. Everything hard about it is what happens to the cells the numbers
// land in, and every one of those failures writes a plausible figure onto the
// sheet rather than complaining:
//
//   COMPUTED, NOT STORED    only the anchor holds a formula. If a spilled value
//                           ever reaches `sheet.cells` it is saved as if a
//                           person typed it, survives the formula that made it,
//                           and becomes a number with no provenance that
//                           nothing will ever recompute. The document is
//                           compared byte for byte before and after.
//   COLLISION BLOCKS        something already in the spill area must stop the
//                           spill with `#SPILL!`. Overwriting is data loss, and
//                           it is data loss to a cell the author is looking at.
//   TWO SPILLS, ONE ANSWER  when two spills want the same cell, the winner must
//                           be the same on every machine and after every
//                           reload. Evaluation order is decided by the
//                           dependency graph and by the order a sparse map
//                           happens to enumerate, so reading order decides.
//   THE OUTPUT IS DATA      a cell reading a spilled cell must see the spilled
//                           value, and a range covering spilled cells must
//                           total them. Both need the anchor ordered first, and
//                           the footprint is not known until it has run — which
//                           is why the recalculation runs to a fixed point.
//   SHAPE SURVIVES          `=A1:C2*2` is 2 rows of 3, not 6 rows of 1. Every
//                           operator in formula.ts used to throw the width
//                           away, so the wrong answer here is a column of six
//                           correct numbers — right in the first cell, which is
//                           the only one anybody checks.
//   NOT ON DATASETS         `kind:'table'` is typed per COLUMN and is exactly
//                           as long as the rows it has. Spilling there would
//                           either invent rows or write untyped cells into a
//                           typed column, and the columnar answer already
//                           exists: a column formula IS the spill.
//                           (docs/dash-sheet-kinds.md, "Two kinds of sheet".)
//   VISIBLE ON SCREEN       the last block mounts the REAL grid and reads the
//                           painted markup, because an engine that spills
//                           perfectly into a map nothing paints is invisible.

import { registerHooks } from 'node:module'

registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const { installDom } = await import('./lib/dash-dom.ts')
const dom = installDom()

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}


const { readFileSync } = await import('node:fs')
const { dirname, resolve } = await import('node:path')
const { fileURLToPath } = await import('node:url')

const {
  cellKey, evalCellArray, recalcCells, recalcWorkbook, spilledFrom, spillExtent,
  SPILL_CELL_MAX, workbookSources,
} = await import('../dash/src/cellformula.ts')
const { isErr } = await import('../dash/src/formula.ts')
const { parseDoc } = await import('../dash/src/model.ts')
const { Store } = await import('../dash/src/store.ts')

// --- the grid, with the paint hook this feature needs ------------------------
//
// THE HOOK IS NOT IN THIS AGENT'S FILES. `grid.ts` belongs to another zone, and
// the two edits below are handed over to be applied at merge — exactly the way
// the appearance hook was handed over last round (commit 67d0eb6, whose own
// message says the rig change matters more than the hook).
//
// The failure that commit describes is the one this block exists to prevent:
// both paint calls could be deleted and 192 checks stayed green, because they
// proved a pure function and nothing proved the grid CALLED it. Here the stakes
// are the same and worse — a spilled cell holds nothing in the document, so a
// grid that does not consult the computed map paints one number and nine blanks
// while every engine check passes.
//
// So the rig applies the patch to a COPY of grid.ts and asserts on the markup
// that copy emits. That proves three things a "pending" comment cannot: the
// anchors still exist in grid.ts (the replacements are asserted, so a drifting
// file fails here), the patch is SUFFICIENT (the painted output is read), and
// the patch is CORRECT (it is the text being reported, not a paraphrase). Once
// the real file carries it, the patch is a no-op and the real module is used.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../dash/src')

function requireGridHook(): void {
  const src = readFileSync(`${SRC}/grid.ts`, 'utf8')
  ok(src.includes('spillExtent(rc)'),
    'grid.ts CALLS spillExtent — without it a 100-row spill paints ~40 rows and stops, ' +
    'with nothing on screen saying the rest of the answer exists')
  ok(src.includes("this.cvComputed(row, col) ??"),
    'and cvValueAt consults the computed map, or every spilled cell reads as empty')
  ok(src.includes('spillExtent, translateCellFormula'), 'and the import is there')
}
requireGridHook()

const { Grid } = await import('../dash/src/grid.ts')
type Cell = import('../dash/src/formula.ts').Cell
type CellSource = import('../dash/src/cellformula.ts').CellSource
type CellRecalc = import('../dash/src/cellformula.ts').CellRecalc
type DashDoc = import('../dash/src/model.ts').DashDoc

// --- fixtures ----------------------------------------------------------------

const A1 = (a: string): { row: number; col: number } => {
  const m = /^([A-Z]+)(\d+)$/.exec(a)!
  let col = 0
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(m[2]) - 1, col: col - 1 }
}
const K = (a: string): string => { const p = A1(a); return cellKey(p.row, p.col) }

type Lit = Record<string, string | number>

/**
 * A spreadsheet sheet from an A1 literal.
 *
 * Keys go in as the A1 spelling, which is what grid.ts's `canvasKey` writes and
 * therefore what a real file holds. `canvasCellSource` reads both spellings, so
 * using this one is also the check that they agree.
 */
function canvas(name: string, at: Lit): unknown {
  const cells: Record<string, unknown> = {}
  for (const [a, v] of Object.entries(at)) {
    cells[a] = typeof v === 'string' && v.startsWith('=') ? { f: v } : { v }
  }
  return { id: name.toLowerCase(), name, kind: 'canvas', cells }
}

const book = (...sheets: unknown[]) => recalcWorkbook(workbookSources({ sheets } as never))
const one = (at: Lit): CellRecalc => book(canvas('S', at)).get('s')!
const val = (r: CellRecalc, a: string): Cell => r.values.get(K(a)) ?? null
const code = (v: Cell): string => (isErr(v) ? String(v) : `not an error (${JSON.stringify(v)})`)

// --- 1. it spills -------------------------------------------------------------

console.log('\none formula, many cells')
{
  const r = one({ A1: 10, A2: 20, A3: 30, B1: '=A1:A3*2' })
  ok(val(r, 'B1') === 20, 'the ANCHOR shows the first value')
  ok(val(r, 'B2') === 40 && val(r, 'B3') === 60, 'and the rest of the array lands below it')
  ok(val(r, 'B4') === null, 'and stops — B4 is not part of the array')

  ok(r.spills.get(K('B1'))?.anchor === K('B1'), 'the anchor is in the spill map, as its own anchor')
  ok(spilledFrom(r, A1('B2').row, A1('B2').col) === K('B1'),
    'B2 reports the anchor it came from — the grid needs this to refuse an edit')
  ok(spilledFrom(r, A1('B1').row, A1('B1').col) === undefined,
    'the anchor itself is NOT spilled output: it is the one cell a person may edit')
  ok(r.order.length === 1, 'exactly one formula was evaluated, not three')

  // A bare range spills too — `=A1:A3` is the array, no operator required.
  const bare = one({ A1: 10, A2: 20, A3: 30, C1: '=A1:A3' })
  ok(val(bare, 'C2') === 20 && val(bare, 'C3') === 30, 'a bare range spills as well')
}

// --- 2. computed, not stored --------------------------------------------------

console.log('\nnothing is written into the document')
{
  const sheet = canvas('S', { A1: 10, A2: 20, A3: 30, B1: '=A1:A3*2' })
  const before = JSON.stringify(sheet)
  const doc = { sheets: [sheet] }
  const r = recalcWorkbook(workbookSources(doc as never)).get('s')!
  ok(val(r, 'B3') === 60, 'the spill computed')
  ok(JSON.stringify(sheet) === before,
    'and the document is byte-for-byte what it was — a spilled value is never stored')

  // And it VANISHES when the anchor changes. The proof that it was never
  // stored is that nothing had to be cleaned up.
  ;(sheet as { cells: Record<string, unknown> }).cells.B1 = { f: '=A1*2' }
  const after = recalcWorkbook(workbookSources({ sheets: [sheet] } as never)).get('s')!
  ok(val(after, 'B1') === 20, 'the anchor still computes')
  ok(val(after, 'B2') === null && val(after, 'B3') === null,
    'and the cells it used to fill are empty again — no residue to clear')
  ok(after.spills.size === 0, 'and nothing is claimed')
}

// --- 3. collision blocks, it never overwrites ---------------------------------

console.log('\nsomething is already there')
{
  const r = one({ A1: 10, A2: 20, A3: 30, B1: '=A1:A3*2', B3: 99 })
  ok(code(val(r, 'B1')) === '#SPILL!', 'a typed value in the way blocks the whole spill')
  ok(val(r, 'B2') === null, 'and NOTHING is placed — not even the cells that would have fitted')
  ok(r.spills.size === 0, 'nothing is claimed')

  // The obstruction is untouched. This is the data-loss check: if the spill had
  // written over B3 the 99 would be gone and nothing on screen would say so.
  const src = canvas('S', { A1: 10, A2: 20, A3: 30, B1: '=A1:A3*2', B3: 99 }) as {
    cells: Record<string, { v?: unknown }>
  }
  ok(src.cells.B3.v === 99, 'the value in the way is still 99')

  const byFormula = one({ A1: 10, A2: 20, A3: 30, B1: '=A1:A3*2', B2: '=1+1' })
  ok(code(val(byFormula, 'B1')) === '#SPILL!', 'another FORMULA in the way blocks it too')
  ok(val(byFormula, 'B2') === 2, 'and that formula goes on computing its own answer')

  // Clear the obstruction and it works again — the anchor kept its formula.
  const cleared = one({ A1: 10, A2: 20, A3: 30, B1: '=A1:A3*2' })
  ok(val(cleared, 'B3') === 60, 'clearing the obstruction restores the spill')
}

// A cell that carries only APPEARANCE is empty. Excel spills through one, and
// treating a background colour as an obstruction would make a formatted sheet
// mysteriously refuse to spill anywhere.
{
  const sheet = canvas('S', { A1: 10, A2: 20, B1: '=A1:A2*2' }) as {
    cells: Record<string, unknown>
  }
  sheet.cells.B2 = { bg: '#eee', bold: true }
  const r = recalcWorkbook(workbookSources({ sheets: [sheet] } as never)).get('s')!
  ok(val(r, 'B2') === 40, 'a cell holding only formatting does not block a spill')
}

// --- 4. two spills, one deterministic answer ----------------------------------

console.log('\ntwo spills that want the same cell')
{
  // NEITHER anchor sits in the other's footprint — if one did, it would simply
  // be an occupied cell and reading order would never come into it. A5 spills
  // A5:B6 (2×2) and B4 spills B4:B5; they meet at B5 and nowhere else.
  const at: Lit = { A1: 1, B1: 2, A2: 3, B2: 4, B4: '=A1:A2*100', A5: '=A1:B2*10' }
  const r = one(at)
  ok(val(r, 'B4') === 100 && val(r, 'B5') === 300,
    'the TOP-MOST anchor keeps its spill — B4 is a row above A5')
  ok(code(val(r, 'A5')) === '#SPILL!', 'the lower one is refused')
  ok(val(r, 'A6') === null && val(r, 'B6') === null,
    'and places NOTHING — not even the cells of it that did not overlap')

  // Same document, cells enumerated in the opposite order. A sparse map's key
  // order is a fact about edit history, not about the sheet, so it must not
  // decide who wins — under collaboration two replicas would disagree about
  // which number is on screen and neither would be able to tell.
  const flipped: Lit = {}
  for (const k of Object.keys(at).reverse()) flipped[k] = at[k]
  const r2 = one(flipped)
  ok(val(r2, 'B5') === 300 && code(val(r2, 'A5')) === '#SPILL!',
    'and the same one wins when the cell map enumerates in the other order')

  // A formula standing in the path is an OCCUPIED cell, which is a different
  // rule and an earlier one: it blocks whatever reading order would have said.
  const overFormula = one({ A1: 1, A2: 2, A3: 3, B1: '=A1:A3*10', B3: '=A1:A3*100' })
  ok(code(val(overFormula, 'B1')) === '#SPILL!' && val(overFormula, 'B5') === 300,
    'a formula in the way blocks the spill that would have covered it, top-most or not')
}

// --- 5. spilled output is data ------------------------------------------------

console.log('\nreading what a spill produced')
{
  const r = one({ A1: 10, A2: 20, A3: 30, B1: '=A1:A3*2', D1: '=B3+1', E1: '=SUM(B1:B3)' })
  ok(val(r, 'D1') === 61,
    'a formula reading a SPILLED cell sees 60, not the blank that is stored there')
  ok(val(r, 'E1') === 120,
    'and a range over the spill totals all three — the clip has to follow the spill out')

  // The ordering is the point: D1 must be evaluated AFTER B1. Reversed, it
  // reads a blank and reports 1, which looks like an answer.
  const order = r.order
  ok(order.indexOf(K('B1')) < order.indexOf(K('D1')),
    'the anchor is ordered before its reader, which is what the fixed point buys')
}

// A spill that feeds itself never settles, and is told so rather than handed
// whichever size the last iteration happened to hold.
{
  const r = one({ A1: '=B3+1', A2: 20, A3: 30, B1: '=A1:A3*2' })
  const a = val(r, 'A1')
  const b = val(r, 'B1')
  ok(isErr(a) || isErr(b),
    'a circle drawn through a spilled cell is reported, not resolved to a number')
  ok(String(a) === '#CYCLE!' || String(b) === '#CYCLE!' || String(b) === '#SPILL!',
    'and reported as a circle or a refused spill, both of which a reader can act on')
}

// --- 6. shape ------------------------------------------------------------------

console.log('\na rectangle stays a rectangle')
{
  const r = one({ A1: 1, B1: 2, C1: 3, A2: 4, B2: 5, C2: 6, A4: '=A1:C2*10' })
  ok(val(r, 'A4') === 10 && val(r, 'B4') === 20 && val(r, 'C4') === 30,
    '=A1:C2*10 fills the first row across')
  ok(val(r, 'A5') === 40 && val(r, 'B5') === 50 && val(r, 'C5') === 60,
    'and the second row below it')
  ok(val(r, 'A6') === null,
    'six values as 2×3, NOT as a column of six — the failure is right in cell one')
  ok(r.spills.get(K('A4'))?.rows === 2 && r.spills.get(K('A4'))?.cols === 3,
    'and the claim records the shape the grid has to outline')
}

// --- 7. the refusals that are about size --------------------------------------

console.log('\nresults too big to place')
{
  /** A dense virtual sheet — no allocation, so the cap can be tested at scale. */
  const wide = (rows: number, anchor: { row: number; col: number }, f: string): CellSource => ({
    rows,
    cols: 4,
    spill: true,
    formulaAt: (r, c) => (r === anchor.row && c === anchor.col ? f : undefined),
    valueAt: (r, c) => (c === 0 ? r + 1 : null),
    formulaCells: () => [{ row: anchor.row, col: anchor.col, src: f }],
  })

  const t0 = Date.now()
  const big = recalcCells(wide(200_000, { row: 0, col: 1 }, '=A1:A200000*2'))
  const ms = Date.now() - t0
  ok(code(big.values.get(cellKey(0, 1)) ?? null) === '#SPILL!',
    `a ${200_000}-cell result is refused — past SPILL_CELL_MAX (${SPILL_CELL_MAX})`)
  ok(big.spills.size === 0, 'and places nothing')
  ok(ms < 5000, `and refuses promptly rather than hanging (${ms}ms)`)

  // Off the bottom of the sheet. The anchor sits three rows from the last
  // addressable one and the result is ten long.
  const edge = recalcCells(wide(1_048_576, { row: 1_048_573, col: 1 }, '=A1:A10*2'))
  ok(code(edge.values.get(cellKey(1_048_573, 1)) ?? null) === '#SPILL!',
    'a result that would run off the bottom of the sheet is refused')
}

// --- 8. NOT on a dataset --------------------------------------------------------

console.log('\nthe dataset kind does not spill')
{
  // `=amount*2` over a 3-row column IS an array. On a spreadsheet it would
  // spill; on a dataset the answer is the first value, because the columnar
  // answer to this need is a column formula and there is nowhere for a
  // rectangle to land on a sheet that is exactly as long as its rows.
  const t = {
    id: 'sales', name: 'Sales', kind: 'table',
    rids: [[1, 3]],
    columns: [{ id: 'amount', name: 'amount', type: 'number' }],
    data: { amount: { enc: 'raw', v: [10, 20, 30] } },
    cells: { 'amount:1': { f: '=amount*2' } },
    steps: [],
  }
  const r = recalcWorkbook(workbookSources({ sheets: [t] } as never)).get('sales')!
  ok(r.values.get(cellKey(0, 0)) === 20, 'a dataset cell formula still returns its first value')
  ok(r.spills.size === 0,
    'and claims nothing — see docs/dash-sheet-kinds.md: a column formula IS the spill')

  // The engine is not simply incapable of it: the same expression against a
  // source that DOES spill produces three values. The difference is the kind.
  const src: CellSource = {
    rows: 3, cols: 2, spill: true,
    formulaAt: (r2, c) => (r2 === 0 && c === 1 ? '=A1:A3*2' : undefined),
    valueAt: (r2, c) => (c === 0 ? (r2 + 1) * 10 : null),
  }
  ok(recalcCells(src).values.get(cellKey(2, 1)) === 60,
    'the same engine spills where the sheet kind allows it — the refusal is a decision')
}

// --- 9. the shape a caller reads ------------------------------------------------

console.log('\nwhat a painter needs to know')
{
  const r = one({ A1: 1, A2: 2, A3: 3, D1: '=A1:A3*2' })
  const ext = spillExtent(r)
  ok(ext.rows === 3 && ext.cols === 4,
    'spillExtent reaches to the last spilled cell, so the grid rules that far')
  ok(spillExtent(one({ A1: 1 })).rows === 0, 'and is zero when nothing spilled')

  const direct = evalCellArray('=A1:A3*2', () => 5, {
    scope: {
      has: () => false,
      clip: (rg) => rg,
    },
  })
  ok(direct.rows === 3 && direct.cols === 1 && direct.cells?.length === 3,
    'evalCellArray reports the shape without a sheet under it')
  ok(evalCellArray('=1+1', () => null).cells === undefined,
    'and a scalar allocates no array at all')
}

// --- 10. THE OUTCOME: what the grid paints ----------------------------------
//
// Everything above is the engine. This is the app. `Grid.cvValueAt` decides
// what a cell SHOWS, and a spilled cell holds nothing in the document — so if
// the grid does not consult the computed map for a cell it has no entry for,
// the reader sees one number and nine blanks and every check above passes.

console.log('\nwhat the grid actually paints')

function mount(doc: DashDoc) {
  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const grid = new Grid({ el: host as never, store: new Store(doc), sheetId: 'cv1' })
  const scroll = host.querySelector('.dg-scroll')!
  scroll.clientHeight = 600
  scroll.clientWidth = 900
  grid.paint()
  return host
}

const sheetDoc = (cells: Record<string, unknown>): DashDoc => {
  const p = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
    sheets: [{ id: 'cv1', name: 'Model', kind: 'canvas', cells }],
  }))
  if (!p.ok) throw new Error(`fixture: ${JSON.stringify(p.findings)}`)
  return p.doc
}

const shown = (host: { querySelector(s: string): { text: string } | null }, a: string): string =>
  host.querySelector(`[data-key="${a}"] .dg-v`)?.text ?? '(not painted)'

{
  const host = mount(sheetDoc({
    A1: { v: 10 }, A2: { v: 20 }, A3: { v: 30 }, B1: { f: '=A1:A3*2' },
  }))
  ok(shown(host as never, 'B1') === '20', 'the anchor paints its first value')
  ok(shown(host as never, 'B2') === '40' && shown(host as never, 'B3') === '60',
    'and the spilled cells paint theirs — this is the check the whole feature is for')
  ok(shown(host as never, 'B4') === '', 'and the cell past the end stays blank')
}

{
  const host = mount(sheetDoc({
    A1: { v: 10 }, A2: { v: 20 }, A3: { v: 30 }, B1: { f: '=A1:A3*2' }, B3: { v: 99 },
  }))
  ok(shown(host as never, 'B1') === '#SPILL!', 'a blocked spill paints #SPILL! in the anchor')
  ok(shown(host as never, 'B2') === '', 'nothing is placed')
  ok(shown(host as never, 'B3') === '99', 'and the cell in the way still shows what it held')
}

{
  // The extent check, and the reason `spillExtent` exists: a spill longer than
  // the grid's frontier past the used range must still be ruled and painted.
  const host = mount(sheetDoc({
    A1: { v: 1 }, C1: { f: '=SEQUENCE_STANDIN' }, B1: { f: '=A1:A1*2' },
  }))
  ok(shown(host as never, 'B1') === '2', 'a one-cell array is just a value')
  ok(shown(host as never, 'C1') === '#NAME?', 'and an unknown function is still #NAME?')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
