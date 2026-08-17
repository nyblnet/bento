#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type list grouping.  node scripts/test-type-lists.ts
//
// A list ITEM is a block; the list itself is not in the model. Runs of adjacent
// `ul`/`ol` blocks are grouped into real <ul>/<ol> elements at render time,
// nested by `level`. That keeps the document flat, which the redline (aligns on
// block ids), the caret (blockId + offset) and pagination (measures line boxes
// through a tree walker) all depend on.
//
// Everything interesting therefore lives in ONE pure function, groupBlocks, and
// two consumers that must agree: the editor builds DOM from its tokens, print
// builds a string. A list that nests on screen and not on paper is the failure
// this rig exists to prevent — print already had it, scanning its own output
// backwards for the last open tag and finding one it had closed.

import { groupBlocks } from '../type/src/render.ts';
import { parseDoc, emptyDoc, MAX_LIST_LEVEL, type Block, type BlockKind } from '../type/src/model.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);

const b = (kind: BlockKind, text: string, level?: number): Block =>
  ({ id: `${kind}-${text}-${level ?? 0}`, kind, text, ...(level ? { level } : {}) });

/** the token stream as a compact string, so expectations read like the output */
const shape = (body: Block[]) => groupBlocks(body).map(t =>
  t.t === 'open' ? `<${t.kind}>` : t.t === 'close' ? `</${t.kind}>` : t.block.text).join(' ');

/** every open has a matching close, in the right order */
function wellFormed(body: Block[]): boolean {
  const stack: string[] = [];
  for (const t of groupBlocks(body)) {
    if (t.t === 'open') stack.push(t.kind);
    else if (t.t === 'close') { if (stack.pop() !== t.kind) return false; }
  }
  return stack.length === 0;
}

H('a run of items becomes one list');
{
  const body = [b('para', 'before'), b('ul', 'a'), b('ul', 'b'), b('para', 'after')];
  ok(shape(body) === 'before <ul> a b </ul> after', shape(body));
  ok(wellFormed(body), 'well formed');
}

H('nesting by level');
{
  const body = [b('ul', 'a'), b('ul', 'a1', 1), b('ul', 'a2', 1), b('ul', 'c')];
  ok(shape(body) === '<ul> a <ul> a1 a2 </ul> c </ul>', shape(body));
  ok(wellFormed(body), 'well formed');
}

H('a change of kind at the same depth starts a new list');
{
  // bullets and numbers are different lists even when equally indented —
  // without this they would share one <ul> and the numbers would vanish
  const body = [b('ul', 'a'), b('ol', '1')];
  ok(shape(body) === '<ul> a </ul> <ol> 1 </ol>', shape(body));
  ok(wellFormed(body), 'well formed');
}

H('a nested list of the other kind');
{
  const body = [b('ol', '1'), b('ul', 'bullet', 1), b('ol', '2')];
  ok(shape(body) === '<ol> 1 <ul> bullet </ul> 2 </ol>', shape(body));
  ok(wellFormed(body), 'well formed');
}

H('unwinding several levels at once');
{
  const body = [b('ul', 'a'), b('ul', 'deep', 3), b('para', 'out')];
  const s = shape(body);
  ok(s === '<ul> a <ul> <ul> <ul> deep </ul> </ul> </ul> </ul> out', s);
  ok(wellFormed(body), 'every level is closed before the paragraph');
}

H('a list that starts indented, and one that ends the document');
{
  ok(wellFormed([b('ul', 'orphan', 2)]), 'an item with no parent item still closes');
  ok(wellFormed([b('para', 'p'), b('ul', 'last')]), 'a trailing list is closed at the end');
  ok(shape([]) === '', 'an empty document yields nothing');
}

H('non-list blocks are untouched');
{
  const body = [b('h1', 'T'), b('para', 'p'), b('quote', 'q')];
  ok(shape(body) === 'T p q', shape(body));
  ok(groupBlocks(body).every(t => t.t === 'block'), 'no list tokens at all');
}

H('the parser accepts lists and clamps the level');
{
  const doc = emptyDoc();
  const json = JSON.stringify({
    ...doc,
    body: [
      { id: 'a', kind: 'ul', text: 'item' },
      { id: 'b', kind: 'ol', text: 'num', level: 2 },
      { id: 'c', kind: 'ul', text: 'deep', level: 99 },
      { id: 'd', kind: 'para', text: 'p', level: 3 },
    ],
  });
  const r = parseDoc(json);
  ok(r.ok, 'a document with lists parses');
  if (r.ok) {
    ok(r.doc.body[0].kind === 'ul' && r.doc.body[1].kind === 'ol', 'both list kinds survive');
    ok(r.doc.body[1].level === 2, 'a valid level survives');
    ok(r.doc.body[2].level === MAX_LIST_LEVEL,
       `a runaway level is clamped to ${MAX_LIST_LEVEL} (got ${r.doc.body[2].level})`);
    ok(r.doc.body[3].level === undefined, 'a level on a paragraph is dropped, not kept as dead data');
    ok(r.repaired.some(x => /clamped/.test(x)), 'and the clamp is reported, not silent');
  }
}

H('a level is never trusted to be sane');
{
  // Generators produce these; the renderer must not be the thing that notices.
  for (const lv of [-1, 0.5, 1e9]) {
    const body = [b('ul', 'x'), { ...b('ul', 'y'), level: lv } as Block];
    ok(wellFormed(body), `level ${lv} still produces balanced output`);
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
