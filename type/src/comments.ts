// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Comments — margin notes on a RANGE of text, with replies and resolution.
//
// The thing every reviewed document needs, and the last review surface this app
// was missing: redline.ts answers "what changed", comments answer "why, and
// what do you think". A redline is a diff between two revisions; a comment is a
// conversation about text that has not changed at all, which is most of the
// text a reviewer has something to say about.
//
// ─────────────────────────────────────────────────────────── the four choices
//
// 1. A COMMENT IS A DOC-LEVEL RECORD, KEYED BY ID — `doc.comments`, exactly the
//    shape `doc.footnotes` already uses. Not nested into the block it points
//    at. The document is FLAT (model.ts explains why: the redline aligns on
//    block ids, the caret is (blockId, offset), pagination walks line boxes),
//    and a thread hanging off a block would put a second kind of nesting under
//    all three. It also has to outlive its block — see orphans below — which a
//    field on the block cannot do by construction.
//
// 2. THE ANCHOR IS A CHARACTER RANGE INTO PLAIN TEXT, and it moves with the
//    text using inline.ts `shift` — the SAME function marks use and the same
//    rule footnote anchors follow. Not a copy of it. A comment whose range
//    drifts onto the wrong words is worse than no comment, and the way that
//    happens is a second implementation of offset arithmetic that is 95%
//    identical to the first. There is one implementation; this module wraps a
//    range in a carrier mark and asks `shift` to move it. Everything an author
//    can anchor into a block's text — a mark, a footnote, a comment — therefore
//    moves identically, and there is one place to get it right.
//
// 3. A COMMENT WHOSE TEXT IS DELETED IS ORPHANED, NEVER DROPPED. See below.
//
// 4. NOTHING IS DRAWN INSIDE THE EDITABLE. Highlights are rectangles painted
//    into an OVERLAY layer, computed from `Range.getClientRects()` — the same
//    technique paginate.ts uses to place its sidenotes, and for the same
//    reason: decorations inserted into the flow enter the undo stack, confuse
//    the caret's offset walk, and get destroyed on the next re-render anyway.
//
// ─────────────────────────────────────────────── how comments stay out of print
//
// STRUCTURALLY, not by a flag. print.ts builds its flow in `bodyHtml`, which
// emits `blockHtml(b)` per block; `blockHtml` reads exactly `b.text`, `b.marks`
// and `b.notes`. It never reads `doc.comments`, and this module never writes a
// mark, a note, or a character into a block — the highlight is an absolutely
// positioned <div> in a sibling overlay of `.t-paper`, and the margin cards are
// in that same overlay. There is no code path from a comment to the printed
// string, so no print-time exclusion is needed and none can be forgotten. (The
// tempting shortcut — a `t:'comment'` mark — is exactly what would have printed
// a yellow highlight onto every executed copy of a contract.) Verified in the
// rig: `buildPrintDocument` output of a commented document contains no comment
// text and is byte-identical to the same document with `comments` removed.
//
// ───────────────────────────────────────────────────────── NEEDS FROM THE CORE
//
// This module is complete and testable WITHOUT the following. Each one is a
// call site the core owns; until they land, a comment's anchor survives every
// edit that goes through `commentsOnEdit` (which nothing calls yet) and is
// repaired defensively on every read by `reconcileThreads` — so nothing is ever
// wrong, only coarse: after an unhooked edit a range is clamped to the block
// and orphaned if it no longer fits, rather than tracked character by character.
//
// (A) type/src/model.ts — declare the field, and repair it at parse time.
//
//     After `NoteRef`, add:
//
//         /** comment id → thread. Doc-level and keyed by id, like footnotes:
//          *  a thread must be able to outlive the block it points at. */
//         export interface CommentMsg { id: string; author: string; at: string; text: string }
//         export interface CommentThread {
//           id: string; block: string; from: number; to: number;
//           quote: string; messages: CommentMsg[];
//           resolved?: boolean; orphan?: boolean;
//         }
//
//     and on `TypeDoc`, beside `footnotes`:
//
//         comments?: Record<string, CommentThread>;
//
//     WHY: format additivity means an unknown `comments` key already rides
//     through `parseDoc` untouched (the `...json` spread), so old files open in
//     a new build and NEW FILES OPEN IN AN OLD BUILD with the comments intact
//     but invisible — which is the additivity requirement, already met. The
//     field is wanted for two other reasons: so `tsc` types it instead of this
//     module casting through the index signature, and so `parseDoc` can repair
//     a hand-edited or generator-produced file (drop a thread with no messages,
//     clamp `from`/`to` into the block, detach a thread whose block is missing
//     or whose range is degenerate) deterministically, the way it already
//     repairs dangling footnote refs. That repair is already written here, pure
//     and in two halves, so `parseDoc` can call it directly:
//
//         const list = reconcileThreads(readThreadsRaw(json), body);
//         if (list.length) doc.comments = Object.fromEntries(list.map(t => [t.id, t]));
//
//     Note the ORDER, which matters: `readThreadsRaw` is the total parse and
//     `reconcileThreads` is the repair, and the edit hooks in (B) deliberately
//     use only the first — repairing before moving an anchor clamps it against
//     a body that has already changed.
//
// (B) type/src/editor.ts — three one-line calls, so an anchor tracks an edit
//     exactly rather than being repaired approximately.
//
//     import { commentsOnEdit, commentsOnSplit, commentsOnMerge } from './comments.ts';
//
//     · in `#input`, inside the existing `this.store.commit(d => { … })`
//       callback, after `d.body[i] = next`:
//               commentsOnEdit(d, c.id, prev.text, next.text);
//       WHY inside the commit: it must land in the same undo snapshot as the
//       text, or ⌘Z restores the words and leaves the anchor where the edit
//       put it. The snapshot scope is `{ block }` today, which does not cover
//       `doc.comments` — so this call also needs the scope widened to 'doc'
//       for the commits that move a comment, OR (cheaper, and what I would do)
//       `commentsOnEdit` returning false when it changed nothing, which it
//       does: a block carrying no comments never widens anybody's undo.
//     · in `#splitBlock`, inside its commit, after the splice:
//               commentsOnSplit(d, src.id, c.at, src.text.length, tail.id);
//     · in `#mergeBack`, inside its commit, after the splice:
//               commentsOnMerge(d, prev.id, cur.id, at);
//
// (C) type/src/print.ts — NOTHING. Deliberately. See above.
//
// (D) type/src/icons.ts — optional. `COMMENT_ICON` below follows the house
//     recipe exactly (24×24 box, rendered 16px, stroke currentColor, width 2,
//     round caps and joins) and lives here only because this module owns its
//     own file. Moving it to `ICONS.comment` is a pure lift.
//
// (E) type/src/main.ts — optional. `PanelSpec.update` is declared in
//     features.ts and never called; this module therefore drives its own
//     repaints from `store.on` and a MutationObserver on the paper, which is
//     self-contained and needs no change. If main.ts ever starts calling
//     `spec.update`, this panel is already idempotent.

