// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Vector booleans in the editor: the contextual bar, one undo step, the
// operation switch, Release and Flatten — end to end in the built shell.
//
//   npm run build:single --prefix slides && node scripts/test-slides-booleans-browser.mjs
//
// WHAT THIS PROVES.
//   1. The topbar's boolean group is absent until two closed shapes are
//      selected, and absent again for a shape + a text box.
//   2. Subtract replaces both operands with ONE path in the bottom operand's
//      stack slot, painted with its fill, with `bool` kept — and the canvas
//      draws it (a real <path>, with the hole: the centre pixel is the slide).
//   3. ⌘Z restores both operands exactly; ⇧⌘Z brings the result back.
//   4. The inspector's operation switch recomputes (union covers the hole).
//   5. Release gives back the operands, where the result stands after a move.
//   6. Flatten keeps the outline and drops the operands.
//   7. ⌥⇧I by keyboard; a saved deck survives load (the sanitizer keeps `bool`).
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
  const load = (els) => p.evaluate((els) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', notes: '', transition: 'none', elements: els }]
    window.bento.loadDoc(JSON.stringify(d))
  }, els)
  const shape = (id, x, y, w, h, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, rotation: 0, opacity: 1, fill: '#5E7699', stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })
  const els = () => p.evaluate(() => window.bento.doc.slides[0].elements)
  const ids = async () => (await els()).map((e) => e.id).join(' ')
  // select as a user does: click the first, Shift-click the rest — near a
  // corner, because the donut's middle is the hole's
  const select = async (list) => {
    // a plain click inside a multi-selection's box would drag that selection
    await p.keyboard.press('Escape'); await p.waitForTimeout(100)
    for (const [i, id] of list.entries()) {
      const b = await p.locator(`.ed-stage-scale [data-el-id="${id}"]`).boundingBox()
      const at = id === 'hole' || id === 'tx' ? [b.width / 2, b.height / 2] : [Math.min(10, b.width / 4), Math.min(10, b.height / 4)]
      if (i) await p.keyboard.down('Shift')
      await p.mouse.click(b.x + at[0], b.y + at[1]); await p.waitForTimeout(150)
      if (i) await p.keyboard.up('Shift')
    }
    await p.waitForTimeout(150)
  }
  const barShown = () => p.evaluate(() => { const b = document.querySelector('.ed-topbar .ed-bool'); return !!b && !b.hidden && b.getBoundingClientRect().width > 0 })

  await load([shape('under', 20, 20, 60, 60, { fill: '#cccccc' }), shape('donut', 200, 200, 300, 300, { fill: '#ff0000' }), shape('hole', 300, 300, 100, 100, { shape: 'ellipse', fill: '#00ff00' }), { id: 'tx', type: 'text', html: 'hi', x: 600, y: 600, w: 100, h: 40, rotation: 0, opacity: 1, fontSize: 20, fontFamily: 'system-ui', fontWeight: 400, color: '#000' }])
  await p.waitForTimeout(400)

  console.log('\nthe contextual bar\n')
  await select(['donut']); await p.waitForTimeout(150)
  ok(!(await barShown()), 'one shape: no boolean group')
  await select(['donut', 'tx']); await p.waitForTimeout(150)
  ok(!(await barShown()), 'a shape and a text box: no boolean group')
  await select(['hole', 'donut']); await p.waitForTimeout(150)
  const both = await p.evaluate(() => window.bento.selection.slice().sort().join())
  ok(both === 'donut,hole', `both shapes selected (${both})`)
  ok(await barShown(), 'two closed shapes: the group is there')

  console.log('\nsubtract\n')
  await p.click('.ed-topbar .ed-bool [data-bool="subtract"]'); await p.waitForTimeout(300)
  const after = await els()
  const res = after.find((e) => e.bool)
  ok(after.length === 3 && !!res, `the operands became one element (${await ids()})`)
  ok(after[1] === undefined ? false : after[1].id === res?.id, 'it sits in the bottom operand\'s slot (above "under")')
  ok(res?.shape === 'path' && res.fill === '#ff0000' && res.bool.op === 'subtract' && res.bool.shapes.map((s) => s.id).join() === 'donut,hole',
    'a path, painted like the bottom operand, keeping both operands bottom first')
  ok(res && Math.round(res.x) === 200 && Math.round(res.w) === 300, `framed on the bottom shape (x ${res?.x}, w ${res?.w})`)
  ok(await p.evaluate(() => window.bento.selection.length === 1), 'the result is selected')
  const drawn = await p.evaluate((id) => !!document.querySelector(`.ed-stage-scale [data-el-id="${id}"] path`), res?.id)
  ok(drawn, 'the canvas draws it as a <path>')
  const centreIsHole = await p.evaluate((id) => {
    const el = document.querySelector(`.ed-stage-scale [data-el-id="${id}"]`)
    const r = el.getBoundingClientRect()
    const hit = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    const corner = document.elementsFromPoint(r.x + 8, r.y + 8)
    return { centre: hit.some((h) => h.closest?.(`[data-el-id="${id}"]`) && h.tagName === 'path'), corner: corner.some((h) => h.tagName === 'path' && h.closest?.(`[data-el-id="${id}"]`)) }
  }, res?.id)
  ok(!centreIsHole.centre && centreIsHole.corner, 'the hole is a hole: the centre misses the path, a corner hits it')

  console.log('\nundo / redo\n')
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250)
  ok(await ids() === 'under donut hole tx', `one ⌘Z gives both operands back (${await ids()})`)
  await p.keyboard.press(`${MOD}+Shift+z`); await p.waitForTimeout(250)
  ok((await els()).some((e) => e.bool), '⇧⌘Z brings the result back')

  console.log('\nthe operation switch\n')
  const boolId = (await els()).find((e) => e.bool).id
  await select([boolId]); await p.waitForTimeout(250)
  const seg = p.locator('.ed-props .ed-bool-ops [role=radio]')
  ok(await seg.count() === 4, 'the inspector offers the four operations')
  await seg.nth(0).click(); await p.waitForTimeout(250)
  const u = (await els()).find((e) => e.id === boolId)
  ok(u?.bool.op === 'union' && !/M[^M]*M/.test(u.d), 'switching to union recomputes: one contour, the hole filled')

  console.log('\nrelease after a move\n')
  // move it through its X field, as an author would
  const xField = p.locator('.ed-props .ed-layer-block .ed-mini', { hasText: /^X$/ }).locator('input')
  await xField.fill('300'); await xField.press('Enter'); await p.waitForTimeout(250)
  ok(Math.round((await els()).find((e) => e.id === boolId).x) === 300, 'moved the result to x 300')
  await select([boolId]); await p.waitForTimeout(200)
  await p.click('.ed-props button:has-text("Release shapes")'); await p.waitForTimeout(250)
  const rel = await els()
  ok(rel.map((e) => e.id).join(' ') === 'under donut hole tx', `Release restores the operands in the slot (${rel.map((e) => e.id).join(' ')})`)
  ok(Math.round(rel[1].x) === 300 && Math.round(rel[2].x) === 400, `…moved with the result (donut x ${rel[1].x}, hole x ${rel[2].x})`)
  ok(rel[2].shape === 'ellipse' && rel[2].fill === '#00ff00', 'each operand keeps its own kind and paint')

  console.log('\nkeyboard and flatten\n')
  await select(['donut', 'hole']); await p.waitForTimeout(200)
  await p.keyboard.press('Alt+Shift+KeyI'); await p.waitForTimeout(250)
  const inter = (await els()).find((e) => e.bool)
  ok(inter?.bool.op === 'intersect' && Math.round(inter.w) === 100, `⌥⇧I intersects (w ${inter?.w})`)
  await select([inter.id]); await p.waitForTimeout(200)
  await p.click('.ed-props button:has-text("Flatten")'); await p.waitForTimeout(250)
  const flat = (await els()).find((e) => e.id === inter.id)
  ok(flat && !flat.bool && flat.shape === 'path' && flat.d === inter.d, 'Flatten keeps the outline and forgets the operands')

  console.log('\nthe format\n')
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(200)
  const json = await p.evaluate(() => JSON.stringify(window.bento.doc))
  await p.evaluate((j) => window.bento.loadDoc(j), json); await p.waitForTimeout(300)
  ok((await els()).find((e) => e.bool)?.bool.shapes.length === 2, 'a reload keeps `bool` (the sanitizer knows it)')
  ok(errors.length === 0, `no page error${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
