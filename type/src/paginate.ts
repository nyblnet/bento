// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Where the pages break, and what goes at the foot of each.
//
// The document flows continuously; pages are COMPUTED over it and drawn as
// decorations. That is not a shortcut — it was the outcome of the spike
// (working/type-spike/RESULTS.md). Fragmenting the DOM into real page boxes
// works, and reproduces the same pagination, but it is not transparent to
// editing: arrow keys stall at the seam (six presses advance four characters)
// and backspace deletes two characters instead of one, because the browser sees
// two paragraphs where the author wrote one. Continuous flow has none of that
// and costs 4ms for 134 pages.
//
// Four rules the spike forced, each after getting it wrong first:
//
//  1. RANGE GEOMETRY, NEVER HIT-TESTING. `caretPositionFromPoint` takes viewport
//     coordinates and only answers for on-screen content, so it cannot find a
//     break on page 60 without scrolling there. `getClientRects()` reports
//     correctly for content far out of view.
//  2. MEASURE SCOPED, NOT GLOBALLY. The naive version re-scanned every line box
//     with a per-character walk on each of ~120 iterations — O(pages · chars) —
//     and hung the tab. Binary-search the blocks for the target y, then measure
//     only inside that block.
//  3. DECORATIONS GO OUTSIDE THE EDITABLE. Markers inserted into the flow put
//     page 2's rule at y=390 on an 864px page body, and would enter the undo
//     stack. An overlay fixes placement and cannot be typed into.
//  4. FOOTNOTES NEED A TERMINATION RULE. Reserving room for notes shortens the
//     page, which can push a reference off it, which frees the room — a real
//     2-cycle, measured on 5 of 40 pages at high note density. When a state
//     repeats, DEFER the last note to the next page: same page count as the
//     alternatives, less wasted note area, and what a typesetter does.

import type { PageSpec, TypeDoc } from './model.ts';
import { atomize, breakY } from './layout.ts';

export interface Page {
  n: number;
  /** paper-space y this page starts at (0 = the first line's top) */
  start: number;
  /** paper-space y it ends at; Infinity for the last page */
  end: number;
  /** footnote ids landing on this page, in order */
  notes: string[];
  /** px reserved at the foot for those notes */
  reserved: number;
}

export interface Metrics {
  pages: Page[];
  /** ms the last pass took, for the status line and for catching regressions */
  ms: number;
}

/** A line box, in paper space. */
interface LineBox { top: number; bottom: number; id?: string }

const bodyHeight = (p: PageSpec) => p.height - p.marginTop - p.marginBottom;

/**
 * Every line box in the flow, in order.
 *
 * One Range per text node and one rect per line — no per-character walk. The
 * origin is the CONTENT box, so y=0 is the first line's top rather than the top
 * of the page margin; getting that wrong silently under-fills page one.
 */
function lineBoxes(host: HTMLElement, page: PageSpec): LineBox[] {
  const out: LineBox[] = [];
  const top0 = host.getBoundingClientRect().top + page.marginTop;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.nodeValue?.trim().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const r = document.createRange();
  // Which BLOCK a line belongs to, so page-breaking hints (keep-together,
  // keep-with-next) can group lines into units that must not be split.
  const owner = (n: Node): string | undefined => {
    let p: HTMLElement | null = n.parentElement;
    while (p && p !== host && !p.dataset.id) p = p.parentElement;
    return p?.dataset.id;
  };
  let n: Node | null;
  while ((n = walker.nextNode())) {
    r.selectNodeContents(n);
    const id = owner(n);
    for (const rect of Array.from(r.getClientRects())) {
      if (rect.height) out.push({ top: rect.top - top0, bottom: rect.bottom - top0, id });
    }
  }
  // ATOMIC BLOCKS — an image, and later a display formula — contain no text
  // nodes, so the walker above never sees them. Left out, they contributed
  // height to the flow that pagination did not know about, and every page after
  // the first image overflowed by exactly the image's height.
  //
  // One box for the whole element is not an approximation, it is the truth: an
  // image cannot be broken across a page, so "does it fit in what is left" is
  // the only question, and a box that does not fit pushes the break to its top
  // — which moves the whole image to the next page. That falls out of the
  // existing algorithm with no special case.
  for (const el of Array.from(host.querySelectorAll<HTMLElement>('[data-atomic]'))) {
    const rect = el.getBoundingClientRect();
    if (rect.height) out.push({ top: rect.top - top0, bottom: rect.bottom - top0, id: el.dataset.id });
  }
  return out.sort((a, b) => a.top - b.top);
}

