#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash DEFINED NAMES — `=B4*TaxRate`, `=SUM(Q3Sales)`.
//
//   node scripts/test-dash-names.ts
//
// WHAT THIS PROVES. A name is a redirection, and every way a redirection can go
// wrong here produces a NUMBER rather than a complaint. That is the whole
// reason for the checks below, and each one constructs the case where a
// plausible implementation quietly reports the wrong figure:
//
//   SUBSTITUTED IN THE WRONG PLACE   a name inside "quoted text", inside a
//                                    [bracketed column], in front of a `(`, or
//                                    after a sheet's `!` is not a name. Reading
//                                    `Sheet1!Total` as the name `Total` and
//                                    splicing a range into it fabricates
//                                    `Sheet1!A1:A5` — a reference to a sheet
//                                    the author never named, and it evaluates.
//   INVISIBLE TO THE ORDERING        a name bound straight to a vector would
//                                    not be a dependency, so `TaxRate` pointing
//                                    at a COMPUTED cell would read whatever
//                                    that cell held before this recalculation.
//                                    Substitution puts it in the graph; this
//                                    rig is what says so.
//   UNREACHABLE BY CONSTRUCTION      `TAX1` parses as a cell address, so a name
//                                    spelled that way is accepted, saved, and
//                                    never once consulted. Refused at the point
//                                    of definition, which is the only place a
//                                    person can be told.
//   SHADOWED THE WRONG WAY           a dataset sheet's `SUM(amount)` already
//                                    binds `amount`. A document-level name that
//                                    outranked it would silently re-point a
//                                    working column formula at other data.
//   DROPPED INSTEAD OF BROKEN        deleting the rows a name covers must give
//                                    `#REF!` at every use and LEAVE the
//                                    definition in place. Deleting the entry
//                                    reports `#NAME?` — "you never defined
//                                    that" — which is a lie about what happened
//                                    and gives the reader nothing to repoint.
//   NOT ACTUALLY WIRED UP            the last two checks mount the REAL grid on
//                                    a REAL document and read the painted
//                                    markup. An engine that resolves names
//                                    perfectly while the app never passes the
//                                    name table is a feature nobody can see.

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

const {
  cellKey, documentNames, expandNames, nameText, recalcWorkbook, shiftDefinedNames,
  validateDefinedName, workbookSources,
} = await import('../dash/src/cellformula.ts')
const { isErr } = await import('../dash/src/formula.ts')
const { mapNames, isNameLike } = await import('../dash/src/a1.ts')
const { parseDoc } = await import('../dash/src/model.ts')
const { Store } = await import('../dash/src/store.ts')
const { Grid } = await import('../dash/src/grid.ts')
type Cell = import('../dash/src/formula.ts').Cell
type DashDoc = import('../dash/src/model.ts').DashDoc
type DefinedName = import('../dash/src/model.ts').DefinedName

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// --- fixtures ----------------------------------------------------------------

const A1 = (a: string): { row: number; col: number } => {
  const m = /^([A-Z]+)(\d+)$/.exec(a)!
  let col = 0
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(m[2]) - 1, col: col - 1 }
}
const K = (a: string): string => { const p = A1(a); return cellKey(p.row, p.col) }

/** A spreadsheet sheet from an A1 literal — a leading `=` makes it a formula. */
function canvas(name: string, at: Record<string, string | number>): unknown {
  const cells: Record<string, unknown> = {}
  for (const [a, v] of Object.entries(at)) {
    cells[K(a)] = typeof v === 'string' && v.startsWith('=') ? { f: v } : { v }
  }
  return { id: name.toLowerCase(), name, kind: 'canvas', cells }
}

const dataset = (name: string, cols: string[], rows: unknown[][]): unknown => ({
  id: name.toLowerCase(),
  name,
  kind: 'table',
  rids: [[1, rows.length]],
  columns: cols.map((c) => ({ id: c.toLowerCase(), name: c, type: 'number' })),
  data: Object.fromEntries(cols.map((c, i) => [
    c.toLowerCase(), { enc: 'raw', v: rows.map((r) => r[i]) },
  ])),
  steps: [],
})

interface Book { names?: Record<string, DefinedName>; sheets: unknown[] }
const run = (b: Book) => recalcWorkbook(workbookSources(b as never))
const at = (b: Book, sheet: string, a: string): Cell =>
  run(b).get(sheet.toLowerCase())!.values.get(K(a)) ?? null
