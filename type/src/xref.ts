// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Captions, automatic figure/table numbering, and cross-references.
//
// This is the feature a long document cannot be maintained without, and the one
// LaTeX users will not give up: you write "see Table 2", someone inserts a table
// three pages earlier, and the sentence still says the right thing.
//
// ═══════════════════════════════════════════════════════ NEEDS FROM THE CORE
//
// Everything below is written and tested against the model as it will be. The
// numbering, the resolution and the atom/string plumbing are complete and run
// in node today (scripts/test-type-xref.ts); what they cannot do without these
// edits is REACH the editor, because a feature module may not add a block kind
// or an inline atom by itself. Each is minimal and each says why.
//
// 1. type/src/model.ts — the caption block kind
//      - BlockKind: add 'caption'
//          export type BlockKind = … | 'cell' | 'caption';
//      - add, beside CellRef:
//          export interface CaptionRef { kind: 'table' | 'figure'; of?: string }
//      - Block: add
//          /** caption placement; only meaningful on a `caption` block */
//          caption?: CaptionRef;
//          /** cross-references, by offset into `text` — atoms, like `notes` */
//          refs?: XrefRef[];   // { to: string; at: number; style?: 'label'|'page'|'both' }
//    WHY a block and not a field on the table: there IS no table block to hang
//    a caption on (a table is a run of `cell` blocks sharing an id), and a
//    caption must have its own stable id anyway — that id is what a reference
//    points at, and what the redline aligns on so an edited caption reports as
//    an edited caption. It is also what makes a figure caption drop in later
//    with no redesign: same block, `kind:'figure'`, `of` naming the image.
//
// 2. type/src/model.ts — parseDoc, in the per-block loop, after the `cell` case:
//      if (kind === 'caption') {
//        const c = isObj(b.caption) ? b.caption as Partial<CaptionRef> : undefined;
//        out.caption = { kind: c?.kind === 'figure' ? 'figure' : 'table',
//                        ...(typeof c?.of === 'string' && c.of ? { of: c.of } : {}) };
//      }
//      const refs = Array.isArray(b.refs)
//        ? (b.refs as XrefRef[]).filter(r => isObj(r) && typeof r.to === 'string' && typeof r.at === 'number')
//            .map(r => ({ to: r.to, at: Math.max(0, Math.min(r.at, text.length)),
//                         ...(r.style === 'page' || r.style === 'both' ? { style: r.style } : {}) }))
//            .sort((x, y) => x.at - y.at)
//        : undefined;
//      if (refs?.length) out.refs = refs;
//    NOTE — and this is a deliberate difference from footnotes: DO NOT drop a
//    reference whose target is missing. parseDoc drops dangling `notes` because
//    a marker with no note behind it renders as a number pointing at nothing.
//    A dangling REFERENCE is the opposite case: the author wrote "see ⟨that
//    table⟩" and the table was deleted. Dropping it silently deletes the
//    sentence's meaning and leaves prose reading "see ." Keeping it renders a
//    visible ?? that says out loud that something must be fixed — the LaTeX
//    behaviour, and the only safe one. See `BROKEN_TEXT` below.
//
// 3. type/src/model.ts — spliceText, so a reference follows the edit exactly as
//    a footnote anchor does. Beneath `if (block.notes?.length) { … }` add:
//      if (block.refs?.length) {
//        const r = shiftRefs(block.refs, at, removed, added.length);
//        if (r.length) out.refs = r; else delete out.refs;
//      }
//    with `import { shiftRefs } from './xref.ts';` at the top. That import is
//    safe: this module imports NOTHING from model.ts at value level (only
//    types), precisely so the core can call into it without a cycle — which is
//    also why `mint()` below exists instead of importing model's `uid`.
//
// 4. type/src/render.ts — the atom and the caption label
//      import { captionPrefixHtml, isXrefAtom, refAtoms, readXrefs } from './xref.ts';
//      - TAG: add `caption: 'figcaption'`
//      - blockHtml: merge `refAtoms(b)` into the `inject` map (they are offsets
//        into the same text as the note anchors), and return
//        `captionPrefixHtml(b) + (html || '<br>')`
//      - readBlock: pass `el => isNoteAtom(el) || isXrefAtom(el)` as the atom
//        predicate, and after the notes line add
//          const refs = readXrefs(atoms); if (refs.length) out.refs = refs; else delete out.refs;
//      - renderBody: after `numberNotes(host, doc)` call `numberXrefs(host, doc)`
//    (A general "atom registry" in render.ts would be tidier and would suit the
//    next feature that needs one — comments, index entries. It is a bigger
//    change than this feature is owed, so this mirrors how notes are wired.)
//
// 5. type/src/print.ts — one line, so paper agrees with screen. After the body
//    HTML is assembled (the `out.join('')` that feeds `.t-body`):
//      import { fillXrefsHtml, captionIndex } from './xref.ts';
//      html = fillXrefsHtml(html, captionIndex(doc.body, docLang(doc)));
//    The DOM pass and the string pass fill the SAME atoms from the SAME index,
//    which is what stops the printed numbering drifting from the screen's.
//
// 6. type/src/registry.ts — `import './xref.ts';` (mine to add, and added).
//
// Until 1–5 land, the interface augmentation at the bottom of this file keeps
// `tsc` honest and the pure functions keep working; delete it when they do. The
// two entry points refuse to run until then (see `corePatched`), so a build
// carrying this file ahead of the patch cannot damage a document.
//
// VERIFIED, not asserted: patches 1–4 were applied to a throwaway copy of
// type/src outside the repo, where `tsc --noEmit` is clean and a caption block
// renders `<span class="t-cap-num" data-cap="c1">Table 1.</span>Fee schedule`,
// a reference renders `Table 1`, spliceText moves a reference anchor from 6 to
// 9 on a three-character insertion, and parseDoc round-trips both fields.
//
// ═════════════════════════════════════════ WHY A REFERENCE IS AN ATOM, NOT TEXT
//
// A reference sits inside a paragraph's text. It could be (a) literal text the
// feature rewrites, (b) a MARK over a run whose text is the number, or (c) an
// ATOM at an offset that occupies no characters — what a footnote marker
// already is. It is (c), and the three properties this app is built on each
// rule out the other two:
//
//   · THE REDLINE DIFFS PLAIN TEXT, WORD BY WORD. With (a) or (b) the
//     characters "Table 2" live in `text`, so inserting an unrelated table on
//     page 1 rewrites every later reference — and the review pane reports a
//     dozen edits nobody made, in a document whose whole point is that a
//     reviewer can trust what it says changed. As an atom the text never moves:
//     renumbering is invisible to the diff, which is correct, because nobody
//     edited anything.
//   · SIGNATURES CANONICALISE THE MODEL. A stored number is content, so it is
//     signed. Renumbering would then break every signature on the document
//     without a human touching a word — and, worse, a signature would attest to
//     a number the reader is not being shown once it re-derives. The atom
//     stores an id and a style, both of which are stable under renumbering.
//   · THE CARET IS (blockId, offset). An atom has a position and no width, and
//     spliceText's arithmetic for exactly that already exists and is tested —
//     `shiftRefs` here is the same rule as the notes rule, on purpose, so there
//     is one concept in the codebase and not two.
//
// The cost is that the visible words are not in the model, so anything reading
// the document as prose (search, export to plain text) must resolve references
// itself. `refText()` is that function and it is pure.
//
// ═══════════════════════════════════════════════ WHOSE LANGUAGE SAYS "TABLE"?
//
// The word "Table" in "Table 2" is USER-VISIBLE and translatable, and it is NOT
// t(). t() follows the READER: locale comes from navigator.language, and
// language never enters the document format. That is right for chrome, and
// wrong here, because this string is not chrome — it renders INTO the document,
// between the author's sentences, and gets printed and signed alongside them.
//
// Follow the reader's locale and a French contract reads "Le calendrier des
// paiements figure au Table 2" for an English reader and "…au Tableau 2" for a
// French one: the label disagrees with the prose around it, and the SAME BYTES
// show two different documents to two people. For an app whose differentiator
// is that a signed document says one thing, that is disqualifying — nobody can
// sign "whatever this renders as in your browser".
//
// So the caption label follows the DOCUMENT's language, `doc.lang` (BCP 47,
// default 'en'; format-additive, so old files simply say English). That is not
// a viewer preference sneaking into the format — it is the same fact `<html
// lang>` carries, content metadata about what language the words are in, no
// different from `title` being in the document. The chrome around the feature —
// the buttons, the panel, the picker — stays on t() and follows the reader,
// which is the correct split: the reader's UI in the reader's language, the
// author's document in the author's.
//
// Hence CAPTION_WORDS below rather than t() calls: a t() catalog is keyed by the
// viewer's locale and cannot answer "what is 'Table' in the document's
// language". The two are different questions and only one of them is i18n.

