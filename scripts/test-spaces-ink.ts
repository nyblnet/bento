#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/spaces ink rig.
//
//   node scripts/test-spaces-ink.ts
//
// WHAT THIS PROVES. Ink is almost entirely pure functions over numbers, and
// every one of its failure modes is silent:
//
//   1. THE CODEC ROUND-TRIPS. A stroke written by this build and parsed back by
//      this build must be the same points, and re-emitting must be byte-stable.
//      If it is not, every open-and-save cycle nudges a drawing, and nobody
//      would ever see it happen — they would see a sketch that had drifted
//      after a month.
//
//   2. SIMPLIFICATION PRESERVES SHAPE. RDP that keeps the wrong points is a
//      drawing that quietly turns into a different drawing. The tolerance is
//      an explicit contract, so it is asserted as one: no original point is
//      further than the tolerance from the simplified polyline.
//
//   3. A MALFORMED STROKE DOES NOT THROW. `strokes` arrives in a file somebody
//      mailed you. A parse that throws inside `renderBlock` takes the whole
//      page down, so every hostile and every merely-wrong shape must come back
//      as "nothing to draw" instead.
//
//   4. THE BYTES ARE MEASURED, NOT HOPED FOR. A realistic drawing's cost is
//      printed on every run — the size rig's watermark discipline, one level
//      down, because a document that gets emailed pays for this field forever.

import {
  parsePath, emitPath, simplify, strokesOf, strokeRecord, strokeAt,
  pressureWidth, inkRatio, nextRatio, ratioName,
  INK_EPSILON, INK_DP, INK_WIDTH, INK_WIDTHS, INK_W_MIN, INK_W_MAX,
  INK_MAX_STROKES, INK_MAX_POINTS, INK_COLORS, CANVAS_RATIO,
  type Pt,
} from '../spaces/src/ink.ts'
import { SPEC, TAG_OF } from '../spaces/src/blocks.ts'
import type { Block } from '../spaces/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const blk = (over: Record<string, unknown> = {}): Block =>
  ({ id: 'i1', type: 'ink', ...over }) as Block

// ---- 1. the registry -------------------------------------------------------
console.log('\nthe block type')
const inkSpec = SPEC.get('ink')
ok(inkSpec?.type === 'ink', 'ink is a registered block type')
ok(inkSpec?.text === true, "ink carries text — its html is the drawing's NAME")
ok(inkSpec?.custom === true, 'ink renders through its own case, not tag+host')
ok(inkSpec?.container === undefined,
  'ink is NOT a container — a stroke is not a block, which is the whole shape decision')
ok(TAG_OF['ink'] === 'div', 'ink has a real element to hang the surface on')
ok(inkSpec?.md === undefined,
  'no markdown trigger: there is no three characters that mean "draw me a picture"')

// ---- 2. the codec ----------------------------------------------------------
console.log('\nthe path codec')

const line: Pt[] = [{ x: 10, y: 10 }, { x: 20, y: 12.5 }, { x: 31.25, y: 9 }]
const d1 = emitPath(line)
ok(d1.startsWith('M10 10'), `an absolute moveto opens the path (${d1})`)
ok(d1.includes('l'), 'the rest is relative linetos, so the letter is paid once')
{
  const back = parsePath(d1)
  ok(!!back && back.length === 3, 'three points out for three points in')
  ok(!!back && back.every((p, i) =>
    Math.abs(p.x - line[i].x) <= 0.005 && Math.abs(p.y - line[i].y) <= 0.005),
    'every coordinate survives to the stored precision')
  // THE STABILITY PROPERTY. Re-emitting what was parsed must produce the same
  // string — otherwise a save that touches nothing still rewrites every stroke,
  // and a "no changes" diff is full of them.
  ok(emitPath(back!) === d1, 'parse → emit is byte-identical: a save that changes nothing writes nothing')
}

// Quantisation is a GRID, and the grid is the promise. A coordinate finer than
// INK_DP places is rounded to it and stays rounded.
{
  const fine = emitPath([{ x: 1.23456, y: 9.87654 }, { x: 2.11111, y: 9.99999 }])
  ok(!/\d\.\d{3}/.test(fine), `nothing survives past ${INK_DP} decimals (${fine})`)
  const back = parsePath(fine)!
  ok(back.every((p) => Math.abs(p.x * 100 - Math.round(p.x * 100)) < 1e-6),
    'every parsed coordinate lands exactly on the 0.01 grid')
}

