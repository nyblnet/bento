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

import { layoutSlide, frameClip, frameChildren, moveInFrame, reflowByArray, moveIntoFrame, moveOutBeside, canAccept, flagged } from '../slides/src/layout.ts'
import { syncComponents } from '../slides/src/components.ts'
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

console.log('\nwrap and rotated clip\n')
{
  // inner width 600-40 = 560: 200+10+200 fits, the third 200 wraps
  const s = slide(frame({ dir: 'row', wrap: true }),
    box('a', 0, 0, 200, 50, { parentId: 'f' }), box('b', 10, 0, 200, 80, { parentId: 'f' }), box('c', 20, 0, 200, 30, { parentId: 'f' }))
  layoutSlide(s)
  ok(xywh(at(s, 'a')) === '120,120,200,50' && xywh(at(s, 'b')) === '330,120,200,80', 'a wrapping row fills the first line')
  ok(xywh(at(s, 'c')) === '120,210,200,30', 'the child that would pass the edge starts the next line, below the tallest of the first plus the gap')
  ok(!layoutSlide(s), 'wrapping is a fixed point too')
  at(s, 'c').x = 300; at(s, 'c').y = 130 // dragged up onto the first line, between a and b
  layoutSlide(s)
  ok(frameChildren(s, at(s, 'f')).map((e: any) => e.id).join() === 'a,c,b' && at(s, 'b').y === 180, 'a child dragged onto another line joins it there, and the overflow wraps')
}
{
  const s = slide(frame({ dir: 'row', wrap: true, hug: true }),
    box('a', 0, 0, 300, 50, { parentId: 'f' }), box('b', 10, 0, 300, 40, { parentId: 'f' }))
  layoutSlide(s)
  ok(at(s, 'f').w === 600 && at(s, 'f').h === 20 + 50 + 10 + 40 + 20, 'a hugging wrapping frame keeps its width and hugs its lines')
}
{
  // inner 560: a(200) + fill b(min 150) fit on line 1, c(200) + fill d(min 0) on line 2
  const s = slide(frame({ dir: 'row', wrap: true }),
    box('a', 0, 0, 200, 50, { parentId: 'f' }), box('b', 10, 0, 40, 50, { parentId: 'f', sizing: { w: 'fill', minW: 150 } }),
    box('c', 20, 60, 200, 50, { parentId: 'f' }), box('d', 30, 60, 10, 50, { parentId: 'f', sizing: { w: 'fill' } }))
  layoutSlide(s)
  ok(at(s, 'b').w === 560 - 200 - 10 && at(s, 'b').y === at(s, 'a').y, 'a fill child takes its own line\'s free space')
  // a fill with no minimum counts as 0, so it joins the first line too and shares it
  ok(at(s, 'c').y > at(s, 'a').y && at(s, 'd').y === at(s, 'c').y && at(s, 'd').w === 560 - 200 - 10, 'line breaking counts a fill child as its minimum (0 when unset), and line 2 shares its own free space')
  ok(!layoutSlide(s), 'per-line fill is a fixed point: the filled size never decides the line')
  at(s, 'f').w = 900; layoutSlide(s)
  ok(at(s, 'b').w < 900, 'widening the frame re-shares the space instead of keeping the grown size')
}
{
  const f = box('f', 0, 0, 100, 100, { layout: { dir: 'row', gap: 0, pad: [0, 0, 0, 0], clip: true } })
  const c = box('c', 50, 0, 100, 100, { parentId: 'f', rotation: 90 })
  const byId = new Map([[f.id, f], [c.id, c]])
  const clip = frameClip(c, byId as any)
  // turned 90° about its centre (100,50), the child's own box sees the frame as local y 50..150: its upper half overlaps
  ok(clip === 'polygon(0px 150px, 0px 50px, 100px 50px, 100px 150px)', `a rotated child is clipped by the frame mapped into its own turned box (${clip})`)
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

console.log('\nreachable bad input still settles\n')
{
  // a frame whose parentId is itself, and two frames that name each other
  const self = slide(box('f', 100, 100, 300, 200, { parentId: 'f', layout: { dir: 'row', gap: 10, pad: [20, 20, 20, 20] } }))
  layoutSlide(self)
  ok(at(self, 'f').parentId === undefined && at(self, 'f').x === 100 && !layoutSlide(self), 'a frame that is its own parent loses the link and stays put')
  const cyc = slide(
    box('A', 100, 100, 300, 200, { parentId: 'B', layout: { dir: 'row', gap: 10, pad: [25, 25, 25, 25] } }),
    box('B', 100, 100, 300, 200, { parentId: 'A', layout: { dir: 'row', gap: 10, pad: [25, 25, 25, 25] } }))
  layoutSlide(cyc)
  const after1 = JSON.stringify(cyc)
  ok(!layoutSlide(cyc) && JSON.stringify(cyc) === after1, 'a parentId cycle is broken once and the slide settles')
  ok([at(cyc, 'A'), at(cyc, 'B')].filter((e: any) => e.parentId).length === 1, 'one link of the cycle survives (the first element in paint order loses its link)')
}
{
  // space-between in a frame its children overflow: no negative step, no flip-flop
  const s = slide(box('f', 0, 0, 100, 50, { layout: { dir: 'col', gap: 0, pad: [0, 0, 0, 0], justify: 'space-between' } }),
    box('a', 0, 0, 40, 300, { parentId: 'f' }), box('b', 0, 300, 40, 80, { parentId: 'f' }))
  layoutSlide(s)
  ok(at(s, 'a').y === 0 && at(s, 'b').y === 300 && !layoutSlide(s), 'overflowing space-between falls back to a plain run and settles')
}
{
  // cols from a token (or a hand-written file) can be 0, fractional or huge; geometry never goes NaN
  for (const cols of [0, -3, 2.6, 1e9, NaN, Infinity]) {
    const s = slide(box('f', 0, 0, 300, 300, { layout: { dir: 'grid', gap: 10, pad: [0, 0, 0, 0], cols, hug: true } }),
      box('a', 0, 0, 50, 50, { parentId: 'f' }), box('b', 60, 0, 50, 50, { parentId: 'f' }))
    layoutSlide(s)
    const all = s.elements.flatMap((e: any) => [e.x, e.y, e.w, e.h])
    ok(all.every(Number.isFinite) && !layoutSlide(s), `cols ${cols}: every box stays finite and the layout settles`)
  }
}
{
  // a non-finite input never reaches the model
  const s = slide(frame({ dir: 'row', gap: NaN }), box('a', 0, 0, 100, 50, { parentId: 'f' }))
  layoutSlide(s)
  ok([at(s, 'a').x, at(s, 'a').y].every(Number.isFinite) && !layoutSlide(s), 'a NaN gap writes no NaN and settles')
}
{
  // an inner hugging frame that FILLS its outer frame's width: the outer frame owns that axis
  const s = slide(box('o', 0, 0, 600, 200, { layout: { dir: 'row', gap: 0, pad: [0, 0, 0, 0] } }),
    box('i', 0, 0, 100, 100, { parentId: 'o', sizing: { w: 'fill' }, layout: { dir: 'row', gap: 0, pad: [0, 0, 0, 0], hug: true } }),
    box('c', 0, 0, 50, 50, { parentId: 'i' }))
  layoutSlide(s)
  ok(at(s, 'i').w === 600 && at(s, 'i').h === 50 && !layoutSlide(s), 'a hugging frame that fills its parent takes the fill width, hugs the other axis, and settles')
}
{
  // fuzz: random nested frames settle after one pass
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]
  let unsettled = 0
  for (let n = 0; n < 2000; n++) {
    const els: any[] = []
    const count = 2 + Math.floor(rnd() * 8)
    for (let i = 0; i < count; i++) {
      const isF = rnd() < 0.4
      els.push(box(`e${i}`, rnd() * 800, rnd() * 600, 1 + rnd() * 300, 1 + rnd() * 300, {
        ...(isF ? { layout: { dir: pick(['row', 'col', 'grid']), gap: Math.floor(rnd() * 30), pad: [0, 1, 2, 3].map(() => Math.floor(rnd() * 20)), justify: pick(['start', 'center', 'end', 'space-between']), align: pick(['start', 'center', 'end', 'stretch']), hug: rnd() < 0.3, wrap: rnd() < 0.2, cols: pick([1, 2, 3, 5]) } } : {}),
        ...(rnd() < 0.6 ? { parentId: `e${Math.floor(rnd() * count)}` } : {}),
        ...(rnd() < 0.3 ? { sizing: { w: pick(['fixed', 'fill']), h: pick(['fixed', 'fill']) } } : {}),
      }))
    }
    const s = slide(...els)
    layoutSlide(s)
    const once = JSON.stringify(s)
    if (layoutSlide(s) || JSON.stringify(s) !== once) unsettled++
  }
  ok(unsettled === 0, `2000 random nested layouts: one pass is a fixed point (${unsettled} unsettled)`)
}

