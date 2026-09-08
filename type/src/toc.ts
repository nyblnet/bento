// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Section numbering and the table of contents.
//
// Both are DERIVED. Nothing this file computes — not a section number, not a
// page reference, not a TOC entry — is ever written into the document. That is
// the same rule the footnote markers already follow (render.ts numberNotes),
// and for the same reason: inserting one heading renumbers every heading after
// it, so a stored number is wrong the instant the author types. A stored PAGE
// number is worse: it is wrong when somebody else opens the file at a different
// zoom, or edits a paragraph twenty pages earlier.
//
// WHAT IS IN THE MODEL
//
//   · a `toc` block, whose stored `text` is only its HEADING ("Contents").
//     The entries are derived at render time and injected as an ATOM.
//   · `doc.sections = { numbered: boolean }` — a document-level switch. An
//     additive top-level field, preserved by parseDoc like any unknown key;
//     absent means ON, so "automatic" is what an author gets by default.
//   · `Block.role` on a heading, which the author already has, to opt out.
//
// KEEPING THE REDLINE QUIET — the constraint that shaped the whole design.
//
// The redline aligns on block ids and diffs plain text. A TOC block whose
// stored text was the LIST OF ENTRIES would change on every repagination, so
// every review of every document would open with "the table of contents
// changed" — the exact noise that makes line diffs useless on prose, and the
// reason a cell is a block. So:
//
//   · the TOC block's `text` is its heading and nothing else. Repaginating a
//     200-page contract cannot change one byte of the document JSON, which
//     also means it cannot invalidate a SIGNATURE (canon.ts digests the model).
//   · section numbers are injected as `[data-derived]` spans, which the core's
//     atom predicate skips exactly as it skips a footnote marker: they occupy a
//     position but no characters, so readBlock cannot type them into the model
//     and the caret cannot land inside one.
//   · the page-number column has a FIXED width and tabular figures. "9" → "10"
//     therefore moves nothing, so filling page numbers in AFTER pagination
//     cannot change the pagination it was derived from. That is what lets the
//     TOC update after pagination rather than before, with no fixpoint loop.
//
// A SKIPPED LEVEL — an h3 with no h2 above it — numbers as `1.0.1`.
//
// The alternative is to promote it and call it `1.1`, which is wrong twice: two
// different outlines then produce the same number, and the author is never told
// their document has a hole in it. The zero keeps the invariant that a number's
// depth equals its heading's level, which is what makes numbers comparable, and
// it makes the missing level visible. Word does the same. Filling the gap later
// turns 1.0.1 into 1.1.1 — a renumber, like any other.
//
// LEADING zeros are the one exception, and the rig is why. A document whose h1
// is its TITLE (role 'title' — the app's own picker calls h1 "Title") never
// opens level 1 at all, so every section came out `0.1`, `0.2`. A level the
// document has NOT USED above this point is not a hole in the sequence, it is
// a level the document does not have — so leading zeros are dropped and the
// sections read 1, 2, 3. An INTERIOR zero is a genuine hole and stays.
//
// NEEDS FROM THE CORE
// ═══════════════════
// Four small additions. Until they land this module registers its chrome and
// stays inert (the wiring below is soft — see `wire()`), so nothing breaks.
//
// 1. type/src/model.ts — the block kind.
//    · line ~20: add `'toc'` to the BlockKind union:
//        export type BlockKind = 'para' | 'h1' | ... | 'cell' | 'toc';
//    · in parseDoc, the kind whitelist (~line 207): add 'toc' to the array
//        ['para','h1','h2','h3','quote','ul','ol','cell','toc']
//    WHY: the TOC prints, so it has to be a block. Its content is derived, so
//    it needs no other model surface at all.
//
// 2. type/src/render.ts — three edits, all in existing functions.
//    a. TAG gains one entry:            toc: 'nav',
//    b. the atom predicate learns about derived content, so injected numbers
//       and entries can never be read back into the model (isNoteAtom is what
//       editor.ts and readBlock both use, so broadening it in place needs no
//       other call-site change):
//
//        export const isDerived = (el: Element) => el.hasAttribute('data-derived');
//        export const isNoteAtom = (el: Element) =>
//          (el.tagName === 'SUP' && el.classList.contains('t-note')) || isDerived(el);
//
//    c. a decorator hook in blockHtml, so ONE function serves the editor, the
//       thumbnail-free print path and pagination — they all go through it:
//
//        export type BlockDecorator = (b: Block, base: string) => string | null;
//        let decorator: BlockDecorator | null = null;
//        export const registerBlockDecorator = (d: BlockDecorator): void => { decorator = d; };
//
//       and in blockHtml, after `const html = toHtml(...)`:
//
//        const base = html || '<br>';
//        return decorator?.(b, base) ?? base;
//
//    WHY (c): print.ts builds a string and the editor builds DOM. Anything
//    derived that is emitted in only one of them is drift, which is the failure
//    print.ts exists to prevent — one hook below both is the only shape that
//    cannot drift.
//
// 3. type/src/features.ts — two registries, in the style of the others:
//
//      export type ReadyFn = (ctx: FeatureContext) => void;
//      export type PaginatedFn = (ctx: FeatureContext, metrics: Metrics, host: HTMLElement) => void;
//      const READY: ReadyFn[] = []; const PAGINATED: PaginatedFn[] = [];
//      export const registerReady = (f: ReadyFn): void => { READY.push(f); };
//      export const registerPaginated = (f: PaginatedFn): void => { PAGINATED.push(f); };
//      export const readyFns = (): ReadyFn[] => READY;
//      export const paginatedFns = (): PaginatedFn[] => PAGINATED;
//
//    (`import type { Metrics } from './paginate.ts'` — type-only, no cycle.)
//
// 4. type/src/main.ts — two lines that call them.
//    · at the BOTTOM of the file, immediately above the existing bare
//      `repaginate();` (the "boot is finished" line):
//        for (const fn of readyFns()) fn(featureCtx);
//    · at the END of `repaginate()`, after `paint()`:
//        for (const fn of paginatedFns()) fn(featureCtx, metrics, paper);
//
//    WHY: a feature needs two moments the registry does not yet offer — "the
//    chrome exists, here is your context" and "the pages have just been
//    measured". Page numbers are only knowable in the second one. Both are
//    general; find-and-replace will want the first, a running-header feature
//    the second.
//
//    WHERE, AND THIS BIT IS LOAD-BEARING — the ready call must go at the
//    BOTTOM, not beside the `for (const spec of panels())` loop where it
//    visually belongs. `featureCtx.refresh()` closes over `schedule`, a `const`
//    declared 70 lines further down, so calling it from the panels loop throws
//    "Cannot access 'schedule' before initialization" and the app boots to a
//    blank page. Verified by applying this patch locally and loading the app:
//    it happened, and it kills the whole editor, not just the feature.

