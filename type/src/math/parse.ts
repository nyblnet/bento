// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// TeX-like source → a tree of math nodes.
//
// TOTAL, NEVER THROWING. This parser runs on every render of every block that
// carries a formula, on text a person is in the middle of typing — so at any
// instant the input is almost certainly malformed. A parser that threw would
// take the whole document's render down between the `\` and the `{`, which is
// not a hypothetical: it is what the first spike did, and it blanked the page.
//
// So every failure has a value: an unknown command, an unclosed brace, an
// argument that is not there — each becomes an `err` node that renders as the
// offending source in a warning colour, in place, with the rest of the formula
// intact. The reader sees exactly which bit is wrong and the document survives.
//
// The three caps below are the other half of that promise. `\frac{\frac{...`
// nested by a generator, or a 200KB paste into a formula, must cost bounded
// time — a renderer is called from a layout loop and has no right to hang the
// tab.

import {
  ACCENTS, ALPHABETS, BIG_OPS, CHAR_CLASS, DELIMS, ESCAPED, GREEK_LOWER,
  GREEK_UPPER, INT_OPS, NAMED_OPS, SPACES, SYMBOLS, type Cls,
} from './symbols.ts';

/** Longer than any real formula; a paste of a whole document is not one. */
export const MAX_SOURCE = 8000;
/** Enough for a page-sized matrix; far short of anything that stalls a frame. */
export const MAX_NODES = 6000;
/** `\frac{\frac{\frac{…` — deeper than this is unreadable anyway. */
export const MAX_DEPTH = 32;

export type Variant = 'italic' | 'up' | 'bold' | 'bolditalic' | 'sans' | 'mono';
export type StyleName = 'D' | 'T' | 'S' | 'SS';

export type MathNode =
  /** one symbol, already resolved to the character it prints */
  | { k: 'atom'; ch: string; cls: Cls; variant?: Variant }
  | { k: 'row'; body: MathNode[] }
  /** a big operator (∑) or a named function (sin); `limits` = scripts go above/below */
  | { k: 'op'; ch: string; cls: Cls; limits: boolean; big: boolean; name?: string }
  | { k: 'frac'; num: MathNode; den: MathNode; bar: boolean; style?: 'D' | 'T'; left?: string; right?: string }
  | { k: 'sqrt'; body: MathNode; index?: MathNode }
  | { k: 'script'; base: MathNode; sup?: MathNode; sub?: MathNode }
  | { k: 'fence'; left: string; right: string; body: MathNode }
  | { k: 'accent'; ch: string; body: MathNode }
  | { k: 'bar'; body: MathNode; under: boolean }
  | { k: 'text'; s: string }
  | { k: 'space'; em: number }
  | { k: 'style'; style: StyleName; body: MathNode }
  | { k: 'font'; variant?: Variant; alphabet?: string; body: MathNode }
  | { k: 'matrix'; rows: MathNode[][]; left: string; right: string; align: 'c' | 'l' }
  | { k: 'err'; s: string; msg: string };

export interface ParseOut { root: MathNode; errors: string[] }

// ───────────────────────────────────────────────────────────────── tokens

type Tok =
  | { t: 'cmd'; v: string }        // \frac, \, , \\  (v excludes the backslash)
  | { t: 'ch'; v: string }
  | { t: 'open' } | { t: 'close' } // { }
  | { t: 'sup' } | { t: 'sub' }
  | { t: 'amp' } | { t: 'nl' }     // & and \\
  | { t: 'ws' }                    // only ever meaningful inside \text
  | { t: 'eof' };

/**
 * Split the source into tokens.
 *
 * A control sequence is a backslash plus LETTERS, or a backslash plus exactly
 * one other character (`\,` `\{` `\\`). Getting that rule wrong is how `\alpha2`
 * becomes the undefined command `\alpha2`.
 */
