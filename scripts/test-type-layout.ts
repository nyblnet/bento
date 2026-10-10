#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type paragraph-layout and page-setup rig.  node scripts/test-type-layout.ts
//
// The geometry and the property→CSS mapping in type/src/layout.ts are pure, and
// they are the half that has to be right: a page is 794px wide or the printed
// A4 is wrong, and nobody finds that out until it is on paper. So everything
// below runs without a browser.
//
// What it holds down, in the order it burned:
//
//   · A4 and Letter convert at 96px to the inch, because that is what a CSS px
//     IS — and print.ts already emits @page in px.
//   · turning the page swaps width and height and nothing else.
//   · margins that leave no text area are REJECTED. Let through, they reach
//     pagination as a negative page body, where the break loop places a page
//     every zero pixels until its 2000-iteration guard fires.
//   · a property a paragraph does not carry means THE DOCUMENT'S — so the
//     document can change its mind and every untouched paragraph follows.
//   · the CSS for each alignment, and the margin/padding pair that the
//     stylesheet's `p + p` hack forces space-before to override as a unit.
//   · with no keep hints anywhere, atomize/breakY reproduce the line-by-line
//     break paginate.ts does today, exactly. That is the condition for putting
//     them in the core loop at all.

import {
  PX_PER_IN, PX_PER_MM, PAPER, matchSize, orientationOf, withOrientation, withSize,
  margins, withMargins, contentBox, validatePage, unitFor, formatLen, parseLen,
  DOC_DEFAULTS, effective, docEffective, writeProps, blockStyle, docVars, pageVars,
  atomize, breakY, type PageGeom, type LineBox,
} from '../type/src/layout.ts';
import { emptyDoc, LETTER, type Block, type TypeDoc } from '../type/src/model.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);

const block = (id: string, extra: Record<string, unknown> = {}): Block =>
  ({ id, kind: 'para', text: `${id} text`, ...extra }) as Block;

H('paper sizes convert at 96px to the inch');
{
  ok(PX_PER_IN === 96, 'the inch is 96px, by the definition of a CSS px');
  ok(Math.abs(PX_PER_MM - 96 / 25.4) < 1e-12, 'and the millimetre follows from it');

  ok(PAPER.letter.width === 816 && PAPER.letter.height === 1056,
     `US Letter is 8.5×11in = ${PAPER.letter.width}×${PAPER.letter.height}px`);
  ok(PAPER.legal.width === 816 && PAPER.legal.height === 1344,
     `US Legal is 8.5×14in = ${PAPER.legal.width}×${PAPER.legal.height}px`);
  ok(PAPER.a4.width === 794 && PAPER.a4.height === 1123,
     `A4 is 210×297mm = ${PAPER.a4.width}×${PAPER.a4.height}px`);
  // the rounding is the only lossy step, and it must stay under a tenth of a mm
  const drift = Math.abs(PAPER.a4.width / PX_PER_MM - 210);
  ok(drift < 0.1, `rounding A4 to whole px costs ${drift.toFixed(3)}mm`);

  // the model's own default IS US Letter — if these disagree, "Letter" in the
  // dialog would silently be a custom size
  ok(LETTER.width === PAPER.letter.width && LETTER.height === PAPER.letter.height,
     'the model default is the same Letter this module offers');
  ok(matchSize(LETTER) === 'letter', 'and it is recognised as Letter, not custom');
  ok(matchSize({ ...LETTER, width: 500 }) === undefined, 'an odd page is custom');
}

H('orientation swaps width and height');
{
  const p = withSize(LETTER, 'a4');
  ok(orientationOf(p) === 'portrait', 'A4 portrait is taller than wide');
  const land = withOrientation(p, 'landscape');
  ok(land.width === p.height && land.height === p.width,
     `landscape A4 is ${land.width}×${land.height}`);
  ok(orientationOf(land) === 'landscape', 'and reads back as landscape');
  ok(matchSize(land) === 'a4', 'a turned page is still A4');
  ok(land.marginTop === p.marginTop && land.marginX === p.marginX,
     'turning the page leaves the margins alone');
  ok(withOrientation(land, 'landscape').width === land.width, 'turning it the way it already faces does nothing');
  // a custom sheet turns too — landscape is not a lookup
  const odd = withOrientation({ ...LETTER, width: 300, height: 500 }, 'landscape');
  ok(odd.width === 500 && odd.height === 300, 'a custom sheet turns as well');
  // choosing a size keeps the orientation you were in
  ok(orientationOf(withSize(land, 'legal')) === 'landscape', 'picking a size keeps the current orientation');
}

