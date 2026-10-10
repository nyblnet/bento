// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// ─────────────────────────────────────────────────────────────────────────────
// MATHEMATICS for bento/type — a hand-rolled TeX-subset typesetter.
// ─────────────────────────────────────────────────────────────────────────────
//
// NO DEPENDENCY, ON PURPOSE. KaTeX is ~280KB of JS plus 60 font files; MathJax
// is larger still. This app ships as ONE HTML file that a person emails to
// somebody, and a maths engine may not be half of it. So the layout is done
// here, in about a thousand lines, and the glyphs come from whatever serif the
// reader already has. That last part is the real cost of the choice and it is
// stated plainly below.
//
// ═══ WHAT IS SUPPORTED ══════════════════════════════════════════════════════
//
//   structure   ^ _ (both orders, nested, primes `x''`), { } grouping,
//               \frac \dfrac \tfrac \cfrac \binom, \sqrt and \sqrt[n]{},
//               \left…\right with . as the null delimiter, \big \Big \bigg
//               \Bigg (accepted, set at natural size), \overline \underline
//   operators   \sum \prod \coprod \int \iint \iiint \oint \bigcup \bigcap
//               \bigoplus \bigotimes \bigvee \bigwedge \bigsqcup \biguplus —
//               with LIMITS above/below in display style for the \sum family
//               and beside the sign for the \int family, as TeX does
//   functions   \sin \cos \tan \cot \sec \csc \arcsin \arccos \arctan \sinh
//               \cosh \tanh \coth \log \ln \lg \exp \det \dim \deg \arg \ker
//               \hom \Pr \gcd \lim \limsup \liminf \max \min \sup \inf
//   symbols     the full Greek alphabet incl. \var- forms; ~120 operators,
//               relations, arrows and ordinary symbols (see math/symbols.ts)
//   fences      ( ) [ ] \{ \} | \| ⟨ ⟩ ⌈ ⌉ ⌊ ⌋ / ↑ ↓, stretched to their content
//   accents     \hat \widehat \check \tilde \widetilde \acute \grave \dot
//               \ddot \breve \bar \vec \mathring
//   fonts       \mathrm \mathbf \mathit \mathsf \mathtt \boldsymbol
//               \operatorname, and \mathbb \mathcal \mathfrak as UNICODE
//               transliterations (there is no font to ship)
//   text        \text \textrm \textnormal \mbox
//   spacing     \, \: \; \! \quad \qquad \enspace and a literal `\ `
//   styles      \displaystyle \textstyle \scriptstyle \scriptscriptstyle
//   environments  matrix pmatrix bmatrix Bmatrix vmatrix Vmatrix cases
//               aligned array  (rows with \\, cells with &)
//
// ═══ WHAT IS NOT ════════════════════════════════════════════════════════════
//
//   · MACROS. No \newcommand, \def, \renewcommand. A document that can define
//     its own commands needs an expansion engine with its own loop guards, and
//     the whole point of this module is that it cannot hang the page.
//   · NUMBERED EQUATIONS, \label, \ref, \tag, and the `align`/`equation`
//     environments that carry them. Numbering is a DOCUMENT concern — it has to
//     interact with pagination, the outline and cross-references — and it
//     belongs in the core beside footnote numbering, not inside a formula
//     renderer. `aligned` (the inner form, unnumbered) is supported.
//   · \overbrace \underbrace \substack \not \mathchoice \genfrac \raisebox,
//     colour and size commands, \begin{tabular}, and TeX programming.
//   · LINE BREAKING INSIDE A FORMULA. A long display equation does not wrap; it
//     runs on. TeX breaks at relations with an author's hints, which needs the
//     line width, which this renderer deliberately does not know.
//   · A MATHS FONT. \mathbb{R} is U+211D, not a rendered glyph from a shipped
//     font, so exotic symbols look like whatever the reader's system has and a
//     few may show as a missing-glyph box. This is the price of one file.
//
// Anything unsupported RENDERS AS AN ERROR IN PLACE — the offending source, in
// the error colour, with a tooltip — never as an exception and never as a blank
// document. See math/parse.ts for why that is the only acceptable behaviour.
//
// ═══ HOW MATH FITS THE MODEL, AND WHY ═══════════════════════════════════════
//
// THE SOURCE IS THE MODEL. Nothing rendered is ever stored: a block holds
// `\frac{a}{b}`, and this module turns that into markup on every render. That
// is not negotiable — rendered output in the document would be a second
// representation to keep in step with the first, and the format has exactly one
// of everything on purpose.
//
// INLINE MATH IS A MARK over the source characters (MarkType 'math'), NOT an
// atom like the footnote marker. The prompt for this feature offered both, and
// the mark wins on all four of the things the app is actually built around:
//
//   1. REDLINE. The redline diffs plain text word by word. With the source in
//      the text, changing `x^2` to `x^3` reports as a one-word change to the
//      formula — reviewable. As an atom with the source held off to the side
//      (the footnote arrangement), the diff would see NO CHANGE AT ALL: the
//      text either side is identical and the marker is in the same place. For
//      an app whose differentiator is redlining contracts, a class of edit that
//      is invisible to review is disqualifying.
//   2. SIGNATURES. canon.ts canonicalises text + marks. A mark is already
//      canonicalised; a side table of formulas would be a new field to fold in,
//      and every new field is a new chance for two honest parties to produce
//      different bytes.
//   3. THE CARET is (blockId, offset). With the source in the text, a formula
//      occupies exactly as many model positions as it has source characters,
//      so every offset after it is a real offset and `spliceText` moves marks
//      and footnote anchors past it with the code that already exists.
//   4. FOOTNOTE ANCHORS and marks already use one rule for "an offset into this
//      text". Math uses the same one. No third concept.
//
//   The cost is that a formula is not one keystroke wide: with the naive core
//   the caret would walk through the source characters invisibly. That is what
//   the editor patch below is for — the rendered formula is
//   `contenteditable=false`, and the caret treats it as one indivisible unit of
//   N characters. N is the source length, so the MODEL arithmetic is unchanged;
//   only the visible stepping is.
//
// DISPLAY MATH IS A BLOCK KIND ('math'), whose `text` is the source. A display
// equation is a paragraph-level object: it is centred, it takes the whole
// measure, it can be a page break's target, and the outline and the redline
// should be able to name it. Every one of those is what a BlockKind is for, and
// none of them is expressible by a mark. The block stays FLAT — no new
// container, no tree — exactly as `ul` and `cell` do.
//
// THE PAGINATION TRAP, AND WHAT WAS DONE ABOUT IT. paginate.ts measures LINE
// BOXES with a TreeWalker over TEXT NODES, and rejects nodes whose value is
// whitespace. An element containing no text is therefore INVISIBLE to
// pagination: it would occupy vertical space on screen that the page breaks
// know nothing about, and every page after it would break in the wrong place.
// A formula normally contains plenty of text — the glyphs ARE text nodes, which
// is one more reason this renderer emits HTML rather than SVG — but not always:
// `\sqrt{}` while it is being typed, `\frac{}{}` from a generator, an empty
// matrix cell. So every empty slot is filled with U+200B (see layout.ts ZW),
// which is a text node, is NOT whitespace to `String.trim` (checked: it
// survives the walker's filter), and prints nothing. The atom wrapper carries
// one too, so a formula can never be a zero-text element.
//   The remaining honest limitation: a tall inline formula reports its own
// parts' rects to the walker, so a page CAN break inside one. Display math is a
// block and does not have this problem; it is the right shape for anything tall
// enough to care.
//
// ═══ NEEDS FROM THE CORE ════════════════════════════════════════════════════
//
// This module is complete and testable without any of the following —
// `renderMath`, `inlineMathHtml` and `displayMathHtml` are pure functions of a
// string. These six edits are what connects it to the document.
//
// (1) type/src/inline.ts — one word.
//        export type MarkType = 'b' | 'i' | 'u' | 's' | 'code' | 'link' | 'math';
//     WHY: the mark is how a run of text is known to be a formula. `math` has
//     no entry in TAG because it is never emitted as a plain tag; see (2).
//
// (2) type/src/inline.ts — `toHtml` gains a fourth parameter, ranges whose text
//     is replaced wholesale:
//
//        export function toHtml(text: string, marks: Mark[] = [],
//                               inject?: Map<number, string>,
//                               atoms?: Array<{ from: number; to: number; html: string }>): string
//
//     Implementation: add each atom's `from`/`to` to the cut set; while walking,
//     when the current point is an atom's `from`, emit its `html`, skip to `to`,
//     and emit no marks or injections inside it. ~8 lines. inline.ts learns
//     NOTHING about math — the caller supplies the html — which is the same
//     arrangement `inject` already has for footnote markers.
//     WHY: without it the source characters render as literal text.
//
// (3) type/src/inline.ts — `fromDom` learns that an atom may carry characters:
//
//        export function fromDom(root: Node,
//                                isAtom: (el: Element) => boolean = () => false,
//                                atomText?: (el: Element) => { text: string; t: MarkType } | undefined): Parsed
//
//     When `atomText` returns a value for an atom element, append its `text` to
//     the running text and push a mark of type `t` over it, instead of
//     recording a zero-width atom. ~6 lines.
//     WHY: this is the seam where the DOM re-enters the model. Without it the
//     first keystroke anywhere in a block would delete every formula in it,
//     because the read-back would find no characters where the source was.
//
// (4) type/src/render.ts — three small things:
//        · `TAG` gains `math: 'div'`
//        · `blockHtml(b)`:
//             if (b.kind === 'math') return displayMathHtml(b.text);
//             const atoms = (b.marks ?? []).filter(m => m.t === 'math')
//               .map(m => ({ from: m.from, to: m.to,
//                            html: inlineMathHtml(b.text.slice(m.from, m.to)) }));
//             …pass `atoms` as toHtml's fourth argument
//        · `isMathAtom = (el: Element) => el.tagName === 'SPAN' &&
//                        el.classList.contains('t-math')`, and `readBlock`
//          passes `isNoteAtom(el) || isMathAtom(el)` as `isAtom` plus an
//          `atomText` that returns `{ text: el.dataset.tex, t: 'math' }` for a
//          math atom. `import { displayMathHtml, inlineMathHtml } from './math.ts'`
//     WHY: one renderer draws the editor, the thumbnails and print, so this is
//     also all that print.ts needs — it goes through `blockHtml` and `TAG`.
//
// (5) type/src/model.ts — `'math'` joins `BlockKind` and the kind allow-list in
//     `parseDoc` (the array literal in the same place). Nothing else: a math
//     block has no new fields, its source is `text`, so `spliceText`,
//     `plainText`, `wordCount` and the canonical form all already handle it.
//     WHY: without it a saved display equation is REPAIRED BACK to a paragraph
//     on the next open, silently, which is a data-loss bug.
//
// (6) type/src/editor.ts — the caret steps over a formula rather than through
//     it. In `#offsetIn`, an element for which `isMathAtom` holds contributes
//     `el.dataset.tex.length` characters and is not descended into; in
//     `#pointAt`, the same element is skipped with its length added, so a
//     position inside it resolves to its near edge. ~8 lines across the two
//     walks, mirroring exactly what they already do for note atoms — the only
//     difference is that a note contributes 0 characters and a formula
//     contributes its source length.
//     WHY: without it the caret sits at invisible positions inside a rendered
//     formula and arrow keys appear to stall.
//
// Optional, not needed for correctness: a "Equation" entry in main.ts's block
// style select, so display math is reachable from the same place as headings.

