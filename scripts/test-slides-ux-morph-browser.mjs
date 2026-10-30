// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Building a morph: the UX audit's findings (docs/audit/ux-pyramid-2026-10-30.md §3), each held.
//
//   npm run build:single --prefix slides && node scripts/test-slides-ux-morph-browser.mjs
//   (SHELL_HTML=<older shell> runs the same checks against it)
//
// WHAT THIS PROVES
//   1. One truth for "will this morph": on a slide that fades, a pair that
//      would morph is NOT shown as morphing — the section says the slide uses
//      Fade and offers Use Morph (one undo step); once it morphs, checkbox,
//      layer badge, ghost and status agree.
//   2. Renaming a paired element's morph name renames its partners on the
//      neighbouring slides in one step, so the pair survives; the field shows
//      what was stored; a clash names the element that holds the name.
//   3. The pairing picker lists the slide before first, by Layers names,
//      never machine ids; it filters, and works from the keyboard.
//   4. The Preview shows the whole slide — what leaves fades out, what enters
//      fades in — keeps the released value, puts the slide back when the
//      user moves on, and Tab moves on (not to the page body); a text pair
//      says its words swap at once.
//   5. A duplicated slide whose elements move is offered Morph once; the
//      Play transition command presents from the slide before into this one.
//   6. The New slide button at the bottom of the list adds at the end.
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const SHELL = process.env.SHELL_HTML || fileURLToPath(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url))

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

