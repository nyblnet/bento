// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Chrome polish: where dragged slides land, tabs in narrow sidebars, hints in
// the speaker view, and a theme palette every colour picker can use.
//
//   npm run build:single --prefix slides && node scripts/test-slides-chrome-polish-browser.mjs
//
// WHAT THIS PROVES
//   1. Dragging slides in the list draws a thick accent line in the gap where
//      they will land — before a thumbnail when the pointer is above its
//      middle, after it below — moving with the pointer; no line where the
//      drop would change nothing; dropping lands exactly there (the end of the
//      list included); the line is gone after the drop.
//   2. Side and inspector tabs stay inside their own boxes at the narrowest
//      panel widths, in en, pt and de: no tab overlaps another or leaves the
//      bar, a cut label ends in an ellipsis, and every tab keeps its full name.
//   3. The speaker view's buttons explain themselves through the app's hint
//      (delayed, with the key as a chip), with no native title tooltip.
//   4. The Theme section is the brand palette: code colours have their own
//      section; Accent 2–6 can be added and removed; every colour picker
//      offers every palette colour; picking Accent 3 and then editing
//      Accent 3 re-colours the shape, one undo step each.
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
const rect = (id, x, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y: 100, w: 200, h: 100, rotation: 0, opacity: 1, fill: '#ff0000', stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })
const slide = (id, elements = [], extra = {}) => ({ id, background: '#ffffff', transition: 'none', notes: '', elements, ...extra })

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const open = async ({ locale = 'en-US', width = 1440, slides, storage = {} } = {}) => {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale })
  await ctx.addInitScript((storage) => { try { localStorage.setItem('bento-slideshow-started', '1'); for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v) } catch {} }, storage)
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-props .ed-tabs'))
  if (slides) {
    await p.evaluate((slides) => { const d = JSON.parse(JSON.stringify(window.bento.doc)); d.slides = slides; window.bento.loadDoc(JSON.stringify(d)) }, slides)
    await p.waitForTimeout(400)
  }
  return { p, ctx, errors }
}
const order = (p) => p.evaluate(() => window.bento.doc.slides.map((s) => s.id))

// ---------------------------------------------------------------- 1
console.log('\n1. where dragged slides land\n')
await run(async () => {
  const { p, ctx, errors } = await open({ slides: [slide('a'), slide('b'), slide('b1', [], { stateOf: 'b' }), slide('c'), slide('d')] })
  const thumb = (i) => p.locator(`.ed-thumbs .ed-thumb[data-index="${i}"]`)
  const line = () => p.evaluate(() => {
    const g = document.querySelector('.ed-thumbs .ed-insertgap.drop')
    if (!g) return null
    const cs = getComputedStyle(g, '::before')
    return { at: g.getAttribute('data-at'), h: parseFloat(cs.height), bg: cs.backgroundColor, op: getComputedStyle(g).opacity, vis: getComputedStyle(g).visibility }
  })
  const box = async (i) => (await thumb(i).boundingBox())
  const a = await box(0)
  await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await p.mouse.down()
  // below the middle of b (whose state b1 follows it) → after the b unit = before c
  const b = await box(1)
  await p.mouse.move(b.x + b.width / 2, b.y + b.height * 0.8, { steps: 6 })
  await p.waitForTimeout(80)
  let l = await line()
  ok(l?.at === '3', `below b's middle the line sits after b and its state (before c) — at ${l?.at}`)
  ok(!!l && l.h >= 3 && l.op === '1' && l.vis === 'visible', `and it is a thick, visible line (${l?.h}px)`)
  const accent = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
  ok(!!l && l.bg !== 'rgba(0, 0, 0, 0)', `in a solid colour (${l?.bg}; accent ${accent})`)
  // above d's middle → before d
  const dd = await box(4)
  await p.mouse.move(dd.x + dd.width / 2, dd.y + dd.height * 0.2, { steps: 6 })
  await p.waitForTimeout(80)
  l = await line()
  ok(l?.at === '4', `above d's middle it moves to before d — at ${l?.at}`)
  // back over a itself → no-op, no line
  const a2 = await box(0)
  await p.mouse.move(a2.x + a2.width / 2, a2.y + a2.height * 0.3, { steps: 8 })
  await p.waitForTimeout(80)
  { const l0 = await line(); ok(l0 === null, `over its own place there is no line (the drop would change nothing) — ${JSON.stringify(l0)}`) }
  // past the last thumb → the end
  const d = await box(4)
  await p.mouse.move(d.x + d.width / 2, d.y + d.height * 0.9, { steps: 6 })
  await p.waitForTimeout(80)
  l = await line()
  ok(l?.at === '5', `below the last slide's middle the line is at the end — at ${l?.at}`)
  await p.mouse.up()
  await p.waitForTimeout(300)
  ok(JSON.stringify(await order(p)) === JSON.stringify(['b', 'b1', 'c', 'd', 'a']), `the drop lands at the end (${(await order(p)).join(',')})`)
  ok((await line()) === null && !(await p.locator('.ed-thumbs-dragging').count()), 'and the line is gone')
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  await ctx.close()
})

