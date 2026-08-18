#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash 3D visualisation rig — the GEOMETRY.
//
//   node scripts/test-dash-viz3d.ts
//
// WHAT THIS PROVES. Nothing in 3D can be checked by looking at it. Every bug in
// this file draws SOMETHING, confidently, and the reader has no way to know the
// picture is wrong. The classes that matter:
//
//   1. A FLIPPED WINDING. Reverse the two triangles of a quad and the surface's
//      normals all point DOWN. It still renders; it is just lit from
//      underneath, which on an unfamiliar dataset reads as "the data is like
//      that". Pinned by asserting the normal of a FLAT grid is exactly +Y — the
//      one case where the right answer is known without argument.
//   2. NORMALS THAT ARE NOT UNIT LENGTH. A normal of length 1.4 shades 40%
//      brighter, so the mesh has bright patches where triangles happen to be
//      large. Nothing is malformed, nothing errors, the surface just has
//      features that are not in the data.
//   3. A DEGENERATE INPUT BECOMING NaN. One constant column divides by a zero
//      extent; every position in the scene becomes NaN; GL draws nothing and
//      says nothing. Checked on every scene this rig builds, and specifically
//      on the constant-column case.
//   4. A MISSING VALUE BECOMING A ZERO. In a surface a coerced zero is not a
//      visible gap, it is a CRATER — and craters look like findings. The rows
//      must be dropped, the count must be reported, and the quad must not be
//      emitted.
//   5. A RAMP THAT DOES NOT REACH ITS ENDS, or that mixes in sRGB. Both make a
//      plausible picture; the second puts a band of mud through the middle of
//      every surface, which reads as a ridge.
//   6. A BLANK BOX WITHOUT WebGL2. The fallback must be a picture of the same
//      scene, and an empty scene must be a SENTENCE, never an empty rectangle.

import {
  buildScene, defaultViz3d, fallbackSvg, frameCamera,
  computeNormals, latLonToXyz, shade, shadeWith, dirToView,
  rampColor, mixRgb, hexToRgb, rgbToHex, RAMPS, LIGHT, AMBIENT,
  _internals,
  type Scene, type Mesh, type Viz3dBinding,
} from '../dash/src/viz3d.ts'
import { Orbit, normalize, sub } from '../dash/src/gl.ts'
import type { ColumnData, ColumnType, TableSheet } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

function sheetOf(cols: Record<string, unknown[]>, types: Record<string, ColumnType> = {}): TableSheet {
  const n = Object.values(cols)[0]?.length ?? 0
  const rids: Array<[number, number]> = n ? [[1, n]] : []
  return {
    id: 'sh', name: 'S', kind: 'table', rids,
    columns: Object.keys(cols).map((id) => ({ id, name: id, type: types[id] ?? 'number' })),
    data: Object.fromEntries(Object.entries(cols).map(([k, v]): [string, ColumnData] =>
      [k, { enc: 'raw', v: v as Array<number | string | boolean | null> }])),
    steps: [],
  }
}

/** Every float the GPU would read, checked for NaN/Infinity. */
function sceneFinite(s: Scene): boolean {
  const fin = (a: Float32Array | undefined) => {
    if (!a) return true
    for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false
    return true
  }
  for (const m of s.meshes) {
    if (!fin(m.positions) || !fin(m.colors) || !fin(m.normals) || !fin(m.sizes)) return false
    if (m.indices) for (let i = 0; i < m.indices.length; i++) {
      if (!Number.isFinite(m.indices[i]) || m.indices[i] * 3 >= m.positions.length) return false
    }
  }
  const b = [...s.bounds.min, ...s.bounds.max, ...s.center, s.radius]
  return b.every((v) => Number.isFinite(v)) && s.radius > 0
}

const unitNormals = (m: Mesh, eps = 1e-5): boolean => {
  if (!m.normals) return true
  for (let i = 0; i + 2 < m.normals.length; i += 3) {
    if (Math.abs(Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]) - 1) > eps) return false
  }
  return true
}

const meshOf = (s: Scene, mode: Mesh['mode']) => s.meshes.find((m) => m.mode === mode)!
const triCount = (m: Mesh) => (m.indices ? m.indices.length : m.positions.length / 3) / 3
const vertCount = (m: Mesh) => m.positions.length / 3

