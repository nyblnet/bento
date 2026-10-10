// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The two styles, and the numbering that feeds them.
//
// EVERYTHING HERE IS DERIVED. Nothing this file computes is ever written back
// into the document: not a number, not a formatted reference, not the sort
// order of the bibliography. `resolve()` reads the body and the entry map and
// returns a fresh answer every time, which is the only arrangement in which
// inserting a citation into paragraph two can renumber the eleven after it —
// and the only one in which switching from IEEE to APA is a preference rather
// than a rewrite of the file.
//
// It is also what keeps the redline honest: a stored "[7]" would diff as a
// changed word every time a citation was inserted earlier in the document,
// and a stored "(Knuth, 1984)" would diff as a whole rewritten phrase the
// moment somebody fixed a typo in the author field.
//
// PURE. No DOM, no `t()`. Bibliographic output is CONTENT, not chrome: a
// reference list is set in the language of the source, not in the language of
// the reader's menus, and the same document read in Tokyo and in Lyon must
// print the same references. So nothing in this file is translated.
//
// TWO STYLES, deliberately not a citation-style engine. `numeric` reads as
// IEEE and `author-year` reads as APA 7th; they are hand-written, not driven
// by a style file, because two styles done properly beat a half-built CSL
// interpreter that gets every style slightly wrong.

import type { BibEntry, Bibliography, CiteRef, CiteStyle } from './types.ts';

// ─────────────────────────────────────────────────────────────────── names

export interface Name {
  last: string;
  first: string;
  /** "von", "van der", "de la" — kept with the surname when sorting */
  von: string;
  /** "Jr.", "III" */
  jr: string;
}

export interface NameList { names: Name[]; etAl: boolean }

const isParticle = (w: string) => !!w && w[0] === w[0].toLowerCase() && /[a-z]/.test(w[0]);

/**
 * Split BibTeX's `author` field into names.
 *
 * Both orderings, as BibTeX defines them:
 *   "Donald E. Knuth"          → First von Last
 *   "Knuth, Donald E."         → von Last, First
 *   "de la Vega, Jr., Maria"   → von Last, Jr, First
 *
 * `and others` sets the et-al flag, which is how a .bib says "and the rest".
 *
 * A COMMA WITH NOTHING AFTER IT means a literal name: `author = {World Health
 * Organization,}` gives one name whose surname is the whole string and which
 * therefore never gets initialised or inverted. That is the supported way to
 * write an institutional author — BibTeX's brace-protection cannot survive
 * into the model, because the model stores decoded text and decoding is what
 * takes the braces off.
 */
export function parseNames(field: string | undefined): NameList {
  const out: NameList = { names: [], etAl: false };
  if (!field) return out;
  // 64 names is more than any real paper and bounds the work
  for (const raw of field.split(/\s+and\s+/i).slice(0, 64)) {
    const chunk = raw.trim();
    if (!chunk) continue;
    if (chunk.toLowerCase() === 'others') { out.etAl = true; continue; }
    out.names.push(parseName(chunk));
  }
  return out;
}

function parseName(s: string): Name {
  const parts = s.split(',').map(p => p.trim());
  if (parts.length > 1) {
    const first = parts.length > 2 ? parts.slice(2).join(', ') : parts[1];
    const jr = parts.length > 2 ? parts[1] : '';
    const { von, last } = splitVon(parts[0]);
    return { last, first, von, jr };
  }
  // "First von Last", BibTeX's own rule: the von part runs from the FIRST
  // lowercase-initial word to the LAST one before the surname. Anything before
  // it is given names, anything after it is the surname.
  //
  // A first version instead grew the surname leftwards through particles,
  // which put "van" in `last` and left `von` empty — so "Ludwig van Beethoven"
  // sorted under V in one place and B in another.
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return { last: s, first: '', von: '', jr: '' };
  let p = 0;
  while (p < words.length - 1 && !isParticle(words[p])) p++;
  if (!isParticle(words[p])) {
    return { last: words[words.length - 1], first: words.slice(0, -1).join(' '), von: '', jr: '' };
  }
  let q = p;
  for (let k = p; k < words.length - 1; k++) if (isParticle(words[k])) q = k;
  return {
    last: words.slice(q + 1).join(' '),
    first: words.slice(0, p).join(' '),
    von: words.slice(p, q + 1).join(' '),
    jr: '',
  };
}

function splitVon(s: string): { von: string; last: string } {
  const words = s.split(/\s+/).filter(Boolean);
  let k = 0;
  while (k < words.length - 1 && isParticle(words[k])) k++;
  return { von: words.slice(0, k).join(' '), last: words.slice(k).join(' ') };
}

/** "Donald E." → "D. E."; "Jean-Paul" → "J.-P." */
export function initials(first: string): string {
  return first.split(/\s+/).filter(Boolean)
    .map(w => w.split('-').map(p => p ? `${p[0].toUpperCase()}.` : '').filter(Boolean).join('-'))
    .join(' ');
}

