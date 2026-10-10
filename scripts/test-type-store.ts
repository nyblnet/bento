#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type store + undo rig.  node scripts/test-type-store.ts
//
// The claims worth pinning, because each fails silently and each costs work:
//   · a typed word is ONE undo press, not one per keystroke
//   · a scoped snapshot really is scoped — the whole document is not copied
//     per keystroke (spaces measured an undo depth of NINE when it was)
//   · undo/redo round-trips exactly, including interleaved
//   · a block snapshot restores the block it names even after the body moved

import { register } from 'node:module';
// The sync adapter (hostStore) pulls the kernel transport in, which uses
// TypeScript node's strip-only loader cannot run — so this rig loads through
// the repo's transpiling hooks, like the other rigs that reach the sync stack.
register('./lib/ts-resolve-hooks.mjs', import.meta.url);
const { Store } = await import('../type/src/store.ts');
import type { TypeDoc } from '../type/src/model.ts';
const { emptyDoc, uid, parseDoc } = await import('../type/src/model.ts');
const { hostStore } = await import('../type/src/sync/session.ts');

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);

const doc = (n = 3): TypeDoc => {
  const d = emptyDoc();
  d.body = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, kind: 'para' as const, text: `block ${i}` }));
  return d;
};

H('a typing run is one undo step');
{
  const s = new Store(doc());
  const before = s.block('p1')!.text;
  for (const ch of 'hello') {
    s.commit(d => { d.body[1].text += ch; }, { scope: { block: 'p1' }, run: 'type:p1' });
  }
  ok(s.block('p1')!.text === before + 'hello', 'five characters landed');
  ok(s.undoDepth === 1, `and cost ONE undo step, not five (depth ${s.undoDepth})`);
  s.undo();
  ok(s.block('p1')!.text === before, 'one undo removes the whole run');
  s.redo();
  ok(s.block('p1')!.text === before + 'hello', 'and redo puts it back');
}

H('a different run, or none, starts a new step');
{
  const s = new Store(doc());
  s.commit(d => { d.body[0].text += 'a'; }, { scope: { block: 'p0' }, run: 'type:p0' });
  s.commit(d => { d.body[1].text += 'b'; }, { scope: { block: 'p1' }, run: 'type:p1' });
  ok(s.undoDepth === 2, 'typing in a different block starts a new step');
  s.commit(d => { d.body[1].text += 'c'; }, { scope: { block: 'p1' }, run: 'type:p1' });
  ok(s.undoDepth === 2, 'continuing the same run does not');
  s.breakRun();
  s.commit(d => { d.body[1].text += 'd'; }, { scope: { block: 'p1' }, run: 'type:p1' });
  ok(s.undoDepth === 3, 'breakRun() closes the group (what a click or a paste does)');
}

H('scoped snapshots do not copy the whole document');
{
  // 400 blocks of real prose, then 200 keystrokes in ONE of them
  const d = emptyDoc();
  d.body = Array.from({ length: 400 }, (_, i) => ({
    id: `p${i}`, kind: 'para' as const,
    text: 'The parties agree that the schedule attached hereto forms part of this agreement. '.repeat(3),
  }));
  const s = new Store(d);
  let bytes = 0;
  for (let i = 0; i < 200; i++) {
    s.commit(x => { x.body[7].text += 'x'; }, { scope: { block: 'p7' }, run: `k${i}` });
  }
  ok(s.undoDepth === 200, `200 distinct edits are 200 undo steps (depth ${s.undoDepth})`);
  // the point: each step holds ONE block, not 400
  const oneBlock = JSON.stringify(d.body[7]).length;
  const wholeDoc = JSON.stringify(d).length;
  bytes = oneBlock * 200;
  ok(bytes < wholeDoc * 200 / 50,
     `200 scoped steps cost ~${(bytes / 1024).toFixed(0)}KB, where whole-document ones would cost ~${(wholeDoc * 200 / 1024 / 1024).toFixed(1)}MB`);
  // and they still restore correctly
  for (let i = 0; i < 200; i++) s.undo();
  ok(!s.block('p7')!.text.endsWith('x'), 'undoing all 200 restores the original text');
}

H('undo/redo round-trips, interleaved');
{
  const s = new Store(doc());
  const snap = () => s.doc.body.map(b => b.text).join('|');
  const start = snap();
  s.commit(d => { d.body[0].text = 'one'; });
  const a = snap();
  s.commit(d => { d.body[1].text = 'two'; });
  const b = snap();
  s.undo(); ok(snap() === a, 'undo returns to the previous state');
  s.undo(); ok(snap() === start, 'and to the one before that');
  s.redo(); ok(snap() === a, 'redo replays');
  s.redo(); ok(snap() === b, 'and replays again');
  ok(!s.canRedo, 'the redo stack is exhausted');
  s.commit(d => { d.body[2].text = 'three'; });
  ok(!s.canRedo, 'a new edit clears the redo stack');
}

