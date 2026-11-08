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
import { fillFields } from './fields.ts';
import { toggleMark, activeAt, setFont, fontAcross, type MarkType, type FontAttrs } from './inline.ts';
import { isList, uid, spliceText, MAX_LIST_LEVEL, type Block, type TypeDoc } from './model.ts';
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
    // Editable only while the copy may write — and kept in step with the store,
    // because a receive-only copy can arrive AFTER boot (see Store.locked).
    const follow = () => { host.contentEditable = store.locked ? 'false' : 'true'; };
    follow();
    store.on(follow);
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
    // From the block ITSELF: a boundary can sit on the block element (Chrome's
    // triple-click ends at the next paragraph's element, offset 0), and a walk
    // over its children alone never met that container and counted the whole
    // block.
    walk(block);
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
      // Derived content in the fresh block has to be filled, or it renders as
      // its placeholder: `blockHtml` emits a field atom UNRESOLVED and the
      // filler puts the value in (fields.ts, mirroring numberXrefs). renderBody
      // does that for a whole-document render; this path replaces one block and
      // never reaches it, so a field in a TRACKED document flashed back to its
      // own name on every keystroke in that paragraph.
      el.replaceWith(fresh);
      fillFields(fresh, this.store.doc);
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
    // A selection the single-block path cannot follow — one that crosses
    // blocks, or (after Select All) starts or ends outside any block — is
    // edited HERE, in the model. Left to contentEditable, the browser deletes
    // the paragraphs between the ends and fuses the two it keeps into one
    // element, while `input` reads back only the block the caret lands in:
    // the screen shows one paragraph, the model still holds them all, and the
    // next render brings back everything the user deleted.
    const span = this.#span();
    if (span) {
      const kind = e.inputType;
      const text = kind === 'insertText' || kind === 'insertReplacementText' ? e.data ?? e.dataTransfer?.getData('text/plain') ?? ''
        : kind === 'insertFromPaste' || kind === 'insertFromDrop' ? e.dataTransfer?.getData('text/plain') ?? ''
        : '';
      if (kind.startsWith('delete') || kind === 'insertParagraph' || kind === 'insertLineBreak'
          || kind === 'insertText' || kind === 'insertReplacementText') {
        e.preventDefault();
        this.#replaceSpan(span.a, span.b, text, kind === 'insertParagraph');
        return;
      }
      if (kind === 'insertFromPaste' || kind === 'insertFromDrop') {
        // The range goes in the model first; the pasted text then takes the
        // same road as a paste at a caret (one block, read back by `input`), so
        // a paste over a range behaves exactly like a paste anywhere else.
        e.preventDefault();
        this.#replaceSpan(span.a, span.b, '', false);
        if (text) document.execCommand('insertText', false, text);
        return;
      }
      // Anything else (composition, formatting commands) is not ours to take
      // over yet; it keeps the browser's behaviour.
    }
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
    if (c.to !== undefined && c.to !== c.at) return;          // a range inside one block: the browser's
    const kind = e.inputType;
    // Backspace at the start of a block joins it onto the one before; forward
    // Delete at the END joins the next one onto it. Both are structural, so
    // both are model edits: the browser's own forward join moved the text on
    // screen and left the model with two blocks.
    if (kind.startsWith('delete') && kind.endsWith('Backward') && c.at === 0) {
      const i = this.store.doc.body.findIndex(b => b.id === c.id);
      // At the very start of the document there is nothing to join, and the
      // browser's own answer was to delete an empty first block's element:
      // gone on screen, still in the model.
      if (i >= 0) e.preventDefault();
      if (i > 0) this.#join(i);
      return;
    }
    if (kind.startsWith('delete') && kind.endsWith('Forward')) {
      const body = this.store.doc.body;
      const i = body.findIndex(b => b.id === c.id);
      if (i >= 0 && c.at >= body[i].text.length) {
        e.preventDefault();                       // at the very end of the document: nothing to join
        if (i + 1 < body.length) this.#join(i + 1);
      }
    }
  };

  // ───────────────────────────────────────────────────── ranges across blocks

  /**
   * Both ends of the selection in model coordinates, when the single-block
   * path cannot handle it: the ends lie in different blocks, or one of them
   * sits outside every block (Select All puts it on the paper itself).
   * Null for a caret, or for a selection inside one block.
   */
  #span(): { a: { id: string; at: number }; b: { id: string; at: number } } | null {
    const sel = getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!this.host.contains(r.startContainer) || !this.host.contains(r.endContainer)) return null;
    const inA = this.#blockOf(r.startContainer), inB = this.#blockOf(r.endContainer);
    if (inA && inA === inB) return null;
    const a = this.#resolve(r.startContainer, r.startOffset, 'start');
    const b = this.#resolve(r.endContainer, r.endOffset, 'end');
    if (!a || !b) return null;
    const body = this.store.doc.body;
    if (body.findIndex(x => x.id === a.id) > body.findIndex(x => x.id === b.id)) return null;   // nothing selected
    return { a, b };
  }

  /**
   * A selection boundary as (block id, offset). Inside a block it is the
   * caret's own reading; between blocks (on the paper, a list or a table
   * wrapper) it snaps to the nearest block INSIDE the selection: the start to
   * the beginning of the next block, the end to the end of the previous one.
   */
  #resolve(node: Node, offset: number, side: 'start' | 'end'): { id: string; at: number } | null {
    const own = this.#blockOf(node);
    if (own) return { id: own.dataset.id!, at: this.#offsetIn(own, node, offset) };
    const point = document.createRange();
    point.setStart(node, offset);
    const els = [...this.host.querySelectorAll<HTMLElement>('[data-id]')].filter(el => this.#blockOf(el.parentNode!) === null);
    if (side === 'start') {
      const el = els.find(x => point.comparePoint(x, 0) >= 0);
      return el ? { id: el.dataset.id!, at: 0 } : null;
    }
    const el = els.filter(x => point.comparePoint(x, x.childNodes.length) <= 0).pop();
    return el ? { id: el.dataset.id!, at: this.#offsetIn(el, el, el.childNodes.length) } : null;
  }

  /**
   * Replace everything from `a` to `b` with `text` (and, for Enter, a split
   * after it) — ONE commit, so ONE ⌘Z puts back exactly what was selected.
   *
   * The first block keeps its identity and the last block's remainder is
   * joined onto it, the same rule Backspace at a block's start follows; the
   * blocks between are removed. Two cases keep the structure instead and only
   * clear the selected text: a range that touches a table (fusing a cell with a
   * paragraph would break the grid) and a tracked document (the deletion is
   * recorded as struck-through text, and a paragraph break cannot be).
   */
  #replaceSpan(a: { id: string; at: number }, b: { id: string; at: number }, text: string, split: boolean): void {
    const body = this.store.doc.body;
    const i = body.findIndex(x => x.id === a.id), j = body.findIndex(x => x.id === b.id);
    if (i < 0 || j < 0 || j < i) return;
    const tracked = tracking(this.store.doc);
    const keep = tracked || body.slice(i, j + 1).some(x => x.kind === 'cell');
    // pasted or dropped text arrives here as one line; a line break would need a split
    const line = text.replace(/\r?\n/g, ' ');
    let caret: Caret | null = null;
    this.store.breakRun();
    this.#runId = null;
    this.store.commit(d => {
      const by = knownAuthor() || 'Anonymous', when = new Date().toISOString();
      const put = (k: number, next: Block) => {
        const prev = d.body[k];
        const out = tracked ? trackEdit(prev, next, by, when) : next;
        d.body[k] = out;
        commentsOnEdit(d, prev.id, prev.text, out.text);
        return out;
      };
      let at: number, k: number;
      if (keep) {
        k = -1; at = 0;
        for (let n = i; n <= j; n++) {
          const blk = d.body[n];
          if (!TEXT_KINDS.has(blk.kind)) continue;
          const from = n === i ? Math.min(a.at, blk.text.length) : 0;
          const to = n === j ? Math.min(b.at, blk.text.length) : blk.text.length;
          if (to > from) put(n, spliceText(blk, from, to - from, ''));
          if (k < 0) { k = n; at = from; }
        }
        if (k < 0) return;                          // nothing editable in range
      } else {
        // A footnote, citation or field strictly inside the selection goes with
        // it; one exactly at either end stays (spliceKeep's rule for a split).
        // The typed text is appended to the head BEFORE the join, so it lands
        // after a marker that sat just before the selection and before one
        // that sat just after it, the way it reads on screen.
        const A = d.body[i], B = d.body[j];
        let head = TEXT_KINDS.has(A.kind) ? spliceKeep(A, 0, Math.min(a.at, A.text.length)) : null;
        if (line) head = { ...(head ?? { id: uid(), kind: 'para', text: '' }), text: (head?.text ?? '') + line };
        const tail = TEXT_KINDS.has(B.kind) ? spliceKeep(B, Math.min(b.at, B.text.length), B.text.length) : null;
        let merged: Block;
        if (i === j && head && tail) {
          // one block (Select All in a one-paragraph document): an edit, not a merge
          merged = joinBlocks(head, tail);
          commentsOnEdit(d, A.id, A.text, merged.text);
        } else if (head && tail) {
          commentsOnEdit(d, A.id, A.text, head.text);
          commentsOnEdit(d, B.id, B.text, tail.text);
          merged = joinBlocks(head, tail);
          commentsOnMerge(d, head.id, tail.id, head.text.length);
        } else {
          if (head) commentsOnEdit(d, A.id, A.text, head.text);
          if (tail) commentsOnEdit(d, B.id, B.text, tail.text);
          merged = head ?? tail ?? { id: uid(), kind: 'para', text: '' };
        }
        at = head ? head.text.length : 0;
        d.body.splice(i, j - i + 1, merged);
        k = i;
      }
      if (keep && line) {
        put(k, spliceText(d.body[k], at, 0, line));
        at += line.length;
      }
      caret = { id: d.body[k].id, at };
      if (split) {
        const tailId = splitIn(d, k, at);
        if (tailId) caret = { id: tailId, at: 0 };
      }
    });
    this.render();
    this.setCaret(caret);
    this.onChange?.();
  }

  #splitBlock(c: Caret): void {
    const i = this.store.doc.body.findIndex(b => b.id === c.id);
    if (i < 0) return;
    this.store.breakRun();
    this.#runId = null;
    let tailId: string | null = null;
    this.store.commit(d => { tailId = splitIn(d, i, c.at); });
    this.render();
    if (tailId) this.setCaret({ id: tailId, at: 0 });
    this.onChange?.();
  }

  /**
   * Join block `i` onto block `i - 1`: Backspace at the start of `i`, or
   * forward Delete at the end of `i - 1`. The earlier block keeps its identity.
   *
   * A table cell or a block with no text (a picture, a formula, a contents
   * list) is not joined: fusing a paragraph into a cell breaks the grid, and
   * fusing it into a picture put its words where nothing renders them. The
   * key does nothing there, as it does at a cell's edge in every word
   * processor.
   */
  #join(i: number): void {
    const body = this.store.doc.body;
    const prev = body[i - 1], cur = body[i];
    if (!prev || !cur) return;
    if (prev.kind === 'cell' || cur.kind === 'cell' || !TEXT_KINDS.has(prev.kind) || !TEXT_KINDS.has(cur.kind)) return;
    const at = prev.text.length;
    const merged = joinBlocks(prev, cur);
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

