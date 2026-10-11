// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Ghost Cut (⇧⌘X / Ctrl+Shift+X) in the packaged editor, with real input.
//
//   npm run build:single --prefix slides && node scripts/test-slides-ghost-cut-browser.mjs
//
// WHAT THIS PROVES (#679):
//   1. ⇧⌘X fades the selection where it stands (CSS filter: opacity(.35)) —
//      including an element with a shadow, whose own inline `filter` would
//      otherwise win — and copies it to the system clipboard;
//   2. a ghost cannot be selected: not by clicking it, not by a marquee;
//   3. Esc puts it back exactly as it was, with no edit made;
//   4. paste MOVES it to the pointer: the same element (same id, still one
//      copy), in one undo step;
//   5. pasted on another slide it leaves the first, and if that slide already
//      has the id (slides share ids for morph) it takes a fresh one rather
//      than making two elements with one id on a slide.
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
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))

  // A deck of our own: slide 1 holds a shadowed box and a plain box; slide 2
  // already holds an element with the plain box's id (the morph idiom).
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    const box = (id, x, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y: 200, w: 160, h: 120, rotation: 0, opacity: 1, fill: '#5E7699', ...extra })
    d.slides = [
      { id: 's1', background: '#ffffff', elements: [box('plain', 160), box('shadowed', 520, { shadow: { x: 0, y: 6, blur: 12, color: 'rgba(0,0,0,.4)' } })] },
      { id: 's2', background: '#ffffff', elements: [box('plain', 900)] },
      { id: 's3', background: '#ffffff', elements: [] },
    ]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)

  const node = (id) => p.locator(`.ed-stage-scale [data-el-id="${id}"]`)
  const clickEl = async (id, mod = false) => {
    const b = await node(id).boundingBox()
    if (mod) await p.keyboard.down('Shift')
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
    if (mod) await p.keyboard.up('Shift')
    await p.waitForTimeout(150)
  }
  const state = () => p.evaluate(() => ({
    slides: window.bento.doc.slides.map((s) => s.elements.map((e) => `${e.id}@${e.x},${e.y}`)),
  }))
  const selected = () => p.evaluate(() => window.bento.selection)
  const ghostCut = async () => { await p.keyboard.press(`${MOD}+Shift+x`); await p.waitForTimeout(200) }
  const paste = async () => {
    const before = JSON.stringify((await state()).slides)
    await p.keyboard.press(`${MOD}+v`)
    await p.waitForTimeout(250)
    if (JSON.stringify((await state()).slides) !== before) return 'keyboard'
    await p.evaluate(() => document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: new DataTransfer() })))
    await p.waitForTimeout(250)
    return 'event'
  }
  const isGhost = (id) => p.evaluate((i) => {
    const n = document.querySelector(`.ed-stage-scale [data-el-id="${i}"]`)
    return { cls: !!n?.classList.contains('bento-el-ghost-cut'), filter: n ? getComputedStyle(n).filter : '' }
  }, id)

  console.log('\n⇧⌘X fades and copies\n')
  await clickEl('plain')
  await clickEl('shadowed', true)
  await p.evaluate(() => { window.__clips.length = 0 })
  const before = await state()
  await ghostCut()
  const gp = await isGhost('plain'), gs = await isGhost('shadowed')
  ok(gp.cls && gs.cls, 'both selected elements are ghosts')
  ok(/opacity\(0\.35\)/.test(gp.filter) && /opacity\(0\.35\)/.test(gs.filter), `faded by CSS — the shadowed one too (${gs.filter})`)
  const clip = await p.evaluate(() => window.__clips.at(-1) ?? '')
  ok(/"__bento":"clip"/.test(clip) && clip.includes('"plain"') && clip.includes('"shadowed"'), 'and copied to the system clipboard as a Bento payload')
  ok(JSON.stringify((await state()).slides) === JSON.stringify(before.slides), 'nothing in the deck changed yet')

  console.log('\na ghost cannot be selected\n')
  ok((await selected()).length === 0, 'cutting clears the selection')
  await clickEl('plain')
  const selIds = await selected()
  ok(!selIds.includes('plain'), `clicking a ghost does not select it (${selIds.join(',') || 'nothing selected'})`)
  // and the pointer goes straight through it: no double-click into its text,
  // no grabbing it — what is under the pointer is whatever lies beneath
  const through = await p.evaluate(() => {
    const n = document.querySelector('.ed-stage-scale [data-el-id="plain"]')
    const r = n.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !n.contains(hit)
  })
  ok(through, 'the pointer passes through a ghost')
  const st = await p.locator('.ed-stage-scale').boundingBox()
  await p.mouse.move(st.x + 4, st.y + 4)
  await p.mouse.down()
  await p.mouse.move(st.x + st.width - 4, st.y + st.height - 4, { steps: 8 })
  await p.mouse.up()
  await p.waitForTimeout(200)
  const afterMarquee = await selected()
  ok(!afterMarquee.includes('plain') && !afterMarquee.includes('shadowed'), `a marquee across the whole slide picks up no ghost (${afterMarquee.join(',') || 'nothing'})`)

  console.log('\nEsc puts it back\n')
  await p.keyboard.press('Escape')
  await p.waitForTimeout(200)
  const ge = await isGhost('plain')
  ok(!ge.cls && !/opacity\(0\.35\)/.test(ge.filter), 'the fade is gone')
  ok(JSON.stringify((await state()).slides) === JSON.stringify(before.slides), 'and the deck is exactly as it was')

  console.log('\npaste moves it, in one undo step\n')
  await clickEl('plain')
  await ghostCut()
  const st2 = await p.locator('.ed-stage-scale').boundingBox()
  const scale = await p.evaluate(() => { const s = document.querySelector('.ed-stage-scale'); return s.getBoundingClientRect().width / window.bento.doc.size.width })
  await p.mouse.move(st2.x + 700 * scale, st2.y + 450 * scale)
  const how = await paste()
  const moved = await state()
  const s1 = moved.slides[0]
  ok(s1.filter((x) => x.startsWith('plain@')).length === 1, `still one "plain" on the slide (${s1.join(' ')})`)
  const pos = s1.find((x) => x.startsWith('plain@'))?.split('@')[1].split(',').map(Number)
  ok(pos && Math.abs(pos[0] - 700) <= 2 && Math.abs(pos[1] - 450) <= 2, `moved to the pointer (${pos}) [${how} paste]`)
  ok(!(await isGhost('plain')).cls, 'and is no longer a ghost')
  await p.keyboard.press('Escape')
  await p.keyboard.press(`${MOD}+z`)
  await p.waitForTimeout(250)
  ok(JSON.stringify((await state()).slides) === JSON.stringify(before.slides), 'one ⌘Z puts it back where it was')

  console.log('\npaste on another slide\n')
  await clickEl('plain')
  await ghostCut()
  const thumb = async (i) => { const b = await p.locator(`.ed-sidebar .ed-thumb[data-index="${i}"]`).boundingBox(); await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await p.waitForTimeout(250) }
  await thumb(2)
  await p.mouse.move(st2.x + 100 * scale, st2.y + 100 * scale)
  await paste()
  let x = await state()
  ok(!x.slides[0].some((e) => e.startsWith('plain@')) && x.slides[2].some((e) => e.startsWith('plain@')),
    `it leaves slide 1 and lands on slide 3, keeping its id (${x.slides[2].join(' ')})`)
  await p.keyboard.press('Escape')
  await p.keyboard.press(`${MOD}+z`)
  await p.waitForTimeout(250)
  await thumb(0)
  await clickEl('plain')
  await ghostCut()
  await thumb(1)
  await p.mouse.move(st2.x + 100 * scale, st2.y + 100 * scale)
  await paste()
  x = await state()
  const ids2 = x.slides[1].map((e) => e.split('@')[0])
  ok(ids2.length === 2 && new Set(ids2).size === 2 && ids2.includes('plain'),
    `onto a slide that already has its id: two elements, two ids (${ids2.join(', ')})`)

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
