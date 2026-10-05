// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE SHARED MENU / DROPDOWN PRIMITIVE — the first of the kernel UI primitives.
//
// WHY THIS EXISTS. Four apps had four dropdowns, and they are one design copied
// four times. The tell is the offset from the trigger: slides `calc(100% + 4px)`,
// spaces `+5px`, dash `+6px`, type `+6px`. Nobody designed 4, 5, 6, 6 — that is
// copy-paste-and-tweak, and it is history rather than intent.
//
// The cost was never bytes. Each app is one self-contained file, so shared code
// is bundled into each anyway and this primitive may well make the shells
// slightly BIGGER. What four copies actually cost is that no piece of hard-won
// knowledge about menus has anywhere to live. CLAUDE.md's hard-won details 9 and
// 10 — a flex item's z-index is a CEILING that caps every descendant, and
// `overflow-y: auto` also clips HORIZONTALLY — were paid for by slides, and
// reached spaces and dash only because each of them independently hit the same
// wall. Type records only one of the two. Three teams bought the same two
// lessons. A shared primitive is the only place that knowledge can live once.
//
// WHAT EACH APP CONTRIBUTED, because "slides is the basis" is true of the CSS
// and false of the behaviour, and the difference is the whole point:
//
//   slides  the richest STRUCTURE — the split button, and the phone treatment
//           where a folded bar scrolls and its menus go `position: fixed`
//           against `--ed-bar-bottom` to escape the scroller's clip. Also the
//           WEAKEST behaviour of the four: of its eight dropdowns, five have no
//           outside-press dismissal at all, one hand-rolls it inline, two call a
//           helper — and not one of them closes on Escape or carries a single
//           `aria-haspopup` or `aria-expanded`.
//   dash    the best BEHAVIOUR — one delegated listener pair for every menu in
//           the app rather than a fresh pair per instance, mutual exclusion
//           (opening one shuts the others), Escape, and dismiss-on-choose.
//   spaces  the only real ACCESSIBILITY — `aria-haspopup`, `aria-expanded`,
//           `role=menu`/`menuitem`, `aria-current` for a selected row and
//           `aria-disabled` for a row that exists but cannot run right now.
//           Also the only viewport-aware placement (`place()`), and the phone
//           bottom-sheet.
//   type    the thinnest, and the one that shows what copying costs: it hides
//           with the `hidden` attribute rather than a state class (a fifth
//           mechanism), hardcodes its radius and shadow instead of using
//           tokens, and paints on `--field` where the other three use
//           `--surface`.
//
// So this primitive takes dash's delegation, spaces' semantics, and slides'
// structure — and adds the one thing NO app has: arrow-key navigation. A menu
// you can open with the keyboard and then not move through is a menu a keyboard
// user is not actually inside.
//
// WHAT THIS DELIBERATELY DOES NOT DECIDE. The four apps disagree on token
// VALUES — dash has diverged forward with `--line-strong`, `--shadow-pop`,
// `--radius-lg` and a `light-dark()` dark mode, against the other three's
// `--line`, a literal shadow and `--radius`. Which way that resolves is the
// maintainer's ruling and it is tier 4 of this project, not this file's to make.
// So every value here reads through a `--bkm-*` custom property whose fallback
// chain lands on whatever the host app already defines (see menu.css). An app
// adopting this primitive keeps the look it has today; only the structure and
// the behaviour are shared. The two places that could not be deferred are the
// trigger offset and the stacking level, where a single value had to be picked:
// 6px and 60, each the majority of the four, each overridable per app.

/** A row in a menu. `off` is a command that exists but cannot run right now;
 *  `selected` is the choice a view is currently on. They are different things —
 *  spaces learned that when they arrived as two separate 5th parameters on two
 *  branches — and a row may be neither. */
export interface MenuItemOpts {
  /** Inline SVG (or any markup) for the row's leading icon. */
  icon?: string
  /** Secondary line under the label. */
  hint?: string
  /** Present but not runnable: dimmed, unfocusable, announced `aria-disabled`. */
  off?: boolean
  /** The option currently in force: announced `aria-current`. */
  selected?: boolean
  /** Skip the default "choosing a row closes the menu". */
  keepOpen?: boolean
}

