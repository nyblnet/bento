#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Stage-0 measurement probes (server/stage0-probes/): load every probe in
// Chromium and check that "Copy results" produces the one line the checklist
// asks for, with the shape a person pastes back. Also checks what each probe
// promises about itself:
//
//   P1 frame   the top page and the frame on two SITES (localhost vs
//              127.0.0.1), a real slides shell boots inside the opaque frame
//              (origin "null"; 'self' and blob: scripts run, inline and eval
//              refused), in all three modes, and offline from the top page's
//              worker; the canary deck plants both canaries in the frame (the
//              positive control: a script WITH a frame target reaches them),
//              window.bentoAgent never returns the ownerPriv canary; no request
//              leaves the two probe origins; the storage and WebMCP pages.
//   P2 install the manifest declares file_handlers + share_target, and the
//              worker answers the share_target POST itself.
//   P3 keep    keys are non-extractable, survive a reload with the same
//              fingerprint, the page never makes one on its own, and
//              "Delete my key" leaves a clean "no key".
//   P5 log     the Worker logs exactly ONE line, the control canary, and
//              never the URL, header or body canary.
//   P6 MCP     initialize / tools/list / tools/call over HTTP; sleep is a
//              write tool, big returns exactly n KiB between its markers.
//   static     the shared helper files are identical in every probe, the top
//              page's CSP carries frame.js's real hash, no probe config has a
//              route or custom domain, and the README lists every deploy.
//
// Needs a built slides shell (default slides/dist-single/Bento_Slides.bento.html;
// --shell <path> or STAGE0_SHELL to override). A missing shell FAILS: CI builds
// it before this step, and a probe that never booted a real shell proves little.

import http from 'node:http'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROBES = join(root, 'server/stage0-probes')
const argShell = process.argv.indexOf('--shell')
const SHELL = argShell > 0 ? process.argv[argShell + 1] : (process.env.STAGE0_SHELL || join(root, 'slides/dist-single/Bento_Slides.bento.html'))

let failed = 0
let passed = 0
const ok = (cond, what, detail = '') => {
  if (cond) { passed++; console.log('ok    ' + what) } else { failed++; console.log('FAIL  ' + what + (detail ? '\n      ' + String(detail).slice(0, 600) : '')) }
}

// --- static checks ---------------------------------------------------------------
{
  const common = ['p1-frame', 'p2-install', 'p3-keep'].map((p) => readFileSync(join(PROBES, p, 'public/probe-common.js'), 'utf8'))
  ok(common.every((c) => c === common[0]), 'probe-common.js is identical in P1, P2 and P3')
  const css = ['p1-frame', 'p2-install', 'p3-keep'].map((p) => readFileSync(join(PROBES, p, 'public/probe.css'), 'utf8'))
  ok(css.every((c) => c === css[0]), 'probe.css is identical in P1, P2 and P3')

  const frameJs = readFileSync(join(PROBES, 'p1-frame/public/frame.js'), 'utf8')
  ok(!/<\/script/i.test(frameJs), 'frame.js has no literal script end tag (it is inlined into a srcdoc)')
  const hash = createHash('sha256').update(frameJs).digest('base64')
  const headers = readFileSync(join(PROBES, 'p1-frame/public/_headers'), 'utf8')
  ok(headers.includes(`'sha256-${hash}'`), "the top page's CSP carries frame.js's current hash", 'expected sha256-' + hash)

  const tomls = []
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/^wrangler.*\.toml$/.test(n)) tomls.push(p) } }
  walk(PROBES)
  ok(tomls.length === 8, 'eight wrangler configs (P1 top + frame, P2, P3, P5 x3, P6)', tomls.length)
  for (const t of tomls) {
    const body = readFileSync(t, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    const rel = t.slice(PROBES.length + 1)
    ok(!/^\s*routes?\s*=/m.test(body) && !/custom_domain/.test(body) && !/bento\.page/.test(body), rel + ': no route, no custom domain, nothing on bento.page')
    const logsOn = /\[observability\][^[]*enabled\s*=\s*true/.test(body)
    ok(logsOn === (rel === 'p5-log/wrangler.toml'), rel + (logsOn ? ': logs on (the P5 "on" config only)' : ': logs not switched on'))
  }
  const readme = readFileSync(join(PROBES, 'README.md'), 'utf8')
  for (const cmd of ['npx wrangler@4.152.0 deploy', 'pages project create bento-probe-frame', 'pages deploy', '-c wrangler.default.toml', '-c wrangler.logs-off.toml']) {
    ok(readme.includes(cmd), 'README lists: ' + cmd)
  }
}

// --- local hosting: static folders (Cloudflare _headers + html_handling) and Workers ---
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' }

function parseHeaders(text) {
  const rules = []
  let cur = null
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    if (!/^\s/.test(raw)) { cur = { path: raw.trim(), headers: [] }; rules.push(cur); continue }
    const i = raw.indexOf(':')
    if (cur && i > 0) cur.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()])
  }
  return rules
}
const matches = (rule, path) => rule.endsWith('/*') ? path.startsWith(rule.slice(0, -1)) : rule === path

