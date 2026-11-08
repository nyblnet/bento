#!/usr/bin/env node
// @bundle
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The Word writer, first stage: bento/type → .docx through typeToDocx, the
// composer the CLI and the page will call (so type's own parseDoc and built-in
// styles are in the loop, not a copy of them).
//
// Each section reads the PACKAGE back — zip, XML, namespaces resolved — and
// asserts the Word structure a reader acts on: style ids and outline levels,
// numbering instances, run properties, hyperlink rels, revision marks, page
// geometry in twips. The self-check (docx-write/verify.ts) gets a negative
// control per rule: a package mutated to break it must be caught.
//
// Bundled (`// @bundle`) because the composer reaches deliver.ts, whose slides
// imports are extensionless.
//
// What this rig does NOT prove: that Word opens the file without repairing it.
// The schema check (the ECMA-376 transitional XSDs) and LibreOffice's reading
// (soffice --convert-to html) are run by hand for every writer change and
// cited in the PR; the Word open is the maintainer's, before the export row
// goes live.

import { readZip, type ZipParts } from '../../kernel/src/convert/zip.ts'
import { parseXml, descendants, attr, kids, textOf, type XElem } from '../../convert/src/xml.ts'
import { typeToDocx } from '../../convert/src/export-docx.ts'
import { docxProblems } from '../../convert/src/docx-write/verify.ts'
import { wordFont, hexColor } from '../../convert/src/docx-write/index.ts'
import { W_NS } from '../../convert/src/docx-write/parts.ts'
import type { FidelityReport } from '../../convert/src/report.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const dec = new TextDecoder()
const enc = new TextEncoder()
const AT = new Date(2026, 0, 1)
const partText = (parts: ZipParts, name: string): string => dec.decode(parts.get(name) ?? new Uint8Array())
const xml = (parts: ZipParts, name: string): XElem => parseXml(partText(parts, name))
const W = (el: XElem, local: string) => descendants(el, W_NS, local)
const val = (el: XElem | undefined) => (el ? attr(el, 'w:val') : undefined)
const codes = (r: FidelityReport) => new Set(r.entries.map((e) => e.code))

interface Block { id: string; kind: string; text: string; [k: string]: unknown }
const doc = (body: Block[], extra: Record<string, unknown> = {}) => ({
  format: 'bento/type', version: 1, docId: 'doc-1', title: 'A title',
  page: { width: 816, height: 1056, marginX: 104, marginTop: 104, marginBottom: 104 },
  footnotes: {}, revisions: [], signatures: {}, body, ...extra,
})

async function out(d: unknown) {
  const r = await typeToDocx(JSON.stringify(d), { at: AT })
  const parts = await readZip(r.bytes)
  return { ...r, parts, body: xml(parts, 'word/document.xml'), styles: xml(parts, 'word/styles.xml') }
}

/** The w:p elements of the body, in order. */
const paras = (body: XElem) => W(body, 'p')
/** A paragraph's visible text (w:t only — deleted text is w:delText). */
const ptext = (p: XElem) => W(p, 't').map(textOf).join('')
const pstyle = (p: XElem) => val(W(p, 'pStyle')[0])
const styleById = (styles: XElem, id: string) => W(styles, 'style').find((s) => attr(s, 'w:styleId') === id)
/** The run whose text is exactly `t`. */
const runWith = (body: XElem, t: string) => W(body, 'r').find((r) => W(r, 't').map(textOf).join('') === t)

