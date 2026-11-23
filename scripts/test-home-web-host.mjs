#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/home in your browser: the library-host security rows that
 * scripts/test-home-web.mjs and scripts/test-home-web-offline.mjs do not
 * already carry. Real builds, real servers, a real browser.
 *
 *   PLAYWRIGHT_MODULE=…/playwright/index.mjs node scripts/test-home-web-host.mjs
 *   BENTO_BROWSER=webkit|firefox|chrome …  another engine (default chromium, Playwright's
 *                                        headless shell; chrome = the installed Google Chrome)
 *   … --only t8,emb,d5,d7                some sections
 *   … --mutants [name…]                  each mutant must turn its row red
 *
 * Builds home/web against local origins (the library on 127.0.0.1, the frame
 * page on localhost: two sites), serves them with the _headers the build wrote,
 * and opens decks made from the frozen slides 1.2.10 shell. Every WebSocket is
 * refused. Rows (design names in brackets):
 *
 *   [T8] isolation between opens of the library, stage 1 (one document per tab,
 *        nothing kept past an open):
 *        a  two tabs, the same file: the second tab's open holds nothing of the
 *           first's; a store message naming the other tab's entry or docId is
 *           dropped.
 *        b  a child frame and a popup of the document post store and handshake
 *           messages to the library window: nothing answers, the store counts
 *           do not move. Control: the document's own port call is served.
 *        d  two files with the SAME docId and different bytes (S.1a), opened one
 *           after the other: the second open is a new, empty entry.
 *   [EMB] a cross-origin https: page embedded by a genuine served document posts
 *        every store, save and identity-shaped request, plus a forged handshake,
 *        to parent and top. Controls: the messages are delivered (listeners in
 *        the document and the library see them), and the document's own port
 *        call is served. Pass: the embed receives nothing, and the store port's
 *        counters do not move while it posts. Plus a message missing its id, its
 *        op or its name on the port is dropped, never answered.
 *   [D5] the service worker rows test-home-web-offline.mjs lacks:
 *        a  the served /sw.js answers Cache-Control: no-cache (read off the wire);
 *        b1 a message posted to the controlling worker adds nothing to any cache;
 *        b2 after a deck opens, no Cache Storage, IndexedDB, localStorage,
 *           sessionStorage or OPFS entry on the library origin holds its canary;
 *        b3 a same-origin path outside the precache list is not answered by the
 *           worker (the server sees it; a listed path is the positive control);
 *        g  the library's served script-src carries neither 'unsafe-inline' nor
 *           blob:, and Trusted Types stay required.
 *   [D7b] with the bento/id agent built in, while the document's frame is
 *        fullscreen, neither a click at the library's sign-in button nor the
 *        keyboard reaches it, and no sign-in window opens. Control: windowed,
 *        the same click opens it.
 *
 * Rows other rigs already carry are not repeated here (scripts/test-home-web.mjs
 * [B2/T9] [B3] [B4] [S7]; test-home-web-offline.mjs worker-src, updateViaCache,
 * precache pins, the frame's worker-src 'none'; check-id-hosting.mjs the
 * sign-in host and directory headers).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { webcrypto } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = process.env.BENTO_BROWSER || 'chromium'
const args = process.argv.slice(2)

