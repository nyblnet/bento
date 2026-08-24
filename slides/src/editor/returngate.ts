// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The words and the markup for "you saved a deck from here before".
//
// The remembering and the policy live in kernel/src/returngate.ts, because
// Spaces, Dash and Type have the identical problem and would each grow their
// own copy of it. What is app-shaped is only this: how slides says it.
//
// WHY THIS EXISTS. Someone works at https://bento.page/slides/, saves, comes
// back later and gets a fresh starter, because a never-saved deck stays
// dormant by design. It reads as lost work. It is not — the file is on disk —
// but nothing on screen said so, and version history and recovery genuinely do
// not survive, because they live in IndexedDB keyed to the ORIGIN and do not
// follow the file to file://.
//
// The gate is on RETURN, not on save: a tab that has just saved is a working
// session writing to disk every 2.5s through its handle, and interrupting it
// would sever something that functions.

import { t } from '../i18n'
import {
  clearSavedHere, isWebOrigin, noteSavedHere, offerFor, savedHere,
  shouldGateOnReturn, type Offer, type Platform,
} from '../../../kernel/src/returngate.ts'

/**
 * Which platform's link to show. A GUESS, and treated as one: the capability
 * test decides what is said, this only decides which download is named. iOS is
 * checked before "Mac" because iPadOS reports MacIntel with touch points.
 */
export function platformGuess(): Platform {
  const ua = navigator.userAgent || ''
  const touchMac = navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1
  if (/iPhone|iPad|iPod/i.test(ua) || touchMac) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  if (/Macintosh|Windows|Linux|CrOS/i.test(ua)) return 'desktop'
  return 'unknown'
}

/** One sentence for the offer, or '' where the honest answer is to say nothing. */
export function offerLine(offer: Offer): string {
  switch (offer.kind) {
    case 'silent':
      return ''
    case 'extension':
      return t('The bento/tray extension can reopen your files here.')
    case 'app':
      return t('The bento/tray app can keep your files on this device.')
    case 'use-chromium':
      return t('This browser cannot reopen a file in place — Chrome or Edge can.')
    case 'keep-file':
      return t('Keep the file somewhere you can find it again.')
  }
}

const el = (tag: string, cls: string, text?: string) => {
  const n = document.createElement(tag)
  n.className = cls
  if (text) n.textContent = text
  return n
}

/**
 * After a save from the web: change what the page CLAIMS TO BE, without
 * interrupting it. Persistent rather than a toast — a toast is exactly the
 * thing someone misses, and this is the sentence that stops the next visit
 * being a surprise.
 */
export function noteSavedFromWeb(fileName: string, env: { fsAccess: boolean; canWrite: boolean }): void {
  if (!isWebOrigin() || !fileName) return
  noteSavedHere(fileName)
  document.querySelector('.ed-savednote')?.remove()
  const note = el('div', 'ed-savednote')
  note.appendChild(el('strong', 'ed-savednote-name', fileName))
  note.appendChild(el('span', 'ed-savednote-body',
    t('This page always starts a new deck — open this file to come back to it.')))
  const line = offerLine(offerFor({ ...env, platform: platformGuess() }))
  if (line) note.appendChild(el('span', 'ed-savednote-offer', line))
  document.body.appendChild(note)
}

/**
 * On return: say what happened, and never stand in the way.
 *
 * "Start a new deck anyway" is ALWAYS present. Some visitors genuinely want a
 * fresh deck and some cannot install anything, and a gate with no way past it
 * is worse than the silent blank starter it replaces.
 */
export function maybeShowReturnGate(env: {
  docIsFresh: boolean
  fsAccess: boolean
  canWrite: boolean
}): void {
  const name = savedHere()
  if (!shouldGateOnReturn({ webOrigin: isWebOrigin(), savedName: name, docIsFresh: env.docIsFresh })) return

  const overlay = el('div', 'ed-gate-overlay')
  const card = el('div', 'ed-gate-card')
  card.appendChild(el('h2', 'ed-gate-h', t('You saved a deck from here before.')))
  card.appendChild(el('p', 'ed-gate-body',
    t('This page always starts fresh. Open your file to carry on with it:')))
  card.appendChild(el('div', 'ed-gate-name', name ?? ''))
  const line = offerLine(offerFor({ fsAccess: env.fsAccess, canWrite: env.canWrite, platform: platformGuess() }))
  if (line) card.appendChild(el('p', 'ed-gate-offer', line))

  const acts = el('div', 'ed-gate-acts')
  const go = document.createElement('button')
  go.className = 'ed-btn ed-btn-primary'
  go.textContent = t('Start a new deck anyway')
  go.addEventListener('click', () => {
    // Forget it, or the same person is asked the same question every visit.
    clearSavedHere()
    overlay.remove()
  })
  acts.appendChild(go)
  card.appendChild(acts)
  overlay.appendChild(card)
  document.body.appendChild(overlay)
  go.focus()
}
