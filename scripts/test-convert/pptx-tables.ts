#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// pptx-write table-mapper rig: tables.ts.
//
//   node scripts/test-convert/pptx-tables.ts     (Node ≥ 23.6 strips types natively)
//
// Emitted graphicFrames are re-read with the convert engine's own parser
// (convert/src/xml.ts) — same posture as pptx-parts: not proof
// PowerPoint accepts the file, but every claim checked (grid sums, schema
// child order in tcPr, escaping, cell counts) is one PowerPoint validates.
// The NEGATIVE controls are computations verified to fail: naive per-column
// rounding really does lose an EMU, and PR #88's zebra parity really does
// stripe the wrong rows on a header-less table.

import { parseXml, kids, kid, attr, textOf, descendants, NS, type XElem } from '../../convert/src/xml.ts'
import { serialize, x } from '../../convert/src/xmlout.ts'
import { Report } from '../../convert/src/report.ts'
import { EMU_PER_PX, type OutTable } from '../../convert/src/types.ts'
import {
  tableFrame, splitEmu, htmlParagraphs, cssSolid, TABLE_GRAPHIC_URI,
} from '../../convert/src/pptx-write/tables.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

function throws(fn: () => unknown, msg: string) {
  let threw = false
  try { fn() } catch { threw = true }
  ok(threw, msg)
}

/** Wrap a frame in a root that declares the conventional prefixes — a slide
 *  root does this in the real package; the rig parses frames standalone. */
const parseFrame = (frame: ReturnType<typeof x>): XElem =>
  kids(parseXml(serialize(x('root', { 'xmlns:a': NS.a, 'xmlns:p': NS.p, 'xmlns:r': NS.r }, [frame]))))[0]

const baseTable = (over: Partial<OutTable> = {}): OutTable => ({
  id: 't1', type: 'table',
  x: 100, y: 80, w: 600, h: 300, rotation: 0, opacity: 1,
  columns: [{ w: 2 }, { w: 1 }, { w: 1 }],
  header: true,
  rows: [
    { cells: [{ html: 'Region' }, { html: 'Q3' }, { html: 'Q4' }] },
    { cells: [{ html: 'EMEA &amp; APAC' }, { html: '1,204', align: 'center' }, { html: '9<br>ish' }] },
    { cells: [{ html: 'AMER' }, { html: '388' }] }, // ragged on purpose
  ],
  style: {
    headerBg: '#1E2A3A', headerColor: '#FFFFFF', zebra: 'rgba(30,42,58,0.05)',
    borderColor: '#C9CFD6', borderWidth: 2, cellPadX: 16, cellPadY: 11,
    fontSize: 18, color: '#1E2A3A', radius: 0, fontFamily: '"Inter", sans-serif',
  },
  ...over,
})

// --- splitEmu ----------------------------------------------------------------
console.log('splitEmu (drift-free grid arithmetic)')

{
  const parts = splitEmu([1, 1, 1], 100)
  ok(parts.reduce((a, b) => a + b, 0) === 100, 'three equal thirds of 100 sum to exactly 100')
  ok(parts.join(',') === '33,34,33', 'the extra unit lands mid-sequence (cumulative-edge rounding)')
  // NEGATIVE control, seen to fail: the naive per-part computation loses a unit.
  const naive = [1, 1, 1].map(() => Math.round(100 / 3))
  ok(naive.reduce((a, b) => a + b, 0) !== 100, 'NEGATIVE: naive per-column rounding does NOT sum to the total')

  const awkward = splitEmu([0.37, 1.21, 0.055, 2.9], 5715001)
  ok(awkward.reduce((a, b) => a + b, 0) === 5715001, 'awkward fractional weights still sum exactly (odd EMU total)')
  ok(splitEmu([0, 1], 1000).join(',') === '0,1000', 'zero-weight column keeps a zero-width gridCol (cell counts must match)')
  ok(splitEmu([-2, 1], 1000)[0] === 0, 'negative weight clamps to a zero-width column instead of corrupting the sum')
}

// --- htmlParagraphs / cssSolid ------------------------------------------------
console.log('cell text + colour helpers')

{
  ok(htmlParagraphs('<b>Bold</b> &amp; <i>quiet</i>').join('|') === 'Bold & quiet', 'tags strip, entities decode')
  ok(htmlParagraphs('line1<br>line2').join('|') === 'line1|line2', '<br> splits paragraphs')
  ok(htmlParagraphs('tail<br><br>').join('|') === 'tail', 'trailing empties drop')
  ok(htmlParagraphs('a<br><br>b').length === 3, 'interior blank paragraph survives (deliberate empty line)')
  ok(htmlParagraphs('&#x2192; &#65;').join('') === '→ A', 'numeric character references decode (hex + decimal)')
  ok(htmlParagraphs('&bogus;').join('') === '&bogus;', 'unknown named entity passes through literally')

  ok(cssSolid('rgba(30,42,58,0.05)', '000000').hex === '1E2A3A', 'rgba() → hex')
  ok(Math.abs(cssSolid('rgba(30,42,58,0.05)', '000000').alpha - 0.05) < 1e-9, 'rgba() alpha separates from the colour')
  ok(cssSolid('#abc', '000000').hex === 'AABBCC', 'short hex expands')
  ok(cssSolid('transparent', 'FFFFFF').alpha === 0, 'transparent = alpha 0 (emit no fill)')
  ok(cssSolid('conic-gradient(red, blue)', 'ABCDEF').hex === 'ABCDEF', 'unparseable colour falls back instead of corrupting')
}

