#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Reveal authoring rig: reading order, the three verbs, the badge cycle, and
// the badges never reaching a render output.
//
//   node scripts/test-slides-reveal-ui.ts
//
// WHAT THIS PROVES. "Reveal in order" is a pure function of the selection's
// geometry — top-to-bottom, then left-to-right, rows found by vertical
// overlap — so two runs give the same numbers and a list numbers down while a
// row of cards numbers across. The verbs continue the slide's sequence rather
// than restarting it; Remove clears only what was stepped; a badge click
// walks 1…max+1 and wraps, never to 0. And the badge layer is editor chrome
// beside the render surface: render.ts, present.ts and preview.ts do not know
// its class name, so thumbnails, present, print and the file-manager preview
// cannot carry one.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readingOrder, revealInOrder, revealTogether, removeReveal, cycleStep, hasSteps, type Placed } from '../slides/src/editor/reveal.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')
const el = (id: string, x: number, y: number, w = 200, h = 60, step?: number): Placed =>
  ({ id, x, y, w, h, ...(step ? { fx: { step } } : {}) })
const ids = (els: { id: string }[]) => els.map((e) => e.id).join(' ')
const steps = (p: { id: string; step: number }[]) => p.map((q) => `${q.id}:${q.step}`).join(' ')

console.log('reading order\n')
const list = [el('c', 100, 300), el('a', 100, 100), el('b', 100, 200)]
ok(ids(readingOrder(list)) === 'a b c', 'a bullet list numbers down the page')
const cards = [el('r', 900, 200, 300, 200), el('l', 100, 200, 300, 200), el('m', 500, 200, 300, 200)]
ok(ids(readingOrder(cards)) === 'l m r', 'a row of cards numbers across')
const ragged = [el('r', 900, 210, 300, 180), el('l', 100, 200, 300, 220), el('m', 500, 190, 300, 200)]
ok(ids(readingOrder(ragged)) === 'l m r', 'cards a few pixels off each other are still one row')
const grid = [el('d', 500, 400), el('b', 500, 100), el('c', 100, 400), el('a', 100, 100)]
ok(ids(readingOrder(grid)) === 'a b c d', 'a 2×2 grid reads row by row')
const twoCol = [el('r1', 700, 100, 200, 60), el('l2', 100, 180, 200, 60), el('l1', 100, 100, 200, 60), el('r2', 700, 180, 200, 60)]
ok(ids(readingOrder(twoCol)) === 'l1 r1 l2 r2', 'two columns of lines interleave by row, as a reader scans them')
const tall = [el('title', 100, 40, 1000, 80), el('body', 100, 140, 1000, 400), el('side', 900, 200, 200, 60)]
ok(ids(readingOrder(tall)) === 'title body side', 'an element inside a taller neighbour\'s extent joins its row, after it')
const shuffled = [...grid].reverse()
ok(ids(readingOrder(shuffled)) === ids(readingOrder(grid)), 'order does not depend on input order')
ok(ids(readingOrder([el('y', 100, 100), el('x', 100, 100)])) === 'x y', 'exact ties break by id — deterministic')
ok(readingOrder([]).length === 0, 'empty selection, empty order')

console.log('\nreveal in order\n')
const slide = [el('t', 100, 40, 1000, 80), el('p1', 100, 200), el('p2', 100, 300), el('p3', 100, 400)]
ok(steps(revealInOrder(slide, [slide[3], slide[1], slide[2]])) === 'p1:1 p2:2 p3:3', 'three bullets → steps 1, 2, 3 in reading order')
const withBase = [el('t', 100, 40, 1000, 80, 2), el('p1', 100, 200), el('p2', 100, 300)]
ok(steps(revealInOrder(withBase, [withBase[1], withBase[2]])) === 'p1:3 p2:4', 'a second batch continues after the slide\'s last step')
const renumber = [el('p1', 100, 200, 200, 60, 5), el('p2', 100, 300, 200, 60, 9)]
ok(steps(revealInOrder(renumber, renumber)) === 'p1:1 p2:2', 're-ordering the same batch renumbers it from 1 (its own steps do not count as a base)')
ok(steps(revealInOrder(slide, [slide[2]])) === 'p2:1', 'one element → the next free step')

