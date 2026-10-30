// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Chrome that holds still: layer rows under the pointer, panel handles.
//
//   npm run build:single --prefix slides && node scripts/test-slides-steady-chrome-browser.mjs
//
// WHAT THIS PROVES: hovering a layer row changes nothing but its highlight —
// no row moves, grows or re-wraps (the padlock and eye are always laid out and
// only fade in; they used to be display:none until hover, so every row jumped
// under the pointer). And the panel handles draw an SVG chevron centred in
// their pill, turned toward where a click moves the edge — not a ‹ › character
// sitting on the font's baseline.
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1'); localStorage.setItem('bento-side-view', 'layers') } catch {} })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-layer'))
  await p.waitForTimeout(400)

  console.log('\nlayer rows hold still under the pointer\n')
  const boxes = () => p.evaluate(() => [...document.querySelectorAll('.ed-layer')].filter((r) => r.offsetParent).map((r) => {
    const b = r.getBoundingClientRect(); const l = r.querySelector('.ed-layer-label')?.getBoundingClientRect()
    return `${Math.round(b.top)},${Math.round(b.height)},${Math.round(l?.width ?? 0)}`
  }).join(' '))
  const rest = await boxes()
  const rows = p.locator('.ed-layer:visible')
  const n = Math.min(await rows.count(), 6)
  let moved = 0
  for (let i = 0; i < n; i++) { await rows.nth(i).hover(); await p.waitForTimeout(150); if ((await boxes()) !== rest) moved++ }
  ok(n >= 4 && moved === 0, `hovering ${n} rows moves, grows or re-wraps none of them (changed on ${moved})`)
  const shown = await rows.nth(n - 1).evaluate((r) => [...r.querySelectorAll('.ed-layer-act')].map((a) => getComputedStyle(a).opacity))
  ok(shown.length === 2 && shown.every((o) => o === '1'), 'the hovered row shows its padlock and eye')

  console.log('\npanel handles draw a centred chevron\n')
  const handles = await p.evaluate(() => [...document.querySelectorAll('.ed-panel-toggle')].filter((h) => h.offsetParent).map((h) => {
    const b = h.getBoundingClientRect(); const s = h.querySelector('svg')?.getBoundingClientRect()
    return { text: (h.textContent ?? '').trim(), dir: h.dataset.dir, off: s ? Math.max(Math.abs((s.left + s.width / 2) - (b.left + b.width / 2)), Math.abs((s.top + s.height / 2) - (b.top + b.height / 2))) : 99 }
  }))
  ok(handles.length >= 3, `the two side handles and the notes handle are there (${handles.length})`)
  ok(handles.every((h) => h.text === '' && h.off <= 0.75), `each is an SVG chevron centred in its pill, no text glyph (worst off-centre ${Math.max(...handles.map((h) => h.off)).toFixed(2)}px)`)
  ok(handles.every((h) => ['left', 'right', 'up', 'down'].includes(h.dir)), `each points somewhere (${handles.map((h) => h.dir).join(', ')})`)
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
