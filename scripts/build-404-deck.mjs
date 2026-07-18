#!/usr/bin/env node
// The 404 page's punchline: a tiny, fully working deck. Spliced from the
// built shell like the gallery decks; template:true so every open is fresh.
//
//   node scripts/build-404-deck.mjs [outFile]   (default: working/404.bento.html)

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = process.argv[2] ?? join(root, 'working/404.bento.html')
const shell = readFileSync(join(root, 'slides/dist-single/Bento_Slides.bento.html'), 'utf8')

const fontSrc = readFileSync(join(root, 'slides/src/fontdata.ts'), 'utf8')
const font = (name) => fontSrc.match(new RegExp(`export const ${name}\\s*=\\s*'(data:[^']+)'`))[1]

const INK = '#0D1B2E', PANEL = '#16273E', PEACH = '#FF9E8A', PAPER = '#F0EBE0', STEEL = '#5E7699'
const MIST = 'rgba(182,193,210,0.85)'
const FR = 'Fraunces, Georgia, serif'
const IN = "'Instrument Sans', 'Helvetica Neue', sans-serif"

const doc = {
  format: 'bento/slides', version: 1, title: '404 — this deck does not exist',
  size: { width: 1280, height: 720 }, template: true,
  theme: { background: INK, color: '#fff', accent: PEACH, fontFamily: IN },
  assets: { 'font-fraunces': font('FRAUNCES_900'), 'font-instrument': font('INSTRUMENT_VAR') },
  fonts: [
    { family: 'Fraunces', asset: 'font-fraunces', weight: '900' },
    { family: 'Instrument Sans', asset: 'font-instrument', weight: '100 900' },
  ],
  slides: [
    {
      id: 'nf-1', background: INK, transition: 'none',
      notes: 'You found the easter egg. The 404 page of bento.page is, of course, a fully working Bento deck — press Escape and you are in the editor. Save a copy: it is yours (fresh identity, automatically).',
      elements: [
        { id: 'nf-tile-a', type: 'shape', shape: 'rect', x: 900, y: 130, w: 190, h: 190, rotation: 0, opacity: 1, fill: PEACH, stroke: 'none', strokeWidth: 0, radius: 34 },
        { id: 'nf-tile-b', type: 'shape', shape: 'rect', x: 1010, y: 350, w: 130, h: 190, rotation: 0, opacity: 1, fill: STEEL, stroke: 'none', strokeWidth: 0, radius: 28 },
        { id: 'nf-tile-c', type: 'shape', shape: 'rect', x: 850, y: 400, w: 120, h: 120, rotation: 0, opacity: 1, fill: PAPER, stroke: 'none', strokeWidth: 0, radius: 24 },
        { id: 'nf-404', type: 'text', x: 80, y: 110, w: 700, h: 300, rotation: 0, opacity: 1, html: '404', fontSize: 260, fontFamily: FR, fontWeight: 900, color: PEACH, align: 'left', valign: 'top', lineHeight: 0.9 },
        { id: 't-a', type: 'text', x: 96, y: 420, w: 760, h: 60, rotation: 0, opacity: 1, html: 'This slide does not exist.', fontSize: 40, fontFamily: FR, fontWeight: 900, color: '#fff', align: 'left', valign: 'top', lineHeight: 1.1, fx: { enter: 'fade-up', order: 1 } },
        { id: 't-b', type: 'text', x: 96, y: 500, w: 760, h: 60, rotation: 0, opacity: 1, html: 'It is, however, a fully working presentation app.', fontSize: 19, fontFamily: IN, fontWeight: 400, color: MIST, align: 'left', valign: 'top', lineHeight: 1.5, fx: { enter: 'fade-up', order: 2 } },
        { id: 't-c', type: 'text', x: 96, y: 640, w: 900, h: 24, rotation: 0, opacity: 1, html: '→ NEXT SLIDE · ESC OPENS THE EDITOR (REALLY)', fontSize: 12, fontFamily: IN, fontWeight: 700, color: 'rgba(255,158,138,0.8)', align: 'left', valign: 'top', lineHeight: 1.3, letterSpacing: 3 },
      ],
    },
    {
      id: 'nf-2', background: PANEL, transition: 'morph',
      notes: 'The tiles morphed because they share ids with slide 1 — that is the whole trick. Links below are plain text on purpose: type them, or press Escape and keep this deck.',
      elements: [
        { id: 'nf-tile-a', type: 'shape', shape: 'rect', x: 96, y: 120, w: 90, h: 90, rotation: 0, opacity: 1, fill: PEACH, stroke: 'none', strokeWidth: 0, radius: 20 },
        { id: 'nf-tile-b', type: 'shape', shape: 'rect', x: 206, y: 120, w: 62, h: 90, rotation: 0, opacity: 1, fill: STEEL, stroke: 'none', strokeWidth: 0, radius: 16 },
        { id: 'nf-tile-c', type: 'shape', shape: 'rect', x: 288, y: 120, w: 58, h: 58, rotation: 0, opacity: 1, fill: PAPER, stroke: 'none', strokeWidth: 0, radius: 14 },
        { id: 'nf-404', type: 'text', x: 96, y: 250, w: 1000, h: 140, rotation: 0, opacity: 1, html: 'Everything else exists.', fontSize: 76, fontFamily: FR, fontWeight: 900, color: '#fff', align: 'left', valign: 'top', lineHeight: 1 },
        { id: 't-a2', type: 'text', x: 96, y: 430, w: 1000, h: 140, rotation: 0, opacity: 1, html: '<b>bento.page</b> — the site<br><b>bento.page/slides</b> — the app, in your browser<br><b>bento.page/#gallery</b> — decks to steal', fontSize: 22, fontFamily: IN, fontWeight: 400, color: MIST, align: 'left', valign: 'top', lineHeight: 1.75, fx: { enter: 'fade-up' } },
        { id: 't-b2', type: 'text', x: 96, y: 640, w: 1000, h: 24, rotation: 0, opacity: 1, html: 'P.S. SAVE A COPY — THIS 404 IS YOURS NOW', fontSize: 12, fontFamily: IN, fontWeight: 700, color: 'rgba(255,158,138,0.8)', align: 'left', valign: 'top', lineHeight: 1.3, letterSpacing: 3, fx: { enter: 'fade-up', order: 2 } },
      ],
    },
  ],
  modified: new Date().toISOString(),
}

const blockRe = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/
const json = JSON.stringify(doc).replace(/</g, '\\u003c')
const spliced = shell.replace(blockRe, `<script type="application/bento+json" id="bento-doc">\n${json}\n</scr` + 'ipt>')
if (!spliced.includes(json)) throw new Error('splice failed')
writeFileSync(out, spliced)
console.log(`404 deck → ${out} (${Math.round(spliced.length / 1024)} KB)`)
