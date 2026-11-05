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
import { boolPolys, shapeToPoly, polyArea, polyToPath, flattenPath, inside, computeBool, canBool, operandsAt } from '../slides/src/vector-bool.ts'

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

console.log('\nelliptical arcs\n')
{
  // a circle of r=50 drawn as two half arcs
  const circle = flattenPath('M 0 50 A 50 50 0 0 1 100 50 A 50 50 0 0 1 0 50 Z')
  ok(near(Math.abs(polyArea(circle)), Math.PI * 2500, 0.01), `two arcs make a circle (area ${Math.abs(polyArea(circle)).toFixed(0)} ≈ ${(Math.PI * 2500).toFixed(0)})`)
  // packed flags ("01") and a relative arc: a half disc
  const half = flattenPath('M 0 50 a50 50 0 01 100 0 Z')
  ok(near(Math.abs(polyArea(half)), (Math.PI * 2500) / 2, 0.01), 'packed arc flags and relative arcs parse (half disc)')
  // the large-arc flag picks the far way round: three quarters of a circle
  const big = flattenPath('M 50 0 A 50 50 0 1 0 100 50 L 50 50 Z')
  ok(near(Math.abs(polyArea(big)), Math.PI * 2500 * 0.75, 0.01), 'the large-arc flag takes the long way (¾ disc)')
  // radii too small for the endpoints are scaled up to just reach (a half circle)
  ok(near(Math.abs(polyArea(flattenPath('M 0 0 A 1 1 0 0 1 100 0 Z'))), (Math.PI * 2500) / 2, 0.01), 'radii too small are scaled up, as SVG does')
  let threw = ''
  try { flattenPath('M0 0 L 10 0 L 10 10 A5 5 0 Z') } catch (e) { threw = String(e) }
  ok(!threw, `a truncated arc (flags missing) does not throw (${threw || 'no throw'})`)
  check('arc-circle ∩ square', S({ shape: 'path', d: 'M 0 50 A 50 50 0 0 1 100 50 A 50 50 0 0 1 0 50 Z', pathBox: [0, 0, 100, 100] }), S({ x: 50, y: 0, w: 100, h: 100 }), 'intersect', (Math.PI * 2500) / 2)
}

console.log('\nexact shared edges (no nudge)\n')
{
  const exact = (poly: any) => poly.flat().every((p: any) => Number.isInteger(Math.round(p.x * 1e6) / 1e6) && Math.abs(p.x - Math.round(p.x)) < 1e-9 && Math.abs(p.y - Math.round(p.y)) < 1e-9)
  const u = boolPolys([shapeToPoly(A), shapeToPoly(side)], 'union')
  ok(u.length === 1 && u[0].length === 4 && polyArea(u) === 20000 && exact(u), `abutting squares unite into ONE 200×100 rectangle, four exact corners (${u.map((c) => c.length)})`)
  const sub = boolPolys([shapeToPoly(A), shapeToPoly(side)], 'subtract')
  ok(sub.length === 1 && sub[0].length === 4 && polyArea(sub) === 10000 && exact(sub), 'subtracting an abutting square leaves the first, exactly')
  const int = boolPolys([shapeToPoly(A), shapeToPoly(side)], 'intersect')
  ok(int.length === 0, 'abutting squares have no intersection (no sliver)')
  const same = [shapeToPoly(A), shapeToPoly(S({}))]
  ok(polyArea(boolPolys(same, 'union')) === 10000 && boolPolys(same, 'union')[0].length === 4, 'a shape united with itself is itself')
  ok(polyArea(boolPolys(same, 'intersect')) === 10000, 'a shape intersected with itself is itself')
  ok(boolPolys(same, 'subtract').length === 0, 'a shape minus itself is nothing')
  // a stretch of shared edge: tops aligned, B starts half way along A
  const half = S({ x: 50, h: 50 })
  const uh = boolPolys([shapeToPoly(A), shapeToPoly(half)], 'union')
  ok(uh.length === 1 && polyArea(uh) === 10000 + 2500 && exact(uh), `edges that run along each other for part of their length merge exactly (${polyArea(uh)})`)
  ok(polyArea(boolPolys([shapeToPoly(A), shapeToPoly(half)], 'subtract')) === 10000 - 2500, 'and subtract exactly')
  // a T: B's corner sits on A's edge
  const t = S({ x: 50, y: 100, w: 100, h: 100 })
  ok(polyArea(boolPolys([shapeToPoly(A), shapeToPoly(t)], 'union')) === 20000 && boolPolys([shapeToPoly(A), shapeToPoly(t)], 'union').length === 1, 'a corner touching an edge unites into one outline')
  ok(boolPolys([shapeToPoly(A), shapeToPoly(t)], 'intersect').length === 0, '…and intersects to nothing')
}

