#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type find and replace.  node scripts/test-type-find.ts
//
// Search and replace are PURE FUNCTIONS over a document, and that is the whole
// reason this rig can exist without a browser. The panel is chrome around
// these four: matchesInText, findMatches, replaceAll, nextFrom.
//
// What this exists to prevent, in order of how much it would cost:
//
//   1. A REPLACE THAT MOVES TEXT AND NOT ITS MARKS. Marks and footnote anchors
//      are offsets into the block's text; a replacement of a different length
//      shifts every one of them. That arithmetic lives in model.spliceText and
//      is REUSED here — these checks are what proves it is actually reused,
//      because a private copy would pass a "the text changed" test and fail
//      these.
//   2. Overlapping matches. "aa" in "aaaa" is two matches, not three: three
//      would mean replacing text a previous replacement had already removed.
//   3. Case folding that changes the LENGTH of the haystack ('İ'), which makes
//      every offset after it address the wrong character.
//   4. A search that does not see list items or table cells. They are ordinary
//      blocks, so this is free — and a regression here would be silent, which
//      is why it is asserted rather than assumed.

import { matchesInText, findMatches, replaceAll, replaceMatch, nextFrom } from '../type/src/find.ts';
import { emptyDoc, spliceText, type Block } from '../type/src/model.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);

const b = (id: string, text: string, extra: Partial<Block> = {}): Block =>
  ({ id, kind: 'para', text, ...extra });

const spans = (text: string, q: string, o = {}) =>
  matchesInText(text, q, o).map(([f, t]) => text.slice(f, t)).join('|');

H('finding');
{
  ok(spans('the cat sat on the mat', 'at') === 'at|at|at', 'every occurrence, in order');
  ok(matchesInText('the cat sat', 'at')[0][0] === 5, 'offsets are into the block text');
  ok(matchesInText('nothing here', 'zebra').length === 0, 'a miss is an empty list');
  ok(matchesInText('anything', '').length === 0, 'an empty query matches nothing, not everything');
}

H('overlaps are never reported');
{
  // three would be a bug with teeth: replacing them in turn splices text the
  // previous replacement already removed
  ok(matchesInText('aaaa', 'aa').length === 2, '"aa" in "aaaa" is two matches');
  ok(spans('aaaaa', 'aa') === 'aa|aa', 'and the odd character is left over');
}

H('match case');
{
  ok(spans('Cat cat CAT', 'cat') === 'Cat|cat|CAT', 'off by default: case is ignored');
  ok(spans('Cat cat CAT', 'cat', { matchCase: true }) === 'cat', 'on: only the exact spelling');
  ok(spans('Cat cat CAT', 'CAT', { matchCase: true }) === 'CAT', 'and it is not a one-way fold');
}

H('case folding never moves an offset');
{
  // 'İ'.toLowerCase() is TWO characters. A lowercased haystack would then be
  // longer than the text it came from and every later offset would be wrong —
  // which, followed by a replace, splices into the middle of a word.
  const text = 'İstanbul is a city';
  for (const [from, to] of matchesInText(text, 'city')) {
    ok(text.slice(from, to) === 'city', `the offset still addresses the match (${from}..${to})`);
  }
  const long = 'aİa cat';
  ok(spans(long, 'cat') === 'cat', 'a length-changing fold earlier in the line does not shift a later match');
}

H('whole word');
{
  ok(spans('cat catalog concat cat.', 'cat') === 'cat|cat|cat|cat', 'off: substrings count');
  ok(matchesInText('cat catalog concat cat.', 'cat', { wholeWord: true }).length === 2,
     'on: only the standalone words');
  const t2 = 'cat catalog concat cat.';
  const m = matchesInText(t2, 'cat', { wholeWord: true });
  ok(m[0][0] === 0 && m[1][0] === 19, 'the first word and the one before the full stop');
  ok(matchesInText('re-cat', 'cat', { wholeWord: true }).length === 1, 'a hyphen is a boundary');
  ok(matchesInText('cat9', 'cat', { wholeWord: true }).length === 0, 'a digit is not');
  ok(matchesInText('naïve', 'naï', { wholeWord: true }).length === 0, 'and neither is an accented letter');
}

H('every block is searched — including list items and table cells');
{
  const body: Block[] = [
    b('p1', 'the term appears here'),
    b('li1', 'and in a list item: term', { kind: 'ul' }),
    b('li2', 'nested too: term', { kind: 'ul', level: 2 }),
    b('c1', 'term', { kind: 'cell', cell: { table: 'tb', cols: 2, head: true } }),
    b('c2', 'and term again', { kind: 'cell', cell: { table: 'tb', cols: 2 } }),
    b('h', 'TERM as a heading', { kind: 'h2' }),
  ];
  const found = findMatches(body, 'term');
  ok(found.length === 6, `six matches across paragraph, list, table and heading (${found.length})`);
  ok(found.map(m => m.id).join(',') === 'p1,li1,li2,c1,c2,h', 'reported in document order');
  ok(found[0].block === 0 && found[5].block === 5, 'each match carries its block index, for stepping');
  ok(findMatches(body, 'term', { matchCase: true }).length === 5, 'the heading drops out under match case');
}

