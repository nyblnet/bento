// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * maths-lite — the Typst maths front end → the same tree. Typst's rules, the
 * ones that matter for a formula on a slide:
 *   a/b          fraction of the neighbouring "atoms": (a+b)/c has no parens
 *   x^2 x_1      attach; a parenthesised script (x^(n+1)) loses its parens
 *   sqrt(x)      function call; root(3, x); frac(a, b); binom; abs; norm;
 *                floor; ceil; hat; tilde; bar; vec; dot; overline; underline;
 *                overbrace(x, "t"); underbrace; mat(1, 2; 3, 4); vec(1, 2);
 *                cases(a, b); bb(R); cal(L); frak(g); bold(x); upright(x);
 *                sans; mono; italic; text(...) ; lr(...); sum_(i=1)^n
 *   "quoted"     text
 *   pi, alpha    named symbols (one table with LaTeX, symbols.ts)
 *   sin, lim     function names, upright
 *   x y          juxtaposition; multi-letter runs are names, single letters
 *                are variables
 */

import { type MNode, type Font, row, mi, mn, mo, MathError, symNode } from './ast.ts'
import { byTypst, byTex, FUNCTIONS, LIMIT_FUNCTIONS } from './symbols.ts'

type Tok = { t: 'name' | 'num' | 'str' | 'op' | '(' | ')' | ',' | ';' | '^' | '_' | '/' ; v: string }

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === '"') { const j = src.indexOf('"', i + 1); if (j < 0) throw new MathError('unterminated string'); out.push({ t: 'str', v: src.slice(i + 1, j) }); i = j + 1; continue }
    if (/[0-9]/.test(c)) { const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!; out.push({ t: 'num', v: m[0] }); i += m[0].length; continue }
    if (/[a-zA-Z]/.test(c)) { const m = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z]+)*/.exec(src.slice(i))!; out.push({ t: 'name', v: m[0] }); i += m[0].length; continue }
    if ('(),;^_/'.includes(c)) { out.push({ t: c as Tok['t'], v: c }); i++; continue }
    // multi-char operators, longest first
    const m = /^(<==>|==>|<==|->|=>|<-|<=|>=|!=|:=|\.\.\.|\*\*|\|\||[-+*=<>|!:.&\[\]{}\\'])/.exec(src.slice(i))
    if (!m) throw new MathError(`unexpected ${c}`)
    out.push({ t: 'op', v: m[0] }); i += m[0].length
  }
  return out
}

const OPS: Record<string, string> = { '->': '→', '=>': '⇒', '<-': '←', '<=': '≤', '>=': '≥', '!=': '≠', '==>': '⟹', '<==': '⟸', '<==>': '⟺', ':=': '≔', '...': '…', '**': '∗', '||': '‖', '-': '−', '*': '⋅', '+': '+', '=': '=', '<': '<', '>': '>', '|': '|', '!': '!', ':': ':', '.': '.', '&': '&', '\\': '\\', "'": '′', '[': '[', ']': ']', '{': '{', '}': '}' }
const FONTS: Record<string, Font> = { bb: 'bb', cal: 'cal', scr: 'scr', frak: 'frak', bold: 'bf', italic: 'it', sans: 'sf', mono: 'tt', upright: 'rm' }
const ACCENTS: Record<string, [string, boolean?, boolean?]> = { hat: ['^'], tilde: ['~'], bar: ['‾'], macron: ['‾'], overline: ['‾', true], underline: ['_', true, true], arrow: ['→'], dot: ['˙'], 'dot.double': ['¨'], acute: ['´'], grave: ['`'], breve: ['˘'], caron: ['ˇ'], circle: ['˚'] }
const FENCED: Record<string, [string, string]> = { abs: ['|', '|'], norm: ['‖', '‖'], floor: ['⌊', '⌋'], ceil: ['⌈', '⌉'], round: ['⌊', '⌉'] }

class Parser {
  i = 0
  private toks: Tok[]
  private display: boolean
  constructor(toks: Tok[], display: boolean) { this.toks = toks; this.display = display }
  peek(o = 0): Tok | undefined { return this.toks[this.i + o] }
  next(): Tok { const t = this.toks[this.i++]; if (!t) throw new MathError('unexpected end'); return t }
  is(t: Tok['t'], v?: string, o = 0): boolean { const p = this.peek(o); return !!p && p.t === t && (v === undefined || p.v === v) }

