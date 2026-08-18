#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash .xlsx rig.
//
//   node scripts/test-dash-xlsx.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Every failure in this module is silent — the file opens,
// the grid fills, the totals compute, and the numbers are wrong by four years
// or a factor of a hundred. So the rig is organised around the ways that
// happens rather than around the functions:
//
//   1. THE EPOCH. 1900 vs 1904 is 1,462 days. The 1900 system's phantom
//      29 February 1900 means serials 1–59 and 61+ need DIFFERENT epochs.
//      Checked against dates computed by hand, in both systems, at the seam.
//   2. PERCENT. Excel stores 15% as 0.15 and so does dash: the value must come
//      through UNCHANGED. A ×100 here is a margin column reading 1500%.
//   3. FORMULAS THAT WOULD SILENTLY REBIND. `Sheet2!A1` imported live resolves
//      against THIS sheet's column A, because a1.ts (correctly) will not
//      rewrite a sheet-qualified name. The import must refuse to make it live.
//
// AND the export is judged by things that are not us:
//
//   • `unzip -t` and python3's zipfile on the archive;
//   • LibreOffice actually OPENING the workbook and converting it to CSV — the
//     "does Excel show a repair dialog" question, answered by a real OOXML
//     consumer rather than by our own reader agreeing with our own writer.
//   • real .xlsx files off this machine, written by Excel, imported here.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeZip } from '../dash/src/zip.ts'
import {
  importXlsx, exportXlsx, serialToIso, isoToSerial, classifyFormat, liveFormula,
  escapeXml, unescapeXml, xlsxFileName, _internals,
} from '../dash/src/xlsx.ts'
import { parseDoc, type DashDoc, type TableSheet } from '../dash/src/model.ts'
import { readCell } from '../dash/src/store.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const tmp = mkdtempSync(join(tmpdir(), 'dash-xlsx-'))
const enc = new TextEncoder()
const have = (cmd: string, ...args: string[]): boolean => {
  try { execFileSync(cmd, args, { stdio: 'ignore' }); return true } catch { return false }
}

// ============================================================ THE EPOCH
{
  // 1900 system, checked at the three points where a wrong epoch shows up.
  ok(serialToIso(1, false) === '1900-01-01', '1900 system: serial 1 is 1 January 1900')
  ok(serialToIso(59, false) === '1900-02-28', '1900 system: serial 59 is 28 February 1900')
  ok(serialToIso(60, false) === '1900-02-29',
    'serial 60 is the day that never existed, and is reported rather than nudged to the 28th or the 1st')
  ok(serialToIso(61, false) === '1900-03-01', '1900 system: serial 61 is 1 March 1900 (the epoch changes here)')
  ok(serialToIso(45000, false) === '2023-03-15', '1900 system: a modern serial')
  ok(serialToIso(25569, false) === '1970-01-01', '1900 system: the Unix epoch is serial 25569')

  // 1904 system. THE FOUR-YEAR BUG: the same serial must be 1,462 days later.
  ok(serialToIso(0, true) === '1904-01-01', '1904 system: serial 0 is 1 January 1904')
  ok(serialToIso(45000, true) === '2027-03-16', '1904 system: the same serial is four years and a day on')
  {
    const a = Date.parse(serialToIso(45000, false)! + 'T00:00:00Z')
    const b = Date.parse(serialToIso(45000, true)! + 'T00:00:00Z')
    ok((b - a) / 86400000 === 1462,
      'and the gap between the two systems is exactly 1,462 days — the number a wrong guess costs')
  }

  // the inverse, including across the leap-bug seam
  for (const s of [1, 59, 61, 25569, 45000, 45999]) {
    const iso = serialToIso(s, false)!
    checks++
    if (isoToSerial(iso) === s) console.log(`  ok    serial ${s} → ${iso} → ${s}`)
    else { failures++; console.log(`  FAIL  serial ${s} round trip gave ${isoToSerial(iso)}`) }
  }
  ok(isoToSerial('2023-03-15T06:00:00') === 45000.25, 'a time of day becomes the fraction of a serial')
  ok(serialToIso(45000.25, false, true) === '2023-03-15T06:00:00', 'and comes back')
  ok(isoToSerial('not a date') === null, 'and a non-date refuses rather than becoming serial 0 (= 1900)')
}

