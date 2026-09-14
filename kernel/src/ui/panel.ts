// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE SHARED SIDE-PANEL + RESIZER PRIMITIVE — tier 2 of the kernel UI
// primitives, after the menu (tier 1).
//
// WHY THIS EXISTS. Measured by concept, the resizable side panel is one design
// implemented three times and stubbed a fourth:
//
//   slides  .ed-sidebar + .ed-props, two .ed-resizer strips, drag-to-size with
//           a per-side clamp, RTL-aware widening, .ed-noanim during the drag,
//           .ed-collapsed, double-click reset, bento-ed-panels persistence,
//           overlay DRAWERS below 700px, a chevron that docks flush when shut.
//   spaces  .sp-sidebar + .sp-insp, .sp-resizer + .sp-insp-rz, --sp-panew,
//           .sp-noanim, .sp-pane-closed, keys bento-sp-width / -pane / -insp.
//   dash    one props panel, EXPLICITLY ported from slides (its panels.ts says
//           "slides is the reference"): 5px resizer + docking chevron, `]` to
//           collapse, boots shut below a width, bento-dash-panels* keys.
//   type    .t-props is a FIXED-WIDTH aside — overflow:auto, no resizer, no
//           collapse, no persistence. It copied the row metrics ("at a fixed
//           width, as slides and dash both do") and none of the machinery.
//
// So "slides is the basis" is again true of three and empty for the fourth —
// type would GAIN drag, collapse and persistence from adopting this, not lose
// anything to it.
//
// THE COST, as with the menu, is not bytes but knowledge with nowhere to live.
// Each app learned the same non-obvious things by itself: a panel must carry a
// no-animation class DURING a drag (or its width transition fights the cursor);
// the chevron docks flush to the screen edge when the panel is collapsed;
// widening flips direction under RTL because the drag delta is physical while
// the panel is docked logically; a panel boots SHUT below a phone width so the
// canvas is what you see; and — hard-won detail 10 — a panel is `overflow:auto`,
// so anything that floats inside it (a menu, a popover) is clipped on BOTH axes
// and must escape the way the menu primitive's phone rule does.
//
// VALUES ARE THE HOST APP'S, exactly as the menu primitive does it: every
// colour and metric reads through a `--bkp-*` custom property whose fallback
// chain lands on whatever token the host already defines, so adoption is
// appearance-neutral and this file commits to no theme mechanism (never
// light-dark(); see panel.css). The PERSISTENCE KEY is injected — the kernel
// must not hardcode an app's localStorage namespace, the same way the broadcast
// session takes an injected projection rather than learning an app's shape.

export interface PanelOpts {
  /** The panel body the app fills. The primitive owns the frame and the
   *  resizer; the content is the app's. */
  content: HTMLElement
  /** Which screen edge the panel docks to. LOGICAL: 'start' is the left in LTR
   *  and the right in RTL — the resizer and the drag direction follow. */
  side: 'start' | 'end'
  /** Width bounds and the default (also the double-click reset target). */
  defaultWidth: number
  minWidth: number
  maxWidth: number
  /** localStorage namespace for this panel's {width, collapsed}. Absent = the
   *  panel does not persist (type's today). Two panels need two keys. */
  storageKey?: string
  /** Initial collapsed state, unless persistence overrides it. */
  collapsed?: boolean
  /** At or below this viewport width the panel is an overlay DRAWER rather than
   *  a column, and boots shut. Default 700 (every app's phone width). */
  drawerBelow?: number
  /** Accessible name for the panel region. */
  label?: string
}

