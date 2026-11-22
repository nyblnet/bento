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
// clips an overflowing child on the canvas; deleting the frame deletes its
// children with it (a frame and its contents are one unit); undoing back
// past ⇧A restores the slide exactly. Cards built of loose shapes (a rect
// with texts lying on it) stay whole: marquee + ⇧A makes each rect its card's
// column frame and lays the cards out in a row with the spacing they had, one
// undo step; ⇧A on one such card makes its rect the frame.
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
  // the gap is the spacing they had (140 between each), not a stock value
  ok(f && f.layout.gap === 140, `the gap is the spacing they had (${f?.layout.gap})`)
  ok(f && at(list, 'a').x === f.x + 16 && at(list, 'b').x === at(list, 'a').x + 160 + 140 && at(list, 'a').y === f.y + 16, 'the children are laid out: padding then gap')
  ok(f && f.w === 16 * 2 + 160 * 3 + 140 * 2, 'the frame hugs them')
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
  await p.evaluate(() => document.activeElement?.blur()) // the gap field had focus
  await p.keyboard.press('Delete'); await p.waitForTimeout(200)
  list = await els()
  ok(!at(list, f.id) && !at(list, 'b') && !list.length, 'deleting the frame deletes what is in it (Figma); Remove auto layout is how to unwrap')
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
  console.log('\nchildren follow a dragged frame live\n')
  {
    await p.evaluate((els) => {
      const d = JSON.parse(JSON.stringify(window.bento.doc))
      d.slides = [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: els }]
      window.bento.loadDoc(JSON.stringify(d))
    }, [box('g', 100, 100, { w: 900, h: 300, layout: { dir: 'row', gap: 0, pad: [20, 0, 0, 0] } }), box('k', 100, 120, { parentId: 'g' })])
    await p.waitForTimeout(400)
    const gb = await p.locator('.ed-stage-scale [data-el-id="g"]').boundingBox()
    // an empty stretch of the frame, away from its child
    const x0 = gb.x + gb.width * 0.7, y0 = gb.y + gb.height * 0.6
    await p.mouse.click(x0, y0); await p.waitForTimeout(200)
    await p.mouse.move(x0, y0); await p.mouse.down()
    for (let i = 1; i <= 8; i++) await p.mouse.move(x0 + i * 10, y0 + i * 5)
    const mid = await p.evaluate(() => {
      const q = (id) => document.querySelector(`.ed-stage-scale [data-el-id="${id}"]`)
      const band = document.querySelector('.ed-stage-scale .ed-frame-band[data-axis="y"]')
      return { gx: parseFloat(q('g').style.left), gy: parseFloat(q('g').style.top), kx: parseFloat(q('k').style.left), ky: parseFloat(q('k').style.top),
        bx: band ? parseFloat(band.style.left) : NaN, by: band ? parseFloat(band.style.top) : NaN }
    })
    ok(Math.abs(mid.bx - mid.gx) < 0.01 && Math.abs(mid.by - mid.gy) < 0.01, `mid-drag, the padding band moves with the frame (band ${mid.bx},${mid.by})`)
    ok(mid.gx !== 100 && Math.abs(mid.kx - mid.gx) < 0.01 && Math.abs(mid.ky - mid.gy - 20) < 0.01, `mid-drag, the child is already where the frame will put it (frame ${mid.gx},${mid.gy}; child ${mid.kx},${mid.ky})`)
    await p.mouse.up(); await p.waitForTimeout(200)
    const after = await els()
    ok(at(after, 'k').x === at(after, 'g').x && at(after, 'g').x !== 100, 'on release the layout lands it there in the model')
  }

  console.log('\nmarquee + ⇧A keeps loose-shape cards whole\n')
  {
    // three cards built loose: a rounded rect with a title and a body lying on it
    const txt = (id, x, y, w, h, html) => ({ id, type: 'text', x, y, w, h, rotation: 0, opacity: 1, html, fontSize: 18, fontFamily: 'system-ui', fontWeight: 400, color: '#111111', align: 'left', valign: 'top', lineHeight: 1.2 })
    const looseCard = (n, x) => [
      box(`c${n}`, x, 200, { w: 200, h: 240, radius: 16, fill: '#E8EEF6' }),
      txt(`t${n}`, x + 20, 220, 160, 40, `Title ${n}`),
      txt(`b${n}`, x + 20, 280, 160, 100, `Body ${n}`),
    ]
    await p.evaluate((els) => {
      const d = JSON.parse(JSON.stringify(window.bento.doc))
      d.slides = [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: els }]
      window.bento.loadDoc(JSON.stringify(d))
    }, [...looseCard(1, 100), ...looseCard(2, 400), ...looseCard(3, 700)])
    await p.waitForTimeout(400)
    const start = JSON.stringify(await els())
    const toClient = (x, y) => p.evaluate(([x, y]) => { const r = document.querySelector('.ed-stage-scale').getBoundingClientRect(); const k = r.width / window.bento.doc.size.width; return [r.left + x * k, r.top + y * k] }, [x, y])
    await p.keyboard.press('Escape'); await p.waitForTimeout(100)
    const [ax, ay] = await toClient(60, 150), [bx, by] = await toClient(960, 500)
    await p.mouse.move(ax, ay); await p.mouse.down()
    for (let i = 1; i <= 12; i++) await p.mouse.move(ax + (bx - ax) * i / 12, ay + (by - ay) * i / 12)
    await p.mouse.up(); await p.waitForTimeout(250)
    ok((await p.evaluate(() => window.bento.selection.length)) === 9, `the marquee takes all nine loose elements (${await p.evaluate(() => window.bento.selection.length)})`)
    await p.keyboard.press('Shift+A'); await p.waitForTimeout(300)
    let list = await els()
    const row = list.find((e) => e.layout && !e.id.startsWith('c'))
    ok(!!row && row.layout.dir === 'row', 'one new frame, a row')
    ok(row && ['c1', 'c2', 'c3'].every((id) => at(list, id).parentId === row.id) && list.filter((e) => e.parentId === row.id).length === 3, `the row holds the three cards, not nine elements (${list.filter((e) => e.parentId === row?.id).map((e) => e.id).join(',')})`)
    ok(['c1', 'c2', 'c3'].every((id) => at(list, id).layout?.dir === 'col'), 'each rect became its card\'s column frame (its paint kept)')
    ok([1, 2, 3].every((n) => at(list, `t${n}`).parentId === `c${n}` && at(list, `b${n}`).parentId === `c${n}`), 'each card holds its own title and body')
    ok(row?.layout.gap === 100 && at(list, 'c2').x - (at(list, 'c1').x + at(list, 'c1').w) === 100, `the cards keep the spacing they had (gap ${row?.layout.gap})`)
    const c1 = at(list, 'c1'), t1 = at(list, 't1'), b1 = at(list, 'b1')
    ok(t1.x - c1.x === 20 && t1.y - c1.y === 20 && b1.y - (t1.y + t1.h) === 20 && Math.abs(c1.w - 200) < 1 && Math.abs(c1.h - 240) < 2, `a card keeps its look: title and body where they sat on it (card ${c1.w}×${c1.h}, title +${t1.x - c1.x},+${t1.y - c1.y})`)
    ok(await p.evaluate(() => window.bento.selection.join()) === row?.id, 'the row is selected')
    await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(200)
    ok(JSON.stringify(await els()) === start, 'one ⌘Z gives the nine loose elements back exactly')

    // one card alone: the rect is the frame, nothing is wrapped round it
    const row1 = async (id, add) => { await p.evaluate(([id, add]) => document.querySelector(`.ed-layer[data-id="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: add })), [id, add]); await p.waitForTimeout(150) }
    await row1('c1', false); await row1('t1', true); await row1('b1', true)
    ok((await p.evaluate(() => window.bento.selection.slice().sort().join())) === 'b1,c1,t1', 'one card picked from Layers')
    await p.keyboard.press('Shift+A'); await p.waitForTimeout(300)
    list = await els()
    ok(list.filter((e) => e.layout).map((e) => e.id).join() === 'c1' && at(list, 't1').parentId === 'c1' && at(list, 'b1').parentId === 'c1', `⇧A on one loose card makes its rect the card frame (${list.filter((e) => e.layout).map((e) => e.id).join()})`)
    ok(await p.evaluate(() => window.bento.selection.join()) === 'c1', 'and selects it')
  }
  ok(!errors.length, `no page error${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