import type { Block, TypeDoc } from './model.ts';
import { blockHtml, TAG } from './render.ts';
import { registerKey, registerPanel, registerTool,
         type FeatureContext } from './features.ts';
import { t } from './i18n.ts';

// ───────────────────────────────────────────────────────────────────── model

export type CaptionKind = 'table' | 'figure';
export type RefStyle = 'label' | 'page' | 'both';

/** What a caption block captions. `of` names the object; numbering never uses it. */
export interface CaptionRef { kind: CaptionKind; of?: string }

/** A cross-reference anchored INTO a block's text, by character offset. */
export interface XrefRef { to: string; at: number; style?: RefStyle }

/** The block kind a caption is. Cast until model.ts learns the kind (patch 1). */
export const CAPTION: Block['kind'] = 'caption' as unknown as Block['kind'];

/** What a broken reference renders as. Visible, and deliberately ugly. */
export const BROKEN_TEXT = '??';

/**
 * A fresh id. Mirrors model.ts `uid`, and is a copy rather than an import so
 * that model.ts can import `shiftRefs` from here without a value-level cycle.
 */
const mint = (p = 'b'): string => {
  const r = globalThis.crypto?.randomUUID?.();
  return r ? `${p}-${r.slice(0, 8)}` : `${p}-${Math.random().toString(36).slice(2, 10)}`;
};

