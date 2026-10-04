#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Layers panel rig (discussion #371): the list is a VIEW onto slide.elements'
// paint order, and moving a row lands exactly where the Order buttons would.
//
//   node scripts/test-slides-layers.ts   (layerrows.ts is DOM-free and
//   node-importable; layers.ts is the DOM half)
//
// WHAT THIS PROVES. Rows come top-first (paint order reversed); every element
// type has a label, text is excerpted with markup stripped and truncated;
// grouped elements are indented; moveInPaintOrder to the end/start/±1 equals
// the panel's reorder('front'|'back')/step(±1) semantics (copied here as the
// reference — the same splice the Arrange kit does), a grouped element moves
// with its group, a no-op returns the same array; highlight follows the
// selection and lights a whole group; the list never reaches render.ts; the
// row SIGNATURE ignores everything a drag changes (a move or resize is
// 'same'; a content edit is 'labels'; reorder, add, remove or regroup is
// 'rows'); the section is mounted FIRST whatever is selected (one home) and
// the panel hands the same header/list nodes back on every rebuild.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { excerpt, labelFor, layerRows, moveInPaintOrder, highlighted, rowSignature, signatureDiff } from '../slides/src/editor/layerrows.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')
type E = { id: string; type: string; groupId?: string; [k: string]: unknown }
const el = (id: string, type = 'shape', extra: Record<string, unknown> = {}): E => ({ id, type, shape: 'rect', ...extra })
const ids = (a: { id: string }[]) => a.map((e) => e.id).join(' ')

// --- the reference: panels.ts Order-button semantics, verbatim in spirit ---
function refReorder<T extends { id: string }>(arr: T[], sel: string[], where: 'front' | 'back'): T[] {
  const s = new Set(sel); const picked = arr.filter((e) => s.has(e.id)); const rest = arr.filter((e) => !s.has(e.id))
  return where === 'front' ? [...rest, ...picked] : [...picked, ...rest]
}
function refStep<T extends { id: string }>(arr: T[], sel: string[], dir: 1 | -1): T[] {
  const a = [...arr]; const s = new Set(sel)
  const idxs = a.map((e, i) => (s.has(e.id) ? i : -1)).filter((i) => i >= 0)
  for (const i of dir > 0 ? [...idxs].reverse() : idxs) { const j = i + dir; if (j < 0 || j >= a.length || s.has(a[j].id)) continue; [a[i], a[j]] = [a[j], a[i]] }
  return a
}

console.log('rows\n')
const slide = { elements: [el('bg'), el('t', 'text', { html: '<p>Hello <b>world</b>&nbsp;&amp; friends, this is long text</p>' }), el('img', 'image'), el('c', 'chart')] as never[] }
const rows = layerRows(slide)
ok(ids(rows) === 'c img t bg', 'top of the stack first (paint order reversed)')
ok(rows.every((r, i) => r.index === slide.elements.length - 1 - i), 'each row remembers its paint index')
ok(rows[2].label === 'Hello world & friends,…' && rows[2].label.length <= 24, `text label is an excerpt, markup and entities out, cut to 24 with …: "${rows[2].label}"`)
ok(excerpt('<p>short</p>') === 'short', 'short text is not truncated')
ok(excerpt('a<br>b</p><p>c') === 'a b c', 'block breaks become spaces')
ok(excerpt('<p></p>') === '', 'empty html → empty (labelFor falls back to "Text")')
ok(labelFor({ type: 'text', html: '' } as never) === 'Text', 'an empty text box is labelled Text')
const kinds: Array<[E, string]> = [
  [el('a', 'shape', { shape: 'ellipse' }), 'Ellipse'], [el('a', 'shape', { shape: 'line' }), 'Line'], [el('a', 'shape', { shape: 'path' }), 'Curve'],
  [el('a', 'image'), 'Image'], [el('a', 'svg'), 'Diagram'], [el('a', 'chart'), 'Chart'], [el('a', 'table'), 'Table'], [el('a', 'code'), 'Code'],
  [el('a', 'media', { kind: 'video' }), 'Video'], [el('a', 'media', { kind: 'audio' }), 'Audio'], [el('a', 'embed'), 'Embed'],
]
ok(kinds.every(([e, want]) => labelFor(e as never) === want), 'every non-text type has its kind as label')
ok(labelFor(el('a', 'shape', { shape: 'rect' }) as never, (s) => `[${s}]`) === '[Rectangle]', 'kind labels go through the translator')
ok(labelFor(el('a', 'text', { html: 'hi' }) as never, (s) => `[${s}]`) === 'hi', 'text excerpts do not (user content)')