// Zero-length steps cost bytes and say nothing.
ok(emitPath([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }]) === 'M5 5',
  'a stroke that never moved is one moveto, not three')

// Leading zeros are the single most repeated character in the field.
ok(emitPath([{ x: 0.5, y: 0.5 }, { x: 0.8, y: 0.2 }]) === 'M.5 .5l.3 -.3',
  'a leading zero is never written — it is paid once per coordinate, forever')

// A LONG PATH round-trips as exactly as a short one: quantisation error must
// not accumulate along the relative deltas.
{
  const long: Pt[] = []
  for (let i = 0; i < 900; i++) long.push({ x: (i * 0.113) % 100, y: (i * 0.077) % 60 })
  const d = emitPath(long)
  const back = parsePath(d)!
  let worst = 0
  for (let i = 0; i < long.length; i++) {
    worst = Math.max(worst, Math.abs(back[i].x - long[i].x), Math.abs(back[i].y - long[i].y))
  }
  ok(worst <= 0.005 + 1e-9,
    `900 relative steps drift by at most half a grid cell (worst ${worst.toExponential(2)})`)
  ok(emitPath(back) === d, '900 points re-emit byte-identically')
}

// ---- 3. what a hostile or merely wrong file can say -------------------------
console.log('\nmalformed input')

const JUNK: unknown[] = [
  undefined, null, 0, 1, true, false, {}, [], NaN,
  '', ' ', 'Z', 'M', 'M10', 'M10 ', 'M 10 , ', 'l', 'C10 10 20 20 30 30',
  'M10 10Z', 'M10 10A5 5 0 0 1 20 20', 'M10 10L20 20 30', 'Mx y',
  'M10 10l</script>', 'M1e400 1', 'M10 10 l 20 20 <img>', '<svg onload=1>',
  'M--1 2', 'M..1 2', 'M10,10,20,20,,30,30',
]
let threw = 0
for (const j of JUNK) {
  try { parsePath(j) } catch { threw++; console.log(`  FAIL  parsePath threw on ${JSON.stringify(j)}`) }
}
ok(threw === 0, `${JUNK.length} malformed \`d\` values and not one throw`)
ok(parsePath('C10 10 20 20 30 30') === null, 'a curve is not in the grammar — this writer never emits one')
ok(parsePath('M10 10Z') === null, 'a close-path is not in the grammar either')
ok(parsePath('M10 10l</script>') === null, 'a script close tag is not a number')
ok(parsePath('M1e400 1') === null, 'an exponent is not in the grammar, so Infinity cannot get in')
ok(parsePath('M10 10L20 20 30') === null, 'a half-finished coordinate pair is a rejected path, not half a stroke')
ok(parsePath('M10,10,20,20') !== null, 'commas are separators, as SVG says')

// strokesOf is the read-time gate, and its rule is the tableOf rule: clamp and
// ignore, never repair, never throw.
console.log('\nstrokesOf — the read-time gate')
const BAD_BLOCKS: Array<[string, Record<string, unknown>]> = [
  ['no strokes key', {}],
  ['strokes is a string', { strokes: 'M10 10' }],
  ['strokes is a number', { strokes: 7 }],
  ['strokes is an object', { strokes: { 0: { d: 'M10 10L20 20' } } }],
  ['strokes holds nulls', { strokes: [null, undefined, 0, '', []] }],
  ['a stroke with no d', { strokes: [{ c: '#fff' }] }],
  ['a stroke whose d is an object', { strokes: [{ d: { toString: () => 'M0 0' } }] }],
  ['a nested array', { strokes: [[{ d: 'M0 0L1 1' }]] }],
]
let badThrew = 0
for (const [label, over] of BAD_BLOCKS) {
  try {
    const got = strokesOf(blk(over))
    if (got.length !== 0) { failures++; checks++; console.log(`  FAIL  ${label} drew something`) }
    else { checks++; console.log(`  ok    ${label} → nothing to draw`) }
  } catch { badThrew++; console.log(`  FAIL  ${label} THREW`) }
}
ok(badThrew === 0, 'no shape of broken `strokes` throws out of strokesOf')

