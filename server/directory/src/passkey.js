// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// Passkeys on the directory: the relying party, the origins it accepts, and the
// two ceremonies it checks itself.
//
// - REGISTRATION (`webauthn.create`): the kernel verifies assertions only, so
//   the directory reads a new passkey's public key out of the authenticator
//   data here. The directory asks for attestation "none" and relies on no
//   attestation signature, so the checks are the client data (type, challenge,
//   origin, never cross-origin), the rp id hash, UP+UV, and an ES256 P-256 key.
// - ASSERTION (`webauthn.get`): kernel/src/webauthn.ts, with the rp id and the
//   origins below, and the stored signature counter of that one credential.
//   The directory sees each credential's assertions in the order they were
//   made, so it is the caller that passes the counter (security's ruling on
//   the kernel verifier).

import { b64uDec, b64uEnc } from '../../../kernel/src/statements.ts'
import { parseStrictJson, verifyAssertion, statementChallenge } from '../../../kernel/src/webauthn.ts'

/**
 * THE constant. The passkeys' relying party is id.bento.page, and the only
 * origins whose ceremonies count are listed here, each with the host class the
 * directory's mail names ("from a browser", "from an app").
 *
 * - `https://signin.id.bento.page` is the sign-in host: the one web origin that
 *   runs ceremonies.
 * - NOT `https://id.bento.page` (the directory itself never runs a ceremony), NOT
 *   `https://home.bento.page` (bento/home asks the sign-in host), NOT
 *   `https://bento.page`, and no other name under any of them.
 * - Native origins join as each is measured on a device (Apple's, Android's
 *   `android:apk-key-hash:…`). None is measured yet, so none is listed: until
 *   then a native assertion is refused, which fails closed.
 *
 * It changes only by a reviewed change to this file, and the rig pins it
 * against the kernel's ROSTER_RP_ID and ROSTER_WEB_ORIGINS.
 */
/**
 * The sign-in host. Mailed links open on it (links.js), and the /v1/web/*
 * routes answer CORS to it alone. It is written here once and listed below.
 */
export const SIGNIN_ORIGIN = 'https://signin.id.bento.page'

/**
 * The directory's own origin, the relying party's host. It serves JSON and
 * exactly one page, the void page a mailed void link opens (voidpage.js), and
 * it is never a ceremony origin: it is NOT in the list below.
 */
export const DIRECTORY_ORIGIN = 'https://id.bento.page'

export const PASSKEY = Object.freeze({
  rpId: 'id.bento.page',
  origins: Object.freeze({
    [SIGNIN_ORIGIN]: 'browser',
  }),
})

/** The origin list in the form the kernel verifier takes. */
export const passkeyOrigins = () => Object.keys(PASSKEY.origins)

/** COSE algorithm ES256: the only one registered. */
export const ES256 = -7

const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_BE = 0x08, FLAG_BS = 0x10, FLAG_AT = 0x40, FLAG_ED = 0x80
const MAX_AUTH_DATA = 2048
const MAX_CLIENT_DATA = 4096
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))
const same = (a, b) => {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}
const no = (reason) => ({ ok: false, reason })

// --- a small strict CBOR reader (definite lengths, no tags, no floats) ---------

class Bad extends Error {}

/**
 * Read one CBOR item from `b` at `at`. Returns [value, next]. Maps come back as
 * Maps with integer or text keys, and a repeated key throws, as does anything
 * indefinite, tagged, floating or deeper than 8.
 */
export function readCbor(b, at, depth = 0) {
  if (depth > 8 || at >= b.length) throw new Bad()
  const head = b[at]
  const major = head >> 5, info = head & 31
  let i = at + 1
  let n
  if (info < 24) n = info
  else if (info === 24) { if (i + 1 > b.length) throw new Bad(); n = b[i]; i += 1 }
  else if (info === 25) { if (i + 2 > b.length) throw new Bad(); n = (b[i] << 8) | b[i + 1]; i += 2 }
  else if (info === 26) { if (i + 4 > b.length) throw new Bad(); n = ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]; i += 4 }
  else throw new Bad() // 64-bit lengths, reserved values and indefinite lengths are never needed here
  switch (major) {
    case 0: return [n, i]
    case 1: return [-1 - n, i]
    case 2: if (i + n > b.length) throw new Bad(); return [b.slice(i, i + n), i + n]
    case 3: {
      if (i + n > b.length) throw new Bad()
      return [strictUtf8.decode(b.subarray(i, i + n)), i + n]
    }
    case 4: {
      const out = []
      for (let k = 0; k < n; k++) { const [v, j] = readCbor(b, i, depth + 1); out.push(v); i = j }
      return [out, i]
    }
    case 5: {
      const out = new Map()
      for (let k = 0; k < n; k++) {
        const [key, j] = readCbor(b, i, depth + 1)
        if (typeof key !== 'number' && typeof key !== 'string') throw new Bad()
        if (out.has(key)) throw new Bad()
        const [v, j2] = readCbor(b, j, depth + 1)
        out.set(key, v)
        i = j2
      }
      return [out, i]
    }
    case 7:
      if (info === 20) return [false, i]
      if (info === 21) return [true, i]
      if (info === 22) return [null, i]
      throw new Bad()
    default: throw new Bad() // tags
  }
}

