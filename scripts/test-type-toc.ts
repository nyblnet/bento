#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type section numbering + table of contents.  node scripts/test-type-toc.ts
//
// Everything here is a PURE function over (document, metrics) — that is the
// whole design claim. A number or a page reference that reached the document
// JSON would be wrong the moment the next heading was typed, so this rig checks
// the derivation AND checks that the derivation writes nothing.
//
// The interesting cases are the ones that renumber: an insertion in the middle,
// a heading that opts out, and an h3 with no h2 above it — which numbers 1.0.1,
// because a number's depth must equal its heading's level and because a
// silently promoted 1.1 hides a hole in the author's outline.

import {
  headings, sectionNumbers, buildToc, tocFor, pageOfY, headingPages,
  sectionSettings, setNumbered, tocEntriesHtml, sectionNumberHtml, decorate,
  TOC_KIND, hasToc,
} from '../type/src/toc.ts';
import { emptyDoc, type Block, type BlockKind, type TypeDoc } from '../type/src/model.ts';
import type { Metrics, Page } from '../type/src/paginate.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);

const b = (kind: string, text: string, extra: Partial<Block> = {}): Block =>
  ({ id: `${kind}-${text.toLowerCase().replace(/\W+/g, '-')}`, kind: kind as BlockKind, text, ...extra });

// Numbering is OPT-IN — absent means off, because the documents this app opens
// mostly carry their numbers in the heading text already ("1. Scope of Work"),
// and numbering those again renders "1.1 1. Scope of Work". These fixtures
// exercise the numbering machinery, so they turn it on; the default itself is
// asserted separately below.
const docOf = (body: Block[]): TypeDoc =>
  ({ ...emptyDoc(), body, sections: { numbered: true } } as TypeDoc);

/** '1.1 Scope' for every heading, so an expectation reads like the page. */
const numbering = (doc: TypeDoc) =>
  headings(doc).map(h => `${h.number ?? '—'} ${h.text}`).join(' | ');

const page = (n: number, start: number, end: number): Page =>
  ({ n, start, end, notes: [], reserved: 0 });
const metricsOf = (...pages: Page[]): Metrics => ({ pages, ms: 0 });

H('h1 / h2 / h3 number as 1, 1.1, 1.2.3');
{
  const doc = docOf([
    b('h1', 'One'), b('para', 'text'),
    b('h2', 'One A'), b('h3', 'One A i'), b('h3', 'One A ii'),
    b('h2', 'One B'),
    b('h1', 'Two'), b('h2', 'Two A'), b('h3', 'Two A i'),
  ]);
  ok(numbering(doc) ===
     '1 One | 1.1 One A | 1.1.1 One A i | 1.1.2 One A ii | 1.2 One B | 2 Two | 2.1 Two A | 2.1.1 Two A i',
     numbering(doc));
  ok(sectionNumbers(doc).get('h3-two-a-i') === '2.1.1', 'the map is keyed by block id');
  ok(sectionNumbers(doc).size === 8, 'every heading has a number and nothing else does');
}

H('a deeper level resets when a shallower one advances');
{
  const doc = docOf([b('h1', 'A'), b('h2', 'A1'), b('h3', 'A1a'), b('h2', 'A2'), b('h3', 'A2a')]);
  ok(numbering(doc) === '1 A | 1.1 A1 | 1.1.1 A1a | 1.2 A2 | 1.2.1 A2a', numbering(doc));
}

H('a SKIPPED level numbers with a zero, and is not promoted');
{
  // an h3 with no h2 above it: the h2 counter has never advanced, so it reads
  // 0. The depth of the number still equals the level of the heading, which is
  // the invariant that makes numbers comparable — and the hole is visible.
  const doc = docOf([b('h1', 'A'), b('h3', 'Orphan'), b('h2', 'A1'), b('h3', 'A1a')]);
  ok(numbering(doc) === '1 A | 1.0.1 Orphan | 1.1 A1 | 1.1.1 A1a', numbering(doc));

  // LEADING zeros are dropped, because they are not a hole: a document that
  // never uses h1 (its title is the h1, or it has none) does not have a level
  // one to be missing. This is the case a role:'title' heading creates, and it
  // read '0.1 Scope' until the rig caught it.
  const noTop = docOf([b('h2', 'A'), b('h3', 'A1'), b('h2', 'B')]);
  ok(numbering(noTop) === '1 A | 1.1 A1 | 2 B', numbering(noTop));

  // filling the gap in later is an ordinary renumber
  const filled = docOf([b('h1', 'A'), b('h2', 'New'), b('h3', 'Orphan')]);
  ok(sectionNumbers(filled).get('h3-orphan') === '1.1.1', '1.0.1 becomes 1.1.1 once the h2 exists');
}

