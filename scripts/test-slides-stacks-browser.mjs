// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Fill and stroke stacks in the editor, end to end in the built shell.
//
//   npm run build:single --prefix slides && node scripts/test-slides-stacks-browser.mjs
//
// WHAT THIS PROVES.
//   1. The renderer draws every visible layer, fills under strokes, bottom
//      first, and a hidden layer not at all.
//   2. "Add fill layer" turns one fill into a stack of two, the new layer on
//      top and mirrored into `fill`; one undo puts the single fill back.
//   3. Each layer row's eye, move-down and remove is ONE undo step, and
//      removing down to one layer folds the stack back into `fill`.
//   4. "Add stroke layer" stacks strokes the same way, and the Stroke header's
//      − removes every stroke layer at once.
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
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))
  const shape = (id, x, y, w, h, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, rotation: 0, opacity: 1, fill: '#5E7699', stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })
  await p.evaluate((els) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', notes: '', transition: 'none', elements: els }]
    window.bento.loadDoc(JSON.stringify(d))
  }, [
    shape('one', 100, 100, 300, 200),
    shape('stk', 500, 100, 300, 200, {
      fills: [{ color: '#ff0000' }, { color: '#00ff00', hidden: true }, { color: '#0000ff' }],
      strokes: [{ color: '#111111', width: 10 }, { color: '#222222', width: 4, align: 'outside' }],
    }),
  ])
  await p.waitForTimeout(500)
  const el = (id) => p.evaluate((id) => JSON.parse(JSON.stringify(window.bento.doc.slides[0].elements.find((e) => e.id === id))), id)
  const node = (id) => `.ed-stage-scale [data-el-id="${id}"]`
  const select = async (id) => {
    await p.keyboard.press('Escape'); await p.waitForTimeout(80)
    const b = await p.locator(node(id)).boundingBox()
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await p.waitForTimeout(250)
  }
  const undo = async () => { await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250) }
  const click = async (sel) => { await p.locator(sel).first().click(); await p.waitForTimeout(250) }

  console.log('\nthe renderer\n')
  const drawn = await p.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-layer]`)]
    .map((n) => `${n.getAttribute('data-layer')}:${n.getAttribute('fill')}:${n.getAttribute('stroke') ?? ''}`), node('stk'))
  const tags = [...new Set(drawn.map((d) => d.split(':')[0]))]
  ok(JSON.stringify(tags) === '["fill0","fill2","stroke0","stroke1"]', `visible layers drawn bottom first, fills under strokes, the hidden one not at all (${tags.join(' ')})`)
  ok(drawn.some((d) => d.startsWith('fill2:#0000ff')) && drawn.some((d) => d.startsWith('fill0:#ff0000')), 'each fill layer paints its own colour')
  const mirrored = await el('stk')
  ok(mirrored.fill === '#0000ff' && mirrored.stroke === '#222222' && mirrored.strokeWidth === 4 && mirrored.strokeAlign === 'outside', 'boot mirrors the top layers into the plain keys')

  console.log('\nadding a fill layer\n')
  await select('one')
  await click('.ed-props .ed-addlayer:has-text("Add fill layer")')
  let one = await el('one')
  ok(one.fills?.length === 2 && one.fills[0].color === '#5E7699' && one.fill === one.fills[1].color, 'one fill became a stack of two, the new one on top and mirrored')
  ok(await p.locator('.ed-props .ed-paintlayer').count() === 2, 'the Fill section lists two layer rows')
  await undo()
  one = await el('one')
  ok(!one.fills && one.fill === '#5E7699', 'one undo puts the single fill back')

  console.log('\nlayer rows\n')
  await select('stk')
  // rows list the top layer first: fill row 0 = layer 2
  const fillRow = (n) => `.ed-props .ed-paintlayer >> nth=${n}`
  await click(`${fillRow(0)} >> .ed-paintlayer-eye`)
  let stk = await el('stk')
  ok(stk.fills[2].hidden === true && stk.fill === '#ff0000', 'the eye hides the top layer; the fallback falls to the next visible one')
  await undo()
  stk = await el('stk')
  ok(!stk.fills[2].hidden && stk.fill === '#0000ff', 'one undo shows it again')
  await click(`${fillRow(0)} >> button[aria-label="Move layer down"]`)
  stk = await el('stk')
  ok(stk.fills.map((f) => f.color).join() === '#ff0000,#0000ff,#00ff00', 'move down swaps the layer with the one beneath')
  await undo()
  await click(`${fillRow(0)} >> button[aria-label="Remove layer"]`)
  await p.waitForTimeout(100)
  await click(`${fillRow(0)} >> button[aria-label="Remove layer"]`)
  stk = await el('stk')
  ok(!stk.fills && stk.fill === '#ff0000', 'removing down to one layer folds the stack back into `fill`')
  await undo()
  stk = await el('stk')
  ok(stk.fills?.length === 2, 'one undo per removal')
  await undo()

  console.log('\nstrokes\n')
  await select('one')
  await click('.ed-props .ed-section[data-key="Stroke"] .ed-sec-act')
  await click('.ed-props .ed-addlayer:has-text("Add stroke layer")')
  one = await el('one')
  ok(one.strokes?.length === 2 && one.strokeWidth === one.strokes[1].width, '"Add stroke layer" stacks a second stroke, mirrored')
  ok(await p.evaluate((sel) => document.querySelectorAll(`${sel} [data-layer^="stroke"]`).length, node('one')) >= 2, 'both stroke layers are drawn')
  await click('.ed-props .ed-section[data-key="Stroke"] .ed-sec-act')
  one = await el('one')
  ok(!one.strokes && one.strokeWidth === 0, "the Stroke header's − removes every stroke layer")

  ok(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
