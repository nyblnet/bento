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
// THE RIG BUILDS REAL .xlsx BYTES — a ZIP of OOXML — and asserts on the
// DOCUMENT that comes out of `importXlsx`. Both halves matter: finding 4 lives
// in a gate that only ever sees real formula text, and a check that a helper
// returns the right answer proves nothing about whether the importer calls it.

import { writeZip } from '../dash/src/zip.ts'
import { importXlsx, exportXlsx, liveFormula } from '../dash/src/xlsx.ts'
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
  ok(!liveFormula('SUBTOTAL(109,A1:A9)').ok,
    'and the SUBTOTAL case that was always right is still right')
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

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
