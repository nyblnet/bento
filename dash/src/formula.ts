// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The formula engine.
//
// ONE EXPRESSION PER COLUMN, and that is the largest structural improvement
// over a spreadsheet available here. Excel stores a formula per CELL, so a
// 100k-row model with 12 computed columns has 1.2 MILLION graph nodes, each
// carrying its own copy of the same expression and its own range references
// that shift when a row is inserted. Here it is 12 nodes, one stored string
// each, and inserting a row changes nothing at all — the `#REF!` class and the
// shifted-VLOOKUP class simply do not exist.
//
// EVALUATION IS VECTORISED. Every node returns either a SCALAR or a COLUMN of
// n values, and the two combine by broadcasting. So `Value * Rate` is one pass
// over two arrays rather than n interpreted expressions, and `Value / SUM(Value)`
// mixes a column and an aggregate without either side knowing about the other.
// Measured shape (design §7): a 100k-row workbook recalculates inside a frame,
// so there is no "calculating…" state and no async recalc UI.
//
// ERRORS PROPAGATE, they do not throw and they are never silently zero. A cell
// that could not be computed reads `#DIV/0!` or `#VALUE!` — visible, and wrong
// in a way you can see. Zero is a number, and a chart of zeros is a wrong
// answer wearing a right answer's clothes.

import type { TableSheet } from './model.ts'
import { readCell } from './store.ts'
import { sheetQualifiers } from './a1.ts'
// TEXT() is the column panel's own format engine, and VALUE()/DATEVALUE() are
// import's own reading of a string. Both are IMPORTS rather than second
// implementations, deliberately: two answers to "what does #,##0.00 mean", or
// to "what day is 03/04/2026", is one wrong number waiting for a date change.
import { formatNumber, readPattern } from './format.ts'
import { coerce, inferColumn } from './import.ts'

export type Cell = number | string | boolean | null | FormulaError
export type Vec = Cell[]

/**
 * Excel-shaped so the strings are already familiar.
 *
 * Fields are declared and assigned explicitly rather than as constructor
 * parameter properties: the rigs run TypeScript through node's strip-only
 * loader, which cannot express them (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
 */
export class FormulaError {
  code: string
  why?: string
  constructor(code: string, why?: string) { this.code = code; this.why = why }
  toString(): string { return this.code }
}
const ERR = {
  div0: () => new FormulaError('#DIV/0!'),
  value: (why?: string) => new FormulaError('#VALUE!', why),
  name: (n: string) => new FormulaError('#NAME?', `unknown name "${n}"`),
  cycle: () => new FormulaError('#CYCLE!'),
  na: () => new FormulaError('#N/A'),
  /** An array result had nowhere to land. See SPILL in cellformula.ts. */
  spill: (why?: string) => new FormulaError('#SPILL!', why),
}
/** Mint `#SPILL!` from outside this module — cellformula.ts owns the geometry. */
export const spillError = (why?: string): FormulaError => ERR.spill(why)
export const isErr = (v: unknown): v is FormulaError => v instanceof FormulaError

// --- lexer ------------------------------------------------------------------

type Tok =
  | { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'id'; v: string }
  | { t: 'op'; v: string } | { t: 'punc'; v: string }

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const isIdStart = (c: string) => /[A-Za-z_]/.test(c)
  const isId = (c: string) => /[A-Za-z0-9_.]/.test(c)
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j])) j++
      out.push({ t: 'num', v: Number(src.slice(i, j)) }); i = j; continue
    }
    if (c === '"') {
      // The doubled-quote escape was UNREACHABLE: the loop condition excluded
      // a quote, so the branch inside that handled a doubled one could never
      // run. It did not fail loudly either — a string holding an escaped quote
      // evaluated to everything BEFORE it and threw the rest away, so a formula
      // with a quoted phrase in it silently lost its text from that point on.
      // The loop now runs to the end of the source and decides at the quote.
      let j = i + 1, s = ''
      while (j < src.length) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { s += '"'; j += 2; continue }
          break
        }
        s += src[j++]
      }
      out.push({ t: 'str', v: s }); i = j + 1; continue
    }
    // [Bracketed Name] — the only way to reference a column whose name has spaces
    if (c === '[') {
      const j = src.indexOf(']', i)
      if (j < 0) { out.push({ t: 'id', v: src.slice(i + 1) }); i = src.length; continue }
      out.push({ t: 'id', v: src.slice(i + 1, j) }); i = j + 1; continue
    }
    if (isIdStart(c)) {
      let j = i
      while (j < src.length && isId(src[j])) j++
      out.push({ t: 'id', v: src.slice(i, j) }); i = j; continue
    }
    const two = src.slice(i, i + 2)
    if (two === '<=' || two === '>=' || two === '<>') { out.push({ t: 'op', v: two }); i += 2; continue }
    if ('+-*/^&=<>'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue }
    if ('(),'.includes(c)) { out.push({ t: 'punc', v: c }); i++; continue }
    i++ // anything else is skipped rather than fatal
  }
  return out
}

// --- parser (precedence climbing) -------------------------------------------

type Node =
  | { k: 'lit'; v: Cell }
  | { k: 'ref'; name: string }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'neg'; e: Node }

const PREC: Record<string, number> = {
  '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1,
  '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5,
}

function parse(src: string): Node {
  const toks = lex(src)
  let p = 0
  const peek = () => toks[p]
  const eat = () => toks[p++]

  function primary(): Node {
    const tk = eat()
    if (!tk) return { k: 'lit', v: ERR.value('empty expression') }
    if (tk.t === 'num') return { k: 'lit', v: tk.v }
    if (tk.t === 'str') return { k: 'lit', v: tk.v }
    if (tk.t === 'op' && tk.v === '-') return { k: 'neg', e: primary() }
    if (tk.t === 'op' && tk.v === '+') return primary()
    if (tk.t === 'punc' && tk.v === '(') {
      const e = expr(0)
      if (peek()?.t === 'punc' && peek()!.v === ')') eat()
      return e
    }
    if (tk.t === 'id') {
      if (peek()?.t === 'punc' && peek()!.v === '(') {
        eat()
        const args: Node[] = []
        if (!(peek()?.t === 'punc' && peek()!.v === ')')) {
          for (;;) {
            args.push(expr(0))
            if (peek()?.t === 'punc' && peek()!.v === ',') { eat(); continue }
            break
          }
        }
        if (peek()?.t === 'punc' && peek()!.v === ')') eat()
        return { k: 'call', name: tk.v.toUpperCase(), args }
      }
      const up = tk.v.toUpperCase()
      if (up === 'TRUE') return { k: 'lit', v: true }
      if (up === 'FALSE') return { k: 'lit', v: false }
      return { k: 'ref', name: tk.v }
    }
    return { k: 'lit', v: ERR.value() }
  }

  function expr(min: number): Node {
    let left = primary()
    for (;;) {
      const tk = peek()
      if (!tk || tk.t !== 'op') break
      const prec = PREC[tk.v]
      if (prec === undefined || prec < min) break
      eat()
      // ^ is right-associative, everything else left
      const right = expr(tk.v === '^' ? prec : prec + 1)
      left = { k: 'bin', op: tk.v, l: left, r: right }
    }
    return left
  }
  return expr(0)
}

/** Column names an expression depends on — the edges of the recalc graph. */
export function dependencies(src: string): string[] {
  const out = new Set<string>()
  const walk = (n: Node): void => {
    if (n.k === 'ref') out.add(n.name)
    else if (n.k === 'bin') { walk(n.l); walk(n.r) }
    else if (n.k === 'neg') walk(n.e)
    else if (n.k === 'call') n.args.forEach(walk)
  }
  walk(parse(src))
  return [...out]
}

// --- coercion ---------------------------------------------------------------

const num = (v: Cell): number | FormulaError => {
  if (isErr(v)) return v
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = Number(String(v).replace(/[,\s£$€¥%]/g, ''))
  return Number.isFinite(n) ? n : ERR.value(`"${v}" is not a number`)
}
const str = (v: Cell): string => (v == null ? '' : isErr(v) ? v.code : String(v))
const bool = (v: Cell): boolean => {
  if (isErr(v)) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return String(v ?? '').toLowerCase() === 'true'
}

