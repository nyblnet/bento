// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// bento/id directory — id.bento.page. It holds each address's passkey roster
// (roster.js, option G) and answers exact-address lookups.
//
// It never holds a private key, a document, an access list, a share, or a
// "who looked up whom" log. No listing exists anywhere: storage is one Durable
// Object per address, named by a hash of the address, and nothing iterates
// them.
//
// The first design bound an account key to an address with a TYPED code mailed
// to the address (`bind.`, /v1/bind/start and /v1/bind/complete). Option G
// replaces it: an account is a roster of passkeys, and every mailed
// confirmation is a link that completes only on the sign-in host (G13). A typed
// code on the same host contradicts that, so both bind routes now answer 410
// and nothing can make a new `bind.` binding. The Address object below still
// answers lookups and deletions for any binding that exists.

import { addressKey, normalize } from './address.js'
import { issueChallenge, openChallenge } from './challenge.js'
import { deliver } from './mail.js'
import { Roster, REQUESTERS } from './roster.js'
import { SIGNIN_ORIGIN } from './passkey.js'
import { WEB_ROUTES } from './seam.js'
import {
  attest, buildDel, importDirKey, tombstone as tombText, verifyBind, verifyDel,
} from './statements.js'

/** A bind. statement's fields, or null. `at` is the time it is judged at: now
 *  for a new submission; for one the directory already accepted, the time it
 *  accepted it (that re-check is integrity, not freshness; expiry is checked
 *  separately, so an expired binding can still be read in order to delete it). */
async function readBind(text, sig, at) {
  const v = await verifyBind(text, sig, { now: at })
  return v.ok ? v.value : null
}

const sha256hex = async (text) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('')

export const LIMITS = {
  codeTtlMs: 20 * 60_000,
  codeAttempts: 5,
  mailCooldownMs: 60_000,
  mailPerDay: 3, // per ADDRESS: the mail-bombing control
  mailPerMonth: 10,
  ip: { start: 20, complete: 60, lookup: 300, delete: 20, challenge: 120, request: 60, setup: 10, enrol: 60 }, // per IP per hour
}
const DAY = 86_400_000
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' // no 0/O, 1/I/L

const BASE = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  // Callers are the bento/home agents (extension, apps), the sign-in host and
  // the deletion page. Nothing here is authorised by origin or cookies: every
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
/** A DO answer passed through; a deletion becomes 204 with no body (a 204 may not carry one). */
const relay = (r) => (r.status === 200 && r.body.deleted === true ? new Response(null, { status: 204, headers: BASE }) : json(r.status, r.body))

export function mintCode() {
  const r = crypto.getRandomValues(new Uint8Array(8))
  let s = ''
  for (const b of r) s += CODE_ALPHABET[b % 31] // 256 % 31 = 8: a bias under 0.4%, acceptable for a 20-minute, 5-try code
  return s
}
const codeOk = (c) => typeof c === 'string' && c.length === 8 && [...c].every((ch) => CODE_ALPHABET.includes(ch))

/** Constant-time compare of two equal-length hex strings. */
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

// --- mail ----------------------------------------------------------------------
// The mail carries the code and fixed wording, never user-supplied text, so
// the directory can never be used to deliver someone else's words.
export async function sendCode(env, to, code) {
  const body = [
    `Your code: ${code}`,
    '',
    'Enter it on the bento/id account-deletion page to remove this address from the directory.',
    'Bento will never ask for this code anywhere else. If you did not ask for it, ignore this email.',
    'The code expires in 20 minutes.',
  ].join('\n')
  return deliver(env, { to, subject: 'Your bento/id removal code', body, code, kind: 'delete' })
}

// --- routes ----------------------------------------------------------------------

async function ledger(env, ip, kind) {
  const stub = env.LEDGER.get(env.LEDGER.idFromName('ledger'))
  const r = await (await stub.fetch('https://ledger/check', { method: 'POST', body: JSON.stringify({ ip, kind }) })).json()
  return r.ok
}

