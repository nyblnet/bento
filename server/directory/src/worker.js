// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// bento/id directory — id.bento.page. It holds each address's passkey roster
// (roster.js, option G).
//
// It never holds a private key, a document, an access list, a share, or a
// "who looked up whom" log. No listing exists anywhere: storage is one Durable
// Object per address, named by a hash of the address, and nothing iterates
// them.
//
// It serves ONE page, the void page (voidpage.js), which a mailed void link
// opens: everything else is JSON.
//
// The first design bound an account key to an address with a TYPED code mailed
// to the address (`bind.`, /v1/bind/start and /v1/bind/complete), and removed
// one with a holder-signed `del.` or another typed code (/v1/delete,
// /v1/delete/start, /v1/delete/complete), with /v1/lookup serving the binding.
// Option G replaces all of it: an account is a roster of passkeys, and every
// mailed confirmation is a link that completes only on the sign-in host (G13).
// A typed code on the same host contradicts that, and nothing could make a
// binding for the others to serve, so every one of those routes answers 410
// and the object that held bindings is gone. Account deletion comes back as a
// mailed link to the sign-in host or a member's assertion.

import { addressKey, normalize } from './address.js'
import { issueChallenge, openChallenge } from './challenge.js'
import { Roster } from './roster.js'
import { HOME_ORIGIN, SIGNIN_ORIGIN } from './passkey.js'
import { STATUS_ROUTE } from './seam.js'
import { browserOrigin, browserRoute, deviceStatus } from './browsers.js'
import { PAGE_HEADERS, VOID_CSS, VOID_HTML, VOID_JS, VOID_PATHS } from './voidpage.js'

export const LIMITS = {
  // per IP per hour. challengeAddr is per IP per hour FOR ONE ADDRESS (a
  // browser challenge, browsers.js): never a count shared by every caller,
  // which a stranger could fill to starve the owner's browsers
  ip: { complete: 60, lookup: 300, challenge: 120, request: 60, setup: 10, enrol: 60, void: 60, reset: 10, checkin: 120, challengeAddr: 20 },
}
const DAY = 86_400_000

const BASE = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  // id.bento.page is the passkeys' relying party and never runs a ceremony.
  // The Permissions-Policy stops WebAuthn create and get on any page it
  // serves; it does NOT stop the WebAuthn Signal API (measured), so nothing
  // here may run script either: every answer is JSON, and the CSP below makes
  // any document it could be read as inert and unframeable. Only the void
  // page runs script, under its own CSP (voidpage.js PAGE_HEADERS).
  'permissions-policy': 'publickey-credentials-get=(), publickey-credentials-create=()',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
}
/**
 * CORS. The routes below that are not a browser page's answer `*`: their
 * callers are the bento/home agents (extension, apps) and the sign-in host,
 * and nothing here is authorised by origin or cookies (every write is a
 * signature, a passkey assertion or a mailed secret), so any origin may call.
 * The /v1/web/* routes are the sign-in host's and the /v1/home/* routes
 * bento/home's (browsers.js): each answers CORS to that origin alone, never
 * `*`. A path that is no route answers with no CORS at all.
 */
const ANY = { ...BASE, 'access-control-allow-origin': '*' }
const only = (origin) => Object.freeze({ ...BASE, 'access-control-allow-origin': origin, vary: 'Origin' })
const WEB = only(SIGNIN_ORIGIN), HOME = only(HOME_ORIGIN)
const headersFor = (path) => {
  const o = browserOrigin(path)
  return o === SIGNIN_ORIGIN ? WEB : o === HOME_ORIGIN ? HOME : PUBLIC.includes(path) ? ANY : BASE
}
const json = (status, body, headers = ANY) => new Response(JSON.stringify(body), { status, headers })
const page = (text, type) => new Response(text, { status: 200, headers: { ...PAGE_HEADERS, 'content-type': type } })
/** The void page's three files, for GET (and HEAD) only. */
const PAGE_FILES = Object.freeze({
  [VOID_PATHS.page]: [VOID_HTML, 'text/html; charset=utf-8'],
  [VOID_PATHS.script]: [VOID_JS, 'text/javascript; charset=utf-8'],
  [VOID_PATHS.style]: [VOID_CSS, 'text/css; charset=utf-8'],
})
const TOKEN = /^[A-Za-z0-9_-]{43}$/

