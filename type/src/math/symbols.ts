// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The symbol tables: what a control sequence means, and what CLASS it is.
//
// The class is not decoration — it is the whole of TeX's horizontal spacing
// model. `a+b` sets wider than `ab` because `+` is a Bin, and `a=b` wider still
// because `=` is a Rel. Getting the class right is most of what makes a formula
// look like mathematics rather than like a string of characters, and it costs a
// table rather than an algorithm.
//
// One table, one entry per command, no aliases resolved at runtime: the parser
// looks a command up once and never branches on its name. Anything not in here
// is an unknown command, which is a rendering ERROR the reader can see and not
// an exception that takes the document down.

/** TeX's atom classes, minus Vcent and Rad which this subset does not expose. */
export type Cls = 'ord' | 'op' | 'bin' | 'rel' | 'open' | 'close' | 'punct' | 'inner';

export interface Sym { ch: string; cls: Cls }

const S = (ch: string, cls: Cls = 'ord'): Sym => ({ ch, cls });

/**
 * Greek. Lowercase is ITALIC and uppercase is UPRIGHT, which is the TeX
 * convention and the one every physics and maths paper follows; rendering
 * `\Omega` in italic makes a document look subtly foreign to the people who
 * read these most.
 */
export const GREEK_LOWER: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ',
  rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
  phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
};
export const GREEK_UPPER: Record<string, string> = {
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

/** Named operators that take LIMITS above and below in display style. */
export const BIG_OPS: Record<string, string> = {
  sum: '∑', prod: '∏', coprod: '∐',
  bigcup: '⋃', bigcap: '⋂', bigvee: '⋁', bigwedge: '⋀',
  bigoplus: '⨁', bigotimes: '⨂', bigodot: '⨀', bigsqcup: '⨆', biguplus: '⨄',
};

/**
 * Integrals. Separate from BIG_OPS because their scripts stay at the SIDE even
 * in display style — `\int_0^1` sets its bounds beside the sign, `\sum_0^1`
 * sets them above and below. TeX makes the same split (\intop vs \sum) and a
 * renderer that treats them alike gets every integral in the document wrong.
 */
export const INT_OPS: Record<string, string> = {
  int: '∫', iint: '∬', iiint: '∭', oint: '∮', oiint: '∯',
};

/**
 * Function names: upright, and set as a single unit. `\sin x` must not be four
 * italic variables multiplied together, which is what it looks like without
 * this list.
 *
 * The `true` ones take limits below in display style (`\lim_{x\to0}`).
 */
export const NAMED_OPS: Record<string, boolean> = {
  sin: false, cos: false, tan: false, cot: false, sec: false, csc: false,
  arcsin: false, arccos: false, arctan: false, sinh: false, cosh: false,
  tanh: false, coth: false, log: false, ln: false, lg: false, exp: false,
  det: false, dim: false, deg: false, arg: false, ker: false, hom: false,
  Pr: false, gcd: true, lim: true, limsup: true, liminf: true,
  max: true, min: true, sup: true, inf: true,
};

/** Everything else, by control-sequence name. */
export const SYMBOLS: Record<string, Sym> = {
  // ── binary operators
  times: S('×', 'bin'), div: S('÷', 'bin'), pm: S('±', 'bin'), mp: S('∓', 'bin'),
  cdot: S('⋅', 'bin'), ast: S('∗', 'bin'), star: S('⋆', 'bin'), circ: S('∘', 'bin'),
  bullet: S('∙', 'bin'), oplus: S('⊕', 'bin'), ominus: S('⊖', 'bin'),
  otimes: S('⊗', 'bin'), oslash: S('⊘', 'bin'), odot: S('⊙', 'bin'),
  cup: S('∪', 'bin'), cap: S('∩', 'bin'), setminus: S('∖', 'bin'),
  wedge: S('∧', 'bin'), vee: S('∨', 'bin'), land: S('∧', 'bin'), lor: S('∨', 'bin'),
  sqcup: S('⊔', 'bin'), sqcap: S('⊓', 'bin'), uplus: S('⊎', 'bin'),
  triangleleft: S('◃', 'bin'), triangleright: S('▹', 'bin'),

  // ── relations
  le: S('≤', 'rel'), leq: S('≤', 'rel'), ge: S('≥', 'rel'), geq: S('≥', 'rel'),
  ne: S('≠', 'rel'), neq: S('≠', 'rel'), equiv: S('≡', 'rel'),
  approx: S('≈', 'rel'), cong: S('≅', 'rel'), sim: S('∼', 'rel'), simeq: S('≃', 'rel'),
  propto: S('∝', 'rel'), ll: S('≪', 'rel'), gg: S('≫', 'rel'),
  subset: S('⊂', 'rel'), subseteq: S('⊆', 'rel'), supset: S('⊃', 'rel'),
  supseteq: S('⊇', 'rel'), sqsubseteq: S('⊑', 'rel'), sqsupseteq: S('⊒', 'rel'),
  in: S('∈', 'rel'), notin: S('∉', 'rel'), ni: S('∋', 'rel'),
  mid: S('∣', 'rel'), nmid: S('∤', 'rel'), perp: S('⊥', 'rel'),
  parallel: S('∥', 'rel'), asymp: S('≍', 'rel'), doteq: S('≐', 'rel'),
  models: S('⊨', 'rel'), vdash: S('⊢', 'rel'), dashv: S('⊣', 'rel'),
  prec: S('≺', 'rel'), succ: S('≻', 'rel'), preceq: S('⪯', 'rel'), succeq: S('⪰', 'rel'),

  // ── arrows (relations, for spacing)
  to: S('→', 'rel'), rightarrow: S('→', 'rel'), leftarrow: S('←', 'rel'),
  gets: S('←', 'rel'), leftrightarrow: S('↔', 'rel'),
  Rightarrow: S('⇒', 'rel'), Leftarrow: S('⇐', 'rel'), Leftrightarrow: S('⇔', 'rel'),
  implies: S('⟹', 'rel'), impliedby: S('⟸', 'rel'), iff: S('⟺', 'rel'),
  mapsto: S('↦', 'rel'), hookrightarrow: S('↪', 'rel'),
  uparrow: S('↑', 'rel'), downarrow: S('↓', 'rel'),
  nearrow: S('↗', 'rel'), searrow: S('↘', 'rel'),

  // ── ordinary symbols
  infty: S('∞'), partial: S('∂'), nabla: S('∇'), forall: S('∀'), exists: S('∃'),
  nexists: S('∄'), neg: S('¬'), lnot: S('¬'), emptyset: S('∅'), varnothing: S('∅'),
  aleph: S('ℵ'), hbar: S('ℏ'), ell: S('ℓ'), imath: S('ı'), jmath: S('ȷ'),
  Re: S('ℜ'), Im: S('ℑ'), wp: S('℘'), prime: S('′'), degree: S('°'),
  angle: S('∠'), triangle: S('△'), square: S('□'), surd: S('√'),
  top: S('⊤'), bot: S('⊥'), flat: S('♭'), sharp: S('♯'), natural: S('♮'),
  clubsuit: S('♣'), diamondsuit: S('♢'), heartsuit: S('♡'), spadesuit: S('♠'),
  checkmark: S('✓'), dagger: S('†'), ddagger: S('‡'),
  ldots: S('…'), dots: S('…'), cdots: S('⋯'), vdots: S('⋮'), ddots: S('⋱'),
  therefore: S('∴'), because: S('∵'),

  // ── punctuation and fences
  colon: S(':', 'punct'),
  langle: S('⟨', 'open'), rangle: S('⟩', 'close'),
  lceil: S('⌈', 'open'), rceil: S('⌉', 'close'),
  lfloor: S('⌊', 'open'), rfloor: S('⌋', 'close'),
  lbrace: S('{', 'open'), rbrace: S('}', 'close'),
  lbrack: S('[', 'open'), rbrack: S(']', 'close'),
  vert: S('|', 'ord'), Vert: S('‖', 'ord'),
};

/**
 * Escaped literals: `\{` is a brace, not the start of a group.
 *
 * `\\` is NOT here — it is a row break inside an environment and the parser
 * intercepts it before this table is consulted.
 */
export const ESCAPED: Record<string, Sym> = {
  '{': S('{', 'open'), '}': S('}', 'close'),
  '%': S('%'), '$': S('$'), '&': S('&'), '#': S('#'), '_': S('_'),
  '|': S('‖', 'ord'),
};

/** Single characters that are not letters or digits. */
export const CHAR_CLASS: Record<string, Sym> = {
  '+': S('+', 'bin'), '-': S('−', 'bin'), '*': S('∗', 'bin'), '/': S('/', 'ord'),
  '=': S('=', 'rel'), '<': S('<', 'rel'), '>': S('>', 'rel'),
  ',': S(',', 'punct'), ';': S(';', 'punct'), ':': S(':', 'rel'),
  '(': S('(', 'open'), '[': S('[', 'open'),
  ')': S(')', 'close'), ']': S(']', 'close'),
  '|': S('|', 'ord'), '!': S('!', 'close'), '?': S('?', 'ord'),
  '.': S('.', 'ord'), '"': S('”', 'ord'),
};

/**
 * Delimiters `\left` and `\right` will stretch, with the fraction of the box
 * that lies ABOVE the glyph's own centre. `.` is the null delimiter — TeX's way
 * of saying "one side only", and dropping it would make `\left. x \right|`
 * (a very common evaluation bar) unwritable.
 */
export const DELIMS: Record<string, string> = {
  '(': '(', ')': ')', '[': '[', ']': ']', '|': '|', '/': '/',
  '.': '', '\\{': '{', '\\}': '}', '\\|': '‖',
  '\\langle': '⟨', '\\rangle': '⟩',
  '\\lceil': '⌈', '\\rceil': '⌉', '\\lfloor': '⌊', '\\rfloor': '⌋',
  '\\lbrace': '{', '\\rbrace': '}', '\\vert': '|', '\\Vert': '‖',
  '\\uparrow': '↑', '\\downarrow': '↓',
};

/** Accents, and the glyph each one draws over its base. */
export const ACCENTS: Record<string, string> = {
  hat: 'ˆ', widehat: 'ˆ', check: 'ˇ', tilde: '˜', widetilde: '˜',
  acute: '´', grave: '`', dot: '˙', ddot: '¨', breve: '˘', bar: 'ˉ',
  vec: '⇀', mathring: '˚',
};

/** Explicit spaces, in em. */
export const SPACES: Record<string, number> = {
  ',': 3 / 18, ':': 4 / 18, ';': 5 / 18, '!': -3 / 18,
  ' ': 6 / 18, quad: 1, qquad: 2, enspace: 0.5, thinspace: 3 / 18,
};

/** `\mathbb{R}` and friends. Mapped to real Unicode, because there is no font. */
const BB: Record<string, string> = {
  A: '𝔸', B: '𝔹', C: 'ℂ', D: '𝔻', E: '𝔼', F: '𝔽', G: '𝔾', H: 'ℍ', I: '𝕀',
  J: '𝕁', K: '𝕂', L: '𝕃', M: '𝕄', N: 'ℕ', O: '𝕆', P: 'ℙ', Q: 'ℚ', R: 'ℝ',
  S: '𝕊', T: '𝕋', U: '𝕌', V: '𝕍', W: '𝕎', X: '𝕏', Y: '𝕐', Z: 'ℤ',
};
const CAL: Record<string, string> = {
  A: '𝒜', B: 'ℬ', C: '𝒞', D: '𝒟', E: 'ℰ', F: 'ℱ', G: '𝒢', H: 'ℋ', I: 'ℐ',
  J: '𝒥', K: '𝒦', L: 'ℒ', M: 'ℳ', N: '𝒩', O: '𝒪', P: '𝒫', Q: '𝒬', R: 'ℛ',
  S: '𝒮', T: '𝒯', U: '𝒰', V: '𝒱', W: '𝒲', X: '𝒳', Y: '𝒴', Z: '𝒵',
};
const FRAK: Record<string, string> = {
  A: '𝔄', B: '𝔅', C: 'ℭ', D: '𝔇', E: '𝔈', F: '𝔉', G: '𝔊', H: 'ℌ', I: 'ℑ',
  J: '𝔍', K: '𝔎', L: '𝔏', M: '𝔐', N: '𝔑', O: '𝔒', P: '𝔓', Q: '𝔔', R: 'ℜ',
  S: '𝔖', T: '𝔗', U: '𝔘', V: '𝔙', W: '𝔚', X: '𝔛', Y: '𝔜', Z: 'ℨ',
};

/**
 * The alphabet a `\mathbb`-style command maps a letter through.
 *
 * These are TRANSLITERATIONS, not fonts: a self-contained document cannot ship
 * a maths font, so `\mathbb{R}` becomes U+211D and takes whatever the reader's
 * system has. A letter with no double-struck codepoint is left alone rather
 * than replaced with a box.
 */
export const ALPHABETS: Record<string, Record<string, string>> = {
  mathbb: BB, mathcal: CAL, mathfrak: FRAK,
};
