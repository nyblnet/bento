// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// View conditions: the part of a view's filter that asks a real question.
//
// WHAT WAS MISSING. `ViewFilter` shipped with two keys — `open` and `is` — and
// that is membership and nothing else. "Books published after 2020", "tasks due
// this week", "pages not tagged draft", "title contains onboarding" were all
// unexpressible, on five layouts sitting over a filter that could not ask them.
//
// THE SHAPE, and why it is this one rather than a tree.
//
//  · ONE NEW LIST, `filter.where`, of FLAT clauses, ANDed. Plus one boolean,
//    `filter.any`, that ORs them instead. That is the whole language.
//  · NO NESTING, deliberately, and this is a judgement rather than an omission.
//    A nested group needs a UI that can show, build and unbuild a tree, and a
//    filter nobody can read is worse than one that cannot ask everything — the
//    popover is a phone sheet. "Due this week AND not tagged draft" and "urgent
//    OR overdue" are the two shapes people actually ask for and both are flat.
//    And nesting REMAINS AVAILABLE: another key added later is additive in
//    exactly the way widening a flat list into a tree afterwards would not be.
//  · `open` AND `is` KEEP THEIR MEANING AND THEIR COMBINATION. The result is
//    `open AND is AND (where, combined by all-or-any)`. `any` reaches only the
//    new list, because making it reach `is` would change what an existing file
//    means, and no key already on somebody's disk may change meaning.
//
// WHAT AN OLDER BUILD DOES WITH THIS. It ignores `where` and `any` entirely —
// they are unknown keys, they round-trip untouched, and the view shows a
// SUPERSET of the rows the author asked for. It also SAYS SO: `where` and `any`
// fall out of `unknownFilterKeys` there, and render.ts already turns that into
// "A filter here is newer than this build and was not applied." That is the
// existing trade, unchanged — additivity keeps the rule, honesty says the rule
// was not applied. What must never happen is a silently WRONG set of rows, and
// a superset with a banner over it is not that.
//
// THE SAME RULE ONE LEVEL DOWN, which is the new part. An operator this build
// does not know is NOT a reason to hide rows. `unknownFilterOps` reports it and
// the clause is treated as no constraint — matching `isOpenPhase`'s existing
// precedent ("an UNKNOWN value counts as open… showing one issue too many is
// not a silent loss") and `is`'s ("an empty list is NO CONSTRAINT"). Under
// `any` that inverts: skipping a clause in an OR would make the group NARROWER,
// so an unknown clause there PASSES, which is the same direction — show more,
// never less, and put a banner over it.
//
// NO `eval`, NO `new Function`, AND THAT IS A SECURITY BOUNDARY. A filter comes
// out of a file somebody mailed you, exactly like block html. calc.ts argues
// this at length for arithmetic and the argument is identical here: an
// expression evaluator that reached for the JS parser would hand back precisely
// what sanitize.ts exists to prevent. This is a fixed operator table over typed
// values and it can only ever return a boolean.
//
// DATES NEVER TOUCH `new Date(string)`. A `date` field holds what `<input
// type="date">` holds — `YYYY-MM-DD`, no zone — so comparison is STRING
// comparison, which is chronological for that shape in every timezone on earth.
// The relative windows are built from journal.ts's `todayISO`/`stepDay`, which
// are calendar arithmetic in the READER'S OWN zone. `new Date('2026-01-01')` is
// UTC midnight by spec and therefore the previous day for half the world; it
// does not appear in this file and must not.

import type { SpacesDoc, Page } from './model.ts'
import { fieldByKey, optionOf, type FieldSpec } from './fields.ts'
import { todayISO, stepDay } from './journal.ts'
import { t } from './i18n.ts'

