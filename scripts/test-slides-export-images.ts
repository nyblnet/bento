#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Export slides as images (discussions #243, #261; design after #306): the
// decisions in slides/src/exportimages.ts, and the shape of the pixel path in
// slides/src/editor/exportimages.ts.
//
//   node scripts/test-slides-export-images.ts
//
// WHAT THIS PROVES. "All slides" is the print set — linear slides in deck
// order, hidden and state slides out. File names pad the page number to two
// digits and sanitise the title with the SAME rule a saved deck's name uses
// (asserted through the kernel symbol itself, not a copy of its regex). JPEG
// gets a white matte and PNG none; scales are exactly 1× and 2×; pixel sizes
// are integers. And the editor half renders through renderSlide in the
// thumbnail/print mode with no PREVIEW_BUDGET tier — a file is not a thumbnail.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  IMAGE_FORMATS, IMAGE_SCALES, exportBase, exportFileName, exportableSlides, matteFor, mimeOf, pixelSize,
} from '../slides/src/exportimages.ts'
import { fileBase, suggestedFileName } from '../kernel/src/save.ts'
import type { BentoDoc, Slide } from '../slides/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')

const slide = (id: string, extra: Partial<Slide> = {}): Slide =>
  ({ id, background: '#fff', transition: 'fade', elements: [], notes: '', ...extra }) as Slide
const doc = (title: string, slides: Slide[], size = { width: 1280, height: 720 }): BentoDoc =>
  ({ title, size, slides, theme: { background: '#fff', color: '#111', accent: '#f7a600', fontFamily: 'x' } }) as unknown as BentoDoc

console.log('which slides\n')
const d = doc('Deck', [slide('a'), slide('b', { hidden: true }), slide('c', { stateOf: 'a' }), slide('d'), slide('e', { hidden: true, stateOf: 'd' })])
ok(exportableSlides(d).map((s) => s.id).join() === 'a,d', 'hidden and state slides are out; the rest in deck order (a,d)')
ok(exportableSlides(doc('x', [])).length === 0, 'an empty deck exports nothing')
const allLinear = doc('x', [slide('1'), slide('2'), slide('3')])
ok(exportableSlides(allLinear).length === 3, 'three plain slides → three pages')
ok(exportableSlides(d).every((s) => d.slides.includes(s)), 'the pages are the deck\'s own slide objects, not copies')

console.log('\nfile names\n')
ok(exportFileName('Deck', 1, 'png') === 'Deck-page-01.png', 'page 1 → -page-01.png')
ok(exportFileName('Deck', 12, 'jpeg') === 'Deck-page-12.jpg', 'page 12 → -page-12.jpg (jpeg is .jpg on disk)')
ok(exportFileName('Deck', 100, 'png') === 'Deck-page-100.png', 'three digits are not truncated')
const messy = doc('My Deck: v2 (final)!', [])
ok(exportBase(messy) === fileBase(suggestedFileName(messy)), 'the base is exactly what the kernel would name a saved copy (same symbol, same rule)')
ok(exportBase(messy) === 'My_Deck_v2_final', `…which sanitises to My_Deck_v2_final (got ${exportBase(messy)})`)
ok(exportBase(doc('', [])) === 'Untitled', 'an untitled deck is "Untitled", as a saved file would be')

console.log('\nformat and size\n')
ok(matteFor('jpeg') === '#ffffff' && matteFor('png') === null, 'JPEG gets a white matte, PNG keeps transparency')
ok(mimeOf('png') === 'image/png' && mimeOf('jpeg') === 'image/jpeg', 'mime types')
ok(IMAGE_SCALES.join() === '1,2' && IMAGE_FORMATS.join() === 'png,jpeg', 'exactly 1× and 2×, PNG and JPEG — no more controls than the three')
ok(pixelSize(d, 2).width === 2560 && pixelSize(d, 2).height === 1440, '2× of 1280×720 is 2560×1440')
const odd = doc('x', [], { width: 1000, height: 562.5 })
ok(Number.isInteger(pixelSize(odd, 1).height) && pixelSize(odd, 1).height === 563, 'pixel sizes are integers (562.5 → 563)')

console.log('\nthe pixel path\n')
const edSrc = read('slides/src/editor/exportimages.ts')
// comments stripped: the header NAMES the things the code must not do
const ed = edSrc.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
ok(/renderSlide\(slide, doc, \{ svgAsImage: true, hidePlaceholders: true \}\)/.test(ed), 'renders through renderSlide in the thumbnail/print mode')
ok(!/PREVIEW_BUDGET|buildSlidePreview|titleCard/.test(ed), 'never tiers by PREVIEW_BUDGET — full fidelity, not a thumbnail')
ok(/bento-fonts/.test(ed), 'the deck\'s @font-face rules ride inside the SVG so text draws in its own type')
ok(/foreignObject/.test(ed) && /toBlob\(/.test(ed), 'SVG foreignObject → canvas → toBlob')
ok(/matteFor\(format\)/.test(ed) && /fillRect/.test(ed), 'the matte is painted before the slide')
ok(/showDirectoryPicker/.test(ed) && !/zip|JSZip|fflate/i.test(ed), 'a folder via the directory picker; no ZIP writer')
ok(/SecurityError/.test(ed), 'a tainted canvas (an image on the web) is a message, not a crash')
ok(/keepHandle|adoptFileHandle/.test(ed) === false, 'never touches the deck\'s own file handle')
const editor = read('slides/src/editor/editor.ts')
ok(/openExportImagesDialog\(this\.store\.doc, this\.store\.slide/.test(editor) && /t\('Export slides as images…'\)/.test(editor), 'the Save menu carries the entry')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
