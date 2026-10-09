#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A document kept in this browser is gated before it replaces the open one —
// the bento/type counterpart of test-slides-restore-gate.ts.
//
//   node scripts/test-type-restore-gate.ts
//
// WHAT THIS PROVES. The "Unsaved changes … were found — Restore" snapshot and
// every Version history entry live in IndexedDB under the document's docId,
// and on file:// that store is shared by every local document. Restore used to
// hand the stored JSON straight to store.replace: recovery via a bare
// JSON.parse (no format check at all), version history via the SAME handler as
// "Replace from JSON…". Now (type/src/restoregate.ts):
//   1. a snapshot never brings identity or capability: docId, collab and
//      readonly are the OPEN FILE's, present or absent, whatever it carries —
//      including a forged docId and a forged room/key;
//   2. an HONEST snapshot keeps the document's sharing: kernel writes
//      snapshots WITHOUT collab (autosave.ts contentOnly), so the old path
//      silently dropped the room credentials on every restore, and turned a
//      view-only copy into an editable local one;
//   3. an honest snapshot's content comes back as it went in;
//   4. something that is not a bento/type document is never offered;
//   5. every restore path goes through the gate — and "Replace from JSON…",
//      which is a document the person chose, does NOT: it keeps its own
//      identity.
// Not proven here, deliberately: slides' gate also rebuilds content key by key
// (untrusted.ts). bento/type has no such layer — see restoregate.ts.

import { register } from 'node:module'
import { readFileSync } from 'node:fs'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { gateRestored } = await import('../type/src/restoregate.ts')
const { Store } = await import('../type/src/store.ts')
const { emptyDoc, parseDoc } = await import('../type/src/model.ts')
import type { TypeDoc } from '../type/src/model.ts'

let checks = 0, failures = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }
const read = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')

// A real document, through parseDoc the way a file reaches the editor.
const docOf = (over: object = {}): TypeDoc => {
  const r = parseDoc(JSON.stringify({ ...emptyDoc(), body: [{ id: 'p1', kind: 'para', text: 'agreed terms' }], ...over }))
  if (!r.ok) throw new Error('fixture did not parse')
  return r.doc
}
// What kernel/src/autosave.ts contentOnly() writes into a snapshot: the
// document WITHOUT collab. Pinned against the kernel source below, so this
// fixture cannot quietly drift from what the browser really stores.
const snapshotOf = (d: TypeDoc): string => { const { collab: _c, ...rest } = d as TypeDoc & { collab?: unknown }; return JSON.stringify(rest) }
const ROOM = { v: 2, on: true, room: 'w-mine', key: 'MY-KEY', owner: 'OP', ownerPriv: 'OK' }

console.log('\na snapshot never brings identity or capability\n')
{
  const live = docOf({ collab: ROOM })
  // FORGED: a snapshot planted under this docId by another local page,
  // claiming to be a different document, in a different room, read-only.
  const forged = JSON.stringify({ ...docOf(), docId: 'doc-ATTACKER', readonly: true,
    body: [{ id: 'p1', kind: 'para', text: 'planted text' }],
    collab: { v: 2, on: true, room: 'w-EVIL', key: 'EVIL-KEY', owner: 'EVIL-PUB', ownerPriv: 'EVIL-PRIV' } })
  const g = gateRestored(forged, live)!
  ok(g.docId === live.docId, 'cross-docId forgery: the restored document keeps the OPEN file\'s docId')
  ok(g.collab?.room === 'w-mine' && g.collab?.key === 'MY-KEY',
     'forged collab: the room and key are the open file\'s, never the snapshot\'s')
  ok(!JSON.stringify(g).includes('EVIL'), 'and nothing of the forged credentials survives anywhere in the result')
  ok(!('readonly' in g), 'a forged readonly is dropped — the open file has no mode set, so neither does the result')
  ok(g.body[0].text === 'planted text', 'its CONTENT is what is restored (that is the feature)')

  // the other direction: the open file IS read-only / view-only
  const viewOnly = docOf({ readonly: true, collab: { ...ROOM, ownerPriv: undefined, role: 'reader' } })
  const unlockAttempt = JSON.stringify({ ...docOf(), readonly: false, collab: { ...ROOM } })
  const st = new Store(viewOnly)
  st.replace(gateRestored(unlockAttempt, st.doc)!)
  ok(st.locked && st.doc.collab?.role === 'reader',
     'a snapshot forging WRITER credentials onto a view-only copy cannot unlock it (#588\'s lock reads collab)')
  ok((st.doc as { readonly?: boolean }).readonly === true, 'nor clear its read-only mode')
}