// ───────────────────────────────────────────────────── the document's language

/**
 * The words that render into the document, per language.
 *
 * Not t(): see the header. These follow `doc.lang`, not the reader. The eight
 * languages are the suite's UI languages, which is a reasonable starting set
 * and not a limit — an unknown language falls back to English rather than to
 * nothing, because "Table 2" is wrong in Finnish but readable, and "" is not.
 */
export const CAPTION_WORDS: Record<string, { table: string; figure: string; page: string }> = {
  en: { table: 'Table',    figure: 'Figure',     page: 'page' },
  fr: { table: 'Tableau',  figure: 'Figure',     page: 'page' },
  de: { table: 'Tabelle',  figure: 'Abbildung',  page: 'Seite' },
  es: { table: 'Tabla',    figure: 'Figura',     page: 'página' },
  it: { table: 'Tabella',  figure: 'Figura',     page: 'pagina' },
  ja: { table: '表',       figure: '図',          page: 'ページ' },
  'zh-hans': { table: '表', figure: '图',         page: '页' },
  'zh-hant': { table: '表', figure: '圖',         page: '頁' },
};

/** The document's language tag, normalised. `lang` is format-additive. */
export function docLang(doc: Partial<TypeDoc> | Record<string, unknown>): string {
  const raw = (doc as Record<string, unknown>).lang;
  return typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : 'en';
}

/** Resolve a BCP 47 tag onto the word table: exact, then script, then base. */
function words(lang: string): { table: string; figure: string; page: string } {
  const l = lang.toLowerCase();
  if (CAPTION_WORDS[l]) return CAPTION_WORDS[l];
  // zh-CN / zh-TW / zh-Hant-HK → the two written forms
  if (l.startsWith('zh')) {
    const trad = /hant|tw|hk|mo/.test(l);
    return CAPTION_WORDS[trad ? 'zh-hant' : 'zh-hans'];
  }
  const base = l.split('-')[0];
  return CAPTION_WORDS[base] ?? CAPTION_WORDS.en;
}

export const captionWord = (kind: CaptionKind, lang = 'en'): string => words(lang)[kind];
export const pageWord = (lang = 'en'): string => words(lang).page;

/** "Table 2" — the label, in the document's language. A space separates it in
 *  Latin scripts; CJK sets the number tight against the word, as those
 *  typographies do. */
export function joinLabel(word: string, n: number, lang = 'en'): string {
  return /^(ja|zh|ko)/.test(lang.toLowerCase()) ? `${word}${n}` : `${word} ${n}`;
}

// ───────────────────────────────────────────────────────────────── numbering

