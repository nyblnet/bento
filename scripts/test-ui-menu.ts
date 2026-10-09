#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The shared kernel MENU primitive — behaviour rig.
//
//   node scripts/test-ui-menu.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. `kernel/src/ui/menu.ts` replaces four hand-rolled dropdowns
// with one, and the case for doing that was never bytes — it was that the
// INVISIBLE behaviour differed in every app and no app had all of it. Every
// check below guards a gap that is real in the tree today:
//
//   1. ARIA. Three of the four apps publish nothing. `aria-haspopup` appears
//      once in spaces and nowhere else; `aria-expanded` is absent from slides
//      and dash entirely. A menu that does not say it is a menu, or whether it
//      is open, is a menu a screen reader cannot describe.
//   2. OUTSIDE-PRESS DISMISSAL. slides builds eight dropdowns; two call its
//      `closeOnOutsidePress` helper, one hand-rolls the same listener inline,
//      and five have no dismissal at all — they stay open until you click the
//      trigger again.
//   3. ESCAPE. slides has no Escape handling on any dropdown. The 74 `Escape`
//      matches in its source are dialogs and overlays.
//   4. FOCUS RETURN. Escaping a menu into `document.body` loses a keyboard
//      user's place. Focus goes back to the trigger.
//   5. ARROW-KEY NAVIGATION. NO app has it. A menu you can open with the
//      keyboard and then not move through is a menu you are not inside.
//   6. MUTUAL EXCLUSION. Only dash shuts the other menus when one opens; the
//      others will happily overlap two popups.
//   7. THE LISTENER LEAK. slides and spaces both add document listeners PER
//      DROPDOWN and remove none — spaces adds two. A long-lived editor
//      accumulates a listener for every menu it has ever built, including ones
//      whose elements are long gone. This rig asserts the count directly,
//      because it is the kind of regression that is invisible until a profile.
//   8. ROWS REBUILT ON OPEN. A row's label can be a function of state — "Hide
//      comments" becomes "Show comments" — and rendering it once at mount
//      leaves it permanently wrong after the first use. Type hit this and
//      wrote `refreshMenuLabels` for it.
//   9. A NESTED MENU IS NOT PART OF THE OUTER ONE. Phone chrome demotes whole
//      dropdown widgets into a ⋯ list, so a bare descendant query walks into
//      the nested popup — which is how slides' ⋯ once came up with the entire
//      language list already unrolled inside it.

import { fileURLToPath } from 'node:url'
import { installDom, fireDoc } from './lib/dash-dom.ts'
import { checkThemedChains } from './lib/ui-theme-guard.ts'

const { doc } = installDom()
const bar = doc.createElement('div')
doc.body.appendChild(bar)

const { createMenu, closeAllMenus } = await import('../kernel/src/ui/menu.ts')

let failures = 0
let checks = 0
function ok(what: string, cond: unknown): void {
  checks++
  if (cond) return
  failures++
  console.error(`  FAIL  ${what}`)
}
function eq(what: string, got: unknown, want: unknown): void {
  checks++
  if (got === want) return
  failures++
  console.error(`  FAIL  ${what}\n        got  ${String(got)}\n        want ${String(want)}`)
}

const click = (el: unknown): void =>
  (el as { dispatchEvent(e: unknown): void }).dispatchEvent({
    type: 'click', preventDefault() {}, stopPropagation() {},
  })
const key = (k: string): void =>
  fireDoc(doc, 'keydown', { key: k, preventDefault() {}, stopPropagation() {} })
const triggerKey = (el: unknown, k: string): void =>
  (el as { dispatchEvent(e: unknown): void }).dispatchEvent({
    type: 'keydown', key: k, preventDefault() {}, stopPropagation() {},
  })
const pressOutside = (): void => fireDoc(doc, 'pointerdown', { target: doc.body })
// deno-lint-ignore no-explicit-any
const A = (el: unknown, k: string): string | null => (el as any).getAttribute(k)

