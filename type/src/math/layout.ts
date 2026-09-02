// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Math nodes → HTML, with the vertical arithmetic done here rather than by the
// browser.
//
// WHY THERE ARE METRICS AT ALL. Almost everything horizontal (widths, line
// breaking, centring a numerator over a denominator) is something CSS already
// does well, and this module leaves all of it to CSS. Four things CSS cannot
// do, and they are exactly the four that make a formula look typeset:
//
//   · a fraction bar must sit on the MATH AXIS of the surrounding line, not at
//     an arbitrary offset, and the axis is where the `=` sign's bar is
//   · a superscript must clear the base's height and a subscript its depth,
//     and the two must clear EACH OTHER
//   · a radical and a `\left(` must be as tall as what they contain
//   · a matrix must centre on the axis
//
// Each needs a HEIGHT, and asking the DOM for one would mean rendering, then
// measuring, then re-rendering — which is not pure, not deterministic, costs a
// forced reflow per formula, and would make the printed document depend on the
// screen it was laid out on. So this module carries a MODEL of the metrics:
// every box reports how far it rises above and falls below its own baseline,
// in em, and the shifts are computed from those.
//
// The model is APPROXIMATE and knows it. A line of text is taken to rise 0.75em
// and fall 0.22em regardless of what glyphs are in it, because a self-contained
// document cannot ship a font and therefore cannot know the reader's metrics.
// The consequence is that a shift can be a few hundredths of an em out — which
// is invisible — and never that a box overlaps its neighbour, because every
// clearance is computed from the same conservative numbers on both sides.
//
// UNITS. All metrics are in em OF THE FORMULA'S OUTERMOST font size, so boxes
// of different script sizes can be compared and added directly. CSS lengths,
// however, resolve against the ELEMENT's font size — so every number that goes
// into an attribute is divided by the size of the style it is emitted in. That
// division is the one thing in this file that must never be forgotten; `emIn`
// exists so it happens in one place.

import {
  parseMath, type MathNode, type ParseOut, type StyleName, type Variant,
} from './parse.ts';
import { ALPHABETS, type Cls } from './symbols.ts';

/** Font size of each style, as a fraction of the formula's base size. */
const SIZE: Record<StyleName, number> = { D: 1, T: 1, S: 0.7, SS: 0.5 };
/** How far a line of text rises above, and falls below, its baseline. */
const ASCENT = 0.75, DESCENT = 0.22;
/** The math axis: where a fraction bar and a `−` sign sit. */
const AXIS = 0.25;
/** Default rule thickness (fraction bar, radical bar, overline). */
const RULE = 0.048;

/** The style a script (superscript, subscript) is set in. */
const SCRIPT_OF: Record<StyleName, StyleName> = { D: 'S', T: 'S', S: 'SS', SS: 'SS' };
/** The style a fraction's numerator and denominator are set in. */
const FRAC_OF: Record<StyleName, StyleName> = { D: 'T', T: 'S', S: 'SS', SS: 'SS' };

export interface Box {
  html: string;
  /** rise above the baseline, in em of the formula's base size */
  h: number;
  /** fall below it */
  d: number;
  /** the atom class, which is what decides the space before the next box */
  cls: Cls;
}

export interface LayoutOpts {
  /** display math is set in D style: bigger operators, taller fractions */
  display?: boolean;
}

interface St {
  style: StyleName;
  variant?: Variant;
  alphabet?: string;
}

