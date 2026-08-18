// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Magic notes: a line that ends in `=` gets its answer.
//
// THE SHAPE, and why it is this one. The document stores what you wrote —
// `budget * 0.3 =` — and the ANSWER is derived when the page is drawn. Never
// stored. That is the same rule slides settled for dynamic fields ("the model
// stores the raw token; only output is resolved"), and here it buys three
// things a stored answer cannot:
//
//  · CHANGE A NUMBER AND EVERYTHING FOLLOWS. Edit `budget = 5000` to 6000 and
//    every line below it re-answers, because nothing downstream was frozen.
//  · The file stays PLAIN. Search, grep, the Markdown export and a build that
//    predates this all see `budget * 0.3 =`, which reads perfectly well as
//    prose. No new block type, no new attribute, nothing for the sanitizer to
//    strip, nothing for an older build to render as a mystery.
//  · The trailing `=` is an OPT-IN. A notes app where every line containing
//    numbers turned into a calculator would be unusable — "we shipped 3 of 7"
//    is a sentence, not a sum. You ask by typing the `=` you were going to
//    type anyway.
//
// NO `eval`, NO `new Function`, AND THAT IS A SECURITY BOUNDARY, not a style
// preference. Block html comes out of a file somebody mailed you; the whole
// point of sanitize.ts is that nothing in a document can execute. An
// expression evaluator that reached for the JS parser would hand that back.
// This is a recursive-descent parser over a fixed grammar and it can only ever
// return a number.

/** What a parsed value is: a number, optionally carrying a unit or a date. */
export interface Val {
  n: number
  /** canonical unit key, e.g. 'm' | 'kg' | 'day' | '%'; absent = plain number */
  u?: string
  /** the value IS a date, `n` being days since the epoch in local terms */
  date?: boolean
  /** the value is a TIME OF DAY, `n` being seconds since midnight. `9:30 + 45
   *  min` should read 10:15, not "36,900 s" — the answer people want back is
   *  the one in the shape they asked in. */
  clock?: boolean
}

export interface CalcCtx {
  /** names defined earlier on the same page — `budget = 5000` */
  vars?: Map<string, Val>
  /** numbers from the lines above, for `sum above` */
  above?: number[]
  /** today, as an ISO date. Injected so the rig is not at the mercy of a clock. */
  today?: string
}

// ---------------------------------------------------------------------------
// units — deliberately few
// ---------------------------------------------------------------------------
//
// Every unit here is one somebody actually writes in a note. The temptation is
// a physics library; the cost of a wrong or surprising conversion in someone's
// notes is worse than the cost of not having it, so the table stays short and
// each family converts through one base.

interface Unit { base: string; k: number; off?: number }
const UNITS: Record<string, Unit> = {
  // length → metres
  mm: { base: 'm', k: 0.001 }, cm: { base: 'm', k: 0.01 }, m: { base: 'm', k: 1 },
  km: { base: 'm', k: 1000 }, inch: { base: 'm', k: 0.0254 }, ft: { base: 'm', k: 0.3048 },
  yd: { base: 'm', k: 0.9144 }, mi: { base: 'm', k: 1609.344 },
  // mass → grams
  mg: { base: 'g', k: 0.001 }, g: { base: 'g', k: 1 }, kg: { base: 'g', k: 1000 },
  t: { base: 'g', k: 1e6 }, oz: { base: 'g', k: 28.349523125 }, lb: { base: 'g', k: 453.59237 },
  // data → bytes. 1024, because a note about file sizes means the one the
  // operating system shows.
  byte: { base: 'byte', k: 1 }, kb: { base: 'byte', k: 1024 }, mb: { base: 'byte', k: 1024 ** 2 },
  gb: { base: 'byte', k: 1024 ** 3 }, tb: { base: 'byte', k: 1024 ** 4 },
  // duration → seconds
  ms: { base: 's', k: 0.001 }, s: { base: 's', k: 1 }, min: { base: 's', k: 60 },
  h: { base: 's', k: 3600 }, day: { base: 's', k: 86400 }, week: { base: 's', k: 604800 },
  // temperature → celsius, and these need an OFFSET as well as a scale, which
  // is why `off` exists at all
  c: { base: 'c', k: 1 }, f: { base: 'c', k: 5 / 9, off: -32 }, k: { base: 'c', k: 1, off: -273.15 },
}

