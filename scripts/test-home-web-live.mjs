#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/home in your browser: the --live build (home/web/build.mjs), which lets
 * the frame reach exactly one relay, in a real browser against the REAL relay.
 *
 *   PLAYWRIGHT_MODULE=…/playwright/index.mjs node scripts/test-home-web-live.mjs
 *   … --chrome                       the installed Google Chrome
 *   BENTO_BROWSER=webkit|firefox …   another engine (default chromium)
 *   … --mutants [name]               each mutant must turn its row red
 *
 * Two builds against local origins, the same as test-home-web.mjs: LIVE
 * (--live, the default relay wss://sync.bento.page) and PLAIN (no --live).
 * Every WebSocket in every context goes through Playwright's routeWebSocket:
 * the relay origin is served by the REAL Room (server/sync-worker, through
 * scripts/lib/relay-route.mjs), every other socket is closed and counted.
 *
 * Rows:
 *   [L3]  the frame's connect-src is EXACTLY the release channel plus the relay
 *         (wss: and https:); the library page and its headers are byte-identical
 *         to the plain build's; the build refuses --live without --dev, a
 *         --sync-origin without --live, and anything but a ws(s) origin whose
 *         host is a plain DNS name or an IP literal (no '*', ';', ',' and no
 *         userinfo: the host lands in a CSP source verbatim).
 *   [L1]  the policy, with REAL sockets: a third build (LOCAL) names a local
 *         relay, ws://127.0.0.1:<port>, served by a raw WebSocket server here.
 *         A socket from the frame reaches it; the PLAIN build refuses the same
 *         socket (securitypolicyviolation, 0 handshakes at the server); a blob
 *         fetch to the relay's http(s) origin leaves the frame. These rows use
 *         NO routeWebSocket: Playwright's routing replaces WebSocket inside the
 *         page, so a routed socket never meets the page's CSP (measured: with
 *         routing on, the plain build's frame "reached" the relay).
 *   [L4]  steering: a socket or fetch from the frame to any other host or port
 *         is refused by the browser (a violation, 0 handshakes there).
 *   [L1r] routing positive control: routeWebSocket SEES a socket opened in the
 *         sandboxed (out-of-process) frame and the real Room answers it. If it
 *         did not, every "0 sockets" row below would be vacuous.
 *   [Lk]  a released shell (slides 1.2.10) with a live session opens in the
 *         LIVE build and opens NO socket: the kernel's sandboxed() rule keeps it
 *         off the network in an opaque, storage-less frame. Control: the same
 *         file opened directly (file://) joins the room. The library says the
 *         document is not live here, which is the truth.
 *   [L5]  read-only in the newest release: the document is given NO session
 *         (its collab is removed before it is spliced), so no shell can join
 *         with credentials the file never chose that code for. An ENCRYPTED
 *         fork (a bento/enc envelope over a live document) is never offered
 *         read-only at all, which is why the removal need not look inside one.
 *   [L7]  teardown: closing the document closes a socket its frame holds.
 *   [L8]  two documents in two frames share no BroadcastChannel (opaque origins);
 *         control: two file:// pages do.
 *   [L9]  every socket not bound for the relay was closed and counted: 0 from
 *         the library's pages, beyond the planted ones.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, webcrypto } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = process.env.BENTO_BROWSER || 'chromium'
const CHROME = process.argv.includes('--chrome')
const RELAY = 'wss://sync.bento.page'
const RELAY_HTTP = 'https://sync.bento.page'

// ---- mutants: each is a run of this rig that must FAIL on its row -----------------------
// source: BENTO_HOME_WEB_MUTANT (applied by build.mjs, --dev only); dist: an edit
// to a built file of the LIVE build (BENTO_LIVE_DIST_MUTANT).
const MUTANTS = [
  // __WS__/__HTTP__ are the LOCAL build's relay origins, filled in at build time
  { name: 'no-relay-in-frame-csp', row: '[L1] a socket from the frame reaches the relay',
    dist: [{ build: 'local', file: 'frame/_headers', from: ' __WS__ __HTTP__', to: '', all: true }] },
  { name: 'frame-csp-any-ws', row: '[L4] a socket from the frame to another port is refused',
    dist: [{ build: 'local', file: 'frame/_headers', from: ' __WS__ __HTTP__', to: ' __WS__ __HTTP__ ws:', all: true }] },
  { name: 'frame-csp-any-http', row: '[L4] a fetch from the frame to another origin is refused',
    dist: [{ build: 'local', file: 'frame/_headers', from: ' __WS__ __HTTP__', to: ' __WS__ http:', all: true }] },
  { name: 'relay-in-library-csp', row: '[L3] the library\'s headers are byte-identical',
    dist: [{ build: 'live', file: 'library/_headers', from: 'frame-src ', to: `connect-src-extra ${RELAY}; frame-src `, all: true }] },
  { name: 'read-only-keeps-session', row: '[L5] read-only: the document is given no live session',
    src: { file: 'library.ts', from: 'const spliced = spliceDoc(shell.html, withoutSession(doc.text))', to: 'const spliced = spliceDoc(shell.html, doc.text)' } },
  { name: 'frame-kept-on-close', row: '[L7] closing the document closes the socket its frame held',
    src: { file: 'library.ts', from: '  session.frame.remove()\n', to: '  session.frame.hidden = true\n' } },
  { name: 'sync-host-any', row: '[L3] the build refuses a wildcard sync host',
    buildMjs: { from: 'if (!(dnsName.test(x.hostname) ||', to: 'if (false && !(dnsName.test(x.hostname) ||' } },
  { name: 'sync-host-semicolon', row: '[L3] the build refuses a sync host carrying ";"',
    buildMjs: { from: '(?:\\.[a-z0-9](?:[a-z0-9-]*', to: '(?:\\.[a-z0-9](?:[a-z0-9;-]*' } },
  { name: 'sync-userinfo-kept', row: '[L3] the build refuses a sync origin with userinfo',
    buildMjs: { from: 'if (x.username || x.password) die(', to: 'if (false) die(' } },
  { name: 'enc-fork-offered', row: '[L5] an encrypted fork carrying a live session is never offered read-only',
    src: { file: 'library.ts', from: "const app = 'text' in doc ? APPS.find((a) => a.format === doc.format) : undefined", to: "const app = 'text' in doc ? APPS.find((a) => a.format === doc.format || doc.format === 'bento/enc') : undefined" } },
  { name: 'live-in-production', row: '[L3] the build refuses --live in a production build',
    buildMjs: { from: "if (live) devOnly('--live", to: "if (false) devOnly('--live" } },
  { name: 'notice-claims-live', row: '[Lk] the library says it is not live here',
    src: { file: 'library.ts', from: "say('notice', 'This is a live document. You are seeing it as it was last saved: it is not live here.')", to: "say('notice', 'This is a live document.')" } },
]

if (process.argv.includes('--mutants')) {
  const only = process.argv[process.argv.indexOf('--mutants') + 1]
  const list = MUTANTS.filter((m) => !only || only.startsWith('--') || m.name === only)
  if (!list.length) { console.error(`no mutant named ${only}`); process.exit(2) }
  let killed = 0
  for (const m of list) {
    const env = { ...process.env, BENTO_LIVE_ONLY_ROW: m.row }
    delete env.BENTO_HOME_WEB_MUTANT; delete env.BENTO_LIVE_DIST_MUTANT
    if (m.src) env.BENTO_HOME_WEB_MUTANT = JSON.stringify(m.src)
    if (m.dist) env.BENTO_LIVE_DIST_MUTANT = JSON.stringify(m.dist)
    let copy = null
    if (m.buildMjs) {
      // a mutated build.mjs beside the real one, so its relative imports resolve
      const real = path.join(ROOT, 'home/web/build.mjs')
      const t = fs.readFileSync(real, 'utf8')
      if (t.split(m.buildMjs.from).length !== 2) { console.log(`SURVIVED  ${m.name}: its edit does not apply once`); continue }
      copy = path.join(ROOT, `home/web/.mutant-build-${process.pid}.mjs`)
      fs.writeFileSync(copy, t.replace(m.buildMjs.from, () => m.buildMjs.to))
      env.BENTO_LIVE_BUILD_MJS = copy
      console.log('  mutant applied to build.mjs')
    }
    const args = [fileURLToPath(import.meta.url), ...(CHROME ? ['--chrome'] : [])]
    const r = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 600_000 })
    if (copy) fs.rmSync(copy, { force: true })
    const out = (r.stdout || '') + (r.stderr || '')
    const applied = !!copy || /mutant applied/.test(out)
    const red = out.split('\n').filter((l) => l.includes('FAIL') && l.includes(m.row))
    const dead = r.status !== 0 && applied && red.length > 0
    if (dead) killed++
    console.log(`${dead ? 'killed  ' : 'SURVIVED'}  ${m.name}: ${red[0]?.trim() ?? `(applied: ${applied}, exit ${r.status}, no FAIL on "${m.row}")`}`)
    if (!dead) console.log(out.split('\n').filter((l) => /FAIL|mutant|Error/.test(l)).slice(0, 12).join('\n'))
  }
  console.log(`\n${killed}/${list.length} mutants killed`)
  process.exit(killed === list.length ? 0 : 1)
}