// --- routes ----------------------------------------------------------------------

async function ledger(env, ip, kind) {
  const stub = env.LEDGER.get(env.LEDGER.idFromName('ledger'))
  const r = await (await stub.fetch('https://ledger/check', { method: 'POST', body: JSON.stringify({ ip, kind }) })).json()
  return r.ok
}

async function rosterStub(env, email) {
  return env.ROSTER.get(env.ROSTER.idFromName(await addressKey(email)))
}
const call = async (stub, op, args) => {
  const r = await stub.fetch('https://address/op', { method: 'POST', body: JSON.stringify({ op, ...args }) })
  return { status: r.status, body: await r.json() }
}

/** setup/start's one answer, whatever happened (it is frozen: nothing may add to it). */
const SETUP_STARTED = Object.freeze({ ok: true })

async function body(req) {
  try { const j = await req.json(); return j && typeof j === 'object' ? j : null } catch { return null }
}

/**
 * The first design's routes, retired under G13 (see the top of this file):
 * 410 for any method (OPTIONS too) and body, before anything is read.
 */
export const RETIRED = Object.freeze([
  '/v1/bind/start', '/v1/bind/complete', '/v1/lookup', '/v1/delete', '/v1/delete/start', '/v1/delete/complete',
])
/** Every route anyone's page may call (CORS `*`): the ones below, and the retired ones' 410. */
const PUBLIC = Object.freeze([
  '/v1/keys', '/v1/roster', '/v1/roster/challenge', '/v1/roster/setup/start', '/v1/roster/setup', '/v1/roster/request', '/v1/void',
  '/v1/roster/reset/start', '/v1/roster/reset', '/v1/roster/reset/void', STATUS_ROUTE, ...RETIRED,
])

export default {
  /**
   * Every answer carries the full header set, an unexpected failure included:
   * an exception that escaped would otherwise reach the platform, which serves
   * its own error page on id.bento.page without them (security's D3).
   */
  async fetch(req, env) {
    try {
      return await route(req, env)
    } catch (e) {
      console.log(`directory error: ${e && e.message}`)
      let path = ''
      try { path = new URL(req.url).pathname } catch { /* the base headers */ }
      return json(500, { error: 'internal' }, headersFor(path))
    }
  },
}

