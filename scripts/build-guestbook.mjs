#!/usr/bin/env node
// U2: the public guestbook deck — one live-collab file anyone can open and
// sign. Minting fresh credentials IS the reset mechanism ("epochs, not
// moderation" — see working/guestbook-design.md).
//
//   node scripts/build-guestbook.mjs [--host wss://sync.bento.page] [--out <file>]
//
// Behaviour: if the out file already exists, it is archived to
// working/guestbook-epochs/ and the new build gets epoch N+1 with FRESH
// room + key (the old room orphans instantly). Default out:
// working/guestbook-live/guestbook.bento.html — release.mjs ships that
// file to bento.page/guestbook.bento.html when it exists.

import { webcrypto as crypto } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const host = opt('host', 'wss://sync.bento.page')
const out = opt('out', join(root, 'working/guestbook-live/guestbook.bento.html'))

const shell = readFileSync(join(root, 'slides/dist-single/Bento_Slides.bento.html'), 'utf8')
const fontSrc = readFileSync(join(root, 'slides/src/fontdata.ts'), 'utf8')
const font = (n) => fontSrc.match(new RegExp(`export const ${n}\\s*=\\s*'(data:[^']+)'`))[1]

// ——— credentials, exactly like the app mints them (online.ts) ———————
const b64u = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const rnd = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return b }
const collab = { room: `${host}/d/r${b64u(rnd(12))}`, key: b64u(rnd(32)), on: true }
const docId = crypto.randomUUID()

// ——— epoch bookkeeping ————————————————————————————————————————————
let epoch = 1
if (existsSync(out)) {
  const prev = readFileSync(out, 'utf8')
  const m = prev.match(/"guestbookEpoch":(\d+)/)
  epoch = m ? Number(m[1]) + 1 : 2
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const archiveDir = join(root, 'working/guestbook-epochs')
  mkdirSync(archiveDir, { recursive: true })
  copyFileSync(out, join(archiveDir, `epoch-${epoch - 1}-${stamp}.bento.html`))
  console.log(`archived epoch ${epoch - 1} → working/guestbook-epochs/`)
}

// ——— the deck ————————————————————————————————————————————————————
const INK = '#0D1B2E', PANEL = '#16273E', PEACH = '#FF9E8A', PAPER = '#F2F0EA'
const STEEL = '#5E7699', TILE = '#F0EBE0', MIST = 'rgba(182,193,210,0.9)', MIST_DIM = 'rgba(182,193,210,0.5)'
const FR = 'Fraunces, Georgia, serif'
const IN = "'Instrument Sans', 'Helvetica Neue', sans-serif"

let uid = 0
const id = (p) => `${p}-${(++uid).toString(36)}`
const text = (o) => ({
  id: o.id ?? id('t'), type: 'text', x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: o.rotation ?? 0, opacity: o.opacity ?? 1, html: o.html,
  fontSize: o.fontSize ?? 24, fontFamily: o.fontFamily ?? IN,
  fontWeight: o.fontWeight ?? 400, color: o.color ?? '#fff',
  align: o.align ?? 'left', valign: o.valign ?? 'top', lineHeight: o.lineHeight ?? 1.3,
  ...(o.letterSpacing != null ? { letterSpacing: o.letterSpacing } : {}),
})
const rect = (o) => ({
  id: o.id ?? id('s'), type: 'shape', shape: o.shape ?? 'rect', x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: o.rotation ?? 0, opacity: o.opacity ?? 1, fill: o.fill ?? 'rgba(0,0,0,0)',
  stroke: o.stroke ?? 'none', strokeWidth: o.strokeWidth ?? 0, radius: o.radius ?? 0,
  ...(o.strokeStyle ? { strokeStyle: o.strokeStyle } : {}),
})

const kick = (x, y, s, color = PEACH) =>
  text({ x, y, w: 900, h: 24, html: s, fontSize: 13, fontWeight: 700, letterSpacing: 5, color })

