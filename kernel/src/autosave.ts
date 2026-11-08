// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Local auto-save + lightweight version history, backed by IndexedDB.
//
// Two concerns, one store:
//   · recovery  — a single latest snapshot per docId, overwritten each cycle.
//     On reopen, if it differs from the file we loaded, we offer to restore
//     (the safety net for a crash / tab-close before a save, and the ONLY net
//     on browsers without the File System Access API).
//   · versions  — a capped, throttled timeline of snapshots per docId, for the
//     "Version history" restore UI.
//
// Snapshots hold the plain document JSON (a few KB–tens of KB), NOT the ~430KB
// HTML shell — restore re-injects via store.replaceDoc. Encrypted decks are
// never snapshotted here (that would write plaintext to disk); their file
// write-back stays encrypted.

import type { KernelDoc } from './doc.ts'
import { appConfig } from './app.ts'
import { docStore, getJSON, setJSON } from './docstore.ts'
import { isBodySealed, noteStoreRefusal } from './save.ts'

/**
 * The BACKSTOP (security): while the body is sealed, by a password or the
 * identity seal, this store neither keeps nor offers a plaintext copy. Every app
 * already guards its own calls; this is the one place they all go through, so an
 * app that misses one of its sites still cannot write or offer plaintext.
 * Deleting stays allowed (clearRecovery, clearVersions): the purge of copies left
 * from an earlier unsealed session depends on it. Each refusal is counted
 * (save.ts noteStoreRefusal), and the sealed-test rigs fail on any, so an app
 * that relies on this instead of its own guard still fails its own rig.
 */
function sealedRefusal(): boolean {
  if (!isBodySealed()) return false
  noteStoreRefusal()
  return true
}

/**
 * One database PER APP.
 *
 * Every app used to share `bento-autosave`, which is two problems, not one.
 * The visible one is that two apps' snapshots pile into one store wherever
 * they share an origin — `bento.page`, or any local server. The dangerous one
 * is `DB_VERSION`: it was shared too, so a new app bumping it to 2 would make
 * every ALREADY-SHIPPED shell of every other app throw `VersionError` on open
 * and lose autosave entirely. Files in the world are frozen code; they would
 * go on opening version 1 forever and there is no way to reach them.
 *
 * `appId` is already `bento-slides` / `bento-spaces`, so this reads
 * `bento-slides-autosave` — no doubled prefix, and no special case for the
 * app that happened to be first. Each app now owns its own version line.
 *
 * Called lazily rather than at module scope: `appConfig()` throws before
 * `configureApp()` runs, and a kernel module that explodes at import time
 * depending on evaluation order is the import-order trap app.ts exists to
 * avoid.
 */
const dbName = () => `${appConfig().appId}-autosave`

/** The shared name every app wrote to before scoping. Read once, then left alone. */
const LEGACY_DB_NAME = 'bento-autosave'
const DB_VERSION = 1
const RECOVERY = 'recovery'
const VERSIONS = 'versions'
const MAX_VERSIONS = 20 // per doc
const PRUNE_DAYS = 30

export interface Snapshot {
  id?: number
  docId: string
  at: number
  title: string
  json: string
}

let dbPromise: Promise<IDBDatabase | null> | null = null

/** Open a database by name, creating this build's stores. */
function open(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    let req: IDBOpenDBRequest
    try { req = indexedDB.open(name, DB_VERSION) } catch { resolve(null); return }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(RECOVERY)) db.createObjectStore(RECOVERY, { keyPath: 'docId' })
      if (!db.objectStoreNames.contains(VERSIONS)) {
        const s = db.createObjectStore(VERSIONS, { keyPath: 'id', autoIncrement: true })
        s.createIndex('docId', 'docId', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

/**
 * Open a database ONLY if it already exists. indexedDB.open() creates a
 * missing one, and the sealed purge runs on every sealed boot: in a browser
 * that never had the legacy database it would leave an empty one behind, a new
 * side effect whose name alone says something (security). So when the open has
 * to create it (an upgrade from version 0), abort that upgrade: the browser
 * then discards the database it was creating, and this resolves null.
 */
function openExisting(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    let req: IDBOpenDBRequest
    try { req = indexedDB.open(name) } catch { resolve(null); return }
    let created = false
    req.onupgradeneeded = (e) => {
      if (e.oldVersion === 0) { created = true; req.transaction?.abort() }
    }
    req.onsuccess = () => { if (created) { req.result.close(); resolve(null) } else resolve(req.result) }
    req.onerror = (e) => { e.preventDefault(); resolve(null) } // the abort lands here
    req.onblocked = () => resolve(null)
  })
}