export interface CaptionEntry {
  /** the caption BLOCK's id — this is what a reference points at */
  id: string;
  kind: CaptionKind;
  /** DERIVED, never stored */
  n: number;
  /** "Table" in the document's language */
  word: string;
  /** "Table 2" */
  label: string;
  /** the caption's own words */
  text: string;
  /** the object captioned, when known (a table id, later an image block id) */
  of?: string;
  /** position in `body`, for ordering and for the panel's jump */
  index: number;
}

const captionOf = (b: Block): CaptionRef | undefined =>
  b.kind === CAPTION ? (b.caption ?? { kind: 'table' }) : undefined;

/**
 * Every caption, numbered in DOCUMENT ORDER with a counter per kind.
 *
 * Numbering is derived on every read and stored nowhere. Insert a table in the
 * middle and everything after it renumbers, which is the whole point; a number
 * written into the JSON would be wrong the instant that happened — the rule
 * render.ts's numberNotes already follows for footnotes, for the same reason.
 */
export function captionEntries(body: readonly Block[], lang = 'en'): CaptionEntry[] {
  const counters: Record<CaptionKind, number> = { table: 0, figure: 0 };
  const out: CaptionEntry[] = [];
  body.forEach((b, index) => {
    const cap = captionOf(b);
    if (!cap) return;
    const kind: CaptionKind = cap.kind === 'figure' ? 'figure' : 'table';
    const n = ++counters[kind];
    const word = captionWord(kind, lang);
    out.push({ id: b.id, kind, n, word, label: joinLabel(word, n, lang),
               text: b.text, ...(cap.of ? { of: cap.of } : {}), index });
  });
  return out;
}

/** The same, keyed by caption id — what reference resolution looks things up in. */
export function captionIndex(body: readonly Block[], lang = 'en'): Map<string, CaptionEntry> {
  return new Map(captionEntries(body, lang).map(e => [e.id, e]));
}

// ─────────────────────────────────────────────────────────────── resolution

export type Resolved =
  | { ok: true; text: string; entry: CaptionEntry }
  | { ok: false; text: string };

/**
 * What a reference renders as.
 *
 * A MISSING TARGET IS NOT AN ERROR TO SWALLOW. It renders as `??` — visible,
 * styled as a problem, and never empty. A reference that renders as nothing is
 * the worst outcome available: the sentence silently becomes "as shown in ."
 * and nobody proof-reading a 90-page contract will catch it. LaTeX prints ??
 * for the same reason, and this keeps the reference in the model so that
 * restoring the deleted table (undo, or accepting a rejected redline) makes
 * every reference to it correct again with no repair step.
 *
 * `pageOf` is optional: page numbers exist only where pagination has been
 * computed (the editor, print), so a style that asks for one degrades to the
 * label rather than to a lie.
 */
export function refText(index: Map<string, CaptionEntry>, ref: XrefRef,
                        opts: { lang?: string; pageOf?: (blockId: string) => number | undefined } = {}): Resolved {
  const entry = index.get(ref.to);
  if (!entry) return { ok: false, text: BROKEN_TEXT };
  const style = ref.style ?? 'label';
  const page = style === 'label' ? undefined : opts.pageOf?.(entry.id);
  const pw = pageWord(opts.lang ?? 'en');
  if (style === 'page' && page !== undefined) return { ok: true, text: `${pw} ${page}`, entry };
  if (style === 'both' && page !== undefined) return { ok: true, text: `${entry.label} (${pw} ${page})`, entry };
  return { ok: true, text: entry.label, entry };
}

/** Every reference in the document, in order. */
export function refsIn(body: readonly Block[]): Array<{ block: Block; ref: XrefRef }> {
  const out: Array<{ block: Block; ref: XrefRef }> = [];
  for (const b of body) for (const ref of b.refs ?? []) out.push({ block: b, ref });
  return out;
}

/** The ones pointing at nothing — what the panel shows and what a pre-send
 *  check should refuse to ignore. */
export function brokenRefs(body: readonly Block[]): Array<{ block: Block; ref: XrefRef }> {
  const index = captionIndex(body);
  return refsIn(body).filter(({ ref }) => !index.has(ref.to));
}

// ────────────────────────────────────────────────────────── offset arithmetic

/**
 * Move reference anchors to follow an edit that replaced [at, at+removed) with
 * `added` characters. THE SAME RULE footnote anchors use — deliberately: an
 * anchor inside the replaced span is dropped because the words it sat in are
 * gone, and everything after it shifts.
 *
 * model.ts spliceText calls this (patch 3). It is here, and pure, so it can be
 * tested without a DOM and without the core edit having landed.
 */
