// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The sign-in host's OWN pages (server/signin/public: /setup, /reset, /account)
// in a real browser: a mailed setup link completed with a new passkey, sign-in
// on the host, a reset link completed, and sign out everywhere.
//
//   node scripts/test-signin-host-pages.mjs            # Playwright's headless shell, a CDP virtual authenticator
//   node scripts/test-signin-host-pages.mjs --chrome   # the installed Google Chrome, the same rows
//   node scripts/test-signin-host-pages.mjs --webkit   # WebKit: the rows that need no passkey
//
// https://signin.id.bento.page is the REAL worker and files; https://id.bento.page
// is the REAL directory worker and Roster object (server/directory/src) in this
// process, against an in-memory store, for every route it has (challenge,
// setup/start, setup, reset/start, reset), plus the contract stub
// scripts/lib/id-signin-directory-stub.mjs for the routes it does not have yet
// (/v1/web/signin*, /v1/web/signout*), which reads the real object's storage.
// Mailed links are taken from the directory's own mail. https://home.bento.page
// is an opener page. Every other request is refused and every WebSocket is
// closed; the rig fails if one was opened.
//
// Each rule has a row and a MUTANT: a copy of server/signin/ with one edit that
// breaks it, under which a row must go red. A mutant whose edit no longer
// applies fails the rig.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { siteHandler } from '../server/signin/local.mjs'
import { signinDirectory } from './lib/id-signin-directory-stub.mjs'
import { parseRos } from '../kernel/src/roster.ts'

const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const CHROME = process.argv.includes('--chrome'), WEBKIT = process.argv.includes('--webkit')
const PASSKEYS = !WEBKIT
const ROOT = fileURLToPath(new URL('../server/signin/', import.meta.url))
const S = 'https://signin.id.bento.page', DIR = 'https://id.bento.page', HOME = 'https://home.bento.page', ATTACKER = 'https://attacker.example'

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }
const info = (m) => console.log(`  info  ${m}`)

// ---- the sign-in host, honest or with one rule broken -------------------------------
const MUTANTS = {
  // the fragment stays in the address bar and the history entry
  'keep-fragment': [['public/link.js', "  history.replaceState(null, '', location.pathname)\n", '']],
  // opening the link acts by itself
  'act-on-open': [['public/link.js', "  show('ready')\n}\n\nstart()", "  show('ready')\n  makePasskey()\n}\n\nstart()"]],
  // any keys accepted beside v, e and t
  'loose-link': [['public/link.js', "  if (keys.length !== 3 || new Set(keys).size !== 3 || !['v', 'e', 't'].every((k) => f.has(k))) return null\n", "  if (!['v', 'e', 't'].every((k) => f.has(k))) return null\n"]],
  // the account remembered from the link, before anything is proved (security-ruling-948)
  'store-early': [['public/link.js', 'const link = readLink()\n', "const link = readLink()\nif (link) localStorage.setItem('bento-id-account', link.address)\n"]],
  // the directory's answer stored whatever account it names
  'no-expect': [['public/account-client.js', "  if (expect !== undefined && a.address !== expect) throw new Refused('other-account')\n", '']],
  // a 32-byte challenge accepted as a raw one (it could be a statement's hash)
  'any-nonce': [['public/account-client.js', 'const SEALED = /^[A-Za-z0-9_-]{54}$/', 'const SEALED = /^[A-Za-z0-9_-]{43,54}$/']],
  // one user handle per account: a new passkey overwrites the old one on the same authenticator
  'fixed-handle': [['public/account-client.js', '  const out = new Uint8Array(48)\n  out.set(h, 0)\n  out.set(crypto.getRandomValues(new Uint8Array(16)), 32)\n  return out\n', '  return h\n']],
  // a reset that signs in and remembers the account
  'reset-remembers': [['public/link.js', "      $('ripens').textContent = when(r.body.ripensAt)\n", "      localStorage.setItem('bento-id-account', link.address)\n      $('ripens').textContent = when(r.body.ripensAt)\n"]],
  // the account page acting on a message (an opener asking for a sign-out)
  'listen': [['public/account.js', 'function start() {\n', "function start() {\n  addEventListener('message', (e) => { if (e.data && e.data.t === 'sign-out-everywhere') signOutAll() })\n"]],
  // the address through an HTML sink
  'markup': [['public/link.js', '  for (const el of document.querySelectorAll(\'[data-address]\')) el.textContent = link.address\n', '  for (const el of document.querySelectorAll(\'[data-address]\')) el.insertAdjacentHTML(\'beforeend\', link.address)\n']],
  // Trusted Types off
  'no-tt': [['src/worker.js', `  "require-trusted-types-for 'script'",\n`, '']],
  // the 501 the directory answers until it can sign browsers out, taken for any other refusal (after a passkey prompt for nothing)
  'no-501': [['public/account-client.js', "  if (c.status === 501) throw new Refused('not-implemented')\n", '']],
  // framing allowed
  'framed': [['src/worker.js', '  "frame-ancestors \'none\'",\n', ''], ['src/worker.js', "  'x-frame-options': 'DENY',\n", '']],
}
const tmp = mkdtempSync(join(tmpdir(), 'signin-pages-'))
let tagN = 0
async function site(mutant) {
  if (!mutant) return siteHandler(ROOT)
  const dir = join(tmp, mutant + ++tagN)
  cpSync(ROOT, dir, { recursive: true })
  for (const [file, from, to] of MUTANTS[mutant]) {
    const f = join(dir, file), text = readFileSync(f, 'utf8')
    const n = text.split(from).length - 1
    if (n !== 1) throw new Error(`mutant ${mutant}: its edit occurs ${n} times in ${file}, not once; update the mutant`)
    writeFileSync(f, text.replace(from, () => to))
  }
  return siteHandler(dir, 'p' + tagN)
}

