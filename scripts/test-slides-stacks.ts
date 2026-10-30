// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Fill and stroke stacks: the top visible layer is mirrored for older shells,
// colour references move with their layer, the gate keeps a good stack and
// drops a bad one whole, and the paint gate covers every layer.
//
//   slides/node_modules/.bin/esbuild scripts/test-slides-stacks.ts --bundle --platform=node --format=esm --outfile=/tmp/s.mjs && node /tmp/s.mjs
//
// WHAT THIS PROVES:
//   1. mirrorStacks writes the TOP VISIBLE layer into fill/fillGradient and
//      stroke/strokeWidth/strokeAlign/strokeDashes — skipping a hidden top —
//      and an all-hidden stack leaves nothing drawn by an older shell;
//   2. setFillLayers/setStrokeLayers make a stack only from two layers and
//      fold one back into the plain keys, carrying themeRefs by layer: a ref
//      on `fill` becomes `fills.0.color`, follows a reorder, dies with its
//      layer, and goes back to `fill` when one layer is left;
//   3. the file gate keeps fills/strokes and drops a stack with one bad layer
//      (the element survives); paintSafeShape gates each layer's colour;
//   4. a stroke layer's gradient mirrors to `strokeGradient` (and folds back),
//      a line's stroke layers mirror to `fill` (its colour), and the gate keeps
//      a layer's blend only from CSS's closed list and gates stroke gradients.
import { sanitizeElement } from '../slides/src/untrusted.ts'
import { paintSafeShape } from '../slides/src/render.ts'
import { mirrorStacks, setFillLayers, setStrokeLayers, strokeLayers } from '../slides/src/stacks.ts'
import type { ShapeElement } from '../slides/src/model.ts'

