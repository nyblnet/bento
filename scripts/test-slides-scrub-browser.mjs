// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Scrubbing a numeric field by dragging its label, in the packaged editor, with real input.
//
//   npm run build:single --prefix slides && node scripts/test-slides-scrub-browser.mjs
//
// WHAT THIS PROVES:
//   1. dragging the X label moves the element LIVE, 1 unit per 2px, and the
//      label is still the same node at the end (the panel did not rebuild
//      under the pointer);
//   2. the whole drag is ONE undo step;
//   3. Shift scrubs ×10;
//   4. a press that does not move is a label click: the field takes focus and
//      typing a value still works;
//   5. a row's numeric field (text Size) scrubs the same way;
//   6. a field with no label of its own (a colour's opacity) scrubs from its
//      unit chip.
//   7. a drag never takes a field past its limits — measured MID-DRAG, in the
//      field, not only in the model (whose setter clamps anyway): opacity stays
//      within 0–100 however far the pointer goes, and turning back moves the
//      value at once (no dead zone the length of the overshoot); a width never
//      goes under 1.
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
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))

  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{
      id: 's1', background: '#ffffff', elements: [
        { id: 'box', type: 'shape', shape: 'rect', x: 200, y: 200, w: 200, h: 120, rotation: 0, opacity: 1, fill: '#5E7699' },
        { id: 'txt', type: 'text', x: 600, y: 200, w: 400, h: 100, rotation: 0, opacity: 1, html: 'Hello', fontSize: 32, color: '#1E2A3A', textStroke: { width: 2, color: '#000000' } },
      ],
    }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)

  const el = (id) => p.evaluate((id) => { const e = window.bento.doc.slides[0].elements.find((e) => e.id === id); return { x: e.x, w: e.w, fontSize: e.fontSize } }, id)
  const select = async (id) => {
    const b = await p.locator(`.ed-stage-scale [data-el-id="${id}"]`).boundingBox()
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
    await p.waitForTimeout(250)
  }
  const mini = (label) => p.locator('.ed-props .ed-mini > span', { hasText: new RegExp(`^${label}$`) }).first()
  const drag = async (handle, dx, mods = []) => {
    const node = await handle.elementHandle()
    const b = await handle.boundingBox()
    const x = b.x + b.width / 2, y = b.y + b.height / 2
    for (const m of mods) await p.keyboard.down(m)
    await p.mouse.move(x, y); await p.mouse.down()
    await p.mouse.move(x + dx / 2, y, { steps: 5 })
    const mid = await p.evaluate(() => window.bento.doc.slides[0].elements.find((e) => e.id === 'box').x)
    const alive = await node.evaluate((n) => n.isConnected)
    await p.mouse.move(x + dx, y, { steps: 5 }); await p.mouse.up()
    for (const m of mods) await p.keyboard.up(m)
    await p.waitForTimeout(250)
    return { mid, alive }
  }

  // 1–2. X, live, one undo step.
  await select('box')
  const { mid: midX, alive } = await drag(mini('X'), 40)
  ok(midX > 200 && midX < 220, `the element moves while the label is dragged (x mid-drag: ${midX})`)
  ok((await el('box')).x === 220, `40px of drag is +20 (x: ${(await el('box')).x})`)
  ok(alive, 'the label under the pointer is the same node mid-drag (no rebuild under the pointer)')
  ok(await p.evaluate(() => document.activeElement?.tagName !== 'INPUT'), 'the field lets go of focus on release, so ⌘Z reaches the editor')
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250)
  ok((await el('box')).x === 200, 'one undo puts the whole drag back')

  // 3. Shift ×10.
  await select('box')
  await drag(mini('W'), 20, ['Shift'])
  ok((await el('box')).w === 300, `Shift scrubs ×10 (w: ${(await el('box')).w})`)

  // 4. A click is still a label click.
  await select('box')
  await mini('X').click()
  ok(await p.evaluate(() => document.activeElement?.closest('.ed-mini')?.textContent?.trim().startsWith('X') ?? false), 'a still press focuses the field')
  await p.keyboard.press(`${MOD}+a`); await p.keyboard.type('333'); await p.keyboard.press('Enter')
  await p.waitForTimeout(250)
  ok((await el('box')).x === 333, 'typing still sets the value')

  // 5. The font size: its 'pt' inside the field, Penpot-style.
  await select('txt')
  const size = mini('pt')
  ok(await size.count() === 1, 'the text panel has its size field')
  const before = (await el('txt')).fontSize
  await drag(size, 20)
  ok((await el('txt')).fontSize > before, `the Size label scrubs the font size (${before} → ${(await el('txt')).fontSize}px)`)

  // 6. A unit chip.
  const chip = p.locator('.ed-props .ed-section[data-key="Stroke"] + .ed-section-body .ed-color-alpha .ed-unit')
  ok(await chip.count() === 1, 'the outline colour has a % chip')
  await drag(chip, -40)
  const stroke = await p.evaluate(() => window.bento.doc.slides[0].elements.find((e) => e.id === 'txt').textStroke.color)
  ok(/^rgba\(0, 0, 0, 0\.8\)$/.test(stroke), `dragging the % chip 40px left takes 20% off (${stroke})`)

  // 7. Limits.
  await select('box')
  const opacity = () => p.evaluate(() => window.bento.doc.slides[0].elements.find((e) => e.id === 'box').opacity)
  const op = p.locator('.ed-props .ed-layer-block .ed-mini[title="Opacity"]')
  const opIn = op.locator('input')
  const hb = await op.locator('span').boundingBox()
  await p.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await p.mouse.down()
  await p.mouse.move(hb.x + 900, hb.y + hb.height / 2, { steps: 30 })
  const held = +(await opIn.inputValue())
  ok(held === 100, `held far past the end, the field reads 100, not more (${held})`)
  await p.mouse.move(hb.x + 860, hb.y + hb.height / 2, { steps: 8 })
  const back = +(await opIn.inputValue())
  ok(back < 100 && back >= 75, `turning back 40px takes the value down at once (${back})`)
  await p.mouse.move(hb.x - 1200, hb.y + hb.height / 2, { steps: 40 })
  ok(+(await opIn.inputValue()) === 0, `and far left it stops at 0 (${await opIn.inputValue()})`)
  await p.mouse.up(); await p.waitForTimeout(250)
  ok(await opacity() === 0, `the model agrees (${await opacity()})`)
  await drag(mini('W'), -2000)
  ok((await el('box')).w === 1, `a width never goes under 1 (${(await el('box')).w})`)

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