/** Blocks whose text the caret edits; the rest (picture, formula, contents) are atoms. */
const TEXT_KINDS: ReadonlySet<Block['kind']> = new Set<Block['kind']>(['para', 'h1', 'h2', 'h3', 'quote', 'ul', 'ol', 'cell', 'caption']);

/**
 * `cur` appended to `prev`, which keeps its identity, kind and paragraph
 * settings. Everything anchored by offset into `cur` — marks, footnotes,
 * cross-references, citations, fields — moves with its words. (The join this
 * replaced carried only marks and footnotes, so Backspace before a paragraph
 * with a citation in it dropped the citation.)
 */
function joinBlocks(prev: Block, cur: Block): Block {
  const at = prev.text.length;
  const out: Block = { ...prev, text: prev.text + cur.text };
  const marks = [...(prev.marks ?? []), ...(cur.marks ?? []).map(m => ({ ...m, from: m.from + at, to: m.to + at }))];
  if (marks.length) out.marks = marks; else delete out.marks;
  for (const key of ATOM_KEYS) {
    const list = [...(prev[key] ?? []), ...(cur[key] ?? []).map(x => ({ ...x, at: x.at + at }))];
    if (list.length) (out as Record<string, unknown>)[key] = list; else delete out[key];
  }
  return out;
}

