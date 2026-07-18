#!/usr/bin/env node
// U1: the launch announcement IS a deck. This file becomes the Show HN link
// target and the press kit. PRIVATE until launch — built into working/, not
// wired into release.mjs (wire it at T-0, e.g. to site/hello.bento.html).
//
//   node scripts/build-announcement-deck.mjs [outFile]
//   default: working/the-announcement.bento.html

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = process.argv[2] ?? join(root, 'working/the-announcement.bento.html')
const shell = readFileSync(join(root, 'slides/dist-single/Bento_Slides.bento.html'), 'utf8')
const fontSrc = readFileSync(join(root, 'slides/src/fontdata.ts'), 'utf8')
const font = (n) => fontSrc.match(new RegExp(`export const ${n}\\s*=\\s*'(data:[^']+)'`))[1]

// ——— bento.page palette, verbatim ———
const INK = '#0D1B2E', PANEL = '#16273E', PAPER = '#F2F0EA', PEACH = '#FF9E8A'
const PEACH_DEEP = '#C25A43', STEEL = '#5E7699', TILE = '#F0EBE0'
const MIST = 'rgba(182,193,210,0.9)', MIST_DIM = 'rgba(182,193,210,0.55)'
const INK_SOFT = 'rgba(20,34,54,0.75)'
const FR = 'Fraunces, Georgia, serif'
const IN = "'Instrument Sans', 'Helvetica Neue', sans-serif"
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace"

let uid = 0
const id = (p) => `${p}-${(++uid).toString(36)}`
const text = (o) => ({
  id: o.id ?? id('t'), type: 'text', x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: o.rotation ?? 0, opacity: o.opacity ?? 1, html: o.html,
  fontSize: o.fontSize ?? 24, fontFamily: o.fontFamily ?? IN,
  fontWeight: o.fontWeight ?? 400, color: o.color ?? '#fff',
  align: o.align ?? 'left', valign: o.valign ?? 'top', lineHeight: o.lineHeight ?? 1.3,
  ...(o.letterSpacing != null ? { letterSpacing: o.letterSpacing } : {}),
  ...(o.fx ? { fx: o.fx } : {}), ...(o.shadow ? { shadow: o.shadow } : {}),
})
const rect = (o) => ({
  id: o.id ?? id('s'), type: 'shape', shape: o.shape ?? 'rect', x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: o.rotation ?? 0, opacity: o.opacity ?? 1, fill: o.fill, stroke: o.stroke ?? 'none',
  strokeWidth: o.strokeWidth ?? 0, radius: o.radius ?? 0,
  ...(o.fillGradient ? { fillGradient: o.fillGradient } : {}),
  ...(o.strokeStyle ? { strokeStyle: o.strokeStyle } : {}),
  ...(o.fx ? { fx: o.fx } : {}), ...(o.shadow ? { shadow: o.shadow } : {}),
})
const slide = (o) => ({
  id: o.id, background: o.background, transition: o.transition ?? 'fade',
  notes: o.notes ?? '', elements: o.elements,
})
const kick = (x, y, s, color = PEACH) =>
  text({ x, y, w: 900, h: 24, html: s, fontSize: 13, fontWeight: 700, letterSpacing: 5, color })
const glowShadow = { blur: 46, color: 'rgba(255,238,214,0.28)' }

// the three tiles — the deck's morph cast (same trick as the landing mark)
const tiles = (a, b, c) => [
  rect({ id: 'bn-a', fill: PEACH, radius: Math.min(a.w, a.h) * 0.18, shadow: glowShadow, ...a }),
  rect({ id: 'bn-b', fill: STEEL, radius: Math.min(b.w, b.h) * 0.18, ...b }),
  rect({ id: 'bn-c', fill: TILE, radius: Math.min(c.w, c.h) * 0.18, ...c }),
]