import { registerKey, registerPanel, registerTool,
         type FeatureContext } from './features.ts';
import { t } from './i18n.ts';
import { spliceText, uid, type Block } from './model.ts';
import { renderMath, ZW } from './math/layout.ts';
import type { Mark } from './inline.ts';

export { parseMath } from './math/parse.ts';
export { renderMath, layoutMath } from './math/layout.ts';
export type { MathNode } from './math/parse.ts';
export type { Box } from './math/layout.ts';

/**
 * The mark type and block kind this module needs from the core (edits 1 and 5).
 *
 * Named constants rather than literals so that the day the core patch lands,
 * every use of them typechecks against the real union instead of being spelled
 * out in six places.
 */
export const MATH_MARK = 'math';
export const MATH_KIND = 'math';

/** Is this mark a formula? Written against the string so it compiles today. */
export const isMathMark = (m: Mark): boolean => (m.t as string) === MATH_MARK;

/**
 * A math mark.
 *
 * The cast is the ONE place this module admits that core edit (1) has not
 * landed yet: `MarkType` does not include 'math', so the object cannot be typed
 * as a `Mark` without it. When the union gains the member this becomes an
 * ordinary literal and the helper can go. It is deliberately a single function
 * rather than a cast at each call site, so applying the patch is a one-line
 * cleanup and not a hunt.
 */