const { startServers, freePorts } = await import(path.join(ROOT, 'home/web/serve.mjs'))
const { spliceDoc, extractDoc } = await import(path.join(ROOT, 'home/web/src/verify.ts'))
const { scanBlocks, executableScripts } = await import(path.join(ROOT, 'kernel/src/gate1.ts'))
const { relayWorld } = await import(path.join(ROOT, 'scripts/lib/relay-route.mjs'))
const { guardBrowser, apiLogger } = await import(path.join(ROOT, 'scripts/lib/browser-guard.mjs'))
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0, failures = 0
let guard = null
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); guard?.progress(m) }
const note = (m) => { console.log(`  note  ${m}`); guard?.progress(m) }
const section = (m) => { console.log(`\n=== ${m}`); guard?.section(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 20000) {
  const end = Date.now() + ms
  const limit = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('check timed out')), 10000))])
  while (Date.now() < end) { try { const v = await limit(fn()); if (v) return v } catch {} await sleep(150) }
  return null
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-home-web-live-'))
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }))

// ---- fixtures ---------------------------------------------------------------------------
const REAL = path.join(ROOT, 'home/fixtures/gate1/real/slides-1.2.10')
const shell1210 = fs.readFileSync(path.join(REAL, 'Bento_Slides.bento.html'), 'utf8')
const realHistory = JSON.parse(fs.readFileSync(path.join(REAL, 'history.json'), 'utf8'))
const realPayload = JSON.parse(realHistory.payload)
const CANARY = 'BENTO-LIVE-CANARY-' + webcrypto.getRandomValues(new Uint32Array(2)).join('')
const docJson = JSON.stringify({
  format: 'bento/slides', version: 1, docId: webcrypto.randomUUID(), title: CANARY, size: { w: 1280, h: 720 },
  slides: [{ id: 's1', background: '#ffffff', elements: [{ id: 't1', type: 'text', x: 96, y: 200, w: 1000, h: 120, html: 'Hello ' + CANARY, fontSize: 48, color: '#16273E' }] }],
}).replace(/</g, '\\u003c')
const F = (k) => path.join(work, `${k}.bento.html`)
fs.writeFileSync(F('plain'), spliceDoc(shell1210, docJson))

