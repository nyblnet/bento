#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Photos shrink at insert (slides/src/editor/shrink.ts): the DOM-free decisions.
//
//   node scripts/test-slides-shrink.ts
//
// WHAT THIS PROVES. The classifier calls a noisy photo AND a smooth
// noise-free gradient (a sky) a photo, and a flat-background screenshot, a
// few-colour logo or anything transparent a graphic (the thing that decides
// lossy vs lossless, so the thing that decides whether a screenshot stays
// sharp and a sky does not become a 4 MB PNG). The keep rule refuses a 19% gain and takes a 21% one. The cap
// scales 4032×3024 to 2560×1920 and leaves 1000×500 alone. SVG and GIF are
// untouchable. And every image insert path in the editor goes through
// shrinkImageFile — while the model is untouched by the change. The encode
// itself needs a browser: measured in Chrome, numbers in the PR.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { classify, sampleGrid, fitEdge, worthIt, untouchable, MAX_EDGE, MIN_GAIN, GRAPHIC_COLOURS, GRAPHIC_FLAT, shrinkNote, fmtBytes } from '../slides/src/editor/shrink.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')

console.log('classification\n')
// a 64×64 "photo": two gradients plus deterministic noise → thousands of bins
const photo = new Uint8ClampedArray(64 * 64 * 4)
let seed = 7
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
  const i = (y * 64 + x) * 4
  photo[i] = (x * 4 + rnd() * 40) & 255
  photo[i + 1] = (y * 4 + rnd() * 40) & 255
  photo[i + 2] = ((x + y) * 2 + rnd() * 40) & 255
  photo[i + 3] = 255
}
ok(classify(photo) === 'photo', 'gradients + noise → photo')
// a smooth sky: a noise-free gradient, every sample point differs from the last
const sky = new Uint8ClampedArray(64 * 64 * 4)
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const i = (y * 64 + x) * 4; sky[i] = 120 + x; sky[i + 1] = 160 + Math.floor(y / 2); sky[i + 2] = 230 - x; sky[i + 3] = 255 }
ok(classify(sky) === 'photo', 'a smooth noise-free gradient (a sky) → photo, not a 4 MB PNG')
// a screenshot: flat background with a few text-like runs → most neighbours identical
const shot = new Uint8ClampedArray(64 * 64 * 4)
for (let k = 0; k < 64 * 64; k++) { const i = k * 4; const ink = k % 7 === 3; shot[i] = ink ? 30 : 244; shot[i + 1] = ink ? 40 : 244; shot[i + 2] = ink ? 60 : 246; shot[i + 3] = 255 }
ok(classify(shot) === 'graphic', 'flat background with text runs (a screenshot) → graphic')
const logo = new Uint8ClampedArray(64 * 64 * 4)
for (let k = 0; k < 64 * 64; k++) { const i = k * 4; const c = [[255, 255, 255], [30, 40, 60], [247, 166, 0]][k % 3]; logo[i] = c[0]; logo[i + 1] = c[1]; logo[i + 2] = c[2]; logo[i + 3] = 255 }
ok(classify(logo) === 'graphic', 'three colours alternating, no runs (a logo) → graphic by colour count')
const alpha = new Uint8ClampedArray(photo); alpha[3] = 200
ok(classify(alpha) === 'graphic', 'one transparent pixel in a photo → graphic (JPEG has no alpha)')
ok(classify(new Uint8ClampedArray(0)) === 'graphic', 'no pixels → graphic (nothing to lose)')
// the flat line: GRAPHIC_FLAT of consecutive samples identical
const runs = (share: number) => { const n = 1000; const a = new Uint8ClampedArray(n * 4); for (let k = 0; k < n; k++) { const i = k * 4; const same = k > 0 && (k * 7919) % 1000 < share * 1000; const v = same ? a[i - 4] : (k * 37) & 255; a[i] = v; a[i + 1] = (v * 3) & 255; a[i + 2] = (v * 5) & 255; a[i + 3] = 255 } return a }
ok(classify(runs(GRAPHIC_FLAT + 0.1)) === 'graphic' && classify(runs(GRAPHIC_FLAT - 0.1)) === 'photo', `the flat line is ${GRAPHIC_FLAT * 100}% identical consecutive samples`)
ok(GRAPHIC_COLOURS <= 64, 'the colour-count line is low enough that a photo of a wall is not a graphic')
// the grid sampler takes real pixels at a stride, in row order
const frame = new Uint8ClampedArray(8 * 4 * 4); for (let k = 0; k < 32; k++) frame[k * 4] = k
const g = sampleGrid(frame, 8, 4, 2)
ok(g.length === 4 * 2 * 4 && g[0] === 0 && g[4] === 2 && g[8] === 4 && g[12] === 6 && g[16] === 16, 'sampleGrid: every step-th pixel, row by row')