let checks = 0
let failures = 0
function ok(cond: unknown, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const rect = (): ShapeElement => ({
  id: 'r', type: 'shape', shape: 'rect', x: 0, y: 0, w: 100, h: 50, rotation: 0, opacity: 1,
  fill: '#336699', stroke: '#000000', strokeWidth: 2, radius: 0,
} as ShapeElement)

console.log('\nthe fallback mirror\n')
{
  const el = rect()
  el.fills = [{ color: '#111111' }, { color: '#222222', gradient: { angle: 90, stops: [{ at: 0, color: '#ff0000' }, { at: 1, color: '#0000ff' }] } }]
  mirrorStacks(el)
  ok(el.fill === '#222222' && el.fillGradient?.stops[0].color === '#ff0000', 'fill/fillGradient mirror the top layer')
  el.fills[1].hidden = true
  mirrorStacks(el)
  ok(el.fill === '#111111' && !el.fillGradient, 'a hidden top layer is skipped: the next visible one is mirrored')
  el.fills[0].hidden = true
  mirrorStacks(el)
  ok(el.fill === 'transparent', 'all hidden: an older shell fills nothing')
  el.strokes = [{ color: '#aaaaaa', width: 8, align: 'outside' }, { color: '#bbbbbb', width: 3, dashes: [6, 2] }]
  mirrorStacks(el)
  ok(el.stroke === '#bbbbbb' && el.strokeWidth === 3 && !el.strokeAlign && JSON.stringify(el.strokeDashes) === '[6,2]', 'stroke keys mirror the top stroke layer, its absent align included')
  ok(!mirrorStacks(el), 'a second mirror changes nothing (the doc hook cannot loop)')
}

console.log('\nlayers and references\n')
{
  const el = rect()
  el.themeRefs = { fill: 'accent1' }
  setFillLayers(el, [{ color: '#336699' }, { color: '#ffffff' }], [0, -1])
  ok(el.fills?.length === 2 && el.fill === '#ffffff', 'two layers make a stack, mirrored from the top')
  ok(el.themeRefs?.['fills.0.color'] === 'accent1' && !el.themeRefs?.fill, "the single fill's ref moves to fills.0.color")
  setFillLayers(el, [{ color: '#ffffff' }, { color: '#336699' }], [1, 0])
  ok(el.themeRefs?.['fills.1.color'] === 'accent1' && !el.themeRefs?.['fills.0.color'], 'a reorder carries the ref with its layer')
  setFillLayers(el, [{ color: '#336699' }], [1])
  ok(!el.fills && el.fill === '#336699' && el.themeRefs?.fill === 'accent1', 'one layer folds back into `fill`, ref and all')
  setFillLayers(el, [{ color: '#336699' }, { color: '#000000' }], [0, -1])
  setFillLayers(el, [{ color: '#000000' }], [1])
  ok(!el.themeRefs, 'removing the referenced layer drops its ref')
  const s = rect()
  setStrokeLayers(s, [{ color: '#000000', width: 2 }, { color: '#ff0000', width: 6, align: 'outside' }], [0, -1])
  ok(s.strokes?.length === 2 && s.strokeWidth === 6 && s.strokeAlign === 'outside', 'a stroke stack mirrors its top layer')
  setStrokeLayers(s, [], [])
  ok(!s.strokes && s.strokeWidth === 0, 'no stroke layers = no stroke')
}

console.log('\nthe gates\n')
{
  const good = sanitizeElement({
    ...rect(),
    fills: [{ color: '#111111' }, { color: '#222222', hidden: true, gradient: { angle: 0, stops: [{ at: 0, color: '#ffffff' }, { at: 1, color: '#000000' }] } }],
    strokes: [{ color: '#333333', width: 2 }, { color: '#444444', width: 4, align: 'inside', dashes: [4, 4] }],
  }) as Record<string, any>
  ok(good?.fills?.length === 2 && good.fills[1].hidden === true && good.fills[1].gradient?.stops.length === 2, 'the gate keeps a fill stack')
  ok(good?.strokes?.[1]?.align === 'inside' && JSON.stringify(good.strokes[1].dashes) === '[4,4]', 'the gate keeps a stroke stack')
  const bad = sanitizeElement({ ...rect(), fills: [{ color: '#111111' }, { color: 'url(https://x.test/a.svg)' }] }) as Record<string, any>
  ok(bad && !bad.fills && bad.fill === '#336699', 'one bad layer drops the whole stack, never the element')
  const odd = sanitizeElement({ ...rect(), strokes: [{ color: '#111111' }] }) as Record<string, any>
  ok(odd && !odd.strokes, 'a stroke layer without a width is refused')
  const safe = paintSafeShape({ ...rect(), fills: [{ color: 'url(https://x.test/a)' }, { color: '#fff', gradient: { angle: 0, stops: [{ at: 0, color: 'url(https://x.test/b)' }] } }], strokes: [{ color: 'url(https://x.test/c)', width: 1 }] })
  ok(safe.fills![0].color === 'transparent' && safe.fills![1].gradient!.stops[0].color === 'transparent' && safe.strokes![0].color === 'transparent',
    'paintSafeShape gates every layer colour, gradient stops included')
}

console.log('\nstroke gradients, lines, blend\n')
{
  const G = { angle: 90, stops: [{ at: 0, color: '#ff0000' }, { at: 1, color: '#0000ff' }] }
  const el = rect()
  setStrokeLayers(el, [{ color: '#000000', width: 2 }, { color: '#ff0000', width: 4, gradient: G }], [0, -1])
  ok(el.strokeGradient?.stops[1].color === '#0000ff' && el.stroke === '#ff0000', 'a gradient top stroke layer mirrors to strokeGradient, its colour the fallback')
  setStrokeLayers(el, [{ color: '#000000', width: 2 }], [0])
  ok(!el.strokes && !el.strokeGradient && el.stroke === '#000000', 'folding to a solid layer drops strokeGradient')
  el.themeRefs = { 'strokeGradient.stops.0.color': 'accent1' }
  el.strokeGradient = JSON.parse(JSON.stringify(G))
  setStrokeLayers(el, [...strokeLayers(el), { color: '#00ff00', width: 1 }], [0, -1])
  ok(el.themeRefs?.['strokes.0.gradient.stops.0.color'] === 'accent1', "a single stroke gradient's stop ref moves into its layer")

  const line = { ...rect(), shape: 'line', fill: '#123456', strokeWidth: 0 } as ShapeElement
  ok(strokeLayers(line).length === 1 && strokeLayers(line)[0].color === '#123456' && strokeLayers(line)[0].width === 2, "a line's one stroke is its fill, at least 2px")
  setStrokeLayers(line, [...strokeLayers(line), { color: '#abcdef', width: 6 }], [0, -1])
  ok(line.strokes?.length === 2 && line.fill === '#abcdef' && line.strokeWidth === 6, "a line's stroke stack mirrors its top layer into fill (its colour) and strokeWidth")
  setStrokeLayers(line, [{ color: '#654321', width: 3 }], [1])
  ok(!line.strokes && line.fill === '#654321', 'one layer left folds back into the line colour')

  const kept = sanitizeElement({
    ...rect(),
    fills: [{ color: '#111111', blend: 'multiply' }, { color: '#222222', blend: 'url(x)' }],
    strokes: [{ color: '#333333', width: 2, blend: 'screen', gradient: G }, { color: '#444444', width: 4 }],
    strokeGradient: G,
  }) as Record<string, any>
  ok(kept?.fills?.[0]?.blend === 'multiply' && kept.strokes?.[0]?.blend === 'screen', 'the gate keeps a layer blend from the list')
  ok(kept?.fills?.length === 2 && !('blend' in kept.fills[1]), 'a blend outside the list is dropped; its layer stays')
  ok(kept?.strokes?.[0]?.gradient?.stops.length === 2 && kept.strokeGradient?.stops.length === 2, 'the gate keeps stroke-layer gradients and strokeGradient')
  const safe = paintSafeShape({ ...rect(), strokeGradient: { angle: 0, stops: [{ at: 0, color: 'url(https://x.test/d)' }] }, strokes: [{ color: '#000', width: 1, gradient: { angle: 0, stops: [{ at: 0, color: 'url(https://x.test/e)' }] } }] })
  ok(safe.strokeGradient!.stops[0].color === 'transparent' && safe.strokes![0].gradient!.stops[0].color === 'transparent', 'paintSafeShape gates stroke gradients too')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