const s1 = {
  id: 'gb-welcome', background: INK, transition: 'none',
  notes: 'The public guestbook: everyone holding this file is in the same live room, end-to-end encrypted. House rules on the slide. Epochs reset the room on a schedule — good walls are archived, vandalism simply evaporates.',
  elements: [
    rect({ id: 'gb-tile-a', x: 980, y: 110, w: 170, h: 170, fill: PEACH, radius: 30 }),
    rect({ id: 'gb-tile-b', x: 1080, y: 310, w: 100, h: 150, fill: STEEL, radius: 22 }),
    rect({ id: 'gb-tile-c', x: 930, y: 330, w: 100, h: 100, fill: TILE, radius: 20 }),
    kick(96, 90, `THE GUESTBOOK — EPOCH ${epoch} · A PUBLIC EXPERIMENT`),
    text({ x: 88, y: 140, w: 900, h: 220, html: 'Leave a mark.', fontSize: 110, fontFamily: FR, fontWeight: 900, color: '#fff', lineHeight: 1 }),
    text({ x: 96, y: 360, w: 780, h: 100, html: 'Everyone with this file open is <b>in this deck with you, live</b> — end-to-end encrypted, no accounts. Pick a wall (→), add a note, a shape, a doodle. Set your name via the <b>Live</b> button so your cursor has one.', fontSize: 19, color: MIST, lineHeight: 1.6 }),
    text({ x: 96, y: 500, w: 900, h: 120, fontSize: 16, color: MIST_DIM, lineHeight: 1.9, html:
      '<b>House rules:</b> add, don’t wipe · be kind · anything goes except cruelty<br>' +
      'The room resets on a schedule — beautiful walls get archived forever, everything else evaporates.' }),
    text({ x: 96, y: 655, w: 1000, h: 24, html: '→ THE WALLS ARE THAT WAY', fontSize: 12, fontWeight: 700, letterSpacing: 3, color: 'rgba(255,158,138,0.85)' }),
  ],
}

