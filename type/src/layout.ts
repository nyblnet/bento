// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Paragraph layout and page setup — the controls a word processor is expected
// to have, and the geometry they are expressed in.
//
// WHAT IS HERE. Alignment, space before/after, line spacing, first-line indent
// and the two page-breaking hints (keep with next, keep together) as PARAGRAPH
// properties; page size, orientation and the four margins as DOCUMENT geometry;
// and an explicit page break the author inserts. The maths and the
// property→CSS mapping are pure functions with no DOM in them, because they are
// the part that has to be right: a wrong millimetre is a wrong printed page,
// and that is only observable on paper.
//
// ────────────────────────────────────────────────────────── 96px = 1in, why
//
// The model stores CSS px and this module converts mm and inches into them at
// 96px to the inch. That is not a convention picked here, it is the definition:
// CSS defines the px as 1/96 of an inch (css-values-4 §6.2), the browser maps
// it to physical length when it prints, and print.ts already emits
// `@page { size: 816px 1056px }` for US Letter — 8.5in × 96 and 11in × 96. So
// A4 is 210mm × 96/25.4 = 793.7px, rounded to 794. Storing mm instead and
// converting at print time would put the same constant in the pipeline one step
// later, with the geometry the editor measures no longer being the geometry the
// paper has. The rounding is to whole px and it is the ONLY lossy step: 794px
// is 210.05mm, a twentieth of a millimetre, well inside what any printer's
// unprintable margin swallows.
//
// Locale decides which unit the DIALOG speaks (in for the US, Canada and the
// Philippines, which never adopted ISO 216; mm everywhere else). The stored
// value is px in both cases — the unit is a viewer preference, exactly as the
// locale and the theme are, and it never enters the document.
//
// ──────────────────────────────────────────── absent means the document default
//
// A paragraph property is written ONLY when it differs from what the document
// says. A paragraph with no `align` is justified because the document's default
// is justify — not because someone wrote 'justify' into it. Setting a property
// to the current default DELETES the field rather than storing it.
//
// This is the whole point of the design, not tidiness. It is what makes "make
// this document ragged-right" one edit to `doc.layout.align` instead of an edit
// to nine hundred paragraphs, and it is what lets a document imported from
// elsewhere adopt this document's typography. The cost is that a paragraph
// deliberately set to the same value as the default is indistinguishable from
// one that was never touched — and that is the right trade, because a
// paragraph the author never touched SHOULD follow the document.
//
// Consequence for CSS: a block's inline style carries only its own overrides;
// document defaults are set once on the paper (custom properties, read by the
// rule block appended to styles.css). Neither is a value baked into a thousand
// elements.
//
// ────────────────────────────────────────────────── the two page-break hints
//
// `keepTogether` (do not split this paragraph across pages) and `keepNext` (do
// not part this paragraph from the one after it — the heading rule) are hints
// to PAGINATION, not CSS. paginate.ts breaks at a LINE boundary: it measures
// every line box through a TreeWalker and takes the first line whose bottom
// overflows. A keep hint means the break may only fall at a BLOCK boundary for
// the blocks that carry one, so pagination has to know which block each line
// belongs to — which it deliberately does not today ("pagination stays
// indifferent — it measures line boxes and never looks at block structure").
//
// So the change is real and it is two lines in lineBoxes plus a call: tag each
// line box with the nearest [data-id] ancestor, then group the tagged boxes
// into ATOMS (`atomize` below) and pick the break with `breakY` instead of the
// inline loop. Both are pure and tested here. The escape hatch matters as much
// as the rule: an atom TALLER than the page cannot be honoured, and pagination
// falls back to line breaking inside it — without that a keep-together
// three-page paragraph produces an empty page and then another one, forever.
//
// ══════════════════════════════════════════════════════ NEEDS FROM THE CORE
//
// Four patches. The module works without them — it applies everything to the
// editor's DOM itself and draws its own page-break rule — but without (1) the
// properties do not survive a save, and without (3) an explicit page break and
// the keep hints do not move a page boundary.
//
// (1) model.ts — THE FORMAT. Two additions and one BUG.
//
//     · `Block` gains the optional paragraph properties:
//
//         align?: 'left' | 'center' | 'right' | 'justify';
//         sb?: number;   // space before, px
//         sa?: number;   // space after, px
//         lh?: number;   // line spacing, a multiple of the font size
//         ind?: number;  // first-line indent, px
//         keepNext?: true; keepTogether?: true; breakBefore?: true;
//
//     · `PageSpec` gains `marginLeft?: number; marginRight?: number` — absent
//       means `marginX`, so every existing file and every symmetric page keeps
//       writing the one field it writes today.
//
//     · `TypeDoc` gains `layout?: { align?; sb?; sa?; lh?; ind? }` — the
//       document defaults. Absent means the built-in ones (DOC_DEFAULTS here).
//
//     · THE BUG: parseDoc BUILDS a fresh block — `const out: Block = { id,
//       kind, text }` — and copies only marks/notes/role/level/cell onto it.
//       Every OTHER field of a block is silently dropped on load. Document-level
//       unknown fields ride along on the object spread and survive; block-level
//       ones do not, so format additivity holds for the document and not for
//       the block, which is where a word processor's additive fields will
//       mostly land. This is not specific to my feature: any block property any
//       future version adds is erased by every older build that opens the file,
//       which is precisely the failure additivity exists to prevent. Minimal
//       fix, in the same place the known fields are copied:
//
//         const KNOWN = new Set(['id','kind','text','marks','notes','role','level','cell']);
//         for (const [k, v] of Object.entries(b)) if (!KNOWN.has(k)) (out as Record<string, unknown>)[k] = v;
//
//       and then CLAMP the ones we now know, as `level` already is — align to
//       the four words, lh to 0.5…4, sb/sa/ind to finite and ≥ 0, the three
//       keep flags to `true` — dropping anything else. `Block` also needs
//       `[extra: string]: unknown` for that copy to type-check, matching what
//       `TypeDoc` already declares.
//
// (2) render.ts — one line in `renderBlock`, so the editor and PRINT get the
//     same styles from the same place:
//
//         import { blockStyle } from './layout.ts';
//         ...
//         const st = blockStyle(b); if (st) el.setAttribute('style', st);
//
//     and the twin in print.ts `bodyHtml`, on the element it already builds:
//     `<${TAG[b.kind]} data-id="…" style="${blockStyle(b)}">`. `blockStyle`
//     takes the BLOCK ALONE by design — defaults belong to the paper, not to
//     ten thousand copies of themselves.
//
// (3) paginate.ts — the hints. In `lineBoxes`, tag each box:
//
//         const owner = (n: Node) => { let p = n.parentElement;
//           while (p && p !== host && !p.dataset.id) p = p.parentElement;
//           return p?.dataset.id; };
//         ... out.push({ top: …, bottom: …, id: owner(n) });
//
//     and in `paginate`, replace the inner break loop
//
//         let e = Infinity;
//         for (const b of boxes) { if (b.top < start - 0.5) continue;
//                                  if (b.bottom - start > avail) { e = b.top; break; } }
//
//     with `const e = breakY(units, start, avail);` where
//     `const units = atomize(doc.body, boxes)` is computed once, beside
//     `const boxes = …`. `LineBox` gains `id?: string`. Nothing else in that
//     file changes; with no keeps and no breaks in the document `atomize`
//     returns one atom per line and `breakY` reproduces the loop above exactly
//     — verified in scripts/test-type-layout.ts.
//
// (4) print.ts — asymmetric margins and the document defaults, both in
//     `printCss`: use `margins(doc.page)` for the page box's left/right padding
//     and for the `.t-run`/`.t-fn` insets, and emit `docVars(doc)` as
//     declarations on `body` so the printed page carries the same defaults the
//     screen does. paginate.ts's note probe (`probe.style.width`) needs the
//     same treatment: `contentBox(page).width`.
//
// Until (1) lands, the properties this module writes are lost on the next load
// — the module is complete and testable, the FILE is not durable.