// ————— 1. structure and ARIA —————
{
  const m = createMenu('Insert', 'Insert an element')
  bar.appendChild(m.root as never)
  eq('trigger announces a menu', A(m.trigger, 'aria-haspopup'), 'menu')
  eq('trigger starts collapsed', A(m.trigger, 'aria-expanded'), 'false')
  eq('trigger carries its name', A(m.trigger, 'aria-label'), 'Insert an element')
  eq('popup is a menu', A(m.menu, 'role'), 'menu')

  const row = m.item('Picture', () => {})
  eq('a row is a menuitem', A(row, 'role'), 'menuitem')

  const off = m.item('Redo', () => {}, { off: true })
  eq('an unrunnable row says so', A(off, 'aria-disabled'), 'true')
  const sel = m.item('Board', () => {}, { selected: true })
  eq('the current choice says so', A(sel, 'aria-current'), 'true')
  ok('a separator is not an item', A(m.separator(), 'role') === 'separator')

  click(m.trigger)
  ok('clicking the trigger opens it', m.isOpen)
  eq('open is published', A(m.trigger, 'aria-expanded'), 'true')
  click(m.trigger)
  ok('clicking again closes it', !m.isOpen)
  eq('closed is published', A(m.trigger, 'aria-expanded'), 'false')
  m.destroy()
}

// ————— 2. outside press dismisses; inside press does not —————
{
  const m = createMenu('File', 'File')
  bar.appendChild(m.root as never)
  const row = m.item('Save', () => {})
  m.open()
  fireDoc(doc, 'pointerdown', { target: row })
  ok('a press INSIDE the menu leaves it open', m.isOpen)
  pressOutside()
  ok('a press outside dismisses it', !m.isOpen)
  m.destroy()
}

// ————— 3/4. Escape closes, and focus goes back to the trigger —————
{
  const m = createMenu('View', 'View')
  bar.appendChild(m.root as never)
  const row = m.item('Zoom', () => {})
  m.open()
  ;(row as unknown as { focus(): void }).focus()
  key('Escape')
  ok('Escape closes the menu', !m.isOpen)
  eq('focus returns to the trigger', doc.activeElement, m.trigger)
  m.destroy()
}

// ————— 5. arrow-key navigation, which no app has —————
{
  const m = createMenu('Go', 'Go')
  bar.appendChild(m.root as never)
  const a = m.item('First', () => {})
  const dead = m.item('Unavailable', () => {}, { off: true })
  const c = m.item('Last', () => {})

  triggerKey(m.trigger, 'ArrowDown')
  ok('ArrowDown on a closed trigger opens it', m.isOpen)
  eq('…and lands on the first row', doc.activeElement, a)

  key('ArrowDown')
  eq('ArrowDown skips the disabled row', doc.activeElement, c)
  key('ArrowDown')
  eq('ArrowDown wraps to the top', doc.activeElement, a)
  key('ArrowUp')
  eq('ArrowUp wraps to the bottom', doc.activeElement, c)
  key('Home')
  eq('Home goes to the first row', doc.activeElement, a)
  key('End')
  eq('End goes to the last row', doc.activeElement, c)
  ok('the disabled row was never focused', doc.activeElement !== dead)
  m.destroy()
}

// ————— 6. mutual exclusion —————
{
  const one = createMenu('One', 'One')
  const two = createMenu('Two', 'Two')
  bar.append(one.root as never, two.root as never)
  one.open()
  two.open()
  ok('opening the second closes the first', !one.isOpen)
  ok('the second is open', two.isOpen)
  closeAllMenus()
  ok('closeAllMenus shuts everything', !two.isOpen)
  one.destroy()
  two.destroy()
}

