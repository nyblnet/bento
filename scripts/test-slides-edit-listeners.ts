#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Inline-edit listeners die with the edit that made them.
//
//   node scripts/test-slides-edit-listeners.ts
//
// WHAT THIS PROVES. canvas.ts attaches keydown/input/paste/blur listeners to
// a text box's or a table cell's inner node every time an edit starts. When
// an edit ends with the text unchanged nothing re-renders, so the SAME node
// is edited next time — and, until this fix, gained another set of listeners
// each time. Tab through a table's cells, then paste into one: the paste
// landed once per visit (measured on the 1.2.0 shell: four visits, four
// copies of the pasted text; on the fix, one). Every edit-time listener now
// carries the AbortSignal of one per-edit controller, and both commit paths
// abort it — asserted here on the source; the browser measurement is the one
// in the PR.

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
const src = readFileSync(join(root, 'slides/src/editor/canvas.ts'), 'utf8')

console.log('one controller per edit\n')
const text = src.slice(src.indexOf('  startTextEdit(node: HTMLElement) {'), src.indexOf('  commitTextEdit() {'))
const cell = src.slice(src.indexOf('  private editCellAt('), src.indexOf('  private commitCellEdit('))
for (const [name, block] of [['a text box', text], ['a table cell', cell]] as const) {
  ok(/this\.editListeners\?\.abort\(\)\s*\n\s*this\.editListeners = new AbortController\(\)/.test(block), `${name}: starting an edit aborts the previous controller and makes a fresh one`)
  // each listener: the text from its addEventListener to the next one (or the
  // end of the block); the call's closing options object must name the signal
  const pieces = block.split("inner.addEventListener('").slice(1)
  const adds = pieces.map((piece) => ({ 1: piece.slice(0, piece.indexOf("'")), 0: piece }))
  const kinds = adds.map((m) => m[1])
  ok(kinds.length >= 4 && ['keydown', 'input', 'paste', 'blur'].every((k) => kinds.includes(k)), `${name}: keydown, input, paste and blur are attached (${kinds.join(', ')})`)
  const unsignalled = adds.filter((m) => !/\bsignal\b[^\n]*\}\)/.test(m[0]))
  ok(unsignalled.length === 0, `${name}: every listener carries the edit's signal${unsignalled.length ? ` — missing on ${unsignalled.map((m) => m[1]).join(', ')}` : ''}`)
}
console.log('\nboth commits end the listeners\n')
const commitText = src.slice(src.indexOf('  commitTextEdit() {'), src.indexOf('  private editCellAt('))
const commitCell = src.slice(src.indexOf('  private commitCellEdit('), src.indexOf('  private moveCell('))
ok(/this\.editListeners\?\.abort\(\)\s*\n\s*this\.editListeners = null\s*\n\s*this\.editing = null/.test(commitText), 'commitTextEdit aborts before clearing the edit')
ok(/this\.editListeners\?\.abort\(\)\s*\n\s*this\.editListeners = null\s*\n\s*this\.editing = null/.test(commitCell), 'commitCellEdit aborts before clearing the edit')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
