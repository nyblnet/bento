#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The shared kernel PANEL + RESIZER primitive — behaviour rig.
//
//   node scripts/test-ui-panel.ts
//
// kernel/src/ui/panel.ts replaces three hand-rolled resizable side panels (and
// stubs a fourth). What differed between the apps was, again, INVISIBLE — the
// no-animation-during-drag class, the boot-shut-below-a-width rule, the RTL
// widening direction, double-click reset, per-viewer persistence. Every check
// below guards one of those, plus the theming guarantee the menu primitive
// introduced. Self-contained DOM (no build), like scripts/test-sync-vouch.ts.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { checkThemedChains } from './lib/ui-theme-guard.ts'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ——— a DOM just big enough for panel.ts ———
type Handler = (e: unknown) => void
class El {
  tag: string
  children: El[] = []
  parent: El | null = null
  attrs = new Map<string, string>()
  styleMap = new Map<string, string>()
  private classes = new Set<string>()
  private handlers = new Map<string, Handler[]>()
  title = ''
  constructor(tag: string) { this.tag = tag }
  get classList() {
    const c = this.classes
    return {
      add: (x: string) => { c.add(x) },
      remove: (x: string) => { c.delete(x) },
      toggle: (x: string, on?: boolean) => { const v = on ?? !c.has(x); v ? c.add(x) : c.delete(x); return v },
      contains: (x: string) => c.has(x),
    }
  }
  get className() { return [...this.classes].join(' ') }
  set className(v: string) { this.classes = new Set(v.split(/\s+/).filter(Boolean)) }
  get style() { const m = this.styleMap; return { setProperty: (k: string, v: string) => m.set(k, v), getPropertyValue: (k: string) => m.get(k) ?? '' } }
  setAttribute(k: string, v: string) { this.attrs.set(k, v) }
  getAttribute(k: string) { return this.attrs.get(k) ?? null }
  append(...xs: El[]) { for (const x of xs) { x.parent = this; this.children.push(x) } }
  appendChild(x: El) { x.parent = this; this.children.push(x); return x }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this) }
  addEventListener(t: string, fn: Handler) { const a = this.handlers.get(t) ?? []; a.push(fn); this.handlers.set(t, a) }
  removeEventListener(t: string, fn: Handler) { this.handlers.set(t, (this.handlers.get(t) ?? []).filter((f) => f !== fn)) }
  fire(t: string, ev: Record<string, unknown> = {}) {
    for (const fn of this.handlers.get(t) ?? []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...ev })
  }
}
const win = new El('window')
;(globalThis as Record<string, unknown>).window = win
const docEl = new El('html')
const body = new El('body')
;(globalThis as Record<string, unknown>).document = {
  createElement: (t: string) => new El(t),
  documentElement: docEl,
  body,
}
let RTL = false
;(globalThis as Record<string, unknown>).getComputedStyle = () => ({ direction: RTL ? 'rtl' : 'ltr' })
const store = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
}
let MQ = false
const mqlListeners: Handler[] = []
;(globalThis as Record<string, unknown>).matchMedia = () => ({
  get matches() { return MQ },
  addEventListener: (_t: string, fn: Handler) => { mqlListeners.push(fn) },
  removeEventListener: () => {},
})
const setMedia = (on: boolean) => { MQ = on; for (const fn of [...mqlListeners]) fn({}) }

const { createPanel } = await import('../kernel/src/ui/panel.ts')

let failures = 0, checks = 0
function ok(cond: unknown, msg: string) { checks++; if (!cond) { failures++; console.error(`  ✗ ${msg}`) } }
function eq(msg: string, got: unknown, want: unknown) { checks++; if (got !== want) { failures++; console.error(`  ✗ ${msg}\n      got ${got} want ${want}`) } }

const mkContent = () => new El('div') as unknown as HTMLElement
const cssVar = (p: { root: { style: { getPropertyValue(k: string): string } } }) => p.root.style.getPropertyValue('--bkp-w')
type P = ReturnType<typeof createPanel>
const R = (p: P) => p.root as unknown as El
const RZ = (p: P) => p.resizer as unknown as El
const chevronOf = (p: P) => (p.resizer as unknown as El).children[0]

