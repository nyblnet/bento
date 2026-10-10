// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The context menu: one floating list, opened at a point, dismissed by
// anything. Deliberately dumb — it renders items and reports clicks. What the
// items ARE is decided by whoever opens it (editor.ts), because that is where
// the selection, the store and the panels live.
//
// Only ONE can be open at a time, and it is a module-level singleton rather
// than a per-caller instance: a second right-click anywhere must replace the
// first menu, including one opened by a different part of the editor.

/** A separator, or a row. `hint` is the shortcut shown greyed on the right. */
export type CtxItem =
  | 'sep'
  | {
      label: string
      run: () => void
      hint?: string
      disabled?: boolean
      /** destructive — rendered in red, and always placed last by convention */
      danger?: boolean
    }

let open: HTMLElement | null = null
let detach: (() => void) | null = null

/** Close the open menu, if any. Safe to call when nothing is open. */
export function closeCtxMenu() {
  detach?.()
  detach = null
  open?.remove()
  open = null
}

export function ctxMenuIsOpen() {
  return !!open
}

/**
 * Open a menu at a viewport point. Items with no enabled entries are dropped
 * along with any separator that would be left dangling, so callers can build a
 * list unconditionally and let the menu decide what is worth showing.
 */
export function openCtxMenu(x: number, y: number, items: CtxItem[]) {
  closeCtxMenu()
  const rows = tidy(items)
  if (!rows.length) return

  const menu = document.createElement('div')
  menu.className = 'ed-ctxmenu'
  menu.setAttribute('role', 'menu')
  for (const item of rows) {
    if (item === 'sep') {
      const s = document.createElement('div')
      s.className = 'ed-ctxmenu-sep'
      menu.appendChild(s)
      continue
    }
    const b = document.createElement('button')
    b.className = 'ed-ctxmenu-item'
    b.setAttribute('role', 'menuitem')
    if (item.danger) b.classList.add('ed-ctxmenu-danger')
    b.disabled = !!item.disabled
    const label = document.createElement('span')
    label.textContent = item.label
    b.appendChild(label)
    if (item.hint) {
      const h = document.createElement('kbd')
      h.textContent = item.hint
      b.appendChild(h)
    }
    // click, not pointerdown: the dismiss listener below is on pointerdown, and
    // acting on the press would run the item and then immediately re-close over
    // a menu that had already gone.
    b.addEventListener('click', () => {
      closeCtxMenu()
      item.run()
    })
    menu.appendChild(b)
  }

  // Measured off-screen first: the flip below needs a real size, and a menu
  // built from a variable number of rows has no size until it is in the DOM.
  menu.style.visibility = 'hidden'
  document.body.appendChild(menu)
  place(menu, x, y)
  menu.style.visibility = ''
  open = menu

  // Dismissal. Capture phase so a press anywhere closes it before that press
  // does anything else, which is what makes the menu feel modal without being
  // modal. `scroll` is captured too — a menu pinned to the viewport while the
  // canvas moves under it would point at the wrong element.
  const onDown = (ev: Event) => {
    if (menu.contains(ev.target as Node)) return
    closeCtxMenu()
  }
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation() // Escape closes THIS, not the selection behind it
      closeCtxMenu()
    }
  }
  const onScroll = () => closeCtxMenu()
  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('wheel', onScroll, true)
  document.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll)
  document.addEventListener('keydown', onKey, true)
  detach = () => {
    document.removeEventListener('pointerdown', onDown, true)
    document.removeEventListener('wheel', onScroll, true)
    document.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', onScroll)
    document.removeEventListener('keydown', onKey, true)
  }
}

/** Drop leading, trailing and doubled separators, and empty menus. */
function tidy(items: CtxItem[]): CtxItem[] {
  const out: CtxItem[] = []
  for (const it of items) {
    if (it === 'sep') {
      if (!out.length || out[out.length - 1] === 'sep') continue
      out.push(it)
      continue
    }
    out.push(it)
  }
  while (out.length && out[out.length - 1] === 'sep') out.pop()
  return out.some((i) => i !== 'sep') ? out : []
}

/**
 * Put the menu at (x, y), flipped back inside the viewport when it would hang
 * off an edge. Flipping rather than clamping keeps the pointer OUTSIDE the
 * menu: a clamped menu slides under the finger or cursor, and the first thing
 * that happens is a mis-click on whatever row landed there.
 */
function place(menu: HTMLElement, x: number, y: number) {
  const m = menu.getBoundingClientRect()
  const pad = 8
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = x
  let top = y
  if (left + m.width > vw - pad) left = Math.max(pad, x - m.width)
  if (top + m.height > vh - pad) top = Math.max(pad, y - m.height)
  // Still taller than the screen (a long menu on a short landscape phone):
  // pin it to the top and let it scroll rather than run off the bottom.
  if (m.height > vh - pad * 2) {
    top = pad
    menu.style.maxHeight = `${vh - pad * 2}px`
    menu.style.overflowY = 'auto'
  }
  menu.style.left = `${Math.round(Math.max(pad, left))}px`
  menu.style.top = `${Math.round(Math.max(pad, top))}px`
}
