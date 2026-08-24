#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Builds a demo deck for the code-token morph. DEMO BUILD, not for release.
//
//   node scripts/build-code-demo.mjs
//
// Splices a hand-written document into the freshly built shell through the
// documented contract: #bento-doc stays plaintext JSON with every `<` escaped
// as <, so the block can never contain a script close.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shellPath = join(root, 'slides/dist-single/Bento_Slides.bento.html')
const out = join(root, 'slides/dist-single/Code_Morph_Demo.bento.html')

const INK = '#0D1B2E', PAPER = '#F2F0EA', MIST = '#8FA0B4'

let uid = 0
const id = (p) => `${p}-${uid++}`

const text = (html, x, y, w, h, o = {}) => ({
  id: id('t'), type: 'text', x, y, w, h, rotation: 0, opacity: 1,
  html, fontSize: o.size ?? 26, fontFamily: 'Instrument Sans, Helvetica Neue, sans-serif',
  fontWeight: o.weight ?? 400, color: o.color ?? PAPER,
  align: o.align ?? 'left', valign: 'top', lineHeight: 1.35, ...o.extra,
})

/** Every code frame shares ONE morphId, which is what makes them a group. */
const code = (content, lang = 'ts') => ({
  id: id('c'), type: 'code', morphId: 'walkthrough',
  x: 96, y: 190, w: 1088, h: 420, rotation: 0, opacity: 1,
  content, lang, color: '#DCE3EC', fontSize: 25, lineHeight: 1.5,
})

const slide = (elements, o = {}) => ({
  id: id('s'), name: o.name ?? '', background: o.bg ?? INK,
  transition: o.transition ?? 'morph', notes: o.notes ?? '', elements,
})

const heading = (s) => text(s, 96, 96, 1088, 60, { size: 34, weight: 700 })
const sub = (s) => text(s, 96, 140, 1088, 40, { size: 19, color: MIST })

// Edits chosen to MOVE code rather than add it: a reorder, an indent shift, a
// rename. Growing the snippet is the case where a morph has least to show —
// most tokens are new, and new tokens have nowhere to travel from.
const V1 = `function publish(deck) {
  const html = render(deck)
  const signed = sign(html)
  upload(signed)
}`
// reorder: sign before render — the two lines trade places
const V2 = `function publish(deck) {
  const signed = sign(html)
  const html = render(deck)
  upload(signed)
}`
// rename: html -> page, used three times
const V3 = `function publish(deck) {
  const signed = sign(page)
  const page = render(deck)
  upload(signed)
}`
// indent: the whole body shifts right and down inside a guard
const V4 = `function publish(deck) {
  if (deck.ready) {
    const signed = sign(page)
    const page = render(deck)
    upload(signed)
  }
}`

const PY = `def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)`
const PY2 = `def fib(n):
    if n < 2:
        return n
    return fib(n - 2) + fib(n - 1)`

const DIFF = `--- a/kernel/src/net.ts
+++ b/kernel/src/net.ts
@@ -118,7 +118,9 @@
 export async function netFetch(input) {
-  return fetch(input)
+  if (offlineEnabled()) throw new OfflineError(input)
+  const ac = new AbortController()
+  return fetch(input, { signal: ac.signal })
 }`

const doc = {
  format: 'bento/slides',
  version: 1,
  docId: 'code-morph-demo-0001',
  title: 'Code that moves',
  size: { width: 1280, height: 720 },
  theme: { background: INK, color: PAPER, accent: '#FF9E8A', fontFamily: 'Instrument Sans, Helvetica Neue, sans-serif' },
  present: { controls: false },
  slides: [
    slide([
      text('Code that moves', 96, 250, 1088, 90, { size: 76, weight: 700 }),
      text('Tokens keep their identity across slides, so the code rearranges itself instead of cross-fading.',
        96, 350, 900, 80, { size: 24, color: MIST }),
      text('77 languages · 6.7 KB · no highlighter dependency', 96, 440, 900, 40, { size: 18, color: '#FF9E8A' }),
    ], { transition: 'fade', name: 'Title', notes: 'Press → to walk the code. Each step inserts lines; the tokens that survive glide into place.' }),

    slide([heading('Four statements'), sub('watch these, not the words — every step below only REARRANGES them'), code(V1)],
      { name: 'v1', notes: 'Nothing is added from here on. Every change moves code that is already on screen.' }),

    slide([heading('Swap two lines'), sub('sign moves up, render moves down — they trade places'), code(V2)],
      { name: 'v2', notes: 'A pure reorder: no token is new, so every one of them travels.' }),

    slide([heading('Rename a variable'), sub('html becomes page, in both places at once'), code(V3)],
      { name: 'v3', notes: 'Everything around the rename holds still, which is what makes the rename readable.' }),

    slide([heading('Wrap it in a guard'), sub('the whole body indents — every line moves right and down together'), code(V4)],
      { name: 'v4', notes: 'The biggest movement in the deck: three lines shift on both axes at once.' }),

    slide([heading('Another language, same machine'), sub('python — same machine, different keyword table'), code(PY, 'py')],
      { transition: 'fade', name: 'py1', notes: 'The tokenizer is shared; only the table changes.' }),

    slide([heading('Another language, same machine'), sub('the two recursive calls swap places'), code(PY2, 'py')],
      { name: 'py2' }),

    slide([heading('And a patch reads as a patch'), sub('diff is a line format, so it gets its own eleven lines of handling'), code(DIFF, 'diff')],
      { transition: 'fade', name: 'diff', notes: 'Added and removed lines are their own token classes.' }),
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
console.log(`  ${doc.slides.length} slides, ${(json.length / 1024).toFixed(1)} KB of document`)