// ==================================================== NUMBER FORMAT → TYPE
{
  ok(classifyFormat('General') === 'number', 'General is a number')
  ok(classifyFormat('yyyy-mm-dd') === 'date', 'an ISO date pattern is a date')
  ok(classifyFormat('mm/dd/yyyy') === 'date', 'so is a US one')
  ok(classifyFormat('0.00%') === 'percent', 'a percent pattern is a percent')
  ok(classifyFormat('"£"#,##0.00') === 'money', 'a quoted currency symbol is money')
  ok(classifyFormat('[$€-407]#,##0.00') === 'money', 'and so is a locale currency block')
  ok(classifyFormat('h:mm:ss') === 'time', 'a clock pattern is a time')
  ok(classifyFormat('[h]:mm') === 'time', 'elapsed hours are a time, not a colour')
  ok(classifyFormat('@') === 'text', '@ is text')

  // THE ONE THAT BIT: an ordinary accounting pattern read as a date, because
  // `\(` and `\-` were not stripped and `d` was found inside an escape.
  ok(classifyFormat('#,##0;\\(#,##0\\);\\-') === 'number',
    'an accounting pattern with escaped brackets is a NUMBER, not a date')
  ok(classifyFormat('* #,##0.00_0\\ "GBP";* \\-\\ #,##0.00_0\\ "GBP"') === 'money',
    'and a quoted currency code with escapes is money, not a date (the m in "GBP" is not a month)')
  ok(classifyFormat('[Red]#,##0.00') === 'number', 'a colour block is not a date (the d in Red)')
  ok(classifyFormat('0.0"days"') === 'number', 'and neither is a quoted unit')
}

// ============================================================ ESCAPING
{
  ok(unescapeXml('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;') === `a & b <c> "d" 'e'`,
    'the five named entities decode')
  ok(unescapeXml('&#65;&#x42;') === 'AB', 'numeric entities decode, decimal and hex')
  ok(unescapeXml('line_x000D_break') === 'line\rbreak', "Excel's _x000D_ escape decodes")
  ok(unescapeXml('part_x0041_number') === 'part_x0041_number',
    'but _x0041_ does NOT — it is ordinary text far more often than it is an escape')
  ok(escapeXml('a & b <c>') === 'a &amp; b &lt;c&gt;', 'text escapes on the way out')
  ok(escapeXml('badbell\tkeep') === 'badbell\tkeep',
    'a control character is stripped (XML cannot carry it and Excel calls the file corrupt); tab stays')
}

// ============================================ FORMULAS THAT MUST NOT GO LIVE
{
  ok(liveFormula('A1*2').ok, 'plain arithmetic goes live')
  ok(liveFormula('SUM(A1:A9)/COUNT(A1:A9)').ok, 'functions dash implements go live')
  ok(!liveFormula('Sheet2!A1*2').ok,
    'a sheet-qualified reference does NOT — a1.ts leaves `Sheet2` alone and the `A1` after it would bind to THIS sheet')
  ok(!liveFormula(`'Q1 data'!B7`).ok, 'nor a quoted sheet name')
  ok(!liveFormula('[1]Other!A1').ok, 'nor an external workbook reference')
  ok(!liveFormula('Table1[Amount]').ok, 'nor a structured table reference')
  ok(liveFormula('VLOOKUP(A1,B1:C9,2,0)').ok, 'VLOOKUP goes live — dash implements it')
  ok(!liveFormula('SUMPRODUCT(A1:A9,B1:B9)').ok,
    'but SUMPRODUCT does not, and a live #NAME? where a number used to be is not an import')
  ok(liveFormula('IF(A1>0,"up","down")').ok, 'a string containing nothing special is fine')
  ok(liveFormula('"a!b"&A1').ok, 'and a `!` inside a quoted string is not a sheet qualifier')
}

// ================================================= IMPORT: a hand-built workbook
//
// Built here as XML so every case is exactly the one being tested. This is the
// input our reader has to survive; the real Excel files come later.