// ---------------------------------------------------------------------------
console.log('the package is complete and passes its own check')
{
  const r = await out(doc([{ id: 'a', kind: 'para', text: 'Hello' }]))
  const names = [...r.parts.keys()]
  ok(names[0] === '[Content_Types].xml', '[Content_Types].xml is the first part')
  for (const p of ['word/document.xml', 'word/styles.xml', 'word/settings.xml', 'word/webSettings.xml', 'word/fontTable.xml', 'docProps/core.xml', 'docProps/app.xml', '_rels/.rels', 'word/_rels/document.xml.rels'])
    ok(r.parts.has(p), `has ${p}`)
  ok(!r.parts.has('word/numbering.xml'), 'no numbering.xml when there is no list (Word writes none either)')
  ok(docxProblems(r.parts).length === 0, `the self-check finds nothing (${docxProblems(r.parts).join('; ') || 'none'})`)
  ok(ptext(paras(r.body)[0]) === 'Hello', 'the text is in the body')
  const compat = W(xml(r.parts, 'word/settings.xml'), 'compatSetting')[0]
  ok(attr(compat, 'w:name') === 'compatibilityMode' && attr(compat, 'w:val') === '15', 'compatibility mode 15, so Word does not open it in Compatibility Mode')
  const core = partText(r.parts, 'docProps/core.xml')
  ok(core.includes('<dc:title>A title</dc:title>'), 'the title is the document title property')
  const again = await typeToDocx(JSON.stringify(doc([{ id: 'a', kind: 'para', text: 'Hello' }])), { at: AT })
  ok(Buffer.from(again.bytes).equals(Buffer.from(r.bytes)), 'two exports of one document are byte-identical')
}

// ---------------------------------------------------------------------------
console.log('block kinds map to Word\'s built-in styles')
{
  const r = await out(doc([
    { id: 'a', kind: 'h1', text: 'One' }, { id: 'b', kind: 'h2', text: 'Two' }, { id: 'c', kind: 'h3', text: 'Three' },
    { id: 'd', kind: 'para', text: 'Body' }, { id: 'e', kind: 'quote', text: 'Quoted' }, { id: 'f', kind: 'caption', text: 'Table 1', caption: { kind: 'table' } },
  ]))
  const ps = paras(r.body)
  ok(pstyle(ps[0]) === 'Heading1' && pstyle(ps[1]) === 'Heading2' && pstyle(ps[2]) === 'Heading3', 'h1–h3 → Heading1–3')
  ok(pstyle(ps[3]) === undefined, 'a paragraph is Normal (no pStyle, as Word writes it)')
  ok(pstyle(ps[4]) === 'Quote' && pstyle(ps[5]) === 'Caption', 'quote → Quote, caption → Caption')
  for (const [id, lvl] of [['Heading1', '0'], ['Heading2', '1'], ['Heading3', '2']] as const)
    ok(val(W(styleById(r.styles, id)!, 'outlineLvl')[0]) === lvl, `${id} has outline level ${lvl}, so Word's navigation pane and contents see it`)
  const h1 = styleById(r.styles, 'Heading1')!
  ok(val(W(h1, 'name')[0]) === 'heading 1', "Heading1 carries Word's built-in name")
  ok(val(W(h1, 'sz')[0]) === '39' && W(h1, 'b').length === 1, "Heading1 is type's 26px semibold: 39 half-points, bold")
  ok(val(W(h1, 'jc')[0]) === 'left', 'headings are not justified (Normal is)')
  ok(val(W(styleById(r.styles, 'Heading3')!, 'color')[0]) === '3A3D44', "Heading3 keeps type's ink-2 colour")
  const normal = styleById(r.styles, 'Normal')!
  ok(attr(normal, 'w:default') === '1' && val(W(normal, 'jc')[0]) === 'both', 'Normal is the default style and justified, as type is')
  ok(attr(W(normal, 'spacing')[0], 'w:after') === '150' && attr(W(normal, 'spacing')[0], 'w:line') === '389', "Normal: 10px after (150 twips), line 1.62 (389)")
  const rpr = W(W(r.styles, 'rPrDefault')[0], 'rFonts')[0]
  ok(attr(rpr, 'w:ascii') === 'Palatino Linotype', "the default face is type's stack's first face Word has: Palatino Linotype")
  ok(val(W(W(r.styles, 'rPrDefault')[0], 'sz')[0]) === '26', 'the default size is 17px = 26 half-points')
  ok(codes(r.report).has('font-substituted'), 'and the substitution (Iowan Old Style) is reported')
}

