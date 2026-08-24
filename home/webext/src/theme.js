// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Light, dark, or whatever the browser is doing.
//
// A CLASSIC SCRIPT, NOT A MODULE, AND LOADED IN <head>. Every other file here
// is an ES module, which the browser defers until after the document parses —
// and a theme applied after the first paint is a white flash on a dark
// machine, every single time a surface opens. A blocking head script runs
// before the body exists, so the very first paint is already correct. An
// inline script would do the same job in one line and is forbidden: MV3's
// content security policy allows extension-local files ('self') and nothing
// else, so this is a file.
//
// WHY localStorage, WHEN EVERY OTHER PREFERENCE HERE LIVES IN IndexedDB.
// Because IndexedDB is asynchronous and this decision has to be made before
// the browser paints. localStorage is synchronous, and extension pages share
// one origin — so home.html and panel.html agree without any message passing.
// Reading the PROPERTY can throw where site data is blocked, so every access
// is guarded: a theme is worth less than a working page.
//
// SEMANTICS MIRROR `kernel/src/theme.ts`, deliberately. That module cannot be
// imported (it is TypeScript, and this directory ships plain .js with no build
// step), so the three states, the storage key and the two attributes it sets
// are reproduced here rather than reinvented.
;(() => {
  const KEY = 'bento-theme'
  const read = () => { try { return localStorage.getItem(KEY) } catch { return null } }
  const write = (v) => {
    try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY) }
    catch { /* the preference simply is not remembered */ }
  }
  const media = () => {
    try { return matchMedia('(prefers-color-scheme: dark)') } catch { return null }
  }

  /** What the user asked for — 'auto' unless they chose otherwise. */
  const choice = () => {
    const v = read()
    return v === 'light' || v === 'dark' ? v : 'auto'
  }
  /** What that resolves to right now, given the browser. */
  const resolved = (c) => {
    const want = c ?? choice()
    return want !== 'auto' ? want : (media()?.matches ? 'dark' : 'light')
  }

  /**
   * `data-theme` is what ui.css keys off. `color-scheme` is what makes the
   * BROWSER's own furniture follow — scrollbars, <select> popups, the canvas
   * behind a rubber-band scroll. Without it a dark page keeps light scrollbars
   * and light dropdowns, and looks broken in exactly the places CSS cannot
   * reach. The tray shipped without it: two scrollers and two selects.
   */
  const apply = (c) => {
    const t = resolved(c)
    const root = document.documentElement
    root.dataset.theme = t
    root.style.colorScheme = t
    return t
  }

  const set = (c) => {
    write(c === 'auto' ? null : c)
    return apply(c)
  }

  // While the choice is 'auto', follow the browser as it changes — otherwise a
  // window left open across sunset keeps yesterday's answer.
  try { media()?.addEventListener('change', () => { if (choice() === 'auto') apply() }) }
  catch { /* older engines: the next page load picks it up */ }

  apply()
  globalThis.bentoTheme = { CHOICES: ['auto', 'light', 'dark'], choice, resolved, set, apply }
})()
