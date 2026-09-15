#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Image crop rig (discussion #319): the crop → CSS mapping, the shape gate,
// and the one-renderer invariant.
//
//   slides/node_modules/.bin/esbuild scripts/test-slides-crop.ts --bundle --platform=node --format=esm --outfile=/tmp/test-slides-crop.mjs
//   node /tmp/test-slides-crop.mjs
//
// (bundled: untrusted.ts imports without extensions)
//
// WHAT THIS PROVES. crop.ts turns {x, y, scale} into inline CSS for the <img>
// such that the frame can never show empty space: the img box is never
// smaller than the frame, the offset moves it by exactly the overhang, and
// object-position moves the cover overflow by the same fraction. Absent → no
// crop styles; centred 1× is identity; out-of-range numbers clamp. The shape
// gate admits `crop` with the right types and drops a wrong shape. render.ts
// applies the crop in the ONE element renderer, and the preview/thumbnail
// paths have no image branch of their own, so canvas, thumbnails, present,
// print and the file-manager preview agree.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeCrop, cropImgStyle, cropWindow, isIdentityCrop, lerpCrop, CROP_MAX_SCALE } from '../slides/src/crop.ts'
import { sanitizeElement } from '../slides/src/untrusted.ts'
import { MODEL_KEYS } from '../slides/src/modelkeys.generated.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
// bundled rigs run from the repo root (CI does; so does the command above)
const root = process.cwd()
const read = (f: string) => readFileSync(join(root, f), 'utf8')
const css = (s: string) => Object.fromEntries(s.split(';').filter(Boolean).map((kv) => kv.split(':').map((x) => x.trim()) as [string, string]))

console.log('the mapping\n')
ok(normalizeCrop(undefined) === null && normalizeCrop(null) === null, 'absent → null (no crop styles)')
ok(isIdentityCrop({ x: 0.5, y: 0.5, scale: 1 }), 'centred 1× is identity — same picture as no crop')
ok(!isIdentityCrop({ x: 0.5, y: 0.5, scale: 1.01 }) && !isIdentityCrop({ x: 0, y: 0.5, scale: 1 }), 'any zoom or pan is not identity')
let s = css(cropImgStyle({ x: 1, y: 0, scale: 2 }))
ok(s.width === '200%' && s.height === '200%', 'scale 2 → img box 200% of the frame on both axes')
ok(s.left === '-100%' && s.top === '0%', 'x=1 → shifted left by the whole overhang (right edge aligned); y=0 → not shifted')
ok(s['object-position'] === '100% 0%', 'object-position follows the same fractions')
ok(s['object-fit'] === 'cover' && s.position === 'absolute' && s['max-width'] === 'none', 'cover, absolute, no max-width cap')
s = css(cropImgStyle({ x: 0.5, y: 0.5, scale: 1 }))
ok(s.width === '100%' && s.left === '0%' && s.top === '0%' && s['object-position'] === '50% 50%', 'centred 1× → 100% box, no offset, centred cover')
s = css(cropImgStyle({ x: 0.25, y: 0.75, scale: 3 }))
ok(s.left === '-50%' && s.top === '-150%', 'scale 3, x .25 → left −50% (= −(3−1)·.25); y .75 → top −150%')

console.log('\nnever a blank frame\n')
// for every x, y, scale the img box covers the frame [0,1]×[0,1]
let covered = true
for (const scale of [1, 1.5, 2, 4, CROP_MAX_SCALE]) for (const x of [0, 0.3, 0.5, 1]) for (const y of [0, 0.7, 1]) {
  const o = css(cropImgStyle({ x, y, scale }))
  const left = parseFloat(o.left) / 100, top = parseFloat(o.top) / 100, w = parseFloat(o.width) / 100, h = parseFloat(o.height) / 100
  if (left > 1e-9 || top > 1e-9 || left + w < 1 - 1e-9 || top + h < 1 - 1e-9) covered = false
}
ok(covered, 'at every sampled x, y, scale the img box covers the whole frame (left ≤ 0, right ≥ 1, same vertically)')
ok(normalizeCrop({ x: 1.7, y: -2, scale: 0.2 })!.x === 1 && normalizeCrop({ x: 1.7, y: -2, scale: 0.2 })!.y === 0, 'x, y clamp into 0..1')
ok(normalizeCrop({ x: 0.5, y: 0.5, scale: 0.2 })!.scale === 1, 'scale below 1 is treated as 1 (never smaller than the frame)')
ok(normalizeCrop({ x: 0.5, y: 0.5, scale: 99 })!.scale === CROP_MAX_SCALE, `scale clamps at ${CROP_MAX_SCALE}`)
ok(normalizeCrop({ x: NaN, y: Infinity, scale: 'x' as never })!.x === 0.5 && normalizeCrop({ x: NaN, y: Infinity, scale: 'x' as never })!.scale === 1, 'non-numbers fall to the identity values')
const win = cropWindow({ x: 1, y: 0, scale: 2 })
ok(win[0] === 0.5 && win[1] === 0 && win[2] === 0.5 && win[3] === 0.5, 'x=1 y=0 scale=2: the window is the top-right quarter of the picture')
const mid = lerpCrop({ x: 0, y: 0, scale: 1 }, { x: 1, y: 1, scale: 3 }, 0.5)
ok(mid.x === 0.5 && mid.y === 0.5 && mid.scale === 2, 'lerp at p=.5 is the numeric midpoint (morph)')

