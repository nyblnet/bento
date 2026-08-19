// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// TRACKED CHANGES.
//
// Two jobs are easy to confuse, and this app does both:
//
//   redline.ts  — compare two SNAPSHOTS and report what moved. Derived, needs
//                 nothing in the format, works across a file someone mailed
//                 back. This is the review most contracts actually get.
//   track.ts    — record each edit AS IT IS MADE, attributed. This is what
//                 people mean by "turn on track changes", and it is the one a
//                 lawyer expects to see before signing.
//
// They meet in the middle: both produce ins/del marks, so ONE review UI serves
// both and redline can generate a tracked document.
//
// THE REPRESENTATION. A tracked deletion does not remove characters — it marks
// them. That is the whole trick, and everything below follows from it:
//
//   - rejecting a deletion is possible, because the text never left
//   - the marks ride on the same offsets as every other mark, so spliceText
//     moves them for free and the CRDT merges them like any other mark
//   - a block's `text` is no longer what the document SAYS. Anything reading
//     prose out of a block must skip del ranges, which is what textOf is for.
//
// That last point is the sharp edge. Word count, find, print-to-plain, export:
// each has to decide whether it wants the text with deletions or without.

import type { Block, TypeDoc } from './model.ts';
import { spliceText } from './model.ts';
import { normalize, type Mark } from './inline.ts';

/** Is the document recording edits? Absent means no — old files are untracked. */
export const tracking = (doc: TypeDoc): boolean => doc.track === true;

/**
 * The prose a reader sees: insertions included, deletions skipped.
 *
 * Defined in model.ts (which this module imports, so it cannot be the other way
 * round) and re-exported here, where callers look for it. wordCount uses the
 * same function, so the count and the text can never disagree.
 */
export { readerText as textOf } from './model.ts';

/** Every tracked mark in the document, with the block it belongs to. */
export interface Change { block: string; mark: Mark; text: string }
export function changes(doc: TypeDoc): Change[] {
  const out: Change[] = [];
  for (const b of doc.body) {
    for (const m of b.marks ?? []) {
      if (m.t === 'ins' || m.t === 'del') out.push({ block: b.id, mark: m, text: b.text.slice(m.from, m.to) });
    }
  }
  return out;
}

/**
 * Re-express an edit as tracked changes.
 *
 * `prev` is the block before the edit and `next` after — which is what the
 * editor has, because it reads the block back out of contentEditable rather
 * than applying operations. The two are diffed by common prefix and suffix:
 * one removal and one insertion, which is what a keystroke, a paste and a
 * type-over-selection each are.
 *
 * The removal is UNDONE — the characters come back — and marked `del`; the
 * insertion is marked `ins`. So the model keeps every character anyone typed
 * or deleted, and the reader is shown the difference.
 */
export interface Span { head: number; removed: string; added: string }

/**
 * What changed between two versions of a block: one removal and one insertion.
 *
 * Exported because the EDITOR needs the same numbers to place the caret. A
 * tracked deletion restores characters the browser had already taken out, so
 * the caret position contentEditable left behind is wrong by exactly the length
 * of the restored text — and computing that from a second, slightly different
 * diff is how the caret ends up one character off on some edits and not others.
 */
export function editSpan(prev: Block, next: Block): Span {
  const a = prev.text, b = next.text;
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head
         && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { head, removed: a.slice(head, a.length - tail), added: b.slice(head, b.length - tail) };
}

/** Where the caret belongs after `trackEdit` — past anything just typed. */
export const caretAfter = (s: Span): number => s.head + s.added.length;

export function trackEdit(prev: Block, next: Block, by: string, at: string): Block {
  if (prev.text === next.text) return next;
  const { head, removed, added } = editSpan(prev, next);

  // Typing INSIDE an existing deletion would otherwise put new words in the
  // middle of struck-through text, where they read as also deleted. The edit
  // is pushed to the end of the del range instead.
  let out = next;
  if (added) {
    const insAt = head;
    out = markRange(out, insAt, insAt + added.length, 'ins', by, at);
  }
  if (removed) {
    // put the characters back, immediately after the insertion, and mark them
    const restoreAt = head + added.length;
    out = spliceText(out, restoreAt, 0, removed);
    out = markRange(out, restoreAt, restoreAt + removed.length, 'del', by, at);
    // A deletion of text that was itself an untracked INSERTION by the same
    // author is just a correction: drop both rather than showing someone
    // deleting their own unsaved typing.
    out = collapseSelfDeletes(out);
  }
  return out;
}

/** Add a mark over a range, merging with an adjacent same-kind mark by the same author. */
function markRange(b: Block, from: number, to: number, t: 'ins' | 'del', by: string, at: string): Block {
  if (to <= from) return b;
  const marks = [...(b.marks ?? [])];
  const touching = marks.findIndex(m => m.t === t && m.by === by && (m.to === from || m.from === to));
  if (touching >= 0) {
    const m = marks[touching];
    marks[touching] = { ...m, from: Math.min(m.from, from), to: Math.max(m.to, to), at };
  } else {
    marks.push({ t, from, to, by, at });
  }
  const out: Block = { ...b, marks: normalize(marks, b.text.length) };
  if (!out.marks?.length) delete out.marks;
  return out;
}

/** An `ins` range fully covered by a `del` by the same author cancels out. */
function collapseSelfDeletes(b: Block): Block {
  const marks = b.marks ?? [];
  const ins = marks.filter(m => m.t === 'ins');
  const del = marks.filter(m => m.t === 'del');
  for (const d of del) {
    const hit = ins.find(i => i.by === d.by && i.from >= d.from && i.to <= d.to);
    if (!hit) continue;
    // remove the text the pair covers, and both marks with it
    const cut = spliceText(b, d.from, d.to - d.from, '');
    cut.marks = (cut.marks ?? []).filter(m => !(m.t === 'del' && m.from === d.from && m.to === d.from));
    if (!cut.marks.length) delete cut.marks;
    return cut;
  }
  return b;
}

const same = (a: Mark, b: Mark) => a.t === b.t && a.from === b.from && a.to === b.to;

/**
 * Accept or reject one tracked change.
 *
 * accept ins → keep the text, drop the mark      reject ins → drop the text
 * accept del → drop the text                     reject del → keep it, drop the mark
 */
export function resolve(b: Block, mark: Mark, accept: boolean): Block {
  const keepText = mark.t === 'ins' ? accept : !accept;
  if (keepText) {
    const marks = (b.marks ?? []).filter(m => !same(m, mark));
    const out: Block = { ...b };
    if (marks.length) out.marks = marks; else delete out.marks;
    return out;
  }
  // Dropping the text takes the mark with it: spliceText discards marks whose
  // range is entirely inside the removed span.
  const out = spliceText(b, mark.from, mark.to - mark.from, '');
  const marks = (out.marks ?? []).filter(m => !(m.t === mark.t && m.from === mark.from && m.to === mark.from));
  if (marks.length) out.marks = marks; else delete out.marks;
  return out;
}

/** Accept or reject every tracked change in the document, in place. */
export function resolveAll(doc: TypeDoc, accept: boolean): void {
  for (let i = 0; i < doc.body.length; i++) {
    let b = doc.body[i];
    for (;;) {
      // Re-read the marks each pass: resolving one shifts the offsets of the
      // rest, so a cached list would apply the second change at stale
      // coordinates. Slower, and correct.
      const m = (b.marks ?? []).find(x => x.t === 'ins' || x.t === 'del');
      if (!m) break;
      b = resolve(b, m, accept);
    }
    doc.body[i] = b;
  }
}
