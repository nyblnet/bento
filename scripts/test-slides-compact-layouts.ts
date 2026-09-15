#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Compact input, round three: placement by layout and role (compact.ts).
//
//   node scripts/test-slides-compact-layouts.ts
//
// WHAT THIS PROVES. A compact slide that names a layout and gives its
// elements roles expands to EXACTLY the layout's frames with the content
// applied (through model.ts applyLayout — the same matching the editor's
// "Apply layout" uses), slides born from the same layout share element ids
// (so their chrome morphs), an unknown role falls back to the body slot with
// a load-report note, explicit geometry always wins, more bodies than slots
// stack into the slot without overlapping (equal shares here; compactload.ts
// restacks by measured height — source-asserted), the four added built-in
// layouts carry the roles AGENTS.md says they do, and AGENTS.md's table of
// layouts and roles is generated from the code so it cannot drift.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { expandDocWithStats, layoutRoles, findLayout, LAYOUT_ALIASES, STACK_GAP } from '../slides/src/compact.ts'
import { builtinLayouts, applyLayout, type Slide, type SlideElement, type TextElement, type ImageElement } from '../slides/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')
type Obj = Record<string, unknown>
const els = (s: Slide) => s.elements as unknown as Obj[]
const text = (s: Slide, id: string) => s.elements.find((e) => e.id === id) as TextElement | undefined
const frame = (e: SlideElement | undefined) => e ? `${e.x},${e.y},${e.w}x${e.h}` : 'none'

console.log('the built-in layouts and their roles\n')
const layouts = builtinLayouts()
const byId = Object.fromEntries(layouts.map((l) => [l.id, l]))
const expectRoles: Record<string, string[]> = {
  'layout-title': ['title', 'subtitle'],
  'layout-title-content': ['title', 'body'],
  'layout-two-col': ['title', 'body', 'left', 'right'],
  'layout-section': ['title', 'kicker'],
  'layout-three-cards': ['title', 'card1', 'card2', 'card3'],
  'layout-quote': ['quote', 'attribution'],
  'layout-image-left': ['image', 'title', 'body'],
  'layout-image-right': ['title', 'body', 'image'],
  'layout-blank': [],
}
ok(layouts.map((l) => l.id).sort().join() === Object.keys(expectRoles).sort().join(), `nine built-in layouts (${layouts.length})`)
for (const [id, roles] of Object.entries(expectRoles)) {
  ok(Object.keys(layoutRoles(byId[id])).sort().join() === [...roles].sort().join(), `${id}: roles ${roles.join(', ') || '(none)'}`)
}
ok(layoutRoles(byId['layout-two-col']).left === 'l2c-left' && layoutRoles(byId['layout-two-col']).right === 'l2c-right', 'left/right are the first and second body slot of the two-column layout')
const ids = layouts.flatMap((l) => l.elements.map((e) => e.id))
ok(new Set(ids).size === ids.length, 'every layout element id is unique across the built-ins (lineage cannot collide)')
const cards = byId['layout-three-cards']
ok(['l3c-bg1', 'l3c-card1'].every((id) => cards.elements.find((e) => e.id === id)?.groupId === 'l3c-g1'), 'a card and its backdrop share a groupId (they move as one)')
ok(['title-body', 'two-column', 'cards'].every((a) => findLayout(a, {})?.id === LAYOUT_ALIASES[a]) && findLayout('quote', {})?.id === 'layout-quote' && findLayout('layout-section', {})?.id === 'layout-section', 'a layout is found by alias, by short name and by id')
const scaled = findLayout('title-body', { size: { width: 1280, height: 720 } })!
ok(text(scaled, 'ltc-title')!.w === 1088, 'the layout is scaled to the deck size (1088 wide on a 1280 deck)')

