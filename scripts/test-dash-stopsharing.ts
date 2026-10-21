#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The off switch for a live session survives every window width, and the
// state it reports is a WORD, never a dot on its own.
//
//   node scripts/test-dash-stopsharing.ts
//
// HISTORY. A polish sweep drove the app at 880px with a session running and the
// string "Stop sharing" appeared NOWHERE in the document: sync.css hid the
// people chip's toggle below 900px to buy bar width, and that toggle was the
// only control that stopped sharing. The chip was then fixed to stand down only
// while NOT live — and the 2026-10-20 review still measured it as a bare grey
// dot at 768px, hidden entirely on a phone, and going live on ONE click with no
// popover at all.
//
// It is gone now. Sharing is spaces' Share popover (dash/src/shareui.ts): a
// labelled button that opens a panel with Go live / Stop sharing inside it, and
// which the phone fold parks in ⋯ rather than hiding. This rig holds the three
// properties that made the old chip a bug, as SOURCE checks; the widths
// themselves are measured in a browser by scripts/test-dash-chrome-browser.mjs.
//
//   1. While a session is running, the popover offers "Stop sharing".
//   2. The button always carries a WORD for the state — "Share" or "Live".
//   3. No stylesheet rule hides the Share control or its word at any width.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ui = readFileSync(join(root, 'dash/src/shareui.ts'), 'utf8')
const main = readFileSync(join(root, 'dash/src/main.ts'), 'utf8')
const cssDir = join(root, 'dash/src')
const css = readdirSync(cssDir).filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(cssDir, f), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '')

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

console.log('the popover offers the off switch whenever there is a session to stop')
{
  // `st === 'off'` gets Go live; EVERY other writable state gets Stop sharing.
  ok(/if \(st === 'off'\) \{[\s\S]{0,400}?t\('Go live'\)[\s\S]{0,400}?\} else \{[\s\S]{0,200}?t\('Stop sharing'\)/.test(ui),
    'the session row is "Go live" when off and "Stop sharing" otherwise — never neither')
  ok(/stopSharing\(this\.host\.session, store\)/.test(ui), 'and "Stop sharing" really calls stopSharing')
}

console.log('\nthe state is a word')
{
  ok(/lab\.textContent = [^\n]*t\('Live'\) : t\('Share'\)/.test(ui),
    'the button\'s label is "Live" while connected and "Share" otherwise')
  ok(!/t\('Start live session'\)/.test(main + ui),
    'the one-click "Start live session" chip is gone (it went live with no popover)')
}

console.log('\nno width hides the Share control or its word')
{
  let hiding = 0
  for (const rule of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = rule[1].trim()
    if (!/display\s*:\s*none/.test(rule[2])) continue
    for (const part of sel.split(',')) {
      // `.dx-share-n:empty` is the peer COUNT with nothing in it, not the word
      if (/\.dx-share(?:-dd|-lab)?(?![-\w])/.test(part) || /\.dx-share-lab/.test(part)) {
        hiding++
        ok(false, `"${part.trim()}" hides the Share control or its label`)
      }
    }
  }
  ok(hiding === 0, 'no display:none rule targets .dx-share, .dx-share-dd or .dx-share-lab')
  // the compact tier hides every bar label — this word must be exempt from it
  ok(/\.dx-bar\.dx-bar-compact \.dx-btn > \.dx-share-lab/.test(css),
    'the compact tier, which hides button labels, explicitly keeps the Share/Live word')
  // GUARD IS LIVE: the selectors this sweep keys on must exist, or it passes vacuously
  ok(/\.dx-share\b/.test(css) && /dx-share-lab/.test(ui),
    'the selectors this sweep checks are the ones the UI really uses')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