// ============================================================= colour & ramps

{
  const stops = RAMPS.viridis.map(hexToRgb)
  const a = rampColor(0, stops)
  const z = rampColor(1, stops)
  ok(close(a[0], stops[0][0]) && close(a[1], stops[0][1]) && close(a[2], stops[0][2]),
    'the ramp at t=0 is EXACTLY the first stop')
  ok(close(z[0], stops[4][0]) && close(z[1], stops[4][1]) && close(z[2], stops[4][2]),
    'the ramp at t=1 is EXACTLY the last stop')
  const mid = rampColor(0.5, stops)
  ok(!close(mid[0], a[0]) || !close(mid[2], a[2]),
    'and the middle is neither end — a ramp that clamps to one colour is refused')
  ok(rampColor(2, stops).every((v, i) => close(v, z[i])) && rampColor(-1, stops).every((v, i) => close(v, a[i])),
    'out-of-range t clamps rather than wrapping or extrapolating')
  ok(rampColor(NaN, stops).every(Number.isFinite), 'a NaN t gives a colour, not NaN channels')

  // the assertion a naive sRGB lerp fails: the midpoint of black and white is
  // sqrt(0.5), not 0.5 — mixing in the display curve is what puts mud in the
  // middle of every hand-rolled ramp
  const grey = mixRgb([0, 0, 0], [1, 1, 1], 0.5)
  ok(close(grey[0], Math.SQRT1_2, 1e-6), 'colours mix in LINEAR light (0.7071), not in sRGB (0.5)')
  ok(!close(grey[0], 0.5, 0.05), 'and the naive sRGB midpoint is refused')

  ok(rgbToHex(hexToRgb('#3B1E54')) === '#3b1e54', 'hex round-trips')
  ok(rgbToHex(hexToRgb('#abc')) === '#aabbcc', 'three-digit hex expands')
  ok(hexToRgb('not a colour').every(Number.isFinite), 'an unparseable colour is grey, not NaN')
}

// ================================================================== lighting

{
  ok(shade(LIGHT) > shade([-LIGHT[0], -LIGHT[1], -LIGHT[2]]),
    'a face turned toward the light is brighter than one turned away')
  const away = shade([-LIGHT[0], -LIGHT[1], -LIGHT[2]])
  ok(away > 0, 'and a face turned away is NOT black — an unlit face reads as a hole in the mesh')
  ok(away <= AMBIENT, 'the away-facing value is at most the ambient term')
  ok(shade([0, 1, 0]) <= 1 && shade(LIGHT) <= 1, 'shading never exceeds 1 (it would clip to white)')
  ok(shade([0, 1, 0]) > shade([0, -1, 0]),
    'the hemisphere fill makes an upward face brighter than a downward one, so an unlit shape still reads')

  // the view-space variant used by the point sprites must agree with the world
  // one when handed matching bases
  const cam = new Orbit()
  cam.azimuth = 0.9
  cam.elevation = 0.3
  const lv = dirToView(cam.view(), LIGHT)
  ok(close(Math.hypot(lv[0], lv[1], lv[2]), 1, 1e-9), 'the light stays unit length through the view rotation')
  const fwdWorld = normalize(sub(cam.target, cam.eye()))
  const fwdView = dirToView(cam.view(), fwdWorld)
  ok(close(fwdView[0], 0, 1e-9) && close(fwdView[1], 0, 1e-9) && close(fwdView[2], -1, 1e-9),
    'a DIRECTION through the view matrix ignores the translation: forward becomes -Z')
  ok(close(
    lv[0] * fwdView[0] + lv[1] * fwdView[1] + lv[2] * fwdView[2],
    LIGHT[0] * fwdWorld[0] + LIGHT[1] * fwdWorld[1] + LIGHT[2] * fwdWorld[2], 1e-9),
    'and the angle between light and view is preserved — the lighting does not swim when the camera moves')
  ok(shadeWith([0, 0, 1], lv) > 0, 'a sprite facing the camera is lit')
}

// ================================================================== normals

