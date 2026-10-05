#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Typed bullets become real lists when an edit ends (discussion #502).
//
//   node scripts/test-slides-bullets.ts
//
// WHAT THIS PROVES. editor/bullets.ts bulletsToLists is a pure function of
// the box's html: a run of glyph lines ("•" + NBSP, indented "◦" + NBSP) is
// one <ul>, an indented line nests under the item before it, lines between
// runs are untouched, lists the formatting bar made are untouched, a glyph in
// the middle of a line is untouched, a box with no typed bullet is returned
// byte-identical (no <div> folding, nothing), and converting the result again
// changes nothing. Hanging indent itself is CSS the renderer already has
// (styles.css list-style-position outside) and is measured in the PR.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { bulletsToLists, hasTypedBullets } from '../slides/src/editor/bullets.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const NB = '\u00a0'
const B = `\u2022${NB}`, S = `\u25e6${NB}`

console.log('runs of glyph lines\n')
ok(bulletsToLists(`${B}one<br>${B}two`) === '<ul><li>one</li><li>two</li></ul>', 'two top-level bullets → one list')
ok(bulletsToLists(`${B}one<br>${NB}${NB}${S}sub<br>${B}two`) === '<ul><li>one<ul><li>sub</li></ul></li><li>two</li></ul>', 'an indented \u25e6 nests under the item before it')
ok(bulletsToLists(`${B}one<br>&nbsp;&nbsp;${S}sub`) === '<ul><li>one<ul><li>sub</li></ul></li></ul>', 'the indent may be &nbsp; entities (what innerHTML serialises)')
ok(bulletsToLists(`\u2022&nbsp;one`) === '<ul><li>one</li></ul>', 'the glyph\'s NBSP may be an entity too')
ok(bulletsToLists('\u2022 one<br>&nbsp; \u25e6 sub') === '<ul><li>one<ul><li>sub</li></ul></li></ul>', 'or the plain space Chrome normalises it to once text follows (what commit sees)')
ok(bulletsToLists(`${NB}${NB}${S}orphan`) === '<ul><li><ul><li>orphan</li></ul></li></ul>', 'a run opening with a sub-bullet gets an empty parent item')

console.log('\nwhat stays as it was\n')
ok(bulletsToLists('Title<br>plain<br><div>x</div>') === 'Title<br>plain<br><div>x</div>', 'no typed bullet → byte-identical, divs untouched')
ok(bulletsToLists(`Title<br>${B}one<br>${B}two<br>after`) === 'Title<ul><li>one</li><li>two</li></ul>after', 'text before and after a run survives; a list is a block, no <br> around it')
ok(bulletsToLists(`a ${B} in the middle`) === `a ${B} in the middle`, 'a glyph mid-line is not a bullet')
const barMade = `<ul><li>from the bar</li></ul>`
ok(bulletsToLists(barMade) === barMade, 'a list the formatting bar made is untouched')
ok(bulletsToLists(`<ul><li>${B}glyph inside a li</li></ul>`) === `<ul><li>${B}glyph inside a li</li></ul>`, 'a glyph inside an existing li is left alone')
ok(bulletsToLists(`<ul><li>x<br>${B}typed inside a li</li></ul>`) === `<ul><li>x<br>${B}typed inside a li</li></ul>`, 'a glyph line that carries list markup (typed inside an existing item) is left alone')
ok(bulletsToLists(`<b>${B}bold bullet</b>`) === `<b>${B}bold bullet</b>`, 'a glyph after an opening tag is not a line start')

console.log('\ncontentEditable blocks\n')
ok(bulletsToLists(`<div>${B}one</div><div>${B}two</div>`) === '<ul><li>one</li><li>two</li></ul>', 'Enter-made <div> blocks are lines')
ok(bulletsToLists(`intro<div>${B}one</div>`) === 'intro<ul><li>one</li></ul>', 'a div after inline text is a line too')

console.log('\nidempotence\n')
for (const src of [`${B}one<br>${B}two`, `Title<br>${B}one<br>${NB}${NB}${S}sub<br>after`, 'plain<br>text', barMade]) {
  const once = bulletsToLists(src)
  ok(bulletsToLists(once) === once, `converting again changes nothing: ${JSON.stringify(src).slice(0, 40)}`)
  ok(!hasTypedBullets(once), 'and the result reports no typed bullets left')
}

console.log('\nthe commit calls it, cells do not\n')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const canvas = readFileSync(join(root, 'slides/src/editor/canvas.ts'), 'utf8')
const textCommit = canvas.slice(canvas.indexOf('  commitTextEdit() {'), canvas.indexOf('  private editCellAt('))
const cellCommit = canvas.slice(canvas.indexOf('  private commitCellEdit('), canvas.indexOf('  private moveCell('))
ok(/bulletsToLists\(sanitizeHtml\(/.test(textCommit), 'commitTextEdit converts the sanitized html (sanitize first, then lists)')
ok(!/bulletsToLists/.test(cellCommit), 'commitCellEdit does not (no list styling in a cell)')
ok(/clipboardToHtml\(ev\.clipboardData\)/.test(canvas) && (canvas.match(/clipboardToHtml\(ev\.clipboardData\)/g) ?? []).length === 2, 'both paste handlers read the clipboard through editor/paste.ts')
ok(!/getData\('text\/html'\)/.test(canvas), 'nothing in canvas.ts reads text/html directly — only the sanitized helper does')
const paste = readFileSync(join(root, 'slides/src/editor/paste.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
ok(/new DOMParser\(\)\.parseFromString\(/.test(paste), 'paste.ts parses the clipboard html in a document of its own (DOMParser)')
ok(!/document\.createElement|document\.body|appendChild|cloneNode|innerHTML\s*=/.test(paste), 'and never creates, appends or clones into the live document — a node adopted there starts loading what it names before any sanitizer runs')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
