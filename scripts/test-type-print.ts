#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type paginated-output rig.  node scripts/test-type-print.ts
//
// `buildPrintDocument` is pure: document + metrics in, HTML out. So the
// structural promises are checkable without a browser, and they are the ones
// the design leans on:
//
//   · the printed page count is the one the editor computed — if print
//     re-paginates, "page 14 paragraph 3" stops meaning anything, which is the
//     entire reason a document like this is exchanged as PDF at all;
//   · every page shows a WINDOW onto one shared flow, offset by that page's
//     start. Slicing content per page would re-lay-out each fragment, and
//     re-layout is exactly how printed pagination drifts from the screen;
//   · a footnote appears on the page its reference lands on, numbered in
//     document order;
//   · the page box is sized from the DOCUMENT's geometry, so a document set to
//     A4 prints A4.
//
// Line-level fidelity (that the print flow breaks lines identically to the
// editor) needs real layout and is verified in the browser: measured at zero
// drift across 222 lines and 8 pages.

import { buildPrintDocument } from '../type/src/print.ts';
import { emptyDoc, LETTER, type TypeDoc } from '../type/src/model.ts';
import type { Metrics } from '../type/src/paginate.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);

function fixture(): { doc: TypeDoc; metrics: Metrics } {
  const doc = emptyDoc();
  doc.title = 'Master Services Agreement';
  doc.body = [
    { id: 'h1', kind: 'h1', text: 'Master Services Agreement' },
    { id: 'p1', kind: 'para', text: 'The parties agree as follows.',
      notes: [{ id: 'n1', at: 28 }] },
    { id: 'p2', kind: 'para', text: 'Payment is due within 30 days.',
      marks: [{ t: 'b', from: 22, to: 29 }], notes: [{ id: 'n2', at: 30 }] },
    { id: 'p3', kind: 'para', text: 'Governed by the laws of Sweden.' },
  ];
  doc.footnotes = { n1: 'The first note.', n2: 'The second note, a little longer.' };
  const metrics: Metrics = {
    ms: 0,
    pages: [
      { n: 1, start: 0, end: 700, notes: ['n1'], reserved: 30 },
      { n: 2, start: 700, end: 1400, notes: ['n2'], reserved: 34 },
      { n: 3, start: 1400, end: Infinity, notes: [], reserved: 0 },
    ],
  };
  return { doc, metrics };
}

H('the printed pagination is the computed one');
{
  const { doc, metrics } = fixture();
  const html = buildPrintDocument(doc, metrics);
  const pages = html.match(/class="t-page"/g)?.length ?? 0;
  ok(pages === metrics.pages.length, `one page box per computed page (${pages} of ${metrics.pages.length})`);

  // each page offsets the SAME flow rather than slicing it
  const offsets = [...html.matchAll(/class="t-body" style="margin-top:(-?\d+)px"/g)].map(m => +m[1]);
  ok(offsets.length === metrics.pages.length, 'every page carries the flow');
  ok(offsets.join() === metrics.pages.map(p => -p.start).join(),
     `each page is offset by its own start (${offsets.join(', ')})`);

  // the window is the page's real extent, so it cannot cut a line in half
  const heights = [...html.matchAll(/class="t-flow" style="height:([\d.]+)px/g)].map(m => +m[1]);
  ok(heights[0] === 700 && heights[1] === 700,
     `interior pages are clipped at their break, not a nominal height (${heights[0]}, ${heights[1]})`);
  const contentH = LETTER.height - LETTER.marginTop - LETTER.marginBottom;
  ok(heights[2] === contentH - 0, `the last page has no break, so it runs to the content height (${heights[2]})`);
}

H('footnotes go to the foot of the page their reference lands on');
{
  const { doc, metrics } = fixture();
  const html = buildPrintDocument(doc, metrics);
  const sections = html.split('class="t-page"').slice(1);
  ok(sections[0].includes('The first note.'), 'page 1 carries note 1');
  ok(sections[1].includes('The second note'), 'page 2 carries note 2');
  ok(!sections[2].includes('t-fn'), 'page 3 has no note area, because no reference lands there');
  ok(!/sidenote/.test(html), 'the editing view’s sidenotes do not leak into print');
  // numbering is derived in document order, not stored
  ok(/<b>1<\/b>The first note/.test(html) && /<b>2<\/b>The second note/.test(html),
     'notes are numbered in document order');
}

H('the page box comes from the document');
{
  const { doc, metrics } = fixture();
  const a4 = { ...doc, page: { width: 794, height: 1123, marginX: 96, marginTop: 96, marginBottom: 96 } };
  const html = buildPrintDocument(a4 as TypeDoc, metrics);
  ok(/@page \{ size: 794px 1123px/.test(html), 'an A4 document prints A4');
  ok(/width: 794px; height: 1123px/.test(html), 'and the page box matches');
  const letter = buildPrintDocument(doc, metrics);
  ok(/@page \{ size: 816px 1056px/.test(letter), 'a Letter document prints Letter');
}

H('running head and page numbers');
{
  const { doc, metrics } = fixture();
  const plain = buildPrintDocument(doc, metrics);
  ok((plain.match(/t-run head/g) ?? []).length === 3, 'a running head on every page');
  ok(plain.includes('>Master Services Agreement</div>'), 'the head defaults to the document title');
  ok((plain.match(/t-run foot/g) ?? []).length === 3, 'a page number on every page');

  const custom = buildPrintDocument(doc, metrics, { header: 'Draft — privileged', pageNumbers: false });
  ok(custom.includes('Draft — privileged'), 'the head can be overridden');
  ok(!/t-run foot/.test(custom), 'page numbers can be turned off');

  const bare = buildPrintDocument(doc, metrics, { bareFirstPage: true });
  const first = bare.split('class="t-page"')[1];
  ok(!first.includes('t-run head'), 'a bare first page carries no running head');
  ok(bare.split('class="t-page"')[2].includes('t-run head'), 'but page 2 still does');
}

H('content is escaped, and formatting survives');
{
  const { doc, metrics } = fixture();
  doc.body[3].text = 'Clause <script>alert(1)</script> & "quoted".';
  doc.title = 'A & B <Ltd>';
  const html = buildPrintDocument(doc, metrics);
  ok(!/<script>alert/.test(html), 'author text cannot introduce a script tag');
  ok(html.includes('&amp;') && html.includes('&lt;'), 'ampersands and angle brackets are escaped');
  ok(/<title>A &amp; B &lt;Ltd&gt;<\/title>/.test(html), 'the title is escaped too');
  ok(/<strong>30 days<\/strong>/.test(html), 'marks render as formatting, from the same renderer the editor uses');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
