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
//      click places it where clicked; with an auto-layout frame selected a
//      click in it puts the new element inside, held to the room a fixed
//      frame has left (a hugging one grows), a drag in it sizes the child,
//      a click outside places on the slide; F's frame is called a Frame.
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
  await load([text('t', 200, 100, 600, 80, 'Hello')])
  await deselect()
  await p.mouse.click(...(await centre('t'))); await p.waitForTimeout(250)
  const leftOpen = () => p.evaluate(() => { const s = document.querySelector('.ed-sidebar'); return !!s && s.getBoundingClientRect().width > 0 })
  const wasOpen = await leftOpen()
  await p.keyboard.press('['); await p.waitForTimeout(300)
  ok((await leftOpen()) !== wasOpen && (await els())[0].html === 'Hello', '[ on a selected text box toggles the slide list, and types no bracket')
  await p.keyboard.press('['); await p.waitForTimeout(300)

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

  console.log('\n4. selection: outermost first, double-click in, Esc out\n')
  await load(card()); await deselect()
  await p.mouse.click(...(await centre('c1'))); await p.waitForTimeout(250)
  ok((await selection()).join() === 'f', `a click on a card's child picks the card (${(await selection()).join()})`)
  await p.mouse.dblclick(...(await centre('c1'))); await p.waitForTimeout(250)
  ok((await selection()).join() === 'c1', `a double-click goes in to the child (${(await selection()).join()})`)
  await p.mouse.click(...(await centre('c2'))); await p.waitForTimeout(250)
  ok((await selection()).join() === 'c2', `inside, a click picks a sibling (${(await selection()).join()})`)
  await p.keyboard.press('Escape'); await p.waitForTimeout(200)
  ok((await selection()).join() === 'f', `Esc steps out to the frame (${(await selection()).join()})`)
  await p.keyboard.press('Escape'); await p.waitForTimeout(200)
  ok((await selection()).length === 0, 'a second Esc deselects')
  const fx0 = (await el('f')).x
  const fromC2 = await centre('c2')
  await drag(fromC2, [fromC2[0] + 100, fromC2[1]])
  all = await els()
  ok(all.find((e) => e.id === 'f').x > fx0 + 40 && all.find((e) => e.id === 'c1').parentId === 'f', `press-and-drag on a child moves the whole card (frame x ${fx0} → ${all.find((e) => e.id === 'f').x})`)
  await load(card()); await deselect()
  {
    const fb = await node('f').boundingBox()
    await drag([fb.x - 30, fb.y - 30], [fb.x + fb.width + 30, fb.y + fb.height + 30])
    ok((await selection()).join() === 'f', `a marquee over a card picks the card, not its contents (${(await selection()).join()})`)
  }
  await load(card()); await deselect(); await pick('f'); await pick('c1', true)
  await p.keyboard.press('Shift+A'); await p.waitForTimeout(300)
  all = await els()
  const outer = all.find((e) => e.layout && e.id !== 'f')
  ok(!!outer && all.find((e) => e.id === 'f').parentId === outer.id && all.find((e) => e.id === 'c1').parentId === 'f', '⇧A over a card and its own child wraps the card and leaves the child in it')
  await load([rect('r1', 100, 300, 100, 100), rect('r2', 260, 300, 100, 100), rect('r3', 420, 300, 100, 100)]); await deselect()
  await pick('r1'); await pick('r2', true); await pick('r3', true)
  await p.keyboard.press('Shift+A'); await p.waitForTimeout(300)
  const row = (await els()).find((e) => e.layout)
  ok(row?.layout.dir === 'row' && row?.layout.gap === 60, `⇧A keeps the spacing the elements had (${row?.layout.dir} gap ${row?.layout.gap}, expected row 60)`)

  console.log('\n5. the tools draw\n')
  // slide px → client px
  const toClient = async (x, y) => p.evaluate(([x, y]) => { const r = document.querySelector('.ed-stage-scale').getBoundingClientRect(); const k = r.width / window.bento.doc.size.width; return [r.left + x * k, r.top + y * k] }, [x, y])
  await load([]); await deselect()
  await p.keyboard.press('r'); await p.waitForTimeout(150)
  ok((await els()).length === 0, 'R arms the rectangle tool; nothing lands until the slide is pressed')
  await drag(await toClient(200, 150), await toClient(500, 350))
  let drawn = (await els())[0]
  ok(drawn?.type === 'shape' && Math.abs(drawn.w - 300) < 6 && Math.abs(drawn.h - 200) < 6 && Math.abs(drawn.x - 200) < 6, `a drag draws it at the dragged size (${drawn && [drawn.x, drawn.y, drawn.w, drawn.h].join(',')})`)
  await deselect()
  await p.keyboard.press('o'); await p.waitForTimeout(150)
  await p.mouse.click(...(await toClient(800, 300))); await p.waitForTimeout(300)
  drawn = (await els()).find((e) => e.shape === 'ellipse')
  ok(!!drawn && Math.abs(drawn.x + drawn.w / 2 - 800) < 6 && Math.abs(drawn.y + drawn.h / 2 - 300) < 6, `a click drops the default centred on the click (${drawn && [drawn.x + drawn.w / 2, drawn.y + drawn.h / 2].join(',')})`)
  await deselect()
  await p.keyboard.press('r'); await p.waitForTimeout(100); await p.keyboard.press('Escape'); await p.waitForTimeout(100)
  await p.mouse.click(...(await toClient(600, 600))); await p.waitForTimeout(200)
  ok((await els()).length === 2, 'Esc stands an armed tool down')
  {
    // a selected frame: a gesture inside it puts the new element in it, sized to fit
    const inner = (all, fid) => { const f = all.find((e) => e.id === fid); const [t, r, b, l] = f.layout.pad; return { x0: f.x + l, y0: f.y + t, x1: f.x + f.w - r, y1: f.y + f.h - b } }
    // a text box's height follows its words, so for text only the width is held
    const fits = (all, fid, across = false) => { const i = inner(all, fid); return kidsOf(all, fid).every((k) => k.x >= i.x0 - 0.5 && k.x + k.w <= i.x1 + 0.5 && (across || (k.y >= i.y0 - 0.5 && k.y + k.h <= i.y1 + 0.5))) }
    const fb = card()[0]
    await load(card()); await deselect(); await pick('f')
    await p.keyboard.press('t'); await p.waitForTimeout(150)
    await p.mouse.click(...(await toClient(fb.x + fb.w - 20, fb.y + fb.h / 2))); await p.waitForTimeout(300)
    await p.keyboard.press('Escape'); await p.waitForTimeout(150)
    all = await els()
    ok(all.length === 4 && all.at(-1).type === 'text' && all.at(-1).parentId === 'f', 'T with an auto-layout frame selected, then a click in it, puts the text inside it')
    ok(fits(all, 'f', true), `…its width held to the room the fixed row has left: nothing passes the frame's edge (${kidsOf(all, "f").map((k) => `${k.id} ${k.x}+${k.w} ${k.y}+${k.h}`).join(', ')}; inner to ${inner(all, 'f').x1})`)
    await load(card()); await deselect(); await pick('f')
    await p.keyboard.press('r'); await p.waitForTimeout(150)
    await p.mouse.click(...(await toClient(fb.x + fb.w - 20, fb.y + fb.h / 2))); await p.waitForTimeout(300)
    all = await els()
    const r1 = all.at(-1)
    ok(r1?.parentId === 'f' && fits(all, 'f') && r1.h <= 100, `R + a click in a fixed card: the default rectangle is clamped to its inner box (${r1 && [r1.w, r1.h].join('×')})`)
    await load([frame('c', 100, 100, 300, 300, { dir: 'col', gap: 10 }), rect('ck', 110, 110, 280, 200, { parentId: 'c' })]); await deselect(); await pick('c')
    await p.keyboard.press('o'); await p.waitForTimeout(150)
    await p.mouse.click(...(await toClient(250, 360))); await p.waitForTimeout(300)
    all = await els()
    const o1 = all.at(-1)
    ok(o1?.parentId === 'c' && o1.w === 280 && o1.h === 70 && fits(all, 'c') && all.find((e) => e.id === 'ck').y === 110, `O + a click in a fixed column: the default is held to the free height and the inner width (${o1 && [o1.w, o1.h].join('×')})`)
    await load([frame('w', 100, 100, 900, 300)]); await deselect(); await pick('w')
    await p.keyboard.press('r'); await p.waitForTimeout(150)
    await drag(await toClient(300, 150), await toClient(380, 210))
    all = await els()
    const r2 = all.at(-1)
    ok(r2?.parentId === 'w' && Math.abs(r2.w - 80) < 4 && Math.abs(r2.h - 60) < 4, `R + a drag in the selected frame draws the child at the dragged size (${r2 && [r2.w, r2.h].join('×')})`)
    await load([frame('h', 100, 100, 120, 80, { hug: true })]); await deselect(); await pick('h')
    await p.keyboard.press('r'); await p.waitForTimeout(150)
    await p.mouse.click(...(await toClient(150, 130))); await p.waitForTimeout(300)
    all = await els()
    const r3 = all.at(-1)
    ok(r3?.parentId === 'h' && r3.w === 300 && r3.h === 200 && all[0].w === 320, `R + a click in a hugging frame: the stock default, and the frame grows round it (${r3 && [r3.w, r3.h].join('×')}, frame ${all[0].w})`)
    await load([frame('o', 100, 100, 300, 200)]); await deselect(); await pick('o')
    await p.keyboard.press('r'); await p.waitForTimeout(150)
    await p.mouse.click(...(await toClient(900, 500))); await p.waitForTimeout(300)
    all = await els()
    const r4 = all.at(-1)
    ok(r4 && !r4.parentId && Math.abs(r4.x + r4.w / 2 - 900) < 6, `a click outside the selected frame places on the slide as usual (${r4?.parentId ?? 'top level'})`)
  }
  await load([]); await deselect()
  await p.keyboard.press('f'); await p.waitForTimeout(100)
  await p.mouse.click(...(await toClient(400, 300))); await p.waitForTimeout(300)
  const fr = (await els())[0]
  ok(!!fr?.layout, 'F then a click puts down a frame')
  ok((await p.textContent('.ed-props .ed-context-name'))?.trim() === 'Frame', `the inspector calls it a Frame (${(await p.textContent('.ed-props .ed-context-name'))?.trim()})`)
  ok((await p.$$eval('.ed-layer .ed-layer-label', (n) => n.map((x) => x.textContent))).includes('Frame'), 'so does Layers')

  console.log('\n6. Layers rows can be told apart\n')
  await load([rect('k1', 100, 100, 100, 100), rect('k2', 300, 100, 100, 100, { fill: '#00ff00' }), rect('k3', 500, 100, 100, 100, { fill: '#0000ff' }), text('k4', 100, 400, 600, 80, 'Quarterly revenue')])
  const labels = await p.$$eval('.ed-layer .ed-layer-label', (n) => n.map((x) => x.textContent))
  ok(new Set(labels).size === labels.length, `every row reads differently (${labels.join(' · ')})`)
  ok(labels.some((l) => /Quarterly revenue/.test(l)), 'a text row shows its words')

  console.log('\n7. chrome: a narrow topbar, and toasts clear of the notes\n')
  await deselect()
  await p.keyboard.press('Meta+c'); await p.waitForTimeout(400) // nothing selected: "Slide copied"
  const clash = await p.evaluate(() => {
    const t = document.querySelector('.ed-toast')?.getBoundingClientRect(), n = document.querySelector('.ed-notespane')?.getBoundingClientRect()
    return !t || !n ? 'missing' : t.bottom > n.top + 1 ? `toast ${Math.round(t.top)}–${Math.round(t.bottom)} over notes from ${Math.round(n.top)}` : ''
  })
  ok(clash === '', `a toast sits above the speaker-notes pane (${clash || 'clear'})`)
  await p.setViewportSize({ width: 768, height: 900 }); await p.waitForTimeout(500)
  const overlaps = await p.evaluate(() => {
    const bs = [...document.querySelectorAll('.ed-topbar button')].filter((b) => !b.closest('.ed-menu')).map((b) => [b.dataset.cmd || b.getAttribute('aria-label') || '', b.getBoundingClientRect()]).filter(([, r]) => r.width > 0)
    const out = []
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) { const [a, r] = bs[i], [b, q] = bs[j]; if (r.left < q.right - 1 && q.left < r.right - 1 && r.top < q.bottom - 1 && q.top < r.bottom - 1) out.push(`${a}×${b}`) }
    return out
  })
  ok(!overlaps.length, `at 768px no topbar button sits on another (${overlaps.join(', ') || 'none'})`)

  console.log(`\n${checks - failures}/${checks} checks passed`)
} finally {
  await browser.close()
}
process.exit(failures ? 1 : 0)
