#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The copies bento/type writes for someone ELSE carry no private key.
//
//   node scripts/test-type-share.ts
//
// WHAT THIS PROVES. "View-only copy…" and "Invite to edit…" (type/src/share.ts)
// write a document for another person. A view-only copy must follow the live
// session and NEVER write; an editor copy must write only through its own
// revocable invite. So neither may carry a private key it was not given:
//   1. a reader copy has NO writerPriv, ownerPriv or invite keypair — whatever
//      the source document held — while keeping the room it follows;
//   2. an editor copy has no writerPriv or ownerPriv, and its invite is a FRESH
//      one, never the source's;
//   3. the default strip removes the whole collab block;
//   4. every copy builder lives in share.ts, and collab.ts builds none inline.
//
// THE FIXTURE IS THE CASE THAT WAS MISSED. bento/type never mints a writer
// key (its rooms are v2, owner-keyed), so a copy of a document type created was
// clean all along. The gap was a document that ARRIVED holding one — an older
// file, a pasted JSON — because parseDoc carries `collab` through verbatim.
// So the source here goes through parseDoc with a legacy writer key on it.

import { register } from 'node:module'
import { readFileSync } from 'node:fs'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { readerCopy, inviteCopy } = await import('../type/src/share.ts')
const { emptyDoc, parseDoc, docForExport } = await import('../type/src/model.ts')
const { mintCollab } = await import('../kernel/src/sync/online.ts')
import type { TypeDoc } from '../type/src/model.ts'

let checks = 0, failures = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }
const read = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')

const SECRETS = ['WRITER-PRIVATE', 'OWNER-PRIVATE', 'INVITE-PRIVATE']
const arrived = (): TypeDoc => {
  const r = parseDoc(JSON.stringify({ ...emptyDoc(), body: [{ id: 'p1', kind: 'para', text: 'terms' }],
    collab: { v: 2, on: true, room: 'w-room', key: 'ROOM-READ-KEY', owner: 'OWNER-PUB', ownerPriv: 'OWNER-PRIVATE',
              writerPub: 'WRITER-PUB', writerPriv: 'WRITER-PRIVATE',
              invite: { pub: 'INV-PUB', priv: 'INVITE-PRIVATE', role: 'writer', sig: 'SIG' } } }))
  if (!r.ok) throw new Error('fixture did not parse')
  return r.doc
}

console.log('\na view-only copy carries no private key\n')
{
  const src = arrived()
  ok((src.collab as { writerPriv?: string }).writerPriv === 'WRITER-PRIVATE',
     'the source really holds a legacy writer key after parseDoc — the case that was missed')
  const r = readerCopy(src)
  const blob = JSON.stringify(r)
  for (const s of SECRETS) ok(!blob.includes(s), `the reader copy does not contain ${s}`)
  ok(!('writerPriv' in r.collab!) && !('ownerPriv' in r.collab!) && !('invite' in r.collab!),
     'writerPriv, ownerPriv and invite are absent as FIELDS, not merely emptied')
  ok(r.collab?.role === 'reader' && r.collab?.on === true, 'it is a live reader')
  ok(r.collab?.room === 'w-room' && r.collab?.key === 'ROOM-READ-KEY',
     'and keeps the room and read key it needs to follow the session')
  ok(r.collab?.sync === undefined, 'with no sync state of the source\'s')
  ok((src.collab as { writerPriv?: string }).writerPriv === 'WRITER-PRIVATE', 'and the OPEN document is untouched')

  // the ordinary case, from a room type itself mints
  const fresh = { ...emptyDoc(), collab: await mintCollab() } as TypeDoc
  const r2 = readerCopy(fresh)
  ok(!('ownerPriv' in r2.collab!) && !('writerPriv' in r2.collab!) && !('invite' in r2.collab!),
     'a copy of a document type minted itself is clean too')
}