// --- the function library ---------------------------------------------------
// Aggregates take a whole column and return a scalar; everything else is
// per row. The split is what lets `Value / SUM(Value)` work.

/**
 * The numbers in a vector, for an aggregate.
 *
 * A BLANK IS NOT A ZERO, and on a sparse spreadsheet that is the difference
 * between a right answer and a confident wrong one. `num()` maps an empty cell
 * to 0 — which is correct in ARITHMETIC (`=A1+1` where A1 is empty is 1, in
 * every spreadsheet there has ever been) and wrong in an AGGREGATE:
 * `AVERAGE(A1:A10)` over three numbers and seven empty cells is the mean of
 * three, not a third of it, and `MIN(A1:A10)` is the smallest of the three, not
 * 0. Excel's rule, and the reason it is Excel's rule is that a spreadsheet
 * range is mostly empty by nature.
 *
 * Non-numeric TEXT is dropped as it always was: `num()` gives an error for it
 * and an error is not a number.
 */
const numbersIn = (v: Vec): number[] => {
  const out: number[] = []
  for (const x of v) {
    if (x === null || x === undefined || x === '') continue
    const n = num(x)
    if (typeof n === 'number') out.push(n)
  }
  return out
}

/**
 * Aggregates that COUNT rather than compute, and are therefore the ones that
 * may look at an error value without being poisoned by it. Everything else
 * propagates the first error it meets — `SUM` of a range holding `#REF!` is
 * `#REF!`, never the total of the cells that happened to work, which is a
 * number with a piece missing and no way to tell.
 */
const COUNTING = new Set(['COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTUNIQUE'])

/**
 * Smallest / largest of a number list, WITHOUT a spread.
 *
 * `Math.min(...n)` is one ARGUMENT per element and throws `RangeError: Maximum
 * call stack size exceeded` somewhere past ~125k of them (condfmt.ts:52 states
 * the same rule; dashboard.ts's axis hit it for real). A range is exactly where
 * this bites: `=MIN(A1:A400000)` is an ordinary thing to write on a sheet this
 * format is sized for, and the failure is not a `#NUM!` a reader could act on —
 * it is a throw out of the recalc, which takes the grid down with it.
 *
 * Callers guarantee a non-empty list; empty is the caller's own answer to give
 * (Excel's MIN of nothing is 0, which is not this function's business).
 */
const smallest = (n: number[]): number => {
  let lo = n[0]
  for (let i = 1; i < n.length; i++) if (n[i] < lo) lo = n[i]
  return lo
}

const largest = (n: number[]): number => {
  let hi = n[0]
  for (let i = 1; i < n.length; i++) if (n[i] > hi) hi = n[i]
  return hi
}

const REF = '#REF!'

const AGG: Record<string, (v: Vec) => Cell> = {
  VAR: (v) => variance(numbersIn(v), true),
  VARP: (v) => variance(numbersIn(v), false),
  STDEVP: (v) => { const r = variance(numbersIn(v), false); return isErr(r) ? r : Math.sqrt(r as number) },
  COUNTUNIQUE: (v) => new Set(v.filter((x) => x != null && x !== '').map((x) => String(x))).size,
  MODE: (v) => {
    const n = numbersIn(v)
    if (!n.length) return ERR.na()
    const seen = new Map<number, number>()
    let best = n[0]
    let bestC = 0
    for (const x of n) {
      const c = (seen.get(x) ?? 0) + 1
      seen.set(x, c)
      if (c > bestC) { bestC = c; best = x }
    }
    return bestC > 1 ? best : ERR.na()
  },
  SUM: (v) => numbersIn(v).reduce((a, b) => a + b, 0),
  AVERAGE: (v) => { const n = numbersIn(v); return n.length ? n.reduce((a, b) => a + b, 0) / n.length : ERR.div0() },
  MIN: (v) => { const n = numbersIn(v); return n.length ? smallest(n) : 0 },
  MAX: (v) => { const n = numbersIn(v); return n.length ? largest(n) : 0 },
  COUNT: (v) => numbersIn(v).length,
  COUNTA: (v) => v.filter((x) => x != null && x !== '').length,
  COUNTBLANK: (v) => v.filter((x) => x == null || x === '').length,
  MEDIAN: (v) => {
    const n = numbersIn(v).sort((a, b) => a - b)
    if (!n.length) return ERR.div0()
    const m = n.length >> 1
    return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2
  },
  STDEV: (v) => {
    const n = numbersIn(v)
    if (n.length < 2) return ERR.div0()
    const mu = n.reduce((a, b) => a + b, 0) / n.length
    return Math.sqrt(n.reduce((a, b) => a + (b - mu) ** 2, 0) / (n.length - 1))
  },
  PRODUCT: (v) => numbersIn(v).reduce((a, b) => a * b, 1),
}
AGG.AVG = AGG.AVERAGE

/** SUMIF/COUNTIF/AVERAGEIF — high-frequency, so worth having in v1. */
const CONDITIONAL = new Set(['SUMIF', 'COUNTIF', 'AVERAGEIF'])

/**
 * The multi-criteria family: `SUMIFS(sum, r1, c1, r2, c2, …)`.
 *
 * Note the argument order is NOT SUMIF's. Excel put the sum range LAST in
 * SUMIF and FIRST in SUMIFS, and every spreadsheet in the world now depends on
 * both. Matching Excel here is not politeness — a formula pasted from a
 * colleague's workbook has to mean the same thing or the number is wrong and
 * looks fine.
 */
const MULTI = new Set(['SUMIFS', 'COUNTIFS', 'AVERAGEIFS', 'MINIFS', 'MAXIFS'])

/** Lookups. Vector-shaped, because dash is column-shaped — see LOOKUP_NOTE. */
const LOOKUPS = new Set(['XLOOKUP', 'VLOOKUP', 'HLOOKUP', 'INDEX', 'MATCH', 'LOOKUP'])

const round = (x: number, dp: number) => {
  const f = 10 ** dp
  return Math.round((x + Number.EPSILON * Math.sign(x)) * f) / f
}

/** "1st", "2nd", "3rd" — for a message that names which argument was wrong. */
const ordinalSuffix = (n: number): string => {
  const t = n % 100
  if (t >= 11 && t <= 13) return 'th'
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'
}

/**
 * The kth value of a sorted list — LARGE and SMALL.
 *
 * A `k` past the end is `#NUM!` and NOT the last value. Clamping is the
 * tempting answer and it is the dangerous one: `LARGE(range, 5)` on a range
 * that turned out to hold four numbers would return the smallest of them,
 * labelled as the fifth largest, and nothing on screen would say the list ran
 * out. Excel refuses here too, for the same reason.
 */
const nth = (list: number[], kArg: Cell, big: boolean): Cell => {
  const k = num(kArg)
  if (isErr(k)) return k
  const i = Math.trunc(k)
  if (i < 1 || i > list.length) {
    return new FormulaError('#NUM!', list.length
      ? `there is no ${i}${ordinalSuffix(i)} value in a list of ${list.length}`
      : 'there are no numbers in that range to rank')
  }
  return [...list].sort((x, y) => (big ? y - x : x - y))[i - 1]
}

const nums = (a: Array<Cell | Vec>): number[] =>
  a.flatMap((x) => (Array.isArray(x) ? x : [x]))
    .map((x) => num(x as Cell)).filter((x): x is number => typeof x === 'number')

/**
 * Functions that consume a WHOLE COLUMN, dispatched before SCALAR.
 *
 * SCALAR broadcasts: it finds the widest vector argument and calls the function
 * once per row, which is exactly right for `ROUND(value, 2)` and exactly wrong
 * for `CORREL(a, b)` — that ran per row and correlated two single numbers,
 * which is 0/0. Same for IRR over a column of cash flows, PERCENTILE over a
 * column, and TEXTJOIN of one. They take the arguments UNBROADCAST.
 */
