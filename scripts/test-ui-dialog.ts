#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The shared kernel MODAL DIALOG primitive — behaviour rig.
//
//   node scripts/test-ui-dialog.ts
//
// kernel/src/ui/dialog.ts is the real consolidation of tier 3: all four apps
// build their About dialog on a per-app overlay. Every check guards behaviour
// that was in one app and not the others, or in none:
//   - focus captured on open and RESTORED to the opener on close (spaces);
//   - Escape closes and does NOT fall through — the dialog's handler is
//     capture-phase on the document (spaces' hard-won rule);
//   - the backdrop dismisses, a click on the card does not, and a confirm
//     dialog can refuse backdrop dismissal;
//   - a real focus TRAP (Tab wraps within the card) — no app had one;
//   - role=dialog / aria-modal / aria-labelledby;
//   - close removes the overlay AND both its listeners (no leak).
// Self-contained DOM, like scripts/test-sync-vouch.ts and test-ui-panel.ts.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { checkThemedChains } from './lib/ui-theme-guard.ts'
const rroot = join(dirname(fileURLToPath(import.meta.url)), '..')

type Handler = (e: unknown) => void
class El {
  tag: string
  children: El[] = []
  parent: El | null = null
  private attrs = new Map<string, string>()
  private classes = new Set<string>()
  private bub = new Map<string, Handler[]>()
  tabIndex = -1
  text = ''
  offsetParent: unknown = {}
  constructor(tag: string) { this.tag = tag }
  get classList() { const c = this.classes; return { add: (x: string) => c.add(x), remove: (x: string) => c.delete(x), contains: (x: string) => c.has(x) } }
  set className(v: string) { this.classes = new Set(v.split(/\s+/).filter(Boolean)) }
  get className() { return [...this.classes].join(' ') }
  set textContent(v: string) { this.text = v }
  setAttribute(k: string, v: string) { this.attrs.set(k, v) }
  getAttribute(k: string) { return this.attrs.get(k) ?? null }
  set id(v: string) { this.attrs.set('id', v) }
  get id() { return this.attrs.get('id') ?? '' }
  appendChild(x: El) { x.parent = this; this.children.push(x); return x }
  append(...xs: El[]) { for (const x of xs) this.appendChild(x) }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null } }
  contains(x: El | null) { for (let n = x; n; n = n.parent) if (n === this) return true; return false }
  addEventListener(t: string, fn: Handler) { this.bub.set(t, [...(this.bub.get(t) ?? []), fn]) }
  removeEventListener(t: string, fn: Handler) { this.bub.set(t, (this.bub.get(t) ?? []).filter((f) => f !== fn)) }
  listenerCount(t: string) { return (this.bub.get(t) ?? []).length }
  fire(t: string, target: El) { for (const fn of [...(this.bub.get(t) ?? [])]) fn({ target, preventDefault() {}, stopPropagation() {} }) }
  focus() { doc.activeElement = this }
  private descend(out: El[]) { for (const c of this.children) { out.push(c); c.descend(out) } }
  querySelectorAll(_sel: string): El[] {
    const all: El[] = []; this.descend(all)
    return all.filter((e) => ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(e.tag.toUpperCase()) || e.tabIndex >= 0)
  }
}
class Doc {
  body = new El('body')
  activeElement: El | null = null
  private cap = new Map<string, Handler[]>()
  private bub = new Map<string, Handler[]>()
  createElement(t: string) { return new El(t) }
  addEventListener(t: string, fn: Handler, capture?: boolean) { const m = capture ? this.cap : this.bub; m.set(t, [...(m.get(t) ?? []), fn]) }
  removeEventListener(t: string, fn: Handler, capture?: boolean) { const m = capture ? this.cap : this.bub; m.set(t, (m.get(t) ?? []).filter((f) => f !== fn)) }
  capCount(t: string) { return (this.cap.get(t) ?? []).length }
  fireKey(key: string, shiftKey = false) {
    let stopped = false
    const ev = { key, shiftKey, preventDefault() {}, stopPropagation() { stopped = true } }
    for (const fn of [...(this.cap.get('keydown') ?? [])]) { fn(ev); if (stopped) return }
    for (const fn of [...(this.bub.get('keydown') ?? [])]) fn(ev)
  }
}
const doc = new Doc()
;(globalThis as Record<string, unknown>).document = doc

const { createDialog } = await import('../kernel/src/ui/dialog.ts')

let failures = 0, checks = 0
function ok(cond: unknown, msg: string) { checks++; if (!cond) { failures++; console.error(`  ✗ ${msg}`) } }
function eq(msg: string, got: unknown, want: unknown) { checks++; if (got !== want) { failures++; console.error(`  ✗ ${msg}\n      got ${got} want ${want}`) } }
const E = (x: unknown) => x as unknown as El
const content = () => new El('div') as unknown as HTMLElement
const btn = (label: string) => { const b = new El('button'); b.textContent = label; return b as unknown as HTMLElement }

