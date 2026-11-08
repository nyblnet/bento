// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// dash's shell matches slides' and spaces': the bar's order and look, one-line
// menus, the Share popover, the 🌐 menu, and a phone bar that never scrolls the
// page.
//
//   npm run build:single --prefix dash && node scripts/test-dash-chrome-browser.mjs
//   (DASH_SHELL=/path/to/Bento_Dash.bento.html to point it at another build)
//
// WHAT THIS PROVES, measured in the packaged document:
//   1. THE HOUSE ORDER. Left to right: mark · title · undo · redo · the insert
//      tools · Comment · … · Share · Save · 🌐 · ?. No version text and no
//      settings/theme button in the bar. Save is INK-FILLED (slides' primary).
//   2. SAVE ▾ IS ONE LINE PER ITEM — an icon, the name, the description as a
//      tooltip — and carries Version history…, Copy document JSON, Replace from
//      JSON… and Start from scratch…, as slides' does.
//   3. SHARE IS A POPOVER AND NOTHING CONNECTS UNTIL "GO LIVE". Every
//      WebSocket the page constructs is recorded: none at boot, none on opening
//      the popover; "Go live" opens exactly one to the relay (the positive
//      control — it shows the recorder sees connections at all).
//   4. THE LIVE STATE IS A WORD AT EVERY WIDTH: the Share button's label is
//      visible at 1440 and 1024, and on a folded bar it is a labelled row in ⋯.
//   5. 🌐 SWITCHES THE LANGUAGE LIVE — no reload (a marker survives), and the
//      bar's labels come back translated.
//   6. "START FROM SCRATCH…" leaves one blank sheet, and ⌘Z brings the whole
//      workbook back.
//   7. PHONE (320/360/390, touch): the DOCUMENT never scrolls sideways
//      (scrollWidth ≤ the device width); ⋯ is reachable and carries About, Settings,
//      Language, Help and Share; Share opens INSIDE ⋯ without closing it; the
//      properties panel has a visible ✕ that closes it.
//   8. ONE ACCENT: the comment colour is the accent, and the Comment tool in
//      the bar opens the composer.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const SHELL = process.env.DASH_SHELL
  ? new URL(`file://${process.env.DASH_SHELL}`).href
  : new URL('../dash/dist-single/Bento_Dash.bento.html', import.meta.url).href

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })

/** A page with every WebSocket recorded (and never really opened). */
async function fresh({ w = 1440, h = 900, mobile = false, accept = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile })
  await ctx.addInitScript(() => {
    window.__ws = []
    window.WebSocket = class extends EventTarget {
      constructor(u) { super(); window.__ws.push(String(u)); this.readyState = 0 }
      send() {} close() {}
    }
  })
  const p = await ctx.newPage()
  p.on('dialog', (d) => (accept ? d.accept() : d.dismiss()).catch(() => {}))
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(SHELL)
  await p.waitForSelector('.dx-bar', { timeout: 15000 })
  await p.waitForTimeout(500)
  return { p, ctx, errors }
}
const tryIt = async (fn) => { try { return await fn() } catch (e) { return `ERR ${String(e.message).split('\n')[0]}` } }