/** What people type → the canonical key. */
const ALIAS: Record<string, string> = {
  millimetre: 'mm', millimeter: 'mm', centimetre: 'cm', centimeter: 'cm',
  metre: 'm', meter: 'm', metres: 'm', meters: 'm', kilometre: 'km', kilometer: 'km',
  kilometres: 'km', kilometers: 'km', in: 'inch', inches: 'inch', foot: 'ft', feet: 'ft',
  yard: 'yd', yards: 'yd', mile: 'mi', miles: 'mi',
  gram: 'g', grams: 'g', kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg',
  tonne: 't', tonnes: 't', ounce: 'oz', ounces: 'oz', pound: 'lb', pounds: 'lb', lbs: 'lb',
  b: 'byte', bytes: 'byte', kib: 'kb', mib: 'mb', gib: 'gb', tib: 'tb',
  sec: 's', secs: 's', second: 's', seconds: 's', minute: 'min', minutes: 'min', mins: 'min',
  hour: 'h', hours: 'h', hr: 'h', hrs: 'h', d: 'day', days: 'day',
  wk: 'week', weeks: 'week', w: 'week',
  celsius: 'c', centigrade: 'c', fahrenheit: 'f', kelvin: 'k',
}
const unitOf = (w: string): string | undefined => {
  const k = w.toLowerCase()
  const canon = ALIAS[k] ?? k
  return UNITS[canon] ? canon : undefined
}

const toBase = (v: Val): number => {
  const u = UNITS[v.u!]
  return (v.n + (u.off ?? 0)) * u.k
}
const fromBase = (n: number, to: string): number => {
  const u = UNITS[to]
  return n / u.k - (u.off ?? 0)
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------
//
// Local-calendar arithmetic, for the same reasons journal.ts spells out: UTC
// makes "today" the wrong day for hours at a time outside Greenwich, and a day
// is not 86,400 seconds on the two daylight-saving boundaries each year. Dates
// are carried as days-since-epoch in LOCAL terms so date maths is integer
// maths, and converted back through the local calendar.

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/
const dayMs = 86400000
const toDay = (y: number, m: number, d: number): number =>
  Math.round(new Date(y, m - 1, d).getTime() / dayMs - new Date(y, m - 1, d).getTimezoneOffset() / 1440)
const fromDay = (n: number): string => {
  const at = new Date(n * dayMs)
  const y = at.getUTCFullYear(), m = at.getUTCMonth() + 1, d = at.getUTCDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
function parseISO(s: string): number | null {
  const m = ISO.exec(s)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const at = new Date(y, mo - 1, d)
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d) return null
  return toDay(y, mo, d)
}

/**
 * Today, in the READER'S timezone.
 *
 * Not `toISOString().slice(0,10)`: that is UTC, so "today" is the wrong day for
 * hours at a time for everyone who does not live in Greenwich, and a note that
 * says `today + 1 week =` would answer with somebody else's calendar.
 */
export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

// ---------------------------------------------------------------------------
// the parser
// ---------------------------------------------------------------------------

type Tok = { t: 'n'; v: number } | { t: 'w'; v: string } | { t: 'o'; v: string } | { t: 'd'; v: number }

function lex(src: string): Tok[] | null {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === ' ') { i++; continue }
    // A DATE IS ONE TOKEN. Lexed before numbers, because `2026-08-10` would
    // otherwise become 2026 minus 08 minus 10 — which parses, and answers 2008.
    // That is the worst kind of bug this file can have: a confident wrong
    // number in somebody's notes.
    if (/[0-9]/.test(c)) {
      const m = /^\d{4}-\d{2}-\d{2}/.exec(src.slice(i))
      if (m) {
        const day = parseISO(m[0])
        if (day === null) return null      // digit-shaped, not a date
        out.push({ t: 'd', v: day })
        i += m[0].length
        continue
      }
    }
    if (/[0-9.]/.test(c)) {
      // digits, with , or _ as thousands separators — people paste both
      let j = i, seen = ''
      while (j < src.length && /[0-9.,_]/.test(src[j])) {
        if (src[j] === ',' && !/[0-9]/.test(src[j + 1] ?? '')) break
        seen += src[j] === ',' || src[j] === '_' ? '' : src[j]
        j++
      }
      const n = Number(seen)
      if (!Number.isFinite(n)) return null
      out.push({ t: 'n', v: n })
      i = j
      continue
    }
    if (/[A-Za-z_$£€]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_$£€]/.test(src[j])) j++
      out.push({ t: 'w', v: src.slice(i, j) })
      i = j
      continue
    }
    if ('+-*/^()%:'.includes(c)) { out.push({ t: 'o', v: c }); i++; continue }
    return null // a character this grammar does not know: not an expression
  }
  return out
}