console.log('\ngroups\n')
const grouped = { elements: [el('a'), el('g1', 'shape', { groupId: 'G' }), el('g2', 'text', { html: 'x', groupId: 'G' }), el('z')] as never[] }
const grows = layerRows(grouped)
ok(grows.filter((r) => r.grouped).map((r) => r.id).join() === 'g2,g1', 'group members are marked (indented)')
ok(!grows[0].grouped && !grows[3].grouped, 'others are not')

console.log('\nmove = the Order buttons\n')
const base = [el('a'), el('b'), el('c'), el('d'), el('e')]
ok(ids(moveInPaintOrder(base, 'b', 4)) === ids(refReorder(base, ['b'], 'front')), 'to the end = Bring to front')
ok(ids(moveInPaintOrder(base, 'd', 0)) === ids(refReorder(base, ['d'], 'back')), 'to 0 = Send to back')
ok(ids(moveInPaintOrder(base, 'b', 2)) === ids(refStep(base, ['b'], 1)), '+1 = Bring forward one step')
ok(ids(moveInPaintOrder(base, 'd', 2)) === ids(refStep(base, ['d'], -1)), '−1 = Send backward one step')
ok(ids(moveInPaintOrder(base, 'a', 3)) === 'b c d a e', 'an arbitrary target index lands exactly there')
ok(moveInPaintOrder(base, 'c', 2) === base, 'moving to where it is returns the SAME array (no undo step)')
ok(moveInPaintOrder(base, 'nope', 0) === base, 'unknown id → same array')
ok(ids(moveInPaintOrder(base, 'a', 99)) === 'b c d e a' && ids(moveInPaintOrder(base, 'e', -5)) === 'e a b c d', 'targets are clamped')
const gbase = [el('a'), el('g1', 'shape', { groupId: 'G' }), el('g2', 'shape', { groupId: 'G' }), el('z')]
ok(ids(moveInPaintOrder(gbase, 'g1', 3)) === 'a z g1 g2', 'a grouped element moves with its whole group, order inside kept')
ok(ids(moveInPaintOrder(gbase, 'g2', 0)) === 'g1 g2 a z', '…to the back too')
ok(ids(moveInPaintOrder(gbase, 'g1', 3)) === ids(refReorder(gbase, ['g1', 'g2'], 'front')), 'which is what Bring to front does with the group selected')
// every single-step move agrees with refStep for every element
let agree = true
for (const e of base) for (const d of [1, -1] as const) {
  const i = base.indexOf(e); const to = i + d
  if (to < 0 || to >= base.length) continue
  if (ids(moveInPaintOrder(base, e.id, to)) !== ids(refStep(base, [e.id], d))) agree = false
}
ok(agree, 'every ±1 move on every element equals the panel step')

console.log('\nhighlight\n')
ok([...highlighted(grows, ['a'])].join() === 'a', 'a selected element lights its row')
ok([...highlighted(grows, ['g1'])].sort().join() === 'g1,g2', 'selecting one member lights the whole group (the canvas selects groups)')
ok(highlighted(grows, []).size === 0, 'nothing selected, nothing lit')

