#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type named-styles rig.  node scripts/test-type-styles.ts
//
// docstyles.ts closes the biggest gap versus Word: before it, a heading's
// size/weight/colour was a build constant (styles.css), not a document
// property, so "make every heading 18px Palatino" had no home. This pins the
// pure half — resolution, CSS composition, precedence, round-tripping — with
// no DOM, mirroring test-type-layout.ts's split for the same reason: it is
// the half that has to be right, and it is the half a browser is not needed
// to check.
//
// What it holds down, in the order it would burn:
//
//   · FORMAT ADDITIVITY (docs/PLATFORM.md §3). A document with no `doc.styles`
//     and blocks with no `styleId` must render BYTE-IDENTICAL to before this
//     feature existed — docStyleCss must return '' for every ordinary block.
//   · applying a style (styleId), and the KIND DEFAULT a block with none
//     falls back to — which is what makes "restyle every heading" possible
//     for paragraphs that never opted in individually.
//   · editing a style repaints every block that uses it, explicit or implicit.
//   · a block's own direct formatting (align/sb/sa/lh/ind) still wins over
//     its style — verified by actually composing the two CSS strings the way
//     render.ts and print.ts do, and reading back which value survives.
//   · a style, and a block's reference to one, survive save/reload — and a
//     dangling reference (the style was deleted) degrades to the kind
//     default rather than losing the paragraph's formatting entirely.

import { emptyDoc, parseDoc, type Block, type DocStyle, type TypeDoc } from '../type/src/model.ts';
import { blockStyle } from '../type/src/layout.ts';
import {
  BUILT_IN_STYLES, DEFAULT_STYLE_ID, activeStyleId, ownStyleId, resolveStyle,
  lookupStyle, listStyles, docStyleCss, styleSheetCss, effectiveLayout, hasDirectFormatting,
  materialize, mergeStyle, captureStyleFromBlock, safeStyleColor,
} from '../type/src/docstyles.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);

const block = (id: string, kind: Block['kind'], extra: Record<string, unknown> = {}): Block =>
  ({ id, kind, text: `${id} text`, ...extra }) as Block;

/** A tiny CSS-declaration-list reader: last declaration of a property wins,
 *  exactly as a browser resolves one `style` attribute — so a test can ask
 *  "what does text-align actually compute to" instead of string-matching. */
const winner = (css: string, prop: string): string | undefined => {
  let v: string | undefined;
  for (const decl of css.split(';')) {
    const [k, ...rest] = decl.split(':');
    if (k?.trim() === prop) v = rest.join(':').trim();
  }
  return v;
};

// ═══════════════════════════════════════════════════════ format additivity

H('a document with no styles renders exactly as it always did');
{
  const doc = emptyDoc();
  ok(doc.styles === undefined, 'emptyDoc carries no styles field at all');

  // Only `para`'s built-in is EMPTY (docs/DECISIONS-style rationale in
  // docstyles.ts: body text's look already comes entirely from unconditional
  // CSS). The other six kinds always had a real, hardcoded look — additivity
  // for THEM means the built-in table reproduces styles.css's own numbers
  // exactly, which is asserted by name below, not "no css at all".
  const kinds: Block['kind'][] = ['para', 'h1', 'h2', 'h3', 'quote', 'ul', 'ol'];
  for (const kind of kinds) {
    const b = block(`b-${kind}`, kind);
    ok(b.styleId === undefined, `a fresh ${kind} block carries no styleId`);
    if (kind === 'para') ok(docStyleCss(doc, b) === '', 'a plain paragraph produces NO css');
    else ok(docStyleCss(doc, b) !== '', `${kind} resolves to its built-in's real numbers`);
  }
  // kinds with no default style at all (image, cell, caption, toc, math, embed)
  for (const kind of ['image', 'cell', 'caption', 'toc', 'math', 'embed'] as const) {
    ok(DEFAULT_STYLE_ID[kind] === undefined, `${kind} has no default style`);
    ok(docStyleCss(doc, block(`b-${kind}`, kind)) === '', `${kind} produces no css either`);
  }
}

