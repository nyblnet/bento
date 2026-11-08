// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// "Save a copy…" keeps you on the original, and the recovery banner warns when
// its copy looks older than the file.
//
//   npm run build:single --prefix slides && node scripts/test-slides-save-copy-browser.mjs
//
// WHAT THIS PROVES, in the packaged editor (maintainer rulings 2026-10-15):
//   1. after ⌘S to one file, an edit, then Save as → Save a copy… to another:
//      the toast is "Copy saved — you are still editing the original" (never
//      "Saved"), the file chip and the window title still name the original,
//      the unsaved dot stays on, and the next ⌘S writes the ORIGINAL file with
//      no picker;
//   2. a recovery snapshot OLDER than the file's own `modified` time gets the
//      warning banner — "This recovered copy looks older than the file you
//      opened. Keep the file unless you know it’s newer." — with "Keep the
//      file" first and focused, and "Restore anyway"; keeping the file does not
//      delete the snapshot;
//   3. a snapshot that is NOT older gets the plain banner, which claims
//      nothing about "newer" or "safe".
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
const COPY_TOAST = 'Copy saved — you are still editing the original'
const OLDER = 'This recovered copy looks older than the file you opened. Keep the file unless you know it’s newer.'
const shellPath = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url)

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  console.log('\nSave a copy… keeps you on the original\n')
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await ctx.route(/^https?:/, (r) => r.abort())
    await ctx.addInitScript(() => {
      window.__picks = []
      window.__writes = []
      const names = ['original.bento.html', 'copy.bento.html']
      const handleFor = (name) => ({
        kind: 'file', name,
        async queryPermission() { return 'granted' },
        async requestPermission() { return 'granted' },
        async isSameEntry(o) { return o?.name === name },
        async createWritable() { return { async write(b) { window.__writes.push(name); void b }, async close() {} } },
      })
      window.showSaveFilePicker = async () => { const n = names[Math.min(window.__picks.length, names.length - 1)]; window.__picks.push(n); return handleFor(n) }
    })
    const p = await ctx.newPage()
    const errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    p.on('dialog', (d) => d.accept())
    await p.goto(shellPath.href)
    await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-title'))
    const toast = () => p.evaluate(() => document.querySelector('.ed-toast')?.textContent ?? '')
    const state = () => p.evaluate(() => ({
      chip: document.querySelector('.ed-filechip')?.textContent ?? '',
      title: document.title,
      dirty: !!document.querySelector('.ed-dirty.on'),
      picks: [...window.__picks], writes: [...window.__writes],
    }))
    await p.locator('.ed-title').fill('Quarterly review')
    await p.locator('.ed-title').press('Tab')
    await p.keyboard.press('ControlOrMeta+s')
    await p.waitForFunction(() => window.__writes.length >= 1)
    await p.waitForTimeout(300)
    const afterSave = await state()
    ok(afterSave.writes[0] === 'original.bento.html' && !afterSave.dirty, `⌘S wrote original.bento.html and the dot went out (${afterSave.writes})`)
    // an edit, then Save as → Save a copy…
    await p.locator('.ed-title').fill('Quarterly review v2')
    await p.locator('.ed-title').press('Tab')
    const before = await state()
    await p.evaluate(() => document.querySelector('.ed-split-caret').click())
    await p.evaluate(() => [...document.querySelectorAll('.ed-save-menu > .ed-btn')].find((b) => (b.getAttribute('aria-label') ?? b.textContent).startsWith('Save a copy')).click())
    await p.waitForFunction(() => window.__writes.includes('copy.bento.html'))
    await p.waitForTimeout(300)
    const afterCopy = await state()
    const t = await toast()
    ok(t === COPY_TOAST, `the toast says the copy is saved and you are on the original ("${t}")`)
    ok(afterCopy.chip === before.chip && afterCopy.title === before.title, `the file chip and window title still name the original ("${afterCopy.chip}" / "${afterCopy.title}")`)
    ok(afterCopy.dirty, 'the unsaved dot stays on: the original has not been saved')
    await p.keyboard.press('ControlOrMeta+s')
    await p.waitForFunction((n) => window.__writes.length > n, afterCopy.writes.length)
    await p.waitForTimeout(300)
    const afterResave = await state()
    ok(afterResave.writes.at(-1) === 'original.bento.html' && afterResave.picks.length === afterCopy.picks.length,
      `the next ⌘S writes the original, with no picker (${afterResave.writes.join(' → ')})`)
    ok(!afterResave.dirty && (await toast()) === 'Saved', 'and that save is a real "Saved" of the original')
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
    await ctx.close()
  }

  // A saved deck with a fixed docId and modified time, spliced into the shell.
  const shell = readFileSync(shellPath, 'utf8')
  const open = '<script type="application/bento+json" id="bento-doc">'
  const i = shell.indexOf(open) + open.length, j = shell.indexOf('</' + 'script>', i)
  const dir = mkdtempSync(join(tmpdir(), 'bento-recovery-'))
  const deckFile = join(dir, 'deck.bento.html')
  const page = await browser.newPage()
  await page.route(/^https?:/, (r) => r.abort())
  await page.goto(shellPath.href)
  await page.waitForFunction(() => window.bento?.doc)
  // Relative to now, never a fixed date: the app prunes recovery snapshots older than
  // 30 days on boot (kernel autosave pruneOld), so a fixed date silently aged the planted
  // snapshot out and the banner checks failed from a calendar date on.
  const MODIFIED = new Date(Date.now() - 2 * 86_400_000).toISOString()
  const doc = await page.evaluate((m) => { const d = JSON.parse(JSON.stringify(window.bento.doc)); d.docId = 'rig-recovery-deck'; d.modified = m; delete d.collab; return d }, MODIFIED)
  await page.close()
  writeFileSync(deckFile, shell.slice(0, i) + JSON.stringify(doc).replace(/</g, '\\u003c') + shell.slice(j))

  async function withSnapshot(at) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await ctx.route(/^https?:/, (r) => r.abort())
    const p = await ctx.newPage()
    await p.goto('file://' + deckFile)
    await p.waitForFunction(() => window.bento?.doc)
    await p.evaluate(async ([d, when]) => {
      // the app's own store (kernel autosave: `${appId}-autosave`), NOT the legacy shared `bento-autosave` it migrates from
      const db = await new Promise((res, rej) => { const r = indexedDB.open('bento-slides-autosave'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      const snap = JSON.parse(JSON.stringify(d)); snap.title = 'Recovered edits'
      await new Promise((res, rej) => { const tx = db.transaction('recovery', 'readwrite'); tx.objectStore('recovery').put({ docId: d.docId, at: when, title: snap.title, json: JSON.stringify(snap) }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
      db.close()
    }, [doc, at])
    await p.reload()
    await p.waitForFunction(() => window.bento?.doc)
    await p.waitForSelector('.ed-recover', { timeout: 8000 }).catch(() => {})
    return { ctx, p }
  }

  console.log('\nan older snapshot: the warning banner\n')
  {
    const { ctx, p } = await withSnapshot(Date.parse(MODIFIED) - 86_400_000)
    const b = await p.evaluate(() => {
      const bar = document.querySelector('.ed-recover')
      return bar ? { text: bar.querySelector('span')?.textContent ?? '', buttons: [...bar.querySelectorAll('button')].map((x) => x.textContent), focused: document.activeElement?.textContent ?? '' } : null
    })
    ok(!!b && b.text === OLDER, `the banner warns the copy looks older ("${b?.text}")`)
    ok(!!b && b.buttons[0] === 'Keep the file' && b.buttons[1] === 'Restore anyway', `"Keep the file" first, then "Restore anyway" (${b?.buttons.join(' · ')})`)
    ok(!!b && b.focused === 'Keep the file', 'keeping the file is the default (focused)')
    await p.evaluate(() => [...document.querySelectorAll('.ed-recover button')].find((x) => x.textContent === 'Keep the file').click())
    await p.waitForTimeout(1000) // long enough for an async IndexedDB delete to land, were one issued
    const kept = await p.evaluate(async () => {
      const gone = !document.querySelector('.ed-recover')
      const db = await new Promise((res) => { const r = indexedDB.open('bento-slides-autosave'); r.onsuccess = () => res(r.result) })
      const snap = await new Promise((res) => { const r = db.transaction('recovery').objectStore('recovery').get('rig-recovery-deck'); r.onsuccess = () => res(r.result) })
      return { gone, snap: snap ? { at: snap.at, title: snap.title } : null, title: window.bento.doc.title }
    })
    ok(kept.gone && kept.title !== 'Recovered edits', 'Keep the file closes the banner and keeps the file')
    ok(kept.snap?.title === 'Recovered edits' && kept.snap?.at === Date.parse(MODIFIED) - 86_400_000,
      `without deleting the planted snapshot (a clock-skewed "older" must never cost work) (${JSON.stringify(kept.snap)})`)
    await ctx.close()
  }

  console.log('\na snapshot that is not older: the plain banner\n')
  {
    const { ctx, p } = await withSnapshot(Date.parse(MODIFIED) + 86_400_000)
    const b = await p.evaluate(() => {
      const bar = document.querySelector('.ed-recover')
      return bar ? { text: bar.textContent ?? '', buttons: [...bar.querySelectorAll('button')].map((x) => x.textContent) } : null
    })
    ok(!!b && b.text.startsWith('Unsaved changes from ') && b.buttons.join(',') === 'Restore,Discard', `the plain banner (${b?.buttons.join(' · ')})`)
    ok(!!b && !/newer|older|safe/i.test(b.text), `and it claims nothing about newer, older or safe ("${b?.text}")`)
    await ctx.close()
  }
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