console.log('\nsignature — what a drag must not touch\n')
{
  const mk = (els: E[]) => ({ elements: els as never })
  const base = [el('a', 'text', { html: 'Hello' }), el('b'), el('c', 'text', { html: 'World', groupId: 'g' })]
  const sig0 = rowSignature(mk(base))
  const moved = base.map((e) => ({ ...e, x: 999, y: -5, w: 1, h: 1, rotation: 45, opacity: 0.2, fill: '#000' }))
  ok(signatureDiff(sig0, rowSignature(mk(moved))) === 'same', 'moving, resizing, rotating, recolouring every element: same signature')
  const relabel = base.map((e) => (e.id === 'a' ? { ...e, html: 'Hello there' } : e))
  ok(signatureDiff(sig0, rowSignature(mk(relabel))) === 'labels', 'editing a text box\'s content: labels only')
  ok(signatureDiff(sig0, rowSignature(mk([base[1], base[0], base[2]]))) === 'rows', 'reordering: rows')
  ok(signatureDiff(sig0, rowSignature(mk([...base, el('d')]))) === 'rows', 'adding an element: rows')
  ok(signatureDiff(sig0, rowSignature(mk(base.slice(0, 2)))) === 'rows', 'removing an element: rows')
  ok(signatureDiff(sig0, rowSignature(mk(base.map((e) => (e.id === 'b' ? { ...e, groupId: 'g' } : e))))) === 'rows', 'regrouping: rows')
  ok(signatureDiff(null, sig0) === 'rows', 'no rows yet: build them')
  ok(signatureDiff(sig0, rowSignature(mk(base))) === 'same', 'the same document twice: same')
}

console.log('\neditor-only\n')
ok(!/ed-layer|layers\.ts|LayersUI/.test(read('slides/src/render.ts')) && !/ed-layer|LayersUI/.test(read('slides/src/present.ts')), 'render.ts and present.ts know nothing of the list — thumbnails, the show, print and preview cannot carry it')
const panels = read('slides/src/editor/panels.ts')
{
  // one home: mounted once, before any of the three builders, whatever is selected
  const rebuild = panels.slice(panels.indexOf('private rebuild(force = false)'), panels.indexOf('private static CLOSED_BY_DEFAULT'))
  const mountAt = rebuild.indexOf('this.layers.mount(this.host)')
  ok(mountAt >= 0 && rebuild.indexOf('this.buildSlidePanel()') > mountAt && rebuild.indexOf('this.buildElementPanel(') > mountAt && rebuild.indexOf('this.buildMultiPanel(') > mountAt,
    'the list is mounted FIRST, before the Slide, element and multi builders alike — one home')
  ok((rebuild.match(/this\.layers\.mount\(/g) ?? []).length === 1, 'and only once per rebuild')
  ok(/this\.layers\.detach\(\)\s*\n\s*this\.host\.innerHTML = ''/.test(rebuild), 'the list is told before the host is cleared, so its scroll survives')
  ok(/this\.applyAccordion\(\)\s*\n\s*this\.layers\.restoreScroll\(\)/.test(rebuild), 'and put back AFTER the accordion has moved the list into its body (moving a node resets its scroll)')
  const ui = read('slides/src/editor/layers.ts')
  ok(/private header: HTMLElement/.test(ui) && /into\.appendChild\(this\.header\)\s*\n\s*into\.appendChild\(this\.list\)/.test(ui), 'mount re-appends the SAME header and list nodes (no new h3 per rebuild)')
  ok(/const diff = signatureDiff\(this\.sig, next\)[\s\S]*if \(diff === 'same'\) \{ this\.highlight\(\); return \}/.test(ui), 'refresh compares the signature first and only re-highlights when nothing a row says changed')
  ok(/if \(diff === 'labels'\)[\s\S]*label\.textContent = r\.label/.test(ui), 'a labels-only change patches text in place')
  ok(!/store\.on\(/.test(ui) && !/'selection'/.test(ui), 'the list has no store subscription of its own — the panel drives it, and selection never rebuilds rows')
  const acc = panels.slice(panels.indexOf('private applyAccordion()'), panels.indexOf('// --- builders'))
  ok(/if \(h\.dataset\.acc\) continue/.test(acc) && /h\.nextElementSibling/.test(acc), 'the accordion attaches one click handler per header for its lifetime and finds the body live (the Layers h3 outlives rebuilds)')
}
ok(/setOrder: \(elements\) => this\.store\.commit\(/.test(panels), 'a move is one store.commit — one undo step, no new field')
ok(/'Layers'\]\)/.test(panels.slice(panels.indexOf('CLOSED_BY_DEFAULT ='), panels.indexOf('CLOSED_BY_DEFAULT =') + 200)), 'closed by default (opened state persists per title like the other sections)')
const layers = read('slides/src/editor/layers.ts') + read('slides/src/editor/layerrows.ts')
ok(!/zIndex|z-index/.test(layers.replace(/^\s*(\/\/|\*).*$/gm, '')), 'no z-index in the code (comments aside) — the order IS the array')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
