// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Citations and a bibliography — the feature that decides whether a thesis or
// a brief can be written in this app at all.
//
// ══════════════════════════════════════════════════ THE MODEL DECISION
//
// A citation is an ATOM: a position in a block's text that occupies no
// characters. It is NOT a mark over a run of text.
//
// The choice looks close, because "(Knuth, 1984)" is visibly a piece of the
// sentence and marks are how this model decorates pieces of sentences. It is
// not close, and the three things this app is actually built on each rule the
// mark out on their own:
//
//   1. THE REDLINE DIFFS PLAIN TEXT, WORD BY WORD. A mark needs characters
//      underneath it, so the mark version has to store the rendered citation —
//      "(Knuth, 1984)" or "[7]" — in `block.text`. Then inserting one citation
//      in paragraph two rewrites the visible text of every later citation, and
//      the redline reports eleven changed words in eleven paragraphs nobody
//      touched. Worse, switching the document from IEEE to APA becomes a
//      global text edit: every citation is a deletion and an insertion, and
//      the review that was supposed to show what counsel changed shows the
//      whole document. As an atom the citation contributes ZERO characters, so
//      re-numbering and re-styling produce an empty diff. That is the whole
//      argument on its own.
//
//   2. SIGNATURES CANONICALISE THE MODEL. A signature covers the canonical
//      content, and a stored rendering means the bytes under the signature
//      depend on the style setting and on the entry's author field. Fix a typo
//      in an author's initial and every signature over the document breaks,
//      for a change that is not in the prose. As an atom, the canonical form
//      holds `{ at, keys }` — the author's actual intent, "cite this work
//      here" — and it does not move when the rendering does.
//
//   3. THE CARET IS (blockId, offset). An atom sits BETWEEN two offsets and
//      can never be entered: arrowing over it is one step, backspace deletes
//      it whole, and there is no position "three characters into the
//      citation". A mark over stored text puts the caret inside a string the
//      author cannot meaningfully edit — type in the middle of "(Knuth," and
//      the model now holds text that no style would ever produce, with a mark
//      claiming it is a citation. The footnote marker already solved exactly
//      this, and `spliceText` in model.ts already carries the offset
//      arithmetic that keeps such an anchor pointing at the right word.
//
// So: `Block.cites?: CiteRef[]`, an offset list beside `Block.notes`, with the
// SOURCES in a doc-level map — `doc.bibliography`, keyed by cite key, exactly
// as `doc.footnotes` is keyed by note id and for exactly the same reason. A
// source outlives the sentence citing it, is cited from three paragraphs at
// once, and must survive the paragraph being rewritten.
//
// EVERYTHING VISIBLE IS DERIVED. The number, the "(Knuth, 1984)", the order of
// the reference list, the disambiguating "1984b" — computed by
// `cite/format.ts` at render time, never stored. A number in the document JSON
// is a bug, not a cache.
//
// ══════════════════════════════════════════════════ NEEDS FROM THE CORE
//
// This module is complete and node-testable as it stands: the BibTeX reader,
// the two styles and the resolution are pure functions, and the panel manages
// entries today. What it cannot do without the core is put an atom in a
// paragraph and have it SURVIVE A SAVE, because parseDoc rebuilds each block
// from named fields and drops what it does not know. Five additions, all
// additive, none of which changes the meaning of an existing file:
//
// ── 1. type/src/model.ts — the reference type, beside NoteRef (~line 60)
//
//     /** A citation anchored INTO a block's text, by character offset. Like a
//      *  footnote marker it is an ATOM: a position, no characters. `keys` is a
//      *  list because "(Knuth, 1984; Lamport, 1994)" is ONE citation. */
//     export interface CiteRef { at: number; keys: string[]; locator?: string;
//                                suppressAuthor?: boolean }
//
// ── 2. type/src/model.ts — the field on Block, beside `notes`
//
//       /** citation references, by offset into `text` */
//       cites?: CiteRef[];
//
//    WHY: without it the field exists at runtime and vanishes on reload.
//
// ── 3. type/src/model.ts — parseDoc, right after the `notes` block (~line 226)
//
//     const cites = Array.isArray(b.cites)
//       ? (b.cites as CiteRef[])
//           .filter(c => isObj(c) && typeof c.at === 'number' && Array.isArray(c.keys))
//           .map(c => ({ ...c, at: Math.max(0, Math.min(c.at, text.length)),
//                        keys: c.keys.filter(k => typeof k === 'string') }))
//           .filter(c => c.keys.length)
//           .sort((x, y) => x.at - y.at)
//       : undefined;
//
//    and beside `if (notes?.length) out.notes = notes;`
//
//     if (cites?.length) out.cites = cites;
//
//    WHY: repairs must be deterministic (two readers must agree on every id),
//    and an out-of-range offset would put a citation past the end of a
//    paragraph. Note there is NO dangling-key sweep here, deliberately: unlike
//    a footnote reference with no note, a citation to a missing entry renders
//    VISIBLY as `[?key]` and is a defect the author must see and fix. Dropping
//    it would silently delete the evidence that a source went missing.
//
// ── 4. type/src/model.ts — spliceText, beside the `notes` block (~line 311)
//
//     if ((block as Block & { cites?: CiteRef[] }).cites?.length) { …same rule… }
//
//    i.e. the identical filter+shift the notes anchors get:
//
//     if (block.cites?.length) {
//       const c = block.cites
//         .filter(x => !(x.at > at && x.at < end))
//         .map(x => x.at >= end ? { ...x, at: x.at + delta } : x);
//       if (c.length) out.cites = c; else delete out.cites;
//     }
//
//    WHY: this is the one function that keeps offsets pointing at the same
//    words through an edit, and its own comment says notes and marks must move
//    TOGETHER or a marker lands in the middle of a word. A third offset list
//    that does not move with them is that bug again.
//
// ── 5. type/src/render.ts — the atom, mirroring `noteMarker`/`isNoteAtom`
//
//     import { citeInject, isCiteAtom, readCiteAtoms } from './cite.ts';
//
//    in `blockHtml`, merge the citation markers into the same inject map the
//    note markers use (a note and a citation CAN share an offset, so it must
//    concatenate rather than overwrite):
//
//     const inject = mergeInject(noteInject(b), citeInject(b));
//
//    in `readBlock`, pass a combined atom test and split the atoms back:
//
//     const { text, marks, atoms } = fromDom(el, el => isNoteAtom(el) || isCiteAtom(el));
//     … const cites = readCiteAtoms(atoms);
//        if (cites.length) out.cites = cites; else delete out.cites;
//
//    and in `renderBody`, after `numberNotes`:
//
//     paintCitations(host, doc);
//
//    WHY: `numberNotes` is already the house pattern for derived numbering —
//    walk the rendered output in document order and put the derived value in
//    the marker. `paintCitations` is the same function for citations, and it
//    lives here rather than in render.ts because it needs the styles.
//
// UNTIL THEN: the panel, the import, the styles and the reference list all
// work; inserting a citation into a paragraph works for the session and is
// lost on reload, because parseDoc drops the field. That is the whole gap.
//
// ══════════════════════════════════════════════════ FORMAT ADDITIVITY
//
// `doc.bibliography` and `doc.citeStyle` are plain extra keys. parseDoc
// already spreads unknown fields through (`...(json as object)`), and save
// re-serialises the whole object, so a file written here opens in an older
// build, edits, and saves with its bibliography intact — the older build never
// looks at the key and never drops it. An older FILE opened here has neither
// key: `readBibliography(undefined)` is an empty map and `readStyle(undefined)`
// is `numeric`. Nothing is required, nothing is migrated. (PLATFORM §3.)

