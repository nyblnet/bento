// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Microtypography — optical margin alignment.
//
// WHAT IT IS. A margin is straight when the INK lines up, not when the advance
// boxes do. A line ending in a full stop has its last box flush with the
// margin, but the period's ink stops well short of the box's right edge, so the
// eye reads a notch. The same happens at the left margin under an opening
// quote, whose ink sits high and right inside a box that is flush. Every book
// you have read fixes this by letting the punctuation hang into the margin.
// This module does that, and it is the difference between text that reads as a
// page and text that reads as a web page.
//
// ─────────────────────────────────────── the constraint that shapes everything
//
// IT MUST NOT CHANGE WHERE LINES BREAK. Not "should rarely" — must not. Line
// breaking is the browser's, pagination is MEASURED off the line boxes it
// produces (paginate.ts), and every saved file carries a page count that is a
// promise already made to whoever printed it. A microtypographic change that
// reflowed a paragraph would move a page break, and the promise with it.
//
// That rules out the way TeX does this. TeX's protrusion feeds the character's
// overhang back into the badness computation, so lines legitimately break
// differently — that is the whole point there, and it is disqualifying here.
//
// So the offset is applied in RENDERING SPACE and nowhere else: the protruding
// character is wrapped in a `<span class="t-hang">` that is `position:
// relative` with a `left` offset. CSS 2.1 §9.4.3 is explicit that a relatively
// positioned box is painted offset and that the offset "does not affect the
// layout of any other box" — the guarantee is in the spec, not in a hope.
//
// The one residual hazard is the WRAPPER, not the offset: browsers break text
// shaping runs at element boundaries, so wrapping the final character of a line
// can lose a kern pair worth a fraction of a pixel, and a fraction of a pixel
// is in principle enough to flip a break. That is why this module VERIFIES
// rather than assumes — see `applyOptical`. If a block's line boundaries moved,
// that block is unwrapped and left exactly as it was. A paragraph that cannot
// be improved safely is not improved.
//
// ────────────────────────────────────────────────── how far a character hangs
//
// Exactly to ink flush, and no further. The objective is stated as a number —
// minimise the deviation of each line's INK edge from the margin — and once it
// is stated, the optimum is not a matter of taste: shift the character out by
// its side bearing, so its ink lands on the margin. Hanging further (the
// classic "half the quote in the margin" look) makes the stated measurement
// WORSE, and there is no honest way to both claim the measurement and overshoot
// it. The bearings are measured from the real font at the real size through a
// canvas, not taken from a table of guesses, so a document that changes its
// typeface gets that typeface's answer.
//
// ────────────────────────────────────────────────────────── what it does NOT do
//
//   · AUTOMATIC HYPHENS DO NOT HANG. `hyphens: auto` draws a hyphen that has no
//     character behind it — there is no text node to wrap, and nothing to
//     attach an offset to. An explicit hyphen the author typed does hang.
//     Fixing the automatic one means putting soft hyphens into the text, which
//     is exactly what the spike rejected (every rendered address would drift
//     from every model address; see editor.ts's header).
//   · RIGHT-TO-LEFT text is skipped. The bearings arithmetic below assumes the
//     line's start is its left edge.
//   · TABLE CELLS and formulas are skipped: a cell's edge is a padding box, not
//     a margin, and a formula never justifies (styles.css says so).
//
// ────────────────────────────────────────────────────────────────── the switch
//
// `doc.optical === false` turns it off, and that is a DOCUMENT property rather
// than a viewer preference for the same reason the typeface is one: it is how
// the author's page is set. Absent means ON, including in every file written
// before this existed — which is a deliberate exception to "old files render
// exactly as they did", taken because the thing old files actually promise is
// their PAGINATION, and that is bit-identical here by construction and by the
// verification pass. The rendering is strictly better by the measurement above.

/** Which end of a line a character sits at. */
export type Edge = 'start' | 'end';

