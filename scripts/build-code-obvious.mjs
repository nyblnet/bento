#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A deliberately UNMISSABLE code-morph demo. DEMO BUILD, not for release.
//
// The matrix deck was correct and unconvincing: a one-line swap travels about
// 40px, and at the default 0.65s morph with a power2.inOut ease that reads as
// a blink. This deck is the opposite extreme — long journeys, a slow beat, a
// big typeface — so the only question it asks is "does the text travel", not
// "can you catch it".

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shellPath = join(root, 'slides/dist-single/Bento_Slides.bento.html')
const out = join(root, 'slides/dist-single/Code_Obvious_Demo.bento.html')

const STAMP = process.env.STAMP || new Date().toISOString().slice(11, 16)
const INK = '#0D1B2E', PAPER = '#F2F0EA', MIST = '#8FA0B4', ACCENT = '#FF9E8A'

let uid = 0
const id = (p) => `${p}-${uid++}`

const text = (html, x, y, w, h, o = {}) => ({
  id: id('t'), type: 'text', x, y, w, h, rotation: 0, opacity: 1,
  html, fontSize: o.size ?? 26, fontFamily: 'Instrument Sans, Helvetica Neue, sans-serif',
  fontWeight: o.weight ?? 400, color: o.color ?? PAPER,
  align: o.align ?? 'left', valign: 'top', lineHeight: 1.35,
})

const code = (content, o = {}) => ({
  id: id('c'), type: 'code', morphId: o.group ?? 'walkthrough',
  x: 96, y: 200, w: 1088, h: 460, rotation: 0, opacity: 1,
  content, grammarName: o.lang ?? 'ts', color: '#DCE3EC',
  fontSize: o.size ?? 34, lineHeight: 1.55, align: 'left', valign: 'top',
  fontFamily: "ui-monospace, 'SFMono-Regular', 'Menlo', 'Consolas', monospace",
})

const slide = (elements, o = {}) => ({
  id: id('s'), name: o.name ?? '', background: o.bg ?? INK,
  transition: o.transition ?? 'morph', notes: o.notes ?? '', elements,
})
const heading = (s) => text(s, 96, 90, 1088, 60, { size: 36, weight: 700 })
const sub = (s) => text(s, 96, 138, 1088, 40, { size: 20, color: MIST })

// ONE line travels the full height of the block, twice over. Nothing is added
// or removed, so every token on screen is a token that must move.
const LONG_A = `function pipeline() {
  FIRST()
  b()
  c()
  d()
  e()
  f()
  g()
}`
const LONG_B = `function pipeline() {
  b()
  c()
  d()
  e()
  f()
  g()
  FIRST()
}`

// A whole block slides down to make room — big, simultaneous travel.
const ROOM_A = `function boot() {
  mount()
  paint()
}`
const ROOM_B = `function boot() {
  checkLicence()
  loadFonts()
  warmCaches()
  mount()
  paint()
}`

const doc = {
  format: 'bento/slides', version: 1,
  docId: 'code-obvious-demo-0001',
  title: `Does the code travel? (build ${STAMP})`,
  size: { width: 1280, height: 720 },
  theme: { background: INK, color: PAPER, accent: ACCENT, fontFamily: 'Instrument Sans, Helvetica Neue, sans-serif' },
  // THE POINT OF THIS BUILD: a slow, readable morph.
  present: { controls: false, morphSeconds: 2.2 },
  slides: [
    slide([
      text('Does the code travel?', 96, 250, 1088, 90, { size: 68, weight: 700 }),
      text('Two moves, both deliberately huge, at a 2.2s morph.', 96, 350, 1000, 50, { size: 24, color: MIST }),
      text(`build ${STAMP} — press → four times`, 96, 415, 1000, 40, { size: 19, color: ACCENT }),
    ], { transition: 'fade', name: 'Title' }),

    slide([heading('1. One line, the whole way down'),
      sub('FIRST() is at the top — watch it, and only it, travel'), code(LONG_A)],
      { name: 'long-before' }),
    slide([heading('1. One line, the whole way down'),
      sub('everything else shuffles up one row to let it past'), code(LONG_B)],
      { name: 'long-after', notes: 'FIRST() travels ~6 line-heights. Nothing fades.' }),

    slide([heading('2. Making room'),
      sub('two lines here — three more are about to arrive above them'), code(ROOM_A, { group: 'room' })],
      { name: 'room-before' }),
    slide([heading('2. Making room'),
      sub('mount() and paint() slide down; the new work fades in behind them'), code(ROOM_B, { group: 'room' })],
      { name: 'room-after', notes: 'Travel and fade in one beat.' }),
  ],
  modified: new Date().toISOString(),
}

const shell = readFileSync(shellPath, 'utf8')
const open = '<script type="application/bento+json" id="bento-doc">'
const i = shell.indexOf(open)
if (i < 0) throw new Error('no #bento-doc block in the shell')
const j = shell.indexOf('</scr' + 'ipt>', i)
const json = JSON.stringify(doc).replace(/</g, '\\u003c')
writeFileSync(out, shell.slice(0, i + open.length) + json + shell.slice(j))
console.log(`wrote ${out}`)
console.log(`  build stamp ${STAMP}, morphSeconds ${doc.present.morphSeconds}`)
