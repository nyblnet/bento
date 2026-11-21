// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// One tool pressed at a time, and a Select-only tool that never moves anything.
//
//   npm run build:single --prefix slides && node scripts/test-slides-select-tool-browser.mjs
//
// WHAT THIS PROVES:
//   1. The topbar shows exactly one pressed tool: V (Move) at rest; R arms and
//      presses R, V lets go; Esc puts V back.
//   2. S (Select only) — the user's ask: a drag that starts ON an element draws
//      a selection box and moves NOTHING (the model's x/y unchanged), selecting
//      what the box holds; a click selects; Shift-drag adds; it stays on across
//      selections; ⌘K offers it; Esc deselects, then returns to V.
//   3. In V, a drag on empty slide space marquees; a drag on an element moves it.
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const SHELL = process.env.SHELL_HTML || fileURLToPath(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url))

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const rect = (id, x, y) => ({ id, type: 'shape', shape: 'rect', x, y, w: 160, h: 100, rotation: 0, opacity: 1, fill: '#e74c3c', stroke: 'transparent', strokeWidth: 0, radius: 0 })

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1') } catch {} })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale'))
  // a full-bleed backdrop (the case that made every drag a move) and three cards on it
  await p.evaluate((els) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: els }]
    window.bento.loadDoc(JSON.stringify(d))
  }, [{ ...rect('bg', 0, 0), w: 1280, h: 720, fill: '#f2f2f2' }, rect('a', 200, 200), rect('b', 420, 200), rect('c', 640, 200)])
  await p.waitForTimeout(400)
  const at = (x, y) => p.evaluate(([x, y]) => { const r = document.querySelector('.ed-stage-scale').getBoundingClientRect(); const k = r.width / window.bento.doc.size.width; return [r.left + x * k, r.top + y * k] }, [x, y])
  const pressed = () => p.$$eval('.ed-topbar [aria-pressed="true"]', (bs) => bs.map((b) => b.dataset.cmd || b.className))
  const pos = (id) => p.evaluate((id) => { const e = window.bento.doc.slides[0].elements.find((x) => x.id === id); return `${e.x},${e.y}` }, id)
  const sel = () => p.evaluate(() => window.bento.selection)
  const drag = async (x0, y0, x1, y1, shift = false) => {
    const [a, b] = await at(x0, y0); const [c, d] = await at(x1, y1)
    if (shift) await p.keyboard.down('Shift')
    await p.mouse.move(a, b); await p.mouse.down(); await p.mouse.move((a + c) / 2, (b + d) / 2, { steps: 4 }); await p.mouse.move(c, d, { steps: 6 }); await p.mouse.up()
    if (shift) await p.keyboard.up('Shift')
    await p.waitForTimeout(350)
  }
  const clickAt = async (x, y) => { const [a, b] = await at(x, y); await p.mouse.click(a, b); await p.waitForTimeout(300) }

  console.log('\none tool pressed at a time\n')
  ok(JSON.stringify(await pressed()) === '["tool-select"]', `V (Move) is pressed at rest (${await pressed()})`)
  await p.keyboard.press('r'); await p.waitForTimeout(200)
  const r = await pressed()
  ok(r.includes('tool-rect') && !r.includes('tool-select'), `R arms and is pressed; V lets go (${r})`)
  await p.keyboard.press('Escape'); await p.waitForTimeout(200)
  ok(JSON.stringify(await pressed()) === '["tool-select"]', `Esc stands R down and V is pressed again (${await pressed()})`)

  console.log('\nS: select only\n')
  await p.keyboard.press('s'); await p.waitForTimeout(200)
  ok(JSON.stringify(await pressed()) === '["tool-marquee"]', `S presses the Select-only tool (${await pressed()})`)
  const before = [await pos('bg'), await pos('a'), await pos('b'), await pos('c')].join(' ')
  // starts ON card a (and on the backdrop), sweeps over a and b
  await drag(190, 190, 600, 320)
  const after = [await pos('bg'), await pos('a'), await pos('b'), await pos('c')].join(' ')
  ok(after === before, `a drag that starts on an element moves nothing (${before} → ${after})`)
  const s1 = (await sel()).sort().join(',')
  ok(s1 === 'a,b', `…and selects what the box holds (${s1})`)
  await clickAt(700, 250)
  ok((await sel()).join(',') === 'c', `a click selects the element under the pointer (${(await sel()).join(',')})`)
  await drag(190, 190, 380, 320, true)
  const s2 = (await sel()).sort().join(',')
  ok(s2 === 'a,c', `Shift-drag adds to the selection (${s2})`)
  ok(JSON.stringify(await pressed()) === '["tool-marquee"]', 'the tool stays on across selections')
  ok([await pos('a'), await pos('b'), await pos('c')].join(' ') === before.split(' ').slice(1).join(' '), 'still nothing moved')
  await p.keyboard.press('Escape'); await p.waitForTimeout(150)
  ok((await sel()).length === 0 && JSON.stringify(await pressed()) === '["tool-marquee"]', 'Esc first lets go of the selection, the tool stays')
  await p.keyboard.press('Escape'); await p.waitForTimeout(150)
  ok(JSON.stringify(await pressed()) === '["tool-select"]', 'a second Esc returns to Move (V)')

  console.log('\n⌘K and the button\n')
  await p.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k'); await p.waitForTimeout(250)
  await p.keyboard.type('select only'); await p.waitForTimeout(200)
  await p.keyboard.press('Enter'); await p.waitForTimeout(250)
  ok(JSON.stringify(await pressed()) === '["tool-marquee"]', '⌘K "select only" turns it on')
  const btn = await p.$eval('.ed-topbar [data-cmd="tool-marquee"]', (b) => ({ label: b.getAttribute('aria-label') ?? '', title: b.title ?? '', icon: !!b.querySelector('svg') }))
  ok(btn.icon && /S\b|\(S\)/.test(btn.title + btn.label), `the topbar button carries its icon and its key (${btn.title || btn.label})`)
  await p.click('.ed-topbar [data-cmd="tool-select"]'); await p.waitForTimeout(200)
  ok(JSON.stringify(await pressed()) === '["tool-select"]', 'clicking Move goes back to V')

  console.log('\nV: empty space marquees, an element moves\n')
  // empty space needs a slide without the backdrop
  await p.evaluate(() => { const d = JSON.parse(JSON.stringify(window.bento.doc)); d.slides[0].elements = d.slides[0].elements.filter((e) => e.id !== 'bg'); window.bento.loadDoc(JSON.stringify(d)) })
  await p.waitForTimeout(400)
  const v0 = [await pos('a'), await pos('b')].join(' ')
  await drag(150, 150, 600, 330)
  ok([await pos('a'), await pos('b')].join(' ') === v0 && (await sel()).sort().join(',') === 'a,b', `a drag from empty space marquees and moves nothing (${(await sel()).join(',')})`)
  await clickAt(1000, 600)
  await drag(280, 250, 330, 300)
  ok((await pos('a')) !== '200,200', `a drag on an element moves it (a at ${await pos('a')})`)
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
