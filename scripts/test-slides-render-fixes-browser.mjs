// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// What the render review found, held: morph paint lands on the drawn node,
// mirrors survive the show, and exports and alt say only what is true.
//
//   npm run build:single --prefix slides && node scripts/test-slides-render-fixes-browser.mjs
//
// WHAT THIS PROVES, on the packaged shell (the show on a manual clock):
//   1. A morph of a shape with an outside (masked) stroke tweens the DRAWN
//      polygon's fill and the stroke's width; the mask's own rect stays white.
//   2. A fill stack with the same layers tweens layer by layer.
//   3. Radial → radial moves the gradient's centre through the middle, not at
//      the end; radial → linear crossfades from a copy painted with the source
//      gradient, and the copy is gone at rest.
//   4. Marching ants on a masked stroke animate the stroke node, never the
//      mask's rect.
//   5. A mirrored chart stays mirrored in the show (live mount and the restored
//      snapshot), and a mirrored cropped picture stays mirrored through a crop
//      morph.
//   6. Export: a child of a clipping frame exports clipped (its SVG carries the
//      clip); a selection of hidden elements cannot be exported to an image and
//      says why.
//   7. alt reads as role="img" on a shape, never on a table or media element
//      (their own cells and controls stay reachable), and the inspector offers
//      it only where it renders.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
import { readFileSync } from 'node:fs'

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwnwEIGBgAHu8D/YQm3LAAAAAASUVORK5CYII='
const base = { rotation: 0, opacity: 1, stroke: 'transparent', strokeWidth: 0, radius: 0 }
const sh = (id, shape, x, y, extra = {}) => ({ id, type: 'shape', shape, x, y, w: 200, h: 200, ...base, fill: '#ff0000', ...extra })
const stops = (a, b) => [{ at: 0, color: a }, { at: 1, color: b }]
const between = (v, a, b) => v > Math.min(a, b) + 0.5 && v < Math.max(a, b) - 0.5
const rgb = (s) => (s?.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  await ctx.addInitScript(() => { try { localStorage.setItem('bento-panel-open', JSON.stringify({ Export: true })); localStorage.setItem('bento-side-view', 'layers') } catch {} })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))
  const load = (slides) => p.evaluate((slides) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = slides
    window.bento.loadDoc(JSON.stringify(d))
  }, slides)

  // --- the show ---------------------------------------------------------------
  const chart = { id: 'ch', type: 'chart', x: 1000, y: 400, w: 300, h: 200, rotation: 0, opacity: 1, flipX: true, option: { xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [1, 3] }] } }
  const img = (crop) => ({ id: 'im', type: 'image', x: 1000, y: 50, w: 200, h: 100, rotation: 0, opacity: 1, src: PNG, fit: 'cover', radius: 0, flipX: true, crop })
  const s1 = [
    sh('m', 'triangle', 50, 50, { stroke: '#000000', strokeWidth: 12, strokeAlign: 'outside', fill: '#ff0000', strokeDashes: [10, 5], fx: { loop: { type: 'dash-march' } } }),
    sh('st', 'rect', 300, 50, { fills: [{ color: '#ff0000' }, { color: 'rgba(0,255,0,0.5)' }] }),
    sh('rr', 'rect', 550, 50, { fillGradient: { angle: 90, kind: 'radial', cx: 0.2, cy: 0.5, r: 0.5, stops: stops('#ff0000', '#0000ff') } }),
    sh('rl', 'rect', 50, 400, { fillGradient: { angle: 90, kind: 'radial', cx: 0.5, cy: 0.5, r: 0.5, stops: stops('#ff0000', '#0000ff') } }),
    chart, img({ x: 0.1, y: 0.1, scale: 2 }),
  ]
  const s2 = s1.map((e) => {
    if (e.id === 'm') return { ...e, fill: '#0000ff', strokeWidth: 24 }
    if (e.id === 'st') return { ...e, fills: [{ color: '#0000ff' }, { color: 'rgba(255,255,0,0.5)' }] }
    if (e.id === 'rr') return { ...e, fillGradient: { ...e.fillGradient, cx: 0.8 } }
    if (e.id === 'rl') return { ...e, fillGradient: { angle: 90, stops: stops('#00ff00', '#ffff00') } }
    if (e.id === 'im') return img({ x: 0.8, y: 0.8, scale: 3 })
    return e
  })
  await load([
    { id: 's1', background: '#ffffff', notes: '', transition: 'none', elements: s1 },
    { id: 's2', background: '#ffffff', notes: '', transition: 'morph', elements: s2 },
  ])
  await p.waitForTimeout(400)
  await p.evaluate(() => window.bento.anim.setManual(true))
  await p.keyboard.press('F5')
  await p.waitForFunction(() => document.querySelector('.bento-present-overlay .reveal .slides > section'), null, { timeout: 10000 })
  await p.waitForTimeout(400)
  const inShow = (fn, arg) => p.evaluate(([src, arg]) => {
    const sec = document.querySelector('.bento-present-overlay section.present')
    return new Function('sec', 'arg', src)(sec, arg)
  }, [fn, arg])

  console.log('\nmarching ants and mirrors on the first slide\n')
  const ants = await inShow(`
    const svg = sec.querySelector('[data-el-id="m"] > svg')
    const tw = (n) => n ? window.bento.anim.getTweensOf(n).length : -1
    return { stroke: tw([...svg.querySelectorAll(':scope > [stroke-width]')].pop()), mask: tw(svg.querySelector('mask rect')) }`)
  ok(ants.stroke > 0 && ants.mask === 0, `dash-march animates the drawn stroke, not the mask's rect (stroke ${ants.stroke}, mask ${ants.mask})`)
  const flips1 = await inShow(`
    const ch = sec.querySelector('[data-el-id="ch"]')
    return { chart: [...ch.children].map((c) => c.style.transform).join('|'), img: sec.querySelector('[data-el-id="im"] img')?.style.transform }`)
  ok(/scale\(-1, 1\)/.test(flips1.chart), `a mirrored live chart is mirrored in the show (${flips1.chart})`)

  console.log('\nthe morph, half way\n')
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(100)
  // MORPH_DURATION is ~1s: step to about the middle
  await p.evaluate(() => { for (let i = 0; i < 9; i++) window.bento.anim.tick(0.05) })
  const mid = await inShow(`
    const q = (id) => sec.querySelector('[data-el-id="' + id + '"] > svg')
    const m = q('m'), st = q('st'), rr = q('rr'), rl = q('rl')
    const grad = (svg) => { const id = /url\\(#([^)]+)\\)/.exec(svg.querySelector(':scope > rect').getAttribute('fill') ?? '')?.[1]; return id && svg.querySelector('[id="' + id + '"]') }
    const fade = rl.querySelector('[data-morph-fade]')
    return {
      polyFill: m.querySelector(':scope > polygon').getAttribute('fill'),
      maskRect: m.querySelector('mask rect')?.getAttribute('fill'),
      strokeW: parseFloat([...m.querySelectorAll(':scope > [stroke-width]')].pop().getAttribute('stroke-width')),
      layer0: st.querySelector('[data-layer="fill0"]').getAttribute('fill'),
      layer1: st.querySelector('[data-layer="fill1"]').getAttribute('fill'),
      rrCx: parseFloat(grad(rr)?.getAttribute('cx')),
      fadeTag: fade && (() => { const id = /url\\(#([^)]+)\\)/.exec(fade.getAttribute('fill'))?.[1]; return rl.querySelector('[id="' + id + '"]')?.tagName })(),
      destOpacity: parseFloat(rl.querySelector(':scope > rect:not([data-morph-fade])').getAttribute('fill-opacity')),
    }`)
  const pf = rgb(mid.polyFill)
  ok(pf.length === 3 && between(pf[0], 255, 0) && between(pf[2], 0, 255), `the drawn polygon's fill is mid-tween (${mid.polyFill})`)
  ok(mid.maskRect === 'white', `the outside stroke's mask rect is untouched (${mid.maskRect})`)
  ok(mid.strokeW > 24 && mid.strokeW < 48, `the masked stroke's drawn width tweens (${mid.strokeW}, doubled 24→48)`)
  const l0 = rgb(mid.layer0), l1 = rgb(mid.layer1)
  ok(between(l0[0], 255, 0) && between(l0[2], 0, 255) && between(l1[2], 0, 0 + 0.001) === false && between(l1[1], 255, 255) === false && between(l1[0], 0, 255), `each fill layer is mid-tween (${mid.layer0} · ${mid.layer1})`)
  const end = await (async () => {
    await p.evaluate(() => { for (let i = 0; i < 80; i++) window.bento.anim.tick(0.05) })
    return inShow(`
      const rr = sec.querySelector('[data-el-id="rr"] > svg'), rl = sec.querySelector('[data-el-id="rl"] > svg')
      const id = /url\\(#([^)]+)\\)/.exec(rr.querySelector(':scope > rect').getAttribute('fill') ?? '')?.[1]
      return { rrCx: parseFloat(rr.querySelector('[id="' + id + '"]')?.getAttribute('cx')), fades: rl.querySelectorAll('[data-morph-fade]').length, op: rl.querySelector(':scope > rect').getAttribute('fill-opacity') }`)
  })()
  ok(mid.rrCx > 0.21 && mid.rrCx < end.rrCx - 0.01, `radial → radial: the centre is on its way at the middle (${mid.rrCx} → ${end.rrCx})`)
  ok(mid.fadeTag === 'radialGradient' && mid.destOpacity > 0 && mid.destOpacity < 1, `radial → linear crossfades from a radial copy (${mid.fadeTag}, destination at ${mid.destOpacity})`)
  ok(end.fades === 0 && end.op === null, `at rest the copy is gone and the destination is opaque (${end.fades}, ${end.op})`)
  const flips2 = await inShow(`
    const ch = sec.querySelector('[data-el-id="ch"]')
    return { chart: [...ch.children].map((c) => c.style.transform).join('|'), img: sec.querySelector('[data-el-id="im"] img')?.style.transform }`)
  ok(/scale\(-1, 1\)/.test(flips2.img ?? ''), `a mirrored picture stays mirrored through a crop morph (${flips2.img})`)
  ok(/scale\(-1, 1\)/.test(flips2.chart), `the chart on the next slide is mirrored too (${flips2.chart})`)
  await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(200)
  await p.evaluate(() => { for (let i = 0; i < 40; i++) window.bento.anim.tick(0.05) })
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(200)
  const restored = await p.evaluate(() => {
    const ch = [...document.querySelectorAll('.bento-present-overlay section [data-el-id="ch"]')].find((n) => !n.closest('section.present'))
    return ch ? [...ch.children].map((c) => c.style.transform).join('|') : 'none'
  })
  ok(/scale\(-1, 1\)/.test(restored), `the snapshot a chart leaves behind is mirrored (${restored})`)
  await p.evaluate(() => window.bento.anim.setManual(false))
  await p.keyboard.press('Escape'); await p.waitForTimeout(400)

  // --- the editor -------------------------------------------------------------
  console.log('\nexport and alt\n')
  const frame = sh('F', 'rect', 100, 100, { w: 300, h: 200, fill: '#eeeeee', layout: { dir: 'row', gap: 0, pad: [0, 0, 0, 0], clip: true } })
  await load([{ id: 's1', background: '#ffffff', notes: '', transition: 'none', elements: [
    frame,
    sh('kid', 'rect', 100, 100, { w: 500, h: 100, parentId: 'F', sizing: {} }),
    sh('gone', 'ellipse', 600, 100, { hidden: true }),
    sh('pic', 'rect', 900, 100, { alt: 'A red square' }),
    { id: 'tb', type: 'table', x: 100, y: 500, w: 300, h: 100, rotation: 0, opacity: 1, columns: [{ w: 1 }, { w: 1 }], header: false, rows: [{ cells: [{ html: 'a' }, { html: 'b' }] }], style: {}, alt: 'should not apply' },
  ] }])
  await p.waitForTimeout(500)
  const row = (id) => p.locator(`.ed-side-layers .ed-layer[data-id="${id}"]`)
  const download = async (label) => {
    // the first setting row set to this label's scale and format, then Export (Figma's section)
    const [fmt, scale] = label === 'SVG' ? ['svg', '1'] : label === 'JPG' ? ['jpeg', '1'] : ['png', label === 'PNG 2×' ? '2' : '1']
    await p.selectOption('.ed-props .ed-export-row >> nth=0 >> select[aria-label="Format"]', fmt); await p.waitForTimeout(150)
    if (fmt !== 'svg') { await p.selectOption('.ed-props .ed-export-row >> nth=0 >> select[aria-label="Scale"]', scale); await p.waitForTimeout(150) }
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.ed-props .ed-export-rows .ed-export-btn')])
    return readFileSync(await dl.path(), 'utf8')
  }
  await row('kid').click(); await p.waitForTimeout(300)
  const svg = await download('SVG')
  ok(/clip-path="url\(#/.test(svg), 'a clipped frame child exports clipped')
  await row('gone').click(); await p.waitForTimeout(300)
  const go = await p.$eval('.ed-props .ed-export-rows .ed-export-btn', (b) => [b.textContent, b.disabled, b.title])
  ok(go[1] && !!go[2], `a hidden selection cannot be drawn to an image, and says why (${go[0]}: ${go[1]})`)
  const more = await p.$eval('.ed-props .ed-export-row button[aria-haspopup="menu"]', (b) => !b.disabled)
  ok(more, '…while Copy as JSON (in ⋯) still works')
  const roles = await p.evaluate(() => ['pic', 'tb'].map((id) => { const n = document.querySelector(`.ed-stage-scale [data-el-id="${id}"]`); return n ? n.getAttribute('role') ?? 'none' : 'missing' }))
  ok(roles[0] === 'img' && roles[1] === 'none', `alt makes a shape an image to screen readers, never a table (${roles})`)
  await row('tb').click(); await p.waitForTimeout(300)
  ok(await p.locator('.ed-props .ed-a11y-alt').count() === 0, 'the inspector offers no alt text for a table')
  await row('pic').click(); await p.waitForTimeout(300)
  ok(await p.locator('.ed-props .ed-a11y-alt').count() === 1, '…and does for a shape')

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