import type { Block, PageSpec, TypeDoc } from './model.ts';
import { registerKey, registerPanel, type FeatureContext } from './features.ts';
import { locale, t } from './i18n.ts';

// ────────────────────────────────────────────────────────────────── geometry

/** CSS defines the px as 1/96 inch. Everything below follows from that. */
export const PX_PER_IN = 96;
export const PX_PER_MM = PX_PER_IN / 25.4;
/** points, for vertical space — typography's own unit, 72 to the inch */
export const PX_PER_PT = PX_PER_IN / 72;

export type Unit = 'mm' | 'in';

/** px per unit. One table, so no conversion is written twice. */
const PER: Record<Unit, number> = { mm: PX_PER_MM, in: PX_PER_IN };

export const toUnit = (px: number, u: Unit): number => px / PER[u];
export const fromUnit = (v: number, u: Unit): number => v * PER[u];

/**
 * Which unit this reader thinks in.
 *
 * The US, Canada and the Philippines never adopted ISO 216 and their paper is
 * sold in inches; everywhere else is millimetres. A reader's preference, so it
 * follows the VIEWER's locale and never the document — the same rule the
 * language picker follows.
 */
export function unitFor(loc: string): Unit {
  const l = loc.toLowerCase();
  return /(^|-)(us|ca|ph)(-|$)/.test(l) ? 'in' : 'mm';
}

/** Round for display: inches want 2 decimals (0.25in is a real setting), mm 0. */
export function formatLen(px: number, u: Unit): string {
  const v = toUnit(px, u);
  return u === 'in' ? String(Math.round(v * 100) / 100) : String(Math.round(v));
}

/** Read a typed length back. Returns null for anything that is not a number. */
export function parseLen(text: string, u: Unit): number | null {
  const v = Number(String(text).replace(',', '.').trim());
  return Number.isFinite(v) ? fromUnit(v, u) : null;
}

export type SizeId = 'a4' | 'letter' | 'legal';
export type Orientation = 'portrait' | 'landscape';

/**
 * The paper sizes, PORTRAIT, in px at 96dpi. Whole px: see the header — the
 * rounding is a twentieth of a millimetre and it keeps the page an integer
 * number of device-independent pixels, which is what the editor lays out in.
 */
export const PAPER: Record<SizeId, { width: number; height: number }> = {
  a4: { width: Math.round(210 * PX_PER_MM), height: Math.round(297 * PX_PER_MM) },   // 794 × 1123
  letter: { width: 8.5 * PX_PER_IN, height: 11 * PX_PER_IN },                        // 816 × 1056
  legal: { width: 8.5 * PX_PER_IN, height: 14 * PX_PER_IN },                         // 816 × 1344
};

/** Which named size this page is, either way up. Undefined = a custom size. */
export function matchSize(page: PageSpec): SizeId | undefined {
  const w = page.width, h = page.height;
  for (const id of Object.keys(PAPER) as SizeId[]) {
    const p = PAPER[id];
    if ((near(w, p.width) && near(h, p.height)) || (near(w, p.height) && near(h, p.width))) return id;
  }
  return undefined;
}
const near = (a: number, b: number) => Math.abs(a - b) <= 1;

export const orientationOf = (page: PageSpec): Orientation =>
  page.width > page.height ? 'landscape' : 'portrait';

/**
 * Turn the page. Landscape is not a separate size: it is the same sheet with
 * width and height exchanged, which is why this swaps rather than looking
 * anything up — a custom 300×500 page turns too.
 */