import type { Metrics, Page } from './paginate.ts';
import type { Block, TypeDoc } from './model.ts';
import type { FeatureContext } from './features.ts';
import * as features from './features.ts';
import * as render from './render.ts';
import { t } from './i18n.ts';

// ───────────────────────────────────────────────────────────── pure: headings

export type HeadKind = 'h1' | 'h2' | 'h3';

/** Heading LEVEL comes from the block kind. The document stays flat. */
export const HEAD_LEVEL: Readonly<Record<string, number>> = { h1: 1, h2: 2, h3: 3 };
export const DEPTH = 3;

export const isHeading = (b: Block): boolean => HEAD_LEVEL[b.kind] !== undefined;

/**
 * The TOC block's kind, as a value.
 *
 * Written once, through the model's own type, so that the day `'toc'` joins
 * BlockKind (patch 1) this becomes an ordinary member and every use of it type
 * checks unchanged — and until then the compiler is not asked to believe a
 * literal that is not in the union yet.
 */
export const TOC_KIND = 'toc' as unknown as Block['kind'];

/**
 * What a `role` means here.
 *
 * The field already exists for "authoring role, for restyling and for a table
 * of contents" (model.ts), and the app's own vocabulary already treats h1 as
 * the document title — the block-kind picker calls it "Title" and the outline
 * panel lists only h2/h3. So a title-roled heading is FURNITURE: a document's
 * name is not section 1 of itself.
 *
 * The four combinations of (numbered, listed) are all reachable, because all
 * four are things people actually want: a schedule heading that is listed but
 * not numbered, an appendix marker that is numbered but not listed.
 */
export const ROLES = {
  /** document furniture: no number, not in the TOC */
  title: { numbered: false, listed: false },
  subtitle: { numbered: false, listed: false },
  /** LaTeX's \section* — in the contents, without a number */
  unnumbered: { numbered: false, listed: true },
  /** numbered like its siblings, but kept out of the contents */
  unlisted: { numbered: true, listed: false },
} as const satisfies Record<string, { numbered: boolean; listed: boolean }>;

