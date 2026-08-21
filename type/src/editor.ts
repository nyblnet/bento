// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The editing loop.
//
// The browser lays out and the browser moves the caret; this file owns the
// MODEL. Three rules keep that honest:
//
//  1. THE CARET IS A MODEL POSITION — (block id, offset into that block's
//     text) — never a DOM position. Forced by measurement: with hyphenation on
//     the renderer inserts characters, so any address in rendered space drifts
//     (working/type-spike/RESULTS.md, C3). Footnote markers are skipped when
//     counting, for the same reason.
//  2. STRUCTURAL EDITS ARE INTERCEPTED. Splitting a paragraph and merging two
//     are done in the model and re-rendered, not left to contentEditable — the
//     browser's version invents elements with no id, and an id it invented is
//     a paragraph the redline cannot align.
//  3. UNDO IS OURS. The browser's contentEditable undo knows nothing about the
//     model, so it is suppressed and every ⌘Z goes through the store.

import { renderBody, renderBlock, readBlock, isNoteAtom, TAG } from './render.ts';
import { toggleMark, activeAt, type MarkType } from './inline.ts';
import { uid, type Block, type TypeDoc } from './model.ts';
import type { Store } from './store.ts';

export interface Caret { id: string; at: number; to?: number }

export class Editor {
  readonly host: HTMLElement;
  readonly store: Store;
  /** fires after the model changed and the DOM was reconciled */
  onChange: (() => void) | null = null;
  /** fires when the caret moves, so a toolbar can show what is active */
  onSelection: ((marks: Set<MarkType>) => void) | null = null;

  constructor(host: HTMLElement, store: Store) {
    this.host = host;
    this.store = store;
    host.contentEditable = 'true';
    host.spellcheck = true;
    this.render();
    host.addEventListener('beforeinput', this.#beforeInput);
    host.addEventListener('input', this.#input);
    host.addEventListener('keydown', this.#keydown);
    document.addEventListener('selectionchange', this.#selectionChange);
  }

  render(): void {
    renderBody(this.store.doc, this.host);
  }

  // ───────────────────────────────────────────────────────── caret ↔ model

  /** Where the caret is, in the document's own coordinates. */
  caret(): Caret | null {
    const sel = getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!this.host.contains(r.startContainer)) return null;
    const startBlock = this.#blockOf(r.startContainer);
    if (!startBlock) return null;
    const at = this.#offsetIn(startBlock, r.startContainer, r.startOffset);
    if (sel.isCollapsed) return { id: startBlock.dataset.id!, at };
    const endBlock = this.#blockOf(r.endContainer);
    if (endBlock !== startBlock) return { id: startBlock.dataset.id!, at };   // cross-block: anchor only
    return { id: startBlock.dataset.id!, at, to: this.#offsetIn(startBlock, r.endContainer, r.endOffset) };
  }

  setCaret(c: Caret | null): void {
    if (!c) return;
    const block = this.#el(c.id);
    if (!block) return;
    const a = this.#pointAt(block, c.at);
    if (!a) return;
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    if (c.to !== undefined && c.to !== c.at) {
      const b = this.#pointAt(block, c.to);
      if (b) r.setEnd(b.node, b.offset); else r.collapse(true);
    } else r.collapse(true);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  }

  #el(id: string): HTMLElement | null {
    return this.host.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
  }
  #blockOf(node: Node): HTMLElement | null {
    let n: Node | null = node;
    while (n && n !== this.host) {
      if (n.nodeType === 1 && (n as HTMLElement).dataset?.id) return n as HTMLElement;
      n = n.parentNode;
    }
    return null;
  }
  /** Characters before (container, offset) inside this block — atoms excluded. */
  #offsetIn(block: HTMLElement, container: Node, offset: number): number {
    let count = 0, done = false;
    const walk = (n: Node): void => {
      if (done) return;
      if (n === container && n.nodeType !== 3) {
        // an element container: offset counts CHILDREN, not characters
        for (let i = 0; i < offset && i < n.childNodes.length; i++) walk(n.childNodes[i]);
        done = true; return;
      }
      if (n.nodeType === 3) {
        if (n === container) { count += Math.min(offset, n.nodeValue!.length); done = true; return; }
        count += n.nodeValue!.length; return;
      }
      if (n.nodeType === 1 && isNoteAtom(n as Element)) return;      // atoms are not characters
      for (const c of Array.from(n.childNodes)) { walk(c); if (done) return; }
    };
    for (const c of Array.from(block.childNodes)) { walk(c); if (done) break; }
    return count;
  }
  /** The DOM point `at` characters into this block. */
  #pointAt(block: HTMLElement, at: number): { node: Node; offset: number } | null {
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
    return last ?? { node: block, offset: 0 };
  }

