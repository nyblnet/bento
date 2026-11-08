#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/connect W2 — the served-document sandbox, in a real browser (manual).
//
//   node scripts/qa-webext-serve.mjs [path/to/genuine.bento.html]
//
// Not a CI rig: CI's headless shell can't load extensions. It loads the
// unpacked extension into Chrome for Testing and opens a GENUINE document
// through serve.html, then plays the document's part with frame.evaluate
// (which runs as page script in the sandbox's realm):
//   · the real deck boots in the sandbox; the identity agent answers over the port;
//   · CRITICAL (security 2026-10-24): page script patches
//     MessagePort.prototype.postMessage/start, EventTarget.prototype.addEventListener,
//     the MessageEvent data getter and Function.prototype.call/bind, then calls the
//     agent — the patches never see the port, and the call still works;
//   · __bentoIdentity can't be replaced (assign, defineProperty, delete);
//   · a well-formed request posted on window, or from a child frame, reaches nothing;
//   · a second handshake is ignored;
//   · an inline script the plan did not list does NOT run (the sandbox CSP).
// Defaults to the frozen real 1.2.10 deck if present, else fetches the live shell.

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
import { readdirSync, mkdtempSync, existsSync, cpSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const ok = (c, m) => { if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const base = join(homedir(), '.cache/puppeteer/chrome')
  for (const b of existsSync(base) ? readdirSync(base).sort().reverse() : []) {
    for (const p of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux64/chrome'])
      if (existsSync(join(base, b, p))) return join(base, b, p)
  }
}

const work = mkdtempSync(join(tmpdir(), 'serve-qa-'))
const ext = join(work, 'ext'); cpSync(join(root, 'home/webext'), ext, { recursive: true })
// a harness page for the sandbox-only rows (a plan that omits a script)
writeFileSync(join(ext, 'src/serve/qa-harness.html'), '<!doctype html><meta charset="utf-8"><body><script type="module" src="qa-harness.js"></script></body>')
writeFileSync(join(ext, 'src/serve/qa-harness.js'), `
const f = document.createElement('iframe'); f.src = 'sandbox.html'; document.body.appendChild(f)
window.__qa = new Promise((res) => {
  addEventListener('message', (ev) => {
    if (ev.source !== f.contentWindow || ev.data?.kind !== 'bento-serve-ready') return
    const html = '<!doctype html><body><p id="p">x</p><script>document.title = "INLINE RAN"</' + 'script><script>window.planned = 1</' + 'script></body>'
    const at = html.indexOf('<script>window.planned')
    const end = html.indexOf('</' + 'script>', at) + 9
    const { port1, port2 } = new MessageChannel()
    f.contentWindow.postMessage({ kind: 'bento-serve', html, plan: [{ tagStart: at, end, text: 'window.planned = 1', module: false }], name: 'qa.bento.html' }, '*', [port2])
    // ONE-SHOT: a second handshake, with another document and another port, must be ignored
    setTimeout(() => {
      const second = '<!doctype html><body><p id="second">SECOND</p><script>window.second = 1</' + 'script></body>'
      const s0 = second.indexOf('<script>'), s1 = second.indexOf('</' + 'script>') + 9
      const c = new MessageChannel()
      window.__secondPortHits = 0
      c.port1.onmessage = () => { window.__secondPortHits++ }
      f.contentWindow.postMessage({ kind: 'bento-serve', html: second, plan: [{ tagStart: s0, end: s1, text: 'window.second = 1', module: false }], name: 'x' }, '*', [c.port2])
    }, 600)
    setTimeout(() => res(f), 1500)
  })
})`)
// Count, on the HOST side, every message that arrives on its port (QA copy
// only), so 'reached the host' is measured rather than inferred.
{
  const f = join(ext, 'src/serve/serve.js')
  const src = readFileSync(f, 'utf8')
  const out = src.replace('      const req = parseRequest(e.data)', '      ;(window.__qaPort ??= []).push(e.data?.op ?? null)\n      const req = parseRequest(e.data)')
  if (out === src) throw new Error('host counter: the parseRequest line moved; update the replace')
  writeFileSync(f, out)
}
// POSITIVE CONTROL for the CRITICAL row: a copy of the sandbox whose bridge calls
// port.postMessage the naive way. The same probe MUST catch it, or a clean
// result on the real sandbox would prove nothing.
{
  const src = readFileSync(join(ext, 'src/serve/sandbox.js'), 'utf8')
  const naive = src.replace('    portPost(port, { id, op, args })', '    port.postMessage({ id, op, args })')
  if (naive === src) throw new Error('positive control: the ask() line moved; update the replace')
  writeFileSync(join(ext, 'src/serve/sandbox-naive.js'), naive)
  writeFileSync(join(ext, 'src/serve/sandbox-naive.html'), '<!doctype html><meta charset="utf-8"><script src="sandbox-naive.js"></script>')
  const mf = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'))
  mf.sandbox.pages.push('src/serve/sandbox-naive.html')
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify(mf, null, 2))
  writeFileSync(join(ext, 'src/serve/qa-naive.html'), '<!doctype html><meta charset="utf-8"><body><script type="module" src="qa-naive.js"></script></body>')
  writeFileSync(join(ext, 'src/serve/qa-naive.js'), `
const f = document.createElement('iframe'); f.src = 'sandbox-naive.html'; document.body.appendChild(f)
addEventListener('message', (ev) => {
  if (ev.source !== f.contentWindow || ev.data?.kind !== 'bento-serve-ready') return
  const { port1, port2 } = new MessageChannel()
  port1.onmessage = (e) => port1.postMessage({ id: e.data.id, result: null })
  f.contentWindow.postMessage({ kind: 'bento-serve', html: '<!doctype html><body>naive</body>', plan: [], name: 'n' }, '*', [port2])
})`)
}
const PROBE = async () => {
  const seen = []
  const mp = MessagePort.prototype, et = EventTarget.prototype, fp = Function.prototype
  const oPost = mp.postMessage, oStart = mp.start, oAdd = et.addEventListener, oCall = fp.call, oBind = fp.bind
  const dataDesc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')
  mp.postMessage = function (...a) { seen.push('postMessage'); return oPost.apply(this, a) }
  mp.start = function (...a) { seen.push('start'); return oStart.apply(this, a) }
  et.addEventListener = function (...a) { if (this instanceof MessagePort) seen.push('addEventListener on a port'); return oAdd.apply(this, a) }
  Object.defineProperty(MessageEvent.prototype, 'data', { configurable: true, get() { if (this.target instanceof MessagePort || this.currentTarget instanceof MessagePort) seen.push('data getter on a port event'); return dataDesc.get.call(this) } })
  fp.call = function (...a) { if (a[0] instanceof MessagePort) seen.push('call with a port'); return oCall.apply(this, a) }
  fp.bind = function (...a) { if (a[0] instanceof MessagePort) seen.push('bind with a port'); return oBind.apply(this, a) }
  const r1 = await window.__bentoIdentity.whoami()
  const r2 = await window.__bentoIdentity.sign('frame', '1.y')
  return { seen, r1, r2 }
}
let docPath = process.argv[2]
if (!docPath) {
  const dir = mkdtempSync(join(tmpdir(), 'serve-doc-'))
  const man = JSON.parse(JSON.parse(await (await fetch('https://bento.page/releases/slides/manifest.json')).text()).payload)
  docPath = join(dir, 'Real deck.bento.html')
  writeFileSync(docPath, await (await fetch(man.url)).text())
}

const ctx = await chromium.launchPersistentContext(join(work, 'profile'), { executablePath: chromePath(), headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] })
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker')
const id = new URL(sw.url()).host

