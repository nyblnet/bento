// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// FIELDS — text a document computes rather than stores.
//
// `{{page}}`, `{{title}}`, `{{date}}`, and — the reason this exists —
// `{{Name}}`, bound to a column of a spreadsheet by mail merge (merge.ts).
//
// THE INVARIANT, which is bento/slides' and is not negotiable: the MODEL
// stores the field, never its value. Only rendered output is resolved. That is
// what makes inserting a page renumber every `{{page}}`, editing the document
// properties restyle every letterhead, and a merged letter still a document
// rather than a screenshot of one.
//
// ────────────────────────────────────────────────────────────────────────────
// WHY A FIELD IS AN ATOM HERE AND A TOKEN IN slides
//
// bento/slides keeps `{{page}}` as literal characters inside a text element's
// HTML and substitutes at render (slides/src/render.ts resolveFields). It then
// pays for that with an editing hack: `canvas.startTextEdit` swaps the RESOLVED
// text back to the raw token while the author is in the box, or the first
// keystroke would commit "7" over `{{page}}` and destroy the field.
//
// That hack cannot be ported, and porting it would be the bug. In slides a text
// element is edited as a WHOLE — you enter the box, you leave the box, and the
// swap happens at those two moments. In bento/type the whole document is one
// contentEditable stream, the caret is a MODEL position `(blockId, offset into
// text)` (inline.ts, reason 3), and `editor.ts` reads the block back out of the
// DOM on EVERY keystroke. So resolving into the text would mean:
//
//   · the DOM holding 5 characters where the model holds 8, which makes every
//     caret computation in that paragraph wrong;
//   · marks, footnote anchors, cross-references, citations AND comment ranges
//     — all offsets into that same string — needing to be shifted through the
//     resolution and back again, in an app whose differentiator is that a
//     comment stays on the clause it was made about;
//   · `readBlock` writing the resolved value into the model the moment anyone
//     typed a space in the paragraph.
//
// So a field is an ATOM: it occupies a POSITION in the text and no characters,
// exactly like the footnote marker (`notes`), the cross-reference (`refs`) and
// the citation (`cites`) already do. `Block.fields` is a fourth list of
// `{at, name}` over the same string, moved by the same rule in `spliceText`.
// The editing gotcha is then not handled — it is STRUCTURALLY ABSENT. There is
// nothing in the text to type over, `readBlock` recovers the field from the
// atom, and the redline sees no text change when a value changes, which is
// right: a mail merge is not an edit to the letter.
//
// `{{Name}}` remains the INTERCHANGE syntax — it is what an author types, what
// a chat AI emits into the document JSON, and what a pasted template carries.
// `bindTokens` converts those literal tokens into field atoms; it is an
// explicit, undoable, whole-document act (the Insert menu, and automatically
// when a data source is bound) rather than an autocorrect in the keystroke
// path, because a silent conversion inside a TRACKED document would rewrite
// somebody's recorded insertion.
//
// ────────────────────────────────────────────────────────────────────────────
// WHAT AN UNMATCHED FIELD LOOKS LIKE, AND WHY
//
// A field whose name matches no built-in and no column of the bound row is
// UNBOUND. Three behaviours, deliberately different by surface:
//
//   editor    the field name in a dimmed, dashed chip, with a tooltip saying
//             nothing supplies it. The author must be able to SEE that the
//             letter has a hole in it — this is the state that ruins 200
//             envelopes, so it is the one state that must not be quiet.
//   print,    EMPTY. Not the literal `{{Name}}`, and not "undefined": a reader
//   preview   must never be shown the machinery, and "Dear undefined," is
//             worse than "Dear ,". The visible gap is the report.
//   plain     empty, as print.
//
// A BOUND field renders its value everywhere, in a faint chip in the editor so
// it reads as computed, and as ordinary text on paper.
//
// THE MERGE ROW WINS OVER A BUILT-IN, and this went the other way first.
//
// The reserved-names version was written, and the rig killed it on the FIRST
// realistic fixture: a spreadsheet of debtors with a column called "Company"
// merged into a letter saying `{{Company}}` printed NOTHING, because `company`
// is one of the document's own properties and the built-in answered first. So
// did `Name`... and `Date`, `Title`, `Subject` and `Author` — which is to say
// the reserved list is a list of the most likely column headings in a mail
// merge. That is not an edge case, it is the feature's main road.
//
// The two failures are not symmetrical, which is what settles it. A SHADOWED
// built-in is loud: the running head prints the recipient's company instead of
// the author's, and whoever proofs page one sees it. An UNBOUND merge field is
// silent: it prints nothing at all, reads as a typographic space, and is
// discovered after two hundred envelopes are sealed. So the specific binding —
// the row somebody deliberately attached to this document — takes precedence,
// and merge.ts flags the shadowed names in the dialog at bind time, where the
// author can still rename the column.

