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
// 4. DASH NEVER INFERS A DATE FROM TYPING. `1/2` is the text "1/2", not the
//    2nd of January and not the 1st of February — nothing on screen would say
//    which, and that guess is the one that renamed a third of the human
//    genome. Dates arrive by APPLYING the Date format, which parses only
//    unambiguous spellings (rule 8) and leaves anything else alone.
//
// 5. A MARK MAKES A FORMAT; a separator does not. Typing `50%` into an
//    unformatted cell stores 0.5 and stamps `0%`; typing `$1,200.50` stores
//    1200.5 and stamps `$#,##0.00`. Typing `1,200` stores 1200 and stamps
//    NOTHING — a comma is how a person types a number, whereas a `%` or a
//    currency symbol is a statement about what the number MEANS. A format is
//    only ever stamped on a cell that had none; typing never overwrites a
//    format somebody chose.
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
import { alignFor, formatValue } from './format.ts'
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

export type FormatKind = 'general' | 'number' | 'currency' | 'percent' | 'date' | 'text'

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
    case 'percent': return `${digitsFor(dp, c.group)}%`
    case 'currency': return `${c.symbol}${digitsFor(dp, c.group)}`
    case 'number': return digitsFor(dp, c.group)
  }
}

/** Is this the Text format? The one question rule 1 asks of a cell. */
export const isTextFormat = (fmt: unknown): boolean =>
  typeof fmt === 'string' && fmt.trim() === TEXT_PATTERN

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

/** Grouped, or plain, with an optional exponent. Signs and marks are peeled first. */
const NUMERIC = /^(?:\d+|\d{1,3}(?:,\d{3})+)?(?:\.\d+)?(?:[eE][-+]?\d+)?$/
/** Symbols worth peeling. A prefix a person would type, not every glyph in Unicode. */
const SYMBOLS = /^[$£€¥₹₽₩₪₺]\s?|^[A-Z]{0,3}\$\s?/

export interface TypedNumber {
  n: number
  /** the field carried a `%` — the value has ALREADY been divided by 100 */
  pct: boolean
  /** the field carried a currency symbol, verbatim */
  symbol: string
  /** decimals actually typed, so a stamped format can match what was written */
  dp: number
  /** the field carried a thousands separator */
  group: boolean
}

/**
 * Read a typed field as a number, or answer null.
 *
 * `strict` is rule 3: with it, a leading zero disqualifies the field (an
 * unformatted cell keeps `01234` as text); without it — the cell is explicitly
 * numeric — the zeros are dropped and the number is read.
 */
export function readTypedNumber(text: string, opts: { strict?: boolean } = {}): TypedNumber | null {
  let s = text.trim()
  if (!s) return null

  // (1,200) is -1200: accounting notation, and the only bracket form worth it
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim() }

  let symbol = ''
  const sym = s.match(SYMBOLS)
  if (sym) { symbol = sym[0]; s = s.slice(sym[0].length).trim() }

  if (s.startsWith('-')) { neg = !neg; s = s.slice(1).trim() }
  else if (s.startsWith('+')) s = s.slice(1).trim()

  // the symbol may sit after the sign — `-$5` as well as `$-5`
  if (!symbol) {
    const sym2 = s.match(SYMBOLS)
    if (sym2) { symbol = sym2[0]; s = s.slice(sym2[0].length).trim() }
  }

  let pct = false
  if (s.endsWith('%')) { pct = true; s = s.slice(0, -1).trim() }

  if (!/\d/.test(s) || !NUMERIC.test(s)) return null
  // rule 3: `0` and `0.5` are numbers; `007` is a label somebody kept the zeros on
  if (opts.strict && /^0\d/.test(s)) return null

  const bare = s.replace(/,/g, '')
  let n = Number(bare)
  if (!Number.isFinite(n)) return null
  if (neg) n = -n
  if (pct) n /= 100

  const dot = bare.indexOf('.')
  const eAt = bare.search(/[eE]/)
  return {
    n,
    pct,
    symbol,
    dp: dot < 0 ? 0 : (eAt < 0 ? bare.length : eAt) - dot - 1,
    group: s.includes(','),
  }
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
  if (!num) return { ...rest, v: s }

  // A bare number in a PERCENT cell is percent points — Excel's rule, and the
  // one everybody has muscle memory for: 50 in a percent cell is 50%.
  if (choice?.kind === 'percent' && !num.pct) return { ...rest, v: num.n / 100 }
  if (has) return { ...rest, v: num.n }

  // rule 5: a MARK makes a format, a separator does not
  if (num.pct) {
    return { ...rest, v: num.n, format: buildPattern({ ...DEFAULT_CHOICE, kind: 'percent', dp: Math.max(0, num.dp - 2), group: false }) }
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
  if (kind === 'number' || kind === 'currency' || kind === 'percent') {
    if (typeof v === 'number') return { cell: base, refused: false }   // rule 6: never rescaled
    if (typeof v !== 'string') return { cell: base, refused: true }
    const num = readTypedNumber(v)
    return num ? { cell: { ...base, v: num.n }, refused: false } : { cell: base, refused: true }
  }
  return { cell: orNull(base), refused: false }
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
}

