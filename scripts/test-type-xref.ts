#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type captions, numbering and cross-references.  node scripts/test-type-xref.ts
//
// The claim under test is one sentence: a number is NEVER stored, so inserting
// a table in the middle of a document renumbers everything after it and every
// reference to it follows — and a reference whose target was deleted says so
// out loud instead of rendering as nothing.
//
// All of it is pure functions over the body, which is why this rig is plain
// node with no DOM: numbering is `captionEntries`, resolution is `refText`, and
// the two consumers (the editor's DOM pass and print's string pass) both fill
// the same atoms from the same index — `fillXrefsHtml` is checked here so that
// paper cannot drift from the screen.

import {
  captionEntries, captionIndex, refText, refsIn, brokenRefs, shiftRefs, withRef,
  newCaption, captionSite, captionForObject, refAtoms, captionPrefixHtml,
  fillXrefsHtml, resolvedText, captionWord, docLang, joinLabel, CAPTION, BROKEN_TEXT,
  type CaptionKind,
} from '../type/src/xref.ts';
import { emptyDoc, type Block, type TypeDoc } from '../type/src/model.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);

const para = (id: string, text = ''): Block => ({ id, kind: 'para', text });
const cell = (id: string, table: string, text = ''): Block =>
  ({ id, kind: 'cell', text, cell: { table, cols: 2 } });
const cap = (id: string, kind: CaptionKind, text: string, of?: string): Block =>
  ({ id, kind: CAPTION, text, caption: { kind, ...(of ? { of } : {}) } });

const labels = (body: Block[], lang = 'en') => captionEntries(body, lang).map(e => e.label).join(' | ');

// ────────────────────────────────────────────────────────────────────────────
H('numbering runs in document order, per kind');
{
  const body = [
    para('p1', 'intro'),
    cap('c1', 'table', 'Fees'),
    para('p2', 'text'),
    cap('c2', 'figure', 'The site'),
    cap('c3', 'table', 'Milestones'),
    cap('c4', 'figure', 'The plan'),
  ];
  ok(labels(body) === 'Table 1 | Figure 1 | Table 2 | Figure 2', labels(body));
  const e = captionEntries(body);
  ok(e[2].n === 2 && e[2].kind === 'table', 'the second table is Table 2');
  ok(e.every(x => x.index === body.findIndex(b => b.id === x.id)), 'each entry knows where it sits');
}

H('two kinds are counted independently');
{
  // a document that is all figures and then all tables must not run one counter
  const body = [cap('f1', 'figure', 'a'), cap('f2', 'figure', 'b'),
                cap('t1', 'table', 'c'), cap('t2', 'table', 'd')];
  ok(labels(body) === 'Figure 1 | Figure 2 | Table 1 | Table 2', labels(body));
}

H('a document with no captions');
{
  const body = [para('p1', 'nothing here'), para('p2', 'nor here')];
  ok(captionEntries(body).length === 0, 'no entries');
  ok(captionIndex(body).size === 0, 'an empty index');
  ok(refsIn(body).length === 0 && brokenRefs(body).length === 0, 'and nothing to resolve');
  ok(fillXrefsHtml('<p>plain text</p>', captionIndex(body)) === '<p>plain text</p>',
     'filling leaves ordinary markup untouched');
}

// ────────────────────────────────────────────────────────────────────────────
H('inserting a table in the MIDDLE renumbers everything after it');
{
  const before = [cap('c1', 'table', 'first'), cap('c2', 'table', 'second'), cap('c3', 'table', 'third')];
  ok(labels(before) === 'Table 1 | Table 2 | Table 3', labels(before));

  // the whole point: a number in the JSON would be wrong from here on
  const after = [before[0], cap('cNEW', 'table', 'inserted'), before[1], before[2]];
  ok(labels(after) === 'Table 1 | Table 2 | Table 3 | Table 4', labels(after));
  const idx = captionIndex(after);
  ok(idx.get('cNEW')!.n === 2, 'the newcomer is Table 2');
  ok(idx.get('c2')!.n === 3 && idx.get('c3')!.n === 4, 'the two below it moved down');
  ok(!('n' in (after[0] as unknown as Record<string, unknown>)), 'and no number is on the block');
  ok(JSON.stringify(after).indexOf('"n":') < 0, 'nothing numeric entered the document JSON');
}

