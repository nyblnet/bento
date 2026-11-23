#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The D5(c) kill-switch drill for bento/home in your browser: a hostile
 * service worker on the library origin, then the fixed deploy. Measured in a
 * real browser, per engine, against the local emulation of the host's kill
 * route (scripts/lib/home-web-kill-host.mjs, which is also its specification).
 *
 *   PLAYWRIGHT_MODULE=…/playwright/index.mjs node scripts/test-home-web-kill-drill.mjs
 *   BENTO_BROWSER=webkit|firefox|chrome …   another engine (default chromium)
 *   … --mutants [name…]                      each mutant must turn its row red
 *
 * The attacker's deploy plants /x/evil-sw.js (served with
 * Service-Worker-Allowed: /) and a page that registers it with scope /. The
 * worker answers every navigation itself and keeps a cache. Positive control:
 * the library's own path / then shows the attacker's page. Then the fixed
 * deploy goes up: the planted paths are gone.
 *
 *   [D5c-base]  WITHOUT the route (the planted path now 404s, as a static host
 *               answers): whether the hostile worker still controls / after 1,
 *               2 and 3 navigations. Recorded, not judged: it is the baseline
 *               that shows the route is needed (or, in an engine that drops a
 *               worker whose script 404s, that it is not the only defence).
 *   [D5c-spec]  the route as a function and over HTTP: a worker-script request is
 *               answered with the cleaning worker at ANY path shape (no extension,
 *               .mjs, deep, a query string, a name the build serves as a file);
 *               the build's own /sw.js is served as built.
 *   [D5c-route] WITH the route: the hostile worker is gone (no registration),
 *               every cache is deleted, and / is the real library, within 3
 *               navigations; the number of navigations and the seconds taken
 *               are printed. [D5c-route-shape] the same for a worker registered
 *               at /x/agent?v=1 (no .js, a query string). Every page call is
 *               bounded, so a row that cannot finish reports red itself.
 *   [D5c-reset] the reset page: after a worker that passes navigations through
 *               (a stale worker, not a hostile one), /reset leaves no
 *               registration and no cache. A hostile worker answers /reset
 *               itself, so the reset page is no defence against one: that row
 *               is recorded too.
 *
 * Builds home/web once (the library is served by the kill host, not
 * home/web/serve.mjs); no frame site is needed. Every WebSocket is refused.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = process.env.BENTO_BROWSER || 'chromium'
const args = process.argv.slice(2)

const MUTANTS = [
  { name: 'route-404', why: 'the host answers a worker-script request at an unknown path with 404, as a static host does', expect: ['[D5c-route]'] },
  { name: 'no-cache-delete', why: 'the cleaning worker unregisters but leaves the caches', expect: ['[D5c-route] every cache'] },
  { name: 'path-shape', why: 'the route answers a worker-script request only at a path ending -sw.js, not at ANY path', expect: ['[D5c-spec] any path shape', '[D5c-spec] over HTTP', '[D5c-route-shape]'] },
  { name: 'no-unregister', why: 'the cleaning worker deletes the caches but keeps its own registration', expect: ['[D5c-route] the hostile worker is gone'] },
  { name: 'reset-bare', why: 'the reset page is sent without Clear-Site-Data and without its script', expect: ['[D5c-reset] /reset leaves'] },
]
if (args.includes('--mutants')) {
  const names = args.slice(args.indexOf('--mutants') + 1)
  let n = 0, bad = 0
  for (const m of MUTANTS.filter((x) => !names.length || names.includes(x.name))) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, NODE_NO_WARNINGS: '1', BENTO_KILL_MUTANT: m.name }, encoding: 'utf8', timeout: 600_000 })
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    const applied = out.includes(`mutant applied: ${m.name}`)
    const fails = out.split('\n').filter((l) => l.includes('FAIL'))
    const caught = m.expect.every((e) => fails.some((l) => l.includes(e)))
    const good = applied && r.status !== 0 && caught
    n++; if (!good) bad++
    console.log(`  ${good ? 'ok  ' : 'FAIL'}  ${m.name}: ${m.why} — ${!applied ? 'NOT APPLIED' : caught ? `red on ${m.expect.join(' + ')}` : r.status === 0 ? 'SURVIVED' : 'red, but not on its row'}`)
    if (!good) console.log(out.split('\n').filter((l) => /FAIL|Error|mutant/.test(l)).slice(0, 8).map((l) => '        ' + l).join('\n'))
  }
  console.log(`\n${n - bad}/${n} mutants killed (${ENGINE})`)
  process.exit(bad ? 1 : 0)
}
const MUTANT = process.env.BENTO_KILL_MUTANT || null
// the host's mutant list: 'reset-bare' is both halves of the reset page removed
const HOST_MUTANT = MUTANT === 'reset-bare' ? ['reset-no-header', 'reset-no-script'] : MUTANT
if (MUTANT && !MUTANTS.some((m) => m.name === MUTANT)) throw new Error(`unknown mutant ${MUTANT}`)