H('margins that leave no text area are rejected, not measured');
{
  ok(validatePage(LETTER).ok, 'US Letter with 104px margins is fine');
  const c = contentBox(LETTER);
  ok(c.width === 816 - 208 && c.height === 1056 - 208, `text area ${c.width}×${c.height}`);

  const noWidth = { ...LETTER, marginX: 410 };          // 820 > 816
  const v1 = validatePage(noWidth);
  ok(!v1.ok && v1.fault === 'no-width', 'side margins wider than the sheet are refused');
  ok(contentBox(noWidth).width < 0, 'and the measure they would have produced is NEGATIVE');

  const noHeight = validatePage({ ...LETTER, marginTop: 600, marginBottom: 600 });
  ok(!noHeight.ok && noHeight.fault === 'no-height', 'top and bottom margins that meet are refused');
  // the boundary: exactly one inch of text is allowed, a hair less is not
  const exact = { ...LETTER, marginX: (816 - 96) / 2 };
  ok(validatePage(exact).ok, 'exactly one inch of measure is allowed');
  ok(!validatePage({ ...exact, marginX: (816 - 95) / 2 }).ok, 'less than an inch is not');

  ok(!validatePage({ ...LETTER, width: 50, height: 50 }).ok, 'a stamp-sized sheet is refused');
  ok(!validatePage({ ...LETTER, width: 99999 }).ok, 'and so is a sheet no printer takes');
}

H('four margins, stored as the fewest fields that say it');
{
  const sym = withMargins(LETTER, { top: 96, bottom: 96, left: 72, right: 72 });
  ok(sym.marginX === 72, 'equal sides are stored as marginX alone');
  ok(sym.marginLeft === undefined && sym.marginRight === undefined,
     'so a symmetric page never needs a field older builds have not shipped');
  ok(margins(sym).left === 72 && margins(sym).right === 72, 'and read back as both sides');

  const bound = withMargins(LETTER, { top: 96, bottom: 96, left: 144, right: 72 });
  ok(bound.marginLeft === 144 && bound.marginRight === 72, 'a bound document stores both sides');
  ok(margins(bound).left === 144 && margins(bound).right === 72, 'and reads them back');
  ok(contentBox(bound).width === 816 - 216, 'the measure uses both, not twice one');
  // an older build reading only marginX must not overlap the text off the page
  ok(bound.marginX === 72, 'marginX stays as the narrower side, so an old build under-indents rather than clipping');
  const plain = { ...LETTER } as PageGeom;
  ok(margins(plain).left === LETTER.marginX, 'a page with no left/right falls back to marginX');
}

H('a property a paragraph does not carry is the document’s');
{
  const doc: TypeDoc = emptyDoc();
  const plain = block('p1');
  ok(effective(doc, plain).align === 'justify',
     'a paragraph with no align is justified — the built-in default, not a stored value');
  ok(!('align' in (plain as Record<string, unknown>)), 'and nothing was written to it to say so');
  ok(DOC_DEFAULTS.align === 'justify', 'justify stays the default: Knuth–Plass is the point');

  // the document changes its mind and the untouched paragraph follows
  (doc as { layout?: unknown }).layout = { align: 'left' };
  ok(effective(doc, plain).align === 'left', 'change the document and every untouched paragraph follows');
  ok(docEffective(doc).align === 'left', 'the document default reads back');
  ok(docEffective(doc).lh === DOC_DEFAULTS.lh, 'and what the document does not say is still built-in');

  // a paragraph that says something keeps saying it
  const centred = block('p2', { align: 'center' });
  ok(effective(doc, centred).align === 'center', 'a paragraph override beats the document');

  // writing the current default DELETES rather than stores
  const b = block('p3');
  writeProps(doc, b, { align: 'center' });
  ok((b as Record<string, unknown>).align === 'center', 'a difference is written');
  writeProps(doc, b, { align: 'left' });
  ok(!('align' in (b as Record<string, unknown>)),
     'setting the value the document already has deletes the field instead of storing it');
  writeProps(doc, b, { sb: 12 });
  ok((b as Record<string, unknown>).sb === 12, 'space before is written');
  writeProps(doc, b, { sb: undefined });
  ok(!('sb' in (b as Record<string, unknown>)), 'and undefined means back to the default');
  writeProps(doc, b, { keepNext: true });
  ok((b as Record<string, unknown>).keepNext === true, 'a keep flag is written as true');
  writeProps(doc, b, { keepNext: undefined });
  ok(!('keepNext' in (b as Record<string, unknown>)), 'and cleared by removal, never stored as false');
  writeProps(doc, b, { lh: 1.5 });
  ok(Object.keys(b as object).join() === 'id,kind,text,lh',
     `a paragraph carries only what makes it different (${Object.keys(b as object).join(', ')})`);
}

