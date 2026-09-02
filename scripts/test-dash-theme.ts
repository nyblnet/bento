#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash theme rig — the palette contract, checked as text.
//
//   node scripts/test-dash-theme.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. A stylesheet has no type system and no runtime errors. Every
// failure this rig covers renders a page that LOOKS fine, which is why each of
// them shipped:
//
//   1. AN UNDECLARED TOKEN IS A DEAD RULE, SILENTLY. `color: var(--accent-ink)`
//      with no --accent-ink declared is not an error — the declaration is
//      invalid at computed-value time, the property falls back to `inherit`,
//      and the rule simply does nothing. dash shipped exactly this: two rules
//      in styles.css referenced --accent-ink, nothing ever declared it, and the
//      two marks they draw (a total that covers only part of a filtered sheet;
//      the "＋ add a total" invitation) had never once appeared. pivot.css's
//      `var(--ui, …)` was the same shape with a fallback, so the pivot rendered
//      off a stand-in font stack rather than the app's.
//   2. TWO APPS DRIFTING APART ONE GREY AT A TIME. bento/slides is the shipped
//      app and its palette is the suite's. dash had re-picked five of slides'
//      colours to neighbouring values — #f8fafc for #f5f7fa, #f1f5f9 for
//      #eceff4, #64748b for #5b6472 — none of them a decision anybody made, all
//      of them visible when the two apps sit side by side. So the LIGHT values
//      of the shared names are compared against slides' :root, in slides'
//      file, every run. A deliberate divergence is allowed, but it has to be
//      written down in DIVERGENCES below, with the reason.
//   3. A CONTRAST FLOOR THAT NOBODY RE-CHECKS. --muted carries 11–11.5px
//      captions and was 4.34:1 on --hover and 4.22:1 on --accent-wash — under
//      AA, on two of the grounds a caption most often lands on. Contrast is
//      arithmetic; it should not need a person with a colour picker.
//   4. A FOCUS RING THE KEYBOARD USER CANNOT SEE. The brand amber is 2.02:1 on
//      white, and WCAG 2.2 SC 1.4.11 asks 3:1 of a focus indicator. dash was
//      focusing with --accent in four places and with --sel-ring in two others,
//      i.e. it had two answers and one of them failed.
//   5. `light-dark()` IS A <color> FUNCTION AND NOTHING ELSE. Fed a number it
//      does not fail loudly — the declaration is invalid, the property takes
//      its initial value, and the effect is whatever that happens to be.
//      --bar-opacity hit this and spent a release fully opaque at 1.49:1. Any
//      non-colour token that varies by theme has to do it in a media query.

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dashDir = join(root, 'dash/src')
const slidesCss = join(root, 'slides/src/styles.css')

let checks = 0
let failures = 0
function ok(cond: unknown, what: string) {
  checks++
  if (cond) return
  failures++
  console.log(`  FAIL  ${what}`)
}

const files = readdirSync(dashDir).filter((f) => f.endsWith('.css')).sort()
const css = Object.fromEntries(files.map((f) => [f, readFileSync(join(dashDir, f), 'utf8')]))
const allCss = files.map((f) => css[f]).join('\n')

// ============================================================ 1 · every token resolves

/**
 * Custom properties WRITTEN BY SOMETHING OTHER THAN A STYLESHEET. Each is
 * listed with who writes it, because "add it to the allowlist" is otherwise the
 * easy way to make this rig say nothing.
 */
const SET_ELSEWHERE: Record<string, string> = {
  '--row-h': 'grid.ts setProperty from its ROW_H constant (styles.css carries a fallback)',
  '--dp-w': 'panels.ts, the dragged panel width',
  '--dbx-cols': 'dashboard.ts, the tile grid column count',
  '--tray-safe-top': 'bento/tray’s WKWebView host — tray/ios/EditorViewController.swift',
  '--tray-safe-right': 'bento/tray’s WKWebView host',
  '--tray-safe-bottom': 'bento/tray’s WKWebView host',
  '--tray-safe-left': 'bento/tray’s WKWebView host',
}

