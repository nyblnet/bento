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

type Snap =
  | { kind: 'doc'; doc: TypeDoc }
  | { kind: 'block'; id: string; index: number; block: Block };

export type Scope = 'doc' | { block: string };
type Listener = (doc: TypeDoc) => void;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const LIMIT = 200;

export class Store {
  #doc: TypeDoc;
  #undo: Snap[] = [];
  #redo: Snap[] = [];
  #listeners = new Set<Listener>();
  /** the open coalescing run, so a burst of typing is ONE undo step */
  #run: string | null = null;

  constructor(doc: TypeDoc) { this.#doc = doc; }

  get doc(): TypeDoc { return this.#doc; }
  get canUndo(): boolean { return this.#undo.length > 0; }
  get canRedo(): boolean { return this.#redo.length > 0; }
  /** depth, for diagnostics and for proving the scoped-snapshot claim */
  get undoDepth(): number { return this.#undo.length; }

  on(fn: Listener): () => void { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  #emit() { for (const fn of this.#listeners) fn(this.#doc); }

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
  commit(fn: (doc: TypeDoc) => void, opts: { scope?: Scope; run?: string } = {}): void {
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
      this.#doc = s.doc;
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