// --- the full frame ----------------------------------------------------------
console.log('tableFrame')

{
  const report = new Report()
  const el = baseTable()
  const frame = parseFrame(tableFrame(el, 7, report, 'slide 2'))

  ok(frame.ns === NS.p && frame.local === 'graphicFrame', 'root is p:graphicFrame')
  ok(attr(kid(kid(frame, NS.p, 'nvGraphicFramePr')!, NS.p, 'cNvPr')!, 'id') === '7', 'cNvPr carries the caller shape id')
  ok(attr(kid(kid(frame, NS.p, 'nvGraphicFramePr')!, NS.p, 'cNvPr')!, 'name') === 'bento:t1', 'name carries the bento identity (#88 objectName convention)')
  const xfrm = kid(frame, NS.p, 'xfrm')!
  ok(attr(kid(xfrm, NS.a, 'off')!, 'x') === String(100 * EMU_PER_PX), 'p:xfrm offset in EMU')
  const gd = kid(kid(frame, NS.a, 'graphic')!, NS.a, 'graphicData')!
  ok(attr(gd, 'uri') === TABLE_GRAPHIC_URI, 'graphicData carries the table uri')

  const tbl = kid(gd, NS.a, 'tbl')!
  const tblPr = kid(tbl, NS.a, 'tblPr')!
  ok(attr(tblPr, 'firstRow') === '1' && attr(tblPr, 'bandRow') === '1', 'header → firstRow, zebra → bandRow')

  // Grid: EMU integers summing exactly to the frame width, 2:1:1.
  const cx = Math.round(600 * EMU_PER_PX)
  const cols = kids(kid(tbl, NS.a, 'tblGrid')!, NS.a, 'gridCol').map((c) => Number(attr(c, 'w')))
  ok(cols.length === 3, 'one gridCol per column')
  ok(cols.reduce((a, b) => a + b, 0) === cx, `gridCol widths sum exactly to the frame width (${cx} EMU)`)
  ok(cols[0] === cols[1] + cols[2], 'weights honoured (2 = 1 + 1)')
  ok(cols.every((w) => Number.isInteger(w)), 'widths are integers (EMU never fractional)')

  // Rows: heights sum to the frame height; ragged row padded to grid width.
  const trs = kids(tbl, NS.a, 'tr')
  ok(trs.length === 3, 'one a:tr per model row')
  ok(trs.map((t) => Number(attr(t, 'h'))).reduce((a, b) => a + b, 0) === Math.round(300 * EMU_PER_PX),
    'row heights sum exactly to the frame height')
  ok(trs.every((t) => kids(t, NS.a, 'tc').length === 3, ), 'every row carries exactly gridCol-many cells (ragged row padded)')

  const cellAt = (r: number, c: number) => kids(trs[r], NS.a, 'tc')[c]
  const tcPrOf = (r: number, c: number) => kid(cellAt(r, c), NS.a, 'tcPr')!
  const fillHex = (tcPr: XElem) => {
    const f = kid(tcPr, NS.a, 'solidFill')
    return f ? attr(kid(f, NS.a, 'srgbClr')!, 'val') : undefined
  }

  // Header row: bold, header colours.
  const hdrRun = descendants(cellAt(0, 0), NS.a, 'rPr')[0]
  ok(attr(hdrRun, 'b') === '1', 'header row runs are bold')
  ok(attr(hdrRun, 'sz') === '1350', 'font size 18px → 13.5pt → sz=1350 centipoints')
  ok(attr(kid(hdrRun, NS.a, 'latin')!, 'typeface') === 'Inter', 'first font family, quotes stripped, on the run')
  ok(fillHex(tcPrOf(0, 0)) === '1E2A3A', 'header cell fill = headerBg')
  ok(attr(kid(descendants(cellAt(0, 0), NS.a, 'solidFill')[0], NS.a, 'srgbClr')!, 'val') === 'FFFFFF',
    'header text colour = headerColor')

  // tcPr: schema order (borders BEFORE fill), margins, anchor.
  {
    const tcPr = tcPrOf(0, 0)
    const order = kids(tcPr).map((k) => k.local)
    ok(order.join(',') === 'lnL,lnR,lnT,lnB,solidFill', 'tcPr children in schema order: borders then fill')
    ok(attr(tcPr, 'marL') === String(16 * EMU_PER_PX) && attr(tcPr, 'marT') === String(11 * EMU_PER_PX),
      'cell padding → margins in EMU')
    ok(attr(tcPr, 'anchor') === 'ctr', 'cells anchor centre (browser td default bento renders with)')
    const ln = kid(tcPr, NS.a, 'lnL')!
    ok(attr(ln, 'w') === String(2 * EMU_PER_PX), 'border width 2px → EMU on every side')
    ok(attr(kid(kid(ln, NS.a, 'solidFill')!, NS.a, 'srgbClr')!, 'val') === 'C9CFD6', 'border colour carried')
  }

  // Zebra with a header: body rows count below the header, odd ones stripe.
  ok(fillHex(tcPrOf(1, 0)) === undefined, 'first body row (bodyIndex 0) unstriped — transparent means NO fill node')
  ok(fillHex(tcPrOf(2, 0)) === '1E2A3A', 'second body row (bodyIndex 1) striped with the zebra colour')
  {
    const stripe = kid(kid(tcPrOf(2, 0), NS.a, 'solidFill')!, NS.a, 'srgbClr')!
    ok(attr(kid(stripe, NS.a, 'alpha')!, 'val') === '5000', 'zebra rgba alpha 0.05 → a:alpha val=5000')
  }

  // Cell content: entities, alignment, <br> paragraphs.
  ok(textOf(descendants(cellAt(1, 0), NS.a, 't')[0]) === 'EMEA & APAC', '&amp; decodes then re-escapes cleanly through the emitter')
  ok(attr(descendants(cellAt(1, 1), NS.a, 'pPr')[0], 'algn') === 'ctr', 'cell align=center → pPr algn=ctr')
  ok(kids(kid(cellAt(1, 2), NS.a, 'txBody')!, NS.a, 'p').length === 2, '<br> in a cell = two a:p paragraphs')

  ok(report.build().entries.length === 0, 'clean table adds no report entries')
}