/**
 * The operators. PERMANENT — every one of these ships into files on other
 * people's disks the moment it is released, and the word can never be reused
 * for anything else.
 *
 * Eleven, argued per field type rather than assembled from a wish list:
 *
 *  · `eq` / `ne` — every type. Exact match on the STORED value, because that
 *    is what the picker supplies (a select stores an option id). For a
 *    multi-value field (`labels`) `eq` is MEMBERSHIP and `ne` its negation,
 *    mirroring what `is` already does for arrays rather than inventing a
 *    second spelling of the same question.
 *  · `gt` / `gte` / `lt` / `lte` — `number` and `date`. Numbers compare
 *    numerically; dates compare as ISO strings. "Published after 2020" is
 *    `gt`, "due before Friday" is `lt`. This is why there is no separate
 *    before/after/on: they are these three under other names.
 *  · `contains` / `notContains` — text, and anything with a readable form.
 *    Matches the text a READER SEES (a select's label, a labels list joined),
 *    case-insensitively, because "contains" is a question about what is on the
 *    screen and matching a select's internal id would answer a different one.
 *  · `empty` / `notEmpty` — every type. The one question `is` could never ask:
 *    an unset value is the absence of a value, not one of its values.
 *  · `in` — `date` only, and the relative half of this feature: a WINDOW word
 *    resolved against the reader's today. See `DateWindow`.
 *
 * Negation is `ne`, `notContains`, `notEmpty` and — for a phase — leaving
 * `open` off. There is no `not(...)` wrapper, because a wrapper is nesting.
 */
export type QueryOp =
  | 'eq' | 'ne'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'notContains'
  | 'empty' | 'notEmpty'
  | 'in'

/** Operators this build can evaluate. A Set, so a key out of a mailed file can
 *  never reach a prototype the way a bare object lookup would. */
const OPS: ReadonlySet<string> = new Set<QueryOp>([
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'notContains', 'empty', 'notEmpty', 'in',
])

/** Operators that need no value — the two that ask about absence. */
const NULLARY: ReadonlySet<string> = new Set<QueryOp>(['empty', 'notEmpty'])

/**
 * The relative windows, for `in`.
 *
 * Five words and no arithmetic in the file. "Overdue" is `past` on a due date;
 * "this week" is `week`. A stored `{ op:'lt', v:'2026-09-10' }` would answer
 * the question ONCE, on the day it was written, and be wrong every day after —
 * which is the whole reason a relative window is a stored WORD and the dates
 * are computed at read time.
 */
export type DateWindow = 'today' | 'week' | 'month' | 'past' | 'future'

const WINDOWS: ReadonlySet<string> = new Set<DateWindow>(['today', 'week', 'month', 'past', 'future'])

/** One condition. `v` is absent exactly for `empty`/`notEmpty`. */
export interface Clause {
  /** a field key from `doc.fields`, or `:title` — see `PAGE_KEYS` */
  key: string
  op: QueryOp
  v?: string | number
}

/**
 * Keys that are about the PAGE rather than one of its fields.
 *
 * A colon prefix, because a field key is minted from a label and can never
 * start with one — so `:title` cannot collide with a schema somebody writes,
 * today or in ten years. Exactly one for now: "title contains X" is the
 * question this whole feature was asked for and the title is not a prop block,
 * so no field key could ever reach it.
 */
export const PAGE_KEYS: ReadonlySet<string> = new Set([':title'])

/** What `:title` is called in the field picker. A literal t(), at the call
 *  site — never a map of English read back, which reaches no catalog. */
export const pageKeyLabel = (key: string): string => (key === ':title' ? t('Title') : key)

/**
 * What an operator is called to somebody choosing one.
 *
 * A FUNCTION with literal `t()` calls, exactly like `fieldTypeLabel` and for
 * exactly the reason written there: the extractor sweeps LITERALS, so a map of
 * English read back through `t(MAP[op])` compiles, runs, reaches no catalog,
 * and the packer still reports 100% because it counts what it swept.
 */
export function opLabel(op: string): string {
  switch (op) {
    case 'eq': return t('is')
    case 'ne': return t('is not')
    case 'gt': return t('is after')
    case 'gte': return t('is on or after')
    case 'lt': return t('is before')
    case 'lte': return t('is on or before')
    case 'contains': return t('contains')
    case 'notContains': return t('does not contain')
    case 'empty': return t('is empty')
    case 'notEmpty': return t('is not empty')
    case 'in': return t('is within')
    default: return op
  }
}

/** The same words for a number, where "after" reads as nonsense. */
export function numberOpLabel(op: string): string {
  switch (op) {
    case 'gt': return t('is more than')
    case 'gte': return t('is at least')
    case 'lt': return t('is less than')
    case 'lte': return t('is at most')
    default: return opLabel(op)
  }
}

/** What a window is called. Literal t() at the call site, same rule. */
export function windowLabel(w: string): string {
  switch (w) {
    case 'today': return t('Today')
    case 'week': return t('This week')
    case 'month': return t('This month')
    case 'past': return t('In the past')
    case 'future': return t('In the future')
    default: return w
  }
}

