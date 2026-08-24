#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type comments rig.  node scripts/test-type-comments.ts
//
// The one thing a comment must never do is drift. A comment sitting one clause
// away from the sentence it is about is worse than no comment, because it is
// confidently wrong — so most of this rig is one assertion said many ways:
//
//     block.text.slice(th.from, th.to)  ==  the words the comment was about
//
// EVERY OFFSET IS DERIVED FROM THE TEXT, never typed. The redline rig learned
// this the hard way (its first fixture hand-counted two offsets wrong and
// reported a failure against correct code); a rig with a wrong expectation is
// worse than no rig, and here it would be worse still, because the thing under
// test IS arithmetic over offsets and a hand-counted expectation is just a
// second, unreviewed implementation of it.

import {
  readThreads, writeThreads, newThread, addReply, setResolved, unresolvedCount,
  orderThreads, reconcileThreads, shiftAnchor, textEdit, shiftThreads,
  splitThreads, mergeThreads, commentsOnEdit, commentsOnSplit, commentsOnMerge,
  editMessage, deleteMessage,
  type CommentThread,
} from '../type/src/comments.ts';
import { emptyDoc, parseDoc, spliceText, type Block, type TypeDoc } from '../type/src/model.ts';
import { buildPrintDocument } from '../type/src/print.ts';
import type { Metrics } from '../type/src/paginate.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);

// ───────────────────────────────────────────────────────────────── fixture

const P2 = 'Payment is due within 30 days of invoice, without set-off.';
const TERM = '30 days';                       // what the comment is about
const CLAUSE = 'the laws of Sweden';          // a second anchor, in another block

function fixture(): TypeDoc {
  const doc = emptyDoc();
  doc.title = 'Master Services Agreement';
  doc.body = [
    { id: 'p1', kind: 'para', text: 'The parties agree as follows.' },
    { id: 'p2', kind: 'para', text: P2, marks: [{ t: 'b', from: P2.indexOf(TERM), to: P2.indexOf(TERM) + TERM.length }] },
    { id: 'p3', kind: 'para', text: 'This agreement is governed by the laws of Sweden.' },
  ] as Block[];
  return doc;
}

/** Anchor a comment on the first occurrence of `term` in a block. Derived. */
function commentOn(doc: TypeDoc, blockId: string, term: string, text: string,
                   id: string, at = '2026-01-01T09:00:00.000Z'): CommentThread {
  const blk = doc.body.find(b => b.id === blockId)!;
  const from = blk.text.indexOf(term);
  if (from < 0) throw new Error(`fixture error: ${JSON.stringify(term)} is not in ${blockId}`);
  const th = newThread(blk, from, from + term.length, 'counsel', text, id, at);
  writeThreads(doc, [...readThreads(doc), th]);
  return th;
}

/** What a thread currently points at, in the live document. */
const anchored = (doc: TypeDoc, id: string): string | null => {
  const th = readThreads(doc).find(x => x.id === id);
  if (!th || th.orphan) return null;
  const blk = doc.body.find(b => b.id === th.block);
  return blk ? blk.text.slice(th.from, th.to) : null;
};

const thread = (doc: TypeDoc, id: string) => readThreads(doc).find(x => x.id === id)!;

/**
 * Edit a block's text the way the editor does — splice the block, then hand the
 * before/after text to the hook the core will call. Deliberately routed through
 * commentsOnEdit rather than the pure shift, so the prefix/suffix RECOVERY of
 * the splice is under test too: the editor rebuilds whole blocks from the DOM
 * and never reports a splice, so that recovery is the real code path.
 */
function edit(doc: TypeDoc, blockId: string, at: number, removed: number, added: string): void {
  const i = doc.body.findIndex(b => b.id === blockId);
  const prev = doc.body[i];
  const next = spliceText(prev, at, removed, added);
  doc.body[i] = next;
  commentsOnEdit(doc, blockId, prev.text, next.text);
}

// ───────────────────────────────────────────────────────── the anchor moves

