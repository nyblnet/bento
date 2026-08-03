// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Facade: the i18n ENGINE lives in the shared kernel; CATALOGS are per-app
// string data and live here. This module registers them at import time and
// re-exports the engine, so registration is guaranteed to precede the first
// t() call by ES module evaluation order.
//
// No translations yet — English-string-as-key means every string
// works untranslated, and catalogs can be added later without touching call
// sites. App code imports './i18n', never the kernel module directly.

import { registerI18n } from '../../kernel/src/i18n.ts'
import type { LocaleChoice } from '../../kernel/src/i18n.ts'

const CHOICES: LocaleChoice[] = [{ code: 'en', label: 'English' }]

registerI18n({ catalogs: {}, choices: CHOICES })

export const LOCALE_CHOICES = CHOICES

export { t, locale, setLocale, i18nApi, localeChoices } from '../../kernel/src/i18n.ts'
export type { Catalog } from '../../kernel/src/i18n.ts'