console.log('\noperands where the result stands\n')
{
  // the result of two operands, then resized / turned; its outline now is the truth to match
  const make = (shapes: any[], op: any) => { const r = computeBool(shapes, op)!; return { ...S({ shape: 'path' }), ...r, pathBox: [0, 0, r.w, r.h], bool: { op, shapes } } as any }
  const now = (el: any) => polyArea(boolPolys(operandsAt(el).map(shapeToPoly), el.bool.op))
  const outline = (el: any) => polyArea(shapeToPoly(el))
  const plain = make([S({}), S({ x: 50, y: 50 })], 'union')
  const moved = { ...plain, x: plain.x + 30, w: plain.w * 2, h: plain.h * 0.5 }
  ok(near(now(moved), outline(moved), 0.005), `a stretched boolean's operands rebuild the stretched outline (${now(moved).toFixed(0)} ≈ ${outline(moved).toFixed(0)})`)
  // an operand turned 30°, then the result stretched 2×1: that operand comes back skewed, as a path
  const tilted = make([S({ w: 200, h: 200 }), S({ x: 60, y: 60, rotation: 30, shape: 'ellipse', w: 120, h: 60 })], 'subtract')
  const wide = { ...tilted, w: tilted.w * 2 }
  const ops = operandsAt(wide)
  ok(ops[1].shape === 'path' && !ops[1].rotation && /C/.test(ops[1].d!), 'a turned operand under a non-uniform stretch comes back as an exact skewed curve, not an un-skewed box')
  ok(near(now(wide), outline(wide), 0.005), `and the released shapes redraw the stretched result (${now(wide).toFixed(0)} ≈ ${outline(wide).toFixed(0)})`)
  ok(ops[0].shape === 'rect' && ops[0].w === 400, 'an unturned operand keeps its kind and simply scales')
  // a quarter-turned operand stays a box: its width takes the vertical scale
  const quarter = make([S({ w: 200, h: 200 }), S({ x: 20, y: 20, w: 100, h: 40, rotation: 90 })], 'subtract')
  const tall = { ...quarter, h: quarter.h * 3 }
  const q = operandsAt(tall)[1]
  ok(q.shape === 'rect' && q.w === 300 && q.h === 40 && q.rotation === 90, `a quarter-turned operand stays a box, the stretch landing on its turned side (${q.w}×${q.h})`)
  // the result turned: operands turn with it
  const turned = { ...plain, rotation: 40, w: plain.w * 1.5 }
  ok(near(now(turned), outline(turned), 0.005), 'a turned and stretched boolean releases into the same outline')
}

console.log('\nwhat the renderer fills, and nothing left\n')
{
  // a pentagram drawn as ONE self-crossing contour: the renderer's nonzero rule fills its centre
  const star = S({ shape: 'path', x: 0, y: 0, w: 100, h: 100, pathBox: [0, 0, 100, 100],
    d: 'M 50 0 L 79.39 90.45 L 2.45 34.55 L 97.55 34.55 L 20.61 90.45 Z' })
  const centre = S({ x: 45, y: 45, w: 10, h: 10 })
  const r = computeBool([star, centre], 'intersect')
  ok(!!r && near(r.w * r.h, 100, 0.05), `a square at a self-crossing star's filled centre intersects to that square (${r ? `${r.w}×${r.h}` : 'nothing'})`)
  // what the renderer fills: nonzero winding of the star as drawn, by grid sampling
  const poly = flattenPath((star as any).d)
  const wind = (q: { x: number; y: number }) => {
    let w = 0
    for (const c of poly) for (let i = 0; i < c.length; i++) {
      const a = c[i], b = c[(i + 1) % c.length]
      const side = (b.x - a.x) * (q.y - a.y) - (q.x - a.x) * (b.y - a.y)
      if (a.y <= q.y && b.y > q.y && side > 0) w++
      else if (a.y > q.y && b.y <= q.y && side < 0) w--
    }
    return w
  }
  let hit = 0
  const N = 300
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (wind({ x: ((i + 0.5) / N) * 100, y: ((j + 0.5) / N) * 100 })) hit++
  const filled = (hit / (N * N)) * 10000
  const u = computeBool([star, centre], 'union')
  ok(!!u && near(polyArea(flattenPath(u.d)), filled, 0.02), `the union is the star as the renderer fills it, centre included (${u ? polyArea(flattenPath(u.d)).toFixed(0) : 'none'} ≈ ${filled.toFixed(0)} px²)`)
}
{
  const a = S({}), b = S({})
  ok(computeBool([a, b], 'subtract') === null, 'a shape minus itself leaves nothing')
  ok(computeBool([a, b], 'exclude') === null, 'a shape excluded with itself leaves nothing')
  const r = computeBool([S({}), S({ x: 50 })], 'union')!
  const pts = r.d.split(/[MLZ]/).map((x) => x.trim()).filter(Boolean)
  ok(pts.every((p, i) => i === 0 || p !== pts[i - 1]), `no point repeats in a row in the emitted path (${r.d})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
