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
import { Roster, REQUESTERS } from './roster.js'
import { SIGNIN_ORIGIN } from './passkey.js'
import { WEB_ROUTES } from './seam.js'

export const LIMITS = {
  ip: { complete: 60, lookup: 300, challenge: 120, request: 60, setup: 10, enrol: 60 }, // per IP per hour
}
const DAY = 86_400_000

const BASE = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  // Callers are the bento/home agents (extension, apps) and the sign-in host.
  // Nothing here is authorised by origin or cookies: every
  // write is a signature, a passkey assertion or a mailed secret, so any origin
  // may call.
  'access-control-allow-origin': '*',
  // id.bento.page is the passkeys' relying party and never runs a ceremony.
  // The Permissions-Policy stops WebAuthn create and get on any page it
  // serves; it does NOT stop the WebAuthn Signal API (measured), so nothing
  // here may run script either: every answer is JSON, and the CSP below makes
  // any document it could be read as inert and unframeable. Only the void
  // page, when it comes, runs script, under its own CSP.
  'permissions-policy': 'publickey-credentials-get=(), publickey-credentials-create=()',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
}
/**
 * The /v1/web/* routes are the sign-in host's (server/signin): a browser page
 * on that origin calls them, so they answer CORS to that origin alone, never
 * `*`. Every other header is the same.
 */
const WEB = { ...BASE, 'access-control-allow-origin': SIGNIN_ORIGIN, vary: 'Origin' }
const headersFor = (path) => (path.startsWith(WEB_ROUTES.prefix) ? WEB : BASE)
const json = (status, body, headers = BASE) => new Response(JSON.stringify(body), { status, headers })

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
    const web = url.pathname.startsWith(WEB_ROUTES.prefix)
    return new Response(null, {
      status: 204,
      headers: { ...headersFor(url.pathname), 'access-control-allow-methods': web ? 'POST, OPTIONS' : 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' },
    })
  }
  const ip = req.headers.get('cf-connecting-ip') || '0.0.0.0'
  const p = url.pathname

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

  // Nothing else is served for GET: in particular no /.well-known/webauthn,
  // which would let the origins it lists use these passkeys, and no route
  // that reads a mailed link (links complete only on the sign-in host).
  if (req.method !== 'POST') return json(404, { error: 'not-found' }, headersFor(p))

  if (p.startsWith(WEB_ROUTES.prefix)) return web(req, env, ip, p)
  const b = await body(req)
  if (!b) return json(400, { error: 'bad-request' })

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

  return json(404, { error: 'not-found' })
}

// --- the sign-in host's routes ---------------------------------------------------
// The browser-key enrolment (#927's seam, server/signin/public/directory-client.js):
//   POST /v1/web/challenge  (any body)                  → 200 { nonce }
//   POST /v1/web/enrol      { text, rq, assertion }     → 200 { ok, wdev, watt }
// The text a passkey signs to certify a browser key is the kernel's `wdev.`
// statement, which is not defined yet. Until it is, enrol checks everything it
// can without that layout and answers 501: nothing is countersigned, stored or
// logged.

/** A challenge for the web audience: never valid for a roster request, and the reverse. */
const WEB_AUDIENCE = 'web'
const B64U = /^[A-Za-z0-9_-]+$/
const TEXT_MAX = 2048
const FIELD_MAX = 4096

async function web(req, env, ip, p) {
  const H = headersFor(p)
  if (p === WEB_ROUTES.challenge) {
    // the sign-in host posts {} as text/plain (a simple request); the body is not read
    if (!(await ledger(env, ip, 'challenge'))) return json(429, { error: 'rate-limited' }, H)
    return json(200, { nonce: await issueChallenge(env.CHALLENGE_KEY, WEB_AUDIENCE, WEB_AUDIENCE, Date.now()) }, H)
  }
  if (p === WEB_ROUTES.enrol) {
    const b = await body(req)
    if (!b) return json(400, { error: 'bad-request' }, H)
    if (typeof b.text !== 'string' || !b.text.startsWith('wdev.') || b.text.length > TEXT_MAX) return json(400, { error: 'text' }, H)
    // the opener the sign-in host read from the message event: only bento/home may ask
    if (!REQUESTERS.includes(b.rq)) return json(400, { error: 'rq' }, H)
    const as = b.assertion
    const field = (v) => typeof v === 'string' && v.length > 0 && v.length <= FIELD_MAX && B64U.test(v)
    if (!as || typeof as !== 'object' || Array.isArray(as) ||
      !['id', 'authenticatorData', 'clientDataJSON', 'signature'].every((k) => field(as[k])) ||
      !(as.userHandle === null || as.userHandle === undefined || field(as.userHandle))) return json(400, { error: 'assertion' }, H)
    if (!(await ledger(env, ip, 'enrol'))) return json(429, { error: 'rate-limited' }, H)
    return json(501, { error: 'not-implemented', reason: 'the kernel wdev. statement is not defined yet' }, H)
  }
  return json(404, { error: 'not-found' }, H)
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
