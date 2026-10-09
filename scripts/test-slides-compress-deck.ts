#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// "Compress pictures in this deck…" (editor/compressdeck.ts): the planning
// half, DOM-free, and the source shape of the browser half.
//
//   node scripts/test-slides-compress-deck.ts
//
// WHAT THIS PROVES. planCompress names exactly the pictures the insert-time
// rules could shrink: image elements only (never media, fonts, svg or code
// themes), an `asset:` key once however many elements share it, an inline
// data URI per element, SVG and GIF left alone by mime before decoding, and
// nothing that is not a data URI. applyCompress writes IN PLACE — same key,
// same element — and drops a replaced asset's blob reference so a live
// session re-uploads the new bytes; unrelated keys, media and fonts are byte-
// identical after it. And the editor runs the dry run before any commit,
// applies the result in ONE commit, and never hides the action behind the
// insert preference (shrinkImageFile is forced).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { planCompress, applyCompress, dataUrlBytes, type DryRun } from '../slides/src/editor/compressdeck.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')

const png = 'data:image/png;base64,' + 'A'.repeat(4000)
const jpg = 'data:image/jpeg;base64,' + 'B'.repeat(4000)
const svg = 'data:image/svg+xml;base64,' + 'C'.repeat(400)
const gif = 'data:image/gif;base64,' + 'D'.repeat(400)
const img = (id: string, src: string) => ({ id, type: 'image', x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1, src })
const doc = {
  format: 'bento/slides', version: 1, title: 'x', size: { width: 1280, height: 720 },
  theme: { background: '#fff', color: '#111', accent: '#f7a600', fontFamily: 'x' },
  assets: { ph1: png, ph2: jpg, logo: svg, anim: gif, font1: 'data:font/woff2;base64,' + 'F'.repeat(400), poster1: jpg, raw: '<svg/>' },
  blobs: { ph1: { key: 'b1', mime: 'image/png', size: 3000 } },
  fonts: [{ family: 'F', asset: 'font1' }],
  slides: [{ id: 's1', elements: [
    img('a', 'asset:ph1'), img('b', 'asset:ph1'), img('c', 'asset:ph2'), img('d', 'asset:logo'), img('e', 'asset:anim'),
    img('f', png), img('g', 'https://example.com/x.png'), img('h', 'asset:raw'), img('i', 'asset:missing'),
    { id: 'm', type: 'media', kind: 'video', x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1, src: 'asset:poster1', poster: 'asset:poster1' },
    { id: 'v', type: 'svg', x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1, asset: 'logo' },
  ] }],
  layouts: [{ id: 'L', elements: [img('la', 'asset:ph2'), img('lb', jpg)] }],
} as never

console.log('the plan\n')
const plan = planCompress(doc)
const keys = plan.map((c) => (c.kind === 'asset' ? `asset:${c.key}` : `inline:${c.elId}`))
ok(keys.includes('asset:ph1') && keys.filter((k) => k === 'asset:ph1').length === 1, 'an asset used by two elements is one candidate')
ok(keys.includes('asset:ph2') && keys.filter((k) => k === 'asset:ph2').length === 1, 'a slide and a layout sharing an asset: still one')
ok(keys.includes('inline:f') && keys.includes('inline:lb'), 'inline data URIs are candidates per element, layouts included')
ok(!keys.includes('asset:logo') && !keys.includes('asset:anim'), 'SVG and GIF are left alone by mime, before any decoding')
ok(!keys.some((k) => k.includes('poster1') || k.includes('font1') || k.includes('missing') || k.includes('raw')), 'media, fonts, raw markup and a missing key are never candidates')
ok(!keys.some((k) => k === 'inline:g'), 'an http src is not a picture we hold')
ok(plan.length === 4, `four candidates in all (${plan.length}: ${keys.join(', ')})`)
ok(dataUrlBytes('data:image/png;base64,QUJD') === 3, 'dataUrlBytes counts the payload (base64 → ¾)')

