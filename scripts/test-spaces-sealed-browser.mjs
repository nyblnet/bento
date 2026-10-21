// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A SEALED SPACE WRITES NOTHING READABLE, in the built shell (Bento ID, bento/connect: K3).
//
//   npm run build:sealtest --prefix spaces && node scripts/test-spaces-sealed-browser.mjs
//
// The shared helper (scripts/lib/sealed-boot.mjs) boots spaces' build:sealtest
// shell with the identity seal set before the app's own boot and proves it took.
// On a space carrying a unique marker in its title and in a page's text:
//   1. after edits, a save and the autosave debounce, NO IndexedDB store holds
//      the marker: no recovery snapshot (main.ts autosave guard), no version
//      (main.ts save-path guard);
//   2. the saved file (the real ⌘S write) has no first-page preview and the
//      marker appears nowhere outside the envelope;
//   3. document.title is neutral (exactly what the saved file's <title> holds)
//      at boot, after a rename and after page navigation; and at the password
//      gate and after unlock for a password space;
//   4. under a host that refuses recovery copies, no recovery-off notice;
//   5. plaintext an UNSEALED session left for this docId on the same storage is
//      never offered to a SEALED boot (no banner, no version history) and is
//      deleted, while another document's entries survive.
// CONTROL: the same steps unsealed DO put the marker in the recovery and version
// stores, show the document title in the tab, and show the notice.
//
// Mutations (spaces/src), each red here. The kernel store refuses plaintext
// reads and writes while sealed (a backstop), so a reverted guard no longer
// shows in the IndexedDB scan: it is caught by the helper's reload()/close(),
// which throw when the store refused anything on a sealed page. reloadRow()
// and finish() turn those throws into red rows rather than a crash.
//   main.ts autosave guard back to isEncryptionActive  → the store-refusal rows
//   main.ts save-path guard back to isEncryptionActive → the store-refusal row after the save
//   tabtitle.ts tabTitle ignores the seal              → the title rows
//   main.ts offerRecovery skips the delete             → the plaintext-left-behind scan row
//   main.ts offerRecovery ignores the seal             → the store-refusal rows and the scan row
// The recovery-off notice's own guard (wireRecoveryOff encrypted:) is covered
// by the autosave guard: a mutation of it alone stays green, by design.
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openSealed, savedFile, scanIndexedDB, sealtestShellWith } from './lib/sealed-boot.mjs'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const MARK = 'ZZSPACESEAL' + Date.now()
const NEUTRAL = 'bento/spaces'
const DB = 'bento-spaces-autosave'
const NOTICE = 'Crash recovery is off for this space'
const PASS = 'correct horse battery staple'
let failures = 0, checks = 0
const ok = (cond, what) => { checks++; if (cond) console.log('  ok    ' + what); else { failures++; console.log('  FAIL  ' + what) } }

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const dir = mkdtempSync(join(tmpdir(), 'bento-spaces-sealed-'))

/** A save target ⌘S writes to, recording each file written. */
const fsaMock = () => {
  window.__written = []
  const handle = { name: 'sealed.bento.html', async createWritable() {
    return { async write(blob) { window.__written.push(await blob.text()) }, async close() {} }
  } }
  window.showSaveFilePicker = async () => handle
}

/** A host with a per-document store that refuses the recovery copy; counts the
 *  recovery copies it was asked for and every save-status sentence shown. */
const refusingHost = () => {
  window.__bentoHost = { ops: ['store'] }
  window.__sets = 0
  window.__notices = []
  const CH = '__bento_tray__'
  window.addEventListener('message', (ev) => {
    const d = ev.data
    if (!d || d[CH] !== true || d.dir !== 'req') return
    let result = { ok: true }
    if (d.op === 'store.set' && d.payload?.name === 'recovery') { window.__sets++; result = { ok: false, reason: 'too-large' } }
    if (d.op === 'store.get') result = { ok: true, bytes: null }
    if (d.op === 'store.list') result = { ok: true, names: [] }
    window.postMessage({ [CH]: true, dir: 'res', id: d.id, result }, '*')
  })
  new MutationObserver((ms) => {
    for (const m of ms) {
      const s = m.target.nodeType === 1 ? m.target.closest?.('.sp-status') : m.target.parentElement?.closest('.sp-status')
      if (s && m.type === 'childList' && s.textContent) window.__notices.push(s.textContent)
    }
  }).observe(document, { subtree: true, childList: true })
}

