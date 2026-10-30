// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The paint keys of the format: radial gradients, stroke position and dashes,
// per-corner radii, flip — what the gate keeps, what it drops, and the CSS a
// radial gradient becomes.
//
//   slides/node_modules/.bin/esbuild scripts/test-slides-paint.ts --bundle --platform=node --format=esm --outfile=/tmp/p.mjs && node /tmp/p.mjs
//
// WHAT THIS PROVES:
//   1. the file gate keeps every new key with a good value and drops a bad one
//      without dropping the element (an additive key costs only itself);
//   2. a radial gradient's CSS is sized like its SVG (radii r of the box, at
//      cx/cy), and a gradient without `kind` is still the linear one;
//   3. radialGeom fills the defaults an author can leave out.
import { sanitizeElement } from '../slides/src/untrusted.ts'
import { cssGradient, radialGeom } from '../kernel/src/shape.ts'

let checks = 0
let failures = 0
function ok(cond: unknown, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const rect = {
  id: 'r', type: 'shape', shape: 'rect', x: 0, y: 0, w: 100, h: 50, rotation: 0, opacity: 1,
  fill: '#336699', stroke: '#000000', strokeWidth: 2, radius: 12,
}

console.log('\nthe gate\n')
const good = sanitizeElement({
  ...rect,
  fillGradient: { angle: 90, kind: 'radial', cx: 0.3, cy: 0.7, r: 0.6, stops: [{ at: 0, color: '#ffffff' }, { at: 1, color: '#000000' }] },
  strokeAlign: 'outside', strokeDashes: [8, 4], radii: [0, 4, 8, 12], flipX: true, flipY: true,
}) as Record<string, any>
ok(good?.fillGradient?.kind === 'radial' && good.fillGradient.cx === 0.3 && good.fillGradient.r === 0.6, 'a radial gradient keeps kind, centre and radius')
ok(good?.strokeAlign === 'outside', 'strokeAlign is kept')
ok(JSON.stringify(good?.strokeDashes) === '[8,4]', 'strokeDashes is kept')
ok(JSON.stringify(good?.radii) === '[0,4,8,12]', 'radii is kept')
ok(good?.flipX === true && good?.flipY === true, 'flipX and flipY are kept')

const bad = sanitizeElement({
  ...rect,
  fillGradient: { angle: 90, kind: 'conic', stops: [{ at: 0, color: '#ffffff' }] },
  strokeAlign: 'middle', strokeDashes: [8], radii: [1, 2, 3], flipX: 'yes',
}) as Record<string, any>
ok(bad && bad.id === 'r', 'bad paint values never cost the element')
ok(bad.fillGradient && !('kind' in bad.fillGradient), 'an unknown gradient kind is dropped; the gradient stays (linear)')
ok(!('strokeAlign' in bad) && !('strokeDashes' in bad) && !('radii' in bad) && !('flipX' in bad), 'a bad strokeAlign, dash pair, radii list or flip is dropped')

console.log('\nradial CSS\n')
const stops = [{ at: 0, color: 'red' }, { at: 1, color: 'blue' }]
ok(cssGradient({ angle: 90, stops }) === 'linear-gradient(90deg, red 0%, blue 100%)', 'no kind: the linear gradient, as before')
ok(cssGradient({ angle: 90, stops, kind: 'radial', cx: 0.25, cy: 0.5, r: 0.5 }) === 'radial-gradient(50% 50% at 25% 50%, red 0%, blue 100%)', 'radial: radii r of the box, at the centre')
ok(JSON.stringify(radialGeom({ angle: 0, stops, kind: 'radial' })) === '{"cx":0.5,"cy":0.5,"r":0.5}', 'radialGeom fills centre and radius defaults')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