H('a reference resolves to the right number, and follows the target');
{
  const ref = { to: 'c2', at: 12 };
  const body = [
    cap('c1', 'table', 'Fees'),
    cap('c2', 'table', 'Milestones'),
    { ...para('p', 'as set out in , payment follows.'), refs: [ref] },
  ];
  ok(refText(captionIndex(body), ref).text === 'Table 2', 'resolves to Table 2');

  const moved = [body[1], body[0], body[2]];        // the target is now first
  ok(refText(captionIndex(moved), ref).text === 'Table 1', 'and to Table 1 once it moves up');
  ok(refsIn(body).length === 1 && brokenRefs(body).length === 0, 'one reference, none broken');
}

H('a reference to a DELETED target degrades visibly, and is never dropped');
{
  const ref = { to: 'gone', at: 3 };
  const body = [cap('c1', 'table', 'Fees'), { ...para('p', 'see  above'), refs: [ref] }];
  const r = refText(captionIndex(body), ref);
  ok(r.ok === false, 'it does not resolve');
  ok(r.text === BROKEN_TEXT && r.text.length > 0, `it renders as ${BROKEN_TEXT}, never as nothing`);
  ok(brokenRefs(body).length === 1, 'and the panel can list it');

  const html = fillXrefsHtml(refAtoms(body[1]).get(3)!, captionIndex(body));
  ok(html.includes('t-xref-broken'), 'the rendered atom carries the broken class');
  ok(html.includes(BROKEN_TEXT), 'and the visible text says so');

  // restoring the table must heal it with no repair step — which is only true
  // because the reference was kept in the model
  const healed = [...body, cap('gone', 'table', 'Restored')];
  ok(refText(captionIndex(healed), ref).text === 'Table 2', 'restoring the target heals the reference');
}

H('page and both styles, and their degradation');
{
  const body = [cap('c1', 'table', 'Fees')];
  const idx = captionIndex(body);
  const pageOf = (id: string) => (id === 'c1' ? 7 : undefined);
  ok(refText(idx, { to: 'c1', at: 0, style: 'page' }, { pageOf }).text === 'page 7', 'page style');
  ok(refText(idx, { to: 'c1', at: 0, style: 'both' }, { pageOf }).text === 'Table 1 (page 7)', 'both style');
  ok(refText(idx, { to: 'c1', at: 0, style: 'page' }).text === 'Table 1',
     'with no pagination it degrades to the label, never to a guess');
}

// ────────────────────────────────────────────────────────────────────────────
H('the atoms occupy a position and no characters');
{
  const b = withRef(para('p', 'see  and .'), 4, 'c1');
  ok(b.text === 'see  and .', 'the text is unchanged by adding a reference');
  ok(b.refs!.length === 1 && b.refs![0].at === 4, 'the anchor is an offset');
  const two = withRef(b, 9, 'c2');
  ok(two.refs!.map(r => r.at).join(',') === '4,9', 'anchors stay sorted');
  ok(refAtoms(two).size === 2, 'two atoms to inject');
  ok(!/>[^<]*[A-Za-z]/.test(refAtoms(two).get(4)!.replace(BROKEN_TEXT, '')),
     'the atom carries no words of its own — they are filled from the index');
}

H('anchors follow an edit, by the same rule footnotes use');
{
  const refs = [{ to: 'a', at: 2 }, { to: 'b', at: 10 }, { to: 'c', at: 20 }];
  const after = shiftRefs(refs, 5, 0, 3);                    // insert 3 chars at 5
  ok(after.map(r => r.at).join(',') === '2,13,23', `insertion pushes later anchors (${after.map(r => r.at)})`);
  const del = shiftRefs(refs, 8, 6, 0);                      // delete 8..14
  ok(del.map(r => r.to).join(',') === 'a,c', 'an anchor inside deleted text goes with it');
  ok(del.map(r => r.at).join(',') === '2,14', 'and the rest close up');
  ok(shiftRefs(refs, 0, 0, 0).length === 3, 'a no-op edit changes nothing');
}

