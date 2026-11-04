// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// WebAuthn assertion checks the directory runs against a credential it stores
// (registration-time checks arrive with the key-blob store). The public key
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

/** The origins accepted for a passkey ASSERTION or REGISTRATION (§9.3): the whole
 *  set. A desktop native origin is self-asserted and advisory: it is accepted
 *  here, but earns nothing, and is never consent evidence (consentOrigins). */
export function assertionOrigins(env) {
  const set = new Set(ORIGINS.map((o) => o.origin))
  for (const o of consentOrigins(env)) set.add(o)
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

// --- registration (§9.3) -------------------------------------------------------------

/** Minimal CBOR (RFC 8949) for attestation objects and COSE keys: definite
 *  lengths only, no tags, no floats. Returns [value, nextOffset] or throws. */
function cbor(b, i = 0, depth = 0) {
  if (depth > 8 || i >= b.length) throw new Error('cbor')
  const ib = b[i++], major = ib >> 5, ai = ib & 31
  let n
  if (ai < 24) n = ai
  else if (ai === 24) n = b[i++]
  else if (ai === 25) { n = (b[i] << 8) | b[i + 1]; i += 2 }
  else if (ai === 26) { n = ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]); i += 4 }
  else throw new Error('cbor')
  if (n === undefined || i > b.length) throw new Error('cbor')
  switch (major) {
    case 0: return [n, i]
    case 1: return [-1 - n, i]
    case 2: case 3: {
      if (i + n > b.length) throw new Error('cbor')
      const v = b.slice(i, i + n)
      return [major === 2 ? v : new TextDecoder('utf-8', { fatal: true }).decode(v), i + n]
    }
    case 4: { const arr = []; for (let k = 0; k < n; k++) { let v; [v, i] = cbor(b, i, depth + 1); arr.push(v) } return [arr, i] }
    case 5: {
      const m = new Map()
      for (let k = 0; k < n; k++) {
        let key, v
        ;[key, i] = cbor(b, i, depth + 1)
        ;[v, i] = cbor(b, i, depth + 1)
        if (m.has(key)) throw new Error('cbor')
        m.set(key, v)
      }
      return [m, i]
    }
    case 7: if (ai === 20 || ai === 21 || ai === 22) return [ai === 21 ? true : ai === 20 ? false : null, i]
  }
  throw new Error('cbor')
}

/**
 * Check a registration (navigator.credentials.create) and return what the Cred
 * stores: { ok, credentialId (b64u), pub (raw P-256), signCount, be }. ES256 only;
 * attestation "none" only (the directory learns no authenticator model). Never
 * throws on bad input.
 */
export async function parseRegistration(attObj, cdjBytes, { challenge, origins }) {
  const no = (reason) => ({ ok: false, reason })
  let cd
  try { cd = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(cdjBytes)) } catch { return no('grammar') }
  if (!cd || typeof cd !== 'object') return no('grammar')
  if (cd.type !== 'webauthn.create') return no('type')
  if (typeof cd.challenge !== 'string' || cd.challenge !== challenge) return no('challenge')
  if (typeof cd.origin !== 'string' || !origins.has(cd.origin)) return no('origin')
  if (cd.crossOrigin !== undefined && cd.crossOrigin !== false) return no('cross-origin')
  if (Object.hasOwn(cd, 'topOrigin')) return no('cross-origin')

  let ao, end
  try { [ao, end] = cbor(attObj) } catch { return no('grammar') }
  if (end !== attObj.length || !(ao instanceof Map)) return no('grammar')
  if (ao.get('fmt') !== 'none') return no('attestation')
  const st = ao.get('attStmt')
  if (!(st instanceof Map) || st.size !== 0) return no('attestation')
  const ad = ao.get('authData')
  if (!(ad instanceof Uint8Array) || ad.length < 55) return no('grammar')
  if (!eq(ad.slice(0, 32), await sha256(new TextEncoder().encode(RP_ID)))) return no('rp')
  const flags = ad[32]
  if (!(flags & 0x01) || !(flags & 0x04)) return no('flags') // UP and UV
  if (!(flags & 0x40)) return no('flags') // AT: attested credential data present
  if ((flags & 0x10) && !(flags & 0x08)) return no('flags') // backed up but not backup-eligible
  const signCount = new DataView(ad.buffer, ad.byteOffset + 33, 4).getUint32(0)
  const idLen = (ad[53] << 8) | ad[54]
  if (idLen === 0 || idLen > 1023 || 55 + idLen > ad.length) return no('grammar')
  const credentialId = ad.slice(55, 55 + idLen)
  let cose, after
  try { [cose, after] = cbor(ad, 55 + idLen) } catch { return no('key') }
  if (after !== ad.length && !(flags & 0x80)) return no('grammar') // trailing bytes only as extensions
  if (!(cose instanceof Map) || cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) return no('key') // EC2, ES256, P-256
  const x = cose.get(-2), y = cose.get(-3)
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) return no('key')
  const raw = new Uint8Array(65); raw[0] = 4; raw.set(x, 1); raw.set(y, 33)
  try { await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']) } catch { return no('key') }
  return { ok: true, credentialId: b64uEnc(credentialId), pub: b64uEnc(raw), signCount, be: !!(flags & 0x08) }
}
