#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Built-in layout geometry rig.
//
//   node scripts/test-layouts.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. `builtinLayouts()` is drawn against a 1600x900 stage
// (LAYOUT_BASE) while the model default is 1280x720. For as long as the
// function ignored the deck's page size, applying "Title" to a default deck
// put the title box at x:160 w:1280 — a right edge of 1440 on a 1280-wide
// slide — and "Title + content" overflowed the bottom by 88px.
//
// That is the kind of defect no structural gate sees: tsc is happy, the shell
// builds, the file saves, and the only symptom is a heading running off the
// side of a slide somebody is presenting. It was found by an agent authoring
// a deck from agents.md (issue #160, finding 9b), not by us.
//
// So: every built-in layout must fit inside the canvas it is asked for, at
// the model default, at the authoring base, and at the non-16:9 sizes the
// slide panel offers. A layout that overflows here would ship a broken slide
// to whoever picked it.

import { builtinLayouts } from '../slides/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// The model default, the geometry's own base, and the two page-size presets
// that are not 16:9 — a squarer canvas is where a naive width-only scale breaks.
const SIZES = [
  { width: 1280, height: 720, name: 'model default 16:9' },
  { width: 1600, height: 900, name: 'authoring base 16:9' },
  { width: 1024, height: 768, name: '4:3' },
  { width: 1920, height: 1080, name: 'large 16:9' },
]

for (const size of SIZES) {
  const bad: string[] = []
  for (const ly of builtinLayouts(size)) {
    for (const e of ly.elements) {
      if (e.x < 0 || e.y < 0 || e.x + e.w > size.width || e.y + e.h > size.height) {
        bad.push(`${ly.id}/${e.id} → right ${e.x + e.w}, bottom ${e.y + e.h}`)
      }
    }
  }
  ok(bad.length === 0,
    `every built-in layout fits ${size.width}x${size.height} (${size.name})` +
    (bad.length ? `\n        ${bad.join('\n        ')}` : ''))
}

// Type has to scale too. A heading kept at 76px on a 1024-wide canvas would
// fit its BOX by the check above and still overflow it visually.
const titleAt = (w: number, h: number) => {
  const ly = builtinLayouts({ width: w, height: h }).find((l) => l.id === 'layout-title')!
  return ly.elements.find((e) => e.id === 'lt-title') as { fontSize?: number }
}
ok((titleAt(1280, 720).fontSize ?? 0) < (titleAt(1600, 900).fontSize ?? 0),
  'title type shrinks with the canvas')
ok((titleAt(1920, 1080).fontSize ?? 0) > (titleAt(1600, 900).fontSize ?? 0),
  'title type grows with the canvas')

// Omitting the size must return the base geometry untouched — `layoutElementIds`
// calls it that way purely to collect ids, and scaling there would be waste.
const bare = builtinLayouts()
const base = builtinLayouts({ width: 1600, height: 900 })
ok(JSON.stringify(bare) === JSON.stringify(base),
  'no size argument returns the unscaled base geometry')

// Ids are the join key for `applyLayout` (match by id, then by role), so a
// rescale must never rename anything.
ok(builtinLayouts({ width: 1024, height: 768 }).map((l) => l.id).join() === bare.map((l) => l.id).join(),
  'scaling preserves layout ids')
ok(JSON.stringify(builtinLayouts({ width: 1024, height: 768 }).map((l) => l.elements.map((e) => e.id)))
   === JSON.stringify(bare.map((l) => l.elements.map((e) => e.id))),
  'scaling preserves element ids')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
