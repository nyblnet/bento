// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// WebAuthn assertion checks the directory runs against a credential it stores
// (identity-directory §9.3 step 2, §9.6c step 5). The credential's public key
// is kept as a raw uncompressed P-256 point (ES256 only), converted from COSE
// once, at registration.

import { b64uDec, b64uEnc } from './statements.js'

export const RP_ID = 'bento.page'

/**
 * The clientDataJSON.origin allow-list: an EXACT string match against a closed
 * set (security §33/§33a). No prefix match, no URL parsing. It changes only by
 * reviewed PR. Ids not yet known (the Android release hash, the published
 * extension store ids) are added when they exist; until then those origins are
 * refused.
 *
 * `browserBound` marks origins the platform vouches for. Desktop native
 * origins are SELF-ASSERTED (security §26.2): any local program can claim them,
 * so they are never evidence and are not accepted for consent.
 */
export const ORIGINS = Object.freeze([
  { origin: 'https://bento.page', browserBound: true },
  { origin: 'bento-desktop:linux', browserBound: false },
  { origin: 'bento-desktop:windows', browserBound: false },
  // { origin: 'android:apk-key-hash:<release hash>', browserBound: true },   // M2
  // { origin: 'chrome-extension://<store id>', browserBound: true },        // when the listing exists
])

/** The origins accepted for directory-verified CONSENT: browser-bound ones only.
 *  Development extension ids come from DEV_ORIGINS, and only when DEV=1, so the
 *  production directory never loads them. Firefox is not in the set (§33a). */
export function consentOrigins(env) {
  const set = new Set(ORIGINS.filter((o) => o.browserBound).map((o) => o.origin))
  if (env && env.DEV === '1' && typeof env.DEV_ORIGINS === 'string') {
    for (const o of JSON.parse(env.DEV_ORIGINS)) if (typeof o === 'string') set.add(o)
  }
  return set
}

const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

/** A DER ECDSA signature as raw r‖s (64 bytes), or null. */
export function derToRaw(der) {
  if (!(der instanceof Uint8Array) || der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) return null
  const out = new Uint8Array(64)
  let i = 2
  for (let part = 0; part < 2; part++) {
    if (der[i] !== 0x02) return null
    const len = der[i + 1]
    let v = der.slice(i + 2, i + 2 + len)
    if (v.length !== len || len === 0) return null
    while (v.length > 1 && v[0] === 0) v = v.slice(1)
    if (v.length > 32) return null
    out.set(v, part * 32 + 32 - v.length)
    i += 2 + len
  }
  return i === der.length ? out : null
}

/**
 * Check one assertion. `cred` is the stored record ({ pub, signCount });
 * `challenge` is the exact string clientDataJSON.challenge must carry. Returns
 * { ok: true, signCount } or { ok: false, reason }. It never throws on bad input.
 */
export async function verifyAssertion(cred, a, { challenge, origins }) {
  const no = (reason) => ({ ok: false, reason })
  if (!a || typeof a !== 'object') return no('grammar')
  const authData = b64uDec(a.authenticatorData ?? '')
  const cdjBytes = b64uDec(a.clientDataJSON ?? '')
  const der = b64uDec(a.signature ?? '')
  if (!authData || !cdjBytes || !der || authData.length < 37) return no('grammar')

  let cd
  try { cd = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(cdjBytes)) } catch { return no('grammar') }
  if (!cd || typeof cd !== 'object') return no('grammar')
  if (cd.type !== 'webauthn.get') return no('type')
  if (typeof cd.challenge !== 'string' || cd.challenge !== challenge) return no('challenge')
  if (typeof cd.origin !== 'string' || !origins.has(cd.origin)) return no('origin')
  if (cd.crossOrigin !== undefined && cd.crossOrigin !== false) return no('cross-origin')
  if (Object.hasOwn(cd, 'topOrigin')) return no('cross-origin')

  if (!eq(authData.slice(0, 32), await sha256(new TextEncoder().encode(RP_ID)))) return no('rp')
  const flags = authData[32]
  if (!(flags & 0x01) || !(flags & 0x04)) return no('flags') // UP and UV
  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0)

  const raw = derToRaw(der)
  const pub = b64uDec(cred.pub ?? '')
  if (!raw || !pub || pub.length !== 65) return no('signature')
  let good = false
  try {
    const key = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const signed = new Uint8Array(authData.length + 32)
    signed.set(authData, 0)
    signed.set(await sha256(cdjBytes), authData.length)
    good = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, signed)
  } catch { good = false }
  if (!good) return no('signature')

  // monotonic when non-zero; 0 is accepted, because synced passkeys report 0
  if (signCount !== 0 && signCount <= (cred.signCount ?? 0)) return no('sign-count')
  return { ok: true, signCount: Math.max(signCount, cred.signCount ?? 0) }
}

/** The storage name of a credential: b64u sha256(credentialId). */
export async function credKey(credentialIdB64u) {
  const id = b64uDec(credentialIdB64u ?? '')
  if (!id || id.length === 0 || id.length > 1023) return null
  return b64uEnc(await sha256(id))
}
