#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The Export section's contrast reading is measured where it is weakest.
//
//   esbuild scripts/test-slides-contrast.ts --bundle --platform=node --format=esm --outfile=/tmp/c.mjs && node /tmp/c.mjs
//
// WHAT THIS PROVES (editor/inspector/contrast.ts, pure model maths):
//   1. a flat text on a flat slide reads the textbook ratio (white on black 21:1);
//   2. the backdrop is what lies BEHIND each point: a card under half the text
//      makes that half the weak one, and the reading says where;
//   3. opacity counts — the element's, and a translucent card's;
//   4. gradients are evaluated at the point, in CSS geometry: a text over a
//      black→white card is worst where the card turns white;
//   5. a rotated card covers what it covers once turned;
//   6. text is judged where its glyphs are (line boxes from the caller), not
//      in the empty corners of a box larger than its words;
//   7. pictures have no colour of their own to judge (null).
import { measureContrast } from '../slides/src/editor/inspector/contrast.ts'

let checks = 0, failures = 0
function ok(cond: unknown, msg: string) { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }
const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) <= tol

const text = (o: object = {}) => ({ id: 't', type: 'text', x: 100, y: 100, w: 400, h: 100, rotation: 0, opacity: 1, html: 'x', fontSize: 20, fontFamily: 'x', fontWeight: 400, color: '#ffffff', ...o })
const card = (o: object = {}) => ({ id: 'c', type: 'shape', shape: 'rect', x: 0, y: 0, w: 300, h: 720, rotation: 0, opacity: 1, fill: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0, ...o })
const slide = (bg: string, elements: object[]) => ({ id: 's', background: bg, transition: 'none', notes: '', elements }) as never

console.log('\nflat\n')
{
  const r = measureContrast(text() as never, slide('#000000', [text()]))!
  ok(near(r.ratio, 21), `white on black reads 21:1 (${r.ratio.toFixed(2)})`)
  ok(r.samples.length === 25 && r.samples.every((x) => near(x, 21)), 'every one of the 25 points agrees')
}

console.log('\nwhat lies behind each point\n')
{
  // the white card covers x 0..300: the text's left half (100..300) sits on white
  const r = measureContrast(text() as never, slide('#000000', [card(), text()]))!
  ok(near(r.ratio, 1), `white text half over a white card: the worst point is 1:1 (${r.ratio.toFixed(2)})`)
  ok(r.at[0] === 0, `and it is on the left (column ${r.at[0]})`)
  ok(r.samples.some((x) => near(x, 21)), 'the right half still reads 21:1 — a centre-only sample would have missed nothing or everything')
  const after = measureContrast(text() as never, slide('#000000', [text(), card()]))!
  ok(near(after.ratio, 21), 'a card ABOVE the text in paint order is not its backdrop')
  ok(near(measureContrast(text() as never, slide('#000000', [card({ hidden: true }), text()]))!.ratio, 21), 'nor is a hidden one')
}

console.log('\nonly where the glyphs are\n')
{
  // the text BOX overhangs the black card onto a white slide, but its words sit on the card
  const box = measureContrast(text() as never, slide('#ffffff', [card({ fill: '#000000' }), text()]))!
  ok(near(box.ratio, 1), `sampled over the whole box, the empty overhang reads 1:1 (${box.ratio.toFixed(2)})`)
  const glyphs = measureContrast(text() as never, slide('#ffffff', [card({ fill: '#000000' }), text()]), 5, [{ x: 100, y: 100, w: 60, h: 24 }])!
  ok(near(glyphs.ratio, 21), `sampled over the line the words fill, it reads the card: 21:1 (${glyphs.ratio.toFixed(2)})`)
}

console.log('\nopacity\n')
{
  const half = measureContrast(text({ opacity: 0.5 }) as never, slide('#000000', [text()]))!
  ok(half.ratio > 4 && half.ratio < 6, `white text at 50% on black is grey on black (${half.ratio.toFixed(2)}), not 21:1`)
  const veil = measureContrast(text() as never, slide('#000000', [card({ w: 1280, opacity: 0.5 }), text()]))!
  ok(veil.ratio > 1.5 && veil.ratio < 6, `a half-transparent white card under white text lifts the backdrop (${veil.ratio.toFixed(2)})`)
  const rgbaCard = measureContrast(text() as never, slide('#000000', [card({ w: 1280, fill: 'rgba(255,255,255,0.5)' }), text()]))!
  ok(near(rgbaCard.ratio, veil.ratio, 0.01), 'a fill\'s own alpha counts the same as the card\'s opacity')
}

console.log('\ngradients, evaluated at the point\n')
{
  // 90deg: left→right, black to white across the whole slide-wide card
  const g = card({ w: 1280, fillGradient: { angle: 90, stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }] } })
  const r = measureContrast(text() as never, slide('#000000', [g, text()]))!
  ok(r.at[0] === 2, `white text over a black→white card is weakest on the right, where the card is lightest (column ${r.at[0]})`)
  const first = measureContrast(text() as never, slide('#000000', [card({ w: 1280, fill: '#000000' }), text()]))!
  ok(r.ratio < first.ratio - 1, `and weaker than the first stop alone would say (${r.ratio.toFixed(2)} < ${first.ratio.toFixed(2)})`)
  const own = measureContrast(text({ colorGradient: { angle: 90, stops: [{ at: 0, color: '#ffffff' }, { at: 1, color: '#000000' }] } }) as never, slide('#000000', [text()]))!
  ok(own.at[0] === 2 && own.ratio < 3, `a text gradient fading to black on black is weakest where it ends (${own.ratio.toFixed(2)})`)
}

console.log('\nrotation\n')
{
  // a thin white bar turned 90° about its centre stands upright through the text's middle
  const bar = card({ x: 100, y: 145, w: 400, h: 10, rotation: 90 })
  const r = measureContrast(text() as never, slide('#000000', [bar, text()]))!
  ok(near(r.ratio, 1) && r.at[0] === 1, `a turned bar is the backdrop where it stands once turned — the centre column (${r.ratio.toFixed(2)}, column ${r.at[0]})`)
}

console.log('\nnothing to judge\n')
ok(measureContrast({ id: 'i', type: 'image', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, src: '' } as never, slide('#000', [])) === null, 'a picture has no colour of its own to judge')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
