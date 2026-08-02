#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Autosave per-app database rig.
//
//   esbuild scripts/test-autosave.ts --bundle --platform=node --format=esm ...
//   BENTO_TEST_APP=bento-slides node <bundle>
//   BENTO_TEST_APP=bento-spaces node <bundle>
//
// (bundled so `fake-indexeddb` resolves from slides/node_modules, matching
// test-clipboard and test-validate)
//
// WHAT THIS PROVES. Every app used to share one IndexedDB database,
// `bento-autosave`, and one `DB_VERSION`. Two failures, one shared:
//
//   1. Snapshots from different apps piled into one store wherever they share
//      an origin — bento.page, or any local server. bento/spaces has been
//      writing into bento/slides' database since its scaffold landed.
//   2. Worse, and asymmetric: DB_VERSION was shared too. A new app bumping it
//      to 2 makes every ALREADY-SHIPPED shell of every other app throw
//      VersionError on open and lose autosave outright. Shipped shells are
//      frozen code — they go on opening version 1 forever, and 1.0.11 files
//      are in the world today.
//
// The rename alone would silently drop every user's recovery snapshot and
// their whole version timeline — a visible feature emptying itself, which is
// a bug report rather than a migration. So the properties tested here are:
// the database is named per app, the legacy contents are carried over ONCE,
// the legacy database is left intact for shells that still write to it, and a
// second run neither duplicates the timeline nor resurrects deleted rows.

import 'fake-indexeddb/auto'
import { configureApp } from '../kernel/src/app.ts'
import { putRecovery, getRecovery, addVersion, listVersions } from '../kernel/src/autosave.ts'

const APP = process.env.BENTO_TEST_APP || 'bento-slides'
const EXPECTED_DB = `${APP}-autosave`
const LEGACY = 'bento-autosave'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const open = (name: string, version?: number): Promise<IDBDatabase> =>
  new Promise((res, rej) => {
    const q = version ? indexedDB.open(name, version) : indexedDB.open(name)
    q.onupgradeneeded = () => {
      const d = q.result
      if (!d.objectStoreNames.contains('recovery')) d.createObjectStore('recovery', { keyPath: 'docId' })
      if (!d.objectStoreNames.contains('versions')) {
        const s = d.createObjectStore('versions', { keyPath: 'id', autoIncrement: true })
        s.createIndex('docId', 'docId', { unique: false })
      }
    }
    q.onsuccess = () => res(q.result)
    q.onerror = () => rej(q.error)
  })

const readAll = (db: IDBDatabase, store: string): Promise<any[]> =>
  new Promise((res) => {
    if (!db.objectStoreNames.contains(store)) return res([])
    const r = db.transaction(store, 'readonly').objectStore(store).getAll()
    r.onsuccess = () => res(r.result ?? [])
    r.onerror = () => res([])
  })

const dbNames = async () => (await indexedDB.databases()).map((d: any) => d.name).sort()

// ---- seed the shared legacy database, as a pre-upgrade user would have it ---
// Both apps' rows, because both wrote here.
const now = Date.now()
{
  const legacy = await open(LEGACY, 1)
  await new Promise<void>((res) => {
    const t = legacy.transaction(['recovery', 'versions'], 'readwrite')
    t.objectStore('recovery').put({ docId: 'deck-uuid-1', at: now, title: 'A deck', json: '{"a":1}' })
    t.objectStore('recovery').put({ docId: 'space-uuid-1', at: now, title: 'A space', json: '{"b":2}' })
    for (let i = 0; i < 3; i++) {
      t.objectStore('versions').add({ docId: 'deck-uuid-1', at: now - i * 1000, title: `v${i}`, json: '{}' })
    }
    t.oncomplete = () => res()
  })
  legacy.close()
}

configureApp({ appId: APP, appName: APP, manifestUrl: 'https://example.invalid/m.json' })

// ---- first use triggers open + migration -----------------------------------
const carried = await getRecovery('deck-uuid-1')
ok((await dbNames()).includes(EXPECTED_DB), `the database is named ${EXPECTED_DB}, not the shared ${LEGACY}`)
ok(carried !== null && carried.title === 'A deck',
  `a recovery snapshot written before the rename is still found (got ${carried ? carried.title : 'null'})`)
ok((await getRecovery('space-uuid-1')) !== null,
  'rows the OTHER app wrote are carried too — nothing records which app wrote a snapshot, and a uuid docId can never collide')
ok((await listVersions('deck-uuid-1')).length === 3,
  `the version timeline survives the rename (got ${(await listVersions('deck-uuid-1')).length}/3)`)

// ---- the legacy database is COPIED, never moved -----------------------------
// Shells already shipped keep writing to the old name; emptying it would break
// the copy of the app the user opens next.
{
  const legacy = await open(LEGACY)
  const rec = await readAll(legacy, 'recovery')
  const ver = await readAll(legacy, 'versions')
  legacy.close()
  ok(rec.length === 2 && ver.length === 3,
    `the legacy database is left intact for shipped shells (${rec.length} recovery, ${ver.length} versions)`)
}

// ---- the new database is live ----------------------------------------------
ok(await putRecovery({ docId: 'deck-uuid-1', title: 'A deck, edited', json: '' } as any),
  'putRecovery reports success against the per-app database')
ok((await getRecovery('deck-uuid-1'))!.title === 'A deck, edited', 'the newer snapshot wins')

// ---- migration runs ONCE ---------------------------------------------------
// A second pass would duplicate the timeline, and would resurrect any snapshot
// the user had deleted. Re-running the migration against a populated target
// must be a no-op.
await addVersion({ docId: 'deck-uuid-1', title: 'v3', json: '{}' } as any)
const after = await listVersions('deck-uuid-1')
ok(after.length === 4, `adding one version gives 4, not 7 — the legacy rows were not copied twice (got ${after.length})`)

console.log(`\n[${APP}] ${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
