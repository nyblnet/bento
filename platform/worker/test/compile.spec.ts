// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Compiler assertions, written in TS so it can import compile.ts/schema.ts
// directly. Bundled + run as a plain Node process by compile.test.mjs — same
// pattern the main repo's scripts/test-*.ts rigs use (see .github/workflows/ci.yml).
import { compileOutline } from '../src/compile/compile.ts'
import { parseOutline } from '../src/compile/schema.ts'
import type { Outline } from '../src/compile/schema.ts'
import { validateIncomingDoc } from '../src/validate.ts'
import type { ChartElement, ImageElement, Slide, TableElement, TextElement } from '../../../slides/src/model.ts'

let failures = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures++
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`)
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

function textRole(slide: Slide, role: string): TextElement | undefined {
  return slide.elements.find((e) => e.type === 'text' && e.role === role) as TextElement | undefined
}

console.log('outline compiler')

// --- one slide of every layout kind, exercised through the full pipeline ---

const fullOutline: Outline = {
  title: 'Q3 review',
  theme: { background: '#0D1B2E', color: '#F5F7FA', accent: '#E8442E' },
  slides: [
    // adjacent pair sharing morphGroup — morph is a transition INTO a slide
    // from the one immediately before it, so only CONSECUTIVE slides can
    // pair (see compile.ts's morph-pairing comment).
    { layout: 'title', heading: 'Q3 Review', subheading: 'Growth & retention', morphGroup: 'cover' },
    { layout: 'title', heading: 'Q3 Review', subheading: 'Recap', morphGroup: 'cover' },
    { layout: 'section', heading: 'Revenue', kicker: 'PART 1' },
    { layout: 'bullets', heading: 'Highlights', bullets: ['Grew 40%', 'Churn down', 'NPS up'] },
    { layout: 'stat', heading: 'Headline', value: 2450, label: 'New customers' },
    {
      layout: 'chart', heading: 'Revenue by quarter', chartType: 'bar',
      categories: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Revenue', data: [420, 780, 1300, 2450] }],
    },
    { layout: 'table', heading: 'Plans', columns: ['Plan', 'Price'], rows: [['Basic', '$9'], ['Pro', '$29']] },
    { layout: 'quote', quote: 'This changed everything.', attribution: 'A customer' },
    { layout: 'image', heading: 'The team', alt: 'team photo', caption: 'Onsite, June 2026' },
  ],
}

check('a full outline compiles to a doc that passes ingest validation', () => {
  const doc = compileOutline(fullOutline)
  const result = validateIncomingDoc(doc)
  assert(result.ok, `validation failed: ${JSON.stringify(result.errors)}`)
  assert(doc.slides.length === fullOutline.slides.length, 'slide count mismatch')
  assert(doc.title === 'Q3 review', 'title not carried through')
  assert(doc.theme.accent === '#E8442E', 'theme not carried through')
})

check('every slide element carries a unique id within its slide', () => {
  const doc = compileOutline(fullOutline)
  for (const slide of doc.slides) {
    const ids = slide.elements.map((e) => e.id)
    assert(new Set(ids).size === ids.length, `duplicate element id on slide ${slide.id}`)
  }
})

check('title slide fills heading and subheading', () => {
  const doc = compileOutline({ title: 't', slides: [{ layout: 'title', heading: 'Hello', subheading: 'World' }] })
  const slide = doc.slides[0]!
  assert(textRole(slide, 'title')?.html === 'Hello', 'heading not set')
  assert(textRole(slide, 'subtitle')?.html === 'World', 'subheading not set')
})

check('bullets render as a bulleted, escaped list', () => {
  const doc = compileOutline({ title: 't', slides: [{ layout: 'bullets', heading: 'H', bullets: ['A < B', 'plain'] }] })
  const body = textRole(doc.slides[0]!, 'body')
  assert(!!body, 'no body element')
  assert(body!.html.includes('&lt; B'), 'bullet text was not HTML-escaped')
  assert(body!.html.includes('•'), 'bullets not rendered with a bullet glyph')
  assert(body!.html.split('<br>').length === 2, 'expected two bullet lines')
})

check('stat slide has a count-up value element and no stray suffix', () => {
  const doc = compileOutline({ title: 't', slides: [{ layout: 'stat', value: 1234, label: 'Users' }] })
  const value = doc.slides[0]!.elements.find((e) => e.type === 'text' && e.html === '1,234') as TextElement | undefined
  assert(!!value, 'formatted value element not found')
  assert(value!.fx?.countUp === true, 'countUp not set on the value element')
})

check('chart slide: bar series stays plain numbers, palette applied', () => {
  const doc = compileOutline({
    title: 't',
    slides: [{ layout: 'chart', chartType: 'bar', categories: ['A', 'B'], series: [{ name: 'S', data: [1, 2] }] }],
  })
  const chart = doc.slides[0]!.elements.find((e) => e.type === 'chart') as ChartElement | undefined
  assert(!!chart, 'no chart element')
  const option = chart!.option as { series: Array<{ data: unknown }>; color?: unknown[] }
  assert(Array.isArray(option.series[0]!.data), 'series data missing')
  assert(option.series[0]!.data.every((n) => typeof n === 'number'), 'bar series data must be PLAIN NUMBERS (CLAUDE.md)')
  assert(Array.isArray(option.color) && option.color.length > 0, 'chart palette not applied')
})

check('chart slide: pie series uses {name,value} objects', () => {
  const doc = compileOutline({
    title: 't',
    slides: [{ layout: 'chart', chartType: 'pie', categories: ['A', 'B'], series: [{ name: 'S', data: [3, 7] }] }],
  })
  const chart = doc.slides[0]!.elements.find((e) => e.type === 'chart') as ChartElement | undefined
  const option = chart!.option as { series: Array<{ data: Array<{ name: string; value: number }> }> }
  assert(option.series[0]!.data[0]!.name === 'A' && option.series[0]!.data[0]!.value === 3, 'pie data shape wrong')
})

check('table slide: header row + body rows, column count matches', () => {
  const doc = compileOutline({
    title: 't',
    slides: [{ layout: 'table', columns: ['A', 'B', 'C'], rows: [['1', '2', '3']] }],
  })
  const table = doc.slides[0]!.elements.find((e) => e.type === 'table') as TableElement | undefined
  assert(!!table, 'no table element')
  assert(table!.columns.length === 3, 'column count mismatch')
  assert(table!.rows.length === 2, 'expected header + 1 body row')
  assert(table!.rows[0]!.cells[0]!.html === 'A', 'header cell content wrong')
  assert(table!.style.color !== table!.style.headerBg, 'table style must be themed, not left at defaults')
})

check('image slide: placeholder element carries phSlot and a safe data: src', () => {
  const doc = compileOutline({ title: 't', slides: [{ layout: 'image', alt: 'a mountain' }] })
  const img = doc.slides[0]!.elements.find((e) => e.type === 'image') as (ImageElement & { phSlot?: string }) | undefined
  assert(!!img, 'no image element')
  assert(typeof img!.phSlot === 'string' && img!.phSlot.length > 0, 'phSlot not set')
  assert(img!.src.startsWith('data:image/svg+xml'), 'placeholder src should be an inline svg data URI')
})

// --- morph pairing ---

check('a shared morphGroup pairs title elements via morphId and morphs the later slide', () => {
  const doc = compileOutline(fullOutline)
  const first = doc.slides[0]!
  const second = doc.slides[1]!
  const firstTitle = textRole(first, 'title')!
  const secondTitle = textRole(second, 'title')!
  assert(!!firstTitle.morphId, 'first slide of the morph group has no morphId')
  assert(firstTitle.morphId === secondTitle.morphId, 'morphIds do not match across the group')
  assert(second.transition === 'morph', 'later slide in the group should have transition:"morph"')
  assert(first.transition !== 'morph', 'first slide of a group should not itself be transition:"morph"')
})

check('slides NOT sharing a morphGroup do not get morphId or transition:"morph"', () => {
  const doc = compileOutline(fullOutline)
  const section = doc.slides[2]! // 'section' layout, no morphGroup
  assert(section.transition !== 'morph', 'ungrouped slide unexpectedly set to morph')
  for (const el of section.elements) assert(!el.morphId, 'ungrouped slide element unexpectedly carries a morphId')
})

check('a morphGroup on a slide with no title-ish element is a no-op, not a crash', () => {
  const doc = compileOutline({
    title: 't',
    slides: [
      { layout: 'quote', quote: 'a', morphGroup: 'g' },
      { layout: 'quote', quote: 'b', morphGroup: 'g' },
    ],
  })
  assert(doc.slides[1]!.transition !== 'morph', 'quote-only group should not set transition:"morph"')
})

// --- schema validation surfaces clear errors ---

check('parseOutline rejects a missing title with a field-scoped error', () => {
  const result = parseOutline({ slides: [{ layout: 'title', heading: 'H' }] })
  assert(!result.ok, 'expected rejection')
  assert(result.errors.some((e) => e.field === 'title'), 'expected a title field error')
})

check('parseOutline rejects an unknown layout', () => {
  const result = parseOutline({ title: 't', slides: [{ layout: 'nonsense' }] })
  assert(!result.ok, 'expected rejection')
  assert(result.errors.some((e) => e.field === 'slides[0].layout'), 'expected a layout field error')
})

check('parseOutline rejects a chart whose series length does not match categories', () => {
  const result = parseOutline({
    title: 't',
    slides: [{ layout: 'chart', chartType: 'bar', categories: ['A', 'B'], series: [{ name: 'S', data: [1] }] }],
  })
  assert(!result.ok, 'expected rejection')
  assert(result.errors.some((e) => e.field === 'slides[0].series[0].data'), 'expected a series-length error')
})

check('parseOutline rejects a pie chart with more than one series', () => {
  const result = parseOutline({
    title: 't',
    slides: [{
      layout: 'chart', chartType: 'pie', categories: ['A'],
      series: [{ name: 'S1', data: [1] }, { name: 'S2', data: [2] }],
    }],
  })
  assert(!result.ok, 'expected rejection')
})

check('parseOutline accepts the full example outline with zero errors', () => {
  const result = parseOutline(fullOutline)
  assert(result.ok, `unexpected errors: ${JSON.stringify((result as { errors: unknown }).errors)}`)
})

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