/**
 * Split `d.body[i]` at `at`, in place, inside the caller's commit. Returns
 * the new tail block's id.
 */
function splitIn(d: TypeDoc, i: number, at: number): string | null {
  const src = d.body[i];
  if (!src) return null;
  const head = spliceKeep(src, 0, at);
  const tail: Block = {
    id: uid(),
    // a heading's continuation is a paragraph — nobody wants two headings;
    // a list item's continuation is another item at the same level, which is
    // what makes a list feel like a list rather than a kind you re-pick
    kind: src.kind === 'para' || src.kind === 'quote' || isList(src.kind) ? src.kind : 'para',
    text: src.text.slice(at),
  };
  if (isList(src.kind) && src.level) tail.level = src.level;
  Object.assign(tail, shiftPast(src, at));
  d.body.splice(i, 1, head, tail);
  commentsOnSplit(d, src.id, at, src.text.length, tail.id);
  return tail.id;
}

/** Offset-anchored atoms on a block: each entry has an `at` into `text`. */
const ATOM_KEYS = ['notes', 'refs', 'cites', 'fields'] as const;

/**
 * The text from `from` to `to`, rebased to 0, with marks clipped to it and
 * every atom from `from` to `to` INCLUSIVE kept (an atom sits between two
 * characters, so one at either edge belongs to this piece).
 */
