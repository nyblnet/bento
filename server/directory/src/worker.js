// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/id directory — id.bento.page. Layer 1 of bento/id: it holds
// holder-published bindings "account key K belongs to the mailbox
// alice@example.com", each made with TWO proofs (a signature by K, and a code
// mailed to the address and entered in the holder's own agent), and answers
// exact-address lookups with a directory-signed attestation.
//
// It never holds a private key, a document, an access list, a share, or a
// "who looked up whom" log. No listing exists anywhere: storage is one Durable
// Object per address, named by a hash of the address, and nothing iterates
// them.
//
// Why a CODE and not a link: an attacker can start a binding of THEIR key to
// a victim's address. If clicking a mailed link completed it, the victim's
// click — or their mail provider's link scanner — would bind the attacker's
// key. Completion here needs the code AND a signature by the binding's own key
// over it, so neither half works alone.

import { addressKey, normalize } from './address.js'
import {
  attest, buildCmp, buildDel, hashOf, importDirKey, tombstone as tombText, verifyBind, verifyCmp, verifyDel,
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
  ip: { start: 20, complete: 60, lookup: 300, delete: 20 }, // per IP per hour
}
const DAY = 86_400_000
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' // no 0/O, 1/I/L

const BASE = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  // Callers are the bento/home agents (extension, apps) and the deletion page.
  // Nothing here is authorised by origin or cookies: every write is a
  // signature or a mailed code, so any origin may call.
  'access-control-allow-origin': '*',
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: BASE })
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
// The mail carries the code, the first 8 characters of the key's fingerprint
// and fixed wording — never user-supplied text (not even the display name), so
// the directory can never be used to deliver someone else's words.
export async function sendCode(env, to, code, fp, kind) {
  const subject = kind === 'delete' ? 'Your bento/id removal code' : 'Your bento/id code'
  const body = [
    `Your code: ${code}`,
    '',
    kind === 'delete'
      ? 'Enter it on the bento/id account-deletion page to remove this address from the directory.'
      : `Enter it in bento/home on your own device to link this address to the key ${fp}.`,
    'Bento will never ask for this code anywhere else. If you did not ask for it, ignore this email.',
    'The code expires in 20 minutes.',
  ].join('\n')
  if (env.MAILER && typeof env.MAILER.send === 'function') return env.MAILER.send({ to, subject, body, code }) // the rig's seam
  if (env.MAILER === 'log' && env.DEV === '1') {
    console.log(JSON.stringify({ devmail: { to, subject, body } })) // local development only
    return
  }
  if (env.MAILER === 'ses') throw new Error('SES sending is not wired yet (needs the maintainer\'s SES account, M4)')
  throw new Error('no mailer configured')
}

// --- routes ----------------------------------------------------------------------

async function ledger(env, ip, kind) {
  const stub = env.LEDGER.get(env.LEDGER.idFromName('ledger'))
  const r = await (await stub.fetch('https://ledger/check', { method: 'POST', body: JSON.stringify({ ip, kind }) })).json()
  return r.ok
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...BASE, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' },
      })
    }
    const ip = req.headers.get('cf-connecting-ip') || '0.0.0.0'
    const p = url.pathname

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

    if (req.method !== 'POST') return json(404, { error: 'not-found' })
    const b = await body(req)
    if (!b) return json(400, { error: 'bad-request' })

    if (p === '/v1/bind/start') {
      // ALWAYS 202 from here on, whatever happens: the answer must not reveal
      // whether the address exists, is rate-limited, or was mailed.
      const binding = await readBind(b.stmt, b.sig, Date.now())
      if (!binding) return json(400, { error: 'bad-statement' }) // reveals nothing about the address
      const email = normalize(binding.address)
      if (!email || email !== binding.address) return json(400, { error: 'bad-address' })
      if (!(await ledger(env, ip, 'start'))) return json(202, { ok: true })
      const r = await call(await addressStub(env, email), 'start', { stmt: b.stmt, sig: b.sig })
      if (r.body.mail) {
        try { await sendCode(env, email, r.body.mail.code, r.body.mail.fp, 'bind') } catch (e) { console.log(`mail failed: ${e.message}`) }
      }
      return json(202, { ok: true })
    }

    if (p === '/v1/bind/complete') {
      const email = normalize(b.email ?? '')
      if (!email || !codeOk(b.code) || typeof b.sig !== 'string') return json(400, { error: 'invalid' })
      if (!(await ledger(env, ip, 'complete'))) return json(429, { error: 'rate-limited' })
      const r = await call(await addressStub(env, email), 'complete', { code: b.code, sig: b.sig })
      return json(r.status, r.body)
    }

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
        try { await sendCode(env, email, r.body.mail.code, '', 'delete') } catch (e) { console.log(`mail failed: ${e.message}`) }
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

    return json(404, { error: 'not-found' })
  },
}

