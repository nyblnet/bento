#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The plaintext store's BACKSTOP (security, after K3): while the body is sealed,
// kernel/src/autosave.ts neither keeps nor offers a plaintext copy, and still
// DELETES, because the purge of copies left from an earlier unsealed session
// depends on it.
//
// Each app guards its own calls to the store. This is the one place they all go
// through, so an app that misses one of its ~11 sites still can't write or offer
// plaintext for a sealed document. (The sealed-test helper fails any app that
// leans on it, through a refusal counter only the test probe can read.)
//
//   esbuild-bundled like test-autosave.ts (fake-indexeddb); see the CI step.

import 'fake-indexeddb/auto'
import { configureApp } from '../kernel/src/app.ts'
import { putRecovery, getRecovery, addVersion, listVersions, clearRecovery, clearVersions } from '../kernel/src/autosave.ts'
import { setIdentitySeal, setEncryptionPassword, isBodySealed, storeRefusalCount } from '../kernel/src/save.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

configureApp({ appId: 'bento-slides', appName: 'Bento Slides', manifestUrl: 'https://invalid.example/m.json' })
const kdoc = Uint8Array.from({ length: 32 }, (_, i) => i + 9)
const docOf = (docId: string, title: string) => ({ format: 'bento/slides', docId, title, slides: [] }) as never
const A = docOf('doc-a', 'ZZ A ZZ'), B = docOf('doc-b', 'ZZ B ZZ')

console.log('\nunsealed: the store keeps and offers, as today')
ok(!isBodySealed(), 'nothing is sealed')
ok(await putRecovery(A), 'putRecovery stores')
ok((await getRecovery('doc-a'))?.title === 'ZZ A ZZ', 'getRecovery offers it')
await addVersion(A)
ok((await listVersions('doc-a')).length === 1, 'addVersion keeps a version, and listVersions offers it')
await putRecovery(B); await addVersion(B)

for (const [label, seal, unseal] of [
  ['the identity seal', () => setIdentitySeal(kdoc), () => setIdentitySeal(null)],
  ['a password', () => setEncryptionPassword('correct horse'), () => setEncryptionPassword(null)],
] as const) {
  console.log(`\nsealed by ${label}: nothing kept, nothing offered`)
  seal()
  ok(isBodySealed(), 'sealed')
  ok((await putRecovery(docOf('doc-a', 'ZZ NEW ZZ'))) === false, 'putRecovery refuses')
  ok((await getRecovery('doc-a')) === null, 'getRecovery offers nothing (the earlier plaintext copy is not shown)')
  await addVersion(docOf('doc-a', 'ZZ NEW ZZ'))
  ok((await listVersions('doc-a')).length === 0, 'listVersions offers nothing')
  unseal()
  ok((await getRecovery('doc-a'))?.title === 'ZZ A ZZ', 'unsealed again: the refused write never landed (the old copy is untouched)')
  ok((await listVersions('doc-a')).length === 1, 'and no version was added while sealed')
}

console.log('\nthe refusal counter, directly: each refused call counts once, nothing else counts')
{
  const n0 = storeRefusalCount()
  await putRecovery(docOf('doc-c', 'c')); await addVersion(docOf('doc-c', 'c'))
  await getRecovery('doc-c'); await listVersions('doc-c')
  ok(storeRefusalCount() === n0, 'unsealed: four store calls, the counter unchanged')
  setIdentitySeal(kdoc)
  await putRecovery(docOf('doc-c', 'c')); await addVersion(docOf('doc-c', 'c'))
  ok(storeRefusalCount() === n0 + 2, 'sealed: putRecovery + addVersion raise it by exactly 2')
  await getRecovery('doc-c'); await listVersions('doc-c')
  ok(storeRefusalCount() === n0 + 4, 'sealed: READS count too: getRecovery + listVersions raise it by 2 more')
  await clearRecovery('doc-c'); await clearVersions('doc-c')
  ok(storeRefusalCount() === n0 + 4, 'sealed: the purge is not a refusal (unchanged)')
  setIdentitySeal(null)
}