const RAW: Record<string, (a: Array<Cell | Vec>) => Cell> = {
  NPV: (a) => { const r = num(a[0] as Cell); return isErr(r) ? r : npv(r, nums(a.slice(1))) },
  IRR: (a) => irr(nums(a)),
  PERCENTILE: (a) => { const k = num(a[1] as Cell); return isErr(k) ? k : percentile(nums([a[0]]), k) },
  QUARTILE: (a) => { const q = num(a[1] as Cell); return isErr(q) ? q : percentile(nums([a[0]]), (q as number) / 4) },
  CORREL: (a) => correl(nums([a[0]]), nums([a[1]])),
  RANK: (a) => {
    const v = num(a[0] as Cell)
    if (isErr(v)) return v
    const list = nums([a[1]])
    const desc = a[2] === undefined || num(a[2] as Cell) === 0
    const sorted = [...list].sort((x, y) => (desc ? y - x : x - y))
    const i = sorted.findIndex((x) => x === v)
    return i < 0 ? ERR.na() : i + 1
  },
  /**
   * `SUMPRODUCT(a, b, …)` — sum of the element-wise products.
   *
   * RANGES OF DIFFERENT LENGTHS ARE REFUSED. Excel's `#VALUE!` for this is one
   * of its few unambiguously right refusals: pairing a 10-row range with a
   * 9-row one is a question with no answer, and padding the short one with
   * zeros would return a total that is wrong by however many rows were missed.
   *
   * Two house rules, both deliberate and both dash-wide rather than invented
   * here. TEXT counts as ZERO (Excel's own rule for this function — the whole
   * term goes to zero, which is what makes `SUMPRODUCT((a="x")*b)` work).
   * BOOLEANS count as 1 and 0, which is `num()`'s reading everywhere else in
   * this file — Excel would give 0 for a bare `SUMPRODUCT(a="x")`, a famous
   * gotcha, and agreeing with `SUM` of the same column matters more than
   * reproducing it. An ERROR still propagates, as it does in every other total.
   */
  SUMPRODUCT: (a) => {
    if (!a.length) return ERR.value('SUMPRODUCT needs at least one range')
    const arrays = a.map(asVec)
    const n = arrays[0].length
    const odd = arrays.findIndex((x) => x.length !== n)
    if (odd > 0) {
      return ERR.value(`SUMPRODUCT pairs its ranges row by row, so they must be the ` +
        `same size — the first covers ${n} cells and the ${odd + 1}${ordinalSuffix(odd + 1)} covers ${arrays[odd].length}`)
    }
    let total = 0
    for (let i = 0; i < n; i++) {
      let term = 1
      for (const arr of arrays) {
        const x = arr[i] ?? null
        if (isErr(x)) return x
        const v = num(x)
        // A non-number is zero, so the whole term is zero — Excel's rule.
        term *= isErr(v) ? 0 : v
      }
      total += term
    }
    return total
  },
  /** The kth largest / smallest. `k` past the end is #NUM!, never the end. */
  LARGE: (a) => nth(nums([a[0]]), a[1] as Cell, true),
  SMALL: (a) => nth(nums([a[0]]), a[1] as Cell, false),
  TEXTJOIN: (a) => {
    const sep = str(a[0] as Cell)
    const skip = bool(a[1] as Cell)
    const parts = a.slice(2).flatMap((x) => (Array.isArray(x) ? x : [x])).map((x) => str(x as Cell))
    return (skip ? parts.filter((p) => p !== '') : parts).join(sep)
  },
}

/**
 * Excel's text wildcards, as a regular expression: `?` is one character, `*` is
 * any run of them, and `~` before any of the three means the character itself.
 *
 * Every other character is ESCAPED. Without that, `SEARCH("(a)", …)` would be
 * read as a regular expression by accident — a group rather than two brackets —
 * and would match text that does not contain what was asked for, which is the
 * one outcome worse than not matching.
 */
function wildcardRe(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '~' && i + 1 < pattern.length && '~?*'.includes(pattern[i + 1])) {
      out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      continue
    }
    if (c === '?') { out += '[^]'; continue }
    if (c === '*') { out += '[^]*'; continue }
    out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out, 'i')
}

