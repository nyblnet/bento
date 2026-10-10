#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// pptx-write text rig: the inline-html tokenizer + the p:sp emitter.
//
//   node scripts/test-convert/pptx-text.ts     (Node ≥ 23.6 strips types natively)
//
// Emitted shapes are re-read through the convert engine's own PARSER
// (convert/src/xml.ts) — independent code with its own strict grammar,
// so escaping claims are round-trip facts, not string.includes hopes. The
// NEGATIVE controls each demonstrate a failure mode that was OBSERVED (the
// phantom trailing line is reproduced live by disabling the trim).

import { parseXml, descendants, kid, kids, attr, textOf, NS, type XElem } from '../../convert/src/xml.ts'
import { serialize, x } from '../../convert/src/xmlout.ts'
import { PML_XMLNS } from '../../convert/src/pptx-write/parts.ts'
import {
  parseInlineHtml, cssColor, textSp,
  type FieldValues, type TextElIn, type TextSpOpts,
} from '../../convert/src/pptx-write/text.ts'
import { Report } from '../../convert/src/report.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// A minimal, fully-typical bento text element; tests override what they probe.
function el(over: Partial<TextElIn> = {}): TextElIn {
  return {
    id: 'e1', x: 100, y: 50, w: 400, h: 120, rotation: 0, opacity: 1,
    html: 'Hello', fontSize: 24, fontFamily: 'Inter, sans-serif', fontWeight: 400,
    color: '#1E2A3A', align: 'left', valign: 'top', lineHeight: 1.25,
    ...over,
  }
}

const fields: FieldValues = {
  page: 6, pages: 12, title: 'Q3 & Q4 <Results>', date: new Date('2026-08-23T12:00:00'),
  author: 'Ada', company: 'Bento', subject: '', event: '',
}

function emit(e: TextElIn, over: Partial<TextSpOpts> = {}): XElem {
  const sp = textSp(e, { shapeId: 2, themeFontFamily: 'Arial', ...over })
  if (!sp) throw new Error('textSp returned null for a non-placeholder element')
  // wrap with the xmlns trio a real slide root declares, then re-parse
  const root = parseXml(serialize(x('root', PML_XMLNS, [sp])))
  const parsed = kid(root, NS.p, 'sp')
  if (!parsed) throw new Error('no p:sp in parsed output')
  return parsed
}

const runsOf = (sp: XElem) => descendants(sp, NS.a, 'r')
const rPrOf = (r: XElem) => kid(r, NS.a, 'rPr')

// --- tokenizer ---------------------------------------------------------------
console.log('tokenizer')

{
  const runs = parseInlineHtml('<b>x<i>y</i></b>')
  ok(runs.length === 2, 'nested <b>x<i>y</i></b> yields two runs')
  ok(runs[0].text === 'x' && runs[0].style.bold === true && !runs[0].style.italic, 'outer run is bold only')
  ok(runs[1].text === 'y' && runs[1].style.bold === true && runs[1].style.italic === true, 'inner run inherits bold and adds italic')
}
{
  // Literal C0 controls (a bad paste, a corrupt import) are scrubbed at
  // ingestion — the same fate the entity decoder gives &#7; — so one stray
  // byte costs a character, never the whole export at serialize time.
  const runs = parseInlineHtml('bad\x07paste')
  ok(runs.length === 1 && runs[0].text === 'badpaste', 'literal C0 control in html is scrubbed, run survives')
}
{
  const runs = parseInlineHtml('a<br>b')
  ok(runs.length === 2 && runs[0].breakAfter && !runs[1].breakAfter, 'br becomes a break flag between runs')
}
{
  const runs = parseInlineHtml('line1<div>line2</div><div>line3</div>')
  ok(runs.length === 3 && runs[0].breakAfter && runs[1].breakAfter && !runs[2].breakAfter,
    'contentEditable shape line1<div>line2</div><div>line3</div> keeps three lines (break on div OPEN too)')
}
{
  const runs = parseInlineHtml('<span>a</span><mark>b</mark>')
  ok(runs.length === 1 && runs[0].text === 'ab' && !runs[0].style.bold, 'span and unknown tags are transparent (children pass through)')
}
{
  const runs = parseInlineHtml('A &amp;&nbsp;B &lt;C&gt; &#66;')
  ok(runs[0].text === 'A & B <C> B', 'entities decode: named, nbsp survives collapse, numeric')
}
{
  const runs = parseInlineHtml('a \n\t  b')
  ok(runs.length === 1 && runs[0].text === 'a b', 'whitespace collapses to the painted form (white-space: normal)')
}