console.log('\nthe purge still works while sealed, for that document only')
setIdentitySeal(kdoc)
await clearRecovery('doc-a')
await clearVersions('doc-a')
setIdentitySeal(null)
ok((await getRecovery('doc-a')) === null, 'clearRecovery deleted the plaintext recovery copy while sealed')
ok((await listVersions('doc-a')).length === 0, 'clearVersions deleted the plaintext versions while sealed')
ok((await getRecovery('doc-b'))?.title === 'ZZ B ZZ', "another document's recovery copy survives")
ok((await listVersions('doc-b')).length === 1, "another document's versions survive")

console.log('\nthe sealed purge reaches the legacy shared database too (shipped shells write there)')
{
  const LEGACY = 'bento-autosave'
  // FIRST: a browser that never had the legacy database must not gain one.
  // indexedDB.open() creates a missing database, and the purge runs on every
  // sealed boot (security).
  const names = async () => (await indexedDB.databases()).map((d) => d.name)
  await new Promise<void>((res) => { const q = indexedDB.deleteDatabase(LEGACY); q.onsuccess = q.onerror = q.onblocked = () => res() })
  ok(!(await names()).includes(LEGACY), 'setup: no legacy database in this browser')
  setIdentitySeal(kdoc)
  await clearRecovery('doc-x'); await clearVersions('doc-x')
  setIdentitySeal(null)
  ok(!(await names()).includes(LEGACY), 'a sealed purge in a browser with no legacy database leaves none behind')
  const openLegacy = (): Promise<IDBDatabase> => new Promise((res, rej) => {
    const q = indexedDB.open(LEGACY, 1)
    q.onupgradeneeded = () => {
      const d = q.result
      if (!d.objectStoreNames.contains('recovery')) d.createObjectStore('recovery', { keyPath: 'docId' })
      if (!d.objectStoreNames.contains('versions')) d.createObjectStore('versions', { keyPath: 'id', autoIncrement: true }).createIndex('docId', 'docId', { unique: false })
    }
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error)
  })
  const run = <T,>(db: IDBDatabase, store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) =>
    new Promise<T>((res, rej) => { const r = f(db.transaction(store, mode).objectStore(store)); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const countIn = async (docId: string) => {
    const db = await openLegacy()
    const rec = await run(db, 'recovery', 'readonly', (s) => s.get(docId))
    const ver = await run(db, 'versions', 'readonly', (s) => s.index('docId').count(IDBKeyRange.only(docId)))
    db.close()
    return { rec: !!rec, ver }
  }
  // what an OLD shell left behind: plaintext for two documents in the shared DB
  {
    const db = await openLegacy()
    for (const id of ['doc-l', 'doc-other']) {
      await run(db, 'recovery', 'readwrite', (s) => s.put({ docId: id, at: 1, title: 'ZZ OLD ZZ', json: '{}' }))
      await run(db, 'versions', 'readwrite', (s) => s.add({ docId: id, at: 1, title: 'ZZ OLD ZZ', json: '{}' }))
      await run(db, 'versions', 'readwrite', (s) => s.add({ docId: id, at: 2, title: 'ZZ OLD ZZ', json: '{}' }))
    }
    db.close()
  }
  ok((await countIn('doc-l')).rec && (await countIn('doc-l')).ver === 2, 'setup: an old shell left doc-l plaintext in the legacy database')
  // unsealed, a purge leaves the legacy database alone, as before
  await clearRecovery('doc-l'); await clearVersions('doc-l')
  ok((await countIn('doc-l')).rec && (await countIn('doc-l')).ver === 2, 'unsealed: clearRecovery/clearVersions leave the legacy database alone')
  setIdentitySeal(kdoc)
  await clearRecovery('doc-l'); await clearVersions('doc-l')
  setIdentitySeal(null)
  const l = await countIn('doc-l'), o = await countIn('doc-other')
  ok(!l.rec && l.ver === 0, "sealed: the purge deletes doc-l's recovery copy and versions from the legacy database")
  ok(o.rec && o.ver === 2, "another document's legacy rows survive")
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