const { startKillHost, killRoute } = await import(path.join(ROOT, 'scripts/lib/home-web-kill-host.mjs'))
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { guardBrowser, apiLogger } = await import(path.join(ROOT, 'scripts/lib/browser-guard.mjs'))

let checks = 0, failures = 0
let guard = null
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); guard?.progress(m) }
const note = (m) => { console.log(`  note  ${m}`); guard?.progress(m) }
const section = (m) => { console.log(`\n=== ${m}`); guard?.section(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-kill-drill-'))
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }))

// --- the route as a function (no browser): the specification's own rows ---------------------------
section('[D5c-spec] the route, as the host must answer')
{
  const H = (p, sw) => killRoute({ method: 'GET', path: p, headers: sw ? { 'service-worker': 'script' } : {} }, { mutant: HOST_MUTANT })
  const a = H('/x/evil-sw.js', true), own = H('/sw.js', true), plain = H('/x/evil-sw.js', false), reset = H('/reset', false)
  ok(a?.status === 200 && a.headers['service-worker-allowed'] === '/' && a.headers['cache-control'] === 'no-store' && a.body.includes('caches.delete') && a.body.includes('registration.unregister'),
    `[D5c-route] spec: a worker-script request at any path gets a 200 cleaning worker with Service-Worker-Allowed: / and no-store (${a?.status})`)
  ok(own === null && plain === null, '[D5c-spec] the build\'s own /sw.js, and a request without Service-Worker: script, are served as usual')
  ok(reset?.headers?.['clear-site-data'] === '"cache", "storage"' && /<script>[^<]*unregister[^<]*caches\.delete/.test(reset.body ?? ''),
    `[D5c-reset] spec: the reset page sends Clear-Site-Data "cache", "storage" and carries its unregister script (${reset?.headers?.['clear-site-data']})`)
  // the route's claim is ANY path: the shapes an attacker can register a worker at (no extension,
  // another extension, deep, a name the build also serves). A query string never reaches this
  // function (the server passes it the pathname): the HTTP rows below carry one.
  const SHAPES = ['/x/evil', '/x/evil.mjs', '/a/b/c/d/worker', '/x/evil.js', '/icon-192.png', '/index.html', '/reset.js']
  const shapes = SHAPES.map((p) => [p, H(p, true)?.status ?? null])
  ok(shapes.every(([, s]) => s === 200), `[D5c-spec] any path shape: a worker-script request is answered with the cleaning worker at every path (${shapes.map(([p, s]) => p + ' ' + s).join(', ')})`)
  if (MUTANT) console.log(`  mutant applied: ${MUTANT}`)
}

