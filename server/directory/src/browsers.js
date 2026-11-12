// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// BROWSER CERTIFICATES and their countersign (option G, SD3).
//
// A browser holds a fresh, non-extractable device key W for each ceremony. A
// roster passkey certifies it on the sign-in host by an assertion over the
// kernel's `wdev.` text (kernel/src/devices.ts); this directory checks that
// assertion, logs the enrolment and answers a `watt.`: its countersign, good
// for at most 24 hours and never past 7 days after the ceremony (X4). A peer
// accepts the certificate only beside a current `watt.`, so a browser renews
// it by a `wren.` its device key signs, and once the 7 days are up only a new
// ceremony (a new key) carries on.
//
// The routes (the contract both callers build on):
//
// The sign-in host's, CORS to it alone, and its Origin is required:
//   POST /v1/web/challenge {address} → 200 {nonce, at, rosHash}; 404 no account
//   POST /v1/web/enrol {text, rq, assertion} → 200 {ok: true, wdev: text, watt}
// bento/home's, CORS to it alone, and its Origin is required:
//   POST /v1/home/challenge {address} → 200 {nonce}; 404 no account
//   POST /v1/home/checkin {wren, sig, pin?}
//     → 200 {watt, wattSig, signer, assertion, roster, incidents}
//     → 403 {error: unknown | revoked | cap, incidents}
// Anyone's (CORS *), for a peer holding a certificate:
//   GET /v1/device/status?e=<address>&c=<sha256 of the certificate text>
//     → 200 {state: ok | revoked | cap | unknown, incidents}
//
// The rules, in the order they are applied:
// - A challenge is sealed (challenge.js) for an AUDIENCE (web: an enrolment;
//   home: a renewal) and for the address, lives 60 seconds, and is spent in
//   the address's object BEFORE any other check, so a failed assertion, a
//   challenge of the other audience, a wrong ceremony time or an unknown key
//   each use it up. Nothing is stored when one is issued, so a stranger who
//   asks for many fills nothing and can push out nobody's challenge; a spent
//   one is kept only for its sweep window (roster.js spentKeepMs). A challenge
//   for another address does not open at all (the seal names the address).
// - Asking for a challenge costs one of the per-IP lookups (the same budget
//   as GET /v1/roster: both answer 404 for an address with no account) and one
//   of that IP's challenges FOR THAT ADDRESS. No limit is shared by everyone
//   who asks about an address: a shared one would let a stranger starve the
//   owner's browsers of renewals.
// - An enrolment names the challenge's own time as its ceremony time (the cap
//   counts from the directory's clock), the LATEST RIPENED roster head (a
//   change still waiting is not a head), and bento/home as the page that
//   asked (rq). Its passkey is an unquarantined member of that head, and the
//   assertion verifies for this rp with the sign-in host as its only origin,
//   with that credential's stored signature counter. The device key must be
//   new: a key enrols once (a fresh key per ceremony).
// - A renewal's `wren.` is verified (the device key signed it) BEFORE its
//   challenge is spent: only the browser that asked knows the challenge, so a
//   refused signature leaves it for that browser. The certificate must be
//   known, unrevoked, made by a passkey that is still an unquarantined member
//   and has been one since the ceremony, and inside its 7 days.
// - `ob` (in the countersign and in the log) is 1 exactly when the enrolment
//   was asked for at bento/home's request: the `rq` the sign-in host reported
//   is bento/home. Every web enrolment's Origin is the sign-in host, so `ob` is
//   never read from Origin. Nothing decides on it; the incident lever filters
//   by it.
// - Revoking (sign out everywhere in browsers; the incident lever) marks
//   every certificate the address holds: its renewals are refused at once, and
//   a peer stops accepting its last countersign when that expires (24 hours at
//   most). The request a member signs for it is a kernel layout, not defined
//   yet, so no route reaches it today.
// - `incidents` is every published incident record [{id, from, to}] (the
//   directory's clock, ms; `to` null while open), from the INCIDENTS variable.
//   A list that does not read is an error: nothing is countersigned under it.
//
// NOT HERE (each its own change): a `dev2.` made by a passkey alone (no native
// origin is measured yet, so no native assertion verifies); retiring the old
// key at a new ceremony and the `mb` field (both kernel layouts first); the
// mail for a new browser; the incident lever itself.