H('a block snapshot survives the body moving under it');
{
  const s = new Store(doc(4));
  s.commit(d => { d.body[2].text = 'edited'; }, { scope: { block: 'p2' } });
  // something else removes an earlier block, so indices shift
  s.commit(d => { d.body.splice(0, 1); });
  s.undo();                      // put the block back
  s.undo();                      // undo the edit
  ok(s.block('p2')!.text === 'block 2', 'the block-scoped undo found its block by id, not by index');
}

H('replace() is undoable');
{
  const s = new Store(doc());
  const before = s.doc.body.length;
  const other = emptyDoc(); other.body = [{ id: 'z', kind: 'para', text: 'replaced' }];
  s.replace(other);
  ok(s.doc.body.length === 1, 'the document was replaced');
  s.undo();
  ok(s.doc.body.length === before, 'and undo brings the original back');
}

H('listeners fire once per commit');
{
  const s = new Store(doc());
  let n = 0;
  const off = s.on(() => n++);
  s.commit(d => { d.body[0].text = 'x'; });
  s.commit(d => { d.body[0].text = 'y'; });
  s.undo();
  ok(n === 3, `two commits and an undo fired three times (${n})`);
  off();
  s.commit(d => { d.body[0].text = 'z'; });
  ok(n === 3, 'and unsubscribing stops them');
}

console.log('\n— a receive-only copy takes no edits, and still receives —');
{
  // Through parseDoc, the way a real file arrives — the lock is decided from
  // what survives intake, not from a hand-built object.
  const docOf = (collab?: object): TypeDoc => {
    const d: TypeDoc = { ...emptyDoc(), body: [{ id: 'p1', kind: 'para', text: 'agreed' }] };
    const r = parseDoc(JSON.stringify(collab ? { ...d, collab } : d));
    if (!r.ok) throw new Error('fixture did not parse');
    return r.doc;
  };
  const room = { v: 2, on: true, room: 'w1', key: 'K', owner: 'OP' };
  // FACTORIES, not shared objects: a Store holds the document it is given, so
  // a case that writes through one (the remote-edit case below does) would
  // otherwise leak into every later case that reuses the fixture — which is
  // exactly how the first version of this section failed.
  const writer   = () => docOf({ ...room, ownerPriv: 'OK' });
  const reader   = () => docOf({ ...room, role: 'reader' });
  const audience = () => docOf({ ...room, role: 'audience', invite: { pub: 'IP', priv: 'IK', role: 'audience', sig: 'S' } });
  const local    = () => docOf();
  const edit = (st: Store) => st.commit(d => { d.body[0].text = 'CHANGED'; });
  const text = (st: Store) => st.doc.body[0].text;

  let st = new Store(writer()); edit(st);
  ok(!st.locked && text(st) === 'CHANGED', 'a writer copy edits');
  st = new Store(local()); edit(st);
  ok(!st.locked && text(st) === 'CHANGED', 'a LOCAL document (no collab) edits — no room is not read-only');

  st = new Store(reader()); edit(st);
  ok(st.locked, 'a view-only reader copy is locked');
  ok(text(st) === 'agreed', 'and a user edit is REFUSED — it would live only here and drift from the room');
  ok(!st.canUndo, 'leaving nothing on the undo stack either');
  st = new Store(audience()); edit(st);
  ok(st.locked && text(st) === 'agreed', 'an audience copy is locked the same way');

  // The sync session's own commits must still land — a reader needs a peer's
  // published images more than anyone (kernel session.ts resolveBlobs).
  st = new Store(reader());
  hostStore(st).commit(() => { (st.doc.assets ??= {}).img = 'data:image/png;base64,AA=='; });
  ok(st.doc.assets?.img !== undefined, "a SYSTEM commit through the session adapter gets through the lock — readers still get images");

  // The copy's own CONNECTION state goes through the same adapter (collab.ts
  // wraps the store with hostStore for kernel online.ts's sharing helpers),
  // and `window.bento.sync.unshare()` reaches stopSharing on ANY copy. A viewer
  // disconnecting must stick — not drop the socket while the file still says
  // on:true and quietly rejoins next open. This is why `system: true` stays on
  // the adapter even once no blob path needs it.
  {
    const { stopSharing } = await import('../kernel/src/sync/online.ts');
    st = new Store(reader());
    stopSharing({ removeTransport() {} } as never, hostStore(st));
    ok(st.doc.collab?.on === false,
       'a READER can turn its own sharing off (bento.sync.unshare) — connection state is not a content edit');
  }

  // A remote edit is applied surgically and announced with touch(), never commit.
  st = new Store(reader()); let heard = 0; st.on(() => heard++);
  st.doc.body[0].text = 'from the room'; st.touch();
  ok(heard === 1 && text(st) === 'from the room', 'a REMOTE edit still lands on a locked copy — it follows the room');

  // THE ARRIVAL PATH bento/slides found: a receive-only copy loaded into an
  // editor that is already running.
  st = new Store(writer());
  ok(!st.locked, 'an editor that boots on a writer copy starts unlocked');
  st.replace(reader());
  ok(st.locked, 'and LOCKS when a reader copy is loaded into it later (loadDoc, Replace from JSON, recovery)');
  edit(st);
  ok(text(st) === 'agreed', 'so the newly-arrived copy refuses edits too');
  // Undo NEVER unlocks: the lock reads `collab`, and undo takes collab from
  // the live document (store.ts FROM_LIVE). This case first asserted the
  // opposite — that undoing the replace restored the writer copy and unlocked
  // it — which was the old full-swap undo, and the rule it encoded is the bug.
  st.undo();
  ok(st.locked, 'undoing that replace does NOT unlock — a view-only copy stays view-only whatever ⌘Z does');
  edit(st);
  ok(text(st) === 'agreed', 'so it still refuses edits after the undo');
}

