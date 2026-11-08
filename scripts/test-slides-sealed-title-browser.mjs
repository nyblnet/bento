// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A password-protected deck's title never appears in a window title.
//
//   npm run build:single --prefix slides && node scripts/test-slides-sealed-title-browser.mjs
//
// WHAT THIS PROVES, in the packaged document. Browsers keep tab titles in their
// history, so a title shown in a tab outlives the session. While a deck's body
// is sealed (a password), every window title slides sets is neutral: the file
// name when it is known, else the app. Checked on a deck whose title is a
// marker string, encrypted through the real UI and saved:
//   1. at the password gate, after unlocking, and after an edit that re-runs
//      the editor's title sync, document.title does not contain the marker;
//   2. the speaker-view popup's title does not contain it;
//   3. control first, on an unencrypted deck: the marker IS in the tab and the
//      speaker title (so the checks above can fail); then adding a password
//      makes both neutral at once — before any save — and removing it brings
//      the marker back.
//   4. a deck sealed by IDENTITY (no password; the build:sealtest shell via
//      scripts/lib/sealed-boot.mjs): its tab and speaker window stay neutral
//      after a rename, and the same shell unsealed shows the title (control).
// Mutations: make the sealed check answer false and 1–4 go red; gate it on the
// password alone (isEncryptionActive) and 4 goes red.
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { openSealed, sealtestShell } from './lib/sealed-boot.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const PASS = 'correct horse 42'
const MARK = 'Zanzibar Merger Plan'
const shell = readFileSync(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'bento-sealed-title-'))

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
async function open(file) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true })
  await ctx.route(/^https?:/, (r) => r.abort())
  await ctx.addInitScript(() => { delete window.showSaveFilePicker; try { localStorage.setItem('bento-slideshow-started', '1') } catch {} })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('dialog', (d) => d.accept())
  await p.goto('file://' + file)
  return { ctx, p, errors }
}
const editorUp = (p) => p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar .ed-logo'), null, { timeout: 10000 })
async function setDeckTitle(p, title) {
  const input = p.locator('.ed-topbar .ed-title')
  await input.fill(title)
  await input.press('Enter')
  await p.waitForFunction((t) => window.bento.doc.title === t, title)
}
async function openSpeaker(p) {
  const popup = p.context().waitForEvent('page')
  await p.locator('.ed-present-pill .ed-pill-caret').click()
  await p.locator('.ed-present-pill .ed-menu').getByText('Open speaker view', { exact: true }).click()
  const w = await popup
  await w.waitForLoadState()
  return w
}
const encryptDialog = async (p) => {
  await p.locator('.ed-split-caret').click()
  await p.locator('.ed-save-menu').getByText('Encrypt with password…', { exact: true }).click()
  await p.locator('dialog.ed-pwdialog .pw1').fill(PASS)
  await p.locator('dialog.ed-pwdialog .pw2').fill(PASS)
}

