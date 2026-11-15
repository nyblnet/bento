// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// Single-use directory challenges: the `dirNonce` a roster request names, and
// the challenge a new passkey is registered over.
//
// A challenge is STATELESS and sealed: issuedAt ‖ nonce ‖ HMAC(secret, audience,
// scope, issuedAt, nonce), 40 bytes, base64url. Nothing is stored when one is
// issued. The Durable Object that applies the request records the nonce as
// SPENT before it checks anything else, so every attempt consumes it, and the
// worker only opens the seal: it never spends.
//
// `scope` is the storage name of the address the request is about, so a
// challenge issued for one address can never be spent at another. It is the
// hash the Durable Object is named by, never the address itself.

import { b64uDec, b64uEnc } from '../../../kernel/src/statements.ts'

/** Long enough for a person to pick a passkey and confirm; single use either way. */
export const CHALLENGE_TTL_MS = 5 * 60_000
const SKEW_MS = 5_000
const LABEL = 'bento-dir/1/challenge'

async function mac(secret, audience, scope, issued, nonce) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('CHALLENGE_KEY is not configured')
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const msg = new TextEncoder().encode(`${LABEL}\n${audience}\n${scope}\n${issued}\n${b64uEnc(nonce)}`)
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, msg)).slice(0, 16)
}

/** A fresh challenge for `audience` about the address stored under `scope`. */
export async function issueChallenge(secret, audience, scope, now) {
  const nonce = crypto.getRandomValues(new Uint8Array(16))
  const out = new Uint8Array(40)
  new DataView(out.buffer).setBigUint64(0, BigInt(now))
  out.set(nonce, 8)
  out.set(await mac(secret, audience, scope, now, nonce), 24)
  return b64uEnc(out)
}

/**
 * Open a challenge: sealed by us, for this audience and scope, and within its
 * lifetime? Returns { nonce, issued } (the nonce is the spent-set key) or null.
 * It does NOT spend the challenge: the Durable Object does that first, inside
 * its own serialisation. `ttl` is the challenge's life: CHALLENGE_TTL_MS for a
 * roster challenge, a minute for a browser's (browsers.js).
 */
export async function openChallenge(secret, audience, scope, challenge, now, ttl = CHALLENGE_TTL_MS) {
  if (typeof challenge !== 'string') return null
  const b = b64uDec(challenge)
  if (!b || b.length !== 40) return null
  const issued = Number(new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0))
  const nonce = b.slice(8, 24)
  const want = await mac(secret, audience, scope, issued, nonce)
  let d = 0
  for (let i = 0; i < 16; i++) d |= want[i] ^ b[24 + i]
  if (d !== 0) return null
  if (issued > now + SKEW_MS || now - issued > ttl) return null
  return { nonce: b64uEnc(nonce), issued }
}
