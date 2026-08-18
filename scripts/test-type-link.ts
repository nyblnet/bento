#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type link rig.
//
//   node scripts/test-type-link.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES, in the order it matters.
//
//  1. SANITISING, because it is a security boundary and not a nicety. A Bento
//     document is untrusted input by house rule, and an href is the one field
//     in this model that a browser will EXECUTE. `javascript:` is the case
//     everyone writes a test for; the ones that actually get shipped are
//     `java\tscript:` (browsers strip the tab before parsing, so a naive
//     startsWith check reads it as a relative path) and the schemes a denylist
//     had not heard of yet, which is why this is an allowlist.
//
//  2. THAT TWO DIFFERENT LINKS DO NOT MERGE. `normalize()` fuses touching marks
//     of the same kind, so if href were not part of its grouping key, linking
//     two adjacent words to two different pages would silently produce ONE link
//     — and the author would not find out until a reader clicked. It IS part of
//     the key; this rig pins that, because a well-meaning simplification of
//     that key is exactly the change nobody would think to test.
//
//  3. THAT AUTOLINK DOES NOT FIRE. The firing cases are easy and the restraint
//     is the feature: this runs on every keystroke of ordinary prose, and a
//     rule loose enough to catch `example.com` also catches `index.html`,
//     `README.md` and `Mr.Smith`. Half the autolink section is negative.
//
// No DOM: link.ts keeps its logic above the browser guard for exactly this
// reason, so all of the above is a CI gate rather than something checked by
// hand in a browser once.

import {
  sanitizeUrl, safeHref, setLink, linkAt, hasLinkIn, autolinkAt,
} from '../type/src/link.ts';
import { normalize, toHtml, type Mark } from '../type/src/inline.ts';
import { safeHref as renderGate } from '../type/src/inline.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);
const J = (v: unknown) => JSON.stringify(v);

// ───────────────────────────────────────────────────────── sanitising
H('a hostile scheme never survives');
{
  const hostile = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'java\rscript:alert(1)',
    'javascript :alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'DATA:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'blob:https://evil.example/9f',
    'filesystem:https://evil.example/temporary/x',
    'jar:https://evil.example!/a',
  ];
  for (const h of hostile) ok(sanitizeUrl(h) === null, `refused: ${J(h)}`);
  ok(safeHref('javascript:alert(1)') === null, 'and refused again at the moment of following');
}

H('an honest address is kept, and completed the way the author meant it');
{
  const cases: Array<[string, string]> = [
    ['https://example.com/a', 'https://example.com/a'],
    ['http://example.com', 'http://example.com'],
    ['mailto:a@example.com', 'mailto:a@example.com'],
    ['tel:+441234567890', 'tel:+441234567890'],
    ['example.com', 'https://example.com'],
    ['www.example.com/x?y=1#z', 'https://www.example.com/x?y=1#z'],
    ['a.person@example.com', 'mailto:a.person@example.com'],
    ['#clause-3', '#clause-3'],
    // Protocol-relative. A Bento document is one FILE, usually opened from
    // file://, where `//host` means a local path — never the web page the
    // author was pointing at. Promoted, not passed through, and not refused.
    ['//evil.example/x', 'https://evil.example/x'],
    ['///evil.example', 'https://evil.example'],
    ['/schedule-a', 'https://schedule-a'],
  ];
  for (const [raw, want] of cases) ok(sanitizeUrl(raw) === want, `${J(raw)} → ${J(want)} (got ${J(sanitizeUrl(raw))})`);
  ok(sanitizeUrl('') === null && sanitizeUrl('   ') === null, 'nothing typed is nothing linked');
}

H('nothing this feature stores can break out of an href attribute');
{
  // inline.ts escapes & < > in an attribute value and NOT the double quote, so
  // an href carrying one closes the attribute and everything after it becomes
  // markup. That is a core bug and it is written up at the top of link.ts; this
  // rig pins the half of it this feature owns — that the strings THIS code
  // produces cannot exercise it, whoever fixes the renderer and whenever.
  const nasty = 'https://x" onmouseover="alert(1)';
  const href = sanitizeUrl(nasty)!;
  ok(href !== null && !href.includes('"'), `a quote is percent-encoded: ${J(href)}`);
  const html = toHtml('click', [{ t: 'link', from: 0, to: 5, href }]);
  ok(/^<a href="[^"]*">click<\/a>$/.test(html),
     `so the anchor is ONE attribute inside ONE pair of quotes, with nothing bolted on after it — ${html}`);
  for (const ch of ['"', "'", '`', '<', '>']) {
    ok(!sanitizeUrl(`https://x${ch}y`)!.includes(ch), `${J(ch)} never reaches the document`);
  }
}

// ─────────────────────────────────────────────────────────── applying
const TEXT = 'See the schedule and the annex for the details.';

