#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The bento/home tripwire (home/webext/src/tripwire*.js) in a real browser:
 * the UNPACKED extension loaded into Chromium by Playwright, against a local
 * home/web build served on two sites (library on 127.0.0.1, frame page on
 * localhost), and a local release channel serving the signed release list.
 *
 *   PLAYWRIGHT_MODULE=…/playwright/index.mjs node scripts/test-webext-tripwire-browser.mjs
 *   TW_ROWS=library-byte,frame-csp …     only these rows (the mutant rig)
 *   TW_MUTANT='{"file":"src/tripwire-judge.js","from":"…","to":"…"}'   one source mutant (or an array of edits)
 *
 * Launches Playwright's own Chromium in new-headless mode (channel
 * 'chromium'), which loads extensions; the headless shell cannot. Every key
 * here is a throwaway made by the rig: the extension copy's tripwire-config.js
 * is replaced with the local origins, the local channel and the rig's key.
 * Sockets are closed (context.routeWebSocket); DNS resolves nothing but the
 * two local hosts.
 *
 * Release A is the home/web build as it is, its own service worker (/sw.js,
 * stage 3) included: every row starts as a first visit (no worker), the
 * library registers that worker on it, and the stage3-* rows run as a
 * returning visitor with it active and in control. A cache-first precache
 * worker is a FIXTURE for the older worker rows, listed in its own release (F)
 * and registered through a page with CSP bypassed; hostile workers are
 * fixtures too.
 *
 *   TW_BUILD_MUTANT='{"file":"sw.ts","from":"…","to":"…"}'   builds release A with a home/web source
 *   mutant (BENTO_HOME_WEB_MUTANT, --dev only), e.g. the worker without navigation preload
 *
 *   TW_H2=1 TW_ROWS=c5-honest-worker,c5-honest-soft-update   serves the library over HTTPS and
 *   HTTP/2 (a throwaway certificate made with openssl, trusted by its SPKI hash only), the shape
 *   home.bento.page has: the honest worker's request headers there are the ones the C5 hold is
 *   measured against (security's second review of #983, M5). Rows that open a deck need the
 *   http frame site, which an https library cannot frame: run the C5 rows only.
 *
 * Every row names the rule it guards; scripts/test-webext-tripwire-mutants.mjs
 * turns each rule off and requires that row to go red.
 */
import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, webcrypto } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import http2 from 'node:http2'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { freePorts, parseHeaders } = await import(path.join(ROOT, 'home/web/serve.mjs'))
const { spliceDoc } = await import(path.join(ROOT, 'home/web/src/verify.ts'))
const { describeBuild, nextServed, buildScriptTexts } = await import(path.join(ROOT, 'scripts/lib/home-web-served.mjs'))
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const chromium = pw.chromium ?? pw.default?.chromium

const ONLY = process.env.TW_ROWS ? new Set(process.env.TW_ROWS.split(',')) : null
const MUTANT = process.env.TW_MUTANT ? [JSON.parse(process.env.TW_MUTANT)].flat() : null
let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
const note = (m) => console.log(`  note  ${m}`)
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-tripwire-'))
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }))

// --- origins and builds -------------------------------------------------------
const [pl, pf, pr] = await freePorts(3)
const H2 = !!process.env.TW_H2
const LIB = `${H2 ? 'https' : 'http'}://127.0.0.1:${pl}`, FRM = `http://localhost:${pf}`, CHAN = `http://127.0.0.1:${pr}`
const LIST_PATH = '/releases/home-web/served.json'
const A = path.join(work, 'A')
const BUILD_MUTANT = process.env.TW_BUILD_MUTANT || null
execFileSync(process.execPath, [path.join(ROOT, 'home/web/build.mjs'), '--out', A, '--library-origin', LIB, '--frame-origin', FRM,
  '--release-base', `${CHAN}/releases/`, '--dev'], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, BENTO_HOME_WEB_MUTANT: BUILD_MUTANT ?? '' } })
const infoA = JSON.parse(fs.readFileSync(path.join(A, 'build.json'), 'utf8'))
if (BUILD_MUTANT) {
  if (!infoA.mutant) throw new Error('TW_BUILD_MUTANT was set but the build says it carries no mutant')
  console.log(`  mutant applied to the home/web build: ${infoA.mutant.slice(0, 70)}`)
}
if (JSON.stringify(infoA.serviceWorkers) !== '["/sw.js"]') throw new Error('the build no longer lists /sw.js as its worker')
// the build's own worker: release A serves it, and the stage3-* rows run with it in control
const BUILD_SW = fs.readFileSync(path.join(A, 'library/sw.js'))

// the fixture worker: precache the library page, answer every same-origin GET from the cache
const SW_HONEST = `// bento/home precache worker (rig fixture)
const C = 'bento-home-v1'
self.addEventListener('install', (e) => e.waitUntil(caches.open(C).then((c) => c.addAll(['/', '/index.html']))))
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url)
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return
  // only the two pages it precached: anything else (a favicon) is left to the page, as the build's worker
  // leaves it, so the fixture makes no request of its own the tripwire would flag (ruling #954 C5)
  if (u.pathname !== '/' && u.pathname !== '/index.html') return
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)))
})
`
// release F: release A with the fixture worker in place of the build's, for the rows that register it
const F = path.join(work, 'F')
fs.cpSync(A, F, { recursive: true })
fs.writeFileSync(path.join(F, 'library/sw.js'), SW_HONEST)

// release B: the same build with different words on the page (a later release)
const B = path.join(work, 'B')
fs.cpSync(A, B, { recursive: true })
const libA = fs.readFileSync(path.join(A, 'library/index.html'), 'utf8')
const LEDE = 'Open a Bento document to view or present it.'
if (libA.split(LEDE).length !== 2) throw new Error('the library page no longer carries the lede this rig edits')
fs.writeFileSync(path.join(B, 'library/index.html'), libA.replace(LEDE, 'Open a Bento document to view or to present it.'))

// release P: release A with a worker that answers navigations from navigation preload (the shape stage 3
// takes, security ruling #954 C1), so webRequest sees the navigation even though the worker answers it
const SW_PRELOAD = SW_HONEST.replace("self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))",
  "self.addEventListener('activate', (e) => e.waitUntil(Promise.all([self.clients.claim(), self.registration.navigationPreload.enable()])))")
  .replace("  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)))",
  `  if (e.request.mode === 'navigate') {
    e.respondWith((async () => { try { const r = await e.preloadResponse; if (r) return r } catch {} try { return await fetch(e.request) } catch { return (await caches.match('/')) ?? Response.error() } })())
    return
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)))`)
if (SW_PRELOAD === SW_HONEST || !SW_PRELOAD.includes('navigationPreload.enable') || !SW_PRELOAD.includes('preloadResponse')) throw new Error('the preload worker fixture did not take')
const P = path.join(work, 'P')
fs.cpSync(A, P, { recursive: true })
fs.writeFileSync(path.join(P, 'library/sw.js'), SW_PRELOAD)

const DAY = 86400e3
const relA = await describeBuild(A, new Date(Date.now() - 10 * DAY).toISOString())
const relP = await describeBuild(P, new Date(Date.now() - 10 * DAY).toISOString())
const relF = await describeBuild(F, new Date(Date.now() - 10 * DAY).toISOString())
const relB = await describeBuild(B, new Date().toISOString())
const relBold = await describeBuild(B, new Date(Date.now() - 4 * DAY).toISOString())

// --- keys and lists -------------------------------------------------------------
const mkKey = async () => {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const { kty, crv, x, y } = await webcrypto.subtle.exportKey('jwk', kp.publicKey)
  return { kp, jwk: { kty, crv, x, y } }
}
const KEY = await mkKey() // the rig's "release key"
const EVIL = await mkKey() // anyone else's
const sign = async (payloadObj, k = KEY) => {
  const payload = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj)
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.kp.privateKey, new TextEncoder().encode(payload))
  return JSON.stringify({ payload, sig: Buffer.from(sig).toString('base64') })
}
const list1 = nextServed(null, relA)
const list2 = nextServed(list1, relB)
const list2old = nextServed(list1, relBold)
const listP = nextServed(null, relP)
const listF = nextServed(null, relF)

// --- the deck the library opens (to get the frame page loaded) ------------------
const REAL = path.join(ROOT, 'home/fixtures/gate1/real/slides-1.2.10')
const shell1210 = fs.readFileSync(path.join(REAL, 'Bento_Slides.bento.html'), 'utf8')
const docJson = JSON.stringify({
  format: 'bento/slides', version: 1, docId: webcrypto.randomUUID(), title: 'tripwire', size: { w: 1280, h: 720 },
  slides: [{ id: 's1', background: '#ffffff', elements: [{ id: 't1', type: 'text', x: 96, y: 200, w: 1000, h: 120, html: 'Hello', fontSize: 48, color: '#16273E' }] }],
})
const DECK = path.join(work, 'deck.bento.html')
fs.writeFileSync(DECK, spliceDoc(shell1210, docJson))

// --- servers whose answers each row sets ------------------------------------------
const matchRule = (pattern, p) => (pattern.endsWith('*') ? p.startsWith(pattern.slice(0, -1)) : pattern === p)
function siteFiles(dir) {
  const rules = parseHeaders(fs.readFileSync(path.join(dir, '_headers'), 'utf8'))
  const files = new Map()
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('_')) continue
    const body = fs.readFileSync(path.join(dir, name))
    const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'
    const paths = name === 'index.html' ? ['/', '/index.html'] : name === 'frame.html' ? ['/frame.html', '/frame'] : [`/${name}`]
    for (const p of paths) {
      const headers = { 'content-type': type }
      for (const r of rules) if (matchRule(r.pattern, p)) for (const [k, v] of r.headers) headers[k.toLowerCase()] = headers[k.toLowerCase()] ? `${headers[k.toLowerCase()]}, ${v}` : v
      files.set(p, { body, headers })
    }
  }
  return files
}
const honest = { lib: siteFiles(path.join(A, 'library')), frame: siteFiles(path.join(A, 'frame')) }
// The site serves the build's own /sw.js, and the library registers it on every visit. Every row
// starts with no worker on the library origin (fresh() clears them): a first visit, on which the
// worker registers but does not answer the navigation. The stage3-* rows prime a returning
// visitor first (the build's worker active and in control, navigation preload on), the shape
// security's stage-3 review measured (ruling #954); the older worker rows register a fixture.
if (!honest.lib.get('/sw.js')?.body.equals(BUILD_SW)) throw new Error('the library site does not serve the build\'s own /sw.js')
const releaseB = siteFiles(path.join(B, 'library'))
// a file may carry `status` and `hold` (send the body, keep the response open); `fallback` answers unlisted library paths
const HELD = []
const state = { lib: new Map(honest.lib), frame: new Map(honest.frame), list: null, hits: [], heads: [], fallback: null, scripts: new Map([...await buildScriptTexts(A), ...await buildScriptTexts(B)]) }
// TW_H2: a throwaway certificate for 127.0.0.1, which the browser trusts by its SPKI hash alone
const TLS = H2 ? (() => {
  const key = path.join(work, 'tls-key.pem'), cert = path.join(work, 'tls-cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' })
  const pem = fs.readFileSync(cert, 'utf8')
  const spki = createHash('sha256').update(createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('base64')
  return { key: fs.readFileSync(key), cert: pem, spki }
})() : null
const serve = (key) => ((H2 && key === 'lib') ? (h) => http2.createSecureServer({ key: TLS.key, cert: TLS.cert, allowHTTP1: true }, h) : (h) => http.createServer(h))((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  state.hits.push(`${key} ${p}`)
  state.heads.push({ key, p, u: req.url, h: req.headers, v: req.httpVersion })
  if (key === 'chan') {
    // the inline scripts' text, published beside the list (scripts/<sha256>.js)
    const sm = /^\/releases\/home-web\/scripts\/([0-9a-f]{64})\.js$/.exec(p)
    if (sm && state.scripts.has(sm[1])) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(state.scripts.get(sm[1])); return }
    if (p === LIST_PATH && state.list != null) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(state.list); return }
    res.writeHead(404).end(); return
  }
  // `cloak`: what the BROWSER's worker-script fetch of /sw.js gets (Service-Worker: script), while every
  // other request, the extension's included, gets the release's bytes (security ruling #954 F-W)
  if (key === 'lib' && p === '/sw.js' && state.cloak && req.headers['service-worker'] === 'script') { res.writeHead(200, state.cloak.headers); res.end(state.cloak.body); return }
  const f = state[key].get(p) ?? (key === 'lib' ? state.fallback : null)
  if (!f) { res.writeHead(404).end(); return }
  res.writeHead(f.status ?? 200, f.headers)
  // `split: [byte, ms]` sends the body up to `byte`, waits, then the rest (a slow link)
  if (f.split) { const [i, ms] = f.split; res.write(f.body.subarray(0, i)); setTimeout(() => { try { if (f.hold) { res.write(f.body.subarray(i)); HELD.push(res) } else res.end(f.body.subarray(i)) } catch {} }, ms) } else if (f.hold) { res.write(f.body); HELD.push(res) } else res.end(f.body)
})
const servers = [[serve('lib'), pl], [serve('frame'), pf], [serve('chan'), pr]]
for (const [s, port] of servers) await new Promise((r) => s.listen(port, '127.0.0.1', r))
// localhost must answer on both families
const frame6 = serve('frame'); await new Promise((r) => frame6.listen(pf, '::1', r)).catch(() => {})

/** A copy of an honest file with `from` (exactly once) replaced. */
const variant = (file, from, to, headers = {}) => {
  const t = file.body.toString('utf8')
  if (t.split(from).length !== 2) throw new Error(`variant: "${from.slice(0, 40)}" is not in the file exactly once`)
  return { body: Buffer.from(t.replace(from, () => to)), headers: { ...file.headers, ...headers } }
}
/** One byte changed inside the (only) inline script, same length. */
const scriptByte = (file) => {
  const t = file.body.toString('utf8')
  const at = t.indexOf('<script>') + '<script>'.length + 40
  const c = t[at] === 'a' ? 'b' : 'a'
  return { body: Buffer.from(t.slice(0, at) + c + t.slice(at + 1)), headers: { ...file.headers } }
}

// --- the extension copy -------------------------------------------------------
const EXT = path.join(work, 'ext')
fs.cpSync(path.join(ROOT, 'home/webext'), EXT, { recursive: true })
const configPath = path.join(EXT, 'src/tripwire-config.js')
const shippedConfig = fs.readFileSync(configPath, 'utf8')
if (!/export \{ RELEASE_KEY as KEY \} from '\.\/release\.js'/.test(shippedConfig)) throw new Error('tripwire-config.js no longer has the shape this rig replaces')
fs.writeFileSync(configPath, [
  '// REPLACED BY scripts/test-webext-tripwire-browser.mjs: local origins, a throwaway key',
  `export const KEY = ${JSON.stringify(KEY.jwk)}`,
  `export const LIBRARY_ORIGIN = ${JSON.stringify(LIB)}`,
  `export const FRAME_ORIGINS = ${JSON.stringify([FRM])}`,
  `export const LIST_URL = ${JSON.stringify(CHAN + LIST_PATH)}`, '',
].join('\n'))
const man = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'))
const twScript = man.content_scripts.find((c) => c.js.includes('src/tripwire-observe.js'))
if (!twScript || JSON.stringify(twScript.matches) !== JSON.stringify(['https://home.bento.page/*']) || twScript.all_frames !== false) throw new Error('manifest.json no longer has the tripwire content script this rig re-points')
twScript.matches = [H2 ? 'https://127.0.0.1/*' : 'http://127.0.0.1/*']
// the frame site, as the shipped manifest will name it once its domain is chosen: in frames
man.content_scripts.push({ ...twScript, matches: ['http://localhost/*'], all_frames: true, match_origin_as_fallback: undefined })
man.host_permissions = man.host_permissions.filter((h) => h !== 'https://home.bento.page/*').concat(['http://127.0.0.1/*', 'http://localhost/*', ...(H2 ? ['https://127.0.0.1/*'] : [])])
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(man, null, 2))
for (const m of MUTANT ?? []) {
  const f = path.join(EXT, m.file)
  const t = fs.readFileSync(f, 'utf8')
  const n = t.split(m.from).length - 1
  if (n !== 1) { console.error(`mutant: "${m.from}" occurs ${n} times in ${m.file}`); process.exit(2) }
  fs.writeFileSync(f, t.replace(m.from, () => m.to))
  console.log(`  mutant applied to ${m.file}: ${m.from.slice(0, 70)}`)
}

