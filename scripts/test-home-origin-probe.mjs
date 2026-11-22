#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/home origin probe — runs home/ios/OriginProbe.js ITSELF against real
 * IndexedDB and localStorage, in WebKit (the engine it runs in on iOS).
 *
 *   PLAYWRIGHT_MODULE=…/playwright/index.mjs node scripts/test-home-origin-probe.mjs
 *   BENTO_BROWSER=chromium …   to run it in Chromium instead
 *
 * WHY. Before a file opened for the first time adopts the storage origin it had
 * before origins followed the file, the host asks this probe whose data that
 * origin holds, and adopts only if every record is the file's own. The first
 * version looked only in the old shared 'bento-autosave' database, while every
 * app writes to `${appId}-autosave` since the per-app split. Against a real
 * edited deck it reported nothing, and "nothing" means adopt. The Swift rule
 * (scripts/test-home-origin.mjs) was right and tested on supplied sets; this
 * tests the half that actually looks, with storage laid out the way the kernel
 * lays it out (kernel/src/autosave.ts, save.ts, sync/blobs.ts).
 */
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROBE = readFileSync(process.env.ORIGIN_PROBE || join(ROOT, 'home/ios/OriginProbe.js'), 'utf8')
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const engine = pw[process.env.BENTO_BROWSER || 'webkit']
// a dead browser or a call that never returns fails loudly, never as a row (scripts/lib/browser-guard.mjs)
const { guardBrowser, apiLogger } = await import(join(ROOT, 'scripts/lib/browser-guard.mjs'))
const browser = await engine.launch({ logger: apiLogger })
const guard = guardBrowser(browser, { rig: `origin probe (${process.env.BENTO_BROWSER || 'webkit'})`, stallMs: 120000 })
guard.section('origin probe')

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); guard.progress(m) }

const A = '7025b63c-1111-4222-8333-944455556666', B = '11111111-2222-4333-8444-555566667777'
// Storage exactly as the kernel lays it out.
const SEED = {
  autosave: (name, docId) => `await new Promise((res, rej) => { const q = indexedDB.open(${JSON.stringify(name)}, 1)
    q.onupgradeneeded = () => { const db = q.result; db.createObjectStore('recovery', { keyPath: 'docId' })
      const v = db.createObjectStore('versions', { keyPath: 'id', autoIncrement: true }); v.createIndex('docId', 'docId', { unique: false }) }
    q.onsuccess = () => { const db = q.result, t = db.transaction(['recovery', 'versions'], 'readwrite')
      t.objectStore('recovery').put({ docId: ${JSON.stringify(docId)}, at: 1, title: 'plaintext', json: '{}' })
      t.objectStore('versions').put({ docId: ${JSON.stringify(docId)}, at: 1, json: '{}' })
      t.oncomplete = () => { db.close(); res() }; t.onerror = () => rej(t.error) }; q.onerror = () => rej(q.error) })`,
  versionsOnly: (name, docId) => `await new Promise((res) => { const q = indexedDB.open(${JSON.stringify(name)}, 1)
    q.onupgradeneeded = () => { const db = q.result; db.createObjectStore('recovery', { keyPath: 'docId' })
      const v = db.createObjectStore('versions', { keyPath: 'id', autoIncrement: true }); v.createIndex('docId', 'docId', { unique: false }) }
    q.onsuccess = () => { const db = q.result, t = db.transaction('versions', 'readwrite'); t.objectStore('versions').put({ docId: ${JSON.stringify(docId)}, at: 1, json: '{}' }); t.oncomplete = () => { db.close(); res() } } })`,
  keyed: (name, store, key, empty = false) => `await new Promise((res) => { const q = indexedDB.open(${JSON.stringify(name)}, 1)
    q.onupgradeneeded = () => { q.result.createObjectStore(${JSON.stringify(store)}) }
    q.onsuccess = () => { const db = q.result; if (${empty}) { db.close(); return res() }
      const t = db.transaction(${JSON.stringify(store)}, 'readwrite'); t.objectStore(${JSON.stringify(store)}).put({ x: 1 }, ${JSON.stringify(key)}); t.oncomplete = () => { db.close(); res() } } })`,
  member: (docId) => `localStorage.setItem('bento-member-${docId}', JSON.stringify({ pub: 'P', priv: 'S' }))`,
  pref: () => `localStorage.setItem('bento-lang', 'fr'); localStorage.setItem('bento-author', 'me')`,
}

