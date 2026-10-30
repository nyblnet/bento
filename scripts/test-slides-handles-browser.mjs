// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Selection handles that never swallow what they select.
//
//   npm run build:single --prefix slides && node scripts/test-slides-handles-browser.mjs
//
// WHAT THIS PROVES: handles are 8px on screen at any zoom, and how many show
// depends on the selection's size ON SCREEN (Figma's rule): all eight with
// room, the four corners when side handles would crowd it — a thin line of
// text included — and none (no stem either) only when it is small both ways — zoomed out, a small
// element used to disappear under fourteen-pixel handles and a long stem.
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
    const r = (id, x, y, w, h) => ({ id, type: 'shape', shape: 'ellipse', x, y, w, h, rotation: 0, opacity: 1, fill: '#4b8cf5', stroke: 'transparent', strokeWidth: 0, radius: 0 })
    d.slides = [{ id: 's', background: '#fff', transition: 'none', notes: '', elements: [r('tiny', 100, 100, 30, 30), r('small', 300, 100, 90, 90), r('big', 600, 100, 500, 300), r('line', 100, 500, 400, 30)] }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)
  const handles = () => p.evaluate(() => {
    const box = document.querySelector('.moveable-control-box')
    const shown = [...(box?.querySelectorAll('.moveable-control.moveable-direction') ?? [])].filter((c) => getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().width > 0)
    const rot = [...(box?.querySelectorAll('.moveable-rotation') ?? [])].filter((c) => getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().height > 0)
    return { n: shown.length, size: shown.length ? Math.round(shown[0].getBoundingClientRect().width) : 0, rot: rot.length }
  })
  const pick = async (id) => { await p.evaluate((id) => document.querySelector(`.ed-layer[data-id="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true })), id); await p.waitForTimeout(300) }
  // zoomed out as far as the editor goes, where small elements get smallest
  await p.locator('.ed-stage-scale').click({ position: { x: 5, y: 5 }, force: true })
  for (let i = 0; i < 6; i++) { await p.keyboard.press('ControlOrMeta+Minus'); await p.waitForTimeout(120) }
  const screen = (id) => p.evaluate((id) => Math.round(Math.min(document.querySelector(`.ed-stage-scale [data-el-id="${id}"]`).getBoundingClientRect().width, document.querySelector(`.ed-stage-scale [data-el-id="${id}"]`).getBoundingClientRect().height)), id)

  await pick('big')
  let h = await handles()
  ok(h.n === 8 && h.size === 8 && h.rot === 1, `a large selection gets all eight 8px handles and the rotation stem (${h.n} × ${h.size}px)`)
  await pick('small')
  const sw = await screen('small')
  h = await handles()
  ok(sw < 64 ? h.n === 4 : h.n === 8, `a ${sw}px-on-screen selection gets ${sw < 64 ? 'its four corners' : 'all eight'} (${h.n})`)
  await pick('tiny')
  const tw = await screen('tiny')
  h = await handles()
  ok(tw < 24 ? h.n === 0 && h.rot === 0 : h.n <= 4, `a ${tw}px-on-screen selection is not buried under handles (${h.n} handles, stem ${h.rot})`)
  ok(h.size === 0 || h.size === 8, `handles stay 8px on screen (${h.size})`)
  // a thin line of text: short but wide — it keeps its corners and stem
  await pick('line')
  h = await handles()
  ok(h.n === 4 && h.rot === 1, `a wide, short selection (a line of text) keeps its four corners and the stem (${h.n}, stem ${h.rot})`)
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
