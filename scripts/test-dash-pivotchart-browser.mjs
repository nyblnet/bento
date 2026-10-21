// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The pivot and chart tools finish what they start — measured in the packaged
// document.
//
//   npm run build:single --prefix dash && node scripts/test-dash-pivotchart-browser.mjs
//   (PLAYWRIGHT_MODULE / CHROME_PATH as the other dash browser rigs take them)
//
// Each row is a finding from the 2026-10-20 review, driven through the real UI:
//   PIVOT  1. ＋ Pivot opens the pivot as a SHEET (where the grid was) with the
//             field editor in the properties panel — there was no editor at all.
//          2. The Grand total column is reachable: fully on screen at desktop
//             width, and scrolled to (not cut off) when the pivot is wider than
//             its pane — it was clipped at the panel edge with no way to reach it.
//          3. A field DRAGGED from the list into Columns (real mouse) regroups.
//          4. A field PICKED into Values, its aggregate switched to Distinct,
//             computes a distinct count.
//          5. A Filters checklist excludes the lost deals; the totals follow and
//             are still money (£). ⌘Z takes the filter back.
//          6. The pivot TAB opens it (it used to offer "open it from ＋ Pivot"),
//             and the edited spec survives a save → reopen of the file.
//   CHART  7. With one Value cell selected, Chart charts Value — not Value,
//             Weighted and Computed.
//          8. The editor sets Line; over Region (no order) it is drawn as bars
//             with a "Draw a line anyway" note, which draws the line.
//          9. The value axis is labelled in £; a title typed in the editor heads
//             the chart; ⌘Z puts the old heading back.
//         10. Series added and coloured from the editor; clicking the grid
//             gives the panel back to the cell.
//   3D    11. The 3D button is hidden by default and shown by the dev flag.
//   FILTER 12. A money column's filter checklist lists £4,300, not 4300, and a
//             search for "4,300" finds it.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

// DASH_SHELL points the rig at another build — how its fails-on-old-code result
// was taken (an origin/main shell before this change).
const SHELL = process.env.DASH_SHELL
  ? pathToFileURL(process.env.DASH_SHELL).href
  : new URL('../dash/dist-single/Bento_Dash.bento.html', import.meta.url).href
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const tmp = mkdtempSync(join(tmpdir(), 'dash-pivotchart-'))

/** One area of the rig. A section that throws (an old build has no field
 *  editor to click) is a FAILURE, recorded, and the next section still runs —
 *  so a run against the old code lists every row it fails, not just the first. */
async function section(name, fn) {
  try { await fn() } catch (e) { ok(false, `${name}: the section could not run — ${String(e.message).split('\n')[0]}`) }
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const errors = []

async function open(url = SHELL, { width = 1440, height = 900, dev3d = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } })
  await ctx.route(/^https?:/, (r) => r.abort())
  if (dev3d) await ctx.addInitScript(() => { try { localStorage.setItem('bento-dash-dev-3d', 'on') } catch {} })
  const p = await ctx.newPage()
  p.setDefaultTimeout(5000)
  p.on('dialog', (d) => d.dismiss())
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(url)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.dg-cell'))
  await p.waitForTimeout(250)
  return p
}

const pivotSpec = (p) => p.evaluate(() => {
  const s = window.bento.doc.sheets.find((x) => x.kind === 'pivot')
  return s ? JSON.parse(JSON.stringify(s.pivot)) : null
})
const visible = (p, sel) => p.evaluate((sel) => {
  const el = document.querySelector(sel)
  if (!el) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'
}, sel)
/** the grand-total cell of the LAST value column, as text */
const grandCell = (p) => p.evaluate(() => {
  const tr = [...document.querySelectorAll('.dx-pivotview .dxp-r.dxp-grand')].pop()
  const tds = tr ? tr.querySelectorAll('td') : []
  return tds.length ? tds[tds.length - 1].textContent : null
})

