// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash first run, in the packaged document: it boots whatever language
// tag the browser has stored, every swept string answers to the audit locale,
// the formula dialog says what is wrong as you type, new sheets are "Sheet3",
// and the keyboard reaches the whole window with a ring you can see.
//
//   npm run build:single --prefix dash && node scripts/test-dash-firstrun-browser.mjs
//
// WHAT THIS PROVES, each with a control that shows the path really ran:
//   1. A BAD STORED LANGUAGE CANNOT STOP BOOT. 'bento-lang' is shared by every
//      file on the origin; 'x-pseudo' (the audit locale) or a malformed tag
//      used to reach Intl.NumberFormat and end in "This file could not start".
//      Control: Intl itself throws on each tag in this browser.
//   2. THE AUDIT LOCALE WORKS, and the strings it used to expose are swept: the
//      Total picker, the footer's SUM/AVG label, the chart and 3D kind button
//      and heading, the formula dialog, and the xlsx and CSV import notices
//      (control: those imports really produced notices to read).
//   3. THE FORMULA DIALOG checks syntax as you type (`Value * 2 +`), lists the
//      functions with signatures, narrows to the word being typed, inserts on
//      Enter, and accepts the starter's own id-written formula on edit.
//   4. A NEW SHEET IS NAMED "Sheet3", of either kind.
//   5. KEYBOARD: Tab from the page walks top bar → grid → panel → sheet tabs,
//      every stop showing a 2px --accent-ink ring (slides' ring); Enter on a
//      focused top-bar button presses it; F6 walks the regions; Tab at the
//      grid's last column leaves the grid instead of trapping focus.
//   6. The sheet-tab caption is at least 11px.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const SHELL = new URL('../dash/dist-single/Bento_Dash.bento.html', import.meta.url).href
const MAP = { a: 'à', e: 'ē', i: 'ï', o: 'ő', u: 'ū', c: 'ĉ', n: 'ñ', s: 'š', y: 'ý', A: 'Å', E: 'Ê', I: 'Ì', O: 'Ø', U: 'Ü', C: 'Ç', N: 'Ñ', S: 'Š', Y: 'Ÿ' }
const ps = (s) => '⟦' + s.replace(/[a-zA-Z]/g, (c) => MAP[c] ?? c) + '⟧'
/** Wholly inside the audit brackets (sentences may be joined by spaces). */
const swept = (s) => !!s && s.trim().length > 0 && s.trim().replace(/⟦[^⟧]*⟧/g, '').replace(/[\s·.,:;()0-9£$%-]/g, '') === ''

/** One block of checks. A block that throws (on old code, the page that
 *  never boots) is a failure, and the rest of the rig still runs. */
async function section(run) {
  try { await run() } catch (e) { ok(false, `the block ran to the end (${String(e?.message ?? e).split('\n')[0]})`) }
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })

async function open(lang, { w = 1440, h = 900, dev3d = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, acceptDownloads: true })
  await ctx.route(/^https?:/, (r) => r.abort())
  if (lang) await ctx.addInitScript((l) => { try { localStorage.setItem('bento-lang', l) } catch {} }, lang)
  // 3D's button is behind a per-viewer developer flag; its strings still ship
  if (dev3d) await ctx.addInitScript(() => { try { localStorage.setItem('bento-dash-dev-3d', 'on') } catch {} })
  const page = await ctx.newPage()
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.dismiss())
  await page.goto(SHELL)
  const booted = await page.waitForFunction(() => window.bento?.doc && document.querySelector('.dg-cell'), null, { timeout: 8000 })
    .then(() => true, () => false)
  await page.waitForTimeout(200)
  return { ctx, page, errors, booted }
}