async function route(req, env) {
  const url = new URL(req.url)
  // before anything else, a preflight included: a retired route answers nothing but 410
  if (RETIRED.includes(url.pathname)) return json(410, { error: 'gone' })
  if (req.method === 'OPTIONS') {
    const h = headersFor(url.pathname)
    if (h === BASE) return json(404, { error: 'not-found' }, BASE) // no route, no CORS
    const browser = browserOrigin(url.pathname) !== null
    return new Response(null, {
      status: 204,
      headers: { ...h, 'access-control-allow-methods': browser ? 'POST, OPTIONS' : 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' },
    })
  }
  const ip = req.headers.get('cf-connecting-ip') || '0.0.0.0'
  const p = url.pathname

  // the browser routes' helpers (browsers.js)
  const k = {
    json: (status, b) => json(status, b, headersFor(p)),
    ledger: (key, kind) => ledger(env, key, kind),
    roster: async (email, op, args) => call(await rosterStub(env, email), op, args),
    body,
  }

  if (p === STATUS_ROUTE && req.method === 'GET') return deviceStatus(env, ip, url, k)

  if (p === '/v1/keys' && req.method === 'GET') {
    return json(200, { keys: JSON.parse(env.DIR_PUBKEYS || '[]') })
  }

  if (p === '/v1/roster' && req.method === 'GET') {
    // the roster head and any waiting change, for the sign-in host to build a request on
    const email = normalize(url.searchParams.get('e') ?? '')
    if (!email) return json(400, { error: 'bad-address' })
    if (!(await ledger(env, ip, 'lookup'))) return json(429, { error: 'rate-limited' })
    const r = await call(await rosterStub(env, email), 'head', {})
    return json(r.status, r.body)
  }

  // The void page: the same fixed bytes for every GET, whatever the query or
  // fragment. Reading it changes nothing (a mail scanner may fetch it).
  if ((req.method === 'GET' || req.method === 'HEAD') && Object.hasOwn(PAGE_FILES, p)) {
    const [text, type] = PAGE_FILES[p]
    return page(req.method === 'HEAD' ? null : text, type)
  }

  // Nothing else is served for GET: in particular no /.well-known/webauthn,
  // which would let the origins it lists use these passkeys, and no route
  // that reads a mailed link (links complete only on the sign-in host).
  if (req.method !== 'POST') return json(404, { error: 'not-found' }, headersFor(p))

  if (browserOrigin(p) !== null) return browserRoute(req, env, ip, p, k)
  const b = await body(req)
  if (!b) return json(400, { error: 'bad-request' }, headersFor(p))

  // --- the passkey roster (option G) ---
  const origin = req.headers.get('origin') || ''

  if (p === '/v1/roster/challenge') {
    const email = normalize(b.email ?? '')
    if (!email) return json(400, { error: 'bad-address' })
    if (!(await ledger(env, ip, 'challenge'))) return json(429, { error: 'rate-limited' })
    return json(200, { challenge: await issueChallenge(env.CHALLENGE_KEY, 'roster', await addressKey(email), Date.now()) })
  }

  if (p === '/v1/roster/setup/start') {
    // Mails the address a setup link (links.js). ALWAYS the same 202 once the
    // address is well formed: the answer never says whether the address has an
    // account, was mailed, or hit a limit, so the object's answer is never
    // passed on (the rig compares the bytes across every state).
    const email = normalize(b.email ?? '')
    if (!email) return json(400, { error: 'bad-address' })
    if (!(await ledger(env, ip, 'setup'))) return json(202, SETUP_STARTED)
    await call(await rosterStub(env, email), 'setupStart', { address: email })
    return json(202, SETUP_STARTED)
  }

  if (p === '/v1/roster/setup') {
    // completes a setup from its mailed token; the mail itself comes with the setup links
    const email = normalize(b.email ?? '')
    if (!email || typeof b.token !== 'string' || typeof b.dirNonce !== 'string') return json(400, { error: 'invalid' })
    if (!(await ledger(env, ip, 'complete'))) return json(429, { error: 'rate-limited' })
    const c = await openChallenge(env.CHALLENGE_KEY, 'roster', await addressKey(email), b.dirNonce, Date.now())
    if (!c) return json(400, { error: 'nonce' })
    const r = await call(await rosterStub(env, email), 'setup', {
      address: email, token: b.token, dirNonce: b.dirNonce, reg: b.reg, nonce: c.nonce, issued: c.issued, os: origin,
    })
    return json(r.status, r.body)
  }

  if (p === '/v1/roster/request') {
    const email = normalize(b.email ?? '')
    if (!email || typeof b.ros !== 'string') return json(400, { error: 'invalid' })
    if (!(await ledger(env, ip, 'request'))) return json(429, { error: 'rate-limited' })
    const dirNonce = b.ros.split('.')[5]
    const c = await openChallenge(env.CHALLENGE_KEY, 'roster', await addressKey(email), dirNonce, Date.now())
    if (!c) return json(400, { error: 'nonce' })
    const r = await call(await rosterStub(env, email), 'request', {
      ros: b.ros, credId: b.credId, assertion: b.assertion, reg: b.reg, rq: b.rq, nonce: c.nonce, issued: c.issued, os: origin,
    })
    return json(r.status, r.body)
  }

  if (p === '/v1/void') {
    // The void page's button (G3, G4). The token is the authority; it is
    // checked in the address's object, which keeps no count of wrong ones.
    // Per-IP limits are the only brake, and they never touch the real token.
    const email = normalize(b.email ?? '')
    if (!email || typeof b.token !== 'string' || !TOKEN.test(b.token) || typeof b.choice !== 'string') return json(400, { error: 'invalid' })
    if (!(await ledger(env, ip, 'void'))) return json(429, { error: 'rate-limited' })
    const r = await call(await rosterStub(env, email), 'void', { token: b.token, choice: b.choice, os: origin })
    return json(r.status, r.body)
  }

  if (p === '/v1/roster/reset/start') {
    // Mails a reset link to an address that has an account (G5). The same 202
    // in every state, as setup/start: it never says whether the address has an
    // account or was mailed. No budget holds a reset mail back (S2).
    const email = normalize(b.email ?? '')
    if (!email) return json(400, { error: 'bad-address' })
    if (!(await ledger(env, ip, 'reset'))) return json(202, SETUP_STARTED)
    await call(await rosterStub(env, email), 'resetStart', { address: email })
    return json(202, SETUP_STARTED)
  }

  if (p === '/v1/roster/reset') {
    // completes a reset from its mailed token with a new passkey; the reset then waits 72 hours
    const email = normalize(b.email ?? '')
    if (!email || typeof b.token !== 'string' || typeof b.dirNonce !== 'string') return json(400, { error: 'invalid' })
    if (!(await ledger(env, ip, 'complete'))) return json(429, { error: 'rate-limited' })
    const c = await openChallenge(env.CHALLENGE_KEY, 'roster', await addressKey(email), b.dirNonce, Date.now())
    if (!c) return json(400, { error: 'nonce' })
    const r = await call(await rosterStub(env, email), 'reset', {
      address: email, token: b.token, dirNonce: b.dirNonce, reg: b.reg, nonce: c.nonce, issued: c.issued, os: origin,
    })
    return json(r.status, r.body)
  }

  if (p === '/v1/roster/reset/void') {
    // a member stopping a reset with its passkey (G5): refused at the last step until the kernel defines what it signs
    const email = normalize(b.email ?? '')
    if (!email || typeof b.dirNonce !== 'string') return json(400, { error: 'invalid' })
    if (!(await ledger(env, ip, 'request'))) return json(429, { error: 'rate-limited' })
    const c = await openChallenge(env.CHALLENGE_KEY, 'roster', await addressKey(email), b.dirNonce, Date.now())
    if (!c) return json(400, { error: 'nonce' })
    const r = await call(await rosterStub(env, email), 'resetVoid', { credId: b.credId, assertion: b.assertion, nonce: c.nonce, issued: c.issued, os: origin })
    return json(r.status, r.body)
  }

  return json(404, { error: 'not-found' }, headersFor(p))
}

export { Roster }

// --- the per-IP ledger ----------------------------------------------------------------
// Keys on HMAC(daySalt, ip); the salt is minted in storage per UTC day and
// yesterday's is deleted with its counters, so no raw IP is ever stored and
// one day's hashes cannot be linked to the next.

const dayOf = (t) => new Date(t).toISOString().slice(0, 10)
const hourOf = (t) => new Date(t).toISOString().slice(0, 13)

export class Ledger {
  constructor(state) { this.state = state }

  async fetch(req) {
    const { ip, kind } = await req.json()
    const now = Date.now()
    const day = dayOf(now), hour = hourOf(now)
    const s = this.state.storage
    let salt = await s.get(`salt:${day}`)
    if (!salt) {
      salt = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')
      await s.put(`salt:${day}`, salt)
      await s.setAlarm(Date.parse(day) + DAY + 60_000)
    }
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const h = [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(String(ip))))].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('')
    const cap = LIMITS.ip[kind] ?? 0
    const key = `${kind}:${hour}:${h}`
    const n = ((await s.get(key)) || 0) + 1
    if (n > cap) return Response.json({ ok: false })
    await s.put(key, n)
    return Response.json({ ok: true })
  }

  async alarm() {
    const today = dayOf(Date.now())
    const dead = []
    for (const k of (await this.state.storage.list()).keys()) {
      const stamp = k.startsWith('salt:') ? k.slice(5) : k.split(':')[1]?.slice(0, 10)
      if (stamp && stamp < today) dead.push(k)
    }
    for (let i = 0; i < dead.length; i += 128) await this.state.storage.delete(dead.slice(i, i + 128))
  }
}
