#!/usr/bin/env node
// "This QR code is a presentation" — builds site/q/index.html from
// site-src/q.html: composes a tiny deck, deflates it into a base64url
// payload (the QR encodes URL#payload — the deck literally lives in the
// code), and inlines a QR SVG generated with the `qrcode` npm CLI.
//
//   node scripts/build-qr-page.mjs [outFile]   (default: site/q/index.html)

import { execFileSync } from 'node:child_process'
import { deflateRawSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = process.argv[2] ?? join(root, 'site/q/index.html')

// the deck that fits in a QR — text + flat shapes only (the projector
// page renders exactly this subset)
const INK = '#0D1B2E', PEACH = '#FF9E8A', PAPER = '#F0EBE0', STEEL = '#5E7699'
const doc = {
  format: 'bento/slides', version: 1, title: 'The QR deck',
  size: { width: 1280, height: 720 },
  slides: [
    { id: 'q1', background: INK, elements: [
      { id: 'a', type: 'shape', shape: 'rect', x: 960, y: 120, w: 150, h: 150, fill: PEACH, radius: 30 },
      { id: 'b', type: 'shape', shape: 'rect', x: 1010, y: 300, w: 100, h: 150, fill: STEEL, radius: 24 },
      { id: 'c', type: 'shape', shape: 'ellipse', x: 900, y: 330, w: 90, h: 90, fill: PAPER },
      { id: 't1', type: 'text', x: 96, y: 170, w: 800, h: 260, html: 'You scanned<br>a slideshow.', fontSize: 84, fontWeight: 800, color: '#fff', lineHeight: 1.05, fontFamily: 'Georgia, serif' },
      { id: 't2', type: 'text', x: 96, y: 460, w: 760, h: 80, html: 'This entire deck travelled inside the QR code — compressed JSON in the URL fragment. No server ever saw it.', fontSize: 21, color: 'rgba(182,193,210,0.9)', lineHeight: 1.5 },
      { id: 't3', type: 'text', x: 96, y: 620, w: 800, h: 30, html: '→ NEXT', fontSize: 13, fontWeight: 700, color: PEACH, letterSpacing: 4 },
    ] },
    { id: 'q2', background: PAPER, elements: [
      { id: 't4', type: 'text', x: 96, y: 150, w: 1080, h: 220, html: 'A deck in 3 KB.<br>An office suite in one file.', fontSize: 66, fontWeight: 800, color: INK, lineHeight: 1.1, fontFamily: 'Georgia, serif' },
      { id: 't5', type: 'text', x: 96, y: 420, w: 900, h: 120, html: 'Real Bento decks carry their own editor, presenter, charts and end-to-end-encrypted collaboration. Still just a file.', fontSize: 22, color: 'rgba(13,27,46,0.75)', lineHeight: 1.55 },
      { id: 't6', type: 'text', x: 96, y: 590, w: 900, h: 60, html: 'bento.page', fontSize: 40, fontWeight: 800, color: '#C25A43' },
    ] },
  ],
}

const payload = deflateRawSync(JSON.stringify(doc), { level: 9 })
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const url = `https://bento.page/q#${payload}`
console.log(`qr payload: ${payload.length} chars (${url.length} total in QR)`)

// QR SVG via the qrcode npm package CLI (cached by npx after first run)
const tmp = join(tmpdir(), `bento-qr-${process.pid}.svg`)
execFileSync('npx', ['--yes', 'qrcode', '-t', 'svg', '-e', 'M', '-o', tmp, url], { stdio: 'inherit' })
let svg = readFileSync(tmp, 'utf8')
rmSync(tmp)
svg = svg.replace(/<\?xml[^>]*\?>/, '')

let html = readFileSync(join(root, 'site-src/q.html'), 'utf8')
html = html.replace('__QR_SVG__', svg)
html = html.replace('__PAYLOAD__', payload)
if (/__(QR_SVG|PAYLOAD)__/.test(html)) throw new Error('placeholder not replaced')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, html)
console.log(`qr page → ${out} (${Math.round(html.length / 1024)} KB)`)
