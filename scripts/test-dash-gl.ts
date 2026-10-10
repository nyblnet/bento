#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash WebGL layer — the MATHS rig.
//
//   node scripts/test-dash-gl.ts
//
// WHAT THIS PROVES. Nothing here can be checked by looking at the screen:
// every bug in this file renders SOMETHING, plausibly, and the reader has no
// way to know the picture is a lie. The four that matter:
//
//   1. A TRANSPOSED MULTIPLY. `multiply(a,b)` meaning "b then a" or "a then b"
//      both produce a scene. They differ only when the operands do not
//      commute, and — because the identity matrix is symmetric — the obvious
//      M·I = M check passes either way. Composition order is pinned against a
//      translate/rotate pair whose two orders give different points.
//   2. A FLIPPED SCREEN Y. NDC counts up, CSS counts down. Get it wrong and
//      every label sits mirrored about the horizon, which on a symmetric
//      scatter plot looks entirely correct. Pinned to an exact pixel.
//   3. A POINT BEHIND THE CAMERA. Negative clip w mirrors x and y back INTO
//      the viewport, so a label for something behind you is drawn in front of
//      you at a confident position. The rig asserts the depth flag that lets
//      a caller reject it.
//   4. THE GIMBAL FLIP. At exactly ±90° elevation the view direction is
//      parallel to `up`, the camera basis collapses, and the scene flips or
//      vanishes. Every hand-rolled orbit control ships this once. Asserted
//      both as a strict clamp AND as continuity of the picture across it — a
//      naive `Math.min(el, PI/2)` passes neither.
//
// Plus the arithmetic that everything else rests on: invert(m)·m = I, and a
// known camera projecting a known point to a known pixel.

import {
  identity, multiply, perspective, lookAt, translate, scale,
  rotateX, rotateY, rotateZ, transformPoint, invert, project,
  add, sub, dot, cross, normalize, length, vscale, V3,
  Orbit, supportsWebGL2,
  type Mat4, type Vec3,
} from '../dash/src/gl.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps
const closeV = (a: Vec3, b: Vec3, eps = 1e-9) =>
  close(a[0], b[0], eps) && close(a[1], b[1], eps) && close(a[2], b[2], eps)
const closeM = (a: Mat4, b: Mat4, eps = 1e-9) => {
  for (let i = 0; i < 16; i++) if (!close(a[i], b[i], eps)) return false
  return true
}
const finiteM = (m: Mat4) => {
  for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) return false
  return true
}

// ------------------------------------------------------------------ vectors
{
  const a: Vec3 = [1, 2, 3], b: Vec3 = [4, 5, 6]
  ok(closeV(add(a, b), [5, 7, 9]), 'add')
  ok(closeV(sub(b, a), [3, 3, 3]), 'sub')
  ok(dot(a, b) === 32, 'dot')
  ok(closeV(vscale(a, 2), [2, 4, 6]), 'scale')
  ok(close(length([3, 4, 0]), 5), 'length')
  ok(close(length(normalize([0, 0, 7])), 1), 'normalize gives a unit vector')

  // right-handed: x cross y is +z. The sign error here inverts the whole
  // camera basis and the scene renders mirrored, not broken.
  ok(closeV(cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]), 'cross is right-handed (x×y = +z)')
  ok(closeV(cross([0, 1, 0], [1, 0, 0]), [0, 0, -1]), 'and anti-commutative (y×x = -z)')

  // the silent-NaN case: one degenerate vector otherwise poisons every
  // projected point in the scene and the canvas just goes empty
  ok(closeV(normalize([0, 0, 0]), [0, 0, 0]), 'normalizing the zero vector gives zero, NOT NaN')
  ok(!Number.isNaN(normalize([0, 0, 0])[0]), 'and specifically not NaN')

  ok(V3.scale === vscale && V3.length === length, 'V3 exposes the ops under their plain names')
}