/**
 * Punctuation allowed to hang at the RIGHT margin.
 *
 * Closing marks and the low, light characters — the ones whose advance box is
 * mostly empty on the right. A letter's right side bearing is a fifth of a
 * period's and hanging it is margin kerning, a different (and later) feature.
 */
export const PROTRUDE_END: ReadonlySet<string> = new Set([
  '.', ',', ';', ':', '!', '?', '·', '…',
  '-', '‐', '‑', '–', '—',          // hyphen, non-breaking, en, em
  '"', "'", '’', '”', '»', '›',     // quotes, closing
  ')', ']', '}', '*',
]);

/**
 * Punctuation allowed to hang at the LEFT margin.
 *
 * Opening marks. The classic case is a paragraph that starts with a quotation:
 * without this its first line reads as indented, and with it the block's left
 * edge is one straight line.
 */
export const PROTRUDE_START: ReadonlySet<string> = new Set([
  '"', "'", '‘', '“', '«', '‹',
  '(', '[', '{', '–', '—', '•', '·',
]);

export const protrudes = (ch: string, edge: Edge): boolean =>
  (edge === 'end' ? PROTRUDE_END : PROTRUDE_START).has(ch);

/** A glyph's advance and the horizontal extent of its ink within that advance. */
export interface Bearings {
  /** the advance width the layout engine gave it */
  advance: number;
  /** ink's left edge, measured from the advance box's left edge */
  inkLeft: number;
  /** ink's right edge, same origin */
  inkRight: number;
}

/**
 * How far to move the character, in px, positive to the RIGHT.
 *
 * End of line: out by the right side bearing, so the ink lands on the margin.
 * Start of line: back by the left side bearing, for the same reason.
 *
 * Two clamps, and both have earned their place in other people's font code:
 * a bearing may come back negative (ink that already overhangs its box, common
 * in italic and script faces) and a bearing may come back absurd (a fallback
 * face substituted for a missing glyph). Anything under a third of a pixel is
 * dropped as beneath the point — it would cost a wrapper and buy nothing.
 */
export const MIN_SHIFT = 0.33;
export const MAX_SHIFT_RATIO = 0.6;

export function opticalShift(ch: string, edge: Edge, b: Bearings): number {
  if (!protrudes(ch, edge)) return 0;
  if (!(b.advance > 0) || !isFinite(b.inkLeft) || !isFinite(b.inkRight)) return 0;
  const cap = b.advance * MAX_SHIFT_RATIO;
  const raw = edge === 'end' ? b.advance - b.inkRight : -b.inkLeft;
  const mag = Math.min(Math.abs(raw), cap);
  if (mag < MIN_SHIFT) return 0;
  return raw < 0 ? -mag : mag;
}

/**
 * Did every line still end where it ended, and start where it started?
 *
 * BOTH HALVES, and the second one was learned the hard way. The first version
 * of this check only asked whether the character that OPENED each line was
 * still on that line — and it passed a real reflow, on a real document, in the
 * measurement run that was supposed to prove the feature safe. Wrapping the
 * comma of "…including time-sheets," cost the kern between "s" and "," , the
 * word no longer fitted, and the break moved back to the hyphen in "time-".
 * "receipts" — the character that opened line 1 — was STILL on line 1
 * afterwards, because the word had moved down onto it. The line count was
 * unchanged and every line top was unchanged too, so nothing else noticed
 * either.
 *
 * So a break is held only when the line's LAST character and its FIRST
 * character are both still on it. That is the definition of the break not
 * having moved, and anything weaker is a check that passes the bug.
 *
 * Kept pure so the rig can exercise it without a layout engine.
 */
export const LINE_EPS = 0.5;

