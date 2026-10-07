// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// SPACES' MENUS, ON THE KERNEL'S MENU. Every dropdown and every anchored menu
// in this app is a `createMenu` from kernel/src/ui/menu.ts; this file is only
// the adapter that fits the primitive to the two ways spaces opens a menu.
//
// WHY. Spaces had its own dropdown (`dropdown()`, two document listeners per
// menu, never removed) and nine anchored popovers, each installing its own
// `mousedown` away-listener. That listener was removed only when IT fired, so a
// popover closed by Escape left one behind, and the next mousedown anywhere —
// including inside the NEXT overlay — closed whatever was open. Measured on the
// built shell: Escape a block menu, open search with ⌘K, click inside the
// search card, and the search closes. None of the menus had arrow keys. The
// kernel primitive has one delegated listener pair for every menu, Escape with
// focus return, arrow/Home/End, aria-expanded, and mutual exclusion, and its
// rig (scripts/test-ui-menu.ts) proves all of it. Adopting it is how spaces
// gets those, rather than growing a second copy of each.
//
// TWO SHAPES:
//
//   barMenu      a trigger in the topbar with its popup under it — the
//                primitive exactly as it comes.
//   anchoredMenu a menu opened FROM something that is not its trigger: a row's
//                ⋯, a block's grip, a board chip. The kernel's menu is
//                positioned by CSS under its own trigger, so this mounts the
//                menu's wrapper `position: fixed` over the anchor, with the
//                trigger hidden, and places the popup against the viewport
//                (flip above when the room is there, clamp to the edges, cap the
//                height to the room it has). Below the drawer breakpoint it is a
//                bottom sheet instead, where a thumb can reach it.
//
// WHAT THE KERNEL DOES NOT HAVE, and is written down for it rather than forked
// here (working/team/notes/spaces.md): an anchored mode with viewport-aware
// placement, a close callback, and a right-aligned shortcut slot on a row. The
// first two are the MutationObserver below; the third is the <kbd> appended to
// the row the kernel returns. Each is composition over the kernel's API, not a
// copy of it.

import { createMenu, type Menu } from '../../kernel/src/ui/menu.ts'
import '../../kernel/src/ui/menu.css'

export type { Menu }

export interface Row {
  /** inline SVG for the leading icon */
  icon?: string
  label: string
  /**
   * A visible second line — only where the row has a CONSEQUENCE worth saying
   * before you press it ("Links to it become dead"). A command list is single
   * line (D2): the name is the description.
   */
  hint?: string
  /**
   * What the row does, NOT drawn: the hover tooltip (`title`, as slides' Save
   * rows) and the row's accessible description through a visually hidden
   * element, so a screen reader still hears it. The Save menu's rows use this
   * rather than `hint` since the maintainer revised D2 for that menu.
   */
  desc?: string
  /** a keyboard shortcut, shown right-aligned in the row (D8) */
  kbd?: string
  off?: boolean
  selected?: boolean
  keepOpen?: boolean
  run: () => void
}

let descSeq = 0

/** One row. Composition over the kernel's `item()`: the shortcut slot is ours. */
export function row(m: Menu, r: Row): HTMLButtonElement {
  const b = m.item(r.label, r.run, {
    icon: r.icon, hint: r.hint, off: r.off, selected: r.selected, keepOpen: r.keepOpen,
  })
  // D2's second line is the row's DESCRIPTION, not part of its name: the name
  // is the accessible name, the hint is announced through aria-describedby
  // (slides' menuLabel, #573). Without this a screen reader read name and
  // sentence as one run-on label.
  if (r.desc) {
    const d = document.createElement('span')
    d.className = 'sp-vh'
    d.id = `sp-mdesc-${++descSeq}`
    d.textContent = r.desc
    // inside the label, after the name — where slides' `.ed-sr-only` sits
    ;(b.querySelector('.bkm-body') ?? b).append(d)
    // the native tooltip on the row itself, as slides' Save rows (#573). With
    // aria-describedby present, `title` is not also read as the description.
    b.title = r.desc
    b.setAttribute('aria-label', r.label)
    b.setAttribute('aria-describedby', d.id)
  }
  const hint = b.querySelector<HTMLElement>('.bkm-hint')
  if (hint) {
    hint.id = `sp-mdesc-${++descSeq}`
    b.setAttribute('aria-label', r.label)
    b.setAttribute('aria-describedby', hint.id)
  }
  if (r.kbd) {
    const k = document.createElement('kbd')
    k.className = 'sp-mkbd'
    k.textContent = r.kbd
    b.append(k)
  }
  return b
}

/** A caption over a group of rows. Not a row: arrow keys never land on it. */
export function caption(m: Menu, text: string): HTMLElement {
  const c = document.createElement('div')
  c.className = 'sp-menu-label'
  c.setAttribute('role', 'presentation')
  c.textContent = text
  m.menu.append(c)
  return c
}

/** Anything that is not a row — a form, a note — appended as-is. */
export function extra(m: Menu, node: HTMLElement): HTMLElement {
  m.menu.append(node)
  return node
}

/**
 * Shortcut notation, in ONE place: modifiers in Apple's ⌃⌥⇧⌘ order (D8).
 * The help sheet and the menus used to disagree with each other — ⇧⌘S beside
 * ⌘⇧J in the same list — because each was typed by hand.
 */