import { parseDeviceCert, buildWatt, verifyWren, CEREMONY_CAP_MS, WATT_MAX_MS } from '../../../kernel/src/devices.ts'
import { sha256b64u, signStatement } from '../../../kernel/src/statements.ts'
import { verifyAssertion, statementChallenge } from '../../../kernel/src/webauthn.ts'
import { HOME_ORIGIN, PASSKEY, SIGNIN_ORIGIN } from './passkey.js'
import { issueChallenge, openChallenge } from './challenge.js'
import { addressKey, normalize } from './address.js'
import { HOME_ROUTES, WEB_ROUTES } from './seam.js'

const DAY = 86_400_000

export const BROWSER_LIMITS = Object.freeze({
  /** a browser challenge's life: one ceremony or one renewal */
  challengeTtlMs: 60_000,
  /** a certificate past its 7 days is kept this much longer (status answers `cap`), then deleted; its log entry stays */
  keepAfterCapMs: DAY,
  /** at most this many certificates are looked at by each enrolment's sweep */
  sweep: 128,
  /** the most incident records the directory publishes */
  incidentsMax: 256,
})

/** The two audiences a browser challenge is sealed for. */
const AUDIENCES = Object.freeze(['web', 'home'])

/** The origin a browser route answers CORS to, or null for a route of anyone's. */
export function browserOrigin(path) {
  if (path.startsWith(WEB_ROUTES.prefix)) return SIGNIN_ORIGIN
  if (path.startsWith(HOME_ROUTES.prefix)) return HOME_ORIGIN
  return null
}

/**
 * Open a browser challenge for the address stored under `scope`, whichever
 * audience it was sealed for: the address's object spends it first and only
 * then compares the audience, so a challenge used at the wrong door is gone.
 */
