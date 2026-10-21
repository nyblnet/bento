// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The grid's core gestures, driven with a real mouse and keyboard.
//
//   npm run build:single --prefix dash && node scripts/test-dash-gestures-browser.mjs
//
// WHAT THIS PROVES, in the packaged document on the starter workbook:
//   1. a column header click SELECTS the column (shift extends, ⌘ adds) and
//      never sorts; a right-click opens the column menu without sorting; the
//      spreadsheet's column letters select the same way;
//   2. sorting still works from the header ▾ menu, and the selected cell
//      follows its ROW through the sort instead of staying on the screen
//      position (which then holds a different record);
//   3. double-clicking a column name renames it in place: Enter commits one
//      undo step, Escape changes nothing;
//   4. ＋ Add a column asks for the type up front, and the type chip on the
//      header reads at 11px or more without touching the column letter;
//   5. ⌘C / ⌘X draw marching ants over what was copied, until Escape, the next
//      edit, or a paste;
//   6. POINT MODE: after `=`, an operator, `(` or `,`, clicking a cell or
//      pressing an arrow inserts its address (shift and drag make a range,
//      with a highlight), another sheet's tab inserts `Sheet!A1`, Enter
//      commits — on a spreadsheet AND in a dataset per-cell formula, where a
//      sorted view still writes the FILE's row;
//   7. Escape closes the Story panel — and does NOT leave a pivot sheet (a
//      pivot is a sheet since #815; you leave a sheet by its tab).
// Every row has a control showing the path ran (the selection moved, the menu
// opened, the click still commits where no reference can go, …).
// DASH_SHELL=<path> runs it against another build (the fails-on-old-code check).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const SHELL = process.env.DASH_SHELL
  ? new URL(`file://${process.env.DASH_SHELL}`).href
  : new URL('../dash/dist-single/Bento_Dash.bento.html', import.meta.url).href
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
const errors = []

async function fresh() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(SHELL)
  await page.waitForSelector('.dg-h[data-col]')
  await page.waitForTimeout(300)
  return { ctx, page }
}

const cellSel = (r, c) => `.dg-sizer .dg-row[data-row="${r}"] .dg-cell[data-ci="${c}"]`
async function center(page, sel) {
  const b = await page.locator(sel).first().boundingBox()
  if (!b) throw new Error(`no box for ${sel}`)
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}
async function click(page, sel, opts = {}) {
  const p = await center(page, sel)
  if (opts.modifiers) for (const m of opts.modifiers) await page.keyboard.down(m)
  await page.mouse.click(p.x, p.y, { button: opts.button ?? 'left', clickCount: opts.clickCount ?? 1 })
  if (opts.modifiers) for (const m of opts.modifiers) await page.keyboard.up(m)
  await page.waitForTimeout(60)
}
async function dblclick(page, sel) {
  const p = await center(page, sel)
  await page.mouse.dblclick(p.x, p.y)
  await page.waitForTimeout(80)
}
const sorts = (page) => page.$$eval('.dg-h[data-col]', (els) => els.map((e) => e.getAttribute('aria-sort')))
const onCols = (page) => page.$$eval('.dg-h.dg-h-on', (els) => els.map((e) => Number(e.dataset.ci)))
const colOf = (page, name) => page.evaluate((n) => window.bento.doc.sheets[0].columns.find((c) => c.name === n)?.id, name)
const editorText = (page) => page.evaluate(() => document.querySelector('.dg-editing')?.textContent ?? null)
const selRows = (page, ci) => page.$$eval(`.dg-sizer .dg-row[data-rid] .dg-cell[data-ci="${ci}"]`,
  (els) => els.filter((e) => e.classList.contains('dg-sel')).length)
const dataRows = (page) => page.$$eval('.dg-sizer .dg-row[data-rid]', (els) => els.length)
const cursorText = (page) => page.evaluate(() => document.querySelector('.dg-sizer .dg-cursor')?.textContent ?? null)