export function lex(src: string): Tok[] {
  const out: Tok[] = [];
  const s = src.slice(0, MAX_SOURCE);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const rest = s.slice(i + 1);
      const m = /^[a-zA-Z]+/.exec(rest);
      if (m) { out.push({ t: 'cmd', v: m[0] }); i += 1 + m[0].length; continue; }
      const next = s[i + 1];
      if (next === undefined) { out.push({ t: 'ch', v: '\\' }); i++; continue; }
      if (next === '\\') { out.push({ t: 'nl' }); i += 2; continue; }
      out.push({ t: 'cmd', v: next }); i += 2; continue;
    }
    if (c === '{') { out.push({ t: 'open' }); i++; continue; }
    if (c === '}') { out.push({ t: 'close' }); i++; continue; }
    if (c === '^') { out.push({ t: 'sup' }); i++; continue; }
    if (c === '_') { out.push({ t: 'sub' }); i++; continue; }
    if (c === '&') { out.push({ t: 'amp' }); i++; continue; }
    // Whitespace is not a character in math mode — `a b` is `ab` — but it IS
    // one inside `\text{if x}`, and the two cannot be told apart until the
    // parser knows which it is in. So it is TOKENISED and then skipped by
    // `peek`/`next`; only `rawGroup`, which reads the token stream directly,
    // ever sees it. Dropping it in the lexer instead cost every `\text` its
    // spaces, and words ran together in the middle of a sentence.
    if (/\s/.test(c)) { out.push({ t: 'ws' }); i++; continue; }
    out.push({ t: 'ch', v: c }); i++;
  }
  out.push({ t: 'eof' });
  return out;
}

// ───────────────────────────────────────────────────────────────── parser

const ROW = (body: MathNode[]): MathNode =>
  body.length === 1 ? body[0] : { k: 'row', body };

/** Environments this subset knows, and the fences each one wears. */
const ENVS: Record<string, { left: string; right: string; align: 'c' | 'l' }> = {
  matrix: { left: '', right: '', align: 'c' },
  pmatrix: { left: '(', right: ')', align: 'c' },
  bmatrix: { left: '[', right: ']', align: 'c' },
  Bmatrix: { left: '{', right: '}', align: 'c' },
  vmatrix: { left: '|', right: '|', align: 'c' },
  Vmatrix: { left: '‖', right: '‖', align: 'c' },
  cases: { left: '{', right: '', align: 'l' },
  aligned: { left: '', right: '', align: 'l' },
  array: { left: '', right: '', align: 'c' },
};

class Parser {
  private toks: Tok[];
  private i = 0;
  private depth = 0;
  private made = 0;
  readonly errors: string[] = [];

  constructor(src: string) { this.toks = lex(src); }

  /** Step over whitespace, which is never an atom. */
  private skipWs(): void { while (this.toks[this.i]?.t === 'ws') this.i++; }
  private peek(): Tok { this.skipWs(); return this.toks[this.i]; }
  private next(): Tok { this.skipWs(); return this.toks[this.i++]; }
  private fail(s: string, msg: string): MathNode {
    if (this.errors.length < 20) this.errors.push(`${msg}: ${s}`);
    return { k: 'err', s, msg };
  }

  /** The budget check every node creation goes through. */
  private budget(): boolean {
    return ++this.made <= MAX_NODES;
  }

  parse(): MathNode {
    const body = this.list(t => t.t === 'eof');
    if (this.peek().t !== 'eof') {
      // a stray `}` (or worse) left the list early — consume the rest so the
      // reader sees it rather than losing it silently
      while (this.peek().t !== 'eof') {
        const t = this.next();
        if (t.t === 'close') body.push(this.fail('}', 'unmatched brace'));
      }
    }
    return ROW(body);
  }

  /** Atoms until `stop` (not consumed) or the end of the input. */
  private list(stop: (t: Tok) => boolean): MathNode[] {
    const out: MathNode[] = [];
    if (++this.depth > MAX_DEPTH) {
      this.depth--;
      return [this.fail('…', 'nested too deeply')];
    }
    for (;;) {
      const t = this.peek();
      if (t.t === 'eof' || stop(t)) break;
      if (!this.budget()) { out.push(this.fail('…', 'formula too large')); break; }
      const node = this.atom();
      if (node) out.push(this.scripts(node));
    }
    this.depth--;
    return out;
  }

