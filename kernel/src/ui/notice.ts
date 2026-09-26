// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE SHARED NOTICE primitive — D3 of the chrome-unification rulings, which asked
// for transient messages "as two levels of one kernel primitive": an AMBIENT
// status line for the running commentary a reader may miss without cost
// ("Edited", "Saved"), and a TOAST pill for the thing they must not miss (a sync
// refusal, "Export done", "A page cannot contain itself"). Both existed in the
// apps and neither was shared: slides has a toast pill and a bar status line;
// spaces had only the bar line, and used it for both — so a sentence the reader
// had to act on flashed for under two seconds in a 12px muted whisper that, on a
// phone, sat over the title strip. This gives the two levels a home.
//
// Each level carries one hard-won lesson:
//
//   AMBIENT  the word must LEAVE the bar, not just fade out of it. The status
//            span is `nowrap`, so once "Edited" is written it holds ~40px of the
//            bar for the rest of the session — and on a phone that width comes
//            out of the controls beside it. So the text is CLEARED after the
//            fade, never during (a mid-fade clear makes it vanish, not settle).
//   TOAST    it is body-level and `position: fixed` above everything (a dialog
//            included, via --z-toast) so no ancestor clips it (detail 10) and
//            nothing paints over it, and it is `aria-live: polite` so it is
//            announced without stealing focus.
//
// Values are the host app's through `--bkn-*` chains (notice.css); never
// light-dark(). The ambient level is styled by the APP (it lives in the app's
// bar, a slot the kernel cannot place) — this owns only its TIMING and the class
// it toggles; the toast level is owned whole.

export interface ToastOpts {
  /** ms on screen before it fades (default 3600 — a sentence's read, plus a
   *  moment). */
  duration?: number
}

/** The one body-level pill, reused — a toast is singular on screen. */
let toastEl: HTMLElement | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null

function ensureToast(): HTMLElement {
  if (toastEl) return toastEl
  const t = document.createElement('div')
  t.className = 'bkn-toast'
  t.setAttribute('role', 'status')
  t.setAttribute('aria-live', 'polite')
  document.body.appendChild(t)
  toastEl = t
  return t
}

/**
 * Level 2 — a toast pill for a message the reader must not miss. Self-mounting
 * and singular: a second call replaces the first rather than stacking. Empty
 * `msg` is a no-op (a toast with nothing to say is a flash of empty chrome).
 */
export function toast(msg: string, opts: ToastOpts = {}): void {
  if (!msg) return
  const t = ensureToast()
  t.textContent = msg
  t.classList.add('bkn-on')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('bkn-on'), opts.duration ?? 3600)
}

export interface AmbientOpts {
  /** ms the message stays before it fades (default 1800). */
  showMs?: number
  /** ms after the fade before the text is CLEARED from the element, so it stops
   *  holding the bar's width (default 260 — long enough to cover the fade). */
  clearMs?: number
  /** the class the app's CSS fades on (default 'bkn-on'; spaces styles 'sp-on'). */
  onClass?: string
}

// Per-element timers, so two status lines (or repeated writes to one) do not
// clear each other. A WeakMap, not a property on the node, so nothing leaks.
const ambientTimers = new WeakMap<HTMLElement, { fade: ReturnType<typeof setTimeout>; clear: ReturnType<typeof setTimeout> }>()

/**
 * Level 1 — the ambient status line, written into the app's own bar element
 * (`el`). The kernel owns the timing and the "clear after the fade" lesson; the
 * app owns where the element sits and how it looks. Empty `msg` clears it now.
 */
export function ambient(el: HTMLElement, msg: string, opts: AmbientOpts = {}): void {
  const onClass = opts.onClass ?? 'bkn-on'
  const prev = ambientTimers.get(el)
  if (prev) { clearTimeout(prev.fade); clearTimeout(prev.clear) }
  if (!msg) {
    el.classList.remove(onClass)
    el.textContent = ''
    ambientTimers.delete(el)
    return
  }
  el.textContent = msg
  el.classList.add(onClass)
  const fade = setTimeout(() => {
    el.classList.remove(onClass)
    const clear = setTimeout(() => {
      // Only clear if nothing was written since — a clear mid-message would drop
      // a word the reader is still on.
      if (!el.classList.contains(onClass)) el.textContent = ''
    }, opts.clearMs ?? 260)
    const rec = ambientTimers.get(el)
    if (rec) rec.clear = clear
  }, opts.showMs ?? 1800)
  ambientTimers.set(el, { fade, clear: fade })
}