function sheetXml(rows: string, extra = ''): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rows}</sheetData>${extra}</worksheet>`
}

async function buildXlsx(opts: {
  sheets: Array<{ name: string; xml: string; state?: string }>
  shared?: string[]
  numFmts?: string[]
  xfs?: number[]
  date1904?: boolean
}): Promise<Uint8Array> {
  const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const shared = opts.shared ?? []
  const numFmts = opts.numFmts ?? []
  const xfs = opts.xfs ?? [0]
  const parts = [
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>') },
    { name: '_rels/.rels', data: enc.encode(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: enc.encode(`<?xml version="1.0"?><workbook xmlns="${M}" xmlns:r="${R}">` +
      (opts.date1904 ? '<workbookPr date1904="1"/>' : '<workbookPr/>') +
      `<sheets>${opts.sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"${s.state ? ` state="${s.state}"` : ''}/>`).join('')}</sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      opts.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rIdS" Type="${R}/sharedStrings" Target="sharedStrings.xml"/>` +
      `<Relationship Id="rIdY" Type="${R}/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/sharedStrings.xml', data: enc.encode(`<?xml version="1.0"?><sst xmlns="${M}" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`) },
    { name: 'xl/styles.xml', data: enc.encode(`<?xml version="1.0"?><styleSheet xmlns="${M}">` +
      (numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.map((c, i) => `<numFmt numFmtId="${164 + i}" formatCode="${c}"/>`).join('')}</numFmts>` : '') +
      // a cellStyleXfs block FIRST, deliberately: it has the same <xf> shape as
      // cellXfs, and a reader that scans for every <xf> indexes into the wrong one
      '<cellStyleXfs count="2"><xf numFmtId="99"/><xf numFmtId="98"/></cellStyleXfs>' +
      `<cellXfs count="${xfs.length}">${xfs.map((f) => `<xf numFmtId="${f}" fontId="0" fillId="0" borderId="0"/>`).join('')}</cellXfs></styleSheet>`) },
  ]
  opts.sheets.forEach((s, i) => parts.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(s.xml) }))
  return writeZip(parts)
}

// --- values, types, shared strings, inline strings
{
  const bytes = await buildXlsx({
    shared: ['Region', 'Amount', 'Share', 'When', 'Live', 'North', 'South'],
    numFmts: ['&quot;£&quot;#,##0.00', '0.0%', 'yyyy-mm-dd'],
    //  0=General  1=money(164)  2=percent(165)  3=date(166)
    xfs: [0, 164, 165, 166],
    sheets: [{
      name: 'Data',
      xml: sheetXml(
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2" s="1"><v>1200.5</v></c><c r="C2" s="2"><v>0.15</v></c><c r="D2" s="3"><v>45000</v></c><c r="E2" t="b"><v>1</v></c></row>' +
        '<row r="3"><c r="A3" t="inlineStr"><is><t>Sou</t><t>th</t></is></c><c r="B3" s="1"><v>3400</v></c><c r="C3" s="2"><v>0.5</v></c><c r="D3" s="3"><v>45001</v></c><c r="E3" t="b"><v>0</v></c></row>'),
    }],
  })
  const r = await importXlsx(bytes, { source: 'built.xlsx', idPrefix: 'sh' })
  const s = r.sheets[0]
  ok(r.sheets.length === 1 && s.columns.length === 5, 'five columns arrive')
  ok(s.columns.map((c) => c.type).join() === 'text,money,percent,date,bool',
    'and are typed text/money/percent/date/bool from the NUMBER FORMATS, not from the digits')
  ok(s.columns.map((c) => c.name).join() === 'Region,Amount,Share,When,Live',
    'the header row names them (shared strings resolved)')
  ok(readCell(s.data.region, 1) === 'South',
    'a rich-text inline string is concatenated from its runs, not truncated to the first')
  ok(readCell(s.data.amount, 0) === 1200.5, 'a money value is the plain number')
  ok(readCell(s.data.share, 0) === 0.15,
    'A PERCENT IS NOT MULTIPLIED — 15% is 0.15 in Excel and 0.15 in dash')
  ok(readCell(s.data.when, 0) === '2023-03-15', 'a date serial becomes an ISO date')
  ok(readCell(s.data.live, 0) === true && readCell(s.data.live, 1) === false, 'booleans survive')
  ok(s.rids.length === 1 && s.rids[0][1] === 2, 'two data rows, header consumed')

  const doc = {
    format: 'bento/dash', version: 1, policy: 'bento-dash-1',
    docId: 'd', title: 'x', sheets: r.sheets,
  }
  const parsed = parseDoc(JSON.stringify(doc))
  ok(parsed.ok === true && parsed.repairs.length === 0,
    'and the imported sheets parse as a legal bento/dash document with nothing to repair')
}

// --- THE 1904 EPOCH, end to end
{
  const make = (d1904: boolean) => buildXlsx({
    shared: ['When'], numFmts: ['yyyy-mm-dd'], xfs: [0, 164], date1904: d1904,
    sheets: [{ name: 'D', xml: sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" s="1"><v>45000</v></c></row>') }],
  })
  const a = await importXlsx(await make(false), {})
  const b = await importXlsx(await make(true), {})
  ok(readCell(a.sheets[0].data.when, 0) === '2023-03-15', '1900 workbook: 15 March 2023')
  ok(readCell(b.sheets[0].data.when, 0) === '2027-03-16', '1904 workbook: the SAME serial is 16 March 2027')
  ok(b.findings.some((f) => f.code === 'date-system'),
    'and the 1904 system is REPORTED, because nothing on screen would otherwise say')
  ok(!a.findings.some((f) => f.code === 'date-system'), 'a 1900 workbook says nothing (the default)')
}

// --- serial 60, the day that never existed
{
  const bytes = await buildXlsx({
    shared: ['When'], numFmts: ['yyyy-mm-dd'], xfs: [0, 164],
    sheets: [{ name: 'D', xml: sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" s="1"><v>60</v></c></row>') }],
  })
  const r = await importXlsx(bytes, {})
  ok(readCell(r.sheets[0].data.when, 0) === '1900-02-29', 'serial 60 keeps the impossible date it was written as')
  ok(r.findings.some((f) => f.code === 'date-1900-bug'), 'and says so rather than moving it silently')
}

// --- SHARED FORMULAS, and the ones that must not go live
{
  const bytes = await buildXlsx({
    shared: ['A', 'B'],
    sheets: [{
      name: 'F',
      xml: sheetXml(
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2"><v>10</v></c><c r="B2"><f t="shared" si="0" ref="B2:B4">A2*2</f><v>20</v></c></row>' +
        '<row r="3"><c r="A3"><v>20</v></c><c r="B3"><f t="shared" si="0"/><v>40</v></c></row>' +
        '<row r="4"><c r="A4"><v>30</v></c><c r="B4"><f>Sheet2!A1*3</f><v>99</v></c></row>'),
    }],
  })
  const r = await importXlsx(bytes, {})
  const s = r.sheets[0]
  ok(s.cells?.['b:1']?.f === '=A1*2',
    'the shared-formula MASTER imports, shifted up by the header row (A2 → A1)')
  ok(s.cells?.['b:2']?.f === '=A2*2',
    'and its FOLLOWER is expanded by translation — otherwise 1 formula and N bare numbers arrive')
  ok(s.cells?.['b:3']?.f === undefined && s.cells?.['b:3']?.xlsxF === '=Sheet2!A1*3',
    'a cross-sheet formula is NOT made live — it would bind to this sheet — and its source is kept beside the value')
  ok(readCell(s.data.b, 2) === 99, 'and the value Excel last calculated is what the grid shows')
  ok(r.findings.some((f) => f.code === 'formula-not-live'), 'and the refusal is reported')
}

// --- merged cells, hidden sheets, no header, mixed types
{
  const bytes = await buildXlsx({
    shared: ['Quarterly report', 'Name', 'Value'],
    sheets: [
      {
        name: 'Merged',
        xml: sheetXml(
          // no header: row 1 already holds numbers
          '<row r="1"><c r="A1" t="s"><v>1</v></c><c r="B1"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>2</v></c></row>',
          '<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>'),
      },
      { name: 'Hidden', state: 'hidden', xml: sheetXml('<row r="1"><c r="A1"><v>7</v></c></row>') },
    ],
  })
  const r = await importXlsx(bytes, {})
  ok(r.findings.some((f) => f.code === 'merged-cells'),
    'merged ranges are reported — the value stays in the top-left cell, never spread across the range')
  ok(r.sheets.length === 2 && r.findings.some((f) => f.code === 'hidden-sheet'),
    'a hidden sheet is imported (hiding is not deleting) and reported')
  ok(r.findings.some((f) => f.code === 'no-header'),
    'a sheet whose first row is data says so instead of eating a row as a header')
}

{
  // A column that is half text and half numbers cannot be typed. Refuse.
  const bytes = await buildXlsx({
    shared: ['Mixed', 'n/a', 'tbd', 'later'],
    sheets: [{
      name: 'M',
      xml: sheetXml(
        '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
        '<row r="2"><c r="A2"><v>1</v></c></row>' +
        '<row r="3"><c r="A3"><v>2</v></c></row>' +
        '<row r="4"><c r="A4" t="s"><v>1</v></c></row>' +
        '<row r="5"><c r="A5" t="s"><v>2</v></c></row>'),
    }],
  })
  const r = await importXlsx(bytes, {})
  ok(r.sheets[0].columns[0].type === 'text' && r.findings.some((f) => f.code === 'mixed-types'),
    'a genuinely mixed column is imported as text and REPORTED, not silently typed to the majority')
}

{
  // 90% numbers with one word in it: typed, and the loss counted — import.ts's rule.
  const rows = ['<row r="1"><c r="A1" t="s"><v>0</v></c></row>']
  for (let i = 2; i <= 20; i++) rows.push(`<row r="${i}"><c r="A${i}"><v>${i}</v></c></row>`)
  rows.push('<row r="21"><c r="A21" t="s"><v>1</v></c></row>')
  const bytes = await buildXlsx({ shared: ['N', 'n/a'], sheets: [{ name: 'N', xml: sheetXml(rows.join('')) }] })
  const r = await importXlsx(bytes, {})
  ok(r.sheets[0].columns[0].type === 'number', 'a column that is 95% numbers is a number column')
  ok(r.sheets[0].columns[0].failed === 1 && r.findings.some((f) => f.code === 'coerce-failed'),
    'and the one value that would not coerce is COUNTED and reported, never hidden')
}

// --- findings do not become a wall
{
  // 12 unnamed columns of mixed data: one finding per column would be 24 lines
  // in a banner, and an unread warning is the same as an absent one.
  const rows = ['<row r="1">' + Array.from({ length: 12 }, (_, i) =>
    `<c r="${String.fromCharCode(65 + i)}1" t="str"><v></v></c>`).join('') + '</row>']
  for (let r = 2; r <= 5; r++) {
    rows.push(`<row r="${r}">` + Array.from({ length: 12 }, (_, i) =>
      r % 2 ? `<c r="${String.fromCharCode(65 + i)}${r}"><v>${r}</v></c>`
        : `<c r="${String.fromCharCode(65 + i)}${r}" t="str"><v>x</v></c>`).join('') + '</row>')
  }
  const r = await importXlsx(await buildXlsx({ sheets: [{ name: 'Wide', xml: sheetXml(rows.join('')) }] }), {})
  const mixed = r.findings.filter((f) => f.code === 'mixed-types')
  ok(mixed.length === 4 && /and 9 more columns/.test(mixed[3].message),
    'repeated findings collapse to the first three plus a count — the count is kept, the wall is not')
}

// --- the cellStyleXfs trap
{
  ok(_internals.readStyles(
    '<styleSheet><cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="9"/></cellXfs></styleSheet>').xf.length === 2,
    'readStyles indexes cellXfs ONLY — cellStyleXfs comes first and has the identical <xf> shape')
}

// ============================================================ EXPORT
//
// The doc under test carries one of everything the exporter has to decide about.

const doc: DashDoc = {
  format: 'bento/dash', version: 1, policy: 'bento-dash-1',
  docId: 'test-doc', title: 'Round trip',
  sheets: [{
    id: 'sheet-1', name: 'Pipeline', kind: 'table',
    rids: [[1, 3]],
    columns: [
      { id: 'region', name: 'Region', type: 'text' },
      { id: 'amount', name: 'Amount', type: 'money', unit: 'GBP', w: 96 },
      { id: 'share', name: 'Share', type: 'percent' },
      { id: 'when', name: 'When', type: 'date' },
      { id: 'live', name: 'Live', type: 'bool' },
      { id: 'adj', name: 'Adjusted', type: 'number' },
    ],
    data: {
      region: { enc: 'dict', dict: ['North', 'South'], idx: [0, 1, 0] },
      amount: { enc: 'raw', v: [1200.5, 3400, 900] },
      share: { enc: 'raw', v: [0.15, 0.5, 0.075] },
      when: { enc: 'raw', v: ['2023-03-15', '2023-03-16', '1900-01-01'] },
      live: { enc: 'raw', v: [true, false, true] },
      adj: { enc: 'raw', v: [10, 20, 30] },
    },
    // a per-cell formula on the last row of `adj`
    cells: { 'adj:3': { f: '=F1+F2' } },
    totals: { amount: 'sum', adj: 'max' },
    steps: [{ op: 'import', from: 'rig', at: '2026-08-04T00:00:00Z' }],
  } as TableSheet],
}

const exported = await exportXlsx(doc, {})
const xlsxPath = join(tmp, 'roundtrip.xlsx')
writeFileSync(xlsxPath, exported.bytes)

// --- a REAL unzip and a REAL zip library must accept the package
if (have('unzip', '-v')) {
  const out = execFileSync('unzip', ['-t', xlsxPath], { encoding: 'utf8' })
  ok(/No errors detected/.test(out), 'unzip -t accepts the exported .xlsx')
} else console.log('  SKIP  no unzip')

if (have('python3', '-V')) {
  const out = execFileSync('python3', ['-c',
    'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(len(z.namelist()))',
  xlsxPath], { encoding: 'utf8' })
  ok(Number(out.trim()) >= 7, 'python3 zipfile opens it and finds the OPC parts')
} else console.log('  SKIP  no python3')

// --- OPC / SpreadsheetML PACKAGE CONFORMANCE
//
// This block exists because LIBREOFFICE IS TOO LENIENT to be the only witness.
// Measured, as a negative control: delete every worksheet `<Override>` from
// [Content_Types].xml, or write a styles part with no `cellStyleXfs` and no
// fills, and LibreOffice still opens the file and converts it happily — while
// Excel shows the repair dialog, which is the thing this exporter is actually
// judged on and the thing there is no Excel on this machine to check.
//
// So the requirements Excel enforces are restated here, from the spec rather
// than from our own writer: an unnamed part, an unresolvable relationship, a
// style index past the end of cellXfs and a shared-string index past the end of
// the table are each a "we found a problem with some content" dialog.
{
  const { readZip } = await import('../dash/src/zip.ts')
  const pkg = await readZip(exported.bytes)
  const dec = new TextDecoder()
  const part = (n: string) => (pkg.has(n) ? dec.decode(pkg.get(n)!) : '')

  const ct = part('[Content_Types].xml')
  ok(ct.startsWith('<?xml'), '[Content_Types].xml is present')
  ok(exported.bytes.indexOf(enc.encode('[Content_Types].xml')[0]) >= 0 &&
    dec.decode(exported.bytes.subarray(30, 49)) === '[Content_Types].xml',
    'and it is the FIRST entry in the archive, which is the one ordering rule OPC states')
  ok(/Extension="rels"/.test(ct) && /Extension="xml"/.test(ct), 'with Defaults for rels and xml')

  const sheetParts = [...pkg.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
  ok(sheetParts.length === 1, 'one worksheet part for the one sheet')
  ok(sheetParts.every((p) => ct.includes(`PartName="/${p}"`) &&
    ct.includes('spreadsheetml.worksheet+xml')),
    'EVERY worksheet part has a content-type Override (Excel refuses a package with an untyped part)')
  for (const [p, type] of [
    ['/xl/workbook.xml', 'sheet.main+xml'],
    ['/xl/styles.xml', 'styles+xml'],
    ['/xl/sharedStrings.xml', 'sharedStrings+xml'],
  ]) {
    ok(ct.includes(`PartName="${p}"`) && ct.includes(type), `${p} is typed as ${type}`)
  }

  // every relationship resolves to a part that exists
  const rootRel = part('_rels/.rels')
  ok(/Target="xl\/workbook\.xml"/.test(rootRel) && /officeDocument/.test(rootRel),
    'the package relationship points at the workbook')
  const wbRels = part('xl/_rels/workbook.xml.rels')
  const targets = [...wbRels.matchAll(/Target="([^"]+)"/g)].map((m) => `xl/${m[1]}`)
  ok(targets.length >= 3 && targets.every((t) => pkg.has(t)),
    `every workbook relationship resolves to a part that exists (${targets.length} of them)`)
  const wb = part('xl/workbook.xml')
  const used = [...wb.matchAll(/r:id="([^"]+)"/g)].map((m) => m[1])
  ok(used.length > 0 && used.every((id) => wbRels.includes(`Id="${id}"`)),
    'and every r:id the workbook names is declared in its .rels')

  // styles: the parts Excel requires, and no index past the end
  const st = part('xl/styles.xml')
  ok(/<cellStyleXfs count="\d+">[\s\S]*<xf[^>]*\/>[\s\S]*<\/cellStyleXfs>/.test(st),
    'styles.xml carries a cellStyleXfs block with at least one xf (Excel repairs a file without it)')
  ok((st.match(/<fill>/g) ?? []).length >= 2 && /patternType="gray125"/.test(st),
    'and the two fills Excel requires, including the gray125 one nobody ever sees')
  const xfCount = (part('xl/styles.xml').match(/<cellXfs count="(\d+)"/) ?? [])[1]
  const sheet1 = part(sheetParts[0])
  const styleIdx = [...sheet1.matchAll(/\ss="(\d+)"/g)].map((m) => Number(m[1]))
  ok(styleIdx.length > 0 && styleIdx.every((i) => i < Number(xfCount)),
    `every cell style index is inside cellXfs (${styleIdx.length} cells, ${xfCount} xfs)`)

  // shared strings: every index resolves
  const sst = part('xl/sharedStrings.xml')
  const uniq = Number((sst.match(/uniqueCount="(\d+)"/) ?? [])[1])
  const sIdx = [...sheet1.matchAll(/t="s"><v>(\d+)</g)].map((m) => Number(m[1]))
  ok(sIdx.length > 0 && sIdx.every((i) => i < uniq),
    `every shared-string index resolves (${sIdx.length} references, ${uniq} strings)`)
  ok((sst.match(/<si>/g) ?? []).length === uniq, 'and uniqueCount matches the number of <si> elements')

  // rows ascending, cell refs on their own row — Excel is strict about both
  const rowNums = [...sheet1.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]))
  ok(rowNums.every((n, i) => i === 0 || n > rowNums[i - 1]), 'rows are written in ascending order')
  let refsOk = true
  for (const m of sheet1.matchAll(/<row r="(\d+)">([\s\S]*?)<\/row>/g)) {
    for (const c of m[2].matchAll(/<c r="([A-Z]+)(\d+)"/g)) if (c[2] !== m[1]) refsOk = false
  }
  ok(refsOk, 'and every cell reference names the row it is written in')
}

// --- LIBREOFFICE: the only check here that answers "does a real spreadsheet
//     application open this without a repair prompt?"
{
  const soffice = '/Applications/LibreOffice.app/Contents/MacOS/soffice'
  if (existsSync(soffice)) {
    const outDir = join(tmp, 'lo')
    execFileSync(soffice, [
      `-env:UserInstallation=file://${join(tmp, 'loprofile')}`,
      '--headless', '--convert-to', 'csv', '--outdir', outDir, xlsxPath,
    ], { stdio: 'ignore', timeout: 180_000 })
    const csvName = readdirSync(outDir).find((f) => f.endsWith('.csv'))
    const csv = csvName ? readFileSync(join(outDir, csvName), 'utf8') : ''
    ok(!!csv, 'LibreOffice opens the exported workbook and converts it')
    ok(/Region,Amount,Share,When,Live,Adjusted/.test(csv), 'with the header row intact')
    // LibreOffice renders through the number formats, so these assert the
    // FORMATS as well as the values.
    ok(/North/.test(csv) && /1200\.5|1,200\.50|£1,200\.50/.test(csv), 'the money value is there')
    ok(/2023-03-15/.test(csv), 'the date came out as a real date, on the right day')
    ok(/15\.0%|15%/.test(csv), 'and the percent renders as 15%, not 1500% or 0.15')
    ok(/TRUE/i.test(csv), 'booleans are booleans')
    // the totals row: SUM(B2:B4) = 5500.5, MAX(F2:F4) = 30 (F4 is =F1+F2 → 30)
    ok(/5500\.5|5,500\.50|£5,500\.50/.test(csv),
      'and LibreOffice CALCULATED the totals row from the SUM() we wrote')
    if (!/5500\.5|5,500\.50|£5,500\.50/.test(csv)) console.log(csv)
  } else console.log('  SKIP  LibreOffice is not installed — the "does it open" check needs it')
}

