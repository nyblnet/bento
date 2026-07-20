// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// The speaker-notes window. It outlives any single present session: the editor
// opens it (its own user gesture) BEFORE presenting, and present mode adopts it.
// Opening the notes and going fullscreen are then two separate gestures, so
// neither steals the other's activation (the macOS second-screen fix). The
// window opens on the current display; the presenter drags it to a second
// screen — we deliberately do NOT request the "window management" permission.

/** macOS is the platform whose exclusive fullscreen Space traps a popup opened
 *  after the slides go fullscreen — so notes must be opened first there. */
export function isMacOS(): boolean {
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData
  if (uaData?.platform) return uaData.platform === 'macOS'
  return /Mac/i.test(navigator.platform || navigator.userAgent || '')
}

// --- speaker-notes window (shared editor↔present) ---------------------------

let speakerWin: Window | null = null
let speakerWatch = 0
let onSpeakerChange: (() => void) | null = null

/** Notified whenever the speaker window opens or closes — including when the
 *  user closes the popup manually — so the editor panel can refresh its button. */
export function onSpeakerWindowChange(cb: (() => void) | null): void {
  onSpeakerChange = cb
}

// Poll for an externally-closed popup (there is no reliable cross-window close
// event); clear our reference and notify so the UI doesn't go stale.
function watchSpeaker(): void {
  clearInterval(speakerWatch)
  if (!speakerWin) return
  speakerWatch = window.setInterval(() => {
    if (!speakerWin || speakerWin.closed) {
      speakerWin = null
      clearInterval(speakerWatch)
      onSpeakerChange?.()
    }
  }, 1000)
}

/** The live speaker-notes window, or null if none is open. */
export function speakerWindow(): Window | null {
  return speakerWin && !speakerWin.closed ? speakerWin : null
}

/** Register (or clear) the speaker window — present mode uses this when it opens
 *  its own, so the editor panel reflects the state and later opens don't dup. */
export function setSpeakerWindow(w: Window | null): void {
  speakerWin = w
  watchSpeaker()
}

/** Copy the app's <style>s and set the body of a speaker window. */
export function paintSpeaker(w: Window, title: string, bodyHtml: string): void {
  const d = w.document
  d.title = title
  if (!d.head.querySelector('style')) {
    for (const st of document.querySelectorAll('style')) d.head.appendChild(d.importNode(st, true))
  }
  d.body.className = 'bento-speaker'
  d.body.innerHTML = bodyHtml
}

/** A generous default popup size for the current display. */
function speakerFeatures(): string {
  const w = Math.min(1200, Math.max(800, Math.round((screen.availWidth || 1440) * 0.72)))
  const h = Math.min(820, Math.max(560, Math.round((screen.availHeight || 900) * 0.78)))
  return `width=${w},height=${h}`
}

/** Open (or focus) the speaker-notes window on the current display and paint it.
 *  MUST be called inside a user gesture (window.open). The presenter drags it to
 *  a second screen. Returns null if the popup was blocked. */
export function openSpeakerWindow(title: string, bodyHtml: string): Window | null {
  if (speakerWin && !speakerWin.closed) {
    speakerWin.focus()
    paintSpeaker(speakerWin, title, bodyHtml)
    return speakerWin
  }
  const w = window.open('', 'bento-speaker', speakerFeatures())
  if (!w) return null
  paintSpeaker(w, title, bodyHtml)
  speakerWin = w
  watchSpeaker()
  return w
}

/** The idle placeholder shown before a presentation drives the window. */
export function speakerIdleBody(title: string, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
  return `<div class="sv-idle"><div class="sv-idle-title">${esc(title)}</div><p class="sv-idle-msg">${esc(message)}</p></div>`
}
