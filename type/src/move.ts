// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// MOVING A BLOCK.
//
// Until this existed the only way to reorder a paragraph was cut and paste,
// which loses comment anchors and any tracked change attached to it.
//
// THE UNIT IS NOT THE BLOCK. The body is flat, but render.ts groupBlocks
// assembles runs of it into single visible things: a table is a run of `cell`
// blocks sharing a table id, and a list is a run of `ul`/`ol` blocks. Moving
// one member of such a run would tear the table in half or drop a paragraph
// between two bullets. So a move operates on the UNIT — the maximal run that
// renders as one thing — and swaps it with the unit next to it.
//
// A caption travels with what it captions. `caption.of` points at the block,
// and a figure that walks away from its caption leaves a numbered line
// stranded under someone else's paragraph.

import { isList, type Block } from './model.ts';

export interface Unit { start: number; end: number; id: string }

/**
 * The unit containing body[i], as a half-open range.
 *
 * Called with the index of ANY member of a run, not just its first — the
 * caret can be in the third cell of a table, and the unit is still the table.
 */
export function unitAt(body: readonly Block[], i: number): Unit {
  if (i < 0 || i >= body.length) return { start: i, end: i + 1, id: '' };
  const b = body[i];
  let start = i, end = i + 1;

  if (b.kind === 'cell' && b.cell) {
    const table = b.cell.table;
    while (start > 0 && body[start - 1].kind === 'cell' && body[start - 1].cell?.table === table) start--;
    while (end < body.length && body[end].kind === 'cell' && body[end].cell?.table === table) end++;
  } else if (isList(b.kind)) {
    // A maximal run of list blocks, INCLUDING a change of bullet to number.
    // groupBlocks would render those as two lists, so this is deliberately
    // coarser than rendering: moving half of what looks like one block of list
    // is a worse outcome than moving one more paragraph than you meant to.
    while (start > 0 && isList(body[start - 1].kind)) start--;
    while (end < body.length && isList(body[end].kind)) end++;
  } else if (b.kind === 'caption') {
    // Grab the thing being captioned, so a caption is never a unit on its own
    // that could be moved away from its figure.
    const of = b.caption?.of;
    if (of) {
      const owner = body.findIndex(x => x.id === of);
      if (owner >= 0 && owner < i) return unitAt(body, owner);
    }
  }

  // absorb a caption that follows this unit and points into it
  const ids = new Set(body.slice(start, end).map(x => x.id));
  while (end < body.length && body[end].kind === 'caption'
         && body[end].caption?.of && ids.has(body[end].caption!.of!)) end++;

  return { start, end, id: body[start].id };
}

/** Every unit in the body, in order. */
export function units(body: readonly Block[]): Unit[] {
  const out: Unit[] = [];
  let i = 0;
  while (i < body.length) {
    const u = unitAt(body, i);
    out.push(u);
    // unitAt can look BACKWARDS (a caption resolves to its figure), so a unit
    // that starts before where we are would loop forever. Step past regardless.
    i = Math.max(u.end, i + 1);
  }
  return out;
}

/**
 * Move the unit containing `id` one place up or down.
 *
 * Returns a NEW body, or null when it cannot move — at the end of the
 * document, or when the id is not there. Null rather than an unchanged copy so
 * the caller can skip the commit entirely and not put an empty step on the
 * undo stack.
 */
export function moveUnit(body: readonly Block[], id: string, dir: -1 | 1): Block[] | null {
  const i = body.findIndex(b => b.id === id);
  if (i < 0) return null;
  const u = unitAt(body, i);
  const list = units(body);
  const at = list.findIndex(x => x.start === u.start);
  const other = list[at + dir];
  if (!other) return null;

  const block = body.slice(u.start, u.end);
  const rest = body.slice(other.start, other.end);
  const out = body.slice();
  if (dir === 1) out.splice(u.start, block.length + rest.length, ...rest, ...block);
  else out.splice(other.start, rest.length + block.length, ...block, ...rest);
  return out;
}

/** Every index a unit may be dropped BEFORE, plus the end of the body. */
export const boundaries = (body: readonly Block[]): number[] =>
  [...units(body).map(u => u.start), body.length];

/**
 * Move a unit so it sits before `target`.
 *
 * Drag needs this: a drop is an arbitrary destination, not a step. The target
 * is SNAPPED to the nearest unit boundary rather than taken literally, so a
 * drop can never land inside a table or between two bullets however sloppy the
 * gesture was — the same guarantee moveUnit gives, enforced in the engine
 * rather than trusted to the pointer.
 *
 * Returns null when the move would change nothing: dropping a unit on either
 * of its own edges is the commonest gesture in a drag that the user thought
 * better of, and it should not land on the undo stack.
 */
export function moveUnitTo(body: readonly Block[], id: string, target: number): Block[] | null {
  const i = body.findIndex(b => b.id === id);
  if (i < 0) return null;
  const u = unitAt(body, i);

  const edges = boundaries(body);
  const snapped = edges.reduce((best, e) =>
    Math.abs(e - target) < Math.abs(best - target) ? e : best, edges[0]);

  // its own two edges are no-ops
  if (snapped === u.start || snapped === u.end) return null;

  const block = body.slice(u.start, u.end);
  const rest = [...body.slice(0, u.start), ...body.slice(u.end)];
  // after removing the unit, everything past it shifts left by its length
  const at = snapped > u.start ? snapped - block.length : snapped;
  rest.splice(at, 0, ...block);
  return rest;
}

/** Can the unit containing `id` move that way? Drives the disabled state. */
export const canMove = (body: readonly Block[], id: string, dir: -1 | 1): boolean =>
  moveUnit(body, id, dir) !== null;