// --- the browser ----------------------------------------------------------------
const ctx = await chromium.launchPersistentContext(path.join(work, 'profile'), {
  channel: 'chromium', headless: !process.env.HEADED,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    ...(H2 ? [`--ignore-certificate-errors-spki-list=${TLS.spki}`] : [])],
})
const sockets = []
await ctx.routeWebSocket(/.*/, (ws) => { sockets.push(ws.url()); ws.close() })
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { try { const v = await fn(); if (v) return v } catch {} await new Promise((r) => setTimeout(r, 150)) }
  return null
}
let sw = ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'))
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 })
const extId = new URL(sw.url()).host
// the worker can evaluate before chrome.storage exists on it (notes: wait for the property used)
await until(() => sw.evaluate(() => !!globalThis.chrome?.storage?.local))
{ const v = await sw.evaluate(() => chrome.runtime.getManifest().version); const b = ctx.browser()?.version?.() ?? ''; console.log(`extension ${extId} v${v} | chromium ${b} | node ${process.version}`) }
const store = {
  log: () => sw.evaluate(() => chrome.storage.local.get('tripwireLog').then((r) => r.tripwireLog ?? [])),
  reset: () => sw.evaluate(async () => { await chrome.storage.local.remove(['tripwireLog', 'tripwireList', 'tripwireUncheckedSince']); await chrome.storage.session.clear() }),
  hold: (raw) => sw.evaluate(async (raw) => {
    const e = JSON.parse(raw); await chrome.storage.local.set({ tripwireList: { payload: e.payload, sig: e.sig, serial: JSON.parse(e.payload).serial, fetchedAt: Date.now() } })
  }, raw),
}
const reportTabs = () => ctx.pages().filter((p) => p.url().startsWith(`chrome-extension://${extId}/src/tripwire.html`))
const closeExtras = async (keep) => { for (const p of ctx.pages()) if (p !== keep) await p.close().catch(() => {}) }

/** Visit the library (and, with `open`, a deck so the frame loads); return this visit's events. */
async function visit(page, url, { open = false, marker = null } = {}) {
  const t0 = Date.now()
  // a page that never finishes loading is a row's finding, not a rig crash
  await page.goto(url, { timeout: 60000 }).catch((e) => note(`navigation to ${url.slice(0, 60)} did not finish: ${String(e?.message ?? e).split('\n')[0].slice(0, 80)}`))
  // the event is THIS navigation's: matched by the page's own time origin, never by when it was
  // recorded (a page opened earlier in the row can be judged after this one starts)
  const origin0 = await page.evaluate(() => performance.timeOrigin).catch(() => null)
  // set BEFORE the verdict exists, so a reload the extension caused would erase it
  if (marker) await page.evaluate((m) => { window.__twMarker = m }, marker).catch(() => {})
  if (open) await page.setInputFiles('#file', DECK)
  const mine = (e) => e.role === 'library' && !e.early && Math.abs((e.page?.timeOrigin ?? 0) - origin0) < 1
  const frameOf = (e) => e.role === 'frame' && Date.parse(e.at) >= t0 - 50
  await until(async () => {
    const log = await store.log()
    return log.some(mine) && (!open || log.some(frameOf))
  }, 40000)
  await new Promise((r) => setTimeout(r, 300))
  const log = await store.log()
  return { lib: log.find(mine), frame: log.find(frameOf), all: log.filter((e) => Date.parse(e.at) >= t0 - 50) }
}
const rules = (e) => (e?.failures ?? []).map((f) => f.rule).sort().join(',')
const row = (name) => !ONLY || ONLY.has(name)
const section = (m) => console.log(`\n=== ${m}`)

const page = await ctx.newPage()
await closeExtras(page)
async function fresh({ list = list1, held = null, lib = {}, frame = {}, keepWorkers = false } = {}) {
  await closeExtras(page)
  // the last row's document leaves first (its pagehide report lands now, not in this row's record)
  await page.goto('about:blank').catch(() => {})
  await new Promise((r) => setTimeout(r, 400))
  // a first visit: no worker and no worker cache on the library origin. Cleared through the
  // DevTools protocol, never from a library page (which the old worker would answer).
  if (!keepWorkers) {
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Storage.clearDataForOrigin', { origin: LIB, storageTypes: 'service_workers,cache_storage' })
    await cdp.detach()
    await new Promise((r) => setTimeout(r, 300))
  }
  // a cookie a row's worker set (worker-cookie) must not ride into the next row's requests
  await ctx.clearCookies()
  await store.reset()
  for (const r of HELD.splice(0)) r.destroy()
  state.fallback = null
  state.cloak = null
  state.lib = new Map(honest.lib); state.frame = new Map(honest.frame)
  for (const [k, v] of Object.entries(lib)) state.lib.set(k, v)
  for (const [k, v] of Object.entries(frame)) state.frame.set(k, v)
  state.list = list == null ? null : typeof list === 'string' ? list : await sign(list)
  if (held) await store.hold(typeof held === 'string' ? held : await sign(held))
}
const libDoc = honest.lib.get('/index.html')
const both = (f) => ({ '/': f, '/index.html': f })

// --- rows without a worker -------------------------------------------------------
if (row('honest')) {
  section('honest: the bytes of release A, list #1 [A]  (rules: all, positive control)')
  await fresh()
  const v = await visit(page, `${LIB}/`, { open: true })
  ok(v.lib?.verdict === 'ok', `library: ok (got ${v.lib?.verdict} ${rules(v.lib)})`)
  ok(v.lib?.observed.bytes && v.lib?.observed.size && v.lib?.observed.csp && v.lib?.observed.scripts, `library: bytes, size, CSP and scripts were all OBSERVED (${JSON.stringify(v.lib?.observed)})`)
  ok(v.lib?.page.cspFrom === 'navigation', `library: the CSP came from the navigation's own headers (webRequest), got ${v.lib?.page.cspFrom}`)
  ok(v.lib?.page.scripts.length === 1, `library: one script parsed (${v.lib?.page.scripts.length})`)
  ok(v.frame?.verdict === 'ok', `frame: ok (got ${v.frame?.verdict} ${rules(v.frame)})`)
  ok(v.frame?.observed.size && v.frame?.observed.csp && v.frame?.page.scripts.length === 1 && !v.frame?.observed.bytes,
    `frame (opaque): size, CSP and one script observed, bytes not readable (${JSON.stringify(v.frame?.observed)})`)
  ok(v.frame?.page.cspFrom === 'navigation', 'frame: its CSP came from the navigation headers')
  ok((v.lib?.warned ?? []).length === 0 && reportTabs().length === 0, 'nothing warned, no report tab')
  const v2 = await visit(page, `${LIB}/index.html`)
  ok(v2.lib?.verdict === 'ok', `library at /index.html: ok (got ${v2.lib?.verdict})`)
}

if (row('library-byte')) {
  section('library-byte: one byte of the library page\'s TEXT changed, same length  (rule: bytes; warning)')
  const bad = variant(libDoc, 'Choose a file', 'Choose a filf')
  await fresh({ lib: both(bad) })
  const v = await visit(page, `${LIB}/`)
  ok(v.lib?.verdict === 'mismatch', `mismatch (got ${v.lib?.verdict})`)
  ok(rules(v.lib) === 'bytes', `only the bytes rule failed (got ${rules(v.lib)})`)
  ok(v.lib?.warned.includes('tab') && v.lib?.warned.includes('badge'), `warned loudly: ${v.lib?.warned}`)
  const tab = await until(() => reportTabs()[0], 5000)
  ok(!!tab, 'the report page opened in a tab')
  if (tab) {
    await tab.waitForLoadState()
    const text = await tab.evaluate(() => document.body.innerText)
    ok(/bytes/.test(text) && /not serving a Bento release/.test(text), 'the report page names the finding and the failed rule')
  }
}

if (row('library-script-byte')) {
  section('library-script-byte: one byte inside the library\'s script, same length  (warning)')
  await fresh({ lib: both(scriptByte(libDoc)) })
  const v = await visit(page, `${LIB}/`)
  ok(v.lib?.verdict === 'mismatch' && rules(v.lib) === 'bytes,scripts', `mismatch on bytes and scripts (got ${v.lib?.verdict} ${rules(v.lib)})`)
}

if (row('frame-byte')) {
  section('frame-byte: one byte inside the frame page\'s script, same length  (rule: scripts, frame)')
  const bad = scriptByte(honest.frame.get('/frame.html'))
  await fresh({ frame: { '/frame.html': bad, '/frame': bad } })
  const v = await visit(page, `${LIB}/`, { open: true })
  ok(v.lib?.verdict === 'ok', `library still ok (${v.lib?.verdict})`)
  ok(v.frame?.verdict === 'mismatch' && rules(v.frame) === 'scripts', `frame: mismatch on scripts only (got ${v.frame?.verdict} ${rules(v.frame)})`)
  ok(v.frame?.warned.includes('tab'), 'frame: warned')
}

if (row('library-csp')) {
  section('library-csp: the library\'s CSP header changed, bytes identical  (rule: csp from the navigation)')
  const h = libDoc.headers['content-security-policy']
  const loose = h.replace(/worker-src [^;]+/, 'worker-src *')
  if (loose === h) throw new Error('the library CSP no longer has the worker-src this row loosens')
  const bad = { body: libDoc.body, headers: { ...libDoc.headers, 'content-security-policy': loose } }
  await fresh({ lib: both(bad) })
  const v = await visit(page, `${LIB}/`)
  ok(v.lib?.verdict === 'mismatch' && rules(v.lib) === 'csp', `mismatch on csp only (got ${v.lib?.verdict} ${rules(v.lib)})`)
}

if (row('frame-csp')) {
  section('frame-csp: the frame page\'s CSP header changed  (rule: csp, from webRequest; the frame has no other source)')
  const f = honest.frame.get('/frame.html')
  const bad = { body: f.body, headers: { ...f.headers, 'content-security-policy': f.headers['content-security-policy'] + '; report-uri /r' } }
  await fresh({ frame: { '/frame.html': bad, '/frame': bad } })
  const v = await visit(page, `${LIB}/`, { open: true })
  ok(v.frame?.verdict === 'mismatch' && rules(v.frame) === 'csp', `frame: mismatch on csp only (got ${v.frame?.verdict} ${rules(v.frame)})`)
}

if (row('bad-signature')) {
  section('bad-signature: no list held; the channel serves a list signed by ANOTHER key that lists the hostile bytes  (rule: signature)')
  const bad = variant(libDoc, 'Choose a file', 'Choose a filf')
  // a list in the right shape, naming the hostile bytes, signed by the wrong key
  const forged = structuredClone(list1)
  const badSha = createHash('sha256').update(bad.body).digest('hex')
  for (const p of ['/', '/index.html']) forged.releases[0].origins[LIB].files[p].sha256 = badSha
  await fresh({ list: await sign(forged, EVIL), lib: both(bad) })
  const v = await visit(page, `${LIB}/`)
  ok(v.lib?.list.status === 'invalid', `the list was refused as invalid (got ${v.lib?.list.status}: ${v.lib?.list.why ?? ''})`)
  ok(v.lib?.verdict !== 'ok', `the page did NOT pass (got ${v.lib?.verdict})`)
  ok(v.lib?.warned.includes('tab'), `a bad signature warns: ${v.lib?.warned}`)
  // and with a genuine list held: judged against it, and the forgery still warns
  await fresh({ held: list1, list: await sign(forged, EVIL), lib: both(bad) })
  const w = await visit(page, `${LIB}/`)
  ok(w.lib?.verdict === 'mismatch' && w.lib?.list.status === 'invalid', `held list: mismatch, and the forged refresh is invalid (got ${w.lib?.verdict}, ${w.lib?.list.status})`)
}

if (row('wrong-type')) {
  section('wrong-type: a list signed with the right key but typed as something else  (rule: type)')
  await fresh({ list: { ...list1, type: 'bento/home-web/other' } })
  const v = await visit(page, `${LIB}/`)
  ok(v.lib?.list.status === 'invalid' && v.lib?.verdict === 'unchecked', `refused as invalid, nothing judged (got ${v.lib?.list.status}, ${v.lib?.verdict})`)
  ok(v.lib?.warned.includes('notification') || v.lib?.warned.includes('tab'), `and that warns: ${v.lib?.warned}`)
}

if (row('stale-held')) {
  section('stale-held: list #1 [A] held; release B deployed; channel has #2 [B, A]  (rule: refresh before warning)')
  await fresh({ held: list1, list: list2, lib: both(releaseB.get('/index.html')) })
  const v = await visit(page, `${LIB}/`)
  ok(v.lib?.verdict === 'ok' && v.lib?.serial === 2, `ok against the refreshed list #2 (got ${v.lib?.verdict} #${v.lib?.serial})`)
  ok(v.lib?.list.status === 'ok' && (v.lib?.warned ?? []).length === 0, `refreshed, nothing warned (${v.lib?.list.status}, ${v.lib?.warned})`)
}

if (row('rollback')) {
  section('rollback: #2 [B, A] held; channel serves the older genuine #1; library serves A  (rules: rollback refused, older release = outdated, grace)')
  await fresh({ held: list2, list: list1 })
  const v = await visit(page, `${LIB}/`)
  ok(v.lib?.list.status === 'rollback', `the older list was refused (got ${v.lib?.list.status})`)
  ok(v.lib?.verdict === 'outdated' && v.lib?.serial === 2 && v.lib?.release === 1, `A is release 1 of #2: outdated (got ${v.lib?.verdict} #${v.lib?.serial} r${v.lib?.release})`)
  ok((v.lib?.warned ?? []).length === 0, `within 72 h of B: recorded, not announced (warned: ${v.lib?.warned})`)
}

if (row('outdated-late')) {
  section('outdated-late: B was signed 4 days ago and A is still served  (rule: grace ends)')
  await fresh({ held: list2old, list: list2old })
  const v = await visit(page, `${LIB}/`)
  ok(v.lib?.verdict === 'outdated', `outdated (got ${v.lib?.verdict})`)
  ok(v.lib?.warned.includes('notification') && !v.lib?.warned.includes('tab'), `a notification, not the tamper tab (warned: ${v.lib?.warned})`)
}

if (row('conflict')) {
  section('conflict: #1 held; the channel serves a DIFFERENT genuine #1  (rule: serial reuse is loud)')
  await fresh({ held: list1, list: { ...list1, at: new Date().toISOString() }, lib: both(variant(libDoc, 'Choose a file', 'Choose a filf')) })
  const v = await visit(page, `${LIB}/`)
  ok(v.lib?.list.status === 'conflict', `refused as a conflict (got ${v.lib?.list.status})`)
  ok(v.lib?.warned.includes('tab'), `loud (warned: ${v.lib?.warned})`)
}

// --- the security ruling's rows (C1-C5, R1, R3): a page that tries to stop, flood or outgrow the check ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const since = async (t0) => (await store.log()).filter((e) => Date.parse(e.at) >= t0 - 50)
/** The library page with its script replaced by `js`, its meta CSP dropped, and a header CSP that lets it run. */
const hostileScriptPage = (js, { hold = false } = {}) => {
  const t = libDoc.body.toString('utf8')
  const s0 = t.indexOf('<script>') + '<script>'.length, s1 = t.indexOf('</script>', s0)
  const meta = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/.exec(t)[0]
  return { body: Buffer.from(t.slice(0, s0).replace(meta, '') + js + t.slice(s1)), hold, headers: { ...libDoc.headers, 'content-security-policy': "script-src 'unsafe-inline' blob:" } }
}
const ORPHAN_WAIT = 13000 // the extension judges an unsettled early report after 10 s

for (const hold of [false, true]) {
  const name = hold ? 'blob-escape-held' : 'blob-escape'
  if (!row(name)) continue
  section(`${name}: a hostile script moves the tab to a same-origin blob: document before the full report${hold ? ' (response held open)' : ''}  (rules: early report, blob document)`)
  const js = "var h='<!doctype html><title>bento/home</title><p id=evil>hostile, same origin</p>';location.replace(URL.createObjectURL(new Blob([h],{type:'text/html'})))"
  await fresh({ lib: both(hostileScriptPage(js, { hold })) })
  const t0 = Date.now()
  await page.goto(`${LIB}/`, { waitUntil: 'commit' }).catch(() => {})
  await until(async () => page.url().startsWith('blob:'), 10000)
  await sleep(ORPHAN_WAIT)
  const evs = await since(t0)
  const blobEv = evs.find((e) => e.url.startsWith('blob:'))
  const earlyEv = evs.find((e) => e.early && !e.url.startsWith('blob:'))
  ok(page.url().startsWith('blob:'), `the hostile document is running at ${page.url().slice(0, 40)}`)
  note(`events: ${evs.map((e) => `${e.url.slice(-20)}${e.early ? '(early)' : ''}=${e.verdict}/${e.class}[${rules(e)}]{${e.warned}} flags ${e.page?.flags}`).join(' | ')}`)
  ok(blobEv?.verdict === 'mismatch' && blobEv.page.flags.some((f) => f.startsWith('document:blob')), `the blob: document itself is a mismatch (${blobEv?.verdict} ${blobEv?.page.flags})`)
  ok(earlyEv?.verdict === 'mismatch' && rules(earlyEv).split(',').includes('scripts'), `the hostile page's EARLY report, never settled, is a mismatch on its script (${earlyEv?.verdict} ${rules(earlyEv)})`)
  ok(reportTabs().length === 1, `one loud report tab for the origin (${reportTabs().length})`)
}

