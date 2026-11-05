// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Groups in the layer list, in the packaged editor, with real input.
//
//   npm run build:single --prefix slides && node scripts/test-slides-layer-groups-browser.mjs
//
// WHAT THIS PROVES:
//   1. grouping gathers the members into one block of the stack, where the
//      topmost of them was, in one undo step with the tagging;
//   2. the group has its own row — 'Group of N' — with its members nested
//      under it; elements outside the group stay outside;
//   3. the group's row selects the whole group, a member's row just that
//      member; the group's row lights only when the whole group is selected;
//   4. the arrow folds the group to its one row and unfolds it;
//   5. a row's right-click is the canvas's element menu: Ungroup from a member,
//      Group from a shift-picked pair of rows;
//   6. a group from a file made before grouping gathered (members interleaved
//      with other elements) gets one group row per run — the list does not
//      pretend the stack is other than it is;
//   7. once inside a group (a member picked from its row), a click on another
//      member picks just that member, as in Figma — it used to select the
//      whole group, which on a big group read as "it selects everything";
//   8. a row renames in place — double-click or Rename on its right-click —
//      and so does a group's row; Escape keeps the old name, an empty name
//      gives the default back, Ungroup drops the group's name; one undo each;
//   9. leaving a rename by clicking elsewhere leaves the focus THERE — taking it
//      back to the list sent the next Backspace to the list, which deleted the
//      element; a rename survives the rows being rebuilt under it (an undo);
//      Rename reaches a member of a folded group.
//  10. inside a group, Shift-click toggles single members even once every
//      member has been shift-picked back in: entering the group is state the
//      editor keeps, not something read off the selection's shape — which
//      made the whole group drop out on the next Shift-click.
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
  await ctx.addInitScript(() => localStorage.setItem('bento-side-view', 'layers'))
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))
  const load = (els) => p.evaluate((els) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', notes: '', elements: els }]
    window.bento.loadDoc(JSON.stringify(d))
  }, els)
  const box = (id, x, y, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w: 160, h: 100, rotation: 0, opacity: 1, fill: '#5E7699', ...extra })
  await load([box('back', 40, 40, { w: 1100, h: 600, fill: '#eeeeee' }), box('a', 100, 100), box('mid', 400, 100), box('b', 700, 100)])
  await p.waitForTimeout(400)

  const order = () => p.evaluate(() => window.bento.doc.slides[0].elements.map((e) => e.id + (e.groupId ? '*' : '')).join(' '))
  const sel = () => p.evaluate(() => window.bento.selection.slice().sort().join(','))
  const rows = () => p.$$eval('.ed-side-layers .ed-layers > .ed-layer', (rs) => rs.map((r) => r.dataset.group ? `[${r.querySelector('.ed-layer-label').textContent}]` : (r.classList.contains('grouped') ? '  ' : '') + r.dataset.id))
  const row = (id) => p.locator(`.ed-side-layers .ed-layer[data-id="${id}"]`)
  const groupRow = () => p.locator('.ed-side-layers .ed-layer-group').first()
  const pick = async (id, shift = false) => {
    const b = await p.locator(`.ed-stage-scale [data-el-id="${id}"]`).boundingBox()
    if (shift) await p.keyboard.down('Shift')
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await p.waitForTimeout(200)
    if (shift) await p.keyboard.up('Shift')
  }
  const menu = async (locator, label) => {
    await locator.click({ button: 'right' }); await p.waitForTimeout(200)
    const item = p.locator('.ed-ctxmenu .ed-ctxmenu-item', { hasText: new RegExp(`^${label}`) })
    const found = await item.count() > 0 && await item.first().isEnabled()
    if (found) await item.first().click(); else await p.keyboard.press('Escape')
    await p.waitForTimeout(250)
    return found
  }

  ok(await p.locator('.ed-side-layers').isVisible(), 'the Layers view is open in the side column')

  // 1. grouping gathers
  await pick('a'); await pick('b', true)
  await p.keyboard.press(`${MOD}+g`); await p.waitForTimeout(250)
  ok(await order() === 'back mid a* b*', `the members gather where the topmost was (${await order()})`)
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250)
  ok(await order() === 'back a mid b', `one undo takes back the gathering and the tags (${await order()})`)
  await p.keyboard.press(`${MOD}+Shift+z`); await p.waitForTimeout(250)

  // 2. the group's row
  ok(JSON.stringify(await rows()) === JSON.stringify(['[Group of 2]', '  b', '  a', 'mid', 'back']), `a row for the group, its members under it (${(await rows()).join(' | ')})`)

  // 3. selecting from the list
  await p.keyboard.press('Escape'); await p.waitForTimeout(150)
  await row('a').click(); await p.waitForTimeout(150)
  ok(await sel() === 'a', 'a member\'s row selects just that member')
  ok(!(await groupRow().getAttribute('class')).includes('sel'), 'and the group\'s row stays unlit')
  await groupRow().click(); await p.waitForTimeout(150)
  ok(await sel() === 'a,b', 'the group\'s row selects the whole group')
  ok((await groupRow().getAttribute('class')).includes('sel'), 'and lights')

  // 4. fold
  await groupRow().locator('.ed-layer-fold').click(); await p.waitForTimeout(150)
  ok(JSON.stringify(await rows()) === JSON.stringify(['[Group of 2]', 'mid', 'back']), 'the arrow folds the group to its row')
  await groupRow().locator('.ed-layer-fold').click(); await p.waitForTimeout(150)
  ok((await rows()).length === 5, 'and unfolds it')

  // 5. right-click verbs
  ok(await menu(row('a'), 'Ungroup'), 'a member\'s right-click offers Ungroup')
  ok(await order() === 'back mid a b' && !(await rows()).some((r) => r.startsWith('[')), `and Ungroup dissolves the group (${await order()})`)
  await row('mid').click(); await p.waitForTimeout(100)
  await p.keyboard.down('Shift'); await row('back').click(); await p.keyboard.up('Shift'); await p.waitForTimeout(150)
  ok(await sel() === 'back,mid', 'shift-click picks a second row')
  ok(await menu(row('back'), 'Group'), 'their right-click offers Group')
  ok(JSON.stringify(await rows()) === JSON.stringify(['b', 'a', '[Group of 2]', '  mid', '  back']), `and Group makes the group (${(await rows()).join(' | ')})`)

  // 6. an interleaved group from an older file
  await load([box('x1', 100, 100, { groupId: 'old' }), box('y', 400, 100), box('x2', 700, 100, { groupId: 'old' })])
  await p.waitForTimeout(400)
  ok(JSON.stringify(await rows()) === JSON.stringify(['[Group of 2]', '  x2', 'y', '[Group of 2]', '  x1']), `each run gets its own group row (${(await rows()).join(' | ')})`)

  // 7. inside a group, a click stays inside
  await load([box('back', 40, 40, { w: 1100, h: 600, fill: '#eeeeee' }), box('a', 100, 100, { groupId: 'g' }), box('b', 400, 300, { groupId: 'g' }), box('c', 800, 100)])
  await p.waitForTimeout(400)
  await row('a').click(); await p.waitForTimeout(150)
  await pick('b')
  ok(await sel() === 'b', `a member picked from its row, a click on another member picks just that one (${await sel()})`)
  await pick('c')
  await pick('a')
  ok(await sel() === 'a,b', `from outside the group, a click still takes the whole group (${await sel()})`)

  // 8. rename
  const name = (id) => p.evaluate((id) => window.bento.doc.slides[0].elements.find((e) => e.id === id)?.name ?? '', id)
  const label = (loc) => loc.locator('.ed-layer-label').textContent()
  await row('c').locator('.ed-layer-label').dblclick(); await p.waitForTimeout(150)
  const field = p.locator('.ed-side-layers .ed-layer-rename')
  ok(await field.count() === 1, 'double-clicking a row opens its name for editing')
  await field.fill('Logo'); await field.press('Enter'); await p.waitForTimeout(250)
  ok(await name('c') === 'Logo' && await label(row('c')) === 'Logo', `Enter keeps the name (${await label(row('c'))})`)
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250)
  ok(await name('c') === '', 'one undo takes it back')
  await p.keyboard.press(`${MOD}+Shift+z`); await p.waitForTimeout(250)
  await row('c').locator('.ed-layer-label').dblclick(); await p.waitForTimeout(150)
  await field.fill('Nope'); await field.press('Escape'); await p.waitForTimeout(250)
  ok(await name('c') === 'Logo', 'Escape keeps the old name')
  ok(await menu(row('c'), 'Rename'), 'the right-click menu offers Rename')
  ok(await field.count() === 1, 'and it opens the same field')
  await field.fill(''); await field.press('Enter'); await p.waitForTimeout(250)
  ok(await name('c') === '' && /^Rectangle( \d+)?$/.test(await label(row('c'))), `an empty name gives the default back (${await label(row('c'))})`)
  await groupRow().locator('.ed-layer-label').dblclick(); await p.waitForTimeout(150)
  await field.fill('Header'); await field.press('Enter'); await p.waitForTimeout(250)
  ok(await label(groupRow()) === 'Header', `a group's row renames the group (${await label(groupRow())})`)
  ok(await p.evaluate(() => window.bento.doc.slides[0].elements.filter((e) => e.groupId === 'g').every((e) => e.groupName === 'Header')), 'the name is on every member')
  ok(await menu(groupRow(), 'Rename') && await field.count() === 1, 'a group\'s right-click offers Rename too')
  await field.press('Escape'); await p.waitForTimeout(150)
  ok(await menu(row('a'), 'Ungroup'), 'Ungroup')
  ok(await p.evaluate(() => window.bento.doc.slides[0].elements.every((e) => !e.groupName)), 'and the group\'s name goes with it')

  // 9. focus, rebuilds, folded groups
  const count = () => p.evaluate(() => window.bento.doc.slides[0].elements.length)
  const n0 = await count()
  await row('c').click(); await p.waitForTimeout(100)
  await row('c').locator('.ed-layer-label').dblclick(); await p.waitForTimeout(150)
  await field.fill('Badge')
  await p.locator('.ed-notespane-text').click(); await p.waitForTimeout(150)
  ok(await name('c') === 'Badge', 'clicking away keeps the name')
  ok(await p.evaluate(() => document.activeElement?.classList.contains('ed-notespane-text')), 'and the focus stays where the click put it')
  await p.keyboard.press('Backspace'); await p.waitForTimeout(150)
  ok(await count() === n0, `a Backspace there deletes no element (${await count()} of ${n0})`)
  await row('c').locator('.ed-layer-label').dblclick(); await p.waitForTimeout(150)
  await field.fill('Half typed')
  await p.evaluate(() => window.bento.undo()); await p.waitForTimeout(250)
  ok(await field.count() === 1 && await field.inputValue() === 'Half typed', `a rebuild under the field keeps it open, typing kept (${await field.count() ? await field.inputValue() : 'gone'})`)
  await field.press('Escape'); await p.waitForTimeout(150)
  await load([box('back', 40, 40, { w: 1100, h: 600, fill: '#eeeeee' }), box('a', 100, 100, { groupId: 'g' }), box('b', 400, 300, { groupId: 'g' })])
  await p.waitForTimeout(400)
  await groupRow().locator('.ed-layer-fold').click(); await p.waitForTimeout(150)
  await p.evaluate(() => window.bento.select?.(['a']) ?? null)
  const ba = await p.locator('.ed-stage-scale [data-el-id="a"]').boundingBox()
  await p.keyboard.down(MOD); await p.mouse.click(ba.x + 20, ba.y + 20); await p.keyboard.up(MOD); await p.waitForTimeout(200)
  await p.mouse.click(ba.x + 20, ba.y + 20, { button: 'right' }); await p.waitForTimeout(200)
  await p.locator('.ed-ctxmenu .ed-ctxmenu-item', { hasText: /^Rename/ }).click(); await p.waitForTimeout(200)
  ok(await field.count() === 1, 'Rename on a member of a folded group opens the group and the field')
  await field.press('Escape')
  // 10. Shift inside an entered group
  await load([box('g1', 100, 300, { groupId: 'h' }), box('g2', 400, 300, { groupId: 'h' }), box('g3', 700, 300, { groupId: 'h' }), box('out', 1000, 300)])
  await p.waitForTimeout(400)
  const modPick = async (id) => { await p.keyboard.down(MOD); await pick(id); await p.keyboard.up(MOD) }
  await modPick('g1')
  ok(await sel() === 'g1', '⌘-click enters the group at g1')
  await pick('g2', true); await pick('g3', true)
  ok(await sel() === 'g1,g2,g3', `Shift-click picks the other members one by one (${await sel()})`)
  await pick('g2', true)
  ok(await sel() === 'g1,g3', `and a further Shift-click takes out just that member (${await sel()})`)
  await row('g3').click(); await p.waitForTimeout(150)
  await pick('g1', true); await pick('g2', true); await pick('g1', true)
  ok(await sel() === 'g2,g3', `the same from a member's row in the layer list (${await sel()})`)
  await pick('out')
  await pick('g1')
  ok(await sel() === 'g1,g2,g3', `leaving the group leaves it: a click back on a member takes the whole group (${await sel()})`)
  await pick('g2', true)
  ok(await sel() === '', `and Shift-click then takes the whole group out (${await sel()})`)

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
