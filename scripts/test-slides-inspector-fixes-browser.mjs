// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The inspector's colour, section, stroke, row and scrub behaviour, end to end.
//
//   npm run build:single --prefix slides && node scripts/test-slides-inspector-fixes-browser.mjs
//
// WHAT THIS PROVES, in the packaged document, through the real panel:
//   1. a theme reference keeps the field's own opacity: a 50% text colour
//      linked to Accent 1 is still 50% after Accent 1 is changed in the Theme
//      section, and picking a theme colour onto a 50% fill keeps the 50%;
//   2. state lines (image "Embedded · …") stay out of the '?' help fold;
//   3. the + on a collapsed optional section opens it, so what was added shows;
//   4. an arrow's stroke can be removed (it is a closed polygon); a line has
//      ONE colour, under Stroke, and it is the `fill` the renderer draws with;
//      an open path's Stroke colour is its `stroke`;
//   5. a typed colour is ONE undo step, linked or not, and a 0% colour stays
//      0% when its hue is typed;
//   6. a click on a colour row's caption does not open the native picker;
//   7. numeric fields are named by what they set (not '%' / 'pt'); a
//      segmented control and the tabs are one tab stop, arrows move;
//   8. a scrub that changes nothing adds no undo step, and pointercancel ends
//      a scrub like a release (cursor class off, edit burst closed).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const ELS = [
  { id: 't', type: 'text', x: 40, y: 40, w: 300, h: 80, html: 'Hello', fontSize: 32, color: '#1E2A3A' },
  { id: 'r', type: 'shape', shape: 'rect', x: 400, y: 40, w: 120, h: 80, fill: 'rgba(255, 0, 0, 0.5)', stroke: 'transparent', strokeWidth: 0 },
  { id: 'z', type: 'shape', shape: 'rect', x: 560, y: 40, w: 120, h: 80, fill: 'rgba(255, 0, 0, 0)', stroke: '#000000', strokeWidth: 2 },
  { id: 'ar', type: 'shape', shape: 'arrow', x: 40, y: 200, w: 200, h: 80, fill: '#ff0000', stroke: '#000000', strokeWidth: 3 },
  { id: 'ln', type: 'shape', shape: 'line', x: 300, y: 200, w: 200, h: 4, fill: '#333333', stroke: 'transparent', strokeWidth: 2 },
  { id: 'pa', type: 'shape', shape: 'path', x: 560, y: 200, w: 200, h: 100, d: 'M0 0 C50 100 150 0 200 100', pathBox: [0, 0, 200, 100], fill: 'none', stroke: '#0000ff', strokeWidth: 3 },
  { id: 'im', type: 'image', x: 800, y: 40, w: 100, h: 100, src: PNG, fit: 'contain', radius: 0 },
].map((e) => ({ rotation: 0, opacity: 1, ...e }))

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1') } catch {} })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-props .ed-tabs'))
  const load = () => p.evaluate((els) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.theme.accent = '#F7A600'
    d.slides = [{ id: 's1', background: '#ffffff', elements: els }]
    window.bento.loadDoc(JSON.stringify(d))
  }, ELS)
  await load(); await p.waitForTimeout(300)
  const el = (id) => p.evaluate((id) => JSON.parse(JSON.stringify(window.bento.doc.slides[0].elements.find((e) => e.id === id))), id)
  const select = async (id) => {
    await p.evaluate((id) => document.querySelector(`.ed-layer[data-id="${id}"]`)?.click(), id)
    await p.waitForTimeout(200)
  }
  const body = (key) => `.ed-props .ed-section[data-key="${key}"] + .ed-section-body`
  const undo = async () => { await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(150) }
  const typeHex = async (scope, hex) => {
    const h = p.locator(`${scope} .ed-color-hex`).first()
    await h.fill(hex); await h.press('Enter')
    await p.evaluate(() => document.activeElement?.blur()); await p.waitForTimeout(200)
  }
  const pickTheme = async (scope, name) => {
    // the section's ⠿ (Figma's catalog) where the field sits in a paint row; the field's own button elsewhere
    await p.locator(scope).first().evaluate((b) => {
      const head = b.previousElementSibling
      const cat = head?.classList.contains('ed-section') ? head.querySelector('.ed-sec-cat') : null
      ;(cat ?? b.querySelector('button[aria-label="Colors & tokens"]'))?.click()
    })
    await p.locator('.ed-tokpick-opt', { hasText: name }).first().click()
    await p.waitForTimeout(200)
  }

  // 1a. alpha on a linked colour survives a theme edit
  await select('t')
  await pickTheme(body('Fill'), 'Accent 1')
  let t = await el('t')
  ok(t.themeRefs?.color === 'accent1', `the text colour is linked to Accent 1 (${JSON.stringify(t.themeRefs)})`)
  const alpha = p.locator(`${body('Fill')} .ed-color-alpha input`)
  await alpha.fill('50'); await alpha.press('Enter'); await p.evaluate(() => document.activeElement?.blur()); await p.waitForTimeout(250)
  t = await el('t')
  ok(t.color === 'rgba(247, 166, 0, 0.5)' && t.themeRefs?.color === 'accent1', `50% keeps the link (${t.color}, ${JSON.stringify(t.themeRefs)})`)
  await p.keyboard.press('Escape'); await p.evaluate(() => document.activeElement?.blur()); await p.waitForTimeout(200)
  // Accent 1 lives in the Tokens view's Theme group (one home for the deck's colours)
  await p.locator('.ed-side-tabs [data-view="tokens"]').click(); await p.waitForTimeout(200)
  const accentRow = p.locator('.ed-side-tokens .ed-token-builtin[data-slot="accent1"]')
  ok(await accentRow.count() === 1, 'the Tokens view has its Accent 1 row')
  await accentRow.locator('.ed-token-value').click()
  await accentRow.locator('input.ed-edit-field').fill('123456'); await accentRow.locator('input.ed-edit-field').press('Enter'); await p.waitForTimeout(300)
  await p.locator('.ed-side-tabs [data-view="layers"]').click(); await p.waitForTimeout(150)
  ok((await p.evaluate(() => window.bento.doc.theme.accent)).toLowerCase() === '#123456', 'editing it changed Accent 1')
  t = await el('t')
  ok(t.color === 'rgba(18, 52, 86, 0.5)', `the linked text colour re-derives with its 50% kept (${t.color})`)

  // 1b. a theme pick onto a 50% fill keeps the 50%
  await select('r')
  await pickTheme(body('Fill'), 'Accent 1')
  const r = await el('r')
  ok(r.fill === 'rgba(18, 52, 86, 0.5)' && r.themeRefs?.fill === 'accent1', `picking a theme colour keeps the field's 50% (${r.fill})`)

  // 5. one undo step per typed colour, linked or not; 0% stays 0%
  // a linked field shows the theme colour's name, not a hex: pick from the
  // native picker, which holds focus while it is open, as the real one does
  await p.locator(`${body('Fill')} input[type=color]`).evaluate((c) => {
    c.focus(); c.value = '#00ff00'; c.dispatchEvent(new Event('input')); c.dispatchEvent(new Event('change')); c.blur()
  })
  await p.waitForTimeout(200)
  ok((await el('r')).fill === 'rgba(0, 255, 0, 0.5)' && !(await el('r')).themeRefs, 'picking a colour on a linked fill writes it and detaches')
  await undo()
  const ru = await el('r')
  ok(ru.fill === 'rgba(18, 52, 86, 0.5)' && ru.themeRefs?.fill === 'accent1', `ONE undo restores colour and link together (${ru.fill}, ${JSON.stringify(ru.themeRefs)})`)
  await select('z')
  await typeHex(body('Fill'), '00ff00')
  ok((await el('z')).fill === 'rgba(0, 255, 0, 0)', `a 0% fill stays 0% when its hue is typed (${(await el('z')).fill})`)
  await undo()
  ok((await el('z')).fill === 'rgba(255, 0, 0, 0)', `and one undo puts it back (${(await el('z')).fill})`)

  // 3. an optional section with nothing in it reads as open and cannot be
  //    folded (a fold would open onto nothing), so its + always shows the result
  await select('r')
  await p.locator('.ed-props .ed-section[data-key="Shadow"]').click(); await p.waitForTimeout(100)
  ok(await p.locator('.ed-props .ed-section[data-key="Shadow"]').evaluate((h) => !h.classList.contains('closed') && h.classList.contains('ed-sec-flat')), 'the empty Shadow section stays open when clicked')
  await p.locator('.ed-props .ed-section[data-key="Shadow"] .ed-sec-act:not(.ed-sec-cat)').click(); await p.waitForTimeout(250)
  ok(!!(await el('r')).shadow, 'the + added a shadow')
  ok(await p.locator(`${body('Shadow')} .ed-shadow-tiles`).isVisible(), 'and its section opened to show it')

  // 8a. a scrub held at a limit is no undo step
  const op = p.locator('.ed-props .ed-layer-block .ed-mini:has(input[aria-label="Opacity"]) span')
  const b = await op.boundingBox()
  await p.mouse.move(b.x + 3, b.y + 5); await p.mouse.down(); await p.mouse.move(b.x + 80, b.y + 5, { steps: 5 }); await p.mouse.up(); await p.waitForTimeout(250)
  ok((await el('r')).opacity === 1, 'opacity held at 100%')
  await undo()
  ok(!(await el('r')).shadow, 'a scrub that changed nothing left no undo step (one undo removes the shadow)')

  // 8b. pointercancel ends the scrub like a release
  await select('r')
  const op2 = p.locator('.ed-props .ed-layer-block .ed-mini:has(input[aria-label="Opacity"]) span')
  const b2 = await op2.boundingBox()
  await p.mouse.move(b2.x + 3, b2.y + 5); await p.mouse.down(); await p.mouse.move(b2.x - 40, b2.y + 5, { steps: 5 })
  // the OS takes the pointer: a cancel and NO release follows
  await p.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true })))
  await p.waitForTimeout(250)
  ok(await p.evaluate(() => !document.body.classList.contains('ed-scrubbing')), 'pointercancel takes the scrub cursor off')
  const scrubbed = (await el('r')).opacity
  ok(scrubbed < 1, `the cancelled drag moved the value (${scrubbed})`)
  const xIn = p.locator('.ed-props .ed-mini', { has: p.locator(':scope > span', { hasText: /^X$/ }) }).first().locator('input')
  await xIn.fill('77'); await xIn.press('Enter'); await p.evaluate(() => document.activeElement?.blur()); await p.waitForTimeout(250)
  await undo()
  await p.mouse.up() // only now: a release must not be what ended the drag
  const after = await el('r')
  ok(after.x === 400 && after.opacity === scrubbed, `the next edit is its own undo step — the burst closed on cancel (x ${after.x}, opacity ${after.opacity})`)

  // 4. arrows, lines, open paths
  await select('ar')
  ok(await p.locator('.ed-props .ed-section[data-key="Stroke"] + .ed-section-body .ed-paint-remove').count() === 1, "an arrow's stroke row has its − (it is a closed polygon)")
  ok(await p.locator('.ed-props .ed-section[data-key="Fill"]').count() === 1, 'an arrow keeps its Fill')
  await select('ln')
  ok(await p.locator('.ed-props .ed-section[data-key="Fill"]').count() === 0, 'a line shows no Fill section')
  ok(await p.locator('.ed-props .ed-section[data-key="Stroke"] + .ed-section-body .ed-paint-remove').count() === 0, "a line's stroke cannot be removed (no − on its row)")
  await typeHex(body('Stroke'), 'ff00ff')
  const ln = await el('ln')
  ok(ln.fill === '#ff00ff' && ln.stroke === 'transparent', `a line's Stroke colour is the fill it is drawn with (fill ${ln.fill}, stroke ${ln.stroke})`)
  const drawn = await p.evaluate(() => document.querySelector('.ed-stage-scale [data-el-id="ln"] line')?.getAttribute('stroke'))
  ok(drawn === '#ff00ff', `and the canvas draws the line in it (${drawn})`)
  await select('pa')
  ok(await p.locator('.ed-props .ed-section[data-key="Stroke"] + .ed-section-body .ed-paint-remove').count() === 0, "an open path's stroke cannot be removed (no − on its row)")
  await typeHex(body('Stroke'), '00ffff')
  ok((await el('pa')).stroke === '#00ffff', "an open path's Stroke colour is its stroke")

  // 2. a state line is not folded behind '?'
  await select('im')
  const st = await p.evaluate(() => [...document.querySelectorAll('.ed-props p.ed-hint')].filter((x) => /Embedded/.test(x.textContent)).map((x) => getComputedStyle(x).display))
  ok(st.length === 1 && st[0] !== 'none', `the image's "Embedded" state shows without opening help (${st})`)

  // 6. caption click on a colour row
  await p.keyboard.press('Escape'); await p.waitForTimeout(200)
  await p.evaluate(() => { window.__clk = 0; document.querySelectorAll('.ed-props input[type=color]').forEach((i) => i.addEventListener('click', () => window.__clk++)) })
  const cap = p.locator('.ed-props .ed-row > span', { hasText: /^Background$/ }).first()
  await cap.click(); await p.waitForTimeout(100)
  ok(await p.evaluate(() => window.__clk) === 0, 'a click on "Background" does not open the colour picker')
  ok(await p.evaluate(() => { const s = [...document.querySelectorAll('.ed-props .ed-row > span')].find((x) => x.textContent === 'Background'); const r = s?.parentElement; return r?.tagName === 'DIV' && r.getAttribute('aria-labelledby') === s.id }), 'the colour row is a group named by its caption')

  // 7. names and keyboard
  await select('t')
  const names = await p.evaluate(() => ({
    op: document.querySelector('.ed-props .ed-mini[title="Opacity"] input')?.getAttribute('aria-label'),
    size: document.querySelector('.ed-props .ed-mini[title="Size (pt)"] input')?.getAttribute('aria-label'),
    x: [...document.querySelectorAll('.ed-props .ed-mini')].find((m) => m.firstElementChild?.textContent === 'X')?.querySelector('input')?.getAttribute('aria-label'),
  }))
  ok(names.op === 'Opacity' && names.size === 'Size (pt)' && names.x === 'X', `numeric fields are named by what they set (${JSON.stringify(names)})`)
  const seg = p.locator('.ed-props .ed-seg[aria-label="Align"]')
  ok(await seg.locator('[tabindex="0"]').count() === 1, 'a segmented control is one tab stop')
  const before = (await el('t')).align ?? 'left'
  await seg.locator('[tabindex="0"]').focus()
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(250)
  const now = (await el('t')).align
  ok(now !== before && (await el('t')).x === 40, `ArrowRight chooses the next option, and does not nudge the element (${before} → ${now})`)
  ok(await p.evaluate(() => document.activeElement?.getAttribute('role') === 'radio' && document.activeElement.getAttribute('aria-checked') === 'true'), 'focus stays on the chosen option across the rebuild')
  await p.locator('.ed-props .ed-tabs [role=tab]').first().focus()
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(100)
  ok(await p.evaluate(() => document.querySelector('.ed-props').dataset.tab) === 'animate', 'ArrowRight on the tabs moves to Animate')
  await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(100)
  ok(await p.evaluate(() => document.querySelector('.ed-props').dataset.tab) === 'format', 'ArrowLeft moves back to Format')

  // CSS rulings: the shadow tile keeps its grey preview patch on hover; the
  // in-field label and the value's padding agree in RTL; the tooltip has an
  // edge in dark; measure labels read at 4.5:1 in light.
  await select('r')
  if (!(await el('r')).shadow) await p.locator('.ed-props .ed-section[data-key="Shadow"] .ed-sec-act:not(.ed-sec-cat)').click()
  await p.waitForTimeout(200)
  const tile = p.locator('.ed-props .ed-shadow-tile').nth(1)
  await tile.hover(); await p.waitForTimeout(100)
  ok(await tile.evaluate((x) => getComputedStyle(x).backgroundImage.includes('gradient')), 'a hovered shadow tile keeps its grey preview patch')
  await p.evaluate(() => { document.documentElement.dir = 'rtl' })
  await p.waitForTimeout(100)
  const rtl = await p.evaluate(() => {
    const m = [...document.querySelectorAll('.ed-props .ed-mini')].find((x) => x.firstElementChild?.textContent === 'X')
    const s = m.querySelector('span').getBoundingClientRect(), i = m.querySelector('input'), r = i.getBoundingClientRect(), cs = getComputedStyle(i)
    return { labelRight: Math.round(r.right - s.right), padR: parseFloat(cs.paddingRight), padL: parseFloat(cs.paddingLeft), labelW: s.width }
  })
  await p.evaluate(() => { document.documentElement.dir = 'ltr' })
  ok(rtl.labelRight < 12 && rtl.padR > rtl.labelW + rtl.labelRight && rtl.padL < 8, `RTL: the in-field label sits right and the value is padded past it on the right (${JSON.stringify(rtl)})`)
  const tok = await p.evaluate(() => {
    const read = (th) => { document.documentElement.dataset.theme = th; const c = getComputedStyle(document.documentElement); return { edge: c.getPropertyValue('--tip-edge').trim(), label: c.getPropertyValue('--blue-label').trim(), surface: c.getPropertyValue('--surface').trim() } }
    const was = document.documentElement.dataset.theme
    const r = { light: read('light'), dark: read('dark') }
    document.documentElement.dataset.theme = was
    return r
  })
  const lum = (hex) => { const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2] }
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
  ok(tok.dark.edge !== 'transparent' && tok.dark.edge !== '', `the tooltip has an edge on the dark chrome (${tok.dark.edge})`)
  const lr = ratio(tok.light.label, tok.light.surface)
  ok(lr >= 4.5, `light measure labels: white on ${tok.light.label} is ${lr.toFixed(2)}:1 (≥ 4.5)`)

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