/**
 * COMMENTS ARE STRIPPED FIRST, and that is not tidiness.
 *
 * The pattern below is `--name:` preceded by whitespace, which a sentence
 * satisfies as readily as a declaration does. Writing `See --desk: an unbounded
 * sheet …` in a comment therefore DECLARED --desk as far as this rig was
 * concerned, and check 1 — the whole reason this file exists, the one that
 * caught two rules that had never drawn anything — went quiet for that token.
 * MEASURED: with the declaration deleted and only the prose left, the rig was
 * green. A guard a comment can switch off is worse than no guard, because it
 * is still reported as a pass.
 */
const declared = new Set<string>()
for (const text of Object.values(css)) {
  const body = text.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of body.matchAll(/(^|[;{\s])(--[a-z0-9-]+)\s*:/g)) declared.add(m[2])
}

console.log('every var() a dash stylesheet reads is declared by one of them')
{
  const used = new Map<string, string[]>()
  for (const [file, text] of Object.entries(css)) {
    for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
      const list = used.get(m[1]) ?? []
      if (!list.includes(file)) list.push(file)
      used.set(m[1], list)
    }
  }
  for (const [name, where] of [...used].sort()) {
    if (declared.has(name) || name in SET_ELSEWHERE) continue
    ok(false, `${name} is read by ${where.join(', ')} and declared nowhere — that rule does nothing`)
  }
  ok(true, `${used.size} distinct tokens read across ${files.length} stylesheets, all resolvable`)
  // and the allowlist is not allowed to rot either
  for (const [name, who] of Object.entries(SET_ELSEWHERE)) {
    ok(used.has(name), `${name} is still read by a stylesheet (written by ${who})`)
  }
}

// ============================================================ 2 · the suite's palette

/**
 * Parse the LIGHT `:root` blocks into name → raw value.
 *
 * The selector is a LIST, not a bare `:root` — slides gained an explicit dark
 * theme (#285) and now opens with `:root, :root[data-theme="light"] {`, which
 * a `/:root\s*\{/` pattern does not match. That is worth spelling out because
 * of how it failed: the rig did not error, it parsed ZERO variables and then
 * reported nine separate "slides declares --ink (has it been renamed?)"
 * failures — a broken parser wearing the costume of nine real findings.
 * `slides.size > 5` below is the check that tells the two apart, and it is why
 * it exists.
 *
 * The dark block is deliberately EXCLUDED. This rig diffs one light palette
 * against the other; letting `[data-theme="dark"]` in would silently overwrite
 * every light value with its dark counterpart and compare the wrong halves.
 */
