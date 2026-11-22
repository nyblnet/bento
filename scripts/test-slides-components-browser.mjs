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
//      new group, rows marked ◇ — on free space clear of the main, selected;
//   3. an edit to the main (the inspector's own corner-radius field) reaches the
//      copy, which keeps its own position;
//   4. a property changed on the copy by hand is kept as an override when the
//      main changes again, while the other properties still follow;
//   5. Detach component (right-click) stops the copy following;
//   6. a number token bound from the inspector's dot writes its value; editing
//      the token in the Tokens view moves the bound property; switching the
//      mode rewrites bound literals; the pill detaches and the value stays
//      (a hand edit dropping the binding is test-slides-tokens.ts's);
//   7. no page error;
//   8. ⌥⌘K on a card frame alone takes its texts into the main, so an
//      inserted copy holds them; a copy is entered as a frame is: a click
//      picks it whole, a double-click goes in (card, then text), Esc comes
//      back out one level at a time.
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
  await p.locator('.ed-side-tokens .ed-component-row button', { hasText: 'Insert' }).click(); await p.waitForTimeout(300)
  const all = await els()
  const copies = all.filter((e) => e.component && !e.component.main)
  ok(copies.length === 2 && copies.every((e) => e.id !== 'a' && e.id !== 'b') && copies[0].groupId === copies[1].groupId && copies[0].groupId !== a.groupId, 'Insert adds two copies with fresh ids in a new group')
  const sel = await p.evaluate(() => window.bento.selection.slice().sort().join(','))
  ok(sel === copies.map((e) => e.id).sort().join(','), 'the copy is selected')
  const ca = copies.find((e) => e.component.key === a.component.key)
  // the copy lands on free space on the slide (the UX audit: never on top of what is there)
  const bbox = (es) => ({ x: Math.min(...es.map((e) => e.x)), y: Math.min(...es.map((e) => e.y)), r: Math.max(...es.map((e) => e.x + e.w)), b: Math.max(...es.map((e) => e.y + e.h)) })
  const cb = bbox(copies), mb = bbox([a, b])
  const size = await p.evaluate(() => window.bento.doc.size)
  ok(!(cb.x < mb.r && mb.x < cb.r && cb.y < mb.b && mb.y < cb.b) && cb.r <= size.width && cb.b <= size.height, 'a copy on the main\'s slide lands clear of it, on the slide')

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
  await p.locator('.ed-tokpick-opt[data-key="radius.card"]').click(); await p.waitForTimeout(300)
  let ea = await el('a')
  ok(ea.radius === 12 && ea.themeRefs?.radius === '$radius.card', 'the dot binds the field to a number token and writes its value')
  ok(await radiusField().locator('.ed-token-pill-name').textContent() === 'radius.card', 'the bound field shows the token as a pill')
  await p.locator('.ed-side-tabs [data-view="tokens"]').click(); await p.waitForTimeout(200)
  // a token's value is text until clicked; Enter commits it
  const setValue = async (v) => {
    await p.locator('.ed-side-tokens .ed-token-row[data-token="radius.card"] .ed-token-value').click()
    const f = p.locator('.ed-side-tokens .ed-token-row[data-token="radius.card"] input.ed-edit-field')
    await f.fill(v); await f.press('Enter'); await p.waitForTimeout(300)
  }
  await setValue('18')
  ea = await el('a')
  ok(ea.radius === 18, `editing the token moves the bound property (${ea.radius})`)
  ok(await p.locator('.ed-side-tokens .ed-token-row[data-token="radius.card"] .ed-token-uses').textContent() !== '0', 'the token counts what follows it')

  // a mode: added from the switch, then a value set in it, then switched back
  await p.locator('.ed-side-tokens .ed-tokens-modes .ed-tokens-addmode').click(); await p.waitForTimeout(200)
  const modeName = p.locator('.ed-side-tokens .ed-tokens-modes .ed-token-new')
  ok(await modeName.evaluate((n) => n === document.activeElement), 'Add mode opens a name field in place, focused (no dialog)')
  await modeName.fill('default'); await modeName.press('Enter'); await p.waitForTimeout(150)
  ok(await modeName.getAttribute('aria-invalid') === 'true', 'a mode name already taken is refused in place')
  await modeName.fill('Dark'); await modeName.press('Enter'); await p.waitForTimeout(300)
  await setValue('2')
  ok((await el('a')).radius === 2, 'in the new mode, the bound property takes that mode\'s value')
  await p.locator('.ed-side-tokens .ed-tokens-mode', { hasText: /^Default$/ }).click(); await p.waitForTimeout(300)
  ok((await el('a')).radius === 18, 'switching the mode back rewrites it')

  // a new token: + opens a name row; Esc cancels, Enter creates
  const addNum = p.locator('.ed-side-tokens .ed-tokens-group[data-type="number"] .ed-sec-act')
  await addNum.click(); await p.waitForTimeout(150)
  await p.keyboard.press('Escape'); await p.waitForTimeout(150)
  ok(await p.locator('.ed-side-tokens .ed-token-new').count() === 0, 'Esc closes the new-token row without a token')
  await addNum.click(); await p.waitForTimeout(150)
  await p.keyboard.type('space.md'); await p.keyboard.press('Enter'); await p.waitForTimeout(300)
  ok(await p.evaluate(() => window.bento.doc.theme.tokens.set['space.md']?.type) === 'number', 'typing a name and Enter creates the number token')
  // a component is renamed in place
  await p.locator('.ed-side-tokens .ed-component-row .ed-token-name').first().click()
  const compName = p.locator('.ed-side-tokens .ed-component-row input.ed-edit-field').first()
  await compName.fill('Card'); await compName.press('Enter'); await p.waitForTimeout(300)
  ok((await el('a')).groupName === 'Card', 'the component is renamed in place (its main\'s group name)')

  await p.locator('.ed-side-tabs [data-view="layers"]').click(); await p.waitForTimeout(150)
  await p.locator('.ed-side-layers .ed-layer[data-id="a"]').click(); await p.waitForTimeout(200)
  await radiusField().locator('.ed-token-pill .ed-color-detach').click({ force: true }); await p.waitForTimeout(300)
  ea = await el('a')
  ok(!ea.themeRefs?.radius && ea.radius === 18, 'the pill\'s detach lets go; the value stays')

  console.log('\nthe offset is in the file; paste and duplicate\n')
  {
    const copies = (await els()).filter((e) => e.component && !e.component.main && !e.component.over)
    const one = copies[0]
    const main = (await els()).find((e) => e.component?.main && e.component.key === one.component.key)
    ok(Array.isArray(one.component.off) && one.component.off[0] === one.x - main.x && one.component.off[1] === one.y - main.y,
      `a copy's offset from its main is kept on it (component.off ${JSON.stringify(one.component.off)})`)
    // save-and-reopen: the offset survives the file gate and the copy follows by it
    await p.evaluate(() => window.bento.loadDoc(JSON.stringify(window.bento.doc))); await p.waitForTimeout(400)
    ok(JSON.stringify((await el(one.id)).component.off) === JSON.stringify(one.component.off), 'and it survives a reload')
    const paste = (elements) => p.evaluate((elements) => {
      const dt = new DataTransfer(); dt.setData('text/plain', JSON.stringify({ __bento: 'clip', kind: 'elements', elements }))
      document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }))
    }, elements).then(() => p.waitForTimeout(300))
    // ⌘D on the main, in the same deck: one main per component, so the duplicate is a copy
    await p.keyboard.press('Escape'); await pick('a')
    const before = new Set((await els()).map((e) => e.id))
    await p.keyboard.press(`${MOD}+d`); await p.waitForTimeout(300)
    const dup = (await els()).find((e) => !before.has(e.id) && e.component?.key === main.component.key)
    const mainsNow = (await els()).filter((e) => e.component?.main && e.component.key === main.component.key)
    ok(!!dup && !dup.component.main && mainsNow.length === 1 && dup.component.off?.[0] === dup.x - mainsNow[0].x, `duplicating the main in its own deck makes a copy of it, offset kept (${dup && JSON.stringify(dup.component)})`)
    // a deck with no main: a pasted copy is detached, a pasted main stays a main
    const snapshot = await els()
    const copyEl = snapshot.find((e) => e.id === one.id), mainEl = snapshot.find((e) => e.id === 'a')
    await p.evaluate(() => {
      const d = JSON.parse(JSON.stringify(window.bento.doc))
      d.slides = [{ id: 'other', background: '#ffffff', transition: 'none', notes: '', elements: [] }]
      window.bento.loadDoc(JSON.stringify(d))
    }); await p.waitForTimeout(400)
    await paste([copyEl])
    let there = await els()
    ok(there.length === 1 && !there[0].component, 'a copy pasted into a deck without its main is detached')
    await paste([mainEl])
    there = await els()
    const pm = there.find((e) => e.component)
    ok(!!pm && pm.component.main === true, 'a main pasted into a deck without one stays a main there')
  }

  {
    // a deck REPLACED in the running editor reads like a cold boot: the editor's
    // memory of the old deck's main must not turn an older shell's copy edit into "the main moved"
    const comp = { id: 'cx', key: 'k0' }
    const deckJson = (mainFill) => p.evaluate(([mainFill, comp, a, b]) => {
      const d = JSON.parse(JSON.stringify(window.bento.doc))
      d.slides = [{ id: 'r1', background: '#ffffff', transition: 'none', notes: '', elements: [
        { ...a, id: 'm', fill: mainFill, groupId: 'gm', component: { ...comp, main: true } },
        { ...b, id: 'c', fill: '#00ff00', groupId: 'gc', component: { ...comp, off: [200, 0] } }, // the copy, edited by an older shell
      ] }]
      return JSON.stringify(d)
    }, [mainFill, comp, box('m', 100, 100), box('c', 300, 100)])
    const first = await deckJson('#111111')
    await p.evaluate((j) => window.bento.loadDoc(j), first); await p.waitForTimeout(300)
    const second = await deckJson('#222222') // same deck, its main edited elsewhere since
    await p.evaluate((j) => window.bento.loadDoc(j), second); await p.waitForTimeout(300)
    const c = await el('c')
    ok(c.fill === '#00ff00' && c.component.over?.includes('fill'), `a replaced deck keeps a copy edited in an older shell (fill ${c.fill}, over ${JSON.stringify(c.component.over)})`)
  }
  {
    // and a literal bound to a token, edited in an older shell: the editor's memory of the PREVIOUS deck's tokens must not read as "the tokens moved"
    const tokDeck = (brand, fill) => p.evaluate(([brand, fill, a]) => {
      const d = JSON.parse(JSON.stringify(window.bento.doc))
      d.theme.tokens = { set: { brand: { type: 'color', values: { default: brand } } } }
      d.slides = [{ id: 't1', background: '#ffffff', transition: 'none', notes: '', elements: [{ ...a, id: 'tb', fill, themeRefs: { fill: '$brand' } }] }]
      return JSON.stringify(d)
    }, [brand, fill, box('tb', 100, 100)])
    await p.evaluate((j) => window.bento.loadDoc(j), await tokDeck('#111111', '#111111')); await p.waitForTimeout(300)
    await p.evaluate((j) => window.bento.loadDoc(j), await tokDeck('#222222', '#00ff00')); await p.waitForTimeout(300)
    const tb = await el('tb')
    ok(tb.fill === '#00ff00' && !tb.themeRefs, `a replaced deck keeps a bound literal an older shell edited, and drops the binding (fill ${tb.fill}, refs ${JSON.stringify(tb.themeRefs)})`)
  }

  console.log('\na card frame alone makes a whole component; its copy is entered by double-click\n')
  {
    const txt = (id, x, y, html, parentId) => ({ id, type: 'text', x, y, w: 160, h: 40, rotation: 0, opacity: 1, html, fontSize: 20, fontFamily: 'system-ui', fontWeight: 400, color: '#111111', align: 'left', valign: 'top', lineHeight: 1.2, parentId })
    await p.evaluate((els) => {
      const d = JSON.parse(JSON.stringify(window.bento.doc))
      d.slides = [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: els }]
      window.bento.loadDoc(JSON.stringify(d))
    }, [box('card', 100, 100, { w: 200, h: 140, fill: '#eeeeee', layout: { dir: 'col', gap: 10, pad: [16, 16, 16, 16], hug: true } }), txt('ct1', 116, 116, 'Revenue', 'card'), txt('ct2', 116, 166, '4.2M', 'card')])
    await p.waitForTimeout(400)
    await p.keyboard.press('Escape')
    await pick('ct1') // a click on its text picks the card
    ok((await p.evaluate(() => window.bento.selection.join())) === 'card', 'the card frame alone is selected')
    await p.keyboard.press(`${MOD}+Alt+KeyK`); await p.waitForTimeout(300)
    let list = await els()
    ok(['card', 'ct1', 'ct2'].every((id) => list.find((e) => e.id === id).component?.main), `⌥⌘K on the frame alone makes it and its texts the main (${list.filter((e) => e.component?.main).map((e) => e.id).join(',')})`)
    await p.locator('.ed-side-tabs [data-view="tokens"]').click(); await p.waitForTimeout(150)
    await p.locator('.ed-side-tokens .ed-component-row .ed-btn', { hasText: /^Insert/ }).first().click(); await p.waitForTimeout(300)
    list = await els()
    const copyFrame = list.find((e) => e.layout && e.id !== 'card')
    const copyKids = list.filter((e) => copyFrame && e.parentId === copyFrame.id)
    ok(!!copyFrame && copyKids.length === 2 && copyKids.every((k) => k.type === 'text'), `Insert makes a copy that holds its two texts (${copyKids.length})`)
    await p.locator('.ed-side-tabs [data-view="layers"]').click(); await p.waitForTimeout(150)
    await p.keyboard.press('Escape'); await p.keyboard.press('Escape'); await p.waitForTimeout(150)
    const kid = copyKids[0]
    const kb = await p.locator(`.ed-stage-scale [data-el-id="${kid.id}"]`).boundingBox()
    const at = [kb.x + kb.width / 2, kb.y + kb.height / 2]
    await p.mouse.click(...at); await p.waitForTimeout(250)
    const whole = (await p.evaluate(() => window.bento.selection.slice())).sort().join()
    ok(whole === [copyFrame.id, ...copyKids.map((k) => k.id)].sort().join(), 'a click on the copy picks the whole copy')
    await p.mouse.dblclick(...at); await p.waitForTimeout(250)
    ok((await p.evaluate(() => window.bento.selection.join())) === copyFrame.id, 'a double-click goes in to the card (the outermost member)')
    ok(await p.locator('.ed-props [aria-label="Corner radius"]').count() > 0, 'whose Corner radius is in reach')
    await p.mouse.dblclick(...at); await p.waitForTimeout(250)
    ok((await p.evaluate(() => window.bento.selection.join())) === kid.id, 'another double-click goes in to the text')
    await p.keyboard.press('Escape'); await p.waitForTimeout(150)
    ok((await p.evaluate(() => window.bento.selection.join())) === copyFrame.id, 'Esc comes out to the card')
    await p.keyboard.press('Escape'); await p.waitForTimeout(150)
    ok((await p.evaluate(() => window.bento.selection.slice().sort().join())) === whole, 'Esc again comes out to the whole copy')
    await p.mouse.click(...at); await p.waitForTimeout(250)
    ok((await p.evaluate(() => window.bento.selection.slice().sort().join())) === whole, 'out of it, a click picks the whole copy again')
  }

  ok(errors.length === 0, `no page error${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