H('an insertion BEFORE the anchor');
{
  const doc = fixture();
  commentOn(doc, 'p2', TERM, 'Is thirty days market standard?', 'c1');
  ok(anchored(doc, 'c1') === TERM, `it starts on ${JSON.stringify(TERM)}`);

  const PRE = 'Unless otherwise agreed, ';
  edit(doc, 'p2', 0, 0, PRE);
  ok(doc.body[1].text.startsWith(PRE), 'the text really did change');
  ok(anchored(doc, 'c1') === TERM,
     `the comment still points at ${JSON.stringify(TERM)} (got ${JSON.stringify(anchored(doc, 'c1'))})`);
  // and it moved by exactly the inserted length — the offsets, not just the slice
  const th = thread(doc, 'c1');
  ok(th.from === doc.body[1].text.indexOf(TERM),
     'its offset is the term\'s new position, derived from the text');
}

H('an insertion INSIDE the anchor');
{
  const doc = fixture();
  commentOn(doc, 'p2', TERM, 'Business days or calendar days?', 'c1');
  // "30 days" → "30 calendar days": the comment was about the whole period, so
  // it must GROW to cover the words that were added into it
  const inside = P2.indexOf(TERM) + '30 '.length;
  edit(doc, 'p2', inside, 0, 'calendar ');
  ok(doc.body[1].text.includes('30 calendar days'), 'the text really did change');
  ok(anchored(doc, 'c1') === '30 calendar days',
     `the anchor grew to cover the insertion (got ${JSON.stringify(anchored(doc, 'c1'))})`);
  ok(!thread(doc, 'c1').orphan, 'and it is not orphaned');
}

H('an insertion AFTER the anchor');
{
  const doc = fixture();
  commentOn(doc, 'p2', TERM, 'Check against the MSA.', 'c1');
  const before = thread(doc, 'c1');
  edit(doc, 'p2', doc.body[1].text.length, 0, ' Time is of the essence.');
  const after = thread(doc, 'c1');
  ok(anchored(doc, 'c1') === TERM, 'the anchor is untouched');
  ok(after.from === before.from && after.to === before.to,
     'and its offsets did not move at all');
}

H('an edit that straddles the anchor');
{
  const doc = fixture();
  commentOn(doc, 'p2', TERM, 'Too long.', 'c1');
  // rewrite "within 30 days of" as "within sixty (60) days of" — the anchor is
  // clipped to what survives rather than dropped, exactly as a bold run is
  const SPAN = 'within 30 days';
  edit(doc, 'p2', P2.indexOf(SPAN), SPAN.length, 'within sixty (60) days');
  const th = thread(doc, 'c1');
  ok(!th.orphan, 'a partly-rewritten anchor survives');
  const now = anchored(doc, 'c1')!;
  ok(doc.body[1].text.slice(th.from, th.to) === now && now.length > 0,
     `it still covers real text (${JSON.stringify(now)})`);
  ok(doc.body[1].text.includes(now), 'which is text that is actually in the block');
}

H('the anchored text is DELETED outright');
{
  const doc = fixture();
  commentOn(doc, 'p2', TERM, 'Is thirty days market standard?', 'c1');
  const from = P2.indexOf(TERM);
  edit(doc, 'p2', from, TERM.length, '');
  ok(!doc.body[1].text.includes(TERM), 'the words are gone from the text');

  const th = thread(doc, 'c1');
  ok(th !== undefined, 'the thread is NOT dropped');
  ok(th.orphan === true, 'it is marked orphaned');
  ok(th.quote === TERM, `and it still says what it was about (${JSON.stringify(th.quote)})`);
  ok(th.messages[0].text === 'Is thirty days market standard?', 'the conversation survives intact');
  ok(anchored(doc, 'c1') === null, 'it points at nothing rather than at whatever moved in');

  // the wrong answer, stated as a test: a live range would now cover the words
  // that flowed into those offsets
  const wouldHaveBeen = doc.body[1].text.slice(from, from + TERM.length);
  ok(wouldHaveBeen !== TERM && wouldHaveBeen.length > 0,
     `keeping the offsets live would have pointed it at ${JSON.stringify(wouldHaveBeen)}`);

  // THE BUG THIS RIG FOUND. The frozen from/to still fit inside the shortened
  // block, so a version of reconcileThreads that re-derived `orphan` from
  // geometry alone un-orphaned this thread on the very next read and pointed it
  // at the text above. Detachment by deletion has to be remembered, not guessed.
  ok(thread(doc, 'c1').orphan === true, 'and it is STILL orphaned when read again');
  const round = readThreads(JSON.parse(JSON.stringify(doc)) as TypeDoc).find(x => x.id === 'c1')!;
  ok(round.orphan === true, 'including after a save and reload');
}

