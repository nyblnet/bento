// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Drag into a frame — from the Layers list and on the canvas.
//
//   npm run build:single --prefix slides && node scripts/test-slides-frame-drop-browser.mjs
//
// WHAT THIS PROVES (Figma's and Penpot's rules for auto-layout frames):
//   Layers: a row dropped on the MIDDLE of a frame row goes inside that frame
//   (indented under it, laid out by it, one undo step); the top and bottom of
//   a row still mean above and below; a frame never goes inside its own child;
//   a child dropped beside a top-level row comes out of its frame.
//   Canvas: dragging an element over an auto-layout frame outlines that frame
//   and shows the slot bar; the drop puts it inside at that slot (one undo
//   step). ⌘/Ctrl held while dragging moves it over the frame instead; a
//   locked frame takes nothing; a child dragged past its frame's edge still
//   comes out.
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
const run = async (fn) => { try { await fn() } catch (e) { ok(false, `threw: ${String(e.message).split('\n')[0]}`) } }
const rect = (id, x, y, w, h, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, rotation: 0, opacity: 1, fill: '#dddddd', stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })
const deck = () => [
  rect('row', 100, 120, 700, 190, { fill: '#f4f4f4', layout: { dir: 'row', gap: 20, pad: [20, 20, 20, 20] } }),
  rect('a', 120, 140, 200, 150, { parentId: 'row' }), rect('b', 340, 140, 200, 150, { parentId: 'row' }),
  rect('x', 120, 520, 120, 100, { fill: '#ff6666' }),
  rect('lk', 900, 120, 300, 190, { fill: '#eeeeff', locked: true, layout: { dir: 'row', gap: 10, pad: [10, 10, 10, 10] } }),
]

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1'); localStorage.setItem('bento-side-view', 'layers') } catch {} })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-props .ed-tabs'))
  const load = async () => {
    await p.evaluate((els) => { const d = JSON.parse(JSON.stringify(window.bento.doc)); d.slides = [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: els }]; window.bento.loadDoc(JSON.stringify(d)) }, deck())
    await p.waitForTimeout(400)
  }
  const els = () => p.evaluate(() => JSON.parse(JSON.stringify(window.bento.doc.slides[0].elements)))
  const el = async (id) => (await els()).find((e) => e.id === id)
  const kids = async (f) => (await els()).filter((e) => e.parentId === f).sort((m, n) => m.x - n.x).map((e) => e.id).join('')
  const undo = async () => { await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(250) }
  const row = (id) => p.locator(`.ed-layer[data-id="${id}"]`)
  const pick = async (id) => { await p.evaluate((id) => document.querySelector(`.ed-layer[data-id="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true })), id); await p.waitForTimeout(250) }
  const node = (id) => p.locator(`.ed-stage-scale [data-el-id="${id}"]`).first()
  // a Layers drop at a fraction of the target row's height (0.5 = its middle)
  const layerDrop = async (from, to, at) => {
    const b = await row(to).boundingBox()
    await row(from).dragTo(row(to), { targetPosition: { x: b.width / 2, y: b.height * at } })
    await p.waitForTimeout(300)
  }
  // a canvas drag of the element's centre to a slide-space point, in small steps
  const canvasDrag = async (id, sx, sy, hold = false) => {
    const a = await node(id).boundingBox()
    const host = await p.locator('.ed-stage-scale').boundingBox()
    const k = await p.evaluate(() => { const h = document.querySelector('.ed-stage-scale'); return h.getBoundingClientRect().width / window.bento.doc.size.width })
    const x0 = a.x + a.width / 2, y0 = a.y + a.height / 2, x1 = host.x + sx * k, y1 = host.y + sy * k
    await p.mouse.move(x0, y0); await p.mouse.down(); await p.waitForTimeout(80)
    if (hold) await p.keyboard.down(MOD)
    let mid = null
    for (let i = 1; i <= 14; i++) {
      await p.mouse.move(x0 + (x1 - x0) * i / 14, y0 + (y1 - y0) * i / 14, { steps: 2 }); await p.waitForTimeout(16)
      if (i === 14) mid = await p.evaluate(() => ({ frame: document.querySelector('.ed-stage-scale .ed-drop-frame')?.dataset.frame ?? null, bar: document.querySelector('.ed-stage-scale .ed-slot-bar')?.dataset.slot ?? null }))
    }
    await p.mouse.up()
    if (hold) await p.keyboard.up(MOD)
    await p.waitForTimeout(350)
    return mid
  }

  console.log('\nLayers\n')
  await run(async () => {
    await load()
    await layerDrop('x', 'row', 0.5)
    ok((await el('x')).parentId === 'row', 'a row dropped on the middle of a frame row goes inside the frame')
    ok(await row('x').evaluate((r) => parseFloat(getComputedStyle(r).paddingInlineStart) > 8), '…and lists indented under it')
    ok((await kids('row')) === 'abx' && (await el('x')).y === 140, `…and the frame lays it out at the end of the row (${await kids('row')}, y ${(await el('x')).y})`)
    await undo()
    ok(!(await el('x')).parentId && (await el('x')).y === 520, 'one undo puts it back out where it was')
  })
  await run(async () => {
    await load()
    const before = (await els()).map((e) => e.id).join()
    await layerDrop('x', 'lk', 0.1)
    const after = (await els()).map((e) => e.id).join()
    ok(!(await el('x')).parentId && after !== before, `the top of a row still means above it — a reorder, not inside (${after})`)
  })
  await run(async () => {
    await load()
    await layerDrop('row', 'a', 0.5)
    ok(!(await el('row')).parentId, 'a frame never goes inside its own child')
  })
  await run(async () => {
    await load()
    await layerDrop('a', 'x', 0.1)
    ok(!(await el('a')).parentId && (await kids('row')) === 'b', `a child dropped beside a top-level row comes out of its frame (${await kids('row')})`)
  })
  await run(async () => {
    await load()
    await layerDrop('x', 'lk', 0.5)
    ok(!(await el('x')).parentId, 'a locked frame takes nothing')
  })

  console.log('\ncanvas\n')
  await run(async () => {
    await load()
    await pick('x')
    const mid = await canvasDrag('x', 330, 215)
    ok(mid?.frame === 'row' && mid?.bar === '1', `mid-drag the frame is outlined as the target and the bar shows slot 1 (${JSON.stringify(mid)})`)
    ok((await el('x')).parentId === 'row' && (await kids('row')) === 'axb', `the drop puts it inside, at that slot (${await kids('row')})`)
    ok(!(await p.evaluate(() => !!document.querySelector('.ed-drop-frame, .ed-slot-bar'))), '…and the outline and bar go')
    await undo()
    ok(!(await el('x')).parentId && (await kids('row')) === 'ab', 'one undo takes it back out')
  })
  await run(async () => {
    await load()
    await pick('x')
    const mid = await canvasDrag('x', 330, 215, true)
    const x = await el('x')
    ok(!mid?.frame && !x.parentId && x.y < 400, `${MOD} held while dragging moves it over the frame without dropping it in (y ${x.y})`)
  })
  await run(async () => {
    await load()
    await pick('x')
    const mid = await canvasDrag('x', 1050, 215)
    const x = await el('x')
    ok(!mid?.frame && !x.parentId && x.x > 800, `a locked frame takes nothing on the canvas either — it just moves over it (x ${x.x})`)
  })
  await run(async () => {
    await load()
    await pick('a')
    await canvasDrag('a', 300, 700)
    ok(!(await el('a')).parentId && (await kids('row')) === 'b', 'a child dragged past its frame\'s edge still comes out')
  })
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