let n = 0
async function probe(seeds, { noDatabases = false } = {}) {
  const host = `case${++n}.test`
  const ctx = await browser.newContext()
  await ctx.route('**/*', (r) => r.fulfill({ contentType: 'text/html', body: r.request().url().endsWith('/probe')
    ? `<!doctype html><script>${noDatabases ? 'try { delete IDBFactory.prototype.databases } catch (e) {}; indexedDB.databases = undefined;' : ''}
       window.webkit = { messageHandlers: { bentoOriginProbe: { postMessage: (v) => { window.__result = v } } } }</script><script>${PROBE}</script>`
    : '<!doctype html><title>seed</title>' }))
  const page = await ctx.newPage()
  await page.goto(`http://${host}/seed`)
  for (const s of seeds) await page.evaluate(`(async () => { ${s} })()`)
  await page.goto(`http://${host}/probe`)
  await page.waitForFunction(() => window.__result, null, { timeout: 10000 })
  const r = await page.evaluate(() => window.__result)
  const after = await page.evaluate(() => indexedDB.databases ? indexedDB.databases().then((d) => d.map((x) => x.name)) : null)
  await ctx.close()
  return { ids: new Set(r.ids), un: r.unattributable, after }
}

console.log(`origin probe, in ${process.env.BENTO_BROWSER || 'webkit'}:`)
{ const r = await probe([]); ok(r.ids.size === 0 && r.un === false, 'an empty origin: nothing stored, attributable — the host adopts')
  ok(Array.isArray(r.after) && r.after.length === 0, 'probing an empty origin CREATES nothing (no database planted for the editor to trip on)') }
for (const app of ['bento-slides', 'bento-spaces', 'bento-dash', 'bento-type']) {
  const r = await probe([SEED.autosave(`${app}-autosave`, A)])
  ok(r.ids.has(A) && r.ids.size === 1 && r.un === false, `${app}-autosave: the recovery copy is attributed to its docId`)
}
{ const r = await probe([SEED.autosave('bento-autosave', A)]); ok(r.ids.has(A) && !r.un, 'the old shared bento-autosave is read too') }
{ const r = await probe([SEED.versionsOnly('bento-slides-autosave', B)]); ok(r.ids.has(B) && !r.un, 'version history alone (no recovery) is attributed through its docId index') }
{ const r = await probe([SEED.autosave('bento-slides-autosave', A), SEED.autosave('bento-type-autosave', B)]); ok(r.ids.has(A) && r.ids.has(B), "two apps' data at one origin: both docIds reported") }
{ const r = await probe([SEED.member(A)]); ok(r.ids.has(A) && !r.un, 'a member key in localStorage is attributed to its docId') }
{ const r = await probe([SEED.pref()]); ok(r.ids.size === 0 && !r.un, "viewer preferences in localStorage don't count as anyone's data") }
{ const r = await probe([SEED.keyed('bento-handles', 'handles', `${A}\u001fDeck.bento.html`)]); ok(r.ids.has(A) && !r.un, 'a saved file handle is attributed by its docId prefix') }
{ const r = await probe([SEED.keyed('bento-handles', 'handles', 'no-separator')]); ok(r.un === true, 'a handle key without a docId is unattributable') }
{ const r = await probe([SEED.keyed('bento-blobcache', 'blobs', 'sha256-abc')]); ok(r.un === true, 'a blob cache (content-addressed, no docId) is unattributable — the host refuses') }
{ const r = await probe([SEED.keyed('something-else', 's', 'k')]); ok(r.un === true, 'an unknown database holding records is unattributable — the host refuses') }
{ const r = await probe([SEED.keyed('something-empty', 's', 'k', true)]); ok(r.un === false, 'an unknown database holding nothing does not refuse') }
{ const r = await probe([SEED.autosave('bento-slides-autosave', A)], { noDatabases: true }); ok(r.un === true, "no indexedDB.databases(): 'couldn't look' reports unattributable, never empty") }

