// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The editor's hints (one tooltip for the chrome), in the packaged editor, with real input.
//
//   npm run build:single --prefix slides && node scripts/test-slides-hints-browser.mjs
//
// WHAT THIS PROVES:
//   1. resting on a control shows its hint after a short delay, not at once;
//   2. a trailing "(⌘Z)" in the text becomes key chips, apart from the words;
//   3. moving straight on to the next control shows its hint at once (warm);
//   4. while hovered the title is borrowed — no native tooltip doubles the
//      hint — with the same text as the icon button's accessible name, and
//      both are given back exactly on the way out;
//   5. keyboard focus shows the hint too, and leaves the title alone;
//   6. a press dismisses it;
//   7. the inspector says what it is about, on every tab — the selection's
//      name and how to change it (one element, several, or the slide) — so a
//      different set of options after a click is never a surprise; its
//      actions carry their shortcuts as key chips;
//   8. a section's help folds behind a "?" on its header line: hidden until
//      asked for, shown as a hint on hover, unfolded in place by a click.
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
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar'))
  await p.waitForTimeout(400)

  const btn = (title) => p.locator(`.ed-topbar .ed-btn[title="${title}"]`).first()
  const tip = () => p.evaluate(() => {
    const t = document.querySelector('.ed-tip')
    return t && !t.hidden ? { text: t.firstChild?.textContent ?? '', keys: [...t.querySelectorAll('kbd')].map((k) => k.textContent) } : null
  })
  const undo = btn('Undo (⌘Z)')
  const redo = btn('Redo (⇧⌘Z)')
  const ub = await undo.boundingBox(), rb = await redo.boundingBox()
  const undoNode = await undo.elementHandle()
  const attrs = () => undoNode.evaluate((n) => ({ title: n.getAttribute('title'), label: n.getAttribute('aria-label'), hint: n.dataset.hint ?? null }))
  const before = await attrs()

  // 1–2. rest, then a hint with key chips
  await p.mouse.move(ub.x + ub.width / 2, ub.y + ub.height / 2)
  await p.waitForTimeout(120)
  ok(await tip() === null, 'not at once')
  await p.waitForTimeout(500)
  const t1 = await tip()
  ok(t1?.text.trim() === 'Undo', `after a rest, the words (${JSON.stringify(t1)})`)
  ok(JSON.stringify(t1?.keys) === '["⌘Z"]', 'and the shortcut as keys')

  // 4. borrowed while hovered
  const during = await attrs()
  ok(during.title === null, 'the title is borrowed while hovered (no native tooltip on top)')
  ok(during.label === 'Undo' || before.label === during.label, `and the button keeps its accessible name (${during.label})`)

  // 3. warm hand-off
  await p.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2)
  await p.waitForTimeout(60)
  ok((await tip())?.text.trim() === 'Redo', 'moving straight on shows the next hint at once')
  ok(JSON.stringify(await attrs()) === JSON.stringify(before), `the title and name are given back exactly (${JSON.stringify(await attrs())})`)

  // 6. a press dismisses
  await p.mouse.down(); await p.mouse.up()
  ok(await tip() === null, 'a press dismisses it')

  // 5. keyboard focus
  await p.mouse.move(700, 450)
  await p.locator('.ed-title').focus()
  await p.keyboard.press('Tab')
  await p.waitForTimeout(600)
  const focused = await p.evaluate(() => document.activeElement?.getAttribute('title'))
  ok(!!focused && (await tip())?.text.trim() === focused.replace(/\s*\(.*\)\s*$/, ''), `keyboard focus shows the hint (${focused})`)
  ok(!!focused, 'and leaves the title where it is')

  // 7. the context line
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    const txt = (id, x) => ({ id, type: 'text', x, y: 100, w: 400, h: 100, rotation: 0, opacity: 1, html: id === 'a' ? 'Quarterly results' : 'B', fontSize: 32, color: '#1E2A3A' })
    d.slides = [{ id: 's1', background: '#ffffff', notes: '', elements: [txt('a', 100), txt('b', 700)] }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)
  const ctxLine = () => p.evaluate(() => ({ name: document.querySelector('.ed-context-name')?.textContent, how: document.querySelector('.ed-context-how')?.textContent }))
  await p.keyboard.press('Escape'); await p.waitForTimeout(200)
  let c = await ctxLine()
  ok(c.name === 'Slide 1' && /Select something/.test(c.how), `with nothing selected it names the slide and says how to see more (${JSON.stringify(c)})`)
  const pick = async (id, shift) => {
    const b = await p.locator(`.ed-stage-scale [data-el-id="${id}"]`).boundingBox()
    if (shift) await p.keyboard.down('Shift')
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await p.waitForTimeout(250)
    if (shift) await p.keyboard.up('Shift')
  }
  await pick('a')
  c = await ctxLine()
  ok(c.name === 'Quarterly results' && /empty part of the slide/.test(c.how), `one element: its name, and the way back to the slide (${JSON.stringify(c)})`)
  for (const name of ['Animate', 'Interact']) {
    await p.locator('.ed-props .ed-tabs [role="tab"]', { hasText: name }).click()
    ok(await p.locator('.ed-context').isVisible(), `the line is there on ${name} too`)
  }
  await p.locator('.ed-props .ed-tabs [role="tab"]', { hasText: 'Format' }).click()
  const dup = await p.locator('.ed-context .ed-btn-icon').first().boundingBox()
  await p.mouse.move(dup.x + dup.width / 2, dup.y + dup.height / 2); await p.waitForTimeout(600)
  const dt = await tip()
  ok(dt?.text.trim() === 'Duplicate' && dt.keys.length === 1 && /D$/.test(dt.keys[0]), `its actions show their shortcut (${JSON.stringify(dt)})`)
  await pick('b', true)
  c = await ctxLine()
  ok(c.name === '2 elements' && /Shift-click/.test(c.how), `several: how many, and how to change the set (${JSON.stringify(c)})`)

  // 8. folded help
  await p.keyboard.press('Escape'); await p.waitForTimeout(200)
  await pick('a')
  const typo = p.locator('.ed-props > .ed-section[data-key="Text"]')
  const body = p.locator('.ed-props > .ed-section[data-key="Text"] + .ed-section-body')
  const q = body.locator(':scope > .ed-help-btn')
  ok(await q.count() === 1, 'Text has a ? on its header line')
  ok(!(await body.locator(':scope > p.ed-hint').first().isVisible()), 'its help is folded away')
  const qb = await q.boundingBox(), hb = await typo.boundingBox()
  ok(Math.abs((qb.y + qb.height / 2) - (hb.y + hb.height / 2)) < 6, 'the ? sits on the header line')
  await p.mouse.move(qb.x + qb.width / 2, qb.y + qb.height / 2); await p.waitForTimeout(600)
  ok(/markdown/.test((await tip())?.text ?? ''), 'hovering it shows the help as a hint')
  await q.click(); await p.waitForTimeout(150)
  ok(await body.locator(':scope > p.ed-hint').first().isVisible() && await q.getAttribute('aria-expanded') === 'true', 'a click unfolds it in place')

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