H('caption placement: after the whole table, not inside it');
{
  const body = [para('p0'), cell('a', 't1'), cell('b', 't1'), cell('c', 't1'), cell('d', 't1'), para('p1')];
  const site = captionSite(body, 2)!;                          // caret in cell b
  ok(site.at === 5, `the caption lands after the last cell (${site.at})`);
  ok(site.kind === 'table' && site.of === 't1', 'and it captions that table');
  const fig = captionSite(body, 0)!;
  ok(fig.kind === 'figure' && fig.at === 1, 'outside a table it is a figure caption');
  ok(captionSite([cap('c1', 'table', 'x')], 0) === null, 'a caption cannot be captioned');

  const withCap = [...body.slice(0, 5), cap('c1', 'table', 'Fees', 't1'), ...body.slice(5)];
  ok(captionForObject(withCap, 't1')?.id === 'c1', 'a table with a caption is recognised');
  ok(captionForObject(withCap, 't9') === undefined, 'and one without is not');
}

H('a caption id is minted once and is what references point at');
{
  const a = newCaption('table', 't1');
  const b = newCaption('table', 't1');
  ok(a.id !== b.id && a.id.startsWith('cap-'), 'ids are fresh and prefixed');
  ok(a.kind === CAPTION && a.caption!.kind === 'table' && a.caption!.of === 't1', 'shape');
  ok(captionEntries([a]).at(0)!.id === a.id, 'the entry is keyed by the BLOCK id');
}

// ────────────────────────────────────────────────────────────────────────────
H('screen and paper fill the same atoms from the same index');
{
  const body = [
    cap('c1', 'table', 'Fee schedule'),
    { ...para('p', 'as in  above'), refs: [{ to: 'c1', at: 6 }] },
  ];
  const idx = captionIndex(body);
  const capHtml = fillXrefsHtml(captionPrefixHtml(body[0]) + 'Fee schedule', idx);
  ok(capHtml.startsWith('<span class="t-cap-num" data-cap="c1">Table 1.</span>'),
     `the caption label is derived into the atom — ${capHtml.slice(0, 60)}`);
  const refHtml = fillXrefsHtml(`as in ${refAtoms(body[1]).get(6)!} above`, idx);
  ok(refHtml.includes('>Table 1<'), 'and so is the reference');
  ok(!refHtml.includes('t-xref-broken'), 'a good reference is not flagged');
}

H('the document as prose, with references resolved');
{
  const doc = { ...emptyDoc(), body: [
    cap('c1', 'table', 'Fee schedule'),
    { ...para('p', 'Payment follows .'), refs: [{ to: 'c1', at: 16 }] },
  ] } as TypeDoc;
  const text = resolvedText(doc);
  ok(text.includes('Table 1. Fee schedule'), 'the caption reads with its label');
  ok(text.includes('Payment follows Table 1.'), `and the sentence reads as the reader sees it — ${text.split('\n')[1]}`);
}

// ────────────────────────────────────────────────────────────────────────────
H('the label is the DOCUMENT’s language, not the reader’s');
{
  ok(captionWord('table', 'fr') === 'Tableau' && captionWord('figure', 'de') === 'Abbildung',
     'the words are looked up by language tag');
  ok(captionWord('table', 'fr-CA') === 'Tableau', 'a region falls back to the base language');
  ok(captionWord('figure', 'zh-TW') === '圖' && captionWord('figure', 'zh-CN') === '图',
     'and Chinese resolves by script, not by region alone');
  ok(captionWord('table', 'fi') === 'Table', 'an unknown language reads English, never empty');
  ok(joinLabel('表', 2, 'ja') === '表2' && joinLabel('Tableau', 2, 'fr') === 'Tableau 2',
     'CJK sets the number tight, Latin scripts space it');

  const body = [cap('c1', 'table', 'Barème')];
  ok(labels(body, 'fr') === 'Tableau 1', 'a French document says Tableau');
  ok(labels(body, 'en') === 'Table 1', 'and the same bytes in an English one say Table');

  ok(docLang({ lang: 'fr-FR' }) === 'fr-fr' && docLang({}) === 'en',
     'the language comes off the document, defaulting to English');
  const doc = { ...emptyDoc(), lang: 'de', body } as TypeDoc;
  ok(resolvedText(doc).startsWith('Tabelle 1.'), 'and the whole document follows it');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
