// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The re-measured audit's remaining findings, closed (polish pass 3).
//
//   npm run build:single --prefix slides && node scripts/test-slides-polish3-browser.mjs
//
// WHAT THIS PROVES, one block per finding:
//   1. a frame's child reorders: a drag shows an insertion bar in the gap it
//      will take and drops there (one undo step); → moves it one slot; a drop
//      outside the frame takes it out.
//   2. ⇧A on overlapping copies (⌘D offsets them 24px) uses gap 16, not 0.
//   3. several frame children selected say they are placed by their frame.
//   4. a toast docks at the top of the canvas — never over Slideshow or zoom —
//      and the morph offer goes once the slide uses Morph, and on presenting.
//   5. ⌘A selects the slide's top-level elements; ⌘K offers Select all; Enter
//      in a number field commits and hands the keys back (⌘D works next).
//   6. no segmented control cuts a word (en, de, pt at 1280).
//   7. the Morph with chip is one line with a chevron.
//   8. frames are named for what they hold: "Row", "Card · <text>".
//   9. a component's name is the same in the toast and the header, and the
//      header's name is click-to-edit text.
//  10. no caption beside its control wraps (en, de, pt at 1280).
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const SHELL = process.env.SHELL_HTML || fileURLToPath(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url))
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const run = async (fn) => { try { await fn() } catch (e) { ok(false, `threw: ${String(e.message).split('\n')[0]}`) } }
const rect = (id, x, y, w, h, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, rotation: 0, opacity: 1, fill: '#dddddd', stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })
const text = (id, x, y, html, extra = {}) => ({ id, type: 'text', x, y, w: 160, h: 40, rotation: 0, opacity: 1, html, fontSize: 20, fontFamily: 'Inter', fontWeight: 400, color: '#111111', align: 'left', valign: 'top', lineHeight: 1.2, ...extra })
const rowDeck = () => [
  rect('row', 100, 280, 700, 190, { fill: '#f4f4f4', layout: { dir: 'row', gap: 20, pad: [20, 20, 20, 20], hug: true } }),
  rect('a', 120, 300, 200, 150, { parentId: 'row' }), rect('b', 340, 300, 200, 150, { parentId: 'row' }), rect('c', 560, 300, 200, 150, { parentId: 'row' }),
]

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
async function boot(locale = 'en-US', width = 1440) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale })
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1'); localStorage.setItem('bento-panel-tab', '"format"') } catch {} })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('dialog', (d) => d.accept())
  await p.goto('file://' + SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-props .ed-tabs'))
  const load = async (els, more = []) => {
    await p.evaluate(([els, more]) => { const d = JSON.parse(JSON.stringify(window.bento.doc)); d.slides = [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: els }, ...more]; window.bento.loadDoc(JSON.stringify(d)) }, [els, more])
    await p.waitForTimeout(400)
  }
  const els = (i = 0) => p.evaluate((i) => JSON.parse(JSON.stringify(window.bento.doc.slides[i].elements)), i)
  const el = async (id, i = 0) => (await els(i)).find((e) => e.id === id)
  const node = (id) => p.locator(`.ed-stage-scale [data-el-id="${id}"]`).first()
  const pick = async (id, add = false) => { await p.evaluate(([id, add]) => document.querySelector(`.ed-layer[data-id="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: add })), [id, add]); await p.waitForTimeout(250) }
  const flow = async () => (await els()).filter((e) => e.parentId === 'row').sort((m, n) => m.x - n.x).map((e) => e.id).join('')
  return { ctx, p, errors, load, els, el, node, pick, flow }
}

try {
  const { ctx, p, errors, load, el, node, pick, flow } = await boot()

  console.log('\n1. reorder inside an auto-layout frame\n')
  await run(async () => {
    await load(rowDeck())
    await pick('a')
    const a = await node('a').boundingBox(), c = await node('c').boundingBox()
    await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await p.mouse.down(); await p.waitForTimeout(80)
    const tx = c.x + c.width * 0.8
    for (let i = 1; i <= 12; i++) { await p.mouse.move(a.x + a.width / 2 + (tx - a.x - a.width / 2) * i / 12, a.y + a.height / 2, { steps: 2 }); await p.waitForTimeout(16) }
    const bar = await p.evaluate(() => { const b = document.querySelector('.ed-stage-scale .ed-slot-bar'); return b ? { slot: b.dataset.slot, w: b.getBoundingClientRect().width } : null })
    ok(!!bar && bar.slot === '2' && bar.w >= 2 && bar.w <= 4, `dragging a child past its last sibling shows a ~3px insertion bar at the last slot (${JSON.stringify(bar)})`)
    await p.mouse.up(); await p.waitForTimeout(400)
    ok((await flow()) === 'bca' && !(await p.evaluate(() => !!document.querySelector('.ed-slot-bar'))), `the drop puts it in that slot, and the bar goes (${await flow()})`)
    await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(250)
    ok((await flow()) === 'abc', 'one undo puts the order back')
    await pick('b'); await p.keyboard.press('ArrowRight'); await p.waitForTimeout(250)
    ok((await flow()) === 'acb', `→ moves the selected child one slot along the row (${await flow()})`)
    await pick('a')
    const a2 = await node('a').boundingBox()
    await p.mouse.move(a2.x + a2.width / 2, a2.y + a2.height / 2); await p.mouse.down(); await p.waitForTimeout(80)
    for (let i = 1; i <= 12; i++) { await p.mouse.move(a2.x + a2.width / 2, a2.y + a2.height / 2 + 300 * i / 12, { steps: 2 }); await p.waitForTimeout(16) }
    ok(!(await p.evaluate(() => !!document.querySelector('.ed-slot-bar'))), 'past the frame\'s edge there is no slot to show')
    await p.mouse.up(); await p.waitForTimeout(400)
    ok(!(await el('a')).parentId && (await flow()) === 'cb', 'dropped outside, the child leaves the frame')
  })

  console.log('\n2. ⇧A on overlapping copies\n')
  await run(async () => {
    await load([rect('p', 200, 200, 200, 120), rect('q', 224, 224, 200, 120)])
    await pick('p'); await pick('q', true)
    await p.keyboard.press('Shift+A'); await p.waitForTimeout(300)
    const f = (await p.evaluate(() => window.bento.doc.slides[0].elements.find((e) => e.layout)))
    ok(f?.layout?.gap === 16, `the new frame's gap is 16, not the overlap's 0 (${f?.layout?.gap})`)
  })

  console.log('\n3. several frame children selected\n')
  await run(async () => {
    await load(rowDeck())
    await pick('a'); await pick('b', true)
    const note = await p.evaluate(() => { const n = document.querySelector('.ed-props .ed-frame-placed'); return n?.offsetParent ? n.textContent : '' })
    ok(/frame/i.test(note) && await p.locator('.ed-props .ed-frame-placed .ed-link-btn').count() === 1, `they say the frame places them, with a way to it ("${note.slice(0, 40)}…")`)
    ok(await p.locator('.ed-props .ed-toolbar .ed-tool[aria-label="Align left"]').count() === 0, 'and offer no align tools that would do nothing')
  })

  console.log('\n4. toasts stay off the controls; the morph offer goes when answered\n')
  await run(async () => {
    await load([rect('m', 100, 100, 200, 150)], [{ id: 's2', background: '#ffffff', transition: 'fade', notes: '', elements: [rect('m', 600, 300, 200, 150)] }])
    await p.evaluate(() => window.bento.goTo?.(1) ?? document.querySelectorAll('.ed-thumb')[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await p.waitForTimeout(300)
    // a toast with an action, the way the editor raises one
    await pick('m')
    await p.keyboard.press(`${MOD}+Alt+KeyK`); await p.waitForTimeout(300)
    const geo = await p.evaluate(() => {
      const t = document.querySelector('.ed-toast')?.getBoundingClientRect()
      const ctrl = [...document.querySelectorAll('button')].filter((b) => /Slideshow|Zoom|%/.test(b.textContent + (b.getAttribute('aria-label') ?? '') + (b.title ?? '')) && b.offsetParent).map((b) => b.getBoundingClientRect())
      const hit = t && ctrl.some((c) => t.left < c.right && c.left < t.right && t.top < c.bottom && c.top < t.bottom)
      const canvas = document.querySelector('.ed-scroll').getBoundingClientRect()
      return t ? { hit, topHalf: t.top < canvas.top + canvas.height / 2 } : null
    })
    ok(!!geo && !geo.hit && geo.topHalf, `a toast docks at the top of the canvas, clear of Slideshow and zoom (${JSON.stringify(geo)})`)
    // the morph offer: the editor's own toast, kind morph — answered by setting Morph from the slide panel
    await p.evaluate(() => { const t = document.createElement('div'); t.className = 'ed-toast show'; t.dataset.kind = 'morph'; t.textContent = 'offer'; document.querySelector('.ed-toast')?.remove(); document.body.appendChild(t) })
    // answered from the slide panel: nothing selected, Animate, the Morph transition
    await p.evaluate(() => document.activeElement?.blur())
    for (let i = 0; i < 3; i++) await p.keyboard.press('Escape')
    await p.waitForTimeout(200)
    await p.locator('.ed-props .ed-tabs [role=tab]').nth(1).click(); await p.waitForTimeout(200)
    await p.locator('.ed-props [data-value="morph"]:visible').first().click(); await p.waitForTimeout(300)
    ok(await p.locator('.ed-toast[data-kind="morph"]').count() === 0, 'once the slide uses Morph, the morph offer is gone')
    await p.evaluate(() => { const t = document.createElement('div'); t.className = 'ed-toast show'; t.textContent = 'x'; document.body.appendChild(t) })
    await p.keyboard.press('Shift+F5'); await p.waitForTimeout(500)
    ok(await p.locator('.ed-toast').count() === 0, 'presenting clears any toast: none is drawn over the show')
    for (let i = 0; i < 4 && await p.locator('.bento-present-overlay').count(); i++) { await p.keyboard.press('Escape'); await p.waitForTimeout(400) }
  })

  console.log('\n5. Select all, and Enter hands the keys back\n')
  await run(async () => {
    await load([...rowDeck(), rect('z', 900, 600, 100, 100)])
    await p.locator('.ed-stage-scale').click({ position: { x: 5, y: 5 }, force: true }).catch(() => {})
    await p.keyboard.press(`${MOD}+KeyA`); await p.waitForTimeout(250)
    const sel = await p.evaluate(() => window.bento.selection)
    ok(JSON.stringify([...sel].sort()) === JSON.stringify(['row', 'z']), `⌘A selects the top-level elements — the frame, not its children (${sel})`)
    await p.keyboard.press(`${MOD}+KeyK`); await p.waitForTimeout(250)
    await p.keyboard.type('select all'); await p.waitForTimeout(150)
    ok(await p.locator('.ed-cmdk-list [data-cmd="select-all"]').count() === 1, '⌘K offers Select all')
    await p.keyboard.press('Escape'); await p.waitForTimeout(150)
    await pick('z')
    await p.locator('.ed-props .ed-tabs [role=tab]').nth(0).click(); await p.waitForTimeout(200)
    const w = p.locator('.ed-props input[aria-label="W"], .ed-props input[aria-label="Width"]').first()
    await w.click(); await w.fill('150'); await w.press('Enter'); await p.waitForTimeout(250)
    const focusOut = await p.evaluate(() => !document.activeElement?.closest('.ed-props'))
    ok((await el('z')).w === 150 && focusOut, 'Enter commits the width and hands the keyboard back to the canvas')
    const n0 = (await p.evaluate(() => window.bento.doc.slides[0].elements.length))
    await p.keyboard.press(`${MOD}+KeyD`); await p.waitForTimeout(250)
    ok((await p.evaluate(() => window.bento.doc.slides[0].elements.length)) === n0 + 1, '…so ⌘D right after duplicates')
  })
  await ctx.close()
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)

  console.log('\n6, 7, 10. nothing cut, nothing wrapped (en, de, pt at 1280)\n')
  for (const locale of ['en-US', 'de-DE', 'pt-BR']) {
    await run(async () => {
      const { ctx, p, load, pick } = await boot(locale, 1280)
      await load([
        rect('row', 100, 280, 700, 190, { layout: { dir: 'row', gap: 20, pad: [20, 20, 20, 20], hug: true } }),
        rect('card', 120, 300, 300, 150, { parentId: 'row', layout: { dir: 'col', gap: 8, pad: [12, 12, 12, 12], hug: true } }),
        text('t', 132, 312, 'Revenue grew', { parentId: 'card', fx: { loop: { type: 'dash-march' } } }),
        rect('loose', 900, 500, 200, 100, { fx: { enter: 'fade' }, link: 's1' }),
      ], [{ id: 's2', background: '#ffffff', transition: 'morph', notes: '', elements: [rect('loose', 600, 300, 200, 100)] }])
      let cut = [], wrapped = []
      for (const id of ['row', 'card', 't', 'loose']) {
        await pick(id)
        for (const tab of [0, 1, 2]) {
          await p.locator('.ed-props .ed-tabs [role=tab]').nth(tab).click(); await p.waitForTimeout(200)
          const r = await p.evaluate(() => ({
            cut: [...document.querySelectorAll('.ed-props .ed-seg-text button')].filter((b) => b.offsetParent && b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent),
            wrapped: [...document.querySelectorAll('.ed-props .ed-row > span:first-child')].filter((s) => s.offsetParent && !s.parentElement.classList.contains('ed-row-stack') && s.offsetHeight > (parseFloat(getComputedStyle(s).lineHeight) || 14) + 1).map((s) => s.textContent),
          }))
          cut.push(...r.cut); wrapped.push(...r.wrapped)
        }
      }
      ok(cut.length === 0, `[${locale}] no segmented control cuts a word${cut.length ? ': ' + [...new Set(cut)].join(', ') : ''}`)
      ok(wrapped.length === 0, `[${locale}] no caption beside its control wraps${wrapped.length ? ': ' + [...new Set(wrapped)].join(', ') : ''}`)
      if (locale === 'en-US') {
        await pick('loose', false)
        await p.evaluate(() => document.querySelectorAll('.ed-thumb')[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await p.waitForTimeout(300)
        await pick('loose')
        await p.locator('.ed-props .ed-tabs [role=tab]').nth(1).click(); await p.waitForTimeout(200)
        const chip = await p.evaluate(() => { const b = document.querySelector('.ed-props .ed-morph-pick-btn'); return b ? { h: b.getBoundingClientRect().height, svg: !!b.querySelector('svg'), one: !!b.querySelector('.ed-morph-pick-txt') } : null })
        ok(!!chip && chip.svg && chip.one && chip.h <= 28, `Morph with is a one-line chip with a chevron (${JSON.stringify(chip)})`)
      }
      await ctx.close()
    })
  }

  console.log('\n8, 9. names that tell levels and components apart\n')
  await run(async () => {
    const { ctx, p, load, pick } = await boot()
    await load([
      rect('row', 100, 280, 700, 190, { layout: { dir: 'row', gap: 20, pad: [20, 20, 20, 20], hug: true } }),
      rect('card', 120, 300, 300, 150, { parentId: 'row', layout: { dir: 'col', gap: 8, pad: [12, 12, 12, 12], hug: true } }),
      text('t', 132, 312, 'Revenue', { parentId: 'card' }),
    ])
    const labels = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.ed-layer')].map((r) => [r.dataset.id, r.querySelector('.ed-layer-label')?.textContent])))
    ok(labels.row === 'Row' && labels.card === 'Card · Revenue', `Layers name the row by its direction and the card by its text (${labels.row} / ${labels.card})`)
    await pick('row')
    ok((await p.locator('.ed-props').textContent()).includes('Row'), 'and so does the inspector header')
    await load([rect('k', 200, 200, 200, 100)])
    await pick('k')
    await p.keyboard.press(`${MOD}+Alt+KeyK`); await p.waitForTimeout(300)
    const toast = await p.evaluate(() => document.querySelector('.ed-toast')?.textContent ?? '')
    await p.evaluate(() => document.querySelector('.ed-layer[data-id="k"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await p.waitForTimeout(300)
    const head = await p.evaluate(() => document.querySelector('.ed-props .ed-comp-name')?.textContent ?? '')
    ok(!!head && toast.includes(head), `the toast and the header name the component alike ("${head}" in "${toast.slice(0, 40)}…")`)
    await p.locator('.ed-props .ed-comp-name').click(); await p.waitForTimeout(150)
    const f = p.locator('.ed-props .ed-comp-name-field')
    ok(await f.count() === 1, 'a click on the name makes it a field')
    await f.fill('Stat card'); await f.press('Enter'); await p.waitForTimeout(300)
    const after = { field: await p.locator('.ed-props .ed-comp-name-field').count(), name: await p.locator('.ed-props .ed-comp-name').textContent().catch(() => null) }
    ok(after.field === 0 && after.name === 'Stat card', `Enter renames it and it reads as text again (${JSON.stringify(after)})`)
    await ctx.close()
  })
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