export function withOrientation(page: PageSpec, o: Orientation): PageSpec {
  if (orientationOf(page) === o) return { ...page };
  return { ...page, width: page.height, height: page.width };
}

/** Apply a named size, keeping the page's current orientation. */
export function withSize(page: PageSpec, id: SizeId, o = orientationOf(page)): PageSpec {
  const p = PAPER[id];
  return withOrientation({ ...page, width: p.width, height: p.height }, o);
}

/** PageSpec plus the two optional margins core does not know about yet. */
export interface PageGeom extends PageSpec {
  marginLeft?: number;
  marginRight?: number;
}
export interface Margins { top: number; right: number; bottom: number; left: number }

/** The four margins. Left and right fall back to `marginX` when absent. */
export function margins(page: PageSpec): Margins {
  const g = page as PageGeom;
  return {
    top: page.marginTop,
    bottom: page.marginBottom,
    left: g.marginLeft ?? page.marginX,
    right: g.marginRight ?? page.marginX,
  };
}

/**
 * Write four margins back.
 *
 * Symmetric margins are stored as `marginX` ALONE — the field every existing
 * file and every older build already understands. `marginLeft`/`marginRight`
 * appear only when the two sides genuinely differ (a bound document), so the
 * common page never depends on a field the core has not shipped yet.
 */
export function withMargins(page: PageSpec, m: Margins): PageGeom {
  const out: PageGeom = { ...(page as PageGeom), marginTop: m.top, marginBottom: m.bottom };
  if (near(m.left, m.right)) {
    out.marginX = Math.round(m.left);
    delete out.marginLeft;
    delete out.marginRight;
  } else {
    out.marginX = Math.round(Math.min(m.left, m.right));   // the fallback stays sane
    out.marginLeft = Math.round(m.left);
    out.marginRight = Math.round(m.right);
  }
  return out;
}

/** What is left for text once the margins have had their share. */
export function contentBox(page: PageSpec): { width: number; height: number } {
  const m = margins(page);
  return { width: page.width - m.left - m.right, height: page.height - m.top - m.bottom };
}

/** A page must leave at least this much room for text, each way. One inch. */
export const MIN_CONTENT = PX_PER_IN;
/** and the sheet itself must be at least this big, each way */
export const MIN_SHEET = 2 * PX_PER_IN;
export const MAX_SHEET = 48 * PX_PER_IN;

export type PageFault = 'sheet-small' | 'sheet-large' | 'no-width' | 'no-height';

/**
 * Is this page usable?
 *
 * Margins that leave no content area are REJECTED here rather than allowed to
 * reach pagination, where `bodyHeight` would go negative and the break loop
 * would place a page every zero pixels until its 2000-iteration guard fired.
 * The fault is returned as a CODE, not a sentence: this function is called from
 * a node rig with no locale, and the sentence belongs to the dialog.
 */
export function validatePage(page: PageSpec): { ok: true } | { ok: false; fault: PageFault } {
  if (!(page.width >= MIN_SHEET) || !(page.height >= MIN_SHEET)) return { ok: false, fault: 'sheet-small' };
  if (page.width > MAX_SHEET || page.height > MAX_SHEET) return { ok: false, fault: 'sheet-large' };
  const c = contentBox(page);
  if (c.width < MIN_CONTENT) return { ok: false, fault: 'no-width' };
  if (c.height < MIN_CONTENT) return { ok: false, fault: 'no-height' };
  return { ok: true };
}

/** The fault, said out loud. t() at call time, never frozen into a const. */
export function faultText(f: PageFault): string {
  switch (f) {
    case 'sheet-small': return t('That sheet is smaller than 2 inches — pick a bigger page.');
    case 'sheet-large': return t('That sheet is larger than any printer takes.');
    case 'no-width': return t('Those side margins leave no room for text.');
    default: return t('Those top and bottom margins leave no room for text.');
  }
}

// ─────────────────────────────────────────────────── paragraph properties

export type Align = 'left' | 'center' | 'right' | 'justify';
export const ALIGNS: readonly Align[] = ['left', 'center', 'right', 'justify'];

/** The properties a paragraph may carry, and a document may default. */
export interface ParaLayout {
  align?: Align;
  /** space before, px */
  sb?: number;
  /** space after, px */
  sa?: number;
  /** line spacing, as a multiple of the font size */
  lh?: number;
  /** first-line indent, px */
  ind?: number;
}
/** …plus the three that are page-breaking, not typography. */
export interface ParaFlags {
  keepNext?: true;
  keepTogether?: true;
  breakBefore?: true;
}
export type ParaProps = ParaLayout & ParaFlags;

/**
 * What the document means when a paragraph says nothing.
 *
 * These are the STYLESHEET's own values, restated as numbers so the resolver
 * has something to compare against. Justify is the default and stays it: the
 * Knuth–Plass line breaker is what makes justified text worth having, and a
 * word processor that defaults to ragged-right throws that away.
 */
export const DOC_DEFAULTS: Required<ParaLayout> = {
  align: 'justify',
  sb: 0,
  sa: 10,
  lh: 1.62,
  ind: Math.round(1.4 * 17 * 10) / 10,     // the stylesheet's 1.4em at 17px
};

const LAYOUT_KEYS = ['align', 'sb', 'sa', 'lh', 'ind'] as const;
const FLAG_KEYS = ['keepNext', 'keepTogether', 'breakBefore'] as const;

/** A block, read as layout properties. Core has not typed these yet. */
export const propsOf = (b: Block): ParaProps => b as unknown as ParaProps;
/** The document's own defaults, over the built-in ones. */
export const docLayout = (doc: TypeDoc): ParaLayout =>
  ((doc as { layout?: ParaLayout }).layout ?? {});

