// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The inspector's Export section — end to end in the built shell.
//
//   npm run build:single --prefix slides && node scripts/test-slides-export-section-browser.mjs
//
// WHAT THIS PROVES.
//   1. Export sits on the Format tab, after everything else, for the slide, one
//      element and a multi-selection alike.
//   2. With nothing selected, PNG 2× is the whole slide at twice its size.
//   3. With an element selected, PNG 1× is that element's box (rotation
//      included) and nothing more, and its corner pixel is the element's fill.
//   4. SVG is a standalone image of the same box (its viewBox is the box).
//   5. Copy as JSON writes ⌘C's clipboard payload: the selected elements.
//   6. A multi-selection exports in the slide's paint order.
import { readFileSync } from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
/** width × height out of a PNG's IHDR */
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)]

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'])
  await ctx.route(/^https?:/, (r) => r.abort())
  // the section starts folded (rarely needed); open it, as a click on its header would
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-panel-open', JSON.stringify({ Export: true })) } catch {} })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(process.env.SHELL_HTML ? 'file://' + process.env.SHELL_HTML : new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))
  const rect = (id, x, y, w, h, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, rotation: 0, opacity: 1, fill: '#ff0000', stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })
  await p.evaluate((els) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', notes: '', transition: 'none', elements: els }]
    window.bento.loadDoc(JSON.stringify(d))
  }, [rect('a', 100, 100, 200, 100), rect('b', 600, 300, 100, 100, { rotation: 45, fill: '#0000ff' })])
  await p.waitForTimeout(400)
  const size = await p.evaluate(() => window.bento.doc.size)
  const formatTab = () => p.evaluate(() => document.querySelector('.ed-props [role=tab][aria-selected="true"]')?.textContent?.trim())
  const exportLast = () => p.evaluate(() => {
    const hs = [...document.querySelectorAll('.ed-props .ed-section')].filter((h) => h.offsetParent !== null)
    return hs.at(-1)?.dataset.key
  })
  const download = async (label) => {
    // the first setting row set to this label's scale and format, then Export (Figma's section)
    const [fmt, scale] = label === 'SVG' ? ['svg', '1'] : label === 'JPG' ? ['jpeg', '1'] : ['png', label === 'PNG 2×' ? '2' : '1']
    await p.selectOption('.ed-props .ed-export-row >> nth=0 >> select[aria-label="Format"]', fmt); await p.waitForTimeout(150)
    if (fmt !== 'svg') { await p.selectOption('.ed-props .ed-export-row >> nth=0 >> select[aria-label="Scale"]', scale); await p.waitForTimeout(150) }
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.ed-props .ed-export-rows .ed-export-btn')])
    return { name: dl.suggestedFilename(), buf: readFileSync(await dl.path()) }
  }
  const select = async (id) => {
    const b = await p.locator(`.ed-stage-scale [data-el-id="${id}"]`).boundingBox()
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await p.waitForTimeout(250)
  }

  console.log('\nthe slide\n')
  await p.keyboard.press('Escape'); await p.waitForTimeout(150)
  ok(await exportLast() === 'Export', `Export is the last section on the ${await formatTab()} tab`)
  const s2 = await download('PNG 2×')
  const [w2, h2] = pngSize(s2.buf)
  ok(w2 === size.width * 2 && h2 === size.height * 2, `PNG 2× is the slide at 2× (${w2}×${h2}, ${s2.name})`)

  console.log('\none element\n')
  await select('a')
  ok(await exportLast() === 'Export', 'Export closes the element\'s Format tab too')
  const e1 = await download('PNG 1×')
  ok(pngSize(e1.buf).join('×') === '200×100', `PNG 1× is the element's box (${pngSize(e1.buf).join('×')})`)
  const red = await p.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const g = c.getContext('2d'); g.drawImage(img, 0, 0)
    return [...g.getImageData(3, 3, 1, 1).data]
  }, e1.buf.toString('base64'))
  ok(red[0] > 200 && red[1] < 60 && red[2] < 60 && red[3] > 200, `its corner is the element's red (${red.join(',')})`)
  const svg = await download('SVG')
  const text = svg.buf.toString('utf8')
  ok(svg.name.endsWith('.svg') && /viewBox="100 100 200 100"/.test(text), `SVG frames the same box (${(text.match(/viewBox="[^"]+"/) ?? ['none'])[0]})`)

  console.log('\na rotated element\n')
  await select('b')
  const r1 = await download('PNG 1×')
  const [rw, rh] = pngSize(r1.buf)
  ok(Math.abs(rw - 142) <= 2 && Math.abs(rh - 142) <= 2, `a 100px square at 45° exports its 142px cover box (${rw}×${rh})`)

  console.log('\ncopy as JSON\n')
  await select('a')
  // Copy as JSON lives in a setting row's ⋯ menu, as Figma keeps its extras
  await p.click('.ed-props .ed-export-row >> nth=0 >> button[aria-haspopup="menu"]'); await p.waitForTimeout(150)
  await p.click('.ed-ctxmenu-item:has-text("Copy as JSON")'); await p.waitForTimeout(250)
  const clip = JSON.parse(await p.evaluate(() => navigator.clipboard.readText()))
  ok(clip.__bento === 'clip' && clip.kind === 'elements' && clip.elements?.length === 1 && clip.elements[0].id === 'a', `the clipboard holds ⌘C's payload for the selection (${clip.kind}, ${clip.elements?.length})`)
  console.log('\nFigma\'s Export, fixed\n')
  const fixed = await p.evaluate(() => {
    const head = document.querySelector('.ed-props .ed-section[data-key="Export"]')
    const rows = [...document.querySelectorAll('.ed-props .ed-export-row')]
    const r = rows[0]; const go = document.querySelector('.ed-props .ed-export-rows .ed-export-btn')
    const [s1, s2] = r?.querySelectorAll('select') ?? []
    return {
      act: !!head?.querySelector('.ed-sec-act'), rows: rows.length, kids: r?.children.length,
      minus: !!r?.querySelector('button[title*="Remove"], button[aria-label*="Remove"]'),
      eq: !!s1 && !!s2 && Math.abs(s1.getBoundingClientRect().width - s2.getBoundingClientRect().width) < 1,
      full: !!go && !!r && Math.abs(go.getBoundingClientRect().width - r.getBoundingClientRect().width) < 1,
      named: /Export/.test(go?.textContent ?? ''),
    }
  })
  ok(!fixed.act, 'the Export header has no + — only its fold')
  ok(fixed.rows === 1 && fixed.kids === 3 && !fixed.minus, `one fixed row: scale · format · ⋯, no − (${fixed.rows} row, ${fixed.kids} controls)`)
  ok(fixed.eq && fixed.full && fixed.named, 'scale and format share the row; one full-width button, named for the selection, exports it')
  await p.selectOption('.ed-props .ed-export-row select[aria-label="Format"]', 'svg'); await p.waitForTimeout(150)
  ok(await p.$eval('.ed-props .ed-export-row select[aria-label="Scale"]', (x) => x.disabled), 'an SVG has no scale to pick')
  await p.selectOption('.ed-props .ed-export-row select[aria-label="Format"]', 'png'); await p.waitForTimeout(150)

  console.log('\nframes and multi-selections\n')
  const words = (id, x, y, extra = {}) => ({ id, type: 'text', x, y, w: 160, h: 40, rotation: 0, opacity: 1, html: 'Hello', fontSize: 24, fontFamily: 'Inter', fontWeight: 400, color: '#111111', ...extra })
  await p.evaluate((els) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', notes: '', transition: 'none', elements: els }]
    window.bento.loadDoc(JSON.stringify(d))
  }, [
    rect('row', 100, 100, 464, 132, { fill: 'transparent', layout: { dir: 'row', gap: 16, pad: [16, 16, 16, 16] } }),
    rect('c1', 116, 116, 200, 100, { fill: '#00aa00', parentId: 'row', layout: { dir: 'column', gap: 8, pad: [16, 16, 16, 16] } }),
    words('t1', 132, 132, { parentId: 'c1' }),
    rect('c2', 332, 116, 200, 100, { fill: '#00aa00', parentId: 'row', layout: { dir: 'column', gap: 8, pad: [16, 16, 16, 16] } }),
    words('t2', 348, 132, { parentId: 'c2' }),
    // ids sort the texts before the rect; the slide paints the rect first
    rect('z', 700, 400, 300, 120, { fill: '#0000ff' }),
    words('a1', 720, 410), words('a2', 720, 460),
  ])
  await p.waitForTimeout(400)
  const pick = async (...ids) => {
    await p.keyboard.press('Escape'); await p.waitForTimeout(100)
    await p.evaluate((ids) => ids.forEach((id, i) => document.querySelector(`.ed-layer[data-id="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: i > 0 }))), ids)
    await p.waitForTimeout(250)
  }
  const order = (svg) => [...svg.matchAll(/data-el-id="([^"]+)"/g)].map((m) => m[1])
  await pick('a2', 'a1', 'z')
  const multi = order((await download('SVG')).buf.toString('utf8'))
  ok(multi.join() === 'z,a1,a2', `a multi-selection exports in the slide's paint order, not the selection's (${multi.join()})`)

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
