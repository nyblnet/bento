#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type model rig.  node scripts/test-type-model.ts
//
// Two properties, both of which fail SILENTLY and neither of which a shipped
// file can be talked out of once it exists:
//
//   1. THE LOAD CONTRACT. An unreadable document must never be replaced by an
//      empty one. bento/spaces learned this the expensive way — a parse that
//      returned null let the caller fall back to a starter, so opening a file
//      from another app presented an empty document over live data, and the
//      first save wrote it to disk. Only an ABSENT or EMPTY block may start a
//      new document; everything else is an error the user gets told about.
//
//   2. OFFSETS MOVE TOGETHER. Marks and footnote anchors are offsets into the
//      same string. Code that updates one and not the other is what put a
//      footnote marker in the middle of a word during the spike, so there is
//      one function that moves both and this pins it.

import { parseDoc, spliceText, emptyDoc, FORMAT, plainText, wordCount, type Block } from '../type/src/model.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);
const J = (v: unknown) => JSON.stringify(v);

const doc = (over: Record<string, unknown> = {}) => JSON.stringify({
  format: FORMAT, version: 1, docId: 'doc-1', title: 'T',
  body: [{ id: 'p1', kind: 'para', text: 'Hello world.' }],
  footnotes: {}, revisions: [], signatures: [], ...over,
});

H('the load contract — an unreadable file never becomes an empty one');
{
  ok(parseDoc('').ok === false && (parseDoc('') as { err: string }).err === 'empty',
     'an empty block is the ONLY path to a new document');
  ok((parseDoc('   \n ') as { err: string }).err === 'empty', 'whitespace counts as empty');

  const bad = parseDoc('{not json');
  ok(!bad.ok && bad.err === 'json', 'malformed JSON is an error, not a fresh document');

  const slides = parseDoc(JSON.stringify({ format: 'bento/slides', slides: [] }));
  ok(!slides.ok && slides.err === 'format', 'a slides file is refused');
  ok(!slides.ok && slides.err === 'format' && slides.found === 'bento/slides',
     'and the refusal names the format it actually found, so the message can be useful');

  const noBody = parseDoc(JSON.stringify({ format: FORMAT }));
  ok(!noBody.ok && noBody.err === 'shape', 'a document with no body is refused');

  const good = parseDoc(doc());
  ok(good.ok && good.doc.body.length === 1, 'a well-formed document loads');
}

H('repairs are derived from the bytes, so every reader agrees');
{
  const dup = parseDoc(doc({ body: [
    { id: 'p1', kind: 'para', text: 'one' },
    { id: 'p1', kind: 'para', text: 'two' },
  ] }));
  ok(dup.ok && dup.doc.body[0].id !== dup.doc.body[1].id, 'duplicate ids are made unique');
  ok(dup.ok && dup.doc.body[1].id === 'p1~1',
     'the repair is positional, so two readers of these bytes produce the SAME ids');
  ok(dup.ok && dup.repaired.some(r => /duplicate id/.test(r)), 'and the repair is reported');

  const weird = parseDoc(doc({ body: [{ id: 'x', kind: 'marquee', text: 'hi' }] }));
  ok(weird.ok && weird.doc.body[0].kind === 'para', 'an unknown block kind reads as a paragraph');

  const orphan = parseDoc(doc({
    body: [{ id: 'p1', kind: 'para', text: 'Hello world.', notes: [{ id: 'gone', at: 5 }] }],
    footnotes: {},
  }));
  ok(orphan.ok && !orphan.doc.body[0].notes,
     'a footnote reference with no note behind it is dropped, and the text kept');

  const overflow = parseDoc(doc({
    body: [{ id: 'p1', kind: 'para', text: 'short', marks: [{ t: 'b', from: 0, to: 999 }] }],
  }));
  ok(overflow.ok && overflow.doc.body[0].marks![0].to === 5, 'marks past the end are clamped');
}

H('unknown fields survive — format additivity (PLATFORM §3)');
{
  const r = parseDoc(doc({ somethingNewer: { a: 1 }, body: [{ id: 'p1', kind: 'para', text: 'x' }] }));
  ok(r.ok && J((r.doc as Record<string, unknown>).somethingNewer) === J({ a: 1 }),
     'a field this build does not know is preserved, not dropped');
}

H('marks and footnote anchors move together');
{
  const b: Block = {
    id: 'p1', kind: 'para',
    text: 'Payment is due within 30 days of invoice, without set-off.',
    marks: [{ t: 'b', from: 22, to: 29 }],                    // "30 days"
    notes: [{ id: 'n1', at: 58 }],                            // after the full stop
  };
  // counsel rewrites the term: "30 days" → "sixty (60) calendar days"
  const at = b.text.indexOf('30 days');
  const next = spliceText(b, at, '30 days'.length, 'sixty (60) calendar days');

  ok(next.text.includes('sixty (60) calendar days'), 'the text is replaced');
  const mark = next.marks![0];
  ok(next.text.slice(mark.from, mark.to) === 'sixty (60) calendar days',
     `the bold still covers the term it was put on (“${next.text.slice(mark.from, mark.to)}”)`);
  ok(next.notes![0].at === next.text.length,
     'the footnote anchor moved with the text after it, and still sits at the end');

  const before = spliceText(b, 0, 7, 'Fees');                 // edit BEFORE both
  ok(before.marks![0].from === 22 - 3, 'an earlier edit shifts the mark by the delta');
  ok(before.notes![0].at === 58 - 3, 'and shifts the anchor by the same delta');

  const wipe = spliceText(b, 22, 7, '');                      // delete the marked words
  ok(!wipe.marks, 'a mark whose text is deleted is dropped, not left dangling');

  const inside: Block = { ...b, notes: [{ id: 'n1', at: 24 }] };  // anchor INSIDE "30 days"
  ok(!spliceText(inside, 22, 7, 'sixty').notes,
     'an anchor inside deleted text is dropped rather than landing mid-word');
}

H('odds and ends');
{
  const d = emptyDoc();
  ok(d.docId && d.body.length === 1 && d.format === FORMAT, 'emptyDoc is well formed');
  ok(emptyDoc().docId !== emptyDoc().docId, 'each new document gets its own identity');
  const r = parseDoc(doc({ body: [
    { id: 'a', kind: 'h2', text: 'Heading' }, { id: 'b', kind: 'para', text: 'two words' }] }));
  ok(r.ok && wordCount(r.doc) === 3, 'word count counts across blocks');
  ok(r.ok && plainText(r.doc) === 'Heading\ntwo words', 'plain text joins blocks with newlines');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