// ────────────────────────────────────────────────────────────── plumbing

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const esc = (s: string): string => s.replace(/[&<>"]/g, c => ESC[c]);

/**
 * A number, rounded to a fixed number of places.
 *
 * DETERMINISM LIVES HERE. The same source must produce the same bytes on every
 * machine — the signature covers the document, but a redline that re-rendered
 * a formula and saw different markup would report a change nobody made. Fixed
 * rounding also keeps floating-point noise (0.30000000000000004) out of the
 * output, which is the readable version of the same requirement.
 */
export const num = (v: number): string => {
  const r = Math.round(v * 1e4) / 1e4;
  return Object.is(r, -0) ? '0' : String(r);
};

/** A length in em of an element that is set at `size`. */
const emIn = (v: number, size: number): string => `${num(v / size)}em`;

const VARIANT_CLASS: Record<Variant, string> = {
  italic: 't-mi', up: '', bold: 't-mb', bolditalic: 't-mbi', sans: 't-msf', mono: 't-mtt',
};

const box = (html: string, h: number, d: number, cls: Cls): Box => ({ html, h, d, cls });

// ────────────────────────────────────────────────────────────── spacing
//
// TeX's inter-atom spacing, reduced to the rule that matters: a Bin gets a
// medium space around it, a Rel a thick one, a Punct a thin one after, and an
// Op a thin one after. Script styles get none of it, which is why `x^{a+b}`
// stays compact.

const SPACE_BEFORE: Record<Cls, number> = {
  ord: 0, op: 0.167, bin: 0.222, rel: 0.278, open: 0, close: 0, punct: 0, inner: 0.167,
};
const SPACE_AFTER: Record<Cls, number> = {
  ord: 0, op: 0.167, bin: 0.222, rel: 0.278, open: 0, close: 0, punct: 0.167, inner: 0.167,
};
/**
 * A Bin that has nothing to bind becomes an Ord.
 *
 * This is what makes `-x` a negation set tight against the x, while `a-x` is a
 * subtraction with air around the sign. Without it every leading minus in the
 * document is spaced as though something were missing before it.
 */
const demoteBin = (cls: Cls, prev: Cls | null): Cls =>
  cls === 'bin' && (prev === null || prev === 'bin' || prev === 'rel' || prev === 'open'
                    || prev === 'punct' || prev === 'op')
    ? 'ord' : cls;

// ────────────────────────────────────────────────────────────── the walk

export function layout(node: MathNode, st: St): Box {
  const size = SIZE[st.style];
  switch (node.k) {
    case 'row': return layoutRow(node.body, st);
    case 'atom': return layoutAtom(node.ch, node.cls, node.variant, st);
    case 'op': return layoutOp(node, st);
    case 'frac': return layoutFrac(node, st);
    case 'sqrt': return layoutSqrt(node, st);
    case 'script': return layoutScript(node, st);
    case 'fence': return layoutFence(node, st);
    case 'accent': return layoutAccent(node, st);
    case 'bar': return layoutBar(node, st);
    case 'matrix': return layoutMatrix(node, st);
    case 'text':
      return box(`<span class="t-mtext">${esc(node.s)}</span>`, ASCENT * size, DESCENT * size, 'ord');
    case 'space':
      return node.em >= 0
        ? box(`<span class="t-msp" style="width:${emIn(node.em * size, size)}"></span>`, 0, 0, 'ord')
        : box(`<span class="t-msp" style="margin-left:${emIn(node.em * size, size)}"></span>`, 0, 0, 'ord');
    case 'style': {
      const inner = layout(node.body, { ...st, style: node.style });
      const ratio = SIZE[node.style] / size;
      if (ratio === 1) return inner;
      return box(`<span style="font-size:${num(ratio)}em">${inner.html}</span>`, inner.h, inner.d, inner.cls);
    }
    case 'font':
      return layout(node.body, { ...st, variant: node.variant ?? st.variant, alphabet: node.alphabet });
    case 'err':
      // The whole point of the error node: it is VISIBLE, it is in place, and
      // it carries the reason in a tooltip. Everything around it still sets.
      return box(`<span class="t-merr" title="${esc(node.msg)}">${esc(node.s || '?')}</span>`,
                 ASCENT * size, DESCENT * size, 'ord');
  }
}

function layoutRow(body: MathNode[], st: St): Box {
  const size = SIZE[st.style];
  if (!body.length) return box('', 0, 0, 'ord');
  const parts: string[] = [];
  let h = 0, d = 0;
  let prev: Cls | null = null;
  let first: Cls | null = null;
  const tight = st.style === 'S' || st.style === 'SS';
  for (const child of body) {
    const b = layout(child, st);
    if (!b.html && b.h === 0 && b.d === 0 && b.cls === 'ord' && child.k === 'row') continue;
    const cls = demoteBin(b.cls, prev);
    if (prev !== null && !tight) {
      // the wider of what the left atom wants after it and the right atom
      // wants before it — never the sum, or `a = b` would set twice as loose
      // as `a + b` for no reason a reader could name
      const gap = Math.max(SPACE_AFTER[prev], SPACE_BEFORE[cls]);
      if (gap > 0) parts.push(`<span class="t-msp" style="width:${num(gap)}em"></span>`);
    }
    parts.push(b.html);
    h = Math.max(h, b.h); d = Math.max(d, b.d);
    prev = cls;
    if (first === null) first = cls;
  }
  if (!parts.length) return box('', 0, 0, 'ord');
  // an empty-looking row still needs SOME height, or a fence around it collapses
  if (h === 0 && d === 0) { h = ASCENT * size; d = DESCENT * size; }
  return box(parts.join(''), h, d, body.length === 1 && first ? first : 'ord');
}

function layoutAtom(ch: string, cls: Cls, variant: Variant | undefined, st: St): Box {
  const size = SIZE[st.style];
  let c = ch;
  if (st.alphabet) {
    const table = ALPHABETS[st.alphabet];
    if (table && table[c]) c = table[c];
  }
  const v = st.variant ?? variant ?? 'up';
  const klass = VARIANT_CLASS[v];
  const html = klass ? `<span class="${klass}">${esc(c)}</span>` : esc(c);
  return box(html, ASCENT * size, DESCENT * size, cls);
}

function layoutOp(node: Extract<MathNode, { k: 'op' }>, st: St): Box {
  const size = SIZE[st.style];
  if (!node.big) {
    // a function name: upright, and one unit — `\sin` never sets as s·i·n
    return box(`<span class="t-mop">${esc(node.name ?? node.ch)}</span>`,
               ASCENT * size, DESCENT * size, 'op');
  }
  // Big operators grow in display style, and they CENTRE ON THE AXIS rather
  // than sitting on the baseline: a summation sign hanging off the baseline is
  // the single most obvious tell of a home-made math renderer.
  const f = st.style === 'D' ? 1.42 : 1;
  const mid = ((ASCENT - DESCENT) / 2) * size * f;
  const v = AXIS * size - mid;
  const style = `font-size:${num(f)}em;vertical-align:${emIn(v, size * f)}`;
  return box(`<span class="t-mbig" style="${style}">${esc(node.ch)}</span>`,
             ASCENT * size * f + v, DESCENT * size * f - v, 'op');
}

/**
 * A fraction.
 *
 * The bar goes on the AXIS, so `\frac{1}{2}` and `x = \frac{1}{2}` have their
 * bar at the same height as the `=`. Everything else follows from that: the
 * numerator is stacked above it and the denominator below, and the whole box is
 * then lowered so the bar lands where it belongs.
 *
 * The emitted box is an inline-block whose baseline is its LAST line box — the
 * denominator's — which is why the shift is computed from the denominator's
 * height and not from the box's total height.
 */
function layoutFrac(node: Extract<MathNode, { k: 'frac' }>, st: St): Box {
  const size = SIZE[st.style];
  const inner: StyleName = node.style ?? FRAC_OF[st.style];
  const cs = SIZE[inner];
  const num_ = layout(node.num, { ...st, style: inner });
  const den = layout(node.den, { ...st, style: inner });
  const rule = node.bar ? RULE * size : 0;
  const gap = (st.style === 'D' ? 0.14 : 0.10) * size;

  const barAbove = den.h + gap + rule / 2;           // bar centre over box baseline
  const v = AXIS * size - barAbove;                  // lower the box onto the axis
  const h = AXIS * size + rule / 2 + gap + num_.h + num_.d;
  const d = den.d + barAbove - AXIS * size;

  const numStyle = `font-size:${num(cs / size)}em;padding-bottom:${emIn(gap, cs)}` +
    (node.bar ? `;border-bottom-width:${emIn(rule, cs)}` : '');
  const denStyle = `font-size:${num(cs / size)}em;padding-top:${emIn(gap, cs)}`;
  const html =
    `<span class="t-mfrac${node.bar ? '' : ' t-nobar'}" style="vertical-align:${emIn(v, size)}">` +
    `<span class="t-mnum" style="${numStyle}">${num_.html || ZW}</span>` +
    `<span class="t-mden" style="${denStyle}">${den.html || ZW}</span></span>`;

  const inner_ = box(html, h, d, 'inner');
  if (!node.left && !node.right) return inner_;
  return fenceAround(inner_, node.left ?? '', node.right ?? '', st);
}

/**
 * A square root.
 *
 * The surd is an SVG stretched to the height of what it covers, with
 * `vector-effect="non-scaling-stroke"` so the stroke stays even however far it
 * is stretched — the reason not to use a `√` glyph with a scaleY, which
 * thickens the horizontal stroke as it grows and looks wrong at any size worth
 * stretching for.
 */
function layoutSqrt(node: Extract<MathNode, { k: 'sqrt' }>, st: St): Box {
  const size = SIZE[st.style];
  const body = layout(node.body, st);
  const rule = RULE * size;
  const gap = 0.09 * size;
  const total = body.h + gap + rule + body.d;

  const surd =
    `<svg class="t-msurd" viewBox="0 0 12 100" preserveAspectRatio="none" aria-hidden="true" ` +
    `style="height:${emIn(total, size)};vertical-align:${emIn(-body.d, size)}">` +
    `<path d="M0.7 60 L3.4 55 L6.2 95 L10.5 3 L12 3" vector-effect="non-scaling-stroke"/></svg>`;

  let index = '';
  if (node.index) {
    const ix = layout(node.index, { ...st, style: 'SS' });
    // the index sits in the crook of the surd: up by most of its height, and
    // pulled right so it does not push the radical along the line
    const lift = total * 0.55;
    index = `<span class="t-mroot" style="vertical-align:${emIn(lift, SIZE.SS * size)};` +
            `font-size:${num(SIZE.SS)}em">${ix.html}</span>`;
  }
  const covered =
    `<span class="t-mrad" style="border-top-width:${emIn(rule, size)};` +
    `padding-top:${emIn(gap, size)}">${body.html || ZW}</span>`;
  return box(index + surd + covered, body.h + gap + rule, body.d, 'ord');
}

/** Superscripts and subscripts — beside the base, or above and below it. */
function layoutScript(node: Extract<MathNode, { k: 'script' }>, st: St): Box {
  const size = SIZE[st.style];
  const base = layout(node.base, st);
  const sStyle = SCRIPT_OF[st.style];
  const ss = SIZE[sStyle];
  const sup = node.sup ? layout(node.sup, { ...st, style: sStyle }) : null;
  const sub = node.sub ? layout(node.sub, { ...st, style: sStyle }) : null;
  if (!sup && !sub) return base;

  // ── limits: `\sum_{i=1}^{n}` in display style stacks its bounds
  const wantsLimits = node.base.k === 'op' && node.base.limits && st.style === 'D';
  if (wantsLimits) return stackLimits(base, sup, sub, st);

  const supShift = sup
    ? Math.max(base.h - 0.30 * ss * size, (st.style === 'D' ? 0.42 : 0.36) * size, sup.d + 0.08 * size)
    : 0;
  let subShift = sub
    ? Math.max(base.d + 0.20 * ss * size, 0.22 * size, sub.h - 0.36 * size)
    : 0;

  if (sup && sub) {
    // they must clear each other, or `x_i^j` sets as a single blur
    const clearance = 0.16 * size;
    const between = (supShift - sup.d) - (sub.h - subShift);
    if (between < clearance) subShift += clearance - between;
    const pad = (supShift + subShift) - sup.d - sub.h;
    const html =
      `<span class="t-mss" style="vertical-align:${emIn(-subShift, ss)};font-size:${num(ss / size)}em">` +
      `<span class="t-msup">${sup.html || ZW}</span>` +
      `<span class="t-msub" style="padding-top:${emIn(Math.max(0, pad), ss)}">${sub.html || ZW}</span>` +
      `</span>`;
    return box(base.html + html,
               Math.max(base.h, supShift + sup.h), Math.max(base.d, subShift + sub.d), base.cls);
  }
  if (sup) {
    const html = `<span class="t-msup t-mside" style="font-size:${num(ss / size)}em;` +
      `vertical-align:${emIn(supShift, ss)}">${sup.html || ZW}</span>`;
    return box(base.html + html, Math.max(base.h, supShift + sup.h), base.d, base.cls);
  }
  const html = `<span class="t-msub t-mside" style="font-size:${num(ss / size)}em;` +
    `vertical-align:${emIn(-subShift, ss)}">${sub!.html || ZW}</span>`;
  return box(base.html + html, base.h, Math.max(base.d, subShift + sub!.d), base.cls);
}

/** Bounds above and below a big operator. */
function stackLimits(base: Box, sup: Box | null, sub: Box | null, st: St): Box {
  const size = SIZE[st.style];
  const ss = SIZE[SCRIPT_OF[st.style]];
  const gap = 0.16 * size;
  const rows: string[] = [];
  if (sup) {
    rows.push(`<span class="t-mover" style="font-size:${num(ss / size)}em;` +
      `padding-bottom:${emIn(gap, ss)}">${sup.html || ZW}</span>`);
  }
  rows.push(`<span class="t-mlimb">${base.html}</span>`);
  if (sub) {
    rows.push(`<span class="t-munder" style="font-size:${num(ss / size)}em;` +
      `padding-top:${emIn(gap, ss)}">${sub.html || ZW}</span>`);
  }
  // the inline-block's baseline is its last row's; shift so the OPERATOR's
  // baseline is the one that lands on the line
  const v = sub ? -(base.d + gap + sub.h) : 0;
  const html = `<span class="t-mlim" style="vertical-align:${emIn(v, size)}">${rows.join('')}</span>`;
  return box(html,
             base.h + (sup ? gap + sup.h + sup.d : 0),
             base.d + (sub ? gap + sub.h + sub.d : 0), 'op');
}

/** `\left( … \right)` — the delimiters grow with what they hold. */
function layoutFence(node: Extract<MathNode, { k: 'fence' }>, st: St): Box {
  return fenceAround(layout(node.body, st), node.left, node.right, st);
}

function fenceAround(body: Box, left: string, right: string, st: St): Box {
  const size = SIZE[st.style];
  // how far the content reaches from the axis, in each direction
  const above = body.h - AXIS * size;
  const below = body.d + AXIS * size;
  const k = Math.max(1,
                     above / ((ASCENT - AXIS) * size) * 1.02,
                     below / ((DESCENT + AXIS) * size) * 1.02);
  const scaled = Math.round(k * 1000) / 1000;
  const delim = (ch: string): string => {
    if (!ch) return '';
    if (scaled <= 1.001) return `<span class="t-mdelim">${esc(ch)}</span>`;
    return `<span class="t-mdelim" style="transform:scaleY(${num(scaled)})">${esc(ch)}</span>`;
  };
  const h = Math.max(body.h, AXIS * size + scaled * (ASCENT - AXIS) * size);
  const d = Math.max(body.d, scaled * (DESCENT + AXIS) * size - AXIS * size);
  return box(delim(left) + body.html + delim(right), h, d, 'inner');
}

/**
 * An accent (`\hat x`, `\vec v`).
 *
 * The accent is ABSOLUTELY positioned over the base, so it adds no width and
 * cannot shift the base along the line. It is excluded from the box's reported
 * height by only a hair, which is deliberate: a hat on a tall base would
 * otherwise open up the line above it in running prose, and TeX makes the same
 * compromise.
 */
function layoutAccent(node: Extract<MathNode, { k: 'accent' }>, st: St): Box {
  const size = SIZE[st.style];
  const body = layout(node.body, st);
  const gap = 0.04 * size;
  // where an accent glyph's ink sits above the bottom of its own line box
  const INK = 0.77 * size;
  const bottom = body.h + body.d + gap - INK;
  const html = `<span class="t-macc">${body.html || ZW}` +
    `<span class="t-maccm" style="bottom:${emIn(bottom, size)}">${esc(node.ch)}</span></span>`;
  return box(html, body.h + gap + 0.16 * size, body.d, body.cls);
}

/** `\overline` / `\underline`. */
function layoutBar(node: Extract<MathNode, { k: 'bar' }>, st: St): Box {
  const size = SIZE[st.style];
  const body = layout(node.body, st);
  const rule = RULE * size;
  const gap = 0.09 * size;
  if (node.under) {
    const html = `<span class="t-mbar t-under" style="border-bottom-width:${emIn(rule, size)};` +
      `padding-bottom:${emIn(gap, size)}">${body.html || ZW}</span>`;
    return box(html, body.h, body.d + gap + rule, body.cls);
  }
  const html = `<span class="t-mbar t-over" style="border-top-width:${emIn(rule, size)};` +
    `padding-top:${emIn(gap, size)}">${body.html || ZW}</span>`;
  return box(html, body.h + gap + rule, body.d, body.cls);
}

/**
 * A matrix, `cases`, or `aligned` — one inline-table, centred on the axis.
 *
 * An inline-table takes its baseline from its FIRST row, which is why the shift
 * is computed rather than assumed: without it a three-row matrix sits with its
 * top row on the line and the rest hanging below.
 */
function layoutMatrix(node: Extract<MathNode, { k: 'matrix' }>, st: St): Box {
  const size = SIZE[st.style];
  const cellStyle: StyleName = st.style === 'D' ? 'T' : st.style;
  const pad = 0.16 * size;
  const rowsHtml: string[] = [];
  const heights: Array<{ h: number; d: number }> = [];
  for (const row of node.rows) {
    let h = ASCENT * SIZE[cellStyle], d = DESCENT * SIZE[cellStyle];
    const cells: string[] = [];
    for (const cellNode of row) {
      const b = layout(cellNode, { ...st, style: cellStyle });
      h = Math.max(h, b.h); d = Math.max(d, b.d);
      cells.push(`<span class="t-mcell">${b.html || ZW}</span>`);
    }
    heights.push({ h, d });
    rowsHtml.push(`<span class="t-mrow2">${cells.join('')}</span>`);
  }
  if (!heights.length) return box('', ASCENT * size, DESCENT * size, 'inner');

  const total = heights.reduce((a, r) => a + r.h + r.d + 2 * pad, 0);
  const firstBaseline = pad + heights[0].h;
  const v = AXIS * size - (firstBaseline - total / 2);
  const cls = node.align === 'l' ? ' t-mleft' : '';
  const html = `<span class="t-mmatrix${cls}" style="vertical-align:${emIn(v, size)};` +
    `--t-mpad:${emIn(pad, size)}">${rowsHtml.join('')}</span>`;
  const inner = box(html, v + firstBaseline, total - firstBaseline - v, 'inner');
  if (!node.left && !node.right) return inner;
  return fenceAround(inner, node.left, node.right, st);
}

/**
 * A zero-width space, and the least obvious load-bearing character in this
 * module.
 *
 * PAGINATION MEASURES TEXT NODES. `paginate.ts` walks the flow with a
 * TreeWalker over SHOW_TEXT and takes a rect per line — an element carrying no
 * text at all is invisible to it, so a formula made only of rules and SVG (an
 * empty `\sqrt{}` while it is being typed, `\frac{}{}` from a generator) would
 * occupy space on screen that the page breaks do not know about, and every page
 * after it would break in the wrong place. Every empty slot therefore gets a
 * U+200B, which is a text node, is not whitespace to `String.trim` (so the
 * walker accepts it), and prints nothing.
 */
const ZW = '​';

// ────────────────────────────────────────────────────────────── entry points

/** Lay out a parsed formula. Exported for the rig, which checks purity. */
export function layoutMath(root: MathNode, opts: LayoutOpts = {}): Box {
  return layout(root, { style: opts.display ? 'D' : 'T' });
}

export interface Rendered {
  /** the markup, without any wrapper */
  html: string;
  h: number;
  d: number;
  /** everything the parser objected to, in source order */
  errors: string[];
}

/** Source → markup. Pure, deterministic, and it never throws. */
export function renderMath(src: string, opts: LayoutOpts = {}): Rendered {
  let parsed: ParseOut;
  try {
    parsed = parseMath(src);
  } catch (e) {
    parsed = { root: { k: 'err', s: src.slice(0, 80), msg: String(e) }, errors: [String(e)] };
  }
  try {
    const b = layoutMath(parsed.root, opts);
    return { html: b.html || ZW, h: b.h, d: b.d, errors: parsed.errors };
  } catch (e) {
    // Same contract as the parser's: a formula is content, and no content may
    // be able to stop the page from rendering.
    return { html: `<span class="t-merr">${esc(src.slice(0, 120))}</span>`,
             h: ASCENT, d: DESCENT, errors: [...parsed.errors, String(e)] };
  }
}

export { ZW };