const hex = (s) => createHash('sha256').update(s).digest('hex')
const b64 = (s) => createHash('sha256').update(s).digest('base64')
const loaderOf = (html) => executableScripts(scanBlocks(html)).find((b) => b.text.includes("inflate('bento-rt')"))
const withLoaderNote = (html, n) => { const b = loaderOf(html); const at = b.start + b.text.length; return html.slice(0, at) + `\n// ${n}\n` + html.slice(at) }
// a newer release (1.2.99) for the read-only row, signed with a throwaway key the LIVE build carries
const futureShell = withLoaderNote(shell1210, 'build 1.2.99')
const futureLoader = loaderOf(shell1210).text + '\n// build 1.2.99\n'
const e0 = realPayload.releases[0]
const futureEntry = {
  version: '1.2.99', sha256: hex(futureShell), at: '2026-11-09T00:00:00.000Z',
  pins: { v: 1, blocks: { ...e0.pins.blocks, loader: hex(futureLoader) }, scriptSrc: [`sha256-${b64(futureLoader)}`, e0.pins.scriptSrc[1]] },
}
const historyPlus = JSON.stringify({ ...realPayload, releases: [futureEntry, ...realPayload.releases] })
const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const { kty, crv, x, y } = await webcrypto.subtle.exportKey('jwk', kp.publicKey)
const sign = async (payload) => JSON.stringify({ payload, sig: Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(payload))).toString('base64') })
fs.writeFileSync(path.join(work, 'test-key.json'), JSON.stringify({ kty, crv, x, y }))
fs.writeFileSync(path.join(work, 'history-test.json'), await sign(realHistory.payload))
const SHELL_URL = 'https://bento.page/releases/slides/Bento_Slides.bento.html'
const manifestFuture = await sign(JSON.stringify({ app: 'bento-slides', version: '1.2.99', sha256: hex(futureShell), url: SHELL_URL, at: futureEntry.at }))

