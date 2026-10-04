#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The shared kernel TOGGLE (switch) primitive — behaviour rig.
//
//   node scripts/test-ui-toggle.ts
//
// Built ahead of a consumer (the three "toggle" classes across the apps are
// three unrelated things, no shared switch — see toggle.ts), so these checks
// pin the contract chosen: a real role="switch" with aria-checked, click
// toggles and fires onChange, set() updates state WITHOUT firing onChange, and
// it is a <button> so the platform gives it keyboard operation. Self-contained
// DOM, like the other primitive rigs.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { checkThemedChains } from './lib/ui-theme-guard.ts'
const rroot = join(dirname(fileURLToPath(import.meta.url)), '..')

type Handler = (e: unknown) => void
class El {
  tag: string; children: El[] = []; parent: El | null = null
  private attrs = new Map<string, string>(); private cls = new Set<string>()
  private h = new Map<string, Handler[]>()
  text = ''; type = ''
  constructor(tag: string) { this.tag = tag }
  get classList() { const c = this.cls; return { add: (x: string) => c.add(x), remove: (x: string) => c.delete(x), toggle: (x: string, on?: boolean) => { const v = on ?? !c.has(x); v ? c.add(x) : c.delete(x); return v }, contains: (x: string) => c.has(x) } }
  set className(v: string) { this.cls = new Set(v.split(/\s+/).filter(Boolean)) }
  set textContent(v: string) { this.text = v }
  setAttribute(k: string, v: string) { this.attrs.set(k, v) }
  getAttribute(k: string) { return this.attrs.get(k) ?? null }
  append(...xs: El[]) { for (const x of xs) { x.parent = this; this.children.push(x) } }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null } }
  addEventListener(t: string, fn: Handler) { this.h.set(t, [...(this.h.get(t) ?? []), fn]) }
  removeEventListener(t: string, fn: Handler) { this.h.set(t, (this.h.get(t) ?? []).filter((f) => f !== fn)) }
  fire(t: string) { for (const fn of [...(this.h.get(t) ?? [])]) fn({ preventDefault() {} }) }
}
;(globalThis as Record<string, unknown>).document = { createElement: (t: string) => new El(t) }

const { createToggle } = await import('../kernel/src/ui/toggle.ts')

let failures = 0, checks = 0
function ok(cond: unknown, msg: string) { checks++; if (!cond) { failures++; console.error(`  ✗ ${msg}`) } }
const E = (x: unknown) => x as unknown as El

// ——— role, aria, label ———
{
  const t = createToggle({ label: 'Live sharing' })
  ok(E(t.control).getAttribute('role') === 'switch', 'the control is role=switch')
  ok(E(t.control).getAttribute('aria-checked') === 'false', 'aria-checked starts false')
  ok(E(t.control).getAttribute('aria-label') === 'Live sharing', 'the label is the accessible name')
  ok(E(t.control).tag.toUpperCase() === 'BUTTON', 'the control is a <button> — keyboard-operable by the platform (Space/Enter)')
  const t2 = createToggle({ label: 'On', checked: true })
  ok(E(t2.control).getAttribute('aria-checked') === 'true', 'checked:true starts aria-checked true')
  ok(E(t2.root).classList.contains('bks-on'), 'and carries the bks-on class')
}

// ——— click toggles, flips aria + class, fires onChange with the new state ———
{
  const seen: boolean[] = []
  const t = createToggle({ label: 'X', onChange: (c) => seen.push(c) })
  E(t.control).fire('click')
  ok(t.checked === true, 'a click turns it on')
  ok(E(t.control).getAttribute('aria-checked') === 'true', 'aria-checked follows')
  ok(E(t.root).classList.contains('bks-on'), 'the on-class follows')
  E(t.control).fire('click')
  ok(t.checked === false, 'a second click turns it off')
  ok(seen.join(',') === 'true,false', 'onChange fired with each new state, in order')
}

// ——— set() updates state and visuals but does NOT fire onChange ———
{
  let fired = 0
  const t = createToggle({ label: 'X', onChange: () => { fired++ } })
  t.set(true)
  ok(t.checked === true && E(t.control).getAttribute('aria-checked') === 'true', 'set(true) updates state and aria')
  ok(E(t.root).classList.contains('bks-on'), 'and the visual')
  ok(fired === 0, 'set() does NOT fire onChange (a set is the app’s doing, not the user’s)')
  t.set(false)
  ok(t.checked === false && fired === 0, 'set(false) too')
}

// ——— destroy removes the listener and the root ———
{
  let fired = 0
  const t = createToggle({ label: 'X', onChange: () => { fired++ } })
  t.destroy()
  E(t.control).fire('click')
  ok(fired === 0 && t.checked === false, 'after destroy, a click does nothing')
}

// ——— THEMING GUARD (shared helper) ———
{
  const appStyles = Object.fromEntries(
    ['slides', 'spaces', 'dash', 'type'].map((x) => [x, join(rroot, `${x}/src/styles.css`)]),
  )
  for (const r of checkThemedChains({
    cssPath: join(rroot, 'kernel/src/ui/toggle.css'),
    prefix: 'bks',
    colourProps: new Set(['ink', 'border', 'off', 'knob']),
    // 'on' is the accent track — a brand colour that legitimately does not invert
    // (dash's --accent is one value for both themes), so it is checked for
    // 'defines' only, not 'themes'.
    appStyles,
  })) ok(r.pass, r.msg)
}

console.log(failures ? `\n${failures} FAILED of ${checks}` : `\ntest-ui-toggle: ${checks} checks OK`)
process.exit(failures ? 1 : 0)