import { t } from './i18n.ts';
import { registerMenuItem, registerPaginated, registerTool, type FeatureContext } from './features.ts';
// TYPES ONLY from model.ts, and that is load-bearing rather than tidy: model.ts
// imports `shiftFields` and `readFieldRefs` from HERE (the same arrangement it
// has with xref.ts), so a value import back would be a real evaluation-time
// cycle. merge.ts, which does need model.ts's values, sits on the other side of
// that edge and is the module registry.ts mounts — it imports this one.
import type { Block, TypeDoc } from './model.ts';
// TYPE-ONLY, so it is erased and joins no import graph — see `tocModule` below
// for why that distinction matters in this particular module.
import type { Metrics, Page } from './paginate.ts';

/**
 * A field: a name, at an offset into the block's text.
 *
 * Same shape as `NoteRef`/`XrefRef`, on purpose — one concept, four uses.
 * `pad` is a zero-pad width and is only meaningful on `page`/`pages`
 * (`{{page:2}}` → "06"), which is the one field a running foot needs to line
 * up in a column.
 */
export interface FieldRef { at: number; name: string; pad?: number }

/**
 * Names the document answers itself. Everything else is looked up in the
 * merge row, so a spreadsheet column named anything outside this list just
 * works.
 */
export const BUILTINS = [
  'title', 'subtitle', 'author', 'company', 'subject', 'keywords',
  'date', 'time', 'page', 'pages',
] as const;
export type Builtin = (typeof BUILTINS)[number];
const BUILTIN_SET: ReadonlySet<string> = new Set(BUILTINS);
export const isBuiltin = (name: string): boolean => BUILTIN_SET.has(name.trim().toLowerCase());

/** Only `page`/`pages` take a width; a padded `{{title:3}}` is a typo. */
const PADDABLE: ReadonlySet<string> = new Set(['page', 'pages']);

/**
 * What a field name may be.
 *
 * Restricted at the boundary rather than trusted: a name arrives from a
 * spreadsheet column, from hand-edited JSON, or from a pasted template, and it
 * ends up in an HTML attribute AND in a `{{...}}` token. Braces, angle
 * brackets, quotes, backslashes and the `:` that introduces a pad width are
 * out because they could not survive both forms; control characters are out
 * because they are how something slips past a check that reads only the
 * visible text. Spaces and hyphens are IN -- "Full Name" and "Invoice-No" are
 * what column headers actually look like, and a rule that rejected them would
 * make the feature useless on real spreadsheets. The length cap is so a
 * pathological header cannot make an unreadable document.
 */