// ---- builds -----------------------------------------------------------------------------
const distMutants = process.env.BENTO_LIVE_DIST_MUTANT ? JSON.parse(process.env.BENTO_LIVE_DIST_MUTANT) : []
const BUILD = process.env.BENTO_LIVE_BUILD_MJS || path.join(ROOT, 'home/web/build.mjs')
async function build(name, extra, { mutate = false, fill = {} } = {}) {
  const [pl, pf, pr] = await freePorts(3)
  const out = path.join(work, name)
  const o = { library: `http://127.0.0.1:${pl}`, frame: `http://localhost:${pf}`, releaseBase: `http://127.0.0.1:${pr}/releases/` }
  const env = { ...process.env }
  if (!mutate) delete env.BENTO_HOME_WEB_MUTANT
  execFileSync(process.execPath, [BUILD, '--out', out, '--library-origin', o.library, '--frame-origin', o.frame, '--release-base', o.releaseBase,
    '--dev', '--key', path.join(work, 'test-key.json'), '--history', path.join(work, 'history-test.json'), ...extra], { stdio: ['ignore', 'ignore', 'inherit'], env })
  if (mutate) for (const m0 of distMutants.filter((d) => d.build === name)) {
    const sub = (t) => Object.entries(fill).reduce((a, [k, v]) => a.split(k).join(v), t)
    const m = { ...m0, from: sub(m0.from), to: sub(m0.to) }
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
  const s = await startServers({ dist: out, ports: { library: pl, frame: pf, release: pr }, onRequest: (r) => seen.push(`http://${r.headers.host}${r.url}`) })
  return { ...o, info, s, seen, out }
}

section(`[L3] the builds (${ENGINE}${CHROME ? ', Google Chrome' : ''})`)
// the raw WebSocket servers: the LOCAL build's relay, and another port (the steering target)
const http = await import('node:http')
function wsServer() {
  const hits = []
  const srv = http.createServer((q, s) => { hits.push({ http: q.url }); s.writeHead(404, { 'access-control-allow-origin': '*' }); s.end() })
  srv.on('upgrade', (q, sock) => {
    hits.push({ ws: q.url })
    const acc = createHash('sha1').update(q.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`)
    sock.write(Buffer.from([0x81, 2, 0x68, 0x69])) // "hi"
    sock.on('error', () => {})
  })
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, hits, port: srv.address().port })))
}
const relaySrv = await wsServer(), otherSrv = await wsServer()
const LOCAL_WS = `ws://127.0.0.1:${relaySrv.port}`, LOCAL_HTTP = `http://127.0.0.1:${relaySrv.port}`
const LIVE = await build('live', ['--live'], { mutate: true })
const LOCAL = await build('local', ['--live', '--sync-origin', LOCAL_WS], { mutate: true, fill: { __WS__: LOCAL_WS, __HTTP__: LOCAL_HTTP } })
const PLAIN = await build('plain', [])
// the two builds must differ ONLY in the frame's connect-src: rebuild PLAIN on LIVE's ports for a byte comparison
const twin = path.join(work, 'twin')
execFileSync(process.execPath, [BUILD, '--out', twin, '--library-origin', LIVE.library, '--frame-origin', LIVE.frame, '--release-base', LIVE.releaseBase,
  '--dev', '--key', path.join(work, 'test-key.json'), '--history', path.join(work, 'history-test.json')], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, BENTO_HOME_WEB_MUTANT: '' } })
{
  const directive = (policy, name) => policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' '))
  const fp = fs.readFileSync(path.join(LIVE.out, 'frame/_headers'), 'utf8')
  const served = [...fp.matchAll(/Content-Security-Policy: (.*)/g)].map((m) => m[1])
  ok(served.length === 2 && served.every((p) => directive(p, 'connect-src') === `connect-src ${LIVE.releaseBase} ${RELAY} ${RELAY_HTTP}`),
    `[L3] the frame's served connect-src is exactly the release channel + ${RELAY} + ${RELAY_HTTP} (${served.map((p) => directive(p, 'connect-src')).join(' | ')})`)
  ok(directive(PLAIN.info.framePolicy, 'connect-src') === `connect-src ${PLAIN.releaseBase}`, '[L3] the plain build\'s frame connect-src is the release channel alone')
  const same = (f) => fs.readFileSync(path.join(LIVE.out, f), 'utf8') === fs.readFileSync(path.join(twin, f), 'utf8')
  ok(same('library/_headers') && same('library/index.html'), '[L3] the library\'s headers are byte-identical and its page too, live or not')
  ok(same('frame/frame.html'), '[L3] the frame page\'s bytes are identical live or not (only its header differs)')
  const tf = fs.readFileSync(path.join(twin, 'frame/_headers'), 'utf8')
  ok(fp.replaceAll(` ${RELAY} ${RELAY_HTTP}`, '') === tf, '[L3] the frame header differs from the plain build\'s in connect-src alone')
  ok(LIVE.info.live === true && LIVE.info.syncOrigin === RELAY && PLAIN.info.live === false && PLAIN.info.syncOrigin === null, '[L3] build.json records live and the relay')
  for (const d of ['sandbox allow-scripts allow-popups allow-modals', "worker-src 'none'", `frame-ancestors ${LIVE.library}`, "default-src 'none'"])
    ok(served.every((p) => p.includes(d)), `[L3] the frame policy still carries ${d}`)
  const refused = (args, env = {}) => {
    const r = spawnSync(process.execPath, [BUILD, '--out', path.join(work, 'x'), '--frame-origin', 'http://localhost:1', '--library-origin', 'http://127.0.0.1:2', ...args],
      { encoding: 'utf8', env: { ...process.env, BENTO_HOME_WEB_MUTANT: '', ...env } })
    return r.status !== 0 ? (r.stderr.trim().split('\n').pop() ?? '') : ''
  }
  const dev = ['--dev']
  for (const [args, what, why] of [
    [['--live', '--history', path.join(REAL, 'history.json'), '--check'], '--live in a production build', /--live lets documents join .*refused in a production build/],
    [[...dev, '--sync-origin', 'wss://relay.example', '--check'], '--sync-origin without --live', /needs --live/],
    [[...dev, '--live', '--sync-origin', 'https://relay.example', '--check'], 'an https:// sync origin', /must be wss/],
    [[...dev, '--live', '--sync-origin', 'wss://relay.example/d', '--check'], 'a sync origin with a path', /must be an origin/],
    [[...dev, '--live', '--sync-origin', 'wss:', '--check'], 'a scheme-only sync origin', /not a URL|must be an origin/],
    // the host lands in a CSP source verbatim: a wildcard, or a ';' / ',' that starts a new directive or policy
    [[...dev, '--live', '--sync-origin', 'wss://*.example.com', '--check'], 'a wildcard sync host', /host must be a plain DNS name/],
    [[...dev, '--live', '--sync-origin', 'wss://x.example;script-src', '--check'], 'a sync host carrying ";" (a new CSP directive)', /host must be a plain DNS name/],
    [[...dev, '--live', '--sync-origin', 'wss://x,y', '--check'], 'a sync host carrying "," (a second CSP policy)', /host must be a plain DNS name/],
    [[...dev, '--live', '--sync-origin', 'wss://user@x.example', '--check'], 'a sync origin with userinfo', /must not carry userinfo/],
  ]) { const e = refused(args); ok(why.test(e), `[L3] the build refuses ${what} (${e.slice(0, 90)})`) }
  const passes = (u) => spawnSync(process.execPath, [BUILD, '--out', path.join(work, 'y'), '--frame-origin', 'http://localhost:1', '--library-origin', 'http://127.0.0.1:2', '--dev', '--live', '--sync-origin', u, '--check'], { encoding: 'utf8', env: { ...process.env, BENTO_HOME_WEB_MUTANT: '' } }).status
  for (const u of ['ws://127.0.0.1:8787', 'ws://[::1]:8787', 'wss://relay-2.example.com'])
    ok(passes(u) === 0, `[L3] control: --live with ${u} passes the checks`)
}

// ---- browser ----------------------------------------------------------------------------
const launch = CHROME ? { channel: 'chrome' } : {}
const browser = await pw[ENGINE].launch({ ...launch, logger: apiLogger })
guard = guardBrowser(browser, { rig: `home/web live (${ENGINE}${CHROME ? ' chrome' : ''})`, stallMs: 120000 })
console.log(`  ${ENGINE} ${browser.version()}`)
const relay = relayWorld({ origin: RELAY })
const consoleLines = []
async function context(tag, { routeSockets = true } = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true })
  if (routeSockets) await relay.attach(ctx, tag)
  // the relay's https origin (blobs) and anything else off the local servers: refused and counted
  const offsite = []
  await ctx.route((u) => !/^(http:\/\/(127\.0\.0\.1|localhost):\d+\/|file:|data:|blob:|about:)/.test(u.href), (r) => { offsite.push(r.request().url()); return r.fulfill({ status: 404, body: '' }) })
  ctx.on('console', (m) => consoleLines.push(`${tag}: ${m.text()}`))
  return Object.assign(ctx, { offsite })
}
const docFrame = (page) => page.frames().find((f) => f.parentFrame() === page.mainFrame())
const booted = (page) => until(async () => { const f = docFrame(page); return f && (await f.evaluate(() => !!(window.bento && window.bento.doc))) ? f : null })
const ui = (page) => page.evaluate(() => {
  const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.offsetParent !== null }
  return {
    viewing: document.body.classList.contains('viewing'), frames: document.querySelectorAll('iframe').length,
    label: document.getElementById('doc-label').textContent,
    notice: vis('notice') ? document.getElementById('notice').textContent : '',
    problem: vis('problem-box') ? document.getElementById('problem').textContent : '',
  }
})
async function open(page, file) {
  await page.setInputFiles('#file', file)
  return until(async () => { const u = await ui(page); return u.viewing || u.problem ? u : null }, 20000)
}
/** Open a socket from inside a frame; resolve with what happened to it. */
const plantSocket = (fr, url) => fr.evaluate((u) => new Promise((res) => {
  const got = []
  let ws
  try { ws = new WebSocket(u) } catch (e) { return res({ threw: String(e && e.name), got, violated: true }) }
  window.__planted = ws
  ws.onmessage = (e) => { got.push(String(e.data)); res({ open: true, got }) }
  ws.onerror = () => res({ error: true, got })
  setTimeout(() => res({ timeout: true, state: ws.readyState, got }), 5000)
}), url)
const plantFetch = (fr, url) => fr.evaluate((u) => fetch(u).then((r) => `status ${r.status}`, (e) => `refused ${e && e.name}`), url)
/** Violations the frame's policy reported for a URL prefix (listener installed by watchViolations). */
const watchViolations = (fr) => fr.evaluate(() => { window.__violations = []; document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.blockedURI + ' ' + e.effectiveDirective)) })
const violations = (fr) => fr.evaluate(() => window.__violations.slice())
const routedTo = (pred, from = 0) => relay.log.sockets.slice(from).filter((s) => pred(s.url))
const ONLY = process.env.BENTO_LIVE_ONLY_ROW || ''
const want = (row) => !ONLY || ONLY.startsWith(row)

