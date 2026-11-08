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
/** The only record version read (agent.js RECORD_V). Kept literal here so the
 *  keystore stays importable without the agent. */
const RECORD_V = 2

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

/**
 * This browser's Bento ID record, or null.
 *
 * A record of any other version is DELETED, not migrated. Every v1 record is a
 * test enrolment from before kx placement was ruled (mode C, identity-design
 * §6b, 2026-11-02): its dev. has no kx, its blobs carry the account scalar
 * alone, and nothing under mode C accepts either. There is no upgrade path by
 * design; the person sets up again.
 */
export async function loadSelf(db = idb()) {
  const r = await db.get(SELF)
  if (r && r.v !== RECORD_V) { await db.del(SELF); return null }
  return r
}

/**
 * Store a newly created Bento ID — only if there is none yet. A second setup
 * never silently replaces the first (that would orphan its keys); replacing is
 * an explicit, later flow (remove, then set up).
 */
export async function saveNewSelf(record, db = idb()) {
  if (await loadSelf(db)) return { ok: false, reason: 'exists' }
  if (record?.v !== RECORD_V) return { ok: false, reason: 'version' }
  if (record?.accountKey?.extractable !== false || record?.deviceKey?.extractable !== false ||
      record?.kxKey?.extractable !== false || record?.recoveryKxKey?.extractable !== false) return { ok: false, reason: 'extractable key' }
  await db.put(SELF, record)
  return { ok: true }
}

/** What a page may show about it: public fields only. */
export function publicView(record) {
  if (!record) return null
  return {
    state: record.state, label: record.label, created: record.created, accountPub: record.accountPub, devicePub: record.devicePub,
    kxPub: record.kxPub, recoveryKxPub: record.recoveryKxPub,
    passkeys: record.passkeys.length, recovery: !!record.recovery,
  }
}