H('parseDoc round-trips a file with no "styles" key unchanged');
{
  const raw = JSON.stringify({
    format: 'bento/type', version: 1, docId: 'd1', title: 'T',
    page: { width: 816, height: 1056, marginX: 104, marginTop: 104, marginBottom: 104 },
    body: [{ id: 'p1', kind: 'h1', text: 'Title' }],
    footnotes: {}, revisions: [], signatures: [],
  });
  const r = parseDoc(raw);
  ok(r.ok, 'parses');
  if (r.ok) {
    ok(r.doc.styles === undefined, 'no styles field is invented on load');
    // an h1 is NOT expected to produce '' — it always resolved to a real
    // Heading-1 look, in styles.css before this feature and through the
    // built-in table now. What additivity promises is the SAME numbers.
    const css = docStyleCss(r.doc, r.doc.body[0]);
    ok(winner(css, 'font-size') === '26px' && winner(css, 'font-weight') === '600',
       'the heading still resolves to exactly styles.css\'s own Heading-1 numbers, from the built-in table alone');
    // a plain paragraph, by contrast, has an EMPTY built-in — additivity for
    // it means no inline css at all, matching a document that never opened
    // the Styles section before this feature existed
    const para = { id: 'x', kind: 'para' as const, text: 'body text' };
    ok(docStyleCss(r.doc, para) === '', 'a plain paragraph still produces no inline css');
  }
}

// ═══════════════════════════════════════════════════════ built-ins, derived from styles.css

H('built-in styles are derived from styles.css\'s own numbers');
{
  const doc = emptyDoc();
  const h1 = block('h', 'h1');
  const css = docStyleCss(doc, h1);
  ok(winner(css, 'font-size') === '26px', `h1 is 26px (${winner(css, 'font-size')})`);
  ok(winner(css, 'font-weight') === '600', 'h1 is weight 600');
  ok(winner(css, 'line-height') === '1.24', 'h1 keeps its own line-height');
  ok(winner(css, 'margin-bottom') === '14px', 'h1\'s CSS margin: 0 0 14px becomes sa=14');
  ok(winner(css, 'margin-top') === undefined, 'h1 has no sb, so no margin-top is emitted at all');

  const quote = block('q', 'quote');
  const qcss = docStyleCss(doc, quote);
  ok(winner(qcss, 'font-style') === 'italic', 'a quote is italic');
  ok(winner(qcss, 'color') === '#3a3d44', 'a quote takes --paper-ink-2, an UNTHEMED fixed value');

  ok(BUILT_IN_STYLES['default-body'].size === undefined
     && BUILT_IN_STYLES['default-body'].weight === undefined
     && BUILT_IN_STYLES['default-body'].color === undefined,
     'Body is intentionally empty — its look already comes from unconditional CSS');
}

// ═══════════════════════════════════════════════════════ applying a style

H('applying a style to a block — explicit styleId beats the kind default');
{
  const doc = emptyDoc();
  const p = block('p1', 'para');
  ok(activeStyleId(doc, p) === 'default-body', 'a plain paragraph defaults to Body');
  ok(ownStyleId(p) === undefined, 'and carries no explicit reference yet');

  p.styleId = 'default-h2';
  ok(ownStyleId(p) === 'default-h2', 'the explicit reference is now Heading 2');
  ok(activeStyleId(doc, p) === 'default-h2', 'and it wins over the kind default');
  const css = docStyleCss(doc, p);
  ok(winner(css, 'font-size') === '15.5px', 'the PARAGRAPH now renders Heading 2\'s size, kind unchanged');

  // choosing the kind's OWN default again clears the field, the same
  // "absent means default" rule layout.ts's paragraph properties already
  // follow — never store what is already implied
  const cleared: Block = { ...p };
  delete cleared.styleId;
  ok(activeStyleId(doc, cleared) === 'default-body', 'clearing it returns to Body');
}

H('a dangling styleId falls back to the kind default, not to nothing');
{
  const doc = emptyDoc();
  const h3 = block('h', 'h3', { styleId: 'no-such-style' });
  ok(resolveStyle(doc, h3)?.id === 'default-h3', 'an unresolvable id falls back to h3\'s own default');
  ok(docStyleCss(doc, h3) !== '', 'so the heading still looks like a heading, not like plain text');
}

// ═══════════════════════════════════════════════════════ editing a style repaints every user

