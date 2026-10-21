// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE SEALED TEST DOCUMENT, end to end on a real built shell (security §31).
// Proves the shared helper (scripts/lib/sealed-boot.mjs) and the KERNEL's sinks
// against slides' build:sealtest shell:
//   - the seal is in place before the app's boot, and the handoff is consumed;
//   - a save writes an identity-sealed v1 envelope, a neutral <title>, a neutral
//     filename, no preview, and neither the title nor the content anywhere;
//   - the unsealed control writes the title, so these checks can see a leak.
// It also MEASURES what reaches IndexedDB after an edit, sealed and unsealed.
// That's each app's guard, switched in its own PR, so it is reported here and
// asserted there.
//
//   npm run build:sealtest --prefix slides && node scripts/test-sealed-boot.mjs

import { openSealed, savedFile, scanIndexedDB, storeRefusals } from './lib/sealed-boot.mjs'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const MARK = 'ZZSEALEDMARK' + Date.now()
let failures = 0, checks = 0
const ok = (cond, what) => { checks++; if (cond) console.log('  ok    ' + what); else { failures++; console.log('  FAIL  ' + what) } }

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })

/** Give the live document a marked title and slide text, as an edit would. */
async function markDocument(page) {
  await page.evaluate((m) => {
    const d = structuredClone(window.bento.doc)
    d.title = m
    const el = d.slides?.[0]?.elements?.find((e) => e.type === 'text')
    if (el) el.html = `<p>${m}</p>`
    window.bento.loadDoc(JSON.stringify(d))
  }, MARK)
  await page.waitForTimeout(4000) // past the 2.5s autosave debounce
}

try {
  console.log('\nsealed')
  {
    const { page, context, errors } = await openSealed(browser, 'slides')
    ok(true, 'the seal took before boot: probe sealed, a save would write kdf hkdf-kdoc v1 (openSealed asserts these)')
    await markDocument(page)
    const { file, fileName, body } = await savedFile(page)
    const env = JSON.parse(body)
    ok(env.format === 'bento/enc' && env.v === 1 && env.kdf === 'hkdf-kdoc' && !!env.salt && !!env.iv && !!env.data, 'the saved body is an identity-sealed v1 envelope')
    ok(!file.includes(MARK), 'the saved FILE carries neither the title nor the content, anywhere')
    ok(/<title>[^<]*<\/title>/.test(file) && !/<title>[^<]*ZZSEALED/.test(file), 'the <title> is neutral')
    ok(!file.includes('data-bento-preview'), 'no first-page preview')
    ok(!fileName.includes(MARK), `the filename is neutral, not the title (${fileName})`)
    const idb = await scanIndexedDB(page, MARK)
    ok(idb.length === 0, `no plaintext in IndexedDB after a sealed edit (${idb.join(', ') || 'none'}): the app's guard, or the kernel store's backstop`)
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`)
    await context.close()
  }

  console.log('\nthe backstop is visible to the rigs: an app leaning on it fails close()')
  {
    // Which branch runs depends on the app's guards: today slides' are not yet
    // switched, so its sealed edit reaches the store and is REFUSED there. Once
    // its guards switch, nothing reaches the store. Either way close() must agree
    // with the counter: that is what keeps each app's guard mutants red.
    const s = await openSealed(browser, 'slides')
    await markDocument(s.page)
    const n = await storeRefusals(s.page)
    const threw = await s.close().then(() => null, (e) => e.message)
    console.log(`  info  the kernel store refused ${n} plaintext call(s) on a sealed slides edit`)
    ok(n > 0 ? /leaned on the kernel store's backstop/.test(threw ?? '') : threw === null,
      n > 0 ? 'refusals > 0, so close() throws: the missing guard fails the rig' : 'no refusals, so close() passes')
    const t = await openSealed(browser, 'slides', { allowStoreRefusals: true })
    await markDocument(t.page)
    ok(await t.close().then(() => true, () => false), 'with { allowStoreRefusals: true }, close() does not throw')
  }

  console.log('\na fixed document, across a reload (for recovery rows keyed by docId)')
  {
    const base = await openSealed(browser, 'slides', { sealed: false })
    const doc = await base.page.evaluate((m) => ({ ...structuredClone(window.bento.doc), title: m }), MARK)
    await base.context.close()
    // allowStoreRefusals: this row tests the helper's fixed-document mechanics,
    // not slides' guards (its own rig asserts those)
    const { page, context, reload } = await openSealed(browser, 'slides', { doc, allowStoreRefusals: true })
    const first = await page.evaluate(() => ({ id: window.bento.doc.docId, title: window.bento.doc.title }))
    ok(first.id === doc.docId && first.title === MARK, 'the fixed document booted, sealed, with its own docId')
    await reload() // re-installs the handoff and re-proves the seal, or throws
    const again = await page.evaluate(() => window.bento.doc.docId)
    ok(again === doc.docId, 'after reload(): the same docId, and the seal proven again')
    await context.close()
  }

  console.log('\nboth seal states on ONE storage (a sealed boot after an unsealed session)')
  {
    const plain = await openSealed(browser, 'slides', { sealed: false })
    await markDocument(plain.page)
    ok((await scanIndexedDB(plain.page, MARK)).length > 0, 'the unsealed session leaves the marker in IndexedDB')
    const docId = await plain.page.evaluate(() => window.bento.doc.docId)
    const sealedPage = await openSealed(browser, 'slides', { context: plain.context, url: plain.url, allowStoreRefusals: true })
    ok((await scanIndexedDB(sealedPage.page, MARK)).length > 0, 'a sealed page on the same context sees the same storage')
    ok(await sealedPage.page.evaluate(() => !!globalThis.__bentoTestSealProbe), 'and it is sealed (the handoff is per page)')
    await plain.reload()
    ok(await plain.page.evaluate(() => !('__bentoTestSealProbe' in globalThis)), 'the unsealed page reloads unsealed: no page inherits a key')
    ok(typeof docId === 'string', 'control: the session had a docId')
    await plain.context.close()
  }

  console.log('\nunsealed control (same test shell, no key handed over)')
  {
    const { page, context } = await openSealed(browser, 'slides', { sealed: false })
    ok(await page.evaluate(() => !('__bentoTestSealProbe' in globalThis)), 'no seal without the handoff')
    await markDocument(page)
    const file = await page.evaluate(() => window.bento.serialize())
    ok(file.includes(MARK), 'control: the unsealed file DOES carry the marker, so the file checks can see a leak')
    const idb = await scanIndexedDB(page, MARK)
    ok(idb.length > 0, `control: the unsealed edit DOES reach IndexedDB (${idb.join(', ') || 'none'}), so the scan can see a leak`)
    await context.close()
  }
} finally {
  await browser.close()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
