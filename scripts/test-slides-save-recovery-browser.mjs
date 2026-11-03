// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// ⌘S never costs an edit its crash-recovery copy, and a save still records one.
//
//   npm run build:single --prefix slides && node scripts/test-slides-save-recovery-browser.mjs
//
// WHAT THIS PROVES, in the packaged document. An edit schedules an auto-save
// (2.5 s), which writes the deck's recovery copy to IndexedDB: the backstop if
// the tab dies. A save makes that pending write redundant, so it is cancelled —
// but only after a save that SUCCEEDED and left nothing unsaved. Cancelled at
// the start of every save, a save the user then dismissed (the picker closed)
// took the edit's only recovery copy with it. And the save's own recovery
// baseline and version checkpoint now run when the page is idle rather than in
// the save's path; they must still run.
//   1. edit, ⌘S, dismiss the save picker, wait past the debounce: the edit IS in
//      the recovery store (and in the version history);
//   2. edit, ⌘S that succeeds (a download here): the recovery copy and a
//      version hold the saved deck, written by the deferred checkpoint.
// Mutation: cancel the timer at the start of save() again and 1 goes red.
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
const dir = mkdtempSync(join(tmpdir(), 'bento-save-recovery-'))
const SAVE = process.platform === 'darwin' ? 'Meta+s' : 'Control+s'

// which IndexedDB stores hold `marker` (recovery and version history live in IndexedDB)
const stores = (p, marker) => p.evaluate(async (m) => {
  const hits = []
  for (const { name } of await indexedDB.databases()) {
    const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    for (const store of Array.from(db.objectStoreNames)) {
      const all = await new Promise((res) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })
      if (JSON.stringify(all).includes(m)) hits.push(store)
    }
    db.close()
  }
  return hits
}, marker)
async function open(withPicker) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true })
  await ctx.route(/^https?:/, (r) => r.abort())
  await ctx.addInitScript((keep) => { if (!keep) delete window.showSaveFilePicker; try { localStorage.setItem('bento-slideshow-started', '1') } catch {} }, withPicker)
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('dialog', (d) => d.dismiss())
  const file = join(dir, `deck-${Math.random().toString(36).slice(2)}.bento.html`)
  writeFileSync(file, shell)
  await p.goto('file://' + file)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar .ed-title'))
  await p.waitForTimeout(400)
  return { ctx, p, errors }
}
const retitle = async (p, title) => {
  await p.locator('.ed-topbar .ed-title').fill(title)
  await p.locator('.ed-topbar .ed-title').press('Enter')
  await p.waitForFunction((t) => window.bento.doc.title === t, title)
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  console.log('a save the user dismisses\n')
  {
    const { ctx, p, errors } = await open(true)
    ok(await p.evaluate(() => typeof window.showSaveFilePicker === 'function'), 'this browser has a save picker (left unanswered, the save is cancelled)')
    const MARK = 'Cancelled save ' + Date.now()
    await retitle(p, MARK)
    await p.waitForTimeout(300) // well inside the 2.5 s debounce
    await p.keyboard.press(SAVE)
    await p.waitForTimeout(500)
    await p.keyboard.press('Escape') // nobody picks a file
    await p.waitForTimeout(4000) // past the debounce
    const hits = await stores(p, MARK)
    ok(hits.includes('recovery'), `the edit is in the recovery store after the dismissed save (${hits.join(', ') || 'nowhere'})`)
    ok(errors.length === 0, `no page error${errors.length ? ' — ' + errors[0] : ''}`)
    await ctx.close()
  }

  console.log('\na save that succeeds\n')
  {
    const { ctx, p, errors } = await open(false)
    const MARK = 'Saved deck ' + Date.now()
    await retitle(p, MARK)
    const dl = p.waitForEvent('download', { timeout: 15000 }).catch(() => null)
    await p.keyboard.press(SAVE)
    ok(!!(await dl), 'the save went through (a download: this browser cannot write in place)')
    await p.waitForTimeout(1200) // the deferred checkpoint runs when idle, at most 200 ms later
    const hits = await stores(p, MARK)
    ok(hits.includes('recovery') && hits.includes('versions'), `the save recorded a recovery baseline and a version (${hits.join(', ') || 'nowhere'})`)
    ok(errors.length === 0, `no page error${errors.length ? ' — ' + errors[0] : ''}`)
    await ctx.close()
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
