// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Every text field, select and textarea in dash's chrome wears the ONE field look.
//
//   npm run build:single --prefix dash && node scripts/test-dash-fields-browser.mjs
//
// Ported from scripts/test-slides-fields-browser.mjs (slides is the reference;
// docs/DECISIONS.md 2026-10-17, "the suite's one field look"). WHAT THIS PROVES,
// measured in the packaged document, in light AND dark theme:
//   1. every visible field on every surface — the formula bar, the properties
//      panel on a dataset and on a spreadsheet, About, Replace from JSON,
//      Settings, find, the column filter, the formula column, chart, pivot, 3D,
//      a story step, the comment composer, tab rename, conditional formatting,
//      split into columns, print — has a 1px SOLID border in the computed
//      --line colour, a --field fill, a 6px radius and (single-line fields) a
//      26px height. The browser's own dress is a 2px INSET border, square
//      corners, and in dark theme a #3b3b3b fill;
//   2. a focused field shows the ring: a 2px solid --accent-ink outline;
//   3. each surface really opened — a floor on how many fields it shows INSIDE
//      its own container — so a surface that silently failed to open cannot
//      pass, since the panel's fields are on the page whatever else is open;
//   4. the check itself works: a field with its author styles reverted (the
//      browser's dress) is planted in the page and must be flagged.
// The one deliberate exception is the ghost workbook title, `.dx-title`
// (boxless at rest), which the password gate also uses.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const SHELL = new URL('../dash/dist-single/Bento_Dash.bento.html', import.meta.url).href

// Every visible field on the page, with what the rule governs. Native widgets
// (checkbox, radio, range, file) keep the platform look and are skipped.
function measure(scope) {
  const root = getComputedStyle(document.documentElement)
  const probe = document.createElement('div')
  document.body.appendChild(probe)
  const resolve = (v) => { probe.style.color = v; return getComputedStyle(probe).color }
  const tok = { line: resolve(root.getPropertyValue('--line')), field: resolve(root.getPropertyValue('--field')), ring: resolve(root.getPropertyValue('--accent-ink')) }
  probe.remove()
  const out = []
  for (const el of document.querySelectorAll('input, textarea, select')) {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    if (!r.width || !r.height || s.visibility === 'hidden') continue
    const type = el.tagName === 'INPUT' ? el.type : el.tagName.toLowerCase()
    if (['checkbox', 'radio', 'range', 'file', 'hidden'].includes(type)) continue
    // the deliberate exception: the ghost workbook title (boxless at rest)
    if (el.matches('.dx-title')) continue
    // a colour well is measured for its box, not its height
    const sides = ['Top', 'Right', 'Bottom', 'Left']
    const name = (el.className && `.${String(el.className).trim().split(/\s+/)[0]}`) || el.closest('[class]')?.className.split(' ')[0] || ''
    out.push({
      id: `${type} ${name}${el.placeholder ? ` "${el.placeholder}"` : ''}`.trim(),
      type,
      styles: sides.map((x) => s[`border${x}Style`]),
      widths: sides.map((x) => s[`border${x}Width`]),
      colors: sides.map((x) => s[`border${x}Color`]),
      bg: s.backgroundColor,
      radius: s.borderTopLeftRadius,
      h: +r.height.toFixed(1),
      planted: el.hasAttribute('data-planted'),
      inScope: !scope || !!el.closest(scope),
    })
  }
  return { tok, fields: out }
}

function problems(f, tok) {
  const p = []
  if (f.styles.some((x) => x === 'inset' || x === 'outset')) p.push(`${f.styles[0]} border (browser default)`)
  else if (f.styles.some((x) => x !== 'solid')) p.push(`border ${f.styles.join('/')}`)
  if (f.widths.some((w) => w !== '1px')) p.push(`border ${f.widths.join('/')}`)
  if (f.colors.some((c) => c !== tok.line)) p.push(`border ${f.colors[0]} ≠ --line ${tok.line}`)
  if (f.bg !== tok.field) p.push(`fill ${f.bg} ≠ --field ${tok.field}`)
  if (f.radius !== '6px') p.push(`radius ${f.radius}`)
  if (f.type !== 'textarea' && Math.abs(f.h - 26) > 0.5) p.push(`height ${f.h}`)
  return p
}