// ===== mutants =====================================================================================
// Each breaks one rule; the rig must go red ON THE ROW THAT GUARDS IT. `src` edits home/web/src
// before the build (the build refuses an edit that does not apply exactly once); `dist` edits the
// built files; `identity` builds the identity library too.
const MUTANTS = [
  {
    name: 'library-answers-window', only: 't8,emb', why: 'the library answers store requests that arrive as window messages',
    src: { file: 'library.ts', from: '  addEventListener(\'message\', s.onReady)\n',
      to: "  addEventListener('message', s.onReady)\n  addEventListener('message', (ev) => { const d = ev.data; if (session === s && d && typeof d === 'object' && ev.source) (ev.source as Window).postMessage({ t: 'bento-store', v: 1, id: d.id ?? 0, ok: true }, '*') })\n" },
    expect: ['[T8-b]', '[EMB-a] the embed received nothing'],
  },
  {
    name: 'frame-relays-window', only: 'emb', why: 'the frame relays window messages onto the store port',
    // after the write: document.open() erases every listener on the window, so a relay set before it is gone
    src: { file: 'frame.ts', from: '    docClose(doc)\n', to: '    docClose(doc)\n    listen(win, \'message\', (e: MessageEvent) => { try { portPost(ports[1], evData(e)) } catch { /* not cloneable */ } })\n' },
    expect: ['[EMB-a] the store port saw nothing from the embed'],
  },
  {
    name: 'store-entry-by-docid', only: 't8', why: 'the entry is the docId and outlives the open (S.1a)',
    src: [{ file: 'library.ts', from: 'entry: mintEntry(), store: null }', to: 'entry: String(docIdOf(html)), store: null }' },
      { file: 'library.ts', from: '  memory.dropEntry(session.entry)\n', to: '' }],
    expect: ['[T8-d]'],
  },
  {
    name: 'sw-message-cache', only: 'd5', why: 'the worker caches what a page posts to it',
    src: { file: 'sw.ts', from: "self.addEventListener('activate', (e) => {",
      to: "(self as any).addEventListener('message', (e: any) => { e.waitUntil(caches.open(CACHE).then((c) => c.put(String(e.data && e.data.cache), new Response('planted')))) })\nself.addEventListener('activate', (e) => {" },
    expect: ['[D5-b1]'],
  },
  {
    name: 'library-keeps-document', only: 'd5', why: 'the library keeps a copy of the open document in session storage',
    src: { file: 'library.ts', from: "  if (v.verdict === 'genuine') {\n", to: "  if (v.verdict === 'genuine') {\n    try { sessionStorage.setItem('bento-last', html) } catch {}\n" },
    expect: ['[D5-b2]'],
  },
  {
    name: 'sw-answers-everything', only: 'd5', why: 'the worker answers every same-origin GET, not only its list',
    src: { file: 'sw.ts', from: ' || !PATHS.has(url.pathname)) return', to: ') return' },
    expect: ['[D5-b3]'],
  },
  {
    name: 'sw-max-age', only: 'd5', why: 'the worker script is served cacheable for an hour',
    dist: [{ file: 'library/_headers', from: 'Cache-Control: no-cache', to: 'Cache-Control: max-age=3600', all: true }],
    expect: ['[D5-a]'],
  },
  {
    name: 'script-src-blob', only: 'd5', why: "the library's script-src gains blob:",
    dist: [{ file: 'library/_headers', from: "script-src 'sha256-", to: "script-src blob: 'sha256-", all: true }],
    expect: ['[D5-g]'],
  },
  {
    name: 'identity-beside-document', only: 'd7', identity: true, why: "the library's sign-in line is drawn beside an open document",
    src: { file: 'identity-ui.ts', from: '  box.hidden = false\n', to: "  box.hidden = false\n  if (box.parentElement !== document.body) document.body.insertBefore(box, document.getElementById('stage'))\n" },
    expect: ['[D7b] windowed, a document open'],
  },
]

if (args.includes('--mutants')) {
  const names = args.slice(args.indexOf('--mutants') + 1).filter((a) => !a.startsWith('--'))
  let n = 0, bad = 0
  for (const m of MUTANTS.filter((x) => !names.length || names.includes(x.name))) {
    const env = { ...process.env, NODE_NO_WARNINGS: '1', BENTO_HOST_MUTANT: JSON.stringify(m) }
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--only', m.only], { env, encoding: 'utf8', timeout: 900_000 })
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    const applied = /mutant applied/.test(out) && !/mutant NOT applied/.test(out)
    const fails = out.split('\n').filter((l) => l.includes('FAIL'))
    const caught = m.expect.every((e) => fails.some((l) => l.includes(e)))
    n++
    const good = applied && r.status !== 0 && caught
    if (!good) bad++
    console.log(`  ${good ? 'ok  ' : 'FAIL'}  ${m.name}: ${m.why} — ${!applied ? 'NOT APPLIED' : caught ? `red on ${m.expect.join(' + ')}` : r.status === 0 ? 'SURVIVED' : 'red, but not on its row'}`)
    if (!good) console.log(out.split('\n').filter((l) => /FAIL|Error|mutant/.test(l)).slice(0, 8).map((l) => '        ' + l).join('\n'))
  }
  console.log(`\n${n - bad}/${n} mutants killed (${ENGINE})`)
  process.exit(bad ? 1 : 0)
}

const MUTANT = process.env.BENTO_HOST_MUTANT ? JSON.parse(process.env.BENTO_HOST_MUTANT) : null
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : ['t8', 'emb', 'd5', 'd7']
const runs = (s) => ONLY.includes(s)

const { startServers, freePorts } = await import(path.join(ROOT, 'home/web/serve.mjs'))
const { spliceDoc } = await import(path.join(ROOT, 'home/web/src/verify.ts'))
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { guardBrowser, apiLogger } = await import(path.join(ROOT, 'scripts/lib/browser-guard.mjs'))

let checks = 0, failures = 0
let guard = null
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); guard?.progress(m) }
const section = (m) => { console.log(`\n=== ${m}`); guard?.section(m) }
const note = (m) => { console.log(`  note  ${m}`); guard?.progress(m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Two instruments not every engine has, decided by engine and never by probing (a probe that
// failed in Chromium would quietly turn its rows off). D5-b3 needs Playwright to say which
// responses a worker answered: WebKit never reports it, and in Firefox the rig's probe page is
// never controlled by the worker (measured), so its positive control cannot pass there. The
// Fullscreen API works in headless Chromium, not in headless WebKit or Firefox. Chromium runs
// every row.
const HAS = { swSource: ENGINE === 'chromium' || ENGINE === 'chrome', fullscreen: ENGINE === 'chromium' || ENGINE === 'chrome' }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-home-host-'))
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }))

