#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Brand palette rig.
//
//   node scripts/test-theme.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. `themeRefs` makes a deck re-brandable by recording where a
// colour came from, and a derivation rewrites the literals when the palette
// moves. Three properties have to hold or the feature is a liability:
//
//   1. IDEMPOTENCE. The derivation runs on the `doc` event behind a signature
//      guard. A derivation that does not settle is an infinite loop, and it
//      would present as the editor hanging, not as a wrong colour.
//   2. ADDITIVITY. Every shipped shell reads `el.fill` directly and always
//      will — the splice contract is frozen. So a document carrying refs must
//      hold literals that are already correct: deleting `palette` and
//      `themeRefs` must change NOTHING a renderer can see.
//   3. NO SILENT INVENTION. A ref pointing at an empty slot, a malformed token,
//      or a path whose target no longer exists must leave the document exactly
//      as it found it — never write undefined, never resurrect a deleted
//      gradient. Getting this wrong corrupts colours with no way back.

import type { BentoDoc } from '../slides/src/model.ts'
import {
  parseThemeRef, formatThemeRef, shiftLightness, paletteOf, resolveRef,
  resolveThemeRefs, paletteSignature, setColor, refAt,
} from '../slides/src/palette.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const deck = (): BentoDoc => ({
  format: 'bento/slides', version: '1.0.0', docId: 'theme-test', title: 'palette',
  size: { width: 1280, height: 720 },
  theme: {
    background: '#FFFFFF', color: '#1E2A3A', accent: '#F7A600',
    fontFamily: 'system-ui',
    palette: { accent2: '#5B8DEF', bg2: '#F5F7FA' },
  },
  assets: {}, fonts: null,
  slides: [{
    id: 's1', background: '#FFFFFF', transition: 'fade', notes: '',
    themeRefs: { background: 'bg1' },
    elements: [
      { id: 'card', type: 'shape', shape: 'rect', x: 96, y: 96, w: 400, h: 200,
        rotation: 0, opacity: 1, fill: '#F7A600', stroke: '#C58500', strokeWidth: 2,
        radius: 8, shadow: { blur: 20, color: '#1E2A3A' },
        themeRefs: { fill: 'accent1', stroke: 'accent1 -20%', 'shadow.color': 'tx1' } } as any,
      { id: 'grad', type: 'shape', shape: 'rect', x: 600, y: 96, w: 300, h: 200,
        rotation: 0, opacity: 1, fill: '#000', stroke: 'none', strokeWidth: 0, radius: 0,
        fillGradient: { angle: 90, stops: [{ at: 0, color: '#5B8DEF' }, { at: 1, color: '#FFFFFF' }] },
        themeRefs: { 'fillGradient.stops.0.color': 'accent2', 'fillGradient.stops.1.color': 'bg1' } } as any,
    ],
  }],
} as any)

// ------------------------------------------------------------------ tokens
ok(parseThemeRef('accent1')?.slot === 'accent1', 'a bare slot parses')
ok(parseThemeRef('accent1 -20%')?.shift === -20, 'a negative shift parses')
ok(parseThemeRef('accent1 +40%')?.shift === 40, 'a positive shift parses')
ok(parseThemeRef('  tx1  ')?.slot === 'tx1', 'surrounding space is tolerated')
ok(parseThemeRef('nope') === null, 'an unknown slot is refused, not guessed')
ok(parseThemeRef('accent1 20%') === null, 'a shift with no sign is refused')
ok(parseThemeRef('') === null, 'an empty token is refused')
ok(formatThemeRef({ slot: 'accent1', shift: 0 }) === 'accent1', 'a zero shift round-trips bare')
ok(formatThemeRef({ slot: 'accent1', shift: -20 }) === 'accent1 -20%', 'a shift round-trips')

// ------------------------------------------------------------------ colour
ok(shiftLightness('#808080', 0) === '#808080', 'a zero shift is identity')
ok(shiftLightness('#000000', 100).toLowerCase() === '#ffffff', '+100% reaches white')
ok(shiftLightness('#FFFFFF', -100).toLowerCase() === '#000000', '-100% reaches black')
ok(shiftLightness('#F7A600', -20) !== '#F7A600', 'a real shift moves the colour')
ok(shiftLightness('#F7A60080', -20).length === 9, 'alpha survives a shift')
ok(shiftLightness('rgb(1,2,3)', -20) === 'rgb(1,2,3)', 'a non-hex colour is left alone, not mangled')
ok(shiftLightness('#abc', 0) === '#abc', 'shorthand hex with no shift is untouched')

