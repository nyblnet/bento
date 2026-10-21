#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash TYPED-ENTRY rig — what a spreadsheet cell IS after somebody types
// into it, and what the formula engine then does with it.
//
//   node scripts/test-dash-entryparse.ts
//
// WHY THIS EXISTS. Review finding 3.1, measured in the built shell: on a
// spreadsheet sheet, typing 10, $5 and 15% and then =SUM over them said 30,
// =G13*G15 said 150, and COUNT said 3. Excel, Sheets and Numbers say 15.15,
// 1.5 and 3. Two faults stacked: typing stored "15%" and "$5" as TEXT (grid.ts
// had its own narrow reader, and the format-aware `coerceInput` in cellprops.ts
// was written, tested, and never wired), and the formula engine then read that
// text by stripping every `%`, `$` and `,` it could find — so the text "15%"
// was the number 15. Each section below has a check that FAILS on that code.
//
// Also guarded: 3.2 (ISO and named-month dates, currency that keeps its
// symbol, accounting negatives), 2.8 (the formula bar shows `100%`, not `1`),
// and 3.4 (a formula that does not parse is refused at entry, not committed).

import { registerHooks } from 'node:module'
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { installDom } = await import('./lib/dash-dom.ts')
const dom = installDom()
// Every reader is reached through the module NAMESPACE, with the old code's
// behaviour as the fallback, so this rig RUNS on the code before the fix and
// fails there check by check rather than at an import.
const CP: Record<string, any> = await import('../dash/src/cellprops.ts')
const GR: Record<string, any> = await import('../dash/src/grid.ts')
const IM: Record<string, any> = await import('../dash/src/import.ts')
type CanvasCellT = import('../dash/src/model.ts').CanvasCell
/** what TYPING does — the function the grid's editors call, not a helper beside it */
const coerceInput = (prev: CanvasCellT | undefined, text: string): CanvasCellT | null => GR.canvasCellEdit(prev, text)
/** what the formula bar shows; before 2.8 it was String(v) */
const enteredForm = (c: CanvasCellT | undefined): string =>
  CP.enteredForm ? CP.enteredForm(c) : (c?.v == null ? '' : String(c.v))
const { inferColumn } = IM
const readEntryNumber = (s: string) => (IM.readEntryNumber ? IM.readEntryNumber(s) : null)
const { setViewerLocale } = await import('../dash/src/format.ts')
const { recalcCells, canvasCellSource, cellKey, evalCell } = await import('../dash/src/cellformula.ts')
const { isErr } = await import('../dash/src/formula.ts')
const { parseDoc } = await import('../dash/src/model.ts')
const { Store } = await import('../dash/src/store.ts')
const { Grid, canvasShown } = GR
const formulaRefusal = (src: string): string | null => (GR.formulaRefusal ? GR.formulaRefusal(src) : null)
const { starterDoc } = await import('../dash/src/starter.ts')
type CanvasCell = import('../dash/src/model.ts').CanvasCell
type CanvasSheet = import('../dash/src/model.ts').CanvasSheet

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const show = (v: unknown) => (v === undefined ? 'undefined' : JSON.stringify(v))

setViewerLocale('en-US')