H('the anchored words are REPLACED rather than deleted');
{
  // Replacing text is not deleting it, and the anchor follows the replacement —
  // the same thing a bold run does, which is the point of sharing `shift`. The
  // comment was about that spot, and that spot now says something else, which
  // is exactly what the commenter needs to see.
  const doc = fixture();
  commentOn(doc, 'p2', TERM, 'Is thirty days market standard?', 'c1');
  edit(doc, 'p2', P2.indexOf(TERM), TERM.length, 'sixty days');
  ok(thread(doc, 'c1').orphan !== true, 'a replaced anchor is not orphaned');
  ok(anchored(doc, 'c1') === 'sixty days',
     `it covers the replacement (${JSON.stringify(anchored(doc, 'c1'))})`);
  ok(thread(doc, 'c1').quote === TERM, 'and still records what it was originally about');
}

H('a comment on a block that no longer exists');
{
  const doc = fixture();
  commentOn(doc, 'p3', CLAUSE, 'Governing law should be England.', 'c1');
  ok(anchored(doc, 'c1') === CLAUSE, 'it starts on the governing-law clause');

  doc.body = doc.body.filter(b => b.id !== 'p3');            // the clause is struck out
  const th = thread(doc, 'c1');
  ok(th !== undefined, 'the thread survives the block');
  ok(th.orphan === true, 'and is orphaned rather than dangling');
  ok(th.block === 'p3', 'it remembers WHICH block it was on');
  ok(th.quote === CLAUSE, 'and what it was about');

  // A missing block detaches a thread only for as long as the block is
  // missing: the repair pass writes nothing back, so putting the paragraph
  // back — a rejected redline does exactly this — reattaches the comment.
  ok(JSON.stringify(doc).includes('"orphan"') === false,
     'the detachment was never written into the file');
  doc.body.push({ id: 'p3', kind: 'para', text: 'This agreement is governed by the laws of Sweden.' } as Block);
  ok(thread(doc, 'c1').orphan !== true, 'restoring the block reattaches it');
  ok(anchored(doc, 'c1') === CLAUSE, 'and it points at the same words again');
}

H('a paragraph split and a paragraph merge');
{
  // the split is a real editing move that changes no words, so no comment on
  // either side of the cut may be lost by it
  const doc = fixture();
  commentOn(doc, 'p2', TERM, 'early', 'c1');
  commentOn(doc, 'p2', 'set-off', 'late', 'c2');
  const cut = P2.indexOf('without');
  const head = spliceText(doc.body[1], cut, P2.length - cut, '');
  const tail: Block = { id: 'p2b', kind: 'para', text: P2.slice(cut) };
  doc.body.splice(1, 1, head, tail);
  commentsOnSplit(doc, 'p2', cut, P2.length, 'p2b');

  ok(thread(doc, 'c1').block === 'p2', 'a comment before the cut stays with the head');
  ok(anchored(doc, 'c1') === TERM, 'still on its words');
  ok(thread(doc, 'c2').block === 'p2b', 'a comment after the cut moves to the tail');
  ok(anchored(doc, 'c2') === 'set-off', `still on its words (${JSON.stringify(anchored(doc, 'c2'))})`);

  // and merging them back restores both
  const at = doc.body[1].text.length;
  doc.body.splice(1, 2, { ...doc.body[1], text: doc.body[1].text + doc.body[2].text });
  commentsOnMerge(doc, 'p2', 'p2b', at);
  ok(anchored(doc, 'c1') === TERM && anchored(doc, 'c2') === 'set-off',
     'merging the paragraphs back leaves both comments on their words');
  ok(doc.body[1].text === P2, 'and the text is what it started as');
}

