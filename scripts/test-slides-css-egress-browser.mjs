// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// No string a document carries makes slides fetch anything, on any surface.
//
//   npm run build:single --prefix slides && node scripts/test-slides-css-egress-browser.mjs
//
// WHAT THIS PROVES, in the packaged document (bento/connect gate-1 invariant 6).
// A colour is the commonest thing a deck writes into CSS, and a colour that is
// really `url(https://…)` is a fetch: a read receipt with the reader's address
// on it, from a file that is meant to work offline. Slides gates document
// colours at the render SINKS (render.ts cssColor / svgPaint / paintSafeShape /
// fetchFreeOption), so every way a document arrives (file, Replace from JSON,
// paste, a collaborator's op) meets the same gate. Here:
//   1. a deck is generated from the format's own schema: EVERY string field of
//      every element kind, the slide and the theme carries a payload, in ten
//      spellings (a bare url(), `red url()`, a declaration break, two that
//      close a function: `red),url()` for a gradient, `red) url() blur(0` for a
//      drop-shadow filter, a protocol-relative `url(//…)`, which has no colon
//      for a colour's character allowlist to catch, and four CSS-escaped
//      spellings of the name, `u\rl(`, `\75rl(`, `\75 rl(`, `\000075rl(`, which
//      a sink that resolves escapes reads as url(), plus an svg element's
//      <style> and style="" (each shown to FETCH when unsanitized, so neither
//      row can pass blind) and chart option colours. Every element is on
//      screen: the fill's reveal step and hover set are removed, since an
//      element they hide paints nothing. The decks are SERVED over
//      https, as bento.page serves them, so a protocol-relative url() reaches
//      the network as it would there;
//   2. it is opened and walked on every surface: boot, both slides on the
//      canvas, every element's panel, the speaker window, present mode, print,
//      serialize, and the saved file opened with JavaScript OFF (a thumbnailer);
//   3. a second deck morphs a shape into payload paint (present's morph writes
//      fill/stroke/stop-color straight into attributes), and two more force the
//      saved preview down to its tinted-box and title-card tiers, which paint
//      with theme colours;
//   4. a collaborator's presence colour, sent as a real presence frame;
// and every request the page makes to the payload origin is logged: there must
// be none. A raw url() written by the rig on the same page IS logged — the
// positive control that makes the zeros a boundary.
// Mutations: drop the gate at any one FETCHING sink — the palette swatches,
// shape paint, present's morph, chart options (snapshot and live), the preview
// title card's accent bar, a peer's name tag, top-bar chip or Share row, or
// cssColor's function check — and its rows go red. Four more sinks are gated
// for hygiene but write properties that cannot fetch today (present's
// --bento-accent feeds outline/border-color, a peer's selection outline is a
// border-color, the preview's tinted boxes are a gradient, the title card's
// text is a color), so dropping those alone stays green, by design.
// The svg rows: a no-op sanitizeSvgCss turns the <style> row red, and an
// svgUrlRefsAllowed that allows everything turns the style="" row red.
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const root = new URL('..', import.meta.url).pathname
const schemaFile = readdirSync(join(root, 'schema')).filter((f) => /^slides-[\d.]+\.json$/.test(f))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop()
const D = JSON.parse(readFileSync(join(root, 'schema', schemaFile), 'utf8')).$defs
const shell = readFileSync(join(root, 'slides/dist-single/Bento_Slides.bento.html'), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'bento-egress-'))
const O = 'http://h.t' // routed: every request to it is logged, none leaves the machine