H('inserting a heading renumbers everything after it');
{
  const before = docOf([b('h1', 'A'), b('h2', 'A1'), b('h2', 'A2'), b('h1', 'B'), b('h2', 'B1')]);
  ok(numbering(before) === '1 A | 1.1 A1 | 1.2 A2 | 2 B | 2.1 B1', numbering(before));

  const after = docOf([...before.body]);
  after.body.splice(2, 0, b('h2', 'Inserted'));
  ok(numbering(after) === '1 A | 1.1 A1 | 1.2 Inserted | 1.3 A2 | 2 B | 2.1 B1', numbering(after));
  // the point of deriving: the SAME blocks carry different numbers now
  ok(sectionNumbers(before).get('h2-a2') === '1.2' && sectionNumbers(after).get('h2-a2') === '1.3',
     'a block that did not change got a new number');
}

H('roles decide what is numbered and what is listed');
{
  const doc = docOf([
    b('h1', 'The Deed', { role: 'title' }),
    b('h2', 'Preamble', { role: 'unnumbered' }),
    b('h2', 'Scope'),
    b('h2', 'Schedule', { role: 'unlisted' }),
    b('h2', 'Fees'),
  ]);
  // the title never opens level 1, so its sections are 1, 2, 3 — not 0.1, 0.2
  ok(numbering(doc) === '— The Deed | — Preamble | 1 Scope | 2 Schedule | 3 Fees', numbering(doc));
  ok(headings(doc).filter(h => h.listed).map(h => h.text).join(',') === 'Preamble,Scope,Fees',
     'title and unlisted headings stay out of the contents');
  // an opted-out heading is outside the sequence, not a gap in it
  ok(buildToc(doc).map(e => `${e.number ?? '—'}`).join(' ') === '— 1 3',
     'the numbers its neighbours carry are unaffected by the exclusion');
  ok(headings(doc)[0].number === undefined, 'a document title is not section 1 of itself');
}

H('the document-level switch turns numbering off');
{
  const doc = docOf([b('h1', 'A'), b('h2', 'A1')]);
  ok(sectionSettings(doc).numbered, 'absent means on — numbering is automatic by default');
  setNumbered(doc, false);
  ok(numbering(doc) === '— A | — A1', numbering(doc));
  ok(buildToc(doc).length === 2, 'the contents still lists them, without numbers');
  setNumbered(doc, true);
  ok(numbering(doc) === '1 A | 1.1 A1', 'and back on again');
  ok(JSON.stringify(doc.sections) === '{"numbered":true}', 'the switch is the ONLY thing stored');
}

H('a TOC built against metrics gives the right page per heading');
{
  const doc = docOf([b('h1', 'A'), b('h2', 'A1'), b('h2', 'A2'), b('h2', 'A3')]);
  const metrics = metricsOf(page(1, 0, 800), page(2, 800, 1600), page(3, 1600, Infinity));
  const tops = new Map([['h1-a', 0], ['h2-a1', 400], ['h2-a2', 800], ['h2-a3', 2000]]);

  ok(pageOfY(metrics.pages, 0) === 1 && pageOfY(metrics.pages, 799) === 1, 'page one');
  ok(pageOfY(metrics.pages, 800) === 2, 'a heading exactly on a break is on the NEW page');
  ok(pageOfY(metrics.pages, 5000) === 3, 'the last page has no end and swallows the rest');
  ok(pageOfY(metrics.pages, -50) === undefined, 'nothing above the first line is on a page');

  const pages = headingPages(metrics, tops);
  ok([...pages.values()].join(',') === '1,1,2,3', `pages ${[...pages.values()].join(',')}`);

  const entries = tocFor(doc, metrics, tops);
  ok(entries.map(e => `${e.number} ${e.text} ${e.page}`).join(' | ') ===
     '1 A 1 | 1.1 A1 1 | 1.2 A2 2 | 1.3 A3 3',
     entries.map(e => `${e.number} ${e.text} ${e.page}`).join(' | '));
  ok(buildToc(doc).every(e => e.page === undefined),
     'built with no metrics, an entry simply has no page yet');
  ok(entries.every(e => e.level === (e.number!.includes('.') ? 2 : 1)), 'level comes from the kind');
}

