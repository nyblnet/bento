// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The key-blob store (D1c): what lets a person get their account key back on a
// new device without any device of theirs to hand it over.
//
//  · PASSKEYS. Each passkey's PRF output wraps the account key into a blob kept
//    in that credential's `Cred` object. Adding or removing one is an
//    account-signed `dreq.` plus consent (the first passkey and code may instead
//    ride on the bind's two proofs: the Address object's setup allowance);
//    fetching one is a WebAuthn assertion.
//  · THE RECOVERY CODE. The device derives a verifier from the code (Argon2id,
//    its own salt) and wraps the account key under another derivation of it. The
//    directory stores the verifier only as an HMAC under a per-account pepper
//    key, and the wrapped key sealed under a second one; the pepper is a Worker
//    secret, never in storage. A correct verifier starts a 72-hour wait, every
//    attempt notifies, and only then is the code-wrapped blob released. A code
//    that was used is spent.
//  · THE ACCESS LEDGER. One end-to-end encrypted blob per account, padded to
//    fixed size buckets.
//
// `Account` is one Durable Object per ADDRESS (named like Address, so it survives
// an account-key rotation); every record in it names the account key it belongs
// to, and material for any other key is treated as gone.

import { b64uDec, b64uEnc } from './statements.js'
import { pepperKeys, pepperOpen, pepperSeal, pepperVerifierTag } from './pepper.js'
import { addressKey, normalize } from './address.js'
import { issueChallenge, openChallenge, CHALLENGE_TTL_MS } from './challenge.js'
import { AUDIENCE } from './consent.js'
import { assertionOrigins, credKey, parseRegistration } from './webauthn.js'

const HOUR = 3_600_000
export const KEYS = Object.freeze({
  maxCreds: 10, // passkeys per account (§9.3)
  rcAttemptsPerDay: 5, // verifier checks per account per 24 h (§9.4)
  rcFailLock: 5, // consecutive wrong verifiers that lock recovery
  rcLockMs: 24 * HOUR,
  rcWaitMs: 72 * HOUR, // a correct verifier releases the blob only after this
  ledgerMin: 4096,
  ledgerMax: 1 << 20, // 1 MiB
})
export const CRED_AUDIENCE = 'cred' // a passkey fetch's challenge: tied to no address (a discoverable get names none)

/** The padding buckets: integer 12.5% steps from 4 KiB (the link store's rule). */
export function bucket(x) {
  let b = KEYS.ledgerMin
  while (b < x) b += b >> 3
  return b
}
export const isBucket = (n) => Number.isSafeInteger(n) && n <= KEYS.ledgerMax && bucket(n) === n

// --- the enrolment body: the exact bytes the rc-enrol dreq. hashes ------------------
// UTF-8 JSON with exactly these keys, each base64url of a fixed length. The
// directory parses the same bytes it hashed, so there is no canonical form to
// agree on. inner = saltW ‖ iv ‖ ct is the code-wrapped blob, opaque here.
const RC_FIELDS = { v: null, saltV: 16, verifier: 32, saltW: 16, iv: 12, ct: 80 }
export function parseEnrolment(bytes) {
  let j
  try { j = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return null }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  const keys = Object.keys(j)
  if (!keys.every((k) => Object.hasOwn(RC_FIELDS, k)) || j.v !== 1) return null // a missing field fails below
  const out = {}
  for (const [k, len] of Object.entries(RC_FIELDS)) {
    if (len === null) continue
    const b = typeof j[k] === 'string' ? b64uDec(j[k]) : null
    if (!b || b.length !== len || b64uEnc(b) !== j[k]) return null
    out[k] = b
  }
  const inner = new Uint8Array(16 + 12 + 80)
  inner.set(out.saltW, 0); inner.set(out.iv, 16); inner.set(out.ct, 28)
  return { saltV: out.saltV, verifier: out.verifier, inner }
}

