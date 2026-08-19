#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Tracked changes — the engine, before any UI is wired to it.
//
//   node scripts/test-type-track.ts
//
// The property that matters and is easy to lose: a tracked document must be
// able to go BOTH ways. Accepting everything must give the text as edited;
// rejecting everything must give the text as it was. If either drifts, the
// feature is worse than not having it — a lawyer rejects a change and gets
// something nobody wrote.

import { register } from 'node:module';
register('./lib/ts-resolve-hooks.mjs', import.meta.url);

const { trackEdit, resolve, resolveAll, textOf, changes } = await import('../type/src/track.ts');
const { emptyDoc, wordCount } = await import('../type/src/model.ts');

let checks = 0, bad = 0;
const ok = (cond: boolean, msg: string) => {
  checks++;
  if (cond) console.log(`  ok    ${msg}`);
  else { bad++; console.log(`  FAIL  ${msg}`); }
};
const eq = (a: unknown, b: unknown, msg: string) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`);

const blk = (text: string, marks?: unknown[]) =>
  ({ id: 'p1', kind: 'para', text, ...(marks ? { marks } : {}) }) as never;
const WHO = 'Counsel', WHEN = '2026-08-18T10:00:00Z';
const edit = (before: string, after: string) => trackEdit(blk(before), blk(after), WHO, WHEN);

console.log('\n— an insertion —');
{
  const b = edit('Payment is due.', 'Payment is now due.');
  eq(b.text, 'Payment is now due.', 'text carries the insertion');
  const ins = (b.marks ?? []).filter((m: { t: string }) => m.t === 'ins');
  eq(ins.length, 1, 'one ins mark');
  eq(b.text.slice(ins[0].from, ins[0].to), 'now ', 'the mark covers exactly what was typed');
  eq(ins[0].by, WHO, 'attributed');
  eq(textOf(b), 'Payment is now due.', 'a reader sees the insertion');
}

console.log('\n— a deletion keeps its characters —');
{
  const b = edit('Payment is now due.', 'Payment is due.');
  eq(b.text, 'Payment is now due.', 'the deleted characters are STILL THERE');
  const del = (b.marks ?? []).filter((m: { t: string }) => m.t === 'del');
  eq(del.length, 1, 'one del mark');
  eq(b.text.slice(del[0].from, del[0].to), 'now ', 'the mark covers exactly what was removed');
  eq(textOf(b), 'Payment is due.', 'a reader does NOT see deleted text');
}

console.log('\n— type over a selection: both, at once —');
{
  const b = edit('due within 30 days', 'due within 45 days');
  ok((b.marks ?? []).some((m: { t: string }) => m.t === 'ins'), 'has an insertion');
  ok((b.marks ?? []).some((m: { t: string }) => m.t === 'del'), 'has a deletion');
  eq(textOf(b), 'due within 45 days', 'reads as the new text');
}

console.log('\n— accept and reject, one change at a time —');
{
  const ins = edit('Payment is due.', 'Payment is now due.');
  const m = (ins.marks ?? []).find((x: { t: string }) => x.t === 'ins')!;
  eq(resolve(ins, m, true).text, 'Payment is now due.', 'accepting an insertion keeps the words');
  eq((resolve(ins, m, true).marks ?? []).length, 0, 'and drops the mark');
  eq(resolve(ins, m, false).text, 'Payment is due.', 'rejecting an insertion removes them');

  const del = edit('Payment is now due.', 'Payment is due.');
  const d = (del.marks ?? []).find((x: { t: string }) => x.t === 'del')!;
  eq(resolve(del, d, true).text, 'Payment is due.', 'accepting a deletion removes the words');
  eq(resolve(del, d, false).text, 'Payment is now due.', 'rejecting a deletion puts them back');
  eq((resolve(del, d, false).marks ?? []).length, 0, 'and drops the mark');
}

console.log('\n— the round trip, over a whole document —');
{
  const ORIGINAL = 'The Supplier shall provide the services within 30 days.';
  const EDITED   = 'The Supplier must provide the services within 45 days.';
  const doc = emptyDoc();
  doc.body = [trackEdit(blk(ORIGINAL), blk(EDITED), WHO, WHEN)];

  eq(textOf(doc.body[0]), EDITED, 'a reader sees the edited text');
  ok(changes(doc).length >= 2, `every change is listed (${changes(doc).length})`);

  const accepted = JSON.parse(JSON.stringify(doc));
  resolveAll(accepted, true);
  eq(accepted.body[0].text, EDITED, 'accept all → the text as edited');
  eq((accepted.body[0].marks ?? []).length, 0, 'accept all → no marks left');

  const rejected = JSON.parse(JSON.stringify(doc));
  resolveAll(rejected, false);
  eq(rejected.body[0].text, ORIGINAL, 'reject all → the text as it was');
  eq((rejected.body[0].marks ?? []).length, 0, 'reject all → no marks left');
}

console.log('\n— existing formatting survives —');
{
  const before = blk('Payment is due.', [{ t: 'b', from: 0, to: 7 }]);
  const after = blk('Payment is really due.', [{ t: 'b', from: 0, to: 7 }]);
  const b = trackEdit(before, after, WHO, WHEN);
  ok((b.marks ?? []).some((m: { t: string; from: number; to: number }) =>
      m.t === 'b' && m.from === 0 && m.to === 7), 'the bold run is still bold');
}

console.log('\n— two authors do not merge —');
{
  // `next` must CARRY the marks so far — in the app it is the block read back
  // out of contentEditable, which has them. Building it with a bare blk() threw
  // Ann's mark away before Bob ever edited, and the rig then reported the
  // engine merging two authors when what it had actually done was lose one.
  let b = trackEdit(blk('a'), blk('ab'), 'Ann', WHEN);
  b = trackEdit(b, { ...b, text: b.text + 'c' } as never, 'Bob', WHEN);
  const ins = (b.marks ?? []).filter((m: { t: string }) => m.t === 'ins');
  eq(ins.length, 2, 'abutting insertions by different people stay separate');
  eq(ins.map((m: { by: string }) => m.by).sort(), ['Ann', 'Bob'], 'each keeps its author');
}

console.log('\n— the word count is what a READER would count —');
{
  const doc = emptyDoc();
  doc.body = [trackEdit(blk('one two three four five'), blk('one two'), WHO, WHEN)];
  eq(doc.body[0].text, 'one two three four five', 'the deleted words are still in the model');
  eq(wordCount(doc), 2, 'but the count is 2, not 5');
  // Without this, DELETING text makes the word count go UP — the struck
  // characters stay in b.text and a raw count has no way to know they are gone.
  const grown = emptyDoc();
  grown.body = [trackEdit(blk('one two'), blk('one two three'), WHO, WHEN)];
  eq(wordCount(grown), 3, 'and an insertion counts');
}

console.log('\n— an untracked document is untouched —');
{
  const doc = emptyDoc();
  const before = JSON.stringify(doc.body);
  resolveAll(doc, true);
  eq(JSON.stringify(doc.body), before, 'resolveAll on a clean document changes nothing');
}

console.log(`\n${checks - bad}/${checks} checks passed`);
if (bad) process.exit(1);
