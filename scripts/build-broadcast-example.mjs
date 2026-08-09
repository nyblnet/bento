#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Build the live-broadcast example fixtures:
//   1. Owner deck  (broadcast-demo.bento.html) — real v2 collab room, owner creds in-file.
//   2. Broadcast copy (broadcast-demo-live.bento.html) — read-only follow mode.
//
//   node scripts/build-broadcast-example.mjs [--relay wss://host]
//
// Output: working/broadcast-demo/

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webcrypto as crypto } from 'node:crypto'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shell = readFileSync(join(root, 'slides/dist-single/Bento_Slides.bento.html'), 'utf8')

const DEFAULT_RELAY = 'wss://sync.bento.page'
const relay = parseRelay(process.argv.slice(2))

// ═══════════════════════════════════════════════════════════════════════
// base64url (byte-identical to slides/src/sync/online.ts)
// ═══════════════════════════════════════════════════════════════════════
const b64u = {
  enc(bytes) {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
  dec(s) {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    const out = new Uint8Array(b.length)
    for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
    return out
  },
}

function parseRelay(args) {
  const i = args.indexOf('--relay')
  if (i !== -1 && args[i + 1]) return args[i + 1].replace(/\/+$/, '')
  return DEFAULT_RELAY
}

function uuid() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}

async function mintCollab() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pub = b64u.enc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))
  const priv = b64u.enc(new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey)))
  const commit = new Uint8Array(await crypto.subtle.digest('SHA-256', b64u.dec(pub)))
  const roomName = 'w' + b64u.enc(commit)
  const room = `${relay}/d/${roomName}`
  const keyBytes = new Uint8Array(32)
  crypto.getRandomValues(keyBytes)
  const key = b64u.enc(keyBytes)
  const tokDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', keyBytes))
  const tok = b64u.enc(tokDigest.slice(0, 18))
  return { room, roomName, key, tok, owner: pub, ownerPriv: priv }
}

// ═══════════════════════════════════════════════════════════════════════
// tiny SVG asset (geometric bento mark), embedded as a data URI
// ═══════════════════════════════════════════════════════════════════════
const svgMarkup =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240" width="320" height="240">` +
  `<rect width="320" height="240" rx="16" fill="#F2F0EA"/>` +
  `<rect x="24" y="24" width="128" height="96" rx="8" fill="#FF9E8A"/>` +
  `<rect x="168" y="24" width="128" height="96" rx="8" fill="#5E7699"/>` +
  `<rect x="24" y="132" width="272" height="84" rx="8" fill="#16273E"/>` +
  `</svg>`
const bentoImage = 'data:image/svg+xml;base64,' + btoa(svgMarkup)

// ═══════════════════════════════════════════════════════════════════════
// deck builders
// ═══════════════════════════════════════════════════════════════════════
const INK = '#0D1B2E'
const PAPER = '#F2F0EA'
const PEACH = '#FF9E8A'
const STEEL = '#5E7699'
const BODY = "'Instrument Sans', system-ui, sans-serif"
const DISPLAY = "'Fraunces', Georgia, serif"

let uid = 0
const id = (p) => `${p}-${(++uid).toString(36)}`

const text = (o) => ({
  id: o.id ?? id('t'),
  type: 'text',
  x: o.x,
  y: o.y,
  w: o.w,
  h: o.h,
  rotation: o.rotation ?? 0,
  opacity: o.opacity ?? 1,
  html: o.html,
  fontSize: o.fontSize ?? 24,
  fontFamily: o.fontFamily ?? BODY,
  fontWeight: o.fontWeight ?? 400,
  color: o.color ?? INK,
  align: o.align ?? 'left',
  valign: o.valign ?? 'top',
  lineHeight: o.lineHeight ?? 1.3,
  ...(o.fx ? { fx: o.fx } : {}),
})

const shape = (kind, o) => ({
  id: o.id ?? id('s'),
  type: 'shape',
  shape: kind,
  x: o.x,
  y: o.y,
  w: o.w,
  h: o.h,
  rotation: o.rotation ?? 0,
  opacity: o.opacity ?? 1,
  fill: o.fill ?? '#000',
  stroke: o.stroke ?? 'none',
  strokeWidth: o.strokeWidth ?? 0,
  radius: o.radius ?? 0,
  ...(o.fx ? { fx: o.fx } : {}),
})

const chart = (o) => ({
  id: o.id ?? id('c'),
  type: 'chart',
  x: o.x,
  y: o.y,
  w: o.w,
  h: o.h,
  rotation: 0,
  opacity: 1,
  preset: o.preset ?? 'bar',
  option: o.option,
  ...(o.fx ? { fx: o.fx } : {}),
})