import { shift, type Mark } from './inline.ts';
import { isNoteAtom } from './render.ts';
import { uid, type Block, type TypeDoc } from './model.ts';
import { registerTool, registerPanel, registerKey, registerMenuItem, registerReady, type FeatureContext } from './features.ts';
import { t } from './i18n.ts';
// NOT `import './comments.css'` here: model.ts imports this module's pure
// functions (readThreadsRaw, reconcileThreads) for parsing, and model.ts is
// imported by nearly every test rig under plain Node, which cannot load a
// bare `.css` specifier the way Vite does. about.ts is always loaded by
// main.ts (never lazily) and no rig imports it, so it is the safe place that
// pulls comments.css into the bundle — see about.ts.

// ───────────────────────────────────────────────────────────────── the shape

/** One message in a thread. The first is the comment; the rest are replies. */
export interface CommentMsg {
  id: string;
  /** self-asserted, from localStorage 'bento-author'. A claim, not an identity —
   *  signatures (canon.ts) are the only thing in this document that proves who. */
  author: string;
  /** ISO wall clock, display only */
  at: string;
  /** CONTENT, not UI: never passed through t() */
  text: string;
}

export interface CommentThread {
  id: string;
  /** the block this points into */
  block: string;
  /** character offsets into that block's PLAIN text — same coordinates as a
   *  mark and a footnote anchor, moved by the same function */
  from: number;
  to: number;
  /**
   * The anchored text, captured when the comment was made.
   *
   * Not a cache: it is the thread's only self-description once the text it
   * pointed at is gone. "Is this enforceable?" with no idea what "this" was is
   * not a comment, it is a riddle.
   */
  quote: string;
  messages: CommentMsg[];
  resolved?: boolean;
  /**
   * The anchor no longer exists: its block was deleted, or its words were.
   *
   * ORPHANS ARE KEPT, and this is the whole policy. Three options were on the
   * table and two of them are wrong:
   *
   *   · DROP the thread — silently destroys review conversation, and it does it
   *     precisely when somebody deletes the clause that was being argued about,
   *     which is the moment the argument matters most.
   *   · KEEP THE OFFSETS LIVE — the comment then points at whatever text has
   *     since flowed into those offsets, so "this indemnity is uncapped" ends
   *     up attached to the notices clause. Worse than no comment, because it
   *     is confidently wrong.
   *   · ORPHAN — the thread stays in the file with its conversation and its
   *     `quote` intact, `block`/`from`/`to` frozen as a record of where it USED
   *     to be, and this flag set. It is not highlighted (there is nothing to
   *     highlight), it is not clickable-to-scroll, and the panel lists it in a
   *     "detached" group saying which words it was about. A human decides
   *     whether it is finished; the app never decides for them.
   *
   * ONCE SET BY AN EDIT, THIS PERSISTS. The first version of this file derived
   * the flag on every read instead — "never trust the file" — and it was wrong
   * in a way the rig caught: a thread whose words were deleted keeps its old
   * `from`/`to` as the record of where it was, and those numbers are usually
   * still inside the (now shorter) block, so re-deriving cheerfully un-orphaned
   * it and pointed it at whatever had flowed into those offsets. That is the
   * exact failure the orphan policy exists to prevent.
   *
   * Undo still resurrects a thread, and does it properly: the store snapshots
   * the whole document, so undoing the deletion restores the comment map as it
   * was before it — flag and offsets together — rather than reconstructing a
   * guess. `reconcileThreads` therefore only ever ADDS this flag, never clears
   * it. What it adds is transient (a read does not write back), which is what
   * lets a thread whose BLOCK is missing come back by itself if the block
   * returns — a redline rejection re-inserting a deleted paragraph does exactly
   * that.
   */
  orphan?: boolean;
}

/** Where a thread's anchor is, as bare offsets. */
export interface Anchor { from: number; to: number }

const AUTHOR_KEY = 'bento-author';   // shared with bento/slides, on purpose

// ─────────────────────────────────────────────────── reading and writing them
//
// `doc.comments` is reached through TypeDoc's `[extra: string]: unknown` index
// signature until (A) above lands. Centralised in these two functions so that
// when it does, this is the only edit.

type Commented = { comments?: Record<string, CommentThread> };
const asCommented = (doc: TypeDoc): Commented => doc as unknown as Commented;

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Every thread in the document, EXACTLY as stored — no repair.
 *
 * Total: a `comments` field of any shape at all yields a valid list, because
 * this runs on files a generator or a hand edit produced. A thread with no
 * messages is not a thread and is the one thing dropped — there is no
 * conversation in it to preserve.
 *
 * The edit hooks below read through THIS, not `readThreads`. They are told the
 * exact edit and know how to move an anchor through it; running the defensive
 * repair first would clamp anchors against the already-mutated body and destroy
 * the very offsets the hook was about to move. That ordering bug is real and
 * the rig caught it: a comment in the tail of a split paragraph was clamped
 * against the truncated head, orphaned, and then skipped by the split.
 */