// --- ROUND TRIP: dash → xlsx → dash
{
  const back = await importXlsx(exported.bytes, {})
  const s = back.sheets[0]
  ok(s.name === 'Pipeline', 'the sheet name survives')
  ok(s.columns.map((c) => c.name).join() === 'Region,Amount,Share,When,Live,Adjusted',
    'every column name survives')
  ok(s.columns.map((c) => c.type).join() === 'text,money,percent,date,bool,number',
    'and every TYPE survives, because the export wrote number formats that say so')
  ok(readCell(s.data.region, 0) === 'North' && readCell(s.data.region, 1) === 'South',
    'a dictionary-encoded text column comes back')
  ok(readCell(s.data.amount, 0) === 1200.5, 'money values are exact')
  ok(readCell(s.data.share, 1) === 0.5, 'a percent is still a fraction after a full round trip')
  ok(readCell(s.data.when, 0) === '2023-03-15', 'a date comes back as the same day')
  ok(readCell(s.data.when, 2) === '1900-01-01',
    'INCLUDING a date before the phantom 29 February 1900, where a single epoch is off by one')
  ok(readCell(s.data.live, 0) === true && readCell(s.data.live, 1) === false, 'booleans survive')
  // the imported id is slugged from the column NAME, so `adj` comes back as `adjusted`
  ok(s.cells?.['adjusted:3']?.f === '=F1+F2',
    'and the per-cell formula comes back pointing at the SAME cells (down one row on the way out, up one on the way in)')
  ok(s.columns.find((c) => c.id === 'amount')?.w === 96 ||
    Math.abs((s.columns.find((c) => c.id === 'amount')?.w as number) - 96) <= 4,
    'column width survives the character↔pixel conversion within a few pixels')
}

