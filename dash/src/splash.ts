// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The boot splash — its dismissal, which is the half with the failure modes.
//
// The MARKUP is not here and must not be: a splash that waits for this bundle
// to parse has already failed at its job. It is inline in index.html, and
// postbuild-compress lifts it (with its own <style>) ahead of the compressed
// payloads, so it paints from the first bytes of the file while ~500KB of
// deflated runtime is still inflating.
//
// Removing it is the LIVE document's business only. `capturePristine()` has
// already cloned the shell by the time anything here runs, so a saved workbook
// keeps its splash for its own next boot — which is the whole point, since the
// file people receive has to paint something before it can run.

/** index.html declares `transition: opacity .45s`; outlive it by a frame. */
const FADE_MS = 500

/**
 * How long the mark stays up, measured from page start rather than from the
 * call — a boot that took 900ms has already shown it long enough.
 *
 * Short on purpose. Slides holds 1250ms because its splash ANIMATES and there
 * is something to watch; dash's is a wordmark on white against an app that is
 * also white, so the only thing a hold buys is not flashing a word for one
 * frame.
 */
const HOLD_MS = 450

/**
 * A boot that THROWS never reaches dismissSplash, and the splash is fixed,
 * opaque and z-index 9999 — the app runs underneath it, unreachable, forever.
 * Slides defends this in CSS (`bsAuto`, a 9s auto-fade in the splash's own
 * inline style, so it works even when the bundle never parses); dash's
 * index.html carries no such rule, so the backstop is armed here instead.
 *
 * Weaker than the CSS one, and knowingly: it covers "the module graph loaded
 * and boot then failed", not "the bundle never ran". Adding the keyframe to
 * index.html would cover both.
 */
const FAILSAFE_MS = 9000

const splash = (): HTMLElement | null => document.getElementById('bento-splash')

const reduced = (): boolean => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** Take the splash away NOW. For the gates: an error surface must not wait
 *  behind branding, and a password prompt the reader cannot see is a bug. */
export function dismissSplashNow(): void {
  splash()?.remove()
}

/** Take the splash away once it has been up long enough to read. */
export function dismissSplash(): void {
  const el = splash()
  if (!el) return
  if (reduced()) { el.remove(); return }
  setTimeout(() => {
    el.classList.add('done')
    // Removed, not just faded: it is `position: fixed; inset: 0`, and while it
    // exists it eats every click on the grid underneath it.
    setTimeout(() => el.remove(), FADE_MS)
  }, Math.max(0, HOLD_MS - performance.now()))
}

setTimeout(dismissSplashNow, FAILSAFE_MS)