// ---- the directory: the real worker and object, and the stub beside them ---------------
const dirMod = await import('../server/directory/src/worker.js')
function namespace(Klass, env) {
  const objs = new Map()
  return {
    objs,
    idFromName: (n) => n,
    get(id) {
      if (!objs.has(id)) {
        const store = new Map()
        const state = { storage: {
          async get(k) { return structuredClone(store.get(k)) },
          async put(k, v) { store.set(k, structuredClone(v)) },
          async delete(k) { for (const x of [].concat(k)) store.delete(x) },
          async list(o = {}) {
            const all = [...store].filter(([k]) => !o.prefix || k.startsWith(o.prefix)).sort(([a], [b]) => (a < b ? -1 : 1))
            return new Map(all.slice(0, o.limit ?? all.length).map(([k, v]) => [k, structuredClone(v)]))
          },
          async setAlarm() {}, async getAlarm() { return null },
        } }
        objs.set(id, { obj: new Klass(state, env), store })
      }
      const { obj } = objs.get(id)
      return { fetch: (u, init) => obj.fetch(u instanceof Request ? u : new Request(u, init)) }
    },
  }
}
const dirKp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const DIR_KEY_JWK = JSON.stringify(await crypto.subtle.exportKey('jwk', dirKp.privateKey))
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const storageName = async (address) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bento-dir/1/addr\n' + address)))

/** A fresh directory: { handler, mails, stub, store(address) }. */
function world() {
  const mails = []
  const env = { DIR_KID: 'dir-1', DIR_KEY_JWK, CHALLENGE_KEY: 'k'.repeat(48), MAILER: { send: (m) => { mails.push(m) } } }
  env.ROSTER = namespace(dirMod.Roster, env)
  env.LEDGER = namespace(dirMod.Ledger, env)
  const raw = (key) => env.ROSTER.objs.get(key)?.store
  const stub = signinDirectory({
    mail: (m) => mails.push(m),
    async accounts(key) {
      const st = raw(key)
      const head = st && st.get('head')
      if (!head) return null
      return {
        address: (await parseRos(head.ros)).value.address,
        members: head.members,
        credential(id) { const pub = st.get(`cid:${id}`); const rec = pub && st.get(`pk:${pub}`); return rec ? { pub, signCount: rec.signCount } : null },
        setCount(pub, n) { st.set(`pk:${pub}`, { ...st.get(`pk:${pub}`), signCount: n }) },
      }
    },
  })
  return {
    mails, stub, env,
    handler: (req) => dirMod.default.fetch(req, env),
    async store(address) { return raw(await storageName(address)) },
  }
}
const linkIn = (mails, kind, to) => {
  for (const m of [...mails].reverse()) {
    if (m.to !== to) continue
    const hit = String(m.body || m.text || '').match(new RegExp(`${S.replace(/\./g, '\\.')}/${kind}#[^\\s]+`))
    if (hit) return hit[0]
  }
  return null
}

// ---- the browser ---------------------------------------------------------------------
const type = WEBKIT ? pw.webkit : pw.chromium
const browser = await type.launch({ headless: true, ...(CHROME ? { channel: 'chrome' } : {}) })
console.log(`${WEBKIT ? 'WebKit' : CHROME ? 'Google Chrome' : 'Playwright headless shell'} ${browser.version()}${PASSKEYS ? ', CDP virtual authenticator' : ', no authenticator (passkey rows run in the Chromium engines)'}`)

