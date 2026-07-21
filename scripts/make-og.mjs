#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// Compose the social share card (og:image) as a self-contained SVG, using the
// SAME embedded typefaces as the deck/landing so it's on-brand. Writes an SVG;
// it's rasterised to site-src/og.png in the browser (no CLI rasteriser is
// installed) — see the companion step in the build notes. 1200x630 = the
// canonical Open Graph / Twitter summary_large_image size.
//
//   node scripts/make-og.mjs [outPath]   (default: scripts/.cache/og.svg)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = process.argv[2] ?? join(root, 'scripts/.cache/og.svg')

const fontSrc = readFileSync(join(root, 'slides/src/fontdata.ts'), 'utf8')
const grab = (name) => {
  const m = fontSrc.match(new RegExp(`export const ${name}\\s*=\\s*'(data:[^']+)'`))
  if (!m) throw new Error(`${name} not found in fontdata.ts`)
  return m[1]
}
const fraunces = grab('FRAUNCES_900')
const instrument = grab('INSTRUMENT_VAR')

// midnight & peach — the showcase palette, verbatim
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <style>
      @font-face { font-family:'Fraunces'; font-weight:900; src:url(${fraunces}) format('woff2'); }
      @font-face { font-family:'Instrument Sans'; font-weight:100 900; src:url(${instrument}) format('woff2'); }
    </style>
    <radialGradient id="amber" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#FF9E8A" stop-opacity="0.34"/>
      <stop offset="60%" stop-color="#FF9E8A" stop-opacity="0.05"/>
      <stop offset="72%" stop-color="#FF9E8A" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="blue" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#5E7699" stop-opacity="0.40"/>
      <stop offset="60%" stop-color="#5E7699" stop-opacity="0.06"/>
      <stop offset="72%" stop-color="#5E7699" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="1200" height="630" fill="#0D1B2E"/>
  <circle cx="1050" cy="70" r="420" fill="url(#amber)"/>
  <circle cx="120" cy="640" r="380" fill="url(#blue)"/>

  <!-- wordmark: logo tile + Bento/Suite -->
  <g transform="translate(80,74)">
    <rect width="52" height="52" rx="12" fill="#16273E"/>
    <rect x="8" y="8" width="11" height="36" rx="4" fill="#5E7699"/>
    <rect x="23" y="8" width="21" height="16" rx="4" fill="#FF9E8A"/>
    <rect x="23" y="28" width="21" height="16" rx="4" fill="#F0EBE0"/>
    <text x="70" y="35" font-family="Instrument Sans, sans-serif" font-weight="700" font-size="30" fill="#ffffff">Bento<tspan fill="#FF9E8A">/</tspan>Suite</text>
  </g>

  <!-- kicker -->
  <text x="80" y="270" font-family="Instrument Sans, sans-serif" font-weight="700" font-size="21" letter-spacing="6" fill="#FF9E8A">LOCAL-FIRST · AI-NATIVE · E2EE</text>

  <!-- headline -->
  <text font-family="Fraunces, Georgia, serif" font-weight="900" font-size="86" fill="#ffffff" letter-spacing="-1">
    <tspan x="80" y="360">The office suite</tspan>
    <tspan x="80" y="452">that fits in <tspan fill="#FF9E8A">a file.</tspan></tspan>
  </text>

  <!-- sub -->
  <text x="80" y="524" font-family="Instrument Sans, sans-serif" font-weight="500" font-size="27" fill="rgba(182,193,210,0.92)">One HTML file — the document, the editor and the player at once.</text>

  <!-- domain -->
  <text x="1120" y="566" text-anchor="end" font-family="Instrument Sans, sans-serif" font-weight="600" font-size="24" fill="rgba(182,193,210,0.75)">bento.page</text>
</svg>`

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, svg)
console.log(`og card → ${out} (${Math.round(svg.length / 1024)} KB SVG, fonts embedded)`)