function staticServer(dir) {
  const rules = existsSync(join(dir, '_headers')) ? parseHeaders(readFileSync(join(dir, '_headers'), 'utf8')) : []
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const path = decodeURIComponent(url.pathname)
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
    if (path.endsWith('.html')) {
      const bare = path === '/index.html' ? '/' : path.slice(0, -5)
      res.writeHead(307, { location: bare + url.search }); res.end(); return
    }
    let file = path === '/' ? 'index.html' : path.slice(1)
    if (!extname(file) && existsSync(join(dir, file + '.html'))) file += '.html'
    const full = join(dir, file)
    if (file.includes('..') || file === '_headers' || !existsSync(full) || statSync(full).isDirectory()) { res.writeHead(404); res.end('not found'); return }
    const h = { 'content-type': TYPES[extname(full)] || 'application/octet-stream' }
    for (const r of rules) if (matches(r.path, path)) for (const [k, v] of r.headers) h[k] = v
    res.writeHead(200, h)
    res.end(req.method === 'HEAD' ? undefined : readFileSync(full))
  })
}

function workerServer(worker) {
  return http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const request = new Request('http://' + req.headers.host + req.url, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body })
    const r = await worker.fetch(request, {}, { waitUntil() {} })
    res.writeHead(r.status, Object.fromEntries(r.headers))
    res.end(Buffer.from(await r.arrayBuffer()))
  })
}

const listen = (server, host) => new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)))

// --- the browser ---------------------------------------------------------------------
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const servers = []

async function copyLine(page) {
  await page.click('#copy')
  await page.waitForFunction(() => document.getElementById('copy').dataset.copied === '1')
  return page.$eval('#result', (e) => e.value)
}
const field = (line, key) => { const m = new RegExp('(?:^| \\| )' + key + '=([^|]*?)(?: \\| |$)').exec(line); return m ? m[1] : null }