const mathMark = (from: number, to: number): Mark =>
  ({ t: MATH_MARK, from, to } as unknown as Mark);

// ───────────────────────────────────────────────────────────── the renderers

/**
 * One inline formula, as the ATOM the core will embed (core edits 2 and 4).
 *
 * `data-tex` carries the SOURCE — it is what `fromDom` reads back, so the
 * rendered glyphs are never what re-enters the model. `contenteditable=false`
 * keeps the browser from letting the caret inside a box whose structure has no
 * model position, and the leading U+200B guarantees the element contains a text
 * node whatever the formula turns out to be (see the pagination note above).
 */
export function inlineMathHtml(src: string): string {
  const r = renderMath(src, { display: false });
  const bad = r.errors.length ? ' t-math-bad' : '';
  return `<span class="t-math${bad}" data-tex="${attr(src)}" contenteditable="false">` +
         `${ZW}${r.html}</span>`;
}

/**
 * One display equation, as the INNER html of a `math` block (core edit 4).
 *
 * The block element itself is created by render.ts from `TAG`, exactly as a
 * paragraph is, so the model stays flat and nothing downstream has to learn
 * what an equation is.
 */
export function displayMathHtml(src: string): string {
  const r = renderMath(src, { display: true });
  const bad = r.errors.length ? ' t-math-bad' : '';
  return `<span class="t-math t-math-display${bad}" data-tex="${attr(src)}">${ZW}${r.html}</span>`;
}