/**
 * The operators worth offering for a field, in the order the picker shows them.
 *
 * Offered, not enforced: a clause naming an operator this type does not list
 * still EVALUATES (a `gt` on a text field compares strings and answers
 * honestly). Narrowing what a picker offers is a kindness to the person
 * building a filter; narrowing what the engine will run would make a filter
 * written by a newer build — or by an agent — stop selecting its own rows.
 */
export function opsFor(vt: string | undefined): QueryOp[] {
  switch (vt) {
    case 'number': return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty']
    case 'date': return ['in', 'eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'empty', 'notEmpty']
    case 'select': return ['eq', 'ne', 'contains', 'empty', 'notEmpty']
    case 'labels': return ['eq', 'ne', 'contains', 'notContains', 'empty', 'notEmpty']
    default: return ['contains', 'notContains', 'eq', 'ne', 'empty', 'notEmpty']
  }
}

/** Every window, in picker order. */
export const DATE_WINDOWS: DateWindow[] = ['today', 'week', 'month', 'past', 'future']

// ---------------------------------------------------------------------------
// reading a filter safely
// ---------------------------------------------------------------------------
//
// Everything below takes `unknown`. A filter arrives inside a document
// somebody mailed you: `where` can be a string, a clause can be null, `op` can
// be a number, and none of that may throw out of a render.

/** The clauses this build can see — shape-checked, nothing else. */
export function clausesOf(filter: unknown): Clause[] {
  if (!filter || typeof filter !== 'object') return []
  const raw = (filter as { where?: unknown }).where
  if (!Array.isArray(raw)) return []
  const out: Clause[] = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const key = (c as { key?: unknown }).key
    const op = (c as { op?: unknown }).op
    if (typeof key !== 'string' || !key || typeof op !== 'string' || !op) continue
    const v = (c as { v?: unknown }).v
    out.push({ key, op: op as QueryOp, v: typeof v === 'string' || typeof v === 'number' ? v : undefined })
  }
  return out
}

/** Is this filter's clause list ORed rather than ANDed? */
export const isAny = (filter: unknown): boolean =>
  !!(filter && typeof filter === 'object' && (filter as { any?: unknown }).any === true)

/**
 * Operators a NEWER build wrote and this one cannot evaluate.
 *
 * The sibling of `unknownFilterKeys`, one level down, and it exists for the
 * same reason: a rule that was not applied means the view shows more than its
 * author asked for, and a count silently too high is the failure additivity
 * trades for. Deduplicated and in file order, so the banner can name them.
 */
export function unknownFilterOps(filter: unknown): string[] {
  const out: string[] = []
  for (const c of clausesOf(filter)) {
    if (!OPS.has(c.op) && !out.includes(c.op)) out.push(c.op)
    // an `in` whose window word is newer is the same failure wearing a known
    // operator's clothes, so it is reported the same way
    else if (c.op === 'in' && !WINDOWS.has(String(c.v)) && !out.includes(`in:${String(c.v)}`)) {
      out.push(`in:${String(c.v)}`)
    }
  }
  return out
}

/** Clauses that narrow something — what the Filter chip counts. */
export const clauseCount = (filter: unknown): number => clausesOf(filter).filter(usable).length

/**
 * Does this clause constrain anything at all?
 *
 * A clause missing its value is the `is: []` case one level down: a half-built
 * condition sitting in a popover must not empty the board for a reason nobody
 * can see. It is not counted and it is not applied.
 */
function usable(c: Clause): boolean {
  if (!OPS.has(c.op)) return false
  if (NULLARY.has(c.op)) return true
  return c.v !== undefined && c.v !== ''
}

/**
 * Which clauses the engine LOOKS AT — a wider set than the one the chip counts,
 * and the difference is load-bearing.
 *
 * A clause with an operator from a newer build narrows nothing HERE, so it is
 * not counted. But dropping it before evaluation is not the same as evaluating
 * it to "cannot say": under `any` a dropped clause is one fewer way through the
 * OR, so the view would show FEWER rows because of a rule nobody can read —
 * the exact failure the whole unknown-operator policy exists to prevent. It
 * stays in the list and `clausePasses` answers `undefined` for it.
 */