H('a straddling comment goes to the side holding more of its text');
{
  const threads: CommentThread[] = [
    { id: 'a', block: 's', from: 0, to: 10, quote: '', messages: [{ id: 'm', author: 'x', at: '', text: 'q' }] },
    { id: 'b', block: 's', from: 10, to: 30, quote: '', messages: [{ id: 'm', author: 'x', at: '', text: 'q' }] },
  ];
  // cut at 14: `a` is 10 chars ahead of it, `b` is 16 chars behind it
  const out = splitThreads(threads, 's', 14, 40, 'tail');
  ok(out[0].block === 's' && out[0].to === 10, 'wholly-before stays put');
  ok(out[1].block === 'tail', 'the straddler goes to the side with more of it');
  ok(out[1].from === 0 && out[1].to === 30 - 14, 'rebased onto the tail');
  const out2 = splitThreads(threads, 's', 26, 40, 'tail');
  ok(out2[1].block === 's' && out2[1].to === 26, 'and to the head when the head holds more, clipped to the cut');
}

H('the arithmetic is inline.ts\'s, not a second copy of it');
{
  // shiftAnchor is a thin wrapper over the same `shift` marks use, so the two
  // must agree on every edge. Asserted directly, because the day they diverge
  // is the day a highlight and the bold under it stop lining up.
  const a = { from: 10, to: 20 };
  ok(shiftAnchor(a, 0, 0, 5, 45)!.from === 15, 'insertion before pushes the start');
  ok(shiftAnchor(a, 10, 0, 5, 45)!.from === 10, 'insertion exactly AT the start joins the range (sticky start)');
  ok(shiftAnchor(a, 10, 0, 5, 45)!.to === 25, '…and carries the end');
  ok(shiftAnchor(a, 20, 0, 5, 45)!.to === 20, 'insertion exactly AT the end does NOT join it');
  ok(shiftAnchor(a, 10, 10, 0, 30) === null, 'deleting the whole range yields nothing to point at');
  ok(shiftAnchor(a, 0, 40, 0, 0) === null, 'and so does deleting everything');

  const e = textEdit('Payment is due within 30 days.', 'Payment is due within 60 days.');
  ok(e !== null && e.removed === 1 && e.added === '6',
     `the recovered splice is MINIMAL, not "the paragraph changed" (${JSON.stringify(e)})`);
  ok(textEdit('same', 'same') === null, 'no change is reported as no edit');
}

// ────────────────────────────────────────────────────────────── thread logic

H('a reply thread');
{
  const doc = fixture();
  commentOn(doc, 'p2', TERM, 'Is thirty days market standard?', 'c1');
  let th = thread(doc, 'c1');
  ok(th.messages.length === 1, 'a new comment is one message');
  ok(th.messages[0].author === 'counsel', 'attributed to whoever wrote it');

  th = addReply(th, 'client', 'Sixty is what we agreed last time.');
  th = addReply(th, 'counsel', 'Then sixty it is.');
  writeThreads(doc, readThreads(doc).map(x => x.id === 'c1' ? th : x));

  const back = thread(doc, 'c1');
  ok(back.messages.length === 3, `three messages after two replies (${back.messages.length})`);
  ok(back.messages.map(m => m.author).join() === 'counsel,client,counsel',
     'in the order they were written, with their authors');
  ok(back.messages[2].text === 'Then sixty it is.', 'and their text survives the round trip');
  ok(addReply(back, 'client', '   ').messages.length === 3, 'an empty reply is not a reply');
  ok(back.messages.every(m => m.id) && new Set(back.messages.map(m => m.id)).size === 3,
     'every message has its own id');
}

