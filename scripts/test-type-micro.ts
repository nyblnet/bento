#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type microtypography rig.  node scripts/test-type-micro.ts
//
// type/src/micro.ts hangs punctuation past the margin so the edge of the text
// reads straight. The feature is small; the thing that could go wrong is not.
//
// THE REGRESSION THAT WOULD HURT MOST IS A REFLOW. Line breaking is the
// browser's, pagination is measured off the line boxes it produces
// (type/src/paginate.ts), and every saved file carries a page count that is
// already a promise to whoever printed it. So an optical adjustment that moved
// a single line break would move a page break, and there is no way to notice
// that from inside the document.
//
// The implementation defends that in two layers and this rig checks BOTH,
// because either alone is a promise rather than a proof:
//
//   1. THE MECHANISM CANNOT REFLOW. The offset is `position: relative` and a
//      `left`, which CSS 2.1 §9.4.3 says is painted-only and affects the layout
//      of no box at all. This rig reads the SHIPPED CSS and the SHIPPED code and
//      refuses anything else — a negative margin, an inline-block, a transform,
//      a letter-spacing. That is the form this bug would actually take: the
//      obvious way to hang a comma is `margin-right: -2px`, it looks identical
//      on the screenshot, and it reflows.
//   2. THE PASS VERIFIES ITSELF. Wrapping a character in a span can still cost
//      a kern pair across the new element boundary, worth a fraction of a pixel
//      — and a fraction of a pixel is in principle enough to flip a break. So
//      the pass re-reads every line boundary after wrapping and unwraps the
//      paragraph if any of them moved. `boundariesHeld` is that decision, and
//      it is pure so that it can be exercised here rather than only in a
//      browser.
//
// And one more, quieter: the wrapper must be INVISIBLE TO THE MODEL. The editor
// reads a block back out of the DOM on every keystroke, so a span the reader
// does not understand is formatting silently invented or silently lost. The
// round trip is checked against the same minimal parser the inline rig uses.
//
// What is NOT here: real layout. Node has none — getBoundingClientRect answers
// zero for everything — so the geometry half (that the ink edge actually gets
// straighter) is measured in a browser and reported with the change. What is
// here is everything that decides whether that measurement is SAFE.

import { readFileSync } from 'node:fs';
import {
  PROTRUDE_END, PROTRUDE_START, protrudes, opticalShift, boundariesHeld,
  MIN_SHIFT, MAX_SHIFT_RATIO, LINE_EPS, opticalOn, stats, mergeLines, lineSplits, type Bearings,
} from '../type/src/micro.ts';
import { fromDom } from '../type/src/inline.ts';
import { emptyDoc, parseDoc } from '../type/src/model.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);
const J = (v: unknown) => JSON.stringify(v);

const here = new URL('.', import.meta.url).pathname;
const read = (p: string) => readFileSync(here + '../' + p, 'utf8');

// ─────────────────────────────────────────── a minimal DOM, for the round trip
// The same 40-line parser scripts/test-type-inline.ts carries, and for the same
// reason: the property has to be checkable in CI, and a property only checked
// in a browser is a property nobody checks.
interface TNode { nodeType: 3; nodeValue: string; childNodes: TNode[] }
interface ENode { nodeType: 1; tagName: string; attrs: Record<string, string>;
                  classList: { contains(c: string): boolean };
                  childNodes: Array<TNode | ENode>; getAttribute(n: string): string | null }

const VOID = new Set(['br', 'img', 'hr']);
function parse(html: string): ENode {
  const mk = (tag: string, attrs: Record<string, string>): ENode => ({
    nodeType: 1, tagName: tag.toUpperCase(), attrs, childNodes: [],
    classList: { contains: (c: string) => (attrs.class ?? '').split(/\s+/).includes(c) },
    getAttribute: (n: string) => attrs[n] ?? null,
  });
  const root = mk('div', {});
  const stack: ENode[] = [root];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+="[^"]*")*)\s*\/?>/g;
  let last = 0, m: RegExpExecArray | null;
  const text = (s: string) => {
    if (!s) return;
    const decoded = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    stack[stack.length - 1].childNodes.push({ nodeType: 3, nodeValue: decoded, childNodes: [] });
  };
  while ((m = re.exec(html))) {
    text(html.slice(last, m.index));
    last = m.index + m[0].length;
    const tag = m[1].toLowerCase();
    if (m[0].startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    const node = mk(tag, attrs);
    stack[stack.length - 1].childNodes.push(node);
    if (!VOID.has(tag) && !m[0].endsWith('/>')) stack.push(node);
  }
  text(html.slice(last));
  return root;
}

