// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Document state and undo.
//
// TWO THINGS THIS GETS RIGHT ON PURPOSE.
//
// 1. SCOPED SNAPSHOTS. bento/spaces measured the naive version: stringifying
//    the whole document on every checkpoint left an undo depth of NINE on a
//    200-page handbook, because nine snapshots exhausted the memory budget. A
//    typing run here records only the BLOCK it touched. That is fast and deep —
//    and it is only correct while the mutation touched nothing else, so `doc`
//    stays the default and callers must ASK for the narrow scope.
//
// 2. PRESENTATION IS NOT AN EDIT. Repagination, typesetting and footnote
//    placement all mutate the DOM and none of them mutate the document, so they
//    cannot enter the undo stack — there is no path from them to `commit`. The
//    spike proved this matters: five typed characters must cost five undo
//    presses, not five plus however many times the page re-laid-out.

import type { Block, TypeDoc } from './model.ts';
import { copyIsReceiveOnly } from './model.ts';

type Snap =
  | { kind: 'doc'; doc: TypeDoc }
  | { kind: 'block'; id: string; index: number; block: Block };

export type Scope = 'doc' | { block: string };
type Listener = (doc: TypeDoc) => void;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const LIMIT = 200;

/**
 * What undo and redo must NEVER move: the open file's identity and capability.
 *
 * A whole-document snapshot carries every field the document had, so swapping
 * one in used to roll these back too — measured on this code before the fix:
 * "Reset access" then ⌘Z put the REVOKED room key back (a copy you had just
 * cut off could rejoin the next time you went live), and "Stop sharing" then
 * ⌘Z turned sharing back on. ⌘Z means "undo what I wrote", not "undo who this
 * file is or who may reach it".
 *
 * So undo/redo move CONTENT and take these from the live document:
 *   docId    — identity; regenerating or reverting it orphans autosave,
 *              recovery and sync for the file
 *   collab   — the room, its keys and whether it is on: capability, and the
 *              thing #588's read-only lock reads, so undo can never unlock a
 *              view-only copy
 *   readonly — the file's mode
 * The same list as bento/slides' FROM_LIVE (restoregate.ts). A local copy for
 * now; kernel will lift one shared list for every app.
 *
 * Consequence worth knowing: undoing a whole-document REPLACE (Replace from
 * JSON, loadDoc, restoring a recovery snapshot) brings back the earlier
 * CONTENT under the identity that replace brought in — identity is not
 * undoable, whichever action changed it. bento/slides behaves the same.
 */
export const FROM_LIVE = ['docId', 'collab', 'readonly'] as const;

export function keepLiveIdentity(doc: TypeDoc, live: TypeDoc): void {
  const d = doc as unknown as Record<string, unknown>;
  const l = live as unknown as Record<string, unknown>;
  for (const k of FROM_LIVE) {
    if (l[k] !== undefined) d[k] = l[k];
    else delete d[k];
  }
}

export class Store {
  #doc: TypeDoc;
  #undo: Snap[] = [];
  #redo: Snap[] = [];
  #listeners = new Set<Listener>();
  /** the open coalescing run, so a burst of typing is ONE undo step */
  #run: string | null = null;

