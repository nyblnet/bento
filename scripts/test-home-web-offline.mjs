#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/home in your browser, stage 3: the library's offline worker, the kill
 * switch and install, in a real browser.
 *
 *   PLAYWRIGHT_MODULE=…/playwright/index.mjs node scripts/test-home-web-offline.mjs
 *   BENTO_BROWSER=webkit|firefox …     another engine (default chromium)
 *   … --mutants [name…]                 each mutant must turn ITS row red (Chromium)
 *
 * Builds home/web twice with a throwaway key against the same local origins
 * (build X, and build Y: the same code with a differently spelled history, so a
 * different build id), deploys X, and later "deploys" Y into the same directory
 * while the servers run. Sockets are refused for the whole run.
 *
 * Offline: Chromium and Firefox go offline with context.setOffline (the servers
 * stay up, so a request that reached them would be seen). In WebKit,
 * Playwright's setOffline refuses a navigation before the page's service
 * worker sees it (measured: with the servers really down the same worker
 * serves the page), so WebKit's offline rows close the servers instead, and
 * the setOffline behaviour is recorded as a note each run.
 *
 * A browser that crashes or disconnects fails the run; it never passes.
 *
 * Sections (BENTO_HW3_ONLY=a,b runs some; the mutant runner uses it):
 *   build    the built files: worker shape and budget, CSPs, headers [T7]
 *   sw       first visit: the worker, its one cache, network first, nothing else cached, no other worker
 *   offline  a returning visit offline: the library from the cache; a document says it needs a connection [T2 offline half]
 *   update   a new deploy replaces the old cache; a precache that is not the build's bytes installs nothing
 *   kill     the drill: withdraw build X, the next load is clean, then Y is served
 *   status   the status fails closed: bad signature, another payload, a replay; positive control
 *   install  the web app manifest and its icons
 *   network  every request in the run was on the allow-list, carried no canary, opened no socket [T2]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, webcrypto } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = fileURLToPath(import.meta.url)

// --- mutants -------------------------------------------------------------------
// src: edits to home/web/src (BENTO_HOME_WEB_MUTANT, applied by build.mjs, which
// refuses unless `from` occurs exactly once). dist: edits to the built files
// (re: a regular expression, all occurrences, at least one required).
const MUTANTS = [
  { name: 'sw-cache-first', why: 'the worker answers from its cache before the network', only: 'sw',
    src: { file: 'sw.ts', from: '  e.respondWith(fetch(e.request).catch(async () => {\n    const hit = await (await caches.open(CACHE)).match(url.pathname)\n    return hit ?? Response.error()\n  }))',
      to: '  e.respondWith((async () => (await (await caches.open(CACHE)).match(url.pathname)) ?? fetch(e.request))())' },
    expect: 'online, the library comes from the server even with the worker in control' },
  { name: 'sw-caches-what-it-sees', why: 'the worker caches whatever passes through it', only: 'sw',
    src: { file: 'sw.ts', from: "  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !PATHS.has(url.pathname)) return\n",
      to: "  if (e.request.method !== 'GET') return\n  if (!PATHS.has(url.pathname)) { e.respondWith(fetch(e.request).then(async (r) => { await (await caches.open(CACHE)).put(e.request, r.clone()); return r })); return }\n" },
    expect: 'after the session, the cache still holds exactly the build\'s files' },
  { name: 'sw-no-pin-check', why: 'the worker caches files without checking them against their pins', only: 'update',
    src: { file: 'sw.ts', from: "      if (sum !== p.sha256) throw new Error(`precache: ${p.path} is not the build's bytes`)\n", to: '      void sum\n' },
    expect: 'a library whose page is not the bytes its worker pins caches nothing' },
  { name: 'sw-keeps-old-caches', why: 'activating a new worker leaves the old build\'s cache', only: 'update',
    src: { file: 'sw.ts', from: '    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k)\n', to: '' },
    expect: 'after a new deploy, only the new build\'s cache is left' },
  { name: 'sw-page-not-precached', why: 'the precache list loses the library page', only: 'offline',
    dist: [{ file: 'library/sw.js', re: '\\{path:"/",sha256:"[0-9a-f]{64}"\\},', to: '' }],
    expect: 'offline, a returning visit opens the library from the worker\'s cache' },
  { name: 'sw-update-via-cache', why: 'the worker script may come from the HTTP cache', only: 'sw',
    src: { file: 'offline.ts', from: "{ scope: '/', updateViaCache: 'none' }", to: "{ scope: '/', updateViaCache: 'all' }" },
    expect: 'one worker, scope /, script /sw.js, updateViaCache none' },
  { name: 'worker-anywhere', why: 'the library page may register any worker script (CSP and Trusted Types widened)', only: 'sw',
    dist: [
      { file: 'library/index.html', re: "require-trusted-types-for 'script'; ", to: '' },
      { file: 'library/index.html', re: 'worker-src [^;]+', to: 'worker-src *' },
      { file: 'library/_headers', re: "require-trusted-types-for 'script'; ", to: '' },
      { file: 'library/_headers', re: 'worker-src [^;]+', to: 'worker-src *' },
    ],
    expect: 'the library page cannot register any other worker script' },
  { name: 'offline-silent', why: 'a frame page that never answers leaves the person looking at nothing', only: 'offline',
    src: { file: 'library.ts', from: '    if (session !== s || s.port) return\n    fail(navigator.onLine', to: '    if (session === s || s.port) return\n    fail(navigator.onLine' },
    expect: 'offline, opening a document says it needs a connection' },
  { name: 'kill-ignored', why: 'a withdrawn build carries on', only: 'kill',
    src: { file: 'offline.ts', from: "status: p.withdrawn.includes(build) ? 'withdrawn' : 'current'", to: "status: 'current'" },
    expect: 'the withdrawn build stops and says so' },
  { name: 'kill-keeps-worker', why: 'withdrawing leaves the worker registered', only: 'kill',
    src: { file: 'offline.ts', from: '  try { for (const r of await navigator.serviceWorker?.getRegistrations() ?? []) await r.unregister() } catch { /* no worker API */ }\n', to: '' },
    expect: 'the withdrawn build\'s worker is unregistered' },
  { name: 'kill-keeps-caches', why: 'withdrawing leaves the caches', only: 'kill',
    src: { file: 'offline.ts', from: '  try { for (const k of await caches.keys()) await caches.delete(k) } catch { /* no caches API */ }\n', to: '' },
    expect: 'the withdrawn build\'s caches are deleted' },
  { name: 'open-before-check', why: 'a file opens before the kill switch has answered', only: 'kill',
    src: { file: 'library.ts', from: '  if (!(await ready)) return // withdrawn: the page has stopped\n', to: '' },
    expect: 'a file dropped before a slow status answers never runs in a withdrawn build' },
  { name: 'status-unverified', why: 'the status is taken without checking its signature', only: 'status',
    src: { file: 'offline.ts', from: "p = await verifySigned(raw, 'bento/home status', key) as Record<string, unknown>", to: 'p = JSON.parse(JSON.parse(raw).payload)' },
    expect: 'a status with a bad signature fails closed' },
  { name: 'status-fail-open', why: 'a status that cannot be trusted is treated as no answer', only: 'status',
    src: { file: 'offline.ts', from: "    if (status === 'withdrawn' || status === 'refused') {\n", to: "    if (status === 'refused') status = 'unreachable'\n    if (status === 'withdrawn') {\n" },
    expect: 'a status with a bad signature fails closed' },
  { name: 'status-any-app', why: 'a signed payload for another app is taken as the status', only: 'status',
    src: { file: 'offline.ts', from: "  if (p.app !== STATUS_APP) return { status: 'refused', why: `a payload for ${String(p.app)}` }\n", to: '' },
    expect: 'a signed payload for another app, in the status\'s shape, fails closed' },
  { name: 'status-replay', why: 'an older status than one already seen is taken', only: 'status',
    src: { file: 'offline.ts', from: '  if (seq < seen) return { status: \'refused\', why: `older than one already seen (${seq} < ${seen})` }\n', to: '' },
    expect: 'an older status than one this browser has seen fails closed' },
  { name: 'manifest-blocked', why: 'the library CSP blocks its own manifest', only: 'install',
    dist: [
      { file: 'library/index.html', re: 'manifest-src [^;]+', to: "manifest-src 'none'" },
      { file: 'library/_headers', re: 'manifest-src [^;]+', to: "manifest-src 'none'" },
    ],
    expect: 'the engine loads the manifest under the library\'s CSP' },
]