// ---------------------------------------------------------------------------
console.log('named styles: overrides of the built-ins, and the document\'s own')
{
  const r = await out(doc([
    { id: 'a', kind: 'h1', text: 'Big' },
    { id: 'b', kind: 'h2', text: 'Fancy', styleId: 'mine' },
    { id: 'c', kind: 'para', text: 'Unknown style', styleId: 'gone' },
  ], {
    styles: {
      'default-h1': { id: 'default-h1', kind: 'h1', name: 'Heading 1', size: 30, weight: 700 },
      mine: { id: 'mine', kind: 'h2', name: 'heading 1', family: 'Georgia, serif', color: 'rgb(200, 0, 0)', italic: true, sa: 20 },
    },
  }))
  ok(val(W(styleById(r.styles, 'Heading1')!, 'sz')[0]) === '45', 'an edited built-in (Heading 1 at 30px) changes Heading1 itself')
  const ps = paras(r.body)
  ok(pstyle(ps[1]) === 'Bento1', "a block's own style is written as its own Word style")
  const mine = styleById(r.styles, 'Bento1')!
  ok(val(W(mine, 'basedOn')[0]) === 'Heading2', 'based on the Word style of its kind (Heading2), so it is still a heading')
  ok(val(W(mine, 'name')[0]) === 'heading 1 (bento)', "a name that collides with Word's own is made distinct")
  ok(attr(W(mine, 'rFonts')[0], 'w:ascii') === 'Georgia' && val(W(mine, 'color')[0]) === 'C80000' && W(mine, 'i').length === 1, 'face, rgb() colour and italic carried')
  ok(attr(W(mine, 'spacing')[0], 'w:after') === '300', 'space after 20px = 300 twips')
  ok(pstyle(ps[2]) === undefined, 'a style id that resolves to nothing falls back to the kind default, as type renders it')
  ok(docxProblems(r.parts).length === 0, 'and every style used is defined')
}

// ---------------------------------------------------------------------------
console.log('inline formatting becomes run properties')
{
  const r = await out(doc([{
    id: 'a', kind: 'para', text: 'bold ital under strike code font both',
    marks: [
      { t: 'b', from: 0, to: 4 }, { t: 'i', from: 5, to: 9 }, { t: 'u', from: 10, to: 15 }, { t: 's', from: 16, to: 22 },
      { t: 'code', from: 23, to: 27 }, { t: 'font', from: 28, to: 32, family: 'Verdana, Geneva, sans-serif', size: 20 },
      { t: 'b', from: 33, to: 37 }, { t: 'i', from: 33, to: 37 },
    ],
  }]))
  const has = (t: string, local: string) => { const run = runWith(r.body, t); return !!run && W(run, local).length > 0 }
  ok(has('bold', 'b') && !has('bold', 'i'), 'b → w:b, alone')
  ok(has('ital', 'i') && !has('ital', 'b'), 'i → w:i, and a mark that ended before a run does not reach it')
  ok(val(W(runWith(r.body, 'under')!, 'u')[0]) === 'single', 'u → w:u single')
  ok(has('strike', 'strike'), 's → w:strike')
  ok(val(W(runWith(r.body, 'code')!, 'rStyle')[0]) === 'Code' && styleById(r.styles, 'Code') !== undefined, 'code → the Code character style, which is defined')
  const f = runWith(r.body, 'font')!
  ok(attr(W(f, 'rFonts')[0], 'w:ascii') === 'Verdana' && val(W(f, 'sz')[0]) === '30', 'a font mark → rFonts Verdana, 20px = 30 half-points')
  ok(has('both', 'b') && has('both', 'i'), 'overlapping marks land on one run')
  ok(ptext(paras(r.body)[0]) === 'bold ital under strike code font both', 'and no character is lost or duplicated across the cuts')
}