// 0. both gates: with the setting at its default (absent), the host page refuses
{
  const off = await ctx.newPage()
  await off.goto(`chrome-extension://${id}/src/serve/serve.html?path=${encodeURIComponent(docPath)}`).catch(() => {})
  await off.waitForTimeout(1200)
  ok(off.url().startsWith('file://') && !off.frames().some((fr) => fr.url().includes('sandbox.html')), 'with the setting at its default (off), even a GENUINE file opens as itself, never in the sandbox')
  await off.close()
  await sw.evaluate(() => chrome.storage.local.set({ serveWithIdentity: true }))
}

// 1. a genuine document, served
const page = await ctx.newPage()
const logs = []; page.on('console', (m) => logs.push(m.text()))
await page.goto(`chrome-extension://${id}/src/serve/serve.html?path=${encodeURIComponent(docPath)}`)
await page.waitForTimeout(500)
const servedUrl = page.url()
ok(servedUrl.startsWith(`chrome-extension://${id}/src/serve/serve.html`), `a genuine document stays on the host page (${servedUrl.slice(0, 60)}…) — ${logs.filter((l) => l.includes('bento/connect')).join(' | ')}`)
const frame = await (async () => { for (let i = 0; i < 100; i++) { const f = page.frames().find((fr) => fr.url().includes('sandbox.html')); if (f) return f; await page.waitForTimeout(100) } })()
ok(!!frame, 'the sandbox frame exists')
await frame.waitForFunction(() => window.bento && typeof window.bento.serialize === 'function', null, { timeout: 30000 }).catch(() => {})
ok(await frame.evaluate(() => !!(window.bento && window.bento.doc)), 'the real deck boots in the sandbox (window.bento is there)')
ok(await frame.evaluate(() => { try { localStorage.getItem('x'); return false } catch { return true } }), 'and has no storage of its own (opaque origin)')
ok(await frame.evaluate(async () => (await window.__bentoIdentity.whoami()) === null), 'the agent answers over the port: whoami → null (no verified Bento ID yet)')
ok(await frame.evaluate(async () => JSON.stringify(await window.__bentoIdentity.sign('frame', '0.x')) === '{"ok":false,"reason":"no-identity"}'), 'sign → no-identity')

