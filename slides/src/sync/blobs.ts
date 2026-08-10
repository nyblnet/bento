// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Encrypted asset blobs — the client half of docs/blob-offload.md.
//
// WHY THIS EXISTS. An asset cannot travel as a CRDT op: a Durable Object
// storage value caps near 2MB, and an asset costs ~1.78x its binary size on
// the wire (base64 twice — once into the data URI, once over the ciphertext).
// So ~1.05MB of binary is the ceiling for an op, against an 8MB embed budget.
// No frame-size constant fixes that. Assets go to the relay's blob store
// instead and the op carries only a reference.
//
// WHY CHUNKED. WebCrypto has NO streaming AES-GCM — encrypt/decrypt are
// one-shot — and a round trip costs roughly 5x the payload in memory
// (measured: 8MB -> 40MB, 64MB -> 320MB). Encrypting a large asset in one
// call would spike a browser tab, and mobile Safari kills tabs for less.
// Fixed-size chunks bound peak memory to ~5x CHUNK regardless of asset size,
// and fall out naturally as resumable upload units later.
//
// WHY THE KEY IS AN HMAC. Content addressing gives dedupe for free, but a bare
// sha256(plaintext) as the storage key would let the relay see that two
// different rooms hold the same image. HMAC(roomKey, hash) is deterministic
// WITHIN a room (so dedupe works) and opaque across rooms (so nothing
// correlates). The relay only ever sees the HMAC.

/** Plaintext bytes per chunk. Peak memory is ~5x this, not ~5x the asset. */
const CHUNK = 4 * 1024 * 1024
/** Must match the relay's MAX_BLOB. NOTE this bounds the ENCODED blob, not the
 *  plaintext — the relay measures what it receives. */
export const MAX_BLOB = 8 * 1024 * 1024
const MAGIC = 0x4242 // 'BB'
const HEADER = 16
const IV_LEN = 12
const TAG_LEN = 16

const b64u = {
  enc(bytes: Uint8Array): string {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
  dec(s: string): Uint8Array {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    const out = new Uint8Array(b.length)
    for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
    return out
  },
}

/** `data:<mime>;base64,<payload>` → bytes + mime. Null if not a data URI. */
export function dataUriToBytes(uri: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri)
  if (!m) return null
  const mime = m[1] || 'application/octet-stream'
  if (!m[2]) return { bytes: new TextEncoder().encode(decodeURIComponent(m[3])), mime }
  const raw = atob(m[3])
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return { bytes, mime }
}

/** bytes → `data:<mime>;base64,…`, chunked so a large asset doesn't blow the
 *  argument stack via String.fromCharCode(...bytes). */
export function bytesToDataUri(bytes: Uint8Array, mime: string): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)))
  }
  return `data:${mime};base64,${btoa(s)}`
}

/** Encoded size for `n` plaintext bytes: header + per-chunk IV and GCM tag.
 *  The client must check THIS against MAX_BLOB, not the plaintext length —
 *  otherwise an asset just under the limit passes here and is refused 413 by
 *  the relay, which measures the ciphertext. */
export function encodedSize(n: number): number {
  return HEADER + Math.max(1, Math.ceil(n / CHUNK)) * (IV_LEN + TAG_LEN) + n
}

/** Largest plaintext asset that still fits in one blob. */
export function maxAssetBytes(): number {
  let n = MAX_BLOB
  while (n > 0 && encodedSize(n) > MAX_BLOB) n -= 1
  return n
}

async function hmacKey(rawRoomKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', rawRoomKey as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
}

/**
 * Storage key for an asset: HMAC(roomKey, sha256(plaintext)), base64url,
 * truncated to 32 chars (the relay accepts [A-Za-z0-9_-]{16,64}). Same bytes
 * in the same room always yield the same key — that IS the dedupe.
 */
export async function blobKey(rawRoomKey: Uint8Array, bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(rawRoomKey), digest as BufferSource)
  return b64u.enc(new Uint8Array(mac)).slice(0, 32)
}

