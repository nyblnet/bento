// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Dates and times as VALUES — what `=A4+1` needs, and nothing that changes a file.
//
// ═══ THE REPRESENTATION, and why it did not change ═════════════════════════
//
// A date in dash is its canonical ISO TEXT — `2026-03-04` — in the file, in a
// dataset's `date` column and in a spreadsheet cell, and it stays that way.
// Excel keeps a serial number (46085) and needs a format to make it readable;
// dash keeps the readable thing and computes with it. Two reasons that is the
// right way round here:
//
//   1. THE FILE IS THE INTERFACE. A person or an agent reading `#bento-doc`
//      reads `2026-03-04`, not 46085 under a pattern somewhere else.
//   2. AN OLDER BUILD MUST NOT CORRUPT A NEWER FILE. Every value this module
//      can produce is a string an older dash already stored and displayed
//      verbatim: it shows `2026-03-04 14:30`, it cannot add one to it, and it
//      writes it back byte for byte. A serial would have been a NUMBER to an
//      older build, which would then have summed it, charted it and printed
//      46085 — a wrong answer, not a missing one.
//
// What changed is the EVALUATOR: it now reads these strings as the moments
// they spell (`readTemporal`), does the arithmetic on a day count, and writes
// the answer back in the same canonical text (`writeTemporal`). So `=A4+1` is
// `2026-03-05`, `=B1-A1` is a number of days, and `=TEXT(A4, "dd mmm yyyy")`
// is `04 Mar 2026`.
//
// THREE KINDS, all canonical, all sortable as text within their kind:
//
//   date       `YYYY-MM-DD`
//   datetime   `YYYY-MM-DD HH:MM` or `YYYY-MM-DD HH:MM:SS` — a space, which
//              is what a person types and reads; `T` (and a trailing `Z` or
//              fractional seconds, xlsx import's and old NOW()'s spelling) is
//              READ but never written
//   time       `HH:MM` or `HH:MM:SS` — a time of day, no date
//
// WALL-CLOCK, NOT INSTANTS. A datetime here has no zone: `2026-03-08 01:30`
// plus an hour is `02:30` even in New York, where that hour did not happen on
// that night. That is Excel's model too, and the only one in which adding a
// day is always adding 24 hours of reading. The single place a zone enters is
// NOW()/TODAY(), which turn the frozen instant into the VIEWER's local clock
// (`localWallClock`) — that is what "now" means to the person reading it.
//
// AMBIGUOUS INPUT IS NOT THIS FILE'S BUSINESS. `3/4/2026` never reaches here as
// a date: entry (cellprops.ts rule 4) and import refuse to guess it, and this
// module reads only the canonical spellings above.

export type TemporalKind = 'date' | 'datetime' | 'time'

/**
 * A moment as a number. `days` counts from 1970-01-01 00:00 (wall clock) for a
 * date or datetime; for a time it is the fraction of one day, in [0, 1).
 */
export interface Temporal {
  kind: TemporalKind
  days: number
}

const DAY_MS = 86_400_000
const DAY_S = 86_400

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?Z?)?$/
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?$/

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const leap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

/**
 * A calendar date as days since 1970-01-01, or null for 31 February.
 *
 * Arithmetic rather than `new Date`: this runs inside sort comparators, where
 * two Date objects per comparison was most of the cost of sorting a date
 * column (measured: 100k ISO dates, 333 ms → 1.95 s). The civil-from-days
 * inverse is Howard Hinnant's, proleptic Gregorian like `Date` itself.
 */
