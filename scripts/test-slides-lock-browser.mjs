// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Locking an element (#838): a locked backdrop no longer blocks the items above it.
//
//   npm run build:single --prefix slides && node scripts/test-slides-lock-browser.mjs
//
// WHAT THIS PROVES, in the packaged document with trusted mouse and keyboard
// input:
//   1. CONTROL: with an UNLOCKED full-slide backdrop, a marquee that starts
//      on it does not select the two small items above it (the reported bug);
//   2. with the backdrop `locked`, the same marquee selects exactly those two,
//      and a plain click on the backdrop selects nothing;
//   3. a locked element is still reachable: from its Layers row and from
//      Alt-click; selected, it shows the lock marker, has no Moveable handles,
//      and an arrow key does not move it;
//   4. ⌘L toggles the lock of the selection, and with NOTHING selected it does
//      not preventDefault (the browser keeps its address-bar shortcut);
//   5. the field is additive: unlocking deletes the key, and the sidebar
//      thumbnails never carry the editor-only lock attribute.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const rect = (id, x, y, w, h, extra = {}) => ({
  id, type: 'shape', shape: 'rect', x, y, w, h, fill: '#88aadd', stroke: 'none', strokeWidth: 0, radius: 0, ...extra,
})

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message + (process.env.STACK ? '\n' + e.stack : '')))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelectorAll('.ed-sidebar .ed-thumb').length > 1)
  await p.waitForTimeout(500)

  const load = async (locked) => {
    await p.evaluate(([bgLocked, mk]) => {
      const d = JSON.parse(JSON.stringify(window.bento.doc))
      const make = (id, x, y, w, h, extra = {}) => ({
        id, type: 'shape', shape: 'rect', x, y, w, h, fill: '#88aadd', stroke: 'none', strokeWidth: 0, radius: 0, ...extra,
      })
      d.slides = [{
        id: 'lk-s1', background: '#ffffff', elements: [
          make('bg', 0, 0, 1280, 720, bgLocked ? { locked: true } : {}),
          make('a', 100, 100, 200, 100),
          make('b', 400, 100, 200, 100),
        ],
      }]
      window.bento.loadDoc(JSON.stringify(d))
    }, [locked, null])
    await p.waitForTimeout(600)
  }
  // slide px -> client px
  const at = async (sx, sy) => p.evaluate(([x, y]) => {
    const r = document.querySelector('.ed-stage-scale > *, .ed-stage-scale').getBoundingClientRect()
    const stage = document.querySelector('.ed-stage-scale').getBoundingClientRect()
    const k = stage.width / window.bento.doc.size.width
    return { x: stage.left + x * k, y: stage.top + y * k }
  }, [sx, sy])
  const selection = () => p.evaluate(() => [...document.querySelectorAll('.ed-stage-scale .bento-el.bento-sel, .ed-stage-scale [data-selected="1"]')].map((n) => n.dataset.elId))
  // the store's own answer, via the Layers highlight
  const selected = () => p.evaluate(() => [...document.querySelectorAll('.ed-layer.sel')].map((n) => n.dataset.id).sort())
  const marquee = async () => {
    const a = await at(60, 60)
    const b = await at(700, 260)
    await p.mouse.move(a.x, a.y)
    await p.mouse.down()
    await p.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 })
    await p.mouse.move(b.x, b.y, { steps: 5 })
    await p.mouse.up()
    await p.waitForTimeout(300)
  }
  const openLayers = async () => {
    // the Layers section lives first in the properties panel; open it if closed
    await p.evaluate(() => {
      const list = document.querySelector('.ed-layers')
      const body = list?.closest('.ed-section-body, .ed-acc-body')
      if (!list || list.offsetParent !== null) return
      const head = list.closest('.ed-section')?.querySelector('.ed-section-title, h3, h4') || list.parentElement?.previousElementSibling
      head?.click()
    })
  }

  console.log('\ncontrol: an unlocked backdrop swallows the marquee\n')
  await load(false)
  await openLayers()
  await marquee()
  {
    const s = await selected()
    ok(!(s.includes('a') && s.includes('b')), `unlocked backdrop: marquee does NOT select both items (got ${JSON.stringify(s)})`)
  }

  const controlErrors = errors.length // the unlocked control drags the backdrop itself; Moveable's press handoff throws there (no lock involved), so only later errors count
  console.log('\nlocked backdrop\n')
  await load(true)
  await openLayers()
  ok(await p.evaluate(() => !!document.querySelector('.ed-stage-scale .bento-el[data-locked][data-el-id="bg"]')), 'the canvas marks the locked node')
  ok(await p.evaluate(() => !document.querySelector('.ed-sidebar [data-locked]')), 'thumbnails never carry the editor-only lock attribute')
  await marquee()
  {
    const s = await selected()
    ok(JSON.stringify(s) === JSON.stringify(['a', 'b']), `marquee over the backdrop selects exactly a and b (got ${JSON.stringify(s)})`)
  }
  {
    await p.keyboard.press('Escape')
    const c = await at(900, 500)
    await p.mouse.click(c.x, c.y)
    await p.waitForTimeout(250)
    const s = await selected()
    ok(s.length === 0, `a click on the locked backdrop selects nothing (got ${JSON.stringify(s)})`)
  }

  console.log('\nreaching a locked element\n')
  {
    // Layers row
    await p.evaluate(() => document.querySelector('.ed-layer[data-id="bg"]')?.click())
    await p.waitForTimeout(300)
    ok(JSON.stringify(await selected()) === '["bg"]', 'its Layers row selects it')
    ok(await p.evaluate(() => !!document.querySelector('.ed-layer[data-id="bg"] .ed-layer-lock')), 'the Layers row shows a padlock')
    ok(await p.evaluate(() => !!document.querySelector('.ed-stage-scale .bento-lock-sel[data-el-id="bg"]')), 'selected, it shows the lock marker')
    ok(await p.evaluate(() => {
      const box = document.querySelector('.moveable-control-box')
      return !box || box.offsetParent === null || getComputedStyle(box).display === 'none' || !box.querySelector('.moveable-control:not([style*="display: none"])')
    }), 'selected, it has no Moveable handles')
    await p.keyboard.press('ArrowRight')
    await p.waitForTimeout(200)
    ok(await p.evaluate(() => window.bento.doc.slides[0].elements.find((e) => e.id === 'bg').x === 0), 'an arrow key does not move it')

    // Alt-click deep select
    await p.keyboard.press('Escape')
    const c = await at(900, 500)
    await p.keyboard.down('Alt')
    await p.mouse.click(c.x, c.y)
    await p.keyboard.up('Alt')
    await p.waitForTimeout(250)
    ok(JSON.stringify(await selected()) === '["bg"]', 'Alt-click reaches the locked element')
  }

  console.log('\n⌘L\n')
  {
    await p.keyboard.press(`${MOD}+l`)
    await p.waitForTimeout(300)
    ok(await p.evaluate(() => !('locked' in window.bento.doc.slides[0].elements.find((e) => e.id === 'bg'))), '⌘L on a locked selection unlocks it and deletes the key')
    ok(await p.evaluate(() => !document.querySelector('.ed-stage-scale .bento-el[data-locked]')), 'the canvas node loses its mark')
    await p.keyboard.press(`${MOD}+l`)
    await p.waitForTimeout(300)
    ok(await p.evaluate(() => window.bento.doc.slides[0].elements.find((e) => e.id === 'bg').locked === true), '⌘L again locks it')

    // nothing selected: the browser keeps ⌘L
    await p.keyboard.press('Escape')
    await p.waitForTimeout(200)
    await p.evaluate(() => {
      window.__lPrevented = null
      window.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'l') window.__lPrevented = e.defaultPrevented })
    })
    await p.keyboard.press(`${MOD}+l`)
    await p.waitForTimeout(200)
    ok((await p.evaluate(() => window.__lPrevented)) === false, '⌘L with nothing selected is left to the browser (not preventDefault-ed)')
    ok(await p.evaluate(() => window.bento.doc.slides[0].elements.find((e) => e.id === 'bg').locked === true), '...and changes nothing')

    // with something selected the editor takes it
    await p.evaluate(() => document.querySelector('.ed-layer[data-id="a"]')?.click())
    await p.waitForTimeout(200)
    await p.keyboard.press(`${MOD}+l`)
    await p.waitForTimeout(250)
    ok((await p.evaluate(() => window.__lPrevented)) === true, '⌘L with a selection is handled (preventDefault-ed)')
    ok(await p.evaluate(() => window.bento.doc.slides[0].elements.find((e) => e.id === 'a').locked === true), '...and locks it')
  }

  console.log('\nDelete and Cut leave locked elements alone\n')
  {
    const ids = () => p.evaluate(() => window.bento.doc.slides[0].elements.map((e) => e.id).join(','))
    // a: locked (from above), bg: locked. Select only locked ones -> nothing happens
    await load(true)
    await p.evaluate(() => document.querySelector('.ed-layer[data-id="bg"]')?.click())
    await p.waitForTimeout(250)
    await p.keyboard.press('Delete')
    await p.waitForTimeout(250)
    ok((await ids()) === 'bg,a,b', 'Delete on a locked-only selection deletes nothing')
    await p.keyboard.press('Backspace')
    await p.waitForTimeout(250)
    ok((await ids()) === 'bg,a,b', 'Backspace on a locked-only selection deletes nothing')
    // mixed selection: bg (locked) + a -> Delete removes a only, bg stays selected
    await p.evaluate(() => document.querySelector('.ed-layer[data-id="bg"]')?.click())
    await p.evaluate(() => document.querySelector('.ed-layer[data-id="a"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
    await p.waitForTimeout(250)
    ok(JSON.stringify(await selected()) === '["a","bg"]', 'a mixed selection of a locked and an unlocked element')
    await p.keyboard.press('Delete')
    await p.waitForTimeout(250)
    ok((await ids()) === 'bg,b', `Delete on a mixed selection removes only the unlocked one (got ${await ids()})`)
    ok(JSON.stringify(await selected()) === '["bg"]', 'the locked element stays selected')
    // the panel Delete button follows the same rule
    const clicked = await p.evaluate(() => {
      const b = [...document.querySelectorAll('.ed-context button')].find((b) => b.getAttribute('aria-label')?.startsWith('Delete'))
      b?.click()
      return !!b
    })
    ok(clicked, 'the panel has a Delete button to press')
    await p.waitForTimeout(250)
    ok((await ids()) === 'bg,b', 'the panel Delete button leaves a locked element too')
    // once unlocked it can go
    await p.keyboard.press(`${MOD}+l`)
    await p.waitForTimeout(250)
    await p.keyboard.press('Delete')
    await p.waitForTimeout(250)
    ok((await ids()) === 'b', 'after unlocking, Delete removes it')
  }

  ok(errors.length === controlErrors, `no page errors once the backdrop is locked${errors.length > controlErrors ? ': ' + errors.slice(controlErrors).join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