function rootVars(text: string): Map<string, string> {
  const out = new Map<string, string>()
  // every light :root block in the file, not just the first — find.css adds two.
  for (const block of text.matchAll(/(^|\})\s*([^{}]*:root[^{}]*)\{([\s\S]*?)\n\}/gm)) {
    const selector = block[2]
    if (/\[data-theme\s*=\s*["']?dark/.test(selector)) continue
    const body = block[3].replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim())
  }
  return out
}

/** The light half of a `light-dark(a, b)` pair, or the value itself. */
function lightValue(v: string): string {
  const m = /^light-dark\(\s*([^,]+),/.exec(v)
  return (m ? m[1] : v).trim().toLowerCase()
}

/**
 * Names that mean the same thing in both apps. dash's name is on the left
 * because dash's stylesheets are what this rig reads; slides' name is the
 * value. Where dash carries slides' own name as an alias, both are checked.
 */
const SHARED: Record<string, string> = {
  '--ink': '--ink',
  '--ink-2': '--ink-2',
  '--line': '--line',
  '--muted': '--muted',
  '--accent': '--accent',
  '--accent-ink': '--accent-ink',
  '--panel': '--chrome',
  '--hover': '--chrome-2',
}

/**
 * Where dash departs from slides ON PURPOSE. A name here is exempt from the
 * comparison and must say why — an empty reason is a failure, because the
 * point of the list is the reason and not the exemption.
 */
const DIVERGENCES: Record<string, string> = {
  '--radius': 'slides has one radius (10px, its floating surfaces); dash splits the '
    + 'scale into --radius / --radius-lg / --radius-xl, and --radius is the CONTROL '
    + 'radius. Same numbers, different partition of them.',
  '--blue': 'dash declares it as an alias of --sel-ring (#2563eb, 5.17:1 on white) '
    + 'rather than slides\' #5b8def (3.23:1). Same job — focus and selection — and '
    + 'dash\'s value clears 4.5:1 where slides\' only clears 3:1.',
}

console.log('\nthe light palette is bento/slides\' palette')
{
  const dash = rootVars(allCss)
  const slides = rootVars(readFileSync(slidesCss, 'utf8'))
  ok(slides.size > 5, 'slides/src/styles.css :root was found and parsed')
  for (const [ours, theirs] of Object.entries(SHARED)) {
    const a = dash.get(ours)
    const b = slides.get(theirs)
    if (!a) { ok(false, `dash declares ${ours}`); continue }
    if (!b) { ok(false, `slides declares ${theirs} (has it been renamed?)`); continue }
    ok(lightValue(a) === lightValue(b),
      `${ours} is slides' ${theirs} — ${lightValue(a)} vs ${lightValue(b)}`)
  }
  for (const [name, why] of Object.entries(DIVERGENCES)) {
    ok(why.length > 40, `${name} diverges from slides for a written-down reason`)
  }
  // the aliases have to actually point at something, or a rule ported from
  // slides resolves to nothing and silently does nothing (failure 1 again)
  for (const alias of ['--chrome', '--chrome-2', '--blue', '--ui']) {
    ok(dash.has(alias), `${alias} exists, so a rule lifted out of slides resolves here`)
  }
}

// ============================================================ 3 · contrast floors

function srgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number]
}
function luminance(hex: string): number {
  const [r, g, b] = srgb(hex).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Both halves of a token, as hex. */
function pair(vars: Map<string, string>, name: string): [string, string] {
  const v = vars.get(name)
  if (!v) throw new Error(`${name} is not declared`)
  const m = /^light-dark\(\s*([^,]+),\s*([^)]+)\)/.exec(v)
  if (!m) return [v.trim(), v.trim()]
  return [m[1].trim(), m[2].trim()]
}

console.log('\ncontrast floors, on both grounds')
{
  const vars = rootVars(allCss)
  /** [ink, ground, floor, what it is] — the floor is 4.5 for text, 3 for a mark. */
  const FLOORS: [string, string, number, string][] = [
    ['--muted', '--bg', 4.5, 'a caption on the sheet'],
    ['--muted', '--panel', 4.5, 'a caption on a chrome band'],
    ['--muted', '--hover', 4.5, 'a caption on a hovered menu row'],
    ['--muted', '--surface', 4.5, 'a caption in a dialog or menu'],
    ['--ink', '--bg', 4.5, 'body text on the sheet'],
    ['--ink', '--surface', 4.5, 'body text in a dialog'],
    ['--ink-2', '--panel', 4.5, 'a control label in the top bar'],
    ['--accent-ink', '--panel', 4.5, 'the amber-meaning mark, on a chrome band'],
    ['--sel-ring', '--bg', 3, 'the selection ring on the sheet'],
    ['--sel-ring', '--panel', 3, 'the focus ring on a chrome band'],
    ['--sel-ring', '--surface', 3, 'the focus ring in a dialog'],
    ['--err-ink', '--bg', 4.5, 'an error figure in a cell'],
    ['--warn-ink', '--warn-bg', 4.5, 'the findings strip'],
    ['--toast-ink', '--toast-bg', 4.5, 'a toast'],
  ]
  for (const [ink, ground, floor, what] of FLOORS) {
    const [il, id] = pair(vars, ink)
    const [gl, gd] = pair(vars, ground)
    for (const [i, g, theme] of [[il, gl, 'light'], [id, gd, 'dark']] as const) {
      const r = contrast(i, g)
      ok(r >= floor, `${theme}: ${what} — ${ink} on ${ground} is ${r.toFixed(2)}:1, floor ${floor}`)
    }
  }
  // The brand amber is the one colour that cannot carry text on the light
  // ground, and the palette comment says so. Assert it, so nobody "fixes" a
  // contrast failure by reaching for the accent.
  const [amber] = pair(vars, '--accent')
  ok(contrast(amber, '#ffffff') < 3,
    `--accent is ${contrast(amber, '#ffffff').toFixed(2)}:1 on white — a mark, never text or a ring`)
}