console.log('\nlayer tree\n')
{
  const s = slide(frame({ dir: 'col' }), box('a', 0, 0, 10, 10, { parentId: 'f' }), box('top', 0, 0, 10, 10))
  const rows = layerRows(s)
  ok(rows.map((r) => r.id).join() === 'top,f,a', 'children list under their frame, the rest stays top-first')
  ok(rows[1].frame === 'col' && rows[2].depth === 1, 'the frame row carries its direction, the child its depth')
  ok(layerRows(slide(box('p', 0, 0, 1, 1), box('q', 0, 0, 1, 1))).every((r) => r.depth === undefined), 'no frames: rows are unchanged')
}

console.log('\nreorder inside a frame (drop slot, arrow key, Layers)\n')
{
  const kids = (s: any) => frameChildren(s, at(s, 'f')).map((e: any) => e.id).join('')
  const row = () => slide(frame({ dir: 'row', gap: 10, pad: [0, 0, 0, 0] }), box('a', 0, 0, 50, 40, { parentId: 'f' }), box('b', 0, 0, 60, 40, { parentId: 'f' }), box('c', 0, 0, 70, 40, { parentId: 'f' }))
  let s = row(); layoutSlide(s)
  ok(kids(s) === 'abc', 'a row starts a b c')
  ok(moveInFrame(s, 'a', 2) && kids(s) === 'bca', `a to the last slot: b c a (${kids(s)})`)
  ok(at(s, 'b').x === 100 && at(s, 'c').x === 170 && at(s, 'a').x === 250, 'and the boxes are laid out in that order, gap kept')
  ok(!moveInFrame(s, 'a', 2), 'moving to the slot it holds changes nothing')
  ok(moveInFrame(s, 'a', -5) && kids(s) === 'abc', 'a slot past the start is the first slot')
  const before = JSON.stringify(s); layoutSlide(s)
  ok(JSON.stringify(s) === before, 'the result is a fixed point: a second layout pass changes nothing')
  const col = slide(frame({ dir: 'col', gap: 5, pad: [0, 0, 0, 0] }, 0, 0, 100, 400), box('a', 0, 0, 50, 40, { parentId: 'f' }), box('b', 0, 0, 50, 40, { parentId: 'f' }))
  layoutSlide(col)
  ok(moveInFrame(col, 'b', 0) && kids(col) === 'ba' && at(col, 'b').y === 0 && at(col, 'a').y === 45, 'a column reorders top to bottom')
  const grid = slide(frame({ dir: 'grid', cols: 2, gap: 0, pad: [0, 0, 0, 0] }, 0, 0, 200, 200), ...['a', 'b', 'c', 'd'].map((id) => box(id, 0, 0, 100, 100, { parentId: 'f' })))
  reflowByArray(grid, 'f')
  ok(kids(grid) === 'abcd', 'a grid reflowed by array order reads a b c d')
  ok(moveInFrame(grid, 'd', 0) && kids(grid) === 'dabc' && at(grid, 'd').x === 0 && at(grid, 'd').y === 0, 'a grid child moves to the first cell')
  const s2 = row(); layoutSlide(s2)
  // Layers: the array order is the new flow order
  s2.elements = [s2.elements[0], at(s2, 'c'), at(s2, 'a'), at(s2, 'b')]
  reflowByArray(s2, 'f')
  ok(kids(s2) === 'cab', `a Layers reorder reflows the frame by array order (${kids(s2)})`)
  ok(!moveInFrame(slide(box('x', 0, 0, 1, 1)), 'x', 1), 'an element outside a frame does not move')
}

