#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/spaces share-copy rig — what an invite carries, and what it must not.
//
//   node scripts/test-spaces.mjs invite      # or just: node scripts/test-spaces.mjs
//
// (Bundled, not run directly: the kernel transport uses TypeScript parameter
// properties, which node's strip-only loader refuses. Handing this file straight
// to node fails in a way that looks like a broken product rather than a missing
// build step — the runner above bundles it the way CI does. Same reason the
// spaces undo rig is bundled.)
//
// WHAT THIS PROVES, and why it is a rig rather than a code review.
//
// "Invite someone…" in bento/spaces was `saveAs('copy')`, which serializes
// `store.doc` — the whole document, `collab` included. `collab.ownerPriv` is
// the ROOT key of the room: it signs writes and it signs REVOCATIONS. So every
// person invited to a space received the power to remove the person who had
// invited them, and to remove everybody else, and there is no way to take it
// back short of re-keying the room and re-sending every copy. Measured on the
// branch before this rig existed: the bytes written by that button contained
// `ownerPriv` in full.
//
// The failure is invisible in the product — the copy opens, syncs, and looks
// exactly like a correct invite — which is precisely the shape of bug that
// needs a machine to notice it. scripts/test-export-secrets.ts reads SOURCE and
// covers "does this call site strip"; this rig runs the real functions against
// real WebCrypto keys and asserts on the actual bytes that would reach the
// file, including a full-text scan for the private key material.
//
// It also verifies the invite the way the RELAY does — checking the owner's
// signature over `inv.${pub}.${role}.${exp}` — so "the copy carries an invite"
// is not taken on the word of a field name. If that chain ever stopped
// verifying, every invite would silently fail to join instead of joining with
// too much power, and this is the one place that would say so.

// --- a browser, reduced to what the module graph touches at import time -----
// The kernel reaches localStorage for the relay-host override and the device
// key. Nothing here connects: no socket is opened by any function under test.
const store = new Map<string, string>()
const shim = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size },
}
const g = globalThis as unknown as Record<string, unknown>
g.localStorage = shim
g.window = g.window ?? { localStorage: shim, addEventListener() {}, setTimeout, clearTimeout }

const { inviteCopy, readerCopy, isOwner, canWrite } = await import('../spaces/src/share.ts')
const { mintCollab } = await import('../kernel/src/sync/online.ts')
import type { SpacesDoc } from '../spaces/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures++; console.error(`  ✗ ${msg}`) }
}

const b64uDec = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

/** A space with real credentials — the document the buttons actually see. */
async function freshDoc(): Promise<SpacesDoc> {
  const collab = await mintCollab()
  return {
    docId: 'doc-under-test',
    title: 'Handbook',
    home: 'p1',
    pages: [{ id: 'p1', title: 'Home', blocks: [{ id: 'b1', type: 'p', html: 'hello' }] }],
    collab,
  } as unknown as SpacesDoc
}

// ---------------------------------------------------------------------------
console.log('\nthe premise: the open document really does hold the owner key')

const doc = await freshDoc()
const c = doc.collab!
ok(!!c.ownerPriv && !!c.owner && c.v === 2, 'a fresh space is minted as a v2 room with an owner keypair')
ok(JSON.stringify(doc).includes(c.ownerPriv!),
  'serializing the OPEN document carries ownerPriv — this is what the old Invite button wrote')
ok(isOwner(doc) && canWrite(doc), 'this copy reads as the owner, and as a writer')

// ---------------------------------------------------------------------------
console.log('\nan invite copy')

const invite = await inviteCopy(doc)
ok(!!invite, 'the owner can mint an invite copy')
const ic = invite!.collab!
const inviteText = JSON.stringify(invite)

// THE ASSERTION THIS RIG EXISTS FOR. Not "the field is absent" — the whole
// serialized copy is scanned, so a private key smuggled anywhere in the
// document (a stray backup under another name, a stamped sync blob that
// happens to embed it) fails too.
ok(!inviteText.includes(c.ownerPriv!),
  'the owner PRIVATE key appears NOWHERE in the invite copy')
