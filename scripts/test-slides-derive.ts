#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The derive pass (slides/src/derive.ts): palette, tokens, components, layout,
// connectors and stack fallbacks as ONE pass in dependency order.
//
//   esbuild scripts/test-slides-derive.ts --bundle --platform=node --format=esm --outfile=… && node …
//
// WHAT THIS PROVES. One pass settles everything a change can reach: a number
// token bound to a frame's gap moves the frame's children in the same pass,
// and a main frame's gap edit relays out its copies in the same pass (layout
// runs after tokens and components, which write layout inputs). A second pass
// changes nothing. Stack layers are the truth: a fallback paint that
// disagrees with the top layer is overwritten on opening (the hand- or
// agent-written deck's case; an older shell's edit to it is the documented
// cost, docs/DECISIONS.md). A deck with no derived features is untouched.

import { derive, deriveMemory } from '../slides/src/derive.ts'
import { makeComponent, instanceOf, components } from '../slides/src/components.ts'
import type { BentoDoc } from '../slides/src/model.ts'

let checks = 0
let failures = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }

const rect = (id: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) =>
  ({ type: 'shape', id, shape: 'rect', x, y, w, h, rotation: 0, opacity: 1, fill: '#cccccc', stroke: '#000000', strokeWidth: 0, radius: 0, ...extra })
const deck = (elements: unknown[], tokens?: unknown): BentoDoc => ({
  format: 'bento/slides', version: 1, docId: 'd', title: 't', size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#111111', accent: '#f7a600', fontFamily: 'x', ...(tokens ? { tokens } : {}) },
  slides: [{ id: 's1', background: '#fff', transition: 'none', notes: '', elements }],
} as unknown as BentoDoc)
const el = (d: BentoDoc, id: string) => d.slides[0].elements.find((e) => e.id === id) as any

console.log('\none pass settles what a change reaches\n')
{
  const d = deck([
    rect('f', 0, 0, 600, 100, { layout: { dir: 'row', gap: 10, pad: [0, 0, 0, 0] }, themeRefs: { 'layout.gap': '$g' } }),
    rect('a', 0, 0, 50, 50, { parentId: 'f' }), rect('b', 60, 0, 50, 50, { parentId: 'f' }),
  ], { set: { g: { type: 'number', values: { default: 10 } } } })
  const mem = deriveMemory(d)
  derive(d, mem)
  ;(d.theme as any).tokens.set.g.values.default = 40
  derive(d, mem)
  ok(el(d, 'f').layout.gap === 40 && el(d, 'b').x === 90, `a token bound to a frame's gap moves its children in the same pass (gap ${el(d, 'f').layout.gap}, b.x ${el(d, 'b').x})`)
  ok(!derive(d, mem), 'and a second pass changes nothing')
}
{
  const d = deck([
    rect('f', 0, 0, 600, 100, { layout: { dir: 'row', gap: 10, pad: [0, 0, 0, 0] } }),
    rect('a', 0, 0, 50, 50, { parentId: 'f' }), rect('b', 60, 0, 50, 50, { parentId: 'f' }),
  ])
  makeComponent([el(d, 'f'), el(d, 'a'), el(d, 'b')], 'c', 'g')
  let n = 0
  d.slides[0].elements.push(...instanceOf(components(d)[0], () => `n${++n}`, 0, 300))
  const mem = deriveMemory(d)
  derive(d, mem)
  el(d, 'f').layout.gap = 40
  derive(d, mem)
  const copyB = d.slides[0].elements.find((e: any) => e.component?.key === el(d, 'b').component.key && !e.component.main) as any
  const copyF = d.slides[0].elements.find((e: any) => e.layout && !e.component.main) as any
  ok(copyF.layout.gap === 40 && copyB.x === 90, `a main frame's gap edit relays out its copy in the same pass (copy gap ${copyF.layout.gap}, copy b.x ${copyB.x})`)
  ok(!derive(d, mem), 'and a second pass changes nothing')
}

console.log('\nstack layers are the truth\n')
{
  const d = deck([rect('s', 0, 0, 100, 100, { fill: '#00ff00', fills: [{ color: '#0000ff' }, { color: '#ff0000' }] })])
  derive(d, deriveMemory(d))
  ok(el(d, 's').fill === '#ff0000' && el(d, 's').fills[1].color === '#ff0000', 'on opening, the fallback is rewritten from the top layer')
}
{
  const d = deck([rect('a', 1, 2, 3, 4), rect('b', 5, 6, 7, 8)])
  const before = JSON.stringify(d)
  ok(!derive(d, deriveMemory(d)) && JSON.stringify(d) === before, 'a deck with no derived features is untouched')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