// ---------------------------------------------------------------------------
console.log('links: external rels, an allowlist, one rel per target')
{
  const r = await out(doc([{
    id: 'a', kind: 'para', text: 'one two three four',
    marks: [
      { t: 'link', from: 0, to: 3, href: 'https://example.com/?a=1&b=2' },
      { t: 'link', from: 4, to: 7, href: 'https://example.com/?a=1&b=2' },
      { t: 'link', from: 8, to: 13, href: 'javascript:alert(1)' },
      { t: 'link', from: 14, to: 18, href: 'mailto:someone@example.com' },
    ],
  }]))
  const links = W(r.body, 'hyperlink')
  ok(links.length === 3, `three hyperlinks (the javascript: one is refused): ${links.length}`)
  const rels = kids(xml(r.parts, 'word/_rels/document.xml.rels'))
    .filter((k): k is XElem => typeof k !== 'string')
    .filter((k) => /hyperlink$/.test(attr(k, 'Type') ?? ''))
  ok(rels.length === 2, `one rel per distinct target (2): ${rels.length}`)
  ok(rels.every((k) => attr(k, 'TargetMode') === 'External'), 'every hyperlink rel is External')
  ok(rels.some((k) => attr(k, 'Target') === 'https://example.com/?a=1&b=2'), 'the target survives escaping exactly')
  ok(!partText(r.parts, 'word/_rels/document.xml.rels').includes('javascript'), 'the refused scheme appears nowhere')
  ok(codes(r.report).has('hyperlink-dropped'), 'and the refusal is reported (hyperlink-dropped, the pptx code)')
  ok(val(W(links[0], 'rStyle')[0]) === 'Hyperlink', 'linked runs carry the Hyperlink style')
  ok(ptext(paras(r.body)[0]) === 'one two three four', 'the refused link keeps its words')
}

// ---------------------------------------------------------------------------
console.log('tracked changes: w:ins and w:del, deleted text kept as w:delText')
{
  const r = await out(doc([{
    id: 'a', kind: 'para', text: 'keep added gone end',
    marks: [
      { t: 'ins', from: 5, to: 11, by: 'Ann', at: '2026-11-08T10:00:00Z' },
      { t: 'del', from: 11, to: 16, by: 'Bob' },
      { t: 'link', from: 16, to: 19, href: 'https://example.com' },
      { t: 'ins', from: 16, to: 19, by: 'Ann' },
    ],
  }], { track: true }))
  const ins = W(r.body, 'ins')
  const del = W(r.body, 'del')
  ok(ins.length === 2 && del.length === 1, `two insertions, one deletion (${ins.length}, ${del.length})`)
  ok(attr(ins[0], 'w:author') === 'Ann' && attr(ins[0], 'w:date') === '2026-11-08T10:00:00Z', 'author and date carried')
  ok(attr(del[0], 'w:author') === 'Bob' && attr(del[0], 'w:date') === undefined, 'a change with no date has none (never an invented one)')
  ok(W(del[0], 'delText').map(textOf).join('') === 'gone ' && W(del[0], 't').length === 0, 'deleted text is w:delText, not w:t')
  ok(W(W(r.body, 'hyperlink')[0], 'ins').length === 1, 'a tracked insertion inside a link nests inside w:hyperlink')
  ok(W(xml(r.parts, 'word/settings.xml'), 'trackRevisions').length === 1, 'doc.track → trackRevisions on')
  ok(docxProblems(r.parts).length === 0, 'revision ids unique')
  const off = await out(doc([{ id: 'a', kind: 'para', text: 'x' }]))
  ok(W(xml(off.parts, 'word/settings.xml'), 'trackRevisions').length === 0, 'and off when the document is not tracking')
}

