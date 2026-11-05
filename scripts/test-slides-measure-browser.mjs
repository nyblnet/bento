// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Alt-hover measuring, in the packaged editor, with real input.
//
//   npm run build:single --prefix slides && node scripts/test-slides-measure-browser.mjs
//
// WHAT THIS PROVES:
//   1. with one element selected, holding Alt and hovering another draws the
//      gaps with the right numbers for a known layout (side by side, stacked,
//      diagonal, and the slide's own edges over empty canvas), and moving to
//      another target re-measures without touching the selection;
//   2. hovering the reference itself, or without Alt, draws nothing;
//   3. it clears on Alt release, on Escape (selection cleared), on leaving the
//      canvas, and while a button is down;
//   4. the numbers are slide units — the same at two zoom levels;
//   5. it is inspection only: the doc JSON is byte-identical and the top of
//      the undo stack is still the load;
//   6. Alt-click still digs (selects the hovered element), and a plain drag
//      still moves;
//   7. the overlay never takes a pointer event;
//   8. a full-bleed element is measured AS an element (its outline is drawn),
//      not mistaken for the slide because its box matches the slide's;
//   9. measuring survives a native drag-and-drop (a layer row dragged in the
//      layer list) — that ends without a mouseup, which left the canvas
//      believing a button was still down;
//  10. releasing Alt over the canvas is swallowed (on Windows a lone Alt
//      press opens the browser's menu bar); elsewhere it is left alone.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const SHOTS = process.env.SHOTS_DIR

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))

  // a: the reference. b: to its right (gap 100, top-top 30, bottom-bottom 20).
  // c: below it (gap 120, left-left 30, right-right 70). d: diagonal (H 400, V 200).
  const before = await p.evaluate(() => JSON.stringify(window.bento.doc))
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    const r = (id, x, y, w, h, fill) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, rotation: 0, opacity: 1, fill })
    d.slides = [{ id: 's1', background: '#ffffff', elements: [
      r('a', 100, 100, 200, 100, '#5E7699'),
      r('b', 400, 130, 100, 50, '#E8A87C'),
      r('c', 130, 320, 100, 80, '#C9D4E3'),
      r('d', 700, 400, 100, 100, '#8FB996'),
    ] }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)
  const loaded = await p.evaluate(() => JSON.stringify(window.bento.doc))

  const node = (id) => p.locator(`.ed-stage-scale [data-el-id="${id}"]`)
  const centre = async (id) => { const b = await node(id).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
  const selected = () => p.evaluate(() => window.bento.selection.slice().sort().join(','))
  const labels = () => p.$$eval('.ed-measure-label', (ls) => ls.map((l) => l.textContent).sort((x, y) => x - y).join(' '))
  const shown = () => p.evaluate(() => !!document.querySelector('.ed-measure-layer'))
  const settle = () => p.waitForTimeout(80)
  const hover = async (pt) => { await p.mouse.move(pt.x, pt.y, { steps: 3 }); await settle() }
  const shot = async (name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }) }

  // select a with a plain click
  await p.keyboard.press('Escape')
  const pa = await centre('a')
  await p.mouse.click(pa.x, pa.y); await p.waitForTimeout(200)
  ok(await selected() === 'a', 'precondition: a is selected')

  // 2. no Alt → nothing
  await hover(await centre('b'))
  ok(!(await shown()), 'hovering without Alt draws nothing')

  // 1. Alt + hover
  await p.keyboard.down('Alt')
  await hover(await centre('b'))
  ok(await labels() === '20 30 100', `side by side: gap 100, top-top 30, bottom-bottom 20 (${await labels()})`)
  await shot('side-by-side')
  await hover(await centre('c'))
  ok(await labels() === '30 70 120', `stacked: gap 120, left-left 30, right-right 70 (${await labels()})`)
  await hover(await centre('d'))
  ok(await labels() === '200 400', `diagonal: 400 across, 200 down (${await labels()})`)
  await shot('diagonal')
  ok(await selected() === 'a', 'moving between targets leaves the selection alone')
  const sb = await p.locator('.ed-stage-scale').boundingBox()
  await hover({ x: sb.x + sb.width * 0.6, y: sb.y + sb.height * 0.15 })
  ok(await labels() === '100 100 520 980', `empty slide: insets to the slide edges (${await labels()})`)
  await shot('slide-edges')
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('.ed-measure-layer')).pointerEvents) === 'none', 'the overlay takes no pointer events')
  await hover(pa)
  ok(!(await shown()), 'hovering the reference itself draws nothing')

  // 3. clears on release, leave, press
  await hover(await centre('b'))
  ok(await shown(), 'back on b, shown again')
  await p.keyboard.up('Alt'); await settle()
  ok(!(await shown()), 'releasing Alt clears it')
  await p.keyboard.down('Alt'); await settle()
  ok(await shown(), 'pressing Alt again over b brings it back without a move')
  const top = await p.locator('.ed-topbar').boundingBox()
  await hover({ x: top.x + top.width / 2, y: top.y + top.height / 2 })
  ok(!(await shown()), 'leaving the canvas clears it')
  await hover(await centre('b'))
  await p.keyboard.press('Escape'); await settle()
  ok(await selected() === '' && !(await shown()), 'Escape clears the selection and the overlay')
  await p.keyboard.up('Alt')

  // 4. two zoom levels, same numbers
  await p.mouse.click(pa.x, pa.y); await p.waitForTimeout(200)
  for (const zoomIn of [false, true]) {
    if (zoomIn) {
      await p.locator('.ed-zoombtn', { hasText: '+' }).click()
      await p.locator('.ed-zoombtn', { hasText: '+' }).click()
      await p.waitForTimeout(300)
    }
    const zl = await p.locator('.ed-zoomlabel').textContent()
    await p.keyboard.down('Alt')
    await hover(await centre('b'))
    ok(await labels() === '20 30 100', `at ${zl}: side by side still 100 / 30 / 20 (${await labels()})`)
    const fs = await p.$eval('.ed-measure-label', (l) => l.getBoundingClientRect().height)
    ok(fs > 12 && fs < 22, `at ${zl}: the label stays screen-sized (${fs.toFixed(1)}px tall)`)
    if (zoomIn) await shot('zoomed')
    await p.keyboard.up('Alt'); await settle()
  }
  await p.locator('.ed-zoomlabel').click(); await p.waitForTimeout(300)

  // 5. inspection only
  ok(await p.evaluate(() => JSON.stringify(window.bento.doc)) === loaded, 'the doc JSON is identical after all that measuring')
  await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(200)
  ok(await p.evaluate(() => JSON.stringify(window.bento.doc)) === before, 'one undo takes back the load — measuring pushed nothing')
  await p.evaluate(() => window.bento.redo()); await p.waitForTimeout(300)
  ok(await p.evaluate(() => JSON.stringify(window.bento.doc)) === loaded, '...and redo restores it')

  // 6. Alt-click still digs; a plain drag still moves (and hides the overlay while pressed)
  await p.keyboard.press('Escape')
  const pa2 = await centre('a')
  await p.mouse.click(pa2.x, pa2.y); await p.waitForTimeout(200)
  const pb = await centre('b')
  await p.keyboard.down('Alt')
  await hover(pb)
  ok(await shown(), 'Alt over b measures')
  await p.mouse.down(); await settle()
  ok(!(await shown()), 'a press clears it')
  await p.mouse.up(); await p.keyboard.up('Alt'); await p.waitForTimeout(200)
  ok(await selected() === 'b', 'Alt-click still selects the element under the pointer')
  const x0 = await p.evaluate(() => window.bento.doc.slides[0].elements.find((e) => e.id === 'b').x)
  await p.mouse.move(pb.x, pb.y); await p.mouse.down(); await p.mouse.move(pb.x + 60, pb.y + 3, { steps: 8 })
  await p.keyboard.down('Alt'); await p.mouse.move(pb.x + 80, pb.y + 3, { steps: 3 }); await settle()
  ok(!(await shown()), 'Alt pressed mid-drag shows nothing')
  await p.mouse.up(); await p.keyboard.up('Alt'); await p.waitForTimeout(250)
  const x1 = await p.evaluate(() => window.bento.doc.slides[0].elements.find((e) => e.id === 'b').x)
  ok(x1 > x0 + 30, `a plain drag still moves the element (${x0} → ${x1})`)

  // 8. full-bleed element
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    const { width, height } = d.size
    const r = (id, x, y, w, h, fill) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, rotation: 0, opacity: 1, fill })
    d.slides = [{ id: 's1', background: '#ffffff', elements: [r('bleed', 0, 0, width, height, '#eeeeee'), r('a', 100, 100, 200, 100, '#5E7699'), r('b', 400, 130, 100, 50, '#E8A87C')] }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)
  await p.keyboard.press('Escape')
  await p.mouse.click((await centre('a')).x, (await centre('a')).y); await p.waitForTimeout(200)
  await p.keyboard.down('Alt')
  await hover({ x: sb.x + sb.width * 0.6, y: sb.y + sb.height * 0.6 })
  ok(await shown() && await p.locator('.ed-measure-target').count() === 1, 'a full-bleed element is outlined as the target, not taken for the slide')
  await p.keyboard.up('Alt'); await settle()

  // 9. after a native drag-and-drop in the layer list
  await p.locator('.ed-side-tabs [data-view="layers"]').click(); await p.waitForTimeout(200)
  await p.mouse.click((await centre('a')).x, (await centre('a')).y); await p.waitForTimeout(200)
  const layerRows = p.locator('.ed-side-layers .ed-layer')
  await layerRows.nth(2).dragTo(layerRows.nth(1)); await p.waitForTimeout(250)
  ok(await selected() === 'a', 'precondition: a layer row was dragged, a still selected')
  await hover(await centre('b'))
  await p.keyboard.down('Alt')
  await p.mouse.move((await centre('b')).x + 2, (await centre('b')).y); await settle()
  ok(await shown(), 'Alt-hover still measures after a native drag-and-drop')

  // 10. the Alt release
  await p.evaluate(() => {
    window.__altUp = []
    window.addEventListener('keyup', (e) => { if (e.key === 'Alt') window.__altUp.push(e.defaultPrevented) })
  })
  await p.keyboard.up('Alt'); await settle()
  await hover({ x: top.x + top.width / 2, y: top.y + top.height / 2 })
  await p.keyboard.down('Alt'); await p.keyboard.up('Alt'); await settle()
  ok(JSON.stringify(await p.evaluate(() => window.__altUp)) === '[true,false]', `Alt released over the canvas is swallowed, over the topbar it is not (${JSON.stringify(await p.evaluate(() => window.__altUp))})`)

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
