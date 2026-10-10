// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// ⌘C with several thumbnails selected copies those slides, parents only.
//
//   npm run build:single --prefix slides && node scripts/test-slides-copy-slides-browser.mjs
//
// WHAT THIS PROVES, in the packaged document with trusted mouse and keyboard
// input (#615 and its follow-up):
//   1. two selected thumbnails → ⌘C puts BOTH slides on the clipboard, in deck
//      order — it used to copy only the current slide;
//   2. a parent's interactive states are not on it (paste is not unit-aware
//      yet, so a state would arrive orphaned), including a Shift-click range
//      that runs across a parent and its states;
//   3. the toast is plural for several slides ("paste them") and singular
//      for one ("paste it").
// The clipboard is observed by wrapping navigator.clipboard.writeText before
// boot — the payload the editor writes, without clipboard permissions.
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  await ctx.addInitScript(() => {
    window.__clips = []
    const clip = navigator.clipboard ?? {}
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: Object.assign(Object.create(Object.getPrototypeOf(clip) ?? Object.prototype), clip, {
        writeText: (t) => { window.__clips.push(String(t)); return Promise.resolve() },
        readText: () => Promise.resolve(window.__clips.at(-1) ?? ''),
      }),
    })
  })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelectorAll('.ed-sidebar .ed-thumb').length > 3)
  await p.waitForTimeout(500)

  // a parent that has a state, its first state, and a plain slide before it
  const plan = await p.evaluate(() => {
    const s = window.bento.doc.slides
    const st = s.findIndex((x) => x.stateOf)
    const parent = s.findIndex((x) => x.id === s[st]?.stateOf)
    const plain = s.findIndex((x, i) => i < parent && !x.stateOf && !s.some((y) => y.stateOf === x.id))
    return { parent, state: st, plain, ids: s.map((x) => x.id), stateOf: s.map((x) => x.stateOf ?? null) }
  })
  ok(plan.parent >= 0 && plan.state > plan.parent && plan.plain >= 0, `the starter deck has a plain slide (${plan.plain}), a parent (${plan.parent}) and its state (${plan.state})`)

  const thumb = async (i, mod = false) => {
    const t = p.locator(`.ed-sidebar .ed-thumb[data-index="${i}"]`)
    await t.scrollIntoViewIfNeeded()
    const b = await t.boundingBox()
    if (mod) await p.keyboard.down(MOD)
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
    if (mod) await p.keyboard.up(MOD)
    await p.waitForTimeout(200)
  }
  const copy = async () => {
    await p.evaluate(() => { window.__clips.length = 0; document.querySelectorAll('.ed-toast').forEach((t) => t.remove()) })
    await p.keyboard.press(`${MOD}+c`)
    await p.waitForTimeout(250)
    return p.evaluate(() => {
      const raw = window.__clips.at(-1)
      let payload = null
      try { payload = JSON.parse(raw) } catch {}
      const toasts = [...document.querySelectorAll('.ed-toast')].map((t) => t.textContent.trim())
      return { payload, toast: toasts.at(-1) ?? '' }
    })
  }
  const slideIds = (r) => (r.payload?.slides ?? []).map((s) => s.id)
  const anyState = (r) => (r.payload?.slides ?? []).some((s) => s.stateOf)

  console.log('\ntwo thumbnails, one a parent with states\n')
  {
    await thumb(plan.plain)
    await thumb(plan.parent, true)
    const r = await copy()
    ok(r.payload?.__bento === 'clip' && r.payload?.kind === 'slides', 'the clipboard holds a Bento slides payload')
    ok(JSON.stringify(slideIds(r)) === JSON.stringify([plan.ids[plan.plain], plan.ids[plan.parent]]),
      `both slides, in deck order (${slideIds(r).join(', ') || 'none'})`)
    ok(!anyState(r) && !slideIds(r).includes(plan.ids[plan.state]), 'no state slide rides along with its parent')
    ok(r.toast === 'Slides copied — ⌘V in any deck to paste them', `the toast is plural ("${r.toast}")`)
  }

  console.log('\na Shift-click range across a parent and its states\n')
  {
    // a modified click on a STATE's own thumbnail is a plain click by design
    // (states are not selectable), so the gesture that sweeps states into a
    // selection is a range that runs across them
    const after = plan.stateOf.findIndex((s, i) => i > plan.state && !s)
    await thumb(plan.plain)
    const b = await p.locator(`.ed-sidebar .ed-thumb[data-index="${after}"]`).boundingBox()
    await p.keyboard.down('Shift')
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
    await p.keyboard.up('Shift')
    await p.waitForTimeout(200)
    const r = await copy()
    const want = plan.ids.filter((_, i) => i >= plan.plain && i <= after && !plan.stateOf[i])
    ok(JSON.stringify(slideIds(r)) === JSON.stringify(want) && !anyState(r),
      `every parent in the range, in order, and none of the states it crosses (${slideIds(r).length} of ${after - plan.plain + 1} thumbnails)`)
  }

  console.log('\none slide\n')
  {
    await thumb(plan.plain)
    const r = await copy()
    ok(JSON.stringify(slideIds(r)) === JSON.stringify([plan.ids[plan.plain]]), `just the current slide (${slideIds(r).join(', ') || 'none'})`)
    ok(r.toast === 'Slide copied — ⌘V in any deck to paste it', `the toast is singular ("${r.toast}")`)
  }

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