// --- trailing-break trim -----------------------------------------------------
console.log('trailing-break trim')

{
  // NEGATIVE control, observed live: WITHOUT the trim, contentEditable's
  // stray final <br> becomes a trailing a:br — a phantom empty line that
  // shifts bottom-anchored text a full line up.
  const untrimmed = parseInlineHtml('Hello<br>', false)
  ok(untrimmed.length === 1 && untrimmed[0].breakAfter === true,
    'NEGATIVE: without the trim the stray final <br> survives as a phantom line break')
  const trimmed = parseInlineHtml('Hello<br>')
  ok(trimmed.length === 1 && trimmed[0].breakAfter === false, 'the trim clears exactly that trailing break')
  const inner = parseInlineHtml('a<br>b')
  ok(inner[0].breakAfter === true, 'an interior break is untouched by the trim')
}
{
  const sp = emit(el({ html: 'Hello<br>' }))
  ok(descendants(sp, NS.a, 'br').length === 0, 'emitted txBody carries no trailing a:br')
  const sp2 = emit(el({ html: 'a<br>b' }))
  ok(descendants(sp2, NS.a, 'br').length === 1, 'interior a:br emitted between runs')
}

// --- escaping through the emitter, both directions ---------------------------
console.log('escaping')

{
  const nasty = 'Q3 & Q4 <Results> "final"'
  // direction 1: author text with live characters — sanitizer spells them as
  // entities; the tokenizer decodes, xmlout re-escapes, the parser gets the
  // original characters back
  const sp = emit(el({ html: 'Q3 &amp; Q4 &lt;Results&gt; "final"' }))
  const r = runsOf(sp)[0]
  ok(textOf(kid(r, NS.a, 't')!) === nasty, 'entity input round-trips to live characters through parseXml')
  const xml = serialize(textSp(el({ html: 'Q3 &amp; Q4 &lt;Results&gt;' }), { shapeId: 2, themeFontFamily: 'Arial' })!)
  ok(xml.includes('&amp;') && xml.includes('&lt;') && !xml.includes('<Results>'), 'the escapes are in the output bytes (direction 2)')
}

// --- field mapping -----------------------------------------------------------
console.log('dynamic fields')

{
  const sp = emit(el({ html: '{{page}} of {{pages}}' }), { fields })
  const flds = descendants(sp, NS.a, 'fld')
  ok(flds.length === 1 && attr(flds[0], 'type') === 'slidenum', '{{page}} becomes a live a:fld type="slidenum"')
  ok(textOf(kid(flds[0], NS.a, 't')!) === '6', 'slidenum field caches the resolved page number')
  ok(/^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/.test(attr(flds[0], 'id') ?? ''), 'field id is GUID-shaped')
  const texts = runsOf(sp).map((r) => textOf(kid(r, NS.a, 't')!))
  ok(texts.join('|') === ' of |12', '{{pages}} freezes to literal text around the field')
}
{
  const sp = emit(el({ html: '{{date}}' }), { fields })
  const fld = descendants(sp, NS.a, 'fld')[0]
  ok(attr(fld, 'type') === 'datetime' && textOf(kid(fld, NS.a, 't')!).length > 0, '{{date}} becomes a:fld type="datetime" with cached text')
}
{
  const sp = emit(el({ html: 'by {{author}} — {{title}}' }), { fields })
  const t = runsOf(sp).map((r) => textOf(kid(r, NS.a, 't')!)).join('')
  ok(t === 'by Ada — Q3 & Q4 <Results>', 'doc-prop tokens resolve to literals, live characters intact')
}
{
  const report = new Report()
  emit(el({ html: 'p. {{page:2}}' }), { fields, report, where: 'slide 1' })
  const built = report.build()
  ok(descendants(emit(el({ html: 'p. {{page:2}}' }), { fields }), NS.a, 'fld').length === 1
    && built.entries.some((e) => e.code === 'text-field-pad-lost'),
    '{{page:2}} stays a live field and the lost zero-pad is reported')
}
{
  const sp = emit(el({ html: '{{page}} intact' })) // no fields ctx
  ok(descendants(sp, NS.a, 'fld').length === 0
    && runsOf(sp).map((r) => textOf(kid(r, NS.a, 't')!)).join('') === '{{page}} intact',
    'NEGATIVE: without a field context tokens stay literal (resolveFields parity)')
}

