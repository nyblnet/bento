// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The properties panel shows what applies to the selection, and nothing else.
//
//   npm run build:single --prefix dash && node scripts/test-dash-panel-context-browser.mjs
//
// Measured in the packaged document (headless Chromium), on both kinds of sheet:
//   1. PER COLUMN TYPE on a dataset — Text, Number, Money, Percent, Date,
//      Yes/No, Category, and a computed Money column — the Number format
//      control appears for the three number types only; no column shows a
//      number pattern, a money placeholder or another column's formula as a
//      placeholder; Total appears for the number types only; Formula appears for
//      the computed column only.
//   2. ONE number-format control. A spreadsheet cell shows a single "Number
//      format" select — no Pattern field (until Custom… is chosen, which reveals
//      it), no "Shows as" box, no "Format" row — and a dataset cell shows the
//      same control with an "Apply to" scope: "These cells" writes the cell's
//      override and leaves the column's pattern alone. Custom… → a typed pattern
//      lands in the file; the Time preset reads `2:30 pm` as `14:30`.
//   3. AN UNSET COLOUR WELL READS UNSET, light and dark — measured from pixels,
//      not from a style read back: the well paints the field's own fill, not the
//      grey/cream fallback. Positive control: a well whose cell HAS a colour
//      paints that colour, so the sampler is awake.
//   4. Checkboxes are bare boxes (≤ 18px), not full-width bordered fields.
//   5. A formula column made from Money (`Value * 2`, through the toolbar's own
//      dialog) is Money with the source's £ format, and one column never mixes
//      grouped and ungrouped numbers (`8600` beside `24,800`).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const SHELL = new URL('../dash/dist-single/Bento_Dash.bento.html', import.meta.url).href
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })

async function openPage(scheme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: scheme, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(SHELL)
  await page.waitForFunction(() => window.bento && window.bento.doc, null, { timeout: 20000 })
  // The fixture: the starter workbook plus the column types it lacks.
  await page.evaluate(() => {
    const doc = JSON.parse(JSON.stringify(window.bento.doc))
    const sh = doc.sheets[0]
    sh.columns.push(
      { id: 'qty', name: 'Qty', type: 'number', w: 90 },
      { id: 'done', name: 'Done', type: 'bool', w: 80 },
      { id: 'tier', name: 'Tier', type: 'enum', w: 90 },
    )
    sh.data.qty = { enc: 'raw', v: [8600, 24800, 3, 12, 5, 7, 9, 11] }
    sh.data.done = { enc: 'raw', v: [true, false, true, false, true, false, true, false] }
    sh.data.tier = { enc: 'dict', dict: ['A', 'B'], idx: [0, 1, 0, 1, 0, 1, 0, 1] }
    doc.sheets[1].cells.D30 = { v: '2:30 pm' }
    window.bento.loadDoc(JSON.stringify(doc))
  })
  await page.waitForTimeout(300)
  return { ctx, page, errors }
}

const cellAt = (page, row, col) =>
  page.locator(`.dg-row[data-row="${row}"] .dg-cell:not(.dg-gutter)`).nth(col)

async function select(page, row, col) {
  await cellAt(page, row, col).click()
  await page.waitForTimeout(120)
}

/** The visible panel rows, with their section — read by LABEL, which both the old and new panels have. */
const panelRows = (page) => page.evaluate(() => {
  const out = []
  let sec = ''
  for (const el of document.querySelectorAll('.dp-right .dp-section, .dp-right .dp-row')) {
    if (!el.offsetParent) continue
    if (el.classList.contains('dp-section')) { sec = el.textContent.trim(); continue }
    const label = el.firstElementChild?.textContent.trim() ?? ''
    const ctl = el.querySelector('input, select')
    out.push({
      sec, label,
      tag: ctl ? (ctl.tagName === 'SELECT' ? 'select' : ctl.type) : 'text',
      value: ctl ? ctl.value : el.textContent.trim(),
      placeholder: ctl?.placeholder ?? '',
    })
  }
  return out
})
const has = (rows, label) => rows.some((r) => r.label === label)
const count = (rows, label) => rows.filter((r) => r.label === label).length

