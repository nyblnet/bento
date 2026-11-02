// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Single-use challenges for consent the directory verifies itself (audience
// `dir`).
//
// A challenge is STATELESS and sealed: issuedAt ‖ nonce ‖ HMAC(secret,
// audience, scope, issuedAt, nonce), 40 bytes, base64url. Nothing is stored
// when one is issued. The Durable Object that applies the action records the
// nonce as SPENT before it checks anything else, so every attempt consumes it.
//
// `scope` is the storage name of the address the action is about, so a
// challenge issued for one address can never be spent at another. It is the
// hash the Address DO is named by, never the address itself.

import { b64uDec, b64uEnc } from './statements.js'

export const CHALLENGE_TTL_MS = 60_000
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
 * 60 seconds? Returns { nonce } (the spent-set key) or null. It does NOT spend
 * the challenge: the Address DO does that first, inside its own serialisation.
 */
export async function openChallenge(secret, audience, scope, challenge, now) {
  if (typeof challenge !== 'string') return null
  const b = b64uDec(challenge)
  if (!b || b.length !== 40 || b64uEnc(b) !== challenge) return null
  const issued = Number(new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0))
  const nonce = b.slice(8, 24)
  const want = await mac(secret, audience, scope, issued, nonce)
  let d = 0
  for (let i = 0; i < 16; i++) d |= want[i] ^ b[24 + i]
  if (d !== 0) return null
  if (issued > now + SKEW_MS || now - issued > CHALLENGE_TTL_MS) return null
  return { nonce: b64uEnc(nonce), issued }
}