// ————— 7. THE LISTENER LEAK —————
{
  const before = {
    down: doc.docListeners.get('pointerdown')?.length ?? 0,
    key: doc.docListeners.get('keydown')?.length ?? 0,
  }
  const menus = Array.from({ length: 8 }, (_, i) => createMenu(`M${i}`, `M${i}`))
  for (const m of menus) bar.appendChild(m.root as never)
  eq('eight menus install ONE pointerdown listener',
    (doc.docListeners.get('pointerdown')?.length ?? 0) - before.down, 1)
  eq('eight menus install ONE keydown listener',
    (doc.docListeners.get('keydown')?.length ?? 0) - before.key, 1)

  for (const m of menus) m.destroy()
  eq('destroying them all removes the pointerdown listener',
    doc.docListeners.get('pointerdown')?.length ?? 0, before.down)
  eq('destroying them all removes the keydown listener',
    doc.docListeners.get('keydown')?.length ?? 0, before.key)

  // destroy() twice must not double-remove somebody else's listener
  menus[0].destroy()
  eq('a second destroy is a no-op', doc.docListeners.get('keydown')?.length ?? 0, before.key)
}

// ————— 8. rows are rebuilt every time it opens —————
{
  let hidden = false
  const m = createMenu('More', 'More', {
    fill: (menu, close) => {
      const b = doc.createElement('button')
      b.className = 'bkm-item'
      b.textContent = hidden ? 'Show comments' : 'Hide comments'
      b.addEventListener('click', () => { hidden = !hidden; close() })
      menu.appendChild(b as never)
    },
  })
  bar.appendChild(m.root as never)
  m.open()
  eq('first open reads the state', m.menu.textContent, 'Hide comments')
  click(m.menu.querySelector('.bkm-item'))
  ok('choosing the row closed the menu', !m.isOpen)
  m.open()
  eq('second open re-reads the state', m.menu.textContent, 'Show comments')
  m.destroy()
}

// ————— choosing a row closes, unless it asks not to —————
{
  const m = createMenu('Act', 'Act')
  bar.appendChild(m.root as never)
  let ran = 0
  const once = m.item('Run', () => { ran++ })
  const sticky = m.item('Toggle', () => { ran++ }, { keepOpen: true })
  const dead = m.item('Nope', () => { ran++ }, { off: true })

  m.open()
  click(once)
  eq('the row ran', ran, 1)
  ok('choosing a row closes the menu', !m.isOpen)

  m.open()
  click(sticky)
  eq('a keepOpen row ran', ran, 2)
  ok('a keepOpen row leaves the menu up', m.isOpen)

  click(dead)
  eq('a disabled row does NOT run', ran, 2)
  m.destroy()
}

// ————— 9. a nested menu's rows are not the outer menu's —————
{
  const outer = createMenu('⋯', 'More')
  bar.appendChild(outer.root as never)
  const mine = outer.item('Mine', () => {})
  const inner = createMenu('Language', 'Language')
  outer.menu.appendChild(inner.root as never)
  inner.item('Deutsch', () => {})
  inner.item('Français', () => {})

  outer.open()
  triggerKey(outer.trigger, 'ArrowDown')
  key('End')
  eq('End stops at the outer menu\'s own last row', doc.activeElement, mine)
  outer.destroy()
  inner.destroy()
}

// ————— 10. THE THEMING GUARD — every colour chain resolves, for each of the
// four apps, to a token that app both DEFINES and THEMES. Shared with the panel
// primitive's rig through scripts/lib/ui-theme-guard.ts; that file states what
// the one property is and why. type having --field where the others have
// --surface is the case that first made this a guard rather than a comment.
{
  const appStyles = Object.fromEntries(
    ['slides', 'spaces', 'dash', 'type'].map((a) => [a, fileURLToPath(new URL(`../${a}/src/styles.css`, import.meta.url))]),
  )
  for (const r of checkThemedChains({
    cssPath: fileURLToPath(new URL('../kernel/src/ui/menu.css', import.meta.url)),
    prefix: 'bkm',
    colourProps: new Set(['bg', 'border', 'ink', 'hover', 'ico', 'focus']),
    exempt: new Set(['shadow']),
    appStyles,
  })) ok(r.msg, r.pass)
}

console.log(failures ? `\ntest-ui-menu: ${failures} FAILED of ${checks}` : `test-ui-menu: ${checks} checks OK`)
process.exit(failures ? 1 : 0)