// The real thing: the slides shell boots, is edited, and ITS kernel autosaves.
// Then the probe runs at that origin. Needs a built shell (slides/dist-single,
// or ORIGIN_PROBE_SHELL); without one this case is reported as skipped.
{
  const { existsSync } = await import('node:fs')
  const shell = process.env.ORIGIN_PROBE_SHELL || join(ROOT, 'slides/dist-single/Bento_Slides.bento.html')
  if (!existsSync(shell)) {
    console.log('  skip  no built slides shell — the real-deck case did not run (npm run build:single --prefix slides)')
  } else {
    const html = readFileSync(shell, 'utf8')
    const ctx = await browser.newContext()
    await ctx.route('**/*', (r) => r.fulfill({ contentType: 'text/html', body: r.request().url().endsWith('/probe')
      ? `<!doctype html><script>window.webkit = { messageHandlers: { bentoOriginProbe: { postMessage: (v) => { window.__result = v } } } }</script><script>${PROBE}</script>`
      : html }))
    const page = await ctx.newPage()
    await page.goto('http://realdeck.test/deck.bento.html')
    await page.waitForFunction(() => window.bento && window.bento.doc && window.bento.loadDoc, null, { timeout: 30000 })
    const docId = await page.evaluate(async () => {
      const d = structuredClone(window.bento.doc); d.title = 'An edit the autosave must keep'
      // loadDoc takes the document as a JSON STRING; an object is refused (false)
      if (!window.bento.loadDoc(JSON.stringify(d))) throw new Error('loadDoc refused the edit')
      return window.bento.doc.docId
    })
    // The database exists from boot; the copy lands after the 2.5s debounce.
    // Wait for the RECORD, not the database, or the probe runs on empty stores.
    // An explicit loop that awaits a real boolean: a predicate that RETURNS a
    // promise is just truthy to waitForFunction, which then passes at once.
    const hasRecord = (id) => page.evaluate((id) => new Promise((res) => {
      const q = indexedDB.open('bento-slides-autosave')
      q.onupgradeneeded = () => { q.transaction.abort(); res(false) }
      q.onerror = () => res(false)
      q.onsuccess = () => { const db = q.result
        if (!db.objectStoreNames.contains('recovery')) { db.close(); return res(false) }
        const g = db.transaction('recovery').objectStore('recovery').getKey(id)
        g.onsuccess = () => { db.close(); res(g.result === id) }; g.onerror = () => { db.close(); res(false) } }
    }), id)
    let saved = false
    for (let i = 0; i < 40 && !(saved = await hasRecord(docId)); i++) await page.waitForTimeout(500)
    ok(saved, "the real deck's own autosave wrote its recovery copy (the case below tests something)")
    // The host probes BEFORE the document loads, in a web view nothing else is
    // using. Close the deck first: a page kept alive in the back-forward cache
    // still holds its database connections, and WebKit then refuses the probe's
    // cursors ("Unable to open cursor"). That refusal is safe (it reads as
    // unattributable), but it isn't the host's situation.
    await page.close()
    const probePage = await ctx.newPage()
    await probePage.goto('http://realdeck.test/probe')
    await probePage.waitForFunction(() => window.__result, null, { timeout: 10000 })
    const r = await probePage.evaluate(() => window.__result)
    if (!r.ids.includes(docId)) console.log('     probe said:', JSON.stringify(r), 'wanted', docId, 'databases:', JSON.stringify(await probePage.evaluate(() => indexedDB.databases())))
    ok(r.ids.includes(docId), `a REAL edited deck's autosave (docId ${String(docId).slice(0, 8)}…) is found by the probe — the host would refuse a successor`)
    await ctx.close()
  }
}

await guard.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