// --- fixtures: decks in the frozen 1.2.10 shell --------------------------------------------------
const REAL = path.join(ROOT, 'home/fixtures/gate1/real/slides-1.2.10')
const shell1210 = fs.readFileSync(path.join(REAL, 'Bento_Slides.bento.html'), 'utf8')
const rnd = () => webcrypto.getRandomValues(new Uint32Array(2)).join('')
const CANARY = 'BENTO-HOST-CANARY-' + rnd()
const deckOf = (docId, title) => spliceDoc(shell1210, JSON.stringify({
  format: 'bento/slides', version: 1, docId, title, size: { w: 1280, h: 720 },
  slides: [{ id: 's1', background: '#ffffff', elements: [{ id: 't1', type: 'text', x: 96, y: 200, w: 1000, h: 120, html: title, fontSize: 48, color: '#16273E' }] }],
}).replace(/</g, '\\u003c'))
const SHARED_ID = webcrypto.randomUUID()
const FILES = {
  x1: deckOf(SHARED_ID, CANARY),                       // the canary is the title on page one
  x2: deckOf(SHARED_ID, 'Same docId, other bytes'),    // S.1a: the same docId, different bytes
  y: deckOf(webcrypto.randomUUID(), 'Another document'),
}
for (const [k, v] of Object.entries(FILES)) fs.writeFileSync(path.join(work, `${k}.bento.html`), v)
const F = (k) => path.join(work, `${k}.bento.html`)

// --- builds ---------------------------------------------------------------------------------------
async function build(name, extra = [], { mutate = true } = {}) {
  const [pl, pf, pr] = await freePorts(3)
  const out = path.join(work, name)
  const o = { library: `http://127.0.0.1:${pl}`, frame: `http://localhost:${pf}`, releaseBase: `http://127.0.0.1:${pr}/releases/` }
  const env = { ...process.env }
  delete env.BENTO_HOME_WEB_MUTANT
  const m = mutate && MUTANT && (!MUTANT.identity || extra.includes('--identity')) ? MUTANT : null
  if (m?.src) env.BENTO_HOME_WEB_MUTANT = JSON.stringify(m.src)
  const r = spawnSync(process.execPath, [path.join(ROOT, 'home/web/build.mjs'), '--out', out, '--library-origin', o.library, '--frame-origin', o.frame,
    '--release-base', o.releaseBase, '--dev', ...extra], { encoding: 'utf8', env })
  console.log(`  build ${name}: exit ${r.status}`)
  if (r.status !== 0) { console.log(r.stderr); if (m) console.log('  mutant NOT applied'); process.exit(2) }
  if (m?.src) console.log(`  mutant applied to ${name} source: ${m.name}`)
  for (const d of m?.dist ?? []) {
    const f = path.join(out, d.file)
    const t = fs.readFileSync(f, 'utf8')
    const n = t.split(d.from).length - 1
    if (d.all ? n < 1 : n !== 1) { console.log(`  mutant NOT applied: "${d.from}" occurs ${n} times in ${d.file}`); process.exit(2) }
    fs.writeFileSync(f, d.all ? t.split(d.from).join(d.to) : t.replace(d.from, () => d.to))
    console.log(`  mutant applied to ${name}/${d.file}: ${m.name}`)
  }
  const seen = []
  const s = await startServers({ dist: out, ports: { library: pl, frame: pf, release: pr }, onRequest: (q) => seen.push({ method: q.method, url: `http://${q.headers.host}${q.url}`, sw: q.headers['service-worker'] ?? null }) })
  return { ...o, s, seen, out }
}

section(`builds (${ENGINE})`)
const A = await build('a')
// the identity build pins a directory key: a throwaway one made here (no directory answers in this rig)
const dirKeys = path.join(work, 'directory-keys.json')
{
  const k = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  fs.writeFileSync(dirKeys, JSON.stringify({ 'dir-1': Buffer.from(await webcrypto.subtle.exportKey('raw', k.publicKey)).toString('base64url') }))
}
const I = runs('d7') ? await build('identity', ['--identity', '--directory-keys', dirKeys]) : null

