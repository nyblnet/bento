#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Inline links in text, through PowerPoint both ways.
//
//   node scripts/test-convert/pptx-links.ts
//
// The bug: `Visit <a href="https://…">our site</a>` exported as plain text —
// no a:hlinkClick, no relationship. Now each linked run carries a:hlinkClick
// to an External hyperlink rel (http, https and mailto only), and the
// importer reads a run's hlinkClick back into an `<a href>` when the target is
// a web address the document can keep. Both halves are held to a scheme rule;
// the hostile rows prove that javascript:, data:, relative and broken-out
// addresses never become a link in either direction. Checks read the
// exported PACKAGE (zip → the engine's strict XML parser), and the round
// trip goes through the real importer, convertPptx.

import { parseXml, descendants, kid, kids, attr, textOf, NS, type XElem } from '../../convert/src/xml.ts'
import { convertPptx } from '../../convert/src/pptx.ts'
import { exportPptx } from '../../convert/src/pptx-write/index.ts'
import { safeHref } from '../../convert/src/pptx-write/text.ts'
import type { OutText } from '../../convert/src/types.ts'
import { exportDeck, deck, frame, partText } from './_export-harness.ts'
import { buildPptx, slide, sp, xfrm } from './_fixtures.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const textEl = (html: string, over: Record<string, unknown> = {}) => ({
  type: 'text', id: 't', ...frame(80, 80, 600, 200), html,
  fontSize: 24, fontFamily: 'Inter, sans-serif', fontWeight: 400, color: '#1E2A3A',
  align: 'left', valign: 'top', lineHeight: 1.25, ...over,
})

interface RunFact { text: string; rId?: string; action?: string }
interface Rel { id: string; type: string; target: string; mode?: string }

async function exportRuns(html: string, over: Record<string, unknown> = {}, extraSlides: unknown[] = []) {
  const d = deck([textEl(html, over)])
  if (extraSlides.length) d.slides.push(...(extraSlides as typeof d.slides))
  const r = await exportDeck(d)
  const s = parseXml(r.slideXml)
  const runs: RunFact[] = descendants(s, NS.a, 'r').map((run) => {
    const rPr = kid(run, NS.a, 'rPr')
    const hl = rPr ? kid(rPr, NS.a, 'hlinkClick') : undefined
    let rId: string | undefined
    if (hl) for (const [k, v] of hl.attrs) if (k.endsWith(':id')) rId = v
    return { text: textOf(kid(run, NS.a, 't')!), rId, action: hl ? attr(hl, 'action') : undefined }
  })
  const relsDoc = parseXml(partText(r.parts, 'ppt/slides/_rels/slide1.xml.rels'))
  const rels: Rel[] = kids(relsDoc).map((e: XElem) => ({
    id: attr(e, 'Id') ?? '', type: attr(e, 'Type') ?? '', target: attr(e, 'Target') ?? '', mode: attr(e, 'TargetMode'),
  }))
  const relById = (id?: string) => rels.find((x) => x.id === id)
  const allText = [...r.parts.keys()].map((k) => partText(r.parts, k)).join('\n')
  return { r, runs, rels, relById, allText }
}

const isHyperlink = (rel?: Rel) => !!rel && rel.type.endsWith('/hyperlink') && rel.mode === 'External'

// ---------------------------------------------------------------- export
console.log('export: an inline link becomes a hyperlink run')
{
  const url = 'https://example.com/a?x=1&y=2'
  const { r, runs, relById } = await exportRuns('Visit <a href="https://example.com/a?x=1&amp;y=2">our site</a> now')
  ok(r.problems.length === 0, `package wiring is clean (${r.problems.join('; ') || 'no problems'})`)
  ok(runs.map((x) => x.text).join('|') === 'Visit |our site| now', 'three runs: before, the link, after')
  ok(runs[0].rId === undefined && runs[2].rId === undefined, 'the words around the link are not linked')
  const rel = relById(runs[1].rId)
  ok(isHyperlink(rel), 'the linked run points at an External hyperlink relationship')
  ok(rel?.target === url, `the relationship targets the address, entities decoded (got ${rel?.target})`)
  ok(runs[1].action === undefined, 'a web link carries no slide-jump action')
}
{
  const { runs, rels, relById } = await exportRuns('<a href="https://a.example/">one</a> and <a href="https://a.example/">again</a>')
  ok(runs[0].rId !== undefined && runs[0].rId === runs[2].rId, 'the same address twice shares one relationship')
  ok(rels.filter((x) => isHyperlink(x)).length === 1, 'and only one hyperlink rel is written')
  ok(relById(runs[0].rId)?.target === 'https://a.example/', 'pointing at that address')
}
{
  const { runs, relById } = await exportRuns('<a href="https://b.example/">plain <b>bold</b> <i>italic</i></a>')
  ok(runs.length >= 3 && runs.every((x) => relById(x.rId)?.target === 'https://b.example/'),
    'formatting inside a link splits runs, and every one of them is linked')
}
{
  const { runs, relById } = await exportRuns('<a href="mailto:hello@example.com">write</a>')
  ok(relById(runs[0].rId)?.target === 'mailto:hello@example.com', 'mailto: exports as a hyperlink')
}
{
  // the element's own link (to a slide) covers the box; an inline link wins
  // for its own words
  const second = { id: 's2', background: '#ffffff', elements: [] }
  const { runs, relById } = await exportRuns('see <a href="https://c.example/">this</a>', { link: 's2' }, [second])
  ok(runs[0].action === 'ppaction://hlinksldjump', 'words outside the inline link keep the element\'s slide jump')
  ok(relById(runs[1].rId)?.target === 'https://c.example/' && runs[1].action === undefined,
    'the inline link wins over the element link for its own words')
}

