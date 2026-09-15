// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * maths-lite — the LaTeX front end: tokenizer + recursive-descent parser →
 * the shared tree (ast.ts). Supported set = what our decks use (the corpus
 * table in the spike handoff) plus the obvious tier. Unknown commands throw
 * MathError, which index.ts turns into "leave the source as typed", the same
 * contract Temml's throwOnError path has today.
 */

import { type MNode, type Font, row, mi, mn, mo, MathError, symNode } from './ast.ts'
import { byTex, FUNCTIONS, LIMIT_FUNCTIONS } from './symbols.ts'

type Tok = { t: 'cmd' | 'ch' | '{' | '}' | '^' | '_' | '&' | '\\\\' | 'ws'; v: string }

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+|.)/s.exec(src.slice(i))
      if (!m) throw new MathError('dangling backslash')
      i += m[0].length
      if (m[1] === '\\') out.push({ t: '\\\\', v: '\\\\' })
      else out.push({ t: 'cmd', v: m[1] })
      // a control word swallows the whitespace after it
      if (/^[a-zA-Z]+$/.test(m[1])) while (i < src.length && /\s/.test(src[i])) i++
      continue
    }
    if (/\s/.test(c)) { while (i < src.length && /\s/.test(src[i])) i++; out.push({ t: 'ws', v: ' ' }); continue }
    if (c === '%') { while (i < src.length && src[i] !== '\n') i++; continue }
    if ('{}^_&'.includes(c)) { out.push({ t: c as Tok['t'], v: c }); i++; continue }
    out.push({ t: 'ch', v: c }); i++
  }
  return out
}

const OPEN_FENCES: Record<string, string> = { '(': '(', '[': '[', '\\{': '{', '|': '|', '.': '', '\\langle': '⟨', '\\lfloor': '⌊', '\\lceil': '⌈', '\\|': '‖', '\\vert': '|', '\\Vert': '‖', '\\lbrace': '{', '\\lbrack': '[' }
const CLOSE_FENCES: Record<string, string> = { ')': ')', ']': ']', '\\}': '}', '|': '|', '.': '', '\\rangle': '⟩', '\\rfloor': '⌋', '\\rceil': '⌉', '\\|': '‖', '\\vert': '|', '\\Vert': '‖', '\\rbrace': '}', '\\rbrack': ']' }
const BIG: Record<string, number> = { big: 1.2, Big: 1.8, bigg: 2.4, Bigg: 3 }
const ACCENTS: Record<string, [string, boolean?]> = { hat: ['^'], widehat: ['^', true], tilde: ['~'], widetilde: ['~', true], bar: ['‾'], overline: ['‾', true], vec: ['→'], dot: ['˙'], ddot: ['¨'], acute: ['´'], grave: ['`'], breve: ['˘'], check: ['ˇ'], overrightarrow: ['→', true], overleftarrow: ['←', true] }
const UNDER: Record<string, string> = { underline: '_', underbrace: '⏟', underrightarrow: '→' }
const OVER: Record<string, string> = { overbrace: '⏞' }
const FONTS: Record<string, Font> = { mathbb: 'bb', mathcal: 'cal', mathscr: 'scr', mathfrak: 'frak', mathbf: 'bf', boldsymbol: 'bf', bm: 'bf', mathit: 'it', mathsf: 'sf', mathtt: 'tt', mathrm: 'rm', operatorname: 'rm', textbf: 'bf', textit: 'it' }
const SPACES: Record<string, number> = { ',': 0.1667, ':': 0.2222, ';': 0.2778, '!': -0.1667, quad: 1, qquad: 2, ' ': 0.25 }
const ENV_FENCES: Record<string, [string, string]> = { matrix: ['', ''], pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], cases: ['{', ''], aligned: ['', ''], align: ['', ''], 'align*': ['', ''], gathered: ['', ''], gather: ['', ''], array: ['', ''], smallmatrix: ['', ''] }