// machine-looking ids, so "no id on screen" means something
const CARD = 's-mvut1a-9rdmmd', TITLE = 's-mvut2b-4kq1zz', GONE = 's-mvut3c-77xa0p', NEW = 's-mvut4d-p0p0p0'
const rect = (id, x, y, w, h, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, rotation: 0, opacity: 1, fill: '#ff0000', stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })
const text = (id, html, extra = {}) => ({ id, type: 'text', html, x: 100, y: 20, w: 600, h: 60, rotation: 0, opacity: 1, fontSize: 32, fontFamily: 'Inter', fontWeight: 600, color: '#111111', align: 'left', valign: 'top', lineHeight: 1.2, ...extra })
const SLIDES = [
  { id: 'sa', background: '#ffffff', transition: 'none', notes: '', elements: [rect(CARD, 100, 100, 200, 100), text(TITLE, 'Revenue'), rect(GONE, 900, 500, 120, 80, { fill: '#00aa00' })] },
  { id: 'sb', background: '#ffffff', transition: 'fade', notes: '', elements: [rect(CARD, 600, 300, 400, 200), text(TITLE, 'Enterprise'), rect(NEW, 100, 500, 100, 100, { shape: 'ellipse', fill: '#0000ff' })] },
  { id: 'sc', background: '#ffffff', transition: 'morph', notes: '', elements: [rect(CARD, 700, 320, 300, 150)] },
]

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1') } catch {} })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-props .ed-tabs'))
  await p.evaluate((slides) => { const d = JSON.parse(JSON.stringify(window.bento.doc)); d.slides = slides; window.bento.loadDoc(JSON.stringify(d)) }, SLIDES)
  await p.waitForTimeout(300)

  const doc = () => p.evaluate(() => JSON.parse(JSON.stringify(window.bento.doc)))
  const thumb = async (i) => { await p.locator('.ed-sidebar .ed-thumb').nth(i).evaluate((n) => n.click()); await p.waitForTimeout(200) }
  const select = async (id) => { await p.evaluate((id) => document.querySelector(`.ed-layer[data-id="${id}"]`)?.click(), id); await p.waitForTimeout(200) }
  const animate = async () => { await p.locator('.ed-props .ed-tabs [role="tab"]', { hasText: /^Animate$/i }).click(); await p.waitForTimeout(200) }
  const link = () => p.locator('.ed-props label.ed-row:has-text("Morph from the slide before") input')
  const sectionText = () => p.evaluate(() => (document.querySelector('.ed-props')?.innerText ?? '') + ' ' + [...document.querySelectorAll('.ed-props input')].map((i) => i.value).join(' '))
  const undo = async () => { await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(250) }
  const ids = [CARD, TITLE, GONE, NEW]

  console.log('\n1. one truth for "will this morph"\n')
  await thumb(1); await select(CARD); await animate()
  ok(await link().count() === 1 && !(await link().isChecked()), 'on a Fade slide the paired card is not shown as morphing')
  let txt = await sectionText()
  ok(/uses Fade/.test(txt), 'the section says the slide uses Fade')
  const use = p.locator('.ed-props .ed-morph-use')
  ok(await use.count() === 1, 'and offers Use Morph')
  if (await use.count()) {
    await use.click(); await p.waitForTimeout(300)
    ok((await doc()).slides[1].transition === 'morph', 'Use Morph switches the slide to Morph')
    await undo()
    ok((await doc()).slides[1].transition === 'fade', 'one undo puts Fade back')
    await select(CARD); await animate(); await p.locator('.ed-props .ed-morph-use').click(); await p.waitForTimeout(300)
  } else await p.evaluate(() => { window.bento.doc.slides[1].transition = 'morph' })
  await select(CARD); await animate()
  ok(await link().isChecked(), 'once the slide morphs, the checkbox says so')
  ok(await p.locator(`.ed-layer[data-id="${CARD}"] .ed-layer-morph`).count() >= 1, '…and so does the layer badge')
  ok(await p.locator('.ed-stage-scale .ed-morph-ghost').count() === 1, '…and the ghost')
  txt = await sectionText()
  ok(/Pairs with: Slide 1 · Rectangle/.test(txt), `…and the status names the partner by page and Layers name`)
  ok(!ids.some((id) => txt.includes(id)), 'no machine id anywhere in the inspector')

  console.log('\n2. renaming keeps the pair\n')
  const nameField = p.locator('.ed-props label.ed-row:has-text("Morph name") input')
  await nameField.fill('revenue card'); await nameField.press('Enter'); await p.waitForTimeout(300)
  let d = await doc()
  const keyOf = (s, id) => d.slides[s].elements.find((e) => e.id === id)?.morphId
  ok(keyOf(0, CARD) === 'revenue-card' && keyOf(1, CARD) === 'revenue-card' && keyOf(2, CARD) === 'revenue-card',
    `the card and its partners on both neighbouring slides take the name (${keyOf(0, CARD)}, ${keyOf(1, CARD)}, ${keyOf(2, CARD)})`)
  ok(await nameField.inputValue() === 'revenue-card', 'the field shows what was stored')
  await select(CARD); await animate()
  ok(await link().isChecked(), 'the pair survived the rename')
  await undo()
  d = await doc()
  ok(!keyOf(0, CARD) && !keyOf(1, CARD) && !keyOf(2, CARD), 'one undo takes the name off all three')
  await select(NEW); await animate()
  await nameField.fill(CARD); await nameField.press('Enter'); await p.waitForTimeout(300)
  const warn = await p.evaluate(() => document.querySelector('.ed-props .ed-morph-warn')?.textContent ?? '')
  ok(/Rectangle/.test(warn), `a clash names the element that holds the name ("${warn}")`)

  console.log('\n3. the pairing picker\n')
  await select(NEW); await animate()
  const pickBtn = p.locator('.ed-props .ed-morph-pick-btn')
  ok(await pickBtn.count() === 1, 'Morph with is a picker button, not a select of every element in the deck')
  if (await pickBtn.count()) {
    await pickBtn.click(); await p.waitForTimeout(200)
    const box = p.locator('.ed-morph-pick')
    const labels = await box.locator('[role=option]').allInnerTexts()
    const head = await box.locator('.ed-morph-pick-h').first().innerText().catch(() => '')
    ok(/Slide 1/.test(head), `the slide before comes first ("${head}")`)
    ok(labels.length > 0 && !labels.some((l) => ids.some((id) => l.includes(id))), `options are named, not ids (${labels.join(' | ')})`)
    await p.keyboard.type('rect'); await p.waitForTimeout(100)
    const shown = await box.locator('[role=option]:not([hidden])').allInnerTexts()
    ok(shown.length >= 1 && shown.every((l) => /rect/i.test(l)), `typing filters (${shown.join(' | ')})`)
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter'); await p.waitForTimeout(300)
    d = await doc()
    const picked = d.slides[1].elements.find((e) => e.id === NEW)?.morphId
    ok(picked === GONE, `arrows and Enter choose it (${picked})`)
    ok(await p.evaluate(() => document.activeElement?.classList.contains('ed-morph-pick-btn')), 'focus returns to the picker button')
    await undo()
  }

  console.log('\n4. the whole-slide preview\n')
  await select(TITLE); await animate()
  ok(/Text changes at once/.test(await sectionText()), 'a text pair whose words differ says they swap at once')
  await select(CARD); await animate()
  const range = p.locator('.ed-props .ed-morph-preview')
  await range.focus()
  await range.evaluate((r) => { r.value = '0'; r.dispatchEvent(new Event('input', { bubbles: true })) })
  await p.waitForTimeout(100)
  const at0 = await p.evaluate(([gone, nw]) => ({
    leaving: Number(document.querySelector(`.ed-stage-scale [data-morph-leaving="${gone}"]`)?.style.opacity ?? -1),
    entering: Number(document.querySelector(`.ed-stage-scale [data-el-id="${nw}"]`)?.style.opacity ?? -1),
    chrome: getComputedStyle(document.querySelector('.moveable-control-box') ?? document.body).visibility,
  }), [GONE, NEW])
  ok(at0.leaving > 0.9, `at 0% what leaves is still there (${at0.leaving})`)
  ok(at0.entering < 0.1 && at0.entering >= 0, `at 0% what enters is not yet (${at0.entering})`)
  ok(at0.chrome === 'hidden', 'the selection box steps aside while previewing')
  await range.evaluate((r) => { r.value = '40'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('pointerup', { bubbles: true })) })
  await p.waitForTimeout(150)
  ok(await range.inputValue() === '40', 'releasing keeps the value where it was let go')
  await p.keyboard.press('Tab'); await p.waitForTimeout(250)
  const after = await p.evaluate((gone) => ({ tag: document.activeElement?.tagName, leaving: !!document.querySelector(`[data-morph-leaving="${gone}"]`) }), GONE)
  ok(after.tag && after.tag !== 'BODY', `Tab moves on to the next control (${after.tag})`)
  ok(!after.leaving, 'moving on puts the slide back')

  console.log('\n5. duplicate, move, morph; play the transition\n')
  await thumb(0)
  await p.locator('.ed-sidebar .ed-thumb').nth(0).evaluate((n) => [...n.querySelectorAll('button')].find((b) => /Duplicate slide/.test(b.title + (b.getAttribute('aria-label') ?? '')))?.click())
  await p.waitForTimeout(300)
  await select(CARD)
  await p.locator('.ed-props .ed-tabs [role="tab"]', { hasText: /^Format$/i }).click()
  const x = p.locator('.ed-props .ed-layer-block .ed-mini', { has: p.locator(':scope > span', { hasText: /^X$/ }) }).first().locator('input')
  await x.fill('+150'); await x.press('Enter'); await p.waitForTimeout(400)
  const toast = p.locator('.ed-toast .ed-toast-act')
  ok(await toast.count() === 1, 'moving something on a duplicated slide offers Morph')
  if (await toast.count()) {
    await toast.click(); await p.waitForTimeout(200)
    ok((await doc()).slides[1].transition === 'morph', 'the offer switches the duplicate to Morph')
  }
  await thumb(2)
  await p.keyboard.press('Escape')
  await p.keyboard.press('Meta+k'); await p.waitForTimeout(200)
  await p.keyboard.type('play transition'); await p.waitForTimeout(150)
  const offered = await p.evaluate(() => document.querySelector('.ed-cmdk')?.innerText ?? '')
  ok(/Play transition/.test(offered), 'Play transition is a command')
  await p.keyboard.press('Enter')
  await p.waitForSelector('.bento-present-overlay', { timeout: 3000 }).catch(() => {})
  const startAt = await p.evaluate(() => [...document.querySelectorAll('.bento-present-overlay .slides > section')].findIndex((s) => s.classList.contains('present')))
  await p.waitForTimeout(1500)
  const endAt = await p.evaluate(() => [...document.querySelectorAll('.bento-present-overlay .slides > section')].findIndex((s) => s.classList.contains('present')))
  ok(startAt === 1 && endAt === 2, `it presents from the slide before and steps into this one (${startAt} → ${endAt})`)
  await p.keyboard.press('Escape'); await p.waitForTimeout(400)

  console.log('\n6. New slide at the bottom adds at the end\n')
  await thumb(0)
  const before = (await doc()).slides.length
  await p.locator('.ed-sidebar .ed-add-slide').evaluate((b) => b.click()); await p.waitForTimeout(200)
  await p.locator('.ed-layoutpick-item').first().click(); await p.waitForTimeout(300)
  const after2 = await doc()
  ok(after2.slides.length === before + 1 && await p.evaluate(() => window.bento.store?.currentIndex ?? null) !== 1
    && !SLIDES.some((s) => s.id === after2.slides[after2.slides.length - 1].id), 'the new slide is the last one')

  ok(!errors.length, `no page error${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
