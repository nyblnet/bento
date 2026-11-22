// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Fill, Stroke, Shadow and Blur, Figma's way: ⠿ and + on the header, each
// paint a row with 👁 and −.
//
//   npm run build:single --prefix slides && node scripts/test-slides-figma-paint-browser.mjs
//
// WHAT THIS PROVES: each paint section heads with Figma's ⠿ catalog (the
// deck's theme colours and tokens, with Manage tokens) and +; a field carries
// no picker button of its own any more; one click on 👁 hides a fill, a stack
// layer, a stroke, a shadow and a blur — kept in the model (fillHidden … or a
// layer's hidden), gone from the canvas — and one undo brings it back; − removes;
// the 👁/− column and the header's ⠿/+ share one right edge in every section.
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const SHELL = process.env.SHELL_HTML || fileURLToPath(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url))

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const run = async (fn) => { try { await fn() } catch (e) { ok(false, `threw: ${String(e.message).split('\n')[0]}`) } }

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1'); localStorage.setItem('bento-panel-tab', '"format"') } catch {} })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-props .ed-tabs'))
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: [
      { id: 'r', type: 'shape', shape: 'rect', x: 100, y: 100, w: 200, h: 100, rotation: 0, opacity: 1, fill: '#ff0000', stroke: '#0000ff', strokeWidth: 4, radius: 0, shadow: { x: 0, y: 4, blur: 8, color: 'rgba(0,0,0,0.3)' }, blur: 2 },
      { id: 'k', type: 'shape', shape: 'rect', x: 400, y: 100, w: 200, h: 100, rotation: 0, opacity: 1, fill: '#00ff00', stroke: 'transparent', strokeWidth: 0, radius: 0, fills: [{ color: '#00ff00' }, { color: 'rgba(0,0,255,0.5)' }] },
    ] }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(300)
  const select = async (id) => { await p.evaluate((id) => document.querySelector(`.ed-layer[data-id="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true })), id); await p.waitForTimeout(300) }
  const el = (id) => p.evaluate((id) => JSON.parse(JSON.stringify(window.bento.doc.slides[0].elements.find((e) => e.id === id))), id)
  const undo = async () => { await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(250) }
  const body = (key) => `.ed-props .ed-section[data-key="${key}"] + .ed-section-body`
  const node = (id) => `.ed-stage-scale [data-el-id="${id}"]`
  await select('r')

  console.log('\nheaders: ⠿ and +\n')
  await run(async () => {
    const heads = await p.evaluate(() => ['Fill', 'Stroke', 'Shadow', 'Blur'].map((k) => {
      const h = [...document.querySelectorAll('.ed-props .ed-section')].find((x) => x.dataset.key === k)
      return { k, cat: !!h?.querySelector('.ed-sec-cat') }
    }))
    ok(heads.every((h) => h.cat), `Fill, Stroke, Shadow and Blur head with the ⠿ catalog (${heads.map((h) => `${h.k}:${h.cat}`).join(' ')})`)
    ok(await p.$$eval(`${body('Fill')} .ed-color-open, ${body('Stroke')} .ed-color-open`, (bs) => bs.every((b) => b.offsetParent === null)), 'the fields carry no picker button of their own — the ⠿ is the one entry point')
    await p.click('.ed-props .ed-section[data-key="Fill"] .ed-sec-cat'); await p.waitForTimeout(250)
    ok(await p.locator('.ed-tokpick').count() === 1, 'Fill’s ⠿ opens the colours & tokens picker')
    const manage = p.locator('.ed-tokpick :text("Manage tokens")')
    ok(await manage.count() === 1, 'its foot offers Manage tokens')
    await manage.click(); await p.waitForTimeout(300)
    ok(await p.evaluate(() => document.querySelector('.ed-side-tabs [data-view="tokens"]')?.getAttribute('aria-selected') === 'true'), 'Manage tokens opens the Tokens view')
    await p.keyboard.press('Escape')
    await p.evaluate(() => document.querySelector('.ed-side-tabs [data-view="layers"]')?.click())
    await select('r')
  })

  console.log('\n👁 hides, kept; one undo brings it back\n')
  await run(async () => {
    const eye = async (key) => { await p.click(`${body(key)} .ed-paintrow .ed-paint-eye >> nth=0`); await p.waitForTimeout(300) }
    await eye('Fill')
    let r = await el('r')
    const fillDrawn = () => p.$eval(`${node('r')} svg rect, ${node('r')} svg path`, (n) => getComputedStyle(n).fill)
    ok(r.fillHidden === true && r.fill === '#ff0000', `a fill hides and its colour is kept (fillHidden ${r.fillHidden}, fill ${r.fill})`)
    ok(/transparent|rgba\(0, 0, 0, 0\)|none/.test(await fillDrawn()), `…and the canvas stops drawing it (${await fillDrawn()})`)
    await undo(); r = await el('r')
    ok(!r.fillHidden, 'one undo shows it again')
    await select('r'); await eye('Stroke'); r = await el('r')
    ok(r.strokeHidden === true && r.strokeWidth === 4, 'a stroke hides, its width kept')
    await undo(); await select('r'); await eye('Shadow'); r = await el('r')
    ok(r.shadowHidden === true && !!r.shadow, 'a shadow hides, kept')
    ok(await p.$eval(node('r'), (n) => !/drop-shadow/.test(getComputedStyle(n).filter)), '…and the canvas drops it')
    await undo(); await select('r'); await eye('Blur'); r = await el('r')
    ok(r.blurHidden === true && r.blur === 2, 'a blur hides, kept')
    await undo()
    await select('k')
    await p.click(`${body('Fill')} .ed-paintrow .ed-paint-eye >> nth=0`); await p.waitForTimeout(300)
    const k = await el('k')
    ok(k.fills?.some((f) => f.hidden), 'a stack layer’s 👁 hides that layer')
    await undo()
  })

  console.log('\n− removes; + adds\n')
  await run(async () => {
    await select('r')
    await p.click(`${body('Blur')} .ed-paintrow .ed-paint-remove`); await p.waitForTimeout(300)
    ok(!(await el('r')).blur, 'a blur’s − removes it')
    await undo(); await select('r')
    await p.click(`${body('Fill')} .ed-paintrow .ed-paint-remove`); await p.waitForTimeout(300)
    ok((await el('r')).fill === 'transparent', 'a fill’s − removes it')
    await p.click('.ed-props .ed-section[data-key="Fill"] .ed-sec-act:not(.ed-sec-cat)'); await p.waitForTimeout(300)
    ok((await el('r')).fill !== 'transparent', 'the header’s + gives the fill back')
  })

  console.log('\none column\n')
  await run(async () => {
    await select('r')
    const g = await p.evaluate(() => {
      const eyes = [...document.querySelectorAll('.ed-props .ed-paint-eye')].map((b) => Math.round(b.getBoundingClientRect().right))
      const rem = [...document.querySelectorAll('.ed-props .ed-paint-remove')].map((b) => Math.round(b.getBoundingClientRect().right))
      const cats = [...document.querySelectorAll('.ed-props .ed-sec-cat')].map((b) => Math.round(b.getBoundingClientRect().right))
      const plus = [...document.querySelectorAll('.ed-props .ed-sec-cat + .ed-sec-act')].map((b) => Math.round(b.getBoundingClientRect().right))
      return { eyes: [...new Set(eyes)], rem: [...new Set(rem)], cats: [...new Set(cats)], plus: [...new Set(plus)] }
    })
    ok(g.eyes.length === 1 && g.rem.length === 1, `👁 and − sit in one column in every section (${g.eyes} / ${g.rem})`)
    ok(g.cats.length === 1 && Math.abs(g.cats[0] - g.eyes[0]) <= 1 && (!g.plus.length || Math.abs(g.plus[0] - g.rem[0]) <= 1), `the header’s ⠿ sits over 👁 and + over − (${g.cats}/${g.eyes}, ${g.plus}/${g.rem})`)
  })
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