{
  // one flat quad, wound the way the surface builder winds it
  const pos = new Float32Array([-1, 0, -1, 1, 0, -1, -1, 0, 1, 1, 0, 1])
  const idx = new Uint32Array([0, 2, 1, 1, 2, 3])
  const n = computeNormals(pos, idx)
  ok([0, 1, 2, 3].every((v) => close(n[v * 3], 0) && close(n[v * 3 + 1], 1) && close(n[v * 3 + 2], 0)),
    'a flat quad wound our way has normals of exactly +Y — the check a flipped winding fails')

  const flipped = computeNormals(pos, new Uint32Array([0, 1, 2, 1, 3, 2]))
  ok(close(flipped[1], -1), 'and reversing the winding really does give -Y, so the check above can fail')

  // an unreferenced vertex has no face to average
  const lone = computeNormals(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 5, 5, 5]), new Uint32Array([0, 2, 1]))
  ok(close(Math.hypot(lone[9], lone[10], lone[11]), 1),
    'a vertex no triangle references gets +Y, not a zero normal that would shade pure black')
}

// ================================================================== 3D scatter

const scatterSheet = sheetOf({
  x: [1, 2, 3, 4, 5],
  y: [10, 20, 30, 40, 50],
  z: [5, 4, 3, 2, 1],
  heat: [0, 25, 50, 75, 100],
  mag: [1, 4, 9, 16, 25],
})

{
  const s = buildScene(scatterSheet, { kind: 'scatter', x: 'x', y: 'y', z: 'z', color: 'heat', size: 'mag' })
  const pts = meshOf(s, 'points')
  ok(!s.empty && vertCount(pts) === 5, 'five clean rows give five points')
  ok(pts.positions.length === 15 && pts.colors.length === 15 && pts.sizes!.length === 5,
    'positions, colours and sizes are all in step')
  ok(sceneFinite(s), 'nothing in the scene is NaN')
  ok(s.dropped === 0 && s.rows === 5, 'nothing was dropped')

  ok(close(pts.positions[0], -1) && close(pts.positions[12], 1),
    'the smallest X sits at -1 and the largest at +1')
  ok(close(pts.positions[2], 1) && close(pts.positions[14], -1),
    'and Z is scaled on its OWN axis — a shared scale would flatten it')

  const stops = RAMPS.viridis.map(hexToRgb)
  ok(close(pts.colors[0], stops[0][0], 1e-6) && close(pts.colors[12], stops[4][0], 1e-6),
    'the colour column maps its extremes to the ramp extremes')
  ok(!close(pts.colors[0], pts.colors[6], 1e-3), 'and the middle rows get different colours')

  // AREA, not radius. mag runs 1,4,9,16,25, so t is 0, 0.125, 0.333, 0.625, 1.
  const r0 = pts.sizes![0], r4 = pts.sizes![4], r2 = pts.sizes![2]
  const areaFrac = (r2 * r2 - r0 * r0) / (r4 * r4 - r0 * r0)
  ok(close(areaFrac, 1 / 3, 1e-5), 'point AREA is linear in the value — the readable encoding')
  ok(!close((r2 - r0) / (r4 - r0), 1 / 3, 1e-3),
    'and the value is NOT mapped straight to the radius, which would exaggerate by the square')

  ok(s.meshes.some((m) => m.mode === 'lines'), 'a bounding frame ships with the points (the depth cue)')
  ok(s.axes.length === 3 && s.axes[0].min === 1 && s.axes[0].max === 5,
    'the axes carry the REAL numbers, since the geometry no longer does')
}

{
  // one row with text where a coordinate belongs
  const s = buildScene(sheetOf({ x: [1, 2, 'n/a', 4, 5], y: [1, 2, 3, 4, 5], z: [1, 2, 3, 4, 5] }),
    { kind: 'scatter', x: 'x', y: 'y', z: 'z' })
  ok(vertCount(meshOf(s, 'points')) === 4, 'a row without a number in every axis is DROPPED, not plotted at 0')
  ok(s.dropped === 1 && s.rows === 5, 'and the drop is counted, so the view can say so')
  ok(sceneFinite(s), 'the surviving geometry is finite')
}

{
  // a categorical colour column
  const s = buildScene(
    sheetOf({ x: [1, 2, 3], y: [1, 2, 3], z: [1, 2, 3], r: ['North', 'South', 'North'] }, { r: 'text' }),
    { kind: 'scatter', x: 'x', y: 'y', z: 'z', color: 'r' },
  )
  const pts = meshOf(s, 'points')
  ok(close(pts.colors[0], pts.colors[6]) && !close(pts.colors[0], pts.colors[3]),
    'a text colour column gives equal categories equal colours and different ones different')
  ok(s.legend?.kind === 'categories' && s.legend.items?.length === 2, 'and the legend lists the categories')
}