export function boundariesHeld(
  tops: readonly number[], after: readonly number[],
  endLines: readonly number[], startLines: readonly number[],
): boolean {
  // NaN is "I could not read that rect", and it must FAIL. Written as positive
  // tests rather than `!==`/`>` because every comparison against NaN is false,
  // which is exactly how an unreadable line would silently pass.
  if (tops.length !== after.length) return false;
  for (let i = 0; i < tops.length; i++) if (!(Math.abs(tops[i] - after[i]) <= LINE_EPS)) return false;
  if (endLines.length !== tops.length || startLines.length !== tops.length) return false;
  for (let k = 0; k < tops.length; k++) {
    if (!(endLines[k] === k) || !(startLines[k] === k)) return false;
  }
  return true;
}

// ───────────────────────────────────────────────────────────── font bearings

const bearingCache = new Map<string, Bearings>();
let measureCtx: CanvasRenderingContext2D | null | undefined;

/** The CSS `font` shorthand for an element, rebuilt when the browser withholds it. */
export function fontOf(el: Element): string {
  const cs = styleOf(el);
  if (cs.font) return cs.font;
  return `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`;
}

/**
 * Ink bounds for one character in one font, from a canvas.
 *
 * `actualBoundingBoxLeft` is positive to the LEFT of the alignment point, which
 * for the default `textAlign` is the advance box's left edge — so the ink's
 * left coordinate is its negation, and getting that sign wrong moves every
 * opening quote the wrong way.
 */
export function bearings(ch: string, font: string): Bearings | null {
  const key = `${font} ${ch}`;
  const hit = bearingCache.get(key);
  if (hit) return hit;
  if (measureCtx === undefined) {
    measureCtx = document.createElement('canvas').getContext('2d');
  }
  if (!measureCtx) return null;
  measureCtx.font = font;
  // A browser that refused the font string would measure in its own default and
  // report bearings for the wrong face. Silence is the failure mode this
  // module cannot have, so refuse instead.
  if (!measureCtx.font) return null;
  const m = measureCtx.measureText(ch);
  const out: Bearings = {
    advance: m.width,
    inkLeft: -(m.actualBoundingBoxLeft ?? 0),
    inkRight: m.actualBoundingBoxRight ?? m.width,
  };
  bearingCache.set(key, out);
  return out;
}

// ──────────────────────────────────────────────────────────────── the DOM pass

export interface MicroStats {
  /** blocks examined this pass (a cached block is not examined) */
  blocks: number;
  /** characters given a hanging offset */
  hung: number;
  /** blocks unwrapped again because their line boundaries had moved */
  reverted: number;
  /** ms the pass took */
  ms: number;
}

const HANG_CLASS = 't-hang';
/** how close a line's edge must come to the block's content edge to count */
const EDGE_TOL = 6;
/** the layout signature that lets an untouched block be skipped entirely */
const SIG = 'micro';

/** Blocks whose edges are not margins, or whose text is not prose. */
function skippable(el: HTMLElement): boolean {
  if (el.dataset.kind === 'cell' || el.closest('.t-table, .t-math, .t-fnarea, pre, code')) return true;
  const cs = styleOf(el);
  if (cs.direction === 'rtl') return true;
  if (cs.display === 'none' || cs.visibility === 'hidden') return true;
  return false;
}

/**
 * Rects merged into LINES.
 *
 * `Range.getClientRects()` does NOT return one rect per line — it returns one
 * per rendered FRAGMENT, so a line carrying a bold run comes back as two or
 * three, each ending mid-line. Read as lines that is silently wrong in the
 * worst way: a fragment's right edge is nowhere near the margin, so the
 * paragraphs with the most formatting are exactly the ones that quietly stop
 * hanging. Grouped by vertical overlap rather than by an equal `top`, because a
 * superscript footnote marker sits higher than the text it rides on and is
 * still on that line.
 */
export interface Line { top: number; bottom: number; left: number; right: number }