H('the CSS a paragraph produces');
{
  ok(blockStyle(block('a')) === '', 'a paragraph with no properties produces NO css, so it inherits');
  ok(blockStyle(block('a', { align: 'left' })) === 'text-align:left', 'left');
  ok(blockStyle(block('a', { align: 'center' })) === 'text-align:center', 'centre');
  ok(blockStyle(block('a', { align: 'right' })) === 'text-align:right', 'right');
  ok(blockStyle(block('a', { align: 'justify' })) === 'text-align:justify',
     'justify is emitted too — it must beat a document default of left');

  ok(blockStyle(block('a', { lh: 1.5 })) === 'line-height:1.5', 'line spacing is a unitless multiple');
  ok(blockStyle(block('a', { ind: 24 })) === 'text-indent:24px', 'first-line indent');
  ok(blockStyle(block('a', { sa: 18 })) === 'margin-bottom:18px', 'space after');
  // the stylesheet spaces consecutive paragraphs with margin-top:-10px +
  // padding-top:10px; overriding only the margin adds 10px to what was asked
  ok(blockStyle(block('a', { sb: 20 })) === 'margin-top:20px;padding-top:0',
     'space before clears the stylesheet’s padding half of the p + p pair');
  ok(blockStyle(block('a', { align: 'center', lh: 2, sb: 6, sa: 6, ind: 0 })) ===
     'text-align:center;line-height:2;margin-top:6px;padding-top:0;margin-bottom:6px;text-indent:0px',
     'and everything together, in one declaration list');
  ok(blockStyle(block('a', { keepNext: true, keepTogether: true, breakBefore: true })) === '',
     'the keep hints produce no CSS at all — they are pagination’s, not the browser’s');
}

H('document defaults go on the paper, not into every paragraph');
{
  const doc = emptyDoc();
  ok(Object.keys(docVars(doc)).length === 0,
     'a document that never touched layout sets nothing, so the stylesheet is untouched');
  (doc as { layout?: unknown }).layout = { align: 'left', lh: 1.5, sa: 14 };
  const v = docVars(doc);
  ok(v['--lay-align'] === 'left' && v['--lay-lh'] === '1.5' && v['--lay-sa'] === '14px',
     'the defaults become custom properties');
  ok(v['--lay-ind'] === undefined, 'and what the document does not say stays with the stylesheet');

  const g = pageVars({ ...LETTER, marginLeft: 144 } as PageGeom);
  ok(g['--page-w'] === '816px' && g['--mar-t'] === '104px', 'the page geometry drives the paper');
  ok(g['--mar-l'] === '144px' && g['--mar-r'] === '104px', 'including a left margin the sheet alone does not know');
}

H('break atoms: with no hints, the line-by-line break of today');
{
  const lines = (id: string, from: number, n: number): LineBox[] =>
    Array.from({ length: n }, (_, i) => ({ top: from + i * 20, bottom: from + i * 20 + 20, id }));
  const body = [block('p1'), block('p2'), block('p3')];
  const boxes = [...lines('p1', 0, 3), ...lines('p2', 60, 3), ...lines('p3', 120, 3)];

  const flat = atomize(body, boxes);
  ok(flat.length === 9, 'with no hints every LINE is its own atom, as pagination is free to break today');
  // the loop paginate.ts runs today, reproduced
  const naive = (start: number, avail: number) => {
    for (const b of boxes) {
      if (b.top < start - 0.5) continue;
      if (b.bottom - start > avail) return b.top;
    }
    return Infinity;
  };
  let same = true;
  for (const avail of [30, 45, 50, 100, 130, 200]) {
    for (const start of [0, 20, 60, 100]) {
      if (breakY(flat, start, avail) !== naive(start, avail)) { same = false; console.log(`     start ${start} avail ${avail}: ${breakY(flat, start, avail)} vs ${naive(start, avail)}`); }
    }
  }
  ok(same, 'breakY matches it for every start and page height tried');
  ok(breakY(flat, 0, 1000) === Infinity, 'and reports Infinity when the rest of the document fits');
}