export type RoleName = keyof typeof ROLES;
export const EXCLUDE_ROLE: RoleName = 'unnumbered';

const roleOf = (b: Block): { numbered: boolean; listed: boolean } =>
  ROLES[(b.role ?? '').trim().toLowerCase() as RoleName] ?? { numbered: true, listed: true };

/** The document-level switch. Absent means ON — numbering is the default. */
export interface SectionSettings { numbered: boolean }

export function sectionSettings(doc: TypeDoc): SectionSettings {
  const raw = (doc as { sections?: unknown }).sections;
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined;
  // ABSENT MEANS OFF. Automatic numbering is opt-in, because the documents this
  // app opens mostly already carry their numbers in the heading text — every
  // contract reads "1. Scope of Work" — and numbering those again renders
  // "1.1 1. Scope of Work". The risk is asymmetric: on-by-default visibly
  // corrupts an existing document, off-by-default is a feature somebody has to
  // find. Verified on the starter contract, which is exactly this case.
  return { numbered: obj?.numbered === true };
}

/** Mutate the switch. The only thing in this file that writes to the model. */
export function setNumbered(doc: TypeDoc, on: boolean): void {
  const raw = (doc as { sections?: unknown }).sections;
  const obj = raw && typeof raw === 'object' ? { ...raw as object } : {};
  (doc as { sections?: unknown }).sections = { ...obj, numbered: on };
}

export interface Heading {
  id: string;
  kind: HeadKind;
  /** 1, 2 or 3 — from the kind, never stored separately */
  level: number;
  text: string;
  /** '1.2.3'; absent when numbering is off or this heading opts out */
  number?: string;
  /** does it belong in the table of contents? */
  listed: boolean;
}

/**
 * Every heading, numbered in document order.
 *
 * PURE: it reads the document and writes nothing, which is what makes it
 * testable in node and what makes "derived, never stored" true by construction
 * rather than by discipline.
 *
 * A heading that opts out of numbering does NOT advance the counters — it is
 * outside the sequence, not a gap in it, so its neighbours stay 3 and 4.
 */
export function headings(doc: TypeDoc): Heading[] {
  const numbering = sectionSettings(doc).numbered;
  const counters = new Array<number>(DEPTH).fill(0);
  const out: Heading[] = [];
  for (const b of doc.body) {
    const level = HEAD_LEVEL[b.kind];
    if (level === undefined) continue;
    const role = roleOf(b);
    const h: Heading = { id: b.id, kind: b.kind as HeadKind, level, text: b.text, listed: role.listed };
    if (numbering && role.numbered) {
      counters[level - 1]++;
      for (let i = level; i < DEPTH; i++) counters[i] = 0;
      // A skipped level shows as 0 — see the header. Leading zeros are dropped:
      // they mean the document never opened that level (a title-only h1), which
      // is not a hole in the sequence but a level the document does not use.
      h.number = counters.slice(0, level).join('.').replace(/^(?:0\.)+/, '');
    }
    out.push(h);
  }
  return out;
}

/** blockId → '1.2.3', for the blocks that have one. */
export function sectionNumbers(doc: TypeDoc): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of headings(doc)) if (h.number) m.set(h.id, h.number);
  return m;
}

// ──────────────────────────────────────────────────────── pure: the TOC itself

export interface TocEntry {
  id: string;
  level: number;
  text: string;
  number?: string;
  /** 1-based page, from the pagination Metrics; absent until pages are known */
  page?: number;
}

/**
 * The entries, optionally carrying page numbers.
 *
 * `pages` is separate from the document on purpose: the entries can be built
 * before anything has been measured (the first paint) and the same function
 * builds them again once the Metrics exist. Nothing about the entry depends on
 * having been rendered.
 */
export function buildToc(doc: TypeDoc, pages?: ReadonlyMap<string, number>): TocEntry[] {
  const out: TocEntry[] = [];
  for (const h of headings(doc)) {
    if (!h.listed) continue;
    const e: TocEntry = { id: h.id, level: h.level, text: h.text };
    if (h.number) e.number = h.number;
    const p = pages?.get(h.id);
    if (p !== undefined) e.page = p;
    out.push(e);
  }
  return out;
}

export const hasToc = (doc: TypeDoc): boolean => doc.body.some(b => b.kind === TOC_KIND);

// ─────────────────────────────────────────────────────── pure: pages from y