console.log('\nthe keep rule\n')
ok(!worthIt(1000, 810), '19% smaller → keep the original')
ok(worthIt(1000, 790), '21% smaller → take it')
ok(worthIt(1000, 800), `exactly ${MIN_GAIN * 100}% → take it`)
ok(!worthIt(1000, 1000) && !worthIt(1000, 1200), 'same or bigger → keep')

console.log('\nthe cap\n')
ok(JSON.stringify(fitEdge(4032, 3024)) === JSON.stringify({ width: 2560, height: 1920 }), '4032×3024 → 2560×1920')
ok(JSON.stringify(fitEdge(3024, 4032)) === JSON.stringify({ width: 1920, height: 2560 }), 'portrait too')
ok(JSON.stringify(fitEdge(1000, 500)) === JSON.stringify({ width: 1000, height: 500 }), '1000×500 stays (never upscaled)')
ok(JSON.stringify(fitEdge(2560, 100)) === JSON.stringify({ width: 2560, height: 100 }), `exactly ${MAX_EDGE} stays`)
ok(fitEdge(10000, 10).height === 3, 'a very wide strip keeps at least a row')

console.log('\nuntouchable formats\n')
ok(untouchable('image/svg+xml') && untouchable('image/gif') && untouchable('IMAGE/GIF'), 'svg and gif are left as they came')
ok(!untouchable('image/png') && !untouchable('image/jpeg') && !untouchable('image/webp'), 'png, jpeg, webp go through')

console.log('\nthe toast\n')
const r = (before: number, after: number, kind: 'photo' | 'graphic' | 'kept') => ({ dataUrl: '', width: 2560, height: 1920, before, after, kind, reason: 'shrunk' as const })
ok(shrinkNote(r(3_000_000, 400_000, 'photo'))?.photo === true, 'a 2.6 MB saving on a photo → a toast, photo wording')
ok(shrinkNote(r(3_000_000, 400_000, 'graphic'))?.photo === false, '…graphic wording for a graphic')
ok(shrinkNote(r(300_000, 150_000, 'photo')) === null, 'a 150 KB saving → no toast (under 200 KB)')
ok(shrinkNote(r(3_000_000, 3_000_000, 'kept')) === null, 'kept → no toast')
ok(shrinkNote(r(3_000_000, 400_000, 'photo'))?.vars.px === 2560, 'the toast names the long edge')
ok(fmtBytes(410 * 1024) === '410 KB' && fmtBytes(3.8 * 1024 * 1024) === '3.8 MB' && fmtBytes(10) === '1 KB', 'bytes read as KB / MB')

console.log('\nevery insert path\n')
const editor = read('slides/src/editor/editor.ts')
const pick = editor.slice(editor.indexOf('private pickImage()'), editor.indexOf('async shrinkForInsert('))
ok(/this\.shrinkForInsert\(file\)/.test(pick) && !/readAsDataURL/.test(pick), 'the file picker goes through shrinkForInsert, not a raw FileReader')
const paste = editor.slice(editor.indexOf('private pasteImageFile('), editor.indexOf('// --- brand palette'))
ok(/this\.shrinkForInsert\(file\)/.test(paste) && !/readAsDataURL/.test(paste), 'paste goes through shrinkForInsert')
ok(/shrinkImageFile\(file\)/.test(editor.slice(editor.indexOf('async shrinkForInsert('))), 'shrinkForInsert calls shrink.ts')
const panels = read('slides/src/editor/panels.ts')
const img = panels.slice(panels.indexOf('private buildImageProps('), panels.indexOf('private buildMediaProps('))
ok(/shrinkImageFile\(file\)/.test(img) && /Replace file \(original size\)/.test(img), 'the panel replaces through the shrink path, with an original-size way out')
ok(/setShrinkEnabled\(/.test(editor) && /shrinkEnabled\(\)/.test(editor), 'the About dialog carries the switch')
ok(/'bento-shrink-photos'/.test(read('slides/src/editor/shrink.ts')), "the preference is localStorage 'bento-shrink-photos'")

console.log('\nthe format\n')
// Not a diff against main: on main that reads as "no later PR may touch
// model.ts". The claim is narrower — shrinking adds nothing to the format —
// so the format is asked directly.
const model = read('slides/src/model.ts')
ok(!/shrink|shrunk|recompress/i.test(model), 'model.ts knows nothing of shrinking — a picture is still a data URI or an asset: key')
const imageIface = model.slice(model.indexOf('export interface ImageElement'), model.indexOf('export interface ImageElement') + 1500)
ok(/src: string/.test(imageIface), 'ImageElement.src is the same string it always was')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
