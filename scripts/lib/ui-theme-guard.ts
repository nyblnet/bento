// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE SHARED THEMING GUARD for the kernel UI primitives. Factored out of
// test-ui-menu.ts and test-ui-panel.ts, which each grew an identical copy
// (the menu primitive landed first; the panel primitive reproduced it because
// the menu's rig was not yet on main to import from).
//
// WHAT IT PINS — one property, stated plainly so this does not inherit the
// "all four guards" overclaim shape the vouch rig's label once had: **every
// colour a primitive's CSS paints must resolve, for each of the four apps, to a
// token that app both DEFINES and THEMES.** That is the whole guarantee. It is
// what makes a primitive adoptable without touching an app's palette: the
// primitive reads through a `--<prefix>-*` custom property whose fallback chain
// lands on the host app's own token, so the primitive commits to no colour and
// no theme mechanism of its own.
//
// It does NOT pin how an app themes (the four use three mechanisms —
// `[data-theme="dark"]`, a `prefers-color-scheme` media query, `light-dark()`),
// only THAT the token it lands on is themed by one of them. And it says nothing
// about non-colour values (radius, gap, z-index): those are the same in both
// themes by design and their chains, being literals, carry no token to check.
//
// The check is returned as a list of results rather than asserted here, so each
// rig reports them through its own `ok()` — the two rigs spell that helper with
// opposite argument orders, and a shared guard should not care.

import { readFileSync } from 'node:fs'

export interface ThemeResult { pass: boolean; msg: string }

/** Every `--<prefix>-<prop>` chain in the primitive's CSS, with the host tokens
 *  its fallback falls through to (in order). A chain whose fallback is a bare
 *  literal — a radius, a z-index — carries no token and is dropped. */
export function themedChains(cssText: string, prefix: string): Array<{ prop: string; tokens: string[] }> {
  const out: Array<{ prop: string; tokens: string[] }> = []
  const re = new RegExp(`var\\(\\s*--${prefix}-([a-z0-9-]+)\\s*,([^\\n]*)`, 'g')
  for (const m of cssText.matchAll(re)) {
    // Digits are part of a token name (`--chrome-2`); an earlier version of this
    // regex stopped at the digit and reported a token nobody defines.
    // Exclude the primitive's OWN properties: a fallback like
    // `calc(var(--bkm-bar-bottom, 56px) + var(--bkm-gap, 6px))` mentions
    // --bkm-gap, which is ours, not a host token to resolve.
    const tokens = [...m[2].matchAll(/var\(\s*(--[a-z0-9-]+)/g)]
      .map((t) => t[1])
      .filter((t) => !t.startsWith(`--${prefix}-`))
    if (tokens.length) out.push({ prop: m[1], tokens })
  }
  return out
}

/** The tokens an app's stylesheet DEFINES, and the subset it THEMES — by any of
 *  the three mechanisms: `light-dark()` in the value, or a re-declaration inside
 *  a `[data-theme="dark"]` block or a dark `prefers-color-scheme` media query. */
export function tokensOf(cssPath: string): { all: Set<string>; themed: Set<string> } {
  const src = readFileSync(cssPath, 'utf8')
  const all = new Set<string>()
  const themed = new Set<string>()
  for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    all.add(m[1])
    if (m[2].includes('light-dark(')) themed.add(m[1])
  }
  // Brace-count from each dark block so a nested rule inside a media query is
  // still counted as part of it.
  for (const start of src.matchAll(/\[data-theme=["']dark["']\][^{]*\{|@media[^{]*prefers-color-scheme:\s*dark[^{]*\{/g)) {
    let depth = 0
    let i = start.index! + start[0].length - 1
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (!depth) break }
    }
    for (const m of src.slice(start.index!, i).matchAll(/(--[a-z0-9-]+)\s*:/g)) themed.add(m[1])
  }
  return { all, themed }
}

export interface GuardOpts {
  /** Path to the primitive's CSS. */
  cssPath: string
  /** The primitive's custom-property prefix, e.g. 'bkm' or 'bkp'. */
  prefix: string
  /** Chain props whose landing token must be THEMED, not merely defined —
   *  the colours. A prop outside this set is only checked for "defines". */
  colourProps: Set<string>
  /** Paths to each app's stylesheet, keyed by app name for the messages. */
  appStyles: Record<string, string>
  /** Chain props to skip entirely — e.g. `shadow`, where the literal fallback
   *  is the intended value for apps with no shadow token. */
  exempt?: Set<string>
}

/**
 * Run the guard and return one result per assertion. `pass` false is a
 * regression; `msg` names the chain and the app. The caller reports each
 * through its own `ok()`.
 */
export function checkThemedChains(opts: GuardOpts): ThemeResult[] {
  const results: ThemeResult[] = []
  const chains = themedChains(readFileSync(opts.cssPath, 'utf8'), opts.prefix)
  const exempt = opts.exempt ?? new Set<string>()
  results.push({ pass: chains.length >= 1, msg: `found ${opts.prefix} colour chains to check (${chains.length})` })
  for (const [app, stylePath] of Object.entries(opts.appStyles)) {
    const { all, themed } = tokensOf(stylePath)
    for (const { prop, tokens } of chains) {
      if (exempt.has(prop)) continue
      const defined = tokens.find((t) => all.has(t))
      results.push({ pass: !!defined, msg: `${app}: --${opts.prefix}-${prop} reaches a token ${app} defines (${tokens.join(' → ')})` })
      if (!defined || !opts.colourProps.has(prop)) continue
      results.push({ pass: themed.has(defined), msg: `${app}: --${opts.prefix}-${prop} lands on ${defined}, which ${app} themes` })
    }
  }
  return results
}