/** The pepper versions this Worker holds: PEPPER_V<n> secrets, 32 bytes base64url. */
export function peppers(env) {
  const m = new Map()
  for (const [k, v] of Object.entries(env)) {
    const x = /^PEPPER_V([1-9][0-9]{0,3})$/.exec(k)
    const b = x && typeof v === 'string' ? b64uDec(v) : null
    if (b && b.length === 32) m.set(Number(x[1]), b)
  }
  return m
}
const currentPepper = (env) => {
  const m = peppers(env)
  if (!m.size) throw new Error('no PEPPER_V<n> secret is configured')
  const v = Math.max(...m.keys())
  return { v, key: m.get(v) }
}

function eqBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}
const sha256hex = async (text) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('')
const ticketHash = (t) => sha256hex(`bento-dir/1/rc-ticket\n${t}`)
/** The storage key of "this account key has had a credential or a code" (§39.3). */
const everKey = async (accountPub) => `ever:${await sha256hex(`bento-dir/1/ever\n${accountPub}`)}`

const call = async (stub, op, args) => {
  const r = await stub.fetch('https://do/op', { method: 'POST', body: JSON.stringify({ op, ...args }) })
  return { status: r.status, body: await r.json() }
}
const accountStub = (env, scope) => env.ACCOUNT.get(env.ACCOUNT.idFromName(scope))
const addressStub = (env, scope) => env.ADDRESS.get(env.ADDRESS.idFromName(scope))
const credStub = (env, key) => env.CRED.get(env.CRED.idFromName(key))

/** A fake but stable salt for an address with no recovery enrolled, so the answer
 *  doesn't say whether one is. */
async function fakeSalt(env, scope) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.CHALLENGE_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const m = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`bento-dir/1/rc-salt\n${scope}`)))
  return b64uEnc(m.slice(0, 16))
}

/**
 * An account-signed request: open the dir challenge for this address, then let
 * the Address object spend it FIRST and verify the dreq. (and, for cred-add,
 * cred-del and rc-enrol, the consent) against the binding it serves.
 */
async function authorize(env, email, b, subject) {
  const scope = await addressKey(email)
  const ch = await openChallenge(env.CHALLENGE_KEY, AUDIENCE, scope, b.challenge, Date.now())
  if (!ch) return { ok: false, reason: 'challenge', scope }
  const r = await call(addressStub(env, scope), 'authorize', {
    nonce: ch.nonce, challenge: b.challenge, req: b.req, sig: b.sig, subject, consent: b.consent ?? null, scope,
  })
  return r.status === 200 ? { ok: true, scope, ...r.body } : { ok: false, reason: r.body.reason, scope }
}

/**
 * The /v1/status, /v1/recovery/*, /v1/cred/* and /v1/ledger/* routes. Returns a
 * Response, or null when `p` is none of them.
 * deps: { json, ledger, notify(scope, kind, fp) }
 */