// --- what the export refuses to guess at
{
  const withFormula: DashDoc = JSON.parse(JSON.stringify(doc))
  ;(withFormula.sheets[0] as TableSheet).columns.push({
    id: 'calc', name: 'Weighted', type: 'number', formula: 'Amount * Share',
  })
  const r1 = await exportXlsx(withFormula, {})
  ok(r1.findings.some((f) => f.code === 'formula-column'),
    'a COLUMN formula is reported rather than machine-translated into Excel syntax')
  const r2 = await exportXlsx(withFormula, {
    computed: { 'sheet-1': new Map([['calc', [180.075, 1700, 67.5]]]) },
  })
  const back = await importXlsx(r2.bytes, {})
  ok(readCell(back.sheets[0].data.weighted, 1) === 1700,
    'and when the editor hands the computed values in, the NUMBERS travel')
}

{
  const longName: DashDoc = JSON.parse(JSON.stringify(doc))
  longName.sheets[0].name = 'A sheet name far longer than thirty-one characters [really]'
  const r = await exportXlsx(longName, {})
  ok(r.findings.some((f) => f.code === 'renamed-sheet'),
    'an illegal sheet name is fixed and reported — Excel refuses to OPEN the file rather than warning')
  const back = await importXlsx(r.bytes, {})
  ok(back.sheets[0].name.length <= 31 && !/[[\]:*?/\\]/.test(back.sheets[0].name),
    'and the name it was given is legal')
}

