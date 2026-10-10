#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// DocStore rig: per-document side data held by the host.
//
//   node scripts/test-docstore.ts
//
// Under the bento/home extension, a document's crash-recovery copy and its
// member key live in the extension's per-document store instead of the storage
// origin every local file shares. This rig stands in for the extension: a page
// that announces `window.__bentoHost.ops` including 'store', answering the same
// request/response protocol the extension's relay speaks, and accepting only the
// names the real worker accepts. It proves:
//   - with no host, nothing changes (localStorage / IndexedDB as before);
//   - with a host, recovery round-trips through it, and only for THIS document;
//   - the member key's PRIVATE half lives in the host; localStorage keeps only
//     the public key, so every existing reader of `bento-member-<docId>`.pub
//     still recognises this device;
//   - a key the browser already held is adopted (same pubkey, same People
//     entry), and its private half removed from localStorage;
//   - a host that refuses or never answers falls back to the old storage;
//   - only the two agreed names are ever used, and values travel as bytes.
//
// Mutations (verified by editing kernel/src and re-running; each fails by exit
// code): drop the per-file docId check in getRecovery; keep the private key in
// localStorage on adoption; drop the public-key mirror.

// ---- browser surface: localStorage, and a window that posts messages -------
const ls = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (ls.has(k) ? ls.get(k)! : null),
  setItem: (k: string, v: string) => { ls.set(k, String(v)) },
  removeItem: (k: string) => { ls.delete(k) },
}
type Listener = (ev: { data: unknown; source: unknown }) => void
const listeners = new Set<Listener>()
const win = {
  addEventListener: (t: string, fn: Listener) => { if (t === 'message') listeners.add(fn) },
  removeEventListener: (t: string, fn: Listener) => { if (t === 'message') listeners.delete(fn) },
  postMessage: (data: unknown) => {
    const clone = structuredClone(data) // what the browser hands the other side
    setTimeout(() => { for (const fn of [...listeners]) fn({ data: clone, source: win }) }, 0)
  },
  setTimeout, clearTimeout, setInterval, clearInterval,
}
;(globalThis as { window?: unknown }).window = win

// ---- the stand-in extension ------------------------------------------------
const CH = '__bento_tray__'
const NAMES = new Set(['recovery', 'memberkey']) // what the real worker accepts
let mode: 'ok' | 'refuse' | 'silent' = 'ok'
const store = new Map<string, Uint8Array>()
const seen: Array<{ op: string; name?: string; bytesIsU8?: boolean }> = []
win.addEventListener('message', (ev) => {
  const d = ev.data as Record<string, unknown> | null
  if (!d || d[CH] !== true || d.dir !== 'req' || typeof d.op !== 'string' || !d.op.startsWith('store.')) return
  const p = (d.payload ?? {}) as { name?: string; bytes?: unknown }
  seen.push({ op: d.op, name: p.name, bytesIsU8: d.op === 'store.set' ? p.bytes instanceof Uint8Array : undefined })
  if (mode === 'silent') return
  let result: unknown
  if (d.op !== 'store.list' && !NAMES.has(String(p.name))) result = { ok: false, reason: 'bad name' }
  else if (d.op === 'store.set') result = mode === 'refuse' ? { ok: false, reason: 'refused' } : (store.set(p.name!, p.bytes as Uint8Array), { ok: true })
  else if (d.op === 'store.get') result = { ok: true, bytes: store.get(p.name!) ?? null }
  else if (d.op === 'store.delete') result = (store.delete(p.name!), { ok: true })
  else if (d.op === 'store.list') result = { ok: true, names: [...store.keys()].sort() }
  win.postMessage({ [CH]: true, dir: 'res', id: d.id, result })
})
const setHost = (on: boolean) => {
  if (on) (globalThis as { __bentoHost?: unknown }).__bentoHost = { name: 'test', ops: ['claim', 'write', 'store'] }
  else delete (globalThis as { __bentoHost?: unknown }).__bentoHost
}

// session.ts (reached through online.ts) uses a TS parameter property, which
// strip-only node can't load; the app's own esbuild transform, as the session
// rigs do. Registered before the dynamic imports below.
const { register } = await import('node:module')
register('./lib/ts-resolve-hooks.mjs', import.meta.url)

const { docStore, resetDocStoreForTest, ExtensionBackend } = await import('../kernel/src/docstore.ts')
const { putRecovery, getRecovery, clearRecovery } = await import('../kernel/src/autosave.ts')
// One module instance; the member-key cache is per docId, and every row uses
// its own docId, so no row sees another's cached identity.
const online = await import('../kernel/src/sync/online.ts')
const freshOnline = async () => online

let checks = 0, failures = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }
const H = (s: string) => console.log(`\n=== ${s} ===`)
const doc = (docId: string, title = 'A deck') => ({ docId, title, slides: [{ id: 's1', note: 'unsaved work' }], collab: { key: 'K' } })
const dec = new TextDecoder()
const stored = (name: string) => { const b = store.get(name); return b ? JSON.parse(dec.decode(b)) : null }
const reset = () => { store.clear(); ls.clear(); seen.length = 0; mode = 'ok' }

H('no host: nothing changes')
{
  reset(); setHost(false); resetDocStoreForTest()
  ok(docStore() === null, 'no __bentoHost store capability → no DocStore')
  const { deviceIdentity } = await freshOnline()
  const id = await deviceIdentity('d-nohost')
  const raw = JSON.parse(ls.get('bento-member-d-nohost') ?? 'null')
  ok(raw?.pub === id.pub && raw?.priv === id.priv, 'the member key stays whole in localStorage, as before')
  ok(seen.length === 0, 'nothing is sent to a host that is not there')
}

