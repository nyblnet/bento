#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Image aspect-ratio lock (#372): `keepAspectRatio` on an image element.
//
//   node scripts/test-slides-aspect-lock.ts
//
// WHAT THIS PROVES. The field is additive — absent means locked, which is
// what every image did before, so old files resize exactly as they did. The
// canvas reads the element's own setting and Shift is the one-drag exception
// in either direction; the panel toggle deletes the field when re-locking
// (never writes `true`) and sets fit:'fill' when unlocking so a stretch is
// visible; the shape gate lets the key through; and the parts of #372 that
// were set aside (template locking, asset compaction, a kernel hook) are not
// in the tree.

import { readFileSync, existsSync } from 'node:fs'
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
const read = (f: string) => readFileSync(join(root, f), 'utf8')

console.log('the model\n')
const model = read('slides/src/model.ts')
const image = model.slice(model.indexOf('export interface ImageElement'), model.indexOf('export interface SvgElement'))
ok(/keepAspectRatio\?: boolean/.test(image), 'ImageElement.keepAspectRatio is optional — absent is a valid, meaningful value')
ok(/[Aa]bsent or true/.test(image), 'the doc comment says absent = locked')
ok(/keepAspectRatio: bool/.test(read('slides/src/untrusted.ts')), 'the shape gate admits the key as a boolean (an untrusted file keeps its setting)')
ok(/keepAspectRatio/.test(read('slides/src/modelkeys.generated.ts')), 'the generated model keys carry it (validate() will not flag it as unknown)')

console.log('\nthe canvas\n')
const canvas = read('slides/src/editor/canvas.ts')
const sync = canvas.slice(canvas.indexOf('const syncKeepRatio ='), canvas.indexOf("mv.on('resizeStart'"))
ok(/el\?\.type === 'image' && el\.keepAspectRatio !== false/.test(sync), 'locked = an image whose field is absent or true')
ok(/inputEvent\?\.shiftKey \? !locked : locked/.test(sync), 'Shift inverts the element\'s own setting — frees a locked image, holds an unlocked one')
ok(/syncKeepRatio\(e\.inputEvent as MouseEvent, e\.target as HTMLElement\)/.test(canvas.slice(canvas.indexOf("mv.on('resizeStart'"), canvas.indexOf("mv.on('resizeGroupStart'"))), 'resizeStart and resize both pass the target so the element is looked up')
// non-image elements: locked is false, so want = shiftKey — exactly the old rule
ok(/const locked = el\?\.type === 'image'/.test(sync), 'a shape or text box is never "locked": Shift keeps the ratio, as before')

console.log('\nthe panel\n')
const panels = read('slides/src/editor/panels.ts')
const img = panels.slice(panels.indexOf('private buildImageProps'), panels.indexOf('private buildImageProps') + 2500)
ok(/this\.row\('Keep aspect ratio', this\.toggle\(\(el as ImageElement\)\.keepAspectRatio !== false/.test(img), 'the toggle reads absent as on')
ok(/if \(on\) delete e\.keepAspectRatio/.test(img), 're-locking DELETES the field — never writes true, so a re-locked file equals an untouched one')
ok(/else \{ e\.keepAspectRatio = false; e\.fit = 'fill' \}/.test(img), 'unlocking writes false and fit:\'fill\' so the stretch shows')
ok(!/e\.w =|e\.h =/.test(img.slice(img.indexOf("'Keep aspect ratio'"))), 'the toggle never moves or resizes the frame — re-locking keeps the current shape')
ok(/'Keep aspect ratio': '/.test(panels), 'the row has a tooltip')

console.log('\nthe panel keeps its scroll\n')
const rebuild = panels.slice(panels.indexOf('private rebuild(force = false)'), panels.indexOf('CLOSED_BY_DEFAULT'))
ok(/const scrollTop = force \? 0 : this\.host\.scrollTop/.test(rebuild), 'a doc edit remembers the scroll; a selection/slide switch (force) starts at the top')
ok(/this\.applyAccordion\(\)\s*\n\s*this\.host\.scrollTop = scrollTop/.test(rebuild), 'the scroll is restored after the accordion runs (which can change the height)')

console.log('\nwhat was set aside stays out\n')
for (const f of ['slides/src/model.ts', 'slides/src/render.ts', 'slides/src/editor/canvas.ts', 'slides/src/editor/editor.ts', 'slides/src/editor/panels.ts', 'slides/src/main.ts', 'kernel/src/save.ts', 'slides/src/styles.css']) {
  ok(!/templateLocked|templateEditOf|compactDocumentAssets|registerSerializePrepare/.test(read(f)), `${f} carries none of the set-aside parts`)
}
ok(!existsSync(join(root, 'slides/src/compact-assets.ts')), 'compact-assets.ts does not exist (#447/#476 own asset pruning)')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
