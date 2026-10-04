// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * maths-lite — the LaTeX front end: tokenizer + recursive-descent parser →
 * the shared tree (ast.ts). Supported set = Temml 0.13.3's vocabulary, held
 * to it command by command (scripts/test-maths-coverage.ts, #551): the
 * symbols, the environments, user macros within a formula, the physics
 * package as built-in macros, and mhchem through mhchem.ts. An unknown
 * command throws MathError (strict: the rigs) or is drawn as its own name so
 * the rest still renders (lenient: what slides ask for); malformed input is
 * always MathError, which index.ts turns into "leave the source as typed".
 */

import { type MNode, type Font, row, mi, mn, mo, MathError, symNode } from './ast.ts'
import { byTex, byGlyph, FUNCTIONS, LIMIT_FUNCTIONS, FN_TEXT, styledChar } from './symbols.ts'
import { ceToTex, puToTex } from './mhchem.ts'

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
const ACCENTS: Record<string, [string, boolean?]> = { hat: ['^'], widehat: ['^', true], tilde: ['~'], widetilde: ['~', true], bar: ['‾'], overline: ['‾', true], vec: ['→'], dot: ['˙'], ddot: ['¨'], acute: ['´'], grave: ['`'], breve: ['˘'], check: ['ˇ'], overrightarrow: ['→', true], overleftarrow: ['←', true], mathring: ['˚'],
  // #551: the rest of Temml's accents, in its glyphs; \v \u \H \r are the
  // text accents, which Temml also accepts in maths
  dddot: ['…'], ddddot: ['….'], widecheck: ['ˇ', true], overleftrightarrow: ['↔', true], Overrightarrow: ['⇒', true], overleftharpoon: ['↼', true], overrightharpoon: ['⇀', true],
  overbracket: ['⎴', true], overparen: ['⏜', true], wideparen: ['⏜', true], overgroup: ['⏠', true], v: ['ˇ'], u: ['˘'], H: ['˝'], r: ['˚'] }
const UNDER: Record<string, string> = { underline: '_', underbar: '_', underbrace: '⏟', underrightarrow: '→', underleftarrow: '←', underleftrightarrow: '↔', underbracket: '⎵', underparen: '⏝', undergroup: '⏡', utilde: '~', c: '¸' }
const OVER: Record<string, string> = { overbrace: '⏞' }
const FONTS: Record<string, Font> = { mathbb: 'bb', mathcal: 'cal', mathscr: 'scr', mathfrak: 'frak', mathbf: 'bf', boldsymbol: 'bf', bm: 'bf', mathit: 'it', mathsf: 'sf', mathtt: 'tt', mathrm: 'rm', operatorname: 'rm', textbf: 'bf', textit: 'it',
  // the older spellings (#551)
  bold: 'bf', Bbb: 'bb', frak: 'frak', mathsfit: 'sfit', mathbfit: 'bfit', Bbbk: 'bb' }
const SPACES: Record<string, number> = { ',': 0.1667, ':': 0.2222, ';': 0.2778, '!': -0.1667, quad: 1, qquad: 2, ' ': 0.25, thinspace: 0.1667, medspace: 0.2222, thickspace: 0.2778, enspace: 0.5, negthinspace: -0.1667,
  enskip: 0.5, negmedspace: -0.2222, negthickspace: -0.2778, space: 0.25, nobreakspace: 0.25, '>': 0.2222 }
/** \large and family: the rest of the group at this size (em), Temml's steps */
const SIZES: Record<string, number> = { tiny: 0.5, sixptsize: 0.6, Tiny: 0.6, scriptsize: 0.7, footnotesize: 0.8, small: 0.9, normalsize: 1, large: 1.2, Large: 1.44, LARGE: 1.728, huge: 2.074, Huge: 2.488 }
/** commands that only steer TeX's line breaking or expansion: nothing to draw */
const NOOPS = new Set(['allowbreak', 'nobreak', 'relax', 'long', 'noexpand', 'expandafter', 'strut', 'displaylimits', 'nolinebreak', 'protect', 'arraystretch', 'arraycolsep'])
const ENV_FENCES: Record<string, [string, string]> = { matrix: ['', ''], pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], cases: ['{', ''], aligned: ['', ''], align: ['', ''], 'align*': ['', ''], gathered: ['', ''], gather: ['', ''], 'gather*': ['', ''], array: ['', ''], smallmatrix: ['', ''], split: ['', ''], multline: ['', ''], 'multline*': ['', ''], eqnarray: ['', ''], 'eqnarray*': ['', ''], equation: ['', ''], 'equation*': ['', ''], alignat: ['', ''], 'alignat*': ['', ''], alignedat: ['', ''],
  // #551: starred matrices take a column alignment; rcases/dcases/drcases;
  // darray is array in display style
  'matrix*': ['', ''], 'pmatrix*': ['(', ')'], 'bmatrix*': ['[', ']'], 'Bmatrix*': ['{', '}'], 'vmatrix*': ['|', '|'], 'Vmatrix*': ['‖', '‖'],
  rcases: ['', '}'], dcases: ['{', ''], drcases: ['', '}'], darray: ['', ''], subarray: ['', ''], 'split*': ['', ''], flalign: ['', ''], 'flalign*': ['', ''] }