// ----------------------------------------------------------------- matrices
{
  const m = multiply(translate([1, 2, 3]), rotateY(0.7))
  ok(closeM(multiply(m, identity()), m), 'M · I = M')
  ok(closeM(multiply(identity(), m), m), 'I · M = M')
  ok(closeM(invert(identity())!, identity()), 'the identity inverts to itself')
}
{
  // Composition order. `multiply(A, B)` is the maths product A·B, so B is
  // applied FIRST — and the two orders must give different answers or the
  // convention is untested.
  const T = translate([1, 0, 0])
  const R = rotateZ(Math.PI / 2)
  const p: Vec3 = [1, 0, 0]
  const rotThenMove = transformPoint(multiply(T, R), p)
  const moveThenRot = transformPoint(multiply(R, T), p)
  ok(closeV(rotThenMove, [1, 1, 0]), 'multiply(T,R) rotates first, then translates')
  ok(closeV(moveThenRot, [0, 2, 0]), 'multiply(R,T) translates first, then rotates')
  ok(!closeV(rotThenMove, moveThenRot), 'the two orders differ — so the convention is actually pinned')
}
{
  // A sign slip in any one of these renders a scene that looks fine until
  // something is asymmetric.
  ok(closeV(transformPoint(rotateX(Math.PI / 2), [0, 1, 0]), [0, 0, 1]), 'rotateX(90°): +y → +z')
  ok(closeV(transformPoint(rotateY(Math.PI / 2), [0, 0, 1]), [1, 0, 0]), 'rotateY(90°): +z → +x')
  ok(closeV(transformPoint(rotateZ(Math.PI / 2), [1, 0, 0]), [0, 1, 0]), 'rotateZ(90°): +x → +y')
  ok(closeV(transformPoint(translate([1, 2, 3]), [1, 1, 1]), [2, 3, 4]), 'translate')
  ok(closeV(transformPoint(scale([2, 3, 4]), [1, 1, 1]), [2, 3, 4]), 'scale')
  ok(closeV(transformPoint(scale(2), [1, 1, 1]), [2, 2, 2]), 'scale takes a uniform number too')
}
{
  // The gnarliest matrix the app builds: a full view-projection with a model
  // transform on the end. If invert survives this it survives anything.
  const m = multiply(
    multiply(perspective(1.1, 1.7, 0.25, 900), lookAt([3, 4, 5], [1, 0, -2], [0, 1, 0])),
    multiply(translate([7, -2, 0.5]), multiply(rotateX(0.3), scale([2, 0.5, 3]))),
  )
  const inv = invert(m)!
  ok(!!inv, 'a view-projection matrix inverts')
  ok(closeM(multiply(inv, m), identity(), 1e-9), 'invert(m) · m is the identity within 1e-9')
  ok(closeM(multiply(m, inv), identity(), 1e-9), 'and m · invert(m) too')

  // the failure: a collapsed matrix has NO inverse, and answering with the
  // identity would let a hit-test report screen pixels as world coordinates
  ok(invert(scale([1, 0, 1])) === null, 'a singular matrix inverts to null, not to a plausible matrix')
  ok(invert(new Float64Array(16) as Mat4) === null, 'the zero matrix inverts to null')
}

