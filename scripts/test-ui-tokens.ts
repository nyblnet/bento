#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The shared kernel CHROME TOKENS — tier 4 guard.
//
//   node scripts/test-ui-tokens.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. kernel/src/ui/tokens.css is the design vocabulary the four
// apps had each drawn slightly differently — the drift working/design/
// chrome-unification.md set out to end (slides' dark --accent-ink was 1.09:1;
// slides and spaces disagreed on a dozen neutrals; every app rolled its own
// radius, z-index and touch target). Defining the tokens once only helps if
// two things stay true, and each is a check below:
//
//   1. THE TOKENS THEMSELVES ARE SOUND. Every flipping colour has a value in
//      BOTH themes and the two dark blocks agree (the toggle block and the OS
//      media block are edited by hand and the hazard is changing one). Every
//      never-flip colour (--accent, --accent-on, --brand) appears in NEITHER
//      dark block. And the text/fill pairs clear WCAG AA in both themes —
//      including the pair #557 fixed, accent text on the chrome, and accent-on
//      on the orange fill.
//
//   2. NO APP RE-DECLARES A FROZEN TOKEN ONCE IT ADOPTS. Adoption (importing
//      this sheet, deleting the app's own copies) is a later change, app by
//      app. This guard arms for it: the moment an app imports tokens.css it may
//      not ALSO define a frozen token — that would silently reinstate the drift.
//      The two documented PARAMETERS (--bg, --drawer-bp: the D6 breakpoint) are
//      exempt, because those an app is meant to set. No app has adopted yet, so
//      that loop is empty today; a FIXTURE proves the checker still bites.
//
// The value assertions are mutation-caught (change a hex → a contrast check
// fails; drop a dark value → the both-themes check fails). The drift check is
// proven against a fixture so it cannot pass vacuously while no app has adopted.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tokensOf } from './lib/ui-theme-guard.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tokensCss = join(root, 'kernel/src/ui/tokens.css')

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// ————————————————————— parse tokens.css —————————————————————

if (!existsSync(tokensCss)) {
  console.log('FAIL  kernel/src/ui/tokens.css does not exist')
  process.exit(1)
}
const src = readFileSync(tokensCss, 'utf8')

/** The body of the first block whose selector matches `startRe`, brace-counted
 *  so a nested media block is handled. Returns '' if not found. */
function blockBody(startRe: RegExp): string {
  const m = src.match(startRe)
  if (!m) return ''
  let depth = 0
  let i = m.index! + m[0].length - 1
  const from = i + 1
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(from, i) }
  }
  return ''
}

/** `--name: value;` declarations in a block, comments stripped. */
function parseVars(body: string): Map<string, string> {
  const out = new Map<string, string>()
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of clean.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim())
  return out
}

