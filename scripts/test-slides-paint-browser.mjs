// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Paint in the editor: gradients (Solid | Linear | Radial, the stop bar, the
// popover's kinds, the canvas handle), stroke position and dashes, per-corner
// radii, flip, and the hover previews — end to end in the built shell.
//
//   npm run build:single --prefix slides && node scripts/test-slides-paint-browser.mjs
//
// WHAT THIS PROVES.
//   1. The renderer draws the new keys: a radialGradient with its centre and
//      radius, a radial text fill, a per-corner rect as a path with arcs, an
//      outside stroke on a triangle as a masked doubled stroke, a flip as a
//      mirrored content node.
//   2. Fill kind is one click; the stop bar adds a stop where it is clicked
//      and Backspace removes the focused one; each is one undo step.
//   3. The colour popover on a gradient offers Solid | Linear | Radial | Tokens;
//      switching previews at once, Esc puts the fill back.
//   4. A radial gradient being edited (its chip focused — selection alone shows
//      nothing) has a centre knob and a dot per stop on the canvas; dragging
//      moves the centre or the stop, one undo step each; focus elsewhere puts
//      the handle away.
//   5. Stroke position, Custom dashes, the corners button and Flip write the
//      model.
//   6. Pointing at a Shadow preset or an entrance previews it on the canvas
//      node and writes nothing.
//   7. Stroke position by PIXELS, for rect, ellipse, triangle and a closed
//      path: inside covers the band just inside the edge, center straddles
//      it, outside covers the band just outside it and leaves the fill on the
//      box — so a mask drawn inverted, a triangle's center drawn as outside,
//      or an outside stroke dragging the fill past the box all fail here.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))
  const shape = (id, x, y, w, h, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, rotation: 0, opacity: 1, fill: '#5E7699', stroke: 'transparent', strokeWidth: 0, radius: 0, ...extra })
  const stops = [{ at: 0, color: '#ff0000' }, { at: 1, color: '#0000ff' }]
  await p.evaluate((els) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', notes: '', transition: 'none', elements: els }]
    window.bento.loadDoc(JSON.stringify(d))
  }, [
    shape('rad', 100, 100, 300, 200, { fillGradient: { angle: 180, kind: 'radial', cx: 0.3, cy: 0.4, r: 0.6, stops } }),
    shape('tri', 500, 100, 200, 200, { shape: 'triangle', stroke: '#000000', strokeWidth: 8, strokeAlign: 'outside' }),
    shape('corn', 100, 400, 200, 150, { radii: [0, 10, 20, 40], radius: 40 }),
    shape('flip', 500, 400, 200, 100, { shape: 'arrow', flipX: true }),
    { id: 'tx', type: 'text', html: 'Hello', x: 800, y: 100, w: 300, h: 80, rotation: 0, opacity: 1, fontSize: 40, fontFamily: 'system-ui', fontWeight: 700, color: '#000', align: 'left', valign: 'top', lineHeight: 1.2, colorGradient: { angle: 90, kind: 'radial', stops } },
  ])
  await p.waitForTimeout(500)
  const el = (id) => p.evaluate((id) => window.bento.doc.slides[0].elements.find((e) => e.id === id), id)
  const node = (id) => `.ed-stage-scale [data-el-id="${id}"]`
  const select = async (id) => {
    await p.keyboard.press('Escape'); await p.waitForTimeout(80)
    const b = await p.locator(node(id)).boundingBox()
    await p.mouse.click(b.x + 12, b.y + b.height / 2); await p.waitForTimeout(250)
  }
  const undo = async () => { await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250) }

  console.log('\nthe renderer\n')
  const r = await p.evaluate(() => {
    const sel = (id) => `.ed-stage-scale [data-el-id="${id}"]`
    const g = document.querySelector(`${sel('rad')} radialGradient`)
    const tx = document.querySelector(`${sel('tx')} .bento-text-inner`)
    const corn = document.querySelector(`${sel('corn')} svg path`)
    const tri = document.querySelector(`${sel('tri')} svg`)
    const flip = document.querySelector(`${sel('flip')} svg`)
    return {
      g: g && [g.getAttribute('cx'), g.getAttribute('cy'), g.getAttribute('r')].join(),
      tx: tx?.style.backgroundImage ?? '',
      corn: corn?.getAttribute('d') ?? '',
      mask: !!tri?.querySelector('mask') && !!tri?.querySelector('[mask]') && tri.querySelector('[mask]').getAttribute('stroke-width') === '16',
      flip: flip?.style.transform ?? '',
    }
  })
  ok(r.g === '0.3,0.4,0.6', `a radial fill is a radialGradient at its centre and radius (${r.g})`)
  ok(r.tx.startsWith('radial-gradient('), `a radial text fill is a CSS radial gradient (${r.tx.slice(0, 40)}…)`)
  ok((r.corn.match(/A/g) ?? []).length === 4, 'per-corner radii draw a path with one arc per corner')
  ok(r.mask, 'an outside stroke on a triangle is a doubled stroke, masked off the fill')
  ok(r.flip.includes('scale(-1, 1)'), `a flipped element draws its content mirrored (${r.flip})`)

  console.log('\nfill kind (in the popover: one Solid | Linear | Radial) and the stop bar\n')
  await select('rad')
  ok(await p.locator('.ed-props .ed-seg[aria-label="Fill style"]').count() === 0, 'the fill row has no second Solid | Linear | Radial — the popover holds it')
  const kindVia = async (k) => {
    await p.click('.ed-props .ed-section[data-key="Fill"] + .ed-section-body .ed-gradchip'); await p.waitForTimeout(200)
    await p.click(`.ed-cpop .ed-cpop-kinds [data-kind="${k}"]`); await p.waitForTimeout(150)
    await p.keyboard.press('Enter'); await p.waitForTimeout(250)
  }
  await kindVia('linear')
  let e = await el('rad')
  ok(e.fillGradient && !e.fillGradient.kind && e.fillGradient.stops.length === 2, 'Linear: the same stops, no kind')
  await kindVia('radial')
  e = await el('rad')
  ok(e.fillGradient?.kind === 'radial', 'Radial: kind radial')
  const bar = await p.locator('.ed-props .ed-gradbar').boundingBox()
  await p.mouse.click(bar.x + bar.width / 2, bar.y + 2); await p.waitForTimeout(250)
  e = await el('rad')
  ok(e.fillGradient.stops.length === 3 && Math.abs(e.fillGradient.stops[1].at - 0.5) < 0.05, `a click on the bar adds a stop there (${e.fillGradient.stops.map((s) => s.at).join(' ')})`)
  ok(/^(#|rgb)/.test(e.fillGradient.stops[1].color) && e.fillGradient.stops[1].color !== '#ff0000', `…in the colour already there (${e.fillGradient.stops[1].color})`)
  await p.locator('.ed-props .ed-gradbar-stop').nth(1).focus()
  await p.keyboard.press('Backspace'); await p.waitForTimeout(250)
  e = await el('rad')
  ok(e.fillGradient.stops.length === 2, 'Backspace on a stop removes it')
  ok(!!(await el('rad')), 'Backspace on a stop does not delete the element')
  await undo()
  ok((await el('rad')).fillGradient.stops.length === 3, 'one undo brings the stop back')
  await undo()
  ok((await el('rad')).fillGradient.stops.length === 2, 'one more undo takes the added one away')

  console.log('\nthe popover\n')
  await p.click('.ed-props .ed-gradchip'); await p.waitForTimeout(250)
  ok(await p.locator('.ed-cpop .ed-cpop-kinds button').count() === 4, 'the popover offers Solid | Linear | Radial | Tokens')
  ok(await p.locator('.ed-cpop .ed-gradbar').count() === 1, 'a gradient shows its stop bar in the popover')
  await p.click('.ed-cpop .ed-cpop-kinds [data-kind="linear"]'); await p.waitForTimeout(250)
  ok(!(await el('rad')).fillGradient.kind, 'Linear previews at once')
  await p.keyboard.press('Escape'); await p.waitForTimeout(300)
  ok(!(await el('rad')).fillGradient.kind && await p.locator('.ed-cpop').count() === 0, 'Esc closes the popover and keeps Linear')
  await undo()
  ok((await el('rad')).fillGradient.kind === 'radial', 'one undo puts the radial back')

  console.log('\nthe canvas handle\n')
  await select('rad')
  ok(await p.locator('.ed-grad-layer').count() === 0, 'selecting a gradient-filled shape alone shows no handle')
  await p.locator('.ed-props .ed-gradchip').focus(); await p.waitForTimeout(150)
  const knobs = p.locator('.ed-grad-layer .ed-grad-knob:not(.ed-grad-stop)')
  ok(await knobs.count() === 2, 'editing it (its chip focused) shows a centre and a radius knob')
  ok(await p.locator('.ed-grad-layer .ed-grad-stop').count() === 2, '…and a dot for each stop')
  const k = await knobs.first().boundingBox()
  const before = (await el('rad')).fillGradient
  await p.mouse.move(k.x + k.width / 2, k.y + k.height / 2)
  await p.mouse.down(); await p.mouse.move(k.x + 40, k.y + 20, { steps: 5 }); await p.mouse.up(); await p.waitForTimeout(250)
  const moved = (await el('rad')).fillGradient
  ok(moved.cx > before.cx && moved.cy > before.cy, `dragging the centre knob moves the centre (${before.cx},${before.cy} → ${moved.cx},${moved.cy})`)
  await undo()
  ok((await el('rad')).fillGradient.cx === before.cx, 'one undo puts the centre back')
  // a stop dot slides its stop along the radius
  const dot = await p.locator('.ed-grad-layer .ed-grad-stop').nth(1).boundingBox()
  const at0 = (await el('rad')).fillGradient.stops[1].at
  await p.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2)
  // toward the centre knob: along the rail, so the projection shrinks
  const ctr = await p.locator('.ed-grad-layer .ed-grad-knob:not(.ed-grad-stop)').first().boundingBox()
  const mx = (dot.x + ctr.x) / 2 + dot.width / 2, my = (dot.y + ctr.y) / 2 + dot.height / 2
  await p.mouse.down(); await p.mouse.move(mx, my, { steps: 5 }); await p.mouse.up(); await p.waitForTimeout(250)
  const at1 = (await el('rad')).fillGradient.stops[1].at
  ok(at1 < at0, `dragging a stop dot toward the centre moves the stop in (${at0} → ${at1})`)
  await undo()
  ok((await el('rad')).fillGradient.stops[1].at === at0, 'one undo puts the stop back')
  ok(await p.locator('.ed-grad-layer').count() === 1, 'the handle stays up through the edits')
  await p.locator('.ed-props .ed-num').first().focus(); await p.waitForTimeout(150)
  ok(await p.locator('.ed-grad-layer').count() === 0, 'focus on another field puts the handle away')

  console.log('\nstroke, corners, flip\n')
  await select('tri')
  await p.locator('.ed-props .ed-seg[aria-label="Stroke position"] button[aria-label="Center"]').click(); await p.waitForTimeout(250)
  ok((await el('tri')).strokeAlign === 'center', 'Stroke position writes strokeAlign')
  await p.locator('.ed-props .ed-seg[aria-label="Line style"] button[aria-label="Custom dashes"]').click(); await p.waitForTimeout(250)
  e = await el('tri')
  ok(Array.isArray(e.strokeDashes) && e.strokeDashes.length === 2 && e.strokeStyle === 'dashed', `Custom dashes writes a pair, with dashed underneath for an older shell (${JSON.stringify(e.strokeDashes)})`)
  await select('corn')
  ok(await p.locator('.ed-props .ed-corners .ed-mini').count() === 4, 'split corners show four fields')
  await p.click('.ed-props .ed-corners-btn'); await p.waitForTimeout(250)
  e = await el('corn')
  ok(!e.radii && e.radius === 40, 'the corners button joins them again (radius keeps the largest)')
  await p.click('.ed-props .ed-corners-btn'); await p.waitForTimeout(250)
  ok(JSON.stringify((await el('corn')).radii) === '[40,40,40,40]', 'and splits them from the one radius')
  await p.click('.ed-props .ed-tool[aria-label="Flip vertical"]'); await p.waitForTimeout(250)
  ok((await el('corn')).flipY === true, 'Flip vertical writes flipY')

  // several: one picture mirrored across the selection's box (corn 100..300, flip 500..700 → box 100..700)
  await select('corn')
  await p.keyboard.down('Shift')
  { const b = await p.locator(node('flip')).boundingBox(); await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2) }
  await p.keyboard.up('Shift'); await p.waitForTimeout(250)
  await p.click('.ed-props .ed-tool[aria-label="Flip horizontal"]'); await p.waitForTimeout(250)
  const [c2, f2] = [await el('corn'), await el('flip')]
  ok(c2.x === 500 && f2.x === 100, `Flip horizontal on two elements swaps their places across the selection's box (corn ${c2.x}, flip ${f2.x})`)
  ok(c2.flipX === true && !f2.flipX, 'and each one\'s own content flips (the already-flipped arrow unflips)')
  await undo()
  ok((await el('corn')).x === 100 && (await el('flip')).x === 500 && (await el('flip')).flipX === true, 'one undo puts both back')

  console.log('\nhover previews\n')
  await select('corn')
  await p.evaluate(() => { const b = [...document.querySelectorAll('.ed-props .ed-sec-act')].find((x) => x.title === 'Add shadow'); b?.click() })
  await p.waitForTimeout(300)
  const filter0 = await p.evaluate((s) => document.querySelector(s).style.filter, node('corn'))
  const shadow0 = JSON.stringify((await el('corn')).shadow)
  await p.locator('.ed-props .ed-shadow-tile').nth(2).hover(); await p.waitForTimeout(150)
  const filter1 = await p.evaluate((s) => document.querySelector(s).style.filter, node('corn'))
  ok(filter1 !== filter0 && filter1.includes('drop-shadow'), 'pointing at a shadow preset shows it on the element')
  ok(JSON.stringify((await el('corn')).shadow) === shadow0, '…and writes nothing')
  await p.mouse.move(5, 5); await p.waitForTimeout(150)
  ok(await p.evaluate((s) => document.querySelector(s).style.filter, node('corn')) === filter0, 'leaving restores it')
  await p.locator('.ed-props .ed-tabs [role=tab]').nth(1).click(); await p.waitForTimeout(200)
  await p.locator('.ed-props .ed-seg button[aria-label="Fly in"]').hover(); await p.waitForTimeout(100)
  ok(await p.evaluate((s) => document.querySelector(s).getAnimations().length > 0, node('corn')), 'pointing at an entrance plays it on the element')
  ok(!(await el('corn')).fx, '…and writes nothing')
  await p.locator('.ed-props .ed-seg button[aria-label="Fly in"]').click(); await p.waitForTimeout(250)
  ok((await el('corn')).fx?.enter === 'slide-up', 'a click on an entrance pill chooses it')

  // 7. stroke position, read from the rasterised svg of each element
  const SW = 20, W = 160
  const kinds = { rect: {}, ellipse: {}, triangle: {}, path: { d: 'M0 0 L100 0 L100 100 L0 100 Z', pathBox: [0, 0, 100, 100] } }
  const aligned = []
  let n = 0
  for (const [kind, extra] of Object.entries(kinds)) for (const align of ['inside', 'center', 'outside']) {
    aligned.push(shape(`al-${kind}-${align}`, 60 + (n % 6) * 250, 60 + Math.floor(n / 6) * 260, W, W, { shape: kind, fill: '#ff0000', stroke: '#000000', strokeWidth: SW, strokeAlign: align, ...extra }))
    n++
  }
  for (const kind of ['rect', 'ellipse']) aligned.push(shape(`tl-${kind}`, 60 + (n++ % 6) * 250, 600, W, W, { shape: kind, fill: '#ff0000', stroke: 'rgba(0,0,0,0.5)', strokeWidth: SW, strokeAlign: 'outside' }))
  await p.evaluate((els) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', notes: '', transition: 'none', elements: els }]
    window.bento.loadDoc(JSON.stringify(d))
  }, aligned)
  await p.waitForTimeout(500)
  // the element's own svg, drawn on white with a margin, sampled at (x, y) in
  // its box's units — measured off the renderer, not the model
  // (a path's viewBox is its pathBox, so the margin is scaled into it and the
  // image drawn at the element's own size, where non-scaling strokes are true)
  const px = (id, pts) => p.evaluate(async ([id, pts, w, h]) => {
    const svg = document.querySelector(`.ed-stage-scale [data-el-id="${id}"] svg`).cloneNode(true)
    const [vx, vy, vw, vh] = svg.getAttribute('viewBox').split(' ').map(Number)
    const m = 40, sx = vw / w, sy = vh / h
    svg.setAttribute('viewBox', `${vx - m * sx} ${vy - m * sy} ${vw + 2 * m * sx} ${vh + 2 * m * sy}`)
    svg.setAttribute('width', String(w + 2 * m)); svg.setAttribute('height', String(h + 2 * m))
    svg.removeAttribute('style')
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const img = new Image()
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg))
    await img.decode()
    const c = document.createElement('canvas'); c.width = w + 2 * m; c.height = h + 2 * m
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0)
    return pts.map(([x, y]) => [...g.getImageData(Math.round(x + m), Math.round(y + m), 1, 1).data.slice(0, 3)])
  }, [id, pts, W, W])
  const cls = ([r, g, b]) => r < 70 && g < 70 && b < 70 ? 'stroke' : r > 190 && g < 70 && b < 70 ? 'fill' : r > 190 && g > 190 && b > 190 ? 'none' : `rgb(${r},${g},${b})`
  // probes across one edge: 15px outside, 5px inside, 15px inside, the centre
  const across = (kind) => kind === 'triangle'
    ? [[W / 2, W + 15], [W / 2, W - 5], [W / 2, W - 15], [W / 2, W * 0.6]]
    : [[-15, W / 2], [5, W / 2], [15, W / 2], [W / 2, W / 2]]
  const want = { inside: ['none', 'stroke', 'stroke', 'fill'], center: ['none', 'stroke', 'fill', 'fill'], outside: ['stroke', 'fill', 'fill', 'fill'] }
  for (const kind of Object.keys(kinds)) for (const align of ['inside', 'center', 'outside']) {
    const got = (await px(`al-${kind}-${align}`, across(kind))).map(cls)
    ok(JSON.stringify(got) === JSON.stringify(want[align]), `${kind} ${align} stroke: outside band · just inside · deeper · centre = ${got.join(' · ')}`)
  }
  for (const kind of ['rect', 'ellipse']) {
    const [r, g, b] = (await px(`tl-${kind}`, [[-5, W / 2]]))[0]
    ok(Math.abs(r - g) < 12 && Math.abs(g - b) < 12, `a translucent outside stroke on a ${kind} shows no fill beyond the box (rgb ${r},${g},${b})`)
  }

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
