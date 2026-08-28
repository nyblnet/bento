#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Which targets anim treats as ELEMENTS.
//
//   node scripts/test-anim-elements.ts
//
// WHAT THIS PROVES. anim splits targets in two: elements get style channels
// (opacity, transform…), everything else is a plain-object tween used for
// count-up state. The split ran on `instanceof HTMLElement || SVGElement`,
// which silently excludes MathML — <mi>, <mn> and <mo> are MathMLElement.
//
// Nothing errored. Formula symbols fell into the plain-object branch, where
// `opacity` was assigned as a JS PROPERTY of the node and no style was ever
// written. They still moved, because the symbol morph writes style.transform
// itself rather than going through a channel, so exactly one thing was
// missing: new terms in a formula appeared instantly while new code tokens
// faded in next to them. Visible only when both ran side by side.

import { anim } from '../kernel/src/anim.ts'

const FAILS: string[] = []
const check = (name: string, cond: boolean) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`)
}

// Minimal DOM stand-ins: anim only needs instanceof Element and a style bag.
class FakeElement { style: Record<string, string> = {} }
class FakeHTML extends FakeElement {}
class FakeSVG extends FakeElement {}
class FakeMathML extends FakeElement {}     // <mi>, <mn>, <mo>
const g: any = globalThis
g.Element = FakeElement
g.HTMLElement = FakeHTML
g.SVGElement = FakeSVG
g.MathMLElement = FakeMathML
g.getComputedStyle = () => ({ opacity: '1', transform: 'none', display: 'block math' })
// anim starts a rAF ticker even in manual mode; headless needs a stub.
g.requestAnimationFrame = () => 0
g.cancelAnimationFrame = () => {}

anim.setManual(true)

const fadeIn = (el: any) => {
  anim.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 1 })
  anim.tick(0.001)
}

// 1. THE REGRESSION — a MathML token must receive a STYLE, not a property.
{
  const mi = new FakeMathML()
  fadeIn(mi)
  check('MathML token gets style.opacity', typeof mi.style.opacity === 'string')
  check('MathML token is NOT assigned a bare property', (mi as any).opacity === undefined)
  anim.tick(1.2)
  check('MathML token lands at its to-value', Math.abs(parseFloat(mi.style.opacity) - 1) < 0.01)
}

// 2. The two kinds that always worked keep working.
for (const [name, El] of [['HTMLElement', FakeHTML], ['SVGElement', FakeSVG]] as const) {
  const el: any = new (El as any)()
  fadeIn(el)
  check(`${name} gets style.opacity`, typeof el.style.opacity === 'string')
}

// 3. NEGATIVE CONTROL — plain objects must still tween as properties, or the
//    count-up state animation breaks.
{
  const state: any = { p: 0 }
  anim.fromTo(state, { p: 0 }, { p: 1, duration: 1 })
  anim.tick(0.5)
  check('plain object still tweens its property', state.p > 0 && state.p <= 1)
  check('plain object gets no style bag', state.style === undefined)
}

// 4. An Element WITHOUT a style bag must not be mistaken for an animatable
//    element (defensive: the check is `instanceof Element && 'style' in t`).
{
  class Bare extends FakeElement {}
  const bare: any = new Bare()
  delete (bare as any).style
  let threw = false
  try { anim.fromTo(bare, { opacity: 0 }, { opacity: 1, duration: 1 }); anim.tick(0.1) }
  catch { threw = true }
  check('style-less Element does not throw', !threw)
}

anim.setManual(false)
console.log(FAILS.length ? `\n${FAILS.length} FAILED` : '\nall passed')
process.exit(FAILS.length ? 1 : 0)