const attr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Everything the parser objected to, for the panel's error line. */
export const mathErrors = (src: string, display = false): string[] =>
  renderMath(src, { display }).errors;

// ───────────────────────────────────────────────────────────── editing

/** The math mark under the caret, if the caret is in a formula. */
function formulaAt(ctx: FeatureContext): { block: Block; mark: Mark } | null {
  const c = ctx.editor.caret();
  if (!c) return null;
  const block = ctx.store.block(c.id);
  if (!block?.marks) return null;
  const at = c.to !== undefined ? Math.min(c.at, c.to) : c.at;
  const mark = block.marks.find(m => isMathMark(m) && at >= m.from && at <= m.to);
  return mark ? { block, mark } : null;
}

/** The default a fresh formula starts from — short, valid, and obviously math. */
const SEED = 'x^2 + y^2 = z^2';

/**
 * Insert an inline formula, or turn the selection into one.
 *
 * Turning a SELECTION into a formula matters more than it looks: it is how a
 * document that already contains `E = mc^2` as ordinary text becomes one where
 * that is typeset, without retyping it. The characters do not move — only the
 * mark is added — so the redline of that edit is empty, which is correct: the
 * words did not change.
 */
export function insertInlineMath(ctx: FeatureContext): void {
  const c = ctx.editor.caret();
  if (!c) { ctx.toast(t('Put the caret where the formula should go')); return; }
  const block = ctx.store.block(c.id);
  if (!block) return;
  const has = c.to !== undefined && c.to !== c.at;
  const from = has ? Math.min(c.at, c.to!) : c.at;
  const to = has ? Math.max(c.at, c.to!) : c.at;

  ctx.store.commit(d => {
    const i = d.body.findIndex(b => b.id === c.id);
    if (i < 0) return;
    let b = d.body[i];
    let end = to;
    if (!has) {
      b = spliceText(b, from, 0, SEED);
      end = from + SEED.length;
    }
    const marks = (b.marks ?? []).filter(m => !isMathMark(m) || m.to <= from || m.from >= end);
    marks.push(mathMark(from, end));
    b.marks = marks.sort((x, y) => x.from - y.from);
    d.body[i] = b;
  }, { scope: { block: c.id } });
  ctx.refresh();
  ctx.toast(t('Formula added — edit it in the Math panel'));
}