// --- build -------------------------------------------------------------------------------------
section(`build (${ENGINE})`)
const out = path.join(work, 'dist')
const r = spawnSync(process.execPath, [path.join(ROOT, 'home/web/build.mjs'), '--out', out, '--library-origin', 'http://127.0.0.1:1', '--frame-origin', 'http://localhost:2', '--dev'], { encoding: 'utf8' })
console.log(`  build: exit ${r.status}`)
if (r.status !== 0) { console.log(r.stderr); process.exit(2) }
// the build names its own origin in its policy; the kill host serves it on another port, so the
// library page's policy is not what these rows are about: they read the worker registrations and
// caches of the ORIGIN, and what / answers.

// the same shapes over HTTP, through the kill host's own server, with query strings: what the
// browser rows reach (a path the build serves as a file is still answered as a worker script)
{
  const host = await startKillHost({ dir: path.join(out, 'library'), route: true, mutant: HOST_MUTANT })
  const got = []
  for (const p of ['/x/agent?v=1', '/x/evil-sw.js?x=1', '/a/b/worker.mjs?y', '/icon-192.png?z']) {
    const res = await fetch(host.origin + p, { headers: { 'service-worker': 'script' } })
    const body = await res.text()
    got.push([p, res.status, res.headers.get('service-worker-allowed'), body.includes('registration.unregister')])
  }
  const own = await fetch(host.origin + '/sw.js', { headers: { 'service-worker': 'script' } })
  const ownBody = await own.text()
  await host.close()
  ok(got.every(([, s, swa, clean]) => s === 200 && swa === '/' && clean), `[D5c-spec] over HTTP, with query strings: every worker-script request is answered with the cleaning worker (${got.map(([p, s, swa, c]) => `${p} ${s} ${swa} ${c ? 'clean' : 'NOT clean'}`).join('; ')})`)
  ok(own.status === 200 && !ownBody.includes('registration.unregister'), `[D5c-spec] over HTTP: the build's own /sw.js is served as built (${own.status})`)
}

// --- the attacker's deploy -------------------------------------------------------------------------
const EVIL_SW = `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil((async () => { const c = await caches.open('evil'); await c.put('/evil-canary', new Response('kept by the attacker')); await self.clients.claim() })()))
self.addEventListener('fetch', (e) => { if (e.request.mode === 'navigate' && MODE === 'hostile') e.respondWith(new Response('<!doctype html><title>evil</title><p id="evil">the attacker answers this page</p>', { headers: { 'content-type': 'text/html' } })) })
`
const REGISTER = (url) => '<!doctype html><title>register</title><script>navigator.serviceWorker.register(' + JSON.stringify(url) + ', { scope: "/" }).then(() => { document.title = "registered" }, (e) => { document.title = "refused " + e.name })</script>'
/** The attacker's deploy: the worker script at `sw` (a URL path, query allowed) and a page that registers it. */
function plant(host, mode, sw) {
  host.extra.set(new URL(sw, 'http://x').pathname, { headers: { 'content-type': 'text/javascript', 'service-worker-allowed': '/', 'cache-control': 'no-cache' }, body: `const MODE = ${JSON.stringify(mode)}\n` + EVIL_SW })
  host.extra.set('/x/evil.html', { headers: { 'content-type': 'text/html' }, body: REGISTER(sw) })
}
const unplant = (host, sw) => { host.extra.delete(new URL(sw, 'http://x').pathname); host.extra.delete('/x/evil.html') }

