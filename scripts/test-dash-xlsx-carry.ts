#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash .xlsx rig — WHAT AN IMPORT CARRIES, AND WHAT IT SAYS IT DROPPED.
//
//   node scripts/test-dash-xlsx-carry.ts
//
// scripts/test-dash-xlsx.ts owns the epoch, the number formats and the export.
// This one owns the findings from the 2026-08-18 bounce test about what an
// import CARRIES and what it says it dropped — measured on real files, none of
// which threw:
//
//   FINDING 4 — THE LIVE-FORMULA GATE LOST A NUMBER. `=SUM(RentCells)/B5`,
//     where `RentCells` is a `<definedName>`, contains no `!`, no `[` and no
//     unknown function, so it passed all three of the gate's checks and was
//     imported LIVE. The cell painted `#NAME?` and Excel's cached 0.61 was
//     gone. Everything under THE GATE below exists so that a bare identifier
//     the workbook does not hand us keeps the cached value — and so that one
//     it DOES (a name dash imported, whose substitution dash can evaluate)
//     still goes live, because "reject every word" would be a different bug.
//
//   FINDING 3 — A MERGED TITLE MADE THE WHOLE SHEET TEXT. A spanning title in
//     A1:C1 with the real header in row 2: row 1 became the header, the header
//     became data row 1, every numeric column held one text value, and all
//     three columns typed as TEXT. A three-column budget with no numbers in
//     it. The facts were all emitted (merged-cells, empty-header, mixed-types)
//     and never joined.
//
//   FINDING 7 — THINGS DROPPED IN SILENCE. Frozen panes, per-cell bold and
//     colour, and an Excel table's TOTALS ROW — which is the consequential
//     one, because it imports as an ordinary data row and then sorts to the
//     top of the deals, is caught by filters, and is counted by aggregates.
//
// THE RIG BUILDS REAL .xlsx BYTES — a ZIP of OOXML — and asserts on the
// DOCUMENT that comes out of `importXlsx`. Both halves matter: finding 4 lives
// in a gate that only ever sees real formula text, and a check that a helper
// returns the right answer proves nothing about whether the importer calls it.

import { readFileSync } from 'node:fs'
import { writeZip } from '../dash/src/zip.ts'
import { importXlsx, exportXlsx, installNames, liveFormula } from '../dash/src/xlsx.ts'
import { readCell } from '../dash/src/store.ts'
import { parseDoc, type DashDoc, type TableSheet } from '../dash/src/model.ts'
import { readFrozen } from '../dash/src/rowcol.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const enc = new TextEncoder()
const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'

interface SheetSpec {
  name: string
  /** `<row>` elements */
  rows: string
  /** anything after `</sheetData>` — `<mergeCells>`, `<dataValidations>` */
  after?: string
  /** anything before `<sheetData>` — `<sheetViews>` */
  before?: string
  /** an Excel Table (ListObject) over this sheet */
  table?: string
}

/** A package `importXlsx` will open. Deliberately a separate builder from the
 *  one in test-dash-xlsx.ts: this one carries styles with real fonts, fills
 *  and borders, `<definedNames>`, and table parts. */
