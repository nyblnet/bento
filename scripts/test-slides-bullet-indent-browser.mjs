// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Indent and outdent bullets (discussion #368) in the packaged editor.
//
//   npm run build:single --prefix slides && node scripts/test-slides-bullet-indent-browser.mjs
//
// WHAT THIS PROVES, with real keys and clicks (slides/src/editor/listindent.ts):
//   1. editing a list, Tab on item 2 nests it under item 1 and Shift+Tab puts
//      it back; the caret stays in the box; Tab on the first item or Shift+Tab
//      at the top level changes nothing and does NOT throw focus out;
//   2. ⌘Z straight after a Tab restores the box;
//   3. committed, the nesting is the format's own (<li>…<ul><li>…) and it is
//      ONE undo step;
//   4. typed bullets ("- a", "- b") indent too: the second becomes a sub-bullet
//      of the first once committed;
//   5. the panel's Indent / Outdent do the same: under the caret while editing
//      (the caret stays), the whole box as one undo step when not;
//   6. Tab outside a list is unchanged: a plain text box still lets focus go,
//      and a table cell still moves to the next cell.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const LIST = '<ul><li>One</li><li>Two</li><li>Three</li></ul>'
const NESTED = '<ul><li>One<ul><li>Two</li></ul></li><li>Three</li></ul>'
const norm = (h) => h.replace(/\s+/g, ' ').replace(/<br>(?=<\/li>)/g, '')

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await p.route(/^https?:/, (r) => r.abort())
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale'))

  await p.evaluate(([list]) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    const text = (id, y, html) => ({ id, type: 'text', x: 120, y, w: 520, h: 150, rotation: 0, opacity: 1, html, fontSize: 28, color: '#1E2A3A', align: 'left' })
    d.slides = [{ id: 's1', background: '#ffffff', elements: [
      text('list', 60, list),
      text('typed', 240, 'x'),
      text('plain', 420, 'Plain words'),
      { id: 'tbl', type: 'table', x: 700, y: 60, w: 420, h: 120, rotation: 0, opacity: 1, columns: [{ w: 1 }, { w: 1 }], header: false,
        rows: [{ cells: [{ html: 'A' }, { html: 'B' }] }, { cells: [{ html: 'C' }, { html: 'D' }] }], style: {} },
    ] }]
    window.bento.loadDoc(JSON.stringify(d))
  }, [LIST])
  await p.waitForTimeout(400)

  const inner = (id) => `.ed-stage-scale [data-el-id="${id}"] .bento-text-inner`
  const html = (id) => p.evaluate((i) => window.bento.doc.slides[0].elements.find((e) => e.id === i).html, id)
  const live = (id) => p.evaluate((s) => document.querySelector(s).innerHTML, inner(id))
  const focusedIn = (id) => p.evaluate((s) => document.querySelector(s)?.contains(document.activeElement), inner(id))
  const edit = async (id) => {
    const b = await p.locator(`.ed-stage-scale [data-el-id="${id}"]`).boundingBox()
    await p.mouse.dblclick(b.x + 30, b.y + 20)
    await p.waitForTimeout(200)
  }
  // put the caret at the end of the item whose own text is `word`
  const caretAfter = (id, word) => p.evaluate(([s, w]) => {
    const root = document.querySelector(s)
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.data.trim() === w) {
      const r = document.createRange(); r.setStart(n, n.data.length); r.collapse(true)
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); return true
    }
    return false
  }, [inner(id), word])
  const commit = async () => { await p.keyboard.press('Escape'); await p.waitForTimeout(250) }

  console.log('\nTab / Shift+Tab on a list item\n')
  await edit('list')
  await caretAfter('list', 'Two')
  await p.keyboard.press('Tab')
  ok(norm(await live('list')) === NESTED, `Tab nests item 2 under item 1 (${norm(await live('list'))})`)
  ok(await focusedIn('list'), 'the caret stays in the box')
  await p.keyboard.press('Shift+Tab')
  ok(norm(await live('list')) === LIST, 'Shift+Tab puts it back')
  await caretAfter('list', 'One')
  await p.keyboard.press('Tab')
  ok(norm(await live('list')) === LIST && await focusedIn('list'), 'Tab on the first item changes nothing and keeps focus')
  await p.keyboard.press('Shift+Tab')
  ok(norm(await live('list')) === LIST && await focusedIn('list'), 'Shift+Tab at the top level changes nothing and keeps focus')

  console.log('\n⌘Z straight after\n')
  await caretAfter('list', 'Two')
  await p.keyboard.press('Tab')
  await p.keyboard.press(`${MOD}+z`)
  ok(norm(await live('list')) === LIST, '⌘Z after a Tab restores the box')

  console.log('\ncommitted: the format\'s own nesting, one undo step\n')
  await caretAfter('list', 'Two')
  await p.keyboard.press('Tab')
  await commit()
  ok(norm(await html('list')) === NESTED, `the stored html nests (${norm(await html('list'))})`)
  await p.evaluate(() => window.bento.undo())
  await p.waitForTimeout(150)
  ok(norm(await html('list')) === LIST, 'one undo takes the whole edit back')

  console.log('\ntyped bullets\n')
  await edit('typed')
  await p.keyboard.type('- a')
  await p.keyboard.press('Enter')
  await p.keyboard.type('- b')
  await p.keyboard.press('Tab')
  const typedLive = await live('typed')
  ok(/<ul><li>a<ul><li>b<\/li><\/ul><\/li><\/ul>/.test(norm(typedLive)) && await focusedIn('typed'), `Tab on a typed "- b" bullet makes it a sub-bullet, caret kept (${norm(typedLive)})`)
  await commit()
  ok(/<ul><li>a<ul><li>b<\/li><\/ul><\/li><\/ul>/.test(norm(await html('typed'))), `committed, b is nested under a (${norm(await html('typed'))})`)

  console.log('\nthe panel buttons\n')
  const panelBtn = (label) => p.locator('.ed-shift-row .ed-btn', { hasText: label })
  await edit('list')
  await caretAfter('list', 'Two')
  await panelBtn('Indent').click()
  ok(norm(await live('list')) === NESTED && await focusedIn('list'), 'editing: Indent nests the item under the caret, caret kept')
  await panelBtn('Outdent').click()
  ok(norm(await live('list')) === LIST, 'editing: Outdent puts it back')
  await commit()
  await p.keyboard.press('Escape')
  const b = await p.locator('.ed-stage-scale [data-el-id="list"]').boundingBox()
  await p.mouse.click(b.x + 30, b.y + 20)
  await p.waitForTimeout(200)
  await panelBtn('Indent').click()
  await p.waitForTimeout(150)
  ok(norm(await html('list')) === '<ul><li>One<ul><li>Two</li><li>Three</li></ul></li></ul>', `not editing: the whole box indents (${norm(await html('list'))})`)
  await p.evaluate(() => window.bento.undo())
  await p.waitForTimeout(150)
  ok(norm(await html('list')) === LIST, 'and one undo takes it back')

  console.log('\nTab outside a list is unchanged\n')
  await edit('plain')
  await p.keyboard.press('Tab')
  await p.waitForTimeout(150)
  ok(!(await focusedIn('plain')), 'in a plain text box, Tab still lets focus go')
  ok((await html('plain')) === 'Plain words', 'and the text is untouched')
  const cell = await p.locator('.ed-stage-scale [data-el-id="tbl"] td').first().boundingBox()
  await p.mouse.dblclick(cell.x + cell.width / 2, cell.y + cell.height / 2)
  await p.waitForTimeout(200)
  await p.keyboard.press('Tab')
  await p.waitForTimeout(150)
  const nowIn = await p.evaluate(() => (document.activeElement?.closest?.('td')?.textContent ?? document.activeElement?.textContent ?? '').trim())
  ok(nowIn === 'B', `in a table cell, Tab still moves to the next cell (now in "${nowIn}")`)

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
