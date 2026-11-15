// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/id sign-in host (server/signin/) in a real browser: the popup
// protocol with bento/home, its consent screen, and the rp rules around it.
//
//   node scripts/test-signin-host-browser.mjs            # Playwright's headless shell
//   node scripts/test-signin-host-browser.mjs --chrome   # the installed Google Chrome
//
// Every origin is routed in-process: https://signin.id.bento.page is the REAL
// worker and files (server/signin/local.mjs); https://home.bento.page and
// https://attacker.example are small opener pages; https://id.bento.page is a
// directory stub that verifies each assertion with the kernel's own verifier
// (kernel/src/webauthn.ts: rp id.bento.page, origins exactly the sign-in host)
// and records the browser-set Origin (`os`) and the opener the page reports
// (`rq`). Each popup gets a CDP virtual authenticator holding one passkey for
// rp id.bento.page. Every other request is refused, and every WebSocket is
// closed; the rig fails if any was opened.
//
// Each rule has a row on the real host and a MUTANT: a copy of server/signin/
// with one edit that breaks that rule, under which the same row must go red.
// A mutant whose edit no longer applies fails the rig.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { siteHandler } from '../server/signin/local.mjs'
import { statementChallenge, verifyAssertion } from '../kernel/src/webauthn.ts'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const CHROME = process.argv.includes('--chrome')
const ROOT = fileURLToPath(new URL('../server/signin/', import.meta.url))
const HOME = 'https://home.bento.page', S = 'https://signin.id.bento.page', ATTACKER = 'https://attacker.example'
const DIR = 'https://id.bento.page'

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

// ---- the site, honest or with one rule broken ---------------------------------
// Each mutant: [file, from, to], applied in a copy; `from` must occur exactly once.
const MUTANTS = {
  // G12a: the origin check dropped, so any opener's request is shown and signed.
  'foreign-opener': [['public/signin.js', "  if (e.origin !== HOME) return show('refused', 'wrong-origin')\n", '']],
  // G12b: replies to whatever the opener now is.
  'reply-star': [['public/signin.js', 'if (to) to.postMessage(msg, HOME)', "if (to) to.postMessage(msg, '*')"]],
  // G12c: a request read from the page's own URL.
  'url-params': [['public/signin.js', "  if (!window.opener) return show('refused', 'no-opener')\n",
    "  const q = new URLSearchParams(location.search || location.hash.slice(1))\n" +
    "  if (q.get('t') === 'enrol') { taken = true; request = { W: q.get('W'), kx: q.get('kx'), label: q.get('label'), rq: HOME }; $('label').textContent = request.label; show('consent'); return }\n" +
    "  if (!window.opener) return show('refused', 'no-opener')\n"]],
  // G12a / "never an account change its opener asks for": a dispatcher that does what it is asked.
  'any-request': [
    ['public/signin.js', "  if (Object.keys(m).sort().join(',') !== 'W,kx,label,t') return 'not-a-request'\n  if (m.t !== 'enrol') return 'not-a-request'\n",
      "  if (m.t !== 'enrol') return { ...m, W: '', kx: '', label: String(m.t) }\n"],
    ['public/signin.js', '    const text = wdevText({ W: request.W, kx: request.kx, address: request.account, rosHash: ch.rosHash, label: request.label, at: ch.at, nonce: ch.nonce })',
      "    const text = request.t ? 'ros.' + request.t + '.' + b64u(new TextEncoder().encode(JSON.stringify(request))) + '.' + ch.nonce : wdevText({ W: request.W, kx: request.kx, address: request.account, rosHash: ch.rosHash, label: request.label, at: ch.at, nonce: ch.nonce })"],
  ],
  // Signal API on the opener's say-so.
  'signal': [['public/signin.js', "  if (Object.keys(m).sort().join(',') !== 'W,kx,label,t') return 'not-a-request'\n",
    "  if (m.t === 'signal') { await PublicKeyCredential.signalAllAcceptedCredentials({ rpId: RP_ID, userId: m.userId, allAcceptedCredentialIds: [] }); return 'signalled' }\n" +
    "  if (Object.keys(m).sort().join(',') !== 'W,kx,label,t') return 'not-a-request'\n"]],
  // G9'.3: framing allowed.
  'framed': [['src/worker.js', '  "frame-ancestors \'none\'",\n', ''], ['src/worker.js', "  'x-frame-options': 'DENY',\n", '']],
  // noopener: the page carries on without an opener.
  'noopener': [['public/signin.js', "  if (!window.opener) return show('refused', 'no-opener')\n", '']],
  // G12d: COOP same-origin on the sign-in host.
  'coop': [['src/worker.js', "  'x-frame-options': 'DENY',\n", "  'x-frame-options': 'DENY',\n  'cross-origin-opener-policy': 'same-origin',\n"]],
}
const tmp = mkdtempSync(join(tmpdir(), 'signin-mutants-'))
let tagN = 0
async function site(mutant) {
  if (!mutant) return siteHandler(ROOT)
  const dir = join(tmp, mutant)
  cpSync(ROOT, dir, { recursive: true })
  for (const [file, from, to] of MUTANTS[mutant]) {
    const f = join(dir, file), text = readFileSync(f, 'utf8')
    const n = text.split(from).length - 1
    if (n !== 1) throw new Error(`mutant ${mutant}: its edit occurs ${n} times in ${file}, not once; update the mutant`)
    writeFileSync(f, text.replace(from, () => to))
  }
  return siteHandler(dir, 'm' + ++tagN)
}