// -------------------------------------------------------------- projection
{
  const near = 0.1, far = 100
  const P = perspective(Math.PI / 2, 1, near, far)
  // GL clip space is [-1, +1] in z. D3D's [0, 1] convention would put the near
  // plane at 0 — everything still draws, and the depth buffer resolution is
  // silently halved.
  ok(close(transformPoint(P, [0, 0, -near])[2], -1, 1e-12), 'the near plane maps to ndc z = -1')
  ok(close(transformPoint(P, [0, 0, -far])[2], 1, 1e-12), 'the far plane maps to ndc z = +1 (GL, not D3D)')
  const wide = perspective(Math.PI / 2, 2, near, far)
  ok(wide[0] < P[0], 'a wider aspect ratio shrinks x in clip space (it fits more world in)')
}
{
  const V = lookAt([0, 0, 5], [0, 0, 0], [0, 1, 0])
  ok(closeV(transformPoint(V, [0, 0, 5]), [0, 0, 0]), 'lookAt puts the eye at the view-space origin')
  ok(transformPoint(V, [0, 0, 0])[2] < 0, 'and the target down -Z, the direction GL looks')

  // the public-API degenerate case: "look straight down" is the first thing
  // anyone tries, and cross(up, forward) is zero there
  const D = lookAt([0, 5, 0], [0, 0, 0], [0, 1, 0])
  ok(finiteM(D), 'looking straight down with up=+Y still yields a finite matrix, not NaN')
  ok(closeV(transformPoint(D, [0, 5, 0]), [0, 0, 0]), 'and it is still a valid view matrix')
}
{
  // A camera we can do the arithmetic for by hand: at z=5, 90° vertical fov,
  // square aspect, so the visible half-width at the origin is exactly 5.
  const vp = multiply(perspective(Math.PI / 2, 1, 0.1, 100), lookAt([0, 0, 5], [0, 0, 0], [0, 1, 0]))
  const W = 100, H = 100

  const c = project(vp, [0, 0, 0], W, H)
  ok(close(c.x, 50, 1e-9) && close(c.y, 50, 1e-9), 'the target projects to the centre of the screen')
  ok(c.z > -1 && c.z < 1, 'and sits inside the depth range')

  const r = project(vp, [1, 0, 0], W, H)
  ok(close(r.x, 60, 1e-9), 'a point 1 unit right of the target lands at x = 60px (1/5 of the half-width)')
  ok(close(r.y, 50, 1e-9), 'and does not move in y')

  const u = project(vp, [0, 1, 0], W, H)
  ok(close(u.y, 40, 1e-9), 'a point 1 unit ABOVE the target lands at y = 40px — screen y counts DOWN')
  ok(!close(u.y, 60, 1e-3), 'and NOT at 60px, which is the unflipped-y bug')

  // behind the camera: the mirrored x/y are the trap, z is the escape
  const behind = project(vp, [1, 0, 10], W, H)
  ok(behind.z > 1, 'a point BEHIND the camera reports z > 1, so `-1<=z<=1` rejects it')
  ok(behind.x < W && behind.x > 0, 'even though its x lands inside the viewport — which is why z must be checked')
  const far = project(vp, [0, 0, -200], W, H)
  ok(far.z > 1, 'a point beyond the far plane is rejected by the same test')

  // project ∘ unproject: the pair the label layer and the picker both need
  const world: Vec3 = [1.5, -0.5, 2]
  const s = project(vp, world, W, H)
  const back = transformPoint(invert(vp)!, [(s.x / W) * 2 - 1, 1 - (s.y / H) * 2, s.z])
  ok(closeV(back, world, 1e-9), 'unprojecting a projected point through invert(vp) returns the world point')
}