// ---------------------------------------------------------------------------
console.log('lists: numbering instances, levels, restarts')
{
  const r = await out(doc([
    { id: 'a', kind: 'ol', text: 'first' },
    { id: 'b', kind: 'ol', text: 'sub', level: 1 },
    { id: 'c', kind: 'ul', text: 'bullet under it', level: 1 },
    { id: 'd', kind: 'ol', text: 'second' },
    { id: 'e', kind: 'para', text: 'between' },
    { id: 'f', kind: 'ol', text: 'restart' },
    { id: 'g', kind: 'ul', text: 'top bullet' },
  ]))
  const ps = paras(r.body)
  const num = (p: XElem) => ({ id: val(W(p, 'numId')[0]), lvl: val(W(p, 'ilvl')[0]) })
  ok(num(ps[0]).id === num(ps[3]).id, 'items of one list share a numbering instance, so the count continues (1, 2)')
  ok(num(ps[1]).lvl === '1' && num(ps[0]).lvl === '0', 'level → ilvl')
  ok(num(ps[2]).id !== num(ps[1]).id, 'a bullet inside a numbered list is its own (bullet) instance')
  ok(num(ps[5]).id !== num(ps[0]).id, 'a list after a paragraph is a new instance (it restarts at 1, as type renders it)')
  ok(num(ps[6]).id !== num(ps[5]).id, 'switching kind at the top level starts a new list')
  ok(num(ps[4]).id === undefined, 'the paragraph between is not numbered')
  ok(pstyle(ps[0]) === 'ListNumber' && pstyle(ps[6]) === 'ListBullet', 'list items carry List Number / List Bullet')
  const numbering = xml(r.parts, 'word/numbering.xml')
  const abs = W(numbering, 'abstractNum')
  const fmt = (a: XElem, l: number) => val(W(W(a, 'lvl').find((v) => attr(v, 'w:ilvl') === String(l))!, 'numFmt')[0])
  ok(fmt(abs[0], 0) === 'bullet' && fmt(abs[1], 0) === 'decimal' && fmt(abs[1], 1) === 'lowerLetter' && fmt(abs[1], 2) === 'lowerRoman',
    "numbered levels go decimal / lower-alpha / lower-roman, as type's stylesheet does")
  ok(W(numbering, 'num').every((n) => W(n, 'startOverride').length === 9), 'every instance restarts all nine levels')
  ok(docxProblems(r.parts).length === 0, 'every numId used is defined')
  const back = await out(doc([
    { id: 'a', kind: 'ol', text: 'one' }, { id: 'b', kind: 'ul', text: 'bullet' }, { id: 'c', kind: 'ol', text: 'one again' },
  ]))
  const bp = paras(back.body)
  ok(num(bp[2]).id !== num(bp[0]).id, 'a numbered list interrupted by a bullet at the top level restarts (type renders two <ol>)')
}

// ---------------------------------------------------------------------------
console.log('paragraph layout and page setup')
{
  const r = await out(doc([
    { id: 'a', kind: 'para', text: 'first' },
    { id: 'b', kind: 'para', text: 'second' },
    { id: 'c', kind: 'h2', text: 'head' },
    { id: 'd', kind: 'para', text: 'after a heading' },
    { id: 'e', kind: 'para', text: 'centred', align: 'center', sb: 8, lh: 2, keepNext: true, breakBefore: true, keepTogether: true },
  ], { page: { width: 1056, height: 816, marginX: 96, marginLeft: 120, marginTop: 72, marginBottom: 60 }, layout: { align: 'left' } }))
  const ps = paras(r.body)
  const first = (p: XElem) => attr(W(p, 'ind')[0] ?? ({ attrs: new Map() } as unknown as XElem), 'w:firstLine')
  ok(first(ps[0]) === undefined, 'the first paragraph is not indented')
  ok(first(ps[1]) === '357', "a paragraph after a paragraph gets type's 1.4em first-line indent (23.8px = 357 twips)")
  ok(first(ps[3]) === undefined, 'a paragraph after a heading is not indented (CSS p + p)')
  const e = ps[4]
  ok(val(W(e, 'jc')[0]) === 'center' && attr(W(e, 'spacing')[0], 'w:before') === '120' && attr(W(e, 'spacing')[0], 'w:line') === '480',
    'direct alignment, space before (8px = 120) and line spacing (2 = 480)')
  ok(W(e, 'keepNext').length === 1 && W(e, 'keepLines').length === 1 && W(e, 'pageBreakBefore').length === 1, 'keep-with-next, keep-together, break-before')
  ok(val(W(styleById(r.styles, 'Normal')!, 'jc')[0]) === 'left', "the document's own default alignment goes into Normal")
  const pg = W(r.body, 'pgSz')[0]
  const mar = W(r.body, 'pgMar')[0]
  ok(attr(pg, 'w:w') === '15840' && attr(pg, 'w:h') === '12240' && attr(pg, 'w:orient') === 'landscape', 'a wide page is landscape, in twips')
  ok(attr(mar, 'w:left') === '1800' && attr(mar, 'w:right') === '1440' && attr(mar, 'w:top') === '1080' && attr(mar, 'w:bottom') === '900',
    'margins in twips, left and right independent (marginLeft overrides marginX)')
  const letter = await out(doc([{ id: 'a', kind: 'para', text: 'x' }]))
  const lp = W(letter.body, 'pgSz')[0]
  ok(attr(lp, 'w:w') === '12240' && attr(lp, 'w:h') === '15840' && attr(lp, 'w:orient') === undefined, "type's Letter page is Word's Letter page exactly (12240 × 15840)")
}