const s1 = slide({
  id: 'an-cover', background: INK, transition: 'none',
  notes: 'Hello, Hacker News. You are not reading a blog post about the product — you are inside it. This file is a complete, editable Bento deck: press Escape at any point and you are in the editor. Arrow keys to continue.',
  elements: [
    ...tiles({ x: 950, y: 110, w: 200, h: 200 }, { x: 1064, y: 340, w: 120, h: 180 }, { x: 900, y: 380, w: 120, h: 120 }),
    kick(96, 96, 'SHOW HN — BENTO/SUITE'),
    text({ x: 88, y: 150, w: 880, h: 340, html: 'This announcement<br>is the product.', fontSize: 96, fontFamily: FR, fontWeight: 900, color: '#fff', lineHeight: 1.02 }),
    text({ x: 96, y: 470, w: 700, h: 90, html: 'You are inside a <b>.bento.html</b> file — a presentation that carries its own editor, presenter and format. One file. No install. No account.', fontSize: 20, color: MIST, lineHeight: 1.6, fx: { enter: 'fade-up', order: 1 } }),
    text({ x: 96, y: 640, w: 1000, h: 24, html: '→ ADVANCE · ESC OPENS THE EDITOR ON THIS VERY FILE', fontSize: 12, fontWeight: 700, letterSpacing: 3, color: 'rgba(255,158,138,0.85)', fx: { enter: 'fade-up', order: 2 } }),
  ],
})

const s2 = slide({
  id: 'an-onefile', background: INK, transition: 'morph',
  notes: 'The whole product in one sentence. The tiles just morphed because they share ids across slides — that is Bento’s native transition, computed from the model, not the DOM.',
  elements: [
    ...tiles({ x: 96, y: 120, w: 110, h: 110 }, { x: 226, y: 120, w: 70, h: 110 }, { x: 316, y: 120, w: 64, h: 64 }),
    text({ x: 90, y: 280, w: 1100, h: 160, html: 'One file is the app.', fontSize: 84, fontFamily: FR, fontWeight: 900, color: '#fff', lineHeight: 1 }),
    text({ x: 96, y: 440, w: 1000, h: 130, html: 'Deck, viewer, presenter, editor, fonts, images, charts — all inside one ~400 KB HTML file that <b>saves itself</b>. Email it, AirDrop it, archive it for a decade. Every copy is the complete product.', fontSize: 21, color: MIST, lineHeight: 1.65, fx: { enter: 'fade-up' } }),
    text({ x: 96, y: 640, w: 900, h: 24, html: 'NOTHING TO INSTALL · NOTHING TO EXPIRE · WORKS FROM file://', fontSize: 12, fontWeight: 700, letterSpacing: 3, color: MIST_DIM, fx: { enter: 'fade-up', order: 2 } }),
  ],
})

const s3 = slide({
  id: 'an-source', background: PAPER, transition: 'fade',
  notes: 'View-source honesty. The document is a plaintext JSON block at the top of the file — open this file in a text editor and there it is. No binary, no lock-in. This is also what makes AI editing trivial.',
  elements: [
    kick(96, 96, 'VIEW-SOURCE HONEST', PEACH_DEEP),
    text({ x: 90, y: 140, w: 1000, h: 110, html: 'Your data is right there.', fontSize: 64, fontFamily: FR, fontWeight: 900, color: INK, lineHeight: 1 }),
    rect({ x: 96, y: 270, w: 1088, h: 330, fill: '#0A1524', radius: 16, shadow: { y: 20, blur: 50, color: 'rgba(13,27,46,0.35)' }, fx: { enter: 'fade-up' } }),
    text({ x: 130, y: 300, w: 1020, h: 280, fontFamily: MONO, fontSize: 17, lineHeight: 1.75, color: '#8FA3BF', fx: { enter: 'fade-up' }, html:
      '&lt;script type="application/bento+json" id="bento-doc"&gt;<br>' +
      '{ "format": "bento/slides",<br>' +
      '&nbsp;&nbsp;"title": <span style="color:#cfe0c5">"This announcement is the product"</span>,<br>' +
      '&nbsp;&nbsp;"slides": [ <span style="color:#FFBCA8">…the slide you are reading…</span> ] }<br>' +
      '&lt;/script&gt;' }),
    text({ x: 96, y: 632, w: 1000, h: 30, html: 'Open this file in a text editor — that block is the whole document. The rest is the runtime.', fontSize: 16, color: INK_SOFT, fx: { enter: 'fade-up', order: 2 } }),
  ],
})

