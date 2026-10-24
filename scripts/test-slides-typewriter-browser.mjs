// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The code typewriter (fx.typeWriter): types in the show, and nowhere else.
//
//   npm run build:single --prefix slides && node scripts/test-slides-typewriter-browser.mjs
//
// WHAT THIS PROVES, in the packaged document, on the animation engine's manual
// clock so every reading is at a known moment:
//   1. a deck carrying fx.typeWriter and present.typeWriterSeconds opens with
//      both intact (the gate keeps what the schema declares);
//   2. the editor never shows a cursor, and a typewriter code element renders
//      the SAME token ids as the plain one it morphs from — no extra splits,
//      no empty spans — so the morph pairs it token for token;
//   3. on that morph arrival the carried tokens are on screen at once while
//      only the new text types in, character by character, behind one cursor,
//      and the run ends with everything shown and the cursor gone;
//   4. a long snippet finishes within the cap instead of holding the slide;
//   5. M (reduced motion) mid-run shows everything at once, with no cursor,
//      and nothing resumes; leaving the slide mid-run leaves it whole.
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
const dir = mkdtempSync(join(tmpdir(), 'bento-typewriter-'))

const code = (id, content, fx) => ({
  id, type: 'code', x: 100, y: 100, w: 1000, h: 500, fontSize: 20, fontFamily: 'ui-monospace, monospace',
  align: 'left', valign: 'top', lineHeight: 1.4, color: '#1E2A3A', content, ...(fx ? { fx } : {}),
})
const slide = (id, elements, extra = {}) => ({ id, background: '#ffffff', transition: 'none', notes: '', elements, ...extra })
const A = 'let total = price * count'
const B = A + '\nconst label = format(total)'
const LONG = Array.from({ length: 60 }, (_, i) => `const value${i} = compute(${i}, value${i ? i - 1 : 0})`).join('\n')
const doc = {
  format: 'bento/slides', version: 1, docId: 'typewriter-rig', title: 'typewriter',
  size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#1E2A3A', accent: '#f7a600', fontFamily: 'system-ui' },
  present: { typeWriterSeconds: 0.08 },
  slides: [
    slide('s1', [{ id: 'title', type: 'text', x: 100, y: 100, w: 800, h: 120, html: '<p>start</p>' }]),
    slide('s2', [code('cd', A)]),
    slide('s3', [code('cd', B, { typeWriter: true })], { transition: 'morph' }),
    slide('s4', [code('mid', B, { typeWriter: true })]),
    slide('s5', [code('long', LONG, { typeWriter: true })]),
    slide('s6', [{ id: 'end', type: 'text', x: 100, y: 100, w: 800, h: 120, html: '<p>end</p>' }]),
  ],
}
const open = '<script type="application/bento+json" id="bento-doc">', close = '</' + 'script>'
const at = shell.indexOf(open) + open.length
const file = join(dir, 'deck.bento.html')
writeFileSync(file, shell.slice(0, at) + JSON.stringify(doc).replace(/</g, '\\u003c') + shell.slice(shell.indexOf(close, at)))

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

  console.log('the format\n')
  const kept = await p.evaluate(() => ({ fx: window.bento.doc.slides[2].elements[0].fx?.typeWriter, secs: window.bento.doc.present?.typeWriterSeconds }))
  ok(kept.fx === true && kept.secs === 0.08, `fx.typeWriter and present.typeWriterSeconds survive opening the file (got ${kept.fx}, ${kept.secs})`)

  console.log('\nthe editor\n')
  const syms = (slideIdx) => p.evaluate(async (i) => {
    document.querySelectorAll('.ed-sidebar .ed-thumb')[i].click()
    await new Promise((r) => setTimeout(r, 300))
    const host = document.querySelector('.ed-stage-scale .bento-el-code')
    return { ids: [...host.querySelectorAll('[data-sym]')].map((s) => s.dataset.sym), empty: [...host.querySelectorAll('[data-sym]')].filter((s) => !s.textContent).length }
  }, slideIdx)
  const plain = await syms(1)
  const typed = await syms(2)
  const carried = plain.ids.filter((id) => typed.ids.includes(id)).length
  ok(plain.ids.length > 0 && carried === plain.ids.length, `every token of the plain slide keeps its id on the typewriter slide (${carried}/${plain.ids.length})`)
  ok(typed.empty === 0, `no empty token spans (${typed.empty})`)
  const cursors = await p.evaluate(() => document.querySelectorAll('.bento-code-cursor, .ed-root .cursor').length)
  ok(cursors === 0, `no cursor anywhere in the editor — canvas or thumbnails (${cursors})`)

  console.log('\nthe show\n')
  await p.evaluate(() => { document.querySelectorAll('.ed-sidebar .ed-thumb')[0].click(); window.bento.anim.setManual(true) })
  await p.waitForTimeout(200)
  await p.keyboard.press('F5')
  await p.waitForFunction(() => document.querySelector('.bento-present-overlay .reveal .slides > section'), null, { timeout: 10000 })
  await p.waitForTimeout(500)
  const tick = (secs) => p.evaluate((s) => { for (let t = 0; t < s; t += 0.05) window.bento.anim.tick(0.05) }, secs)
  const next = async () => { await p.keyboard.press('ArrowRight'); await p.waitForTimeout(150) }
  const prev = async () => { await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(150) }
  // what the audience sees of one code element: per token, is it fully shown?
  const read = (id, carriedIds = []) => p.evaluate(([id, carriedIds]) => {
    const host = [...document.querySelectorAll(`.bento-present-overlay [data-el-id="${id}"]`)].find((n) => n.closest('section.present'))
      ?? document.querySelector(`.bento-present-overlay [data-el-id="${id}"]`)
    const shown = (s) => {
      const cs = getComputedStyle(s)
      if (Number(cs.opacity) < 0.99) return 0
      const m = /inset\(\S+ ([\d.]+)%/.exec(cs.clipPath)
      return m ? 1 - Number(m[1]) / 100 : 1
    }
    const ink = [...host.querySelectorAll('[data-sym]')].filter((s) => /\S/.test(s.textContent))
    const frac = (list) => { const n = list.reduce((a, s) => a + s.textContent.length, 0); return n ? list.reduce((a, s) => a + shown(s) * s.textContent.length, 0) / n : 1 }
    return {
      all: frac(ink),
      carried: frac(ink.filter((s) => carriedIds.includes(s.dataset.sym))),
      fresh: frac(ink.filter((s) => !carriedIds.includes(s.dataset.sym))),
      partial: ink.some((s) => { const v = shown(s); return v > 0 && v < 1 }),
      cursors: host.querySelectorAll('.bento-code-cursor, .cursor').length,
    }
  }, [id, carriedIds])

  await next(); await tick(1.5) // s2, plain
  await next() // s3: morph arrival, the typewriter version of the same element
  await tick(0.35)
  const m1 = await read('cd', plain.ids)
  await tick(0.6)
  const m2 = await read('cd', plain.ids)
  ok(m1.carried === 1 && m2.carried === 1, `on the morph arrival the carried tokens are shown at once (${m1.carried}, ${m2.carried})`)
  ok(m1.fresh < m2.fresh && m2.fresh < 1, `only the new text types in, and it advances (${m1.fresh.toFixed(2)} → ${m2.fresh.toFixed(2)})`)
  ok(m1.partial || m2.partial || (m2.fresh > m1.fresh && m2.fresh - m1.fresh < 0.6), 'it types a character at a time, not a token at a time')
  ok(m2.cursors === 1, `one cursor while typing (${m2.cursors})`)
  await tick(5)
  const m3 = await read('cd', plain.ids)
  ok(m3.all === 1 && m3.cursors === 0, `the run ends whole, cursor gone (shown ${m3.all.toFixed(2)}, cursors ${m3.cursors})`)

  await next() // s4
  await tick(0.8)
  const r1 = await read('mid')
  await p.keyboard.press('m')
  await p.waitForTimeout(150)
  const r2 = await read('mid')
  await tick(2)
  const r3 = await read('mid')
  ok(r1.all < 1, `s4 is mid-run before M (${r1.all.toFixed(2)})`)
  ok(r2.all === 1 && r2.cursors === 0 && r3.all === 1 && r3.cursors === 0, `M settles at once — all shown, no cursor — and nothing resumes (${r2.all.toFixed(2)}/${r2.cursors}, then ${r3.all.toFixed(2)}/${r3.cursors})`)
  await p.keyboard.press('m') // motion back on: s4 replays its run
  await p.waitForTimeout(150)
  await tick(8)

  await next() // s5: long snippet
  const chars = LONG.length
  await tick(0.5)
  const l0 = await read('long')
  await tick(7.5)
  const l1 = await read('long')
  ok(l0.all < 1 && l1.all === 1 && l1.cursors === 0, `${chars} characters finish inside the cap — done 8 s in (${l0.all.toFixed(2)} → ${l1.all.toFixed(2)}, cursors ${l1.cursors})`)

  await prev() // s4 types again; leave it mid-run
  await tick(0.6)
  const e0 = await read('mid')
  await next()
  await tick(0.2)
  const e1 = await read('mid')
  ok(e0.all < 1 && e1.all === 1 && e1.cursors === 0, `leaving a slide mid-run leaves it whole (${e0.all.toFixed(2)} → ${e1.all.toFixed(2)}, cursors ${e1.cursors})`)
  ok(errors.length === 0, `no page error${errors.length ? ' — ' + errors[0] : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
