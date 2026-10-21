// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// When the host refuses a deck's recovery copy, the editor says so — once.
//
//   npm run build:single --prefix slides && node scripts/test-slides-recovery-off-browser.mjs
//
// WHAT THIS PROVES (maintainer-approved wording, 2026-10-15). Under a host with
// a per-document store (bento/home), crash recovery lives in the host; when it
// refuses a deck's copy (too large) there is no backstop any more, and the
// kernel's onRecoveryOff fires. Then, in the packaged editor:
//   1. the save status shows "Crash recovery is off for this deck — it’s too
//      large to keep a backup copy. Save often." and holds it long enough to
//      read;
//   2. it says so ONCE per deck: the next refused autosave stays quiet;
//   3. the unsaved dot's tooltip stops claiming the work is "kept in this
//      browser";
//   4. a host that keeps the copy gets no such message (the control);
//   5. never for an encrypted deck (checked at source: an encrypted deck is
//      never snapshotted, and the notice refuses to speak for one).
// The page plays the host: it announces `store` and answers the editor's
// postMessage requests, refusing or keeping `recovery` per run.
import { readFileSync } from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const NOTICE = 'Crash recovery is off for this deck — it’s too large to keep a backup copy. Save often.'
const shell = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href

async function run(refuse) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await ctx.route(/^https?:/, (r) => r.abort())
    await ctx.addInitScript((refuseRecovery) => {
      window.__bentoHost = { ops: ['store'] }
      window.__sets = 0
      window.__notices = 0
      const CH = '__bento_tray__'
      window.addEventListener('message', (ev) => {
        const d = ev.data
        if (!d || d[CH] !== true || d.dir !== 'req') return
        let result = { ok: true }
        if (d.op === 'store.set' && d.payload?.name === 'recovery') { window.__sets++; result = refuseRecovery ? { ok: false, reason: 'too-large' } : { ok: true } }
        if (d.op === 'store.get') result = { ok: true, bytes: null }
        if (d.op === 'store.list') result = { ok: true, names: [] }
        window.postMessage({ [CH]: true, dir: 'res', id: d.id, result }, '*')
      })
      // count every time the save status is set to the notice
      new MutationObserver(() => {
        const tag = document.querySelector('.ed-autosaved')
        if (tag && tag.textContent.startsWith('Crash recovery is off') && tag.dataset.counted !== tag.textContent + tag.className) {
          if (tag.classList.contains('show')) { window.__notices++; tag.dataset.counted = tag.textContent + tag.className }
        }
      }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] })
    }, refuse)
    const p = await ctx.newPage()
    const errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(shell)
    await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-title'))
    const edit = async (v) => {
      await p.locator('.ed-title').fill(v)
      await p.locator('.ed-title').press('Tab')
      await p.waitForTimeout(3200) // the 2.5s autosave debounce, then the host's answer
    }
    await edit('First edit')
    const first = await p.evaluate(() => {
      const tag = document.querySelector('.ed-autosaved')
      return { text: tag?.textContent ?? '', shown: !!tag?.classList.contains('show'), sets: window.__sets, notices: window.__notices, dotTitle: document.querySelector('.ed-dirty')?.title ?? '' }
    })
    await p.waitForTimeout(2500) // still up after the normal 1.4s a "Saved" lasts
    const held = await p.evaluate(() => !!document.querySelector('.ed-autosaved')?.classList.contains('show'))
    await edit('Second edit')
    const second = await p.evaluate(() => ({ sets: window.__sets, notices: window.__notices }))
    return { first, held, second, errors }
  } finally { await browser.close() }
}

console.log('\na host that refuses the recovery copy\n')
{
  const r = await run(true)
  ok(r.first.sets >= 1, `the editor asked the host to keep a recovery copy (${r.first.sets})`)
  ok(r.first.shown && r.first.text === NOTICE, `the save status says recovery is off ("${r.first.text}")`)
  ok(r.held, 'and holds it long enough to read')
  ok(!/kept in this browser/.test(r.first.dotTitle), `the unsaved dot no longer claims a backup ("${r.first.dotTitle}")`)
  // once per deck is the kernel's promise (after a refusal it stops asking the host); the editor keeps its own guard too
  ok(r.second.notices === 1, `said once: a later autosave stays quiet (${r.second.notices} notice)`)
  ok(r.errors.length === 0, `no page errors${r.errors.length ? ': ' + r.errors.join('; ') : ''}`)
}

console.log('\na host that keeps it (the control)\n')
{
  const r = await run(false)
  ok(r.first.sets >= 1 && r.second.notices === 0 && r.first.text !== NOTICE, `no recovery-off message (${r.second.notices})`)
}

console.log('\nnever for a sealed deck (a password or the identity seal)\n')
{
  const src = readFileSync(new URL('../slides/src/editor/editor.ts', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('private noticeRecoveryOff('), src.indexOf('private noticeRecoveryOff(') + 700)
  ok(/onRecoveryOff\(\(docId\) => this\.noticeRecoveryOff\(docId\)\)/.test(src), 'the editor listens to the kernel\'s onRecoveryOff')
  ok(/if \(docId !== this\.store\.doc\.docId \|\| isBodySealed\(\) \|\| this\.recoveryOffSaid\.has\(docId\)\) return/.test(fn),
    'the notice refuses a sealed deck, another deck, and a second telling')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
