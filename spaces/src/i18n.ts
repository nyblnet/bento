// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Facade: the i18n ENGINE lives in the shared kernel; CATALOGS are per-app
// string data and live here. This module registers them at import time and
// re-exports the engine, so registration is guaranteed to precede the first
// t() call by ES module evaluation order.
//
// ENGLISH-STRING-AS-KEY (gettext style): the source sentence IS the key, so a
// missing entry falls back to readable English rather than a blank. Never call
// t() in a module-level const — it would freeze at import time, before the
// viewer's locale is resolved.

import { registerI18n, locale } from '../../kernel/src/i18n.ts'
import type { LocaleChoice } from '../../kernel/src/i18n.ts'
// EXPLICIT `.ts`, like every other import in this app's newer files. It was
// extensionless, which node's strip-only TypeScript loader will not follow — so
// any module that reached t() (and canvas.ts does) could not be handed to a
// node rig at all, and scripts/test-spaces.mjs had to bundle it first. One
// character buys a whole subtree of the app back for direct testing.
import { PACKED, PACKED_LOCALES } from './i18n/packed.ts'

/** Offered in the About picker, each labelled in its own language. */
const CHOICES: LocaleChoice[] = [
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'zh-Hans', label: '简体中文' },
  { code: 'zh-Hant', label: '繁體中文' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
]

registerI18n({
  packed: {
    locales: PACKED_LOCALES,
    table: PACKED,
    // Regional codes a browser actually reports, mapped onto a column. Without
    // these, a zh-TW reader falls all the way back to English despite the
    // traditional catalog being right there.
    alias: {
      zh: 'zh-Hans',
      'zh-CN': 'zh-Hans',
      'zh-SG': 'zh-Hans',
      'zh-TW': 'zh-Hant',
      'zh-HK': 'zh-Hant',
      'zh-MO': 'zh-Hant',
      'pt-BR': 'pt',
      'pt-PT': 'pt',
    },
  },
  choices: CHOICES,
})

export const LOCALE_CHOICES = CHOICES

export { t, locale, setLocale, i18nApi, localeChoices } from '../../kernel/src/i18n.ts'
export type { Catalog } from '../../kernel/src/i18n.ts'

/** Languages whose CHROME reads right-to-left. */
const RTL = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi'])

export const isRtl = (code: string): boolean => RTL.has(code.split('-')[0].toLowerCase())

/**
 * Point the CHROME at the viewer's language (PLATFORM §8).
 *
 * Deliberately called AFTER capturePristine(): saves re-serialize the pristine
 * clone, so the dir/lang attributes never reach a saved file. Direction follows
 * the VIEWER; the DOCUMENT's own base direction is theme.dir, pinned on the
 * inner container by the renderer. Two different things that must never be
 * confused — a document does not mirror because its reader's UI does.
 */
export function applyDirection(): void {
  const code = locale()
  document.documentElement.lang = code
  document.documentElement.dir = isRtl(code) ? 'rtl' : 'ltr'
}