H('a replace keeps marks pointing at the same words');
{
  //  "Payment is due in 30 days."  bold over "due in" (11..17), a note at 26
  const src = b('p', 'Payment is due in 30 days.', {
    marks: [{ t: 'b', from: 11, to: 17 }],
    notes: [{ id: 'n1', at: 26 }],
  });
  const m = findMatches([src], '30')[0];
  const out = replaceMatch(src, m, 'sixty');            // 2 chars → 5
  ok(out.text === 'Payment is due in sixty days.', out.text);
  ok(out.marks![0].from === 11 && out.marks![0].to === 17, 'a mark BEFORE the edit does not move');
  ok(out.notes![0].at === 29, 'a footnote anchor after the edit moves by the delta (+3)');
  ok(out.text.slice(out.marks![0].from, out.marks![0].to) === 'due in',
     'and the mark still covers the words it was put on');

  // the same edit, with the mark AFTER the replacement
  const src2 = b('p', 'Payment is due in 30 days.', { marks: [{ t: 'i', from: 21, to: 25 }] });
  const out2 = replaceMatch(src2, findMatches([src2], '30')[0], 'sixty');
  ok(out2.text.slice(out2.marks![0].from, out2.marks![0].to) === 'days',
     'a mark after the edit follows its own text');

  // shortening, too — the delta is negative and everything must come back
  const src3 = b('p', 'Payment is due in sixty days.', {
    marks: [{ t: 'b', from: 24, to: 28 }], notes: [{ id: 'n1', at: 29 }],
  });
  const out3 = replaceMatch(src3, findMatches([src3], 'sixty')[0], '30');
  ok(out3.text === 'Payment is due in 30 days.', out3.text);
  ok(out3.text.slice(out3.marks![0].from, out3.marks![0].to) === 'days', 'a shorter replacement too');
  ok(out3.notes![0].at === 26, 'and the note comes back with it');
}

H('replace does no offset arithmetic of its own');
{
  // the point of the reuse: replaceMatch must be spliceText, exactly
  const src = b('p', 'one two three', { marks: [{ t: 'u', from: 4, to: 7 }], notes: [{ id: 'n', at: 8 }] });
  const m = findMatches([src], 'two')[0];
  const mine = replaceMatch(src, m, 'ii');
  const theirs = spliceText(src, m.from, m.to - m.from, 'ii');
  ok(JSON.stringify(mine) === JSON.stringify(theirs), 'byte-identical to model.spliceText');
}

H('replace all');
{
  const body: Block[] = [
    b('p1', 'the term, the term'),
    b('p2', 'no hits here'),
    b('li', 'a term in a list', { kind: 'ul' }),
    b('c', 'term', { kind: 'cell', cell: { table: 't', cols: 1 } }),
  ];
  const r = replaceAll(body, 'term', 'clause');
  ok(r.count === 4, `four replacements (${r.count})`);
  ok(r.body[0].text === 'the clause, the clause', 'both hits in one block, and the second offset is right');
  ok(r.body[2].text === 'a clause in a list', 'the list item too');
  ok(r.body[3].text === 'clause', 'and the table cell');
  ok(r.body[1] === body[1], 'a block with no match is the SAME object — the snapshot stays cheap');
  ok(body[0].text === 'the term, the term', 'and the input is untouched: the function is pure');
}

H('replace all applies back to front, so a length change cannot corrupt later hits');
{
  const src = b('p', 'x term y term z', { marks: [{ t: 'b', from: 14, to: 15 }], notes: [{ id: 'n', at: 15 }] });
  const r = replaceAll([src], 'term', 'a');           // shrinks by 3, twice
  ok(r.body[0].text === 'x a y a z', r.body[0].text);
  ok(r.body[0].text.slice(r.body[0].marks![0].from, r.body[0].marks![0].to) === 'z',
     'the mark on the last character survives both replacements');
  ok(r.body[0].notes![0].at === 9, 'and so does the note anchored at the end');

  const grow = replaceAll([b('p', 'a b a b')], 'b', 'LONGER');
  ok(grow.body[0].text === 'a LONGER a LONGER', grow.body[0].text);
}

H('a replacement that contains the query does not run away');
{
  const r = replaceAll([b('p', 'cat cat')], 'cat', 'cats');
  ok(r.body[0].text === 'cats cats' && r.count === 2, 'each match is replaced exactly once');
  // and stepping past it is how the panel avoids re-matching what it wrote
  const after = findMatches(r.body, 'cat');
  ok(nextFrom(after, 0, 0 + 'cats'.length) === 1, 'the cursor lands on the NEXT match, not the new one');
  ok(nextFrom(after, 0, 999) === 0, 'past the end it wraps to the top');
  ok(nextFrom([], 0, 0) === -1, 'with nothing found there is nowhere to go');
}

H('replace all is one undo step');
{
  // the store is the thing under test here: ONE commit, so ONE ⌘Z, no matter
  // how many matches were swept
  const doc = emptyDoc();
  doc.body = [b('p1', 'term term term'), b('p2', 'term'), b('p3', 'nothing')];
  const { Store } = await import('../type/src/store.ts');
  const store = new Store(doc);
  const before = store.undoDepth;
  store.commit(d => { d.body = replaceAll(d.body, 'term', 'clause').body; });
  ok(store.undoDepth === before + 1, `four replacements cost one undo step (${store.undoDepth - before})`);
  ok(store.doc.body[0].text === 'clause clause clause', 'and they all landed');
  store.undo();
  ok(store.doc.body[0].text === 'term term term' && store.doc.body[1].text === 'term',
     'one ⌘Z brings the whole document back');
}

H('the panel registered itself');
{
  const { panels, tools, keys } = await import('../type/src/features.ts');
  ok(panels().some(p => p.id === 'find'), 'a Find panel');
  ok(panels().find(p => p.id === 'find')!.label === 'Find', 'whose label is read late, through t()');
  ok(tools('review').some(t => t.id === 'find'), 'a toolbar button in the review group');
  ok(keys().some(k => k.key === 'f' && k.mod === true), 'and ⌘F');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