// ─────────────────────────────────────────────────── which characters may hang
H('what is allowed to hang, and at which end');
{
  ok(protrudes('.', 'end') && protrudes(',', 'end'), 'the full stop and the comma hang at the right margin');
  ok(protrudes('-', 'end') && protrudes('—', 'end'), 'so do an explicit hyphen and an em dash');
  ok(protrudes('”', 'end') && protrudes('’', 'end'), 'and closing quotes');
  ok(protrudes('“', 'start') && protrudes('(', 'start'), 'opening quotes and brackets hang at the left');

  // A LETTER MUST NOT HANG. Moving every line's last letter out by its side
  // bearing is margin kerning — a different feature, with a different risk
  // profile, and doing it here by accident would move every line of the
  // document rather than the punctuated ones.
  for (const ch of 'aeoxWy0') ok(!protrudes(ch, 'end') && !protrudes(ch, 'start'), `'${ch}' never hangs`);
  ok(!protrudes(' ', 'end'), 'nor a space');

  // the closing marks belong at the closing end and vice versa
  ok(!protrudes('“', 'end'), 'an OPENING quote does not hang off the right margin');
  ok(!protrudes('.', 'start'), 'a full stop does not hang off the left one');
  ok(PROTRUDE_END.size > 0 && PROTRUDE_START.size > 0, 'both sets are populated');
}

// ─────────────────────────────────────────────────────────── how far it moves
H('the offset is the side bearing, and nothing more');
{
  // a period in a 17px serif: ~4.6px advance, ink from 1.5 to 3.1
  const period: Bearings = { advance: 4.6, inkLeft: 1.5, inkRight: 3.1 };
  const s = opticalShift('.', 'end', period);
  ok(Math.abs(s - 1.5) < 1e-9, `it moves right by the right side bearing: ${s.toFixed(2)}px`);
  ok(s > 0, 'positive is out into the margin at the right edge');

  // Ink flush is the OPTIMUM of the stated objective, so overshooting it is a
  // regression and not a taste. After the shift the ink's right edge sits
  // exactly on the advance box's right edge — i.e. on the margin.
  ok(Math.abs((period.inkRight + s) - period.advance) < 1e-9,
     'after the shift the ink ends exactly where the advance box did — on the margin');

  const quote: Bearings = { advance: 5.2, inkLeft: 1.1, inkRight: 4.9 };
  const q = opticalShift('“', 'start', quote);
  ok(Math.abs(q + 1.1) < 1e-9, `an opening quote moves LEFT by its left bearing: ${q.toFixed(2)}px`);
  ok(q < 0, 'negative is out into the margin at the left edge');

  ok(opticalShift('e', 'end', period) === 0, 'a character that may not hang gets no offset at all');

  // clamps
  const wild: Bearings = { advance: 4, inkLeft: 0, inkRight: 0 };
  ok(Math.abs(opticalShift('.', 'end', wild) - 4 * MAX_SHIFT_RATIO) < 1e-9,
     `an absurd bearing is capped at ${MAX_SHIFT_RATIO} of the advance — a substituted fallback face cannot throw a comma across the page`);
  const overhang: Bearings = { advance: 4, inkLeft: -0.9, inkRight: 4.9 };
  ok(opticalShift('’', 'end', overhang) < 0,
     'ink that already overhangs its box is pulled back IN, not pushed further out (italic and script faces)');
  const tiny: Bearings = { advance: 4, inkLeft: 0.1, inkRight: 3.9 };
  ok(opticalShift('.', 'end', tiny) === 0, `under ${MIN_SHIFT}px is not worth a wrapper and is dropped`);
  ok(opticalShift('.', 'end', { advance: 0, inkLeft: 0, inkRight: 0 }) === 0, 'a zero advance yields nothing');
  ok(opticalShift('.', 'end', { advance: NaN, inkLeft: 1, inkRight: 1 }) === 0, 'and so does a NaN');
}