const NAME_OK = /^[^{}<>"'\\:\u0000-\u001f\u007f]{1,64}$/;
export const safeFieldName = (raw: string): string | null => {
  const n = (raw ?? '').trim().replace(/\s+/g, ' ');
  return n && NAME_OK.test(n) ? n : null;
};

/** Two names are the same field if they differ only by case or edge space. */
export const fieldKey = (name: string): string => name.trim().toLowerCase();

/**
 * A field's address in the document: which block, and where in it.
 *
 * Needed because `{{page}}` is the one field whose value differs between two
 * occurrences of the SAME field — a running foot repeated through a contract is
 * a different number on every page — so resolution has to be able to say WHICH
 * occurrence it is answering for. Rides the atom as `data-fkey`, so the string
 * renderers (print, preview) can look it up without a DOM.
 */
export const fkeyOf = (blockId: string, at: number): string => `${blockId}:${at}`;

// ───────────────────────────────────────────────────────────── model helpers

export const fieldsOf = (b: Block): FieldRef[] => (b.fields as FieldRef[] | undefined) ?? [];

/**
 * Move field anchors to follow an edit that replaced [at, at+removed) with
 * `added` characters.
 *
 * THE SAME RULE the notes and the cross-references use — `model.ts spliceText`
 * calls this beside `shiftRefs`. Pure and DOM-free so the rig can hold it to
 * that promise without a browser.
 */
export function shiftFields(fields: readonly FieldRef[], at: number, removed: number,
                            added: number): FieldRef[] {
  const end = at + removed;
  const delta = added - removed;
  return fields
    .filter(f => !(f.at > at && f.at < end))
    .map(f => (f.at >= end ? { ...f, at: f.at + delta } : { ...f }))
    .sort((x, y) => x.at - y.at);
}

/** Add a field to a block at an offset. Pure — the caller commits it. */
export function withField(block: Block, at: number, name: string, pad?: number): Block {
  const safe = safeFieldName(name);
  if (!safe) return block;
  const f: FieldRef = {
    at: Math.max(0, Math.min(at, block.text.length)),
    name: safe,
    ...(pad && pad > 0 && PADDABLE.has(fieldKey(safe)) ? { pad: Math.min(9, Math.floor(pad)) } : {}),
  };
  return { ...block, fields: [...fieldsOf(block), f].sort((x, y) => x.at - y.at) };
}

/** Sanitize a `fields` array off a parsed document. Used by model.ts parseDoc. */
export function readFieldRefs(raw: unknown, len: number): FieldRef[] {
  if (!Array.isArray(raw)) return [];
  const out: FieldRef[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const r = f as Partial<FieldRef>;
    const name = typeof r.name === 'string' ? safeFieldName(r.name) : null;
    if (!name || typeof r.at !== 'number' || !Number.isFinite(r.at)) continue;
    const pad = typeof r.pad === 'number' && r.pad > 0 && PADDABLE.has(fieldKey(name))
      ? Math.min(9, Math.floor(r.pad)) : undefined;
    out.push({ at: Math.max(0, Math.min(r.at, len)), name, ...(pad ? { pad } : {}) });
  }
  return out.sort((x, y) => x.at - y.at);
}

// ─────────────────────────────────────────────────────────── {{token}} ⇄ field

/**
 * `{{ Name }}` or `{{page:2}}`. Deliberately the SAME token spelling
 * bento/slides uses, so a document moving between the two apps means the same
 * thing in both, and so a chat AI that has seen one has seen the other.
 */
export const TOKEN = /\{\{\s*([^{}:<>"']{1,64}?)\s*(?::\s*(\d{1,2})\s*)?\}\}/g;

/**
 * Turn every literal `{{token}}` in a block's text into a field atom.
 *
 * Returns null when there is nothing to do, so a caller can commit only the
 * blocks that changed. Pure: it walks the tokens back to front so each splice
 * leaves the offsets of the ones still to come untouched, and it goes through
 * `spliceText` — passed in rather than imported — so marks, notes, refs, cites
 * and the fields already present all move by the one rule that exists for it.
 *
 * `spliceText` arrives as a parameter because model.ts imports THIS module
 * (for `shiftFields`), and importing it back at module scope would be a
 * value-level cycle — the same dance xref.ts already does.
 */
export function tokensToFields(
  block: Block,
  splice: (b: Block, at: number, removed: number, added: string) => Block,
): Block | null {
  const hits = [...block.text.matchAll(TOKEN)];
  if (!hits.length) return null;
  let out = block;
  let changed = false;
  for (let i = hits.length - 1; i >= 0; i--) {
    const m = hits[i];
    const name = safeFieldName(m[1]);
    if (!name) continue;
    const at = m.index!;
    // Cut the characters out FIRST, then anchor the field where they were: the
    // splice moves every other anchor in the block, and a field added before it
    // would be moved by its own removal.
    out = splice(out, at, m[0].length, '');
    out = withField(out, at, name, m[2] ? Number(m[2]) : undefined);
    changed = true;
  }
  return changed ? out : null;
}

/** The document with its `{{tokens}}` converted. Returns the count converted. */
export function bindTokens(
  doc: TypeDoc,
  splice: (b: Block, at: number, removed: number, added: string) => Block,
): number {
  let n = 0;
  doc.body.forEach((b, i) => {
    const next = tokensToFields(b, splice);
    if (!next) return;
    n += fieldsOf(next).length - fieldsOf(b).length;
    doc.body[i] = next;
  });
  return n;
}

/** A field written back as its token — for plain-text export and round-tripping. */
export const tokenOf = (f: FieldRef): string => `{{${f.name}${f.pad ? `:${f.pad}` : ''}}}`;

// ────────────────────────────────────────────────────────────────── resolving

/**
 * What the fields of one rendering resolve against.
 *
 * `page`/`pages` are OPTIONAL because they are not always knowable: the string
 * renderers (preview.ts) draw a document that has not been paginated, and a
 * field nobody can answer must read as unbound rather than as "1".
 */
export interface FieldContext {
  title: string;
  subtitle: string;
  author: string;
  company: string;
  subject: string;
  keywords: string;
  date: Date;
  /**
   * Which page a particular field is ON, by its `fkey` (see `fkeyOf`).
   *
   * A FUNCTION rather than a number, because a document has many pages and the
   * fields on it are not all on the same one — a running foot repeated through
   * a contract is the whole use. It is optional because the page is not always
   * knowable: pagination is a MEASUREMENT (paginate.ts walks line boxes), so
   * before the first pass, and in the string renderers that draw a document
   * nobody has laid out, `{{page}}` has no answer and reads as unbound rather
   * than as a confident "1".
   */
  pageOf?: (fkey: string) => number | undefined;
  pages?: number;
  /** the merge row, keyed by `fieldKey` — see merge.ts */
  row?: Record<string, string>;
  /**
   * A live cell in a sheet this document embeds — see live.ts.
   *
   * Consulted LAST, after the row and the built-ins, so adding this could not
   * change what any existing field resolves to. It only ever answers names that
   * parse as an address (`Q3!Revenue`), and those cannot collide with a
   * built-in or, in practice, with a column heading.
   */
  cell?: (name: string) => string | null;
}

/**
 * Where live cells plug in.
 *
 * A REGISTRATION rather than an import, because live.ts already imports this
 * file for `fieldKey` and importing it back would make a cycle — and because it
 * is how the rest of this app mounts an optional capability (registerPreview,
 * registerPaginated). A build that never loads live.ts resolves every field
 * exactly as it did before.
 */
type CellFactory = (doc: TypeDoc) => (name: string) => string | null;
let cellFactory: CellFactory | null = null;
export function registerCells(f: CellFactory): void { cellFactory = f; }

/** The field values a document supplies about itself. */
export function fieldContext(doc: TypeDoc, over: Partial<FieldContext> = {}): FieldContext {
  const m = doc.meta ?? {};
  const merge = (doc.merge as { row?: Record<string, string> } | undefined);
  return {
    title: doc.title ?? '',
    subtitle: doc.subtitle ?? '',
    author: m.author ?? '',
    company: m.company ?? '',
    subject: m.subject ?? '',
    keywords: m.keywords ?? '',
    date: new Date(),
    ...(merge?.row ? { row: merge.row } : {}),
    ...(cellFactory ? { cell: cellFactory(doc) } : {}),
    ...over,
  };
}

/**
 * A field's value, or NULL when nothing supplies it.
 *
 * null is the whole point of the return type: the three surfaces show an
 * unbound field differently (see this file's header) and every one of them
 * needs to be able to tell "" from "there is no such thing".
 */
export function resolveField(f: FieldRef, ctx: FieldContext, fkey = ''): string | null {
  const key = fieldKey(f.name);
  // THE ROW FIRST. See this file's header: the built-in list is also the list
  // of likely column headings, and losing a merge value is the silent failure
  // while shadowing a document property is the loud one.
  const bound = ctx.row?.[key];
  if (bound !== undefined) return bound;
  const pad = (n: number | undefined): string | null => {
    if (n === undefined) return null;
    return f.pad && f.pad > 0 ? String(n).padStart(f.pad, '0') : String(n);
  };
  switch (key) {
    case 'title': return ctx.title;
    case 'subtitle': return ctx.subtitle;
    case 'author': return ctx.author;
    case 'company': return ctx.company;
    case 'subject': return ctx.subject;
    case 'keywords': return ctx.keywords;
    case 'date': return ctx.date.toLocaleDateString();
    case 'time': return ctx.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    case 'page': return pad(ctx.pageOf?.(fkey));
    case 'pages': return pad(ctx.pages);
    default: return ctx.cell?.(f.name) ?? null;
  }
}

// ───────────────────────────────────────────────────────────────────── atoms

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, c => ESC[c]);

export const FIELD_CLASS = 't-field';
export const UNBOUND_CLASS = 't-field-unbound';

/**
 * The atoms a block contributes, keyed by offset — merged into `blockHtml`'s
 * inject map beside the footnote markers, cross-references and citations.
 *
 * The atom is emitted UNRESOLVED, carrying the field name as its placeholder
 * text; `fillFields` / `fillFieldsHtml` put the value in afterwards. That is
 * `numberXrefs`' arrangement exactly, and it is the reason a field costs the
 * caret nothing: filling writes text and one class, never structure.
 */
export function fieldAtoms(b: Block): Map<number, string> {
  const m = new Map<number, string>();
  for (const f of fieldsOf(b)) {
    const prev = m.get(f.at) ?? '';
    m.set(f.at,
      prev + `<span class="${FIELD_CLASS} ${UNBOUND_CLASS}" data-field="${esc(f.name)}"`
      + ` data-fkey="${esc(fkeyOf(b.id, f.at))}"`
      + (f.pad ? ` data-pad="${f.pad}"` : '')
      + ` contenteditable="false">${esc(f.name)}</span>`);
  }
  return m;
}

/** Is this element one of ours? A field owns no characters, so `readBlock`
 *  must never absorb its value into the block's text. */
export const isFieldAtom = (el: Element): boolean =>
  el.tagName === 'SPAN' && el.classList.contains(FIELD_CLASS);

/** Read field atoms back out of a parsed block — the editor round-trip. */
export function readFields(atoms: Array<{ at: number; el: Element }>): FieldRef[] {
  const out: FieldRef[] = [];
  for (const a of atoms) {
    const el = a.el as HTMLElement;
    const name = el.dataset?.field ? safeFieldName(el.dataset.field) : null;
    if (!name) continue;
    const pad = Number(el.dataset.pad);
    out.push({ name, at: a.at,
               ...(Number.isFinite(pad) && pad > 0 && PADDABLE.has(fieldKey(name)) ? { pad } : {}) });
  }
  return out.sort((x, y) => x.at - y.at);
}

// ────────────────────────────────────────────────────────────────── filling in

// ─────────────────────────────────────────────────────────────── pagination
//
// `{{page}}` is the one field whose answer is a MEASUREMENT rather than a
// lookup, so it arrives the way every measured thing in this app does: after a
// pagination pass, through the `paginated` hook, from the same line-box
// geometry paginate.ts used. Nothing here re-derives page boundaries — it asks
// toc.ts's `pageOfY`, which is the one implementation of "which page is this y
// on", so a field and a table of contents can never disagree about page 7.

let PAGE_AT: Map<string, number> = new Map();
let PAGE_COUNT: number | undefined;

/** What the last pagination pass knows, as a FieldContext fragment. */
export const pagination = (): Partial<FieldContext> =>
  (PAGE_COUNT === undefined
    ? {}
    : { pages: PAGE_COUNT, pageOf: (k: string) => PAGE_AT.get(k) });

/** Reset — for the rig, and for a document that has not been laid out. */
export function setPagination(pages: number | undefined, at: Map<string, number> = new Map()): void {
  PAGE_COUNT = pages;
  PAGE_AT = at;
}

/**
 * toc.ts's `pageOfY`, fetched LAZILY — and the laziness is load-bearing.
 *
 * model.ts imports this module, so anything this module imports at the top
 * joins model.ts's own import graph. toc.ts calls `registerBlockDecorator` at
 * MODULE SCOPE, so a static import here closes the cycle
 * model → fields → toc → render → model and toc runs against a half-evaluated
 * render.ts: measured, `Cannot access 'registerBlockDecorator' before
 * initialization`, at import time, in every build. Deferring the import to the
 * first pagination pass breaks the cycle in time rather than in structure — and
 * the alternative, a second copy of "which page is this y on", is exactly what
 * would let a field and a table of contents disagree about page 7.
 */
let PAGE_OF_Y: Promise<typeof import('./toc.ts')> | null = null;
const tocModule = () => (PAGE_OF_Y ??= import('./toc.ts'));

registerPaginated((ctx, metrics, paper) => {
  const m = metrics as Metrics;
  if (!m?.pages?.length) return;
  void tocModule().then(({ pageOfY }) => measure(ctx, m, paper, pageOfY));
});

function measure(
  ctx: FeatureContext,
  m: Metrics,
  paper: HTMLElement,
  pageOfY: (pages: readonly Page[], y: number) => number | undefined,
) {
  // The SAME origin paginate.ts lineBoxes uses: the host's top plus the page's
  // top margin, so y=0 is the first line's top rather than the top of the paper.
  // An origin that disagreed by the margin would put every field one page out
  // near a boundary — visible only on long documents, which is the worst kind.
  const top0 = paper.getBoundingClientRect().top + (ctx.store.doc.page?.marginTop ?? 0);
  const at = new Map<string, number>();
  for (const el of paper.querySelectorAll<HTMLElement>(`span.${FIELD_CLASS}`)) {
    const k = el.dataset.fkey;
    if (!k) continue;
    const n = pageOfY(m.pages, el.getBoundingClientRect().top - top0);
    if (n !== undefined) at.set(k, n);
  }
  setPagination(m.pages.length, at);
  // Re-fill in place: filling writes text and one class, never structure, so a
  // caret sitting in the paragraph beside a page number does not move.
  fillFields(paper, ctx.store.doc);
}

/**
 * Fill the field atoms in a rendered host — the EDITOR path, called from
 * renderBody after numberXrefs.
 *
 * An unbound field keeps the dashed chip and its own name, which is the only
 * surface that shows one: see the header.
 */
export function fillFields(host: HTMLElement, doc: TypeDoc, over: Partial<FieldContext> = {}): void {
  const ctx = fieldContext(doc, { ...pagination(), ...over });
  for (const el of host.querySelectorAll<HTMLElement>(`span.${FIELD_CLASS}`)) {
    const name = el.dataset.field ?? '';
    const pad = Number(el.dataset.pad);
    const v = resolveField({ name, at: 0, ...(Number.isFinite(pad) && pad > 0 ? { pad } : {}) },
                           ctx, el.dataset.fkey ?? '');
    el.textContent = v === null ? name : v;
    el.classList.toggle(UNBOUND_CLASS, v === null);
    el.title = v === null
      ? t('Nothing supplies “{name}” — it prints as nothing').replace('{name}', name)
      : t('Field: {name}').replace('{name}', name);
  }
}

/**
 * Fill field atoms in a STRING of block HTML — the print and preview path.
 *
 * UNBOUND RESOLVES TO NOTHING HERE, and the whole span goes with it: a reader
 * must not be shown the machinery, and an empty chip would still draw its
 * dashed outline on paper. Pure, so the rig can assert paper and screen agree.
 */
export function fillFieldsHtml(html: string, ctx: FieldContext): string {
  return html.replace(
    new RegExp(`<span class="${FIELD_CLASS}[^"]*"([^>]*)>.*?</span>`, 'g'),
    (_m, attrs: string) => {
      const name = /data-field="([^"]*)"/.exec(attrs)?.[1] ?? '';
      const fkey = /data-fkey="([^"]*)"/.exec(attrs)?.[1] ?? '';
      const padRaw = /data-pad="(\d+)"/.exec(attrs)?.[1];
      // The name came out of an attribute we escaped on the way in; decode the
      // three entities that escaping can produce before looking it up, or a
      // column called "R&D" never matches.
      const plain = name.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const v = resolveField(
        { name: plain, at: 0, ...(padRaw ? { pad: Number(padRaw) } : {}) }, ctx, fkey);
      return v === null ? '' : `<span class="${FIELD_CLASS}">${esc(v)}</span>`;
    });
}

