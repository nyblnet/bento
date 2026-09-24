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
import { byTex, FUNCTIONS, LIMIT_FUNCTIONS, styledChar } from './symbols.ts'

/** A node that is only letters (\rm Res, \mathrm{Res}) as its text, else null. */
function textOf(n: MNode): string | null {
  if (n.k === 'sym' && n.cls === 'i') return n.t
  if (n.k === 'style' && !n.color && !n.box && !n.cancel) return textOf(n.c)
  if (n.k === 'row') { const parts = n.c.map(textOf); return parts.every((p) => p !== null) && parts.length ? parts.join('') : null }
  return null
}

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
const ACCENTS: Record<string, [string, boolean?]> = { hat: ['^'], widehat: ['^', true], tilde: ['~'], widetilde: ['~', true], bar: ['‾'], overline: ['‾', true], vec: ['→'], dot: ['˙'], ddot: ['¨'], acute: ['´'], grave: ['`'], breve: ['˘'], check: ['ˇ'], overrightarrow: ['→', true], overleftarrow: ['←', true], mathring: ['˚'] }
const UNDER: Record<string, string> = { underline: '_', underbrace: '⏟', underrightarrow: '→' }
const OVER: Record<string, string> = { overbrace: '⏞' }
const FONTS: Record<string, Font> = { mathbb: 'bb', mathcal: 'cal', mathscr: 'scr', mathfrak: 'frak', mathbf: 'bf', boldsymbol: 'bf', bm: 'bf', mathit: 'it', mathsf: 'sf', mathtt: 'tt', mathrm: 'rm', operatorname: 'rm', textbf: 'bf', textit: 'it' }
const SPACES: Record<string, number> = { ',': 0.1667, ':': 0.2222, ';': 0.2778, '!': -0.1667, quad: 1, qquad: 2, ' ': 0.25, thinspace: 0.1667, medspace: 0.2222, thickspace: 0.2778, enspace: 0.5, negthinspace: -0.1667 }
const ENV_FENCES: Record<string, [string, string]> = { matrix: ['', ''], pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], cases: ['{', ''], aligned: ['', ''], align: ['', ''], 'align*': ['', ''], gathered: ['', ''], gather: ['', ''], 'gather*': ['', ''], array: ['', ''], smallmatrix: ['', ''], split: ['', ''], multline: ['', ''], 'multline*': ['', ''], eqnarray: ['', ''], 'eqnarray*': ['', ''], equation: ['', ''], 'equation*': ['', ''], alignat: ['', ''], 'alignat*': ['', ''], alignedat: ['', ''] }
/** \xrightarrow and family: the arrow each draws */
const XARROWS: Record<string, string> = { xrightarrow: '→', xleftarrow: '←', xleftrightarrow: '↔', xRightarrow: '⇒', xLeftarrow: '⇐', xLeftrightarrow: '⇔', xmapsto: '↦', xhookrightarrow: '↪', xhookleftarrow: '↩', xtwoheadrightarrow: '↠', xtwoheadleftarrow: '↞', xlongequal: '=' }
/** the old font switches (\rm Res): the rest of the group in that font */
const SWITCHES: Record<string, Font> = { rm: 'rm', bf: 'bf', it: 'it', sf: 'sf', tt: 'tt', cal: 'cal' }
/** infix fractions: {a \over b}, {n \choose k}, {a \atop b} */
const INFIX = new Set(['over', 'choose', 'atop', 'brace', 'brack'])
/** a TeX dimension → em (the units a slide formula can mean; 10pt type) */
function dimEm(s: string): number {
  const m = /^\s*(-?[\d.]+)\s*(em|ex|pt|mu|px|mm|cm|in|bp|pc)?\s*$/.exec(s)
  if (!m) throw new MathError(`bad dimension ${s}`)
  const n = parseFloat(m[1])
  const per: Record<string, number> = { em: 1, ex: 0.431, pt: 0.1, mu: 1 / 18, px: 0.0625, mm: 0.2845, cm: 2.845, in: 7.227, bp: 0.1004, pc: 1.2 }
  return n * per[m[2] ?? 'em']
}

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

  /** A sequence up to a terminator the caller owns. An infix fraction
   *  (\over, \choose, \atop) splits the WHOLE sequence at itself. */
  parseRow(stop: (t: Tok) => boolean): MNode {
    const c: MNode[] = []
    while (this.peek() && !stop(this.peek()!)) {
      const p = this.peek()!
      if (p.t === 'cmd' && INFIX.has(p.v)) {
        this.next()
        const n = row(c), d = this.parseRow(stop)
        if (p.v === 'over') return { k: 'frac', n, d }
        const f: MNode = { k: 'frac', n, d, nobar: true }
        if (p.v === 'atop') return f
        const [l, r] = p.v === 'choose' ? ['(', ')'] : p.v === 'brace' ? ['{', '}'] : ['[', ']']
        return { k: 'fence', l, r, c: f, explicit: true }
      }
      const n = this.parseScripted()
      // \notag, \vspace, \displaystyle: nothing to lay out, so no empty box
      if (!(n.k === 'row' && n.c.length === 0)) c.push(n)
    }
    return row(c)
  }
  /** A macro's argument: a {group}, or ONE token — \frac12 is 1 over 2,
   *  where a bare 12 in a row is the number twelve. */
  parseArg(): MNode {
    const p = this.peek()
    if (!p) throw new MathError('missing argument')
    if (p.t === '{') return this.parseGroup()
    if (p.t === 'ch') { this.next(); return /[0-9]/.test(p.v) ? mn(p.v) : this.charAtomSingle(p.v) }
    return this.parseAtom()
  }
  private charAtomSingle(v: string): MNode {
    if (/[a-zA-Z]/.test(v)) return mi(v)
    if ('+-*/=<>,;:!?|.()[]'.includes(v)) return mo(v === '-' ? '−' : v === '*' ? '∗' : v)
    return mi(v)
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
    if (base.k === 'sym' && base.fn && (LIMIT_FUNCTIONS.includes(base.t) || base.limfn)) limits = this.display
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
    if (name in FONTS) {
      // \operatorname*{argmax}: the star puts its scripts under/over in display
      if (name === 'operatorname' && this.is('ch', '*')) { this.next(); const n = this.font('rm', true); if (n.k === 'sym') n.limfn = true; return n }
      return this.font(FONTS[name], name === 'operatorname')
    }
    if (name in SWITCHES) return { k: 'style', c: this.parseRow((t) => t.t === '}'), font: SWITCHES[name] }
    if (name in XARROWS) {
      let under: MNode | undefined
      if (this.is('ch', '[')) { this.next(); under = this.parseRow((t) => t.t === 'ch' && t.v === ']'); this.next() }
      const over = this.parseArg()
      const empty = (n: MNode | undefined) => !n || (n.k === 'row' && n.c.length === 0)
      return { k: 'xarrow', a: XARROWS[name], over: empty(over) ? undefined : over, under: empty(under) ? undefined : under }
    }
    if (name in ACCENTS) { const [a, s] = ACCENTS[name]; return { k: 'accent', b: this.parseArg(), a, stretchy: s } }
    if (name in UNDER) { const b = this.parseGroup(); const node: MNode = { k: 'accent', b, a: UNDER[name], under: true, stretchy: true }; return this.braceLabel(node, name === 'underbrace', true) }
    if (name in OVER) { const b = this.parseGroup(); const node: MNode = { k: 'accent', b, a: OVER[name], stretchy: true }; return this.braceLabel(node, true, false) }
    if (name in BIG || /^[bB]igg?[lrm]$/.test(name)) {
      const size = BIG[name.replace(/[lrm]$/, '')]
      const d = this.delim()
      return mo(d, { stretchy: true, size })
    }
    switch (name) {
      case 'frac': case 'dfrac': case 'tfrac': return { k: 'frac', n: this.parseArg(), d: this.parseArg(), display: name === 'dfrac' ? true : name === 'tfrac' ? false : undefined }
      case 'cfrac': return { k: 'frac', n: this.parseArg(), d: this.parseArg(), display: true }
      case 'binom': case 'dbinom': case 'tbinom': return { k: 'fence', l: '(', r: ')', c: { k: 'frac', n: this.parseArg(), d: this.parseArg(), nobar: true }, explicit: true }
      case 'genfrac': {
        // \genfrac{left}{right}{thickness}{style}{num}{den}
        const fenceOf = (s: string, close: boolean) => { const t = s.trim(); if (!t) return ''; const tab = close ? CLOSE_FENCES : OPEN_FENCES; if (t in tab) return tab[t]; if (t in OPEN_FENCES) return OPEN_FENCES[t]; if (t in CLOSE_FENCES) return CLOSE_FENCES[t]; throw new MathError(`bad delimiter ${t}`) }
        const rawArg = () => { if (this.is('{')) { this.next(); let s = ''; while (!this.is('}')) { const t = this.next(); s += t.t === 'cmd' ? '\\' + t.v : t.v } this.next(); return s } return this.next().v }
        const l = fenceOf(rawArg(), false), r = fenceOf(rawArg(), true), thick = rawArg().trim(), st = rawArg().trim()
        const f: MNode = { k: 'frac', n: this.parseArg(), d: this.parseArg(), nobar: /^0(\.0*)?\s*[a-z]*$/.test(thick) || undefined, display: st === '0' ? true : st === '1' ? false : undefined }
        return l || r ? { k: 'fence', l, r, c: f, explicit: true } : f
      }
      case 'sqrt': {
        let idx: MNode | undefined
        if (this.is('ch', '[')) { this.next(); idx = this.parseRow((t) => t.t === 'ch' && t.v === ']'); this.next() }
        return { k: 'sqrt', b: this.parseArg(), i: idx }
      }
      case 'middle': return mo(this.delim(), { stretchy: true, pad: '0.05em' })
      case 'colon': return mo(':', { pad: '0em', rpad: '0.1667em' })
      case 'bmod': return mo('mod', { pad: '0.2222em' })
      case 'pmod': case 'pod': case 'mod': {
        const arg = this.parseArg()
        const modWord = mi('mod', { fn: true })
        // an empty <mo> first, as Temml writes it: a line may break there
        if (name === 'mod') return row([mo(''), { k: 'space', em: 0.6667 }, modWord, { k: 'space', em: 0.3333 }, arg])
        return row([mo(''), { k: 'space', em: 0.4444 }, { k: 'fence', l: '(', r: ')', c: name === 'pmod' ? row([modWord, { k: 'space', em: 0.3333 }, arg]) : arg }])
      }
      case 'substack': {
        if (!this.is('{')) throw new MathError('\\substack needs a group')
        this.next()
        const rows: MNode[][] = [[this.parseRow((t) => t.t === '}' || t.t === '\\\\')]]
        while (this.is('\\\\')) { this.next(); rows.push([this.parseRow((t) => t.t === '}' || t.t === '\\\\')]) }
        if (!this.is('}')) throw new MathError('missing }')
        this.next()
        return { k: 'table', rows, align: 's' }
      }
      case 'mathbin': case 'mathrel': case 'mathord': case 'mathop': case 'mathopen': case 'mathclose': case 'mathpunct': {
        const g = this.parseArg()
        const flat = textOf(g)
        if (name === 'mathord') return g.k === 'sym' ? mi(g.t) : g
        if (name === 'mathop') return flat !== null ? mi(flat, { fn: true }) : g
        if (g.k !== 'sym') return g
        const pad = name === 'mathbin' ? '0.2222em' : name === 'mathrel' ? '0.2778em' : name === 'mathpunct' ? '0em' : undefined
        return mo(g.t, pad ? { pad, rpad: name === 'mathpunct' ? '0.1667em' : undefined } : {})
      }
      case 'emph': return { k: 'text', t: [...this.rawGroup()].map((c) => styledChar(c, 'it')).join('') }
      case 'hspace': { if (this.is('ch', '*')) this.next(); return { k: 'space', em: dimEm(this.rawGroup()) } }
      case 'mspace': case 'hskip': case 'kern': case 'mkern': case 'mskip': { const d = this.rawGroup(); return { k: 'space', em: dimEm(name.startsWith('m') && !/[a-z]{2}\s*$/.test(d) ? d + 'mu' : d) } }
      case 'vspace': { if (this.is('ch', '*')) this.next(); this.rawGroup(); return { k: 'row', c: [] } }
      case 'notag': case 'nonumber': case 'label': { if (name === 'label') this.rawGroup(); return { k: 'row', c: [] } }
      case 'tag': {
        // an equation label, set after the formula at a quad's distance;
        // \tag* without the parentheses
        const star = this.is('ch', '*'); if (star) this.next()
        const t = this.rawGroup()
        return row([{ k: 'space', em: 1 }, { k: 'text', t: star ? t : `(${t})` }])
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
    if (name === 'array' || name.startsWith('alignat')) this.rawGroup() // column spec / column count, ignored beyond alignment
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
    const align = name.startsWith('align') || name === 'aligned' || name === 'split' || name.startsWith('eqnarray') ? 'rl'
      : name === 'cases' ? 'll' : name.startsWith('multline') || name.startsWith('gather') || name.startsWith('equation') ? 'd' : 'c'
    // equation: one line, no table around it
    if (name.startsWith('equation') && rows.length === 1 && rows[0].length === 1) return rows[0][0]
    return { k: 'table', rows, l: fences[0], r: fences[1], align }
  }
}

export function parseLatex(src: string, display: boolean): MNode {
  const p = new Parser(tokenize(src), display)
  const r = p.parseRow(() => false)
  if (p.peek()) throw new MathError('trailing input')
  return r
}
