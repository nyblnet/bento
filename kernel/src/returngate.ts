// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// "You saved a deck from here before" — the state and the policy behind it.
//
// WHY THIS EXISTS. Someone opens https://bento.page/slides/, works, saves. The
// file lands on disk correctly. They come back to the same URL later and get a
// FRESH STARTER, because a never-saved deck stays dormant by design. It reads
// as lost work. It is not — but nothing on screen says so, and two things
// genuinely do not survive the round trip: version history and recovery live in
// IndexedDB keyed to the bento.page ORIGIN and do not follow the file to
// file://, and the session does not either.
//
// THE GATE IS ON RETURN, NOT ON SAVE. Blocking straight after the save was the
// first instinct and is wrong: once an FSA handle exists the editor silently
// rewrites the real file every 2.5s (save.ts writeUpdatedFile), so that tab is
// a working session writing to disk on every edit. Interrupting it would sever
// something that is functioning and lose whatever was typed since the last
// write. The confusion happens on the NEXT VISIT, so that is where the gate
// goes.
//
// WHAT LIVES HERE: the remembering, and the decision about what to offer.
// NOT the words and not the markup — those are the app's, because each app
// says it differently. Spaces, Dash and Type have the identical problem, and
// built app-side each would grow its own copy of this.
//
// The policy function is PURE and takes its inputs as arguments rather than
// reaching for save.ts, so it can be tested without a DOM and cannot drift
// from what the caller actually observed.

import { lsDel, lsGet, lsSet } from './storage.ts'

/** localStorage, viewer-scoped — the same rule locale, theme and reduced
 *  motion already follow. This NEVER goes in the document: it is a fact about
 *  this browser, not about the deck, and a deck that carried it would tell
 *  everyone you sent it to that YOU once saved something. */
const KEY = 'bento-saved-here'

/**
 * Remember that a save happened from this origin, and under what name, so the
 * next visit can say which file to open. Deliberately stores ONLY the name:
 * no doc id, no path (a page cannot know a path), nothing that identifies the
 * document's contents.
 */
export const noteSavedHere = (fileName: string): void => {
  if (fileName) lsSet(KEY, fileName)
}

/** The last file name saved from this origin, or null. */
export const savedHere = (): string | null => lsGet(KEY)

/** Forget it — for "start a new deck anyway", so the gate does not re-nag. */
export const clearSavedHere = (): void => lsDel(KEY)

/**
 * Is this a page served over the web, rather than the user's own file?
 *
 * The gate is meaningless on file:// — there the reader IS looking at their
 * saved deck, which is the thing the gate would be telling them to open.
 */
export const isWebOrigin = (): boolean => {
  try {
    return /^https?:$/.test(location.protocol)
  } catch {
    return false
  }
}

/**
 * Which hosts a reader could actually install TODAY.
 *
 * Availability gating is required from day one rather than added later:
 * hardcoding "install the extension" would tell an Android user to install a
 * Chrome extension. Flip these as each host gets a release — that is the whole
 * maintenance burden of the mobile rows.
 */
export const HOST_AVAILABLE = {
  desktopExtension: true,
  ios: false,   // home/ios — PR open, no release
  android: false, // home/android — on main via #87, no release
} as const

export type Platform = 'desktop' | 'ios' | 'android' | 'unknown'

export type Offer =
  /** Everything already works. Say nothing at all. */
  | { kind: 'silent' }
  /** Chrome/Edge desktop with no host: the extension is a real upgrade. */
  | { kind: 'extension' }
  /** An installable app exists for this platform. */
  | { kind: 'app'; platform: 'ios' | 'android' }
  /** No FSA and no host to fix it: keep the file wherever the OS puts files. */
  | { kind: 'keep-file'; platform: Platform }
  /** Desktop browser with no File System Access at all. No host helps. */
  | { kind: 'use-chromium' }

/**
 * What to offer, given what was OBSERVED rather than guessed.
 *
 * `fsAccess` is a real feature test (save.ts hasFsAccess / canWriteInPlace);
 * `platform` is a guess from the user agent. Where they disagree the
 * capability decides WHAT TO SAY and the platform decides only WHICH LINK —
 * so a browser that gains File System Access tomorrow is handled correctly by
 * this function on the day it ships, with no change here.
 */
export function offerFor(env: {
  fsAccess: boolean
  canWrite: boolean
  platform: Platform
}): Offer {
  // A host is already writing the file in place. Nothing to sell, nothing to
  // warn about: this is the case the whole feature is trying to reach.
  if (env.canWrite) return { kind: 'silent' }

  // The browser can write in place but nothing is holding a handle across
  // sessions — the extension is exactly the missing piece.
  if (env.fsAccess) {
    return HOST_AVAILABLE.desktopExtension ? { kind: 'extension' } : { kind: 'keep-file', platform: env.platform }
  }

  // From here down the browser has no File System Access at all.
  if (env.platform === 'ios') {
    return HOST_AVAILABLE.ios ? { kind: 'app', platform: 'ios' } : { kind: 'keep-file', platform: 'ios' }
  }
  if (env.platform === 'android') {
    return HOST_AVAILABLE.android ? { kind: 'app', platform: 'android' } : { kind: 'keep-file', platform: 'android' }
  }
  // Safari or Firefox on a desktop. No extension will help — saying "install
  // our extension" here would be a lie, and the honest answer is a browser
  // that implements the API.
  if (env.platform === 'desktop') return { kind: 'use-chromium' }
  return { kind: 'keep-file', platform: env.platform }
}

/**
 * Should the returning-visitor gate be shown?
 *
 * `docIsFresh` is the app's to decide — only the app knows whether what it just
 * loaded is its own starter or a real document — and it is the input that stops
 * the gate appearing over someone's actual work.
 */
export function shouldGateOnReturn(state: {
  webOrigin: boolean
  savedName: string | null
  docIsFresh: boolean
}): boolean {
  return state.webOrigin && !!state.savedName && state.docIsFresh
}
