#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Lists through PowerPoint, both ways.
//
//   node scripts/test-convert/pptx-lists.ts
//
// The bug: a bento text box holding `<ul><li>One<ul><li>Two</li></ul></li>
// <li>Three</li></ul>` exported as ONE paragraph reading "OneTwoThree" — no
// bullets, no levels, no line breaks. Each list item is its own a:p now, with
// lvl, a hanging indent and a bullet; and the importer turns those paragraphs
// back into the same nesting. The checks read the PACKAGE (the exporter's
// bytes through the kernel zip reader and the engine's strict XML parser),
// and the round trip goes through the real importer, convertPptx.

import { parseXml, descendants, kid, kids, attr, textOf, NS, type XElem } from '../../convert/src/xml.ts'
import { convertPptx } from '../../convert/src/pptx.ts'
import type { OutText } from '../../convert/src/types.ts'
import { parseParagraphs } from '../../convert/src/pptx-write/text.ts'
import { exportDeck, deck, frame, partText } from './_export-harness.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const FONT = 24 // px
const EMU = 9525 // per px
const HANG = Math.round(1.35 * FONT * EMU)

const textEl = (html: string, over: Record<string, unknown> = {}) => ({
  type: 'text', id: 'list', ...frame(80, 80, 600, 300), html,
  fontSize: FONT, fontFamily: 'Inter, sans-serif', fontWeight: 400, color: '#1E2A3A',
  align: 'left', valign: 'top', lineHeight: 1.25, ...over,
})

interface ParaFacts { text: string; lvl: number; marL?: number; indent?: number; bullet: string; brs: number }

async function exportParas(html: string, over: Record<string, unknown> = {}) {
  const r = await exportDeck(deck([textEl(html, over)]))
  const slide = parseXml(r.slideXml)
  const sp = descendants(slide, NS.p, 'sp')[0]
  const body = kid(sp, NS.p, 'txBody')!
  const paras: ParaFacts[] = kids(body, NS.a, 'p').map((p) => {
    const pPr = kid(p, NS.a, 'pPr')
    const num = (k: string) => { const v = pPr ? attr(pPr, k) : undefined; return v === undefined ? undefined : Number(v) }
    let bullet = ''
    if (pPr && kid(pPr, NS.a, 'buNone')) bullet = 'none'
    const ch = pPr ? kid(pPr, NS.a, 'buChar') : undefined
    const auto = pPr ? kid(pPr, NS.a, 'buAutoNum') : undefined
    if (ch) bullet = attr(ch, 'char') ?? '?'
    if (auto) bullet = attr(auto, 'type') ?? '?'
    return {
      text: descendants(p, NS.a, 't').map(textOf).join(''),
      lvl: num('lvl') ?? 0, marL: num('marL'), indent: num('indent'), bullet,
      brs: kids(p, NS.a, 'br').length,
    }
  })
  return { r, paras }
}

async function roundTrip(html: string, over: Record<string, unknown> = {}): Promise<{ html: string; codes: string[] }> {
  const { bytes } = await (await import('../../convert/src/pptx-write/index.ts')).exportPptx(deck([textEl(html, over)]))
  const back = await convertPptx(bytes)
  const t = back.doc.slides[0].elements.find((e) => e.type === 'text') as OutText | undefined
  return { html: t?.html ?? '(no text element)', codes: back.report.entries.map((e) => e.code) }
}

// ------------------------------------------------- the reported deck, exported
console.log('export: the nested list from the report')
{
  const html = '<ul><li>One<ul><li>Two</li></ul></li><li>Three</li></ul>'
  const { r, paras } = await exportParas(html)
  ok(r.problems.length === 0, `package wiring is clean (${r.problems.join('; ') || 'no problems'})`)
  ok(paras.length === 3, `three paragraphs, one per item (got ${paras.length}: ${paras.map((p) => p.text).join(' | ')})`)
  ok(paras.map((p) => p.text).join('|') === 'One|Two|Three', 'item text intact, nothing glued')
  ok(paras.map((p) => p.lvl).join(',') === '0,1,0', 'levels 0, 1, 0')
  ok(paras[0].bullet === '•' && paras[2].bullet === '•', 'top level draws a disc, as `ul` does')
  ok(paras[1].bullet === '◦', 'nested level draws a circle, as `ul ul` does')
  ok(paras[0].marL === HANG && paras[0].indent === -HANG, `level 0: marL ${HANG}, hanging indent −${HANG} (1.35em)`)
  ok(paras[1].marL === 2 * HANG && paras[1].indent === -HANG, 'level 1: indented one step further')
  ok(paras.every((p) => p.brs === 0), 'no a:br stands in for the item boundaries')
}

