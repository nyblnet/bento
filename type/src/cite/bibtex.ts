// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A BibTeX reader. Pasted text in, entries out, and it never throws.
//
// ─────────────────────────────────────────────────────── WHAT IS SUPPORTED
//
//   ENTRY TYPES, modelled properly:
//     @article  @book  @inproceedings  @techreport  @misc
//   Aliases folded in: @conference → @inproceedings.
//   Any OTHER type (@incollection, @phdthesis, @manual, @unpublished, …) is
//   read as @misc with its fields intact and a line in `skipped` saying so —
//   the entry is still citable, it just formats generically. Losing a source
//   silently is worse than formatting it plainly.
//
//   SYNTAX:
//     · `@type{key, field = value, …}` and the `@type(key, …)` paren form
//     · values as {braced}, "quoted", bare numbers, or @string macros
//     · @string definitions and `#` concatenation
//     · @comment and @preamble, skipped
//     · nested braces to any depth, `\{` and `\}` escaped
//     · a trailing comma before the closing delimiter
//     · % comments to end of line, outside braces and quotes
//     · the three-letter month macros (jan…dec)
//
//   TeX IN VALUES:
//     · accents, both forms — \"o \'e \`a \^o \~n \=a \.z \u{a} \v{s} \H{o}
//       \c{c} \k{a} \d{h} \b{h} \r{a} — applied as Unicode combining marks and
//       composed with NFC, so `\'{\i}` really is í and not a dotted mess
//     · the standalone letters \ss \o \O \aa \AA \ae \AE \oe \OE \l \L \i \j
//       \dh \DH \th \TH
//     · escaped punctuation \& \% \_ \$ \# \{ \}
//     · font/emphasis commands (\textbf \textit \emph \texttt \textsc \mbox
//       \url \textsuperscript) unwrapped to their argument
//     · any other \command dropped, its braced argument kept
//     · `---` → em dash, `--` → en dash, ``…'' → curly quotes, `~` → a space
//     · $…$ math stripped to its contents
//     · BRACE-QUOTING: braces are removed and the text inside is kept EXACTLY.
//       We never case-fold a title, so `{DNA}` needs no protection — but it
//       gets it anyway, because the braces come off and the capitals do not.
//
// ─────────────────────────────────────────────────── WHAT IS NOT SUPPORTED
//
//     · crossref / xdata inheritance — the child keeps only its own fields
//     · BibLaTeX date ranges (`date = {1984-06/1984-07}`); `year` is what is
//       read, and a `date` field's leading four digits are read as the year
//     · sorting keys, `sortname`, `shortauthor`, name-list options
//     · \newcommand and any macro not defined by @string
//     · maths beyond stripping the dollars — `$x^2$` reads as `x^2`
//     · verbatim fields; `url` is cleaned like everything else
//
// ────────────────────────────────────────────────────────────── UNTRUSTED
//
// Pasted BibTeX is a document, and in this repo every document is untrusted
// input (docs/DECISIONS.md). Three consequences are built in here rather than
// hoped for at the call site:
//
//   1. It cannot throw. A truncated file, a stray `@`, an unclosed brace, 40MB
//      of `{` — each stops the scan and adds a line to `skipped`. The caller
//      always gets a result it can show.
//   2. It cannot inject markup. Values come out as TEXT: every `<`, `&` and
//      quote is an ordinary character here, and the atoms this module renders
//      escape on the way to the DOM. Nothing built from a value is ever
//      assigned to innerHTML.
//   3. It is bounded. Input length, entry count, field count and nesting depth
//      all have ceilings, because the scanner runs on the UI thread on a paste.
//
// The whole file is pure: string in, data out, no DOM, so `node
// scripts/test-type-cite.ts` exercises exactly the code the app runs.

import { BIB_FIELDS, BIB_TYPES, cleanField, validKey, type BibEntry, type BibType } from './types.ts';

/** Ceilings. Generous for real bibliographies, fatal for a denial-of-service. */
export const SRC_MAX = 4 * 1024 * 1024;
export const ENTRY_MAX = 5000;
export const FIELDS_MAX = 64;
export const DEPTH_MAX = 64;

export interface BibParse {
  /** in file order; a duplicate key keeps the FIRST definition */
  entries: Array<{ key: string; entry: BibEntry }>;
  /** everything not imported, phrased for a person to act on */
  skipped: string[];
}

// ───────────────────────────────────────────────────────────── TeX decoding

