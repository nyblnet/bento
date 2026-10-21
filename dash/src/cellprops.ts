// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Per-cell FORMAT, TYPE and APPEARANCE on a spreadsheet sheet (`kind: 'canvas'`).
//
// `CanvasCell` has carried `{ format, color, bg, bold, align }` since commit
// one and nothing has ever SET them — the grid already paints all five. So this
// file is UI plus one thing that is not UI at all and is the reason the file
// exists: the rules that decide WHAT A CELL IS.
//
// ═══ THE COERCION RULES ═══════════════════════════════════════════════════
//
// A spreadsheet decides a cell's type from what was typed into it, and every
// spreadsheet in the world gets some of this wrong in a way that eats data —
// silently, at entry, where nobody is looking. These are dash's rules. They are
// pure functions below (`coerceInput`, `recastForFormat`) so the rig can hold
// them without a DOM, and they are stated here because the next person to
// "fix" one of them needs to know it was a decision.
//
// 1. THE TEXT FORMAT IS ABSOLUTE. A cell formatted Text (`@`) stores exactly
//    what was typed, as a string — never a number, never a boolean, and NOT a
//    formula even when it starts with `=`. That is the whole point of asking
//    for Text: `01234`, `1/2`, `+44 20`, `=mc2` and `TRUE` are all preserved
//    verbatim. Excel does this too, and it is the only escape hatch that is
//    guaranteed to hold, because every other rule below has an exception.
//
// 2. AN APOSTROPHE FORCES TEXT, once, for the cell being typed. `'007` stores
//    "007" and the apostrophe is dropped. Thirty years of muscle memory; it
//    costs one line and it is the fastest way out of any rule here.
//
// 3. LEADING ZEROS SURVIVE, and this is where dash differs from Excel. In a
//    cell with no format, `01234` stays the TEXT "01234". Excel and Sheets
//    both store 1234 and the zeros are gone forever — and the zeros are the
//    information: a part number, a postcode, an account. The reverse mistake
//    is recoverable (format the cell Number and it reads 1234); this one is
//    not. In a cell explicitly formatted Number/Currency/Percent the author
//    HAS said it is a quantity, so there `01234` is 1234.
//
// 4. DASH NEVER GUESSES A DATE FROM TYPING — and reads the ones that need no
//    guess. `1/2` and `3/4/2026` stay the text they were, not the 2nd of
//    January and not the 1st of February — nothing on screen would say which,
//    and that guess is the one that renamed a third of the human genome. But
//    `2026-03-04` (ISO) and `Mar 4 2026` / `4 March 2026` (a named month) can
//    only mean one day, and refusing THOSE was not caution, it was a
//    spreadsheet that could not take a date (review finding 3.2): typing one
//    stores the canonical `YYYY-MM-DD` and stamps the Date format, as rule 5
//    stamps a percent. A slash date stays text even when its day is over 12
//    (`readEnteredDate` says why). In a cell already formatted Date, every
//    unambiguous spelling is read (rule 8).
//
// 5. A MARK MAKES A FORMAT; a separator does not. Typing `50%` into an
//    unformatted cell stores 0.5 and stamps `0%`; typing `$1,200.50` stores
//    1200.5 and stamps `$#,##0.00`. Typing `1,200` stores 1200 and stamps
//    NOTHING — a comma is how a person types a number, whereas a `%` or a
//    currency symbol is a statement about what the number MEANS. A format is
//    only ever stamped on a cell that had none; typing never overwrites a
//    format somebody chose. `(5)` is -5 (accounting), and `€3,50` is 3.5 —
//    the digits are read by import.ts's `readEntryNumber`, the same shapes a
//    CSV is read with, and a field that fits BOTH conventions (`1,234`) goes
//    the way the VIEWER's own locale writes decimals.
//
//    This is what typing does on a spreadsheet since review finding 3.1. It
//    was written here, tested, and never wired: grid.ts kept its own narrower
//    `canvasValue`, so `15%` was stored as the TEXT "15%" and the formula
//    engine then read that text as 15.
//
// 6. A FORMAT CHANGE NEVER RESCALES A NUMBER. Applying Percent to 50 shows
//    5000%, as it does everywhere else, because the alternative — quietly
//    dividing by 100 — turns a column of rates into a column of wrong. Text
//    that carries a `%` is a different thing: reading "50%" as 0.5 is reading
//    the mark, not rescaling.
//
// 7. A FORMAT CHANGE NEVER DESTROYS A VALUE IT CANNOT READ. Applying Number to
//    "north" leaves "north" (and the format, which the grid ignores for text).
//    Applying Text to 1200 stores "1200" — the plain value, not the formatted
//    one, so `£1,200.00` does not become the literal string "£1,200.00".
//
// 8. AN AMBIGUOUS DATE IS REFUSED, not guessed. Applying Date accepts
//    `2026-03-05`, `2026/3/5`, `5 Mar 2026`, `Mar 5, 2026` and `13/2/2026`
//    (13 cannot be a month, so the order is decidable) and REFUSES `1/2/2026`.
//    A refused cell keeps its value and the panel says how many were refused.
//    Dates are stored as canonical `YYYY-MM-DD` TEXT, which is what the table
//    kind already does with a `date` column.
//
// 9. CLEARING A CELL KEEPS ITS FORMAT AND ITS APPEARANCE. Selecting a bolded
//    percent cell and pressing Delete empties it; it does not un-bold it. Same
//    rule `canvasCellEdit` already holds for colour, extended to `format`.
//
// ═══ WHY THE PATTERNS ARE RE-PARSED HERE ══════════════════════════════════
//
// `format.ts` owns the pattern → display half and its `readPattern` is module
// private, so the panel parses the pattern a second time to answer a different
// question: not "how do I print this" but "which preset is this, and with how
// many decimals" — the round trip a dropdown needs in order to show the format
// the cell already has. Worth folding into format.ts as an exported
// `classifyFormat` the day that file is open for editing.
//
// NOTHING HERE IMPORTS grid.ts, deliberately. `coerceInput` is meant to be the
// function grid.ts's `canvasCellEdit` calls, and a module the grid imports must
// not import the grid back.

