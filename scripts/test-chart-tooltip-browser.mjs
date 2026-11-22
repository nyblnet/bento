// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A chart in the show draws its hover tooltip: a title, then one row per
// series with a small colour swatch, the series name and the value. The
// colour comes from the chart's option, which is document data, so the swatch
// must show a colour and nothing else: a colour it does not recognise draws
// no swatch, and the tooltip holds exactly its rows. The plain colour row is
// the control: it proves the rig reached a tooltip at all.
//
//   npm run build:single --prefix slides && node scripts/test-chart-tooltip-browser.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const shellPath = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).pathname
let failures = 0, checks = 0
const ok = (cond, what) => { checks++; if (cond) console.log('  ok    ' + what); else { failures++; console.log('  FAIL  ' + what) } }

const MARK = 'window.__rowMark=1'
const ROWS = [
  ['a plain colour', '#ff0000', 'background:#ff0000'],
  ['a colour with a closing quote and markup', `"><img src=x onerror="${MARK}">`, 'background:transparent'],
  ['a colour with a closing quote and an attribute', `red" onmouseover="${MARK}`, 'background:transparent'],
  ['a colour followed by another declaration', 'red;background:url(http://example.invalid/r.png)', 'background:transparent'],
  ['a colour written as a function that loads', 'url(r.png)', 'background:transparent'],
]
const deck = (color) => ({
  format: 'bento/slides', version: 1, title: 'chart', docId: 'rig-chart-tooltip', readonly: true,
  size: { width: 1280, height: 720 }, theme: { background: '#ffffff', color: '#111111', accent: '#ff9e8a', fontFamily: 'sans-serif' },
  slides: [{ id: 's1', background: '#ffffff', elements: [{
    id: 'c1', type: 'chart', x: 40, y: 40, w: 1200, h: 640, rotation: 0, opacity: 1, preset: 'bar',
    option: { tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: ['a', 'b', 'c'] }, yAxis: { type: 'value' },
      series: [{ name: 'S', type: 'bar', data: [3, 5, 4], itemStyle: { color } }] },
  }] }],
})

const shell = readFileSync(shellPath, 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'bento-charttip-'))
const blockRe = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  for (const [what, color, want] of ROWS) {
    const json = JSON.stringify(deck(color)).replace(/</g, '\\u003c')
    const file = join(dir, `row-${checks}.html`)
    writeFileSync(file, shell.replace(blockRe, () => `<script type="application/bento+json" id="bento-doc">\n${json}\n</scr` + 'ipt>'))
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const remote = []
    await ctx.routeWebSocket(/.*/, (ws) => ws.close())
    await ctx.route('**/*', (r) => { const u = r.request().url(); if (/^(file|data|blob):/.test(u)) return r.continue(); remote.push(u); return r.abort() })
    const page = await ctx.newPage()
    await page.goto('file://' + file)
    await page.waitForFunction(() => [...document.querySelectorAll('svg')].some((s) => s.getBoundingClientRect().width > 600), null, { timeout: 15000 })
    const box = await page.evaluate(() => {
      const r = [...document.querySelectorAll('svg')].map((s) => s.getBoundingClientRect()).find((b) => b.width > 600 && b.height > 300)
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    })
    let tip = null
    for (let fy = 0.3; fy <= 0.85 && !tip; fy += 0.1) {
      for (let fx = 0.15; fx <= 0.9 && !tip; fx += 0.05) {
        await page.mouse.move(box.x + box.w * fx, box.y + box.h * fy)
        tip = await page.evaluate(() => {
          const t = [...document.querySelectorAll('div')].find((d) => d.style.zIndex === '10000' && d.style.display === 'block')
          return t ? { kids: [...t.querySelectorAll('*')].map((e) => e.tagName + ':' + [...e.attributes].map((a) => a.name).join(',')), style: t.querySelector('span')?.getAttribute('style') ?? '' } : null
        })
      }
    }
    await page.waitForTimeout(300)
    const marked = await page.evaluate(() => window.__rowMark === 1)
    ok(!!tip, `${what}: the tooltip appears on hover`)
    ok(!!tip && tip.style.includes(want), `${what}: the swatch reads ${want}`)
    ok(!!tip && tip.kids.join(' ') === 'B: BR: SPAN:style B:', `${what}: the tooltip holds only its title, swatch and value (${tip?.kids.join(' ')})`)
    ok(!marked, `${what}: nothing else ran`)
    ok(!remote.some((u) => u.includes('example.invalid')), `${what}: nothing was fetched for the swatch`)
    await ctx.close()
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