const join = (...bits: Array<string | undefined>) => bits.filter(Boolean).join(' ');

/** "Knuth, D. E." — APA's reference-list form. */
const apaName = (n: Name): string => {
  const surname = join(n.von, n.last);
  const rest = [initials(n.first), n.jr].filter(Boolean).join(', ');
  return rest ? `${surname}, ${rest}` : surname;
};

/** "D. E. Knuth" — IEEE's. */
const ieeeName = (n: Name): string => {
  const surname = join(n.von, n.last, n.jr && n.jr.replace(/\.$/, '') + '.');
  const ini = initials(n.first);
  return ini ? `${ini} ${surname}` : surname;
};

/** The family name alone — what an author–year citation shows. */
export const familyName = (n: Name): string => join(n.von, n.last);

// ────────────────────────────────────────────────────────── sorting, stably

/**
 * A sort key that does not move when the reader's locale does.
 *
 * `localeCompare` would order the bibliography differently in Stockholm and in
 * Madrid, which means the same file prints differently for two readers — and
 * in a numeric style the NUMBERS would differ too, so a colleague's "see [4]"
 * would point at the wrong work. Fold to ASCII-ish and compare code units.
 */
export const sortKey = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036F]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

const entrySortKey = (e: BibEntry | undefined): string => {
  if (!e) return '\uFFFF';        // an entry that vanished sorts last, not first
  const names = parseNames(e.author ?? e.editor);
  const who = names.names.length ? names.names.map(familyName).join(' ') : (e.title ?? '');
  return sortKey(who);
};

// ────────────────────────────────────────────────────────────── resolution

/** Where a citation sits, in document order. */
export interface CiteSite { blockId: string; ref: CiteRef }

/** A block, as far as this module needs to know. */
export interface CitedBlock { id: string; cites?: CiteRef[] }

/** Citations in document order, each block's own in offset order. */
export function collectCites(body: readonly CitedBlock[]): CiteSite[] {
  const out: CiteSite[] = [];
  for (const b of body) {
    if (!b.cites?.length) continue;
    for (const ref of [...b.cites].sort((x, y) => x.at - y.at)) out.push({ blockId: b.id, ref });
  }
  return out;
}

export interface Resolution {
  style: CiteStyle;
  /** the keys the bibliography prints, in the order it prints them */
  order: string[];
  /** numeric style: key → its number. Empty for author–year. */
  number: Record<string, number>;
  /** author–year: key → 'a' | 'b' | … when one author has two works in a year */
  suffix: Record<string, string>;
  /** cited keys with no entry behind them, first-cited first */
  missing: string[];
}

/**
 * Work out the numbering and the bibliography order for one document.
 *
 * Numeric numbers by FIRST APPEARANCE, which is what IEEE does and what makes
 * "[1]" the first reference a reader meets. Author–year sorts alphabetically,
 * because that is how a reader finds "Knuth, 1984" in the list.
 */
export function resolve(body: readonly CitedBlock[], bib: Bibliography, style: CiteStyle): Resolution {
  const res: Resolution = { style, order: [], number: {}, suffix: {}, missing: [] };
  const firstSeen: string[] = [];
  const seen = new Set<string>();
  const missing = new Set<string>();
  for (const site of collectCites(body)) {
    for (const key of site.ref.keys) {
      if (bib[key]) {
        if (!seen.has(key)) { seen.add(key); firstSeen.push(key); }
      } else if (!missing.has(key)) { missing.add(key); res.missing.push(key); }
    }
  }

  if (style === 'numeric') {
    res.order = firstSeen;
    firstSeen.forEach((k, i) => { res.number[k] = i + 1; });
    return res;
  }

  res.order = [...firstSeen].sort((a, b) => {
    const ka = entrySortKey(bib[a]), kb = entrySortKey(bib[b]);
    if (ka !== kb) return ka < kb ? -1 : 1;
    const ya = bib[a]?.year ?? '', yb = bib[b]?.year ?? '';
    if (ya !== yb) return ya < yb ? -1 : 1;
    const ta = sortKey(bib[a]?.title ?? ''), tb = sortKey(bib[b]?.title ?? '');
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;                      // the key, so ties are stable
  });

  // Disambiguation letters: two works by the same author in the same year are
  // 1984a and 1984b, in the order the list prints them.
  const groups = new Map<string, string[]>();
  for (const k of res.order) {
    const g = `${entrySortKey(bib[k])}${bib[k]?.year ?? ''}`;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(k);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.forEach((k, i) => { res.suffix[k] = letters(i); });
  }
  return res;
}

