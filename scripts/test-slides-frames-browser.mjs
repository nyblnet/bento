// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Auto-layout frames in the real editor.
//
//   npm run build:single --prefix slides && node scripts/test-slides-frames-browser.mjs
//
// WHAT THIS PROVES. ⇧A wraps the selection in a frame, behind it, in one undo
// step, and lays the children out (padding, gap, the axis they were spread
// on); the frame is selected and the inspector shows its Auto layout section;
// moving the frame moves its children (the solver, not a group); changing the
// gap from the inspector re-lays them; the canvas draws the padding and gap
// bands; the layer list shows the children under the frame; a clip frame
// clips an overflowing child on the canvas; deleting the frame leaves its
// children where they were, as ordinary elements; one undo of ⇧A restores
// the slide exactly.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  await ctx.addInitScript(() => localStorage.setItem('bento-side-view', 'layers'))
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))
  const box = (id, x, y, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w: 160, h: 100, rotation: 0, opacity: 1, fill: '#5E7699', stroke: 'none', strokeWidth: 0, radius: 0, ...extra })
  await p.evaluate((els) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: els }]
    window.bento.loadDoc(JSON.stringify(d))
  }, [box('a', 100, 100), box('b', 400, 130), box('c', 700, 90)])
  await p.waitForTimeout(400)
  const els = () => p.evaluate(() => JSON.parse(JSON.stringify(window.bento.doc.slides[0].elements)))
  const at = (list, id) => list.find((e) => e.id === id)
  const before = JSON.stringify(await els())

  console.log('\n⇧A wraps the selection\n')
  const pick = async (id, shift = false) => {
    const b = await p.locator(`.ed-stage-scale [data-el-id="${id}"]`).boundingBox()
    if (shift) await p.keyboard.down('Shift')
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await p.waitForTimeout(150)
    if (shift) await p.keyboard.up('Shift')
  }
  await pick('a'); await pick('b', true); await pick('c', true)
  await p.keyboard.press('Shift+A'); await p.waitForTimeout(300)
  let list = await els()
  const f = list.find((e) => e.layout)
  ok(!!f && f.shape === 'rect' && list.indexOf(f) === 0, 'a frame (a rect with layout) is inserted behind the selection')
  ok(f && ['a', 'b', 'c'].every((id) => at(list, id).parentId === f.id), 'the selection becomes its children')
  ok(f && f.layout.dir === 'row', 'children spread across become a row')
  ok(f && at(list, 'a').x === f.x + 16 && at(list, 'b').x === at(list, 'a').x + 160 + 16 && at(list, 'a').y === f.y + 16, 'the children are laid out: padding then gap')
  ok(f && f.w === 16 * 2 + 160 * 3 + 16 * 2, 'the frame hugs them')
  ok(await p.evaluate(() => window.bento.selection.join()) === f?.id, 'the frame is selected')
  ok(await p.locator('.ed-props .ed-section', { hasText: /^Auto layout/ }).count() === 1, 'the inspector shows the Auto layout section')
  ok(await p.locator('.ed-stage-scale .ed-frame-band').count() === 4 + 2, 'the canvas shows four padding bands and two gap bands')
  const rowIds = await p.$$eval('.ed-side-layers .ed-layers > .ed-layer', (rs) => rs.map((r) => r.dataset.id))
  ok(rowIds[0] === f?.id && rowIds.slice(1).sort().join() === 'a,b,c', 'the layer list shows the children under the frame')

  console.log('\nthe frame carries its children\n')
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(200) // the frame is selected: a nudge moves it
  list = await els()
  const moved = at(list, f.id)
  ok(moved.x !== f.x && at(list, 'a').x === moved.x + 16 && at(list, 'a').y === moved.y + 16, `moving the frame moves its children (frame ${f.x}→${moved.x})`)
  const gapInput = p.locator('.ed-props .ed-mini input[aria-label="Gap"]')
  await gapInput.fill('40'); await gapInput.press('Enter'); await p.waitForTimeout(200)
  list = await els()
  ok(at(list, 'b').x - at(list, 'a').x === 160 + 40, 'the inspector gap re-lays the row')

  console.log('\nclip, delete, undo\n')
  const kept = at(await els(), 'b')
  await p.evaluate(() => document.activeElement?.blur()) // the gap field had focus
  await p.keyboard.press('Delete'); await p.waitForTimeout(200)
  list = await els()
  ok(!at(list, f.id) && !at(list, 'b').parentId && at(list, 'b').x === kept.x, 'deleting the frame leaves the children where they were, unparented')
  for (let i = 0; i < 4; i++) { await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(100) }
  ok(JSON.stringify(await els()) === before, 'undoing back past ⇧A restores the slide exactly')

  // a clip frame, from a file: the overflowing child is clipped on the canvas
  await p.evaluate((els) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: els }]
    window.bento.loadDoc(JSON.stringify(d))
  }, [box('f', 100, 100, { w: 200, layout: { dir: 'row', gap: 0, pad: [0, 0, 0, 0], clip: true } }), box('wide', 0, 0, { w: 400, parentId: 'f' })])
  await p.waitForTimeout(400)
  ok(await p.locator('.ed-stage-scale [data-el-id="wide"]').evaluate((n) => n.style.clipPath) === 'inset(0px 200px 0px 0px)', 'a clip frame clips its overflowing child on the canvas')
  ok(!errors.length, `no page error${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