H('break atoms: the hints');
{
  const lines = (id: string, from: number, n: number): LineBox[] =>
    Array.from({ length: n }, (_, i) => ({ top: from + i * 20, bottom: from + i * 20 + 20, id }));

  // keep-together: a paragraph that would straddle the break moves whole
  {
    const body = [block('p1'), block('p2', { keepTogether: true })];
    const boxes = [...lines('p1', 0, 3), ...lines('p2', 60, 3)];
    const loose = atomize([block('p1'), block('p2')], boxes);
    ok(breakY(loose, 0, 80) === 80, 'without the hint the break falls mid-paragraph, at y=80');
    const kept = atomize(body, boxes);
    ok(kept.length === 4, 'the kept paragraph is one atom and the loose one is three');
    ok(breakY(kept, 0, 80) === 60, 'with it the whole paragraph moves to the next page, at y=60');
  }

  // keep-with-next: the heading rule
  {
    const body = [block('h', { keepNext: true }), block('p')];
    const boxes = [...lines('h', 0, 1), ...lines('p', 20, 4)];
    const atoms = atomize(body, boxes);
    ok(atoms.length === 1, 'a keepNext block fuses with the one after it, lines and all');
    ok(breakY(atoms, 0, 200) === Infinity, 'and is never parted while the page can hold the pair');
    const body2 = [block('a'), block('h', { keepNext: true }), block('p')];
    const boxes2 = [...lines('a', 0, 2), ...lines('h', 40, 1), ...lines('p', 60, 2)];
    const at2 = atomize(body2, boxes2);
    ok(breakY(at2, 0, 50) === 40, 'a heading whose paragraph will not fit goes over with it');
  }

  // an author's page break
  {
    const body = [block('p1'), block('p2', { breakBefore: true })];
    const boxes = [...lines('p1', 0, 2), ...lines('p2', 40, 2)];
    const atoms = atomize(body, boxes);
    ok(breakY(atoms, 0, 1000) === 40, 'a page break is honoured even though everything fits');
    ok(breakY(atoms, 40, 1000) === Infinity, 'and does not fire again once the page starts there');
  }

  // a break the author asked for beats a keep that would swallow it
  {
    const body = [block('h', { keepNext: true }), block('p', { breakBefore: true })];
    const boxes = [...lines('h', 0, 1), ...lines('p', 20, 2)];
    const atoms = atomize(body, boxes);
    ok(atoms[0].lines.length === 1 && atoms[0].lines[0].id === 'h',
       'keepNext does not fuse across a break the author inserted');
    ok(atoms[1].forced, 'the break rides on the first atom of the paragraph that asked for it');
    ok(breakY(atoms, 0, 1000) === 20, 'so the break still happens');
  }

  // the escape hatch: an atom taller than the page
  {
    const body = [block('p', { keepTogether: true })];
    const boxes = Array.from({ length: 10 }, (_, i) => ({ top: i * 20, bottom: i * 20 + 20, id: 'p' }));
    const atoms = atomize(body, boxes);
    const y = breakY(atoms, 0, 100);
    ok(y === 100, `a keep-together paragraph taller than the page breaks by line anyway (y=${y})`);
    ok(y > 0, 'because returning the page’s own start would emit zero-height pages forever');
  }
}

H('units follow the reader, never the document');
{
  ok(unitFor('en-US') === 'in' && unitFor('en-CA') === 'in' && unitFor('en-PH') === 'in',
     'the three countries that never adopted ISO 216 get inches');
  ok(unitFor('sv-SE') === 'mm' && unitFor('en-GB') === 'mm' && unitFor('ja-JP') === 'mm',
     'everyone else gets millimetres');
  ok(formatLen(PAPER.a4.width, 'mm') === '210', 'A4 shows as 210mm');
  ok(formatLen(PAPER.letter.width, 'in') === '8.5', 'Letter shows as 8.5in');
  ok(parseLen('8.5', 'in') === 816, 'and 8.5in reads back as 816px');
  ok(parseLen('210', 'mm') !== null && Math.round(parseLen('210', 'mm')!) === 794, '210mm reads back as 794px');
  ok(parseLen('21,0', 'mm') !== null, 'a decimal comma is a decimal point');
  ok(parseLen('wide', 'in') === null, 'and a word is not a length');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
