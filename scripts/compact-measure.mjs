#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// How much of a deck's JSON is boilerplate an author never chose (#422).
//
//   node scripts/compact-measure.mjs [deck.bento.html …]
//
// With no arguments: the starter deck (slides/src/starterdeck.ts) and the two
// biggest gallery decks built by build-example-decks.mjs into working/ (or
// pass paths). For each: full bytes, compact bytes (slides/src/compact.ts
// compactDoc, the same function "Copy compact JSON" uses), tokens at chars/4,
// and which fields the stripping removed most bytes from. Assets and fonts
// are counted separately: they are payload, not boilerplate, and dominate a
// deck with photos — the interesting number is the DOCUMENT without them.
//
// Exported for the rig: measureDoc(doc) → { full, compact, ... }.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { compactDoc } = await import(join(root, 'slides/src/compact.ts'))
const { starterDoc } = await import(join(root, 'slides/src/starterdeck.ts'))

/** The document minus binary payload: assets and fonts, which no compaction touches. */
export function withoutPayload(doc) {
  const { assets, fonts, ...rest } = doc
  // an inline data: URI on an element (a video pasted straight in) is payload too
  return JSON.parse(JSON.stringify(rest, (k, v) => (typeof v === 'string' && v.startsWith('data:') && v.length > 256 ? `data:…(${v.length} B)` : v)))
}

export function measureDoc(doc) {
  const full = withoutPayload(doc)
  const compact = withoutPayload(compactDoc(doc))
  const fullJson = JSON.stringify(full)
  const compactJson = JSON.stringify(compact)
  // per-field bytes removed: walk elements of both and diff key sets
  const removed = {}
  const els = (d) => d.slides.flatMap((s) => s.elements ?? [])
  const fe = els(full), ce = els(compact)
  fe.forEach((el, i) => {
    const c = ce[i] ?? {}
    for (const k of Object.keys(el)) if (!(k in c)) removed[k] = (removed[k] ?? 0) + JSON.stringify({ [k]: el[k] }).length
  })
  full.slides.forEach((s, i) => {
    const c = compact.slides[i] ?? {}
    for (const k of Object.keys(s)) if (k !== 'elements' && !(k in c)) removed[`slide.${k}`] = (removed[`slide.${k}`] ?? 0) + JSON.stringify({ [k]: s[k] }).length
  })
  const top = Object.entries(removed).sort((a, b) => b[1] - a[1])
  return {
    elements: fe.length, slides: full.slides.length,
    fullBytes: fullJson.length, compactBytes: compactJson.length,
    fullTokens: Math.round(fullJson.length / 4), compactTokens: Math.round(compactJson.length / 4),
    payloadBytes: JSON.stringify(doc).length - fullJson.length,
    top,
  }
}

const readDeck = (file) => {
  const html = readFileSync(file, 'utf8')
  const m = /<script type="application\/bento\+json" id="bento-doc">\s*([\s\S]*?)\s*<\/script>/.exec(html)
  if (!m) throw new Error(`no #bento-doc in ${file}`)
  return JSON.parse(m[1])
}

export function defaultDecks() {
  const decks = [['starter deck', starterDoc()]]
  const dir = process.env.DECKS_DIR ?? join(root, 'working') // build-example-decks.mjs's default output
  if (existsSync(dir)) {
    const files = readdirSync(dir).filter((f) => f.endsWith('.bento.html')).map((f) => [f, readDeck(join(dir, f))])
    files.sort((a, b) => b[1].slides.flatMap((s) => s.elements).length - a[1].slides.flatMap((s) => s.elements).length)
    for (const [f, d] of files.slice(0, 2)) decks.push([f.replace('.bento.html', ''), d])
  }
  return decks
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const decks = process.argv.length > 2 ? process.argv.slice(2).map((f) => [basename(f), readDeck(f)]) : defaultDecks()
  let tf = 0, tc = 0
  console.log('| deck | slides | elements | full bytes | compact bytes | saved | full tokens | compact tokens | payload (assets+fonts) |')
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  const tops = {}
  for (const [name, doc] of decks) {
    const m = measureDoc(doc)
    tf += m.fullBytes; tc += m.compactBytes
    console.log(`| ${name} | ${m.slides} | ${m.elements} | ${m.fullBytes.toLocaleString()} | ${m.compactBytes.toLocaleString()} | ${(100 - m.compactBytes / m.fullBytes * 100).toFixed(1)}% | ${m.fullTokens.toLocaleString()} | ${m.compactTokens.toLocaleString()} | ${m.payloadBytes.toLocaleString()} |`)
    for (const [k, v] of m.top) tops[k] = (tops[k] ?? 0) + v
  }
  console.log(`| **total** | | | ${tf.toLocaleString()} | ${tc.toLocaleString()} | ${(100 - tc / tf * 100).toFixed(1)}% | ${Math.round(tf / 4).toLocaleString()} | ${Math.round(tc / 4).toLocaleString()} | |`)
  console.log('\nbytes removed, by field (all decks):\n')
  console.log('| field | bytes |'); console.log('| --- | ---: |')
  for (const [k, v] of Object.entries(tops).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`| \`${k}\` | ${v.toLocaleString()} |`)
}
