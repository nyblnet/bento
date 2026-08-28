// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Every word the extension says, in the reader's language.
//
// WHERE THE LANGUAGE COMES FROM. `chrome.i18n` resolves the catalogue once, at
// load, from the BROWSER'S UI LANGUAGE — and offers no way to change it. That
// is the right default (browser chrome should speak the browser's language, and
// it is the only mechanism that can also localise the store listing) but on
// macOS the browser's UI language is the system's, so a user who wants the
// extension in another language has to restart their whole computer in it.
// bento/slides has a picker; this had nothing.
//
// So there are two paths now:
//
//   · AUTOMATIC (the default, and what every existing install keeps doing) —
//     `chrome.i18n.getMessage`, exactly as before.
//   · AN EXPLICIT CHOICE — we fetch `_locales/<code>/messages.json` out of our
//     own package and read from that instead. `getMessage` cannot be pointed at
//     another locale, so serving the catalogue ourselves is the only way.
//
// WHAT A CHOICE CANNOT REACH. `__MSG_appName__` and `__MSG_appDesc__` live in
// the manifest and are resolved by Chrome, not by us — so the extension's name
// and description on the chrome://extensions card, in the toolbar tooltip and
// in the Web Store stay in the browser's UI language whatever is picked here.
// That is a limit of the platform, not an oversight: there is no API that
// re-resolves a manifest string.
//
// A MISSING KEY SHOWS ITSELF. `getMessage` returns an empty string for a key it
// does not know, so a typo silently blanks a button. Falling back to the key
// name makes it read `helpAboutTitle` instead — ugly on purpose, and impossible
// to miss in review.

import { GRANT, get, put } from './db.js'

/** Every catalogue in the package. Kept in step by scripts/test-webext-i18n.ts. */
export const LOCALES = [
  'ar', 'bn', 'da', 'de', 'en', 'es', 'fa', 'fi', 'fil', 'fr', 'he', 'hi', 'id',
  'it', 'ja', 'ko', 'ms', 'nb', 'nl', 'pl', 'pt_BR', 'ru', 'sv', 'th', 'tr',
  'uk', 'ur', 'vi', 'zh_CN', 'zh_TW',
]

/** `_locales` uses underscores; BCP-47 (and Intl) wants hyphens. */
const tag = (code) => code.replace('_', '-')

/**
 * What a language calls ITSELF.
 *
 * Derived rather than translated: a list of 30 language names, in each of 30
 * languages, is 900 strings nobody can check. `Intl.DisplayNames` asked for a
 * language in its own locale gives the endonym — 日本語, العربية — which is
 * also what a picker should show, because the person looking for their language
 * is not currently reading the one the UI is in.
 */
export function localeLabel(code) {
  try {
    const name = new Intl.DisplayNames([tag(code)], { type: 'language' }).of(tag(code))
    return name ? name[0].toLocaleUpperCase(tag(code)) + name.slice(1) : code
  } catch {
    return code
  }
}

let catalogue = null   // the fetched override catalogue, or null when automatic
let activeCode = null  // the override's code, or null when automatic

/** The language actually in use — the override, else whatever Chrome resolved. */
export function currentLocale() {
  if (activeCode) return activeCode
  try { return chrome.i18n.getUILanguage() } catch { return 'en' }
}

/** null when following the browser; otherwise the explicitly chosen code. */
export const localeOverride = () => activeCode

async function fetchCatalogue(code) {
  const res = await fetch(chrome.runtime.getURL(`_locales/${code}/messages.json`))
  if (!res.ok) throw new Error(`messages.json ${res.status}`)
  return res.json()
}

/**
 * Load any saved choice. Call — and await — before the first render, or the
 * page paints in one language and switches to another a moment later.
 */
export async function initI18n() {
  try {
    const saved = await get(GRANT, 'lang')
    if (saved && LOCALES.includes(saved)) {
      catalogue = await fetchCatalogue(saved)
      activeCode = saved
    }
  } catch {
    // An unreadable store or a missing catalogue is not worth a broken page:
    // fall back to the browser's own resolution, which always works.
    catalogue = null
    activeCode = null
  }
}

/**
 * Choose a language, or pass null to go back to following the browser.
 * Callers re-render their own UI (see `applyLocale` in home.js).
 */
export async function setLocale(code) {
  if (!code) {
    catalogue = null
    activeCode = null
    await put(GRANT, 'lang', null)
    return
  }
  if (!LOCALES.includes(code)) return
  catalogue = await fetchCatalogue(code)
  activeCode = code
  await put(GRANT, 'lang', code)
}

/**
 * One message, with positional substitutions.
 *
 *   t('foundFolders', 2)  ->  "Found 2 folders"
 *
 * Chrome takes substitutions as strings, so numbers are coerced here rather
 * than at every call site. When an override is active we do the `$1` expansion
 * ourselves, because `getMessage` is doing none of the work.
 */
export const t = (key, ...subs) => {
  const s = subs.map((x) => String(x))
  const own = catalogue?.[key]?.message
  // `$$` is Chrome's escape for a literal dollar; expand placeholders first and
  // unescape after, so a translated "$$5" cannot be read as a substitution.
  if (own) return own.replace(/\$(\d)/g, (_, n) => s[Number(n) - 1] ?? '').replace(/\$\$/g, '$')
  try {
    return chrome.i18n.getMessage(key, s) || key
  } catch {
    return key // no chrome.i18n: a test rig, or a page loaded outside the extension
  }
}

/**
 * Right-to-left, when the chosen language is.
 *
 * The app already does this deliberately (`slides/src/i18n.ts RTL_LANGS`), and
 * the extension shipped Arabic, Persian, Hebrew and Urdu catalogues into a
 * layout that was left-to-right in fourteen places. Setting `dir` is only half
 * of it — the CSS had to stop naming sides, which is why it uses
 * `inset-inline-start` and `text-align: start` rather than `left`.
 *
 * Reads `currentLocale()` rather than `getUILanguage()` directly, so an
 * explicit choice of Arabic mirrors the layout even though Chrome's own UI is
 * still in English. Getting this wrong is invisible in English and total in
 * Arabic.
 */
const RTL = new Set(['ar', 'fa', 'he', 'iw', 'ur', 'ps', 'sd', 'ug', 'yi'])

export function applyDirection(root = document) {
  const lang = currentLocale()
  try {
    root.documentElement.lang = tag(lang)
    root.documentElement.dir = RTL.has(lang.split(/[-_]/)[0].toLowerCase()) ? 'rtl' : 'ltr'
  } catch {
    /* no document to mark up */
  }
}

export function localize(root = document) {
  applyDirection(root)
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n)
  }
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    el.innerHTML = t(el.dataset.i18nHtml)
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder)
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle)
  }
}
