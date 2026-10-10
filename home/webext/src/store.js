// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// DocStore, the extension backend: what a document keeps beside itself —
// its CRASH RECOVERY and its collab MEMBER KEY, nothing else — stored in THIS
// extension's origin rather than the page's. (Version history lives in the
// file itself: maintainer ruling, 2026-10-10.)
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
// names, delete(name). The names are exactly NAMES; values are opaque —
// stored blindly, never parsed. No encryption on this path: the partition is
// the isolation.
//
// TRANSPORT. Runtime messaging is JSON, so bytes cross the relay↔worker hop
// as base64, and a value over CHUNK bytes travels as numbered chunks under a
// transaction id, committed in one step: a reader sees the old value or the
// new one, never half. A transfer that began before the value now committed
// is refused as 'superseded', so a late write never replaces a newer one. Every message re-derives the partition and holds no
// state between messages (the worker is evicted at will); chunks of a
// transfer that never committed are swept by `gc`.
//
// A MOVED FILE (security ruling 2026-10-10, handoffs/…docstore-carryover).
// The partition is the path, so a moved or renamed document opens with an
// empty one. Its recovery may FOLLOW it — once — and only when all of this
// holds, every part checked by the extension, none taken from the page:
//   · the new file's #bento-doc block hashes to the hash recorded when the
//     extension last WROTE the old file (`recordSaved`, at every save it
//     performs) — the same saved document, moved; a different file, or one
//     edited elsewhere since, does not match and nothing carries;
//   · the old path is GONE, as seen through the extension's own folder grant
//     (`deps.gone`): where the old folder is not granted, or the answer is
//     anything but a definite not-found, nothing carries;
//   · the recovery was written in the last CARRY_DAYS;
//   · exactly one old partition qualifies.
// It MOVES (re-keyed, the old entry deleted), so two files can never both
// claim it. The MEMBER KEY NEVER CARRIES: a moved honest file re-enrols
// through its own invite chain, and nothing here can tell a genuine file from
// one that copied its docId. Whatever carries reaches the page through the
// kernel's restore gate like any other recovery.
//
// RETENTION. `recovery` and `memberkey` are single entries by construction.
// A partition untouched for MAX_AGE_DAYS is dropped. One whose file is gone is
// kept only while it could still carry (recovery younger than CARRY_DAYS),
// then dropped; "gone" is the grant's answer, never a guess.
//
// Pure: the IndexedDB adapter, the hash, the file reader and the grant walk
// come in as `deps`, so scripts/test-webext-store.ts drives the real code.

/** Bytes per chunk on the relay↔worker hop (before base64). */
export const CHUNK = 3 * 1024 * 1024
/** Largest value one name may hold. */
export const MAX_VALUE = 64 * 1024 * 1024
/** The only names a document may keep here. */
export const NAMES = Object.freeze(['recovery', 'memberkey'])
/** A partition untouched this long is dropped. */
export const MAX_AGE_DAYS = 30
/** A recovery older than this never follows a moved file. */
export const CARRY_DAYS = 7
const DAY = 24 * 3600 * 1000
/** A transfer that never committed is swept after this long. */
const STALE_TX_MS = 3600 * 1000

/** Names: exactly NAMES. Prefixes for list: any string, matched against NAMES. */
export const validName = (n) => typeof n === 'string' && NAMES.includes(n)
export const validPrefix = (p) => typeof p === 'string' && p.length <= 200 && !p.includes('\u0000')
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
  // `start` (first chunk) orders transfers for commit; `at` (latest chunk) is for the stale sweep
  const tk = `t${S}${path}${S}${p.name}${S}${p.tx}`
  const t = await deps.db.get(tk)
  await deps.db.put(tk, { start: t?.start ?? deps.now(), at: deps.now() })
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
  // A LATE transfer — one that began before the value now committed, e.g. a
  // write the page gave up waiting for and has since sent again — must not
  // replace the newer value. Refused, and its chunks dropped; the newer one stands.
  const begun = (await deps.db.get(`t${S}${path}${S}${p.name}${S}${p.tx}`))?.start
  if (old && old.tx !== p.tx && begun != null && (old.at ?? 0) > begun) {
    await dropTx(path, p.name, p.tx, deps)
    return { ok: false, reason: 'superseded' }
  }
  await deps.db.put(mKey(path, p.name), { tx: p.tx, n: p.n, size, at: deps.now() })
  await deps.db.del(`t${S}${path}${S}${p.name}${S}${p.tx}`)
  if (old && old.tx !== p.tx) await dropTx(path, p.name, old.tx, deps)
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

// ---------------------------------------------------------------- moved files

const SCRIPT_CLOSE = '</' + 'script>'
const DOC_ATTR = ' id="bento-doc"'
/**
 * The #bento-doc body of an HTML file, exactly as kernel/src/save.ts
 * `embeddedDocBlock` reads it (anchored on the id attribute, CRLF normalised,
 * trimmed), so the hash here and the kernel's notion of "same document" agree.
 */
export function docBlock(html) {
  const at = html.indexOf(DOC_ATTR)
  if (at < 0) return null
  const start = html.indexOf('>', at + DOC_ATTR.length)
  if (start < 0) return null
  const end = html.indexOf(SCRIPT_CLOSE, start + 1)
  if (end < 0) return null
  return html.slice(start + 1, end).replace(/\r\n/g, '\n').trim() || null
}

/** sha-256 (hex) of the block's UTF-8 bytes, or null when there is no block. */
export async function blockHash(html, deps) {
  const block = docBlock(String(html ?? ''))
  return block == null ? null : deps.sha256(new TextEncoder().encode(block))
}

