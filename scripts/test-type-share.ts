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
const { readerCopy, inviteCopy, stripCollabSecrets } = await import('../type/src/share.ts')
const { emptyDoc, parseDoc } = await import('../type/src/model.ts')
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

console.log('\nthe default strip removes the room too\n')
{
  const d = arrived(); stripCollabSecrets(d)
  ok(!('collab' in d), 'with no keepRoom, the whole collab block goes — the room key is a capability')
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

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