// --- one Durable Object per ADDRESS ------------------------------------------------
// Storage: `cur` (the live binding: exact statement text, holder signature,
// attestation), `chain` (hashes of every earlier binding for this address),
// `pend` (a pending code), `mail` (send times, for the per-address limits),
// `tomb` (a deletion). Strongly consistent per address, so a re-bind and a
// lookup can never race into a mixed answer.

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

    if (a.op === 'start') {
      if (!(await mayMail())) return out(202, { mail: null })
      const b = await readBind(a.stmt, a.sig, now)
      if (!b) return out(202, { mail: null })
      // a LIVE binding never moves to another key by email alone (security §25):
      // that is the 72-hour contestable rotation, which is not built yet. No mail.
      const live = await s.get('cur')
      if (live && live.b.expires > now && live.b.key !== b.accountPub) return out(202, { mail: null })
      const code = mintCode()
      await s.put('pend', { kind: 'bind', stmt: a.stmt, sig: a.sig, codeHash: await codeHash(code), expires: now + LIMITS.codeTtlMs, attempts: 0 })
      return out(202, { mail: { code, fp: (await hashOf(b.accountPub)).slice(0, 8) } })
    }

    if (a.op === 'complete') {
      const p = await pending('bind')
      if (!p) return out(400, { error: 'invalid' })
      const b = await readBind(p.stmt, p.sig, now) // re-verified, and still within its lifetime
      const h = await hashOf(p.stmt)
      if (!b || !same(await codeHash(a.code), p.codeHash)) return fail(p)
      if (!(await verifyCmp(buildCmp(h, a.code), a.sig, { accountPub: b.accountPub, bindText: p.stmt })).ok) return fail(p)
      // sequence rules against what is live now
      const cur = await s.get('cur')
      const live = cur && cur.b.expires > now ? cur : null
      if (live) {
        if (b.accountPub !== live.b.key) return fail(p) // re-checked: it may have gone live since start
        if (b.seq !== live.b.seq + 1 || b.prev !== live.h) return fail(p)
      } else if (b.seq !== 1 && !(cur && b.seq === cur.b.seq + 1 && b.prev === cur.h)) {
        return fail(p) // a fresh start is seq 1; an expired binding may also be continued
      }
      // a new key over an EXPIRED binding, proven by email alone: pinners warn
      const rebound = !!cur && cur.b.key !== b.accountPub
      const dirKey = await importDirKey(this.env.DIR_KEY_JWK)
      const att = await attest(dirKey, this.env.DIR_KID, h, now, now)
      if (cur) await s.put('chain', [...((await s.get('chain')) || []), cur.h])
      // `b` keeps only what the service needs between requests — NOT the address
      // or the name, which live once, inside the signed statement it serves
      await s.put('cur', { stmt: p.stmt, sig: p.sig, h, b: { key: b.accountPub, seq: b.seq, expires: b.expires }, verifiedAt: now, rebound })
      await s.delete(['pend', 'tomb'])
      return out(200, { binding: p.stmt, sig: p.sig, attestation: att.text, attestationSig: att.sig, rebound })
    }

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