export async function keysRoute(p, b, env, ip, deps) {
  const ours = p === '/v1/status' || p.startsWith('/v1/recovery/') || p.startsWith('/v1/cred/') || p.startsWith('/v1/ledger/')
  if (!ours) return null
  const { json, ledger, notify } = deps
  // OFF unless KEYSTORE=1 (and a PEPPER_V<n> secret is set): branch-only until reviewed and deployed.
  if (env.KEYSTORE !== '1') return json(404, { error: 'not-found' })
  const bytes = (x, max = 4096) => { const v = typeof x === 'string' ? b64uDec(x) : null; return v && v.length > 0 && v.length <= max && b64uEnc(v) === x ? v : null }

  // --- the signed status read: state + the short event list (§9.7) -----------------
  if (p === '/v1/status') {
    const email = normalize(b.email ?? '')
    if (!email || typeof b.req !== 'string' || typeof b.sig !== 'string') return json(400, { error: 'invalid' })
    if (!(await ledger(env, ip, 'keys'))) return json(429, { error: 'rate-limited' })
    const a = await authorize(env, email, b, { op: 'status' })
    if (!a.ok) return json(400, { error: 'invalid', reason: a.reason })
    // contested (security's ruling): here, to the key holder only; never in the public lookup
    return json(200, { state: a.state, events: a.events, ...(a.pending ? { pending: a.pending } : {}), ...(a.contested === true ? { contested: true } : {}) })
  }

  // --- passkeys ---------------------------------------------------------------------
  if (p === '/v1/cred/challenge') {
    if (!(await ledger(env, ip, 'challenge'))) return json(429, { error: 'rate-limited' })
    return json(200, { challenge: await issueChallenge(env.CHALLENGE_KEY, CRED_AUDIENCE, '', Date.now()), ttlMs: CHALLENGE_TTL_MS })
  }

  if (p === '/v1/cred/add') {
    const email = normalize(b.email ?? '')
    const att = bytes(b.attestationObject, 8192), cdj = bytes(b.clientDataJSON)
    if (!email || !att || !cdj || typeof b.req !== 'string' || typeof b.sig !== 'string') return json(400, { error: 'invalid' })
    if (!(await ledger(env, ip, 'keys'))) return json(429, { error: 'rate-limited' })
    const a = await authorize(env, email, b, { op: 'cred-add', attestationObject: b.attestationObject, clientDataJSON: b.clientDataJSON })
    if (!a.ok) return json(400, { error: 'invalid', reason: a.reason })
    // the ceremony's challenge is the dir challenge this request spent
    const reg = await parseRegistration(att, cdj, { challenge: b.challenge, origins: assertionOrigins(env) })
    if (!reg.ok) return json(400, { error: 'invalid', reason: `registration:${reg.reason}` })
    const blob = b.blob
    const ck = await credKey(reg.credentialId)
    if (!prfBlobOk(blob, ck)) return json(400, { error: 'invalid', reason: 'blob' })
    const attachment = b.attachment === 'platform' || b.attachment === 'cross-platform' ? b.attachment : null // a LABEL, never evidence
    const devicePub = typeof b.devicePub === 'string' && b.devicePub.length <= 100 ? b.devicePub : null
    const ix = await call(accountStub(env, a.scope), 'credAdd', { key: ck, accountPub: a.accountPub, setup: a.setup === true, grace: a.grace === true })
    if (ix.status !== 200) return json(ix.status, ix.body)
    const r = await call(credStub(env, ck), 'register', {
      rec: { scope: a.scope, accountPub: a.accountPub, pub: reg.pub, signCount: reg.signCount, be: reg.be, attachment, devicePub, created: Date.now(), blob },
    })
    if (r.status !== 200) {
      await call(accountStub(env, a.scope), 'credDel', { key: ck })
      return json(r.status, r.body)
    }
    // a new-key credential ends the rotation grace. If this call is lost the Account
    // still refuses the grace (`grace-over`), and the old passkeys go at the 30 days.
    try { await call(addressStub(env, a.scope), 'credLanded', {}) } catch (e) { console.log(`credLanded failed: ${e.message}`) }
    await notify(a.scope, 'cred-add', ck.slice(0, 8), { setup: a.setup === true })
    return json(200, { ok: true })
  }

  if (p === '/v1/cred/del') {
    const email = normalize(b.email ?? '')
    const id = bytes(b.credentialId, 1023)
    if (!email || !id || typeof b.req !== 'string' || typeof b.sig !== 'string') return json(400, { error: 'invalid' })
    if (!(await ledger(env, ip, 'keys'))) return json(429, { error: 'rate-limited' })
    const a = await authorize(env, email, b, { op: 'cred-del', credentialId: b.credentialId })
    if (!a.ok) return json(400, { error: 'invalid', reason: a.reason })
    const ck = await credKey(b.credentialId)
    const ix = await call(accountStub(env, a.scope), 'credDel', { key: ck })
    if (ix.status !== 200) return json(ix.status, ix.body)
    await call(credStub(env, ck), 'delete', { scope: a.scope })
    await notify(a.scope, 'cred-del', ck.slice(0, 8))
    return json(200, { ok: true })
  }

  if (p === '/v1/cred/get') {
    if (!(await ledger(env, ip, 'keys'))) return json(429, { error: 'rate-limited' })
    const ch = await openChallenge(env.CHALLENGE_KEY, CRED_AUDIENCE, '', b.challenge, Date.now())
    const ck = b.assertion && typeof b.assertion === 'object' ? await credKey(b.assertion.credentialId) : null
    if (!ch || !ck) return json(400, { error: 'invalid' })
    const r = await call(credStub(env, ck), 'get', { nonce: ch.nonce, challenge: b.challenge, assertion: b.assertion, origins: [...assertionOrigins(env)] })
    if (r.status !== 200) return json(400, { error: 'invalid', reason: r.body.reason })
    // released only for the CURRENT account key, and never while frozen
    const st = await call(addressStub(env, r.body.scope), 'peek', {})
    if (!st.body.live) return json(400, { error: 'invalid', reason: 'orphaned' })
    // an old key's blob opens to a superseded key: never served, grace or no grace
    if (st.body.accountPub !== r.body.accountPub) return json(400, { error: 'invalid', reason: 'stale' })
    if (st.body.state === 'frozen') return json(409, { error: 'state' })
    await notify(r.body.scope, 'cred-fetch', ck.slice(0, 8)) // every fetch notifies (§9.3)
    return json(200, { blob: r.body.blob })
  }

  // --- the recovery code --------------------------------------------------------------
  if (p === '/v1/recovery/enrol') {
    const email = normalize(b.email ?? '')
    const body = bytes(b.body)
    const parsed = body && parseEnrolment(body)
    if (!email || !parsed || typeof b.req !== 'string' || typeof b.sig !== 'string') return json(400, { error: 'invalid' })
    if (!(await ledger(env, ip, 'keys'))) return json(429, { error: 'rate-limited' })
    const a = await authorize(env, email, b, { op: 'rc-enrol', body: b.body })
    if (!a.ok) return json(400, { error: 'invalid', reason: a.reason })
    const r = await call(accountStub(env, a.scope), 'rcEnrol', { accountPub: a.accountPub, body: b.body, setup: a.setup === true })
    if (r.status !== 200) return json(r.status, r.body)
    await notify(a.scope, 'rc-enrol', '', { setup: a.setup === true })
    return json(200, { ok: true })
  }

  if (p === '/v1/recovery/salt') {
    const email = normalize(b.email ?? '')
    if (!email) return json(400, { error: 'bad-address' })
    if (!(await ledger(env, ip, 'recovery'))) return json(429, { error: 'rate-limited' })
    const scope = await addressKey(email)
    const r = await call(accountStub(env, scope), 'rcSalt', {})
    return json(200, { saltV: r.body.saltV ?? await fakeSalt(env, scope) })
  }

  if (p === '/v1/recovery/start' || p === '/v1/recovery/release') {
    const email = normalize(b.email ?? '')
    const verifier = bytes(b.verifier, 32)
    if (!email || !verifier || verifier.length !== 32) return json(400, { error: 'invalid' })
    if (p === '/v1/recovery/release' && typeof b.ticket !== 'string') return json(400, { error: 'invalid' })
    if (!(await ledger(env, ip, 'recovery'))) return json(429, { error: 'rate-limited' })
    const scope = await addressKey(email)
    const st = await call(addressStub(env, scope), 'peek', {})
    if (!st.body.live) return json(400, { error: 'invalid' })
    const start = p === '/v1/recovery/start'
    const r = await call(accountStub(env, scope), start ? 'rcStart' : 'rcRelease', { accountPub: st.body.accountPub, verifier: b.verifier, ticket: b.ticket })
    // every counted attempt, right or wrong, notifies; a refusal past the daily
    // count or while locked is listed but not mailed (it would be a mail cannon)
    if (r.body.notify) await notify(scope, r.body.notify, '', { mail: !r.body.quiet })
    const { notify: _, quiet: __, ...body } = r.body
    return json(r.status, body)
  }

  // --- the access ledger ---------------------------------------------------------------
  // A read or a write needs an account-key signature over a fresh challenge (§9.5),
  // and kernel's closed dreq. op set has no ledger op yet. Until it does, these
  // answer 501; the Account object below already enforces the buckets and the key.
  if (p === '/v1/ledger/get' || p === '/v1/ledger/put') return json(501, { error: 'not-implemented', reason: 'needs-kernel-op' })

  return json(404, { error: 'not-found' })
}

