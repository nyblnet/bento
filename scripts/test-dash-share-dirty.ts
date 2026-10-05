#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash SHARING STATE rig — two gates in dash/src/sync/online.ts.
//
//   node scripts/test-dash-share-dirty.ts
//
// 1. STARTING, STOPPING OR ROTATING SHARING MARKS THE WORKBOOK UNSAVED. They
//    write `doc.collab` directly — not data edits, so not patches and not undo
//    entries — and nothing told the unsaved dot. A key ROTATION is revocation:
//    closed without saving, the file kept the keys meant to be dead, with no
//    warning and no automatic save to the file. Minting credentials for a new
//    workbook stays silent, or every untouched starter would warn on close.
//
// 2. ONLY A WRITER COPY OFFERS WRITE AUTH. Both gates asked
//    `role !== 'reader'`, so the kernel's newer 'audience' role (a live-show
//    member, receive-only) presented its show ticket as write auth and called
//    itself an Editor in presence. Now an allowlist that fails closed —
//    `copyCanWrite`, the same rule as type's (#588).

import { registerHooks } from 'node:module'
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

// No network, ever: a socket that records what it was asked for and stays shut.
const opened: string[] = []
class FakeSocket {
  readyState = 0
  constructor(url: string) { opened.push(url) }
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}
;(globalThis as { WebSocket: unknown }).WebSocket = FakeSocket

const { parseDoc } = await import('../dash/src/model.ts')
const { Store } = await import('../dash/src/store.ts')
const online = await import('../dash/src/sync/online.ts')
const { SyncSession } = await import('../dash/src/sync/session.ts')
const { startSharing, stopSharing, rotateKeys, copyCanWrite, joinFromDoc, collabOf, mintCollab, disconnectOnline } = online
type DashDoc = import('../dash/src/model.ts').DashDoc

let checks = 0, failures = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const fresh = (collab?: object): DashDoc => {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 'Book',
    ...(collab ? { collab } : {}),
    sheets: [{
      id: 'sh', kind: 'table', name: 'Data', rids: [[1, 1]], nextRid: 2,
      columns: [{ id: 'v', name: 'Value', type: 'number' }],
      data: { v: { enc: 'raw', v: [1] } }, steps: [],
    }],
  }))
  if (!r.ok) throw new Error('fixture')
  return r.doc
}

/** A session that records the transport it is handed, and connects nothing. */
function fakeSession() {
  const made: unknown[] = []
  return {
    made,
    enableSharing() {},
    addTransport(factory: (docId: string, onFrame: () => void) => unknown) { made.push(factory('d', () => {})) },
    removeTransport() {},
    applySnapshot() {}, snapshot() { return null }, hello() {}, onRelayReady() {}, refused() {},
  }
}
const watch = (s: InstanceType<typeof Store>) => {
  const n = { unsaved: 0 }
  s.on('unsaved', () => { n.unsaved++ })
  return n
}

console.log('starting, stopping and rotating sharing mark the workbook unsaved')
{
  // A workbook whose sharing was STOPPED. (A new one is minted with on:true
  // and stays dormant until opted in — starting it changes no byte of the
  // document, so there is nothing for the file to learn; that case is below.)
  const s = new Store(fresh({ ...(await mintCollab()), on: false })), n = watch(s), sess = fakeSession()
  await startSharing(sess as never, s)
  ok(collabOf(s.doc)?.on === true, 'sharing is on in the document')
  ok(n.unsaved === 1, `starting marks it unsaved — the file must learn it is shared (${n.unsaved})`)
  await startSharing(sess as never, s)
  ok(n.unsaved === 1, 'starting again when already on changes nothing and says nothing')
  stopSharing(sess as never, s)
  ok(collabOf(s.doc)?.on === false && n.unsaved === 2, 'stopping marks it unsaved')
  stopSharing(sess as never, s)
  ok(n.unsaved === 2, 'stopping when already off says nothing')
  const room = collabOf(s.doc)?.room
  await rotateKeys(sess as never, s)
  ok(collabOf(s.doc)?.room !== room, 'rotation minted a new room')
  ok(n.unsaved >= 3, `ROTATION marks it unsaved — revocation is only real once the file holds the new keys (${n.unsaved})`)
  ok(!s.canUndo, 'and none of it entered the undo history — it is not an edit to the data')
  disconnectOnline(sess as never)
}