// ------------------------------------------------------------------- orbit
const camera = () => {
  const o = new Orbit()
  o.azimuth = 0; o.elevation = 0; o.distance = 5
  o.fovY = Math.PI / 2; o.near = 0.1; o.far = 100
  o.target = [0, 0, 0]
  return o
}
{
  const o = camera()
  ok(closeV(o.eye(), [0, 0, 5]), 'at azimuth 0, elevation 0 the camera sits on +Z')
  const hand = multiply(perspective(Math.PI / 2, 1, 0.1, 100), lookAt([0, 0, 5], [0, 0, 0], [0, 1, 0]))
  ok(closeM(o.matrix(1), hand), 'Orbit.matrix is exactly perspective · lookAt')

  o.azimuth = 0.9; o.elevation = -0.3
  ok(close(length(sub(o.eye(), o.target)), o.distance, 1e-9),
    'the eye stays exactly `distance` from the target at any angle')
  o.target = [10, -4, 2]
  ok(close(length(sub(o.eye(), o.target)), o.distance, 1e-9), 'including around a moved target')
}
{
  // THE CLAMP.
  const o = camera()
  o.rotate(0, 1e6)
  ok(o.elevation < Math.PI / 2, 'elevation stays STRICTLY below +90° after a huge drag')
  ok(o.elevation !== Math.PI / 2, 'and is not exactly 90° — the naive clamp that gimbal-flips')
  ok(Math.PI / 2 - o.elevation < 1e-3, 'but stops JUST short, so the limit is invisible')
  ok(finiteM(o.matrix(1)), 'the view-projection at the top pole is finite')

  o.rotate(0, -1e6)
  ok(o.elevation > -Math.PI / 2, 'the bottom pole clamps too')
  ok(o.elevation + Math.PI / 2 < 1e-3, 'symmetrically')
  ok(finiteM(o.matrix(1)), 'and is finite there as well')
}
{
  // The clamp has to keep the PICTURE continuous, not just the number: a
  // camera that reaches the pole exactly swaps its right-vector for the
  // opposite one, and the scene mirrors in a single frame.
  const o = camera()
  o.elevation = Math.PI / 2 - 0.02
  const before = project(o.matrix(1), [1, 0, 0], 100, 100)
  o.rotate(0, 1e6)                       // slam into the clamp
  const after = project(o.matrix(1), [1, 0, 0], 100, 100)
  ok(Math.abs(after.x - before.x) < 3,
    `the image does not jump at the clamp (moved ${Math.abs(after.x - before.x).toFixed(2)}px)`)
  ok(before.x > 50 && after.x > 50, 'the marker stays on the same side of the screen (no mirror flip)')
}
{
  const o = camera()
  o.azimuth = 0
  o.rotate(1000, 0)
  ok(Math.abs(o.azimuth) <= Math.PI + 1e-12, 'azimuth wraps into [-π, π] rather than growing forever')
  ok(!close(o.azimuth, 0), 'and it did actually rotate')
}
{
  // distance may never reach zero: lookAt of a zero-length forward is NaN,
  // and one NaN in the matrix empties the whole canvas
  const o = camera()
  o.zoom(1e-9)
  ok(o.distance === o.minDistance, 'zooming in past the limit clamps to minDistance')
  ok(o.distance > 0, 'and never reaches 0')
  ok(finiteM(o.matrix(1)), 'so the matrix is still finite at full zoom-in')

  o.distance = 5
  o.zoom(0)
  ok(o.distance === 5, 'a zoom factor of 0 is ignored, not applied')
  o.zoom(-2)
  ok(o.distance === 5, 'and a negative factor is ignored — it would pull the camera through the target')
  o.zoom(1e9)
  ok(o.distance === o.maxDistance, 'zooming out clamps to maxDistance')
  o.distance = 5
  o.zoom(0.5)
  ok(close(o.distance, 2.5), 'an ordinary zoom just scales the distance')
}
{
  // pan must track the pointer: at 90° fov the visible world height at the
  // target equals 2 * distance, so half a viewport of drag moves exactly
  // `distance` units.
  const o = camera()
  o.height = 100
  o.pan(0, 50)
  ok(closeV(o.target, [0, 5, 0], 1e-9), 'dragging down half the viewport moves the target up by distance·tan(fov/2)')

  const o2 = camera()
  o2.height = 100
  o2.distance = 10
  o2.pan(0, 50)
  ok(closeV(o2.target, [0, 10, 0], 1e-9), 'the same drag moves twice as far from twice the distance')

  const o3 = camera()
  o3.height = 100
  o3.pan(50, 0)
  ok(closeV(o3.target, [-5, 0, 0], 1e-9), 'dragging right moves the target left — the model follows the pointer')

  // and from an arbitrary angle, panning stays in the screen plane
  const o4 = camera()
  o4.azimuth = 1.1; o4.elevation = 0.6; o4.height = 100
  const fwd = normalize(sub(o4.target, o4.eye()))
  const t0 = o4.target
  o4.pan(23, -17)
  const moved = sub(o4.target, t0)
  ok(close(dot(moved, fwd), 0, 1e-9), 'a pan never moves the target along the view direction')
  ok(length(moved) > 0, 'but it does move it')
}

// --------------------------------------------------------- the GL boundary
ok(supportsWebGL2() === false,
  'supportsWebGL2() answers false where there is no DOM instead of throwing (node, and the scriptless preview)')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