// ============================================================ 4 · focus is one colour

/**
 * Rules that still focus with the amber, and are owned by somebody else.
 *
 * NOT an exemption on principle — each of these is the same defect the check
 * exists for, and each is a one-token fix (`var(--accent)` → `var(--blue)`).
 * They are listed so this rig can be green on a tree it does not own all of,
 * and the COUNT is asserted: the list may shrink and must never grow. Delete an
 * entry the moment its file is fixed.
 */
const AMBER_FOCUS_TODO = [
  'panels.css .dp-row input:focus / select:focus',
  'story.css .ds-cap-in:focus',
]

console.log('\nfocus is indicated with one colour, and it is not the amber')
{
  const offenders: string[] = []
  for (const [file, text] of Object.entries(css)) {
    const body = text.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of body.matchAll(/[^}]*:focus(-visible)?[^{]*\{([^}]*)\}/g)) {
      const decl = m[2]
      if (/(outline|border-color)\s*:[^;]*var\(--accent\)/.test(decl)) {
        offenders.push(`${file}: ${m[0].trim().replace(/\s+/g, ' ').slice(0, 70)}`)
      }
    }
  }
  ok(offenders.length <= AMBER_FOCUS_TODO.length,
    `no NEW :focus rule paints with --accent (2.02:1 on white, under SC 1.4.11's 3:1) — `
    + `${offenders.length} found, ${AMBER_FOCUS_TODO.length} known`
    + (offenders.length > AMBER_FOCUS_TODO.length ? `\n        ${offenders.join('\n        ')}` : ''))
  ok(offenders.every((o) => AMBER_FOCUS_TODO.some((t) => o.startsWith(t.split(' ')[0]))),
    'and every one of them is a file already on the known list')
}

// ============================================================ 5 · light-dark() is a colour

console.log('\nlight-dark() is only asked for colours')
{
  const vars = rootVars(allCss)
  for (const [name, value] of vars) {
    if (!value.startsWith('light-dark(')) continue
    const [light] = pair(vars, name)
    const looksLikeColour = /^(#|rgba?\(|hsla?\(|color-mix\(|var\(|oklch\(|transparent$|currentcolor$)/.test(light)
    ok(looksLikeColour,
      `${name} varies by theme and must therefore be a <color> — light-dark() cannot `
      + `carry "${light}". It is a legal thing to WRITE in a custom property and an `
      + `invalid thing to substitute anywhere, so the property silently takes its `
      + `initial value. This is how every shadow in dash was "none". Vary the colour `
      + `and keep the rest outside, as --shadow-pop does.`)
  }
  // the one token that DOES vary and is not a colour has to do it the long way
  ok(/@media\s*\(prefers-color-scheme:\s*dark\)[^}]*--bar-opacity/s.test(css['styles.css']),
    '--bar-opacity, a number, varies through a media query and not through light-dark()')
}

// ============================================================ 6 · no colour hides in a query

console.log('\nno component stylesheet states a colour inside a colour-scheme query')
{
  for (const [file, text] of Object.entries(css)) {
    const body = text.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of body.matchAll(/@media[^{]*prefers-color-scheme[^{]*\{([\s\S]*?)\n\}/g)) {
      const hasHex = /#[0-9a-f]{3,8}\b|rgba?\(/i.test(m[1])
      const onlyTokens = /--[a-z-]+\s*:/.test(m[1])
      ok(!hasHex || onlyTokens,
        `${file}: a prefers-color-scheme block states a raw colour — the palette does the theming`)
    }
  }
  ok(true, 'checked every prefers-color-scheme block in dash/src')
}

// ============================================================

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