console.log('\nan honest snapshot keeps the document\'s sharing\n')
{
  // The bug that needs no forger: kernel writes snapshots WITHOUT collab.
  const writer = docOf({ collab: ROOM })
  const snap = snapshotOf({ ...writer, body: [{ id: 'p1', kind: 'para', text: 'my unsaved words' }] } as TypeDoc)
  ok(!JSON.parse(snap).collab, 'a real snapshot carries no collab (kernel contentOnly)')
  const g = gateRestored(snap, writer)!
  ok(g.collab?.room === 'w-mine' && g.collab?.key === 'MY-KEY',
     'restoring it KEEPS the room credentials — the old path dropped them on every restore')
  const reader = docOf({ collab: { ...ROOM, ownerPriv: undefined, role: 'reader' } })
  const st = new Store(reader)
  st.replace(gateRestored(snapshotOf(reader), st.doc)!)
  ok(st.locked, 'and a view-only copy stays view-only — the old path turned it into an editable local document')
}

console.log('\nan honest snapshot round-trips\n')
{
  const live = docOf({ title: 'Lease', collab: ROOM,
    body: [{ id: 'h', kind: 'h1', text: 'Lease' }, { id: 'p', kind: 'para', text: 'Rent is due monthly.' }] })
  const g = gateRestored(snapshotOf(live), live)!
  const strip = (d: TypeDoc) => { const { modified: _m, ...r } = d as TypeDoc & { modified?: unknown }; return JSON.stringify(r) }
  ok(strip(g) === strip(live), 'content, title and identity come back as they went in, key for key')
}

console.log('\nnot a document → never offered\n')
{
  const live = docOf({ collab: ROOM })
  ok(gateRestored('{not json', live) === null, 'malformed JSON is not offered')
  ok(gateRestored('', live) === null, 'an empty snapshot is not offered')
  ok(gateRestored(JSON.stringify({ format: 'bento/slides', slides: [] }), live) === null,
     'another app\'s document is not offered as a bento/type restore')
}

console.log('\nrestore is gated; opening a document is not\n')
{
  // Replace from JSON / opening a file: a document the person CHOSE — it keeps
  // its own identity. parseDoc + store.replace, exactly as main.ts does.
  const chosen = docOf({ docId: 'doc-CHOSEN', collab: { ...ROOM, room: 'w-theirs', key: 'THEIR-KEY' } })
  const st = new Store(docOf({ collab: ROOM }))
  const r = parseDoc(JSON.stringify(chosen)); st.replace(r.ok ? r.doc : st.doc)
  ok(st.doc.docId === 'doc-CHOSEN' && st.doc.collab?.room === 'w-theirs',
     'Replace from JSON keeps the CHOSEN document\'s own identity — that is not a restore')
}

console.log('\nevery restore path uses the gate\n')
{
  const autosave = read('type/src/autosave.ts')
  ok(!/JSON\.parse\(\s*snap\.json/.test(autosave), 'type/src/autosave.ts: no raw JSON.parse of a stored snapshot remains')
  ok((autosave.match(/gateRestored\(snap\.json/g) ?? []).length >= 2,
     'type/src/autosave.ts: recovery gates when the banner appears AND again at the click')
  const about = read('type/src/about.ts')
  const history = about.slice(about.indexOf('function openVersionHistory'))
  ok(/onRestoreDoc\(v\.json\)/.test(history) && !/onReplaceDoc\(v\.json\)/.test(history),
     'type/src/about.ts: Version history restores through onRestoreDoc, not Replace from JSON\'s hook')
  const main = read('type/src/main.ts')
  const hook = main.slice(main.indexOf('onRestoreDoc:'), main.indexOf('onRestoreDoc:') + 400)
  ok(/gateRestored\(json, store\.doc\)/.test(hook), 'type/src/main.ts: onRestoreDoc goes through gateRestored')
  const kernel = read('kernel/src/autosave.ts')
  ok(/function contentOnly[\s\S]{0,120}collab/.test(kernel),
     'kernel/src/autosave.ts: snapshots are still written without collab — the fixture above matches the real thing')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