ok(ic.ownerPriv === undefined, 'collab.ownerPriv is absent')
ok(ic.writerPriv === undefined, 'collab.writerPriv is absent — no room-wide write key either')
ok(ic.invite?.priv !== c.ownerPriv, 'the invite key is a DIFFERENT keypair, not the owner key renamed')

// What it must still carry, or it cannot join at all.
ok(ic.room === c.room && ic.key === c.key, 'it keeps the room and the symmetric read key')
ok(ic.owner === c.owner, 'it keeps the owner PUBLIC key — the room id commits to it')
ok(ic.on === true, 'sharing is armed, so opening the copy joins')
ok(!!ic.invite?.pub && !!ic.invite?.priv && !!ic.invite?.sig, 'it carries a complete invite')
ok(ic.invite?.role === 'writer', 'the invite delegates WRITE, not owner')

// Verified the way the relay verifies it (server/sync-worker: `inv.…` over the
// owner pubkey). A field named `sig` proves nothing on its own.
const ownerKey = await crypto.subtle.importKey(
  'raw', b64uDec(c.owner!) as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
)
const iv = ic.invite!
const chainOk = await crypto.subtle.verify(
  { name: 'ECDSA', hash: 'SHA-256' }, ownerKey,
  b64uDec(iv.sig) as BufferSource,
  new TextEncoder().encode(`inv.${iv.pub}.${iv.role}.${iv.exp ?? 0}`),
)
ok(chainOk, 'the invite is signed BY THE OWNER — the chain the relay checks actually verifies')

// A revocation is signed with the owner key. Holding only the invite, the
// recipient cannot produce one — which is the property the whole design buys.
ok(!inviteText.includes('"ownerPriv"'), 'no ownerPriv field survives under any value')

ok(doc.collab!.ownerPriv === c.ownerPriv,
  'minting an invite does not disturb the OPEN document (it is a clone, not a move)')

const second = await inviteCopy(doc)
ok(second!.collab!.invite!.pub !== ic.invite!.pub,
  'each invite is a fresh keypair, so revoking one does not cut off the other')

// ---------------------------------------------------------------------------
console.log('\na view-only copy')

const viewer = readerCopy(doc)
ok(!!viewer, 'a view-only copy can be made')
const vc = viewer!.collab!
const viewText = JSON.stringify(viewer)
ok(!viewText.includes(c.ownerPriv!), 'the owner private key appears nowhere in it')
ok(vc.ownerPriv === undefined && vc.writerPriv === undefined && vc.invite === undefined,
  'it holds NO private key of any kind — so it can sign nothing, so the relay stores nothing from it')
ok(vc.role === 'reader', 'it is marked reader, which is what locks the editor for the person holding it')
ok(vc.room === c.room && vc.key === c.key, 'it keeps the room and the read key — it still receives')
ok(vc.sync === undefined, 'the stamped CRDT state is dropped — a viewer must not rejoin as a fork')
ok(!canWrite(viewer!), 'canWrite() reports false for it')

// ---------------------------------------------------------------------------
// The allowlist bar (security, 2026-10-04): build every copy builder from ONE
// source carrying every known secret, an unknown future field and a JSON own
// __proto__ key, and prove only the allowlist survives — nothing by name, and
// nothing new by accident. (The whole-block default drop is docForExport's job,
// pinned in scripts/test-export-secrets.ts.)
console.log('\nevery builder, from one poisoned source')

// a real own __proto__ key: JSON.parse makes it an OWN property, not the chain.
const poisoned = JSON.parse(JSON.stringify(doc)) as SpacesDoc
const pc = JSON.parse(
  '{"__proto__":{"polluted":true}}',
) as Record<string, unknown>
// keep the REAL ownerPriv (inviteCopy mints against it); poison everything else
Object.assign(pc, poisoned.collab, {
  writerPriv: 'WPRIV',
  invite: { pub: 'SRC', priv: 'SRCPRIV', role: 'writer', sig: 's' },
  audience: { invite: { priv: 'APRIV' } },
  sync: { v: 2, tag: 'stamp' }, links: [{ url: 'https://pub' }],
  futureSecret: 'LEAK',
})
poisoned.collab = pc as SpacesDoc['collab']

