// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE SHARED TOOLTIP primitive — tier 3, BUILT AHEAD OF A CONSUMER on the
// maintainer's call ("build all four, they would come into play soon"). It is
// NOT a consolidation: the four-way read found no app has a hover tooltip at
// all — all four use the native `title` attribute (99/132/135/65 uses), and the
// `*-tip` classes that exist are a help overlay, a tone indicator and a drop
// marker, not tooltips. So this is a new, deliberately minimal abstraction; a
// real consumer will tell us what it needs, and this should be revisited if
// none adopts it. See docs/DECISIONS.md.
//
// Kept to exactly what a tooltip is: anchored to an element, shown on hover or
// focus after a short delay, hidden on leave / blur / Escape, and wired to the
// anchor with `aria-describedby` so it is not mouse-only.
//
// THE ONE THING THAT MATTERS MOST, per the brief: it must never be clipped by an
// ancestor. A tooltip is the primitive most likely to be born inside a scroll
// container (a panel, a menu), and hard-won detail 10 says an ancestor with
// `overflow:auto` clips BOTH axes. So the tip is rendered in `document.body` as
// a single `position: fixed` element, positioned from the anchor's rect — it has
// no scrolling ancestor to be trapped by, by construction. Values are the host
// app's via `--bkt-*` chains (tooltip.css); never light-dark().

export interface TooltipOpts {
  /** ms of hover/focus before it shows (default 400 — long enough not to flash
   *  on a pointer passing through, short enough to feel responsive). */
  delay?: number
  /** which side of the anchor to prefer (default 'top'). */
  placement?: 'top' | 'bottom'
}

/** The one body-level tip element, reused across every anchor — a tooltip is
 *  singular on screen, so there is never a reason for more than one. */
let tip: HTMLElement | null = null
let tipSeq = 0
let hideTimer: ReturnType<typeof setTimeout> | null = null
let showTimer: ReturnType<typeof setTimeout> | null = null

function ensureTip(): HTMLElement {
  if (tip) return tip
  tip = document.createElement('div')
  tip.className = 'bkt'
  tip.setAttribute('role', 'tooltip')
  tip.id = `bkt-${++tipSeq}`
  tip.hidden = true
  document.body.appendChild(tip)
  return tip
}

function place(anchor: HTMLElement, placement: 'top' | 'bottom'): void {
  const t = ensureTip()
  const r = anchor.getBoundingClientRect()
  // fixed, viewport coordinates — no scrolling ancestor to clip it (detail 10).
  t.style.position = 'fixed'
  t.style.left = `${Math.round(r.left + r.width / 2)}px`
  // translateX(-50%) centres it on the anchor (tooltip.css); top/bottom flips
  // which edge it hangs from.
  if (placement === 'bottom') { t.style.top = `${Math.round(r.bottom + 6)}px`; t.style.bottom = 'auto' }
  else { t.style.top = 'auto'; t.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px` }
}

function hideNow(): void {
  if (showTimer) { clearTimeout(showTimer); showTimer = null }
  if (tip) tip.hidden = true
}

/**
 * Attach a tooltip to `anchor`. Returns a detach() that removes every listener
 * and the `aria-describedby` wiring — call it when the anchor goes away.
 */
export function attachTooltip(anchor: HTMLElement, text: string, opts: TooltipOpts = {}): () => void {
  const delay = opts.delay ?? 400
  const placement = opts.placement ?? 'top'

  const show = (): void => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    if (showTimer) clearTimeout(showTimer)
    showTimer = setTimeout(() => {
      const t = ensureTip()
      t.textContent = text
      place(anchor, placement)
      t.hidden = false
      anchor.setAttribute('aria-describedby', t.id)
    }, delay)
  }
  const hide = (): void => {
    if (showTimer) { clearTimeout(showTimer); showTimer = null }
    anchor.removeAttribute('aria-describedby')
    // a tiny grace so moving the pointer onto nothing does not flicker; the
    // primitive stays simple — no hovering the tip itself (it is not interactive)
    hideTimer = setTimeout(hideNow, 60)
  }
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') hide() }

  anchor.addEventListener('mouseenter', show)
  anchor.addEventListener('mouseleave', hide)
  anchor.addEventListener('focus', show)
  anchor.addEventListener('blur', hide)
  anchor.addEventListener('keydown', onKey)

  return () => {
    anchor.removeEventListener('mouseenter', show)
    anchor.removeEventListener('mouseleave', hide)
    anchor.removeEventListener('focus', show)
    anchor.removeEventListener('blur', hide)
    anchor.removeEventListener('keydown', onKey)
    anchor.removeAttribute('aria-describedby')
    hideNow()
  }
}