{
  // the degenerate case that turns everything into NaN if it is not guarded
  const s = buildScene(sheetOf({ x: [7, 7, 7], y: [1, 2, 3], z: [1, 2, 3] }),
    { kind: 'scatter', x: 'x', y: 'y', z: 'z' })
  const pts = meshOf(s, 'points')
  ok(sceneFinite(s), 'a CONSTANT column does not divide by a zero extent — no NaN anywhere')
  ok(close(pts.positions[0], 0) && close(pts.positions[3], 0) && close(pts.positions[6], 0),
    'its points collapse onto 0 rather than to NaN or to the edge of the box')
}

// ==================================================================== surface

/** 3x3 samples of z over x,y in {0,1,2} — the known-answer grid. */
function gridRows(skip: Array<[number, number]> = []) {
  const x: number[] = [], y: number[] = [], z: number[] = []
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      if (skip.some(([a, b]) => a === i && b === j)) continue
      x.push(i); y.push(j); z.push(i * 3 + j)
    }
  }
  return sheetOf({ x, y, z })
}

{
  const s = buildScene(gridRows(), { kind: 'surface', x: 'x', y: 'y', z: 'z' })
  const m = meshOf(s, 'triangles')
  ok(vertCount(m) === 9, 'a 3x3 grid is 9 vertices — one per SAMPLE, shared between quads')
  ok(triCount(m) === 8, 'and 8 triangles: (3-1) x (3-1) quads, two triangles each')
  ok(m.indices!.length === 24, 'so 24 indices')
  ok(unitNormals(m), 'every surface normal is unit length')
  ok(sceneFinite(s) && s.dropped === 0, 'the scene is finite and nothing was dropped')
  ok(m.cull === false, 'the surface is NOT marked cullable — it must stay visible from below')

  const stops = RAMPS.viridis.map(hexToRgb)
  // z runs 0..8; cell (0,0) is the minimum, (2,2) the maximum
  ok(close(m.colors[0], stops[0][0], 1e-6) && close(m.colors[1], stops[0][1], 1e-6),
    'the lowest sample takes the first ramp stop')
  const last = (9 - 1) * 3
  ok(close(m.colors[last], stops[4][0], 1e-6) && close(m.colors[last + 2], stops[4][2], 1e-6),
    'and the highest takes the last')
  ok(close(m.positions[1], -1) && close(m.positions[last + 1], 1),
    'height spans the full [-1, 1] between the extremes')
}

{
  // a FLAT field: the one case where the right normal is not a matter of taste
  const flat = sheetOf({
    x: [0, 1, 2, 0, 1, 2, 0, 1, 2],
    y: [0, 0, 0, 1, 1, 1, 2, 2, 2],
    z: [5, 5, 5, 5, 5, 5, 5, 5, 5],
  })
  const m = meshOf(buildScene(flat, { kind: 'surface', x: 'x', y: 'y', z: 'z' }), 'triangles')
  let up = true
  for (let i = 0; i + 2 < m.normals!.length; i += 3) {
    if (!close(m.normals![i], 0) || !close(m.normals![i + 1], 1) || !close(m.normals![i + 2], 0)) up = false
  }
  ok(up, 'a flat surface has every normal at exactly +Y — the assertion a flipped winding fails')
}

{
  const s = buildScene(gridRows([[0, 0]]), { kind: 'surface', x: 'x', y: 'y', z: 'z' })
  const m = meshOf(s, 'triangles')
  ok(triCount(m) === 6, 'a MISSING corner sample removes its quad: 6 triangles, not 8')
  ok(s.dropped === 0 && s.rows === 8, 'the rows that were there are all used')
  ok(sceneFinite(s), 'and the hole leaves no NaN behind')
}

