// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Canvas feedback: the modifier line, the transform pill, morph pairing, and
// Layers' padlock and eye.
//
//   npm run build:single --prefix slides && node scripts/test-slides-hud-browser.mjs
//
// WHAT THIS PROVES.
//   1. Holding Alt, ⌘/Ctrl or Shift with the pointer over the canvas shows a
//      line saying what that key does; releasing it, or leaving the canvas,
//      takes the line away.
//   2. Dragging an element shows a pill with its X and Y beside the pointer,
//      and the pill goes when the drag ends.
//   3. On a morph slide, an element paired with one on the slide before gets a
//      ↔ badge in Layers and, selected, a dashed ghost of its old frame with
//      the curve it travels; an unpaired element gets neither. The Animate
//      tab's Preview moves the canvas toward the old frame and puts it back on
//      release — the document never changes.
//   4. The padlock locks: the element stays listed but a click on the canvas
//      passes through it to what is beneath. The eye hides: the element is
//      drawn nowhere (canvas, thumbnail), its row dims, and undo brings it
//      back. Both are one undo step each.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

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
  const box = (id, x, y, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w: 160, h: 100, rotation: 0, opacity: 1, fill: '#5E7699', ...extra })
  await p.evaluate((slides) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = slides
    window.bento.loadDoc(JSON.stringify(d))
  }, [
    { id: 's1', background: '#ffffff', notes: '', transition: 'fade', elements: [box('a', 100, 100)] },
    { id: 's2', background: '#ffffff', notes: '', transition: 'morph', elements: [box('back', 40, 40, { w: 1100, h: 600, fill: '#eeeeee' }), box('a', 700, 300), box('b', 300, 400)] },
  ])
  await p.waitForTimeout(400)
  const node = (id) => p.locator(`.ed-stage-scale [data-el-id="${id}"]`)
  const centre = async (id) => { const b = await node(id).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
  const sel = () => p.evaluate(() => window.bento.selection.slice().sort().join(','))
  const el = (id) => p.evaluate((id) => window.bento.doc.slides[0].elements.find((e) => e.id === id), id)

  console.log('\nthe modifier line\n')
  const c = await centre('a')
  await p.mouse.move(c.x, c.y + 200)
  await p.mouse.move(c.x, c.y + 220)
  const hint = () => p.evaluate(() => { const h = document.querySelector('.ed-modhint'); return h && !h.hidden ? h.textContent : '' })
  ok(await hint() === '', 'nothing is shown with no key held')
  await p.keyboard.down('Alt')
  ok(/^Alt:/.test(await hint()), `Alt shows what Alt does (${await hint()})`)
  await p.keyboard.up('Alt')
  ok(await hint() === '', 'releasing it takes the line away')
  await p.keyboard.down('Shift')
  ok(/^Shift:.*axis/.test(await hint()), 'Shift shows what Shift does')
  await p.keyboard.up('Shift')
  await p.keyboard.down(MOD)
  ok(/duplicates/.test(await hint()), '⌘/Ctrl shows what it does')
  await p.keyboard.up(MOD)
  await p.mouse.move(5, 500) // over the side column
  await p.keyboard.down('Alt')
  ok(await hint() === '', 'off the canvas, a held key shows nothing')
  await p.keyboard.up('Alt')

  console.log('\nthe transform pill\n')
  await p.mouse.click(c.x, c.y); await p.waitForTimeout(200)
  ok(await sel() === 'a', 'the element is selected')
  await p.mouse.move(c.x, c.y)
  await p.mouse.down()
  await p.mouse.move(c.x + 30, c.y + 10, { steps: 4 })
  await p.mouse.move(c.x + 60, c.y + 20, { steps: 4 })
  const pill = await p.evaluate(() => { const h = document.querySelector('.ed-hud'); return h && !h.hidden ? h.textContent : '' })
  ok(/^X \d+(\.\d)?\s+Y \d+(\.\d)?$/.test(pill), `a drag shows X and Y beside the pointer (${pill})`)
  await p.mouse.up(); await p.waitForTimeout(150)
  ok(await p.evaluate(() => document.querySelector('.ed-hud')?.hidden), 'and the pill goes when the drag ends')
  const moved = await el('a')
  ok(moved.x > 100, `the drag moved the element (x ${moved.x})`)
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(200)

  console.log('\nmorph pairing\n')
  await p.keyboard.press('Escape')
  await p.keyboard.press('PageDown'); await p.waitForTimeout(300)
  const badges = await p.$$eval('.ed-side-layers .ed-layer[data-id]', (rs) => rs.filter((r) => r.querySelector('.ed-layer-morph')).map((r) => r.dataset.id))
  ok(JSON.stringify(badges) === '["a"]', `only the paired element has the ↔ badge (${badges})`)
  await p.locator('.ed-side-layers .ed-layer[data-id="a"]').click(); await p.waitForTimeout(200)
  const ghost = await p.evaluate(() => {
    const g = document.querySelector('.ed-stage-scale .ed-morph-ghost')
    const r = g?.querySelector('rect')
    return g ? { x: +r.getAttribute('x'), y: +r.getAttribute('y'), path: !!g.querySelector('path') } : null
  })
  ok(!!ghost && ghost.x === 100 && ghost.y === 100 && ghost.path, `selected, it shows a dashed ghost at its old frame and the curve (${JSON.stringify(ghost)})`)
  await p.locator('.ed-side-layers .ed-layer[data-id="b"]').click(); await p.waitForTimeout(200)
  ok(!(await p.$('.ed-stage-scale .ed-morph-ghost')), 'an unpaired element shows none')
  await p.locator('.ed-side-layers .ed-layer[data-id="a"]').click(); await p.waitForTimeout(200)
  await p.locator('.ed-props .ed-tabs [role="tab"]', { hasText: /^Animate$/i }).click(); await p.waitForTimeout(200)
  const range = p.locator('.ed-props .ed-morph-preview')
  ok(await range.count() === 1, 'the Morph section offers a Preview')
  const before = JSON.stringify(await p.evaluate(() => window.bento.doc))
  await range.evaluate((r) => { r.value = '0'; r.dispatchEvent(new Event('input')) })
  const at0 = await centre('a')
  const at1Model = await p.evaluate(() => { const e = window.bento.doc.slides[1].elements.find((x) => x.id === 'a'); return e.x })
  await range.evaluate((r) => { r.value = '100'; r.dispatchEvent(new Event('input')) })
  const at100 = await centre('a')
  ok(at0.x < at100.x - 100, `at 0% the element stands at its old frame, at 100% at its own (${Math.round(at0.x)} → ${Math.round(at100.x)})`)
  await range.evaluate((r) => { r.value = '40'; r.dispatchEvent(new Event('input')) })
  await range.evaluate((r) => r.dispatchEvent(new Event('pointerup')))
  await p.waitForTimeout(150)
  ok(Math.abs((await centre('a')).x - at100.x) > 1, 'letting go keeps the preview where it was released')
  await range.evaluate((r) => r.dispatchEvent(new Event('blur')))
  await p.waitForTimeout(150)
  const back = await centre('a')
  ok(Math.abs(back.x - at100.x) < 1, 'moving on from the scrubber puts the canvas back')
  ok(JSON.stringify(await p.evaluate(() => window.bento.doc)) === before && at1Model === 700, 'the document never changed')

  console.log('\nthe padlock\n')
  await p.keyboard.press('PageUp'); await p.waitForTimeout(150)
  await p.evaluate((slides) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = slides
    window.bento.loadDoc(JSON.stringify(d))
  }, [{ id: 's1', background: '#ffffff', notes: '', transition: 'fade', elements: [box('back', 40, 40, { w: 1100, h: 600, fill: '#eeeeee' }), box('top', 300, 200)] }])
  await p.waitForTimeout(400)
  const rowOf = (id) => p.locator(`.ed-side-layers .ed-layer[data-id="${id}"]`)
  await rowOf('top').hover()
  await rowOf('top').locator('.ed-layer-locked').click(); await p.waitForTimeout(200)
  ok((await el('top')).locked === true, 'the padlock sets locked')
  ok(await node('top').evaluate((n) => n.dataset.locked === '1'), 'the canvas marks it')
  await p.keyboard.press('Escape')
  const t = await centre('top')
  await p.mouse.click(t.x, t.y); await p.waitForTimeout(200)
  ok(await sel() === 'back', `a click on it passes through to what is beneath (${await sel()})`)
  ok(await rowOf('top').count() === 1, 'it stays listed')
  ok(await rowOf('top').locator('.ed-layer-locked.on').isVisible(), 'its padlock stays shown while on')
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(200)
  ok(!(await el('top')).locked, 'one undo unlocks it')

  console.log('\nthe eye\n')
  await rowOf('top').hover()
  await rowOf('top').locator('.ed-layer-hidden').click(); await p.waitForTimeout(250)
  ok((await el('top')).hidden === true, 'the eye sets hidden')
  ok(await node('top').count() === 0, 'the canvas no longer draws it')
  ok(await p.locator('.ed-thumb [data-el-id="top"]').count() === 0, 'nor does the thumbnail')
  ok((await rowOf('top').getAttribute('class')).includes('is-hidden'), 'its row dims')
  await rowOf('top').locator('.ed-layer-hidden').click(); await p.waitForTimeout(250)
  ok(!(await el('top')).hidden && await node('top').count() === 1, 'the eye again shows it')
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250)
  ok((await el('top')).hidden === true, 'undo steps back one toggle')
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250)
  ok(!(await el('top')).hidden, 'and another')

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
