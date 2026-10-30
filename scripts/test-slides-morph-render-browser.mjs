// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Paint layers and the morph, end to end: what the renderer draws, what the
// show tweens, what the editor's Preview shows, and how layers are edited.
//
//   npm run build:single --prefix slides && node scripts/test-slides-morph-render-browser.mjs
//
// WHAT THIS PROVES, on the packaged shell:
//   1. Rendering. A stroke gradient paints across the svg's box (userSpaceOnUse,
//      so a flat line still shows it); a line can carry a stroke stack — one
//      <line> per layer, tips on the top one only; a fill layer covers the box
//      whatever the top stroke's position (no outside inset); a layer's blend
//      reaches its node.
//   2. The show (manual clock). A child of a clipping frame stays clipped by
//      the frame WHILE both travel — mid-morph its clip edge sits between the
//      two frames' edges, and at rest the resting clip is back; stroke layers
//      tween colour and width like fill layers; a gradient fill's stops tween.
//   3. The editor's Preview scrubber shows the same: the travelling clip, and
//      gradient stops mixed — with the show's own steppers.
//   4. Editing. Stroke layer rows carry dash, gap and blend; a fill row's grip
//      drags it over another (one undo step); a stroke layer can become a
//      gradient through its popover.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const shape = (id, x, y, w, h, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, rotation: 0, opacity: 1, fill: '#5E7699', stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })
const grad = (a, b, angle = 90) => ({ angle, stops: [{ at: 0, color: a }, { at: 1, color: b }] })
const frame = (w) => shape('F', 100, 100, w, 200, { fill: '#eeeeee', layout: { dir: 'row', gap: 0, pad: [0, 0, 0, 0], clip: true } })
const child = () => shape('C', 100, 100, 600, 200, { fill: '#cc3333', parentId: 'F' })
const slides = [
  { id: 's1', background: '#ffffff', notes: '', transition: 'none', elements: [
    frame(300), child(),
    shape('S', 800, 100, 200, 100, { fill: '#ffffff', strokes: [{ color: '#ff0000', width: 4 }, { color: '#0000ff', width: 8 }] }),
    shape('G', 800, 300, 200, 100, { fill: '#000000', fillGradient: grad('#ff0000', '#0000ff') }),
  ] },
  { id: 's2', background: '#ffffff', notes: '', transition: 'morph', elements: [
    frame(700), child(),
    shape('S', 800, 100, 200, 100, { fill: '#ffffff', strokes: [{ color: '#00ff00', width: 8 }, { color: '#ffff00', width: 16 }] }),
    shape('G', 800, 300, 200, 100, { fill: '#000000', fillGradient: grad('#00ff00', '#ffff00') }),
  ] },
  { id: 's3', background: '#ffffff', notes: '', transition: 'none', elements: [
    shape('R', 100, 100, 200, 100, { stroke: '#000000', strokeWidth: 6, strokeGradient: grad('#ff0000', '#0000ff') }),
    shape('LN', 100, 300, 300, 20, { shape: 'line', fill: '#000000', strokeWidth: 4, strokeGradient: grad('#ff0000', '#0000ff') }),
    shape('LS', 100, 400, 300, 20, { shape: 'line', fill: '#00aa00', strokeWidth: 3, lineEnd: 'arrow', strokes: [{ color: '#000000', width: 9 }, { color: '#00aa00', width: 3 }] }),
    shape('O', 600, 100, 200, 100, {
      fills: [{ color: '#ff0000' }, { color: '#0000ff', blend: 'multiply' }],
      strokes: [{ color: '#000000', width: 10, align: 'outside' }, { color: '#ffaa00', width: 2 }],
      fill: '#0000ff', stroke: '#ffaa00', strokeWidth: 2,
    }),
  ] },
]

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  await ctx.addInitScript(() => {
    try { localStorage.setItem('bento-slideshow-started', '1'); localStorage.setItem('bento-reduce-motion', 'off'); localStorage.setItem('bento-side-view', 'layers') } catch {}
  })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))
  await p.evaluate((slides) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = slides
    window.bento.loadDoc(JSON.stringify(d))
  }, slides)
  await p.waitForTimeout(500)
  // the side column shows Layers, so slides are walked with the store
  const thumb = async (i) => { await p.evaluate((i) => window.bento.store?.goTo ? window.bento.store.goTo(i) : document.querySelectorAll('.ed-sidebar .ed-thumb')[i].click(), i); await p.waitForTimeout(300) }
  const node = (id) => `.ed-stage-scale [data-el-id="${id}"]`
  const model = (si, id) => p.evaluate(([si, id]) => window.bento.doc.slides[si].elements.find((e) => e.id === id), [si, id])
  const undo = async () => { await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250) }
  const rgb = (s) => (/rgba?\(([^)]+)\)/.exec(s ?? '')?.[1] ?? '').split(/[\s,]+/).slice(0, 3).map(Number)
  const between = (v, a, b) => v > Math.min(a, b) + 0.5 && v < Math.max(a, b) - 0.5
  // the x of a clip polygon's second point (the frame's right edge, in the node's box)
  const clipRight = (cp) => { const m = /polygon\([^,]+,\s*([-\d.]+)px/.exec(cp ?? ''); return m ? +m[1] : NaN }

  console.log('\nrendering\n')
  await thumb(2)
  const r = await p.evaluate((sel) => {
    const q = (id) => document.querySelector(`${sel}[data-el-id="${id}"] svg`)
    const R = q('R'), LN = q('LN'), LS = q('LS'), O = q('O')
    const gradOf = (svg, node) => { const id = /url\(#([^)]+)\)/.exec(node?.getAttribute('stroke') ?? '')?.[1]; return id ? svg.querySelector(`[id="${id}"]`) : null }
    const rNode = R.querySelector(':scope > [stroke-width]')
    const lnNode = LN.querySelector('line')
    const lines = [...LS.querySelectorAll(':scope > line')]
    const oFill = O.querySelector('[data-layer="fill0"]')
    const oTop = O.querySelector('[data-layer="fill1"]')
    return {
      rUnits: gradOf(R, rNode)?.getAttribute('gradientUnits'),
      lnUnits: gradOf(LN, lnNode)?.getAttribute('gradientUnits'),
      lineLayers: lines.map((l) => l.getAttribute('data-layer')),
      tips: lines.map((l) => !!l.getAttribute('marker-end')),
      fillBox: oFill ? [+oFill.getAttribute('x'), +oFill.getAttribute('width')] : null,
      blend: oTop?.style.mixBlendMode,
    }
  }, '.ed-stage-scale ')
  ok(r.rUnits === 'userSpaceOnUse', `a rect's stroke gradient paints across the box (${r.rUnits})`)
  ok(r.lnUnits === 'userSpaceOnUse', `a flat line's stroke gradient is drawn — not lost to a zero-height bounding box (${r.lnUnits})`)
  ok(JSON.stringify(r.lineLayers) === '["stroke0","stroke1"]', `a line's stroke stack draws one <line> per layer (${r.lineLayers})`)
  ok(JSON.stringify(r.tips) === '[false,true]', `the arrow tip rides the top stroke only (${r.tips})`)
  ok(r.fillBox && r.fillBox[0] === 0 && r.fillBox[1] === 200, `a fill layer covers the box under an outside stroke — no inset (${r.fillBox})`)
  ok(r.blend === 'multiply', `a layer's blend reaches its node (${r.blend})`)

  console.log('\nthe show\n')
  await thumb(0)
  await p.evaluate(() => window.bento.anim.setManual(true))
  await p.keyboard.press('F5')
  await p.waitForFunction(() => document.querySelector('.bento-present-overlay .reveal .slides > section'), null, { timeout: 10000 })
  await p.waitForTimeout(400)
  const tick = (secs) => p.evaluate((s) => { for (let t = 0; t < s; t += 0.02) window.bento.anim.tick(0.02) }, secs)
  const show = (sel) => p.evaluate((sel) => {
    const here = [...document.querySelectorAll(`.bento-present-overlay ${sel}`)]
    const n = here.find((x) => x.closest('section.present')) ?? here[0]
    return n
      ? { clip: n.style?.clipPath ?? '', stroke: n.getAttribute?.('stroke'), width: +(n.getAttribute?.('stroke-width') ?? NaN), stops: [...(n.ownerSVGElement ?? n).querySelectorAll?.('stop') ?? []].map((s) => s.getAttribute('stop-color')) }
      : null
  }, sel)
  const restClip1 = (await show('[data-el-id="C"]'))?.clip
  ok(/inset/.test(restClip1 ?? ''), `at rest on the first slide the child is clipped by its narrow frame (${restClip1})`)
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(120)
  await tick(0.3)
  const mid = await show('[data-el-id="C"]')
  const edge = clipRight(mid?.clip)
  ok(/^polygon/.test(mid?.clip ?? '') && edge > 300.5 && edge < 699.5, `mid-morph the clip follows the frame as it widens — right edge ${edge} between 300 and 700`)
  const s1 = await show('[data-el-id="S"] [data-layer="stroke1"]')
  const c1 = rgb(s1?.stroke)
  ok(c1.length === 3 && between(c1[2], 255, 0) && between(c1[0], 0, 255), `a stroke layer's colour is mid-tween (${s1?.stroke})`)
  ok(between(s1?.width, 8, 16), `…and its width too (${s1?.width})`)
  const gm = await show('[data-el-id="G"] svg > :not(defs)')
  const g0 = rgb(gm?.stops?.[0])
  ok(g0.length === 3 && between(g0[0], 255, 0), `a gradient fill's stops tween (${gm?.stops?.[0]})`)
  await tick(2)
  const end = await show('[data-el-id="C"]')
  ok(!/polygon/.test(end?.clip ?? ''), `at rest the travelling clip hands back to the resting one ('${end?.clip}')`)
  const s2 = await show('[data-el-id="S"] [data-layer="stroke1"]')
  ok(s2?.stroke === '#ffff00' && s2?.width === 16, `the stroke layer lands on its own paint (${s2?.stroke}, ${s2?.width})`)
  await p.keyboard.press('Escape'); await p.waitForTimeout(300)
  await p.evaluate(() => window.bento.anim.setManual(false))

  console.log('\nthe editor Preview\n')
  await thumb(1)
  await p.locator('.ed-side-layers .ed-layer[data-id="G"]').click(); await p.waitForTimeout(200)
  await p.locator('.ed-props .ed-tabs [role="tab"]', { hasText: /^Animate$/i }).click(); await p.waitForTimeout(200)
  const range = p.locator('.ed-props .ed-morph-preview')
  ok(await range.count() === 1, 'the Morph section offers its Preview')
  await range.evaluate((r) => { r.value = '50'; r.dispatchEvent(new Event('input')) })
  const pv = await p.evaluate(() => {
    const c = document.querySelector('.ed-stage-scale [data-el-id="C"]')
    const stop = document.querySelector('.ed-stage-scale [data-el-id="G"] stop')
    return { clip: c?.style.clipPath, stop: stop?.getAttribute('stop-color') }
  })
  const pe = clipRight(pv.clip)
  ok(/^polygon/.test(pv.clip ?? '') && pe > 300.5 && pe < 699.5, `at 50% the child is clipped by the frame halfway (${pe})`)
  const ps = rgb(pv.stop)
  ok(ps.length === 3 && between(ps[0], 255, 0) && between(ps[1], 0, 255), `the gradient's stops are mixed in the preview, as in the show (${pv.stop})`)
  await range.evaluate((r) => r.dispatchEvent(new Event('pointerup')))
  await p.waitForTimeout(200)

  console.log('\nediting layers\n')
  await thumb(2)
  await p.locator('.ed-side-layers .ed-layer[data-id="O"]').click(); await p.waitForTimeout(250)
  await p.locator('.ed-props .ed-tabs [role="tab"]', { hasText: /^Format$/i }).click(); await p.waitForTimeout(200)
  const row = (k) => p.locator(`.ed-props .ed-paintlayer[data-layer="${k}"]`)
  // a layer's blend and dashes sit behind its ⋯
  await row('stroke1').locator('.ed-paintlayer-more').click(); await p.waitForTimeout(150)
  await row('fill1').locator('.ed-paintlayer-more').click(); await p.waitForTimeout(150)
  ok(await row('stroke1').locator('.ed-layer-blend').count() === 1 && await row('fill1').locator('.ed-layer-blend').count() === 1, 'every layer row offers a blend mode')
  ok(await row('stroke1').locator('input[aria-label="Dash"], .ed-mini:has-text("Dash")').count() >= 1, 'a stroke layer row offers dash and gap')
  await row('fill1').locator('.ed-layer-blend').selectOption('screen'); await p.waitForTimeout(200)
  ok((await model(2, 'O')).fills[1].blend === 'screen', 'choosing a blend writes the layer')
  await undo()
  ok((await model(2, 'O')).fills[1].blend === 'multiply', 'one undo puts it back')
  const before = (await model(2, 'O')).fills.map((f) => f.color)
  await row('fill0').locator('.ed-paintlayer-grip').dragTo(row('fill1'))
  await p.waitForTimeout(300)
  const after = (await model(2, 'O')).fills.map((f) => f.color)
  ok(JSON.stringify(after) === JSON.stringify([...before].reverse()), `dragging a fill row onto another reorders the stack (${before} → ${after})`)
  await undo()
  ok(JSON.stringify((await model(2, 'O')).fills.map((f) => f.color)) === JSON.stringify(before), 'one undo restores the order')
  // a stroke layer becomes a gradient through its popover
  await row('stroke1').locator('input[type=color]').first().click(); await p.waitForTimeout(250)
  await p.click('.ed-cpop .ed-cpop-kinds [data-kind="linear"]'); await p.waitForTimeout(200)
  ok(await p.locator('.ed-grad-layer').count() === 1, 'the canvas shows the gradient handle while the popover edits it')
  await p.keyboard.press('Enter'); await p.waitForTimeout(300)
  const sg = (await model(2, 'O')).strokes[1]
  ok(sg.gradient?.stops?.length >= 2, 'the stroke layer now carries a gradient')
  const drawn = await p.evaluate(() => document.querySelector('.ed-stage-scale [data-el-id="O"] [data-layer="stroke1"]')?.getAttribute('stroke'))
  ok(/^url\(#/.test(drawn ?? ''), `…and draws with it (${drawn})`)
  await undo()
  ok(!(await model(2, 'O')).strokes[1].gradient, 'one undo makes it solid again')

  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
