#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Encrypted asset blob rig.
//
//   node scripts/test-blobs.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. `getBlob` fetches an asset from the relay's blob store by
// its content address and hands the bytes to the renderer. Every guard in that
// path except one is about CORRUPTION, and corruption is loud: AES-GCM fails,
// the asset resolves to nothing, the user sees an empty element.
//
// SUBSTITUTION is the quiet one. The relay stores ciphertext it cannot read,
// but it chooses which ciphertext answers which address — so it can serve the
// room's blob B when asked for A. B decrypts perfectly (same room key, valid
// GCM tags), so the header check, the tag check and the length check all pass,
// and the deck renders a different picture with no error anywhere. Worse, the
// swap is written to IndexedDB under A's key, so it survives the relay going
// honest again.
//
// The only thing that can catch it is the address itself: it IS
// HMAC(roomKey, sha256(plaintext)), so recomputing it over what arrived proves
// the bytes are the bytes that were asked for. This rig pins that check.
//
// The IndexedDB half of the same check (a cache hit is re-verified, so an entry
// poisoned by a build that predates this is re-fetched rather than trusted) is
// the same three lines against the same helper, and is not reachable from node
// — there is no indexedDB here, so cacheGet always misses.

import { blobKey, encodeBlob, getBlob, type BlobEndpoint } from '../slides/src/sync/blobs.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const endpoint: BlobEndpoint = { base: 'https://relay.invalid', room: 'w-test', tok: 'tok' }
const roomKey = crypto.getRandomValues(new Uint8Array(32))
const otherRoomKey = crypto.getRandomValues(new Uint8Array(32))

// two distinct "assets" — think two images the same room uploaded
const assetA = new Uint8Array(4096).map((_, i) => i & 0xff)
const assetB = new Uint8Array(4096).map((_, i) => (i * 7 + 3) & 0xff)

const keyA = await blobKey(roomKey, assetA)
const keyB = await blobKey(roomKey, assetB)
ok(keyA !== keyB, 'distinct assets get distinct addresses')

/** Whatever the relay decides to answer with, regardless of the address asked. */
let served: Uint8Array | null = null
globalThis.fetch = (async () => (
  served ? new Response(served as unknown as BodyInit) : new Response('missing', { status: 404 })
)) as typeof fetch

const same = (a: Uint8Array | null, b: Uint8Array) =>
  !!a && a.length === b.length && a.every((v, i) => v === b[i])

// ------------------------------------------------------------- honest relay
served = await encodeBlob(roomKey, assetA)
ok(same(await getBlob(endpoint, roomKey, keyA), assetA),
  'an honest answer round-trips byte for byte')

// -------------------------------------------------------- the substitution
// B is a perfectly valid blob of this room: right key, intact tags. Only the
// address it is served under is a lie. Before the content-address check this
// returned B's bytes and cached them under A.
served = await encodeBlob(roomKey, assetB)
ok((await getBlob(endpoint, roomKey, keyA)) === null,
  'a valid blob served under another blob\'s address is REFUSED, not rendered')
ok(same(await getBlob(endpoint, roomKey, keyB), assetB),
  'and the same bytes are still accepted under their own address')

// ------------------------------------------------------- corruption, still loud
served = await encodeBlob(otherRoomKey, assetA)
ok((await getBlob(endpoint, roomKey, keyA)) === null,
  'a blob sealed with a foreign key is refused (GCM, unchanged)')

served = await encodeBlob(roomKey, assetA)
served[served.length - 1] ^= 0xff
ok((await getBlob(endpoint, roomKey, keyA)) === null,
  'a flipped ciphertext bit is refused (GCM, unchanged)')

served = null
ok((await getBlob(endpoint, roomKey, keyA)) === null,
  'a 404 reads as unavailable rather than throwing')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