const ALL_SPELLINGS = {
  'bare url()': (u) => `url(${u})`,
  'colour then url()': (u) => `red url(${u})`,
  'declaration break': (u) => `red;background:url(${u})`,
  'closes a gradient': (u) => `red),url(${u})`,
  'closes a drop-shadow': (u) => `red) url(${u}) blur(0`,
  // no scheme, so no colon: the one url() a colour's character allowlist does
  // not stop on its own — only the function check does
  'protocol-relative url()': (u) => `url(${u.replace(/^https?:/, '')})`,
  // CSS escapes inside the function name: a sink whose CSS parser resolves them
  // (an svg paint attribute does) reads each of these as url(
  'escaped u\\rl(': (u) => `u\\rl(${u})`,
  'escaped \\75rl(': (u) => `\\75rl(${u})`,
  'escaped \\75 rl(': (u) => `\\75 rl(${u})`,
  'escaped \\000075rl(': (u) => `\\000075rl(${u})`,
}
// EGRESS_SPELLINGS narrows the run (comma-separated names) for mutation sweeps;
// CI runs them all
const only = process.env.EGRESS_SPELLINGS?.split(',').map((s) => s.trim())
const SPELLINGS = Object.fromEntries(Object.entries(ALL_SPELLINGS).filter(([k]) => !only || only.includes(k)))
const SKIP = new Set(['id', 'type', 'docId', 'format', 'collab', 'blobs', 'assets', 'stateOf', 'readonly', 'template', 'html', 'markup', 'code', 'option', 'rows', 'columns', 'comments', 'notes'])
const KINDS = ['text', 'shape', 'image', 'svg', 'chart', 'table', 'media', 'embed', 'code']
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const theme0 = { background: '#ffffff', color: '#1E2A3A', accent: '#f7a600', fontFamily: 'system-ui' }

// builds payloads with unique tags, remembering which field each came from
function payloads(spell) {
  const tags = new Map()
  let n = 0
  const tag = (path) => { const t = (n++).toString(36); tags.set(t, path); return t }
  const pay = (path) => spell(`${O}/${tag(path)}`)
  const raw = (path) => `${O}/${tag(path)}`
  const resolve = (s) => (s && s.$ref ? D[s.$ref.split('/').pop()] : s)
  function fill(s, path, depth = 0) {
    s = resolve(s)
    if (!s || depth > 6) return undefined
    if (s.enum) return s.enum[0]
    if (s.oneOf || s.anyOf) return fill((s.oneOf || s.anyOf)[0], path, depth + 1)
    const t = Array.isArray(s.type) ? s.type[0] : s.type
    if (t === 'string') return pay(path)
    if (t === 'number' || t === 'integer') return Math.min(s.maximum ?? 50, Math.max(s.minimum ?? 0, 40))
    if (t === 'boolean') return true
    if (t === 'array') { const v = fill(s.items, path + '[]', depth + 1); return v === undefined ? [] : [v] }
    if (t === 'object' || s.properties) {
      const o = {}
      for (const [k, v] of Object.entries(s.properties || {})) {
        if (SKIP.has(k)) continue
        const x = fill(v, `${path}.${k}`, depth + 1)
        if (x !== undefined) o[k] = x
      }
      return o
    }
    return undefined
  }
  return { tags, pay, raw, fill }
}
const geo = (i) => ({ x: 60 + (i % 4) * 290, y: 60 + Math.floor(i / 4) * 200, w: 260, h: 160, rotation: 0, opacity: 1 })
const DECK = 'https://deck.test/'
const write = (name, doc) => {
  const open = '<script type="application/bento+json" id="bento-doc">', close = '</' + 'script>'
  const at = shell.indexOf(open) + open.length
  const file = join(dir, name)
  writeFileSync(file, shell.slice(0, at) + JSON.stringify(doc).replace(/</g, '\\u003c') + shell.slice(shell.indexOf(close, at)))
  return DECK + name
}