async function openBrowser(env, scope, challenge, now) {
  for (const aud of AUDIENCES) {
    const c = await openChallenge(env.CHALLENGE_KEY, aud, scope, challenge, now, BROWSER_LIMITS.challengeTtlMs)
    if (c) return { ...c, aud }
  }
  return null
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/
/** The published incident records. Throws on anything that does not read: an answer is never built on half a list. */
export function incidentsOf(env) {
  const list = JSON.parse(env.INCIDENTS ?? '[]')
  if (!Array.isArray(list) || list.length > BROWSER_LIMITS.incidentsMax) throw new Error('INCIDENTS is not a list')
  return list.map((x) => {
    const ok = x && typeof x === 'object' && Object.keys(x).length === 3 && typeof x.id === 'string' && ID.test(x.id) &&
      Number.isSafeInteger(x.from) && x.from > 0 && (x.to === null || (Number.isSafeInteger(x.to) && x.to >= x.from))
    if (!ok) throw new Error('INCIDENTS holds a record that does not read')
    return { id: x.id, from: x.from, to: x.to }
  })
}

const B64U = /^[A-Za-z0-9_-]+$/
const TEXT_MAX = 2048
const FIELD_MAX = 4096
const field = (v) => typeof v === 'string' && v.length > 0 && v.length <= FIELD_MAX && B64U.test(v)

/**
 * The browser routes, from the worker. `k` carries the worker's helpers:
 * json(status, body) with this route's headers, ledger(key, kind), roster(email,
 * op, args) and body(req).
 */
export async function browserRoute(req, env, ip, p, k) {
  const { json, ledger, roster, body } = k
  // Origin is hygiene, not the gate (every write is a signature): a call from
  // any other page, or with none, is refused before anything is read
  if (req.headers.get('origin') !== browserOrigin(p)) return json(403, { error: 'origin' })
  const b = await body(req)
  if (!b) return json(400, { error: 'bad-request' })

  if (p === WEB_ROUTES.challenge || p === HOME_ROUTES.challenge) {
    const email = normalize(b.address)
    if (!email) return json(400, { error: 'bad-address' })
    // both answer 404 for an address with no account: the per-IP lookup budget
    if (!(await ledger(ip, 'lookup'))) return json(429, { error: 'rate-limited' })
    const scope = await addressKey(email)
    // one IP's challenges for one address; never a limit shared by every caller
    if (!(await ledger(`${ip}\n${scope}`, 'challengeAddr'))) return json(429, { error: 'rate-limited' })
    const r = await roster(email, 'browserHead', {})
    if (r.status !== 200) return json(r.status, r.body)
    const at = Date.now()
    const web = p === WEB_ROUTES.challenge
    const nonce = await issueChallenge(env.CHALLENGE_KEY, web ? 'web' : 'home', scope, at)
    return json(200, web ? { nonce, at, rosHash: r.body.rosHash } : { nonce })
  }

  if (p === WEB_ROUTES.enrol) {
    if (typeof b.text !== 'string' || !b.text.startsWith('wdev.') || b.text.length > TEXT_MAX) return json(400, { error: 'text' })
    // the opener the sign-in host read from the message event: only bento/home may ask
    if (b.rq !== HOME_ORIGIN) return json(400, { error: 'rq' })
    const as = b.assertion
    if (!as || typeof as !== 'object' || Array.isArray(as) ||
      !['id', 'authenticatorData', 'clientDataJSON', 'signature'].every((f) => field(as[f])) ||
      !(as.userHandle === null || as.userHandle === undefined || field(as.userHandle))) return json(400, { error: 'assertion' })
    if (!(await ledger(ip, 'enrol'))) return json(429, { error: 'rate-limited' })
    const c = await parseDeviceCert(b.text)
    if (!c.ok || c.value.kind !== 'wdev' || c.value.via !== 'passkey') return json(400, { error: 'text' })
    const ch = await openBrowser(env, await addressKey(c.value.address), c.value.dirNonce, Date.now())
    if (!ch) return json(400, { error: 'nonce' })
    const r = await roster(c.value.address, 'browserEnrol', {
      text: b.text, rq: b.rq, assertion: { id: as.id, authenticatorData: as.authenticatorData, clientDataJSON: as.clientDataJSON, signature: as.signature },
      nonce: ch.nonce, issued: ch.issued, aud: ch.aud, os: req.headers.get('origin'),
    })
    return json(r.status, r.body)
  }

  if (p === HOME_ROUTES.checkin) {
    if (typeof b.wren !== 'string' || typeof b.sig !== 'string' || b.wren.length > TEXT_MAX || b.sig.length > FIELD_MAX ||
      !(b.pin === undefined || (typeof b.pin === 'string' && b.pin.length <= 64))) return json(400, { error: 'bad-request' })
    if (!(await ledger(ip, 'checkin'))) return json(429, { error: 'rate-limited' })
    const incidents = incidentsOf(env) // first: an unreadable list countersigns nothing
    // signed by the device key it names; checked before the challenge is spent
    // (only the browser that asked knows it, so a refused signature leaves it)
    const v = await verifyWren(b.wren, b.sig)
    if (!v.ok) return json(400, { error: 'wren' })
    const ch = await openBrowser(env, await addressKey(v.value.address), v.value.challenge, Date.now())
    if (!ch) return json(400, { error: 'nonce' })
    const r = await roster(v.value.address, 'browserCheckin', { devicePub: v.value.devicePub, pin: b.pin, nonce: ch.nonce, issued: ch.issued, aud: ch.aud })
    return json(r.status, r.status === 200 || r.status === 403 ? { ...r.body, incidents } : r.body)
  }

  return json(404, { error: 'not-found' })
}

/** GET /v1/device/status?e=&c=: a certificate's standing, for any peer. */
export async function deviceStatus(env, ip, url, k) {
  const { json, ledger, roster } = k
  const email = normalize(url.searchParams.get('e') ?? '')
  const c = url.searchParams.get('c') ?? ''
  if (!email || !/^[A-Za-z0-9_-]{43}$/.test(c)) return json(400, { error: 'invalid' })
  if (!(await ledger(ip, 'lookup'))) return json(429, { error: 'rate-limited' })
  const incidents = incidentsOf(env)
  const r = await roster(email, 'browserStatus', { certHash: c })
  return json(r.status, r.status === 200 ? { ...r.body, incidents } : r.body)
}

// --- in the address's object (roster.js hands these ops here) ---------------------

export const BROWSER_OPS = Object.freeze(['browserHead', 'browserEnrol', 'browserCheckin', 'browserStatus', 'browserRevokeAll'])

let signer = null
/**
 * The countersign: a watt. over the certificate, signed with the directory's
 * online key, good for 24 hours and never past 7 days after the ceremony.
 * Throws when the key is not configured, before anything is stored.
 */
async function countersign(env, { certHash, ob, ceremonyAt, now }) {
  if (typeof env.DIR_KEY_JWK !== 'string' || typeof env.DIR_KID !== 'string') throw new Error('DIR_KEY_JWK and DIR_KID are not configured')
  if (!signer || signer.jwk !== env.DIR_KEY_JWK) {
    signer = { jwk: env.DIR_KEY_JWK, key: await crypto.subtle.importKey('jwk', JSON.parse(env.DIR_KEY_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) }
  }
  const expires = Math.min(now + WATT_MAX_MS, ceremonyAt + CEREMONY_CAP_MS)
  const text = buildWatt({ certHash, ob, loggedAt: now, expires, kid: env.DIR_KID })
  return { text, sig: await signStatement(signer.key, text) }
}

/**
 * A stored certificate's standing: revoked (signed out, the lever, or its
 * passkey removed, suspended or re-added since the ceremony), cap (its 7 days
 * are up) or ok.
 */
async function standing(s, rec, now) {
  if (rec.revokedAt) return 'revoked'
  const head = await s.get('head')
  const m = head?.members.find((x) => x.pub === rec.signer)
  if (!m || m.kind !== 'pk' || m.quarantined) return 'revoked'
  const pk = await s.get(`pk:${rec.signer}`)
  if (!pk || pk.addedAt > rec.ceremonyAt) return 'revoked'
  if (now >= rec.ceremonyAt + CEREMONY_CAP_MS) return 'cap'
  return 'ok'
}

/** The chain as kernel RosterLink objects, from the pinned head (or from setup). */
async function chainFrom(s, pin) {
  const links = [...(await s.list({ prefix: 'link:' })).values()].map((l) => {
    const out = { ros: l.ros, rip: l.rip, ripSig: l.ripSig }
    if (l.kind === 'member') { out.signer = l.signer; out.assertion = l.assertion }
    if (l.voided) out.voided = l.voided
    return out
  })
  let from = 0
  if (typeof pin === 'string') for (let i = 0; i < links.length; i++) if ((await sha256b64u(links[i].ros)) === pin) from = i
  return links.slice(from)
}

/** Delete the certificates past their 7 days and the keep after it (their log entries stay). */
async function sweep(s, now) {
  const dead = []
  for (const [key, rec] of await s.list({ prefix: 'wd:', limit: BROWSER_LIMITS.sweep })) {
    if (rec.ceremonyAt + CEREMONY_CAP_MS + BROWSER_LIMITS.keepAfterCapMs <= now) dead.push(key, `wh:${rec.certHash}`)
  }
  if (dead.length) await s.delete(dead)
}

/**
 * One browser op on the Roster object `obj`. `h.spend` is the object's own
 * spend (roster.js), `h.out` its answer, `h.origin` the request's Origin as
 * logged, `h.notify` its roster mail.
 */
export async function browserOp(obj, a, now, h) {
  const s = obj.state.storage
  const { spend, out } = h

  if (a.op === 'browserHead') {
    // the latest RIPENED head: a change that is due takes effect first, and a waiting one is never a head
    await obj.ripen(now)
    const head = await s.get('head')
    if (!head) return out(404, { error: 'not-found' })
    return out(200, { rosHash: head.hash })
  }

  if (a.op === 'browserEnrol') {
    if (!(await spend())) return out(400, { error: 'nonce' })
    if (a.aud !== 'web') return out(400, { error: 'nonce' }) // a renewal's challenge, used up here
    const p = await parseDeviceCert(a.text)
    if (!p.ok || p.value.kind !== 'wdev' || p.value.via !== 'passkey') return out(400, { error: 'text' })
    const c = p.value
    if (c.ceremonyAt !== a.issued) return out(400, { error: 'ceremony' })
    await obj.ripen(now)
    const head = await s.get('head')
    if (!head) return out(404, { error: 'not-found' })
    if (c.rosHash !== head.hash) return out(400, { error: 'head' })
    if (a.rq !== HOME_ORIGIN) return out(400, { error: 'rq' })
    const as = a.assertion
    const pub = as && typeof as.id === 'string' ? await s.get(`cid:${as.id}`) : undefined
    const m = pub ? head.members.find((x) => x.pub === pub) : undefined
    if (!m || m.kind !== 'pk' || m.quarantined) return out(403, { error: 'signer' })
    if (await s.get(`wd:${c.devicePub}`)) return out(409, { error: 'device-known' }) // a fresh key per ceremony
    const rec = await s.get(`pk:${pub}`)
    const assertion = { authenticatorData: as.authenticatorData, clientDataJSON: as.clientDataJSON, signature: as.signature }
    const v = await verifyAssertion(assertion, {
      publicKey: pub, challenge: await statementChallenge(a.text), rpId: PASSKEY.rpId, origins: [SIGNIN_ORIGIN], storedSignCount: rec?.signCount,
    })
    if (!v.ok) return out(403, { error: 'assertion' })
    const certHash = await sha256b64u(a.text)
    const ob = a.rq === HOME_ORIGIN ? 1 : 0
    // the countersign first: without the key nothing is stored, the counter included
    const w = await countersign(obj.env, { certHash, ob, ceremonyAt: c.ceremonyAt, now })
    if (rec) await s.put(`pk:${pub}`, { ...rec, signCount: v.value.signCount })
    await s.put(`wd:${c.devicePub}`, { certHash, signer: pub, assertion, ceremonyAt: c.ceremonyAt, rq: a.rq, ob, loggedAt: now, renewedAt: now, revokedAt: null })
    await s.put(`wh:${certHash}`, c.devicePub)
    await obj.log({ k: 'wdev', at: now, seq: head.seq, pub: c.devicePub, by: pub, os: h.origin, rq: a.rq, co: SIGNIN_ORIGIN })
    await sweep(s, now)
    return out(200, { ok: true, wdev: a.text, watt: w.text })
  }

  if (a.op === 'browserCheckin') {
    if (!(await spend())) return out(400, { error: 'nonce' })
    if (a.aud !== 'home') return out(400, { error: 'nonce' }) // an enrolment's challenge, used up here
    const rec = typeof a.devicePub === 'string' ? await s.get(`wd:${a.devicePub}`) : undefined
    if (!rec) return out(403, { error: 'unknown' })
    await obj.ripen(now)
    const st = await standing(s, rec, now)
    if (st !== 'ok') return out(403, { error: st })
    const w = await countersign(obj.env, { certHash: rec.certHash, ob: rec.ob, ceremonyAt: rec.ceremonyAt, now })
    await s.put(`wd:${a.devicePub}`, { ...rec, renewedAt: now })
    return out(200, { watt: w.text, wattSig: w.sig, signer: rec.signer, assertion: rec.assertion, roster: await chainFrom(s, a.pin) })
  }

  if (a.op === 'browserStatus') {
    const pub = typeof a.certHash === 'string' ? await s.get(`wh:${a.certHash}`) : undefined
    const rec = pub ? await s.get(`wd:${pub}`) : undefined
    if (!rec) return out(200, { state: 'unknown' })
    await obj.ripen(now)
    return out(200, { state: await standing(s, rec, now) })
  }

  if (a.op === 'browserRevokeAll') {
    // sign out everywhere in browsers (and the incident lever, for one address):
    // every certificate the address holds stops renewing at once
    const head = await s.get('head')
    if (!head) return out(404, { error: 'not-found' })
    let n = 0
    for (const [key, rec] of await s.list({ prefix: 'wd:' })) {
      if (rec.revokedAt) continue
      await s.put(key, { ...rec, revokedAt: now })
      n++
    }
    await obj.log({ k: 'signout', at: now, seq: head.seq, pub: typeof a.by === 'string' ? a.by : '', os: h.origin, rq: '', co: '', n })
    return out(200, { revoked: n })
  }

  return out(400, { error: 'bad-op' })
}
