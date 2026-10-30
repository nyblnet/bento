// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Hints: one tooltip for the whole editor chrome, the way design tools show
// them — after a short rest, then instantly while you move along a toolbar,
// on keyboard focus as well as hover, with the shortcut set apart as keys.
//
// It reads the `title` every control already carries, so no call site
// changes. The title is BORROWED for as long as the hint shows — moved to
// data-hint, which keeps the browser's own slow, unstyled tooltip from
// doubling it, with the same text standing in as the accessible name (or
// description) the title was providing — and put back on the way out, so the
// DOM is as its author wrote it except under the pointer.
// A trailing "(⇧⌘G)" — the convention the strings already use — becomes key
// chips. The slide itself is content, not chrome: nothing under the stage
// is touched.

const REST_MS = 450
/** moving from one hinted control to the next within this long skips the rest */
const WARM_MS = 300

export function mountHints(root: HTMLElement, signal: AbortSignal) {
  // the root's own document: the speaker view is another window
  const doc = root.ownerDocument
  const win = doc.defaultView!
  const tip = doc.createElement('div')
  tip.className = 'ed-tip'
  tip.setAttribute('role', 'tooltip')
  tip.hidden = true
  doc.body.appendChild(tip)
  signal.addEventListener('abort', () => tip.remove(), { once: true })

  let timer = 0
  let current: HTMLElement | null = null
  let coldAt = 0
  let pointerY: number | null = null

  /** The hinted control an event reached, adopting its title on the way. */
  const hinted = (target: EventTarget | null): HTMLElement | null => {
    // the slide is content, not chrome — on the canvas and in the show alike
    if (!(target instanceof win.Element) || target.closest('.ed-stage-scale, .ed-tip, .reveal .slides')) return null
    const el = target.closest<HTMLElement>('[title], [data-hint]')
    if (!el || !root.contains(el)) return null
    return el.getAttribute('title')?.trim() || el.dataset.hint ? el : null
  }

  /** Take the title for the length of the hint (see the header). */
  const borrow = (el: HTMLElement) => {
    const text = el.getAttribute('title')?.trim()
    if (!text) return
    el.removeAttribute('title')
    el.dataset.hint = text
    // the title was this control's accessible name (icon-only) or its
    // description (everything else); while it is away, the same text stands in
    if (el.getAttribute('aria-label')) return
    const attr = el.textContent?.trim() ? 'aria-description' : 'aria-label'
    el.setAttribute(attr, attr === 'aria-label' ? text.replace(SHORTCUT, '') : text)
    el.dataset.hintAria = attr
  }
  const giveBack = (el: HTMLElement) => {
    if (el.dataset.hint === undefined) return
    if (!el.hasAttribute('title')) el.setAttribute('title', el.dataset.hint)
    delete el.dataset.hint
    if (el.dataset.hintAria) { el.removeAttribute(el.dataset.hintAria); delete el.dataset.hintAria }
  }

  const show = (el: HTMLElement) => {
    const text = el.dataset.hint ?? el.getAttribute('title')?.trim() ?? ''
    const m = SHORTCUT.exec(text)
    // a window that repaints its body (the speaker view) took the tip with it
    if (!tip.isConnected) doc.body.appendChild(tip)
    tip.replaceChildren(m ? text.slice(0, m.index) : text)
    if (m) {
      const keys = doc.createElement('span')
      keys.className = 'ed-tip-keys'
      for (const k of m[1].split(/\s*(?:·|\/)\s*/)) {
        const kbd = doc.createElement('kbd')
        kbd.textContent = k
        keys.appendChild(kbd)
      }
      tip.appendChild(keys)
    }
    tip.hidden = false
    const r = el.getBoundingClientRect()
    const t = tip.getBoundingClientRect()
    // a tall, thin control (a panel's resize edge) is hinted beside the
    // pointer: above or below it would land on whatever heads the column
    if (r.height > 120 && pointerY !== null) {
      const right = r.right + 8 + t.width < win.innerWidth
      tip.style.left = `${right ? r.right + 8 : r.left - 8 - t.width}px`
      tip.style.top = `${Math.min(Math.max(pointerY - t.height / 2, 8), win.innerHeight - t.height - 8)}px`
      return
    }
    const below = r.bottom + 8 + t.height < win.innerHeight
    const x = Math.min(Math.max(r.left + r.width / 2 - t.width / 2, 8), win.innerWidth - t.width - 8)
    tip.style.left = `${x}px`
    tip.style.top = `${below ? r.bottom + 8 : r.top - 8 - t.height}px`
  }

  /** A hover borrows the title (the browser would show its own tooltip on top);
   *  keyboard focus leaves it alone — browsers show no native tooltip there. */
  const enter = (el: HTMLElement, byPointer: boolean) => {
    if (el === current) return
    win.clearTimeout(timer)
    if (current) giveBack(current)
    current = el
    if (byPointer) borrow(el)
    if (!tip.hidden || performance.now() - coldAt < WARM_MS) show(el)
    else timer = win.setTimeout(() => current === el && show(el), REST_MS)
  }
  const leave = () => {
    win.clearTimeout(timer)
    if (!tip.hidden) coldAt = performance.now()
    if (current) giveBack(current)
    current = null
    tip.hidden = true
  }

  const opts = { capture: true, signal }
  doc.addEventListener('pointerover', (ev) => {
    if (ev.pointerType === 'touch') return
    pointerY = ev.clientY
    const el = hinted(ev.target)
    if (el) enter(el, true)
    else if (current && !current.contains(ev.target as Node)) leave()
  }, opts)
  doc.addEventListener('focusin', (ev) => {
    pointerY = null // a keyboard hint sits by the control, not where the mouse was
    const el = hinted(ev.target)
    if (el && (ev.target as Element).matches(':focus-visible')) enter(el, false)
  }, opts)
  for (const type of ['pointerdown', 'keydown', 'focusout', 'scroll', 'wheel'] as const) {
    doc.addEventListener(type, () => { if (current) leave() }, { ...opts, passive: true })
  }
  win.addEventListener('blur', leave, { signal })
}

/** "Group (⌘G)" → "⌘G"; "Undo · redo (⌘Z · ⌘⇧Z)" → "⌘Z · ⌘⇧Z". */
// keys only — '(⇧Tab while editing)' is a sentence and stays text; a lone
// key ('(L)', '(→)', '(?)') counts, a word like '(PDF)' does not
const KEY = '(?:(?:[⌘⇧⌥⌃⌫]|Ctrl|Alt|Shift|Esc|Tab|Del|F\\d)[^()\\s]*|[A-Z0-9?←→↑↓](?![^()\\s·])|Space|Home|End|PgUp|PgDn)'
export const SHORTCUT = new RegExp(`\\s*\\((${KEY}(?:\\s*·\\s*[^()\\s]+)*)\\)\\s*$`)
