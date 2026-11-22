// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Every text field, select and textarea in slides' chrome wears the ONE field look.
//
//   npm run build:single --prefix slides && node scripts/test-slides-fields-browser.mjs
//
// WHAT THIS PROVES, measured in the packaged document, in light AND dark theme:
//   1. every visible field — the properties panel for each element kind, the
//      slide panel, Document properties, Preferences, Replace from JSON,
//      Export images, Save with
//      password, the Share popover, the comment popover — has a 1px SOLID
//      border in the computed --line colour, a --field fill, a 6px radius, and
//      (single-line fields) a 26px height. The browser's own dress is a 2px
//      INSET border with square corners, and in dark theme a #3b3b3b fill: five
//      slides fields had that fill, and About's theme select had all of it;
//   2. a focused field shows the amber ring: a 2px solid --accent-ink outline;
//   3. each surface really opened — a floor on how many fields it shows — so a
//      menu that silently failed to open cannot pass by having no fields;
//   4. the check itself works: a field with its author styles reverted (the
//      browser's dress) is planted in the page and must be flagged.
// The rule under test is the `THE FIELD` block in slides/src/styles.css, the
// reference dash, spaces and type copy.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const SHELL = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
// one slide per element kind, so each kind's properties panel gets walked
const KINDS = {
  text: { type: 'text', html: 'Hello' },
  rect: { type: 'shape', shape: 'rect', fill: '#88aaff' },
  line: { type: 'shape', shape: 'line', fill: '#333333', h: 4 },
  image: { type: 'image', src: PNG },
  chart: { type: 'chart', option: { xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [1, 2] }] } },
  pie: { type: 'chart', option: { series: [{ type: 'pie', data: [{ name: 'a', value: 1 }, { name: 'b', value: 2 }] }] } },
  table: { type: 'table', columns: [{ w: 1 }, { w: 1 }], header: true, style: { borderColor: '#d0d7e2', borderWidth: 1 }, rows: [{ cells: [{ html: 'a' }, { html: 'b' }] }, { cells: [{ html: '1' }, { html: '2' }] }] },
  media: { type: 'media', kind: 'video', src: 'x.mp4' },
  svg: { type: 'svg', svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' },
  code: { type: 'code', code: 'let a = 1', lang: 'js' },
}
const NAMES = Object.keys(KINDS)

// Every visible field on the page, with what the rule governs. Native widgets
// (checkbox, radio, range, file) keep the platform look and are skipped.
function measure(scope) {
  const root = getComputedStyle(document.documentElement)
  const probe = document.createElement('div')
  document.body.appendChild(probe)
  const resolve = (v) => { probe.style.color = v; return getComputedStyle(probe).color }
  // a control's edge is its own token (dark mode lifts it to 3:1 against the panel)
  const tok = { line: resolve(root.getPropertyValue('--field-line')), field: resolve(root.getPropertyValue('--field')), ring: resolve(root.getPropertyValue('--accent-ink')) }
  probe.remove()
  const out = []
  for (const el of document.querySelectorAll('input, textarea, select')) {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    if (!r.width || !r.height || s.visibility === 'hidden') continue
    const type = el.tagName === 'INPUT' ? el.type : el.tagName.toLowerCase()
    if (['checkbox', 'radio', 'range', 'file', 'hidden'].includes(type)) continue
    // the deliberate exceptions: the ghost deck title (boxless at rest) and
    // the password gate, which is its own card on the boot splash
    if (el.matches('.ed-title, .ed-pwcard input')) continue
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
  if (f.colors.some((c) => c !== tok.line)) p.push(`border ${f.colors[0]} ≠ --field-line ${tok.line}`)
  if (f.bg !== tok.field) p.push(`fill ${f.bg} ≠ --field ${tok.field}`)
  if (f.radius !== '6px') p.push(`radius ${f.radius}`)
  if (f.type !== 'textarea' && Math.abs(f.h - 26) > 0.5) p.push(`height ${f.h}`)
  return p
}

// each surface gets a fresh page; `open` brings it up, and `min` is the floor
// on how many fields it shows INSIDE `scope` — proof the surface opened at
// all, since the panel's fields are on the page whatever else is open
const SURFACES = [
  { name: 'slide panel', scope: '.ed-props', min: 4, open: async () => {} },
  ...NAMES.map((k, i) => ({ name: `panel: ${k}`, scope: '.ed-props', min: 6, open: async (p) => {
    await p.evaluate((i) => document.querySelectorAll('.ed-sidebar .ed-thumb')[i].click(), i)
    await p.waitForTimeout(150)
    const box = await p.evaluate((k) => {
      const r = document.querySelector(`.ed-stage-scale [data-el-id="e-${k}"]`).getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 20) }
    }, k)
    await p.mouse.click(box.x, box.y)
    await p.waitForFunction((k) => window.bento.selection.includes(`e-${k}`), k)
  } })),
  // the document's fields have their own dialog (File ▸ Document properties); the app's in Preferences
  { name: 'Document properties', scope: '.ed-about', min: 5, open: (p) => fileMenu(p, 'doc-props') },
  { name: 'Preferences', scope: '.ed-about', min: 1, open: (p) => p.locator('.ed-topbar [data-cmd="preferences"]').click() },
  { name: 'Replace from JSON', scope: '.ed-about', min: 1, open: (p) => fileMenu(p, 'replace-json') },
  { name: 'Export images', scope: '.bkd-card', min: 3, open: (p) => fileMenu(p, 'export-images') },
  { name: 'Save with password', scope: 'dialog.ed-pwdialog', min: 2, open: (p) => saveAs(p, 'Save with password') },
  { name: 'Share popover', scope: '.ed-share-pop', min: 1, open: (p) => p.locator('.ed-btn-share').click() },
  { name: 'comment popover', scope: '.ed-comment-pop', min: 1, open: (p) => p.locator('.ed-stage-scale .ed-comment-marker, .ed-comment-marker').first().click() },
]
async function fileMenu(p, cmd) {
  await p.locator('.ed-topbar .ed-logo').click()
  await p.locator(`.ed-file-menu [data-cmd="${cmd}"]`).click()
}
async function saveAs(p, label) {
  await p.locator('.ed-split-caret').click()
  // exact: "Replace from JSON" is also a phrase in another item's description
  await p.locator('.ed-save-menu').getByText(`${label}…`, { exact: true }).click()
}

