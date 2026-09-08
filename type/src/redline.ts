// SPDX-License-Identifier: MIT
// Redlining for bento/type.
//
// A redline is NOT a CRDT op log. CRDT ops are mechanical, auto-merged and
// per-keystroke; a redline is semantic, attributable, and above all REVIEWED —
// a human accepts or rejects each one. The op log may be a source for building
// one, but the change set is its own object with its own correctness rules.
//
// The two invariants everything else rests on:
//     accept(all)  ==  the document they sent back
//     reject(all)  ==  the document you sent
// If either fails, "review these changes" is a lie, because the reviewer's
// choices do not add up to either endpoint. Every other property (attribution,
// signing, partial acceptance) is worthless without those two.
//
// Granularity is WORDS, not lines and not characters. Line diffs are useless on
// prose (a reflowed paragraph reads as wholly rewritten); character diffs are
// technically correct and unreadable, marking "30" → "60" as a change of one
// glyph inside a word nobody can see.

import type { Block } from './model.ts';
import type { Mark } from './inline.ts';

export type Change =
  | { id: string; kind: 'text'; blockId: string; at: number; removed: string; added: string; author: string }
  | { id: string; kind: 'format'; blockId: string; before: Mark[]; after: Mark[]; author: string }
  | { id: string; kind: 'block-ins'; blockId: string; block: Block; index: number; author: string }
  | { id: string; kind: 'block-del'; blockId: string; block: Block; author: string }
  | { id: string; kind: 'reorder'; from: string[]; to: string[]; author: string };

export interface ChangeSet { base: string; author: string; changes: Change[] }

/** Split into words + the whitespace between them, so joins are lossless. */
export function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/**
 * Myers-style LCS over tokens, returned as a compact op list.
 * O(n·m) memory is fine here: a paragraph is hundreds of tokens, not millions,
 * and blocks are diffed independently.
 */