// ===== [L1] [L4] the frame's policy, measured with REAL sockets ================================
section('[L1] [L4] a socket from the frame: the relay only, and only in a live build (no routing: real sockets)')
{
  const ctx = await context('local-frame', { routeSockets: false })
  const page = await ctx.newPage()
  await page.goto(LOCAL.library + '/')
  await open(page, F('plain'))
  const fr = await booted(page)
  ok(!!fr, 'the 1.2.10 deck boots in the LOCAL live build\'s frame')
  if (fr) await watchViolations(fr)
  const h0 = relaySrv.hits.length, o0 = otherSrv.hits.length
  const r = fr ? await plantSocket(fr, `${LOCAL_WS}/d/wLOCAL?tok=x`) : {}
  ok(r.open && r.got[0] === 'hi' && relaySrv.hits.slice(h0).some((h) => h.ws === '/d/wLOCAL?tok=x'),
    `[L1] a socket from the frame reaches the relay: the server saw its handshake and its frame came back (${JSON.stringify(r).slice(0, 60)})`)
  const blob = fr ? await plantFetch(fr, `${LOCAL_HTTP}/b/wLOCAL/AAAAAAAAAAAAAAAAAAAAAA`) : ''
  ok(blob === 'status 404' && relaySrv.hits.some((h) => h.http === '/b/wLOCAL/AAAAAAAAAAAAAAAAAAAAAA'), `[L1] a blob fetch to the relay's http(s) origin leaves the frame (${blob})`)
  const evil = fr ? await plantSocket(fr, `ws://127.0.0.1:${otherSrv.port}/d/wLOCAL`) : {}
  await sleep(300)
  const v = fr ? await violations(fr) : []
  ok(!evil.open && otherSrv.hits.length === o0 && v.some((x) => x.includes(String(otherSrv.port)) && /connect-src/.test(x)),
    `[L4] a socket from the frame to another port is refused: a connect-src violation, 0 handshakes there (${JSON.stringify(evil).slice(0, 50)}; ${v.join(', ').slice(0, 80)})`)
  const evilFetch = fr ? await plantFetch(fr, `http://localhost:${otherSrv.port}/b/x/AAAAAAAAAAAAAAAAAAAAAA`) : ''
  ok(/^refused/.test(evilFetch) && otherSrv.hits.length === o0, `[L4] a fetch from the frame to another origin is refused (${evilFetch}; reached ${otherSrv.hits.length - o0})`)
  const evilWss = fr ? await plantSocket(fr, 'wss://relay.attacker.example/d/wLOCAL') : {}
  ok(!evilWss.open, '[L4] a wss:// socket to another host is refused too')
  await ctx.close()
}
{
  const ctx = await context('plain-frame', { routeSockets: false })
  const page = await ctx.newPage()
  await page.goto(PLAIN.library + '/')
  await open(page, F('plain'))
  const fr = await booted(page)
  if (fr) await watchViolations(fr)
  const h0 = relaySrv.hits.length
  const r = fr ? await plantSocket(fr, `${LOCAL_WS}/d/wPLAIN?tok=x`) : {}
  await sleep(300)
  const v = fr ? await violations(fr) : []
  ok(!!fr && !r.open && relaySrv.hits.length === h0 && v.some((x) => /connect-src/.test(x)),
    `[L1] the plain build refuses the same socket: a violation, 0 handshakes (${JSON.stringify(r).slice(0, 50)}; ${v.join(', ').slice(0, 70)})`)
  await ctx.close()
}
// [L1r] the routing control: a routed socket from the sandboxed frame meets the real Room
{
  const ctx = await context('route-control')
  const page = await ctx.newPage()
  await page.goto(LIVE.library + '/')
  await open(page, F('plain'))
  const fr = await booted(page)
  const room = 'wROUTE' + 'A'.repeat(20)
  const mark = relay.log.sockets.length
  const r = fr ? await plantSocket(fr, `${RELAY}/d/${room}?tok=tok0123456789abcd`) : {}
  const reached = routedTo((u) => u.startsWith(`${RELAY}/d/${room}`), mark)
  const seen = r.open && reached.length === 1 && /"ctl":"ready"/.test(r.got[0] ?? '')
  ok(seen, `[L1r] routeWebSocket SEES a socket from the sandboxed frame and the real Room answers (${(r.got[0] ?? JSON.stringify(r)).slice(0, 50)})`)
  if (!seen) { console.log('  FAIL  without it every routed 0-socket row below is vacuous'); failures++ }
  await ctx.close()
}