const sealedNow = (page) => page.evaluate(() => !!globalThis.__bentoTestSealProbe?.sealed())
const booted = (page) => page.waitForFunction(() => window.bento?.doc && document.querySelector('.sp-doctitle'), null, { timeout: 30000 })

/** Rename the space through the title field. */
async function rename(page, value) {
  await page.locator('.sp-doctitle').fill(value)
  await page.locator('.sp-doctitle').press('Tab')
}

/** Open another page from the page list; returns whether the page changed. */
async function navigate(page) {
  const before = await page.evaluate(() => document.querySelector('.sp-treelink.sp-here')?.textContent ?? '')
  await page.locator('.sp-treelink:not(.sp-here)').first().click()
  await page.waitForTimeout(300)
  const after = await page.evaluate(() => document.querySelector('.sp-treelink.sp-here')?.textContent ?? '')
  return after !== before
}

/**
 * End a page openSealed opened. The helper's close() (when this checkout's
 * helper has one) THROWS if the store refused a write on a sealed page: the
 * kernel's backstop must never be what keeps a scan clean, so a refusal is a
 * red row here. Without it, the context is closed as before.
 */
async function finish(o, what) {
  if (typeof o.close === 'function') {
    try { await o.close(); ok(true, `${what}: the store refused nothing`) }
    catch (e) { ok(false, `${what}: ${e.message}`) }
  }
  await o.context.close().catch(() => {})
}

/**
 * Reload a page openSealed opened, through the helper's reload(), which THROWS
 * on a sealed page whose store refused anything since it booted. That is a red
 * row here, not a crash: the rows after it still run. On a refusal the page is
 * reloaded plainly so the walk can go on.
 */
async function reloadRow(o, what) {
  try { await o.reload(); ok(true, `${what}: the store refused nothing before this reload`) }
  catch (e) { ok(false, `${what}: ${e.message}`); await o.page.reload() }
}

/** IndexedDB stores (db/store) holding the marker. */
const stores = async (page) => scanIndexedDB(page, MARK)

