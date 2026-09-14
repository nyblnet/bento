// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The citation/bibliography DATA, and the rules for reading it back from a
// file nobody trusts.
//
// Two shapes, and they mirror two shapes the model already has:
//
//   BibEntry lives in a doc-level map keyed by id — `doc.bibliography` is
//   `doc.footnotes` with more fields. A source outlives the sentence that
//   cites it, gets cited from three paragraphs at once, and must survive the
//   paragraph being rewritten; a note has exactly the same lifetime problem
//   and the model already answered it with a doc-level map.
//
//   CiteRef lives on the block, anchored by character offset — it is NoteRef
//   with a payload. See cite.ts for why this is an ATOM and not a mark.
//
// Everything here is defensive: a `bibliography` field arrives from a JSON
// blob that may have been written by another tool, hand-edited, or crafted.
// `readBibliography` is total — it returns a map, never throws, and drops what
// it cannot understand rather than passing a surprise downstream.

/** The entry types we model. Anything else a .bib names is read as `misc`. */
export type BibType = 'article' | 'book' | 'inproceedings' | 'techreport' | 'misc';

export const BIB_TYPES: readonly BibType[] =
  ['article', 'book', 'inproceedings', 'techreport', 'misc'];

/**
 * The fields an entry may carry. All STRINGS, deliberately.
 *
 * `author` stays in BibTeX's own "Last, First and Last, First" form rather
 * than being split into structured names at import. That keeps the document
 * field human-readable and hand-editable, keeps a round trip through a .bib
 * lossless, and means the ONE place that has to know how a name decomposes is
 * the formatter — which has to know anyway, because IEEE and APA decompose it
 * differently.
 */
export interface BibEntry {
  type: BibType;
  author?: string;
  editor?: string;
  title?: string;
  year?: string;
  month?: string;
  journal?: string;
  booktitle?: string;
  publisher?: string;
  institution?: string;
  school?: string;
  volume?: string;
  number?: string;
  pages?: string;
  address?: string;
  edition?: string;
  series?: string;
  howpublished?: string;
  note?: string;
  url?: string;
  doi?: string;
}

/** The fields we keep. An unknown field is dropped, not carried. */
export const BIB_FIELDS: ReadonlyArray<Exclude<keyof BibEntry, 'type'>> = [
  'author', 'editor', 'title', 'year', 'month', 'journal', 'booktitle',
  'publisher', 'institution', 'school', 'volume', 'number', 'pages',
  'address', 'edition', 'series', 'howpublished', 'note', 'url', 'doi',
];

export type Bibliography = Record<string, BibEntry>;

/**
 * A citation anchored into a block's text.
 *
 * `keys` is a LIST because "(Knuth, 1984; Lamport, 1994)" is one citation with
 * one position, not two citations that happen to be adjacent — and because
 * every style joins a multi-key citation differently, so the grouping has to
 * survive into the formatter.
 */
export interface CiteRef {
  /** character offset into the block's text — the coordinate NoteRef uses */
  at: number;
  keys: string[];
  /** "p. 34", "ch. 2" — authored text, shown inside the citation */
  locator?: string;
  /** author-year only: render "(1984)" because the sentence already said Knuth */
  suppressAuthor?: boolean;
}

export type CiteStyle = 'numeric' | 'author-year';
export const CITE_STYLES: readonly CiteStyle[] = ['numeric', 'author-year'];
export const DEFAULT_STYLE: CiteStyle = 'numeric';

// ────────────────────────────────────────────────────── reading untrusted data

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * How long a single field may be. A citation is rendered into a line of prose;
 * a 4MB "title" is not a title, it is a way to make the layout engine chew.
 */
export const FIELD_MAX = 4000;

/**
 * Characters with no business in a bibliographic field.
 *
 * Control characters and the bidi overrides are the interesting ones: they are
 * INVISIBLE in the panel and load-bearing in the output, so a crafted .bib
 * could make a rendered reference read as a different work than the one the
 * panel shows.
 */
const JUNK = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Whitespace is collapsed for the same reason a title is one line: the
 *  citation is prose, not a code block. */
export const cleanField = (s: string): string =>
  s.replace(JUNK, '').replace(/\s+/g, ' ').trim().slice(0, FIELD_MAX);

/**
 * A citation key, as it may appear in markup and in a data- attribute.
 * BibTeX allows nearly anything; we allow what cannot be mistaken for syntax.
 */
export const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:._+/'-]{0,127}$/;
export const validKey = (k: string): boolean => KEY_RE.test(k);

/** Coerce one untrusted value into an entry, or reject it. */
export function readEntry(v: unknown): BibEntry | undefined {
  if (!isObj(v)) return undefined;
  const type = BIB_TYPES.includes(v.type as BibType) ? v.type as BibType : 'misc';
  const out: BibEntry = { type };
  for (const f of BIB_FIELDS) {
    const raw = v[f];
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const s = cleanField(String(raw));
    if (s) out[f] = s;
  }
  return out;
}

/**
 * Read `doc.bibliography`, whatever is actually there.
 *
 * Absent is the normal case — every file written before this feature existed,
 * and every file with no sources. It reads as an empty map, which is why older
 * files stay readable (format additivity, PLATFORM §3).
 */
export function readBibliography(v: unknown): Bibliography {
  const out: Bibliography = {};
  if (!isObj(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    if (!validKey(k)) continue;
    const e = readEntry(raw);
    if (e) out[k] = e;
  }
  return out;
}

export function readStyle(v: unknown): CiteStyle {
  return CITE_STYLES.includes(v as CiteStyle) ? v as CiteStyle : DEFAULT_STYLE;
}

/** Coerce one untrusted citation reference. Returns undefined if unusable. */
export function readCiteRef(v: unknown, textLen: number): CiteRef | undefined {
  if (!isObj(v) || typeof v.at !== 'number' || !Number.isFinite(v.at)) return undefined;
  if (!Array.isArray(v.keys)) return undefined;
  const keys = (v.keys as unknown[])
    .filter((k): k is string => typeof k === 'string' && validKey(k))
    .slice(0, 64);
  if (!keys.length) return undefined;
  const out: CiteRef = { at: Math.max(0, Math.min(Math.floor(v.at), textLen)), keys };
  const loc = typeof v.locator === 'string' ? cleanField(v.locator).slice(0, 120) : '';
  if (loc) out.locator = loc;
  if (v.suppressAuthor === true) out.suppressAuthor = true;
  return out;
}
