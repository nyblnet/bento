// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/connect — where the extension keeps its Bento ID: its own IndexedDB
// database, one record. The keys are NON-extractable CryptoKeys (IndexedDB
// stores them by structured clone; no page and no other extension can reach
// this origin). Removing the extension deletes all of it — which is why setup
// insists on a way back (a passkey blob or a recovery code).
//
// `db` is injectable so the rig runs the same code against memory.

const NAME = 'bento-connect'
const SELF = 'self'

export function idb(name = NAME) {
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open(name, 1)
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv') }
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  const run = async (mode, fn) => {
    const d = await open()
    return new Promise((res, rej) => {
      const t = d.transaction('kv', mode)
      const req = fn(t.objectStore('kv'))
      t.oncomplete = () => res(req?.result)
      t.onerror = () => rej(t.error)
    })
  }
  return {
    get: (k) => run('readonly', (s) => s.get(k)).then((v) => v ?? null),
    put: (k, v) => run('readwrite', (s) => s.put(v, k)).then(() => {}),
    del: (k) => run('readwrite', (s) => s.delete(k)).then(() => {}),
  }
}

/** This browser's Bento ID record, or null. */
export const loadSelf = (db = idb()) => db.get(SELF)

/**
 * Store a newly created Bento ID — only if there is none yet. A second setup
 * never silently replaces the first (that would orphan its keys); replacing is
 * an explicit, later flow (remove, then set up).
 */
export async function saveNewSelf(record, db = idb()) {
  if (await db.get(SELF)) return { ok: false, reason: 'exists' }
  if (record?.accountKey?.extractable !== false || record?.deviceKey?.extractable !== false) return { ok: false, reason: 'extractable key' }
  await db.put(SELF, record)
  return { ok: true }
}

/** What a page may show about it: public fields only. */
export function publicView(record) {
  if (!record) return null
  return {
    state: record.state, label: record.label, created: record.created, accountPub: record.accountPub, devicePub: record.devicePub,
    passkeys: record.passkeys.length, recovery: !!record.recovery,
  }
}