export interface MenuOpts {
  /** Extra classes for the wrapper, e.g. an app's own `ed-split`. */
  className?: string
  /** Extra classes for the popup itself, e.g. an app's `ed-share-pop`. */
  menuClass?: string
  /** Anchor the popup to the end of the trigger rather than the start. Used by
   *  a menu that hangs off a control near the inline-end edge, where a
   *  start-anchored popup grows off the screen. */
  alignEnd?: boolean
  /** Rebuild the rows every time it opens. A row's label can be a function of
   *  state — "Hide comments" becomes "Show comments" — and rendering it once at
   *  mount leaves it permanently wrong after the first use. */
  fill?: (menu: HTMLElement, close: () => void) => void
}

export interface Menu {
  /** The positioned wrapper. Put this in the bar. */
  readonly root: HTMLElement
  /** The button that opens it. */
  readonly trigger: HTMLButtonElement
  /** The popup. Append rows here, or let `fill` do it. */
  readonly menu: HTMLElement
  readonly isOpen: boolean
  open(): void
  close(): void
  toggle(): void
  /** Build a row. Appends to the popup unless `into` says otherwise. */
  item(label: string, onClick: () => void, opts?: MenuItemOpts): HTMLButtonElement
  /** A hairline between groups of rows. */
  separator(): HTMLElement
  /** Drop the wrapper and forget this menu. Safe to call twice. */
  destroy(): void
}

const OPEN = 'bkm-open'

/** Every live menu, so one document listener can serve all of them.
 *
 *  This is dash's model and it is the correct one. slides and spaces both add a
 *  `document.addEventListener` (two, in spaces' case) per dropdown and remove
 *  neither, so a long-lived editor accumulates a listener for every menu it has
 *  ever built — including menus whose elements are long gone. Here the document
 *  listeners are installed once, on the first menu, and removed again when the
 *  last one is destroyed. */
const live = new Set<MenuState>()

interface MenuState {
  root: HTMLElement
  trigger: HTMLButtonElement
  menu: HTMLElement
  close(): void
}

let wired = false

function onDocPointerDown(ev: Event): void {
  const target = ev.target as Node | null
  for (const m of live) {
    if (!m.root.classList.contains(OPEN)) continue
    if (target && m.root.contains(target)) continue
    m.close()
  }
}

function onDocKeyDown(ev: KeyboardEvent): void {
  const open = [...live].find((m) => m.root.classList.contains(OPEN))
  if (!open) return
  if (ev.key === 'Escape') {
    ev.stopPropagation()
    open.close()
    // Focus goes back to the trigger, not to nowhere. Escaping a menu into
    // `document.body` is how a keyboard user loses their place entirely.
    open.trigger.focus()
    return
  }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Home' || ev.key === 'End') {
    const rows = focusableRows(open.menu)
    if (!rows.length) return
    ev.preventDefault()
    const at = rows.indexOf(document.activeElement as HTMLElement)
    let next: number
    if (ev.key === 'Home') next = 0
    else if (ev.key === 'End') next = rows.length - 1
    else if (ev.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % rows.length
    else next = at < 0 ? rows.length - 1 : (at - 1 + rows.length) % rows.length
    rows[next].focus()
  }
}

/** Rows a keyboard may land on: not the disabled ones, and not a nested menu's
 *  rows. A demoted widget's popup renders INSIDE the ⋯ list on a phone (see
 *  menu.css), so a bare descendant query would walk into it. */
function focusableRows(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>('.bkm-item')].filter(
    (b) => b.getAttribute('aria-disabled') !== 'true' && b.closest('.bkm-menu') === menu,
  )
}

function wire(): void {
  if (wired) return
  wired = true
  document.addEventListener('pointerdown', onDocPointerDown)
  document.addEventListener('keydown', onDocKeyDown)
}

function unwire(): void {
  if (!wired || live.size) return
  wired = false
  document.removeEventListener('pointerdown', onDocPointerDown)
  document.removeEventListener('keydown', onDocKeyDown)
}

/**
 * Build a dropdown menu.
 *
 * `label` may be empty for an icon-only trigger, but `tip` never is: an
 * icon-only control leans on its `title` for its name, and that name is also
 * what `aria-label` publishes.
 */
