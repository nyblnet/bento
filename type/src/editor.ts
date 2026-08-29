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
import { toggleMark, activeAt, setFont, fontAcross, type MarkType, type FontAttrs } from './inline.ts';
import { isList, uid, MAX_LIST_LEVEL, type Block, type TypeDoc } from './model.ts';
import type { Store } from './store.ts';
import { commentsOnEdit, commentsOnSplit, commentsOnMerge } from './comments.ts';
import { knownAuthor } from './comments.ts';
import { tracking, trackEdit, editSpan, caretAfter } from './track.ts';

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

    // TRACKED CHANGES are applied HERE, at the one point where the editor knows
    // both the before and the after of a block. Deleted characters are put
    // BACK and marked, so the DOM the browser just produced is no longer what
    // the model says — which is why this path re-renders and re-places the
    // caret, and the untracked path (overwhelmingly the common one) does not.
    const tracked = tracking(this.store.doc)
      ? trackEdit(prev, next, knownAuthor() || 'Anonymous', new Date().toISOString())
      : next;
    // Re-render whenever tracking CHANGED anything — not only when it restored
    // deleted characters. An insertion leaves the text identical, so the first
    // version of this skipped the render and the new ins mark sat in the model
    // with nothing on screen to show for it: you typed into a tracked document
    // and saw ordinary text.
    const rerender = tracking(this.store.doc)
      && (tracked.text !== next.text
          || JSON.stringify(tracked.marks) !== JSON.stringify(next.marks));
    const caretAt = rerender ? caretAfter(editSpan(prev, next)) : undefined;

    // one undo step per typing run, per block
    this.#runId ??= `type:${c.id}:${Date.now()}`;
    this.store.commit(d => {
      const i = d.body.findIndex(b => b.id === c.id);
      if (i >= 0) d.body[i] = tracked;
      // INSIDE the commit deliberately: an anchor that moved outside it would
      // survive a ⌘Z that put the words back, leaving the comment pointing at
      // text nobody wrote. Returns false when the block carries no comment, so
      // an ordinary paragraph never widens anybody's undo scope.
      commentsOnEdit(d, c.id, prev.text, next.text);
    }, { scope: { block: c.id }, run: this.#runId });
    if (rerender) {
      // Just THIS block, not the whole body: tracking re-renders on nearly
      // every keystroke, and renderBody rebuilds every paragraph in the
      // document — on a long contract that is a visible stall per character.
      const fresh = renderBlock(tracked);
      el.replaceWith(fresh);
      if (caretAt !== undefined) this.setCaret({ id: c.id, at: caretAt });
    }
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
      // Enter on an EMPTY list item ends the list instead of adding another
      // empty one — outdenting a level at a time, then becoming a paragraph.
      // Every word processor does this and its absence is felt immediately:
      // without it there is no way out of a list except changing the kind by
      // hand.
      const blk = this.store.block(c.id);
      if (blk && isList(blk.kind) && blk.text === '') {
        this.#exitList(c);
        return;
      }
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
      // a heading's continuation is a paragraph — nobody wants two headings;
      // a list item's continuation is another item at the same level, which is
      // what makes a list feel like a list rather than a kind you re-pick
      kind: src.kind === 'para' || src.kind === 'quote' || isList(src.kind) ? src.kind : 'para',
      text: tailText,
    };
    if (isList(src.kind) && src.level) tail.level = src.level;
    const shifted = shiftPast(src, c.at);
    if (shifted.marks?.length) tail.marks = shifted.marks;
    if (shifted.notes?.length) tail.notes = shifted.notes;
    this.store.breakRun();
    this.#runId = null;
    this.store.commit(d => {
      d.body.splice(i, 1, head, tail);
      commentsOnSplit(d, src.id, c.at, src.text.length, tail.id);
    });
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
    this.store.commit(d => {
      d.body.splice(i - 1, 2, merged);
      commentsOnMerge(d, prev.id, cur.id, at);
    });
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

  /**
   * Set the typeface and/or size across the selection.
   *
   * Mirrors toggle(), but it is not a toggle: a font has a VALUE, so choosing
   * Verdana over a Georgia run replaces it rather than turning something on
   * and off. Pass null for an attribute to clear it back to the document
   * default; leave it undefined to change only the other one.
   */
  setFontOn(attrs: FontAttrs): void {
    const c = this.caret();
    if (!c || c.to === undefined || c.to === c.at) return;   // nothing selected
    const from = Math.min(c.at, c.to), to = Math.max(c.at, c.to);
    if (!this.store.block(c.id)) return;
    this.store.breakRun();
    this.#runId = null;
    this.store.commit(d => {
      const i = d.body.findIndex(b => b.id === c.id);
      if (i < 0) return;
      const b = d.body[i];
      const marks = setFont(b.marks ?? [], b.text.length, from, to, attrs);
      if (marks.length) b.marks = marks; else delete b.marks;
    }, { scope: { block: c.id } });
    this.render();
    this.setCaret({ id: c.id, at: from, to });
    this.onChange?.();
  }

  /** The typeface across the selection — a value, 'mixed', or nothing. */
  fontOfSelection(): { family: string | 'mixed' | undefined; size: number | 'mixed' | undefined } {
    const c = this.caret();
    const blk = c ? this.store.block(c.id) : undefined;
    if (!c || !blk) return { family: undefined, size: undefined };
    const from = Math.min(c.at, c.to ?? c.at), to = Math.max(c.at, c.to ?? c.at);
    return fontAcross(blk.marks ?? [], from, to);
  }

  /** Change a block's kind — paragraph, heading, quote. */
  /**
   * Insert a table at the caret: `rows` x `cols` empty cells, header row first.
   *
   * Every cell is a block, so this is an ordinary splice into `body` — nothing
   * about the caret, the redline or pagination has to learn what a table is.
   */
  insertTable(rows = 3, cols = 3): void {
    const c = this.caret();
    if (!c) return;
    const i = this.store.doc.body.findIndex(b => b.id === c.id);
    if (i < 0) return;
    const table = uid();
    const cells: Block[] = [];
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < cols; k++) {
        cells.push({ id: uid(), kind: 'cell', text: '',
                     cell: { table, cols, ...(r === 0 ? { head: true } : {}) } });
      }
    }
    this.store.breakRun();
    this.#runId = null;
    // An empty paragraph at the caret is consumed; anything with text keeps its
    // place and the table lands after it.
    const here = this.store.doc.body[i];
    const at = here.text === '' && here.kind === 'para' ? i : i + 1;
    const drop = here.text === '' && here.kind === 'para' ? 1 : 0;
    this.store.commit(d => { d.body.splice(at, drop, ...cells); });
    this.render();
    this.setCaret({ id: cells[0].id, at: 0 });
    this.onChange?.();
  }

  /**
   * Tab inside a table moves to the next cell, and off the last cell adds a
   * row — the behaviour every table editor has, and the one that makes a table
   * fillable without reaching for the mouse.
   */
  #nextCell(back: boolean): boolean {
    const c = this.caret();
    if (!c) return false;
    const body = this.store.doc.body;
    const i = body.findIndex(b => b.id === c.id);
    const here = body[i];
    if (i < 0 || here?.kind !== 'cell' || !here.cell) return false;
    const step = back ? -1 : 1;
    const next = body[i + step];
    if (next?.kind === 'cell' && next.cell?.table === here.cell.table) {
      this.setCaret({ id: next.id, at: 0 });
      return true;
    }
    if (back) return true;                       // at the first cell: stay put
    // off the end: append one row
    const { table, cols } = here.cell;
    const fresh: Block[] = Array.from({ length: cols }, () =>
      ({ id: uid(), kind: 'cell' as const, text: '', cell: { table, cols } }));
    this.store.breakRun();
    this.store.commit(d => { d.body.splice(i + 1, 0, ...fresh); });
    this.render();
    this.setCaret({ id: fresh[0].id, at: 0 });
    this.onChange?.();
    return true;
  }

  /** Insert a picture at the caret as its own block. */
  insertImage(image: { src: string; alt?: string }): void {
    const c = this.caret();
    if (!c) return;
    const i = this.store.doc.body.findIndex(b => b.id === c.id);
    if (i < 0) return;
    const here = this.store.doc.body[i];
    const block: Block = { id: uid(), kind: 'image', text: '', image: { ...image } };
    // a following paragraph, so there is somewhere to type after the picture —
    // an image as the last block leaves the caret nowhere to go
    const after: Block = { id: uid(), kind: 'para', text: '' };
    const empty = here.kind === 'para' && here.text === '';
    this.store.breakRun();
    this.#runId = null;
    this.store.commit(d => { d.body.splice(empty ? i : i + 1, empty ? 1 : 0, block, after); });
    this.render();
    this.setCaret({ id: after.id, at: 0 });
    this.onChange?.();
  }

  /** Empty list item + Enter: outdent one level, or leave the list entirely. */
  #exitList(c: Caret): void {
    this.store.breakRun();
    this.#runId = null;
    this.store.commit(d => {
      const b = d.body.find(x => x.id === c.id);
      if (!b) return;
      const lv = b.level ?? 0;
      if (lv > 0) b.level = lv - 1 || undefined;
      else { b.kind = 'para'; delete b.level; }
    }, { scope: { block: c.id } });
    this.render();
    this.setCaret(c);
    this.onChange?.();
  }

  /**
   * Indent or outdent a list item.
   *
   * An item may only ever be one level deeper than the item above it. Allowing
   * a jump would produce a list whose first child is nested two deep, which the
   * renderer has to express as two <ul>s with nothing between them — legal HTML
   * that reads as a bug.
   */
  indent(by: 1 | -1): boolean {
    const c = this.caret();
    if (!c) return false;
    const i = this.store.doc.body.findIndex(b => b.id === c.id);
    if (i < 0) return false;
    const b = this.store.doc.body[i];
    if (!isList(b.kind)) return false;
    const cur = b.level ?? 0;
    const prev = i > 0 ? this.store.doc.body[i - 1] : undefined;
    const ceiling = prev && isList(prev.kind) ? (prev.level ?? 0) + 1 : 0;
    const next = Math.max(0, Math.min(by > 0 ? ceiling : cur - 1, MAX_LIST_LEVEL));
    if (next === cur) return false;
    this.store.breakRun();
    this.store.commit(d => {
      const t = d.body.find(x => x.id === c.id);
      if (t) { if (next) t.level = next; else delete t.level; }
    }, { scope: { block: c.id } });
    this.render();
    this.setCaret(c);
    this.onChange?.();
    return true;
  }

  setKind(kind: Block['kind']): void {
    const c = this.caret();
    if (!c) return;
    this.store.breakRun();
    this.store.commit(d => {
      const b = d.body.find(x => x.id === c.id);
      if (!b) return;
      b.kind = kind;
      // a level left behind on a paragraph is dead data that reappears the
      // moment somebody makes it a list again, at a depth they did not choose
      if (!isList(kind)) delete b.level;
    }, { scope: { block: c.id } });
    this.render();
    this.setCaret(c);
    this.onChange?.();
  }

  // ───────────────────────────────────────────────────────────── keys

  #keydown = (e: KeyboardEvent): void => {
    // Tab indents a list item. It is NOT swallowed elsewhere: in a document
    // that is not a list, Tab must still move focus out of the editor, which is
    // the only way a keyboard user leaves it.
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // A table cell claims Tab first: inside a grid it means "next cell", and
      // indenting a cell would mean nothing.
      if (this.#nextCell(e.shiftKey) || this.indent(e.shiftKey ? -1 : 1)) e.preventDefault();
      return;
    }
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

  /**
   * The marks in force at the caret.
   *
   * The same answer `onSelection` pushes, available to ASK for. A panel that
   * rebuilds itself needs the state at the moment it rebuilds, and a single
   * push callback can only have one subscriber — so a second consumer either
   * hijacks it or mirrors it into a variable that is stale by definition.
   */
  activeMarks(): Set<MarkType> {
    const c = this.caret();
    if (!c) return new Set();
    const blk = this.store.block(c.id);
    if (!blk) return new Set();
    return activeAt(blk.marks ?? [], c.to !== undefined ? Math.min(c.at, c.to) + 1 : c.at);
  }

  #selectionChange = (): void => {
    if (!this.onSelection) return;
    const marks = this.activeMarks();
    if (!this.caret()) return;
    this.onSelection(marks);
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