H('editing a style updates every block that uses it — explicit AND implicit');
{
  let doc = emptyDoc();
  const explicit = block('e', 'para', { styleId: 'default-h1' }); // opted in
  const implicit = block('i', 'h1');                              // uses h1's default, unset
  const other = block('o', 'h2');                                 // a different kind, untouched

  ok(docStyleCss(doc, explicit) === docStyleCss(doc, implicit),
     'before any edit, the explicit user and the implicit user already agree (both read the built-in)');

  // "Update style to match this paragraph" writes into doc.styles — simulate
  // the panel's edit path directly with the exported pure helper
  doc = { ...doc, styles: { 'default-h1': mergeStyle(doc, 'default-h1', 'h1', { size: 40, color: '#ff0000' }) } };

  const cssExplicit = docStyleCss(doc, explicit);
  const cssImplicit = docStyleCss(doc, implicit);
  ok(winner(cssExplicit, 'font-size') === '40px', 'the explicit user picks up the edit');
  ok(winner(cssImplicit, 'font-size') === '40px', 'so does the block that never set styleId at all');
  ok(winner(cssExplicit, 'color') === '#ff0000' && winner(cssImplicit, 'color') === '#ff0000',
     'both agree on the new colour too');
  ok(docStyleCss(doc, other) !== cssExplicit, 'a DIFFERENT kind (h2) is unaffected by editing h1');
}

H('materialize copies the built-in on first edit, and only then');
{
  const doc = emptyDoc();
  ok(doc.styles?.['default-h2'] === undefined, 'nothing materialized yet');
  const copy = materialize(doc, 'default-h2', 'h2');
  ok(copy.size === 15.5 && copy.sb === 24, 'the copy carries the built-in\'s own numbers');
  ok(doc.styles?.['default-h2'] === undefined, 'materialize does not mutate the document — the caller commits');

  const shell = materialize(doc, 'my-custom-style', 'para');
  ok(shell.id === 'my-custom-style' && shell.kind === 'para', 'an id with no built-in gets a bare shell, not a crash');
}

// ═══════════════════════════════════════════════════════ per-block overrides win

H('direct per-block formatting wins over the style — composed the way render.ts does');
{
  const doc: TypeDoc = { ...emptyDoc(), styles: { 'default-h1': { ...BUILT_IN_STYLES['default-h1'], align: 'left', sb: 5 } } };
  const b = block('h', 'h1');           // uses the (now edited) h1 default: align left, sb 5

  const undisturbed = [docStyleCss(doc, b), blockStyle(b)].filter(Boolean).join(';');
  ok(winner(undisturbed, 'text-align') === 'left', 'with no override, the style\'s own alignment applies');

  b.align = 'right';                    // a direct per-block override (layout.ts vocabulary)
  b.sb = 40;
  const overridden = [docStyleCss(doc, b), blockStyle(b)].filter(Boolean).join(';');
  ok(winner(overridden, 'text-align') === 'right', 'the block\'s OWN alignment wins, not the style\'s "left"');
  ok(winner(overridden, 'margin-top') === '40px', 'and its own space-before wins over the style\'s 5px');
  ok(hasDirectFormatting(b), 'and the panel can tell this block has been overridden');
  ok(!hasDirectFormatting(block('clean', 'h1')), 'while an untouched block does not read as modified');
}

H('effectiveLayout reports block over style over document, for "update style to match"');
{
  const doc: TypeDoc = {
    ...emptyDoc(),
    layout: { sa: 99 },                                   // document default
    styles: { 'default-h2': { ...BUILT_IN_STYLES['default-h2'], sa: 8, lh: 1.5 } },  // style layer
  };
  const untouched = block('u', 'h2');
  const eff0 = effectiveLayout(doc, untouched);
  ok(eff0.sa === 8, 'the style\'s space-after beats the document default (8, not 99)');
  ok(eff0.lh === 1.5, 'and its line spacing applies too');

  const overridden = block('v', 'h2', { sa: 1 });
  const eff1 = effectiveLayout(doc, overridden);
  ok(eff1.sa === 1, 'the block\'s own space-after beats the style\'s 8');
  ok(eff1.lh === 1.5, 'while the style still supplies what the block did not touch');
}