async function chooseIn(page, label, value) {
  const sel = page.locator('.dp-right .dp-row').filter({ has: page.locator(`span:text-is("${label}")`) }).locator('select').first()
  await sel.selectOption(value)
  await page.waitForTimeout(150)
}

// ============================================================ 1 · per column type
console.log('\n1 · a dataset column shows only the fields its type uses')
{
  const { ctx, page, errors } = await openPage('light')
  const cols = await page.evaluate(() => window.bento.doc.sheets[0].columns.map((c) => ({ name: c.name, type: c.type, formula: !!c.formula })))
  const NUMERIC = new Set(['number', 'money', 'percent'])
  let sawNumeric = 0
  let sawPlain = 0
  for (let ci = 0; ci < cols.length; ci++) {
    const c = cols[ci]
    await select(page, 1, ci)
    const rows = await panelRows(page)
    const what = `${c.name} (${c.type}${c.formula ? ', computed' : ''})`
    const numeric = NUMERIC.has(c.type)
    if (numeric) sawNumeric++; else sawPlain++
    ok(numeric ? count(rows, 'Number format') === 1 : !has(rows, 'Number format'),
      `${what}: Number format ${numeric ? 'shown once' : 'absent'}`)
    ok(!has(rows, 'Format') && !has(rows, 'Shows as') && !has(rows, 'Pattern'),
      `${what}: no separate Format / Pattern / Shows as control`)
    const bad = rows.filter((r) => /£|#,##0|\*/.test(r.placeholder))
    ok(bad.length === 0,
      `${what}: no field shows a money, pattern or formula placeholder${bad.length ? ' — ' + bad.map((r) => `${r.label} "${r.placeholder}"`).join(', ') : ''}`)
    ok(numeric ? has(rows, 'Total') : !has(rows, 'Total'), `${what}: Total ${numeric ? 'shown' : 'absent'}`)
    ok(c.formula ? has(rows, 'Formula') : !has(rows, 'Formula'), `${what}: Formula ${c.formula ? 'shown' : 'absent'}`)
    await page.locator('.dp-right').screenshot({ path: `${process.env.SHOT_DIR || '/tmp'}/panel-ctx-${ci}-${c.type}.png` }).catch(() => {})
  }
  ok(sawNumeric >= 4 && sawPlain >= 5, `the fixture covered every type (${sawNumeric} number-typed, ${sawPlain} other)`)
  ok(errors.length === 0, `no page errors${errors.length ? ' — ' + errors.join('; ') : ''}`)
  await ctx.close()
}

// ============================================================ 2 · one format control
console.log('\n2 · one number-format control, on both kinds of sheet')
{
  const { ctx, page, errors } = await openPage('light')
  // --- dataset: the scope switch writes the cell override, not the column
  const valueCol = await page.evaluate(() => window.bento.doc.sheets[0].columns.findIndex((c) => c.id === 'value'))
  await select(page, 1, valueCol)
  let rows = await panelRows(page)
  ok(has(rows, 'Apply to'), 'a dataset cell offers Apply to (this column / these cells)')
  let wrote = false
  try {
    await chooseIn(page, 'Apply to', 'cells')
    await chooseIn(page, 'Number format', 'percent')
    wrote = true
  } catch { /* old panel: no such control */ }
  const after = await page.evaluate(() => {
    const sh = window.bento.doc.sheets[0]
    const over = Object.entries(sh.cells ?? {}).find(([k]) => k.startsWith('value:'))
    return { over: over?.[1]?.format, col: sh.columns.find((c) => c.id === 'value').format }
  })
  ok(wrote && /%$/.test(after.over ?? '') && after.col === '£#,##0',
    `"These cells" + Percent writes the cell override (${after.over}) and leaves the column at £#,##0 (${after.col})`)

  // --- spreadsheet
  await page.locator('[role=tab]').filter({ hasText: 'Scratch' }).first().click()
  await page.waitForTimeout(300)
  await select(page, 8, 1)                     // B9 — 100000, £#,##0
  rows = await panelRows(page)
  ok(count(rows, 'Number format') === 1, 'a spreadsheet cell shows ONE Number format select')
  ok(!has(rows, 'Format') && !has(rows, 'Shows as') && !has(rows, 'Pattern'),
    'and no Format row, no Shows as box, no Pattern field beside it')
  const sample = await page.locator('.dp-right .dc-sample').first().textContent().catch(() => null)
  ok(sample === '£100,000', `a live sample prints the cell with its format (${sample})`)

  let custom = false
  try {
    await chooseIn(page, 'Number format', 'custom')
    custom = true
  } catch { /* old panel offered Custom only for a pattern no preset spells */ }
  rows = await panelRows(page)
  ok(custom && has(rows, 'Pattern'), 'choosing Custom… reveals the Pattern field')
  const focused = await page.evaluate(() => document.activeElement?.closest('.dp-row')?.firstElementChild?.textContent)
  ok(focused === 'Pattern', 'and puts the cursor in it')
  if (custom) {
    await page.keyboard.type('0.0 "kg"')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
  }
  const fmt = await page.evaluate(() => window.bento.doc.sheets[1].cells.B9?.format)
  ok(fmt === '0.0 "kg"', `the typed pattern lands in the file (${fmt})`)
  rows = await panelRows(page)
  ok(rows.find((r) => r.label === 'Number format')?.value === 'custom' && has(rows, 'Pattern'),
    'a pattern no preset spells reopens on Custom…, with its field')
  await chooseIn(page, 'Number format', 'number').catch(() => {})
  rows = await panelRows(page)
  ok(!has(rows, 'Pattern') && has(rows, 'Decimals'), 'a preset hides the Pattern field again and shows its own options')

  // --- Time
  await select(page, 29, 3)                    // D30 — "2:30 pm"
  let timed = false
  try { await chooseIn(page, 'Number format', 'time'); timed = true } catch { /* no Time preset */ }
  const d30 = await page.evaluate(() => window.bento.doc.sheets[1].cells.D30)
  ok(timed && d30?.v === '14:30' && d30?.format === 'hh:mm', `Time reads "2:30 pm" as 14:30 (${JSON.stringify(d30)})`)
  ok(errors.length === 0, `no page errors${errors.length ? ' — ' + errors.join('; ') : ''}`)
  await ctx.close()
}

// ============================================================ 3 + 4 · wells and checkboxes
/** The colour a well PAINTS, off its diagonal, read from a screenshot. */
async function wellPixel(page, label) {
  const well = page.locator('.dp-right .dp-row').filter({ has: page.locator(`span:text-is("${label}")`) }).locator('input[type=color]').first()
  const box = await well.boundingBox()
  if (!box) return null
  // Below the bottom-left → top-right strike, away from the border.
  const x = Math.round(box.x + box.width * 0.78)
  const y = Math.round(box.y + box.height * 0.62)
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } })
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = c.height = 1
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)]
  }, png.toString('base64'))
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const near = (a, b, tol = 10) => !!a && a.every((v, i) => Math.abs(v - b[i]) <= tol)