import { registerKey, registerMenuItem, registerPanel, registerTool, type FeatureContext } from './features.ts';
import { t } from './i18n.ts';
import type { Block, TypeDoc } from './model.ts';
import { parseBibtex } from './cite/bibtex.ts';
import {
  bibliography, citationText, missingText, referenceText, resolve,
  type BibLine, type CitedBlock, type Resolution,
} from './cite/format.ts';
import {
  cleanField, readBibliography, readCiteRef, readStyle, validKey,
  type BibEntry, type Bibliography, type CiteRef, type CiteStyle,
} from './cite/types.ts';

export { parseBibtex, decodeTex } from './cite/bibtex.ts';
export * from './cite/format.ts';
export * from './cite/types.ts';

/** A block carrying the field the core patch adds. Cast, not augmented, so
 *  applying that patch removes these casts instead of colliding with them. */
type CiteBlock = Block & { cites?: CiteRef[] };

// ───────────────────────────────────────────────────── reading the document

export const docBib = (doc: TypeDoc): Bibliography => readBibliography(doc.bibliography);
export const docStyle = (doc: TypeDoc): CiteStyle => readStyle(doc.citeStyle);

/** Blocks as the resolver wants them: id plus (validated) citation refs. */
const citedBody = (doc: TypeDoc): CitedBlock[] =>
  doc.body.map(b => {
    const raw = (b as CiteBlock).cites;
    if (!Array.isArray(raw)) return { id: b.id };
    const cites = raw.map(r => readCiteRef(r, b.text.length)).filter((r): r is CiteRef => !!r);
    return cites.length ? { id: b.id, cites } : { id: b.id };
  });

