#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Save-intent rig.
//
//   node scripts/test-savepurpose.ts
//
// WHAT THIS PROVES. A HOST that polyfills `showSaveFilePicker` — home/ios over
// UIDocument, home/webext over a directory grant — sees only the options bag.
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
import { pickerIdFor, suggestedFileName as suggestedName, type SavePurpose } from '../kernel/src/save.ts'

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

// ------------------------------------------------- every app announces itself
// A host must know whether a document predates `pickerIdFor` (#213), because
// before it every save sent `bento-doc` and acting on that overwrites the open
// document. The signal used to live in `window.bento.updates.version`, which
// each app assembles by hand — and bento/dash never included `updates`, so
// every Cmd-S in Dash fell through to a destination prompt. The fix is that the
// signal cannot live in a per-app object at all: `configureApp` is the one call
// every app makes, so it announces the version and the next app inherits it.
const appSrc = readFileSync(new URL('../kernel/src/app.ts', import.meta.url), 'utf8')
ok(/__bentoRuntime/.test(appSrc), 'the kernel announces the runtime version to a host')
ok(appSrc.indexOf('announceRuntime()') < appSrc.indexOf('function announceRuntime'),
  'and does it from configureApp, which every app calls — not from each app in turn')
ok(/writable: false/.test(appSrc),
  'the announcement is not writable: a document shares that realm and must not fake its own version')

const updateSrc = readFileSync(new URL('../kernel/src/update.ts', import.meta.url), 'utf8')
const call = updateSrc.slice(updateSrc.indexOf('writeUpdatedFileAs(html'))
ok(/purpose:\s*'in-place'/.test(call.slice(0, 300)),
  'applyUpdateInPlace declares in-place, so a host recognises it and writes without asking')
ok(!/writeUpdatedFileAs\(html, doc, \{ keepHandle: true, suggestedName: [^}]*\}\)/.test(updateSrc),
  'the update no longer falls through to the default share purpose')

// ------------------------------------------------- the convention is the id
// `.bento.html` is not decoration. home/webext injects its save bridge on
// `file:///*.bento.html` and home/ios matches the same way, so a document named
// `Q3.html` opens fine and then asks where to save — it is a second-class
// citizen everywhere the name is what identifies us.
//
// `suggestedFileName` has always produced the compound extension, but the
// PICKER accepted `.html`, so an author who typed a bare name got `Q3.html`.
// Bento was manufacturing the exception and then coping with it. Accepting only
// `.bento.html` makes the browser append it to a bare name.
const saveSrc = readFileSync(new URL('../kernel/src/save.ts', import.meta.url), 'utf8')
ok(/\.bento\.html$/.test(suggestedName({ title: 'Q3 Board Review' } as any)),
  `suggestedFileName produces the compound extension (${suggestedName({ title: 'Q3 Board Review' } as any)})`)
ok(!/accept: \{ 'text\/html': \['\.html'\] \}/.test(saveSrc),
  'and the picker no longer accepts a bare .html, which is how bare names slipped through')
for (const m of saveSrc.matchAll(/accept: \{ 'text\/html': \[([^\]]*)\] \}/g)) {
  ok(m[1] === "'.bento.html'", `every picker accepts only .bento.html (found ${m[1]})`)
}
ok((saveSrc.match(/accept: \{ 'text\/html'/g) ?? []).length >= 2,
  'both picker call sites are covered — a copy that drifts is how one of them would regress')


console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
