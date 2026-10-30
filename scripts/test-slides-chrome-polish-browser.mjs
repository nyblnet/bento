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
    const { p, ctx } = await open({ locale, width: 1280 })
    await p.evaluate(() => document.querySelector('.ed-stage-scale [data-el-id]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await p.waitForTimeout(300)
    // drag each resizer far past where it may go
    for (const [i, dx] of [[0, -600], [1, 600]]) {
      const h = await p.locator('.ed-resizer').nth(i).boundingBox()
      await p.mouse.move(h.x + h.width / 2, h.y + 200)
      await p.mouse.down()
      await p.mouse.move(h.x + h.width / 2 + dx, h.y + 200, { steps: 8 })
      await p.mouse.up()
      await p.waitForTimeout(250)
    }
    const bars = await p.evaluate(() => [...document.querySelectorAll('.ed-sidebar .ed-icon-tabs, .ed-props .ed-icon-tabs, .ed-props .ed-tabs')].filter((b, i, a) => a.indexOf(b) === i).map((bar) => {
      const r = bar.getBoundingClientRect()
      const panel = bar.closest('.ed-sidebar, .ed-props').getBoundingClientRect()
      const tabs = [...bar.querySelectorAll(':scope > button')].map((b) => {
        const br = b.getBoundingClientRect()
        const n = b.querySelector('.ed-tab-name')
        const shown = !!n && getComputedStyle(n).display !== 'none'
        return { l: br.left, r: br.right, on: b.getAttribute('aria-selected') === 'true', glyph: !!b.querySelector('svg'), shown, cut: shown && n.scrollWidth > n.clientWidth + 1, named: !!(b.getAttribute('aria-label') || b.title) }
      })
      return { side: !!bar.closest('.ed-sidebar'), w: Math.round(panel.width), l: r.left, r: r.right, tabs }
    }))
    ok(bars.length === 2, `${locale}: one icon-tab bar on each side (${bars.length})`)
    for (const bar of bars) {
      const where = `${locale} ${bar.side ? 'side' : 'inspector'} tabs at ${bar.w}px`
      ok(bar.w > 0 && bar.w < 400, `${where}: the drag stopped at the panel's minimum`)
      ok(bar.tabs.every((t) => t.glyph), `${where}: every tab has its glyph`)
      ok(bar.tabs.every((t) => t.l >= bar.l - 0.5 && t.r <= bar.r + 0.5) && bar.tabs.every((t, i) => i === 0 || t.l >= bar.tabs[i - 1].r - 0.5), `${where}: no tab over another or outside the bar`)
      const sel = bar.tabs.find((t) => t.on)
      ok(!!sel && sel.shown && !sel.cut, `${where}: the chosen tab's name shows whole`)
      const others = bar.tabs.filter((t) => !t.on)
      ok(others.every((t) => t.shown && !t.cut) || others.every((t) => !t.shown), `${where}: the other tabs are all named or all glyphs — never a cut word`)
      ok(bar.tabs.every((t) => t.named), `${where}: every tab keeps its full name for the hint and screen readers`)
    }
    await ctx.close()
  })
}