/** A PRF blob as kernel's sealPrfBlob makes it, for THIS credential. */
function prfBlobOk(blob, ck) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return false
  const keys = Object.keys(blob).sort().join(',')
  if (keys !== 'cred,ct,iv,salt,v' || blob.v !== 1 || blob.cred !== ck) return false
  const len = (s) => { const v = typeof s === 'string' ? b64uDec(s) : null; return v && b64uEnc(v) === s ? v.length : -1 }
  return len(blob.salt) === 32 && len(blob.iv) === 12 && len(blob.ct) === 80
}

// --- one Durable Object per ADDRESS for the account's material ------------------------
// Storage: `creds` (credential storage names), `owners` (each one's account key:
// what tells a new key's passkey from one left by the key before it), `rc` (the peppered verifier and the
// sealed code-wrapped blob, with the account key they belong to and the pepper
// version), `rcLog` (attempt times, last 24 h), `rcFails`, `rcLock`, `rel` (a
// pending release: its ticket hash and when it opens), `led` (the ledger blob),
// `ever:<hash of an account key>` (that key has had a credential or a code: what
// the setup allowance asks, set once and never cleared, by a cred-del or a wipe; only
// `everEnd` ends it, which the Address object sends once a deleted binding's own expiry
// passes with no re-bind).