if (row('held-then-leave')) {
  section('held-then-leave: the hostile page holds its response open, runs, then leaves for an honest path  (rule: early report)')
  const js = "window.__evil=1;setTimeout(function(){location.replace('/index.html')},3000)"
  await fresh({ lib: { '/': hostileScriptPage(js, { hold: true }) } })
  const t0 = Date.now()
  await page.goto(`${LIB}/`, { waitUntil: 'commit' }).catch(() => {})
  await sleep(4000 + ORPHAN_WAIT)
  const evs = await since(t0)
  note(`events: ${evs.map((e) => `${e.url.replace(LIB, '')}${e.early ? '(early)' : ''}=${e.verdict}`).join(' ')}`)
  const earlyEv = evs.find((e) => e.early)
  ok(evs.some((e) => !e.early && e.url === `${LIB}/index.html` && e.verdict === 'ok'), 'the honest page it left for is ok')
  ok(earlyEv?.verdict === 'mismatch' && earlyEv.url === `${LIB}/`, `and the hostile visit is on record as a mismatch (${earlyEv?.verdict} ${earlyEv?.url})`)
  ok(earlyEv?.warned.includes('tab'), `loudly (${earlyEv?.warned})`)
}

if (row('no-store')) {
  section('no-store: one byte of library text changed, sent with Cache-Control: no-store  (rule: bytes-unread)')
  await fresh({ lib: both(variant(libDoc, 'Choose a file', 'Choose a filf', { 'cache-control': 'no-store' })) })
  const v = await visit(page, `${LIB}/`)
  ok(!v.lib?.observed.bytes, 'the bytes could not be read (nothing cached)')
  ok(v.lib?.verdict === 'mismatch' && rules(v.lib).split(',').includes('bytes-unread'), `unread bytes on the library are a mismatch, not a pass (${v.lib?.verdict} ${rules(v.lib)})`)
}

if (row('held-open')) {
  section('held-open: the honest library\'s response never ends  (rule: a visit cut short that is the clean start of a release is recorded quietly)')
  const b = libDoc.body.toString('utf8')
  await fresh({ lib: both({ body: Buffer.from(b.slice(0, b.indexOf('</main>'))), hold: true, headers: libDoc.headers }) })
  const t0 = Date.now()
  await page.goto(`${LIB}/`, { waitUntil: 'commit' }).catch(() => {})
  const ev = await until(async () => (await since(t0)).find((e) => !e.early), 75000)
  ok(ev?.verdict === 'incomplete' && ev.page.aborted && (ev.warned ?? []).length === 0 && reportTabs().length === 0, `an honest visit cut short: incomplete, recorded quietly (${ev?.verdict} aborted ${ev?.page?.aborted} warned ${ev?.warned})`)
}

if (row('held-open-hostile')) {
  section('held-open-hostile: a hostile page whose response never ends  (rules: incomplete, size-unread: never ok)')
  await fresh({ lib: both(hostileScriptPage('window.__evil=1', { hold: true })) })
  const t0 = Date.now()
  await page.goto(`${LIB}/`, { waitUntil: 'commit' }).catch(() => {})
  const ev = await until(async () => (await since(t0)).find((e) => !e.early), 75000)
  ok(ev?.verdict === 'mismatch' && rules(ev).includes('incomplete') && rules(ev).includes('size-unread'), `an unfinished hostile parse is never ok (${ev?.verdict} ${rules(ev)})`)
}

for (const [name, fb] of [
  ['unlisted-404', { status: 404, body: Buffer.from('<!doctype html><title>404</title><h1>404 Not Found</h1>'), headers: { 'content-type': 'text/html' } }],
  ['unlisted-spa', { body: libDoc.body, headers: { 'content-type': 'text/html; charset=utf-8' } }],
]) {
  if (!row(name)) continue
  section(`${name}: three links to unlisted paths  (rules: script-free unlisted is quiet; one loud warning per origin per session)`)
  await fresh()
  state.fallback = fb
  const vs = []
  for (const q of ['/nope?a', '/nope?b', '/nope?c']) vs.push((await visit(page, `${LIB}${q}`)).lib)
  await sleep(1000)
  if (name === 'unlisted-404') {
    ok(vs.every((e) => e?.verdict === 'unlisted' && e.warned.length === 0), `a host's 404 page is recorded quietly (${vs.map((e) => e?.verdict)})`)
    ok(reportTabs().length === 0, `no report tab (${JSON.stringify((await store.log()).filter((e) => e.role === 'page-request').map((e) => [e.url, e.failures.map((f) => f.why ?? f.rule), e.page?.request?.type]))})`)
  } else {
    ok(vs.every((e) => e?.verdict === 'mismatch'), `the library's scripts at an unlisted path, without its CSP header, are a mismatch (${vs.map((e) => `${e?.verdict}[${rules(e)}]`)})`)
    ok(reportTabs().length === 1, `but ONE loud report tab for the origin, not three (${reportTabs().length})`)
  }
}

if (row('framed')) {
  section('framed: a third-party page frames ten library paths  (rule: the library is judged only as a top-level page)')
  await fresh()
  state.fallback = { body: libDoc.body, headers: { 'content-type': 'text/html; charset=utf-8' } }
  state.frame.set('/evil', { body: Buffer.from([...Array(10)].map((_, i) => `<iframe src="${LIB}/nope?f=${i}"></iframe>`).join('')), headers: { 'content-type': 'text/html' } })
  const t0 = Date.now()
  await page.goto(`${FRM}/evil`)
  await until(async () => page.frames().length >= 11, 10000)
  await sleep(ORPHAN_WAIT)
  const evs = (await since(t0)).filter((e) => e.origin === LIB)
  ok(page.frames().length >= 11, `the ten frames loaded (${page.frames().length - 1})`)
  ok(evs.length === 0 && reportTabs().length === 0, `nothing judged, nothing opened (${evs.length} events, ${reportTabs().length} tabs)`)
}

if (row('concurrent')) {
  section('concurrent: sixteen honest library tabs at once  (rule: one chain for every storage write)')
  await fresh()
  await visit(page, `${LIB}/`)
  const t0 = Date.now()
  const tabs = await Promise.all([...Array(16)].map(() => ctx.newPage()))
  await Promise.all(tabs.map((p, i) => p.goto(`${LIB}/?r=${i}`, { timeout: 90000 })))
  await until(async () => (await since(t0)).length >= 16, 60000)
  await sleep(1500)
  const evs = await since(t0)
  ok(evs.length === 16 && evs.every((e) => e.verdict === 'ok'), `every one recorded (${evs.length}/16: ${evs.map((e) => e.verdict)})`)
  for (const p of tabs) await p.close()
}

if (row('oversized')) {
  section('oversized: 700 script elements with 16 KB paths  (rules: caps; the record always holds the check)')
  await fresh()
  const t = libDoc.body.toString('utf8')
  const pad = [...Array(700)].map((_, i) => `<script src="/${'A'.repeat(16000)}${i}"></script>`).join('')
  const big = { body: Buffer.from(t.replace('</body>', () => pad + '</body>')), headers: { ...libDoc.headers } }
  await fresh({ lib: both(big) })
  const v = await visit(page, `${LIB}/`)
  const tab = await until(() => reportTabs()[0], 10000)
  ok(v.lib?.verdict === 'mismatch' && v.lib.page.flags.includes('over-cap:scripts'), `recorded as a mismatch, over the cap (${v.lib?.verdict} ${v.lib?.page.flags})`)
  if (tab) {
    await tab.waitForLoadState(); await sleep(500)
    const meta = await tab.evaluate(() => document.getElementById('meta')?.textContent ?? '')
    ok(/mismatch/.test(meta), `the report page shows THIS check (${meta.slice(0, 80)})`)
  } else ok(false, 'a report tab opened')
}

if (row('report-not-found')) {
  section('report-not-found: the report page asked for a check that is not on record  (rule: never another check)')
  await fresh()
  await visit(page, `${LIB}/`)
  const p = await ctx.newPage()
  await p.goto(`chrome-extension://${extId}/src/tripwire.html?id=nope`)
  await sleep(500)
  const r = await p.evaluate(() => ({ nf: !document.getElementById('notfound').hidden, verdict: !document.getElementById('verdict').hidden, list: document.getElementById('liststatus').textContent }))
  ok(r.nf && !r.verdict, `"not found", and no other check shown (${JSON.stringify(r)})`)
  ok(/#1/.test(r.list), `the list status says which list checks run against (${r.list})`)
  await p.close()
}

if (row('never-checked')) {
  section('never-checked: no list can be fetched, for more than three days  (rule R3)')
  await fresh({ list: null })
  const v1 = await visit(page, `${LIB}/`)
  ok(v1.lib?.verdict === 'unchecked' && v1.lib.warned.length === 0, `day one: unchecked, recorded quietly (${v1.lib?.verdict} ${v1.lib?.warned})`)
  await sw.evaluate(() => chrome.storage.local.set({ tripwireUncheckedSince: Date.now() - 4 * 86400e3 }))
  await sw.evaluate(() => chrome.storage.session.clear())
  const v2 = await visit(page, `${LIB}/`)
  ok(v2.lib?.verdict === 'unchecked' && v2.lib.warned.includes('notification') && !v2.lib.warned.includes('tab'), `after three days: a notification says nothing is being checked (${v2.lib?.warned})`)
  const p = await ctx.newPage()
  await p.goto(`chrome-extension://${extId}/src/tripwire.html`)
  await sleep(500)
  ok(/never been checked/.test(await p.evaluate(() => document.getElementById('liststatus').textContent)), 'the report page says home.bento.page has never been checked')
  await p.close()
}

if (row('withdrawn')) {
  section('withdrawn: release A is withdrawn in list #2; the library still serves A  (rule R1)')
  const l2 = structuredClone(list2)
  l2.releases[1].withdrawn = true
  await fresh({ held: l2, list: l2 })
  const v = await visit(page, `${LIB}/`)
  ok(v.lib?.verdict === 'mismatch' && rules(v.lib) === 'withdrawn' && v.lib.warned.includes('tab'), `serving a withdrawn release is a loud mismatch, not "outdated" (${v.lib?.verdict} ${rules(v.lib)})`)
}

if (row('carries-app')) {
  section('carries-app: a list signed with the right key that also carries `app`  (rule R2)')
  await fresh({ list: { ...list1, app: 'bento-slides' } })
  const v = await visit(page, `${LIB}/`)
  ok(v.lib?.list.status === 'invalid' && v.lib?.verdict === 'unchecked', `refused as invalid (${v.lib?.list.status}, ${v.lib?.verdict})`)
}


if (row('about-popup')) {
  section('about-popup: a hostile script writes code into an about:blank popup of the library origin  (rule: about: documents are judged by the origin they run in)')
  const js = "document.addEventListener('click',function(){var w=window.open('about:blank');w.document.write('<p>hostile popup<script>fetch(\"/popup-evil\")<'+'/script>');w.document.close()})"
  await fresh({ lib: both(hostileScriptPage(js)) })
  const h0 = state.hits.length
  const t0 = Date.now()
  await page.goto(`${LIB}/`)
  await sleep(500)
  const popP = ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null)
  await page.mouse.click(50, 200)
  const pop = await popP
  const ev = await until(async () => (await since(t0)).find((e) => e.url.startsWith('about:')), 15000)
  ok(!!pop && state.hits.slice(h0).includes('lib /popup-evil'), 'the popup ran the hostile code (the attack is real)')
  ok(ev?.verdict === 'mismatch' && ev.origin === LIB && ev.page.flags.some((f) => f.startsWith('document:about')), `the about: document is on record as a mismatch of the library origin (${ev?.verdict} ${ev?.origin} ${ev?.page?.flags})`)
  if (pop) await pop.close().catch(() => {})
}

// --- N1: what the parse looks like, as it happens; N4: visits cut short, and warnings by class ----------------
const CSP_EVIL = "script-src 'unsafe-inline'; connect-src 'self'"

