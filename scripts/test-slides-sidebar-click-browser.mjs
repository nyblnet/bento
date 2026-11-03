// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Clicking a slide in the list never moves the list under the pointer.
//
//   npm run build:single --prefix slides && node scripts/test-slides-sidebar-click-browser.mjs
//
// WHAT THIS PROVES, in the packaged document. The slide list scrolls the
// current slide into view. A click on a thumb clears the multi-selection
// first and moves the current slide second, and clearing repainted the list
// with the current slide still the OLD one — so when that slide was scrolled
// out of view, the list jumped up to it, then down to the clicked thumb, which
// ended up at an edge with a different slide under the pointer (reported with
// hidden and state slides, which make lists long; any long list did it).
// On a deck with hidden slides and nested state slides, with the previously
// current slide off-screen ABOVE or BELOW:
//   1. clicking a fully visible thumb — plain, hidden, a parent, a state —
//      leaves the list's scroll position and the thumb exactly where they were,
//      and the clicked slide is the one under the pointer;
//   2. clicking a thumb that is only partly visible may reveal it, and the
//      clicked slide is still the one under the pointer;
//   3. moving the current slide from the keyboard still brings an off-screen
//      thumb into view (the reveal is kept, only aimed at real changes).
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const shell = readFileSync(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'bento-sidebar-click-'))
// 18 slides: s04 and s11 hidden; s06 has two states, s13 has one
const slides = []
const add = (id, extra = {}) => slides.push({ id, background: '#ffffff', transition: 'none', notes: '', elements: [{ id: 't-' + id, type: 'text', x: 100, y: 100, w: 800, h: 120, html: `<p>${id}</p>` }], ...extra })
for (let n = 1; n <= 13; n++) {
  const id = 's' + String(n).padStart(2, '0')
  add(id, n === 4 || n === 11 ? { hidden: true } : {})
  if (n === 6) { add('s06a', { stateOf: 's06' }); add('s06b', { stateOf: 's06' }) }
  if (n === 13) add('s13a', { stateOf: 's13' })
}
add('s14'); add('s15')
const doc = { format: 'bento/slides', version: 1, docId: 'sidebar-click', title: 'sidebar', size: { width: 1280, height: 720 }, theme: { background: '#ffffff', color: '#1E2A3A', accent: '#f7a600', fontFamily: 'system-ui' }, slides }
const open = '<script type="application/bento+json" id="bento-doc">', close = '</' + 'script>'
const at = shell.indexOf(open) + open.length
const file = join(dir, 'deck.bento.html')
writeFileSync(file, shell.slice(0, at) + JSON.stringify(doc).replace(/</g, '\\u003c') + shell.slice(shell.indexOf(close, at)))

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 800 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1') } catch {} })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + file)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-sidebar .ed-thumb'), null, { timeout: 20000 })
  await p.waitForTimeout(800)

  const idx = (id) => slides.findIndex((s) => s.id === id)
  const geom = (id) => p.evaluate((i) => {
    const sb = document.querySelector('.ed-sidebar'), sr = sb.getBoundingClientRect()
    const r = sb.querySelector(`.ed-thumb[data-index="${i}"]`).getBoundingClientRect()
    return { scroll: Math.round(sb.scrollTop), top: Math.round(r.top), bottom: Math.round(r.bottom), visTop: Math.round(sr.top), visBottom: Math.round(sr.top + sb.clientHeight) }
  }, idx(id))
  const under = (x, y) => p.evaluate(([x, y]) => { const t = document.elementFromPoint(x, y)?.closest('.ed-thumb'); return t ? window.bento.doc.slides[Number(t.dataset.index)]?.id : null }, [x, y])
  // make `from` current without touching the list's scroll, then scroll the list to `scroll`
  const setUp = async (from, scroll) => {
    await p.evaluate((i) => document.querySelectorAll('.ed-sidebar .ed-thumb')[i].click(), idx(from))
    await p.waitForTimeout(200)
    await p.evaluate((y) => { document.querySelector('.ed-sidebar').scrollTop = y }, scroll)
    await p.waitForTimeout(150)
  }
  const click = async (target) => {
    const g = await geom(target)
    const x = 60, y = Math.max(g.top, g.visTop) + 12
    await p.mouse.click(x, y)
    await p.waitForTimeout(500)
    return { before: g, after: await geom(target), under: await under(x, y) }
  }

  console.log('a fully visible thumb, the current slide scrolled out of view\n')
  // [current slide (off-screen), list scroll, target, what the target is]
  for (const [from, scroll, target, what] of [
    ['s01', 400, 's08', 'a plain slide (current one above, off-screen)'],
    ['s01', 300, 's06', 'a parent with states'],
    ['s01', 300, 's06a', 'a state slide'],
    ['s01', 500, 's11', 'a hidden slide'],
    ['s15', 0, 's03', 'a plain slide (current one below, off-screen)'],
    ['s15', 0, 's04', 'a hidden slide (current one below)'],
  ]) {
    await setUp(from, scroll)
    const pre = await geom(from)
    const g0 = await geom(target)
    const fully = g0.top >= g0.visTop && g0.bottom <= g0.visBottom
    const offscreen = pre.bottom <= pre.visTop || pre.top >= pre.visBottom
    if (!fully || !offscreen) { ok(false, `${what}: set-up (target fully visible ${fully}, ${from} off-screen ${offscreen})`); continue }
    const r = await click(target)
    ok(r.after.scroll === r.before.scroll && Math.abs(r.after.top - r.before.top) <= 1 && r.under === target,
      `${what}: list stays put — scroll ${r.before.scroll}→${r.after.scroll}, thumb ${r.before.top}→${r.after.top}px, under the pointer: ${r.under}`)
  }

  console.log('\na partly visible thumb\n')
  {
    await setUp('s01', 0)
    // pick the first thumb that straddles the bottom edge
    const target = await p.evaluate(() => {
      const sb = document.querySelector('.ed-sidebar'), bot = sb.getBoundingClientRect().top + sb.clientHeight
      const t = [...sb.querySelectorAll('.ed-thumb')].find((n) => { const r = n.getBoundingClientRect(); return r.top < bot - 20 && r.bottom > bot })
      return t ? window.bento.doc.slides[Number(t.dataset.index)].id : null
    })
    if (!target) ok(false, 'set-up: a thumb straddling the bottom edge')
    else {
      const r = await click(target)
      ok(r.under === target, `${target}, partly visible: it may be revealed (scroll ${r.before.scroll}→${r.after.scroll}), and it is still the one under the pointer (${r.under})`)
    }
  }

  console.log('\nkeyboard navigation still reveals\n')
  {
    await setUp('s01', 0)
    await p.mouse.click(700, 400) // the canvas, nothing selected: arrows walk slides
    await p.keyboard.press('Escape')
    for (let i = 0; i < 12; i++) { await p.keyboard.press('PageDown'); await p.waitForTimeout(60) }
    await p.waitForTimeout(400)
    const cur = await p.evaluate(() => window.bento.doc.slides[[...document.querySelectorAll('.ed-sidebar .ed-thumb')].findIndex((n) => n.classList.contains('active'))]?.id)
    const g = cur ? await geom(cur) : null
    ok(!!g && g.top >= g.visTop - 1 && g.bottom <= g.visBottom + 1, `after paging to ${cur} from the keyboard, its thumb is in view (${g ? `${g.top}–${g.bottom} within ${g.visTop}–${g.visBottom}` : 'no thumb'})`)
  }
  ok(errors.length === 0, `no page error${errors.length ? ' — ' + errors[0] : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