console.log('export: numbered, mixed, and the edges')
{
  const { paras } = await exportParas('<ol><li>First</li><li>Second<ol><li>Inner</li></ol></li></ol>')
  ok(paras.map((p) => p.bullet).join(',') === 'arabicPeriod,arabicPeriod,arabicPeriod',
    'ol items are live buAutoNum arabicPeriod at every level')
  ok(paras.map((p) => p.lvl).join(',') === '0,0,1', 'ol nesting keeps its levels')
}
{
  const { paras } = await exportParas('<ol><li>a<ul><li>b</li></ul></li></ol>')
  ok(paras[1].bullet === '•', 'a ul inside an ol draws a disc (no ul above it)')
}
{
  const { paras } = await exportParas('Intro<ul><li>a</li><li>b</li></ul>Outro')
  ok(paras.map((p) => p.text).join('|') === 'Intro|a|b|Outro', 'text around a list keeps its own paragraphs')
  ok(paras[0].bullet === 'none' && paras[3].bullet === 'none',
    'the plain paragraphs beside a list say buNone outright')
}
{
  const { paras } = await exportParas('<ul><li>One<br>still one</li><li><br></li></ul>')
  ok(paras.length === 2 && paras[0].brs === 1 && paras[0].text === 'Onestill one',
    'a <br> inside an item is a line break within that item')
  ok(paras[1].text === '' && paras[1].bullet === '•' && paras[1].brs === 0,
    'an empty item (contentEditable\'s <li><br></li>) stays a paragraph, without a phantom break')
}
{
  const { paras } = await exportParas('<ul><li>One<ul><li>Two</li></ul>after</li></ul>')
  ok(paras.length === 3 && paras[2].text === 'after' && paras[2].bullet === 'none' && paras[2].lvl === 0
    && paras[2].indent === 0 && paras[2].marL === HANG,
    'text after a nested list continues its item: same indent, no bullet')
}
{
  const { paras } = await exportParas('<ul><li>One</li></ul>', { align: 'center' })
  // a zero indent glues the bullet to the first word (seen in a LibreOffice
  // render), so a centred list keeps the hang and its line still centres
  ok(paras[0].marL === HANG && paras[0].indent === -HANG, 'a centred list keeps the hanging indent, so its bullet keeps a gap')
}
{
  // REGRESSION GUARD: list-free text keeps its one-paragraph shape
  const { paras } = await exportParas('line1<div>line2</div>')
  ok(paras.length === 1 && paras[0].brs === 1 && paras[0].bullet === '',
    'list-free text is still ONE paragraph with an a:br, and no bullet properties')
}
{
  const p = parseParagraphs('<ul><li>a</li></ul>')
  ok(p.length === 1 && p[0].list?.level === 0 && p[0].list?.ordered === false, 'parseParagraphs: one item, level 0, unordered')
}

// -------------------------------------------------------- the round trip back
console.log('round trip: exported, then imported by convertPptx')
const cases: Array<[string, string]> = [
  ['<ul><li>One<ul><li>Two</li></ul></li><li>Three</li></ul>', 'the reported nesting'],
  ['<ol><li>First</li><li>Second<ol><li>Inner</li></ol></li><li>Third</li></ol>', 'a numbered list with a nested one'],
  ['Intro<ul><li>a</li><li>b</li></ul>Outro', 'text around a list'],
  ['<ul><li>a<ol><li>n1</li><li>n2</li></ol></li><li>b</li></ul>', 'numbers nested under bullets'],
]
for (const [html, label] of cases) {
  const back = await roundTrip(html)
  ok(back.html === html, `${label}: comes back as the same html (got ${back.html})`)
  ok(!back.codes.includes('bullet-flattened') && !back.codes.includes('auto-number-frozen'),
    `${label}: nothing reported flattened or frozen`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