const s4 = slide({
  id: 'an-collab', background: INK, transition: 'fade',
  notes: 'Collaboration without accounts: keys are minted client-side at document creation and live in the file. The relay stores ciphertext and learns nothing — its source is about one file, read it. Offline edits merge back through our own CRDT (character-level text merging included), verified by a convergence rig across hundreds of thousands of checks.',
  elements: [
    kick(96, 96, 'TOGETHER, LIVE'),
    text({ x: 90, y: 140, w: 1100, h: 200, html: 'The file is<br>the invitation.', fontSize: 76, fontFamily: FR, fontWeight: 900, color: '#fff', lineHeight: 1.02 }),
    text({ x: 96, y: 360, w: 1000, h: 90, html: 'Start a live session and send the file — anyone who opens a copy joins. <b>E2EE</b>, keys never leave the file, and offline edits merge back both ways when people return.', fontSize: 20, color: MIST, lineHeight: 1.6, fx: { enter: 'fade-up' } }),
    ...[['E2EE', 'AES-GCM, keys in your file'], ['BLIND RELAY', 'stores ciphertext, learns nothing'], ['OWN CRDT', 'char-level merges, fuzz-tested']].map(([h, b], i) => [
      rect({ x: 96 + i * 372, y: 490, w: 340, h: 120, fill: PANEL, radius: 16, fx: { enter: 'fade-up', order: i + 1 } }),
      text({ x: 120 + i * 372, y: 512, w: 292, h: 30, html: h, fontSize: 14, fontWeight: 800, letterSpacing: 3, color: PEACH, fx: { enter: 'fade-up', order: i + 1 } }),
      text({ x: 120 + i * 372, y: 546, w: 292, h: 50, html: b, fontSize: 15, color: MIST, lineHeight: 1.45, fx: { enter: 'fade-up', order: i + 1 } }),
    ]).flat(),
  ],
})

const s5 = slide({
  id: 'an-ai', background: PAPER, transition: 'fade',
  notes: 'Full disclosure: an AI agent designed and wrote this deck — and the four templates in the gallery — by editing the JSON directly. The recipe your agent needs is one markdown file: bento.page/agents.md. If you never touch AI, nothing here ever will either.',
  elements: [
    kick(96, 96, 'DESIGNED FOR AI · ENTIRELY OPTIONAL', PEACH_DEEP),
    text({ x: 90, y: 140, w: 1100, h: 200, html: 'An agent wrote<br>this deck.', fontSize: 76, fontFamily: FR, fontWeight: 900, color: INK, lineHeight: 1.02 }),
    text({ x: 96, y: 370, w: 1000, h: 130, html: 'The document is plain JSON in the file, so agents edit <b>.bento.html</b> files in place and chatbots round-trip the JSON. No converters, no uploads, no .pptx archaeology — this deck and the whole template gallery were authored that way.', fontSize: 20, color: INK_SOFT, lineHeight: 1.6, fx: { enter: 'fade-up' } }),
    rect({ x: 96, y: 540, w: 620, h: 70, fill: INK, radius: 35, fx: { enter: 'fade-up', order: 2 } }),
    text({ x: 96, y: 562, w: 620, h: 30, html: 'bento.page/agents.md — the recipe for your agent', fontSize: 17, fontWeight: 600, color: TILE, align: 'center', fx: { enter: 'fade-up', order: 2 } }),
  ],
})

const s6 = slide({
  id: 'an-forever', background: INK, transition: 'fade',
  notes: 'Local-first, provably: Offline mode hard-blocks every network feature. Updates are ECDSA-signed, verified in-app, and write a NEW file — the old one stays as rollback. If bento.page vanished tomorrow, every file keeps working. That is the whole point.',
  elements: [
    kick(96, 96, 'LOCAL-FIRST, PROVABLY'),
    text({ x: 90, y: 140, w: 1100, h: 200, html: 'This file will open<br>in 2036.', fontSize: 76, fontFamily: FR, fontWeight: 900, color: '#fff', lineHeight: 1.02 }),
    text({ x: 96, y: 370, w: 1000, h: 140, html: 'No account. No telemetry. An <b>Offline mode</b> that hard-blocks everything network-shaped. Signed updates you apply yourself — each one writes a new file, so the old one is your rollback. Documents should outlive the companies that made them.', fontSize: 20, color: MIST, lineHeight: 1.62, fx: { enter: 'fade-up' } }),
    text({ x: 96, y: 620, w: 1000, h: 30, html: 'IF BENTO.PAGE VANISHED TONIGHT, EVERY FILE KEEPS OPENING, EDITING, PRESENTING.', fontSize: 12, fontWeight: 700, letterSpacing: 3, color: MIST_DIM, fx: { enter: 'fade-up', order: 2 } }),
  ],
})

