// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A sealed deck's content never reaches IndexedDB, and it never offers or keeps an unsealed snapshot.
//
//   npm run build:sealtest --prefix slides && node scripts/test-slides-sealed-guards-browser.mjs
//
// WHAT THIS PROVES, on slides' build:sealtest shell through the shared helper
// (scripts/lib/sealed-boot.mjs). A deck's body can be sealed by a password OR
// by the identity seal; kernel's isBodySealed() covers both. Slides' guards on
// plaintext-to-disk — the autosave's recovery copy and version checkpoint, the
// ⌘S checkpoint, the "recovery is off" notice — used isEncryptionActive(), the
// password alone, so an identity-sealed deck's edits were written in plaintext
// to bento-slides-autosave (measured: recovery AND versions). Now:
//   1. sealed: after an edit and past the autosave debounce, and again after a
//      ⌘S, no IndexedDB record carries the deck's content; the saved file is a
//      sealed envelope with a neutral <title>, no preview and no content;
//   2. the password items stay keyed to the PASSWORD: a deck sealed by
//      identity, with no password, offers "Encrypt with password…", never
//      "Change password…" or "Remove password";
//   3. control, the same shell unsealed: the same edit DOES reach IndexedDB,
//      so the scan can see a leak.
//   4. a sealed document never offers or keeps an unsealed snapshot: after an
//      unsealed session leaves one (recovery + version) for its docId, a
//      sealed boot on the same storage shows no Restore banner, lists nothing
//      in version history, and deletes it; another document's snapshot
//      survives; control: an unsealed reboot DOES offer it back.
// The kernel store now refuses plaintext while sealed (a BACKSTOP), so IndexedDB
// stays clean even with one of slides' guards reverted. Every sealed page
// therefore ends with the helper's close(), which fails on any refused read or
// write: slides' own guard has to stop the call first.
// Mutations (each rebuilt, build:sealtest exit checked): the autosave guard on
// isEncryptionActive(), the ⌘S checkpoint guard on it, the sealed boot skipping
// the delete, and no sealed branch at boot (the banner offered) each go red.
import { openSealed, savedFile, scanIndexedDB } from './lib/sealed-boot.mjs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const MARK = 'ZZSEALEDGUARD' + Date.now()

// End a SEALED page through the helper's close(), never context.close(): it
// throws if the kernel store's backstop had to refuse a plaintext read or write.
// The backstop keeps IndexedDB clean even when slides' own guard is missing, so
// the scans alone would pass with a guard reverted; this row is what fails then.
async function closes(sealed, what) {
  try {
    await sealed.close()
    ok(true, `${what}: the kernel store refused nothing (slides' own guards stopped every plaintext read and write)`)
  } catch (e) {
    ok(false, `${what}: ${String(e.message || e).split('\n')[0]}`)
  }
}

