// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Numeric fields: arithmetic, arrow keys, the locked scrub, and Mixed values on a multi-selection.
//
//   npm run build:single --prefix slides && node scripts/test-slides-inspector-scrub-browser.mjs
//
// WHAT THIS PROVES, in the built shell:
//   1. a numeric field is a spinbutton text field that takes arithmetic:
//      `360/2` sets 180, `+24` adds to the value, junk restores the value and
//      edits nothing; ↑/↓ step (Shift ×10); each is ONE undo step;
//   2. a scrub asks for the pointer lock once past its dead zone (Figma's
//      unbounded drag) and still works when the lock is refused — the rig
//      reports which path this browser took — and releases the lock;
//   3. two elements with different X show "Mixed"; a scrub moves EACH by the
//      same delta from its own value, typed `+10` too, and a plain typed
//      value sets them all — one undo step each; equal values show the value.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const ELS = [
  { id: 'a', type: 'shape', shape: 'rect', x: 100, y: 100, w: 200, h: 100, fill: '#ff0000', stroke: 'transparent', strokeWidth: 0, radius: 0 },
  { id: 'b', type: 'shape', shape: 'rect', x: 400, y: 100, w: 200, h: 100, fill: '#00ff00', stroke: 'transparent', strokeWidth: 0, radius: 0 },
].map((e) => ({ rotation: 0, opacity: 1, ...e }))

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1') } catch {} })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-props .ed-tabs'))
  await p.evaluate((els) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', elements: els }]
    window.bento.loadDoc(JSON.stringify(d))
  }, ELS)
  await p.waitForTimeout(300)
  const el = (id) => p.evaluate((id) => JSON.parse(JSON.stringify(window.bento.doc.slides[0].elements.find((e) => e.id === id))), id)
  const select = async (id, add = false) => {
    // the Layers view may be folded behind Slides: its rows take a click all the same
    await p.evaluate(([id, add]) => document.querySelector(`.ed-layer[data-id="${id}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: add })), [id, add])
    await p.waitForTimeout(200)
  }
  const field = (label) => p.locator('.ed-props .ed-layer-block .ed-mini', { has: p.locator(':scope > span', { hasText: new RegExp(`^${label}$`) }) }).first()
  const type = async (label, text) => {
    const i = field(label).locator('input')
    await i.fill(text); await i.press('Enter'); await p.evaluate(() => document.activeElement?.blur()); await p.waitForTimeout(200)
  }
  const undo = async () => { await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(200) }

  console.log('\n1. arithmetic and arrows\n')
  await select('a')
  const xi = field('X').locator('input')
  ok(await xi.evaluate((i) => i.type === 'text' && i.inputMode === 'decimal' && i.getAttribute('role') === 'spinbutton' && i.classList.contains('ed-num')),
    'X is a spinbutton text field (it takes arithmetic)')
  ok(await xi.getAttribute('aria-valuenow') === '100', 'it carries aria-valuenow')
  await type('X', '360/2')
  ok((await el('a')).x === 180, `360/2 sets 180 (${(await el('a')).x})`)
  await type('X', '+24')
  ok((await el('a')).x === 204, `+24 adds (${(await el('a')).x})`)
  await type('W', '*2')
  ok((await el('a')).w === 400, `*2 doubles W (${(await el('a')).w})`)
  await type('X', 'alert(1)')
  ok((await el('a')).x === 204 && await xi.inputValue() === '204', 'junk restores the value and edits nothing')
  await undo()
  ok((await el('a')).w === 200 && (await el('a')).x === 204, 'one undo takes back only the *2')
  await xi.focus(); await p.keyboard.press('ArrowUp'); await p.keyboard.press('Shift+ArrowUp'); await p.waitForTimeout(150)
  await p.evaluate(() => document.activeElement?.blur()); await p.waitForTimeout(150)
  ok((await el('a')).x === 215, `↑ steps 1, Shift+↑ steps 10 (${(await el('a')).x})`)
  ok((await el('b')).x === 400, 'the arrows nudged the field, not the selection on the canvas')
  await undo(); await undo(); await undo(); await undo()
  ok((await el('a')).x === 100, `four undos are the four edits (${(await el('a')).x})`)

  console.log('\n2. the locked scrub\n')
  await select('a')
  await p.evaluate(() => {
    window.__lock = { asked: 0, held: false }
    const orig = Element.prototype.requestPointerLock
    Element.prototype.requestPointerLock = function (...a) { window.__lock.asked++; return orig.apply(this, a) }
    document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement) window.__lock.held = true })
  })
  const xs = field('X').locator('span')
  const bx = await xs.boundingBox()
  await p.mouse.move(bx.x + 3, bx.y + 5); await p.mouse.down(); await p.mouse.move(bx.x + 63, bx.y + 5, { steps: 6 }); await p.waitForTimeout(100)
  const mid = await p.evaluate(() => ({ ...window.__lock, now: !!document.pointerLockElement }))
  await p.mouse.up(); await p.waitForTimeout(250)
  ok(mid.asked === 1, `past the dead zone the scrub asks once for the pointer lock (${mid.asked})`)
  console.log(`  info  this browser ${mid.held ? 'GRANTED the lock: the drag ran on movementX' : 'refused the lock: the drag ran on the visible pointer'}`)
  ok(await p.evaluate(() => !document.pointerLockElement), 'the release lets the pointer go')
  const scrubbedX = (await el('a')).x
  ok(mid.held || scrubbedX > 100, `the drag moved X (${scrubbedX})`)
  if (scrubbedX !== 100) { await undo(); ok((await el('a')).x === 100, 'the whole drag is one undo step') }

  console.log('\n3. Mixed on a multi-selection\n')
  await select('a'); await select('b', true)
  ok((await p.evaluate(() => window.bento.selection)).length === 2, 'two elements selected')
  const mx = field('X').locator('input')
  ok(await mx.inputValue() === '' && await mx.getAttribute('placeholder') === 'Mixed', 'different X values show Mixed')
  ok(await field('W').locator('input').inputValue() === '200', 'equal W values show the value')
  const ms = await field('X').locator('span').boundingBox()
  await p.mouse.move(ms.x + 3, ms.y + 5); await p.mouse.down(); await p.mouse.move(ms.x + 23, ms.y + 5, { steps: 4 }); await p.mouse.up(); await p.waitForTimeout(250)
  let a = await el('a'), b = await el('b')
  const d = a.x - 100
  ok(d !== 0 && b.x - 400 === d, `a scrub moves each by the same delta from its own X (a ${a.x}, b ${b.x})`)
  await undo()
  a = await el('a'); b = await el('b')
  ok(a.x === 100 && b.x === 400, 'one undo takes the whole scrub back from both')
  await select('a'); await select('b', true)
  await type('X', '+10')
  a = await el('a'); b = await el('b')
  ok(a.x === 110 && b.x === 410, `typed +10 adds to each (${a.x}, ${b.x})`)
  await select('a'); await select('b', true)
  await type('Y', '300')
  a = await el('a'); b = await el('b')
  ok(a.y === 300 && b.y === 300, 'a plain value sets them all')
  await undo()
  a = await el('a'); b = await el('b')
  ok(a.y === 100 && b.y === 100 && a.x === 110, 'one undo step for the whole selection')
  await select('a'); await select('b', true)
  await type('W', '+50')
  ok((await el('a')).w === 250 && (await el('b')).w === 250, 'equal values take a relative entry as an ordinary one')
  ok(errors.length === 0, `no page error${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
