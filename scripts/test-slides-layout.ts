#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Auto layout rig: the frame solver (slides/src/layout.ts) and the layer tree.
//
//   node scripts/test-slides-layout.ts
//
// WHAT THIS PROVES. A row, a column and a grid place their children at the
// padding plus the gaps; 'fill' shares the free space; a hugging frame sizes
// to its children; alignment and space-between move children on both axes;
// order along the main axis is the children's position, so a child dragged
// past a sibling swaps with it; nested frames hug inner-first; a clipping
// frame clips only what overflows; a dangling parentId is dropped; a slide
// with no frames is left byte-identical and reports no change; a second run
// changes nothing (the solver is a fixed point, so the editor's doc hook
// cannot loop); and the layer list shows children under their frame.

import { layoutSlide, frameClip, frameChildren } from '../slides/src/layout.ts'
import { layerRows } from '../slides/src/editor/layerrows.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const box = (id: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'shape', shape: 'rect', x, y, w, h, rotation: 0, opacity: 1, fill: '#ccc', stroke: 'none', strokeWidth: 0, radius: 0, ...extra }) as any
const frame = (layout: Record<string, unknown>, x = 100, y = 100, w = 600, h = 200) =>
  box('f', x, y, w, h, { layout: { gap: 10, pad: [20, 20, 20, 20], ...layout } })
const slide = (...elements: any[]) => ({ id: 's', background: '#fff', transition: 'none', notes: '', elements }) as any
const at = (s: any, id: string) => s.elements.find((e: any) => e.id === id)
const xywh = (e: any) => [e.x, e.y, e.w, e.h].join(',')

console.log('\nrow\n')
{
  const s = slide(frame({ dir: 'row' }), box('a', 0, 0, 100, 50, { parentId: 'f' }), box('b', 500, 0, 80, 40, { parentId: 'f' }))
  ok(layoutSlide(s), 'laying out a frame reports a change')
  ok(xywh(at(s, 'a')) === '120,120,100,50' && xywh(at(s, 'b')) === '230,120,80,40', 'children start at the padding, one gap apart, aligned to the top')
  ok(!layoutSlide(s), 'a second run changes nothing (fixed point)')
  at(s, 'b').x = 0 // dragged to the left of a
  layoutSlide(s)
  ok(at(s, 'b').x === 120 && at(s, 'a').x === 210, 'dragging a child past its sibling reorders them')
  ok(frameChildren(s, at(s, 'f')).map((e: any) => e.id).join() === 'b,a', 'frameChildren reads the new order')
}

console.log('\ncolumn, fill, alignment\n')
{
  const s = slide(frame({ dir: 'col', align: 'center' }, 0, 0, 300, 400),
    box('a', 0, 0, 100, 50, { parentId: 'f' }), box('b', 0, 100, 60, 40, { parentId: 'f', sizing: { h: 'fill' } }))
  layoutSlide(s)
  ok(at(s, 'a').y === 20 && at(s, 'b').y === 80, 'a column stacks top to bottom with the gap')
  ok(at(s, 'b').h === 400 - 40 - 50 - 10, "'fill' takes the free height")
  ok(at(s, 'a').x === 100 && at(s, 'b').x === 120, 'cross-axis center centres each child in the padded width')
}
{
  const s = slide(frame({ dir: 'row', justify: 'space-between', align: 'stretch' }, 0, 0, 500, 100),
    box('a', 0, 0, 50, 10, { parentId: 'f' }), box('b', 10, 0, 50, 10, { parentId: 'f' }), box('c', 20, 0, 50, 10, { parentId: 'f' }))
  layoutSlide(s)
  ok(at(s, 'a').x === 20 && at(s, 'c').x === 430 && at(s, 'b').x === 225, 'space-between spreads the children edge to edge')
  ok([at(s, 'a'), at(s, 'b'), at(s, 'c')].every((e: any) => e.h === 60 && e.y === 20), 'stretch fills the cross axis')
}
{
  const s = slide(frame({ dir: 'row', justify: 'end' }, 0, 0, 500, 100), box('a', 0, 0, 100, 10, { parentId: 'f' }))
  layoutSlide(s)
  ok(at(s, 'a').x === 380, "justify 'end' pushes the run to the far padding")
}