/** accent command → the Unicode combining mark it applies to the next letter */
const ACCENT: Record<string, string> = {
  "'": '\u0301', '`': '\u0300', '^': '\u0302', '\"': '\u0308', '~': '\u0303',
  '=': '\u0304', '.': '\u0307', 'u': '\u0306', 'v': '\u030C', 'H': '\u030B',
  'c': '\u0327', 'k': '\u0328', 'd': '\u0323', 'b': '\u0331', 'r': '\u030A',
};

/** standalone letter commands */
const LETTER: Record<string, string> = {
  ss: 'ß', o: 'ø', O: 'Ø', aa: 'å', AA: 'Å',
  ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', l: 'ł',
  L: 'Ł', i: 'i', j: 'j', dh: 'ð', DH: 'Ð', th: 'þ',
  TH: 'Þ', copyright: '©', pounds: '£',
};

/** commands whose argument is the content and whose styling we drop */
const UNWRAP = new Set([
  'textbf', 'textit', 'textsl', 'textsc', 'texttt', 'textrm', 'textmd',
  'textnormal', 'textsuperscript', 'textsubscript', 'emph', 'mbox', 'hbox',
  'url', 'href', 'text', 'mathrm', 'bf', 'it', 'sc', 'tt', 'rm', 'em',
]);

const ESCAPED = new Set(['&', '%', '$', '#', '_', '{', '}']);

/** Read a `{...}` group starting at `i` (which must be the brace). */
function group(s: string, i: number): { body: string; end: number } | null {
  if (s[i] !== '{') return null;
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') { k++; continue; }
    if (c === '{') { depth++; if (depth > DEPTH_MAX) return null; }
    else if (c === '}') { depth--; if (!depth) return { body: s.slice(i + 1, k), end: k + 1 }; }
  }
  return null;
}

/**
 * TeX → text.
 *
 * A single left-to-right scan. Recursion happens only into a command's braced
 * argument, and DEPTH_MAX bounds it — a value of 100,000 nested braces is a
 * plausible paste and must not be a stack overflow.
 */
export function decodeTex(src: string, depth = 0): string {
  if (depth > DEPTH_MAX) return '';
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (c === '\\') {
      const next = src[i + 1];
      if (next === undefined) break;                        // a trailing backslash
      // \& \% \{ … — the character itself
      if (ESCAPED.has(next)) { out += next; i++; continue; }
      if (next === '\\') { out += ' '; i++; continue; }      // a line break in a value
      // a word command: \ss, \textbf, \relax
      const word = /^[A-Za-z]+/.exec(src.slice(i + 1, i + 40));
      if (word) {
        const name = word[0];
        let k = i + 1 + name.length;
        // `\ss{}` and `\ss ` both mean ß — an empty group or a space is a
        // TERMINATOR for the command name, not an argument.
        if (src[k] === '{' && src[k + 1] === '}') k += 2;
        else while (src[k] === ' ') k++;
        if (LETTER[name] !== undefined && !(name.length === 1 && ACCENT[name] && src[k] === '{')) {
          out += LETTER[name]; i = k - 1; continue;
        }
        if (ACCENT[name]) { const r = accent(src, k, ACCENT[name], depth); out += r.text; i = r.end - 1; continue; }
        const g = src[k] === '{' ? group(src, k) : null;
        if (UNWRAP.has(name)) {
          if (g) { out += decodeTex(g.body, depth + 1); i = g.end - 1; continue; }
          i = k - 1; continue;                               // \bf with no argument: a switch
        }
        // an unknown command: drop the command, keep what it wrapped
        if (g) { out += decodeTex(g.body, depth + 1); i = g.end - 1; continue; }
        i = k - 1; continue;
      }
      // a symbol accent: \'e or \'{e}
      if (ACCENT[next]) { const r = accent(src, i + 2, ACCENT[next], depth); out += r.text; i = r.end - 1; continue; }
      out += next; i++; continue;
    }

    if (c === '{' || c === '}') continue;                    // brace-quoting: off it comes
    if (c === '$') continue;                                 // math delimiters only
    if (c === '~') { out += ' '; continue; }                 // a tie is still a space
    if (c === '-' && src[i + 1] === '-') {
      if (src[i + 2] === '-') { out += '—'; i += 2; } else { out += '–'; i += 1; }
      continue;
    }
    if (c === '`') { if (src[i + 1] === '`') { out += '“'; i++; } else out += '‘'; continue; }
    if (c === "'") { if (src[i + 1] === "'") { out += '”'; i++; } else out += "'"; continue; }
    out += c;
  }
  return out;
}

/**
 * Apply a combining mark to whatever follows, and compose.
 *
 * Composing with NFC is what makes this a table of 15 marks instead of a table
 * of 300 precomposed characters, and it is also what makes `\v{s}` work — š is
 * not in anybody's hand-written accent table and it is in Unicode.
 */
