// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// The consent route under option G: a native app's consent key (a `ck` roster
// member) speaking for the account through a `cns.` (kernel/src/statements.ts).
//
// The rules (kernel/src/roster.ts, "consent keys"; security's rulings on KG3):
//
// - The directory checks a cns. LIVE with the kernel's verifyConsent, which
//   RECOMPUTES the transcript from the directory's own audience (`dir`), the
//   challenge it issued (the dirNonce the payload names) and the exact payload
//   it is about to apply. Nothing in the request is trusted for those three.
//   The challenge itself was spent before any check (the Roster object's
//   spend, one per request), so verifyConsent is passed `spend: () => true`
//   and never spends a second time.
// - The PURPOSE is the caller's, fixed in code, never read from the request:
//   a roster co-sign is never a web-add one, and the payload's family must be
//   the purpose's.
// - It then runs the same offline check every peer will run on the stored link
//   (kernel memberProof, so verifyCoSign at the link's requestedAt), so the
//   directory never accepts a link a peer would refuse.
// - RIPENESS has one source: the directory's own stored chain, run through the
//   kernel's verifyRosterChain, which gives each member's `since`. A ck is ripe
//   once `requestedAt - since >= 72 h`, measured at requestedAt (the directory's
//   clock when the request arrived), never at ripening and never from the
//   requester's `created`.

import { b64uDec, b64uEnc, verifyConsent } from '../../../kernel/src/statements.ts'
import { memberProof, verifyRosterChain, ROSTER_WAIT_MS } from '../../../kernel/src/roster.ts'
import { PASSKEY, passkeyOrigins } from './passkey.js'

/** The rp a consent key's cns. names. */
export const CONSENT_RP = 'bento'

/**
 * X5: any key added from a browser (a passkey or a consent key), on an account
 * that has a ripe consent key, waits this long unless that key co-signs it
 * (then it takes effect at once). Without a ripe consent key it waits the
 * usual 72 hours. A consent key is the MORE dangerous add (once ripe it acts
 * without a wait), so it never waits less than a passkey would.
 */
export const X5_WAIT_MS = 7 * 24 * 3_600_000

const no = (reason) => ({ ok: false, reason })

/**
 * One stored link as a peer receives it: the texts, the countersign, and the
 * proof of whoever asked (an assertion for a passkey, the cns. and its
 * signature for a consent key), the co-sign, and a void's evidence.
 */
export function linkOut(l) {
  const out = { ros: l.ros, rip: l.rip, ripSig: l.ripSig }
  if (l.kind === 'member') {
    out.signer = l.signer
    if (l.assertion !== undefined) out.assertion = l.assertion
    if (l.sig !== undefined) out.sig = l.sig
    if (l.cns !== undefined) out.cns = l.cns
    if (l.cosign !== undefined) out.cosign = l.cosign
  }
  if (l.voided) out.voided = l.voided
  return out
}

let own = null
/** A raw P-256 point (65 bytes, b64u) or null. */
const point = (v) => { const b = typeof v === 'string' ? b64uDec(v) : null; return b && b.length === 65 && b[0] === 4 ? v : null }
/**
 * The directory's own countersign keys, as a peer pins them: { [kid]: raw P-256
 * point }. The CURRENT key comes from DIR_KEY_JWK under DIR_KID; every key it
 * countersigned with before a rotation comes from DIR_RETIRED_KEYS (optional,
 * JSON, { kid: point }, the same points peers keep pinning). Without the
 * retired keys a chain countersigned before a rotation would not verify here,
 * so no ripeness could be read and every request on an account holding a
 * consent key would fail, a passkey's removal of a stolen key included.
 * DIR_RETIRED_KEYS never names DIR_KID, and holds nothing but points; anything
 * else refuses (no request is decided on a key set nobody meant).
 */
