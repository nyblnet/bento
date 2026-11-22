// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The Export section's SVG is native vectors a design tool can open, and it
// looks like the slide.
//
//   npm run build:single --prefix slides && node scripts/test-slides-svg-export-browser.mjs
//
// WHAT THIS PROVES, on a slide carrying one of everything (gradient rect with
// stroke, radius and shadow; a turned ellipse; a mirrored triangle; wrapped
// bold centred text; a bulleted list; a turned italic text; a formula; a picture; an svg element; a table):
//   1. the file is well-formed SVG with NO <foreignObject> and no HTML in it —
//      shapes, <text> runs, an <image>, gradients, a shadow filter;
//   2. each element is a group in slide coordinates carrying its turn and
//      mirror as transforms; every word of the text is in a <text>, and the
//      list keeps its bullets;
//   3. drawn by the browser as a plain <img>, it matches the slide's own
//      render (the PNG export) — compared pixel by pixel, with a tolerance for
//      glyph anti-aliasing — and is far from a blank slide, so the comparison
//      has teeth;
//   4. an element's export includes what spills past its box: a shadowed
//      rect's PNG and SVG frame the shadow too.
import { readFileSync } from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)]

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-panel-open', JSON.stringify({ Export: true })) } catch {} })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))
  const base = { rotation: 0, opacity: 1 }
  const shape = (id, shape, x, y, w, h, extra = {}) => ({ ...base, id, type: 'shape', shape, x, y, w, h, fill: '#2266cc', stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })
  const text = (id, x, y, w, h, html, extra = {}) => ({ ...base, id, type: 'text', x, y, w, h, html, fontSize: 28, fontFamily: 'Arial, sans-serif', fontWeight: 400, color: '#1e2a3a', align: 'left', valign: 'top', lineHeight: 1.25, ...extra })
  await p.evaluate(({ els }) => {
    // a 4×4 picture, half orange, half teal, made here so the fixture carries no binary
    const c = document.createElement('canvas'); c.width = 4; c.height = 4
    const g = c.getContext('2d'); g.fillStyle = '#ff8800'; g.fillRect(0, 0, 2, 4); g.fillStyle = '#008888'; g.fillRect(2, 0, 2, 4)
    els.push({ id: 'pic', type: 'image', x: 980, y: 60, w: 200, h: 120, rotation: 0, opacity: 1, src: c.toDataURL('image/png'), fit: 'fill', radius: 0 })
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#f4f1ea', notes: '', transition: 'none', elements: els }]
    window.bento.loadDoc(JSON.stringify(d))
  }, {
    els: [
      shape('card', 'rect', 60, 60, 320, 200, { radius: 16, stroke: '#1e2a3a', strokeWidth: 4, fillGradient: { angle: 90, stops: [{ at: 0, color: '#ffcc00' }, { at: 1, color: '#ff3366' }] }, shadow: { x: 0, y: 12, blur: 24, color: 'rgba(0,0,0,0.35)' } }),
      shape('oval', 'ellipse', 460, 80, 240, 140, { rotation: 30, fill: '#22aa66' }),
      shape('tri', 'triangle', 760, 60, 160, 160, { fill: '#8844cc', flipX: true }),
      text('title', 60, 320, 420, 160, '<b>Native vectors</b> for every design tool, wrapped over lines', { align: 'center', color: '#a03010' }),
      text('list', 560, 320, 360, 160, '<ul><li>First point</li><li>Second point</li></ul>', { fontSize: 24 }),
      text('formula', 980, 440, 260, 60, '$E = mc^2$', { fontSize: 32 }),
      text('turned', 700, 520, 360, 60, 'Turned <i>text</i>', { rotation: -12, fontSize: 32, color: '#225588' }),
      { ...base, id: 'logo', type: 'svg', x: 980, y: 240, w: 160, h: 160, markup: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#cc2244"/><rect x="30" y="30" width="40" height="40" fill="#ffffff"/></svg>' },
      { ...base, id: 'tab', type: 'table', x: 60, y: 520, w: 520, h: 120, columns: [{ w: 1 }, { w: 1 }], header: true, rows: [{ cells: [{ html: 'Region' }, { html: 'Sales' }] }, { cells: [{ html: 'North' }, { html: '42' }] }], style: { headerBg: '#1e2a3a', headerColor: '#ffffff', borderColor: '#999999', borderWidth: 1, fontSize: 20 } },
    ],
  })
  await p.waitForTimeout(500)
  const download = async (label) => {
    // the first setting row set to this label's scale and format, then Export (Figma's section)
    const [fmt, scale] = label === 'SVG' ? ['svg', '1'] : label === 'JPG' ? ['jpeg', '1'] : ['png', label === 'PNG 2×' ? '2' : '1']
    await p.selectOption('.ed-props .ed-export-row >> nth=0 >> select[aria-label="Format"]', fmt); await p.waitForTimeout(150)
    if (fmt !== 'svg') { await p.selectOption('.ed-props .ed-export-row >> nth=0 >> select[aria-label="Scale"]', scale); await p.waitForTimeout(150) }
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.ed-props .ed-export-rows .ed-export-btn')])
    return { name: dl.suggestedFilename(), buf: readFileSync(await dl.path()) }
  }

  console.log('\n1. native, well-formed\n')
  await p.keyboard.press('Escape'); await p.waitForTimeout(200)
  const svg = (await download('SVG')).buf.toString('utf8')
  const parsed = await p.evaluate((s) => {
    const d = new DOMParser().parseFromString(s, 'image/svg+xml')
    const count = (sel) => d.querySelectorAll(sel).length
    return {
      error: d.querySelector('parsererror')?.textContent ?? null,
      root: d.documentElement.localName,
      foreign: count('foreignObject'),
      html: [...d.querySelectorAll('*')].filter((e) => e.namespaceURI === 'http://www.w3.org/1999/xhtml').length,
      texts: [...d.querySelectorAll('text')].map((t) => t.textContent),
      images: count('image'),
      gradients: count('linearGradient'),
      filters: count('filter feGaussianBlur'),
      groups: [...d.querySelectorAll('g[data-el-id]')].map((g) => [g.getAttribute('data-el-id'), g.getAttribute('transform')]),
      flips: [...d.querySelectorAll('g[transform*="scale(-1 1)"]')].length,
      shapes: count('path, rect, ellipse, circle, polygon, line'),
    }
  }, svg)
  ok(!parsed.error && parsed.root === 'svg', `the file parses as SVG (${parsed.error ?? 'no parser error'})`)
  ok(parsed.foreign === 0 && parsed.html === 0, `no <foreignObject>, no HTML (${parsed.foreign}, ${parsed.html})`)
  ok(parsed.images === 2, `the picture and the formula are the two <image>s — MathML has no vector form a design tool reads (${parsed.images})`)
  ok(!/<math\b/.test(svg), 'no MathML is left in the file')
  ok(parsed.gradients >= 1 && parsed.filters >= 1, `the gradient fill and the shadow are SVG defs (${parsed.gradients} gradient, ${parsed.filters} blur)`)
  ok(parsed.shapes >= 8, `shapes, the svg element and the table's boxes are vector primitives (${parsed.shapes})`)

  console.log('\n2. groups, transforms, words\n')
  const g = Object.fromEntries(parsed.groups)
  ok(['card', 'oval', 'tri', 'title', 'list', 'turned', 'pic', 'logo', 'tab'].every((id) => id in g), `every element is a group of its own (${Object.keys(g).join(', ')})`)
  ok(/translate\(460 80\) rotate\(30 120 70\)/.test(g.oval ?? ''), `the ellipse turns about its own centre in slide coordinates (${g.oval})`)
  ok(parsed.flips >= 1, 'the mirrored triangle carries its mirror as a transform')
  const words = parsed.texts.join(' ')
  ok(['Turned', 'text', 'Native', 'vectors', 'design', 'wrapped', 'lines', 'First', 'Second', 'Region', 'Sales', 'North', '42'].every((w) => words.includes(w)), 'every word is in a <text>, the table\'s too')
  const titleRuns = await p.evaluate((s) => {
    const d = new DOMParser().parseFromString(s, 'image/svg+xml')
    return [...d.querySelectorAll('g[data-el-id="title"] text')].map((t) => +t.getAttribute('y'))
  }, svg)
  ok(new Set(titleRuns.map((y) => Math.round(y))).size >= 2, `the wrapped title keeps its line breaks (${[...new Set(titleRuns.map((y) => Math.round(y)))].join(', ')} as baselines)`)
  ok(parsed.texts.filter((t) => t.trim() === '•').length === 2, `the list keeps both bullets (${parsed.texts.filter((t) => t.trim() === '•').length})`)
  ok(/font-weight="700"/.test(svg), 'the bold run stays bold')
  ok(/font-style="italic"/.test(svg), 'the italic run stays italic')
  ok(/translate\(700 520\) rotate\(-12 180 30\)/.test(g.turned ?? ''), `a turned text is measured unturned and turned back as a transform (${g.turned})`)

  console.log('\n3. it looks like the slide\n')
  const png = (await download('PNG 1×')).buf.toString('base64')
  const cmp = await p.evaluate(async ({ svg, png }) => {
    const load = async (src) => { const i = new Image(); i.src = src; await i.decode(); return i }
    const draw = (img, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(img, 0, 0, w, h); return g.getImageData(0, 0, w, h).data }
    const ref = await load('data:image/png;base64,' + png)
    const W = ref.width, H = ref.height
    const a = draw(ref, W, H)
    const b = draw(await load('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)), W, H)
    let off = 0, blankOff = 0
    const bg = [0xf4, 0xf1, 0xea]
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
      if (d > 48) off++
      if (Math.max(Math.abs(a[i] - bg[0]), Math.abs(a[i + 1] - bg[1]), Math.abs(a[i + 2] - bg[2])) > 48) blankOff++
    }
    return { off: off / (W * H), blank: blankOff / (W * H), W, H }
  }, { svg, png })
  ok(cmp.blank > 0.12, `the slide is far from blank — ${(cmp.blank * 100).toFixed(1)}% of it differs from its background, so the comparison has teeth`)
  ok(cmp.off < 0.005, `the SVG drawn as an <img> matches the slide's render: ${(cmp.off * 100).toFixed(2)}% of ${cmp.W}×${cmp.H} pixels differ (glyph and hairline edges), under 0.5%`)

  console.log('\n4. what spills past an element\'s box\n')
  const b = await p.locator('.ed-stage-scale [data-el-id="card"]').boundingBox()
  await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await p.waitForTimeout(250)
  const [cw, ch] = pngSize((await download('PNG 1×')).buf)
  // 320×200 + a 4px centred stroke (2 each side) + a 24px shadow: 3σ = 72 around, shifted 12 down (60 above, 84 below)
  ok(cw >= 320 + 2 * 72 && ch >= 200 + 60 + 84, `the shadowed card's PNG frames its shadow and stroke (${cw}×${ch}, box 320×200)`)
  const cardSvg = (await download('SVG')).buf.toString('utf8')
  const vb = /viewBox="([^"]+)"/.exec(cardSvg)[1].split(' ').map(Number)
  ok(vb[2] === cw && vb[3] === ch, `the SVG frames the same spill (${vb.join(' ')})`)
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
