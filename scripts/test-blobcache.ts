#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Blob cache rig: the IndexedDB cache holds ciphertext, never plaintext.
//
//   node scripts/test-blobcache.ts      (Node ≥ 23.6; fake-indexeddb from an app workspace)
//
// WHAT THIS PROVES. Live-session media (images, video an author drops into a
// shared deck) travels through the relay encrypted, and kernel/src/sync/blobs.ts
// keeps a local copy in IndexedDB (`bento-blobcache`) so a slide that reuses an
// asset does not refetch it. IndexedDB is per ORIGIN, and on file:// every local
// page shares one origin — so whatever is written there is readable by any other
// HTML file opened from disk. The cache must therefore hold only what the relay
// holds: the encodeBlob ciphertext, useless without the room key in the document.
//
// It pins, against the real module and a real (fake-indexeddb) database:
//   - every write path (fetch, upload, dedup) stores ciphertext that decodes to
//     the asset, and no stored value contains the plaintext;
//   - a cache hit still returns the plaintext, with no network;
//   - a tampered entry falls through to a refetch, which heals the entry;
//   - an existing version-1 store (which held plaintext) is purged on upgrade;
//   - the SHIPPED version-1 opener, run verbatim against an upgraded database,
//     gets no cache at all, so an older runtime can no longer write plaintext;
//   - an older tab holding a version-1 connection cannot make getBlob hang.

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// fake-indexeddb lives in each app workspace (scripts/ has no package.json).
type FakeIdb = { indexedDB: IDBFactory; IDBFactory: new () => IDBFactory }
let fake: FakeIdb | undefined
for (const app of ['slides', 'type', 'spaces', 'dash']) {
  try {
    const req = createRequire(new URL(`../${app}/package.json`, import.meta.url))
    fake = await import(pathToFileURL(req.resolve('fake-indexeddb')).href) as FakeIdb
    break
  } catch { /* try the next workspace */ }
}
if (!fake?.IDBFactory) {
  console.log('FAIL  fake-indexeddb is not installed in any app workspace (run npm ci in slides/)')
  process.exit(1)
}
const G = globalThis as unknown as { indexedDB: IDBFactory; fetch: typeof fetch }

/** A fresh, empty browser profile. */
const freshProfile = () => { G.indexedDB = new fake!.IDBFactory() }
/** A fresh copy of the module (its db() memo starts empty), like a new tab. */
let gen = 0
const loadBlobs = async () =>
  await import(`../kernel/src/sync/blobs.ts?tab=${++gen}`) as typeof import('../kernel/src/sync/blobs.ts')

const DB = 'bento-blobcache'
const STORE = 'blobs'
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** Raw read of everything in the store, bypassing the module (an attacker's view). */
async function rawAll(): Promise<Map<string, Uint8Array> | null> {
  return new Promise((resolve) => {
    const req = G.indexedDB.open(DB)
    req.onerror = () => resolve(null)
    req.onsuccess = () => {
      const d = req.result
      if (!d.objectStoreNames.contains(STORE)) { d.close(); return resolve(new Map()) }
      const out = new Map<string, Uint8Array>()
      const tx = d.transaction(STORE, 'readonly')
      const cur = tx.objectStore(STORE).openCursor()
      cur.onsuccess = () => {
        const c = cur.result
        if (c) { out.set(String(c.key), new Uint8Array(c.value as ArrayBuffer)); c.continue() }
      }
      tx.oncomplete = () => { d.close(); resolve(out) }
    }
  })
}

/** Raw overwrite of one entry (tampering, or a pre-existing value). */
async function rawPut(key: string, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve) => {
    const req = G.indexedDB.open(DB)
    req.onsuccess = () => {
      const d = req.result
      const tx = d.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(bytes.slice().buffer, key)
      tx.oncomplete = () => { d.close(); resolve() }
    }
  })
}

