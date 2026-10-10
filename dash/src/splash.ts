// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The boot splash — its dismissal, which is the half with the failure modes.
//
// The MARKUP is not here and must not be: a splash that waits for this bundle
// to parse has already failed at its job. It is inline in index.html, and
// postbuild-compress lifts it (with its own <style>) ahead of the compressed
// payloads, so it paints from the first bytes of the file while ~170KB of
// deflated runtime is still inflating.
//
// Removing it is the LIVE document's business only. `capturePristine()` has
// already cloned the shell by the time anything here runs, so a saved workbook
// keeps its splash for its own next boot — which is the whole point, since the
// file people receive has to paint something before it can run. That is also
// why nothing in this module carries `data-bento-transient`: the splash is
// SHELL, not runtime-injected DOM, and the rule it has to satisfy is the
// opposite one — exactly one copy must survive a save. (Measured on a
// serialize() of a fresh boot: one `id="bento-splash"`, one splash `<style>`,
// and no `.dx-bar` anywhere, i.e. the 43KB app stylesheet stayed deflated.)
//
// THE TIMING RULE, AND WHY IT IS NOT A CLOCK
//
// It used to be: hold the mark 450ms from page start, then cross-fade for
// 500ms. Measured against the build, that is a bill nobody was getting value
// for. The workbook is in the DOM long before the hold expires:
//
//     starter workbook (1KB doc) ......... grid in DOM at   85ms
//     2.4MB doc,  60,000 rows ............ grid in DOM at  350ms
//      13MB doc, 400,000 rows ............ grid in DOM at  415ms
//
// — so on every workbook that exists, a reader who double-clicked a
// spreadsheet was shown a wordmark on white for 450ms and then a half-second
// dissolve, over an application that had been finished and waiting the whole
// time. The clock was measuring the brand, not the work.
//
// So the hold is gone. The splash now leaves as soon as there is something
// behind it, and the only timing left is the FADE — which is free, because
// `.done` also sets `pointer-events: none`, so the workbook is clickable from
// the first frame of it. Cost falls from ~950ms to one frame plus a dissolve
// the reader can already type through.
//
// What is left to decide is only how it LEAVES, and that is one line: a boot
// fast enough to feel instant should end instantly, and a boot slow enough
// that the mark was genuinely read should dissolve. See SNAP_MS.
//
// A NOTE ON WHAT IS NOT CLAIMED HERE. An earlier draft of this file decided
// the same question by asking `getEntriesByType('paint')` whether the splash
// had ever been composited, and skipped the fade when the answer was "no
// paints yet" — on the theory that nothing unseen can flash. That instrument
// does not support the claim. Measured on the starter workbook: at the moment
// of removal (106ms) `getEntriesByType('paint')` was still EMPTY, and yet a
// PerformanceObserver reported `first-paint` at 88ms — i.e. the frame had been
// presented eighteen milliseconds earlier and the entry had simply not landed
// in the buffer yet. Paint entries are delivered after the frame, so they can
// only ever prove a paint HAS happened, never that one has not. The splash is
// therefore assumed to be visible, always, and the rule below is about
// elapsed time, which this code can actually observe.

import { t } from './i18n.ts'

/** index.html declares `transition: opacity .45s`; outlive it by a frame. */
const FADE_MS = 500

/**
 * Below this much elapsed page time, the workbook is revealed with a cut
 * rather than a dissolve.
 *
 * A dissolve is not free at the fast end: on the starter workbook the grid is
 * ready at ~100ms, so a 500ms cross-fade is five sixths of everything the
 * reader experiences, and it turns "the file opened" into "the file is
 * opening". Below the threshold the honest presentation is that there was
 * nothing to wait for. Above it the mark has been on screen long enough to
 * read, and snapping it away would register as a glitch.
 *
 * 300ms is placed against the measurements above: every ordinary workbook, up
 * to 60,000 rows at 350ms, lands near or under it and opens with a cut; the
 * 13MB / 400,000-row outlier at 415ms is over it and gets the dissolve, which
 * is the case where a dissolve is the right answer anyway.
 */
const SNAP_MS = 300

/**
 * When to stop believing a boot is still coming.
 *
 * Was 9000. The slowest boot this build can be made to have is the 13MB /
 * 400,000-row workbook above, at 415ms, so 6s is fourteen times the measured
 * worst case — and unlike the old number it is safe to shorten, because the
 * failsafe now LOOKS before it fires (`appIsUp`) instead of assuming the worst.
 * A slow phone that is merely slow still wins the race; only a boot that
 * produced no DOM at all loses it.
 */
const FAILSAFE_MS = 6000

/**
 * How long to wait for the animation frame that does the reveal, before doing
 * it on a plain timer instead.
 *
 * requestAnimationFrame is the right instrument — it lands after `boot()` has
 * finished writing the workbook and before the next paint, so the first frame
 * the reader sees is the grid with no splash over it, and no intermediate
 * state is ever composited. But a rAF in a background tab never runs at all
 * (measured: `document.visibilityState === 'hidden'`, callbacks never fire),
 * and the old timer-based code did work there. Racing the two keeps that.
 */
const REVEAL_FALLBACK_MS = 60

const splash = (): HTMLElement | null => document.getElementById('bento-splash')

const reduced = (): boolean => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** Is there a workbook, an error surface, or a password gate behind the splash? */
const appIsUp = (): boolean => {
  const app = document.getElementById('app')
  if (app && app.childElementCount > 0) return true
  return !!document.querySelector('.dx-gate')
}