// ---- the browser --------------------------------------------------------------
const browser = await chromium.launch({ ...(CHROME ? { channel: 'chrome' } : {}), headless: true })
console.log(`${CHROME ? 'Google Chrome' : 'Playwright headless shell'} ${browser.version()}`)

// The person's passkey for rp id.bento.page.
const pk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const b64u = (b) => Buffer.from(b).toString('base64url')
const PK_PUB = b64u(await crypto.subtle.exportKey('raw', pk.publicKey))
const PK_PKCS8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pk.privateKey)).toString('base64')
const CRED_ID = Buffer.from('alice-passkey-01').toString('base64')
const USER = Buffer.from('acct-alice-0001')

const HOME_LIB = (title, extra = '') => `<!doctype html><meta charset=utf-8><title>${title}</title><script>
window.HM = { msgs: [], w: null,
  open(url, feat) { this.w = window.open(url || '${S}/', 'signin', feat || 'popup,width=520,height=640'); return !!this.w },
  send(m) { this.w.postMessage(m, '${S}') },
}
addEventListener('message', (e) => HM.msgs.push({ origin: e.origin, data: e.data, fromPopup: e.source === HM.w }))
</script>${extra}`
// A plain page at any origin, for the rp rows: no sign-in host code at all.
const PROBE = `<!doctype html><meta charset=utf-8><title>probe</title><script>
window.probe = async () => {
  const out = {}, ch = crypto.getRandomValues(new Uint8Array(32))
  const name = (e) => (e && e.name) || String(e)
  try { await navigator.credentials.create({ publicKey: { rp: { id: 'id.bento.page', name: 'x' }, user: { id: new Uint8Array(8), name: 'x', displayName: 'x' }, challenge: ch, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] } }); out.create = 'OK' } catch (e) { out.create = name(e) }
  try { await navigator.credentials.get({ publicKey: { rpId: 'id.bento.page', challenge: ch, allowCredentials: [] } }); out.get = 'OK' } catch (e) { out.get = name(e) }
  const P = window.PublicKeyCredential
  for (const [m, arg] of [['signalAllAcceptedCredentials', { rpId: 'id.bento.page', userId: '${USER.toString('base64url')}', allAcceptedCredentialIds: [] }],
    ['signalUnknownCredential', { rpId: 'id.bento.page', credentialId: '${Buffer.from('alice-passkey-01').toString('base64url')}' }],
    ['signalCurrentUserDetails', { rpId: 'id.bento.page', userId: '${USER.toString('base64url')}', name: 'renamed', displayName: 'renamed' }]]) {
    if (typeof P[m] !== 'function') { out[m] = 'absent'; continue }
    try { await P[m](arg); out[m] = 'OK' } catch (e) { out[m] = name(e) }
  }
  return out
}</script>`

