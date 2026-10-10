#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Moving a block — and never tearing one in half.
//
//   node scripts/test-type-move.ts
//
// The body is FLAT but the rendering is grouped, so the interesting cases are
// all about runs: a table is consecutive `cell` blocks sharing a table id, a
// list is consecutive ul/ol blocks. Move one member of a run and you split a
// table down the middle or drop a paragraph between two bullets. Every check
// here is a way that could happen.

import { register } from 'node:module';
register('./lib/ts-resolve-hooks.mjs', import.meta.url);

const { unitAt, units, moveUnit, canMove } = await import('../type/src/move.ts');

let checks = 0, bad = 0;
const ok = (c: boolean, m: string) => { checks++; if (c) console.log(`  ok    ${m}`); else { bad++; console.log(`  FAIL  ${m}`); } };
const eq = (a: unknown, b: unknown, m: string) => {
  const same = JSON.stringify(a) === JSON.stringify(b);
  checks++;
  if (same) console.log(`  ok    ${m}`);
  else { bad++; console.log(`  FAIL  ${m}\n        got  ${JSON.stringify(a)}\n        want ${JSON.stringify(b)}`); }
};

const p = (id: string) => ({ id, kind: 'para', text: id });
const li = (id: string, level = 0) => ({ id, kind: 'ul', text: id, level });
const cell = (id: string, table: string) => ({ id, kind: 'cell', text: id, cell: { table, cols: 2 } });
const cap = (id: string, of: string) => ({ id, kind: 'caption', text: id, caption: { kind: 'figure', of } });
const img = (id: string) => ({ id, kind: 'image', text: '', image: { src: 'x' } });
const ids = (body: readonly { id: string }[]) => body.map(b => b.id);

console.log('\n— plain paragraphs —');
{
  const body = [p('a'), p('b'), p('c')];
  eq(ids(moveUnit(body, 'b', -1)!), ['b', 'a', 'c'], 'up swaps with the one above');
  eq(ids(moveUnit(body, 'b', 1)!), ['a', 'c', 'b'], 'down swaps with the one below');
  ok(moveUnit(body, 'a', -1) === null, 'the first cannot go up');
  ok(moveUnit(body, 'c', 1) === null, 'the last cannot go down');
  ok(moveUnit(body, 'nope', 1) === null, 'an unknown id moves nothing');
  ok(!canMove(body, 'a', -1) && canMove(body, 'a', 1), 'canMove agrees');
}

console.log('\n— a table is one thing —');
{
  const body = [p('a'), cell('c1', 't'), cell('c2', 't'), cell('c3', 't'), cell('c4', 't'), p('z')];
  const u = unitAt(body, 2);            // asked about the SECOND cell
  eq([u.start, u.end], [1, 5], 'any cell resolves to the whole table');
  eq(ids(moveUnit(body, 'c1', 1)!), ['a', 'z', 'c1', 'c2', 'c3', 'c4'],
     'the table moves down as a block, past the paragraph');
  eq(ids(moveUnit(body, 'c3', -1)!), ['c1', 'c2', 'c3', 'c4', 'a', 'z'],
     'and a move asked from a middle cell moves the whole table');
  eq(ids(moveUnit(body, 'a', 1)!), ['c1', 'c2', 'c3', 'c4', 'a', 'z'],
     'a paragraph jumps the ENTIRE table, never into it');
  // two adjacent tables must not merge into one unit
  const two = [cell('x1', 't1'), cell('x2', 't1'), cell('y1', 't2'), cell('y2', 't2')];
  eq(units(two).map(u2 => [u2.start, u2.end]), [[0, 2], [2, 4]], 'two tables are two units');
  eq(ids(moveUnit(two, 'y1', -1)!), ['y1', 'y2', 'x1', 'x2'], 'and they swap whole');
}

console.log('\n— a list is one thing —');
{
  const body = [p('a'), li('l1'), li('l2', 1), li('l3'), p('z')];
  eq([unitAt(body, 3).start, unitAt(body, 3).end], [1, 4], 'any item resolves to the whole list');
  eq(ids(moveUnit(body, 'a', 1)!), ['l1', 'l2', 'l3', 'a', 'z'],
     'a paragraph jumps the whole list, never landing between bullets');
  eq(ids(moveUnit(body, 'l2', 1)!), ['a', 'z', 'l1', 'l2', 'l3'],
     'and the list moves as one, asked from a nested item');
}

console.log('\n— a caption travels with its figure —');
{
  const body = [p('a'), img('f1'), cap('c1', 'f1'), p('z')];
  eq([unitAt(body, 1).start, unitAt(body, 1).end], [1, 3], 'the figure unit absorbs its caption');
  eq([unitAt(body, 2).start, unitAt(body, 2).end], [1, 3], 'and asking about the caption gives the same unit');
  eq(ids(moveUnit(body, 'f1', 1)!), ['a', 'z', 'f1', 'c1'], 'they move together');
  eq(ids(moveUnit(body, 'c1', -1)!), ['f1', 'c1', 'a', 'z'], 'from either end');
  // a caption is never left as an orphan unit that could outrun its figure
  ok(!units(body).some(u => u.end - u.start === 1 && body[u.start].kind === 'caption'),
     'no caption is ever a unit on its own');
}

console.log('\n— a captioned table —');
{
  const body = [cell('c1', 't'), cell('c2', 't'), cap('cp', 'c1'), p('z')];
  eq([unitAt(body, 0).start, unitAt(body, 0).end], [0, 3], 'the table unit absorbs its caption too');
  eq(ids(moveUnit(body, 'c1', 1)!), ['z', 'c1', 'c2', 'cp'], 'and all three move as one');
}