// ============================================================ 1 · order and look
console.log('the bar, at 1440')
{
  const { p, ctx, errors } = await fresh()
  const m = await p.evaluate(() => {
    const bar = document.querySelector('.dx-bar')
    const x = (sel) => { const el = bar.querySelector(sel); if (!el || !el.offsetParent) return null; return el.getBoundingClientRect().x }
    const ink = (() => { const d = document.createElement('div'); d.style.color = getComputedStyle(document.documentElement).getPropertyValue('--ink'); document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c })()
    const save = bar.querySelector('[data-act="save"]')
    return {
      xs: {
        mark: x('.dx-mark'), title: x('.dx-title'), undo: x('[data-act="undo"]'), redo: x('[data-act="redo"]'),
        formula: x('[data-act="formula"]'), story: x('[data-act="story"]'), comment: x('[data-act="comment"]'),
        share: x('.dx-share'), save: x('[data-act="save"]'), lang: x('.dx-lang-trig'), help: x('.dx-help-btn'),
      },
      text: bar.textContent,
      settingsInBar: !!bar.querySelector('[data-act="settings"]'),
      saveBg: save ? getComputedStyle(save).backgroundColor : '', ink,
    }
  })
  const order = ['mark', 'title', 'undo', 'redo', 'formula', 'story', 'comment', 'share', 'save', 'lang', 'help']
  const missing = order.filter((k) => m.xs[k] == null)
  ok(missing.length === 0, `every control of the house order is in the bar${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`)
  const seq = order.filter((k) => m.xs[k] != null)
  const sorted = [...seq].sort((a, b) => m.xs[a] - m.xs[b])
  ok(seq.join(' ') === sorted.join(' '), `left to right: ${order.join(' · ')} (measured: ${sorted.join(' · ')})`)
  ok(!/\bv\d+\.\d+\.\d+/.test(m.text), 'no version text in the bar (it lives in About)')
  ok(!m.settingsInBar, 'no settings/theme button in the bar (Settings is reached from About and ⋯)')
  ok(m.saveBg === m.ink, `Save is ink-filled, the suite's primary (background ${m.saveBg}, --ink ${m.ink})`)
  ok(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`)
  await ctx.close()
}

// ============================================================ 2 · Save ▾
console.log('\nthe Save ▾ menu')
{
  const { p, ctx } = await fresh()
  await p.locator('.dxs-caret').click()
  await p.waitForTimeout(150)
  const rows = await p.evaluate(() => [...document.querySelectorAll('.dxs-menu .dxs-item')].map((b) => ({
    name: (b.querySelector('.dx-mi-name') ?? b).textContent.trim(),
    h: b.getBoundingClientRect().height,
    tip: b.title,
    icon: !!b.querySelector('svg'),
    small: !!b.querySelector('small'),
    shownText: [...b.querySelectorAll('*')].filter((n) => n.childElementCount === 0 && n.offsetParent && n.getBoundingClientRect().height > 2).map((n) => n.textContent.trim()).filter(Boolean),
  })))
  ok(rows.length >= 8, `the menu has its rows (${rows.length})`)
  const tall = rows.filter((r) => r.h > 34 || r.small || r.shownText.length > 1)
  ok(tall.length === 0, `every row is ONE line (≤34px, one visible run of text)${tall.length ? ` — two-line: ${tall.map((r) => `${r.name} ${Math.round(r.h)}px`).join(', ')}` : ''}`)
  ok(rows.every((r) => r.icon), 'every row has an icon')
  ok(rows.filter((r) => r.name !== 'Save').every((r) => r.tip.length > 10), 'every row\'s description is its TOOLTIP')
  for (const want of ['Version history…', 'Copy document JSON', 'Replace from JSON…', 'Start from scratch…']) {
    ok(rows.some((r) => r.name === want), `"${want}" is in Save ▾, as in slides`)
  }
  await ctx.close()
}

// ============================================================ 3 · Share gating
console.log('\nShare: a popover, and nothing connects until "Go live"')
{
  const { p, ctx } = await fresh()
  ok((await p.evaluate(() => window.__ws.length)) === 0, 'a fresh workbook opens NO socket at boot')
  // …nor on an EDIT. The collaboration keys are minted a beat after boot, so
  // "sharing on" is true from then on; only the eligibility gate (the file
  // arrived shared, or the reader chose to share) stands between the first
  // keystroke and the relay. Measured without that gate: this edit connected.
  await p.locator('.dg-row .dg-cell[data-ci]').nth(2).click()
  await p.keyboard.type('edited')
  await p.keyboard.press('Enter')
  await p.waitForTimeout(300)
  ok((await p.evaluate(() => window.__ws.length)) === 0, 'and an edit does not connect it either')
  const opened = await tryIt(async () => { await p.locator('.dx-share').click(); await p.waitForTimeout(200); return true })
  ok(opened === true, `the Share button opens a popover (${opened})`)
  const pop = await p.evaluate(() => {
    const el = document.querySelector('.dx-share-pop')
    if (!el || !el.offsetParent) return null
    return {
      name: !!el.querySelector('input'),
      text: el.textContent,
      acts: [...el.querySelectorAll('[data-share]')].map((b) => b.dataset.share),
    }
  })
  ok(!!pop && pop.name, 'the popover asks for your name')
  ok(!!pop && /People/.test(pop.text) && /Share a copy/i.test(pop.text), 'it lists People and offers "Share a copy"')
  ok(!!pop && ['reading', 'invite', 'viewonly', 'golive'].every((a) => pop.acts.includes(a)),
    `reading copy · invite to edit · view-only copy · Go live are all there (${pop ? pop.acts.join(', ') : 'no popover'})`)
  ok((await p.evaluate(() => window.__ws.length)) === 0, 'opening the popover connects nothing')
  await tryIt(() => p.locator('[data-share="golive"]').click())
  await p.waitForTimeout(400)
  const ws = await p.evaluate(() => window.__ws)
  ok(ws.length === 1 && /^wss:\/\/[^/]+\/d\/w/.test(ws[0]), `"Go live" opens exactly one socket, to the room (positive control: ${ws.length} recorded)`)
  const lab = await p.evaluate(() => document.querySelector('.dx-share-lab')?.textContent)
  ok(lab === 'Live', `and the button now SAYS so: "${lab}"`)
  // A FILE THAT ARRIVES SHARED REJOINS ITS ROOM — which is what makes an invite
  // or a view-only copy worth sending. Saved from the live page, reopened: one
  // socket at boot, with no click. (The fresh workbook above opened none.)
  const html = await p.evaluate(() => window.bento.serialize())
  await ctx.close()
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const file = join(mkdtempSync(join(tmpdir(), 'dash-chrome-')), 'shared.bento.html')
  writeFileSync(file, html)
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx2.addInitScript(() => {
    window.__ws = []
    window.WebSocket = class extends EventTarget {
      constructor(u) { super(); window.__ws.push(String(u)); this.readyState = 0 }
      send() {} close() {}
    }
  })
  const p2 = await ctx2.newPage()
  await p2.goto(new URL(`file://${file}`).href)
  await p2.waitForSelector('.dx-bar', { timeout: 15000 })
  await p2.waitForTimeout(600)
  const ws2 = await p2.evaluate(() => window.__ws)
  ok(ws2.length === 1, `a saved SHARED workbook rejoins its room on open (${ws2.length} socket at boot)`)
  await ctx2.close()
}

// ============================================================ 4 · the word at every width
console.log('\nthe live state is a word at every width')
for (const w of [1440, 1024, 768]) {
  const { p, ctx } = await fresh({ w })
  const r = await p.evaluate(() => {
    const lab = document.querySelector('.dx-share-lab')
    const inMore = !!lab?.closest('.dx-more-menu')
    const vis = lab && lab.getBoundingClientRect().width > 8 && getComputedStyle(lab).display !== 'none'
    return { inMore, vis, text: lab?.textContent ?? '' }
  })
  if (r.inMore) {
    await tryIt(() => p.locator('.dx-more-trig').click())
    await p.waitForTimeout(150)
    const v = await p.evaluate(() => { const l = document.querySelector('.dx-more-menu .dx-share-lab'); return !!l && l.getBoundingClientRect().width > 8 })
    ok(v && r.text.length > 0, `${w}px: the bar is folded and Share is a LABELLED row in ⋯ ("${r.text}")`)
  } else {
    ok(r.vis && r.text.length > 0, `${w}px: the Share button carries its word in the bar ("${r.text}")`)
  }
  await ctx.close()
}

// ============================================================ 5 · 🌐, live
console.log('\nthe 🌐 menu switches the language without a reload')
{
  const { p, ctx } = await fresh()
  await p.evaluate(() => { window.__marker = 'still-here' })
  const did = await tryIt(async () => {
    await p.locator('.dx-lang-trig').click()
    await p.locator('.dx-lang-menu [data-lang="ja"]').click()
    await p.waitForTimeout(300)
    return true
  })
  ok(did === true, `🌐 is in the bar and offers 日本語 (${did})`)
  const r = await p.evaluate(() => ({
    marker: window.__marker,
    save: document.querySelector('.dx-save-lab')?.textContent,
    formula: document.querySelector('[data-act="formula"] span')?.textContent,
  }))
  ok(r.marker === 'still-here', 'no reload happened (a reload of a file:// page would drop unsaved work)')
  ok(r.save === '保存' && r.formula === '数式', `the bar is Japanese at once — Save "${r.save}", Formula "${r.formula}"`)
  await p.evaluate(() => localStorage.removeItem('bento-lang'))
  await ctx.close()
}

// ============================================================ 6 · Start from scratch
console.log('\nStart from scratch…')
{
  const { p, ctx } = await fresh({ accept: true })
  const before = await p.evaluate(() => [...document.querySelectorAll('.dx-tab')].length)
  const did = await tryIt(async () => {
    await p.locator('.dxs-caret').click()
    await p.locator('.dxs-item', { hasText: 'Start from scratch…' }).click()
    await p.waitForTimeout(300)
    return true
  })
  const after = await p.evaluate(() => ({ tabs: document.querySelectorAll('.dx-tab').length, cells: [...document.querySelectorAll('.dg-row .dg-cell[data-ci]')].filter((c) => c.textContent.trim()).length }))
  ok(did === true && before > 1 && after.tabs === 1 && after.cells === 0, `one blank sheet is left (tabs ${before} → ${after.tabs}, filled cells ${after.cells})`)
  await p.keyboard.press('ControlOrMeta+z')
  await p.waitForTimeout(300)
  const back = await p.evaluate(() => document.querySelectorAll('.dx-tab').length)
  ok(back === before, `⌘Z brings the whole workbook back (${back} tabs)`)
  await ctx.close()
}

// ============================================================ 7 · phone
console.log('\nphone widths')
for (const w of [320, 360, 390]) {
  const { p, ctx, errors } = await fresh({ w, h: 780, mobile: true })
  // Against the DEVICE width, not innerWidth: on a mobile viewport the layout
  // viewport GROWS to fit overflowing content (measured on the old bar: 509px
  // of document reported innerWidth 509 at a 390px device), so innerWidth
  // would pass the very bug this checks for.
  const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }))
  ok(m.sw <= w && m.iw <= w, `${w}px: the document never scrolls sideways (scrollWidth ${m.sw}, layout viewport ${m.iw}, device ${w})`)
  const more = await tryIt(async () => {
    const t = p.locator('.dx-more-trig')
    await t.scrollIntoViewIfNeeded()
    await t.tap()
    await p.waitForTimeout(200)
    return true
  })
  ok(more === true, `${w}px: ⋯ is reachable (${more})`)
  const items = await p.evaluate(() => {
    const menu = document.querySelector('.dx-more-menu')
    // position: fixed on a phone, so offsetParent is null — measure the box
    const r = menu?.getBoundingClientRect()
    if (!menu || !r.width || getComputedStyle(menu).display === 'none') return null
    return { text: menu.textContent, inside: r.left >= 0 && r.right <= innerWidth + 0.5, share: !!menu.querySelector('.dx-share'), lang: !!menu.querySelector('.dx-lang-trig') }
  })
  ok(!!items && items.inside, `${w}px: ⋯ opens on screen`)
  ok(!!items && /About/.test(items.text) && /Settings/.test(items.text) && items.lang && /shortcuts/i.test(items.text) && items.share,
    `${w}px: ⋯ carries About, Settings, Language, Help and Share`)
  if (w === 390) {
    await tryIt(() => p.locator('.dx-more-menu .dx-share').tap())
    await p.waitForTimeout(200)
    const st = await p.evaluate(() => ({
      more: document.querySelector('.dx-more-dd')?.classList.contains('open'),
      pop: (document.querySelector('.dx-share-pop')?.getBoundingClientRect().height ?? 0) > 40,
    }))
    ok(st.more && st.pop, `Share opens INSIDE ⋯ without closing it (⋯ open ${st.more}, popover shown ${st.pop})`)
    await p.mouse.click(200, 600)
    const panel = await tryIt(async () => {
      await p.locator('.dx-format-btn').tap()
      await p.waitForTimeout(300)
      const x = await p.evaluate(() => {
        const b = document.querySelector('.dp-panel .dx-panel-close')
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { shown: r.width > 20 && r.right <= innerWidth && r.top >= 0, shut: document.querySelector('.dp-panel.dp-right').classList.contains('dp-shut') }
      })
      if (!x) return 'no close button'
      if (x.shut) return 'Format did not open the panel'
      if (!x.shown) return 'the close button is not on screen'
      await p.locator('.dp-panel .dx-panel-close').tap()
      await p.waitForTimeout(300)
      return await p.evaluate(() => document.querySelector('.dp-panel.dp-right').classList.contains('dp-shut')) ? true : 'still open'
    })
    ok(panel === true, `the properties panel opens from Format and has a ✕ that closes it (${panel})`)
  }
  ok(errors.length === 0, `${w}px: no page errors${errors.length ? `: ${errors[0]}` : ''}`)
  await ctx.close()
}

// ============================================================ 8 · one accent, and Comment
console.log('\none accent, and Comment is a tool')
{
  const { p, ctx } = await fresh()
  const c = await p.evaluate(() => {
    const d = document.createElement('div')
    document.body.append(d)
    const res = (v) => { d.style.color = `var(${v})`; return getComputedStyle(d).color }
    const out = { cmt: res('--cmt'), accent: res('--accent') }
    d.remove()
    return out
  })
  ok(c.cmt === c.accent, `comments wear the accent, not a second colour (${c.cmt} vs ${c.accent})`)
  const did = await tryIt(async () => {
    await p.locator('.dg-row .dg-cell').nth(3).click()
    await p.locator('[data-act="comment"]').click()
    await p.waitForTimeout(200)
    return await p.evaluate(() => !!document.querySelector('.dxc-pop textarea'))
  })
  ok(did === true, `the Comment tool in the bar opens the composer (${did})`)
  await ctx.close()
}

await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