class Parser {
  i = 0
  /** inside \text{…} whitespace is content; everywhere else it is nothing */
  raw = false
  private toks: Tok[]
  private display: boolean
  constructor(toks: Tok[], display: boolean) { this.toks = toks; this.display = display }
  private skipWs() { if (!this.raw) while (this.toks[this.i]?.t === 'ws') this.i++ }
  peek(): Tok | undefined { this.skipWs(); return this.toks[this.i] }
  next(): Tok { this.skipWs(); const t = this.toks[this.i++]; if (!t) throw new MathError('unexpected end'); return t }
  is(t: Tok['t'], v?: string): boolean { const p = this.peek(); return !!p && p.t === t && (v === undefined || p.v === v) }

  /** A sequence up to a terminator the caller owns. */
  parseRow(stop: (t: Tok) => boolean): MNode {
    const c: MNode[] = []
    while (this.peek() && !stop(this.peek()!)) c.push(this.parseScripted())
    return row(c)
  }
  parseGroup(): MNode {
    if (this.is('{')) {
      this.next()
      const r = this.parseRow((t) => t.t === '}')
      if (!this.is('}')) throw new MathError('missing }')
      this.next()
      return r
    }
    return this.parseAtom()
  }
  /** atom followed by any ^ _ scripts */
  parseScripted(): MNode {
    let base = this.parseAtom()
    let sub: MNode | undefined, sup: MNode | undefined
    // big operators take under/over limits in display mode — except the
    // integrals, which TeX (and Temml) keep at the side
    let limits = base.k === 'sym' && !!base.big && this.display && !/[∫∬∭∮]/.test(base.t)
    if (base.k === 'sym' && base.fn && LIMIT_FUNCTIONS.includes(base.t)) limits = this.display
    for (;;) {
      if (this.is('cmd', 'limits')) { this.next(); limits = true; continue }
      if (this.is('cmd', 'nolimits')) { this.next(); limits = false; continue }
      if (this.is('^')) { this.next(); if (sup) throw new MathError('double superscript'); sup = this.parseGroup(); continue }
      if (this.is('_')) { this.next(); if (sub) throw new MathError('double subscript'); sub = this.parseGroup(); continue }
      // primes are superscripts
      if (this.is('ch', "'")) { const ps: MNode[] = []; while (this.is('ch', "'")) { this.next(); ps.push(mo('′', { pad: '0em' })) } const p = ps.length === 1 ? ps[0] : { k: 'row', c: ps } as MNode; sup = sup ? row([p, sup]) : p; continue }
      break
    }
    if (sub || sup) base = { k: 'scr', b: base, sub, sup, limits: limits || undefined }
    return base
  }
  parseAtom(): MNode {
    const t = this.next()
    switch (t.t) {
      case '{': this.i--; return this.parseGroup()
      case '}': throw new MathError('unexpected }')
      case '^': case '_': throw new MathError('script without base')
      case '&': case '\\\\': throw new MathError('alignment outside a table')
      case 'ch': return this.charAtom(t.v)
      case 'cmd': return this.command(t.v)
      case 'ws': return this.parseAtom() // unreachable outside raw mode
    }
  }
  charAtom(v: string): MNode {
    if (/[0-9]/.test(v)) { let n = v; while (this.is('ch') && /[0-9.]/.test(this.peek()!.v)) n += this.next().v; return mn(n) }
    // `(…)` / `[…]` with the closer in the same group is ONE node, the way Temml
    // (and Typst) see it: a script after `)` then belongs to the group.
    if (v === '(' || v === '[') {
      const close = v === '(' ? ')' : ']'
      let depth = 0, j = this.i, found = false
      for (; j < this.toks.length; j++) {
        const t = this.toks[j]
        if (t.t === '}' || t.t === '&' || t.t === '\\\\' || (t.t === 'cmd' && (t.v === 'right' || t.v === 'end'))) break
        if (t.t === 'ch' && t.v === v) depth++
        else if (t.t === 'ch' && t.v === close) { if (depth === 0) { found = true; break } depth-- }
      }
      if (found) {
        const c = this.parseRow((t) => t.t === 'ch' && t.v === close && this.i === j)
        this.next()
        return { k: 'fence', l: v, r: close, c }
      }
    }
    if (/[a-zA-Z]/.test(v)) return mi(v)
    if ('+-*/=<>,;:!?|.()[]'.includes(v)) return mo(v === '-' ? '−' : v === '*' ? '∗' : v)
    return mi(v)
  }
  command(name: string): MNode {
    const sym = byTex.get(name)
    if (sym) return symNode(sym)
    if (FUNCTIONS.includes(name) || LIMIT_FUNCTIONS.includes(name)) return mi(name, { fn: true })
    if (name in SPACES) return { k: 'space', em: SPACES[name] }
    if (name in FONTS) return this.font(FONTS[name], name === 'operatorname')
    if (name in ACCENTS) { const [a, s] = ACCENTS[name]; return { k: 'accent', b: this.parseGroup(), a, stretchy: s } }
    if (name in UNDER) { const b = this.parseGroup(); const node: MNode = { k: 'accent', b, a: UNDER[name], under: true, stretchy: true }; return this.braceLabel(node, name === 'underbrace', true) }
    if (name in OVER) { const b = this.parseGroup(); const node: MNode = { k: 'accent', b, a: OVER[name], stretchy: true }; return this.braceLabel(node, true, false) }
    if (name in BIG || /^[bB]igg?[lrm]$/.test(name)) {
      const size = BIG[name.replace(/[lrm]$/, '')]
      const d = this.delim()
      return mo(d, { stretchy: true, size })
    }
    switch (name) {
      case 'frac': case 'dfrac': case 'tfrac': return { k: 'frac', n: this.parseGroup(), d: this.parseGroup(), display: name === 'dfrac' ? true : name === 'tfrac' ? false : undefined }
      case 'binom': case 'dbinom': case 'tbinom': return { k: 'fence', l: '(', r: ')', c: { k: 'frac', n: this.parseGroup(), d: this.parseGroup(), nobar: true }, explicit: true }
      case 'sqrt': {
        let idx: MNode | undefined
        if (this.is('ch', '[')) { this.next(); idx = this.parseRow((t) => t.t === 'ch' && t.v === ']'); this.next() }
        return { k: 'sqrt', b: this.parseGroup(), i: idx }
      }
      case 'left': {
        const l = this.delim()
        const c = this.parseRow((t) => t.t === 'cmd' && t.v === 'right')
        if (!this.is('cmd', 'right')) throw new MathError('missing \\right')
        this.next()
        const r = this.delim(true)
        return { k: 'fence', l, r, c, explicit: true }
      }
      case 'right': throw new MathError('\\right without \\left')
      case 'text': case 'textrm': case 'textnormal': case 'mbox': case 'textsf': case 'texttt': return { k: 'text', t: this.rawGroup() }
      case 'textcolor': { const color = this.rawGroup(); return { k: 'style', c: this.parseGroup(), color } }
      case 'color': { const color = this.rawGroup(); return { k: 'style', c: this.parseRow((t) => t.t === '}'), color } }
      case 'boxed': return { k: 'style', c: this.parseGroup(), box: true }
      case 'cancel': return { k: 'style', c: this.parseGroup(), cancel: true }
      case 'displaystyle': { this.display = true; return { k: 'row', c: [] } }
      case 'textstyle': case 'scriptstyle': { this.display = false; return { k: 'row', c: [] } }
      case 'begin': return this.environment()
      case 'end': throw new MathError('\\end without \\begin')
      case 'not': { const a = this.parseGroup(); return a.k === 'sym' ? mo(a.t + '̸') : a }
      case 'stackrel': case 'overset': { const top = this.parseGroup(); const b = this.parseGroup(); return { k: 'scr', b, sup: top, limits: true } }
      case 'underset': { const bot = this.parseGroup(); const b = this.parseGroup(); return { k: 'scr', b, sub: bot, limits: true } }
      case 'phantom': return { k: 'style', c: this.parseGroup(), color: 'transparent' }
      case 'lVert': case 'rVert': return mo('‖')
      case 'lvert': case 'rvert': return mo('|')
      case 'lbrack': return mo('[')
      case 'rbrack': return mo(']')
      case 'hline': return { k: 'row', c: [] }
      case '$': return mi('$')
      case '%': return mi('%')
      case '&': return mi('&')
      case '#': return mi('#')
      case '_': return mi('_')
      case ' ': return { k: 'space', em: 0.25 }
    }
    throw new MathError(`unknown command \\${name}`)
  }
  /** a \left/\right/\big delimiter token */
  delim(close = false): string {
    const t = this.next()
    const key = t.t === 'cmd' ? '\\' + t.v : t.v
    const table = close ? CLOSE_FENCES : OPEN_FENCES
    if (key in table) return table[key]
    if (key in OPEN_FENCES) return OPEN_FENCES[key]
    if (key in CLOSE_FENCES) return CLOSE_FENCES[key]
    if (t.t === 'cmd' && byTex.get(t.v)) return byTex.get(t.v)!.cp
    if (t.t === 'ch' && '<>/'.includes(t.v)) return t.v === '<' ? '⟨' : t.v === '>' ? '⟩' : '/'
    throw new MathError(`bad delimiter ${key}`)
  }
  font(f: Font, isOp = false): MNode {
    if (isOp) return mi(this.rawGroup(), { fn: true })
    return { k: 'style', c: this.parseGroup(), font: f }
  }
  /** \text{…}: the braces' content verbatim (tokens joined, spaces kept) */
  rawGroup(): string {
    if (!this.is('{')) return this.next().v
    this.next()
    this.raw = true
    let depth = 1, s = ''
    try {
      while (depth) {
        const t = this.next()
        if (t.t === '{') depth++
        else if (t.t === '}') { depth--; if (!depth) break }
        else s += t.t === 'cmd' ? (t.v === ' ' ? ' ' : (byTex.get(t.v)?.cp ?? '\\' + t.v)) : t.v
      }
    } finally { this.raw = false }
    return s
  }
  braceLabel(node: MNode, allowSup: boolean, under: boolean): MNode {
    // \underbrace{x}_{label} / \overbrace{x}^{label}
    if (under && this.is('_')) { this.next(); return { k: 'scr', b: node, sub: this.parseGroup(), limits: true } }
    if (!under && allowSup && this.is('^')) { this.next(); return { k: 'scr', b: node, sup: this.parseGroup(), limits: true } }
    return node
  }
  environment(): MNode {
    const name = this.rawGroup()
    const fences = ENV_FENCES[name]
    if (!fences) throw new MathError(`unknown environment ${name}`)
    if (name === 'array') this.rawGroup() // column spec, ignored beyond alignment
    const rows: MNode[][] = [[]]
    const cur = () => rows[rows.length - 1]
    const cell = (): MNode => this.parseRow((t) => t.t === '&' || t.t === '\\\\' || (t.t === 'cmd' && t.v === 'end'))
    cur().push(cell())
    for (;;) {
      if (this.is('&')) { this.next(); cur().push(cell()); continue }
      if (this.is('\\\\')) { this.next(); if (this.is('ch', '[')) { while (!this.is('ch', ']')) this.next(); this.next() } rows.push([]); cur().push(cell()); continue }
      if (this.is('cmd', 'end')) { this.next(); const e = this.rawGroup(); if (e !== name) throw new MathError('mismatched \\end'); break }
      throw new MathError('bad table')
    }
    // a trailing \\ leaves an empty last row
    if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0].k === 'row' && (rows[rows.length - 1][0] as { c: MNode[] }).c.length === 0) rows.pop()
    const align = name.startsWith('align') || name === 'aligned' ? 'rl' : name === 'cases' ? 'll' : 'c'
    return { k: 'table', rows, l: fences[0], r: fences[1], align }
  }
}

export function parseLatex(src: string, display: boolean): MNode {
  const p = new Parser(tokenize(src), display)
  const r = p.parseRow(() => false)
  if (p.peek()) throw new MathError('trailing input')
  return r
}