async function rosterStub(env, email) {
  return env.ROSTER.get(env.ROSTER.idFromName(await addressKey(email)))
}
async function addressStub(env, email) {
  const key = await addressKey(email)
  return env.ADDRESS.get(env.ADDRESS.idFromName(key))
}
const call = async (stub, op, args) => {
  const r = await stub.fetch('https://address/op', { method: 'POST', body: JSON.stringify({ op, ...args }) })
  return { status: r.status, body: await r.json() }
}

async function body(req) {
  try { const j = await req.json(); return j && typeof j === 'object' ? j : null } catch { return null }
}

/** The typed-code `bind.` routes, retired under G13 (see the top of this file). */
export const RETIRED = Object.freeze(['/v1/bind/start', '/v1/bind/complete'])

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
  if (req.method === 'OPTIONS') {
    const web = url.pathname.startsWith(WEB_ROUTES.prefix)
    return new Response(null, {
      status: 204,
      headers: { ...headersFor(url.pathname), 'access-control-allow-methods': web ? 'POST, OPTIONS' : 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' },
    })
  }
  const ip = req.headers.get('cf-connecting-ip') || '0.0.0.0'
  const p = url.pathname
  if (RETIRED.includes(p)) return json(410, { error: 'gone' })

  if (p === '/v1/keys' && req.method === 'GET') {
    return json(200, { keys: JSON.parse(env.DIR_PUBKEYS || '[]') })
  }

  if (p === '/v1/lookup' && req.method === 'GET') {
    const email = normalize(url.searchParams.get('e') ?? '')
    if (!email) return json(400, { error: 'bad-address' })
    if (!(await ledger(env, ip, 'lookup'))) return json(429, { error: 'rate-limited' })
    const r = await call(await addressStub(env, email), 'lookup', {})
    return json(r.status, r.body)
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

  if (p === '/v1/delete') {
    const email = normalize(b.email ?? '')
    if (!email || typeof b.sig !== 'string') return json(400, { error: 'invalid' })
    if (!(await ledger(env, ip, 'delete'))) return json(429, { error: 'rate-limited' })
    const r = await call(await addressStub(env, email), 'delete', { ts: b.ts, sig: b.sig })
    return relay(r)
  }

  if (p === '/v1/delete/start') {
    const email = normalize(b.email ?? '')
    if (!email) return json(400, { error: 'bad-address' })
    if (!(await ledger(env, ip, 'start'))) return json(202, { ok: true })
    const r = await call(await addressStub(env, email), 'deleteStart', {})
    if (r.body.mail) {
      try { await sendCode(env, email, r.body.mail.code) } catch (e) { console.log(`mail failed: ${e.message}`) }
    }
    return json(202, { ok: true })
  }

  if (p === '/v1/delete/complete') {
    const email = normalize(b.email ?? '')
    if (!email || !codeOk(b.code)) return json(400, { error: 'invalid' })
    if (!(await ledger(env, ip, 'complete'))) return json(429, { error: 'rate-limited' })
    const r = await call(await addressStub(env, email), 'deleteComplete', { code: b.code })
    return relay(r)
  }

  // --- the passkey roster (option G) ---
  const origin = req.headers.get('origin') || ''

  if (p === '/v1/roster/challenge') {
    const email = normalize(b.email ?? '')
    if (!email) return json(400, { error: 'bad-address' })
    if (!(await ledger(env, ip, 'challenge'))) return json(429, { error: 'rate-limited' })
    return json(200, { challenge: await issueChallenge(env.CHALLENGE_KEY, 'roster', await addressKey(email), Date.now()) })
  }

  if (p === '/v1/roster/setup/start') {
    // Mails the address a setup link (links.js). ALWAYS 202 once the address
    // is well formed: the answer never says whether the address has an account,
    // was mailed, or hit a limit.
    const email = normalize(b.email ?? '')
    if (!email) return json(400, { error: 'bad-address' })
    if (!(await ledger(env, ip, 'setup'))) return json(202, { ok: true })
    await call(await rosterStub(env, email), 'setupStart', { address: email })
    return json(202, { ok: true })
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

// --- one Durable Object per ADDRESS ------------------------------------------------
// Storage: `cur` (a binding: exact statement text, holder signature), `chain`
// (hashes of every earlier binding for this address), `pend` (a pending
// removal code), `mail` (send times, for the per-address limits), `tomb` (a
// deletion). Nothing can make a new binding since the bind routes were retired;
// this object answers lookups and removals for the ones that exist.

export class Address {
  constructor(state, env) { this.state = state; this.env = env }

  async fetch(req) {
    const a = await req.json()
    const now = Date.now()
    const s = this.state.storage
    const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    // may we mail this address now? (per-address limits; recorded only when a mail is actually sent)
    const mayMail = async () => {
      const times = ((await s.get('mail')) || []).filter((t) => now - t < 31 * DAY)
      if (times.length && now - times[times.length - 1] < LIMITS.mailCooldownMs) return false
      if (times.filter((t) => now - t < DAY).length >= LIMITS.mailPerDay) return false
      if (times.length >= LIMITS.mailPerMonth) return false
      await s.put('mail', [...times, now])
      return true
    }
    const pending = async (kind) => {
      const p = await s.get('pend')
      if (!p || p.kind !== kind || p.expires <= now || p.attempts >= LIMITS.codeAttempts) return null
      return p
    }
    const codeHash = (code) => sha256hex(`bento-dir/1/code\n${code}`)
    const fail = async (p) => { p.attempts++; await s.put('pend', p); return out(400, { error: 'invalid' }) }

    if (a.op === 'lookup') {
      const cur = await s.get('cur')
      if (cur && cur.b.expires > now) {
        // a FRESH issuedAt on every answer, so a client can tell a replayed old answer by age
        const dirKey = await importDirKey(this.env.DIR_KEY_JWK)
        const att = await attest(dirKey, this.env.DIR_KID, cur.h, cur.verifiedAt, now)
        return out(200, { binding: cur.stmt, sig: cur.sig, attestation: att.text, attestationSig: att.sig, chain: (await s.get('chain')) || [], rebound: !!cur.rebound })
      }
      const tomb = await s.get('tomb')
      if (tomb) return out(410, { error: 'deleted', tombstone: tomb })
      return out(404, { error: 'not-found' }) // never existed, or expired: the same answer
    }

    const tombstone = async (by) => {
      const cur = await s.get('cur')
      await s.delete(['cur', 'pend'])
      if (!cur) return // nothing was bound: nothing to record
      const dirKey = await importDirKey(this.env.DIR_KEY_JWK)
      await s.put('tomb', await tombText(dirKey, this.env.DIR_KID, cur.h, cur.b.seq, now, by))
    }

    if (a.op === 'delete') {
      const cur = await s.get('cur')
      const b = cur && (await readBind(cur.stmt, cur.sig, cur.verifiedAt)) // the address, read from the statement itself
      if (!b || !Number.isSafeInteger(a.ts)) return out(400, { error: 'invalid' })
      if (!(await verifyDel(buildDel(b.address, a.ts), a.sig, { accountPub: b.accountPub, now })).ok) return out(400, { error: 'invalid' })
      await tombstone('holder')
      return out(200, { deleted: true })
    }

    if (a.op === 'deleteStart') {
      // only an address with something to delete is mailed; the HTTP answer is 202 either way
      // only an EXPIRED binding can be removed by mailbox alone: a live one is
      // removed by its holder (del.), or, once rotation lands, by the 72-hour
      // contestable path. Email never decides alone (security §25).
      const cur = await s.get('cur')
      if (!cur || cur.b.expires > now || !(await mayMail())) return out(202, { mail: null })
      const code = mintCode()
      await s.put('pend', { kind: 'delete', codeHash: await codeHash(code), expires: now + LIMITS.codeTtlMs, attempts: 0 })
      return out(202, { mail: { code } })
    }

    if (a.op === 'deleteComplete') {
      const p = await pending('delete')
      if (!p) return out(400, { error: 'invalid' })
      if (!same(await codeHash(a.code), p.codeHash)) return fail(p)
      const cur = await s.get('cur')
      if (cur && cur.b.expires > now) return fail(p) // renewed since the code was mailed
      await tombstone('mailbox')
      return out(200, { deleted: true })
    }

    return out(400, { error: 'bad-op' })
  }
}

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