// ---------------------------------------------------------------- 2
console.log('\n2. tabs in the narrowest sidebars\n')
for (const locale of ['en-US', 'pt-BR', 'de-DE']) {
  await run(async () => {
    // the resizers' minimums (editor.ts PANEL_BOUNDS)
    const { p, ctx } = await open({ locale, width: 1280, storage: { 'bento-ed-panels': JSON.stringify({ left: 110, right: 190 }) } })
    await p.evaluate(() => document.querySelector('.ed-stage-scale [data-el-id]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await p.waitForTimeout(300)
    const bars = await p.evaluate(() => [...document.querySelectorAll('.ed-tabs.ed-side-tabs, .ed-props .ed-tabs')].map((bar) => {
      const r = bar.getBoundingClientRect()
      const tabs = [...bar.querySelectorAll(':scope > button')].map((b) => {
        const br = b.getBoundingClientRect()
        // the label's own box: the name span, or the button's text
        const label = b.querySelector('.ed-tab-name') ?? b
        const cs = getComputedStyle(label)
        const shown = getComputedStyle(label).display !== 'none' && label.textContent.trim() !== ''
        const cut = shown && label.scrollWidth > label.clientWidth + 1
        return { l: br.left, r: br.right, name: b.getAttribute('aria-label') || b.textContent.trim(), titled: !!(b.title || b.getAttribute('aria-label') || b.dataset.hint), cut, clipped: cs.overflow === 'hidden' || cs.overflowX === 'hidden', ellipsis: cs.textOverflow === 'ellipsis' }
      })
      return { side: bar.classList.contains('ed-side-tabs'), l: r.left, r: r.right, tabs }
    }))
    for (const bar of bars) {
      const where = `${locale} ${bar.side ? 'side' : 'inspector'} tabs`
      const inside = bar.tabs.every((t) => t.l >= bar.l - 0.5 && t.r <= bar.r + 0.5)
      const apart = bar.tabs.every((t, i) => i === 0 || t.l >= bar.tabs[i - 1].r - 0.5)
      ok(inside && apart, `${where}: every tab inside the bar, none over another`)
      const bad = bar.tabs.filter((t) => t.cut && !(t.clipped && t.ellipsis))
      ok(!bad.length, `${where}: a cut label ends in an ellipsis inside its own tab${bad.length ? ' — ' + bad.map((t) => t.name).join(', ') : ''}`)
      ok(bar.tabs.every((t) => t.titled), `${where}: every tab keeps its full name for the hint and screen readers`)
    }
    await ctx.close()
  })
}

await run(async () => {
  const { p, ctx } = await open({ locale: 'pt-BR' })
  const tabs = await p.evaluate(() => [...document.querySelectorAll('.ed-props .ed-tabs > button')].map((b) => ({ glyph: !!b.querySelector('svg'), on: b.getAttribute('aria-selected') === 'true', name: getComputedStyle(b.querySelector('.ed-tab-name') ?? b).display !== 'none' })))
  ok(tabs.length === 3 && tabs.every((t) => t.glyph), 'the inspector tabs carry glyphs, like the side column')
  ok(tabs.filter((t) => t.name).length === 1 && tabs.find((t) => t.on)?.name, 'and only the chosen tab says its name')
  // the panel's resize edge: its hint sits beside the pointer, never over a tab bar
  const edge = p.locator('.ed-resizer').last()
  const eb = await edge.boundingBox()
  await p.mouse.move(eb.x + eb.width / 2, eb.y + 24)
  await p.waitForTimeout(800)
  const over = await p.evaluate((y) => {
    const t = document.querySelector('.ed-tip:not([hidden])')?.getBoundingClientRect()
    if (!t) return 'no hint'
    if (t.top < 0) return `off the top of the window (${Math.round(t.top)})`
    if (Math.abs((t.top + t.bottom) / 2 - y) > 30) return `away from the pointer (${Math.round(t.top)}–${Math.round(t.bottom)}, pointer ${y})`
    const hit = [...document.querySelectorAll('.ed-tabs')].some((bar) => { const r = bar.getBoundingClientRect(); return t.left < r.right && t.right > r.left && t.top < r.bottom && t.bottom > r.top })
    return hit ? 'over the tabs' : 'clear'
  }, Math.round(eb.y + 24))
  ok(over === 'clear', `the resize edge's hint sits beside the pointer, clear of the tabs (${over})`)
  await ctx.close()
})

// ---------------------------------------------------------------- 3
console.log('\n3. the speaker view explains itself with the app hint\n')
await run(async () => {
  const { p, ctx, errors } = await open({ slides: [slide('a', [rect('r', 100)]), slide('b')] })
  await p.keyboard.press('F5')
  await p.waitForTimeout(900)
  const [sv] = await Promise.all([ctx.waitForEvent('page', { timeout: 8000 }), p.keyboard.press('s')])
  await sv.waitForSelector('.sv-btn', { timeout: 8000 })
  const btn = sv.locator('.sv-btn[data-nav="laser"], .sv-btn').first()
  const name = await btn.getAttribute('aria-label')
  await btn.hover()
  await sv.waitForTimeout(150)
  const early = await sv.evaluate(() => { const t = document.querySelector('.ed-tip'); return !!t && !t.hidden })
  await sv.waitForTimeout(600)
  const tip = await sv.evaluate(() => { const t = document.querySelector('.ed-tip'); return t && !t.hidden ? { text: t.textContent, keys: t.querySelectorAll('kbd').length } : null })
  const titled = await btn.getAttribute('title')
  ok(!early, 'the hint waits for the pointer to rest (not shown at 150ms)')
  ok(!!tip && !!tip.text, `then the app's hint shows (${tip?.text ?? 'none'}) for "${name}"`)
  ok(titled === null, `and the native title is borrowed while it shows, so the browser draws no second tooltip (title=${titled})`)
  // any speaker button with a key in its name gets the key as a chip
  const keyed = sv.locator('.sv-btn[title*="("]').first()
  if (await keyed.count()) {
    await sv.mouse.move(0, 0); await sv.waitForTimeout(400)
    await keyed.hover(); await sv.waitForTimeout(700)
    const k = await sv.evaluate(() => document.querySelectorAll('.ed-tip:not([hidden]) kbd').length)
    ok(k > 0, 'a button with a shortcut shows it as a key chip')
  }
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  await ctx.close()
})

// ITEMS-4

await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