// ---------------------------------------------------------------------------
console.log('what is not written yet is reported, and no words are lost')
{
  const r = await out(doc([
    { id: 'a', kind: 'para', text: 'Noted', notes: [{ id: 'n1', at: 5 }] },
    { id: 'b', kind: 'cell', text: 'cell words', cell: { table: 't', cols: 1 } },
    { id: 'c', kind: 'image', text: '', image: { src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'a chart' } },
    { id: 'd', kind: 'toc', text: '' },
    { id: 'e', kind: 'math', text: 'x^2' },
  ], {
    footnotes: { n1: 'a note' },
    comments: { c1: { id: 'c1', block: 'a', from: 0, to: 5, quote: 'Noted', messages: [{ id: 'm', author: 'A', at: '2026-01-01T00:00:00Z', text: 'hm' }] } },
    revisions: [{ id: 'r', at: '2026-01-01T00:00:00Z', label: 'v1', body: [] }],
  }))
  const c = codes(r.report)
  for (const code of ['footnote-not-yet', 'table-not-yet', 'image-not-yet', 'toc-not-yet', 'math-as-source', 'comments-not-yet', 'revisions-dropped', 'layout-not-identical'])
    ok(c.has(code), `reported: ${code}`)
  const all = paras(r.body).map(ptext)
  ok(all.includes('cell words') && all.includes('a chart') && all.includes('x^2'), 'cell text, alt text and the formula source are all in the document')
  ok(val(W(paras(r.body).find((p) => ptext(p) === 'x^2')!, 'jc')[0]) === 'center', 'display math is centred')
}

// ---------------------------------------------------------------------------
console.log('input: saved files, refusals, capabilities, hostile text')
{
  const d = doc([{ id: 'a', kind: 'para', text: 'From a file' }], {
    collab: { room: 'wss://relay.example/r1', key: 'SECRET-ROOM-KEY', ownerPriv: 'SECRET-OWNER-PRIV' },
  })
  const html = '<!doctype html><title>x</title><script type="application/bento+json" id="bento-doc">\n' +
    JSON.stringify(d).replace(/</g, '\\u003c') + '\n</' + 'script>'
  const r = await typeToDocx(html, { at: AT })
  const parts = await readZip(r.bytes)
  ok(ptext(paras(xml(parts, 'word/document.xml'))[0]) === 'From a file', 'a saved .bento.html exports')
  const everything = [...parts.values()].map((b) => dec.decode(b)).join('')
  ok(!everything.includes('SECRET') && !everything.includes('relay.example'), 'no sharing key or room reaches any part')

  const refuses = async (input: string, re: RegExp, what: string) => {
    try { await typeToDocx(input); ok(false, what) } catch (e) { ok(re.test(String((e as Error).message)), `${what}: ${(e as Error).message}`) }
  }
  await refuses(JSON.stringify({ format: 'bento/slides', slides: [] }), /only bento\/type/, 'a slides deck is refused')
  await refuses(JSON.stringify({ format: 'bento/enc', v: 1 }), /password/, 'an encrypted document is refused with what to do')
  await refuses('{"format":"bento/type"}', /format check/, 'a document with no body is refused')
  await refuses('{nope', /does not parse/, 'broken JSON is refused')

  const hostile = await out(doc([{
    id: 'a', kind: 'para', text: 'a\u0001b <&> "q" end',
    marks: [{ t: 'b', from: 12, to: 15 }],
  }], { title: 'T\u0002 <x>', meta: { author: 'A & B' } }))
  ok(ptext(paras(hostile.body)[0]) === 'ab <&> "q" end', 'a control character costs one character, markup characters survive as text')
  ok(textOf(W(runWith(hostile.body, 'end')!, 't')[0]) === 'end', 'a mark after the control character still covers the right letters')
  ok(partText(hostile.parts, 'docProps/core.xml').includes('<dc:title>T &lt;x&gt;</dc:title>'), 'the title is scrubbed and escaped')
}