const light = parseVars(blockBody(/:root\s*\{/))                       // the bare :root
const darkToggle = parseVars(blockBody(/:root\[data-theme="dark"\]\s*\{/))
const darkMedia = parseVars(blockBody(/@media[^{]*prefers-color-scheme:\s*dark[\s\S]*?:root:not\(\[data-theme="light"\]\)\s*\{/))

ok(light.size > 15, `the base :root block parses (${light.size} tokens)`)
ok(darkToggle.size > 8, `the [data-theme="dark"] block parses (${darkToggle.size} tokens)`)
ok(darkMedia.size > 8, `the prefers-color-scheme:dark block parses (${darkMedia.size} tokens)`)

// The two dark blocks are edited by hand — they must define the same tokens
// with the same values, or an app gets one dark in the OS and another on toggle.
{
  const kToggle = [...darkToggle.keys()].sort().join(' ')
  const kMedia = [...darkMedia.keys()].sort().join(' ')
  ok(kToggle === kMedia, 'the two dark blocks define the same token set')
  let mismatch = ''
  for (const [k, v] of darkToggle) if (darkMedia.get(k) !== v) mismatch += ` ${k}(${v}≠${darkMedia.get(k)})`
  ok(mismatch === '', `the two dark blocks agree on every value${mismatch}`)
}

// ————————————————————— which tokens must flip, which must not —————————————————————

const MUST_FLIP = ['--ink', '--ink-2', '--muted', '--surface', '--field', '--chrome',
  '--chrome-2', '--line', '--edge', '--accent-ink', '--blue', '--danger', '--shade', '--bg']
const NEVER_FLIP = ['--accent', '--accent-on', '--brand']

for (const t of MUST_FLIP) {
  ok(light.has(t), `${t} has a light value`)
  ok(darkToggle.has(t), `${t} has a dark value`)
}
for (const t of NEVER_FLIP) {
  ok(light.has(t), `${t} is defined`)
  ok(!darkToggle.has(t) && !darkMedia.has(t), `${t} does NOT flip (absent from both dark blocks)`)
}

// The D-rulings that are tokens are present with the ruled values.
ok(light.get('--fs-title') === '17px', 'D4: --fs-title is 17px')
ok(light.get('--fw-title') === '650', 'D4: --fw-title is 650')
ok(light.get('--tap') === '44px', 'D5: --tap is 44px')
ok(light.has('--drawer-bp'), 'D6: --drawer-bp exists (the one per-app breakpoint parameter)')
ok(light.get('--kbd-font') === 'inherit', 'D8: --kbd-font is inherit (sans, not mono)')
ok(light.get('--kbd-align') === 'right', 'D8: --kbd-align is right')

// ————————————————————— contrast, both themes —————————————————————

function hex(h: string): [number, number, number] {
  const s = h.trim().replace('#', '')
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255) as [number, number, number]
}
function lum([r, g, b]: number[]): number {
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [R, G, B] = [f(r), f(g), f(b)]
  return 0.2126 * R + 0.7152 * G + 0.0722 * B
}
function contrast(a: string, b: string): number {
  const la = lum(hex(a)), lb = lum(hex(b))
  const hi = Math.max(la, lb), lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}
/** A token's value in a theme: dark uses the dark block, falling back to the
 *  light value for the never-flip colours. */
function val(token: string, theme: 'light' | 'dark'): string {
  if (theme === 'dark' && darkToggle.has(token)) return darkToggle.get(token)!
  return light.get(token)!
}

for (const theme of ['light', 'dark'] as const) {
  const cr = (fg: string, bg: string) => contrast(val(fg, theme), val(bg, theme))
  // Body / secondary / muted text on every ground the chrome paints text on.
  for (const bg of ['--surface', '--chrome', '--field']) {
    const c = cr('--ink', bg)
    ok(c >= 4.5, `${theme}: --ink on ${bg} — ${c.toFixed(2)}:1 (≥4.5)`)
  }
  for (const bg of ['--surface', '--chrome']) {
    ok(cr('--ink-2', bg) >= 4.5, `${theme}: --ink-2 on ${bg} — ${cr('--ink-2', bg).toFixed(2)}:1 (≥4.5)`)
    ok(cr('--muted', bg) >= 4.5, `${theme}: --muted on ${bg} — ${cr('--muted', bg).toFixed(2)}:1 (≥4.5)`)
  }
  // Accent text on the chrome (the #557 fix), and ink on the orange fill.
  for (const bg of ['--surface', '--chrome']) {
    const c = cr('--accent-ink', bg)
    ok(c >= 4.5, `${theme}: --accent-ink text on ${bg} — ${c.toFixed(2)}:1 (≥4.5)`)
  }
  ok(cr('--accent-on', '--accent') >= 4.5, `${theme}: --accent-on on the --accent fill — ${cr('--accent-on', '--accent').toFixed(2)}:1 (≥4.5)`)
  // The secondary accent, at the UI/large-text floor.
  ok(cr('--blue', '--surface') >= 3, `${theme}: --blue on --surface — ${cr('--blue', '--surface').toFixed(2)}:1 (≥3)`)
  // Destructive-action ink is real text (a "Delete" label), so the body floor.
  // It flips precisely because a dark-red would fail this in the dark theme.
  for (const bg of ['--surface', '--chrome']) {
    ok(cr('--danger', bg) >= 4.5, `${theme}: --danger text on ${bg} — ${cr('--danger', bg).toFixed(2)}:1 (≥4.5)`)
  }
  // --edge is "the border that must be seen"; --line is the subtle hairline.
  // Their ordering is the invariant §1 states — edge reads harder than line.
  ok(cr('--edge', '--surface') > cr('--line', '--surface'),
    `${theme}: --edge (${cr('--edge', '--surface').toFixed(2)}:1) reads harder than --line (${cr('--line', '--surface').toFixed(2)}:1)`)
}

// ————————————————————— the drift guard —————————————————————

// @app-settable marker → the parameter tokens an app MAY set. Everything else
// defined here is frozen.
const settableM = src.match(/@app-settable:\s*([^\n]+)/)
const settable = new Set((settableM?.[1] ?? '').trim().split(/\s+/).filter((s) => s.startsWith('--')))
ok(settable.size >= 1, `@app-settable marker parses (${[...settable].join(' ')})`)
ok(settable.has('--bg') && settable.has('--drawer-bp'), 'the parameters --bg and --drawer-bp are app-settable')

const allDefined = new Set<string>([...light.keys(), ...darkToggle.keys(), ...darkMedia.keys()])
const frozen = new Set([...allDefined].filter((t) => !settable.has(t)))
ok(frozen.size > 10, `frozen token set is non-empty (${frozen.size})`)
ok(frozen.has('--ink') && frozen.has('--accent-ink') && frozen.has('--radius'),
  'the drift-drivers (--ink, --accent-ink, --radius) are frozen')
for (const t of settable) ok(!frozen.has(t), `${t} is a parameter, not frozen`)

/** Frozen tokens an app's stylesheet DEFINES — the redefinitions the guard
 *  refuses once that app has adopted the shared sheet. */
function redefinedFrozen(cssPath: string): string[] {
  const { all } = tokensOf(cssPath)
  return [...all].filter((t) => frozen.has(t)).sort()
}

// An app has ADOPTED when its source imports the shared sheet.
function importsTokens(appDir: string): boolean {
  const dir = join(root, appDir)
  if (!existsSync(dir)) return false
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()!
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (/\.(ts|css)$/.test(e.name) && readFileSync(p, 'utf8').includes('ui/tokens.css')) return true
    }
  }
  return false
}

const APPS: Record<string, string> = {
  slides: 'slides/src/styles.css',
  spaces: 'spaces/src/styles.css',
  dash: 'dash/src/styles.css',
  type: 'type/src/styles.css',
}
let adopted = 0
for (const [app, styles] of Object.entries(APPS)) {
  const dir = `${app}/src`
  if (!existsSync(join(root, styles)) || !importsTokens(dir)) continue
  adopted++
  const dupes = redefinedFrozen(join(root, styles))
  ok(dupes.length === 0, `${app} adopted tokens.css and re-declares no frozen token${dupes.length ? ' — drop: ' + dupes.join(', ') : ''}`)
}
console.log(`  ····  ${adopted} app(s) have adopted tokens.css; the drift guard checks each`)

// FIXTURE — the checker must bite even while no app has adopted. Prove it flags
// a frozen redefinition and allows a parameter override, using tokensOf's own
// parse via a temp file written by the harness would be heavier than needed:
// re-run the frozen filter over a literal token set.
{
  const fauxAll = new Set(['--ink', '--radius', '--bg', '--drawer-bp', '--some-app-token'])
  const flagged = [...fauxAll].filter((t) => frozen.has(t)).sort()
  ok(flagged.includes('--ink') && flagged.includes('--radius'),
    'fixture: the guard flags an app that redefines --ink / --radius')
  ok(!flagged.includes('--bg') && !flagged.includes('--drawer-bp') && !flagged.includes('--some-app-token'),
    'fixture: the guard allows --bg, --drawer-bp and an app-private token')
}

// ————————————————————— summary —————————————————————
console.log(`\n${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