// Every surface the rig visits opens with all collapsed panel sections opened,
// so fields behind the accordion are measured too.
const expandAll = (p) => p.evaluate(() => { for (const h of document.querySelectorAll('.ed-sec-toggle.closed')) h.click() })

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  for (const theme of ['light', 'dark']) {
    console.log(`\n${theme} theme\n`)
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await ctx.addInitScript((th) => {
      try { localStorage.setItem('bento-theme', th); localStorage.setItem('bento-slideshow-started', '1') } catch {}
    }, theme)
    await ctx.route(/^https?:/, (r) => r.abort())
    let doc = null
    const fresh = async () => {
      const p = await ctx.newPage()
      p.on('dialog', (d) => d.dismiss())
      p.on('pageerror', (e) => ok(false, `no page error (${e.message})`))
      await p.goto(SHELL)
      await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar .ed-logo'))
      if (!doc) {
        doc = JSON.parse(JSON.stringify(await p.evaluate(() => window.bento.doc)))
        doc.slides = NAMES.map((k, i) => ({
          id: `s${i}`, background: '#ffffff',
          comments: i === 0 ? [{ id: 'c1', author: 'A', at: '2026-10-01T00:00:00Z', text: 'hi' }] : undefined,
          elements: [{ id: `e-${k}`, x: 300, y: 200, w: 500, h: KINDS[k].h || 260, ...KINDS[k] }],
        }))
      }
      const loaded = await p.evaluate((j) => !!window.bento.loadDoc(j), JSON.stringify(doc))
      if (!loaded) throw new Error('fixture deck did not load')
      return p
    }

    const p0 = await fresh()
    ok(await p0.evaluate(() => document.documentElement.dataset.theme) === (theme), `the page is in ${theme} theme`)
    await p0.close()

    let total = 0
    const focusable = []
    for (const s of SURFACES) {
      const p = await fresh()
      let res
      try {
        await s.open(p)
        await p.waitForTimeout(250)
        await expandAll(p); await p.waitForTimeout(80); await expandAll(p)
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
      if (s.name === 'panel: chart') focusable.push(p)
      else await p.close()
    }
    ok(total >= 60, `${total} fields measured across ${SURFACES.length} surfaces`)

    // 2. the focus ring, on each kind of field the chart panel carries
    const p = focusable[0]
    for (const sel of ['input[type="text"]', 'input[type="number"]', 'select', 'textarea']) {
      const ring = await p.evaluate((sel) => {
        const el = [...document.querySelectorAll(`.ed-props ${sel}, .ed-panel ${sel}, ${sel}`)].find((e) => e.getBoundingClientRect().width && !e.matches('.ed-title'))
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
        `focused ${sel} shows the amber ring (${ring ? `${ring.width} ${ring.style} ${ring.color}, want ${ring.want}` : 'none found'})`)
    }

    // 4. the check catches the browser's dress: plant a field whose author
    //    styles are reverted, and it must come back with problems
    const planted = await p.evaluate(() => {
      const el = document.createElement('input')
      el.setAttribute('data-planted', '')
      el.style.all = 'revert'
      document.querySelector('.ed-props, .ed-panel, body').appendChild(el)
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
