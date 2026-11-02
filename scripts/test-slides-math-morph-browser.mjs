// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A formula's symbols, mid-morph, sit where their box says they should.
//
//   npm run build:single --prefix slides && node scripts/test-slides-math-morph-browser.mjs
//
// morphMathSymbols (slides/src/present.ts) layers a per-symbol travel on top
// of runMorph's box tween. The box scales, and a translate on a child of a
// scaled box is scaled too, so the symbol translate is divided by the box's
// CURRENT scale. The symbols ride the 'spring' ease while the box rides
// power2.inOut: dividing by a scale computed from the spring's progress (the
// box's scale only at the ends and where the two curves cross) threw symbols
// tens of pixels off their line whenever the formula changed size.
//
// WHAT THIS PROVES, in the packaged document, on the manual animation clock:
//   1. the box is mid-morph (its size is strictly between the two frames);
//   2. each travelling symbol sits at  S·dst + (src − dst)·(1 − p)  inside its
//      box, in slide px, where S is the box's MEASURED scale, src/dst the
//      symbol's offsets in its box at rest on each slide, and p = spring(t)
//      with t recovered from the measured box width through power2.inOut's
//      inverse — so the symbols keep the spring and the box keeps its ease;
//   3. a positive control: at the early samples the symbols are measurably
//      away from where a plain box scale would put them (the travel is on
//      screen), and the old spring-scale counter-scale would miss by more
//      than three times the tolerance.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const shell = readFileSync(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'bento-math-morph-'))

// The same element, small then large: the box scales x2.5 across and x3
// down, while the terms trade places across the plus sign.
const A = { x: 100, y: 80, w: 400, h: 100 }
const B = { x: 160, y: 260, w: 1000, h: 300 }
const text = (frame, tex) => ({
  id: 'eq', type: 'text', ...frame, fontSize: 48, align: 'left', valign: 'top', color: '#1E2A3A',
  html: `<p>$${tex}$</p>`,
})
const slide = (id, elements, extra = {}) => ({ id, background: '#ffffff', transition: 'none', notes: '', elements, ...extra })
const doc = {
  format: 'bento/slides', version: 1, docId: 'math-morph-rig', title: 'math morph',
  size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#1E2A3A', accent: '#f7a600', fontFamily: 'system-ui' },
  present: { morphSeconds: 1 },
  slides: [
    slide('s1', [{ id: 'title', type: 'text', x: 100, y: 100, w: 800, h: 120, html: '<p>start</p>' }]),
    slide('s2', [text(A, 'x + 3 = 7')]),
    slide('s3', [text(B, '3 + x = 7')], { transition: 'morph' }),
  ],
}
const open = '<script type="application/bento+json" id="bento-doc">', close = '</' + 'script>'
const at = shell.indexOf(open) + open.length
const file = join(dir, 'deck.bento.html')
writeFileSync(file, shell.slice(0, at) + JSON.stringify(doc).replace(/</g, '\\u003c') + shell.slice(shell.indexOf(close, at)))