import './cellprops.css'
import { t } from './i18n.ts'
import { formatValue, readPattern, typedNumber, viewerDecimal } from './format.ts'
import { readEntryNumber, type EntryNumber } from './import.ts'
import { formatRef } from './a1.ts'
import { isFormula } from './cellformula.ts'
import {
  KEY_CAP, applyAppearance, buildAppearanceSection, sameCell,
  type Appearance, type AppearanceEdit, type CellRange, type Pos,
} from './cellfmt.ts'
import type { CanvasCell, CanvasSheet, ColumnType } from './model.ts'
import type { Patch } from './store.ts'

// The selection geometry and the whole appearance vocabulary now live in
// cellfmt.ts, which serves BOTH kinds of sheet — this kind is no longer the
// only one that can bold a cell. Re-exported from here because this is where
// every existing caller (panels.ts, the rig) already looks for them, and a
// moved export is a needless edit to five other files.
export { KEY_CAP }
export type { CellRange, Pos }

// --- patterns ---------------------------------------------------------------

/** Excel's "everything here is text" pattern, and the one rule 1 hangs on. */
export const TEXT_PATTERN = '@'
/** The one date pattern dash writes. ISO, because rule 8 stores ISO. */
export const DATE_PATTERN = 'yyyy-mm-dd'
/** The one time pattern dash writes: 24-hour, the same canonical-text idea as
 *  Date — a time is stored as `HH:MM` (or `HH:MM:SS`) TEXT, never a fraction
 *  of a day nobody can read in the file. */
export const TIME_PATTERN = 'hh:mm'

export type FormatKind = 'general' | 'number' | 'currency' | 'percent' | 'date' | 'time' | 'text'

export interface FormatChoice {
  kind: FormatKind
  /** decimal places, for the three numeric kinds */
  dp: number
  /** thousands grouping */
  group: boolean
  /** the currency prefix, verbatim — `£`, `US$`, `CHF ` */
  symbol: string
}

export const DEFAULT_CHOICE: FormatChoice = { kind: 'general', dp: 2, group: true, symbol: '$' }

/**
 * What a preset means when it is picked on a cell that had NO format.
 *
 * Excel's answers, because they are the ones people expect from thirty years
 * of muscle memory: Percent is `0%` (a rate is 50%, not 50.00%), Number and
 * Currency are two decimals and grouped. Picked on a cell that ALREADY has a
 * format the current decimals are kept instead — switching Currency to Number
 * must not silently re-round a column somebody set to 3dp.
 */
export function defaultsFor(kind: FormatKind): Pick<FormatChoice, 'dp' | 'group'> {
  return kind === 'percent' ? { dp: 0, group: false } : { dp: 2, group: true }
}

/**
 * A currency symbol to START from, guessed from the VIEWER's locale.
 *
 * The symbol itself is DOCUMENT data — format.ts's opening argument, and it is
 * right: every reader of the file must see the author's currency. What is
 * viewer-scoped is the DEFAULT the picker opens with, which is a guess about
 * the author and is stored explicitly the moment they accept it. Guessing from
 * the browser beats defaulting to a currency the author does not use.
 */
export function localeSymbol(loc: string | undefined): string {
  const l = (loc ?? '').toLowerCase()
  if (l.startsWith('en-gb') || l.startsWith('cy')) return '£'
  if (/^(de|fr|es|it|nl|pt|fi|el|ga|sk|sl|lv|lt|et|mt)\b/.test(l)) return '€'
  if (l.startsWith('ja') || l.startsWith('zh')) return '¥'
  if (l.startsWith('ru')) return '₽'
  if (l.startsWith('hi') || l.startsWith('en-in')) return '₹'
  return '$'
}

const digitsFor = (dp: number, group: boolean): string =>
  `${group ? '#,##0' : '0'}${dp > 0 ? `.${'0'.repeat(dp)}` : ''}`

/** The pattern a choice writes. `undefined` is General — the ABSENT field. */
export function buildPattern(c: FormatChoice): string | undefined {
  const dp = Math.max(0, Math.min(9, Math.round(c.dp)))
  switch (c.kind) {
    case 'general': return undefined
    case 'text': return TEXT_PATTERN
    case 'date': return DATE_PATTERN
    case 'time': return TIME_PATTERN
    case 'percent': return `${digitsFor(dp, c.group)}%`
    case 'currency': return `${c.symbol}${digitsFor(dp, c.group)}`
    case 'number': return digitsFor(dp, c.group)
  }
}