/** Footnote ids whose marker falls in [start, end), in document order. */
function notesIn(host: HTMLElement, page: PageSpec, start: number, end: number): string[] {
  const top0 = host.getBoundingClientRect().top + page.marginTop;
  const out: string[] = [];
  for (const sup of Array.from(host.querySelectorAll<HTMLElement>('sup.t-note'))) {
    const y = sup.getBoundingClientRect().top - top0;
    if (y >= start - 0.5 && y < end - 0.5) out.push(sup.dataset.note!);
  }
  return out;
}

/**
 * How tall the note area would be for these notes — MEASURED, not estimated.
 * A wrong estimate here moves every page break after it.
 */
let notesProbe: HTMLElement | null = null;
function measureNotes(doc: TypeDoc, page: PageSpec, ids: string[]): number {
  if (!ids.length) return 0;
  if (!notesProbe) {
    notesProbe = document.createElement('div');
    // marked transient so a save can never capture it (kernel/src/save.ts
    // strips marked nodes from the pristine clone)
    notesProbe.setAttribute('data-bento-transient', '');
    notesProbe.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;contain:strict';
    document.body.appendChild(notesProbe);
  }
  const probe = notesProbe;
  probe.style.width = `${page.width - page.marginX * 2}px`;
  probe.innerHTML = `<div class="t-fnarea">` +
    ids.map((id, i) => `<p><b>${i + 1}</b>${escapeHtml(doc.footnotes[id] ?? '')}</p>`).join('') +
    `</div>`;
  return (probe.firstElementChild as HTMLElement).getBoundingClientRect().height + 10;
}
const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

/**
 * Compute the pages.
 *
 * The reserve↔break relation is circular, so each page iterates to a fixpoint.
 * When a state repeats — a genuine 2-cycle, not a hypothetical — the last note
 * is deferred to the next page and the loop ends.
 */
export function paginate(doc: TypeDoc, host: HTMLElement): Metrics {
  const t0 = performance.now();
  const page = doc.page;
  const H = bodyHeight(page);
  const boxes = lineBoxes(host, page);
  const units = atomize(doc.body, boxes);
  const pages: Page[] = [];

  let start = 0;
  /** notes pushed off the previous page — they MUST be placed on this one */
  let deferred: string[] = [];
  let guard = 0;

  while (guard++ < 2000) {
    const carried = deferred;
    deferred = [];
    let reserved = 0;
    let end = Infinity;
    let notes: string[] = carried;
    const seen = new Set<string>();

    for (let iter = 0; iter < 16; iter++) {
      const avail = H - reserved;
      // With no keeps and no explicit breaks in the document, atomize returns
      // one atom per line and breakY reproduces the line-by-line loop this
      // replaced, exactly — asserted in scripts/test-type-layout.ts for every
      // start and height tried, which is what made the swap safe.
      const e = breakY(units, start, avail);
      const ids = carried.concat(notesIn(host, page, start, e));
      const need = measureNotes(doc, page, ids);
      if (Math.abs(need - reserved) < 0.5) { end = e; notes = ids; reserved = need; break; }

      // A state we have already been in is the 2-cycle: reserving room for
      // these notes shortens the page enough to push one of them off it, which
      // frees the room, which pulls it back. Break it by DEFERRING the last
      // note — never a carried one, or it would ping-pong forever.
      const key = `${ids.length}:${Math.round(need)}`;
      if (seen.has(key)) {
        if (ids.length > carried.length) {
          notes = ids.slice(0, -1);
          deferred = ids.slice(-1);
        } else {
          notes = ids;                       // nothing left to defer; take it
        }
        reserved = measureNotes(doc, page, notes);
        end = e;
        break;
      }
      seen.add(key);
      reserved = need; end = e; notes = ids;
    }

    // NO PROGRESS. One box is taller than the page can ever be — an image
    // larger than the paper, which a file can perfectly well contain. The break
    // would be placed at the box's own top, the next page would start where
    // this one did, and the loop would spin until the guard, producing hundreds
    // of empty pages. Give the oversized box its own page and move past it: it
    // will overflow the margin, which is visible and fixable, rather than
    // hanging the document, which is neither.
    if (isFinite(end) && end <= start + 0.5) {
      const next = boxes.find(b => b.top > start + 0.5);
      end = next ? next.top : Infinity;
    }

    pages.push({ n: pages.length + 1, start, end, notes, reserved });
    if (!isFinite(end)) break;
    start = end;
  }

  return { pages, ms: performance.now() - t0 };
}

