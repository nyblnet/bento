#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/slides share-copy rig — what a view-only / editor copy carries, run
// against the REAL builders (slides/src/share.ts) with real WebCrypto keys.
//
//   node scripts/test-slides-share.ts
//
// slides is SHIPPED, so reader/invite are held to the same behavioural bar as
// spaces/type/dash: build every copy from ONE source carrying every known secret,
// an unknown field and a JSON own __proto__ key, and prove only the kernel
// allowlist survives. The builders were extracted out of editor.ts so this rig can
// import and run them (editor.ts has DOM at module scope and cannot load in node);
// scripts/test-export-secrets.ts still source-guards the editor call sites.

import { register } from 'node:module'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { readerCopy, inviteCopy } = await import('../slides/src/share.ts')
const { newDoc } = await import('../slides/src/model.ts')
const { mintCollab } = await import('../kernel/src/sync/online.ts')
import type { BentoDoc } from '../slides/src/model.ts'

let checks = 0, failures = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

console.log('every builder, from one poisoned source\n')
{
  const base = await mintCollab() as Record<string, unknown> // real room/owner keys, so inviteCopy can sign
  const poisoned = newDoc()
  const pc = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
  Object.assign(pc, base, {
    writerPriv: 'WPRIV',
    invite: { pub: 'SRC', priv: 'SRCPRIV', role: 'writer', sig: 's' },
    audience: { invite: { priv: 'APRIV' } },
    sync: { v: 2, tag: 'stamp' }, links: [{ url: 'https://pub' }], futureSecret: 'LEAK',
  })
  ;(poisoned as unknown as { collab: unknown }).collab = pc

  const READER_KEYS = ['room', 'key', 'owner', 'writerPub', 'on', 'v', 'role']
  const INVITE_KEYS = ['room', 'key', 'owner', 'writerPub', 'on', 'v', 'sync', 'invite', 'role']
  const POISON = ['writerPriv', 'ownerPriv', 'audience', 'futureSecret', 'links']

  const rc = readerCopy(poisoned).collab as unknown as Record<string, unknown>
  const ic = (await inviteCopy(poisoned, base.ownerPriv as string)).collab as unknown as Record<string, unknown>

  ok(Object.keys(rc).every((k) => READER_KEYS.includes(k)),
    `reader copy: ONLY reader-allowlist keys survive (${Object.keys(rc).sort().join(',')})`)
  ok(rc.role === 'reader', 'reader copy: role forced to reader (opens locked)')
  ok(rc.sync === undefined, 'reader copy: the CRDT sync stamp is dropped')
  ok(Object.keys(ic).every((k) => INVITE_KEYS.includes(k)),
    `invite copy: ONLY invite-allowlist keys survive (${Object.keys(ic).sort().join(',')})`)
  ok(ic.sync !== undefined, 'invite copy: keeps the sync stamp (it contributes)')
  ok((ic.invite as { pub: string }).pub !== 'SRC', 'invite copy: the delegation is FRESH, never the source invite')
  ok(ic.role === 'writer', 'invite copy: top-level role from the fresh writer invite (opens editable)')
  for (const f of POISON) { ok(!(f in rc), `reader drops ${f}`); ok(!(f in ic), `invite drops ${f}`) }
  ok(!Object.hasOwn(rc, '__proto__') && !Object.hasOwn(ic, '__proto__'), 'neither copy carries a __proto__ own key')
  ok(({} as Record<string, unknown>).polluted === undefined, 'and the __proto__ source key polluted nothing (Object.hasOwn)')

  // the planted bypass: rebuilding collab by SPREADING the source keeps every
  // secret; the exact-key-set check above is what turns that red.
  const bypass = { ...pc, role: 'reader' } as Record<string, unknown>
  ok('writerPriv' in bypass && !Object.keys(bypass).every((k) => READER_KEYS.includes(k)),
    'a spread-the-source bypass FAILS the reader key-set check (not vacuous)')

  // the open document is untouched (the builders clone)
  ok((poisoned as unknown as { collab: Record<string, unknown> }).collab.ownerPriv !== undefined,
    'the open document is untouched — the builders clone, never mutate it')
}

// A slides deck can EMBED another bento document inside an element (el.doc). That
// inner document carries its own collab, so a copy must strip it — the extracted
// builders keep the embedded-document strip the old inline path ran.
console.log('\nembedded documents are stripped from every copy\n')
{
  const base = await mintCollab() as Record<string, unknown>
  const SECRET = { ownerPriv: 'OWNER-PRIV', writerPriv: 'WRITER-PRIV', key: 'ROOM-KEY', room: 'ROOM-ID',
    invite: { pub: 'i', priv: 'INVITE-PRIV', role: 'writer', sig: 's' } }
  const inner = () => ({ title: 'inner', slides: [{ id: 'x' }], docId: 'INNER-DOCID', collab: JSON.parse(JSON.stringify(SECRET)) })
  const NEEDLES = ['OWNER-PRIV', 'WRITER-PRIV', 'INVITE-PRIV', 'ROOM-KEY', 'ROOM-ID', 'INNER-DOCID']
  const leaks = (o: unknown) => NEEDLES.filter((n) => JSON.stringify(o).includes(n))
  const withEmbed = () => {
    const d = newDoc()
    ;(d as unknown as { collab: unknown }).collab = JSON.parse(JSON.stringify(base))
    d.slides[0].elements = [{ id: 'e1', type: 'embed', x: 0, y: 0, w: 1, h: 1, app: 'web', doc: inner() } as never]
    return d
  }
  const r = readerCopy(withEmbed())
  ok(leaks(r).length === 0, `view-only copy strips the embedded document's secrets (${leaks(r).join(',') || 'clean'})`)
  const iv = await inviteCopy(withEmbed(), base.ownerPriv as string)
  ok(leaks(iv).length === 0, `editor copy strips the embedded document's secrets (${leaks(iv).join(',') || 'clean'})`)
  const keptDoc = (r.slides[0].elements[0] as unknown as { doc: { title?: string } }).doc
  ok(keptDoc.title === 'inner', 'and the embedded content itself survives (only its envelope goes)')
}

// FROM_LIVE now imports the kernel superset, which carries `template`. That is a
// no-op for slides: template is written only on the Save-as-template clone, never
// on a live editing doc — so there is never a live value to keep. Pin the invariant.
console.log('\nthe FROM_LIVE superset is a no-op for a live slides doc\n')
{
  ok((newDoc() as unknown as { template?: unknown }).template === undefined,
    'a fresh/live slides doc carries no template, so keeping it live changes nothing')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