/** Is this the Text format? The one question rule 1 asks of a cell. */
export const isTextFormat = (fmt: unknown): boolean =>
  typeof fmt === 'string' && fmt.trim() === TEXT_PATTERN

/** An hour token and no digit placeholder. Asked BEFORE `looksLikeDate`, whose
 *  `m{1,4}` would otherwise claim `hh:mm` for a date by its minutes. */
const looksLikeTime = (f: string): boolean => /h/i.test(f) && !/[#0]/.test(f) && !/[yd]/i.test(f)

const looksLikeDate = (f: string): boolean =>
  /[ymd]/i.test(f) && !/[#0]/.test(f) && /y{2,4}|d{1,2}|m{1,4}/i.test(f)

/**
 * Which preset a stored pattern IS — the round trip a dropdown needs.
 *
 * Answers a choice for ANY string, so an unrecognised pattern still yields
 * sensible decimals for the stepper; the caller decides whether it is "custom"
 * by rebuilding the pattern and comparing (`isCustomPattern`).
 */
export function classifyFormat(fmt: string | undefined): FormatChoice {
  const f = (fmt ?? '').trim()
  if (!f) return { ...DEFAULT_CHOICE }
  if (f === TEXT_PATTERN) return { ...DEFAULT_CHOICE, kind: 'text' }
  if (looksLikeTime(f)) return { ...DEFAULT_CHOICE, kind: 'time' }
  if (looksLikeDate(f)) return { ...DEFAULT_CHOICE, kind: 'date' }

  const pct = f.includes('%')
  const body = f.replace('%', '')
  const m = body.match(/[#0][#0,]*(?:\.0+)?/)      // format.ts readPattern's own shape
  const digits = m?.[0] ?? ''
  const at = m ? body.indexOf(digits) : -1
  const dot = digits.indexOf('.')
  const prefix = at >= 0 ? body.slice(0, at) : ''
  return {
    kind: pct ? 'percent' : prefix ? 'currency' : 'number',
    dp: dot >= 0 ? digits.length - dot - 1 : 0,
    group: digits.includes(','),
    symbol: prefix || DEFAULT_CHOICE.symbol,
  }
}

/** A pattern no preset spells — the dropdown shows "Custom" and stays out of it. */
export const isCustomPattern = (fmt: string | undefined): boolean => {
  const f = (fmt ?? '').trim()
  if (!f) return false
  return buildPattern(classifyFormat(f)) !== f
}

// --- reading what was typed -------------------------------------------------

/**
 * What a typed field reads as — import.ts's `EntryNumber`. The reading is
 * import's, not a second parser: one set of digit shapes decides what `1,234`,
 * `3,50`, `$5`, `(5)` and `15%` mean, whether they were typed, pasted,
 * imported or met by a formula.
 */
export type TypedNumber = EntryNumber

/**
 * Read a typed field as a number, or answer null.
 *
 * `strict` is rule 3: with it, a leading zero disqualifies the field (an
 * unformatted cell keeps `01234` as text); without it — the cell is explicitly
 * numeric — the zeros are dropped and the number is read.
 *
 * The decimal convention is the VIEWER's when the field alone cannot say
 * (`1,234` is 1234 to a British typist and 1.234 to a German one); `3,50`
 * reads 3.5 to everybody, as it does on import. See `readEntryNumber`.
 */
export function readTypedNumber(text: string, opts: { strict?: boolean } = {}): TypedNumber | null {
  return readEntryNumber(text, { strict: opts.strict, prefer: viewerDecimal() })
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const iso = (y: number, m: number, d: number): string | null => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  // a real calendar check, so 31 February is refused rather than stored
  const probe = new Date(Date.UTC(y, m - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * A date, canonical, or null when the spelling is ambiguous or is not one.
 *
 * Rule 8. The refusal is the feature: `1/2/2026` gets null, because dash cannot
 * know which half is the month and neither can the reader looking at it.
 */
export function readTypedDate(text: string): string | null {
  const s = text.trim()
  if (!s) return null

  // ISO first, and slashes with a four-digit year at the FRONT are ISO order
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (m) return iso(+m[1], +m[2], +m[3])

  // a named month is never ambiguous: `5 Mar 2026`, `Mar 5, 2026`, `March 2026`
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/)
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase())
    return mi < 0 ? null : iso(+m[3], mi + 1, +m[1])
  }
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/)
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase())
    return mi < 0 ? null : iso(+m[3], mi + 1, +m[2])
  }

  // d/m/yyyy or m/d/yyyy — ONLY when one of the two cannot be a month
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/)
  if (m) {
    const a = +m[1]
    const b = +m[2]
    if (a > 12 && b <= 12) return iso(+m[3], b, a)
    if (b > 12 && a <= 12) return iso(+m[3], a, b)
    return null                                   // 1/2/2026 — refused, on purpose
  }
  return null
}

/**
 * A date read from TYPING into a cell with no format — rule 4's narrower set.
 *
 * ISO (`2026-03-04`, `2026/3/4`) and a named month (`Mar 4 2026`,
 * `4 March 2026`) and nothing else. `readTypedDate` also accepts a slash date
 * whose day is over 12 (`13/2/2026`), which is right when somebody has SAID the
 * cell is a date — but from bare typing it would make `13/2/2026` a date and
 * `12/2/2026`, one row up, the text it has to stay. One column, two kinds, and
 * which is which decided by the day of the month: the refusal is kept whole.
 */