/** Everything in one store of a database, or [] on any failure. */
function readAll(db: IDBDatabase, store: string): Promise<Snapshot[]> {
  return new Promise((resolve) => {
    let t: IDBTransaction
    try { t = db.transaction(store, 'readonly') } catch { resolve([]); return }
    const req = t.objectStore(store).getAll()
    req.onsuccess = () => resolve((req.result as Snapshot[]) ?? [])
    req.onerror = () => resolve([])
  })
}

/**
 * Carry snapshots over from the shared database, ONCE, on first open.
 *
 * Renaming without this would silently drop every user's recovery snapshot and
 * their whole version timeline — a visible feature quietly emptying itself,
 * which is a bug report, not a migration.
 *
 * It COPIES rather than moves: shells already shipped go on writing to the old
 * name forever, and deleting the source would break the copy of the app the
 * user might open next. The cost is that the old database lingers; `pruneOld`
 * ages its contents out on its own schedule.
 *
 * Everything is copied, not just this app's rows. Nothing in a snapshot records
 * which app wrote it — and it does not need to: `docId` is a uuid, so another
 * app's rows can never match a lookup here. Filtering would mean guessing.
 */
async function migrateLegacy(target: IDBDatabase, targetName: string): Promise<void> {
  if (targetName === LEGACY_DB_NAME) return
  // Only ever migrate INTO an empty database — a second pass would duplicate
  // the version timeline, and a user who deleted a snapshot would see it return.
  const existing = await readAll(target, RECOVERY)
  if (existing.length) return
  const legacy = await open(LEGACY_DB_NAME)
  if (!legacy) return
  try {
    const [recovery, versions] = await Promise.all([
      readAll(legacy, RECOVERY),
      readAll(legacy, VERSIONS),
    ])
    if (!recovery.length && !versions.length) return
    await new Promise<void>((resolve) => {
      let t: IDBTransaction
      try { t = target.transaction([RECOVERY, VERSIONS], 'readwrite') } catch { resolve(); return }
      const rs = t.objectStore(RECOVERY)
      const vs = t.objectStore(VERSIONS)
      for (const r of recovery) rs.put(r)
      // drop the old autoIncrement key so the target mints its own
      for (const v of versions) { const { id: _id, ...rest } = v; vs.add(rest as Snapshot) }
      t.oncomplete = () => resolve()
      t.onerror = () => resolve()
      t.onabort = () => resolve()
    })
  } finally {
    legacy.close()
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = (async () => {
    let name: string
    try { name = dbName() } catch { return null } // configureApp() never ran
    const db = await open(name)
    if (!db) return null
    try { await migrateLegacy(db, name) } catch { /* best effort, never fatal */ }
    return db
  })()
  return dbPromise
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then((db) => {
    if (!db) return null
    return new Promise<T | null>((resolve) => {
      let t: IDBTransaction
      try { t = db.transaction(store, mode) } catch { resolve(null); return }
      const req = fn(t.objectStore(store))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => resolve(null)
    })
  })
}

/**
 * A recovery/version snapshot is CONTENT ONLY — `doc.collab` is dropped.
 *
 * Every autosave writes to IndexedDB, and Chrome gives every `file://` document
 * ONE shared origin, so an IndexedDB record is readable by any other local
 * document. `doc.collab` carries the live-room secrets — the read key, the owner
 * and writer private keys, the invite, the audience key — and content recovery
 * has no use for them: restore takes `collab` from the file that is actually
 * open, never from the snapshot (see the editor's restore path), so a snapshot
 * that keeps collab would only be a place for those secrets to leak. A deck that
 * was never saved has no file to re-read and re-mints its collab, as it does
 * today. `collab` is a top-level field, so omitting it here removes it whole.
 */
function contentOnly(doc: KernelDoc): string {
  const { collab: _collab, ...rest } = doc as KernelDoc & { collab?: unknown }
  return JSON.stringify(rest)
}

/**
 * Write the single latest recovery snapshot for this doc.
 *
 * Returns whether it ACTUALLY stored. `tx()` resolves null on every failure
 * rather than throwing — no IndexedDB at all, a blocked open, a failed
 * transaction — which is right for a best-effort backstop but means a caller
 * cannot assume success. That distinction is load-bearing now that the editor
 * tells the author their work is "backed up in this browser": Safari in private
 * browsing and some `file://` contexts have no usable IndexedDB, and on iOS
 * that is exactly where a shared deck tends to be opened. Claiming a backstop
 * that isn't there would be worse than saying nothing.
 */
/** Documents whose recovery copy the host refused (e.g. too large) in this page. */
const recoveryRefused = new Set<string>()
const recoveryOffListeners = new Set<(docId: string, reason: string) => void>()

/** Has crash recovery been switched off for this document in this page? True
 *  after the per-document store refused its recovery copy (too large, say). */
export function recoveryOff(docId: string): boolean {
  return recoveryRefused.has(docId)
}

/** Be told, once per document, that its crash recovery is off — so the app can
 *  say so instead of implying a backstop that isn't there. Returns unsubscribe. */
export function onRecoveryOff(fn: (docId: string, reason: string) => void): () => void {
  recoveryOffListeners.add(fn)
  return () => { recoveryOffListeners.delete(fn) }
}

export async function putRecovery(doc: KernelDoc): Promise<boolean> {
  if (sealedRefusal()) return false
  const snap: Snapshot = { docId: doc.docId, at: Date.now(), title: doc.title, json: contentOnly(doc) }
  // Under a host with a per-document store (docstore.ts), the recovery copy
  // lives THERE — out of the storage origin every local file shares — and any
  // copy this origin still holds is removed. While that host is present the
  // copy NEVER falls back to this origin: a host that doesn't answer in time
  // may still be writing (the next autosave cycle writes again), and one that
  // refuses (too large) turns recovery off for the document, said once.
  const ds = docStore()
  if (ds) {
    if (recoveryRefused.has(doc.docId)) return false
    const out = await setJSON(ds, 'recovery', snap)
    if (out === 'stored') {
      void tx(RECOVERY, 'readwrite', (s) => s.delete(doc.docId))
      return true
    }
    if (out === 'refused') {
      recoveryRefused.add(doc.docId)
      const reason = 'the extension declined to keep a recovery copy of this document'
      console.info('[bento] crash recovery is off for this document:', reason)
      for (const fn of recoveryOffListeners) { try { fn(doc.docId, reason) } catch { /* a listener's problem */ } }
    }
    return false
  }
  const key = await tx(RECOVERY, 'readwrite', (s) => s.put(snap))
  return key != null
}

export async function getRecovery(docId: string): Promise<Snapshot | null> {
  if (sealedRefusal()) return null
  const ds = docStore()
  if (ds) {
    try {
      // the entry is per FILE, so check it is this document's before using it
      const held = await getJSON<Snapshot>(ds, 'recovery')
      if (held && held.docId === docId) return held
    } catch { /* host unavailable: fall back to this origin's store */ }
  }
  return (await tx<Snapshot>(RECOVERY, 'readonly', (s) => s.get(docId))) ?? null
}

/** Does the recovery snapshot look OLDER than the file now open? A SIGNAL for
 *  the app's banner, never a reason to HIDE the offer (maintainer ruling,
 *  2026-10-15): the banner warns ("This recovered copy looks older than the
 *  file. Restore anyway?") and keeping the file is the default, but the snapshot
 *  is always offered. The two times come from different clocks — `snap.at` is
 *  this device's ms (`Date.now()`), `doc.modified` is whichever device last
 *  saved (an ISO string) — so a false "older" under skew must only soften copy,
 *  never suppress. Returns true ONLY when both times are known and the snapshot
 *  is the older; unknown either side → false (say nothing). */
export function recoveryLooksOlder(snap: Snapshot, doc: { modified?: string | number }): boolean {
  const ms = (t: string | number | undefined): number | undefined => {
    if (typeof t === 'number') return Number.isFinite(t) ? t : undefined
    if (typeof t === 'string') { const n = Date.parse(t); return Number.isNaN(n) ? undefined : n }
    return undefined
  }
  const s = ms(snap.at), m = ms(doc.modified)
  return s !== undefined && m !== undefined && s < m
}

export async function clearRecovery(docId: string): Promise<void> {
  const ds = docStore()
  if (ds) {
    try {
      const held = await getJSON<Snapshot>(ds, 'recovery')
      if (!held || held.docId === docId) await ds.delete('recovery')
    } catch { /* host unavailable: nothing to clear there */ }
  }
  await tx(RECOVERY, 'readwrite', (s) => s.delete(docId))
  if (isBodySealed()) await purgeLegacy(docId, RECOVERY)
}

/** Delete every version-history snapshot for a docId. Used when a deck is
 *  encrypted: the plaintext snapshots written before encryption was enabled must
 *  not linger in IndexedDB (they'd defeat the encryption the user just turned on). */
export async function clearVersions(docId: string): Promise<void> {
  const all = await versionsOf(docId) // NOT listVersions: it reads nothing while sealed, and this must still delete
  await Promise.all(all.map((v) => tx(VERSIONS, 'readwrite', (s) => s.delete(v.id!))))
  if (isBodySealed()) await purgeLegacy(docId, VERSIONS)
}

/**
 * The sealed purge reaches the LEGACY shared database too (security). Shells
 * shipped before the per-app scoping go on writing to 'bento-autosave' forever,
 * so a document's plaintext from before it was sealed can sit there long after
 * this app's own copy is gone, until pruneOld ages it out. While the body is
 * sealed, purging a document deletes its rows there as well: that document
 * only, by docId. Outside a seal, clearRecovery/clearVersions leave the legacy
 * database alone, as before.
 */
async function purgeLegacy(docId: string, store: typeof RECOVERY | typeof VERSIONS): Promise<void> {
  let name: string
  try { name = dbName() } catch { return }
  if (name === LEGACY_DB_NAME) return // already purged above
  const legacy = await openExisting(LEGACY_DB_NAME)
  if (!legacy) return
  try {
    await new Promise<void>((resolve) => {
      let t: IDBTransaction
      try { t = legacy.transaction(store, 'readwrite') } catch { resolve(); return }
      const os = t.objectStore(store)
      if (store === RECOVERY) os.delete(docId)
      else {
        const cur = os.index('docId').openCursor(IDBKeyRange.only(docId))
        cur.onsuccess = () => { const c = cur.result; if (c) { c.delete(); c.continue() } }
      }
      t.oncomplete = () => resolve()
      t.onerror = () => resolve()
      t.onabort = () => resolve()
    })
  } finally {
    legacy.close()
  }
}

export async function addVersion(doc: KernelDoc): Promise<void> {
  if (sealedRefusal()) return
  await tx(VERSIONS, 'readwrite', (s) =>
    s.add({ docId: doc.docId, at: Date.now(), title: doc.title, json: contentOnly(doc) } as Snapshot))
  // prune to the newest MAX_VERSIONS for this doc
  const all = await versionsOf(doc.docId)
  if (all.length > MAX_VERSIONS) {
    const doomed = all.slice(MAX_VERSIONS)
    await Promise.all(doomed.map((v) => tx(VERSIONS, 'readwrite', (s) => s.delete(v.id!))))
  }
}

export async function listVersions(docId: string): Promise<Snapshot[]> {
  if (sealedRefusal()) return []
  return versionsOf(docId)
}

/** Every version snapshot for a docId, newest first, whatever the seal: for
 *  this module's own pruning and purging, never handed to an app. */
async function versionsOf(docId: string): Promise<Snapshot[]> {
  const db = await openDb()
  if (!db) return []
  return new Promise((resolve) => {
    let t: IDBTransaction
    try { t = db.transaction(VERSIONS, 'readonly') } catch { resolve([]); return }
    const idx = t.objectStore(VERSIONS).index('docId')
    const out: Snapshot[] = []
    const req = idx.openCursor(IDBKeyRange.only(docId))
    req.onsuccess = () => {
      const cur = req.result
      if (cur) { out.push(cur.value as Snapshot); cur.continue() }
      else resolve(out.sort((a, b) => b.at - a.at)) // newest first
    }
    req.onerror = () => resolve([])
  })
}

/** Drop snapshots older than PRUNE_DAYS across all docs (housekeeping). */
export async function pruneOld(): Promise<void> {
  const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000
  const db = await openDb()
  if (!db) return
  for (const store of [VERSIONS, RECOVERY]) {
    try {
      const t = db.transaction(store, 'readwrite')
      const req = t.objectStore(store).openCursor()
      req.onsuccess = () => {
        const cur = req.result
        if (!cur) return
        if ((cur.value as Snapshot).at < cutoff) cur.delete()
        cur.continue()
      }
    } catch { /* best effort */ }
  }
}
