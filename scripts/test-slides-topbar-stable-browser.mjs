// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The top bar never moves under the pointer (#546).
//
//   npm run build:single --prefix slides && node scripts/test-slides-topbar-stable-browser.mjs
//
// WHAT THIS PROVES, in the packaged editor with real input. Auto-save flashed
// "Saved" as a FLEX ITEM after the deck title, and the file chip toggled
// display whenever the title matched the file name — both pushed every control
// after them sideways, so while someone undid repeatedly the Undo button moved
// under the pointer and the click landed on Redo. Now:
//   1. through a real ⌘S and a real auto-save write-back, the "Saved" flash
//      appears (visibly, inside the bar) while Undo and Redo stay exactly put;
//   2. renaming the deck to its file's name, and undoing that, leaves Undo and
//      Redo exactly put (the chip keeps its slot and only goes quiet);
//   3. the same on the folded phone bar.
// File writes go to a stub handle (the File System Access picker), so nothing
// touches disk.
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
  for (const [label, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    console.log(`\n${label} (${width}px)\n`)
    const ctx = await browser.newContext({ viewport: { width, height } })
    await ctx.route(/^https?:/, (r) => r.abort())
    await ctx.addInitScript(() => {
      const handle = { name: 'stable-test.bento.html', kind: 'file',
        async queryPermission() { return 'granted' }, async requestPermission() { return 'granted' },
        async createWritable() { return { async write() {}, async close() {} } } }
      window.showSaveFilePicker = async () => handle
    })
    const p = await ctx.newPage()
    const errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    p.on('dialog', (d) => d.accept())
    await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
    await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar'))
    await p.waitForTimeout(400)
    // the controls a click can land on, by their command (stable across tiers
    // AND platforms: the tooltip was the handle until it began to name the
    // platform's own modifier — "Undo (CtrlZ)" off a Mac — and on Linux, CI
    // included, both buttons then read as missing, which also made every
    // "did not move" check below compare missing with missing and pass)
    const rects = () => p.evaluate(() => Object.fromEntries([['Undo (⌘Z)', 'undo'], ['Redo (⇧⌘Z)', 'redo']].map(([t, cmd]) => {
      const b = [...document.querySelectorAll('.ed-topbar .ed-btn')].find((x) => x.dataset.cmd === cmd && x.getBoundingClientRect().width)
      const r = b?.getBoundingClientRect()
      return [t, r ? `${r.x.toFixed(1)},${r.y.toFixed(1)},${r.width.toFixed(1)}` : 'missing']
    })))
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

    // a first save gives the deck a file (and a handle for auto-save)
    await p.keyboard.press(`${MOD}+s`)
    await p.waitForTimeout(600)
    const base = await rects()
    // the folded phone bar keeps Undo; Redo moves into ⋯ by design
    ok(base['Undo (⌘Z)'] !== 'missing' && (label === 'phone' || base['Redo (⇧⌘Z)'] !== 'missing'),
      `${label === 'phone' ? 'Undo is' : 'Undo and Redo are'} on the bar (${JSON.stringify(base)})`)

    // a real auto-save write-back flashes "Saved"
    await p.locator('.ed-title').fill('Stability check')
    await p.locator('.ed-title').press('Tab')
    await p.waitForSelector('.ed-autosaved.show', { timeout: 6000 }).catch(() => {})
    const during = await rects()
    const tag = await p.evaluate(() => {
      const t = document.querySelector('.ed-autosaved.show'), bar = document.querySelector('.ed-topbar')
      if (!t) return null
      const r = t.getBoundingClientRect(), b = bar.getBoundingClientRect()
      return { text: t.textContent, inBar: r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.width > 0, opacity: +getComputedStyle(t).opacity }
    })
    ok(!!tag && tag.inBar, `the "Saved" flash shows, inside the bar (${JSON.stringify(tag)})`)
    ok(same(base, during), `Undo and Redo do not move while it shows (${JSON.stringify(during)})`)
    await p.waitForTimeout(2000)
    ok(same(base, await rects()), 'nor after it fades')

    // the title matches the file name, then an undo brings the old one back
    await p.locator('.ed-title').fill('stable-test')
    await p.locator('.ed-title').press('Tab')
    await p.waitForTimeout(300)
    const quiet = await rects()
    ok(same(base, quiet), `renaming the deck to its file's name leaves them put (${JSON.stringify(quiet)})`)
    await p.mouse.click(10, height - 10) // off the title, so ⌘Z is the deck's undo
    await p.keyboard.press(`${MOD}+z`)
    await p.waitForTimeout(300)
    const undone = await p.evaluate(() => window.bento.doc.title)
    ok(undone !== 'stable-test' && same(base, await rects()), `and so does undoing it (title "${undone}")`)

    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
    await ctx.close()
  }
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
