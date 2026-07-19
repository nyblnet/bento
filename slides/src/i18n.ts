// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// Internationalization, Bento-sized: a ~1KB t() with English-string-as-key
// (gettext philosophy — the source stays readable, fallback is free), catalogs
// compiled into the bundle (self-containment: nothing is fetched), and locale
// resolution that follows the VIEWER (navigator.language, with a per-browser
// override from the About dialog). Language never enters the document format —
// a deck authored in Tokyo opens with French chrome in Paris.
//
// Catalogs live in src/i18n/<locale>.ts as flat Record<english, translation>.
// Missing keys fall back to English automatically. {name} placeholders are
// interpolated after lookup. Plurals: we sidestep via wording ("Slides: {n}")
// — revisit with Intl.PluralRules if a real plural ever appears.

import { ja } from './i18n/ja'
import { zhHans } from './i18n/zh-Hans'
import { es } from './i18n/es'
import { fr } from './i18n/fr'
import { de } from './i18n/de'
import { zhHant } from './i18n/zh-Hant'
import { it } from './i18n/it'

export type Catalog = Record<string, string>

const CATALOGS: Record<string, Catalog> = {
  ja,
  'zh-Hans': zhHans,
  zh: zhHans, // zh, zh-CN, zh-SG → simplified
  'zh-Hant': zhHant,
  'zh-TW': zhHant,
  'zh-HK': zhHant,
  it,
  es,
  fr,
  de,
}

/** Locales offered in the About picker (label in its own language). */
export const LOCALE_CHOICES: Array<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'zh-Hans', label: '简体中文' },
  { code: 'zh-Hant', label: '繁體中文' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'de', label: 'Deutsch' },
]

/** Accented pseudo-locale (dev builds only): exposes unswept strings and
 *  layouts that break under longer text. */
const pseudo = (s: string): string =>
  '⟦' +
  s.replace(/[a-zA-Z]/g, (c) => {
    const map: Record<string, string> = {
      a: 'à', e: 'ē', i: 'ï', o: 'ő', u: 'ū', c: 'ĉ', n: 'ñ', s: 'š', y: 'ý',
      A: 'Å', E: 'Ê', I: 'Ì', O: 'Ø', U: 'Ü', C: 'Ç', N: 'Ñ', S: 'Š', Y: 'Ÿ',
    }
    return map[c] ?? c
  }) +
  '⟧'

function resolve(): string {
  const saved = localStorage.getItem('bento-lang')
  if (saved) return saved
  const nav = navigator.language || 'en'
  if (CATALOGS[nav]) return nav
  const base = nav.split('-')[0]
  if (base === 'zh') return 'zh-Hans'
  return CATALOGS[base] ? base : 'en'
}

let current = resolve()

export const locale = (): string => current

/** Persist the override and switch. Callers re-render their own UI. */
export function setLocale(code: string): void {
  if (code === 'en') localStorage.removeItem('bento-lang')
  else localStorage.setItem('bento-lang', code)
  current = code
}

/** Translate an English source string, then interpolate {placeholders}. */
export function t(en: string, vars?: Record<string, string | number>): string {
  let out =
    current === 'x-pseudo' ? pseudo(en) : (CATALOGS[current]?.[en] ?? en)
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v))
  }
  return out
}

// dev convenience: window.bento.i18n exposes locale switching for testing;
// the pseudo locale is reachable by setLocale('x-pseudo') in any build.
export const i18nApi = { t, locale, setLocale, choices: LOCALE_CHOICES }