console.log('\nan editor copy writes only through its own invite\n')
{
  const src = arrived()
  const ownerPriv = (await mintCollab()).ownerPriv as string   // a real key, so mintInvite can sign
  const e = await inviteCopy(src, ownerPriv)
  const blob = JSON.stringify(e)
  ok(!blob.includes('WRITER-PRIVATE'), 'no legacy writer key — it would be a second way in no revocation reaches')
  ok(!blob.includes('OWNER-PRIVATE'), 'no owner key')
  ok(!blob.includes('INVITE-PRIVATE') && e.collab?.invite?.pub !== 'INV-PUB',
     'and the invite is a FRESH one, never the source\'s own')
  ok(e.collab?.invite?.role === 'writer' && e.collab?.on === true, 'a live editor invite')
}

// The allowlist bar (security, 2026-10-04): every builder, from ONE source
// carrying every known secret, an unknown field and a JSON own __proto__ key —
// only the allowlist survives, nothing by name and nothing new by accident. (The
// whole-block default drop is docForExport's, pinned in test-export-secrets.ts.)
console.log('\nevery builder, from one poisoned source\n')
{
  const poisoned = arrived()
  const pc = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
  Object.assign(pc, poisoned.collab, {
    writerPriv: 'WRITER-PRIVATE',
    invite: { pub: 'SRC', priv: 'INVITE-PRIVATE', role: 'writer', sig: 's' },
    audience: { invite: { priv: 'AUD-PRIVATE' } },
    sync: { v: 2, tag: 'stamp' }, links: [{ url: 'https://pub' }], futureSecret: 'LEAK',
  })
  poisoned.collab = pc as TypeDoc['collab']

  const READER_KEYS = ['room', 'key', 'owner', 'writerPub', 'on', 'v', 'role']
  const INVITE_KEYS = ['room', 'key', 'owner', 'writerPub', 'on', 'v', 'sync', 'invite', 'role']
  const POISON = ['writerPriv', 'ownerPriv', 'audience', 'futureSecret', 'links']

  const rc = readerCopy(poisoned).collab as Record<string, unknown>
  const ic = (await inviteCopy(poisoned, (await mintCollab()).ownerPriv as string)).collab as Record<string, unknown>

  ok(Object.keys(rc).every((k) => READER_KEYS.includes(k)),
    `reader copy: ONLY reader-allowlist keys survive (${Object.keys(rc).sort().join(',')})`)
  ok(rc.role === 'reader' && rc.sync === undefined, 'reader: role forced reader, no sync stamp')
  ok(Object.keys(ic).every((k) => INVITE_KEYS.includes(k)),
    `invite copy: ONLY invite-allowlist keys survive (${Object.keys(ic).sort().join(',')})`)
  ok(ic.sync !== undefined && (ic.invite as { pub: string }).pub !== 'SRC',
    'invite: keeps sync, carries a FRESH invite not the source\'s')
  ok(ic.role === 'writer', 'invite: top-level role from the fresh writer invite (type mints writer invites only)')
  for (const f of POISON) { ok(!(f in rc), `reader drops ${f}`); ok(!(f in ic), `invite drops ${f}`) }
  ok(!Object.hasOwn(rc, '__proto__') && !Object.hasOwn(ic, '__proto__'), 'neither copy carries a __proto__ own key')
  ok(({} as Record<string, unknown>).polluted === undefined, 'and the __proto__ source key polluted nothing (Object.hasOwn)')

  // the planted bypass: rebuilding collab by SPREADING the source keeps every
  // secret; the exact-key-set check above is what turns that red.
  const bypass = { ...pc, role: 'reader' } as Record<string, unknown>
  ok('writerPriv' in bypass && !Object.keys(bypass).every((k) => READER_KEYS.includes(k)),
    'a spread-the-source bypass FAILS the reader key-set check (not vacuous)')
}

