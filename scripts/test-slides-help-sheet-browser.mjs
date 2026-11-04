// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The keyboard shortcuts dialog fits what it says, in long languages, with real input.
//
//   npm run build:single --prefix slides && node scripts/test-slides-help-sheet-browser.mjs
//
// WHAT THIS PROVES, in en, pt and de, at 1440×900, 1280×800 and a 390px phone:
//   1. no row's keys overlap its name, and every row stays inside the list;
//   2. the dialog fits the window (a full-screen sheet on the phone);
//   3. every row's keycaps end on one right edge (D8: right-aligned against
//      what they do, as a menu's are), in the interface face, never a monospace;
//   4. the category rail never truncates a category name.
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const SHELL = process.env.SHELL_HTML || fileURLToPath(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url))

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  for (const locale of ['en-US', 'pt-BR', 'de-DE']) {
    for (const [w, h] of [[1440, 900], [1280, 800], [390, 844]]) {
      const tag = `[${locale} ${w}×${h}]`
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale })
      await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1') } catch {} })
      await ctx.route(/^https?:/, (r) => r.abort())
      const p = await ctx.newPage()
      const errors = []
      p.on('pageerror', (e) => errors.push(e.message))
      await p.goto('file://' + SHELL)
      await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale'))
      await p.evaluate(() => document.querySelector('.ed-keys-overlay, .ed-about-overlay')?.remove())
      await p.locator('.ed-stage-scale').click({ position: { x: 4, y: 4 }, force: true })
      await p.keyboard.press('?')
      const opened = await p.waitForSelector('.ed-keys', { timeout: 3000 }).then(() => true, () => false)
      ok(opened, `${tag} ? opens the shortcuts dialog`)
      if (!opened) { await ctx.close(); continue }
      const r = await p.evaluate(() => {
        const rect = (n) => n.getBoundingClientRect()
        const box = rect(document.querySelector('.ed-keys')), list = rect(document.querySelector('.ed-keys-list'))
        const rows = [...document.querySelectorAll('.ed-keys-row')].filter((n) => n.offsetParent)
        const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1
        const overlaps = rows.filter((row) => hit(rect(row.querySelector('.ed-keys-name')), rect(row.querySelector('.ed-keys-keys')))).map((r) => r.textContent.slice(0, 30))
        const outside = rows.filter((row) => { const b = rect(row); return b.left < list.left - 9 || b.right > list.right + 9 }).map((r) => r.textContent.slice(0, 30))
        const rights = rows.map((row) => Math.round(rect(row.querySelector('.ed-keys-keys')).right))
        const kbd = document.querySelector('.ed-keys-keys kbd')
        const cut = [...document.querySelectorAll('.ed-keys-cat > span:first-child')].filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent)
        return { w: box.width, h: box.height, vw: innerWidth, vh: innerHeight, overlaps, outside, ragged: Math.max(...rights) - Math.min(...rights), rows: rows.length, font: getComputedStyle(kbd).fontFamily, cut }
      })
      ok(r.rows > 60, `${tag} the dialog lists the shortcuts (${r.rows} rows)`)
      ok(r.overlaps.length === 0, `${tag} no row's keys overlap its name${r.overlaps.length ? ': ' + r.overlaps.slice(0, 3).join(' | ') : ''}`)
      ok(r.outside.length === 0, `${tag} every row stays inside the list${r.outside.length ? ': ' + r.outside.slice(0, 3).join(' | ') : ''}`)
      ok(r.w <= r.vw && r.h <= r.vh, `${tag} the dialog fits the window (${Math.round(r.w)}×${Math.round(r.h)} of ${r.vw}×${r.vh})`)
      ok(r.ragged <= 1, `${tag} every row's keycaps end on one right edge (spread ${r.ragged}px)`)
      ok(!/mono/i.test(r.font), `${tag} keycaps in the interface face (${r.font.split(',')[0]})`)
      ok(r.cut.length === 0, `${tag} no category name is cut${r.cut.length ? ': ' + r.cut.join(', ') : ''}`)
      ok(errors.length === 0, `${tag} no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
      await ctx.close()
    }
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
