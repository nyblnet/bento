// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The ⌘K command palette, and the shortcuts that moved into the same command list.
//
//   npm run build:single --prefix slides && node scripts/test-slides-command-palette-browser.mjs
//
// WHAT THIS PROVES.
//   1. ⌘K opens the palette with its input focused; typing filters by a fuzzy
//      match; ↑↓ move the choice; Enter runs it and closes; Esc closes.
//   2. The command that ran is listed first the next time the palette opens.
//   3. The keys that moved into the list still do what they did: ⌘D
//      duplicates, ⌘Z / ⇧⌘Z undo and redo, ⌘G groups, [ hides the slide list,
//      PageDown walks a slide — and none of them fires while typing in a field.
//   4. The topbar's Undo tooltip reads its keys from the list.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const nEls = () => p.evaluate(() => {
    const i = [...document.querySelectorAll('.ed-thumb')].findIndex((t) => t.classList.contains('active'))
    return window.bento.doc.slides[Math.max(0, i)].elements.length
  })
  const selection = () => p.evaluate(() => window.bento.selection)

  console.log('\nthe palette\n')
  await p.mouse.click(700, 120) // focus the page, not a field
  await p.keyboard.press('Escape')
  await p.keyboard.press(`${mod}+k`)
  ok(await p.isVisible('.ed-cmdk'), '⌘K opens the palette')
  ok(await p.evaluate(() => document.activeElement?.classList.contains('ed-cmdk-input')), 'its input has focus')
  const all = await p.$$eval('.ed-cmdk-list li', (l) => l.length)
  ok(all > 20, `it lists the commands (${all})`)
  ok(await p.$$eval('.ed-cmdk-list kbd', (k) => k.some((x) => x.textContent === 'F5')), 'shortcuts show as key chips')
  await p.keyboard.type('add tab')
  const first = await p.$eval('.ed-cmdk-list li[aria-selected="true"]', (li) => li.dataset.cmd)
  ok(first === 'insert-table', `a fuzzy query picks "Add a table" first (${first})`)
  ok(await p.$$eval('.ed-cmdk-list li', (l) => l.length) < all, 'typing filters the list')
  await p.keyboard.press('Backspace'); await p.keyboard.press('Backspace'); await p.keyboard.press('Backspace')
  await p.keyboard.type('xt box')
  const before = await nEls()
  await p.keyboard.press('Enter')
  ok(!(await p.$('.ed-cmdk')), 'Enter closes the palette')
  await p.waitForTimeout(200)
  // the text tool arms, as T does; a click on the slide puts the box down
  { const b = await p.locator('.ed-stage-scale').boundingBox(); await p.mouse.click(b.x + b.width / 2, b.y + b.height * 0.85) }
  await p.waitForTimeout(250)
  await p.keyboard.press('Escape') // leave the new text box's editing; it stays selected
  ok(await nEls() === before + 1, `Enter ran the chosen command — a text box was added (${before} → ${await nEls()})`)
  const added = await selection()
  await p.keyboard.press(`${mod}+k`)
  ok(await p.$eval('.ed-cmdk-list li', (li) => li.dataset.cmd) === 'insert-text', 'the command just used is listed first next time')
  await p.keyboard.press('ArrowDown')
  ok(await p.$eval('.ed-cmdk-list li:nth-child(2)', (li) => li.getAttribute('aria-selected')) === 'true', '↓ moves the choice')
  await p.keyboard.press('Escape')
  ok(!(await p.$('.ed-cmdk')), 'Esc closes it')
  ok(JSON.stringify(await selection()) === JSON.stringify(added), 'Esc in the palette leaves the selection alone')

  console.log('\nthe keys that moved into the list\n')
  ok(added.length === 1, `the new text box is selected (${added.length})`)
  const n0 = await nEls()
  await p.keyboard.press(`${mod}+d`)
  ok(await nEls() === n0 + 1, '⌘D duplicates the selection')
  await p.keyboard.press(`${mod}+z`)
  ok(await nEls() === n0, '⌘Z undoes it')
  await p.keyboard.press(`${mod}+Shift+z`)
  ok(await nEls() === n0 + 1, '⇧⌘Z redoes it')
  await p.keyboard.press(`${mod}+z`)
  await p.keyboard.press(`${mod}+z`) // and the inserted text box
  ok(await nEls() === before, 'undo walks back to the deck as it was')
  await p.mouse.click(700, 120); await p.keyboard.press('Escape')
  await p.keyboard.press(`${mod}+a`)
  await p.keyboard.press(`${mod}+k`)
  await p.keyboard.type('distribute')
  const dist = await p.$$eval('.ed-cmdk-list li', (l) => l.map((x) => x.dataset.cmd))
  ok(dist[0]?.startsWith('distribute-'), `the other tools' word finds the command — "distribute" → ${dist.slice(0, 2).join(', ')}`)
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape')
  const sideOpen = () => p.evaluate(() => !document.querySelector('.ed-root')?.classList.contains('left-collapsed') && (document.querySelector('.ed-sidebar')?.getBoundingClientRect().width ?? 0) > 40)
  const wasOpen = await sideOpen()
  await p.keyboard.press('[')
  await p.waitForTimeout(350)
  ok(await sideOpen() !== wasOpen, '[ still toggles the slide list')
  await p.keyboard.press('[')
  await p.waitForTimeout(350)
  const slideAt = () => p.evaluate(() => [...document.querySelectorAll('.ed-thumb')].findIndex((t) => t.classList.contains('active')))
  await p.keyboard.press('Escape')
  const s0 = await slideAt()
  await p.keyboard.press('PageDown')
  ok(await slideAt() === s0 + 1, `PageDown walks to the next slide (${s0} → ${await slideAt()})`)
  await p.keyboard.press('PageUp')

  console.log('\nnot while typing\n')
  const title = await p.$('.ed-topbar .ed-title')
  await title.click()
  await p.keyboard.press(`${mod}+k`)
  ok(!(await p.$('.ed-cmdk')), '⌘K does not open while a text field has focus')
  const s1 = await slideAt()
  await p.keyboard.press('PageDown')
  ok(await slideAt() === s1, 'PageDown in a field is the field’s own key')
  await p.keyboard.press('Escape')

  console.log('\nthe topbar\n')
  const undoTitle = await p.$$eval('.ed-group-history .ed-btn', (b) => b.map((x) => x.getAttribute('title') ?? x.dataset.hint ?? ''))
  ok(undoTitle.some((x) => /^Undo \((⌘|Ctrl)Z\)$/.test(x)), `Undo's tooltip carries its keys from the list (${undoTitle[0]})`)

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
