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
//   2. V F R O L P T do what they say on the canvas (one element each, or an
//      armed draw tool V cancels), and do nothing while a text field has focus.
//   3. The path bar is there only for one path shape: Smooth rounds every
//      corner of a polygon into a curve, a pressed anchor is the one Corner /
//      Symmetric act on, Close path opens and closes it, ⌘Z undoes each.
//   4. Undo, Redo, Help, PDF, Save and the element menu's rows carry data-cmd.
//   5. The ? sheet's Tools section lists the letters from the same list.
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
    await p.keyboard.press(k); await p.waitForTimeout(250)
    const after = await els()
    ok(after.length === before + 1 && check(after.at(-1)), `${k.toUpperCase()} inserts ${what}`)
  }
  await deselect()
  const beforeT = (await els()).length
  await p.keyboard.press('t'); await p.waitForTimeout(300)
  ok((await els()).length === beforeT + 1 && (await els()).at(-1).type === 'text', 'T inserts a text box')
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape'); await p.waitForTimeout(150)
  const armed = () => p.evaluate(() => [...document.querySelectorAll('.ed-stage-scale > div')].some((d) => d.style.cursor === 'crosshair'))
  await p.keyboard.press('l'); await p.waitForTimeout(150)
  ok(await armed(), 'L arms the line tool')
  await p.keyboard.press('v'); await p.waitForTimeout(150)
  ok(!(await armed()), 'V puts it down')
  await p.keyboard.press('p'); await p.waitForTimeout(150)
  ok(await armed(), 'P arms the pen (click the corners)')
  await p.keyboard.press('v'); await p.waitForTimeout(150)
  const n0 = (await els()).length
  await p.click('.ed-topbar .ed-title'); await p.keyboard.press('End')
  await p.keyboard.type('rot'); await p.waitForTimeout(150)
  ok((await els()).length === n0, 'letters typed into the title insert nothing')
  await p.keyboard.press('Escape')

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
    const sec = [...document.querySelectorAll('.ed-help-sec')].find((s) => s.querySelector('h3')?.textContent === 'Tools')
    return sec ? [...sec.querySelectorAll('kbd')].map((k) => k.textContent) : null
  })
  ok(!!toolRows && ['V', 'F', 'R', 'O', 'L', 'P', 'T', '⇧A'].every((k) => toolRows.includes(k)), `the Tools section lists the letters (${toolRows?.join(' ')})`)
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
