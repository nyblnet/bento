#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Spike: what LaTeX do our own decks actually use? Extracts every $…$ and
// $$…$$ formula from the sources below into a JSON corpus and prints the
// distinct-command table that decides maths-lite's supported set.
//
//   node scripts/spike-maths-corpus.mjs [out.json]
//
// Sources: the starter deck source, the four gallery decks + announcement +
// 404 (built .bento.html under working/), the guestbook archive samples, and
// every rig/source fixture under scripts/ and slides/src that carries TeX.

import { readFileSync, readdirSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = process.argv[2] ?? join(process.env.CLAUDE_JOB_DIR ?? '/tmp', 'tmp', 'maths-corpus.json')

// the same delimiter rules render.ts resolveMath uses
const DISPLAY = /(^|[^\\])\$\$([^$]+?)\$\$/g
const INLINE = /(^|[^\\$])\$(\S(?:[^$\n]*?\S)?)\$(?!\d)/g

const corpus = [] // { src, display, source }
const seen = new Set()
function harvest(text, source) {
  // JSON/TS string literals carry escaped backslashes and quotes; unescape the
  // common forms so `\\frac` reads as `\frac` the way the renderer sees it.
  const plain = text.replace(/\\\\/g, '\\').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  for (const [re, display] of [[DISPLAY, true], [INLINE, false]]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(plain))) {
      let src = m[2].trim().replace(/^\$+/, '') // a `$$…$$` also matches the inline form one char in
      // JS template literals (`${x}`) and regex source are not maths: a formula
      // starts with a token, never with `{`, and carries at least one TeX
      // command, script or relation.
      if (src.startsWith('{') || /Math\.|toFixed|data-|px;|\?\)/.test(src)) continue
      if (!/\\[a-zA-Z]|[\^_=]/.test(src)) continue
      const key = (display ? 'D' : 'I') + src
      if (seen.has(key)) continue
      seen.add(key)
      corpus.push({ src, display, source })
    }
  }
}

function docOf(html) {
  const m = /<script[^>]*id="bento-doc"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  return m ? m[1] : null
}
function walkStrings(v, fn) {
  if (typeof v === 'string') fn(v)
  else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, fn))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => walkStrings(x, fn))
}
function harvestDeckFile(path, label) {
  if (!existsSync(path)) return
  const html = readFileSync(path, 'utf8')
  const json = docOf(html)
  if (!json) return
  try {
    const doc = JSON.parse(json.replace(/\\u003c/g, '<'))
    const body = doc.body ?? doc // bento/enc envelopes are skipped (no body)
    walkStrings(body, (s) => harvest(s, label))
  } catch { /* encrypted or not a deck */ }
}

// 1. starter deck source
harvest(readFileSync(join(root, 'slides/src/starterdeck.ts'), 'utf8'), 'starterdeck.ts')
// 2. gallery + announcement + 404 decks under working/
for (const f of ['orbital-dark-immersive', 'picnic-playful', 'signal-editorial-type', 'terra-premium-product', 'the-announcement', '404']) {
  harvestDeckFile(join(root, 'working', `${f}.bento.html`), `gallery:${f}`)
}
// their sources too, in case a built copy is stale
for (const f of ['build-example-decks.mjs', 'build-announcement-deck.mjs', 'build-404-deck.mjs', 'build-guestbook.mjs']) {
  const p = join(root, 'scripts', f)
  if (existsSync(p)) harvest(readFileSync(p, 'utf8'), `scripts/${f}`)
}
// 3. guestbook archives + live
for (const dir of ['working/guestbook-archives', 'working/guestbook-epochs', 'working/guestbook-live']) {
  const d = join(root, dir)
  if (!existsSync(d)) continue
  for (const f of readdirSync(d)) if (f.endsWith('.bento.html')) harvestDeckFile(join(d, f), `${dir}/${f}`)
}
// 4. rig fixtures and app sources
function walkDir(d, fn) {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (f === 'node_modules' || f.startsWith('.')) continue
    if (statSync(p).isDirectory()) walkDir(p, fn)
    else fn(p)
  }
}
for (const dir of ['scripts', 'slides/src', 'site-src', 'docs']) {
  const d = join(root, dir)
  if (!existsSync(d)) continue
  walkDir(d, (p) => {
    if (!/\.(ts|mjs|js|md|html)$/.test(p) || p.endsWith('spike-maths-corpus.mjs')) return
    const text = readFileSync(p, 'utf8')
    if (!/\\(frac|sqrt|sum|int|alpha|beta|mathbb|left|begin|cdot|times|infty|partial|nabla|hat|vec|pi\b)|\$\$/.test(text)) return
    harvest(text, relative(root, p))
  })
}

// --- the command table -----------------------------------------------------
const counts = new Map()
const where = new Map()
const bump = (k, source) => { counts.set(k, (counts.get(k) ?? 0) + 1); (where.get(k) ?? where.set(k, new Set()).get(k)).add(source.split(':')[0].split('/')[0]) }
for (const { src, source } of corpus) {
  for (const m of src.matchAll(/\\([a-zA-Z]+|.)/g)) bump('\\' + m[1], source)
  for (const ch of src.replace(/\\[a-zA-Z]+|\\./g, '')) if ('^_{}&'.includes(ch)) bump(ch, source)
  for (const m of src.matchAll(/\\begin\{(\w+\*?)\}/g)) bump(`env:${m[1]}`, source)
}
const table = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .map(([cmd, n]) => ({ cmd, n, sources: [...where.get(cmd)].sort() }))

writeFileSync(out, JSON.stringify({ corpus, table }, null, 2))
console.log(`${corpus.length} distinct formulas (${corpus.filter((c) => c.display).length} display) from ${new Set(corpus.map((c) => c.source)).size} sources → ${out}\n`)
console.log('| command | count | sources |\n| --- | ---: | --- |')
for (const r of table) console.log(`| \`${r.cmd}\` | ${r.n} | ${r.sources.join(', ')} |`)