export function readEnteredDate(text: string): string | null {
  const s = text.trim()
  if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(s)) return null
  return readTypedDate(s)
}

/**
 * A time of day, canonical `HH:MM` (or `HH:MM:SS`), or null.
 *
 * Accepts `14:30`, `9:05`, `2:30 pm`, `2:30PM`, `14:30:15`. Unlike a date there
 * is no day/month ambiguity to refuse — only an out-of-range hour or minute.
 */
export function readTypedTime(text: string): string | null {
  const m = text.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i)
  if (!m) return null
  let h = +m[1]
  const min = +m[2]
  const sec = m[3] === undefined ? null : +m[3]
  if (m[4]) {
    if (h < 1 || h > 12) return null
    const pm = /^p/i.test(m[4])
    h = (h % 12) + (pm ? 12 : 0)
  }
  if (h > 23 || min > 59 || (sec !== null && sec > 59)) return null
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(h)}:${two(min)}${sec === null ? '' : `:${two(sec)}`}`
}

// --- the two rules, as functions --------------------------------------------

/** A cell with nothing in it at all is not a cell — sparseness, kept here too. */
const orNull = (c: CanvasCell): CanvasCell | null => (Object.keys(c).length ? c : null)

/**
 * Writing `text` into a cell: the cell to store, or `null` to REMOVE the key.
 *
 * The format-aware replacement for grid.ts's `canvasCellEdit`, and a drop-in
 * one: same signature, same null-means-absent contract, same "a value and a
 * formula are alternatives" rule. What it adds is rules 1–5 — which is the
 * difference between a spreadsheet that can be told what a cell is and one
 * that only guesses.
 */
export function coerceInput(prev: CanvasCell | undefined, text: string): CanvasCell | null {
  const { v: _v, f: _f, ...rest } = prev ?? {}
  const s = text.trim()

  // rule 9: an emptied cell keeps its format and its appearance
  if (s === '') return orNull(rest)

  // rule 1: Text is absolute — a formula typed here is the text of a formula
  if (isTextFormat(rest.format)) return { ...rest, v: text.replace(/^'/, '') }

  // rule 2: the apostrophe, which beats everything below it
  if (s.startsWith("'")) return { ...rest, v: s.slice(1) }

  if (isFormula(s)) return { ...rest, f: s }
  if (/^true$/i.test(s)) return { ...rest, v: true }
  if (/^false$/i.test(s)) return { ...rest, v: false }

  const has = typeof rest.format === 'string' && rest.format.trim() !== ''
  const choice = has ? classifyFormat(rest.format as string) : null
  const numeric = choice !== null &&
    (choice.kind === 'number' || choice.kind === 'currency' || choice.kind === 'percent')

  // rule 3: strict (leading zeros are a label) unless the cell says it is a quantity
  const num = readTypedNumber(s, { strict: !numeric })
  if (!num) {
    // rule 4: a date is read from typing only where nobody could misread it
    // (in a Date cell any unambiguous spelling; in a blank one the narrower set
    // `readEnteredDate` allows; in a cell somebody formatted as a NUMBER, none —
    // typing never overwrites a format somebody chose, rule 5)
    if (choice?.kind === 'date') {
      const d = readTypedDate(s)
      if (d) return { ...rest, v: d }
    } else if (!has) {
      const d = readEnteredDate(s)
      if (d) return { ...rest, v: d, format: DATE_PATTERN }
    }
    return { ...rest, v: s }
  }

  // A bare number in a PERCENT cell is percent points — Excel's rule, and the
  // one everybody has muscle memory for: 50 in a percent cell is 50%.
  if (choice?.kind === 'percent' && !num.pct) return { ...rest, v: num.n / 100 }
  if (has) return { ...rest, v: num.n }

  // rule 5: a MARK makes a format, a separator does not
  if (num.pct) {
    return { ...rest, v: num.n, format: buildPattern({ ...DEFAULT_CHOICE, kind: 'percent', dp: num.dp, group: false }) }
  }
  if (num.symbol) {
    return {
      ...rest,
      v: num.n,
      format: buildPattern({ ...DEFAULT_CHOICE, kind: 'currency', dp: num.dp, group: true, symbol: num.symbol }),
    }
  }
  return { ...rest, v: num.n }
}

export interface Recast {
  cell: CanvasCell | null
  /** the value could not be read as the new format asks — rule 7/8 kept it */
  refused: boolean
}

/**
 * Apply `fmt` to a cell, re-reading its value the way the new format asks.
 *
 * Rules 6–8. A formula cell is never re-read — the value is derived, and
 * rewriting it would be a file carrying a number that disagrees with its own
 * formula (the thing `canvasCellEdit` refuses too).
 */
export function recastForFormat(prev: CanvasCell | undefined, fmt: string | undefined): Recast {
  const base: CanvasCell = { ...(prev ?? {}) }
  if (fmt === undefined) delete base.format
  else base.format = fmt

  if (base.f !== undefined || base.v === undefined || base.v === '') {
    return { cell: orNull(base), refused: false }
  }

  const kind = fmt === undefined ? 'general' : classifyFormat(fmt).kind
  const v = base.v

  if (kind === 'text') {
    // rule 7: the PLAIN value, never the formatted one
    return { cell: { ...base, v: typeof v === 'string' ? v : String(v) }, refused: false }
  }
  if (kind === 'date') {
    if (typeof v !== 'string') return { cell: base, refused: typeof v === 'number' }
    const d = readTypedDate(v)
    return d ? { cell: { ...base, v: d }, refused: false } : { cell: base, refused: true }
  }
  if (kind === 'time') {
    if (typeof v !== 'string') return { cell: base, refused: typeof v === 'number' }
    const tm = readTypedTime(v)
    return tm ? { cell: { ...base, v: tm }, refused: false } : { cell: base, refused: true }
  }
  if (kind === 'number' || kind === 'currency' || kind === 'percent') {
    if (typeof v === 'number') return { cell: base, refused: false }   // rule 6: never rescaled
    if (typeof v !== 'string') return { cell: base, refused: true }
    const num = readTypedNumber(v)
    return num ? { cell: { ...base, v: num.n }, refused: false } : { cell: base, refused: true }
  }
  return { cell: orNull(base), refused: false }
}

/**
 * What the formula bar (and the cell editor) shows for a VALUE cell: the form
 * somebody would type to put that value there — finding 2.8.
 *
 * Not the display (`$1,200.50` rounds; `12%` hides `12.5%`) and not the raw
 * stored number (`1` for a cell that reads `100%`, which then re-commits as
 * 100%·100 the moment somebody presses Enter on it in a percent cell). The
 * rule is a ROUND TRIP: `coerceInput(cell, enteredForm(cell))` stores the same
 * value again, so opening a cell and pressing Enter never changes it.
 *
 *   • a percent cell shows its value ×100 with a `%`, at full precision;
 *   • a currency cell shows its symbol and at least the format's decimals;
 *   • any other number is written in the viewer's own decimal separator,
 *     ungrouped — the separator `readTypedNumber` will read it back with;
 *   • text that would NOT read back as itself (`'15%` kept as text, a legacy
 *     file's "2026-03-04" that was never made a date) wears the apostrophe that
 *     keeps it text, which is also how a reader can see that it IS text.
 *
 * A formula cell is not this function's business: the bar shows its source.
 */
