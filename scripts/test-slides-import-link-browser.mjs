// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// File → Import PowerPoint… and Export for PowerPoint… open the converter
// on bento.page, and say so.
//
//   npm run build:single --prefix slides && node scripts/test-slides-import-link-browser.mjs
//
// WHAT THIS PROVES, in the packaged document:
//   1. the File menu (on the wordmark) has "Import PowerPoint…" with the
//      ways to make a deck and "Export for PowerPoint…" under Export, after
//      the import, each ONE line (DECISIONS 2026-10-30: File acts on the
//      document, Save ▾ only saves);
//   2. each description is the hover tooltip, naming bento.page, a new tab and
//      the internet connection; the export one also says the deck is not
//      uploaded;
//   3. clicking each opens exactly its URL in a new tab, with no opener (the
//      page cannot reach back into this document), and leaves this document
//      where it was: import → /convert?from=pptx (new shells go straight to
//      the page; /import only redirects for old ones), export → /convert;
//   4. both entries are translated in every catalog (checked in German).
// The network is blocked throughout: a click is measured by the tab it asks
// for, not by the page loading.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const ENTRIES = [
  { name: 'Import PowerPoint…', url: 'https://bento.page/convert?from=pptx', de: 'PowerPoint importieren' },
  { name: 'Export for PowerPoint…', url: 'https://bento.page/convert', de: 'Für PowerPoint exportieren', tipAlso: /not uploaded/ },
]

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
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-logo'))
  const openSave = () => p.evaluate(() => document.querySelector('.ed-logo').click())
  const rowsNow = () => p.evaluate(() => [...document.querySelectorAll('.ed-file-menu > .ed-btn')].map((b) => ({
    name: b.getAttribute('aria-label') ?? b.querySelector('span')?.firstChild?.textContent?.trim() ?? b.textContent.trim(),
    title: b.title, h: Math.round(b.getBoundingClientRect().height),
  })))

  console.log('the entries\n')
  await openSave()
  const rows = await rowsNow()
  const names = rows.map((r) => r.name)
  const imp = names.indexOf(ENTRIES[0].name), exp = names.indexOf(ENTRIES[1].name)
  ok(imp >= 0 && exp > imp && !(await p.evaluate(() => [...document.querySelectorAll('.ed-save-menu .ed-btn')].some((b) => /PowerPoint/.test(b.textContent)))),
    `Import PowerPoint… then Export for PowerPoint… in the File menu, neither in Save (${names.join(' · ')})`)
  for (const e of ENTRIES) {
    const r = rows.find((x) => x.name === e.name)
    ok(!!r && r.h <= 32, `${e.name}: one line (${r?.h}px)`)
    const tip = r?.title ?? ''
    ok(/bento\.page/.test(tip) && /new tab/.test(tip) && /internet/.test(tip) && (!e.tipAlso || e.tipAlso.test(tip)),
      `${e.name}: tooltip names bento.page, a new tab and the connection${e.tipAlso ? ', and that the deck is not uploaded' : ''} ("${tip}")`)
  }

  console.log('\nthe clicks\n')
  for (const e of ENTRIES) {
    asked.length = 0
    if (!(await p.evaluate(() => document.querySelector('.ed-file-menu')?.closest('.ed-dropdown')?.classList.contains('open')))) await openSave()
    const [popup] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null),
      p.evaluate((n) => [...document.querySelectorAll('.ed-file-menu > .ed-btn')].find((b) => b.getAttribute('aria-label') === n || b.textContent.trim().startsWith(n)).click(), e.name),
    ])
    ok(!!popup, `${e.name}: opens a new tab`)
    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {})
      ok(asked.length === 1 && asked[0] === e.url, `${e.name}: the tab asks for ${e.url}, and only it (${asked.join(', ') || 'nothing'})`)
      ok(await popup.evaluate(() => window.opener === null).catch(() => true), `${e.name}: the new tab has no opener`)
      await popup.close()
    }
    ok(p.url() === shell, `${e.name}: this document stays where it was`)
    ok(!(await p.evaluate(() => document.querySelector('.ed-file-menu')?.closest('.ed-dropdown')?.classList.contains('open'))), `${e.name}: the menu closes`)
  }

  console.log('\ntranslated\n')
  const setLang = (label) => p.evaluate((l) => {
    document.querySelector('.ed-topbar [data-cmd="preferences"]').click()
    const sel = document.querySelector('.ed-prefs select')
    sel.value = [...sel.options].find((o) => o.textContent.trim() === l).value
    sel.dispatchEvent(new Event('change'))
    document.querySelectorAll('.ed-about-overlay').forEach((o) => o.remove())
  }, label)
  await setLang('Deutsch')
  await openSave()
  const de = await p.evaluate(() => [...document.querySelectorAll('.ed-file-menu > .ed-btn')].map((b) => b.getAttribute('aria-label') ?? b.textContent.trim()))
  for (const e of ENTRIES) ok(de.some((x) => x.startsWith(e.de)), `German shows "${e.de}…"`)
  await setLang('English')

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
