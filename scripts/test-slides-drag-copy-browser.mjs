// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// What a click would pick is outlined first; a copy-drag never empties the
// spot it copies from.
//
//   npm run build:single --prefix slides && node scripts/test-slides-drag-copy-browser.mjs
//
// WHAT THIS PROVES:
//   1. hovering the canvas outlines what a click would select (Figma's hover):
//      no key — the whole group; ⌘ (Ctrl elsewhere) — the exact member under
//      the pointer; Alt — the next element down the dig; the outline follows
//      the key being pressed and released without the pointer moving, and
//      nothing is outlined over what is already selected;
//   2. during a ⌘-drag copy the spot copied FROM is never empty: sampled every
//      frame — scrolling mid-drag included — something is drawn there (the
//      copy used to appear only on release, so the original seemed to vanish);
//      the drop leaves original and copy, one undo removes the copy;
//   3. Esc during the drag cancels it: no copy, the original where it was.
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const SHELL = process.env.SHELL_HTML || fileURLToPath(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url))
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

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
    const r = (id, x, y, w, h, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, rotation: 0, opacity: 1, fill: '#4b8cf5', stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })
    d.slides = [{ id: 's', background: '#fff', transition: 'none', notes: '', elements: [
      r('back', 100, 400, 500, 300, { fill: '#dddddd' }),
      r('front', 200, 450, 120, 120, { fill: '#ff6b6b' }),
      r('g1', 800, 100, 150, 150, { groupId: 'g', groupName: 'Pair' }),
      r('g2', 1000, 100, 150, 150, { groupId: 'g', groupName: 'Pair' }),
      r('solo', 800, 500, 200, 150, { fill: '#7bd389' }),
    ] }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)
  const centre = (id) => p.evaluate((id) => { const b = document.querySelector(`.ed-stage-scale [data-el-id="${id}"]`).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } }, id)
  const hover = () => p.evaluate(() => document.querySelector('.ed-hover-box')?.dataset.ids ?? '')
  const sel = () => p.evaluate(() => [...window.bento.store?.selection ?? []].join(',') || document.querySelector('.ed-props')?.dataset.sel || '')

  console.log('\n1. hover outlines what a click would pick\n')
  const g1 = await centre('g1')
  await p.mouse.move(g1.x - 10, g1.y - 10); await p.mouse.move(g1.x, g1.y); await p.waitForTimeout(120)
  ok((await hover()).split(' ').sort().join() === 'g1,g2', `no key: the whole group (${await hover()})`)
  await p.keyboard.down(MOD); await p.waitForTimeout(120)
  ok(await hover() === 'g1', `⌘ held, pointer still: the exact member (${await hover()})`)
  await p.keyboard.up(MOD); await p.waitForTimeout(120)
  ok((await hover()).split(' ').sort().join() === 'g1,g2', 'released: back to the group')
  const f = await centre('front')
  await p.mouse.move(f.x, f.y); await p.waitForTimeout(100)
  await p.mouse.click(f.x, f.y); await p.waitForTimeout(250)
  ok(await hover() === '', 'nothing is outlined over what is selected')
  await p.keyboard.down('Alt'); await p.mouse.move(f.x + 1, f.y + 1); await p.waitForTimeout(120)
  ok(await hover() === 'back', `Alt held over the selection: the next one down the dig (${await hover()})`)
  await p.keyboard.up('Alt'); await p.waitForTimeout(100)

  console.log('\n2. a copy-drag never empties the spot it copies from\n')
  const s = await centre('solo')
  await p.mouse.click(s.x, s.y); await p.waitForTimeout(250)
  const from = await p.evaluate(() => { const n = document.querySelector('.ed-stage-scale [data-el-id="solo"]'); return { left: n.style.left, top: n.style.top } })
  // every frame: is something drawn at the original spot (the element or its stand-in)?
  await p.evaluate(({ left, top }) => {
    window.__empty = 0; window.__frames = 0; window.__sampling = true
    const tick = () => {
      if (!window.__sampling) return
      window.__frames++
      const here = [...document.querySelectorAll('.ed-stage-scale .bento-el')].some((n) => n.style.left === left && n.style.top === top && n.offsetParent && getComputedStyle(n).visibility !== 'hidden' && (n.dataset.elId === 'solo' || n.classList.contains('ed-copy-ghost')))
      if (!here) window.__empty++
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, from)
  await p.keyboard.down(MOD)
  await p.mouse.move(s.x, s.y); await p.mouse.down()
  for (let i = 1; i <= 12; i++) { await p.mouse.move(s.x - i * 25, s.y + i * 8); await p.waitForTimeout(16) }
  await p.mouse.wheel(0, 120); await p.waitForTimeout(80) // scrolling mid-drag
  for (let i = 13; i <= 18; i++) { await p.mouse.move(s.x - i * 25, s.y + i * 8); await p.waitForTimeout(16) }
  const mid = await p.evaluate(() => ({ empty: window.__empty, frames: window.__frames }))
  await p.mouse.up(); await p.keyboard.up(MOD); await p.waitForTimeout(300)
  await p.evaluate(() => { window.__sampling = false })
  ok(mid.frames > 10 && mid.empty === 0, `the original's spot is drawn in every frame of the drag (${mid.empty} empty of ${mid.frames})`)
  const after = await p.evaluate(() => window.bento.doc.slides[0].elements.filter((e) => e.fill === '#7bd389').map((e) => `${e.x},${e.y}`))
  ok(after.length === 2 && after.includes('800,500'), `the drop leaves the original where it was and a copy (${after.join(' | ')})`)
  ok(await p.evaluate(() => document.querySelectorAll('.ed-copy-ghost').length) === 0, 'no stand-in is left behind')
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250)
  ok(await p.evaluate(() => window.bento.doc.slides[0].elements.filter((e) => e.fill === '#7bd389').length) === 1, 'one undo removes the copy')

  console.log('\n3. Esc cancels the drag\n')
  const s2 = await centre('solo')
  await p.mouse.click(s2.x, s2.y); await p.waitForTimeout(250)
  await p.keyboard.down(MOD)
  await p.mouse.move(s2.x, s2.y); await p.mouse.down()
  for (let i = 1; i <= 8; i++) { await p.mouse.move(s2.x + i * 20, s2.y + i * 10); await p.waitForTimeout(16) }
  await p.keyboard.press('Escape'); await p.waitForTimeout(100)
  await p.mouse.up(); await p.keyboard.up(MOD); await p.waitForTimeout(300)
  const cancel = await p.evaluate(() => window.bento.doc.slides[0].elements.filter((e) => e.fill === '#7bd389').map((e) => `${e.x},${e.y}`))
  ok(cancel.length === 1 && cancel[0] === '800,500', `no copy, the original where it was (${cancel.join(' | ')})`)
  ok(await p.evaluate(() => { const n = document.querySelector('.ed-stage-scale [data-el-id="solo"]'); return n.style.left === '800px' && n.style.top === '500px' }), 'and drawn back in place')
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