// PROTOTYPE POLLUTION. `Object.hasOwn`, never `in` and never truthiness — the
// bug that shipped in this app twice. A document is JSON, and JSON.parse gives
// a plain object, but a block also reaches here from code, and `d` is a name
// that exists nowhere on Object.prototype while `constructor` is a name that
// does. The assertion is that an INHERITED key is not read as document data.
{
  const hostile = Object.create({ strokes: [{ d: 'M0 0L50 50' }] }) as Block
  hostile.id = 'i9'
  hostile.type = 'ink'
  ok(strokesOf(hostile).length === 0,
    'a `strokes` inherited from the prototype is NOT the document\'s strokes')
}

// A colour is an allowlist on the raw string, so `url(#…)` and friends cannot
// reach an svg presentation attribute.
console.log('\ncolour and width clamps')
for (const c of ['url(#x)', 'red', 'javascript:1', '#12345', 'rgb(0,0,0)', '', '  #fff  x', 42, null]) {
  const got = strokesOf(blk({ strokes: [{ d: 'M0 0L1 1', c }] }))
  ok(got.length === 1 && got[0].color === null, `c=${JSON.stringify(c)} falls back to the document's ink`)
}
for (const c of ['#fff', '#FFFFFF', '#12345678', '#abcd']) {
  const got = strokesOf(blk({ strokes: [{ d: 'M0 0L1 1', c }] }))
  ok(got.length === 1 && got[0].color === c, `c=${c} is a colour this build will paint`)
}
ok(strokesOf(blk({ strokes: [{ d: 'M0 0L1 1', c: '  #fff  ' }] }))[0].color === '#fff',
  'surrounding whitespace is trimmed, not treated as a different colour')
for (const [w, want] of [[0, INK_W_MIN], [-5, INK_W_MIN], [1e9, INK_W_MAX], [NaN, INK_WIDTH],
  ['2', INK_WIDTH], [null, INK_WIDTH], [0.5, 0.5]] as Array<[unknown, number]>) {
  const got = strokesOf(blk({ strokes: [{ d: 'M0 0L1 1', w }] }))
  ok(got.length === 1 && got[0].width === want, `w=${JSON.stringify(w)} → ${want}`)
}

// The ceilings. Not a validation error — the field round-trips whole; this
// build simply declines to paint all of it.
{
  const many = Array.from({ length: INK_MAX_STROKES + 50 }, () => ({ d: 'M0 0L1 1' }))
  ok(strokesOf(blk({ strokes: many })).length === INK_MAX_STROKES,
    `a file with ${many.length} strokes paints at most ${INK_MAX_STROKES}`)
  const huge = 'M0 0l' + Array.from({ length: INK_MAX_POINTS + 10 }, () => '.1 .1').join(' ')
  ok(parsePath(huge) === null, 'a path past the point ceiling is declined rather than drawn')
}

// ---- 4. simplification preserves shape -------------------------------------
console.log('\nsimplification')

/** The whole contract of RDP, stated as a measurement: no original point ends
 *  up further than the tolerance from the polyline that replaced it. */
function maxDeviation(orig: Pt[], simp: Pt[]): number {
  const seg = (p: Pt, a: Pt, b: Pt): number => {
    const vx = b.x - a.x, vy = b.y - a.y
    const l2 = vx * vx + vy * vy
    let tx = a.x, ty = a.y
    if (l2 > 0) {
      const tt = Math.min(1, Math.max(0, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2))
      tx = a.x + tt * vx; ty = a.y + tt * vy
    }
    return Math.hypot(p.x - tx, p.y - ty)
  }
  let worst = 0
  for (const p of orig) {
    let best = Infinity
    for (let i = 1; i < simp.length; i++) best = Math.min(best, seg(p, simp[i - 1], simp[i]))
    worst = Math.max(worst, best)
  }
  return worst
}

/** A realistic hand stroke: a smooth arc, sampled densely, with the tremor a
 *  real hand and a real digitizer both add. Deterministic — a rig that fails
 *  one run in twenty is a rig nobody trusts. */
function handStroke(seed: number, samples: number, cx: number, cy: number, r: number): Pt[] {
  let s = seed >>> 0
  const rnd = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  const pts: Pt[] = []
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 1.7
    pts.push({
      x: cx + Math.cos(a) * r + (rnd() - 0.5) * 0.08,
      y: cy + Math.sin(a) * r + (rnd() - 0.5) * 0.08,
    })
  }
  return pts
}