async function build(opts: {
  sheets: SheetSpec[]
  shared?: string[]
  numFmts?: string[]
  /** cellXfs: one entry per style index */
  xfs?: Array<{ fmt?: number; font?: number; fill?: number; border?: number }>
  /** `<font>` bodies, index 0 is the default */
  fonts?: string[]
  /** `<fill>` bodies; Excel requires index 0 = none and 1 = gray125 */
  fills?: string[]
  /** `<border>` bodies, index 0 is the empty one */
  borders?: string[]
  definedNames?: Array<{ name: string; body: string; localSheetId?: number }>
}): Promise<Uint8Array> {
  const shared = opts.shared ?? []
  const numFmts = opts.numFmts ?? []
  const xfs = opts.xfs ?? [{}]
  const fonts = opts.fonts ?? ['<sz val="11"/><name val="Calibri"/>']
  const fills = opts.fills ?? ['<patternFill patternType="none"/>', '<patternFill patternType="gray125"/>']
  const borders = opts.borders ?? ['<left/><right/><top/><bottom/><diagonal/>']
  const dn = opts.definedNames ?? []

  const parts: Array<{ name: string; data: Uint8Array }> = []
  const add = (name: string, s: string) => parts.push({ name, data: enc.encode(s) })

  const tables = opts.sheets.map((s, i) => (s.table ? `xl/tables/table${i + 1}.xml` : null))

  add('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="${CT}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/></Types>')
  add('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  add('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="${M}" xmlns:r="${R}"><workbookPr/>` +
    `<sheets>${opts.sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
    (dn.length
      ? `<definedNames>${dn.map((d) => `<definedName name="${d.name}"${d.localSheetId === undefined ? '' : ` localSheetId="${d.localSheetId}"`}>${d.body}</definedName>`).join('')}</definedNames>`
      : '') +
    '</workbook>')
  add('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    opts.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rIdS" Type="${R}/sharedStrings" Target="sharedStrings.xml"/>` +
    `<Relationship Id="rIdY" Type="${R}/styles" Target="styles.xml"/></Relationships>`)
  add('xl/sharedStrings.xml', `<?xml version="1.0"?><sst xmlns="${M}" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`)
  add('xl/styles.xml', `<?xml version="1.0"?><styleSheet xmlns="${M}">` +
    (numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.map((c, i) => `<numFmt numFmtId="${164 + i}" formatCode="${c}"/>`).join('')}</numFmts>` : '') +
    `<fonts count="${fonts.length}">${fonts.map((f) => `<font>${f}</font>`).join('')}</fonts>` +
    `<fills count="${fills.length}">${fills.map((f) => `<fill>${f}</fill>`).join('')}</fills>` +
    `<borders count="${borders.length}">${borders.map((b) => `<border>${b}</border>`).join('')}</borders>` +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${xfs.length}">${xfs.map((x) =>
      `<xf numFmtId="${x.fmt ?? 0}" fontId="${x.font ?? 0}" fillId="${x.fill ?? 0}" borderId="${x.border ?? 0}"` +
      `${x.font ? ' applyFont="1"' : ''}${x.fill ? ' applyFill="1"' : ''}${x.border ? ' applyBorder="1"' : ''}/>`).join('')}</cellXfs>` +
    '</styleSheet>')

  opts.sheets.forEach((s, i) => {
    add(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0"?><worksheet xmlns="${M}">` +
      (s.before ?? '') + `<sheetData>${s.rows}</sheetData>` + (s.after ?? '') +
      (s.table ? `<tableParts count="1"><tablePart r:id="rIdT"/></tableParts>` : '') +
      '</worksheet>')
    if (s.table) {
      add(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`,
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rIdT" Type="${R}/table" Target="../tables/table${i + 1}.xml"/></Relationships>`)
      add(tables[i]!, `<?xml version="1.0"?>${s.table}`)
    }
  })
  return writeZip(parts)
}

/** `<row>` from a list of cell fragments. */
const row = (r: number, cells: string): string => `<row r="${r}">${cells}</row>`
/** a shared-string cell */
const sc = (ref: string, i: number, s?: number): string =>
  `<c r="${ref}"${s ? ` s="${s}"` : ''} t="s"><v>${i}</v></c>`
/** a number cell */
const nc = (ref: string, v: number | string, s?: number): string =>
  `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${v}</v></c>`
/** a formula cell, with the value Excel cached beside it */
const fc = (ref: string, f: string, v: number | string): string =>
  `<c r="${ref}"><f>${f}</f><v>${v}</v></c>`

const over = (s: TableSheet, key: string): Record<string, unknown> =>
  (s.cells?.[key] ?? {}) as Record<string, unknown>

// ══════════════════════════════════════════════ THE GATE (finding 4)
//
// The unit half. The importer half is below it, and it is the half that was
// actually broken: `liveFormula` could have been perfect and the number would
// still have been lost if `readOneSheet` had not asked it.
{
  ok(!liveFormula('SUM(RentCells)/B5').ok,
    'a bare identifier fails the gate — this is finding 4, and it is the one that DESTROYED a value')
  const why = liveFormula('SUM(RentCells)/B5')
  ok(!why.ok && why.why.includes('RentCells'),
    'and the refusal names the word, so the finding can say which one')
  ok(liveFormula('B4*TaxRate', new Set(['taxrate'])).ok,
    'a name the workbook defines AND dash imported goes live — "reject every identifier" would be a different bug')
  ok(!liveFormula('B4*TaxRate', new Set(['other'])).ok,
    'but only that name: a different one in the table does not admit this word')
  ok(liveFormula('B4*taxrate', new Set(['taxrate'])).ok, 'names match case-insensitively, as Excel matches them')
  ok(liveFormula('IF(A1,TRUE,FALSE)').ok,
    'TRUE and FALSE are values, not names, and must not be mistaken for undefined ones')
  ok(liveFormula('SUM(A1:A9)+B5*2').ok, 'a formula of nothing but references and known functions still goes live')
  ok(liveFormula('IF(A1>0,"Total","RentCells")').ok,
    'a word inside a STRING is text — the lexer, not a regex, is what knows the difference')
  ok(!liveFormula('#REF!+1').ok === false,
    'an error literal left by a previous edit is not read as the name REF')
  ok(liveFormula('LOG10(A1)').ok, 'a function dash has is still a call, not a bare word')
  // SUBTOTAL used to stand here as the example of a function dash lacked, and
  // it is the one Excel writes into EVERY table's totals row — so while it was
  // missing, every imported table arrived with a dead total. dash has it now
  // (formula.ts), which is why the gate lets it through; the gate itself is
  // unchanged and is asserted against a function dash still does not have.
  ok(liveFormula('SUBTOTAL(109,A1:A9)').ok,
    'a table totals row goes LIVE now — dash has SUBTOTAL, and a dead total was the whole complaint')
  ok(!liveFormula('OFFSET(A1,1,1)').ok,
    'and the case that was always right is still right: a function dash lacks keeps its cached value')
}

// The importer half: real bytes, and the OUTCOME in the document.
{
  const bytes = await build({
    shared: ['Category', 'Amount', 'Rent share'],
    sheets: [{
      name: 'Summary',
      rows: row(1, sc('A1', 0) + sc('B1', 1) + sc('C1', 2)) +
        row(2, sc('A2', 0) + nc('B2', 1000) + fc('C2', 'SUM(RentCells)/B2', 0.61)) +
        row(3, sc('A3', 0) + nc('B3', 2000) + fc('C3', 'B3*2', 4000)),
    }],
    definedNames: [{ name: 'RentCells', body: 'Summary!$B$2:$B$3' }],
  })
  const r = await importXlsx(bytes, { idPrefix: 'g' })
  const s = r.sheets[0]
  const c2 = over(s, `${s.columns[2].id}:1`)

  // THE MEASUREMENT. Before the fix this cell had `f` set and no value in
  // sight; the grid rendered #NAME? and 0.61 existed nowhere in the document.
  ok(c2.f === undefined,
    'the defined-name formula is NOT imported live — the whole of finding 4 in one assertion')
  ok(c2.xlsxF === '=SUM(RentCells)/B2',
    'its source is kept verbatim, so a re-export puts the model back')
  // The pair, not either half: the cached value never left the column even
  // when the bug was live — what destroyed it was the formula rendering OVER
  // it. So this asserts the value is there AND that nothing computes on top.
  ok(readCell(s.data[s.columns[2].id], 0) === 0.61 && c2.f === undefined,
    "and Excel's cached 0.61 is what the cell shows, which is the number the finding says was destroyed")
  ok(over(s, `${s.columns[2].id}:2`).f === '=B2*2',
    'the ordinary formula beside it still goes live (shifted up by the header row) — the gate got narrower, not blunter')
  const nl = r.findings.find((f) => f.code === 'formula-not-live')
  ok(!!nl && nl.message.includes('RentCells'),
    'and it takes a formula-not-live finding naming the word, exactly as SUBTOTAL does')
}

// A name dash CAN carry goes live, and the table comes back for the document.
{
  const bytes = await build({
    shared: ['Net', 'Tax'],
    sheets: [{
      name: 'Bill',
      rows: row(1, sc('A1', 0) + sc('B1', 1)) +
        row(2, nc('A2', 100) + fc('B2', 'A2*TaxRate', 20)) +
        row(3, nc('A3', 250) + fc('B3', 'A3*TaxRate', 50)),
    }],
    definedNames: [
      { name: 'TaxRate', body: '0.2' },
      { name: 'RentCells', body: 'Bill!$A$2:$A$3' },
      { name: 'Region', body: '"North"' },
      { name: 'Loose', body: '$A$2:$A$3' },
      { name: 'Computed', body: 'OFFSET(Bill!$A$1,1,0)' },
      { name: 'TAX1', body: '7' },
      { name: '_xlnm.Print_Area', body: 'Bill!$A$1:$B$3' },
    ],
  })
  const r = await importXlsx(bytes, { idPrefix: 'n', names: true })
  const s = r.sheets[0]
  ok(r.names?.TaxRate?.v === 0.2, 'a number-valued name is carried into doc.names')
  ok(r.names?.Region?.v === 'North', 'so is a text one')
  ok(r.names?.RentCells?.ref === 'Bill!$A$1:$A$2',
    'and a range one — SHIFTED UP by the header row, because dash row 1 is Excel row 2')
  ok(r.names?.Loose === undefined && r.names?.Computed === undefined && r.names?.TAX1 === undefined,
    'an unqualified range, a formula and a cell-shaped spelling are refused rather than half-carried')
  ok(r.names?.['_xlnm.Print_Area'] === undefined, 'and Print_Area is view state, not a name')
  ok(r.findings.filter((f) => f.code === 'defined-name').length === 3,
    'each refusal is a finding — three names dropped, three lines')
  ok(over(s, `${s.columns[1].id}:1`).f === '=A1*TaxRate',
    'a formula using a carried, evaluable name IS live: the fix is a gate, not a wall')
  ok(readCell(s.data[s.columns[1].id], 0) === 20, 'and its cached value is still underneath')
}

// The default path carries no names, so no name may go live — otherwise a
// caller that ignores `result.names` re-opens finding 4 through another door.
{
  const bytes = await build({
    shared: ['Net', 'Tax'],
    sheets: [{
      name: 'Bill',
      rows: row(1, sc('A1', 0) + sc('B1', 1)) + row(2, nc('A2', 100) + fc('B2', 'A2*TaxRate', 20)),
    }],
    definedNames: [{ name: 'TaxRate', body: '0.2' }],
  })
  const r = await importXlsx(bytes, { idPrefix: 'd' })
  const s = r.sheets[0]
  ok(r.names === undefined, 'without the opt the table is not returned…')
  ok(over(s, `${s.columns[1].id}:1`).f === undefined && readCell(s.data[s.columns[1].id], 0) === 20,
    '…and nothing goes live on the strength of a table the document will not have')
  ok(r.findings.some((f) => f.code === 'defined-name' && f.message.includes('TaxRate')),
    'and the names are REPORTED as not carried — finding 7 counted this as a silent drop')
}

// ═══════════════════════════════════════ THE HEADER IN ROW 2 (finding 3)
{
  // budget.xlsx, as the bounce test had it: a spanning title in A1:C1, the
  // real header in row 2, numbers below.
  const bytes = await build({
    shared: ['Jan 2026 budget', 'Category', 'Budget', 'Actual', 'Rent', 'Food'],
    sheets: [{
      name: 'Budget',
      rows: row(1, sc('A1', 0)) +
        row(2, sc('A2', 1) + sc('B2', 2) + sc('C2', 3)) +
        row(3, sc('A3', 4) + nc('B3', 1200) + nc('C3', 1180)) +
        row(4, sc('A4', 5) + nc('B4', 400) + nc('C4', 455)),
      after: '<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>',
    }],
  })
  const r = await importXlsx(bytes, { idPrefix: 'h' })
  const s = r.sheets[0]

  // THE MEASUREMENT, and every line of it was wrong before: the columns were
  // "Jan 2026 budget"/"Column 2"/"Column 3", all three typed TEXT, and the
  // real header sat in data row 1.
  ok(s.columns.map((c) => c.name).join() === 'Category,Budget,Actual',
    'the header is taken from ROW 2, under the spanning title')
  ok(s.columns.map((c) => c.type).join() === 'text,number,number',
    'so the numeric columns are NUMBERS — a three-column budget arrived with no numbers in it')
  ok(readCell(s.data[s.columns[1].id], 0) === 1200 && s.rids[0][1] === 2,
    'and the two data rows are the two data rows, with the header no longer among them')
  const hr = r.findings.find((f) => f.code === 'header-row')
  ok(!!hr, 'it is SAID — a header moved without a word is how the whole finding started')
  ok(!!hr && hr.message.includes('A1:C1'),
    'and it names the merge that caused it, joining two facts that used to read as unrelated complaints')
  ok(!r.findings.some((f) => f.code === 'empty-header'),
    'the empty-header complaint about "Column 2"/"Column 3" is gone, because it was a consequence')
  ok(!r.findings.some((f) => f.code === 'mixed-types'),
    'and so is mixed-types: one text value in a numeric column was the header all along')
}

// The evidence has to be REQUIRED, or this becomes a header thief. A merge in
// row 1 that spans a real header — the "Q1 | Q2" two-tier idiom — must not
// move anything.
{
  const bytes = await build({
    shared: ['Region', 'Q1', 'Q2', 'North'],
    sheets: [{
      name: 'Tiered',
      rows: row(1, sc('A1', 0) + sc('B1', 1) + sc('C1', 2)) +
        row(2, sc('A2', 3) + nc('B2', 10) + nc('C2', 20)),
      after: '<mergeCells count="1"><mergeCell ref="B1:C1"/></mergeCells>',
    }],
  })
  const r = await importXlsx(bytes, { idPrefix: 'q' })
  ok(r.sheets[0].columns.map((c) => c.name).join() === 'Region,Q1,Q2',
    'a merge in a row that IS the header changes nothing — row 2 has to look like a header for row 1 to lose the job')
  ok(!r.findings.some((f) => f.code === 'header-row'), 'and nothing is claimed about it')
}

// An explicit instruction always beats the inference.
{
  const bytes = await build({
    shared: ['Jan 2026 budget', 'Category', 'Budget'],
    sheets: [{
      name: 'Budget',
      rows: row(1, sc('A1', 0)) + row(2, sc('A2', 1) + sc('B2', 2)) + row(3, sc('A3', 1) + nc('B3', 5)),
      after: '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>',
    }],
  })
  const r = await importXlsx(bytes, { idPrefix: 'f', header: false })
  ok(r.sheets[0].columns[0].name === 'Column 1' && r.sheets[0].rids[0][1] === 3,
    'header:false still means no header at all, and no row is taken from anybody')
  ok(!r.findings.some((f) => f.code === 'header-row'), 'and the inference does not argue with the instruction')

  // `headerRow` is the answer a boolean cannot give, and the hook a "use this
  // row as the header" command would call.
  const r2 = await importXlsx(bytes, { idPrefix: 'x', headerRow: 1 })
  ok(r2.sheets[0].columns.map((c) => c.name).join() === 'Category,Budget' && r2.sheets[0].rids[0][1] === 1,
    'headerRow:1 names the second row of the used range as the header, and the data starts under it')
  const r3 = await importXlsx(bytes, { idPrefix: 'y', headerRow: 0 })
  ok(r3.sheets[0].columns[0].name === 'Jan 2026 budget',
    'and headerRow:0 puts it back on the title, because an instruction is an instruction')
}

// ═════════════════════════════════ FROZEN PANES, FORMAT, TOTALS (finding 7)
{
  // Every fixture in the bounce test froze its header and bolded it; not one
  // imported sheet reported a freeze and not one cell override carried bold.
  const bytes = await build({
    shared: ['Deal', 'Stage', 'Value', 'Acme', 'Open', 'Beta', 'Won'],
    fonts: [
      '<sz val="11"/><name val="Calibri"/>',
      '<b/><sz val="11"/><name val="Calibri"/>',
      '<i/><u/><color rgb="FFCC0000"/><sz val="11"/><name val="Calibri"/>',
    ],
    fills: [
      '<patternFill patternType="none"/>', '<patternFill patternType="gray125"/>',
      '<patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/></patternFill>',
    ],
    borders: ['<left/><right/><top/><bottom/><diagonal/>',
      '<left/><right/><top/><bottom style="thin"><color rgb="FF333333"/></bottom><diagonal/>'],
    //  1 = bold   2 = italic+underline+red on a yellow fill   3 = bottom rule
    xfs: [{}, { font: 1 }, { font: 2, fill: 2 }, { border: 1 }],
    sheets: [{
      name: 'Pipeline',
      before: '<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" state="frozen"/></sheetView></sheetViews>',
      rows: row(1, sc('A1', 0, 1) + sc('B1', 1, 1) + sc('C1', 2, 1)) +
        row(2, sc('A2', 3) + sc('B2', 4) + nc('C2', 120000, 2)) +
        row(3, sc('A3', 5) + sc('B3', 6) + nc('C3', 749050, 3)),
    }],
  })
  const r = await importXlsx(bytes, { idPrefix: 'z' })
  const s = r.sheets[0]

  // FREEZE. Excel's ySplit counts SHEET rows and its first one is the header,
  // which a dataset pins on its own; dash's frozen.rows counts DATA rows. So
  // ySplit=2 over a 1-row header is one frozen data row, and ySplit=1 (which
  // every fixture had) is correctly zero — a distinction the finding could not
  // make from the outside and this rig has to.
  const fz = readFrozen(s)
  ok(fz.rows === 1 && fz.cols === 1,
    'a frozen pane arrives: ySplit=2 over a one-row header is ONE frozen data row, xSplit=1 is one column')
  ok(readFrozen({ ...s, frozen: undefined } as TableSheet).rows === 0, 'and readFrozen is what reads it')

  // FORMAT. Header bold is not carried and must not be: a dataset draws its
  // own header, so there is nowhere to put it and nothing is lost.
  const vId = s.columns[2].id
  ok(over(s, `${vId}:1`).bold === undefined, 'the header row is the grid\'s own furniture, so its bold is not a cell override')
  ok(over(s, `${vId}:1`).italic === true && over(s, `${vId}:1`).underline === true,
    'a data cell keeps italic and underline')
  ok(over(s, `${vId}:1`).color === '#cc0000', 'and its font colour, as #rrggbb')
  ok(over(s, `${vId}:1`).bg === '#fff2cc', 'and its solid fill becomes the background')
  ok(over(s, `${vId}:2`).border === 'b' && over(s, `${vId}:2`).borderColor === '#333333',
    'a bottom rule becomes the "b" edge with its colour')
  ok(!('v' in over(s, `${vId}:1`)),
    'an appearance override carries NO value — cellfmt.ts\'s one line: appearance is not a back door to a type')
  ok(readCell(s.data[vId], 0) === 120000, 'so the number is still the column\'s, and no total can move')
}

// THE TOTALS ROW — the consequential one. Excel's totals row imports as an
// ordinary data row, so sorting pipeline.xlsx by Value descending puts the row
// labelled "Total", holding 869,050, at the top of the deals.
{
  const table = '<table xmlns="' + M + '" id="1" name="Deals" displayName="Deals" ref="A1:C4" ' +
    'headerRowCount="1" totalsRowCount="1"><autoFilter ref="A1:C3"/><tableColumns count="3">' +
    '<tableColumn id="1" name="Deal" totalsRowLabel="Total"/>' +
    '<tableColumn id="2" name="Stage"/>' +
    '<tableColumn id="3" name="Value" totalsRowFunction="sum"/>' +
    '</tableColumns></table>'
  const bytes = await build({
    shared: ['Deal', 'Stage', 'Value', 'Acme', 'Open', 'Beta', 'Won', 'Total'],
    sheets: [{
      name: 'Pipeline',
      table,
      rows: row(1, sc('A1', 0) + sc('B1', 1) + sc('C1', 2)) +
        row(2, sc('A2', 3) + sc('B2', 4) + nc('C2', 120000)) +
        row(3, sc('A3', 5) + sc('B3', 6) + nc('C3', 749050)) +
        row(4, sc('A4', 7) + fc('C4', 'SUBTOTAL(109,C2:C3)', 869050)),
    }],
  })
  const r = await importXlsx(bytes, { idPrefix: 't' })
  const s = r.sheets[0]
  const vId = s.columns[2].id

  ok(s.rids.reduce((n, [, c]) => n + c, 0) === 2,
    'the table has TWO rows, not three: the totals row is not a deal')
  const values = Array.from({ length: 3 }, (_, i) => readCell(s.data[vId], i))
  ok(values[0] === 120000 && values[1] === 749050 && !values.includes(869050),
    'and 869,050 is NOWHERE in the column, waiting to sort to the top of the deals')
  ok(s.totals?.[vId] === 'sum',
    'it became the column PROPERTY docs/dash-sheet-kinds.md worked out: totalsRowFunction="sum" ⇄ totals:{value:"sum"}')
  ok(s.columns[0].name === 'Deal' && s.columns.length === 3, 'the table names the columns')
  const tf = r.findings.find((f) => f.code === 'totals-row')
  ok(!!tf, 'and it is said, because a row that leaves the data is a row somebody will look for')

  // The property must survive the format, or it is a runtime trick.
  const doc = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, docId: 'x', title: 'T', sheets: [s],
  }))
  ok(doc.ok && (doc.doc.sheets[0] as TableSheet).totals?.[vId] === 'sum',
    'and it round-trips through parseDoc, so it is document data and not a guess made at paint time')
}