// ===================================================================== 1
console.log('\n1. what typing stores — value and format (findings 3.1, 3.2)')
{
  // [typed, stored value, stamped format]
  const table: Array<[string, unknown, string | undefined]> = [
    ['10', 10, undefined],
    ['15%', 0.15, '0%'],
    ['12.5%', 0.125, '0.0%'],
    ['100%', 1, '0%'],
    ['$5', 5, '$#,##0'],
    ['$300.50', 300.5, '$#,##0.00'],
    ['£1,234', 1234, '£#,##0'],
    ['€3,50', 3.5, '€#,##0.00'],          // decimal comma: `,50` cannot be a thousands group
    ['($1,200.50)', -1200.5, '$#,##0.00'],
    ['(5)', -5, undefined],                // accounting negative, no mark → no format
    ['-$5', -5, '$#,##0'],
    ['1,200', 1200, undefined],            // a separator is not a mark (rule 5)
    ['1e3', 1000, undefined],
    ['2026-03-04', '2026-03-04', 'yyyy-mm-dd'],
    ['Mar 4 2026', '2026-03-04', 'yyyy-mm-dd'],
    ['4 March 2026', '2026-03-04', 'yyyy-mm-dd'],
    ['March 4, 2026', '2026-03-04', 'yyyy-mm-dd'],
    ['3/4/2026', '3/4/2026', undefined],   // THE refusal: 3 April or 4 March
    ['13/4/2026', '13/4/2026', undefined], // a slash date stays text from typing (readEnteredDate)
    ['2026-02-31', '2026-02-31', undefined], // no such day
    ['007', '007', undefined],             // rule 3: the zeros are the information
    ["'15%", '15%', undefined],            // rule 2: the apostrophe
    ['TRUE', true, undefined],
    ['north', 'north', undefined],
    ['15 %', 0.15, '0%'],
  ]
  for (const [typed, v, fmt] of table) {
    const c = coerceInput(undefined, typed)
    ok(c !== null && c.v === v && c.format === fmt,
      `"${typed}" → v=${show(v)} format=${show(fmt)}   (got v=${show(c?.v)} format=${show(c?.format)})`)
  }
  // a cell that already SAYS what it is
  ok(coerceInput({ format: 'yyyy-mm-dd' }, '13/4/2026')?.v === '2026-04-13',
    'in a cell formatted Date, an unambiguous slash date IS read (rule 8)')
  ok(coerceInput({ format: 'yyyy-mm-dd' }, '3/4/2026')?.v === '3/4/2026',
    '…and an ambiguous one is still refused, even there')
  ok(coerceInput({ format: '#,##0.00' }, 'Mar 4 2026')?.v === 'Mar 4 2026' &&
    coerceInput({ format: '#,##0.00' }, 'Mar 4 2026')?.format === '#,##0.00',
    'a date typed into a NUMBER-formatted cell does not overwrite the format somebody chose')
  ok(coerceInput({ format: '@' }, '15%')?.v === '15%', 'the Text format is absolute (rule 1)')
  ok(coerceInput({ format: '0%' }, '15')?.v === 0.15, 'a bare 15 in a percent cell is 15%')
}

// ===================================================================== 2
console.log('\n2. the viewer\'s decimal convention — only where the field cannot say')
{
  setViewerLocale('de-DE')
  ok(coerceInput(undefined, '1,234')?.v === 1.234, 'de: "1,234" is 1,234 — one point two three four')
  ok(coerceInput(undefined, '1.234')?.v === 1234, 'de: "1.234" is one thousand two hundred and thirty-four')
  ok(coerceInput(undefined, '3,50 €')?.v === 3.5 && coerceInput(undefined, '3,50 €')?.format === '€#,##0.00',
    'de: "3,50 €" is 3.5 euros, the symbol kept')
  ok(coerceInput(undefined, '1.5')?.v === 1.5, 'de: "1.5" reads under only one convention, so it is 1.5')
  setViewerLocale('en-GB')
  ok(coerceInput(undefined, '1,234')?.v === 1234, 'en: "1,234" is 1234')
  ok(coerceInput(undefined, '3,50')?.v === 3.5, 'en: "3,50" is still 3.5 — it fits only the comma convention, as on import')
  setViewerLocale('en-US')
  // the SAME digit shapes import votes with — one reader, not two
  ok(inferColumn(['€3,50']).parsed === 'comma' && readEntryNumber('€3,50')?.n === 3.5,
    'import infers "€3,50" as the comma convention, and the entry reader reads it as 3.5 — the same code')
}