const hKey = (path) => `h${S}${path}`

/**
 * The extension just WROTE this file: remember which document it now holds.
 * Called from the worker's own save path with the bytes it wrote — never with
 * anything the page says about itself.
 */
export async function recordSaved(path, html, deps) {
  if (!path) return
  const hash = await blockHash(html, deps)
  if (hash) await deps.db.put(hKey(path), { hash, at: deps.now() })
  else await deps.db.del(hKey(path))
}

/** Move one entry (manifest + chunks) from one partition to another; the old one is deleted. */
async function moveEntry(from, to, name, deps) {
  const m = await deps.db.get(mKey(from, name))
  if (!m) return false
  for (let i = 0; i < m.n; i++) {
    const c = await deps.db.get(cKey(from, name, m.tx, i))
    if (c == null) return false
  }
  for (let i = 0; i < m.n; i++) await deps.db.put(cKey(to, name, m.tx, i), await deps.db.get(cKey(from, name, m.tx, i)))
  await deps.db.put(mKey(to, name), { ...m, at: deps.now() })
  await deps.db.del(mKey(from, name))
  await dropTx(from, name, m.tx, deps)
  return true
}

/**
 * A document opened at `path`: if its partition is empty, may a moved
 * document's recovery follow it? Returns what happened, for the log and the
 * rig: { carried: oldPath } or { carried: null, why }.
 */
export async function carry(path, deps) {
  if (!path) return { carried: null, why: 'not a document' }
  const own = await deps.db.range(`m${S}${path}${S}`, `m${S}${path}${S}${END}`)
  if (own.length) return { carried: null, why: 'has its own' }
  let hash = null
  try { hash = await deps.fileBlockHash(path) } catch { hash = null }
  if (!hash) return { carried: null, why: 'no block' }
  const cutoff = deps.now() - CARRY_DAYS * DAY
  const eligible = []
  for (const [k, v] of await deps.db.range(`h${S}`, `h${S}${END}`)) {
    const old = k.slice(2)
    if (old === path || v?.hash !== hash) continue
    const rec = await deps.db.get(mKey(old, 'recovery'))
    if (!rec || !(rec.at >= cutoff)) continue
    let state = 'unknown'
    try { state = await deps.gone(old) } catch { state = 'unknown' }
    if (state !== 'gone') continue
    eligible.push(old)
  }
  if (!eligible.length) return { carried: null, why: 'nothing matches' }
  if (eligible.length > 1) return { carried: null, why: 'ambiguous' }
  const [old] = eligible
  // recovery ONLY. The member key stays behind with the old partition and is swept.
  if (!(await moveEntry(old, path, 'recovery', deps))) return { carried: null, why: 'incomplete' }
  await deps.db.put(hKey(path), { ...(await deps.db.get(hKey(old))), at: deps.now() })
  await deps.db.del(hKey(old))
  await deps.db.put(`x${S}${path}`, { from: old, at: deps.now() })
  return { carried: old }
}

/**
 * Is `path` definitely gone? Asked through a folder grant whose location the
 * extension has PROVEN (db prefixes): walk from it; a NotFoundError on the way
 * is 'gone', reaching the file is 'present', anything else — no grant covers
 * it, permission lapsed, an unexpected error — is 'unknown'. Never a file://
 * probe: a folder the browser may not read (macOS privacy, say) looks exactly
 * like a missing one.
 */
export async function goneVia(path, grants) {
  for (const { dir, prefix } of grants) {
    if (!prefix || !path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) continue
    const rel = path.slice(prefix.length).split('/').filter(Boolean)
    if (!rel.length) continue
    try {
      if (await dir.queryPermission({ mode: 'read' }) !== 'granted') continue
      let cur = dir
      for (const seg of rel.slice(0, -1)) cur = await cur.getDirectoryHandle(seg)
      await cur.getFileHandle(rel[rel.length - 1])
      return 'present'
    } catch (e) {
      if (e?.name === 'NotFoundError') return 'gone'
    }
  }
  return 'unknown'
}

/**
 * The sweep: partitions untouched for MAX_AGE_DAYS; partitions whose file is
 * gone and whose recovery is too old to carry; and chunks of transfers that
 * never committed. Returns what it dropped, for the log and the rig.
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
    let why = newest < now - MAX_AGE_DAYS * DAY ? 'age' : null
    if (!why) {
      let state = 'unknown'
      try { state = await deps.gone(path) } catch { state = 'unknown' }
      if (state === 'gone') {
        const rec = await deps.db.get(mKey(path, 'recovery'))
        // still a carry candidate: keep it until it is too old to follow
        if (!(rec && rec.at >= now - CARRY_DAYS * DAY)) why = 'gone'
      }
    }
    if (!why) continue
    for (const [k] of await deps.db.range(`m${S}${path}${S}`, `m${S}${path}${S}${END}`)) {
      await remove(path, { name: k.slice(mKey(path, '').length) }, deps)
    }
    await deps.db.del(hKey(path))
    await deps.db.del(`x${S}${path}`)
    dropped.push({ path, why })
  }
  // Chunks no manifest points to and no live transfer owns: left when two
  // commits interleaved (each dropped the value it read as old, not the other's).
  const live = new Set((await deps.db.range(`t${S}`, `t${S}${END}`)).map(([k]) => k.slice(2)))
  for (const [k] of await deps.db.range(`c${S}`, `c${S}${END}`)) {
    const [, path, name, tx] = k.split(S)
    if (live.has(`${path}${S}${name}${S}${tx}`)) continue
    const m = await deps.db.get(mKey(path, name))
    if (!m || m.tx !== tx) await deps.db.del(k)
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