console.log('\nexpansion by role\n')
const one = expandDocWithStats({ compact: true, slides: [
  { id: 'a', layout: 'title-body', elements: [{ role: 'title', md: 'Hi' }, { role: 'body', md: '- a\n- b' }] },
  { id: 'b', layout: 'title-body', elements: [{ role: 'title', md: 'Second' }, { role: 'body', md: 'Text' }] },
] })
const a = one.doc.slides[0], b = one.doc.slides[1]
const ref = findLayout('title-body', { size: { width: 1280, height: 720 } })!
ok(els(a).map((e) => e.id).join() === ref.elements.map((e) => e.id).join(), 'the slide has exactly the layout\'s elements, in order, with the layout\'s ids')
ok(frame(text(a, 'ltc-title')) === frame(text(ref, 'ltc-title')) && frame(text(a, 'ltc-body')) === frame(text(ref, 'ltc-body')), 'title and body sit exactly on the layout\'s frames')
ok(text(a, 'ltc-title')!.html === 'Hi' && /• a<br>• b|<li>a/.test(text(a, 'ltc-body')!.html), 'content applied: the title, and the markdown body as the editor converts it')
ok(text(a, 'ltc-title')!.fontSize === text(ref, 'ltc-title')!.fontSize && text(a, 'ltc-title')!.fontWeight === 700, 'typography is the layout\'s (44→scaled, weight 700), not the compact default')
ok(els(a).every((e) => !(e.placeholder && !(e.html as string))), 'no leftover placeholder prompt: every text slot was filled')
ok(text(b, 'ltc-title')!.id === text(a, 'ltc-title')!.id, 'two slides from the same layout share element ids — their titles morph')
ok(!('layout' in (a as unknown as Obj)), 'the compact `layout` key never reaches the document')
ok(one.stats.laidOut === 2 && one.stats.notes.length === 0, 'stats: two slides laid out, no notes')

console.log('\nfallbacks, explicit geometry, images\n')
const two = expandDocWithStats({ compact: true, slides: [
  { id: 'c', layout: 'title-body', elements: [
    { role: 'title', md: 'T' }, { role: 'quote', md: 'Q' },
    { type: 'shape', shape: 'rect', x: 10, y: 20, w: 30, h: 40, role: 'title' },
    { type: 'text', role: 'title', x: 700, y: 600, w: 200, h: 50, html: 'Explicit' },
  ] },
  { id: 'd', layout: 'section', elements: [{ role: 'body', md: 'No body slot here' }] },
  { id: 'e', layout: 'no-such-layout', elements: [{ type: 'text', x: 1, y: 2, w: 3, h: 4, html: 'x' }] },
  { id: 'f', layout: 'image-left', elements: [{ type: 'image', role: 'image', src: 'data:,', fit: 'cover' }, { role: 'title', md: 'Pic' }] },
  { id: 'g', layout: 'two-column', elements: [{ role: 'left', md: 'L' }, { role: 'right', md: 'R' }] },
] })
const c = two.doc.slides[0]
ok(text(c, 'ltc-body')!.html === 'Q', 'a role the layout has no slot for lands in the body slot')
ok(two.stats.notes.some((n) => n.path === '/slides/0/elements/1/role' && /no `quote` slot in layout `layout-title-content`; placed as body/.test(n.reason)), 'and the load report says so, with the path')
const shape = els(c).find((e) => e.type === 'shape' && e.x === 10)
ok(!!shape && shape.w === 30 && shape.h === 40, 'explicit geometry wins: the shape sits where the author put it, role or not')
const explicit = els(c).find((e) => e.html === 'Explicit')
ok(!!explicit && explicit.x === 700 && explicit.y === 600, 'a text with a frame and a role is placed as given, not into the slot')
ok(text(c, 'ltc-title')!.html === 'T', '…and the slot took the frameless title')
const d = two.doc.slides[1]
ok(two.stats.notes.some((n) => n.path === '/slides/1/elements/0/role' && /no body slot; placed at the default frame/.test(n.reason)) && els(d).some((e) => e.html === 'No body slot here'), 'no body slot at all: placed at the default frame, reported')
const e = two.doc.slides[2]
ok(two.stats.notes.some((n) => n.path === '/slides/2/layout' && /unknown layout/.test(n.reason)) && els(e).length === 1 && els(e)[0].x === 1, 'an unknown layout: elements placed as given, reported')
const f = two.doc.slides[3]
const pic = f.elements.find((x) => x.id === 'lil-image') as ImageElement | undefined
ok(!!pic && pic.type === 'image' && pic.src === 'data:,' && pic.fit === 'cover' && frame(pic) === frame(text(findLayout('image-left', { size: { width: 1280, height: 720 } })!, 'lil-image')), 'an image donor REPLACES the image slot: picture, fit kept, slot frame and id')
ok(text(f, 'lil-title')!.html === 'Pic', 'the title beside it is filled')
const g = two.doc.slides[4]
ok(text(g, 'l2c-left')!.html === 'L' && text(g, 'l2c-right')!.html === 'R', 'left/right fill the two-column layout\'s columns')