export interface Panel {
  /** The panel column (content + resizer). Put it in the app's layout. */
  readonly root: HTMLElement
  /** The draggable strip, carrying the collapse chevron. */
  readonly resizer: HTMLElement
  readonly content: HTMLElement
  readonly width: number
  readonly collapsed: boolean
  setWidth(px: number): void
  /** Reset to defaultWidth (what a double-click on the resizer does). */
  resetWidth(): void
  collapse(): void
  expand(): void
  toggle(): void
  /** Fires after any width or collapse change — the app refits its canvas here.
   *  Returns an unsubscribe. */
  onChange(fn: () => void): () => void
  destroy(): void
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function lsSet(key: string, val: string): void {
  try { localStorage.setItem(key, val) } catch { /* private window / quota / blocked */ }
}

/** Is the document right-to-left? The drag delta is physical (clientX), so a
 *  'start' panel in RTL is docked on the RIGHT and widens the opposite way. */
function isRtl(): boolean {
  try { return getComputedStyle(document.documentElement).direction === 'rtl' } catch { return false }
}

export function createPanel(opts: PanelOpts): Panel {
  const drawerBelow = opts.drawerBelow ?? 700
  const root = document.createElement('div')
  root.className = 'bkp bkp-' + opts.side
  if (opts.label) root.setAttribute('aria-label', opts.label)
  root.setAttribute('role', 'region')

  const resizer = document.createElement('div')
  resizer.className = 'bkp-resizer'
  resizer.title = '' // the app may set a localized title; the primitive stays language-free
  const chevron = document.createElement('button')
  chevron.type = 'button'
  chevron.className = 'bkp-toggle'
  chevron.setAttribute('aria-expanded', 'true')
  resizer.appendChild(chevron)

  opts.content.classList.add('bkp-content')

  // The resizer sits on the panel's INNER edge: after the content for a 'start'
  // panel, before it for an 'end' panel, so the strip is always between the
  // panel and the canvas.
  if (opts.side === 'start') root.append(opts.content, resizer)
  else root.append(resizer, opts.content)

  let width = opts.defaultWidth
  let collapsed = !!opts.collapsed
  // A drawer boots shut: on a phone the canvas is what you want first.
  const mql = typeof matchMedia === 'function' ? matchMedia(`(max-width: ${drawerBelow}px)`) : null
  if (mql?.matches) collapsed = true

  // Persistence overrides the initial width/collapsed, when a key is given.
  if (opts.storageKey) {
    const raw = lsGet(opts.storageKey)
    if (raw) {
      try {
        const saved = JSON.parse(raw) as { width?: number; collapsed?: boolean }
        if (typeof saved.width === 'number') width = clamp(saved.width, opts.minWidth, opts.maxWidth)
        if (typeof saved.collapsed === 'boolean' && !mql?.matches) collapsed = saved.collapsed
      } catch { /* corrupt entry — ignore, use defaults */ }
    }
  }

  const listeners = new Set<() => void>()
  const fire = (): void => listeners.forEach((fn) => fn())

  function persist(): void {
    if (opts.storageKey) lsSet(opts.storageKey, JSON.stringify({ width, collapsed }))
  }

  function render(): void {
    root.style.setProperty('--bkp-w', `${width}px`)
    root.classList.toggle('bkp-collapsed', collapsed)
    root.classList.toggle('bkp-drawer', !!mql?.matches)
    chevron.setAttribute('aria-expanded', String(!collapsed))
  }

  const api: Panel = {
    root,
    resizer,
    content: opts.content,
    get width() { return width },
    get collapsed() { return collapsed },
    setWidth(px: number): void {
      width = clamp(px, opts.minWidth, opts.maxWidth)
      render(); persist(); fire()
    },
    resetWidth(): void {
      width = opts.defaultWidth
      render(); persist(); fire()
    },
    collapse(): void { if (!collapsed) { collapsed = true; render(); persist(); fire() } },
    expand(): void { if (collapsed) { collapsed = false; render(); persist(); fire() } },
    toggle(): void { collapsed = !collapsed; render(); persist(); fire() },
    onChange(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn) },
    destroy(): void {
      mql?.removeEventListener?.('change', onMql)
      root.remove()
      listeners.clear()
    },
  }

  // The chevron toggles; its click must not also start a drag.
  chevron.addEventListener('click', (ev) => { ev.stopPropagation(); api.toggle() })

  // Drag-to-size. A collapsed panel does not resize; the chevron is not a drag.
  resizer.addEventListener('mousedown', (down) => {
    if (down.target === chevron || collapsed) return
    down.preventDefault()
    const startX = down.clientX
    const startW = width
    // Physical delta → logical widen: a 'start' panel widens with a rightward
    // drag in LTR and a leftward drag in RTL; an 'end' panel is the mirror.
    const widensRight = (opts.side === 'start') !== isRtl()
    // No width transition WHILE dragging, or the panel chases the cursor a
    // frame behind. Every app learned this; here it is one class.
    root.classList.add('bkp-noanim')
    document.body.classList.add('bkp-resizing')
    const move = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX
      api.setWidth(startW + (widensRight ? dx : -dx))
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      root.classList.remove('bkp-noanim')
      document.body.classList.remove('bkp-resizing')
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })
  resizer.addEventListener('dblclick', (ev) => { if (ev.target !== chevron) api.resetWidth() })

  // Crossing the drawer breakpoint re-lays-out and, entering drawer width,
  // boots the panel shut so the canvas is what shows.
  function onMql(): void {
    if (mql?.matches) collapsed = true
    render(); fire()
  }
  mql?.addEventListener?.('change', onMql)

  render()
  return api
}