function ownKeys(env) {
  const retired = env.DIR_RETIRED_KEYS ?? ''
  if (own && own.jwk === env.DIR_KEY_JWK && own.kid === env.DIR_KID && own.retired === retired) return own.keys
  const j = JSON.parse(env.DIR_KEY_JWK)
  const x = b64uDec(j.x), y = b64uDec(j.y)
  if (!x || !y || x.length !== 32 || y.length !== 32) throw new Error('DIR_KEY_JWK is not a P-256 key')
  const raw = new Uint8Array(65)
  raw[0] = 4; raw.set(x, 1); raw.set(y, 33)
  const keys = Object.create(null)
  if (retired !== '') {
    const all = JSON.parse(retired)
    if (!all || typeof all !== 'object' || Array.isArray(all)) throw new Error('DIR_RETIRED_KEYS is not a { kid: key } object')
    for (const [kid, v] of Object.entries(all)) {
      if (kid === env.DIR_KID) throw new Error('DIR_RETIRED_KEYS names the current DIR_KID')
      if (!point(v)) throw new Error(`DIR_RETIRED_KEYS ${kid} is not a P-256 point`)
      keys[kid] = v
    }
  }
  keys[env.DIR_KID] = b64uEnc(raw)
  own = { jwk: env.DIR_KEY_JWK, kid: env.DIR_KID, retired, keys: Object.freeze(keys) }
  return own.keys
}

/** The options a peer verifies this directory's chain with. */
export const chainOpts = (env, now) => ({
  directoryKeys: ownKeys(env), rpId: PASSKEY.rpId, origins: passkeyOrigins(), now, consentRp: CONSENT_RP,
})

/**
 * Every member's `since` (the ripenedAt from which it has been a member
 * without a break), from the directory's own stored chain through the kernel's
 * verifier: the ONE source of ripeness. Throws when the stored chain does not
 * verify, so nothing is decided on a chain a peer would refuse.
 */
export async function sinceOf(storage, env, now) {
  const links = [...(await storage.list({ prefix: 'link:' })).values()].map(linkOut)
  const v = await verifyRosterChain(links, chainOpts(env, now))
  if (!v.ok) throw new Error(`the stored roster chain does not verify: ${v.reason}`)
  return new Map(v.value.members.map((m) => [m.pub, m.since]))
}

/** Ripe at `at`: a member for at least 72 hours by then, on the stored chain's `since`. */
export const ripeAt = (since, pub, at) => {
  const t = since.get(pub)
  return t !== undefined && at - t >= ROSTER_WAIT_MS
}

/**
 * A consent key's consent over `text`, checked live and then as a peer will
 * check it. `member` is the ck roster member that signed; `proof` is
 * `{ cns, sig }` from the request; `nonce` is the directory challenge the
 * payload names; `purpose` is the CALLER's ('roster'); `at` the directory's
 * clock now (the link's requestedAt).
 */
export async function ckConsent(member, proof, text, nonce, purpose, at) {
  if (!proof || typeof proof !== 'object' || typeof proof.cns !== 'string' || typeof proof.sig !== 'string') return no('proof')
  const live = await verifyConsent(proof.cns, proof.sig, {
    consentPub: member.pub, rp: CONSENT_RP, audience: 'dir', challenge: nonce, payloadText: text, docId: null, now: at,
    spend: () => true, // spent once, first, by the Roster object
  })
  if (!live.ok) return no(`consent-${live.reason}`)
  if (live.value.purpose !== purpose) return no('consent-purpose')
  if (purpose !== 'roster') return no('consent-purpose') // web-add arrives with route D
  const peer = await memberProof(member, { cns: proof.cns, sig: proof.sig }, text, nonce, at, { rpId: PASSKEY.rpId, origins: passkeyOrigins(), consentRp: CONSENT_RP })
  if (!peer.ok) return no(peer.reason)
  return { ok: true }
}

/**
 * A request's co-sign, `{ signer, cns, sig }`. It counts only from an
 * unquarantined ck of the CURRENT (pre-change) head that is not the requester
 * and is ripe at `at`. Anything else is a refusal, never ignored.
 */
export async function checkCosign(c, { head, requester, text, nonce, since, at }) {
  if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.signer !== 'string' || typeof c.cns !== 'string' || typeof c.sig !== 'string') return no('cosign')
  if (Object.keys(c).some((k) => !['signer', 'cns', 'sig'].includes(k))) return no('cosign')
  if (c.signer === requester) return no('cosign')
  const co = head.members.find((m) => m.pub === c.signer)
  if (!co) return no('cosign-signer')
  if (co.kind !== 'ck') return no('cosign-kind')
  if (co.quarantined) return no('cosign-quarantined')
  if (!ripeAt(since, co.pub, at)) return no('cosign-unripe')
  const v = await ckConsent(co, c, text, nonce, 'roster', at)
  if (!v.ok) return no(`cosign-${v.reason}`)
  return { ok: true, value: { signer: c.signer, cns: c.cns, sig: c.sig } }
}
