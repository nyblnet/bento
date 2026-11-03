// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The saved preview keeps a first page's pictures whenever they fit the budget.
//
//   npm run build:single --prefix slides && node scripts/test-slides-preview-tiers-browser.mjs
//
// WHAT THIS PROVES, in the packaged document. A saved deck carries a still of
// its first page for file managers, in three tiers under PREVIEW_BUDGET: the
// page with its images, the page with tinted boxes where the images were, and
// a title card. Two things decide which tier a deck gets, and both are pinned:
//   1. hoisting — a declaration repeated on the page moves into one rule, so an
//      image used twice costs ONE copy of its data. A length cap on what may be
//      hoisted kept the repeats inline, and a 33 KB image used twice fell to
//      tinted boxes where it fits once;
//   2. the fast path — when the page's distinct assets already exceed the
//      budget, tier 1 is skipped without building it (a 9 MB first page saves
//      in a third of the time). The assets are a LOWER bound on tier 1's size,
//      so the comparison is against the budget itself: compared against less,
//      a 62 KB image that fits was sent to tinted boxes.
// Each case is a saved file's own preview, read back: which tier, and how many
// copies of the image data it holds.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const shell = readFileSync(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'bento-preview-tiers-'))

// incompressible-looking base64, so sizes are what they say
const b64 = (bytes, seed) => { let s = ''; const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; let x = seed; for (let i = 0; i < bytes; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += a[x % 64] } return s }
const img = (kb, seed = 7) => 'data:image/png;base64,' + b64(kb * 1024, seed)
const at = (i) => ({ x: 80 + i * 380, y: 120, w: 340, h: 220, rotation: 0, opacity: 1 })
const images = (srcs) => srcs.map((src, i) => ({ id: 'i' + i, type: 'image', ...at(i), src }))
const deck = (elements) => ({
  format: 'bento/slides', version: 1, docId: 'preview-tiers', title: 'tiers', size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#1E2A3A', accent: '#f7a600', fontFamily: 'system-ui' },
  slides: [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements }],
})
const same = (kb, n) => { const s = img(kb); return Array.from({ length: n }, () => s) }
const CASES = [
  // [name, elements, expected tier, expected copies of image data in tier 1]
  ['one 33 KB image, used twice', images(same(33, 2)), 1, 1],
  ['one 20 KB image, used three times', images(same(20, 3)), 1, 1],
  ['two different 20 KB images', images([img(20, 1), img(20, 2)]), 1, 2],
  ['one 62 KB image, alone (fits)', images([img(62)]), 1, 1],
  ['one 70 KB image, alone (does not fit)', images([img(70)]), 2, 0],
  ['three 3 MB images (the fast path)', images([img(3072, 1), img(3072, 2), img(3072, 3)]), 2, 0],
]

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  for (const [name, elements, tier, copies] of CASES) {
    const p = await ctx.newPage()
    const open = '<script type="application/bento+json" id="bento-doc">', close = '</' + 'script>'
    const a = shell.indexOf(open) + open.length
    const file = join(dir, `${name.replace(/\W+/g, '-')}.bento.html`)
    writeFileSync(file, shell.slice(0, a) + JSON.stringify(deck(elements)).replace(/</g, '\\u003c') + shell.slice(shell.indexOf(close, a)))
    await p.goto('file://' + file)
    await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar'), null, { timeout: 30000 })
    const r = await p.evaluate(() => {
      const html = window.bento.serialize()
      const d = new DOMParser().parseFromString(html, 'text/html')
      const pv = d.querySelector('[data-bento-preview]:not(script)')
      if (!pv) return { tier: 0, copies: 0, bytes: 0 }
      const out = pv.outerHTML
      const copies = (out.match(/data:image\/png/g) || []).length
      const tinted = /linear-gradient\(135deg/.test(out)
      return { tier: copies ? 1 : tinted ? 2 : 3, copies, bytes: new TextEncoder().encode(out).length }
    })
    const label = (t) => ['no preview', 'tier 1 (images)', 'tier 2 (tinted boxes)', 'tier 3 (title card)'][t]
    ok(r.tier === tier && (tier !== 1 || r.copies === copies),
      `${name}: ${label(tier)}${tier === 1 ? `, image data held ${copies}×` : ''} — got ${label(r.tier)}${r.tier === 1 ? `, ${r.copies}×` : ''} (${r.bytes} bytes)`)
    await p.close()
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
