// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// ⌘C an element, ⌘V it onto another slide: it lands where it was (#569).
//
//   npm run build:single --prefix slides && node scripts/test-slides-paste-position-browser.mjs
//
// In the packaged editor: real ⌘C (its payload captured from the editor's own
// navigator.clipboard.writeText), then that payload handed to the editor's
// paste handler as a ClipboardEvent — the system clipboard of a headless
// browser is not dependable, the editor's code paths are.
//   1. onto ANOTHER slide the copy keeps its position;
//   2. onto the source slide it steps +20/+20 off the original;
//   3. pasted there again it cascades another +20;
//   4. a group duplicated with ⌘D, or copied and pasted, comes out as a group
//      of its OWN — one fresh group id for the copies — instead of joining the
//      original group (four members where there were two).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  await ctx.addInitScript(() => {
    window.__clips = []
    const clip = navigator.clipboard ?? {}
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: Object.assign(Object.create(Object.getPrototypeOf(clip) ?? Object.prototype), clip, {
        writeText: (t) => { window.__clips.push(String(t)); return Promise.resolve() },
      }),
    })
  })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale'))
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [
      { id: 's1', background: '#ffffff', elements: [{ id: 'box', type: 'shape', shape: 'rect', x: 200, y: 160, w: 180, h: 120, rotation: 0, opacity: 1, fill: '#5E7699' }] },
      { id: 's2', background: '#ffffff', elements: [] },
    ]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)

  const thumb = async (i) => { const b = await p.locator(`.ed-sidebar .ed-thumb[data-index="${i}"]`).boundingBox(); await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await p.waitForTimeout(250) }
  const paste = () => p.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', window.__clips.at(-1))
    document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }))
  }).then(() => p.waitForTimeout(250))
  const pos = (i) => p.evaluate((s) => window.bento.doc.slides[s].elements.map((e) => `${e.x},${e.y}`), i)

  const b = await p.locator('.ed-stage-scale [data-el-id="box"]').boundingBox()
  await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
  await p.waitForTimeout(150)
  await p.keyboard.press(`${MOD}+c`)
  await p.waitForTimeout(150)
  ok(/"__bento":"clip"/.test(await p.evaluate(() => window.__clips.at(-1) ?? '')), '⌘C wrote a Bento clip payload')

  await thumb(1)
  await paste()
  const s2 = await pos(1)
  ok(s2.length === 1 && s2[0] === '200,160', `onto another slide it keeps its position (${s2.join(' ')})`)

  await thumb(0)
  await paste()
  await paste()
  const s1 = await pos(0)
  ok(s1.join(' ') === '200,160 220,180 240,200', `onto the source slide it steps +20, then cascades (${s1.join(' ')})`)

  // 4. groups duplicate and paste as groups of their own
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    const box = (id, x) => ({ id, type: 'shape', shape: 'rect', x, y: 300, w: 160, h: 100, rotation: 0, opacity: 1, fill: '#5E7699', groupId: 'g' })
    d.slides = [{ id: 's1', background: '#ffffff', elements: [box('m1', 200), box('m2', 500)] }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)
  const groupsOf = () => p.evaluate(() => window.bento.doc.slides[0].elements.map((e) => e.groupId))
  const fresh = (gs) => { const c = gs.slice(2); return c.length === 2 && c[0] === c[1] && c[0] !== 'g' && gs[0] === 'g' && gs[1] === 'g' }
  const m = await p.locator('.ed-stage-scale [data-el-id="m1"]').boundingBox()
  await p.mouse.click(m.x + m.width / 2, m.y + m.height / 2); await p.waitForTimeout(200)
  ok((await p.evaluate(() => window.bento.selection.length)) === 2, 'precondition: a click selects the whole pair')
  await p.keyboard.press(`${MOD}+d`); await p.waitForTimeout(250)
  ok(fresh(await groupsOf()), `⌘D: the copies form one new group of their own (${(await groupsOf()).join(' ')})`)
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250)
  await p.mouse.click(m.x + m.width / 2, m.y + m.height / 2); await p.waitForTimeout(200)
  await p.keyboard.press(`${MOD}+c`); await p.waitForTimeout(150)
  await paste()
  ok(fresh(await groupsOf()), `paste: the copies form one new group of their own (${(await groupsOf()).join(' ')})`)

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