  /**
   * Attach `^` and `_` to the atom just parsed.
   *
   * Both orders (`x^2_i` and `x_i^2`) mean the same thing and both occur in
   * real sources, so this loops rather than expecting one shape. A second
   * superscript on the same base is TeX's "double superscript" error; here the
   * later one wins and the reader is told, because refusing to render is worse
   * than rendering the likely intent.
   */
  private scripts(base: MathNode): MathNode {
    let sup: MathNode | undefined;
    let sub: MathNode | undefined;
    let any = false;
    for (;;) {
      const t = this.peek();
      // a prime is a superscript written differently
      if (t.t === 'ch' && t.v === "'") {
        this.next();
        let ch = '′';
        while (this.peek().t === 'ch' && (this.peek() as { v: string }).v === "'") { this.next(); ch += '′'; }
        sup = sup ? ROW([sup, { k: 'atom', ch, cls: 'ord' }]) : { k: 'atom', ch, cls: 'ord' };
        any = true;
        continue;
      }
      if (t.t !== 'sup' && t.t !== 'sub') break;
      this.next();
      const arg = this.arg();
      if (t.t === 'sup') {
        if (sup) this.errors.push('two superscripts on one base');
        sup = arg;
      } else {
        if (sub) this.errors.push('two subscripts on one base');
        sub = arg;
      }
      any = true;
    }
    if (!any) return base;
    return { k: 'script', base, sup, sub };
  }

  /**
   * One argument: a braced group, or the single next atom.
   *
   * `\frac12` really is one half in TeX and generators emit it, so the
   * single-token form is not an indulgence.
   */
  private arg(): MathNode {
    const t = this.peek();
    if (t.t === 'open') {
      this.next();
      const body = this.list(x => x.t === 'close');
      if (this.peek().t === 'close') this.next();
      else this.errors.push('missing }');
      return ROW(body);
    }
    if (t.t === 'eof' || t.t === 'close') return this.fail('', 'missing argument');
    const node = this.atom();
    return node ?? this.fail('', 'missing argument');
  }

  /** An optional `[...]` argument, for `\sqrt[3]{x}`. */
  private optArg(): MathNode | undefined {
    const t = this.peek();
    if (t.t !== 'ch' || t.v !== '[') return undefined;
    this.next();
    const body = this.list(x => x.t === 'ch' && x.v === ']');
    if (this.peek().t === 'ch') this.next();
    return ROW(body);
  }

  /** The text of a braced group, verbatim — for `\text{…}` and `\begin{…}`. */
  private rawGroup(): string {
    if (this.peek().t !== 'open') {
      const t = this.next();
      return t.t === 'ch' || t.t === 'cmd' ? t.v : '';
    }
    this.next();
    let out = '';
    let depth = 1;
    for (;;) {
      // raw: this is the one reader that must NOT skip whitespace
      const t = this.toks[this.i++] ?? { t: 'eof' as const };
      if (t.t === 'eof') { this.errors.push('missing }'); break; }
      if (t.t === 'open') { depth++; out += '{'; continue; }
      if (t.t === 'close') { if (--depth === 0) break; out += '}'; continue; }
      out += t.t === 'cmd' ? `\\${t.v}` : t.t === 'ch' ? t.v
           : t.t === 'ws' ? ' ' : t.t === 'sup' ? '^' : t.t === 'sub' ? '_'
           : t.t === 'amp' ? '&' : t.t === 'nl' ? ' ' : '';
    }
    return out;
  }

  private atom(): MathNode | null {
    const t = this.next();
    switch (t.t) {
      case 'open': {
        const body = this.list(x => x.t === 'close');
        if (this.peek().t === 'close') this.next(); else this.errors.push('missing }');
        return ROW(body);
      }
      case 'close': return this.fail('}', 'unmatched brace');
      case 'ws': return null;                      // skipped everywhere but \text
      case 'nl': case 'amp': return null;          // only meaningful in a matrix
      case 'sup': case 'sub': {
        // a script with nothing before it: TeX errors, we render an empty base
        this.i--;
        return this.scripts({ k: 'row', body: [] });
      }
      case 'ch': return this.charAtom(t.v);
      case 'cmd': return this.command(t.v);
      default: return null;
    }
  }

