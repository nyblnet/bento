// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The Share popover stays on screen at phone width.
//
//   npm run build:single --prefix slides && node scripts/test-slides-share-pop-phone-browser.mjs
//
// At phone width the topbar folds Share into ⋯, and the Share popover opens from
// there sized to its content. A collaborator with a long name used to make it
// wider than the screen (757px at 390px, 373px off the left edge), so the People
// list and every share action could not be reached. In the packaged editor, at
// 390 and 320px, with one peer whose name is 74 characters, this measures with
// getBoundingClientRect that the popover is wholly inside the viewport, that the
// row's name is cut by its own ellipsis rather than widening the popover, and
// that the share actions below the list are reachable (the point under each one
// hits it). The network is closed: http(s) aborted, every WebSocket closed.
// RIG_MUTANT=inline rebuilds with the folded popover floating beside ⋯ again
// (the width bound alone keeps it on screen: only the "section of ⋯" rows go
// red); RIG_MUTANT=both also drops the width bound (main before this change:
// every on-screen row goes red too). In the shipped layout the popover is a
// section of ⋯ and already as wide as the list, so the width bound is the
// second line, for whenever it floats. The rig edits
// slides/src/styles.css, runs build:single, and restores the file.
import { readFileSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const WIDTH = '.ed-topbar.ed-bar-fold .ed-menu .ed-menu.ed-share-pop { max-width: calc(100vw - 16px); }'
const INLINE = '  .ed-topbar.ed-bar-fold .ed-menu .ed-dropdown.open > .ed-menu { position: static; }'
const MUTANTS = {
  // the folded widget's popover floating again (fixed, beside ⋯): the width
  // bound still keeps it on screen, only the "section of ⋯" row goes red
  inline: [INLINE],
  // both gone (main before this change): off screen and floating
  both: [INLINE, WIDTH],
}
const mutant = process.env.RIG_MUTANT
if (mutant) {
  const needles = MUTANTS[mutant]
  if (!needles) { console.log(`  FAIL  unknown mutant ${mutant}`); process.exit(1) }
  const src = new URL('../slides/src/styles.css', import.meta.url)
  const orig = readFileSync(src, 'utf8')
  let text = orig
  for (const needle of needles) {
    if (text.split(needle).length !== 2) { console.log(`  FAIL  mutant ${mutant}: needle not found exactly once`); process.exit(1) }
    text = text.replace(needle, '')
  }
  writeFileSync(src, text)
  try {
    execFileSync('npm', ['run', 'build:single', '--prefix', 'slides'], { cwd: new URL('..', import.meta.url), stdio: 'inherit', env: { ...process.env, ZOPFLI: '0' } })
  } finally { writeFileSync(src, orig) }
  console.log(`  (mutant build: ${mutant})`)
}

const shell = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url)
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sharepop-rig-')))
const file = join(dir, `sharepop-${Date.now()}.bento.html`)
writeFileSync(file, readFileSync(shell))
const LONG = 'Maximiliana Alexandrovna Featherstonehaugh-Wolfeschlegelsteinhausenberger'

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
let sockets = 0
try {
  for (const width of [390, 320]) {
    const ctx = await browser.newContext({ viewport: { width, height: 760 }, locale: 'en-US', hasTouch: true })
    await ctx.route(/^https?:/, (r) => r.abort())
    await ctx.routeWebSocket(/.*/, (ws) => { sockets++; ws.close() })
    const p = await ctx.newPage()
    const errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto('file://' + file)
    await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-title'))
    const info = await p.evaluate(() => ({ room: window.bento.doc.collab?.room, docId: window.bento.doc.docId }))

    // open Share from wherever the bar put it (inside ⋯ at phone width)
    const openShare = () => p.evaluate(() => {
      const btn = document.querySelector('.ed-btn-share')
      const own = btn.closest('.ed-dropdown')
      for (let a = own?.parentElement; a; a = a.parentElement) {
        if (a.classList?.contains('ed-dropdown') && !a.classList.contains('open')) a.firstElementChild.click()
      }
      if (!own.classList.contains('open')) btn.click()
      return !!own.parentElement.closest('.ed-dropdown')
    })
    const folded = await openShare()
    ok(folded, `${width}px: Share is folded into ⋯ (the case under test)`)
    await p.evaluate(() => [...document.querySelectorAll('.ed-share-pop button')].find((b) => /Go live/.test(b.getAttribute('aria-label') || b.textContent))?.click())
    await p.waitForTimeout(500)

    // one collaborator with a long name, on the same-machine channel
    await p.evaluate(({ docId, LONG }) => {
      const ch = new BroadcastChannel(`bento-sync-${docId}`)
      ch.onmessage = (e) => {
        if (e.data?.pv === undefined || window.__sent) return
        window.__sent = true
        ch.postMessage({ pv: e.data.pv, t: 'p', a: 'rig-long', p: { name: LONG, color: '#8FA3BF', slide: window.bento.doc.slides[0].id, sel: [], role: 'editor' } })
      }
    }, { ...info, LONG })
    await p.waitForFunction(() => document.querySelectorAll('.ed-share-peers .ed-share-peer').length >= 1, null, { timeout: 10000 })
    // the "joined" toast is transient and floats over the bottom of the screen;
    // wait it out so the tap test measures the popover, not the toast
    await p.waitForFunction(() => !document.querySelector('.ed-toast.show'), null, { timeout: 15000 })
    await p.waitForTimeout(400)

    const m = await p.evaluate(() => {
      const pop = [...document.querySelectorAll('.ed-share-pop')].find((x) => x.closest('.ed-dropdown.open'))
      const r = pop.getBoundingClientRect()
      const who = pop.querySelector('.ed-share-peers .ed-share-peer .who')
      const actions = [...pop.querySelectorAll('.ed-share-btn')].filter((b) => b.offsetParent)
      const hits = actions.map((b) => {
        b.scrollIntoView({ block: 'nearest' })
        const br = b.getBoundingClientRect()
        const x = br.left + Math.min(br.width / 2, 40), y = br.top + br.height / 2
        const inView = br.left >= 0 && br.right <= innerWidth && br.width > 0
        const top = document.elementFromPoint(x, y)
        return { label: (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 30), inView, hit: !!top && (top === b || b.contains(top)) }
      })
      return {
        vw: innerWidth, left: r.left, right: r.right, width: r.width,
        inMore: (() => { const more = pop.parentElement.closest('.ed-menu'); if (!more) return null; const mr = more.getBoundingClientRect(); return getComputedStyle(pop).position === 'static' && r.left >= mr.left - 0.5 && r.right <= mr.right + 0.5 })(),
        nameCut: who ? who.scrollWidth > who.clientWidth : null,
        whoRight: who ? who.getBoundingClientRect().right : null,
        hits,
      }
    })
    ok(m.left >= 0 && m.right <= m.vw, `${width}px: the Share popover is inside the viewport (${Math.round(m.left)}..${Math.round(m.right)} of ${m.vw})`)
    ok(m.width <= m.vw - 16 + 0.5, `${width}px: and at most the viewport less 16px wide (${Math.round(m.width)}px)`)
    ok(m.inMore === true, `${width}px: the popover opens as a section of the ⋯ list, not floating beside it`)
    ok(m.nameCut === true && m.whoRight <= m.vw, `${width}px: the long name is cut by its own ellipsis, on screen`)
    ok(m.hits.length > 0 && m.hits.every((h) => h.inView && h.hit), `${width}px: every share action is on screen and takes the tap (${m.hits.filter((h) => !h.inView || !h.hit).map((h) => h.label).join(', ') || 'all'})`)
    ok(errors.length === 0, `${width}px: no page errors${errors.length ? ': ' + errors[0] : ''}`)
    if (process.env.RIG_SHOT) await p.screenshot({ path: process.env.RIG_SHOT.replace('.png', `-${width}.png`) })
    await ctx.close()
  }
  console.log(`  (WebSockets closed by the rig: ${sockets})`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks`)
process.exit(failures ? 1 : 0)
