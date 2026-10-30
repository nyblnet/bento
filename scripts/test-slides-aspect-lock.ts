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
ok(/const locked = !!el && ratioLocked\(el\)/.test(sync), 'locked = the element\'s own padlock (ratioLocked)')
ok(/el\.type === 'image' \? el\.keepAspectRatio !== false : el\.keepAspectRatio === true/.test(model), 'ratioLocked: an image is locked unless false; anything else only when true')
ok(/inputEvent\?\.shiftKey \? !locked : locked/.test(sync), 'Shift inverts the element\'s own setting — frees a locked image, holds an unlocked one')
ok(/syncKeepRatio\(e\.inputEvent as MouseEvent, e\.target as HTMLElement\)/.test(canvas.slice(canvas.indexOf("mv.on('resizeStart'"), canvas.indexOf("mv.on('resizeGroupStart'"))), 'resizeStart and resize both pass the target so the element is looked up')
// a non-image with no key is free, so want = shiftKey — exactly the old rule
{
  const { ratioLocked } = await import('../slides/src/model.ts')
  ok(!ratioLocked({ type: 'shape' } as never) && ratioLocked({ type: 'shape', keepAspectRatio: true } as never), 'a shape is free until its padlock is on — every existing deck resizes as before')
  ok(ratioLocked({ type: 'image' } as never) && !ratioLocked({ type: 'image', keepAspectRatio: false } as never), 'an image is locked until unlocked, as before')
}

console.log('\nthe panel\n')
const panels = read('slides/src/editor/panels.ts')
// the whole method, however long the Picture section grows: up to the next method
// one home: the padlock between W and H (arrange.ts) serves images too; the Picture section has no second toggle
const media = read('slides/src/editor/inspector/media.ts')
const arrange = read('slides/src/editor/inspector/arrange.ts')
const lock = arrange.slice(arrange.indexOf('function ratioLock('), arrange.indexOf('\n}\n', arrange.indexOf('function ratioLock(')))
ok(!/'Keep aspect ratio'/.test(media), 'the Picture section carries no second aspect toggle')
ok(/const on = ratioLocked\(el\)/.test(lock), 'the padlock reads absent as on for an image (ratioLocked)')
ok(/if \(on\) \{ e\.keepAspectRatio = false; \(e as ImageElement\)\.fit = 'fill' \} else delete e\.keepAspectRatio/.test(lock), 'on an image: unlocking writes false and fit:\'fill\'; re-locking DELETES the field, so a re-locked file equals an untouched one')
ok(!/e\.w =|e\.h =/.test(lock), 'the padlock never moves or resizes the frame — re-locking keeps the current shape')
ok(/b\.title = on \?/.test(lock), 'the padlock says what it does')

console.log('\nthe panel keeps its scroll\n')
const rebuild = panels.slice(panels.indexOf('rebuild(force = false)'), panels.indexOf('CLOSED_BY_DEFAULT'))
ok(/const scrollTop = force \? 0 : this\.host\.scrollTop/.test(rebuild), 'a doc edit remembers the scroll; a selection/slide switch (force) starts at the top')
// The Layers list restores its OWN scroll between the two (#507) — a
// different value; the panel's must still be the last thing set.
ok(/this\.applyAccordion\(\)[^]*?this\.host\.scrollTop = scrollTop\s*\n\s*\}/.test(rebuild), 'the panel scroll is restored after the accordion runs (which can change the height)')
ok(!/this\.host\.scrollTop = scrollTop[\s\S]*this\.applyAccordion\(\)/.test(rebuild), 'and never before it')

console.log('\nwhat was set aside stays out\n')
for (const f of ['slides/src/model.ts', 'slides/src/render.ts', 'slides/src/editor/canvas.ts', 'slides/src/editor/editor.ts', 'slides/src/editor/panels.ts', 'slides/src/main.ts', 'kernel/src/save.ts', 'slides/src/styles.css']) {
  ok(!/templateLocked|templateEditOf|compactDocumentAssets|registerSerializePrepare/.test(read(f)), `${f} carries none of the set-aside parts`)
}
ok(!existsSync(join(root, 'slides/src/compact-assets.ts')), 'compact-assets.ts does not exist (#447/#476 own asset pruning)')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