async function aesKey(rawRoomKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', rawRoomKey as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/**
 * Encrypt to the on-the-wire blob layout:
 *   [magic u16][version u8][reserved u8][chunkSize u32][totalSize u32][nChunks u32]
 *   then per chunk: [iv 12][ciphertext (plaintext + 16-byte tag)]
 * Chunk lengths are implied by chunkSize + totalSize, so nothing is ambiguous.
 */
export async function encodeBlob(rawRoomKey: Uint8Array, bytes: Uint8Array, mimeUnused?: string): Promise<Uint8Array> {
  void mimeUnused // mime rides in the op, not the blob: the blob is opaque
  const key = await aesKey(rawRoomKey)
  const nChunks = Math.max(1, Math.ceil(bytes.length / CHUNK))
  const out = new Uint8Array(HEADER + nChunks * (IV_LEN + TAG_LEN) + bytes.length)
  const dv = new DataView(out.buffer)
  dv.setUint16(0, MAGIC, true)
  dv.setUint8(2, 1)
  dv.setUint8(3, 0)
  dv.setUint32(4, CHUNK, true)
  dv.setUint32(8, bytes.length, true)
  dv.setUint32(12, nChunks, true)
  let at = HEADER
  for (let i = 0; i < nChunks; i++) {
    const slice = bytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, bytes.length))
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, slice as BufferSource))
    out.set(iv, at); at += IV_LEN
    out.set(ct, at); at += ct.length
  }
  return out
}

/** Inverse of encodeBlob. Null on a wrong key, truncation or corruption —
 *  every chunk is individually authenticated by its GCM tag. */
export async function decodeBlob(rawRoomKey: Uint8Array, blob: Uint8Array): Promise<Uint8Array | null> {
  if (blob.length < HEADER) return null
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  if (dv.getUint16(0, true) !== MAGIC || dv.getUint8(2) !== 1) return null
  const chunkSize = dv.getUint32(4, true)
  const total = dv.getUint32(8, true)
  const nChunks = dv.getUint32(12, true)
  if (!chunkSize || nChunks > 4096) return null
  const key = await aesKey(rawRoomKey)
  const out = new Uint8Array(total)
  let at = HEADER
  let wrote = 0
  for (let i = 0; i < nChunks; i++) {
    const plainLen = Math.min(chunkSize, total - wrote)
    const ctLen = plainLen + TAG_LEN
    if (at + IV_LEN + ctLen > blob.length) return null
    const iv = blob.subarray(at, at + IV_LEN); at += IV_LEN
    const ct = blob.subarray(at, at + ctLen); at += ctLen
    try {
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct as BufferSource))
      out.set(plain, wrote)
      wrote += plain.length
    } catch {
      return null // wrong key or tampered chunk
    }
  }
  return wrote === total ? out : null
}

// --- local cache -------------------------------------------------------------
// A blob a peer sent is worth keeping: the same asset is referenced by every
// slide that uses it, and re-fetching on each render would be absurd. Keyed by
// the blob key, which is already content-addressed.

const DB = 'bento-blobcache'
const STORE = 'blobs'
let dbP: Promise<IDBDatabase | null> | null = null

