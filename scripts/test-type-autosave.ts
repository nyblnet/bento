#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type autosave + crash-recovery rig.  node scripts/test-type-autosave.ts
//
// Storage mechanics (IndexedDB, per-app database naming, legacy migration)
// are already proven by scripts/test-autosave.ts against the shared kernel
// module — this rig does not re-test IndexedDB. What is app-specific, and
// what this pins instead:
//
//   1. docContentKey ignores BOOKKEEPING (modified, preview, autosave) and
//      capability (collab, and the sync state inside it), but counts every
//      piece of work the file on disk could lack — including a signature, a
//      comment and a Snapshot. So the boot-time "is this actually different
//      from what's on disk" check neither nags on every reload nor stays
//      silent when there really is unsaved work. It is NOT canon.ts's
//      signing set: see autosave.ts docContentKey for why those differ.
//   2. canSnapshot() — the encryption guard — refuses the moment the kernel's
//      encryption state goes active, and un-refuses when it clears. This is
//      the one line responsible for "never write plaintext to IndexedDB
//      beside a file whose whole purpose is that it is not legible".
//   3. Restoring a recovered snapshot through store.replace() round-trips
//      the document EXACTLY (byte-for-byte JSON) and lands as ONE undo step
//      — never a silent, un-undoable swap of the document under the author.

import { configureApp } from '../kernel/src/app.ts'
import { setEncryptionPassword } from '../kernel/src/save.ts'
import { docContentKey, canSnapshot } from '../type/src/autosave.ts'
import { emptyDoc, uid, type TypeDoc } from '../type/src/model.ts'
import { Store } from '../type/src/store.ts'
import { gateRestored } from '../type/src/restoregate.ts'

configureApp({ appId: 'bento-type-test', appName: 'bento/type (test)', manifestUrl: 'https://example.invalid/m.json' })

let checks = 0, failures = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }
const H = (s: string) => console.log(`\n=== ${s} ===`)

const doc = (): TypeDoc => {
  const d = emptyDoc()
  d.title = 'Master Services Agreement'
  d.body = [{ id: uid(), kind: 'para', text: 'Payment is due within 30 days.' }]
  return d
}

H('docContentKey ignores bookkeeping, which churns without any work done')
{
  const a = doc()
  const b: TypeDoc = JSON.parse(JSON.stringify(a))
  // A save stamps `modified`, a sync round-trip rewrites collab's state, and
  // neither is anything the author would want offered back on reload.
  a.modified = '2026-01-01T00:00:00.000Z'
  b.modified = '2099-12-31T23:59:59.000Z'
  ;(a as any).collab = { room: 'r1', key: 'k1' }
  ;(b as any).collab = { room: 'r2', key: 'k2', sync: { v: 1 } }
  ;(a as any).preview = '<div>old</div>'
  ;(b as any).preview = '<div>new</div>'
  ok(docContentKey(a) === docContentKey(b),
    'modified/collab/preview differ but the content key agrees')

  const c = doc()
  c.body[0].text = 'Payment is due within 45 days.'
  ok(docContentKey(a) !== docContentKey(c),
    'an actual edit to body text changes the content key')

  const d2 = doc()
  d2.title = 'A Different Title'
  ok(docContentKey(a) !== docContentKey(d2),
    'a title change changes the content key too — title is real content, not chrome')
}

H('docContentKey is stable across independent JSON round-trips')
{
  const a = doc()
  const roundTripped: TypeDoc = JSON.parse(JSON.stringify(a))
  ok(docContentKey(a) === docContentKey(roundTripped),
    'serializing and re-parsing an unedited document keeps the same key (no false "unsaved changes" banner on a clean reload)')
}

H('canSnapshot refuses while encryption is active')
{
  ok(canSnapshot(), 'snapshots are allowed with no password set (the common case today)')
  setEncryptionPassword('correct horse battery staple')
  ok(!canSnapshot(), 'encryption active — canSnapshot refuses, so runAutosave never reaches putRecovery')
  setEncryptionPassword(null)
  ok(canSnapshot(), 'clearing the password restores snapshotting')
}