H('editing a message');
{
  const doc = fixture();
  commentOn(doc, 'p2', TERM, 'Is thirty days market standard?', 'c1');
  let th = thread(doc, 'c1');
  th = addReply(th, 'client', 'Sixty is what we agreed last time.');
  const before = { block: th.block, from: th.from, to: th.to, quote: th.quote };
  const firstId = th.messages[0].id, replyId = th.messages[1].id;

  const edited = editMessage(th, firstId, 'Is THIRTY days market standard, or sixty?');
  ok(edited.messages[0].text === 'Is THIRTY days market standard, or sixty?', 'the text changes');
  ok(edited.messages[0].id === firstId && edited.messages[0].author === 'counsel',
     'id and author are untouched by an edit');
  ok(edited.messages[1].text === 'Sixty is what we agreed last time.',
     'the OTHER message in the thread is untouched');
  ok(edited.block === before.block && edited.from === before.from && edited.to === before.to
     && edited.quote === before.quote,
     'the thread\'s anchor (block/from/to/quote) is byte-identical after the edit — ' +
     'an edit changes what was SAID, never what it was said ABOUT');

  writeThreads(doc, readThreads(doc).map(x => x.id === 'c1' ? edited : x));
  ok(anchored(doc, 'c1') === TERM, 'and the live anchor still resolves to the same words');

  ok(editMessage(th, replyId, '   ') === th, 'an edit to nothing but whitespace is refused, not a blank');
  ok(editMessage(th, 'no-such-id', 'x') === th, 'editing a message that is not in the thread is a no-op');
}

H('deleting a message: some remain');
{
  const doc = fixture();
  commentOn(doc, 'p2', TERM, 'Is thirty days market standard?', 'c1');
  let th = thread(doc, 'c1');
  th = addReply(th, 'client', 'Sixty is what we agreed last time.');
  th = addReply(th, 'counsel', 'Then sixty it is.');
  const replyId = th.messages[1].id;

  const after = deleteMessage(th, replyId);
  ok(after !== null, 'the thread survives — two messages are still in it');
  if (after) {
    ok(after.messages.length === 2, `down to two messages (${after.messages.length})`);
    ok(after.messages.map(m => m.text).join('|') === 'Is thirty days market standard?|Then sixty it is.',
       'the deleted message is gone; the other two keep their order');
    ok(after.block === th.block && after.from === th.from && after.to === th.to,
       'the anchor is untouched by deleting a reply');
  }
}

H('deleting the last message removes the whole thread');
{
  const doc = fixture();
  commentOn(doc, 'p2', TERM, 'Is thirty days market standard?', 'c1');
  commentOn(doc, 'p3', CLAUSE, 'Governing law should be England.', 'c2');
  const th1 = thread(doc, 'c1');
  ok(th1.messages.length === 1, 'c1 starts as a single message, nothing to reply with yet');

  const gone = deleteMessage(th1, th1.messages[0].id);
  ok(gone === null, 'deleting the only message returns null — no empty-shell thread');

  // the caller (comments.ts mutateThread) is what actually removes it from
  // the map; exercise that end-to-end via the same doc-level plumbing a UI
  // action would use.
  writeThreads(doc, readThreads(doc).filter(x => x.id !== 'c1'));
  ok(readThreads(doc).find(x => x.id === 'c1') === undefined, 'c1 is gone from the document entirely');
  ok(readThreads(doc).find(x => x.id === 'c2') !== undefined, 'and c2, a different thread, is untouched');
  ok(anchored(doc, 'c2') === CLAUSE, 'c2 still resolves to its own words');
  ok(!JSON.stringify(doc).includes('Is thirty days market standard?'),
     'the deleted conversation does not linger anywhere in the saved bytes');
}