// --- browser --------------------------------------------------------------------------------------
const browser = ENGINE === 'chrome' ? await pw.chromium.launch({ channel: 'chrome', logger: apiLogger }) : await pw[ENGINE].launch({ logger: apiLogger })
guard = guardBrowser(browser, { rig: `home/web host (${ENGINE})` })
const sockets = []
async function context(opts = {}) {
  const ctx = await browser.newContext(opts)
  await ctx.routeWebSocket(/.*/, (ws) => { sockets.push(ws.url()); ws.close() })
  return ctx
}
const docFrame = (page) => page.frames().find((f) => f.parentFrame() === page.mainFrame())
async function until(fn, ms = 20000) {
  const end = Date.now() + ms
  const limit = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('check timed out')), 10000))])
  while (Date.now() < end) { try { const v = await limit(fn()); if (v) return v } catch {} await sleep(150) }
  return null
}
const booted = (page) => until(async () => { const f = docFrame(page); return f && (await f.evaluate(() => !!(window.bento && window.bento.doc))) ? f : null })
const viewing = (page) => page.evaluate(() => ({ viewing: document.body.classList.contains('viewing'), problem: document.getElementById('problem-box')?.hidden === false ? document.getElementById('problem').textContent : '' }))
async function open(page, key) {
  await page.bringToFront()
  await page.setInputFiles('#file', F(key))
  const u = await until(async () => { const v = await viewing(page); return v.viewing || v.problem ? v : null })
  return u?.viewing ? booted(page) : null
}
const counts = async (page) => { const v = await page.evaluate(() => document.documentElement.getAttribute('data-bento-store')); const [served, refused, dropped] = (v ?? '0 0 0').split(' ').map(Number); return { served, refused, dropped } }
const total = (c) => c.served + c.refused + c.dropped
// the kernel's own client, loaded into the booted frame as a later shell would carry it
const esbuild = process.env.ESBUILD || path.join(ROOT, 'slides/node_modules/.bin/esbuild')
const kernelJs = execFileSync(esbuild, [path.join(ROOT, 'kernel/src/docstore.ts'), '--bundle', '--format=iife', '--global-name=__bentoKernelStore', '--platform=browser', '--target=es2022', '--log-level=error'], { encoding: 'utf8' })
const loadKernel = (fr) => fr.evaluate((code) => new Promise((res, rej) => {
  if (window.__bentoKernelStore) return res(true)
  const el = document.createElement('script')
  el.src = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  el.onload = () => res(true)
  el.onerror = () => rej(new Error('the kernel bundle did not load'))
  document.head.appendChild(el)
}), kernelJs)
/** The document's store, through the kernel's client: `ops` run in the frame. */
const withStore = async (fr, fn, arg) => { await loadKernel(fr); return fr.evaluate(fn, arg).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) })) }
const STORE_SET = async (v) => { const ds = window.__bentoKernelStore.docStore(); return ds.set('memberkey', new TextEncoder().encode(v)) }
const STORE_READ = async () => { const ds = window.__bentoKernelStore.docStore(); const b = await ds.get('memberkey'); return { list: await ds.list(), key: b ? new TextDecoder().decode(b) : null } }