// ── 1. header click selects, never sorts ─────────────────────────────────────
console.log('header click')
{
  const { ctx, page } = await fresh()
  const rows = await dataRows(page)
  ok((await sorts(page)).every((s) => s === 'none'), 'control: nothing is sorted at boot')
  await click(page, '.dg-h[data-ci="1"] .dg-name')
  ok((await sorts(page)).every((s) => s === 'none'), 'clicking the Owner name does not sort')
  ok(!/Sorted/.test(await page.evaluate(() => document.querySelector('.dg-a11y')?.textContent ?? '')), 'the view status says nothing about a sort')
  ok(JSON.stringify(await onCols(page)) === '[1]', `the click selects column B (lit: ${JSON.stringify(await onCols(page))})`)
  ok(await selRows(page, 1) === rows, `every row of column B is selected (${await selRows(page, 1)}/${rows})`)
  await click(page, '.dg-h[data-ci="2"] .dg-letter', { modifiers: ['Shift'] })
  ok(JSON.stringify(await onCols(page)) === '[1,2]', `shift-click extends to B:C (${JSON.stringify(await onCols(page))})`)
  await click(page, '.dg-h[data-ci="4"]', { modifiers: [MOD] })
  const lit = await onCols(page)
  ok(lit.includes(4) && lit.includes(1) && !lit.includes(3), `⌘-click adds column E without D (${JSON.stringify(lit)})`)
  ok(await selRows(page, 4) === rows && await selRows(page, 3) === 0, 'E is wholly selected, D not at all')
  // right-click: the column menu, still no sort
  await click(page, '.dg-h[data-ci="2"] .dg-name', { button: 'right' })
  ok(await page.$('.dx-pop') !== null, 'control: right-click opened the column menu')
  ok((await sorts(page)).every((s) => s === 'none'), 'right-click does not sort')
  await page.keyboard.press('Escape')
  // double-click the name: rename, not sort-twice
  await dblclick(page, '.dg-h[data-ci="1"] .dg-name')
  ok((await sorts(page)).every((s) => s === 'none'), 'double-click does not sort')
  ok(await page.$('.dg-h .dg-rename') !== null, 'double-click opens an in-place name field')
  await page.keyboard.press(`${MOD}+a`)
  await page.keyboard.type('Seller')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(80)
  const names = () => page.evaluate(() => window.bento.doc.sheets[0].columns.map((c) => c.name))
  ok((await names())[1] === 'Seller', `Enter commits the new name (${(await names())[1]})`)
  ok(await page.$eval('.dg-h[data-ci="1"] .dg-name', (e) => e.textContent.trim()) === 'Seller', 'the header shows it')
  await page.evaluate(() => window.bento.undo())
  await page.waitForTimeout(60)
  ok((await names())[1] === 'Owner', 'ONE undo puts the old name back')
  await dblclick(page, '.dg-h[data-ci="1"] .dg-name')
  await page.keyboard.type('Nope')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(60)
  ok((await names())[1] === 'Owner' && await page.$('.dg-rename') === null, 'Escape cancels the rename')
  // the spreadsheet's letters select the same way
  await click(page, '.dx-tab[data-sheet="sheet-scratch"]')
  await page.waitForSelector('.dg-canvas .dg-h.dg-ch')
  await click(page, '.dg-ch[data-ci="2"]')
  ok(JSON.stringify(await onCols(page)) === '[2]', `spreadsheet: clicking C selects column C (${JSON.stringify(await onCols(page))})`)
  await click(page, '.dg-ch[data-ci="4"]', { modifiers: ['Shift'] })
  ok(JSON.stringify(await onCols(page)) === '[2,3,4]', `spreadsheet: shift-click extends to C:E (${JSON.stringify(await onCols(page))})`)
  await ctx.close()
}

// ── 2. sorting from ▾, and the selection follows its row ─────────────────────
console.log('sort from the menu')
{
  const { ctx, page } = await fresh()
  // East / Lee / £4,300 sits on visible row 3
  await click(page, cellSel(3, 3))
  const before = await cursorText(page)
  const ownerId = await colOf(page, 'Owner')
  await click(page, `.dg-filter[data-filter="${ownerId}"]`)
  await click(page, '.dx-pop button[data-a="asc"]')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(80)
  ok((await sorts(page))[1] === 'ascending', 'Sort A → Z in the ▾ menu sorts the column')
  const at3 = await page.$eval(cellSel(3, 3), (e) => e.textContent)
  ok(at3 !== before, `control: the sort moved a different record onto row 4 (${at3} ≠ ${before})`)
  ok(await cursorText(page) === before, `the selected cell followed its row (${await cursorText(page)} = ${before})`)
  // and a selected whole column stays the whole column
  await click(page, '.dg-h[data-ci="0"]')
  await click(page, `.dg-filter[data-filter="${await colOf(page, 'Value')}"]`)
  await click(page, '.dx-pop button[data-a="desc"]')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(80)
  ok(JSON.stringify(await onCols(page)) === '[0]' && await selRows(page, 0) === await dataRows(page), 'a selected column stays selected through a sort')
  await ctx.close()
}

