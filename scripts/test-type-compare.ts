#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type compare-with-a-file rig.  node scripts/test-type-compare.ts
//
// Two things can be silently wrong about comparing two documents, and neither
// shows up as a crash:
//
//   1. THE DIRECTION. `redline(before, after)` is not symmetric, but its change
//      COUNT is — swap the ends and you get the same number of cards, each one
//      saying the opposite of the truth. A rig that only counted changes would
//      pass against a backwards implementation forever. So every orientation
//      check below reads the CONTENT of a change: their text must arrive as
//      `removed` and ours as `added`, because the panel paints `removed` as
//      <del> and a reader takes <del> to mean "this went away".
//
//   2. WHICH DOCUMENT WAS READ. The other file arrives as a saved shell whose
//      `#bento-doc` block is `<`-escaped (`<`) by the splice contract, or
//      as bare JSON. Read the wrong bytes, or accept another app's file, and
//      the redline is a confident answer to a question nobody asked.
//
// ON THE FIXTURE, which is the part this zone has got wrong before: a rig whose
// fixture is something no real code produces passes forever while the feature
// is broken. So the shell here is THE BUILT ARTIFACT — type/dist-single/
// *.bento.html, what `npm run build:single` writes — whenever it exists, and
// the run says which fixture it used. Where it does not exist (a CI job that
// never built the app), the shell is reconstructed with the same escape rule
// and the run says so out loud, because a fixture standing in for the real
// thing must never be able to pass itself off as it.
//
// The document bodies are built from `emptyDoc()` and the app's own model, not
// typed out as object literals: emptyDoc is what a fresh bento/type document
// actually is, including the fields this rig has never heard of.

import { register } from 'node:module';
register('./lib/ts-resolve-hooks.mjs', import.meta.url);

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const { extractDocJson, readTypeDoc, compareDocs } =
  await import('../type/src/comparedoc.ts');
const { emptyDoc, FORMAT } = await import('../type/src/model.ts');
type TypeDoc = ReturnType<typeof emptyDoc>;

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => {
  checks++;
  if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);

// ─────────────────────────────────────────────────────────────── the fixtures

/**
 * A document with real prose in it, built on top of a real `emptyDoc()`.
 * Block ids are given explicitly because the redline ALIGNS ON THEM — two
 * copies of a contract share ids, which is exactly the case being tested.
 */
function contract(docId: string, terms: string): TypeDoc {
  const d = emptyDoc();
  d.docId = docId;
  d.title = 'Services Agreement';
  d.body = [
    { id: 'p1', kind: 'para', text: 'The parties agree as follows.' },
    { id: 'p2', kind: 'para', text: `Payment is due within ${terms} of invoice.` },
    { id: 'p3', kind: 'para', text: 'This agreement is governed by the laws of Sweden.' },
  ];
  return d;
}

/**
 * The other side's copy, wrapped as a saved file — the real build artifact if
 * one is on disk, otherwise the same bytes assembled by hand.
 *
 * The escaping is the point. kernel/src/save.ts writes the block as
 * `'\n' + body.replace(/</g, '\\u003c') + '\n'` so the JSON can never contain
 * `</script>`; a fixture that skipped it would be testing a file this suite has
 * never written.
 */
const SHELL_RE = /\.bento\.html$/;
function builtShell(): { html: string; real: boolean } {
  const dir = join(root, 'type/dist-single');
  try {
    const f = readdirSync(dir).find(n => SHELL_RE.test(n));
    if (f) return { html: readFileSync(join(dir, f), 'utf8'), real: true };
  } catch { /* not built — fall through */ }
  return { html: '', real: false };
}