function dayNumber(y: number, m: number, d: number): number | null {
  if (m < 1 || m > 12 || d < 1) return null
  if (d > (m === 2 && leap(y) ? 29 : MONTH_DAYS[m - 1])) return null
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/**
 * Read a value as a date, datetime or time — or null.
 *
 * Only the CANONICAL spellings: this is how the evaluator sees a stored value,
 * and stored values are canonical because entry made them so. A loose reading
 * here would let a text cell that merely looks like a date start doing date
 * arithmetic with whatever order it guessed.
 */
export function readTemporal(v: unknown): Temporal | null {
  if (typeof v !== 'string') return null
  // the fast refusal first: this runs inside sort comparators over 100k rows,
  // and almost all text starts with something that is not a digit
  const c0 = v.charCodeAt(0)
  if (!(c0 >= 48 && c0 <= 57) && c0 !== 32) return null
  const s = v.length > 40 ? '' : c0 === 32 ? v.trim() : v
  if (!s) return null
  // every canonical spelling has a '-' at 4 or a ':' at 1 or 2 — part numbers don't
  if (s.charCodeAt(4) !== 45 && s.charCodeAt(1) !== 58 && s.charCodeAt(2) !== 58) return null
  let m = DATE_RE.exec(s)
  if (m) {
    const day = dayNumber(+m[1], +m[2], +m[3])
    if (day === null) return null
    if (m[4] === undefined) return { kind: 'date', days: day }
    const h = +m[4]; const mi = +m[5]; const sec = m[6] === undefined ? 0 : +m[6]
    if (h > 23 || mi > 59 || sec > 59) return null
    return { kind: 'datetime', days: day + (h * 3600 + mi * 60 + sec) / DAY_S }
  }
  m = TIME_RE.exec(s)
  if (m) {
    const h = +m[1]; const mi = +m[2]; const sec = m[3] === undefined ? 0 : +m[3]
    if (h > 23 || mi > 59 || sec > 59) return null
    return { kind: 'time', days: (h * 3600 + mi * 60 + sec) / DAY_S }
  }
  return null
}

/** Is this value a date, datetime or time? */
export const isTemporal = (v: unknown): boolean => readTemporal(v) !== null

const two = (n: number): string => String(n).padStart(2, '0')

/** Seconds into the day, rounded — 0.5 of a day held as a float is 11:59:59.999… */
function splitDay(days: number): { day: number; secs: number } {
  let day = Math.floor(days)
  let secs = Math.round((days - day) * DAY_S)
  if (secs >= DAY_S) { day += 1; secs -= DAY_S }
  return { day, secs }
}

/** `YYYY-MM-DD` for a day number. */
export function isoDay(day: number): string {
  const d = new Date(day * DAY_MS)
  const y = d.getUTCFullYear()
  const ys = y < 0 ? `-${String(-y).padStart(6, '0')}` : y > 9999 ? `+${String(y).padStart(6, '0')}` : String(y).padStart(4, '0')
  return `${ys}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`
}

/** `HH:MM`, or `HH:MM:SS` when the seconds are not zero. */
export function clockOf(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  return `${two(h)}:${two(m)}${s ? `:${two(s)}` : ''}`
}

/** The canonical text for a moment — the only spelling dash writes. */
export function writeTemporal(t: Temporal): string {
  if (t.kind === 'time') {
    const secs = ((Math.round(t.days * DAY_S) % DAY_S) + DAY_S) % DAY_S
    return clockOf(secs)
  }
  const { day, secs } = splitDay(t.days)
  if (t.kind === 'date') return isoDay(day)
  return `${isoDay(day)} ${clockOf(secs)}`
}

/** The parts of a moment, for YEAR/MONTH/DAY/HOUR/… and for patterns. */
export function partsOf(t: Temporal): {
  y: number; mo: number; d: number; wd: number; h: number; mi: number; s: number
} {
  const { day, secs } = t.kind === 'time'
    ? { day: 0, secs: ((Math.round(t.days * DAY_S) % DAY_S) + DAY_S) % DAY_S }
    : splitDay(t.days)
  const dt = new Date(day * DAY_MS)
  return {
    y: t.kind === 'time' ? 1899 : dt.getUTCFullYear(),
    mo: t.kind === 'time' ? 12 : dt.getUTCMonth() + 1,
    d: t.kind === 'time' ? 31 : dt.getUTCDate(),
    wd: dt.getUTCDay(),
    h: Math.floor(secs / 3600),
    mi: Math.floor((secs % 3600) / 60),
    s: secs % 60,
  }
}

/** A date from parts, Excel-style: months and days roll over (`DATE(2026,13,1)`). */
export function dateFromParts(y: number, m: number, d: number): number | null {
  if (![y, m, d].every(Number.isFinite)) return null
  const dt = new Date(Date.UTC(2000, 0, 1))
  dt.setUTCFullYear(Math.trunc(y), Math.trunc(m) - 1, Math.trunc(d))
  const ms = dt.getTime()
  return Number.isFinite(ms) ? Math.round(ms / DAY_MS) : null
}

/** Days in a month (1-based). */
export const daysInMonth = (y: number, m: number): number => {
  const dt = new Date(Date.UTC(2000, 0, 1))
  dt.setUTCFullYear(y, m, 0)
  return dt.getUTCDate()
}

/**
 * The VIEWER's wall clock at an instant — what NOW() and TODAY() print.
 *
 * The instant is frozen in the document (`doc.modified`, an ISO string in UTC,
 * so everybody's file holds the same moment); the reading is local, because
 * "now" means the reader's now. `Date`'s local getters apply the zone and its
 * daylight-saving rule for that instant, which is the whole of the conversion.
 */
export function localWallClock(instant: string | number | Date): Temporal | null {
  const d = instant instanceof Date ? instant : new Date(instant)
  if (!Number.isFinite(d.getTime())) return null
  const day = dayNumber(d.getFullYear(), d.getMonth() + 1, d.getDate())
  if (day === null) return null
  const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()
  return { kind: 'datetime', days: day + secs / DAY_S }
}

// ═══ ARITHMETIC ═══════════════════════════════════════════════════════════
//
// The rules, Excel's where Excel's are meaningful:
//
//   date + n, n + date      n days later (a fraction of a day makes a datetime)
//   date − n                n days earlier
//   date − date             the number of days between them (a fraction for
//                           datetimes) — a NUMBER, not a date
//   date + time             that date at that time (a datetime)
//   time ± n                n days of clock later/earlier, wrapped to a day
//   time ± time             the clock sum or difference, wrapped
//   time − time             …except that this is the one people mean as a
//                           DURATION: it is a number (a fraction of a day), as
//                           in Excel, and a Time-formatted cell shows it as one
//   date + date, n − date   refused: neither means anything
//
// `null` means "not a date question" and the caller does plain arithmetic.

export type TemporalAnswer = { value: string | number } | { refuse: string } | null

export function temporalArith(op: '+' | '-', x: unknown, y: unknown, xn: number | null, yn: number | null): TemporalAnswer {
  const a = readTemporal(x)
  const b = readTemporal(y)
  if (!a && !b) return null
  const dated = (t: Temporal | null) => t !== null && t.kind !== 'time'

  if (a && b) {
    if (op === '-') {
      if (dated(a) && dated(b)) return { value: roundDays(a.days - b.days) }
      if (a.kind === 'time' && b.kind === 'time') return { value: roundDays(a.days - b.days) }
      if (dated(a) && b.kind === 'time') return { value: writeTemporal({ kind: 'datetime', days: a.days - b.days }) }
      return { refuse: `${String(x)} − ${String(y)}: a time minus a date is not a moment` }
    }
    if (dated(a) && dated(b)) return { refuse: `${String(x)} + ${String(y)}: two dates do not add up to a date` }
    if (a.kind === 'time' && b.kind === 'time') return { value: writeTemporal({ kind: 'time', days: a.days + b.days }) }
    const d = dated(a) ? a : b
    const tm = dated(a) ? b : a
    return { value: writeTemporal({ kind: 'datetime', days: d.days + tm.days }) }
  }

  // exactly one side is a moment; the other must be a plain number of days
  const t = (a ?? b) as Temporal
  const n = a ? yn : xn
  if (n === null) return { refuse: `${String(a ? y : x)} is not a number of days` }
  if (op === '-' && !a) return { refuse: `${String(x)} − ${String(y)}: a number minus a date is not a date` }
  const days = op === '+' ? t.days + n : t.days - n
  if (t.kind === 'time') return { value: writeTemporal({ kind: 'time', days }) }
  const kind: TemporalKind = t.kind === 'datetime' || !Number.isInteger(roundDays(days)) ? 'datetime' : 'date'
  return { value: writeTemporal({ kind, days }) }
}

/** A day count to the nearest second, so 1/3 of a day minus itself is 0, not 1e-17. */
export const roundDays = (d: number): number => Math.round(d * DAY_S) / DAY_S

/**
 * Order two moments, or null when they are not comparable — a time of day
 * against a date has no order (Excel would compare 0.5 with 46085).
 */
export function compareTemporal(x: unknown, y: unknown): number | null {
  // Two plain `YYYY-MM-DD`s — by far the common pair, a date column being
  // sorted — order by their text already, and an invalid one would order by
  // its text anyway. So that pair never pays for parsing.
  if (typeof x === 'string' && typeof y === 'string' && x.length === 10 && y.length === 10 &&
    x.charCodeAt(4) === 45 && y.charCodeAt(4) === 45 && x.charCodeAt(7) === 45 && y.charCodeAt(7) === 45 &&
    x.charCodeAt(0) <= 57 && y.charCodeAt(0) <= 57 && x.charCodeAt(0) >= 48 && y.charCodeAt(0) >= 48) {
    return x < y ? -1 : x > y ? 1 : 0
  }
  const a = readTemporal(x)
  const b = readTemporal(y)
  if (!a || !b) return null
  if ((a.kind === 'time') !== (b.kind === 'time')) return null
  const d = roundDays(a.days - b.days)
  return d < 0 ? -1 : d > 0 ? 1 : 0
}

// ═══ PATTERNS ═════════════════════════════════════════════════════════════
//
// `dd mmm yyyy`, `yyyy-mm-dd hh:mm`, `h:mm AM/PM`, `dddd`… — the Excel date
// tokens, for TEXT() and for a cell's display. `m` is MINUTES after an hour or
// before a seconds token and MONTH otherwise, which is Excel's own rule.
// Quoted text and backslash-escaped characters are literal. Month and day
// NAMES are the viewer's (Intl), like the separators of a number: the pattern
// is the author's, the language is the reader's.

/** Does a pattern describe a date or time rather than a number? */
export function isTemporalPattern(fmt: unknown): boolean {
  if (typeof fmt !== 'string') return false
  const f = stripLiterals(fmt)
  if (/[#0?]/.test(f) || f.includes('@')) return false
  return /y|d|m|h|s/i.test(f)
}

/** Does a pattern print a clock but no calendar? (`hh:mm`, `h:mm:ss AM/PM`) */
export function isTimeOnlyPattern(fmt: unknown): boolean {
  if (!isTemporalPattern(fmt)) return false
  const f = stripLiterals(String(fmt)).replace(/am\/pm|a\/p/gi, '')
  return /h/i.test(f) && !/[yd]/i.test(f)
}

const stripLiterals = (f: string): string => f.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '')

type Tok = { k: 'lit'; v: string } | { k: 'tok'; v: string }

function tokenize(fmt: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < fmt.length) {
    const c = fmt[i]
    if (c === '"') {
      const j = fmt.indexOf('"', i + 1)
      out.push({ k: 'lit', v: fmt.slice(i + 1, j < 0 ? fmt.length : j) })
      i = j < 0 ? fmt.length : j + 1
      continue
    }
    if (c === '\\') { out.push({ k: 'lit', v: fmt[i + 1] ?? '' }); i += 2; continue }
    if (c === '[') {
      // [$-409] locale tags and [Red] colours: skipped, as Excel's display does
      const j = fmt.indexOf(']', i)
      i = j < 0 ? fmt.length : j + 1
      continue
    }
    const ampm = fmt.slice(i).match(/^(am\/pm|a\/p)/i)
    if (ampm) { out.push({ k: 'tok', v: ampm[0] }); i += ampm[0].length; continue }
    if (/[ymdhs]/i.test(c)) {
      let j = i
      while (j < fmt.length && fmt[j].toLowerCase() === c.toLowerCase()) j++
      out.push({ k: 'tok', v: fmt.slice(i, j).toLowerCase() })
      i = j
      continue
    }
    out.push({ k: 'lit', v: c })
    i++
  }
  return out
}

const nameCache = new Map<string, string[]>()
function names(locale: string | undefined, what: 'month' | 'weekday', width: 'long' | 'short'): string[] {
  const key = `${locale ?? ''}|${what}|${width}`
  const hit = nameCache.get(key)
  if (hit) return hit
  let out: string[]
  try {
    const f = new Intl.DateTimeFormat(locale, { [what]: width, timeZone: 'UTC' })
    out = what === 'month'
      ? Array.from({ length: 12 }, (_, i) => f.format(Date.UTC(2026, i, 1)))
      // 2026-03-01 is a Sunday, so index 0 is Sunday, as getUTCDay counts
      : Array.from({ length: 7 }, (_, i) => f.format(Date.UTC(2026, 2, 1 + i)))
  } catch {
    out = what === 'month'
      ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
      : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    if (width === 'short') out = out.map((s) => s.slice(0, 3))
  }
  nameCache.set(key, out)
  return out
}

/** Print a moment under an Excel date/time pattern, in the viewer's language. */
export function formatTemporal(t: Temporal, fmt: string, locale?: string): string {
  const p = partsOf(t)
  const toks = tokenize(fmt)
  const twelve = toks.some((x) => x.k === 'tok' && /^(am\/pm|a\/p)$/i.test(x.v))
  // which `m` runs are minutes: after an hour, or before a seconds token
  const isMinute = (i: number): boolean => {
    for (let j = i - 1; j >= 0; j--) {
      const x = toks[j]
      if (x.k !== 'tok') continue
      if (x.v[0] === 'h') return true
      break
    }
    for (let j = i + 1; j < toks.length; j++) {
      const x = toks[j]
      if (x.k !== 'tok') continue
      return x.v[0] === 's'
    }
    return false
  }
  let out = ''
  toks.forEach((x, i) => {
    if (x.k === 'lit') { out += x.v; return }
    const v = x.v
    switch (v[0]) {
      case 'y': out += v.length <= 2 ? two(p.y % 100) : String(p.y).padStart(4, '0'); break
      case 'm':
        if (v.length <= 2 && isMinute(i)) { out += v.length === 2 ? two(p.mi) : String(p.mi); break }
        out += v.length === 1 ? String(p.mo)
          : v.length === 2 ? two(p.mo)
            : v.length === 3 ? names(locale, 'month', 'short')[p.mo - 1]
              : v.length === 5 ? names(locale, 'month', 'long')[p.mo - 1].slice(0, 1)
                : names(locale, 'month', 'long')[p.mo - 1]
        break
      case 'd':
        out += v.length === 1 ? String(p.d)
          : v.length === 2 ? two(p.d)
            : v.length === 3 ? names(locale, 'weekday', 'short')[p.wd]
              : names(locale, 'weekday', 'long')[p.wd]
        break
      case 'h': {
        const h = twelve ? ((p.h + 11) % 12) + 1 : p.h
        out += v.length >= 2 ? two(h) : String(h)
        break
      }
      case 's': out += v.length >= 2 ? two(p.s) : String(p.s); break
      default: {
        // AM/PM or A/P, in the case it was written
        const pm = p.h >= 12
        if (/^a\/p$/i.test(v)) out += pm ? (v[0] === 'a' ? 'p' : 'P') : (v[0] === 'a' ? 'a' : 'A')
        else out += pm ? (v[0] === 'a' ? 'pm' : 'PM') : (v[0] === 'a' ? 'am' : 'AM')
      }
    }
  })
  return out
}