ok(_internals.safeSheetName('a/b:c', new Set()) === 'a-b-c', 'the forbidden characters are replaced')
ok(_internals.safeSheetName('Sheet', new Set(['sheet'])) === 'Sheet 2', 'and a duplicate is disambiguated')
ok(xlsxFileName('Q1 / plan') === 'Q1 - plan.xlsx', 'the download name is filesystem-safe')

// =========================================== REAL .xlsx FILES OFF THIS MACHINE
{
  const candidates = [
    '/Users/andy/devel/sxadc/raw_categories.xlsx',
    '/Users/andy/Documents/Digitalise Growth-Initiatives-Cost-Model.xlsx',
    '/Users/andy/Downloads/Digital_Sonar_Resource_Validation_v5.xlsx',
  ].filter(existsSync)
  if (!candidates.length) console.log('  SKIP  no real .xlsx to import')
  for (const path of candidates) {
    const short = path.split('/').pop()!
    let r
    try {
      r = await importXlsx(new Uint8Array(readFileSync(path)), { source: short })
    } catch (e) {
      failures++; checks++
      console.log(`  FAIL  ${short}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    const rows = r.sheets.reduce((n, s) => n + s.rids.reduce((m, [, c]) => m + c, 0), 0)
    ok(r.sheets.length > 0 && rows > 0, `${short}: ${r.sheets.length} sheet(s), ${rows} rows`)
    // and the result must be a legal document
    const parsed = parseDoc(JSON.stringify({
      format: 'bento/dash', version: 1, docId: 'd', title: short, sheets: r.sheets,
    }))
    ok(parsed.ok === true, `${short}: parses as a bento/dash document`)
    // and it must export again without throwing
    const out = await exportXlsx(parsed.ok ? parsed.doc : ({} as DashDoc), {})
    ok(out.bytes.length > 0, `${short}: re-exports to a non-empty .xlsx`)
    if (have('unzip', '-v')) {
      const p = join(tmp, `re-${short}`)
      writeFileSync(p, out.bytes)
      ok(/No errors detected/.test(execFileSync('unzip', ['-t', p], { encoding: 'utf8' })),
        `${short}: and that re-export is a valid archive`)
    }
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