// 2. CRITICAL: page script patches every prototype the bridge could touch, then calls the agent
const crit = await frame.evaluate(PROBE)
ok(crit.seen.length === 0, `with postMessage/start/addEventListener/the data getter/call/bind all patched, the patches never saw the port (${crit.seen.join(', ') || 'nothing'})`)
ok(crit.r1 === null && crit.r2?.reason === 'no-identity', 'and the agent still works through the captured functions')

// 2b. security's further probes: Object.prototype accessors that cloning, JSON or
// promise resolution might consult, and a re-entrant call from a patched then
const more = await frame.evaluate(async () => {
  const bad = []
  const hits = Object.create(null)
  const suspicious = (v) => v instanceof MessagePort || v instanceof MessageEvent || (typeof Window !== 'undefined' && v instanceof Window && v !== window)
  const keys = ['id', 'op', 'args', 'result', 'ok', 'reason', 'data', 'ports', 'source', 'then', 'toJSON', 'text', 'kind', 'plan', 'html', 'name', 'payload', 'purpose', 'pub', 'email']
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty(k)) continue
    Object.defineProperty(Object.prototype, k, {
      configurable: true,
      get() { hits[k] = (hits[k] ?? 0) + 1; if (suspicious(this)) bad.push(`get ${k} on ${this?.constructor?.name}`); return undefined },
      set(v) { if (suspicious(this) || suspicious(v)) bad.push(`set ${k}`); Object.defineProperty(this, k, { value: v, writable: true, enumerable: true, configurable: true }) },
    })
  }
  let thenCalls = 0, reentered = []
  const oThen = Promise.prototype.then
  Promise.prototype.then = function (f, r) {
    thenCalls++
    if (thenCalls < 4) reentered.push(window.__bentoIdentity.whoami())
    for (const a of [f, r]) if (suspicious(a)) bad.push('then got a port/event')
    return oThen.call(this, f, r)
  }
  const out = await Promise.all([window.__bentoIdentity.whoami(), window.__bentoIdentity.sign('frame', '2.z'), window.__bentoIdentity.resolve({ pub: null, email: 'a@b.c' })])
  Promise.resolve(1).then(() => {}) // the page's own use: proves the patch is live
  const re = await Promise.all(reentered)
  Promise.prototype.then = oThen
  for (const k of keys) { const d = Object.getOwnPropertyDescriptor(Object.prototype, k); if (d && d.get) delete Object.prototype[k] }
  return { bad, hits: Object.entries(hits).map(([k, n]) => `${k}×${n}`).join(' '), thenCalls, out: JSON.stringify(out), re: JSON.stringify(re) }
})
ok(more.hits.length > 0, `(live) the patched Object.prototype accessors WERE consulted during the agent calls: ${more.hits}`)
ok(more.bad.length === 0, `and on 20 keys that cloning, JSON and promise resolution might touch, they never saw a port, an event or another window (${more.bad.join(', ') || 'nothing'})`)
ok(more.thenCalls > 0 && more.out === '[null,{"ok":false,"reason":"no-identity"},null]' && /^\[(null,?)+\]$/.test(more.re), `re-entrant agent calls from inside a patched Promise.prototype.then (live: ${more.thenCalls} calls) all answer correctly (${more.re})`)