// ------------------------------------------------------------- resolution
{
  const d = deck()
  const p = paletteOf(d)
  ok(p.bg1 === '#FFFFFF' && p.tx1 === '#1E2A3A' && p.accent1 === '#F7A600',
    'bg1/tx1/accent1 come from the canonical fields, never a second copy')
  ok(p.accent2 === '#5B8DEF', 'a palette slot is used when present')
  ok(p.accent3 === '#F7A600', 'an absent slot falls back to accent rather than dangling')
  ok(resolveRef('accent1', p) === '#F7A600', 'a bare ref resolves to the slot')
  ok(resolveRef('nope', p) === null, 'an unknown slot resolves to null, not a colour')
}

// ------------------------------------------------------------- idempotence
{
  const d = deck()
  const first = resolveThemeRefs(d)
  const after1 = JSON.stringify(d)
  const second = resolveThemeRefs(d)
  const after2 = JSON.stringify(d)
  ok(after1 === after2, 'derivation is idempotent — a second pass changes nothing')
  ok(second === false, 'the second pass reports no change (the loop guard depends on it)')
  void first
}

// ------------------------------------------------------------ determinism
{
  const a = deck(); const b = deck()
  resolveThemeRefs(a); resolveThemeRefs(b)
  ok(JSON.stringify(a) === JSON.stringify(b),
    'two replicas derive byte-identical documents — no ops need to cross the wire')
}

// --------------------------------------------------------------- it works
{
  const d = deck()
  d.theme.accent = '#E8442E'      // re-brand
  resolveThemeRefs(d)
  const card: any = d.slides[0].elements[0]
  ok(card.fill === '#E8442E', 'changing accent1 rewrites every literal referencing it')
  ok(card.stroke !== '#E8442E' && card.stroke !== '#C58500',
    'a shifted ref re-derives from the NEW base, not the old literal')
  const grad: any = d.slides[0].elements[1]
  ok(grad.fillGradient.stops[0].color === '#5B8DEF', 'a nested array path resolves')
  ok(d.slides[0].background === '#FFFFFF', 'a slide-level ref resolves')
}

// ------------------------------------------------------------- additivity
// The compatibility proof. A shipped shell knows nothing about palette/themeRefs
// and reads the literals; so removing both must leave every literal identical.
{
  const derived = deck(); resolveThemeRefs(derived)
  const stripped = JSON.parse(JSON.stringify(derived))
  delete stripped.theme.palette
  const strip = (o: any) => { delete o.themeRefs }
  for (const s of stripped.slides) { strip(s); s.elements.forEach(strip) }
  const visible = (doc: any) => JSON.stringify(doc, (k, v) => (k === 'themeRefs' || k === 'palette' ? undefined : v))
  ok(visible(derived) === visible(stripped),
    'stripping palette + themeRefs leaves every rendered value byte-identical')
}

// -------------------------------------------------------- no invention
{
  const d = deck()
  ;(d.slides[0].elements[0] as any).themeRefs.fill = 'ghost'   // unknown slot
  const before = (d.slides[0].elements[0] as any).fill
  resolveThemeRefs(d)
  ok((d.slides[0].elements[0] as any).fill === before,
    'a ref to an unknown slot leaves the literal exactly as it was')
}
{
  const d = deck()
  delete (d.slides[0].elements[0] as any).shadow     // target removed by the user
  resolveThemeRefs(d)
  ok((d.slides[0].elements[0] as any).shadow === undefined,
    'a ref whose target was deleted does not resurrect it')
}
{
  const d = deck()
  ;(d.slides[0].elements[0] as any).themeRefs.fill = 'accent1 nonsense'
  const before = (d.slides[0].elements[0] as any).fill
  resolveThemeRefs(d)
  ok((d.slides[0].elements[0] as any).fill === before, 'a malformed token changes nothing')
}

// ------------------------------------------------------------- setColor
{
  const d = deck()
  const el: any = d.slides[0].elements[0]
  setColor(el, 'fill', '#123456', null)   // a deliberate custom colour
  ok(el.fill === '#123456', 'setColor writes the literal')
  ok(refAt(el, 'fill') === undefined, 'choosing a custom colour CLEARS the ref')
  resolveThemeRefs(d)
  ok(el.fill === '#123456',
    'and the next palette derivation does not overwrite it — the whole point of clearing')
  setColor(el, 'fill', '#F7A600', 'accent1')
  ok(refAt(el, 'fill') === 'accent1', 'setColor can put a ref back')
}

// ------------------------------------------------------------- signature
{
  const d = deck()
  const s1 = paletteSignature(d)
  d.slides[0].elements[0].x = 999                 // an unrelated edit
  ok(paletteSignature(d) === s1, 'the guard ignores edits that cannot change colours')
  d.theme.accent = '#000000'
  ok(paletteSignature(d) !== s1, 'the guard fires when the palette moves')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
