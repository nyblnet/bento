// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A SEALED dash workbook writes no plaintext of itself anywhere this page can
// reach, and shows the neutral title while sealed, matching the saved file's
// title.
//
//   npm run build:sealtest --prefix dash && node scripts/test-dash-sealed-browser.mjs
//
// Uses the shared sealed TEST document (scripts/lib/sealed-boot.mjs): the
// identity seal is installed before dash's own boot and PROVEN before any row
// runs. Every guard dash keeps against plaintext asks `isBodySealed()` — true
// for a password OR the identity seal — and each row has an UNSEALED control
// that must show the very leak the sealed run must not, so a row can never pass
// because the path under it never ran.
//
//   1. recovery snapshot + version timeline   (main.ts autosave, about.ts)
//   2. the saved file: no marker anywhere — no preview (preview.ts), and the
//      shell title is neutral
//   3. the tab title (main.ts boot and the title field)
//   4. reading a plaintext recovery snapshot back (recovery.ts)
//   5. drop-open: a sealed window refuses to adopt a dropped workbook (dropopen.ts)
//
// Every SEALED page ends through the helper's close() (and would reload through
// its reload()), never context.close(): those throw when the kernel store had to
// refuse a plaintext read or write. The store refuses as a BACKSTOP, so without
// this a reverted dash guard would be masked by it and every row would stay
// green. A throw is scored as a failed check, so the summary line still prints.
import { readFileSync } from 'node:fs'
import { openSealed, savedFile, scanIndexedDB, sealtestShell } from './lib/sealed-boot.mjs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const MARKER = 'SEALRIG-7f3a91'
const APP = 'bento/dash'
const settle = (page) => page.waitForTimeout(3600) // autosave debounce is 2.5s

// End a sealed page through the helper. Its close() throws when dash leaned on
// the kernel store's backstop; that is a missing dash guard, so it is a FAIL.
async function closeSealed(opened, what) {
  let err = null
  try { await opened.close() } catch (e) { err = e }
  ok(!err, `SEALED ${what}: the kernel store refused no plaintext read or write${err ? ' — ' + err.message : ''}`)
}