const SCALAR: Record<string, (a: Cell[]) => Cell> = {
  // --- logic
  // TRUE()/FALSE() are functions in Excel, and people type them. Their absence
  // was not an error either: `TRUE()` parsed as an unknown NAME, so `IF(TRUE(),
  // …)` quietly took the false branch.
  TRUE: () => true,
  FALSE: () => false,
  IFS: (a) => {
    for (let i = 0; i + 1 < a.length; i += 2) if (bool(a[i])) return a[i + 1]
    return ERR.na()
  },
  SWITCH: (a) => {
    for (let i = 1; i + 1 < a.length; i += 2) if (looseEq(a[0], a[i])) return a[i + 1]
    // an odd trailing argument is the default, as Excel has it
    return a.length % 2 === 0 ? a[a.length - 1] : ERR.na()
  },
  XOR: (a) => a.filter(bool).length % 2 === 1,
  IFNA: (a) => (isErr(a[0]) && String(a[0]) === '#N/A' ? a[1] ?? '' : a[0]),
  CHOOSE: (a) => {
    const i = num(a[0])
    if (isErr(i)) return i
    const k = Math.trunc(i)
    if (k < 1 || k >= a.length) {
      const have = a.length - 1
      return ERR.value(`CHOOSE was given ${have} choice${have === 1 ? '' : 's'} and asked for number ${k}`)
    }
    return a[k]
  },
  // --- text
  /**
   * `TEXT(value, "#,##0.00")` — a number, printed the way a column would print
   * it. THE SAME ENGINE, imported from format.ts rather than written again.
   *
   * IT REFUSES A DATE PATTERN instead of quietly handing the value back.
   * `TEXT(A1, "dd/mm/yyyy")` is the second most common use of this function in
   * Excel and dash's patterns describe NUMBERS only (`readPattern` — a prefix,
   * grouping, decimals, a percent), so the honest answer is to say so. Printing
   * the ISO date unchanged would look like it had worked and would be wrong on
   * every screen where the format was the point.
   */
  TEXT: (a) => {
    if (isErr(a[0])) return a[0]
    const fmt = str(a[1])
    if (!fmt) return ERR.value('TEXT needs a format to print with, like "#,##0.00"')
    if (!readPattern(fmt).digits) {
      return ERR.value(`"${fmt}" is not a number format — it has no 0 or # in it. ` +
        'dash formats NUMBERS this way (a prefix, grouping, decimals, %); a date ' +
        'is already the date it is, and DAY/MONTH/YEAR take it apart.')
    }
    const n = num(a[0])
    if (isErr(n)) return n
    return formatNumber(n, fmt)
  },
  /**
   * `VALUE("1,234.50")` — the standard Excel repair for numbers stored as text,
   * reading the string exactly as IMPORT would read it (`inferColumn` +
   * `coerce`). Currency signs, grouping, accounting parentheses and a trailing
   * `%` all come out as the number they denote; the decimal convention is the
   * one import picks, so a formula and a re-import can never disagree about
   * what `1.234` was.
   *
   * A DATE IS REFUSED rather than turned into a serial number. dash stores a
   * date as a date (model.ts), so `VALUE("2026-03-04")` has nothing to return —
   * Excel's answer, 46085, is a number about a calendar dash does not keep.
   */
  VALUE: (a) => {
    const v = a[0]
    if (isErr(v)) return v
    if (typeof v === 'number') return v
    const s = String(v ?? '').trim()
    if (s === '') return ERR.value('VALUE was given nothing to read')
    const inf = inferColumn([s])
    if (inf.type === 'number' || inf.type === 'money' || inf.type === 'percent') {
      const n = coerce(s, inf)
      if (typeof n === 'number') return n
    }
    if (inf.type === 'date' || inf.ambiguous) {
      return ERR.value(`"${s}" reads as a date, not a number. dash keeps a date as a ` +
        'date rather than as a serial number, so there is no number here to return — ' +
        'DATEVALUE reads a date, and DAYS() subtracts two of them.')
    }
    return ERR.value(`"${s}" is not a number. VALUE reads the digits a number was ` +
      'typed with — grouping, a currency sign, a trailing %, accounting brackets — ' +
      'and refuses anything else rather than returning part of it.')
  },
  /**
   * `DATEVALUE("15/04/2026")` — and the refusal is the feature.
   *
   * The reading is IMPORT'S, deliberately (`inferColumn`): `03/04/2026` is 3
   * April and 4 March and the string does not say which, so import refuses it
   * and so does this. A looser rule here would mean the same six characters
   * meant one day in a column and another in a formula, in one file, with
   * nothing on screen to show which had happened.
   *
   * Returns an ISO date STRING, because that is what a date is in dash — not a
   * serial number, so it is comparable, sortable and printable as it stands.
   */
  DATEVALUE: (a) => {
    const v = a[0]
    if (isErr(v)) return v
    const s = String(v ?? '').trim()
    if (s === '') return ERR.value('DATEVALUE was given nothing to read')
    const inf = inferColumn([s])
    if (inf.type === 'date') {
      const d = coerce(s, inf)
      if (typeof d === 'string') return d
    }
    if (inf.ambiguous) {
      return ERR.value(`"${s}" is ambiguous: ${inf.ambiguous.detail}. ` +
        'Write it as 2026-03-04, or say which you mean with DATE(2026, 3, 4).')
    }
    return ERR.value(`"${s}" is not a date dash can read without guessing. It reads ` +
      '2026-03-04, and a slash date only when the day is unmistakable (15/04/2026). ' +
      'DATE(y, m, d) says it outright.')
  },
  /**
   * `SEARCH` is `FIND` with the case ignored and wildcards allowed — `?` for one
   * character, `*` for any run, `~` to mean the character itself.
   *
   * A MISS IS `#N/A`, matching dash's own FIND rather than Excel's `#VALUE!`.
   * Two functions in one product that report the same nothing two different
   * ways is worse than either choice, and #N/A is the more accurate of the two:
   * the text is not there, which is an absence, not a bad argument.
   */
  SEARCH: (a) => {
    const needle = str(a[0])
    const hay = str(a[1])
    const from = a[2] === undefined ? 1 : num(a[2])
    if (isErr(from)) return from
    if (from < 1 || from > hay.length + 1) {
      return ERR.value(`SEARCH starts at character 1, and "${hay}" has ${hay.length}`)
    }
    const i = hay.slice(from - 1).search(wildcardRe(needle))
    return i < 0 ? ERR.na() : from + i
  },
  /** `REPLACE(text, start, howMany, with)` — by POSITION. SUBSTITUTE is by text. */
  REPLACE: (a) => {
    const s = str(a[0])
    const start = num(a[1])
    const n = num(a[2])
    if (isErr(start)) return start
    if (isErr(n)) return n
    if (start < 1) return ERR.value('REPLACE counts characters from 1')
    if (n < 0) return ERR.value('a negative number of characters is not a length')
    return s.slice(0, start - 1) + str(a[3]) + s.slice(start - 1 + n)
  },
  PROPER: (a) => str(a[0]).replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
  REPT: (a) => { const n = num(a[1]); return isErr(n) ? n : n < 0 ? ERR.value('negative count') : str(a[0]).repeat(Math.floor(n)) },
  DATE: (a) => {
    const y = num(a[0]); const m = num(a[1]); const d = num(a[2])
    if (isErr(y)) return y; if (isErr(m)) return m; if (isErr(d)) return d
    return isoOf(new Date(Date.UTC(y, m - 1, d)))
  },
  EOMONTH: (a) => {
    const d = asDate(a[0]); const k = num(a[1] ?? 0)
    if (!d) return ERR.value('not a date'); if (isErr(k)) return k
    return isoOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k + 1, 0)))
  },
  EDATE: (a) => {
    const d = asDate(a[0]); const k = num(a[1] ?? 0)
    if (!d) return ERR.value('not a date'); if (isErr(k)) return k
    return isoOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, d.getUTCDate())))
  },
  DAYS: (a) => {
    const b = asDate(a[0]); const c = asDate(a[1])
    return b && c ? Math.round((b.getTime() - c.getTime()) / DAY_MS) : ERR.value('not a date')
  },
  WEEKDAY: (a) => { const d = asDate(a[0]); return d ? d.getUTCDay() + 1 : ERR.value('not a date') },
  // --- finance. Every rate is PER PERIOD; nothing here divides by twelve for you.
  PMT: (a) => {
    const r = num(a[0]); const n = num(a[1]); const p = num(a[2])
    if (isErr(r)) return r; if (isErr(n)) return n; if (isErr(p)) return p
    return pmt(r, n, p, a[3] === undefined ? 0 : (num(a[3]) as number), a[4] === undefined ? 0 : (num(a[4]) as number))
  },
  FV: (a) => {
    const r = num(a[0]); const n = num(a[1]); const p = num(a[2])
    if (isErr(r)) return r; if (isErr(n)) return n; if (isErr(p)) return p
    return fvOf(r, n, p, a[3] === undefined ? 0 : (num(a[3]) as number), a[4] === undefined ? 0 : (num(a[4]) as number))
  },
  PV: (a) => {
    const r = num(a[0]); const n = num(a[1]); const p = num(a[2])
    if (isErr(r)) return r; if (isErr(n)) return n; if (isErr(p)) return p
    return pvOf(r, n, p, a[3] === undefined ? 0 : (num(a[3]) as number), a[4] === undefined ? 0 : (num(a[4]) as number))
  },
  // --- statistics over explicit arguments
  IF: (a) => (bool(a[0]) ? a[1] ?? true : a[2] ?? false),
  AND: (a) => a.every(bool),
  OR: (a) => a.some(bool),
  NOT: (a) => !bool(a[0]),
  IFERROR: (a) => (isErr(a[0]) ? a[1] ?? '' : a[0]),
  ISBLANK: (a) => a[0] == null || a[0] === '',
  ISNUMBER: (a) => typeof a[0] === 'number',
  ISTEXT: (a) => typeof a[0] === 'string',
  ISERROR: (a) => isErr(a[0]),
  ABS: (a) => { const n = num(a[0]); return isErr(n) ? n : Math.abs(n) },
  ROUND: (a) => { const n = num(a[0]); const d = num(a[1] ?? 0); return isErr(n) ? n : isErr(d) ? d : round(n, d) },
  ROUNDUP: (a) => { const n = num(a[0]); const d = num(a[1] ?? 0); if (isErr(n)) return n; const f = 10 ** (isErr(d) ? 0 : d); return Math.ceil(n * f) / f },
  ROUNDDOWN: (a) => { const n = num(a[0]); const d = num(a[1] ?? 0); if (isErr(n)) return n; const f = 10 ** (isErr(d) ? 0 : d); return Math.floor(n * f) / f },
  INT: (a) => { const n = num(a[0]); return isErr(n) ? n : Math.floor(n) },
  CEILING: (a) => { const n = num(a[0]); return isErr(n) ? n : Math.ceil(n) },
  FLOOR: (a) => { const n = num(a[0]); return isErr(n) ? n : Math.floor(n) },
  SIGN: (a) => { const n = num(a[0]); return isErr(n) ? n : Math.sign(n) },
  SQRT: (a) => { const n = num(a[0]); return isErr(n) ? n : n < 0 ? ERR.value('negative') : Math.sqrt(n) },
  POWER: (a) => { const b = num(a[0]); const e = num(a[1]); return isErr(b) ? b : isErr(e) ? e : b ** e },
  MOD: (a) => { const x = num(a[0]); const y = num(a[1]); if (isErr(x)) return x; if (isErr(y)) return y; return y === 0 ? ERR.div0() : x % y },
  EXP: (a) => { const n = num(a[0]); return isErr(n) ? n : Math.exp(n) },
  LN: (a) => { const n = num(a[0]); return isErr(n) ? n : n <= 0 ? ERR.value() : Math.log(n) },
  LOG10: (a) => { const n = num(a[0]); return isErr(n) ? n : n <= 0 ? ERR.value() : Math.log10(n) },
  CONCAT: (a) => a.map(str).join(''),
  CONCATENATE: (a) => a.map(str).join(''),
  LEN: (a) => str(a[0]).length,
  LEFT: (a) => { const n = num(a[1] ?? 1); return str(a[0]).slice(0, isErr(n) ? 1 : n) },
  RIGHT: (a) => { const n = num(a[1] ?? 1); return isErr(n) ? n : n <= 0 ? '' : str(a[0]).slice(-n) },
  MID: (a) => { const s = num(a[1] ?? 1); const l = num(a[2] ?? 0); return isErr(s) ? s : isErr(l) ? l : str(a[0]).slice(s - 1, s - 1 + l) },
  LOWER: (a) => str(a[0]).toLowerCase(),
  UPPER: (a) => str(a[0]).toUpperCase(),
  TRIM: (a) => str(a[0]).trim().replace(/\s+/g, ' '),
  SUBSTITUTE: (a) => str(a[0]).split(str(a[1])).join(str(a[2])),
  FIND: (a) => { const i = str(a[1]).indexOf(str(a[0])); return i < 0 ? ERR.na() : i + 1 },
  YEAR: (a) => Number(str(a[0]).slice(0, 4)) || ERR.value(),
  MONTH: (a) => Number(str(a[0]).slice(5, 7)) || ERR.value(),
  DAY: (a) => Number(str(a[0]).slice(8, 10)) || ERR.value(),
}