console.log('\n— units() terminates and covers everything —');
{
  const body = [p('a'), img('f'), cap('c', 'f'), li('l1'), li('l2'), cell('t1', 't'), p('z')];
  const us = units(body);
  eq(us.map(u => [u.start, u.end]), [[0, 1], [1, 3], [3, 5], [5, 6], [6, 7]], 'the body partitions cleanly');
  // Every block belongs to exactly one unit — no gaps, no overlaps. A caption
  // resolving BACKWARDS to its figure is what could have made units() loop.
  const covered = us.flatMap(u => Array.from({ length: u.end - u.start }, (_, k) => u.start + k));
  eq(covered, body.map((_, k) => k), 'every block is covered exactly once');
}

console.log('\n— a move is a permutation, never a loss —');
{
  const body = [p('a'), li('l1'), li('l2'), cell('t1', 't'), cell('t2', 't'), img('f'), cap('c', 'f'), p('z')];
  for (const id of ['a', 'l1', 't1', 'f', 'z']) {
    for (const dir of [-1, 1] as const) {
      const out = moveUnit(body, id, dir);
      if (!out) continue;
      eq(ids(out).slice().sort(), ids(body).slice().sort(), `${id} ${dir < 0 ? 'up' : 'down'} keeps every block`);
      eq(out.length, body.length, `${id} ${dir < 0 ? 'up' : 'down'} changes no count`);
    }
  }
}

console.log('\n— up then down is the identity —');
{
  const body = [p('a'), li('l1'), li('l2'), p('z')];
  const down = moveUnit(body, 'a', 1)!;
  eq(ids(moveUnit(down, 'a', -1)!), ids(body), 'moving down then up restores the order');
}

console.log('\n— dropping a unit anywhere (what a drag does) —');
{
  const { moveUnitTo, boundaries } = await import('../type/src/move.ts');
  const body = [p('a'), li('l1'), li('l2'), cell('t1', 't'), cell('t2', 't'), p('z')];
  eq(boundaries(body), [0, 1, 3, 5, 6], 'the legal drop points are the unit edges and the end');

  eq(ids(moveUnitTo(body, 'a', 6)!), ['l1', 'l2', 't1', 't2', 'z', 'a'], 'a paragraph dropped at the end');
  eq(ids(moveUnitTo(body, 'z', 0)!), ['z', 'a', 'l1', 'l2', 't1', 't2'], 'and one dropped at the start');
  eq(ids(moveUnitTo(body, 'l1', 6)!), ['a', 't1', 't2', 'z', 'l1', 'l2'], 'a whole list travels');
  eq(ids(moveUnitTo(body, 't1', 1)!), ['a', 't1', 't2', 'l1', 'l2', 'z'], 'and a whole table');

  // A sloppy drop must never land INSIDE a table or a list. Ties snap to the
  // EARLIER boundary, which is arbitrary but deterministic; the UI measures in
  // pixels, where an exact tie is vanishingly unlikely.
  eq(ids(moveUnitTo(body, 'a', 4)!), ['l1', 'l2', 'a', 't1', 't2', 'z'],
     'a drop aimed between two table cells snaps to the table edge');
  eq(ids(moveUnitTo(body, 'z', 2)!), ['a', 'z', 'l1', 'l2', 't1', 't2'],
     'and one aimed between two bullets snaps out of the list');
  ok(moveUnitTo(body, 'a', 2) === null,
     'a drop aimed into the list from the block right above it snaps back to where it already is');

  ok(moveUnitTo(body, 'a', 0) === null, 'dropping a unit on its own leading edge is a no-op');
  ok(moveUnitTo(body, 'a', 1) === null, 'and on its own trailing edge');
  ok(moveUnitTo(body, 'nope', 0) === null, 'an unknown id moves nothing');

  for (const target of [0, 1, 2, 3, 4, 5, 6]) {
    const out = moveUnitTo(body, 'l1', target);
    if (!out) continue;
    eq(ids(out).slice().sort(), ids(body).slice().sort(), `drop at ${target} keeps every block`);
  }
}

console.log('\n— the shortcut matcher, which every other shortcut shares —');
{
  const { matchKey, registerKey } = await import('../type/src/features.ts');
  const ev = (o: Record<string, unknown>) =>
    ({ key: 'ArrowUp', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...o }) as never;

  registerKey({ key: 'arrowup', ctrl: true, shift: true, run() {} });
  registerKey({ key: 'arrowdown', alt: true, shift: true, run() {} });

  ok(!!matchKey(ev({ ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Up matches the ctrl binding');
  // The whole reason `ctrl` exists: mod conflates ⌘ with Ctrl, and ⌘⇧↑ is
  // "select to the start of the document" on a Mac. It must NOT move a block.
  ok(!matchKey(ev({ metaKey: true, shiftKey: true })), 'Cmd+Shift+Up does NOT');
  ok(!matchKey(ev({ ctrlKey: true })), 'Ctrl+Up alone does not');
  ok(!matchKey(ev({ ctrlKey: true, shiftKey: true, altKey: true })), 'nor with Alt added');
  ok(!!matchKey(ev({ key: 'ArrowDown', altKey: true, shiftKey: true })), 'Alt+Shift+Down matches the alt binding');
  ok(!matchKey(ev({ key: 'ArrowDown', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Down does not match it');

  // an existing mod binding still behaves exactly as before
  registerKey({ key: 'b', mod: true, run() {} });
  ok(!!matchKey(ev({ key: 'b', metaKey: true })), 'mod still matches Cmd');
  ok(!!matchKey(ev({ key: 'b', ctrlKey: true })), 'and still matches Ctrl');
}

console.log(`\n${checks - bad}/${checks} checks passed`);
if (bad) process.exit(1);