console.log('\napply, in place, one blob reference dropped\n')
const d2 = JSON.parse(JSON.stringify(doc)) as typeof doc & { assets: Record<string, string>; blobs?: Record<string, unknown>; slides: Array<{ elements: Array<{ id: string; src?: string }> }> }
const small = 'data:image/jpeg;base64,' + 'S'.repeat(100)
const run: DryRun = {
  shrunk: [
    { candidate: plan.find((c) => c.kind === 'asset' && c.key === 'ph1')!, result: { dataUrl: small, width: 1, height: 1, before: 3000, after: 75, kind: 'photo', reason: 'shrunk' } },
    { candidate: plan.find((c) => c.kind === 'inline' && c.elId === 'f')!, result: { dataUrl: small, width: 1, height: 1, before: 3000, after: 75, kind: 'photo', reason: 'shrunk' } },
  ],
  before: 6000, after: 150, examined: 4,
}
const beforeOther = JSON.stringify({ ph2: d2.assets.ph2, logo: d2.assets.logo, font1: d2.assets.font1, poster1: d2.assets.poster1, fonts: (d2 as { fonts: unknown }).fonts, m: d2.slides[0].elements.find((e) => e.id === 'm') })
const n = applyCompress(d2 as never, run)
ok(n === 2, `two pictures written (${n})`)
ok(d2.assets.ph1 === small && d2.slides[0].elements.find((e) => e.id === 'a')!.src === 'asset:ph1', 'the asset value is replaced under the SAME key — references untouched')
ok(d2.blobs?.ph1 === undefined, 'the replaced asset\'s blob reference is dropped so a live session re-uploads')
ok(d2.slides[0].elements.find((e) => e.id === 'f')!.src === small, 'an inline element gets its new bytes')
ok(JSON.stringify({ ph2: d2.assets.ph2, logo: d2.assets.logo, font1: d2.assets.font1, poster1: d2.assets.poster1, fonts: (d2 as { fonts: unknown }).fonts, m: d2.slides[0].elements.find((e) => e.id === 'm') }) === beforeOther, 'every other asset, the fonts and the media element are byte-identical')

console.log('\nthe editor half\n')
const editor = read('slides/src/editor/editor.ts')
const fn = editor.slice(editor.indexOf('private async compressDeckPictures('), editor.indexOf('  toast(message: string) {'))
ok(/await dryRun\(doc/.test(fn) && fn.indexOf('await dryRun(') < fn.indexOf('applyCompress('), 'the dry run runs first, before any commit')
ok((fn.match(/this\.store\.commit\(/g) ?? []).length === 1 && /this\.store\.commit\(\(\) => \{ applied = applyCompress\(/.test(fn), 'the whole pass is ONE store commit — one undo step')
ok(/if \(!run\.shrunk\.length\)[\s\S]*?this\.toast\(/.test(fn) && fn.indexOf('if (!run.shrunk.length)') < fn.indexOf('createDialog('), 'nothing to shrink → a toast, never the dialog')
ok(/createDialog\(\{ title: t\('Compress pictures in this deck'\)/.test(fn), 'the confirmation is the kernel dialog')
const cd = read('slides/src/editor/compressdeck.ts')
ok(/shrinkImageFile\(blob, \{ force: true, skipLossyAtCap: true \}\)/.test(cd), 'the deck pass forces the shrink regardless of the insert preference, and skips lossy pictures already within the cap')
ok(/opts\.skipLossyAtCap && \/\^image\\\/\(jpeg\|webp\)\$\/i\.test\(file\.type\) && Math\.max\(bmp\.width, bmp\.height\) <= MAX_EDGE/.test(read('slides/src/editor/shrink.ts')), 'shrinkImageFile keeps a JPEG/WebP at or under 2560 px when asked — a second pass is a no-op, no generation loss')
ok(/if \(!opts\.force && !shrinkEnabled\(\)\)/.test(read('slides/src/editor/shrink.ts')), 'and shrinkImageFile honours `force`')
ok(/Compress pictures in this deck…/.test(editor.slice(editor.indexOf('private openAbout('), editor.indexOf('private async compressDeckPictures('))), 'the entry lives in the About dialog')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