// A totals function dash has no home for is DROPPED and named, never guessed.
{
  const table = '<table xmlns="' + M + '" id="1" name="D" displayName="D" ref="A1:B3" ' +
    'headerRowCount="1" totalsRowCount="1"><tableColumns count="2">' +
    '<tableColumn id="1" name="Deal" totalsRowLabel="Total"/>' +
    '<tableColumn id="2" name="Value" totalsRowFunction="stdDev"/></tableColumns></table>'
  const bytes = await build({
    shared: ['Deal', 'Value', 'Acme', 'Total'],
    sheets: [{
      name: 'Odd',
      table,
      rows: row(1, sc('A1', 0) + sc('B1', 1)) + row(2, sc('A2', 2) + nc('B2', 10)) +
        row(3, sc('A3', 3) + nc('B3', 10)),
    }],
  })
  const r = await importXlsx(bytes, { idPrefix: 'o' })
  const s = r.sheets[0]
  ok(s.rids.reduce((n, [, c]) => n + c, 0) === 1, 'the totals row still leaves the data')
  ok(s.totals === undefined || Object.keys(s.totals).length === 0, 'but no total is invented for stdDev')
  ok(r.findings.some((f) => f.code === 'totals-row' && f.message.includes('stdDev')),
    'and the one dash cannot express is named')
}