{
  const raw = handStroke(7, 900, 50, 30, 22)
  const simp = simplify(raw, INK_EPSILON)
  const dev = maxDeviation(raw, simp)
  ok(dev <= INK_EPSILON + 0.001,
    `no point drifts past the tolerance (worst ${dev.toFixed(4)} ≤ ${INK_EPSILON})`)
  ok(simp.length < raw.length / 5,
    `${raw.length} samples → ${simp.length} points (${(100 - simp.length / raw.length * 100).toFixed(1)}% removed)`)
  ok(simp[0].x === raw[0].x && simp[simp.length - 1].x === raw[raw.length - 1].x,
    'the endpoints are never moved — a stroke must start and end where the pen did')
}

// A straight line collapses to its two ends and nothing else.
{
  const straight: Pt[] = Array.from({ length: 400 }, (_, i) => ({ x: i * 0.2, y: 10 }))
  ok(simplify(straight, INK_EPSILON).length === 2, '400 collinear samples are two points')
}
// A sharp corner is never rounded off, however many samples surround it.
{
  const corner: Pt[] = []
  for (let i = 0; i <= 200; i++) corner.push({ x: i * 0.1, y: 0 })
  for (let i = 1; i <= 200; i++) corner.push({ x: 20, y: i * 0.1 })
  const simp = simplify(corner, INK_EPSILON)
  ok(simp.some((p) => Math.abs(p.x - 20) < 0.01 && Math.abs(p.y) < 0.01),
    'the corner point itself is kept — RDP keeps the extremes, not a sample near them')
}
// Degenerate inputs.
ok(simplify([], INK_EPSILON).length === 0, 'an empty stroke simplifies to an empty stroke')
ok(simplify([{ x: 1, y: 1 }], INK_EPSILON).length === 1, 'one point stays one point')
ok(simplify([{ x: 1, y: 1 }, { x: 2, y: 2 }], INK_EPSILON).length === 2, 'two points stay two')

// A stroke that RDP reduced to nothing visible must not become a record.
ok(strokeRecord([{ x: 5, y: 5 }, { x: 5, y: 5 }], null, INK_WIDTH)?.d === 'M5 5',
  'a dot is still a stroke — a full stop is a mark someone made')

// DEFAULTS ARE ABSENT KEYS.
{
  const rec = strokeRecord(handStroke(3, 60, 20, 20, 8), null, INK_WIDTH)!
  ok(!Object.hasOwn(rec, 'c'), 'the default pen writes no `c`')
  ok(!Object.hasOwn(rec, 'w'), 'the default nib writes no `w`')
  const rec2 = strokeRecord(handStroke(3, 60, 20, 20, 8), '#E5484D', INK_WIDTHS[2])!
  ok(rec2.c === '#E5484D' && rec2.w === INK_WIDTHS[2], 'a non-default pen writes both')
  ok(strokeRecord(handStroke(3, 60, 20, 20, 8), 'red', INK_WIDTH)!.c === undefined,
    'a colour this build would not paint is never WRITTEN either')
}

// ---- 5. pressure -----------------------------------------------------------
console.log('\npressure and pointer type')
ok(pressureWidth(1, 'mouse', [0.5, 0.5]) === 1,
  'a mouse reports 0.5 for "button down" — it must not read as medium pressure')
ok(pressureWidth(1, 'touch', [0.5]) === 1, 'a finger draws the nominal width')
ok(pressureWidth(1, 'pen', []) === 1, 'a stylus that reports nothing draws the nominal width')
ok(pressureWidth(1, 'pen', [0, 0, 0]) === 1, 'all-zero pressure is no signal, not a zero-width stroke')
{
  const light = pressureWidth(1, 'pen', [0.15, 0.2, 0.18])
  const firm = pressureWidth(1, 'pen', [0.9, 0.95, 1])
  ok(light < 1 && firm > 1 && firm > light * 1.5,
    `a firm stylus stroke is visibly fatter than a light one (${light.toFixed(2)} vs ${firm.toFixed(2)})`)
  ok(light > 0.4, 'a light stroke thins but never disappears')
  ok(pressureWidth(1, 'pen', [5, 9]) <= 1.35, 'a digitizer reporting nonsense above 1 is clamped')
}