// ---------------------------------------------------------------------------
console.log('pure helpers')
{
  ok(wordFont('Georgia, "Times New Roman", serif').name === 'Georgia' && !wordFont('Georgia, serif').substituted, 'a stack Word has is kept as is')
  ok(wordFont('-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif').name === 'Segoe UI', 'the system stack → Segoe UI')
  ok(wordFont('ui-monospace, SFMono-Regular, Menlo, Consolas, monospace').name === 'Consolas', 'the monospace stack → Consolas')
  ok(wordFont('Fancy Grotesk, sans-serif').name === 'Arial', 'an unknown face with a generic → the generic face')
  ok(wordFont('Fancy Grotesk').name === 'Fancy Grotesk' && !wordFont('Fancy Grotesk').substituted, 'an unknown face alone is written as named (Word substitutes)')
  ok(hexColor('#abc') === 'AABBCC' && hexColor('#3a3d44') === '3A3D44' && hexColor('rgba(1, 2, 3, 0.5)') === '010203' && hexColor('hsl(1,2%,3%)') === null,
    'colours: short and long hex, rgb(a); hsl is refused (reported by the caller)')
}

// ---------------------------------------------------------------------------
console.log('the self-check catches what it claims to (negative controls)')
{
  const r = await out(doc([
    { id: 'a', kind: 'ul', text: 'item' },
    { id: 'b', kind: 'para', text: 'x y', marks: [{ t: 'ins', from: 0, to: 1, by: 'A' }, { t: 'ins', from: 2, to: 3, by: 'B' }, { t: 'code', from: 1, to: 2 }] },
  ]))
  ok(docxProblems(r.parts).length === 0, 'the unmutated package is clean')
  const mutate = (name: string, f: (s: string) => string): Map<string, Uint8Array> => {
    const m = new Map(r.parts)
    const before = partText(r.parts, name)
    const after = f(before)
    if (after === before) throw new Error(`mutation of ${name} changed nothing`)
    m.set(name, enc.encode(after))
    return m
  }
  const catches = (parts: Map<string, Uint8Array>, re: RegExp, what: string) => {
    const p = docxProblems(parts)
    ok(p.some((l) => re.test(l)), `${what} (${p.join('; ') || 'nothing found'})`)
  }
  { const m = new Map(r.parts); m.delete('word/settings.xml'); catches(m, /missing word\/settings\.xml/, 'a missing settings part') }
  catches(mutate('word/document.xml', (s) => s.replace('w:val="ListBullet"', 'w:val="Nope"')), /paragraph style Nope/, 'an undefined paragraph style')
  catches(mutate('word/document.xml', (s) => s.replace('<w:rStyle w:val="Code"/>', '<w:rStyle w:val="Normal"/>')), /character style Normal/, 'a paragraph style used as a character style')
  catches(mutate('word/document.xml', (s) => s.replace('<w:numId w:val="1"/>', '<w:numId w:val="7"/>')), /numId 7/, 'an undefined numbering instance')
  catches(mutate('word/numbering.xml', (s) => s.replace('<w:abstractNumId w:val="0"/>', '<w:abstractNumId w:val="9"/>')), /undefined abstract list/, 'an instance of an undefined abstract list')
  catches(mutate('word/document.xml', (s) => s.replace(/(<w:ins w:id=")2"/, '$11"')), /revision id/, 'duplicate revision ids')
  catches(mutate('word/styles.xml', (s) => s.replace('<w:basedOn w:val="Normal"/>', '<w:basedOn w:val="Gone"/>')), /undefined style Gone/, 'a style based on an undefined style')
  catches(mutate('word/document.xml', (s) => s.replace('</w:body>', '<w:p><w:hyperlink r:id="rId99"/></w:p></w:body>')), /rId99 has no rel/, 'an r:id with no rel (the shared OPC check)')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