// ROUND TRIP: what comes in has to go back out, or the importer has made a new
// silent loss on the export side.
{
  const bytes = await build({
    shared: ['Deal', 'Value', 'Acme', 'Beta'],
    fonts: ['<sz val="11"/><name val="Calibri"/>', '<b/><color rgb="FF0044AA"/><sz val="11"/>'],
    fills: ['<patternFill patternType="none"/>', '<patternFill patternType="gray125"/>',
      '<patternFill patternType="solid"><fgColor rgb="FFEEEEEE"/></patternFill>'],
    xfs: [{}, { font: 1, fill: 2 }],
    sheets: [{
      name: 'Deals',
      before: '<sheetViews><sheetView workbookViewId="0"><pane ySplit="2" state="frozen"/></sheetView></sheetViews>',
      rows: row(1, sc('A1', 0) + sc('B1', 1)) + row(2, sc('A2', 2) + nc('B2', 10, 1)) +
        row(3, sc('A3', 3) + nc('B3', 20)),
    }],
  })
  const first = await importXlsx(bytes, { idPrefix: 'rt' })
  const doc = {
    format: 'bento/dash', version: 1, docId: 'x', title: 'T', sheets: first.sheets,
  } as unknown as DashDoc
  const out = await exportXlsx(doc, { store: true })
  const back = await importXlsx(out.bytes, { idPrefix: 'rt2' })
  const a = first.sheets[0]
  const b = back.sheets[0]
  ok(over(b, `${b.columns[1].id}:1`).bold === true, 'bold survives dash → xlsx → dash')
  ok(over(b, `${b.columns[1].id}:1`).color === '#0044aa', 'so does the font colour')
  ok(over(b, `${b.columns[1].id}:1`).bg === '#eeeeee', 'and the fill')
  ok(readFrozen(b).rows === readFrozen(a).rows && readFrozen(b).rows === 1,
    'and the frozen pane comes home as the same one row')
  ok(readCell(b.data[b.columns[1].id], 0) === 10 && readCell(b.data[b.columns[1].id], 1) === 20,
    'with the numbers unchanged, which is the only part of this that a person would notice going wrong')
}