const applies = (c: Clause): boolean => !OPS.has(c.op) || usable(c)

// ---------------------------------------------------------------------------
// dates, in the reader's own timezone
// ---------------------------------------------------------------------------

/**
 * The day the week starts on for this reader — 0 Sunday … 6 Saturday.
 *
 * LOCALE-DEPENDENT AND VIEWER-SCOPED, never in the document. "This week" means
 * Monday–Sunday in Berlin and Sunday–Saturday in Chicago, and the same file
 * opened in both places should answer each reader's question — the same rule
 * the whole app already follows for language, date formatting and journal
 * labels (PLATFORM §8). Storing a week-start on the filter would freeze one
 * reader's calendar into everybody else's file.
 *
 * `Intl.Locale.weekInfo` is the browser's own answer where it exists; MONDAY
 * (ISO 8601) is the fallback, which is the majority answer and the one the ISO
 * date this field already stores agrees with.
 */
export function weekStartDay(locale?: string): number {
  try {
    const L = new Intl.Locale(locale || (typeof navigator !== 'undefined' ? navigator.language : 'en'))
    // weekInfo is a getter on some engines and a method on older ones
    const info = (L as unknown as { weekInfo?: { firstDay?: number }; getWeekInfo?: () => { firstDay?: number } })
    const first = (typeof info.getWeekInfo === 'function' ? info.getWeekInfo() : info.weekInfo)?.firstDay
    // Intl numbers Monday 1 … Sunday 7; JS numbers Sunday 0 … Saturday 6
    if (typeof first === 'number' && first >= 1 && first <= 7) return first % 7
  } catch { /* an engine without weekInfo, or a locale it will not parse */ }
  return 1
}

/** An inclusive ISO range. An absent end is unbounded on that side. */
export interface DateRange { from?: string; to?: string }

/**
 * What a window means TODAY, in local calendar terms.
 *
 * `today` is injected rather than read, so the rig is not at the mercy of a
 * clock — the same arrangement `CalcCtx.today` already uses.
 */
export function windowRange(w: string, today = todayISO(), locale?: string): DateRange | undefined {
  switch (w) {
    case 'today': return { from: today, to: today }
    case 'past': return { to: stepDay(today, -1) }
    case 'future': return { from: stepDay(today, 1) }
    case 'week': {
      const [y, m, d] = today.split('-').map(Number)
      // getDay() on a component-built local Date: no parsing, no UTC midnight
      const dow = new Date(y, m - 1, d).getDay()
      const back = (dow - weekStartDay(locale) + 7) % 7
      const from = stepDay(today, -back)
      return { from, to: stepDay(from, 6) }
    }
    case 'month': {
      const [y, m] = today.split('-').map(Number)
      const first = `${y}-${String(m).padStart(2, '0')}-01`
      // day 0 of the NEXT month is the last day of this one — the constructor
      // does month lengths and leap years, which is the one piece of date work
      // worth delegating
      const last = new Date(y, m, 0)
      return { from: first, to: `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}` }
    }
    default: return undefined
  }
}

// ---------------------------------------------------------------------------
// evaluating one clause
// ---------------------------------------------------------------------------

const isEmptyValue = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)

/** The text a READER sees for a value — what `contains` is a question about. */
export function readableOf(f: FieldSpec | undefined, v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => optionOf(f, x)?.label ?? String(x)).join(', ')
  if (isEmptyValue(v)) return ''
  return optionOf(f, v)?.label ?? String(v)
}

/** The stored forms of a value, for exact match. One entry, or one per member. */
const storedOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : isEmptyValue(v) ? [] : [String(v)]

/**
 * Compare a value with a clause's `v`, numerically where the field says so.
 *
 * Returns undefined when the comparison cannot be made — a `gt` against a
 * value that is not a number. That is a real "no", not an unknown: "estimate
 * is more than 3" is false for an issue whose estimate is the word "big".
 */
