// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Hovering never moves the canvas.
//
//   npm run build:single --prefix slides && node scripts/test-slides-hover-steady-browser.mjs
//
// WHAT THIS PROVES: the hover outline (what a click would pick) and the Alt
// measure lines are overlays that cannot grow the canvas's scrollable area.
// Drawn round an element that runs off the slide, the outline used to widen
// the scroll area, so scrollbars came and went and the whole slide jumped as
// the pointer crossed it.
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
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1') } catch {} })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale'))
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    const r = (id, x, y, w, h) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, rotation: 0, opacity: 1, fill: '#4b8cf5', stroke: 'transparent', strokeWidth: 0, radius: 0 })
    // one inside the slide, one running far off its right and bottom edges
    d.slides = [{ id: 's', background: '#fff', transition: 'none', notes: '', elements: [r('in', 200, 200, 200, 120), r('off', d.size.width - 150, d.size.height - 100, 900, 700)] }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)
  const scroll = () => p.evaluate(() => { const s = document.querySelector('.ed-scroll'); const st = document.querySelector('.ed-stage-scale').getBoundingClientRect(); return `${s.scrollWidth}x${s.scrollHeight}@${s.scrollLeft},${s.scrollTop}|${Math.round(st.left)},${Math.round(st.top)}` })
  const rest = await scroll()
  const visibleOf = (id) => p.evaluate((id) => { const b = document.querySelector(`.ed-stage-scale [data-el-id="${id}"]`).getBoundingClientRect(); const s = document.querySelector('.ed-scroll').getBoundingClientRect(); const x = Math.max(b.left, s.left) + 8, y = Math.max(b.top, s.top) + 8; return { x, y } }, id)
  let moved = 0
  for (const id of ['off', 'in', 'off']) {
    const at = await visibleOf(id)
    for (const dx of [0, 12, 24]) { await p.mouse.move(at.x + dx, at.y + dx); await p.waitForTimeout(80); if ((await scroll()) !== rest) moved++ }
  }
  const outlined = await p.evaluate(() => !!document.querySelector('.ed-hover-box'))
  ok(outlined, 'hovering draws the pick outline')
  ok(moved === 0, `hovering an element that runs off the slide moves nothing — scroll size, scroll position and the slide stay put (changed on ${moved} of 9 moves)`)
  // Alt measures from the selection to the hovered element, off-slide included
  await p.evaluate(() => document.querySelector('.ed-layer[data-id="in"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await p.waitForTimeout(200)
  const at = await visibleOf('off')
  await p.mouse.move(at.x, at.y); await p.keyboard.down('Alt'); await p.waitForTimeout(150)
  const withAlt = await scroll()
  await p.keyboard.up('Alt')
  ok(withAlt.split('|')[0] === rest.split('|')[0], `Alt-measuring to it does not grow the scroll area either (${rest.split('|')[0]} → ${withAlt.split('|')[0]})`)
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