// A dash totals row has to survive dash → xlsx → dash, or the property this
// import now understands is one the export flattens back into a data row —
// the same finding, one door along.
{
  const bytes = await build({
    shared: ['Deal', 'Value', 'Acme', 'Beta'],
    sheets: [{
      name: 'Deals',
      rows: row(1, sc('A1', 0) + sc('B1', 1)) + row(2, sc('A2', 2) + nc('B2', 120000)) +
        row(3, sc('A3', 3) + nc('B3', 749050)),
    }],
  })
  const first = await importXlsx(bytes, { idPrefix: 'tt' })
  const sheet = { ...first.sheets[0], totals: { [first.sheets[0].columns[1].id]: 'sum' as const } }
  const out = await exportXlsx({
    format: 'bento/dash', version: 1, docId: 'x', title: 'T', sheets: [sheet],
  } as unknown as DashDoc, { store: true })
  const back = await importXlsx(out.bytes, { idPrefix: 'tt2' })
  const b = back.sheets[0]
  ok(b.rids.reduce((n, [, c]) => n + c, 0) === 2,
    'the exported totals row does not come home as a third deal')
  ok(b.totals?.[b.columns[1].id] === 'sum',
    'it comes home as the property it left as — the export writes a real ListObject, not only a row of SUM()s')
  ok(readCell(b.data[b.columns[1].id], 0) === 120000, 'and the deals are untouched')
}