function cmp(vt: string | undefined, value: unknown, want: string | number): number | undefined {
  if (isEmptyValue(value)) return undefined
  if (vt === 'number') {
    const a = Number(Array.isArray(value) ? NaN : value), b = Number(want)
    if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined
    return a < b ? -1 : a > b ? 1 : 0
  }
  // Dates included, ON PURPOSE: a `date` field holds `YYYY-MM-DD`, whose string
  // order IS its chronological order, in every timezone, with no Date object
  // anywhere near it.
  const a = String(Array.isArray(value) ? value.join(', ') : value)
  const b = String(want)
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Does one value satisfy one clause?
 *
 * `undefined` means THIS BUILD CANNOT SAY — an unknown operator or an unknown
 * window word — which the caller turns into "no constraint" under AND and into
 * "passes" under OR. Both are the same direction: show more, never less, and
 * let the banner say a rule was not applied.
 */
export function clausePasses(
  doc: SpacesDoc, values: Map<string, unknown>, c: Clause, page?: Page, today?: string,
): boolean | undefined {
  if (!OPS.has(c.op)) return undefined
  const field = PAGE_KEYS.has(c.key) ? undefined : fieldByKey(doc, c.key)
  const value = PAGE_KEYS.has(c.key)
    ? (c.key === ':title' ? (page?.title ?? '') : undefined)
    : values.get(c.key)

  if (c.op === 'empty') return isEmptyValue(value)
  if (c.op === 'notEmpty') return !isEmptyValue(value)
  // A half-built condition is already filtered out of the list by `usable`, so
  // this is unreachable through `passesClauses` — it is here for the direct
  // caller, since this function is exported and a UI previewing a clause as it
  // is typed will ask about one before it has a value.
  if (c.v === undefined || c.v === '') return undefined

  switch (c.op) {
    case 'eq': return storedOf(value).includes(String(c.v))
    case 'ne': return !storedOf(value).includes(String(c.v))
    case 'contains':
      return readableOf(field, value).toLowerCase().includes(String(c.v).toLowerCase())
    case 'notContains':
      return !readableOf(field, value).toLowerCase().includes(String(c.v).toLowerCase())
    case 'in': {
      const r = windowRange(String(c.v), today ?? todayISO())
      if (!r) return undefined              // a window word from a newer build
      if (isEmptyValue(value)) return false // an unset date is in no window
      const s = String(value)
      if (r.from && s < r.from) return false
      if (r.to && s > r.to) return false
      return true
    }
    default: {
      const d = cmp(field?.vt, value, c.v)
      if (d === undefined) return false
      return c.op === 'gt' ? d > 0 : c.op === 'gte' ? d >= 0 : c.op === 'lt' ? d < 0 : d <= 0
    }
  }
}

/**
 * Does a row pass a filter's clause list?
 *
 * TRUE when there is nothing to apply — an absent `where`, an empty one, or a
 * list of half-built clauses — because that is the same rule the rest of this
 * filter follows: absent means everything, and so does a constraint that
 * constrains nothing.
 */
export function passesClauses(
  doc: SpacesDoc, values: Map<string, unknown>, filter: unknown, page?: Page, today?: string,
): boolean {
  const list = clausesOf(filter).filter(applies)
  if (!list.length) return true
  if (isAny(filter)) {
    // an unknown clause PASSES here: skipping it would leave fewer ways
    // through an OR, which is the one direction this file never goes
    return list.some((c) => clausePasses(doc, values, c, page, today) !== false)
  }
  return list.every((c) => clausePasses(doc, values, c, page, today) !== false)
}

/**
 * A clause in words, for the popover's list of what is applied.
 *
 * A TRANSLATABLE TEMPLATE rather than a hardcoded join, and that is the whole
 * point of it being a t() string. `${name} ${op} ${value}` in source would pin
 * English word order into every language: Japanese wants the operand before the
 * predicate ("Year が 2020 より大きい"), and a fixed join can only ever produce
 * the English one. The parts are t()'d at their own call sites and the ORDER is
 * the catalogs' to choose.
 */
export function clauseSummary(doc: SpacesDoc, c: Clause): string {
  const f = PAGE_KEYS.has(c.key) ? undefined : fieldByKey(doc, c.key)
  const field = f ? f.label : PAGE_KEYS.has(c.key) ? pageKeyLabel(c.key) : c.key
  const op = f?.vt === 'number' ? numberOpLabel(c.op) : opLabel(c.op)
  if (NULLARY.has(c.op)) return t('{field} {op}', { field, op })
  const value = c.op === 'in' ? windowLabel(String(c.v))
    : f?.options?.length ? (optionOf(f, c.v)?.label ?? String(c.v ?? ''))
      : String(c.v ?? '')
  return t('{field} {op} {value}', { field, op, value })
}