export function shiftRefs(refs: readonly XrefRef[], at: number, removed: number, added: number): XrefRef[] {
  const end = at + removed;
  const delta = added - removed;
  return refs
    .filter(r => !(r.at > at && r.at < end))
    .map(r => (r.at >= end ? { ...r, at: r.at + delta } : { ...r }))
    .sort((x, y) => x.at - y.at);
}

/** Add a reference to a block at an offset. Pure — the caller commits it. */
export function withRef(block: Block, at: number, to: string, style?: RefStyle): Block {
  const ref: XrefRef = { to, at: Math.max(0, Math.min(at, block.text.length)),
                         ...(style && style !== 'label' ? { style } : {}) };
  return { ...block, refs: [...(block.refs ?? []), ref].sort((x, y) => x.at - y.at) };
}

/** A new caption block for an object. Its id is minted ONCE and never again:
 *  it is what every reference to this table points at, so re-minting it would
 *  break every sentence that mentions the table. */
export function newCaption(kind: CaptionKind, of?: string, text = ''): Block {
  return { id: mint('cap'), kind: CAPTION, text,
           caption: { kind, ...(of ? { of } : {}) } };
}

/**
 * Where a caption for the block at `i` belongs, and what it captions.
 *
 * Inside a table the caption goes AFTER the whole run of cells sharing the
 * table id — a caption in the middle of a table would split it into two tables,
 * since grouping is by adjacency.
 */
export function captionSite(body: readonly Block[], i: number):
    { at: number; kind: CaptionKind; of?: string } | null {
  const here = body[i];
  if (!here) return null;
  if (here.kind === CAPTION) return null;              // already a caption
  if (here.kind === 'cell' && here.cell) {
    const table = here.cell.table;
    let end = i;
    while (end + 1 < body.length && body[end + 1].kind === 'cell'
           && body[end + 1].cell?.table === table) end++;
    return { at: end + 1, kind: 'table', of: table };
  }
  return { at: i + 1, kind: 'figure' };
}

/** Does this table already have a caption? Keeps the button from making two. */
export function captionForObject(body: readonly Block[], of: string): Block | undefined {
  return body.find(b => b.kind === CAPTION && b.caption?.of === of);
}

// ──────────────────────────────────────────────────── atoms: model → markup
//
// Two placeholder atoms are emitted with the block's HTML and FILLED afterwards
// from the index — the numbering cannot be known block-locally, and doing it in
// a second pass is exactly what numberNotes does. There are two consumers: the
// editor fills DOM nodes, print fills a string. Both read the same index, so
// paper and screen cannot disagree.

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: string) => s.replace(/[&<>"]/g, c => ESC[c]);

/** The atoms a block contributes, keyed by offset — merged into blockHtml's
 *  inject map beside the footnote markers. */
export function refAtoms(b: Block): Map<number, string> {
  const m = new Map<number, string>();
  for (const r of b.refs ?? []) {
    const prev = m.get(r.at) ?? '';
    m.set(r.at, prev + `<span class="t-xref" data-xref="${esc(r.to)}"` +
                       `${r.style && r.style !== 'label' ? ` data-style="${esc(r.style)}"` : ''}` +
                       ` contenteditable="false">${BROKEN_TEXT}</span>`);
  }
  return m;
}

/** The label that precedes a caption's own words. Empty for every other kind. */
export function captionPrefixHtml(b: Block): string {
  if (b.kind !== CAPTION) return '';
  return `<span class="t-cap-num" data-cap="${esc(b.id)}" contenteditable="false"></span>`;
}

/** Is this element one of ours? Both atoms are invisible to the model: the
 *  reference is an id, and the caption label is DERIVED, so neither may come
 *  back through readBlock as text. */
export const isXrefAtom = (el: Element): boolean =>
  el.tagName === 'SPAN' && (el.classList.contains('t-xref') || el.classList.contains('t-cap-num'));

/** Read reference atoms back out of a parsed block. Caption labels carry no
 *  `data-xref` and so vanish here, which is correct — they are derived. */
export function readXrefs(atoms: Array<{ at: number; el: Element }>): XrefRef[] {
  const out: XrefRef[] = [];
  for (const a of atoms) {
    const el = a.el as HTMLElement;
    const to = el.dataset?.xref;
    if (!to) continue;
    const style = el.dataset.style;
    out.push({ to, at: a.at, ...(style === 'page' || style === 'both' ? { style } : {}) });
  }
  return out.sort((x, y) => x.at - y.at);
}

// ─────────────────────────────────────────────────────────────── filling in

/** Fill both atom kinds in a STRING of block HTML — the print path. Pure, so
 *  the rig can assert that paper renders the same words as the screen. */
export function fillXrefsHtml(html: string, index: Map<string, CaptionEntry>,
                              opts: { lang?: string; pageOf?: (id: string) => number | undefined } = {}): string {
  return html.replace(/<span class="t-(xref|cap-num)"([^>]*)>.*?<\/span>/g, (_m, which: string, attrs: string) => {
    const id = /data-(?:xref|cap)="([^"]*)"/.exec(attrs)?.[1] ?? '';
    if (which === 'cap-num') {
      const e = index.get(id);
      return `<span class="t-cap-num" data-cap="${esc(id)}">${e ? esc(e.label) + '.' : ''}</span>`;
    }
    const style = /data-style="([^"]*)"/.exec(attrs)?.[1] as RefStyle | undefined;
    const r = refText(index, { to: id, at: 0, ...(style ? { style } : {}) }, opts);
    return `<span class="t-xref${r.ok ? '' : ' t-xref-broken'}" data-xref="${esc(id)}">${esc(r.text)}</span>`;
  });
}

