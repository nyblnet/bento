// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Typing into a SPREADSHEET cell in the built shell: what the cells show, what
// the formulas over them compute, what the formula bar says, and what happens
// to a formula that does not parse.
//
//   npm run build:single --prefix dash && node scripts/test-dash-entryparse-browser.mjs
//
// The review's exact keystrokes (finding 3.1): on the Scratch sheet, G13..G19
// receive 10, $5, 15%, =SUM(G13:G15), =G13+G14, =COUNT(G13:G15), =G13*G15.
// Before the fix the grid showed 30, 15, 3 and 150 — "15%" was stored as text
// and the engine read the text as 15. Now 15.15, 15, 3 and 1.5. Then 2.8 (the
// bar over 15% says 15%, over a date says the date) and 3.4 (=A11+ is refused
// in the cell AND in the formula bar, with the reason visible; Esc cancels).
//
// node scripts/test-dash-entryparse.ts holds the full table; this row proves
// the real editor, keyboard and paint reach it.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

const SHELL = new URL('../dash/dist-single/Bento_Dash.bento.html', import.meta.url).href
const SHOTS = process.env.SHOT_DIR

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(SHELL)
  await page.waitForFunction(() => window.bento?.doc && document.querySelector('.dg-cell'))
  const cellAt = (row, col) => page.locator(`.dg-row[data-row="${row}"] .dg-cell:not(.dg-gutter)`).nth(col)

  // ---- the review's 2.8 shot, exactly: Pipeline F1, a Percent column showing 100%
  await page.locator('.dx-tab', { hasText: 'Pipeline' }).click()
  await page.waitForTimeout(200)
  await page.locator('.dg-cell[data-col]').filter({ hasText: '100%' }).first().click()
  ok(await page.locator('.dx-fx-input').inputValue() === '100%',
    `the formula bar over Pipeline's Probability 100% reads "100%", not "1" (got "${await page.locator('.dx-fx-input').inputValue()}")`)

  await page.locator('.dx-tab', { hasText: 'Scratch' }).click()
  await page.waitForTimeout(300)
  const textAt = (row, col) => cellAt(row, col).evaluate((el) => el.textContent.trim())
  const stored = (key) => page.evaluate((k) => {
    const s = window.bento.doc.sheets.find((x) => x.name === 'Scratch')
    return s.cells[k] ?? null
  }, key)

  // ---- the review's keystrokes, G13 down
  await cellAt(12, 6).click()
  for (const t of ['10', '$5', '15%', '=SUM(G13:G15)', '=G13+G14', '=COUNT(G13:G15)', '=G13*G15']) {
    await page.keyboard.type(t)
    await page.keyboard.press('Enter')
  }
  await page.waitForTimeout(300)
  const shown = []
  for (let r = 12; r < 19; r++) shown.push(await textAt(r, 6))
  console.log(`  G13..G19 read: ${shown.join(' | ')}`)
  ok(shown[1] === '$5' && shown[2] === '15%', `$5 and 15% display as typed ("${shown[1]}", "${shown[2]}")`)
  ok(JSON.stringify(await stored('G15')) === JSON.stringify({ v: 0.15, format: '0%' }),
    `15% is STORED as 0.15 with a percent format (${JSON.stringify(await stored('G15'))})`)
  ok(JSON.stringify(await stored('G14')) === JSON.stringify({ v: 5, format: '$#,##0' }),
    `$5 is stored as 5 with a currency format that keeps the $ (${JSON.stringify(await stored('G14'))})`)
  ok(shown[3] === '15.15', `=SUM(G13:G15) shows 15.15 — the review measured 30 (got "${shown[3]}")`)
  ok(shown[4] === '15', `=G13+G14 shows 15 (got "${shown[4]}")`)
  ok(shown[5] === '3', `=COUNT(G13:G15) shows 3 (got "${shown[5]}")`)
  ok(/^1\.50?$/.test(shown[6]), `=G13*G15 shows 1.5 — the review measured 150 (got "${shown[6]}")`)

  // ---- dates
  await cellAt(12, 7).click()
  for (const t of ['2026-03-04', 'Mar 4 2026', '3/4/2026']) {
    await page.keyboard.type(t)
    await page.keyboard.press('Enter')
  }
  await page.waitForTimeout(200)
  ok((await stored('H13'))?.v === '2026-03-04' && (await stored('H13'))?.format === 'yyyy-mm-dd',
    `ISO 2026-03-04 is a date (${JSON.stringify(await stored('H13'))})`)
  ok((await stored('H14'))?.v === '2026-03-04' && (await stored('H14'))?.format === 'yyyy-mm-dd',
    `"Mar 4 2026" is the same date (${JSON.stringify(await stored('H14'))})`)
  ok(JSON.stringify(await stored('H15')) === JSON.stringify({ v: '3/4/2026' }),
    `"3/4/2026" is still refused as a date and kept as text (${JSON.stringify(await stored('H15'))})`)

  // ---- the formula bar shows the ENTERED form (2.8)
  const fx = page.locator('.dx-fx-input')
  // the review's own case: a value STORED as a number and THEN formatted as a
  // percent from the panel — the bar said 1 for a cell reading 100%
  await cellAt(12, 8).click()
  await page.keyboard.type('1')
  await page.keyboard.press('Enter')
  await cellAt(12, 8).click()
  const fmtSelect = page.locator('.dp-panel select').filter({ has: page.locator('option[value="percent"]') }).first()
  await fmtSelect.selectOption('percent')
  await page.waitForTimeout(150)
  ok(await textAt(12, 8) === '100%' && (await stored('I13'))?.v === 1,
    `the cell holds 1 and reads 100% (${await textAt(12, 8)}, ${JSON.stringify(await stored('I13'))})`)
  await cellAt(13, 8).click()
  await cellAt(12, 8).click()
  ok(await fx.inputValue() === '100%', `the formula bar over it reads "100%", not 1 (got "${await fx.inputValue()}")`)
  await cellAt(14, 6).click()
  ok(await fx.inputValue() === '15%', `the formula bar over G15 reads "15%", not 0.15 (got "${await fx.inputValue()}")`)
  await cellAt(13, 6).click()
  ok(await fx.inputValue() === '$5', `…over G14 reads "$5" (got "${await fx.inputValue()}")`)
  await cellAt(13, 7).click()
  ok(await fx.inputValue() === '2026-03-04', `…over H14 reads the date "2026-03-04" (got "${await fx.inputValue()}")`)

  // ---- a malformed formula in the CELL (3.4)
  await cellAt(19, 6).click()
  await page.keyboard.type('=A11+')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
  const editing = page.locator('.dg-cell.dg-editing')
  ok(await editing.count() === 1 && (await editing.textContent()) === '=A11+',
    'Enter on =A11+ leaves the editor OPEN with the text in it')
  ok(await stored('G20') === null, 'and commits nothing')
  const tip = page.locator('.dg-refuse-tip')
  const tipBox = (await tip.count()) ? await tip.boundingBox() : null
  ok(tipBox && await tip.isVisible() && tipBox.y > 0 && tipBox.y + tipBox.height < 900,
    `the reason is visible under the cell: "${tipBox ? await tip.textContent() : 'NO MESSAGE'}"`)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/entryparse-refused.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)
  ok(await editing.count() === 0 && await tip.count() === 0 && await stored('G20') === null,
    'Escape cancels: editor closed, message gone, nothing written')

  // ---- …and in the formula bar
  await cellAt(19, 6).click()
  await fx.click()
  await fx.fill('=SUM(')
  await fx.press('Enter')
  await page.waitForTimeout(100)
  ok(await stored('G20') === null && await page.locator('.dx-fx-tip').isVisible(),
    'the formula bar refuses =SUM( too, with the reason shown')
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/entryparse-fx-refused.png` })
  await fx.press('Escape')
  ok(await page.locator('.dx-fx-tip').count() === 0 && await fx.inputValue() === '',
    'Escape in the bar puts the cell\'s own contents back')
  await cellAt(19, 6).click()
  await fx.click()
  await fx.fill('=SUM(G13:G15)')
  await fx.press('Enter')
  await page.waitForTimeout(150)
  ok((await stored('G20'))?.f === '=SUM(G13:G15)' && await textAt(19, 6) === '15.15',
    'a formula that parses lands from the bar as before')
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/entryparse-after.png` })

  ok(errors.length === 0, `no page errors (${errors.join(' | ') || 'none'})`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
