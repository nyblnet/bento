#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type redline rig.  node scripts/test-type-redline.ts
//
// The two invariants everything rests on:
//     accept(all) == the document they sent back
//     reject(all) == the document you sent
// If either fails, "review these changes" is a lie, because the reviewer's
// choices do not add up to either endpoint.
//
// The fixture is built to be able to FAIL. An earlier version of this rig
// passed against three deliberately broken apply() implementations, because
// its only same-block edits were length-preserving, its only inserted block
// went at the end, and nothing exercised a stale change set. Each is present
// here on purpose.

import { redline, apply, describe, diffTokens, tokenize } from '../type/src/redline.ts';
import { sign, verify, newKey, digest } from '../type/src/canon.ts';
import type { Block } from '../type/src/model.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);
const same = (a: { body: Block[] }, b: { body: Block[] }) => JSON.stringify(a.body) === JSON.stringify(b.body);

const A = {
  docId: 'doc-1',
  body: [
    { id: 'p1', kind: 'para', text: 'The parties agree as follows.' },
    // two edits in one block, the EARLIER one length-changing
    { id: 'p2', kind: 'para', text: 'Payment is due within 30 days of invoice, without set-off.',
      marks: [{ t: 'b', from: 22, to: 29 }],                       // "30 days"
      notes: [{ id: 'n1', at: 58 }] },
    { id: 'p3', kind: 'para', text: 'This agreement is governed by the laws of Sweden.' },
    { id: 'p4', kind: 'para', text: 'Either party may terminate on notice.' },
  ] as Block[],
};

// Offsets are DERIVED from the text, never typed. The first version of this
// fixture hand-counted them, got two wrong, and reported a failure against
// correct code — a test that lies is worse than no test.
const P2 = 'Payment is due within sixty (60) calendar days of invoice, without set-off or counterclaim.';
const TERM = 'sixty (60) calendar days';

const B = {
  docId: 'doc-1',
  body: [
    { id: 'p1', kind: 'para', text: 'The parties agree as follows.' },
    { id: 'p2', kind: 'para', text: P2,
      marks: [{ t: 'b', from: P2.indexOf(TERM), to: P2.indexOf(TERM) + TERM.length }],
      notes: [{ id: 'n1', at: P2.length }] },
    // a NEW block in the MIDDLE, not at the end
    { id: 'p6', kind: 'para', text: 'Late payment shall bear interest at the statutory rate.' },
    { id: 'p4', kind: 'para', text: 'Either party may terminate on notice.' },
    { id: 'p5', kind: 'para', text: 'Neither party shall be liable for indirect losses.' },
  ] as Block[],
};

H('the two invariants');
{
  const set = redline(A, B, { author: 'counsel' });
  const all = new Set(set.changes.map(c => c.id));
  ok(same(apply(A, set, all), B), 'accept ALL reproduces the document they sent back');
  ok(same(apply(A, set, new Set()), A), 'accept NONE leaves the document you sent');
}

H('what the reviewer sees');
{
  const set = redline(A, B, { author: 'counsel' });
  for (const c of set.changes) console.log(`      · ${c.kind.padEnd(10)} ${describe(c)}`);
  const kinds = set.changes.map(c => c.kind);
  ok(kinds.includes('block-del'), 'the deleted governing-law clause is reported');
  ok(kinds.includes('block-ins'), 'the two added clauses are reported');
  ok(kinds.includes('text'), 'the payment-terms edits are reported');
  const ins = set.changes.filter(c => c.kind === 'block-ins') as Array<{ index: number }>;
  ok(ins.some(c => c.index > 0 && c.index < B.body.length - 1),
     'a block inserted in the MIDDLE records its position, not just "somewhere"');
  const texts = set.changes.filter(c => c.kind === 'text' && (c as { blockId: string }).blockId === 'p2');
  ok(texts.length >= 2, `the two separate edits in one paragraph are two changes (${texts.length})`);
}

H('marks and footnote anchors survive an accepted edit');
{
  const set = redline(A, B, { author: 'counsel' });
  const out = apply(A, set, new Set(set.changes.map(c => c.id)));
  const p2 = out.body.find(b => b.id === 'p2')!;
  ok(p2.text === B.body[1].text, 'the text matches what they sent');
  ok(JSON.stringify(p2.marks) === JSON.stringify(B.body[1].marks),
     `the bold covers the same term (“${p2.text.slice(p2.marks![0].from, p2.marks![0].to)}”)`);
  ok(p2.notes![0].at === B.body[1].notes![0].at,
     'the footnote anchor lands where they put it, not mid-word');
}