/** The whole derived answer for one document. Cheap; recomputed, never cached. */
export const resolveDoc = (doc: TypeDoc): Resolution =>
  resolve(citedBody(doc), docBib(doc), docStyle(doc));

/** Which keys are cited, and how often. Drives the panel's "uncited" hint. */
export function citeCounts(doc: TypeDoc): Map<string, number> {
  const n = new Map<string, number>();
  for (const b of citedBody(doc)) for (const c of b.cites ?? []) {
    for (const k of c.keys) n.set(k, (n.get(k) ?? 0) + 1);
  }
  return n;
}

// ───────────────────────────────────────────────────────────────── the atom

export const CITE_CLASS = 't-cite';

/** Does this element stand for a citation? The core's `fromDom` atom test. */
export const isCiteAtom = (el: Element): boolean =>
  el.tagName === 'SPAN' && el.classList.contains(CITE_CLASS);

const escAttr = (s: string) => s.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * The marker's HTML.
 *
 * It carries NO rendered text — `paintCitations` fills it in from the model
 * after the block is in the DOM, which is what makes the rendering derived
 * rather than baked into the markup the editor reads back. `contenteditable`
 * is off so the browser treats it as one indivisible thing, exactly as the
 * footnote marker does.
 *
 * Every attribute value is escaped, and keys are validated on the way in and
 * on the way out — this string is built from a .bib somebody pasted.
 */
export function citeMarker(ref: CiteRef): string {
  const keys = ref.keys.filter(validKey);
  if (!keys.length) return '';
  const loc = ref.locator ? ` data-loc="${escAttr(ref.locator)}"` : '';
  const sup = ref.suppressAuthor ? ' data-sup="1"' : '';
  return `<span class="${CITE_CLASS}" data-cite="${escAttr(keys.join(' '))}"${loc}${sup}` +
         ` contenteditable="false">…</span>`;
}

/** Offset → marker, for the renderer's `inject` map. */
export function citeInject(b: Block): Map<number, string> {
  const out = new Map<number, string>();
  for (const ref of (b as CiteBlock).cites ?? []) {
    const html = citeMarker(ref);
    if (html) out.set(ref.at, (out.get(ref.at) ?? '') + html);
  }
  return out;
}

/**
 * Merge two inject maps.
 *
 * `toHtml` takes ONE marker string per offset, and a footnote and a citation
 * can legitimately land on the same character — "…as held in Smith.[3](Knuth,
 * 1984)". A plain `new Map([...a, ...b])` silently keeps only the second, so
 * the footnote would disappear from the rendering and then from the model the
 * next time the block was read back.
 */
export function mergeInject(...maps: Array<Map<number, string> | undefined>): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of maps) for (const [at, html] of m ?? []) out.set(at, (out.get(at) ?? '') + html);
  return out;
}

/** Read citation atoms back out of a rendered block (the `readBlock` half). */
export function readCiteAtoms(atoms: ReadonlyArray<{ at: number; el: Element }>): CiteRef[] {
  const out: CiteRef[] = [];
  for (const a of atoms) {
    if (!isCiteAtom(a.el)) continue;
    const keys = (a.el.getAttribute('data-cite') ?? '').split(' ').filter(validKey);
    if (!keys.length) continue;
    const ref: CiteRef = { at: a.at, keys };
    const loc = cleanField(a.el.getAttribute('data-loc') ?? '');
    if (loc) ref.locator = loc;
    if (a.el.getAttribute('data-sup') === '1') ref.suppressAuthor = true;
    out.push(ref);
  }
  return out.sort((x, y) => x.at - y.at);
}