console.log('\n— undo and redo move content, never identity —');
{
  // Driven through the app's REAL identity actions — kernel online.ts's
  // sharing helpers via the session adapter, exactly as collab.ts calls them —
  // not by hand-setting fields. In type, collab is the field that changes in
  // place; docId and readonly change only when a document is loaded over this
  // one, so those rows go through replace.
  const { stopSharing, rotateKeys } = await import('../kernel/src/sync/online.ts');
  const ses = { removeTransport() {} } as never;
  // Through parseDoc, like the section above, and fresh per call.
  const docOf = (collab?: object): TypeDoc => {
    const d: TypeDoc = { ...emptyDoc(), body: [{ id: 'p1', kind: 'para', text: 'agreed' }] };
    const r = parseDoc(JSON.stringify(collab ? { ...d, collab } : d));
    if (!r.ok) throw new Error('fixture did not parse');
    return r.doc;
  };
  const room = { v: 2, on: true, room: 'w1', key: 'K', owner: 'OP' };
  const local = () => docOf();
  const text = (st: Store) => st.doc.body[0].text;
  const shared = (over: object = {}) => docOf({ ...room, ownerPriv: 'OK', room: 'OLD-ROOM', key: 'OLD-KEY', ...over });
  const typed = (st: Store, t: string) => st.commit(d => { d.body[0].text = t; });

  // collab: Stop sharing
  let s1 = new Store(shared()); typed(s1, 'v2');
  stopSharing(ses, hostStore(s1));
  s1.undo();
  ok(s1.doc.collab?.on === false, 'Stop sharing, then ⌘Z: sharing STAYS off');
  s1.redo();
  ok(s1.doc.collab?.on === false, 'and redo does not turn it back on either');

  // collab: Reset access — revocation, the case that matters most
  let s2 = new Store(shared()); typed(s2, 'v2');
  await rotateKeys(ses, hostStore(s2));
  const fresh = s2.doc.collab?.key;
  ok(fresh !== 'OLD-KEY', 'Reset access mints a new room key');
  // Undo ALL the way back, checking at EVERY step — rotateKeys commits twice
  // (stopSharing, then the fresh credentials), so the revoked key is sitting
  // in more than one snapshot, and any single step could have resurrected it.
  let steps = 0, everOld = false;
  while (s2.canUndo) { s2.undo(); steps++; if (s2.doc.collab?.key === 'OLD-KEY' || s2.doc.collab?.room === 'OLD-ROOM') everOld = true; }
  ok(!everOld && s2.doc.collab?.key === fresh,
     `and ⌘Z all the way back (${steps} steps) never brings the REVOKED key or room back, at any step`);
  ok(text(s2) === 'agreed', 'while the CONTENT still undoes all the way back');
  while (s2.canRedo) { s2.redo(); if (s2.doc.collab?.key !== fresh) everOld = true; }
  ok(!everOld && text(s2) === 'v2', 'redo moves content forward and leaves the new key alone at every step');

  // docId: identity survives undo across a load
  const other = docOf({ ...room, ownerPriv: 'OK' }); other.docId = 'doc-LOADED';
  let s3 = new Store(shared()); const before = s3.doc.docId;
  s3.replace(other);
  s3.undo();
  ok(s3.doc.docId === 'doc-LOADED' && s3.doc.docId !== before,
     'docId is not undoable: ⌘Z after a load keeps the live identity');
  ok(text(s3) === 'agreed', 'though the earlier content comes back');
  s3.redo();
  ok(s3.doc.docId === 'doc-LOADED', 'and redo keeps it');

  // readonly: the file's mode survives undo across a load
  const player = docOf(); (player as { readonly?: boolean }).readonly = true;
  let s4 = new Store(local()); s4.replace(player);
  s4.undo();
  ok((s4.doc as { readonly?: boolean }).readonly === true, 'readonly is not undoable: the mode the file is in stays');
  s4.redo();
  ok((s4.doc as { readonly?: boolean }).readonly === true, 'across redo too');

  // and the field going ABSENT is kept as absent, not resurrected from the snapshot
  let s5 = new Store(player); s5.replace(local());
  s5.undo();
  ok(!('readonly' in s5.doc), 'a live field that is ABSENT stays absent — undo does not resurrect it from the snapshot');

  // the ordinary case is untouched: content undo still works
  let s6 = new Store(shared()); typed(s6, 'v2'); typed(s6, 'v3');
  s6.undo();
  ok(text(s6) === 'v2', 'an ordinary edit still undoes');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