const sockets = [], refused = []
let handler = null, homeHeaders = {}, probeOrigins = new Set()
const dirLog = [], challenged = []
// The account the sign-in host keeps in its own storage (its setup and sign-in
// pages write it): the certificate names it, so without one nothing is asked.
const ACCOUNT = 'alice@example.com'
const ctx = await browser.newContext()
await ctx.routeWebSocket(/.*/, (ws) => { sockets.push(ws.url()); ws.close() })
// Registered first, so it runs last: anything not routed below is refused and recorded.
await ctx.route('**/*', (route) => { refused.push(route.request().url()); return route.abort() })
await ctx.route(`${S}/**`, async (route) => {
  const r = route.request(), u = new URL(r.url())
  if (probeOrigins.has(S) && u.pathname === '/probe') return route.fulfill({ contentType: 'text/html', body: PROBE })
  const res = await handler(new Request(r.url(), { method: r.method() }))
  return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) })
})
const htmlFor = (origin) => (route) => {
  const u = new URL(route.request().url())
  if (u.pathname === '/probe') return route.fulfill({ contentType: 'text/html', body: PROBE })
  if (u.pathname === '/frame') return route.fulfill({ contentType: 'text/html', body: HOME_LIB('frame', `<iframe id=f src="${S}/" allow="publickey-credentials-get *; publickey-credentials-create *" width=500 height=500></iframe>`) })
  return route.fulfill({ headers: { 'content-type': 'text/html', ...(origin === HOME ? homeHeaders : {}) }, body: HOME_LIB(origin) })
}
await ctx.route(`${HOME}/**`, htmlFor(HOME))
await ctx.route(`${ATTACKER}/**`, htmlFor(ATTACKER))
await ctx.route('https://bento.page/**', htmlFor('https://bento.page'))
await ctx.route(`${DIR}/**`, async (route) => {
  const r = route.request(), u = new URL(r.url())
  const cors = { 'access-control-allow-origin': S, 'content-type': 'application/json' }
  if (r.method() !== 'POST') return route.fulfill({ status: 404, body: '' })
  if (u.pathname === '/v1/web/challenge') {
    challenged.push(JSON.parse(r.postData() || 'null')?.address)
    return route.fulfill({ headers: cors, body: JSON.stringify({ nonce: b64u(crypto.getRandomValues(new Uint8Array(24))), at: Date.now(), rosHash: b64u(crypto.getRandomValues(new Uint8Array(32))) }) })
  }
  if (u.pathname === '/v1/web/enrol') {
    const b = JSON.parse(r.postData())
    const v = await verifyAssertion(b.assertion, { publicKey: PK_PUB, challenge: await statementChallenge(b.text), rpId: 'id.bento.page', origins: [S] })
    const os = r.headers()['origin']
    const parts = b.text.split('.')
    dirLog.push({ os, rq: b.rq, verify: v.ok ? 'ok' : v.reason, kind: parts[0], W: parts[0] === 'wdev' ? parts[1] : null })
    if (os !== S || !v.ok) return route.fulfill({ status: 403, headers: cors, body: JSON.stringify({ ok: false }) })
    return route.fulfill({ headers: cors, body: JSON.stringify({ ok: true, wdev: b.text, watt: 'watt.' + parts[1] + '.countersigned' }) })
  }
  return route.fulfill({ status: 404, headers: cors, body: '{}' })
})

