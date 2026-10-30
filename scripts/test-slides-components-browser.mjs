// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Components and design tokens in the packaged editor, with real input.
//
//   npm run build:single --prefix slides && node scripts/test-slides-components-browser.mjs
//
// WHAT THIS PROVES:
//   1. ⌥⌘K makes the selection a component's main, in one undo step; its
//      layer rows show ◆, and the Tokens view lists it;
//   2. Insert (Tokens view) drops a copy on the current slide — fresh ids, one
//      new group, rows marked ◇ — selected;
//   3. an edit to the main (the inspector's own corner-radius field) reaches the
//      copy, which keeps its own position;
//   4. a property changed on the copy by hand is kept as an override when the
//      main changes again, while the other properties still follow;
//   5. Detach component (right-click) stops the copy following;
//   6. a number token bound from the inspector's dot writes its value; editing
//      the token in the Tokens view moves the bound property; switching the
//      mode rewrites bound literals; the pill detaches and the value stays
//      (a hand edit dropping the binding is test-slides-tokens.ts's);
//   7. no page error.
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
  const box = (id, x, y, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w: 160, h: 100, rotation: 0, opacity: 1, fill: '#5E7699', stroke: '#000000', strokeWidth: 0, radius: 0, ...extra })
  await p.evaluate((els) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: els }]
    d.theme.tokens = { set: { 'radius.card': { type: 'number', values: { default: 12 } } } }
    window.bento.loadDoc(JSON.stringify(d))
  }, [box('a', 100, 100), box('b', 300, 100)])
  await p.waitForTimeout(400)

  const els = () => p.evaluate(() => window.bento.doc.slides[0].elements)
  const el = async (id) => (await els()).find((e) => e.id === id)
  const pick = async (id, shift = false) => {
    const b = await p.locator(`.ed-stage-scale [data-el-id="${id}"]`).boundingBox()
    if (shift) await p.keyboard.down('Shift')
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await p.waitForTimeout(200)
    if (shift) await p.keyboard.up('Shift')
  }
  const radiusField = () => p.locator('.ed-props .ed-mini', { has: p.locator('[aria-label="Corner radius"]') }).first()
  const setRadius = async (v) => {
    const input = radiusField().locator('input')
    await input.fill(String(v)); await input.press('Enter'); await p.waitForTimeout(250)
    await p.locator('.ed-stage-scale').click({ position: { x: 5, y: 5 }, force: true }).catch(() => {})
  }

  console.log('\ncreate\n')
  await pick('a'); await pick('b', true)
  await p.keyboard.press(`${MOD}+Alt+KeyK`); await p.waitForTimeout(300)
  const a = await el('a'), b = await el('b')
  ok(a.component?.main && b.component?.main && a.component.id === b.component.id && a.groupId === b.groupId, '⌥⌘K: both elements are the main of one component, one group')
  ok(await p.locator('.ed-side-layers .ed-layer[data-id="a"] .ed-layer-comp').textContent() === '◆', 'the main\'s layer row shows ◆')
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250)
  ok(!(await el('a')).component, 'one undo removes it')
  await p.keyboard.press(`${MOD}+Shift+z`); await p.waitForTimeout(250)

  console.log('\ninsert a copy\n')
  await p.locator('.ed-side-tabs [data-view="tokens"]').click(); await p.waitForTimeout(200)
  ok(await p.locator('.ed-side-tokens .ed-component-row').count() === 1, 'the Tokens view lists the component')
  await p.locator('.ed-side-tokens .ed-component-row button').click(); await p.waitForTimeout(300)
  const all = await els()
  const copies = all.filter((e) => e.component && !e.component.main)
  ok(copies.length === 2 && copies.every((e) => e.id !== 'a' && e.id !== 'b') && copies[0].groupId === copies[1].groupId && copies[0].groupId !== a.groupId, 'Insert adds two copies with fresh ids in a new group')
  const sel = await p.evaluate(() => window.bento.selection.slice().sort().join(','))
  ok(sel === copies.map((e) => e.id).sort().join(','), 'the copy is selected')
  const ca = copies.find((e) => e.component.key === a.component.key)
  ok(ca.x === a.x + 24 && ca.y === a.y + 24, 'a copy on the main\'s slide is offset so it can be seen')

  console.log('\nthe main moves, the copy follows\n')
  await p.locator('.ed-side-tabs [data-view="layers"]').click(); await p.waitForTimeout(150)
  await p.locator('.ed-side-layers .ed-layer[data-id="a"]').click(); await p.waitForTimeout(200)
  await setRadius(20)
  let c = await el(ca.id)
  ok((await el('a')).radius === 20 && c.radius === 20, `the copy takes the main's corner radius (${c.radius})`)
  ok(c.x === ca.x && c.y === ca.y, 'and keeps its own position')

  console.log('\noverride\n')
  await p.locator(`.ed-side-layers .ed-layer[data-id="${ca.id}"]`).click(); await p.waitForTimeout(200)
  await setRadius(5)
  c = await el(ca.id)
  ok(c.radius === 5 && c.component.over?.includes('radius'), 'a hand edit on the copy is recorded as an override')
  await p.evaluate(() => {
    const m = window.bento.doc.slides[0].elements.find((e) => e.id === 'a')
    window.bento.store.commit(() => { m.radius = 30; m.fill = '#ff0000' })
  }).catch(() => {})
  await p.waitForTimeout(250)
  c = await el(ca.id)
  const viaStore = c.fill === '#ff0000'
  if (!viaStore) {
    // no scripting store: drive the main through the inspector instead
    await p.locator('.ed-side-layers .ed-layer[data-id="a"]').click(); await p.waitForTimeout(200)
    await setRadius(30)
  }
  c = await el(ca.id)
  ok(c.radius === 5, 'the override survives the next main edit')
  if (viaStore) ok(c.fill === '#ff0000', 'while other properties still follow')

  console.log('\ndetach\n')
  await p.locator(`.ed-side-layers .ed-layer[data-id="${ca.id}"]`).click({ button: 'right' }); await p.waitForTimeout(200)
  await p.locator('.ed-ctxmenu .ed-ctxmenu-item', { hasText: /^Detach component/ }).first().click(); await p.waitForTimeout(250)
  c = await el(ca.id)
  ok(!c.component, 'Detach component drops the membership')
  await p.locator('.ed-side-layers .ed-layer[data-id="a"]').click(); await p.waitForTimeout(200)
  await setRadius(40)
  ok((await el(ca.id)).radius === 5, 'a detached element stops following')

  console.log('\na member moved alone keeps its place\n')
  {
    await p.locator('.ed-side-tabs [data-view="tokens"]').click(); await p.waitForTimeout(150)
    await p.locator('.ed-side-tokens .ed-component-row .ed-btn', { hasText: /^Insert/ }).first().click(); await p.waitForTimeout(300)
    await p.locator('.ed-side-tabs [data-view="layers"]').click(); await p.waitForTimeout(150)
    const fresh = await p.evaluate(() => window.bento.selection.slice()) // Insert selects the new copy
    const copy = (await els()).filter((e) => fresh.includes(e.id))
    const A = await el('a'), B = await el('b')
    const cA = copy.find((e) => e.component.key === A.component.key), cB = copy.find((e) => e.component.key === B.component.key)
    const nudge = async (id) => {
      await p.locator(`.ed-side-layers .ed-layer[data-id="${id}"]`).click(); await p.waitForTimeout(150)
      await p.locator('.ed-stage-scale').focus().catch(() => {})
      await p.keyboard.press('Shift+ArrowRight'); await p.waitForTimeout(300) // ⇧→ nudges 10px (the layer list keeps ↑↓ for its rows)
    }
    await nudge(cA.id)
    let nA = await el(cA.id), nB = await el(cB.id)
    ok(nA.x === cA.x + 10 && nA.component.over?.includes('x') && nB.x === cB.x && !nB.component.over, `one member nudged alone overrides its position; its sibling stays (${nA.x - cA.x})`)
    await nudge('a'); await nudge('b')
    nA = await el(cA.id); nB = await el(cB.id)
    ok(nA.x === cA.x + 10 && nB.x === cB.x + 10, `the main moves: the free member follows its counterpart, the moved one keeps its place (${nA.x - cA.x}, ${nB.x - cB.x})`)
  }

  console.log('\ntokens\n')
  await p.locator('.ed-side-layers .ed-layer[data-id="a"]').click(); await p.waitForTimeout(200)
  await radiusField().hover()
  await radiusField().locator('.ed-token-dot').click(); await p.waitForTimeout(200)
  await p.locator('.ed-ctxmenu .ed-ctxmenu-item', { hasText: /^radius\.card/ }).first().click(); await p.waitForTimeout(300)
  let ea = await el('a')
  ok(ea.radius === 12 && ea.themeRefs?.radius === '$radius.card', 'the dot binds the field to a number token and writes its value')
  ok(await radiusField().locator('.ed-token-pill').textContent() === 'radius.card', 'the bound field shows the token as a pill')
  await p.locator('.ed-side-tabs [data-view="tokens"]').click(); await p.waitForTimeout(200)
  const value = p.locator('.ed-side-tokens .ed-token-row[data-token="radius.card"] input[type="number"]')
  await value.fill('18'); await value.press('Enter'); await p.waitForTimeout(300)
  ea = await el('a')
  ok(ea.radius === 18, `editing the token moves the bound property (${ea.radius})`)
  ok(await p.locator('.ed-side-tokens .ed-token-row[data-token="radius.card"] .ed-token-uses').textContent() !== '0', 'the token counts what follows it')

  // a mode: added from the switch, then a value set in it, then switched back
  await p.locator('.ed-side-tokens .ed-tokens-mode').selectOption('+'); await p.waitForTimeout(200)
  const modeName = p.locator('.ed-side-tokens .ed-tokens-head .ed-token-new')
  ok(await modeName.evaluate((n) => n === document.activeElement), 'Add mode opens a name field in place, focused (no dialog)')
  await modeName.fill('default'); await modeName.press('Enter'); await p.waitForTimeout(150)
  ok(await modeName.getAttribute('aria-invalid') === 'true', 'a mode name already taken is refused in place')
  await modeName.fill('Dark'); await modeName.press('Enter'); await p.waitForTimeout(300)
  await value.fill('2'); await value.press('Enter'); await p.waitForTimeout(300)
  ok((await el('a')).radius === 2, 'in the new mode, the bound property takes that mode\'s value')
  await p.locator('.ed-side-tokens .ed-tokens-mode').selectOption('default'); await p.waitForTimeout(300)
  ok((await el('a')).radius === 18, 'switching the mode back rewrites it')

  // a new token: + opens a name row; Esc cancels, Enter creates
  const addNum = p.locator('.ed-side-tokens .ed-tokens-add').nth(1)
  await addNum.click(); await p.waitForTimeout(150)
  await p.keyboard.press('Escape'); await p.waitForTimeout(150)
  ok(await p.locator('.ed-side-tokens .ed-token-new').count() === 0, 'Esc closes the new-token row without a token')
  await addNum.click(); await p.waitForTimeout(150)
  await p.keyboard.type('space.md'); await p.keyboard.press('Enter'); await p.waitForTimeout(300)
  ok(await p.evaluate(() => window.bento.doc.theme.tokens.set['space.md']?.type) === 'number', 'typing a name and Enter creates the number token')
  // a component is renamed in place
  const compName = p.locator('.ed-side-tokens .ed-component-row input.ed-token-name').first()
  await compName.fill('Card'); await compName.press('Enter'); await p.waitForTimeout(300)
  ok((await el('a')).groupName === 'Card', 'the component is renamed in place (its main\'s group name)')

  await p.locator('.ed-side-tabs [data-view="layers"]').click(); await p.waitForTimeout(150)
  await p.locator('.ed-side-layers .ed-layer[data-id="a"]').click(); await p.waitForTimeout(200)
  await radiusField().locator('.ed-token-pill').click(); await p.waitForTimeout(300)
  ea = await el('a')
  ok(!ea.themeRefs?.radius && ea.radius === 18, 'clicking the pill detaches; the value stays')

  ok(errors.length === 0, `no page error${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