console.log('\nrotation keeps the CRDT stamp and published links (shared kernel helper)')
{
  const s = new Store(fresh({ ...(await mintCollab()), on: true })), sess = fakeSession()
  const before = collabOf(s.doc) as Record<string, unknown>
  before.sync = { v: 2, tag: 'keepme' } // set on the live block (parseDoc wouldn't carry unknowns)
  before.links = [{ url: 'https://pub/x' }]
  const oldPriv = before.ownerPriv
  await rotateKeys(sess as never, s)
  const after = collabOf(s.doc) as Record<string, unknown>
  ok((after.sync as { tag?: string })?.tag === 'keepme', 'the CRDT sync stamp survived the rotation')
  ok(JSON.stringify(after.links) === JSON.stringify([{ url: 'https://pub/x' }]), 'published links survived the rotation (dash uses the kernel COLLAB_ROTATE_KEEP)')
  ok(after.ownerPriv !== oldPriv, 'the owner private key is fresh — access was revoked')
  disconnectOnline(sess as never)
}

console.log('\nminting credentials for a NEW workbook stays silent')
{
  // and so does opting a never-saved workbook in: its credentials were minted
  // on:true, so `startSharing` changes no byte of the document
  const s0 = new Store(fresh({ ...(await mintCollab()) })), n0 = watch(s0), sess0 = fakeSession()
  await startSharing(sess0 as never, s0)
  ok(n0.unsaved === 0, 'opting in a workbook already marked on changes nothing in it, and says nothing')
  disconnectOnline(sess0 as never)

  const s = new Store(fresh()), n = watch(s)
  new SyncSession(s)
  await new Promise((r) => setTimeout(r, 50))
  ok(!!collabOf(s.doc)?.room, 'the session minted credentials at creation')
  ok(n.unsaved === 0, 'and did NOT mark the workbook unsaved — an untouched starter must close without a warning')
}

console.log('\ncopyCanWrite is an allowlist that fails closed')
for (const [role, want] of [
  [undefined, true], ['writer', true], ['reader', false], ['audience', false], ['commenter', false], ['owner', false],
] as const) {
  ok(copyCanWrite({ room: 'r', key: 'k', ...(role ? { role } : {}) } as never) === want,
    `role ${role ?? '(absent — every file older than the field)'} → ${want ? 'writes' : 'does not write'}`)
}
ok(copyCanWrite(undefined) === false, 'no collab block → does not write')

console.log('\nonly a writer copy offers write auth to the relay')
{
  const creds = await mintCollab()
  for (const [role, wantAuth] of [[undefined, true], ['reader', false], ['audience', false]] as const) {
    const s = new Store(fresh({ ...creds, on: true, ...(role ? { role } : {}) }))
    const sess = fakeSession()
    disconnectOnline(sess as never)
    joinFromDoc(sess as never, s)
    const t = sess.made[0] as { auth?: unknown } | undefined
    ok(!!t, `a transport was built for role ${role ?? '(absent)'}`)
    ok(!!t?.auth === wantAuth, `role ${role ?? '(absent)'} ${wantAuth ? 'signs as a writer' : 'offers NO write auth'}`)
    ;(t as { close?: () => void } | undefined)?.close?.()
    disconnectOnline(sess as never)
  }
}

console.log('\nan audience copy is a Viewer in presence, not an Editor')
{
  const creds = await mintCollab()
  for (const [role, want] of [['audience', 'viewer'], ['reader', 'viewer'], [undefined, 'owner']] as const) {
    const s = new Store(fresh({ ...creds, ...(role ? { role } : {}) }))
    const sess = new SyncSession(s) as unknown as { presence?: () => { role?: string }; selfPresence?: () => { role?: string } }
    const p = (sess.presence ?? sess.selfPresence)?.call(sess)
    ok(p?.role === want, `role ${role ?? '(absent, owner keys)'} → ${want} — got ${p?.role}`)
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
// A SyncSession keeps heartbeat timers, and they would hold the process open
// after a clean run — which a CI runner reports as a hang, not a pass.
process.exit(failures ? 1 : 0)