function accent(src: string, at: number, mark: string, depth: number): { text: string; end: number } {
  let base = '';
  let end = at;
  if (src[at] === '{') {
    const g = group(src, at);
    if (!g) return { text: '', end: src.length };
    base = decodeTex(g.body, depth + 1);
    end = g.end;
  } else if (src[at] === '\\') {
    const word = /^\\([A-Za-z]+)/.exec(src.slice(at, at + 20));
    if (word && LETTER[word[1]] !== undefined) { base = LETTER[word[1]]; end = at + word[0].length; }
    else { base = src[at + 1] ?? ''; end = at + 2; }
  } else if (src[at] !== undefined) {
    base = src[at]; end = at + 1;
  }
  // `\'{\i}` is í: the dotless i exists so the accent can replace the dot.
  base = base.replace(/ı/g, 'i').replace(/ȷ/g, 'j');
  if (!base) return { text: '', end };
  return { text: (base[0] + mark + base.slice(1)).normalize('NFC'), end };
}

// ─────────────────────────────────────────────────────────── the entry scanner

/** Split on `sep` at brace depth 0, outside "quotes". */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = false, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (quote) { if (c === '"') quote = false; continue; }
    if (c === '"' && depth === 0) { quote = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

/** One `#`-concatenated value, resolved through the @string macros. */
function value(raw: string, macros: Map<string, string>, note: (s: string) => void): string {
  let out = '';
  for (const part of splitTop(raw, '#')) {
    const p = part.trim();
    if (!p) continue;
    if (p[0] === '{') { const g = group(p, 0); out += decodeTex(g ? g.body : p.slice(1)); continue; }
    if (p[0] === '"') { out += decodeTex(p.slice(1, p.endsWith('"') && p.length > 1 ? -1 : undefined)); continue; }
    if (/^[0-9]+$/.test(p)) { out += p; continue; }
    const m = macros.get(p.toLowerCase());
    if (m !== undefined) { out += m; continue; }
    note(`unknown @string macro "${p.slice(0, 40)}" used as written`);
    out += decodeTex(p);
  }
  return out;
}

/** Strip `%` comments, which run to end of line outside braces and quotes. */
function stripComments(s: string): string {
  let out = '', depth = 0, quote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { out += c + (s[i + 1] ?? ''); i++; continue; }
    if (quote) { out += c; if (c === '"') quote = false; continue; }
    if (c === '"' && depth === 0) { out += c; quote = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '%' && depth === 0) {
      const nl = s.indexOf('\n', i);
      if (nl < 0) break;
      i = nl - 1; out += '\n';
      continue;
    }
    out += c;
  }
  return out;
}

const MONTHS: Array<[string, string]> = [
  ['jan', 'January'], ['feb', 'February'], ['mar', 'March'], ['apr', 'April'],
  ['may', 'May'], ['jun', 'June'], ['jul', 'July'], ['aug', 'August'],
  ['sep', 'September'], ['oct', 'October'], ['nov', 'November'], ['dec', 'December'],
];

const ALIAS: Record<string, BibType> = { conference: 'inproceedings' };