  private charAtom(c: string): MathNode {
    const known = CHAR_CLASS[c];
    if (known) return { k: 'atom', ch: known.ch, cls: known.cls };
    if (c >= '0' && c <= '9') return { k: 'atom', ch: c, cls: 'ord', variant: 'up' };
    if (/[a-zA-Z]/.test(c)) return { k: 'atom', ch: c, cls: 'ord', variant: 'italic' };
    return { k: 'atom', ch: c, cls: 'ord' };
  }

  private delim(): string {
    const t = this.next();
    if (t.t === 'ch') {
      const d = DELIMS[t.v];
      if (d !== undefined) return d;
      this.errors.push(`not a delimiter: ${t.v}`);
      return '';
    }
    if (t.t === 'cmd') {
      const d = DELIMS[`\\${t.v}`];
      if (d !== undefined) return d;
      this.errors.push(`not a delimiter: \\${t.v}`);
      return '';
    }
    if (t.t === 'open') return '{';
    if (t.t === 'close') return '}';
    this.errors.push('missing delimiter');
    return '';
  }

  private command(name: string): MathNode {
    // ── fractions
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
      const num = this.arg(), den = this.arg();
      return { k: 'frac', num, den, bar: true,
               ...(name === 'dfrac' || name === 'cfrac' ? { style: 'D' as const }
                   : name === 'tfrac' ? { style: 'T' as const } : {}) };
    }
    if (name === 'binom' || name === 'choose') {
      const num = this.arg(), den = this.arg();
      return { k: 'frac', num, den, bar: false, left: '(', right: ')' };
    }
    if (name === 'sqrt') {
      const index = this.optArg();
      const body = this.arg();
      return index ? { k: 'sqrt', body, index } : { k: 'sqrt', body };
    }
    if (name === 'overline') return { k: 'bar', body: this.arg(), under: false };
    if (name === 'underline') return { k: 'bar', body: this.arg(), under: true };

    // ── fences
    if (name === 'left') {
      const left = this.delim();
      const body = ROW(this.list(x => x.t === 'cmd' && (x.v === 'right' || x.v === 'end')));
      const t = this.peek();
      if (t.t === 'cmd' && t.v === 'right') { this.next(); return { k: 'fence', left, right: this.delim(), body }; }
      // An unclosed `\left` is the commonest half-typed state there is, so it
      // degrades to a one-sided fence rather than to an error node — the
      // formula keeps rendering while the author types the other half.
      this.errors.push('\\left with no \\right');
      return { k: 'fence', left, right: '', body };
    }
    if (name === 'right') return this.fail('\\right', 'no \\left for this');
    if (name === 'big' || name === 'Big' || name === 'bigg' || name === 'Bigg'
        || name === 'bigl' || name === 'bigr' || name === 'Bigl' || name === 'Bigr') {
      // sized delimiters are accepted and set at their natural size: the shape
      // is right, only the emphasis is lost
      return { k: 'atom', ch: this.delim(), cls: name.endsWith('r') ? 'close' : 'open' };
    }

    // ── environments
    if (name === 'begin') return this.env();
    if (name === 'end') { this.rawGroup(); return this.fail('\\end', 'no \\begin for this'); }

    // ── text and fonts
    if (name === 'text' || name === 'textrm' || name === 'mbox' || name === 'textnormal') {
      return { k: 'text', s: this.rawGroup() };
    }
    if (ALPHABETS[name]) return { k: 'font', alphabet: name, body: this.arg() };
    const FONTS: Record<string, Variant> = {
      mathrm: 'up', operatorname: 'up', mathbf: 'bold', boldsymbol: 'bolditalic',
      mathit: 'italic', mathsf: 'sans', mathtt: 'mono',
    };
    if (FONTS[name]) return { k: 'font', variant: FONTS[name], body: this.arg() };

    // ── style
    const STYLES: Record<string, StyleName> = {
      displaystyle: 'D', textstyle: 'T', scriptstyle: 'S', scriptscriptstyle: 'SS',
    };
    if (STYLES[name]) {
      // a style command applies to the rest of its group, which is why it takes
      // no argument and swallows what follows
      const body = ROW(this.list(x => x.t === 'close' || x.t === 'eof'));
      return { k: 'style', style: STYLES[name], body };
    }