export function readThreadsRaw(doc: TypeDoc): CommentThread[] {
  const raw = asCommented(doc).comments;
  if (!isObj(raw)) return [];
  const out: CommentThread[] = [];
  for (const [key, v] of Object.entries(raw)) {
    if (!isObj(v)) continue;
    const messages = Array.isArray(v.messages)
      ? (v.messages as unknown[]).filter(isObj).map((m, i) => ({
          id: typeof m.id === 'string' && m.id ? m.id : `${key}-m${i}`,
          author: typeof m.author === 'string' ? m.author : '',
          at: typeof m.at === 'string' ? m.at : '',
          text: typeof m.text === 'string' ? m.text : '',
        }))
      : [];
    if (!messages.length) continue;
    // NOT sorted into order and not clamped here: a stored range of (9e9, -3)
    // is garbage, and quietly repairing it into "the whole paragraph" would
    // attach somebody's comment to text they never selected. Left as read, so
    // reconcileThreads sees a degenerate range and orphans it — which says
    // "this pointed somewhere that no longer makes sense", which is the truth.
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
    const from = num(v.from), to = num(v.to);
    out.push({
      id: typeof v.id === 'string' && v.id ? v.id : key,
      block: typeof v.block === 'string' ? v.block : '',
      from, to,
      quote: typeof v.quote === 'string' ? v.quote : '',
      messages,
      ...(v.resolved === true ? { resolved: true as const } : {}),
      ...(v.orphan === true ? { orphan: true as const } : {}),
    });
  }
  return out;
}

/** Every thread, repaired against the current body — what every reader wants. */
export const readThreads = (doc: TypeDoc): CommentThread[] =>
  reconcileThreads(readThreadsRaw(doc), doc.body);

/** Put a thread list back, as the id-keyed map the format stores. */
export function writeThreads(doc: TypeDoc, threads: CommentThread[]): void {
  const d = asCommented(doc);
  if (!threads.length) { delete d.comments; return; }
  const map: Record<string, CommentThread> = {};
  for (const th of threads) map[th.id] = th;
  d.comments = map;
}

// ───────────────────────────────────────────────────────── anchor maintenance
//
// All pure. This is the part that must not be wrong.

/**
 * A range wrapped as a MARK, so inline.ts `shift` can move it.
 *
 * The carrier's type is arbitrary and never rendered or stored — `shift` only
 * ever reads `from`/`to`, and `normalize` (which it ends with) only cares that
 * a mark of zero width is dropped, which is exactly the signal this module
 * wants for "the anchored text is gone".
 *
 * This indirection is the point of the whole file. Marks, footnote anchors and
 * comment anchors are three names for one problem, and the moment any of them
 * gets its own arithmetic they start disagreeing under an edit that straddles a
 * boundary — the failure mode being a comment sitting one word to the left of
 * the sentence it is about, which nobody notices until a contract is signed.
 */
const CARRIER: Mark['t'] = 'b';

/**
 * Move a range to follow an edit that replaced [at, at+removed) with `added`
 * characters, against a text of final length `len`.
 *
 * Returns null when the range no longer covers anything — the anchored text was
 * deleted outright. The caller decides what that means; here it means orphan.
 *
 * The behaviour at the two edges is inherited, deliberately, rather than chosen:
 * an insertion exactly AT `from` joins the range and one exactly AT `to` does
 * not, because that is what `shift` does to a mark, and a comment highlight
 * that grew differently from the bold underneath it would look like a bug in
 * one of them.
 */
export function shiftAnchor(a: Anchor, at: number, removed: number, added: number, len: number): Anchor | null {
  const moved = shift([{ t: CARRIER, from: a.from, to: a.to }], at, removed, added, len);
  if (!moved.length) return null;
  return { from: moved[0].from, to: moved[0].to };
}

/**
 * The minimal edit between two versions of one block's text, as
 * (at, removed, added) — a common-prefix / common-suffix trim.
 *
 * The editor rebuilds a whole block from the DOM on every `input` (render.ts
 * readBlock) rather than reporting a splice, so the splice has to be recovered
 * here. Minimal matters: treating a keystroke as "replaced the entire
 * paragraph" would orphan every comment in it on the first character typed.
 *
 * Returns null when the text did not change.
 */