console.log('\ndrop into a frame, take out (Layers drag, canvas drag)\n')
{
  const kids = (s: any) => frameChildren(s, at(s, 'f')).map((e: any) => e.id).join('')
  const ids = (s: any) => s.elements.map((e: any) => e.id).join('')
  const mk = () => { const s = slide(box('x', 900, 400, 30, 30), frame({ dir: 'row', gap: 10, pad: [0, 0, 0, 0] }, 0, 0, 600, 100), box('a', 0, 0, 50, 40, { parentId: 'f' }), box('b', 0, 0, 60, 40, { parentId: 'f' }), box('y', 700, 400, 30, 30)); layoutSlide(s); return s }
  let s = mk()
  ok(moveIntoFrame(s, ['x'], 'f', 2) && at(s, 'x').parentId === 'f' && kids(s) === 'abx', `x dropped at the end of the row: a b x (${kids(s)})`)
  ok(ids(s).indexOf('f') < ids(s).indexOf('x'), `it paints above its frame (${ids(s)})`)
  ok(at(s, 'x').x === 130 && at(s, 'x').y === 0, `the layout places it in the flow (${at(s, 'x').x},${at(s, 'x').y})`)
  s = mk()
  ok(moveIntoFrame(s, ['y', 'x'], 'f', 1) && kids(s) === 'axyb', `two dropped at slot 1 keep their paint order: a x y b (${kids(s)})`)
  s = mk()
  const inner = box('g', 0, 0, 100, 50, { parentId: 'f', layout: { dir: 'row', gap: 0, pad: [0, 0, 0, 0] } })
  s.elements.push(inner); layoutSlide(s)
  ok(!moveIntoFrame(s, ['f'], 'g', 0) && !canAccept(s, ['f'], 'g'), 'a frame never goes inside its own child (no cycle)')
  ok(!canAccept(s, ['f'], 'f'), 'nor inside itself')
  s = mk(); at(s, 'f').locked = true
  ok(!moveIntoFrame(s, ['x'], 'f', 0), 'a locked frame takes nothing')
  s = mk()
  ok(!moveIntoFrame(s, ['x'], 'y', 0), 'a plain rectangle (no layout) takes nothing')
  s = mk()
  const ax = at(s, 'a').x
  ok(moveOutBeside(s, ['a'], 'y', true) && at(s, 'a').parentId === undefined && at(s, 'a').x === ax, 'taken out, a keeps its place on the slide')
  ok(ids(s).indexOf('a') === ids(s).indexOf('y') + 1 && kids(s) === 'b', `…lands just above y in paint order, and the frame keeps b (${ids(s)})`)
}

