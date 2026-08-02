// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Internationalization, Bento-sized: a ~1KB t() with English-string-as-key
// (gettext philosophy — the source stays readable, fallback is free), catalogs
// compiled into the bundle (self-containment: nothing is fetched), and locale
// resolution that follows the VIEWER (navigator.language, with a per-browser
// override). Language never enters the document format — a deck authored in
// Tokyo opens with French chrome in Paris.
//
// The ENGINE lives here; the CATALOGS are per-app string data and stay in the
// app (slides/src/i18n/*.ts), registered at boot via registerI18n(). Apps
// import their own ./i18n facade, never this module directly — the facade is
// what guarantees catalogs are registered before the first t().
//
// Locale resolution is LAZY on purpose: it depends on the catalog registry
// (navigator.language only wins if we actually have that catalog), so
// resolving at module scope would run against an empty registry and silently
// fall everyone back to English. Registration also clears the memo.


import { lsDel, lsGet, lsSet } from './storage.ts'

export type Catalog = Record<string, string>
export interface LocaleChoice { code: string; label: string }

/**
 * Key-once catalog shape. English-string-as-key means the source sentence is
 * the key in EVERY locale, so N catalogs store the same English text N times —
 * and deflate can't dedupe it (32KB window vs catalogs spanning hundreds of
 * KB). Packing stores each key once with translations positional by `locales`;
 * a 0, a short row, or an absent key all mean "fall back to English".
 */
export interface PackedCatalogs {
  locales: readonly string[]
  table: Record<string, ReadonlyArray<string | 0>>
  /** extra locale codes mapping onto a column, e.g. { 'zh-TW': 'zh-Hant' } */
  alias?: Record<string, string>
}

/** A language pack: one language, loaded at runtime rather than bundled. */
export interface LanguagePack {
  /** app this pack was built for — rejected if it isn't ours */
  app?: string
  /** app version it was built against; older is fine, it degrades per string */
  version?: string
  lang: string
  /** picker label in its own language ("한국어") */
  label?: string
  strings: Catalog
}

let CATALOGS: Record<string, Catalog> = {}
let PACKED: PackedCatalogs | null = null
/** locale code -> column index in PACKED.table rows */
let COLUMN: Record<string, number> = {}
/**
 * Runtime-loaded packs, keyed by language. Consulted BEFORE the bundled core
 * so a pack can also correct a bundled language without an app release —
 * see docs/i18n-packs.md. Packs are additive: an app that never loads one
 * behaves exactly as if this didn't exist.
 */
let PACKS: Record<string, Catalog> = {}
let CHOICES: LocaleChoice[] = [{ code: 'en', label: 'English' }]

/**
 * Register this app's catalogs + picker choices. Call once, at boot.
 * Takes either `catalogs` (plain per-locale maps) or `packed` (key-once).
 */
export function registerI18n(opts: {
  catalogs?: Record<string, Catalog>
  packed?: PackedCatalogs
  choices: LocaleChoice[]
}): void {
  CATALOGS = opts.catalogs ?? {}
  PACKED = opts.packed ?? null
  COLUMN = {}
  if (PACKED) {
    PACKED.locales.forEach((code, i) => { COLUMN[code] = i })
    for (const [from, to] of Object.entries(PACKED.alias ?? {})) {
      const i = PACKED.locales.indexOf(to)
      if (i >= 0) COLUMN[from] = i
    }
  }
  CHOICES = opts.choices
  // A pack loaded BEFORE registration (block order in the shell is not
  // guaranteed) would otherwise lose its picker entry when CHOICES is
  // replaced. Re-append any pack language the new choices don't mention.
  for (const lang of Object.keys(PACKS)) {
    if (!CHOICES.some((c) => c.code === lang)) CHOICES = [...CHOICES, { code: lang, label: lang }]
  }
  current = null // re-resolve: the registry the resolution depends on just changed
}