try {
  // ===================== P1 frame =====================
  ok(existsSync(SHELL), 'a built slides shell to boot in the frame', 'missing ' + SHELL + ' (npm run build:single --prefix slides)')
  if (existsSync(SHELL)) {
    const pub = join(PROBES, 'p1-frame/public')
    const topSrv = staticServer(pub); const frameSrv = staticServer(pub)
    servers.push(topSrv, frameSrv)
    const topPort = await listen(topSrv, '127.0.0.1')
    const framePort = await listen(frameSrv, '127.0.0.1')
    // two SITES: "localhost" and "127.0.0.1" are different hosts, so cross-site
    const TOP = 'http://localhost:' + topPort
    const FRAME = 'http://127.0.0.1:' + framePort
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const foreign = []
    ctx.on('request', (r) => {
      const u = r.url()
      if (!(u.startsWith(TOP) || u.startsWith(FRAME) || u.startsWith('blob:') || u.startsWith('data:') || u.startsWith('about:'))) foreign.push(u)
    })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message)))

    // A fresh shell carries an EMPTY document block (the starter deck is made
    // at boot), and the maintainer opens a saved deck. So: boot the shell once,
    // let it serialize itself, and use that saved deck.
    const makerCtx = await browser.newContext()
    const maker = await makerCtx.newPage()
    await maker.goto(pathToFileURL(SHELL).href)
    await maker.waitForFunction(() => window.bento && window.bento.doc && typeof window.bento.serialize === 'function', null, { timeout: 45000 })
    const deck = Buffer.from(await maker.evaluate(async () => String(await window.bento.serialize())))
    await makerCtx.close()
    ok(/id="bento-doc">\s*\{/.test(deck.toString('utf8')), 'P1: a saved slides deck made from the shell (its document block is filled)')
    const DECK = { name: 'probe-deck.bento.html', mimeType: 'text/html', buffer: deck }

    await page.goto(TOP + '/?frame=' + encodeURIComponent(FRAME + '/frame'))
    const openDeck = async (mode, canary = false) => {
      await page.selectOption('#mode', mode)
      await page.setChecked('#canary', canary)
      await page.evaluate(() => { document.getElementById('observed').textContent = '' })
      await page.setInputFiles('#file', DECK)
      await page.waitForFunction(() => /document boot: (ok|fail)/.test(document.getElementById('observed').textContent), null, { timeout: 45000 })
      return copyLine(page)
    }

    let line = await openDeck('cross-site')
    ok(line.startsWith('P1 v1 | page=main | ua='), 'P1 main: the line starts with its probe, version and page', line)
    ok(field(line, 'mode') === 'cross-site' && field(line, 'frame') === FRAME, 'P1 cross-site: the frame is the other site', line)
    ok(field(line, 'origin') === 'null', 'P1 cross-site: the frame runs at an opaque origin', field(line, 'origin'))
    ok(field(line, 'served-by') === 'network', 'P1 cross-site: served by the frame site', field(line, 'served-by'))
    ok(field(line, 'csp') === 'self:ok blob:ok inline:blocked eval:blocked reported:2', "P1 cross-site: 'self' and blob: run, inline and eval refused", field(line, 'csp'))
    ok(/^throws/.test(field(line, 'storage') || ''), 'P1 cross-site: storage throws in the frame', field(line, 'storage'))
    ok(/^ok \d+ms$/.test(field(line, 'boot') || ''), 'P1 cross-site: the real slides shell boots in the frame', field(line, 'boot'))
    // The probe's own two refusals (inline, eval) are counted before the
    // document exists; what the violations field holds is the document's own.
    // (Today's loader tries an inline script and new Function before blob:,
    // so a booting shell reports both, with their line numbers.)
    ok(/^\d+( |$)/.test(field(line, 'violations') || '') && field(line, 'errors') === '0', 'P1 cross-site: the document\'s own CSP refusals are reported apart from the probe\'s checks', field(line, 'violations'))
    ok(/^1:-,2:-,3:-,4:-,5:-,6:-,7:-,8:-$/.test(field(line, 'steps') || ''), 'P1: the eight steps are in the line', field(line, 'steps'))

    // manual marks and the notes field reach the line, with separators made safe
    await page.selectOption('[data-step="1"]', 'worked')
    await page.selectOption('[data-step="5"]', 'blocked')
    await page.fill('[data-err="5"]', 'print dialog | never opened')
    await page.fill('#notes', 'run | one')
    line = await copyLine(page)
    ok(/(^| \| )steps=1:-,2:worked,3:-,4:-,5:-,6:blocked\(print dialog never opened\),7:-,8:-( \| |$)/.test(line), 'P1: a marked step and its error text reach the line', field(line, 'steps'))
    ok(field(line, 'notes') === 'run / one' && line.split(' | ').length === 28, 'P1: a "|" typed by the person never adds a field', line.split(' | ').length)

    // canary deck (C1): the positive control reaches inside the frame
    line = await openDeck('cross-site', true)
    const run = (/^run-([a-z0-9]{6})$/.exec(field(line, 'canary') || '') || [])[1]
    ok(!!run, 'P1 canary: the line carries the run id', field(line, 'canary'))
    const docFrame = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(FRAME + '/frame'))
    const inFrame = docFrame ? await docFrame.evaluate(() => ({ owner: window.bento.doc.collab && window.bento.doc.collab.ownerPriv, on: window.bento.doc.collab && window.bento.doc.collab.on, text: JSON.stringify(window.bento.doc.slides[0]) })) : null
    ok(inFrame && inFrame.owner === 'CANARY-OWNERPRIV-' + run && inFrame.on === false, 'P1 canary: ownerPriv planted, sharing off (positive control with a frame target)', JSON.stringify(inFrame && { owner: inFrame.owner, on: inFrame.on }))
    ok(inFrame && inFrame.text.includes('CANARY-SLIDE-' + run), 'P1 canary: CANARY-SLIDE is on slide one')
    const agent = await page.evaluate(() => JSON.stringify([window.bentoAgent.describe(), window.bentoAgent.listSlides()]))
    ok(agent.includes('CANARY-SLIDE-' + run) && !agent.includes('CANARY-OWNERPRIV'), 'P1 canary: window.bentoAgent lists slide text and never the ownerPriv canary')
    ok(await page.evaluate(() => { try { window.bentoAgent = 1 } catch { /* strict */ } return typeof window.bentoAgent.listSlides === 'function' }), 'P1: window.bentoAgent cannot be replaced')
    const topSeesFrame = await page.evaluate(() => { try { return typeof document.querySelector('iframe.doc').contentWindow.bento } catch (e) { return 'throws ' + e.name } })
    ok(/^throws/.test(topSeesFrame), 'P1: the top page cannot reach the frame\'s window.bento', topSeesFrame)

    // worker-served srcdoc frame
    line = await openDeck('srcdoc')
    ok(field(line, 'served-by') === 'srcdoc' && field(line, 'frame') === 'srcdoc', 'P1 srcdoc: built from the top page\'s own copy', line)
    ok(field(line, 'origin') === 'null' && field(line, 'csp') === 'self:n/a(srcdoc hash) blob:ok inline:blocked eval:blocked reported:4', 'P1 srcdoc: opaque, hash-pinned script, blob: runs, inline refused (each refusal reported by both policies: inherited + own)', field(line, 'csp'))
    ok(/^ok \d+ms$/.test(field(line, 'boot') || ''), 'P1 srcdoc: the shell boots', field(line, 'boot'))

    // frame-site worker mode: the hidden installer answers, the shell boots online
    line = await openDeck('frame-sw')
    ok(/^ok \d+ms$/.test(field(line, 'boot') || ''), 'P1 frame-sw: the shell boots', field(line, 'boot'))
    await page.waitForFunction(() => !/frame-site worker: asked/.test(document.getElementById('sw-status').textContent), null, { timeout: 15000 })
    line = await copyLine(page)
    ok(/^third-party /.test(field(line, 'frame-sw') || ''), 'P1 frame-sw: the frame site\'s worker registered from the hidden frame', field(line, 'frame-sw'))

    // offline (A4): the top page's worker serves the page and the srcdoc frame
    await page.waitForFunction(async () => { const r = await navigator.serviceWorker.ready; return !!r.active }, null, { timeout: 15000 })
    await page.reload()
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 })
    await ctx.setOffline(true)
    await page.reload()
    line = await openDeck('srcdoc')
    ok(field(line, 'online') === 'false' && field(line, 'topsw') === 'controlled', 'P1 offline: the page came from its worker', line)
    ok(/^ok \d+ms$/.test(field(line, 'boot') || ''), 'P1 offline: the worker-served frame boots the shell', field(line, 'boot'))
    await ctx.setOffline(false)

    // storage page (A3)
    await page.goto(TOP + '/storage?frame=' + encodeURIComponent(FRAME + '/frame'))
    await page.click('#run')
    await page.waitForFunction(() => /4\. storage access/.test(document.getElementById('observed').textContent), null, { timeout: 15000 })
    line = await copyLine(page)
    ok(line.startsWith('P1 v1 | page=storage | ua=') && field(line, 'frame') === FRAME, 'P1 storage: the line names its page and frame site', line)
    for (const k of ['ls', 'idb', 'cookie', 'sa']) ok(!!field(line, k) && field(line, k) !== 'not run', 'P1 storage: ' + k + ' answered', field(line, k))
    ok(/previous none$/.test(field(line, 'idb')), 'P1 storage: the first run finds nothing earlier', field(line, 'idb'))
    await page.click('#run')
    await page.waitForTimeout(500)
    line = await copyLine(page)
    ok(/previous \d{4}-/.test(field(line, 'idb')), 'P1 storage: a second run finds the first run\'s value', field(line, 'idb'))

    // WebMCP page (C2)
    await page.goto(TOP + '/webmcp?frame=' + encodeURIComponent(FRAME + '/frame'))
    await page.waitForFunction(() => !/waiting/.test(document.getElementById('observed').textContent), null, { timeout: 15000 })
    await page.fill('#notes', 'probe_top_tool')
    line = await copyLine(page)
    ok(line.startsWith('P1 v1 | page=webmcp | ua=') && field(line, 'frame-origin') === 'null' && !!field(line, 'top-api') && field(line, 'agent-listed') === 'probe_top_tool', 'P1 WebMCP: both registrations reported, the agent\'s list recorded', line)

    ok(foreign.length === 0, 'P1: no request leaves the two probe origins', foreign.slice(0, 5).join(' '))
    ok(errors.length === 0, 'P1: no uncaught error in the probe pages', errors.slice(0, 3).join(' / '))
    await ctx.close()
  }

  // ===================== P2 install =====================
  {
    const srv = staticServer(join(PROBES, 'p2-install/public')); servers.push(srv)
    const BASE = 'http://localhost:' + await listen(srv, '127.0.0.1')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message)))
    await page.goto(BASE + '/')
    const man = await page.evaluate(async () => (await fetch('/manifest.webmanifest')).json())
    ok(man.file_handlers && man.file_handlers[0].accept['text/html'].includes('.html'), 'P2: the manifest handles .html files')
    ok(man.share_target && man.share_target.method === 'POST' && man.share_target.params.files[0].name === 'file', 'P2: the manifest declares a file share target')
    ok(man.icons.some((i) => i.sizes === '512x512') && man.display === 'standalone', 'P2: installable shape (512 icon, standalone)')
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 })
    // the share target, answered by the worker (offline, as E3 asks)
    await ctx.setOffline(true)
    const status = await page.evaluate(async () => {
      const fd = new FormData()
      fd.append('file', new File(['<!doctype html><title>shared</title>'], 'shared.bento.html', { type: 'text/html' }))
      // manual: a redirect the worker made is visible as such; offline, an
      // unanswered POST would reject instead
      const r = await fetch('/share-target', { method: 'POST', body: fd, redirect: 'manual' })
      return r.type
    })
    ok(status === 'opaqueredirect', 'P2: the worker answers the share POST offline and redirects to the app', status)
    await page.goto(BASE + '/?shared=1')
    await page.waitForFunction(() => /received/.test(document.getElementById('observed').textContent), null, { timeout: 10000 })
    const line = await copyLine(page)
    ok(line.startsWith('P2 v1 | ua=') && field(line, 'display') === 'tab' && field(line, 'opened') === 'share', 'P2: the line shape (tab, opened by share)', line)
    ok(/^received 36 bytes \(worker: offline, page offline\)$/.test(field(line, 'share') || ''), 'P2: the shared file arrived while offline', field(line, 'share'))
    ok(['fsa', 'launchQueue', 'sw', 'write', 'stored-handle', 'reload-perm', 'request-perm', 'launch', 'prompt', 'open-with', 'disk-changed'].every((k) => field(line, k) !== null), 'P2: every field the sittings record is in the line')
    await ctx.setOffline(false)
    ok(errors.length === 0, 'P2: no uncaught error', errors.join(' / '))
    await ctx.close()
  }

  // ===================== P3 keep =====================
  {
    const srv = staticServer(join(PROBES, 'p3-keep/public')); servers.push(srv)
    const BASE = 'http://localhost:' + await listen(srv, '127.0.0.1')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    page.on('dialog', (d) => d.accept())
    await page.goto(BASE + '/')
    await page.waitForFunction(() => /No key|Key/.test(document.getElementById('state').textContent))
    let line = await copyLine(page)
    ok(line.startsWith('P3 v1 | ua=') && field(line, 'key') === 'none' && field(line, 'fp') === '-', 'P3: a fresh browser says "no key" and makes none on its own', line)
    await page.click('#make')
    await page.waitForFunction(() => /Key present/.test(document.getElementById('state').textContent))
    line = await copyLine(page)
    const fp = field(line, 'fp')
    ok(field(line, 'key') === 'same' && /^[0-9a-f]{16}$/.test(fp || '') && /^[0-9a-f]{8}$/.test(field(line, 'kxfp') || ''), 'P3: Make keys gives a fingerprint', line)
    ok(field(line, 'extractable') === 'false' && field(line, 'sign') === 'ok' && field(line, 'kx') === 'ok', 'P3: both keys non-extractable and usable')
    await page.click('#persist')
    await page.waitForFunction(() => !/persist\(\) answer not asked/.test(document.getElementById('observed').textContent))
    await page.reload()
    await page.waitForFunction(() => /Key present|No key|Key:/.test(document.getElementById('state').textContent))
    line = await copyLine(page)
    ok(field(line, 'fp') === fp && field(line, 'key') === 'same', 'P3: after a reload, the same fingerprint', line)
    ok(field(line, 'visits') === '2' && /^\d{4}-/.test(field(line, 'previous-visit') || ''), 'P3: the visit log counts each load', field(line, 'visits'))
    ok(['persisted', 'persist-answer', 'created', 'age-days', 'display'].every((k) => field(line, k) !== null), 'P3: every field the sittings record is in the line')
    await page.click('#delete')
    await page.waitForFunction(() => /No key/.test(document.getElementById('state').textContent))
    await page.reload()
    await page.waitForFunction(() => /No key|Key/.test(document.getElementById('state').textContent))
    line = await copyLine(page)
    ok(field(line, 'key') === 'none', 'P3: Delete my key, reload: a clean "no key" (the positive control)', line)
    await ctx.close()
  }

  // ===================== P5 log canary =====================
  {
    const mod = await import(pathToFileURL(join(PROBES, 'p5-log/src/index.js')).href)
    const logs = []
    const orig = console.log
    const worker = { fetch: async (req, env, c) => { console.log = (...a) => logs.push(a.join(' ')); try { return await mod.default.fetch(req, env, c) } finally { console.log = orig } } }
    const srv = workerServer(worker); servers.push(srv)
    const BASE = 'http://localhost:' + await listen(srv, '127.0.0.1')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(BASE + '/')
    const curl = await page.$eval('#curl', (e) => e.textContent)
    const run = (/CANARY-BODY-([a-z0-9]+)/.exec(curl) || [])[1]
    ok(!!run && curl.includes('/canary?canary=CANARY-URL-' + run) && curl.includes('X-Canary: CANARY-HDR-' + run), 'P5: the curl line carries all three canaries', curl)
    ok(logs.length === 0, 'P5: loading the page logs nothing', logs.join(' / '))
    await page.click('#send')
    await page.waitForFunction(() => /page /.test(document.getElementById('sent').textContent))
    ok((await page.$eval('#sent', (e) => e.textContent)) === 'page 200 run matched', 'P5: Send reaches the Worker with this page\'s run')
    ok(logs.length === 1 && logs[0] === 'probe-logline CANARY-LOGLINE-' + run, 'P5: the Worker logs exactly the control line', logs.join(' / '))
    ok(!logs.join('\n').match(/CANARY-(URL|HDR|BODY)/), 'P5: the Worker never logs the URL, header or body canary')
    await page.selectOption('#config', { index: 2 })
    await page.selectOption('#u', 'no'); await page.selectOption('#l', 'yes')
    await page.fill('#ret', '3 days')
    const line = await copyLine(page)
    ok(line.startsWith('P5 v1 | run=' + run + ' | config=logs off') && field(line, 'url') === 'no' && field(line, 'logline') === 'yes' && field(line, 'retention') === '3 days' && field(line, 'sent') === 'page 200 run matched', 'P5: the line shape', line)
    await ctx.close()
  }

  // ===================== P6 slow MCP =====================
  {
    const mod = await import(pathToFileURL(join(PROBES, 'p6-mcp/src/index.js')).href)
    const srv = workerServer(mod.default); servers.push(srv)
    const BASE = 'http://localhost:' + await listen(srv, '127.0.0.1')
    const rpc = async (msg) => {
      const r = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(msg) })
      return { status: r.status, type: r.headers.get('content-type'), body: r.status === 202 ? null : await r.json() }
    }
    let r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rig', version: '1' } } })
    ok(r.status === 200 && r.body.result.protocolVersion === '2025-06-18' && r.body.result.capabilities.tools, 'P6: initialize answers with the client\'s revision and a tools capability', JSON.stringify(r.body))
    r = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
    ok(r.status === 202, 'P6: a notification gets 202 and no body')
    r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = Object.fromEntries(r.body.result.tools.map((t) => [t.name, t]))
    ok(Object.keys(tools).sort().join() === 'big,sleep', 'P6: exactly two tools, sleep and big')
    ok(tools.sleep.annotations.readOnlyHint === false && tools.big.annotations.readOnlyHint === true, 'P6: sleep is a write tool, big is read-only')
    const t0 = Date.now()
    r = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sleep', arguments: { seconds: 0.4 } } })
    const took = Date.now() - t0
    ok(/^slept 0\.4 s/.test(r.body.result.content[0].text) && took >= 380, 'P6: sleep waits and says so', took + 'ms')
    for (const kb of [1, 3, 100]) {
      r = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'big', arguments: { kilobytes: kb } } })
      const t = r.body.result.content[0].text
      ok(t.length === kb * 1024 && t.startsWith('BEGIN-' + kb + 'KB\n') && t.endsWith('END-' + kb + 'KB total ' + kb * 1024 + ' bytes\n'), 'P6: big ' + kb + ' is exactly ' + kb + ' KiB between its markers', t.length)
    }
    r = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'big', arguments: { kilobytes: 0 } } })
    ok(r.body.result.isError === true, 'P6: an out-of-range size is a tool error, not a crash')
    r = await rpc({ jsonrpc: '2.0', id: 6, method: 'nope' })
    ok(r.body.error && r.body.error.code === -32601, 'P6: an unknown method is -32601')
    const g = await fetch(BASE + '/mcp')
    ok(g.status === 405, 'P6: GET /mcp is 405 (no event stream)')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(BASE + '/')
    ok((await page.$eval('#url', (e) => e.textContent)) === BASE + '/mcp', 'P6: the page shows the connector URL')
    await page.fill('#product', 'claude.ai | test'); await page.fill('#sok', '120'); await page.selectOption('#add', 'yes')
    const line = await copyLine(page)
    ok(line.startsWith('P6 v1 | product=claude.ai / test | sleep-ok=120') && field(line, 'can-add') === 'yes' && line.split(' | ').length === 9, 'P6: the line shape', line)
    await ctx.close()
  }
} catch (e) {
  failed++
  console.log('FAIL  the rig crashed: ' + (e && e.stack || e))
} finally {
  await browser.close()
  for (const s of servers) s.close()
}

console.log(`\nstage-0 probes: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