// ────────────────────────────────────── THE ONE THAT MATTERS: no line moved
H('the runtime guard: a paragraph whose line boundaries moved is unwrapped');
{
  // Three lines. `tops` is where they were, `after` where they are now, and
  // the last two arrays say which line each line's LAST and FIRST character was
  // found on afterwards. Held means every one of them is still on its own line.
  const tops = [100, 120, 140];
  const held = boundariesHeld(tops, [100, 120, 140], [0, 1, 2], [0, 1, 2]);
  ok(held, 'nothing moved: the wrapping stands');

  ok(!boundariesHeld(tops, [100, 120], [0, 1, 2], [0, 1, 2]),
     'a paragraph that lost a line is REJECTED — the reflow this feature must never cause');
  ok(!boundariesHeld(tops, [100, 120, 140, 160], [0, 1, 2], [0, 1, 2]), 'and one that gained a line');

  // THE ONE THAT GOT THROUGH. Measured on a real 14-page document: wrapping the
  // comma of "…including time-sheets," cost the kern between the "s" and the
  // ",", the word stopped fitting, and the break moved back to the hyphen in
  // "time-". The line COUNT was unchanged, every line TOP was unchanged, and
  // the character that OPENED line 1 was still on line 1 — the word had simply
  // moved down onto it. Only the line's LAST character betrays this.
  ok(!boundariesHeld(tops, [100, 120, 140], [1, 1, 2], [0, 1, 2]),
     "a word that fell off the end of line 0 onto line 1 is caught — the one-sided check passed this on a real document");
  ok(!boundariesHeld(tops, [100, 120, 140], [0, 1, 2], [0, 0, 2]),
     'and a word pulled UP from line 1 onto line 0, which is the same bug mirrored');

  ok(boundariesHeld([100], [100.2], [0], [0]),
     `sub-pixel noise inside ${LINE_EPS}px is not a reflow`);
  ok(!boundariesHeld(tops, [100, 121.2, 140], [0, 1, 2], [0, 1, 2]),
     'but a line that actually shifted is');

  // A rect we could not read comes back -1 (or NaN), and it must FAIL rather
  // than pass — "I could not tell" is not "it was fine".
  ok(!boundariesHeld(tops, [100, 120, 140], [0, -1, 2], [0, 1, 2]),
     'an unreadable line is treated as a failure, not as a pass');
  ok(!boundariesHeld(tops, [100, NaN, 140], [0, 1, 2], [0, 1, 2]),
     'and so is an unreadable line top');
  ok(!boundariesHeld(tops, [100, 120, 140], [0, 1], [0, 1, 2]),
     'a short observation array is a failure too, not a silently shorter loop');
}

// ─────────────────────────────────────────── rects are fragments, not lines
H('client rects are merged into lines before anything is measured');
{
  // Range.getClientRects() returns one rect per rendered FRAGMENT. A line
  // carrying a bold run comes back as two, each ending mid-line — read as
  // lines, the paragraphs with the most formatting are exactly the ones that
  // quietly stop hanging, because no "line" appears to reach the margin.
  const R = (top: number, bottom: number, left: number, right: number) =>
    ({ top, bottom, left, right, height: bottom - top, width: right - left }) as DOMRect;
  const lines = mergeLines([R(0, 20, 0, 300), R(0, 20, 300, 608), R(20, 40, 0, 608)]);
  ok(lines.length === 2, `three fragments over two lines merge to two lines (got ${lines.length})`);
  ok(lines[0].left === 0 && lines[0].right === 608, 'the merged line spans from the first fragment to the last');

  // a superscript footnote marker sits higher than the text it rides on and is
  // still on that line — so the grouping is by overlap, not by an equal top
  const withSup = mergeLines([R(0, 20, 0, 300), R(-6, 8, 300, 310), R(0, 20, 310, 608)]);
  ok(withSup.length === 1, 'a raised footnote marker does not become a line of its own');
  ok(withSup[0].right === 608, 'and the line still reaches the margin');

  ok(mergeLines([]).length === 0, 'no rects, no lines');
  ok(mergeLines([R(0, 0.2, 0, 300)]).length === 0, 'a zero-height rect is not a line');

  // the split used to decide which line a character is on sits between them
  const s = lineSplits(mergeLines([R(0, 20, 0, 608), R(24, 44, 0, 608)]));
  ok(s.length === 1 && Math.abs(s[0] - 22) < 1e-9, `one split, midway between the lines: ${s[0]}`);
}

// ──────────────────────────────── the mechanism, as it is actually shipped
H('the shipped CSS and code can only paint, never lay out');
{
  const css = read('type/src/styles.css');
  const print = read('type/src/print.ts');
  ok(/\.t-hang\s*\{\s*position:\s*relative;\s*\}/.test(css),
     'styles.css gives .t-hang relative positioning and nothing else');
  ok(/\.t-hang\s*\{\s*position:\s*relative;\s*\}/.test(print),
     'and print.ts ships the same rule, so paper and screen hang identically');

  // The bug this catches by name: hanging a comma with `margin-right: -2px`
  // looks the same and reflows the paragraph.
  const rule = (src: string) => (src.match(/\.t-hang\s*\{[^}]*\}/) ?? [''])[0];
  const BANNED = /(margin|padding|width|display|float|transform|letter-spacing|word-spacing|font-|text-indent)/;
  ok(!BANNED.test(rule(css)), 'the screen rule declares no property that could move another box');
  ok(!BANNED.test(rule(print)), 'nor the print one');

  // and the code may only ever set `left`
  const micro = read('type/src/micro.ts');
  const props = [...micro.matchAll(/span\.style\.([A-Za-z]+)\s*=/g)].map(m => m[1]);
  ok(props.length > 0 && props.every(p => p === 'left'),
     `the pass sets only 'left' on a wrapper (found: ${J([...new Set(props)])})`);
  ok(!/span\.style\.cssText/.test(micro), 'and never a cssText it could smuggle anything through');
}