H('recovery round-trips through the host, for THIS document only')
{
  reset(); setHost(true); resetDocStoreForTest()
  ok(docStore() !== null, 'a host announcing store → a DocStore')
  ok(await putRecovery(doc('d1') as never) === true, 'putRecovery reports it stored')
  const held = stored('recovery')
  ok(held?.docId === 'd1' && typeof held?.json === 'string' && held.json.includes('unsaved work'), 'the host holds this document\'s recovery copy')
  ok(!held?.json.includes('"collab"'), 'the recovery copy is content-only, as before')
  const back = await getRecovery('d1')
  ok(back?.docId === 'd1' && back.json === held.json, 'getRecovery returns it')
  ok(await getRecovery('some-other-doc') === null, 'a DIFFERENT document at this path gets nothing (the entry is per file)')
  await clearRecovery('d1')
  ok(!store.has('recovery'), 'clearRecovery removes it from the host')
}

H('member key: the private half lives in the host; localStorage keeps only the pubkey')
{
  reset(); setHost(true); resetDocStoreForTest()
  const { deviceIdentity } = await freshOnline()
  const id = await deviceIdentity('d2')
  const held = stored('memberkey')
  ok(held?.docId === 'd2' && held.pub === id.pub && held.priv === id.priv, 'the host holds the full member key, tagged with its document')
  const mirror = JSON.parse(ls.get('bento-member-d2') ?? 'null')
  ok(mirror?.pub === id.pub, 'localStorage still names this device\'s pubkey (presence and People views read it)')
  ok(mirror && !('priv' in mirror), 'and holds NO private key')
  // a later page: the host already holds this document's key from before, and
  // this browser's localStorage has nothing — the identity comes back from the host
  store.set('memberkey', new TextEncoder().encode(JSON.stringify({ docId: 'd2b', pub: 'HELD-PUB', priv: 'HELD-PRIV' })))
  const id2 = await deviceIdentity('d2b')
  ok(id2.pub === 'HELD-PUB' && id2.priv === 'HELD-PRIV', 'a later page gets its identity back from the host')
  ok(JSON.parse(ls.get('bento-member-d2b') ?? 'null')?.pub === 'HELD-PUB', 'and re-publishes the pubkey for the readers')
}

H('a key this browser already held is adopted, and its private half leaves localStorage')
{
  reset(); setHost(true); resetDocStoreForTest()
  const { deviceIdentity } = await freshOnline()
  const old = { pub: 'OLD-PUB', priv: 'OLD-PRIV' }
  ls.set('bento-member-d3', JSON.stringify(old))
  const id = await deviceIdentity('d3')
  ok(id.pub === 'OLD-PUB' && id.priv === 'OLD-PRIV', 'the same identity: this device keeps its People entry')
  ok(stored('memberkey')?.priv === 'OLD-PRIV', 'the host now holds the private key')
  const mirror = JSON.parse(ls.get('bento-member-d3') ?? 'null')
  ok(mirror?.pub === 'OLD-PUB' && !('priv' in mirror), 'localStorage keeps the pubkey and no longer the private key')
}

H('a host entry for another document is never used')
{
  reset(); setHost(true); resetDocStoreForTest()
  store.set('memberkey', new TextEncoder().encode(JSON.stringify({ docId: 'someone-else', pub: 'X-PUB', priv: 'X-PRIV' })))
  const { deviceIdentity } = await freshOnline()
  const id = await deviceIdentity('d4')
  ok(id.pub !== 'X-PUB', 'a key tagged for another document is not adopted')
  ok(stored('memberkey')?.docId === 'd4', 'this document\'s own key replaces it')
}

H('a host that refuses, or never answers, falls back to the old storage')
{
  reset(); setHost(true); resetDocStoreForTest(); mode = 'refuse'
  const a = await freshOnline()
  const id = await a.deviceIdentity('d5')
  const raw = JSON.parse(ls.get('bento-member-d5') ?? 'null')
  ok(raw?.priv === id.priv, 'refused: the member key is kept whole in localStorage')
  ok(await putRecovery(doc('d5') as never) === false || !store.has('recovery'), 'refused: recovery is not claimed as held by the host')

  reset(); setHost(true); resetDocStoreForTest(new ExtensionBackend(40)); mode = 'silent'
  const b = await freshOnline()
  const t = Date.now()
  const id2 = await b.deviceIdentity('d6')
  ok(Date.now() - t < 2000, 'silent: the wait is bounded (no hang)')
  ok(JSON.parse(ls.get('bento-member-d6') ?? 'null')?.priv === id2.priv, 'silent: the member key is kept whole in localStorage')
  ok(await getRecovery('d6') === null, 'silent: getRecovery falls back and returns nothing (no throw)')
}

H('only the two agreed names are used, and values travel as bytes')
{
  ok(seen.every((s) => s.op === 'store.list' || s.name === 'recovery' || s.name === 'memberkey'),
    `names used: ${[...new Set(seen.map((s) => s.name))].join(', ') || '(none)'}`)
  reset(); setHost(true); resetDocStoreForTest()
  await putRecovery(doc('d7') as never)
  const { deviceIdentity } = await freshOnline()
  await deviceIdentity('d7')
  const sets = seen.filter((s) => s.op === 'store.set')
  ok(sets.length >= 2 && sets.every((s) => s.bytesIsU8), 'every store.set carries a Uint8Array')
  ok((await docStore()!.list()).join(',') === 'memberkey,recovery', 'list returns exactly the two entries')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