{
  // aggregation: two rows land in the same cell
  const dup = sheetOf({
    x: [0, 0, 1, 1, 0, 0, 1, 1, 0],
    y: [0, 0, 0, 0, 1, 1, 1, 1, 0],
    z: [10, 30, 1, 1, 1, 1, 1, 1, 20],
  })
  const sum = buildScene(dup, { kind: 'bars', x: 'x', y: 'y', z: 'z', agg: 'sum' })
  const avg = buildScene(dup, { kind: 'bars', x: 'x', y: 'y', z: 'z', agg: 'avg' })
  const cnt = buildScene(dup, { kind: 'bars', x: 'x', y: 'y', z: 'z', agg: 'count' })
  ok(sum.axes[2].max === 60, 'sum of the three rows in cell (0,0) is 60')
  ok(avg.axes[2].max === 20, 'and their average is 20')
  ok(cnt.axes[2].max === 3, 'and their count is 3')
  ok(sum.axes[2].title === 'sum of z' && cnt.axes[2].title === 'count',
    'the value axis says which aggregate produced it')

  // A surface is a FIELD and bars are a TOTAL, so their defaults are opposite.
  // With sum, a cell holding two samples reports twice the field's value, and a
  // smooth surface renders as a comb of spikes whose period is the BINNING.
  ok(buildScene(dup, { kind: 'bars', x: 'x', y: 'y', z: 'z' }).axes[2].title === 'sum of z',
    'bars default to SUM — a bar is a total')
  const smooth = sheetOf({
    x: [0, 0, 1, 1, 0, 0, 1, 1], y: [0, 0, 0, 0, 1, 1, 1, 1], z: [5, 5, 5, 5, 5, 5, 5, 5],
  })
  const surf = buildScene(smooth, { kind: 'surface', x: 'x', y: 'y', z: 'z' })
  ok(surf.axes[2].title === 'avg of z', 'a surface defaults to AVERAGE — a surface is a field')
  ok(surf.axes[2].min === 5 && surf.axes[2].max === 5,
    'so a constant field two-samples-deep is FLAT at 5, not a doubled 10 that varies with sampling density')
}

{
  const s = buildScene(sheetOf({ x: [1, 1, 1], y: [1, 2, 3], z: [1, 2, 3] }),
    { kind: 'surface', x: 'x', y: 'y', z: 'z' })
  ok(!!s.empty && !s.meshes.length,
    'one distinct value on an axis is a LINE, not a surface — refused with a reason rather than drawn empty')
}

// ======================================================================= bars

{
  const four = sheetOf({
    x: ['A', 'A', 'B', 'B'],
    y: ['P', 'Q', 'P', 'Q'],
    v: [10, 20, 30, 40],
  }, { x: 'text', y: 'text', v: 'number' })
  const s = buildScene(four, { kind: 'bars', x: 'x', y: 'y', z: 'v' })
  const m = meshOf(s, 'triangles')
  ok(vertCount(m) === 96, 'four bars are 96 vertices — 24 per box, so each face keeps its own normal')
  ok(m.indices!.length === 144 && triCount(m) === 48, 'and 36 indices per box: 12 triangles, 6 faces')
  ok(unitNormals(m), 'every bar normal is unit length')

  // a box is flat-shaded, so each normal must be an AXIS — a smoothed corner is
  // the tell that computeNormals was run over geometry that did not want it
  let axisAligned = true
  for (let i = 0; i + 2 < m.normals!.length; i += 3) {
    const c = [m.normals![i], m.normals![i + 1], m.normals![i + 2]].map(Math.abs)
    if (!(close(c[0] + c[1] + c[2], 1) && c.filter((v) => close(v, 1)).length === 1)) axisAligned = false
  }
  ok(axisAligned, 'and every one is axis-aligned: box corners are crisp, not melted')
  ok(m.cull === true, 'bars are closed geometry, so the SVG fallback may cull their back faces')
  ok(sceneFinite(s), 'the bar scene is finite')
}

{
  const s = buildScene(sheetOf({
    x: ['A', 'A', 'B', 'B'], y: ['P', 'Q', 'P', 'Q'], v: [10, -6, 3, 4],
  }, { x: 'text', y: 'text', v: 'number' }), { kind: 'bars', x: 'x', y: 'y', z: 'v' })
  ok(close(s.bounds.max[1], 1) && close(s.bounds.min[1], -0.6, 1e-6),
    'a NEGATIVE bar hangs below the floor, scaled against the largest magnitude')
  ok(!close(s.bounds.min[1], 0, 1e-6),
    'the axis is not clipped at zero, which would hide the negative value entirely')
}