{
  // Zebra parity WITHOUT a header — the case that separates render.ts's rule
  // (bodyIndex odd) from PR #88's (raw index even). render.ts is the
  // on-screen truth; under #88's parity these two assertions fail.
  const report = new Report()
  const el = baseTable({
    header: false,
    rows: [0, 1, 2, 3].map((i) => ({ cells: [{ html: `r${i}` }, { html: '' }, { html: '' }] })),
  })
  const tbl = kid(kid(kid(parseFrame(tableFrame(el, 2, report, 'slide 1')), NS.a, 'graphic')!, NS.a, 'graphicData')!, NS.a, 'tbl')!
  const rowFill = (r: number) => kid(kid(kids(kids(tbl, NS.a, 'tr')[r], NS.a, 'tc')[0], NS.a, 'tcPr')!, NS.a, 'solidFill')
  ok(rowFill(0) === undefined && rowFill(2) === undefined, 'NEGATIVE (#88 parity): even rows of a header-less table are NOT striped')
  ok(rowFill(1) !== undefined && rowFill(3) !== undefined, 'header-less table stripes odd rows, matching render.ts')
  ok(attr(kid(tbl, NS.a, 'tblPr')!, 'firstRow') === undefined, 'no header → no firstRow flag')
}

{
  // Opacity folds into every colour; rotation and radius report.
  const report = new Report()
  const el = baseTable({ opacity: 0.5, rotation: 15 })
  ;(el.style as Record<string, unknown>).radius = 10
  const frame = parseFrame(tableFrame(el, 2, report, 'slide 3'))
  const firstFill = descendants(frame, NS.a, 'solidFill')[0]
  ok(attr(kid(kid(firstFill, NS.a, 'srgbClr')!, NS.a, 'alpha')!, 'val') === '50000',
    'element opacity 0.5 → a:alpha val=50000 on fills (#88 combineTransparency semantics)')
  const codes = report.build().entries.map((e) => `${e.verdict}:${e.code}`).sort()
  ok(codes.join(' ') === 'dropped:table-radius-dropped dropped:table-rotation-dropped',
    'rotation and radius each report as dropped')
}

{
  // Sparse style object: defaults fill in (mirroring slides DEFAULT_TABLE_STYLE).
  const report = new Report()
  const el = baseTable({ style: undefined })
  const frame = parseFrame(tableFrame(el, 2, report, 'slide 1'))
  ok(attr(descendants(frame, NS.a, 'rPr')[0], 'sz') === '1350', 'missing style → default 18px font (sz=1350)')
  ok(descendants(frame, NS.a, 'lnL').length > 0, 'missing style → default 1px border still drawn')
}

// A C0 control character in AUTHOR text is scrubbed at ingestion (one bad
// pasted byte costs a character, not the export) — while the emitter's own
// throwing guard still backstops the part. If the scrub ever disappears,
// serialize throws here and this block fails loudly instead of shipping a
// part PowerPoint refuses.
{
  const el = baseTable()
  el.rows[1].cells[0].html = 'bad\x07cell'
  const xml = serialize(x('root', { 'xmlns:a': NS.a, 'xmlns:p': NS.p, 'xmlns:r': NS.r }, [tableFrame(el, 2, new Report(), 'slide 1')]))
  ok(xml.includes('badcell') && !xml.includes('\x07'),
    'a C0 control character in cell text is scrubbed at ingestion (export survives, char is gone)')
}

console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) process.exit(1)
