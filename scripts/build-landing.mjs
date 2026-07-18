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
if (html.includes('__FRAUNCES__') || html.includes('__INSTRUMENT__')) {
  throw new Error('font placeholder not replaced')
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, html)
console.log(`landing → ${out} (${Math.round(html.length / 1024)} KB, self-contained)`)