export function mergeLines(rects: readonly DOMRect[]): Line[] {
  const src = rects.filter(r => r.height > 0.5 && r.width >= 0)
    .slice().sort((a, b) => a.top - b.top || a.left - b.left);
  const out: Line[] = [];
  for (const r of src) {
    const last = out[out.length - 1];
    // overlap, not equality: a `sup` shares the line and not the baseline
    if (last && r.top < last.bottom - 1) {
      last.top = Math.min(last.top, r.top);
      last.bottom = Math.max(last.bottom, r.bottom);
      last.left = Math.min(last.left, r.left);
      last.right = Math.max(last.right, r.right);
    } else {
      out.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    }
  }
  return out;
}

/**
 * The y that separates line k from line k+1.
 *
 * Compared against a character's vertical CENTRE, which is what makes the
 * answer the same for a superscript as for the text beside it.
 */
export const lineSplits = (lines: readonly Line[]): number[] =>
  lines.slice(0, -1).map((l, i) => (l.bottom + lines[i + 1].top) / 2);

/**
 * The element's own document and view.
 *
 * NOT the module's `document`. print.ts runs this pass inside the print
 * iframe's document, and a Range or an element made by the wrong document is
 * either a WrongDocumentError or, worse, a silently adopted node.
 */
const docOf = (el: Node): Document => el.ownerDocument ?? (el as Document);
const styleOf = (el: Element): CSSStyleDeclaration =>
  (docOf(el).defaultView ?? window).getComputedStyle(el);

/** Every text node under `el`, with the running character offset of each. */
function textRuns(el: HTMLElement): Array<{ node: Text; at: number }> {
  const out: Array<{ node: Text; at: number }> = [];
  const w = docOf(el).createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let at = 0;
  let n: Node | null;
  while ((n = w.nextNode())) {
    const len = (n.nodeValue ?? '').length;
    if (len) { out.push({ node: n as Text, at }); at += len; }
  }
  return out;
}

/** (textNode, offset) for a character index across the whole block. */
function locate(runs: Array<{ node: Text; at: number }>, i: number): { node: Text; off: number } | null {
  for (let k = runs.length - 1; k >= 0; k--) {
    if (i >= runs[k].at) {
      const off = i - runs[k].at;
      return off < runs[k].node.nodeValue!.length ? { node: runs[k].node, off } : null;
    }
  }
  return null;
}

/** Take the wrappers back out, leaving the text byte-identical. */
export function unhang(root: HTMLElement): void {
  for (const span of Array.from(root.querySelectorAll<HTMLElement>(`span.${HANG_CLASS}`))) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }
  root.normalize();
}

/**
 * Optical margin alignment over a rendered flow.
 *
 * Runs after pagination has measured, because it cannot change what pagination
 * measured — that is the invariant, and the pass proves it per block rather
 * than asserting it. Blocks whose layout signature is unchanged since last time
 * keep the wrappers they already have and are not touched at all, which is what
 * keeps typing free: an edit re-examines one paragraph, not the document.
 */
export function applyOptical(host: HTMLElement, enabled: boolean): MicroStats {
  const t0 = performance.now();
  const stats: MicroStats = { blocks: 0, hung: 0, reverted: 0, ms: 0 };
  if (!enabled) {
    unhang(host);
    for (const el of Array.from(host.querySelectorAll<HTMLElement>('[data-id]'))) delete el.dataset[SIG];
    stats.ms = performance.now() - t0;
    return stats;
  }

  for (const el of Array.from(host.querySelectorAll<HTMLElement>('[data-id]'))) {
    if (skippable(el)) continue;
    const font = fontOf(el);
    const cs = styleOf(el);
    const sig = `${el.offsetWidth}|${font}|${cs.textIndent}|${cs.textAlign}|${el.textContent}`;
    if (el.dataset[SIG] === sig) continue;
    stats.blocks++;
    unhang(el);
    const hung = hangBlock(el, font, cs);
    stats.hung += hung.hung;
    if (hung.reverted) stats.reverted++;
    el.dataset[SIG] = sig;
  }
  stats.ms = performance.now() - t0;
  return stats;
}

