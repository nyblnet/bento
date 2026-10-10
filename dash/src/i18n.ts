// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Facade: the i18n ENGINE lives in the shared kernel; CATALOGS are per-app
// string data and live here. This module registers them at import time and
// re-exports the engine, so registration is guaranteed to precede the first
// t() call by ES module evaluation order. App code imports './i18n', never the
// kernel module directly — that would bypass this registration.
//
// The per-locale catalogs in ./i18n/*.ts are the SOURCE OF TRUTH: that is what
// a translator reviews and what a contributor submits. What SHIPS is the
// key-once packing of them in ./i18n/packed.ts, because English-string-as-key
// means the same English sentence is a key in all seven catalogs and deflate
// cannot dedupe across its 32KB window. Regenerate after editing a catalog:
//
//     node scripts/test-dash-i18n.ts --write
//
// and the same script, run without --write, is the guard: it sweeps every t()
// out of dash/src, fails on a catalog key that no longer matches a source
// string, and fails on a {placeholder} that a translation dropped or renamed.
//
// LANGUAGE NEVER ENTERS THE DOCUMENT. It follows the VIEWER (navigator.language,
// with a per-browser 'bento-lang' override and the picker in About) — a
// platform invariant, not a preference, exactly like the theme. A workbook
// written in Osaka opens with German chrome in Hamburg and the bytes on disk
// are identical.

import { PACKED, PACKED_LOCALES } from './i18n/packed.ts'
import { registerI18n } from '../../kernel/src/i18n.ts'
import type { LocaleChoice } from '../../kernel/src/i18n.ts'

/** Locales offered in the About picker (each label in its own language). */
const CHOICES: LocaleChoice[] = [
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'zh-Hans', label: '简体中文' },
  { code: 'zh-Hant', label: '繁體中文' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'de', label: 'Deutsch' },
]

registerI18n({
  packed: {
    locales: PACKED_LOCALES,
    table: PACKED,
    // navigator.language is a full tag. Without these, a zh-TW reader falls
    // back to English rather than to the Traditional column that is right
    // there — the base-language fallback in the kernel only reaches 'zh'.
    alias: {
      zh: 'zh-Hans',
      'zh-CN': 'zh-Hans',
      'zh-SG': 'zh-Hans',
      'zh-TW': 'zh-Hant',
      'zh-HK': 'zh-Hant',
      'zh-MO': 'zh-Hant',
    },
  },
  choices: CHOICES,
})

export const LOCALE_CHOICES = CHOICES

export { t, locale, setLocale, i18nApi, localeChoices } from '../../kernel/src/i18n.ts'
export type { Catalog } from '../../kernel/src/i18n.ts'