// ——— defaults & clamp ———
{
  const p = createPanel({ content: mkContent(), side: 'start', defaultWidth: 236, minWidth: 190, maxWidth: 520 })
  eq('boots at the default width', cssVar(p), '236px')
  ok(!p.collapsed, 'boots expanded')
  p.setWidth(1000); eq('setWidth clamps to max', p.width, 520)
  p.setWidth(10); eq('setWidth clamps to min', p.width, 190)
  p.resetWidth(); eq('resetWidth returns to default', p.width, 236)
  p.destroy()
}

// ——— drag, and the no-anim class during it ———
{
  const p = createPanel({ content: mkContent(), side: 'start', defaultWidth: 200, minWidth: 100, maxWidth: 400 })
  RZ(p).fire('mousedown', { clientX: 500 })
  ok(R(p).classList.contains('bkp-noanim'), 'the panel gets .bkp-noanim while dragging')
  win.fire('mousemove', { clientX: 560 }) // +60, start panel LTR widens right
  eq('a rightward drag widens a start panel in LTR', p.width, 260)
  win.fire('mouseup', {})
  ok(!R(p).classList.contains('bkp-noanim'), 'and loses .bkp-noanim after')
  p.destroy()
}

// ——— RTL flips the widen direction ———
{
  RTL = true
  const p = createPanel({ content: mkContent(), side: 'start', defaultWidth: 200, minWidth: 100, maxWidth: 400 })
  RZ(p).fire('mousedown', { clientX: 500 })
  win.fire('mousemove', { clientX: 560 }) // +60 physical, but RTL start panel is docked right
  eq('a rightward drag NARROWS a start panel under RTL', p.width, 140)
  win.fire('mouseup', {})
  p.destroy()
  RTL = false
}

// ——— an end panel is the mirror ———
{
  const p = createPanel({ content: mkContent(), side: 'end', defaultWidth: 200, minWidth: 100, maxWidth: 400 })
  RZ(p).fire('mousedown', { clientX: 500 })
  win.fire('mousemove', { clientX: 560 }) // +60, end panel LTR widens LEFTward → narrows on rightward
  eq('a rightward drag narrows an end panel in LTR', p.width, 140)
  win.fire('mouseup', {})
  p.destroy()
}

// ——— collapse: chevron toggles, aria flips, a collapsed panel does not drag ———
{
  const p = createPanel({ content: mkContent(), side: 'start', defaultWidth: 200, minWidth: 100, maxWidth: 400 })
  chevronOf(p).fire('click')
  ok(p.collapsed && R(p).classList.contains('bkp-collapsed'), 'the chevron collapses the panel')
  eq('aria-expanded flips', chevronOf(p).getAttribute('aria-expanded'), 'false')
  const w = p.width
  RZ(p).fire('mousedown', { clientX: 500 }); win.fire('mousemove', { clientX: 600 }); win.fire('mouseup', {})
  eq('a collapsed panel does not resize on drag', p.width, w)
  chevronOf(p).fire('click')
  ok(!p.collapsed, 'the chevron expands it again')
  p.destroy()
}

// ——— double-click resets ———
{
  const p = createPanel({ content: mkContent(), side: 'start', defaultWidth: 236, minWidth: 100, maxWidth: 400 })
  p.setWidth(300)
  RZ(p).fire('dblclick')
  eq('double-click resets to default', p.width, 236)
  p.destroy()
}

