// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Vector booleans: the computed outline covers exactly the area the operation means.
//
//   node scripts/test-slides-vector-bool.ts
//
// WHAT THIS PROVES. For rects and ellipses — overlapping, disjoint, nested,
// abutting and rotated — union, subtract, intersect and exclude produce an
// outline whose area matches the arithmetic (|A∪B| = |A|+|B|−|A∩B| and so on),
// measured two independent ways: the signed shoelace sum of the wound contours
// (which is only right if holes wind opposite their outlines, i.e. if an old
// shell's nonzero fill draws the holes) and an evenodd point grid over the
// emitted `d` re-flattened from text. And the result round-trips through the
// same path parser the editor uses for operands, so a boolean of a boolean works.
import { boolPolys, shapeToPoly, polyArea, polyToPath, flattenPath, inside, computeBool, canBool } from '../slides/src/vector-bool.ts'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const near = (a: number, b: number, rel = 0.01) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * rel)

const S = (o: Record<string, unknown>) => ({ type: 'shape', id: 's', x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1, fill: '#000', stroke: 'none', strokeWidth: 0, radius: 0, shape: 'rect', ...o }) as never

/** Evenodd area of an emitted path, by grid sampling (independent of winding). */
function gridArea(d: string, box: { x: number; y: number; w: number; h: number }) {
  const poly = flattenPath(d)
  const N = 300
  let hit = 0
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++)
    if (inside({ x: ((i + 0.5) / N) * box.w, y: ((j + 0.5) / N) * box.h }, poly)) hit++
  return (hit / (N * N)) * box.w * box.h
}

function check(name: string, a: never, b: never, op: 'union' | 'subtract' | 'intersect' | 'exclude', want: number) {
  const poly = boolPolys([shapeToPoly(a), shapeToPoly(b)], op)
  const area = polyArea(poly)
  ok(near(area, want), `${name} ${op}: wound area ${area.toFixed(0)} ≈ ${want.toFixed(0)}`)
  const r = polyToPath(poly)
  if (want < 1) { ok(!r || near(area, 0), `${name} ${op}: empty`); return }
  ok(!!r && near(gridArea(r.d, r), want, 0.02), `${name} ${op}: evenodd area of the emitted d ≈ ${want.toFixed(0)}`)
}

console.log('\noverlapping rects (100×100 at 0,0 and 50,50)\n')
const A = S({}), B = S({ x: 50, y: 50 })
check('rects', A, B, 'union', 17500)
check('rects', A, B, 'intersect', 2500)
check('rects', A, B, 'subtract', 7500)
check('rects', A, B, 'exclude', 15000)

console.log('\ndisjoint\n')
const far = S({ x: 300 })
check('disjoint', A, far, 'union', 20000)
check('disjoint', A, far, 'intersect', 0)
check('disjoint', A, far, 'subtract', 10000)
check('disjoint', A, far, 'exclude', 20000)

console.log('\ncontained (a 40×40 square inside, the donut case)\n')
const small = S({ x: 30, y: 30, w: 40, h: 40 })
check('contained', A, small, 'union', 10000)
check('contained', A, small, 'intersect', 1600)
check('contained', A, small, 'subtract', 8400)
check('contained', A, small, 'exclude', 8400)
check('container', small, A, 'subtract', 0)

console.log('\nabutting (share an edge)\n')
const side = S({ x: 100 })
check('abutting', A, side, 'union', 20000)
check('abutting', A, side, 'subtract', 10000)

console.log('\nellipses (r=50, centres 50 apart)\n')
const E1 = S({ shape: 'ellipse' }), E2 = S({ shape: 'ellipse', x: 50 })
const disc = Math.PI * 2500
// lens area for two circles r, centre distance d: 2r²acos(d/2r) − (d/2)√(4r²−d²)
const lens = 2 * 2500 * Math.acos(50 / 100) - 25 * Math.sqrt(4 * 2500 - 2500)
check('ellipses', E1, E2, 'union', 2 * disc - lens)
check('ellipses', E1, E2, 'intersect', lens)
check('ellipses', E1, E2, 'subtract', disc - lens)
check('ellipses', E1, E2, 'exclude', 2 * disc - 2 * lens)

console.log('\nrotation and radius\n')
ok(near(polyArea(shapeToPoly(S({ rotation: 45 }))), 10000), 'a rotated square keeps its area')
const diamond = shapeToPoly(S({ rotation: 45 }))
ok(near(Math.max(...diamond[0].map((p) => p.x)) - Math.min(...diamond[0].map((p) => p.x)), 141.4), 'and turns about its centre (diagonal is the new width)')
// the octagon: each diamond tip pokes 20.71 past the square, a triangle of area 20.71²
check('rotated', A, S({ rotation: 45 }), 'intersect', 10000 - 4 * 20.71 * 20.71)
const rr = 100 * 100 - (4 - Math.PI) * 20 * 20
ok(near(polyArea(shapeToPoly(S({ radius: 20 }))), rr), `a rounded rect's area is the square less its corners (${rr.toFixed(0)})`)

console.log('\nthe result is a path an operand can be\n')
const first = computeBool([A, small], 'subtract')!
const asShape = S({ shape: 'path', ...first, pathBox: [0, 0, first.w, first.h] })
ok(canBool({ type: 'shape', shape: 'path', d: first.d }), 'the closed result is itself boolean-able')
ok(near(polyArea(shapeToPoly(asShape)), 8400), 'a donut parsed back from its d keeps its hole (area 8400)')
check('donut ∪ plug', asShape, small, 'union', 10000)
ok(!canBool({ type: 'shape', shape: 'line' }) && !canBool({ type: 'shape', shape: 'path', d: 'M 0 0 L 10 10' }) && !canBool({ type: 'text' }), 'lines, open paths and text are refused')
ok(flattenPath('m 0 0 h 10 v 10 h -10 z')[0].length === 4, 'relative h/v commands parse')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