export function textEdit(prev: string, next: string): { at: number; removed: number; added: string } | null {
  if (prev === next) return null;
  const max = Math.min(prev.length, next.length);
  let p = 0;
  while (p < max && prev[p] === next[p]) p++;
  let s = 0;
  while (s < max - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  return { at: p, removed: prev.length - p - s, added: next.slice(p, next.length - s) };
}

/** Move one thread through an edit in ITS block. Pure; returns a new thread. */
export function shiftThread(th: CommentThread, at: number, removed: number, added: number, len: number): CommentThread {
  const moved = shiftAnchor({ from: th.from, to: th.to }, at, removed, added, len);
  // The frozen from/to are kept as the record of where it was — see `orphan`.
  if (!moved) return { ...th, orphan: true };
  const out: CommentThread = { ...th, from: moved.from, to: moved.to };
  delete out.orphan;
  return out;
}

/** Move every thread anchored in `blockId` through one edit. Pure. */
export function shiftThreads(threads: CommentThread[], blockId: string,
                             at: number, removed: number, added: number, len: number): CommentThread[] {
  return threads.map(th =>
    th.block === blockId && !th.orphan ? shiftThread(th, at, removed, added, len) : th);
}

/**
 * Follow a paragraph SPLIT: `srcId` was cut at `at`, the head keeping `srcId`
 * and the tail becoming `tailId`.
 *
 * A thread that straddles the cut cannot be in two places, and the two obvious
 * answers are both bad: dropping it destroys a live conversation over an edit
 * that changed no words at all, and duplicating it makes one comment that two
 * people must now resolve twice. It goes to the side holding MORE of the text
 * it was about, clipped — which is the side a reader would point at.
 */
export function splitThreads(threads: CommentThread[], srcId: string, at: number,
                             srcLen: number, tailId: string): CommentThread[] {
  const tailLen = srcLen - at;
  return threads.map(th => {
    if (th.block !== srcId || th.orphan) return th;
    if (th.to <= at) return th;                                   // wholly in the head
    if (th.from >= at) {                                          // wholly in the tail
      return { ...th, block: tailId, from: th.from - at, to: Math.min(th.to - at, tailLen) };
    }
    const inHead = at - th.from, inTail = th.to - at;
    if (inTail > inHead) return { ...th, block: tailId, from: 0, to: Math.min(inTail, tailLen) };
    return { ...th, to: at };
  });
}

/**
 * Follow a paragraph MERGE: `curId` was appended to `prevId` at offset `at`.
 * Nothing is lost — a merge only concatenates — so every anchor survives.
 */
export function mergeThreads(threads: CommentThread[], prevId: string, curId: string, at: number): CommentThread[] {
  return threads.map(th =>
    th.block === curId && !th.orphan
      ? { ...th, block: prevId, from: th.from + at, to: th.to + at }
      : th);
}

/**
 * Repair every thread against the body, and set or CLEAR `orphan`.
 *
 * A NET, NOT A DERIVATION. It only ever ADDS the flag — see `orphan` for the
 * bug that taught the difference. Its job is to make this module safe before
 * the editor hooks in (B) exist, and safe against files nothing in this app
 * wrote: the worst an untracked edit or a bad generator can do is clamp a range
 * or detach a thread, never point one somewhere false.
 *
 * Runs on every read and writes nothing back, so what it adds is transient —
 * which is what lets a thread whose block is missing come back by itself when
 * the block returns.
 */
export function reconcileThreads(threads: CommentThread[], body: readonly Block[]): CommentThread[] {
  const byId = new Map(body.map(b => [b.id, b]));
  return threads.map(th => {
    if (th.orphan) return th;                      // already detached; leave the record alone
    const blk = byId.get(th.block);
    if (!blk) return { ...th, orphan: true };
    const from = Math.max(0, Math.min(th.from, blk.text.length));
    const to = Math.max(0, Math.min(th.to, blk.text.length));
    if (to <= from) return { ...th, orphan: true };
    return { ...th, from, to };
  });
}

// ───────────────────────────────────────────────────────────── thread logic

const now = () => new Date().toISOString();

/** Start a thread on [from,to) of a block. `quote` is captured here, once. */
export function newThread(block: Block, from: number, to: number, author: string, text: string,
                          id = uid('cm'), at = now()): CommentThread {
  return {
    id, block: block.id, from, to,
    quote: block.text.slice(from, to),
    messages: [{ id: uid('cmm'), author, at, text }],
  };
}

/** Append a reply. Pure. An empty body is not a reply and is refused. */
export function addReply(th: CommentThread, author: string, text: string, at = now()): CommentThread {
  if (!text.trim()) return th;
  return { ...th, messages: [...th.messages, { id: uid('cmm'), author, at, text }] };
}

/**
 * Edit a message's text in place. Pure; touches nothing else on the thread —
 * `block`/`from`/`to`/`quote` are the ANCHOR and an edit to what somebody
 * SAID about the text is not an edit to what they said it ABOUT, so the
 * anchor a caller reads before and after this call is byte-identical.
 *
 * An empty result is not an edit (that is what delete is for) and is refused:
 * this returns the thread unchanged rather than leaving a blank message
 * behind for a hasty save-of-empty-textarea to commit.
 */
export function editMessage(th: CommentThread, msgId: string, text: string): CommentThread {
  const trimmed = text.trim();
  if (!trimmed || !th.messages.some(m => m.id === msgId)) return th;
  return { ...th, messages: th.messages.map(m => m.id === msgId ? { ...m, text: trimmed } : m) };
}

/**
 * Remove one message. Returns the thread with it gone, or `null` when it was
 * the LAST message — a thread with no messages is not a thread (the same
 * rule `readThreadsRaw` applies on parse), so the caller deletes the whole
 * thread rather than keep an empty shell with a frozen anchor and no
 * conversation to show for it.
 */
export function deleteMessage(th: CommentThread, msgId: string): CommentThread | null {
  const messages = th.messages.filter(m => m.id !== msgId);
  return messages.length ? { ...th, messages } : null;
}

/**
 * Resolve or unresolve. Both directions, because "resolved" is a reviewer's
 * judgement and reviewers change their minds — a one-way resolve is a delete
 * with extra steps.
 */
export function setResolved(th: CommentThread, resolved: boolean): CommentThread {
  const out = { ...th };
  if (resolved) out.resolved = true; else delete out.resolved;
  return out;
}

/** How many threads still want a human. Orphans count: they are not resolved. */
export const unresolvedCount = (threads: readonly CommentThread[]): number =>
  threads.filter(th => !th.resolved).length;

/**
 * The order the panel shows.
 *
 * UNRESOLVED FIRST, because the panel's job is a to-do list and a document with
 * forty settled comments must not bury the three that are open. Then attached
 * before detached — a comment you can still click through to outranks one whose
 * text is gone. Then DOCUMENT ORDER, so reading the panel top to bottom is
 * reading the document top to bottom. Orphans have no position left, so they
 * fall back to when they were written. Fully deterministic: two readers of one
 * file see the same list, which matters because people say "the third comment".
 */
export function orderThreads(threads: readonly CommentThread[], body: readonly Block[]): CommentThread[] {
  const pos = new Map(body.map((b, i) => [b.id, i]));
  const rank = (th: CommentThread) => [
    th.resolved ? 1 : 0,
    th.orphan ? 1 : 0,
    th.orphan ? Number.MAX_SAFE_INTEGER : (pos.get(th.block) ?? Number.MAX_SAFE_INTEGER),
    th.orphan ? 0 : th.from,
  ];
  return [...threads].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    const ta = a.messages[0]?.at ?? '', tb = b.messages[0]?.at ?? '';
    return ta < tb ? -1 : ta > tb ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

// ────────────────────────────────────── the hooks the core calls (see (B))
//
// Thin, mutating wrappers over the pure functions above. Each returns whether
// it changed anything, so a commit whose block carries no comments costs
// nothing and does not have to widen its undo scope.

export function commentsOnEdit(doc: TypeDoc, blockId: string, prevText: string, nextText: string): boolean {
  const d = asCommented(doc);
  if (!d.comments) return false;
  const e = textEdit(prevText, nextText);
  if (!e) return false;
  const before = readThreadsRaw(doc);
  if (!before.some(th => th.block === blockId)) return false;
  writeThreads(doc, shiftThreads(before, blockId, e.at, e.removed, e.added.length, nextText.length));
  return true;
}

export function commentsOnSplit(doc: TypeDoc, srcId: string, at: number, srcLen: number, tailId: string): boolean {
  const d = asCommented(doc);
  if (!d.comments) return false;
  const before = readThreadsRaw(doc);
  if (!before.some(th => th.block === srcId)) return false;
  writeThreads(doc, splitThreads(before, srcId, at, srcLen, tailId));
  return true;
}

export function commentsOnMerge(doc: TypeDoc, prevId: string, curId: string, at: number): boolean {
  const d = asCommented(doc);
  if (!d.comments) return false;
  const before = readThreadsRaw(doc);
  if (!before.some(th => th.block === curId)) return false;
  writeThreads(doc, mergeThreads(before, prevId, curId, at));
  return true;
}

// ═══════════════════════════════════════════════════════════════════════ UI
//
// Everything below touches the DOM. The logic above does not, which is what
// lets the rig run under plain node.

/**
 * The bubble, to the house recipe in icons.ts: 24×24 box, rendered at 16px,
 * stroke currentColor at width 2, round caps and joins. It lives here rather
 * than in ICONS because this feature is one file — see (D).
 */
const COMMENT_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.4-4.2A8 8 0 0 1 13 4a8 8 0 0 1 8 8z"/>' +
  '<line x1="8.5" y1="11" x2="15.5" y2="11"/><line x1="8.5" y1="14.5" x2="13" y2="14.5"/></svg>';

/**
 * Who you are IF you have already said — never asks.
 *
 * authorName() below prompts when it does not know, which is right when you
 * have just chosen to leave a comment and wrong on a keystroke: tracked changes
 * attribute every edit, and a modal in the middle of a sentence would be
 * unusable. Tracking asks once, when it is switched on.
 */
export function knownAuthor(): string {
  try { return localStorage.getItem(AUTHOR_KEY) || ''; } catch { return ''; }
}

/** Ask for a name if there isn't one, without the caller needing a comment. */
export const ensureAuthor = (): string => authorName();

/**
 * Set the name directly — the primary path, from the About dialog's "You"
 * section. `authorName()`'s prompt stays as the FALLBACK for someone who
 * comments or turns on tracking before ever opening About; both write the
 * same key, so whichever ran first is what the other reads.
 *
 * Trimmed and stored empty-as-cleared: an empty saved name is not a name, and
 * `authorName()` must still see nothing there so it prompts (or falls back to
 * 'Anonymous') the next time it is needed, rather than silently attributing
 * as ''.
 */
export function setAuthorName(name: string): void {
  const who = name.trim();
  try { who ? localStorage.setItem(AUTHOR_KEY, who) : localStorage.removeItem(AUTHOR_KEY); }
  catch { /* private mode — the name just won't persist across reloads */ }
}

/** Who you are, as bento/slides records it — one suite, one answer. */
function authorName(): string {
  let who = '';
  try { who = localStorage.getItem(AUTHOR_KEY) ?? ''; } catch { /* private mode */ }
  if (who) return who;
  const asked = typeof prompt === 'function'
    ? prompt(t('Your name, so your comments are attributed'), '') : '';
  who = (asked ?? '').trim();
  if (who) { try { localStorage.setItem(AUTHOR_KEY, who); } catch { /* ignore */ } }
  // NOT t(): this becomes CONTENT in the file, and content does not change
  // language when somebody else opens it.
  return who || 'Anonymous';
}

const when = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined,
    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/** The selected thread — VIEW state, never in the document. */
let selected: string | null = null;
/** The one message currently being edited in place — VIEW state too. */
let editingMsg: string | null = null;
let layer: HTMLElement | null = null;
let repaint: (() => void) | null = null;
let refreshPanel: (() => void) | null = null;

/**
 * The DOM point `at` characters into a rendered block — footnote atoms skipped,
 * exactly as editor.ts counts them. A comment's offsets are model offsets, and
 * the model does not know the marker is there.
 */
function pointAt(block: HTMLElement, at: number): { node: Node; offset: number } | null {
  let count = 0;
  let last: { node: Node; offset: number } | null = null;
  const walk = (n: Node): { node: Node; offset: number } | null => {
    if (n.nodeType === 3) {
      const len = n.nodeValue!.length;
      if (count + len >= at) return { node: n, offset: at - count };
      count += len;
      last = { node: n, offset: len };
      return null;
    }
    if (n.nodeType === 1 && isNoteAtom(n as Element)) return null;
    for (const c of Array.from(n.childNodes)) { const r = walk(c); if (r) return r; }
    return null;
  };
  for (const c of Array.from(block.childNodes)) { const r = walk(c); if (r) return r; }
  return last;
}

/** Characters before (container, offset) in this block — the inverse of above. */
function offsetIn(block: HTMLElement, container: Node, offset: number): number {
  let count = 0, done = false;
  const walk = (n: Node): void => {
    if (done) return;
    if (n === container && n.nodeType !== 3) {
      for (let i = 0; i < offset && i < n.childNodes.length; i++) walk(n.childNodes[i]);
      done = true; return;
    }
    if (n.nodeType === 3) {
      if (n === container) { count += Math.min(offset, n.nodeValue!.length); done = true; return; }
      count += n.nodeValue!.length; return;
    }
    if (n.nodeType === 1 && isNoteAtom(n as Element)) return;
    for (const c of Array.from(n.childNodes)) { walk(c); if (done) return; }
  };
  for (const c of Array.from(block.childNodes)) { walk(c); if (done) break; }
  return count;
}

const blockEl = (paper: HTMLElement, id: string) =>
  paper.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);

function rangeFor(paper: HTMLElement, th: CommentThread): Range | null {
  const el = blockEl(paper, th.block);
  if (!el) return null;
  const a = pointAt(el, th.from), b = pointAt(el, th.to);
  if (!a || !b) return null;
  const r = document.createRange();
  try { r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); } catch { return null; }
  return r;
}