class P {
  i = 0
  t: Tok[]
  ctx: CalcCtx
  // plain fields, not constructor parameter properties: node's type stripping
  // is strip-ONLY, and a parameter property is syntax that would have to be
  // transformed. The rigs run this file directly.
  constructor(t: Tok[], ctx: CalcCtx) { this.t = t; this.ctx = ctx }
  peek(): Tok | undefined { return this.t[this.i] }
  word(): string | undefined { const x = this.peek(); return x?.t === 'w' ? x.v.toLowerCase() : undefined }
  op(v: string): boolean {
    const x = this.peek()
    if (x?.t === 'o' && x.v === v) { this.i++; return true }
    return false
  }
  kw(...w: string[]): boolean {
    const x = this.word()
    if (x && w.includes(x)) { this.i++; return true }
    return false
  }

  /** expr := term (('+'|'-') term)* , with `+ N%` meaning "increase by N%" */
  expr(): Val | null {
    let a = this.term()
    if (!a) return null
    for (;;) {
      const plus = this.op('+')
      const minus = !plus && this.op('-')
      if (!plus && !minus) return a
      const b = this.term()
      if (!b) return null
      if (b.u === '%') {
        // 340 + 15%  →  391. The reading everybody means.
        a = { ...a, n: a.n * (1 + (plus ? 1 : -1) * b.n / 100) }
        continue
      }
      const r = this.add(a, b, plus ? 1 : -1)
      if (!r) return null
      a = r
    }
  }

  add(a: Val, b: Val, sign: number): Val | null {
    // clock ± duration = clock; clock − clock = how long between them
    if (a.clock && b.clock) {
      if (sign > 0) return null            // two times of day do not add
      // in HOURS, not seconds: "how long between 9:30 and 17:00" is answered
      // "7.5 h" by every person who has ever asked it, and "27,000 s" by
      // nobody.
      return { n: (a.n - b.n) / 3600, u: 'h' }
    }
    if (a.clock) {
      if (!b.u || UNITS[b.u]?.base !== 's') return null
      // wrap across midnight rather than reporting a 25th hour
      const n = ((a.n + sign * toBase(b)) % 86400 + 86400) % 86400
      return { n, u: 's', clock: true }
    }
    if (b.clock) return null
    // date ± duration = date; date − date = days
    if (a.date && b.date) {
      if (sign > 0) return null
      return { n: a.n - b.n, u: 'day' }
    }
    if (a.date) {
      if (!b.u || UNITS[b.u]?.base !== 's') return null
      const days = toBase(b) / 86400
      if (!Number.isInteger(days)) return { n: a.n + sign * days, date: true }
      return { n: a.n + sign * days, date: true }
    }
    if (b.date) return null
    if (a.u && b.u) {
      if (UNITS[a.u]?.base !== UNITS[b.u]?.base) return null
      return { n: fromBase(toBase(a) + sign * toBase(b), a.u), u: a.u }
    }
    if (a.u || b.u) return { n: a.n + sign * b.n, u: a.u ?? b.u }
    return { n: a.n + sign * b.n }
  }

  /** term := pow (('*'|'/') pow)* */
  term(): Val | null {
    let a = this.pow()
    if (!a) return null
    for (;;) {
      const mul = this.op('*')
      const div = !mul && this.op('/')
      if (!mul && !div) return a
      const b = this.pow()
      if (!b) return null
      if (a.date || b.date) return null
      if (b.u === '%') { a = { ...a, n: mul ? a.n * b.n / 100 : a.n / (b.n / 100) }; continue }
      if (div && b.n === 0) return null
      a = { n: mul ? a.n * b.n : a.n / b.n, u: a.u ?? (mul ? b.u : undefined) }
    }
  }