const READER_KEYS = ['room', 'key', 'owner', 'writerPub', 'on', 'v', 'role']
const INVITE_KEYS = ['room', 'key', 'owner', 'writerPub', 'on', 'v', 'sync', 'invite', 'role']
const SECRETS = ['writerPriv', 'ownerPriv', 'audience', 'futureSecret', 'links']

const rc = readerCopy(poisoned)!.collab as Record<string, unknown>
const vic = (await inviteCopy(poisoned))!.collab as Record<string, unknown>

ok(Object.keys(rc).every((k) => READER_KEYS.includes(k)),
  `reader copy: ONLY reader-allowlist keys survive (${Object.keys(rc).sort().join(',')})`)
ok(rc.role === 'reader', 'reader copy: role is forced to reader')
ok(rc.sync === undefined, 'reader copy: the CRDT sync stamp is dropped')
ok(Object.keys(vic).every((k) => INVITE_KEYS.includes(k)),
  `invite copy: ONLY invite-allowlist keys survive (${Object.keys(vic).sort().join(',')})`)
ok(vic.sync !== undefined, 'invite copy: keeps the sync stamp (it contributes)')
ok((vic.invite as { pub: string }).pub !== 'SRC', 'invite copy: the delegation is FRESH, never the source invite')
ok(vic.role === 'writer', 'invite copy: top-level role comes from the fresh writer invite (editor chrome)')
for (const f of SECRETS) {
  ok(!(f in rc), `reader copy drops ${f}`)
  ok(!(f in vic), `invite copy drops ${f}`)
}
ok(!Object.hasOwn(rc, '__proto__') && !Object.hasOwn(vic, '__proto__'),
  'neither copy carries a __proto__ own key')
ok(({} as Record<string, unknown>).polluted === undefined,
  'and the __proto__ source key polluted nothing (Object.hasOwn, not `in`)')

// The planted bypass: a builder that rebuilds collab by SPREADING the source
// keeps every secret. The exact-key-set check above is what turns that red —
// proving it is not a vacuous check.
const bypass = { ...pc, role: 'reader' } as Record<string, unknown>
ok('writerPriv' in bypass && !Object.keys(bypass).every((k) => READER_KEYS.includes(k)),
  'a spread-the-source bypass FAILS the reader key-set check (the check is not vacuous)')

