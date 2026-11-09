// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A colour from the document draws only as a colour — in the built shell.
//
//   npm run build:single --prefix dash && node scripts/test-dash-colours-browser.mjs
//
// node scripts/test-dash-colours.ts holds every paint function's table; this
// proves the real grid reaches them. The built file is opened with
// conditional formats whose colours are a CONTROL (a real colour, which must
// paint: a background, a text colour and a data bar) and then values that are
// not colours (a quote that would end the style attribute, a declaration that
// would fetch). Every formatted cell and bar is hovered; no handler may exist,
// nothing may run, nothing may be fetched — and the bars must still draw.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

const SHELL = fileURLToPath(new URL('../dash/dist-single/Bento_Dash.bento.html', import.meta.url))
const BLOCK = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const dir = mkdtempSync(join(tmpdir(), 'dash-colours-'))
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  // the starter workbook, as the shell boots it
  const ctx0 = await browser.newContext()
  await ctx0.route('**/*', (route) => (/^(file|data|blob):/.test(route.request().url()) ? route.continue() : route.abort()))
  await ctx0.routeWebSocket(/.*/, (ws) => ws.close())
  const p0 = await ctx0.newPage()
  await p0.goto('file://' + SHELL)
  await p0.waitForFunction(() => window.bento?.doc && document.querySelector('.dg-cell'))
  const doc = await p0.evaluate(() => JSON.parse(JSON.stringify(window.bento.doc)))
  await ctx0.close()
  const si = doc.sheets.findIndex((s) => s.kind === 'table' &&
    s.columns.some((c) => ['number', 'money', 'int', 'percent'].includes(c.type)))
  ok(si >= 0, 'the starter workbook has a table with a number column')
  const sheet = doc.sheets[si]
  const col = sheet.columns.find((c) => ['number', 'money', 'int', 'percent'].includes(c.type))

  const shell = readFileSync(SHELL, 'utf8')
  const open = async (name, colour) => {
    // Its own docId and NO collab block: the starter carries live
    // credentials, and files sharing them are one room on the relay — the
    // runs would merge into each other, and a rig must not reach the network.
    const d = structuredClone(doc)
    delete d.collab
    d.docId = `zq-colours-${name}`
    d.sheets[si].condfmt = {
      [col.id]: [
        { kind: 'colorScale', colors: [colour, '#00ff00'] },
        { kind: 'cellValue', op: 'notBlank', style: { color: colour } },
        { kind: 'dataBar', color: colour },
      ],
    }
    const json = JSON.stringify(d).replace(/</g, '\\u003c')
    const out = shell.replace(BLOCK, () => '<script type="application/bento+json" id="bento-doc">\n' + json + '\n</scr' + 'ipt>')
    if (out === shell) throw new Error('splice failed')
    const f = join(dir, `${name}.bento.html`)
    writeFileSync(f, out)
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const fetched = []
    await ctx.routeWebSocket(/.*/, (ws) => { fetched.push('WS ' + ws.url()); ws.close() })
    await ctx.route('**/*', (route) => {
      const u = route.request().url()
      if (u.startsWith('file:') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue()
      fetched.push(u); return route.abort()
    })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('file://' + f)
    await page.waitForFunction(() => window.bento?.doc && document.querySelector('.dg-cell'))
    await page.locator('.dx-tab', { hasText: sheet.name }).first().click()
    await page.waitForTimeout(400)
    const cells = await page.evaluate((cid) => [...document.querySelectorAll(`.dg-row[data-rid] .dg-cell[data-col="${CSS.escape(cid)}"]`)]
      .slice(0, 15).map((e) => {
        const r = e.getBoundingClientRect()
        const bar = e.querySelector('.dg-bar')
        return {
          x: r.x + r.width / 2, y: r.y + r.height / 2,
          bg: getComputedStyle(e).backgroundColor, fg: getComputedStyle(e).color,
          bar: bar ? getComputedStyle(bar).backgroundColor : null,
          barW: bar ? bar.getBoundingClientRect().width : 0,
        }
      }), col.id)
    // every element in the grid, attributes and all: not one handler
    const handlers = await page.evaluate(() => [...document.querySelectorAll('*')]
      .filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length)
    for (const c of cells) { await page.mouse.move(c.x, c.y); await page.waitForTimeout(20) }
    for (const c of cells) { await page.mouse.move(c.x - 30, c.y); await page.waitForTimeout(10) }
    const ran = await page.evaluate(() => window.__zqRan ?? 0)
    await ctx.close()
    return { cells, handlers, ran, fetched, errors }
  }

  // ---- the control: a real colour paints all three ways
  const ctrl = await open('control', '#ff0000')
  ok(ctrl.cells.length >= 3, `control: the formatted column is on screen (${ctrl.cells.length} cells)`)
  ok(ctrl.cells.some((c) => c.bg === 'rgb(255, 0, 0)'), `control: the colour scale paints its red stop (${[...new Set(ctrl.cells.map((c) => c.bg))].slice(0, 4).join(' | ')})`)
  ok(ctrl.cells.every((c) => c.fg === 'rgb(255, 0, 0)'), 'control: the cell-value rule paints the text red')
  ok(ctrl.cells.some((c) => c.bar === 'rgb(255, 0, 0)' && c.barW > 0), 'control: the data bars draw red')
  ok(ctrl.errors.length === 0, `control: no page errors (${ctrl.errors.join('; ')})`)

  // ---- values that are not colours
  const MARK = 'window.__zqRan=(window.__zqRan||0)+1'
  const hostile = {
    'quote': `x" onmouseover="${MARK}`,
    'quote-hex': `#f00" onmouseover="${MARK}" x="`,
    'single': `x' onmouseover='${MARK}`,
    'fetch': 'red;background:url(http://127.0.0.1:9/zq-fetch)',
    'img': `red"><img src=x onerror="${MARK}">`,
  }
  for (const [name, colour] of Object.entries(hostile)) {
    const r = await open(name, colour)
    ok(r.cells.length === ctrl.cells.length, `${name}: the column still paints (${r.cells.length} cells)`)
    ok(r.handlers === 0, `${name}: no element carries an event-handler attribute (${r.handlers})`)
    ok(r.ran === 0, `${name}: hovering every cell runs nothing (${r.ran})`)
    ok(r.fetched.length === 0, `${name}: nothing is fetched (${r.fetched.join(', ')})`)
    ok(r.cells.some((c) => c.barW > 0), `${name}: the data bars still draw, in the default colour`)
    ok(r.cells.some((c) => c.bg === 'rgb(0, 255, 0)'), `${name}: the colour scale's good stop still paints`)
    ok(r.errors.length === 0, `${name}: no page errors (${r.errors.join('; ')})`)
  }
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} passed${failures ? `, ${failures} FAILED` : ''}`)
process.exit(failures ? 1 : 0)