// ===================================================================== 3
console.log('\n3. arithmetic over what was TYPED — the review\'s exact case')
{
  const sheet = { cells: {} as Record<string, CanvasCell> }
  const type = (key: string, text: string) => { const c = coerceInput(sheet.cells[key], text); if (c) sheet.cells[key] = c }
  type('G13', '10'); type('G14', '$5'); type('G15', '15%')
  type('G16', '=SUM(G13:G15)'); type('G17', '=G13*G15'); type('G18', '=COUNT(G13:G15)'); type('G19', '=G13+G14')
  const r = recalcCells(canvasCellSource(sheet as Pick<CanvasSheet, 'cells'>))
  const at = (row: number) => r.values.get(cellKey(row, 6))
  ok(Math.abs((at(15) as number) - 15.15) < 1e-12, `=SUM over 10, $5, 15% is 15.15 (got ${String(at(15))}; the review measured 30)`)
  ok(Math.abs((at(16) as number) - 1.5) < 1e-12, `=G13*G15 is 1.5 (got ${String(at(16))}; the review measured 150)`)
  ok(at(17) === 3, `=COUNT over them is 3 (got ${String(at(17))})`)
  ok(at(18) === 15, `=G13+G14 is 15 (got ${String(at(18))})`)
}

// ===================================================================== 4
console.log('\n4. text in arithmetic — Excel\'s rule (formula.ts, above `num`)')
{
  // A1..A6 hold TEXT, as a legacy file (or an apostrophe) leaves them
  const cells: Record<string, unknown> = { '0,0': 10, '1,0': '$5', '2,0': '15%', '3,0': 'abc', '4,0': true, '5,0': '5' }
  const read = (r: { row: number; col: number }) => (cells[`${r.row},${r.col}`] ?? null) as never
  const ev = (f: string) => evalCell(f, read)
  const num = (f: string, want: number) => {
    const got = ev(f)
    ok(typeof got === 'number' && Math.abs(got - want) < 1e-12, `${f} = ${want}   (got ${String(got)})`)
  }
  const err = (f: string, code: string) => {
    const got = ev(f)
    ok(isErr(got) && got.code === code, `${f} is ${code}   (got ${String(got)})`)
  }
  // rule 1: a range counts only its NUMBERS — numeric-looking text and booleans skipped
  num('=SUM(A1:A6)', 10)
  num('=COUNT(A1:A6)', 1)
  num('=AVERAGE(A1:A3)', 10)
  num('=MAX(A1:A3)', 10)
  num('=SUMIF(A1:A6,"<>x",A1:A6)', 10)
  // every argument, not just the first
  num('=SUM(1,2,3)', 6)
  num('=SUM(A1:A2,A1)', 20)
  // rule 2: a value written directly is coerced; one that will not read is #VALUE!
  num('=SUM("5",1)', 6)
  num('=SUM(TRUE,1)', 2)
  err('=SUM(1,"abc")', '#VALUE!')
  num('=COUNT(1,"abc","5")', 2)
  // rule 3: direct arithmetic coerces numeric text exactly
  num('=A1*A3', 1.5)
  num('=A1+A2', 15)
  num('=-A3', -0.15)
  num('=A6*2', 10)
  num('=A1+A5', 11)
  err('=A1+A4', '#VALUE!')
  err('=A4*1', '#VALUE!')
  num('="(5)"*1', -5)
  num('="1,234"+0', 1234)
  err('="2026-03-04"+1', '#VALUE!')
  err('="12abc"*1', '#VALUE!')       // never the digits that happened to be in it
  // postfix percent in a formula
  num('=10*15%', 1.5)
  num('=50%', 0.5)
  num('=2^50%*2^50%', 2)
}