/**
 * Insert a display equation as its own block.
 *
 * An empty paragraph at the caret is CONSUMED rather than left above the
 * equation, which is the same rule `insertTable` uses — pressing Enter and then
 * inserting should not leave a blank line behind.
 */
export function insertDisplayMath(ctx: FeatureContext): void {
  const c = ctx.editor.caret();
  const body = ctx.store.doc.body;
  const i = c ? body.findIndex(b => b.id === c.id) : body.length - 1;
  const here = body[Math.max(0, i)];
  const block = { id: uid(), kind: MATH_KIND, text: SEED } as unknown as Block;
  ctx.store.commit(d => {
    const at = here && here.text === '' && here.kind === 'para' ? i : i + 1;
    const drop = here && here.text === '' && here.kind === 'para' ? 1 : 0;
    d.body.splice(Math.max(0, at), drop, block);
  });
  ctx.refresh();
  ctx.toast(t('Equation added — edit it in the Math panel'));
}

/** Rewrite the source of the formula at the caret. */
function setSource(ctx: FeatureContext, id: string, from: number, to: number, src: string): void {
  ctx.store.commit(d => {
    const i = d.body.findIndex(b => b.id === id);
    if (i < 0) return;
    const b = spliceText(d.body[i], from, to - from, src);
    const marks = (b.marks ?? []).filter(m => !isMathMark(m) || m.to <= from || m.from >= from + src.length);
    marks.push(mathMark(from, from + src.length));
    b.marks = marks.sort((x, y) => x.from - y.from);
    d.body[i] = b;
  }, { scope: { block: id } });
  ctx.refresh();
}

// ───────────────────────────────────────────────────────────── the chrome

/** House recipe, character for character with icons.ts: 24px box, 16px render. */
const RADICAL_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round"><path d="M3 13h3l3.5 7L14 4h7"/></svg>';

registerTool({
  id: 'math',
  icon: RADICAL_ICON,
  get title() { return t('Formula (⌘M)'); },
  group: 'insert',
  label: () => t('Formula'),
  order: 40,
  run: ctx => insertInlineMath(ctx),
});

// A display equation is a SECOND kind of insert, not an action — it puts
// something in the document, so it belongs beside Formula in the Insert menu
// rather than in ⋯ where it was competing with Print and Sign.
registerTool({
  id: 'math-display',
  icon: RADICAL_ICON,
  get title() { return t('Insert a display equation on its own line'); },
  group: 'insert',
  label: () => t('Equation block'),
  order: 41,
  run: ctx => insertDisplayMath(ctx),
});

registerKey({ key: 'm', mod: true, run: ctx => insertInlineMath(ctx) });

/**
 * The Math panel: the source of the formula under the caret, and what it looks
 * like as you type it.
 *
 * A live preview is not decoration here. TeX is a language, the reader of this
 * app is not required to know it, and the difference between `x^10` and
 * `x^{10}` is invisible in the source and obvious in the preview. The panel
 * also renders the ERRORS, which is where an unsupported command gets
 * explained rather than silently ignored.
 */