// ——— persistence: saved and restored, clamped; absent key writes nothing ———
{
  store.clear()
  const a = createPanel({ content: mkContent(), side: 'end', defaultWidth: 236, minWidth: 190, maxWidth: 520, storageKey: 'k-props' })
  a.setWidth(300); a.collapse()
  ok(store.has('k-props'), 'a panel with a key persists')
  a.destroy()
  const b = createPanel({ content: mkContent(), side: 'end', defaultWidth: 236, minWidth: 190, maxWidth: 520, storageKey: 'k-props' })
  eq('a new panel restores the saved width', b.width, 300)
  ok(b.collapsed, 'and the saved collapsed state')
  b.destroy()
  // a corrupt/oversized saved width is clamped on restore
  store.set('k-props', JSON.stringify({ width: 99999, collapsed: false }))
  const c = createPanel({ content: mkContent(), side: 'end', defaultWidth: 236, minWidth: 190, maxWidth: 520, storageKey: 'k-props' })
  eq('a saved width past max is clamped on restore', c.width, 520)
  c.destroy()
  // no key → nothing written
  const before = store.size
  const d = createPanel({ content: mkContent(), side: 'start', defaultWidth: 200, minWidth: 100, maxWidth: 400 })
  d.setWidth(250); d.collapse()
  eq('a panel with no key writes nothing', store.size, before)
  d.destroy()
}

// ——— drawer: boots shut below the width, and crossing in collapses ———
{
  MQ = true
  const p = createPanel({ content: mkContent(), side: 'end', defaultWidth: 236, minWidth: 100, maxWidth: 400 })
  ok(p.collapsed, 'a panel that boots below the drawer width boots SHUT')
  ok(R(p).classList.contains('bkp-drawer'), 'and carries .bkp-drawer')
  p.destroy()
  MQ = false
  const q = createPanel({ content: mkContent(), side: 'end', defaultWidth: 236, minWidth: 100, maxWidth: 400 })
  ok(!q.collapsed, 'above the width it boots open')
  setMedia(true)
  ok(q.collapsed && R(q).classList.contains('bkp-drawer'), 'crossing into drawer width collapses it and marks it a drawer')
  q.destroy()
}

// ——— drawer boot-shut does NOT overwrite a saved OPEN state until crossed ———
{
  store.clear(); MQ = false
  const a = createPanel({ content: mkContent(), side: 'end', defaultWidth: 236, minWidth: 100, maxWidth: 400, storageKey: 'k-d' })
  ok(!a.collapsed, 'wide: open')
  a.destroy()
  MQ = true
  const b = createPanel({ content: mkContent(), side: 'end', defaultWidth: 236, minWidth: 100, maxWidth: 400, storageKey: 'k-d' })
  ok(b.collapsed, 'below the drawer width the panel boots shut even though the saved state was open')
  b.destroy()
  MQ = false
}

// ——— onChange fires; destroy cleans up ———
{
  const p = createPanel({ content: mkContent(), side: 'start', defaultWidth: 200, minWidth: 100, maxWidth: 400 })
  let n = 0
  const off = p.onChange(() => { n++ })
  p.setWidth(250); p.toggle(); p.resetWidth()
  eq('onChange fires on width and collapse changes', n, 3)
  off(); p.setWidth(260)
  eq('unsubscribe stops it', n, 3)
  p.destroy()
  ok(R(p).parent === null || !R(p).parent, 'destroy removes the root')
}

// ——— THEMING GUARD — shared with the menu primitive's rig via
// scripts/lib/ui-theme-guard.ts. It pins one property: every colour panel.css
// paints resolves, for each of the four apps, to a token that app both defines
// and themes. `--bkp-bg` chaining --surface → --chrome is why type (which has
// --chrome, not --surface) resolves at all. ———
{
  const appStyles = Object.fromEntries(
    ['slides', 'spaces', 'dash', 'type'].map((a) => [a, join(root, `${a}/src/styles.css`)]),
  )
  for (const r of checkThemedChains({
    cssPath: join(root, 'kernel/src/ui/panel.css'),
    prefix: 'bkp',
    colourProps: new Set(['bg', 'border', 'toggle-ink', 'resizer-hover']),
    appStyles,
  })) ok(r.pass, r.msg)
}
console.log(failures ? `\n${failures} FAILED of ${checks}` : `\ntest-ui-panel: ${checks} checks OK`)
process.exit(failures ? 1 : 0)
