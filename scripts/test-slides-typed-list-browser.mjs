// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Typing "- " / "* " starts a REAL list at once (discussion #711).
//
//   npm run build:single --prefix slides && node scripts/test-slides-typed-list-browser.mjs
//
// WHAT THIS PROVES, with real keys in the packaged editor
// (slides/src/editor/typedlist.ts):
//   1. "- x" and "* x" are an <ul><li> while the box is still open (no glyph);
//   2. Enter starts the next item, an empty item + Enter ends the list;
//   3. two spaces before the marker nest the item, Enter on an empty nested
//      item outdents it, Tab / Shift+Tab still move items;
//   4. ⌘Z right after the conversion puts the typed marker back;
//   5. "\- x" stays a literal dash;
//   6. inside an existing item, a typed marker is NOT a second bullet (#711);
//   7. glyph decks and pasted plain text still become lists on commit; a table
//      cell keeps its glyph.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const norm = (h) => h.replace(/\s+/g, ' ').replace(/<br>(?=<\/li>)/g, '').replace(/&nbsp;/g, ' ')

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await p.route(/^https?:/, (r) => r.abort())
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale'))

  const reset = async (html, extra = []) => {
    await p.evaluate(([h, ex]) => {
      const d = JSON.parse(JSON.stringify(window.bento.doc))
      d.slides = [{ id: 's1', background: '#ffffff', elements: [
        { id: 't', type: 'text', x: 120, y: 60, w: 520, h: 300, rotation: 0, opacity: 1, html: h, fontSize: 28, color: '#1E2A3A', align: 'left' },
        ...ex] }]
      window.bento.loadDoc(JSON.stringify(d))
    }, [html, extra])
    await p.waitForTimeout(400)
  }
  const sel = '.ed-stage-scale [data-el-id="t"] .bento-text-inner'
  const live = async () => norm(await p.evaluate((s) => document.querySelector(s).innerHTML, sel))
  const saved = async () => norm(await p.evaluate(() => window.bento.doc.slides[0].elements[0].html))
  const open = async () => {
    const b = await p.locator('.ed-stage-scale [data-el-id="t"]').boundingBox()
    await p.mouse.dblclick(b.x + 30, b.y + 20)
    await p.waitForTimeout(200)
  }
  const atEnd = (css = '') => p.evaluate(([s, c]) => {
    const e = document.querySelector(s); const t = c ? e.querySelector(c) : e
    const r = document.createRange(); r.selectNodeContents(t); r.collapse(false)
    const q = getSelection(); q.removeAllRanges(); q.addRange(r)
  }, [sel, css])
  const commit = async () => { await p.keyboard.press('Escape'); await p.waitForTimeout(300) }
  const type = (s) => p.keyboard.type(s)

  console.log('\nA typed marker is a real list at once\n')
  await reset('x'); await open(); await type('- one')
  ok(await live() === '<ul><li>one</li></ul>', `"- one" → a list while still open (${await live()})`)
  await p.keyboard.press('Enter'); await type('two')
  ok(await live() === '<ul><li>one</li><li>two</li></ul>', `Enter starts the next item (${await live()})`)
  await p.keyboard.press('Enter'); await p.keyboard.press('Enter'); await type('after')
  const ended = await live()
  ok(/^<ul><li>one<\/li><li>two<\/li><\/ul>.*after/.test(ended) && !/<li>after/.test(ended), `Enter on an empty item ends the list (${ended})`)
  await commit()
  ok(!/[•◦]/.test(await saved()), `committed with no glyph (${await saved()})`)

  await reset('x'); await open(); await type('* star')
  ok(await live() === '<ul><li>star</li></ul>', `"* " works too (${await live()})`)
  await commit()

  console.log('\nNesting\n')
  await reset('x'); await open(); await type('- one'); await p.keyboard.press('Enter'); await type('  - sub')
  ok(await live() === '<ul><li>one<ul><li>sub</li></ul></li></ul>', `two spaces then "- " nests (${await live()})`)
  await p.keyboard.press('Enter')
  await p.keyboard.press('Enter')
  ok(await live() === '<ul><li>one<ul><li>sub</li></ul></li><li></li></ul>', `Enter on an empty nested item outdents it (${await live()})`)
  await type('back')
  await p.keyboard.press('Tab')
  ok(await live() === '<ul><li>one<ul><li>sub</li><li>back</li></ul></li></ul>', `Tab still nests (${await live()})`)
  await p.keyboard.press('Shift+Tab')
  ok(await live() === '<ul><li>one<ul><li>sub</li></ul></li><li>back</li></ul>', `Shift+Tab still un-nests (${await live()})`)
  await commit()

  console.log('\nUndo and escapes\n')
  await reset('x'); await open(); await type('- ')
  ok((await live()).includes('<li>'), 'the marker converted')
  await p.keyboard.press(`${MOD}+z`)
  const undone = await live()
  ok(!undone.includes('<li>') && /^- ?$/.test(undone), `⌘Z puts the typed marker back (${undone})`)
  await type('x')
  ok(await live() === '- x', `and typing on is plain text (${await live()})`)
  await commit()
  await reset('x'); await open(); await type('\\- keep')
  await commit()
  ok(!(await saved()).includes('<li>') && (await saved()).includes('- keep') && !(await saved()).includes('\\'), `"\\- " keeps a literal dash (${await saved()})`)

  console.log('\nInside an existing item (the double bullet)\n')
  await reset('<ul><li>one</li></ul>'); await open(); await atEnd('li')
  await p.keyboard.press('Enter'); await type('  - sub')
  const inner = await live()
  ok(inner === '<ul><li>one<ul><li>sub</li></ul></li></ul>', `a marker in an item nests it, one bullet (${inner})`)
  ok(!/[•◦]/.test(inner), 'no glyph beside the item bullet')
  await commit()

  console.log('\nOlder content still converts\n')
  await reset('• a<br>• b'); await open(); await commit()
  ok(await saved() === '<ul><li>a</li><li>b</li></ul>', `glyph decks still become lists on commit (${await saved()})`)
  await reset('x'); await open()
  await p.evaluate((s) => {
    const dt = new DataTransfer(); dt.setData('text/plain', '- a\n- b')
    document.querySelector(s).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, sel)
  await commit()
  ok(await saved() === '<ul><li>a</li><li>b</li></ul>', `pasted "- a / - b" becomes a list (${await saved()})`)
  await reset('x', [{ id: 'tbl', type: 'table', x: 700, y: 60, w: 420, h: 120, rotation: 0, opacity: 1, columns: [{ w: 1 }], header: false,
    rows: [{ cells: [{ html: 'A' }] }], style: {} }])
  const cell = await p.locator('.ed-stage-scale [data-el-id="tbl"] td').first().boundingBox()
  await p.mouse.dblclick(cell.x + cell.width / 2, cell.y + cell.height / 2)
  await p.waitForTimeout(200)
  await p.keyboard.press(`${MOD}+a`); await type('- c')
  const cellHtml = await p.evaluate(() => document.activeElement?.innerHTML ?? '')
  ok(!cellHtml.includes('<li>') && cellHtml.includes('•'), `a table cell keeps the glyph (${cellHtml})`)

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