  // ─────────────────────────────────────────────────────────── input

  #runId: string | null = null;

  #input = (): void => {
    const c = this.caret();
    if (!c) return;
    const el = this.#el(c.id);
    if (!el) return;
    const prev = this.store.block(c.id);
    if (!prev) return;
    const next = readBlock(el, prev);
    if (next.text === prev.text && JSON.stringify(next.marks) === JSON.stringify(prev.marks)) return;
    // one undo step per typing run, per block
    this.#runId ??= `type:${c.id}:${Date.now()}`;
    this.store.commit(d => {
      const i = d.body.findIndex(b => b.id === c.id);
      if (i >= 0) d.body[i] = next;
    }, { scope: { block: c.id }, run: this.#runId });
    this.onChange?.();
  };

  /**
   * Structural edits are done in the MODEL, not by contentEditable.
   *
   * Left to itself the browser splits a paragraph by cloning the element —
   * including its `data-id`. Two blocks with one id is precisely what the
   * redline cannot align and what the model's own parse has to repair, so the
   * split is intercepted and the new block gets a fresh id here.
   */
  #beforeInput = (e: InputEvent): void => {
    const c = this.caret();
    if (!c) return;
    if (e.inputType === 'insertParagraph') {
      e.preventDefault();
      this.#splitBlock(c);
      return;
    }
    if (e.inputType === 'deleteContentBackward' && c.to === undefined && c.at === 0) {
      const i = this.store.doc.body.findIndex(b => b.id === c.id);
      if (i > 0) { e.preventDefault(); this.#mergeBack(i); }
      return;
    }
  };

  #splitBlock(c: Caret): void {
    const i = this.store.doc.body.findIndex(b => b.id === c.id);
    if (i < 0) return;
    const src = this.store.doc.body[i];
    const head = spliceKeep(src, 0, c.at);
    const tailText = src.text.slice(c.at);
    const tail: Block = {
      id: uid(),
      // a heading's continuation is a paragraph — nobody wants two headings
      kind: src.kind === 'para' || src.kind === 'quote' ? src.kind : 'para',
      text: tailText,
    };
    const shifted = shiftPast(src, c.at);
    if (shifted.marks?.length) tail.marks = shifted.marks;
    if (shifted.notes?.length) tail.notes = shifted.notes;
    this.store.breakRun();
    this.#runId = null;
    this.store.commit(d => { d.body.splice(i, 1, head, tail); });
    this.render();
    this.setCaret({ id: tail.id, at: 0 });
    this.onChange?.();
  }