// The svg element's markup, every row of which FETCHES when it is not
// sanitized — the raw-markup control below proves that, so a row that cannot
// see its sanitizer fails instead of passing. An external paint server never
// does: Chromium will not fetch `fill:url(https://…)`, in a <style>, a style=""
// or a fill=""/stroke="" attribute, so those rows were blind (a no-op
// sanitizeSvgCss stayed green) and are not here.
const svgMarkup = (raw) => `<svg viewBox="0 0 10 10" style="background-image:url(${raw('svg style=""')})">` +
  // An ordinary rule first, then the payload: scopeCss prefixes the stylesheet,
  // and a payload in the first rule (or an @import, which must be first) is
  // turned into a dead selector by the scoping alone, sanitizer or no — such a
  // row passes for the wrong reason.
  `<style>rect{fill:#88aaff} svg{background-image:url(${raw('svg <style> background')})}</style>` +
  '<rect width="10" height="10" fill="#88aaff"/></svg>'

// the every-field deck
function fieldsDeck(P) {
  const element = (kind, i) => {
    const e = { ...P.fill(D[kind], kind), ...geo(i), id: `e-${kind}`, type: kind }
    // The schema fill gives every element a reveal step and a hover set, and an
    // element hidden by either renders display:none — so nothing it carries is
    // ever painted, and its rows cannot see a sink. Neither field is a sink (a
    // step is a number, a set name is a data attribute), so both go, and every
    // element is on screen from the first frame.
    delete e.showOnHover
    if (e.fx) delete e.fx.step
    // an svg element's asset WINS over its markup (render.ts svgMarkup), and
    // the payload key names no asset, so the markup was never drawn
    if (kind === 'svg') delete e.asset
    if (kind === 'text') e.html = `<p style="background:url(${P.raw('text.html style')})">x</p>`
    if (kind === 'shape') e.shape = 'rect'
    if (kind === 'image') e.src = PNG
    if (kind === 'svg') e.markup = svgMarkup(P.raw)
    if (kind === 'chart') e.option = { color: [P.pay('chart option.color[0]')], backgroundColor: P.pay('chart backgroundColor'), textStyle: { color: P.pay('chart textStyle.color') }, legend: { show: true, textStyle: { color: P.pay('chart legend.textStyle.color') } }, xAxis: { type: 'category', data: ['a', 'b'], axisLabel: { color: P.pay('chart axisLabel.color') }, axisLine: { lineStyle: { color: P.pay('chart axisLine.color') } } }, yAxis: { type: 'value', splitLine: { lineStyle: { color: P.pay('chart splitLine.color') } } }, series: [{ name: 's', type: 'bar', data: [1, 2], itemStyle: { color: P.pay('chart series.itemStyle.color') }, label: { show: true, color: P.pay('chart series.label.color') } }, { name: 'l', type: 'line', data: [2, 1], lineStyle: { color: P.pay('chart series.lineStyle.color') }, itemStyle: { color: P.pay('chart line itemStyle.color') } }] }
    if (kind === 'table') { e.columns = [{ w: 1 }, { w: 1 }]; e.header = true; e.rows = [{ cells: [{ html: 'a', color: P.pay('table cell.color'), bg: P.pay('table cell.bg') }, { html: 'b' }] }, { cells: [{ html: '1' }, { html: '2' }] }] }
    if (kind === 'media') { e.kind = 'video'; e.src = 'x.mp4'; delete e.poster }
    if (kind === 'embed') { e.app = 'web'; e.url = 'https://example.com/'; e.live = false }
    if (kind === 'code') { e.code = 'let a = 1'; e.lang = 'js' }
    return e
  }
  const slide = { ...P.fill(D.slide, 'slide'), id: 's1', transition: 'none', notes: '', elements: KINDS.map(element) }
  delete slide.stateOf; delete slide.comments
  return {
    format: 'bento/slides', version: 1, docId: 'egress-fields', title: 'egress',
    size: { width: 1280, height: 720 }, theme: { ...P.fill(D.theme, 'theme'), fontFamily: 'system-ui' },
    slides: [slide, { id: 's2', background: P.pay('slide2.background'), transition: 'fade', notes: '', elements: [] }],
  }
}
// a shape that morphs into payload paint (slide 2 is the morph target)
function morphDeck(P) {
  const shape = (fill, stroke, stops) => ({ id: 'm1', type: 'shape', shape: 'rect', ...geo(0), fill, stroke, strokeWidth: 4, ...(stops ? { fillGradient: { angle: 90, stops } } : {}) })
  const line = (fill) => ({ id: 'm2', type: 'shape', shape: 'line', x: 400, y: 400, w: 300, h: 4, rotation: 0, opacity: 1, fill, strokeWidth: 4 })
  return {
    format: 'bento/slides', version: 1, docId: 'egress-morph', title: 'morph', size: { width: 1280, height: 720 }, theme: theme0,
    slides: [
      { id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: [shape('#123456', '#000000', [{ at: 0, color: '#ff0000' }, { at: 1, color: '#0000ff' }]), line('#222222')] },
      { id: 's2', background: '#ffffff', transition: 'morph', notes: '', elements: [shape(P.pay('morph target fill'), P.pay('morph target stroke')), line(P.pay('morph line colour'))] },
      { id: 's3', background: '#ffffff', transition: 'morph', notes: '', elements: [shape('#00ff00', '#000000', [{ at: 0, color: P.pay('morph gradient stop') }, { at: 1, color: '#000000' }])] },
    ],
  }
}
// first pages that only fit the preview's lower tiers, painted with theme colours
function tierDeck(P, which) {
  const big = 'data:image/png;base64,' + 'A'.repeat(90 * 1024)
  const els = which === 'tinted'
    ? [{ id: 'big', type: 'image', ...geo(0), src: big }]
    : Array.from({ length: 40 }, (_, i) => ({ id: 't' + i, type: 'text', ...geo(i % 8), html: '<p>' + 'words '.repeat(400) + '</p>' }))
  return {
    format: 'bento/slides', version: 1, docId: 'egress-' + which, title: 'tier ' + which, size: { width: 1280, height: 720 },
    theme: { ...theme0, accent: P.pay(`theme.accent (preview ${which})`), color: P.pay(`theme.color (preview ${which})`) },
    slides: [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: els }],
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
async function context(log, js = true) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: js })
  if (js) await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1') } catch {} })
  await ctx.route(/^https?:\/\/h\.t\//, (r) => { log(new URL(r.request().url()).pathname.slice(1)); r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) }) })
  await ctx.route(/^https?:\/\/(?!h\.t\/)/, (r) => r.abort())
  // decks are SERVED, as bento.page serves them: a protocol-relative url() then
  // resolves to the network, where on a file:// page it would not
  await ctx.route(/^https:\/\/deck\.test\//, (r) => {
    const f = join(dir, new URL(r.request().url()).pathname.slice(1))
    return existsSync(f) ? r.fulfill({ status: 200, contentType: 'text/html', body: readFileSync(f) }) : r.fulfill({ status: 404, body: '' })
  })
  return ctx
}
const control = async (p) => {
  await p.evaluate((o) => { const d = document.createElement('div'); d.style.cssText = `width:20px;height:20px;background-image:url(${o}/CONTROL)`; document.body.appendChild(d); d.getBoundingClientRect() }, O)
  await p.waitForTimeout(400)
}
const booted = (p) => p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar'), null, { timeout: 15000 })
const menu = async (p, label) => {
  await p.locator('.ed-present-pill .ed-pill-caret').click()
  await p.locator('.ed-present-pill .ed-menu').getByText(label, { exact: true }).click()
}
// open a saved file the way a thumbnailer does: no script, the preview paints
async function thumbnail(saved, log) {
  const ctx = await context(log, false)
  const name = `saved-${Math.random().toString(36).slice(2)}.html`
  writeFileSync(join(dir, name), saved)
  const p = await ctx.newPage(); await p.goto(DECK + name); await p.waitForTimeout(700)
  await ctx.close()
}
const report = (label, hits, tags) => {
  const leaked = [...hits].filter((t) => t !== 'CONTROL').map((t) => `${tags.get(t) ?? '?'}`)
  ok(hits.has('CONTROL'), `${label}: positive control — a raw url() on this page IS fetched`)
  ok(leaked.length === 0, `${label}: no document string fetched anything${leaked.length ? ' — ' + [...new Set(leaked)].join(', ') : ''}`)
}

