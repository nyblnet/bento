#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The starter deck is the example of how a Bento deck is built: named layers,
// groups, auto-layout frames, components and design tokens. Bundled (the
// slides sources use extensionless imports):
//
//   slides/node_modules/.bin/esbuild scripts/test-slides-starterdeck.ts --bundle --platform=node --format=esm --outfile=/tmp/t.mjs && node /tmp/t.mjs
//
// WHAT THIS PROVES. The shipped deck is a derive fixed point (a boot changes
// nothing, so no token binding or component override is lost on opening); it
// validates without errors; every bound token exists and its literal agrees;
// every component copy has a main and kept its intended overrides; every
// frame child sits inside its frame; and each invisible hit rect covers the
// button it serves.

import { starterDoc } from '../slides/src/starterdeck.ts'
import { derive, deriveMemory } from '../slides/src/derive.ts'
import { validateDoc } from '../slides/src/validate.ts'
import { components, copiesOf } from '../slides/src/components.ts'
import { isFrame } from '../slides/src/layout.ts'
import { tokenName, tokenValue } from '../slides/src/tokens.ts'

let failures = 0
const ok = (c: unknown, msg: string) => { if (!c) { failures++; console.error('FAIL', msg) } }

const doc = starterDoc()
const before = JSON.stringify(doc)
ok(!derive(doc, deriveMemory(doc)), 'a boot derive pass changes nothing (fixed point)')
ok(JSON.stringify(doc) === before, 'document byte-identical after a boot derive')

const v = validateDoc(doc, { measure: false })
const errors = v.findings.filter((f) => f.severity === 'error')
ok(!errors.length, `validates without errors: ${errors.map((f) => f.code + ' ' + f.message).join('; ')}`)

let bound = 0
for (const s of doc.slides) for (const h of [s, ...s.elements] as Array<{ themeRefs?: Record<string, string> }>) {
  for (const [, ref] of Object.entries(h.themeRefs ?? {})) {
    const n = tokenName(ref)
    ok(n && tokenValue(doc, n) !== undefined, `token ${ref} exists`)
    bound++
  }
}
ok(bound > 600, `tokens are used across the deck (${bound} bindings)`)
// every visible colour, border width and font is bound; only zero widths,
// fully transparent paints and the hand-set one-off radii may stay literal
const parse = (c: string) => /rgba?\([^)]*,\s*0\s*\)$/.test(c) || c === 'transparent'
for (const s of doc.slides) for (const e of s.elements as any[]) {
  const refs = e.themeRefs ?? {}
  for (const k of ['fill', 'stroke', 'color']) if (typeof e[k] === 'string' && !parse(e[k]) && !refs[k]) ok(false, `${e.name ?? e.id}.${k} ${e[k]} is bound to a token`)
  if (e.strokeWidth && !refs.strokeWidth) ok(false, `${e.name ?? e.id}.strokeWidth is bound`)
  if (e.fontFamily && !refs.fontFamily) ok(false, `${e.name ?? e.id}.fontFamily is bound`)
}

const comps = components(doc)
ok(comps.length >= 3, `deck has components (${comps.map((c) => c.name).join(', ')})`)
for (const c of comps) ok(copiesOf(doc, c.id).length >= 2, `${c.name} has copies`)
const overrides = comps.flatMap((c) => copiesOf(doc, c.id).flatMap((i) => i.els.flatMap((e) => e.component?.over ?? [])))
ok(overrides.includes('html'), 'copies override their words')

let frames = 0
for (const s of doc.slides) {
  const byId = new Map(s.elements.map((e) => [e.id, e]))
  for (const e of s.elements) {
    if (isFrame(e)) frames++
    if (!e.parentId) continue
    const f = byId.get(e.parentId)!
    ok(isFrame(f), `${e.name ?? e.id}: parent is a frame`)
    ok(s.elements.indexOf(f) < s.elements.indexOf(e), `${e.name ?? e.id}: paints above its frame`)
    ok(e.x >= f.x - 0.01 && e.y >= f.y - 0.01 && e.x + e.w <= f.x + f.w + 0.01 && e.y + e.h <= f.y + f.h + 0.01,
      `${e.name ?? e.id} on ${s.name ?? s.id}: inside its frame`)
  }
  for (const hit of s.elements.filter((e) => e.link && e.type === 'shape' && /hit/.test(e.id))) {
    const btn = s.elements.find((e) => e !== hit && e.x === hit.x && e.y === hit.y && e.w === hit.w && e.h === hit.h)
    ok(btn, `${hit.id} on ${s.name ?? s.id}: covers its button exactly`)
  }
}
ok(frames >= 10, `deck uses auto layout (${frames} frames)`)

const named = doc.slides.flatMap((s) => s.elements).filter((e) => e.name || e.groupName).length
const all = doc.slides.flatMap((s) => s.elements).length
ok(named / all > 0.8, `layers are named (${named}/${all})`)

if (failures) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log(`starter deck OK — ${frames} frames, ${comps.length} components, ${bound} token bindings, ${named}/${all} named`)
