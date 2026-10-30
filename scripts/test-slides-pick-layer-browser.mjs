// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Reaching an element under other elements, in the packaged editor, with real input.
//
//   npm run build:single --prefix slides && node scripts/test-slides-pick-layer-browser.mjs
//
// WHAT THIS PROVES:
//   1. Alt-click digs through the painted stack, one element per click, and
//      wraps — even when the element on top is a small label whose resize
//      handles cover its middle (below ~100% zoom, that is every label). The
//      press lands on a handle there; a still Alt-press must dig, and must not
//      resize anything;
//   2. Alt-DRAG on that handle still resizes;
//   3. ⌘-click (Ctrl elsewhere) selects exactly the element under the pointer,
//      even a member of a group, whether or not the group is already
//      selected; a plain click still takes the whole group, and ⌘-DRAG still
//      duplicates;
//   4. right-click over a stack lists every element under the pointer, top
//      first, and picking one selects it;
//   5. ⌘-click and ⌘-drag share one dead zone: a ⌘-press that wobbles 2px
//      (on an unselected group member, or inside the selected group) is a
//      ⌘-click — it selects the member and leaves no copy behind and nothing
//      moved — while a real ⌘-drag of a group leaves copies that form a group
//      of their OWN, not six members of the original;
//   6. an Alt-press on the selection's box that wobbles 2px is still a click:
//      it digs, and leaves no empty undo step behind;
//   7. ⌘-click stands down while the motion-path editor owns the canvas, as
//      Alt-click's dig does.
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

  // Three elements stacked on one point: a large rectangle at the back, an
  // ellipse, and a small text label on top (painted last). A fourth, apart,
  // to ⌘-drag.
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{
      id: 's1', background: '#ffffff', elements: [
        { id: 'back', type: 'shape', shape: 'rect', x: 300, y: 200, w: 600, h: 400, rotation: 0, opacity: 1, fill: '#C9D4E3' },
        { id: 'mid', type: 'shape', shape: 'ellipse', x: 450, y: 300, w: 300, h: 200, rotation: 0, opacity: 1, fill: '#5E7699' },
        { id: 'tiny', type: 'text', x: 575, y: 393, w: 50, h: 14, rotation: 0, opacity: 1, html: 'tiny', fontSize: 10, color: '#1E2A3A' },
        { id: 'apart', type: 'shape', shape: 'rect', x: 950, y: 200, w: 250, h: 150, rotation: 0, opacity: 1, fill: '#E8A87C' },
      ],
    }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)

  const node = (id) => p.locator(`.ed-stage-scale [data-el-id="${id}"]`)
  const centre = async (id) => { const b = await node(id).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
  const selected = () => p.evaluate(() => window.bento.selection.slice().sort().join(','))
  const frame = (id) => p.evaluate((id) => { const e = window.bento.doc.slides[0].elements.find((e) => e.id === id); return e && `${e.x},${e.y},${e.w},${e.h}` }, id)
  const count = () => p.evaluate(() => window.bento.doc.slides[0].elements.length)
  const clickAt = async (pt, mods = []) => {
    for (const m of mods) await p.keyboard.down(m)
    await p.mouse.click(pt.x, pt.y)
    for (const m of mods) await p.keyboard.up(m)
    await p.waitForTimeout(200)
  }
  const deselect = async () => { await p.keyboard.press('Escape'); await p.waitForTimeout(150) }
  const pt = await centre('tiny')

  // 1. Alt-click digs, wraps, and a press on a handle does not resize.
  await deselect()
  await clickAt(pt)
  ok(await selected() === 'tiny', 'a plain click takes the top element')
  const onHandle = await p.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.moveable-control-box'), pt)
  ok(onHandle, 'the precondition holds: with the label selected, its middle is covered by a handle')
  const tinyFrame = await frame('tiny')
  const dug = []
  for (let i = 0; i < 3; i++) { await clickAt(pt, ['Alt']); dug.push(await selected()) }
  ok(dug.join(' > ') === 'mid > back > tiny', `Alt-click digs one deeper per click and wraps (${dug.join(' > ')})`)
  ok(await frame('tiny') === tinyFrame, 'a still Alt-press on a handle resizes nothing')

  // 2. Alt-drag on the handle is still centre-resize.
  await clickAt(pt)
  await p.keyboard.down('Alt')
  await p.mouse.move(pt.x, pt.y); await p.mouse.down(); await p.mouse.move(pt.x, pt.y + 30, { steps: 6 }); await p.mouse.up()
  await p.keyboard.up('Alt')
  await p.waitForTimeout(250)
  ok(await frame('tiny') !== tinyFrame, 'Alt-drag on the handle still resizes')
  ok(await selected() === 'tiny', '...and keeps the selection')
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250)
  ok(await frame('tiny') === tinyFrame, 'one undo puts it back')

  // 3. ⌘-click reaches a group member; a plain click takes the group.
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    for (const e of d.slides[0].elements) if (e.id === 'mid' || e.id === 'tiny') e.groupId = 'g1'
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)
  await deselect()
  await clickAt(pt)
  ok(await selected() === 'mid,tiny', 'a plain click on a grouped label selects the whole group')
  await clickAt(pt, [MOD])
  ok(await selected() === 'tiny', '⌘-click inside the selected group selects just the member under the pointer')
  await deselect()
  await clickAt(pt, [MOD])
  ok(await selected() === 'tiny', '⌘-click with nothing selected selects just the member too')
  const before = await count()
  await deselect()
  const ap = await centre('apart')
  await clickAt(ap)
  await p.keyboard.down(MOD)
  await p.mouse.move(ap.x, ap.y); await p.mouse.down(); await p.mouse.move(ap.x + 80, ap.y, { steps: 8 }); await p.mouse.up()
  await p.keyboard.up(MOD)
  await p.waitForTimeout(300)
  ok(await count() === before + 1, '⌘-drag still leaves a duplicate behind')
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250)

  // 4. Right-click lists the stack, top first, and picks.
  await deselect()
  await p.mouse.click(pt.x, pt.y, { button: 'right' })
  await p.waitForTimeout(250)
  const rows = await p.$$eval('.ed-ctxmenu .ed-ctxmenu-item', (bs) => bs.map((b) => b.querySelector('span')?.textContent ?? ''))
  ok(/^Select tiny \| Select Ellipse \| Select Rectangle( \d+)?$/.test(rows.slice(0, 3).join(' | ')), `the menu opens with the stack, top first (${rows.slice(0, 3).join(' | ')})`)
  const pick = p.locator('.ed-ctxmenu .ed-ctxmenu-item', { hasText: 'Select Rectangle' })
  if (await pick.count()) await pick.click()
  else await p.keyboard.press('Escape')
  await p.waitForTimeout(200)
  ok(await selected() === 'back', 'picking a row selects that element')
  await p.mouse.click((await centre('apart')).x, (await centre('apart')).y, { button: 'right' })
  await p.waitForTimeout(200)
  const lone = await p.$$eval('.ed-ctxmenu .ed-ctxmenu-item', (bs) => bs.some((b) => b.textContent.startsWith('Select ')))
  ok(!lone, 'over a single element the menu has no pick rows')
  await p.keyboard.press('Escape')

  // 5. ⌘ dead zone, and ⌘-drag copies get their own group.
  const loadRow = (bg = '#ffffff') => p.evaluate((bg) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    const box = (id, x, y, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w: 160, h: 100, rotation: 0, opacity: 1, fill: '#5E7699', ...extra })
    d.slides = [{ id: 's1', background: bg, elements: [
      box('a', 100, 120), box('b', 560, 120), box('c', 1020, 120),
      box('g1', 470, 440, { groupId: 'g' }), box('g2', 650, 440, { groupId: 'g' }), box('g3', 830, 440, { groupId: 'g' }),
    ] }]
    window.bento.loadDoc(JSON.stringify(d))
  }, bg).then(() => p.waitForTimeout(400))
  const doc = () => p.evaluate(() => JSON.stringify(window.bento.doc))
  const wobble = async (pt, key, dx = 2) => {
    await p.keyboard.down(key)
    await p.mouse.move(pt.x, pt.y); await p.mouse.down(); await p.mouse.move(pt.x + dx, pt.y, { steps: 2 }); await p.mouse.up()
    await p.keyboard.up(key)
    await p.waitForTimeout(300)
  }
  await loadRow()
  let loaded = await doc()
  await wobble(await centre('g2'), MOD)
  ok(await doc() === loaded, '⌘-press with 2px of wobble on an unselected group member copies and moves nothing')
  ok(await selected() === 'g2', `...and selects just that member (${await selected()})`)
  await deselect()
  await clickAt(await centre('g1'))
  ok(await selected() === 'g1,g2,g3', 'precondition: a plain click selects the whole group')
  await wobble(await centre('g2'), MOD)
  ok(await doc() === loaded, '⌘-press with 2px of wobble inside the selected group copies and moves nothing')
  ok(await selected() === 'g2', `...and narrows to the member under the pointer (${await selected()})`)
  await deselect()
  await clickAt(await centre('g1'))
  await wobble(await centre('g2'), MOD, 80)
  const groups = await p.evaluate(() => window.bento.doc.slides[0].elements.filter((e) => e.groupId).map((e) => `${e.id}:${e.groupId}`))
  const copies = groups.filter((g) => !/^g\d:/.test(g)).map((g) => g.split(':')[1])
  ok(copies.length === 3, `a real ⌘-drag of the group leaves three copies (${groups.join(' ')})`)
  ok(new Set(copies).size === 1 && copies[0] !== 'g', `...which form one group of their own (${copies.join(',')})`)
  ok(groups.filter((g) => g.endsWith(':g')).length === 3, '...and the original group keeps its three members')
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250)

  // 6. Alt wobble on the selection's box digs, with no empty undo step.
  const beforeLoad = await doc()
  await loadRow('#fafafa')
  loaded = await doc()
  await clickAt(await centre('a')); await clickAt(await centre('c'), ['Shift'])
  ok(await selected() === 'a,c', 'precondition: a and c are selected, b sits under their box')
  await wobble(await centre('b'), 'Alt')
  ok(await selected() === 'b', `an Alt-press with 2px of wobble on the box digs to b (${await selected()})`)
  ok(await doc() === loaded, '...and changes nothing')
  await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(250)
  ok(await doc() === beforeLoad, '...and records no undo step: one undo takes back the load itself')
  await p.evaluate(() => window.bento.redo()); await p.waitForTimeout(250)

  // 7. ⌘-click stands down while the motion-path editor is open.
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides[0].elements.find((e) => e.id === 'a').fx = { loop: { type: 'motion-path', path: 'M0,0 L300,0', duration: 6 } }
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)
  await clickAt(await centre('a'))
  const editPath = p.locator('button', { hasText: 'Edit path on canvas' })
  for (const tab of await p.locator('.ed-props .ed-tabs button').all()) {
    if (await editPath.isVisible()) break
    await tab.click(); await p.waitForTimeout(150)
  }
  await editPath.click(); await p.waitForTimeout(250)
  ok(await p.locator('.ed-pathedit').count() === 1, 'precondition: the motion-path editor is open')
  await clickAt(await centre('b'), [MOD])
  ok(await selected() === 'a', `⌘-click on another element leaves the selection alone while editing the path (${await selected()})`)

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