registerPanel({
  id: 'math',
  get label() { return t('Math'); },
  // RIGHT, not left: this panel edits the SOURCE OF THE FORMULA UNDER THE
  // CARET, which is a property of the selection, not a list of what is in the
  // document. It sat on the left only because that was where panels went.
  side: 'right',
  order: 60,
  mount(host, ctx) {
    host.innerHTML = '';
    const hint = document.createElement('p');
    hint.className = 't-hint';
    host.appendChild(hint);

    const area = document.createElement('textarea');
    area.className = 't-mathsrc';
    area.rows = 3;
    area.spellcheck = false;
    host.appendChild(area);

    const preview = document.createElement('div');
    preview.className = 't-mathprev';
    host.appendChild(preview);

    const errs = document.createElement('p');
    errs.className = 't-hint t-bad';
    host.appendChild(errs);

    const help = document.createElement('p');
    help.className = 't-hint';
    host.appendChild(help);

    // `current` is the formula the panel is editing, resolved on every update.
    // Held here rather than read back from the DOM so that a re-render between
    // keystrokes cannot make the panel write into the wrong block.
    let current: { id: string; from: number; to: number; display: boolean } | null = null;

    const draw = () => {
      const src = area.value;
      const r = renderMath(src, { display: !!current?.display });
      preview.innerHTML = `<span class="t-math${current?.display ? ' t-math-display' : ''}">${ZW}${r.html}</span>`;
      errs.textContent = r.errors.length ? r.errors.slice(0, 3).join(' · ') : '';
    };

    area.addEventListener('input', draw);
    area.addEventListener('change', () => {
      if (!current) return;
      const src = area.value;
      if (current.display) {
        ctx.store.commit(d => {
          const b = d.body.find(x => x.id === current!.id);
          if (b) b.text = src;
        }, { scope: { block: current.id } });
        current = { ...current, to: src.length };
        ctx.refresh();
      } else {
        setSource(ctx, current.id, current.from, current.to, src);
        current = { ...current, to: current.from + src.length };
      }
    });

    (host as HTMLElement & { _sync?: () => void })._sync = () => {
      hint.textContent = t('The formula at the caret. TeX-like source; the document stores the source, never the picture.');
      help.textContent = t('Supported: \\frac \\sqrt ^ _ \\sum \\int \\left( \\right) Greek, matrices, cases.');
      const c = ctx.editor.caret();
      const blk = c ? ctx.store.block(c.id) : undefined;
      if (blk && (blk.kind as string) === MATH_KIND) {
        current = { id: blk.id, from: 0, to: blk.text.length, display: true };
        if (document.activeElement !== area) area.value = blk.text;
        area.disabled = false;
      } else {
        const f = formulaAt(ctx);
        if (f) {
          current = { id: f.block.id, from: f.mark.from, to: f.mark.to, display: false };
          if (document.activeElement !== area) area.value = f.block.text.slice(f.mark.from, f.mark.to);
          area.disabled = false;
        } else {
          current = null;
          if (document.activeElement !== area) area.value = '';
          area.disabled = false;
        }
      }
      // HIDDEN when there is no formula at the caret. On the left this panel sat
      // behind a tab, so an empty one cost nothing; stacked on the right it is
      // always on screen, and a permanent "The formula at the caret" under a
      // contract that contains no mathematics is just noise. A contextual panel
      // that is never absent stops being contextual.
      host.hidden = current === null;
      draw();
    };
    (host as HTMLElement & { _sync?: () => void })._sync!();
    document.addEventListener('selectionchange', () => {
      // `.on` is a LEFT-hand tab class. Right-hand panels are stacked and never
      // carry it (.t-props .t-panel is display:block), so this guard was always
      // false after the panel moved and the source stopped following the caret
      // — it only refreshed when the document itself changed.
      if (host.isConnected) (host as HTMLElement & { _sync?: () => void })._sync!();
    });
  },
  update(host) {
    (host as HTMLElement & { _sync?: () => void })._sync?.();
  },
});
