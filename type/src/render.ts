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
import { isList, MAX_LIST_LEVEL, type Block, type TypeDoc } from './model.ts';

export const TAG: Record<Block['kind'], string> = {
  para: 'p', h1: 'h1', h2: 'h2', h3: 'h3', quote: 'blockquote',
  // A list ITEM is the block, and so is a table CELL. The <ul>/<ol> and the
  // <table> around them are not in the model — see groupBlocks, and Block.level
  // / Block.cell for why the document stays flat.
  ul: 'li', ol: 'li', cell: 'td',
};

/**
 * Group a flat block list into the tree the browser needs to draw it.
 *
 * Runs of adjacent list blocks become real <ul>/<ol> elements, nested by
 * `level`. Everything else is emitted as itself. This is the ONLY place that
 * knows lists have a container, which is what lets the model stay flat and
 * pagination stay indifferent — it measures line boxes through a tree walker
 * and never looks at block structure at all.
 *
 * Emitted as a token stream rather than DOM so the editor and print can share
 * it: print builds a string, the editor builds elements.
 */
export type GroupToken =
  | { t: 'open'; kind: 'ul' | 'ol' }
  | { t: 'close'; kind: 'ul' | 'ol' }
  | { t: 'table'; rows: Block[][]; head: boolean }
  | { t: 'block'; block: Block };

export function groupBlocks(body: readonly Block[]): GroupToken[] {
  const out: GroupToken[] = [];
  // the open list stack, one entry per depth
  const stack: Array<'ul' | 'ol'> = [];
  // The close token carries its KIND. A consumer that has to work out what it
  // is closing gets it wrong the moment lists nest — print did exactly that,
  // scanning its own output backwards for the last open tag and finding one it
  // had already closed.
  const closeTo = (depth: number) => {
    while (stack.length > depth) out.push({ t: 'close', kind: stack.pop()! });
  };
  for (let i = 0; i < body.length; i++) {
    const b = body[i];
    // ---- tables: a run of cells sharing one table id, chunked into rows
    if (b.kind === 'cell' && b.cell) {
      closeTo(0);
      const id = b.cell.table;
      const cells: Block[] = [];
      while (i < body.length && body[i].kind === 'cell' && body[i].cell?.table === id) {
        cells.push(body[i]); i++;
      }
      i--;                                    // the for-loop will step past the run
      // `cols` is repeated on every cell, so a disagreement is resolved by
      // MAJORITY rather than by trusting whichever cell happened to be first —
      // one edited cell should not reshape the whole table.
      const tally = new Map<number, number>();
      for (const c of cells) tally.set(c.cell!.cols, (tally.get(c.cell!.cols) ?? 0) + 1);
      const cols = Math.max(1, [...tally.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0]);
      const rows: Block[][] = [];
      for (let k = 0; k < cells.length; k += cols) rows.push(cells.slice(k, k + cols));
      out.push({ t: 'table', rows, head: !!cells[0]?.cell?.head });
      continue;
    }
    if (!isList(b.kind)) { closeTo(0); out.push({ t: 'block', block: b }); continue; }
    const kind = b.kind as 'ul' | 'ol';
    // CLAMPED HERE TOO, not only in the parser. parseDoc clamps what arrives
    // from a file, but this function also runs on the LIVE model, which the
    // editor and any script can write to directly. Unclamped, `level: 1e9`
    // opened a billion list elements: the rig died with a V8 out-of-memory,
    // and in a browser that is a hung tab from one bad number.
    const lv = Number.isFinite(b.level) ? Math.max(0, Math.min(MAX_LIST_LEVEL, Math.floor(b.level!))) : 0;
    const want = lv + 1;                              // depth in open elements
    // A change of KIND at the same depth ends one list and starts another:
    // bullets and numbers are different lists even when equally indented.
    if (stack.length === want && stack[want - 1] !== kind) closeTo(want - 1);
    closeTo(want);
    while (stack.length < want) { stack.push(kind); out.push({ t: 'open', kind }); }
    out.push({ t: 'block', block: b });
  }
  closeTo(0);
  return out;
}

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
/**
 * A table, from its rows of cell blocks.
 *
 * Each <td> keeps its block's `data-id`, so everything that addresses a block —
 * the caret, the redline, a comment — reaches a cell without knowing tables
 * exist. A short last row is PADDED with empty cells rather than left ragged:
 * the model may disagree with itself, but the rendered grid never should.
 */
export function renderTable(rows: Block[][], head: boolean): HTMLElement {
  const table = document.createElement('table');
  table.className = 't-table';
  const cols = rows[0]?.length ?? 1;
  const thead = head ? document.createElement('thead') : null;
  const tbody = document.createElement('tbody');
  rows.forEach((row, r) => {
    const isHead = head && r === 0;
    const tr = document.createElement('tr');
    for (let c = 0; c < cols; c++) {
      const b = row[c];
      const cell = document.createElement(isHead ? 'th' : 'td');
      if (b) {
        cell.dataset.id = b.id;
        cell.dataset.kind = b.kind;
        cell.innerHTML = blockHtml(b);
      } else {
        cell.innerHTML = '<br>';               // padding for a short final row
        cell.dataset.pad = '1';
      }
      tr.appendChild(cell);
    }
    (isHead ? thead! : tbody).appendChild(tr);
  });
  if (thead) table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}

export function renderBody(doc: TypeDoc, host: HTMLElement): void {
  const frag = document.createDocumentFragment();
  let cursor: Node = frag;
  for (const tok of groupBlocks(doc.body)) {
    if (tok.t === 'open') {
      const list = document.createElement(tok.kind);
      cursor.appendChild(list);
      cursor = list;
    } else if (tok.t === 'close') {
      cursor = cursor.parentNode ?? frag;
    } else if (tok.t === 'table') {
      cursor.appendChild(renderTable(tok.rows, tok.head));
    } else {
      cursor.appendChild(renderBlock(tok.block));
    }
  }
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