const seeds = [
  { html: 'the file is the room 🤯', color: PEACH, rot: -3 },
  { html: 'hello from epoch ' + epoch, color: TILE, rot: 2 },
  { html: 'no login. no cloud. just us.', color: STEEL, rot: -1 },
  { html: 'sign below ↓', color: PEACH, rot: 1 },
  { html: 'archive me, i’m beautiful', color: TILE, rot: -2 },
  { html: 'CRDTs are magic', color: STEEL, rot: 3 },
]
const walls = seeds.map((seed, i) => ({
  id: `gb-wall-${i + 1}`, background: i % 2 ? PANEL : INK, transition: 'fade',
  notes: `Wall ${i + 1} of ${seeds.length}. Everything here was left by someone holding this file. Add yours anywhere — double-click to write, or drop shapes from the toolbar.`,
  elements: [
    text({ x: 40, y: 40, w: 600, h: 200, html: String(i + 1).padStart(2, '0'), fontSize: 180, fontFamily: FR, fontWeight: 900, color: i % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.045)' }),
    kick(96, 84, `WALL ${String(i + 1).padStart(2, '0')} — SIGN ANYWHERE`, 'rgba(255,158,138,0.6)'),
    rect({ x: 60, y: 130, w: 1160, h: 540, stroke: 'rgba(182,193,210,0.18)', strokeWidth: 1.5, radius: 18, strokeStyle: 'dashed' }),
    text({ x: 140 + (i * 137) % 700, y: 190 + (i * 211) % 350, w: 420, h: 60, html: seed.html, fontSize: 30, fontFamily: i % 2 ? FR : IN, fontWeight: i % 2 ? 900 : 700, color: seed.color, rotation: seed.rot }),
  ],
}))

const s8 = {
  id: 'gb-how', background: PAPER, transition: 'fade',
  notes: 'How it works: the collab keys live inside this file — possession is membership. The relay only ever sees ciphertext. Epochs: fresh keys are minted on reset, which orphans the old room instantly; saved copies keep working offline, which is rather the point.',
  elements: [
    kick(96, 96, 'HOW THIS WORKS', '#C25A43'),
    text({ x: 90, y: 140, w: 1000, h: 110, html: 'The file is the room.', fontSize: 64, fontFamily: FR, fontWeight: 900, color: INK, lineHeight: 1 }),
    text({ x: 96, y: 280, w: 1040, h: 260, fontSize: 20, color: 'rgba(20,34,54,0.78)', lineHeight: 1.85, html:
      '· The encryption keys travel <b>inside this file</b> — opening it is joining it<br>' +
      '· Edits sync end-to-end encrypted; the relay stores ciphertext and learns nothing<br>' +
      '· Every reset mints fresh keys — the old room simply stops existing<br>' +
      '· Your saved copy keeps working forever, offline, like any Bento deck' }),
    text({ x: 96, y: 600, w: 1000, h: 30, html: 'THIS IS THE SAME COLLAB THAT SHIPS IN EVERY DECK — NOTHING SPECIAL WAS BUILT FOR THIS STUNT', fontSize: 12, fontWeight: 700, letterSpacing: 2.5, color: 'rgba(20,34,54,0.5)' }),
  ],
}

const s9 = {
  id: 'gb-close', background: INK, transition: 'morph',
  notes: 'The pitch, quietly. Save a copy of the guestbook as a souvenir of this epoch — or start a deck of your own.',
  elements: [
    rect({ id: 'gb-tile-a', x: 540, y: 110, w: 200, h: 200, fill: PEACH, radius: 36 }),
    rect({ id: 'gb-tile-b', x: 464, y: 230, w: 120, h: 180, fill: STEEL, radius: 26 }),
    rect({ id: 'gb-tile-c', x: 700, y: 250, w: 120, h: 120, fill: TILE, radius: 24 }),
    text({ x: 140, y: 380, w: 1000, h: 120, html: 'Make a deck of your own.', fontSize: 66, fontFamily: FR, fontWeight: 900, color: '#fff', align: 'center', lineHeight: 1 }),
    text({ x: 140, y: 520, w: 1000, h: 60, html: '<b>bento.page</b> — templates, the app, the whole story. One file each.', fontSize: 19, color: MIST, align: 'center', lineHeight: 1.6 }),
    text({ x: 140, y: 620, w: 1000, h: 24, html: 'SAVE A COPY OF THIS GUESTBOOK — IT’S YOUR SOUVENIR OF EPOCH ' + epoch, fontSize: 12, fontWeight: 700, letterSpacing: 2.5, color: 'rgba(255,158,138,0.8)', align: 'center' }),
  ],
}

const doc = {
  format: 'bento/slides', version: 1, title: `The Guestbook — epoch ${epoch}`,
  docId, collab, guestbookEpoch: epoch,
  size: { width: 1280, height: 720 },
  theme: { background: INK, color: '#fff', accent: PEACH, fontFamily: IN },
  assets: { 'font-fraunces': font('FRAUNCES_900'), 'font-instrument': font('INSTRUMENT_VAR') },
  fonts: [
    { family: 'Fraunces', asset: 'font-fraunces', weight: '900' },
    { family: 'Instrument Sans', asset: 'font-instrument', weight: '100 900' },
  ],
  slides: [s1, ...walls, s8, s9],
  modified: new Date().toISOString(),
}

const blockRe = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/
const json = JSON.stringify(doc).replace(/</g, '\\u003c')
const spliced = shell.replace(blockRe, `<script type="application/bento+json" id="bento-doc">\n${json}\n</scr` + 'ipt>')
if (!spliced.includes(json)) throw new Error('splice failed')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, spliced)
console.log(`guestbook epoch ${epoch} → ${out} (${Math.round(spliced.length / 1024)} KB)`)
console.log(`room: ${collab.room}`)
console.log('next: publish the site (release --no-build + rsync + push) so the new epoch replaces the old file')
