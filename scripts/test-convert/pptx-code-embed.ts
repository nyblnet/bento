// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// code → editable text, embed → a picture of its view.
//
//   node scripts/test-convert/pptx-code-embed.ts

import { exportOne, exportDeck, deck, frame } from './_export-harness.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const MONO = "ui-monospace, 'SFMono-Regular', 'Berkeley Mono', 'Menlo', 'Consolas', monospace"
const code = (content: string, extra: object = {}) => ({
  type: 'code', fontSize: 19, fontFamily: MONO, align: 'left', valign: 'top', lineHeight: 1.62,
  color: '#DCE3EC', content, grammarName: 'js', ...extra,
})
/** the visible lines of every text body: paragraphs and line breaks both end a line */
const paras = (xml: string) => [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].flatMap((m) =>
  m[1].split(/<a:br>[\s\S]*?<\/a:br>|<a:br\/>/).map((l) => [...l.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join('')))
const NB = ' '

console.log('code')
{
  const r = await exportOne(code('load(deck, (slides) => {\n  render(slides)\n\tdone()\n})'))
  const p = paras(r.slideXml)
  ok(r.problems.length === 0 && /<p:sp>/.test(r.slideXml), 'a code element becomes a text shape, package clean')
  ok(p.length === 4, `one line per source line (${p.length})`)
  ok(p[1] === `${NB}${NB}render(slides)`, `leading spaces survive as no-break spaces (${JSON.stringify(p[1])})`)
  ok(p[2] === `${NB.repeat(8)}done()`, `a tab expands to the next 8-column stop (${JSON.stringify(p[2])})`)
  ok(/typeface="Consolas"/.test(r.slideXml) && !/ui-monospace|Berkeley/.test(r.slideXml), 'slides\' monospace stack is written as Consolas')
  ok(/<a:bodyPr[^>]*wrap="none"/.test(r.slideXml), 'long lines do not wrap (wrap="none"), as in slides')
  ok(/<a:srgbClr val="DCE3EC"/.test(r.slideXml), 'the element colour is kept')
  ok(r.codes.has('code-colours-flattened') && !r.codes.has('element-unsupported'), 'lost syntax colours are reported, nothing else dropped')
}
{
  const r = await exportOne(code('if (a < b && c > "d") {{page}}'))
  ok(r.problems.length === 0 && paras(r.slideXml)[0] === 'if (a &lt; b &amp;&amp; c &gt; "d") {{page}}',
    `<, & and > are escaped once, single spaces stay ordinary, {{tokens}} stay literal (${JSON.stringify(paras(r.slideXml)[0])})`)
  const dbl = paras((await exportOne(code('a  b'))).slideXml)[0]
  ok(dbl === `a ${NB}b`, `a run of spaces keeps its width (${JSON.stringify(dbl)})`)
  const plain = await exportOne(code('x', { grammarName: undefined }))
  ok(!plain.codes.has('code-colours-flattened'), 'plain code with no highlighting reports no lost colours')
  const empty = await exportOne(code(''))
  ok(empty.problems.length === 0 && !empty.codes.has('code-colours-flattened'), 'an empty code box exports clean')
}

console.log('embed')
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#f00"/></svg>'
{
  const r = await exportOne({ type: 'embed', app: 'bento/dash', view: SVG })
  ok(r.problems.length === 0 && /<p:pic>/.test(r.slideXml) && [...r.parts.keys()].some((k) => /^ppt\/media\/.*\.svg$/.test(k)),
    'an embed becomes a picture with its SVG in the package')
  ok(r.codes.has('embed-static') && /bento\/dash document shows as a picture/.test(r.report.entries.find((e) => e.code === 'embed-static')!.detail),
    'it is reported as a static picture, naming the app')
}
{
  const d = deck([{ id: 'e1', ...frame(80, 80, 300, 200), type: 'embed', app: 'bento/type', view: 'asset:v1' }], { assets: { v1: SVG } })
  const r = await exportDeck(d)
  ok(r.problems.length === 0 && /<p:pic>/.test(r.slideXml), 'a view stored as an asset is found and placed')
}
{
  const r = await exportOne({ type: 'embed', app: 'web', view: '', url: 'https://example.com' })
  ok(r.problems.length === 0 && !/<p:pic>/.test(r.slideXml) && r.codes.has('embed-no-view'), 'an embed with no view is reported dropped, never silently')
  const bad = await exportOne({ type: 'embed', app: 'web', view: '<img src=x onerror=alert(1)>' })
  ok(!/<p:pic>/.test(bad.slideXml) && bad.codes.has('embed-no-view'), 'a view that is not SVG is not embedded')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