if (process.argv.includes('--mutants')) {
  const only = process.argv.slice(process.argv.indexOf('--mutants') + 1)
  let n = 0, bad = 0
  for (const m of MUTANTS.filter((x) => !only.length || only.includes(x.name))) {
    const env = { ...process.env, BENTO_BROWSER: 'chromium', NODE_NO_WARNINGS: '1', BENTO_HW3_ONLY: m.only }
    delete env.BENTO_HOME_WEB_MUTANT; delete env.BENTO_HW3_DIST_MUTANT
    if (m.src) env.BENTO_HOME_WEB_MUTANT = JSON.stringify(m.src)
    if (m.dist) env.BENTO_HW3_DIST_MUTANT = JSON.stringify(m.dist)
    const r = spawnSync(process.execPath, [SELF], { env, encoding: 'utf8', timeout: 600_000 })
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    const applied = (m.src ? /mutant applied to x source/.test(out) && /mutant applied to y source/.test(out) : true) &&
      (m.dist ? m.dist.every((d) => out.includes(`mutant applied to x/${d.file}`)) : true)
    // a kill is a COMPLETED run (its summary printed) with a FAIL on the guarding row: a crash is not a kill
    const completed = /^\d+\/\d+ checks passed \(chromium\)/m.test(out) && !/the browser crashed/.test(out)
    const caught = out.split('\n').some((l) => l.includes('FAIL') && l.includes(m.expect))
    n++
    const killed = applied && completed && r.status !== 0 && caught
    if (!killed) bad++
    console.log(`  ${killed ? 'ok  ' : 'FAIL'}  ${m.name}: ${m.why} — ${!applied ? 'NOT APPLIED' : !completed ? 'the run did not complete (a crash is not a kill)' : caught ? 'red on its row' : r.status === 0 ? 'SURVIVED' : 'red, but not on its row'}`)
    if (!killed) console.log(out.split('\n').filter((l) => /FAIL|Error|mutant/.test(l)).slice(0, 8).map((l) => '        ' + l).join('\n'))
  }
  console.log(`\n${n - bad}/${n} mutants killed`)
  process.exit(bad ? 1 : 0)
}