export function enteredForm(cell: CanvasCell | undefined): string {
  const v = cell?.v
  if (v === undefined || v === null || v === '') return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  const fmt = typeof cell?.format === 'string' ? cell.format : undefined
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v)
    const kind = fmt ? classifyFormat(fmt).kind : 'general'
    return enteredNumber(v, kind === 'percent' ? 'percent' : kind === 'currency' ? 'currency' : 'plain', fmt)
  }
  const s = String(v)
  if (isTextFormat(fmt)) return s
  // would typing `s` back into this cell store `s`? if not, it needs the apostrophe
  const { v: _v, f: _f, ...rest } = cell ?? {}
  const back = coerceInput(rest, s)
  return back && back.v === s && back.f === undefined && back.format === rest.format ? s : `'${s}`
}

/**
 * A NUMBER in its entered form — `enteredForm`'s numeric half, shared with the
 * dataset kind, whose column (not the cell) says percent or money.
 *
 *   percent   ×100 with a `%`, at full precision — `100%` for a stored 1
 *   currency  the pattern's own symbol, and at least its decimals — `$300.50`
 *   plain     the number, ungrouped, in the viewer's decimal separator
 */
export function enteredNumber(v: number, kind: 'percent' | 'currency' | 'plain', fmt?: string): string {
  if (!Number.isFinite(v)) return String(v)
  if (kind === 'percent') {
    const shown = Number((v * 100).toPrecision(15))
    // full precision, but never the binary noise of ×100 (0.07·100)
    return `${typedNumber(shown / 100 === v ? shown : v * 100)}%`
  }
  if (kind === 'currency') {
    const p = readPattern(fmt)
    const body = typedNumber(Math.abs(v), p.dp ?? 0)
    return `${v < 0 ? '-' : ''}${p.prefix}${body}${p.suffix}`
  }
  return typedNumber(v)
}

// --- selections, as A1 keys -------------------------------------------------

/** One address. a1.ts's `formatRef` is the ONLY place a key is minted. */
const a1 = (row: number, col: number): string =>
  formatRef({ row, col, absRow: false, absCol: false })

/**
 * Every address in the selection, once, in reading order.
 *
 * Deduplicated because ⌘-click ranges overlap and one A1 key must appear once
 * in a patch — `setCanvasCells` is a record, so a repeat is silently the last
 * one, and the INVERSE would then be built from a value the first write had
 * already replaced.
 */
export function rangeKeys(ranges: readonly CellRange[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of ranges) {
    const top = Math.min(r.anchor.row, r.head.row)
    const bottom = Math.max(r.anchor.row, r.head.row)
    const left = Math.min(r.anchor.col, r.head.col)
    const right = Math.max(r.anchor.col, r.head.col)
    for (let row = top; row <= bottom; row++) {
      for (let col = left; col <= right; col++) {
        if (out.length >= KEY_CAP) return out
        const k = a1(row, col)
        if (seen.has(k)) continue
        seen.add(k)
        out.push(k)
      }
    }
  }
  return out
}