  #mergeBack(i: number): void {
    const body = this.store.doc.body;
    const prev = body[i - 1], cur = body[i];
    const at = prev.text.length;
    const merged: Block = { ...prev, text: prev.text + cur.text };
    const marks = [...(prev.marks ?? []), ...(cur.marks ?? []).map(m => ({ ...m, from: m.from + at, to: m.to + at }))];
    const notes = [...(prev.notes ?? []), ...(cur.notes ?? []).map(n => ({ ...n, at: n.at + at }))];
    if (marks.length) merged.marks = marks; else delete merged.marks;
    if (notes.length) merged.notes = notes; else delete merged.notes;
    this.store.breakRun();
    this.#runId = null;
    this.store.commit(d => { d.body.splice(i - 1, 2, merged); });
    this.render();
    this.setCaret({ id: merged.id, at });
    this.onChange?.();
  }

  // ────────────────────────────────────────────────────────── formatting

  /** ⌘B and friends, applied to the model and re-rendered. */
  toggle(t: MarkType, href?: string): void {
    const c = this.caret();
    if (!c || c.to === undefined || c.to === c.at) return;   // nothing selected
    const from = Math.min(c.at, c.to), to = Math.max(c.at, c.to);
    const blk = this.store.block(c.id);
    if (!blk) return;
    this.store.breakRun();
    this.#runId = null;
    this.store.commit(d => {
      const i = d.body.findIndex(b => b.id === c.id);
      if (i < 0) return;
      const b = d.body[i];
      const marks = toggleMark(b.marks ?? [], b.text.length, from, to, t, href);
      if (marks.length) b.marks = marks; else delete b.marks;
    }, { scope: { block: c.id } });
    this.render();
    this.setCaret({ id: c.id, at: from, to });
    this.onChange?.();
  }

  /** Change a block's kind — paragraph, heading, quote. */
  setKind(kind: Block['kind']): void {
    const c = this.caret();
    if (!c) return;
    this.store.breakRun();
    this.store.commit(d => {
      const b = d.body.find(x => x.id === c.id);
      if (b) b.kind = kind;
    }, { scope: { block: c.id } });
    this.render();
    this.setCaret(c);
    this.onChange?.();
  }

  // ───────────────────────────────────────────────────────────── keys

  #keydown = (e: KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'z') {
      e.preventDefault();
      const c = this.caret();
      if (e.shiftKey) this.store.redo(); else this.store.undo();
      this.render();
      if (c && this.#el(c.id)) this.setCaret(c);
      this.onChange?.();
      return;
    }
    if (k === 'b' || k === 'i' || k === 'u') {
      e.preventDefault();
      this.toggle(k === 'b' ? 'b' : k === 'i' ? 'i' : 'u');
    }
  };

  #selectionChange = (): void => {
    if (!this.onSelection) return;
    const c = this.caret();
    if (!c) return;
    const blk = this.store.block(c.id);
    if (!blk) return;
    this.onSelection(activeAt(blk.marks ?? [], c.to !== undefined ? Math.min(c.at, c.to) + 1 : c.at));
  };

  destroy(): void {
    this.host.removeEventListener('beforeinput', this.#beforeInput);
    this.host.removeEventListener('input', this.#input);
    this.host.removeEventListener('keydown', this.#keydown);
    document.removeEventListener('selectionchange', this.#selectionChange);
  }
}

/** The head of a split: text up to `at`, with marks and notes clipped to it. */
function spliceKeep(b: Block, from: number, to: number): Block {
  const text = b.text.slice(from, to);
  const out: Block = { ...b, text };
  const marks = (b.marks ?? [])
    .map(m => ({ ...m, from: Math.max(0, m.from - from), to: Math.min(to - from, m.to - from) }))
    .filter(m => m.to > m.from);
  const notes = (b.notes ?? []).filter(n => n.at >= from && n.at <= to).map(n => ({ ...n, at: n.at - from }));
  if (marks.length) out.marks = marks; else delete out.marks;
  if (notes.length) out.notes = notes; else delete out.notes;
  return out;
}

/** The tail of a split: everything from `at`, rebased to 0. */
function shiftPast(b: Block, at: number): { marks?: Block['marks']; notes?: Block['notes'] } {
  const len = b.text.length - at;
  const marks = (b.marks ?? [])
    .map(m => ({ ...m, from: Math.max(0, m.from - at), to: Math.min(len, m.to - at) }))
    .filter(m => m.to > m.from);
  const notes = (b.notes ?? []).filter(n => n.at > at).map(n => ({ ...n, at: n.at - at }));
  return { marks: marks.length ? marks : undefined, notes: notes.length ? notes : undefined };
}

export { TAG, renderBlock };
export type { TypeDoc };