// The caller's half of the names contract, in one line — and its one rule.
{
  const bytes = await build({
    shared: ['Net'],
    sheets: [{ name: 'Bill', rows: row(1, sc('A1', 0)) + row(2, nc('A2', 100)) }],
    definedNames: [{ name: 'TaxRate', body: '0.2' }, { name: 'Fresh', body: '0.5' }],
  })
  const r = await importXlsx(bytes, { idPrefix: 'i', names: true })
  const doc = {
    format: 'bento/dash', version: 1, docId: 'x', title: 'T', sheets: r.sheets,
    names: { TaxRate: { v: 0.4 } },
  } as unknown as DashDoc
  const skipped = installNames(doc, r.names)
  ok(doc.names?.Fresh?.v === 0.5, 'a name the document does not have is installed')
  ok(doc.names?.TaxRate?.v === 0.4,
    "and one it DOES keeps its own meaning — importing a second workbook must not repoint every formula that used it")
  ok(skipped.join() === 'TaxRate', 'the collision comes back so the caller can say so')
  ok(installNames(doc, undefined).length === 0 && doc.names?.Fresh?.v === 0.5,
    'and installing nothing changes nothing')
}

console.log('\nBOTH import doors ask for names, and BOTH install them')
{
  // THE CALLER CHECK, and here it guards a contract rather than a feature.
  // `names: true` is opt-in because the gate TRUSTS the table: `liveFormula`
  // lets a formula go live when every bare word it mentions is a name the
  // import carried. A caller that asks for names and does not install them
  // therefore re-creates finding 4 exactly — `=B4*TaxRate` painting #NAME? over
  // a real number — while looking more capable, not less.
  //
  // Both doors are checked because dash has TWO import paths and the bounce
  // test already found them out of step once: fifteen findings render as
  // bullets through the menu and as one unbroken paragraph through the drop
  // door. Same feature, two doors, and the door people use was the broken one.
  // COMMENTS STRIPPED, and that is not fussiness. The first version of this
  // check tested the raw source, and a negative control walked straight through
  // it: dropopen.ts carries a comment EXPLAINING the `names: true` contract, so
  // deleting the actual option left the string sitting in the prose above it
  // and the check stayed green. A guard a comment can satisfy is a guard that
  // certifies documentation.
  const src = (f: string) => readFileSync(new URL(`../dash/src/${f}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  for (const f of ['main.ts', 'dropopen.ts']) {
    const code = src(f)
    ok(/names:\s*true/.test(code), `${f} asks importXlsx to carry defined names`)
    ok(code.includes('installNames('),
      `and ${f} INSTALLS them — asking without installing is finding 4 with extra steps`)
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
