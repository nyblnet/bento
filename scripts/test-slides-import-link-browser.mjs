// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Save as → Import PowerPoint… opens the importer on bento.page, and says so.
//
//   npm run build:single --prefix slides && node scripts/test-slides-import-link-browser.mjs
//
// WHAT THIS PROVES, in the packaged document:
//   1. the Save-as menu has "Import PowerPoint…" as ONE line, directly after
//      "Replace from JSON…" (where spaces keeps Import Markdown…);
//   2. its description is the hover tooltip, and names bento.page, a new tab
//      and the internet connection it needs;
//   3. clicking it opens exactly the importer URL in a new tab, with no
//      opener (the page cannot reach back into this document), and leaves
//      this document where it was;
//   4. the entry is translated in every catalog (checked in German).
// The network is blocked throughout: the click is measured by the tab it
// asks for, not by the page loading.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const URL_EXPECTED = 'https://bento.page/import'

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  // record what navigations ASK for, then refuse them: nothing leaves the rig
  const asked = []
  await ctx.route(/^https?:/, (r) => { if (r.request().isNavigationRequest()) asked.push(r.request().url()); return r.abort() })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  const shell = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href
  await p.goto(shell)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-split-caret'))

  console.log('the entry\n')
  await p.evaluate(() => document.querySelector('.ed-split-caret').click())
  const rows = await p.evaluate(() => [...document.querySelectorAll('.ed-save-menu > .ed-btn')].map((b) => ({
    name: b.getAttribute('aria-label') ?? b.querySelector('span')?.firstChild?.textContent?.trim() ?? b.textContent.trim(),
    title: b.title, h: Math.round(b.getBoundingClientRect().height),
  })))
  const i = rows.findIndex((r) => r.name.startsWith('Import PowerPoint'))
  ok(i >= 0, `"Import PowerPoint…" is in the Save-as menu (${rows.map((r) => r.name).join(' · ')})`)
  ok(i > 0 && rows[i - 1].name.startsWith('Replace from JSON'), 'it sits directly after Replace from JSON…, the other import')
  ok(i >= 0 && rows[i].h <= 32, `one line (${rows[i]?.h}px)`)
  const tip = rows[i]?.title ?? ''
  ok(/bento\.page/.test(tip) && /new tab/.test(tip) && /internet/.test(tip), `its tooltip names bento.page, a new tab and the connection ("${tip}")`)

  console.log('\nthe click\n')
  const [popup] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null),
    p.evaluate(() => [...document.querySelectorAll('.ed-save-menu > .ed-btn')].find((b) => (b.getAttribute('aria-label') ?? b.textContent).includes('Import PowerPoint')).click()),
  ])
  ok(!!popup, 'it opens a new tab')
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {})
    ok(asked.length === 1 && asked[0] === URL_EXPECTED, `the tab asks for the importer, and only it (${asked.join(', ') || 'nothing'})`)
    ok(await popup.evaluate(() => window.opener === null).catch(() => true), 'the new tab has no opener')
    await popup.close()
  }
  ok(p.url() === shell, 'this document stays where it was')
  ok(!(await p.evaluate(() => document.querySelector('.ed-save-menu')?.closest('.ed-dropdown')?.classList.contains('open'))), 'the menu closes')

  console.log('\ntranslated\n')
  await p.evaluate(() => [...document.querySelectorAll('.ed-lang-menu .ed-btn')].find((b) => b.textContent.trim() === 'Deutsch').click())
  await p.evaluate(() => document.querySelector('.ed-split-caret').click())
  const de = await p.evaluate(() => [...document.querySelectorAll('.ed-save-menu > .ed-btn')].map((b) => b.textContent.trim()))
  ok(de.some((x) => x.startsWith('PowerPoint importieren')), 'German shows "PowerPoint importieren…"')
  await p.evaluate(() => [...document.querySelectorAll('.ed-lang-menu .ed-btn')].find((b) => b.textContent.trim() === 'English').click())

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