{
  // one category too many on an axis
  const many = sheetOf({
    x: Array.from({ length: 200 }, (_, i) => `c${i}`),
    y: Array.from({ length: 200 }, () => 'P'),
    v: Array.from({ length: 200 }, () => 1),
  }, { x: 'text', y: 'text', v: 'number' })
  const s = buildScene(many, { kind: 'bars', x: 'x', y: 'y', z: 'v' })
  ok(s.axes[0].labels!.length === _internals.AXIS_MAX_BARS,
    `a bar axis caps at ${_internals.AXIS_MAX_BARS} categories rather than emitting 200 unreadable columns`)
  ok(s.dropped === 200 - _internals.AXIS_MAX_BARS,
    'and the rows past the cap are counted as dropped, not folded into an "other" bar whose height is an artefact')
}

// ====================================================================== globe

{
  const a = latLonToXyz(0, 0, 1)
  ok(close(a[0], 0) && close(a[1], 0) && close(a[2], 1), 'lat 0 / lon 0 is +Z, where the camera starts')
  const b = latLonToXyz(90, 0, 1)
  ok(close(b[0], 0) && close(b[1], 1) && close(b[2], 0), 'the north pole is +Y')
  const c = latLonToXyz(0, 90, 1)
  ok(close(c[0], 1) && close(c[1], 0) && close(c[2], 0), 'lon +90 is +X')
  ok(close(latLonToXyz(-45, 123, 2).reduce((s, v) => s + v * v, 0), 4, 1e-9),
    'and every point lands exactly on the sphere of the radius asked for')

  const sm = _internals.sphereMesh(1, 8, 4)
  ok(sm.positions.length === 45 * 3, 'a UV sphere duplicates its seam column: (8+1) x (4+1) vertices')
  ok(sm.indices.length === 144,
    'and skips the degenerate pole triangles: 48 triangles, not 64')
  let unit = true
  for (let i = 0; i + 2 < sm.normals.length; i += 3) {
    if (!close(Math.hypot(sm.normals[i], sm.normals[i + 1], sm.normals[i + 2]), 1, 1e-6)) unit = false
    if (!close(Math.hypot(sm.positions[i], sm.positions[i + 1], sm.positions[i + 2]), 1, 1e-6)) unit = false
  }
  ok(unit, 'sphere normals are exact (they ARE the positions), including at the poles')
}

{
  const g = sheetOf({
    lat: [51.5, -33.9, 35.7, 95, 40.7],
    lon: [-0.1, 151.2, 139.7, 10, -74],
    pop: [9, 5, 37, 1, 8],
  })
  const s = buildScene(g, { kind: 'globe', lat: 'lat', lon: 'lon', color: 'pop' })
  const pts = meshOf(s, 'points')
  ok(vertCount(pts) === 4, 'a latitude of 95 is REFUSED — a mis-bound column must not paint a confident band')
  ok(s.dropped === 1, 'and the refusal is counted')
  let onShell = true
  for (let i = 0; i + 2 < pts.positions.length; i += 3) {
    if (!close(Math.hypot(pts.positions[i], pts.positions[i + 1], pts.positions[i + 2]), 1.012, 1e-5)) onShell = false
  }
  ok(onShell, 'points sit just OFF the surface, so they cannot z-fight with it')
  ok(s.meshes.some((m) => m.mode === 'triangles') && s.meshes.some((m) => m.mode === 'lines'),
    'the globe ships a lit sphere and a graticule — a featureless sphere does not read as rotating')
  ok(sceneFinite(s), 'the globe scene is finite')
}

// ================================================== empty and degenerate input