console.log('\nreveal together / remove\n')
ok(steps(revealTogether(slide, [slide[1], slide[2], slide[3]])) === 'p1:1 p2:1 p3:1', 'together → one step for all')
ok(steps(revealTogether(withBase, [withBase[1], withBase[2]])) === 'p1:3 p2:3', '…after the rest of the slide')
ok(steps(removeReveal([el('a', 0, 0, 1, 1, 2), el('b', 0, 0, 1, 1), el('c', 0, 0, 1, 1, 1)])) === 'a:0 c:0', 'remove clears only the stepped ones')
ok(removeReveal([el('b', 0, 0, 1, 1)]).length === 0, 'nothing stepped → nothing to write (no spurious undo step)')

console.log('\nbadge cycle\n')
const cyc = [el('a', 0, 0, 1, 1, 1), el('b', 0, 0, 1, 1, 2), el('c', 0, 0, 1, 1, 3)]
ok(cycleStep(cyc, cyc[0]) === 2, '1 → 2')
ok(cycleStep(cyc, cyc[2]) === 1, 'at the top (3, others max 2 → top 3) wraps to 1')
ok(cycleStep(cyc, cyc[1]) === 3, '2 → 3')
ok(cycleStep([el('a', 0, 0, 1, 1, 1)], el('a', 0, 0, 1, 1, 1)) === 1, 'alone on the slide: 1 → 1 (top is 1, wraps)')
ok(cycleStep([el('a', 0, 0, 1, 1, 1), el('z', 0, 0, 1, 1, 1)], el('a', 0, 0, 1, 1, 1)) === 2, 'joins one past the others\' last step')
ok([1, 2, 3, 4].every((s) => cycleStep(cyc, el('x', 0, 0, 1, 1, s)) > 0), 'never cycles to 0 — removing is a verb, not a click')
ok(!hasSteps(slide) && hasSteps(withBase), 'badges show only when the slide has a step')

console.log('\nbadges never reach a render output\n')
for (const f of ['slides/src/render.ts', 'slides/src/present.ts', 'slides/src/preview.ts', 'slides/src/print.ts']) {
  let src = ''
  try { src = read(f) } catch { continue }
  ok(!/step-badge|stepbadges|StepBadges/.test(src), `${f} knows nothing of the badge`)
}
const canvas = read('slides/src/editor/canvas.ts')
ok(/new StepBadges\(store, this\.stage,/.test(canvas), 'the layer mounts on the STAGE beside the render surface, not inside it')
const badges = read('slides/src/editor/stepbadges.ts')
ok(/hasSteps\(slide\.elements\)/.test(badges), 'the layer stands down on a slide without steps')
ok(!/renderSlide|sanitizeHtml/.test(badges), 'the badge module never renders slide content')

console.log('\nentry points\n')
const editor = read('slides/src/editor/editor.ts')
ok(/label: t\('Reveal in order'\)/.test(editor) && /label: t\('Reveal together'\)/.test(editor) && /label: t\('Remove reveal'\)/.test(editor), 'the element context menu carries the three verbs')
ok(/Right-click ▸ Reveal in order/.test(editor), 'the ? help sheet names the entry point')
const panels = read('slides/src/editor/panels.ts')
ok(/this\.revealRow\(els\)/.test(panels.slice(panels.indexOf('private buildMultiPanel'), panels.indexOf('private buildElementPanel'))), 'a multi-selection panel offers the verbs')
ok(/this\.revealRow\(\[el\]\)/.test(panels.slice(panels.indexOf('private buildPresentingProps'))), 'the Presenting section offers them for one element')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