/**
 * Fill both atom kinds in a rendered host — the editor path, called from
 * renderBody after numberNotes.
 *
 * Writes only text and one class, never structure, so it cannot disturb the
 * caret: nothing an author can put a caret in changes size or identity.
 */
export function numberXrefs(host: HTMLElement, doc: TypeDoc,
                            pageOf?: (id: string) => number | undefined): void {
  const lang = docLang(doc);
  const index = captionIndex(doc.body, lang);
  for (const el of host.querySelectorAll<HTMLElement>('span.t-cap-num')) {
    const e = index.get(el.dataset.cap ?? '');
    el.textContent = e ? `${e.label}.` : '';
  }
  for (const el of host.querySelectorAll<HTMLElement>('span.t-xref')) {
    const style = el.dataset.style as RefStyle | undefined;
    const r = refText(index, { to: el.dataset.xref ?? '', at: 0, ...(style ? { style } : {}) },
                      { lang, ...(pageOf ? { pageOf } : {}) });
    el.textContent = r.text;
    el.classList.toggle('t-xref-broken', !r.ok);
    el.title = r.ok ? r.text : t('This reference points at something that is no longer in the document');
  }
}

/** The document as prose, with references resolved — for search, plain-text
 *  export, and anything that must read what the reader reads. */
export function resolvedText(doc: TypeDoc): string {
  const lang = docLang(doc);
  const index = captionIndex(doc.body, lang);
  return doc.body.map(b => {
    const cap = captionOf(b);
    const head = cap ? `${index.get(b.id)?.label ?? ''}. ` : '';
    if (!b.refs?.length) return head + b.text;
    let out = '', cut = 0;
    for (const r of [...b.refs].sort((x, y) => x.at - y.at)) {
      out += b.text.slice(cut, r.at) + refText(index, r, { lang }).text;
      cut = r.at;
    }
    return head + out + b.text.slice(cut);
  }).join('\n');
}

