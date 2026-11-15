// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A stand-in for the bento/id directory's browser routes, for the rigs, built
// on the kernel's own builders and verifiers. It is the CONTRACT the
// directory's routes must match (server/directory), until they exist:
//
// The sign-in host's routes (CORS to https://signin.id.bento.page alone; the
// request's Origin must be that host):
//
//   POST /v1/web/challenge { address }
//     → 200 { nonce, at, rosHash }: a single-use challenge (16-64 bytes,
//       base64url) bound to the account and to the web audience; `at` is the
//       directory's time for it, which the certificate names as its ceremony
//       time; rosHash is sha256 of the account's current roster head.
//     → 404 { error: 'not-found' } for an address with no account.
//   POST /v1/web/enrol { text, rq, assertion{ id, userHandle?, authenticatorData, clientDataJSON, signature } }
//     → 200 { ok: true, wdev: text, watt }. In this order: `text` parses as the
//       kernel's wdev. via passkey; its dirNonce is SPENT first (a known,
//       unspent web challenge under 60 s old); its address is the challenge's;
//       its ceremonyAt is exactly the challenge's `at`; its rosHash is the
//       current head; rq is https://home.bento.page; the credential id names a
//       passkey that is an unquarantined member of that head; the assertion
//       verifies (kernel verifyAssertion: rp id.bento.page, origins exactly the
//       sign-in host). Then it logs { os: the request's Origin, rq, devicePub },
//       stores the certificate with its signer and assertion, and answers a
//       watt.: loggedAt now, expires min(now + 24 h, ceremonyAt + 7 days), and
//       ob = 1 exactly when the enrolment was made at bento/home's request
//       (the logged rq is https://home.bento.page, as the sign-in host
//       reported it). Every web enrolment's Origin is the sign-in host, so ob
//       is never read from Origin. No verifier decides anything on ob.
//       mb is the account's mailbox state at that moment: 0 while the address
//       is confirmed, else the time it went unconfirmed (≤ loggedAt). Read
//       from the account, never defaulted: here `mailbox` (address → mb),
//       where an account not listed is confirmed.
//
// bento/home's routes (CORS to https://home.bento.page alone; Origin must be it):
//
//   POST /v1/home/challenge { address } → 200 { nonce }: single use, home audience.
//   POST /v1/home/checkin { wren, sig, pin? }
//     wren. verified by the kernel (verifyWren) under the device key it names;
//     its challenge spent first (home audience, the same address). Then:
//     → 403 { error: 'unknown', incidents } no certificate for that key;
//     → 403 { error: 'revoked', incidents } the key was revoked (the lever,
//       or "sign out everywhere");
//     → 403 { error: 'cap', incidents } at or past ceremonyAt + 7 days;
//     → 200 { watt, wattSig, signer, assertion, roster, incidents }: a fresh
//       watt. (as above) and the directory's signature over it, the certificate's
//       signer and assertion as stored, and the roster as kernel RosterLink
//       objects starting AT the pinned head (or at setup without a pin, or
//       with a pin that is not a head of this account).
//   `incidents` is every published incident record, [{ id, from, to }]
//   (directory clock, ms; `to` null while open). bento/home honours them.
//
// Every body is JSON sent as text/plain (a simple request, no preflight).
//
// `hostile` switches make it misbehave the ways a rig row must catch.

import { parseDeviceCert, buildWatt, verifyWren, CEREMONY_CAP_MS, WATT_MAX_MS } from '../../kernel/src/devices.ts'
import { b64uEnc, sha256b64u, signStatement } from '../../kernel/src/statements.ts'
import { parseRos } from '../../kernel/src/roster.ts'
import { verifyAssertion, statementChallenge } from '../../kernel/src/webauthn.ts'

export const HOME = 'https://home.bento.page'
export const SIGNIN = 'https://signin.id.bento.page'
const CHALLENGE_MS = 60_000

/**
 * accounts: Map address → RosterLink[] (from setup); credentials: Map
 * credential id (base64url) → passkey pub; key: { kid, key } signs watts;
 * now(): the directory's clock.
 */