/**
 * Volatiles. TODAY() is by far the most common one on earth, and banning it —
 * which two of the three design proposals did — sends people to hard-coding a
 * date, which is strictly worse. It is FROZEN at commit instead: the value is
 * stamped into the document so the file shows the same number to everybody who
 * opens it, and re-running is an explicit act.
 */
export const VOLATILE = new Set(['TODAY', 'NOW'])

export interface EvalCtx {
  /** column name (or id) → its values */
  cols: Map<string, Vec>
  n: number
  /** frozen at commit; a document opened in 2030 shows the number it was saved with */
  now?: string
}

function evalNode(node: Node, ctx: EvalCtx): Cell | Vec {
  switch (node.k) {
    case 'lit': return node.v
    case 'ref': {
      const v = ctx.cols.get(node.name) ?? ctx.cols.get(node.name.toLowerCase())
      return v ?? ERR.name(node.name)
    }
    case 'neg': {
      const e = evalNode(node.e, ctx)
      return map1(e, (x) => { const n = num(x); return isErr(n) ? n : -n })
    }
    case 'bin': return binop(node.op, evalNode(node.l, ctx), evalNode(node.r, ctx))
    case 'call': return callFn(node, ctx)
  }
}

const isVec = (v: Cell | Vec): v is Vec => Array.isArray(v)
const at = (v: Cell | Vec, i: number): Cell => (isVec(v) ? v[i] ?? null : v)

/**
 * Give a result the SHAPE of the range that produced it.
 *
 * A bound range carries its width (`Shaped.__cols`, set by cellformula.ts's
 * `bindRefs`) because VLOOKUP and INDEX have to tell a 2-column table from a
 * 20-row one. Every operator here then threw that width away: `A1:C3 * 2` came
 * out as a flat nine-element array with no idea it was three wide.
 *
 * That was survivable while the only consumer was a lookup reading a range
 * DIRECTLY, and is not now that a result can SPILL — the shape is the footprint
 * it spills into, and losing it turns a 3×3 block into a 9×1 column down the
 * sheet, which is a wrong answer that looks like a right one in the first cell.
 *
 * Only carried when the operand SURVIVED the operation at full length. A
 * broadcast that changed the length changed the shape, and guessing the new one
 * from the old width is exactly the kind of nearly-right that this file's
 * header refuses.
 */
function carryShape(out: Vec, ...from: Array<Cell | Vec>): Vec {
  let cols = 0
  let widest = -1
  for (const a of from) {
    if (!isVec(a) || a.length !== out.length) continue
    const c = (a as Vec & Shaped).__cols
    if (typeof c === 'number' && c > 1 && a.length > widest) { widest = a.length; cols = c }
  }
  // 1 is the default a reader infers from the length alone; storing it would
  // make "no shape" and "one column" two states that mean the same thing.
  if (cols > 1) (out as Vec & Shaped).__cols = cols
  return out
}

function map1(a: Cell | Vec, f: (x: Cell) => Cell): Cell | Vec {
  if (!isVec(a)) return f(a)
  return carryShape(a.map(f), a)
}

function binop(op: string, l: Cell | Vec, r: Cell | Vec): Cell | Vec {
  const n = isVec(l) ? l.length : isVec(r) ? (r as Vec).length : -1
  const one = (x: Cell, y: Cell): Cell => {
    if (isErr(x)) return x
    if (isErr(y)) return y
    if (op === '&') return str(x) + str(y)
    if (op === '=') return looseEq(x, y)
    if (op === '<>') return !looseEq(x, y)
    if (op === '<' || op === '>' || op === '<=' || op === '>=') {
      const a = typeof x === 'string' && typeof y === 'string' ? x : num(x)
      const b = typeof x === 'string' && typeof y === 'string' ? y : num(y)
      if (isErr(a)) return a
      if (isErr(b)) return b
      return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b
    }
    const a = num(x); if (isErr(a)) return a
    const b = num(y); if (isErr(b)) return b
    switch (op) {
      case '+': return a + b
      case '-': return a - b
      case '*': return a * b
      case '/': return b === 0 ? ERR.div0() : a / b
      case '^': return a ** b
      default: return ERR.value(`unknown operator ${op}`)
    }
  }
  if (n < 0) return one(l as Cell, r as Cell)
  return carryShape(Array.from({ length: n }, (_, i) => one(at(l, i), at(r, i))), l, r)
}

const looseEq = (x: Cell, y: Cell): boolean => {
  if (typeof x === 'number' || typeof y === 'number') {
    const a = num(x); const b = num(y)
    return !isErr(a) && !isErr(b) && a === b
  }
  return String(x ?? '').toLowerCase() === String(y ?? '').toLowerCase()
}

/** `">100"`, `"North"`, `42` — the criteria form SUMIF/COUNTIF take. */
function matches(v: Cell, crit: Cell): boolean {
  const c = str(crit).trim()
  const m = c.match(/^(<=|>=|<>|<|>|=)\s*(.*)$/)
  if (!m) return looseEq(v, crit)
  const [, op, rest] = m
  const target: Cell = rest === '' ? null : Number.isFinite(Number(rest)) ? Number(rest) : rest
  const r = binop(op === '=' ? '=' : op, v, target)
  return bool(r as Cell)
}

// --- lookups ----------------------------------------------------------------
//
// LOOKUP_NOTE. dash is COLUMN-shaped: a reference resolves to a vector, and a
// range binds to one flat vector of the cells it covers. Excel's VLOOKUP takes
// a 2-D table and a column NUMBER, which only means something if the shape is
// known — so a range carries its width, and VLOOKUP reads it. Where the shape
// is unknown (a bare column), a `col` of 1 is the column itself and anything
// higher is #REF!, which is what Excel says when you index past the table.
//
// XLOOKUP is the one to reach for and the one that fits dash without
// contortion: two vectors, no index arithmetic, and no silent breakage when a
// column is inserted in the middle of the table — the failure VLOOKUP is
// famous for. VLOOKUP exists because people's existing formulas use it.

/**
 * What a bound range knows about ITSELF, beyond its values.
 *
 * `__cols` is the shape VLOOKUP and INDEX read. The other two are the two
 * things a COLUMN expression structurally does not have and a CELL formula
 * does, and they are carried on the vector rather than in `EvalCtx` for one
 * reason: they are facts about ONE argument. `SUBTOTAL(109, A1:A9)` asks which
 * rows of THAT range the view is hiding, and a context-level answer would have
 * to be re-derived per argument anyway.
 *
 * Both are set by whoever binds the range — see `markHidden` / `markOrigin` and
 * the note above them. Absent means "not known", and every function that reads
 * them says what it does with that, in the open, rather than guessing.
 */
export interface Shaped {
  __rows?: number
  __cols?: number
  /**
   * Which of these values the VIEW is hiding, one flag per element, row-major.
   *
   * A filter is view state (grid.ts), never document state, so this is the
   * only way the view can reach an expression at all. Absent = nothing is
   * hidden, which is the truth on an unfiltered sheet and the whole of what a
   * column expression can ever say.
   */
  __hidden?: boolean[]
}