console.log('\ngrid\n')
{
  const s = slide(frame({ dir: 'grid', cols: 2 }, 0, 0, 230, 230),
    ...['a', 'b', 'c'].map((id, i) => box(id, i * 10, 0, 50, 50, { parentId: 'f' })))
  layoutSlide(s)
  ok(xywh(at(s, 'a')) === '20,20,50,50' && at(s, 'b').x === 120 && at(s, 'c').y === 120 && at(s, 'c').x === 20, 'a 2-column grid fills row by row in equal cells')
}

console.log('\nhug, nesting, clip\n')
{
  const s = slide(frame({ dir: 'row', hug: true }, 0, 0, 999, 999),
    box('a', 0, 0, 100, 50, { parentId: 'f' }), box('b', 200, 0, 100, 80, { parentId: 'f' }))
  layoutSlide(s)
  ok(at(s, 'f').w === 20 + 100 + 10 + 100 + 20 && at(s, 'f').h === 20 + 80 + 20, 'a hugging frame wraps its children plus padding')
}
{
  const inner = box('g', 0, 0, 10, 10, { parentId: 'f', layout: { dir: 'col', gap: 4, pad: [5, 5, 5, 5], hug: true } })
  const s = slide(frame({ dir: 'row', hug: true }), inner, box('x', 0, 0, 30, 30, { parentId: 'g' }), box('y', 0, 40, 30, 30, { parentId: 'g' }), box('z', 50, 0, 40, 40, { parentId: 'f' }))
  layoutSlide(s)
  ok(at(s, 'g').w === 40 && at(s, 'g').h === 74, 'an inner frame hugs before its parent measures it')
  ok(at(s, 'x').x === at(s, 'g').x + 5 && at(s, 'y').y === at(s, 'g').y + 5 + 30 + 4, "the inner frame's children follow where the outer frame put it")
  ok(at(s, 'f').h === 20 + 74 + 20, 'and the outer frame hugs the inner one')
}
{
  const s = slide(frame({ dir: 'row', clip: true }, 0, 0, 100, 100), box('a', 0, 0, 200, 50, { parentId: 'f' }), box('b', 0, 0, 10, 10))
  layoutSlide(s)
  const byId = new Map(s.elements.map((e: any) => [e.id, e]))
  ok(frameClip(at(s, 'a'), byId as any) === 'inset(0px 120px 0px 0px)', 'a clip frame clips the overflowing side only')
  ok(frameClip(at(s, 'b'), byId as any) === '', 'an element outside any frame is never clipped')
  at(s, 'f').layout.clip = false
  ok(frameClip(at(s, 'a'), byId as any) === '', 'no clip once clipping is off')
}

console.log('\nold files and dangling links\n')
{
  const s = slide(box('a', 1, 2, 3, 4), box('b', 5, 6, 7, 8, { groupId: 'g' }))
  const before = JSON.stringify(s)
  ok(!layoutSlide(s) && JSON.stringify(s) === before, 'a slide with no frames is untouched and reports no change')
}
{
  const s = slide(box('a', 1, 2, 3, 4, { parentId: 'gone', sizing: { w: 'fill' } }))
  ok(layoutSlide(s) && at(s, 'a').parentId === undefined && at(s, 'a').sizing === undefined && at(s, 'a').x === 1, 'a child of a deleted frame becomes an ordinary element where it was')
}

console.log('\nlayer tree\n')
{
  const s = slide(frame({ dir: 'col' }), box('a', 0, 0, 10, 10, { parentId: 'f' }), box('top', 0, 0, 10, 10))
  const rows = layerRows(s)
  ok(rows.map((r) => r.id).join() === 'top,f,a', 'children list under their frame, the rest stays top-first')
  ok(rows[1].frame === 'col' && rows[2].depth === 1, 'the frame row carries its direction, the child its depth')
  ok(layerRows(slide(box('p', 0, 0, 1, 1), box('q', 0, 0, 1, 1))).every((r) => r.depth === undefined), 'no frames: rows are unchanged')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