const code = (v: Cell): string => (isErr(v) ? String(v) : `not an error (${JSON.stringify(v)})`)

// --- 1. a name stands in for a number ----------------------------------------

console.log('\na name stands in for a number')
{
  const b: Book = {
    names: { TaxRate: { v: 0.2 } },
    sheets: [canvas('S', { B4: 250, C1: '=B4*TaxRate' })],
  }
  ok(at(b, 'S', 'C1') === 50, '=B4*TaxRate is 50 where TaxRate is 0.2')

  // One edit moves every use. That is the reason to have names at all, so it
  // is asserted rather than assumed.
  b.names!.TaxRate = { v: 0.1 }
  ok(at(b, 'S', 'C1') === 25, 'editing the definition moves the result')

  const undef = at({ names: {}, sheets: [canvas('S', { B4: 250, C1: '=B4*TaxRate' })] }, 'S', 'C1')
  ok(code(undef) === '#NAME?', 'an UNDEFINED name is #NAME?, never blank and never zero')
}

// A negative literal has to bind as a VALUE. `=2^Rate` with Rate = -2 read as
// text becomes `2^-2` — which happens to be right — but `=10-Rate` becomes
// `10--2`; the parenthesised form is the one that cannot be argued with.
{
  const b: Book = { names: { Rate: { v: -2 } }, sheets: [canvas('S', { A1: '=10-Rate' })] }
  ok(at(b, 'S', 'A1') === 12, 'a NEGATIVE constant substitutes as a value: 10 - (-2) = 12')
}
{
  const b: Book = {
    names: { Label: { v: 'He said "no"' } },
    sheets: [canvas('S', { A1: '=Label' })],
  }
  ok(at(b, 'S', 'A1') === 'He said "no"',
    'a text constant holding a quote cannot terminate its own string literal')
}

// --- 2. a name stands in for a RANGE ------------------------------------------

console.log('\na name stands in for a range')
{
  const b: Book = {
    names: { Q3Sales: { ref: "'Q3 pipeline'!A1:A3" } },
    sheets: [
      canvas('Q3 pipeline', { A1: 10, A2: 20, A3: 30 }),
      canvas('Report', { B1: '=SUM(Q3Sales)', B2: '=COUNT(Q3Sales)' }),
    ],
  }
  ok(at(b, 'Report', 'B1') === 60, 'SUM over a named range totals the cells it covers')
  ok(at(b, 'Report', 'B2') === 3, 'and the range keeps its LENGTH — COUNT is 3, not 1')
}

// THE ORDERING CHECK. `Total` points at a cell that is itself computed. A name
// bound directly to a value would be invisible to the dependency graph and read
// whatever was there first; substitution makes it an ordinary edge.
{
  const b: Book = {
    names: { Total: { ref: 'A9' } },
    sheets: [canvas('S', { A1: 5, A9: '=A1*100', B1: '=Total+1' })],
  }
  ok(at(b, 'S', 'B1') === 501,
    'a name pointing at a COMPUTED cell is ordered after it — 501, not 1')
}

// --- 3. what is NOT a name ----------------------------------------------------

console.log('\nwhat a name is not')
{
  const names = { Total: { ref: 'A1:A3' }, TaxRate: { v: 0.2 } }
  const scope = documentNames(names)
  const same = (src: string) => mapNames(src, (w) => scope.lookup(w) ?? w) === src

  ok(same('"Total is here"'), 'a name inside a quoted string is text, not a reference')
  ok(same('[Total]'), 'a [bracketed name] is the column escape and is left alone')
  ok(same('Total(1)'), 'a name followed by ( is a call')
  ok(same('Total[Col]'), 'a name followed by [ qualifies a structured reference')
  // The fabrication case: `Sheet1!Total` must not become `Sheet1!A1:A3`.
  ok(same('Sheet1!Total'), 'a word after a sheet qualifier belongs to the qualifier')
  ok(mapNames('SUM(a1 : b2)', (w) => scope.lookup(w) ?? w) === 'SUM(a1 : b2)',
    'a name-only walk returns every reference exactly as the author wrote it')
  ok(mapNames('=B4*TaxRate', (w) => scope.lookup(w) ?? w) === '=B4*(0.2)',
    'and it does substitute the one word that IS a name')
}