// --- centipoints and percentages ---------------------------------------------
console.log('unit arithmetic')

{
  const sp = emit(el({ fontSize: 24, letterSpacing: 3, lineHeight: 1.5 }))
  const rPr = rPrOf(runsOf(sp)[0])!
  ok(attr(rPr, 'sz') === '1800', 'fontSize 24px → 18pt → sz="1800" centipoints')
  ok(attr(rPr, 'spc') === '225', 'letterSpacing 3px → 2.25pt → spc="225" centipoints (uncapped, unlike #88)')
  const spcPct = descendants(sp, NS.a, 'spcPct')[0]
  ok(attr(spcPct, 'val') === '150000', 'lineHeight 1.5 → a:spcPct val="150000" (1000ths of a percent)')
}
{
  const sp = emit(el({ fontSize: 18 }))
  ok(attr(rPrOf(runsOf(sp)[0])!, 'sz') === '1350', 'fontSize 18px → 13.5pt → sz="1350" (fractional pt lands exactly in centipoints)')
}

// --- geometry, rotation, opacity ---------------------------------------------
console.log('frame')

{
  const sp = emit(el({ x: 100, y: 50, w: 400, h: 120, rotation: 45 }))
  const xfrm = descendants(sp, NS.a, 'xfrm')[0]
  const off = kid(xfrm, NS.a, 'off')!
  const ext = kid(xfrm, NS.a, 'ext')!
  ok(attr(off, 'x') === String(100 * 9525) && attr(off, 'y') === String(50 * 9525), 'px → EMU offsets (×9525)')
  ok(attr(ext, 'cx') === String(400 * 9525) && attr(ext, 'cy') === String(120 * 9525), 'px → EMU extents')
  ok(attr(xfrm, 'rot') === '2700000', 'rotation 45° → rot="2700000" (60000ths of a degree)')
  ok(attr(descendants(emit(el()), NS.a, 'xfrm')[0], 'rot') === undefined, 'rotation 0 omits rot (native shape)')
  ok(attr(descendants(emit(el({ rotation: -90 })), NS.a, 'xfrm')[0], 'rot') === '16200000', 'negative rotation normalizes to 0..360')
}
{
  const sp = emit(el({ color: 'rgba(255,0,0,0.5)', opacity: 0.5 }))
  const srgb = descendants(sp, NS.a, 'srgbClr')[0]
  ok(attr(srgb, 'val') === 'FF0000', 'rgba red → srgbClr FF0000')
  ok(attr(kid(srgb, NS.a, 'alpha')!, 'val') === '25000', 'color alpha × element opacity compose: 0.5·0.5 → a:alpha 25000')
  ok(cssColor('#1E2A3A').hex === '1E2A3A' && cssColor('#1E2A3A').alpha === 1, 'hex parses opaque')
  ok(cssColor('bogus(1,2)').hex === '000000', 'NEGATIVE: unparseable colour falls back instead of emitting garbage')
}