if (row('dsd-leave')) {
  section('dsd-leave: stage 1, a script in a declarative shadow root (attached after the observer last looked) runs, then leaves for an honest page  (rule: the element sequence, reported as it grows)')
  const head = '<!doctype html><html><head><meta charset="utf-8"><title>bento/home</title></head><body><div id="h">' + '<p>'.repeat(300)
  const tail = "<template shadowrootmode=\"open\"><script>fetch('/evil-ran-dsd');location.replace('/index.html')<\/script></template></div>"
  await fresh({ lib: { '/': { body: Buffer.from(head + tail), headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': CSP_EVIL }, hold: true, split: [Buffer.byteLength(head), 800] } } })
  const h0 = state.hits.length
  const t0 = Date.now()
  await page.goto(`${LIB}/`, { waitUntil: 'commit' }).catch(() => {})
  await sleep(3500 + ORPHAN_WAIT)
  const evs = await since(t0)
  const hostile = evs.find((e) => e.early && e.url === `${LIB}/`)
  ok(state.hits.slice(h0).includes('lib /evil-ran-dsd'), 'the hidden script ran and left (the attack is real)')
  // the hidden script's own fetch is a page-request finding too (M6), and may take the origin's one loud tab first
  const pageReq = evs.find((e) => e.role === 'page-request' && e.url === `${LIB}/evil-ran-dsd`)
  ok(hostile?.verdict === 'mismatch' && rules(hostile).includes('elements') && (hostile.warned.includes('tab') || (pageReq?.warned ?? []).includes('tab')), `the visit is on record as a loud mismatch: its parse stopped matching any listed document (${hostile?.verdict} ${rules(hostile)} ${hostile?.warned}; its fetch: ${pageReq?.warned})`)
}

if (row('dsd-leave-prefix')) {
  section('dsd-leave-prefix: the honest library\'s own start, then a declarative shadow root on <main> whose script leaves  (rule: a shadow root is flagged as the parse goes on)')
  const t = libDoc.body.toString('utf8')
  const at = t.indexOf('<main>') + '<main>'.length
  // the meta CSP stays an element (the start must match the honest one), with a policy that lets the script run
  const head = t.slice(0, at).replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*(">)/, (_, a, b) => `${a}script-src 'unsafe-inline'${b}`)
  const tail = "<template shadowrootmode=\"open\"><script>fetch('/evil-ran-dsdp');location.replace('/index.html')<\/script>"
  await fresh({ lib: { '/': { body: Buffer.from(head + tail), headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': CSP_EVIL }, hold: true, split: [Buffer.byteLength(head), 800] } } })
  const h0 = state.hits.length
  const t0 = Date.now()
  await page.goto(`${LIB}/`, { waitUntil: 'commit' }).catch(() => {})
  await sleep(3500 + ORPHAN_WAIT)
  const evs = await since(t0)
  const hostile = evs.find((e) => e.early && e.url === `${LIB}/`)
  ok(state.hits.slice(h0).includes('lib /evil-ran-dsdp'), 'the hidden script ran and left (the attack is real)')
  ok(!!hostile, `the visit is on record (${hostile?.verdict} ${rules(hostile)} flags ${hostile?.page?.flags})`)
  ok(hostile?.verdict === 'mismatch' && hostile.page.flags.includes('shadow-root'), `as a mismatch: the shadow root was flagged (${hostile?.verdict} ${hostile?.page?.flags})`)
}

if (row('visit-started')) {
  section('visit-started: a listed page that shows the observer nothing, then is left  (rule: every visit is on record)')
  // the honest page's own first bytes, up to its first element the observer records (html and head it does not)
  const lt = libDoc.body.toString('utf8')
  await fresh({ lib: both({ body: Buffer.from(lt.slice(0, lt.indexOf('<meta'))), hold: true, headers: libDoc.headers }) })
  const t0 = Date.now()
  await page.goto(`${LIB}/`, { waitUntil: 'commit' }).catch(() => {})
  await sleep(1000)
  await page.goto('about:blank').catch(() => {})
  await sleep(ORPHAN_WAIT)
  const ev = (await since(t0)).find((e) => e.url === `${LIB}/`)
  note(`visit-started events: ${JSON.stringify((await store.log()).slice(0, 4).map((e) => [e.url, e.early, e.verdict, e.at]))}`)
  ok(ev?.verdict === 'incomplete' && (ev.warned ?? []).length === 0, `the visit is on record, quietly, as incomplete (${ev?.verdict} ${ev?.warned})`)
}

if (row('popup-decoy')) {
  section('popup-decoy: a third party opens the honest library and closes it mid-script, then a real hostile deploy follows  (rules: a script cut short is an exact prefix of the published text; the decoy is quiet; the real mismatch is loud)')
  await fresh()
  const t = libDoc.body.toString('utf8')
  const mid = Buffer.byteLength(t.slice(0, t.indexOf('<script>') + 8 + 2000))
  for (const p of ['/', '/index.html']) state.lib.set(p, { body: libDoc.body, headers: libDoc.headers, split: [mid, 5000] })
  state.frame.set('/attacker', { body: Buffer.from(`<!doctype html><button id=b style="width:300px;height:100px" onclick="window.__w=window.open('${LIB}/');setTimeout(function(){window.__w.close()},1500)">go</button>`), headers: { 'content-type': 'text/html' } })
  await page.goto(`${FRM}/attacker`)
  const t0 = Date.now()
  const popP = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null)
  await page.click('#b')
  await popP
  await sleep(3000 + ORPHAN_WAIT)
  const evs = await since(t0)
  const decoy = evs.find((e) => e.url === `${LIB}/`)
  note(`decoy: ${JSON.stringify({ early: decoy?.early, size: decoy?.page?.size, aborted: decoy?.page?.aborted, complete: decoy?.page?.complete, elements: decoy?.page?.elements?.length, scripts: decoy?.page?.scripts?.length, errors: decoy?.page?.errors, partial: decoy?.page?.partial, all: evs.map((e) => e.url + (e.early ? '(e)' : '') + '=' + e.verdict) })}`)
  ok(!!decoy && ['incomplete', 'ok'].includes(decoy.verdict) && (decoy.warned ?? []).length === 0 && reportTabs().length === 0, `the closed honest visit is recorded quietly (${decoy?.verdict} ${rules(decoy)} ${decoy?.warned}; partial ${JSON.stringify(decoy?.page?.partial)})`)
  await closeExtras(page)
  for (const p of ['/', '/index.html']) state.lib.set(p, variant(libDoc, 'Choose a file', 'Choose a filf'))
  const v = await visit(page, `${LIB}/`)
  ok(v.lib?.verdict === 'mismatch' && v.lib.warned.includes('tab'), `then a real hostile deploy is LOUD (${v.lib?.verdict} ${rules(v.lib)} ${v.lib?.warned})`)
}

if (row('class-keys')) {
  section('class-keys: an "unverified" mismatch first, then a "tampered" one, same session  (rule: one loud warning per class, so the first cannot silence the second)')
  await fresh()
  // the browser keeps no copy of the honest page this once (as a cleared or full cache would): its bytes cannot be read
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  const a = await visit(page, `${LIB}/`)
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }); await cdp.detach()
  ok(a.lib?.verdict === 'mismatch' && a.lib.class === 'unverified' && a.lib.warned.includes('tab'), `honest page, bytes unreadable: unverified, loud once (${a.lib?.verdict} ${a.lib?.class} ${rules(a.lib)} ${a.lib?.warned})`)
  for (const p of ['/', '/index.html']) state.lib.set(p, variant(libDoc, 'Choose a file', 'Choose a filf'))
  await closeExtras(page)
  const b = await visit(page, `${LIB}/`)
  ok(b.lib?.verdict === 'mismatch' && b.lib.class === 'tampered' && b.lib.warned.includes('tab'), `then a changed byte: tampered, loud too (${b.lib?.verdict} ${b.lib?.class} ${b.lib?.warned})`)
}

for (const [name, bad] of [['cross-site-link', false], ['cross-site-no-store', true]]) {
  if (!row(name)) continue
  section(`${name}: the library reached by a link on another site${bad ? ', one byte changed and sent no-store' : ''}  (rules: a cross-site navigation's bytes are not judged; its Cache-Control header is)`)
  await fresh(bad ? { lib: both(variant(libDoc, 'Choose a file', 'Choose a filf', { 'cache-control': 'no-store' })) } : {})
  if (!bad) {
    // a stale entry in the cache first: another release's page, visited directly
    for (const p of ['/', '/index.html']) state.lib.set(p, releaseB.get('/index.html'))
    await visit(page, `${LIB}/`)
    for (const p of ['/', '/index.html']) state.lib.set(p, honest.lib.get(p))
  }
  state.frame.set('/opener', { body: Buffer.from(`<!doctype html><a id=l href="${LIB}/">link</a>`), headers: { 'content-type': 'text/html' } })
  await page.goto(`${FRM}/opener`)
  const t0 = Date.now()
  await page.click('#l')
  const ev = await until(async () => (await since(t0)).find((e) => e.url === `${LIB}/` && !e.early), 20000)
  if (!bad) ok(ev?.verdict === 'ok' && ev.page.crossSite && !ev.observed.bytes && (ev.warned ?? []).length === 0, `honest, reached from another site: ok, quietly; its bytes are not judged, an older cached page notwithstanding (${ev?.verdict} ${rules(ev)} crossSite ${ev?.page?.crossSite})`)
  else ok(ev?.verdict === 'mismatch' && rules(ev).split(',').includes('cache-control'), `no-store, reached from another site: a mismatch on its Cache-Control header (${ev?.verdict} ${rules(ev)})`)
}


if (row('xsite-markup')) {
  section('xsite-markup: reached by a link on another site, a same-length MARKUP change (the lede becomes a link elsewhere)  (rule: the element sequence still judges a cross-site visit)')
  const LEDE = 'Open a Bento document to view or present it.'
  const link = '<a href="http://x.example/">Open it</a>'.padEnd(LEDE.length, ' ')
  const body = variant(libDoc, LEDE, link)
  ok(body.body.length === libDoc.body.length, 'the change keeps the length (size cannot catch it)')
  await fresh({ lib: both(body) })
  state.frame.set('/opener', { body: Buffer.from(`<!doctype html><a id=l href="${LIB}/">link</a>`), headers: { 'content-type': 'text/html' } })
  await page.goto(`${FRM}/opener`)
  const t0 = Date.now()
  await page.click('#l')
  const ev = await until(async () => (await since(t0)).find((e) => e.url === `${LIB}/` && !e.early), 20000)
  const shown = await page.evaluate(() => !!document.querySelector('a[href="http://x.example/"]')).catch(() => null)
  ok(shown === true && ev?.page?.crossSite === true && !ev.observed?.bytes, `the injected link is on screen, on a cross-site visit whose bytes are not judged (shown ${shown}, crossSite ${ev?.page?.crossSite})`)
  ok(ev?.verdict === 'mismatch' && rules(ev).split(',').includes('elements') && (ev.warned ?? []).includes('tab'), `a loud mismatch on the element sequence (${ev?.verdict} ${rules(ev)} ${ev?.warned})`)
}

for (const [name, secs] of [['refresh-header', 1], ['refresh-header-now', 0]]) {
  if (!row(name)) continue
  section(`${name}: the honest bytes, sent with \`Refresh: ${secs}; url=<another site>\` on a direct visit  (rule: a Refresh header is never in a release)`)
  await fresh({ lib: both({ body: libDoc.body, headers: { ...libDoc.headers, refresh: `${secs}; url=${FRM}/phish` } }) })
  state.frame.set('/phish', { body: Buffer.from('<!doctype html>phish'), headers: { 'content-type': 'text/html' } })
  const t0 = Date.now()
  await page.goto(`${LIB}/`).catch(() => {})
  await sleep(2500 + (secs ? 0 : ORPHAN_WAIT))
  const evs = (await since(t0)).filter((e) => e.url === `${LIB}/`)
  note(`${name} events: ${JSON.stringify(evs.map((e) => [e.early ? 'early' : 'full', e.verdict, rules(e), e.page?.aborted, e.page?.refresh]))}`)
  ok(page.url().endsWith('/phish'), `the tab left for the other site (the attack is real): ${page.url()}`)
  // with no delay the page may leave before its full report does: whichever report settles the visit, it is loud
  const loud = evs.filter((e) => e.verdict === 'mismatch' && rules(e).split(',').includes('refresh-header'))
  ok(evs.length > 0 && loud.length === evs.length && loud.some((e) => (e.warned ?? []).includes('tab')), `every report of the visit is a mismatch on the Refresh header, loudly (${evs.map((e) => `${e.early ? 'early' : 'full'} ${e.verdict} ${rules(e)} ${e.warned}`).join(' | ')})`)
}

if (row('cut-mid-script')) {
  section('cut-mid-script: the honest library, its script still arriving, left before it ends  (rule: a script cut short that is an exact prefix of the published text is clean)')
  const t = libDoc.body.toString('utf8')
  const mid = Buffer.byteLength(t.slice(0, t.indexOf('<script>') + 8 + 2000))
  await fresh({ lib: both({ body: libDoc.body.subarray(0, mid), headers: libDoc.headers, hold: true }) })
  const t0 = Date.now()
  await page.goto(`${LIB}/`, { waitUntil: 'commit' }).catch(() => {})
  await sleep(1500)
  await page.goto('about:blank').catch(() => {})
  await sleep(ORPHAN_WAIT)
  const ev = (await since(t0)).find((e) => e.url === `${LIB}/`)
  ok(ev?.verdict === 'incomplete' && (ev.warned ?? []).length === 0 && ev.page?.partial?.length > 1000, `recorded quietly as incomplete, with the script cut short (${ev?.verdict} ${rules(ev)} ${ev?.warned} partial ${JSON.stringify(ev?.page?.partial)})`)
}
// --- rows with a service worker ---------------------------------------------------
const SW_ROWS = ['sw-preload-vary', 'sw-element', 'shadow-root', 'shadow-root-removed', 'sw-honest', 'sw-script-bytes', 'sw-custom-path', 'sw-cache-extra', 'sw-cache-poisoned', 'sw-navigation-only', 'sw-markup', 'sw-size', 'script-rewrite']
async function withWorker(script, { scope = '/', url = '/sw.js' } = {}) {
  // the rig registers through a page with CSP bypassed (the library's own worker-src names only its /sw.js)
  await page.goto('about:blank')
  const reg = await ctx.newPage()
  const cdp = await ctx.newCDPSession(reg)
  await cdp.send('Page.setBypassCSP', { enabled: true })
  state.lib.set(url, { body: Buffer.from(script), headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache' } })
  await reg.goto(`${LIB}/`)
  const okReg = await reg.evaluate(async ({ url, scope }) => {
    const r = await navigator.serviceWorker.register(url, { scope })
    const w = r.installing || r.waiting || r.active
    if (w && w.state !== 'activated') await new Promise((res) => w.addEventListener('statechange', () => w.state === 'activated' && res()))
    return url !== '/sw.js' || (await (await caches.open('bento-home-v1')).keys()).length === 2 || 'the precache is not there'
  }, { url, scope }).catch((e) => String(e))
  await reg.close()
  return okReg
}
/** A registration the row depends on must have happened: say so, rather than judge a page without it. */
function needWorker(r) { if (r !== true) ok(false, `the rig could not set up its worker: ${r}`) }
async function noWorkers() {
  // Cleared through the DevTools protocol, never from a page: a page on the library origin is a
  // navigation the old worker answers, and that navigation's update check can start an install
  // whose precache lands in the NEXT row's cache (seen: a poisoned entry overwritten mid-row).
  await page.goto('about:blank')
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Storage.clearDataForOrigin', { origin: LIB, storageTypes: 'service_workers,cache_storage' })
  await cdp.detach()
  await sleep(300)
}
/** A worker that answers NAVIGATIONS with the cached page edited by `pairs` ([from, to], each exactly once) and everything else honestly from the cache. */
const hostileWorker = (pairs, headerEdit = '') => SW_HONEST.replace("e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)))",
  `if (e.request.mode === 'navigate') {
    e.respondWith(caches.match('/').then(async (r) => {
      let t = await r.text()
      for (const [a, b] of ${JSON.stringify(pairs)}) t = t.replace(a, () => b)
      const h = new Headers(r.headers)
      ${headerEdit}
      return new Response(t, { headers: h })
    }))
    return
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)))`)

if (SW_ROWS.some(row)) {
  await page.goto('about:blank')
  if (row('sw-honest')) {
    section('sw-honest: the fixture precache worker (release F) serves the library  (positive control, a fixture worker present)')
    await fresh({ list: listF })
    ok(await withWorker(SW_HONEST) === true, 'the fixture worker registered and activated')
    const v = await visit(page, `${LIB}/`, { open: true })
    ok(v.lib?.page.viaWorker === true, 'the navigation was answered by the worker')
    ok(v.lib?.verdict === 'ok', `ok (got ${v.lib?.verdict} ${rules(v.lib)})`)
    ok(v.lib?.page.workers.length >= 1 && v.lib?.page.cache.length === 2, `the worker and both cache entries were read (${v.lib?.page.workers.length} worker(s), ${v.lib?.page.cache?.length} entries)`)
    ok(v.lib?.page.cspFrom === 'cache', `with a worker the CSP came from the fetch through it (${v.lib?.page.cspFrom}): webRequest does not see a worker's answer`)
    ok(v.frame?.verdict === 'ok', `the frame is unaffected (${v.frame?.verdict})`)
    await noWorkers()
  }
  if (row('sw-script-bytes')) {
    section('sw-script-bytes: the network now serves a different /sw.js  (rule: worker-bytes)')
    await fresh({ list: listF })
    needWorker(await withWorker(SW_HONEST))
    state.lib.set('/sw.js', { body: Buffer.from(SW_HONEST + '// changed\n'), headers: { 'content-type': 'text/javascript' } })
    const v = await visit(page, `${LIB}/`)
    ok(v.lib?.verdict === 'mismatch' && rules(v.lib).split(',').every((r) => r === 'worker-bytes') && rules(v.lib), `mismatch on worker-bytes only (got ${v.lib?.verdict} ${rules(v.lib)})`)
    await noWorkers()
  }
  if (row('sw-custom-path')) {
    section('sw-custom-path: a second worker registered at a path no release lists  (rule: worker)')
    await fresh({ list: listF })
    needWorker(await withWorker(SW_HONEST))
    needWorker(await withWorker('// a worker at a custom path\n', { url: '/x/sw2.js', scope: '/x/' }))
    // the rig's own setup, checked before the visit: both registrations exist
    const check = await ctx.newPage(); await check.goto(`${LIB}/`)
    const regs = await until(async () => { const n = await check.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope)); return n.length === 2 ? n : null }, 10000)
    await check.close()
    needWorker(regs ? true : 'the custom-path registration is not there before the visit')
    const v = await visit(page, `${LIB}/`)
    ok(v.lib?.verdict === 'mismatch' && rules(v.lib) === 'worker', `mismatch on worker only (got ${v.lib?.verdict} ${rules(v.lib)}); via worker ${v.lib?.page.viaWorker}, ${v.lib?.page.workers?.length} workers, ${v.lib?.page.cache?.length} cached, errors ${JSON.stringify(v.lib?.page.errors)})`)
    await noWorkers()
  }
  if (row('sw-cache-extra')) {
    section('sw-cache-extra: an entry no release lists, waiting in the worker\'s cache  (rule: cache)')
    await fresh({ list: listF })
    needWorker(await withWorker(SW_HONEST))
    const p = await ctx.newPage(); await p.goto(`${LIB}/`)
    await p.evaluate(async () => (await caches.open('bento-home-v1')).put('/later.js', new Response('/* waiting */')))
    await p.close()
    const v = await visit(page, `${LIB}/`)
    ok(v.lib?.verdict === 'mismatch' && rules(v.lib) === 'cache', `mismatch on cache only (got ${v.lib?.verdict} ${rules(v.lib)})`)
    await noWorkers()
  }
  if (row('sw-cache-poisoned')) {
    section('sw-cache-poisoned: one byte of the cached library page changed; the worker serves it  (rule: cache; nothing repaired)')
    await fresh({ list: listF })
    needWorker(await withWorker(SW_HONEST))
    const p = await ctx.newPage(); await p.goto(`${LIB}/`)
    const bad = variant(libDoc, 'Choose a file', 'Choose a filf').body.toString('utf8')
    await p.evaluate(async (bad) => { const c = await caches.open('bento-home-v1'); const r = await c.match('/'); await c.put('/', new Response(bad, { headers: r.headers })) }, bad)
    await p.close()
    await page.goto('about:blank')
    // count main-frame navigations: a reload the extension caused is one more than the visit's own,
    // whenever it lands (a marker alone can be set on the reloaded page)
    let navs = 0
    const onNav = (f) => { if (f === page.mainFrame()) navs++ }
    page.on('framenavigated', onNav)
    const v = await visit(page, `${LIB}/`, { marker: 'still here' })
    const shown = await page.evaluate(() => document.body.innerText.includes('Choose a filf')).catch(() => false)
    ok(v.lib?.page.viaWorker && shown, 'the worker served the poisoned page')
    ok(v.lib?.verdict === 'mismatch' && rules(v.lib) === 'cache', `mismatch on cache (got ${v.lib?.verdict} ${rules(v.lib)}); cached ${JSON.stringify(v.lib?.page.cache?.map((c) => `${c.url.slice(-12)}:${c.sha256.slice(0, 8)}`))}; via worker ${v.lib?.page.viaWorker}, ${v.lib?.page.workers?.length} workers, ${v.lib?.page.cache?.length} cached, errors ${JSON.stringify(v.lib?.page.errors)})`)
    ok(v.lib?.observed.bytes && !rules(v.lib).includes('bytes'), 'MEASURED: the content script\'s only-if-cached fetch does not pass through the page\'s worker; it read the HTTP cache\'s honest copy')
    await new Promise((r) => setTimeout(r, 1500))
    // a reload destroys the context mid-check: that is a FAIL row, never a crash (ruling C7)
    const after = await page.evaluate(async () => ({
      marker: window.__twMarker, regs: (await navigator.serviceWorker.getRegistrations()).length,
      cached: (await (await caches.open('bento-home-v1')).match('/').then((r) => r.text())).includes('Choose a filf'),
    })).catch((e) => ({ error: String(e?.message ?? e).slice(0, 80) }))
    page.off('framenavigated', onNav)
    ok(navs === 1 && after.marker === 'still here' && after.regs === 1 && after.cached, `nothing was "fixed": the page was not reloaded (${navs} navigation(s)), the worker is registered, the poisoned entry is still cached (${JSON.stringify(after)})`)
    await noWorkers()
  }
  if (row('sw-navigation-only')) {
    section('sw-navigation-only: a hostile worker changes one byte of the script for navigations only; the network /sw.js is honest again  (rule: scripts)')
    await fresh({ list: listF })
    const t = libDoc.body.toString('utf8')
    const at = t.indexOf('<script>') + '<script>'.length + 40
    const from = t.slice(at - 20, at + 20), to = t.slice(at - 20, at) + (t[at] === 'a' ? 'b' : 'a') + t.slice(at + 1, at + 20)
    needWorker(await withWorker(hostileWorker([[from, to]])))
    state.lib.set('/sw.js', { body: Buffer.from(SW_HONEST), headers: { 'content-type': 'text/javascript' } })
    const v = await visit(page, `${LIB}/`)
    ok(v.lib?.page.viaWorker === true, 'answered by the hostile worker')
    ok(v.lib?.verdict === 'mismatch' && rules(v.lib) === 'scripts', `mismatch on scripts only: bytes, size, CSP and cache all look honest (got ${v.lib?.verdict} ${rules(v.lib)})`)
    await noWorkers()
  }
  if (row('sw-markup')) {
    section('sw-markup: a hostile worker swaps page text for an <img onerror> of the same length  (rule: markup)')
    await fresh({ list: listF })
    const from = 'Only the code of signed Bento releases runs here,'
    const to = '<img src=x onerror="1">'.padEnd(from.length, ' ')
    needWorker(await withWorker(hostileWorker([[from, to]])))
    state.lib.set('/sw.js', { body: Buffer.from(SW_HONEST), headers: { 'content-type': 'text/javascript' } })
    const v = await visit(page, `${LIB}/`)
    ok(v.lib?.verdict === 'mismatch' && rules(v.lib).split(',').includes('markup') && rules(v.lib).replace('elements', '').replace(/^,|,$/g, '') === 'markup', `mismatch on markup (and the element it added) (got ${v.lib?.verdict} ${rules(v.lib)})`)
    await noWorkers()
  }
  if (row('sw-size')) {
    section('sw-size: a hostile worker adds text to the page (no script, no handler)  (rule: size)')
    await fresh({ list: listF })
    needWorker(await withWorker(hostileWorker([['Choose a file', 'Choose a file to send us']])))
    state.lib.set('/sw.js', { body: Buffer.from(SW_HONEST), headers: { 'content-type': 'text/javascript' } })
    const v = await visit(page, `${LIB}/`)
    ok(v.lib?.verdict === 'mismatch' && rules(v.lib) === 'size', `mismatch on size only (got ${v.lib?.verdict} ${rules(v.lib)})`)
    await noWorkers()
  }
  if (row('script-rewrite')) {
    section('script-rewrite: a hostile worker serves a script that runs, then rewrites its own text to the honest one  (rule: script-rewritten)')
    await fresh({ list: listF })
    const t = libDoc.body.toString('utf8')
    const s0 = t.indexOf('<script>') + '<script>'.length, s1 = t.indexOf('</script>', s0)
    const honestJs = t.slice(s0, s1)
    // same length, so only the parse can tell: the script reads the honest page through the worker
    // (a synchronous XHR, so it is done before the parse ends) and replaces its own text with the honest one
    const evil = "(function(){var s=document.currentScript,x=new XMLHttpRequest;x.open('GET','/',false);x.send();var t=x.responseText,a=t.indexOf('<scr'+'ipt>')+8;s.textContent=t.slice(a,t.indexOf('</'+'script>',a))})();/*"
    const pad = honestJs.length - evil.length - 2
    if (pad < 0) throw new Error('the honest script is too short for this row')
    const hostileJs = evil + ' '.repeat(pad) + '*/'
    // and it must run: the page's own meta CSP (script hash, Trusted Types) is blanked to the same length,
    // and the worker sends a header CSP that allows it. The content script's fetch reads the HTTP cache, which
    // holds the honest page and its honest CSP header.
    const meta = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/.exec(t)[0]
    const sw = hostileWorker([[honestJs, hostileJs], [meta, ' '.repeat(meta.length)]], `h.set('content-security-policy', "script-src 'unsafe-inline'; connect-src 'self'")`)
    needWorker(await withWorker(sw))
    state.lib.set('/sw.js', { body: Buffer.from(SW_HONEST), headers: { 'content-type': 'text/javascript' } })
    const v = await visit(page, `${LIB}/`)
    const ran = await page.evaluate((h) => document.querySelector('script')?.textContent === h, honestJs)
    ok(ran, 'the hostile script ran and its text now reads exactly as the honest one')
    ok(v.lib?.verdict === 'mismatch' && rules(v.lib).split(',').includes('markup') && v.lib?.page.flags.includes('script-rewritten'), `mismatch: a script rewrote itself (got ${v.lib?.verdict} ${rules(v.lib)} ${v.lib?.page.flags})`)
    await noWorkers()
  }
  if (row('sw-preload-vary')) {
    section('sw-preload-vary: a listed worker that answers navigations by navigation preload; then one text byte, sent `Vary: *` so the HTTP cache keeps no copy  (rule: bytes unread are waived only when the worker answered from somewhere webRequest did not see)')
    await fresh({ list: listP })
    ok(await withWorker(SW_PRELOAD) === true, 'the preload worker registered and activated')
    const h = await visit(page, `${LIB}/`)
    ok(h.lib?.verdict === 'ok' && h.lib.page.viaWorker === true && h.lib.page.cspFrom === 'navigation', `positive control: honest, answered by the worker, and webRequest saw the navigation (${h.lib?.verdict} ${rules(h.lib)} viaWorker ${h.lib?.page.viaWorker} cspFrom ${h.lib?.page.cspFrom})`)
    for (const p of ['/', '/index.html']) state.lib.set(p, variant(libDoc, 'Choose a file', 'Choose a filf', { vary: '*' }))
    await closeExtras(page)
    const v = await visit(page, `${LIB}/`)
    const served = await page.evaluate(() => document.body.innerHTML.includes('Choose a filf')).catch(() => null)
    ok(served === true && v.lib?.page.viaWorker === true && !v.lib?.observed.bytes, `the changed byte reached the page through the worker, and the cache holds no copy to read (served ${served}, bytes read ${v.lib?.observed.bytes})`)
    ok(v.lib?.verdict === 'mismatch' && rules(v.lib).split(',').includes('bytes-unread') && (v.lib.warned ?? []).includes('tab'), `a loud mismatch: bytes unread (${v.lib?.verdict} ${rules(v.lib)} ${v.lib?.warned})`)
    await noWorkers()
  }
}

if (row('shadow-root')) {
  section('shadow-root: a hostile worker puts a handler and a script inside a declarative shadow root, same length  (rule: shadow-root is markup)')
  await fresh({ list: listF })
  const t = libDoc.body.toString('utf8')
  const LONG = 'Only the code of signed Bento releases runs here, each document in its own sandbox. Saving changes is not available on this page yet: to edit, open the file in your browser directly or in the Bento app.'
  const meta = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/.exec(t)[0]
  const inj = '<div><template shadowrootmode="open"><img src=x onerror="document.title=\'DSD\'"><script>window.__dsd=1<\/script></template></div>'
  needWorker(await withWorker(hostileWorker([[LONG, inj.padEnd(LONG.length, ' ')], [meta, ' '.repeat(meta.length)]], `h.set('content-security-policy', "script-src 'unsafe-inline'")`)))
  state.lib.set('/sw.js', { body: Buffer.from(SW_HONEST), headers: { 'content-type': 'text/javascript' } })
  const v = await visit(page, `${LIB}/`)
  const ran = await page.evaluate(() => document.title === 'DSD').catch(() => false)
  ok(ran, 'the hidden handler ran (the attack is real)')
  ok(v.lib?.verdict === 'mismatch' && rules(v.lib).split(',').includes('markup') && v.lib.page.flags.includes('shadow-root'), `a shadow root is markup (${v.lib?.verdict} ${rules(v.lib)} ${v.lib?.page.flags})`)
  await noWorkers()
}

if (row('shadow-root-removed')) {
  section('shadow-root-removed: a hostile worker streams a declarative shadow root whose script removes its own host, same length  (rule: every element walked is checked for a shadow root)')
  await fresh({ list: listF })
  const t = libDoc.body.toString('utf8')
  const LONG = 'Only the code of signed Bento releases runs here, each document in its own sandbox. Saving changes is not available on this page yet: to edit, open the file in your browser directly or in the Bento app.'
  const meta = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/.exec(t)[0]
  const style = /<style>([\s\S]*?)<\/style>/.exec(t)[1]
  const SPLIT = '<template shadowrootmode'
  const inj = '<div id="h">' + '<p>'.repeat(300) + '<template shadowrootmode="open"><script>fetch("/evil-ran-dsdw");window.__evil=1;document.getElementById("h").remove()<\/script></template></div>'
  const room = LONG.length + style.length
  if (inj.length > room) throw new Error('the injection does not fit')
  const pairs = [[style, ''], [LONG, inj.padEnd(room, ' ')], [meta, ' '.repeat(meta.length)]]
  const sw = SW_HONEST.replace("e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)))",
    `if (e.request.mode === 'navigate') {
    e.respondWith(caches.match('/').then(async (r) => {
      let t = await r.text()
      for (const [a, b] of ${JSON.stringify(pairs)}) t = t.replace(a, () => b)
      const h = new Headers(r.headers)
      h.set('content-security-policy', "script-src 'unsafe-inline'; connect-src 'self'")
      const i = t.indexOf(${JSON.stringify(SPLIT)})
      const enc = new TextEncoder()
      const s = new ReadableStream({ async start(c) { c.enqueue(enc.encode(t.slice(0, i))); await new Promise((z) => setTimeout(z, 800)); c.enqueue(enc.encode(t.slice(i))); c.close() } })
      return new Response(s, { headers: h })
    }))
    return
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)))`)
  needWorker(await withWorker(sw))
  state.lib.set('/sw.js', { body: Buffer.from(SW_HONEST), headers: { 'content-type': 'text/javascript' } })
  const h0 = state.hits.length
  const v = await visit(page, `${LIB}/`)
  const ran = state.hits.slice(h0).includes('lib /evil-ran-dsdw') || await page.evaluate(() => !!window.__evil).catch(() => false)
  ok(ran && v.lib?.page.viaWorker, 'the hidden script ran under the worker and removed its host (the attack is real)')
  ok(v.lib?.verdict === 'mismatch' && v.lib.page.flags.includes('shadow-root'), `a removed shadow host is still flagged (${v.lib?.verdict} ${rules(v.lib)} ${v.lib?.page.flags})`)
  await noWorkers()
}

if (row('sw-element')) {
  section('sw-element: a hostile worker turns page text into an element, same length, no script, no handler  (rule: the element sequence, in the full report)')
  await fresh({ list: listF })
  needWorker(await withWorker(hostileWorker([['Only the code', '<b>Only</b> c']])))
  state.lib.set('/sw.js', { body: Buffer.from(SW_HONEST), headers: { 'content-type': 'text/javascript' } })
  const v = await visit(page, `${LIB}/`)
  ok(v.lib?.verdict === 'mismatch' && rules(v.lib) === 'elements', `mismatch on elements only (got ${v.lib?.verdict} ${rules(v.lib)})`)
  await noWorkers()
}


// --- stage 3: the build's own worker in control (security ruling #954, C1 and C2) -----------------
// A returning visitor: the library's own /sw.js registered, activated and controlling, with
// navigation preload on, so webRequest sees each navigation as the tab's own main frame. Then a
// hostile response, which must reach the page (the positive control in each row) and be a mismatch.
// The C1 build mutant (TW_BUILD_MUTANT: the worker without navigation preload) turns the rows
// whose response the HTTP cache keeps no copy of, and the cross-site one, green-for-the-attacker.
const STAGE3 = ['stage3-honest', 'stage3-index', 'stage3-csp', 'stage3-csp-nostore', 'stage3-vary-text', 'stage3-nostore-text', 'stage3-text', 'stage3-vary-text-index', 'stage3-text-index', 'stage3-cross-site-no-store']
/** Prime a returning visitor; returns the controlling worker's script URL, or null. */
async function prime() {
  await fresh()
  await page.goto(`${LIB}/`)
  const ctl = await until(async () => {
    if (await page.evaluate(() => document.documentElement.getAttribute('data-bento-sw')) !== 'registered') return null
    return page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return r.active?.state === 'activated' ? r.active.scriptURL : null })
  }, 20000)
  await page.goto('about:blank')
  return ctl
}
/** The build's own worker is the one in control of the page (its cache is the build's, never the fixture's). */
const realWorkerInControl = (p) => p.evaluate(async () => ({
  controller: navigator.serviceWorker.controller?.scriptURL ?? null,
  caches: await caches.keys(),
})).then((r) => (r.controller === `${LIB}/sw.js` && r.caches.includes(infoA.offline.cache) && !r.caches.includes('bento-home-v1') ? true : JSON.stringify(r))).catch((e) => String(e))
const cspWide = () => libDoc.headers['content-security-policy'].replace(/connect-src [^;]+/, 'connect-src *')
const textByte = (headers = {}) => variant(libDoc, 'Choose a file', 'Choose a filf', headers)
const showsFilf = (p) => p.evaluate(() => document.body.innerHTML.includes('Choose a filf')).catch(() => null)
const ROWS3 = [
  ['stage3-csp', 'the library CSP widened (connect-src *), bytes identical, cacheable', () => ({ body: libDoc.body, headers: { ...libDoc.headers, 'content-security-policy': cspWide() } }),
    async (p) => (await p.evaluate(() => 1)) === 1, (r) => r === 'csp'],
  ['stage3-csp-nostore', 'the library CSP widened, bytes identical, Cache-Control: no-store', () => ({ body: libDoc.body, headers: { ...libDoc.headers, 'cache-control': 'no-store', 'content-security-policy': cspWide() } }),
    async (p) => (await p.evaluate(() => 1)) === 1, (r) => r.split(',').includes('cache-control') && r.split(',').includes('csp')],
  ['stage3-vary-text', 'one byte of text, no-cache plus Vary: * (the HTTP cache keeps no copy)', () => textByte({ vary: '*' }), showsFilf, (r) => r.split(',').includes('bytes-unread')],
  ['stage3-nostore-text', 'one byte of text, Cache-Control: no-store', () => textByte({ 'cache-control': 'no-store' }), showsFilf, (r) => r.split(',').includes('cache-control')],
  ['stage3-text', 'one byte of text, the headers as shipped', () => textByte(), showsFilf, (r) => r === 'bytes'],
  // the same two at /index.html, the page's other name, which the worker answers as '/' (security ruling on #964, M1)
  ['stage3-vary-text-index', 'at /index.html, one byte of text, no-cache plus Vary: *', () => textByte({ vary: '*' }), showsFilf, (r) => r.split(',').includes('bytes-unread'), '/index.html'],
  ['stage3-text-index', 'at /index.html, one byte of text, the headers as shipped', () => textByte(), showsFilf, (r) => r === 'bytes', '/index.html'],
]
if (STAGE3.some(row)) {
  if (row('stage3-honest')) {
    section('stage3-honest: a returning visitor, the build\'s own worker in control, the honest release  (positive control: webRequest sees the preload navigation)')
    const ctl = await prime()
    ok(ctl === `${LIB}/sw.js`, `the library's own worker is active: ${ctl}`)
    await fresh({ keepWorkers: true })
    const v = await visit(page, `${LIB}/`, { open: true })
    ok(await realWorkerInControl(page) === true, `the build's own worker controls the page, with the build's cache (${await realWorkerInControl(page)})`)
    ok(v.lib?.verdict === 'ok' && v.lib.page.viaWorker === true && v.lib.page.cspFrom === 'navigation', `ok, answered by the worker, and the CSP came from the navigation webRequest saw (${v.lib?.verdict} ${rules(v.lib)} viaWorker ${v.lib?.page.viaWorker} cspFrom ${v.lib?.page.cspFrom})`)
    ok(v.lib?.observed.bytes && (v.lib.page.workers ?? []).length === 1, `bytes read, one worker read (${JSON.stringify(v.lib?.observed)}, ${v.lib?.page.workers?.length} worker(s))`)
    ok(v.frame?.verdict === 'ok', `the frame is unaffected (${v.frame?.verdict})`)
    // a second visit and a forced update check: still nothing to say (/index.html is stage3-index's)
    await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.update())).catch(() => {})
    const v2 = await visit(page, `${LIB}/`)
    ok(v2.lib?.verdict === 'ok' && v2.lib.page.viaWorker === true, `a second visit after an update check: ok (${v2.lib?.verdict} ${rules(v2.lib)} errors ${JSON.stringify(v2.lib?.page?.errors)})`)
  }
  if (row('stage3-index')) {
    // An honest returning visitor opening /index.html, the library page by its other name, eight times,
    // each a fresh returning visitor that has never fetched /index.html. Before the worker answered
    // /index.html as '/', its navigation fell through the worker and the preload response was often not
    // kept in the HTTP cache: bytes unread, a loud "unverified" tab on an honest page (security measured
    // 4 in 8). The build mutant that drops that line must turn this row red.
    section('stage3-index: an honest returning visitor opens /index.html, eight times  (security ruling on #964, M1: no false "unverified")')
    const tally = {}
    let read = 0, via = 0
    for (let i = 0; i < 8; i++) {
      const ctl = await prime()
      if (ctl !== `${LIB}/sw.js`) { tally[`no worker (${ctl})`] = (tally[`no worker (${ctl})`] ?? 0) + 1; continue }
      await fresh({ keepWorkers: true })
      const v = await visit(page, `${LIB}/index.html`)
      const k = `${v.lib?.verdict}[${rules(v.lib)}]${(v.lib?.warned ?? []).includes('tab') ? '+tab' : ''}`
      tally[k] = (tally[k] ?? 0) + 1
      if (v.lib?.observed?.bytes) read++
      if (v.lib?.page?.viaWorker === true) via++
    }
    ok(via === 8, `every visit was a page the build's own worker controls, so the row ran what it names (${via}/8)`)
    ok(tally['ok[]'] === 8, `eight honest visits, eight quiet ok verdicts, no tab (${JSON.stringify(tally)})`)
    ok(read === 8, `the page's bytes were read on every visit (${read}/8)`)
  }
  for (const [name, what, make, served, expect, at = '/'] of ROWS3) {
    if (!row(name)) continue
    section(`${name}: ${what}, the build's own worker in control  (security ruling #954)`)
    const ctl = await prime()
    ok(ctl === `${LIB}/sw.js`, `the library's own worker is active before the row (${ctl})`)
    await fresh({ keepWorkers: true, lib: both(make()) })
    const v = await visit(page, `${LIB}${at}`)
    const s = await served(page)
    ok(s === true && v.lib?.page.viaWorker === true, `the hostile response reached the page, through the worker (served ${s}, viaWorker ${v.lib?.page.viaWorker}, cspFrom ${v.lib?.page.cspFrom})`)
    ok(v.lib?.verdict === 'mismatch' && expect(rules(v.lib)) && (v.lib.warned ?? []).includes('tab'), `a loud mismatch (${v.lib?.verdict} [${rules(v.lib)}] ${v.lib?.warned})`)
  }
  if (row('stage3-cross-site-no-store')) {
    section('stage3-cross-site-no-store: reached by a link from another site, one byte changed and sent no-store, the build\'s own worker in control  (security ruling #954)')
    const ctl = await prime()
    ok(ctl === `${LIB}/sw.js`, `the library's own worker is active before the row (${ctl})`)
    await fresh({ keepWorkers: true, lib: both(textByte({ 'cache-control': 'no-store' })) })
    state.frame.set('/opener', { body: Buffer.from(`<!doctype html><a id=l href="${LIB}/">link</a>`), headers: { 'content-type': 'text/html' } })
    await page.goto(`${FRM}/opener`)
    const t0 = Date.now()
    await Promise.all([page.waitForURL(`${LIB}/`, { timeout: 20000 }).catch(() => {}), page.click('#l')])
    const ev = await until(async () => (await since(t0)).find((e) => e.url === `${LIB}/` && !e.early), 40000)
    const s = await showsFilf(page)
    ok(s === true && ev?.page?.viaWorker === true, `the hostile response reached the page, through the worker (served ${s}, viaWorker ${ev?.page?.viaWorker})`)
    ok(ev?.verdict === 'mismatch' && ev.page.crossSite === true && rules(ev).split(',').includes('cache-control'), `a mismatch, seen as cross-site, on its Cache-Control (${ev?.verdict} [${rules(ev)}] crossSite ${ev?.page?.crossSite})`)
  }
  await fresh()
}


// --- C5: the library worker's own requests (security ruling #954, F-W the cloaked worker) -----------
// The server answers the browser's own fetch of /sw.js (Service-Worker: script) with a different worker
// than everyone else gets, the extension's fetch included, so the worker-bytes rule sees the release's
// bytes. What the tripwire can still see is what that worker DOES: its own requests (webRequest, tabId -1,
// initiator the library origin), held to the honest worker's: GET, no query, a path the release serves,
// and /sw.js only as the browser's worker-script fetch.
const C5_ROWS = ['c5-honest-worker', 'sw-cloak', 'sw-cloak-launder', 'worker-query', 'worker-unlisted-path', 'worker-post', 'worker-header', 'worker-header-held', 'preload-header', 'worker-cookie', 'worker-referer', 'c5-honest-soft-update', 'c5-honest-manifest', 'page-manifest-query', 'c5-honest-own-url', 'nav-meta-refresh', 'nav-refresh-header', 'nav-client-navigate', 'c5-honest-reload', 'nav-sub-frame', 'nav-sw-redirect', 'nav-sw-redirect-net', 'nav-sw-redirect-bounce', 'c5-honest-server-redirect', 'c5-reload-after-stop']
const workerEvents = async (t0) => (await since(t0)).filter((e) => e.role === 'worker')
/** The build's worker with `extra` appended: installs (its precache matches its pins) and runs `extra` too. */
const cloakOf = (extra) => ({ body: Buffer.concat([BUILD_SW, Buffer.from(`\n${extra}\n`)]), headers: { ...honest.lib.get('/sw.js').headers } })
/** Install a cloaked worker on a first visit, then visit again under it; returns this row's worker events and server hits. */
async function underCloak(extra) {
  await fresh()
  state.cloak = cloakOf(extra)
  const t0 = Date.now(), h0 = state.hits.length, k0 = state.heads.length
  await page.goto(`${LIB}/`)
  const ctl = await until(async () => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state === 'activated'), 20000)
  await page.goto('about:blank')
  const k1 = state.heads.length
  const v = await visit(page, `${LIB}/`)
  await sleep(2000)
  return { ctl, v, evs: await workerEvents(t0), hits: state.hits.slice(h0), heads: state.heads.slice(k0), visitHeads: state.heads.slice(k1) }
}
const whys = (evs) => evs.flatMap((e) => e.failures.map((f) => f.why ?? f.rule))
if (C5_ROWS.some(row)) {
  if (row('c5-honest-worker')) {
    section('c5-honest-worker: the build\'s own worker installs, answers two visits and an update check  (rule: its own requests are all allowed; positive control)')
    await fresh()
    // MEASURED, and printed: the header names the extension sees on the worker's requests (tabId -1),
    // the set the C5 hold is held to; under TW_H2 over HTTPS and HTTP/2 (security's review of #983, M5)
    await sw.evaluate((lib) => {
      globalThis.__twSeen = []
      globalThis.__twSeenFn ??= (d) => { if (d.tabId === -1) globalThis.__twSeen.push(`${new URL(d.url).pathname} ${d.type}: ${(d.requestHeaders ?? []).map((x) => x.name.toLowerCase()).sort().join(',')}`) }
      chrome.webRequest.onSendHeaders.addListener(globalThis.__twSeenFn, { urls: [`${lib}/*`], tabId: -1 }, ['requestHeaders', 'extraHeaders'])
    }, LIB)
    const t0 = Date.now(), h0 = state.hits.length, k0 = state.heads.length
    const ctl = await prime()
    await fresh({ keepWorkers: true })
    const t1 = Date.now()
    const v1 = await visit(page, `${LIB}/`)
    await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.update())).catch(() => {})
    await sleep(1500)
    // `/` again, not /index.html: MEASURED, a preload navigation to a path the HTTP cache has never held is
    // sometimes not stored there (here 2 in 8, after update() and a pause), so its bytes read as unread: an
    // "unverified" warning on an honest page, from the C2 rule, not this one. Recorded in the PR and notes.
    const v2 = await visit(page, `${LIB}/`)
    await sleep(1500)
    const hits = state.hits.slice(h0)
    const precache = infoA.offline.precache.map((p) => p.path ?? p)
    ok(ctl === `${LIB}/sw.js` && precache.every((p) => hits.includes(`lib ${p}`)), `the worker installed: the server saw its precache fetches (${precache.join(' ')}) and it controls the page`)
    ok(hits.filter((h) => h === 'lib /sw.js').length >= 3, `and /sw.js fetched again: the browser's update check and the extension's own read (${hits.filter((h) => h === 'lib /sw.js').length} times)`)
    ok(v1.lib?.verdict === 'ok' && v2.lib?.verdict === 'ok' && v1.lib.page.viaWorker, `both visits ok (${v1.lib?.verdict} [${rules(v1.lib)}] ${v2.lib?.verdict} [${rules(v2.lib)}] errors ${JSON.stringify(v2.lib?.page?.errors)})`)
    const evs = (await since(t0)).filter((e) => e.role === 'worker')
    ok(evs.length === 0 && reportTabs().length === 0, `no worker-request finding, no report tab (${JSON.stringify(evs.map((e) => [e.url, whys([e])]))})`)
    void t1
    const seen = await sw.evaluate(() => { chrome.webRequest.onSendHeaders.removeListener(globalThis.__twSeenFn); return globalThis.__twSeen })
    for (const x of [...new Set(seen)]) note(`extension saw (tabId -1) ${x}`)
    const libHeads = state.heads.slice(k0).filter((q) => q.key === 'lib')
    note(`the library server saw HTTP ${[...new Set(libHeads.map((q) => q.v))].join(', ')}; header names on the worker's /sw.js and precache requests: ${[...new Set(libHeads.filter((q) => q.h['sec-fetch-dest'] !== 'document').map((q) => Object.keys(q.h).filter((k) => !k.startsWith(':')).sort().join(',')))].join(' | ')}`)
    ok(seen.length >= precache.length, `positive control on the measurement: the extension saw the worker's requests (${seen.length})`)
    if (H2) ok(libHeads.length > 0 && libHeads.every((q) => q.v === '2.0'), `TW_H2: every library request came over HTTP/2 (${[...new Set(libHeads.map((q) => q.v))].join(', ')})`)
  }
  if (row('c5-honest-soft-update')) {
    section('c5-honest-soft-update: the build\'s worker installs on a first visit; the next navigation brings the browser\'s soft update  (rule: its Referer, the script\'s own URL, is the browser\'s)')
    await fresh()
    const t0 = Date.now(), k0 = state.heads.length
    await page.goto(`${LIB}/`)
    const ctl = await until(async () => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state === 'activated'), 20000)
    await page.goto('about:blank')
    const v = await visit(page, `${LIB}/`)
    await sleep(2000)
    // MEASURED (Chromium 149): this sequence's second /sw.js script fetch carries Referer: <the script's URL>
    const soft = state.heads.slice(k0).filter((q) => q.key === 'lib' && q.p === '/sw.js' && q.h['service-worker'] === 'script' && q.h.referer === `${LIB}/sw.js`).length
    ok(ctl && soft > 0, `the worker installed, and the browser's update check named the script as its Referer (${soft} time(s))`)
    const evs = await workerEvents(t0)
    ok(v.lib?.verdict === 'ok' && evs.length === 0 && reportTabs().length === 0, `the visit ok, no worker-request finding, no report tab (${v.lib?.verdict} [${rules(v.lib)}] ${JSON.stringify(evs.map((e) => [e.url, whys([e])]))})`)
  }
  if (row('sw-cloak')) {
    section('sw-cloak: the browser\'s worker fetch gets the release\'s worker plus a fetch listener that beacons home  (rule: a worker request to a path no release serves)')
    const r = await underCloak('self.addEventListener("fetch",()=>{fetch("/sw-evil-beacon",{cache:"no-store"}).catch(()=>{})})')
    const beacons = r.hits.filter((h) => h === 'lib /sw-evil-beacon').length
    ok(r.ctl && beacons > 0, `the cloaked worker is installed and ran its own code (beacons at the server: ${beacons})`)
    const ev = r.evs.find((e) => e.url === `${LIB}/sw-evil-beacon`)
    ok(ev?.verdict === 'mismatch' && whys([ev]).includes('a path no release serves') && ev.class === 'tampered' && (ev.warned ?? []).includes('tab'), `a loud mismatch on the worker's request (${ev?.verdict} ${JSON.stringify(ev && whys([ev]))} ${ev?.class} ${ev?.warned})`)
    ok(r.evs.length === 1, `recorded once for its kind, however often it fired (${r.evs.length})`)
  }
  if (row('sw-cloak-launder')) {
    section('sw-cloak-launder: the cloaked worker re-fetches /sw.js itself on activate  (rule: the worker script only as the browser\'s worker-script fetch)')
    const r = await underCloak('self.addEventListener("activate",(e)=>e.waitUntil(fetch("/sw.js",{cache:"reload"}).catch(()=>{})))')
    ok(r.ctl, 'the cloaked worker is installed')
    const ev = r.evs.find((e) => e.url === `${LIB}/sw.js`)
    ok(ev?.verdict === 'mismatch' && whys([ev]).some((w) => /not fetched as the browser's worker script/.test(w)), `a mismatch on its own /sw.js fetch (${JSON.stringify(r.evs.map((e) => [e.url, whys([e])]))})`)
  }
  for (const [name, extra, url, why] of [
    ['worker-query', 'self.addEventListener("activate",(e)=>e.waitUntil(fetch("/index.html?x=1").catch(()=>{})))', `${LIB}/index.html?x=1`, 'a query'],
    ['worker-unlisted-path', 'self.addEventListener("activate",(e)=>e.waitUntil(fetch("/not-in-release").catch(()=>{})))', `${LIB}/not-in-release`, 'a path no release serves'],
    ['worker-post', 'self.addEventListener("activate",(e)=>e.waitUntil(fetch("/",{method:"POST",body:"x"}).catch(()=>{})))', `${LIB}/`, 'not GET'],
  ]) {
    if (!row(name)) continue
    section(`${name}: the cloaked worker fetches ${url.replace(LIB, '')}${name === 'worker-post' ? ' by POST' : ''} on activate  (rule: ${why})`)
    const r = await underCloak(extra)
    const seen = r.hits.some((h) => h === `lib ${new URL(url).pathname}`)
    ok(r.ctl && seen, `the cloaked worker is installed and made the request (server saw it: ${seen})`)
    const ev = r.evs.find((e) => e.url === url && whys([e]).includes(why))
    ok(ev?.verdict === 'mismatch' && (ev.warned ?? []).length > 0, `a mismatch: ${why} (${JSON.stringify(r.evs.map((e) => [e.url, whys([e])]))})`)
  }
  // security ruling on #983, M1: bytes in the request HEADERS of a request the allowlist permits
  if (row('worker-header')) {
    section('worker-header: the cloaked worker GETs /index.html (allowed: listed, no query) with a header of its own  (rule: its headers held to the honest worker\'s)')
    const r = await underCloak('self.addEventListener("activate",(e)=>e.waitUntil(fetch("/index.html",{cache:"no-store",headers:{"x-exfil":"secret-hdr-1"}}).catch(()=>{})))')
    const sent = r.heads.filter((q) => q.p === '/index.html' && q.h['x-exfil'] === 'secret-hdr-1').length
    ok(r.ctl && sent > 0, `the cloaked worker is installed and the header reached the server (${sent} time(s))`)
    const ev = r.evs.find((e) => e.url === `${LIB}/index.html`)
    ok(ev?.verdict === 'mismatch' && whys([ev]).includes('a header the honest worker does not send: x-exfil') && ev.class === 'tampered' && (ev.warned ?? []).includes('tab'), `a loud mismatch on the header (${JSON.stringify(r.evs.map((e) => [e.url, whys([e])]))})`)
  }
  if (row('worker-header-held')) {
    section('worker-header-held: the cloaked worker puts its bytes in headers the honest one does send (Accept, Accept-Language, User-Agent)  (rule: held to their honest values)')
    const r = await underCloak('self.addEventListener("activate",(e)=>e.waitUntil(Promise.all([["accept","secret-a","/manifest.webmanifest"],["accept-language","secret-l","/icon-192.png"],["user-agent","secret-u","/icon-512.png"]].map(([k,v,u])=>fetch(u,{cache:"no-store",headers:{[k]:v}}).catch(()=>{})))))')
    const at = { accept: '/manifest.webmanifest', 'accept-language': '/icon-192.png', 'user-agent': '/icon-512.png' }
    // MEASURED here: which of the three the browser lets a worker set (the rest it overrides)
    const reached = Object.keys(at).filter((k) => r.heads.some((q) => q.p === at[k] && String(q.h[k] ?? '').startsWith('secret-')))
    note(`the server saw the worker's own value for: ${reached.join(', ') || 'none'}`)
    ok(r.ctl && reached.includes('accept') && reached.includes('accept-language'), `the cloaked worker is installed and its Accept and Accept-Language values reached the server (${reached.join(', ')})`)
    for (const k of reached) {
      const ev = r.evs.find((e) => e.url === `${LIB}${at[k]}`)
      ok(ev?.verdict === 'mismatch' && whys([ev]).includes(`a header the honest worker does not send: ${k} with another value`), `${k}: a mismatch on its value (${JSON.stringify(ev && whys([ev]))})`)
    }
  }
  if (row('preload-header')) {
    section('preload-header: the cloaked worker sets the navigation preload header value  (rule: Service-Worker-Navigation-Preload is the browser\'s true)')
    const r = await underCloak('self.addEventListener("activate",(e)=>e.waitUntil(self.registration.navigationPreload.enable().then(()=>self.registration.navigationPreload.setHeaderValue("secret-pre-2"))))')
    const sent = r.visitHeads.filter((q) => q.p === '/' && q.h['service-worker-navigation-preload'] === 'secret-pre-2').length
    ok(r.ctl && sent > 0, `the cloaked worker is installed and the tab's navigation carried its value to the server (${sent} time(s))`)
    ok(r.v.lib?.verdict === 'mismatch' && rules(r.v.lib).split(',').includes('preload-header') && (r.v.lib.warned ?? []).includes('tab'), `the page: a loud mismatch on preload-header (${r.v.lib?.verdict} [${rules(r.v.lib)}] ${r.v.lib?.warned})`)
  }
  // security's second review of #983 (M4): forbidden header NAMES whose VALUES a worker chooses
  if (row('worker-cookie')) {
    section('worker-cookie: the cloaked worker sets a cookie (cookieStore) and GETs a listed path with it  (rule: no Cookie on the worker\'s requests, nor on the library\'s navigation)')
    const r = await underCloak('self.addEventListener("activate",(e)=>e.waitUntil(self.cookieStore.set({name:"x",value:"secret-ck-1"}).then(()=>fetch("/manifest.webmanifest",{cache:"no-store",credentials:"include"})).catch(()=>{})))')
    const sent = r.heads.filter((q) => String(q.h.cookie ?? '').includes('secret-ck-1'))
    const onVisit = r.visitHeads.filter((q) => q.p === '/' && String(q.h.cookie ?? '').includes('secret-ck-1')).length
    ok(r.ctl && sent.some((q) => q.p === '/manifest.webmanifest') && onVisit > 0, `the cloaked worker is installed and its cookie reached the server (${sent.map((q) => q.p).join(' ')}; on the judged navigation ${onVisit})`)
    const ev = r.evs.find((e) => e.url === `${LIB}/manifest.webmanifest`)
    ok(ev?.verdict === 'mismatch' && whys([ev]).includes('a header the honest worker does not send: cookie') && ev.class === 'tampered' && (ev.warned ?? []).includes('tab'), `the worker's request: a loud mismatch on its Cookie (${JSON.stringify(r.evs.map((e) => [e.url, whys([e])]))})`)
    ok(r.v.lib?.verdict === 'mismatch' && rules(r.v.lib).split(',').includes('request-cookie'), `the next visit: a mismatch on the navigation's Cookie (${r.v.lib?.verdict} [${rules(r.v.lib)}])`)
    ok(!JSON.stringify(await store.log()).includes('secret-ck-1'), 'the record names no cookie value')
  }
  if (row('worker-referer')) {
    section('worker-referer: the cloaked worker GETs a listed path with a Referer of its own (fetch referrer, unsafe-url)  (rule: no Referer on the worker\'s requests)')
    const r = await underCloak('self.addEventListener("activate",(e)=>e.waitUntil(fetch("/manifest.webmanifest",{cache:"no-store",referrer:"/secret-ref-2?x=secret-ref-q",referrerPolicy:"unsafe-url"}).catch(()=>{})))')
    const sent = r.heads.filter((q) => q.p === '/manifest.webmanifest' && String(q.h.referer ?? '').includes('secret-ref')).length
    ok(r.ctl && sent > 0, `the cloaked worker is installed and its Referer reached the server (${sent} time(s))`)
    const ev = r.evs.find((e) => e.url === `${LIB}/manifest.webmanifest`)
    ok(ev?.verdict === 'mismatch' && whys([ev]).includes('a header the honest worker does not send: referer') && ev.class === 'tampered' && (ev.warned ?? []).includes('tab'), `a loud mismatch on its Referer (${JSON.stringify(r.evs.map((e) => [e.url, whys([e])]))})`)
  }
  // security's third review of #983 (M6): a cloaked worker rewrites an attribute VALUE of the page it
  // answers (no request of its own, the residual M2 accepted), and the BROWSER then fetches what the page
  // names: Chrome's own manifest fetch, a tab request (tabId = the tab, type other), carries the bytes
  const pageEvents = async (t0) => (await since(t0)).filter((e) => e.role === 'page-request')
  /** Record what webRequest shows of the library's tab (non-document) requests, for a positive control. */
  const watchTabRequests = () => sw.evaluate((lib) => {
    globalThis.__twTab = []
    globalThis.__twTabFn ??= (d) => { if (d.tabId >= 0 && d.type !== 'main_frame' && d.type !== 'sub_frame') globalThis.__twTab.push(`${d.type} ${d.method} ${d.url.replace(lib, '')}`) }
    chrome.webRequest.onSendHeaders.addListener(globalThis.__twTabFn, { urls: [`${lib}/*`] }, ['requestHeaders', 'extraHeaders'])
  }, LIB)
  const tabRequestsSeen = () => sw.evaluate(() => { chrome.webRequest.onSendHeaders.removeListener(globalThis.__twTabFn); return globalThis.__twTab })
  if (row('c5-honest-manifest')) {
    section('c5-honest-manifest: a first visit installs the build\'s worker, a second visit under it; the browser fetches the page\'s manifest  (rule: the page\'s own requests allowed; honest control for M6)')
    await fresh()
    await watchTabRequests()
    const t0 = Date.now(), k0 = state.heads.length
    const v1 = await visit(page, `${LIB}/`)
    const ctl = await until(async () => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state === 'activated'), 20000)
    await page.goto('about:blank')
    const v2 = await visit(page, `${LIB}/`)
    await sleep(2500)
    const seen = await tabRequestsSeen()
    for (const x of [...new Set(seen)]) note(`extension saw (a tab, not a document) ${x}`)
    const mf = state.heads.slice(k0).filter((q) => q.key === 'lib' && q.p === '/manifest.webmanifest' && q.h['sec-fetch-dest'] === 'manifest')
    // positive control: the request this rule judges happened, and the extension saw it as a tab request
    ok(mf.length > 0 && seen.some((x) => x.startsWith('other GET /manifest.webmanifest')), `the browser's own manifest fetch reached the server (${mf.length}) and webRequest showed it as a tab request (${seen.filter((x) => /manifest/.test(x)).join(' | ')})`)
    ok(ctl && v1.lib?.verdict === 'ok' && v2.lib?.verdict === 'ok' && v2.lib.page.viaWorker === true, `the worker installed; both visits ok, the second through it (${v1.lib?.verdict} [${rules(v1.lib)}] ${v2.lib?.verdict} [${rules(v2.lib)}] viaWorker ${v2.lib?.page?.viaWorker})`)
    const evs = await pageEvents(t0)
    ok(evs.length === 0 && reportTabs().length === 0, `no page-request finding, no report tab (${JSON.stringify(evs.map((e) => [e.url, whys([e])]))})`)
  }
  if (row('c5-honest-own-url')) {
    section('c5-honest-own-url: honest visits to /?from=link, and to an unlisted path (a 404)  (rule: the content script\'s re-read of the tab\'s own URL is not a request the page named)')
    await fresh()
    await watchTabRequests()
    const t0 = Date.now()
    const v = await visit(page, `${LIB}/?from=link`)
    await page.goto(`${LIB}/no-such-page`).catch(() => {})
    await sleep(3000)
    const seen = await tabRequestsSeen()
    for (const x of [...new Set(seen)]) note(`extension saw (a tab, not a document) ${x}`)
    // MEASURED (Chromium 149): the re-read of a 404 shows no tab request at all; the query visit's does
    note(`the 404's re-read reached webRequest: ${seen.some((x) => x.startsWith('xmlhttprequest GET /no-such-page'))}`)
    ok(seen.includes('xmlhttprequest GET /?from=link'), 'positive control: webRequest showed the content script\'s re-read of /?from=link as a tab request')
    const evs = await pageEvents(t0)
    ok(evs.length === 0 && reportTabs().length === 0, `no page-request finding, no report tab (${v.lib?.verdict} [${rules(v.lib)}]; ${JSON.stringify(evs.map((e) => [e.url, whys([e])]))})`)
  }
  if (row('page-manifest-query')) {
    section('page-manifest-query: a cloaked worker answers the navigation from its preload with the manifest href carrying a query (same length), and lets the manifest fetch through  (rule: the page\'s own requests: no query)')
    await fresh()
    // the handler goes FIRST, ahead of the build's own fetch listener: it answers the navigation itself
    // and returns before the build's handler for the manifest, so the browser's fetch reaches the network
    const wrap = (handler) => `{const _ael=self.addEventListener.bind(self);self.addEventListener=(t,f,o)=>t==="fetch"?_ael(t,(e)=>{${handler};f(e)},o):_ael(t,f,o)}\n`
    const handler = `const u=new URL(e.request.url);if(u.pathname==="/manifest.webmanifest")return;if(e.request.mode==="navigate"&&u.pathname==="/"){e.respondWith((e.preloadResponse||Promise.resolve()).then((r)=>r||fetch(e.request)).then(async(r)=>new Response((await r.text()).replace('href="/manifest.webmanifest"','href="/manifest.webmanifest?s=secret-mf-1234"').replace(', initial-scale=1"','"'),{status:r.status,headers:r.headers})));return}`
    state.cloak = { body: Buffer.concat([Buffer.from(wrap(handler)), BUILD_SW]), headers: { ...honest.lib.get('/sw.js').headers } }
    const t0 = Date.now()
    await page.goto(`${LIB}/`)
    const ctl = await until(async () => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state === 'activated'), 20000)
    await page.goto('about:blank')
    const k1 = state.heads.length
    const v = await visit(page, `${LIB}/`)
    const href = await page.evaluate(() => document.querySelector('link[rel=manifest]')?.getAttribute('href')).catch((e) => String(e))
    await until(async () => (await pageEvents(t0)).length > 0, 8000)
    await sleep(1000)
    const got = state.heads.slice(k1).filter((q) => q.key === 'lib' && String(q.u).includes('secret-mf-1234') && q.h['sec-fetch-dest'] === 'manifest')
    const rawHits = state.heads.slice(k1).filter((q) => q.key === 'lib' && q.p === '/manifest.webmanifest').length
    ok(ctl && href === '/manifest.webmanifest?s=secret-mf-1234' && v.lib?.page?.viaWorker === true, `the cloaked worker is installed and answered the page with the rewritten href (${href}, viaWorker ${v.lib?.page?.viaWorker})`)
    ok(got.length > 0, `and the browser's own manifest fetch carried it to the server (${got.length} of ${rawHits} manifest requests)`)
    const evs = await pageEvents(t0)
    const ev = evs.find((e) => e.url === `${LIB}/manifest.webmanifest?s=secret-mf-1234`)
    ok(ev?.verdict === 'mismatch' && whys([ev]).includes('a query') && ev.class === 'tampered' && (ev.warned ?? []).includes('tab'), `a loud mismatch on the page's request (${JSON.stringify(evs.map((e) => [e.url, whys([e]), e.warned]))})`)
    ok(ev?.page?.request?.type === 'other' && ev.page.request.initiator === LIB, `seen as the tab's request: type other, initiator the library origin (${ev?.page?.request?.type} ${ev?.page?.request?.initiator})`)
  }

  // --- navigations a library document starts (security's fourth review of #983, M7) -------------------
  // MEASURED (Chromium 149): a meta refresh, a Refresh header and the worker's WindowClient.navigate() are
  // each a main_frame request with initiator = the library origin, and the navigation preload carries the
  // URL to the server; so is the honest Reload button's location.reload(), to the URL the tab is on.
  const navEvents = async (t0) => (await since(t0)).filter((e) => e.role === 'navigation')
  const watchNavs = () => sw.evaluate((lib) => {
    globalThis.__twNav = []
    globalThis.__twNavFn ??= (d) => { globalThis.__twNav.push(`${d.type} ${d.initiator ?? '-'} ${d.method} ${d.url.replace(lib, '')}`) }
    chrome.webRequest.onSendHeaders.addListener(globalThis.__twNavFn, { urls: [`${lib}/*`], types: ['main_frame', 'sub_frame'] }, ['requestHeaders', 'extraHeaders'])
  }, LIB)
  const navsSeen = () => sw.evaluate(() => { chrome.webRequest.onSendHeaders.removeListener(globalThis.__twNavFn); return globalThis.__twNav })
  const navWrap = (handler) => `{const _ael=self.addEventListener.bind(self);self.addEventListener=(t,f,o)=>t==="fetch"?_ael(t,(e)=>{${handler};f(e)},o):_ael(t,f,o)}\n`
  /** Install a worker whose fetch handler runs `handler` first, then visit / under it; returns what the row needs. */
  async function navUnder(handler, marker) {
    await fresh()
    state.cloak = { body: Buffer.concat([Buffer.from(navWrap(handler)), BUILD_SW]), headers: { ...honest.lib.get('/sw.js').headers } }
    await page.goto(`${LIB}/`)
    const ctl = await until(async () => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state === 'activated'), 20000)
    await page.goto('about:blank')
    await sleep(300)
    await watchNavs()
    const t0 = Date.now(), k1 = state.heads.length
    await page.goto(`${LIB}/`).catch((e) => note(`goto: ${e}`))
    await until(async () => (await navEvents(t0)).length > 0, 8000)
    await sleep(1500)
    const seen = await navsSeen()
    const got = state.heads.slice(k1).filter((q) => q.key === 'lib' && String(q.u).includes(marker))
    return { ctl, t0, seen, got, evs: await navEvents(t0), final: page.url() }
  }
  const navCheck = (r, marker, how) => {
    for (const x of [...new Set(r.seen)]) note(`extension saw (a navigation) ${x.replace(/x{20,}/g, 'x…')}`)
    // positive control: the bytes did leave, in a navigation the library origin started
    ok(r.ctl && r.got.length > 0 && r.seen.some((x) => x.startsWith(`main_frame ${LIB} GET /?s=${marker}`)), `the cloaked worker is installed and ${how} carried the query to the server (${r.got.length} request(s), ${r.got.map((q) => `${String(q.u).length}-char URL dest=${q.h['sec-fetch-dest']}`).join(' | ')})`)
    const ev = r.evs.find((e) => String(e.url).startsWith(`${LIB}/?s=${marker}`))
    ok(ev?.verdict === 'mismatch' && whys([ev]).includes('a query') && ev.class === 'tampered' && (ev.warned ?? []).includes('tab') && reportTabs().length > 0, `a loud mismatch on the navigation (${JSON.stringify(r.evs.map((e) => [String(e.url).replace(LIB, '').slice(0, 40), whys([e]), e.warned]))})`)
    ok(ev?.page?.request?.type === 'main_frame' && ev.page.request.initiator === LIB && ev.page.request.from === `${LIB}/`, `seen as a navigation the library page started, from the URL it was on (${ev?.page?.request?.type} ${ev?.page?.request?.initiator} from ${ev?.page?.request?.from})`)
  }
  if (row('nav-meta-refresh')) {
    section('nav-meta-refresh: a cloaked worker changes two attribute VALUES of the page it answers: the CSP <meta> becomes a meta refresh to /?s=… (same length)  (rule: a navigation the library starts: no query)')
    const handler = `const u=new URL(e.request.url);if(e.request.mode==="navigate"&&u.pathname==="/"&&!u.search){e.respondWith((e.preloadResponse||Promise.resolve()).then((r)=>r||fetch(e.request)).then(async(r)=>{const t=await r.text();return new Response(t.replace(/http-equiv="Content-Security-Policy" content="([^"]*)"/,(m,c)=>'http-equiv="refresh" content="'+'0;url=/?s=secret-meta-'.padEnd(c.length+16,'x')+'"'),{status:r.status,headers:r.headers})}));return}`
    navCheck(await navUnder(handler, 'secret-meta'), 'secret-meta', 'the browser\'s meta-refresh navigation')
  }
  if (row('nav-refresh-header')) {
    section('nav-refresh-header: a cloaked worker adds Refresh: 0;url=/?s=… to its answer for /  (rule: a navigation the library starts: no query)')
    const handler = `const u=new URL(e.request.url);if(e.request.mode==="navigate"&&u.pathname==="/"&&!u.search){e.respondWith((e.preloadResponse||Promise.resolve()).then((r)=>r||fetch(e.request)).then(async(r)=>{const h=new Headers(r.headers);h.set("refresh","0;url=/?s=secret-hdr-1234");return new Response(await r.text(),{status:r.status,headers:h})}));return}`
    navCheck(await navUnder(handler, 'secret-hdr'), 'secret-hdr', 'the browser\'s Refresh-header navigation')
  }
  if (row('nav-client-navigate')) {
    section('nav-client-navigate: a cloaked worker calls WindowClient.navigate("/?s=…") on the page it answered  (rule: a navigation the library starts: no query)')
    const handler = `const u=new URL(e.request.url);if(e.request.mode==="navigate"&&u.pathname==="/"&&!u.search&&!self.__twNavDone){self.__twNavDone=1;const id=e.resultingClientId;setTimeout(()=>clients.get(id).then((c)=>c&&c.navigate("/?s=secret-cn-1234")).catch(()=>{}),1000)}`
    navCheck(await navUnder(handler, 'secret-cn'), 'secret-cn', 'WindowClient.navigate()')
  }
  if (row('c5-honest-reload')) {
    section('c5-honest-reload: honest visits to /?from=link and to /, each reloaded by the library\'s own Reload button (location.reload())  (rule: a navigation to the URL the tab is on is not judged)')
    await fresh()
    await watchNavs()
    const t0 = Date.now()
    const v1 = await visit(page, `${LIB}/?from=link`)
    await page.evaluate(() => document.getElementById('reload').click()).catch((e) => note(`reload: ${e}`))
    await sleep(2500)
    await page.goto('about:blank')
    const v2 = await visit(page, `${LIB}/`)
    await until(async () => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state === 'activated'), 20000)
    await page.evaluate(() => document.getElementById('reload').click()).catch((e) => note(`reload: ${e}`))
    await sleep(2500)
    const seen = await navsSeen()
    for (const x of [...new Set(seen)]) note(`extension saw (a navigation) ${x}`)
    // positive control: the Reload button's navigations happened, and the library origin started them
    ok(seen.includes(`main_frame ${LIB} GET /?from=link`) && seen.includes(`main_frame ${LIB} GET /`), 'the Reload button reloaded both pages: library-initiated navigations to /?from=link and to / (positive control)')
    const evs = (await since(t0)).filter((e) => e.verdict === 'mismatch')
    ok(v1.lib?.verdict === 'ok' && v2.lib?.verdict === 'ok' && evs.length === 0 && reportTabs().length === 0, `no finding, no report tab (${v1.lib?.verdict} ${v2.lib?.verdict}; ${JSON.stringify(evs.map((e) => [e.role, String(e.url).replace(LIB, ''), whys([e])]))})`)
  }
  // n5 (security's fifth review of #983): a sub_frame navigation the library page starts, in a browser
  if (row('nav-sub-frame')) {
    section('nav-sub-frame: a cloaked worker\'s answer for / carries an <iframe src="/?s=…">  (rule: a navigation the library starts, in a frame too: no query)')
    const handler = `const u=new URL(e.request.url);if(e.request.mode==="navigate"&&u.pathname==="/"&&!u.search){e.respondWith((e.preloadResponse||Promise.resolve()).then((r)=>r||fetch(e.request)).then(async(r)=>{let t=(await r.text()).replace(/frame-src [^;"]+/g,"frame-src *");const i=t.lastIndexOf("</body>");t=t.slice(0,i)+'<iframe src="/?s=secret-sf-1234"></iframe>'+t.slice(i);const h=new Headers(r.headers);h.delete("content-security-policy");return new Response(t,{status:r.status,headers:h})}));return}`
    const r = await navUnder(handler, 'secret-sf')
    for (const x of [...new Set(r.seen)]) note(`extension saw (a navigation) ${x}`)
    ok(r.ctl && r.got.some((q) => q.h['sec-fetch-dest'] === 'iframe') && r.seen.some((x) => x.startsWith(`sub_frame ${LIB} GET /?s=secret-sf`)), `the cloaked worker is installed and the frame's navigation carried the query to the server (${r.got.map((q) => `dest=${q.h['sec-fetch-dest']}`).join(' ')}) (positive control)`)
    const ev = r.evs.find((e) => String(e.url).startsWith(`${LIB}/?s=secret-sf`))
    ok(ev?.verdict === 'mismatch' && whys([ev]).includes('a query') && ev.page?.request?.type === 'sub_frame' && ev.page.request.initiator === LIB && (ev.warned ?? []).includes('badge'), `a mismatch on the sub_frame navigation (${JSON.stringify(r.evs.map((e) => [String(e.url).replace(LIB, '').slice(0, 30), e.page?.request?.type, whys([e]), e.warned]))})`)
  }
  // --- a navigation that ARRIVED by a same-origin redirect (security's fifth review of #983, M8) ----------
  // MEASURED (Chromium 149): a worker's Response.redirect() for a TYPED navigation (no initiator) sends the
  // tab on with the absent initiator kept, and the navigation preload carries the new URL to the server; the
  // page's navigation entry says redirectCount 1 (0 on an honest typed visit)
  const redirectCheck = (r, marker, how, redirects, what = 'the page\'s redirectCount') => {
    for (const x of [...new Set(r.seen)]) note(`extension saw (a navigation) ${x}`)
    ok(r.ctl && r.got.length > 0 && r.seen.some((x) => x.startsWith(`main_frame - GET /?s=${marker}`)) && redirects === 1, `the cloaked worker is installed and ${how} carried the query to the server (${r.got.length} request(s): ${r.got.map((q) => `dest=${q.h['sec-fetch-dest']} preload=${q.h['service-worker-navigation-preload'] ?? '-'}`).join(' | ')}), with no initiator; ${what} ${redirects} (positive control)`)
    const ev = r.evs.find((e) => String(e.url).startsWith(`${LIB}/?s=${marker}`))
    ok(ev?.verdict === 'mismatch' && whys([ev]).includes('a query') && ev.class === 'tampered' && (ev.warned ?? []).includes('tab') && reportTabs().length > 0, `a loud mismatch on the navigation (${JSON.stringify(r.evs.map((e) => [String(e.url).replace(LIB, '').slice(0, 40), whys([e]), e.warned]))})`)
    ok(ev?.page?.request?.arrived === 'redirect' && ev.page.request.type === 'main_frame' && ev.page.request.initiator === null && ev.page.request.from === null, `recorded as a navigation that arrived by a redirect, judged on its final URL (${JSON.stringify(ev?.page?.request)})`)
  }
  const redirectsOf = (p) => p.evaluate(() => performance.getEntriesByType('navigation')[0]?.redirectCount ?? null).catch(() => null)
  if (row('nav-sw-redirect')) {
    section('nav-sw-redirect: a cloaked worker answers a typed navigation to / with Response.redirect("/?s=…")  (rule: a navigation that arrived by a redirect: no query)')
    const handler = `const u=new URL(e.request.url);if(e.request.mode==="navigate"&&u.pathname==="/"&&!u.search){e.respondWith(Response.redirect(new URL("/?s=secret-redir-1234",u).href,302));return}`
    const r = await navUnder(handler, 'secret-redir')
    redirectCheck(r, 'secret-redir', 'the redirected navigation', await redirectsOf(page))
  }
  if (row('nav-sw-redirect-net')) {
    section('nav-sw-redirect-net: as nav-sw-redirect, and the worker leaves the /?s=… leg to the network  (rule: a navigation that arrived by a redirect: no query)')
    const handler = `const u=new URL(e.request.url);if(e.request.mode==="navigate"&&u.pathname==="/"){if(!u.search){e.respondWith(Response.redirect(new URL("/?s=secret-rnet-1234",u).href,302));return}e.stopImmediatePropagation?.();throw 0}`
    const r = await navUnder(handler, 'secret-rnet')
    redirectCheck(r, 'secret-rnet', 'the redirected navigation (network leg)', await redirectsOf(page))
  }
  if (row('nav-sw-redirect-bounce')) {
    section('nav-sw-redirect-bounce: the redirect to /?s=…, whose page then meta-refreshes back to /  (the round-4 bounce through a redirect; rule: a navigation that arrived by a redirect: no query)')
    const handler = `const u=new URL(e.request.url);if(e.request.mode==="navigate"&&u.pathname==="/"){if(!u.search&&!self.__twB){self.__twB=1;e.respondWith(Response.redirect(new URL("/?s=secret-bnc-1234",u).href,302));return}if(u.search){e.respondWith((e.preloadResponse||Promise.resolve()).then((r)=>r||fetch(e.request)).then(async(r)=>new Response((await r.text()).replace(/http-equiv="Content-Security-Policy" content="[^"]*"/,'http-equiv="refresh" content="0;url=/"'),{status:r.status,headers:r.headers})));return}}`
    const r = await navUnder(handler, 'secret-bnc')
    await sleep(1500)
    const final = page.url()
    redirectCheck(r, 'secret-bnc', 'the redirected navigation', r.seen.some((x) => x === 'main_frame - GET /') && r.seen.some((x) => x === `main_frame ${LIB} GET /`) ? 1 : 'no bounce seen', 'and the meta refresh back to / followed it: redirectCount (of a page that left)')
    ok(final === `${LIB}/`, `and the tab ended back on / (${final.replace(LIB, '')})`)
  }
  if (row('c5-honest-server-redirect')) {
    section('c5-honest-server-redirect: the server answers /index.html with a 301 to /, then a typed /?from=link  (rule: a redirect to a served path with no query is quiet; honest control for M8)')
    await fresh({ lib: { '/index.html': { status: 301, headers: { location: '/', 'content-length': '0' }, body: Buffer.alloc(0) } } })
    await watchNavs()
    const t0 = Date.now()
    const v = await visit(page, `${LIB}/index.html`)
    const redirects = await redirectsOf(page)
    const final = page.url()
    await page.goto('about:blank')
    const v2 = await visit(page, `${LIB}/?from=link`)
    const redirects2 = await redirectsOf(page)
    await sleep(2000)
    const seen = await navsSeen()
    for (const x of [...new Set(seen)]) note(`extension saw (a navigation) ${x}`)
    // positive control: the path executed: the document arrived by a redirect, and its report said so
    ok(redirects === 1 && final === `${LIB}/` && v.lib?.page?.url === `${LIB}/`, `the server's 301 took the tab to / and the page counted it (redirectCount ${redirects}, at ${final.replace(LIB, '')}) (positive control)`)
    const evs = (await since(t0)).filter((e) => e.verdict === 'mismatch')
    ok(v.lib?.verdict === 'ok' && v2.lib?.verdict === 'ok' && redirects2 === 0 && evs.length === 0 && reportTabs().length === 0, `no finding, no report tab (${v.lib?.verdict} ${v2.lib?.verdict}, /?from=link redirectCount ${redirects2}; ${JSON.stringify(evs.map((e) => [e.role, String(e.url).replace(LIB, ''), whys([e])]))})`)
  }
  // --- the record of where the tab is, after the EXTENSION's worker stopped (security's fifth review, M9) ---
  // MV3 stops an idle extension worker after ~30 s; the in-memory record is gone, and the session record is
  // all a Reload has. It shared 'twh:' with the headers record, which overwrote and removed it.
  if (row('c5-reload-after-stop')) {
    section('c5-reload-after-stop: an honest visit to /?from=link; the extension\'s worker is stopped; the library\'s Reload button  (rule: a reload of the URL the tab is on, from the session record)')
    await fresh()
    await visit(page, `${LIB}/?from=link`)
    await until(async () => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state === 'activated'), 20000)
    await sleep(1500)
    const here = await sw.evaluate(async () => Object.entries(await chrome.storage.session.get(null)).filter(([, v]) => typeof v === 'string').map(([k, v]) => `${k}=${v}`))
    note(`session string records before the stop: ${JSON.stringify(here.map((x) => x.replace(/:\/\/[^/]+/, '://LIB')))}`)
    await sw.evaluate(() => { globalThis.__twAlive = 1 })
    const cdp = await ctx.newCDPSession(page)
    const { targetInfos } = await cdp.send('Target.getTargets')
    const tgt = targetInfos.find((x) => x.type === 'service_worker' && x.url.startsWith(`chrome-extension://${extId}/`))
    let stopped = false
    if (tgt) { try { stopped = (await cdp.send('Target.closeTarget', { targetId: tgt.targetId })).success } catch (e) { note(`closeTarget: ${e}`) } }
    await cdp.detach().catch(() => {})
    await sleep(2000)
    const t0 = Date.now(), k0 = state.heads.length
    await page.evaluate(() => document.getElementById('reload').click()).catch((e) => note(`reload: ${e}`))
    await sleep(4000)
    // the worker the webRequest event woke: a new one
    const old = sw
    sw = await until(async () => { const w = ctx.serviceWorkers().find((x) => x.url().startsWith(`chrome-extension://${extId}/`)); return w && (await w.evaluate(() => !!globalThis.chrome?.storage?.local).catch(() => false)) ? w : null }, 20000) ?? sw
    const reborn = await sw.evaluate(() => globalThis.__twAlive === undefined).catch((e) => `unread: ${e}`)
    const reloads = state.heads.slice(k0).filter((q) => q.key === 'lib' && q.u === '/?from=link' && q.h['sec-fetch-dest'] === 'document' && q.h['sec-fetch-site'] === 'same-origin').length
    const evs = await since(t0)
    note(`events ${JSON.stringify(evs.map((e) => [e.role, String(e.url).replace(LIB, ''), e.verdict, whys([e]), e.warned]))}; a new extension worker: ${sw !== old}`)
    ok(here.some((x) => x.endsWith(`=${LIB}/?from=link`)) && stopped && reborn === true && reloads > 0, `positive control: the session held where the tab is (/?from=link), the extension's worker was stopped (${stopped}), a new one answered with its memory empty (${reborn}), and the Reload reached the server as a navigation the page started (${reloads})`)
    ok(evs.some((e) => e.role === 'library' && e.verdict === 'ok') && !evs.some((e) => e.verdict === 'mismatch') && reportTabs().length === 0, 'the reloaded page judged ok; no finding, no report tab')
  }
  await fresh()
}

ok(sockets.length === 0, `no WebSocket was opened (${sockets.length})`)
await ctx.close()
for (const [s] of servers) s.close()
frame6.close()
console.log(`\n${checks - failures}/${checks} checks passed${MUTANT ? ' (MUTANT)' : ''}`)
process.exit(failures ? 1 : 0)
