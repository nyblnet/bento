// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// DocStore, the extension backend: what a document keeps beside itself —
// recovery, version history, keys — stored in THIS extension's origin
// rather than the page's.
//
// WHY HERE. Every document opened from disk shares one storage origin
// (docs/DECISIONS.md, 2026-10-04), so a page-side store is a store every
// local HTML file can read. The extension has an origin of its own, and the
// browser tells it which file is asking (`sender.url`, stamped, not
// forgeable by the page). So each document gets a PARTITION keyed by its
// absolute path, derived here from the sender and never from the payload,
// and the page can only ever reach its own. A document id the page supplies
// is never a key: it is page data, and a hostile local file could claim
// another deck's.
//
// The kernel's DocStore interface (agreed 2026-09-26) is four operations,
// bytes both ways: get(name) → bytes|null, set(name, bytes), list(prefix) →
// names, delete(name). Names are plain purposes (`recovery`, `ver/<seq>`,
// `memberkey`); values are opaque — stored blindly, never parsed. No
// encryption on this path: the partition is the isolation (the page-side
// fallback, where the origin is shared, is where keys and HMAC names live).
//
// TRANSPORT. Runtime messaging is JSON, so bytes cross the relay↔worker hop
// as base64, and a value over CHUNK bytes travels as numbered chunks under a
// transaction id, committed in one step: a reader sees the old value or the
// new one, never half. Every message re-derives the partition and holds no
// state between messages (the worker is evicted at will); chunks of a
// transfer that never committed are swept by `gc`.
//
// RETENTION mirrors the page store (kernel autosave.ts): `recovery` is a
// single entry by construction; `ver/*` keeps the newest VERSIONS_MAX and
// nothing older than MAX_AGE_DAYS. A partition whose file no longer exists
// is dropped, and so is one untouched for MAX_AGE_DAYS. A moved or renamed
// file therefore starts with an empty partition: it loses local history,
// never content (the file itself is the source of truth).
//
// Pure: the IndexedDB adapter and the file-exists probe come in as `deps`,
// so scripts/test-webext-store.ts drives the real code in node.

/** Bytes per chunk on the relay↔worker hop (before base64). */
export const CHUNK = 3 * 1024 * 1024
/** Largest value one name may hold. */
export const MAX_VALUE = 64 * 1024 * 1024
export const VERSIONS_MAX = 20
export const MAX_AGE_DAYS = 30
const DAY = 24 * 3600 * 1000
/** A transfer that never committed is swept after this long. */
const STALE_TX_MS = 3600 * 1000