/**
 * Everything a pass needs to know about one block's line layout.
 *
 * Shared by the hanging pass and the measurement so that the two cannot answer
 * differently about where a line ends — a measurement that disagrees with the
 * thing it is measuring is worse than no measurement.
 */
interface BlockLines {
  lines: Line[];
  text: string;
  runs: Array<{ node: Text; at: number }>;
  total: number;
  left: number;
  right: number;
  /** index of the first NON-SPACE character of line k */
  firstOf(k: number): number;
  /** index of the last NON-SPACE character of line k */
  lastOf(k: number): number;
  /** was line k broken INSIDE a word — i.e. did the browser draw a hyphen? */
  hyphenated(k: number): boolean;
  /** vertical centre of character i, in client coords */
  centre(i: number): number;
}

function blockLines(el: HTMLElement, cs: CSSStyleDeclaration): BlockLines | null {
  const text = el.textContent ?? '';
  if (!text.trim()) return null;
  const d = docOf(el);
  const range = d.createRange();
  range.selectNodeContents(el);
  const lines = mergeLines(Array.from(range.getClientRects()));
  if (!lines.length) return null;
  const runs = textRuns(el);
  if (!runs.length) return null;
  const total = runs[runs.length - 1].at + runs[runs.length - 1].node.nodeValue!.length;

  const box = el.getBoundingClientRect();
  const left = box.left + parseFloat(cs.paddingLeft || '0') + parseFloat(cs.borderLeftWidth || '0');
  const right = box.right - parseFloat(cs.paddingRight || '0') - parseFloat(cs.borderRightWidth || '0');

  const probe = d.createRange();
  const centre = (i: number): number => {
    const p = locate(runs, i);
    if (!p) return NaN;
    probe.setStart(p.node, p.off);
    probe.setEnd(p.node, p.off + 1);
    const r = probe.getBoundingClientRect();
    return r.height > 0.5 ? r.top + r.height / 2 : NaN;
  };
  const splits = lineSplits(lines);

  // boundary[k] = index of the first character of line k+1. Binary search,
  // because a character's line index is monotonic in the character index — a
  // per-character walk over the document is what hung the tab during the
  // pagination spike (paginate.ts rule 2).
  const boundary: number[] = [];
  let lo = 0;
  for (let k = 0; k + 1 < lines.length; k++) {
    let a = lo, b = total;
    while (a < b) {
      const mid = (a + b) >> 1;
      const cy = centre(mid);
      // a character whose rect we cannot read counts as still on this line, so
      // the search converges rather than throwing the block away
      if (!isFinite(cy) || cy < splits[k]) a = mid + 1; else b = mid;
    }
    boundary.push(a);
    lo = a;
  }

  // THE BREAK SPACE BELONGS TO THE LINE ABOVE IT. A line reading "…the term. "
  // has a collapsed space as its last character, so the naive index is a space
  // and nothing hangs — which is most lines. Measured before this: 14 hanging
  // characters in a 14-page document, against 25 after.
  const ws = /\s/;
  const firstOf = (k: number) => {
    let i = k === 0 ? 0 : boundary[k - 1];
    while (i < total && ws.test(text[i])) i++;
    return i;
  };
  const lastOf = (k: number) => {
    let i = (k + 1 < lines.length ? boundary[k] : total) - 1;
    while (i >= 0 && ws.test(text[i])) i--;
    return i;
  };
  // A break with no whitespace at it is a break INSIDE a word, which means
  // `hyphens: auto` drew a hyphen there — a glyph with no character behind it,
  // which nothing can wrap and nothing can hang.
  //
  // Asked as "is the next line's first character the one right after this
  // line's last", not by reading the character at the boundary index: the
  // collapsed break space can be reported on either line, so an index-based
  // test is noisy by one and re-classified ten lines of a fourteen-page
  // document between two runs that had identical line breaking.
  const hyphenated = (k: number) =>
    k + 1 < lines.length && firstOf(k + 1) === lastOf(k) + 1;

  return { lines, text, runs, total, left, right, firstOf, lastOf, hyphenated, centre };
}

