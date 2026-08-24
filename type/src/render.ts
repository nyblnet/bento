// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// model → DOM. One renderer, shared by the editor, the paginated view and
// (eventually) print, so what an author edits is what the reader gets.
//
// The renderer is PURE with respect to the document: it reads and never writes.
// Everything it emits is reconstructible from the model, which is what lets the
// editor re-render a block at any moment without asking whether it is safe.

import { toHtml, fromDom, type Mark } from './inline.ts';
import type { Block, TypeDoc } from './model.ts';

export const TAG: Record<Block['kind'], string> = {
  para: 'p', h1: 'h1', h2: 'h2', h3: 'h3', quote: 'blockquote',
};

/** Footnote markers are ATOMS: they occupy a position but no characters. */
export const isNoteAtom = (el: Element) =>
  el.tagName === 'SUP' && el.classList.contains('t-note');

const noteMarker = (id: string) =>
  `<sup class="t-note" data-note="${id}" contenteditable="false">•</sup>`;

/** One block, as HTML. Marks become tags; note refs become atoms. */
export function blockHtml(b: Block): string {
  const inject = b.notes?.length
    ? new Map(b.notes.map(n => [n.at, noteMarker(n.id)]))
    : undefined;
  const html = toHtml(b.text, b.marks ?? [], inject);
  // an empty block still needs a line box, or it collapses and cannot be clicked
  return html || '<br>';
}

export function renderBlock(b: Block): HTMLElement {
  const el = document.createElement(TAG[b.kind]);
  el.dataset.id = b.id;
  el.dataset.kind = b.kind;
  el.innerHTML = blockHtml(b);
  return el;
}

/** The whole body. Callers own the host; this replaces its contents. */
export function renderBody(doc: TypeDoc, host: HTMLElement): void {
  const frag = document.createDocumentFragment();
  for (const b of doc.body) frag.appendChild(renderBlock(b));
  host.replaceChildren(frag);
  numberNotes(host, doc);
}

/**
 * Number the footnote markers in document order and put the number in the
 * marker. Numbering is DERIVED, never stored: inserting a note renumbers
 * everything after it, and a stored number would be wrong the moment it did.
 */
export function numberNotes(host: HTMLElement, _doc: TypeDoc): string[] {
  const order: string[] = [];
  for (const sup of host.querySelectorAll<HTMLElement>('sup.t-note')) {
    order.push(sup.dataset.note!);
    sup.textContent = String(order.length);
  }
  return order;
}

/**
 * Read one rendered block back into the model.
 *
 * The DOM is the only place the browser records what the author just typed, so
 * this is the seam where user intent enters the model — and the reason marks
 * are ranges over plain text rather than markup is that this function can then
 * be total: whatever the browser produced, the result is text plus marks, with
 * nothing that has no place to go.
 */
export function readBlock(el: HTMLElement, prev: Block): Block {
  const { text, marks, atoms } = fromDom(el, isNoteAtom);
  const out: Block = { ...prev, id: el.dataset.id || prev.id, text };
  const kind = el.dataset.kind as Block['kind'] | undefined;
  if (kind && kind in TAG) out.kind = kind;
  if (marks.length) out.marks = marks as Mark[]; else delete out.marks;
  const notes = atoms
    .map(a => ({ id: (a.el as HTMLElement).dataset.note!, at: a.at }))
    .filter(n => n.id);
  if (notes.length) out.notes = notes; else delete out.notes;
  return out;
}