/** Names and prefixes: plain purposes, no climbing, no separators of ours. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
export const validName = (n) => typeof n === 'string' && NAME_RE.test(n) && !n.split('/').includes('..')
export const validPrefix = (p) => p === '' || (typeof p === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(p) && !p.split('/').includes('..'))
export const validTx = (t) => typeof t === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(t)

const S = '\u0000'
const mKey = (path, name) => `m${S}${path}${S}${name}`
const cKey = (path, name, tx, i) => `c${S}${path}${S}${name}${S}${tx}${S}${String(i).padStart(6, '0')}`
const cPrefix = (path, name, tx) => `c${S}${path}${S}${name}${S}${tx ?? ''}`
const END = '￿'

export const toB64 = (u8) => {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
  return btoa(s)
}
export const fromB64 = (b64) => {
  const s = atob(b64)
  const u8 = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i)
  return u8
}
const b64Len = (b64) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)

// ---------------------------------------------------------------- the ops
// Each takes the PATH the worker derived from the sender, never one from
// the page. A null path is not a document: every op refuses it.

export async function get(path, p, deps) {
  if (!path) return { ok: false, reason: 'not a document' }
  if (!validName(p?.name)) return { ok: false, reason: 'bad name' }
  const m = await deps.db.get(mKey(path, p.name))
  if (!m) return { ok: true, found: false }
  if (m.n === 1) {
    const c = await deps.db.get(cKey(path, p.name, m.tx, 0))
    if (c == null) return { ok: false, reason: 'missing chunk' }
    return { ok: true, found: true, size: m.size, inline: c }
  }
  return { ok: true, found: true, size: m.size, tx: m.tx, n: m.n }
}

export async function chunk(path, p, deps) {
  if (!path) return { ok: false, reason: 'not a document' }
  if (!validName(p?.name) || !validTx(p?.tx) || !Number.isInteger(p?.i) || p.i < 0) return { ok: false, reason: 'bad request' }
  const m = await deps.db.get(mKey(path, p.name))
  if (!m || m.tx !== p.tx || p.i >= m.n) return { ok: false, reason: 'gone' } // replaced mid-read: the caller starts over
  const c = await deps.db.get(cKey(path, p.name, p.tx, p.i))
  return c == null ? { ok: false, reason: 'missing chunk' } : { ok: true, data: c }
}

/** One chunk of a transfer. Nothing is visible until `commit`. */
export async function put(path, p, deps) {
  if (!path) return { ok: false, reason: 'not a document' }
  if (!validName(p?.name) || !validTx(p?.tx) || !Number.isInteger(p?.i) || p.i < 0 || typeof p?.data !== 'string') return { ok: false, reason: 'bad request' }
  if (b64Len(p.data) > CHUNK) return { ok: false, reason: 'chunk too large' }
  if (p.i * CHUNK >= MAX_VALUE) return { ok: false, reason: 'too large' }
  await deps.db.put(cKey(path, p.name, p.tx, p.i), p.data)
  await deps.db.put(`t${S}${path}${S}${p.name}${S}${p.tx}`, { at: deps.now() }) // for the stale sweep
  return { ok: true }
}

/** Make a transfer the value of `name`: every chunk present, then one manifest write. */
export async function commit(path, p, deps) {
  if (!path) return { ok: false, reason: 'not a document' }
  if (!validName(p?.name) || !validTx(p?.tx) || !Number.isInteger(p?.n) || p.n < 1) return { ok: false, reason: 'bad request' }
  let size = 0
  for (let i = 0; i < p.n; i++) {
    const c = await deps.db.get(cKey(path, p.name, p.tx, i))
    if (c == null) return { ok: false, reason: 'incomplete' }
    size += b64Len(c)
  }
  if (size > MAX_VALUE) { await dropTx(path, p.name, p.tx, deps); return { ok: false, reason: 'too large' } }
  const old = await deps.db.get(mKey(path, p.name))
  await deps.db.put(mKey(path, p.name), { tx: p.tx, n: p.n, size, at: deps.now() })
  await deps.db.del(`t${S}${path}${S}${p.name}${S}${p.tx}`)
  if (old && old.tx !== p.tx) await dropTx(path, p.name, old.tx, deps)
  if (p.name.startsWith('ver/')) await retain(path, deps)
  return { ok: true }
}

/** The small case in one message: a single chunk, committed. */
export async function set(path, p, deps) {
  if (!path) return { ok: false, reason: 'not a document' }
  if (!validName(p?.name) || typeof p?.data !== 'string') return { ok: false, reason: 'bad request' }
  if (b64Len(p.data) > CHUNK) return { ok: false, reason: 'chunk too large' }
  const tx = deps.txid()
  const r = await put(path, { name: p.name, tx, i: 0, data: p.data }, deps)
  return r.ok ? commit(path, { name: p.name, tx, n: 1 }, deps) : r
}

export async function list(path, p, deps) {
  if (!path) return { ok: false, reason: 'not a document' }
  const prefix = p?.prefix ?? ''
  if (!validPrefix(prefix)) return { ok: false, reason: 'bad prefix' }
  const lo = mKey(path, prefix)
  const names = (await deps.db.range(lo, `${lo}${END}`)).map(([k]) => k.slice(mKey(path, '').length))
  return { ok: true, names: names.sort() }
}

