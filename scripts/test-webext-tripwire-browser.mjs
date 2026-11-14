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
 * A stage-3-style service worker is a FIXTURE here (a precache-and-serve
 * worker, the shape page-as-app S.2/D5 asks for), registered on the library
 * origin through a page with CSP bypassed (the stage-1 library's CSP refuses
 * workers). Hostile workers are fixtures too.
 *
 * Every row names the rule it guards; scripts/test-webext-tripwire-mutants.mjs
 * turns each rule off and requires that row to go red.
 */
import { execFileSync } from 'node:child_process'
import { createHash, webcrypto } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
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
const LIB = `http://127.0.0.1:${pl}`, FRM = `http://localhost:${pf}`, CHAN = `http://127.0.0.1:${pr}`
const LIST_PATH = '/releases/home-web/served.json'
const A = path.join(work, 'A')
execFileSync(process.execPath, [path.join(ROOT, 'home/web/build.mjs'), '--out', A, '--library-origin', LIB, '--frame-origin', FRM,
  '--release-base', `${CHAN}/releases/`, '--dev'], { stdio: ['ignore', 'ignore', 'inherit'] })

// the fixture worker: precache the library page, answer every same-origin GET from the cache
const SW_HONEST = `// bento/home precache worker (rig fixture)
const C = 'bento-home-v1'
self.addEventListener('install', (e) => e.waitUntil(caches.open(C).then((c) => c.addAll(['/', '/index.html']))))
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url)
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)))
})
`
fs.writeFileSync(path.join(A, 'library/sw.js'), SW_HONEST)
const infoA = JSON.parse(fs.readFileSync(path.join(A, 'build.json'), 'utf8'))
fs.writeFileSync(path.join(A, 'build.json'), JSON.stringify({ ...infoA, serviceWorkers: ['/sw.js'] }, null, 2))

// release B: the same build with different words on the page (a later release)
const B = path.join(work, 'B')
fs.cpSync(A, B, { recursive: true })
const libA = fs.readFileSync(path.join(A, 'library/index.html'), 'utf8')
const LEDE = 'Open a Bento document to view or present it.'
if (libA.split(LEDE).length !== 2) throw new Error('the library page no longer carries the lede this rig edits')
fs.writeFileSync(path.join(B, 'library/index.html'), libA.replace(LEDE, 'Open a Bento document to view or to present it.'))