/** Run `fn` on the next frame, or on a short timer if frames are not coming. */
function onNextFrame(fn: () => void): void {
  let done = false
  const once = () => { if (!done) { done = true; fn() } }
  try {
    requestAnimationFrame(once)
  } catch { /* no rAF at all — the timer below is the whole mechanism */ }
  setTimeout(once, REVEAL_FALLBACK_MS)
}

/** Take the splash away NOW. For the gates: an error surface must not wait
 *  behind branding, and a password prompt the reader cannot see is a bug. */
export function dismissSplashNow(): void {
  splash()?.remove()
}

/**
 * Reveal the workbook.
 *
 * Called at the TOP of `boot()`, before `app.innerHTML` is written — so this
 * must not act immediately or it would uncover an empty page for a frame. The
 * frame hop is what makes "as soon as it is ready" mean the workbook rather
 * than the moment somebody asked.
 */
export function dismissSplash(): void {
  if (!splash()) return
  onNextFrame(() => {
    const el = splash()
    if (!el) return
    // Fast enough to feel instant, or motion is unwelcome: cut, don't dissolve.
    if (performance.now() < SNAP_MS || reduced()) { el.remove(); return }
    el.classList.add('done')
    // Removed, not just faded: it is `position: fixed; inset: 0`, and while it
    // exists it eats every click on the grid underneath it.
    setTimeout(() => el.remove(), FADE_MS)
  })
}

/**
 * The backstop, for a boot that started and then stopped happening.
 *
 * A boot that THROWS never reaches dismissSplash, and the splash is fixed,
 * opaque and z-index 9999 — so without this the workbook runs underneath it,
 * unreachable, forever.
 *
 * It does not simply `remove()` any more. Removing a splash with nothing
 * behind it trades a stuck logo for a blank white page, which is strictly less
 * information: the reader can no longer even tell the file is a bento/dash
 * workbook, and nothing on screen says their data is still in it. So the
 * failsafe reads the page first — if the workbook (or a gate, or the password
 * prompt) is up, this fired for no reason and it just gets out of the way; and
 * only if the page is genuinely empty does it say so, and hand back the two
 * things a stuck reader actually needs: their document, and another attempt.
 *
 * KNOWN LIMIT, unchanged and worth stating plainly: this covers "the module
 * graph loaded and boot then failed". It cannot cover "the bundle never ran" —
 * a truncated download, a file cut off mid-payload — because then nothing in
 * this file executes. Measured on a shell truncated inside the runtime payload:
 * no error, no timeout, the wordmark on white indefinitely. Only a rule in
 * index.html's own <style>, which needs no JavaScript, can reach that case;
 * slides carries exactly such a keyframe (`bsAuto`) and dash does not yet.
 */
function failsafe(): void {
  const el = splash()
  if (!el) return
  if (appIsUp()) { el.remove(); return }
  stall(el)
}

/**
 * Replace the splash with something a stuck reader can act on.
 *
 * Deliberately built from `.dx-gate`, the same surface `refuse()` uses in
 * main.ts, so "this file did not open" looks like one answer in this app
 * rather than two. The inline colours are a belt on top of that brace: this
 * runs when something has already gone wrong, and it must stay legible even if
 * the reason is that the stylesheet never arrived.
 */
function stall(el: HTMLElement): void {
  el.classList.remove('done')
  el.style.opacity = '1'
  el.style.display = 'block'
  el.style.overflow = 'auto'
  el.textContent = ''

  const gate = document.createElement('div')
  gate.className = 'dx-gate'
  gate.style.maxWidth = '34rem'
  gate.style.margin = '12vh auto'
  gate.style.padding = '0 1.5rem'
  // The splash sets `font: 600 20px/1.4` on itself to size the wordmark, and
  // everything put inside it inherits that — measured: the body copy rendered
  // semibold at 20px, which reads as a second heading rather than a sentence.
  gate.style.font = '400 14px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif'

  const h = document.createElement('h1')
  h.style.font = '600 20px/1.3 ui-sans-serif, system-ui, -apple-system, sans-serif'
  h.style.margin = '0 0 8px'
  h.textContent = t('This workbook did not finish opening.')

  // ONE STRING LITERAL PER t(), ON ONE LINE. The catalogs are swept out of this
  // directory by `node scripts/test-dash-i18n.ts`, which reads the source text
  // of the call — a key built by concatenating two literals is a key the sweep
  // cannot see, so it would ship untranslatable and the guard would not say so.
  const p = document.createElement('p')
  p.style.margin = '0 0 14px'
  p.textContent = t('Your data has not been changed — it is still inside this file. Try opening it again, or take the contents out below.')

  const again = document.createElement('button')
  again.className = 'dx-btn'
  again.style.marginRight = '8px'
  again.textContent = t('Try again')
  again.addEventListener('click', () => location.reload())

  const copy = document.createElement('button')
  copy.className = 'dx-btn'
  copy.textContent = t('Copy document JSON')
  copy.addEventListener('click', () => {
    const raw = document.getElementById('bento-doc')?.textContent ?? ''
    void navigator.clipboard?.writeText(raw)
    copy.textContent = t('Copied')
  })

  gate.append(h, p, again, copy)
  el.append(gate)
}

setTimeout(failsafe, FAILSAFE_MS)