// ===================================================================== 5
console.log('\n5. the formula bar shows what was ENTERED (finding 2.8), and it round-trips')
{
  for (const loc of ['en-US', 'de-DE']) {
    setViewerLocale(loc)
    const cases: Array<[string, string, string]> = loc === 'en-US'
      ? [['100%', '100%', '100%'], ['15%', '15%', '15%'], ['12.5%', '12.5%', '12.5%'], ['7%', '7%', '7%'],
        ['$300.50', '$300.50', '$300.50'], ['$5', '$5', '$5'], ['($1,200.50)', '-$1200.50', '($1,200.50)'],
        ['2026-03-04', '2026-03-04', '2026-03-04'], ['Mar 4 2026', '2026-03-04', '2026-03-04'],
        ['1,234.5', '1234.5', '1,234.5'], ['0.1', '0.1', '0.1'], ["'15%", "'15%", '15%'],
        ['TRUE', 'TRUE', '✓'], ['north', 'north', 'north']]
      : [['12,5%', '12,5%', '12,5 %'], ['1,234', '1,234', '1,234'], ['1.234', '1234', '1.234'], ['3,50 €', '€3,50', '€3,50']]
    for (const [typed, bar] of cases) {
      const cell = coerceInput(undefined, typed)!
      const shown = enteredForm(cell)
      const again = coerceInput(cell, shown)
      ok(shown === bar, `${loc}: typed "${typed}" → the bar shows "${bar}"   (got "${shown}")`)
      ok(again?.v === cell.v && again?.format === cell.format,
        `${loc}: …and pressing Enter on "${shown}" stores the same value again (${show(cell.v)})`)
    }
  }
  setViewerLocale('en-US')
  // binary noise must not leak into the bar
  const noisy = { v: 0.07, format: '0%' }
  ok(enteredForm(noisy) === '7%', `0.07 in a percent cell shows 7%, not 7.000000000000001% (got ${enteredForm(noisy)})`)
  const exact = { v: 0.1 + 0.2 }
  ok(coerceInput({}, enteredForm(exact))?.v === 0.1 + 0.2,
    'a value 15 digits cannot hold is shown with 17, so opening and closing the cell never changes it')
  // a legacy file's TEXT date reads as text in the bar, so nobody mistakes it for a date
  ok(enteredForm({ v: '2026-03-04' }) === "'2026-03-04",
    'a legacy unformatted "2026-03-04" TEXT wears the apostrophe that keeps it text')
  ok(canvasShown({ v: 0.15, format: '0%' }, 0.15) === '15%', 'and the CELL still reads 15% (the display is unchanged)')
}

// ===================================================================== 6
console.log('\n6. a formula that does not parse is refused at entry (finding 3.4)')
{
  const refused: Array<[string, RegExp]> = [
    ['=A11+', /ends after “\+”/],
    ['=SUM(', /ends after “\(”|never closed/],
    ['=(1+2', /never closed/],
    ['=1 2', /“2” cannot go there/],
    ['=1+*2', /“\*” cannot go there/],
    ['=SUM(1,)', /“\)” cannot go there/],
    ['=A1:', /“:” cannot go there/],
    ['=A1)', /“\)” cannot go there/],
    ['=A1 B1', /“B1” cannot go there/],    // the reference is named as it was typed
  ]
  for (const [src, re] of refused) {
    const why = formulaRefusal(src)
    ok(why !== null && re.test(why), `${src} is refused   (${why ?? 'ACCEPTED'})`)
  }
  const fine = [
    '=SUM(A1:A3)', '=Pipeline!D1*2', "='My Sheet'!A1+1", '=IF(A1>1,"a","b")', '=-A1%',
    '=#REF!+1', '=A1&" x"', '=10*15%', '=$A$1+B$2', '=SUM(amount)', '=TODAY()', '=1', '=--A1',
    '=XLOOKUP(A1,B1:B9,C1:C9)', '=A1:B3*2', '="a, b) c"',
  ]
  for (const src of fine) ok(formulaRefusal(src) === null, `${src} is accepted   (${formulaRefusal(src) ?? 'ok'})`)
  // NO FALSE REFUSALS on real formulas: every formula the starter workbook ships
  const starter = starterDoc()
  const all: string[] = []
  for (const s of starter.sheets) {
    if (s.kind === 'canvas') for (const c of Object.values(s.cells)) if (typeof c?.f === 'string') all.push(c.f)
  }
  const bad = all.filter((f) => formulaRefusal(f) !== null)
  ok(all.length > 0 && bad.length === 0,
    `every one of the starter's ${all.length} spreadsheet formulas is accepted${bad.length ? ` — refused: ${bad.join(' | ')}` : ''}`)
}

