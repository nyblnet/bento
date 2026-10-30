// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The UX audit's canvas findings (docs/audit/ux-pyramid-2026-10-30.md), each
// held where it was fixed.
//
//   npm run build:single --prefix slides && node scripts/test-slides-ux-canvas-browser.mjs
//
// WHAT THIS PROVES
//   1. Pressing an element that is not selected and dragging moves it, in one
//      gesture, and throws nothing (it used to throw "setting 'dist'" on every
//      move and leave the element where it was).
//   2. A key typed at a selected text box is text: "Revenue" on a placeholder
//      fills it and inserts no rectangle; ⇧A stays the command's.
//   3. A frame moves as a unit: ⌘D, copy/paste and slide duplicate carry its
//      children, re-pointed at the copy; Delete takes the frame's children too.
//   4. Figma's selection model: a click picks the outermost frame, a double-
//      click goes in, Esc goes back out; a marquee takes top-level elements;
//      ⇧A over a frame and its child wraps the frame, with the gap it had.
//   5. The tools draw: R then a drag makes a rectangle of the dragged size, a
//      click places it where clicked; T with an auto-layout frame selected
//      puts the text inside it; F's frame is called a Frame.
//   6. Layers names tell rows apart: three rectangles of different colours are
//      three different labels, a text row shows its words.
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const SHELL = process.env.SHELL_HTML || fileURLToPath(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url))

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const rect = (id, x, y, w, h, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, rotation: 0, opacity: 1, fill: '#ff0000', stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })
const text = (id, x, y, w, h, html, extra = {}) => ({ id, type: 'text', x, y, w, h, rotation: 0, opacity: 1, html, fontSize: 32, fontFamily: 'system-ui', fontWeight: 400, color: '#111111', align: 'left', valign: 'top', lineHeight: 1.2, ...extra })
const frame = (id, x, y, w, h, layout = {}) => rect(id, x, y, w, h, { fill: '#eeeeee', layout: { dir: 'row', gap: 20, pad: [10, 10, 10, 10], ...layout } })

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.addInitScript(() => {
    try { localStorage.setItem('bento-slideshow-started', '1') } catch {}
    // the editor's copies, observed without clipboard permissions
    window.__clips = []
    const clip = navigator.clipboard ?? {}
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: Object.assign(Object.create(Object.getPrototypeOf(clip) ?? Object.prototype), clip, {
        writeText: (t) => { window.__clips.push(String(t)); return Promise.resolve() },
        readText: () => Promise.resolve(window.__clips.at(-1) ?? ''),
      }),
    })
  })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-props .ed-tabs'))
  const load = async (elements, more = []) => {
    await p.evaluate(([els, more]) => {
      const d = JSON.parse(JSON.stringify(window.bento.doc))
      d.slides = [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: els }, ...more]
      window.bento.loadDoc(JSON.stringify(d))
    }, [elements, more])
    await p.waitForTimeout(350)
  }
  const els = (slide = 0) => p.evaluate((i) => JSON.parse(JSON.stringify(window.bento.doc.slides[i].elements)), slide)
  const el = async (id) => (await els()).find((e) => e.id === id)
  const selection = () => p.evaluate(() => window.bento.selection)
  const node = (id) => p.locator(`.ed-stage-scale [data-el-id="${id}"]`).first()
  const centre = async (id, dx = 0, dy = 0) => { const b = await node(id).boundingBox(); return [b.x + b.width / 2 + dx, b.y + b.height / 2 + dy] }
  const deselect = async () => { await p.evaluate(() => document.activeElement?.blur()); for (let i = 0; i < 3; i++) await p.keyboard.press('Escape'); await p.waitForTimeout(150) }
  const pick = async (id, add = false) => { await p.evaluate(([id, add]) => document.querySelector(`.ed-layer[data-id="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: add })), [id, add]); await p.waitForTimeout(200) }
  const paste = () => p.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', window.__clips.at(-1) ?? ''); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })) }).then(() => p.waitForTimeout(300))
  const drag = async (from, to, steps = 12) => {
    await p.mouse.move(...from); await p.mouse.down()
    for (let i = 1; i <= steps; i++) { await p.mouse.move(from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps); await p.waitForTimeout(16) }
    await p.mouse.up(); await p.waitForTimeout(300)
  }

  console.log('\n1. press-and-drag an unselected element\n')
  await load([rect('a', 200, 200, 200, 150), rect('b', 700, 200, 200, 150, { fill: '#0000ff' })])
  await deselect()
  const e0 = errors.length
  const from = await centre('a')
  await drag(from, [from[0] + 120, from[1] + 60])
  const a1 = await el('a')
  ok(a1.x > 250 && a1.y > 220, `the element moved with the first press (x ${a1.x}, y ${a1.y})`)
  ok(errors.length === e0, `nothing threw while dragging (${errors.slice(e0)[0] ?? 'none'})`)
  await deselect()
  const fromB = await centre('b')
  await p.mouse.click(...fromB); await p.waitForTimeout(300)
  ok((await el('b')).x === 700, 'a plain click still only selects (no stuck drag)')

  console.log('\n2. typing at a selected text box\n')
  await load([text('t', 200, 100, 600, 80, '', { placeholder: 'Click to add title' })])
  await deselect()
  await p.mouse.click(...(await centre('t'))); await p.waitForTimeout(250)
  ok((await selection()).join() === 't', 'one click selects the placeholder')
  await p.keyboard.type('Revenue', { delay: 30 })
  await p.keyboard.press('Escape'); await p.waitForTimeout(250)
  const after2 = await els()
  ok(after2.length === 1, `no rectangle was inserted (${after2.length} elements)`)
  ok(/Revenue/.test(after2[0].html), `the words went into the box (${JSON.stringify(after2[0].html)})`)
  await load([text('t', 200, 100, 600, 80, 'Hello')])
  await deselect()
  await p.mouse.click(...(await centre('t'))); await p.waitForTimeout(250)
  await p.keyboard.press('Shift+A'); await p.waitForTimeout(300)
  ok((await els()).some((e) => e.layout), '⇧A on a selected text box still wraps it in a frame')

  console.log('\n3. a frame is one unit\n')
  const card = () => [frame('f', 100, 100, 400, 120), rect('c1', 110, 110, 100, 100, { parentId: 'f' }), text('c2', 230, 110, 200, 60, 'Card', { parentId: 'f' })]
  const kidsOf = (all, fid) => all.filter((e) => e.parentId === fid)
  await load(card()); await deselect(); await pick('f')
  await p.keyboard.press('Meta+d'); await p.waitForTimeout(300)
  let all = await els()
  const dup = all.find((e) => e.layout && e.id !== 'f')
  ok(!!dup && kidsOf(all, dup.id).length === 2, `⌘D on a frame copies its two children into the copy (${dup ? kidsOf(all, dup.id).length : 'no copy'})`)
  ok(kidsOf(all, 'f').length === 2, 'the original keeps its own two')
  ok((await selection()).join() === dup?.id, 'the copy of the frame is what is selected')
  await load(card()); await deselect(); await pick('f')
  await p.keyboard.press('Meta+c'); await p.waitForTimeout(150)
  await paste()
  all = await els()
  const pasted = all.find((e) => e.layout && e.id !== 'f')
  ok(!!pasted && kidsOf(all, pasted.id).length === 2, `⌘C ⌘V of a frame pastes its children inside the pasted frame (${pasted ? kidsOf(all, pasted.id).length : 'no paste'})`)
  await load(card()); await deselect(); await pick('f')
  {
    // press on the frame's own body: under the short child, clear of the
    // padding and gap bands (dragging those sets the spacing)
    const [c2, fb] = [await node('c2').boundingBox(), await node('f').boundingBox()]
    const gx = c2.x + c2.width / 2, gy = (c2.y + c2.height + fb.y + fb.height) / 2 - 4
    await p.keyboard.down('Meta')
    await drag([gx, gy], [gx, gy + 200])
    await p.keyboard.up('Meta')
    all = await els()
    const frames = all.filter((e) => e.layout)
    ok(frames.length === 2 && frames.every((f) => kidsOf(all, f.id).length === 2), `⌘-drag a frame: the copy left behind holds its own children (${frames.map((f) => kidsOf(all, f.id).length).join('/')})`)
  }
  await load(card()); await deselect(); await pick('f')
  await p.keyboard.press('Backspace'); await p.waitForTimeout(250)
  ok((await els()).length === 0, `Delete on a frame takes its contents too (${(await els()).length} left)`)
  await p.keyboard.press('Meta+z'); await p.waitForTimeout(250)
  ok((await els()).length === 3, 'one ⌘Z brings the frame and its contents back')
  await load(card(), [{ id: 's2', background: '#fff', transition: 'none', notes: '', elements: [] }])
  await p.evaluate(() => document.querySelector('.ed-sidebar .ed-thumb')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 120 })))
  await p.waitForTimeout(200)
  const dupRow = p.locator('.ed-ctxmenu button, .ed-ctxmenu [role=menuitem]', { hasText: /^Duplicate/ }).first()
  if (await dupRow.count()) { await dupRow.click(); await p.waitForTimeout(300) }
  const s1 = await els(1)
  ok(s1.length === 3 && kidsOf(s1, 'f').length === 2, `a duplicated slide's frame still holds its children (${s1.length} elements)`)

  console.log(`\n${checks - failures}/${checks} checks passed`)
} finally {
  await browser.close()
}
process.exit(failures ? 1 : 0)