export async function remove(path, p, deps) {
  if (!path) return { ok: false, reason: 'not a document' }
  if (!validName(p?.name)) return { ok: false, reason: 'bad name' }
  const m = await deps.db.get(mKey(path, p.name))
  await deps.db.del(mKey(path, p.name))
  if (m) await dropTx(path, p.name, m.tx, deps)
  return { ok: true }
}

async function dropTx(path, name, tx, deps) {
  const lo = cPrefix(path, name, tx)
  for (const [k] of await deps.db.range(`${lo}${S}`, `${lo}${S}${END}`)) await deps.db.del(k)
  await deps.db.del(`t${S}${path}${S}${name}${S}${tx}`)
}

/** `ver/*` in one partition: the newest VERSIONS_MAX, none older than MAX_AGE_DAYS. */
export async function retain(path, deps) {
  const lo = mKey(path, 'ver/')
  const vers = (await deps.db.range(lo, `${lo}${END}`)).map(([k, v]) => ({ name: k.slice(mKey(path, '').length), at: v.at }))
  vers.sort((a, b) => b.at - a.at)
  const cutoff = deps.now() - MAX_AGE_DAYS * DAY
  for (const [i, v] of vers.entries()) {
    if (i >= VERSIONS_MAX || v.at < cutoff) await remove(path, { name: v.name }, deps)
  }
}

/**
 * The sweep: partitions whose file is gone, partitions untouched for
 * MAX_AGE_DAYS, and chunks of transfers that never committed. `exists(path)`
 * answers whether the file is still there (a file:// probe in the worker).
 * Returns what it dropped, for the log and the rig.
 */
export async function gc(deps) {
  const now = deps.now()
  const parts = new Map() // path → newest at
  for (const [k, v] of await deps.db.range(`m${S}`, `m${S}${END}`)) {
    const path = k.split(S)[1]
    parts.set(path, Math.max(parts.get(path) ?? 0, v?.at ?? 0))
  }
  const dropped = []
  for (const [path, newest] of parts) {
    const old = newest < now - MAX_AGE_DAYS * DAY
    let gone = false
    if (!old) { try { gone = !(await deps.exists(path)) } catch { gone = false } }
    if (!old && !gone) continue
    for (const [k] of await deps.db.range(`m${S}${path}${S}`, `m${S}${path}${S}${END}`)) {
      await remove(path, { name: k.slice(mKey(path, '').length) }, deps)
    }
    dropped.push({ path, why: old ? 'age' : 'gone' })
  }
  for (const [k, v] of await deps.db.range(`t${S}`, `t${S}${END}`)) {
    if ((v?.at ?? 0) < now - STALE_TX_MS) {
      const [, path, name, tx] = k.split(S)
      const m = await deps.db.get(mKey(path, name))
      if (!m || m.tx !== tx) await dropTx(path, name, tx, deps)
    }
  }
  return dropped
}

// ---------------------------------------------------------------- IndexedDB

/** The real adapter: its own database, so large values never share a version with the grant store. */
export function idbAdapter(dbName = 'bento-docstore') {
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open(dbName, 1)
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv') }
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  const tx = async (mode, fn) => {
    const d = await open()
    return new Promise((res, rej) => {
      const t = d.transaction('kv', mode)
      const out = fn(t.objectStore('kv'))
      t.oncomplete = () => res(out?.result ?? out?.value)
      t.onerror = () => rej(t.error)
    })
  }
  return {
    get: (k) => tx('readonly', (s) => s.get(k)).then((v) => v ?? null),
    put: (k, v) => tx('readwrite', (s) => { s.put(v, k) }),
    del: (k) => tx('readwrite', (s) => { s.delete(k) }),
    range: async (lo, hi) => {
      const d = await open()
      return new Promise((res, rej) => {
        const out = []
        const req = d.transaction('kv', 'readonly').objectStore('kv').openCursor(IDBKeyRange.bound(lo, hi))
        req.onsuccess = () => { const c = req.result; if (c) { out.push([c.key, c.value]); c.continue() } else res(out) }
        req.onerror = () => rej(req.error)
      })
    },
  }
}
