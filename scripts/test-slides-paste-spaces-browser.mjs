// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Pasted text keeps its runs of spaces, in the packaged editor (#750).
//
//   npm run build:single --prefix slides && node scripts/test-slides-paste-spaces-browser.mjs
//
// WHAT THIS PROVES, with real paste events into an editing text box:
//   1. plain text with runs of spaces keeps them, and in a monospace box the
//      columns line up (measured: the width of "a   b" is five characters,
//      not three), on the canvas and in the sidebar thumbnail, which paint the
//      same html as the show and the print view;
//   2. an html clipboard whose text sits in a <pre> or a `white-space: pre`
//      span keeps its spaces and its line breaks;
//   3. html that is NOT preformatted still collapses, as it always did;
//   4. pasting text with no box open makes a text element that keeps them.
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
      { id, type: 'text', x: 120, y: 60 + i * 180, w: 800, h: 120, rotation: 0, opacity: 1, html: 'x', fontSize: 28, fontFamily: 'monospace', color: '#1E2A3A', align: 'left' })) }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)
  const html = (id) => p.evaluate((i) => window.bento.doc.slides[0].elements.find((e) => e.id === i).html, id).then((h) => h.replaceAll('&nbsp;', '\u00a0'))
  const open = async (id) => {
    const b = await p.locator(`.ed-stage-scale [data-el-id="${id}"]`).boundingBox()
    await p.mouse.dblclick(b.x + 30, b.y + 20)
    await p.waitForTimeout(200)
    await p.keyboard.press('ControlOrMeta+a')
    await p.keyboard.press('Delete')
  }
  const paste = (data) => p.evaluate((d) => {
    const dt = new DataTransfer()
    for (const [k, v] of Object.entries(d)) dt.setData(k, v)
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, data)
  const leave = async () => { await p.keyboard.press('Escape'); await p.waitForTimeout(250) }
  const N = ' '
  const widthOf = (sel, needle) => p.evaluate(([s, n]) => {
    const root = document.querySelector(s)
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      const i = t.data.indexOf(n)
      if (i >= 0) { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + n.length); return r.getBoundingClientRect().width }
    }
    return -1
  }, [sel, needle])

  // 1. plain text
  await open('a')
  await paste({ 'text/plain': 'a   b\n    deep' })
  await leave()
  const a = await html('a')
  ok(a === `a${N}${N} b<br>${N}${N}${N}${N}deep`, `plain paste keeps the runs (${JSON.stringify(a)})`)
  const canvas = '.ed-stage-scale [data-el-id="a"]'
  const full = await widthOf(canvas, `a${N}${N} b`)
  const one = await widthOf(canvas, 'a')
  ok(full > 0 && Math.abs(full / one - 5) < 0.2, `monospace: "a   b" is five cells wide on the canvas (${(full / one).toFixed(2)})`)
  const thumb = await p.evaluate(() => [...document.querySelectorAll('[data-el-id="a"]')].filter((e) => !e.closest('.ed-stage-scale')).map((e) => e.textContent).join('|'))
  ok(thumb.includes(`a${N}${N} b`), 'the sidebar thumbnail paints the same spaces')

  // 2. preformatted html
  await open('b')
  await paste({ 'text/plain': 'ignored', 'text/html': '<pre>x   y\n  z\n</pre>' })
  await leave()
  const b = await html('b')
  ok(b === `x${N}${N} y<br>${N}${N}z`, `a <pre> keeps spaces and line breaks (${JSON.stringify(b)})`)
  await open('b')
  await paste({ 'text/html': '<span style="white-space: pre-wrap">p   q</span>' })
  await leave()
  ok(await html('b') === `p${N}${N} q`, `white-space: pre-wrap keeps spaces (${JSON.stringify(await html('b'))})`)

  // 3. ordinary html still collapses
  await open('c')
  await paste({ 'text/html': '<p>m   n</p>' })
  await leave()
  const c = await html('c')
  ok(!c.includes(N) && /m +n/.test(c), `non-preformatted html is untouched (${JSON.stringify(c)})`)

  // 4. paste with nothing open
  await p.mouse.click(1300, 900)
  await p.evaluate(() => document.activeElement?.blur?.())
  await p.evaluate(async () => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'k    v')
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await p.waitForTimeout(300)
  const added = await p.evaluate(() => window.bento.doc.slides[0].elements.map((e) => e.html).find((h) => h && h.startsWith('k')))
  ok(added === `k${N}${N}${N} v`, `pasting with no box open keeps them (${JSON.stringify(added)})`)

  ok(errors.length === 0, `no page errors ${errors.join('; ')}`)
} finally {
  await browser.close()
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