    // ── accents
    if (ACCENTS[name]) return { k: 'accent', ch: ACCENTS[name], body: this.arg() };

    // ── spacing
    if (SPACES[name] !== undefined) return { k: 'space', em: SPACES[name] };

    // ── operators
    if (BIG_OPS[name]) return { k: 'op', ch: BIG_OPS[name], cls: 'op', limits: true, big: true };
    if (INT_OPS[name]) return { k: 'op', ch: INT_OPS[name], cls: 'op', limits: false, big: true };
    if (NAMED_OPS[name] !== undefined) {
      return { k: 'op', ch: name, cls: 'op', limits: NAMED_OPS[name], big: false, name };
    }
    if (name === 'limits' || name === 'nolimits' || name === 'mathop') {
      // accepted and ignored: the default this renderer picks is the one TeX
      // would pick in the overwhelming majority of sources
      return { k: 'row', body: [] };
    }

    // ── letters and plain symbols
    if (GREEK_LOWER[name]) return { k: 'atom', ch: GREEK_LOWER[name], cls: 'ord', variant: 'italic' };
    if (GREEK_UPPER[name]) return { k: 'atom', ch: GREEK_UPPER[name], cls: 'ord', variant: 'up' };
    const sym = SYMBOLS[name] ?? ESCAPED[name];
    if (sym) return { k: 'atom', ch: sym.ch, cls: sym.cls };

    return this.fail(`\\${name}`, 'unknown command');
  }

  /** `\begin{env} … \\ … & … \end{env}` */
  private env(): MathNode {
    const name = this.rawGroup();
    const spec = ENVS[name];
    if (!spec) {
      // Skip to the matching \end so the REST of the formula still renders.
      // Bailing here instead would turn one unsupported environment into a
      // document with everything after it missing.
      for (;;) {
        const t = this.next();
        if (t.t === 'eof') break;
        if (t.t === 'cmd' && t.v === 'end') { this.rawGroup(); break; }
      }
      return this.fail(`\\begin{${name}}`, 'unsupported environment');
    }
    if (name === 'array') this.rawGroupIfBrace();
    const rows: MathNode[][] = [];
    let row: MathNode[] = [];
    let cell: MathNode[] = [];
    const endCell = () => { row.push(ROW(cell)); cell = []; };
    const endRow = () => { endCell(); rows.push(row); row = []; };
    for (;;) {
      const t = this.peek();
      if (t.t === 'eof') { this.errors.push(`missing \\end{${name}}`); break; }
      if (t.t === 'cmd' && t.v === 'end') { this.next(); this.rawGroup(); break; }
      if (t.t === 'amp') { this.next(); endCell(); continue; }
      if (t.t === 'nl') { this.next(); endRow(); continue; }
      if (!this.budget()) { cell.push(this.fail('…', 'formula too large')); break; }
      const node = this.atom();
      if (node) cell.push(this.scripts(node));
    }
    // a trailing `\\` means "end of the last row", not "one more empty row"
    if (cell.length || row.length) endRow();
    return { k: 'matrix', rows, left: spec.left, right: spec.right, align: spec.align };
  }

  /** `\begin{array}{cc}` — the column spec is accepted and not honoured. */
  private rawGroupIfBrace(): void {
    if (this.peek().t === 'open') this.rawGroup();
  }
}

/**
 * Parse a formula. Never throws; the errors are also embedded in the tree so
 * they render in place.
 */
export function parseMath(src: string): ParseOut {
  const p = new Parser(typeof src === 'string' ? src : '');
  let root: MathNode;
  try {
    root = p.parse();
  } catch (e) {
    // The belt to the parser's braces. Nothing here is expected to throw, and
    // if a future edit makes something throw, a formula must still not be able
    // to take a page down.
    root = { k: 'err', s: src.slice(0, 80), msg: (e as Error).message || 'could not read this formula' };
  }
  return { root, errors: p.errors };
}