let handler = null, W = null, twist = null
const sockets = [], stray = [], dirReqs = []
const ctx = await browser.newContext()
await ctx.routeWebSocket(/.*/, (ws) => { sockets.push(ws.url()); ws.close() })
await ctx.route('**/*', (route) => { stray.push(route.request().url()); return route.abort() })
await ctx.route(`${S}/**`, async (route) => {
  const res = await handler(new Request(route.request().url(), { method: route.request().method() }))
  return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) })
})
const OPENER = `<!doctype html><meta charset=utf-8><title>opener</title><script>
window.HM = { w: null, open(u) { this.w = window.open(u, 'acct' + Math.random(), 'popup,width=480,height=640'); return !!this.w }, send(m) { this.w.postMessage(m, '${S}') } }
</script>`
for (const o of [HOME, ATTACKER]) {
  await ctx.route(`${o}/**`, (route) => {
    const u = new URL(route.request().url())
    if (u.pathname === '/frame') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><iframe id=f src="${S}/account" width=400 height=400></iframe>` })
    return route.fulfill({ contentType: 'text/html', body: OPENER })
  })
}
await ctx.route(`${DIR}/**`, async (route) => {
  const r = route.request(), u = new URL(r.url())
  const origin = r.headers()['origin'] || ''
  dirReqs.push({ method: r.method(), path: u.pathname, origin })
  const cors = { 'access-control-allow-origin': S, vary: 'Origin', 'content-type': 'application/json' }
  if (u.pathname.startsWith('/v1/web/signin') || u.pathname.startsWith('/v1/web/signout')) {
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST' } })
    let body = null
    try { body = JSON.parse(r.postData() || 'null') } catch {}
    let [status, out] = (await W.stub.handle(u.pathname, { origin, body })) || [404, { error: 'not-found' }]
    if (twist === 'short-nonce' && u.pathname === '/v1/web/signin/challenge') out = { nonce: Buffer.alloc(32, 1).toString('base64url') }
    if (twist === 'other-address' && u.pathname === '/v1/web/signin' && status === 200) out = { address: 'mallory@example.com' }
    if (twist === 'not-yet' && u.pathname === '/v1/web/signout/challenge') { status = 501; out = { error: 'not-implemented' } }
    return route.fulfill({ status, headers: cors, body: JSON.stringify(out) })
  }
  const res = await W.handler(new Request(r.url(), { method: r.method(), headers: { ...(origin ? { origin } : {}), 'content-type': 'text/plain' }, body: ['GET', 'HEAD'].includes(r.method()) ? undefined : r.postData() || '' }))
  return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) })
})
// Counts WebAuthn calls and any Signal API call (CDP-injected, so the page's CSP does not apply).
await ctx.addInitScript(() => {
  window.__calls = { get: 0, create: 0, signal: 0 }
  const c = navigator.credentials
  if (c) {
    const g = c.get.bind(c), k = c.create.bind(c)
    c.get = (o) => { window.__calls.get++; return g(o) }
    c.create = (o) => { window.__calls.create++; return k(o) }
  }
  const P = window.PublicKeyCredential
  for (const m of ['signalAllAcceptedCredentials', 'signalUnknownCredential', 'signalCurrentUserDetails']) {
    if (P && typeof P[m] === 'function') { const f = P[m].bind(P); P[m] = (a) => { window.__calls.signal++; return f(a) } }
  }
})
const signals = []
const auths = new Map()
async function authenticator(p) {
  if (!PASSKEYS) return null
  if (auths.has(p)) return auths.get(p)
  const c = await ctx.newCDPSession(p)
  await c.send('WebAuthn.enable')
  const { authenticatorId } = await c.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  const a = {
    creds: async () => (await c.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
    add: (credential) => c.send('WebAuthn.addCredential', { authenticatorId, credential }),
  }
  auths.set(p, a)
  return a
}
// Each page starts with this host's storage empty (the context is shared across rows).
const fresh = async () => {
  const p = await ctx.newPage(); await authenticator(p)
  await p.goto(`${S}/signin.css`); await p.evaluate(() => localStorage.clear())
  return p
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 6000) => { const t = Date.now(); for (;;) { const v = await fn().catch(() => undefined); if (v) return v; if (Date.now() - t > ms) return v; await sleep(40) } }
const state = (p) => p.evaluate(() => [document.body.dataset.state, document.body.dataset.reason || '']).catch(() => ['closed', ''])
const settled = (p, not = ['loading']) => until(async () => { const s = await state(p); return !not.includes(s[0]) && s })
const stored = (p) => p.evaluate(() => localStorage.getItem('bento-id-account'))
const plant = (p, v) => p.evaluate((x) => { if (x === null) localStorage.removeItem('bento-id-account'); else localStorage.setItem('bento-id-account', x) }, v)
const calls = async (p) => { const c = await p.evaluate(() => window.__calls).catch(() => null); if (c) signals.push(c.signal); return c }
const click = async (p, sel, not) => { await p.click(sel, { timeout: 4000 }); return settled(p, not) }
const reset = async (mutant = null) => {
  handler = await site(mutant); W = world(); twist = null; dirReqs.length = 0
  for (const x of ctx.pages()) await x.close().catch(() => {})
  auths.clear()
}
let addrN = 0
const addr = (tag) => `${tag}-${++addrN}@example.com`
/** A real mailed link: the directory's own setup or reset mail for `email`. */
async function mailedLink(kind, email) {
  const r = await W.handler(new Request(`${DIR}/v1/roster/${kind}/start`, { method: 'POST', body: JSON.stringify({ email }) }))
  if (r.status !== 202) throw new Error(`${kind}/start: ${r.status}`)
  return linkIn(W.mails, kind, email)
}
const token = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
/** Completes a setup through the page; answers { p, email }. */
async function setUp(p, email) {
  await p.goto(await mailedLink('setup', email)); await settled(p)
  await click(p, '#make', ['loading', 'ready', 'working'])
  await click(p, '#confirm', ['loading', 'confirm', 'working'])
  return state(p)
}

try {
  // ---- L: what a link page does on open, and the fragment rules (every engine) ----------
  console.log('\nL   opening a mailed link')
  const openLink = async (mutant, frag, path = '/setup', query = '') => {
    await reset(mutant)
    const p = await fresh()
    const email = addr('open')
    await p.goto(`${S}${path}${query}#${frag ?? `v=1&e=${encodeURIComponent(email)}&t=${token()}`}`); await settled(p); await sleep(150)
    return { p, email, s: await state(p), href: await p.evaluate(() => location.href), reqs: dirReqs.length, st: await stored(p), text: await p.locator('body').innerText() }
  }
  let r = await openLink()
  ok(r.s[0] === 'ready', `a setup link opens ready (${r.s})`)
  ok(r.reqs === 0, `opening it sends nothing to the directory (${r.reqs} requests)`)
  ok(r.href === `${S}/setup`, `the token is out of the address bar and the history entry (${r.href})`)
  ok(r.text.includes(r.email) && r.st === null, 'the address is shown, and nothing is stored')
  ok(r.text.includes('Documents shared with you are opened by keys kept in this browser.'), 'X3: the setup page states what a browser-only account loses')
  ok(r.text.includes(`You are making a passkey for ${r.email}. Only continue if that is your email address and you asked for this link just now.`), 'the address is the decision: continue only if it is yours (account fixation)')
  ok(!/recovery code:|write (this|it) down|\b[A-Z0-9]{4}(-[A-Z0-9]{4}){3,}\b/i.test(r.text), 'X7: the page shows no code')
  r = await openLink('keep-fragment')
  ok(r.href !== `${S}/setup`, `MUTANT keep-fragment: the token stays in the address bar (${r.href.slice(0, 60)})`)
  r = await openLink('act-on-open')
  ok(r.reqs > 0 || r.s[0] !== 'ready', `MUTANT act-on-open: opening the link reaches the directory (${r.reqs} requests, ${r.s})`)
  r = await openLink(null, undefined, '/reset')
  ok(r.s[0] === 'ready' && r.reqs === 0 && r.href === `${S}/reset` && r.text.includes('72 hours'), `a reset link: ready, nothing sent, token removed (${r.s}, ${r.reqs})`)

  console.log('\nL   a link that is not exactly v, e and t is refused, and nothing is sent or stored')
  const good = (e) => `v=1&e=${encodeURIComponent(e)}&t=${token()}`
  const BADLINKS = [
    ['an extra key', (e) => good(e) + '&account=mallory%40example.com'],
    ['no token', (e) => `v=1&e=${encodeURIComponent(e)}`],
    ['a repeated address', (e) => good(e) + `&e=mallory%40example.com`],
    ['version 2', (e) => good(e).replace('v=1', 'v=2')],
    ['a short token', (e) => `v=1&e=${encodeURIComponent(e)}&t=${token().slice(0, 40)}`],
    ['an address with spaces', () => `v=1&e=a%20b%40example.com&t=${token()}`],
    ['an address that is not ASCII', () => `v=1&e=${encodeURIComponent(String.fromCodePoint(0x430) + 'lice@example.com')}&t=${token()}`],
    ['empty', () => ''],
  ]
  const badRuns = async (mutant) => {
    const out = []
    for (const [name, f] of BADLINKS) {
      const x = await openLink(mutant, f(`bad${addrN}@example.com`))
      out.push({ name, s: x.s, reqs: x.reqs, st: x.st, href: x.href })
    }
    const q = await openLink(mutant, undefined, '/setup', '?t=enrol')
    out.push({ name: 'a query string beside the fragment', s: q.s, reqs: q.reqs, st: q.st, href: q.href })
    return out
  }
  for (const x of await badRuns()) ok(x.s[0] === 'refused' && x.s[1] === 'bad-link' && x.reqs === 0 && x.st === null && x.href === `${S}/setup`, `${x.name}: refused, nothing sent or stored, the URL cleaned (${x.s}, ${x.href})`)
  const loose = await badRuns('loose-link')
  ok(loose.some((x) => x.s[0] === 'ready'), `MUTANT loose-link: a link with other keys opens ready (${loose.filter((x) => x.s[0] === 'ready').map((x) => x.name)})`)

  console.log('\nL   an address full of markup is shown as text')
  const markupAddr = '<img/src=x/onerror=alert(1)>"@example.com'
  r = await openLink(null, `v=1&e=${encodeURIComponent(markupAddr)}&t=${token()}`)
  const asText = await r.p.evaluate(() => [...document.querySelectorAll('[data-address]')].map((e) => [e.textContent, e.children.length]))
  ok(r.s[0] === 'ready' && asText.length > 0 && asText.every(([t, n]) => t === markupAddr && n === 0), `shown exactly, as text (${JSON.stringify(asText[0])})`)
  r = await openLink('markup', `v=1&e=${encodeURIComponent(markupAddr)}&t=${token()}`)
  const asHtml = await r.p.evaluate(() => [...document.querySelectorAll('[data-address]')].map((e) => [e.textContent, e.children.length])).catch(() => [])
  ok(r.s[0] !== 'ready' || asHtml.some(([t, n]) => n > 0 || t !== markupAddr), `MUTANT markup: the address goes through an HTML sink (Trusted Types throws, or it renders) (${r.s}, ${JSON.stringify(asHtml[0])})`)

  console.log('\nL   Trusted Types and framing, on the account page')
  const tt = async (mutant) => {
    await reset(mutant); const p = await fresh(); await p.goto(`${S}/account`); await settled(p)
    return p.evaluate(() => { try { document.body.insertAdjacentHTML('beforeend', '<b id=tt>x</b>'); return 'assigned' } catch (e) { return e.name } })
  }
  const ttHonest = await tt()
  if (WEBKIT && ttHonest === 'assigned') info(`WebKit ${browser.version()} does not enforce Trusted Types here (the header is sent; the Chromium engines check it)`)
  else {
    ok(ttHonest === 'TypeError', `a string into an HTML sink is refused (${ttHonest})`)
    const ttm = await tt('no-tt')
    ok(ttm === 'assigned', `MUTANT no-tt: the sink takes the string (${ttm})`)
  }
  const framed = async (mutant) => {
    await reset(mutant); const p = await fresh(); await p.goto(`${ATTACKER}/frame`); await sleep(700)
    const f = p.frames().find((x) => x !== p.mainFrame())
    return f ? await f.evaluate(() => document.body?.dataset?.state || 'no-state').catch(() => 'not rendered') : 'no frame'
  }
  let fr = await framed()
  ok(fr === 'not rendered' || fr === 'no-state', `attacker.example frames /account: not rendered (${fr})`)
  fr = await framed('framed')
  ok(['signed-out', 'signed-in', 'loading'].includes(fr), `MUTANT framed: /account renders inside attacker.example (${fr})`)

  console.log('\nA   the account page, no passkey needed')
  const acct = async (mutant, plantAs, hash = '') => {
    await reset(mutant); const p = await fresh()
    await p.goto(`${S}/account`); await settled(p); await plant(p, plantAs)
    await p.goto('about:blank'); await p.goto(`${S}/account${hash}`); await settled(p)
    return { p, s: await state(p), text: await p.locator('body').innerText(), shown: await p.locator('#account').textContent() }
  }
  let a = await acct(null, null)
  ok(a.s[0] === 'signed-out' && (await a.p.locator('#signout-ask').isVisible()) === false, `with no account here: sign-in, setup and reset; no sign-out (${a.s})`)
  a = await acct(null, 'alice@example.com', '#account=mallory%40example.com&t=signout')
  ok(a.s[0] === 'signed-in' && a.shown === 'alice@example.com', `the stored account is shown, and the URL changes nothing (${a.s}, ${a.shown})`)
  a = await acct(null, '<b>x</b>@example.com')
  ok(a.shown === '<b>x</b>@example.com' && (await a.p.locator('#account b').count()) === 0, 'a stored account with markup is shown as text')

  console.log('\nA   an opener asking the account page for a sign-out gets nothing')
  const asked = async (mutant) => {
    await reset(mutant)
    const home = await fresh(); await home.goto(`${S}/account`); await settled(home); await plant(home, 'alice@example.com')
    await home.goto(HOME + '/')
    const popP = ctx.waitForEvent('page')
    await home.evaluate((u) => HM.open(u), `${S}/account`)
    const pop = await popP; await authenticator(pop); await pop.waitForLoadState(); await settled(pop)
    const before = await state(pop)
    for (const m of [{ t: 'sign-out-everywhere' }, { t: 'signout', address: 'alice@example.com' }, 'sign-out-everywhere']) await home.evaluate((x) => HM.send(x), m)
    await sleep(600)
    return { before, after: await state(pop), reqs: dirReqs.filter((d) => d.path.startsWith('/v1/web/signout')).length, c: await calls(pop) }
  }
  r = await asked()
  ok(r.before[0] === 'signed-in' && r.after[0] === 'signed-in' && r.reqs === 0 && r.c?.get === 0, `nothing happens: no request, no passkey prompt (${r.after}, ${r.reqs} requests)`)
  r = await asked('listen')
  ok(r.reqs > 0 || r.c?.get > 0 || r.after[0] !== 'signed-in', `MUTANT listen: the opener's message starts a sign-out (${r.reqs} requests, get ${r.c?.get}, ${r.after})`)

  if (PASSKEYS) {
    // ---- 1. setup, through the real directory ----------------------------------------
    console.log('\n1   a mailed setup link completed with a new passkey, then confirmed by a sign-in')
    await reset()
    let p = await fresh(); let auth = auths.get(p)
    const alice = addr('alice')
    await p.goto(await mailedLink('setup', alice)); await settled(p)
    let s = await click(p, '#make', ['loading', 'ready', 'working'])
    let st = await W.store(alice)
    let creds = await auth.creds()
    const head = st && st.get('head')
    ok(s[0] === 'confirm' && !!head && head.seq === 0 && head.members.length === 1 && creds.length === 1, `the directory set the account up with the new passkey (${s}, ${head?.members.length} member, ${creds.length} credential)`)
    ok(creds[0] && st.get(`cid:${Buffer.from(creds[0].credentialId, 'base64').toString('base64url')}`) === head.members[0].pub, 'its one member is the credential this browser just made')
    const uh = creds[0] ? Buffer.from(creds[0].userHandle, 'base64') : Buffer.alloc(0)
    ok(uh.length === 48 && hex(uh.subarray(0, 32)) === (await storageName(alice)), `the passkey's user handle is the account's storage name plus 16 random bytes (${uh.length} bytes)`)
    ok((await stored(p)) === null, 'nothing is stored before the sign-in confirms it')
    s = await click(p, '#confirm', ['loading', 'confirm', 'working'])
    ok(s[0] === 'done' && (await stored(p)) === alice && (await p.locator('#done-account').textContent()) === alice, `confirmed: the account the directory named is stored (${s}, ${await stored(p)})`)
    let c = await calls(p)
    ok(c.create === 1 && c.get === 1, `one create and one get (${JSON.stringify(c)})`)
    ok(W.mails.some((m) => m.to === alice && /set up/i.test(m.subject || '')), 'the directory mailed its setup notice')

    console.log('\n1   a link the directory refuses stores nothing')
    const refused = async (mutant) => {
      await reset(mutant); const p = await fresh(); const e = addr('nolink')
      await mailedLink('setup', e) // a real link exists; the page carries a different token
      await p.goto(`${S}/setup#v=1&e=${encodeURIComponent(e)}&t=${token()}`); await settled(p)
      const s = await click(p, '#make', ['loading', 'ready', 'working'])
      return { s, st: await stored(p), head: !!(await W.store(e))?.get('head') }
    }
    r = await refused()
    ok(r.s[0] === 'failed' && r.s[1] === 'link-used' && r.st === null && !r.head, `a wrong token: not set up, nothing stored (${r.s}, ${r.st})`)
    r = await refused('store-early')
    ok(r.st !== null, `MUTANT store-early: the link's address is stored though nothing was proved (${r.st})`)

    console.log('\n1   the confirmation must name the link\'s address')
    const other = async (mutant) => {
      await reset(mutant); const p = await fresh(); const e = addr('carol')
      await p.goto(await mailedLink('setup', e)); await settled(p)
      await click(p, '#make', ['loading', 'ready', 'working'])
      twist = 'other-address'
      const s = await click(p, '#confirm', ['loading', 'confirm', 'working'])
      return { s, st: await stored(p) }
    }
    r = await other()
    ok(r.s[0] === 'unconfirmed' && r.s[1] === 'other-account' && r.st === null, `a directory answer naming another account: nothing stored (${r.s}, ${r.st})`)
    r = await other('no-expect')
    ok(r.st === 'mallory@example.com', `MUTANT no-expect: the other account is stored (${r.st})`)

    // ---- 2. sign in on the host ---------------------------------------------------------
    console.log('\n2   sign in on this host with a discoverable passkey')
    await reset(); p = await fresh(); auth = auths.get(p)
    const dave = addr('dave')
    ok((await setUp(p, dave))[0] === 'done', 'set up (the account the rows below sign in to)')
    await plant(p, null)
    await p.goto(`${S}/account`); await settled(p)
    s = await click(p, '#signin', ['loading', 'signed-out', 'working'])
    ok(s[0] === 'signed-in' && (await stored(p)) === dave && (await p.locator('#account').textContent()) === dave, `signed in: the directory's answer is stored and shown (${s}, ${await stored(p)})`)
    // the popup shows the account this host now holds
    const home = await ctx.newPage(); await home.goto(HOME + '/') // not fresh(): this host's storage must stay
    const popP = ctx.waitForEvent('page'); await home.evaluate((u) => HM.open(u), `${S}/`)
    const pop = await popP; await pop.waitForLoadState(); await settled(pop)
    const k = async (alg, use) => Buffer.from(await crypto.subtle.exportKey('raw', (await crypto.subtle.generateKey(alg, true, use)).publicKey)).toString('base64url')
    await home.evaluate((m) => HM.send(m), { t: 'enrol', W: await k({ name: 'ECDSA', namedCurve: 'P-256' }, ['sign']), kx: await k({ name: 'ECDH', namedCurve: 'P-256' }, ['deriveBits']), label: 'Chrome on MacBook' })
    await settled(pop, ['loading', 'waiting'])
    ok((await pop.locator('#account').textContent()) === dave, `bento/home's sign-in window shows the account this host signed in to (${await pop.locator('#account').textContent()})`)
    await pop.close()

    console.log('\n2   a passkey on no account changes nothing')
    const stranger = async (p) => {
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
      const h = Buffer.concat([Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bento-dir/1/addr\nnobody@example.com'))), Buffer.alloc(16, 3)])
      await auths.get(p).add({ credentialId: Buffer.from('stranger-passkey-01').toString('base64'), isResidentCredential: true, rpId: 'id.bento.page', privateKey: Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64'), userHandle: h.toString('base64'), signCount: 0 })
    }
    await reset(); p = await fresh(); await stranger(p)
    await p.goto(`${S}/account`); await settled(p); await plant(p, 'bob@example.com'); await plant(p, null)
    await p.goto(`${S}/account`); await settled(p)
    s = await click(p, '#signin', ['loading', 'signed-out', 'working'])
    ok(s[0] === 'failed' && s[1] === 'not-member' && (await stored(p)) === null, `refused not-member, nothing stored (${s}, ${await stored(p)})`)
    await plant(p, 'bob@example.com'); await p.goto(`${S}/account`); await settled(p)
    s = await click(p, '#switch', ['loading', 'signed-in', 'working'])
    ok(s[0] === 'failed' && (await stored(p)) === 'bob@example.com', `a failed "use another passkey" keeps the account already here (${s}, ${await stored(p)})`)

    console.log('\n2   a 32-byte challenge (a statement hash\'s size) is never signed raw')
    const shortNonce = async (mutant) => {
      await reset(mutant); const p = await fresh(); const e = addr('erin')
      await setUp(p, e); await plant(p, null)
      await p.goto(`${S}/account`); await settled(p)
      twist = 'short-nonce'
      const before = (await calls(p)).get
      const s = await click(p, '#signin', ['loading', 'signed-out', 'working'])
      return { s, gets: (await calls(p)).get - before }
    }
    r = await shortNonce()
    ok(r.s[0] === 'failed' && r.gets === 0, `refused before any passkey prompt (${r.s}, ${r.gets} get)`)
    r = await shortNonce('any-nonce')
    ok(r.gets > 0, `MUTANT any-nonce: the passkey is asked to sign it (${r.gets} get)`)

    // ---- 3. reset, through the real directory ---------------------------------------
    console.log('\n3   a mailed reset link completed with a new passkey')
    const resetRun = async (mutant) => {
      await reset(mutant); const p = await fresh(); const e = addr('frank')
      await setUp(p, e); await plant(p, null)
      const before = (await auths.get(p).creds()).length
      await p.goto(await mailedLink('reset', e)); await settled(p)
      const s = await click(p, '#make', ['loading', 'ready', 'working'])
      const st = await W.store(e)
      return { s, before, after: (await auths.get(p).creds()).length, pend: st.get('pend'), stored: await stored(p), ripens: await p.locator('#ripens').textContent(), e }
    }
    r = await resetRun()
    ok(r.s[0] === 'waiting' && r.pend?.kind === 'reset', `the reset waits at the directory (${r.s}, ${r.pend?.kind})`)
    ok(/^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/.test(r.ripens) && Math.abs(Date.parse(r.ripens.replace(' UTC', 'Z').replace(' ', 'T')) - r.pend.ripensAt) < 60_000, `the page says when it takes effect, the directory's time (${r.ripens})`)
    ok(r.stored === null, `a reset stores no account (${r.stored})`)
    ok(r.before === 1 && r.after === 2, `the new passkey does not overwrite the old one on this authenticator (${r.before} -> ${r.after})`)
    let m = await resetRun('fixed-handle')
    ok(m.after < 2, `MUTANT fixed-handle: the reset's passkey overwrites the old one (${m.before} -> ${m.after})`)
    m = await resetRun('reset-remembers')
    ok(m.stored !== null, `MUTANT reset-remembers: a reset stores the account (${m.stored})`)

    // ---- 4. sign out everywhere -------------------------------------------------------
    console.log('\n4   sign out everywhere, by a member\'s passkey on this host')
    await reset(); p = await fresh()
    const gina = addr('gina')
    await setUp(p, gina)
    await p.goto(`${S}/account`); await settled(p)
    s = await click(p, '#signout-ask', ['loading', 'signed-in'])
    ok(s[0] === 'confirm-signout' && (await p.locator('[data-for=confirm-signout] [data-account]').textContent()) === gina && W.stub.log.length === 0, `asked first, naming the account; nothing sent yet (${s})`)
    s = await click(p, '#signout', ['loading', 'confirm-signout', 'working'])
    const memberPub = (await W.store(gina)).get('head').members[0].pub
    ok(s[0] === 'signed-out-all' && W.stub.log.length === 1 && W.stub.log[0].address === gina && W.stub.log[0].by === memberPub && W.stub.revoked.has(gina),
      `the directory verified the member's assertion over wout. and revoked every browser key (${s}, ${JSON.stringify(W.stub.log.map((x) => [x.address, x.by.slice(0, 8)]))})`)
    ok(W.stub.log[0].os === S && W.mails.some((x) => x.to === gina && /signed out/i.test(x.subject)), 'the request came from the sign-in host, and the address is mailed')
    ok((await stored(p)) === gina, 'this host stays signed in (it holds no browser key)')

    console.log('\n4   while the directory cannot sign browsers out yet (501), the page says so before any passkey prompt')
    const notYet = async (mutant) => {
      await reset(mutant); const p = await fresh(); const e = addr('ivy')
      await setUp(p, e)
      await p.goto(`${S}/account`); await settled(p)
      await click(p, '#signout-ask', ['loading', 'signed-in'])
      twist = 'not-yet'
      const before = (await calls(p)).get
      const s = await click(p, '#signout', ['loading', 'confirm-signout', 'working'])
      return { s, gets: (await calls(p)).get - before, text: await p.locator('#failed-text').textContent(), log: W.stub.log.length }
    }
    r = await notYet()
    ok(r.s[0] === 'failed' && r.s[1] === 'not-implemented' && r.gets === 0 && r.log === 0 && r.text === 'Signing every browser out is not available yet. Nothing changed.',
      `"not available yet", no passkey prompt, nothing revoked (${r.s}, ${r.gets} get, "${r.text}")`)
    r = await notYet('no-501')
    ok(r.s[1] !== 'not-implemented' || r.text !== 'Signing every browser out is not available yet. Nothing changed.', `MUTANT no-501: the page answers a generic refusal (${r.s}, "${r.text}")`)

    console.log('\n4   a passkey that is not a member signs nobody out')
    await reset(); p = await fresh()
    const hal = addr('hal')
    await setUp(p, hal)
    const q = await fresh(); await stranger(q)
    await q.goto(`${S}/account`); await settled(q); await plant(q, hal); await q.goto(`${S}/account`); await settled(q)
    await click(q, '#signout-ask', ['loading', 'signed-in'])
    s = await click(q, '#signout', ['loading', 'confirm-signout', 'working'])
    ok(s[0] === 'failed' && s[1] === 'not-member' && W.stub.log.length === 0 && !W.stub.revoked.has(hal), `refused not-member, nothing revoked (${s})`)

    const sig = signals.reduce((x, y) => x + y, 0)
    ok(sig === 0, `no page called the WebAuthn Signal API (${sig})`)
  } else {
    info('the passkey rows (setup, sign-in, reset, sign out everywhere) run with --chrome and in the headless shell')
  }

  console.log('\nisolation')
  ok(sockets.length === 0, `no WebSocket was opened (${sockets.length})`)
  const strayHere = stray.filter((x) => !x.endsWith('/favicon.ico'))
  ok(strayHere.length === 0, `nothing was fetched outside the routed origins (${JSON.stringify(strayHere.slice(0, 3))})`)
} finally {
  await browser.close()
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