await run(async () => {
  const { p, ctx } = await open({ locale: 'pt-BR' })
  const tabs = await p.evaluate(() => [...document.querySelectorAll('.ed-props .ed-tabs > button')].map((b) => ({ glyph: !!b.querySelector('svg'), on: b.getAttribute('aria-selected') === 'true', name: getComputedStyle(b.querySelector('.ed-tab-name') ?? b).display !== 'none' })))
  ok(tabs.length === 3 && tabs.every((t) => t.glyph), 'the inspector tabs carry glyphs, like the side column')
  ok(!!tabs.find((t) => t.on)?.name && (tabs.every((t) => t.name) || tabs.filter((t) => t.name).length === 1), 'the chosen tab says its name; the others all do or none do')
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

// ---------------------------------------------------------------- 4
console.log('\n4. one home for the deck\'s colours, and one token picker\n')
await run(async () => {
  const { p, ctx, errors } = await open({ slides: [slide('s1', [rect('r', 100)]), slide('s2')] })
  const el = () => p.evaluate(() => JSON.parse(JSON.stringify(window.bento.doc.slides[0].elements[0])))
  const undo = async () => { await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(250) }
  // the slide's Theme section: no colours, a way to where they live
  await p.evaluate(() => window.bento.store?.select?.([]))
  await p.mouse.click(5, 450) // nothing selected: the slide's panel
  await p.waitForTimeout(300)
  const theme = await p.evaluate(() => {
    const head = [...document.querySelectorAll('.ed-props .ed-section')].find((h) => h.dataset.key === 'Theme')
    const body = head?.nextElementSibling
    return head ? { colours: body?.querySelectorAll('input[type=color]').length ?? 0, link: !!body?.querySelector('.ed-theme-tokens') } : null
  })
  ok(!!theme && theme.colours === 0 && theme.link, `the slide's Theme section lists no colours, only the way to Tokens (${JSON.stringify(theme)})`)
  ok(!(await p.locator('.ed-props .ed-section[data-key="Code colors"]').count()), 'a deck with no code has no Code colors section')
  await p.locator('.ed-props .ed-theme-tokens').click()
  await p.waitForTimeout(250)
  ok((await p.getAttribute('.ed-sidebar', 'data-view')) === 'tokens', 'its link opens the Tokens view')

  // the Tokens view: the theme colours as a built-in group, a slot added from +
  const builtins = await p.evaluate(() => [...document.querySelectorAll('.ed-tokens-group[data-type="color"] .ed-token-builtin')].map((r) => r.dataset.slot))
  ok(JSON.stringify(builtins) === JSON.stringify(['bg1', 'tx1', 'accent1']), `Theme lists Background, Text, Accent 1 (${builtins.join(',')})`)
  ok(!(await p.locator('.ed-token-badge').count()), 'no per-row Theme badge — the group says it')
  await p.locator('.ed-tokens-sub .ed-tokens-add').click()
  await p.waitForTimeout(150)
  await p.locator('.ed-ctxmenu button, .ed-ctxmenu [role=menuitem]').filter({ hasText: /Accent 3/ }).first().click()
  await p.waitForTimeout(300)
  ok(await p.evaluate(() => !!window.bento.doc.theme.palette?.accent3), 'Theme ＋ adds Accent 3 to the palette')

  // the shape's fill follows Accent 3 from the picker — one undo step
  await p.evaluate(() => document.querySelector('.ed-layer[data-id="r"], .ed-side-layers [data-id="r"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await p.evaluate(() => { const r = document.querySelector('.ed-stage-scale [data-el-id="r"]'); r?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 })) })
  await p.evaluate(() => window.bento.select?.(['r']) ?? null)
  await p.waitForTimeout(300)
  if (!(await p.locator('.ed-props button[aria-label="Colors & tokens"]').count())) {
    const box = await p.locator('.ed-stage-scale [data-el-id="r"]').boundingBox()
    await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await p.waitForTimeout(300)
  }
  await p.locator('.ed-props button[aria-label="Colors & tokens"]').first().click()
  await p.waitForTimeout(250)
  const groups = await p.evaluate(() => [...document.querySelectorAll('.ed-tokpick .ed-morph-pick-h')].map((h) => h.textContent))
  ok(groups[0] === 'Theme', `the colour picker opens on the Theme group (${groups.join(' · ')})`)
  ok(!!(await p.locator('.ed-tokpick input[type=search]').count()) && !!(await p.locator('.ed-tokpick-foot').count()), 'with a search box, and its actions as a list at the foot')
  await p.locator('.ed-tokpick input[type=search]').fill('accent 3')
  ok((await p.locator('.ed-tokpick-opt:not([hidden])').count()) === 1, 'typing filters the rows')
  await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter')
  await p.waitForTimeout(300)
  let r = await el()
  ok(r.themeRefs?.fill === 'accent3' && r.fill.toLowerCase().startsWith(await p.evaluate(() => window.bento.doc.theme.palette.accent3.toLowerCase())), `picking Accent 3 makes the fill follow it (${r.themeRefs?.fill}, ${r.fill})`)
  ok(!!(await p.locator('.ed-props .ed-color-token-name').filter({ hasText: 'Accent 3' }).count()), 'the field shows Accent 3 as a pill')
  await undo()
  r = await el()
  ok(!r.themeRefs?.fill && r.fill === '#ff0000', 'one undo lets go of it')
  await p.evaluate(() => window.bento.redo()); await p.waitForTimeout(250)

  // editing Accent 3 in the Tokens view re-colours the shape — one undo step
  await p.click('.ed-side-tabs [data-view="tokens"]'); await p.waitForTimeout(250)
  const val = p.locator('.ed-token-builtin[data-slot="accent3"] .ed-token-value')
  await val.click()
  const field = p.locator('.ed-token-builtin[data-slot="accent3"] input.ed-edit-field')
  ok(await field.count() === 1, 'a click on the value turns the text into a field')
  await field.fill('123456'); await field.press('Enter')
  await p.waitForTimeout(400)
  ok(!(await p.locator('.ed-side-tokens input.ed-edit-field').count()), 'Enter commits and the field is text again')
  r = await el()
  ok(r.fill.toLowerCase().startsWith('#123456'), `the shape follows the new Accent 3 (${r.fill})`)
  await undo()
  r = await el()
  ok(!r.fill.toLowerCase().startsWith('#123456') && r.themeRefs?.fill === 'accent3', 'one undo puts Accent 3 and the shape back')

  // a number field: the dot opens the same picker; a made token binds; the pill reopens it
  await p.evaluate(() => { const d = window.bento.doc; d.theme.tokens = { set: { 'space.md': { type: 'number', values: { default: 24 } } } } })
  await p.evaluate(() => window.bento.store?.emit?.('doc'))
  const radius = p.locator('.ed-props .ed-mini:has(input[aria-label="Corner radius"]) .ed-token-dot')
  if (await radius.count()) {
    await radius.evaluate((d) => d.click()); await p.waitForTimeout(250)
    ok(!!(await p.locator('.ed-tokpick').count()), 'a number field\'s dot opens the same picker')
    await p.locator('.ed-tokpick-act').filter({ hasText: /token from this value/ }).click(); await p.waitForTimeout(300)
    r = await el()
    ok(/^\$/.test(r.themeRefs?.radius ?? ''), `"Make a token from this value" binds the field to a new token (${r.themeRefs?.radius})`)
    await p.locator('.ed-props .ed-token-pill-name').first().click(); await p.waitForTimeout(250)
    ok(!!(await p.locator('.ed-tokpick-opt[aria-selected="true"]').count()), 'the pill reopens the picker with its token checked')
    await p.keyboard.press('Escape')
  } else ok(false, 'the corner radius field has a token dot')

  // a token's name edits in place and returns to text
  await p.click('.ed-side-tabs [data-view="tokens"]'); await p.waitForTimeout(250)
  const nm = p.locator('.ed-token-row[data-token] .ed-token-name').first()
  const before = await nm.textContent()
  await nm.click()
  await p.locator('.ed-token-row[data-token] input.ed-edit-field').fill('space.lg'); await p.keyboard.press('Enter')
  await p.waitForTimeout(350)
  ok(!(await p.locator('.ed-side-tokens input.ed-edit-field').count()) && (await p.locator('.ed-token-row[data-token="space.lg"] .ed-token-name').textContent()) === 'space.lg', `a renamed token reads as text again (${before} → space.lg)`)
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  await ctx.close()
})

await run(async () => {
  // (b) a literal that already IS a theme colour binds to it, not to a twin token;
  // (a) a multi-selection binds every element and shows the shared pill
  const { p, ctx, errors } = await open({ slides: [slide('s1', [rect('a', 100, { fill: '#ff9e8a' }), rect('b', 400, { fill: '#ff9e8a' }), rect('c', 700)])] })
  await p.evaluate(() => { window.bento.doc.theme.accent = '#ff9e8a' })
  const els = () => p.evaluate(() => JSON.parse(JSON.stringify(window.bento.doc.slides[0].elements)))
  const pickLayers = async (...ids) => { await p.evaluate((ids) => ids.forEach((id, i) => document.querySelector(`.ed-layer[data-id="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: i > 0 }))), ids); await p.waitForTimeout(300) }
  await pickLayers('a')
  await p.locator('.ed-props button[aria-label="Colors & tokens"]').first().click(); await p.waitForTimeout(250)
  const acts = await p.locator('.ed-tokpick-act').allTextContents()
  ok(acts.some((a) => /Bind 2 uses to Accent 1/.test(a)) && !acts.some((a) => /Make a token/.test(a)), `a colour equal to Accent 1 offers to bind its uses to Accent 1 (${acts.join(' / ')})`)
  await p.locator('.ed-tokpick-act').filter({ hasText: /Bind 2 uses/ }).click(); await p.waitForTimeout(300)
  let e = await els()
  ok(e[0].themeRefs?.fill === 'accent1' && e[1].themeRefs?.fill === 'accent1' && !(await p.evaluate(() => Object.keys(window.bento.doc.theme.tokens?.set ?? {}).length)), 'both uses now follow Accent 1, and no duplicate token was made')
  await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(250)
  e = await els()
  ok(!e[0].themeRefs?.fill && !e[1].themeRefs?.fill, 'one undo takes it back')
  await pickLayers('a', 'b', 'c')
  const btn = p.locator('.ed-props [data-shared="fill"] button[aria-label="Colors & tokens"]')
  ok(await btn.count() === 1, 'a multi-selection\'s Fill has the token picker')
  await btn.click(); await p.waitForTimeout(250)
  await p.locator('.ed-tokpick-opt[data-key="accent1"]').click(); await p.waitForTimeout(300)
  e = await els()
  ok(e.every((x) => x.themeRefs?.fill === 'accent1'), 'picking Accent 1 binds all three')
  ok(await p.locator('.ed-props [data-shared="fill"] .ed-color-token-name').filter({ hasText: 'Accent 1' }).count() === 1, 'and the shared field shows the Accent 1 pill')
  await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(250)
  e = await els()
  ok(e.every((x) => !x.themeRefs?.fill), 'one undo lets go of all three')
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  await ctx.close()
})

await run(async () => {
  const code = { id: 'c', type: 'code', x: 100, y: 100, w: 400, h: 200, rotation: 0, opacity: 1, code: 'let x = 1', lang: 'js', fontSize: 18, fontFamily: 'monospace' }
  const { p, ctx } = await open({ slides: [slide('s1', [code])] })
  await p.mouse.click(5, 450); await p.waitForTimeout(300)
  const sec = await p.evaluate(() => { const h = [...document.querySelectorAll('.ed-props .ed-section')].find((x) => x.dataset.key === 'Code colors'); return h ? { closed: h.classList.contains('closed'), rows: h.nextElementSibling?.querySelectorAll('input[type=color]').length } : null })
  ok(!!sec && sec.closed && sec.rows > 0, `a deck with code has its own Code colors section, folded (${JSON.stringify(sec)})`)
  await ctx.close()
})

await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
