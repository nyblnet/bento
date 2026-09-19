// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// When to mention the bento/home extension, and what to say.
//
// The extension gives a deck opened from disk three things the browser alone
// cannot: ⌘S that writes the open file in place with no picker, updates that
// land in place with a backup beside them, and the Assistant on Chrome's
// on-device model — nothing leaves the computer, no account, no key. Each is
// best said at the moment its absence is felt, once, and never again once
// dismissed: after the first save that needed a picker, on the update dialog
// that would need one, and in the Assistant's empty state. Not on every
// page, not as a banner at boot — a deck that opens and works has no reason
// to sell anything.
//
// "Would help" = Chrome/Edge (the File System Access API exists), the deck
// is a file:// page (the only place the extension attaches), and no host is
// injected. A web-served deck, Safari/Firefox (no FSA either way) and a page
// that already has the host say nothing.

import { lsGet, lsSet } from '../../../kernel/src/storage.ts'

/** Where "get the extension" points. The app has no store link yet — the
 *  repository directory is the honest address until a listing exists. */
export const EXTENSION_URL = 'https://github.com/nyblnet/bento/tree/main/home/webext'

export type HintKind = 'save' | 'update'
/** the app's translator, passed in: this module runs in node without the catalogs */
export type T = (key: string) => string

export const extensionWouldHelp = (): boolean =>
  typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'
  && typeof location !== 'undefined' && location.protocol === 'file:'
  && !(window as { __bentoHost?: unknown }).__bentoHost

const key = (kind: HintKind) => `bento-ext-hint-${kind}`
export const hintDismissed = (kind: HintKind): boolean => lsGet(key(kind)) === 'off'
export const dismissHint = (kind: HintKind): void => { lsSet(key(kind), 'off') }

/** The sentence for each moment. Exported for the rig. */
export const hintText = (kind: HintKind, t: T): string => kind === 'save'
  ? t('You picked the file you already had open. With the bento/home extension, ⌘S writes it in place — no picker — updates land in place with a backup beside them, and the Assistant runs on Chrome’s on-device model.')
  : t('With the bento/home extension this update rewrites the file in place, backup beside it — no picker — and the Assistant runs on Chrome’s on-device model.')

const el = (tag: string, cls: string, text?: string) => { const n = document.createElement(tag); n.className = cls; if (text) n.textContent = text; return n }

/**
 * The hint as a line: the sentence, "Get the extension" (a new tab) and
 * "Not now" (remembered). Null when it should not be shown. `onDismiss`
 * lets a container remove itself.
 */
export function extensionHint(kind: HintKind, t: T, onDismiss?: () => void): HTMLElement | null {
  if (!extensionWouldHelp() || hintDismissed(kind)) return null
  const line = el('div', `ed-exthint ed-exthint-${kind}`)
  line.appendChild(el('span', 'ed-exthint-text', hintText(kind, t)))
  const get = document.createElement('button')
  get.type = 'button'
  get.className = 'ed-btn ed-btn-primary ed-exthint-get'
  get.textContent = t('Get the extension')
  get.addEventListener('click', () => window.open(EXTENSION_URL, '_blank', 'noopener'))
  const not = document.createElement('button')
  not.type = 'button'
  not.className = 'ed-btn ed-exthint-not'
  not.textContent = t('Not now')
  not.addEventListener('click', () => { dismissHint(kind); line.remove(); onDismiss?.() })
  line.append(get, not)
  return line
}