// ── 3. add a column with its type; the type chip is readable ─────────────────
console.log('add column + type chip')
{
  const { ctx, page } = await fresh()
  const chip = await page.$$eval('.dg-h[data-col]', (els) => els.map((h) => {
    const t = h.querySelector('.dg-type'); const l = h.querySelector('.dg-letter')
    const a = t.getBoundingClientRect(); const b = l.getBoundingClientRect()
    const s = getComputedStyle(t)
    return { size: parseFloat(s.fontSize), op: parseFloat(s.opacity), gap: a.left - b.right, clipped: t.scrollWidth > t.clientWidth + 0.5, text: t.textContent }
  }))
  ok(chip.length === 7, 'control: seven type chips measured')
  ok(chip.every((c) => c.size >= 11), `every type chip is at least 11px (${[...new Set(chip.map((c) => c.size))].join(',')})`)
  ok(chip.every((c) => c.op >= 0.99), 'at full opacity')
  ok(chip.every((c) => c.gap >= 4), `none comes within 4px of its letter (min ${Math.min(...chip.map((c) => c.gap)).toFixed(1)})`)
  ok(chip.every((c) => !c.clipped), `none is truncated in English (${chip.filter((c) => c.clipped).map((c) => c.text).join(',') || 'none'})`)
  await click(page, '.dg-add-col')
  await page.waitForSelector('.dx-ask')
  const sel = await page.$('.dx-ask select')
  ok(sel !== null, 'the New column dialog has a type picker')
  if (sel) {
    const opts = await sel.$$eval('option', (os) => os.map((o) => o.value))
    ok(opts.length === 7 && opts.includes('money') && opts.includes('date'), `it offers every column type (${opts.join(',')})`)
    const name = await page.$('.dx-ask input.dx-ask-in')
    await name.fill('Budget')
    await sel.selectOption('money')
    await page.click('.dx-ask-go')
    await page.waitForTimeout(80)
    const col = await page.evaluate(() => window.bento.doc.sheets[0].columns.at(-1))
    ok(col?.name === 'Budget' && col?.type === 'money', `the new column is created with the chosen type (${col?.name}:${col?.type})`)
  }
  await ctx.close()
}

// ── 4. copy marks ────────────────────────────────────────────────────────────
console.log('copy marks')
{
  const { ctx, page } = await fresh()
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
  await click(page, cellSel(1, 0))
  await click(page, cellSel(2, 1), { modifiers: ['Shift'] })
  ok(await page.$('.dg-ants') === null, 'control: no ants before copying')
  await page.keyboard.press(`${MOD}+c`)
  await page.waitForTimeout(60)
  const ants = await page.$('.dg-ants')
  ok(ants !== null, '⌘C draws the marching ants')
  if (ants) {
    const a = await ants.boundingBox(); const o = await (await page.$('.dg-outline')).boundingBox()
    ok(Math.abs(a.x - o.x) <= 2 && Math.abs(a.width - o.width) <= 3 && Math.abs(a.height - o.height) <= 3,
      `over exactly the copied range (${a.width.toFixed(0)}×${a.height.toFixed(0)} vs ${o.width.toFixed(0)}×${o.height.toFixed(0)})`)
  }
  await click(page, cellSel(5, 2))
  ok(await page.$('.dg-ants') !== null, 'moving the selection keeps them')
  await page.keyboard.press('Escape')
  ok(await page.$('.dg-ants') === null, 'Escape clears them')
  await click(page, cellSel(1, 0))
  await page.keyboard.press(`${MOD}+c`)
  await click(page, cellSel(6, 1))
  await page.keyboard.type('Late')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(60)
  ok(await page.$eval(cellSel(6, 1), (e) => e.textContent) === 'Late', 'control: the edit was written')
  ok(await page.$('.dg-ants') === null, 'the next edit clears them')
  await click(page, cellSel(1, 0))
  await page.keyboard.press(`${MOD}+c`)
  ok(await page.$('.dg-ants') !== null, 'control: copied again')
  await click(page, cellSel(7, 2))
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'South')
    ;(document.activeElement ?? document.body).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }))
  })
  await page.waitForTimeout(60)
  const pasted = await page.$eval(cellSel(7, 2), (e) => e.textContent)
  ok(pasted.startsWith('South'), `control: the paste landed (${pasted})`)
  ok(await page.$('.dg-ants') === null, 'a paste clears them')
  await click(page, cellSel(2, 0))
  await page.keyboard.press(`${MOD}+x`)
  await page.waitForTimeout(60)
  ok(await page.$('.dg-ants') !== null, '⌘X draws them too (after the cut has cleared the cell)')
  await ctx.close()
}