const spliceInto = (html: string, doc: unknown): string =>
  html.replace(/(<script[^>]*\bid=["']bento-doc["'][^>]*>)[\s\S]*?(<\/script>)/i,
               (_m, open: string, close: string) =>
                 open + '\n' + JSON.stringify(doc).replace(/</g, '\\u003c') + '\n' + close);

const HANDMADE = '<!DOCTYPE html>\n<html><head>'
  + '<script type="application/bento+json" id="bento-doc">\n{}\n</script>'
  + '</head><body><div id="bento-splash">bento/type</div></body></html>';

const built = builtShell();
console.log(built.real
  ? '\nfixture: type/dist-single/*.bento.html — THE BUILT ARTIFACT'
  : '\nfixture: reconstructed shell (type/dist-single not built; run `npm run build:single` in type/ to test the real one)');
const SHELL = built.real ? built.html : HANDMADE;

// THEIR copy: the same document id, one clause reworded, one clause struck.
const theirs = contract('doc-services-1', '30 days');
// OUR copy: what is open in the editor.
const ours = contract('doc-services-1', 'sixty (60) calendar days');
ours.body = [ours.body[0], ours.body[1],
              { id: 'p4', kind: 'para', text: 'Late payment bears interest at the statutory rate.' }];

H('reading the other file');
{
  const html = spliceInto(SHELL, theirs);
  ok(html.includes('\\u003c') || !JSON.stringify(theirs).includes('<'),
     'the fixture shell carries the splice contract\'s <-escaping');

  const x = extractDocJson(html);
  ok(x.from === 'shell', 'a saved .bento.html is recognised as a shell, not as raw JSON');
  const r = readTypeDoc(html);
  ok(r.ok, 'the document comes back out of it');
  ok(r.ok && r.doc.format === FORMAT, 'and it is a bento/type document');
  ok(r.ok && r.doc.docId === 'doc-services-1', 'with the docId the file carried');
  ok(r.ok && r.doc.body[1].text.includes('30 days'), 'and their wording, not ours');
  ok(r.ok && r.repaired.length === 0, 'a file this app wrote needs no repair');
}

H('a bare document, which is what a chat AI hands back');
{
  const r = readTypeDoc(JSON.stringify(theirs, null, 2));
  ok(extractDocJson('{"format":"x"}').from === 'raw', 'JSON with no shell around it is read as raw');
  ok(r.ok && r.doc.docId === 'doc-services-1', 'and parses to the same document');
}

H('the direction — their text is what was REMOVED');
{
  const cmp = compareDocs(theirs, ours, 'counsel');
  for (const c of cmp.set.changes) console.log(`      · ${c.kind}`);

  const text = cmp.set.changes.filter(c => c.kind === 'text') as Array<
    { blockId: string; removed: string; added: string }>;
  ok(text.length > 0, 'the reworded payment clause is reported as a text change');
  const pay = text.find(c => c.blockId === 'p2');
  ok(!!pay && pay.removed.includes('30'),
     'THEIR "30 days" is the REMOVED side (what the panel paints as <del>)');
  ok(!!pay && pay.added.includes('sixty'),
     'OUR "sixty (60) calendar days" is the ADDED side');
  ok(!!pay && !pay.removed.includes('sixty'),
     'and not the other way round — this is the check a swapped diff fails');

  // The governing-law clause is in their copy and gone from ours: from their
  // file to this document, that is a DELETION. Backwards it would be an insert.
  const dels = cmp.set.changes.filter(c => c.kind === 'block-del') as Array<{ blockId: string }>;
  const ins = cmp.set.changes.filter(c => c.kind === 'block-ins') as Array<{ blockId: string }>;
  ok(dels.some(c => c.blockId === 'p3'),
     'a clause only THEY have reads as a deletion');
  ok(ins.some(c => c.blockId === 'p4'),
     'a clause only WE have reads as an insertion');
  ok(!dels.some(c => c.blockId === 'p4') && !ins.some(c => c.blockId === 'p3'),
     'and neither is reported the wrong way about');
}

H('comparing is a VIEW — it may not touch either document');
{
  const a = contract('doc-a', '30 days'), b = contract('doc-b', '45 days');
  const beforeA = JSON.stringify(a), beforeB = JSON.stringify(b);
  compareDocs(a, b);
  ok(JSON.stringify(a) === beforeA, 'the other document is not mutated');
  ok(JSON.stringify(b) === beforeB, 'and neither is this one');
}

H('the same document, compared with itself');
{
  const cmp = compareDocs(theirs, contract('doc-services-1', '30 days'));
  ok(cmp.identical, 'is reported as identical');
  ok(cmp.set.changes.length === 0, 'with no changes');
  ok(cmp.sameDocId, 'and as the same document');
  // The point of `identical` existing at all: the caller must be able to tell
  // "no differences" from "the comparison never ran", which an empty change
  // list alone cannot do.
  ok('identical' in cmp, 'as a fact of its own, not as an empty list to infer from');
}

H('a different document is legitimate, and worth saying');
{
  const cmp = compareDocs(contract('doc-other', '30 days'), ours);
  ok(!cmp.sameDocId, 'a mismatched docId is reported');
  ok(cmp.set.changes.length > 0, 'but the comparison still runs — it is not an error');
}

H('the files that are not this');
{
  const slides = spliceInto(SHELL, { ...theirs, format: 'bento/slides' });
  const r1 = readTypeDoc(slides);
  ok(!r1.ok && r1.kind === 'other-app', 'another Bento app\'s file is refused as such');
  ok(!r1.ok && r1.found === 'bento/slides', 'and names the app it actually is');

  const r2 = readTypeDoc('<!DOCTYPE html><html><body><h1>a web page</h1></body></html>');
  ok(!r2.ok && r2.kind === 'not-bento',
     'an ordinary web page is "not a Bento document", not a JSON syntax error');

  // A file cut off mid-write. The block is there and the format is right, so
  // nothing before JSON.parse can catch it.
  const truncated = SHELL.replace(
    /(<script[^>]*\bid=["']bento-doc["'][^>]*>)[\s\S]*?(<\/script>)/i,
    (_m, open: string, close: string) => `${open}\n{"format":"bento/type","body":[\n${close}`);
  const r3 = readTypeDoc(truncated);
  ok(!r3.ok && r3.kind === 'json', 'a truncated document block is refused as unreadable JSON');

  const r4 = readTypeDoc('');
  ok(!r4.ok && r4.kind === 'empty', 'an empty file is refused as empty');

  const r5 = readTypeDoc(JSON.stringify({ format: FORMAT, version: 1, docId: 'd', title: 'T' }));
  ok(!r5.ok && r5.kind === 'shape', 'a bento/type document with no body is refused');
}

H('a repaired file says so — a repair can look like a change');
{
  // Duplicate block ids: parseDoc repairs the second deterministically, which
  // changes an id the redline ALIGNS ON. Left unsaid, that surfaces as a
  // deletion and an insertion the author never made.
  const dupes = { ...theirs, body: [theirs.body[0], { ...theirs.body[0], text: 'A second block reusing the id.' }] };
  const r = readTypeDoc(JSON.stringify(dupes));
  ok(r.ok && r.repaired.length > 0, 'the repair is reported to the caller, not swallowed');
}

console.log(`\n${failures ? 'FAILED' : 'passed'} — ${checks - failures}/${checks} checks`);
process.exit(failures ? 1 : 0);
