// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The UX audit's inspector behaviour, held where it was fixed
// (docs/audit/ux-pyramid-2026-10-30.md).
//
//   npm run build:single --prefix slides && node scripts/test-slides-ux-inspector-browser.mjs
//   SHELL_HTML=/path/to/older.bento.html node scripts/test-slides-ux-inspector-browser.mjs   (it fails there)
//
// WHAT THIS PROVES
//   1. The arrange toolbars: every tool is clickable — none covered by
//      another, none outside the panel — with 1, 2 and 3 shapes selected, at
//      1280 and 1440 wide, in English, German and Portuguese. ⌥A aligns left,
//      ⌃⌥H spaces evenly, the tooltip names the key, and a turned element
//      lines up by the box it covers on the slide.
//   2. Several shapes show Fill, Stroke and Shadow: a fill they disagree on
//      reads Mixed, one typed colour sets all three, one undo takes it back.
//   3. A frame's child offers no align (its frame places it), its X/Y are
//      read-only, a nested frame shows Resizing with Hug, Fill is refused
//      where the parent hugs, and W follows a layout change at once. Its
//      sizing rows say how it follows its frame and live on Format only.
//   4. Number fields: "abc" is refused with a reason (not silently); Esc puts
//      the value back and leaves the field; ⌘Z in a field is the document's
//      undo; "1,000" is a thousand in English.
//   5. The colour popover: one Solid | Linear | Radial (in the popover, not
//      also on the row); a theme colour picked onto a 0% fill is opaque; a
//      transparent fill reads None; the swatch has a name; a hex typed into
//      an unpainted fill (a frame's 'transparent', one or several) comes in
//      at 100%, unless it carries its own alpha; a fill set to 0% keeps it.
//   6. A paint layer row is grip · eye · paint · ⋯ with its blend behind ⋯,
//      and nothing in it leaves the panel at 1024 wide.
//   7. Focus: after + Add shadow it lands in the Shadow section, after a
//      toolbar button it stays on that button; a section header folds from
//      the keyboard; the alignment box is one tab stop, ↓ moves a row.
//   8. The Stroke line's Position never runs under its Weight, at 1280 and
//      1440 wide, in English and German.
//   9. A gradient fill's ⠿ (colours & tokens) is off and says why.
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const SHELL = process.env.SHELL_HTML || fileURLToPath(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url))

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const shape = (id, x, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y: 100, w: 200, h: 100, rotation: 0, opacity: 1, fill: '#ff0000', stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })

// a section that throws (an older build lacks what it drives) counts as one
// failure and the next section still runs
const run = async (fn) => { try { await fn() } catch (e) { ok(false, `threw: ${String(e.message).split('\n')[0]}`) } }
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const open = async (locale, width, els) => {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, locale })
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1'); localStorage.setItem('bento-panel-tab', '"format"') } catch {} })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-props .ed-tabs'))
  await p.evaluate((els) => { const d = JSON.parse(JSON.stringify(window.bento.doc)); d.slides = [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: els }]; window.bento.loadDoc(JSON.stringify(d)) }, els)
  await p.waitForTimeout(300)
  const select = async (...ids) => { await p.evaluate((ids) => { ids.forEach((id, i) => document.querySelector(`.ed-layer[data-id="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: i > 0 }))) }, ids); await p.waitForTimeout(250) }
  const el = (id) => p.evaluate((id) => JSON.parse(JSON.stringify(window.bento.doc.slides[0].elements.find((e) => e.id === id) ?? null)), id)
  const undo = async () => { await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(200) }
  return { ctx, p, errors, select, el, undo }
}
// every tool's centre hits that tool, inside the panel
const toolsClear = (p) => p.evaluate(() => {
  const host = document.querySelector('.ed-props').getBoundingClientRect()
  const tools = [...document.querySelectorAll('.ed-props .ed-layer-block .ed-toolbar .ed-tool')]
  const bad = tools.filter((b) => {
    const r = b.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return r.left < host.left || r.right > host.right || !(hit === b || b.contains(hit))
  })
  return { n: tools.length, bad: bad.map((b) => b.getAttribute('aria-label')) }
})

try {
  console.log('\n1. the arrange toolbars\n')
  for (const [locale, width] of [['en-US', 1440], ['en-US', 1280], ['de-DE', 1280], ['pt-BR', 1280]]) {
    const { ctx, p, select } = await open(locale, width, [shape('a', 100), shape('b', 500), shape('c', 900, { fill: '#00ff00' })])
    for (const ids of [['a'], ['a', 'b'], ['a', 'b', 'c']]) {
      await select(...ids)
      const r = await toolsClear(p)
      ok(r.n > 0 && r.bad.length === 0, `[${locale} ${width}] ${ids.length} selected: all ${r.n} tools clickable${r.bad.length ? ` — covered or out: ${r.bad.join(', ')}` : ''}`)
    }
    await ctx.close()
  }
  await run(async () => {
    const { ctx, p, select, el, undo } = await open('en-US', 1440, [shape('a', 100), shape('b', 500, { y: 300 }), shape('c', 1000, { y: 500 }), shape('r', 600, { y: 700, rotation: 90 })])
    await select('a', 'b', 'c')
    await p.mouse.move(700, 950) // over nothing; keys go to the editor
    await p.keyboard.press('Alt+KeyA'); await p.waitForTimeout(200)
    ok((await el('b')).x === 100 && (await el('c')).x === 100, `⌥A aligns the selection left (b ${(await el('b')).x}, c ${(await el('c')).x})`)
    await undo()
    await p.keyboard.press('Control+Alt+KeyH'); await p.waitForTimeout(200)
    ok(Math.abs((await el('b')).x - 550) < 0.5, `⌃⌥H spaces them evenly across (b at ${(await el('b')).x}, expected 550)`)
    await undo()
    const tip = await p.locator('.ed-props .ed-toolbar .ed-tool[aria-label="Align left"]').getAttribute('title')
    ok(/⌥A/.test(tip ?? ''), `the Align left tooltip names its key (${tip})`)
    // r is 200×100 turned 90°: it covers x 650..750 on the slide; aligning left with a puts that edge at 100
    await select('a', 'r')
    await p.locator('.ed-props .ed-toolbar .ed-tool[aria-label="Align left"]').click(); await p.waitForTimeout(200)
    const r = await el('r')
    ok(Math.abs(r.x + r.w / 2 - r.h / 2 - 100) < 0.5, `a turned element aligns by the box it covers (left edge ${r.x + r.w / 2 - r.h / 2})`)
    ok(await p.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Align left', '7. focus stays on the toolbar button after its action rebuilt the panel')
    await ctx.close()
  })

  console.log('\n2. several shapes: Fill, Stroke, Shadow\n')
  await run(async () => {
    const { ctx, p, select, el, undo } = await open('en-US', 1440, [shape('a', 100), shape('b', 500, { fill: '#0000ff' }), shape('c', 900)])
    await select('a', 'b', 'c')
    const fill = p.locator('.ed-props .ed-section[data-key="Fill"] + .ed-section-body')
    ok(await fill.count() === 1 && await p.locator('.ed-props .ed-section[data-key="Stroke"]').count() === 1 && await p.locator('.ed-props .ed-section[data-key="Shadow"]').count() === 1, 'a three-shape selection shows Fill, Stroke and Shadow')
    const hex = fill.locator('.ed-color-hex')
    ok(await hex.count() === 1 && (await hex.inputValue()) === '' && (await hex.getAttribute('placeholder')) === 'Mixed', 'fills they disagree on read Mixed')
    await hex.fill('00ff00'); await hex.press('Enter'); await p.waitForTimeout(250)
    ok([await el('a'), await el('b'), await el('c')].every((e) => e.fill === 'rgba(0, 255, 0, 1)' || e.fill === '#00ff00'), `one typed colour sets all three (${(await el('b')).fill})`)
    await undo()
    ok((await el('a')).fill === '#ff0000' && (await el('b')).fill === '#0000ff', 'one undo takes all three back')
    await p.evaluate(() => document.activeElement?.blur())
    await p.locator('.ed-props .ed-section[data-key="Shadow"] .ed-sec-act').click(); await p.waitForTimeout(250)
    ok([await el('a'), await el('b'), await el('c')].every((e) => e.shadow), '+ on Shadow gives all three a shadow')
    ok(await p.evaluate(() => !!document.activeElement?.closest('.ed-props .ed-section[data-key="Shadow"] + .ed-section-body, .ed-props .ed-section[data-key="Shadow"]')), '7. after + Add shadow, focus is in the Shadow section, not on <body>')
    await ctx.close()
  })

  console.log('\n3. a frame and its children\n')
  await run(async () => {
    const frame = shape('F', 100, { w: 432, h: 132, fill: '#eeeeee', layout: { dir: 'row', gap: 16, pad: [16, 16, 16, 16], hug: true } })
    const inner = shape('G', 116, { y: 116, w: 200, h: 100, fill: '#dddddd', parentId: 'F', layout: { dir: 'col', gap: 8, pad: [8, 8, 8, 8], hug: true } })
    const leaf = shape('k', 332, { y: 116, parentId: 'F' })
    const { ctx, p, select, el } = await open('en-US', 1440, [frame, inner, leaf, shape('z', 1000, { y: 500 })])
    await p.waitForTimeout(300)
    await select('k')
    ok(await p.locator('.ed-props .ed-toolbar[aria-label="Align"], .ed-props .ed-toolbar .ed-tool[aria-label="Align left"]').count() === 0, "a frame's child offers no align")
    const x = p.locator('.ed-props .ed-layer-block .ed-mini', { has: p.locator(':scope > span', { hasText: /^X$/ }) }).locator('input')
    ok(await x.evaluate((i) => i.readOnly), 'its X is read-only (the frame places it)')
    await select('G')
    // the sizing rows sit right under W/H, in the header-less top block (Figma keeps them there)
    const resizing = p.locator('.ed-props .ed-row:has([data-axis])')
    const under = await p.evaluate(() => { const r = document.querySelector('.ed-props .ed-row:has([data-axis])'); return !!r?.parentElement?.classList.contains('ed-layer-block') && !document.querySelector('.ed-props .ed-section[data-key="Resizing"]') })
    ok(await resizing.count() === 2 && await resizing.locator('[data-value="hug"]').count() === 2 && under, 'a nested frame shows its sizing right under W/H, with Hug on both axes')
    ok(await resizing.locator('[data-value="fill"]').first().isDisabled(), 'Fill is refused where the parent hugs')
    // they say how the child takes its size, not the page size's "Custom slide width"
    const tips = await resizing.evaluateAll((rs) => rs.map((r) => r.title))
    ok(tips.length === 2 && tips.every((x) => /frame/i.test(x) && !/slide/i.test(x)), `the sizing rows' hints are about the frame (${tips.join(' | ')})`)
    // how it is sized is how it looks: Format only (one home per control)
    const shown = []
    for (const tab of await p.locator('.ed-props .ed-tabs [role=tab]').all()) {
      await tab.click(); await p.waitForTimeout(100)
      shown.push(`${(await tab.getAttribute('aria-label')) || (await tab.textContent()).trim()}:${await resizing.evaluateAll((rs) => rs.filter((r) => r.offsetParent).length)}`)
    }
    await p.locator('.ed-props .ed-tabs [role=tab]').first().click(); await p.waitForTimeout(100)
    ok(shown.join() === 'Format:2,Animate:0,Interact:0', `the sizing rows show on Format only (${shown.join(', ')})`)
    ok(await p.locator('.ed-props .ed-section[data-key="Auto layout"]').count() === 1, '…and its own Auto layout below')
    await select('F')
    const before = (await el('F')).w
    const gap = p.locator('.ed-props .ed-section[data-key="Auto layout"] + .ed-section-body input[aria-label="Gap"]')
    await gap.fill('40'); await gap.press('Enter'); await p.evaluate(() => document.activeElement?.blur()); await p.waitForTimeout(300)
    const w = await p.locator('.ed-props .ed-layer-block .ed-mini', { has: p.locator(':scope > span', { hasText: /^W$/ }) }).locator('input').inputValue()
    const fw = (await el('F')).w
    ok(fw === before + 24 && +w === fw, `W follows the layout at once (field ${w}, frame ${before} → ${fw})`)
    await ctx.close()
  })

  console.log('\n4. number fields\n')
  await run(async () => {
    const { ctx, p, select, el } = await open('en-US', 1440, [shape('a', 100)])
    await select('a')
    const field = (l) => p.locator('.ed-props .ed-layer-block .ed-mini', { has: p.locator(':scope > span', { hasText: new RegExp(`^${l}$`) }) }).locator('input')
    await field('X').fill('abc'); await field('X').press('Enter'); await p.waitForTimeout(150)
    const why = await p.locator('.ed-num-why').textContent().catch(() => '')
    ok((await field('X').inputValue()) === '100' && /isn’t a number/.test(why ?? '') && await field('X').getAttribute('aria-invalid') === 'true', `"abc" is refused, with a reason (${why})`)
    await field('X').fill('999'); await field('X').press('Escape'); await p.waitForTimeout(150)
    ok((await el('a')).x === 100 && await p.evaluate(() => !document.activeElement?.closest('.ed-props')), 'Esc puts the value back and leaves the field')
    await field('X').fill('300'); await field('X').press('Enter'); await p.waitForTimeout(250)
    ok((await el('a')).x === 300, 'Enter commits')
    await field('X').fill('77'); await field('X').press('Meta+z'); await p.waitForTimeout(250)
    ok((await el('a')).x === 100, `⌘Z in the field is the document's undo (x ${(await el('a')).x})`)
    await field('W').fill('1,000'); await field('W').press('Enter'); await p.waitForTimeout(250)
    ok((await el('a')).w === 1000, `"1,000" is a thousand in English (${(await el('a')).w})`)
    await ctx.close()
  })

  console.log('\n5. the colour popover and row\n')
  await run(async () => {
    const { ctx, p, select, el } = await open('en-US', 1440, [shape('a', 100, { fill: 'rgba(255, 0, 0, 0)' }), shape('g', 500, { fillGradient: { angle: 90, stops: [{ at: 0, color: '#ff0000' }, { at: 1, color: '#0000ff' }] } })])
    await select('g')
    ok(await p.locator('.ed-props .ed-seg[aria-label="Fill style"]').count() === 0, 'the fill row carries no second Solid | Linear | Radial')
    await select('a')
    const body = p.locator('.ed-props .ed-section[data-key="Fill"] + .ed-section-body')
    ok(await body.locator('.ed-color-hex').getAttribute('placeholder') === 'None' && (await body.locator('.ed-color-hex').inputValue()) === '', 'a transparent fill reads None')
    ok(!!(await body.locator('input[type=color]').getAttribute('aria-label')), 'the swatch has an accessible name')
    await p.locator('.ed-props .ed-section[data-key="Fill"] .ed-sec-cat').click()
    await p.locator('.ed-tokpick-opt').first().click(); await p.waitForTimeout(250)
    const f = (await el('a')).fill
    ok(!/,\s*0\)$/.test(f) && (await el('a')).themeRefs?.fill, `a theme colour picked onto a 0% fill is opaque (${f})`)
    await ctx.close()
  })
  await run(async () => {
    // a hex typed into an unpainted fill (an auto-layout frame's 'transparent')
    // shows: 100%, unless the typing carried an alpha; a fill set to 0% keeps it
    const clear = (id, x) => shape(id, x, { fill: 'transparent', layout: { dir: 'row', gap: 16, pad: [16, 16, 16, 16] } })
    const { ctx, p, select, el, undo } = await open('en-US', 1440, [clear('a', 100), clear('b', 500), clear('c', 900), shape('z', 100, { y: 400, fill: 'rgba(255, 0, 0, 0)' })])
    const hex = p.locator('.ed-props .ed-section[data-key="Fill"] + .ed-section-body .ed-color-hex')
    // the alpha of a stored colour: rgba(…, a), #rrggbbaa, else opaque
    const alpha = (c) => { const m = /rgba\([^)]*,\s*([\d.]+)\)/.exec(c); if (m) return Number(m[1]); const h = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(c); return h ? parseInt(h[1], 16) / 255 : 1 }
    // one unfilled frame shows + (no colour row); several share one colour row, reading None
    const all3 = async () => [await el('a'), await el('b'), await el('c')]
    await select('a', 'b', 'c')
    await hex.fill('0000ff'); await hex.press('Enter'); await p.waitForTimeout(250)
    ok((await all3()).every((e) => alpha(e.fill) === 1), `several frames with no fill: one typed hex comes in at 100% on all (${(await el('b')).fill})`)
    await undo()
    await select('a', 'b', 'c')
    await hex.fill('0000ff80'); await hex.press('Enter'); await p.waitForTimeout(250)
    ok((await all3()).every((e) => Math.abs(alpha(e.fill) - 0.5) < 0.01), `…unless the typing carries its own alpha (${(await el('b')).fill})`)
    await undo()
    await select('z')
    await hex.fill('00ff00'); await hex.press('Enter'); await p.waitForTimeout(250)
    ok(alpha((await el('z')).fill) === 0, `a fill set to 0% keeps its 0% when a hex is typed (${(await el('z')).fill})`)
    await ctx.close()
  })

  console.log('\n6. a paint layer row\n')
  await run(async () => {
    const st = shape('s', 100, { fills: [{ color: '#ff0000' }, { color: '#00ff00', blend: 'multiply' }], fill: '#00ff00' })
    const { ctx, p, select } = await open('en-US', 1024, [st])
    await select('s')
    const row = p.locator('.ed-props .ed-paintlayer').first()
    const fit = await row.evaluate((r) => {
      const host = document.querySelector('.ed-props').getBoundingClientRect()
      const hex = r.querySelector('.ed-color-hex')?.getBoundingClientRect()
      return [...r.querySelectorAll('*')].every((n) => { const b = n.getBoundingClientRect(); return !b.width || (b.left >= host.left - 0.5 && b.right <= host.right + 0.5) }) && (hex?.width ?? 0) >= 40
    })
    ok(fit, 'at 1024 wide the row stays in the panel and the hex has room')
    ok(await row.locator('.ed-paint-eye').count() === 1 && await row.locator('.ed-paint-remove').count() === 1 && !(await p.locator('.ed-props .ed-layer-blend').first().isVisible()), "the row is Figma's paint · 👁 · −, its blend kept out of the way")
    await row.click({ button: 'right', position: { x: 4, y: 13 } }); await p.waitForTimeout(150)
    ok(await p.locator('.ed-props .ed-layer-blend').first().isVisible(), 'a right-click on the row shows the blend')
    await ctx.close()
  })
  await run(async () => {
    // a stack is the element's own: a multi-selection whose fills differ keeps
    // its Fill header and says why there is nothing to edit, never vanishes
    const st = shape('s', 100, { fills: [{ color: '#ff0000' }, { color: '#00ff00', blend: 'multiply' }], fill: '#00ff00' })
    const { ctx, p, select } = await open('en-US', 1440, [st, shape('t', 500)])
    await select('s', 't')
    const note = p.locator('.ed-props .ed-section[data-key="Fill"] + .ed-section-body .ed-fill-differ')
    ok(await note.isVisible() && (await note.textContent()) === 'Each has its own fill layers — select one to edit' && !(await p.locator('.ed-props [data-shared="fill"]').count()),
      'differing fill stacks: the Fill header stays, with "Each has its own fill layers — select one to edit" and no shared field')
    await ctx.close()
  })

  console.log('\n7. keyboard\n')
  await run(async () => {
    const frame = shape('F', 100, { w: 432, h: 132, layout: { dir: 'row', gap: 16, pad: [16, 16, 16, 16] } })
    const { ctx, p, select, errors } = await open('en-US', 1440, [frame])
    await select('F')
    const head = p.locator('.ed-props .ed-section[data-key="Auto layout"]')
    await head.focus()
    ok(await head.evaluate((h) => document.activeElement === h && h.getAttribute('aria-expanded') === 'true'), 'a section header takes focus and says it is open')
    await p.keyboard.press('Enter'); await p.waitForTimeout(250)
    ok(await head.getAttribute('aria-expanded') === 'false', 'Enter folds it')
    await p.keyboard.press('Enter'); await p.waitForTimeout(250)
    const cells = p.locator('.ed-props .ed-align-matrix button')
    ok(await cells.count() === 9 && await cells.evaluateAll((bs) => bs.filter((b) => b.tabIndex === 0).length) === 1, 'the alignment box is one tab stop')
    await cells.first().focus()
    await p.keyboard.press('ArrowDown'); await p.waitForTimeout(250)
    ok(await p.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Left', `↓ moves a whole row (now ${await p.evaluate(() => document.activeElement?.getAttribute('aria-label'))})`)
    ok(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
    await ctx.close()
  })
  await run(async () => {
    // a shadow just added hands focus to its chip; → there is the chip's (the
    // next preset), never the canvas's nudge of the card
    const { ctx, p, select, el } = await open('en-US', 1440, [shape('c', 100)])
    await select('c')
    // a plain button owns no arrows: after a + (focus stays on it), → nudges
    await p.click('.ed-props .ed-section[data-key="Fill"] button[aria-label="Add fill layer"]'); await p.waitForTimeout(250)
    const onPlus = await p.evaluate(() => document.activeElement?.getAttribute('aria-label'))
    await p.keyboard.press('ArrowRight'); await p.waitForTimeout(250)
    const x1 = (await el('c')).x
    ok(onPlus === 'Add fill layer' && x1 === 101, `→ on a section's + (focus on "${onPlus}") still nudges the card (x ${x1})`)
    await p.click('.ed-props .ed-section[data-key="Shadow"] button[aria-label="Add shadow"]'); await p.waitForTimeout(250)
    const s0 = JSON.stringify((await el('c')).shadow)
    await p.keyboard.press('ArrowRight'); await p.waitForTimeout(250)
    const c = await el('c')
    ok(c.x === x1 && JSON.stringify(c.shadow) !== s0 && await p.evaluate(() => !!document.activeElement?.closest('.ed-props')),
      `→ on a new shadow's chip moves to the next preset and leaves the card where it is (x ${c.x}, focus ${await p.evaluate(() => document.activeElement?.className)})`)
    await ctx.close()
  })

  console.log('\n8. the Stroke line\n')
  // the position control kept its 110px field width in a column narrower
  // than that, and its "Outside" glyph ran under the weight field
  for (const [locale, width] of [['en-US', 1280], ['en-US', 1440], ['de-DE', 1280], ['de-DE', 1440]]) {
    await run(async () => {
      const { ctx, p, select } = await open(locale, width, [shape('s', 100, { stroke: '#000000', strokeWidth: 2 })])
      await select('s')
      const gap = await p.evaluate(() => {
        const seg = document.querySelector('.ed-props .ed-stroke-line > .ed-seg')?.getBoundingClientRect()
        const weight = document.querySelector('.ed-props .ed-stroke-line > :last-child')?.getBoundingClientRect()
        // and each glyph still shows whole in its narrower segment
        const whole = [...document.querySelectorAll('.ed-props .ed-stroke-line > .ed-seg button')].every((b) => b.getBoundingClientRect().width >= b.querySelector('svg').getBoundingClientRect().width + 4)
        return seg && weight && whole ? weight.left - seg.right : NaN
      })
      ok(gap >= 0, `${locale} at ${width}: Position ends before Weight begins, its glyphs whole (gap ${gap.toFixed(1)}px)`)
      await ctx.close()
    })
  }

  console.log('\n9. the ⠿ on a gradient fill\n')
  await run(async () => {
    const grad = shape('g', 100, { fillGradient: { angle: 90, stops: [{ at: 0, color: '#ff0000' }, { at: 1, color: '#0000ff' }] } })
    const { ctx, p, select } = await open('en-US', 1440, [grad, shape('s', 400)])
    const cat = p.locator('.ed-props .ed-section[data-key="Fill"] .ed-sec-cat')
    await select('g')
    // a gradient has no one colour a token could bind (refs are per layer):
    // the ⠿ says so rather than opening onto nothing
    const g = { off: await cat.isDisabled(), tip: await cat.getAttribute('title') }
    await select('s')
    ok(g.off && /gradient/i.test(g.tip) && !(await cat.isDisabled()), `a gradient fill's ⠿ is off and says why; a solid fill's works (${g.tip})`)
    await ctx.close()
  })
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