/**
 * Mark which elements the current view hides. `mask` is 1:1 with `v`.
 *
 * EXPORTED RATHER THAN ASSIGNED IN PLACE. `cellformula.ts` binds every
 * reference and is the only module that can know which rows the view is
 * hiding — and it is not this file, so the shape of what it stamps has to be
 * stated somewhere both agree on. `(vec as Vec & Shaped).__hidden = …` written
 * in another module is a private field assigned from outside, which survives
 * exactly until one of the two is renamed. This is the contract.
 */
export const markHidden = (v: Vec, mask: boolean[]): Vec => {
  ;(v as Vec & Shaped).__hidden = mask
  return v
}

/** The elements a view is showing. Unmarked = all of them. */
const visibleIn = (v: Cell | Vec): Vec => {
  if (!isVec(v)) return [v]
  const mask = (v as Vec & Shaped).__hidden
  return mask ? v.filter((_, i) => !mask[i]) : v
}
const shapeOf = (v: Vec): { rows: number; cols: number } => {
  const s = v as Vec & Shaped
  const cols = typeof s.__cols === 'number' && s.__cols > 0 ? s.__cols : 1
  return { rows: Math.ceil(v.length / cols), cols }
}

/**
 * The shape of a result, for whoever has to place it on a grid.
 *
 * The same reading `cellAt` uses, exported so that spill geometry and lookup
 * geometry cannot drift into two answers to one question.
 */
export const vecShape = (v: Vec): { rows: number; cols: number } => shapeOf(v)

/** Row-major cell at (r, c) of a shaped range. */
const cellAt = (v: Vec, r: number, c: number): Cell => {
  const { cols } = shapeOf(v)
  return v[r * cols + c] ?? null
}

/**
 * First index in `hay` matching `needle`.
 *
 * EXACT by default, and that is a deliberate departure from VLOOKUP's legacy
 * 4th argument defaulting to TRUE (approximate). An approximate match on
 * UNSORTED data returns a confidently wrong row, and that default has produced
 * more quiet spreadsheet errors than any other single thing in Excel. Ours
 * defaults to exact; approximate is available by asking for it.
 */
function findIndex(hay: Vec, needle: Cell, approx = false): number {
  if (!approx) {
    for (let i = 0; i < hay.length; i++) if (looseEq(hay[i], needle)) return i
    return -1
  }
  // approximate: the LAST value <= needle, which assumes ascending order —
  // Excel's rule, and its documented requirement
  let best = -1
  for (let i = 0; i < hay.length; i++) {
    const c = binop('<=', hay[i], needle)
    if (c === true) best = i
  }
  return best
}

const asVec = (v: Cell | Vec): Vec => (Array.isArray(v) ? v : [v])

// --- SUBTOTAL, and the totals row Excel writes ------------------------------
//
// EVERY EXCEL TABLE ARRIVES CARRYING ONE. A ListObject's totals row is written
// as `SUBTOTAL(109, …)`, so before this existed every imported table landed
// with a dead total: `#NAME?` where a number had been, or — worse — the cached
// number frozen beside a formula nothing would ever recompute. Measured on
// `pipeline.xlsx`.
//
// ITS DEFINING BEHAVIOUR IS THAT IT IGNORES ROWS A FILTER HAS HIDDEN, which is
// exactly what dash's own footer already does (`grid.ts aggregate` over
// `store.order`). That agreement is not a coincidence and is not dash deviating
// from Excel: docs/dash-sheet-kinds.md works out that dash's dataset IS an
// Excel Table, and a Table's totals row is filter-aware in Excel too. So
// `SUBTOTAL(109, Value)` and the footer's `sum` must be the SAME NUMBER over
// the same rows, and `scripts/test-dash-functions.ts` asserts that against
// `aggregate` itself rather than against a total worked out by hand.
//
// THE 1xx AND THE 1-11 FORMS ARE THE SAME FUNCTION HERE, and that is a fact
// about dash rather than a shortcut. In Excel both families skip filtered-out
// rows and only the 1xx family also skips rows hidden BY HAND; dash has no
// hand-hidden rows at all (`rowcol.ts hiddenSet` hides COLUMNS, and the view
// vector is built by the filter), so there is no case that could tell them
// apart. If manual row hiding is ever built, this is the line that has to grow
// a second mask — not a second function.
//
// NESTED SUBTOTALS ARE NOT EXCLUDED. Excel ignores other SUBTOTAL results
// inside the range so that a stack of group totals does not double-count.
// Doing that needs to know which CELLS in the range are themselves SUBTOTALs,
// which the bound vector does not carry — and dash's own totals row is a column
// property that sits outside the data range, so the shape that makes Excel need
// the rule does not arise from anything dash generates. Written down rather
// than silently absent.
const SUBTOTAL_FNS: Record<number, string> = {
  1: 'AVERAGE', 2: 'COUNT', 3: 'COUNTA', 4: 'MAX', 5: 'MIN', 6: 'PRODUCT',
  7: 'STDEV', 8: 'STDEVP', 9: 'SUM', 10: 'VAR', 11: 'VARP',
}

/**
 * Functions that take their arguments UNBROADCAST and may hand back an ARRAY.
 *
 * `RAW` was nearly this and cannot be: its signature returns a `Cell`, so a
 * function whose whole point is a rectangle (TRANSPOSE) would have had to
 * return its first value, which is the failure mode a spilling engine exists to
 * end. These see the vectors as they were bound — shape, view mask and all.
 */
const SHAPED: Record<string, (a: Array<Cell | Vec>) => Cell | Vec> = {
  SUBTOTAL: (a) => {
    const k = num(a[0] as Cell)
    if (isErr(k)) return k
    const legal = Number.isInteger(k) && ((k >= 1 && k <= 11) || (k >= 101 && k <= 111))
    if (!legal) {
      return ERR.value(`SUBTOTAL's first argument says WHICH total: 1-11, or 101-111 ` +
        `to say the same thing about a filtered view. ${k} is neither ` +
        '(109 is SUM, which is what Excel writes into a table\'s totals row).')
    }
    if (a.length < 2) return ERR.value('SUBTOTAL needs something to total')
    const fn = SUBTOTAL_FNS[k > 100 ? k - 100 : k]
    const vec = a.slice(1).flatMap(visibleIn)
    // The same rule the aggregates keep: a COUNT may look at an error without
    // being poisoned, and everything else propagates the first one it meets
    // rather than totalling the cells that happened to work.
    if (!COUNTING.has(fn)) {
      const bad = vec.find(isErr)
      if (bad) return bad
    }
    return AGG[fn](vec)
  },
  /**
   * Rows become columns. On the SPREADSHEET kind this SPILLS — the shape it
   * returns is the footprint cellformula.ts places (see its SPILL block) — and
   * on a dataset a cell formula keeps returning its first value, which is that
   * module's existing rule for every array result and not one invented here.
   */
  TRANSPOSE: (a) => {
    const v = a[0]
    if (isErr(v)) return v
    if (!isVec(v)) return v ?? null
    if (!v.length) return ERR.value('TRANSPOSE was given nothing to transpose')
    const { rows, cols } = shapeOf(v)
    const out: Vec = new Array(rows * cols).fill(null)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) out[c * rows + r] = v[r * cols + c] ?? null
    }
    // The transpose of an r×c block is c×r, so the new width is the old height.
    if (rows > 1) (out as Vec & Shaped).__cols = rows
    return out
  },
}

// --- finance ----------------------------------------------------------------
//
// The reason a finance team opens Excel rather than anything else. All of these
// take a RATE PER PERIOD, not an annual rate — the single most common way these
// get used wrongly, so the argument is named `rate` everywhere and never
// silently divided by twelve.

/** Net present value of `flows`, discounted one period each, first flow at t=1. */
const npv = (rate: number, flows: number[]): number =>
  flows.reduce((acc, f, i) => acc + f / (1 + rate) ** (i + 1), 0)

/**
 * Internal rate of return: the rate at which NPV is zero.
 *
 * Bisection, not Newton-Raphson. Newton is faster and diverges on exactly the
 * cash-flow shapes people have (a sign change late in the series), returning a
 * number rather than failing. Bisection over a bracketed range either converges
 * or reports #NUM!, and a refusal is worth more than a plausible rate.
 */
