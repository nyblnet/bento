// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Dates and times in a SPREADSHEET cell of the built shell, with the real
// keyboard, paste, format panel and paint.
//
//   npm run build:single --prefix dash && node scripts/test-dash-dates-browser.mjs
//
// node scripts/test-dash-dates.ts holds the full table; this proves the real
// editor reaches it. The audit's own keystrokes: `2026-03-04` then `=A4+1`,
// `=TEXT(A4,"dd mmm yyyy")` and `=DATE(2026,3,4)+1` were all #VALUE!, and
// `=NOW()` painted `2026-11-07T11:57:37.957Z`. The page runs in New York time
// so NOW() has to be converted to show what the rig expects.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

const SHELL = new URL('../dash/dist-single/Bento_Dash.bento.html', import.meta.url).href
const SHOTS = process.env.SHOT_DIR

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 }, locale: 'en-GB', timezoneId: 'America/New_York',
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(SHELL)
  await page.waitForFunction(() => window.bento?.doc && document.querySelector('.dg-cell'))
  await page.locator('.dx-tab', { hasText: 'Scratch' }).click()
  await page.waitForTimeout(300)
  const cellAt = (row, col) => page.locator(`.dg-row[data-row="${row}"] .dg-cell:not(.dg-gutter)`).nth(col)
  const textAt = (row, col) => cellAt(row, col).evaluate((el) => el.textContent.trim())
  const stored = (key) => page.evaluate((k) => {
    const s = window.bento.doc.sheets.find((x) => x.name === 'Scratch')
    return s.cells[k] ?? null
  }, key)
  const typeDown = async (row, col, list) => {
    await cellAt(row, col).click()
    for (const t of list) { await page.keyboard.type(t); await page.keyboard.press('Enter') }
    await page.waitForTimeout(250)
  }

  // ---- entry, column F from row 13
  await typeDown(12, 5, ['2026-03-04', '2026-03-31', '2026-03-04 22:30', '9:05', '2:30 PM', '3/4/2026'])
  ok(JSON.stringify(await stored('F13')) === JSON.stringify({ v: '2026-03-04', format: 'yyyy-mm-dd' }),
    `2026-03-04 is a date (${JSON.stringify(await stored('F13'))})`)
  ok(JSON.stringify(await stored('F15')) === JSON.stringify({ v: '2026-03-04 22:30', format: 'yyyy-mm-dd hh:mm' }),
    `2026-03-04 22:30 is a date and time (${JSON.stringify(await stored('F15'))})`)
  ok(JSON.stringify(await stored('F16')) === JSON.stringify({ v: '09:05', format: 'hh:mm' }),
    `9:05 is a time (${JSON.stringify(await stored('F16'))})`)
  ok(JSON.stringify(await stored('F17')) === JSON.stringify({ v: '14:30', format: 'hh:mm' }),
    `2:30 PM is 14:30 (${JSON.stringify(await stored('F17'))})`)
  ok(JSON.stringify(await stored('F18')) === JSON.stringify({ v: '3/4/2026' }),
    `3/4/2026 is still refused and kept as text (${JSON.stringify(await stored('F18'))})`)
  ok(await textAt(14, 5) === '2026-03-04 22:30' && await textAt(15, 5) === '09:05',
    `they paint as typed, canonical (${await textAt(14, 5)}, ${await textAt(15, 5)})`)

  // ---- a paste goes through the same reader
  await cellAt(12, 8).click()
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.setData('text/plain', 'Mar 4 2026\t14:30\n2026-03-04T09:05\t3/4/2026')
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    ;(document.activeElement ?? document).dispatchEvent(ev)
  })
  await page.waitForTimeout(250)
  ok(JSON.stringify(await stored('I13')) === JSON.stringify({ v: '2026-03-04', format: 'yyyy-mm-dd' }) &&
    JSON.stringify(await stored('J13')) === JSON.stringify({ v: '14:30', format: 'hh:mm' }) &&
    JSON.stringify(await stored('I14')) === JSON.stringify({ v: '2026-03-04 09:05', format: 'yyyy-mm-dd hh:mm' }) &&
    JSON.stringify(await stored('J14')) === JSON.stringify({ v: '3/4/2026' }),
  `a pasted block stores the same values typing does (${JSON.stringify([await stored('I13'), await stored('J13'), await stored('I14'), await stored('J14')])})`)

  // ---- formulas over them, column G
  const f = [
    ['=F13+1', '2026-03-05'],
    ['=F14-F13', '27'],
    ['=DATE(2026,3,4)+1', '2026-03-05'],
    ['=TEXT(F13,"dd mmm yyyy")', '04 Mar 2026'],
    ['=TEXT(F15,"h:mm AM/PM")', '10:30 PM'],
    ['=(F17-F16)*24*60', '325'],
    ['=WEEKDAY(F13)', '4'],
    ['=EOMONTH(F13,0)', '2026-03-31'],
    ['=EDATE("2026-01-31",1)', '2026-02-28'],
    ['=DATEDIF(F13,F14,"D")', '27'],
    ['=NETWORKDAYS(F13,F14)', '20'],
    ['=MAX(F13:F14)', '2026-03-31'],
  ]
  await typeDown(12, 6, f.map(([x]) => x))
  for (let i = 0; i < f.length; i++) {
    const got = await textAt(12 + i, 6)
    ok(got === f[i][1], `${f[i][0]} paints ${f[i][1]} (got "${got}")`)
  }

  // ---- NOW() and TODAY(): the document's frozen instant on New York's clock
  await typeDown(25, 6, ['=NOW()', '=TODAY()'])
  const modified = await page.evaluate(() => window.bento.doc.modified)
  const local = await page.evaluate((iso) => {
    const d = new Date(iso)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }, modified)
  const now = await textAt(25, 6)
  const today = await textAt(26, 6)
  ok(!/[TZ]/.test(now) && now.startsWith(local),
    `NOW() paints the local wall clock "${now}" for instant ${modified} (expected ${local}…), never the raw UTC string`)
  ok(today === local.slice(0, 10), `TODAY() paints the local date ${today}`)

  // ---- the format panel: Date and time, and a pattern of the author's own
  await cellAt(12, 5).click()
  const fmtSelect = page.locator('.dp-panel select').filter({ has: page.locator('option[value="datetime"]') }).first()
  ok(await fmtSelect.count() === 1, 'the cell panel offers a Date and time format')
  const label = await fmtSelect.locator('option[value="datetime"]').textContent()
  ok(label === 'Date and time', `labelled "Date and time" (got "${label}")`)
  await fmtSelect.selectOption('datetime')
  await page.waitForTimeout(200)
  ok(await textAt(12, 5) === '2026-03-04 00:00', `a date under Date and time paints midnight (got "${await textAt(12, 5)}")`)
  await page.evaluate(() => {
    const s = window.bento.doc.sheets.find((x) => x.name === 'Scratch')
    window.bento.commit({ op: 'setCanvasCells', sheet: s.id, cells: { F13: { v: '2026-03-04', format: 'dddd d mmmm yyyy' } } })
  })
  await page.waitForTimeout(200)
  const custom = await textAt(12, 5)
  ok(custom === 'Wednesday 4 March 2026', `an author's own pattern paints, in the viewer's words (got "${custom}")`)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dates.png` })

  ok(errors.length === 0, `no page errors (${errors.join(' | ') || 'none'})`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
