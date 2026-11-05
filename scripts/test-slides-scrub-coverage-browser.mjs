// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Every numeric field in the inspector can be scrubbed, across the whole showcase deck.
//
//   npm run build:single --prefix slides && node scripts/test-slides-scrub-coverage-browser.mjs
//
// WHAT THIS PROVES: the rule "a number in the inspector scrubs from its label"
// holds everywhere, not just where someone remembered. It opens every slide of
// the showcase deck the shell starts with (pictures, charts, pies, tables,
// code, gradients, shadows), selects every element through the layers list,
// and the slide itself, and fails on any numeric field with no scrub handle —
// its row or mini label, or a unit chip beside it. A new numeric field that
// skips row()/mini()/unitHandle() fails here, by name.
//
// The one exception is named, not silent: chart DATA — the data grid's cells
// and a pie slice's value — is typed like a spreadsheet, not nudged like a size.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const EXEMPT = '.ed-pie-val, .ed-chart-grid input'

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))

  // Fields with no handle in the inspector as it stands, named by section and caption.
  const orphans = () => p.$$eval('.ed-props input.ed-num', (inputs, exempt) => inputs
    .filter((i) => !i.matches(exempt) && i.offsetParent !== null)
    .filter((i) => {
      const own = i.closest('.ed-row, .ed-mini')
      const label = own?.querySelector(':scope > .ed-scrub')
      const chip = [i.previousElementSibling, i.nextElementSibling].some((n) => n?.classList.contains('ed-scrub'))
      return !(label && (own.matches('.ed-mini') || own.querySelectorAll("input.ed-num").length === 1)) && !chip
    })
    .map((i) => i.closest('.ed-row')?.firstElementChild?.textContent || i.title || i.placeholder || '(no caption)'), EXEMPT)

  const slides = await p.evaluate(() => window.bento.doc.slides.length)
  const seen = new Set()
  let fields = 0
  for (let s = 0; s < slides; s++) {
    await p.locator('.ed-sidebar .ed-thumb').nth(s).click()
    await p.waitForTimeout(250)
    await p.keyboard.press('Escape'); await p.waitForTimeout(150)
    const where = (what) => `slide ${s + 1} ${what}`
    for (const o of await orphans()) seen.add(`${where('(slide panel)')}: ${o}`)
    fields += await p.locator('.ed-props input.ed-num').count()
    const rows = await p.locator('.ed-layers .ed-layer').count()
    for (let r = 0; r < rows; r++) {
      const row = p.locator('.ed-layers .ed-layer').nth(r)
      const name = (await row.textContent())?.trim()
      await row.evaluate((n) => n.click()) // the Layers section may be folded; selecting is not what is under test
      await p.waitForTimeout(150)
      fields += await p.locator('.ed-props input.ed-num').count()
      for (const o of await orphans()) seen.add(`${where(`"${name}"`)}: ${o}`)
    }
  }
  ok(fields > 100, `the walk saw the inspector's numeric fields (${fields} across ${slides} slides)`)
  ok(seen.size === 0, `every numeric field has a scrub handle${seen.size ? ':\n          ' + [...seen].join('\n          ') : ''}`)
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
