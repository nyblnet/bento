// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The last of the inspector revamp, end to end in the built shell.
//
//   npm run build:single --prefix slides && node scripts/test-slides-finish-browser.mjs
//
// WHAT THIS PROVES.
//   1. The colour popover reads and writes OKLCH: a colour shows as L%, C, H,
//      a typed in-gamut OKLCH lands on that colour, and an out-of-gamut one is
//      gamut-MAPPED (CSS Color 4: chroma reduced, L and H kept) AND flagged.
//   2. Tokens of every type: the Tokens view groups them by type with a
//      preview; a font token binds the text's font (and moving the token moves
//      the text), a shadow token binds the Shadow section, an opacity token the
//      opacity field.
//   3. The padlock between W and H: on a shape (free by default) it locks, a
//      typed W then carries H along, and one undo puts it back.
//   4. Popovers arrive animated (the shared entry), and none under reduced motion.
//   5. Export shows the contrast of a text against what is behind it, graded,
//      and a picture's alt text is written and rendered as its aria-label.
//   6. The morph link toggle pairs an element with its look-alike on the slide
//      before, and unpairs it again.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
// sRGB hex → OKLCH (Ottosson), to judge the popover's output independently
function oklchOf(hex) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const q = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * q
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * q
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * q, Math.hypot(A, B), (Math.atan2(B, A) * 180 / Math.PI + 360) % 360]
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-panel-open', JSON.stringify({ Export: true, Shadow: true })) } catch {} })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))
  const rect = (id, x, y, w, h, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, rotation: 0, opacity: 1, fill: '#ff0000', stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })
  const text = (id, x, y, extra = {}) => ({ id, type: 'text', x, y, w: 400, h: 80, rotation: 0, opacity: 1, html: 'Hello', fontSize: 20, fontFamily: 'Georgia, serif', fontWeight: 400, color: '#777777', align: 'left', valign: 'top', lineHeight: 1.2, ...extra })
  await p.evaluate(([s1, s2]) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [
      { id: 's1', background: '#ffffff', notes: '', transition: 'none', elements: s1 },
      { id: 's2', background: '#ffffff', notes: '', transition: 'morph', elements: s2 },
    ]
    d.theme.tokens = { set: {
      'font.body': { type: 'fontFamily', values: { default: 'Courier New, monospace' } },
      'shadow.card': { type: 'shadow', values: { default: { x: 0, y: 6, blur: 18, color: 'rgba(0, 0, 0, 0.3)' } } },
      'opacity.muted': { type: 'opacity', values: { default: 0.5 } },
    } }
    window.bento.loadDoc(JSON.stringify(d))
  }, [
    [rect('card', 80, 80, 300, 200, { fill: '#000000' }), text('t', 100, 120, { color: '#ffffff' })],
    [rect('card2', 120, 90, 300, 200, { fill: '#000000' }), text('t2', 400, 400), { id: 'pic', type: 'image', x: 800, y: 100, w: 200, h: 150, rotation: 0, opacity: 1, src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', fit: 'cover' }],
  ])
  await p.waitForTimeout(400)
  const el = (id) => p.evaluate((i) => JSON.parse(JSON.stringify(window.bento.doc.slides.flatMap((s) => s.elements).find((e) => e.id === i))), id)
  // by its layer row: the canvas centre of an element can sit under another one
  const select = async (id) => {
    await p.locator('.ed-side-tabs [data-view="layers"]').click(); await p.waitForTimeout(120)
    await p.locator(`.ed-side-layers .ed-layer[data-id="${id}"]`).click(); await p.waitForTimeout(250)
  }
  const nextSlide = async () => {
    await p.keyboard.press('Escape'); await p.mouse.click(5, 300); await p.waitForTimeout(150)
    await p.keyboard.press('ArrowRight'); await p.waitForTimeout(350)
  }
  const body = (key) => `.ed-props .ed-section[data-key="${key}"] + .ed-section-body`

  console.log('\nOKLCH\n')
  await select('card')
  await p.click(`${body('Fill')} input[type=color]`); await p.waitForTimeout(200)
  ok(await p.locator('.ed-cpop').isVisible(), 'the colour popover is open')
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('.ed-cpop')).animationName) === 'ed-cpop-in', 'it arrives with the shared entry animation')
  await p.selectOption('.ed-cpop select', 'oklch')
  const shown = await p.inputValue('.ed-cpop-text')
  ok(/^0%, 0, 0$/.test(shown), `black reads as OKLCH "0%, 0, 0" (${shown})`)
  // a typed value is read on change; Enter would also close the popover
  const typeValue = async (v) => { await p.fill('.ed-cpop-text', v); await p.$eval('.ed-cpop-text', (i) => i.dispatchEvent(new Event('change'))); await p.waitForTimeout(150) }
  await typeValue('62.8%, 0.2577, 29.23')
  ok(await p.evaluate(() => document.querySelector('.ed-cpop-text').classList.contains('is-clamped')) === false, 'an in-gamut OKLCH is not flagged')
  await typeValue('70%, 0.4, 150')
  ok(await p.evaluate(() => document.querySelector('.ed-cpop-text').classList.contains('is-clamped')), 'an out-of-gamut OKLCH is clamped and flagged')
  // CSS Color 4 gamut mapping keeps lightness and hue and gives up chroma
  {
    const mapped = await p.$eval(`${body('Fill')} input[type=color]`, (i) => i.value)
    const [L, , H] = oklchOf(mapped)
    // the map stops once clipping moves the colour less than a JND (ΔEOK 0.02), so a little drift is allowed
    ok(Math.abs(L - 0.7) < 0.02 && Math.abs(H - 150) < 4 && mapped !== '#00d600', // #00d600 = per-channel clip: L 77%, H 142°
       `oklch(70% 0.4 150) maps to the same lightness and hue in sRGB (${mapped}: L ${(L * 100).toFixed(1)}%, H ${H.toFixed(1)}°)`)
  }
  await p.keyboard.press('Escape'); await p.waitForTimeout(150)
  // in-gamut value checked against the conversion directly (the popover's own functions)
  await p.click(`${body('Fill')} input[type=color]`); await p.waitForTimeout(150)
  await p.fill('.ed-cpop-text', '62.8%, 0.2577, 29.23'); await p.press('.ed-cpop-text', 'Enter'); await p.waitForTimeout(150)
  await p.mouse.click(5, 5); await p.waitForTimeout(250)
  const fill = (await el('card')).fill.toLowerCase()
  ok(fill === '#ff0000' || fill === '#fe0000' || fill === '#ff0100', `oklch(62.8% 0.2577 29.23) is sRGB red (${fill})`)

  console.log('\ntokens of every type\n')
  await p.locator('.ed-side-tabs [data-view="tokens"]').click(); await p.waitForTimeout(200)
  const groups = await p.$$eval('.ed-tokens-group', (gs) => gs.map((g) => g.dataset.type))
  ok(['color', 'number', 'fontSize', 'opacity', 'fontFamily', 'shadow'].every((t) => groups.includes(t)), `the view groups by every type (${groups.join(', ')})`)
  ok(await p.$eval('.ed-tokens-group[data-type="fontFamily"] .ed-token-preview', (e) => e.style.fontFamily.includes('Courier')), 'a font token previews in its face')
  ok(await p.$eval('.ed-tokens-group[data-type="shadow"] .ed-token-preview', (e) => e.style.boxShadow.includes('18px')), 'a shadow token previews its shadow')
  ok(await p.$eval('.ed-tokens-group[data-type="opacity"] .ed-token-value', (e) => e.textContent) === '50%', 'an opacity token shows as a percentage')
  await select('t')
  await p.locator('.ed-props .ed-token-wrap:has(select) .ed-token-dot').click({ force: true }); await p.waitForTimeout(150)
  await p.locator('.ed-tokpick-opt[data-key="font.body"]').click(); await p.waitForTimeout(200)
  let te = await el('t')
  ok(te.fontFamily === 'Courier New, monospace' && te.themeRefs?.fontFamily === '$font.body', 'the font select binds a font token')
  await p.locator('.ed-side-tabs [data-view="tokens"]').click(); await p.waitForTimeout(150)
  await p.click('.ed-tokens-group[data-type="fontFamily"] .ed-token-value')
  await p.fill('.ed-tokens-group[data-type="fontFamily"] input.ed-edit-field', 'Arial, sans-serif')
  await p.press('.ed-tokens-group[data-type="fontFamily"] input.ed-edit-field', 'Enter'); await p.waitForTimeout(250)
  ok((await el('t')).fontFamily === 'Arial, sans-serif', 'editing the token moves the text with it')
  await select('card')
  if (!(await el('card')).shadow) { await p.locator('.ed-props .ed-section[data-key="Shadow"] button').first().click(); await p.waitForTimeout(250) }
  ok(!!(await el('card')).shadow, 'the card has a shadow to bind')
  await p.locator('.ed-props .ed-token-wrap:has(.ed-shadow-tiles) .ed-token-dot').click({ force: true }); await p.waitForTimeout(150)
  await p.locator('.ed-tokpick-opt[data-key="shadow.card"]').click(); await p.waitForTimeout(200)
  const sh = (await el('card')).shadow
  ok(sh?.blur === 18 && (await el('card')).themeRefs?.shadow === '$shadow.card', `the Shadow section binds a shadow token (${JSON.stringify(sh)})`)
  const opDot = p.locator('.ed-props .ed-grid2 .ed-has-token .ed-token-dot').first()
  if (await opDot.count()) {
    await opDot.click({ force: true }); await p.waitForTimeout(150)
    const item = p.locator('.ed-tokpick-opt[data-key="opacity.muted"]', { hasText: '50%' })
    ok(await item.count() === 1, 'the opacity field offers the opacity token, shown as 50%')
    await p.keyboard.press('Escape')
  } else ok(false, 'the opacity field has a token dot')

  console.log('\nthe padlock\n')
  const lock = p.locator('.ed-props .ed-ratio-lock')
  ok(await lock.getAttribute('aria-pressed') === 'false', 'a shape starts unlocked')
  await lock.click(); await p.waitForTimeout(200)
  ok((await el('card')).keepAspectRatio === true, 'the padlock writes keepAspectRatio: true')
  const w = p.locator('.ed-props .ed-mini input[aria-label="W"]').first()
  await w.fill('600'); await w.press('Enter'); await p.waitForTimeout(200)
  let c = await el('card')
  ok(c.w === 600 && c.h === 400, `a typed W carries H along (${c.w}×${c.h})`)
  await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(200)
  c = await el('card')
  ok(c.w === 300 && c.h === 200, `one undo puts both back (${c.w}×${c.h})`)

  console.log('\naccessibility\n')
  await select('t')
  const a11y = await p.locator('.ed-props .ed-a11y').textContent()
  // the card turned red in the OKLCH step: white on #ff0000 is 4.00:1 — judged
  // against the CARD (white on the white slide would read 1.00:1)
  ok(/4\.00:1/.test(a11y) && /Fails/.test(a11y), `white 20px text on the red card: 4.00:1, fails AA (${a11y?.trim()})`)
  await nextSlide()
  if (await p.locator('.ed-stage-scale [data-el-id="t2"]').count()) {
    await select('t2')
    const grey = await p.locator('.ed-props .ed-a11y').textContent()
    ok(/4\.48:1/.test(grey) && /Fails/.test(grey), `#777 on white is 4.48:1 — fails AA for body text (${grey?.trim()})`)
    await select('pic')
    await p.fill('.ed-props .ed-a11y-alt', 'A one-pixel test picture'); await p.press('.ed-props .ed-a11y-alt', 'Enter'); await p.waitForTimeout(250)
    ok((await el('pic')).alt === 'A one-pixel test picture', 'the alt text is written to the element')
    ok(await p.$eval('.ed-stage-scale [data-el-id="pic"]', (n) => n.getAttribute('role') === 'img' && n.getAttribute('aria-label') === 'A one-pixel test picture'), 'and rendered as role=img with that label')

    console.log('\nthe morph link toggle\n')
    await select('card2')
    await p.locator('.ed-props .ed-tabs [role="tab"]', { hasText: /^Animate$/i }).click(); await p.waitForTimeout(200)
    const link = p.locator('.ed-props label.ed-row:has-text("Morph from the slide before") input')
    ok(await link.isChecked() === false, 'card2 does not morph from the slide before yet')
    await link.check(); await p.waitForTimeout(250)
    ok((await el('card2')).morphId === 'card', 'the toggle pairs it with its look-alike, card')
    await p.locator('.ed-props label.ed-row:has-text("Morph from the slide before") input').uncheck(); await p.waitForTimeout(250)
    ok(!(await el('card2')).morphId, 'unchecking unpairs it')
  } else ok(false, 'the second slide could be reached')

  console.log('\nreduced motion\n')
  await p.emulateMedia({ reducedMotion: 'reduce' })
  await select('card2').catch(() => {})
  await p.locator('.ed-props .ed-tabs [role="tab"]', { hasText: /^Format$/i }).click().catch(() => {})
  await p.click(`${body('Fill')} input[type=color]`).catch(() => {}); await p.waitForTimeout(150)
  ok(await p.evaluate(() => { const c = document.querySelector('.ed-cpop'); return !!c && getComputedStyle(c).animationName === 'none' }), 'under reduced motion the popover just appears')
  await p.keyboard.press('Escape')

  ok(!errors.length, `no page error${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