// --- the rig ---------------------------------------------------------------------
const ENGINE = process.env.BENTO_BROWSER || 'chromium'
const ONLY = (process.env.BENTO_HW3_ONLY || '').split(',').filter(Boolean)
const runs = (s) => !ONLY.length || ONLY.includes(s)
const { startServers, freePorts } = await import(path.join(ROOT, 'home/web/serve.mjs'))
const { spliceDoc } = await import(path.join(ROOT, 'home/web/src/verify.ts'))
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
const note = (m) => console.log(`  note  ${m}`)
const section = (m) => console.log(`\n=== ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) { try { const v = await fn(); if (v) return v } catch {} await sleep(150) }
  return null
}
const hex = (b) => createHash('sha256').update(b).digest('hex')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-home-web-offline-'))
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }))

// --- fixtures ------------------------------------------------------------------------
const REAL = path.join(ROOT, 'home/fixtures/gate1/real/slides-1.2.10')
const shell1210 = fs.readFileSync(path.join(REAL, 'Bento_Slides.bento.html'), 'utf8')
const realHistory = JSON.parse(fs.readFileSync(path.join(REAL, 'history.json'), 'utf8'))
const CANARY = 'BENTO-CANARY-' + webcrypto.getRandomValues(new Uint32Array(2)).join('')
const docJson = JSON.stringify({
  format: 'bento/slides', version: 1, docId: webcrypto.randomUUID(), title: CANARY, size: { w: 1280, h: 720 },
  slides: [{ id: 's1', background: '#ffffff', elements: [{ id: 't1', type: 'text', x: 96, y: 200, w: 1000, h: 120, html: 'Hello ' + CANARY, fontSize: 48, color: '#16273E' }] }],
}).replace(/</g, '\\u003c')
const DECK = path.join(work, 'deck.bento.html')
fs.writeFileSync(DECK, spliceDoc(shell1210, docJson))

// a throwaway key: the builds verify with it, and the status tool signs with it
const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const priv = await webcrypto.subtle.exportKey('jwk', kp.privateKey)
const { kty, crv, x, y } = await webcrypto.subtle.exportKey('jwk', kp.publicKey)
const pub = { kty, crv, x, y }
const KEY = path.join(work, 'test-key.json')
const PUB = path.join(work, 'test-pub.json')
fs.writeFileSync(KEY, JSON.stringify({ private: priv, public: pub }))
fs.writeFileSync(PUB, JSON.stringify(pub))
const other = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const signWith = async (k, payload) => JSON.stringify({ payload, sig: Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k, new TextEncoder().encode(payload))).toString('base64') })
// the same history, spelled two ways: two builds of the same code with different ids
fs.writeFileSync(path.join(work, 'history-x.json'), await signWith(kp.privateKey, realHistory.payload))
fs.writeFileSync(path.join(work, 'history-y.json'), await signWith(kp.privateKey, JSON.stringify(JSON.parse(realHistory.payload), null, 1)))
/** The status, signed by the tool this PR ships (scripts/sign-home-status.mjs). */
function status(args) {
  return execFileSync(process.execPath, [path.join(ROOT, 'scripts/sign-home-status.mjs'), '--key', KEY, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

// --- builds ----------------------------------------------------------------------------
const distMutants = process.env.BENTO_HW3_DIST_MUTANT ? JSON.parse(process.env.BENTO_HW3_DIST_MUTANT) : []
const [PL, PF, PR] = await freePorts(3)
const O = { library: `http://127.0.0.1:${PL}`, frame: `http://localhost:${PF}`, releaseBase: `http://127.0.0.1:${PR}/releases/` }
function build(name, history) {
  const out = path.join(work, name)
  execFileSync(process.execPath, [path.join(ROOT, 'home/web/build.mjs'), '--out', out, '--library-origin', O.library, '--frame-origin', O.frame,
    '--release-base', O.releaseBase, '--dev', '--key', PUB, '--history', history], { stdio: ['ignore', 'ignore', 'inherit'] })
  for (const m of distMutants) {
    const f = path.join(out, m.file)
    const t = fs.readFileSync(f, 'utf8')
    const re = new RegExp(m.re, 'g')
    if (!re.test(t)) throw new Error(`dist mutant: /${m.re}/ does not occur in ${m.file}`)
    fs.writeFileSync(f, t.replace(new RegExp(m.re, 'g'), () => m.to))
    console.log(`  mutant applied to ${name}/${m.file}`)
  }
  const info = JSON.parse(fs.readFileSync(path.join(out, 'build.json'), 'utf8'))
  if (info.mutant) console.log(`  mutant applied to ${name} source: ${info.mutant}`)
  return { out, info }
}
section(`builds (${ENGINE})`)
const X = build('x', path.join(work, 'history-x.json'))
const Y = build('y', path.join(work, 'history-y.json'))
ok(X.info.offline.build !== Y.info.offline.build && X.info.offline.cache !== Y.info.offline.cache, 'builds X and Y are two builds: different build ids and cache names')

// the served site: deploy() copies a build's library into it while the servers run
const SITE = path.join(work, 'site')
fs.cpSync(path.join(X.out, 'frame'), path.join(SITE, 'frame'), { recursive: true })
// probe files on the library origin, outside the build (no rule in _headers, so no CSP)
const PROBE_HTML = '<!doctype html><title>probe</title><p>probe</p>'
const PROBE_SW = "self.addEventListener('fetch', () => {})"
function deploy(B, { tamperPage = false } = {}) {
  const lib = path.join(SITE, 'library')
  fs.rmSync(lib, { recursive: true, force: true })
  fs.cpSync(path.join(B.out, 'library'), lib, { recursive: true })
  fs.writeFileSync(path.join(lib, 'probe.html'), PROBE_HTML)
  fs.writeFileSync(path.join(lib, 'probe-sw.js'), PROBE_SW)
  if (tamperPage) fs.appendFileSync(path.join(lib, 'index.html'), '<!-- not the pinned bytes -->\n')
}
deploy(X)
const files = new Map()
const seen = []
let S = null
const up = async () => { S = await startServers({ dist: SITE, ports: { library: PL, frame: PF, release: PR }, files, onRequest: (r) => seen.push({ method: r.method, url: `http://${r.headers.host}${r.url}` }) }) }
const down = async () => { await S?.close(); S = null }
await up()
const STATUS = '/releases/home/status.json'
const LIB_PATHS = ['/', '/sw.js', ...X.info.offline.precache.map((p) => p.path), '/probe.html', '/probe-sw.js']

// --- [build] -----------------------------------------------------------------------------
if (runs('build')) {
  section('[build] the built files [T7]')
  const sw = fs.readFileSync(path.join(X.out, 'library/sw.js'), 'utf8')
  ok(!/importScripts|\beval\b|\bFunction\s*\(|\bimport\s*\(/.test(sw), 'the worker has no importScripts, eval, Function or dynamic import')
  const BUDGET = { library: 32 * 1024, sw: 3 * 1024 }
  ok(X.info.bytes.libraryWithoutHistories <= BUDGET.library, `library page ${X.info.bytes.libraryWithoutHistories} B (without bundled histories) is within ${BUDGET.library} B`)
  ok(X.info.bytes.sw <= BUDGET.sw, `worker ${X.info.bytes.sw} B is within ${BUDGET.sw} B`)
  ok(X.info.offline.precache.map((p) => p.path).join(' ') === '/ /manifest.webmanifest /icon-192.png /icon-512.png',
    `the worker precaches the library's own files only (${X.info.offline.precache.map((p) => p.path).join(' ')})`)
  const pol = X.info.libraryPolicy.split('; ')
  ok(pol.includes(`worker-src ${O.library}/sw.js`) && pol.includes(`manifest-src ${O.library}/manifest.webmanifest`) && pol.includes('trusted-types bento-sw') && pol.includes("require-trusted-types-for 'script'"),
    'the library CSP names exactly one worker script and one manifest, and allows one Trusted Types policy')
  const fp = X.info.framePolicy.split('; ')
  ok(fp[0] === 'sandbox allow-scripts allow-popups allow-modals' && fp.includes("worker-src 'none'") && fp.includes("manifest-src 'none'") && fp.includes(`frame-ancestors ${O.library}`),
    'the frame policy is unchanged: sandboxed, worker-src none, framed only by the library')
  const lh = fs.readFileSync(path.join(X.out, 'library/_headers'), 'utf8')
  const swRule = /^\/sw\.js\n((?:\s+.*\n)+)/m.exec(lh)?.[1] ?? ''
  ok(/Content-Security-Policy: default-src 'none'; connect-src 'self'/.test(swRule) && /Cache-Control: no-cache/.test(swRule), "the worker is served with its own default-src 'none' policy and Cache-Control: no-cache")
  ok(!/sw\.js|webmanifest/.test(fs.readFileSync(path.join(X.out, 'frame/_headers'), 'utf8')) && !fs.existsSync(path.join(X.out, 'frame/sw.js')), 'the frame site serves no worker and no manifest')
}

// --- browser --------------------------------------------------------------------------------
const browser = await pw[ENGINE].launch()
let closing = false, crashed = false
browser.on('disconnected', () => { if (!closing) crashed = true })
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
/** The library's state, once its status check has answered. */
async function settled(page, ms = 20000) {
  await until(() => page.evaluate(() => {
    const s = document.documentElement.getAttribute('data-bento-status')
    return s && s !== 'checking' && (s === 'withdrawn' || s === 'refused' || document.documentElement.getAttribute('data-bento-sw'))
  }), ms)
  return lib(page)
}
const lib = (page) => page.evaluate(async () => {
  const regs = await navigator.serviceWorker.getRegistrations()
  return {
    status: document.documentElement.getAttribute('data-bento-status'), sw: document.documentElement.getAttribute('data-bento-sw'),
    build: document.documentElement.getAttribute('data-bento-build'),
    regs: regs.map((r) => ({ scope: r.scope, script: (r.active || r.waiting || r.installing)?.scriptURL ?? null, updateViaCache: r.updateViaCache })),
    caches: await caches.keys(), stopped: document.body.classList.contains('stopped'),
    stopText: document.getElementById('withdrawn')?.offsetParent ? document.getElementById('withdrawn-text').textContent : '',
    picker: !!document.getElementById('file')?.offsetParent,
  }
})
/** Wait until the worker has activated and holds `cache`. */
const cached = (page, cache, ms = 15000) => until(() => page.evaluate(async (c) => {
  const k = await caches.keys()
  return k.length === 1 && k[0] === c ? k : null
}, cache), ms)
const docFrame = (page) => page.frames().find((f) => f.parentFrame() === page.mainFrame())
const ui = (page) => page.evaluate(() => {
  const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.offsetParent !== null }
  return { viewing: document.body.classList.contains('viewing'), frames: document.querySelectorAll('iframe').length, problem: vis('problem-box') ? document.getElementById('problem').textContent : '' }
})
async function open(page) {
  await page.setInputFiles('#file', DECK)
  return until(async () => { const u = await ui(page); return u.viewing || u.problem ? u : null }, 30000)
}
const booted = (page) => until(async () => { const f = docFrame(page); return f && (await f.evaluate(() => !!(window.bento && window.bento.doc))) ? f : null })
const served = (from, p) => seen.slice(from).filter((r) => r.url === O.library + p)
const frameFetches = (from) => seen.slice(from).filter((r) => r.url.startsWith(O.frame))
/** Offline: setOffline (servers up, so a request that got out would be seen), or in WebKit the servers down. */
async function offline(ctx) { if (ENGINE === 'webkit') await down(); else await ctx.setOffline(true) }
async function online(ctx) { if (ENGINE === 'webkit') await up(); else await ctx.setOffline(false) }
/** Every cached entry's text, to look for document content. */
const cacheText = (page) => page.evaluate(async () => {
  let t = ''
  for (const n of await caches.keys()) { const c = await caches.open(n); for (const r of await c.keys()) t += r.url + '\n' + await (await c.match(r)).text() }
  return t
})

try {
  // --- [sw] first visit --------------------------------------------------------------------
  if (runs('sw')) {
    section('[sw] first visit: one worker, one cache keyed on the build, network first, nothing else kept')
    files.delete(STATUS)
    const ctx = await context()
    const page = await ctx.newPage()
    await page.goto(O.library + '/')
    let s = await settled(page)
    ok(s.status === 'unreachable' && s.sw === 'registered', `with no status published (404) the library carries on and registers its worker (${s.status}, ${s.sw})`)
    ok(s.build === X.info.offline.build, 'the page knows its own build id (the sha256 of its script, as the build printed it)')
    s = await lib(page)
    ok(s.regs.length === 1 && s.regs[0].scope === O.library + '/' && s.regs[0].script === O.library + '/sw.js' && s.regs[0].updateViaCache === 'none',
      `one worker, scope /, script /sw.js, updateViaCache none (${JSON.stringify(s.regs)})`)
    const c = await cached(page, X.info.offline.cache)
    ok(!!c, `the worker holds exactly one cache, named for the build's content hash (${(await lib(page)).caches.join(', ')})`)
    const entries = await page.evaluate(async (name) => {
      const out = []
      const ca = await caches.open(name)
      for (const r of await ca.keys()) out.push([new URL(r.url).pathname, Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await (await ca.match(r)).arrayBuffer())), (b) => b.toString(16).padStart(2, '0')).join('')])
      return out
    }, X.info.offline.cache)
    const want = X.info.offline.precache.map((p) => [p.path, p.sha256])
    ok(JSON.stringify(entries.sort()) === JSON.stringify(want.sort()), 'the cache holds the build\'s files, each byte for byte its pin')

    // network first: with the worker in control, an online load still comes from the server
    await page.reload()
    const mark = seen.length
    await page.reload()
    await settled(page)
    const ctl = await page.evaluate(() => !!navigator.serviceWorker.controller)
    ok(ctl && served(mark, '/').length >= 1, `online, the library comes from the server even with the worker in control (controlled ${ctl}, GET / seen ${served(mark, '/').length})`)

    // open a document; afterwards nothing new is in the cache and no document content anywhere in it
    const u = await open(page)
    const fr = await booted(page)
    ok(!!fr && u?.viewing, 'positive control: online, the deck opens and boots')
    // also pass a page the list does not name through the worker
    const probe = await ctx.newPage()
    await probe.goto(O.library + '/probe.html')
    await probe.evaluate(() => fetch('/probe-sw.js').then((r) => r.text()).catch(() => ''))
    await sleep(1000)
    const after = await lib(page)
    const keys = await page.evaluate(async (n) => (await (await caches.open(n)).keys()).map((r) => r.url).sort(), X.info.offline.cache)
    ok(after.caches.length === 1 && JSON.stringify(keys) === JSON.stringify(X.info.offline.precache.map((p) => O.library + p.path).sort()),
      `after the session, the cache still holds exactly the build's files (${after.caches.length} cache(s), ${keys.length} entries)`)
    ok(!(await cacheText(page)).includes(CANARY), 'no cache holds any of the document')

    // no other worker: the library's policy (CSP worker-src, and Trusted Types where the engine has it) refuses any other script
    const other = await page.evaluate(() => { try { return navigator.serviceWorker.register('/probe-sw.js', { scope: '/probe-scope/' }).then(() => 'registered', (e) => e.name) } catch (e) { return e.name } })
    const control = await probe.evaluate(() => navigator.serviceWorker.register('/probe-sw.js', { scope: '/probe-scope/' }).then(async (r) => { await r.unregister(); return 'registered' }, (e) => e.name))
    ok(control === 'registered', `positive control: a page on the library origin WITHOUT the library's policy can register that script (${control})`)
    ok(other !== 'registered', `the library page cannot register any other worker script (${other})`)
    await ctx.close()
  }

  // --- [offline] a returning visit offline ---------------------------------------------------------
  if (runs('offline')) {
    section(`[offline] a returning visit with no network (${ENGINE === 'webkit' ? 'servers closed' : 'context.setOffline'})`)
    files.delete(STATUS)
    const ctx = await context()
    const page = await ctx.newPage()
    await page.goto(O.library + '/')
    await settled(page)
    ok(!!(await cached(page, X.info.offline.cache)), 'precondition: the worker is installed and holds the build')
    await page.evaluate(() => { window.__before = 1 })
    await offline(ctx)
    const mark = seen.length
    const nav = await page.goto(O.library + '/').then((r) => r?.status() ?? 0, (e) => String(e).split('\n')[0])
    const fresh = await page.evaluate(() => window.__before === undefined).catch(() => false)
    const s = fresh ? await settled(page) : null
    ok(nav === 200 && fresh && s?.status === 'unreachable' && s?.picker, `offline, a returning visit opens the library from the worker's cache (${nav}; status ${s?.status})`)
    ok(served(mark, '/').length === 0, 'offline, nothing reached the server (the page came from the cache)')
    const csp = await page.evaluate(async () => (await caches.match('/'))?.headers.get('content-security-policy') ?? null).catch(() => null)
    const headerCsp = /^\/\n(?:.*\n)*?\s+Content-Security-Policy: (.*)$/m.exec(fs.readFileSync(path.join(X.out, 'library/_headers'), 'utf8'))?.[1]
    ok(!!csp && csp === headerCsp, 'the cached page keeps its header CSP (frame-ancestors and all)')
    if (ENGINE !== 'webkit') {
      // record whether the engine's offline emulation reaches the cross-site frame (Chromium's does not: measured)
      const fm = seen.length
      await page.setInputFiles('#file', DECK)
      await until(async () => (await ui(page)).problem || frameFetches(fm).length || null, 8000)
      note(`context.setOffline ${frameFetches(fm).length ? 'does NOT cover' : 'covers'} the cross-site frame in ${ENGINE}; the row below also closes the servers`)
      await page.goto(O.library + '/')
      await settled(page)
    }
    // a real outage for the document row: no engine's emulation is trusted to hold the frame site offline
    await down()
    await page.setInputFiles('#file', DECK)
    const u = await until(async () => { const v = await ui(page); return v.problem ? v : null }, 30000)
    const up1 = !!(await docFrame(page)?.evaluate(() => !!window.bento).catch(() => false))
    ok(!!u && !u.viewing && u.frames === 0 && !up1 && /needs a connection|Check your connection/.test(u.problem), `offline, opening a document says it needs a connection, and nothing is left open (${(u?.problem ?? 'nothing shown').slice(0, 90)})`)
    if (ENGINE !== 'webkit') await up()
    await online(ctx)
    if (ENGINE === 'webkit') {
      // record what Playwright's setOffline does to a worker-controlled navigation in WebKit
      await ctx.setOffline(true)
      const r = await page.goto(O.library + '/').then((x) => `served ${x?.status()}`, (e) => `refused (${String(e).split('\n')[0].slice(0, 60)})`)
      await ctx.setOffline(false)
      note(`WebKit with context.setOffline: a worker-controlled navigation was ${r}`)
    }
    await page.goto(O.library + '/')
    await settled(page)
    await open(page)
    ok(!!(await booted(page)), 'positive control: back online, the same deck opens and boots')
    await ctx.close()
  }

  // --- [update] a new deploy, and a precache that is not the build's ---------------------------------
  if (runs('update')) {
    section('[update] a new deploy replaces the old cache; bytes that are not the build\'s install nothing')
    files.delete(STATUS)
    deploy(X)
    let ctx = await context()
    let page = await ctx.newPage()
    await page.goto(O.library + '/')
    await settled(page)
    ok(!!(await cached(page, X.info.offline.cache)), 'precondition: build X\'s worker holds X\'s cache')
    deploy(Y)
    await page.goto(O.library + '/')
    const s = await settled(page)
    const swapped = await until(() => page.evaluate(async (n) => { const k = await caches.keys(); return k.length === 1 && k[0] === n }, Y.info.offline.cache), 15000)
    const left = await page.evaluate(() => caches.keys())
    ok(s.build === Y.info.offline.build && !!swapped, `after a new deploy, only the new build's cache is left (${left.map((k) => k.slice(0, 22)).join(', ')})`)
    await ctx.close()

    deploy(Y, { tamperPage: true })
    ctx = await context()
    page = await ctx.newPage()
    await page.goto(O.library + '/')
    await settled(page)
    await sleep(3000)
    const t = await lib(page)
    const active = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active)
    ok(t.caches.length === 0 && !active, `a library whose page is not the bytes its worker pins caches nothing (caches ${t.caches.length}, active worker ${active})`)
    await ctx.close()
    deploy(X)
  }

  // --- [kill] the drill ----------------------------------------------------------------------------------
  if (runs('kill')) {
    section('[kill] the drill: withdraw build X; the next load is clean')
    files.delete(STATUS)
    deploy(X)
    const ctx = await context()
    const page = await ctx.newPage()
    await page.goto(O.library + '/')
    let s = await settled(page)
    ok(s.status === 'unreachable' && !!(await cached(page, X.info.offline.cache)), 'precondition: build X runs, its worker installed and holding its cache')
    files.set(STATUS, status(['--seq', '5', '--withdraw', X.info.offline.build]))
    const t0 = Date.now()
    let mark = seen.length
    await page.goto(O.library + '/')
    s = await settled(page)
    note(`withdrawn to stopped and cleaned: ${Date.now() - t0} ms (${ENGINE})`)
    ok(s.status === 'withdrawn' && s.stopped && /has been withdrawn/.test(s.stopText) && !s.picker, `the withdrawn build stops and says so (${s.status}: ${s.stopText.slice(0, 60)}…)`)
    ok(s.regs.length === 0, `the withdrawn build's worker is unregistered (${s.regs.length} left)`)
    ok(s.caches.length === 0, `the withdrawn build's caches are deleted (${s.caches.length} left)`)
    // nothing opens in it
    await page.setInputFiles('#file', DECK).catch(() => {})
    await sleep(2500)
    ok((await ui(page)).frames === 0 && frameFetches(mark).length === 0, 'nothing opens in a withdrawn build (the frame page is never fetched)')
    // the withdrawn build is gone from this browser: offline, nothing serves it
    await offline(ctx)
    const gone = await page.goto(O.library + '/').then((r) => `served ${r?.status()}`, () => 'nothing')
    const still = await page.evaluate(() => document.documentElement.getAttribute('data-bento-build')).catch(() => null)
    ok(gone === 'nothing' || still !== X.info.offline.build, `offline after the kill, the withdrawn build is not served from anywhere (${gone})`)
    await online(ctx)
    // the next load: the fixed deploy
    deploy(Y)
    mark = seen.length
    const t1 = Date.now()
    await page.goto(O.library + '/')
    s = await settled(page)
    const clean = await cached(page, Y.info.offline.cache)
    note(`fixed deploy to a clean, re-installed library: ${Date.now() - t1} ms (${ENGINE})`)
    ok(s.status === 'current' && s.build === Y.info.offline.build && served(mark, '/').length >= 1, `the next load is clean: build Y from the server, status current (${s.status})`)
    ok(!!clean && (await lib(page)).regs.length === 1, 'and only Y\'s worker and cache are installed')
    await open(page)
    ok(!!(await booted(page)), 'and documents open again')
    await ctx.close()

    // a file dropped before a slow status answers never runs in a withdrawn build
    deploy(X)
    const slow = status(['--seq', '6', '--withdraw', X.info.offline.build])
    files.set(STATUS, async () => { await sleep(3000); return slow })
    const ctx2 = await context()
    const p2 = await ctx2.newPage()
    mark = seen.length
    await p2.goto(O.library + '/')
    await p2.setInputFiles('#file', DECK)
    const s2 = await settled(p2, 20000)
    await sleep(1500)
    ok(s2.status === 'withdrawn' && (await ui(p2)).frames === 0 && frameFetches(mark).length === 0,
      `a file dropped before a slow status answers never runs in a withdrawn build (${s2.status}, frame fetched ${frameFetches(mark).length})`)
    await ctx2.close()
    files.delete(STATUS)
  }

  // --- [status] fails closed ---------------------------------------------------------------------------
  if (runs('status')) {
    section('[status] the status fails closed')
    deploy(X)
    // installed: visit once with no status first, so the worker and cache exist to be removed
    const visit = async (body, ctx, { installed = false } = {}) => {
      const own = !ctx
      ctx = ctx ?? await context()
      const page = await ctx.newPage()
      if (installed) {
        files.delete(STATUS)
        await page.goto(O.library + '/')
        await settled(page)
        if (!(await cached(page, X.info.offline.cache))) ok(false, 'precondition: the worker installed before the status row')
      }
      files.set(STATUS, body)
      await page.goto(O.library + '/')
      const s = await settled(page)
      if (own) await ctx.close(); else await page.close()
      return s
    }
    const signed = JSON.parse(status(['--seq', '20']))
    const forged = JSON.stringify({ payload: signed.payload, sig: JSON.parse(await signWith(other.privateKey, signed.payload)).sig })
    let s = await visit(forged, null, { installed: true })
    ok(s.status === 'refused' && s.stopped && /could not confirm/.test(s.stopText) && s.regs.length === 0 && s.caches.length === 0,
      `a status with a bad signature fails closed: stopped, worker and caches removed (${s.status})`)
    const tampered = JSON.stringify({ ...signed, payload: signed.payload.replace('"seq":20', '"seq":21') })
    s = await visit(tampered, null, { installed: true })
    ok(s.status === 'refused', `a status whose payload changed after signing fails closed (${s.status})`)
    const otherApp = await signWith(kp.privateKey, JSON.stringify({ app: 'bento-home', seq: 30, at: new Date().toISOString(), withdrawn: [] }))
    s = await visit(otherApp)
    ok(s.status === 'refused', `a signed payload for another app, in the status's shape, fails closed (${s.status})`)
    const manifest = await signWith(kp.privateKey, JSON.stringify({ app: 'bento-slides', version: '1.2.10', sha256: 'a'.repeat(64), url: 'https://bento.page/releases/slides/Bento_Slides.bento.html', at: new Date().toISOString() }))
    s = await visit(manifest)
    ok(s.status === 'refused', `a correctly signed release manifest served as the status fails closed (${s.status})`)
    // replay: this browser has seen seq 41; an older, correctly signed status is refused
    const ctx = await context()
    s = await visit(status(['--seq', '41', '--withdraw', 'f'.repeat(64)]), ctx)
    ok(s.status === 'current' && s.sw === 'registered', `positive control: a signed status that does not list this build lets it run (${s.status})`)
    s = await visit(status(['--seq', '40']), ctx)
    ok(s.status === 'refused', `an older status than one this browser has seen fails closed (${s.status})`)
    await ctx.close()
    // a status the server cannot give (500) is no answer: the library carries on
    s = await visit(null)
    ok(s.status === 'unreachable' && !s.stopped, `no status published (404) is no answer: the library carries on (${s.status})`)
    files.delete(STATUS)
  }

  // --- [install] -----------------------------------------------------------------------------------------
  if (runs('install')) {
    section('[install] the web app manifest')
    deploy(X)
    files.delete(STATUS)
    const ctx = await context()
    const page = await ctx.newPage()
    await page.goto(O.library + '/')
    await settled(page)
    const link = await page.evaluate(() => document.querySelector('link[rel=manifest]')?.getAttribute('href'))
    ok(link === '/manifest.webmanifest', `the library links its manifest (${link})`)
    const r = await ctx.request.get(O.library + '/manifest.webmanifest')
    const m = await r.json().catch(() => null)
    ok(r.status() === 200 && /application\/manifest\+json/.test(r.headers()['content-type'] ?? ''), `the manifest is served as application/manifest+json (${r.headers()['content-type']})`)
    ok(!!m && m.name === 'bento/home' && m.start_url === '/' && m.scope === '/' && m.id === '/' && m.display === 'standalone', 'the manifest names the app, starts and is scoped at /, and displays standalone')
    const icons = []
    for (const i of m?.icons ?? []) {
      const ir = await ctx.request.get(O.library + i.src)
      const b = await ir.body()
      icons.push({ sizes: i.sizes, ok: ir.status() === 200 && b.readUInt32BE(16) + 'x' + b.readUInt32BE(20) === i.sizes })
    }
    ok(icons.length === 2 && icons.every((i) => i.ok) && icons.some((i) => i.sizes === '192x192') && icons.some((i) => i.sizes === '512x512'), `192 and 512 px PNG icons are served at their stated sizes (${JSON.stringify(icons)})`)
    if (ENGINE === 'chromium') {
      const cdp = await ctx.newCDPSession(page)
      const am = await cdp.send('Page.getAppManifest').catch((e) => ({ errors: [String(e)] }))
      ok(am.url === O.library + '/manifest.webmanifest' && !am.errors?.length && !!am.data, `the engine loads the manifest under the library's CSP (${am.url ?? 'none'}; errors ${JSON.stringify(am.errors ?? [])})`)
      const ie = await cdp.send('Page.getInstallabilityErrors').catch((e) => ({ installabilityErrors: [{ errorId: String(e) }] }))
      ok(!ie.installabilityErrors?.length, `Chromium finds the library installable (${JSON.stringify(ie.installabilityErrors)})`)
    } else note(`${ENGINE}: installability is Chromium's to report (CDP); the manifest rows above are the engine-neutral check`)
    await ctx.close()
  }

  // --- [network] -----------------------------------------------------------------------------------------
  if (runs('network')) {
    section('[network] every request in this run [T2]')
    if (!S) await up()
    const ctx = await context()
    const page = await ctx.newPage()
    await page.goto(O.library + '/')
    await settled(page)
    const probe = `${O.releaseBase}probe/library`
    await page.evaluate((u) => fetch(u).catch(() => {}), probe)
    await sleep(1000)
    ok(recorded.some((r) => r.url === probe) && seen.some((r) => r.url === probe), 'positive control: a request planted in the library is seen in the browser and at the server')
    const sock = await ctx.newPage()
    await sock.evaluate(() => { try { new WebSocket('ws://127.0.0.1:9/bento-hw3-probe') } catch {} })
    await until(() => sockets.includes('ws://127.0.0.1:9/bento-hw3-probe'), 5000)
    ok(sockets.includes('ws://127.0.0.1:9/bento-hw3-probe'), 'positive control: a socket opened by a page in this context is recorded')
    await ctx.close()
    const allowed = (r) => (r.method === 'GET' && (LIB_PATHS.some((p) => r.url === O.library + p) || r.url === O.frame + '/frame.html' || r.url.startsWith(O.releaseBase))) ||
      /^(blob|data|about):/.test(r.url)
    const stray = recorded.filter((r) => !allowed(r))
    ok(stray.length === 0, `every request the browser made is on the allow-list (${recorded.length} recorded${stray.length ? '; stray: ' + stray.slice(0, 3).map((r) => r.method + ' ' + r.url).join(', ') : ''})`)
    const strayS = seen.filter((r) => !allowed(r))
    ok(strayS.length === 0, `every request the servers received is on the allow-list (${seen.length}${strayS.length ? '; stray: ' + strayS.slice(0, 3).map((r) => r.method + ' ' + r.url).join(', ') : ''})`)
    const forms = [CANARY, Buffer.from(CANARY).toString('base64').slice(0, 16), encodeURIComponent(CANARY)]
    const leaks = recorded.filter((r) => forms.some((c) => r.url.includes(c) || r.body.includes(c) || r.headers.includes(c)))
    ok(leaks.length === 0, `no URL, header or body carries the document's canary${leaks.length ? ': ' + leaks[0].url : ''}`)
    ok(sockets.filter((u) => !u.includes('bento-hw3-probe')).length === 0, 'no socket was opened by the library, its worker or a document')
  }
} catch (e) {
  ok(false, `the run threw: ${String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ')}`)
}

ok(!crashed, `the browser stayed up for the whole run (${ENGINE})`)
closing = true
await browser.close().catch(() => {})
await down()
if (crashed || failures) console.log(`\n${checks - failures}/${checks} checks passed (${ENGINE}) — ${crashed ? 'the browser crashed: this run is not a pass' : 'FAILED'}`)
else console.log(`\n${checks - failures}/${checks} checks passed (${ENGINE})`)
process.exit(failures || crashed ? 1 : 0)