// 3. the agent can't be replaced
const rep = await frame.evaluate(() => {
  const a = window.__bentoIdentity
  const tries = []
  try { window.__bentoIdentity = { contract: 1, whoami: () => 'EVIL' } } catch (e) { tries.push('assign:' + e.name) }
  try { Object.defineProperty(window, '__bentoIdentity', { value: { evil: 1 } }) } catch (e) { tries.push('define:' + e.name) }
  try { delete window.__bentoIdentity } catch (e) { tries.push('delete:' + e.name) }
  try { a.whoami = () => 'EVIL' } catch (e) { tries.push('member:' + e.name) }
  return { same: window.__bentoIdentity === a, frozen: Object.isFrozen(a), desc: JSON.stringify(Object.getOwnPropertyDescriptor(window, '__bentoIdentity') && { w: Object.getOwnPropertyDescriptor(window, '__bentoIdentity').writable, c: Object.getOwnPropertyDescriptor(window, '__bentoIdentity').configurable }), tries }
})
ok(rep.same && rep.frozen && rep.desc === '{"w":false,"c":false}', `__bentoIdentity can't be replaced, redefined, deleted or edited (${rep.tries.join(', ')})`)

// 4. requests that don't come through the port reach nothing
const portBefore = await page.evaluate(() => [...(window.__qaPort ?? [])])
const strays = await frame.evaluate(async () => {
  const req = { id: 's999', op: 'save.write', args: { text: 'EVIL' } }
  window.postMessage(req, '*')
  window.parent.postMessage(req, '*')
  window.top.postMessage(req, '*')
  const child = document.createElement('iframe'); document.body.appendChild(child)
  try { child.contentWindow.parent.postMessage(req, '*') } catch {}
  window.parent.postMessage({ kind: 'bento-serve-ready' }, '*')
  await new Promise((r) => setTimeout(r, 500))
  return true
})
await page.waitForTimeout(300)
ok(strays, 'a well-formed save request posted on window, to parent, to top and from a child frame was sent')
const portAfter = await page.evaluate(() => [...(window.__qaPort ?? [])])
ok(portBefore.filter((o) => o?.startsWith('identity.')).length >= 4, `(control) the host's counter does see the agent's own calls on the port: ${portBefore.join(', ')}`)
ok(portAfter.length === portBefore.length && !portAfter.includes('save.write'), `and none of the strays reached the host: nothing new arrived on its port (${portAfter.length - portBefore.length} new)`)

// 5. the sandbox-only rows: an inline script the plan did not list does not run
const h = await ctx.newPage()
await h.goto(`chrome-extension://${id}/src/serve/qa-harness.html`)
await h.waitForTimeout(2000)
const sb = h.frames().find((fr) => fr.url().includes('sandbox.html'))
const res = sb ? await sb.evaluate(() => ({ planned: window.planned, title: document.title })) : null
ok(res && res.planned === 1, 'a script IN the plan runs (as a blob: script)')
const second = sb ? await sb.evaluate(() => ({ second: window.second, el: !!document.getElementById('second'), first: !!document.getElementById('p') })) : null
ok(second && second.second === undefined && !second.el && second.first, 'ONE-SHOT: a second handshake (another document, another port) is ignored — the first document stays, the second never runs')
ok((await h.evaluate(() => window.__secondPortHits)) === 0, 'and the agent never talks on the second port')
const n = await ctx.newPage()
await n.goto(`chrome-extension://${id}/src/serve/qa-naive.html`)
await n.waitForTimeout(1200)
const nf = n.frames().find((fr) => fr.url().includes('sandbox-naive.html'))
const naive = nf ? await nf.evaluate(PROBE) : null
ok(naive && naive.seen.includes('postMessage'), `POSITIVE CONTROL: the same probe CATCHES a naive bridge that calls port.postMessage (${naive?.seen.join(', ')})`)
ok(res && res.title !== 'INLINE RAN', `an inline script NOT in the plan does not run — the fixed CSP refuses it (title "${res?.title}")`)

// 6. an UNKNOWN file opens as itself, without identity
const dir = mkdtempSync(join(tmpdir(), 'serve-unknown-'))
const genuine = readFileSync(docPath, 'utf8')
const rt = genuine.indexOf('id="bento-rt"'); const at = genuine.indexOf('>', rt) + 20
const tampered = join(dir, 'Tampered.bento.html')
writeFileSync(tampered, genuine.slice(0, at) + (genuine[at] === 'A' ? 'B' : 'A') + genuine.slice(at + 1))
const u = await ctx.newPage()
await u.goto(`chrome-extension://${id}/src/serve/serve.html?path=${encodeURIComponent(tampered)}`).catch(() => {})
await u.waitForTimeout(1500)
ok(u.url().startsWith('file://') && !u.frames().some((fr) => fr.url().includes('sandbox.html')), `a one-byte-tampered copy is UNKNOWN: it opens as itself (${u.url().slice(0, 40)}…), never in the sandbox`)

await ctx.close()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
