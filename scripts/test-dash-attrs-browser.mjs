// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A column's width and id, and a sheet's row ids, reach the grid's markup only
// as values — in the built shell.
//
//   npm run build:single --prefix dash && node scripts/test-dash-attrs-browser.mjs
//
// node scripts/test-dash-attrs.ts holds the repair and helper tables; this
// proves the real grid's attribute sites. A sheet whose column width, column
// id and row-id run are NOT what they should be (a quote that would end the
// attribute, then a handler) arrives three ways:
//
//   live    through a store commit, as a live edit does — parseDoc never sees
//           it, so the grid's own escaping and width coercion are all there is;
//   file    in a saved file, which parseDoc repairs on open;
//   frozen  in a file under a policy this build does not know, which parseDoc
//           must leave untouched — the grid again carries it alone.
//
// Each is hovered cell by cell: no element may carry an event-handler
// attribute, nothing may run, the values must still be on screen, and the
// width must be the default. The same three with ordinary values are the
// control: their width (180px) and values arrive as written.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

const SHELL = fileURLToPath(new URL('../dash/dist-single/Bento_Dash.bento.html', import.meta.url))
const BLOCK = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const MARK = 'window.__zqRan=(window.__zqRan||0)+1'
const BAD = {
  id: `x" onmouseover="${MARK}" y="`,
  w: `1px" onmouseover="${MARK}" y="`,
  rid: `7" onmouseover="${MARK}" y="`,
}
const GOOD = { id: 'amount', w: 180, rid: 7 }

/** A small sheet carrying the given id / width / row-id start, with totals. */
const sheetWith = (v) => ({
  id: 'zq-sheet', name: 'Probe', kind: 'table', steps: [],
  // both columns frozen, so the second one's sticky `left:` adds up the first one's width
  frozen: { rows: 0, cols: 2 },
  rids: [[v.rid, 3]],
  columns: [
    { id: v.id, name: 'Amount', type: 'number', w: v.w },
    { id: 'other', name: 'Other', type: 'number', w: 120 },
  ],
  data: { [v.id]: { enc: 'raw', v: [4111, 4222, 4333] }, other: { enc: 'raw', v: [1, 2, 3] } },
  totals: { [v.id]: 'sum', other: 'sum' },
})

const dir = mkdtempSync(join(tmpdir(), 'dash-attrs-'))
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx0 = await browser.newContext()
  await ctx0.route('**/*', (route) => (/^(file|data|blob):/.test(route.request().url()) ? route.continue() : route.abort()))
  await ctx0.routeWebSocket(/.*/, (ws) => ws.close())
  const p0 = await ctx0.newPage()
  await p0.goto('file://' + SHELL)
  await p0.waitForFunction(() => window.bento?.doc && document.querySelector('.dg-cell'))
  const starter = await p0.evaluate(() => JSON.parse(JSON.stringify(window.bento.doc)))
  await ctx0.close()
  const shell = readFileSync(SHELL, 'utf8')

  // Each file its own docId and NO collab block: the starter carries live
  // credentials, and two files holding them are one shared room — the second
  // opened with the first one's columns merged in. The network is closed too.
  const fileOf = (name, doc) => {
    const { collab: _drop, ...rest } = doc
    const json = JSON.stringify({ ...rest, docId: `zq-${name}` }).replace(/</g, '\\u003c')
    const out = shell.replace(BLOCK, () => '<script type="application/bento+json" id="bento-doc">\n' + json + '\n</scr' + 'ipt>')
    if (out === shell) throw new Error('splice failed')
    const f = join(dir, `${name}.bento.html`)
    writeFileSync(f, out)
    return 'file://' + f
  }

  /** Open, put the probe sheet on screen, hover everything, report. */
  const run = async (how, v) => {
    let url = 'file://' + SHELL
    if (how === 'file') url = fileOf(`file-${typeof v.w}`, { ...starter, sheets: [...starter.sheets, sheetWith(v)] })
    if (how === 'frozen') url = fileOf(`frozen-${typeof v.w}`, { ...starter, policy: 'a-later-policy', sheets: [...starter.sheets, sheetWith(v)] })
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const fetched = []
    await ctx.routeWebSocket(/.*/, (ws) => { fetched.push(ws.url()); ws.close() })
    await ctx.route('**/*', (route) => {
      const u = route.request().url()
      if (u.startsWith('file:') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue()
      fetched.push(u); return route.abort()
    })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(url)
    await page.waitForFunction(() => window.bento?.doc && document.querySelector('.dg-cell'))
    if (how === 'live') await page.evaluate((s) => window.bento.commit({ op: 'setSheet', id: s.id, sheet: s }), sheetWith(v))
    await page.locator('.dx-tab', { hasText: 'Probe' }).first().click()
    await page.waitForTimeout(400)
    const seen = await page.evaluate(() => {
      const head = [...document.querySelectorAll('.dg-h[data-col]')]
      const amount = head.find((h) => h.textContent.includes('Amount'))
      return {
        width: amount ? Math.round(amount.getBoundingClientRect().width) : -1,
        text: document.querySelector('.dg-table')?.textContent ?? '',
        boxes: [...document.querySelectorAll('.dg-table .dg-cell, .dg-table [data-grip], .dg-table [data-filter], .dg-table [data-retype]')]
          .slice(0, 80).map((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
          .filter((p) => p.x > 0 && p.y > 0 && p.x < 1440 && p.y < 900),
        handlers: [...document.querySelectorAll('*')]
          .filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length,
      }
    })
    for (const b of seen.boxes) { await page.mouse.move(b.x, b.y); await page.waitForTimeout(8) }
    const ran = await page.evaluate(() => window.__zqRan ?? 0)
    await ctx.close()
    return { ...seen, ran, errors, fetched }
  }

  for (const how of ['live', 'file', 'frozen']) {
    const ctrl = await run(how, GOOD)
    ok(ctrl.width === 180, `${how} control: the column is as wide as the file says (${ctrl.width}px)`)
    ok(ctrl.text.includes('4,222') || ctrl.text.includes('4222'), `${how} control: its values are on screen`)
    ok(ctrl.handlers === 0 && ctrl.ran === 0, `${how} control: no handler, nothing runs`)

    const r = await run(how, BAD)
    ok(r.boxes.length > 5, `${how}: the grid painted and was hovered (${r.boxes.length} targets)`)
    ok(r.handlers === 0, `${how}: no element carries an event-handler attribute (${r.handlers})`)
    ok(r.ran === 0, `${how}: hovering every cell runs nothing (${r.ran})`)
    ok(r.fetched.length === 0, `${how}: nothing reached the network (${r.fetched.join(', ')})`)
    ok(r.width === 130, `${how}: a width that is not a number draws at the default (${r.width}px)`)
    // Row ids that are not numbers cannot be read back: live or frozen, those
    // rows draw empty (and never as markup). An ordinary file repairs them.
    if (how === 'file') ok(r.text.includes('4,222') || r.text.includes('4222'), `${how}: the column's values are still on screen`)
    ok(r.errors.length === 0, `${how}: no page errors (${r.errors.slice(0, 2).join('; ')})`)
  }
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} passed${failures ? `, ${failures} FAILED` : ''}`)
process.exit(failures ? 1 : 0)