  constructor(doc: TypeDoc) { this.#doc = doc; this.#relock(); }

  /**
   * True while the document is a RECEIVE-ONLY copy (a view-only reader, or a
   * live-show audience member). User edits are refused; see `commit`.
   *
   * DERIVED from the document and recomputed on every change, never set once
   * at boot. A copy can arrive in a running editor by load, by `loadDoc`, by
   * restoring a recovery snapshot, or by undoing a replace — and bento/slides
   * found the version of this lock that was decided only at build time, which
   * a dropped-in reader copy simply walked past. Deriving it means there is no
   * path to forget.
   */
  #locked = false;
  get locked(): boolean { return this.#locked; }
  #relock(): void { this.#locked = copyIsReceiveOnly(this.#doc.collab); }

  get doc(): TypeDoc { return this.#doc; }
  get canUndo(): boolean { return this.#undo.length > 0; }
  get canRedo(): boolean { return this.#redo.length > 0; }
  /** depth, for diagnostics and for proving the scoped-snapshot claim */
  get undoDepth(): number { return this.#undo.length; }

  on(fn: Listener): () => void { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  #emit() { this.#relock(); for (const fn of this.#listeners) fn(this.#doc); }

  #snap(scope: Scope): Snap {
    if (scope === 'doc') return { kind: 'doc', doc: clone(this.#doc) };
    const index = this.#doc.body.findIndex(b => b.id === scope.block);
    if (index < 0) return { kind: 'doc', doc: clone(this.#doc) };
    return { kind: 'block', id: scope.block, index, block: clone(this.#doc.body[index]) };
  }

  #push(s: Snap) {
    this.#undo.push(s);
    if (this.#undo.length > LIMIT) this.#undo.shift();
    this.#redo.length = 0;
  }

  /**
   * Mutate the document.
   *
   * `run` names a coalescing group: successive commits with the SAME run share
   * one undo step, which is how a typed word is one press of ⌘Z rather than
   * five. Any commit without a run, or with a different one, closes the group.
   */
  commit(fn: (doc: TypeDoc) => void, opts: { scope?: Scope; run?: string; system?: boolean } = {}): void {
    // A receive-only copy takes no USER edits — the relay would drop them, so
    // they would live only here and quietly diverge this file from the room it
    // claims to follow. `system` is for the sync session's own bookkeeping
    // (materialising a peer's published images, kernel session.ts
    // resolveBlobs), which a reader needs more than anyone: blocking it would
    // leave every reader looking at empty pictures.
    if (this.#locked && !opts.system) return;
    const scope = opts.scope ?? 'doc';
    const run = opts.run ?? null;
    if (run === null || run !== this.#run) this.#push(this.#snap(scope));
    this.#run = run;
    fn(this.#doc);
    this.#emit();
  }

  /** End the current typing run, so the next edit starts a new undo step. */
  breakRun(): void { this.#run = null; }

  /**
   * Announce a change that was made to the document from OUTSIDE — a remote
   * collaborator's edit applied surgically by the sync session.
   *
   * Deliberately NOT `commit`: a remote edit must not land on this person's
   * undo stack. ⌘Z means "undo what I did", and pushing a snapshot here would
   * make it revert a colleague's paragraph instead — while also making their
   * edit re-appear on redo, which is worse.
   */
  touch(): void { this.#emit(); }

  /** Replace the whole document — loading a file, or restoring a revision. */
  replace(doc: TypeDoc): void {
    this.#push({ kind: 'doc', doc: clone(this.#doc) });
    this.#run = null;
    this.#doc = doc;
    this.#emit();
  }

  #apply(s: Snap): Snap {
    if (s.kind === 'doc') {
      const inverse: Snap = { kind: 'doc', doc: clone(this.#doc) };
      const live = this.#doc;
      this.#doc = s.doc;
      keepLiveIdentity(this.#doc, live);
      return inverse;
    }
    // A block snapshot restores that block in place. If the block is gone (a
    // later whole-doc edit removed it) fall back to re-inserting at the index
    // it had, rather than dropping the user's text on the floor.
    const at = this.#doc.body.findIndex(b => b.id === s.id);
    if (at >= 0) {
      const inverse: Snap = { kind: 'block', id: s.id, index: at, block: clone(this.#doc.body[at]) };
      this.#doc.body[at] = s.block;
      return inverse;
    }
    const index = Math.min(s.index, this.#doc.body.length);
    const inverse: Snap = { kind: 'doc', doc: clone(this.#doc) };
    this.#doc.body.splice(index, 0, s.block);
    return inverse;
  }

  undo(): boolean {
    const s = this.#undo.pop();
    if (!s) return false;
    this.#redo.push(this.#apply(s));
    this.#run = null;
    this.#emit();
    return true;
  }

  redo(): boolean {
    const s = this.#redo.pop();
    if (!s) return false;
    this.#undo.push(this.#apply(s));
    this.#run = null;
    this.#emit();
    return true;
  }

  block(id: string): Block | undefined { return this.#doc.body.find(b => b.id === id); }
}
