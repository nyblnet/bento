// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The shortcuts & tips sheet fits what it says, in long languages, with real input.
//
//   npm run build:single --prefix slides && node scripts/test-slides-help-sheet-browser.mjs
//
// WHAT THIS PROVES, in en, pt and de, at 1440×900 and 1280×800:
//   1. no key overlaps any description — a long key ('Animate ▸ Loop
//      animation') used to spill out of its fixed 128px column, leftward, over
//      the other column's text;
//   2. every key and description stays inside its own column;
//   3. the sheet fits the window's width;
//   4. within a section the keys share one right edge (D8: right-aligned
//      against what they do, as a menu's are).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  for (const locale of ['en-US', 'pt-BR', 'de-DE']) {
    for (const [w, h] of [[1440, 900], [1280, 800]]) {
      const tag = `[${locale} ${w}×${h}]`
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale })
      await ctx.route(/^https?:/, (r) => r.abort())
      const p = await ctx.newPage()
      const errors = []
      p.on('pageerror', (e) => errors.push(e.message))
      await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
      await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-btn-help'))
      await p.locator('.ed-btn-help').click()
      await p.waitForSelector('.ed-help-box')
      const r = await p.evaluate(() => {
        const box = document.querySelector('.ed-help-box').getBoundingClientRect()
        const rect = (n) => n.getBoundingClientRect()
        const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1
        const keys = [...document.querySelectorAll('.ed-help-row kbd')]
        const texts = [...document.querySelectorAll('.ed-help-row > span')]
        const overlaps = []
        for (const k of keys) for (const s of texts) if (hit(rect(k), rect(s))) overlaps.push(`${k.textContent} × ${s.textContent.slice(0, 24)}`)
        const outside = [...keys, ...texts].filter((n) => { const c = rect(n.closest('.ed-help-col')), b = rect(n); return b.left < c.left - 1 || b.right > c.right + 1 }).map((n) => n.textContent.slice(0, 30))
        const ragged = [...document.querySelectorAll('.ed-help-sec')].filter((sec) => {
          const rights = [...sec.querySelectorAll('kbd')].map((k) => Math.round(rect(k).right))
          return rights.length > 1 && Math.max(...rights) - Math.min(...rights) > 1
        }).map((s) => s.querySelector('h3').textContent)
        const said = keys.map((k) => k.textContent)
        const newRows = ['⇧A', '⇧U', 'K', '360/2'].filter((k) => !said.some((x) => x.includes(k)))
        return { w: box.width, vw: innerWidth, overlaps, outside, ragged, keys: keys.length, newRows }
      })
      ok(r.keys > 20, `${tag} the sheet opened (${r.keys} keys)`)
      ok(r.newRows.length === 0, `${tag} the sheet names auto layout, booleans, the palette and arithmetic${r.newRows.length ? ' — missing ' + r.newRows.join(', ') : ''}`)
      ok(r.overlaps.length === 0, `${tag} no key overlaps a description${r.overlaps.length ? ': ' + r.overlaps.slice(0, 4).join(' | ') : ''}`)
      ok(r.outside.length === 0, `${tag} everything stays in its column${r.outside.length ? ': ' + r.outside.slice(0, 4).join(' | ') : ''}`)
      ok(r.w <= r.vw, `${tag} the sheet fits the window (${Math.round(r.w)} of ${r.vw}px)`)
      ok(r.ragged.length === 0, `${tag} keys share a right edge within each section${r.ragged.length ? ': ' + r.ragged.join(', ') : ''}`)
      ok(errors.length === 0, `${tag} no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
      await ctx.close()
    }
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
