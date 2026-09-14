#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type block grouping — lists and tables.  node scripts/test-type-blocks.ts
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
import { parseDoc, emptyDoc, MAX_LIST_LEVEL, MAX_TABLE_COLS, type Block, type BlockKind } from '../type/src/model.ts';

let checks = 0, failures = 0;
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s: string) => console.log(`\n=== ${s} ===`);

const b = (kind: BlockKind, text: string, level?: number): Block =>
  ({ id: `${kind}-${text}-${level ?? 0}`, kind, text, ...(level ? { level } : {}) });

/** the token stream as a compact string, so expectations read like the output */
const shape = (body: Block[]) => groupBlocks(body).map(t =>
  t.t === 'open' ? `<${t.kind}>` : t.t === 'close' ? `</${t.kind}>`
  : t.t === 'table' ? `[table ${t.rows.length}x${t.rows[0]?.length ?? 0}${t.head ? ' head' : ''}]`
  : t.block.text).join(' ');

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


// ───────────────────────────────────────────────────────────────── tables
//
// A CELL is a block too, and for a sharper reason than list items: the redline
// aligns on block ids, so per-cell blocks give per-cell review. A table as one
// block would report "the payment table changed" when a single figure moved.

const cell = (table: string, cols: number, text: string, head?: boolean): Block =>
  ({ id: `${table}-${text}`, kind: 'cell', text, cell: { table, cols, ...(head ? { head: true } : {}) } });

H('cells group into a grid');
{
  const body = [
    b('para', 'before'),
    cell('t1', 2, 'a'), cell('t1', 2, 'b'), cell('t1', 2, 'c'), cell('t1', 2, 'd'),
    b('para', 'after'),
  ];
  ok(shape(body) === 'before [table 2x2] after', shape(body));
}

H('a header row is recognised');
{
  const body = [cell('t', 2, 'H1', true), cell('t', 2, 'H2', true), cell('t', 2, 'a'), cell('t', 2, 'b')];
  const tok = groupBlocks(body).find(t => t.t === 'table')!;
  ok(tok.t === 'table' && tok.head === true, 'head is taken from the first cell');
  ok(tok.t === 'table' && tok.rows.length === 2 && tok.rows[0].length === 2, '2x2 including the header');
}

H('two tables side by side stay separate');
{
  const body = [cell('t1', 1, 'a'), cell('t2', 1, 'b')];
  ok(shape(body) === '[table 1x1] [table 1x1]', shape(body));
}

H('a short final row is kept, not dropped');
{
  // five cells in a three-column table: the model can say this and the reader
  // must still see every cell they wrote
  const body = [cell('t', 3, 'a'), cell('t', 3, 'b'), cell('t', 3, 'c'), cell('t', 3, 'd'), cell('t', 3, 'e')];
  const tok = groupBlocks(body).find(t => t.t === 'table')!;
  ok(tok.t === 'table' && tok.rows.length === 2, 'two rows');
  ok(tok.t === 'table' && tok.rows[1].length === 2, 'the last row holds the two remaining cells');
  const all = tok.t === 'table' ? tok.rows.flat().map(x => x.text).join('') : '';
  ok(all === 'abcde', `no cell is lost (${all})`);
}

H('a disagreement about the column count is settled by majority');
{
  // one cell edited by a tool that got `cols` wrong must not reshape the table
  const body = [cell('t', 3, 'a'), cell('t', 3, 'b'), cell('t', 3, 'c'),
                { ...cell('t', 3, 'd'), cell: { table: 't', cols: 7 } } as Block,
                cell('t', 3, 'e'), cell('t', 3, 'f')];
  const tok = groupBlocks(body).find(t => t.t === 'table')!;
  ok(tok.t === 'table' && tok.rows[0].length === 3, `majority wins (got ${tok.t === 'table' ? tok.rows[0].length : '?'})`);
}

H('a table interrupted by a paragraph is two tables');
{
  const body = [cell('t', 1, 'a'), b('para', 'interrupt'), cell('t', 1, 'b')];
  ok(shape(body) === '[table 1x1] interrupt [table 1x1]',
     `same id, but not adjacent — ${shape(body)}`);
}

H('the parser repairs a cell it cannot place');
{
  const doc = emptyDoc();
  const r = parseDoc(JSON.stringify({ ...doc, body: [
    { id: 'ok', kind: 'cell', text: 'fine', cell: { table: 't', cols: 2 } },
    { id: 'noref', kind: 'cell', text: 'orphan' },
    { id: 'wide', kind: 'cell', text: 'huge', cell: { table: 't2', cols: 999 } },
  ] }));
  ok(r.ok, 'it still parses');
  if (r.ok) {
    ok(r.doc.body[0].kind === 'cell', 'a good cell survives');
    ok(r.doc.body[1].kind === 'para', 'a cell with no placement becomes a paragraph');
    ok(r.doc.body[2].cell?.cols === MAX_TABLE_COLS, `runaway columns clamped to ${MAX_TABLE_COLS}`);
    ok(r.repaired.length >= 2, 'and both repairs are reported');
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
