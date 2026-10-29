#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Design tokens (slides/src/tokens.ts) and component copies (components.ts),
// DOM-free:
//
//   node scripts/test-slides-tokens.ts
//
// WHAT THIS PROVES. A binding writes the token's value AND the `$name` ref; a
// token edit or a mode switch rewrites every bound literal, numbers and
// colours alike, and keeps a colour's own opacity; a literal edited by hand
// loses its binding and keeps the hand value; rename and delete carry the refs;
// a deck with no tokens is untouched; the palette derivation ignores `$` refs.
// Components: a copy follows its main's edits, keeps its own offset, keeps a
// property edited by hand as an override, and detach stops the following.

import { bindToken, deleteToken, renameToken, syncTokenRefs, tokenName, tokenUses, unbindToken } from '../slides/src/tokens.ts'
import { resolveThemeRefs } from '../slides/src/palette.ts'
import { components, detach, instanceOf, makeComponent, syncComponents } from '../slides/src/components.ts'
import type { BentoDoc } from '../slides/src/model.ts'

let failures = 0, checks = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }

const deck = (): BentoDoc => ({
  format: 'bento/slides', version: 1, docId: 'd', title: 't', size: { width: 1280, height: 720 },
  theme: {
    background: '#ffffff', color: '#111111', accent: '#f7a600', fontFamily: 'x',
    tokens: { modes: ['light', 'dark'], mode: 'light', set: {
      'radius.card': { type: 'number', values: { light: 12, dark: 12 } },
      'color.card': { type: 'color', values: { light: '#eeeeee', dark: '#222222' } },
    } },
  },
  slides: [{ id: 's1', background: '#fff', transition: 'none', notes: '', elements: [
    { type: 'shape', id: 'a', shape: 'rect', x: 0, y: 0, w: 100, h: 50, rotation: 0, opacity: 1, fill: '#ff000080', stroke: '#000', strokeWidth: 0, radius: 0 },
    { type: 'shape', id: 'b', shape: 'rect', x: 0, y: 0, w: 100, h: 50, rotation: 0, opacity: 1, fill: '#00ff00', stroke: '#000', strokeWidth: 0, radius: 4 },
  ] }],
} as unknown as BentoDoc)
const el = (d: BentoDoc, id: string) => d.slides[0].elements.find((e) => e.id === id) as any

console.log('\ntokens\n')
{
  const d = deck()
  ok(tokenName('$radius.card') === 'radius.card' && tokenName('accent1') === null, '`$name` is a token ref, a slot name is not')
  bindToken(d, el(d, 'a'), 'radius', 'radius.card')
  bindToken(d, el(d, 'a'), 'fill', 'color.card')
  ok(el(d, 'a').radius === 12 && el(d, 'a').themeRefs.radius === '$radius.card', 'binding writes the number and the ref')
  ok(el(d, 'a').fill === '#eeeeee80', 'binding a colour keeps the field\'s own opacity')
  ok(!syncTokenRefs(d, false), 'a deck in step with its tokens: nothing to do')

  d.theme.tokens!.set['radius.card'].values.light = 20
  ok(syncTokenRefs(d, true) && el(d, 'a').radius === 20, 'a token edit rewrites the bound number')
  d.theme.tokens!.mode = 'dark'
  syncTokenRefs(d, true)
  ok(el(d, 'a').fill === '#22222280' && el(d, 'a').radius === 12, 'switching the mode rewrites every bound literal from that mode')
  ok(!syncTokenRefs(d, true), 'idempotent: a second pass writes nothing')

  el(d, 'a').radius = 3 // a hand edit
  ok(syncTokenRefs(d, false) && el(d, 'a').radius === 3 && !el(d, 'a').themeRefs.radius, 'a hand edit drops the binding and keeps the hand value')
  ok(el(d, 'a').themeRefs.fill === '$color.card', '…and only that one')

  resolveThemeRefs(d)
  ok(el(d, 'a').fill === '#22222280', 'the palette derivation leaves `$` refs alone')

  renameToken(d, 'color.card', 'surface')
  ok(el(d, 'a').themeRefs.fill === '$surface' && !!d.theme.tokens!.set.surface, 'rename carries every ref')
  ok(tokenUses(d).get('surface') === 1, 'uses are counted')
  deleteToken(d, 'surface')
  ok(!el(d, 'a').themeRefs && el(d, 'a').fill === '#22222280', 'delete unbinds; the literal stays')
  bindToken(d, el(d, 'b'), 'radius', 'radius.card')
  unbindToken(el(d, 'b'), 'radius')
  ok(!el(d, 'b').themeRefs && el(d, 'b').radius === 12, 'unbind keeps the literal')

  const plain = deck(); delete (plain.theme as any).tokens
  const before = JSON.stringify(plain)
  syncTokenRefs(plain, true); syncTokenRefs(plain, false)
  ok(JSON.stringify(plain) === before, 'a deck with no tokens is untouched')
}

console.log('\ncomponents\n')
{
  const d = deck()
  const last = new Map<string, string>()
  makeComponent([el(d, 'a'), el(d, 'b')], 'c1', 'g1')
  let n = 0
  const copy = instanceOf(components(d)[0], () => `n${++n}`, 300, 0)
  d.slides[0].elements.push(...copy)
  ok(copy.length === 2 && copy.every((e) => e.component?.id === 'c1' && !e.component.main && e.groupId === copy[0].groupId), 'an instance is a fresh group of copies')
  syncComponents(d, last)
  ok(!syncComponents(d, last), 'a fresh copy agrees with its main')

  el(d, 'a').fill = '#0000ff'; el(d, 'b').x = 10
  ok(syncComponents(d, last), 'the main moved')
  const [ca, cb] = copy as any[]
  ok(ca.fill === '#0000ff', 'a copy follows its main\'s edit')
  ok(cb.x === 310 && ca.x === 300, 'and keeps its own offset')

  cb.fill = '#123456' // a hand edit on the copy
  syncComponents(d, last)
  ok(cb.component.over?.includes('fill') && cb.fill === '#123456', 'a copy edited by hand records an override')
  el(d, 'b').fill = '#abcdef'; el(d, 'b').radius = 9
  syncComponents(d, last)
  ok(cb.fill === '#123456' && cb.radius === 9, 'an override survives the next main edit; other keys still follow')

  detach([ca])
  el(d, 'a').fill = '#000000'
  syncComponents(d, last)
  ok(ca.fill === '#0000ff' && !ca.component, 'a detached element stops following')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
