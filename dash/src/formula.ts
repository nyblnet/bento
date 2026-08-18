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
}
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
      let j = i + 1, s = ''
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '"' && src[j + 1] === '"') { s += '"'; j += 2; continue }
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

const numbersIn = (v: Vec): number[] =>
  v.map(num).filter((x): x is number => typeof x === 'number')

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
  MIN: (v) => { const n = numbersIn(v); return n.length ? Math.min(...n) : 0 },
  MAX: (v) => { const n = numbersIn(v); return n.length ? Math.max(...n) : 0 },
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
const LOOKUPS = new Set(['XLOOKUP', 'VLOOKUP', 'INDEX', 'MATCH', 'LOOKUP'])

const round = (x: number, dp: number) => {
  const f = 10 ** dp
  return Math.round((x + Number.EPSILON * Math.sign(x)) * f) / f
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
  TEXTJOIN: (a) => {
    const sep = str(a[0] as Cell)
    const skip = bool(a[1] as Cell)
    const parts = a.slice(2).flatMap((x) => (Array.isArray(x) ? x : [x])).map((x) => str(x as Cell))
    return (skip ? parts.filter((p) => p !== '') : parts).join(sep)
  },
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
  // --- text
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

function map1(a: Cell | Vec, f: (x: Cell) => Cell): Cell | Vec {
  if (!isVec(a)) return f(a)
  return a.map(f)
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
  return Array.from({ length: n }, (_, i) => one(at(l, i), at(r, i)))
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

/** A range's shape, when the binding knew it. See cellformula.ts's bindRefs. */
export interface Shaped { __rows?: number; __cols?: number }
const shapeOf = (v: Vec): { rows: number; cols: number } => {
  const s = v as Vec & Shaped
  const cols = typeof s.__cols === 'number' && s.__cols > 0 ? s.__cols : 1
  return { rows: Math.ceil(v.length / cols), cols }
}

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
  if (AGG[name]) {
    const v = evalNode(node.args[0], ctx)
    return AGG[name](isVec(v) ? v : [v])
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
    return name === 'MINIFS' ? Math.min(...vals) : Math.max(...vals)
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
  return Array.from({ length: width }, (_, i) => fn(args.map((a) => at(a, i))))
}

/** Evaluate one column expression over `n` rows. Never throws. */
export function evaluate(src: string, ctx: EvalCtx): Vec {
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
  ...Object.keys(RAW), ...Object.keys(SCALAR), ...VOLATILE,
].sort()
