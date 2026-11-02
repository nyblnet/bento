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
import { issueChallenge, openChallenge, CHALLENGE_TTL_MS } from './challenge.js'
import { AUDIENCE, verifyDirConsent } from './consent.js'
import {
  attest, b64uEnc, buildCmp, buildDel, hashOf, importDirKey, tombstone as tombText, verifyBind, verifyCmp, verifyDel,
  verifyStatementSig,
} from './statements.js'
import { verifyAssertion } from './webauthn.js'

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
  ip: { start: 20, complete: 60, lookup: 300, delete: 20, challenge: 120, rotate: 20 }, // per IP per hour
  rotationWindowMs: 72 * 3_600_000, // a pending rotation is contestable for 72 hours (security §25)
  freezeTokenTtlMs: 24 * 3_600_000, // an emailed freeze link stays usable for a day
  credFailures: 5, // consecutive WebAuthn failures before a credential locks
  credLockMs: 15 * 60_000,
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

/** A freeze token: 32 random bytes, base64url. It travels only in a URL fragment. */
export const mintToken = () => b64uEnc(crypto.getRandomValues(new Uint8Array(32)))
const tokenOk = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t)

// The freeze confirmation page. Fixed text, no user content; the script reads
// the fragment and POSTs only when the button is pressed.
const FREEZE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Freeze bento/id keys</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1e2a3a;background:#fff}
button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:0;background:#b3261e;color:#fff;cursor:pointer}
button:disabled{opacity:.5}</style></head><body>
<h1>Freeze your bento/id keys?</h1>
<p>Do this if your devices were lost or stolen. Freezing stops every key linked to this address from working, so nobody can use them or change them.</p>
<p><strong>Only your recovery code can unfreeze it.</strong> Without one, the address stays frozen until it expires.</p>
<p><button id="go" type="button">Freeze my keys</button></p>
<p id="msg" role="status"></p>
<script src="/freeze.js"></script></body></html>`
const FREEZE_JS = `(() => {
  const q = new URLSearchParams(location.hash.slice(1)), go = document.getElementById('go'), msg = document.getElementById('msg')
  let email = ''
  try { email = new TextDecoder().decode(Uint8Array.from(atob((q.get('e') || '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))) } catch {}
  const token = q.get('t') || ''
  if (!email || !token) { go.disabled = true; msg.textContent = 'This link is incomplete. Open it again from the email.'; return }
  go.addEventListener('click', async () => {
    go.disabled = true
    const r = await fetch('/v1/freeze/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, token }) }).catch(() => null)
    msg.textContent = r && r.ok ? 'Frozen. Use your recovery code in bento/home to set up new keys.' : 'This link has expired or was already used.'
  })
})()`
const page = (text, type = 'text/html; charset=utf-8') => new Response(text, {
  status: 200,
  headers: {
    'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  },
})

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
export const freezeLink = (to, token) => `https://id.bento.page/freeze#e=${b64uEnc(new TextEncoder().encode(to))}&t=${token}`

export async function sendCode(env, to, code, fp, kind, freezeToken = null) {
  let subject, body
  if (kind === 'freeze') {
    subject = 'Freeze your bento/id address'
    body = [
      'Someone asked to freeze the bento/id keys linked to this address.',
      '',
      'If your devices were lost or stolen, open this link and press the button to freeze them:',
      freezeLink(to, freezeToken),
      '',
      'Opening the link does nothing on its own. Once frozen, only your recovery code can unfreeze it.',
      'If you did not ask for this, ignore this email. The link expires in 24 hours.',
    ].join('\n')
  } else if (kind === 'rotate') {
    subject = 'Your bento/id key change code'
    body = [
      `Your code: ${code}`,
      '',
      `Enter it in bento/home on your own device to move this address to the new key ${fp}.`,
      'The change takes effect 72 hours after you enter the code. Until then, any of your devices can stop it.',
      'Bento will never ask for this code anywhere else. The code expires in 20 minutes.',
      '',
      'If you did not ask for this, someone may have your device. Freeze your keys here:',
      freezeLink(to, freezeToken),
      'Opening the link does nothing on its own. Once frozen, only your recovery code can unfreeze it.',
    ].join('\n')
  } else {
    subject = kind === 'delete' ? 'Your bento/id removal code' : 'Your bento/id code'
    body = [
      `Your code: ${code}`,
      '',
      kind === 'delete'
        ? 'Enter it on the bento/id account-deletion page to remove this address from the directory.'
        : `Enter it in bento/home on your own device to link this address to the key ${fp}.`,
      'Bento will never ask for this code anywhere else. If you did not ask for it, ignore this email.',
      'The code expires in 20 minutes.',
    ].join('\n')
  }
  if (env.MAILER && typeof env.MAILER.send === 'function') return env.MAILER.send({ to, subject, body, code, kind, freezeToken }) // the rig's seam
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

    // The emailed freeze link opens this page. A GET never changes anything
    // (mail scanners pre-fetch links); the page's button makes the POST, and the
    // token rides in the URL fragment, which no server or log ever sees.
    if (p === '/freeze' && req.method === 'GET') return page(FREEZE_HTML)
    if (p === '/freeze.js' && req.method === 'GET') return page(FREEZE_JS, 'text/javascript')

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

    // --- consent challenges (audience `dir`, §9.6c) --------------------------------
    // Issued to anyone for any well-formed address: a challenge reveals nothing,
    // is stored nowhere, and is good only at that address for 60 seconds.
    if (p === '/v1/challenge') {
      const email = normalize(b.email ?? '')
      if (!email) return json(400, { error: 'bad-address' })
      if (!(await ledger(env, ip, 'challenge'))) return json(429, { error: 'rate-limited' })
      const challenge = await issueChallenge(env.CHALLENGE_KEY, AUDIENCE, await addressKey(email), Date.now())
      return json(200, { challenge, audience: AUDIENCE, ttlMs: CHALLENGE_TTL_MS })
    }

    // --- rotation (security §25: active → pending 72 h → active) -----------------
    // OFF unless ROTATION=1. A pending window is only safe once an old-key holder
    // can contest it ("this wasn't me"), and that needs a kernel statement that
    // does not exist yet. Until then the email-only freeze is the sole contest.
    if (p === '/v1/rotate/start' || p === '/v1/rotate/complete') {
      if (env.ROTATION !== '1') return json(404, { error: 'not-found' })
      if (p === '/v1/rotate/start') {
        const binding = await readBind(b.stmt, b.sig, Date.now())
        if (!binding) return json(400, { error: 'bad-statement' })
        const email = normalize(binding.address)
        if (!email || email !== binding.address) return json(400, { error: 'bad-address' })
        const scope = await addressKey(email)
        const ch = await openChallenge(env.CHALLENGE_KEY, AUDIENCE, scope, b.challenge, Date.now())
        if (!ch) return json(400, { error: 'invalid', reason: 'challenge' })
        if (!(await ledger(env, ip, 'rotate'))) return json(429, { error: 'rate-limited' })
        const r = await call(env.ADDRESS.get(env.ADDRESS.idFromName(scope)), 'rotateStart', {
          stmt: b.stmt, sig: b.sig, oldSig: b.oldSig, challenge: b.challenge, nonce: ch.nonce, scope, consent: b.consent,
        })
        if (r.body.mail) {
          try { await sendCode(env, email, r.body.mail.code, r.body.mail.fp, 'rotate', r.body.mail.freezeToken) } catch (e) { console.log(`mail failed: ${e.message}`) }
          return json(202, { ok: true })
        }
        return json(r.status, r.body)
      }
      const email = normalize(b.email ?? '')
      if (!email || !codeOk(b.code) || typeof b.sig !== 'string') return json(400, { error: 'invalid' })
      if (!(await ledger(env, ip, 'complete'))) return json(429, { error: 'rate-limited' })
      const r = await call(await addressStub(env, email), 'rotateComplete', { code: b.code, sig: b.sig })
      return json(r.status, r.body)
    }

    // --- the email-only freeze (security §25) -----------------------------------
    if (p === '/v1/freeze/start') {
      const email = normalize(b.email ?? '')
      if (!email) return json(400, { error: 'bad-address' })
      if (!(await ledger(env, ip, 'start'))) return json(202, { ok: true })
      const r = await call(await addressStub(env, email), 'freezeStart', {})
      if (r.body.mail) {
        try { await sendCode(env, email, '', '', 'freeze', r.body.mail.freezeToken) } catch (e) { console.log(`mail failed: ${e.message}`) }
      }
      return json(202, { ok: true }) // whether or not anything was mailed
    }

    if (p === '/v1/freeze/complete') {
      const email = normalize(b.email ?? '')
      if (!email || !tokenOk(b.token)) return json(400, { error: 'invalid' })
      if (!(await ledger(env, ip, 'complete'))) return json(429, { error: 'rate-limited' })
      const r = await call(await addressStub(env, email), 'freezeComplete', { token: b.token })
      return json(r.status, r.body)
    }

    return json(404, { error: 'not-found' })
  },
}

// --- one Durable Object per ADDRESS ------------------------------------------------
// Storage: `cur` (the live binding: exact statement text, holder signature,
// attestation inputs; after a rotation also `rotSig`, the PREVIOUS key's
// signature over this statement), `chain` (hashes of every earlier binding for
// this address), `pend` (a pending code), `mail` (send times, for the
// per-address limits), `tomb` (a deletion), and the binding STATE (security §25):
// `rot` (a pending rotation: the next binding, contestable until `until`),
// `frz` (a freeze), `fpend` (an emailed freeze token), `spent` (consent
// challenges already used here). Strongly consistent per address, so a re-bind,
// a rotation and a lookup can never race into a mixed answer.
//
// States: active (no `rot`, no `frz`) · pending (`rot`) · frozen (`frz`).
// A pending rotation becomes active LAZILY, on the first request after its 72
// hours, so no timer is needed to be right; the answer is the same either way.

export class Address {
  constructor(state, env) { this.state = state; this.env = env }

  async fetch(req) {
    const a = await req.json()
    const now = Date.now()
    const s = this.state.storage
    const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const refuse = (reason) => out(400, { error: 'invalid', reason })

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
    const tokenHash = (t) => sha256hex(`bento-dir/1/freeze\n${t}`)
    const fail = async (p) => { p.attempts++; await s.put('pend', p); return out(400, { error: 'invalid' }) }

    // a pending rotation whose 72 hours passed uncontested becomes the binding
    const settle = async () => {
      const rot = await s.get('rot')
      if (!rot || now < rot.until || (await s.get('frz'))) return
      const cur = await s.get('cur')
      if (cur) await s.put('chain', [...((await s.get('chain')) || []), cur.h])
      await s.put('cur', { stmt: rot.stmt, sig: rot.sig, rotSig: rot.oldSig, h: rot.h, b: rot.b, verifiedAt: rot.at, rebound: false })
      await s.delete(['rot', 'fpend'])
    }
    await settle()
    const live = async () => { const c = await s.get('cur'); return c && c.b.expires > now ? c : null }
    const stateOf = async () => ((await s.get('frz')) ? 'frozen' : (await s.get('rot')) ? 'pending' : 'active')
    const freeze = async (by) => {
      const cur = await live()
      await s.put('frz', { at: now, by, h: cur ? cur.h : null })
      await s.delete(['rot', 'pend', 'fpend']) // a freeze ends any rotation in flight
    }
    /** spend a consent challenge HERE, before anything else is checked (§24b: spend-first) */
    const spend = async (nonce) => {
      const spent = Object.fromEntries(Object.entries((await s.get('spent')) || {}).filter(([, t]) => t > now))
      if (typeof nonce !== 'string' || Object.hasOwn(spent, nonce)) return false
      spent[nonce] = now + 2 * CHALLENGE_TTL_MS
      await s.put('spent', spent)
      return true
    }

    if (a.op === 'start') {
      if (!(await mayMail())) return out(202, { mail: null })
      const b = await readBind(a.stmt, a.sig, now)
      if (!b) return out(202, { mail: null })
      const cur = await live()
      // a LIVE binding never moves to another key by email alone (security §25):
      // that is the 72-hour contestable rotation. And while it is pending or
      // frozen, nothing renews it either: neither key is honoured in a freeze.
      if (cur && (cur.b.key !== b.accountPub || (await stateOf()) !== 'active')) return out(202, { mail: null })
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
      const lv = cur && cur.b.expires > now ? cur : null
      if (lv) {
        if (b.accountPub !== lv.b.key) return fail(p) // re-checked: it may have gone live since start
        if ((await stateOf()) !== 'active') return fail(p) // pending or frozen since start
        if (b.seq !== lv.b.seq + 1 || b.prev !== lv.h) return fail(p)
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
      // over an expired binding, whatever state it was in goes with it
      await s.delete(['pend', 'tomb', 'rot', 'frz', 'fpend'])
      return out(200, { binding: p.stmt, sig: p.sig, attestation: att.text, attestationSig: att.sig, rebound })
    }

    if (a.op === 'lookup') {
      const cur = await live()
      if (cur) {
        // a FRESH issuedAt on every answer, so a client can tell a replayed old
        // answer by age; the STATE is inside the signature. While pending, this is
        // the OLD binding and pins do not move; while frozen, no ✓ and nothing is
        // wrapped to either key.
        const state = await stateOf()
        const dirKey = await importDirKey(this.env.DIR_KEY_JWK)
        const att = await attest(dirKey, this.env.DIR_KID, cur.h, cur.verifiedAt, now, state)
        const body = { binding: cur.stmt, sig: cur.sig, attestation: att.text, attestationSig: att.sig, state, chain: (await s.get('chain')) || [], rebound: !!cur.rebound }
        if (cur.rotSig) body.rotSig = cur.rotSig // the previous key's signature over this binding: pinners follow silently
        return out(200, body)
      }
      const tomb = await s.get('tomb')
      if (tomb) return out(410, { error: 'deleted', tombstone: tomb })
      return out(404, { error: 'not-found' }) // never existed, or expired: the same answer
    }

    const tombstone = async (by) => {
      const cur = await s.get('cur')
      await s.delete(['cur', 'pend', 'rot', 'frz', 'fpend'])
      if (!cur) return // nothing was bound: nothing to record
      const dirKey = await importDirKey(this.env.DIR_KEY_JWK)
      await s.put('tomb', await tombText(dirKey, this.env.DIR_KID, cur.h, cur.b.seq, now, by))
    }

    if (a.op === 'delete') {
      const cur = await s.get('cur')
      const b = cur && (await readBind(cur.stmt, cur.sig, cur.verifiedAt)) // the address, read from the statement itself
      if (!b || !Number.isSafeInteger(a.ts)) return out(400, { error: 'invalid' })
      // frozen: neither key is honoured (security §23.1b), and a holder delete
      // would clear the way for an email-only re-bind, undoing the freeze
      if (await s.get('frz')) return out(400, { error: 'invalid' })
      if (!(await verifyDel(buildDel(b.address, a.ts), a.sig, { accountPub: b.accountPub, now })).ok) return out(400, { error: 'invalid' })
      await tombstone('holder')
      return out(200, { deleted: true })
    }

    if (a.op === 'deleteStart') {
      // only an address with something to delete is mailed; the HTTP answer is 202 either way.
      // Only an EXPIRED binding can be removed by mailbox alone: a live one is
      // removed by its holder (del.), or frozen by email. Email never decides alone (security §25).
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

    // --- rotation: a new key, vouched for by the old one, consented, and proven by email
    if (a.op === 'rotateStart') {
      if (!(await spend(a.nonce))) return refuse('replay') // FIRST: every attempt consumes the challenge
      const cur = await live()
      if (!cur) return refuse('state')
      if ((await stateOf()) !== 'active') return refuse('state') // one rotation at a time; never out of a freeze
      const b = await readBind(a.stmt, a.sig, now) // signed by the NEW key
      const was = await readBind(cur.stmt, cur.sig, cur.verifiedAt)
      if (!b || !was || b.address !== was.address) return refuse('statement')
      if (b.accountPub === cur.b.key) return refuse('same-key') // a renewal, not a rotation
      if (b.seq !== cur.b.seq + 1 || b.prev !== cur.h) return refuse('sequence')
      // the OLD key vouches for the exact new statement: this is what lets pinners follow silently
      if (typeof a.oldSig !== 'string' || !(await verifyStatementSig(cur.b.key, a.oldSig, a.stmt))) return refuse('old-key')
      const c = await verifyDirConsent(this.env, {
        scope: a.scope, accountPub: cur.b.key, purpose: 'rotate', challenge: a.challenge, payloadText: a.stmt, consent: a.consent, now,
      })
      if (!c.ok) return refuse(`consent:${c.reason}`)
      if (!(await mayMail())) return out(429, { error: 'mail-limit' })
      const code = mintCode(), freezeToken = mintToken()
      await s.put('pend', { kind: 'rotate', stmt: a.stmt, sig: a.sig, oldSig: a.oldSig, codeHash: await codeHash(code), expires: now + LIMITS.codeTtlMs, attempts: 0 })
      await s.put('fpend', { hash: await tokenHash(freezeToken), expires: now + LIMITS.freezeTokenTtlMs, attempts: 0 })
      return out(202, { mail: { code, fp: (await hashOf(b.accountPub)).slice(0, 8), freezeToken } })
    }

    if (a.op === 'rotateComplete') {
      const p = await pending('rotate')
      if (!p) return out(400, { error: 'invalid' })
      const b = await readBind(p.stmt, p.sig, now)
      const h = await hashOf(p.stmt)
      if (!b || !same(await codeHash(a.code), p.codeHash)) return fail(p)
      if (!(await verifyCmp(buildCmp(h, a.code), a.sig, { accountPub: b.accountPub, bindText: p.stmt })).ok) return fail(p)
      const cur = await live()
      if (!cur || (await stateOf()) !== 'active' || b.prev !== cur.h || b.seq !== cur.b.seq + 1) return fail(p) // moved since start
      await s.put('rot', { stmt: p.stmt, sig: p.sig, oldSig: p.oldSig, h, b: { key: b.accountPub, seq: b.seq, expires: b.expires }, at: now, until: now + LIMITS.rotationWindowMs })
      await s.delete('pend')
      return out(200, { state: 'pending', activeAt: now + LIMITS.rotationWindowMs })
    }

    // --- the email-only freeze: a mailed single-use token, used only by a deliberate POST
    if (a.op === 'freezeStart') {
      const cur = await live()
      if (!cur || (await s.get('frz')) || !(await mayMail())) return out(202, { mail: null })
      const freezeToken = mintToken()
      await s.put('fpend', { hash: await tokenHash(freezeToken), expires: now + LIMITS.freezeTokenTtlMs, attempts: 0 })
      return out(202, { mail: { freezeToken } })
    }

    if (a.op === 'freezeComplete') {
      const f = await s.get('fpend')
      if (!f || f.expires <= now || f.attempts >= LIMITS.codeAttempts) return out(400, { error: 'invalid' })
      if (!same(await tokenHash(a.token), f.hash)) { f.attempts++; await s.put('fpend', f); return out(400, { error: 'invalid' }) }
      // (`frz` here is belt and braces: a freeze deletes `fpend`, so a used token is already gone)
      if (!(await live()) || (await s.get('frz'))) return out(400, { error: 'invalid' })
      // resolvable ONLY by the recovery code (or the org), never by a device's
      // old key: the case this exists for is a thief holding the devices
      await freeze('email')
      return out(200, { state: 'frozen' })
    }

    return out(400, { error: 'bad-op' })
  }
}

// --- one Durable Object per passkey CREDENTIAL (§9.1, §9.3) ---------------------------
// Named by b64u sha256(credentialId). Holds `cred`: { scope (the storage name of
// the address it belongs to), pub (raw P-256), signCount, be, attachment,
// devicePub, created }, plus `fails` and `lockedUntil`. Registration and the
// PRF-wrapped blob arrive with the key-blob store; this class only verifies
// assertions.

export class Cred {
  constructor(state, env) { this.state = state; this.env = env }

  async fetch(req) {
    const a = await req.json()
    const now = Date.now()
    const s = this.state.storage
    const res = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

    if (a.op === 'assert') {
      const cred = await s.get('cred')
      if (!cred || cred.scope !== a.scope) return res({ ok: false, reason: 'unknown' }) // one answer for both
      if (((await s.get('lockedUntil')) || 0) > now) return res({ ok: false, reason: 'locked' })
      const v = await verifyAssertion(cred, a.assertion, { challenge: a.challenge, origins: new Set(a.origins) })
      if (!v.ok) {
        const fails = ((await s.get('fails')) || 0) + 1
        if (fails >= LIMITS.credFailures) { await s.put('lockedUntil', now + LIMITS.credLockMs); await s.put('fails', 0) } else await s.put('fails', fails)
        return res(v)
      }
      await s.put('cred', { ...cred, signCount: v.signCount })
      await s.put('fails', 0)
      return res({ ok: true })
    }

    return res({ ok: false, reason: 'bad-op' })
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
