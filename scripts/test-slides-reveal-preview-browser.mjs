// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Presenting a deck and clicking a shape never opens a frame or runs script.
//
//   npm run build:single --prefix slides && node scripts/test-slides-reveal-preview-browser.mjs [shell]
//
// Reveal's click-to-preview overlay binds to ANY element carrying a
// data-preview-* attribute, and a deck's svg keeps data-* names. The overlay
// is cut out of the bundle (slides/vite.config.ts); this rig clicks, with a
// real mouse, every kind of hostile shape through each way a deck arrives:
// file boot, window.bento.loadDoc, and pasting a bento clip.
//   - CONTROL 1: every click reaches a shape (a capture listener counts them).
//   - CONTROL 2: the attributes really are in the rendered DOM, so the
//     overlay's trigger selector would match; only the disarmed engine stops it.
//   - Run it on a shell built WITHOUT the disarm and it fails (script runs,
//     frame opens, URL fetched).
import { readFileSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

const SHELL = resolve(process.argv[2] || 'slides/dist-single/Bento_Slides.bento.html')
const shell = readFileSync(SHELL, 'utf8')
const DIR = realpathSync(mkdtempSync(join(tmpdir(), 'reveal-preview-')))
let pass = 0, fails = 0
const ok = (c, m) => { c ? pass++ : fails++; console.log((c ? '  ok    ' : '  FAIL  ') + m) }

const J = 'javascript:parent.__pwned=1'
const PAYLOADS = [
  ['data-preview-link', J],
  ['data-preview-link', 'about:blank#frame'],
  ['data-preview-image', 'https://egress.invalid/img.png'],
  ['data-preview-video', 'https://egress.invalid/v.mp4'],
  ['data-background-iframe', 'https://egress.invalid/bg'],
]
const svgFor = ([a, v]) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g ${a}="${v}"><rect width="100" height="100" fill="red"/></g></svg>`
const els = (p) => PAYLOADS.map((pl, i) => ({ id: p + i, type: 'svg', x: 20 + i * 250, y: 100, w: 220, h: 220, rotation: 0, opacity: 1, markup: svgFor(pl) }))
const blank = (id) => ({ format: 'bento/slides', version: 1, docId: id, title: 'b', size: { width: 1280, height: 720 }, slides: [{ id: 's0', background: '#fff', transition: 'none', notes: '', elements: [] }] })
const deck = (id) => ({ ...blank(id), slides: [{ id: 's1', background: '#fff', transition: 'none', notes: '', elements: els('e') }] })
const write = (name, d) => {
  const html = shell.replace(/(<script[^>]*id="bento-doc"[^>]*>)[\s\S]*?(<\/script>)/, (_, a, b) => a + JSON.stringify(d).replace(/</g, '\\u003c') + b)
  const f = join(DIR, name); writeFileSync(f, html); return 'file://' + f
}
const SEL = '[data-preview-link],[data-preview-image],[data-preview-video],[data-background-iframe]'

const b = await chromium.launch({ headless: true })
async function run(label, prep) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1') } catch {} })
  const reqs = []
  await ctx.route(/^https?:/, (r) => { reqs.push(r.request().url()); r.abort() })
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)))
  await prep(p)
  await p.locator('.ed-present-pill .ed-pill-caret').click()
  await p.locator('.ed-present-pill .ed-menu').getByText('Present in this tab', { exact: true }).click()
  await p.waitForSelector('.reveal .slides section.present [data-el-id]', { timeout: 10000 }); await p.waitForTimeout(800)
  await p.evaluate(() => { window.__hits = 0; document.addEventListener('click', (e) => { if (e.target.closest?.('.reveal .slides [data-el-id]')) window.__hits++ }, true) })
  const n = await p.evaluate((sel) => document.querySelectorAll('.reveal .slides ' + sel).length, SEL)
  ok(n >= 1, `${label}: CONTROL, the hostile attributes reach the rendered slide (${n})`)
  const rects = await p.locator('.reveal .slides section.present [data-el-id] rect').all()
  ok(rects.length >= PAYLOADS.length && rects.length % PAYLOADS.length === 0, `${label}: ${rects.length} shapes to click`)
  for (const r of rects) {
    const bx = await r.boundingBox()
    await p.mouse.click(bx.x + bx.width / 2, bx.y + bx.height / 2) // trusted click
    await p.waitForTimeout(250)
  }
  const hits = await p.evaluate(() => window.__hits)
  ok(hits === rects.length, `${label}: CONTROL, all ${rects.length} clicks reached a shape (${hits})`)
  const s = await p.evaluate(() => ({ pwned: !!window.__pwned, frames: document.querySelectorAll('iframe').length, overlay: document.querySelectorAll('.r-overlay').length }))
  ok(!s.pwned, `${label}: no script ran`)
  ok(s.frames === 0 && s.overlay === 0, `${label}: no frame or overlay opened (frames ${s.frames}, overlays ${s.overlay})`)
  const egress = reqs.filter((u) => u.includes('egress.invalid'))
  ok(egress.length === 0, `${label}: nothing fetched ${JSON.stringify(egress)}`)
  ok(errs.length === 0, `${label}: no page errors ${errs.join('|')}`)
  await ctx.close()
}
const ready = (p) => p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar'), null, { timeout: 15000 })
await run('file boot', async (p) => { await p.goto(write('boot.bento.html', deck('rp-boot'))); await ready(p) })
await run('window.bento.loadDoc', async (p) => {
  await p.goto(write('blank1.bento.html', blank('rp-blank1'))); await ready(p)
  ok(await p.evaluate((j) => !!window.bento.loadDoc(j), JSON.stringify(deck('rp-load'))), 'loadDoc accepted the deck')
})
await run('bento clip paste (slides, then elements)', async (p) => {
  await p.goto(write('blank2.bento.html', blank('rp-blank2'))); await ready(p)
  const d = deck('x')
  for (const clip of [{ __bento: 'clip', kind: 'slides', slides: d.slides }, { __bento: 'clip', kind: 'elements', elements: els('c') }]) {
    await p.evaluate((t) => { const dt = new DataTransfer(); dt.setData('text/plain', t); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })) }, JSON.stringify(clip))
    await p.waitForTimeout(500)
  }
  const n = await p.evaluate(() => window.bento.doc.slides.map((s) => s.elements.length).join('/'))
  ok(/[1-9]/.test(n), `clip pastes landed (${n})`)
  await p.evaluate(() => { const i = window.bento.doc.slides.findIndex((s) => s.elements.length >= 5); document.querySelectorAll('.ed-sidebar .ed-thumb')[i]?.click() })
  await p.waitForTimeout(300)
})
await b.close()
console.log(`${pass}/${pass + fails} checks passed`)
process.exit(fails ? 1 : 0)
