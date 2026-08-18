#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type inline-formatting rig.
//
//   node scripts/test-type-inline.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. `type/src/inline.ts` stores plain text plus marks over
// character ranges, and renders HTML from it. Everything downstream of the
// model — the word-level redline, the canonical form a signature covers, the
// caret's model position, and footnote anchors — assumes that spine is exact.
//
// So the load-bearing property is the ROUND TRIP:
//
//     fromDom(parse(toHtml(text, marks)))  ==  { text, marks }
//
// If it does not hold, formatting silently mutates every time a block is
// re-rendered — which is invisible until a signed document stops verifying, or
// a redline reports a change nobody made.
//
// The rig carries its own 40-line HTML parser rather than a DOM dependency,
// because the round trip has to be checkable in CI, and a property only
// checked in a browser is a property nobody checks.

import { readFileSync } from 'node:fs';
import {
  normalize, coversAll, activeAt, addMark, removeMark, toggleMark, shift,
  toHtml, fromDom, type Mark,
} from '../type/src/inline.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);
const J = (v: unknown) => JSON.stringify(v);

// ───────────────────────────────────────────── a minimal DOM, for the parser
interface TNode { nodeType: 3; nodeValue: string; childNodes: TNode[] }
interface ENode { nodeType: 1; tagName: string; attrs: Record<string, string>;
                  childNodes: Array<TNode | ENode>; getAttribute(n: string): string | null }
type AnyNode = TNode | ENode;

const VOID = new Set(['br', 'img', 'hr']);
function parse(html: string): ENode {
  const root: ENode = { nodeType: 1, tagName: 'DIV', attrs: {}, childNodes: [], getAttribute: () => null };
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
    last = re.lastIndex;
    const tag = m[1].toLowerCase();
    if (m[0][1] === '/') { if (stack.length > 1) stack.pop(); continue; }
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? '').matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    const el: ENode = { nodeType: 1, tagName: tag.toUpperCase(), attrs, childNodes: [],
                        getAttribute(n) { return this.attrs[n] ?? null; } };
    stack[stack.length - 1].childNodes.push(el);
    if (!VOID.has(tag)) stack.push(el);
  }
  text(html.slice(last));
  return root;
}
// sanity: the parser itself must be right, or every result below is noise
{
  const p = parse('a<strong>b<em>c</em></strong>d');
  const kinds = p.childNodes.map(n => n.nodeType === 3 ? 't' : (n as ENode).tagName);
  if (J(kinds) !== J(['t', 'STRONG', 't'])) { console.log('  FAIL  the rig\'s own parser is broken'); process.exit(1); }
}

const roundTrip = (text: string, marks: Mark[]) => {
  const html = toHtml(text, marks);
  const back = fromDom(parse(html) as unknown as Node);
  return { html, text: back.text, marks: back.marks };
};

// ───────────────────────────────────────────────────────────── normalize
H('normalize gives one representation of any formatting');
{
  const t = 'abcdefghij';
  ok(J(normalize([{ t: 'b', from: 5, to: 8 }, { t: 'b', from: 0, to: 3 }], t.length))
     === J([{ t: 'b', from: 0, to: 3 }, { t: 'b', from: 5, to: 8 }]), 'marks come back sorted');
  ok(normalize([{ t: 'b', from: 0, to: 4 }, { t: 'b', from: 4, to: 8 }], t.length).length === 1,
     'touching marks of the same kind merge');
  ok(normalize([{ t: 'b', from: 0, to: 6 }, { t: 'b', from: 3, to: 8 }], t.length)[0].to === 8,
     'overlapping marks of the same kind merge');
  ok(normalize([{ t: 'b', from: 3, to: 3 }], t.length).length === 0, 'an empty mark is dropped');
  ok(normalize([{ t: 'b', from: 5, to: 999 }], t.length)[0].to === 10, 'marks are clamped to the text');
  ok(normalize([{ t: 'b', from: 0, to: 4 }, { t: 'i', from: 0, to: 4 }], t.length).length === 2,
     'different kinds do NOT merge');
  ok(normalize([{ t: 'link', from: 0, to: 4, href: 'a' }, { t: 'link', from: 4, to: 8, href: 'b' }], t.length).length === 2,
     'links with different targets do not merge');
}