{
  const cases: Array<[string, Scene]> = [
    ['a sheet with no rows', buildScene(sheetOf({ x: [], y: [], z: [] }), { kind: 'scatter', x: 'x', y: 'y', z: 'z' })],
    ['a scatter missing its Z column', buildScene(scatterSheet, { kind: 'scatter', x: 'x', y: 'y' })],
    ['a scatter bound to a column that is not there', buildScene(scatterSheet, { kind: 'scatter', x: 'x', y: 'y', z: 'nope' })],
    ['a globe with no lat/lon', buildScene(scatterSheet, { kind: 'globe' })],
    ['a surface with no value column', buildScene(scatterSheet, { kind: 'surface', x: 'x', y: 'y' })],
    ['an all-text scatter', buildScene(
      sheetOf({ a: ['p', 'q'], b: ['r', 's'], c: ['t', 'u'] }, { a: 'text', b: 'text', c: 'text' }),
      { kind: 'scatter', x: 'a', y: 'b', z: 'c' })],
  ]
  for (const [what, s] of cases) {
    ok(!!s.empty && s.empty.length > 8 && !s.meshes.length,
      `${what} gives an EMPTY scene carrying a sentence, not a box of NaN`)
    ok(sceneFinite(s), `  ...and ${what} leaves the bounds and radius finite`)
  }
  const cam = frameCamera(cases[0][1])
  const m = cam.matrix(1.5)
  ok([...m].every(Number.isFinite),
    'and an empty scene still frames a finite camera — radius 1, never 0, or lookAt is NaN')
}

// ================================================================= 2D fallback

{
  const s = buildScene(gridRows(), { kind: 'surface', x: 'x', y: 'y', z: 'z' })
  const svg = fallbackSvg(s, 640, 420)
  ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), 'the fallback is a complete SVG document')
  ok(svg.includes('<polygon'), 'and it actually draws the mesh — not a blank rectangle')
  ok(!svg.includes('NaN') && !svg.includes('Infinity'), 'with no NaN or Infinity anywhere in the geometry')
  const polys = svg.match(/<polygon/g)!.length
  ok(polys === 8, 'one polygon per triangle of the 3x3 surface')

  const pts = fallbackSvg(buildScene(scatterSheet,
    { kind: 'scatter', x: 'x', y: 'y', z: 'z', color: 'heat', size: 'mag' }), 400, 300)
  ok((pts.match(/<circle/g) ?? []).length === 5, 'a scatter falls back to one circle per row')
  ok(pts.includes('<line'), 'and keeps the bounding frame, so the projection still reads as 3D')
}

{
  const s = buildScene(sheetOf({ x: [1], y: [1], z: [1] }), { kind: 'scatter', x: 'x', y: 'y' })
  const svg = fallbackSvg(s, 300, 200)
  ok(!svg.includes('<polygon') && !svg.includes('<circle'), 'an empty scene draws no geometry')
  ok(svg.includes('<text') && svg.includes('three numeric columns'),
    'but says WHY in words — a workbook that opens to an empty rectangle is worse than one with no 3D at all')
}

{
  // painter's algorithm: FAR first, or the near triangle is painted over
  const far: Mesh = {
    mode: 'triangles', lit: false,
    positions: new Float32Array([-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0, 0.5, -0.5]),
    colors: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  }
  const near: Mesh = {
    mode: 'triangles', lit: false,
    positions: new Float32Array([-0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0, 0.5, 0.5]),
    colors: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]),
  }
  const scene: Scene = {
    kind: 'scatter', meshes: [near, far],   // deliberately NEAR first in the list
    bounds: { min: [-1, -1, -1], max: [1, 1, 1] }, center: [0, 0, 0], radius: 1.5,
    axes: [], rows: 0, dropped: 0,
  }
  const svg = fallbackSvg(scene, 400, 400, { azimuth: 0, elevation: 0 })
  const fills = [...svg.matchAll(/<polygon[^>]*fill="(#[0-9a-f]{6})"/g)].map((m) => m[1])
  ok(fills.length === 2, 'both triangles are drawn')
  ok(fills[0] === '#0000ff' && fills[1] === '#ff0000',
    'the FAR triangle is emitted first, so the near one paints over it — the reverse order is a wrong picture')
}

{
  // column names are user data and go straight into markup
  const s = buildScene(
    sheetOf({ '<script>x</script>': [1, 2], b: [1, 2], c: [1, 2] }),
    { kind: 'scatter', x: '<script>x</script>', y: 'b', z: 'c' },
  )
  const svg = fallbackSvg(s, 400, 300)
  ok(!svg.includes('<script'), 'a column name cannot inject markup into the fallback SVG')
  ok(svg.includes('&lt;script&gt;'), 'it is escaped, not stripped, so the name is still readable')
}

