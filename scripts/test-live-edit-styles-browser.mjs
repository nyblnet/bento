// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// An edit that arrives from another participant is drawn by the same renderer
// as the file, so the renderer holds a slide background and a deck font to the
// same rules the file is held to when opened. Two tabs of one deck share edits
// over the same-machine channel; the sending tab writes the change straight
// into its document and flushes.
// A colour, a gradient and a plain font weight arriving are the controls.
//
//   npm run build:single --prefix slides && node scripts/test-live-edit-styles-browser.mjs

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const shellPath = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).pathname
let failures = 0, checks = 0
const ok = (cond, what) => { checks++; if (cond) console.log('  ok    ' + what); else { failures++; console.log('  FAIL  ' + what) } }

const FONT = 'data:font/woff2;base64,d09GMgABAAAAAA'
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const R = 'http://example.invalid/'
// [what, edit applied in the sending tab, check on the receiving tab]
const ROWS = [
  ['a colour background', `d.slides[0].background = '#eeeeee'`, { bg: 'rgb(238, 238, 238)' }],
  ['a gradient background', `d.slides[0].background = 'linear-gradient(90deg, #ff0000, #0000ff)'`, { bgImage: 'linear-gradient' }],
  ['a font with a plain weight', `d.fonts = [{ family: 'RowFace', asset: 'f1', weight: '700' }]`, { face: 'font-weight:700' }],
  ['a background that loads', `d.slides[0].background = 'url(${R}bg.png)'`, {}],
  ['a font weight followed by another rule', `d.fonts = [{ family: 'RowFace', asset: 'f1', weight: '900}body{background:url(${R}font.png)}' }]`, { noRule: true }],
  ['a picture fit followed by another declaration', `d.slides[0].elements[0].fit = 'cover;background:url(${R}fit.png)'`, {}],
]

const html = readFileSync(shellPath, 'utf8')
const blockRe = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/
let current = ''
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(current) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  let n = 0
  for (const [what, edit, want] of ROWS) {
    const doc = {
      format: 'bento/slides', version: 1, title: 'live', docId: `rig-live-edit-${n++}-${Date.now()}`,
      size: { width: 1280, height: 720 }, theme: { background: '#ffffff', color: '#111111', accent: '#ff9e8a', fontFamily: 'sans-serif' },
      assets: { f1: FONT },
      slides: [{ id: 's1', background: '#ffffff', elements: [{ id: 'i1', type: 'image', x: 100, y: 100, w: 300, h: 200, rotation: 0, opacity: 1, fit: 'cover', src: PNG }] }],
    }
    current = html.replace(blockRe, () => `<script type="application/bento+json" id="bento-doc">\n${JSON.stringify(doc).replace(/</g, '\\u003c')}\n</scr` + 'ipt>')
    const url = `http://127.0.0.1:${server.address().port}/row-${n}.html`
    const ctx = await browser.newContext()
    await ctx.routeWebSocket(/.*/, (ws) => ws.close())
    await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.startsWith('http://127.0.0.1') || /^(data|blob):/.test(u)) return r.continue(); return r.abort() })
    const receiver = await ctx.newPage()
    const fetched = []
    receiver.on('request', (q) => { if (q.url().includes('example.invalid')) fetched.push(q.url()) })
    await receiver.goto(url); await receiver.waitForTimeout(2500)
    const sender = await ctx.newPage(); await sender.goto(url); await sender.waitForTimeout(2500)
    await sender.evaluate((src) => { new Function('d', src)(window.bento.doc); window.bento.sync.flush() }, edit)
    await receiver.waitForTimeout(3000)
    const got = await receiver.evaluate(() => {
      const s = document.querySelector('.ed-stage-scale .bento-slide')
      const cs = s ? getComputedStyle(s) : null
      const rule = document.getElementById('bento-fonts')?.textContent ?? ''
      return { bg: cs?.backgroundColor, bgImage: cs?.backgroundImage ?? '', rule, arrived: JSON.stringify(window.bento.doc).length }
    })
    if (want.bg) ok(got.bg === want.bg, `${what}: drawn on the receiving canvas (${got.bg})`)
    if (want.bgImage) ok(got.bgImage.includes(want.bgImage), `${what}: drawn on the receiving canvas (${got.bgImage.slice(0, 40)})`)
    if (want.face) ok(got.rule.replace(/\s/g, '').includes(want.face), `${what}: the face is in the receiving tab's stylesheet`)
    if (want.noRule) ok(!/body\s*\{/.test(got.rule), `${what}: no rule beyond the face reaches the stylesheet`)
    ok(fetched.length === 0, `${what}: the receiving tab fetched nothing (${fetched.join(',')})`)
    await ctx.close()
  }
} finally {
  await browser.close()
  server.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