/** A block as prose with its fields resolved — for plain-text export and search. */
export function fieldedText(b: Block, ctx: FieldContext): string {
  const fs = fieldsOf(b);
  if (!fs.length) return b.text;
  let out = '';
  let at = 0;
  for (const f of fs) {
    out += b.text.slice(at, f.at) + (resolveField(f, ctx, fkeyOf(b.id, f.at)) ?? '');
    at = f.at;
  }
  return out + b.text.slice(at);
}

// ─────────────────────────────────────────────────────────────────────── UI

const FIELD_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"'
  + ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M4 7h16M4 7v10M20 7v10M4 17h16"/><path d="M9 12h6"/></svg>';

/** The built-ins, with the label the picker shows. Never a module-level const
 *  of translated strings — this is a function so t() resolves at open time. */
function builtinChoices(): Array<{ name: string; label: string }> {
  return [
    { name: 'title', label: t('Document title') },
    { name: 'subtitle', label: t('Subtitle') },
    { name: 'author', label: t('Author') },
    { name: 'company', label: t('Company') },
    { name: 'subject', label: t('Subject') },
    { name: 'keywords', label: t('Keywords') },
    { name: 'date', label: t('Today’s date') },
    { name: 'time', label: t('Time of day') },
    { name: 'page', label: t('Page number') },
    { name: 'pages', label: t('Total pages') },
  ];
}