H('applying a link over a selection');
{
  const marks = setLink([], TEXT.length, 8, 16, 'https://example.com/schedule');
  ok(J(marks) === J([{ t: 'link', from: 8, to: 16, href: 'https://example.com/schedule' }]),
     `the selected range carries the mark and nothing else does — ${J(marks)}`);
  ok(TEXT.slice(8, 16) === 'schedule', 'and it covers the words that were selected');
  ok(toHtml(TEXT, marks).includes('<a href="https://example.com/schedule">schedule</a>'),
     'which renders as one anchor around them');
}

H('a link lands beside other formatting without disturbing it');
{
  const bold: Mark[] = [{ t: 'b', from: 0, to: 20 }];
  const marks = setLink(bold, TEXT.length, 8, 16, 'https://example.com/s');
  ok(marks.filter(m => m.t === 'b').length === 1, 'the bold run is still one run');
  ok(marks.filter(m => m.t === 'b')[0].to === 20, 'and still the same length');
}

H('re-targeting a link REPLACES it — it is not a toggle');
{
  const one = setLink([], TEXT.length, 8, 16, 'https://one.example');
  const two = setLink(one, TEXT.length, 8, 16, 'https://two.example');
  ok(two.length === 1 && two[0].href === 'https://two.example',
     `editing the address leaves exactly one link, the new one — ${J(two)}`);
}

H('THE ONE THAT WOULD BE SILENT: two adjacent DIFFERENT links do not merge');
{
  // 'schedule' 8–16, ' and ' 16–21, 'the annex' 21–30 — the middle words are
  // linked too, so the two marks TOUCH. normalize() fuses touching marks of the
  // same kind; it must not fuse these.
  let marks = setLink([], TEXT.length, 8, 21, 'https://example.com/schedule');
  marks = setLink(marks, TEXT.length, 21, 30, 'https://example.com/annex');
  ok(marks.length === 2, `two touching links stay two marks (got ${marks.length}: ${J(marks)})`);
  ok(marks[0].href === 'https://example.com/schedule' && marks[1].href === 'https://example.com/annex',
     'each keeps its own address');
  ok(marks[0].to === marks[1].from, 'and they really are touching, not separated by a gap');
  ok(normalize(marks, TEXT.length).length === 2,
     'normalize agrees — href is part of its grouping key');
  const html = toHtml(TEXT, marks);
  ok((html.match(/<a /g) ?? []).length === 2, `and the render is two anchors — ${html.slice(0, 110)}…`);

  // The same two ranges with the SAME address SHOULD become one: that is the
  // merge doing its job, and it is what makes the negative result above mean
  // something rather than being merging switched off.
  let same = setLink([], TEXT.length, 8, 21, 'https://example.com/x');
  same = setLink(same, TEXT.length, 21, 30, 'https://example.com/x');
  ok(same.length === 1 && same[0].from === 8 && same[0].to === 30,
     `two touching links to the same page DO merge — ${J(same)}`);
}

H('removing a link');
{
  const marks = setLink([], TEXT.length, 8, 16, 'https://example.com/s');
  ok(setLink(marks, TEXT.length, 8, 16, null).length === 0, 'clearing the whole link removes it');
  const bold = setLink([{ t: 'b', from: 0, to: 20 }], TEXT.length, 8, 16, 'https://example.com/s');
  const gone = setLink(bold, TEXT.length, 8, 16, null);
  ok(gone.length === 1 && gone[0].t === 'b', 'and takes nothing else with it');
  // A partial unlink splits, because removeMark does — the rule is inline.ts's,
  // not this file's, and that is the point of not reimplementing it.
  const split = setLink(setLink([], TEXT.length, 8, 30, 'https://example.com/s'),
                        TEXT.length, 12, 20, null);
  ok(split.length === 2 && split[0].to === 12 && split[1].from === 20,
     `unlinking the middle of a link splits it — ${J(split)}`);
  ok(split.every(m => m.href === 'https://example.com/s'), 'both halves keep the address');
}

H('which link the caret is on');
{
  const marks = setLink(setLink([], TEXT.length, 8, 16, 'https://a.example'),
                        TEXT.length, 21, 30, 'https://b.example');
  ok(linkAt(marks, 12)?.href === 'https://a.example', 'inside the first link');
  ok(linkAt(marks, 25)?.href === 'https://b.example', 'inside the second');
  ok(linkAt(marks, 18) === undefined, 'between them, on neither');
  ok(linkAt(marks, 8)?.href === 'https://a.example', 'on the first character counts as inside');
  ok(linkAt(undefined, 3) === undefined, 'a block with no marks at all is fine');
  ok(hasLinkIn(marks, 14, 24), 'a range overlapping either link is reported');
  ok(!hasLinkIn(marks, 16, 21), 'a range in the gap is not');
}