/** 0 → a, 25 → z, 26 → aa. */
function letters(i: number): string {
  let s = '';
  let n = i;
  do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// ─────────────────────────────────────────────────────── the in-text citation

/**
 * How a MISSING entry shows up.
 *
 * Visibly, and in both styles. A citation whose entry was deleted, or whose
 * key was mistyped, is a defect in the document and the author has to be able
 * to see it — in the paginated view, in print, and in the PDF. Rendering
 * nothing would hide it until a reviewer noticed a sentence that cites the
 * air; rendering "[?]" without the key would hide WHICH one.
 */
export const missingText = (key: string): string => `[?${key}]`;

/** The text of one citation, in the document's style. */
export function citationText(ref: CiteRef, res: Resolution, bib: Bibliography): string {
  const keys = ref.keys;
  if (!keys.length) return '';
  if (res.style === 'numeric') {
    const bits = keys.map(k => {
      if (!bib[k]) return missingText(k);
      const inner = ref.locator ? `${res.number[k]}, ${ref.locator}` : String(res.number[k]);
      return `[${inner}]`;
    });
    return bits.join(', ');
  }
  // author–year: the list prints in bibliography order, so the reader can walk
  // straight from "(Knuth, 1984; Lamport, 1994)" down the alphabet
  const rank = new Map(res.order.map((k, i) => [k, i]));
  const ordered = [...keys].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
  const bits = ordered.map(k => {
    const e = bib[k];
    if (!e) return missingText(k);
    const year = (e.year || 'n.d.') + (res.suffix[k] ?? '');
    const who = ref.suppressAuthor ? '' : inTextAuthors(e);
    return [who, year, ref.locator].filter(Boolean).join(', ');
  });
  return `(${bits.join('; ')})`;
}

/**
 * APA's et-al rule, 7th edition: one or two authors are both named, three or
 * more collapse to the first plus "et al." from the FIRST citation onward.
 * (The 6th edition spelled out three on first use; the 7th stopped, because
 * nobody could remember which citation was the first one.)
 */
export function inTextAuthors(e: BibEntry): string {
  const { names, etAl } = parseNames(e.author ?? e.editor);
  if (!names.length) return e.title ?? '';
  if (etAl || names.length > 2) return `${familyName(names[0])} et al.`;
  if (names.length === 2) return `${familyName(names[0])} & ${familyName(names[1])}`;
  return familyName(names[0]);
}

// ───────────────────────────────────────────────────────────── the list

export interface BibLine {
  key: string;
  /** the numeric style's label, "[3]"; empty in author–year */
  label: string;
  /** the reference itself, as plain text */
  text: string;
}

/** The bibliography, in the style's own order and format. */
export function bibliography(res: Resolution, bib: Bibliography): BibLine[] {
  return res.order.map(key => ({
    key,
    label: res.style === 'numeric' ? `[${res.number[key]}]` : '',
    text: referenceText(bib[key], res.style, res.suffix[key] ?? ''),
  }));
}

const dash = (s: string | undefined): string =>
  (s ?? '').replace(/\s*(?:--|-|–|—)\s*/g, '–');

const period = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

const link = (e: BibEntry): string =>
  e.doi ? `https://doi.org/${e.doi.replace(/^https?:\/\/doi\.org\//i, '')}` : (e.url ?? '');

/** One reference, formatted. `suffix` is the author–year disambiguation letter. */
export function referenceText(e: BibEntry | undefined, style: CiteStyle, suffix = ''): string {
  if (!e) return '';
  return style === 'numeric' ? ieeeReference(e) : apaReference(e, suffix);
}

// ── IEEE-ish

function ieeeAuthors(e: BibEntry): string {
  const { names, etAl } = parseNames(e.author ?? e.editor);
  if (!names.length) return '';
  // IEEE names up to six authors and then gives up; that ceiling is the style's
  const shown = names.length > 6 || etAl ? names.slice(0, 1) : names;
  const rendered = shown.map(ieeeName);
  if (names.length > 6 || etAl) return `${rendered[0]} et al.`;
  if (rendered.length === 1) return rendered[0];
  if (rendered.length === 2) return `${rendered[0]} and ${rendered[1]}`;
  return `${rendered.slice(0, -1).join(', ')}, and ${rendered[rendered.length - 1]}`;
}

/**
 * Pieces joined by ", ", except after a quoted title — which already carries
 * its own comma INSIDE the quotes, IEEE-style, and must not gain a second one.
 * A first version joined everything with ", " and produced `"Title," , Comput.
 * J.`; a second sniffed for a trailing `,"` and broke on a title ending in a
 * question mark, where the quoted form is `"Why?"`.
 */
interface Piece { t: string; sep?: string }

function assemble(pieces: Piece[]): string {
  let out = '';
  for (const p of pieces) {
    if (!p.t) continue;
    out = out ? out + (sepOf(pieces, p) ?? ', ') + p.t : p.t;
  }
  return out;
}
const sepOf = (pieces: Piece[], p: Piece): string | undefined => {
  const i = pieces.indexOf(p);
  for (let k = i - 1; k >= 0; k--) if (pieces[k].t) return pieces[k].sep;
  return undefined;
};

function ieeeReference(e: BibEntry): string {
  const pieces: Piece[] = [{ t: ieeeAuthors(e) }];
  const title = e.title ?? '';
  const place = [e.address, e.publisher].filter(Boolean).join(': ');

  if (e.type === 'book') {
    pieces.push({ t: title });
    // "1st ed." already ends in a period, so the separator that follows it is a
    // SPACE. With ', ' it read "…, 1st ed., Reading"; with '. ' it doubled up.
    pieces.push({ t: e.edition ? `${e.edition} ed.` : '', sep: ' ' });
    pieces.push({ t: e.series ?? '' });
    pieces.push({ t: place });
  } else {
    // the comma lives inside the quotes; a title that ends in its own
    // punctuation keeps it and gains none
    pieces.push({ t: title ? `"${title}${/[.?!,]$/.test(title) ? '' : ','}"` : '', sep: ' ' });
    if (e.type === 'inproceedings') {
      pieces.push({ t: e.booktitle ? `in ${e.booktitle}` : '' });
      pieces.push({ t: e.address ?? '' });
    } else if (e.type === 'article') {
      pieces.push({ t: e.journal ?? '' });
      pieces.push({ t: e.volume ? `vol. ${e.volume}` : '' });
      pieces.push({ t: e.number ? `no. ${e.number}` : '' });
    } else if (e.type === 'techreport') {
      pieces.push({ t: e.institution ?? e.school ?? '' });
      pieces.push({ t: e.address ?? '' });
      pieces.push({ t: e.number ? `Tech. Rep. ${e.number}` : 'Tech. Rep.' });
    } else {
      pieces.push({ t: e.howpublished ?? '' });
      pieces.push({ t: e.publisher ?? '' });
    }
    pieces.push({ t: e.pages ? `pp. ${dash(e.pages)}` : '' });
  }
  pieces.push({ t: e.year ?? '' });

  let out = period(assemble(pieces));
  const href = link(e);
  if (href) out += ` [Online]. Available: ${href}`;
  if (e.note) out += ` ${period(e.note)}`;
  return out.replace(/\s+/g, ' ').trim();
}

// ── APA-ish

function apaAuthors(e: BibEntry): string {
  const { names, etAl } = parseNames(e.author ?? e.editor);
  if (!names.length) return '';
  // APA 7 lists up to twenty; beyond that, nineteen, an ellipsis, and the last
  const rendered = names.map(apaName);
  if (etAl) return `${rendered[0]}, et al.`;
  if (rendered.length === 1) return rendered[0];
  if (rendered.length === 2) return `${rendered[0]}, & ${rendered[1]}`;
  if (rendered.length <= 20) return `${rendered.slice(0, -1).join(', ')}, & ${rendered[rendered.length - 1]}`;
  return `${rendered.slice(0, 19).join(', ')}, ... ${rendered[rendered.length - 1]}`;
}

function apaReference(e: BibEntry, suffix: string): string {
  const out: string[] = [];
  const who = apaAuthors(e);
  if (who) out.push(period(who));
  out.push(`(${(e.year || 'n.d.') + suffix}).`);
  const title = e.title ?? '';

  if (e.type === 'article') {
    if (title) out.push(period(title));
    const vol = e.volume ? (e.number ? `${e.volume}(${e.number})` : e.volume) : '';
    const tail = [e.journal, vol, e.pages ? dash(e.pages) : ''].filter(Boolean).join(', ');
    if (tail) out.push(period(tail));
  } else if (e.type === 'book') {
    out.push(period([title, e.edition ? `(${e.edition} ed.)` : ''].filter(Boolean).join(' ')));
    if (e.publisher) out.push(period(e.publisher));
  } else if (e.type === 'inproceedings') {
    if (title) out.push(period(title));
    const where = [e.booktitle ? `In ${e.booktitle}` : '', e.pages ? `(pp. ${dash(e.pages)})` : '']
      .filter(Boolean).join(' ');
    if (where) out.push(period(where));
    if (e.publisher) out.push(period(e.publisher));
  } else if (e.type === 'techreport') {
    out.push(period([title, e.number ? `(Report No. ${e.number})` : ''].filter(Boolean).join(' ')));
    const org = e.institution ?? e.school;
    if (org) out.push(period(org));
  } else {
    if (title) out.push(period(title));
    const org = e.publisher ?? e.howpublished ?? e.institution;
    if (org) out.push(period(org));
  }
  const href = link(e);
  if (href) out.push(href);
  if (e.note) out.push(period(e.note));
  return out.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