for (const scheme of ['light', 'dark']) {
  console.log(`\n3 · an unset colour well reads unset (${scheme})`)
  const { ctx, page } = await openPage(scheme)
  const field = await page.evaluate(() => {
    const p = document.createElement('div')
    p.style.color = getComputedStyle(document.documentElement).getPropertyValue('--field')
    document.body.appendChild(p)
    const m = getComputedStyle(p).color.match(/\d+/g).slice(0, 3).map(Number)
    p.remove()
    return m
  })
  await select(page, 1, 0)                     // Region 2 — nothing set
  for (const [label, fallback] of [['Text colour', '#1e2a3a'], ['Background', '#fff3cd']]) {
    const px = await wellPixel(page, label)
    // (The fallback is only a separate test where it differs from the field —
    // in dark the ink fallback and the field are both near-black.)
    ok(near(px, field) && (near(field, hex(fallback), 30) || !near(px, hex(fallback), 30)),
      `${label} with nothing set paints the field's own fill (${px}), not the ${fallback} fallback`)
  }

  // POSITIVE CONTROL: a well whose cell has colours paints them.
  await page.locator('[role=tab]').filter({ hasText: 'Scratch' }).first().click()
  await page.waitForTimeout(300)
  await select(page, 9, 1)                     // B10 — bg #FFF4D6
  const bg = await wellPixel(page, 'Background')
  ok(near(bg, hex('#fff4d6')), `a SET background paints its colour (${bg}) — the sampler is awake`)
  await select(page, 0, 3)                     // D1 — colour #5B6B80
  const ink = await wellPixel(page, 'Text colour')
  ok(near(ink, hex('#5b6b80')), `a SET text colour paints its colour (${ink})`)

  console.log(`\n4 · checkboxes are bare (${scheme})`)
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.dp-right input[type=checkbox]')]
    .filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }))
  ok(boxes.length >= 4, `the panel shows checkboxes to measure (${boxes.length})`)
  ok(boxes.every(([w, h]) => w <= 18 && h <= 18),
    `every checkbox is a bare box, not a full-width field (${[...new Set(boxes.map((b) => b.join('×')))].join(', ')})`)
  await ctx.close()
}