/** A COSE_Key that is exactly an ES256 P-256 public key → the raw point, or a reason. */
async function coseToRaw(key) {
  if (!(key instanceof Map)) return no('key')
  if (key.get(3) !== ES256) return no('alg')
  if (key.size !== 5 || key.get(1) !== 2 || key.get(-1) !== 1) return no('key')
  const x = key.get(-2), y = key.get(-3)
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) return no('key')
  const raw = new Uint8Array(65)
  raw[0] = 4; raw.set(x, 1); raw.set(y, 33)
  try { await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']) } catch { return no('key') }
  return { ok: true, value: raw }
}

/**
 * Check a registration as `navigator.credentials.create` returns it, sent as
 * `{clientDataJSON, authenticatorData}` (base64url; the browser's
 * `getAuthenticatorData()`). `challenge` is the exact bytes the directory
 * issued. Returns `{credId, pub, signCount, be, bs, origin}` or a reason.
 * Never throws.
 */
export async function verifyRegistration(reg, challenge) {
  try { return await registration(reg, challenge) } catch { return no('grammar') }
}

async function registration(reg, challenge) {
  if (!reg || typeof reg !== 'object' || !(challenge instanceof Uint8Array) || challenge.length < 16) return no('grammar')
  const ad = b64uDec(reg.authenticatorData)
  const cdj = b64uDec(reg.clientDataJSON)
  if (!ad || !cdj || ad.length > MAX_AUTH_DATA || cdj.length > MAX_CLIENT_DATA || ad.length < 37 + 18) return no('grammar')

  let text
  try { text = strictUtf8.decode(cdj) } catch { return no('grammar') }
  const cd = parseStrictJson(text)
  if (cd === 'duplicate') return no('duplicate-key')
  if (!(cd instanceof Map)) return no('grammar')
  if (cd.get('type') !== 'webauthn.create') return no('type')
  const ch = cd.get('challenge')
  const chBytes = typeof ch === 'string' ? b64uDec(ch) : null
  if (!chBytes || !same(chBytes, challenge)) return no('challenge')
  const origin = cd.get('origin')
  if (typeof origin !== 'string' || !Object.hasOwn(PASSKEY.origins, origin)) return no('origin')
  if (cd.has('crossOrigin') && cd.get('crossOrigin') !== false) return no('cross-origin')
  if (cd.has('topOrigin')) return no('cross-origin')

  if (!same(ad.subarray(0, 32), await sha256(new TextEncoder().encode(PASSKEY.rpId)))) return no('rp')
  const flags = ad[32]
  if (!(flags & FLAG_UP)) return no('up')
  if (!(flags & FLAG_UV)) return no('uv')
  if (!(flags & FLAG_AT)) return no('grammar')
  if ((flags & FLAG_BS) && !(flags & FLAG_BE)) return no('grammar')
  const signCount = ((ad[33] << 24) >>> 0) + (ad[34] << 16) + (ad[35] << 8) + ad[36]

  // attested credential data: aaguid(16) ‖ credIdLen(2) ‖ credId ‖ COSE key
  let i = 37 + 16
  const idLen = (ad[i] << 8) | ad[i + 1]
  i += 2
  if (idLen < 16 || idLen > 1023 || i + idLen > ad.length) return no('grammar')
  const credId = ad.slice(i, i + idLen)
  i += idLen
  let key
  try { [key, i] = readCbor(ad, i) } catch { return no('grammar') }
  const k = await coseToRaw(key)
  if (!k.ok) return k
  if (flags & FLAG_ED) {
    let ext
    try { [ext, i] = readCbor(ad, i) } catch { return no('grammar') }
    if (!(ext instanceof Map)) return no('grammar')
  }
  if (i !== ad.length) return no('grammar')

  return { ok: true, value: { credId: b64uEnc(credId), pub: b64uEnc(k.value), signCount, be: !!(flags & FLAG_BE), bs: !!(flags & FLAG_BS), origin } }
}

/**
 * A member's assertion over a statement text, checked against PASSKEY and
 * that credential's stored counter. Returns the kernel's info plus the origin
 * (already checked against the closed list), or the kernel's reason.
 */
export async function verifyMemberAssertion(assertion, { publicKey, text, storedSignCount }) {
  const v = await verifyAssertion(assertion, {
    publicKey, challenge: await statementChallenge(text), rpId: PASSKEY.rpId, origins: passkeyOrigins(), storedSignCount,
  })
  if (!v.ok) return v
  // the kernel has refused duplicate keys and checked the origin against the list; read it back for the log and mail
  const cd = parseStrictJson(strictUtf8.decode(b64uDec(assertion.clientDataJSON)))
  return { ok: true, value: { ...v.value, origin: cd.get('origin') } }
}