/**
 * Which page a paper-space y lands on.
 *
 * The half-pixel slack matches paginate.ts's own comparisons: a break is chosen
 * at a line-box top, and asking for the page of that exact y must give the page
 * the line is ON, not the one it ended.
 */
export function pageOfY(pages: readonly Page[], y: number): number | undefined {
  for (const p of pages) {
    if (y >= p.start - 0.5 && (!isFinite(p.end) || y < p.end - 0.5)) return p.n;
  }
  return undefined;
}

/** blockId → page, from measured tops. Pure, so the rig can supply the tops. */
export function headingPages(
  metrics: Metrics, tops: ReadonlyMap<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, y] of tops) {
    const n = pageOfY(metrics.pages, y);
    if (n !== undefined) out.set(id, n);
  }
  return out;
}

/** The whole derivation, in one call: document + measurements → entries. */
export const tocFor = (
  doc: TypeDoc, metrics: Metrics, tops: ReadonlyMap<string, number>,
): TocEntry[] => buildToc(doc, headingPages(metrics, tops));

// ───────────────────────────────────────────────────────── derived markup
//
// LAYOUT is inline, COLOUR comes from styles.css.
//
// Not a style preference: print.ts carries its own stylesheet and this module
// may not touch it, so a TOC that got its columns from styles.css would print
// as a run-on paragraph. Inline layout prints correctly with no print-side
// change; colour is themed and stays in the stylesheet where the theme rig can
// see it. No literal colour appears in this file.

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** width of the page column — fixed, so filling it in later moves nothing */
const PAGE_COL = '2.4em';
const NUM_COL = '3.4em';
const TABULAR = 'font-variant-numeric:tabular-nums';

/** The section number, as an atom the model can never absorb. */
export const sectionNumberHtml = (number: string): string =>
  `<span class="t-secnum" data-derived contenteditable="false"` +
  ` style="margin-inline-end:.5em;${TABULAR}">${esc(number)}</span>`;

/**
 * The entry list.
 *
 * One atom wrapping the whole list, so the TOC block's own stored text (its
 * heading) stays editable and everything derived stays outside the model. No
 * whitespace is emitted between the atom and the heading text — a stray space
 * there WOULD be a character, and readBlock would write it into the document.
 */
export function tocEntriesHtml(entries: readonly TocEntry[]): string {
  if (!entries.length) return '';
  const numbered = entries.some(e => e.number);
  const rows = entries.map(e => {
    const indent = (e.level - 1) * 1.5;
    const num = numbered
      ? `<span class="t-toc-n" style="flex:0 0 ${NUM_COL};${TABULAR}">${esc(e.number ?? '')}</span>` : '';
    return `<a class="t-toc-e" data-goto="${esc(e.id)}"` +
      ` style="display:flex;align-items:baseline;gap:.4em;text-decoration:none;color:inherit` +
      `;margin-inline-start:${indent}em;text-indent:0">` +
      num +
      `<span class="t-toc-t" style="flex:1 1 auto">${esc(e.text)}</span>` +
      `<span class="t-toc-p" style="flex:0 0 ${PAGE_COL};text-align:end;${TABULAR}">` +
      `${e.page ?? ''}</span></a>`;
  }).join('');
  return `<span class="t-toc" data-derived contenteditable="false" style="display:block;margin-top:.4em">${rows}</span>`;
}

/**
 * The decorator the core hook calls, for EVERY block.
 *
 * `base` is the block's ordinary html, already built — so a heading keeps its
 * marks and its footnote markers and merely gains a number in front.
 */
export interface Derived {
  /** blockId → section number; recomputed for you when omitted */
  numbers?: ReadonlyMap<string, string>;
  /** blockId → page; entries simply carry no page when omitted */
  pages?: ReadonlyMap<string, number>;
}

export function decorate(doc: TypeDoc, b: Block, base: string, d: Derived = {}): string | null {
  if (b.kind === TOC_KIND) return base + tocEntriesHtml(buildToc(doc, d.pages));
  const level = HEAD_LEVEL[b.kind];
  if (level === undefined) return null;
  // The caches are PARAMETERS, not module state. Recomputing the numbering for
  // every block would make a render O(blocks²) — 200 pages of contract is a
  // real number — but a decorator that read a module-level cache would answer
  // differently depending on what ran before it, which is untestable and, in
  // node, simply wrong.
  const n = (d.numbers ?? sectionNumbers(doc)).get(b.id);
  return n ? sectionNumberHtml(n) + base : null;
}