// ============================================================ 5 · money carries, grouping is per column
console.log('\n5 · a formula over Money is Money; a column never mixes grouping')
{
  const { ctx, page, errors } = await openPage('light')
  const colText = (ci) => page.evaluate((ci) => [...document.querySelectorAll('.dg-row')]
    .filter((r) => r.dataset.rid && r.querySelector('.dg-cell:not(.dg-gutter)'))
    .map((r) => r.querySelectorAll('.dg-cell:not(.dg-gutter)')[ci]?.textContent.trim() ?? '')
    .filter(Boolean), ci)
  const mixed = (vals) => {
    const big = vals.filter((v) => /\d{4,}|\d,\d{3}/.test(v))
    return big.some((v) => v.includes(',')) && big.some((v) => /\d{4}/.test(v.replace(/[^\d,]/g, '')))
  }
  const qtyCol = await page.evaluate(() => window.bento.doc.sheets[0].columns.findIndex((c) => c.id === 'qty'))
  const qty = await colText(qtyCol)
  ok(qty.includes('8600') || qty.includes('8,600'), `the Qty column painted (${qty.slice(0, 3).join(' / ')})`)
  ok(!mixed(qty), `a plain Number column groups all its values or none (${qty.slice(0, 2).join(' / ')})`)

  await page.locator('[data-act=formula]').click()
  await page.waitForSelector('.dx-ask')
  const ins = page.locator('.dx-ask .dx-ask-in')
  await ins.nth(0).fill('Value * 2')
  await ins.nth(1).fill('Double')
  await page.locator('.dx-ask-go').click()
  await page.waitForTimeout(300)
  const col = await page.evaluate(() => window.bento.doc.sheets[0].columns.find((c) => c.name === 'Double'))
  ok(col?.type === 'money' && col?.format === '£#,##0',
    `\`Value * 2\` over a £ column is a Money column with its format (${col?.type}, ${col?.format})`)
  const dblCol = await page.evaluate(() => window.bento.doc.sheets[0].columns.findIndex((c) => c.name === 'Double'))
  const dbl = await colText(dblCol)
  ok(dbl.length >= 8 && dbl.every((v) => v.startsWith('£')), `every value prints in £ (${dbl.slice(0, 2).join(' / ')})`)
  ok(!mixed(dbl), 'and the column never prints 8600 beside 24,800')
  ok(errors.length === 0, `no page errors${errors.length ? ' — ' + errors.join('; ') : ''}`)
  await ctx.close()
}

await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
