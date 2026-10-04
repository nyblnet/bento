#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The shared kernel TOOLTIP primitive — behaviour rig.
//
//   node scripts/test-ui-tooltip.ts
//
// Built ahead of a consumer (no app has a hover tooltip; see tooltip.ts), so
// these checks pin the contract we chose rather than a behaviour we found:
// shows after a delay on hover/focus, hides on leave/blur/Escape, wires
// aria-describedby, does not flash on a pointer passing through, and — the one
// that matters most — renders in document.body as a fixed element so no scroll
// container clips it. Self-contained DOM, like the other primitive rigs.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { checkThemedChains } from './lib/ui-theme-guard.ts'
const rroot = join(dirname(fileURLToPath(import.meta.url)), '..')

type Handler = (e: unknown) => void
class El {
  tag: string; children: El[] = []; parent: El | null = null
  private attrs = new Map<string, string>(); private cls = new Set<string>()
  private h = new Map<string, Handler[]>()
  hidden = false; text = ''; id = ''
  style: Record<string, string> = {}
  rect = { left: 100, top: 200, right: 180, bottom: 224, width: 80, height: 24 }
  constructor(tag: string) { this.tag = tag }
  get classList() { const c = this.cls; return { add: (x: string) => c.add(x), remove: (x: string) => c.delete(x), contains: (x: string) => c.has(x) } }
  set className(v: string) { this.cls = new Set(v.split(/\s+/).filter(Boolean)) }
  set textContent(v: string) { this.text = v }
  get textContent() { return this.text }
  setAttribute(k: string, v: string) { this.attrs.set(k, v) }
  getAttribute(k: string) { return this.attrs.get(k) ?? null }
  removeAttribute(k: string) { this.attrs.delete(k) }
  appendChild(x: El) { x.parent = this; this.children.push(x); return x }
  getBoundingClientRect() { return this.rect }
  addEventListener(t: string, fn: Handler) { this.h.set(t, [...(this.h.get(t) ?? []), fn]) }
  removeEventListener(t: string, fn: Handler) { this.h.set(t, (this.h.get(t) ?? []).filter((f) => f !== fn)) }
  fire(t: string, ev: Record<string, unknown> = {}) { for (const fn of [...(this.h.get(t) ?? [])]) fn({ preventDefault() {}, ...ev }) }
  querySelectorAll(sel: string): El[] { const out: El[] = []; const cls = sel.replace('.', ''); const walk = (n: El) => { for (const c of n.children) { if (c.cls.has(cls)) out.push(c); walk(c) } }; walk(this); return out }
}
const doc = { body: new El('body'), createElement: (t: string) => new El(t) }
;(globalThis as Record<string, unknown>).document = doc
;(globalThis as Record<string, unknown>).window = { innerHeight: 800 }

const { attachTooltip } = await import('../kernel/src/ui/tooltip.ts')

let failures = 0, checks = 0
function ok(cond: unknown, msg: string) { checks++; if (!cond) { failures++; console.error(`  ✗ ${msg}`) } }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const anchor = () => new El('button')
const theTip = () => doc.body.querySelectorAll('.bkt')[0]

// ——— shows after the delay, wired to the anchor ———
{
  const a = anchor()
  attachTooltip(a as unknown as HTMLElement, 'Save the deck', { delay: 15 })
  a.fire('mouseenter')
  ok(!theTip() || theTip().hidden, 'nothing shows before the delay')
  await wait(30)
  const tip = theTip()
  ok(tip && !tip.hidden, 'the tip shows after the delay')
  ok(tip.text === 'Save the deck', 'with the anchor’s text')
  ok(a.getAttribute('aria-describedby') === tip.id, 'the anchor is aria-describedby the tip')
  a.fire('mouseleave')
  ok(a.getAttribute('aria-describedby') === null, 'leaving clears aria-describedby immediately')
  await wait(80)
  ok(theTip().hidden, 'and the tip hides')
}

// ——— detail-10: the tip lives in the body, position fixed — no clip ———
{
  const scroller = new El('div') // a would-be scroll container
  const a = anchor(); scroller.appendChild(a)
  attachTooltip(a as unknown as HTMLElement, 'Tip', { delay: 5 })
  a.fire('mouseenter'); await wait(15)
  const tip = theTip()
  ok(tip.parent === doc.body, 'the tip is a child of document.body, NOT of the anchor’s container (so no ancestor clips it)')
  ok(tip.style.position === 'fixed', 'it is position:fixed')
  ok(tip.style.left && (tip.style.top !== 'auto' || tip.style.bottom), 'it is positioned from the anchor rect')
  a.fire('mouseleave'); await wait(80)
}

// ——— no flash: leaving before the delay never shows it ———
{
  const a = anchor()
  attachTooltip(a as unknown as HTMLElement, 'Nope', { delay: 40 })
  a.fire('mouseenter')
  await wait(10)
  a.fire('mouseleave') // before the 40ms delay
  // check at +35 (t≈45): PAST the 40ms show delay, but BEFORE the 60ms hide
  // grace — so a tip that (wrongly) showed would still be visible here. This
  // window is what makes the check catch a missing flash-guard, rather than the
  // grace timer hiding it for the wrong reason.
  await wait(35)
  ok(theTip().hidden, 'a pointer passing through (leave before delay) never shows the tip')
}

// ——— focus/blur, and Escape ———
{
  const a = anchor()
  attachTooltip(a as unknown as HTMLElement, 'Focused', { delay: 5 })
  a.fire('focus'); await wait(15)
  ok(!theTip().hidden, 'focus shows the tip (keyboard, not just hover)')
  a.fire('keydown', { key: 'Escape' }); await wait(80)
  ok(theTip().hidden, 'Escape hides it')
  ok(a.getAttribute('aria-describedby') === null, 'and clears aria')
}

// ——— singleton: many anchors, one tip element ———
{
  const a = anchor(), b = anchor()
  attachTooltip(a as unknown as HTMLElement, 'A', { delay: 5 })
  attachTooltip(b as unknown as HTMLElement, 'B', { delay: 5 })
  a.fire('mouseenter'); await wait(15); a.fire('mouseleave'); await wait(80)
  b.fire('mouseenter'); await wait(15)
  ok(doc.body.querySelectorAll('.bkt').length === 1, 'there is exactly one tip element for all anchors')
  ok(theTip().text === 'B', 'and it carries the current anchor’s text')
  b.fire('mouseleave'); await wait(80)
}

// ——— detach removes the listeners and aria ———
{
  const a = anchor()
  const detach = attachTooltip(a as unknown as HTMLElement, 'Gone', { delay: 5 })
  detach()
  a.fire('mouseenter'); await wait(20)
  ok(theTip().hidden, 'after detach, hovering the anchor does nothing')
  ok(a.getAttribute('aria-describedby') === null, 'and no aria wiring remains')
}

// ——— THEMING GUARD (shared helper) ———
{
  const appStyles = Object.fromEntries(
    ['slides', 'spaces', 'dash', 'type'].map((x) => [x, join(rroot, `${x}/src/styles.css`)]),
  )
  for (const r of checkThemedChains({
    cssPath: join(rroot, 'kernel/src/ui/tooltip.css'),
    prefix: 'bkt',
    colourProps: new Set(['ink', 'bg']),
    appStyles,
  })) ok(r.pass, r.msg)
}

console.log(failures ? `\n${failures} FAILED of ${checks}` : `\ntest-ui-tooltip: ${checks} checks OK`)
process.exit(failures ? 1 : 0)