// Every page gets a virtual authenticator holding the person's passkey.
const authOf = new Map()
const popups = []
const attach = async (p) => {
  const c = await ctx.newCDPSession(p)
  await c.send('WebAuthn.enable')
  const { authenticatorId } = await c.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await c.send('WebAuthn.addCredential', { authenticatorId, credential: { credentialId: CRED_ID, isResidentCredential: true, rpId: 'id.bento.page', privateKey: PK_PKCS8, userHandle: USER.toString('base64'), signCount: 0 } })
  authOf.set(p, { c, authenticatorId })
}
const creds = async (p) => { const a = authOf.get(p); return (await a.c.send('WebAuthn.getCredentials', { authenticatorId: a.authenticatorId })).credentials.length }
// Records any Signal API call a page makes (CDP-injected, so the page's CSP does not apply).
await ctx.addInitScript(() => {
  window.__signals = []
  const P = window.PublicKeyCredential
  for (const m of ['signalAllAcceptedCredentials', 'signalUnknownCredential', 'signalCurrentUserDetails']) {
    if (P && typeof P[m] === 'function') { const f = P[m].bind(P); P[m] = (a) => { window.__signals.push(m); return f(a) } }
  }
})
ctx.on('page', (p) => { const ready = attach(p).catch((e) => console.log('  cdp', e.message)); popups.push({ p, ready }) })

const page = await ctx.newPage()
const sleep = (ms) => page.waitForTimeout(ms)
const until = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn().catch(() => undefined); if (v) return v; if (Date.now() - t > ms) return v; await sleep(40) } }
const lastPopup = async () => {
  await until(async () => popups.length > 0)
  const x = popups.pop(); await x.ready
  await x.p.waitForLoadState().catch(() => {})
  return x.p
}
const state = (p) => p.evaluate(() => [document.body.dataset.state, document.body.dataset.reason || '']).catch(() => ['closed', ''])
const settled = (p, not = ['loading']) => until(async () => { const s = await state(p); return !not.includes(s[0]) && s })
const msgs = () => page.evaluate(() => HM.msgs)
const keys = async () => {
  const W = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const kx = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  return { W, Wpub: b64u(await crypto.subtle.exportKey('raw', W.publicKey)), kxPub: b64u(await crypto.subtle.exportKey('raw', kx.publicKey)) }
}
const reset = async (mutant = null, hh = {}) => {
  handler = await site(mutant); homeHeaders = hh; dirLog.length = 0
  for (const x of ctx.pages()) if (x !== page) await x.close().catch(() => {})
  popups.length = 0
}
// Opens the sign-in host from `origin` the way bento/home does, and waits until it has settled.
const openFrom = async (origin, url, feat) => {
  await page.goto(origin + '/?r=' + Math.random())
  await page.evaluate(([u, f]) => HM.open(u, f), [url, feat])
  const p = await lastPopup()
  await settled(p)
  return p
}
const send = async (p, m) => { await page.evaluate((x) => HM.send(x), m); await settled(p, ['loading', 'waiting']) }
const approve = async (p) => { await p.click('#approve', { timeout: 3000 }); await settled(p, ['loading', 'waiting', 'consent', 'working']) }
const enrolMsg = (k, label = 'Chrome on MacBook') => ({ t: 'enrol', W: k.Wpub, kx: k.kxPub, label })
// The sign-in host's own storage, as its pages leave it (page.evaluate is not bound by the page's CSP).
const setAccount = async (a) => {
  const p = await ctx.newPage()
  await p.goto(S + '/')
  await p.evaluate((x) => { if (x) localStorage.setItem('bento-id-account', x); else localStorage.removeItem('bento-id-account') }, a)
  await p.close()
  const i = popups.findIndex((x) => x.p === p)
  if (i >= 0) popups.splice(i, 1)
}
handler = await site(null)
await setAccount(ACCOUNT)