// --- 4. a name spelled like a cell is unreachable, so it is refused -----------

console.log('\na name that could never be reached')
{
  ok(validateDefinedName('TAX1') === 'cellshaped',
    'TAX1 is refused: a1.ts resolves it as a cell long before the name table')
  ok(validateDefinedName('Q3') === 'cellshaped', 'so is Q3')
  ok(validateDefinedName('TaxRate') === null, 'TaxRate is fine')
  ok(validateDefinedName('REVENUE2024') === null,
    'REVENUE2024 is a name — past a1.ts’s three-letter fence, so not an address')
  ok(validateDefinedName('') === 'empty', 'blank is refused')
  ok(validateDefinedName('two words') === 'shape', 'a space is refused')
  ok(validateDefinedName('2024') === 'shape', 'a bare number is refused')
  ok(validateDefinedName('tax', { Tax: { v: 1 } }) === 'taken',
    'a spelling that differs only in case is taken — lookup is case-insensitive')
  ok(validateDefinedName('Tax', { Tax: { v: 1 } }) === null,
    'and renaming a name to itself is not a collision')
  ok(isNameLike('TAX1') === false && isNameLike('TaxRate'), 'isNameLike agrees')

  // Refusing at the UI is not enough — a hand-edited file can hold one.
  const b: Book = { names: { TAX1: { v: 9 } }, sheets: [canvas('S', { A1: 1, TAX1: 7 } as never)] }
  ok(documentNames(b.names).lookup('TAX1') === undefined,
    'a cell-shaped entry in the file is dropped from the table, not half-honoured')
}

// --- 5. a column wins ---------------------------------------------------------

console.log('\na column name beats a document name')
{
  const b: Book = {
    names: { amount: { v: 999 } },
    sheets: [dataset('Sales', ['amount'], [[10], [20], [30]])],
  }
  const t = b.sheets[0] as { cells?: Record<string, unknown> }
  t.cells = { 'amount:1': { f: '=SUM(amount)' } }
  ok(at(b, 'Sales', 'A1') === 60,
    'SUM(amount) on a dataset still means the COLUMN, not the 999 someone named')

  // And the same word on a sheet with no such column resolves to the name.
  const b2: Book = { names: { amount: { v: 999 } }, sheets: [canvas('S', { A1: '=amount' })] }
  ok(at(b2, 'S', 'A1') === 999, 'on a sheet with no column of that name, the name applies')
}

// --- 6. chains and circles ----------------------------------------------------

console.log('\nnames made of names')
{
  const b: Book = {
    names: { Net: { ref: 'A1' }, Gross: { v: 1.2 }, Total: { ref: 'Net' } },
    sheets: [canvas('S', { A1: 100, B1: '=Total*Gross' })],
  }
  ok(at(b, 'S', 'B1') === 120, 'a name defined in terms of another name resolves')

  const loop: Book = {
    names: { A: { ref: 'B' }, B: { ref: 'A' } },
    sheets: [canvas('S', { C1: '=A' })],
  }
  ok(code(at(loop, 'S', 'C1')) === '#CYCLE!',
    'two names defined in terms of each other is #CYCLE!, never a partial expansion')

  const self: Book = { names: { X: { ref: 'X+1' } }, sheets: [canvas('S', { C1: '=X' })] }
  ok(code(at(self, 'S', 'C1')) === '#CYCLE!', 'and a name defined in terms of itself')

  // Two occurrences of ONE name at one depth is not a cycle, which is the bug a
  // naive "have I seen this name" guard produces.
  const twice: Book = { names: { X: { v: 2 } }, sheets: [canvas('S', { C1: '=X+X' })] }
  ok(at(twice, 'S', 'C1') === 4, '=X+X is 4 — the same name twice is not a circle')

  ok(expandNames('=A1').expr === '=A1' && expandNames('=A1').cycle === undefined,
    'a document with no names is not walked at all')
}

// --- 7. a deleted target is #REF!, and the name survives ----------------------