/** mathtools' colon relations: one operator each, relation-spaced */
const COLONS: Record<string, string> = { colonapprox: '∶≈', colonsim: '∶∼', coloneq: '∶−', colonminus: '∶−', coloncolonapprox: '∷≈', coloncolonsim: '∷∼', coloncolonminus: '∷−',
  Colonapprox: '∷≈', Colonsim: '∷∼', Coloneq: '∷−', Eqcolon: '−∷', Eqqcolon: '=∷', equalscoloncolon: '=∷', minuscoloncolon: '−∷', minuscolon: '−∶', ratio: '∶', vcentcolon: '∶', dblcolon: '∷' }
/** the Greek capitals that look Latin (\Alpha is Α, not A) and the upright
 *  lowercase (\upalpha): identifiers drawn upright, as Temml does */
const UPRIGHT: Record<string, string> = { Alpha: 'Α', Beta: 'Β', Epsilon: 'Ε', Zeta: 'Ζ', Eta: 'Η', Iota: 'Ι', Kappa: 'Κ', Mu: 'Μ', Nu: 'Ν', Omicron: 'Ο', Rho: 'Ρ', Tau: 'Τ', Chi: 'Χ', Upsilon: 'Υ', AA: 'Å', aa: 'å', omicron: 'ο' }
/** where a switch (\large, \rm, \color) stops: the end of its group or cell */
const groupEnd = (t: Tok) => t.t === '}' || t.t === '&' || t.t === '\\\\' || (t.t === 'cmd' && (t.v === 'end' || t.v === 'right' || t.v === 'middle'))
/** \textcircled: the circled letters and digits Unicode has */
const circled = (s: string) => [...s].map((c) => /[A-Z]/.test(c) ? String.fromCodePoint(0x24b6 + c.charCodeAt(0) - 65) : /[a-z]/.test(c) ? String.fromCodePoint(0x24d0 + c.charCodeAt(0) - 97) : /[1-9]/.test(c) ? String.fromCodePoint(0x2460 + c.charCodeAt(0) - 49) : c === '0' ? '⓪' : c).join('')
/** \textsc: lowercase as small capitals */
const SMALLCAPS = 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ'
const smallcaps = (s: string) => s.replace(/[a-z]/g, (c) => SMALLCAPS[c.charCodeAt(0) - 97])
/** a user macro (\newcommand, \def) or a built-in one (physics): its
 *  argument count, the default for an optional first argument, its body */
type Macro = { n: number; opt?: Tok[]; body: Tok[] }

/** the physics package, as macros over what the parser already knows: name →
 *  [argument count, body]. Temml's spellings, so a deck looks as it would there. */
