#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Alt-hover measurement geometry rig.
//
//   node scripts/test-slides-measure-geom.ts   (measure-geom.ts is DOM-free)
//
// WHAT THIS PROVES. Separated horizontally → one horizontal gap, edge to edge,
// through the middle of the shared span; vertically → one vertical gap;
// diagonally → both, from the reference's centre, each with a dash along the
// target's edge. Overlapping → no negative gap, but start-to-start and
// end-to-end offsets; containment → the four insets; coinciding edges or
// centres (within 0.5px) → an accent guide and no 0 label; abutting → a guide,
// no gap; zero-size boxes → no duplicate lines; rotation → the axis-aligned
// box; labels round like the inspector.

import { measureBoxes, aabb, fmt, union, type Box } from '../slides/src/editor/measure-geom.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const B = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h })
const vals = (r: ReturnType<typeof measureBoxes>) => r.measures.map((m) => fmt(m.value)).sort().join(' ')
const horiz = (r: ReturnType<typeof measureBoxes>) => r.measures.filter((m) => m.y1 === m.y2)
const vert = (r: ReturnType<typeof measureBoxes>) => r.measures.filter((m) => m.x1 === m.x2)
const kinds = (r: ReturnType<typeof measureBoxes>, k: string) => r.guides.filter((g) => g.kind === k)

// separated horizontally, overlapping vertically
{
  const r = measureBoxes(B(0, 0, 100, 100), B(150, 20, 50, 50))
  ok(horiz(r).length === 1 && fmt(horiz(r)[0].value) === '50', 'H gap: one horizontal 50')
  const m = horiz(r)[0]
  ok(m.x1 === 100 && m.x2 === 150 && m.y1 === 45, 'H gap runs edge to edge through the shared span (y=45)')
  ok(vals(r) === '20 30 50', 'H gap 50, plus top-top 20 and bottom-bottom 30')
  ok(vert(r).every((v) => v.x1 === 150) && kinds(r, 'dash').length === 2, 'offsets sit on the target edge, dashed back to the reference')
  // the target on the other side measures the same
  ok(vals(measureBoxes(B(150, 20, 50, 50), B(0, 0, 100, 100))) === '20 30 50', 'H gap is symmetric in side')
}
// separated vertically
{
  const r = measureBoxes(B(0, 0, 100, 100), B(10, 130, 80, 40))
  ok(vert(r).length === 1 && vert(r)[0].y1 === 100 && vert(r)[0].y2 === 130, 'V gap: 100→130')
  ok(kinds(r, 'align').some((g) => g.x1 === 50 && g.x2 === 50), 'V gap: centred target shows a centre guide')
  ok(vals(r) === '10 10 30', 'V gap 30, plus left/right insets 10 and 10')
}
// diagonal
{
  const r = measureBoxes(B(0, 0, 100, 100), B(160, 140, 40, 40))
  ok(vals(r) === '40 60', 'diagonal: horizontal 60 and vertical 40')
  const h = horiz(r)[0], v = vert(r)[0]
  ok(h.y1 === 50 && h.x1 === 100 && h.x2 === 160, 'diagonal H leaves the reference at its centre y')
  ok(v.x1 === 50 && v.y1 === 100 && v.y2 === 140, 'diagonal V leaves the reference at its centre x')
  ok(kinds(r, 'dash').length === 2, 'diagonal: a dash along each target edge')
  ok(kinds(r, 'align').length === 0, 'diagonal: nothing aligned')
}
// overlapping (partial)
{
  const r = measureBoxes(B(0, 0, 100, 100), B(60, 30, 100, 100))
  ok(r.measures.every((m) => m.value > 0), 'overlap: no negative or zero values')
  ok(vals(r) === '30 30 60 60', 'overlap: left-left 60, right-right 60, top-top 30, bottom-bottom 30')
}
// containment
{
  const r = measureBoxes(B(0, 0, 200, 100), B(20, 10, 100, 60))
  ok(vals(r) === '10 20 30 80', 'containment: insets 20 / 80 / 10 / 30')
  ok(horiz(r).every((m) => m.y1 === 40), 'containment: horizontal insets through the middle of the inner box')
}
// aligned edges
{
  const r = measureBoxes(B(0, 0, 100, 100), B(0, 200, 100, 50))
  ok(vals(r) === '100', 'same left+right: only the vertical gap')
  ok(kinds(r, 'align').length === 3, 'same left, right, centre: three guides')
  const g = kinds(r, 'align')[0]
  ok(g.y1 === 0 && g.y2 === 250, 'guide spans both boxes')
  const sub = measureBoxes(B(0, 0, 100, 100), B(0.3, 200, 100, 50))
  ok(kinds(sub, 'align').length === 3 && vals(sub) === '100', 'within 0.5px still counts as aligned')
}
// abutting
{
  const r = measureBoxes(B(0, 0, 100, 100), B(100, 0, 50, 100))
  ok(r.measures.length === 0, 'abutting + same top/bottom: no numbers')
  ok(kinds(r, 'align').some((g) => g.x1 === 100), 'abutting: a guide at the shared edge')
}
// zero-size boxes
{
  const r = measureBoxes(B(0, 0, 100, 100), B(50, 50, 0, 0))
  ok(vals(r) === '50 50 50 50', 'a point at the centre: four 50 insets')
  ok(kinds(r, 'align').length === 2, 'a point at the centre: both centre guides')
  const same = measureBoxes(B(10, 10, 0, 0), B(10, 10, 0, 0))
  ok(same.measures.length === 0, 'two coincident points: no numbers')
  const keys = same.guides.map((g) => [g.kind, g.x1, g.y1, g.x2, g.y2].join())
  ok(new Set(keys).size === keys.length, 'two coincident points: no duplicate guides')
  const line = measureBoxes(B(0, 0, 100, 0), B(0, 40, 100, 0))
  ok(vals(line) === '40', 'two flat lines stacked: the gap only')
}
// rotation, union, formatting
{
  const a = aabb({ x: 0, y: 0, w: 100, h: 20, rotation: 90 })
  ok(Math.abs(a.x - 40) < 1e-9 && Math.abs(a.y + 40) < 1e-9 && Math.abs(a.w - 20) < 1e-9 && Math.abs(a.h - 100) < 1e-9, 'aabb of a 90° turn swaps w/h about the centre')
  ok(aabb({ x: 1, y: 2, w: 3, h: 4, rotation: 360 }).w === 3, 'a full turn is no turn')
  const u = union([B(0, 0, 10, 10), B(20, 5, 10, 10)])!
  ok(u.x === 0 && u.w === 30 && u.h === 15, 'union of boxes')
  ok(fmt(50) === '50' && fmt(12.34) === '12.3' && fmt(7.96) === '8', 'labels round like the inspector')
}

console.log(`\n${checks - failures}/${checks} passed`)
if (failures) process.exit(1)