async function retitle(page, text) {
  await page.locator('.dx-title').fill(text)
  await page.locator('.dx-title').dispatchEvent('input')
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  // ---- rows 1–3 on the shared test document, sealed and unsealed
  for (const sealed of [true, false]) {
    console.log(`\n${sealed ? 'SEALED' : 'unsealed control'}`)
    const opened = await openSealed(browser, 'dash', { sealed })
    const { page, errors } = opened
    const t0 = await page.evaluate(() => [document.title, window.bento.doc.title])
    if (sealed) ok(t0[0] === APP, `at boot the tab says only "${APP}" — got "${t0[0]}"`)
    else ok(t0[0] !== APP && t0[0].includes(t0[1]), `CONTROL: unsealed, the tab shows the workbook title at boot — "${t0[0]}"`)
    await retitle(page, MARKER)
    // and in a CELL, through the grid, so the preview (which draws cells) has it too
    await page.locator('.dg-cell').nth(12).click()
    await page.keyboard.type(MARKER + '-cell')
    await page.keyboard.press('Enter')
    await settle(page)
    const hits = await scanIndexedDB(page, MARKER)
    const inRecovery = hits.filter((h) => h.endsWith('/recovery')), inVersions = hits.filter((h) => h.endsWith('/versions'))
    if (sealed) {
      ok(inRecovery.length === 0, `no plaintext RECOVERY snapshot (${inRecovery.join(', ') || 'none'})`)
      ok(inVersions.length === 0, `no plaintext VERSION in the timeline (${inVersions.join(', ') || 'none'})`)
      ok(hits.length === 0, `nothing else in IndexedDB carries it either (${hits.join(', ') || 'none'})`)
    } else {
      ok(inRecovery.length >= 1, `CONTROL: unsealed, a recovery snapshot DOES carry the marker (${inRecovery.join(', ')})`)
      ok(inVersions.length >= 1, `CONTROL: unsealed, a version DOES carry the marker (${inVersions.join(', ')})`)
    }
    const title = await page.evaluate(() => document.title)
    if (sealed) ok(title === APP, `after a rename the tab still says only "${APP}" — got "${title}"`)
    else ok(title.includes(MARKER), `CONTROL: unsealed, the tab follows the rename — "${title}"`)
    if (sealed) {
      const f = await savedFile(page)
      ok(!f.file.includes(MARKER), 'the saved file carries the marker nowhere — not in the body, the preview or the <title>')
      ok(/<title>bento\/dash<\/title>/.test(f.file), 'and its <title> is the neutral app name')
      // the preview on its own. On the save path kernel's previewAllowed gate
      // runs FIRST and never calls dash's provider for a sealed body, so this
      // row sees the kernel layer, not dash's: disabling previewMarkup's own
      // isBodySealed() guard leaves it green. scripts/test-dash-preview.ts
      // drives previewMarkup directly and guards dash's layer.
      ok(!f.file.includes('data-bento-preview'), 'and it carries NO preview element at all')
    } else {
      const html = await page.evaluate(() => window.bento.serializeAuto())
      ok(html.includes(MARKER), 'CONTROL: unsealed, the saved file does carry it (preview, title, body)')
      const preview = (html.match(/<[^>]*data-bento-preview[\s\S]*?<script data-bento-preview/) || [''])[0]
      ok(preview.includes(MARKER + '-cell'), 'CONTROL: unsealed, the PREVIEW itself draws the marked cell — so the sealed row can see a preview leak')
    }
    ok(errors.length === 0, `no page errors${errors.length ? ' — ' + errors.join('; ') : ''}`)
    if (sealed) await closeSealed(opened, 'rows 1–3')
    else await opened.context.close()
  }

  // ---- row 5: drop-open
  const dropped = readFileSync(sealtestShell('dash'), 'utf8').replace(
    /(<script type="application\/bento\+json" id="bento-doc">)[\s\S]*?(<\/script>)/,
    (_, a, c) => a + JSON.stringify({ format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'dropped-1', title: 'Dropped workbook',
      sheets: [{ id: 's', kind: 'table', name: 'D', rids: [[1, 1]], nextRid: 2, columns: [{ id: 'v', name: 'V', type: 'number' }], data: { v: { enc: 'raw', v: [1] } }, steps: [] }] }).replace(/</g, '\\u003c') + c)
  for (const sealed of [true, false]) {
    const opened = await openSealed(browser, 'dash', { sealed })
    const { page } = opened
    page.on('dialog', (d) => d.accept())
    await page.evaluate((html) => {
      const dt = new DataTransfer()
      dt.items.add(new File([html], 'dropped.bento.html', { type: 'text/html' }))
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    }, dropped)
    await page.waitForTimeout(800)
    const title = await page.evaluate(() => window.bento.doc.title)
    const refused = await page.evaluate(() => document.body.innerText.includes('encrypted workbook open'))
    if (sealed) ok(refused && title !== 'Dropped workbook', `SEALED: a dropped workbook is refused, not adopted under this document's seal (title "${title}")`)
    else ok(!refused && title === 'Dropped workbook', `CONTROL: unsealed, the dropped workbook opens (title "${title}")`)
    if (sealed) await closeSealed(opened, 'drop-open')
    else await opened.context.close()
  }

  // ---- row 4: reading a plaintext snapshot back, and purging it. Both seal
  // states on ONE storage, through the shared helper: an unsealed session
  // leaves a genuine plaintext snapshot of a fixed document; reopening it
  // unsealed offers it (the control); opening the SAME document sealed, in the
  // same context, must neither offer it nor keep it, while a SECOND workbook's
  // snapshot on that storage survives. The scans run from an unsealed page.
  {
    const sheet = { id: 's', kind: 'table', name: 'D', rids: [[1, 1]], nextRid: 2, columns: [{ id: 'v', name: 'V', type: 'number' }], data: { v: { enc: 'raw', v: [1] } }, steps: [] }
    const fixed = (docId, title) => ({ format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId, title, sheets: [sheet] })
    const OTHER = 'OTHERWB-2c8d40' // must not contain MARKER: the scans match by substring
    const stores = (hits) => ['recovery', 'versions'].filter((s) => hits.some((h) => h.endsWith('/' + s)))
    const a = await openSealed(browser, 'dash', { sealed: false, doc: fixed('seal-rig-fixed', 'Fixed') })
    await retitle(a.page, MARKER)
    await settle(a.page)
    ok(stores(await scanIndexedDB(a.page, MARKER)).length === 2, 'CONTROL: an unsealed session leaves this workbook\'s plaintext in /recovery AND /versions')
    await a.reload()
    await a.page.waitForTimeout(600)
    ok(await a.page.locator('.dxr-bar').count() === 1, 'CONTROL: unsealed, reopening OFFERS it — the read-back path runs')
    await a.page.close()
    const c = await openSealed(browser, 'dash', { sealed: false, context: a.context, doc: fixed('seal-rig-other', 'Other') })
    await retitle(c.page, OTHER)
    await settle(c.page)
    ok(stores(await scanIndexedDB(c.page, OTHER)).length === 2, 'CONTROL: a second workbook\'s plaintext is in /recovery AND /versions on the same storage')
    const b = await openSealed(browser, 'dash', { context: a.context, url: a.url })
    await b.page.waitForTimeout(600)
    ok(await b.page.locator('.dxr-bar').count() === 0, 'SEALED: the same workbook on the same storage does NOT offer the plaintext snapshot')
    await closeSealed(b, 'read-back') // b shares a.context, so this closes only its page
    const left = stores(await scanIndexedDB(c.page, MARKER))
    ok(left.length === 0, `SEALED: after the sealed boot, none of this workbook's plaintext is kept (found in: ${left.join(', ') || 'nothing'})`)
    ok(stores(await scanIndexedDB(c.page, OTHER)).length === 2, 'the second workbook\'s snapshot and versions survive the purge')
    await a.context.close()
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