// ─────────────────────────────────────────────────────────── toggle/remove
H('toggle behaves the way ⌘B does');
{
  const t = 'the quick brown fox';
  let m: Mark[] = [];
  m = toggleMark(m, t.length, 4, 9, 'b');
  ok(J(m) === J([{ t: 'b', from: 4, to: 9 }]), 'toggling an unmarked range marks it');
  m = toggleMark(m, t.length, 4, 9, 'b');
  ok(m.length === 0, 'toggling it again clears it');
  m = toggleMark([], t.length, 0, 19, 'b');
  m = toggleMark(m, t.length, 4, 9, 'b');
  ok(J(m) === J([{ t: 'b', from: 0, to: 4 }, { t: 'b', from: 9, to: 19 }]),
     'clearing the middle of a marked run splits it');
  ok(coversAll([{ t: 'b', from: 0, to: 4 }, { t: 'b', from: 4, to: 9 }], 0, 9, 'b'),
     'two adjacent marks together cover the range');
  ok(!coversAll([{ t: 'b', from: 0, to: 4 }, { t: 'b', from: 5, to: 9 }], 0, 9, 'b'),
     'a gap means the range is not fully covered');
  ok(J([...activeAt([{ t: 'b', from: 2, to: 6 }], 4)]) === J(['b']), 'activeAt reports what the caret sits in');
}

// ────────────────────────────────────────────────────────────────── shift
H('marks follow an edit — the same rule footnote anchors use');
{
  const t = 'Payment is due within 30 days of invoice.';
  const bold: Mark[] = [{ t: 'b', from: 22, to: 29 }];              // "30 days"
  ok(J(shift(bold, 0, 8, 3, t.length)) === J([{ t: 'b', from: 17, to: 24 }]),
     'an edit BEFORE a mark moves it by the delta');
  ok(J(shift(bold, 30, 5, 5, t.length)) === J(bold), 'an edit after a mark leaves it alone');
  ok(shift(bold, 22, 7, 0, t.length).length === 0, 'a mark whose text is deleted is dropped');
  const straddle: Mark[] = [{ t: 'b', from: 0, to: 30 }];
  const after = shift(straddle, 22, 7, 20, t.length + 13);
  ok(after[0].from === 0 && after[0].to === 43,
     `a mark straddling the edit is clipped, not dropped (0–${after[0].to})`);
}

// ─────────────────────────────────────────────────────────── the round trip
H('THE round trip: render then read back');
{
  const cases: Array<[string, Mark[]]> = [
    ['plain text with no marks', []],
    ['bold at the start', [{ t: 'b', from: 0, to: 4 }]],
    ['bold at the very end', [{ t: 'b', from: 12, to: 20 }]],
    ['nested bold and italic', [{ t: 'b', from: 0, to: 20 }, { t: 'i', from: 5, to: 12 }]],
    ['partially overlapping runs', [{ t: 'b', from: 0, to: 12 }, { t: 'i', from: 6, to: 20 }]],
    ['adjacent different marks', [{ t: 'b', from: 0, to: 8 }, { t: 'i', from: 8, to: 16 }]],
    ['three marks over one run', [{ t: 'b', from: 2, to: 18 }, { t: 'i', from: 4, to: 16 }, { t: 'u', from: 6, to: 14 }]],
    ['a link', [{ t: 'link', from: 2, to: 10, href: 'https://example.invalid/a' }]],
    ['a link inside bold', [{ t: 'b', from: 0, to: 20 }, { t: 'link', from: 4, to: 12, href: '#x' }]],
    ['code', [{ t: 'code', from: 5, to: 9 }]],
    ['strike', [{ t: 's', from: 1, to: 7 }]],
  ];
  for (const [label, marks] of cases) {
    const text = 'The quick brown fox jumps.';
    const r = roundTrip(text, marks);
    const want = normalize(marks, text.length);
    ok(r.text === text && J(r.marks) === J(want),
       `${label} — ${r.text === text ? '' : 'TEXT CHANGED; '}${J(r.marks) === J(want) ? '' : `marks ${J(r.marks)} ≠ ${J(want)}; `}${r.html.length} chars`);
  }
}

H('the round trip survives characters that mean something in HTML');
{
  for (const text of ['a < b && c > d', 'quotes "here" and ‘there’', '5 < 6 & 7 > 6',
                      'em—dash, ellipsis…, ampersand & more']) {
    const marks: Mark[] = [{ t: 'b', from: 2, to: Math.min(8, text.length) }];
    const r = roundTrip(text, marks);
    ok(r.text === text, `“${text.slice(0, 22)}…” survives escaping (got “${r.text.slice(0, 22)}…”)`);
  }
}

H('unknown markup contributes text and no formatting');
{
  const back = fromDom(parse('a<script>bad()</script>b<span class="x">c</span>') as unknown as Node);
  ok(!/</.test(back.text), 'no markup leaks into the text');
  ok(back.marks.length === 0, 'no marks are invented from tags the model has no word for');
  ok(back.text.includes('b') && back.text.includes('c'), 'the text inside unknown tags is kept');
}

// ─────────────────────────────────────────────────── idempotence + stability
H('stability — the properties the signature depends on');
{
  const text = 'The quick brown fox jumps.';
  const marks: Mark[] = [{ t: 'b', from: 0, to: 12 }, { t: 'i', from: 6, to: 20 }];
  const once = roundTrip(text, marks);
  const twice = roundTrip(once.text, once.marks);
  ok(J(once.marks) === J(twice.marks) && once.html === twice.html,
     'a second round trip changes nothing (idempotent)');
  ok(J(normalize([...marks].reverse(), text.length)) === J(normalize(marks, text.length)),
     'the order marks were authored in does not affect the stored form');
}