// ══════════════════════════════════════════════════════════════════════ chrome
//
// From here down is the editor surface: two toolbar buttons, a picker, a panel
// and a shortcut, all registered through features.ts so main.ts is untouched.
// Every string here is CHROME and goes through t() — it is the reader's UI, in
// the reader's language, which is the other half of the argument in the header.

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" ` +
  `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON_CAPTION = svg('<rect x="3" y="4" width="18" height="11" rx="2"/><line x1="6" y1="19" x2="18" y2="19"/>');
const ICON_XREF = svg('<path d="M4 7h9"/><path d="M4 12h6"/><path d="M4 17h9"/><path d="M15 12l5 5-5 5" transform="translate(0,-7)"/>');

/**
 * Is this build's core patched (patches 1 and 4)?
 *
 * Until it is, a caption block would ask the renderer for TAG['caption'] and
 * get `undefined`, and a reference would be committed into a document that
 * renders it as nothing — the exact failure this feature exists to prevent,
 * caused by the feature itself. So the two entry points refuse rather than
 * damage a document, and say why. PROBED, not assumed: the check renders a
 * throwaway block and looks for the atom, so it goes green the moment the
 * patch lands and needs no second edit here.
 *
 * (The import of render.ts is a cycle once patch 4 lands. It is safe: neither
 * module touches the other at evaluation time, only inside functions.)
 */
let probed: boolean | null = null;
export function corePatched(): boolean {
  if (probed === null) {
    const probe: Block = { id: 'probe', kind: 'para', text: 'x', refs: [{ to: 'nothing', at: 0 }] };
    probed = CAPTION in TAG && blockHtml(probe).includes('t-xref');
  }
  return probed;
}
const refuse = (ctx: FeatureContext): boolean => {
  if (corePatched()) return false;
  ctx.toast(t('This build cannot render captions yet — apply the core patch listed at the top of xref.ts'));
  return true;
};

/** The block the caret is in, as an index into body. */
function caretIndex(ctx: FeatureContext): number {
  const c = ctx.editor.caret();
  if (!c) return -1;
  return ctx.store.doc.body.findIndex(b => b.id === c.id);
}

/** Add a caption to the table (or the block) the caret is in. */
export function addCaption(ctx: FeatureContext): void {
  if (refuse(ctx)) return;
  const i = caretIndex(ctx);
  if (i < 0) { ctx.toast(t('Put the caret in the table or paragraph to caption')); return; }
  const site = captionSite(ctx.store.doc.body, i);
  if (!site) { ctx.toast(t('That is already a caption')); return; }
  if (site.of) {
    const existing = captionForObject(ctx.store.doc.body, site.of);
    if (existing) { ctx.editor.setCaret({ id: existing.id, at: existing.text.length }); ctx.toast(t('This already has a caption')); return; }
  }
  const block = newCaption(site.kind, site.of);
  ctx.store.breakRun();
  ctx.store.commit(d => { d.body.splice(site.at, 0, block); });
  ctx.refresh();
  ctx.editor.setCaret({ id: block.id, at: 0 });
}

/** Insert a cross-reference at the caret. */
export function insertRef(ctx: FeatureContext, to: string, style: RefStyle = 'label'): void {
  const c = ctx.editor.caret();
  if (!c) { ctx.toast(t('Put the caret where the reference goes')); return; }
  const at = c.at;
  ctx.store.breakRun();
  ctx.store.commit(d => {
    const i = d.body.findIndex(b => b.id === c.id);
    if (i < 0) return;
    d.body[i] = withRef(d.body[i], at, to, style);
  }, { scope: { block: c.id } });
  ctx.refresh();
  ctx.editor.setCaret({ id: c.id, at });
}

/**
 * The picker — a reference is chosen from a list, never typed as an id.
 *
 * An id is a thing the author has no reason to know and every reason to get
 * wrong; the list shows what they actually wrote, "Table 2 — Fee schedule".
 */
export function openPicker(ctx: FeatureContext): void {
  if (refuse(ctx)) return;
  const c = ctx.editor.caret();
  if (!c) { ctx.toast(t('Put the caret where the reference goes')); return; }
  const entries = captionEntries(ctx.store.doc.body, docLang(ctx.store.doc));
  if (!entries.length) { ctx.toast(t('Nothing to refer to yet — caption a table first')); return; }

  const back = document.createElement('div');
  back.className = 't-overlay';
  const box = document.createElement('div');
  box.className = 't-dlg t-xref-pick';
  box.innerHTML = `<h3>${t('Insert a cross-reference')}</h3>`;

  const styleRow = document.createElement('div');
  styleRow.className = 't-xref-style';
  const sel = document.createElement('select');
  for (const [value, label] of [['label', t('Label — “Table 2”')],
                                ['page', t('Page — “page 7”')],
                                ['both', t('Both — “Table 2 (page 7)”')]] as const) {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    sel.appendChild(o);
  }
  styleRow.append(sel);
  box.appendChild(styleRow);

  const list = document.createElement('div');
  list.className = 't-xref-list';
  for (const e of entries) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<b>${esc(e.label)}</b><span>${esc(e.text || t('(untitled)'))}</span>`;
    b.addEventListener('click', () => {
      close();
      insertRef(ctx, e.id, sel.value as RefStyle);
    });
    list.appendChild(b);
  }
  box.appendChild(list);

  const foot = document.createElement('div');
  foot.className = 't-xref-foot';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 't-btn';
  cancel.textContent = t('Cancel');
  cancel.addEventListener('click', () => close());
  foot.appendChild(cancel);
  box.appendChild(foot);

  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  function close() {
    window.removeEventListener('keydown', onKey, true);
    back.remove();
    // the caret was preserved by mousedown-preventDefault on the toolbar; put
    // it back explicitly for the keyboard path, where focus moved into the box
    if (c) ctx.editor.setCaret(c);
  }
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  window.addEventListener('keydown', onKey, true);
  back.appendChild(box);
  document.body.appendChild(back);
  (list.querySelector('button') as HTMLElement | null)?.focus();
}