// ===================================================================== 7
console.log('\n7. through the REAL editor and formula bar')
{
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
    sheets: [{ id: 'cv1', name: 'Scratch', kind: 'canvas', cells: { A1: { v: 10 }, B1: { v: 1, format: '0%' }, B2: { v: 300.5, format: '$#,##0.00' } } }],
  }))
  if (!r.ok) throw new Error('fixture')
  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const store = new Store(r.doc)
  const grid = new Grid({ el: host as never, store, sheetId: 'cv1' })
  const scroll = host.querySelector('.dg-scroll')!
  scroll.clientHeight = 600; scroll.clientWidth = 900
  grid.paint()
  const cells = () => (store.doc.sheets[0] as CanvasSheet).cells
  const key = (k: string) => ({ type: 'keydown', key: k, shiftKey: false, preventDefault() {}, stopPropagation() {} })
  const typeAt = (row: number, text: string, press = 'Enter') => {
    grid.sel.moveTo(row, 0); grid.paint()
    grid.typeInto(text[0])
    const cell = host.querySelector('.dg-cell.dg-editing')!
    cell.textContent = text
    cell.dispatchEvent(key(press))
    return cell
  }
  typeAt(1, '15%')
  ok(cells().A2?.v === 0.15 && cells().A2?.format === '0%', `typing 15% in the editor stores 0.15 with 0% (got ${show(cells().A2)})`)
  typeAt(2, '$300.50')
  ok(cells().A3?.v === 300.5 && cells().A3?.format === '$#,##0.00', `typing $300.50 stores 300.5 with a $ format (got ${show(cells().A3)})`)
  const ed = typeAt(3, '=A11+')
  ok(cells().A4 === undefined, 'typing =A11+ and pressing Enter commits NOTHING')
  ok(ed.classList.contains('dv-refused') && ed.contentEditable === 'true',
    '…the editor stays open, marked refused, with the text still in it')
  ok(dom.doc.body.querySelector('.dg-refuse-tip') !== null, '…and the reason is shown under it')
  ed.dispatchEvent(key('Escape'))
  ok(cells().A4 === undefined && dom.doc.body.querySelector('.dg-refuse-tip') === null,
    'Escape abandons it, and the message goes with it')
  typeAt(3, '=A1+A2')
  ok(cells().A4?.f === '=A1+A2', 'a formula that parses is committed as before')
  // the formula bar
  let bar = ''
  grid.onSelectionChange = (_s: string, _r: string, v: string) => { bar = v }
  grid.sel.moveTo(1, 0); grid.announce()
  ok(bar === '15%', `the formula bar over 0.15 (0%) reads "15%" (got "${bar}")`)
  grid.sel.moveTo(2, 0); grid.announce()
  ok(bar === '$300.50', `the formula bar over $300.50 reads "$300.50" (got "${bar}")`)
  // the review's own case: a cell STORED as 1 with a percent format (a file,
  // not a fresh typing) — the bar said 1
  grid.sel.moveTo(0, 1); grid.announce()
  ok(bar === '100%', `the formula bar over a stored 1 formatted 0% reads "100%", not "1" (got "${bar}")`)
  grid.sel.moveTo(1, 1); grid.announce()
  ok(bar === '$300.50', `the formula bar over a stored 300.5 formatted $#,##0.00 reads "$300.50" (got "${bar}")`)
  grid.sel.moveTo(5, 0)
  ok(typeof grid.setActiveCell('=SUM(') === 'string' && cells().A6 === undefined,
    'the formula bar refuses =SUM( too, and writes nothing')
  ok(grid.setActiveCell('=SUM(A1:A3)') === null && cells().A6?.f === '=SUM(A1:A3)',
    'and takes a formula that parses')
  // a TSV PASTE is read the way typing is
  grid.sel.moveTo(9, 2)
  grid.pasteTsv('15%\t$1,200.50\n2026-03-04\t(5)\n3/4/2026\t007')
  const c = cells()
  ok(c.C10?.v === 0.15 && c.C10?.format === '0%' && c.D10?.v === 1200.5 && c.D10?.format === '$#,##0.00',
    `a pasted 15% and $1,200.50 are numbers with their formats (${show(c.C10)}, ${show(c.D10)})`)
  ok(c.C11?.v === '2026-03-04' && c.C11?.format === 'yyyy-mm-dd' && c.D11?.v === -5,
    `a pasted ISO date is a date and (5) is -5 (${show(c.C11)}, ${show(c.D11)})`)
  ok(c.C12?.v === '3/4/2026' && c.D12?.v === '007', 'and a paste keeps the same refusals: 3/4/2026 and 007 stay text')
}