// ──────────────────────────────────────────────────────────── live wiring
//
// Everything below is the browser side: caches, the DOM measurement, and the
// chrome. The functions above never reach it, which is why they run in node.

let ctxRef: FeatureContext | null = null;
let numbers: Map<string, string> | null = null;
let pageCache: Map<string, number> = new Map();
let wired = false;

/** The numbering, recomputed at most once per document change. */
function numberCache(doc: TypeDoc): Map<string, string> {
  if (!numbers) numbers = sectionNumbers(doc);
  return numbers;
}

/** Paper-space top of every heading, measured the way paginate.ts measures. */
export function measureTops(doc: TypeDoc, host: HTMLElement): Map<string, number> {
  const top0 = host.getBoundingClientRect().top + doc.page.marginTop;
  const tops = new Map<string, number>();
  for (const b of doc.body) {
    if (!isHeading(b)) continue;
    const el = host.querySelector<HTMLElement>(`[data-id="${CSS.escape(b.id)}"]`);
    if (el) tops.set(b.id, el.getBoundingClientRect().top - top0);
  }
  return tops;
}

/**
 * After pagination: fill in the page numbers.
 *
 * In place, never by re-rendering, and never by committing. The page column has
 * a fixed width, so writing "12" where "" was moves nothing and the pagination
 * this was derived from stays valid — no second pass, no fixpoint. Only when
 * the ENTRY COUNT disagrees with the DOM (a heading was added while the caret
 * sat elsewhere and nothing re-rendered) is the list rebuilt wholesale.
 */
export function paintPages(ctx: FeatureContext, metrics: Metrics, host: HTMLElement): void {
  const doc = ctx.store.doc;
  pageCache = headingPages(metrics, measureTops(doc, host));
  const entries = buildToc(doc, pageCache);
  for (const box of Array.from(host.querySelectorAll<HTMLElement>('[data-kind="toc"]'))) {
    const rows = Array.from(box.querySelectorAll<HTMLElement>('a[data-goto]'));
    if (rows.length !== entries.length) {
      const list = box.querySelector<HTMLElement>('.t-toc');
      const html = tocEntriesHtml(entries);
      if (list) list.outerHTML = html;
      else box.insertAdjacentHTML('beforeend', html);
      continue;
    }
    rows.forEach((row, i) => {
      const e = entries[i];
      const pg = row.querySelector<HTMLElement>('.t-toc-p');
      const txt = row.querySelector<HTMLElement>('.t-toc-t');
      const num = row.querySelector<HTMLElement>('.t-toc-n');
      const page = e.page === undefined ? '' : String(e.page);
      if (pg && pg.textContent !== page) pg.textContent = page;
      if (txt && txt.textContent !== e.text) txt.textContent = e.text;
      if (num && num.textContent !== (e.number ?? '')) num.textContent = e.number ?? '';
      if (row.dataset.goto !== e.id) row.dataset.goto = e.id;
    });
  }
}

/** Insert a contents block above the caret's block, or at the top. */
export function insertToc(ctx: FeatureContext): void {
  if (!wired) { ctx.toast(t('The table of contents needs the core render hook.')); return; }
  const doc = ctx.store.doc;
  const caret = ctx.editor.caret();
  // above the caret's block; with no caret, under a leading title — a contents
  // page belongs beneath the document's name, which is where authors put it
  let at = 0;
  if (caret) at = Math.max(0, doc.body.findIndex(b => b.id === caret.id));
  else while (at < doc.body.length && doc.body[at].kind === 'h1') at++;
  const id = `toc-${Math.random().toString(36).slice(2, 10)}`;
  const heading = t('Contents');
  ctx.store.commit(d => {
    d.body.splice(at, 0, { id, kind: TOC_KIND, text: heading });
  });
  ctx.editor.render();
  ctx.refresh();
  ctx.toast(t('Contents inserted. Page numbers fill in as the document paginates.'));
}

/** Toggle the document-level switch. */
export function toggleNumbering(ctx: FeatureContext): void {
  const on = !sectionSettings(ctx.store.doc).numbered;
  ctx.store.commit(d => setNumbered(d, on));
  numbers = null;
  ctx.editor.render();
  ctx.refresh();
  ctx.toast(on ? t('Sections are numbered.') : t('Section numbering is off.'));
}