/** The whole job: text in, entries plus a list of what was not imported. */
export function parseBibtex(input: unknown): BibParse {
  const skipped: string[] = [];
  const entries: Array<{ key: string; entry: BibEntry }> = [];
  if (typeof input !== 'string' || !input.trim()) {
    return { entries, skipped: input === undefined || input === null || input === '' ? [] : ['nothing that looks like BibTeX'] };
  }
  let src = input;
  if (src.length > SRC_MAX) {
    src = src.slice(0, SRC_MAX);
    skipped.push(`the paste was longer than ${Math.round(SRC_MAX / 1024)}KB — only the first part was read`);
  }
  src = stripComments(src);

  const macros = new Map<string, string>(MONTHS);
  const seen = new Set<string>();
  // Reported ONCE at the end, not per entry: every real .bib carries abstract,
  // isbn and keywords, and 200 identical lines would bury the one line that
  // says a source was lost.
  const unmodelled = new Set<string>();
  let i = 0;

  while (i < src.length) {
    const at = src.indexOf('@', i);
    if (at < 0) break;
    i = at + 1;
    const tm = /^[A-Za-z]+/.exec(src.slice(i, i + 40));
    if (!tm) { skipped.push(`ignored a stray "@" at character ${at}`); continue; }
    const type = tm[0].toLowerCase();
    i += tm[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    const open = src[i];
    if (open !== '{' && open !== '(') { skipped.push(`@${type} at character ${at} has no body — skipped`); continue; }

    // Read the body with brace counting. The paren form still nests with
    // braces, so `)` only closes when nothing is open.
    let depth = 0, quote = false, end = -1;
    for (let k = i; k < src.length; k++) {
      const c = src[k];
      if (c === '\\') { k++; continue; }
      if (quote) { if (c === '"') quote = false; continue; }
      if (c === '"' && depth <= 1) { quote = true; continue; }
      if (c === '{') { depth++; if (depth > DEPTH_MAX) { end = -2; break; } continue; }
      if (c === '}') { depth--; if (open === '{' && depth === 0) { end = k; break; } continue; }
      if (c === ')' && open === '(' && depth === 0) { end = k; break; }
    }
    if (end === -2) { skipped.push(`@${type} at character ${at} nests braces too deeply — skipped`); i = at + 1; continue; }
    // RESUME, do not stop. A file whose third entry lost a brace still has
    // forty good entries after it, and `break` here threw them all away — the
    // rig caught exactly that. Rewinding to just past the `@` lets the scan
    // find the next entry, at the cost of one report per wrecked entry.
    if (end < 0) {
      skipped.push(`@${type} at character ${at} is never closed — skipped, and reading continued after it`);
      i = at + 1;
      continue;
    }
    const body = src.slice(i + 1, end);
    i = end + 1;

    if (type === 'comment' || type === 'preamble') continue;

    if (type === 'string') {
      const eq = splitTop(body, '=');
      if (eq.length < 2) { skipped.push(`@string at character ${at} is not "name = value" — ignored`); continue; }
      const name = eq[0].trim().toLowerCase();
      if (!name) { skipped.push(`@string at character ${at} has no name — ignored`); continue; }
      macros.set(name, value(eq.slice(1).join('='), macros, m => skipped.push(`@string ${name}: ${m}`)));
      continue;
    }

    if (entries.length >= ENTRY_MAX) {
      skipped.push(`stopped after ${ENTRY_MAX} entries`);
      break;
    }

    const parts = splitTop(body, ',');
    const key = (parts.shift() ?? '').trim();
    if (!key) { skipped.push(`@${type} at character ${at} has no citation key — skipped (nothing could cite it)`); continue; }
    if (!validKey(key)) {
      skipped.push(`@${type} key ${JSON.stringify(key.slice(0, 40))} uses characters a citation cannot carry — skipped`);
      continue;
    }
    if (seen.has(key)) { skipped.push(`${key}: a second @${type} with this key — kept the first`); continue; }

    let btype: BibType;
    if (BIB_TYPES.includes(type as BibType)) btype = type as BibType;
    else if (ALIAS[type]) btype = ALIAS[type];
    else {
      btype = 'misc';
      skipped.push(`${key}: @${type} is not a type this app models — imported as @misc, so it still cites`);
    }

    const entry: BibEntry = { type: btype };
    const allowed = new Set<string>(BIB_FIELDS as readonly string[]);
    let malformed = 0;
    for (const f of parts.slice(0, FIELDS_MAX)) {
      if (!f.trim()) continue;                                // the trailing comma
      const eq = splitTop(f, '=');
      if (eq.length < 2) { malformed++; continue; }
      const name = eq[0].trim().toLowerCase();
      const text = cleanField(value(eq.slice(1).join('='), macros, m => skipped.push(`${key}: ${m}`)));
      if (!text) continue;
      if (allowed.has(name)) { (entry as unknown as Record<string, string>)[name] = text; continue; }
      // BibLaTeX writes `date = {1984-06-01}`; the year is in there and the
      // alternative is an entry that formats as "n.d." for no good reason.
      if (name === 'date' && !entry.year) {
        const y = /^\d{4}/.exec(text);
        if (y) entry.year = y[0];
        continue;
      }
      if (name === 'journaltitle' && !entry.journal) { entry.journal = text; continue; }
      unmodelled.add(name.slice(0, 32));
    }
    if (parts.length > FIELDS_MAX) {
      skipped.push(`${key}: only the first ${FIELDS_MAX} fields were read`);
    }
    if (malformed) {
      skipped.push(`${key}: ${malformed} piece${malformed > 1 ? 's' : ''} of the entry ${malformed > 1 ? 'were' : 'was'} not "field = value" — ignored`);
    }
    seen.add(key);
    entries.push({ key, entry });
  }

  if (unmodelled.size) {
    skipped.push(`fields this app does not model, dropped everywhere: ${[...unmodelled].sort().join(', ')}`);
  }
  return { entries, skipped };
}
