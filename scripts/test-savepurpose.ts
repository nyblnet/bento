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

import { pickerIdFor, type SavePurpose } from '../kernel/src/save.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const purposes: SavePurpose[] = ['in-place', 'copy', 'share']
const ids = purposes.map(pickerIdFor)

ok(new Set(ids).size === purposes.length,
  `every purpose has its own picker id (${ids.join(', ')})`)
ok(pickerIdFor('in-place') === 'bento-doc',
  'in-place keeps the original id, so no existing deck changes where its picker opens')
ok(pickerIdFor('copy') !== pickerIdFor('in-place'),
  'a copy is distinguishable from an in-place save — the case that overwrote a file')
ok(pickerIdFor('share') !== pickerIdFor('in-place'),
  'a share export is distinguishable from an in-place save')
ok(ids.every((id) => /^[a-z0-9-]+$/.test(id) && id.length <= 32),
  'ids are plain and short enough for the picker to accept')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
