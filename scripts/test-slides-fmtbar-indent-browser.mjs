// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Indent and Outdent in the inline formatting bar (discussion #724).
//
//   npm run build:single --prefix slides && node scripts/test-slides-fmtbar-indent-browser.mjs
//
// WHAT THIS PROVES, with real selections and clicks:
//   1. selecting text in a bulleted list item shows Outdent and Indent in the
//      bar, Indent nests the item under the one above (the format's own
//      <li>…<ul><li>), Outdent puts it back, the selection stays and the bar
//      stays up;
//   2. the same on a NUMBERED list (nested <ol>);
//   3. a nested item is painted further in than its parent, on the canvas and
//      in the sidebar thumbnail (the same renderer the show and print use);
//   4. off a list, the two buttons are disabled and a click changes nothing;
//   5. the first item cannot indent and a top-level item cannot outdent.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let failures = 0
function ok(cond, msg) {
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const UL = '<ul><li>One</li><li>Two</li><li>Three</li></ul>'
const OL = '<ol><li>One</li><li>Two</li><li>Three</li></ol>'
const norm = (h) => h.replace(/\s+/g, ' ').replace(/<br>(?=<\/li>)/g, '')

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await p.route(/^https?:/, (r) => r.abort())
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale'))
  await p.evaluate(([ul, ol]) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    const text = (id, y, html) => ({ id, type: 'text', x: 120, y, w: 520, h: 150, rotation: 0, opacity: 1, html, fontSize: 28, color: '#1E2A3A', align: 'left' })
    d.slides = [{ id: 's1', background: '#ffffff', elements: [text('ul', 40, ul), text('ol', 230, ol), text('plain', 420, 'Plain words here')] }]
    window.bento.loadDoc(JSON.stringify(d))
  }, [UL, OL])
  await p.waitForTimeout(400)

  const inner = (id) => `.ed-stage-scale [data-el-id="${id}"] .bento-text-inner`
  const live = (id) => p.evaluate((s) => document.querySelector(s).innerHTML, inner(id))
  const edit = async (id) => {
    const b = await p.locator(`.ed-stage-scale [data-el-id="${id}"]`).boundingBox()
    await p.mouse.dblclick(b.x + 30, b.y + 20)
    await p.waitForTimeout(200)
  }
  // select the words of the item (or text node) whose text is `word`
  const select = (id, word) => p.evaluate(([s, w]) => {
    const root = document.querySelector(s)
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.data.trim() === w) {
      const r = document.createRange(); r.selectNodeContents(n)
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); return true
    }
    return false
  }, [inner(id), word])
  const btn = (dir) => p.locator(`.ed-fmtbar [data-indent="${dir}"]`)
  const barUp = async () => { await p.waitForTimeout(150); return (await p.locator('.ed-fmtbar').count()) > 0 }
  const selText = () => p.evaluate(() => getSelection().toString())
  const leave = async () => { await p.keyboard.press('Escape'); await p.waitForTimeout(250) }
  const NESTED = (tag) => `<${tag}><li>One<${tag}><li>Two</li></${tag}></li><li>Three</li></${tag}>`

  for (const [id, tag, flat] of [['ul', 'ul', UL], ['ol', 'ol', OL]]) {
    console.log(`\n${tag === 'ul' ? 'bulleted' : 'numbered'} list\n`)
    await edit(id)
    await select(id, 'Two')
    ok(await barUp() && await btn(1).count() === 1 && await btn(-1).count() === 1, 'the bar has Outdent and Indent')
    ok(await btn(1).isEnabled() && await btn(-1).isEnabled(), 'enabled inside a list')
    await btn(1).click()
    ok(norm(await live(id)) === NESTED(tag), `Indent nests item 2 (${norm(await live(id))})`)
    ok(await selText() === 'Two' && await barUp(), 'the selection and the bar stay')
    const xs = await p.evaluate((s) => [...document.querySelectorAll(s + ' li')].map((l) => Math.round(l.getBoundingClientRect().left + parseFloat(getComputedStyle(l).paddingLeft))), inner(id))
    const labelLeft = await p.evaluate((s) => {
      const out = []
      for (const li of document.querySelectorAll(s + ' li')) {
        const t = [...li.childNodes].find((n) => n.nodeType === 3)
        const r = document.createRange(); r.selectNodeContents(t); out.push(Math.round(r.getBoundingClientRect().left))
      }
      return out
    }, inner(id))
    ok(labelLeft[1] > labelLeft[0] + 10 && labelLeft[2] === labelLeft[0], `the nested item is painted further in on the canvas (${labelLeft})`)
    await btn(-1).click()
    ok(norm(await live(id)) === flat, 'Outdent puts it back')
    await select(id, 'One')
    await btn(1).click()
    ok(norm(await live(id)) === flat, 'the first item cannot indent')
    await btn(-1).click()
    ok(norm(await live(id)) === flat, 'a top-level item cannot outdent')
    await select(id, 'Two')
    await btn(1).click()
    await leave()
    const thumbLeft = await p.evaluate((i) => {
      const root = [...document.querySelectorAll(`[data-el-id="${i}"]`)].find((e) => !e.closest('.ed-stage-scale'))
      const out = []
      for (const li of root.querySelectorAll('li')) {
        const t = [...li.childNodes].find((n) => n.nodeType === 3)
        const r = document.createRange(); r.selectNodeContents(t); out.push(r.getBoundingClientRect().left)
      }
      return out
    }, id)
    ok(thumbLeft[1] > thumbLeft[0] && thumbLeft[2] === thumbLeft[0], `and in the sidebar thumbnail (${thumbLeft.map((v) => Math.round(v))})`)
  }

  console.log('\noff a list\n')
  await edit('plain')
  await select('plain', 'Plain words here')
  ok(await barUp(), 'the bar is up')
  ok(await btn(1).isDisabled() && await btn(-1).isDisabled(), 'both buttons are disabled')
  const before = await live('plain')
  await btn(1).click({ force: true })
  ok(await live('plain') === before, 'a click changes nothing')
  await leave()

  ok(errors.length === 0, `no page errors ${errors.join('; ')}`)
} finally {
  await browser.close()
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