/** One block. Returns what it did, having already undone it if it went wrong. */
function hangBlock(el: HTMLElement, font: string, cs: CSSStyleDeclaration): { hung: number; reverted: boolean } {
  const m = blockLines(el, cs);
  if (!m) return { hung: 0, reverted: false };
  const { lines, text, runs, left, right, firstOf, lastOf } = m;
  const d = docOf(el);

  // What to wrap: the last character of each line that reaches the right
  // margin, and the first of each line that starts at the left one.
  const jobs: Array<{ i: number; shift: number }> = [];
  const want = (i: number, edge: Edge) => {
    const ch = text[i];
    if (!ch || !protrudes(ch, edge)) return;
    const b = bearings(ch, font);
    const shift = b && opticalShift(ch, edge, b);
    if (shift) jobs.push({ i, shift });
  };
  for (let k = 0; k < lines.length; k++) {
    if (Math.abs(lines[k].right - right) <= EDGE_TOL) want(lastOf(k), 'end');
    if (Math.abs(lines[k].left - left) <= EDGE_TOL) want(firstOf(k), 'start');
  }
  if (!jobs.length) return { hung: 0, reverted: false };

  // Wrap from the back, so an earlier job's text-node split cannot move a later
  // job's offsets out from under it.
  jobs.sort((x, y) => y.i - x.i);
  let hung = 0;
  for (const job of jobs) {
    const p = locate(runs, job.i);
    if (!p) continue;
    const r = d.createRange();
    r.setStart(p.node, p.off);
    r.setEnd(p.node, p.off + 1);
    const span = d.createElement('span');
    span.className = HANG_CLASS;
    span.style.left = `${job.shift.toFixed(2)}px`;
    try { r.surroundContents(span); hung++; } catch { /* a mark boundary: skip it */ }
  }
  if (!hung) return { hung: 0, reverted: false };

  // ── the verification. Nothing above is trusted.
  //
  // Every line's first AND last character is looked up again and must still be
  // on that line. One side alone is not enough — see boundariesHeld, which
  // records the reflow that got through the one-sided version.
  const after = blockLines(el, cs);
  if (!after) { unhang(el); return { hung: 0, reverted: true }; }
  const lineAt = (i: number): number => {
    const cy = after.centre(i);
    if (!isFinite(cy)) return -1;
    return after.lines.findIndex(l => cy >= l.top - 1 && cy <= l.bottom + 1);
  };
  const ks = lines.map((_, k) => k);
  if (!boundariesHeld(
        lines.map(r => r.top), after.lines.map(r => r.top),
        ks.map(k => lineAt(lastOf(k))), ks.map(k => lineAt(firstOf(k))))) {
    unhang(el);
    return { hung: 0, reverted: true };
  }
  return { hung, reverted: false };
}

/** One line's ink edge, as an offset from the margin it is trying to reach. */
export interface InkSample {
  /** signed px: negative is ink stopping short of the margin */
  dev: number;
  /** the character painted at the line's end */
  ch: string;
  /** was the line broken inside a word, so the browser drew its own hyphen? */
  hyphenated: boolean;
}

/**
 * Where each justified line's INK actually ends, relative to the margin.
 *
 * This is the measurement the feature is justified by, and it lives in the
 * shipped module rather than in a script so the claim can be re-checked on any
 * document at any time. It reads the trailing character's OWN rect — which
 * carries the hanging offset when there is one — and subtracts that character's
 * right side bearing, so what comes back is the position of the last ink on
 * the line and not the position of its advance box.
 *
 * The last line of a justified paragraph is excluded: it is set flush left and
 * says nothing about the right margin. Hyphenated lines are REPORTED rather
 * than dropped, because they are the population this feature cannot help
 * (`hyphens: auto` draws a glyph with no character behind it) and hiding them
 * would flatter the result.
 */