export function keys(...parts: Array<'ctrl' | 'alt' | 'shift' | 'mod' | string>): string {
  const ORDER = ['ctrl', 'alt', 'shift', 'mod']
  const GLYPH: Record<string, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘' }
  const mods = parts.filter((p) => ORDER.includes(p)).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
  const rest = parts.filter((p) => !ORDER.includes(p))
  return mods.map((m) => GLYPH[m]).join('') + rest.join('')
}

export interface BarMenuOpts {
  icon: string
  label: string
  tip: string
  fill: (m: Menu) => void
  /** hangs off the inline-end of the bar: grow inward */
  end?: boolean
  /** a long list: scroll inside the viewport rather than run off it */
  scroll?: boolean
  className?: string
}

/** A topbar dropdown. The kernel primitive, with spaces' button face. */
export function barMenu(o: BarMenuOpts): Menu {
  let m: Menu | null = null
  m = createMenu(o.label, o.tip, {
    className: 'sp-mn' + (o.className ? ' ' + o.className : ''),
    menuClass: 'sp-mn-pop' + (o.scroll ? ' bkm-scroll' : ''),
    alignEnd: o.end,
    fill: () => { if (m) o.fill(m) },
  })
  m.trigger.classList.add('sp-btn')
  m.trigger.insertAdjacentHTML('afterbegin', o.icon)
  // the word collapses with the bar's compact tier, like every labelled button
  m.trigger.querySelector('.bkm-label')?.classList.add('sp-btnlabel')
  return m
}

export interface AnchoredOpts {
  /** the menu's accessible name */
  label: string
  /** a bottom sheet instead of an anchored popup (phone) */
  sheet?: boolean
  /** extra class on the popup */
  className?: string
  /** runs once, however the menu closed: a row, Escape, a click away, close() */
  onClose?: () => void
  /** where focus goes when the menu closes with focus inside it */
  returnFocus?: HTMLElement | null
  /** role of the popup: `menu` unless it holds a form, which is a `dialog` */
  role?: 'menu' | 'dialog' | 'listbox'
}

const GAP = 4 // slides' .ed-menu offset
const EDGE = 8

/**
 * Put the popup against the viewport. The same rules place() in editor.ts
 * followed: take the side with more room, give the popup that room, then clamp
 * it inside the edges. Coordinates are the wrapper's, which sits exactly over
 * the anchor.
 */
function placeMenu(root: HTMLElement, pop: HTMLElement, r: DOMRect): void {
  root.style.left = `${r.left}px`
  root.style.top = `${r.top}px`
  root.style.width = `${r.width}px`
  root.style.height = `${r.height}px`
  const below = innerHeight - r.bottom - GAP - EDGE
  const above = r.top - GAP - EDGE
  const useBelow = below >= above || below >= 320
  pop.style.maxHeight = `${Math.max(160, useBelow ? below : above)}px`
  pop.style.top = useBelow ? `calc(100% + ${GAP}px)` : 'auto'
  pop.style.bottom = useBelow ? 'auto' : `calc(100% + ${GAP}px)`
  // measured after the cap; clamp on the inline axis. Physical left/right, so
  // the logical inset the kernel sets is cleared first.
  pop.style.insetInlineStart = 'auto'
  pop.style.insetInlineEnd = 'auto'
  const w = pop.offsetWidth
  const rtl = getComputedStyle(root).direction === 'rtl'
  let left = rtl ? r.right - w : r.left
  if (left + w > innerWidth - EDGE) left = innerWidth - w - EDGE
  if (left < EDGE) left = EDGE
  pop.style.left = `${left - r.left}px`
  pop.style.right = 'auto'
}

/**
 * A menu opened from an element that is not its trigger. Returns the open
 * menu; `onClose` fires exactly once, whichever way it closes.
 */
export function anchoredMenu(
  anchor: HTMLElement | DOMRect,
  fill: (m: Menu) => void,
  o: AnchoredOpts,
): Menu {
  const m = createMenu('', o.label, {
    className: 'sp-mn-anchored',
    menuClass: 'sp-mn-pop bkm-scroll' + (o.sheet ? ' sp-mn-sheet' : '') + (o.className ? ' ' + o.className : ''),
  })
  m.trigger.hidden = true
  m.trigger.tabIndex = -1
  if (o.role && o.role !== 'menu') m.menu.setAttribute('role', o.role)
  m.menu.setAttribute('aria-label', o.label)
  // populate BEFORE opening: an anchored menu is built once for the one open
  fill(m)
  document.body.append(m.root)
  m.open()

  const rect = () => (anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor)
  const place = () => { if (!o.sheet) placeMenu(m.root, m.menu, rect()) }
  place()
  addEventListener('resize', place)

  // THE CLOSE CALLBACK THE PRIMITIVE DOES NOT HAVE. The kernel closes a menu
  // by taking `bkm-open` off its wrapper — on Escape, on a press outside, when
  // another menu opens, on a row. Watching that one class is the only way to
  // hear all four, so this is where the menu is torn down and focus returned.
  let done = false
  const finish = () => {
    if (done) return
    done = true
    mo.disconnect()
    removeEventListener('resize', place)
    const hadFocus = m.root.contains(document.activeElement)
    m.destroy()
    o.onClose?.()
    if (hadFocus) {
      const back = o.returnFocus ?? (anchor instanceof HTMLElement ? anchor : null)
      try { back?.focus?.() } catch { /* the anchor went with a repaint */ }
    }
  }
  const mo = new MutationObserver(() => { if (!m.isOpen) finish() })
  mo.observe(m.root, { attributes: true, attributeFilter: ['class'] })
  return m
}