const FORMAT_KINDS: FormatKind[] = ['general', 'number', 'currency', 'percent', 'date', 'text']

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
            : t('Text')

/** A quantity for the preview when the cell is empty — something with a shape. */
const SAMPLE = 1234.5

const valueType = (v: unknown): ColumnType =>
  typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'text'

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
  const custom = isCustomPattern(fmt)
  const choice: FormatChoice = {
    ...classifyFormat(fmt),
    ...(fmt ? {} : { symbol: localeSymbol(ctx.locale) }),
  }
  if (!fmt) choice.kind = 'general'

  const write = (next: string | undefined): void => {
    if (readOnly) return
    const r = formatPatch(sheet, keys, next)
    if (r.patch) ctx.commit(r.patch)
    ctx.say(r.refused
      ? t('{n} value(s) could not be read as this format, and were left as they are.')
        .replace('{n}', String(r.refused))
      : '')
  }

  const kinds: Array<readonly [string, string]> = [
    ...FORMAT_KINDS.map((k) => [k, kindLabel(k)] as const),
    ...(custom ? [['custom', t('Custom')] as const] : []),
  ]
  const kindSel = kit.select(kinds, custom ? 'custom' : choice.kind, (v) => {
    if (v === 'custom') return            // a hand-written pattern is not ours to respell
    const kind = v as FormatKind
    // A cell that had no format takes the preset's own defaults; one that had
    // a format keeps the decimals its author chose.
    write(buildPattern({ ...choice, ...(fmt ? {} : defaultsFor(kind)), kind }))
  })
  kindSel.disabled = readOnly
  kit.row(host, t('Format'), kindSel)

  const numeric = !custom &&
    (choice.kind === 'number' || choice.kind === 'currency' || choice.kind === 'percent')

  if (numeric) {
    const dp = kit.number(choice.dp, 1, (v) =>
      write(buildPattern({ ...choice, dp: Math.max(0, Math.min(9, Math.round(v))) })))
    dp.min = '0'
    dp.max = '9'
    dp.disabled = readOnly
    kit.row(host, t('Decimals'), dp)

    const grp = kit.check(choice.group, (v) => write(buildPattern({ ...choice, group: v })))
    grp.disabled = readOnly
    kit.row(host, t('Thousands separator'), grp)

    if (choice.kind === 'currency') {
      const sym = kit.text(choice.symbol, (v) =>
        write(buildPattern({ ...choice, symbol: v.trim() || choice.symbol })))
      sym.disabled = readOnly
      sym.classList.add('dp-narrow')
      kit.row(host, t('Symbol'), sym)
    }
  }

  // THE ESCAPE HATCH, and it is not a lesser control: format.ts accepts any
  // Excel-ish pattern and the presets are only the six people ask for by name.
  const pat = kit.text(fmt ?? '', (v) => {
    const next = v.trim()
    if (next === (fmt ?? '')) return
    write(next || undefined)
  })
  pat.placeholder = '#,##0.00'
  pat.classList.add('dp-mono')
  pat.disabled = readOnly
  kit.row(host, t('Pattern'), pat)

  // What the pattern DOES, against this cell's own value. The one control that
  // answers "why does my number look like that" without a save and a reload.
  const shownVal = cell?.v === undefined || cell.v === '' ? SAMPLE : cell.v
  const prev = document.createElement('div')
  prev.className = 'dc-preview'
  prev.textContent = formatValue(shownVal, { type: valueType(shownVal), format: fmt })
  if (cell?.v === undefined || cell.v === '') prev.classList.add('dc-preview-sample')
  prev.style.textAlign = (cell?.align as string | undefined) ?? alignFor(valueType(shownVal))
  kit.row(host, t('Shows as'), prev)

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
  // which is where its cell types are decided and is meaningless on a dataset.
  buildAppearanceSection({ host, kit, cell: cell as Appearance | undefined, readOnly, write: style })

  if (ctx.message) kit.note(host, ctx.message)
}
