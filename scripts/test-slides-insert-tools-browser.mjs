// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The one-letter tools, the path bar and the command names on the chrome — end
// to end in the built shell.
//
//   npm run build:single --prefix slides && node scripts/test-slides-insert-tools-browser.mjs
//
// WHAT THIS PROVES.
//   1. The topbar's tools carry data-cmd, a letter badge and the letter in
//      their tooltip — all read from the command list (commands.ts).
//   2. V F R O L P T do what they say on the canvas (each arms its tool and a
//      click on the slide puts one element down; V cancels an armed tool),
//      and do nothing while a text field has focus.
//   3. The path bar is there only for one path shape: Smooth rounds every
//      corner of a polygon into a curve, a pressed anchor is the one Corner /
//      Symmetric act on, Close path opens and closes it, ⌘Z undoes each.
//   4. Undo, Redo, Help, PDF, Save and the element menu's rows carry data-cmd.
//   5. The ? sheet's Tools section lists the letters from the same list.
//   7. A path shape (polygon or curve) is dragged from inside its fill,
//      selected or not, as a rectangle is.
//   6. At 1280 wide (the icon-only tier) the tools still show their keys, in
//      the button's corner, clear of the icon, and the bar does not overflow.
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
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))
  const load = (els) => p.evaluate((els) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', notes: '', transition: 'none', elements: els }]
    window.bento.loadDoc(JSON.stringify(d))
  }, els)
  const els = () => p.evaluate(() => window.bento.doc.slides[0].elements)
  const slideAt = async (fx, fy) => { const b = await p.locator('.ed-stage-scale').boundingBox(); return [b.x + b.width * fx, b.y + b.height * fy] }
  const deselect = async () => { await p.keyboard.press('Escape'); await p.waitForTimeout(120) }

  console.log('\nthe tools on the bar\n')
  const tools = await p.evaluate(() => [...document.querySelectorAll('.ed-topbar .ed-insert [data-cmd]')].map((b) => ({
    cmd: b.dataset.cmd, key: b.querySelector('.ed-tool-key')?.textContent ?? '', title: b.title,
  })))
  const byCmd = Object.fromEntries(tools.map((x) => [x.cmd, x]))
  for (const [cmd, key] of [['tool-select', 'V'], ['tool-frame', 'F'], ['insert-text', 'T'], ['comment', 'C']]) {
    ok(byCmd[cmd]?.key === key, `${cmd} carries the badge ${key} (${byCmd[cmd]?.key})`)
    ok(byCmd[cmd]?.title.endsWith(`(${key})`), `${cmd}'s tooltip names ${key}`)
  }
  for (const cmd of ['insert-image', 'insert-table', 'insert-chart', 'insert-code']) ok(!!byCmd[cmd], `${cmd} is a command button`)
  const shapeKeys = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.ed-topbar .ed-menu [data-cmd^="tool-"]')].map((b) => [b.dataset.cmd, b.querySelector('.ed-tool-key')?.textContent])))
  ok(shapeKeys['tool-rect'] === 'R' && shapeKeys['tool-ellipse'] === 'O' && shapeKeys['tool-line'] === 'L' && shapeKeys['tool-pen'] === 'P', `the Shape menu badges R O L P (${JSON.stringify(shapeKeys)})`)

  console.log('\nthe letters at a normal window width\n')
  {
    // at 1280 the bar is icon-only (compact); each tool still shows its key in its corner
    const q = await ctx.newPage()
    await q.setViewportSize({ width: 1280, height: 800 })
    await q.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
    await q.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))
    await q.waitForTimeout(300)
    const look = () => q.evaluate(() => {
      const bar = document.querySelector('.ed-topbar')
      const out = { compact: bar.classList.contains('ed-bar-compact'), fold: bar.classList.contains('ed-bar-fold'), overflow: bar.scrollWidth - bar.clientWidth, keys: {} }
      for (const b of document.querySelectorAll('.ed-topbar [data-cmd] ')) {
        const k = b.querySelector(':scope > .ed-tool-key')
        if (!k) continue
        const kr = k.getBoundingClientRect(), br = b.getBoundingClientRect(), ir = b.querySelector('svg')?.getBoundingClientRect()
        const cs = getComputedStyle(k)
        const seen = kr.width > 0 && kr.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0
        const inside = kr.left >= br.left - 0.5 && kr.right <= br.right + 0.5 && kr.top >= br.top - 0.5 && kr.bottom <= br.bottom + 0.5
        const clear = !ir || b.closest('.ed-menu') || kr.left >= ir.right - 0.5 || kr.top >= ir.bottom - 0.5
        out.keys[k.textContent] = seen && inside && clear && br.width > 0
      }
      return out
    })
    let at = await look()
    ok(at.compact && !at.fold && at.overflow <= 1, `at 1280 the bar is icon-only and does not overflow (compact ${at.compact}, overflow ${at.overflow})`)
    ok(['V', 'S', 'F', 'T'].every((k) => at.keys[k]), `V S F T show their keys on their buttons, clear of the icon (${JSON.stringify(at.keys)})`)
    await q.click('.ed-topbar .ed-shape-trigger'); await q.waitForTimeout(200)
    at = await look()
    ok(['R', 'O', 'L', 'P'].every((k) => at.keys[k]), `the Shape menu rows show R O L P (${JSON.stringify(at.keys)})`)
    await q.close()
  }

  console.log('\nthe letters\n')
  await load([])
  await p.waitForTimeout(300)
  await p.locator('.ed-scroll').click({ position: { x: 20, y: 20 } }); await deselect()
  for (const [k, check, what] of [
    ['r', (e) => e.type === 'shape' && e.shape === 'rect' && !e.layout, 'a rectangle'],
    ['o', (e) => e.type === 'shape' && e.shape === 'ellipse', 'an ellipse'],
    ['f', (e) => e.type === 'shape' && e.shape === 'rect' && e.layout?.dir === 'row', 'an auto-layout frame'],
  ]) {
    const before = (await els()).length
    await deselect()
    // the box tools arm; a click on the slide puts the element down
    await p.keyboard.press(k); await p.waitForTimeout(150)
    await p.mouse.click(...(await slideAt(0.3 + 0.1 * before, 0.5))); await p.waitForTimeout(250)
    const after = await els()
    ok(after.length === before + 1 && check(after.at(-1)), `${k.toUpperCase()} then a click puts down ${what}`)
  }
  await deselect()
  const beforeT = (await els()).length
  await p.keyboard.press('t'); await p.waitForTimeout(150)
  await p.mouse.click(...(await slideAt(0.5, 0.2))); await p.waitForTimeout(300)
  ok((await els()).length === beforeT + 1 && (await els()).at(-1).type === 'text', 'T then a click puts down a text box')
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape'); await p.waitForTimeout(150)
  const armed = () => p.evaluate(() => [...document.querySelectorAll('.ed-stage-scale > div')].some((d) => d.style.cursor === 'crosshair'))
  await p.keyboard.press('l'); await p.waitForTimeout(150)
  ok(await armed(), 'L arms the line tool')
  await p.keyboard.press('v'); await p.waitForTimeout(150)
  ok(!(await armed()), 'V puts it down')
  await p.keyboard.press('p'); await p.waitForTimeout(150)
  ok(await armed(), 'P arms the pen')
  await p.keyboard.press('v'); await p.waitForTimeout(150)
  const n0 = (await els()).length
  await p.click('.ed-topbar .ed-title'); await p.keyboard.press('End')
  await p.keyboard.type('rot'); await p.waitForTimeout(150)
  ok((await els()).length === n0, 'letters typed into the title insert nothing')
  await p.keyboard.press('Escape')

  console.log('\nthe pen\n')
  {
    await load([]); await p.waitForTimeout(300)
    await p.locator('.ed-scroll').click({ position: { x: 20, y: 20 } }) // focus back on the canvas, out of the title
    const st = await p.locator('.ed-stage-scale').boundingBox()
    const at = (fx, fy) => [st.x + st.width * fx, st.y + st.height * fy]
    const nums = (d) => (d.match(/-?\d*\.?\d+/g) ?? []).map(Number)
    // corner at A, smooth (dragged) at B, corner at C, then click A: closed
    await deselect(); await p.keyboard.press('p'); await p.waitForTimeout(150)
    await p.mouse.click(...at(0.2, 0.6))
    await p.mouse.move(...at(0.4, 0.3)); await p.mouse.down()
    await p.mouse.move(...at(0.45, 0.3), { steps: 4 }); await p.mouse.move(...at(0.5, 0.3), { steps: 4 }); await p.mouse.up()
    await p.mouse.click(...at(0.6, 0.6))
    await p.mouse.click(...at(0.2, 0.6)); await p.waitForTimeout(300)
    let all = await els()
    const shape = all.at(-1)
    ok(all.length === 1 && shape.shape === 'path' && /Z\s*$/.test(shape.d) && shape.pathBox?.[2] === shape.w, `clicking the first point closes the pen's path into a filled shape (${shape?.d})`)
    // M A C a1 b1 B C b2 c2 C C … : B's handles are b1 (in) and b2 (out)
    const n = nums(shape.d)
    const B = [n[6], n[7]], bin = [n[4], n[5]], bout = [n[8], n[9]]
    ok(Math.abs(bin[0] + bout[0] - 2 * B[0]) < 0.05 && Math.abs(bin[1] + bout[1] - 2 * B[1]) < 0.05 && Math.abs(bout[0] - B[0]) > 10, `a click-drag places a smooth point with symmetric handles (in ${bin}, out ${bout}, at ${B})`)
    ok(!(await armed()), 'the pen puts itself down when the shape is done')
    // Alt breaks the handle
    await load([]); await p.waitForTimeout(300)
    await deselect(); await p.keyboard.press('p'); await p.waitForTimeout(150)
    await p.mouse.click(...at(0.2, 0.6))
    await p.mouse.move(...at(0.4, 0.3)); await p.mouse.down()
    await p.mouse.move(...at(0.5, 0.3), { steps: 4 })
    await p.keyboard.down('Alt'); await p.mouse.move(...at(0.5, 0.5), { steps: 4 }); await p.keyboard.up('Alt'); await p.mouse.up()
    await p.mouse.click(...at(0.6, 0.6))
    await p.keyboard.press('Escape'); await p.waitForTimeout(300)
    all = await els()
    const open = all.at(-1)
    const m = nums(open.d)
    const B2 = [m[6], m[7]], in2 = [m[4], m[5]], out2 = [m[8], m[9]]
    ok(all.length === 1 && !/Z/.test(open.d) && open.fill === 'transparent' && open.strokeWidth > 0, `Esc finishes an open path, drawn as a stroke (${open.d})`)
    ok(Math.abs(in2[0] + out2[0] - 2 * B2[0]) > 1 || Math.abs(in2[1] + out2[1] - 2 * B2[1]) > 1, `Alt while dragging breaks the handles (in ${in2}, out ${out2})`)
    // Backspace takes the last point back; Enter on two points finishes open
    await load([]); await p.waitForTimeout(300)
    await deselect(); await p.keyboard.press('p'); await p.waitForTimeout(150)
    await p.mouse.click(...at(0.2, 0.2)); await p.mouse.click(...at(0.4, 0.2)); await p.mouse.click(...at(0.4, 0.4))
    await p.keyboard.press('Backspace'); await p.keyboard.press('Enter'); await p.waitForTimeout(300)
    all = await els()
    ok(all.length === 1 && !/Z/.test(all[0].d) && (all[0].d.match(/C/g) ?? []).length === 1, `Backspace takes the last point back, Enter finishes the two left as an open path (${all[0]?.d})`)
    // and the curve editor reads what the pen wrote: closed, three anchors
    await load([shape]); await p.waitForTimeout(300)
    await p.evaluate((id) => window.bento.select?.([id]), shape.id)
    if (!(await p.evaluate(() => window.bento.selection.length))) { const b = await p.locator(`.ed-stage-scale [data-el-id="${shape.id}"]`).boundingBox(); await p.mouse.click(b.x + b.width / 2, b.y + b.height * 0.7) }
    await p.waitForTimeout(300)
    const anchors = await p.evaluate(() => document.querySelectorAll('.ed-bz-anchor').length)
    ok(anchors === 3, `the curve editor opens the pen's shape with its three anchors (${anchors})`)
    await p.keyboard.press('Escape')
  }

  console.log('\nthe path bar\n')
  const tri = { id: 'tri', type: 'shape', shape: 'path', x: 300, y: 200, w: 400, h: 300, rotation: 0, opacity: 1, fill: '#5E7699', stroke: '#000000', strokeWidth: 2, radius: 0, d: 'M 0 300 L 200 0 L 400 300 Z', pathBox: [0, 0, 400, 300] }
  await load([tri, { ...tri, id: 'box', shape: 'rect', x: 900, y: 200, w: 100, h: 100, d: undefined, pathBox: undefined }])
  await p.waitForTimeout(400)
  const bar = () => p.evaluate(() => { const b = document.querySelector('.ed-topbar .ed-pathbar'); return !!b && !b.hidden && b.getBoundingClientRect().width > 0 })
  const pressed = () => p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.ed-pathbar [data-node]')].map((b) => [b.dataset.node, b.getAttribute('aria-pressed') === 'true'])))
  const d = async () => (await els()).find((e) => e.id === 'tri').d
  const clickEl = async (id, fx = 0.5, fy = 0.6) => {
    const b = await p.locator(`.ed-stage-scale [data-el-id="${id}"]`).boundingBox()
    await p.mouse.click(b.x + b.width * fx, b.y + b.height * fy); await p.waitForTimeout(250)
  }
  await clickEl('box')
  ok(!(await bar()), 'a rectangle: no path bar')
  await clickEl('tri')
  ok(await bar(), 'one path shape: the path bar is there')
  ok((await pressed()).close === true, 'Close path shows pressed on a closed polygon')
  const d0 = await d()
  await p.click('.ed-pathbar [data-node="smooth"]'); await p.waitForTimeout(300)
  const d1 = await d()
  ok(d1 !== d0 && /C/.test(d1), `Smooth turns the polygon into a curve (${d1.slice(0, 40)}…)`)
  const handles = await p.evaluate(() => document.querySelectorAll('.ed-bezedit circle').length)
  ok(handles > 3, `the curve editor took over, handles shown (${handles})`)
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250)
  ok(await d() === d0, '⌘Z restores the polygon')
  await p.keyboard.press(`${MOD}+Shift+z`); await p.waitForTimeout(300)
  await clickEl('tri')
  // press the first anchor: the pills now act on it alone
  const a0 = p.locator('.ed-bezedit .ed-bz-anchor[data-idx="0"]')
  const ab = await a0.boundingBox()
  await p.mouse.click(ab.x + ab.width / 2, ab.y + ab.height / 2); await p.waitForTimeout(200)
  ok((await pressed()).smooth === true, `the pressed anchor shows Smooth (${JSON.stringify(await pressed())}, ${await p.evaluate(() => document.querySelectorAll('.ed-bz-sel').length)} marked)`)
  await p.click('.ed-pathbar [data-node="corner"]'); await p.waitForTimeout(300)
  ok((await pressed()).corner === true, 'Corner on that anchor: it shows Corner')
  const sharp = await p.evaluate(() => document.querySelectorAll('.ed-bezedit rect.ed-bz-anchor').length)
  ok(sharp === 1, `exactly one anchor is a corner now (${sharp})`)
  await p.click('.ed-pathbar [data-node="symmetric"]'); await p.waitForTimeout(300)
  ok((await pressed()).symmetric === true, 'Symmetric on that anchor: it shows Symmetric')
  await p.click('.ed-pathbar [data-node="close"]'); await p.waitForTimeout(300)
  ok(!/Z/.test(await d()) && (await pressed()).close === false, 'Close path opens it (no Z)')
  await p.click('.ed-pathbar [data-node="close"]'); await p.waitForTimeout(300)
  ok(/Z/.test(await d()) && (await pressed()).close === true, '…and again closes it')

  console.log('\na path shape drags like any other\n')
  {
    // inside its fill, not on its outline: the polygon (line editor) and a curve (bezier editor)
    const curve = { ...tri, id: 'cur', x: 800, y: 200, d: 'M 0 300 C 0 100 400 100 400 300 L 200 300 Z' }
    await load([tri, curve]); await p.waitForTimeout(400)
    const toC = (x, y) => p.evaluate(([x, y]) => { const r = document.querySelector('.ed-stage-scale').getBoundingClientRect(); const k = r.width / window.bento.doc.size.width; return [r.left + x * k, r.top + y * k] }, [x, y])
    // where the drawn outline is (a curve's box is re-fitted to its anchors on commit, so not el.y)
    const yOf = (id) => p.evaluate((id) => { const r = document.querySelector('.ed-stage-scale').getBoundingClientRect(), k = r.width / window.bento.doc.size.width; return Math.round((document.querySelector(`.ed-stage-scale [data-el-id="${id}"] path`).getBoundingClientRect().top - r.top) / k) }, id)
    const pull = async (x, y, dy) => {
      const a = await toC(x, y), b = await toC(x, y + dy)
      await p.mouse.move(...a); await p.mouse.down()
      for (let i = 1; i <= 10; i++) { await p.mouse.move(a[0], a[1] + (b[1] - a[1]) * i / 10); await p.waitForTimeout(16) }
      await p.mouse.up(); await p.waitForTimeout(300)
    }
    for (const [id, x] of [['tri', 500], ['cur', 1000]]) {
      await deselect()
      const y0 = await yOf(id)
      await pull(x, 420, 60)
      const y1 = await yOf(id)
      ok(Math.abs(y1 - y0 - 60) < 3, `${id}: pressed unselected inside its fill and dragged, it moves in the same gesture (top ${y0} → ${y1})`)
      await pull(x, 480, 60)
      const y2 = await yOf(id)
      ok(Math.abs(y2 - y1 - 60) < 3, `${id}: selected, a drag inside its fill moves it again (top ${y1} → ${y2})`)
    }
    await load([tri, { ...tri, id: 'box', shape: 'rect', x: 900, y: 200, w: 100, h: 100, d: undefined, pathBox: undefined }]); await p.waitForTimeout(400)
  }

  console.log('\ncommand names on the chrome\n')
  const named = await p.evaluate(() => ['undo', 'redo', 'help', 'export-pdf', 'save'].filter((c) => !document.querySelector(`.ed-topbar [data-cmd="${c}"]`)))
  ok(named.length === 0, `undo, redo, help, PDF and Save carry data-cmd${named.length ? ' — missing ' + named.join(', ') : ''}`)
  const b = await p.locator('.ed-stage-scale [data-el-id="box"]').boundingBox()
  await p.mouse.click(b.x + 50, b.y + 50, { button: 'right' }); await p.waitForTimeout(200)
  const menuCmds = await p.evaluate(() => [...document.querySelectorAll('.ed-ctxmenu [data-cmd]')].map((x) => `${x.dataset.cmd}=${x.querySelector('kbd')?.textContent ?? ''}`))
  ok(['duplicate', 'auto-layout', 'delete'].every((c) => menuCmds.some((m) => m.startsWith(c + '='))), `the element menu's rows name their commands (${menuCmds.join(' ')})`)
  ok(menuCmds.find((m) => m.startsWith('auto-layout='))?.endsWith('⇧A'), 'and show the command list\'s keys')
  await p.keyboard.press('Escape')

  console.log('\nthe ? sheet\n')
  await p.click('.ed-topbar [data-cmd="help"]'); await p.waitForTimeout(200)
  const toolRows = await p.evaluate(() => {
    // rows follow their group's heading; a chord's keys are separate caps
    const out = []
    let tools = false
    for (const el of document.querySelectorAll('.ed-keys-list > *')) {
      if (el.classList.contains('ed-keys-group')) tools = el.textContent === 'Tools'
      else if (tools) for (const ks of el.querySelectorAll('.ed-keys-keys')) out.push([...ks.querySelectorAll('kbd')].map((k) => k.textContent).join(''))
    }
    return out.length ? out : null
  })
  ok(!!toolRows && ['V', 'F', 'R', 'O', 'L', 'P', 'T'].every((k) => toolRows.includes(k)), `the Tools group lists the letters (${toolRows?.join(' ')})`)
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