// --- browser --------------------------------------------------------------------------------------
const browser = ENGINE === 'chrome' ? await pw.chromium.launch({ channel: 'chrome', logger: apiLogger }) : await pw[ENGINE].launch({ logger: apiLogger })
guard = guardBrowser(browser, { rig: `home/web kill drill (${ENGINE})` })
const sockets = []
// every page call is bounded, so a page caught in a navigation loop reports red on its own row
// rather than through the browser guard's timeout
const bounded = (p, ms, what) => Promise.race([p, new Promise((r) => setTimeout(() => r({ error: `${what} did not answer within ${ms} ms` }), ms))])
const state = (page) => bounded(page.evaluate(async () => {
  const regs = await navigator.serviceWorker.getRegistrations()
  return {
    evil: !!document.getElementById('evil'), library: !!document.getElementById('file'),
    regs: regs.map((g) => (g.active || g.waiting || g.installing)?.scriptURL ?? 'none'), caches: await caches.keys(),
  }
}).catch((e) => ({ error: String(e.message).split('\n')[0] })), 5000, 'the page').then((s) => (s.error ? { evil: false, library: false, regs: ['unknown'], caches: ['unknown'], ...s } : s))
async function until(fn, ms) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v || Date.now() > end) return v; await sleep(200) } }
const go = (page, url) => page.goto(url, { waitUntil: 'load', timeout: 10000 }).catch(() => null)

/** A fresh context and kill host; the attacker's worker registered at `sw` and in control of /. */
async function infected(mode, routeOn, sw = '/x/evil-sw.js') {
  const host = await startKillHost({ dir: path.join(out, 'library'), route: false, mutant: HOST_MUTANT })
  const ctx = await browser.newContext()
  await ctx.routeWebSocket(/.*/, (ws) => { sockets.push(ws.url()); ws.close() })
  const page = await ctx.newPage()
  plant(host, mode, sw)
  await go(page, host.origin + '/x/evil.html')
  const reg = await until(() => bounded(page.evaluate(async () => document.title === 'registered' && !!(await navigator.serviceWorker.getRegistration('/'))?.active), 5000, 'the page').then((v) => v === true), 10000)
  await go(page, host.origin + '/')
  const s = await state(page)
  // the fixed deploy: the planted paths are gone; the route is on or off
  unplant(host, sw)
  host.set({ route: routeOn })
  return { host, ctx, page, reg: !!reg, s }
}

