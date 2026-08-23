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

// The story is this repo's own offline fix, built up a step at a time.
const V1 = `export async function netFetch(input) {
  return fetch(input)
}`
const V2 = `export async function netFetch(input) {
  if (offlineEnabled()) throw new OfflineError(input)
  return fetch(input)
}`
const V3 = `export async function netFetch(input) {
  if (offlineEnabled()) throw new OfflineError(input)
  const ac = new AbortController()
  inFlight.add(ac)
  return fetch(input, { signal: ac.signal })
}`
const V4 = `export async function netFetch(input) {
  if (offlineEnabled()) throw new OfflineError(input)
  const ac = new AbortController()
  inFlight.add(ac)
  try {
    return await fetch(input, { signal: ac.signal })
  } finally {
    inFlight.delete(ac)
  }
}`

const PY = `def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)`
const PY2 = `def fib(n, memo={}):
    if n in memo:
        return memo[n]
    if n < 2:
        return n
    memo[n] = fib(n - 1) + fib(n - 2)
    return memo[n]`

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

    slide([heading('Start with the naive version'), sub('slides/src/... netFetch, before the offline switch'), code(V1)],
      { name: 'v1', notes: 'Two lines. Watch what stays put as the next steps land.' }),

    slide([heading('Refuse when offline'), sub('a guard goes in at the top — everything below shifts down'), code(V2)],
      { name: 'v2', notes: 'The signature and the fetch call keep their token ids, so they slide down rather than redraw.' }),

    slide([heading('Register what is in flight'), sub('two more lines, and fetch grows an argument'), code(V3)],
      { name: 'v3', notes: 'Note the fetch line: it gains `{ signal: ac.signal }` while the identifier itself stays the same token.' }),

    slide([heading('Always clean up'), sub('wrap it, so the registry cannot leak'), code(V4)],
      { name: 'v4', notes: 'try/finally wraps the body — the return line moves right AND down, and is seen to move.' }),

    slide([heading('Another language, same machine'), sub('python — one tokenizer, a keyword table per language'), code(PY, 'py')],
      { transition: 'fade', name: 'py1', notes: 'The tokenizer is shared; only the table changes.' }),

    slide([heading('Another language, same machine'), sub('memoised — the body grows around what was already there'), code(PY2, 'py')],
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