H('captureStyleFromBlock — the pure half of "Update style to match this paragraph"');
{
  const doc = emptyDoc();
  const b: Block = { id: 'h', kind: 'h1', text: 'A much longer heading', align: 'center', sa: 3,
    marks: [{ t: 'font', from: 0, to: 6, family: 'Georgia, serif', size: 30 }] };
  const patch = captureStyleFromBlock(doc, b);
  ok(patch !== null, 'h1 has an active style, so there is something to capture');
  ok(patch!.align === 'center' && patch!.sa === 3, 'the block\'s own overrides are captured');
  ok(patch!.family === undefined && patch!.size === undefined,
     'a font mark that does not cover the WHOLE block is "mixed", so family/size are left alone');

  b.marks = [{ t: 'font', from: 0, to: b.text.length, family: 'Georgia, serif', size: 30 }];
  const whole = captureStyleFromBlock(doc, b);
  ok(whole!.family === 'Georgia, serif' && whole!.size === 30,
     'a font mark covering the ENTIRE block is captured into the style');

  const noStyleKind = block('t', 'toc');    // no default style, and no explicit styleId
  ok(captureStyleFromBlock(doc, noStyleKind) === null, 'a kind with nothing active captures nothing');
}

// ═══════════════════════════════════════════════════════ save / reload

H('a style, and a block\'s reference to it, survive save/reload');
{
  const doc: TypeDoc = {
    ...emptyDoc(),
    body: [
      block('p1', 'h2', { styleId: 'brand-heading' }),
      block('p2', 'para'),
    ],
    styles: {
      'brand-heading': { id: 'brand-heading', kind: 'h2', name: 'Brand heading',
                          family: 'Georgia, serif', size: 22, weight: 700, italic: true,
                          color: '#204060', align: 'left', sb: 10, sa: 4, lh: 1.3, ind: 12 },
      'default-h1': { ...BUILT_IN_STYLES['default-h1'], size: 40 },   // a materialized built-in too
    },
  };
  const raw = JSON.stringify(doc);
  const r = parseDoc(raw);
  ok(r.ok, 'the file with styles parses');
  if (!r.ok) throw new Error('unreachable');

  ok(r.doc.body[0].styleId === 'brand-heading', 'the block\'s style reference survives');
  const s = r.doc.styles?.['brand-heading'];
  ok(!!s, 'the custom style survives');
  ok(s?.family === 'Georgia, serif' && s?.size === 22 && s?.weight === 700 && s?.italic === true
     && s?.color === '#204060' && s?.align === 'left' && s?.sb === 10 && s?.sa === 4
     && s?.lh === 1.3 && s?.ind === 12,
     'every field of the custom style round-trips exactly');
  ok(r.doc.styles?.['default-h1']?.size === 40, 'a materialized built-in override survives too');
  ok(docStyleCss(r.doc, r.doc.body[0]) === docStyleCss(doc, doc.body[0]),
     'and the reloaded document renders identically to the one that was saved');
}

H('parseDoc repairs a malformed styles map instead of trusting it');
{
  const raw = JSON.stringify({
    format: 'bento/type', version: 1, docId: 'd1', title: 'T',
    page: { width: 816, height: 1056, marginX: 104, marginTop: 104, marginBottom: 104 },
    body: [{ id: 'p1', kind: 'para', text: 'x' }],
    footnotes: {}, revisions: [], signatures: [],
    styles: {
      good: { kind: 'h1', name: 'Good', size: 20, weight: 650, italic: 'yes',
              color: 'red; background:url(https://evil/x.png)', align: 'diagonal', lh: 100 },
      bad1: 'not an object',
      bad2: null,
    },
  });
  const r = parseDoc(raw);
  ok(r.ok, 'still parses — a bad style entry is repaired, not fatal');
  if (!r.ok) throw new Error('unreachable');
  const styles = r.doc.styles ?? {};
  ok(Object.keys(styles).length === 1, `only the one usable entry survives (${Object.keys(styles).join(',')})`);
  const g = styles.good;
  ok(g.kind === 'h1' && g.name === 'Good', 'the valid fields are kept');
  ok(g.size === 20, 'a size inside range is kept');
  // Math.round(6.5) rounds UP in JS (round-half-up), so 650 → 700
  ok(g.weight === 700, `weight 650 rounds to the nearest hundred (${g.weight})`);
  ok(g.italic === undefined, 'a non-boolean italic is dropped, not coerced');
  ok(g.color === undefined, 'a colour that could close its declaration and open another is refused');
  ok(g.align === undefined, 'an align that is not one of the four words is dropped');
  ok(g.lh === undefined, 'a line-height of 100 is outside 0.5–4 and dropped');
}