H('restoring a recovered snapshot round-trips the document exactly')
{
  const original = doc()
  original.footnotes[uid('n')] = 'A footnote, so nested content round-trips too.'
  original.body[0].marks = [{ t: 'b', from: 0, to: 7 }]

  // This is exactly what checkRecovery does: JSON.stringify into a Snapshot,
  // JSON.parse back out, and hand the result to store.replace().
  const snapshotJson = JSON.stringify(original)
  const recovered: TypeDoc = JSON.parse(snapshotJson)
  ok(docContentKey(recovered) === docContentKey(original),
    'the round-tripped snapshot has the same content key as the original')

  const openDoc = doc()
  openDoc.body[0].text = 'A different document, currently open in the editor.'
  const store = new Store(openDoc) // a DIFFERENT doc is "currently open"
  const before = store.undoDepth
  store.replace(recovered)
  ok(JSON.stringify(store.doc) === snapshotJson,
    'store.doc after replace() is byte-identical to the snapshot JSON')
  ok(store.doc.body[0].text === original.body[0].text, 'restored body text matches')
  ok(Object.keys(store.doc.footnotes).length === 1, 'restored footnotes survive the round trip')
  ok(store.undoDepth === before + 1, 'replace() pushed exactly one undo step — restore is ONE ⌘Z away from undone')
  ok(store.undo(), 'undo succeeds')
  ok(store.doc.body[0].text === openDoc.body[0].text, 'undo reverts the restore back to what was open before it')
}

H('work the file on disk lacks is unsaved work — even when no text changed')
{
  // This rig USED to assert the opposite for signatures ("re-signing churns
  // these without the author having typed anything"), and so certified the
  // bug: the recovery key reused canon.ts's SIGNING set, a signature is
  // rightly outside what it signs, and that same exclusion made it invisible
  // to recovery. The question here is not "did anyone type?" but "does the
  // snapshot hold work the file lacks?" — and a signature is exactly that.
  const base = doc()
  const signed: TypeDoc = JSON.parse(JSON.stringify(base))
  signed.signatures = [{ alg: 'ES256', pub: 'P', name: 'Alice', content: 'C', prev: '', sig: 'S' } as any]
  ok(docContentKey(base) !== docContentKey(signed),
    'a signature added since the last write changes the content key')

  const commented: TypeDoc = JSON.parse(JSON.stringify(base))
  ;(commented as any).comments = { c1: { id: 'c1', text: 'check clause 4', author: 'Bob', at: 'x', replies: [] } }
  ok(docContentKey(base) !== docContentKey(commented),
    'a comment added since the last write changes the content key')

  const snapped: TypeDoc = JSON.parse(JSON.stringify(base))
  snapped.revisions = [{ id: 'rev1', at: 'x', label: 'Revision 1', body: JSON.parse(JSON.stringify(base.body)) }]
  ok(docContentKey(base) !== docContentKey(snapped),
    'a Snapshot taken since the last write changes the content key')
}

H('THE CRASH CASE: sign, crash before the file is written, reload')
{
  // Through the real decision path checkRecovery takes — gateRestored, then
  // the key comparison — minus IndexedDB, which test-autosave.ts already
  // proves against the kernel. The file on disk is `live`: opened, never
  // re-written. The recovery snapshot is what the crashed session last held.
  const live = doc()
  const snapshot: TypeDoc = JSON.parse(JSON.stringify(live))
  snapshot.modified = '2099-01-01T00:00:00.000Z'
  snapshot.signatures = [{ alg: 'ES256', pub: 'P', name: 'Alice', content: 'C', prev: '', sig: 'S' } as any]

  const recovered = gateRestored(JSON.stringify(snapshot), live)
  ok(recovered !== null, 'the snapshot passes the restore gate')
  ok(docContentKey(recovered!) !== docContentKey(live),
    'the Restore banner is OFFERED — the snapshot holds a signature the file lacks')
  ok(recovered!.signatures.length === 1 && recovered!.signatures[0].name === 'Alice',
    'and restoring it brings the signature back, not just the banner')
  ok(recovered!.docId === live.docId, 'while identity still comes from the live file, never the snapshot')

  // The control: a snapshot that differs only by bookkeeping must NOT nag.
  const churn: TypeDoc = JSON.parse(JSON.stringify(live))
  churn.modified = '2099-01-01T00:00:00.000Z'
  const quiet = gateRestored(JSON.stringify(churn), live)
  ok(quiet !== null && docContentKey(quiet) === docContentKey(live),
    'a snapshot differing only in modified offers nothing — no banner on every reload')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