/**
 * Put the derived citation text into every marker under `host`.
 *
 * The same job `numberNotes` does, and the same rule: walk the rendered output
 * and write what the model says it should say. Nothing is read back from here,
 * so a repaint can never change the document.
 *
 * `textContent`, never innerHTML — the text is built from an author field that
 * came out of a pasted .bib, and this is the seam where it would otherwise
 * become markup.
 */
export function paintCitations(host: ParentNode, doc: TypeDoc): Resolution {
  const res = resolveDoc(doc);
  const bib = docBib(doc);
  for (const el of host.querySelectorAll<HTMLElement>(`span.${CITE_CLASS}`)) {
    const keys = (el.dataset.cite ?? '').split(' ').filter(validKey);
    if (!keys.length) { el.textContent = missingText('?'); continue; }
    const ref: CiteRef = { at: 0, keys };
    if (el.dataset.loc) ref.locator = el.dataset.loc;
    if (el.dataset.sup === '1') ref.suppressAuthor = true;
    el.textContent = citationText(ref, res, bib);
    // A missing entry has to be VISIBLE, not just present in a panel nobody
    // opened. The class tints it; the text already names the key.
    el.classList.toggle('miss', keys.some(k => !bib[k]));
    el.title = keys.map(k => bib[k] ? referenceText(bib[k], res.style, res.suffix[k] ?? '')
                                    : `${k} — no entry in this document`).join('\n');
  }
  return res;
}

// ─────────────────────────────────────────────────────────────── mutations

/** Merge parsed entries into the document. Returns what happened, for a toast. */
export function importBibtex(ctx: FeatureContext, src: string): { added: number; replaced: number; skipped: string[] } {
  const { entries, skipped } = parseBibtex(src);
  let added = 0, replaced = 0;
  if (entries.length) {
    ctx.store.commit(doc => {
      const bib = docBib(doc);
      for (const { key, entry } of entries) {
        if (bib[key]) replaced++; else added++;
        bib[key] = entry;
      }
      doc.bibliography = bib;
    });
  }
  return { added, replaced, skipped };
}

export function setCiteStyle(ctx: FeatureContext, style: CiteStyle): void {
  ctx.store.commit(doc => { doc.citeStyle = style; });
  ctx.refresh();
}

export function removeEntry(ctx: FeatureContext, key: string): void {
  ctx.store.commit(doc => {
    const bib = docBib(doc);
    delete bib[key];
    doc.bibliography = bib;
  });
  ctx.refresh();
}

/**
 * Insert a citation at the caret.
 *
 * Scoped to the block, because that is all it touches — the doc-level
 * bibliography is untouched here, which is exactly why a citation and its
 * source have separate lifetimes.
 */
export function insertCitation(ctx: FeatureContext, keys: string[], locator?: string): boolean {
  const c = ctx.editor.caret();
  if (!c) { ctx.toast(t('Put the caret where the citation goes first')); return false; }
  const clean = keys.filter(validKey);
  if (!clean.length) return false;
  ctx.store.commit(doc => {
    const b = doc.body.find(x => x.id === c.id) as CiteBlock | undefined;
    if (!b) return;
    const ref: CiteRef = { at: Math.min(c.at, b.text.length), keys: clean };
    const loc = cleanField(locator ?? '');
    if (loc) ref.locator = loc;
    b.cites = [...(b.cites ?? []), ref].sort((x, y) => x.at - y.at);
  }, { scope: { block: c.id } });
  ctx.refresh();
  return true;
}

// ─────────────────────────────────────────────────────────────── the chrome

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 5h11"/><path d="M4 10h11"/><path d="M4 15h7"/>' +
  '<path d="M17.5 14.5 19 19l-1.5-1-1.5 1z"/><path d="M17.5 14.5V9"/></svg>';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

const btn = (label: string, onClick: () => void, cls = 't-cite-mini'): HTMLButtonElement => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

