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

// tokens.ts reaches the file gate (untrusted.ts), which imports app modules
// without extensions: the resolve hooks go in before any app module loads
const { register } = await import('node:module')
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { bindToken, deleteToken, renameToken, syncTokenRefs, tokenName, tokenUses, unbindToken } = await import('../slides/src/tokens.ts')
const { resolveThemeRefs } = await import('../slides/src/palette.ts')
const { components, detach, instanceOf, makeComponent, syncComponents } = await import('../slides/src/components.ts')
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
  makeComponent([el(d, 'a'), el(d, 'b')], 'c1', 'g1')
  let n = 0
  const copy = instanceOf(components(d)[0], () => `n${++n}`, 300, 0)
  d.slides[0].elements.push(...copy)
  ok(copy.length === 2 && copy.every((e) => e.component?.id === 'c1' && !e.component.main && e.groupId === copy[0].groupId), 'an instance is a fresh group of copies')
  syncComponents(d)
  ok(!syncComponents(d), 'a fresh copy agrees with its main')

  el(d, 'a').fill = '#0000ff'; el(d, 'b').x = 10
  ok(syncComponents(d), 'the main moved')
  const [ca, cb] = copy as any[]
  ok(ca.fill === '#0000ff', 'a copy follows its main\'s edit')
  ok(cb.x === 310 && ca.x === 300, 'and keeps its own offset')

  cb.fill = '#123456' // a hand edit on the copy
  syncComponents(d)
  ok(cb.component.over?.includes('fill') && cb.fill === '#123456', 'a copy edited by hand records an override')
  el(d, 'b').fill = '#abcdef'; el(d, 'b').radius = 9
  syncComponents(d)
  ok(cb.fill === '#123456' && cb.radius === 9, 'an override survives the next main edit; other keys still follow')

  detach([ca])
  el(d, 'a').fill = '#000000'
  syncComponents(d)
  ok(ca.fill === '#0000ff' && !ca.component, 'a detached element stops following')
}

console.log('\nno token reaches past its own data\n')
{
  // '$toString' passes the name regex; Object.prototype must never answer for a token or a mode
  const d = deck()
  el(d, 'a').themeRefs = { fill: '$toString' }
  let threw = ''
  try { syncTokenRefs(d, true); syncTokenRefs(d, false) } catch (e) { threw = (e as Error).message }
  ok(!threw && el(d, 'a').fill === '#ff000080', `a ref to "$toString" is no token: nothing throws, nothing is written (${threw || 'ok'})`)
  ok(tokenName('$toString') === null && tokenName('$__proto__') === null && tokenName('$constructor') === null, 'tokenName refuses names Object.prototype owns')
  for (const mode of ['toString', '__proto__', 'constructor']) {
    const m = deck()
    ;(m.theme as any).tokens = JSON.parse(`{"modes":["${mode}"],"mode":"${mode}","set":{"c":{"type":"color","values":{"default":"#123456"}}}}`)
    el(m, 'a').themeRefs = { fill: '$c' }
    syncTokenRefs(m, true)
    ok(typeof el(m, 'a').fill === 'string' && el(m, 'a').fill.startsWith('#123456'), `a mode named "${mode}" is ignored: the fill stays a colour (${typeof el(m, 'a').fill})`)
  }
}
{
  // theme.tokens with no set (an older shell's gate, a hand edit) must not crash the doc hook
  const d = deck()
  ;(d.theme as any).tokens = {}
  el(d, 'a').themeRefs = { fill: '$x' }
  let threw = ''
  try { syncTokenRefs(d, true); tokenUses(d); renameToken(d, 'x', 'y'); deleteToken(d, 'x') } catch (e) { threw = (e as Error).message }
  ok(!threw, `a token set that is missing reads as empty (${threw || 'ok'})`)
}
{
  // a token value is held to the rule of the property it is written into
  const d = deck()
  ;(d.theme as any).tokens.set.evil = { type: 'fontFamily', values: { light: 'red) url(https://evil.example/f.svg#f', dark: 'x' } }
  ;(d.theme as any).tokens.set.n = { type: 'number', values: { light: 7, dark: 7 } }
  ;(d.theme as any).tokens.set.inf = { type: 'number', values: { light: Infinity, dark: Infinity } }
  const a = el(d, 'a')
  a.shadow = { x: 0, y: 2, blur: 4, color: '#000000' }
  ok(!bindToken(d, a, 'shadow.color', 'evil') && a.shadow.color === '#000000', 'a font string is not bound into a shadow colour (no CSS reaches style.filter)')
  ok(!bindToken(d, a, 'id', 'n') && a.id === 'a', 'nothing binds to id')
  a.link = 's9'; a.component = { id: 'c', key: 'k' }
  for (const path of ['type', 'link', 'parentId', 'component.main', 'html']) {
    const before = JSON.stringify(a)
    ok(!bindToken(d, a, path, 'n') && JSON.stringify(a) === before, `nothing binds to ${path}, and nothing is written there`)
  }
  delete a.link; delete a.component
  ok(!bindToken(d, a, 'radius', 'inf') && a.radius === 0, 'a non-finite number is not written')
  a.themeRefs = { 'shadow.color': '$evil', radius: '$inf' } // as a hostile file would carry them
  syncTokenRefs(d, true)
  ok(a.shadow.color === '#000000' && a.radius === 0, 'refs a file carries are refused the same way at sync')
  const f = el(d, 'b')
  f.layout = { dir: 'grid', gap: 10, pad: [0, 0, 0, 0], cols: 2 }
  ;(d.theme as any).tokens.set.zero = { type: 'number', values: { light: 0, dark: 0 } }
  ok(!bindToken(d, f, 'layout.cols', 'zero') && f.layout.cols === 2, 'a grid is not given 0 columns by a token')
  ok(bindToken(d, f, 'layout.gap', 'n') && f.layout.gap === 7, 'an allowed path still binds (layout.gap)')
}