try {
  // --- the svg rows can see their sanitizer -------------------------------------
  // The same markup, written UNSANITIZED into a live page: every row must fetch,
  // or its zero below would prove nothing.
  {
    console.log('\nthe svg rows, unsanitized\n')
    const P = payloads((u) => `url(${u})`)
    const markup = svgMarkup(P.raw)
    const hits = new Set()
    const ctx = await context((t) => hits.add(t))
    const p = await ctx.newPage()
    await p.goto(write('raw.bento.html', { format: 'bento/slides', version: 1, docId: 'egress-raw', title: 'raw', size: { width: 1280, height: 720 }, theme: theme0, slides: [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: [] }] }))
    await booted(p)
    await p.evaluate((m) => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:0;top:0;width:40px;height:40px'; d.innerHTML = m; document.body.appendChild(d); d.getBoundingClientRect() }, markup)
    await p.waitForTimeout(700)
    await ctx.close()
    for (const [t, path] of P.tags) ok(hits.has(t), `${path}: fetches when unsanitized, so the row can see the sanitizer`)
  }

  for (const [name, spell] of Object.entries(SPELLINGS)) {
    console.log(`\n${name}\n`)
    // --- every field, every surface ------------------------------------------
    {
      const P = payloads(spell)
      const hits = new Set()
      const ctx = await context((t) => hits.add(t))
      const p = await ctx.newPage()
      const errors = []
      p.on('pageerror', (e) => errors.push(e.message))
      p.on('dialog', (d) => d.dismiss())
      await p.goto(write('fields.bento.html', fieldsDeck(P)))
      await booted(p)
      await p.waitForTimeout(600)
      await control(p)
      for (const i of [1, 0]) { await p.evaluate((i) => document.querySelectorAll('.ed-sidebar .ed-thumb')[i]?.click(), i); await p.waitForTimeout(300) }
      for (const k of KINDS) {
        const box = await p.evaluate((k) => { const e = document.querySelector(`.ed-stage-scale [data-el-id="e-${k}"]`); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + 8, y: r.y + 8 } }, k)
        if (!box) continue
        await p.mouse.click(box.x, box.y); await p.waitForTimeout(200)
        await p.evaluate(() => { for (const h of document.querySelectorAll('.ed-sec-toggle.closed')) h.click() }); await p.waitForTimeout(100)
      }
      await p.mouse.click(5, 880)
      const pop = ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null)
      await menu(p, 'Open speaker view')
      const sw = await pop
      await p.waitForTimeout(500)
      await menu(p, 'Present in this tab')
      await p.waitForTimeout(1200)
      await p.keyboard.press('ArrowRight'); await p.waitForTimeout(1200)
      await p.keyboard.press('Escape'); await p.waitForTimeout(500)
      await p.emulateMedia({ media: 'print' }); await p.evaluate(() => window.dispatchEvent(new Event('beforeprint'))); await p.waitForTimeout(600); await p.emulateMedia({ media: 'screen' })
      const saved = await p.evaluate(() => window.bento.serialize())
      ok(!!sw, 'the speaker window opened')
      ok(errors.length === 0, `no page error${errors.length ? ' — ' + errors[0].slice(0, 100) : ''}`)
      await ctx.close()
      await thumbnail(saved, (t) => hits.add(t))
      report(`every field (${P.tags.size} payloads), every surface`, hits, P.tags)
    }
    // --- a shape morphing into payload paint -------------------------------------
    {
      const P = payloads(spell)
      const hits = new Set()
      const ctx = await context((t) => hits.add(t))
      const p = await ctx.newPage()
      p.on('dialog', (d) => d.dismiss())
      await p.goto(write('morph.bento.html', morphDeck(P)))
      await booted(p); await p.waitForTimeout(400)
      await control(p)
      await p.evaluate(() => document.querySelectorAll('.ed-sidebar .ed-thumb')[0]?.click())
      await menu(p, 'Present in this tab')
      await p.waitForTimeout(800)
      for (let i = 0; i < 2; i++) { await p.keyboard.press('ArrowRight'); await p.waitForTimeout(1600) }
      await p.keyboard.press('Escape'); await p.waitForTimeout(300)
      await ctx.close()
      report('present morph into payload paint', hits, P.tags)
    }
    // --- the preview's lower tiers --------------------------------------------------
    for (const which of ['tinted', 'title']) {
      const P = payloads(spell)
      const hits = new Set()
      const ctx = await context((t) => hits.add(t))
      const p = await ctx.newPage()
      await p.goto(write(`tier-${which}.bento.html`, tierDeck(P, which)))
      await booted(p); await p.waitForTimeout(400)
      await control(p)
      const saved = await p.evaluate(() => window.bento.serialize())
      const tier = /linear-gradient\(135deg/.test(saved) ? 'tinted boxes' : /data-bento-preview/.test(saved) ? 'written' : 'none'
      await ctx.close()
      await thumbnail(saved, (t) => hits.add(t))
      report(`saved preview, ${which === 'tinted' ? 'tinted-box' : 'title-card'} tier (${tier})`, hits, P.tags)
    }
  }

  // --- 4. a collaborator's presence colour, sent as a real presence frame -----------
  // Each peer computes its own colour and sends it in its presence frame; the
  // receiver keeps it as sent, so it is peer-controlled input. The frame goes
  // over the same-machine channel (bento-sync-<docId>), on this slide and
  // selecting an element, so all four places a peer's colour is painted render:
  // the selection outline and name tag on the canvas, the top-bar chip, and the
  // row in the Share panel.
  console.log('\na collaborator\'s presence colour\n')
  for (const [name, spell] of Object.entries(SPELLINGS)) {
    const P = payloads(spell)
    const hits = new Set()
    const ctx = await context((t) => hits.add(t))
    const p = await ctx.newPage()
    const doc = { format: 'bento/slides', version: 1, docId: 'egress-peer', title: 'peer', size: { width: 1280, height: 720 }, theme: theme0,
      slides: [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: [{ id: 'e1', type: 'shape', shape: 'rect', ...geo(0), fill: '#88aaff' }] }] }
    await p.goto(write('peer.bento.html', doc))
    await booted(p); await p.waitForTimeout(500)
    await control(p)
    const color = P.pay(`peer.color (${name})`)
    const send = () => p.evaluate(({ docId, color }) => {
      const ch = new BroadcastChannel('bento-sync-' + docId)
      ch.postMessage({ pv: 2, t: 'p', a: 'zzpeer-actor-rig', p: { name: 'Rig Peer', color, slide: 's1', sel: ['e1'] } })
      ch.close()
    }, { docId: doc.docId, color })
    await send(); await p.waitForTimeout(700)
    await send()
    const seen = await p.waitForFunction(() => (window.bento.sync.peers() || []).some((x) => x.name === 'Rig Peer'), null, { timeout: 4000 }).then(() => true, () => false)
    ok(seen, `${name}: the presence frame arrived — the peer is in the session`)
    await p.locator('.ed-btn-share').click().catch(() => {}) // the Share panel's people rows
    await p.waitForTimeout(700)
    await send(); await p.waitForTimeout(500)
    await ctx.close()
    report(`${name}: a peer's presence colour, all four places it is painted`, hits, P.tags)
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