// ---------------------------------------------------------------------------
// The SHIPPED version-1 cache code, verbatim from kernel/src/sync/blobs.ts as
// released through 1.2.9 (only `dbP` is per-instance so each call is a new tab).
// Shipped shells are frozen, so this is exactly what an older runtime runs.
function shippedV1() {
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
  async function cacheGet(key: string): Promise<Uint8Array | null> {
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
  async function cachePut(key: string, bytes: Uint8Array): Promise<void> {
    const d = await db()
    if (!d) return
    try {
      d.transaction(STORE, 'readwrite').objectStore(STORE).put(bytes.slice().buffer, key)
    } catch { /* cache is best effort */ }
  }
  return { db, cacheGet, cachePut }
}
// ---------------------------------------------------------------------------

// A recognisable plaintext: if any stored value contains this, plaintext leaked.
const MARKER = new TextEncoder().encode('BENTO-PLAINTEXT-MARKER-')
const asset = new Uint8Array(4096)
for (let i = 0; i < asset.length; i++) asset[i] = MARKER[i % MARKER.length]
const containsMarker = (v: Uint8Array) => {
  outer: for (let i = 0; i + MARKER.length <= v.length; i++) {
    for (let j = 0; j < MARKER.length; j++) if (v[i + j] !== MARKER[j]) continue outer
    return true
  }
  return false
}
const same = (a: Uint8Array | null, b: Uint8Array) =>
  !!a && a.length === b.length && a.every((x, i) => x === b[i])

const roomKey = crypto.getRandomValues(new Uint8Array(32))
const endpoint = { base: 'https://relay.invalid', room: 'w-test', tok: 'tok' }

/** A relay: answers GET with `served`, HEAD with `headStatus`, PUT with 200. Counts calls. */
let served: Uint8Array | null = null
let headStatus = 404
let calls = { get: 0, head: 0, put: 0 }
G.fetch = (async (_u: unknown, init?: RequestInit) => {
  const m = init?.method ?? 'GET'
  if (m === 'HEAD') { calls.head++; return new Response(null, { status: headStatus }) }
  if (m === 'PUT') { calls.put++; return new Response(null, { status: 200 }) }
  calls.get++
  return served ? new Response(served as unknown as BodyInit) : new Response('missing', { status: 404 })
}) as typeof fetch
const resetCalls = () => { calls = { get: 0, head: 0, put: 0 } }

// --- 1. fetch path: what lands in the cache ----------------------------------
console.log('\nfetch path caches ciphertext')
{
  freshProfile()
  const b = await loadBlobs()
  const key = await b.blobKey(roomKey, asset)
  served = await b.encodeBlob(roomKey, asset)
  resetCalls()
  const got = await b.getBlob(endpoint, roomKey, key)
  await settle()
  ok(same(got, asset), 'getBlob returns the asset')
  const all = await rawAll()
  const v = all?.get(key)
  ok(!!v, 'the fetched blob was cached')
  ok(!!v && !containsMarker(v), 'the cached value does NOT contain the plaintext')
  ok(!!v && same(await b.decodeBlob(roomKey, v), asset), 'the cached value decodes to the asset with the room key')
  ok(![...(all?.values() ?? [])].some(containsMarker), 'no value anywhere in the store contains the plaintext')

  // --- 2. a hit returns plaintext, with no network
  served = null
  resetCalls()
  const hit = await b.getBlob(endpoint, roomKey, key)
  ok(same(hit, asset), 'a cache hit returns the plaintext')
  ok(calls.get === 0, `and touches no network (GETs: ${calls.get})`)

  // --- 3. a tampered entry falls through to a refetch, which heals it
  const bad = v!.slice(); bad[bad.length - 1] ^= 0xff
  await rawPut(key, bad)
  served = await b.encodeBlob(roomKey, asset)
  resetCalls()
  const healed = await b.getBlob(endpoint, roomKey, key)
  await settle()
  ok(same(healed, asset), 'a tampered entry still yields the asset (via refetch)')
  ok(calls.get === 1, `the tampered entry was not trusted — refetched (GETs: ${calls.get})`)
  const after = (await rawAll())?.get(key)
  ok(!!after && same(await b.decodeBlob(roomKey, after), asset) && !containsMarker(after),
    'the refetch overwrote the entry with valid ciphertext')

  // a wrong-key entry (decodes to nothing) is likewise not trusted
  await rawPut(key, await b.encodeBlob(crypto.getRandomValues(new Uint8Array(32)), asset))
  resetCalls()
  ok(same(await b.getBlob(endpoint, roomKey, key), asset) && calls.get === 1,
    'an entry sealed under another key is refetched, not trusted')
}

// --- 4. upload + dedup paths --------------------------------------------------
console.log('\nupload and dedup paths cache ciphertext')
{
  freshProfile()
  const b = await loadBlobs()
  headStatus = 404
  const up = await b.putBlob(endpoint, roomKey, asset)
  await settle()
  ok(up.ok && !up.deduped, 'putBlob uploads')
  const k = up.ok ? up.key : ''
  let v = (await rawAll())?.get(k)
  ok(!!v && !containsMarker(v), 'upload path: the cached value does NOT contain the plaintext')
  ok(!!v && same(await b.decodeBlob(roomKey, v), asset), 'upload path: it decodes to the asset')

  freshProfile()
  const b2 = await loadBlobs()
  headStatus = 200
  resetCalls()
  const dd = await b2.putBlob(endpoint, roomKey, asset)
  await settle(60)
  ok(dd.ok && dd.deduped && calls.put === 0, 'putBlob dedups on HEAD 200 (no PUT)')
  v = (await rawAll())?.get(dd.ok ? dd.key : '')
  ok(!!v && !containsMarker(v), 'dedup path: the cached value does NOT contain the plaintext')
  ok(!!v && same(await b2.decodeBlob(roomKey, v), asset), 'dedup path: it decodes to the asset')
  headStatus = 404
}

// --- 5. a version-1 plaintext store is purged on upgrade ----------------------
console.log('\nupgrade purges the version-1 plaintext store')
{
  freshProfile()
  const old = shippedV1()
  const b = await loadBlobs()
  const key = await b.blobKey(roomKey, asset)
  await old.cachePut(key, asset)           // what a 1.2.9 tab wrote: PLAINTEXT
  await settle()
  ok(!!(await old.cacheGet(key)) && containsMarker((await old.cacheGet(key))!),
    'precondition: the shipped v1 code stored plaintext')
  ;(await old.db())?.close()               // that tab is closed
  await b.cacheGet('anything')              // a new runtime opens the cache once
  await settle()
  const all = await rawAll()
  ok(!!all && ![...all.values()].some(containsMarker), 'after the new runtime opens it, no plaintext remains')
  ok(!!all && !all.has(key), 'the plaintext entry itself is gone (store dropped, not migrated)')
}

// --- 6. the shipped v1 opener, against an upgraded database, gets no cache ----
console.log('\nan older runtime gets no cache once a new one has run')
{
  freshProfile()
  const b = await loadBlobs()
  await b.cacheGet('init')                  // new runtime creates version 2
  await settle()
  const old = shippedV1()                   // then an older tab opens the same origin
  ok((await old.db()) === null, 'the shipped v1 open resolves null against a version-2 database (VersionError)')
  const key = await b.blobKey(roomKey, asset)
  await old.cachePut(key, asset)            // it tries to cache plaintext
  await settle()
  ok((await old.cacheGet(key)) === null, 'its cacheGet finds nothing')
  const all = await rawAll()
  ok(!!all && ![...all.values()].some(containsMarker), 'its cachePut wrote no plaintext')
}

// --- 7. an older tab still holding v1 cannot make getBlob hang ---------------
console.log('\nan open version-1 connection does not hang the new runtime')
{
  freshProfile()
  const old = shippedV1()
  const held = await old.db()               // an older tab, open, never closing
  ok(!!held, 'precondition: the older tab holds an open v1 connection')
  const b = await loadBlobs()
  const key = await b.blobKey(roomKey, asset)
  served = await b.encodeBlob(roomKey, asset)
  resetCalls()
  const t = setTimeout(() => { console.log('  FAIL  getBlob hung behind a blocked upgrade'); process.exit(1) }, 3000)
  const got = await b.getBlob(endpoint, roomKey, key)
  clearTimeout(t)
  ok(same(got, asset), 'getBlob still returns the asset (runs uncached while blocked)')
  ok(calls.get === 1, 'it fetched from the relay rather than waiting')
  held!.close()                             // the older tab closes
  await settle(60)
  const all = await rawAll()
  ok(!!all && ![...all.values()].some(containsMarker), 'and once it closes, the pending upgrade still leaves no plaintext')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