console.log('\nstacking bodies\n')
const three = expandDocWithStats({ compact: true, slides: [
  { id: 'h', layout: 'title-body', elements: [{ role: 'title', md: 'T' }, { role: 'body', md: 'p1' }, { role: 'body', md: 'p2' }, { role: 'body', md: 'p3' }] },
] })
const h = three.doc.slides[0]
const slot = text(findLayout('title-body', { size: { width: 1280, height: 720 } })!, 'ltc-body')!
const bodies = ['ltc-body', 'ltc-body-2', 'ltc-body-3'].map((id) => text(h, id)!)
ok(bodies.every(Boolean) && bodies.map((x) => x.html).join() === 'p1,p2,p3', 'three bodies → the slot and two more, ids derived from the slot')
const share = Math.floor((slot.h - STACK_GAP * 2) / 3)
ok(bodies.every((x) => x.h === share) && bodies.every((x, i) => x.y === slot.y + i * (share + STACK_GAP)), `equal shares of the slot (${share} px) with a ${STACK_GAP} px gap`)
ok(bodies.every((x, i) => i === 0 || x.y >= bodies[i - 1].y + bodies[i - 1].h), 'no overlap')
ok(bodies[2].y + bodies[2].h <= slot.y + slot.h, 'the stack stays inside the slot')
ok(bodies.every((x) => x.x === slot.x && x.w === slot.w && x.fontSize === slot.fontSize), 'each keeps the slot\'s x, width and typography')
ok(three.stats.stacks.length === 1 && three.stats.stacks[0].ids.join() === 'ltc-body,ltc-body-2,ltc-body-3' && three.stats.autoHeight.length === 3, 'stats name the stack and mark each for measuring')
const load = read('slides/src/compactload.ts')
ok(/export function restack\(/.test(load) && /fitAutoHeights\(doc, stats\)\n\s*restack\(doc, stats\)/.test(load), 'compactload restacks by measured height after fitting (browser side)')
ok(/y \+= el\.h \+ STACK_GAP/.test(load), 'restack lays them top-to-bottom with the same gap')
ok(/restack\(store\.doc, \{ stacks: parsed\.report\.stacks \}\)/.test(read('slides/src/main.ts')), 'the fonts-ready re-fit restacks too')

console.log('\nthe editor path is the same one\n')
const donorSlide = { id: 'x', elements: [{ id: 'q', type: 'text', role: 'title', html: 'Hi', x: 0, y: 0, w: 1, h: 1 }] } as unknown as Slide
const applied = applyLayout(donorSlide, byId['layout-title-content'], new Set(ids))
ok((applied.find((x) => x.id === 'ltc-title') as TextElement).html === 'Hi', 'applyLayout (the editor\'s "Apply layout") fills a slot by role the same way')
ok(/applyLayout\(slideForApply, layout, known\)/.test(read('slides/src/compact.ts')), 'compact.ts calls that function, not a copy of it')
ok(!/layout\?:/.test(read('slides/src/model.ts').slice(read('slides/src/model.ts').indexOf('export interface Slide '))), 'the Slide model gains no `layout` field — input only')

console.log('\nAGENTS.md cannot drift\n')
const agents = read('AGENTS.md')
for (const l of layouts) {
  if (l.id === 'layout-blank') continue
  const roles = Object.keys(layoutRoles(l))
  const line = `\`${l.id.replace(/^layout-/, '')}\` — ${roles.join(', ')}`
  ok(agents.includes(line), `AGENTS.md lists ${line}`)
}
ok(/"layout": "title-body"/.test(agents) && /"role": "title"/.test(agents), 'AGENTS.md shows the layout + role example')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