let marked, markedDoc
try {
  // ---- the marked space: a fixed docId, the marker in its title and text ----
  {
    const { page, context } = await openSealed(browser, 'spaces', { sealed: false })
    const doc = await page.evaluate((m) => {
      const d = structuredClone(window.bento.doc)
      d.docId = 'rig-sealed-space'
      d.title = m
      delete d.collab
      const b = d.pages[0].blocks.find((x) => typeof x.html === 'string')
      b.html = `${m} body text`
      return d
    }, MARK)
    ok(doc.pages.length >= 2, `the space has pages to navigate between (${doc.pages.length})`)
    markedDoc = doc
    marked = sealtestShellWith('spaces', doc).href
    await context.close()
  }

  /**
   * The whole walk on the marked space, sealed or not: boot, rename, navigate,
   * edit, ⌘S, wait out the autosave debounce, scan.
   */
  async function walk(sealed) {
    const o = await openSealed(browser, 'spaces', { sealed, doc: markedDoc })
    const { page, context, errors } = o
    await context.addInitScript(fsaMock)
    // reload() installs the key handoff again and re-proves the seal state
    await reloadRow(o, sealed ? 'sealed walk, first reload' : 'unsealed walk, first reload')
    await booted(page)
    const r = { sealedAfterGoto: await sealedNow(page), errors }
    r.titleBoot = await page.title()
    await rename(page, MARK + ' renamed')
    r.titleRename = await page.title()
    r.navigated = await navigate(page)
    r.titleNav = await page.title()
    await page.keyboard.press('ControlOrMeta+s')
    await page.waitForFunction(() => window.__written.length > 0, null, { timeout: 10000 }).catch(() => {})
    // a further edit after the save, then past the 2.5s autosave debounce
    await rename(page, MARK + ' after save')
    await page.waitForTimeout(4000)
    r.titleLater = await page.title()
    r.written = await page.evaluate(() => window.__written.slice(-1)[0] ?? '')
    r.idb = await stores(page)
    r.saved = sealed ? await savedFile(page) : null
    // what a save would write now (the probe sealed; the app's own serializer unsealed)
    r.serialized = sealed ? r.saved.file : await page.evaluate(() => window.bento.serializeAuto())
    // read back across a reload, keyed by docId: a stored snapshot, a banner
    await reloadRow(o, sealed ? 'sealed walk, reload after the edits' : 'unsealed walk, reload after the edits')
    await page.waitForSelector('.sp-banner', { timeout: 5000 }).catch(() => {})
    r.banner = await page.locator('.sp-banner').count()
    r.snapshot = await page.evaluate(([name, id]) => new Promise((res) => {
      const o = indexedDB.open(name)
      o.onsuccess = () => {
        const db = o.result
        if (!db.objectStoreNames.contains('recovery')) { db.close(); res(null); return }
        const g = db.transaction('recovery', 'readonly').objectStore('recovery').get(id)
        g.onsuccess = () => { db.close(); res(g.result ?? null) }
        g.onerror = () => { db.close(); res(null) }
      }
      o.onerror = () => res(null)
    }), [DB, markedDoc.docId])
    await finish(o, sealed ? 'sealed walk' : 'unsealed walk')
    return r
  }

  console.log('\nidentity-sealed space')
  const s = await walk(true)
  ok(s.sealedAfterGoto, 'the marked space booted sealed (the probe says sealed after the navigation)')
  ok(s.idb.length === 0, `NO IndexedDB store holds the marker (${s.idb.join(', ') || 'none'})`)
  ok(!s.idb.includes(`${DB}/recovery`), 'no recovery snapshot (the autosave guard)')
  ok(!s.idb.includes(`${DB}/versions`), 'no version (the save-path and throttled guards)')
  ok(s.written.length > 0, `⌘S wrote the file (${s.written.length} bytes)`)
  ok(/"kdf":"hkdf-kdoc"/.test(s.written), 'the written body is an identity-sealed envelope')
  ok(!s.written.includes('data-bento-preview'), 'the written file carries no first-page preview')
  ok(!s.written.includes(MARK), 'the marker appears nowhere in the written file outside the envelope')
  ok(!s.serialized.includes('data-bento-preview') && !s.serialized.includes(MARK), 'the kernel probe\'s serialized save agrees: no preview, no marker')
  const fileTitle = (s.written.match(/<title>([^<]*)<\/title>/) || [])[1]
  ok(fileTitle === NEUTRAL, `the saved file's <title> is "${NEUTRAL}" (${fileTitle})`)
  ok(s.titleBoot === NEUTRAL, `tab title at boot is neutral (${s.titleBoot})`)
  ok(s.titleRename === NEUTRAL, `tab title after a rename is neutral (${s.titleRename})`)
  ok(s.navigated, 'page navigation happened')
  ok(s.titleNav === NEUTRAL, `tab title after page navigation is neutral (${s.titleNav})`)
  ok(s.titleLater === NEUTRAL, `tab title after the save and later edits is neutral (${s.titleLater})`)
  ok(s.snapshot === null, 'after reload: no recovery snapshot stored for this docId')
  ok(s.banner === 0, 'after reload: no recovery banner')
  ok(s.errors.length === 0, `no page errors${s.errors.length ? ': ' + s.errors[0] : ''}`)

  console.log('\nunsealed control (same shell, same steps, no key handed over)')
  const c = await walk(false)
  ok(!c.sealedAfterGoto, 'not sealed')
  ok(c.idb.includes(`${DB}/recovery`), `control: the recovery store DOES hold the marker (${c.idb.join(', ') || 'none'})`)
  ok(c.idb.includes(`${DB}/versions`), 'control: the versions store DOES hold the marker')
  ok(c.written.includes('data-bento-preview') && c.written.includes(MARK), 'control: the written file DOES carry a preview and the marker')
  ok(c.titleBoot === `${MARK} — ${NEUTRAL}`, `control: tab title at boot shows the document title (${c.titleBoot})`)
  ok(c.titleRename === `${MARK} renamed — ${NEUTRAL}`, `control: tab title after a rename shows it (${c.titleRename})`)
  ok(c.titleNav.startsWith(MARK), `control: and after page navigation (${c.titleNav})`)
  ok(!!c.snapshot && JSON.stringify(c.snapshot).includes(MARK), 'control: after reload, a recovery snapshot IS stored for this docId')
  ok(c.banner > 0, 'control: after reload, the recovery banner IS shown')
  ok(c.serialized.includes('data-bento-preview') && c.serialized.includes(MARK), 'control: a serialized save DOES carry a preview and the marker')
  const cFileTitle = (c.written.match(/<title>([^<]*)<\/title>/) || [])[1] ?? ''
  ok(cFileTitle.includes(MARK), `control: the saved file's <title> DOES carry the document title (${cFileTitle})`)
  ok(c.titleLater.startsWith(MARK), `control: and after the save and later edits (${c.titleLater})`)

  console.log('\nsealed: the identity-sealed file reopened, at its gate')
  {
    const file = join(dir, 'identity-sealed.bento.html')
    writeFileSync(file, s.written)
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.route(/^https?:/, (route) => route.abort())
    const page = await context.newPage()
    await page.goto(pathToFileURL(file).href)
    await page.waitForSelector('.sp-gate', { timeout: 30000 }).catch(() => {})
    ok(await page.locator('.sp-gate').count() > 0, 'it opens at a gate (this build holds no key for it)')
    const tt = await page.title()
    ok(tt === NEUTRAL, `tab title at the gate is neutral (${tt})`)
    await context.close()
  }
  {
    const file = join(dir, 'unsealed.bento.html')
    writeFileSync(file, c.written)
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.route(/^https?:/, (route) => route.abort())
    const page = await context.newPage()
    await page.goto(pathToFileURL(file).href)
    await booted(page)
    ok(await page.locator('.sp-gate').count() === 0, 'control: the unsealed file reopened opens with no gate')
    const tt = await page.title()
    ok(tt.startsWith(MARK), `control: and its tab title DOES show the document title (${tt})`)
    await context.close()
  }

  console.log('\npassword space: gate, unlock, rename, navigate')
  {
    // make it through the real UI on the unsealed marked space
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.route(/^https?:/, (route) => route.abort())
    let page = await context.newPage()
    await page.goto(marked)
    await booted(page)
    const tBefore = await page.title()
    ok(tBefore.startsWith(MARK), `control: before the password is set, the tab title DOES show the document title (${tBefore})`)
    await page.locator('.sp-savemenu').click()
    await page.getByText('Encrypt with password…', { exact: true }).click()
    const pw = page.locator('input[type=password]')
    await pw.nth(0).fill(PASS)
    await pw.nth(1).fill(PASS)
    await pw.nth(1).press('Enter')
    await page.waitForFunction(() => document.querySelectorAll('input[type=password]').length === 0)
    const tSet = await page.title()
    ok(tSet === NEUTRAL, `tab title turns neutral once the password is set (${tSet})`)
    const html = await page.evaluate(() => window.bento.serializeAuto())
    await page.close()
    const file = join(dir, 'password.bento.html')
    writeFileSync(file, html)

    page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(pathToFileURL(file).href)
    await page.waitForSelector('.sp-gate input[type=password]', { timeout: 30000 })
    const tGate = await page.title()
    ok(tGate === NEUTRAL, `tab title at the password gate is neutral (${tGate})`)
    await page.locator('.sp-gate input[type=password]').fill(PASS)
    await page.locator('.sp-gate input[type=password]').press('Enter')
    await booted(page)
    const tUnlock = await page.title()
    ok(tUnlock === NEUTRAL, `tab title after unlock is neutral (${tUnlock})`)
    await rename(page, MARK + ' renamed')
    const tRename = await page.title()
    ok(tRename === NEUTRAL, `tab title after a rename is neutral (${tRename})`)
    ok(await navigate(page), 'page navigation happened')
    const tNav = await page.title()
    ok(tNav === NEUTRAL, `tab title after page navigation is neutral (${tNav})`)
    await page.waitForTimeout(4000)
    const idb = await stores(page)
    ok(idb.length === 0, `NO IndexedDB store holds the marker (${idb.join(', ') || 'none'})`)
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
    await context.close()
  }
  {
    // the control for every password row: the same space with no password
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.route(/^https?:/, (route) => route.abort())
    const page = await context.newPage()
    await page.goto(marked)
    await booted(page)
    ok(await page.locator('.sp-gate').count() === 0, 'control: with no password there is no gate')
    const tOpen = await page.title()
    ok(tOpen.startsWith(MARK), `control: the tab title on open DOES show the document title (${tOpen})`)
    await rename(page, MARK + ' renamed')
    const tRename = await page.title()
    ok(tRename.startsWith(MARK), `control: after a rename it DOES (${tRename})`)
    await navigate(page)
    const tNav = await page.title()
    ok(tNav.startsWith(MARK), `control: after page navigation it DOES (${tNav})`)
    await page.waitForTimeout(4000)
    const idb = await stores(page)
    ok(idb.length > 0, `control: IndexedDB DOES hold the marker (${idb.join(', ')})`)
    await context.close()
  }

  /** The marked space under a host that refuses the recovery copy. */
  async function hosted(sealed) {
    const o = await openSealed(browser, 'spaces', { sealed, doc: markedDoc })
    const { page, context } = o
    await context.addInitScript(refusingHost)
    await reloadRow(o, sealed ? 'sealed, hosted, reload' : 'unsealed, hosted, reload')
    await booted(page)
    const sealedAfter = await sealedNow(page)
    await rename(page, MARK + ' hosted')
    await page.waitForTimeout(3500)
    await rename(page, MARK + ' hosted again')
    await page.waitForTimeout(3500)
    const r = await page.evaluate((n) => ({ sets: window.__sets, notices: window.__notices.filter((x) => x.startsWith(n)).length }), NOTICE)
    await finish(o, sealed ? 'sealed, hosted' : 'unsealed, hosted')
    return { sealedAfter, ...r }
  }

  console.log('\nrecovery-off notice under a refusing host')
  {
    const h = await hosted(true)
    ok(h.sealedAfter, 'sealed')
    ok(h.sets === 0, `sealed: the host was never asked for a recovery copy (${h.sets})`)
    ok(h.notices === 0, `sealed: no recovery-off notice (${h.notices})`)
    const hc = await hosted(false)
    ok(hc.sets >= 1 && hc.notices === 1, `control: unsealed, the host refused a copy and the notice showed once (${hc.sets} asked, ${hc.notices} shown)`)
  }

  console.log('\nplaintext an unsealed session left behind, then a sealed boot on the same storage')
  {
    const MX = MARK + 'X', MY = MARK + 'Y'
    const docOf = (id, title) => ({ ...structuredClone(markedDoc), docId: id, title })
    /** an unsealed session on `context` that edits, so a snapshot and a version land */
    async function leave(context, doc, edit) {
      const o = await openSealed(browser, 'spaces', { sealed: false, doc, context })
      await booted(o.page)
      await rename(o.page, edit)
      await o.page.waitForTimeout(4000)
      await o.page.close()
      return o
    }
    async function bannerAndHistory(page) {
      await page.waitForSelector('.sp-banner', { timeout: 4000 }).catch(() => {})
      const banner = await page.locator('.sp-banner').count()
      await page.locator('.sp-savemenu').click()
      await page.getByText('Version history…', { exact: true }).click()
      await page.waitForTimeout(800)
      const versions = await page.locator('.sp-ab-version').count()
      return { banner, versions }
    }

    // control: an unsealed reboot of X on the same storage IS offered the copy
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      await context.route(/^https?:/, (route) => route.abort())
      const x = await leave(context, docOf('rig-left-x', MX), MX + ' edited')
      const again = await openSealed(browser, 'spaces', { sealed: false, context, url: x.url })
      await booted(again.page)
      const r = await bannerAndHistory(again.page)
      ok(r.banner > 0, `control: an UNSEALED reboot of X on the same storage IS offered the banner (${r.banner})`)
      ok(r.versions > 0, `control: and its version history DOES list X's versions (${r.versions})`)
      await finish(again, 'unsealed reboot of X')
    }

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.route(/^https?:/, (route) => route.abort())
    const x = await leave(context, docOf('rig-left-x', MX), MX + ' edited')
    await leave(context, docOf('rig-left-y', MY), MY + ' edited')
    {
      const probe = await context.newPage()
      await probe.goto(x.url)
      await booted(probe)
      const before = await scanIndexedDB(probe, MX)
      ok(before.includes(`${DB}/recovery`) && before.includes(`${DB}/versions`),
        `precondition: the unsealed session left X's snapshot and a version (${before.join(', ')})`)
      await probe.close()
    }
    const sealedX = await openSealed(browser, 'spaces', { context, url: x.url })
    await booted(sealedX.page)
    const r = await bannerAndHistory(sealedX.page)
    ok(r.banner === 0, `a SEALED boot of X on the same storage offers NO banner (${r.banner})`)
    ok(r.versions === 0, `and its version history shows NOTHING (${r.versions})`)
    await sealedX.page.waitForTimeout(500)
    const leftX = await scanIndexedDB(sealedX.page, MX)
    ok(leftX.length === 0, `afterwards NO IndexedDB store holds X's plaintext (${leftX.join(', ') || 'none'})`)
    const leftY = await scanIndexedDB(sealedX.page, MY)
    ok(leftY.includes(`${DB}/recovery`) && leftY.includes(`${DB}/versions`),
      `a SECOND document's (Y) snapshot and version survive the sealed boot of X (${leftY.join(', ') || 'none'})`)
    await finish(sealedX, 'sealed boot of X')
  }
} finally {
  await browser.close()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