const cell = (p, n) => p.locator('.dg-cell').nth(n)
const byText = (p, txt) => p.getByText(txt, { exact: true }).first().click({ timeout: 4000 })
const openReplaceJson = async (p) => { await p.locator('.dxs-caret').click(); await p.locator('.dxs-item', { hasText: 'Replace from JSON…' }).click() }
const ctxItem = async (p, label) => { await cell(p, 12).click({ button: 'right' }); await byText(p, label) }

// each surface gets a fresh page; `open` brings it up, and `min` is the floor
// on how many fields it shows INSIDE `scope`. Surfaces hosted IN the panel
// (chart, pivot, 3D, conditional formatting) can only name the panel; for them
// "opened" also rests on `open` succeeding. Dashboard and Paste special have no
// fields and are not listed.
const SURFACES = [
  { name: 'formula bar', scope: '.dx-formula', min: 1, open: (p) => cell(p, 12).click() },
  { name: 'properties panel (dataset)', scope: '.dp-panel', min: 6, open: (p) => cell(p, 12).click() },
  { name: 'About', scope: '.dx-about', min: 2, open: (p) => p.locator('[data-act="about"]').click() },
  // Replace from JSON lives in the Save ▾ menu now, as in slides
  { name: 'Replace from JSON', scope: '.dx-about', min: 1, open: (p) => openReplaceJson(p) },
  // Settings is reached from About's footer (it left the bar, as in slides)
  { name: 'Settings', scope: '.dx-about', min: 2, open: async (p) => { await p.locator('[data-act="about"]').click(); await p.locator('.dx-about-foot .dx-btn', { hasText: 'Settings' }).click() } },
  { name: 'find', scope: '.dx-find', min: 1, open: async (p) => { await cell(p, 12).click(); await p.keyboard.press('ControlOrMeta+f') } },
  { name: 'column filter', scope: '.dx-pop', min: 1, open: (p) => p.locator('.dg-filter').first().click() },
  { name: 'formula column', scope: '.dx-about, .dx-pop, .dx-ask, .dp-panel', min: 1, open: (p) => p.locator('[data-act="formula"]').click() },
  { name: 'chart', scope: '.dp-panel', min: 4, open: (p) => p.locator('[data-act="chart"]').click() },
  { name: 'pivot', scope: '.dp-panel', min: 4, open: (p) => p.locator('[data-act="pivot"]').click() },
  { name: '3D', scope: '.dp-panel', min: 4, open: (p) => p.locator('[data-act="viz3d"]').click() },
  { name: 'story step', scope: '.ds-step', min: 1, open: async (p) => { await p.locator('[data-act="story"]').click(); await p.locator('[data-act="capture"]').first().click() } },
  { name: 'comment composer', scope: '[class^="dxc"]', min: 1, open: async (p) => { await cell(p, 12).click(); await p.locator('[data-act="comment"]').click() } },
  { name: 'tab rename', scope: '.dx-tab-rename, .dx-tab', min: 1, open: (p) => p.locator('.dx-tab').first().dblclick() },
  { name: 'conditional formatting', scope: '.dp-panel', min: 4, open: (p) => ctxItem(p, 'More conditional formatting…') },
  { name: 'split into columns', scope: '.dx-ask', min: 1, open: (p) => ctxItem(p, 'Split into columns…') },
  { name: 'print', scope: '.dx-print-card', min: 1, open: async (p) => { await p.locator('.dx-dd-trig', { hasText: 'Data' }).first().click(); await byText(p, 'Print…') } },
  { name: 'spreadsheet sheet + panel', scope: '.dp-panel', min: 4, open: async (p) => { await p.locator('.dx-tab').nth(1).click(); await p.waitForTimeout(200); await cell(p, 30).click() } },
]

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  for (const theme of ['light', 'dark']) {
    console.log(`\n${theme} theme\n`)
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } })
    await ctx.addInitScript((th) => { try { localStorage.setItem('bento-theme', th) } catch {} }, theme)
    // 3D sits behind a developer flag (off by default); this rig measures its
    // panel's fields, so it turns the flag on.
    await ctx.addInitScript(() => { try { localStorage.setItem('bento-dash-dev-3d', 'on') } catch {} })
    await ctx.route(/^https?:/, (r) => r.abort())
    const fresh = async () => {
      const p = await ctx.newPage()
      p.on('dialog', (d) => d.dismiss())
      p.on('pageerror', (e) => ok(false, `no page error (${e.message})`))
      await p.goto(SHELL)
      await p.waitForFunction(() => window.bento?.doc && document.querySelector('.dg-cell'))
      await p.waitForTimeout(250)
      return p
    }

    const p0 = await fresh()
    ok(await p0.evaluate(() => document.documentElement.dataset.theme) === theme, `the page is in ${theme} theme`)
    await p0.close()

    let total = 0
    let focusPage = null
    for (const s of SURFACES) {
      const p = await fresh()
      let res
      try {
        await s.open(p)
        await p.waitForTimeout(300)
        res = await p.evaluate(measure, s.scope)
      } catch (e) {
        ok(false, `${s.name}: opens (${e.message.split('\n')[0]})`)
        await p.close()
        continue
      }
      const bad = res.fields.map((f) => [f, problems(f, res.tok)]).filter(([, pr]) => pr.length)
      total += res.fields.length
      const own = res.fields.filter((f) => f.inScope).length
      ok(own >= s.min && bad.length === 0,
        `${s.name}: ${own} field(s) of its own (floor ${s.min}), all ${res.fields.length} on the page in the field look` +
        bad.map(([f, pr]) => `\n          ${f.id}: ${pr.join('; ')}`).join(''))
      // the dataset panel carries all three kinds (text, number, select). It was
      // the chart's page while the chart sat beside the cell panel; the chart
      // now owns the panel with its own editor, which has no number field.
      if (s.name === 'properties panel (dataset)') focusPage = p
      else await p.close()
    }
    ok(total >= 150, `${total} fields measured across ${SURFACES.length} surfaces`)

    // 2. the focus ring, on each kind of field the dataset panel carries
    const p = focusPage
    for (const sel of ['input[type="text"]', 'input[type="number"]', 'select']) {
      const ring = await p.evaluate((sel) => {
        const el = [...document.querySelectorAll(`.dp-panel ${sel}`)].find((e) => e.getBoundingClientRect().width)
        if (!el) return null
        el.focus({ focusVisible: true })
        const s = getComputedStyle(el)
        const probe = document.createElement('div')
        probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--accent-ink')
        document.body.appendChild(probe)
        const want = getComputedStyle(probe).color
        probe.remove()
        return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, want, focusVisible: el.matches(':focus-visible') }
      }, sel)
      ok(ring && ring.focusVisible && ring.style === 'solid' && ring.width === '2px' && ring.color === ring.want,
        `focused ${sel} shows the ring (${ring ? `${ring.width} ${ring.style} ${ring.color}, want ${ring.want}` : 'none found'})`)
    }
    // a textarea, on the surface that has one
    {
      const tp = await fresh()
      await openReplaceJson(tp); await tp.waitForTimeout(200)
      const ring = await tp.evaluate(() => {
        const el = document.querySelector('.dx-about textarea')
        if (!el) return null
        el.focus({ focusVisible: true })
        const s = getComputedStyle(el)
        const probe = document.createElement('div')
        probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--accent-ink')
        document.body.appendChild(probe)
        const want = getComputedStyle(probe).color
        probe.remove()
        return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, want, focusVisible: el.matches(':focus-visible') }
      })
      ok(ring && ring.focusVisible && ring.style === 'solid' && ring.width === '2px' && ring.color === ring.want,
        `focused textarea shows the ring (${ring ? `${ring.width} ${ring.style} ${ring.color}, want ${ring.want}` : 'none found'})`)
      await tp.close()
    }

    // 4. the check catches the browser's dress: plant a field whose author
    //    styles are reverted, and it must come back with problems
    const planted = await p.evaluate(() => {
      const el = document.createElement('input')
      el.setAttribute('data-planted', '')
      el.style.all = 'revert'
      document.querySelector('.dp-panel, body').appendChild(el)
      return true
    }) && (await p.evaluate(measure))
    const pf = planted.fields.find((f) => f.planted)
    const pr = pf ? problems(pf, planted.tok) : []
    ok(pf && pr.some((x) => /browser default|fill|radius/.test(x)), `a browser-dressed field is flagged (${pr.join('; ') || 'not flagged'})`)
    await p.close()
    await ctx.close()
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