/**
 * Draw the page furniture and the notes into the overlay.
 *
 * Notes go in the RIGHT-HAND GUTTER, beside their reference — not at the foot
 * of the page. In a continuous flow nothing physically reserves the space a
 * page-foot note would need, so the note lands on top of the body text (the
 * spike did exactly this before it was caught). Only a paginated OUTPUT can put
 * a note at a page foot, because only there is the space real. The BREAKS still
 * reserve room for them, so the page numbers are the ones the printed document
 * will have.
 */
export function drawPages(doc: TypeDoc, host: HTMLElement, deco: HTMLElement, metrics: Metrics): void {
  const page = doc.page;
  deco.replaceChildren();
  const frag = document.createDocumentFragment();

  for (const pg of metrics.pages) {
    if (pg.n === 1) continue;
    const y = pg.start + page.marginTop;
    const rule = el('div', 'rule'); rule.style.top = `${y}px`;
    const tl = el('div', 'tick'); tl.style.top = `${y}px`; tl.style.left = `${page.marginX - 24}px`;
    const tr = el('div', 'tick'); tr.style.top = `${y}px`;
    tr.style.left = `${page.width - page.marginX + 14}px`;
    const num = el('div', 'num'); num.style.top = `${y + 7}px`;
    num.style.left = `${page.width - page.marginX + 34}px`;
    num.textContent = String(pg.n);
    frag.append(rule, tl, tr, num);
  }

  // sidenotes, stacked so two never overlap
  const paperTop = host.getBoundingClientRect().top;
  let lastBottom = -1e9;
  const numbers = new Map<string, number>();
  Array.from(host.querySelectorAll<HTMLElement>('sup.t-note'))
    .forEach((sup, i) => numbers.set(sup.dataset.note!, i + 1));

  for (const sup of Array.from(host.querySelectorAll<HTMLElement>('sup.t-note'))) {
    const id = sup.dataset.note!;
    const text = doc.footnotes[id];
    if (!text) continue;
    const note = el('div', 'sidenote');
    note.dataset.note = id;
    note.innerHTML = `<b>${numbers.get(id)}</b>${escapeHtml(text)}`;
    frag.appendChild(note);
    const y = sup.getBoundingClientRect().top - paperTop;
    note.style.top = `${Math.max(y - 2, lastBottom + 8)}px`;
    // measured after insertion, so the stack accounts for real wrapped height
    deco.appendChild(note);
    lastBottom = parseFloat(note.style.top) + note.getBoundingClientRect().height;
  }
  deco.prepend(frag);
}

function el(tag: string, cls: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = cls;
  return n;
}
