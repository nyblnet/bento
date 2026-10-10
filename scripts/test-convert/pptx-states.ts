// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Interactive states: left out by default (links go to the parent), or with
// includeStates, hidden slides right after their parent that links lead to.
//
//   node scripts/test-convert/pptx-states.ts

import { exportDeck, partText, frame, type Exported } from './_export-harness.ts'
import type { ExportDoc } from '../../convert/src/pptx-write/index.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const text = (id: string, html: string) => ({ id, type: 'text', ...frame(80, 80, 400, 60), html, fontSize: 24,
  fontFamily: 'Inter, sans-serif', fontWeight: 400, color: '#1e2a3a', align: 'left', valign: 'top', lineHeight: 1.2 })
const button = (id: string, link: string) => ({ id, type: 'shape', ...frame(80, 300, 200, 60), shape: 'rect',
  fill: '#ff7a59', stroke: '#000000', strokeWidth: 0, radius: 0, link })

const doc = (): ExportDoc => ({
  title: 'States', size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#1e2a3a', accent: '#ff7a59', fontFamily: 'Inter, sans-serif' },
  slides: [
    { id: 'a', background: '#ffffff', notes: 'A notes', elements: [text('t1', 'Page {{page}}'), button('b1', 'a-detail')] as never },
    { id: 'a-detail', stateOf: 'a', background: '#ffffff', notes: 'detail notes', elements: [text('t2', 'Detail on {{page}}'), button('back', 'a')] as never },
    { id: 'b', background: '#ffffff', elements: [text('t3', 'Page {{page}}'), button('b2', 'a-detail')] as never },
  ],
})

/** slide n's link targets, as slide numbers */
const jumps = (r: Exported, n: number) => [...partText(r.parts, `ppt/slides/_rels/slide${n}.xml.rels`).matchAll(/Target="\.\.\/slides\/slide(\d+)\.xml"/g)].map((m) => Number(m[1]))
const hidden = (r: Exported, n: number) => /<p:sld\b[^>]*\bshow="0"/.test(partText(r.parts, `ppt/slides/slide${n}.xml`))
const textOf = (r: Exported, n: number) => [...partText(r.parts, `ppt/slides/slide${n}.xml`).matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')
const slideCount = (r: Exported) => [...r.parts.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).length

console.log('the writer with the option off (bentoToPptx, the CLI and the page default it on): states left out')
{
  const r = await exportDeck(doc())
  ok(r.problems.length === 0 && slideCount(r) === 2, `2 slides (${slideCount(r)})`)
  ok(JSON.stringify(jumps(r, 1)) === '[1]' && JSON.stringify(jumps(r, 2)) === '[1]', `links into the state go to its parent (slide 1: ${jumps(r, 1)}, slide 2: ${jumps(r, 2)})`)
  ok(r.codes.has('state-slides-omitted') && !r.codes.has('states-as-hidden-slides'), 'reported as left out')
}

console.log('includeStates: hidden slides that links lead to')
{
  const r = await exportDeck(doc(), { includeStates: true })
  ok(r.problems.length === 0 && slideCount(r) === 3, `3 slides, package clean (${slideCount(r)})`)
  ok(/Detail on/.test(textOf(r, 2)), 'the state sits right after its parent (slide 2)')
  ok(hidden(r, 2) && !hidden(r, 1) && !hidden(r, 3), 'the state is a hidden slide; the others are not')
  ok(JSON.stringify(jumps(r, 1)) === '[2]' && JSON.stringify(jumps(r, 3)) === '[2]', `links into the state land on it (slide 1: ${jumps(r, 1)}, slide 3: ${jumps(r, 3)})`)
  ok(JSON.stringify(jumps(r, 2)) === '[1]', `the state's own link back still reaches its parent (${jumps(r, 2)})`)
  ok(/Page 1/.test(textOf(r, 1)) && /Detail on 1/.test(textOf(r, 2)) && /Page 2/.test(textOf(r, 3)),
    `states take no page number of their own (${textOf(r, 2)}; ${textOf(r, 3)})`)
  // PowerPoint numbers every slide, hidden ones too: where its number would
  // differ from bento's page, the page is fixed text, not a live field
  const live = (n: number) => /<a:fld [^>]*type="slidenum"/.test(partText(r.parts, `ppt/slides/slide${n}.xml`))
  ok(live(1) && !live(2) && !live(3), `a live slide number only where PowerPoint counts the same (slide 1 live: ${live(1)}, 2: ${live(2)}, 3: ${live(3)})`)
  ok(r.report.entries.some((e) => e.code === 'text-field-frozen' && e.where === 'slide 3'), 'the fixed page number is reported where it happened')
  ok(r.parts.has('ppt/notesSlides/notesSlide2.xml') && /detail notes/.test(partText(r.parts, 'ppt/notesSlides/notesSlide2.xml')), "the state's speaker notes come along")
  ok(r.codes.has('states-as-hidden-slides') && !r.codes.has('state-slides-omitted'), 'reported as hidden slides, not as left out')
}

console.log('a hidden slide (the same miscount, without any states)')
{
  const d = doc()
  d.slides = [d.slides[0], { id: 'h', hidden: true, background: '#ffffff', elements: [] }, d.slides[2]]
  const r = await exportDeck(d)
  const live = (n: number) => /<a:fld [^>]*type="slidenum"/.test(partText(r.parts, `ppt/slides/slide${n}.xml`))
  ok(/Page 2/.test(textOf(r, 3)) && !live(3) && live(1),
    `after a hidden slide, bento's page 2 stays 2 as fixed text, where PowerPoint would count 3 (${textOf(r, 3)})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