function spliceKeep(b: Block, from: number, to: number): Block {
  const text = b.text.slice(from, to);
  const out: Block = { ...b, text };
  const marks = (b.marks ?? [])
    .map(m => ({ ...m, from: Math.max(0, m.from - from), to: Math.min(to - from, m.to - from) }))
    .filter(m => m.to > m.from);
  if (marks.length) out.marks = marks; else delete out.marks;
  for (const key of ATOM_KEYS) {
    const list = (b[key] ?? []).filter(n => n.at >= from && n.at <= to).map(n => ({ ...n, at: n.at - from }));
    if (list.length) (out as Record<string, unknown>)[key] = list; else delete out[key];
  }
  return out;
}

/**
 * The tail of a split: marks and atoms from `at`, rebased to 0. An atom
 * exactly at the split stays with the head. (This carried only marks and
 * footnotes; cross-references, citations and fields stayed on the head at
 * offsets past its end.)
 */
function shiftPast(b: Block, at: number): Partial<Pick<Block, 'marks' | typeof ATOM_KEYS[number]>> {
  const len = b.text.length - at;
  const out: Record<string, unknown> = {};
  const marks = (b.marks ?? [])
    .map(m => ({ ...m, from: Math.max(0, m.from - at), to: Math.min(len, m.to - at) }))
    .filter(m => m.to > m.from);
  if (marks.length) out.marks = marks;
  for (const key of ATOM_KEYS) {
    const list = (b[key] ?? []).filter(n => n.at > at).map(n => ({ ...n, at: n.at - at }));
    if (list.length) out[key] = list;
  }
  return out;
}

export { TAG, renderBlock };
export type { TypeDoc };
