// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The ONE place this app touches the network.
//
// WHY THIS EXISTS. Offline mode used to be a boolean that five call sites
// remembered to consult, and the ones that forgot were invisible from the
// inside: the switch looked sound in the docs AND in the code — an agent
// asked to audit it reported "secure" twice — and only watching real traffic
// showed otherwise. Reported 2026-08-09 (GHSA-5c3x-xqp6-g94r), reproduced on
// 802804b. With the switch ON:
//
//   - a manual "Check for updates" still called home (the gate sat on the
//     AUTO-check call site; checkForUpdates() itself fetched unconditionally)
//   - "Manage languages…" still downloaded packs.json and a 73KB pack
//   - a deck's remote <video src> still loaded — 4 requests, and NOT a fetch
//     at all, so no fetch-shaped gate could ever have caught it
//   - in-flight requests kept running (nothing in the codebase could abort:
//     there was no AbortController anywhere)
//   - a second tab's open socket kept carrying edits, because the toggle
//     disconnected only its own tab's session and nothing watched `storage`
//   - and with site data blocked, the checkbox showed ENABLED while the
//     preference never persisted, so the switch silently did nothing
//
// So the switch stops being a thing to remember. Every request goes through
// netFetch/netWebSocket, and `scripts/test-offline.ts` FAILS THE BUILD if any
// file outside this one calls `fetch(` or `new WebSocket` directly. That is
// the property worth having: not "the call sites are right today" but "a new
// call site cannot be wrong". Suggested by the reporter, and it is the right
// shape — an agent, or a person, can check a rule like that mechanically.
//
// What offline does NOT block, deliberately: BroadcastChannel. Same-machine
// tab sync is not networking, and nothing leaves the computer.

import { lsGet, lsSet } from './storage.ts'

/** Thrown by netFetch/netWebSocket when the offline switch is on. */
export class OfflineError extends Error {
  constructor(what = 'the network') {
    super(`Offline mode is on — refusing to reach ${what}.`)
    this.name = 'OfflineError'
  }
}

/**
 * Set for THIS session once anyone flips the switch, so the guarantee holds
 * even where the preference cannot be stored. Storage-blocked contexts are
 * not an edge case here — they are private windows and locked-down browsers,
 * i.e. exactly the people most likely to want this switch on.
 */
let sessionOffline: boolean | null = null

/**
 * Offline mode: a hard, viewer-side switch that blocks EVERY network touch —
 * update checks, language packs, collaboration and remote media alike. The
 * guarantee it buys: with the switch on, nothing about you or a document ever
 * leaves this computer.
 */
export const offlineEnabled = (): boolean =>
  sessionOffline ?? lsGet('bento-offline') === 'on'

/**
 * Set the switch. Returns whether it actually PERSISTED — false where site
 * data is blocked or storage is full.
 *
 * The caller must not ignore this. It used to swallow the failure, so with
 * storage unavailable the checkbox showed "on" over a switch that was off:
 * measured — checkbox enabled, preference `off`, request went out anyway.
 * A privacy switch that lies is worse than one that is missing, because the
 * whole reason to touch it is to stop doing something.
 */
export const setOffline = (on: boolean): boolean => {
  sessionOffline = on
  const stuck = lsSet('bento-offline', on ? 'on' : 'off')
  if (on) enforceOffline()
  return stuck
}

// ——— live connections, so "go offline" can mean NOW rather than "next time"

const inFlight = new Set<AbortController>()
const sockets = new Set<WebSocket>()

/**
 * Cut everything already running. Called when the switch goes on — in THIS
 * tab by setOffline, and in every OTHER tab by the `storage` listener below,
 * which is the half that was missing: `bento-offline` is shared across tabs,
 * so a second tab already believed it was offline while its socket kept
 * carrying edits both ways.
 */
export function enforceOffline(): void {
  for (const ac of [...inFlight]) {
    try { ac.abort(new OfflineError()) } catch { /* already settled */ }
  }
  inFlight.clear()
  for (const ws of [...sockets]) {
    try { ws.close(1000, 'offline mode') } catch { /* already closing */ }
  }
  sockets.clear()
}

let guarding = false
/**
 * Watch the switch in other tabs. `storage` fires only in the tabs that did
 * NOT make the change, which is exactly the set that needs telling.
 */
export function startNetGuard(): void {
  if (guarding || typeof addEventListener !== 'function') return
  guarding = true
  addEventListener('storage', (e) => {
    if (e.key !== 'bento-offline') return
    // Mirror the other tab's decision into this one, or a session flag set
    // here would outrank it and keep letting requests out.
    sessionOffline = e.newValue === 'on'
    if (sessionOffline) enforceOffline()
  })
}

// ——— the primitives

/** fetch(), refused when offline and abortable the moment the switch flips. */
export async function netFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  if (offlineEnabled()) throw new OfflineError(String(input))
  const ac = new AbortController()
  inFlight.add(ac)
  // Honour a caller's own signal as well as ours.
  if (init.signal) {
    if (init.signal.aborted) ac.abort(init.signal.reason)
    else init.signal.addEventListener('abort', () => ac.abort(init.signal!.reason), { once: true })
  }
  try {
    return await fetch(input, { ...init, signal: ac.signal })
  } finally {
    inFlight.delete(ac)
  }
}

/** new WebSocket(), refused when offline and closed the moment the switch flips. */
export function netWebSocket(url: string): WebSocket {
  if (offlineEnabled()) throw new OfflineError(url)
  const ws = new WebSocket(url)
  sockets.add(ws)
  ws.addEventListener('close', () => sockets.delete(ws), { once: true })
  return ws
}

// ——— the part no fetch wrapper can see

/**
 * Does this `src` reach the network when a browser loads it?
 *
 * Media and images are loaded by the BROWSER from a `src` attribute, not by
 * us from a fetch — which is why a remote <video> sailed through a switch
 * that gated every fetch in the app. The renderer asks this before it emits
 * one.
 *
 * `data:`, `blob:` and `asset:` are carried inside the file. Anything that
 * resolves to http(s) is a request leaving the machine — including a
 * same-origin relative path, because a deck opened from a web server still
 * reaches that server for it, and "nothing leaves this computer" has to mean
 * what it says.
 */
export function isRemoteUrl(src: string): boolean {
  const s = (src ?? '').trim()
  if (!s) return false
  if (/^(data|blob|asset|file):/i.test(s)) return false
  // Protocol-relative names a HOST whatever the page's scheme is. Judged
  // before resolution, so the answer does not depend on whether the deck was
  // opened from a web server or from a file:// path — a privacy switch that
  // changes its mind based on that is not one you can reason about.
  if (s.startsWith('//')) return true
  try {
    const base = typeof document !== 'undefined' ? document.baseURI : undefined
    return /^https?:$/i.test(new URL(s, base).protocol)
  } catch {
    return false // unparseable is not a URL a browser will reach either
  }
}

/** A `src` the renderer must not emit right now. */
export const remoteSrcBlocked = (src: string): boolean => offlineEnabled() && isRemoteUrl(src)
