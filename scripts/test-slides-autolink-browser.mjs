// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// URLs typed or pasted into a text box become links, in the packaged editor
// (discussion #723).
//
//   npm run build:single --prefix slides && node scripts/test-slides-autolink-browser.mjs
//
// WHAT THIS PROVES, with real keys and a real paste event:
//   1. a URL followed by a space becomes an <a href>, a trailing full stop stays
//      outside it, and what is typed next is plain text, not link text;
//   2. ⌘Z straight after the conversion puts the plain URL back;
//   3. Enter finishes a URL too, and ⌘Z then reverts the link;
//   4. javascript: (and a bare scheme) never become links;
//   5. committed, the link is in the model with its href; the sidebar thumbnail
//      paints it; reopening and leaving changes nothing;
//   6. pasted plain text with a URL in it is linked.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let failures = 0
function ok(cond, msg) {
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await p.route(/^https?:/, (r) => r.abort())
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale'))
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', elements: ['a', 'b', 'c', 'd'].map((id, i) => (
      { id, type: 'text', x: 120, y: 40 + i * 150, w: 800, h: 100, rotation: 0, opacity: 1, html: 'x', fontSize: 28, color: '#1E2A3A', align: 'left' })) }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)
  const MOD = 'ControlOrMeta'
  const inner = (id) => `.ed-stage-scale [data-el-id="${id}"] .bento-text-inner`
  const live = (id) => p.evaluate((s) => document.querySelector(s).innerHTML.replace(/​/g, ''), inner(id))
  const model = (id) => p.evaluate((i) => window.bento.doc.slides[0].elements.find((e) => e.id === i).html, id)
  const open = async (id) => {
    const b = await p.locator(`.ed-stage-scale [data-el-id="${id}"]`).boundingBox()
    await p.mouse.dblclick(b.x + 30, b.y + 20)
    await p.waitForTimeout(200)
    await p.keyboard.press(`${MOD}+a`)
    await p.keyboard.press('Delete')
  }
  const leave = async () => { await p.keyboard.press('Escape'); await p.waitForTimeout(250) }
  const anchors = (id) => p.evaluate((s) => [...document.querySelectorAll(s + ' a')].map((a) => [a.getAttribute('href'), a.textContent]), inner(id))

  console.log('\ntyped, then a space\n')
  await open('a')
  await p.keyboard.type('see https://github.com. ')
  ok(JSON.stringify(await anchors('a')) === '[["https://github.com","https://github.com"]]', `a link, the full stop outside (${await live('a')})`)
  await p.keyboard.type('next')
  const html = await live('a')
  ok(/<\/a>\.(?:&nbsp;| )next/.test(html), `typing on is plain text outside the link (${html})`)
  await p.keyboard.press(`${MOD}+a`); await p.keyboard.press('Delete')
  await p.keyboard.type('go https://example.org/x ')
  await p.keyboard.press(`${MOD}+z`)
  ok((await anchors('a')).length === 0 && (await live('a')).includes('https://example.org/x'), `⌘Z puts the plain URL back (${await live('a')})`)
  await p.keyboard.press(`${MOD}+a`); await p.keyboard.press('Delete')
  await p.keyboard.type('keep https://keep.me ')
  await leave()

  console.log('\ncommitted\n')
  const kept = await model('a')
  ok(/<a href="https:\/\/keep\.me">https:\/\/keep\.me<\/a>/.test(kept), `the model has the link (${kept})`)
  const thumb = await p.evaluate(() => [...document.querySelectorAll('[data-el-id="a"] a')].filter((e) => !e.closest('.ed-stage-scale')).map((a) => a.getAttribute('href')))
  ok(thumb.includes('https://keep.me'), 'the sidebar thumbnail paints it')
  await open('b'); await leave()
  const b = await p.locator(`.ed-stage-scale [data-el-id="a"]`).boundingBox()
  await p.mouse.dblclick(b.x + 30, b.y + 20); await p.waitForTimeout(200); await leave()
  ok(await model('a') === kept, 'reopening and leaving changes nothing')

  console.log('\nEnter\n')
  await open('b')
  await p.keyboard.type('https://enter.me')
  await p.keyboard.press('Enter')
  ok(JSON.stringify(await anchors('b')) === '[["https://enter.me","https://enter.me"]]', `Enter links it (${await live('b')})`)
  await p.keyboard.press(`${MOD}+z`)
  ok((await anchors('b')).length === 0 && (await live('b')).includes('https://enter.me'), `⌘Z reverts it (${await live('b')})`)
  await leave()

  console.log('\nnever javascript:\n')
  await open('c')
  await p.keyboard.type('javascript:alert(1) and https:// and http://. ')
  ok((await anchors('c')).length === 0, `no link (${await live('c')})`)
  await leave()

  console.log('\npasted\n')
  await open('d')
  await p.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'docs at https://a.b/c_d_e, thanks')
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  ok(JSON.stringify(await anchors('d')) === '[["https://a.b/c_d_e","https://a.b/c_d_e"]]', `pasted text is linked, no italics (${await live('d')})`)
  await leave()

  ok(errors.length === 0, `no page errors ${errors.join('; ')}`)
} finally {
  await browser.close()
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