/**
 * Paint highlights and margin cards into the overlay.
 *
 * Its own layer, a sibling of `.t-deco` — because `drawPages` calls
 * `deco.replaceChildren()` on every repagination and would wipe anything this
 * module put there. The layer is `pointer-events:none` with only the cards
 * interactive, so a highlight can never swallow a click meant for the text.
 */
function paintLayer(ctx: FeatureContext): void {
  const paper = ctx.editor.host;
  const wrap = paper.parentElement;
  if (!wrap) return;
  if (!layer || layer.parentElement !== wrap) {
    layer = document.createElement('div');
    layer.className = 't-cmt-layer';
    // never captured by a save: the file carries doc.comments, not their pixels
    layer.setAttribute('data-bento-transient', '');
    wrap.appendChild(layer);
  }
  layer.replaceChildren();

  const threads = orderThreads(readThreads(ctx.store.doc), ctx.store.doc.body)
    .filter(th => !th.orphan);
  if (!threads.length) return;

  const top0 = paper.getBoundingClientRect().top;
  const left0 = paper.getBoundingClientRect().left;
  const frag = document.createDocumentFragment();

  // The gutter is shared with footnote sidenotes, which paginate.ts has already
  // stacked. Start below whatever is there and keep stacking, so a note and a
  // comment beside the same line never land on top of each other.
  const occupied: Array<[number, number]> = [];
  const deco = wrap.querySelector('.t-deco');
  if (deco) for (const n of Array.from(deco.querySelectorAll<HTMLElement>('.sidenote'))) {
    const y = parseFloat(n.style.top || '0');
    occupied.push([y, y + n.getBoundingClientRect().height]);
  }
  let lastBottom = -1e9;

  for (const th of threads) {
    const r = rangeFor(paper, th);
    if (!r) continue;
    const rects = Array.from(r.getClientRects()).filter(x => x.width > 0 && x.height > 0);
    if (!rects.length) continue;

    for (const rect of rects) {
      const hl = document.createElement('div');
      hl.className = 't-cmt-hl' + (th.resolved ? ' done' : '') + (th.id === selected ? ' on' : '');
      hl.style.top = `${rect.top - top0}px`;
      hl.style.left = `${rect.left - left0}px`;
      hl.style.width = `${rect.width}px`;
      hl.style.height = `${rect.height}px`;
      frag.appendChild(hl);
    }

    const card = buildCard(ctx, th);
    frag.appendChild(card);
    layer.appendChild(card);                       // measured after insertion
    let y = rects[0].top - top0 - 2;
    for (const [a, b] of occupied) if (y < b && y + 10 > a) y = b + 8;
    y = Math.max(y, lastBottom + 8);
    card.style.top = `${y}px`;
    lastBottom = y + card.getBoundingClientRect().height;
  }
  layer.prepend(frag);
}

