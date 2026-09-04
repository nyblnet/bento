#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The off switch for a live session survives every window width.
//
//   node scripts/test-dash-stopsharing.ts
//
// WHY THIS EXISTS. A polish sweep drove the app at 880px with a session
// running: `collab.on` was true, the room was live on `wss://sync.bento.page`,
// and the string "Stop sharing" appeared NOWHERE in the document. The only
// trace of a running session was an 8px green dot. `sync.css` hid
// `.dx-people-toggle` outright below 900px to buy width in the top bar, and
// that toggle is the only control that stops sharing.
//
// The nearest thing left was About's "Offline mode — block every network
// feature", which also kills the signed update check: to stop one workbook
// being shared you had to switch off the app's networking.
//
// THE RULE, and it is narrow on purpose. A control that reports nothing may
// stand down at a narrow width — that is what the responsive ladder is for, and
// the 390px measurement behind these rules (the chip cost 20px the bar did not
// have and pushed About off the edge) is real and still honoured. A control
// that STOPS SOMETHING ALREADY HAPPENING may not. So the collapse is scoped to
// `:not(.dx-live)`, and `.dx-live` is on the chip exactly when there is a
// session to stop.
//
// Checked as CSS text, because this is a media-query question: `dash-dom.ts` is
// a parser and a node tree, not a layout engine, and cannot tell you what a
// viewport width does to a declaration.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'dash/src/sync.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const people = readFileSync(join(root, 'dash/src/sync/people.ts'), 'utf8')

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

console.log('the chip says when there is a session to stop')
{
  ok(/classList\.toggle\('dx-live'/.test(people),
    'the host takes `dx-live` while sharing — a class on a child cannot save a parent that is display:none')
  ok(/dx-people-toggle\$\{live \? ' dx-live' : ''\}/.test(people),
    'and so does the toggle itself, for the rules that hide only the button')
}

console.log('\nno width hides the off switch')
{
  // Every rule in this stylesheet that hides something in the people chip must
  // either be scoped away from a live session, or not be inside a width query.
  let hiding = 0
  for (const block of css.matchAll(/@media[^{]*max-width[^{]*\{([\s\S]*?)\n\}/g)) {
    for (const rule of block[1].matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const sel = rule[1].trim()
      const body = rule[2]
      // ONLY THE ROUTE TO THE BUTTON. `.dx-people-title` is the word "Live"
      // beside the dot and `.dx-people-name` is a peer's name — both are
      // decoration and hiding them at a narrow width is the ladder working.
      // What may not disappear is the toggle, or the chip that contains it.
      if (!/\.dx-people-toggle|\.dx-people(?![-\w])/.test(sel)) continue
      if (!/display\s*:\s*none/.test(body)) continue
      hiding++
      ok(/:not\(\.dx-live\)/.test(sel),
        `"${sel}" hides part of the sharing chip at a narrow width without exempting a LIVE session — ` +
        'that is how "Stop sharing" left the document at 880px')
    }
  }
  // GUARD IS LIVE: if the selectors are ever renamed this loop finds nothing
  // and every check above it passes vacuously.
  ok(hiding >= 2, `the width rules that hide the chip were found and checked (${hiding})`)
}

console.log('\nand the label is the one a reader would look for')
{
  ok(/t\('Stop sharing'\)/.test(people), 'the live label is "Stop sharing", not a symbol')
  ok(/t\('Start live session'\)/.test(people), 'and the idle one says what it will do')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
