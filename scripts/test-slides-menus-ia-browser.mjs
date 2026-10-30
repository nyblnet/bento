// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The top bar's map: Save saves, File acts on the document, the app cluster
// sets up the app, About is only about.
//
//   npm run build:single --prefix slides && node scripts/test-slides-menus-ia-browser.mjs
//
// WHAT THIS PROVES (docs/DECISIONS.md 2026-10-30, the top bar's three kinds):
//   1. Save ▾ holds only the ways to save: a copy, a new deck, a password.
//   2. The wordmark opens the File menu: new, import, export (print among
//      them), version history, document properties, compress pictures, the
//      document as JSON, About — and its rows work.
//   3. Print stays in sight on the bar, and in File ▸ Export.
//   4. The app cluster — shortcuts, help, preferences — is one group, each
//      with its hint; Preferences holds the app's settings, and they persist.
//   5. About holds no settings and no document properties.
//   6. ⌘K finds every moved command; ⌘, opens Preferences.
//   7. At 1280, 768 and 390 no bar control overlaps another.
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const SHELL = process.env.SHELL_HTML || fileURLToPath(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url))

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const run = async (fn) => { try { await fn() } catch (e) { ok(false, `threw: ${String(e.message).split('\n')[0]}`) } }

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const open = async (width) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } })
    await ctx.addInitScript(() => { try { localStorage.setItem('bento-slideshow-started', '1') } catch {} })
    await ctx.route(/^https?:/, (r) => r.abort())
    const p = await ctx.newPage()
    const errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    p.on('dialog', (d) => d.dismiss())
    await p.goto('file://' + SHELL)
    await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar'))
    await p.waitForTimeout(400)
    return { p, ctx, errors }
  }
  const { p, ctx, errors } = await open(1440)
  const rows = (sel) => p.$$eval(`${sel} > .ed-btn`, (r) => r.map((b) => b.getAttribute('aria-label') ?? b.querySelector('.ed-menu-label')?.textContent?.trim() ?? b.textContent.trim()))

  console.log('\n1. Save ▾ saves\n')
  await run(async () => {
    await p.click('.ed-split-caret'); await p.waitForTimeout(150)
    const save = await rows('.ed-save-menu')
    ok(save.length === 3 && /copy/i.test(save[0]) && /new deck/i.test(save[1]) && /password/i.test(save[2]), `exactly the ways to save (${save.join(' · ')})`)
    ok(!save.some((x) => /JSON|PowerPoint|images|history|scratch/i.test(x)), 'nothing that is not saving')
    await p.click('.ed-split-caret')
  })

  console.log('\n2. File, on the wordmark\n')
  await run(async () => {
    await p.click('.ed-logo'); await p.waitForTimeout(150)
    const cmds = await p.$$eval('.ed-file-menu > .ed-btn', (r) => r.map((b) => b.dataset.cmd))
    const want = ['start-scratch', 'import-pptx', 'export-pdf', 'export-images', 'export-pptx', 'version-history', 'doc-props', 'compress-images', 'copy-json', 'copy-compact-json', 'replace-json', 'about']
    ok(want.every((c) => cmds.includes(c)), `every document command is there (${cmds.join(', ')})`)
    const caps = await p.$$eval('.ed-file-menu > .ed-menu-cap', (r) => r.map((c) => c.textContent))
    ok(caps.includes('Export') && caps.includes('Advanced'), `grouped under captions (${caps.join(', ')})`)
    ok(await p.$eval('.ed-file-menu [data-cmd="export-pdf"]', (b) => /P/.test(b.querySelector('.ed-menu-keys')?.textContent ?? '')), 'Print shows its shortcut there')
    await p.click('.ed-file-menu [data-cmd="doc-props"]'); await p.waitForTimeout(200)
    const props = await p.$eval('.ed-about', (b) => b.innerText)
    ok(/Author/.test(props) && /Keywords/.test(props) && /\{\{author\}\}/.test(props), 'Document properties opens its own dialog with the fields')
    await p.keyboard.press('Escape')
    await p.click('.ed-logo'); await p.click('.ed-file-menu [data-cmd="version-history"]')
    ok(await p.waitForSelector('.ed-version-box', { timeout: 3000 }).then(() => true, () => false), 'Version history opens')
    await p.keyboard.press('Escape')
    await p.evaluate(() => document.querySelectorAll('.ed-about-overlay, .ed-dialog-overlay').forEach((o) => o.remove()))
  })

  console.log('\n3. Print in sight\n')
  await run(async () => {
    const pdf = await p.$('.ed-topbar .ed-group-right > [data-cmd="export-pdf"]')
    ok(!!pdf && await pdf.isVisible(), 'Print is a visible bar button')
    ok(/⌘P|Ctrl\+?P/.test((await pdf.getAttribute('title')) ?? ''), `its hint carries ⌘P (${await pdf.getAttribute('title')})`)
  })

  console.log('\n4. The app cluster and Preferences\n')
  await run(async () => {
    const app = await p.$$eval('.ed-topbar .ed-app button', (bs) => bs.map((b) => ({ cmd: b.dataset.cmd ?? '', name: b.getAttribute('aria-label') ?? b.title, title: b.title, w: Math.round(b.getBoundingClientRect().width) })))
    ok(app.length === 3, `one group of three (${app.map((a) => a.name).join(' · ')})`)
    ok(app.some((a) => a.cmd === 'help' && /\?/.test(a.title)) && app.some((a) => a.cmd === 'preferences' && /,/.test(a.title)), 'shortcuts (?) and preferences (⌘,) carry their keys')
    ok(new Set(app.map((a) => a.w)).size === 1, `same-size buttons (${app.map((a) => a.w).join('/')})`)
    ok(!(await p.$('.ed-topbar .ed-lang-menu')), 'no loose language button on the bar')
    await p.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma'); await p.waitForTimeout(200)
    const prefs = await p.$eval('.ed-about', (b) => ({ text: b.innerText, cls: b.className }))
    ok(/ed-prefs/.test(prefs.cls), '⌘, opens Preferences')
    ok(['Appearance', 'Language', 'automatically', 'Shrink photos', 'Offline'].every((w) => prefs.text.includes(w)), 'Preferences holds the app’s settings')
    ok(!/Author|Keywords|Compress pictures/.test(prefs.text), '…and nothing of the document')
    const was = await p.$eval('.ed-prefs input[type=checkbox]', (c) => c.checked)
    await p.click('.ed-prefs input[type=checkbox]')
    await p.keyboard.press('Escape')
    await p.click('.ed-topbar [data-cmd="preferences"]'); await p.waitForTimeout(150)
    ok(await p.$eval('.ed-prefs input[type=checkbox]', (c) => c.checked) === !was, 'a setting persists across reopening')
    await p.click('.ed-prefs input[type=checkbox]') // put it back
    await p.keyboard.press('Escape')
  })

  console.log('\n5. About is about\n')
  await run(async () => {
    await p.click('.ed-logo'); await p.click('.ed-file-menu [data-cmd="about"]'); await p.waitForTimeout(200)
    const about = await p.$eval('.ed-about', (b) => b.innerText)
    ok(/v\d+\.\d+\.\d+/.test(about) && /Check for updates/.test(about), 'version and the update check')
    ok(!/Appearance|Offline|Shrink photos|Author|Keywords|Compress pictures/.test(about), 'no settings and no document properties')
    await p.keyboard.press('Escape')
  })

  console.log('\n6. ⌘K finds them\n')
  await run(async () => {
    for (const q of ['Preferences', 'Document properties', 'Version history', 'Print', 'Replace from JSON', 'Language', 'Keyboard shortcuts']) {
      await p.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k'); await p.waitForTimeout(150)
      await p.keyboard.type(q); await p.waitForTimeout(150)
      const hit = await p.$$eval('.ed-cmdk-list [role=option], .ed-cmdk-list li, .ed-cmdk-row', (r) => r.map((x) => x.textContent).join(' | '))
      ok(hit.toLowerCase().includes(q.toLowerCase().split(' ')[0]), `⌘K "${q}" finds it`)
      await p.keyboard.press('Escape')
    }
  })
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  await ctx.close()

  console.log('\n7. Nothing overlaps on the bar\n')
  for (const w of [1280, 768, 390]) {
    await run(async () => {
      const s = await open(w)
      const n = await s.p.evaluate(() => {
        const rs = [...document.querySelectorAll('.ed-topbar .ed-btn, .ed-topbar .ed-logo, .ed-topbar .ed-title')]
          .filter((e) => !e.closest('.ed-menu') && e.offsetParent && getComputedStyle(e).visibility !== 'hidden')
          .map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height)
        let hits = 0
        for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
          const a = rs[i], b = rs[j]
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hits++
        }
        return hits
      })
      ok(n === 0, `${w}px: no two bar controls overlap (${n})`)
      await s.ctx.close()
    })
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