const s7 = slide({
  id: 'an-honest', background: PANEL, transition: 'fade',
  notes: 'The honest slide. Undo during live collab is snapshot-based and can revert a collaborator’s concurrent edit to the same property (documented LWW compromise). Editing is desktop-first; phones view and present well. Fullscreen needs a user gesture. Files grow with embedded images. We would rather you hear it from us.',
  elements: [
    kick(96, 96, 'WHAT IT DOESN’T DO (YET)'),
    text({ x: 90, y: 140, w: 1000, h: 110, html: 'The honest slide.', fontSize: 64, fontFamily: FR, fontWeight: 900, color: '#fff', lineHeight: 1 }),
    text({ x: 96, y: 280, w: 1040, h: 300, fontSize: 20, color: MIST, lineHeight: 1.9, fx: { enter: 'fade-up' }, html:
      '· Undo during live collab is snapshot-based — it can revert a peer’s concurrent edit<br>' +
      '· Editing is desktop-first; phones are for viewing and presenting<br>' +
      '· Fullscreen needs a user gesture; some embeds deny it (we degrade to tab mode)<br>' +
      '· Files grow with embedded images — no optimizer yet<br>' +
      '· Docs and Sheets don’t exist yet. Slides came first.' }),
    text({ x: 96, y: 620, w: 1000, h: 30, html: 'TRADE-OFFS ARE DESIGN. WE’D RATHER DISCLOSE THAN DISAPPOINT.', fontSize: 12, fontWeight: 700, letterSpacing: 3, color: 'rgba(255,158,138,0.7)', fx: { enter: 'fade-up', order: 2 } }),
  ],
})

const s8 = slide({
  id: 'an-close', background: INK, transition: 'morph',
  notes: 'The close. This file is now the reader’s: because it is a template, saving mints a fresh identity automatically — their copy is theirs, keys and all. That is the viral loop: every shared deck is a working install.',
  elements: [
    ...tiles({ x: 540, y: 90, w: 200, h: 200 }, { x: 464, y: 210, w: 120, h: 180 }, { x: 700, y: 230, w: 120, h: 120 }),
    text({ x: 140, y: 360, w: 1000, h: 130, html: 'One file. Yours. Forever.', fontSize: 74, fontFamily: FR, fontWeight: 900, color: '#fff', align: 'center', lineHeight: 1 }),
    text({ x: 140, y: 500, w: 1000, h: 60, html: '<b>bento.page</b> — the site &nbsp;·&nbsp; <b>bento.page/slides</b> — the app &nbsp;·&nbsp; the gallery — decks to steal', fontSize: 19, color: MIST, align: 'center', lineHeight: 1.6, fx: { enter: 'fade-up' } }),
    text({ x: 140, y: 600, w: 1000, h: 30, html: 'PRESS ESC AND SAVE A COPY — THIS ANNOUNCEMENT IS NOW YOUR DECK. FRESH IDENTITY INCLUDED.', fontSize: 12, fontWeight: 700, letterSpacing: 2.5, color: 'rgba(255,158,138,0.85)', align: 'center', fx: { enter: 'fade-up', order: 2 } }),
  ],
})

const doc = {
  format: 'bento/slides', version: 1, title: 'This announcement is the product',
  size: { width: 1280, height: 720 }, template: true,
  theme: { background: INK, color: '#fff', accent: PEACH, fontFamily: IN },
  assets: { 'font-fraunces': font('FRAUNCES_900'), 'font-instrument': font('INSTRUMENT_VAR') },
  fonts: [
    { family: 'Fraunces', asset: 'font-fraunces', weight: '900' },
    { family: 'Instrument Sans', asset: 'font-instrument', weight: '100 900' },
  ],
  present: { progress: true },
  slides: [s1, s2, s3, s4, s5, s6, s7, s8],
  modified: new Date().toISOString(),
}

const blockRe = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/
const json = JSON.stringify(doc).replace(/</g, '\\u003c')
const spliced = shell.replace(blockRe, `<script type="application/bento+json" id="bento-doc">\n${json}\n</scr` + 'ipt>')
if (!spliced.includes(json)) throw new Error('splice failed')
writeFileSync(out, spliced)
console.log(`announcement → ${out} (${doc.slides.length} slides, ${Math.round(spliced.length / 1024)} KB)`)
