// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The inspector speaks the author's language, across the whole showcase deck.
//
//   npm run build:single --prefix slides && node scripts/test-slides-copy-browser.mjs
//
// WHAT THIS PROVES: walking every element of every showcase slide (and each
// slide itself) on all three tabs, in English and in Portuguese,
//   1. no row label, section title or menu option shows a stored model value
//      (focus-group, slide-left, kenburns, dash-march…) — those reach the
//      screen only through labeledSelect() with a translated label;
//   2. none of the words the copy review retired comes back (State of, Morph
//      id, Backdrop…), in either language;
//   3. in Portuguese, the rows the review renamed are translated, not shown
//      in English.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const RAW = /^[a-z0-9]+(?:-[a-z0-9]+)+$/ // a kebab-case stored value
const RETIRED = ['State of', 'Morph id', 'Pair with', 'Backdrop', 'Reveal step', 'Ambient', 'Lap easing', 'Hover dim', 'Default set',
  'Preview set', 'Unnumbered', 'V-align', 'Grad. angle', 'Start tip', 'End tip', 'Enter secs', 'Zoom secs', 'Loop secs']
const RENAMED_EN = ['Variant of', 'On hover', 'Hover group', 'Show on hover of', 'Morph name', 'Morph with', 'Entrance', 'Appears on click',
  'Pan & zoom', 'Layout role', 'Blend mode', 'Blur behind', 'Skip numbering', 'Slide name', 'Vertical align']

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  for (const locale of ['en-US', 'pt-BR']) {
    const tag = `[${locale}]`
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale })
    await ctx.route(/^https?:/, (r) => r.abort())
    const p = await ctx.newPage()
    const errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
    await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-props .ed-tabs'))

    const words = () => p.evaluate(() => {
      const out = []
      for (const n of document.querySelectorAll('.ed-props .ed-row > span:first-child, .ed-props .ed-mini > span, .ed-props > .ed-section, .ed-props option, .ed-props .ed-seg button'))
        out.push(n.textContent.trim())
      return out
    })
    const seen = new Set()
    const take = async () => {
      for (const tab of await p.locator('.ed-props .ed-tabs [role="tab"]').all()) {
        await tab.click()
        for (const w of await words()) seen.add(w)
      }
    }
    const slides = await p.evaluate(() => window.bento.doc.slides.length)
    for (let s = 0; s < slides; s++) {
      await p.locator('.ed-sidebar .ed-thumb').nth(s).evaluate((n) => n.click())
      await p.waitForTimeout(150)
      await p.keyboard.press('Escape'); await p.waitForTimeout(100)
      await take()
      const ids = await p.evaluate((s) => window.bento.doc.slides[s].elements.map((e) => e.id), s)
      for (const id of ids) {
        await p.evaluate((id) => document.querySelector(`.ed-layer[data-id="${id}"]`)?.click(), id)
        await p.waitForTimeout(80)
        await take()
      }
    }
    const all = [...seen]
    ok(all.length > 200, `${tag} the walk read the inspector (${all.length} distinct labels and options)`)
    const raw = all.filter((w) => RAW.test(w))
    ok(raw.length === 0, `${tag} no stored value shows as a label${raw.length ? ': ' + raw.join(', ') : ''}`)
    const back = all.filter((w) => RETIRED.includes(w))
    ok(back.length === 0, `${tag} no retired wording${back.length ? ': ' + back.join(', ') : ''}`)
    if (locale === 'pt-BR') {
      const english = all.filter((w) => RENAMED_EN.includes(w))
      ok(english.length === 0, `${tag} the renamed rows are translated${english.length ? ' — still English: ' + english.join(', ') : ''}`)
    } else {
      const found = RENAMED_EN.filter((w) => all.includes(w))
      ok(found.length >= 10, `${tag} the new wording is on screen (${found.length}/${RENAMED_EN.length} met on the showcase)`)
    }
    ok(errors.length === 0, `${tag} no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
    await ctx.close()
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