// ─────────────────────────────────────────────────────────── autolink
const auto = (text: string, marks: Mark[] = []) => autolinkAt(text, text.length, marks);

H('autolink fires on a URL completed by a space');
{
  const cases: Array<[string, string, string]> = [
    ['see https://example.com/a ', 'https://example.com/a', 'an explicit https URL'],
    ['see http://example.com ', 'http://example.com', 'and http'],
    ['see www.example.com ', 'https://www.example.com', 'the www. idiom is completed to https'],
    ['mail a@example.com ', 'mailto:a@example.com', 'an email becomes mailto:'],
    ['see https://example.com/a. ', 'https://example.com/a', 'a sentence full stop is left out of it'],
    ['see https://example.com/a, ', 'https://example.com/a', 'so is a comma'],
    ['(see https://example.com/a) ', 'https://example.com/a', 'so is a closing bracket it did not open'],
    ['see https://ex.example/Foo_(bar) ', 'https://ex.example/Foo_(bar)', 'but a bracket the URL DID open is kept'],
  ];
  for (const [text, want, why] of cases) {
    const hit = auto(text);
    ok(hit?.href === want, `${why} — ${J(text)} → ${J(hit?.href)}`);
  }
  const hit = auto('see https://example.com/a ')!;
  ok('see https://example.com/a '.slice(hit.from, hit.to) === 'https://example.com/a',
     'the offsets cover exactly the URL, not the space that triggered it');
}

H('autolink stays silent — the half that runs on every keystroke of prose');
{
  const quiet: Array<[string, string]> = [
    ['see https://example.com/a', 'nothing has completed the word yet — no trailing space'],
    ['the fee is agreed ', 'ordinary prose'],
    ['see example.com ', 'a BARE domain: index.html and README.md are the same shape'],
    ['open index.html ', 'a filename is not an address'],
    ['read README.md ', 'even though .md is a real TLD'],
    ['ask Mr.Smith ', 'a name with a full stop in it'],
    ['clause 3.5 ', 'a number'],
    ['e.g. ', 'an abbreviation'],
    ['version v1.2.3 ', 'a version'],
    ['javascript:alert(1) ', 'a hostile scheme is not a scheme we autolink'],
    ['data:text/html,x ', 'nor is data:'],
    ['ftp://files.example/x ', 'nor a scheme outside the allowlist'],
    ['www. ', 'a www. prefix with no domain after it'],
    ['a@b ', 'an @ with no dotted domain'],
    [' ', 'a lone space'],
    ['', 'an empty block'],
  ];
  for (const [text, why] of quiet) ok(auto(text) === null, `${why} — ${J(text)}`);
}

H('autolink never fires inside a link that already exists');
{
  const text = 'see https://example.com/a ';
  const linked = setLink([], text.length, 4, 25, 'https://chosen.example');
  ok(auto(text, linked) === null,
     'a URL already linked is left alone — re-linking would replace the address the author chose');
  // and a link ELSEWHERE in the block does not block a new one
  const other = setLink([], text.length, 0, 3, 'https://elsewhere.example');
  ok(auto(text, other)?.href === 'https://example.com/a', 'but a link on other words does not stop it');
}

H('autolink is cheap, because it runs on every input event');
{
  // The gate is the character before the caret. A long paragraph with no
  // trailing space must not be scanned at all — measured rather than asserted,
  // because "it is O(1)" is the kind of claim that quietly stops being true.
  const long = 'lorem ipsum dolor sit amet '.repeat(4000) + 'x';
  const t0 = performance.now();
  for (let i = 0; i < 20000; i++) autolinkAt(long, long.length, []);
  const per = (performance.now() - t0) / 20000;
  ok(per < 0.01, `20,000 rejections of a ${long.length.toLocaleString()}-char block: ${per.toFixed(5)}ms each`);
}

H('the two gates agree — the render one and the navigation one');
{
  // There are deliberately TWO: inline.ts guards what enters the document's
  // HTML, link.ts guards what a ⌘-click follows. They serve different moments,
  // but they share an ALLOWLIST, and a duplicated security policy is one that
  // drifts — someone adds a scheme to one and the other silently disagrees.
  // Nothing forces them together, so this asserts they cannot part.
  const cases = [
    'https://example.com/a', 'http://x.test', 'mailto:a@b.co', 'tel:+44123', '#frag',
    '/abs', './rel', '../up', 'relative/path',
    'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>',
    'vbscript:x', 'file:///etc/passwd', '//evil.example/x', 'ftp://f.example',
    ' https://ok.example ', 'HTTPS://UP.EXAMPLE',
  ];
  const apart = cases.filter(c => (renderGate(c) !== null) !== (safeHref(c) !== null));
  ok(apart.length === 0,
     `both gates reach the same verdict on ${cases.length} urls${apart.length ? ` — differ on ${JSON.stringify(apart)}` : ''}`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