// ===== [Lk] a released shell with a live session ==============================================
section('[Lk] slides 1.2.10 with a live session: the file:// control joins, the frame does not')
let liveFile = null, liveRoom = null
{
  // the owner shares from a file:// copy: the real shell mints the session and joins the real Room
  const ctx = await context('owner')
  const owner = await ctx.newPage()
  await owner.goto('file://' + F('plain'))
  await until(() => owner.evaluate(() => !!(window.bento && window.bento.doc)))
  await owner.evaluate(() => window.bento.sync.share())
  const joined = await until(async () => routedTo((u) => u.startsWith(RELAY + '/d/w')).find((s) => s.tag === 'owner' && s.open))
  ok(!!joined, `control: the file:// copy of 1.2.10 joins its room on the routed relay (${joined?.url.slice(0, 50)}…)`)
  liveRoom = joined?.name
  fs.writeFileSync((liveFile = F('live')), await owner.evaluate(() => window.bento.serialize()))
  const d = extractDoc(fs.readFileSync(liveFile, 'utf8'))
  const collab = 'text' in d ? JSON.parse(d.text).collab : null
  ok(collab?.on === true && collab.room.startsWith(RELAY + '/d/'), 'the saved file carries its live session, on, on the shipped relay')
  const ins = (await until(async () => { const x = relay.log.frames.filter((f) => f.dir === 'in' && f.name === liveRoom); return x.length ? x : null }, 10000)) ?? []
  ok(ins.length > 0 && ins.every((f) => !f.text.includes(CANARY)) && ins.some((f) => /"(d|iv|ct)":/.test(f.text)),
    `positive control: the relay recorded ${ins.length} frames from the owner, ciphertext only (no canary)`)

  const lctx = await context('library')
  const page = await lctx.newPage()
  await page.goto(LIVE.library + '/')
  const mark = relay.log.sockets.length
  const u = await open(page, liveFile)
  const fr = await booted(page)
  await sleep(4000)
  const state = fr ? await fr.evaluate(() => ({ sandboxed: window.bento.sandboxed, collab: !!window.bento.doc.collab, transports: window.bento.sync.transports() })) : null
  ok(!!fr && state?.collab && routedTo(() => true, mark).length === 0,
    `[Lk] the live document opens in the live build and opens NO socket (sandboxed ${state?.sandboxed}, transports ${state?.transports}): released shells stay off the network in the frame`)
  if (state?.sandboxed !== true) note(`the shell does not report sandboxed (${state?.sandboxed}): if a socket opened above, the kernel rule has changed and this row must be rewritten`)
  ok(/it is not live here/.test(u?.notice ?? ''), `[Lk] the library says it is not live here (${u?.notice})`)
  ok(await owner.evaluate(() => window.bento.sync.peers().length) === 0, '[Lk] the owner sees no peer from the library')

  // [L7] teardown: a socket the frame holds closes with the document
  if (fr && want('[L7]')) {
    const m2 = relay.log.sockets.length
    const r = await plantSocket(fr, `${RELAY}/d/wTEARDOWN${'C'.repeat(20)}?tok=tok0123456789abcd`)
    const s = relay.log.sockets[m2]
    ok(r.open && !!s?.open, `[L7] control: a socket planted in the frame is open on the relay (${!!s?.open})`)
    const t0 = Date.now()
    await page.click('#close')
    const closed = await until(async () => (s && !s.open) || null, 5000)
    ok(!!closed, `[L7] closing the document closes the socket its frame held (${closed ? Date.now() - t0 + ' ms' : 'still open'}, closed by ${s?.closedBy})`)
    ok((await ui(page)).frames === 0, '[L7] and the frame is gone')
  }
  ok(lctx.offsite.length === 0, `[L9] the library context reached nothing off its own servers (${lctx.offsite.join(' ')})`)
  await lctx.close()
  await ctx.close()
}