function db(): Promise<IDBDatabase | null> {
  if (dbP) return dbP
  dbP = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    let req: IDBOpenDBRequest
    try { req = indexedDB.open(DB, 1) } catch { return resolve(null) }
    req.onupgradeneeded = () => {
      const d = req.result
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
  return dbP
}

export async function cacheGet(key: string): Promise<Uint8Array | null> {
  const d = await db()
  if (!d) return null
  return new Promise((resolve) => {
    try {
      const r = d.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      r.onsuccess = () => resolve(r.result ? new Uint8Array(r.result as ArrayBuffer) : null)
      r.onerror = () => resolve(null)
    } catch { resolve(null) }
  })
}

export async function cachePut(key: string, bytes: Uint8Array): Promise<void> {
  const d = await db()
  if (!d) return
  try {
    // store the ArrayBuffer, not the view — structured clone keeps it compact
    d.transaction(STORE, 'readwrite').objectStore(STORE).put(bytes.slice().buffer, key)
  } catch { /* cache is best effort */ }
}

// --- transport ---------------------------------------------------------------

export interface BlobEndpoint {
  /** relay origin, e.g. https://sync.bento.page */
  base: string
  room: string
  tok: string
}

const url = (e: BlobEndpoint, key: string) =>
  `${e.base.replace(/\/$/, '')}/b/${encodeURIComponent(e.room)}/${encodeURIComponent(key)}?tok=${encodeURIComponent(e.tok)}`

export type PutResult =
  | { ok: true; key: string; deduped: boolean }
  | { ok: false; reason: 'too-large' | 'unsupported' | 'network' | 'forbidden' | 'room-full' }

/**
 * Encrypt and upload. Returns the key to put in the op. Dedupe is a HEAD
 * first: content addressing means an identical asset already uploaded by a
 * peer needs no second upload.
 *
 * 'unsupported' means the relay has no blob storage configured (501) — the
 * caller should fall back to inlining, NOT treat it as an error.
 */
export async function putBlob(e: BlobEndpoint, rawRoomKey: Uint8Array, bytes: Uint8Array): Promise<PutResult> {
  if (encodedSize(bytes.length) > MAX_BLOB) return { ok: false, reason: 'too-large' }
  const key = await blobKey(rawRoomKey, bytes)
  try {
    const head = await fetch(url(e, key), { method: 'HEAD' })
    if (head.status === 200) {
      void cachePut(key, bytes)
      return { ok: true, key, deduped: true }
    }
    if (head.status === 501) return { ok: false, reason: 'unsupported' }
    if (head.status === 403) return { ok: false, reason: 'forbidden' }
    const body = await encodeBlob(rawRoomKey, bytes)
    const res = await fetch(url(e, key), {
      method: 'PUT', body: body as BodyInit,
      headers: { 'content-type': 'application/octet-stream' },
    })
    if (res.status === 501) return { ok: false, reason: 'unsupported' }
    if (res.status === 403) return { ok: false, reason: 'forbidden' }
    if (res.status === 413) return { ok: false, reason: 'too-large' }
    // 507: the room's total blob quota is exhausted. Permanent for this room
    // until it expires — the caller must not retry in a loop.
    if (res.status === 507) return { ok: false, reason: 'room-full' }
    if (!res.ok) return { ok: false, reason: 'network' }
    void cachePut(key, bytes)
    return { ok: true, key, deduped: false }
  } catch {
    return { ok: false, reason: 'network' }
  }
}

/** Does `plain` actually hash to the address we asked for? One SHA-256 plus
 *  one HMAC over bytes we have just decrypted anyway — negligible beside the
 *  AES-GCM pass that produced them, and it runs once per fetch, not per use
 *  (the cache is keyed by the same address). */
async function addressMatches(rawRoomKey: Uint8Array, key: string, plain: Uint8Array): Promise<boolean> {
  return (await blobKey(rawRoomKey, plain)) === key
}

/** Fetch and decrypt, cache-first. Null means "not available right now" —
 *  callers render a placeholder rather than a broken image, and may retry.
 *  A blob that fails its content-address check reads as unavailable too: a
 *  placeholder is recoverable, the wrong picture is not. */
export async function getBlob(e: BlobEndpoint, rawRoomKey: Uint8Array, key: string): Promise<Uint8Array | null> {
  const hit = await cacheGet(key)
  try {
    // The hit is checked as well, so a cache written before this verification
    // existed (or edited under us in IndexedDB) heals: falling through re-fetches
    // and cachePut, keyed by the address, overwrites the bad entry.
    // INSIDE the try like the post-fetch check below: addressMatches can throw
    // (measured — crypto.subtle.importKey('raw', new Uint8Array(0), HMAC) rejects
    // with DataError on an empty room key), and the contract above promises null,
    // not a rejection. session.resolveBlobs has try/finally and no catch, so a
    // throw here escapes as an unhandled rejection.
    if (hit && await addressMatches(rawRoomKey, key, hit)) return hit
    const res = await fetch(url(e, key))
    if (!res.ok) return null
    const enc = new Uint8Array(await res.arrayBuffer())
    const plain = await decodeBlob(rawRoomKey, enc)
    if (!plain) return null
    // GCM proves someone holding the room key sealed these bytes. It does NOT
    // prove they are the bytes this address names, and nothing else here did:
    // the relay is free to answer address A with the room's blob B, and every
    // check above passes. The picture silently becomes a different picture and
    // cachePut writes the swap to disk permanently. The address is the only
    // binding between reference and content, so verify it before both.
    if (!await addressMatches(rawRoomKey, key, plain)) return null
    void cachePut(key, plain)
    return plain
  } catch {
    return null
  }
}