console.log('\nthe shape gate\n')
const base = { id: 'i1', type: 'image', x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1, src: 'data:image/png;base64,AAAA', fit: 'cover', radius: 0 }
const good = sanitizeElement({ ...base, crop: { x: 1, y: 0, scale: 2 } }) as { crop?: unknown } | null
ok(!!good && JSON.stringify(good.crop) === JSON.stringify({ x: 1, y: 0, scale: 2 }), 'a well-formed crop passes the gate intact')
const noCrop = sanitizeElement(base) as { crop?: unknown } | null
ok(!!noCrop && !('crop' in noCrop), 'no crop → no crop key')
const bad = sanitizeElement({ ...base, crop: { x: 'left', y: 0, scale: 2 } }) as { crop?: unknown } | null
ok(!!bad && bad.crop === undefined, 'a wrong-typed field drops the crop, the element survives')
const missing = sanitizeElement({ ...base, crop: { x: 1, scale: 2 } }) as { crop?: unknown } | null
ok(!!missing && missing.crop === undefined, 'a crop missing a required number is dropped')
const extra = sanitizeElement({ ...base, crop: { x: 1, y: 0, scale: 2, onload: 'x' } }) as { crop?: Record<string, unknown> } | null
ok(!!extra?.crop && !('onload' in extra.crop), 'an unknown key inside crop is stripped')
const oor = sanitizeElement({ ...base, crop: { x: 5, y: 0, scale: 2 } }) as { crop?: unknown } | null
ok(!!oor && oor.crop === undefined, 'an out-of-range number is refused by the gate (crop.ts clamps only what the gate let through)')
ok(JSON.stringify(MODEL_KEYS.imageCrop) === JSON.stringify(['scale', 'x', 'y']), 'modelkeys carries imageCrop = scale, x, y')
ok(MODEL_KEYS.element.image.includes('crop'), 'modelkeys: image elements may carry crop')

console.log('\none renderer\n')
const render = read('slides/src/render.ts')
ok(/case 'image': \{[\s\S]*?if \(el\.crop && !isIdentityCrop\(el\.crop\)\) \{[\s\S]*?img\.style\.cssText = cropImgStyle\(el\.crop\)/.test(render), 'render.ts applies the crop in the single image branch via cropImgStyle')
ok((render.match(/document\.createElement\('img'\)/g) ?? []).length >= 1 && !/case 'image'[\s\S]*case 'image'/.test(render), 'exactly one image branch — thumbnails, present, print and preview all come through it')
ok(!/cropImgStyle|\.crop\b/.test(read('slides/src/preview.ts')), 'preview.ts has no crop code of its own (it staticizes the same render)')
ok(/lerpCrop\(a\.crop!, b\.crop!, state\.p\)/.test(read('slides/src/present.ts')), 'present.ts tweens the crop when both sides carry one')
ok(/a\.crop && b\.crop && !isIdentityCrop\(a\.crop\) && !isIdentityCrop\(b\.crop\)/.test(read('slides/src/present.ts')), '…and only then — one-sided crops snap')
const canvas = read('slides/src/editor/canvas.ts')
ok(/closest<HTMLElement>\('\.bento-el-image'\)[\s\S]*?this\.startCropEdit\(/.test(canvas), 'double-click on a picture enters crop mode')
ok(/this\.cropEditor\?\.active \|\| handled \? \[\] : this\.selectedNodes\(\)/.test(canvas), 'Moveable stands down while cropping')
ok(/private buildCropProps\(el: ImageElement\)/.test(read('slides/src/editor/panels.ts')), 'the image panel has a Crop block')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