// the eases, as kernel/src/anim.ts defines them
const spring = (t) => 1 - (1 - t) ** 2 * (Math.cos(Math.PI * t) + 0.625 * Math.sin(Math.PI * t))
const p2inv = (q) => (q < 0.5 ? Math.cbrt(2 * q) / 2 : 1 - Math.cbrt(2 - 2 * q) / 2)

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  await ctx.addInitScript(() => {
    try { localStorage.setItem('bento-slideshow-started', '1'); localStorage.setItem('bento-reduce-motion', 'off') } catch {}
  })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + file)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-sidebar .ed-thumb'), null, { timeout: 20000 })
  await p.waitForTimeout(800)
  await p.evaluate(() => { document.querySelectorAll('.ed-sidebar .ed-thumb')[0].click(); window.bento.anim.setManual(true) })
  await p.waitForTimeout(200)
  await p.keyboard.press('F5')
  await p.waitForFunction(() => document.querySelector('.bento-present-overlay .reveal .slides > section'), null, { timeout: 10000 })
  await p.waitForTimeout(500)
  const tick = (secs) => p.evaluate((s) => {
    let left = s
    while (left > 1e-9) { const d = Math.min(0.05, left); window.bento.anim.tick(d); left -= d }
  }, secs)
  const next = async () => { await p.keyboard.press('ArrowRight'); await p.waitForTimeout(150) }

  // Geometry of the eq host and its symbols, in screen px. Positions are read
  // from the top-left edge, which a scale about the box's top-left and a
  // translate move exactly as derived above.
  const read = () => p.evaluate(() => {
    const host = [...document.querySelectorAll('.bento-present-overlay [data-flip-id="eq"]')].find((n) => n.closest('section.present'))
    if (!host) return null
    const h = host.getBoundingClientRect()
    const syms = {}
    for (const s of host.querySelectorAll('[data-sym]')) { const r = s.getBoundingClientRect(); syms[s.dataset.sym] = { x: r.left - h.left, y: r.top - h.top } }
    return { w: h.width, h: h.height, syms }
  })

  await next(); await tick(1.5) // s2 at rest: the symbol cache is taken here
  const from = await read()
  ok(!!from && Object.keys(from.syms).length >= 4, `the formula renders as symbols on the from slide (${from && Object.keys(from.syms).join(' ')})`)
  if (!from) throw new Error('no formula host on the from slide')
  const k = from.w / A.w // screen px per slide px
  const src = Object.fromEntries(Object.entries(from.syms).map(([id, v]) => [id, { x: v.x / k, y: v.y / k }]))

  await next() // s3: morph arrival
  const samples = []
  for (const dt of [0.2, 0.12, 0.13, 0.2]) { await tick(dt); samples.push(await read()) }
  await tick(2)
  const rest = await read()
  ok(Math.abs(rest.w / k - B.w) < 1 && Math.abs(rest.h / k - B.h) < 1, `the box lands on the to frame (${(rest.w / k).toFixed(1)}x${(rest.h / k).toFixed(1)})`)
  const dst = Object.fromEntries(Object.entries(rest.syms).map(([id, v]) => [id, { x: v.x / k, y: v.y / k }]))
  const moving = Object.keys(dst).filter((id) => src[id] && Math.hypot(src[id].x - dst[id].x, src[id].y - dst[id].y) > 20)
  ok(moving.length >= 2, `terms trade places: ${moving.length} symbols travel (${moving.join(' ')})`)

  const TOL = 2 // slide px
  for (const [i, s] of samples.entries()) {
    const Sx = s.w / k / B.w
    const Sy = s.h / k / B.h
    const qx = (s.w / k - A.w) / (B.w - A.w)
    const qy = (s.h / k - A.h) / (B.h - A.h)
    ok(qx > 0.02 && qx < 0.98 && Math.abs(qx - qy) < 0.01, `sample ${i + 1}: the box is mid-morph (q=${qx.toFixed(3)} across, ${qy.toFixed(3)} down)`)
    const t = p2inv(qx)
    const ps = spring(t)
    let worst = 0, worstOld = 0, travel = 0
    for (const id of moving) {
      const got = { x: s.syms[id].x / k, y: s.syms[id].y / k }
      const dx = src[id].x - dst[id].x, dy = src[id].y - dst[id].y
      const want = { x: Sx * dst[id].x + dx * (1 - ps), y: Sy * dst[id].y + dy * (1 - ps) }
      worst = Math.max(worst, Math.hypot(got.x - want.x, got.y - want.y))
      // the old counter-scale: translate divided by the spring-progress scale
      const oSx = (A.w + (B.w - A.w) * ps) / B.w, oSy = (A.h + (B.h - A.h) * ps) / B.h
      const old = { x: Sx * dst[id].x + (Sx / oSx) * dx * (1 - ps), y: Sy * dst[id].y + (Sy / oSy) * dy * (1 - ps) }
      worstOld = Math.max(worstOld, Math.hypot(old.x - want.x, old.y - want.y))
      travel = Math.max(travel, Math.hypot(got.x - Sx * dst[id].x, got.y - Sy * dst[id].y))
    }
    ok(worst < TOL, `sample ${i + 1} (t=${t.toFixed(3)}, spring p=${ps.toFixed(3)}): every travelling symbol is within ${TOL}px of box + spring travel (worst ${worst.toFixed(2)}px)`)
    if (i < 2) ok(travel > 10 && worstOld > 3 * TOL, `sample ${i + 1}: positive control — symbols are ${travel.toFixed(1)}px off their scaled rest spot, and the spring-scale counter-scale would miss by ${worstOld.toFixed(1)}px`)
  }
  ok(errors.length === 0, `no page error${errors.length ? ' — ' + errors[0] : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