/** A modal, built the way about.ts builds one so the two read as one app. */
function dialog(title: string, body: HTMLElement, footer: HTMLElement[]): () => void {
  const back = el('div', 't-overlay');
  const card = el('div', 't-dlg');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', title);
  const h = el('h2', 't-dlg-h', title);
  const foot = el('div', 't-dlg-foot');
  foot.append(...footer);
  card.append(h, body, foot);
  back.append(card);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  back.addEventListener('click', e => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  return close;
}

/** Paste-BibTeX. The import reports what it skipped — silence would be a lie. */
function openImport(ctx: FeatureContext, done: () => void): void {
  const body = el('div');
  body.append(el('p', 't-about-blurb', t(
    'Paste BibTeX below. @article, @book, @inproceedings, @techreport and @misc ' +
    'are modelled; any other type is imported as @misc so it still cites.')));
  const ta = el('textarea', 't-cite-paste');
  ta.rows = 12;
  ta.spellcheck = false;
  ta.placeholder = '@book{knuth1984,\n  author = {Knuth, Donald E.},\n  title  = {The {TeX}book},\n  year   = {1984}\n}';
  body.append(ta);
  const report = el('div', 't-note');
  body.append(report);
  const close = dialog(t('Import BibTeX'), body, [
    btn(t('Cancel'), () => close(), 't-cite-btn'),
    btn(t('Import'), () => {
      const { added, replaced, skipped } = importBibtex(ctx, ta.value);
      if (!added && !replaced) {
        report.textContent = skipped.length
          ? `${t('Nothing was imported.')} ${skipped.join(' \u00b7 ')}`
          : t('Nothing that looks like a BibTeX entry.');
        return;
      }
      ctx.toast(t('{added} added, {replaced} updated', { added, replaced }));
      if (skipped.length) ctx.toast(skipped[0]);
      done();
      ctx.refresh();
      close();
    }, 't-cite-btn t-cite-go'),
  ]);
  setTimeout(() => ta.focus(), 0);
}

/** Pick a source and drop a citation at the caret, without typing a key. */
function openPicker(ctx: FeatureContext): void {
  const bib = docBib(ctx.store.doc);
  const keys = Object.keys(bib).sort();
  const body = el('div');
  if (!keys.length) {
    body.append(el('p', 't-about-blurb', t('This document has no sources yet. Import some BibTeX first.')));
    const close0 = dialog(t('Insert citation'), body, [btn(t('Close'), () => close0(), 't-cite-btn')]);
    return;
  }
  const search = el('input', 't-cite-search');
  search.type = 'search';
  search.placeholder = t('Search author, title or key');
  const list = el('div', 't-cite-pick');
  const chosen = new Set<string>();
  const locator = el('input', 't-cite-search');
  locator.placeholder = t('Page or section, optional — e.g. p. 34');

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    for (const key of keys) {
      const e = bib[key];
      const hay = `${key} ${e.author ?? ''} ${e.title ?? ''} ${e.year ?? ''}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      const row = el('label', 't-cite-row' + (chosen.has(key) ? ' on' : ''));
      const box = el('input');
      box.type = 'checkbox';
      box.checked = chosen.has(key);
      box.addEventListener('change', () => {
        if (box.checked) chosen.add(key); else chosen.delete(key);
        row.classList.toggle('on', box.checked);
      });
      const txt = el('span');
      txt.append(el('b', '', `${e.author ?? e.title ?? key}${e.year ? ` (${e.year})` : ''}`));
      txt.append(el('i', '', e.title ?? ''));
      txt.append(el('code', '', key));
      row.append(box, txt);
      list.append(row);
    }
    if (!list.children.length) list.append(el('p', 't-note', t('Nothing matches.')));
  };
  search.addEventListener('input', draw);
  draw();
  body.append(search, list, locator);

  const close = dialog(t('Insert citation'), body, [
    btn(t('Cancel'), () => close(), 't-cite-btn'),
    btn(t('Insert'), () => {
      if (!chosen.size) return;
      // Sorted, so the same set of sources always produces the same reference —
      // "(Knuth, 1984; Lamport, 1994)" must not depend on click order.
      if (insertCitation(ctx, [...chosen].sort(), locator.value)) close();
    }, 't-cite-btn t-cite-go'),
  ]);
  setTimeout(() => search.focus(), 0);
}

/** The panel: sources, the reference list as it will print, and the trouble. */
function mountPanel(host: HTMLElement, ctx: FeatureContext): void {
  const draw = () => {
    const doc = ctx.store.doc;
    const bib = docBib(doc);
    const res = resolveDoc(doc);
    const counts = citeCounts(doc);
    host.replaceChildren();

    // ── controls
    const bar = el('div', 't-cite-bar');
    const sel = el('select', 't-cite-style');
    for (const [value, label] of [['numeric', t('Numeric [1] — IEEE-ish')],
                                  ['author-year', t('Author–year — APA-ish')]] as const) {
      const o = el('option', '', label);
      o.value = value;
      sel.append(o);
    }
    sel.value = docStyle(doc);
    sel.addEventListener('change', () => setCiteStyle(ctx, readStyle(sel.value)));
    bar.append(sel);
    bar.append(btn(t('Paste BibTeX…'), () => openImport(ctx, draw), 't-cite-btn'));
    bar.append(btn(t('Cite…'), () => openPicker(ctx), 't-cite-btn'));
    host.append(bar);

    // ── citations pointing at nothing, first, because they are a defect
    if (res.missing.length) {
      const warn = el('div', 't-cite-miss');
      warn.append(el('div', 't-cite-miss-h', t('Cited but not in this document')));
      for (const k of res.missing) warn.append(el('code', '', k));
      warn.append(el('p', 't-note', t('These render as [?key] in the document so they cannot be missed.')));
      host.append(warn);
    }

    const keys = Object.keys(bib).sort();
    if (!keys.length) {
      host.append(el('p', 't-note', t('No sources yet. Paste a .bib file to get started.')));
      return;
    }

    // ── the sources themselves
    host.append(el('h3', 't-cite-h', t('Sources ({n})', { n: keys.length })));
    for (const key of keys) {
      const card = el('div', 't-card');
      const who = el('div', 'who');
      who.append(el('code', '', key));
      const n = counts.get(key) ?? 0;
      who.append(el('span', n ? 't-ok' : 't-warn',
        n ? t('cited {n} times', { n }) : t('not cited')));
      card.append(who);
      card.append(el('div', 'what', referenceText(bib[key], res.style, res.suffix[key] ?? '')));
      const btns = el('div', 'btns');
      btns.append(btn(t('Cite here'), () => { insertCitation(ctx, [key]); }, ''));
      btns.append(btn(t('Remove'), () => {
        if (counts.get(key)
            && !confirm(t('{key} is cited in this document. Remove it anyway?', { key }))) return;
        removeEntry(ctx, key);
        draw();
      }, ''));
      card.append(btns);
      host.append(card);
    }

    // ── the list as it will print, in the style's own order
    const lines: BibLine[] = bibliography(res, bib);
    host.append(el('h3', 't-cite-h', t('References, as they will print')));
    if (!lines.length) {
      host.append(el('p', 't-note', t('Nothing is cited yet, so the list is empty.')));
      return;
    }
    const list = el('div', 't-cite-list');
    for (const line of lines) {
      const row = el('div', 't-cite-ref');
      if (line.label) row.append(el('span', 'n', line.label));
      row.append(el('span', 'r', line.text));
      list.append(row);
    }
    host.append(list);
  };

  // The panel repaints on every document change, and repaints the CITATIONS in
  // the document with it. Once render.ts calls `paintCitations` itself (see
  // NEEDS FROM THE CORE §5) this second call becomes redundant and harmless —
  // it is idempotent, because it only ever writes derived text into markers.
  ctx.store.on(() => {
    draw();
    paintCitations(document, ctx.store.doc);
  });
  draw();
  paintCitations(document, ctx.store.doc);
}

registerPanel({
  id: 'cite',
  get label() { return t('Sources'); },
  host: 'citeHost',
  order: 40,
  mount: mountPanel,
  update: (_host, ctx) => { paintCitations(document, ctx.store.doc); },
});

registerTool({
  id: 'cite',
  icon: ICON,
  get title() { return t('Insert citation'); },
  group: 'insert',
  label: () => t('Citation'),
  order: 40,
  run: openPicker,
});

registerMenuItem({
  id: 'cite-import',
  get label() { return t('Import BibTeX…'); },
  order: 40,
  run: ctx => openImport(ctx, () => {}),
});

// ⌘⇧C — beside ⌘⇧A for a footnote, and not ⌘C, which is copy.
registerKey({ key: 'c', mod: true, shift: true, run: openPicker });

/** Escape hatch for scripts and agents, matching `window.bento.comments()`. */
export const citeApi = (doc: TypeDoc) => ({
  style: docStyle(doc),
  entries: docBib(doc) as Record<string, BibEntry>,
  resolution: resolveDoc(doc),
  references: bibliography(resolveDoc(doc), docBib(doc)),
});
