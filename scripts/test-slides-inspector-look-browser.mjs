// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The inspector fits its column, in the longest languages, across the whole showcase deck.
//
//   npm run build:single --prefix slides && node scripts/test-slides-inspector-look-browser.mjs
//
// WHAT THIS PROVES, at the panel's default width (264px), in en, pt and de,
// for every element of every showcase slide and each slide itself, on all
// three tabs:
//   1. no visible control reaches past the panel's edge (the first audit
//      measured the bullet buttons 75px past it);
//   2. no dropdown cuts off its chosen value while a wider layout was there:
//      a row too narrow for it gives the dropdown the full width, caption
//      above (a value longer than the whole panel may then ellipsise);
//   3. align and order are ONE toolbar of icon buttons on top, each with a
//      hint; match-size and group join for two or more, even gaps for three;
//   4. a numeric pair carries its label inside the field (X 96), Penpot-style;
//   5. colours: swatch · hex · %, a typed hex is the colour; Stroke comes and
//      goes from its header's + and −; the theme's colours sit behind a
//      palette button, NAMED, and a colour taken from them shows its name in
//      the field (it follows the theme) until it is detached;
//   6. page sizes are tiles drawn at their proportions, one click each;
//      Custom opens W and H, held to 320–4000.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  for (const locale of ['en-US', 'pt-BR', 'de-DE']) {
    const tag = `[${locale}]`
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale })
    await ctx.route(/^https?:/, (r) => r.abort())
    const p = await ctx.newPage()
    const errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
    await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-props .ed-tabs'))
    const width = await p.evaluate(() => Math.round(document.querySelector('.ed-props').getBoundingClientRect().width))

    const over = new Set(), cut = new Set(), lap = new Set()
    const measure = () => p.evaluate(() => {
      const h = document.querySelector('.ed-props'), pr = h.getBoundingClientRect()
      const name = (c) => (c.closest('.ed-row')?.firstElementChild?.textContent || c.textContent || c.tagName).trim().slice(0, 32)
      const o = [...h.querySelectorAll('button, select, input, span, label, p')].filter((c) => c.offsetParent && c.getBoundingClientRect().right > pr.right - 1).map(name)
      const m = document.createElement('canvas').getContext('2d')
      // a value longer than the whole panel may ellipsise — once it HAS the full width
      const t = [...h.querySelectorAll('select')].filter((s) => s.offsetParent && !s.parentElement.classList.contains('ed-row-stack')).filter((s) => {
        m.font = getComputedStyle(s).font
        return m.measureText(s.options[s.selectedIndex]?.text ?? '').width > s.clientWidth - 20
      }).map((s) => `${name(s)}: ${s.options[s.selectedIndex]?.text}`)
      // an in-field label must end before its value starts (pt 'Desfoque atrás' once ran into its 0)
      const lap = [...h.querySelectorAll('.ed-mini')].filter((x) => x.offsetParent).filter((x) => {
        const sp = x.querySelector(':scope > span'), inp = x.querySelector('input')
        if (!sp || !inp) return false
        const l = sp.getBoundingClientRect(), f = inp.getBoundingClientRect()
        return l.right > f.left + parseFloat(getComputedStyle(inp).paddingLeft) + 0.5
      }).map((x) => x.querySelector(':scope > span').textContent)
      return { o, t, lap }
    })
    const n = await p.evaluate(() => window.bento.doc.slides.length)
    for (let s = 0; s < n; s++) {
      await p.locator('.ed-sidebar .ed-thumb').nth(s).evaluate((x) => x.click()); await p.waitForTimeout(120)
      const ids = await p.evaluate((s) => window.bento.doc.slides[s].elements.map((e) => e.id), s)
      for (const id of [null, ...ids]) {
        if (id) await p.evaluate((id) => document.querySelector(`.ed-layer[data-id="${id}"]`)?.click(), id)
        else await p.keyboard.press('Escape')
        await p.waitForTimeout(60)
        for (const t of await p.locator('.ed-props .ed-tabs [role=tab]').all()) {
          await t.click()
          const r = await measure()
          r.o.forEach((x) => over.add(x)); r.t.forEach((x) => cut.add(x)); r.lap.forEach((x) => lap.add(x))
        }
      }
    }
    ok(width <= 270, `${tag} measured at the default width (${width}px)`)
    ok(over.size === 0, `${tag} nothing reaches past the panel's edge${over.size ? ': ' + [...over].join(' | ') : ''}`)
    ok(cut.size === 0, `${tag} no dropdown cuts off its value${cut.size ? ': ' + [...cut].join(' | ') : ''}`)
    ok(lap.size === 0, `${tag} no in-field label runs into its value${lap.size ? ': ' + [...lap].join(' | ') : ''}`)

    if (locale === 'en-US') {
      // a fresh slide with three boxes, for the Arrange kit and the numeric fields
      await p.evaluate(() => {
        const d = JSON.parse(JSON.stringify(window.bento.doc))
        const box = (id, x) => ({ id, type: 'shape', shape: 'rect', x, y: 200, w: 160, h: 100, rotation: 0, opacity: 1, fill: '#5E7699' })
        d.slides = [{ id: 's1', background: '#ffffff', notes: '', elements: [box('a', 100), box('b', 500), box('c', 900)] }]
        window.bento.loadDoc(JSON.stringify(d))
      })
      await p.waitForTimeout(400)
      const pick = (ids) => p.evaluate((ids) => { for (const [i, id] of ids.entries()) document.querySelector(`.ed-layer[data-id="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: i > 0 })) }, ids)
      await p.locator('.ed-props .ed-tabs [role=tab]').first().click()
      const kit = () => p.$$eval('.ed-props .ed-layer-block .ed-toolbar .ed-tool', (bs) => ({
        n: bs.length, icons: bs.every((b) => b.querySelector('svg') && !b.textContent.trim() && b.title && b.getAttribute('aria-label')),
        rows: new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size,
        // every tool reachable: inside the panel's content box and clear of every other
        clear: (() => {
          const host = document.querySelector('.ed-props').getBoundingClientRect()
          const rs = bs.map((b) => b.getBoundingClientRect())
          return rs.every((r, i) => r.left >= host.left && r.right <= host.right &&
            rs.every((o, j) => j === i || r.right <= o.left + 0.5 || o.right <= r.left + 0.5 || r.bottom <= o.top + 0.5 || o.bottom <= r.top + 0.5))
        })(),
      }))
      await pick(['a']); await p.waitForTimeout(200)
      let k = await kit()
      ok(k.icons, 'every toolbar button is an icon with a hint and a name')
      ok(k.n === 12 && k.rows === 2 && k.clear, `one element: align on one line, order and flip on the next, none covered (${k.n} tools, ${k.rows} lines)`)
      await pick(['a', 'b']); await p.waitForTimeout(200)
      k = await kit()
      // a, b and c are shapes, so the four vector booleans join too (vector-bool.ts)
      ok(k.n === 19 && k.clear, `two: match width/height, Group and the four booleans join, none covered (${k.n})`)
      await pick(['a', 'b', 'c']); await p.waitForTimeout(200)
      k = await kit()
      ok(k.n === 21 && k.clear, `three: even gaps join them, none covered or out of the panel (${k.n})`)
      await pick(['a']); await p.waitForTimeout(200)
      const inside = await p.evaluate(() => {
        const m = [...document.querySelectorAll('.ed-props .ed-mini')].find((x) => x.querySelector('span')?.textContent === 'X')
        if (!m) return false
        // inside the INPUT's own box (which keeps THE FIELD's look, #729), and
        // clear of the value, which starts after the label
        const inp = m.querySelector('input'), f = inp.getBoundingClientRect(), l = m.querySelector('span').getBoundingClientRect()
        return l.left >= f.left && l.right <= f.right && l.top >= f.top && l.bottom <= f.bottom &&
          parseFloat(getComputedStyle(inp).paddingLeft) >= l.right - f.left
      })
      ok(inside, 'a numeric pair carries its label inside the field')

      // the colour field: swatch · hex · % — a typed hex is the colour
      await p.locator('.ed-props .ed-tabs [role=tab]').first().click()
      const fill = () => p.evaluate(() => window.bento.doc.slides[0].elements[0].fill)
      const row = p.locator('.ed-props .ed-section[data-key="Fill"] + .ed-section-body')
      const hex = row.locator('.ed-color-hex')
      ok(await hex.count() === 1 && /^[0-9a-f]{6}$/.test(await hex.inputValue()), `the Fill section shows its hex value (${await hex.inputValue()})`)
      await hex.fill('ff0000'); await hex.press('Enter'); await p.waitForTimeout(200)
      ok((await fill()).toLowerCase() === '#ff0000', `typing a hex sets the colour (${await fill()})`)
      await hex.fill('0f0'); await hex.press('Enter'); await p.waitForTimeout(200)
      ok((await fill()).toLowerCase() === '#00ff00', 'a three-digit hex is understood')
      await hex.fill('nope'); await hex.press('Enter'); await p.waitForTimeout(200)
      ok((await fill()).toLowerCase() === '#00ff00' && await row.locator('.ed-color-hex').inputValue() === '00ff00', 'nonsense is refused and the field shows the colour again')
      // Stroke is added from its header's +, and removed from its −
      const strokeHead = p.locator('.ed-props .ed-section[data-key="Stroke"]')
      ok(await strokeHead.locator('.ed-sec-act').getAttribute('aria-label') === 'Add stroke', 'a box with no stroke offers + Add stroke on the header')
      await strokeHead.locator('.ed-sec-act').click(); await p.waitForTimeout(250)
      ok((await p.evaluate(() => window.bento.doc.slides[0].elements[0].strokeWidth)) > 0, 'and + adds one')
      const stroke = p.locator('.ed-props .ed-section[data-key="Stroke"] + .ed-section-body')
      const pct = stroke.locator('.ed-color-alpha .ed-unit')
      const before = await stroke.locator('.ed-color-alpha input').inputValue()
      const b = await pct.boundingBox()
      await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down(); await p.mouse.move(b.x - 40, b.y + b.height / 2, { steps: 6 }); await p.mouse.up()
      await p.waitForTimeout(250)
      const after = await p.locator('.ed-props .ed-section[data-key="Stroke"] + .ed-section-body .ed-color-alpha input').inputValue()
      ok(+after < +before, `the % inside the field scrubs the opacity (${before} → ${after})`)
      await p.locator('.ed-props .ed-section[data-key="Stroke"] .ed-sec-act').click(); await p.waitForTimeout(250)
      ok((await p.evaluate(() => window.bento.doc.slides[0].elements[0].strokeWidth)) === 0, '− takes the stroke away')

      // theme colours
      const fillBody = p.locator('.ed-props .ed-section[data-key="Fill"] + .ed-section-body')
      ok(await fillBody.locator('.ed-swatch').count() === 0 || !(await fillBody.locator('.ed-palette').isVisible()), 'the theme colours are not strewn above the field')
      await fillBody.locator('.ed-color .ed-tool').click(); await p.waitForTimeout(150)
      const items = fillBody.locator('.ed-palette-item')
      ok(await items.count() >= 3 && (await items.first().textContent()).trim().length > 0, `the palette button opens the theme's colours, named (${await items.count()})`)
      await items.nth(2).click(); await p.waitForTimeout(250)
      const linked = await p.evaluate(() => JSON.stringify(window.bento.doc.slides[0].elements[0].themeRefs ?? null))
      const token = p.locator('.ed-props .ed-section[data-key="Fill"] + .ed-section-body .ed-color-token')
      ok(linked !== 'null' && await token.count() === 1, `a theme colour is recorded as one, and the field shows its name (${await token.textContent().catch(() => '')})`)
      await token.locator('.ed-color-detach').click(); await p.waitForTimeout(250)
      ok(await p.evaluate(() => !window.bento.doc.slides[0].elements[0].themeRefs?.fill) && await p.locator('.ed-props .ed-section[data-key="Fill"] + .ed-section-body .ed-color-hex').count() === 1, 'detaching makes it a plain colour again, hex and all')

      // page sizes
      await p.keyboard.press('Escape'); await p.mouse.click(5, 500); await p.waitForTimeout(250)
      const tiles = p.locator('.ed-props .ed-page-tile')
      const shapes = await tiles.evaluateAll((bs) => bs.map((b) => { const r = b.querySelector('.ed-page-shape').getBoundingClientRect(); return Math.round(r.width / r.height * 100) / 100 }))
      ok(await tiles.count() === 7 && shapes[0] > 1.7 && shapes[3] < 0.6, `seven tiles, each drawn at its proportions (${shapes.join(' ')})`)
      await tiles.nth(1).click(); await p.waitForTimeout(250)
      ok(await p.evaluate(() => `${window.bento.doc.size.width}x${window.bento.doc.size.height}`) === '960x720', 'one click sets 4:3')
      ok(await p.locator('.ed-props .ed-page-tile[aria-checked="true"]').getAttribute('aria-label') === 'Classic 4:3', 'and the tile shows it is chosen')
      await tiles.last().click(); await p.waitForTimeout(150)
      const wField = p.locator('.ed-props .ed-page-tiles + .ed-grid2 .ed-mini').first()
      ok(await wField.isVisible(), 'Custom opens W and H')
      const wb = await wField.locator('span').boundingBox()
      await p.mouse.move(wb.x + 3, wb.y + wb.height / 2); await p.mouse.down(); await p.mouse.move(wb.x - 2000, wb.y + wb.height / 2, { steps: 40 })
      ok(+(await wField.locator('input').inputValue()) === 320, `a width drag stops at 320 (${await wField.locator('input').inputValue()})`)
      await p.mouse.up(); await p.waitForTimeout(250)
      ok(await p.evaluate(() => window.bento.doc.size.width) === 320, 'and the deck agrees')
    }
    ok(errors.length === 0, `${tag} no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
    await ctx.close()
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