export function directoryStub({ accounts, credentials, key, now }) {
  const nonces = new Map()
  const certs = new Map()          // devicePub → { cert, signer, assertion, ceremonyAt, address }
  const revoked = new Set()
  const mailbox = new Map()        // address → mb: absent = confirmed (0), else when it went unconfirmed
  const incidents = []
  const log = []
  const hostile = {}               // { watt48h, rogue: { kid, key, links } }

  const fresh = () => b64uEnc(crypto.getRandomValues(new Uint8Array(24)))
  const head = async (address) => {
    const links = accounts.get(address)
    if (!links) return null
    const last = links[links.length - 1]
    const h = await parseRos(last.ros)
    return { links, hash: await sha256b64u(last.ros), members: h.ok ? h.value.members : [] }
  }
  const spend = (n, aud, address) => {
    const c = nonces.get(n)
    if (!c || c.spent) return false
    c.spent = true
    return c.aud === aud && c.address === address && now() - c.at <= CHALLENGE_MS && c
  }
  const watt = async (c, signer = key) => {
    const t = now()
    const expires = hostile.watt48h ? t + 2 * WATT_MAX_MS : Math.min(t + WATT_MAX_MS, c.ceremonyAt + CEREMONY_CAP_MS)
    const text = buildWatt({ certHash: await sha256b64u(c.cert), ob: c.rq === HOME ? 1 : 0, mb: mailbox.get(c.address) ?? 0, loggedAt: t, expires, kid: signer.kid })
    return { text, sig: await signStatement(signer.key, text) }
  }

  async function handle({ method, path, origin, body }) {
    const web = path.startsWith('/v1/web/'), home = path.startsWith('/v1/home/')
    const headers = { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', vary: 'Origin',
      'access-control-allow-origin': web ? SIGNIN : home ? HOME : '*' }
    const out = (status, b) => ({ status, headers, body: JSON.stringify(b) })
    if (method !== 'POST') return out(404, { error: 'not-found' })
    if ((web && origin !== SIGNIN) || (home && origin !== HOME)) return out(403, { error: 'origin' })
    let b
    try { b = JSON.parse(body || '{}') } catch { return out(400, { error: 'bad-request' }) }
    if (!b || typeof b !== 'object') return out(400, { error: 'bad-request' })

    if (path === '/v1/web/challenge' || path === '/v1/home/challenge') {
      const h = await head(b.address)
      if (!h) return out(404, { error: 'not-found' })
      const nonce = fresh(), at = now()
      nonces.set(nonce, { aud: web ? 'web' : 'home', address: b.address, at, spent: false })
      log.push({ k: web ? 'web-challenge' : 'home-challenge', address: b.address, origin })
      return out(200, web ? { nonce, at, rosHash: h.hash } : { nonce })
    }

    if (path === '/v1/web/enrol') {
      const p = await parseDeviceCert(b.text)
      if (!p.ok || p.value.kind !== 'wdev' || p.value.via !== 'passkey') return out(400, { error: 'text' })
      const c = p.value
      const n = spend(c.dirNonce, 'web', c.address)
      if (!n) return out(400, { error: 'nonce' })
      if (c.ceremonyAt !== n.at) return out(400, { error: 'ceremony' })
      const h = await head(c.address)
      if (!h || c.rosHash !== h.hash) return out(400, { error: 'head' })
      if (b.rq !== HOME) return out(400, { error: 'rq' })
      const a = b.assertion
      const signer = a && credentials.get(a.id)
      if (!signer || !h.members.some((m) => m.kind === 'pk' && m.pub === signer && !m.quarantined)) return out(403, { error: 'signer' })
      const assertion = { authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, signature: a.signature }
      const v = await verifyAssertion(assertion, { publicKey: signer, challenge: await statementChallenge(b.text), rpId: 'id.bento.page', origins: [SIGNIN] })
      if (!v.ok) return out(403, { error: 'assertion' })
      const rec = { cert: b.text, signer, assertion, ceremonyAt: c.ceremonyAt, address: c.address, rq: b.rq }
      certs.set(c.devicePub, rec)
      log.push({ k: 'enrol', os: origin, rq: b.rq, W: c.devicePub, kx: c.kx, label: c.label, address: c.address, at: now() })
      return out(200, { ok: true, wdev: b.text, watt: (await watt(rec)).text })
    }

    if (path === '/v1/home/checkin') {
      const v = await verifyWren(b.wren, b.sig)
      if (!v.ok) return out(400, { error: 'wren' })
      if (!spend(v.value.challenge, 'home', v.value.address)) return out(400, { error: 'nonce' })
      const rec = certs.get(v.value.devicePub)
      log.push({ k: 'checkin', W: v.value.devicePub, pin: b.pin ?? null, at: now(), known: !!rec })
      if (!rec || rec.address !== v.value.address) return out(403, { error: 'unknown', incidents })
      if (revoked.has(v.value.devicePub)) return out(403, { error: 'revoked', incidents })
      if (now() >= rec.ceremonyAt + CEREMONY_CAP_MS) return out(403, { error: 'cap', incidents })
      const r = hostile.rogue
      const links = r ? r.links : accounts.get(rec.address)
      let from = 0
      if (typeof b.pin === 'string') for (let i = 0; i < links.length; i++) if ((await sha256b64u(links[i].ros)) === b.pin) from = i
      const w = await watt(rec, r ? { kid: r.kid, key: r.key } : key)
      return out(200, { watt: w.text, wattSig: w.sig, signer: rec.signer, assertion: rec.assertion, roster: links.slice(from), incidents,
        ...(r ? { keys: { [r.kid]: r.pub } } : {}) })
    }
    return out(404, { error: 'not-found' })
  }

  return { handle, certs, revoked, incidents, log, hostile, nonces, mailbox }
}
