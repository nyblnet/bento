#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The file gate's rules for the keys the editor revamp added, by behaviour.
//
//   esbuild scripts/test-slides-gate-keys.ts --bundle --platform=node --format=esm --outfile=… && node …
//
// WHAT THIS PROVES. Every rule the gate (untrusted.ts, restoregate.ts) holds
// a new key to is exercised by a value it must take and one it must refuse —
// not left to schema drift, which only notices a rule that DISAPPEARS, never
// one that is loosened. Booleans: operands must be shapes, at least two, at
// most the element cap, nested at most 8 deep (a hostile clip nested 1300
// deep is refused, not a stack overflow), and carry no component, frame link
// or lock. Components: `main` is `true` or absent; `sig` is a short hash.
// Frames: `layout.pad` is four numbers, `cols` 1..64; `sizing` takes only its
// words; `parentId`, `alt`, `locked` hold their types. Paint: radial `cx` is
// bounded; a stack has at most 16 layers; a stroke layer's width is bounded.
// Token refs: only on bindable properties, only real token names; a slide's
// only on its background. Theme tokens, on restore AND on file open: names
// that are not token names or reach into Object.prototype are dropped, as are
// modes that would, values outside their type's rule, sets past 500 tokens or
// 16 modes; a token set with no `set` is normalised away instead of crashing.

import { sanitizeElement, sanitizeSlide, LIMITS } from '../slides/src/untrusted.ts'
import { gateRestored, guardOpenedDoc } from '../slides/src/restoregate.ts'
import { newDoc, type BentoDoc } from '../slides/src/model.ts'

let checks = 0
let failures = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }

const rect = (extra: Record<string, unknown> = {}) => ({ type: 'shape', id: 'r', shape: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, fill: '#000000', stroke: '#000000', strokeWidth: 0, radius: 0, ...extra })
const kept = (extra: Record<string, unknown>, key: string) => (sanitizeElement(rect(extra)) as any)?.[key]

console.log('\nbooleans\n')
{
  const two = [rect({ id: 'a' }), rect({ id: 'b' })]
  ok(!!kept({ shape: 'path', d: 'M0 0 L1 1 Z', bool: { op: 'union', shapes: two } }, 'bool'), 'two shape operands are kept')
  ok(!kept({ bool: { op: 'union', shapes: [rect({ id: 'a' }), { type: 'text', id: 't', x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1, html: 'x', fontSize: 10, fontFamily: 'x', fontWeight: 400, color: '#000' }] } }, 'bool'), 'a non-shape operand drops the operand list')
  ok(!kept({ bool: { op: 'union', shapes: [rect({ id: 'a' })] } }, 'bool'), 'one operand is no boolean')
  const many = Array.from({ length: LIMITS.elements + 1 }, (_, i) => rect({ id: `o${i}` }))
  ok(!kept({ bool: { op: 'union', shapes: many } }, 'bool'), `more than ${LIMITS.elements} operands are refused`)
  ok(!kept({ bool: { op: 'xor', shapes: two } }, 'bool'), 'an unknown operation is refused')
  let deep: any = rect({ id: 'leaf' })
  for (let i = 0; i < 1300; i++) deep = rect({ id: `n${i}`, shape: 'path', d: 'M0 0 Z', bool: { op: 'union', shapes: [deep, rect({ id: `s${i}` })] } })
  let threw = ''
  try { sanitizeElement(deep) } catch (e) { threw = (e as Error).message }
  ok(!threw, `a boolean nested 1300 deep is refused without a stack overflow (${threw || 'ok'})`)
  let nest: any = rect({ id: 'leaf' })
  for (let i = 0; i < 3; i++) nest = rect({ id: `m${i}`, shape: 'path', d: 'M0 0 Z', bool: { op: 'union', shapes: [nest, rect({ id: `t${i}` })] } })
  ok(!!(sanitizeElement(nest) as any)?.bool?.shapes[0]?.bool?.shapes[0]?.bool, 'a boolean of a boolean of a boolean is kept')
  const tagged = (sanitizeElement(rect({ shape: 'path', d: 'M0 0 Z', bool: { op: 'union', shapes: [
    rect({ id: 'a', component: { id: 'c', key: 'k', main: true }, parentId: 'f', sizing: { w: 'fill' }, locked: true, layout: { dir: 'row', gap: 0, pad: [0, 0, 0, 0] } }),
    rect({ id: 'b' })] } })) as any)?.bool?.shapes[0]
  ok(!!tagged && !tagged.component && !tagged.parentId && !tagged.sizing && !tagged.locked && !tagged.layout, 'an operand carries no component, frame link, sizing, lock or layout')
}