  /** items until a stop token; handles a/b by folding the two neighbours */
  parseSeq(stop: (t: Tok) => boolean): MNode {
    const c: MNode[] = []
    while (this.peek() && !stop(this.peek()!)) {
      if (this.is('/')) {
        this.next()
        const num = c.pop() ?? { k: 'row', c: [] }
        const den = this.parseAttached()
        c.push({ k: 'frac', n: strip(num), d: strip(den) })
        continue
      }
      c.push(this.parseAttached())
    }
    return row(c)
  }
  /** an atom with its ^ _ attachments */
  parseAttached(): MNode {
    let base = this.parseAtom()
    let sub: MNode | undefined, sup: MNode | undefined
    const limits = (base.k === 'sym' && !!base.big && this.display && !/[∫∬∭∮]/.test(base.t)) || (base.k === 'sym' && !!base.fn && LIMIT_FUNCTIONS.includes(base.t) && this.display)
    for (;;) {
      if (this.is('^')) { this.next(); sup = strip(this.parseAtom()); continue }
      if (this.is('_')) { this.next(); sub = strip(this.parseAtom()); continue }
      if (this.is('op', "'")) { const ps: MNode[] = []; while (this.is('op', "'")) { this.next(); ps.push(mo('′', { pad: '0em' })) } const p = ps.length === 1 ? ps[0] : { k: 'row', c: ps } as MNode; sup = sup ? row([p, sup]) : p; continue }
      break
    }
    if (sub || sup) base = { k: 'scr', b: base, sub, sup, limits: limits || undefined }
    return base
  }
  parseAtom(): MNode {
    const t = this.next()
    switch (t.t) {
      case 'num': return mn(t.v)
      case 'str': return { k: 'text', t: t.v }
      case '(': {
        // a parenthesised group: stays visible as fences unless consumed by ^ _ /
        const inner = this.parseSeq((x) => x.t === ')')
        if (!this.is(')')) throw new MathError('missing )')
        this.next()
        // Typst sizes a matching pair to its content (its `lr` is automatic)
        // — but a stretchy paren in Chrome is a different, wider-bearing
        // glyph, so `f(x)` would gain gaps Typst never shows. Stretch only
        // when the content is tall (a fraction, root, table, under/over
        // limits); a plain group is the tight `(` the LaTeX path emits.
        return { k: 'fence', l: '(', r: ')', c: inner, explicit: isTall(inner) || undefined }
      }
      case ')': throw new MathError('unexpected )')
      case ',': return mo(',')
      case ';': return mo(';')
      case '^': case '_': case '/': throw new MathError(`unexpected ${t.v}`)
      case 'op': return t.v === '<==>' ? symNode(byTex.get('iff')!) : t.v === '==>' ? symNode(byTex.get('implies')!) : mo(OPS[t.v] ?? t.v)
      case 'name': return this.name(t.v)
    }
  }
  name(v: string): MNode {
    // function call?
    if (this.is('(')) {
      if (v in FONTS) { return { k: 'style', c: this.args1(), font: FONTS[v] } }
      if (v in ACCENTS) { const [a, s, u] = ACCENTS[v]; return { k: 'accent', b: this.args1(), a, stretchy: s, under: u } }
      if (v in FENCED) { const [l, r] = FENCED[v]; const c = this.args1(); return { k: 'fence', l, r, c, explicit: isTall(c) || undefined } }
      switch (v) {
        case 'sqrt': return { k: 'sqrt', b: this.args1() }
        case 'root': { const [i, b] = this.args(2); return { k: 'sqrt', b, i } }
        case 'frac': { const [n, d] = this.args(2); return { k: 'frac', n, d } }
        case 'binom': { const [n, d] = this.args(2); return { k: 'fence', l: '(', r: ')', c: { k: 'frac', n, d, nobar: true }, explicit: true } }
        case 'overbrace': { const [b, l] = this.args(1, 2); const node: MNode = { k: 'accent', b, a: '⏞', stretchy: true }; return l ? { k: 'scr', b: node, sup: l, limits: true } : node }
        case 'underbrace': { const [b, l] = this.args(1, 2); const node: MNode = { k: 'accent', b, a: '⏟', stretchy: true, under: true }; return l ? { k: 'scr', b: node, sub: l, limits: true } : node }
        case 'text': return { k: 'text', t: this.rawArg() }
        case 'lr': { const inner = this.args1(); return inner.k === 'fence' ? inner : inner }
        case 'mat': { const rows = this.rows(';', ','); return { k: 'table', rows, l: '(', r: ')', align: 'c' } }
        case 'vec': { const rows = this.rows(';', ','); return { k: 'table', rows: rows.length === 1 ? rows[0].map((c) => [c]) : rows, l: '(', r: ')', align: 'c' } }
        case 'cases': { const rows = this.rows(',', '&'); return { k: 'table', rows, l: '{', r: '', align: 'll' } }
        case 'display': { const inner = this.args1(); return inner }
        case 'op': return mi(this.rawArg(), { fn: true })
        case 'limits': case 'scripts': { const inner = this.args1(); return inner }
      }
    }
    const sym = byTypst.get(v)
    if (sym) return symNode(sym)
    // Typst's spacing words
    const SP: Record<string, number> = { thin: 0.1667, med: 0.2222, thick: 0.2778, quad: 1, wide: 2 }
    if (v in SP) return { k: 'space', em: SP[v] }
    if (v === 'oo') return mi('∞')
    if (v === 'dif') return mi('d', { up: true })
    if (FUNCTIONS.includes(v) || LIMIT_FUNCTIONS.includes(v)) return mi(v, { fn: true })
    if (v.length === 1) return mi(v)
    // a multi-letter run Typst does not know is an upright word; TeX users
    // would write \mathrm — treat it as an identifier run
    return mi(v, { fn: true })
  }
  /** one call argument list `( … )` returning the single content */
  args1(): MNode { const a = this.args(1); return a[0] }
  args(min: number, max = min): MNode[] {
    this.next() // (
    const out: MNode[] = []
    while (!this.is(')')) {
      out.push(strip(this.parseSeq((x) => x.t === ',' || x.t === ')')))
      if (this.is(',')) this.next()
    }
    this.next()
    if (out.length < min || out.length > max) throw new MathError('wrong argument count')
    return out
  }
  /** rows for mat/vec (`a, b; c, d`) and cases (`a & "if", b & "else"`) */
  rows(rowSep: string, colSep: string): MNode[][] {
    this.next() // (
    const rows: MNode[][] = [[]]
    const isSep = (x: Tok, s: string) => (s === '&' ? x.t === 'op' && x.v === '&' : x.t === s)
    while (!this.is(')')) {
      rows[rows.length - 1].push(strip(this.parseSeq((x) => isSep(x, rowSep) || isSep(x, colSep) || x.t === ')')))
      if (isSep(this.peek()!, colSep)) this.next()
      else if (isSep(this.peek()!, rowSep)) { this.next(); rows.push([]) }
    }
    this.next()
    if (rows[rows.length - 1].length === 0) rows.pop()
    return rows
  }
  rawArg(): string {
    this.next() // (
    let s = ''
    while (!this.is(')')) { const t = this.next(); s += (t.t === 'str' ? t.v : t.v) + (this.is('name') || this.is('num') ? ' ' : '') }
    this.next()
    return s.trim()
  }
}

/** Does this content need a delimiter taller than the line? */
function isTall(n: MNode): boolean {
  switch (n.k) {
    case 'frac': case 'sqrt': case 'table': return true
    case 'scr': return !!n.limits || isTall(n.b)
    case 'fence': return !!n.explicit || isTall(n.c)
    case 'row': return n.c.some(isTall)
    case 'style': return isTall(n.c)
    case 'accent': return isTall(n.b)
    default: return false
  }
}

/** `(x)` used as a script/fraction part loses its parentheses, as in Typst. */
function strip(n: MNode): MNode {
  return n.k === 'fence' && n.l === '(' && n.r === ')' && !n.size ? n.c : n // (explicit or not: a consumed group loses its parens)
}

export function parseTypst(src: string, display: boolean): MNode {
  const p = new Parser(tokenize(src), display)
  const r = p.parseSeq(() => false)
  if (p.peek()) throw new MathError('trailing input')
  return r
}