try {
  section('[D5c-base] the fixed deploy, WITHOUT the route: the planted path now answers 404')
  {
    const { host, ctx, page, reg, s } = await infected('hostile', false)
    ok(reg && s.evil && s.regs.length === 1 && s.caches.includes('evil'), `[D5c-base] positive control: the hostile worker registered with scope / and answers the library's own path (${JSON.stringify(s)})`)
    const per = []
    for (let i = 1; i <= 3; i++) {
      await go(page, host.origin + '/')
      await sleep(1500) // the update check runs after the navigation
      const t = await state(page)
      per.push(`${i}: ${t.evil ? 'hostile' : t.library ? 'library' : 'other'}, ${t.regs.length} worker(s)`)
    }
    const updates = host.seen.filter((q) => q.path === '/x/evil-sw.js' && q.sw === 'script').length
    note(`[D5c-base] ${ENGINE}: after the fixed deploy, with the planted script answering 404: ${per.join('; ')} (${updates} update fetches of the planted script)`)
    ok(updates >= 1, `[D5c-base] the engine did ask the host for the planted script again (${updates}): the route can be reached by the update check`)
    await ctx.close(); await host.close()
  }

  /** The fixed deploy with the route, against a hostile worker registered at `sw`: gone within 3 navigations. */
  const routeRow = async (tag, sw) => {
    const { host, ctx, page, reg, s } = await infected('hostile', true, sw)
    const p = new URL(sw, 'http://x').pathname
    ok(reg && s.evil, `[${tag}] positive control: the hostile worker, registered at ${sw}, answered / before the fixed deploy (${JSON.stringify(s)})`)
    const t0 = Date.now()
    let navs = 0, t = null
    for (navs = 1; navs <= 3; navs++) {
      await go(page, host.origin + '/')
      t = await until(async () => { const x = await state(page); return x.regs.length === 0 && !x.evil ? x : null }, 4000) ?? await state(page)
      if (t.regs.length === 0 && !t.evil) break
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    const served = host.seen.filter((q) => q.path === p && q.sw === 'script').length
    ok(t.regs.length === 0 && !t.evil && t.library, `[${tag}] the hostile worker is gone and / is the real library within 3 navigations (${sw}; ${navs <= 3 ? navs : 'not within 3'} navigation(s), ${secs} s; ${served} worker-script fetches at that path; ${JSON.stringify(t)})`)
    // the library page registers its own worker again on that load: the ATTACKER's cache is what must be gone
    ok(!t.caches.includes('evil'), `[${tag}] every cache the hostile worker kept is deleted (${JSON.stringify(t.caches)})`)
    note(`[${tag}] ${ENGINE}: time to clean ${secs} s, ${navs <= 3 ? navs : '>3'} navigation(s)`)
    await ctx.close(); await host.close()
  }
  section('[D5c-route] the fixed deploy WITH the route: the hostile worker is replaced by the cleaning worker')
  await routeRow('D5c-route', '/x/evil-sw.js')
  // the route's claim is ANY path: a worker registered at a path with no extension and a query
  section('[D5c-route-shape] the same, the hostile worker registered at a path with no .js and a query string')
  await routeRow('D5c-route-shape', '/x/agent?v=1')

  section('[D5c-reset] the reset page and Clear-Site-Data')
  {
    // a stale worker (passes navigations through) and its cache, then /reset from the server
    const { host, ctx, page, reg, s } = await infected('stale', false)
    host.set({ route: true }) // the reset page is part of the route
    ok(reg && !s.evil && s.regs.length === 1 && s.caches.includes('evil'), `[D5c-reset] positive control: a stale worker is registered and keeps a cache (${JSON.stringify(s)})`)
    // the update check this navigation starts would clean on its own: hold the route's worker
    // answer back for this row, so only the page's Clear-Site-Data can do the work
    host.set({ route: true, mutant: ['route-404', ...[].concat(HOST_MUTANT ?? [])] })
    const rs = await go(page, host.origin + '/reset')
    await sleep(1000)
    const t = await state(page)
    ok(!!rs && rs.status() === 200 && t.regs.length === 0 && t.caches.length === 0, `[D5c-reset] /reset leaves no worker and no cache (${JSON.stringify(t)})`)
    await ctx.close(); await host.close()
  }
  {
    // what the header does ALONE in this engine (recorded: it decides whether the script is needed)
    const { host, ctx, page } = await infected('stale', false)
    host.set({ route: true, mutant: ['route-404', 'reset-no-script'] })
    await go(page, host.origin + '/reset')
    await sleep(1000)
    const t = await state(page)
    note(`[D5c-reset] ${ENGINE}: Clear-Site-Data "cache", "storage" ALONE leaves ${t.regs.length} worker(s) and ${t.caches.length} cache(s)`)
    await ctx.close(); await host.close()
  }
  {
    const { host, ctx, page, s } = await infected('hostile', false)
    host.set({ route: true, mutant: 'route-404' })
    await go(page, host.origin + '/reset')
    await sleep(1000)
    const t = await state(page)
    const reached = host.seen.some((q) => q.path === '/reset')
    note(`[D5c-reset] ${ENGINE}: under a HOSTILE worker, /reset ${reached ? 'reached the server' : 'never reached the server (the worker answered it)'}; afterwards ${JSON.stringify({ evil: t.evil, regs: t.regs.length, caches: t.caches })}. Only the update route removes a hostile worker.`)
    ok(s.evil, '[D5c-reset] (control for the note above: the hostile worker was in control)')
    await ctx.close(); await host.close()
  }

  section('[network] sockets')
  ok(sockets.length === 0, `no WebSocket was opened in this run (${sockets.length})`)
} catch (e) {
  ok(false, `the run threw: ${String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ')}`)
}
await guard.close()
console.log(`\n${checks - failures}/${checks} checks passed (${ENGINE})`)
process.exit(failures ? 1 : 0)