try {
  // ------------------------------------------------------------------ 1. boot
  console.log('\n1. a stored language tag cannot stop boot\n')
  for (const tag of ['x-pseudo', 'en_US!!', 'not a tag']) {
    const { ctx, page, errors, booted } = await open(tag)
    const r = await page.evaluate((t) => {
      let threw = false
      try { new Intl.NumberFormat(t) } catch { threw = true }
      return {
        threw,
        stored: localStorage.getItem('bento-lang'),
        refused: /could not start/i.test(document.body.innerText),
        money: [...document.querySelectorAll('.dg-cell')].map((c) => c.textContent).find((s) => /\d{1,3}[,.\s ]?\d{3}/.test(s ?? '')) ?? '',
      }
    }, tag)
    ok(r.threw, `control: Intl.NumberFormat(${JSON.stringify(tag)}) throws in this browser`)
    ok(r.stored === tag, `the tag really is stored (${JSON.stringify(r.stored)})`)
    ok(booted && !r.refused && errors.length === 0,
      `with ${JSON.stringify(tag)} stored the workbook opens (booted=${booted}, refused=${r.refused}, errors=${errors.join(' | ') || 'none'})`)
    ok(!!r.money, `and its numbers are formatted (${r.money || 'none found'})`)
    await ctx.close()
  }

  // --------------------------------------------------------- 2. pseudo sweep
  console.log('\n2. the audit locale, and the strings it exposed\n')
  await section(async () => {
    const { ctx, page, errors } = await open('x-pseudo', { dev3d: true })
    const formulaLabel = await page.locator('[data-act="formula"] span').textContent()
    ok(formulaLabel === ps('Formula'), `control: the audit locale is active (top bar reads ${formulaLabel})`)

    // A Money cell: the panel offers a Total only on the number types
    await page.locator('.dg-cell[role="gridcell"][data-col="value"]').first().click()
    await page.waitForTimeout(200)
    const total = await page.evaluate(() => {
      const sel = [...document.querySelectorAll('.dp-panel select')].find((s) => [...s.options].some((o) => o.value === 'sum'))
      return sel ? [...sel.options].map((o) => o.textContent) : null
    })
    ok(total && total.length >= 6 && total.every(swept), `every Total option is swept (${total?.join(' / ')})`)
    const foot = await page.locator('.dg-agg').first().textContent()
    ok(swept(foot), `the footer total's label is swept (${foot})`)

    await page.locator('[data-act="chart"]').click()
    await page.waitForTimeout(300)
    const kind2d = await page.locator('.dx-chart-kind').textContent()
    ok(swept(kind2d), `the chart kind button is swept (${kind2d})`)
    await page.locator('[data-act="viz3d"]').click()
    await page.waitForTimeout(400)
    const kind3d = await page.locator('.dx-chart-kind').textContent()
    const head3d = await page.locator('.dx-chart-title').textContent()
    ok(swept(kind3d), `the 3D kind button is swept (${kind3d})`)
    ok(head3d.startsWith('⟦'), `the 3D heading's kind is swept (${head3d})`)

    // xlsx: export the starter (it has a totals row), then import it back —
    // which is the round trip the review found the developer-voice notices on
    const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => document.querySelector('[data-act="export-xlsx"]').click())])
    const xlsx = await dl.path()
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.evaluate(() => document.querySelector('[data-act="import-xlsx"]').click())])
    await fc.setFiles(xlsx)
    await page.waitForTimeout(800)
    const xl = await page.evaluate(() => [...document.querySelectorAll('.dx-findings li, .dx-findings p, .dx-findings > *')]
      .map((e) => e.textContent.replace(/^●\s*/, '').trim()).filter((s) => s && s !== '●'))
    ok(xl.length >= 1, `control: the xlsx round trip produced notices to read (${xl.length})`)
    ok(xl.length >= 1 && xl.every(swept), `every xlsx notice is swept${xl.filter((s) => !swept(s)).map((s) => `\n          unswept: ${s}`).join('')}`)

    // CSV: a ragged row and a repeated header
    const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.evaluate(() => document.querySelector('[data-act="import"]').click())])
    await fc2.setFiles({ name: 'odd.csv', mimeType: 'text/csv', buffer: Buffer.from('a,a,b\n1,2,3\n4,5\n6,7,8\n') })
    await page.waitForTimeout(800)
    const csv = await page.evaluate(() => [...document.querySelectorAll('.dx-findings li, .dx-findings p, .dx-findings > *')]
      .map((e) => e.textContent.replace(/^●\s*/, '').trim()).filter((s) => s && s !== '●'))
    ok(csv.length >= 2, `control: the CSV import produced notices to read (${csv.length})`)
    ok(csv.length >= 2 && csv.every(swept), `every CSV notice is swept${csv.filter((s) => !swept(s)).map((s) => `\n          unswept: ${s}`).join('')}`)

    ok(errors.length === 0, `no page errors in the audit locale (${errors.join(' | ') || 'none'})`)
    await ctx.close()
  })
  await section(async () => {
    const { ctx, page } = await open('x-pseudo')
    await page.locator('[data-act="formula"]').click()
    await page.waitForTimeout(200)
    await page.locator('.dx-ask-in').first().fill('Value * 2 +')
    await page.waitForTimeout(100)
    const err = await page.locator('.dx-ask-err').textContent()
    const heads = await page.locator('.dx-fn-h').allTextContents()
    ok(swept(err), `the formula dialog's syntax error is swept (${err})`)
    ok(heads.length >= 2 && heads.every((h) => h.startsWith('⟦')), `the function list's headings are swept (${heads.join(' / ')})`)
    await ctx.close()
  })

  await section(async () => {
    // In English the Total picker says words, not the model's `avg`
    const { ctx, page } = await open('en')
    // A Money cell: the panel offers a Total only on the number types
    await page.locator('.dg-cell[role="gridcell"][data-col="value"]').first().click()
    await page.waitForTimeout(200)
    const total = await page.evaluate(() => {
      const sel = [...document.querySelectorAll('.dp-panel select')].find((s) => [...s.options].some((o) => o.value === 'sum'))
      return sel ? [...sel.options].map((o) => o.textContent) : null
    })
    ok(total?.join('/') === 'None/Sum/Average/Count/Minimum/Maximum', `the Total picker reads None/Sum/Average/Count/Minimum/Maximum (${total?.join('/')})`)
    await ctx.close()
  })

  // ---------------------------------------------------- 3. formula dialog (en)
  console.log('\n3. the formula dialog\n')
  await section(async () => {
    const { ctx, page } = await open('en')
    await page.locator('[data-act="formula"]').click()
    await page.waitForTimeout(200)
    const inp = page.locator('.dx-ask-in').first()
    const err = page.locator('.dx-ask-err')
    const go = page.locator('.dx-ask-go')
    await inp.fill('')
    await inp.pressSequentially('Value * 2 +')
    ok(await err.isVisible() && (await err.textContent()) === 'Something has to follow “+”.' && await go.isDisabled(),
      `"Value * 2 +" says what is wrong as it is typed, and Add is off (${await err.textContent()})`)
    await inp.pressSequentially(' 1')
    ok(await err.isHidden() && await go.isEnabled(), 'finishing it ("Value * 2 + 1") clears the error and turns Add back on')
    await inp.fill('SUMM(Value)')
    ok(/no function called SUMM/.test(await err.textContent()), `an unknown function is named (${await err.textContent()})`)
    await inp.fill('Value * 15%')
    ok(/15% is 0\.15/.test(await err.textContent()), `a percent sign says how to write a percentage (${await err.textContent()})`)

    const all = await page.locator('.dx-fn-item').count()
    await inp.fill('')
    await inp.pressSequentially('Value * SU')
    await page.waitForTimeout(50)
    const items = await page.locator('.dx-fn-item').allTextContents()
    ok(all >= 100, `the list shows every function with nothing typed (${all})`)
    ok(items.length > 0 && items.length < all && items.every((s) => /^[A-Z0-9]*SU/.test(s) || s.includes('SU')) && items[0].startsWith('SUBSTITUTE('),
      `typing "SU" narrows it to ${items.length}, with signatures (${items.slice(0, 3).join(' · ')} …)`)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    ok(await inp.inputValue() === 'Value * SUBSTITUTE(', `↓ then Enter writes the function at the caret, replacing the half-typed word (${await inp.inputValue()})`)
    ok(await page.locator('.dx-ask').isVisible(), 'and Enter on the list did not submit the dialog')
    const chips = await page.locator('.dx-fn-col').allTextContents()
    ok(chips.includes('Value') && chips.includes('Probability'), `the sheet's columns are listed as chips (${chips.join(', ')})`)
    await page.keyboard.press('Escape')

    // the starter's computed column is written against column ids
    await page.locator('.dg-row[data-row="0"] .dg-cell[data-col="weighted"]').click()
    await page.keyboard.press('F2')
    await page.waitForTimeout(300)
    const editing = await page.locator('.dx-ask').isVisible()
    ok(editing, 'F2 on the starter\'s Weighted cell opens its formula')
    if (editing) {
      ok(await page.locator('.dx-ask-in').first().inputValue() === 'value * prob' && await page.locator('.dx-ask-err').isHidden(),
        'and its id-written formula ("value * prob") is accepted, not refused as an unknown column')
    }
    await ctx.close()
  })

  // ---------------------------------------------------------- 4. sheet names
  console.log('\n4. new sheet names\n')
  await section(async () => {
    const { ctx, page } = await open('en')
    const before = await page.evaluate(() => window.bento.doc.sheets.map((s) => s.name))
    for (const [i, kind] of [[1, 'spreadsheet'], [0, 'dataset']]) {
      await page.locator('.dx-tab-add').click()
      await page.locator('.dx-tab-menu-row').nth(i).click()
      await page.waitForTimeout(200)
    }
    const after = await page.evaluate(() => window.bento.doc.sheets.map((s) => s.name))
    const added = after.slice(before.length)
    const n = before.length
    ok(added[0] === `Sheet${n + 1}` && added[1] === `Sheet${n + 2}`,
      `a new spreadsheet then a new dataset on a workbook of ${n} are "Sheet${n + 1}", "Sheet${n + 2}" (got ${added.join(', ')})`)
    await ctx.close()
  })

  // ------------------------------------------------------------- 5. keyboard
  console.log('\n5. the keyboard reaches everything, with a visible ring\n')
  await section(async () => {
    const { ctx, page } = await open('en')
    const where = () => page.evaluate(() => {
      const el = document.activeElement
      const s = el ? getComputedStyle(el) : null
      const probe = document.createElement('div')
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--accent-ink')
      document.body.append(probe)
      const ink = getComputedStyle(probe).color
      probe.remove()
      const region = !el || el === document.body ? 'body'
        : el.closest('.dx-bar') ? 'top' : el.closest('.dx-formula') ? 'formula'
          : el.closest('.dg-scroll') ? 'grid' : el.closest('.dp-panel') ? 'panel' : el.closest('.dx-tabs') ? 'tabs' : 'other'
      const ringed = !!s && s.outlineStyle === 'solid' && s.outlineWidth === '2px' && s.outlineColor === ink && el.matches(':focus-visible')
      const cursor = !!el && el.classList.contains('dg-cursor')
      const control = !!el && el.matches('button, input, select, textarea, a[href], [tabindex]')
      return { region, ringed, cursor, control, tag: el?.tagName, cls: String(el?.className ?? '').split(' ')[0], text: (el?.textContent ?? '').trim().slice(0, 20) }
    })
    const seen = []
    const unringed = []
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press('Tab')
      const w = await where()
      if (seen[seen.length - 1] !== w.region) seen.push(w.region)
      // a grid cell shows the cursor box, not an outline; checkboxes their own
      if (w.region !== 'body' && !w.ringed && !w.cursor && !/dp-check/.test(w.cls)) unringed.push(`${w.region} ${w.tag}.${w.cls} "${w.text}"`)
      if (w.region === 'body' && seen.includes('tabs')) break
    }
    const order = seen.filter((r) => ['top', 'grid', 'panel', 'tabs'].includes(r))
    ok(['top', 'grid', 'panel', 'tabs'].every((r, i) => order.indexOf(r) >= 0 && (i === 0 || order.indexOf(r) > order.indexOf(['top', 'grid', 'panel', 'tabs'][i - 1]))),
      `Tab walks top bar → grid → panel → sheet tabs (${seen.join(' → ')})`)
    ok(unringed.length === 0, `every stop shows the 2px --accent-ink ring (or the grid's cursor box)${unringed.map((u) => `\n          no ring: ${u}`).join('')}`)

    // Enter on a focused top-bar button presses it
    await page.locator('[data-act="formula"]').focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    ok(await page.locator('.dx-ask').isVisible(), 'Enter on the focused Formula button opens its dialog (it used to move the grid cursor)')
    await page.keyboard.press('Escape')

    // F6 walks the regions
    await page.evaluate(() => document.activeElement?.blur())
    const f6 = []
    for (let i = 0; i < 6; i++) { await page.keyboard.press('F6'); f6.push((await where()).region) }
    ok(f6.slice(0, 5).join(',') === 'top,formula,grid,panel,tabs' && f6[5] === 'top', `F6 walks the regions and wraps (${f6.join(' → ')})`)
    await page.keyboard.press('Shift+F6')
    ok((await where()).region === 'tabs', 'Shift+F6 walks back')

    // Tab inside the grid is the next cell — and at the last column it leaves
    // Frames between steps: the grid repaints the row and re-focuses the cursor
    // cell after a move, and a slower runner reads focus mid-repaint otherwise.
    const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    await page.locator('.dg-row[data-row="1"] .dg-cell[data-ci]').first().click()
    await settle()
    const afterClick = await where()
    ok(afterClick.region === 'grid' && afterClick.cursor, `a clicked cell takes focus (focus on ${afterClick.region} ${afterClick.tag}.${afterClick.cls} "${afterClick.text}")`)
    const ciBefore = await page.evaluate(() => document.querySelector('.dg-cursor')?.getAttribute('data-ci'))
    await page.keyboard.press('Tab')
    await settle()
    const inGrid = await where()
    const ciAfter = await page.evaluate(() => document.querySelector('.dg-cursor')?.getAttribute('data-ci'))
    ok(inGrid.region === 'grid' && inGrid.cursor && Number(ciAfter) === Number(ciBefore) + 1,
      `inside the grid, Tab moves to the next cell (the data-entry run) (column ${ciBefore} → ${ciAfter}, focus on ${inGrid.region} ${inGrid.tag}.${inGrid.cls})`)
    await page.keyboard.press('End')
    await settle()
    await page.keyboard.press('Tab')
    await settle()
    const out = await where()
    ok(out.region !== 'grid' && out.region !== 'body', `Tab at the last column leaves the grid (now on ${out.region} ${out.tag}.${out.cls})`)
    await ctx.close()
  })

  // ---------------------------------------------------------- 6. tab caption
  console.log('\n6. the sheet tab caption\n')
  await section(async () => {
    const { ctx, page } = await open('en')
    const sizes = await page.evaluate(() => [...document.querySelectorAll('.dx-tab-word, .dx-tab-kind')]
      .map((e) => parseFloat(getComputedStyle(e).fontSize)))
    ok(sizes.length > 0 && sizes.every((s) => s >= 11), `the tab's kind caption is at least 11px (${sizes.join(', ')}px)`)
    await ctx.close()
  })
} finally {
  await browser.close()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