/**
 * Load a language pack (docs/i18n-packs.md). Additive and idempotent-ish:
 * later loads of the same language merge over earlier ones.
 *
 * Deliberately tolerant. A pack built against an older app version simply
 * lacks the newer keys, and every miss falls through to the bundled core and
 * then to the English key — so a stale pack degrades string by string instead
 * of failing to load. That tolerance is what lets packs be released on their
 * own cadence.
 *
 * Returns false if the pack is for a different app, which is the one case
 * worth rejecting outright: its keys would be wrong, not merely missing.
 */
export function addPack(pack: LanguagePack, appName?: string): boolean {
  if (!pack?.lang || !pack.strings) return false
  if (appName && pack.app && pack.app !== appName) return false
  PACKS[pack.lang] = { ...(PACKS[pack.lang] ?? {}), ...pack.strings }
  if (pack.label && !CHOICES.some((c) => c.code === pack.lang)) {
    CHOICES = [...CHOICES, { code: pack.lang, label: pack.label }]
  }
  current = null // a newly available locale can change what resolve() picks
  return true
}

/**
 * Drop a loaded pack. Removes its picker entry too — unless the language is
 * ALSO in the bundled core, in which case the pack was only correcting it and
 * the core entry must survive. Falls the active locale back to English if the
 * language just disappeared underneath it.
 */
export function removePack(lang: string): boolean {
  if (!PACKS[lang]) return false
  delete PACKS[lang]
  const stillBundled = PACKED ? COLUMN[lang] !== undefined : !!CATALOGS[lang]
  if (!stillBundled) {
    CHOICES = CHOICES.filter((c) => c.code !== lang)
    if (current === lang) setLocale('en')
  }
  current = null
  return true
}

/** Languages available only because a pack was loaded. */
export const loadedPacks = (): string[] => Object.keys(PACKS)

/** Do we actually carry strings for this locale code? Drives resolve(). */
function hasLocale(code: string): boolean {
  if (PACKS[code]) return true
  return PACKED ? COLUMN[code] !== undefined : !!CATALOGS[code]
}

/** The translation for `en` in the active locale, or undefined to fall back. */
function lookup(en: string, loc: string): string | undefined {
  // packs first: a pack may add a language OR correct a bundled one
  const fromPack = PACKS[loc]?.[en]
  if (fromPack !== undefined) return fromPack
  if (PACKED) {
    const col = COLUMN[loc]
    if (col === undefined) return undefined
    const hit = PACKED.table[en]?.[col]
    return hit === 0 || hit === undefined ? undefined : hit
  }
  return CATALOGS[loc]?.[en]
}

/** Locales offered in the picker (label in its own language). */
export const localeChoices = (): LocaleChoice[] => CHOICES

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
  const saved = lsGet('bento-lang')
  if (saved) return saved
  const nav = navigator.language || 'en'
  if (hasLocale(nav)) return nav
  const base = nav.split('-')[0]
  if (base === 'zh') return 'zh-Hans'
  return hasLocale(base) ? base : 'en'
}

let current: string | null = null

function activeLocale(): string {
  if (current === null) current = resolve()
  return current
}

export const locale = (): string => activeLocale()

/** Persist the override and switch. Callers re-render their own UI. */
export function setLocale(code: string): void {
  if (code === 'en') lsDel('bento-lang')
  else lsSet('bento-lang', code)
  current = code
}

/** Translate an English source string, then interpolate {placeholders}. */
export function t(en: string, vars?: Record<string, string | number>): string {
  const cur = activeLocale()
  let out = cur === 'x-pseudo' ? pseudo(en) : (lookup(en, cur) ?? en)
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v))
  }
  return out
}

// dev convenience: window.bento.i18n exposes locale switching for testing;
// the pseudo locale is reachable by setLocale('x-pseudo') in any build.
export const i18nApi = { t, locale, setLocale, choices: localeChoices, addPack, removePack, loadedPacks }