try {
  // ===== [T8] =================================================================================
  if (runs('t8')) {
    section('[T8] isolation between opens of the library (stage 1)')
    const ctx = await context()
    const t1 = await ctx.newPage()
    await t1.goto(A.library + '/')
    const f1 = await open(t1, 'x1')
    const set1 = f1 ? await withStore(f1, STORE_SET, 'tab-one-secret') : null
    const read1 = f1 ? await withStore(f1, STORE_READ) : null
    // the second tab opens only now, with the first still holding its open (CI's Firefox never
    // answered a call into a tab that had loaded in the background meanwhile)
    const t2 = await ctx.newPage()
    await t2.goto(A.library + '/')
    ok(set1 === 'stored' && read1?.key === 'tab-one-secret', `[T8-a] positive control: the first tab's document stores and reads back through its port (${set1}, ${JSON.stringify(read1)})`)
    const f2 = await open(t2, 'x1')
    // the second tab's document speaks on its port by hand: what it holds, then the first tab's docId and an entry
    const c0 = await counts(t2)
    const t2r = f2 ? await f2.evaluate(async (docId) => {
      const port = window.__bentoDocStore.take()
      if (!port) return { error: 'no port' }
      const got = []
      port.onmessage = (e) => got.push(e.data)
      const R = (id, op, x = {}) => ({ t: 'bento-store', v: 1, id, op, ...x })
      const wait = () => new Promise((r) => setTimeout(r, 600))
      port.postMessage(R(1, 'list')); port.postMessage(R(2, 'get', { name: 'memberkey' }))
      await wait()
      const own = got.splice(0).map((a) => ({ id: a.id, ok: a.ok, names: a.names, bytes: a.bytes === undefined ? 'absent' : a.bytes === null ? null : 'bytes' }))
      port.postMessage(R(100, 'get', { name: 'memberkey', docId }))
      port.postMessage(R(101, 'list', { entry: docId }))
      port.postMessage(R(102, 'get', { name: 'memberkey', entry: 'tab-one' }))
      await wait()
      return { own, answered: got.length }
    }, SHARED_ID) : null
    const c1 = await counts(t2)
    const own = t2r?.own ?? []
    ok(own.length === 2 && own.every((a) => a.ok) && JSON.stringify(own[0].names) === '[]' && own[1].bytes === null, `[T8-a] two tabs, the same file: the second tab's open holds nothing of the first's (${JSON.stringify(own)})`)
    ok(t2r?.answered === 0 && c1.dropped - c0.dropped === 3, `[T8-a] a store message naming the other open's docId or an entry is dropped, never answered (${t2r?.answered} answered, dropped +${c1.dropped - c0.dropped})`)

    // [T8-b] a child frame and a popup of the document, at the library window
    await t2.click('#close')
    const fb = await open(t2, 'y')
    const before = await counts(t2)
    const probe = fb ? await fb.evaluate(async () => {
      const got = []
      const listen = (w, who) => { try { w.addEventListener('message', (e) => got.push({ who, kind: e.data && (e.data.kind || e.data.t || e.data.op) })) } catch {} }
      const msgs = [
        { t: 'bento-store', v: 1, id: 1, op: 'list' },
        { t: 'bento-store', v: 1, id: 2, op: 'get', name: 'memberkey' },
        { kind: 'bento-frame-ready' },
        { kind: 'save-declined' },
        { id: 'w1', op: 'identity.whoami' },
      ]
      const fire = (src, target) => { for (const m of msgs) { try { target.postMessage(m, '*') } catch {} } const { port1, port2 } = new MessageChannel(); port1.onmessage = (e) => got.push({ who: 'forged-port', kind: JSON.stringify(e.data).slice(0, 40) }); try { target.postMessage({ kind: 'bento-frame-ready' }, '*', [port2]) } catch {} }
      // a child frame of the document (same opaque origin, so this script can drive it)
      const child = document.createElement('iframe')
      document.body.appendChild(child)
      const cw = child.contentWindow
      listen(cw, 'child')
      fire('child', cw.top); fire('child', cw.parent.parent)
      // the document itself, at its parent
      listen(window, 'doc')
      fire('doc', window.parent); fire('doc', window.top)
      await new Promise((r) => setTimeout(r, 800))
      return { got, childTopIsParent: cw.top === window.parent }
    }) : null
    // a popup the document opens (from a click: a popup needs activation)
    const popP = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null)
    await fb?.evaluate(() => {
      const b = document.createElement('button')
      b.id = 'rig-pop'; b.textContent = 'pop'
      b.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;width:80px;height:40px'
      b.addEventListener('click', () => {
        const w = window.open('about:blank')
        window.__pop = w
        if (w) {
          window.__popGot = []
          w.addEventListener('message', (e) => window.__popGot.push(e.data))
          for (const target of [w.opener && w.opener.parent, w.opener && w.opener.top]) {
            if (!target) continue
            for (const m of [{ t: 'bento-store', v: 1, id: 3, op: 'list' }, { kind: 'bento-frame-ready' }]) { try { target.postMessage(m, '*') } catch {} }
          }
        }
      })
      document.body.appendChild(b)
    })
    await fb?.click('#rig-pop', { timeout: 5000 }).catch(() => {})
    const pop = await popP
    await sleep(1000)
    const popGot = fb ? await fb.evaluate(() => (window.__popGot ?? []).length).catch(() => -1) : -1
    const after = await counts(t2)
    const answers = (probe?.got ?? []).filter((g) => g.who === 'forged-port' || g.kind === 'bento-store' || (typeof g.kind === 'number'))
    ok(!!probe && answers.length === 0 && popGot === 0, `[T8-b] a child frame, the document and a popup posting store and handshake messages at the library window get no answer (${answers.length} to the frames, ${popGot} to the popup${pop ? '' : '; no popup opened in ' + ENGINE})`)
    ok(total(after) === total(before), `[T8-b] the library's store counters did not move (${JSON.stringify(before)} -> ${JSON.stringify(after)})`)
    await pop?.close().catch(() => {})
    const ctl = fb ? await withStore(fb, async () => (await window.__bentoKernelStore.docStore().list()).length) : null
    const afterCtl = await counts(t2)
    ok(ctl === 0 && afterCtl.served === after.served + 1, `[T8-b] positive control: the document's own port call is served (${JSON.stringify(ctl)}, served ${after.served} -> ${afterCtl.served})`)

    // [T8-d] S.1a: the same docId, different bytes, one after the other in one tab
    await t1.click('#close')
    const fx2 = await open(t1, 'x2')
    const readx2 = fx2 ? await withStore(fx2, STORE_READ) : null
    ok(!!readx2 && JSON.stringify(readx2.list) === '[]' && readx2.key === null, `[T8-d] a file with the same docId and other bytes, opened after the first closed, is a new empty entry (${JSON.stringify(readx2)})`)
    await ctx.close()
  }

  // ===== [EMB] ================================================================================
  if (runs('emb')) {
    section('[EMB] a cross-origin https: embed inside a genuine served document')
    const EMBED = 'https://embed.bento-rig.test'
    const embedHtml = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/webext-embed/embed.html'), 'utf8')
    const ctx = await context()
    const embedHits = []
    // the embed is served over https by the rig itself (no CDN; Playwright fulfils it before any network)
    await ctx.route(`${EMBED}/**`, (route) => { embedHits.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'text/html', body: embedHtml }) })
    const page = await ctx.newPage()
    await page.goto(A.library + '/')
    // what the library window receives from the embed's origin (control: the messages are delivered)
    // An embed inside the sandboxed frame inherits its sandbox, so its messages arrive from origin
    // "null", as the document's own do: the listeners pick the embed's out by their shape.
    // (the page policies refuse eval, so the same predicate is written out in each listener)
    await page.evaluate(() => {
      const shape = (d) => !!d && typeof d === 'object' && ((typeof d.op === 'string' && /^(identity|save|serve)\./.test(d.op)) || d.name === 'forged.bento.html' || d.kind === 'bento-serve-ready')
      window.__libGot = []; addEventListener('message', (e) => { if (shape(e.data)) window.__libGot.push(e.origin) })
    })
    const fr = await open(page, 'y')
    ok(!!fr, '[EMB] precondition: the genuine deck boots in the frame')
    await fr?.evaluate(() => {
      const shape = (d) => !!d && typeof d === 'object' && ((typeof d.op === 'string' && /^(identity|save|serve)\./.test(d.op)) || d.name === 'forged.bento.html' || d.kind === 'bento-serve-ready')
      window.__docGot = []; addEventListener('message', (e) => { if (shape(e.data)) window.__docGot.push(e.origin) })
    })
    const c0 = await counts(page)
    await fr?.evaluate((src) => { const f = document.createElement('iframe'); f.id = 'rig-embed'; f.src = src; document.body.appendChild(f) }, `${EMBED}/embed.html`)
    const emb = await until(() => { const f = page.frames().find((x) => x.url().startsWith(EMBED)); return f ? f.evaluate(() => window.__embed && { ...window.__embed, got: window.__embed.got.length }) : null }, 10000)
    await sleep(1800) // the fixture attacks at once and again 700 ms later
    const embedFrame = page.frames().find((x) => x.url().startsWith(EMBED))
    const embAfter = embedFrame ? await embedFrame.evaluate(() => ({ got: window.__embed.got, tried: window.__embed.tried.length, origin: window.__embed.origin, secure: window.__embed.secure })) : null
    const libGot = await page.evaluate(() => window.__libGot.length)
    const docGot = fr ? await fr.evaluate(() => window.__docGot.length) : 0
    const c1 = await counts(page)
    ok(embedHits.length >= 1 && embAfter?.origin === EMBED && embAfter?.secure === true && embAfter.tried >= 20, `[EMB-a] the embed was served over https from the rig's origin, and its script ran (${embedHits.length} fetches, ${embAfter?.origin}, secure ${embAfter?.secure}, ${embAfter?.tried} attempts)`)
    ok(libGot >= 10 && docGot >= 10, `[EMB-a] control: the embed's messages are delivered to the library window (${libGot}) and to the document (${docGot})`)
    ok(!!embAfter && embAfter.got.length === 0, `[EMB-a] the embed received nothing (${JSON.stringify(embAfter?.got ?? null).slice(0, 160)})`)
    ok(total(c1) === total(c0), `[EMB-a] the store port saw nothing from the embed (${JSON.stringify(c0)} -> ${JSON.stringify(c1)})`)
    const ctl = fr ? await withStore(fr, async () => (await window.__bentoKernelStore.docStore().list()).length) : null
    const c2 = await counts(page)
    ok(ctl === 0 && c2.served === c1.served + 1, `[EMB-a] control: the genuine document's own port call is served (${JSON.stringify(ctl)}, served ${c1.served} -> ${c2.served})`)

    // [EMB-b] absent fields on the port: dropped, never answered (a fresh open, a fresh port)
    await page.click('#close')
    const fb = await open(page, 'y')
    const cb0 = await counts(page)
    const absent = fb ? await fb.evaluate(async () => {
      const port = window.__bentoDocStore.take()
      const got = []
      port.onmessage = (e) => got.push(e.data)
      port.postMessage({ t: 'bento-store', v: 1, op: 'list' })                          // no id
      port.postMessage({ t: 'bento-store', v: 1, id: 1, name: 'memberkey' })            // no op
      port.postMessage({ t: 'bento-store', v: 1, id: 2, op: 'get' })                    // no name
      port.postMessage({ v: 1, id: 3, op: 'list' })                                     // no t
      port.postMessage({ t: 'bento-store', id: 4, op: 'list' })                         // no v
      await new Promise((r) => setTimeout(r, 600))
      const before = got.length
      port.postMessage({ t: 'bento-store', v: 1, id: 5, op: 'list' })                   // control
      await new Promise((r) => setTimeout(r, 600))
      return { answered: before, control: got.slice(before).map((a) => a.id) }
    }) : null
    const cb1 = await counts(page)
    ok(absent?.answered === 0 && cb1.dropped - cb0.dropped === 5, `[EMB-b] a store message missing its id, op, name, t or v is dropped, never answered (${absent?.answered} answered, dropped +${cb1.dropped - cb0.dropped})`)
    ok(JSON.stringify(absent?.control) === '[5]', `[EMB-b] control: the same port answers a whole message (${JSON.stringify(absent?.control)})`)
    await ctx.close()
  }

  // ===== [D5] =================================================================================
  if (runs('d5')) {
    section('[D5] the library service worker: what test-home-web-offline.mjs does not carry')
    const wire = await fetch(A.library + '/sw.js')
    const cc = wire.headers.get('cache-control')
    ok(wire.status === 200 && cc === 'no-cache', `[D5-a] the served /sw.js answers Cache-Control: no-cache, read off the wire (${wire.status}, ${cc})`)
    const libCsp = (await fetch(A.library + '/')).headers.get('content-security-policy') ?? ''
    const scriptSrc = libCsp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src ')) ?? ''
    ok(!!scriptSrc && !/'unsafe-inline'|'unsafe-eval'|\bblob:|\bdata:|\*/.test(scriptSrc) && scriptSrc.split(' ').slice(1).every((s) => /^'sha256-[A-Za-z0-9+/=]+'$/.test(s)),
      `[D5-g] the library's served script-src is hashes only: no 'unsafe-inline', blob:, data: or wildcard (${scriptSrc.slice(0, 60)}…)`)
    ok(libCsp.includes("require-trusted-types-for 'script'"), "[D5-g] the library's served policy still requires Trusted Types")

    const ctx = await context()
    const first = await ctx.newPage()
    await first.goto(A.library + '/')
    const ready = await until(() => first.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!r?.active && (await caches.keys()).length === 1 }), 20000)
    // a controlled page: a NEW tab, not a reload (CI's Firefox never answered a call into a page
    // reloaded under its worker)
    const page = await ctx.newPage()
    await page.goto(A.library + '/')
    await first.close()
    const controlled = await until(() => page.evaluate(() => !!navigator.serviceWorker.controller), 10000)
    ok(!!ready && !!controlled, `[D5] precondition: the worker is installed, holds its cache, and controls the page (${!!ready}, ${!!controlled})`)
    // the cache names and whether any cache answers /evil (CI's Firefox never returned from a walk of
    // every cache's keys on this page; these are the calls test-home-web-offline makes there)
    const cacheList = () => until(() => page.evaluate(async () => ({ names: await caches.keys(), evil: !!(await caches.match('/evil')) })), 30000)
    const list0 = await cacheList()
    await page.evaluate(() => { navigator.serviceWorker.controller?.postMessage({ cache: '/evil' }); navigator.serviceWorker.controller?.postMessage({ cache: '/evil', url: '/evil', body: 'x' }) })
    await sleep(1200)
    const list1 = await cacheList()
    ok(!!list0 && !!list1 && list0.names.length === 1 && !list0.evil && JSON.stringify(list1.names) === JSON.stringify(list0.names) && !list1.evil, `[D5-b1] a message posted to the controlling worker adds nothing to any cache (${JSON.stringify(list0)} -> ${JSON.stringify(list1)})`)

    // [D5-b3] a same-origin path off the list is not the worker's to answer. Subresource fetches
    // (a navigation may be answered from the navigation preload, which an engine can report either
    // way), from a probe page the rig plants on the library origin: off the list itself, so it has
    // no policy of its own and the worker leaves it to the server, but it is in the worker's scope,
    // so the worker sees its fetches. A listed path is the control.
    fs.writeFileSync(path.join(A.out, 'library', 'rig-probe.html'), '<!doctype html><title>probe</title>')
    const bySw = new Map()
    const onResp = (r) => { try { const u = new URL(r.url()); if (u.origin === A.library) bySw.set(u.pathname, r.fromServiceWorker()) } catch {} }
    ctx.on('response', onResp)
    const nav = await ctx.newPage()
    await nav.goto(A.library + '/rig-probe.html').catch(() => {})
    const navCtl = await until(() => nav.evaluate(() => !!navigator.serviceWorker.controller), 10000)
    const mark = A.seen.length
    const st = await nav.evaluate(async () => ({
      listed: await fetch('/icon-192.png', { cache: 'no-store' }).then((r) => r.status, () => 'error'),
      unlisted: await fetch('/rig-unlisted-path', { cache: 'no-store' }).then((r) => r.status, () => 'error'),
    })).catch((e) => ({ error: String(e.message) }))
    await sleep(300)
    ctx.off('response', onResp)
    await nav.close()
    const atServer = A.seen.slice(mark).filter((r) => r.url === A.library + '/rig-unlisted-path').length
    const listedBySw = bySw.get('/icon-192.png') ?? null, unlistedBySw = bySw.get('/rig-unlisted-path') ?? null
    if (!HAS.swSource) note(`[D5-b3] not measured in ${ENGINE}: ${ENGINE === 'webkit' ? "Playwright's WebKit does not report which responses a service worker answered" : "the rig's probe page is not controlled by the worker here, so the positive control cannot pass"} (Chromium measures it)`)
    else ok(!!navCtl && st.listed === 200 && listedBySw === true, `[D5-b3] positive control: on a page the worker controls, a listed path is answered by the worker (controlled ${!!navCtl}, ${st.listed}, fromServiceWorker ${listedBySw})`)
    if (HAS.swSource) ok(st.unlisted === 404 && atServer === 1 && unlistedBySw === false, `[D5-b3] a same-origin path off the list goes to the server as if there were no worker (status ${st.unlisted}, ${atServer} at the server, from the worker ${unlistedBySw})`)

    // [D5-b2] open the canary deck, then look everywhere the library origin can keep anything
    await page.bringToFront()
    const fr = await open(page, 'x1')
    ok(!!fr, '[D5-b2] positive control: the canary deck (its title is the canary) opens and boots')
    const where = await page.evaluate(async (canary) => {
      const found = []
      const has = (t) => typeof t === 'string' && t.includes(canary)
      for (const n of await caches.keys()) { const c = await caches.open(n); for (const r of await c.keys()) if (has(r.url) || has(await (await c.match(r)).text())) found.push('cache ' + n) }
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (has(k) || has(localStorage.getItem(k))) found.push('localStorage') }
      for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (has(k) || has(sessionStorage.getItem(k))) found.push('sessionStorage') }
      const dbs = indexedDB.databases ? await indexedDB.databases() : []
      for (const d of dbs) {
        const db = await new Promise((res) => { const r = indexedDB.open(d.name); r.onsuccess = () => res(r.result); r.onerror = () => res(null) })
        if (!db) continue
        for (const s of db.objectStoreNames) {
          const all = await new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res([]) })
          if (has(JSON.stringify(all, (k, v) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? new TextDecoder().decode(v) : v)))) found.push('indexedDB ' + d.name)
        }
        db.close()
      }
      let opfs = 'absent'
      try {
        const root = await navigator.storage.getDirectory()
        opfs = 'empty'
        const walk = async (dir) => { for await (const [name, h] of dir.entries()) { opfs = 'entries'; if (h.kind === 'file') { if (has(await (await h.getFile()).text())) found.push('opfs ' + name) } else await walk(h) } }
        await walk(root)
      } catch {}
      return { found, opfs, dbs: dbs.map((d) => d.name) }
    }, CANARY)
    ok(where.found.length === 0, `[D5-b2] no Cache Storage, IndexedDB, localStorage, sessionStorage or OPFS entry on the library origin holds the open document's canary (${JSON.stringify(where)})`)
    await ctx.close()
  }

  // ===== [D7b] ================================================================================
  if (runs('d7')) {
    section('[D7b] the bento/id sign-in is never reachable while a document is open, windowed or fullscreen')
    const SIGNIN = 'https://signin.id.bento.page'
    const ctx = await context()
    const signinOpened = []
    await ctx.route(`${SIGNIN}/**`, (route) => { signinOpened.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>sign-in stand-in</title><p>stand-in' }) })
    await ctx.route('https://id.bento.page/**', (route) => route.fulfill({ status: 503, body: '' }))
    const page = await ctx.newPage()
    await page.goto(I.library + '/')
    const act = await until(() => page.evaluate(() => { const a = document.getElementById('id-act'); return a && !a.hidden && document.getElementById('id-box').dataset.ready === '1' ? a.textContent : null }), 20000)
    ok(!!act, `[D7b] precondition: with no document open, the identity line shows its button (${act})`)
    const box = await page.locator('#id-act').boundingBox()
    const shown = () => page.evaluate(() => { const a = document.getElementById('id-act'); return !!a && a.getClientRects().length > 0 })
    /** a click where the button was, then Tab and Enter: did any sign-in window open? */
    const tryReach = async () => {
      const pop = ctx.waitForEvent('page', { timeout: 2500 }).catch(() => null)
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      let focused = false
      for (let i = 0; i < 12 && !focused; i++) {
        await page.keyboard.press('Tab')
        focused = await page.evaluate(() => document.activeElement?.id === 'id-act').catch(() => false)
        if (focused) await page.keyboard.press('Enter')
      }
      const p = await pop
      await p?.close().catch(() => {})
      return { opened: !!p || signinOpened.length > 0, focused }
    }
    const fr = await open(page, 'y')
    ok(!!fr, '[D7b] precondition: a deck boots')
    const r1 = await tryReach()
    ok(!(await shown()) && !r1.opened && !r1.focused, `[D7b] windowed, a document open: the sign-in button is not rendered, and neither a click where it was nor Tab and Enter opens a sign-in window (${JSON.stringify(r1)})`)
    // the document goes fullscreen from a click inside its own frame (it has the activation)
    await fr?.evaluate(() => {
      const b = document.createElement('button')
      b.id = 'rig-fs'; b.textContent = 'fullscreen'
      b.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;width:120px;height:40px'
      b.addEventListener('click', () => { document.documentElement.requestFullscreen().catch(() => {}) })
      document.body.appendChild(b)
    })
    await fr?.click('#rig-fs', { timeout: 5000 }).catch(() => {})
    const fs1 = await until(() => page.evaluate(() => document.fullscreenElement?.tagName ?? null), 5000)
    if (!HAS.fullscreen) note(`[D7b] fullscreen not measured in ${ENGINE}: headless ${ENGINE} refuses requestFullscreen (it answered ${fs1}); the windowed rows above hold here, Chromium runs the fullscreen rows`)
    else ok(fs1 === 'IFRAME', `[D7b] precondition: the document's frame is fullscreen in the library (${fs1})`)
    const r2 = await tryReach()
    if (HAS.fullscreen) ok(!(await shown()) && !r2.opened && !r2.focused, `[D7b] fullscreen: the sign-in button is not rendered, and neither a click where it was nor Tab and Enter opens a sign-in window (${JSON.stringify(r2)})`)
    await page.evaluate(() => document.fullscreenElement && document.exitFullscreen()).catch(() => {})
    await until(() => page.evaluate(() => !document.fullscreenElement), 5000)
    // control: the document closed, the same click opens the sign-in window
    await page.click('#close')
    const pop3 = ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null)
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const p3 = await pop3
    await sleep(500)
    ok(!!p3 && signinOpened.length >= 1, `[D7b] control: with the document closed, a click on the same spot opens the sign-in window (${p3 ? 'opened' : 'none'}, ${signinOpened.length} requests)`)
    await p3?.close().catch(() => {})
    await ctx.close()
  }

  section('[network] sockets')
  ok(sockets.length === 0, `no WebSocket was opened in this run (${sockets.length})`)
} catch (e) {
  ok(false, `the run threw: ${String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ')}`)
}

await guard.close()
await A.s.close(); if (I) await I.s.close()
console.log(`\n${checks - failures}/${checks} checks passed (${ENGINE})`)
process.exit(failures ? 1 : 0)
