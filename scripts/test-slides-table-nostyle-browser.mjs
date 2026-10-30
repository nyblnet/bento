// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A table with no `style` object opens, and selecting it opens its panel.
//
//   npm run build:single --prefix slides && node scripts/test-slides-table-nostyle-browser.mjs
//
// WHAT THIS PROVES, in the packaged document. `style` is a required table key,
// but the load gate only required `columns` and `rows`, so a FULL document
// whose table omitted it got through. It rendered (render.ts guards `style`),
// and then selecting the table crashed the properties panel on
// `undefined.borderWidth`, leaving no table controls. (A COMPACT document
// already got the theme's table style from expansion.) Load now fills a
// missing or non-object `style` with the deck theme's table style, as a new
// table gets. Each of the three ways a document arrives is checked, and on
// each the table is selected with a real click:
//   1. a file that boots with it;
//   2. `window.bento.loadDoc` (the agent API);
//   3. Replace from JSON (pasted into the dialog and applied);
// and in every case: no page error, the table panel's own controls are shown,
// and the table now carries a style object. A table that DID give a style
// keeps exactly what it gave.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const shellPath = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url)
const shell = readFileSync(shellPath, 'utf8')
const open = '<script type="application/bento+json" id="bento-doc">'
const close = '</' + 'script>'
const at = shell.indexOf(open) + open.length
const dir = mkdtempSync(join(tmpdir(), 'bento-table-nostyle-'))

// a FULL document (it carries `version`, so it is not read as compact)
const table = (extra) => ({
  id: 'tb', type: 'table', x: 200, y: 160, w: 600, h: 240, rotation: 0, opacity: 1, header: true,
  columns: [{ w: 1 }, { w: 1 }],
  rows: [{ cells: [{ html: 'A' }, { html: 'B' }] }, { cells: [{ html: '1' }, { html: '2' }] }],
  ...extra,
})
const deck = (el) => ({
  format: 'bento/slides', version: 1, title: 'tables',
  size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#1E2A3A', accent: '#f7a600', fontFamily: 'system-ui' },
  slides: [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: [el] }],
})
const CASES = {
  'no style': table({}),
  'style: null': table({ style: null }),
  'style: a string': table({ style: 'boxed' }),
}
const GIVEN = { borderWidth: 3, borderColor: '#ff0000', fontSize: 22 }

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
async function page(doc) {
  const file = join(dir, `d${Math.random().toString(36).slice(2)}.bento.html`)
  writeFileSync(file, shell.slice(0, at) + JSON.stringify(doc).replace(/</g, '\\u003c') + shell.slice(shell.indexOf(close, at)))
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('dialog', (d) => d.accept())
  await p.route(/^https?:/, (r) => r.abort())
  await p.goto('file://' + file)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar .ed-logo') && !document.getElementById('bento-splash'), null, { timeout: 8000 })
  return { p, errors }
}
// select the table with a real click; report what the panel shows
async function selectTable(p) {
  await p.waitForFunction(() => document.querySelector('.ed-stage-scale [data-el-id="tb"]'))
  const r = await p.evaluate(() => { const b = document.querySelector('.ed-stage-scale [data-el-id="tb"]').getBoundingClientRect(); return { x: b.x + 12, y: b.y + 12 } })
  await p.mouse.click(r.x, r.y)
  await p.waitForTimeout(300)
  return p.evaluate(() => {
    const el = window.bento.doc.slides[0].elements.find((e) => e.id === 'tb')
    return {
      selected: window.bento.selection.includes('tb'),
      // "Header row" exists only in the table panel; the crash left it unbuilt
      panel: [...document.querySelectorAll('.ed-props .ed-row')].some((r) => /Header row/.test(r.textContent)),
      style: el && el.style,
    }
  })
}
// loadDoc and Replace start from a deck whose table has GIVEN, so a replace
// that silently did nothing must not pass: the style has to be the filled one
const verdict = (name, r, errors) => {
  ok(errors.length === 0 && r.selected && r.panel && r.style && typeof r.style === 'object' &&
    typeof r.style.borderWidth === 'number' && r.style.borderColor !== GIVEN.borderColor,
    `${name}: opens, selects, shows the table panel, carries a style` +
    (errors.length ? ` — ${errors[0].slice(0, 90)}` : r.panel ? '' : ' — no table panel'))
}

try {
  for (const [name, el] of Object.entries(CASES)) {
    console.log(`\n${name}\n`)
    // 1. boot
    {
      const { p, errors } = await page(deck(el))
      verdict('file boot', await selectTable(p), errors)
      await p.close()
    }
    // 2. loadDoc, over a starter deck that booted
    {
      const { p, errors } = await page(deck(table({ style: GIVEN })))
      const loaded = await p.evaluate((j) => !!window.bento.loadDoc(j), JSON.stringify(deck(el)))
      ok(loaded, 'loadDoc accepts it')
      verdict('loadDoc', await selectTable(p), errors)
      await p.close()
    }
    // 3. Replace from JSON, through the dialog
    {
      const { p, errors } = await page(deck(table({ style: GIVEN })))
      await p.locator('.ed-logo').click() // Replace from JSON is the document's: File ▸ Advanced
      await p.locator('.ed-file-menu [data-cmd="replace-json"]').click()
      await p.locator('.ed-about-json').fill(JSON.stringify(deck(el)))
      await p.locator('.ed-about .ed-btn-primary').click()
      await p.waitForFunction(() => window.bento.doc.slides[0].elements[0]?.style !== undefined || !document.querySelector('.ed-about-json'), null, { timeout: 4000 }).catch(() => {})
      await p.evaluate(() => document.querySelector('.ed-about-overlay')?.remove())
      verdict('Replace from JSON', await selectTable(p), errors)
      await p.close()
    }
  }

  console.log('\na style that was given is kept\n')
  const { p, errors } = await page(deck(table({ style: GIVEN })))
  const r = await selectTable(p)
  ok(errors.length === 0 && r.panel && JSON.stringify(r.style) === JSON.stringify(GIVEN), `the given style is untouched (${JSON.stringify(r.style)})`)
  await p.close()
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