{
  const s = buildScene(sheetOf({ x: [1, 2, 'x', 4], y: [1, 2, 3, 4], z: [1, 2, 3, 4] }),
    { kind: 'scatter', x: 'x', y: 'y', z: 'z' })
  ok(fallbackSvg(s, 400, 300).includes('1 of 4 rows had no value'),
    'the fallback says how many rows are missing from the picture')
}

// ============================================================ axes and binning

{
  const ax = _internals.categorise(['Jan', 'Feb', 'Mar', 'Jan'], 16, 64)
  ok(ax.labels.join() === 'Jan,Feb,Mar' && !ax.numeric,
    'a text axis keeps FIRST-SEEN order — sorting month names alphabetically makes a surface out of noise')
  ok(ax.slot[3] === 0, 'and a repeat lands in the slot it opened')

  const nums = _internals.categorise([3, 1, 2, 2], 16, 64)
  ok(nums.labels.join() === '1,2,3' && nums.numeric,
    'a numeric axis is ASCENDING — a surface interpolates between neighbours, so order is the shape')
  ok(nums.slot[0] === 2 && nums.slot[1] === 0, 'and rows point at the right slots')

  const wide = _internals.categorise(Array.from({ length: 100 }, (_, i) => i), 4, 64)
  ok(wide.labels.length === 4, 'more distinct values than bins asked for gives equal-width bins')
  ok(wide.slot[0] === 0 && wide.slot[99] === 3,
    'and the top edge belongs to the LAST bin, not to an out-of-range one')

  const blanks = _internals.categorise([1, null, '', 5], 16, 64)
  ok(blanks.slot[1] === -1 && blanks.slot[2] === -1, 'a blank has no slot, so its row is dropped rather than binned at 0')
}

{
  const g = _internals.aggregateGrid(2, 1, [0, 0, 1], [0, 0, 0], [4, 6, null], 'sum')
  ok(g.v[0] === 10 && g.present[0] === 1, 'cells sum')
  ok(g.present[1] === 0, 'a cell whose only row has no value is ABSENT, not zero — a coerced zero is a crater')
  ok(g.used === 2, 'and the rows actually used are counted')
  const mx = _internals.aggregateGrid(1, 1, [0, 0], [0, 0], [4, 9], 'max')
  const mn = _internals.aggregateGrid(1, 1, [0, 0], [0, 0], [4, 9], 'min')
  ok(mx.v[0] === 9 && mn.v[0] === 4, 'min and max pick, they do not accumulate')
}

// ============================================================ default binding

{
  ok(defaultViz3d(scatterSheet)?.kind === 'scatter', 'three numeric columns default to a scatter')
  const geo = sheetOf({ lat: [1], lon: [2], n: [3] })
  ok(defaultViz3d(geo)?.kind === 'globe', 'named lat/lon columns default to a globe')
  const trap = sheetOf({ platform: [1], longevity: [2], n: [3] })
  ok(defaultViz3d(trap)?.kind === 'scatter',
    '"platform" and "longevity" are not coordinates — the word-boundary check refuses them')
  const cats = sheetOf({ a: ['x'], b: ['y'], v: [1] }, { a: 'text', b: 'text', v: 'number' })
  ok(defaultViz3d(cats)?.kind === 'bars', 'two categories and a measure default to 3D bars')
  ok(defaultViz3d(sheetOf({ a: ['x'] }, { a: 'text' })) === null,
    'and a sheet with nothing to plot gets NULL rather than a forced wrong view')
}

// ====================================================== formula columns ride in

{
  const s = sheetOf({ x: [1, 2, 3], y: [1, 2, 3] })
  s.columns.push({ id: 'k', name: 'k', type: 'number', formula: 'x * 10' })
  const computed = new Map<string, unknown[]>([['k', [10, 20, 30]]])
  const b: Viz3dBinding = { kind: 'scatter', x: 'x', y: 'y', z: 'k' }
  ok(!!buildScene(s, b).empty, 'a formula column with nothing computed for it is refused rather than plotted as blank')
  const withIt = buildScene(s, b, computed)
  ok(!withIt.empty && vertCount(meshOf(withIt, 'points')) === 3 && withIt.axes[2].max === 30,
    'and the values the grid just recalculated plot as themselves — chart.ts\'s `computed` contract, unchanged')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
