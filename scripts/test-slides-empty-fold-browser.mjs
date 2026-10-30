// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// An inspector section with nothing in it reads as open and folds nothing.
//
//   npm run build:single --prefix slides && node scripts/test-slides-empty-fold-browser.mjs
//
// WHAT THIS PROVES: a section that is only its header — Shadow and Blur before
// their + is pressed — shows the same open chevron as every open section (so
// the column reads alike) but is no button: it has no role, no tab stop, and a
// click or Enter on it changes nothing, even when an earlier session stored it
// as folded. A section with content still folds and unfolds as before.
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  // an earlier session folded Shadow while it had content
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1'); localStorage.setItem('bento-panel-tab', '"format"'); localStorage.setItem('bento-panel-open', JSON.stringify({ Shadow: false })) } catch {} })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-props .ed-tabs'))
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: [
      { id: 'r', type: 'shape', shape: 'rect', x: 100, y: 100, w: 200, h: 100, rotation: 0, opacity: 1, fill: '#ff0000', stroke: 'transparent', strokeWidth: 0, radius: 0 },
    ] }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(300)
  await p.evaluate(() => document.querySelector('.ed-layer[data-id="r"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await p.waitForTimeout(300)

  const head = (key) => p.locator(`.ed-props .ed-section[data-key="${key}"]`)
  const state = (key) => head(key).evaluate((h) => ({
    flat: h.classList.contains('ed-sec-flat'), closed: h.classList.contains('closed'), chevron: h.classList.contains('ed-sec-toggle'),
    role: h.getAttribute('role'), tab: h.getAttribute('tabindex'), expanded: h.getAttribute('aria-expanded'),
    cursor: getComputedStyle(h).cursor,
  }))

  console.log('\nan empty section\n')
  const sh = await state('Shadow')
  ok(sh.flat && sh.chevron && !sh.closed, 'Shadow with no shadow shows the open chevron, never folded — even though it was stored folded')
  ok(sh.role === null && sh.tab === null && sh.expanded === null, 'and it is no button: no role, no tab stop, no aria-expanded')
  ok(sh.cursor !== 'pointer', 'nor does it offer a pointing hand')
  await head('Shadow').click({ position: { x: 60, y: 10 } })
  await p.waitForTimeout(200)
  ok(!(await state('Shadow')).closed, 'a click on it folds nothing')

  console.log('\na section with content\n')
  const fill = await state('Fill')
  ok(!fill.flat && fill.role === 'button' && fill.tab === '0', 'Fill is still a fold button')
  await head('Fill').click({ position: { x: 60, y: 10 } })
  await p.waitForTimeout(250)
  ok((await state('Fill')).closed, 'and still folds')
  await head('Fill').click({ position: { x: 60, y: 10 } })
  await p.waitForTimeout(250)

  console.log('\nadding the shadow makes it a fold\n')
  await head('Shadow').locator('.ed-sec-act').click()
  await p.waitForTimeout(300)
  const after = await state('Shadow')
  ok(!after.flat && after.role === 'button', 'with a shadow, Shadow is a fold button again')
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