export class Account {
  constructor(state, env) { this.state = state; this.env = env }

  async fetch(req) {
    const a = await req.json()
    const now = Date.now()
    const s = this.state.storage
    const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const refuse = (reason, extra = {}) => out(400, { error: 'invalid', reason, ...extra })
    /** does this key hold a passkey here? Asked beside the write it guards: the rotation
     *  grace ends at the new key's first credential, so two adds in flight can't both land */
    const holds = async (pub) => Object.values((await s.get('owners')) || {}).includes(pub)

    if (a.op === 'credAdd') {
      const creds = (await s.get('creds')) || []
      if (creds.includes(a.key)) return refuse('exists')
      if (creds.length >= KEYS.maxCreds) return refuse('limit')
      if (a.setup === true && creds.length) return refuse('filled') // the setup allowance fills an empty slot, never adds to one
      if (a.grace === true && (await holds(a.accountPub))) return refuse('grace-over')
      const ever = await everKey(a.accountPub)
      await s.put('creds', [...creds, a.key])
      await s.put('owners', { ...((await s.get('owners')) || {}), [a.key]: a.accountPub })
      await s.put(ever, true)
      return out(200, { ok: true })
    }
    if (a.op === 'credDel') {
      const creds = (await s.get('creds')) || []
      if (!creds.includes(a.key)) return refuse('unknown')
      await s.put('creds', creds.filter((k) => k !== a.key))
      const { [a.key]: _, ...owners } = (await s.get('owners')) || {}
      await s.put('owners', owners)
      return out(200, { ok: true })
    }

    if (a.op === 'rcEnrol') {
      const parsed = parseEnrolment(b64uDec(a.body))
      if (!parsed) return refuse('body')
      const { v, key } = currentPepper(this.env)
      const pk = await pepperKeys(key, a.accountPub)
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const rec = {
        v, accountPub: a.accountPub, saltV: b64uEnc(parsed.saltV),
        tag: b64uEnc(await pepperVerifierTag(pk.verifyKey, parsed.verifier)),
        iv: b64uEnc(iv), ct: b64uEnc(await pepperSeal(pk.wrapKey, iv, parsed.inner, a.accountPub)), at: now,
      }
      const ever = await everKey(a.accountPub)
      // read after the awaits above, beside the write: the setup allowance never replaces a code
      if (a.setup === true && (await s.get('rc'))) return refuse('filled')
      await s.put('rc', rec)
      await s.put(ever, true)
      await s.delete('rel') // a new code ends any release in flight for the old one
      return out(200, { ok: true })
    }

    if (a.op === 'everHad') return out(200, { ever: (await s.get(await everKey(a.accountPub))) === true })

    if (a.op === 'rcSalt') {
      const rc = await s.get('rc')
      return out(200, { saltV: rc ? rc.saltV : null })
    }

    if (a.op === 'rcStart' || a.op === 'rcRelease' || a.op === 'rcResolve') {
      const start = a.op === 'rcStart', resolve = a.op === 'rcResolve'
      const kind = a.op === 'rcRelease' ? 'rc-release' : 'rc-attempt'
      if (((await s.get('rcLock')) || 0) > now) return refuse('locked', { notify: kind, quiet: true })
      const log = ((await s.get('rcLog')) || []).filter((t) => now - t < 24 * HOUR)
      if (log.length >= KEYS.rcAttemptsPerDay) return refuse('limit', { notify: kind, quiet: true })
      await s.put('rcLog', [...log, now])
      const wrong = async (reason) => {
        const fails = ((await s.get('rcFails')) || 0) + 1
        if (fails >= KEYS.rcFailLock) { await s.put('rcLock', now + KEYS.rcLockMs); await s.put('rcFails', 0) } else await s.put('rcFails', fails)
        return refuse(reason, { notify: kind })
      }

      let rc = await s.get('rc')
      if (rc && rc.keepUntil && rc.keepUntil <= now) { await s.delete(['rc', 'rel']); rc = null } // a deleted binding's window is over (§39.6)
      // orphaned by a rotation (§9.4b); a resolution names the FROZEN binding's key, so it never orphans one
      if (rc && rc.accountPub !== a.accountPub) { if (!resolve) await s.delete(['rc', 'rel']); rc = null }
      if (!rc) return wrong('invalid')
      const pep = peppers(this.env).get(rc.v)
      if (!pep) return refuse('pepper', { notify: kind }) // never a version this Worker doesn't hold
      const pk = await pepperKeys(pep, rc.accountPub)
      const verifier = b64uDec(a.verifier)
      if (!eqBytes(await pepperVerifierTag(pk.verifyKey, verifier), b64uDec(rc.tag))) return wrong('invalid')

      if (resolve) {
        // the code is right, but it is NOT spent here: a resolution that waits (an
        // email-only or contested freeze) can still be voided by the frozen key, and
        // a voided one must leave the code usable. The Address object spends it
        // (dropOld) when the resolution COMMITS, at once or at settle (§39.3, §28a).
        // A code enrolled just before a freeze is not a factor a thief lacks: key +
        // passkey can enrol one a minute earlier. So the enrolment time goes back, read
        // here on the record that verified, for the Address object to hold against
        // `frz.at`. `at` is set only by rcEnrol, so nothing else makes a code older.
        await s.put('rcFails', 0)
        return out(200, { ok: true, enrolledAt: rc.at })
      }

      if (start) {
        await s.put('rcFails', 0)
        // the raw verifier is in hand: move an old pepper version's record to the current one
        const cur = currentPepper(this.env)
        if (rc.v !== cur.v) {
          const inner = await pepperOpen(pk.wrapKey, b64uDec(rc.iv), b64uDec(rc.ct), rc.accountPub)
          if (inner) {
            const nk = await pepperKeys(cur.key, rc.accountPub)
            const iv = crypto.getRandomValues(new Uint8Array(12))
            await s.put('rc', { ...rc, v: cur.v, tag: b64uEnc(await pepperVerifierTag(nk.verifyKey, verifier)), iv: b64uEnc(iv), ct: b64uEnc(await pepperSeal(nk.wrapKey, iv, inner, rc.accountPub)) })
          }
        }
        const prev = await s.get('rel')
        const ticket = b64uEnc(crypto.getRandomValues(new Uint8Array(32)))
        const until = prev ? prev.until : now + KEYS.rcWaitMs // a second start never shortens or restarts the wait
        await s.put('rel', { until, th: await ticketHash(ticket) })
        return out(200, { ticket, releaseAt: until, notify: kind })
      }

      const rel = await s.get('rel')
      if (!rel || (await ticketHash(String(a.ticket))) !== rel.th) return wrong('ticket')
      if (now < rel.until) return refuse('early', { releaseAt: rel.until, notify: kind })
      const inner = await pepperOpen(pk.wrapKey, b64uDec(rc.iv), b64uDec(rc.ct), rc.accountPub)
      if (!inner) return refuse('blob', { notify: kind })
      // a code that was used is spent (§28a): the device enrols a new one
      await s.delete(['rc', 'rel'])
      await s.put('rcFails', 0)
      return out(200, { inner: b64uEnc(inner), notify: kind })
    }

    if (a.op === 'ledgerPut') {
      const blob = b64uDec(a.blob ?? '')
      if (!blob || !isBucket(blob.length)) return refuse('size')
      await s.put('led', { accountPub: a.accountPub, blob: a.blob, at: now })
      return out(200, { ok: true })
    }
    if (a.op === 'ledgerGet') {
      const led = await s.get('led')
      if (led && led.accountPub !== a.accountPub) { await s.delete('led'); return out(404, { error: 'not-found' }) } // replaced on rotation (§9.5)
      return led ? out(200, { blob: led.blob }) : out(404, { error: 'not-found' })
    }

    if (a.op === 'going') {
      // the names a wipe (no `keep`) or a rekey is about to take, and nothing is taken:
      // the Address object writes them down first. Those calls' answers can be lost after
      // they commit, and the list here is the only other memory of the Cred objects
      const creds = (await s.get('creds')) || [], owners = (await s.get('owners')) || {}
      return out(200, { creds: a.keep ? creds.filter((k) => !a.keep.includes(owners[k])) : creds })
    }
    if (a.op === 'wipe') {
      const creds = (await s.get('creds')) || []
      await s.delete(a.keepRc ? ['creds', 'owners', 'led'] : ['creds', 'owners', 'rc', 'rcLog', 'rcFails', 'rcLock', 'rel', 'led'])
      if (a.keepRc) {
        // kept for the deleted binding's window only (§39.6): deleted at its expiry
        // at the latest, by the alarm, or sooner when the window closes (rekey)
        const rc = await s.get('rc')
        if (rc && Number.isSafeInteger(a.keepUntil)) { await s.put('rc', { ...rc, keepUntil: a.keepUntil }); await s.setAlarm(a.keepUntil) }
      }
      return out(200, { creds })
    }
    if (a.op === 'everEnd') {
      // the Address object's word that a deleted binding's own expiry has passed with no
      // re-bind and its wipe has finished. Material here all the same (a passkey that
      // landed just behind the wipe) means a key may be back: the rows stay.
      const rc = await s.get('rc')
      if (rc && rc.keepUntil && rc.keepUntil <= now) await s.delete(['rc', 'rel']) // the alarm's job, if it has not run
      else if (rc) return out(200, { held: true })
      if (((await s.get('creds')) || []).length) return out(200, { held: true })
      const rows = [...(await s.list({ prefix: 'ever:' })).keys()]
      for (let i = 0; i < rows.length; i += 128) await s.delete(rows.slice(i, i + 128))
      return out(200, { ok: true })
    }
    if (a.op === 'rekey') {
      // only the passkeys of the keys in `keep` stay (the Address object may be retrying,
      // and the new key may have added one since), and with `rc`, only a recovery record
      // of theirs: a grace ending leaves the code slot alone. The caller deletes the Cred
      // objects of the passkeys this answers with, and never of one in `stays`.
      const keep = a.keep, creds = (await s.get('creds')) || [], owners = (await s.get('owners')) || {}
      const stays = creds.filter((k) => keep.includes(owners[k]))
      await s.put('creds', stays)
      await s.put('owners', Object.fromEntries(stays.map((k) => [k, owners[k]])))
      const rc = await s.get('rc')
      if (a.rc === true && rc && !keep.includes(rc.accountPub)) await s.delete(['rc', 'rel'])
      return out(200, { creds: creds.filter((k) => !stays.includes(k)), stays })
    }
    if (a.op === 'rcKeep') {
      const rc = await s.get('rc')
      if (rc && rc.accountPub === a.accountPub && rc.keepUntil) { const { keepUntil: _, ...kept } = rc; await s.put('rc', kept) }
      return out(200, { ok: true })
    }
    return out(400, { error: 'bad-op' })
  }

  async alarm() {
    const rc = await this.state.storage.get('rc')
    if (rc && rc.keepUntil && rc.keepUntil <= Date.now()) await this.state.storage.delete(['rc', 'rel'])
  }
}