export function createMenu(label: string, tip: string, opts: MenuOpts = {}): Menu {
  const root = document.createElement('div')
  root.className = 'bkm' + (opts.className ? ' ' + opts.className : '')

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'bkm-trigger'
  trigger.title = tip
  trigger.setAttribute('aria-label', tip)
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-expanded', 'false')
  if (label) {
    // The word is a SPAN, not a bare text node, so a narrow bar can drop the
    // label and keep the icon. Both slides and spaces arrived at this
    // independently; it is the only way to collapse a labelled control without
    // also losing it.
    const span = document.createElement('span')
    span.className = 'bkm-label'
    span.textContent = label
    trigger.appendChild(span)
  }

  const menu = document.createElement('div')
  menu.className = 'bkm-menu' + (opts.menuClass ? ' ' + opts.menuClass : '')
  menu.setAttribute('role', 'menu')
  if (opts.alignEnd) root.classList.add('bkm-end')

  let dead = false

  const state: MenuState = {
    root,
    trigger,
    menu,
    close(): void {
      root.classList.remove(OPEN)
      trigger.setAttribute('aria-expanded', 'false')
    },
  }

  const open = (): void => {
    if (dead) return
    // Mutual exclusion: opening one menu shuts every other. Without it a bar
    // ends up with two popups overlapping each other, which dash fixed and the
    // other three did not.
    for (const m of live) if (m !== state) m.close()
    if (opts.fill) {
      menu.replaceChildren()
      opts.fill(menu, state.close)
    }
    root.classList.add(OPEN)
    trigger.setAttribute('aria-expanded', 'true')
  }

  const api: Menu = {
    root,
    trigger,
    menu,
    get isOpen(): boolean {
      return root.classList.contains(OPEN)
    },
    open,
    close: state.close,
    toggle(): void {
      if (root.classList.contains(OPEN)) state.close()
      else open()
    },
    item(text: string, onClick: () => void, io: MenuItemOpts = {}): HTMLButtonElement {
      const b = document.createElement('button')
      b.type = 'button'
      b.className =
        'bkm-item' + (io.off ? ' bkm-off' : '') + (io.selected ? ' bkm-selected' : '')
      b.setAttribute('role', 'menuitem')
      if (io.off) b.setAttribute('aria-disabled', 'true')
      if (io.selected) b.setAttribute('aria-current', 'true')
      if (io.icon) {
        const ico = document.createElement('span')
        ico.className = 'bkm-ico'
        ico.innerHTML = io.icon
        b.appendChild(ico)
      }
      const body = document.createElement('span')
      body.className = 'bkm-body'
      const strong = document.createElement('span')
      strong.className = 'bkm-text'
      strong.textContent = text
      body.appendChild(strong)
      if (io.hint) {
        const hint = document.createElement('span')
        hint.className = 'bkm-hint'
        hint.textContent = io.hint
        body.appendChild(hint)
      }
      b.appendChild(body)
      b.addEventListener('click', (ev) => {
        ev.stopPropagation()
        if (io.off) return
        if (!io.keepOpen) state.close()
        onClick()
      })
      menu.appendChild(b)
      return b
    },
    separator(): HTMLElement {
      const sep = document.createElement('div')
      sep.className = 'bkm-sep'
      // A hairline is decoration; a screen reader walking the menu should not
      // stop on it.
      sep.setAttribute('role', 'separator')
      menu.appendChild(sep)
      return sep
    },
    destroy(): void {
      if (dead) return
      dead = true
      live.delete(state)
      root.remove()
      unwire()
    },
  }

  trigger.addEventListener('click', (ev) => {
    ev.stopPropagation()
    api.toggle()
  })
  // ArrowDown on a CLOSED trigger opens it and lands on the first row — the
  // standard menu-button gesture, and the one that makes the arrow handling
  // above reachable without a mouse.
  trigger.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' || root.classList.contains(OPEN)) return
    ev.preventDefault()
    open()
    focusableRows(menu)[0]?.focus()
  })

  root.append(trigger, menu)
  live.add(state)
  wire()
  return api
}

/** Close every open menu. For an app that needs to shut the bar on its own
 *  events — starting a presentation, entering a modal. */
export function closeAllMenus(): void {
  for (const m of live) m.close()
}
