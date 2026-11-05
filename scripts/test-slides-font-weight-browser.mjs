// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// An embedded font is declared with the weights it really has (#850).
//
//   npm run build:single --prefix slides && node scripts/test-slides-font-weight-browser.mjs
//
// Before: "＋ Embed font file…" wrote every face as `font-weight: normal`. A
// variable font covering 100..900 then matched only 400, and Bold drew the
// 400 instance thickened by the browser — faux bold.
//
// WHAT THIS PROVES, through the real picker in the packaged editor:
//   1. each file lands in doc.fonts with the weight it states: the fvar range
//      for a variable TTF/WOFF, the MEASURED range for a variable WOFF2 (our
//      test font and the shell's own Instrument Sans, a real one), the OS/2
//      weight and italic bit for a static TTF, nothing for a static WOFF2
//      (whose tables cannot be read);
//   2. it renders: a text element at weight 700 in the embedded variable
//      family is much wider than one at 400 — the test font's bar grows with
//      wght, and only the font's own 700 grows it;
//   3. the measure can tell: the same bytes declared `normal` (the old
//      behaviour) render 700 at the 400 width, so (2) is not luck.
//
// Fonts: scripts/fixtures/fonts (ours, MIT; make-weight-fonts.py rebuilds them).
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const fixture = (name) => fileURLToPath(new URL(`./fixtures/fonts/${name}`, import.meta.url))
// the shell's own variable WOFF2, written out so it can go through the picker
const scratch = mkdtempSync(join(tmpdir(), 'bento-font-weight-'))
const fontdata = readFileSync(new URL('../slides/src/fontdata.ts', import.meta.url), 'utf8')
const instrument = join(scratch, 'InstrumentSans.woff2')
writeFileSync(instrument, Buffer.from(fontdata.match(/INSTRUMENT_VAR = 'data:font\/woff2;base64,([^']+)'/)[1], 'base64'))

const rows = [
  ['variable ttf', fixture('BentoWeightVar.ttf'), 'BentoWeightVar', { weight: '100 900' }],
  ['variable woff', fixture('BentoWeightVar.woff'), 'BentoWeightVar', { weight: '100 900' }],
  ['variable woff2 (measured)', fixture('BentoWeightVar.woff2'), 'BentoWeightVar', { weight: '100 900' }],
  ['Instrument Sans woff2 (measured)', instrument, 'InstrumentSans', { weight: '400 700' }],
  ['static ttf', fixture('BentoWeightStatic.ttf'), 'BentoWeightStatic', { weight: '700', style: 'italic' }],
  ['static woff2', fixture('BentoWeightStatic.woff2'), 'BentoWeightStatic', {}],
]

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.route(/^https?:/, (r) => r.abort())
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc)
  const text = (id, y, weight) => ({ id, type: 'text', x: 100, y, w: 1100, h: 120, rotation: 0, opacity: 1, html: 'HHHHHHHH', fontSize: 80, fontWeight: weight, color: '#1e2a3a' })

  for (const [name, path, family, want] of rows) {
    console.log(`\n${name}\n`)
    await p.evaluate(([t1]) => {
      const d = JSON.parse(JSON.stringify(window.bento.doc))
      d.slides = [{ id: 's1', background: '#ffffff', elements: [t1] }]
      d.fonts = []
      window.bento.loadDoc(JSON.stringify(d))
    }, [text('t1', 100, 400)])
    await p.waitForTimeout(300)
    await p.locator('.ed-stage-scale [data-el-id="t1"]').click()
    const chooser = p.waitForEvent('filechooser')
    // the font list's last entry (the inspector's Text section)
    await p.locator('.ed-props select[aria-label="Font"]').selectOption({ label: '＋ Embed font file…' })
    await (await chooser).setFiles(path)
    await p.waitForFunction((family) => window.bento.doc.fonts?.some((f) => f.family === family), family, { timeout: 10000 })
    const entry = await p.evaluate((family) => window.bento.doc.fonts.find((f) => f.family === family), family)
    const got = { weight: entry.weight, style: entry.style }
    ok(got.weight === want.weight && got.style === want.style,
      `doc.fonts states ${JSON.stringify(want)} (got ${JSON.stringify(got)})`)
  }

  // 2 + 3: render the variable font at 400 and 700, declared as embedded and as the old `normal`.
  const asset = 'data:font/ttf;base64,' + readFileSync(fixture('BentoWeightVar.ttf')).toString('base64')
  const width = async (faces) => {
    await p.evaluate(([faces, asset, a, b]) => {
      const d = JSON.parse(JSON.stringify(window.bento.doc))
      d.slides = [{ id: 's1', background: '#ffffff', elements: [a, b] }]
      d.fonts = faces
      d.assets = { ...d.assets, 'weight-test': asset }
      window.bento.loadDoc(JSON.stringify(d))
    }, [faces, asset, { ...text('w400', 100, 400), fontFamily: faces[0].family }, { ...text('w700', 300, 700), fontFamily: faces[0].family }])
    await p.evaluate(() => document.fonts.ready)
    await p.waitForTimeout(300)
    return p.evaluate(() => ['w400', 'w700'].map((id) => {
      const inner = document.querySelector(`.ed-stage-scale [data-el-id="${id}"] .bento-text-inner`)
      const r = document.createRange(); r.selectNodeContents(inner); return r.getBoundingClientRect().width
    }))
  }
  console.log('\nrendering\n')
  const [real400, real700] = await width([{ family: 'Bento Weight Embedded', asset: 'weight-test', weight: '100 900' }])
  const [old400, old700] = await width([{ family: 'Bento Weight Old', asset: 'weight-test' }])
  const ratio = (a, b) => Math.round((b / a) * 100) / 100
  // the bar's advance is 260 units at 400 and 404 at 700 (make-weight-fonts.py): 1.55x
  ok(ratio(real400, real700) > 1.4, `declared 100 900: 700 renders the font's own bold, ${ratio(real400, real700)}x the 400 width`)
  ok(ratio(old400, old700) < 1.1, `control, declared normal: 700 is faux bold of 400, ${ratio(old400, old700)}x`)
  ok(Math.abs(real400 - old400) < 1, `both render the same 400 (${Math.round(real400)} vs ${Math.round(old400)}px)`)

  ok(errors.length === 0, `no page errors (${errors.join('; ')})`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks pass`)
if (failures) process.exit(1)