export function inkDeviation(host: HTMLElement): InkSample[] {
  const out: InkSample[] = [];
  const probe = docOf(host).createRange();
  for (const el of Array.from(host.querySelectorAll<HTMLElement>('[data-id]'))) {
    if (skippable(el)) continue;
    const cs = styleOf(el);
    if (cs.textAlign !== 'justify') continue;
    const m = blockLines(el, cs);
    if (!m) continue;
    const font = fontOf(el);
    for (let k = 0; k + 1 < m.lines.length; k++) {
      const i = m.lastOf(k);
      const ch = m.text[i];
      if (!ch) continue;
      const p = locate(m.runs, i);
      if (!p) continue;
      probe.setStart(p.node, p.off);
      probe.setEnd(p.node, p.off + 1);
      const r = probe.getBoundingClientRect();
      if (!(r.height > 0.5)) continue;
      const b = bearings(ch, font);
      const rsb = b ? Math.max(0, b.advance - b.inkRight) : 0;
      out.push({ dev: r.right - rsb - m.right, ch, hyphenated: m.hyphenated(k) });
    }
  }
  return out;
}

/** mean and standard deviation of a sample, for reporting a measurement */
export function stats(xs: readonly number[]): { n: number; mean: number; sd: number } {
  const n = xs.length;
  if (!n) return { n: 0, mean: 0, sd: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { n, mean, sd };
}

// ─────────────────────────────────────────────────────────────── registration

import { registerPaginated, registerReady } from './features.ts';
import type { TypeDoc } from './model.ts';

/** Absent means on — see the header for why this file's default is not "off". */
export const opticalOn = (doc: Pick<TypeDoc, 'optical'>): boolean => doc.optical !== false;

/** The last pass's numbers, for the status line and for anyone measuring. */
export let lastPass: MicroStats = { blocks: 0, hung: 0, reverted: 0, ms: 0 };

registerPaginated((ctx, _metrics, host) => {
  // The caret is saved and put back around the pass. Wrapping splits a text
  // node, and a split under a live selection is how a caret jumps a character
  // while somebody is typing — the model position is the one that survives it
  // (editor.ts rule 1).
  const focused = host.contains(document.activeElement) || host === document.activeElement;
  const caret = focused ? ctx.editor.caret() : null;
  lastPass = applyOptical(host, opticalOn(ctx.store.doc));
  if (caret) ctx.editor.setCaret(caret);
});

registerReady(ctx => {
  // A diagnostic handle, in the shape window.bento.comments() already
  // established: the measurement this feature is justified by has to be
  // re-runnable on a real document, not only in a rig.
  (globalThis as unknown as Record<string, unknown>).bentoMicro = {
    stats: () => lastPass,
    // run a pass over an arbitrary rendered flow — the print document included,
    // which is how the cross-document path (a Range must come from the node's
    // OWN document) is checked without opening a print dialog
    apply: (host: HTMLElement, on = true) => applyOptical(host, on),
    deviation: (host?: HTMLElement) => {
      const el = host ?? document.querySelector<HTMLElement>('.t-paper');
      if (!el) return null;
      const all = inkDeviation(el);
      const flush = all.filter(s => !s.hyphenated);
      return {
        all: stats(all.map(s => s.dev)),
        // the population this feature can act on at all
        unhyphenated: stats(flush.map(s => s.dev)),
        hyphenated: all.length - flush.length,
      };
    },
    samples: (host?: HTMLElement) => {
      const el = host ?? document.querySelector<HTMLElement>('.t-paper');
      return el ? inkDeviation(el) : null;
    },
    set: (on: boolean) => {
      ctx.store.commit(d => { if (on) delete d.optical; else d.optical = false; });
      ctx.refresh();
    },
  };
});
