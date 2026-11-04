// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// #761: a slide can be dragged to the very end of the sidebar list.
//
//   npm run build:single --prefix slides && node scripts/test-slides-sidebar-drop-end-browser.mjs
//
// The drag is driven with real DragEvents carrying one shared DataTransfer
// (dragstart on a thumb, then dragover/drop on the target), like the browser
// does. Controls: a drop on a middle thumb still moves (the path executed),
// and a dragover on a non-slide drag is NOT claimed. Targets: the gap after
// the last thumbnail and the "New slide" button both land the slide last, and a
// parent's states travel with it and are never split from it.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
import { resolve } from 'node:path'

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const file = resolve(process.argv[2] || 'slides/dist-single/Bento_Slides.bento.html')
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto('file://' + file)
  await page.waitForSelector('.ed-thumb', { timeout: 20000 })

  const load = async () => {
    await page.evaluate(() => {
      const d = JSON.parse(JSON.stringify(window.bento.doc))
      const mk = (id, extra = {}) => ({ id, background: '#fff', elements: [], ...extra })
      d.slides = [mk('A'), mk('A-state', { stateOf: 'A' }), mk('B'), mk('C')]
      window.bento.loadDoc(JSON.stringify(d))
    })
    await page.waitForFunction(() => document.querySelectorAll('.ed-thumb').length === 4)
  }
  const order = () => page.evaluate(() => window.bento.doc.slides.map((s) => s.id).join(','))
  // dragstart on thumb `from`, then dragover + drop on the target selector
  const drag = (from, target, kind = 'text/bento-slide') => page.evaluate(([from, target, kind]) => {
    const dt = new DataTransfer()
    const src = document.querySelectorAll('.ed-thumb')[from]
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    if (kind !== 'text/bento-slide') { dt.clearData(); dt.setData(kind, 'x') }
    const t = typeof target === 'number' ? document.querySelectorAll('.ed-thumb')[target] : document.querySelector(target)
    // the sidebar places a drop by the pointer, as a real drag carries it: a
    // thumb's upper part lands before it, a button or gap at its centre
    const r = t.getBoundingClientRect()
    const xy = { clientX: r.left + r.width / 2, clientY: typeof target === 'number' ? r.top + r.height / 4 : r.top + r.height / 2 }
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...xy })
    t.dispatchEvent(over)
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...xy })
    t.dispatchEvent(drop)
    return { overClaimed: over.defaultPrevented }
  }, [from, target, kind])

  await load()
  ok((await order()) === 'A,A-state,B,C', 'fixture: A (with a state), B, C')

  await drag(0, 3) // control: drop on the last thumb puts A (+state) before C
  ok((await order()) === 'B,A,A-state,C', `control: a drop on a thumb still moves the block (${await order()})`)

  await load()
  const lastGap = await page.evaluate(() => { const g = [...document.querySelectorAll('#x,.ed-insertgap')]; return g.length })
  ok(lastGap >= 4, `the list has insert gaps (${lastGap})`)
  const r1 = await drag(0, '.ed-add-slide')
  ok(r1.overClaimed, 'dragover on the New slide button accepts a slide drag (no stop cursor)')
  ok((await order()) === 'B,C,A,A-state', `dropping on the New slide button lands the slide last, state kept with it (${await order()})`)

  await load()
  const gapSel = await page.evaluate(() => {
    const g = [...document.querySelectorAll('.ed-insertgap')]; g.at(-1).id = 'endgap'; return '#endgap'
  })
  const r2 = await drag(2, gapSel)
  ok(r2.overClaimed, 'dragover on the gap after the last thumbnail accepts a slide drag')
  ok((await order()) === 'A,A-state,C,B', `dropping on the end gap lands the slide last (${await order()})`)

  await load()
  const r3 = await drag(0, '.ed-add-slide', 'text/plain')
  ok(!r3.overClaimed && (await order()) === 'A,A-state,B,C', 'a non-slide drag over the button is left alone')
  ok(errs.length === 0, `no page errors (${errs.join('; ')})`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