H('resolve and unresolve');
{
  const doc = fixture();
  commentOn(doc, 'p2', TERM, 'Is thirty days market standard?', 'c1');
  commentOn(doc, 'p3', CLAUSE, 'Governing law?', 'c2');
  ok(unresolvedCount(readThreads(doc)) === 2, 'two open to start with');

  const resolved = setResolved(thread(doc, 'c1'), true);
  writeThreads(doc, readThreads(doc).map(x => x.id === 'c1' ? resolved : x));
  ok(thread(doc, 'c1').resolved === true, 'it resolves');
  ok(unresolvedCount(readThreads(doc)) === 1, 'and the count follows');
  ok(anchored(doc, 'c1') === TERM, 'a resolved comment keeps its anchor — it is not a delete');

  const reopened = setResolved(thread(doc, 'c1'), false);
  writeThreads(doc, readThreads(doc).map(x => x.id === 'c1' ? reopened : x));
  ok(thread(doc, 'c1').resolved === undefined, 'and it reopens, with the flag GONE, not false');
  ok(unresolvedCount(readThreads(doc)) === 2, 'back to two open');
  ok(JSON.stringify(reopened).includes('resolved') === false,
     'so a reopened thread serializes exactly as one that was never resolved');
}

H('the order the panel shows');
{
  const doc = fixture();
  // deliberately created out of every order that matters
  commentOn(doc, 'p3', CLAUSE, 'last block, open', 'c-p3', '2026-01-01T09:00:00.000Z');
  commentOn(doc, 'p2', 'set-off', 'later in p2, open', 'c-p2b', '2026-01-01T08:00:00.000Z');
  commentOn(doc, 'p2', TERM, 'earlier in p2, open', 'c-p2a', '2026-01-01T10:00:00.000Z');
  commentOn(doc, 'p1', 'parties', 'first block, RESOLVED', 'c-p1', '2026-01-01T07:00:00.000Z');
  writeThreads(doc, readThreads(doc).map(x => x.id === 'c-p1' ? setResolved(x, true) : x));
  // and one that has lost its text entirely
  commentOn(doc, 'p1', 'follows', 'orphan, open', 'c-orph', '2026-01-01T06:00:00.000Z');
  edit(doc, 'p1', doc.body[0].text.indexOf('follows'), 'follows'.length, '');

  const order = orderThreads(readThreads(doc), doc.body).map(x => x.id);
  ok(order.join() === 'c-p2a,c-p2b,c-p3,c-orph,c-p1',
     `unresolved in document order, then detached, then resolved (${order.join(' ')})`);

  const list = orderThreads(readThreads(doc), doc.body);
  const firstResolvedAt = list.findIndex(x => x.resolved);
  ok(list.slice(0, firstResolvedAt).every(x => !x.resolved), 'nothing resolved appears above anything open');
  ok(unresolvedCount(list) === 4, 'the count is the open ones, orphans included — they still want a human');

  // deterministic: two readers of one file must see the same list
  const again = orderThreads([...list].reverse(), doc.body).map(x => x.id);
  ok(again.join() === order.join(), 'and the order does not depend on the input order');
}

// ─────────────────────────────────────────────────── the file, and the paper

H('comments are saved in the file, and an older build still opens it');
{
  const doc = fixture();
  commentOn(doc, 'p2', TERM, 'Is thirty days market standard?', 'c1');
  const json = JSON.stringify(doc);
  ok(json.includes('Is thirty days market standard?'), 'the conversation is in the saved bytes');

  // FORMAT ADDITIVITY: parseDoc has no idea what `comments` is, and the unknown
  // field rides through untouched — which is the same thing as an older build
  // opening a newer file, since that build's parseDoc is this one minus the
  // comment code.
  const parsed = parseDoc(json);
  ok(parsed.ok, 'it parses');
  if (parsed.ok) {
    ok(readThreads(parsed.doc).length === 1, 'and the thread is still there after a round trip');
    ok(anchored(parsed.doc, 'c1') === TERM, 'still anchored on its words');
    ok(parsed.repaired.length === 0, `and nothing was reported as repaired (${parsed.repaired.join('; ')})`);
  }

  // a file a generator got wrong: repaired, never crashed
  const junk = JSON.parse(json);
  junk.comments = {
    ok1: { id: 'ok1', block: 'p2', from: 9e9, to: -3, quote: 'x', messages: [{ text: 'runaway offsets' }] },
    ok2: { id: 'ok2', block: 'nope', from: 0, to: 2, quote: 'y', messages: [{ text: 'no such block' }] },
    bad: { id: 'bad', block: 'p2', from: 0, to: 2, quote: 'z', messages: [] },
    worse: 'not an object at all',
  };
  const rough = readThreads(junk as TypeDoc);
  ok(rough.length === 2, `a thread with no conversation in it is the only one dropped (${rough.length})`);
  ok(rough.find(x => x.id === 'ok1')!.orphan === true,
     'a garbage range orphans rather than being "repaired" into the whole paragraph');
  ok(rough.find(x => x.id === 'ok2')!.orphan === true, 'a missing block orphans');
}