// Derived from the KERNEL type, not typed out here: a new private field added
// to CollabCreds fails this until inviteCopy stops carrying it.
const { readFileSync, existsSync } = await import('node:fs')
const { dirname, join, resolve } = await import('node:path')
// Located from the CWD, walking up — NOT from import.meta.url. This rig is
// BUNDLED to a temp directory before it runs (CI does exactly that), so the
// module's own path points at the build output and not at the repo.
const REL = 'kernel/src/sync/crdt.ts'
let root = resolve(process.cwd())
while (!existsSync(join(root, REL)) && dirname(root) !== root) root = dirname(root)
ok(existsSync(join(root, REL)), `found the repo (${REL}) by walking up from the working directory`)
const credsSrc = readFileSync(join(root, REL), 'utf8')
const block = credsSrc.slice(credsSrc.indexOf('export interface CollabCreds {'))
const fields = [...block.slice(0, block.indexOf('\n}')).matchAll(/^ {2}([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1])
const privateFields = fields.filter((f) => /Priv$/.test(f))
ok(privateFields.length >= 2, `CollabCreds declares ${fields.length} fields, ${privateFields.length} private (${privateFields.join(', ')})`)
for (const f of privateFields) {
  ok((ic as Record<string, unknown>)[f] === undefined, `an invite copy carries no ${f}`)
  ok((vc as Record<string, unknown>)[f] === undefined, `a view-only copy carries no ${f}`)
}

// ---------------------------------------------------------------------------
console.log('\na member copy cannot mint invites')

// Opening an invite makes you an editor, not an owner. If a member could mint
// invites, "you stay the owner" in the button's own hint would be false: the
// person you invited could invite the world and you could not tell.
const memberDoc = JSON.parse(inviteText) as SpacesDoc
ok(!isOwner(memberDoc), 'an invited copy does not read as the owner')
ok((await inviteCopy(memberDoc)) === null, 'inviteCopy() refuses — it holds no key to root a chain in')
ok(canWrite(memberDoc), '…but it can still write, which is the point of an invite')

// ---------------------------------------------------------------------------
console.log('\nwhich copies may write — an allowlist that fails closed')

// share.ts used to ask `role !== 'reader'`, which answers "yes" for every role
// invented after it. The kernel's 'audience' (a live-show member, receive-only
// transport) is the one that exists today; the rest stand in for tomorrow's.
// Every gate — canWrite, isReaderCopy, the boot lock in main.ts, the People
// label in collabui.ts — answers through copyCanWrite, so this pins all of them.
{
  const { copyCanWrite, isReaderCopy } = await import('../spaces/src/share.ts')
  const { Store } = await import('../spaces/src/store.ts')
  const withCollab = (collab: unknown): SpacesDoc => ({ ...JSON.parse(JSON.stringify(doc)), collab }) as SpacesDoc
  const room = { v: 2, on: true, room: c.room, key: c.key, owner: c.owner }
  const writes = (d: SpacesDoc) => canWrite(d) && !isReaderCopy(d)
  const locked = (d: SpacesDoc) => !canWrite(d) && isReaderCopy(d)

  ok(writes(doc), 'an OWNER copy writes (no role field; marked by ownerPriv)')
  ok(writes(memberDoc), 'an invited editor writes')
  ok(writes(withCollab({ ...room, role: 'writer' })), "role 'writer' writes")
  ok(writes(withCollab({ on: true, room: 'r1', key: 'K', writerPub: 'WP', writerPriv: 'WK' })),
    'a LEGACY copy with no role field writes — every pre-role file is one')
  const plain = withCollab(undefined)
  delete plain.collab
  ok(!isReaderCopy(plain), 'a plain file with NO collab is not locked — it opens editable exactly as before')

  ok(locked(viewer!), "role 'reader' is read-only")
  ok(locked(withCollab({ ...room, role: 'audience',
    invite: { pub: 'IP', priv: 'IK', role: 'audience', sig: 'S' } })),
    "role 'audience' is read-only — though it carries an invite, which is what made it read as an Editor")
  ok(locked(withCollab({ ...room, role: 'presenter-of-tomorrow' })),
    'a role nobody has taught this about fails CLOSED, not open')
  ok(locked(withCollab({ ...room, role: 7 })), 'a non-string role is read-only')
  ok(locked(withCollab({ ...room, role: null })), 'a null role is read-only — null is not absent')
  ok(locked(withCollab(JSON.parse(`{"room":"w1","key":"K","role":"__proto__"}`))), "role '__proto__' is read-only")
  ok(locked(withCollab(JSON.parse(`{"room":"w1","key":"K","role":"owner"}`))),
    "role 'owner' is read-only — it is not a role value; ownership is a key, not a label")
  // Inherited `role` must not answer for the file in either direction.
  ok(!copyCanWrite(Object.assign(Object.create({ role: 'writer' }), { role: 'reader', room: 'w1', key: 'K' })),
    'an own reader role is not overridden by an inherited writer one')

  // The lock as main.ts derives it, and what it does to a commit.
  const audienceDoc = withCollab({ ...room, role: 'audience' })
  const s = new Store(audienceDoc)
  if (audienceDoc.readonly || isReaderCopy(audienceDoc)) s.readOnly = true
  const before = JSON.stringify(s.doc)
  s.commit(() => { s.doc.title = 'changed by an audience' })
  ok(s.readOnly && JSON.stringify(s.doc) === before && !s.dirty,
    'an audience copy boots with a read-only store, and its commit is a no-op')
  const ws = new Store(withCollab({ ...room, role: 'writer' }))
  if (isReaderCopy(ws.doc)) ws.readOnly = true
  ws.commit(() => { ws.doc.title = 'changed by a writer' })
  ok(!ws.readOnly && ws.doc.title === 'changed by a writer', '…and a writer copy commits as before')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