function irr(flows: number[], guess = 0.1): Cell {
  const f = (r: number) => flows.reduce((a, c, i) => a + c / (1 + r) ** i, 0)
  let lo = -0.9999
  let hi = 10
  let flo = f(lo)
  let fhi = f(hi)
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) {
    void guess
    return new FormulaError('#NUM!', 'no rate brackets a sign change in these cash flows')
  }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    const fm = f(mid)
    if (Math.abs(fm) < 1e-10) return mid
    if (flo * fm < 0) { hi = mid; fhi = fm } else { lo = mid; flo = fm }
  }
  void fhi
  return (lo + hi) / 2
}

/** Payment per period for a loan. Excel's sign convention: a payment is negative. */
const pmt = (rate: number, nper: number, pv: number, fv = 0, type = 0): number => {
  if (rate === 0) return -(pv + fv) / nper
  const p = (1 + rate) ** nper
  return -(pv * p + fv) * rate / ((p - 1) * (1 + rate * (type ? 1 : 0)))
}

const fvOf = (rate: number, nper: number, pmtv: number, pv = 0, type = 0): number => {
  if (rate === 0) return -(pv + pmtv * nper)
  const p = (1 + rate) ** nper
  return -(pv * p + pmtv * (1 + rate * (type ? 1 : 0)) * (p - 1) / rate)
}

const pvOf = (rate: number, nper: number, pmtv: number, fv = 0, type = 0): number => {
  if (rate === 0) return -(fv + pmtv * nper)
  const p = (1 + rate) ** nper
  return -(fv + pmtv * (1 + rate * (type ? 1 : 0)) * (p - 1) / rate) / p
}

// --- statistics -------------------------------------------------------------

/**
 * Linear-interpolated percentile, Excel's PERCENTILE.INC.
 *
 * `k` is a FRACTION (0.9), not a percentage (90) — passing 90 gets #NUM! rather
 * than being clamped to the maximum, because clamping would silently answer a
 * question nobody asked.
 */
