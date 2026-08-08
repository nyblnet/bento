// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Small crypto helpers shared by store.ts. No dependency on Node's `crypto`
// module — everything here is Web Crypto, available in the Workers runtime.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** A short, URL-safe random id — used for deck ids and asset keys. Not a
 *  capability by itself (deck ids are public/shareable); the edit token is
 *  the capability. */
export function randomId(length = 12): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

/** A longer random token — used as the deck's edit capability. Only its hash
 *  is ever persisted (see sha256Hex); the raw value is returned to the
 *  caller exactly once, at deck creation. */
export function randomToken(): string {
  return randomId(32)
}

export async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