  pow(): Val | null {
    const a = this.unary()
    if (!a) return null
    if (this.op('^')) {
      const b = this.unary()
      if (!b || a.date || b.date) return null
      return { n: a.n ** b.n, u: a.u }
    }
    return a
  }

  unary(): Val | null {
    if (this.op('-')) { const v = this.unary(); return v && !v.date ? { ...v, n: -v.n } : null }
    if (this.op('+')) return this.unary()
    return this.atom()
  }

  atom(): Val | null {
    // N% of X
    const start = this.i
    const a = this.primary()
    if (!a) return null
    if (a.u === '%' && this.kw('of')) {
      const b = this.expr()
      return b && !b.date ? { n: b.n * a.n / 100, u: b.u } : null
    }
    // X in UNIT  /  X to UNIT  /  X as UNIT
    if (this.kw('in', 'to', 'as')) {
      const w = this.word()
      const to = w && unitOf(w)
      if (!to || !a.u || a.date) { this.i = start; return null }
      if (UNITS[to].base !== UNITS[a.u].base) return null
      this.i++
      return { n: fromBase(toBase(a), to), u: to }
    }
    return a
  }

  primary(): Val | null {
    if (this.op('(')) {
      const v = this.expr()
      if (!v || !this.op(')')) return null
      return v
    }
    const x = this.peek()
    if (!x) return null

    if (x.t === 'd') { this.i++; return { n: x.v, date: true } }

    if (x.t === 'n') {
      this.i++
      // a clock time: 9:30
      if (this.op(':')) {
        const m = this.peek()
        if (m?.t !== 'n' || m.v > 59) return null
        this.i++
        return { n: x.v * 3600 + m.v * 60, u: 's', clock: true }
      }
      if (this.op('%')) return { n: x.v, u: '%' }
      const w = this.word()
      if (w) {
        const u = unitOf(w)
        if (u) { this.i++; return { n: x.v, u } }
      }
      return { n: x.v }
    }

    if (x.t === 'w') {
      const w = x.v.toLowerCase()
      const today = this.ctx.today ? parseISO(this.ctx.today) : null
      if (w === 'today' && today !== null) { this.i++; return { n: today, date: true } }
      if (w === 'tomorrow' && today !== null) { this.i++; return { n: today + 1, date: true } }
      if (w === 'yesterday' && today !== null) { this.i++; return { n: today - 1, date: true } }
      if (w === 'sum' || w === 'total') {
        this.i++
        this.kw('above', 'of')
        const list = this.ctx.above ?? []
        return { n: list.reduce((s, v) => s + v, 0) }
      }
      const v = this.ctx.vars?.get(w)
      if (v) { this.i++; return { ...v } }
      return null
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

const LABEL: Record<string, string> = {
  inch: 'in', byte: 'B', kb: 'KB', mb: 'MB', gb: 'GB', tb: 'TB',
  day: 'days', week: 'weeks', c: '°C', f: '°F', k: 'K',
}

/** Round away the float dust — 0.1+0.2 must not read as 0.30000000000000004. */
const tidy = (n: number): number => Math.abs(n) < 1e-10 ? 0 : Number(n.toPrecision(12))

export function format(v: Val, locale?: string): string {
  if (v.date) return fromDay(Math.round(v.n))
  if (v.clock) {
    const t = Math.round(v.n / 60)
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
  }
  const n = tidy(v.n)
  // PRECISION A NOTE WANTS. Six decimal places is right for a conversion table
  // and wrong for "how far is it" — 584.088921 mi is noise around 584.09. The
  // bigger the number, the fewer decimals carry meaning.
  const abs = Math.abs(n)
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6
  const num = new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n)
  if (!v.u) return num
  if (v.u === '%') return `${num}%`
  // Every unit gets a space except the percent sign. SI puts a space before
  // °C; only % is written tight against its number.
  return `${num} ${LABEL[v.u] ?? v.u}`
}

// ---------------------------------------------------------------------------
// the surface
// ---------------------------------------------------------------------------

/** The trailing `=` that asks for an answer, with optional trailing space. */
const ASKS = /=\s*$/

/** Does this line ask for an answer? */
export const asksForAnswer = (text: string): boolean => ASKS.test(text)

/**
 * `name = value` on its own line DEFINES a name for the lines below it.
 *
 * Deliberately not `let` or `set`: people already write `budget = 5000` in
 * notes, and the feature is worth nothing if it needs its own vocabulary.
 */
const DEF = /^\s*([A-Za-z_][A-Za-z0-9_ ]{0,30}?)\s*=\s*(.+)$/

export function definition(text: string, ctx: CalcCtx = {}): { name: string; val: Val } | null {
  const m = DEF.exec(text)
  if (!m || asksForAnswer(text)) return null
  const name = m[1].trim().toLowerCase()
  if (!name || unitOf(name) || ['today', 'tomorrow', 'yesterday', 'sum', 'total'].includes(name)) return null
  const val = evaluate(m[2], ctx)
  return val ? { name, val } : null
}

/**
 * Evaluate an expression. Returns null for anything this grammar does not
 * fully understand — including a partial parse, which is the case that matters:
 * "meet at 3" must not quietly become 3.
 */
export function evaluate(src: string, ctx: CalcCtx = {}): Val | null {
  const body = src.replace(ASKS, '').trim()
  if (!body || body.length > 200) return null
  const toks = lex(body)
  if (!toks || !toks.length) return null
  const p = new P(toks, ctx)
  const v = p.expr()
  // the whole line must be consumed, or it was prose that happened to start
  // with something numeric
  if (!v || p.i !== toks.length || !Number.isFinite(v.n)) return null
  return v
}

/** The answer for a line, already formatted — or null if there is not one. */
export function answer(text: string, ctx: CalcCtx = {}, locale?: string): string | null {
  if (!asksForAnswer(text)) return null
  const v = evaluate(text, ctx)
  return v ? format(v, locale) : null
}

/**
 * The context a line on a page sees: every name defined ABOVE it, and the
 * numbers above it for `sum above`.
 *
 * Shared by the renderer and the editor's preview so the ghost answer and the
 * committed one can never disagree — two implementations of "what does this
 * line know" is exactly the kind of drift that makes a preview a liar.
 */
export function pageContext(
  lines: Array<{ id: string; text: string }>,
  upTo: string,
): CalcCtx {
  const ctx = freshContext()
  for (const l of lines) {
    if (l.id === upTo) break
    feed(ctx, l.text)
  }
  return ctx
}

/** A context for the top of a page. */
export const freshContext = (): CalcCtx =>
  ({ vars: new Map<string, Val>(), above: [], today: localToday() })

/**
 * Take one line into the context, in reading order.
 *
 * ONE implementation, used by the renderer and by the editor's preview. Two
 * would drift, and a preview that disagrees with the committed answer is worse
 * than no preview.
 *
 * `sum above` means THE RUN OF FIGURES DIRECTLY ABOVE, not every number on the
 * page. Summing the whole page was the first behaviour and it was confidently
 * wrong: with three figures in a list under a budget and two other answers, it
 * reported 78,732 where a person reading the page means 515. So any line that
 * is not itself a plain figure ends the run — a heading, a sentence, a
 * definition, another answer.
 */
export function feed(ctx: CalcCtx, text: string): void {
  const def = definition(text, ctx)
  if (def) { ctx.vars!.set(def.name, def.val); ctx.above!.length = 0; return }
  // An ANSWER ENDS THE RUN as well as staying out of it. A subtotal is where a
  // group of figures finishes, so the next `sum above` means the figures after
  // it — otherwise every subtotal silently includes the ones before it.
  if (asksForAnswer(text)) { ctx.above!.length = 0; return }
  const v = evaluate(text, ctx)
  // a figure is a line that IS a number — `120`, `45 kg`, `12 * 3`. A date is
  // not a figure, and neither is a sentence.
  if (v && !v.date && !v.clock) ctx.above!.push(v.n)
  else if (text.trim()) ctx.above!.length = 0
}
