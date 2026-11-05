// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The laser pointer fades out when you let go, in the packaged editor's show, with real input.
//
//   npm run build:single --prefix slides && node scripts/test-slides-laser-release-browser.mjs
//
// WHAT THIS PROVES:
//   1. while drawing, the dot and a trail are on screen;
//   2. letting go does NOT clear the trail at once (it used to: the laser
//      vanished mid-sweep) — right after release the trail is still visible,
//      the dot is fading out;
//   3. the trail runs out on its own within its lifetime (~0.8s);
//   4. a new stroke starts clean: the old stroke never joins it;
//   5. leaving the slide still clears at once.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))
  await p.keyboard.press('F5')
  await p.waitForFunction(() => document.querySelector('.bento-present-overlay .reveal .slides > section'), null, { timeout: 10000 })
  await p.waitForTimeout(600)
  await p.keyboard.press('l'); await p.waitForTimeout(200)

  const lit = () => p.evaluate(() => [...document.querySelectorAll('.bento-laser-trail-segment.core')].filter((s) => +(s.getAttribute('opacity') ?? 0) > 0.01).length)
  const dot = () => p.evaluate(() => { const d = document.querySelector('.bento-laser-dot:not(.bento-remote)'); return { visible: d.classList.contains('visible'), opacity: +getComputedStyle(d).opacity } })
  const r = await p.evaluate(() => { const b = document.querySelector('.bento-present-overlay section.present .bento-slide').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })
  const sweep = async (y) => {
    await p.mouse.move(r.x + r.w * 0.2, y); await p.mouse.down()
    await p.mouse.move(r.x + r.w * 0.7, y + 40, { steps: 25 })
  }

  // 1. drawing
  await sweep(r.y + r.h * 0.4)
  ok(await lit() > 3 && (await dot()).visible, `while drawing, the dot and the trail show (${await lit()} lit segments)`)

  // 2. release
  await p.mouse.up()
  await p.waitForTimeout(60)
  const after = await lit()
  ok(after > 0, `just after letting go, the trail is still there, fading (${after} lit segments)`)
  const d = await dot()
  ok(!d.visible && d.opacity > 0, `and the dot is fading, not gone (opacity ${d.opacity.toFixed(2)})`)

  // 3. runs out
  await p.waitForTimeout(1100)
  ok(await lit() === 0, `within its lifetime the trail is gone (${await lit()} lit)`)

  // 4. a new stroke right after a release starts clean
  await sweep(r.y + r.h * 0.4)
  await p.mouse.up()
  await p.waitForTimeout(30)
  await p.mouse.move(r.x + r.w * 0.5, r.y + r.h * 0.8); await p.mouse.down()
  const firstPoint = await p.evaluate(() => {
    const segs = [...document.querySelectorAll('.bento-laser-trail-segment.core')].filter((s) => +(s.getAttribute('opacity') ?? 0) > 0.01)
    return segs.length
  })
  await p.mouse.move(r.x + r.w * 0.55, r.y + r.h * 0.8, { steps: 4 })
  const joined = await p.evaluate((topY) => [...document.querySelectorAll('.bento-laser-trail-segment.core')]
    .filter((s) => +(s.getAttribute('opacity') ?? 0) > 0.01)
    .some((s) => { const b = s.getBBox(); return b.y < topY && b.y + b.height > topY + 60 }), r.y + r.h * 0.5)
  ok(firstPoint === 0 && !joined, `a new stroke does not join the one still fading (${firstPoint} segments at press, joined: ${joined})`)
  await p.mouse.up()

  // 5. leaving the slide clears at once
  await sweep(r.y + r.h * 0.3)
  await p.mouse.move(r.x + r.w + 60, r.y - 30, { steps: 3 })
  await p.waitForTimeout(40)
  ok(await lit() === 0, `leaving the slide still clears at once (${await lit()} lit)`)
  await p.mouse.up()

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