// ===================================================================== 8
console.log('\n8. the DATASET kind: the bar over a Percent column (the review\'s own 2.8 shot)')
{
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd3', title: 't',
    sheets: [{
      id: 'ds', name: 'Pipeline', kind: 'table', rids: [[1, 2]], nextRid: 3,
      columns: [
        { id: 'p', name: 'Probability', type: 'percent', format: '0%' },
        { id: 'm', name: 'Value', type: 'money', format: '£#,##0.00' },
        { id: 'n', name: 'Qty', type: 'number' },
      ],
      data: { p: { enc: 'raw', v: [1, 0.125] }, m: { enc: 'raw', v: [12400.5, 300] }, n: { enc: 'raw', v: [3, 4] } },
      steps: [],
    }],
  }))
  if (!r.ok) throw new Error('fixture')
  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const store = new Store(r.doc)
  const grid = new Grid({ el: host as never, store, sheetId: 'ds' })
  const scroll = host.querySelector('.dg-scroll')!
  scroll.clientHeight = 600; scroll.clientWidth = 900
  grid.paint()
  let bar = ''
  grid.onSelectionChange = (_s: string, _r: string, v: string) => { bar = v }
  const at = (row: number, col: number) => { grid.sel.moveTo(row, col); grid.announce(); return bar }
  ok(at(0, 0) === '100%', `Probability 1 (shown 100%) reads "100%" in the bar, not "1" (got "${bar}")`)
  ok(at(1, 0) === '12.5%', `0.125 reads "12.5%" (got "${bar}")`)
  ok(at(0, 1) === '£12400.50', `money 12400.5 under £#,##0.00 reads "£12400.50" (got "${bar}")`)
  ok(at(0, 2) === '3', `a plain number reads as itself (got "${bar}")`)
  // the bar's text reads back to the same value — the round trip
  const back = (text: string, type: string) => GR.coerceForColumn(text, type)
  ok(back('100%', 'percent') === 1 && back('12.5%', 'percent') === 0.125 && back('£12400.50', 'money') === 12400.5,
    'and each reads back to the value it shows')
  ok(back('12abc', 'number') === '12abc', 'a dataset number column keeps "12abc" as typed rather than reading 12 out of it')
  setViewerLocale('de-DE')
  ok(back('12,5 %', 'percent') === 0.125, 'de: "12,5 %" in a percent column is 0.125')
  setViewerLocale('en-US')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) { console.log(`${failures} FAILED`); process.exit(1) }