console.log('\nwhen the cells a name covers are deleted')
{
  const names: Record<string, DefinedName> = {
    Q3Sales: { ref: 'A2:A4', note: 'agreed with finance' },
    Pinned: { ref: '$A$8' },
    Rate: { v: 0.2 },
  }
  // Rows 1..3 (0-based) removed — the whole of A2:A4.
  const gone = shiftDefinedNames(names, 'row', 1, -3)
  const map = new Map(gone)
  ok(map.get('Q3Sales') === '#REF!', 'a name whose whole target was deleted becomes #REF!')
  ok(map.get('Pinned') === '$A$5', 'a $-pinned name MOVES — the cell it names physically moved')
  ok(!map.has('Rate'), 'a name that is a constant is not touched by a structural edit')

  // The definition SURVIVES. This is the honesty rule, and the reason the
  // rewrite returns changed refs instead of deleting entries.
  for (const [k, ref] of gone) names[k] = { ...names[k], ref }
  ok('Q3Sales' in names && names.Q3Sales.note === 'agreed with finance',
    'the entry stays in the table, note and all, ready to be repointed')

  const b: Book = { names, sheets: [canvas('S', { B1: '=SUM(Q3Sales)' })] }
  ok(code(at(b, 'S', 'B1')) === '#REF!',
    'every use reports #REF! — "the cells you named are gone", not "#NAME?"')

  // A partial deletion SHRINKS, exactly as a written range does.
  const part = new Map(shiftDefinedNames({ Q: { ref: 'A2:A10' } }, 'row', 1, -3))
  ok(part.get('Q') === 'A2:A7', 'deleting three rows out of the middle shrinks the name')
}

// A name pointing at a deleted SHEET is the same class of failure.
{
  const b: Book = {
    names: { Pipeline: { ref: "'Q3 pipeline'!A1:A3" } },
    sheets: [canvas('Report', { B1: '=SUM(Pipeline)' })],
  }
  ok(code(at(b, 'Report', 'B1')) === '#REF!',
    'a name pointing at a sheet that is not there is #REF!, never a blank')
}

// --- 8. spellings ------------------------------------------------------------

console.log('\nspelling and definition shape')
{
  const b: Book = { names: { TaxRate: { v: 0.2 } }, sheets: [canvas('S', { A1: '=taxrate*10' })] }
  ok(at(b, 'S', 'A1') === 2, 'lookup is case-insensitive, as Excel matches')

  ok(nameText({ ref: 'A1:A3', v: 5 }) === 'A1:A3',
    'a definition holding BOTH takes the reference — the more specific reading')
  ok(nameText({}) === undefined, 'a definition holding neither defines nothing')
  ok(nameText({ v: Number.NaN }) === undefined, 'and NaN is not a number to substitute')
}

// --- 9. THE OUTCOME: the real grid, on a real document ------------------------
//
// Everything above proves the engine. This proves the APP: `Grid.cvRefresh`
// calls `workbookSources(this.store.doc)`, so the document's name table has to
// reach the recalculation without anyone passing it by hand. An engine that is
// right while the caller never wires it up is a feature nobody can see, and
// that is exactly the failure this block exists to catch.

console.log('\nwhat the grid actually paints')

function mount(doc: DashDoc) {
  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const store = new Store(doc)
  const grid = new Grid({ el: host as never, store, sheetId: 'cv1' })
  const scroll = host.querySelector('.dg-scroll')!
  scroll.clientHeight = 600
  scroll.clientWidth = 900
  grid.paint()
  return { host, store, grid }
}

/** What one cell of the painted sheet SHOWS, by its A1 key. */
const shown = (host: { querySelector(s: string): { text: string } | null }, a: string): string =>
  host.querySelector(`[data-key="${a}"] .dg-v`)?.text ?? '(not painted)'

{
  const parsed = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
    names: { TaxRate: { v: 0.2 }, Subtotal: { ref: 'A1' } },
    sheets: [{
      id: 'cv1', name: 'Invoice', kind: 'canvas',
      cells: { A1: { v: 250 }, B1: { f: '=A1*TaxRate' }, C1: { f: '=Subtotal+B1' } },
    }],
  }))
  ok(parsed.ok, 'the fixture parses')
  ok(!!(parsed.doc as { names?: unknown }).names,
    'parseDoc carries the name table through — a stripped table would be silent')

  const { host } = mount(parsed.doc)
  ok(shown(host as never, 'B1') === '50',
    'the grid paints 50 for =A1*TaxRate — the name reached the recalculation')
  ok(shown(host as never, 'C1') === '300',
    'and 300 for =Subtotal+B1, so a named REFERENCE reaches it too')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
