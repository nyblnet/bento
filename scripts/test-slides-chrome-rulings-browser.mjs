// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Slides' chrome against the maintainer's D1–D8 rulings, measured in the packaged document.
//
//   npm run build:single --prefix slides && node scripts/test-slides-chrome-rulings-browser.mjs
//
// WHAT THIS PROVES (seven items from spaces' bar-parity pass, #572):
//   1. D2, as revised 2026-09-26 — Save-as and Share rows stay one line with
//      the description as the hover tooltip AND as a visually-hidden
//      aria-describedby node, and both menus fit the screen;
//   2. D4 — dialog titles (help, Version history) are 17px/650, not the
//      browser's 19.5px/700 h2;
//   3. D8 — help-sheet shortcuts are in the interface face, right-aligned;
//   4. at the compact tier the Save caret keeps its ▾, and its name stays
//      "Save as…" (the glyph is aria-hidden);
//   5. on a phone, rows in ⋯ read from the start edge, not centred;
//   6. keyboard focus draws a designed ring (--accent-ink, 2px): outside on a
//      bar button, inside on a menu row, 3:1 on its surface in both themes;
//   7. the dark theme's menu shadow is its own, not the light navy at 14%.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
// computed colours are rgb()/rgba(), except color-mix(), which computes to
// color(srgb r g b) in 0–1
const rgb = (s) => { const n = s.match(/[\d.]+/g).slice(0, 3).map(Number); return s.startsWith('color(') ? n.map((v) => v * 255) : n }
const lum = ([r, g, b]) => { const c = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }; return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b) }
const contrast = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const THEMES = ['light', 'dark']

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('dialog', (d) => d.accept())
  await p.route(/^https?:/, (r) => r.abort())
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar .ed-split-caret'))
  const theme = (th) => p.evaluate((t) => { document.documentElement.dataset.theme = t }, th)
  const closeAll = () => p.evaluate(() => {
    document.querySelectorAll('.ed-dropdown.open').forEach((d) => d.classList.remove('open'))
    document.querySelectorAll('.ed-about-overlay').forEach((o) => o.remove())
  })
  const openSave = () => p.evaluate(() => document.querySelector('.ed-split-caret').click())

  // --- 1. D2 descriptions ------------------------------------------------------
  console.log('D2 (revised): Save-as rows are one line, the description a tooltip and an ARIA description\n')
  await openSave()
  const save = await p.evaluate(() => [...document.querySelectorAll('.ed-save-menu > .ed-btn')].map((b) => {
    const id = b.getAttribute('aria-describedby'), d = id && document.getElementById(id)
    const r = d?.getBoundingClientRect()
    return { name: b.getAttribute('aria-label') ?? b.textContent.trim(), h: b.getBoundingClientRect().height, title: b.title,
      desc: d?.textContent ?? '', hidden: !!(d && r.width <= 1 && r.height <= 1), inRow: !!(d && b.contains(d)), second: !!b.querySelector('.ed-mi-desc') }
  }))
  const described = save.filter((x) => x.desc)
  ok(described.length >= 8, `${described.length} of ${save.length} Save-as rows carry a description (Export slides as images opens a dialog that explains itself)`)
  ok(save.every((x) => Math.abs(x.h - 30) <= 0.5 && !x.second), `every row is one 30px line (${[...new Set(save.map((x) => x.h))].join('/')}px)`)
  ok(described.every((x) => x.title === x.desc), 'the description is the row\'s hover tooltip (title)')
  ok(described.every((x) => x.hidden && x.inRow), '…and the same text is the aria-describedby target, visually hidden inside the row')
  // the name stays the name: the description is announced AS a description
  const replaceRow = p.getByRole('button', { name: 'Replace from JSON…', exact: true })
  ok(await replaceRow.count() === 1, 'a described row keeps its bare name ("Replace from JSON…"), not name+description')
  const menuW = await p.evaluate(() => document.querySelector('.ed-save-menu').getBoundingClientRect().width)
  ok(menuW <= 264.5 && menuW >= 240, `the list keeps spaces' width for it (${menuW}px, 240–264)`)
  // on a short window (phone landscape) it must scroll, not run off the
  // bottom with its last commands out of reach
  await closeAll()
  await p.setViewportSize({ width: 1280, height: 260 })
  await openSave()
  const fit = await p.evaluate(() => { const m = document.querySelector('.ed-save-menu'); const last = m.lastElementChild; last.scrollIntoView({ block: 'nearest' }); const r = last.getBoundingClientRect(); return { bottom: Math.round(m.getBoundingClientRect().bottom), lastBottom: Math.round(r.bottom), vh: innerHeight } })
  ok(fit.bottom <= fit.vh && fit.lastBottom <= fit.vh, `at 260px tall the list ends on screen (${fit.bottom} ≤ ${fit.vh}) and its last row scrolls into reach`)
  await closeAll()
  await p.setViewportSize({ width: 1440, height: 900 })
  await theme('light')
  await p.setViewportSize({ width: 1440, height: 768 })
  await p.evaluate(() => document.querySelector('.ed-btn-share').click())
  const share = await p.evaluate(() => [...document.querySelectorAll('.ed-share-pop .ed-share-btn')].map((b) => {
    const id = b.getAttribute('aria-describedby'), d = id && document.getElementById(id), r = d?.getBoundingClientRect()
    return { title: b.title, desc: d?.textContent ?? '', hidden: !!(d && r.width <= 1 && r.height <= 1 && b.contains(d)), tall: b.getBoundingClientRect().height }
  }))
  const shared = share.filter((x) => x.desc)
  ok(share.length >= 5 && shared.length === share.length, `Share's ${share.length} actions each carry a description`)
  ok(shared.every((x) => x.title === x.desc && x.hidden), 'as the hover tooltip, and as a visually hidden aria-describedby target in the row')
  ok(share.every((x) => x.tall <= 36), `every Share row is one line (${[...new Set(share.map((x) => Math.round(x.tall)))].join('/')}px tall)`)
  const shareBottom = await p.evaluate(() => Math.round(document.querySelector('.ed-share-pop').getBoundingClientRect().bottom))
  ok(shareBottom <= 768, `the Share menu ends on a 768px laptop screen (bottom ${shareBottom})`)
  await p.setViewportSize({ width: 1440, height: 900 })
  await closeAll()
  await theme('light')

  // --- 2. D4 dialog titles ----------------------------------------------------
  console.log('\nD4: dialog titles 17px/650\n')
  const title = () => p.evaluate(() => { const h = document.querySelector('.ed-about-overlay h2'); const c = getComputedStyle(h); return `${c.fontSize}/${c.fontWeight}` })
  await p.evaluate(() => document.querySelector('.ed-btn-help').click())
  ok(await title() === '17px/650', `help sheet title ${await title()}`)

  // --- 3. D8 shortcuts ----------------------------------------------------------
  console.log('\nD8: help shortcuts in the interface face, right-aligned\n')
  const k = await p.evaluate(() => {
    const kbd = document.querySelector('.ed-help-row kbd'), row = kbd.parentElement
    const col = parseFloat(getComputedStyle(row).gridTemplateColumns)
    return { font: getComputedStyle(kbd).fontFamily, ui: getComputedStyle(document.body).fontFamily, right: kbd.getBoundingClientRect().right - row.getBoundingClientRect().left, col }
  })
  ok(k.font === k.ui && !/mono/i.test(k.font), `shortcut face = interface face (${k.font.split(',')[0]})`)
  ok(Math.abs(k.right - k.col) < 1, `shortcut ends at its column's edge (${k.right.toFixed(1)} of ${k.col}px)`)
  await closeAll()
  await openSave()
  await p.evaluate(() => [...document.querySelectorAll('.ed-save-menu .ed-btn')].find((b) => b.textContent.startsWith('Version history')).click())
  await p.waitForSelector('.ed-version-box h2')
  ok(await title() === '17px/650', `Version history title ${await title()}`)
  await closeAll()

  // --- 4. compact caret ---------------------------------------------------------
  console.log('\ncompact tier: the Save caret keeps its ▾\n')
  await p.setViewportSize({ width: 1100, height: 800 })
  await p.waitForFunction(() => { const b = document.querySelector('.ed-topbar'); return b.classList.contains('ed-bar-compact') && !b.classList.contains('ed-bar-fold') })
  const caret = await p.evaluate(() => { const s = document.querySelector('.ed-split-caret .ed-caret'); const r = s.getBoundingClientRect(); return { w: r.width, text: s.textContent, disp: getComputedStyle(s).display } })
  ok(caret.disp !== 'none' && caret.w > 0 && caret.text === '▾', `▾ is drawn (${caret.disp}, ${caret.w.toFixed(1)}px)`)
  // the glyph is decoration: the button's name stays its title, at every tier
  ok(await p.getByRole('button', { name: 'Save as… — copy, new deck, password', exact: true }).count() === 1, 'the caret is still named "Save as… — copy, new deck, password", not "▾"')

  // --- 5. phone rows --------------------------------------------------------------
  console.log('\nphone: ⋯ rows read from the start edge\n')
  await p.setViewportSize({ width: 390, height: 844 })
  await p.waitForFunction(() => document.querySelector('.ed-topbar')?.classList.contains('ed-bar-fold'))
  await p.evaluate(() => [...document.querySelectorAll('.ed-topbar .ed-phone-only > .ed-btn')].find((b) => b.textContent.includes('⋯')).click())
  const rows = await p.evaluate(() => {
    const menu = [...document.querySelectorAll('.ed-dropdown.open > .ed-menu')].pop()
    return [...menu.querySelectorAll(':scope > .ed-btn')].filter((b) => b.getBoundingClientRect().width).map((b) => {
      const kid = b.firstElementChild.getBoundingClientRect(), r = b.getBoundingClientRect()
      return { name: b.textContent.trim().slice(0, 20), inset: kid.left - r.left, jc: getComputedStyle(b).justifyContent }
    })
  })
  const centred = rows.filter((r) => r.jc === 'center' || r.inset > 20)
  ok(rows.length >= 5 && centred.length === 0, `${rows.length} rows, all start-aligned${centred.length ? ' — centred: ' + centred.map((r) => `${r.name} (${r.inset.toFixed(0)}px)`).join(', ') : ''}`)
  await closeAll()
  await p.setViewportSize({ width: 1440, height: 900 })
  await p.waitForFunction(() => !document.querySelector('.ed-topbar')?.classList.contains('ed-bar-fold'))

  // --- 6. focus ring --------------------------------------------------------------
  console.log('\nfocus: a designed ring, both themes\n')
  const ring = () => p.evaluate(() => {
    const a = document.activeElement, c = getComputedStyle(a)
    const probe = document.createElement('div'); probe.style.color = 'var(--accent-ink)'; document.body.appendChild(probe)
    const accentInk = getComputedStyle(probe).color; probe.remove()
    let bgEl = a.closest('.ed-menu') ?? document.querySelector('.ed-topbar')
    return { cls: a.className, style: c.outlineStyle, width: c.outlineWidth, color: c.outlineColor, offset: c.outlineOffset, accentInk, bg: getComputedStyle(bgEl).backgroundColor, visible: a.matches(':focus-visible') }
  })
  for (const th of THEMES) {
    await theme(th)
    await p.locator('.ed-title').click()
    await p.keyboard.press('Shift+Tab') // back from the title to the logo / update chip
    const bar = await ring()
    ok(bar.visible && bar.style === 'solid' && bar.width === '2px' && bar.color === bar.accentInk && parseFloat(bar.offset) >= 2,
      `${th}: a bar control shows a 2px --accent-ink ring outside it (${bar.cls}: ${bar.style} ${bar.width} ${bar.color} offset ${bar.offset})`)
    const r1 = contrast(bar.color, bar.bg)
    ok(r1 >= 3, `${th}: bar ring ${r1.toFixed(2)}:1 on the bar ≥ 3`)
    await p.locator('.ed-split-caret').focus()
    await p.keyboard.press('Enter')
    await p.keyboard.press('Tab')
    const row = await ring()
    ok(row.visible && row.cls.includes('ed-btn') && row.style === 'solid' && parseFloat(row.offset) < 0,
      `${th}: a menu row's ring sits inside it (offset ${row.offset})`)
    const r2 = contrast(row.color, row.bg)
    ok(r2 >= 3, `${th}: row ring ${r2.toFixed(2)}:1 on the menu ≥ 3`)
    await closeAll()
  }

  // --- 7. dark menu shadow ----------------------------------------------------------
  console.log('\nmenu shadow per theme\n')
  const shadows = {}
  for (const th of THEMES) {
    await theme(th)
    await openSave()
    shadows[th] = await p.evaluate(() => getComputedStyle(document.querySelector('.ed-save-menu')).boxShadow)
    await closeAll()
  }
  ok(/rgba\(20, 30, 45, 0\.14\)/.test(shadows.light), `light keeps navy at 14% (${shadows.light})`)
  ok(shadows.dark !== shadows.light && /rgba\(0, 0, 0, 0\.5\)/.test(shadows.dark), `dark has its own, black at 50% (${shadows.dark})`)

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
