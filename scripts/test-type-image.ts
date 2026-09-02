#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type pictures.  node scripts/test-type-image.ts
//
// An image is the first block that is not text, and that makes it the first one
// pagination cannot see: paginate.ts measures LINE BOXES through a TreeWalker
// over text nodes, so a picture contributed height nobody had counted. It now
// carries `data-atomic` and is measured as one box — which is not an
// approximation but the truth, since a picture cannot be split across a page.
//
// The parts that can be tested without a browser are here: what may be a
// source, and what the parser does with a picture it cannot use. The layout
// behaviour is verified in the browser and the numbers are in the commit.

import { parseDoc, emptyDoc, SAFE_IMG, IMAGE_EMBED_BUDGET } from '../type/src/model.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);

H('what may be a source');
{
  // A document is untrusted input and this string goes straight into an <img>.
  const good = [
    'data:image/png;base64,iVBORw0KGgo=',
    'data:image/jpeg;base64,/9j/4AAQ',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    // no `;` at all: a data URI only has one when it carries a parameter such
    // as ;base64. This form is valid, common, and WAS REFUSED — the pattern
    // required the semicolon, so every unencoded SVG was silently dropped.
    'data:image/svg+xml,%3Csvg%3E%3C/svg%3E',
    'https://example.com/a.png',
    'http://example.com/a.png',
    './beside.png', '../up.png', '/root.png',
  ];
  for (const s of good) ok(SAFE_IMG.test(s), `accepted: ${s.slice(0, 42)}`);

  const bad = [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:image/png',                       // no separator, so not a payload
    'vbscript:msgbox',
    'file:///etc/passwd',
    ' javascript:alert(1)',                 // leading space must not slip past
  ];
  for (const s of bad) ok(!SAFE_IMG.test(s), `refused: ${s.slice(0, 42)}`);
}

H('the parser repairs a picture it cannot use');
{
  const doc = emptyDoc();
  const r = parseDoc(JSON.stringify({ ...doc, body: [
    { id: 'good', kind: 'image', text: '', image: { src: 'https://example.com/a.png', alt: 'A chart', w: 0.5 } },
    { id: 'nosrc', kind: 'image', text: '', image: { alt: 'The Q3 revenue chart' } },
    { id: 'evil', kind: 'image', text: '', image: { src: 'javascript:alert(1)', alt: 'nope' } },
    { id: 'wide', kind: 'image', text: '', image: { src: 'https://example.com/b.png', w: 9 } },
  ] }));
  ok(r.ok, 'it still parses');
  if (r.ok) {
    ok(r.doc.body[0].kind === 'image' && r.doc.body[0].image?.w === 0.5, 'a good picture survives with its width');
    ok(r.doc.body[1].kind === 'para', 'a picture with no source becomes a paragraph');
    ok(r.doc.body[1].text === 'The Q3 revenue chart',
       'and keeps its alt text as the words — a vanished figure is the worse outcome');
    ok(r.doc.body[2].kind === 'para', 'a javascript: source is refused, not sanitised into the document');
    ok(r.doc.body[3].image?.w === undefined, 'a nonsense width is dropped rather than clamped to a guess');
    ok(r.repaired.length >= 3, `and every repair is reported (${r.repaired.length})`);
  }
}

H('the embed budget is a real number, not a vibe');
{
  ok(IMAGE_EMBED_BUDGET > 0 && IMAGE_EMBED_BUDGET <= 16 * 1024 * 1024,
     `a sane ceiling for a self-contained file (${(IMAGE_EMBED_BUDGET / 1024 / 1024).toFixed(1)} MB)`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