console.log('export: addresses that must not become links')
const hostile: Array<[string, string]> = [
  ['<a href="javascript:alert(1)">x</a>', 'javascript:'],
  ['<a href="JaVaScRiPt:alert(1)">x</a>', 'javascript: in mixed case'],
  ['<a href="&#106;avascript:alert(1)">x</a>', 'javascript: spelled with an entity'],
  ['<a href=" javascript:alert(1)">x</a>', 'javascript: behind a space'],
  ['<a href="data:text/html,hi">x</a>', 'data:'],
  ['<a href="file:///etc/passwd">x</a>', 'file:'],
  ['<a href="/relative/path">x</a>', 'a relative path'],
  [`<a href='https://e.example/"onmouseover=x'>x</a>`, 'a quote inside the address'],
  ['<a href="https://e.example/a b">x</a>', 'whitespace inside the address'],
  ['<a>x</a>', 'no href at all'],
]
for (const [html, label] of hostile) {
  const { r, runs, rels } = await exportRuns(html)
  ok(runs.length === 1 && runs[0].text === 'x' && runs[0].rId === undefined && rels.every((x) => !x.type.endsWith('/hyperlink')),
    `${label}: the text exports, unlinked, and no hyperlink rel is written`)
  ok(!/javascript:|data:text|file:\/\/\//i.test([...r.parts.keys()].filter((k) => k.endsWith('.rels')).map((k) => partText(r.parts, k)).join('')),
    `${label}: the address appears in no relationship`)
}
ok(safeHref('https://' + 'a'.repeat(2050)) === undefined, 'an address over 2048 characters is not a link')
ok(safeHref('https://ok.example/') === 'https://ok.example/', 'positive control: a plain https address is a link')

// ---------------------------------------------------------- the round trip
console.log('round trip: exported, then imported by convertPptx')
async function roundTrip(html: string) {
  const { bytes } = await exportPptx(deck([textEl(html)]))
  const back = await convertPptx(bytes)
  const t = back.doc.slides[0].elements.find((e) => e.type === 'text') as OutText | undefined
  return { html: t?.html ?? '(no text element)', codes: back.report.entries.map((e) => e.code) }
}
for (const [html, label] of [
  ['Visit <a href="https://example.com/a?x=1&amp;y=2">our site</a> now', 'a link inside a sentence'],
  ['<a href="https://b.example/">plain <b>bold</b></a> after', 'formatting inside a link stays one link'],
  ['<a href="https://a.example/">one</a> <a href="https://z.example/">two</a>', 'two links side by side'],
  ['<ul><li>See <a href="https://a.example/">this</a></li><li>two<ul><li><a href="https://z.example/">deep</a></li></ul></li></ul>',
    'links inside list items, nested too'],
] as const) {
  const back = await roundTrip(html)
  ok(back.html === html, `${label}: comes back as the same html (got ${back.html})`)
}
{
  const back = await roundTrip('<a href="mailto:hello@example.com">write</a>')
  ok(back.html === 'write', 'mailto: comes back as plain text: the slides renderer keeps http(s) links only')
  ok(back.codes.includes('hyperlink-dropped'), 'and the report says the link was dropped')
}

// ---------------------------------------------------- import, hostile files
console.log('import: a hand-built deck whose links are not web addresses')
{
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const run = (rid: string, text: string, action = '') =>
    `<a:r><a:rPr lang="en-US"><a:hlinkClick r:id="${rid}"${action ? ` action="${action}"` : ''}/></a:rPr><a:t>${text}</a:t></a:r>`
  const body = '<p:txBody><a:bodyPr/><a:lstStyle/><a:p>' +
    run('rWeb', 'web') + run('rJs', 'js') + run('rData', 'data') + run('rInt', 'internal') +
    run('rWeb', 'jump', 'ppaction://hlinksldjump') + run('rMissing', 'missing') + run('rQuote', 'quote') +
    '</a:p></p:txBody>'
  const bytes = await buildPptx({
    slides: [{
      xml: slide(sp(2, 'Links', `<p:spPr>${xfrm(914400, 914400, 4572000, 914400)}</p:spPr>${body}`)),
      rels:
        `<Relationship Id="rWeb" Type="${REL}/hyperlink" Target="https://ok.example/?a=1&amp;b=2" TargetMode="External"/>` +
        `<Relationship Id="rJs" Type="${REL}/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>` +
        `<Relationship Id="rData" Type="${REL}/hyperlink" Target="data:text/html,x" TargetMode="External"/>` +
        `<Relationship Id="rInt" Type="${REL}/hyperlink" Target="https://internal.example/"/>` +
        `<Relationship Id="rQuote" Type="${REL}/hyperlink" Target="https://q.example/&quot;onmouseover=x" TargetMode="External"/>`,
    }],
  })
  const back = await convertPptx(bytes)
  const t = back.doc.slides[0].elements.find((e) => e.type === 'text') as OutText | undefined
  const html = t?.html ?? ''
  ok(html.startsWith('<a href="https://ok.example/?a=1&amp;b=2">web</a>'), `the web link comes in as a link, & escaped (got ${html})`)
  ok((html.match(/<a /g) ?? []).length === 1, 'and it is the ONLY link: js, data, internal, slide-jump, missing and quote targets are not')
  ok(!/javascript|data:|internal\.example|q\.example/.test(html), 'no rejected target reaches the html')
  ok(html.endsWith('jsdatainternaljumpmissingquote'), 'their words all come in as plain text')
  ok(back.report.entries.some((e) => e.code === 'hyperlink-dropped'), 'the dropped links are reported')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
