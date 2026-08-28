#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A scenario matrix for the code morph (C implementation: HeckelDiff + kernel tokenizer). DEMO BUILD.
//
//   node scripts/build-code-matrix.mjs
//
// One pair of slides per scenario, so each kind of edit can be watched on its
// own. Measured offline first (scratchpad/anchor/matrix.mjs): every scenario
// pairs its tokens cleanly EXCEPT a swap of two lines that share a prefix,
// where the duplicated leading token cannot be disambiguated and one line ends
// up assembled from two different origin lines. That is the one to watch.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shellPath = join(root, 'slides/dist-single/Bento_Slides.bento.html')
const out = join(root, 'slides/dist-single/Code_Matrix_Demo.bento.html')

const INK = '#0D1B2E', PAPER = '#F2F0EA', MIST = '#8FA0B4', PEACH = '#FF9E8A'
let uid = 0
const id = (p) => `${p}-${uid++}`

const text = (html, x, y, w, h, o = {}) => ({
  id: id('t'), type: 'text', x, y, w, h, rotation: 0, opacity: 1, html,
  fontSize: o.size ?? 24, fontFamily: 'Instrument Sans, Helvetica Neue, sans-serif',
  fontWeight: o.weight ?? 400, color: o.color ?? PAPER, align: 'left', valign: 'top', lineHeight: 1.35,
})
const code = (content, lang = 'ts') => ({
  id: id('c'), type: 'code', morphId: 'm', x: 96, y: 210, w: 1088, h: 400,
  rotation: 0, opacity: 1, content, grammarName: lang, color: '#DCE3EC',
  fontSize: 26, lineHeight: 1.55, align: 'left', valign: 'top',
  fontFamily: "ui-monospace, 'SFMono-Regular', 'Menlo', 'Consolas', monospace",
})
const slide = (elements, o = {}) => ({
  id: id('s'), name: o.name ?? '', background: INK,
  transition: o.transition ?? 'morph', notes: o.notes ?? '', elements,
})

// [label, what to expect, before, after]
const CASES = [
  ['1. Swap — distinct lines', 'clean: the two lines trade places',
   `function f() {\n  alpha(one)\n  beta(two)\n  done()\n}`,
   `function f() {\n  beta(two)\n  alpha(one)\n  done()\n}`],
  ['2. Swap — shared prefix', 'each const travels with its own line — nearest anchor wins',
   `function f() {\n  const a = one()\n  const b = two()\n  done()\n}`,
   `function f() {\n  const b = two()\n  const a = one()\n  done()\n}`],
  ['3. Move a line far', 'first() travels to the bottom, the rest shift up',
   `function f() {\n  first()\n  x()\n  y()\n  z()\n  last()\n}`,
   `function f() {\n  x()\n  y()\n  z()\n  last()\n  first()\n}`],
  ['4. Delete a middle line', 'two() goes, three() rises to meet one()',
   `function f() {\n  one()\n  two()\n  three()\n}`,
   `function f() {\n  one()\n  three()\n}`],
  ['5. Insert at the top', 'zero() arrives, everything below moves down',
   `function f() {\n  one()\n  two()\n}`,
   `function f() {\n  zero()\n  one()\n  two()\n}`],
  ['6. Rename', 'total becomes acc; nothing moves, two tokens change',
   `function f() {\n  const total = sum(xs)\n  return total\n}`,
   `function f() {\n  const acc = sum(xs)\n  return acc\n}`],
  ['7. Indent — wrap in a block', 'the body shifts right and down together',
   `function f() {\n  one()\n  two()\n}`,
   `function f() {\n  if (ok) {\n    one()\n    two()\n  }\n}`],
]

const slides = [slide([
  text('Seven ways to change code', 96, 250, 1088, 80, { size: 64, weight: 700 }),
  text('Each pair is one edit. Watch what travels, and what tears.', 96, 350, 900, 50, { size: 22, color: MIST }),
  text('Scenario 2 was the known-tear case — fixed by breadth-first pairing.', 96, 410, 950, 50, { size: 18, color: PEACH }),
], { transition: 'fade', name: 'title' })]

for (const [label, expect, A, B] of CASES) {
  const head = (s) => text(s, 96, 96, 1088, 50, { size: 30, weight: 700 })
  const sub = (s) => text(s, 96, 146, 1088, 40, { size: 18, color: MIST })
  slides.push(slide([head(label), sub('before — ' + expect), code(A)], { transition: 'fade', name: label + ' (before)' }))
  slides.push(slide([head(label), sub('after — ' + expect), code(B)], { name: label + ' (after)', notes: expect }))
}

const doc = {
  format: 'bento/slides', version: 1, docId: 'code-matrix-demo-0001',
  title: 'Seven ways to change code',
  size: { width: 1280, height: 720 },
  theme: { background: INK, color: PAPER, accent: PEACH, fontFamily: 'Instrument Sans, Helvetica Neue, sans-serif' },
  present: { controls: false, morphSeconds: 1.4 }, slides, modified: new Date().toISOString(),
}

const shell = readFileSync(shellPath, 'utf8')
const open = '<script type="application/bento+json" id="bento-doc">'
const i = shell.indexOf(open)
const j = shell.indexOf('</scr' + 'ipt>', i)
writeFileSync(out, shell.slice(0, i + open.length) + JSON.stringify(doc).replace(/</g, '\\u003c') + shell.slice(j))
console.log(`wrote ${out}`)
console.log(`  ${slides.length} slides — ${CASES.length} scenarios`)
