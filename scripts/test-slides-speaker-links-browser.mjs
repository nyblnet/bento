// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A link in a speaker-view preview never navigates the popup.
//
//   npm run build:single --prefix slides && node scripts/test-slides-speaker-links-browser.mjs
//
// WHAT THIS PROVES: the speaker window holds the presenter's notes, and its
// current, next, rail and grid previews render the slides' real anchors. A
// click on one (activated as the browser's own default action, so a missing
// preventDefault shows up as a navigation request) leaves the popup on its
// own page and sends no request.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let failures = 0
function ok(cond, msg) {
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const link = (n) => `<a href="https://example.org/${n}">https://example.org/${n}</a>`

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const hits = []
  await ctx.route(/^https?:/, (r) => { hits.push(r.request().url()); r.abort() })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale'))
  await p.evaluate((links) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    const slide = (id, html) => ({ id, background: '#ffffff', elements: [
      { id: 't' + id, type: 'text', x: 120, y: 60, w: 800, h: 100, rotation: 0, opacity: 1, html, fontSize: 28, color: '#1E2A3A', align: 'left' }] })
    d.slides = [slide('s1', links[0]), slide('s2', links[1])]
    window.bento.loadDoc(JSON.stringify(d))
  }, [link(1), link(2)])
  await p.waitForTimeout(400)

  const popup = ctx.waitForEvent('page')
  await p.locator('.ed-present-pill .ed-pill-caret').click()
  await p.locator('.ed-present-pill .ed-menu').getByText('Open speaker view', { exact: true }).click()
  const sp = await popup
  await sp.waitForLoadState()
  await p.locator('.ed-present-pill .ed-pill-caret').click()
  await p.locator('.ed-present-pill .ed-menu').getByText('Present in this tab', { exact: true }).click()
  await sp.waitForSelector('.sv-btn[data-nav]', { timeout: 15000 })
  await sp.waitForTimeout(1500)
  const start = sp.url()
  hits.length = 0

  const anchors = await sp.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')))
  ok(anchors.length >= 2, `the popup's previews hold real anchors (${anchors.length})`)
  // an unfixed popup navigates away and the page context dies mid-call: swallow that, the checks below report it
  await sp.evaluate(() => document.querySelectorAll('a[href]').forEach((a) => a.click())).catch(() => {})
  // the grid: open it and click its anchors too
  await sp.evaluate(() => document.querySelector('.sv-btn[data-nav="grid"]')?.click()).catch(() => {})
  await sp.waitForTimeout(500)
  await sp.evaluate(() => document.querySelectorAll('a[href]').forEach((a) => a.click())).catch(() => {})
  await sp.waitForTimeout(600)
  ok(sp.url() === start && hits.length === 0, `no click navigates the popup, nothing is requested (${hits.length} requests)`)
  ok(errors.length === 0, `no page errors ${errors.join('; ')}`)
} finally {
  await browser.close()
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