// --- element-level style, alignment, anchoring -------------------------------
console.log('style plumbing')

{
  const sp = emit(el({ fontWeight: 700, align: 'center', valign: 'bottom', fontFamily: '"Space Grotesk", sans-serif' }))
  ok(attr(rPrOf(runsOf(sp)[0])!, 'b') === '1', 'fontWeight 700 → b="1" (#88 threshold ≥600)')
  ok(attr(descendants(sp, NS.a, 'pPr')[0], 'algn') === 'ctr', 'align center → algn="ctr"')
  const bodyPr = descendants(sp, NS.a, 'bodyPr')[0]
  ok(attr(bodyPr, 'anchor') === 'b', 'valign bottom → bodyPr anchor="b"')
  ok(attr(bodyPr, 'lIns') === '0' && kid(bodyPr, NS.a, 'normAutofit') !== undefined, 'zero insets + normAutofit (#88 margin:0 / fit:shrink)')
  ok(attr(kid(rPrOf(runsOf(sp)[0])!, NS.a, 'latin')!, 'typeface') === 'Space Grotesk', 'first family, quotes stripped → a:latin')
}
{
  const sp = emit(el({ html: '<u>u</u><s>s</s><code>c</code>' }))
  const [u, s, c] = runsOf(sp)
  ok(attr(rPrOf(u)!, 'u') === 'sng', '<u> → u="sng"')
  ok(attr(rPrOf(s)!, 'strike') === 'sngStrike', '<s> → strike="sngStrike" (beyond #88: PptxGenJS had no strike)')
  ok(attr(kid(rPrOf(c)!, NS.a, 'latin')!, 'typeface') === 'Courier New', '<code> → Courier New (#88 mapping)')
}
{
  const sp = emit(el({ textStroke: { width: 2, color: '#F7A600', fill: 'none' } }))
  const rPr = rPrOf(runsOf(sp)[0])!
  const ln = kid(rPr, NS.a, 'ln')!
  ok(attr(ln, 'w') === String(2 * 9525), 'textStroke width 2px → a:ln w in EMU')
  ok(kid(rPr, NS.a, 'noFill') !== undefined, "textStroke fill:'none' → hollow glyphs via a:noFill interior")
}
{
  const sp = emit(el(), { link: { rId: 'rId7', slideJump: true } })
  const hl = kid(rPrOf(runsOf(sp)[0])!, NS.a, 'hlinkClick')!
  ok(attr(hl, 'id') === 'rId7' && attr(hl, 'action') === 'ppaction://hlinksldjump',
    'link rides on every run rPr (#88 per-run fix) with the slide-jump action')
}

// --- placeholder skip and shape identity -------------------------------------
console.log('shape identity')

{
  ok(textSp(el({ html: '  <br> ', placeholder: 'Click to add title' }), { shapeId: 2, themeFontFamily: 'Arial' }) === null,
    'NEGATIVE: unfilled placeholder exports nothing (#88 skip — present mode hides it too)')
  ok(textSp(el({ html: 'Real title', placeholder: 'Click to add title' }), { shapeId: 2, themeFontFamily: 'Arial' }) !== null,
    'a FILLED placeholder exports normally')
  const sp = emit(el({ id: 'e1', morphId: 'tile-a' }), { shapeId: 9 })
  const cNvPr = descendants(sp, NS.p, 'cNvPr')[0]
  ok(attr(cNvPr, 'id') === '9' && attr(cNvPr, 'name') === 'bento:tile-a', 'cNvPr carries the allocated id and bento:<morph key> name (#88)')
  const empty = emit(el({ html: '' }))
  ok(kids(kid(kid(empty, NS.p, 'txBody')!, NS.a, 'p')!, NS.a, 'r').length === 0
    && kid(empty, NS.p, 'txBody') !== undefined, 'empty text still emits a txBody with one (empty) a:p')
}

console.log(`\n${checks} checks, ${failures} failing`)
process.exit(failures ? 1 : 0)
