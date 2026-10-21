// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Turning a stored value into the string a reader sees.
//
// THE LINE THIS FILE DRAWS, because PLATFORM §8 does not draw it yet:
//
//   The number FORMAT is DOCUMENT data — the author chose two decimal places
//   and a pound sign, and everyone who opens the file must see the same thing,
//   or two people reading one board disagree about what it says.
//
//   The GROUPING and DECIMAL GLYPHS are VIEWER chrome, the same rule locale
//   already follows everywhere else in Bento. A German reader of a British
//   author's workbook should see 1.234,50 for the value the author formatted
//   as #,##0.00 — same number, same precision, their own separators.
//
// So the format string says WHAT to show and the viewer's locale says HOW to
// punctuate it. Getting this backwards either freezes one reader's separators
// into everyone else's file, or lets the author's chosen precision drift.

import type { Column, ColumnType } from './model.ts'
import { intlLocale } from './i18n.ts'

/**
 * Viewer-scoped, never in the document.
 *
 * PULLED, not pushed. This used to be a module variable somebody had to
 * remember to set, and nobody ever did: it stayed `undefined` for the life of
 * the app, `Intl` fell through to the browser, and choosing French in About
 * gave French chrome above English-punctuated numbers. Pushing it from the
 * language picker would have fixed that one call site and left the next one —
 * `window.bento.i18n.setLocale` reaches the kernel directly and never passes
 * through the app's facade at all. Asking at format time cannot go out of step
 * with the answer.
 *
 * The override survives for tests, which need a locale without a global.
 */
let viewerLocale: string | undefined

export const setViewerLocale = (l: string | undefined): void => { viewerLocale = l }

const forNumbers = (): string | undefined => viewerLocale ?? intlLocale()

/**
 * The VIEWER's decimal separator — '.' or ','. What a typist means by `1,234`
 * (import.ts `readEntryNumber` asks this to break a tie only a single value
 * can have), and the separator the formula bar writes a number back with, so
 * that what it shows is what the same person would type to get it again.
 */
export function viewerDecimal(): '.' | ',' {
  try {
    const part = new Intl.NumberFormat(forNumbers()).formatToParts(1.5).find((p) => p.type === 'decimal')
    return part?.value === ',' ? ',' : '.'
  } catch {
    return '.'
  }
}

/**
 * A number written the way a person would TYPE it, in the viewer's own
 * separators: no grouping, as many digits as the value needs (15 significant,
 * or 17 when 15 would not read back as the same double), and at least `minDp`
 * decimals. The formula bar's half of "show what was entered".
 */
export function typedNumber(n: number, minDp = 0): string {
  let digits = 15
  if (Number(n.toPrecision(15)) !== n) digits = 17
  const fmt = (sig: number) => new Intl.NumberFormat(forNumbers(), {
    useGrouping: false,
    maximumSignificantDigits: sig,
  }).format(n)
  let out = fmt(digits)
  if (minDp > 0) {
    // pad to the format's decimals: `$300.5` under `$#,##0.00` reads `$300.50`
    const dec = viewerDecimal()
    const at = out.indexOf(dec)
    const have = at < 0 ? 0 : out.length - at - 1
    if (have < minDp) out = (at < 0 ? out + dec : out) + '0'.repeat(minDp - have)
  }
  return out
}

/**
 * What an Excel-style pattern means, and the ONE place that decides it.
 *
 * Exported because `TEXT(value, "#,##0.00")` is the same question a column's
 * format field asks, and answering it twice is a bug with a delay on it: the
 * two readings agree on the day they are written and drift on the first edit,
 * after which a column and a formula print the same number differently on the
 * same screen. See `formatNumber`, which is the whole of TEXT.
 *
 * We support the part people actually write — a currency prefix, thousands
 * grouping, and a fixed number of decimals — and ignore the rest rather than
 * pretending. `digits` reports whether the pattern said anything about digits
 * AT ALL, which is what tells a number pattern from a date one (`dd/mm/yyyy`
 * has no `0` and no `#` in it). A caller that cannot format dates needs to
 * REFUSE one rather than print the value unchanged and look like it worked.
 */
