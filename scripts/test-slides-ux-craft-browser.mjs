// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The inspector's craft: icon pickers, one grid, captions that fit, side tabs that never cut a word.
//
//   npm run build:single --prefix slides && node scripts/test-slides-ux-craft-browser.mjs
//
// WHAT THIS PROVES (measured in the packaged editor, real clicks; the
// UX pyramid audit of 2026-10-30, docs/audit/, is where each came from):
//   1. a choice between a few VISUAL options is an icon picker, not words or a
//      dropdown: auto-layout direction, stroke position, line style, chart
//      type, picture fit, slide transition, entrance, lap speed, appearance —
//      each a radiogroup of glyphs, each glyph named for assistive tech.
//   2. one two-column grid: every pair (W·H with its padlock, X·Y, blend ·
//      opacity) splits the row into two equal columns, the padlock inside W's
//      own field; a switch sits inside the panel's edge (it overran by 4px);
//      the alignment box's nine cells are equal; the toolbar's tools are 26
//      high like every field; a table's column count is a field you can type.
//   3. no caption takes more than two lines beside its control, in en, de or
//      pt at 1280px — a longer one goes above its control instead.
//   4. the side column's tabs never cut a word, in any of the 8 core locales:
//      each is a glyph, the chosen one also its name, and the name is always
//      the tab's accessible name.
//   5. dark mode: a form control's edge is 3:1 against the panel (WCAG 1.4.11);
//      it was 1.33:1.
//   6. words: the role section is named for what it holds, not a second
//      'Layout' beside 'Auto layout'; Count up is offered only where there is
//      a number to count; the slide's Transition is not labelled twice.
//
// Against a build from before these changes: 1, 2, 4, 5 and 6 fail.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const SHELL = process.env.SHELL_HTML || new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href

// One slide holding one of each kind, borrowed from the starter deck so charts
// and tables carry real options; a frame with a child; a stroked rect.
async function boot(browser, { locale = 'en-US', theme } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale })
  await ctx.route(/^https?:/, (r) => r.abort())
  if (theme) await ctx.addInitScript((th) => { try { localStorage.setItem('bento-theme', th) } catch {} }, theme)
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    const all = d.slides.flatMap((s) => s.elements)
    const first = (pred) => JSON.parse(JSON.stringify(all.find(pred)))
    const at = (el, id, x, y, w, h) => Object.assign(el, { id, x, y, w, h, rotation: 0, parentId: undefined, groupId: undefined, fx: undefined, hidden: undefined, locked: undefined })
    const chart = at(first((e) => e.type === 'chart'), 'chart', 40, 40, 300, 200)
    chart.preset = 'bar'
    const table = at(first((e) => e.type === 'table'), 'table', 380, 40, 300, 200)
    const code = at(first((e) => e.type === 'code'), 'code', 720, 40, 300, 200)
    const base = { rotation: 0, opacity: 1 }
    const els = [chart, table, code,
      { ...base, id: 'frame', type: 'shape', shape: 'rect', x: 40, y: 300, w: 300, h: 160, fill: '#eeeeee', stroke: 'transparent', strokeWidth: 0, radius: 0,
        layout: { dir: 'row', gap: 16, pad: [16, 16, 16, 16] } },
      { ...base, id: 'kid', type: 'shape', shape: 'rect', parentId: 'frame', x: 56, y: 316, w: 80, h: 80, fill: '#88aaee', stroke: 'transparent', strokeWidth: 0, radius: 0 },
      { ...base, id: 'box', type: 'shape', shape: 'rect', x: 400, y: 300, w: 200, h: 160, fill: '#ffcc88', stroke: '#1e2a3a', strokeWidth: 4, radius: 8 },
      { ...base, id: 'num', type: 'text', x: 680, y: 300, w: 300, h: 80, html: 'Revenue 42%', fontSize: 32, fontFamily: 'system-ui', fontWeight: 400, color: '#1e2a3a', align: 'left', valign: 'top', lineHeight: 1.2 },
      { ...base, id: 'line', type: 'shape', shape: 'line', x: 680, y: 450, w: 300, h: 10, fill: '#1e2a3a', stroke: '#1e2a3a', strokeWidth: 3, radius: 0 },
    ]
    d.slides = [{ id: 's1', background: '#ffffff', transition: 'fade', notes: '', elements: els }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(500)
  return { ctx, p, errors }
}