export function diffTokens(a: string[], b: string[]): Array<{ op: string; tokens: string[] }> {
  const n = a.length, m = b.length;
  // trim the common head and tail first — in a redline most of a paragraph is
  // untouched, so this is the difference between instant and quadratic
  let s = 0;
  while (s < n && s < m && a[s] === b[s]) s++;
  let e = 0;
  while (e < n - s && e < m - s && a[n - 1 - e] === b[m - 1 - e]) e++;
  const A = a.slice(s, n - e), B = b.slice(s, m - e);

  const N = A.length, M = B.length;
  const lcs = Array.from({ length: N + 1 }, () => new Uint32Array(M + 1));
  for (let i = N - 1; i >= 0; i--)
    for (let j = M - 1; j >= 0; j--)
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const ops: Array<{ op: string; tokens: string[] }> = [];
  const push = (op: string, tokens: string[]) => {
    if (!tokens.length) return;
    const last = ops[ops.length - 1];
    if (last && last.op === op) last.tokens.push(...tokens);
    else ops.push({ op, tokens: [...tokens] });
  };
  push('eq', a.slice(0, s));
  let i = 0, j = 0;
  while (i < N && j < M) {
    if (A[i] === B[j]) { push('eq', [A[i]]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push('del', [A[i]]); i++; }
    else { push('ins', [B[j]]); j++; }
  }
  push('del', A.slice(i));
  push('ins', B.slice(j));
  push('eq', a.slice(n - e));
  return ops;
}

/**
 * A change set between two revisions of a document.
 *
 * Blocks are aligned by id where both sides have one — which is why stable ids
 * matter: without them a moved paragraph reads as a delete plus an unrelated
 * insert, and the reviewer sees two changes where the author made one.
 */
export function redline(
  before: { docId: string; body: Block[] },
  after: { docId: string; body: Block[] },
  { author = 'anon' }: { author?: string } = {},
): ChangeSet {
  const changes: Change[] = [];
  let seq = 0;
  const id = () => `c${++seq}`;

  const beforeById = new Map(before.body.map(b => [b.id, b]));
  const afterById = new Map(after.body.map(b => [b.id, b]));

  // blocks removed outright
  for (const b of before.body) {
    if (!afterById.has(b.id)) {
      changes.push({ id: id(), kind: 'block-del', blockId: b.id, block: b, author });
    }
  }
  // blocks added outright
  after.body.forEach((b, index) => {
    if (!beforeById.has(b.id)) {
      changes.push({ id: id(), kind: 'block-ins', blockId: b.id, block: b, index, author });
    }
  });
  // blocks present on both sides: diff their text, and note reordering
  const beforeOrder = before.body.filter(b => afterById.has(b.id)).map(b => b.id);
  const afterOrder = after.body.filter(b => beforeById.has(b.id)).map(b => b.id);
  if (beforeOrder.join() !== afterOrder.join()) {
    changes.push({ id: id(), kind: 'reorder', from: beforeOrder, to: afterOrder, author });
  }
  // A formatting change is a change. It has no text delta, so the token diff
  // below cannot see it — and in a contract, bolding a limitation of liability
  // is exactly the edit the other side must be shown. Reported separately, and
  // only when the TEXT is unchanged: when text moved too, the mark arithmetic
  // in `apply` carries the formatting with it and a second card would be noise.
  for (const b of before.body) {
    const a2 = afterById.get(b.id);
    if (!a2 || a2.text !== b.text) continue;
    const wasMarks = JSON.stringify(b.marks ?? []);
    const nowMarks = JSON.stringify(a2.marks ?? []);
    if (wasMarks !== nowMarks) {
      changes.push({ id: id(), kind: 'format', blockId: b.id,
                     before: b.marks ?? [], after: a2.marks ?? [], author });
    }
  }

  for (const b of before.body) {
    const a2 = afterById.get(b.id);
    if (!a2 || a2.text === b.text) continue;
    const ops = diffTokens(tokenize(b.text), tokenize(a2.text));
    // One CHANGE per contiguous edit region, so a reviewer accepts a thought
    // rather than a token — and regions separated by only a few unchanged
    // characters are COALESCED into one.
    //
    // Without that, "30 days" → "sixty (60) calendar days" arrives as three
    // separate changes ("30"→"sixty", insert "(60) calendar ", …) which a
    // reviewer has to accept individually and could half-accept into nonsense.
    // Measured on the fixture: 3 changes become 1. The threshold is in
    // characters of untouched text between two edits.
    const COALESCE = 12;
    const raw = [];
    let cursor = 0, i = 0;
    while (i < ops.length) {
      if (ops[i].op === 'eq') { cursor += ops[i].tokens.join('').length; i++; continue; }
      const start = cursor;
      let removed = '', added = '';
      while (i < ops.length && ops[i].op !== 'eq') {
        if (ops[i].op === 'del') removed += ops[i].tokens.join('');
        else added += ops[i].tokens.join('');
        i++;
      }
      cursor += removed.length;
      raw.push({ at: start, removed, added });
    }
    const merged = [];
    for (const r of raw) {
      const prev = merged[merged.length - 1];
      const gap = prev ? r.at - (prev.at + prev.removed.length) : Infinity;
      if (prev && gap >= 0 && gap < COALESCE) {
        const between = b.text.slice(prev.at + prev.removed.length, r.at);
        prev.removed += between + r.removed;
        prev.added += between + r.added;
      } else merged.push({ ...r });
    }
    for (const m of merged) {
      changes.push({ id: id(), kind: 'text', blockId: b.id, at: m.at,
                     removed: m.removed, added: m.added, author });
    }
  }
  return { base: before.docId, author, changes };
}

/**
 * Apply a change set, accepting only the ids in `accept`.
 * Rejected changes leave the document exactly as it was.
 */
export function apply(before: { docId: string; body: Block[] }, set: ChangeSet, accept: Set<string> | null = null): { docId: string; body: Block[] } {
  const take = (c: Change) => accept === null || accept.has(c.id);
  const body = before.body.map(b => ({ ...b }));
  const byId = new Map(body.map(b => [b.id, b]));

  // text edits first, right-to-left inside each block so earlier offsets stay valid
  const textChanges = set.changes.filter((c): c is Extract<Change, { kind: 'text' }> => c.kind === 'text' && take(c));
  const byBlock = new Map();
  for (const c of textChanges) {
    if (!byBlock.has(c.blockId)) byBlock.set(c.blockId, []);
    byBlock.get(c.blockId).push(c);
  }
  for (const [blockId, list] of byBlock) {
    const blk = byId.get(blockId);
    if (!blk) continue;
    list.sort((x: Extract<Change, { kind: 'text' }>, y: Extract<Change, { kind: 'text' }>) => y.at - x.at);
    if (blk.notes) blk.notes = blk.notes.map(n => ({ ...n }));
    for (const c of list) {
      if (blk.text.slice(c.at, c.at + c.removed.length) !== c.removed) {
        throw new Error(`change ${c.id} does not apply: expected ${JSON.stringify(c.removed)} at ${c.at}`);
      }
      blk.text = blk.text.slice(0, c.at) + c.added + blk.text.slice(c.at + c.removed.length);
      // Anything anchored INTO this block by character offset has to move with
      // the text, or it lands mid-word. TWO things are: footnote markers, and
      // formatting marks. A version of this that moved only one of them is the
      // bug that put a marker in the middle of a word during the spike.
      if (blk.marks) {
        const delta = c.added.length - c.removed.length;
        const end = c.at + c.removed.length;
        const move = (p: number) => p <= c.at ? p
          : p >= end ? p + delta
          : c.at + Math.min(p - c.at, c.added.length);
        const moved = blk.marks
          .map(m => ({ ...m, from: move(m.from), to: move(m.to) }))
          .filter(m => m.to > m.from);
        if (moved.length) blk.marks = moved; else delete blk.marks;
      }
      if (blk.notes) {
        const delta = c.added.length - c.removed.length;
        blk.notes = blk.notes
          // a marker inside the replaced span has lost its anchor entirely
          .filter(n => !(n.at > c.at && n.at < c.at + c.removed.length))
          .map(n => n.at >= c.at + c.removed.length ? { ...n, at: n.at + delta } : n);
      }
    }
  }

  // formatting
  for (const c of set.changes.filter((c): c is Extract<Change, { kind: 'format' }> => c.kind === 'format' && take(c))) {
    const blk = byId.get(c.blockId);
    if (!blk) continue;
    if (c.after.length) blk.marks = c.after.map(m => ({ ...m })); else delete blk.marks;
  }

  let out = body;
  // deletions
  const dels = new Set(set.changes.filter((c): c is Extract<Change, { kind: 'block-del' }> => c.kind === 'block-del' && take(c)).map(c => c.blockId));
  out = out.filter(b => !dels.has(b.id));
  // reorder
  const reorder = set.changes.find((c): c is Extract<Change, { kind: 'reorder' }> => c.kind === 'reorder' && take(c));
  if (reorder) {
    const rank = new Map(reorder.to.map((bid, i) => [bid, i]));
    out.sort((x, y) => (rank.get(x.id) ?? 1e9) - (rank.get(y.id) ?? 1e9));
  }
  // insertions, at their recorded index
  for (const c of set.changes.filter((c): c is Extract<Change, { kind: 'block-ins' }> => c.kind === 'block-ins' && take(c))) {
    out.splice(Math.min(c.index, out.length), 0, { ...c.block });
  }
  return { ...before, body: out };
}

/** A one-line human summary, the thing a reviewer actually reads. */
export function describe(c: Change): string {
  const clip = (s: string, n = 40) => s.length > n ? s.slice(0, n) + '…' : s;
  switch (c.kind) {
    case 'text':
      if (!c.removed) return `insert “${clip(c.added)}”`;
      if (!c.added) return `delete “${clip(c.removed)}”`;
      return `“${clip(c.removed, 24)}” → “${clip(c.added, 24)}”`;
    case 'format': {
      const names: Record<string, string> = { b: 'bold', i: 'italic', u: 'underline', s: 'strikethrough', code: 'code', link: 'link' };
      const was = new Set(c.before.map(m => m.t)), now = new Set(c.after.map(m => m.t));
      const added = [...now].filter(t => !was.has(t)).map(t => names[t] ?? t);
      const removed = [...was].filter(t => !now.has(t)).map(t => names[t] ?? t);
      if (added.length && !removed.length) return `apply ${added.join(', ')}`;
      if (removed.length && !added.length) return `remove ${removed.join(', ')}`;
      if (added.length || removed.length) return `${removed.join(', ')} → ${added.join(', ')}`;
      return 'change formatting';
    }
    case 'block-ins': return `insert new paragraph “${clip(c.block.text)}”`;
    case 'block-del': return `delete paragraph “${clip(c.block.text)}”`;
    case 'reorder': return `reorder ${c.to.length} paragraphs`;
    // every kind is handled above; TypeScript proves it, so this can only be
    // reached by a Change shape added without updating this switch
    default: return 'change';
  }
}