/**
 * One message, in the shape both the margin card and the panel use.
 *
 * Edit/delete are gated by NAME, not identity — this document has no notion
 * of who is typing beyond the self-asserted `bento-author` value, so "is this
 * yours" is "does the byline match what's in localStorage right now", the
 * same honour-system comparison editor.ts already trusts for attributing a
 * tracked change. Anyone can rename themselves to someone else's name and
 * edit their comments; that is true of `authorName()` everywhere else in this
 * file too, and is not something a margin-card button could fix.
 */
function buildMessage(ctx: FeatureContext, th: CommentThread, m: CommentMsg, cls: string, suffix = ''): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = cls;
  const editing = editingMsg === m.id;

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = `${m.author} · ${when(m.at)}${suffix}`;

  const me = knownAuthor();
  if (me && m.author === me && !editing) {
    const tools = document.createElement('span');
    tools.className = 't-cmt-msgtools';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 't-cmt-msgbtn';
    editBtn.textContent = t('Edit');
    editBtn.title = t('Edit your comment');
    editBtn.addEventListener('click', () => { editingMsg = m.id; repaint?.(); refreshPanel?.(); });
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 't-cmt-msgbtn';
    delBtn.textContent = t('Delete');
    delBtn.title = th.messages.length > 1 ? t('Delete your comment') : t('Delete this thread');
    delBtn.addEventListener('click', () => {
      const question = th.messages.length > 1
        ? t('Delete this comment?') : t('Delete this whole thread?');
      if (!confirm(question)) return;
      mutateThread(ctx, th.id, cur => deleteMessage(cur, m.id));
    });
    tools.append(editBtn, delBtn);
    who.appendChild(tools);
  }
  wrap.appendChild(who);

  if (editing) {
    const ta = document.createElement('textarea');
    ta.className = 't-cmt-edit';
    ta.rows = 2;
    ta.value = m.text;
    const row = document.createElement('div');
    row.className = 'btns';
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = t('Save');
    save.addEventListener('click', () => {
      const text = ta.value.trim();
      if (!text) return;
      editingMsg = null;
      mutateThread(ctx, th.id, cur => editMessage(cur, m.id, text));
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = t('Cancel');
    cancel.addEventListener('click', () => { editingMsg = null; repaint?.(); refreshPanel?.(); });
    row.append(save, cancel);
    wrap.append(ta, row);
    return wrap;
  }

  const what = document.createElement('div');
  what.className = 'what';
  what.textContent = m.text;
  wrap.appendChild(what);
  return wrap;
}

/** One margin card. Expanded — replies, a reply box, resolve — when selected. */
function buildCard(ctx: FeatureContext, th: CommentThread): HTMLElement {
  const card = document.createElement('div');
  card.className = 't-cmt-card' + (th.resolved ? ' done' : '') + (th.id === selected ? ' on' : '');
  card.dataset.thread = th.id;
  const open = th.id === selected;
  const msgs = open ? th.messages : th.messages.slice(0, 1);
  const more = th.messages.length - msgs.length;
  for (const m of msgs) card.appendChild(buildMessage(ctx, th, m, 'msg'));
  if (more > 0) {
    const rest = document.createElement('div');
    rest.className = 'who';
    rest.textContent = t('{n} more', { n: String(more) });
    card.appendChild(rest);
  }
  card.addEventListener('mousedown', e => {
    // not `click`: mousedown beats the selection change, so opening a card
    // cannot be mistaken for the author clicking into the paper
    if ((e.target as HTMLElement).closest('button, textarea')) return;
    e.preventDefault();
    select(ctx, th.id === selected ? null : th.id);
  });
  if (open) card.appendChild(threadActions(ctx, th));
  return card;
}

/** Reply box + resolve toggle, shared by the margin card and the panel. */
function threadActions(ctx: FeatureContext, th: CommentThread): HTMLElement {
  const box = document.createElement('div');
  box.className = 'acts';
  const input = document.createElement('textarea');
  input.rows = 2;
  input.placeholder = t('Reply…');
  const row = document.createElement('div');
  row.className = 'btns';
  const send = document.createElement('button');
  send.type = 'button';
  send.textContent = t('Reply');
  send.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text) return;
    mutateThread(ctx, th.id, cur => addReply(cur, authorName(), text));
    input.value = '';
  });
  const res = document.createElement('button');
  res.type = 'button';
  res.textContent = th.resolved ? t('Reopen') : t('Resolve');
  res.addEventListener('click', () => mutateThread(ctx, th.id, cur => setResolved(cur, !cur.resolved)));
  row.append(send, res);
  box.append(input, row);
  return box;
}