console.log('\ncomponents and frames\n')
{
  // C2: a component whose main is a frame with a child; the copy's child belongs to the COPY's frame
  const d = deck()
  const [a, b] = [el(d, 'a'), el(d, 'b')]
  a.layout = { dir: 'row', gap: 10, pad: [10, 10, 10, 10] }
  b.parentId = 'a'
  makeComponent([a, b], 'cf', 'g1')
  let n = 0
  const copy = instanceOf(components(d)[0], () => `n${++n}`, 0, 300) as any[]
  d.slides[0].elements.push(...copy)
  syncComponents(d)
  const [cf, cc] = [copy.find((e) => e.layout), copy.find((e) => !e.layout)]
  ok(cc.parentId === cf.id, `a copy's child sits in the copy's frame (${cc.parentId}), not the main's`)
  a.layout.gap = 40 // the main frame moves on
  syncComponents(d)
  ok(cc.parentId === cf.id && !cc.component.over?.includes('parentId'), 'and stays there when the main changes, with no override recorded')
}
{
  // C3: a component made of one frame child; an instance placed elsewhere does not join the main's frame
  const d = deck()
  const [f, a] = [el(d, 'a'), el(d, 'b')]
  f.layout = { dir: 'row', gap: 10, pad: [10, 10, 10, 10] }
  a.parentId = 'a'; a.sizing = { w: 'fill' }
  makeComponent([a], 'c1', 'g1')
  const copy = instanceOf(components(d)[0], () => 'i', 500, 300) as any[]
  d.slides[0].elements.push(...copy)
  syncComponents(d)
  ok(copy[0].parentId === undefined && copy[0].sizing === undefined, 'an instance of a frame child is placed free, not pulled into the main frame')
  ok(!copy[0].component.over, 'and records no override for the frame link it does not share')
}
{
  // M4: two main sets for one component (an old duplicate) — the first in deck order is THE main, deterministically
  const d = deck()
  makeComponent([el(d, 'a')], 'c1', 'g1')
  const dup = JSON.parse(JSON.stringify(d.slides[0])); dup.id = 's2'
  d.slides.push(dup)
  const copy = instanceOf(components(d)[0], () => 'k', 0, 300) as any[]
  d.slides[0].elements.push(...copy)
  syncComponents(d)
  ok(components(d).length === 1 && components(d)[0].main.length === 1 && components(d)[0].main[0] === el(d, 'a'), 'two main sets: the first in deck order is the main')
  el(d, 'a').fill = '#ff0000'
  syncComponents(d)
  ok(copy[0].fill === '#ff0000', 'an edit to that main reaches its copies')
}

