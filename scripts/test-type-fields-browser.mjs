// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Every text field, select and textarea in type's chrome wears the ONE field look.
//
//   npm run build:single --prefix type && node scripts/test-type-fields-browser.mjs
//
// A port of scripts/test-slides-fields-browser.mjs — the same measurement and
// the same verdicts, over type's shell, surfaces and containers. The rule
// under test is the `THE FIELD` block in type/src/styles.css, copied from
// slides (docs/DECISIONS.md 2026-10-17, "the suite's one field look").
//
// WHAT THIS PROVES, measured in the packaged document, in light AND dark theme:
//   1. every visible field — the properties panel (paragraph styles, page
//      layout, the Review panel), the image panel, About, find and replace,
//      the link popover, the comment box, the live-session name, Insert a
//      field, Import BibTeX, Insert citation, and mail merge on a two-sheet
//      workbook — has a 1px SOLID border in the computed --line colour, a
//      --field fill, a 6px radius, and (single-line fields) a 26px height. Two
//      type fields shipped in the browser's own dress (an unclassed select:
//      the Review panel's "Display" and mail merge's "Sheet"), and the rest
//      each restated the look with their own radius (6, 7 or 8px) and padding;
//   2. a focused field shows the amber ring: a 2px solid --accent-text outline
//      (type's name for slides' --accent-ink; type's own --accent-ink is text
//      ON the accent, near-black in dark theme, and would hide the ring);
//   3. each surface really opened — a floor on how many fields it shows — so a
//      menu that silently failed to open cannot pass by having no fields;
//   4. the check itself works: a field with its author styles reverted (the
//      browser's dress) is planted in the page and must be flagged.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const SHELL = new URL('../type/dist-single/Bento_Type.bento.html', import.meta.url).href
// A two-sheet bento/dash workbook, as dash's importDelimited writes one: mail
// merge shows its Sheet picker only when there is a choice to make.
const DASH = {"format":"bento/dash","version":1,"policy":"bento-dash-1","docId":"doc-115b3d47","title":"Two sheets","sheets":[{"id":"s-a","name":"Recipients","kind":"table","rids":[[1,2]],"columns":[{"id":"name","name":"Name","type":"text"},{"id":"owed","name":"Owed","type":"number","parsed":"dot"}],"data":{"name":{"enc":"raw","v":["Ada","Grace"]},"owed":{"enc":"raw","v":[1,2]}},"steps":[{"op":"import","from":"pasted","at":"","rows":2}]},{"id":"s-b","name":"Others","kind":"table","rids":[[1,1]],"columns":[{"id":"name","name":"Name","type":"text"},{"id":"plan","name":"Plan","type":"text"}],"data":{"name":{"enc":"raw","v":["Alan"]},"plan":{"enc":"raw","v":["Gold"]}},"steps":[{"op":"import","from":"pasted","at":"","rows":1}]}],"measures":{"Weighted pipeline":{"name":"Weighted pipeline","expr":"SUM(value * prob)","grain":"sheet-pipeline","additive":true,"unit":"GBP","desc":"Open value discounted by probability. Won counts in full; lost counts nothing."}},"theme":{"background":"#FFFFFF","color":"#1E2A3A","accent":"#F7A600","fontFamily":"ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"}}
const dir = mkdtempSync(join(tmpdir(), 'bento-type-fields-'))
const DASH_FILE = join(dir, 'two-sheets.bento.html')
writeFileSync(DASH_FILE, '<!DOCTYPE html>\n<html><head><script type="application/bento+json" id="bento-doc">\n'
  + JSON.stringify(DASH).replace(/</g, '\\u003c') + '\n</scr' + 'ipt></head><body></body></html>')
const PNG_FILE = join(dir, 'px.png')
writeFileSync(PNG_FILE, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))

