// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The editor-UI review's findings, each held where it was fixed.
//
//   npm run build:single --prefix slides && node scripts/test-slides-ui-fixes-browser.mjs
//
// WHAT THIS PROVES
//   1. A gradient stop owns its keys: Backspace with two stops left, and the
//      arrows, never reach the editor (which deleted or nudged the element),
//      in the panel and in the colour popover. Enter selects a stop; an arrow
//      moves it, the stops re-sort and focus follows the stop that moved.
//   2. On a multi-selection showing Mixed, ↑ steps each element from its own
//      value, `*2` doubles each, `+10` adds to each, a plain value sets all.
//   3. Nothing behind a sheet: with the ? sheet open, R / T / F / ⇧A insert
//      nothing; ⇧R is not R either.
//   4. The ⌘K palette ignores the Enter that ends an IME composition and
//      hands focus back to where it was opened.
//   5. ⌘G with nothing to group is still the editor's (the browser's Find
//      next does not run).
//   6. ⌥⌘K reads the layout's letter (Dvorak's K), and falls back to the
//      physical key only when Option made a symbol (macOS: ˚).
//   7. Switching language rebuilds the editor without stacking another
//      transform pill or modifier line, and the modifier line is not a live
//      region.
//   8. A read-only (reader) copy's palette offers nothing that edits.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const SHELL = process.env.SHELL_HTML || fileURLToPath(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url))

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const shape = (id, x, w, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y: 100, w, h: 100, rotation: 0, opacity: 1, fill: '#ff0000', stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })
const GRAD = { angle: 90, stops: [{ at: 0, color: '#ff0000' }, { at: 0.05, color: '#00ff00' }, { at: 1, color: '#0000ff' }] }
const ELS = [shape('a', 100, 200), shape('b', 400, 300), shape('g', 800, 200, { fillGradient: { angle: 90, stops: [{ at: 0, color: '#ff0000' }, { at: 1, color: '#0000ff' }] } }), shape('h', 800, 200, { y: 400, fillGradient: GRAD })]

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
  const load = () => p.evaluate((els) => { const d = JSON.parse(JSON.stringify(window.bento.doc)); d.slides = [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: els }]; window.bento.loadDoc(JSON.stringify(d)) }, ELS)
  await load()
  await p.waitForTimeout(300)
  const n = () => p.evaluate(() => window.bento.doc.slides[0].elements.length)
  const el = (id) => p.evaluate((id) => JSON.parse(JSON.stringify(window.bento.doc.slides[0].elements.find((e) => e.id === id) ?? null)), id)
  const select = async (id, add = false) => { await p.evaluate(([id, add]) => document.querySelector(`.ed-layer[data-id="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: add })), [id, add]); await p.waitForTimeout(200) }
  const field = (label) => p.locator('.ed-props .ed-layer-block .ed-mini', { has: p.locator(':scope > span', { hasText: new RegExp(`^${label}$`) }) }).first().locator('input')
  const blur = () => p.evaluate(() => document.activeElement?.blur())

  console.log('\n1. gradient stops own their keys\n')
  await select('g')
  let stops = await p.$$('.ed-props .ed-gradbar-stop')
  ok(stops.length === 2, `the panel shows the two stops (${stops.length})`)
  await stops[0].focus()
  await p.keyboard.press('Backspace'); await p.waitForTimeout(200)
  ok((await n()) === 4 && (await el('g'))?.fillGradient.stops.length === 2, 'Backspace on a stop with two left deletes neither the stop nor the element')
  await load(); await p.waitForTimeout(200); await select('g')
  stops = await p.$$('.ed-props .ed-gradbar-stop')
  await stops[0]?.focus()
  const gx = (await el('g')).x
  await p.keyboard.press('ArrowUp'); await p.waitForTimeout(200)
  ok((await el('g'))?.x === gx && (await el('g'))?.y === 100, 'an arrow on a stop does not nudge the element')
  await load(); await p.waitForTimeout(200); await select('g')
  stops = await p.$$('.ed-props .ed-gradbar-stop')
  await stops[1]?.focus()
  await p.keyboard.press('Enter'); await p.waitForTimeout(100)
  ok((await p.$$eval('.ed-props .ed-gradbar-stop', (h) => h.map((x) => x.getAttribute('aria-pressed')).join(','))) === 'false,true', 'Enter selects the focused stop')
  await select('h')
  stops = await p.$$('.ed-props .ed-gradbar-stop')
  await stops[0].focus()
  await p.keyboard.press('Shift+ArrowRight'); await p.waitForTimeout(300)
  ok(JSON.stringify((await el('h')).fillGradient.stops.map((s) => s.at)) === '[0.05,0.1,1]', `Shift+→ moves the stop past its neighbour and the stops re-sort (${JSON.stringify((await el('h')).fillGradient.stops.map((s) => s.at))})`)
  ok(/10%/.test(await p.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')), `focus follows the moved stop, which says where it is (${await p.evaluate(() => document.activeElement?.getAttribute('aria-label'))})`)
  await load(); await p.waitForTimeout(200); await select('g')
  await p.click('.ed-props .ed-gradchip'); await p.waitForTimeout(200)
  const popStops = await p.$$('.ed-cpop .ed-gradbar-stop')
  ok(popStops.length === 2, 'the colour popover shows the stops too')
  await popStops[0]?.focus()
  await p.keyboard.press('Backspace'); await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(200)
  ok((await n()) === 4 && (await el('g'))?.x === gx, 'in the popover, Backspace and the arrows leave the element where it is')
  await p.keyboard.press('Escape'); await p.waitForTimeout(150)

  console.log('\n2. Mixed fields work per element\n')
  await load(); await p.waitForTimeout(200)
  await select('a'); await select('b', true)
  const X = field('X')
  ok((await X.inputValue()) === '', 'X differs: the field is empty (Mixed)')
  await X.focus(); await p.keyboard.press('ArrowUp'); await blur(); await p.waitForTimeout(200)
  ok((await el('a')).x === 101 && (await el('b')).x === 401, `↑ steps each element from its own x (${(await el('a')).x} / ${(await el('b')).x})`)
  let W = field('W'); await W.fill('*2'); await W.press('Enter'); await blur(); await p.waitForTimeout(200)
  ok((await el('a')).w === 400 && (await el('b')).w === 600, `*2 doubles each width (${(await el('a')).w} / ${(await el('b')).w})`)
  W = field('W'); await W.fill('+10'); await W.press('Enter'); await blur(); await p.waitForTimeout(200)
  ok((await el('a')).w === 410 && (await el('b')).w === 610, '+10 adds to each')
  W = field('W'); await W.fill('50'); await W.press('Enter'); await blur(); await p.waitForTimeout(200)
  ok((await el('a')).w === 50 && (await el('b')).w === 50, 'a plain value sets them all')

  console.log('\n3. nothing behind a sheet\n')
  await load(); await p.waitForTimeout(200)
  await blur(); await p.keyboard.press('Escape')
  await p.keyboard.press('Shift+R'); await p.waitForTimeout(150)
  ok((await n()) === 4, '⇧R is not R: nothing inserted')
  await p.keyboard.press('Shift+Slash'); await p.waitForTimeout(200)
  ok(!!(await p.$('.ed-about-overlay')), 'the ? sheet is open')
  for (const k of ['r', 't', 'f']) await p.keyboard.press(k)
  await select('a')
  await p.keyboard.press('Shift+A'); await p.waitForTimeout(200)
  ok((await n()) === 4, `R, T, F and ⇧A behind the sheet insert nothing (${await n()} elements)`)
  await p.evaluate(() => document.querySelector('.ed-about-overlay')?.remove())

  console.log('\n4. the ⌘K palette\n')
  await blur(); await p.keyboard.press('Escape')
  await p.keyboard.press('Meta+k'); await p.waitForTimeout(100)
  await p.keyboard.type('add tab')
  await p.evaluate(() => document.querySelector('.ed-cmdk-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true, cancelable: true })))
  await p.waitForTimeout(150)
  ok(!!(await p.$('.ed-cmdk')) && (await n()) === 4, 'the Enter that ends an IME composition runs nothing')
  await p.keyboard.press('Escape'); await p.waitForTimeout(100)
  const undoBtn = p.locator('[data-cmd="undo"]').first()
  await undoBtn.focus()
  await p.keyboard.press('Meta+k'); await p.waitForTimeout(100); await p.keyboard.press('Escape'); await p.waitForTimeout(100)
  ok(await p.evaluate(() => document.activeElement?.getAttribute('data-cmd') === 'undo'), 'Esc hands focus back to where ⌘K was pressed')
  console.log('\n5. ⌘G with nothing to group\n')
  await blur(); await p.keyboard.press('Escape')
  const prevented = await p.evaluate(() => { const e = new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented })
  ok(prevented, "⌘G is the editor's even when it does nothing (no browser Find next)")

  await load(); await p.waitForTimeout(200)
  console.log('\n6. ⌥⌘K by letter, by key only when Option made a symbol\n')
  const press = (key, code) => p.evaluate(([key, code]) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, code, altKey: true, metaKey: true, ctrlKey: true, bubbles: true, cancelable: true })), [key, code])
  await select('a')
  await press('t', 'KeyK'); await p.waitForTimeout(150) // Dvorak: the key marked T sits where QWERTY has K
  ok(!(await el('a')).component, '⌥⌘ on a key that types t does not create a component')
  await press('k', 'KeyT'); await p.waitForTimeout(150) // Dvorak: the key that types k
  ok(!!(await el('a')).component, '⌥⌘ on the key that types k does')
  await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(150)
  await select('a')
  await press('˚', 'KeyK'); await p.waitForTimeout(150) // macOS: Option turned K into ˚
  ok(!!(await el('a')).component, 'when Option made a symbol, the physical K decides')
  await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(150)

  console.log('\n7. a language switch does not stack overlays\n')
  ok(await p.evaluate(() => !document.querySelector('.ed-modhint')?.hasAttribute('aria-live')), 'the modifier line is not a live region')
  for (const lang of ['Deutsch', 'English']) {
    await p.evaluate((l) => [...document.querySelectorAll('.ed-lang-menu .ed-btn')].find((b) => b.textContent.trim() === l)?.click(), lang)
    await p.waitForTimeout(400)
  }
  const counts = await p.evaluate(() => [document.querySelectorAll('body > .ed-hud').length, document.querySelectorAll('.ed-modhint').length])
  ok(counts[0] === 1 && counts[1] === 1, `one transform pill and one modifier line after two switches (${counts})`)

  console.log('\n8. a read-only deck\n')
  // a reader copy (collab role 'reader') boots the editor read-only
  const doc = await p.evaluate((els) => { const d = JSON.parse(JSON.stringify(window.bento.doc)); d.slides = [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: els }]; d.collab = { role: 'reader', on: false }; return d }, ELS)
  const shell = readFileSync(SHELL, 'utf8')
  const open = '<script type="application/bento+json" id="bento-doc">'
  const at = shell.indexOf(open) + open.length
  const file = join(mkdtempSync(join(tmpdir(), 'bento-ui-fixes-')), 'reader.bento.html')
  writeFileSync(file, shell.slice(0, at) + JSON.stringify(doc).replace(/</g, '\\u003c') + shell.slice(shell.indexOf('</' + 'script>', at)))
  const r = await ctx.newPage()
  r.on('pageerror', (e) => errors.push(e.message))
  await r.goto('file://' + file)
  await r.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar') && !document.getElementById('bento-splash'))
  const reader = await r.evaluate(() => document.body.classList.contains('ed-reader'))
  ok(reader, 'the reader copy is in reader mode')
  await r.evaluate(() => document.activeElement?.blur())
  await r.keyboard.press('Meta+k'); await r.waitForTimeout(150)
  const offered = await r.$$eval('.ed-cmdk-list li', (li) => li.map((x) => x.dataset.cmd))
  ok(reader && offered.length > 0 && !offered.some((c) => /^(insert-|tool-(frame|rect|ellipse|line|pen)|duplicate|delete|auto-layout|group|ghost-cut)/.test(c ?? '')) && offered.includes('present'), `a read-only deck offers no insert or edit, still Present (${offered.join(' ')})`)
  await r.close()

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
