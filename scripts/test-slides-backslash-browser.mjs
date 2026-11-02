// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Typed backslashes survive leaving the text box, in the packaged editor (#697).
//
//   npm run build:single --prefix slides && node scripts/test-slides-backslash-browser.mjs
//
// WHAT THIS PROVES, with real keys: the reporter's two scenarios. `a\-b` typed
// into a text box and committed is still `a\-b`; `a\\-b` is still `a\\-b`
// after the first blur AND after reopening and blurring again; a real escape
// (`\*x\*`) still collapses to `*x*`.
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
    d.slides = [{ id: 's1', background: '#ffffff', elements: ['a', 'b', 'c'].map((id, i) => (
      { id, type: 'text', x: 120, y: 60 + i * 180, w: 520, h: 120, rotation: 0, opacity: 1, html: 'x', fontSize: 28, color: '#1E2A3A', align: 'left' })) }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)
  const html = (id) => p.evaluate((i) => window.bento.doc.slides[0].elements.find((e) => e.id === i).html, id)
  const open = async (id) => {
    const b = await p.locator(`.ed-stage-scale [data-el-id="${id}"]`).boundingBox()
    await p.mouse.dblclick(b.x + 30, b.y + 20)
    await p.waitForTimeout(200)
  }
  const retype = async (id, text) => {
    await open(id)
    await p.keyboard.press('ControlOrMeta+a')
    await p.keyboard.type(text)
    await p.keyboard.press('Escape')
    await p.waitForTimeout(250)
  }
  const reopenAndLeave = async (id) => {
    await open(id)
    await p.keyboard.press('Escape')
    await p.waitForTimeout(250)
  }

  await retype('a', 'a\\-b')
  ok(await html('a') === 'a\\-b', `scenario 1: a\\-b stays (${await html('a')})`)

  await retype('b', 'a\\\\-b')
  ok(await html('b') === 'a\\\\-b', `scenario 2: a\\\\-b stays (${await html('b')})`)
  await reopenAndLeave('b')
  ok(await html('b') === 'a\\\\-b', `scenario 2: and after reopening and leaving (${await html('b')})`)

  await retype('c', '\\*x\\*')
  ok(await html('c') === '*x*', `a real escape still collapses (${await html('c')})`)
  await reopenAndLeave('c')
  ok(await html('c') === '*x*', `and reopening changes nothing (${await html('c')})`)

  ok(errors.length === 0, `no page errors ${errors.join('; ')}`)
} finally {
  await browser.close()
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
