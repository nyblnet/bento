#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Save-intent rig.
//
//   node scripts/test-savepurpose.ts
//
// WHAT THIS PROVES. A HOST that polyfills `showSaveFilePicker` — tray/ios over
// UIDocument, tray/webext over a directory grant — sees only the options bag.
// It has to answer "am I being asked to overwrite the open document, or to make
// a second file?" from that alone, and the two failure directions are not
// symmetric: guessing "copy" costs a prompt, guessing "in-place" overwrites
// somebody's work with no dialog and no warning.
//
// Measured, in a browser extension, 2026-08-02: it overwrote the open deck,
// because ⌘S and "Save a copy…" reached the picker with byte-identical
// arguments. `id` is now the signal. If these three ever collapse back to one
// value, every host silently loses the ability to tell them apart — and finds
// out the way we did.

import { readFileSync } from 'node:fs'
import { pickerIdFor, type SavePurpose } from '../kernel/src/save.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const purposes: SavePurpose[] = ['in-place', 'copy', 'share', 'backup']
const ids = purposes.map(pickerIdFor)

ok(new Set(ids).size === purposes.length,
  `every purpose has its own picker id (${ids.join(', ')})`)
ok(pickerIdFor('in-place') === 'bento-doc',
  'in-place keeps the original id, so no existing deck changes where its picker opens')
ok(pickerIdFor('copy') !== pickerIdFor('in-place'),
  'a copy is distinguishable from an in-place save — the case that overwrote a file')
ok(pickerIdFor('share') !== pickerIdFor('in-place'),
  'a share export is distinguishable from an in-place save')
ok(pickerIdFor('backup') !== pickerIdFor('in-place'),
  'a backup is distinguishable from the file it backs up — it is a NEW file beside it')
ok(ids.every((id) => /^[a-z0-9-]+$/.test(id) && id.length <= 32),
  'ids are plain and short enough for the picker to accept')

// ---------------------------------------------------------- the update path
// The self-update is the ONE caller of writeUpdatedFileAs that is overwriting
// the document on screen rather than exporting a new file. It hard-coded
// `share` for both, so a host was told "the author will choose a destination"
// about a save that should never have shown a dialog — reported against 1.0.16,
// with the extension installed and the folder granted.
//
// Read as source, because the branch is unreachable without a DOM and a picker.
// A weak assertion on the right line beats a strong one on a mock of it.
const updateSrc = readFileSync(new URL('../kernel/src/update.ts', import.meta.url), 'utf8')
const call = updateSrc.slice(updateSrc.indexOf('writeUpdatedFileAs(html'))
ok(/purpose:\s*'in-place'/.test(call.slice(0, 300)),
  'applyUpdateInPlace declares in-place, so a host recognises it and writes without asking')
ok(!/writeUpdatedFileAs\(html, doc, \{ keepHandle: true, suggestedName: [^}]*\}\)/.test(updateSrc),
  'the update no longer falls through to the default share purpose')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