// ───────────────────────────────────────── invisible to the model
H('a wrapper is transparent to the block reader');
{
  // The editor reads a block back out of the DOM on every keystroke. If the
  // reader saw the wrapper, a paragraph would gain or lose formatting simply
  // by being hung — and it would do it silently, on a document someone may
  // already have signed.
  const bare = '<p>He said <strong>no</strong>, twice.</p>';
  const hung = '<p>He said <strong>no</strong><span class="t-hang" style="left:1.50px">,</span> twice<span class="t-hang" style="left:1.50px">.</span></p>';
  const a = fromDom(parse(bare) as unknown as Node);
  const b = fromDom(parse(hung) as unknown as Node);
  ok(a.text === b.text, `the text is byte-identical: ${J(a.text)}`);
  ok(J(a.marks) === J(b.marks), 'and so are the marks — the wrapper contributes none');
  ok(b.text.includes(', twice.'), 'the punctuation is still IN the text, only painted elsewhere');

  // one wrapped inside a mark, which is where a naive reader would split a run
  const inside = '<p>He said <strong>no<span class="t-hang" style="left:1.50px">.</span></strong></p>';
  const c = fromDom(parse(inside) as unknown as Node);
  ok(J(c.marks) === J([{ t: 'b', from: 8, to: 11 }]),
     `a wrapper inside a bold run does not split it: ${J(c.marks)}`);
}

// ───────────────────────────────────────────────────── the document property
H('doc.optical — absent means on, and only `false` is stored');
{
  const fresh = emptyDoc();
  ok(fresh.optical === undefined, 'a new document says nothing about it');
  ok(opticalOn(fresh), 'and is therefore on');
  ok(opticalOn({ optical: true }), 'true is on');
  ok(!opticalOn({ optical: false }), 'false is off, and false is the only way to be off');

  // A file written before this existed is the case that matters: it must open,
  // and it must open with the feature on, because what it promised was its
  // PAGINATION and that is untouched.
  const old = parseDoc(JSON.stringify({ ...emptyDoc(), optical: undefined }));
  ok(old.ok && old.doc.optical === undefined, 'an old file parses with no such field');
  ok(old.ok && opticalOn(old.doc), 'and renders with optical margins on');

  const off = parseDoc(JSON.stringify({ ...emptyDoc(), optical: false }));
  ok(off.ok && off.doc.optical === false, 'a document that turned it off keeps it off through a parse');
  const again = off.ok ? parseDoc(JSON.stringify(off.doc)) : off;
  ok(again.ok && again.doc.optical === false, 'and through a save and a reopen');

  const on = parseDoc(JSON.stringify({ ...emptyDoc(), optical: true }));
  ok(on.ok && on.doc.optical === undefined, 'an explicit true is normalised away — the default carries no information');
  const junk = parseDoc(JSON.stringify({ ...emptyDoc(), optical: 'yes please' }));
  ok(junk.ok && junk.doc.optical === undefined, 'and junk is dropped rather than ridden along as truthy');
}

// ──────────────────────────────────────────────────────── the measurement
H('the measurement the feature is justified by');
{
  const s = stats([-2, -1, 0, 1, 2]);
  ok(s.n === 5 && Math.abs(s.mean) < 1e-12 && Math.abs(s.sd - Math.sqrt(2)) < 1e-12,
     `mean and standard deviation of the ink offsets: n=${s.n} sd=${s.sd.toFixed(4)}`);
  ok(stats([]).n === 0, 'an empty sample does not divide by zero');

  // the claim, restated as arithmetic: hanging removes the right side bearing
  // from each line's shortfall, so a sample of shortfalls shrinks toward zero
  const before = [1.5, 0, 1.5, 0.9, 0, 1.5];          // periods, commas, letters
  const rsb    = [1.5, 0, 1.5, 0.9, 0, 1.5];
  const after  = before.map((b, i) => b - rsb[i]);
  ok(stats(after).sd < stats(before).sd,
     `removing the side bearing shrinks the spread of the ink edge: sd ${stats(before).sd.toFixed(3)} → ${stats(after).sd.toFixed(3)}`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