// ===== [L5] read-only in the newest release ===============================================
section('[L5] read-only in the newest release carries no session')
if (liveFile && want('[L5]')) {
  LIVE.s.files.set('/releases/slides/history.json', await sign(historyPlus))
  LIVE.s.files.set('/releases/slides/manifest.json', manifestFuture)
  LIVE.s.files.set('/releases/slides/Bento_Slides.bento.html', futureShell)
  fs.writeFileSync(F('liveFork'), withLoaderNote(fs.readFileSync(liveFile, 'utf8'), 'a fork'))
  const ctx = await context('readonly')
  const page = await ctx.newPage()
  await page.goto(LIVE.library + '/')
  await open(page, F('liveFork'))
  await page.click('#readonly')
  const fr = await booted(page)
  const u = await ui(page)
  const inside = fr ? await fr.evaluate(() => ({ room: window.bento.doc.collab?.room ?? null, on: window.bento.doc.collab?.on, title: window.bento.doc.title })) : null
  ok(/^Read-only in bento\/slides 1\.2\.99$/.test(u.label) && inside?.title === CANARY, `control: the fork opens read-only in the newest release with its own content (${u.label})`)
  ok(!!inside && inside.room !== liveRoom && !(inside.room ?? '').includes(liveRoom ?? '\0'),
    `[L5] read-only: the document is given no live session (room in the frame: ${inside?.room?.slice(0, 50) ?? 'none'})`)
  ok(/it is not live here/.test(u.notice), '[L5] the notice still names it a live document shown as last saved')

  // An ENCRYPTED fork: withoutSession cannot see inside a bento/enc envelope, and
  // needs not, because the library never offers such a fork read-only (its
  // format is bento/enc, no app's). A real envelope (kernel save.ts encryptBody:
  // PBKDF2-SHA-256 + AES-GCM) over the live document, collab and all.
  const plainFork = fs.readFileSync(F('liveFork'), 'utf8')
  const fd = extractDoc(plainFork)
  const subtle = webcrypto.subtle
  const salt = webcrypto.getRandomValues(new Uint8Array(16)), iv = webcrypto.getRandomValues(new Uint8Array(12))
  const pk = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 },
    await subtle.importKey('raw', new TextEncoder().encode('rig-password'), 'PBKDF2', false, ['deriveKey']),
    { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, pk, new TextEncoder().encode(fd.text)))
  const b64 = (u8) => Buffer.from(u8).toString('base64')
  const envelope = JSON.stringify({ format: 'bento/enc', v: 1, it: 1000, salt: b64(salt), iv: b64(iv), data: b64(ct) })
  ok('text' in fd && (JSON.parse(fd.text).collab?.room ?? '').startsWith(RELAY + '/d/') && plainFork.split(fd.text).length === 2,
    'control: the fork\'s plaintext document carries the live session the envelope will hide')
  fs.writeFileSync(F('encFork'), plainFork.replace(fd.text, () => envelope))
  const ed = extractDoc(fs.readFileSync(F('encFork'), 'utf8'))
  ok(ed.format === 'bento/enc', `control: the encrypted fork's document block is a bento/enc envelope (${ed.format})`)
  const page2 = await ctx.newPage()
  await page2.goto(LIVE.library + '/')
  const u2 = await open(page2, F('encFork'))
  const offered = await page2.evaluate(() => { const e = document.getElementById('readonly'); return !!e && !e.hidden && e.offsetParent !== null })
  ok(/will not run here/.test(u2?.problem ?? ''), `control: the encrypted fork is unverifiable, so its code never runs (${(u2?.problem ?? '').slice(0, 60)})`)
  ok(!offered && (await ui(page2)).frames === 0,
    '[L5] an encrypted fork carrying a live session is never offered read-only (so no envelope with a session reaches a frame)')
  await ctx.close()
}