/** "B2", or "B2:D5 · 12 cells" — what the section is about to write to. */
export function describeSelection(ranges: readonly CellRange[]): string {
  const n = rangeKeys(ranges).length
  const r = ranges[ranges.length - 1]
  if (!r) return ''
  const a = a1(Math.min(r.anchor.row, r.head.row), Math.min(r.anchor.col, r.head.col))
  const b = a1(Math.max(r.anchor.row, r.head.row), Math.max(r.anchor.col, r.head.col))
  if (n === 1) return a
  const span = a === b ? a : `${a}:${b}`
  return `${ranges.length > 1 ? `${span}…` : span} · ${t('{n} cells').replace('{n}', String(n))}`
}

// --- patches ----------------------------------------------------------------
//
// ONE PATCH FOR THE WHOLE SELECTION, always. Bolding twenty cells is one edit
// to the person who did it, so it has to be one undo step — and `setCanvasCells`
// already carries many cells for exactly this reason (a paste, a fill, a
// delete). Twenty patches would also be twenty CRDT ops and twenty repaints.

/** The appearance vocabulary is cellfmt.ts's now, and it is the SAME one the
 *  dataset kind writes — italic, underline, wrap and borders included. */
export type StyleEdit = AppearanceEdit

const same = (a: CanvasCell | null, b: CanvasCell | undefined): boolean =>
  sameCell(a as Record<string, unknown> | null, b as Record<string, unknown> | undefined)

/**
 * Set or clear appearance fields across a selection.
 *
 * `null` clears — and a cleared field is DELETED, never stored as `false` or
 * `''`. An additive field where absent means "no" has to be absent when the
 * answer is no, or un-bolding a cell leaves the file different from the one
 * before anyone bolded it (the argument panels.ts makes for `totals`).
 *
 * Cells the edit would not change are left OUT of the patch, so applying
 * "align: auto" to forty untouched cells writes nothing at all — a spreadsheet
 * that grows forty entries because somebody clicked a control that did nothing
 * is not sparse any more.
 */
export function stylePatch(sheet: CanvasSheet, keys: readonly string[], edit: StyleEdit): Patch | null {
  const cells: Record<string, CanvasCell | null> = {}
  let n = 0
  for (const key of keys) {
    const prev = sheet.cells[key]
    // `applyAppearance` is the shared writer: it clears by DELETING the key
    // (`false` and `''` mean absent too) and it refuses to write anything
    // outside `APPEARANCE_FIELDS`, so this path cannot smuggle a `v` either.
    const out = applyAppearance<CanvasCell>(prev, edit)
    if (same(out, prev)) continue
    cells[key] = out
    n++
  }
  return n ? { op: 'setCanvasCells', sheet: sheet.id, cells } : null
}

export interface FormatPatch {
  patch: Patch | null
  /** cells whose value the new format could not read — rules 7 and 8 */
  refused: number
  /** cells whose value the new format re-read into something else */
  recast: number
}

/** Apply one pattern across a selection, re-reading every value with it. */
export function formatPatch(
  sheet: CanvasSheet, keys: readonly string[], fmt: string | undefined,
): FormatPatch {
  const cells: Record<string, CanvasCell | null> = {}
  let n = 0
  let refused = 0
  let recast = 0
  for (const key of keys) {
    const prev = sheet.cells[key]
    const r = recastForFormat(prev, fmt)
    if (same(r.cell, prev)) continue
    if (r.refused) refused++
    if (prev && r.cell && prev.v !== r.cell.v) recast++
    cells[key] = r.cell
    n++
  }
  // A refusal on a cell that changed nothing else still has to be reported, so
  // it is counted above the `same` skip only when something was written. A
  // cell that was ALREADY in the target format and could not be read is not a
  // new refusal; nothing about it changed.
  return { patch: n ? { op: 'setCanvasCells', sheet: sheet.id, cells } : null, refused, recast }
}

// --- the panel section ------------------------------------------------------

/** The row builders panels.ts owns — passed in so there is ONE spelling of a row. */
export interface PanelKit {
  section(host: HTMLElement, title: string): void
  row(host: HTMLElement, label: string, control: HTMLElement): void
  readonlyRow(host: HTMLElement, label: string, value: string): void
  note(host: HTMLElement, message: string): void
  text(value: string, onChange: (v: string) => void): HTMLInputElement
  number(value: number, step: number, onChange: (v: number) => void): HTMLInputElement
  select(
    options: ReadonlyArray<readonly [string, string]>, value: string,
    onChange: (v: string) => void,
  ): HTMLSelectElement
  check(value: boolean, onChange: (v: boolean) => void): HTMLInputElement
}

export interface CellPropsHost {
  host: HTMLElement
  kit: PanelKit
  sheet: CanvasSheet
  ranges: readonly CellRange[]
  cursor: Pos
  readOnly: boolean
  /** the viewer's locale, for the currency default only */
  locale?: string
  commit(p: Patch): void
  /** something the last edit needs to say — a refusal count, usually */
  message?: string
  say(msg: string): void
  /** rebuild the panel without a commit — Custom… opening, mostly */
  rerender(): void
  /** the value the cursor cell SHOWS — a formula's result, not its absent `v` */
  value?: unknown
}

/** The presets a SPREADSHEET cell offers — every kind there is, since the cell
 *  is where this kind of sheet decides what a value IS. */
export const CELL_KINDS: readonly FormatKind[] =
  ['general', 'number', 'currency', 'percent', 'date', 'time', 'text']

/**
 * A LITERAL translation call per preset, rather than one over a lookup table.
 *
 * The extraction rig sweeps literal translation calls out of the source and
 * diffs them against every catalog. A call whose argument is a table lookup is
 * invisible to it unless the table is ALSO declared in the rig's INDIRECT
 * list — a second place to remember, and one nobody remembers. Written out,
 * the strings are where the tool already looks for them.
 */