// Every visible field on the page, with what the rule governs. Native widgets
// (checkbox, radio, range, file) keep the platform look and are skipped.
function measure(scope) {
  const root = getComputedStyle(document.documentElement)
  const probe = document.createElement('div')
  document.body.appendChild(probe)
  const resolve = (v) => { probe.style.color = v; return getComputedStyle(probe).color }
  const tok = { line: resolve(root.getPropertyValue('--line')), field: resolve(root.getPropertyValue('--field')), ring: resolve(root.getPropertyValue('--accent-text')) }
  probe.remove()
  const out = []
  for (const el of document.querySelectorAll('input, textarea, select')) {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    if (!r.width || !r.height || s.visibility === 'hidden') continue
    const type = el.tagName === 'INPUT' ? el.type : el.tagName.toLowerCase()
    if (['checkbox', 'radio', 'range', 'file', 'hidden'].includes(type)) continue
    // the deliberate exception: the ghost document title in the bar (boxless
    // at rest), slides' .ed-title counterpart. Nothing inside the document
    // page is chrome, and none is measured.
    if (el.matches('.t-doctitle') || el.closest('#paper')) continue
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

// each surface gets a fresh page; `open` brings it up, and `min` is the floor
// on how many fields it shows INSIDE `scope` — proof the surface opened at
// all, since the panel's fields are on the page whatever else is open
const selectText = async (p) => {
  const bb = await p.locator('#paper p[data-kind=para]').first().boundingBox()
  await p.mouse.click(bb.x + 4, bb.y + bb.height / 2)
  await p.keyboard.press('Home')
  for (let i = 0; i < 8; i++) await p.keyboard.press('Shift+ArrowRight')
}
const menu = async (p, btn, label) => {
  await p.click('#' + btn)
  await p.waitForTimeout(150)
  await p.getByRole('button', { name: label }).or(p.getByRole('menuitem', { name: label })).first().click()
}
const SURFACES = [
  { name: 'properties panel (Review, page layout)', scope: '#propsPanel', min: 8, open: async () => {} },
  { name: 'paragraph styles', scope: '.t-sty-row', min: 2, open: (p) => selectText(p) },
  { name: 'image panel', scope: '#propsPanel', min: 2, open: async (p) => {
    p.__file = PNG_FILE
    await selectText(p); await menu(p, 'insertMenuBtn', 'Picture'); await p.waitForTimeout(500)
    const bb = await p.locator('#paper [data-kind=image]').first().boundingBox()
    await p.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2)
    await p.waitForFunction(() => [...document.querySelectorAll('#propsPanel input')].some((i) => /Alt/.test(i.previousElementSibling?.textContent || '')))
  } },
  { name: 'About', scope: '.t-dlg', min: 2, open: (p) => p.click('#mark') },
  // through Navigate → Results, where the find box lives: the toolbar button
  // and ⌘F do not reach it on main (reported separately; this rig is about
  // how the fields look, not how they are reached)
  { name: 'find and replace', scope: '.t-find', min: 2, open: async (p) => {
    await p.click('.t-tabs button[data-tab="navigate"]'); await p.click('button[data-view="results"]')
  } },
  { name: 'link popover', scope: '.t-link-pop', min: 1, open: async (p) => { await selectText(p); await p.click('#tool-link') } },
  { name: 'comment box', scope: '.acts', min: 1, open: async (p) => { await selectText(p); await p.click('#tool-comment') } },
  { name: 'live-session name', scope: '.tc-name-row', min: 1, open: (p) => p.click('.tc-share-btn') },
  { name: 'Insert a field', scope: '.t-dlg', min: 1, open: async (p) => { await selectText(p); await menu(p, 'insertMenuBtn', 'Field') } },
  { name: 'Import BibTeX', scope: '.t-dlg', min: 1, open: (p) => menu(p, 'more', 'Import BibTeX') },
  { name: 'Insert citation', scope: '.t-dlg', min: 2, open: async (p) => {
    await menu(p, 'more', 'Import BibTeX')
    await p.fill('.t-cite-paste', '@article{knuth84, author={Donald Knuth}, title={Literate Programming}, year={1984}, journal={The Computer Journal}}')
    await p.getByRole('button', { name: 'Import', exact: true }).click(); await p.waitForTimeout(200)
    await selectText(p); await p.keyboard.press('ArrowRight'); await menu(p, 'insertMenuBtn', 'Citation')
  } },
  { name: 'mail merge, two sheets', scope: '.t-dlg', min: 2, open: async (p) => {
    p.__file = DASH_FILE
    await menu(p, 'more', 'Mail merge'); await p.waitForTimeout(600)
    await p.locator('.t-dlg select').first().waitFor()
  } },
]

// the panel's collapsible sections, opened so fields behind them are measured
const expandAll = (p) => p.evaluate(() => { for (const h of document.querySelectorAll('#propsPanel details:not([open])')) h.open = true })

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  for (const theme of ['light', 'dark']) {
    console.log(`\n${theme} theme\n`)
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await ctx.addInitScript((th) => { try { localStorage.setItem('bento-theme', th) } catch {} }, theme)
    await ctx.route(/^https?:/, (r) => r.abort())
    const fresh = async () => {
      const p = await ctx.newPage()
      p.on('dialog', (d) => d.accept('Probe').catch(() => {}))
      p.on('filechooser', (fc) => { if (p.__file) fc.setFiles(p.__file).catch(() => {}) })
      // ONE known error is tolerated, by its exact text: the shell loader's
      // synchronous inline path rejects type's bundle (Vite's lazy-import helper
      // carries import.meta.url) and the loader falls back to its blob import —
      // the app boots either way. Reported separately; any OTHER error fails.
      p.on('pageerror', (e) => { if (!/Cannot use 'import\.meta' outside a module/.test(e.message)) ok(false, `no page error (${e.message})`) })
      await p.goto(SHELL)
      await p.waitForFunction(() => window.bento?.doc && document.querySelector('#paper p[data-kind=para]'))
      return p
    }

    const p0 = await fresh()
    ok(await p0.evaluate(() => document.documentElement.dataset.theme) === theme, `the page is in ${theme} theme`)
    await p0.close()

    let total = 0
    let focusable = null
    for (const s of SURFACES) {
      const p = await fresh()
      let res
      try {
        await s.open(p)
        await p.waitForTimeout(250)
        await expandAll(p)
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
      if (s.name === 'comment box') focusable = p
      else await p.close()
    }
    ok(total >= 60, `${total} fields measured across ${SURFACES.length} surfaces`)

    // 2. the focus ring, on each kind of field — on the comment page, which
    //    has no modal dialog holding focus and carries all four kinds
    const p = focusable
    for (const sel of ['input[type="text"]', 'input[type="number"]', 'select', 'textarea']) {
      const ring = await p.evaluate((sel) => {
        const el = [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().width && !e.matches('.t-doctitle') && !e.closest('#paper'))
        if (!el) return null
        el.focus({ focusVisible: true })
        const s = getComputedStyle(el)
        const probe = document.createElement('div')
        probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--accent-text')
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
      const el = document.createElement('select')
      el.setAttribute('data-planted', '')
      el.style.all = 'revert'
      el.innerHTML = '<option>x</option>'
      document.querySelector('#propsPanel, body').appendChild(el)
      return true
    }) && (await p.evaluate(measure))
    const pf = planted.fields.find((f) => f.planted)
    const pr = pf ? problems(pf, planted.tok) : []
    ok(pf && pr.some((x) => /browser default|fill|radius|border/.test(x)), `a browser-dressed field is flagged (${pr.join('; ') || 'not flagged'})`)
    await p.close()
    await ctx.close()
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