// ===== [L8] two frames share no BroadcastChannel ===========================================
section('[L8] two documents in two frames share no BroadcastChannel')
if (want('[L8]')) {
  const ctx = await context('bc')
  const pages = [await ctx.newPage(), await ctx.newPage()]
  const frames = []
  for (const p of pages) { await p.goto(LIVE.library + '/'); await open(p, F('plain')); frames.push(await booted(p)) }
  const listen = (f) => f.evaluate(() => { window.__heard = []; const c = new BroadcastChannel('bento-live-probe'); c.onmessage = (e) => window.__heard.push(e.data); window.__bc = c })
  const say = (f) => f.evaluate(() => new BroadcastChannel('bento-live-probe').postMessage('hello'))
  if (frames.every(Boolean)) {
    await listen(frames[1]); await say(frames[0]); await sleep(800)
    ok((await frames[1].evaluate(() => window.__heard.length)) === 0, '[L8] a message on a BroadcastChannel in one frame never reaches the other')
  } else ok(false, '[L8] both frames booted')
  const files = [await ctx.newPage(), await ctx.newPage()]
  for (const p of files) { await p.goto('file://' + F('plain')); await until(() => p.evaluate(() => !!window.bento)) }
  await listen(files[1].mainFrame()); await say(files[0].mainFrame()); await sleep(800)
  const heard = await files[1].evaluate(() => window.__heard.length)
  ok(heard === 1 || ENGINE !== 'chromium', `[L8] control: two file:// pages DO share one (heard ${heard})`)
  if (heard !== 1) note(`file:// BroadcastChannel on ${ENGINE}: heard ${heard} (only chromium is held to the control)`)
  await ctx.close()
}

// ===== [L9] every other socket ============================================================
section('[L9] sockets not bound for the relay')
{
  const libraryOther = relay.log.other.filter((u) => !/attacker\.example|127\.0\.0\.1:9\//.test(u))
  ok(libraryOther.length === 0, `[L9] no socket went anywhere but the relay (${libraryOther.join(' ') || 'none'})`)
  // positive control: an unrouted socket planted in a page IS recorded as other
  const ctx = await context('other-control')
  const p = await ctx.newPage()
  await p.goto('file://' + F('plain'))
  const before = relay.log.other.length
  await p.evaluate(() => new Promise((r) => { const w = new WebSocket('wss://elsewhere.example/'); w.onerror = w.onclose = () => r(); setTimeout(r, 3000) }))
  ok(relay.log.other.length === before + 1, '[L9] positive control: a socket to another host is seen by the route and counted')
  await ctx.close()
}

await guard.close()
await Promise.all([LIVE.s.close(), LOCAL.s.close(), PLAIN.s.close()])
relaySrv.srv.close(); otherSrv.srv.close()
console.log(failures === 0 ? `\nALL PASS (${checks} checks, ${ENGINE}${CHROME ? ' chrome' : ''})` : `\n${failures} FAILURES of ${checks} checks`)
process.exit(failures ? 1 : 0)
