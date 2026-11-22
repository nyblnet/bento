// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The QR page (bento.page/q/) plays a deck carried in its own URL fragment.
// It draws text boxes with their bold, italic and line breaks and nothing
// else, loads nothing, and runs only its own script. Built the way the
// release builds it, served over http, driven in Chromium. The built-in deck
// and a formatted text box are the controls that the page draws at all.
//
//   node scripts/test-qr-page-browser.mjs

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { deflateRawSync } from 'node:zlib'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
let failures = 0, checks = 0
const ok = (cond, what) => { checks++; if (cond) console.log('  ok    ' + what); else { failures++; console.log('  FAIL  ' + what) } }

const dir = mkdtempSync(join(tmpdir(), 'bento-qrpage-'))
execFileSync('node', [new URL('./build-qr-page.mjs', import.meta.url).pathname, join(dir, 'q/index.html')], { stdio: 'ignore' })
const page = readFileSync(join(dir, 'q/index.html'))
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/q/`

const frag = (doc) => deflateRawSync(Buffer.from(JSON.stringify(doc))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const one = (el, slide = {}) => ({ slides: [{ ...slide, elements: [{ type: 'text', x: 96, y: 170, w: 800, h: 260, html: 'x', ...el }] }] })
const MARK = 'window.__rowMark=1'
const R = 'http://example.invalid/'
const OTHER_ROWS = [
  ['an image with an error handler', one({ html: `<img src=x onerror="${MARK}">` })],
  ['an svg with a load handler', one({ html: `<svg onload="${MARK}"></svg>` })],
  ['a frame', one({ html: `<iframe srcdoc="<script>parent.__rowMark=1<\/script>"></iframe>` })],
  ['a bold tag with a handler', one({ html: `<b onmouseover="${MARK}" style="background:url(${R}b.png)">hover</b>` })],
  ['a script element', one({ html: `<script>${MARK}<\/script>` })],
  ['a position that adds a declaration', one({ x: `1px;background:url(${R}x.png);y:`, html: 'pos' })],
  ['a slide background that loads', one({ html: 'bg' }, { background: `url(${R}bg.png)` })],
]

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const open = async (hash) => {
    const ctx = await browser.newContext()
    const remote = []
    await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.startsWith(base) || /^(data|blob):/.test(u)) return r.continue(); remote.push(u); return r.abort() })
    const p = await ctx.newPage()
    const csp = []
    await p.exposeFunction('__rowCsp', (d) => csp.push(d))
    await p.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => window.__rowCsp(e.violatedDirective)))
    await p.goto(base + hash)
    return { ctx, p, remote, csp }
  }

  // control: the built-in deck plays
  {
    const { ctx, p } = await open('')
    await p.click('#play'); await p.waitForTimeout(800)
    ok((await p.textContent('#stage')).includes('You scanned'), 'the built-in deck plays (control)')
    await ctx.close()
  }
  // control: formatting survives
  {
    const { ctx, p, csp } = await open('#' + frag(one({ html: '<b>bold</b> and <i>italic</i><br>two' })))
    await p.waitForTimeout(1200)
    const got = await p.evaluate(() => ({ b: !!document.querySelector('#stage b'), i: !!document.querySelector('#stage i'), br: !!document.querySelector('#stage br'), text: document.querySelector('#stage').textContent }))
    ok(got.b && got.i && got.br && got.text.includes('bold and italictwo'), 'a text box keeps bold, italic and a line break (control)')
    ok(csp.length === 0, `the page's own script runs under its policy (${csp.join(',')})`)
    await ctx.close()
  }
  for (const [what, doc] of OTHER_ROWS) {
    const { ctx, p, remote } = await open('#' + frag(doc))
    await p.waitForTimeout(1200)
    const box = await p.evaluate(() => { const r = document.querySelector('#stage .el')?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null })
    if (box) { await p.mouse.move(box.x, box.y); await p.waitForTimeout(200) }
    const got = await p.evaluate(() => ({
      mark: window.__rowMark === 1,
      foreign: [...document.querySelectorAll('#stage .el *')].filter((e) => !['B', 'STRONG', 'I', 'EM', 'U', 'S', 'CODE', 'BR', 'SPAN', 'SUB', 'SUP'].includes(e.tagName) || e.attributes.length).map((e) => e.tagName),
      drawn: !!document.querySelector('#stage .el'),
    }))
    ok(got.drawn, `${what}: the slide is drawn`)
    ok(!got.mark, `${what}: nothing ran`)
    ok(got.foreign.length === 0, `${what}: no other element or attribute reached the page (${got.foreign.join(',')})`)
    ok(remote.length === 0, `${what}: nothing was fetched (${remote.join(',')})`)
    await ctx.close()
  }
} finally {
  await browser.close()
  server.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
