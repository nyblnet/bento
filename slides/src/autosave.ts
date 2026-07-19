// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
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

import type { BentoDoc } from './model'

const DB_NAME = 'bento-autosave'
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

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    let req: IDBOpenDBRequest
    try { req = indexedDB.open(DB_NAME, DB_VERSION) } catch { resolve(null); return }
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
  })
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

/** The content that actually matters for "did this change" — excludes volatile
 *  fields (modified timestamp, collab sync state) that churn without a real edit. */
export function docContentKey(doc: BentoDoc): string {
  return JSON.stringify([doc.title, doc.size, doc.theme, doc.slides, doc.layouts ?? null, doc.fonts ?? null, doc.assets ?? null])
}

export async function putRecovery(doc: BentoDoc): Promise<void> {
  await tx(RECOVERY, 'readwrite', (s) =>
    s.put({ docId: doc.docId, at: Date.now(), title: doc.title, json: JSON.stringify(doc) } as Snapshot))
}

export async function getRecovery(docId: string): Promise<Snapshot | null> {
  return (await tx<Snapshot>(RECOVERY, 'readonly', (s) => s.get(docId))) ?? null
}

export async function clearRecovery(docId: string): Promise<void> {
  await tx(RECOVERY, 'readwrite', (s) => s.delete(docId))
}

/** Delete every version-history snapshot for a docId. Used when a deck is
 *  encrypted: the plaintext snapshots written before encryption was enabled must
 *  not linger in IndexedDB (they'd defeat the encryption the user just turned on). */
export async function clearVersions(docId: string): Promise<void> {
  const all = await listVersions(docId)
  await Promise.all(all.map((v) => tx(VERSIONS, 'readwrite', (s) => s.delete(v.id!))))
}

export async function addVersion(doc: BentoDoc): Promise<void> {
  await tx(VERSIONS, 'readwrite', (s) =>
    s.add({ docId: doc.docId, at: Date.now(), title: doc.title, json: JSON.stringify(doc) } as Snapshot))
  // prune to the newest MAX_VERSIONS for this doc
  const all = await listVersions(doc.docId)
  if (all.length > MAX_VERSIONS) {
    const doomed = all.slice(MAX_VERSIONS)
    await Promise.all(doomed.map((v) => tx(VERSIONS, 'readwrite', (s) => s.delete(v.id!))))
  }
}

export async function listVersions(docId: string): Promise<Snapshot[]> {
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
