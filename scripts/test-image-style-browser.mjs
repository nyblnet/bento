// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A picture's `fit` and corner `radius` come from the document and are drawn
// into the picture's inline style. A fit draws as its keyword and a radius as
// its number of pixels; a value that is neither draws as the default, adds
// nothing else to the style, and loads nothing. Opened as a file, in the show.
// The rig's own page-made load is the control that the recorder sees requests.
//
//   npm run build:single --prefix slides && node scripts/test-image-style-browser.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const shellPath = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).pathname
let failures = 0, checks = 0
const ok = (cond, what) => { checks++; if (cond) console.log('  ok    ' + what); else { failures++; console.log('  FAIL  ' + what) } }

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const R = (n) => `http://example.invalid/${n}.png`
// [what, extra props, expected object-fit, expected border radius]
const ROWS = [
  ['fit cover, radius 12', { fit: 'cover', radius: 12 }, 'cover', '12px'],
  ['fit contain, no radius', { fit: 'contain' }, 'contain', '0px'],
  ['no fit at all', {}, 'fill', '0px'],
  ['a fit followed by another declaration', { fit: `cover;background:url(${R('fit')})` }, 'fill', '0px'],
  ['a radius followed by another declaration', { radius: `1;background:url(${R('radius')});x:` }, 'fill', '0px'],
]
const deck = (extra) => ({
  format: 'bento/slides', version: 1, title: 'img', docId: 'rig-image-style', readonly: true,
  size: { width: 1280, height: 720 }, theme: { background: '#ffffff', color: '#111111', accent: '#ff9e8a', fontFamily: 'sans-serif' },
  slides: [{ id: 's1', background: '#ffffff', elements: [{ id: 'i1', type: 'image', x: 100, y: 100, w: 300, h: 200, rotation: 0, opacity: 1, src: PNG, ...extra }] }],
})

const shell = readFileSync(shellPath, 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'bento-imgstyle-'))
const blockRe = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  for (const [what, extra, fit, radius] of ROWS) {
    const json = JSON.stringify(deck(extra)).replace(/</g, '\\u003c')
    const file = join(dir, `row-${checks}.html`)
    writeFileSync(file, shell.replace(blockRe, () => `<script type="application/bento+json" id="bento-doc">\n${json}\n</scr` + 'ipt>'))
    const ctx = await browser.newContext()
    const remote = []
    await ctx.routeWebSocket(/.*/, (ws) => ws.close())
    await ctx.route('**/*', (r) => { const u = r.request().url(); if (/^(file|data|blob):/.test(u)) return r.continue(); remote.push(u); return r.abort() })
    const page = await ctx.newPage()
    await page.goto('file://' + file)
    await page.waitForFunction(() => document.querySelectorAll('.reveal [data-el-id="i1"] img').length > 0, null, { timeout: 15000 })
    await page.waitForTimeout(500)
    const got = await page.evaluate(() => {
      const img = document.querySelector('.reveal [data-el-id="i1"] img')
      const cs = getComputedStyle(img)
      return { fit: cs.objectFit, radius: cs.borderTopLeftRadius, bg: img.style.backgroundImage }
    })
    await page.evaluate(() => { const i = new Image(); i.src = 'http://example.invalid/control.png' })
    await page.waitForTimeout(300)
    ok(got.fit === fit, `${what}: object-fit is ${fit} (${got.fit})`)
    ok(got.radius === radius, `${what}: the corner radius is ${radius} (${got.radius})`)
    ok(!got.bg, `${what}: the picture's style holds no background`)
    ok(remote.some((u) => u.includes('control.png')), `${what}: the recorder sees a page-made load (control)`)
    ok(!remote.some((u) => !u.includes('control.png') && u.includes('example.invalid')), `${what}: nothing else was fetched`)
    await ctx.close()
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