const DAY = 86400e3
const relA = await describeBuild(A, new Date(Date.now() - 10 * DAY).toISOString())
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
const releaseB = siteFiles(path.join(B, 'library'))
// a file may carry `status` and `hold` (send the body, keep the response open); `fallback` answers unlisted library paths
const HELD = []
const state = { lib: new Map(honest.lib), frame: new Map(honest.frame), list: null, hits: [], fallback: null, scripts: new Map([...await buildScriptTexts(A), ...await buildScriptTexts(B)]) }
const serve = (key) => http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  state.hits.push(`${key} ${p}`)
  if (key === 'chan') {
    // the inline scripts' text, published beside the list (scripts/<sha256>.js)
    const sm = /^\/releases\/home-web\/scripts\/([0-9a-f]{64})\.js$/.exec(p)
    if (sm && state.scripts.has(sm[1])) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(state.scripts.get(sm[1])); return }
    if (p === LIST_PATH && state.list != null) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(state.list); return }
    res.writeHead(404).end(); return
  }
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
twScript.matches = ['http://127.0.0.1/*']
// the frame site, as the shipped manifest will name it once its domain is chosen: in frames
man.content_scripts.push({ ...twScript, matches: ['http://localhost/*'], all_frames: true, match_origin_as_fallback: undefined })
man.host_permissions = man.host_permissions.filter((h) => h !== 'https://home.bento.page/*').concat(['http://127.0.0.1/*', 'http://localhost/*'])
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
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
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
async function fresh({ list = list1, held = null, lib = {}, frame = {} } = {}) {
  await closeExtras(page)
  // the last row's document leaves first (its pagehide report lands now, not in this row's record)
  await page.goto('about:blank').catch(() => {})
  await new Promise((r) => setTimeout(r, 400))
  await store.reset()
  for (const r of HELD.splice(0)) r.destroy()
  state.fallback = null
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
  const bad = { body: libDoc.body, headers: { ...libDoc.headers, 'content-security-policy': h.replace("worker-src 'none'", 'worker-src *') } }
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
    ok(reportTabs().length === 0, 'no report tab')
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
  ok(hostile?.verdict === 'mismatch' && rules(hostile).includes('elements') && hostile.warned.includes('tab'), `the visit is on record as a loud mismatch: its parse stopped matching any listed document (${hostile?.verdict} ${rules(hostile)} ${hostile?.warned})`)
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
  section(`${name}: the library reached by a link on another site${bad ? ', one byte changed and sent no-store' : ''}  (rules: a cross-site navigation's bytes are not asked for; its Cache-Control header is)`)
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
  if (!bad) ok(ev?.verdict === 'ok' && ev.page.crossSite && !ev.observed.bytes && (ev.warned ?? []).length === 0, `honest, reached from another site: ok, quietly; its bytes are not judged (another navigation's may be all that is cached) (${ev?.verdict} ${rules(ev)} crossSite ${ev?.page?.crossSite} bytes ${ev?.observed?.bytes})`)
  else ok(ev?.verdict === 'mismatch' && rules(ev).split(',').includes('cache-control'), `no-store, reached from another site: a mismatch on its Cache-Control header (${ev?.verdict} ${rules(ev)})`)
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
const SW_ROWS = ['sw-element', 'shadow-root', 'shadow-root-removed', 'sw-honest', 'sw-script-bytes', 'sw-custom-path', 'sw-cache-extra', 'sw-cache-poisoned', 'sw-navigation-only', 'sw-markup', 'sw-size', 'script-rewrite']
async function withWorker(script, { scope = '/', url = '/sw.js' } = {}) {
  // the stage-1 library's CSP refuses workers; the rig registers through a page with CSP bypassed
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
    section('sw-honest: the precache worker serves release A  (positive control, worker present)')
    await fresh()
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
    await fresh()
    needWorker(await withWorker(SW_HONEST))
    state.lib.set('/sw.js', { body: Buffer.from(SW_HONEST + '// changed\n'), headers: { 'content-type': 'text/javascript' } })
    const v = await visit(page, `${LIB}/`)
    ok(v.lib?.verdict === 'mismatch' && rules(v.lib).split(',').every((r) => r === 'worker-bytes') && rules(v.lib), `mismatch on worker-bytes only (got ${v.lib?.verdict} ${rules(v.lib)})`)
    await noWorkers()
  }
  if (row('sw-custom-path')) {
    section('sw-custom-path: a second worker registered at a path no release lists  (rule: worker)')
    await fresh()
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
    await fresh()
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
    await fresh()
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
    await fresh()
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
    await fresh()
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
    await fresh()
    needWorker(await withWorker(hostileWorker([['Choose a file', 'Choose a file to send us']])))
    state.lib.set('/sw.js', { body: Buffer.from(SW_HONEST), headers: { 'content-type': 'text/javascript' } })
    const v = await visit(page, `${LIB}/`)
    ok(v.lib?.verdict === 'mismatch' && rules(v.lib) === 'size', `mismatch on size only (got ${v.lib?.verdict} ${rules(v.lib)})`)
    await noWorkers()
  }
  if (row('script-rewrite')) {
    section('script-rewrite: a hostile worker serves a script that runs, then rewrites its own text to the honest one  (rule: script-rewritten)')
    await fresh()
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
}

if (row('shadow-root')) {
  section('shadow-root: a hostile worker puts a handler and a script inside a declarative shadow root, same length  (rule: shadow-root is markup)')
  await fresh()
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
  await fresh()
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
  await fresh()
  needWorker(await withWorker(hostileWorker([['Only the code', '<b>Only</b> c']])))
  state.lib.set('/sw.js', { body: Buffer.from(SW_HONEST), headers: { 'content-type': 'text/javascript' } })
  const v = await visit(page, `${LIB}/`)
  ok(v.lib?.verdict === 'mismatch' && rules(v.lib) === 'elements', `mismatch on elements only (got ${v.lib?.verdict} ${rules(v.lib)})`)
  await noWorkers()
}

ok(sockets.length === 0, `no WebSocket was opened (${sockets.length})`)
await ctx.close()
for (const [s] of servers) s.close()
frame6.close()
console.log(`\n${checks - failures}/${checks} checks passed${MUTANT ? ' (MUTANT)' : ''}`)
process.exit(failures ? 1 : 0)