console.log('\na locked or hidden frame holds its contents\n')
{
  const s = slide(frame({ dir: 'row' }), box('a', 0, 0, 50, 50, { parentId: 'f' }), frame({ dir: 'col' }, 0, 0, 100, 100), box('c', 0, 0, 10, 10))
  s.elements[2].id = 'g'; s.elements[2].parentId = 'f'; s.elements[3].parentId = 'g'
  s.elements[0].locked = true
  const L = flagged(s, 'locked')
  ok(L.has('f') && L.has('a') && L.has('g') && L.has('c'), 'a locked frame locks its children and theirs')
  ok(!s.elements[1].locked && !s.elements[3].locked, '…in effect only: their own flags are untouched, so unlocking gives them back as they were')
  s.elements[0].locked = undefined; s.elements[2].hidden = true
  const H = flagged(s, 'hidden')
  ok(H.has('g') && H.has('c') && !H.has('f') && !H.has('a') && flagged(s, 'locked').size === 0, 'a hidden inner frame hides its own contents, nothing above it')
  const rows = layerRows(s)
  ok(rows.find((r) => r.id === 'c')!.heldHidden && !rows.find((r) => r.id === 'g')!.heldHidden, 'Layers marks the child as hidden by its frame, the frame as hidden by itself')
  const loop = slide(box('x', 0, 0, 10, 10, { parentId: 'y', locked: true }), box('y', 0, 0, 10, 10, { parentId: 'x' }))
  ok(flagged(loop, 'locked').size === 2, 'a parentId cycle in a hand-written file terminates')
}

console.log('\nlock and visibility are a layer\'s own, not a component\'s\n')
{
  const comp = { id: 'k1' }
  const doc: any = { slides: [
    slide(box('m', 0, 0, 50, 50, { component: { ...comp, main: true } })),
    { ...slide(box('c1', 100, 0, 50, 50, { component: { ...comp } })), id: 's2' },
  ], theme: {} }
  syncComponents(doc)
  doc.slides[0].elements[0].locked = true; doc.slides[0].elements[0].hidden = true
  syncComponents(doc)
  const copy = doc.slides[1].elements[0]
  ok(!copy.locked && !copy.hidden, `locking and hiding the main leaves its copies alone (copy L${+!!copy.locked}H${+!!copy.hidden})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