try {
  // --- 3. control, then adding and removing a password ------------------------
  console.log('an unencrypted deck, then a password added and removed\n')
  const plain = join(dir, 'plain.bento.html')
  writeFileSync(plain, shell)
  const a = await open(plain)
  await editorUp(a.p)
  await setDeckTitle(a.p, MARK)
  const sp = await openSpeaker(a.p)
  ok((await a.p.title()).includes(MARK), `control: the unencrypted deck's tab shows its title ("${await a.p.title()}")`)
  ok((await sp.title()).includes(MARK), `control: so does the speaker window ("${await sp.title()}")`)

  // the password is set when the dialog confirms; the save it starts is a
  // download here, and the title must already be neutral before it lands
  await encryptDialog(a.p)
  // "at once" means BEFORE the save the dialog starts, which re-syncs the title
  // itself: record the tab title the moment the "Encrypted" toast appears. The
  // toast is inserted before save() is called, and this observer's callback is
  // queued ahead of the save's own continuation.
  await a.p.evaluate(() => {
    window.__titleAtToast = null
    const mo = new MutationObserver(() => {
      // textContent, not innerText: the toast is appended hidden and only shown
      // a timer later, and innerText skips hidden text
      if (window.__titleAtToast === null && /Encrypted — remember/.test(document.querySelector('.ed-toast')?.textContent || '')) { window.__titleAtToast = document.title; mo.disconnect() }
    })
    mo.observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  const dl = a.p.waitForEvent('download', { timeout: 15000 })
  await a.p.locator('dialog.ed-pwdialog button').last().click()
  // wait for the RECORDING, not the title: the title can turn neutral before
  // the toast (two IndexedDB clears sit between them), and reading early saw null
  await a.p.waitForFunction(() => window.__titleAtToast !== null, null, { timeout: 8000 }).catch(() => {})
  const atToast = await a.p.evaluate(() => window.__titleAtToast)
  ok(atToast !== null && !atToast.includes(MARK), `adding a password makes the tab neutral at once, before the save ("${atToast}")`)
  ok(!(await a.p.title()).includes(MARK), `…and it stays neutral after the save ("${await a.p.title()}")`)
  ok(!(await sp.title()).includes(MARK), `…and the open speaker window ("${await sp.title()}")`)
  const enc = join(dir, 'enc.bento.html')
  await (await dl).saveAs(enc)
  ok(/bento\/enc/.test(readFileSync(enc, 'utf8')), 'the saved file is encrypted')

  await a.p.locator('.ed-split-caret').click()
  await a.p.locator('.ed-save-menu').getByText('Remove password', { exact: true }).click()
  await a.p.waitForFunction((m) => document.title.includes(m), MARK, { timeout: 3000 }).catch(() => {})
  ok((await a.p.title()).includes(MARK), `removing the password brings the title back ("${await a.p.title()}")`)
  ok((await sp.title()).includes(MARK), `…to the speaker window too ("${await sp.title()}")`)
  ok(a.errors.length === 0, `no page error${a.errors.length ? ' — ' + a.errors[0] : ''}`)
  await a.ctx.close()

  // --- 1–2. opening the encrypted deck ------------------------------------------
  console.log('\nopening the encrypted deck\n')
  const b = await open(enc)
  await b.p.waitForSelector('.ed-pwcard input[type=password]')
  ok(!(await b.p.title()).includes(MARK), `at the password gate: "${await b.p.title()}"`)
  const input = b.p.locator('.ed-pwcard input[type=password]').first()
  await input.fill(PASS)
  await input.press('Enter')
  await editorUp(b.p)
  ok(await b.p.evaluate((m) => window.bento.doc.title === m, MARK), 'the unlocked deck carries the marker title (the check below is real)')
  ok(!(await b.p.title()).includes(MARK), `after unlocking: "${await b.p.title()}"`)
  // an edit that re-runs the title sync: rename the deck
  await setDeckTitle(b.p, `${MARK} v2`)
  ok(!(await b.p.title()).includes(MARK), `after an edit that re-syncs the title: "${await b.p.title()}"`)
  const sp2 = await openSpeaker(b.p)
  ok(!(await sp2.title()).includes(MARK), `the speaker window: "${await sp2.title()}"`)
  ok(b.errors.length === 0, `no page error${b.errors.length ? ' — ' + b.errors[0] : ''}`)
  await b.ctx.close()

  // --- sealed by identity, no password (the build:sealtest shell) ----------------
  if (existsSync(sealtestShell('slides'))) {
    console.log('\nsealed by identity (no password)\n')
    const s = await openSealed(browser, 'slides')
    await s.page.evaluate(() => { try { localStorage.setItem('bento-slideshow-started', '1') } catch {} })
    await setDeckTitle(s.page, MARK)
    ok(!(await s.page.title()).includes(MARK), `after renaming a sealed deck: "${await s.page.title()}"`)
    const sp3 = await openSpeaker(s.page)
    ok(!(await sp3.title()).includes(MARK), `its speaker window: "${await sp3.title()}"`)
    await s.context.close()
    const c = await openSealed(browser, 'slides', { sealed: false })
    await setDeckTitle(c.page, MARK)
    ok((await c.page.title()).includes(MARK), `control, the same shell unsealed: the title shows ("${await c.page.title()}")`)
    await c.context.close()
  } else console.log('\n  skip  sealed by identity (run npm run build:sealtest --prefix slides)')
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