console.log('\nevery copy is minted in share.ts\n')
{
  const collab = read('type/src/collab.ts')
  ok(/inviteCopy\(/.test(collab) && /readerCopy\(/.test(collab), 'collab.ts builds its copies through share.ts')
  ok(!/JSON\.parse\(JSON\.stringify\(store\.doc\)\)/.test(collab), 'and clones none inline')
  // No other type module builds a reader or audience copy by hand.
  const { readdirSync } = await import('node:fs')
  const rogue = readdirSync(new URL('../type/src/', import.meta.url))
    .filter(f => f.endsWith('.ts') && f !== 'share.ts' && f !== 'model.ts')
    .filter(f => /role:\s*'(?:reader|audience)'/.test(read('type/src/' + f)))
  ok(rogue.length === 0, `no copy builder outside share.ts sets a reader/audience role (${rogue.join(', ') || 'none'}) — type builds no audience copies at all`)
}

console.log('\nembedded documents don\'t carry sharing keys out\n')
{
  // An embed's copy of its source document, carrying that document's FULL
  // sharing envelope plus its docId. It is put onto the live body DIRECTLY —
  // not through parseDoc, which now cleans embeds on entry — because the point
  // is a document that reached the live file by another path (a peer's sync op,
  // anything pre-dating the intake scrub). Built through parseDoc, the rows
  // below would pass whether or not the outbound strip existed.
  const ENV = { v: 2, on: true, room: 'w-src', key: 'SRC-READ-KEY', owner: 'SRC-OWNER-PUB', ownerPriv: 'SRC-OWNER-KEY',
                writerPub: 'SRC-WRITER-PUB', writerPriv: 'SRC-WRITER-KEY', invite: { pub: 'SRC-INV-PUB', priv: 'SRC-INVITE-KEY', role: 'writer', sig: 'S' } }
  const SECRETS = ['SRC-READ-KEY', 'SRC-OWNER-KEY', 'SRC-WRITER-KEY', 'SRC-INVITE-KEY']
  const withDirtyEmbed = async (): Promise<TypeDoc> => {
    const r = parseDoc(JSON.stringify({ ...emptyDoc(), body: [{ id: 'p1', kind: 'para', text: 'see the deck' }],
      collab: await mintCollab() }))
    if (!r.ok) throw new Error('fixture did not parse')
    r.doc.body.push({ id: 'e1', kind: 'embed', text: '',
      embed: { app: 'bento/slides', view: '<svg/>', doc: { format: 'bento/slides', docId: 'deck-SRC', title: 'Q3', collab: ENV } } } as never)
    return r.doc
  }
  const embedded = (d: TypeDoc) => (d.body.find(b => b.kind === 'embed') as { embed: { doc: Record<string, unknown> } }).embed.doc
  const clean = (d: TypeDoc) => { const b = JSON.stringify(d.body); return SECRETS.every(x => !b.includes(x)) }

  const src = await withDirtyEmbed()
  ok(!clean(src), 'the fixture really holds an embed carrying a full sharing envelope')

  const r = readerCopy(src)
  ok(clean(r) && !('collab' in embedded(r)), 'a VIEW-ONLY copy carries none of the embedded document\'s keys')
  ok(embedded(r).docId === 'deck-SRC' && embedded(r).title === 'Q3', 'while the embedded document and its docId are kept')

  const own = (await mintCollab()).ownerPriv as string
  const i = await inviteCopy(src, own)
  ok(clean(i) && !('collab' in embedded(i)), 'an EDITOR copy carries none of them either')

  const x = docForExport(src)
  ok(clean(x) && !('collab' in embedded(x)), '"Copy document JSON" (docForExport) carries none of them')
  ok(!('collab' in x), 'and still drops the document\'s own room, as it always has')

  ok(!clean(src) && 'collab' in embedded(src), 'none of the three mutated the OPEN document')

  // Entry: a document arriving through parseDoc (open, Replace from JSON,
  // loadDoc, restore) comes in with its embeds already clean.
  const entering = parseDoc(JSON.stringify({ ...emptyDoc(), body: [{ id: 'e1', kind: 'embed', text: '',
    embed: { app: 'bento/slides', view: '<svg/>', doc: { format: 'bento/slides', docId: 'deck-SRC', collab: ENV } } }] }))
  ok(entering.ok && clean(entering.doc), 'a document ENTERING bento/type has its embeds cleaned on the way in')

  // Leaving to disk: Save and the browser snapshots go through the same strip.
  const main = read('type/src/main.ts'), auto = read('type/src/autosave.ts')
  ok(/saveFile\(withoutEmbeddedCaps\(store\.doc\)/.test(main), 'Save writes the document with its embeds cleaned')
  ok(/putRecovery\(safe\)/.test(auto) && /addVersion\(safe\)/.test(auto) && /const safe = withoutEmbeddedCaps\(doc\)/.test(auto),
     'and so do the recovery snapshot and the version history, which any local page can read')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
