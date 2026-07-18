#!/usr/bin/env node
// Assemble the bento.page landing page: inject the deck's embedded typefaces
// (Fraunces Black + Instrument Sans, from slides/src/fontdata.ts) into the
// template so the page is fully self-contained — no external requests, same
// design language, same faces as the showcase deck.
//
//   node scripts/build-landing.mjs [outPath]     (default: site/index.html)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
]) html = html.replace(ph, thumb(file))

if (/__(FRAUNCES|INSTRUMENT|PH_[A-Z0-9]+)__/.test(html)) {
  throw new Error('unreplaced placeholder in landing template')
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, html)
console.log(`landing → ${out} (${Math.round(html.length / 1024)} KB, self-contained)`)
