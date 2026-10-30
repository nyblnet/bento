// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Keeping a deck on-brand: the UX audit's tokens and components findings
// (docs/audit/ux-pyramid-2026-10-30.md §2), each held where it was fixed.
//
//   npm run build:single --prefix slides && node scripts/test-slides-ux-brand-browser.mjs
//   (SHELL_HTML=<older build> runs the same checks against it)
//
// WHAT THIS PROVES
//   1. Token rows stay readable: a name keeps ≥80px at the default panel width;
//      a colour token's value opens the app's colour popover, not the browser's
//      picker; a refused name says why (aria-invalid + aria-describedby); the
//      new row has focus after it is created.
//   2. Tokens can be found: ⌘K lists New color token, the component commands
//      and Switch mode; the ? sheet has a Tokens row; a field's bind dot shows
//      while the field has keyboard focus.
//   3. Feedback: a token's uses count is a button that walks its uses across
//      slides; a mode switch toasts what changed; the inspector's bound swatch
//      shows a token's new value at once.
//   4. One brand system: the theme colours lead the Tokens view as built-in,
//      undeletable tokens that write the palette; the Theme section links to
//      Tokens; the colour menu is "Colors & tokens" and its detach names what
//      it detaches from.
//   5. Adoption: "Make a token from this color" binds every literal use in the
//      deck in one undo step; "Select all with this color" selects them.
//   6. Components: ⌥⌘K says so and opens the name; a copy is inserted on free
//      space and selected; a copy's inspector header reaches its main; Reset
//      overrides; deleting a main asks, and a copy becomes the main; detaching
//      part of a main reads "Remove from component".
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const SHELL = process.env.SHELL_HTML || fileURLToPath(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url))

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const shape = (id, x, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y: 100, w: 200, h: 120, rotation: 0, opacity: 1, fill: '#123456', stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })
const text = (id, x, html) => ({ id, type: 'text', x, y: 300, w: 200, h: 60, rotation: 0, opacity: 1, html, fontSize: 24, fontFamily: 'Inter', fontWeight: 400, color: '#111111', align: 'left', valign: 'top', lineHeight: 1.2 })
const SLIDES = [
  { id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: [shape('a', 100), shape('b', 400, { fill: '#ff0000' }), text('t1', 700, 'Hello')] },
  { id: 's2', background: '#123456', transition: 'none', notes: '', elements: [shape('c', 100)] },
]
const TOKENS = { modes: ['default', 'Dark'], mode: 'default', set: { 'color.brand': { type: 'color', values: { default: '#ff9900', Dark: '#3355ff' } }, 'space.md': { type: 'number', values: { default: 16, Dark: 16 } } } }

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1'); localStorage.setItem('bento-side-view', 'tokens') } catch {} })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  let dialogs = 0
  p.on('dialog', (d) => { dialogs++; d.accept() })
  await p.goto('file://' + SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-props .ed-tabs'))
  const load = (tokens = TOKENS, slides = SLIDES) => p.evaluate(([slides, tokens]) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = slides
    d.theme.tokens = tokens
    window.bento.loadDoc(JSON.stringify(d))
  }, [slides, tokens])
  const doc = () => p.evaluate(() => JSON.parse(JSON.stringify(window.bento.doc)))
  const el = async (id) => (await doc()).slides.flatMap((s) => s.elements).find((e) => e.id === id)
  const select = async (id, add = false) => { await p.evaluate(([id, add]) => document.querySelector(`.ed-layer[data-id="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: add })), [id, add]); await p.waitForTimeout(200) }
  const goSlide = async (i) => { await sideView('slides'); await p.evaluate((i) => document.querySelectorAll('.ed-sidebar .ed-thumb')[i]?.click(), i); await p.waitForTimeout(150) }
  const current = () => p.evaluate(() => [...document.querySelectorAll('.ed-sidebar .ed-thumb')].findIndex((n) => n.classList.contains('active')))
  const selection = () => p.evaluate(() => window.bento.selection.slice().sort().join())
  const sideView = (v) => p.evaluate((v) => document.querySelector(`.ed-side-tabs [data-view="${v}"]`)?.click(), v)
  // a missing control is a failed check, not a crash: an older build lacks most of them
  const tap = (sel) => p.click(sel, { timeout: 1500 }).then(() => true, () => false)
  const fill = (sel, v) => p.fill(sel, v, { timeout: 1500 }).then(() => true, () => false)
  const toast = () => p.evaluate(() => document.querySelector('.ed-toast')?.textContent ?? '')
  const palette = async (q) => {
    await p.evaluate(() => document.activeElement?.blur())
    await p.keyboard.press('Meta+k'); await p.waitForTimeout(150)
    await p.keyboard.type(q); await p.waitForTimeout(150)
    const rows = await p.$$eval('.ed-cmdk-overlay [role="option"], .ed-cmdk-overlay li', (r) => r.map((x) => x.textContent))
    await p.keyboard.press('Escape'); await p.waitForTimeout(100)
    return rows.join(' | ')
  }

  await load(); await p.waitForTimeout(400)
  await sideView('tokens'); await p.waitForTimeout(150)

  console.log('\n1. token rows stay readable\n')
  const nameW = await p.evaluate(() => document.querySelector('.ed-tokens [data-token="space.md"] .ed-token-name')?.getBoundingClientRect().width ?? 0)
  ok(nameW >= 80, `a number token's name keeps ≥80px at the default panel width (${Math.round(nameW)}px)`)
  const colorW = await p.evaluate(() => document.querySelector('.ed-tokens [data-token="color.brand"] .ed-token-name')?.getBoundingClientRect().width ?? 0)
  ok(colorW >= 80, `a colour token's name too (${Math.round(colorW)}px)`)
  ok(!(await p.$('.ed-tokens [data-token="color.brand"] input[type="color"]')), "a colour token's value is not the browser's colour input")
  await tap('.ed-tokens [data-token="color.brand"] .ed-token-swatch').catch(() => {})
  await p.waitForTimeout(150)
  ok(!!(await p.$('.ed-cpop')), "…it opens the app's colour popover")
  await p.keyboard.press('Escape'); await p.waitForTimeout(100)

  await tap('.ed-tokens-group[data-type="number"] .ed-tokens-add')
  await p.keyboard.type('Brand Primary!'); await p.keyboard.press('Enter'); await p.waitForTimeout(120)
  const why = await p.evaluate(() => {
    const i = document.querySelector('.ed-tokens .ed-token-new')
    const d = i?.getAttribute('aria-describedby')
    return { invalid: i?.getAttribute('aria-invalid'), note: d ? document.getElementById(d)?.textContent : '' }
  })
  ok(why.invalid === 'true' && /letter/i.test(why.note ?? ''), `a refused name says why ("${why.note}")`)
  await p.keyboard.press('Meta+a'); await p.keyboard.type('space.md'); await p.keyboard.press('Enter'); await p.waitForTimeout(120)
  const dupe = await p.evaluate(() => { const i = document.querySelector('.ed-tokens .ed-token-new'); const d = i?.getAttribute('aria-describedby'); return d ? document.getElementById(d)?.textContent : '' })
  ok(/already/i.test(dupe ?? ''), `a taken name says so ("${dupe}")`)
  await p.keyboard.press('Meta+a'); await p.keyboard.type('space.lg'); await p.keyboard.press('Enter'); await p.waitForTimeout(200)
  const focusIn = await p.evaluate(() => document.activeElement?.closest('[data-token]')?.getAttribute('data-token'))
  ok(focusIn === 'space.lg', `focus lands on the new row (${focusIn})`)

  console.log('\n2. tokens can be found\n')
  await select('a')
  ok(/New color token/.test(await palette('token')), '⌘K "token" lists New color token')
  ok(/Switch mode/.test(await palette('mode')), '⌘K "mode" lists Switch mode')
  ok(/Show tokens and components/.test(await palette('component')), '⌘K "component" finds the Tokens view (Show tokens and components)')
  await p.keyboard.press('?'); await p.waitForTimeout(200)
  ok(await p.evaluate(() => [...document.querySelectorAll('.ed-help-row kbd')].some((k) => k.textContent === 'Tokens')), 'the ? sheet has a Tokens row')
  await p.keyboard.press('Escape'); await p.waitForTimeout(100)
  await select('a')
  const dotOnFocus = await p.evaluate(() => {
    const f = document.querySelector('.ed-props .ed-has-token input')
    f?.focus()
    const dot = f?.parentElement?.querySelector('.ed-token-dot')
    return dot ? getComputedStyle(dot).opacity : 'none'
  })
  ok(dotOnFocus === '1', `a bindable field's dot shows while the field has focus (opacity ${dotOnFocus})`)
  await p.evaluate(() => document.activeElement?.blur())

  console.log('\n3. feedback\n')
  // a and c bound to color.brand, on two slides
  await load({ ...TOKENS, set: { ...TOKENS.set } }, [
    { ...SLIDES[0], elements: [shape('a', 100, { fill: '#ff9900', themeRefs: { fill: '$color.brand' } }), SLIDES[0].elements[1], SLIDES[0].elements[2]] },
    { ...SLIDES[1], elements: [shape('c', 100, { fill: '#ff9900', themeRefs: { fill: '$color.brand' } })] },
  ])
  await p.waitForTimeout(300); await sideView('tokens'); await p.waitForTimeout(100)
  const uses = await p.$('.ed-tokens [data-token="color.brand"] .ed-token-uses')
  ok(!!uses && (await uses.evaluate((u) => u.tagName)) === 'BUTTON', 'the uses count is a button')
  if (uses) {
    await uses.click({ timeout: 1500 }).catch(() => {}); await p.waitForTimeout(200)
    const first = [await current(), await selection()]
    await tap('.ed-tokens [data-token="color.brand"] .ed-token-uses'); await p.waitForTimeout(200)
    const second = [await current(), await selection()]
    ok(first[1] === 'a' && second[1] === 'c' && second[0] === 1, `…it walks the uses across slides (${first} → ${second})`)
  }
  await p.locator('.ed-tokens-mode', { hasText: /^Dark$/ }).click({ timeout: 1500 }).catch(() => {}); await p.waitForTimeout(250)
  ok(/2 properties changed/.test(await toast()), `a mode switch says what it changed ("${await toast()}")`)
  ok(/didn’t follow/.test(await toast()), '…and what it did not (the hard-coded colours on those slides)')
  await p.locator('.ed-tokens-mode', { hasText: /^Default$/ }).click({ timeout: 1500 }).catch(() => {}); await p.waitForTimeout(200)
  await goSlide(0); await select('a'); await sideView('tokens'); await p.waitForTimeout(100)
  await tap('.ed-tokens [data-token="color.brand"] .ed-token-swatch'); await p.waitForTimeout(150)
  await fill('.ed-cpop .ed-cpop-text', '#00aa44'); await p.keyboard.press('Enter'); await p.waitForTimeout(300)
  const panelHex = await p.evaluate(() => document.querySelector('.ed-props .ed-colorref input[type="color"]')?.value)
  ok((await el('a')).fill.toLowerCase() === '#00aa44' && panelHex === '#00aa44', `the inspector's bound swatch shows the token's new value at once (${panelHex})`)

  console.log('\n4. one brand system\n')
  await sideView('tokens'); await p.waitForTimeout(100)
  const builtins = await p.$$eval('.ed-tokens [data-type="color"] .ed-token-builtin', (r) => r.map((x) => [x.querySelector('.ed-token-name')?.textContent, !!x.querySelector('.ed-token-del')]))
  ok(builtins.length >= 3 && builtins.some(([n]) => n === 'Accent 1') && builtins.every(([, del]) => !del), `the theme colours lead the Colors group as undeletable tokens (${builtins.map(([n]) => n).join(', ')})`)
  const acc = await p.$('.ed-tokens .ed-token-builtin[data-slot="accent1"] .ed-token-swatch')
  if (acc) {
    await acc.click({ timeout: 1500 }).catch(() => {}); await p.waitForTimeout(150)
    await fill('.ed-cpop .ed-cpop-text', '#aa00aa'); await p.keyboard.press('Enter'); await p.waitForTimeout(250)
  }
  ok((await doc()).theme.accent.toLowerCase() === '#aa00aa', 'editing a built-in writes the palette (theme.accent)')
  await goSlide(0); await p.evaluate(() => document.activeElement?.blur()); await p.keyboard.press('Escape'); await p.waitForTimeout(200)
  const link = await p.$('.ed-props .ed-theme-tokens')
  if (link) { await link.click({ timeout: 1500 }).catch(() => {}); await p.waitForTimeout(150) }
  ok(!!link && (await p.evaluate(() => document.querySelector('.ed-side-tabs [aria-selected="true"]')?.dataset.view)) === 'tokens', 'the Theme section opens Tokens')
  await select('a')
  const words = await p.evaluate(() => ({ open: document.querySelector('.ed-props .ed-colorref button[aria-label="Colors & tokens"]')?.title, detach: document.querySelector('.ed-props .ed-color-detach')?.title }))
  ok(words.open === 'Colors & tokens' && words.detach === 'Detach from token', `one vocabulary (${words.open} · ${words.detach})`)

  console.log('\n5. adoption\n')
  await load({ set: {} }); await p.waitForTimeout(300)
  await select('a')
  await tap('.ed-props .ed-colorref button[aria-label="Colors & tokens"]'); await p.waitForTimeout(100)
  const make = p.locator('.ed-tokpick-act', { hasText: 'Make a token from this color' })
  if (await make.count()) { await make.click({ timeout: 1500 }).catch(() => {}); await p.waitForTimeout(250) }
  const d5 = await doc()
  const bound = [d5.slides[0].elements[0].themeRefs?.fill, d5.slides[1].elements[0].themeRefs?.fill, d5.slides[1].themeRefs?.background]
  ok(!!d5.theme.tokens?.set['color.brand'] && bound.every((r) => r === '$color.brand'), `one click binds every literal use in the deck (${bound})`)
  ok(/3 uses/.test(await toast()), `…and says how many ("${await toast()}")`)
  await p.evaluate(() => document.activeElement?.blur())
  await p.keyboard.press('Meta+z'); await p.waitForTimeout(250)
  const undone = await doc()
  ok(!undone.theme.tokens?.set?.['color.brand'] && !undone.slides[1].elements[0].themeRefs, '…in one undo step')
  await goSlide(0); await p.waitForTimeout(150)
  await p.evaluate(() => window.bento.loadDoc(JSON.stringify((() => { const d = window.bento.doc; d.slides[0].elements.push({ ...d.slides[0].elements[0], id: 'a2', x: 900 }); return d })())))
  await p.waitForTimeout(300); await select('a')
  await tap('.ed-props .ed-colorref button[aria-label="Colors & tokens"]'); await p.waitForTimeout(100)
  const pick = p.locator('.ed-tokpick-act', { hasText: 'Select all with this color' })
  if (await pick.count()) { await pick.click({ timeout: 1500 }).catch(() => {}); await p.waitForTimeout(200) }
  ok((await selection()) === 'a,a2', 'Select all with this color selects every use on the slide')

  console.log('\n6. components\n')
  await load({ set: {} }); await p.waitForTimeout(300)
  await select('a'); await select('t1', true)
  await p.keyboard.press('Meta+Alt+k'); await p.waitForTimeout(300)
  ok(/Component 1/.test(await toast()), `⌥⌘K says so ("${await toast()}")`)
  ok(await p.evaluate(() => document.querySelector('.ed-side-tabs [aria-selected="true"]')?.dataset.view === 'tokens' && !!document.querySelector('.ed-component-row.ed-flash')), '…and points at it in Tokens, where it is named')
  await p.keyboard.press('Meta+z'); await p.waitForTimeout(250)
  ok(!(await el('a')).component, '…and ⌘Z still undoes the make')
  await p.keyboard.press('Meta+Shift+z'); await p.waitForTimeout(250)
  await p.keyboard.press('Escape'); await p.evaluate(() => document.activeElement?.blur())
  await goSlide(1); await p.waitForTimeout(200); await sideView('tokens'); await p.waitForTimeout(100)
  await tap('.ed-components .ed-component-row .ed-btn'); await p.waitForTimeout(250)
  const d6 = await doc()
  const copy = d6.slides[1].elements.filter((e) => e.component && !e.component.main)
  const sel6 = await selection()
  const over = copy.some((c) => d6.slides[1].elements.filter((e) => !e.component).some((o) => c.x < o.x + o.w && o.x < c.x + c.w && c.y < o.y + o.h && o.y < c.y + c.h))
  ok(copy.length === 2 && sel6 === copy.map((c) => c.id).sort().join() && !over, `Insert puts the copy on free space and selects it (overlap ${over})`)
  const head = await p.evaluate(() => document.querySelector('.ed-props .ed-comp-title')?.textContent ?? '')
  ok(/◇/.test(head) && /copy/i.test(head), `a copy's inspector says what it is ("${head}")`)
  const goMain = p.locator('.ed-props .ed-comp-acts .ed-btn', { hasText: 'Go to main' })
  if (await goMain.count()) { await goMain.click({ timeout: 1500 }).catch(() => {}); await p.waitForTimeout(250) }
  ok((await current()) === 0 && (await selection()) === 'a,t1', 'Go to main selects the main on its slide')
  // a local edit on the copy, then Reset overrides
  // the copy edited elsewhere (an older shell): reopened, its difference reads as an override
  await p.evaluate(([id]) => { const d = JSON.parse(JSON.stringify(window.bento.doc)); d.slides[1].elements.find((e) => e.id === id).fill = '#00ff00'; window.bento.loadDoc(JSON.stringify(d)) }, [copy.find((c) => c.type === 'shape').id])
  await p.waitForTimeout(200)
  await goSlide(1); await sideView('layers'); await p.waitForTimeout(100); await select(copy.find((c) => c.type === 'shape').id)
  const reset = p.locator('.ed-props .ed-comp-acts .ed-btn', { hasText: 'Reset overrides' })
  if (await reset.count()) { await reset.click({ timeout: 1500 }).catch(() => {}); await p.waitForTimeout(250) }
  ok((await el(copy.find((c) => c.type === 'shape').id))?.fill === '#123456', 'Reset overrides brings the copy back to its main')
  await goSlide(0); await p.waitForTimeout(200); await select('a')
  const part = await p.evaluate(() => [...document.querySelectorAll('.ed-props .ed-comp-acts .ed-btn')].map((b) => b.textContent).join())
  ok(/Remove from component/.test(part), `detaching part of a main reads "Remove from component" (${part})`)
  await select('a'); await select('t1', true)
  dialogs = 0
  await p.keyboard.press('Backspace'); await p.waitForTimeout(300)
  const d7 = await doc()
  ok(dialogs === 1, 'deleting a main with copies asks first')
  ok(d7.slides[1].elements.filter((e) => e.component?.main).length === 2, '…and the copy becomes the new main')

  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' / ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