const PHYSICS: Record<string, [number, string]> = {
  abs: [1, '\\left|#1\\right|'], absolutevalue: [1, '\\left|#1\\right|'], norm: [1, '\\left\\|#1\\right\\|'], vqty: [1, '\\left|#1\\right|'],
  pqty: [1, '\\left(#1\\right)'], bqty: [1, '\\left[#1\\right]'], Bqty: [1, '\\left\\{#1\\right\\}'], quantity: [1, '\\left\\{#1\\right\\}'],
  // the bar is an ordinary symbol (\mathord), as Temml draws it: a bare |
  // is an operator that grows to the tallest thing in the row
  bra: [1, '\\langle #1\\mathord{|}'], ket: [1, '\\mathord{|}#1\\rangle'], braket: [1, '\\langle #1\\rangle'], Braket: [1, '\\langle #1\\rangle'], ketbra: [2, '\\mathord{|}#1\\rangle\\langle #2\\mathord{|}'],
  expval: [1, '\\left\\langle #1\\right\\rangle'], expectationvalue: [1, '\\left\\langle #1\\right\\rangle'], ev: [1, '\\left\\langle #1\\right\\rangle'],
  mel: [3, '\\left\\langle #1\\right|#2\\left|#3\\right\\rangle'], matrixel: [3, '\\left\\langle #1\\right|#2\\left|#3\\right\\rangle'], matrixelement: [3, '\\left\\langle #1\\right|#2\\left|#3\\right\\rangle'],
  comm: [2, '\\left[#1,#2\\right]'], commutator: [2, '\\left[#1,#2\\right]'], acomm: [2, '\\left\\{#1,#2\\right\\}'], anticommutator: [2, '\\left\\{#1,#2\\right\\}'], pb: [2, '\\left\\{#1,#2\\right\\}'], poissonbracket: [2, '\\left\\{#1,#2\\right\\}'],
  dd: [0, '\\text{d}'], differential: [0, '\\text{d}'], order: [1, '\\mathcal{O}\\left(#1\\right)'],
  vb: [1, '\\boldsymbol{#1}'], vectorbold: [1, '\\boldsymbol{#1}'], va: [1, '\\vec{\\boldsymbol{#1}}'], vectorarrow: [1, '\\vec{\\boldsymbol{#1}}'], vu: [1, '\\hat{\\boldsymbol{#1}}'], vectorunit: [1, '\\hat{\\boldsymbol{#1}}'],
  grad: [0, '\\pmb{\\nabla}'], gradient: [0, '\\pmb{\\nabla}'], divergence: [0, '\\pmb{\\nabla}\\pmb{\\cdot}'], curl: [0, '\\pmb{\\nabla}\\mskip4mu\\pmb{\\times}\\mskip4mu'], laplacian: [0, '\\nabla^2'],
  cross: [0, '\\pmb{\\times}'], cp: [0, '\\mskip4mu\\pmb{\\times}\\mskip4mu'], crossproduct: [0, '\\pmb{\\times}'], dotproduct: [0, '\\pmb{\\cdot}'], vdot: [0, '\\pmb{\\cdot}'],
  qq: [1, '\\quad\\text{ #1 }\\quad'], qqtext: [1, '\\quad\\text{ #1 }\\quad'], pv: [0, '\\mathcal{P}'], PV: [0, '\\mathcal{P}'], principalvalue: [0, '\\mathcal{P}'],
  set: [1, '\\{#1\\}'], Set: [1, '\\left\\{\\:#1\\:\\right\\}'], Bra: [1, '\\left\\langle #1\\right|'], Ket: [1, '\\left|#1\\right\\rangle'],
  innerproduct: [2, '\\left\\langle #1\\middle|#2\\right\\rangle'], outerproduct: [2, '\\left|#1\\right\\rangle\\left\\langle #2\\right|'], dyad: [2, '\\left|#1\\right\\rangle\\left\\langle #2\\right|'], op: [2, '\\left|#1\\right\\rangle\\left\\langle #2\\right|'],
  phase: [1, '\\angle #1'], TextOrMath: [2, '#2'], vcenter: [1, '#1'], eval: [1, '\\left.#1\\right|'], evaluated: [1, '\\left.#1\\right|'],
}
// \qand, \qif, … : a word between quads
for (const w of ['and', 'as', 'assume', 'c', 'cc', 'comma', 'else', 'even', 'for', 'given', 'if', 'in', 'integer', 'let', 'odd', 'or', 'otherwise', 'since', 'then', 'unless', 'using', 'all'])
  PHYSICS['q' + w] = [0, w === 'comma' ? ',\\quad' : w === 'c' ? '\\quad\\text{c.c.}' : w === 'cc' ? '\\quad\\text{c.c.}' : `\\quad\\text{${w}}\\quad`]
/** \xrightarrow and family: the arrow each draws */
const XARROWS: Record<string, string> = { xrightarrow: '→', xleftarrow: '←', xleftrightarrow: '↔', xRightarrow: '⇒', xLeftarrow: '⇐', xLeftrightarrow: '⇔', xmapsto: '↦', xhookrightarrow: '↪', xhookleftarrow: '↩', xtwoheadrightarrow: '↠', xtwoheadleftarrow: '↞', xlongequal: '=',
  // #551: the harpoons, and mhchem's reaction arrows by their Temml names
  xleftharpoondown: '↽', xleftharpoonup: '↼', xrightharpoondown: '⇁', xrightharpoonup: '⇀', xleftrightharpoons: '⇋', xrightleftharpoons: '⇌', xtofrom: '⇄',
  longleftharpoondown: '↽', longrightharpoonup: '⇀', yields: '→', yieldsLeft: '←', yieldsLeftRight: '↔', chemequilibrium: '⇌', equilibriumRight: '⇌', equilibriumLeft: '⇋', mesomerism: '↔' }