// select as a user can: the element's row in Layers (frames' children included)
const select = async (p, id) => {
  if (!await p.locator('.ed-side-layers').isVisible()) { await p.locator('.ed-side-tabs [data-view="layers"]').click(); await p.waitForTimeout(150) }
  await p.locator(`.ed-side-layers .ed-layer[data-id="${id}"]`).click()
  await p.waitForTimeout(250)
}
const deselect = async (p) => { await p.locator('.ed-stage-scale').click({ position: { x: 2, y: 2 } }); await p.keyboard.press('Escape'); await p.waitForTimeout(250) }
const tab = async (p, name) => { await p.locator(`.ed-props .ed-tabs [role="tab"]`).nth(name).click(); await p.waitForTimeout(200) }
// the control in the row whose caption is `caption` (or the section's own picker)
const pickerIn = (p, caption) => p.evaluate((c) => {
  const row = [...document.querySelectorAll('.ed-props .ed-row')].find((r) => r.querySelector(':scope > span:first-child')?.textContent === c && r.offsetParent)
  const ctl = row?.querySelector(':scope > :not(span:first-child)')
  if (!ctl) return null
  return { tag: ctl.tagName, seg: ctl.classList.contains('ed-seg'), glyphs: ctl.querySelectorAll(':scope > button > svg').length, buttons: ctl.querySelectorAll(':scope > button').length,
    named: [...ctl.querySelectorAll(':scope > button')].every((b) => b.getAttribute('aria-label')) }
}, caption)
const isPicker = (r) => !!r && r.seg && r.glyphs === r.buttons && r.buttons > 1 && r.named

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  console.log('\n1 · icon pickers (en)\n')
  {
    const { ctx, p, errors } = await boot(browser)
    await select(p, 'frame')
    ok(isPicker(await pickerIn(p, 'Direction')), 'auto-layout Direction is glyphs (row · column · grid)')
    const pad = await p.$$eval('.ed-props .ed-mini .ed-mini-icon', (s) => s.map((x) => x.getAttribute('aria-label')))
    ok(['Gap', 'Top padding', 'Left padding'].every((n) => pad.includes(n)), `gap and padding are labelled by glyphs, named in words (${pad.slice(0, 6).join(', ')})`)
    const cells = await p.$$eval('.ed-align-matrix button', (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().height)))
    ok(cells.length === 9 && new Set(cells).size === 1, `the alignment box's nine cells are one height (${[...new Set(cells)].join('/')})`)

    await select(p, 'box')
    ok(isPicker(await pickerIn(p, 'Stroke position')), 'Stroke position is glyphs (inside · center · outside)')
    const style = await p.evaluate(() => { const s = document.querySelector('.ed-props [aria-label="Line style"]'); return s && { seg: s.classList.contains('ed-seg'), glyphs: s.querySelectorAll('button > svg').length } })
    ok(style?.seg && style.glyphs === 4, `Line style is four glyphs, not a dropdown (${JSON.stringify(style)})`)
    // the grid: W · H split equal, the padlock inside W
    const geo = await p.evaluate(() => {
      const lock = document.querySelector('.ed-props .ed-ratio-lock')
      const w = lock?.closest('.ed-mini, .ed-has-lock')
      const grid = w?.parentElement
      const [a, b] = [...(grid?.children ?? [])].map((x) => x.getBoundingClientRect())
      const l = lock?.getBoundingClientRect(), wr = w?.getBoundingClientRect()
      return a && b && l && wr && { aw: Math.round(a.width), bw: Math.round(b.width), gap: Math.round(b.left - a.right), inside: l.left >= wr.left && l.right <= wr.right }
    })
    ok(!!geo && geo.aw === geo.bw && geo.gap <= 4 && geo.inside, `W and H split the row equally with the padlock inside W (${JSON.stringify(geo)})`)
    const wide = await p.evaluate(() => { const g = document.querySelector('.ed-props .ed-grid-wide'); const [a, b] = [...(g?.children ?? [])].map((x) => Math.round(x.getBoundingClientRect().width)); return [a, b] })
    ok(!!wide[0] && wide[0] === wide[1], `blend · opacity split the row like every other pair (${wide.join(' · ')})`)
    const tools = await p.$$eval('.ed-props .ed-toolbar .ed-tool', (ts) => [...new Set(ts.map((t) => Math.round(t.getBoundingClientRect().height)))])
    ok(tools.length === 1 && tools[0] === 26, `the toolbar's tools are 26 high, like every field (${tools.join('/')})`)

    await select(p, 'line')
    const ends = await p.$$eval('.ed-props .ed-tip-btn', (bs) => bs.map((b) => !!b.querySelector('svg') && !!b.getAttribute('aria-label')))
    ok(ends.length === 2 && ends.every(Boolean), 'line start and end are glyph buttons, named')
    ok(await p.locator('.ed-props [aria-label="Swap ends"]').count() === 1, 'and a swap between them')

    await select(p, 'chart')
    ok(isPicker(await pickerIn(p, 'Type')), 'chart Type is glyphs (bar · line · pie · scatter)')
    await select(p, 'table')
    ok((await pickerIn(p, 'Columns'))?.tag === 'INPUT', 'a table\'s column count is a field you can type, not ± buttons')
    // a switch row: the box stays inside the panel's content edge
    const edge = await p.evaluate(() => [...document.querySelectorAll('.ed-props .ed-row > .ed-toggle')].filter((x) => x.offsetParent)
      .map((x) => Math.round(x.parentElement.getBoundingClientRect().right - x.getBoundingClientRect().right)))
    ok(edge.length > 0 && edge.every((d) => d >= 0), `switches end inside the panel's edge (${edge.join(', ')} px to spare)`)
    await select(p, 'code')
    ok(await p.evaluate(() => [...document.querySelectorAll('.ed-props .ed-row > span:first-child')].every((s) => s.textContent !== 'Size (pt)')),
      "a code block's size is in-field, as on a text box — not a labelled row")

    // the Animate tab
    await select(p, 'box')
    await tab(p, 1)
    ok(isPicker(await pickerIn(p, 'Entrance')), 'Entrance is glyphs (none · fade · fly), not eight word chips')
    ok(await p.evaluate(() => ![...document.querySelectorAll('.ed-props .ed-row > span:first-child')].some((s) => s.offsetParent && s.textContent === 'Count up numbers')),
      'Count up is not offered on a rectangle with no number in it')
    await select(p, 'num')
    ok(await p.evaluate(() => [...document.querySelectorAll('.ed-props .ed-row > span:first-child')].some((s) => s.offsetParent && s.textContent === 'Count up numbers')),
      '…and is on text that has one')
    ok(await p.evaluate(() => { const r = [...document.querySelectorAll('.ed-props .ed-row')].find((x) => x.querySelector('span')?.textContent === 'Pan & zoom'); return r?.querySelector('input[type="checkbox"]') }),
      'Pan & zoom is a switch, not a None/Ken Burns dropdown')
    // the slide: transition picker, named once
    await deselect(p)
    ok(await p.evaluate(() => window.bento.selection.length === 0), 'nothing selected: the slide\'s own panel')
    await tab(p, 1)
    const trans = await p.evaluate(() => { const s = document.querySelector('.ed-props [aria-label="Transition"].ed-seg'); return s && { glyphs: s.querySelectorAll('button > svg').length, captioned: [...document.querySelectorAll('.ed-props .ed-row > span:first-child')].some((c) => c.offsetParent && c.textContent === 'Transition') } })
    ok(trans?.glyphs === 5 && !trans.captioned, `the slide's Transition is five glyphs under its section, not labelled twice (${JSON.stringify(trans)})`)
    await tab(p, 0)
    await select(p, 'box')
    const heads = await p.$$eval('.ed-props > .ed-section', (hs) => hs.filter((h) => h.offsetParent).map((h) => h.textContent))
    ok(heads.includes('Placeholder role') && !heads.includes('Layout'), `the role section is named for what it holds (${heads.join(', ')})`)
    ok(!errors.length, `no page error (${errors.join(' | ')})`)
    await ctx.close()
  }

  console.log('\n3 · captions fit (en, de, pt at 1280)\n')
  for (const locale of ['en-US', 'de-DE', 'pt-BR']) {
    const { ctx, p } = await boot(browser, { locale })
    let worst = { lines: 0, text: '' }
    for (const id of ['frame', 'kid', 'box', 'num', 'line', 'chart', 'table', 'code']) {
      await select(p, id)
      for (const t of [0, 1, 2]) {
        await tab(p, t)
        const w = await p.evaluate(() => {
          let best = { lines: 0, text: '' }
          for (const s of document.querySelectorAll('.ed-props .ed-row > span:first-child')) {
            if (!s.offsetParent || s.parentElement.classList.contains('ed-row-stack')) continue
            const line = parseFloat(getComputedStyle(s).lineHeight) || 14
            const lines = Math.round(s.offsetHeight / line)
            if (lines > best.lines) best = { lines, text: s.textContent }
          }
          return best
        })
        if (w.lines > worst.lines) worst = w
      }
    }
    ok(worst.lines <= 2, `[${locale}] no caption beside its control takes more than two lines (worst: ${worst.lines} — "${worst.text}")`)
    await ctx.close()
  }

  console.log('\n4 · side tabs never cut a word (8 core locales)\n')
  for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'ja-JP', 'pt-BR', 'zh-CN']) {
    const { ctx, p } = await boot(browser, { locale })
    const cut = []
    for (const view of ['slides', 'layers', 'tokens']) {
      await p.locator(`.ed-side-tabs [data-view="${view}"]`).click()
      await p.waitForTimeout(150)
      cut.push(...await p.$$eval('.ed-side-tabs button', (bs) => bs.flatMap((b) => {
        const shownText = [...b.querySelectorAll('*'), b].filter((n) => n.childNodes.length && [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()))
        return shownText.filter((n) => n.offsetParent && n.scrollWidth > n.clientWidth + 1).map(() => b.getAttribute('aria-label') || b.textContent)
      })))
    }
    const named = await p.$$eval('.ed-side-tabs button', (bs) => bs.every((b) => b.getAttribute('aria-label')))
    ok(!cut.length && named, `[${locale}] no side tab is cut short, and each is named (${cut.join(', ') || 'none cut'})`)
    await ctx.close()
  }

  console.log('\n5 · dark mode: a control\'s edge reads\n')
  {
    const { ctx, p } = await boot(browser, { theme: 'dark' })
    await select(p, 'box')
    const c = await p.evaluate(() => {
      const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
      const field = document.querySelector('.ed-props input.ed-num')
      const panel = rgb(getComputedStyle(document.querySelector('.ed-props')).backgroundColor)
      return { theme: document.documentElement.dataset.theme, ratio: Math.round(ratio(rgb(getComputedStyle(field).borderTopColor), panel) * 100) / 100 }
    })
    ok(c.theme === 'dark' && c.ratio >= 3, `a field's edge is ≥3:1 against the dark panel (${c.ratio}:1)`)
    await ctx.close()
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
