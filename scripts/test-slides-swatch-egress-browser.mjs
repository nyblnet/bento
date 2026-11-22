// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Two editor swatches paint document colours through the colour gate.
//
//   npm run build:single --prefix slides && node scripts/test-slides-swatch-egress-browser.mjs
//
// WHAT THIS PROVES, in the packaged document, with Offline mode on.
//   1. The Morph with picker draws a swatch of each candidate's fill. A fill
//      that is really `url(…)` is not fetched; a plain colour still paints.
//   2. The colour popover's Tokens list draws a chip of each colour token. A
//      token value is gated when a file opens, but a collaborator's edit
//      arrives as written: a peer (a second tab on the same deck, the
//      same-machine channel) sets a token to `url(…)`, and its chip fetches
//      nothing; a plain token's chip still paints.
// Both swatches are style.background, which loads a url() as an image. Every
// request to the payload origin is logged; a raw url() written on the same
// page IS fetched (the positive control), so a zero is a boundary.
// Mutations: drop cssColor at either swatch (inspector/animate.ts hintOf,
// inspector/colorpopover.ts token chip) and that row goes red.
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const root = new URL('..', import.meta.url).pathname
const shell = readFileSync(process.env.SHELL_HTML || join(root, 'slides/dist-single/Bento_Slides.bento.html'), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'bento-swatch-'))
const O = 'http://h.t' // routed: every request to it is logged, none leaves the machine
const DECK = 'https://deck.test/'
const write = (name, doc) => {
  const open = '<script type="application/bento+json" id="bento-doc">', close = '</' + 'script>'
  const at = shell.indexOf(open) + open.length
  writeFileSync(join(dir, name), shell.slice(0, at) + JSON.stringify(doc).replace(/</g, '\\u003c') + shell.slice(shell.indexOf(close, at)))
  return DECK + name
}
const theme = { background: '#ffffff', color: '#111111', accent: '#2f6df6', fontFamily: 'system-ui',
  tokens: { set: { ink: { type: 'color', values: { default: '#123456' } } } } }
const rect = (id, x, fill) => ({ id, type: 'shape', shape: 'rect', x, y: 100, w: 200, h: 150, rotation: 0, opacity: 1, fill, stroke: '#000000', strokeWidth: 0 })

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
async function context(log) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1'); localStorage.setItem('bento-offline', 'on') } catch {} })
  await ctx.routeWebSocket(/.*/, (ws) => ws.close())
  await ctx.route(/^https?:\/\/h\.t\//, (r) => { log(new URL(r.request().url()).pathname.slice(1)); r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) }) })
  await ctx.route(/^https:\/\/deck\.test\//, (r) => {
    const f = join(dir, new URL(r.request().url()).pathname.slice(1))
    return existsSync(f) ? r.fulfill({ status: 200, contentType: 'text/html', body: readFileSync(f) }) : r.fulfill({ status: 404, body: '' })
  })
  await ctx.route(/^https?:\/\/(?!h\.t\/|deck\.test\/)/, (r) => r.abort())
  return ctx
}
const booted = (p) => p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar'), null, { timeout: 15000 })
const control = async (p) => {
  await p.evaluate((o) => { const d = document.createElement('div'); d.style.cssText = `width:20px;height:20px;background-image:url(${o}/CONTROL)`; document.body.appendChild(d); d.getBoundingClientRect() }, O)
  await p.waitForTimeout(400)
}
const select = async (p, id) => {
  const b = await p.locator(`.ed-stage-scale [data-el-id="${id}"]`).boundingBox()
  await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await p.waitForTimeout(300)
}
const report = (label, hits) => {
  ok(hits.has('CONTROL'), `${label}: positive control — a raw url() on this page IS fetched`)
  const leaked = [...hits].filter((t) => t !== 'CONTROL')
  ok(leaked.length === 0, `${label}: no document colour fetched anything${leaked.length ? ' — ' + leaked.join(', ') : ''}`)
}

try {
  console.log('\nthe Morph with picker\n')
  {
    const hits = new Set()
    const ctx = await context((t) => hits.add(t))
    const p = await ctx.newPage()
    p.on('dialog', (d) => d.dismiss())
    // slide 1 holds the candidates; the picker is opened on slide 2's element
    await p.goto(write('morph.bento.html', { format: 'bento/slides', version: 1, docId: 'swatch-morph', title: 'm', size: { width: 1280, height: 720 }, theme,
      slides: [
        { id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: [rect('bad', 100, `url(${O}/morph-hint)`), rect('good', 400, '#00aa00')] },
        { id: 's2', background: '#ffffff', transition: 'morph', notes: '', elements: [rect('me', 100, '#ff0000')] },
      ] }))
    await booted(p); await p.waitForTimeout(400)
    await control(p)
    await p.evaluate(() => document.querySelectorAll('.ed-sidebar .ed-thumb')[1]?.click()); await p.waitForTimeout(400)
    await select(p, 'me')
    // the picker sits on the Animate tab: a click on the hidden button is what its own click runs
    await p.evaluate(() => document.querySelector('.ed-morph-pick-btn')?.click()); await p.waitForTimeout(600)
    const swatches = await p.evaluate(() => [...document.querySelectorAll('.ed-morph-pick .ed-morph-hint')].map((h) => getComputedStyle(h).backgroundColor))
    ok(swatches.length === 2 && swatches.includes('rgb(0, 170, 0)'), `the picker drew both candidates' swatches, the plain one in its colour (${swatches.join(' / ')})`)
    await ctx.close()
    report('Morph with picker', hits)
  }

  console.log('\nthe colour popover\'s Tokens list, after a collaborator\'s edit\n')
  {
    const hits = new Set()
    const ctx = await context((t) => hits.add(t))
    const url = write('tokens.bento.html', { format: 'bento/slides', version: 1, docId: 'swatch-tokens', title: 't', size: { width: 1280, height: 720 }, theme,
      slides: [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: [rect('z', 100, '#aabbcc')] }] })
    const A = await ctx.newPage(); A.on('dialog', (d) => d.dismiss())
    await A.goto(url); await booted(A); await A.waitForTimeout(500)
    const B = await ctx.newPage(); B.on('dialog', (d) => d.dismiss())
    await B.goto(url); await booted(B); await B.waitForTimeout(800)
    await control(A)
    // the peer writes the model directly, as any client can, and lets its session send it
    await B.evaluate((o) => { window.bento.doc.theme.tokens.set.brand = { type: 'color', values: { default: `url(${o}/token-chip)` } }; window.bento.sync.flush() }, O)
    const arrived = await A.waitForFunction(() => !!window.bento.doc.theme.tokens?.set?.brand, null, { timeout: 5000 }).then(() => true, () => false)
    ok(arrived, 'the collaborator\'s token reached this tab as written')
    await select(A, 'z')
    await A.evaluate(() => document.querySelector('.ed-props [data-paint]')?.click()); await A.waitForTimeout(400)
    await A.evaluate(() => document.querySelector('.ed-cpop-kinds [data-kind="tokens"]')?.click()); await A.waitForTimeout(600)
    const chips = await A.evaluate(() => [...document.querySelectorAll('.ed-cpop-tokens .ed-swatch')].map((c) => getComputedStyle(c).backgroundColor))
    ok(chips.length === 2 && chips.includes('rgb(18, 52, 86)'), `the Tokens list drew both chips, the plain token in its colour (${chips.join(' / ')})`)
    await ctx.close()
    report('Tokens list after a peer\'s edit', hits)
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