try {
  await section('pivot', async () => {
    // ================================================================== PIVOT
    console.log('\npivot: opens as a sheet, with a field editor')
    const p = await open()
    await p.locator('[data-act="pivot"]').click()
    await p.waitForTimeout(300)
    ok(await visible(p, '.dx-pivotview') && !(await visible(p, '.dx-grid')),
      '＋ Pivot shows the pivot where the grid was, and hides the grid')
    ok(await p.locator('.dx-tab.active').innerText().then((s) => /pivot/i.test(s)),
      'its tab is the active one')
    ok(await p.locator('.dp-panel .dpf-well').count() === 4,
      'the properties panel is the field editor: Filters, Columns, Rows and Values')
    ok(await p.locator('.dp-panel .dpf-field').count() >= 7, 'with the source\'s columns listed as fields')

    console.log('\npivot: the Grand total column is reachable')
    const grandVisible = (pg) => pg.evaluate(() => {
      const scroll = document.querySelector('.dx-pivotview .dxp-scroll')
      const ths = [...document.querySelectorAll('.dx-pivotview thead th')]
      const g = ths.filter((th) => /Grand total/.test(th.textContent)).pop()
      if (!scroll || !g) return null
      const s = scroll.getBoundingClientRect()
      const r = g.getBoundingClientRect()
      return { inside: r.right <= s.right + 1 && r.left >= s.left - 1, sw: scroll.scrollWidth, cw: scroll.clientWidth }
    })
    const g1 = await grandVisible(p)
    ok(g1 && g1.inside, `at 1440px the Grand total header lies wholly inside the pivot pane (${JSON.stringify(g1)})`)

    console.log('\npivot: drag a field into Columns')
    const src = await p.locator('.dpf-field[data-col="stage"]').boundingBox()
    const dst = await p.locator('.dpf-well[data-area="cols"]').boundingBox()
    await p.mouse.move(src.x + 20, src.y + src.height / 2)
    await p.mouse.down()
    await p.mouse.move(src.x + 40, src.y + 40, { steps: 4 })
    await p.mouse.move(dst.x + dst.width / 2, dst.y + dst.height - 6, { steps: 8 })
    await p.mouse.up()
    await p.waitForTimeout(300)
    let spec = await pivotSpec(p)
    ok(spec.cols.includes('stage'), `Stage dragged with the mouse lands in Columns (cols: ${JSON.stringify(spec.cols)})`)
    ok(await p.locator('.dx-pivotview thead th', { hasText: /^Won$/ }).count() > 0, 'and the table regroups under Won / Open / Lost')
    ok(await p.locator('.dx-tab.active').innerText().then((s) => /pivot/i.test(s)),
      'the edit does not throw the reader off the pivot tab (a setSheet to a pivot read as "doomed" did)')

    console.log('\npivot: wider than its pane, the Grand total scrolls into reach')
    {
      const narrow = await p.context().newPage()
      await narrow.setViewportSize({ width: 900, height: 800 })
      narrow.on('pageerror', (e) => errors.push(e.message))
      await narrow.goto(SHELL)
      await narrow.waitForFunction(() => window.bento?.doc && document.querySelector('.dg-cell'))
      await narrow.locator('[data-act="pivot"]').click({ force: true }).catch(async () => {
        await narrow.locator('.dx-dd-trig[data-dd="insert"]').click(); await narrow.locator('[data-act="pivot"]').click()
      })
      await narrow.waitForTimeout(300)
      await narrow.locator('.dpf-well[data-area="cols"] .dpf-add').selectOption('stage')
      await narrow.waitForTimeout(300)
      const before = await grandVisible(narrow)
      ok(before && before.sw > before.cw, `the Owner × Stage pivot is wider than its pane at 900px (${before?.sw} > ${before?.cw})`)
      await narrow.evaluate(() => { const s = document.querySelector('.dx-pivotview .dxp-scroll'); s.scrollLeft = s.scrollWidth })
      const after = await grandVisible(narrow)
      ok(after && after.inside, 'and scrolling the pivot brings the whole Grand total column into view — it is scrolled to, not cut off')
      await narrow.close()
    }

    console.log('\npivot: pick a field into Values, count it distinct')
    await p.locator('.dpf-well[data-area="cols"] .dpf-chip[data-col="stage"] .dpf-x').click()
    await p.waitForTimeout(200)
    await p.locator('.dpf-well[data-area="cols"] .dpf-chip[data-col="owner"] .dpf-x').click()
    await p.waitForTimeout(200)
    await p.locator('.dpf-well[data-area="values"] .dpf-add').selectOption('owner')
    await p.waitForTimeout(200)
    spec = await pivotSpec(p)
    ok(spec.values.length === 2 && spec.values[1].col === 'owner' && spec.values[1].fn === 'count',
      `Owner picked into Values is COUNTED, not summed (${JSON.stringify(spec.values[1])})`)
    await p.locator('.dpf-well[data-area="values"] .dpf-chip').nth(1).locator('.dpf-agg').selectOption('countDistinct')
    await p.waitForTimeout(250)
    spec = await pivotSpec(p)
    ok(spec.values[1].fn === 'countDistinct', 'its aggregate switched to Distinct is stored')
    ok(await grandCell(p) === '3', `the grand Distinct Owner is 3 (Priya, Sam, Lee) — not the 8 rows (${await grandCell(p)})`)
    ok(await p.locator('.dx-pivotview .dxp-skipped').count() === 0,
      'and no cell of a count is marked "values are not numbers and were not counted" — a count of names counted every name')
    const sumGrand = await p.evaluate(() => {
      const tr = [...document.querySelectorAll('.dx-pivotview .dxp-r.dxp-grand')].pop()
      return tr.querySelectorAll('td')[0].textContent
    })
    ok(sumGrand === '£97,050', `Sum of Value keeps the column's money format (${sumGrand})`)

    console.log('\npivot: filter the lost deals out')
    await p.locator('.dpf-well[data-area="filters"] .dpf-add').selectOption('stage')
    await p.waitForTimeout(200)
    await p.locator('.dpf-chip[data-col="stage"] .dpf-filter-btn').click()
    await p.waitForTimeout(150)
    const labels = await p.locator('.dpf-chip[data-col="stage"] .dpf-check-item:not(.dpf-check-all)').allInnerTexts()
    ok(labels.join('|') === 'Lost|Open|Won', `the checklist lists the stages (${labels.join('|')})`)
    await p.locator('.dpf-chip[data-col="stage"] .dpf-check-item', { hasText: /^Lost$/ }).locator('input').click()
    await p.waitForTimeout(300)
    spec = await pivotSpec(p)
    ok(JSON.stringify(spec.filters?.[0]?.pred) === '{"op":"isOneOf","values":["Open","Won"]}',
      `the filter is stored as a JSON list (${JSON.stringify(spec.filters?.[0]?.pred)})`)
    ok(JSON.stringify(spec.rows) === '["region"]', 'and Region is still the rows')
    const filtered = await p.evaluate(() => {
      const tr = [...document.querySelectorAll('.dx-pivotview .dxp-r.dxp-grand')].pop()
      return tr ? tr.querySelectorAll('td')[0].textContent : null
    })
    ok(filtered === '£87,950', `without the lost deal the grand total is £87,950 = £97,050 − £9,100 (${filtered})`)
    const south = await p.evaluate(() => {
      const tr = [...document.querySelectorAll('.dx-pivotview .dxp-r.dxp-leaf')].find((r) => r.querySelector('th')?.textContent === 'South')
      return tr ? tr.querySelectorAll('td')[0].textContent : null
    })
    ok(south === '£26,500', `South loses exactly its £9,100 lost deal: £8,200 + £18,300 = £26,500 (${south})`)
    await p.locator('.dx-pivotview').click({ position: { x: 600, y: 400 } })
    await p.keyboard.press(`${MOD}+z`)
    await p.waitForTimeout(300)
    spec = await pivotSpec(p)
    ok(!spec.filters?.[0]?.pred, `⌘Z takes the filter back (${JSON.stringify(spec.filters)})`)
    // A printable key and Enter, with the pivot up: before the guard they went
    // to the HIDDEN grid's cursor (Region, row 1) and typed over "North".
    const table = () => p.evaluate(() => JSON.stringify(window.bento.doc.sheets.filter((x) => x.kind !== 'pivot')))
    const was = await table()
    await p.keyboard.press('q')
    await p.keyboard.press('Enter')
    await p.waitForTimeout(700)
    ok(await table() === was && !(await p.evaluate(() => document.activeElement?.isContentEditable || document.activeElement?.tagName === 'TEXTAREA')),
      'typing with the pivot up does not reach the hidden grid — the dataset is unchanged and no cell editor opened')
    await p.keyboard.press(`${MOD}+Shift+z`)
    await p.waitForTimeout(200)
    spec = await pivotSpec(p)
    ok(spec.filters?.[0]?.pred?.op === 'isOneOf', '⇧⌘Z puts it back')

    console.log('\npivot: the tab opens it, and the file keeps it')
    await p.locator('.dx-tab', { hasText: 'Pipeline' }).first().click()
    await p.waitForTimeout(250)
    ok(await visible(p, '.dx-grid') && !(await visible(p, '.dx-pivotview')), 'the Pipeline tab brings the grid back')
    ok(!(await p.locator('.dp-panel .dpf-well').count()), 'and the panel back to the cell')
    await p.locator('.dx-tab', { hasText: /pivot/i }).click()
    await p.waitForTimeout(250)
    ok(await visible(p, '.dx-pivotview') && await p.locator('.dx-pop, .dx-tab-menu').count() === 0,
      'clicking the pivot TAB opens the pivot — not a menu saying "open it from ＋ Pivot"')
    const file = join(tmp, 'saved.bento.html')
    writeFileSync(file, await p.evaluate(() => window.bento.serialize()))
    const q = await open(pathToFileURL(file).href)
    await q.locator('.dx-tab', { hasText: /pivot/i }).click()
    await q.waitForTimeout(300)
    const qs = await pivotSpec(q)
    ok(JSON.stringify(qs) === JSON.stringify(spec),
      `saved and reopened, the pivot has the fields it was given (${JSON.stringify(qs)})`)
    const reopened = await q.evaluate(() => {
      const tr = [...document.querySelectorAll('.dx-pivotview .dxp-r.dxp-grand')].pop()
      return tr ? tr.querySelectorAll('td')[0].textContent : null
    })
    ok(reopened === '£87,950', `and computes the same filtered total from the file (${reopened})`)
    await q.context().close()
    await p.context().close()
  })

  await section('chart', async () => {
    // ================================================================== CHART
    console.log('\nchart: from the selection')
    const c = await open()
    await c.locator('.dg-cell', { hasText: /^£12,400$/ }).first().click()
    await c.waitForTimeout(100)
    await c.locator('[data-act="chart"]').click()
    await c.waitForTimeout(400)
    let chart = await c.evaluate(() => window.bento.doc.chart)
    ok(JSON.stringify(chart?.binding?.series) === '["value"]',
      `one Value cell selected → the chart is of Value alone (${JSON.stringify(chart?.binding?.series)})`)
    ok(await c.locator('.dp-panel .dce-type').count() === 1, 'and the properties panel is its editor')
    const yLabels = await c.evaluate(() => [...document.querySelectorAll('.dx-chart-body svg text')].map((t) => t.textContent))
    ok(yLabels.some((s) => /^£\d/.test(s)), `the value axis is in £ (${yLabels.filter((s) => /\d/.test(s)).slice(0, 3).join(', ')})`)

    console.log('\nchart: a line through Region is refused, unless asked')
    // Bars are rects painted in the series colour; a line is a stroked path with
    // a dot per category. (charts-lite also lays transparent hit bands over each
    // category, so "any rect" counts the wrong thing.)
    const shapes = () => c.evaluate(() => {
      const svg = document.querySelector('.dx-chart-body svg')
      const series = '#f7a600'
      return {
        bars: [...svg.querySelectorAll('rect')].filter((r) => (r.getAttribute('fill') || '').toLowerCase() === series).length,
        lines: [...svg.querySelectorAll('path')].filter((x) => x.getAttribute('fill') === 'none' && (x.getAttribute('stroke') || '').toLowerCase() === series).length,
        note: [...document.querySelectorAll('.dx-chart-note')].map((n) => n.textContent).join(' '),
      }
    })
    await c.locator('.dce-type').selectOption('line')
    await c.waitForTimeout(300)
    chart = await c.evaluate(() => window.bento.doc.chart)
    let sh = await shapes()
    ok(chart.binding.kind === 'line' && sh.bars === 3 && sh.lines === 0 && /Draw a line anyway/.test(sh.note),
      `Line chosen over Region → drawn as 3 bars and no line, with the reason and the offer (${sh.bars} bars, ${sh.lines} lines; "${sh.note.slice(0, 60)}…")`)
    await c.locator('.dx-chart-note button', { hasText: 'Draw a line anyway' }).click()
    await c.waitForTimeout(300)
    chart = await c.evaluate(() => window.bento.doc.chart)
    sh = await shapes()
    ok(chart.binding.allowLine === true && sh.bars === 0 && sh.lines === 1 && !/Draw a line anyway/.test(sh.note),
      `asked, the line is drawn (${sh.lines} line, ${sh.bars} bars, allowLine ${chart.binding.allowLine})`)
    await c.locator('.dce-type').selectOption('bar')
    await c.waitForTimeout(200)

    console.log('\nchart: title, undo, series, colour')
    const head = () => c.locator('.dx-chart-title').innerText()
    const before = await head()
    await c.locator('.dce-title').fill('Deals by region')
    await c.locator('.dce-title').press('Enter')
    await c.waitForTimeout(250)
    ok(await head() === 'Deals by region', `a typed title heads the chart (${await head()})`)
    await c.locator('.dx-chart-body').click({ position: { x: 20, y: 20 } })
    await c.keyboard.press(`${MOD}+z`)
    await c.waitForTimeout(300)
    ok(await head() === before && !(await c.evaluate(() => window.bento.doc.chart.binding.title)),
      `⌘Z puts the old heading back on screen AND in the file (${await head()})`)
    await c.locator('.dce-add').selectOption('weighted')
    await c.waitForTimeout(250)
    chart = await c.evaluate(() => window.bento.doc.chart)
    ok(JSON.stringify(chart.binding.series) === '["value","weighted"]', 'Weighted added from the editor')
    ok(await c.locator('.dce-series').count() === 2, 'and listed as a second series')
    await c.locator('.dce-series[data-col="weighted"] .dce-colour').evaluate((el) => {
      el.value = '#112233'; el.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await c.waitForTimeout(250)
    chart = await c.evaluate(() => window.bento.doc.chart)
    const fills = await c.evaluate(() => [...document.querySelectorAll('.dx-chart-body svg rect')].map((r) => (r.getAttribute('fill') || '').toLowerCase()))
    ok(chart.binding.colors?.weighted === '#112233' && fills.includes('#112233'),
      `its colour is stored and painted (${chart.binding.colors?.weighted})`)
    await c.locator('.dg-cell', { hasText: /^North$/ }).first().click()
    await c.waitForTimeout(250)
    ok(!(await c.locator('.dp-panel .dce-type').count()) && await c.locator('.dp-panel .dp-section', { hasText: /^Cell$/i }).count() > 0,
      'clicking back into the grid gives the panel back to the cell')
    await c.context().close()
  })

  await section('3D', async () => {
    // ===================================================================== 3D
    console.log('\n3D: behind a developer flag')
    const d0 = await open()
    ok(!(await visible(d0, '[data-act="viz3d"]')), 'the 3D button is hidden by default')
    await d0.context().close()
    const d1 = await open(SHELL, { dev3d: true })
    ok(await visible(d1, '[data-act="viz3d"]'), 'and shown with localStorage bento-dash-dev-3d = "on"')
    await d1.context().close()
  })

  await section('filter', async () => {
    // ================================================================= FILTER
    console.log('\nfilter: the checklist shows values as the column does')
    const f = await open()
    const valueCaret = f.locator('.dg-head-row .dg-filter').nth(3)
    await valueCaret.click()
    await f.waitForTimeout(250)
    const items = await f.locator('.dfx-item:not(.dfx-all)').allInnerTexts()
    ok(items.includes('£4,300') && !items.includes('4300'), `the Value checklist lists £4,300, not 4300 (${items.slice(0, 3).join(', ')})`)
    await f.locator('.dfx-q').fill('4,300')
    await f.waitForTimeout(400)
    const found = await f.locator('.dfx-item:not(.dfx-all)').allInnerTexts()
    ok(found.length === 1 && found[0] === '£4,300', `searching "4,300" — what the reader sees — finds it (${found.join(', ')})`)
    await f.context().close()
  })

  ok(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await browser.close()
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