H('safeStyleColor is an allow-list, defence in depth over the parser\'s own check');
{
  ok(safeStyleColor('#1a1a1a') === '#1a1a1a', 'a hex colour passes');
  ok(safeStyleColor('rgba(10, 20, 30, .5)') === 'rgba(10, 20, 30, .5)', 'an rgba() passes');
  ok(safeStyleColor('crimson') === 'crimson', 'a named colour passes');
  ok(safeStyleColor('red; } body { background: url(https://evil/x.png') === null, 'an injection attempt is refused');
  ok(safeStyleColor(undefined) === null, 'undefined is refused, not printed as "undefined"');
}

H('listStyles offers the built-ins in a stable order, plus any custom ones');
{
  const doc: TypeDoc = { ...emptyDoc(), styles: { 'brand': { id: 'brand', kind: 'para', name: 'Brand body' } } };
  const ids = listStyles(doc).map(s => s.id);
  ok(ids[0] === 'default-body' && ids.includes('default-h1') && ids.includes('default-quote'),
     'the seven built-ins are always offered');
  ok(ids.includes('brand'), 'and a custom style the document defines is offered too');
  ok(lookupStyle(doc, 'brand')?.name === 'Brand body', 'lookupStyle finds it');
}

// ═══════════════════════════════════════════════════════ the live-editor stylesheet
//
// render.ts does NOT write named-style CSS into a block's `style` attribute —
// see docstyles.ts's `styleSheetCss` header for why: layout.ts repaints that
// attribute independently (its own MutationObserver, `blockStyle(b)` alone)
// on every render, and an earlier version of this feature that also wrote
// there had its contribution silently erased microtasks later. Instead a
// `[data-style-id]` stylesheet is injected once and updated in step; the
// editor tags each element with the attribute. This is the part of the
// design that closed a REAL bug, so it gets its own coverage.

H('styleSheetCss — the mechanism the live editor actually uses');
{
  const doc = emptyDoc();
  const css = styleSheetCss(doc);
  ok(css.includes('[data-style-id="default-h1"]'), 'h1\'s built-in gets a rule, unedited or not');
  ok(!css.includes('[data-style-id="default-body"]'),
     'Body is empty, so it gets NO rule at all — an empty selector would be dead weight');
  ok(winner(css.match(/\[data-style-id="default-h2"\]\{([^}]*)\}/)?.[1] ?? '', 'font-size') === '15.5px',
     'each rule carries that style\'s own declarations');

  const edited: TypeDoc = { ...doc, styles: { 'default-h3': { ...BUILT_IN_STYLES['default-h3'], color: '#112233' } } };
  const css2 = styleSheetCss(edited);
  ok(css2.includes('[data-style-id="default-h3"]{') && css2.includes('color:#112233'),
     'editing a built-in changes ITS rule, in place');

  const custom: TypeDoc = { ...doc, styles: { brand: { id: 'brand', kind: 'para', name: 'Brand', size: 19 } } };
  ok(styleSheetCss(custom).includes('[data-style-id="brand"]{font-size:19px}'), 'a custom style gets its own rule too');

  // an id must not be able to close its own attribute selector and inject a
  // second one — defence in depth, since parseDoc already restricts what
  // reaches an id in practice
  const hostile: TypeDoc = { ...doc, styles: { 'x"}body{display:none}[x="y': { id: 'x"}body{display:none}[x="y', kind: 'para', name: 'x', size: 10 } } };
  const hcss = styleSheetCss(hostile);
  ok(hcss.includes('\\"') && !hcss.includes('}body{display:none}[x="y"]{font-size'),
     'a quote inside a style id is escaped, not left to break out of the selector');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