{
  // item 7: "has the main moved?" is read from the file, not from one replica's memory
  const mk = () => {
    const d = deck()
    makeComponent([el(d, 'a')], 'c1', 'g1')
    d.slides[0].elements.push(...instanceOf(components(d)[0], () => 'cp', 0, 300))
    syncComponents(d)
    return d
  }
  const copyOf = (d: any) => d.slides[0].elements.find((e: any) => e.id === 'cp')
  const joined = JSON.parse(JSON.stringify(mk())) // a replica that just joined, or a session opening the file
  joined.slides[0].elements.find((e: any) => e.id === 'a').fill = '#00ffff' // the main, edited by an older shell
  syncComponents(joined)
  ok(copyOf(joined).fill === '#00ffff' && !copyOf(joined).component.over, 'a main edited before this session opened still reaches its copies')
  const other = JSON.parse(JSON.stringify(mk()))
  copyOf(other).fill = '#ff00ff' // the copy, edited by an older shell
  syncComponents(other)
  ok(copyOf(other).fill === '#ff00ff' && copyOf(other).component.over?.includes('fill'), 'a copy edited before this session opened keeps its edit as an override')
}

console.log('\ntoken types beyond colour and number\n')
{
  const d = deck()
  d.theme.tokens!.set['font.body'] = { type: 'fontFamily', values: { light: 'Courier New, monospace', dark: 'Courier New, monospace' } }
  d.theme.tokens!.set['shadow.card'] = { type: 'shadow', values: { light: { x: 0, y: 4, blur: 12, color: 'rgba(0, 0, 0, 0.2)' }, dark: { x: 0, y: 8, blur: 24, color: '#000000' } } }
  d.theme.tokens!.set['opacity.muted'] = { type: 'opacity', values: { light: 0.5, dark: 0.7 } }
  d.slides[0].elements.push({ type: 'text', id: 't', x: 0, y: 0, w: 100, h: 40, rotation: 0, opacity: 1, html: 'x', fontSize: 20, fontFamily: '#abc, serif', fontWeight: 400, color: '#000', align: 'left', valign: 'top', lineHeight: 1.2 } as never)
  bindToken(d, el(d, 't'), 'fontFamily', 'font.body')
  ok(el(d, 't').fontFamily === 'Courier New, monospace', 'a font token writes the stack as-is (never treated as a colour)')
  bindToken(d, el(d, 'a'), 'shadow', 'shadow.card')
  ok(el(d, 'a').shadow.blur === 12 && el(d, 'a').shadow !== d.theme.tokens!.set['shadow.card'].values.light, 'a shadow token writes a copy, never the token object itself')
  bindToken(d, el(d, 'a'), 'opacity', 'opacity.muted')
  ok(el(d, 'a').opacity === 0.5, 'an opacity token writes 0..1')
  ok(!syncTokenRefs(d, false), 'a bound shadow is not mistaken for a hand edit')
  el(d, 'a').shadow = { color: 'rgba(0, 0, 0, 0.2)', blur: 12, y: 4, x: 0 }
  ok(!syncTokenRefs(d, false) && el(d, 'a').themeRefs.shadow === '$shadow.card', 'nor is the same shadow with its keys in another order')
  d.theme.tokens!.mode = 'dark'
  syncTokenRefs(d, true)
  ok(el(d, 'a').shadow.blur === 24 && el(d, 'a').opacity === 0.7, 'switching mode moves the shadow and the opacity')
  el(d, 'a').shadow = { ...el(d, 'a').shadow, blur: 3 }
  syncTokenRefs(d, false)
  ok(!el(d, 'a').themeRefs.shadow && el(d, 'a').shadow.blur === 3, 'a shadow edited by hand drops its binding and keeps the edit')
}
{
  // restoregate.ts imports app source extensionless: the hooks resolve it as vite does
  const { register } = await import('node:module')
  register('./lib/ts-resolve-hooks.mjs', import.meta.url)
  const { sanitizeDoc } = await import('../slides/src/restoregate.ts')
  const d = deck() as any
  d.theme.tokens.set = {
    'font.ok': { type: 'fontFamily', values: { light: 'Inter, sans-serif' } },
    'shadow.ok': { type: 'shadow', values: { light: { x: 1, y: 2, blur: 3, color: '#000000' } } },
    'shadow.bad': { type: 'shadow', values: { light: 'url(javascript:alert(1))' } },
    'opacity.bad': { type: 'opacity', values: { light: 3 } },
    'type.bad': { type: 'gradient', values: { light: 1 } },
  }
  const out = sanitizeDoc(JSON.parse(JSON.stringify(d)))!.doc.theme.tokens!.set
  ok(!!out['font.ok']?.values.light && !!out['shadow.ok']?.values.light, 'the file gate keeps a font and a shadow token')
  ok(!out['shadow.bad']?.values.light && !out['opacity.bad']?.values.light && !out['type.bad'], 'and drops a non-shadow shadow, an opacity past 1 and an unknown type')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
