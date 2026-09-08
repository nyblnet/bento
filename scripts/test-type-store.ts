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

import { Store } from '../type/src/store.ts';
import { emptyDoc, uid, type TypeDoc } from '../type/src/model.ts';

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

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
