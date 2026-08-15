// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Every word the extension says, in the reader's language.
//
// WHY NOT THE APP'S SYSTEM. `slides/src/i18n.ts` uses the English string as the
// key, compiles catalogues into the bundle, and lets the VIEWER pick a language
// at runtime. That design exists because a document travels: it is opened by
// people who did not write it, on machines that are not the author's, and the
// reader chooses. An extension does not travel. It belongs to one browser, and
// browser chrome should speak the browser's language — which is exactly what
// `chrome.i18n` does, and the only mechanism that can also localise the store
// listing.
//
// The cost, accepted deliberately: `chrome.i18n` has NO runtime switching. There
// is no language picker here as there is in the app's About dialog, because
// Chrome resolves the locale once at load from its own UI language. Anyone who
// wants the extension in another language changes it in Chrome, which is where
// they would look.
//
// A MISSING KEY SHOWS ITSELF. `getMessage` returns an empty string for a key it
// does not know, so a typo silently blanks a button. Falling back to the key
// name makes it read `helpAboutTitle` instead — ugly on purpose, and impossible
// to miss in review.

/**
 * One message, with positional substitutions.
 *
 *   t('foundFolders', 2)  ->  "Found 2 folders"
 *
 * Chrome takes substitutions as strings, so numbers are coerced here rather
 * than at every call site.
 */
export const t = (key, ...subs) => {
  try {
    return chrome.i18n.getMessage(key, subs.map((s) => String(s))) || key
  } catch {
    return key // no chrome.i18n: a test rig, or a page loaded outside the extension
  }
}

/**
 * Fill the static markup.
 *
 * Chrome substitutes `__MSG_x__` in the manifest and in CSS, but NOT in HTML —
 * so anything written into a page has to be filled at load. Attributes are
 * separate because a placeholder and a title are not text nodes and would
 * otherwise have to be set from script, scattering strings back into the code
 * this exists to keep them out of.
 *
 *   <h1 data-i18n="helpTitle"></h1>
 *   <input data-i18n-placeholder="searchPlaceholder">
 *   <button data-i18n-title="moreActions">…</button>
 *
 * `data-i18n-html` exists for the few strings carrying <b> or <code>. The
 * source is our own catalogue, never a document or a message, so it is markup
 * we wrote — but it is a separate attribute so that using it is a decision
 * rather than the default.
 */
/**
 * Right-to-left, when the browser's language is.
 *
 * The app already does this deliberately (`slides/src/i18n.ts RTL_LANGS`), and
 * the extension shipped Arabic, Persian, Hebrew and Urdu catalogues into a
 * layout that was left-to-right in fourteen places. Setting `dir` is only half
 * of it — the CSS had to stop naming sides, which is why it uses
 * `inset-inline-start` and `text-align: start` rather than `left`.
 *
 * `chrome.i18n.getUILanguage()` is the browser's language, which is the one
 * Chrome resolved the catalogue from, so the direction cannot disagree with the
 * words on screen.
 */
const RTL = new Set(['ar', 'fa', 'he', 'iw', 'ur', 'ps', 'sd', 'ug', 'yi'])

export function applyDirection(root = document) {
  try {
    const lang = chrome.i18n.getUILanguage()
    root.documentElement.lang = lang
    root.documentElement.dir = RTL.has(lang.split('-')[0].toLowerCase()) ? 'rtl' : 'ltr'
  } catch {
    /* no chrome.i18n: leave the document as authored */
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
