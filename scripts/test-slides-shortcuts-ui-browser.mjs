// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The keyboard shortcuts dialog: found, searched and walked like a modern app's.
//
//   npm run build:single --prefix slides && node scripts/test-slides-shortcuts-ui-browser.mjs
//
// WHAT THIS PROVES:
//   1. it opens from ?, from ⌘/ (Ctrl+/), and from the bar's ⌨ button, with
//      the search field focused;
//   2. search finds by name (English, and the interface language — Portuguese
//      here) and by keys however they are typed (⌘D, ctrl+d, cmd d, shift a),
//      and says so when nothing matches;
//   3. the category rail filters to one category;
//   4. the keyed commands are each listed exactly once, and the gestures that
//      are not commands have their own Mouse & trackpad group;
//   5. ↓ walks from the search into the rows; Esc clears the search first,
//      then closes, and focus goes back to what opened it.
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const SHELL = process.env.SHELL_HTML || fileURLToPath(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url))

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const open = async (locale) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale })
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1') } catch {} })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale'))
  await p.locator('.ed-stage-scale').click({ position: { x: 4, y: 4 }, force: true })
  return { ctx, p, errors }
}
const names = (p) => p.$$eval('.ed-keys-row .ed-keys-name', (n) => n.map((x) => x.textContent))
const type = async (p, q) => { await p.fill('.ed-keys-search', q); await p.waitForTimeout(80) }
try {
  const { ctx, p, errors } = await open('en-US')
  console.log('\n1. three ways in\n')
  await p.keyboard.press('?')
  ok(await p.waitForSelector('.ed-keys', { timeout: 2000 }).then(() => true, () => false), '? opens it')
  ok(await p.evaluate(() => document.activeElement?.classList.contains('ed-keys-search')), '…with the search field focused')
  await p.keyboard.press('Escape'); await p.waitForTimeout(100)
  ok(!(await p.$('.ed-keys')), 'Esc closes it')
  await p.locator('.ed-stage-scale').click({ position: { x: 4, y: 4 }, force: true })
  await p.keyboard.press('ControlOrMeta+/')
  ok(await p.waitForSelector('.ed-keys', { timeout: 2000 }).then(() => true, () => false), '⌘/ (Ctrl+/) opens it')
  await p.keyboard.press('Escape'); await p.waitForTimeout(100)
  const btn = p.locator('.ed-topbar [data-cmd="help"]').first()
  await btn.click()
  ok(await p.waitForSelector('.ed-keys', { timeout: 2000 }).then(() => true, () => false), 'the bar\'s ⌨ button opens it')

  console.log('\n2. search\n')
  await type(p, 'duplicate')
  ok((await names(p)).includes('Duplicate'), 'by name: "duplicate" finds Duplicate')
  for (const q of ['ctrl+d', 'cmd d', '⌘D']) {
    await type(p, q)
    ok((await names(p)).includes('Duplicate'), `by keys: "${q}" finds Duplicate`)
  }
  await type(p, 'shift a')
  ok((await names(p)).includes('Add auto layout'), 'by keys: "shift a" finds Add auto layout')
  await type(p, 'zzqqxx')
  ok(!!(await p.$('.ed-keys-empty')), 'nothing matching says so')
  ok(await p.$$eval('.ed-keys-row .ed-keys-hint', (h) => h.length) === 0, '…and lists nothing')
  await type(p, 'group')
  ok((await p.$$eval('.ed-keys-row .ed-keys-hint', (h) => h.map((x) => x.textContent))).some((x) => /Arrange/.test(x)), 'a match carries its category')

  console.log('\n3. the rail\n')
  await type(p, '')
  await p.click('.ed-keys-cat[data-group="present"]'); await p.waitForTimeout(80)
  const heads = await p.$$eval('.ed-keys-group', (h) => h.map((x) => x.textContent))
  ok(heads.length === 1 && /present/i.test(heads[0]), `Present shows only Present (${heads.join(', ')})`)
  ok((await names(p)).includes('End the show'), '…its keys included')
  await p.click('.ed-keys-cat[data-group="all"]'); await p.waitForTimeout(80)

  console.log('\n4. complete, once each\n')
  const all = await names(p)
  const keyed = ['Save', 'Undo', 'Redo', 'Duplicate', 'Group', 'Ungroup', 'Move', 'Select only', 'Frame', 'Add auto layout', 'Zoom in', 'Fit the slide',
    'Present', 'Command palette', 'Keyboard shortcuts', 'Select all', 'Align left', 'Space evenly across', 'Flip horizontal', 'Create component', 'Print or save as PDF…', 'Preferences']
  const counts = keyed.map((k) => [k, all.filter((n) => n === k).length])
  ok(counts.every(([, n]) => n === 1), `each keyed command is listed exactly once${counts.filter(([, n]) => n !== 1).map(([k, n]) => ` — ${k}: ${n}`).join('')}`)
  const groups = await p.$$eval('.ed-keys-group', (h) => h.map((x) => x.textContent))
  ok(groups.some((g) => /mouse/i.test(g)), 'gestures have their Mouse & trackpad group')
  ok(await p.evaluate(() => { const r = [...document.querySelectorAll('.ed-keys-row')].find((x) => x.textContent.includes('Duplicate')); return /Duplicate, (Command|Ctrl) D/.test(r?.getAttribute('aria-label') ?? '') }), 'a row reads aloud as its name and its keys')

  console.log('\n5. keyboard and focus\n')
  await p.focus('.ed-keys-search')
  await p.keyboard.press('ArrowDown')
  ok(await p.evaluate(() => document.activeElement?.classList.contains('ed-keys-row')), '↓ goes from the search into the rows')
  await p.focus('.ed-keys-search'); await type(p, 'save')
  await p.keyboard.press('Escape'); await p.waitForTimeout(80)
  ok(!!(await p.$('.ed-keys')) && (await p.inputValue('.ed-keys-search')) === '', 'Esc clears the search first')
  await p.keyboard.press('Escape'); await p.waitForTimeout(100)
  ok(!(await p.$('.ed-keys')), '…then closes')
  ok(await p.evaluate(() => document.activeElement?.dataset?.cmd === 'help'), 'focus goes back to the ⌨ button that opened it')
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  await ctx.close()

  console.log('\n6. in Portuguese\n')
  const pt = await open('pt-BR')
  await pt.p.keyboard.press('?')
  await pt.p.waitForSelector('.ed-keys')
  await type(pt.p, 'duplicar')
  ok((await names(pt.p)).length > 0, 'the interface language\'s name finds it ("duplicar")')
  await type(pt.p, 'duplicate')
  ok((await names(pt.p)).length > 0, '…and the English name still does')
  await pt.ctx.close()
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