export function readPattern(fmt: string | undefined): {
  prefix: string; suffix: string; group: boolean; dp: number | null; pct: boolean
  digits: boolean
} {
  if (!fmt) return { prefix: '', suffix: '', group: false, dp: null, pct: false, digits: false }
  const pct = fmt.includes('%')
  const body = fmt.replace('%', '')
  const m = body.match(/[#0][#0,]*(?:\.0+)?/)
  const digits = m?.[0] ?? ''
  const at = m ? body.indexOf(digits) : -1
  const dot = digits.indexOf('.')
  return {
    prefix: at >= 0 ? body.slice(0, at) : '',
    suffix: at >= 0 ? body.slice(at + digits.length) : '',
    group: digits.includes(','),
    // `null` means "decide from the value" (0 for an integer, 2 otherwise) and
    // is right ONLY when the pattern says nothing about digits at all. A
    // pattern with digits and no decimal point says something very definite —
    // NO decimals — and answering `null` there made "#,##0" print 1,234.50 and
    // "0" print 7.60. Formatting a column as a whole number has never worked on
    // either kind of sheet; Excel rounds, and so do we now.
    dp: dot >= 0 ? digits.length - dot - 1 : (digits ? 0 : null),
    pct,
    digits: digits !== '',
  }
}

/**
 * Assemble the digits. `Intl` does the punctuation, so the VIEWER's separators
 * apply to the AUTHOR's precision — the split this file exists to make.
 */
function assemble(
  shown: number, p: ReturnType<typeof readPattern>, dp: number, group: boolean,
): string {
  const body = new Intl.NumberFormat(forNumbers(), {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
    useGrouping: group,
  }).format(shown)
  return `${p.prefix}${body}${p.suffix}${p.pct && !p.suffix ? '%' : ''}`
}

/**
 * A number under an explicit pattern, with no column to ask about defaults.
 *
 * This is `TEXT(value, format)` and nothing else, which is why it lives here
 * rather than in formula.ts: it is the same engine the column panel drives, so
 * `TEXT(A1, "#,##0.00")` and a column formatted `#,##0.00` can never disagree
 * about what that string means.
 *
 * The pattern is REQUIRED, so none of `formatValue`'s type-shaped defaults
 * apply: a caller who wrote a pattern said what they wanted. What is still
 * inferred is the one thing the pattern genuinely leaves open — a pattern with
 * no decimal point at all (`readPattern` returns `dp: null` only when there
 * were no digit placeholders either, which `TEXT` refuses before it gets here).
 */
export function formatNumber(n: number, fmt: string): string {
  const p = readPattern(fmt)
  const shown = p.pct ? n * 100 : n
  return assemble(shown, p, p.dp ?? (shown % 1 === 0 ? 0 : 2), p.group)
}

/** Format one value for display. Never mutates, never throws. */
export function formatValue(v: unknown, col: Pick<Column, 'type' | 'format'>): string {
  if (v == null || v === '') return ''
  const t: ColumnType = col.type
  if (t === 'bool') return v ? '✓' : ''
  if (t === 'date') return String(v)
  if (t === 'text' || t === 'enum') return String(v)

  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return String(v)

  const p = readPattern(col.format)
  const isPct = p.pct || t === 'percent'
  const shown = isPct ? n * 100 : n
  // Intl.NumberFormat throws for more than 100 fraction digits, so a format
  // string like "0.000…" (long enough) would break the never-throws contract.
  const rawDp = p.dp ?? (t === 'money' ? 2 : isPct ? 0 : shown % 1 === 0 ? 0 : 2)
  const dp = Math.max(0, Math.min(100, rawDp))

  // GROUPING IS A PROPERTY OF THE COLUMN, never of one value. A plain number
  // used to group from 10,000 up, so one column printed `8600` beside `24,800`.
  // With no pattern, Money groups (as currency always does) and a plain number
  // does not — Excel's, Sheets' and Numbers' General, and the only rule that
  // cannot print a year as 2,026. A pattern with `#,##0` groups everything.
  const group = p.group || (!col.format && t === 'money')
  // A percent COLUMN prints a `%` even with no pattern saying so, which
  // `assemble` cannot know from the pattern alone — so the sign is appended
  // here when the type, rather than the pattern, is what asked for it.
  const out = assemble(shown, p, dp, group)
  return isPct && !p.pct && !p.suffix ? `${out}%` : out
}

/**
 * A value as a LIST shows it — a filter checklist, the pivot's filter list.
 *
 * A quantity prints the way its column prints it: a money column's box says
 * £4,300 because the cell above it says £4,300, and a checklist that said 4300
 * asked the reader to translate between two spellings of one number on one
 * screen. Everything else prints as stored. `formatValue` is NOT used for those
 * on purpose: it prints `false` in a Yes/No column as '' — the empty label the
 * "(Blanks)" box owns — and a list must never offer two boxes that read alike.
 */
export function listLabel(v: unknown, col: Pick<Column, 'type' | 'format'> | undefined): string {
  if (v == null) return ''
  const t = col?.type
  if (col && (t === 'number' || t === 'money' || t === 'percent')) {
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n) && String(v).trim() !== '') return formatValue(n, col)
  }
  return String(v)
}

/** Right-align anything that is a quantity; left-align anything that is a word. */
export const alignFor = (t: ColumnType): 'left' | 'right' =>
  t === 'number' || t === 'money' || t === 'percent' ? 'right' : 'left'

export const TYPE_LABEL: Record<ColumnType, string> = {
  text: 'Text', number: 'Number', money: 'Money',
  percent: 'Percent', date: 'Date', bool: 'Yes/No', enum: 'Category',
}

/** A column total, as the Total picker and the totals menu name it. English
 *  here, translated at render time — the model words (`avg`) are not words a
 *  reader should have to decode. */
export const AGG_WORD: Record<'sum' | 'avg' | 'count' | 'min' | 'max', string> = {
  sum: 'Sum', avg: 'Average', count: 'Count', min: 'Minimum', max: 'Maximum',
}

/** …and as the footer cell labels its own number, where there is room for a
 *  short word only. Same keys, the catalogs' short forms ("Mittelw."). */
export const AGG_SHORT: Record<'sum' | 'avg' | 'count' | 'min' | 'max', string> = {
  sum: 'sum', avg: 'avg', count: 'count', min: 'min', max: 'max',
}