// ──────────────────────────────────────────────────────────────── the panel

function paintPanel(host: HTMLElement, ctx: FeatureContext): void {
  const doc = ctx.store.doc;
  const entries = captionEntries(doc.body, docLang(doc));
  const broken = brokenRefs(doc.body);
  host.replaceChildren();

  if (!entries.length) {
    const p = document.createElement('p');
    p.className = 't-hint';
    p.textContent = t('No captions yet. Put the caret in a table and press the caption button; numbering and every reference to it follow automatically.');
    host.appendChild(p);
  }
  for (const e of entries) {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 't-xref-item';
    a.innerHTML = `<b>${esc(e.label)}</b> ${esc(e.text || t('(untitled)'))}`;
    a.addEventListener('click', ev => {
      ev.preventDefault();
      ctx.editor.setCaret({ id: e.id, at: 0 });
      document.querySelector(`[data-id="${CSS.escape(e.id)}"]`)?.scrollIntoView({ block: 'center' });
    });
    host.appendChild(a);
  }
  if (broken.length) {
    const h = document.createElement('p');
    h.className = 't-xref-broken-head';
    h.textContent = t('{n} broken reference(s)').replace('{n}', String(broken.length));
    host.appendChild(h);
    for (const { block } of broken) {
      const a = document.createElement('a');
      a.href = '#';
      a.className = 't-xref-item t-xref-broken';
      a.textContent = block.text.slice(0, 60) || t('(empty paragraph)');
      a.addEventListener('click', ev => {
        ev.preventDefault();
        ctx.editor.setCaret({ id: block.id, at: 0 });
        document.querySelector(`[data-id="${CSS.escape(block.id)}"]`)?.scrollIntoView({ block: 'center' });
      });
      host.appendChild(a);
    }
  }
}

// ─────────────────────────────────────────────────────────────── registration

registerTool({
  id: 'caption', icon: ICON_CAPTION, group: 'insert', order: 30, label: () => t('Caption'),
  get title() { return t('Caption this table or figure'); },
  run: addCaption,
});

registerTool({
  id: 'xref', icon: ICON_XREF, group: 'insert', order: 31, label: () => t('Cross-reference'),
  get title() { return t('Insert a cross-reference to a caption'); },
  run: openPicker,
});

// NO ⋯ entry: this is the same action as the Insert tool above, and a thing
// with two homes teaches that neither is where it lives. Inserting is what the
// Insert menu is for; ⋯ is for document-level actions.

// ⌥⌘R: R for reference. ⌘R is the browser's reload and ⇧⌘R its hard reload, so
// neither is available; Alt keeps it out of both.
registerKey({ key: 'r', mod: true, alt: true, run: openPicker });

registerPanel({
  id: 'figures', order: 30,
  get label() { return t('Figures'); },
  // a VIEW of the Navigate tab: a figure list answers "where is it"
  host: 'figuresHost',
  mount(host, ctx) {
    paintPanel(host, ctx);
    // PanelSpec.update is declared in features.ts and main.ts never calls it,
    // so a panel keeps itself current by subscribing. Said here rather than
    // left as a surprise for the next feature.
    ctx.store.on(() => paintPanel(host, ctx));
  },
  update: paintPanel,
});

// ────────────────────────────────────────────────────────────────────────────
// Until core patch 1 lands, teach TypeScript about the two fields it adds.
// DELETE THIS BLOCK when model.ts carries them.
declare module './model.ts' {
  interface Block {
    caption?: CaptionRef;
    refs?: XrefRef[];
  }
}