// ——— aria + structure ———
{
  const d = createDialog({ title: 'About', content: content(), actions: [btn('OK'), btn('Cancel')] })
  eq('card is role=dialog', E(d.card).getAttribute('role'), 'dialog')
  eq('card is aria-modal', E(d.card).getAttribute('aria-modal'), 'true')
  ok(E(d.card).getAttribute('aria-labelledby'), 'a titled dialog is aria-labelledby')
  ok(E(d.card).querySelectorAll('button').length >= 2, 'the actions row is rendered')
  const d2 = createDialog({ label: 'Rename', content: content() })
  eq('an untitled dialog uses aria-label', E(d2.card).getAttribute('aria-label'), 'Rename')
}

// ——— open mounts + focuses in; close unmounts + restores ———
{
  const opener = new El('button'); doc.activeElement = opener
  const first = btn('First')
  const c = content(); E(c).appendChild(E(first))
  const d = createDialog({ title: 'T', content: c })
  d.open()
  ok(doc.body.contains(E(d.root)), 'open mounts the overlay')
  eq('focus moves to the first focusable', doc.activeElement, E(first))
  ok(d.isOpen, 'isOpen true')
  d.close()
  ok(!doc.body.contains(E(d.root)), 'close unmounts the overlay')
  eq('focus is restored to the opener', doc.activeElement, opener)
}

// ——— Escape closes, capture-phase, no fall-through ———
{
  let bubbleSaw = false
  const probe = () => { bubbleSaw = true }
  doc.addEventListener('keydown', probe) // an "editor" listener on the bubble phase
  const d = createDialog({ title: 'T', content: content() })
  d.open()
  doc.fireKey('Escape')
  ok(!d.isOpen, 'Escape closes the dialog')
  ok(!bubbleSaw, 'the capture-phase Escape does NOT reach a bubble listener behind it')
  doc.removeEventListener('keydown', probe)
}

// ——— backdrop dismisses; the card does not; and it can be refused ———
{
  const d = createDialog({ title: 'T', content: content() })
  d.open()
  E(d.card).fire('mousedown', E(d.card)) // wrong target: a click inside the card
  // the dialog listens on root; fire on root with target=card
  E(d.root).fire('mousedown', E(d.card))
  ok(d.isOpen, 'a mousedown on the card does not dismiss')
  E(d.root).fire('mousedown', E(d.root)) // target is the scrim itself
  ok(!d.isOpen, 'a mousedown on the backdrop dismisses')

  const d2 = createDialog({ title: 'Confirm', content: content(), dismissOnBackdrop: false })
  d2.open()
  E(d2.root).fire('mousedown', E(d2.root))
  ok(d2.isOpen, 'a dialog with dismissOnBackdrop:false ignores the backdrop')
  d2.close()
}

// ——— the focus trap: Tab wraps within the card ———
{
  const a = btn('A'), b = btn('B'), c = btn('C')
  const body = content(); E(body).append(E(a), E(b), E(c))
  const d = createDialog({ title: 'T', content: body })
  d.open()
  E(c).focus() // last
  doc.fireKey('Tab')
  eq('Tab off the last focusable wraps to the first', doc.activeElement, E(a))
  E(a).focus() // first
  doc.fireKey('Tab', true) // shift+Tab
  eq('Shift+Tab off the first wraps to the last', doc.activeElement, E(c))
  d.close()
}

// ——— close cleans up: overlay gone, document listener removed, onClose fired ———
{
  const before = doc.capCount('keydown')
  let closed = 0
  const d = createDialog({ title: 'T', content: content(), onClose: () => { closed++ } })
  d.open()
  eq('open adds one capture-phase keydown listener', doc.capCount('keydown') - before, 1)
  d.close()
  eq('close removes it (no leak)', doc.capCount('keydown'), before)
  eq('onClose fired once', closed, 1)
  d.close()
  eq('a second close is a no-op', closed, 1)
}

// ——— THEMING GUARD (shared helper) ———
{
  const appStyles = Object.fromEntries(
    ['slides', 'spaces', 'dash', 'type'].map((a) => [a, join(rroot, `${a}/src/styles.css`)]),
  )
  for (const r of checkThemedChains({
    cssPath: join(rroot, 'kernel/src/ui/dialog.css'),
    prefix: 'bkd',
    colourProps: new Set(['bg', 'ink', 'body-ink', 'border']),
    appStyles,
  })) ok(r.pass, r.msg)
}

console.log(failures ? `\n${failures} FAILED of ${checks}` : `\ntest-ui-dialog: ${checks} checks OK`)
process.exit(failures ? 1 : 0)