console.log('\ncomponents, frames and the small keys\n')
{
  ok(kept({ component: { id: 'c', key: 'k', main: true } }, 'component')?.main === true, 'component.main true is kept')
  ok(kept({ component: { id: 'c', key: 'k', main: 'yes' } }, 'component')?.main === undefined, 'component.main anything else is dropped')
  ok(!kept({ component: { key: 'k' } }, 'component'), 'a component with no id is dropped')
  ok(kept({ component: { id: 'c', key: 'k', sig: 'a1b2c3' } }, 'component')?.sig === 'a1b2c3', 'a short hash sig is kept')
  ok(kept({ component: { id: 'c', key: 'k', sig: 'x'.repeat(40) } }, 'component')?.sig === undefined, 'a long or odd sig is dropped')
  const L = (layout: unknown) => kept({ layout }, 'layout')
  ok(!!L({ dir: 'row', gap: 4, pad: [1, 2, 3, 4] }), 'a well-formed layout is kept')
  ok(!L({ dir: 'row', gap: 4, pad: [1, 2, 3] }) && !L({ dir: 'row', gap: 4, pad: 'lots' }), 'layout.pad must be four numbers')
  ok(L({ dir: 'grid', gap: 4, pad: [0, 0, 0, 0], cols: 0 })?.cols === undefined && L({ dir: 'grid', gap: 4, pad: [0, 0, 0, 0], cols: 65 })?.cols === undefined, 'layout.cols outside 1..64 is dropped')
  ok(!L({ dir: 'diagonal', gap: 4, pad: [0, 0, 0, 0] }), 'an unknown direction drops the layout')
  ok(kept({ sizing: { w: 'fill', h: 'hug' } }, 'sizing')?.h === undefined && kept({ sizing: { w: 'fill' } }, 'sizing')?.w === 'fill', 'sizing takes only fixed and fill')
  ok(kept({ parentId: 'f1' }, 'parentId') === 'f1' && kept({ parentId: 'x"; y' }, 'parentId') === undefined, 'parentId is an id')
  ok(kept({ alt: 'A chart of sales' }, 'alt') === 'A chart of sales' && kept({ alt: 'x'.repeat(LIMITS.prose + 1) }, 'alt') === undefined && kept({ alt: 7 }, 'alt') === undefined, 'alt is bounded text')
  ok(kept({ locked: true }, 'locked') === true && kept({ locked: 'true' }, 'locked') === undefined, 'locked is a boolean')
}

console.log('\npaint\n')
{
  const grad = (cx: number) => kept({ fillGradient: { angle: 0, kind: 'radial', cx, cy: 0.5, r: 0.5, stops: [{ at: 0, color: '#000' }, { at: 1, color: '#fff' }] } }, 'fillGradient')
  ok(grad(0.5)?.cx === 0.5 && grad(11)?.cx === undefined, 'a radial centre is bounded')
  const layers = (n: number) => kept({ fills: Array.from({ length: n }, () => ({ color: '#123456' })) }, 'fills')
  ok(layers(LIMITS.paintLayers)?.length === LIMITS.paintLayers && !layers(LIMITS.paintLayers + 1), `a stack holds at most ${LIMITS.paintLayers} layers`)
  const sw = (width: number) => kept({ strokes: [{ color: '#000', width }, { color: '#fff', width: 1 }] }, 'strokes')
  ok(!!sw(4) && !sw(1e5) && !sw(-1), 'a stroke layer width is bounded')
}

