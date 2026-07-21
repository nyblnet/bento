#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// Assemble the bento.page landing page: inject the deck's embedded typefaces
// (Fraunces Black + Instrument Sans, from slides/src/fontdata.ts) into the
// template so the page is fully self-contained — no external requests, same
// design language, same faces as the showcase deck.
//
//   node scripts/build-landing.mjs [outPath]     (default: site/index.html)

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = process.argv[2] ?? join(root, 'site/index.html')

const fontSrc = readFileSync(join(root, 'slides/src/fontdata.ts'), 'utf8')
const grab = (name) => {
  const m = fontSrc.match(new RegExp(`export const ${name}\\s*=\\s*'(data:[^']+)'`))
  if (!m) throw new Error(`${name} not found in fontdata.ts`)
  return m[1]
}

let html = readFileSync(join(root, 'site-src/landing.html'), 'utf8')
html = html.replace('__FRAUNCES__', grab('FRAUNCES_900'))
html = html.replace('__INSTRUMENT__', grab('INSTRUMENT_VAR'))

// gallery poster thumbs — small renditions of the decks' public-domain
// photos (scripts/gallery-photos/thumbs), inlined so the page stays
// self-contained
const thumb = (file) =>
  'data:image/jpeg;base64,' + readFileSync(join(root, 'scripts/gallery-photos/thumbs', file)).toString('base64')
for (const [ph, file] of [
  ['__PH_PRESS__', 'press.jpg'], ['__PH_VASE1__', 'vase1.jpg'],
  ['__PH_VASE2__', 'vase2.jpg'], ['__PH_VASE3__', 'vase3.jpg'],
  ['__PH_STARS__', 'stars.jpg'], ['__PH_FAIR__', 'fair.jpg'],
  ['__PH_FAIRWIDE__', 'fairwide.jpg'],
]) html = html.replace(ph, thumb(file))

// Download-pill size claim: measured from the actual shell the download link
// serves, so it can never drift from the real file. Prefer the released copy
// (release.mjs writes it before calling this script); fall back to the local
// build. Rounded to the nearest 10 KB to match the "~" approximate style.
const shellFile = [
  join(root, 'site/releases/slides/Bento_Slides.bento.html'),
  join(root, 'slides/dist-single/Bento_Slides.bento.html'),
].find(existsSync)
if (!shellFile) {
  throw new Error('no built shell found to size the Download pill — cut a release or run `npm run build:single` first')
}
const shellKB = Math.round(statSync(shellFile).size / 1024 / 10) * 10
html = html.replace('__SHELL_KB__', String(shellKB))

if (/__(FRAUNCES|INSTRUMENT|PH_[A-Z0-9]+|SHELL_KB)__/.test(html)) {
  throw new Error('unreplaced placeholder in landing template')
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, html)
console.log(`landing → ${out} (${Math.round(html.length / 1024)} KB, self-contained)`)

// Static site-root assets that travel with the landing: the social share card
// (og:image) plus robots/sitemap. Copied into the same directory as the page.
const siteDir = dirname(out)
for (const f of ['og.png', 'robots.txt', 'sitemap.xml']) {
  const src = join(root, 'site-src', f)
  if (!existsSync(src)) throw new Error(`missing site-src/${f}`)
  copyFileSync(src, join(siteDir, f))
}
console.log(`  + og.png, robots.txt, sitemap.xml → ${siteDir}`)