const slide = (o) => ({
  id: o.id ?? id('sl'),
  background: o.background,
  transition: o.transition ?? 'fade',
  notes: o.notes ?? '',
  elements: o.elements,
})

function buildDoc(docId, collab) {
  const sTitle = slide({
    id: 'bc-title',
    background: INK,
    transition: 'none',
    notes: 'Broadcast demo cover. A simple title slide on the ink background.',
    elements: [
      text({
        x: 96, y: 240, w: 1088, h: 120,
        html: 'Bento Broadcast Demo',
        fontSize: 84, fontWeight: 900, fontFamily: DISPLAY, color: PAPER, lineHeight: 1.05,
      }),
      text({
        x: 96, y: 380, w: 900, h: 40,
        html: 'A tiny deck that follows the presenter live.',
        fontSize: 24, color: 'rgba(242,240,234,0.75)',
      }),
      shape('rect', { x: 96, y: 430, w: 160, h: 6, fill: PEACH }),
    ],
  })

  const sBullets = slide({
    id: 'bc-bullets',
    background: PAPER,
    transition: 'fade',
    notes: 'Bullet slide showing the broadcast value proposition.',
    elements: [
      text({ x: 96, y: 84, w: 900, h: 60, html: 'What broadcast does', fontSize: 52, fontWeight: 900, fontFamily: DISPLAY, color: INK }),
      shape('rect', { x: 96, y: 150, w: 1088, h: 2, fill: 'rgba(13,27,46,0.15)' }),
      ...[
        ['No accounts', 'Viewers open a file, not a login page.'],
        ['Same renderer', 'The copy runs the real Bento presenter — morphs included.'],
        ['Number-only nav', 'The relay sees only a slide index, never content.'],
      ].flatMap(([head, body], i) => [
        shape('ellipse', { x: 116, y: 210 + i * 130, w: 20, h: 20, fill: PEACH }),
        text({ x: 156, y: 196 + i * 130, w: 800, h: 44, html: `<b>${head}</b>`, fontSize: 28, fontWeight: 800, color: INK }),
        text({ x: 156, y: 244 + i * 130, w: 800, h: 36, html: body, fontSize: 20, color: 'rgba(13,27,46,0.72)' }),
      ]),
    ],
  })

  const sImage = slide({
    id: 'bc-image',
    background: PAPER,
    transition: 'fade',
    notes: 'Image slide: a small inline SVG data URI used as a self-contained asset.',
    elements: [
      text({ x: 96, y: 84, w: 900, h: 60, html: 'Self-contained assets', fontSize: 52, fontWeight: 900, fontFamily: DISPLAY, color: INK }),
      shape('rect', { x: 96, y: 150, w: 1088, h: 2, fill: 'rgba(13,27,46,0.15)' }),
      text({ x: 96, y: 200, w: 560, h: 200, html: 'This image is embedded as a data URI in the doc JSON — no external host, no broken link when the copy travels.', fontSize: 22, color: 'rgba(13,27,46,0.72)', lineHeight: 1.5 }),
      { id: id('im'), type: 'image', x: 720, y: 180, w: 480, h: 360, rotation: 0, opacity: 1, src: bentoImage, fit: 'contain', radius: 16 },
    ],
  })

  const sMorphA = slide({
    id: 'bc-morph-a',
    background: PAPER,
    transition: 'fade',
    notes: 'Morph beat part 1: the amber block and title are about to rearrange.',
    elements: [
      text({ id: 'bc-m-title', x: 96, y: 84, w: 900, h: 60, html: 'Morph transition', fontSize: 52, fontWeight: 900, fontFamily: DISPLAY, color: INK }),
      shape('rect', { id: 'bc-m-bar', x: 96, y: 160, w: 320, h: 24, fill: PEACH }),
      text({ x: 96, y: 230, w: 600, h: 160, html: 'The next slide shares these element ids.<br>Bento tweens position, size and color automatically.', fontSize: 24, color: 'rgba(13,27,46,0.72)', lineHeight: 1.5 }),
      shape('rect', { id: 'bc-m-box', x: 96, y: 430, w: 200, h: 200, fill: STEEL, radius: 12 }),
    ],
  })

  const sMorphB = slide({
    id: 'bc-morph-b',
    background: INK,
    transition: 'morph',
    notes: 'Morph beat part 2: same ids, new frames. The amber bar becomes a column, the box slides right and changes colour.',
    elements: [
      text({ id: 'bc-m-title', x: 96, y: 60, w: 500, h: 44, html: 'Morph transition', fontSize: 32, fontWeight: 900, fontFamily: DISPLAY, color: 'rgba(242,240,234,0.7)' }),
      shape('rect', { id: 'bc-m-bar', x: 96, y: 120, w: 16, h: 520, fill: PEACH }),
      text({ x: 150, y: 120, w: 500, h: 160, html: 'Same ids.<br>New frames.<br>Instant motion.', fontSize: 48, fontWeight: 800, color: PAPER, lineHeight: 1.2 }),
      shape('rect', { id: 'bc-m-box', x: 780, y: 260, w: 360, h: 360, fill: PEACH, radius: 180 }),
    ],
  })

  const sChart = slide({
    id: 'bc-chart',
    background: PAPER,
    transition: 'fade',
    notes: 'Chart slide: a simple bar chart using the ECharts-shaped option JSON that charts-lite understands.',
    elements: [
      text({ x: 96, y: 84, w: 900, h: 60, html: 'Charts work too', fontSize: 52, fontWeight: 900, fontFamily: DISPLAY, color: INK }),
      shape('rect', { x: 96, y: 150, w: 1088, h: 2, fill: 'rgba(13,27,46,0.15)' }),
      chart({
        x: 96, y: 200, w: 1088, h: 420,
        preset: 'bar',
        option: {
          grid: { left: 48, right: 16, top: 24, bottom: 48 },
          xAxis: { type: 'category', data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
          yAxis: { type: 'value' },
          color: [PEACH, STEEL],
          tooltip: { trigger: 'axis' },
          legend: { bottom: 0, textStyle: { color: '#6B7280' } },
          series: [
            { type: 'bar', name: 'Views', data: [42, 68, 54, 86, 73], itemStyle: { borderRadius: [6, 6, 0, 0] } },
            { type: 'bar', name: 'Edits', data: [28, 35, 42, 51, 64], itemStyle: { borderRadius: [6, 6, 0, 0] } },
          ],
        },
        fx: { enter: 'fade-up' },
      }),
    ],
  })

  return {
    format: 'bento/slides',
    version: 1,
    docId,
    title: 'Bento Broadcast Demo',
    size: { width: 1280, height: 720 },
    theme: { background: PAPER, color: INK, accent: PEACH, fontFamily: BODY },
    modified: new Date().toISOString(),
    slides: [sTitle, sBullets, sImage, sMorphA, sMorphB, sChart],
    collab,
  }
}

function spliceDoc(shell, doc) {
  const json = JSON.stringify(doc).replace(/</g, '\\u003c')
  const blockRe = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/
  const out = shell.replace(blockRe, `<script type="application/bento+json" id="bento-doc">\n${json}\n</scr` + 'ipt>')
  if (!out.includes(json)) throw new Error('splice failed — #bento-doc block not found or replacement missed')
  return out
}

// ═══════════════════════════════════════════════════════════════════════
// build + write
// ═══════════════════════════════════════════════════════════════════════
const creds = await mintCollab()
const ownerDocId = uuid()
const copyDocId = uuid()
const hostedDocId = uuid()

const ownerCollab = {
  room: creds.room,
  key: creds.key,
  on: true,
  v: 2,
  owner: creds.owner,
  ownerPriv: creds.ownerPriv,
  role: 'writer',
}

const broadcastCopyCollab = {
  on: false,
  broadcast: {
    room: creds.roomName,
    tok: creds.tok,
    relay,
  },
}

const hostedCopyCollab = {
  ...ownerCollab,
  role: 'reader',
  on: true,
  sync: undefined,
  broadcast: {
    room: creds.roomName,
    tok: creds.tok,
    relay,
  },
}
delete hostedCopyCollab.writerPriv
delete hostedCopyCollab.ownerPriv
delete hostedCopyCollab.invite

const ownerDoc = buildDoc(ownerDocId, ownerCollab)
const copyDoc = buildDoc(copyDocId, broadcastCopyCollab)
const hostedDoc = buildDoc(hostedDocId, hostedCopyCollab)

const outDir = join(root, 'working/broadcast-demo')
mkdirSync(outDir, { recursive: true })

const ownerOut = spliceDoc(shell, ownerDoc)
const copyOut = spliceDoc(shell, copyDoc)
const hostedOut = spliceDoc(shell, hostedDoc)

writeFileSync(join(outDir, 'owner.bento.html'), ownerOut)
writeFileSync(join(outDir, 'copy.bento.html'), copyOut)
writeFileSync(join(outDir, 'hosted.bento.html'), hostedOut)

console.log(`owner.bento.html   — ${Math.round(ownerOut.length / 1024)} KB`)
console.log(`copy.bento.html    — ${Math.round(copyOut.length / 1024)} KB`)
console.log(`hosted.bento.html  — ${Math.round(hostedOut.length / 1024)} KB`)
console.log(`relay: ${relay}`)
console.log(`room:  ${creds.roomName}`)