H('an empty document, and one with no headings');
{
  const empty = emptyDoc();
  ok(headings(empty).length === 0 && buildToc(empty).length === 0, 'no headings, no entries');
  ok(tocEntriesHtml(buildToc(empty)) === '', 'and no markup at all — an empty list is not a blank row');
  ok(hasToc(empty) === false, 'a fresh document has no contents block');

  const prose = docOf([b('para', 'one'), b('quote', 'two'), b('ul', 'three')]);
  ok(buildToc(prose).length === 0, 'paragraphs, quotes and list items are not headings');
  const metrics = metricsOf(page(1, 0, Infinity));
  ok(tocFor(prose, metrics, new Map()).length === 0, 'and metrics change nothing about that');
}

H('DERIVED, NEVER STORED');
{
  const doc = docOf([
    b('h1', 'A'), { id: 'toc-1', kind: TOC_KIND, text: 'Contents' }, b('h2', 'A1'),
  ]);
  const before = JSON.stringify(doc);
  const metrics = metricsOf(page(1, 0, 800), page(2, 800, Infinity));
  const entries = tocFor(doc, metrics, new Map([['h1-a', 0], ['h2-a1', 900]]));
  const html = tocEntriesHtml(entries) + sectionNumberHtml('1.1') + JSON.stringify(headings(doc));
  ok(html.length > 0, 'the whole derivation ran');
  ok(JSON.stringify(doc) === before, 'and not one byte of the document changed');

  // the redline diffs a block's plain text: the contents block's text is its
  // HEADING, so repagination can never make a review noisy
  ok(doc.body[1].text === 'Contents', 'the TOC block still stores only its heading');
  const bodyJson = JSON.stringify(doc.body);
  ok(!/"(number|page|sections)"/.test(bodyJson) && !bodyJson.includes('1.1'),
     'no number and no page reference is anywhere in the body JSON');

  // the injected markup is an ATOM (data-derived), which the core's atom
  // predicate skips — that is what stops it being read back into the model
  ok(tocEntriesHtml(entries).startsWith('<span class="t-toc" data-derived'), 'entries are one atom');
  ok(sectionNumberHtml('1.1').includes('data-derived'), 'so is a section number');
  ok(!/data-derived[^>]*>\s/.test(sectionNumberHtml('1.1')),
     'with no stray whitespace beside it — a space there WOULD be a character');
}

H('the decorator, which is what the renderer calls');
{
  const doc = docOf([
    b('h1', 'A'), { id: 'toc-1', kind: TOC_KIND, text: 'Contents' }, b('h2', 'A<b>1</b>'),
  ]);
  ok(decorate(doc, doc.body[0], 'A') === sectionNumberHtml('1') + 'A', 'a heading gains its number in front');
  ok(decorate(doc, b('para', 'nothing'), 'nothing') === null, 'a paragraph is left entirely alone');

  const toc = decorate(doc, doc.body[1], 'Contents')!;
  ok(toc.startsWith('Contents'), 'the TOC keeps its own heading as real, editable text');
  ok(toc.includes(`data-goto="${doc.body[2].id}"`), 'and carries an anchor per entry, for click-to-scroll');
  ok(toc.includes('&lt;b&gt;'), 'entry text is escaped — a heading is plain text, not markup');
  ok(!toc.includes('#'), 'no literal colour in the derived markup; colour comes from the stylesheet');
  ok(/flex:0 0 2\.4em/.test(toc),
     'the page column has a FIXED width, so filling pages in later moves nothing');

  setNumbered(doc, false);
  ok(decorate(doc, doc.body[0], 'A') === null, 'with numbering off a heading is not touched at all');
}

H('automatic numbering is OFF until asked for');
{
  // The risk is asymmetric. On by default visibly corrupts an existing
  // document — the starter contract renders "1.1 1. Scope of Work" — while off
  // by default is a feature somebody has to find. Verified on that document,
  // which is exactly the common case: headings that already carry numbers.
  const plain = { ...emptyDoc(), body: [b('h1', '1. Scope of Work'), b('h2', '1.1 Fees')] } as TypeDoc;
  ok(headings(plain).every(h => h.number === undefined),
     'a document that says nothing about numbering gets no numbers');
  const on = { ...plain, sections: { numbered: true } } as TypeDoc;
  ok(headings(on).some(h => h.number !== undefined), 'and asking for them turns them on');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