H('a comment can never reach the printed page');
{
  const doc = fixture();
  commentOn(doc, 'p2', TERM, 'CONFIDENTIAL REVIEWER NOTE: push back hard on this.', 'c1');
  const metrics: Metrics = { ms: 0, pages: [{ n: 1, start: 0, end: Infinity, notes: [], reserved: 0 }] };
  const withComments = buildPrintDocument(doc, metrics);

  ok(!withComments.includes('CONFIDENTIAL REVIEWER NOTE'), 'the comment text is not in the print output');
  ok(!withComments.includes('counsel'), 'nor is the commenter\'s name');
  ok(!/t-cmt/.test(withComments), 'nor any comment markup');

  // the strong form: print cannot TELL the difference. print.ts renders blocks
  // from text + marks + notes and never reads doc.comments, so there is no path
  // from a comment to the paper that a future edit could forget to close.
  const clean = fixture();
  ok(buildPrintDocument(clean, metrics) === withComments,
     'the printed bytes are identical to the same document with no comments at all');
  ok(withComments.includes(TERM), 'and the commented WORDS still print, unmarked');
}

// ───────────────────────────────── the pure movers, exercised without a doc

H('the pure movers stand alone');
{
  const base: CommentThread[] = [
    { id: 'a', block: 'b1', from: 4, to: 9, quote: 'quick', messages: [{ id: 'm', author: 'x', at: '', text: 'q' }] },
  ];
  const TXT = 'The quick brown fox';
  const NEW = 'The very quick brown fox';
  const e = textEdit(TXT, NEW)!;
  const moved = shiftThreads(base, 'b1', e.at, e.removed, e.added.length, NEW.length);
  // "very " is inserted at exactly the anchor's start, so the STICKY START rule
  // above applies and the range takes it in — the same thing the bold under it
  // would do. Derived from the text either way, never hand-counted.
  ok(NEW.slice(moved[0].from, moved[0].to) === 'very quick',
     `sticky start: the anchor reads "very quick" (${JSON.stringify(NEW.slice(moved[0].from, moved[0].to))})`);
  ok(TXT.slice(base[0].from, base[0].to) === 'quick', 'and the original still read "quick"');
  ok(shiftThreads(base, 'other', 0, 0, 99, 999)[0].from === 4, 'an edit in another block moves nothing');

  const merged = mergeThreads(base, 'b0', 'b1', 100);
  ok(merged[0].block === 'b0' && merged[0].from === 104 && merged[0].to === 109,
     'a merge rebases the anchor onto the surviving block');
  ok(reconcileThreads(base, [{ id: 'b1', kind: 'para', text: TXT } as Block])[0].orphan === undefined,
     'reconcile leaves a good anchor alone');
  ok(reconcileThreads(base, [{ id: 'b1', kind: 'para', text: 'Th' } as Block])[0].orphan === true,
     'and orphans one the text is now too short for');
  ok(reconcileThreads([{ ...base[0], orphan: true }], [{ id: 'b1', kind: 'para', text: TXT } as Block])[0].orphan === true,
     'an orphan flag is never cleared by the repair pass — only undo brings a thread back');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