// an edit: the marker into the title and the first text box, then past the
// 2.5s autosave debounce
async function edit(page) {
  await page.evaluate((m) => {
    const d = structuredClone(window.bento.doc)
    d.title = m
    const el = d.slides?.[0]?.elements?.find((e) => e.type === 'text')
    if (el) el.html = `<p>${m}</p>`
    window.bento.loadDoc(JSON.stringify(d))
  }, MARK)
  await page.waitForTimeout(4000)
}
async function saveMenu(page) {
  await page.locator('.ed-split-caret').click()
  const items = await page.locator('.ed-save-menu').innerText()
  await page.keyboard.press('Escape')
  await page.mouse.click(5, 880)
  return items
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  console.log('sealed by identity (no password)\n')
  {
    const sealed = await openSealed(browser, 'slides')
    const { page, errors } = sealed
    await page.evaluate(() => { try { localStorage.setItem('bento-slideshow-started', '1') } catch {} })
    await edit(page)
    ok(await page.evaluate((m) => window.bento.doc.title === m, MARK), 'the edit landed in the live deck (the scans below are real)')
    const afterAutosave = await scanIndexedDB(page, MARK)
    ok(afterAutosave.length === 0, `after the autosave: no IndexedDB record carries the content (${afterAutosave.join(', ') || 'none'})`)
    // ⌘S: a download here (no file handle), then the save's own checkpoint.
    // Headless Chromium HAS showSaveFilePicker, and a picker nobody answers is a
    // cancelled save that returns before the checkpoint — so take it away, and
    // require the download, or this step proves nothing.
    await page.evaluate(() => { delete window.showSaveFilePicker })
    const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    ok(!!(await dl), '⌘S saved (a download), so the save checkpoint ran')
    await page.waitForTimeout(800)
    const afterSave = await scanIndexedDB(page, MARK)
    ok(afterSave.length === 0, `after ⌘S: still none (${afterSave.join(', ') || 'none'})`)
    const { file, body } = await savedFile(page)
    const env = JSON.parse(body)
    ok(env.format === 'bento/enc' && !file.includes(MARK) && !file.includes('data-bento-preview') && !/<title>[^<]*ZZSEALED/.test(file),
      'the saved file: a sealed envelope, neutral <title>, no preview, no content')
    const menu = await saveMenu(page)
    ok(/Encrypt with password/.test(menu) && !/Change password|Remove password/.test(menu),
      'the password items follow the password, not the seal: "Encrypt with password…" is offered, "Change"/"Remove password" are not')
    ok(errors.length === 0, `no page error${errors.length ? ' — ' + errors[0] : ''}`)
    await closes(sealed, 'the sealed edit, autosave and ⌘S')
  }

  console.log('\nunsealed control (same shell, no key handed over)\n')
  {
    const { page, context } = await openSealed(browser, 'slides', { sealed: false })
    await edit(page)
    const hits = await scanIndexedDB(page, MARK)
    ok(hits.length > 0, `the unsealed edit DOES reach IndexedDB (${hits.join(', ') || 'none'}), so the scan can see a leak`)
    await context.close()
  }

  // --- 4. a sealed document never offers or keeps an unsealed snapshot ----------
  // Recovery is keyed by docId, so these boot FIXED documents, and share one
  // IndexedDB across sessions through { context, url }.
  console.log('\nan unsealed snapshot left from an earlier session\n')
  const deck = (docId, text) => ({
    format: 'bento/slides', version: 1, docId, title: `deck ${docId}`,
    size: { width: 1280, height: 720 },
    theme: { background: '#ffffff', color: '#1E2A3A', accent: '#f7a600', fontFamily: 'system-ui' },
    slides: [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: [{ id: 't1', type: 'text', x: 100, y: 100, w: 600, h: 80, html: `<p>${text}</p>` }] }],
  })
  const MA = MARK + 'A', MB = MARK + 'B'
  const editTo = async (page, m) => {
    await page.evaluate((m) => {
      const d = structuredClone(window.bento.doc)
      d.slides[0].elements[0].html = `<p>${m}</p>`
      window.bento.loadDoc(JSON.stringify(d))
    }, m)
    await page.waitForTimeout(4000) // past the autosave debounce
  }
  const banner = (page) => page.waitForSelector('.ed-recover', { timeout: 2500 }).then(() => true, () => false)
  async function versionRows(page) {
    await page.locator('.ed-split-caret').click()
    await page.locator('.ed-save-menu').getByText('Version history…', { exact: true }).click()
    await page.waitForSelector('.ed-version-box', { timeout: 3000 })
    const n = await page.locator('.ed-version-box .ed-version-row').count()
    await page.evaluate(() => document.querySelector('.ed-about-overlay')?.remove())
    return n
  }

  // control: unsealed, then unsealed again on the same storage — the banner IS offered
  {
    const first = await openSealed(browser, 'slides', { sealed: false, doc: deck('rig-sealed-ctl', 'original') })
    await editTo(first.page, MA)
    ok((await scanIndexedDB(first.page, MA)).length > 0, 'control: the unsealed edit left a snapshot')
    await first.page.close()
    const again = await openSealed(browser, 'slides', { sealed: false, context: first.context, url: first.url })
    ok(await banner(again.page), 'control: an unsealed reboot DOES offer it back (the checks below can see an offer)')
    ok(await versionRows(again.page) > 0, 'control: and its version history lists it')
    await first.context.close()
  }
  // sealed boot over a leftover snapshot, beside another document's snapshot
  {
    const a = await openSealed(browser, 'slides', { sealed: false, doc: deck('rig-sealed-a', 'original') })
    await editTo(a.page, MA)
    const b = await openSealed(browser, 'slides', { sealed: false, doc: deck('rig-sealed-b', 'original'), context: a.context })
    await editTo(b.page, MB)
    ok((await scanIndexedDB(b.page, MA)).length > 0 && (await scanIndexedDB(b.page, MB)).length > 0, 'two unsealed sessions left a snapshot each (A and B)')
    await a.page.close()
    await b.page.close()
    const s = await openSealed(browser, 'slides', { context: a.context, url: a.url })
    ok(!(await banner(s.page)), 'sealed boot of A: no Restore banner')
    ok(await versionRows(s.page) === 0, 'sealed boot of A: nothing in version history')
    const leftA = await scanIndexedDB(s.page, MA)
    ok(leftA.length === 0, `sealed boot of A: A's unsealed snapshot is deleted (${leftA.join(', ') || 'none left'})`)
    const leftB = await scanIndexedDB(s.page, MB)
    ok(leftB.length > 0, `another document's snapshot survives (${leftB.join(', ') || 'GONE'})`)
    ok(s.errors.length === 0, `no page error${s.errors.length ? ' — ' + s.errors[0] : ''}`)
    // the sealed boot's purge and the empty history must come from slides'
    // own checks: a refused getRecovery/listVersions READ fails here too
    await closes(s, 'the sealed boot of A, its purge and its version history')
    await a.context.close()
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