// ---- 6. the eraser ---------------------------------------------------------
console.log('\nthe eraser')
{
  const b = blk({ strokes: [
    { d: 'M10 10L30 10' },
    { d: 'M10 40L30 40' },
  ] })
  const all = strokesOf(b)
  ok(strokeAt(all, { x: 20, y: 10 }, 1) === 0, 'a point on the first stroke hits the first stroke')
  ok(strokeAt(all, { x: 20, y: 40 }, 1) === 1, 'a point on the second hits the second')
  ok(strokeAt(all, { x: 20, y: 25 }, 1) === -1, 'a point between them hits nothing')
  ok(strokeAt([], { x: 0, y: 0 }, 1) === -1, 'an empty drawing has nothing to erase')
  // TOP DOWN: the stroke a reader sees under the eraser is the last one painted.
  const over = strokesOf(blk({ strokes: [{ d: 'M10 10L30 10' }, { d: 'M10 10L30 10' }] }))
  ok(strokeAt(over, { x: 20, y: 10 }, 1) === 1, 'two strokes in the same place: the top one goes first')
}

// ---- 7. the surface's shape ------------------------------------------------
console.log('\nthe surface')
ok(inkRatio(blk()) === CANVAS_RATIO, 'no ratio is the default shape')
for (const r of [undefined, null, 'wide', NaN, Infinity, {}, 0, -3]) {
  const got = inkRatio(blk({ ratio: r }))
  ok(Number.isFinite(got) && got > 0, `ratio=${JSON.stringify(r)} → a shape, never an error (${got})`)
}
{
  let at = CANVAS_RATIO
  for (let i = 0; i < 3; i++) at = nextRatio(at)
  ok(at === CANVAS_RATIO, 'three steps round the shape cycle comes back to where it started')
  ok(ratioName(1.55) === 'Wide', 'a hand-written 1.55 still has a name')
}

// ---- 8. THE BYTES ----------------------------------------------------------
//
// A REALISTIC DRAWING, measured. This is the number the PR reports and the one
// a future change has to beat: a document that gets emailed pays for this field
// on every open, on every phone, forever.
console.log('\nbytes — a realistic drawing')
{
  // A flowchart-ish sketch: 34 strokes — boxes, arrows and scribbled labels —
  // each sampled the way a 120Hz pen samples.
  const strokes: Array<{ d: string; c?: string; w?: number }> = []
  let rawSamples = 0
  let keptPoints = 0
  for (let s = 0; s < 34; s++) {
    const samples = 60 + (s * 37) % 400
    const pts = handStroke(s + 1, samples, 12 + (s * 13) % 76, 8 + (s * 7) % 45, 3 + (s % 9))
    rawSamples += pts.length
    const rec = strokeRecord(pts, s % 4 === 0 ? '#E5484D' : null, INK_WIDTH)
    if (rec) { strokes.push(rec); keptPoints += parsePath(rec.d)!.length }
  }
  const json = JSON.stringify({ id: 'i1', type: 'ink', html: 'How it works', strokes })
  const bytes = new TextEncoder().encode(json).length
  const rawBytes = new TextEncoder().encode(JSON.stringify(
    Array.from({ length: rawSamples }, () => [12.345678, 45.678901]))).length
  console.log(`        ${strokes.length} strokes · ${rawSamples} raw samples → ${keptPoints} stored points`)
  console.log(`        stored block: ${bytes} B (${(bytes / 1024).toFixed(1)} KiB), ` +
    `${(bytes / keptPoints).toFixed(1)} B/point`)
  console.log(`        raw samples as JSON pairs would be ${(rawBytes / 1024).toFixed(1)} KiB ` +
    `— ${(rawBytes / bytes).toFixed(0)}× this`)
  // A CEILING, so the next change to the codec cannot quietly cost 3×. It is
  // deliberately loose: the assertion is "this is small", not "this is 8412".
  ok(bytes < 12 * 1024, `a 34-stroke drawing is under 12 KiB (${bytes} B)`)
  ok(bytes / keptPoints < 12, `a stored point costs under 12 B (${(bytes / keptPoints).toFixed(1)} B)`)
  // And it must survive the round trip it will take through every save.
  const reread = strokesOf(JSON.parse(json) as Block)
  ok(reread.length === strokes.length, 'every stroke reads back out of the serialized block')
  ok(reread.every((s, i) => emitPath(s.pts) === strokes[i].d),
    'and every one re-emits byte-identically — a save rewrites nothing')
}

// ---- 9. the palette --------------------------------------------------------
ok(INK_COLORS[0] === null, "the first pen is the document's own ink, so a drawing is legible in both themes")
ok(INK_COLORS.slice(1).every((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)),
  'every other pen is a plain hex colour this build will paint')
ok(INK_WIDTHS.includes(INK_WIDTH), 'the default nib is one of the ones the toolbar offers')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