try {
  // ---- P1: the round trip, the positive control for every row below ----------
  console.log('\nP1  bento/home asks, the person approves, the directory logs it')
  await reset()
  let k = await keys(), s0
  let pop = await openFrom(HOME)
  ok((await state(pop))[0] === 'waiting', 'the sign-in host waits for bento/home')
  const ready = (await msgs()).filter((m) => m.data?.t === 'ready')
  ok(ready.length === 1 && ready[0].origin === S && ready[0].fromPopup, `bento/home got one 'ready' from ${S}`)
  await send(pop, enrolMsg(k))
  ok((await state(pop))[0] === 'consent', 'the consent screen is shown')
  const consent = await pop.locator('[data-for=consent]').innerText()
  ok(consent.includes(HOME), 'it names the opener by its real origin')
  ok(consent.includes('Name chosen by bento/home') && consent.includes('Chrome on MacBook'), 'it shows the label as chosen by bento/home')
  ok(/Approve only if you just asked bento\/home to sign in/.test(consent), 'it says approve only if you just asked bento/home to sign in')
  ok(consent.includes('This page cannot check which device holds the key bento/home sent.'), 'it says it cannot check which device holds the key (the claim rows are in the engines rig)')
  await approve(pop)
  ok((await state(pop))[0] === 'done', 'the sign-in host finished')
  const got = (await msgs()).find((m) => m.data?.t === 'enrolled')
  ok(!!got && got.origin === S && got.fromPopup && got.data.wdev.split('.')[1] === k.Wpub, 'bento/home received enrolled, from the sign-in host, for its own key')
  ok(dirLog.length === 1 && dirLog[0].os === S && dirLog[0].rq === HOME && dirLog[0].verify === 'ok' && dirLog[0].W === k.Wpub,
    `the directory saw Origin ${S}, rq ${HOME}, and the kernel verifier accepted the assertion (${JSON.stringify(dirLog)})`)
  ok(challenged.length === 1 && challenged[0] === ACCOUNT && consent.includes(ACCOUNT),
    `the account comes from the sign-in host's own storage: shown, and the challenge is asked for it (${JSON.stringify(challenged)})`)
  await until(async () => pop.isClosed(), 3000)
  ok(pop.isClosed(), 'the window closed itself')

  console.log('\nP1  no account kept on the sign-in host')
  await reset(); challenged.length = 0
  await setAccount(null)
  pop = await openFrom(HOME)
  await send(pop, enrolMsg(await keys()))
  s0 = await state(pop)
  ok(s0[0] === 'no-account' && !(await pop.locator('#approve').isVisible()) && challenged.length === 0 && dirLog.length === 0,
    `nothing is shown to approve and nothing is asked of the directory (${s0})`)
  await setAccount(ACCOUNT)

  // ---- P2: a foreign opener ---------------------------------------------------
  const foreign = async (mutant) => {
    await reset(mutant); const k = await keys()
    const p = await openFrom(ATTACKER)
    const toOpener = (await msgs()).length
    await page.evaluate((x) => HM.send(x), enrolMsg(k)); await settled(p, ['loading', 'waiting'])
    const shown = (await state(p))[0] === 'consent'
    if (shown) await approve(p)
    return { toOpener, shown, s: await state(p), dir: dirLog.map((d) => [d.rq, d.verify]) }
  }
  console.log('\nP2  attacker.example opens the sign-in host')
  let r = await foreign()
  ok(r.toOpener === 0, 'no message reaches a foreign opener')
  ok(!r.shown && r.s[1] === 'wrong-origin' && r.dir.length === 0, `its request is refused, nothing is shown, the directory is untouched (${r.s})`)
  r = await foreign('foreign-opener')
  ok(r.shown && r.dir.some((d) => d[0] === ATTACKER && d[1] === 'ok'), `MUTANT foreign-opener: consent shown and the directory enrols the attacker's key (${JSON.stringify(r.dir)})`)

  // ---- P3: the opener navigates away before the reply --------------------------
  const away = async (mutant) => {
    await reset(mutant); const k = await keys()
    const p = await openFrom(HOME)
    await send(p, enrolMsg(k))
    await page.evaluate((u) => { location.href = u }, ATTACKER + '/'); await page.waitForURL(ATTACKER + '/')
    const alive = await p.evaluate(() => !!window.opener && !window.opener.closed)
    await approve(p)
    return { alive, got: (await msgs()).filter((m) => m.data?.t === 'enrolled'), dir: dirLog.length }
  }
  console.log('\nP3  bento/home\'s window goes to attacker.example while the person approves')
  r = await away()
  ok(r.alive && r.dir === 1, 'the opener is still there and the enrolment completed (the reply is the only thing being tested)')
  ok(r.got.length === 0, 'the reply is not delivered to the new origin')
  r = await away('reply-star')
  ok(r.got.length > 0, `MUTANT reply-star: attacker.example receives wdev. and watt. (${r.got.length})`)

  // ---- P4: noopener --------------------------------------------------------------
  const noopen = async (mutant) => {
    await reset(mutant)
    await page.goto(HOME + '/?r=' + Math.random())
    await page.evaluate(() => HM.open(undefined, 'noopener'))
    const p = await lastPopup(); await settled(p); return state(p)
  }
  console.log('\nP4  opened with noopener')
  let s = await noopen()
  ok(s[0] === 'refused' && s[1] === 'no-opener', `the sign-in host refuses and waits for nothing (${s})`)
  s = await noopen('noopener')
  ok(!(s[0] === 'refused' && s[1] === 'no-opener'), `MUTANT noopener: the page carries on without an opener (${s})`)

  // ---- P5: requests that are not the one shape ----------------------------------
  console.log('\nP5  the opener asks for anything but the one enrol request')
  const asks = async (mutant) => {
    const k = await keys()
    const tries = [
      { t: 'roster-add', W: k.Wpub, kx: k.kxPub, label: 'backup key', cred: 'ATTACKER-PASSKEY' },
      { t: 'roster-remove', member: 'P1' },
      { t: 'delete-account' },
      { t: 'sign-out-everywhere' },
      { t: 'enrol', W: k.Wpub, kx: k.kxPub, label: 'x', account: 'bob@example.com' },
      { t: 'enrol', W: k.Wpub, kx: k.kxPub, label: 'x', rq: HOME },
      { t: 'enrol', W: k.kxPub.slice(0, 80), kx: k.kxPub, label: 'x' },
      'enrol', ['enrol'], null,
    ]
    const out = []
    for (const m of tries) {
      await reset(mutant)
      const p = await openFrom(HOME)
      await send(p, m)
      const st = await state(p)
      if (st[0] === 'consent') await approve(p)
      out.push({ m: JSON.stringify(m).slice(0, 48), st, dir: dirLog.map((d) => d.kind) })
    }
    return out
  }
  for (const x of await asks()) ok(x.st[0] === 'refused' && x.dir.length === 0, `${x.m}: refused (${x.st[1]}), nothing reaches the directory`)
  const mut = await asks('any-request')
  ok(mut.some((x) => x.dir.includes('ros')), `MUTANT any-request: an opener-requested roster change is signed and reaches the directory (${JSON.stringify(mut.filter((x) => x.dir.length).map((x) => [x.m, x.dir]))})`)

  console.log('\nP5  one request per window')
  await reset(); k = await keys(); const k2 = await keys()
  pop = await openFrom(HOME)
  await send(pop, enrolMsg(k, 'one'))
  await page.evaluate((x) => HM.send(x), enrolMsg(k2, 'two')); await settled(pop, ['loading', 'waiting', 'consent'])
  s = await state(pop)
  ok(s[0] === 'refused' && s[1] === 'one-request-per-window', `a second request voids the window (${s})`)
  ok(!(await pop.locator('#approve').isVisible()) && dirLog.length === 0, 'and neither request can be approved')

  // ---- P5: the Signal API on the opener's say-so ----------------------------------
  console.log('\nP5  the opener asks for a Signal API call')
  const signal = async (mutant) => {
    await reset(mutant)
    const p = await openFrom(HOME)
    const before = await creds(p)
    await page.evaluate((x) => HM.send(x), { t: 'signal', userId: USER.toString('base64url') })
    await settled(p, ['loading', 'waiting']); await sleep(200)
    return { before, after: await creds(p), calls: await p.evaluate(() => window.__signals), s: await state(p) }
  }
  r = await signal()
  ok(r.calls.length === 0 && r.before === 1 && r.after === 1 && r.s[0] === 'refused', `refused: no Signal call, the passkey is still there (calls ${r.calls.length}, passkeys ${r.before} -> ${r.after})`)
  r = await signal('signal')
  ok(r.calls.length > 0 || r.after < r.before, `MUTANT signal: the page calls the Signal API (calls ${JSON.stringify(r.calls)}, passkeys ${r.before} -> ${r.after})`)

  // ---- P6: nothing from the URL ----------------------------------------------------
  console.log('\nP6  a request in the URL')
  const viaUrl = async (mutant) => {
    await reset(mutant); const k = await keys()
    const q = `t=enrol&W=${k.Wpub}&kx=${k.kxPub}&label=evil`
    const out = []
    for (const u of [`${S}/?${q}`, `${S}/#${q}`]) { const p = await openFrom(HOME, u); out.push((await state(p))[0]); await p.close() }
    const p = await openFrom(HOME)
    await page.evaluate((u) => { HM.w.location = u }, `${S}/?${q}&roster=remove-all`)
    await until(async () => p.url().includes('roster=')); await settled(p)
    out.push((await state(p))[0])
    return out
  }
  let u = await viaUrl()
  ok(u.every((x) => x === 'waiting'), `query, fragment, and the opener re-pointing the popup: no consent, no action (${u})`)
  u = await viaUrl('url-params')
  ok(u.some((x) => x === 'consent'), `MUTANT url-params: a consent screen built from the URL (${u})`)

  // ---- P7: COOP --------------------------------------------------------------------
  console.log('\nP7  Cross-Origin-Opener-Policy')
  const coop = async (mutant, hh) => {
    await reset(mutant, hh)
    await page.goto(HOME + '/?coop=' + Math.random())
    await page.evaluate(() => HM.open())
    const p = await lastPopup(); await settled(p)
    return { s: await state(p), ready: (await msgs()).filter((m) => m.data?.t === 'ready').length }
  }
  r = await coop(null, { 'cross-origin-opener-policy': 'same-origin-allow-popups' })
  ok(r.s[0] === 'waiting' && r.ready === 1, `bento/home sending same-origin-allow-popups keeps the protocol working (${r.s}, ready ${r.ready})`)
  r = await coop(null, { 'cross-origin-opener-policy': 'same-origin' })
  ok(r.ready === 0, `bento/home sending same-origin severs it (${r.s}, ready ${r.ready}): why home may send at most same-origin-allow-popups`)
  r = await coop('coop')
  ok(r.ready === 0 && r.s[1] === 'no-opener', `MUTANT coop: the sign-in host sending same-origin severs it (${r.s}, ready ${r.ready})`)

  // ---- framing --------------------------------------------------------------------
  console.log('\nG9\'.3  framing')
  const framed = async (mutant, from) => {
    await reset(mutant)
    await page.goto(from + '/frame'); await sleep(600)
    const f = page.frames().find((x) => x !== page.mainFrame())
    const st = f ? await f.evaluate(() => document.body?.dataset?.state || 'no-state').catch(() => 'not rendered') : 'no frame'
    return { url: f?.url(), st }
  }
  for (const from of [HOME, ATTACKER]) {
    r = await framed(null, from)
    ok(r.st === 'not rendered' || r.st === 'no-state', `${from} frames the sign-in host: not rendered (${r.url}, ${r.st})`)
  }
  r = await framed('framed', HOME)
  ok(['refused', 'waiting', 'consent', 'loading'].includes(r.st), `MUTANT framed: the sign-in host renders inside bento/home (${r.st})`)

  // Labels and the consent screen's claims run in every engine, WebKit
  // included: scripts/test-signin-host-engines.mjs.

  // ---- H1: a hostile bento/home, the sign-in host honest ------------------------------
  console.log('\nH1  a hostile bento/home substitutes a key it also holds')
  await reset(); const honestK = await keys()
  pop = await openFrom(HOME); await send(pop, enrolMsg(honestK)); const honestText = await pop.locator('[data-for=consent]').innerText()
  await reset(); const hostile = await keys()
  const offPage = await crypto.subtle.exportKey('jwk', hostile.W.privateKey)
  pop = await openFrom(HOME); await send(pop, enrolMsg(hostile)); const hostileText = await pop.locator('[data-for=consent]').innerText()
  await approve(pop)
  ok(dirLog.length === 1 && dirLog[0].W === hostile.Wpub && dirLog[0].rq === HOME, 'the substituted key is enrolled after one approval (recorded: the bound in security\'s R1′, not a defect of this page)')
  const fp = (t) => t.replace(/Key fingerprint\s*\n?\s*[0-9a-f]{4} [0-9a-f]{4}/, 'Key fingerprint <fp>')
  ok(fp(honestText) === fp(hostileText), 'the honest and hostile screens differ only in the fingerprint (so the screen certifies the origin and nothing about the key)')
  const signer = await crypto.subtle.importKey('jwk', offPage, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const stmt = new TextEncoder().encode('inv.room42.attacker.' + Date.now())
  const verifier = await crypto.subtle.importKey('raw', Buffer.from(dirLog[0].W, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer, stmt), stmt),
    'the off-page copy signs under the enrolled key (why the label is "(passkey sign-in)" and the 7-day bound holds)')

  // ---- G9′: who can use rp id.bento.page --------------------------------------------
  console.log('\nG9′  rp id.bento.page from each origin (a plain page, no sign-in host code)')
  await reset()
  probeOrigins = new Set([S])
  for (const origin of [S, HOME, 'https://bento.page', ATTACKER]) {
    const p = await ctx.newPage(); await popups.pop()?.ready
    await p.goto(origin + '/probe')
    const before = await creds(p)
    const out = await p.evaluate(() => window.probe())
    const after = await creds(p)
    if (origin === S) {
      ok(out.get === 'OK', `${origin}: get works (the positive control for the refusals below) ${JSON.stringify(out)}`)
    } else {
      const sigs = ['signalAllAcceptedCredentials', 'signalUnknownCredential', 'signalCurrentUserDetails']
      ok(out.create === 'SecurityError' && out.get === 'SecurityError', `${origin}: create and get refused (${out.create}, ${out.get})`)
      ok(sigs.every((m) => out[m] === 'SecurityError' || out[m] === 'absent') && after === before,
        `${origin}: every Signal API call refused, passkeys ${before} -> ${after} (${sigs.map((m) => out[m]).join(', ')})`)
    }
    await p.close()
  }
  probeOrigins = new Set()

  console.log('\nisolation')
  ok(sockets.length === 0, `no WebSocket was opened (${sockets.length})`)
  const stray = refused.filter((x) => !x.endsWith('/favicon.ico'))
  ok(stray.length === 0, `nothing was fetched outside the routed origins (${JSON.stringify(stray.slice(0, 3))})`)
} finally {
  await browser.close()
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