const kindLabel = (k: FormatKind): string =>
  k === 'general' ? t('General')
    : k === 'number' ? t('Number')
      : k === 'currency' ? t('Currency')
        : k === 'percent' ? t('Percent')
          : k === 'date' ? t('Date')
            : k === 'time' ? t('Time')
              : t('Text')

/** A quantity for the preview when the cell is empty — something with a shape. */
const SAMPLE = 1234.5
/** …and a moment, for the two presets that print one. */
const SAMPLE_DATE = '2026-03-05'
const SAMPLE_TIME = '14:30'

const valueType = (v: unknown): ColumnType =>
  typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'text'

// ═══ ONE NUMBER-FORMAT CONTROL ═════════════════════════════════════════════
//
// Both kinds of sheet used to show three controls for one idea: a preset
// dropdown, a raw Pattern field and a "Shows as" box on a spreadsheet; a cell
// Pattern AND a column Format on a dataset, each with its own placeholder.
// They are one control now, drawn by this one builder on both kinds:
//
//   Number format  [preset ▾]       General, Number, Currency, Percent, … Custom…
//   (Decimals / Thousands separator / Symbol — only for the numeric presets)
//   Pattern        [#,##0.00 "kg"]  — ONLY while the preset is Custom…
//                   £1,234.50       — a live sample, printed, not a field
//
// and, on a dataset, an "Apply to" choice above it — this column or these
// cells — because there the column owns the format and a cell may override it.
// No model field changed: the column still writes `format`, a cell override
// still writes its own `format`, a spreadsheet cell still writes its own.

/** What the preset select can stand on besides a FormatKind. */
export type FormatOption = FormatKind | 'inherit'

export interface NumberFormatCtx {
  host: HTMLElement
  kit: PanelKit
  /** the pattern stored in the CURRENT scope; absent = General (or inherit) */
  fmt: string | undefined
  /** the presets this scope offers, in order. Custom… is always appended. */
  kinds: readonly FormatOption[]
  /** the pattern a cell inherits when it has none (dataset, cells scope) */
  inherited?: string
  /** dataset only: the scope switch */
  scope?: { value: 'column' | 'cells'; set(v: 'column' | 'cells'): void }
  /** the sample, printed with a candidate pattern */
  preview(fmt: string | undefined): { text: string; sample: boolean }
  /** identifies the selection, so "Custom…" stays open across a rebuild */
  key: string
  locale?: string
  readOnly: boolean
  /** `undefined` clears the field in this scope */
  write(next: string | undefined): void
  rerender(): void
}

/** Which selection has Custom… open with no custom pattern stored yet. */
let customOpen: string | null = null
/** …and whether the Pattern field it reveals should take the focus. */
let focusPattern = false

/** What the preset select shows for a stored pattern, in a given scope. */
export function formatOptionFor(
  fmt: string | undefined, kinds: readonly FormatOption[],
): FormatOption | 'custom' {
  if (!fmt) return kinds.includes('inherit') ? 'inherit' : 'general'
  if (isCustomPattern(fmt)) return 'custom'
  const k = classifyFormat(fmt).kind
  return kinds.includes(k) ? k : 'custom'
}