H('a formatting change is a change');
{
  const bolded = { docId: 'doc-1', body: A.body.map(b => b.id === 'p4'
    ? { ...b, marks: [{ t: 'b' as const, from: 0, to: 12 }] } : b) };
  const set = redline(A, bolded);
  const fmt = set.changes.filter(c => c.kind === 'format');
  ok(fmt.length === 1, `bolding a clause with no text edit is reported (${fmt.length} change)`);
  ok(/bold/.test(describe(fmt[0])), `and described in words: “${describe(fmt[0])}”`);
  const all = new Set(set.changes.map(c => c.id));
  ok(same(apply(A, set, all), bolded), 'accepting it applies the formatting');
  ok(same(apply(A, set, new Set()), A), 'rejecting it leaves the document unformatted');

  // and it must NOT double-report when the text moved too
  const both = redline(A, B);
  ok(both.changes.filter(c => c.kind === 'format').length === 0,
     'a block whose text also changed does not get a second, redundant format card');
}

H('partial acceptance — every subset applies cleanly');
{
  const set = redline(A, B, { author: 'counsel' });
  const ids = set.changes.map(c => c.id);
  let bad = 0;
  for (let mask = 0; mask < (1 << ids.length); mask++) {
    const acc = new Set(ids.filter((_, i) => mask & (1 << i)));
    try { const d = apply(A, set, acc); if (!Array.isArray(d.body)) bad++; }
    catch { bad++; }
  }
  ok(bad === 0, `all ${1 << ids.length} subsets apply without throwing`);
}

H('determinism');
{
  ok(JSON.stringify(redline(A, B).changes) === JSON.stringify(redline(A, B).changes),
     'the same pair always yields the same change set');
  ok(redline(A, A).changes.length === 0, 'a document against itself yields no changes');
  const rev = redline(B, A);
  ok(same(apply(B, rev, new Set(rev.changes.map(c => c.id))), A), 'the redline is symmetric');
}

H('granularity');
{
  const ops = diffTokens(tokenize('Payment is due within 30 days.'), tokenize('Payment is due within 60 days.'));
  const changed = ops.filter(o => o.op !== 'eq');
  ok(changed.length === 2 && changed[0].tokens.join('') === '30' && changed[1].tokens.join('') === '60',
     'a changed number is one deleted word and one inserted word, not a rewritten sentence');
}

H('a proposal is attributable');
{
  const key = await newKey();
  const set = redline(A, B, { author: 'counsel' });
  const proposed = apply(A, set, new Set(set.changes.map(c => c.id)));
  const sig = await sign({ ...proposed, docId: A.docId }, key, { name: 'counsel' });
  ok((await verify({ ...proposed, docId: A.docId }, sig)).ok, 'the proposed document verifies');
  ok(!(await verify({ ...A, docId: A.docId }, sig)).ok, 'and does not verify against the original');
  const tampered = JSON.parse(JSON.stringify(set));
  const t = tampered.changes.find((c: { kind: string }) => c.kind === 'text');
  t.added = ' nine hundred (900) days';
  const other = apply(A, tampered, new Set(tampered.changes.map((c: { id: string }) => c.id)));
  ok(await digest({ ...proposed, docId: A.docId }) !== await digest({ ...other, docId: A.docId }),
     'altering a change after signing changes the digest');
}

H('a table is reviewed CELL BY CELL');
{
  // The whole reason a cell is a block. If a table were one block, changing one
  // figure would report "the fees table changed" — which is the failure that
  // makes line diffs useless on prose, and the limitation bento/slides
  // documents for its own tables.
  const c = (text: string, head?: boolean): Block =>
    ({ id: 'c-' + text.replace(/\W/g, ''), kind: 'cell', text,
       cell: { table: 'fees', cols: 2, ...(head ? { head: true } : {}) } } as Block);

  const before = { docId: 'd', body: [
    { id: 'p', kind: 'para', text: 'Fees:' } as Block,
    c('Service', true), c('Rate', true),
    c('Design'), c('£1,200'),
    c('Build'), c('£1,050'),
  ] };
  const after = {
    docId: 'd',
    body: before.body.map(b => b.text === '£1,050' ? { ...b, text: '£1,300' } : b),
  };

  const set = redline(before, after, { author: 'counsel' });
  ok(set.changes.length === 1, `one change, not a rewritten table (${set.changes.length})`);
  const ch = set.changes[0] as { kind: string; blockId?: string };
  ok(ch.kind === 'text', `and it is a text edit (${ch.kind})`);
  ok(ch.blockId === 'c-1050', `anchored to the CELL that changed (${ch.blockId})`);
  console.log(`      · ${describe(set.changes[0])}`);

  const all = new Set(set.changes.map(x => x.id));
  ok(same(apply(before, set, all), after), 'accepting it reproduces their table');
  ok(same(apply(before, set, new Set()), before), 'rejecting it leaves yours');

  // and a structural change is still structural
  const rowAdded = { docId: 'd', body: [...after.body, c('Support'), c('£400')] };
  const set2 = redline(after, rowAdded);
  ok(set2.changes.length === 2 && set2.changes.every(x => x.kind === 'block-ins'),
     `adding a row is two cell inserts (${set2.changes.map(x => x.kind).join(',')})`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