console.log('\ntoken references\n')
{
  const refs = (themeRefs: Record<string, string>) => kept({ themeRefs }, 'themeRefs') ?? {}
  ok(refs({ fill: '$brand' }).fill === '$brand' && refs({ 'layout.gap': '$space.md' })['layout.gap'] === '$space.md', 'a token ref on a bindable property is kept')
  for (const path of ['id', 'type', 'html', 'link', 'component.main', 'parentId', 'bool.shapes.0.fill'])
    ok(refs({ [path]: '$brand' })[path] === undefined, `a token ref on ${path} is dropped`)
  ok(refs({ fill: '$9bad' }).fill === undefined && refs({ fill: '$toString' }).fill === undefined, 'a ref to a name that is no token name is dropped')
  ok(refs({ fill: 'accent1' }).fill === 'accent1', 'palette refs are unchanged')
  for (const path of ['html', 'link', 'id', 'src'])
    ok(refs({ [path]: 'accent1' })[path] === undefined, `a palette ref on ${path} is dropped — it would write a colour over it`)
  ok(refs({ 'shadow.color': 'accent2', 'fillGradient.stops.0.color': 'tx1' })['shadow.color'] === 'accent2', 'palette refs on paint paths are kept')
  const slide = (themeRefs: Record<string, string>) => (sanitizeSlide({ id: 's', background: '#fff', transition: 'none', notes: '', elements: [], themeRefs }) as any)?.themeRefs ?? {}
  ok(slide({ background: '$brand' }).background === '$brand' && slide({ notes: '$brand' }).notes === undefined, "a slide's token ref sits only on its background")
}

console.log('\ntheme tokens, restored and opened\n')
{
  const live = newDoc()
  const withTokens = (tokens: unknown): BentoDoc => ({ ...JSON.parse(JSON.stringify(live)), theme: { ...live.theme, tokens } })
  const restored = (tokens: unknown) => gateRestored(JSON.stringify(withTokens(tokens)), live)?.doc.theme.tokens as any
  const opened = (tokens: unknown) => { const d = JSON.parse(JSON.stringify(withTokens(tokens))); guardOpenedDoc(d); return d.theme.tokens as any }
  for (const [where, gate] of [['restore', restored], ['open', opened]] as const) {
    const set = gate(JSON.parse(`{"set":{"__proto__":{"type":"color","values":{"default":"#fff"}},"toString":{"type":"color","values":{"default":"#fff"}},"9bad":{"type":"color","values":{"default":"#fff"}},"ok":{"type":"color","values":{"default":"#fff"}}}}`))?.set ?? {}
    ok(Object.keys(set).join() === 'ok', `${where}: token names that are no token names, or reach into Object.prototype, are dropped (${Object.keys(set).join()})`)
    const vals = gate({ set: {
      font: { type: 'fontFamily', values: { default: 'Inter; color: red' } },
      col: { type: 'color', values: { default: 'url(https://evil.example/x)' } },
      big: { type: 'number', values: { default: 1e7 } },
      op: { type: 'opacity', values: { default: 2 } },
      good: { type: 'number', values: { default: 12 } },
    } })?.set ?? {}
    ok(!vals.font?.values.default && !vals.col?.values.default && !vals.big?.values.default && !vals.op?.values.default && vals.good?.values.default === 12,
      `${where}: values outside their type's rule are dropped (font, colour, number bound, opacity)`)
    const modes = gate(JSON.parse(`{"modes":["toString","dark"],"mode":"__proto__","set":{"c":{"type":"color","values":{"__proto__":"#000","dark":"#111"}}}}`))
    ok(!modes?.modes && modes?.mode === undefined && Object.keys(modes?.set.c.values ?? {}).join() === 'dark', `${where}: modes that reach into Object.prototype are dropped`)
    ok(!gate({ modes: Array.from({ length: 17 }, (_, i) => `m${i}`), set: { c: { type: 'number', values: { m0: 1 } } } })?.modes, `${where}: more than 16 modes are refused`)
    const huge = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`t${i}`, { type: 'number', values: { default: i } }]))
    ok(Object.keys(gate({ set: huge })?.set ?? {}).length === 500, `${where}: a set holds at most 500 tokens`)
  }
  ok(opened({}) === undefined, 'open: a token set with no set is normalised away')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