function percentile(nums: number[], k: number): Cell {
  if (!nums.length) return ERR.div0()
  if (!(k >= 0 && k <= 1)) return new FormulaError('#NUM!', 'percentile takes a fraction between 0 and 1')
  const s = [...nums].sort((a, b) => a - b)
  const pos = k * (s.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

/** Sample variance (n−1). VARP/STDEVP use the population divisor. */
const variance = (nums: number[], sample: boolean): Cell => {
  const n = nums.length
  if (n < (sample ? 2 : 1)) return ERR.div0()
  const mean = nums.reduce((a, b) => a + b, 0) / n
  const ss = nums.reduce((a, b) => a + (b - mean) ** 2, 0)
  return ss / (sample ? n - 1 : n)
}

function correl(xs: number[], ys: number[]): Cell {
  const n = Math.min(xs.length, ys.length)
  if (n < 2) return ERR.div0()
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy
  }
  const d = Math.sqrt(sxx * syy)
  return d === 0 ? ERR.div0() : sxy / d
}

// --- dates ------------------------------------------------------------------
//
// Dates are ISO STRINGS in dash, not serial numbers (model.ts). So date maths
// parses, computes in UTC and formats back — never through the local timezone,
// which would move a date across midnight for half the world's readers.

const asDate = (v: Cell): Date | null => {
  if (typeof v !== 'string') return null
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}
const isoOf = (d: Date): string => d.toISOString().slice(0, 10)
const DAY_MS = 86_400_000

function callFn(node: Node & { k: 'call' }, ctx: EvalCtx): Cell | Vec {
  const name = node.name

  if (name === 'TODAY' || name === 'NOW') {
    const iso = ctx.now ?? new Date().toISOString()
    return name === 'TODAY' ? iso.slice(0, 10) : iso
  }
  // BEFORE the aggregates, and before broadcasting: these read the vectors as
  // they were BOUND — shape, view mask and all — and may hand back a rectangle.
  const shaped = SHAPED[name]
  if (shaped) return shaped(node.args.map((x) => evalNode(x, ctx)))

  if (AGG[name]) {
    const v = evalNode(node.args[0], ctx)
    const vec = isVec(v) ? v : [v]
    if (!COUNTING.has(name)) {
      const bad = vec.find(isErr)
      if (bad) return bad
    }
    return AGG[name](vec)
  }
  if (CONDITIONAL.has(name)) {
    const range = evalNode(node.args[0], ctx)
    const crit = evalNode(node.args[1], ctx)
    const sumRange = node.args[2] ? evalNode(node.args[2], ctx) : range
    const rv = isVec(range) ? range : [range]
    const sv = isVec(sumRange) ? sumRange : [sumRange]
    const keep: number[] = []
    rv.forEach((x, i) => { if (matches(x, at(crit, i))) keep.push(i) })
    if (name === 'COUNTIF') return keep.length
    const vals = keep.map((i) => num(sv[i] ?? null)).filter((x): x is number => typeof x === 'number')
    if (name === 'SUMIF') return vals.reduce((a, b) => a + b, 0)
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : ERR.div0()
  }
  if (MULTI.has(name)) {
    // SUMIFS(sum, r1, c1, …) / COUNTIFS(r1, c1, …) — count has no sum range.
    const counting = name === 'COUNTIFS'
    const target = counting ? null : asVec(evalNode(node.args[0], ctx))
    const pairsFrom = counting ? 0 : 1
    const pairs: Array<{ range: Vec; crit: Cell | Vec }> = []
    for (let i = pairsFrom; i + 1 < node.args.length; i += 2) {
      pairs.push({
        range: asVec(evalNode(node.args[i], ctx)),
        crit: evalNode(node.args[i + 1], ctx),
      })
    }
    if (!pairs.length) return ERR.value(`${name} needs at least one range and criterion`)
    const rows = Math.max(...pairs.map((p) => p.range.length), target?.length ?? 0)
    const keep: number[] = []
    for (let i = 0; i < rows; i++) {
      // EVERY criterion must hold. `some` here instead of `every` is the bug
      // that turns a two-condition report into a one-condition one, and the
      // total still looks like a total.
      if (pairs.every((p) => matches(p.range[i] ?? null, at(p.crit, i)))) keep.push(i)
    }
    if (counting) return keep.length
    const vals = keep.map((i) => num(target![i] ?? null)).filter((x): x is number => typeof x === 'number')
    if (name === 'SUMIFS') return vals.reduce((a, b) => a + b, 0)
    if (!vals.length) return name === 'AVERAGEIFS' ? ERR.div0() : 0
    if (name === 'AVERAGEIFS') return vals.reduce((a, b) => a + b, 0) / vals.length
    // `smallest`/`largest`, never a spread: `vals` is one entry per SURVIVING
    // row, so a criterion that keeps most of a large sheet is exactly the shape
    // that overflows the argument list.
    return name === 'MINIFS' ? smallest(vals) : largest(vals)
  }

  if (LOOKUPS.has(name)) {
    const a = node.args.map((x) => evalNode(x, ctx))
    if (name === 'MATCH') {
      const i = findIndex(asVec(a[1]), a[0] as Cell, num((a[2] ?? 0) as Cell) !== 0)
      return i < 0 ? ERR.na() : i + 1        // 1-based, as Excel reports it
    }
    if (name === 'INDEX') {
      const v = asVec(a[0])
      const n = num(a[1] as Cell)
      if (isErr(n)) return n
      // INDEX(range, row, col) on a shaped range; INDEX(vector, n) otherwise
      if (node.args.length > 2) {
        const c = num(a[2] as Cell)
        if (isErr(c)) return c
        return cellAt(v, n - 1, c - 1)
      }
      return n >= 1 && n <= v.length ? v[n - 1] : new FormulaError(REF, 'index is outside the range')
    }
    if (name === 'XLOOKUP') {
      const i = findIndex(asVec(a[1]), a[0] as Cell)
      if (i < 0) return a[3] !== undefined ? (a[3] as Cell) : ERR.na()
      return asVec(a[2])[i] ?? null
    }
    if (name === 'LOOKUP') {
      const i = findIndex(asVec(a[1]), a[0] as Cell, true)
      return i < 0 ? ERR.na() : asVec(a[2] ?? a[1])[i] ?? null
    }
    if (name === 'HLOOKUP') {
      // The same function turned ninety degrees: search the first ROW, return
      // from the nth. Rarer than VLOOKUP and it exists for the same reason —
      // somebody's workbook already says it.
      const grid = asVec(a[1])
      const { rows, cols } = shapeOf(grid)
      const rowN = num(a[2] as Cell)
      if (isErr(rowN)) return rowN
      if (rowN < 1 || rowN > rows) {
        return new FormulaError(REF, `row ${rowN} is outside a ${rows}-row range`)
      }
      const firstRow: Vec = []
      for (let c = 0; c < cols; c++) firstRow.push(cellAt(grid, 0, c))
      const i = findIndex(firstRow, a[0] as Cell, a[3] !== undefined && bool(a[3] as Cell))
      return i < 0 ? ERR.na() : cellAt(grid, rowN - 1, i)
    }
    // VLOOKUP(value, table, col, [approx])
    const table = asVec(a[1])
    const { cols } = shapeOf(table)
    const colN = num(a[2] as Cell)
    if (isErr(colN)) return colN
    if (colN < 1 || colN > cols) return new FormulaError(REF, `column ${colN} is outside a ${cols}-column range`)
    const firstCol: Vec = []
    for (let r = 0; r * cols < table.length; r++) firstCol.push(cellAt(table, r, 0))
    const i = findIndex(firstCol, a[0] as Cell, a[3] !== undefined && bool(a[3] as Cell))
    return i < 0 ? ERR.na() : cellAt(table, i, colN - 1)
  }

  const raw = RAW[name]
  if (raw) return raw(node.args.map((x) => evalNode(x, ctx)))

  const fn = SCALAR[name]
  if (!fn) return ERR.name(name)

  const args = node.args.map((a) => evalNode(a, ctx))
  // widest vector argument decides the result's length; all-scalar stays scalar
  let width = -1
  for (const a of args) if (isVec(a)) width = Math.max(width, a.length)
  if (width < 0) return fn(args as Cell[])
  return carryShape(Array.from({ length: width }, (_, i) => fn(args.map((a) => at(a, i)))), ...args)
}

/**
 * THE EDGE OF THE COLUMN LANGUAGE, and the one sentence it is allowed to say
 * about the other side of it.
 *
 * `Jan!A1` in a column expression used to come back `#NAME? unknown name "Jan"`,
 * which is false in both halves: `Jan` is not unknown, it is a sheet sitting in
 * the tab strip, and the reason it cannot be used is a BOUNDARY rather than a
 * typo. An error that misdescribes itself sends the reader to fix the spelling
 * of a word that was spelled correctly.
 *
 * WHY THE BOUNDARY IS REAL and not an unimplemented feature. Everything that
 * runs through `evaluate` — a column formula, a derive step, a conditional
 * format rule — is defined over the COLUMNS OF ONE SHEET, by identity. That is
 * the whole structural claim this file's header makes: no positions, so no
 * `#REF!` class, and inserting a row changes nothing. Reaching another sheet
 * gives that back in the worst possible way:
 *
 *   · another sheet's CELL by position (`Rates!B2`) reintroduces exactly the
 *     address that moves when somebody inserts a row on a sheet the author is
 *     not looking at — into the one expression that has n rows depending on it;
 *   · another sheet's COLUMN is a JOIN, and pairing row i with row i is a join
 *     with no key, no cardinality answer and no opinion about two sheets of
 *     different lengths. dash has `join` in its step vocabulary for this, and
 *     it asks all three questions. A second, worse join hidden inside an
 *     arithmetic expression is not a feature, it is the bug report a year from
 *     now that says the numbers changed when someone sorted a different tab.
 *
 * So the answer names the boundary and both ways across it. A CELL formula on
 * this same dataset may reference another sheet — that path is positional
 * already and is bound by cellformula.ts, which resolves the workbook.
 */
const crossSheetRefusal = (src: string): FormulaError | null => {
  const named = sheetQualifiers(src)
  if (!named.length) return null
  return new FormulaError('#NAME?',
    `"${named[0].sheet}" is another sheet. This expression is computed over the ` +
    'columns of its own sheet only — a formula in a single CELL can reference ' +
    'another sheet, and a join step brings another sheet\'s rows across.')
}

/** Evaluate one column expression over `n` rows. Never throws. */
export function evaluate(src: string, ctx: EvalCtx): Vec {
  // Before parsing, because the parser has no concept of a sheet and would
  // report the qualifier as a stray word. `sheetQualifiers` is free on a source
  // with no `!` in it, which is virtually all of them.
  const crossed = crossSheetRefusal(src)
  if (crossed) return Array.from({ length: ctx.n }, () => crossed)
  let node: Node
  try { node = parse(src) } catch { return Array.from({ length: ctx.n }, () => ERR.value('could not parse')) }
  let out: Cell | Vec
  try { out = evalNode(node, ctx) } catch (e) {
    out = ERR.value(e instanceof Error ? e.message : String(e))
  }
  return isVec(out) ? out : Array.from({ length: ctx.n }, () => out as Cell)
}

// --- recalculation ----------------------------------------------------------

export interface RecalcResult {
  /** colId → computed values, for every column that has a formula */
  values: Map<string, Vec>
  /** columns in a cycle — reported, never silently zeroed */
  cycles: string[]
  order: string[]
}

/**
 * Recompute every formula column in dependency order.
 *
 * Kahn's algorithm over COLUMNS. Anything left when the queue drains is in a
 * cycle, and gets `#CYCLE!` rather than a plausible number — measured at 9 ms
 * for a 1M-node graph, so at twelve nodes the sort is free.
 */
export function recalc(sheet: TableSheet, now?: string): RecalcResult {
  const n = sheet.rids.reduce((a, [, c]) => a + c, 0)

  // both id and name resolve, so `[Unit price]` and `unit_price` both work
  const base = new Map<string, Vec>()
  const put = (k: string, v: Vec) => { base.set(k, v); base.set(k.toLowerCase(), v) }
  for (const c of sheet.columns) {
    if (c.formula) continue
    const d = sheet.data[c.id]
    const vals: Vec = Array.from({ length: n }, (_, i) => readCell(d, i) as Cell)
    put(c.id, vals); put(c.name, vals)
  }

  const formulas = sheet.columns.filter((c) => c.formula)
  const byKey = new Map<string, string>()   // id or name (lowercased) -> colId
  for (const c of formulas) { byKey.set(c.id.toLowerCase(), c.id); byKey.set(c.name.toLowerCase(), c.id) }

  const deps = new Map<string, Set<string>>()
  for (const c of formulas) {
    const d = new Set<string>()
    for (const ref of dependencies(c.formula!)) {
      const target = byKey.get(ref.toLowerCase())
      // INCLUDING itself. `a = a + 1` is a circular reference, and excluding
      // self-edges gave it indegree 0 — so it drained from the queue, computed
      // against its own stale values, and produced a number.
      if (target) d.add(target)
    }
    deps.set(c.id, d)
  }

  // Kahn
  const indeg = new Map([...deps].map(([k, v]) => [k, v.size]))
  const queue = [...indeg].filter(([, d]) => d === 0).map(([k]) => k)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const [other, d] of deps) {
      if (d.has(id)) {
        d.delete(id)
        const left = (indeg.get(other) ?? 1) - 1
        indeg.set(other, left)
        if (left === 0) queue.push(other)
      }
    }
  }
  const cycles = formulas.map((c) => c.id).filter((id) => !order.includes(id))

  const values = new Map<string, Vec>()
  const ctx: EvalCtx = { cols: base, n, now }
  for (const id of order) {
    const col = formulas.find((c) => c.id === id)!
    const v = evaluate(col.formula!, ctx)
    values.set(id, v)
    put(id, v); put(col.name, v)
  }
  for (const id of cycles) {
    values.set(id, Array.from({ length: n }, () => ERR.cycle()))
  }
  return { values, cycles, order }
}

/** Every function name this build knows — the agent surface needs to say. */
export const FUNCTIONS: string[] = [
  ...Object.keys(AGG), ...CONDITIONAL, ...MULTI, ...LOOKUPS,
  ...Object.keys(RAW), ...Object.keys(SCALAR), ...Object.keys(SHAPED), ...VOLATILE,
].sort()