/** Exclude the caret's heading from numbering, or put it back. */
export function toggleExclude(ctx: FeatureContext): void {
  const caret = ctx.editor.caret();
  const block = caret ? ctx.store.block(caret.id) : undefined;
  if (!block || !isHeading(block)) { ctx.toast(t('Put the caret in a heading first.')); return; }
  const off = (block.role ?? '') !== EXCLUDE_ROLE;
  ctx.store.commit(d => {
    const b = d.body.find(x => x.id === block.id);
    if (!b) return;
    if (off) b.role = EXCLUDE_ROLE; else delete b.role;
  }, { scope: { block: block.id } });
  numbers = null;
  ctx.editor.render();
  ctx.refresh();
  ctx.toast(off ? t('This heading is no longer numbered.') : t('This heading is numbered again.'));
}

// The icon follows type/src/icons.ts exactly: 24×24 box, rendered at 16px,
// stroke currentColor at width 2, round caps and joins. It lives here rather
// than in icons.ts because a feature is one file — the recipe is what must not
// drift, not the location.
const TOC_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"' +
  ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<line x1="4" y1="6" x2="14" y2="6"/><line x1="4" y1="12" x2="12" y2="12"/>' +
  '<line x1="4" y1="18" x2="15" y2="18"/><line x1="19" y1="6" x2="20" y2="6"/>' +
  '<line x1="19" y1="12" x2="20" y2="12"/><line x1="19" y1="18" x2="20" y2="18"/></svg>';

// ── registration. Labels are GETTERS so t() runs when the chrome is built,
// never at module evaluation — a translated string frozen at import is the
// i18n bug this codebase names explicitly.
features.registerTool({
  id: 'toc',
  icon: TOC_ICON,
  get title() { return t('Insert a table of contents'); },
  group: 'insert',
  label: () => t('Contents'),
  order: 60,
  run: insertToc,
});

// 'Number sections' is a document PROPERTY and lives in the properties panel.

// NO ⋯ entry for excluding a heading: it is a property of the heading under
// the caret, and it lives as a checkbox in the properties panel's Text section,
// where it can SHOW its state instead of only offering to flip it.

/**
 * Soft wiring.
 *
 * The three core hooks this feature needs (see NEEDS FROM THE CORE) do not
 * exist yet. Looking them up by name rather than importing them keeps `tsc`
 * clean and the app running BEFORE the patch lands, and needs no edit here
 * AFTER it lands — the feature simply starts working. The casts are the only
 * thing the patch makes unnecessary.
 */
/**
 * One indirection, and it earns its keep: naming the export through a VARIABLE
 * keeps the bundler from resolving it statically, so a hook that does not exist
 * yet is `undefined` at run time instead of a build warning on every build.
 */
const soft = (mod: object, name: string): unknown => (mod as Record<string, unknown>)[name];

function wire(): void {
  const reg = soft(render, 'registerBlockDecorator');
  if (typeof reg === 'function') {
    (reg as (d: (b: Block, base: string) => string | null) => void)((b, base) => {
      if (!ctxRef) return null;
      const doc = ctxRef.store.doc;
      return decorate(doc, b, base, { numbers: numberCache(doc), pages: pageCache });
    });
    wired = true;
  }
  const ready = soft(features, 'registerReady');
  if (typeof ready === 'function') {
    (ready as (f: (c: FeatureContext) => void) => void)(onReady);
  }
  const paginated = soft(features, 'registerPaginated');
  if (typeof paginated === 'function') {
    (paginated as (f: (c: FeatureContext, m: Metrics, h: HTMLElement) => void) => void)(
      (ctx, metrics, host) => { if (ctxRef) paintPages(ctx, metrics, host); });
  }
}

function onReady(ctx: FeatureContext): void {
  ctxRef = ctx;
  // the numbering is a derivation of the document, so it is invalidated by the
  // document and by nothing else
  ctx.store.on(() => { numbers = null; });
  // Clicking an entry goes to the heading. Delegated, because the entries are
  // rebuilt from scratch whenever anything changes and a listener per row would
  // be attached to elements that no longer exist.
  ctx.editor.host.addEventListener('click', e => {
    const row = (e.target as HTMLElement | null)?.closest?.('a[data-goto]') as HTMLElement | null;
    if (!row) return;
    e.preventDefault();
    ctx.editor.host.querySelector(`[data-id="${CSS.escape(row.dataset.goto!)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  // the first paint happened before the context existed, so it has no numbers
  if (wired) ctx.refresh();
}

wire();