/** The merge columns this document is bound to, if any. */
export function boundColumns(doc: TypeDoc): string[] {
  const m = doc.merge as { row?: Record<string, string>; columns?: string[] } | undefined;
  if (Array.isArray(m?.columns)) return m!.columns!.filter(c => typeof c === 'string');
  return m?.row ? Object.keys(m.row) : [];
}

/** Insert a field at the caret. */
export function insertField(ctx: FeatureContext, name: string, pad?: number): void {
  const c = ctx.editor.caret();
  if (!c) { ctx.toast(t('Put the caret where the field goes')); return; }
  const at = c.at;
  ctx.store.breakRun();
  ctx.store.commit(d => {
    const i = d.body.findIndex(b => b.id === c.id);
    if (i < 0) return;
    d.body[i] = withField(d.body[i], at, name, pad);
  }, { scope: { block: c.id } });
  ctx.refresh();
  ctx.editor.setCaret({ id: c.id, at });
}

export function openFieldPicker(ctx: FeatureContext): void {
  const c = ctx.editor.caret();
  if (!c) { ctx.toast(t('Put the caret where the field goes')); return; }

  const back = document.createElement('div');
  back.className = 't-overlay';
  const box = document.createElement('div');
  box.className = 't-dlg t-field-pick';
  box.innerHTML = `<h3>${esc(t('Insert a field'))}</h3>`;

  const list = document.createElement('div');
  list.className = 't-field-list';
  const add = (name: string, label: string, note?: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<b>${esc(label)}</b><span>${esc(note ?? `{{${name}}}`)}</span>`;
    b.addEventListener('click', () => { close(); insertField(ctx, name); });
    list.appendChild(b);
  };

  const cols = boundColumns(ctx.store.doc);
  if (cols.length) {
    const h = document.createElement('div');
    h.className = 't-field-head';
    h.textContent = t('From the data source');
    list.appendChild(h);
    for (const col of cols) add(col, col);
  }
  const h2 = document.createElement('div');
  h2.className = 't-field-head';
  h2.textContent = t('About this document');
  list.appendChild(h2);
  for (const b of builtinChoices()) add(b.name, b.label);
  box.appendChild(list);

  // A name can also be TYPED: a template is often written before its
  // spreadsheet exists, and refusing to name a column that is not there yet
  // would make the two impossible to write in either order.
  const row = document.createElement('div');
  row.className = 't-field-custom';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 't-input';
  input.placeholder = t('or a field name…');
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 't-btn';
  go.textContent = t('Insert');
  const commit = () => {
    const n = safeFieldName(input.value);
    if (!n) { ctx.toast(t('That is not a usable field name')); return; }
    close();
    insertField(ctx, n);
  };
  go.addEventListener('click', commit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
  row.append(input, go);
  box.appendChild(row);

  const foot = document.createElement('div');
  foot.className = 't-dlg-foot';
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
    if (c) ctx.editor.setCaret(c);
  }
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  window.addEventListener('keydown', onKey, true);
  back.appendChild(box);
  document.body.appendChild(back);
  input.focus();
}

registerTool({
  id: 'field',
  icon: FIELD_ICON,
  get title() { return t('Insert a field that the document fills in'); },
  group: 'insert',
  label: () => t('Field'),
  order: 60,
  run: openFieldPicker,
});

registerMenuItem({
  id: 'fields-from-tokens',
  label: () => t('Turn {{…}} tokens into fields'),
  order: 61,
  run: ctx => {
    // Imported lazily so this module stays free of a value-level cycle with
    // model.ts, which imports `shiftFields` from here.
    void import('./model.ts').then(({ spliceText }) => {
      let n = 0;
      ctx.store.breakRun();
      ctx.store.commit(d => { n = bindTokens(d, spliceText); });
      ctx.editor.render();
      ctx.refresh();
      ctx.toast(n
        ? t('{n} field(s) created from tokens').replace('{n}', String(n))
        : t('No {{…}} tokens found in this document'));
    });
  },
});