// ──────────────────────────────────────────────────────────────── fuzz
// Hand-picked cases test the shapes you thought of. The bug this rig already
// caught — a mark silently truncated when another one overlapped it — was in
// the list only because it was written down as a known-hard case. Random marks
// cover the ones nobody wrote down.
H('fuzz: 2,000 random mark sets round-trip exactly');
{
  let seed = 0x5eed;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const KINDS: MarkType[] = ['b', 'i', 'u', 's', 'code', 'link'];
  const TEXT = 'The quick brown fox jumps over the lazy dog & <friends> too.';
  let bad = 0, worst = '';
  for (let n = 0; n < 2000; n++) {
    const count = 1 + ((rnd() * 5) | 0);
    const marks: Mark[] = [];
    for (let i = 0; i < count; i++) {
      const a = (rnd() * TEXT.length) | 0, b = (rnd() * TEXT.length) | 0;
      const t = KINDS[(rnd() * KINDS.length) | 0];
      const from = Math.min(a, b), to = Math.max(a, b);
      if (to <= from) continue;
      marks.push(t === 'link' ? { t, from, to, href: '#' + i } : { t, from, to });
    }
    const want = normalize(marks, TEXT.length);
    const r = roundTrip(TEXT, marks);
    if (r.text !== TEXT || J(r.marks) !== J(want)) {
      bad++;
      if (!worst) worst = `in ${J(want)}\n        out ${J(r.marks)}\n        html ${r.html}`;
    }
  }
  ok(bad === 0, `2,000 random mark sets survive the round trip (${bad} failed)`);
  if (bad) console.log(`        ${worst}`);
}

H('an href cannot escape its attribute, and cannot carry a scheme');
{
  // Both of these were live. A document is untrusted input, so neither needed a
  // user of the link feature: a hand-written #bento-doc block, a pasted <a>
  // (fromDom copies the attribute verbatim) or a sync op would do, and
  // render.ts puts the result through innerHTML.
  const inject = toHtml('click me', [{ t: 'link', from: 0, to: 8,
    href: 'https://x" onmouseover="alert(1)' }] as never);
  ok(/^<a href="[^"]*">click me<\/a>$/.test(inject),
     `the attribute stays one attribute: ${inject}`);
  // NO SUBSTRING SEARCH. `onmouseover=` survives inside the escaped attribute
  // VALUE, where it is inert, so grepping for it fails on correct output — and
  // a cleverer regex over the same string fails the same way, because a regex
  // cannot tell an attribute from text that looks like one. The assertion
  // above IS the integrity check: `[^"]*` cannot contain a quote, so if the
  // whole tag matches `<a href="...">` then the value never closed early and
  // no second attribute exists. Two agents wrote the substring version first,
  // which is why this note is here rather than a third one.

  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>',
                     'vbscript:msgbox', 'file:///etc/passwd']) {
    const out = toHtml('x', [{ t: 'link', from: 0, to: 1, href: bad }] as never);
    ok(out === '<a>x</a>', `${bad.slice(0, 24)} renders with no href, keeping the words: ${out}`);
  }
  for (const good of ['https://example.com/a?b=1&c=2', 'mailto:a@b.co', '#anchor', '/rel', './rel']) {
    const out = toHtml('x', [{ t: 'link', from: 0, to: 1, href: good }] as never);
    ok(/^<a href="/.test(out), `${good} survives: ${out}`);
  }
  // & inside a real href must be escaped, not dropped
  const amp = toHtml('x', [{ t: 'link', from: 0, to: 1, href: 'https://e.com/?a=1&b=2' }] as never);
  ok(amp.includes('&amp;b=2'), `an ampersand in a query is escaped: ${amp}`);
}

H('the source carries no literal control characters');
{
  // A literal NUL in the merge key made git and grep treat this whole file as
  // binary, which hid it from ordinary tooling and cost a debugging cycle. The
  // separator is still a NUL at runtime; it is written as an escape.
  const src = readFileSync(new URL('../type/src/inline.ts', import.meta.url), 'utf8');
  const ctrl = [...src].filter(c => c.charCodeAt(0) < 9 || (c.charCodeAt(0) > 13 && c.charCodeAt(0) < 32));
  ok(ctrl.length === 0, `no literal control characters in the source (${ctrl.length})`);
  ok(normalize([{ t: 'link', from: 0, to: 2, href: 'a' },
                { t: 'link', from: 2, to: 4, href: 'b' }] as never, 4).length === 2,
     'and two different links still do not merge, so the separator still works');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
