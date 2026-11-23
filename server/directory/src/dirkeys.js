// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// What the directory hands a kernel verifier that it cannot read off the
// statement itself: its own countersign keys (a stored chain verifies under
// them) and a passkey assertion's signature counter. A kernel member proof
// never compares counters (a peer sees links out of order), so wherever the
// directory accepts a member's assertion through a kernel verifier it reads
// the counter here and keeps the stored one moving forward itself (security's
// D6 on #953).

import { b64uDec, b64uEnc } from '../../../kernel/src/statements.ts'

/**
 * The directory's own public keys, by kid, as a peer pins them: the online
 * key's public half, and any earlier key DIR_PUBKEYS lists as {kid, pub}
 * (after a rotation the chain still carries links the old key signed).
 */
export async function directoryKeys(env) {
  const jwk = JSON.parse(env.DIR_KEY_JWK)
  const pub = await crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
  const keys = { [env.DIR_KID]: b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', pub))) }
  let more = []
  try { more = JSON.parse(env.DIR_PUBKEYS || '[]') } catch { /* none */ }
  for (const k of Array.isArray(more) ? more : []) if (k && typeof k.kid === 'string' && typeof k.pub === 'string' && !Object.hasOwn(keys, k.kid)) keys[k.kid] = k.pub
  return keys
}

/** An assertion's signature counter (authenticator data bytes 33-36), or null when it does not read. */
export function signCountOf(assertion) {
  const ad = assertion && typeof assertion.authenticatorData === 'string' ? b64uDec(assertion.authenticatorData) : null
  return ad && ad.length >= 37 ? ((ad[33] << 24) >>> 0) + (ad[34] << 16) + (ad[35] << 8) + ad[36] : null
}