/** What actually applies to this paragraph: block over document over built-in. */
export function effective(doc: TypeDoc, b: Block): Required<ParaLayout> {
  const d = docLayout(doc), p = propsOf(b);
  const out = { ...DOC_DEFAULTS };
  for (const k of LAYOUT_KEYS) {
    const v = (p[k] ?? d[k]) as never;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** What the document says, where the block says nothing. */
export function docEffective(doc: TypeDoc): Required<ParaLayout> {
  const d = docLayout(doc);
  const out = { ...DOC_DEFAULTS };
  for (const k of LAYOUT_KEYS) {
    const v = d[k] as never;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Write properties onto a block — the one place absent-means-default is
 * enforced.
 *
 * A value equal to the document default is DELETED rather than stored, so a
 * paragraph only carries what makes it different. `undefined` in the patch
 * means "back to the default" and deletes too. Mutates, because it is called
 * inside store.commit on the live document.
 */
export function writeProps(doc: TypeDoc, b: Block, patch: Partial<ParaProps>): void {
  const target = b as unknown as Record<string, unknown>;
  const def = docEffective(doc);
  for (const k of LAYOUT_KEYS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === undefined || v === def[k]) delete target[k];
    else target[k] = v;
  }
  for (const k of FLAG_KEYS) {
    if (!(k in patch)) continue;
    if (patch[k]) target[k] = true; else delete target[k];
  }
}

/**
 * The document defaults, as custom properties for the paper element.
 *
 * Only what differs from the stylesheet is emitted, and `data-lay` is what
 * switches the appended rule block on — a document that never touched any of
 * this renders through the untouched original rules.
 */
export function docVars(doc: TypeDoc): Record<string, string> {
  const d = docLayout(doc);
  const out: Record<string, string> = {};
  if (d.align) out['--lay-align'] = d.align;
  if (d.lh !== undefined) out['--lay-lh'] = String(d.lh);
  if (d.sb !== undefined) out['--lay-sb'] = `${d.sb}px`;
  if (d.sa !== undefined) out['--lay-sa'] = `${d.sa}px`;
  if (d.ind !== undefined) out['--lay-ind'] = `${d.ind}px`;
  return out;
}

/** The page geometry, as the custom properties styles.css already reads. */
export function pageVars(page: PageSpec): Record<string, string> {
  const m = margins(page);
  return {
    '--page-w': `${page.width}px`,
    '--page-h': `${page.height}px`,
    '--mar-x': `${page.marginX}px`,
    '--mar-l': `${m.left}px`,
    '--mar-r': `${m.right}px`,
    '--mar-t': `${m.top}px`,
    '--mar-b': `${m.bottom}px`,
  };
}

/**
 * One paragraph's own overrides, as inline CSS.
 *
 * The BLOCK ALONE — no document, on purpose. What a paragraph does not say is
 * not its business, and baking the document default into every element is how
 * "change the document's alignment" stops working.
 *
 * `padding-top: 0` rides with `sb` because the stylesheet spaces consecutive
 * paragraphs with a `margin-top: -10px; padding-top: 10px` pair; overriding
 * only the margin would leave the padding behind and add 10px to whatever the
 * author asked for.
 */
export function blockStyle(b: Block): string {
  const p = propsOf(b);
  const out: string[] = [];
  if (p.align) out.push(`text-align:${p.align}`);
  if (p.lh !== undefined) out.push(`line-height:${p.lh}`);
  if (p.sb !== undefined) out.push(`margin-top:${p.sb}px`, 'padding-top:0');
  if (p.sa !== undefined) out.push(`margin-bottom:${p.sa}px`);
  if (p.ind !== undefined) out.push(`text-indent:${p.ind}px`);
  return out.join(';');
}

// ──────────────────────────────────────────────── the page-breaking hints

/** A line box as pagination measures it, tagged with the block it belongs to. */
export interface LineBox { top: number; bottom: number; id?: string }

/**
 * A unit a page break may fall between. Ordinary text gives one atom per LINE,
 * which is exactly the freedom pagination has today; a keep hint fuses lines,
 * or whole blocks, into one.
 */
export interface Atom {
  top: number;
  bottom: number;
  /** the lines inside, so an oversized atom can still be broken */
  lines: LineBox[];
  /** the author put a page break before this atom */
  forced: boolean;
}

/**
 * Group measured line boxes into break atoms.
 *
 * Reads the BODY for hints and the BOXES for geometry, and nothing else — no
 * DOM, so the interesting cases are testable in node. Boxes with no block id
 * (a stray text node) are treated as ordinary lines, which is the behaviour
 * pagination has today.
 */
export function atomize(body: readonly Block[], boxes: readonly LineBox[]): Atom[] {
  const prop = new Map<string, ParaProps>();
  const order = new Map<string, number>();
  body.forEach((b, i) => { prop.set(b.id, propsOf(b)); order.set(b.id, i); });

  // consecutive boxes of one block are a run; a box with no id is its own run
  type Run = { id?: string; lines: LineBox[] };
  const runs: Run[] = [];
  for (const box of boxes) {
    const last = runs[runs.length - 1];
    if (last && box.id && last.id === box.id) last.lines.push(box);
    else runs.push({ id: box.id, lines: [box] });
  }

  const atoms: Atom[] = [];
  for (let i = 0; i < runs.length; i++) {
    const group: Run[] = [runs[i]];
    let forced = !!(runs[i].id && prop.get(runs[i].id!)?.breakBefore);
    // keepNext fuses this run with the next — repeatedly, so a stack of
    // headings holds together. A break the author asked for WINS over a keep:
    // fusing across it would silently discard the break.
    while (i + 1 < runs.length) {
      const here = runs[i].id ? prop.get(runs[i].id!) : undefined;
      const next = runs[i + 1].id ? prop.get(runs[i + 1].id!) : undefined;
      if (!here?.keepNext || next?.breakBefore) break;
      group.push(runs[++i]);
    }
    const atomic = group.length > 1 ||
      !!(group[0].id && prop.get(group[0].id!)?.keepTogether);
    const lines = group.flatMap(r => r.lines);
    if (!lines.length) continue;
    if (atomic) {
      atoms.push({
        top: Math.min(...lines.map(l => l.top)),
        bottom: Math.max(...lines.map(l => l.bottom)),
        lines, forced,
      });
    } else {
      for (const l of lines) {
        atoms.push({ top: l.top, bottom: l.bottom, lines: [l], forced });
        forced = false;                     // only the first line carries it
      }
    }
  }
  return atoms;
}

/**
 * Where the page ends: the paper-space y of the first atom that will not fit
 * in `avail` starting from `start`, or Infinity if everything left fits.
 *
 * With no hints anywhere this is line-for-line the loop paginate.ts runs today,
 * which is the point — the hints are an addition, not a new pagination.
 *
 * The escape hatch: an atom that is taller than the whole page can never be
 * honoured, so when the overflowing atom is the one the page STARTS with, the
 * break falls at a line inside it. Without that, a keep-together paragraph
 * longer than a page would return `start` as the break and pagination would
 * emit zero-height pages until its guard tripped.
 */
export function breakY(atoms: readonly Atom[], start: number, avail: number): number {
  for (const a of atoms) {
    if (a.top < start - 0.5) continue;
    if (a.forced && a.top > start + 0.5) return a.top;
    if (a.bottom - start > avail) {
      if (a.top > start + 0.5) return a.top;
      for (const l of a.lines) {
        if (l.bottom - start > avail && l.top > start + 0.5) return l.top;
      }
      return Infinity;                      // not even one line fits; take it
    }
  }
  return Infinity;
}

// ═══════════════════════════════════════════════════════════════════ the UI
//
// Everything below touches the DOM. It is separated from the maths above by
// this line and by nothing else: the pure half is what the rig exercises, the
// impure half is what a browser needs, and neither imports anything of the
// other's.

/**
 * Icons, to the house recipe (icons.ts): a 24×24 box rendered at 16px, stroke
 * `currentColor` at width 2, round caps and joins. Declared HERE rather than in
 * icons.ts because a feature is meant to be one file plus one line in
 * registry.ts — the recipe is what must not drift, not the file it lives in.
 */
const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ALIGN_ICON: Record<Align, string> = {
  left: svg('<line x1="3" y1="5" x2="21" y2="5"/><line x1="3" y1="9.5" x2="15" y2="9.5"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="3" y1="18.5" x2="15" y2="18.5"/>'),
  center: svg('<line x1="3" y1="5" x2="21" y2="5"/><line x1="6" y1="9.5" x2="18" y2="9.5"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="6" y1="18.5" x2="18" y2="18.5"/>'),
  right: svg('<line x1="3" y1="5" x2="21" y2="5"/><line x1="9" y1="9.5" x2="21" y2="9.5"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="9" y1="18.5" x2="21" y2="18.5"/>'),
  justify: svg('<line x1="3" y1="5" x2="21" y2="5"/><line x1="3" y1="9.5" x2="21" y2="9.5"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="3" y1="18.5" x2="21" y2="18.5"/>'),
};

/**
 * The unit this reader measures in.
 *
 * navigator.language FIRST, `locale()` only as the fallback — and that order is
 * the bug this exists because of: `locale()` returns the resolved CATALOG
 * locale, and type ships one catalog, so every reader in the world resolves to
 * plain 'en' and a US reader was offered millimetres. The catalog a person
 * reads the chrome in and the paper their printer holds are different
 * questions.
 */
const readerUnit = (): Unit =>
  unitFor(globalThis.navigator?.language || locale());

const alignLabel = (a: Align): string => a === 'left' ? t('Left')
  : a === 'center' ? t('Centre') : a === 'right' ? t('Right') : t('Justified');

// ───────────────────────────────────────────── model → the live document DOM
//
// The editor renders blocks from the model and knows nothing about layout, so
// this pass puts the geometry and the per-paragraph styles onto what it drew.
// When core patch (2) lands, renderBlock does the per-block half at render time
// and this becomes the page-geometry half alone.

let painting = false;

export function applyToDom(doc: TypeDoc, host: HTMLElement): void {
  if (painting) return;
  painting = true;
  try {
    // geometry on :root — styles.css declares --page-w and friends there
    const root = document.documentElement;
    for (const [k, v] of Object.entries(pageVars(doc.page))) root.style.setProperty(k, v);

    // document defaults on the paper, plus the switch that engages the rules
    const vars = docVars(doc);
    for (const k of ['--lay-align', '--lay-lh', '--lay-sb', '--lay-sa', '--lay-ind']) {
      host.style.removeProperty(k);
    }
    for (const [k, v] of Object.entries(vars)) host.style.setProperty(k, v);
    if (Object.keys(vars).length) host.dataset.lay = '1'; else delete host.dataset.lay;

    // per-paragraph overrides
    const byId = new Map(doc.body.map(b => [b.id, b]));
    for (const el of Array.from(host.querySelectorAll<HTMLElement>('[data-id]'))) {
      const b = byId.get(el.dataset.id!);
      if (!b) continue;
      const style = blockStyle(b);
      if (style) el.setAttribute('style', style); else el.removeAttribute('style');
      if (propsOf(b).breakBefore) el.dataset.break = '1'; else delete el.dataset.break;
    }
  } finally { painting = false; }
}

/**
 * Keep the DOM in step.
 *
 * Two signals, because the editor re-renders for reasons the store never hears
 * about (a caret move that splits a block re-renders before it commits): the
 * store for model changes, a MutationObserver on the paper for renders. The
 * observer watches childList ONLY — this pass writes style ATTRIBUTES, which
 * are a different mutation type, so it cannot re-trigger itself.
 */
function watch(ctx: FeatureContext): void {
  const host = ctx.editor.host;
  const paint = () => applyToDom(ctx.store.doc, host);
  paint();
  ctx.store.on(paint);
  new MutationObserver(paint).observe(host, { childList: true, subtree: true });
}

// ───────────────────────────────────────────────────────── selection → model

/** The blocks the selection touches, in document order. */
function selectedIds(ctx: FeatureContext): string[] {
  const host = ctx.editor.host;
  const sel = getSelection();
  const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  if (r && !r.collapsed && host.contains(r.commonAncestorContainer)) {
    const hit = Array.from(host.querySelectorAll<HTMLElement>('[data-id]'))
      .filter(el => r.intersectsNode(el))
      .map(el => el.dataset.id!);
    if (hit.length) return hit;
  }
  const c = ctx.editor.caret();
  return c ? [c.id] : [];
}

/** The block the panel is showing — the first of the selection. */
function focusBlock(ctx: FeatureContext): Block | undefined {
  const [id] = selectedIds(ctx);
  return id ? ctx.store.block(id) : undefined;
}

/**
 * Apply paragraph properties to the selection — ONE undo step, whether it
 * lands on one paragraph or ninety.
 *
 * The caret is taken before and restored after, because refresh() re-renders
 * the whole body and a re-render is a new set of nodes with no selection in
 * them: without this, changing alignment silently ends text entry.
 */
function applyPara(ctx: FeatureContext, patch: Partial<ParaProps>): void {
  const ids = selectedIds(ctx);
  if (!ids.length) { ctx.toast(t('Put the caret in a paragraph first')); return; }
  const set = new Set(ids);
  const caret = ctx.editor.caret();
  ctx.store.breakRun();
  ctx.store.commit(d => {
    for (const b of d.body) if (set.has(b.id)) writeProps(d, b, patch);
  });
  ctx.refresh();
  ctx.editor.setCaret(caret);
}

/** Toggle the author's page break on the paragraph the caret is in. */
function togglePageBreak(ctx: FeatureContext): void {
  const b = focusBlock(ctx);
  if (!b) { ctx.toast(t('Put the caret in a paragraph first')); return; }
  const on = !propsOf(b).breakBefore;
  if (on && ctx.store.doc.body[0]?.id === b.id) {
    // a break before the first paragraph would start the document on page 2
    ctx.toast(t('The first paragraph already starts a page'));
    return;
  }
  applyPara(ctx, { breakBefore: on ? true : undefined });
  ctx.toast(on ? t('Page break inserted') : t('Page break removed'));
}

// ────────────────────────────────────────────────────────── page setup dialog

const el = (tag: string, cls?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

/**
 * Page setup — size, orientation, the four margins, and the document's
 * paragraph defaults.
 *
 * The defaults live here rather than in the paragraph panel because that is
 * what they are: a property of the DOCUMENT, changed once, followed by every
 * paragraph that never overrode it. Applying is a single commit, so the whole
 * dialog is one press of ⌘Z — a page resize that took three undos to put back
 * would be a trap, since it moves every page break in the file.
 */
export function openPageSetup(ctx: FeatureContext): void {
  const unit = readerUnit();
  const start = ctx.store.doc.page as PageGeom;
  let page: PageGeom = { ...start };
  let defaults: ParaLayout = { ...docLayout(ctx.store.doc) };

  const back = el('div', 't-overlay');
  const card = el('div', 't-dlg');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', t('Page setup'));
  const close = () => back.remove();

  const h = (text: string) => { const n = el('h2', 't-dlg-h'); n.textContent = text; return n; };
  const row = (labelText: string, ...nodes: HTMLElement[]) => {
    const r = el('div', 't-row');
    const s = el('span');
    s.textContent = labelText;
    r.append(s, ...nodes);
    return r;
  };
  const num = (value: number, on: (v: number) => void) => {
    const i = el('input', 't-input') as HTMLInputElement;
    i.type = 'text';
    i.inputMode = 'decimal';
    i.value = formatLen(value, unit);
    i.addEventListener('input', () => {
      const px = parseLen(i.value, unit);
      if (px !== null) { on(px); sync(); }
    });
    return i;
  };
  const select = (options: Array<[string, string]>, value: string, on: (v: string) => void) => {
    const s = el('select', 't-select') as HTMLSelectElement;
    for (const [v, label] of options) {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      s.append(o);
    }
    s.value = value;
    s.addEventListener('change', () => { on(s.value); sync(); });
    return s;
  };

  // ---- size and orientation
  const sizeSel = select(
    [['a4', 'A4'], ['letter', t('US Letter')], ['legal', t('US Legal')], ['custom', t('Custom')]],
    matchSize(page) ?? 'custom',
    v => {
      if (v === 'custom') return;
      page = { ...page, ...withSize(page, v as SizeId) };
      wIn.value = formatLen(page.width, unit);
      hIn.value = formatLen(page.height, unit);
    });
  const orientSel = select(
    [['portrait', t('Portrait')], ['landscape', t('Landscape')]],
    orientationOf(page),
    v => {
      page = { ...page, ...withOrientation(page, v as Orientation) };
      wIn.value = formatLen(page.width, unit);
      hIn.value = formatLen(page.height, unit);
    });
  const wIn = num(page.width, v => { page = { ...page, width: Math.round(v) }; });
  const hIn = num(page.height, v => { page = { ...page, height: Math.round(v) }; });

  // ---- margins
  const m0 = margins(page);
  const set = (k: keyof Margins) => (v: number) => {
    page = withMargins(page, { ...margins(page), [k]: Math.round(v) });
  };
  const mt = num(m0.top, set('top'));
  const mb = num(m0.bottom, set('bottom'));
  const ml = num(m0.left, set('left'));
  const mr = num(m0.right, set('right'));

  // ---- document paragraph defaults
  const eff = docEffective(ctx.store.doc);
  const alignSel = select(ALIGNS.map(a => [a, alignLabel(a)] as [string, string]), eff.align,
    v => { defaults = { ...defaults, align: v as Align }; });
  const lhSel = select(
    [['1', '1.0'], ['1.15', '1.15'], ['1.5', '1.5'], ['1.62', t('Book (1.62)')], ['2', '2.0']],
    String(eff.lh), v => { defaults = { ...defaults, lh: Number(v) }; });

  const readout = el('p', 't-note');
  const err = el('p', 't-note t-bad');
  const apply = el('button', 't-btn t-primary') as HTMLButtonElement;

  function sync() {
    sizeSel.value = matchSize(page) ?? 'custom';
    orientSel.value = orientationOf(page);
    const check = validatePage(page);
    const c = contentBox(page);
    readout.textContent = t('Text area: {w} × {h} {unit}', {
      w: formatLen(c.width, unit), h: formatLen(c.height, unit),
      unit: unit === 'in' ? t('in') : t('mm'),
    });
    err.textContent = check.ok ? '' : faultText(check.fault);
    err.hidden = check.ok;
    apply.disabled = !check.ok;
  }

  apply.textContent = t('Apply');
  apply.addEventListener('click', () => {
    if (!validatePage(page).ok) return;
    const caret = ctx.editor.caret();
    ctx.store.breakRun();
    // ONE commit: geometry and defaults land together, so ⌘Z puts the document
    // back exactly as it was — including every page break this moved.
    ctx.store.commit(d => {
      d.page = page as PageSpec;
      const keep: ParaLayout = {};
      for (const [k, v] of Object.entries(defaults)) {
        if (v !== undefined && v !== DOC_DEFAULTS[k as keyof ParaLayout]) {
          (keep as Record<string, unknown>)[k] = v;
        }
      }
      if (Object.keys(keep).length) (d as { layout?: ParaLayout }).layout = keep;
      else delete (d as { layout?: ParaLayout }).layout;
    });
    ctx.refresh();
    ctx.editor.setCaret(caret);
    close();
  });

  const cancel = el('button', 't-btn');
  cancel.textContent = t('Cancel');
  cancel.addEventListener('click', close);

  card.append(
    h(t('Page')),
    row(t('Size'), sizeSel, orientSel),
    row(unit === 'in' ? t('Width × height (in)') : t('Width × height (mm)'), wIn, hIn),
    h(t('Margins')),
    row(unit === 'in' ? t('Top / bottom (in)') : t('Top / bottom (mm)'), mt, mb),
    row(unit === 'in' ? t('Left / right (in)') : t('Left / right (mm)'), ml, mr),
    readout, err,
    h(t('Paragraph defaults')),
    row(t('Alignment'), alignSel),
    row(t('Line spacing'), lhSel),
  );
  const note = el('p', 't-note');
  note.textContent = t('Paragraphs follow these unless they say otherwise.');
  card.append(note);
  const foot = el('div', 't-dlg-foot');
  foot.append(cancel, apply);
  card.append(foot);
  sync();

  back.append(card);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  document.body.append(back);
  (sizeSel as HTMLSelectElement).focus();
}

// ─────────────────────────────────────────────────────────── the panel
//
// Paragraph properties live in a PANEL rather than a dialog: they are adjusted
// while looking at the paragraph, and a modal over the page hides the one thing
// the author is judging the change by.

function mountPanel(host: HTMLElement, ctx: FeatureContext): void {
  // NO title of its own: the first group below is already "Paragraph", and
  // adding a section header above it printed the word twice in a row.
  watch(ctx);
  const unit = readerUnit();
  const wrap = el('div', 't-lay');

  const group = (title: string, ...nodes: HTMLElement[]) => {
    const g = el('div', 't-lay-g');
    const hd = el('div', 't-lay-h');
    hd.textContent = title;
    g.append(hd, ...nodes);
    return g;
  };

  // alignment
  const alignRow = el('div', 't-lay-row');
  const alignBtns = ALIGNS.map(a => {
    const b = el('button', 't-btn') as HTMLButtonElement;
    b.type = 'button';
    b.innerHTML = ALIGN_ICON[a];
    b.title = alignLabel(a);
    b.addEventListener('mousedown', e => { e.preventDefault(); applyPara(ctx, { align: a }); });
    alignRow.append(b);
    return [a, b] as const;
  });

  const field = (labelText: string, suffix: string, read: (b: Block) => string,
                 write: (v: number | undefined) => Partial<ParaProps>) => {
    const r = el('div', 't-lay-row');
    const l = el('label');
    l.textContent = labelText;
    const i = el('input', 't-input') as HTMLInputElement;
    i.type = 'text';
    i.inputMode = 'decimal';
    i.addEventListener('change', () => {
      const raw = i.value.trim();
      const v = raw === '' ? undefined : Number(raw.replace(',', '.'));
      applyPara(ctx, write(v !== undefined && Number.isFinite(v) ? v : undefined));
    });
    const s = el('span', 't-lay-unit');
    s.textContent = suffix;
    r.append(l, i, s);
    return { row: r, input: i, read };
  };

  const before = field(t('Space before'), t('pt'),
    b => trim(effective(ctx.store.doc, b).sb / PX_PER_PT),
    v => ({ sb: v === undefined ? undefined : v * PX_PER_PT }));
  const after = field(t('Space after'), t('pt'),
    b => trim(effective(ctx.store.doc, b).sa / PX_PER_PT),
    v => ({ sa: v === undefined ? undefined : v * PX_PER_PT }));
  const indent = field(t('First line'), unit === 'in' ? t('in') : t('mm'),
    b => formatLen(effective(ctx.store.doc, b).ind, unit),
    v => ({ ind: v === undefined ? undefined : fromUnit(v, unit) }));

  const lineSel = el('select', 't-select') as HTMLSelectElement;
  for (const [v, label] of [['1', '1.0'], ['1.15', '1.15'], ['1.5', '1.5'],
                            ['1.62', t('Book (1.62)')], ['2', '2.0']] as Array<[string, string]>) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    lineSel.append(o);
  }
  lineSel.addEventListener('change', () => applyPara(ctx, { lh: Number(lineSel.value) }));
  const lineRow = el('div', 't-lay-row');
  const lineLabel = el('label');
  lineLabel.textContent = t('Line spacing');
  lineRow.append(lineLabel, lineSel);

  const check = (labelText: string, key: keyof ParaFlags, hint: string) => {
    const l = el('label', 't-lay-check');
    const i = el('input') as HTMLInputElement;
    i.type = 'checkbox';
    i.addEventListener('change', () =>
      applyPara(ctx, { [key]: i.checked ? true : undefined } as Partial<ParaProps>));
    const s = document.createElement('span');
    s.textContent = labelText;
    l.append(i, s);
    l.title = hint;
    return { label: l, input: i, key };
  };
  const keepNext = check(t('Keep with next'), 'keepNext',
    t('This paragraph and the one after it stay on the same page.'));
  const keepTogether = check(t('Keep together'), 'keepTogether',
    t('This paragraph is never split across a page break.'));
  const breakBefore = check(t('Page break before'), 'breakBefore',
    t('Start this paragraph on a new page.'));

  const reset = el('button', 't-btn') as HTMLButtonElement;
  reset.type = 'button';
  reset.textContent = t('Use document defaults');
  reset.addEventListener('mousedown', e => {
    e.preventDefault();
    applyPara(ctx, { align: undefined, sb: undefined, sa: undefined, lh: undefined, ind: undefined });
  });

  // The page-size summary, and ONLY the summary. The "Page setup…" button that
  // used to sit beside it, under a second "Document" heading, is gone: page
  // size and orientation are rows in the props panel's Document section now,
  // and repeating the entry point here printed "Document" twice in one panel.
  const summary = el('p', 't-hint');

  wrap.append(
    group(t('Paragraph'), alignRow, lineRow, before.row, after.row, indent.row),
    group(t('Page breaking'), keepNext.label, keepTogether.label, breakBefore.label, summary),
  );
  const resetRow = el('div', 't-lay-row');
  resetRow.append(reset);
  wrap.insertBefore(resetRow, wrap.children[1]);
  host.append(wrap);

  /** Show what applies to the paragraph under the caret. */
  const refresh = () => {
    const b = focusBlock(ctx);
    const doc = ctx.store.doc;
    const e = b ? effective(doc, b) : docEffective(doc);
    for (const [a, btn] of alignBtns) btn.classList.toggle('on', e.align === a);
    lineSel.value = String(e.lh);
    if (document.activeElement !== before.input) before.input.value = b ? before.read(b) : '';
    if (document.activeElement !== after.input) after.input.value = b ? after.read(b) : '';
    if (document.activeElement !== indent.input) indent.input.value = b ? indent.read(b) : '';
    const p = b ? propsOf(b) : {};
    keepNext.input.checked = !!p.keepNext;
    keepTogether.input.checked = !!p.keepTogether;
    breakBefore.input.checked = !!p.breakBefore;
    const size = matchSize(doc.page);
    const c = contentBox(doc.page);
    summary.textContent = t('{size}, {orient} · text area {w} × {h} {unit}', {
      size: size ? size.toUpperCase() : t('Custom'),
      orient: orientationOf(doc.page) === 'portrait' ? t('Portrait') : t('Landscape'),
      w: formatLen(c.width, unit), h: formatLen(c.height, unit),
      unit: unit === 'in' ? t('in') : t('mm'),
    });
  };
  refresh();
  ctx.store.on(refresh);
  document.addEventListener('selectionchange', refresh);
}

const trim = (v: number): string => String(Math.round(v * 10) / 10);

// ─────────────────────────────────────────────────────────── registration

registerPanel({
  id: 'layout',
  // RIGHT: these are the properties of the selected paragraph, not a list of
  // what is in the document. The suite's rule, from dash/src/panels.ts.
  side: 'right',
  get label() { return t('Layout'); },
  order: 40,
  mount: mountPanel,
});

// Page setup is reached from the Document section of the properties panel;
// it is a property, not an action, and the ⋯ menu is for actions.

// NO ⋯ entry: "page break here" IS the breakBefore property, which is already
// a checkbox in the Page breaking group of this panel. Offering it twice, once
// as an action and once as a property, made the two look like different things.
// The keyboard shortcut stays — that is the fast path, not a second home.

// ⌘⏎ for the break and ⌘⇧L/E/R/J for alignment — the shortcuts every word
// processor has had for thirty years. A person should not have to learn ours.
registerKey({ key: 'enter', mod: true, run: togglePageBreak });
for (const [key, align] of [['l', 'left'], ['e', 'center'], ['r', 'right'], ['j', 'justify']] as const) {
  registerKey({ key, mod: true, shift: true, run: ctx => applyPara(ctx, { align }) });
}