/** the old font switches (\rm Res): the rest of the group in that font */
const SWITCHES: Record<string, Font> = { rm: 'rm', bf: 'bf', it: 'it', sf: 'sf', tt: 'tt', cal: 'cal' }
/** infix fractions: {a \over b}, {n \choose k}, {a \atop b} */
const INFIX = new Set(['over', 'choose', 'atop', 'brace', 'brack', 'above'])
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
  /** show an unknown command as its name in place instead of refusing the
   *  whole formula (render.ts; the rigs and the editor hint stay strict) */
  private lenient: boolean
  /** \newcommand / \def definitions: they live for this formula only */
  private macros = new Map<string, Macro>()
  private expansions = 0
  constructor(toks: Tok[], display: boolean, lenient = false) { this.toks = toks; this.display = display; this.lenient = lenient }
  /** A macro argument as TOKENS: a {group}'s content, or one token. */
  argTokens(): Tok[] {
    const p = this.next()
    if (p.t !== '{') return [p]
    const out: Tok[] = []
    for (let depth = 1; ;) {
      const t = this.toks[this.i++]
      if (!t) throw new MathError('missing }')
      if (t.t === '{') depth++
      else if (t.t === '}' && !--depth) return out
      out.push(t)
    }
  }
  /** `[…]` as tokens, when one follows; else undefined */
  optTokens(): Tok[] | undefined {
    if (!this.is('ch', '[')) return undefined
    this.next()
    const out: Tok[] = []
    while (!this.is('ch', ']')) out.push(this.next())
    this.next()
    return out
  }
  /** Expand a macro in place: its body, with #1…#9 replaced, goes back into
   *  the token stream and parsing carries on from its first atom, the way
   *  TeX reads it — so \R^2 puts the 2 on \R's expansion, and a body of
   *  several atoms (a+b) is several atoms, not one group. */
  expand(m: Macro): MNode {
    if (++this.expansions > 1000) throw new MathError('macro loop')
    const args: Tok[][] = []
    for (let k = 0; k < m.n; k++) args.push(k === 0 && m.opt ? (this.optTokens() ?? m.opt) : this.argTokens())
    const out: Tok[] = []
    for (let j = 0; j < m.body.length; j++) {
      const t = m.body[j], d = m.body[j + 1]
      if (t.t === 'ch' && t.v === '#' && d?.t === 'ch' && /[1-9]/.test(d.v)) { out.push(...(args[+d.v - 1] ?? [])); j++ } else out.push(t)
    }
    this.toks.splice(this.i, 0, ...out)
    const p = this.peek()
    return !p || groupEnd(p) ? { k: 'row', c: [] } : this.parseAtom()
  }
  /** \newcommand{\name}[n][default]{body}, \renewcommand, \providecommand,
   *  \def\name#1#2{body}, \let\a\b, \DeclareMathOperator{\name}{text} */
  define(kind: string): MNode {
    const star = this.is('ch', '*')
    if (star) this.next()
    // the name is a command in any real use; Temml also takes a bare
    // character, which then simply never matches anything
    const nameTok = (): string => {
      const t = this.is('{') ? this.argTokens()[0] : this.next()
      if (!t) throw new MathError('macro needs a name')
      return t.v
    }
    const name = nameTok()
    if (kind === 'let') {
      if (this.is('ch', '=')) this.next()
      if (this.peek()) this.macros.set(name, { n: 0, body: [this.next()] })
    } else if (kind === 'DeclareMathOperator') {
      this.macros.set(name, { n: 0, body: [{ t: 'cmd', v: 'operatorname' }, ...(star ? [{ t: 'ch', v: '*' } as Tok] : []), { t: '{', v: '{' }, ...this.argTokens(), { t: '}', v: '}' }] })
    } else if (kind.endsWith('def')) {
      let n = 0
      while (!this.is('{')) { const t = this.next(); if (t.t === 'ch' && /[1-9]/.test(t.v)) n = +t.v }
      this.macros.set(name, { n, body: this.argTokens() })
    } else {
      const count = this.optTokens()
      const opt = this.optTokens()
      const m: Macro = { n: count ? +count.map((t) => t.v).join('') || 0 : 0, opt, body: this.argTokens() }
      if (kind !== 'providecommand' || !this.macros.has(name)) this.macros.set(name, m)
    }
    return { k: 'row', c: [] }
  }
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
        // \above takes the rule's thickness: {1pt} or 1pt; the bar is drawn
        // at the default weight (a slide has no use for a hairline choice)
        if (p.v === 'above') { if (this.is('{')) this.rawGroup(); else while (this.is('ch') && /[\d.a-z]/.test(this.peek()!.v)) this.next() }
        const n = row(c), d = this.parseRow(stop)
        if (p.v === 'over' || p.v === 'above') return { k: 'frac', n, d }
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
    // a symbol typed as itself (∈, ≤, →, ∑): the class its command has, so
    // `x ∈ A` spaces like `x \in A` (#551)
    const s = byGlyph.get(v)
    return s ? (s.cls === 'i' ? mi(v) : mo(v, s.cls === 'big' ? { big: true } : undefined)) : mi(v)
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
    if (base.k === 'sym' && base.fn && (LIMIT_FUNCTIONS.includes(base.t) || Object.values(FN_TEXT).includes(base.t) || base.limfn)) limits = this.display
    if ((base.k === 'accent' && base.lim) || (base.k === 'multi' && base.b.k === 'sym' && base.b.big)) limits = this.display
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
    return this.charAtomSingle(v)
  }
  command(name: string): MNode {
    // a macro this formula defined wins over everything (\renewcommand\vec)
    const user = this.macros.get(name)
    if (user) return this.expand(user)
    const sym = byTex.get(name)
    if (sym) return symNode(sym)
    if (FUNCTIONS.includes(name) || LIMIT_FUNCTIONS.includes(name)) return mi(FN_TEXT[name] ?? name, { fn: true })
    if (name in SPACES) return { k: 'space', em: SPACES[name] }
    if (name in SIZES) return { k: 'style', c: this.parseRow(groupEnd), size: SIZES[name] }
    if (NOOPS.has(name)) return { k: 'row', c: [] }
    if (name in COLONS) return mo(COLONS[name], { pad: '0.2778em' })
    if (name in UPRIGHT) return mi(UPRIGHT[name], { up: true })
    // \upalpha: the Greek letter, upright
    if (name.startsWith('up') && byTex.get(name.slice(2))?.cls === 'i' && /^[α-ωϵϑϕϖϱς]$/.test(byTex.get(name.slice(2))!.cp)) return mi(byTex.get(name.slice(2))!.cp, { up: true })
    if (name in FONTS) {
      // \operatorname*{argmax}: the star puts its scripts under/over in display
      if (name === 'operatorname' && this.is('ch', '*')) { this.next(); const n = this.font('rm', true); if (n.k === 'sym') n.limfn = true; return n }
      return this.font(FONTS[name], name === 'operatorname')
    }
    if (name in SWITCHES) return { k: 'style', c: this.parseRow(groupEnd), font: SWITCHES[name] }
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
        const f: MNode = { k: 'frac', n: this.parseArg(), d: this.parseArg(), nobar: /^0(\.0*)?\s*[a-z]*$/.test(thick) || undefined, display: st === '0' ? true : st === '1' ? false : undefined, level: st === '2' ? 1 : st === '3' ? 2 : undefined }
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
      case 'mspace': case 'hskip': case 'kern': case 'mkern': case 'mskip': { const d = this.dimension(); return { k: 'space', em: dimEm(name.startsWith('m') && !/[a-z]{2}\s*$/.test(d) ? d + 'mu' : d) } }
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
      case 'text': case 'textrm': case 'textnormal': case 'mbox': case 'textsf': case 'texttt': case 'textup': case 'textmd': case 'hbox': case 'textsl': return { k: 'text', t: this.rawGroup() }
      case 'textsc': return { k: 'text', t: smallcaps(this.rawGroup()) }
      case 'textcircled': return { k: 'text', t: circled(this.rawGroup()) }
      case 'fbox': case 'framebox': return { k: 'style', c: { k: 'text', t: this.rawGroup() }, box: true }
      case 'colorbox': { const bg = this.rawGroup(); return { k: 'style', c: { k: 'text', t: this.rawGroup() }, bg } }
      case 'fcolorbox': { const frame = this.rawGroup(), bg = this.rawGroup(); return { k: 'style', c: { k: 'text', t: this.rawGroup() }, bg, frame } }
      case 'bcancel': return { k: 'style', c: this.parseGroup(), cancel: 'down' }
      case 'xcancel': return { k: 'style', c: this.parseGroup(), cancel: 'x' }
      case 'sout': return { k: 'style', c: this.parseGroup(), cancel: 'h' }
      case 'cancelto': { const to = this.parseGroup(); return { k: 'scr', b: { k: 'style', c: this.parseGroup(), cancel: true }, sup: to } }
      case 'pmb': return { k: 'style', c: this.parseGroup(), bold: true }
      case 'mathnormal': case 'mathinner': return this.parseGroup()
      case 'hphantom': return { k: 'pad', c: this.parseGroup(), phantom: true, h0: true, d0: true }
      case 'vphantom': return { k: 'pad', c: this.parseGroup(), phantom: true, w0: true }
      case 'mathstrut': return { k: 'pad', c: mo('('), phantom: true, w0: true }
      case 'smash': {
        const o = this.optTokens()?.map((t) => t.v).join('') ?? 'tb'
        return { k: 'pad', c: this.parseGroup(), h0: o.includes('t') || undefined, d0: o.includes('b') || undefined }
      }
      case 'rlap': case 'mathrlap': return { k: 'pad', c: this.parseGroup(), lap: 'r' }
      case 'llap': case 'mathllap': return { k: 'pad', c: this.parseGroup(), lap: 'l' }
      case 'clap': case 'mathclap': return { k: 'pad', c: this.parseGroup(), lap: 'c' }
      case 'sideset': {
        // \sideset{_a^b}{_c^d}\sum: two groups of scripts around a big operator
        const scripts = () => {
          if (!this.is('{')) throw new MathError('\\sideset needs groups')
          this.next()
          let sub: MNode | undefined, sup: MNode | undefined
          while (!this.is('}')) {
            if (this.is('_')) { this.next(); sub = this.parseGroup() }
            else if (this.is('^')) { this.next(); sup = this.parseGroup() }
            else if (this.is('ch', "'")) { this.next(); sup = mo('′', { pad: '0em' }) }
            else throw new MathError('\\sideset takes scripts')
          }
          this.next()
          return { sub, sup }
        }
        const pre = scripts(), post = scripts()
        return { k: 'multi', b: this.parseAtom(), presub: pre.sub, presup: pre.sup, sub: post.sub, sup: post.sup }
      }
      case 'prescript': { const presup = this.parseGroup(), presub = this.parseGroup(); return { k: 'multi', b: this.parseGroup(), presup, presub } }
      case 'operatornamewithlimits': { const n = this.font('rm', true); if (n.k === 'sym') n.limfn = true; return n }
      case 'varliminf': return { k: 'accent', b: mi('lim', { fn: true }), a: '_', under: true, stretchy: true, lim: true }
      case 'varlimsup': return { k: 'accent', b: mi('lim', { fn: true }), a: '‾', stretchy: true, lim: true }
      case 'varinjlim': return { k: 'accent', b: mi('lim', { fn: true }), a: '→', under: true, stretchy: true, lim: true }
      case 'varprojlim': return { k: 'accent', b: mi('lim', { fn: true }), a: '←', under: true, stretchy: true, lim: true }
      case 'idotsint': return row([mo('∫', { big: true }), mo('⋯'), mo('∫', { big: true })])
      // the last of Temml's vocabulary (#551): actuarial angle, long
      // division, mirrored text, coherence relations, mhchem's standard state
      // and dashed bonds, \futurelet
      case 'angl': return { k: 'style', c: this.parseGroup(), rule: 'angl' }
      case 'angln': return { k: 'style', c: mi('n'), rule: 'angl' }
      case 'longdiv': return row([mo(')', { stretchy: true }), { k: 'style', c: this.parseGroup(), rule: 'top' }])
      case 'reflectbox': return { k: 'style', c: { k: 'text', t: this.rawGroup() }, mirror: true }
      case 'coh': case 'incoh': {
        const [top, bot] = name === 'coh' ? ['⌢', '⌣'] : ['⌣', '⌢']
        return row([{ k: 'space', em: 0.2778 }, { k: 'scr', b: mi(bot), sup: mi(top), limits: true }, { k: 'space', em: 0.2778 }])
      }
      case 'scoh': case 'sincoh': return row([{ k: 'space', em: 0.2778 }, mi(name === 'scoh' ? '⌢' : '⌣'), { k: 'space', em: 0.2778 }])
      case 'standardstate': return { k: 'style', c: { k: 'text', t: '⦵' }, size: 0.5 }
      case 'uniDash': case 'triDash': case 'tripleDash': case 'tripleDashOverLine': case 'tripleDashOverDoubleLine': case 'tripleDashBetweenDoubleLine':
        return { k: 'bond', kind: name }
      case 'futurelet': {
        // \futurelet\cs\a\b: \cs becomes the token AFTER \a, which stays put
        const cs = this.next()
        const ahead = this.toks[this.i + 1]
        if (ahead) this.macros.set(cs.v, { n: 0, body: [ahead] })
        return { k: 'row', c: [] }
      }
      case 'surd': return mo('√')
      case 'LaTeX': case 'TeX': case 'Temml': case 'KaTeX': return { k: 'text', t: name }
      case 'eqref': return { k: 'text', t: `(${this.rawGroup()})` }
      case 'ref': return { k: 'text', t: this.rawGroup() }
      case 'newline': return { k: 'row', c: [] }
      case 'newcommand': case 'renewcommand': case 'providecommand': case 'def': case 'gdef': case 'edef': case 'xdef': case 'let': case 'DeclareMathOperator':
        return this.define(name)
      // physics: derivatives take an optional order and one or two arguments
      // (\dv{x} is d/dx, \dv{f}{x} is df/dx, \dv[2]{f}{x} the second)
      case 'dv': case 'derivative': case 'odv': case 'pdv': case 'partialderivative': case 'fdv': case 'functionalderivative': {
        const d = name.startsWith('p') ? '\\partial ' : name.startsWith('f') ? '\\delta ' : '\\text{d}'
        const order = this.optTokens()?.map((t) => t.v).join('')
        const a = this.argTokens(), b = this.is('{') ? this.argTokens() : null
        const src = (x: Tok[]) => x.map((t) => (t.t === 'cmd' ? '\\' + t.v + ' ' : t.v)).join('')
        const pow = order ? `^{${order}}` : ''
        const tex = b ? `\\frac{${d}${pow}${src(a)}}{${d}${src(b)}${pow}}` : `\\frac{${d}${pow}}{${d}${src(a)}${pow}}`
        this.toks.splice(this.i, 0, ...tokenize(`{${tex}}`))
        return this.parseAtom()
      }
      // \qty(…), \qty[…], \qty|…|, \qty{…}: stretchy fences around the group
      case 'qty': {
        const open = this.peek()
        const pairs: Record<string, string> = { '(': ')', '[': ']', '|': '|' }
        if (open?.t === 'ch' && open.v in pairs) {
          this.next()
          const c = this.parseRow((t) => t.t === 'ch' && t.v === pairs[open.v])
          this.next()
          return { k: 'fence', l: open.v, r: pairs[open.v], c, explicit: true }
        }
        return { k: 'fence', l: '{', r: '}', c: this.parseGroup(), explicit: true }
      }
      // mhchem: \ce{…} chemistry and \pu{…} units, rewritten to LaTeX
      case 'ce': case 'pu': {
        const raw = this.rawSource()
        this.toks.splice(this.i, 0, ...tokenize(`{${name === 'ce' ? ceToTex(raw) : puToTex(raw)}}`))
        return this.parseAtom()
      }
      case 'textcolor': { const color = this.rawGroup(); return { k: 'style', c: this.parseGroup(), color } }
      case 'color': { const color = this.rawGroup(); return { k: 'style', c: this.parseRow(groupEnd), color } }
      case 'boxed': return { k: 'style', c: this.parseGroup(), box: true }
      case 'cancel': return { k: 'style', c: this.parseGroup(), cancel: true }
      case 'displaystyle': { this.display = true; return { k: 'row', c: [] } }
      case 'textstyle': case 'scriptstyle': case 'scriptscriptstyle': { this.display = false; return { k: 'row', c: [] } }
      // plain TeX's \matrix{a & b \cr c & d}
      case 'matrix': {
        if (!this.is('{')) throw new MathError('\\matrix needs a group')
        this.next()
        const end = (t: Tok) => t.t === '}' || t.t === '&' || t.t === '\\\\' || (t.t === 'cmd' && t.v === 'cr')
        const rows: MNode[][] = [[this.parseRow(end)]]
        while (!this.is('}')) {
          const t = this.next()
          if (t.t === '&') rows[rows.length - 1].push(this.parseRow(end))
          else if (!this.is('}')) rows.push([this.parseRow(end)])
        }
        this.next()
        return { k: 'table', rows, align: 'c' }
      }
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
      // a rule mid-row has no row edge to sit on; environment() reads the
      // ones at a row's start (where TeX allows them) as table rules
      case 'hline': case 'hdashline': return { k: 'row', c: [] }
      case '$': return mi('$')
      case '%': return mi('%')
      case '&': return mi('&')
      case '#': return mi('#')
      case '_': return mi('_')
      case ' ': return { k: 'space', em: 0.25 }
    }
    const phys = PHYSICS[name]
    if (phys) return this.expand({ n: phys[0], body: tokenize(phys[1]) })
    if (this.lenient) return { k: 'unknown', t: '\\' + name }
    throw new MathError(`unknown command \\${name}`)
  }
  /** a TeX dimension: {3pt}, or unbraced as TeX allows — \kern3pt, \mskip4mu */
  dimension(): string {
    if (this.is('{')) return this.rawGroup()
    let s = ''
    while (this.is('ch') && /[-\d.]/.test(this.peek()!.v)) s += this.next().v
    for (let k = 0; k < 2 && this.is('ch') && /[a-z]/.test(this.peek()!.v); k++) s += this.next().v
    return s
  }
  /** a {group}'s source text exactly as typed (for \ce and \pu) */
  rawSource(): string {
    return this.argTokens().map((t) => (t.t === 'cmd' ? '\\' + t.v + (/^[a-zA-Z]+$/.test(t.v) ? ' ' : '') : t.v)).join('')
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
  /** amscd's CD: objects and arrows on a grid. `@>a>b>` → with a over and b
   *  under, `@<<<` ←, `@=` a long equals; `@VaVbV` ↓ with a left and b right,
   *  `@AAA` ↑, `@|` a double bar; `@.` leaves a cell empty. A row holding a
   *  vertical arrow puts its arrows under the objects (even columns); an
   *  object row interleaves objects and horizontal arrows. */
  cd(): MNode {
    const stop = (t: Tok) => (t.t === 'ch' && t.v === '@') || t.t === '\\\\' || t.t === '&' || (t.t === 'cmd' && t.v === 'end')
    const label = (ch: string) => { const r = this.parseRow((t) => t.t === 'ch' && t.v === ch); this.next(); return r }
    const some = (n: MNode) => (n.k === 'row' && n.c.length === 0 ? undefined : n)
    const small = (n: MNode) => (some(n) ? { k: 'style', c: n, size: 0.7 } as MNode : { k: 'row', c: [] } as MNode)
    const object = () => { let o = this.parseRow(stop); while (this.is('&')) { this.next(); o = row([o, this.parseRow(stop)]) } return o }
    const rows: MNode[][] = []
    for (;;) {
      const parts: MNode[] = [object()]
      let vertical = false
      while (this.is('ch', '@')) {
        this.next()
        const k = this.next().v
        if (k === '>' || k === '<') { const a = label(k), b = label(k); parts.push({ k: 'xarrow', a: k === '>' ? '→' : '←', over: some(a), under: some(b) }) }
        else if (k === '=') parts.push({ k: 'xarrow', a: '=' })
        else if (k === 'V' || k === 'A') { vertical = true; const a = label(k), b = label(k); parts.push(row([small(a), mo(k === 'V' ? '↓' : '↑', { stretchy: true, size: 1.8 }), small(b)])) }
        else if (k === '|') { vertical = true; parts.push(mo('‖', { stretchy: true, size: 1.8 })) }
        else if (k === '.') parts.push({ k: 'row', c: [] })
        else throw new MathError(`bad CD arrow @${k}`)
        parts.push(object())
      }
      // a vertical row: its arrows go in the object columns, gaps between
      rows.push(vertical ? parts.filter((_, i) => i % 2).flatMap((a, i) => (i ? [{ k: 'row', c: [] } as MNode, a] : [a])) : parts)
      if (this.is('\\\\')) { this.next(); continue }
      break
    }
    if (!this.is('cmd', 'end')) throw new MathError('bad CD')
    this.next()
    if (this.rawGroup() !== 'CD') throw new MathError('mismatched \\end')
    if (rows.length > 1 && rows[rows.length - 1].every((c) => c.k === 'row' && c.c.length === 0)) rows.pop()
    return { k: 'table', rows, align: 'c', display: true }
  }
  environment(): MNode {
    const name = this.rawGroup()
    if (name === 'CD') return this.cd()
    const fences = ENV_FENCES[name]
    if (!fences) throw new MathError(`unknown environment ${name}`)
    // a starred matrix takes [l|c|r]; an array its column spec; alignat a count
    let cols: string | undefined
    if (name.endsWith('matrix*')) cols = this.optTokens()?.map((t) => t.v).join('').replace(/[^lcr]/g, '') || undefined
    // column rules from the spec: | solid, : dashed, || double, each on the
    // boundary it sits at (0 = before the first column)
    let vlines: string[] | undefined
    if (name.endsWith('array')) {
      const spec = this.rawGroup().replace(/\{[^}]*\}/g, '') // p{2cm}, @{…}: arguments, not columns
      cols = spec.replace(/[^lcr]/g, '') || undefined
      const vl = ['']
      for (const c of spec) {
        if (c === '|' || c === ':') vl[vl.length - 1] = c === ':' ? 'dashed' : vl[vl.length - 1] === 'solid' ? 'double' : 'solid'
        else if ('lcr'.includes(c)) vl.push('')
      }
      if (vl.some(Boolean)) vlines = vl
    } else if (name.startsWith('alignat')) this.rawGroup()
    // row rules at the start of a row: \hline solid, \hdashline dashed, two
    // in a row double — on the boundary above that row
    const hl: string[] = []
    const rule = () => { let r = ''; while (this.is('cmd', 'hline') || this.is('cmd', 'hdashline')) { const v = this.next().v; r = r ? 'double' : v === 'hline' ? 'solid' : 'dashed' } return r }
    const rows: MNode[][] = [[]]
    const cur = () => rows[rows.length - 1]
    const cell = (): MNode => this.parseRow((t) => t.t === '&' || t.t === '\\\\' || (t.t === 'cmd' && t.v === 'end'))
    hl[0] = rule()
    cur().push(cell())
    for (;;) {
      if (this.is('&')) { this.next(); cur().push(cell()); continue }
      if (this.is('\\\\')) { this.next(); if (this.is('ch', '[')) { while (!this.is('ch', ']')) this.next(); this.next() } hl[rows.length] = rule(); rows.push([]); cur().push(cell()); continue }
      if (this.is('cmd', 'end')) { this.next(); const e = this.rawGroup(); if (e !== name) throw new MathError('mismatched \\end'); break }
      throw new MathError('bad table')
    }
    // a trailing \\ leaves an empty last row
    if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0].k === 'row' && (rows[rows.length - 1][0] as { c: MNode[] }).c.length === 0) rows.pop()
    const align = name.startsWith('align') || name === 'aligned' || name.startsWith('split') || name.startsWith('eqnarray') || name.startsWith('flalign') ? 'rl'
      : /cases$/.test(name) ? 'll' : name.startsWith('multline') || name.startsWith('gather') || name.startsWith('equation') ? 'd' : 'c'
    // equation: one line, no table around it
    if (name.startsWith('equation') && rows.length === 1 && rows[0].length === 1) return rows[0][0]
    // how the columns sit (#551): aligned pairs right|left so the relations
    // line up, eqnarray right|centre|left, the cases family left
    const ncol = Math.max(...rows.map((r) => r.length))
    if (align === 'rl') cols = name.startsWith('eqnarray') ? 'rcl' : 'rl'.repeat(Math.ceil(ncol / 2))
    if (align === 'll') cols = 'l'
    return { k: 'table', rows, l: fences[0], r: fences[1], align, cols, display: name === 'dcases' || name === 'drcases' || name === 'darray' || undefined,
      vlines, hlines: hl.some(Boolean) ? hl : undefined }
  }
}

export function parseLatex(src: string, display: boolean, lenient = false): MNode {
  const p = new Parser(tokenize(src), display, lenient)
  // A line break outside any environment (#551) — what chat assistants write
  // for several display lines: `a = b \\ c = d`. Display maths stacks the
  // lines, centred, like gather; inline maths has nowhere to break to, so it
  // keeps one line (Temml draws both on one line).
  const isBreak = (t: Tok) => t.t === '\\\\' || (t.t === 'cmd' && t.v === 'newline')
  const lines = [p.parseRow(isBreak)]
  while (p.peek() && isBreak(p.peek()!)) {
    p.next()
    p.optTokens() // \\[4pt]: the extra leading is TeX's, not a slide's
    lines.push(p.parseRow(isBreak))
  }
  if (p.peek()) throw new MathError('trailing input')
  const empty = (n: MNode) => n.k === 'row' && n.c.length === 0
  while (lines.length > 1 && empty(lines[lines.length - 1])) lines.pop()
  if (lines.length === 1) return lines[0]
  return display ? { k: 'table', rows: lines.map((l) => [l]), align: 'd' } : row(lines.flatMap((l, i) => (i ? [mo(''), l] : [l])))
}
