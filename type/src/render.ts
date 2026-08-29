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
import { captionPrefixHtml, isXrefAtom, refAtoms, readXrefs, numberXrefs } from './xref.ts';
import { blockStyle } from './layout.ts';
import { activeStyleId, ensureStyleSheet } from './docstyles.ts';
import { citeInject, isCiteAtom, mergeInject, paintCitations, readCiteAtoms } from './cite.ts';
import { displayMathHtml, inlineMathHtml, isMathMark } from './math.ts';
import { renderEmbed } from './embed.ts';

export const TAG: Record<Block['kind'], string> = {
  para: 'p', h1: 'h1', h2: 'h2', h3: 'h3', quote: 'blockquote',
  // A list ITEM is the block, and so is a table CELL. The <ul>/<ol> and the
  // <table> around them are not in the model — see groupBlocks, and Block.level
  // / Block.cell for why the document stays flat.
  ul: 'li', ol: 'li', cell: 'td',
  // atomic: rendered by renderImage/renderEmbed, never by the generic path
  image: 'figure', caption: 'figcaption', toc: 'nav', math: 'div', embed: 'figure',
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
  (el.tagName === 'SUP' && el.classList.contains('t-note')) ||
  // DERIVED content — a section number, a contents list — is an atom for the
  // same reason a footnote marker is: it occupies a position, owns no
  // characters, and readBlock must never absorb it into the text. Broadened
  // here rather than at every call site so nothing downstream has to learn a
  // second predicate.
  el.hasAttribute('data-derived');

/**
 * Decorators — a feature's chance to add derived content to a block.
 *
 * ONE hook, consulted by blockHtml, so the editor and print cannot drift: both
 * build their HTML through this function. A decorator returns a prefix, a
 * suffix, or atoms; it must never change the block's text, which is what keeps
 * the redline quiet and the signature stable.
 */
export type BlockDecorator = (b: Block, base: string) => string | null;
const DECORATORS: BlockDecorator[] = [];
export const registerBlockDecorator = (d: BlockDecorator): void => { DECORATORS.push(d); };
/** Each decorator sees the previous one's output, so several can compose. */
const decorate = (b: Block, base: string): string => {
  let out = base;
  for (const d of DECORATORS) out = d(b, out) ?? out;
  return out;
};

const noteMarker = (id: string) =>
  `<sup class="t-note" data-note="${id}" contenteditable="false">•</sup>`;

/** One block, as HTML. Marks become tags; note refs become atoms. */
export function blockHtml(b: Block): string {
  // Notes and cross-references are both ATOMS at offsets into the same text, so
  // they share one inject map — a reference is the footnote marker's idea
  // applied to a different target.
  // A note, a cross-reference and a citation can all sit at the SAME offset, so
  // these are merged rather than assigned — a plain map write silently drops
  // one, and the one it drops depends on iteration order.
  // INLINE MATH is a mark whose source characters are replaced wholesale by the
  // typeset result. It is a mark and not an atom deliberately: the source lives
  // in the text, so `x^2` → `x^3` reports to the redline as a one-word change
  // to that formula. As an atom the diff would see no change at all, which for
  // a redlining app is disqualifying.
  const mathRanges = (b.marks ?? []).filter(isMathMark)
    .map(m => ({ from: m.from, to: m.to, html: inlineMathHtml(b.text.slice(m.from, m.to)) }));
  const atoms = mergeInject(
    new Map((b.notes ?? []).map(n => [n.at, noteMarker(n.id)])),
    refAtoms(b),
    citeInject(b),
  );
  const html = toHtml(b.text, b.marks ?? [], atoms.size ? atoms : undefined,
                      mathRanges.length ? mathRanges : undefined);
  // an empty block still needs a line box, or it collapses and cannot be clicked
  return captionPrefixHtml(b) + decorate(b, html || '<br>');
}

/**
 * A picture.
 *
 * `data-atomic` is what tells pagination this block has a height but no text
 * nodes — without it the TreeWalker in paginate.ts never sees the image and
 * every page after it overflows by exactly its height. Any future block that
 * renders as a box rather than as text (a display formula, a chart) must carry
 * the same attribute.
 *
 * The alt text is also the caption fallback and the redline's handle on the
 * block, which is why it lives in the model rather than only in the markup.
 */
export function renderImage(b: Block): HTMLElement {
  const fig = document.createElement('figure');
  fig.className = 't-figure';
  fig.dataset.id = b.id;
  fig.dataset.kind = b.kind;
  fig.dataset.atomic = '1';
  const im = b.image;
  if (!im) return fig;
  if (im.align) fig.dataset.align = im.align;
  const img = document.createElement('img');
  img.src = im.src;
  img.alt = im.alt ?? '';
  if (im.w) img.style.width = `${Math.round(im.w * 100)}%`;
  // PAGINATION MUST RE-RUN WHEN THE PICTURE ARRIVES. An image decodes
  // asynchronously, so the pass that runs immediately after render measures it
  // as one line of alt text. Measured: a 500px picture paginated as 2 pages
  // before it decoded and 3 after, with the first break moving 836 → 560. And
  // because print reproduces the editor's pagination exactly, that is a
  // document that prints with the wrong breaks — silently, and only when it
  // contains a picture.
  //
  // The renderer stays pure with respect to the document: it announces that the
  // layout changed and does not know who is listening.
  const relayout = () => fig.dispatchEvent(new CustomEvent('t-relayout', { bubbles: true }));
  img.addEventListener('load', relayout, { once: true });
  // An image that fails to load must not leave an invisible gap that
  // pagination has already reserved space for.
  img.addEventListener('error', () => { fig.dataset.broken = '1'; relayout(); }, { once: true });
  fig.appendChild(img);
  return fig;
}

/**
 * The document `renderBlock` styles a single block against, when the caller
 * does not pass one explicitly.
 *
 * `renderBody` sets it on every pass, which is the common path; the one
 * caller that renders a lone block WITHOUT the document in hand
 * (editor.ts's live re-render of the block just typed in) still resolves
 * named styles correctly because renderBody always ran at least once first —
 * module state rather than a signature change on a function this module does
 * not own the only caller of, mirroring layout.ts's own `painting` flag.
 */
let lastDoc: TypeDoc | undefined;

export function renderBlock(b: Block, doc: TypeDoc | undefined = lastDoc): HTMLElement {
  if (b.kind === 'image') return renderImage(b);
  if (b.kind === 'embed') return renderEmbed(b);
  if (b.kind === 'math') {
    // A display formula is atomic: it has height and, once typeset, may hold no
    // text node pagination can measure — so it carries data-atomic like a
    // picture, and gets the same one-box treatment.
    const el = document.createElement('div');
    el.className = 't-mathblock';
    el.dataset.id = b.id;
    el.dataset.kind = b.kind;
    el.dataset.atomic = '1';
    el.dataset.tex = b.text;
    el.innerHTML = displayMathHtml(b.text);
    return el;
  }
  const el = document.createElement(TAG[b.kind]);
  el.dataset.id = b.id;
  el.dataset.kind = b.kind;
  // A named style's typography arrives through a STYLESHEET keyed by this
  // attribute (docstyles.ts ensureStyleSheet/styleSheetCss), never through
  // this element's `style` attribute — that one belongs to layout.ts's
  // `blockStyle` alone below, and layout.ts repaints it independently (its
  // own MutationObserver) whenever the paper's children change, which a
  // render always causes. Two mechanisms writing the SAME attribute would
  // have the second one silently erase the first the next time that
  // observer fired; the split is what keeps them from ever colliding.
  const sid = doc ? activeStyleId(doc, b) : undefined;
  if (sid) el.dataset.styleId = sid;
  // The paragraph's OWN properties only — the document's defaults live on the
  // paper, not on ten thousand copies of themselves. This is an INLINE style,
  // so it beats the stylesheet rule above for any property both set: a
  // block's own align/sb/sa/lh/ind wins over its named style, for free, by
  // CSS specificity — no coordination between the two mechanisms required.
  const st = blockStyle(b);
  if (st) el.setAttribute('style', st);
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
  lastDoc = doc;
  ensureStyleSheet(doc);
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
      cursor.appendChild(renderBlock(tok.block, doc));
    }
  }
  host.replaceChildren(frag);
  numberNotes(host, doc);
  numberXrefs(host, doc);
  paintCitations(host, doc);
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
  const { text, marks, atoms } = fromDom(el, el2 => isNoteAtom(el2) || isXrefAtom(el2) || isCiteAtom(el2));
  const out: Block = { ...prev, id: el.dataset.id || prev.id, text };
  const kind = el.dataset.kind as Block['kind'] | undefined;
  if (kind && kind in TAG) out.kind = kind;
  if (marks.length) out.marks = marks as Mark[]; else delete out.marks;
  const notes = atoms
    .map(a => ({ id: (a.el as HTMLElement).dataset.note!, at: a.at }))
    .filter(n => n.id);
  if (notes.length) out.notes = notes; else delete out.notes;
  const refs = readXrefs(atoms);
  if (refs.length) out.refs = refs; else delete out.refs;
  const cites = readCiteAtoms(atoms);
  if (cites.length) out.cites = cites; else delete out.cites;
  return out;
}