/**
 * Change one thread and commit it, or DELETE it when `fn` returns null —
 * deleting the last message in it. Whole-doc scope: comments are doc-level.
 *
 * A deleted thread leaves nothing behind to clean up: `paintLayer` and the
 * panel both rebuild their contents from `readThreads(ctx.store.doc)` on
 * every commit (via the `store.on` subscription below), so a thread that is
 * no longer in the map is simply not painted — there is no separate
 * highlight or marker element to remember to remove.
 */
function mutateThread(ctx: FeatureContext, id: string, fn: (th: CommentThread) => CommentThread | null): void {
  ctx.store.commit(d => {
    // raw: a reply/edit/delete must not silently write back the read-time repair
    const threads = readThreadsRaw(d);
    const i = threads.findIndex(x => x.id === id);
    if (i < 0) return;
    const next = fn(threads[i]);
    if (next === null) {
      threads.splice(i, 1);
      if (selected === id) selected = null;
    } else {
      threads[i] = next;
    }
    writeThreads(d, threads);
  });
}

function select(ctx: FeatureContext, id: string | null): void {
  selected = id;
  repaint?.();
  refreshPanel?.();
  if (!id) return;
  const th = readThreads(ctx.store.doc).find(x => x.id === id);
  if (!th || th.orphan) return;
  const el = blockEl(ctx.editor.host, th.block);
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ─────────────────────────────────────────────────────────────── the feature

/** Comment on the current selection. */
function addComment(ctx: FeatureContext): void {
  const c = ctx.editor.caret();
  if (!c || c.to === undefined || c.to === c.at) {
    ctx.toast(t('Select some text first, then comment on it'));
    return;
  }
  const from = Math.min(c.at, c.to), to = Math.max(c.at, c.to);
  const blk = ctx.store.block(c.id);
  if (!blk) return;
  const who = authorName();
  const text = typeof prompt === 'function'
    ? (prompt(t('Comment on “{quote}”', { quote: blk.text.slice(from, to).slice(0, 60) })) ?? '').trim()
    : '';
  if (!text) return;
  const th = newThread(blk, from, to, who, text);
  ctx.store.commit(d => { writeThreads(d, [...readThreadsRaw(d), th]); });
  selected = th.id;
  ctx.refresh();
}

registerTool({
  id: 'comment',
  icon: COMMENT_ICON,
  get title() { return t('Comment on the selected text (⌘⇧M)'); },
  group: 'review',
  order: 10,
  run: addComment,
});

registerKey({ key: 'm', mod: true, shift: true, run: addComment });

registerPanel({
  id: 'comments',
  get label() { return t('Comments'); },
  // a SECTION of the Review tab: comments are one of the things people did to
  // this document, alongside tracked changes and signatures
  host: 'commentsHost',
  order: 20,
  mount(host, ctx) {
    const render = () => {
      const threads = orderThreads(readThreads(ctx.store.doc), ctx.store.doc.body);
      const open = unresolvedCount(threads);

      // The count lives HERE and not on the tab. Putting it on the tab was the
      // first version and it wrapped "Comments 1" onto two lines — four tabs
      // share a 250px sidebar — which made the whole tab row grow taller the
      // moment a document had a comment, jogging the panel below it. A count
      // that reflows the chrome it lives in is not worth the glance it saves.

      host.replaceChildren();
      if (!threads.length) {
        const hint = document.createElement('div');
        hint.className = 't-hint';
        hint.textContent = t('Select some text and press ⌘⇧M to comment on it.');
        host.appendChild(hint);
        return;
      }
      const count = document.createElement('div');
      count.className = 't-hint';
      count.textContent = open
        ? t('{open} open of {all}', { open: String(open), all: String(threads.length) })
        : t('All {all} resolved', { all: String(threads.length) });
      host.appendChild(count);

      for (const th of threads) {
        const card = document.createElement('div');
        card.className = 't-card t-cmt-item' + (th.resolved ? ' done' : '')
                       + (th.id === selected ? ' on' : '');
        const first = th.messages[0];
        const repliesSuffix = th.messages.length > 1
          ? ` · ${t('{n} replies', { n: String(th.messages.length - 1) })}` : '';
        const firstEl = buildMessage(ctx, th, first, 'msg', repliesSuffix);
        // splice the quote between the byline and the body — the reading order
        // is "who said it, about what, saying what" — by inserting it right
        // after the who-line buildMessage always puts first.
        const quote = document.createElement('div');
        quote.className = 'quote' + (th.orphan ? ' gone' : '');
        quote.textContent = th.quote;
        firstEl.insertBefore(quote, firstEl.firstElementChild!.nextSibling);
        card.appendChild(firstEl);
        if (th.orphan) {
          const gone = document.createElement('div');
          gone.className = 'who';
          gone.textContent = t('the text this was about is gone');
          card.appendChild(gone);
        }
        card.addEventListener('click', e => {
          if ((e.target as HTMLElement).closest('.acts, button, textarea')) return;
          select(ctx, th.id === selected ? null : th.id);
        });
        if (th.id === selected) {
          for (const m of th.messages.slice(1)) card.appendChild(buildMessage(ctx, th, m, 'reply'));
          card.appendChild(threadActions(ctx, th));
        }
        host.appendChild(card);
      }
    };

    refreshPanel = render;
    repaint = () => paintLayer(ctx);
    render();

    // Own repaints, because main.ts never calls PanelSpec.update — see (E).
    // The store fires on every commit; the observer catches the editor's
    // re-renders and pagination's reflows, which move the geometry without
    // changing the document.
    let beat: number | undefined;
    const soon = () => {
      clearTimeout(beat);
      beat = setTimeout(() => { render(); paintLayer(ctx); }, 60) as unknown as number;
    };
    ctx.store.on(soon);
    new MutationObserver(soon).observe(ctx.editor.host, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', soon);

    // Clicking a commented range focuses its comment — the other half of
    // "clicking a comment scrolls to the range". Capture-phase and read-only:
    // it never touches the selection the author is making.
    ctx.editor.host.addEventListener('click', () => {
      const sel = getSelection();
      if (!sel || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      if (!sel.isCollapsed || !ctx.editor.host.contains(r.startContainer)) return;
      let n: Node | null = r.startContainer;
      while (n && n !== ctx.editor.host && !(n.nodeType === 1 && (n as HTMLElement).dataset?.id)) n = n.parentNode;
      if (!n || n === ctx.editor.host) return;
      const el = n as HTMLElement;
      const at = offsetIn(el, r.startContainer, r.startOffset);
      const hit = orderThreads(readThreads(ctx.store.doc), ctx.store.doc.body)
        .find(th => !th.orphan && th.block === el.dataset.id && at >= th.from && at <= th.to);
      if (hit) select(ctx, hit.id);
    });

    setTimeout(() => paintLayer(ctx), 120);
  },
  update(_host, ctx) { refreshPanel?.(); paintLayer(ctx); },
});

// ─────────────────────────────────────────────────────── showing and hiding
//
// A VIEWER preference, kept beside the theme rather than in the document: it is
// about reading this file today, not about the file. Two people opening the
// same document disagree about whether they want the margin full of review,
// and neither answer belongs in bytes they both sign.
//
// It hides the APPARATUS — highlights and cards — and never the text, and it
// changes nothing in `doc.comments`, so a hidden thread is still saved, still
// exported, and still there when it is turned back on.

const HIDE_KEY = 'bento-type-hide-comments';

export const commentsHidden = (): boolean => {
  try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; }
};

export function setCommentsHidden(on: boolean): void {
  try { on ? localStorage.setItem(HIDE_KEY, '1') : localStorage.removeItem(HIDE_KEY); }
  catch { /* storage blocked — the class below still applies for this session */ }
  document.documentElement.classList.toggle('t-hide-comments', on);
}

/** Apply the remembered choice at boot. */
export const applyCommentVisibility = (): void => {
  document.documentElement.classList.toggle('t-hide-comments', commentsHidden());
};

registerMenuItem({
  id: 'comments-visibility',
  get label() { return commentsHidden() ? t('Show comments') : t('Hide comments'); },
  order: 15,
  run(ctx) {
    setCommentsHidden(!commentsHidden());
    ctx.refresh();
    ctx.toast(commentsHidden() ? t('Comments hidden') : t('Comments shown'));
  },
});

// the remembered choice, applied once the app exists
registerReady(() => applyCommentVisibility());
