// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The colour popover: opens from the swatch, previews live, commits once, cancels clean.
//
//   npm run build:single --prefix slides && node scripts/test-slides-color-popover-browser.mjs
//
// WHAT THIS PROVES, in the built shell, on a shape's Fill:
//   1. clicking the swatch opens OUR popover (square, hue, opacity, value,
//      swatches) and never the browser's picker (the click is cancelled);
//   2. dragging in the square previews the fill live, and closing commits it
//      as ONE undo step;
//   3. a hex typed in the popover is the colour; the RGB model reads and takes
//      `r, g, b`; a CSS name is understood;
//   4. a theme swatch in the popover LINKS the palette slot, keeping the
//      field's opacity, exactly as the palette list does;
//   5. Esc after a preview restores the colour and leaves no undo step;
//   6. a translucent colour's swatch is marked see-through.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const ELS = [
  { id: 'r', type: 'shape', shape: 'rect', x: 100, y: 100, w: 200, h: 100, fill: '#ff0000', stroke: 'transparent', strokeWidth: 0, radius: 0 },
  { id: 'q', type: 'shape', shape: 'rect', x: 400, y: 100, w: 200, h: 100, fill: '#123456', stroke: 'transparent', strokeWidth: 0, radius: 0 },
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
  await p.evaluate((els) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.theme.accent = '#F7A600'
    d.slides = [{ id: 's1', background: '#ffffff', elements: els }]
    window.bento.loadDoc(JSON.stringify(d))
  }, ELS)
  await p.waitForTimeout(300)
  const el = (id) => p.evaluate((id) => JSON.parse(JSON.stringify(window.bento.doc.slides[0].elements.find((e) => e.id === id))), id)
  const select = async (id) => {
    await p.evaluate((id) => document.querySelector(`.ed-layer[data-id="${id}"]`)?.click(), id)
    await p.waitForTimeout(200)
  }
  const swatch = '.ed-props .ed-section[data-key="Fill"] + .ed-section-body input[type=color]'
  const openPop = async () => {
    await p.locator(swatch).first().click(); await p.waitForTimeout(150)
    return p.locator('.ed-cpop')
  }
  const undo = async () => { await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(200) }

  console.log('\n1. opens ours, never the browser\'s\n')
  await select('r')
  const native = await p.locator(swatch).first().evaluate((c) => new Promise((res) => {
    c.addEventListener('click', (e) => setTimeout(() => res(e.defaultPrevented)), { once: true })
    c.click()
  }))
  ok(native === true, 'the swatch click is cancelled: the native picker never opens')
  const pop = p.locator('.ed-cpop')
  ok(await pop.count() === 1, 'the popover is open')
  ok(await pop.locator('.ed-cpop-sv').count() === 1 && await pop.locator('.ed-cpop-hue').count() === 1 && await pop.locator('.ed-cpop-alpha').count() === 1 && await pop.locator('.ed-cpop-text').count() === 1,
    'it has the square, hue, opacity and value')
  const pw = await pop.evaluate((x) => x.offsetWidth) // layout width: the opening scale would read short
  ok(Math.abs(pw - 248) < 0.5, `it is 248px wide (${pw})`)
  ok(await pop.locator('.ed-cpop-swatch').count() >= 2, 'it offers swatches (theme, and this slide)')

  console.log('\n2. a drag previews, closing commits once\n')
  const sv = await pop.locator('.ed-cpop-sv').boundingBox()
  await p.mouse.move(sv.x + sv.width * 0.5, sv.y + sv.height * 0.5); await p.mouse.down()
  await p.mouse.move(sv.x + sv.width * 0.2, sv.y + sv.height * 0.2, { steps: 5 })
  const live = (await el('r')).fill
  await p.mouse.up()
  ok(live !== '#ff0000', `the fill previews while dragging (${live})`)
  await p.mouse.click(1300, 900); await p.waitForTimeout(250) // outside: commits
  ok(await p.locator('.ed-cpop').count() === 0, 'a click outside closes it')
  const committed = (await el('r')).fill
  ok(committed === live, `and keeps the colour (${committed})`)
  await undo()
  ok((await el('r')).fill === '#ff0000', 'one undo takes the whole pick back')

  console.log('\n3. typed values\n')
  await select('r')
  let pp = await openPop()
  const text = pp.locator('.ed-cpop-text')
  await text.fill('00ff88'); await text.press('Enter'); await p.waitForTimeout(250)
  ok((await el('r')).fill === '#00ff88', `a typed hex is the colour (${(await el('r')).fill})`)
  ok(await p.locator('.ed-cpop').count() === 0, 'Enter closes the popover')
  pp = await openPop()
  await pp.locator('select').selectOption('rgb'); await p.waitForTimeout(50)
  ok(await pp.locator('.ed-cpop-text').inputValue() === '0, 255, 136', `the RGB model reads r, g, b (${await pp.locator('.ed-cpop-text').inputValue()})`)
  await pp.locator('.ed-cpop-text').fill('10, 20, 30'); await pp.locator('.ed-cpop-text').press('Enter'); await p.waitForTimeout(250)
  ok((await el('r')).fill === '#0a141e', `and takes it (${(await el('r')).fill})`)
  pp = await openPop()
  await pp.locator('select').selectOption('hex')
  await pp.locator('.ed-cpop-text').fill('rebeccapurple'); await pp.locator('.ed-cpop-text').press('Enter'); await p.waitForTimeout(250)
  ok((await el('r')).fill === '#663399', `a CSS name is understood (${(await el('r')).fill})`)

  console.log('\n4. a theme swatch links the slot\n')
  const alpha = p.locator('.ed-props .ed-section[data-key="Fill"] + .ed-section-body .ed-color-alpha input')
  await alpha.fill('50'); await alpha.press('Enter'); await p.evaluate(() => document.activeElement?.blur()); await p.waitForTimeout(200)
  pp = await openPop()
  await pp.locator('.ed-cpop-swatch[title="Accent 1"]').click(); await p.waitForTimeout(250)
  const linked = await el('r')
  ok(linked.themeRefs?.fill === 'accent1' && linked.fill === 'rgba(247, 166, 0, 0.5)', `Accent 1 is linked with the 50% kept (${linked.fill}, ${JSON.stringify(linked.themeRefs)})`)
  ok(await p.locator('.ed-cpop').count() === 0, 'and the popover closed')

  console.log('\n5. Esc cancels\n')
  await select('q')
  const stack0 = await p.evaluate(() => JSON.stringify(window.bento.doc))
  pp = await openPop()
  await pp.locator('.ed-cpop-hue').fill('200'); await p.waitForTimeout(100)
  ok((await el('q')).fill !== '#123456', `the hue slider previews (${(await el('q')).fill})`)
  await p.keyboard.press('Escape'); await p.waitForTimeout(250)
  ok((await el('q')).fill === '#123456', `Esc restores the colour (${(await el('q')).fill})`)
  ok(await p.evaluate(() => JSON.stringify(window.bento.doc)) === stack0, 'and the document is exactly as before')
  await undo()
  ok((await el('r')).themeRefs?.fill === undefined, 'the next undo is the edit before it — the cancelled preview left no step')

  console.log('\n6. the see-through swatch\n')
  await p.evaluate(() => window.bento.redo()); await p.waitForTimeout(200)
  await select('r')
  ok(await p.locator(swatch).first().evaluate((c) => c.classList.contains('ed-see-through')), 'a 50% fill marks its swatch see-through')
  await select('q')
  ok(await p.locator(swatch).first().evaluate((c) => !c.classList.contains('ed-see-through')), 'an opaque one does not')
  ok(errors.length === 0, `no page error${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
