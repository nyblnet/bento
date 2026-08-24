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

// TWO techniques, so they can be compared in one deck.
//
// A. FILL-IN (slides 2-5). The skeleton — signature, comments, closing brace —
//    is identical on every slide, so nothing has to move and the new lines
//    simply fade in where a comment already reserved the space. This is the
//    technique in the PR's own demo video, and it is the calmer of the two.
// B. TRAVEL (slides 7-8). A reorder, where the same tokens genuinely change
//    place. Nothing fades; the code rearranges itself.

const SKEL = (a = '', b = '', c = '') => `export async function netFetch(input) {
  // refuse when the switch is on
${a}
  // register what is in flight
${b}
  // and always clean up
${c}
}`

const F1 = SKEL()
const F2 = SKEL('  if (offlineEnabled()) throw new OfflineError(input)')
const F3 = SKEL('  if (offlineEnabled()) throw new OfflineError(input)',
                '  const ac = new AbortController()\n  inFlight.add(ac)')
const F4 = SKEL('  if (offlineEnabled()) throw new OfflineError(input)',
                '  const ac = new AbortController()\n  inFlight.add(ac)',
                '  try { return await fetch(input, { signal: ac.signal }) }\n  finally { inFlight.delete(ac) }')

// B: the same four statements, two of them swapped.
const T1 = `function publish(deck) {
  const html = render(deck)
  const signed = sign(html)
  upload(signed)
}`
const T2 = `function publish(deck) {
  const signed = sign(html)
  const html = render(deck)
  upload(signed)
}`

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
      text('Code that writes itself', 96, 240, 1088, 90, { size: 72, weight: 700 }),
      text('Two techniques, one tokenizer. Press → to walk through.', 96, 340, 900, 50, { size: 24, color: MIST }),
      text('77 languages · 6.7 KB · no highlighter dependency', 96, 410, 900, 40, { size: 18, color: '#FF9E8A' }),
    ], { transition: 'fade', name: 'Title', notes: 'Slides 2-5 fill in. Slides 7-8 rearrange. Watch which one you prefer.' }),

    slide([heading('A. Fill in the blanks'), sub('the comments hold the shape — nothing below them will move'), code(F1)],
      { transition: 'fade', name: 'skeleton', notes: 'The skeleton is identical on the next three slides. Only the gaps fill.' }),
    slide([heading('A. Fill in the blanks'), sub('the guard arrives where the comment reserved room'), code(F2)],
      { name: 'fill-1', notes: 'The new line fades in. Everything else is exactly where it was.' }),
    slide([heading('A. Fill in the blanks'), sub('two more, under the second comment'), code(F3)],
      { name: 'fill-2' }),
    slide([heading('A. Fill in the blanks'), sub('and the cleanup, under the third'), code(F4)],
      { name: 'fill-3', notes: 'Nothing has travelled in this whole sequence. That is the point.' }),

    slide([heading('B. Or let it rearrange'), sub('same four statements — now two of them swap places'), code(T1)],
      { transition: 'fade', name: 'travel-a', notes: 'Now the opposite: no new code at all, only movement.' }),
    slide([heading('B. Or let it rearrange'), sub('sign moves up, render moves down'), code(T2)],
      { name: 'travel-b', notes: 'Every token here is old. They trade places rather than redraw.' }),

    slide([heading('Diff reads as a diff'), sub('a line format, eleven lines of its own handling'), code(DIFF, 'diff')],
      { transition: 'fade', name: 'diff' }),
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