// ── 5. point mode ────────────────────────────────────────────────────────────
console.log('point mode')
{
  const { ctx, page } = await fresh()
  await click(page, '.dx-tab[data-sheet="sheet-scratch"]')
  await page.waitForSelector('.dg-canvas .dg-sizer .dg-row')
  // numbers to point at: C3:C5 = 1, 2, 3
  await click(page, cellSel(2, 2))
  for (const n of ['1', '2', '3']) { await page.keyboard.type(n); await page.keyboard.press('Enter') }
  const scratch = () => page.evaluate(() => window.bento.doc.sheets.find((s) => s.id === 'sheet-scratch').cells)
  await click(page, cellSel(0, 0))
  await page.keyboard.type('=SUM(')
  await click(page, cellSel(2, 2))
  ok(await editorText(page) === '=SUM(C3', `clicking C3 inserts its address (${await editorText(page)})`)
  ok(await page.$('.dg-point') !== null, 'and highlights it')
  await click(page, cellSel(4, 2), { modifiers: ['Shift'] })
  ok(await editorText(page) === '=SUM(C3:C5', `shift-click makes it a range (${await editorText(page)})`)
  const hl = await page.$('.dg-point')
  if (hl) {
    const h = await hl.boundingBox(); const top = await page.locator(cellSel(2, 2)).boundingBox()
    ok(Math.abs(h.y - top.y) <= 3 && h.height >= top.height * 3 - 4, `the highlight covers C3:C5 (${h.height.toFixed(0)}px tall)`)
  }
  await page.keyboard.type(')')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(80)
  ok((await scratch())['0,0']?.f === '=SUM(C3:C5)' || Object.values(await scratch()).some((c) => c?.f === '=SUM(C3:C5)'),
    'Enter commits =SUM(C3:C5)')
  ok(await page.$eval(cellSel(0, 0), (e) => e.textContent) === '6', `which computes 6 (${await page.$eval(cellSel(0, 0), (e) => e.textContent)})`)
  // arrows: from the editing cell, shift to extend
  await click(page, cellSel(0, 1))
  await page.keyboard.type('=')
  await page.keyboard.press('ArrowDown')
  ok(await editorText(page) === '=B2', `an arrow points at the cell below (${await editorText(page)})`)
  await page.keyboard.press('ArrowRight')
  ok(await editorText(page) === '=C2', `a second arrow MOVES the reference rather than adding one (${await editorText(page)})`)
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  ok(await editorText(page) === '=C2:C4', `shift+arrow extends it (${await editorText(page)})`)
  await page.keyboard.type('*2')
  await page.keyboard.press('ArrowLeft')
  ok(await editorText(page) === '=C2:C4*2', `after an operand an arrow is just the caret again (${await editorText(page)})`)
  await page.keyboard.press('Escape')
  // drag draws a range
  await click(page, cellSel(1, 4))
  await page.keyboard.type('=')
  const a = await center(page, cellSel(2, 2)); const b = await center(page, cellSel(4, 3))
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up()
  ok(await editorText(page) === '=C3:D5', `a drag points at a range (${await editorText(page)})`)
  await page.keyboard.press('Escape')
  // control: where no reference can go, a click still commits and moves
  await click(page, cellSel(6, 0))
  await page.keyboard.type('=C3')
  await click(page, cellSel(8, 3))
  ok(await editorText(page) === null, 'control: after an operand, a click commits the edit')
  ok(Object.values(await scratch()).some((c) => c?.f === '=C3'), 'control: and =C3 was written')
  // another sheet's tab
  await click(page, cellSel(7, 0))
  await page.keyboard.type('=')
  await click(page, '.dx-tab[data-sheet="sheet-pipeline"]')
  ok(await page.evaluate(() => document.querySelector('.dx-tab.active')?.dataset.sheet) === 'sheet-scratch', 'clicking the Pipeline tab does not leave the sheet')
  ok(await editorText(page) === '=Pipeline!A1', `it inserts Pipeline!A1 (${await editorText(page)})`)
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  ok(await editorText(page) === '=Pipeline!D2', `arrows walk the other sheet (${await editorText(page)})`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(80)
  ok(/8,?200/.test(await page.$eval(cellSel(7, 0), (e) => e.textContent)), `=Pipeline!D2 computes £8,200's value (${await page.$eval(cellSel(7, 0), (e) => e.textContent)})`)
  await ctx.close()
}

console.log('point mode on a dataset')
{
  const { ctx, page } = await fresh()
  const stage = await colOf(page, 'Stage')
  const over = () => page.evaluate((id) => Object.entries(window.bento.doc.sheets[0].cells ?? {})
    .filter(([k, v]) => k.startsWith(id + ':') && v?.f).map(([, v]) => v.f), stage)
  await click(page, cellSel(0, 2))
  await page.keyboard.type('=')
  await click(page, cellSel(1, 3))
  ok(await editorText(page) === '=D2', `a dataset cell points too (${await editorText(page)})`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(80)
  ok((await over()).includes('=D2'), 'Enter writes the per-cell formula =D2')
  // sorted by Value ▼: the top row is the file's row 6 (£22,750)
  await click(page, `.dg-filter[data-filter="${await colOf(page, 'Value')}"]`)
  await click(page, '.dx-pop button[data-a="desc"]')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(80)
  ok(/22,750/.test(await page.$eval(cellSel(0, 3), (e) => e.textContent)), 'control: £22,750 is on top after the sort')
  await click(page, cellSel(2, 2))
  await page.keyboard.type('=')
  await click(page, cellSel(0, 3))
  ok(await editorText(page) === '=D6', `pointing in a sorted view writes the FILE's row (${await editorText(page)})`)
  await page.keyboard.press('Escape')
  await ctx.close()
}

// ── 6. Escape closes Story, not a pivot sheet ────────────────────────────────
console.log('Escape closes panels')
{
  const { ctx, page } = await fresh()
  await click(page, cellSel(1, 1))
  await click(page, '[data-act="story"]')
  ok(await page.$('.ds-editor') !== null, 'control: the Story panel opened')
  await page.keyboard.press(`${MOD}+c`)
  await page.keyboard.press('Escape')
  ok(await page.$('.dg-ants') === null && await page.$('.ds-editor') !== null, 'one Escape closes one thing: the copy marks first')
  await page.keyboard.press('Escape')
  ok(await page.$('.ds-editor') === null, 'Escape closes the Story panel')
  await click(page, '.ds-editor', { modifiers: [] }).catch(() => {})
  // NOT THE PIVOT, deliberately. The Pivot side panel this section used to
  // close is gone: since #815 a pivot is a SHEET with a tab, and as in Excel you
  // leave a sheet by its tab, never with Escape. So the row is the opposite one:
  // Escape on a pivot sheet leaves it on screen, and throws nothing.
  const pivotUp = () => page.evaluate(() => {
    const el = document.querySelector('.dx-pivotview')
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'
  })
  await click(page, '[data-act="pivot"]')
  await page.waitForTimeout(150)
  await page.locator('.dx-tab:not(.active)').first().click()
  await page.waitForTimeout(150)
  await page.locator('.dx-tab', { hasText: /pivot/i }).first().click()
  await page.waitForTimeout(150)
  const pivotWas = await pivotUp()
  const errorsBefore = errors.length
  await page.keyboard.press('Escape')
  await page.waitForTimeout(60)
  ok(pivotWas && await pivotUp() && errors.length === errorsBefore,
    `Escape does not leave a pivot sheet, and throws nothing (control: opened from its tab, the pivot was shown: ${pivotWas})`)
  await ctx.close()
}

await browser.close()
ok(errors.length === 0, `no page errors (${errors.join(' | ') || 'none'})`)
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