export function buildNumberFormat(ctx: NumberFormatCtx): void {
  const { host, kit, fmt, kinds, readOnly } = ctx
  const w = (next: string | undefined): void => { if (!readOnly) ctx.write(next) }

  if (ctx.scope) {
    const sc = ctx.scope
    const scopeSel = kit.select(
      [['column', t('This column')] as const, ['cells', t('These cells')] as const],
      sc.value, (v) => sc.set(v as 'column' | 'cells'))
    scopeSel.disabled = readOnly
    scopeSel.dataset.dpField = 'format-scope'
    kit.row(host, t('Apply to'), scopeSel)
  }

  const stored = formatOptionFor(fmt, kinds)
  if (stored === 'custom' && customOpen === ctx.key) customOpen = null
  const shown = customOpen === ctx.key ? 'custom' : stored
  // A cell inheriting its column's pattern starts every preset from THAT
  // pattern's decimals and symbol — "Number" on a £#,##0 column means 0dp.
  const basis = fmt ?? ctx.inherited
  const was = classifyFormat(basis)
  const choice: FormatChoice = {
    ...was,
    ...(basis && was.kind === 'currency' ? {} : { symbol: localeSymbol(ctx.locale) }),
  }

  const options: Array<readonly [string, string]> = [
    ...kinds.map((k) => [k, k === 'inherit' ? t('Same as column') : kindLabel(k)] as const),
    ['custom', t('Custom…')] as const,
  ]
  const sel = kit.select(options, shown, (v) => {
    if (v === 'custom') { customOpen = ctx.key; focusPattern = true; ctx.rerender(); return }
    customOpen = null
    if (v === 'inherit' || v === 'general') { w(undefined); ctx.rerender(); return }
    const kind = v as FormatKind
    // No pattern yet: the preset's own defaults. A pattern already: keep the
    // decimals its author chose — switching Currency to Number must not
    // silently re-round a column somebody set to 3dp.
    w(buildPattern({ ...choice, ...(basis ? {} : defaultsFor(kind)), kind }))
    ctx.rerender()
  })
  sel.disabled = readOnly
  sel.dataset.dpField = 'number-format'
  kit.row(host, t('Number format'), sel)

  const preset = shown === 'number' || shown === 'currency' || shown === 'percent' ? shown : null
  if (preset) {
    const dp = kit.number(choice.dp, 1, (v) =>
      w(buildPattern({ ...choice, kind: preset, dp: Math.max(0, Math.min(9, Math.round(v))) })))
    dp.min = '0'
    dp.max = '9'
    dp.disabled = readOnly
    kit.row(host, t('Decimals'), dp)

    const grp = kit.check(choice.group, (v) => w(buildPattern({ ...choice, kind: preset, group: v })))
    grp.disabled = readOnly
    kit.row(host, t('Thousands separator'), grp)

    if (preset === 'currency') {
      const sym = kit.text(choice.symbol, (v) =>
        w(buildPattern({ ...choice, kind: preset, symbol: v.trim() || choice.symbol })))
      sym.disabled = readOnly
      sym.classList.add('dp-narrow')
      kit.row(host, t('Symbol'), sym)
    }
  }

  // THE ESCAPE HATCH — revealed only for Custom…, where it is the whole control.
  if (shown === 'custom') {
    const pat = kit.text(fmt ?? '', (v) => {
      const next = v.trim()
      if (next === (fmt ?? '')) return
      w(next || undefined)
    })
    pat.placeholder = basis ?? '#,##0.00'
    pat.classList.add('dp-mono')
    pat.disabled = readOnly
    pat.dataset.dpField = 'pattern'
    kit.row(host, t('Pattern'), pat)
    if (focusPattern) {
      focusPattern = false
      // Selected, so typing REPLACES the preset's pattern it opened on and
      // an arrow key edits it instead.
      queueMicrotask(() => { if (pat.isConnected) { pat.focus(); pat.select() } })
    }
  }

  // The live sample: what the pattern DOES, against this cell's own value. A
  // printed line under the control, not a field — it is an answer, not a
  // question, and a bordered box here read as a third control.
  const p = ctx.preview(basis)
  const line = document.createElement('div')
  line.className = 'dp-row dp-row-sample'
  const out = document.createElement('span')
  out.className = p.sample ? 'dc-sample dc-sample-eg' : 'dc-sample'
  out.title = t('Sample')
  out.textContent = p.text
  line.append(document.createElement('span'), out)
  host.appendChild(line)
}

/** The sample for a spreadsheet cell: its own value, or a shape for the preset. */
export function cellPreview(
  value: unknown, fmt: string | undefined,
): { text: string; sample: boolean } {
  const empty = value === undefined || value === null || value === ''
  const kind = classifyFormat(fmt).kind
  const v = !empty ? value
    : kind === 'date' ? SAMPLE_DATE : kind === 'time' ? SAMPLE_TIME : SAMPLE
  return { text: formatValue(v, { type: valueType(v), format: fmt }), sample: empty }
}

/**
 * The Cell section: what this cell IS, and what it looks like.
 *
 * Reads the sheet, writes patches, and owns no state — the panel rebuilds on
 * every `doc` and every selection change, so anything remembered here would be
 * a second copy of the document going stale.
 */
export function buildCellProps(ctx: CellPropsHost): void {
  const { host, kit, sheet, ranges, cursor, readOnly } = ctx
  const keys = rangeKeys(ranges)
  const cursorKey = a1(cursor.row, cursor.col)
  const cell: CanvasCell | undefined = sheet.cells[cursorKey]

  kit.section(host, t('Cell'))
  kit.readonlyRow(host, t('Selection'), describeSelection(ranges) || cursorKey)

  if (keys.length >= KEY_CAP) {
    kit.note(host, t('Only the first {n} cells of this selection will be changed.')
      .replace('{n}', String(KEY_CAP)))
  }

  // --- number format --------------------------------------------------------

  const fmt = typeof cell?.format === 'string' ? cell.format : undefined
  buildNumberFormat({
    host, kit, fmt, kinds: CELL_KINDS,
    preview: (f) => cellPreview(ctx.value !== undefined ? ctx.value : cell?.v, f),
    key: `${sheet.id}!${cursorKey}`,
    locale: ctx.locale,
    readOnly,
    rerender: ctx.rerender,
    write: (next) => {
      const r = formatPatch(sheet, keys, next)
      if (r.patch) ctx.commit(r.patch)
      ctx.say(r.refused
        ? t('{n} value(s) could not be read as this format, and were left as they are.')
          .replace('{n}', String(r.refused))
        : '')
    },
  })

  if (isTextFormat(fmt)) {
    kit.note(host, t('Text cells keep exactly what is typed — leading zeros, slashes, and an = that is not a formula.'))
  }

  // --- appearance -----------------------------------------------------------

  const style = (edit: StyleEdit): void => {
    if (readOnly) return
    const p = stylePatch(sheet, keys, edit)
    if (p) ctx.commit(p)
    ctx.say('')
  }

  // ONE section builder, drawn identically on the dataset kind — see
  // cellfmt.ts. This kind's own contribution above it is the FORMAT block,
  // which is where its cell types are decided.
  buildAppearanceSection({ host, kit, cell: cell as Appearance | undefined, readOnly, write: style })

  if (ctx.message) kit.note(host, ctx.message)
}
