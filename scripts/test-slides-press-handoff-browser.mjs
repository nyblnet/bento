// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Pressing an unselected element and dragging: the Selecto -> Moveable handoff.
//
//   npm run build:single --prefix slides && node scripts/test-slides-press-handoff-browser.mjs
//
// WHAT THIS PROVES, in the packaged document with trusted mouse input:
//   1. a press on a full-slide backdrop that drags on produces NO page errors
//      (on main every mouse move threw "Cannot set properties of null
//      (setting 'dist')": Moveable runs its target-change pass twice, the
//      second unset the drag the handoff had just started);
//   2. that drag really moves the pressed element, by the pointer's distance;
//   3. a plain click (press and release in one go) selects without moving it
//      and without errors, so the handoff is still cancelled when the release
//      wins (#260);
//   4. a press on a small element drags that element the same way.
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
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelectorAll('.ed-sidebar .ed-thumb').length > 1)
  await p.waitForTimeout(500)

  const load = async () => {
    await p.evaluate(() => {
      const d = JSON.parse(JSON.stringify(window.bento.doc))
      const mk = (id, x, y, w, h) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, fill: '#88aadd', stroke: 'none', strokeWidth: 0, radius: 0 })
      d.slides = [{ id: 'ph-s1', background: '#ffffff', elements: [mk('bg', 0, 0, 1280, 720), mk('a', 100, 100, 200, 100)] }]
      window.bento.loadDoc(JSON.stringify(d))
    })
    await p.waitForTimeout(600)
    errors.length = 0
  }
  const geom = () => p.evaluate(() => {
    const r = document.querySelector('.ed-stage-scale').getBoundingClientRect()
    return { left: r.left, top: r.top, k: r.width / window.bento.doc.size.width }
  })
  const pos = (id) => p.evaluate((i) => { const e = window.bento.doc.slides[0].elements.find((x) => x.id === i); return [e.x, e.y] }, id)
  const dragFrom = async (sx, sy, dx, dy) => {
    const g = await geom()
    const x = g.left + sx * g.k
    const y = g.top + sy * g.k
    await p.mouse.move(x, y)
    await p.mouse.down()
    await p.mouse.move(x + (dx * g.k) / 2, y + (dy * g.k) / 2, { steps: 4 })
    await p.mouse.move(x + dx * g.k, y + dy * g.k, { steps: 4 })
    await p.mouse.up()
    await p.waitForTimeout(400)
    return g
  }

  console.log('\npress on the backdrop and drag\n')
  await load()
  await dragFrom(700, 400, 100, 60)
  ok(errors.length === 0, `no page errors (${errors.length}${errors[0] ? ': ' + errors[0] : ''})`)
  {
    const [x, y] = await pos('bg')
    ok(Math.abs(x - 100) < 3 && Math.abs(y - 60) < 3, `the backdrop followed the pointer (now ${x}, ${y})`)
  }

  console.log('\na plain click selects without moving\n')
  await load()
  {
    const g = await geom()
    await p.mouse.click(g.left + 700 * g.k, g.top + 400 * g.k)
    await p.waitForTimeout(500)
    await p.mouse.move(g.left + 800 * g.k, g.top + 450 * g.k, { steps: 4 })
    await p.waitForTimeout(300)
    const [x, y] = await pos('bg')
    ok(x === 0 && y === 0, `the click left the backdrop in place (${x}, ${y})`)
    ok(errors.length === 0, `no page errors (${errors.length}${errors[0] ? ': ' + errors[0] : ''})`)
  }

  console.log('\npress on a small element and drag\n')
  await load()
  await dragFrom(150, 130, 200, 150)
  ok(errors.length === 0, `no page errors (${errors.length}${errors[0] ? ': ' + errors[0] : ''})`)
  {
    const [x, y] = await pos('a')
    ok(Math.abs(x - 300) < 3 && Math.abs(y - 250) < 3, `the element followed the pointer (now ${x}, ${y})`)
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
