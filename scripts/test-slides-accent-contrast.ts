#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The accent as TEXT: every use reads, in both themes.
//
//   node scripts/test-slides-accent-contrast.ts
//
// WHAT THIS PROVES. In dark theme `--accent-ink` was #3a2a00 — a colour meant
// for text ON the orange fill — while every place that used it as text sat on
// the dark chrome: the armed comment tool, the language menu's ✓, the comment
// popover's name. Measured 1.09:1, i.e. invisible, and shipped (found by the
// spaces chrome audit, working/design/chrome-unification.md). Now:
//
//   --accent-ink  accent-coloured text on the chrome's own surfaces (flips)
//   --accent-on   text sitting on the solid --accent fill (does not flip)
//
// The rig reads the real tokens out of slides/src/styles.css and checks:
//   1. every rule that sets `color: var(--accent-ink)` is on the AUDITED list
//      below, which names the surface it sits on — a new use goes red until
//      someone has looked at what is behind it;
//   2. each audited use reaches 4.5:1 (WCAG AA, normal text) in both themes;
//   3. text over the SLIDE (comment labels) carries the surface-coloured halo,
//      because the deck's background is nobody's token;
//   4. text on the orange fill uses --accent-on, reaches 4.5:1 there, and no
//      rule hard-codes the old #3a28xx/#3a2axx any more;
//   5. the focus outlines the kernel's toggle/menu draw from --accent-ink reach
//      3:1 on the chrome (WCAG non-text contrast).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'slides/src/styles.css'), 'utf8')

// --- tokens -------------------------------------------------------------------
const block = (sel: string) => {
  const i = css.indexOf(sel + ' {')
  if (i < 0) throw new Error('no block ' + sel)
  return css.slice(i, css.indexOf('}', i))
}
const tokens = (b: string) => Object.fromEntries([...b.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
const THEMES = {
  light: tokens(block(':root, :root[data-theme="light"]')),
  dark: tokens(block(':root[data-theme="dark"]')),
} as Record<string, Record<string, string>>

// --- colour maths (WCAG 2.x relative luminance) --------------------------------
type RGB = [number, number, number]
const hex = (h: string): RGB => { const s = h.replace('#', ''); const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) as RGB }
const lum = ([r, g, b]: RGB) => { const c = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }; return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b) }
const contrast = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
// color-mix(in srgb, A p%, transparent) painted over B
const over = (a: RGB, p: number, b: RGB): RGB => a.map((v, i) => Math.round(v * p + b[i] * (1 - p))) as RGB

// --- 1. every text use is audited --------------------------------------------
type Bg = 'surface' | 'chrome-tint-22' | 'chrome-tint-30' | 'over-slide'
const AUDITED: Record<string, Bg> = {
  '.ed-btn-armed': 'chrome-tint-22',           // the armed comment tool, on the topbar
  '.ed-lang-on::after': 'surface',             // the language menu's ✓
  '.ed-comment-me:hover': 'surface',           // your own name in a comment thread
  '.ed-comment-hl.slide': 'over-slide',        // "SLIDE" label on a whole-slide comment
  '.ed-comment-hl.pin': 'over-slide',          // coordinates beside a point comment
}
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim().split('\n').pop()!.trim(), body: m[2] }))
const inkText = rules.filter((r) => /(^|;|\s)color:\s*var\(--accent-ink\)/.test(r.body)).map((r) => r.sel)
const unaudited = inkText.filter((s) => !(s in AUDITED))
ok(unaudited.length === 0, `every accent-ink text use is audited (${inkText.length})${unaudited.length ? ' — new, look at its background: ' + unaudited.join(', ') : ''}`)
ok(Object.keys(AUDITED).every((s) => inkText.includes(s)), 'and every audited use still exists (remove it from the list when it goes)')

// --- 2 & 3. contrast of each use, both themes -------------------------------------
for (const [theme, t] of Object.entries(THEMES)) {
  const ink = hex(t['--accent-ink']), accent = hex(t['--accent'])
  // (the topbar paints --surface — measured in Chrome, both themes — so the
  // armed tool's 22%/30% accent tint sits over --surface, not --chrome)
  const bgOf = (bg: Bg): RGB => bg === 'surface' || bg === 'over-slide' ? hex(t['--surface'])
    : over(accent, bg === 'chrome-tint-22' ? 0.22 : 0.3, hex(t['--surface']))
  for (const [sel, bg] of Object.entries(AUDITED)) {
    const c = contrast(ink, bgOf(bg))
    ok(c >= 4.5, `${theme}: ${sel} on ${bg === 'over-slide' ? 'its surface-coloured halo' : bg} — ${c.toFixed(2)}:1`)
  }
  // the armed tool's hover is a deeper tint of the same text
  const hover = contrast(ink, bgOf('chrome-tint-30'))
  ok(hover >= 4.5, `${theme}: .ed-btn-armed:hover — ${hover.toFixed(2)}:1`)
  // 5. focus outlines (non-text) drawn from --accent-ink on the chrome
  for (const bg of ['--chrome', '--surface']) {
    const c = contrast(ink, hex(t[bg]))
    ok(c >= 3, `${theme}: a focus outline in --accent-ink on ${bg} — ${c.toFixed(2)}:1 (non-text, ≥3)`)
  }
  // 4. text on the orange
  const on = contrast(hex(t['--accent-on']), accent)
  ok(on >= 4.5, `${theme}: --accent-on on the --accent fill — ${on.toFixed(2)}:1`)
}
for (const sel of Object.entries(AUDITED).filter(([, bg]) => bg === 'over-slide').map(([s]) => s)) {
  const r = rules.find((x) => x.sel === sel)!
  ok(/text-shadow:\s*var\(--over-slide-halo\)/.test(r.body), `${sel} carries the surface halo (the slide behind it is the deck's colour, not a token)`)
}
ok(/--over-slide-halo:[^;]*var\(--surface\)/.test(css), 'the halo is drawn in --surface, so it follows the theme')

// --- 4. text on the fill uses the token -----------------------------------------
// every rule that puts text on the solid fill must read on it: --accent-on in
// the editor; the speaker view (its own popup document) spells a near-black
const onFill = rules.filter((r) => /background:\s*var\(--accent\)\s*;/.test(r.body) && /(^|;|\s)color:/.test(r.body))
for (const r of onFill) {
  const c = /(?:^|;|\s)color:\s*([^;]+)/.exec(r.body)![1].trim()
  const fg = c === 'var(--accent-on)' ? THEMES.dark['--accent-on'] : c
  const ratio = /^#[0-9a-f]{3,6}$/i.test(fg) ? contrast(hex(fg), hex(THEMES.dark['--accent'])) : 0
  ok(ratio >= 4.5, `${r.sel}: text on the accent fill (${c}) — ${ratio.toFixed(2)}:1`)
}
ok(['.ed-comment-chip', '.ed-step-badge.sel', '.ed-comment-marker'].every((s) => /color:\s*var\(--accent-on\)/.test(rules.find((r) => r.sel === s)?.body ?? '')), 'the editor\'s chips, badges and markers take --accent-on')
const hard = rules.filter((r) => !r.sel.startsWith(':root') && /color:\s*#3a2[0-9a-f]00/i.test(r.body)).map((r) => r.sel)
ok(hard.length === 0, `no rule hard-codes the old on-accent brown${hard.length ? ': ' + hard.join(', ') : ''}`)

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
