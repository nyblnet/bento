// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Filtering and multi-key sort — VIEW state, never document state.
//
// Everything here produces an ORDER VECTOR: the row indices that are visible,
// in the order they are shown. `store.view()` swaps it in, emits an
// invalidation and takes no checkpoint (store.ts:494) — so filtering and
// sorting do not dirty the file, do not enter undo history and do not mint a
// collaboration op. Writing the first sort as a `commit` is the easy mistake,
// and nobody notices until a workbook saves itself every time somebody clicks
// a column header.
//
// FOUR THINGS ARE WRONG IN EVERY NAIVE IMPLEMENTATION, and every one of them is
// silent — the grid still paints, the rows still look like rows:
//
//   1. LEXICAL COMPARISON OF NUMBERS. "9" < "10" is FALSE as text and TRUE as
//      arithmetic. A column that arrived as strings — every CSV column before
//      it is typed, every column import declined to type — then sorts
//      1, 10, 100, 2 and a "less than 10" filter hides the 9. Comparison here
//      reads BOTH sides and compares numerically when both are numbers — and
//      REFUSES when only one of them is, because as text "1 unit" is less than
//      "10" and "50%" is greater than "1", and neither answer means anything.
//   2. A BLANK THAT IS "SMALLEST". `Number(null)` is 0 and `null < 5` is true
//      in JavaScript, so a naive filter files every empty cell under "less than
//      5" and a naive sort stacks them all at the top. A blank is not the
//      smallest value, it is NOT A VALUE: blanks never satisfy an ordering
//      comparison, and they SINK in ascending and descending alike. Excel does
//      this too, and the grid's first sort already did it (grid.ts:241).
//   3. A CHECKBOX LIST THAT WILL NOT TICK. The list is built from the values in
//      the column and then matched with `Set.has`, which is identity — so a set
//      holding the number 10 does not match the cell holding "10", and a box
//      the user just ticked filters its own rows away. Membership here matches
//      on the same canonical key the list was DEDUPED by, so the round trip
//      holds by construction.
//   4. A TOP-N THAT RANKS THE WRONG POPULATION. "Top 3" means top 3 of what is
//      left after the other filters, not the top 3 of the whole column
//      intersected with them — those differ, and the second silently returns
//      fewer rows than asked for (often none). Rank predicates are applied
//      LAST, over the survivors.
//
// Nothing here touches the DOM or the document: pure functions over a `get`
// accessor, so the whole surface is provable in node.

/**
 * What a filter menu offers.
 *
 * `topN`/`bottomN` are in the same union as the rest because a filter menu
 * offers them in the same list — but they are the only ones that cannot be
 * answered for one row in isolation (see `needsWholeColumn`).
 */
export type Predicate =
  | { op: 'equals'; v: unknown }
  | { op: 'notEquals'; v: unknown }
  | { op: 'contains'; v: string }
  | { op: 'notContains'; v: string }
  | { op: 'startsWith'; v: string }
  | { op: 'endsWith'; v: string }
  | { op: 'greater'; v: unknown }
  | { op: 'less'; v: unknown }
  | { op: 'greaterOrEqual'; v: unknown }
  | { op: 'lessOrEqual'; v: unknown }
  /** Inclusive both ends. A blank bound is unbounded on that side. */
  | { op: 'between'; lo: unknown; hi: unknown }
  | { op: 'isBlank' }
  | { op: 'notBlank' }
  /** The Excel checkbox list. `null` in the set is the "(Blanks)" box. */
  | { op: 'isOneOf'; set: Set<unknown> }
  | { op: 'topN'; n: number }
  | { op: 'bottomN'; n: number }

export interface ColumnFilter {
  col: string
  pred: Predicate
}

/** Read one row of one column. The grid's is `readCell(sheet.data[col], row)`. */
export type Get = (col: string, row: number) => unknown

/**
 * A rank predicate needs the whole column, so a caller that evaluates row by
 * row has to ask before it starts rather than discovering it in a `catch`.
 */
export const needsWholeColumn = (
  p: Predicate,
): p is { op: 'topN'; n: number } | { op: 'bottomN'; n: number } =>
  p.op === 'topN' || p.op === 'bottomN'

// --- Values ----------------------------------------------------------------

/**
 * A blank is null, undefined, or whitespace. NOT zero and NOT false: those are
 * answers, and a filter that swept them into "(Blanks)" would be hiding data
 * the author entered on purpose.
 */
export const isBlank = (v: unknown): boolean =>
  v == null || (typeof v === 'string' && v.trim() === '')

/**
 * The digit shape a string has to have to be READ as a number.
 *
 * Deliberately strict, and deliberately NOT `Number(s)`:
 *   - `Number('')` is 0, which is how a blank becomes a zero.
 *   - `Number('  ')` is 0 as well.
 *   - `Number('2026-01-15')` is NaN, which is the one piece of luck here — an
 *     ISO date must stay text, because ISO dates sort chronologically AS TEXT
 *     and that is the entire reason import.ts stores them that way.
 *   - a percent-notated string is NOT read as a number: the stored value of a
 *     percent column is the fraction (import.ts:281), so reading "50%" as 50
 *     would compare it against a stored 0.5 and every comparison in that
 *     column would be wrong by a factor of a hundred.
 */
const NUMERIC = /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)$/

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (s === '' || !NUMERIC.test(s)) return null
  const n = Number(s.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * Which order a value belongs to. Numbers and text are different KINDS, and
 * mixing them is what makes a comparison arbitrary rather than merely wrong:
 * as text, "1 unit" is LESS THAN "10" and "50%" is GREATER THAN "1". Both
 * answers are meaningless, and both look like a working filter.
 */
const kind = (v: unknown): 'n' | 't' => (asNumber(v) === null ? 't' : 'n')

/** Text form. `String(null)` is "null", which would match a `contains` of "u". */
const text = (v: unknown): string => (v == null ? '' : String(v))

/** Case- and whitespace-insensitive text, which is what a person means. */
const key = (v: unknown): string => text(v).trim().toLowerCase()

/**
 * The ONE canonical key that both dedupes the checkbox list and matches it, so
 * a ticked box cannot fail to match its own rows.
 *
 * Numbers canonicalise through their numeric value, so 10, "10", " 10 " and
 * "10.0" are one entry and one match. Text canonicalises case-insensitively,
 * which is how the filter compares text everywhere else — the alternative is a
 * list with "North" and "north" as two boxes that filter identically.
 */
export function matchKey(v: unknown): string {
  if (isBlank(v)) return '\u0000blank'
  const n = asNumber(v)
  return n === null ? `t:${key(v)}` : `n:${n}`
}

/**
 * The key of the "(Blanks)" box.
 *
 * Exported because the MENU has to be able to NAME that box: the list carries
 * `null` for it, and a menu that keyed its tickboxes by `String(value)` would
 * key this one "null" and then never find it again in the list it had just
 * built. One spelling of the sentinel, in one place. (It is NUL-prefixed rather
 * than space-prefixed so that a column literally holding the text "blank"
 * cannot land on it.)
 */
export const BLANK_KEY = matchKey(null)

/**
 * Total order over cell values, used by sorting and by every ordering
 * predicate. TYPE-AWARE by inspection, because a column's declared type does
 * not survive into the values — a `text` column full of digits still has to
 * sort 9 before 10.
 *
 * Text is compared case-insensitively by code unit rather than by
 * `localeCompare`. Collation is viewer chrome elsewhere in Bento, but a row
 * ORDER that changed with the reader's locale would mean two people looking at
 * one shared workbook disagree about which row is third — and the order vector
 * is also what a top-N cut is taken from.
 *
 * A NUMBER SORTS BEFORE TEXT when a column holds both, which is Excel's order
 * and the only one that is stable: comparing 10 against "n/a" as strings puts
 * the number wherever its digits happen to fall, so adding a row of notes
 * reshuffles the numbers around them. Sorting needs a total order over
 * everything; ORDERING PREDICATES do not, and they refuse the mixed case
 * instead (see `ord`).
 *
 * Blanks are NOT handled here: they are not values, so they have no place in a
 * value order. Callers deal with them first (`buildOrder` sinks them, the
 * predicates refuse them).
 */
export function compare(a: unknown, b: unknown): number {
  const x = asNumber(a)
  const y = asNumber(b)
  if (x !== null && y !== null) return x < y ? -1 : x > y ? 1 : 0
  if (x !== null) return -1
  if (y !== null) return 1
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1
  }
  const s = key(a)
  const t = key(b)
  return s < t ? -1 : s > t ? 1 : 0
}

// --- Predicates ------------------------------------------------------------

/** Equality is `compare` at zero, so "10" equals 10 and "North" equals "north". */
function eq(v: unknown, target: unknown): boolean {
  if (isBlank(target)) return isBlank(v)
  if (isBlank(v)) return false
  return compare(v, target) === 0
}

/**
 * An ordering test.
 *
 * A blank on EITHER side fails: a blank cell is not greater than 5 and not
 * less than 5, and "greater than nothing" is not a question.
 *
 * A KIND MISMATCH fails too. "Less than 10" over a column with "n/a" and
 * "1 unit" in it is a NUMBER filter, and a number filter must not match text —
 * Excel's number filters behave this way, and the alternative is the arbitrary
 * answer text comparison gives ("1 unit" sorts before "10", so the naive
 * implementation shows it). The same rule read the other way is what makes
 * "after M" work on a column of names.
 */
function ord(v: unknown, target: unknown, test: (c: number) => boolean): boolean {
  if (isBlank(v) || isBlank(target)) return false
  if (kind(v) !== kind(target)) return false
  return test(compare(v, target))
}

/**
 * Does one value pass one predicate?
 *
 * THROWS on `topN`/`bottomN` rather than answering. Both plausible answers are
 * a lie in the shape of a filter: `true` shows every row and `false` shows
 * none, and either one looks like a working filter with surprising data. Ask
 * `needsWholeColumn` first, or route through `buildOrder`, which ranks.
 *
 * `isOneOf` here rescans the set for every call — correct, and O(set) per row.
 * `buildOrder` pre-keys the set once instead; it is the hot path.
 */
export function passes(value: unknown, pred: Predicate): boolean {
  switch (pred.op) {
    case 'isBlank': return isBlank(value)
    case 'notBlank': return !isBlank(value)
    case 'equals': return eq(value, pred.v)
    // a blank cell DOES "not equal" 5 — Excel agrees, and the alternative
    // makes equals/notEquals fail to partition the rows
    case 'notEquals': return !eq(value, pred.v)
    case 'contains': return key(value).includes(key(pred.v))
    case 'notContains': return !key(value).includes(key(pred.v))
    case 'startsWith': return key(value).startsWith(key(pred.v))
    case 'endsWith': return key(value).endsWith(key(pred.v))
    case 'greater': return ord(value, pred.v, (c) => c > 0)
    case 'less': return ord(value, pred.v, (c) => c < 0)
    case 'greaterOrEqual': return ord(value, pred.v, (c) => c >= 0)
    case 'lessOrEqual': return ord(value, pred.v, (c) => c <= 0)
    case 'between': {
      if (isBlank(value)) return false
      const bothWays = !isBlank(pred.lo) && !isBlank(pred.hi)
      // a menu with two boxes will be typed into in either order, and
      // "between 100 and 10" plainly means the range 10..100
      const flip = bothWays && compare(pred.lo, pred.hi) > 0
      const lo = flip ? pred.hi : pred.lo
      const hi = flip ? pred.lo : pred.hi
      // an empty box is an OPEN end, not an empty result: clearing the upper
      // bound widens the filter, and clearing both constrains nothing. The
      // alternative — an unfilled range matching no rows — empties the grid
      // the moment the menu opens, which reads as a broken app rather than as
      // a filter waiting for its bounds.
      if (!isBlank(lo) && (kind(value) !== kind(lo) || compare(value, lo) < 0)) return false
      if (!isBlank(hi) && (kind(value) !== kind(hi) || compare(value, hi) > 0)) return false
      return true
    }
    case 'isOneOf': {
      const k = matchKey(value)
      for (const x of pred.set) if (matchKey(x) === k) return true
      return false
    }
    case 'topN':
    case 'bottomN':
      throw new Error(
        `"${pred.op}" ranks a whole column and cannot be judged one row at a ` +
        'time; use buildOrder (needsWholeColumn reports this)',
      )
  }
}

// --- The order vector ------------------------------------------------------

/**
 * Narrow `keep` to the n highest (or lowest) values in `vals`.
 *
 * TIES ARE KEPT, so this can return more than n rows: the cut is a THRESHOLD,
 * not a count. With four rows at 100 and a "top 3", dropping one of them is a
 * coin flip the reader cannot see and cannot appeal — and a top-3 that shows
 * four rows explains itself, while a top-3 that dropped Tuesday does not.
 *
 * Blanks never rank. A blank has no position in an ordering, so it is not in
 * the top and not in the bottom.
 */
function rankFilter(
  keep: number[],
  vals: unknown[],
  pred: { op: 'topN' | 'bottomN'; n: number },
): number[] {
  const n = Math.floor(pred.n)
  // RANK ONLY WHAT CAN BE RANKED. compare() puts text after numbers by design
  // — that is right for sorting, where every row must land somewhere — but
  // "top 5" over a column holding one stray "n/a" then returns the text rows
  // and HIDES every real number. A rank filter is a question about magnitude,
  // so a value with no magnitude is not a candidate. Blanks were already
  // excluded for exactly this reason; text is the same case wearing a
  // different coat. (condfmt.ts's topNMask reaches the same conclusion.)
  const present = keep.filter((i) => !isBlank(vals[i]) && rankable(vals[i]))
  // "top 0" is nothing. Treating a non-positive n as "no filter" would show
  // every row for a filter the user believes they applied.
  if (!(n > 0)) return []
  if (present.length <= n) return present
  const ranked = present.slice().sort((a, b) => compare(vals[a], vals[b]))
  const cut = pred.op === 'topN'
    ? vals[ranked[ranked.length - n]]
    : vals[ranked[n - 1]]
  return present.filter((i) => (pred.op === 'topN'
    ? compare(vals[i], cut) >= 0
    : compare(vals[i], cut) <= 0))
}

/** Can this value carry a rank? Numbers and numeric strings can; words cannot. */
function rankable(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v === 'boolean') return true
  if (typeof v === 'string') {
    const t = v.trim()
    return t !== '' && Number.isFinite(Number(t.replace(/[,\s£$€¥%]/g, '')))
  }
  return false
}

/**
 * The visible row indices, in order — what `store.order[sheetId]` holds and
 * what `grid.ts ridAt` reads through.
 *
 * Indices are POSITIONS, 0-based, in the sheet's own row order; the grid turns
 * one into a rid. A filtered grid must size its scroller from `order.length`
 * and NOT from the sheet's row count, or it reserves space for rows it is not
 * going to draw.
 *
 * FILTERS AND with each other, rank predicates run last over the survivors,
 * then the sort keys apply in order. A filter naming a column `get` does not
 * know reads as all-blank, which hides everything — callers drop filters whose
 * column was removed rather than leaving the user with an empty grid and no
 * explanation.
 */
export function buildOrder(
  rows: number,
  get: Get,
  filters: ColumnFilter[],
  sorts: Array<{ col: string; dir: 'asc' | 'desc' }>,
): number[] {
  if (!(rows > 0)) return []

  // One pass per column instead of a `get` call per comparison: a sort
  // comparator runs O(n log n) times, so reading through the encoding inside it
  // would walk the same run-length rid table and re-index the same dictionary
  // entry thousands of times. Measured at 100k rows with one filter and two
  // sort keys: 49 ms — a click, not a frame, and it is a click.
  const cache = new Map<string, unknown[]>()
  const column = (c: string): unknown[] => {
    let a = cache.get(c)
    if (!a) {
      a = new Array<unknown>(rows)
      for (let i = 0; i < rows; i++) a[i] = get(c, i)
      cache.set(c, a)
    }
    return a
  }

  const tests: Array<(row: number) => boolean> = []
  for (const f of filters) {
    if (needsWholeColumn(f.pred)) continue
    const vals = column(f.col)
    if (f.pred.op === 'isOneOf') {
      // pre-keyed once: the checkbox list can hold a thousand entries, and
      // rescanning it per row is a thousand string builds per row
      const keys = new Set<string>()
      for (const x of f.pred.set) keys.add(matchKey(x))
      tests.push((row) => keys.has(matchKey(vals[row])))
    } else {
      const p = f.pred
      tests.push((row) => passes(vals[row], p))
    }
  }

  let keep: number[] = []
  outer: for (let i = 0; i < rows; i++) {
    for (const t of tests) if (!t(i)) continue outer
    keep.push(i)
  }

  // LAST, and over the survivors: "top 3" means top 3 of what is left.
  for (const f of filters) {
    if (needsWholeColumn(f.pred)) keep = rankFilter(keep, column(f.col), f.pred)
  }

  if (sorts.length) {
    const keys = sorts.map((s) => ({
      vals: column(s.col),
      sign: s.dir === 'desc' ? -1 : 1,
    }))
    keep.sort((a, b) => {
      for (const k of keys) {
        const x = k.vals[a]
        const y = k.vals[b]
        const bx = isBlank(x)
        const by = isBlank(y)
        // NOT multiplied by sign: blanks sink in both directions, because a
        // blank is not "smallest", it is "not a value"
        if (bx !== by) return bx ? 1 : -1
        if (bx) continue // tied on this key; the next one decides
        const c = compare(x, y)
        if (c !== 0) return c * k.sign
      }
      // MULTI-KEY, and this is where a single-key implementation loses the
      // second key silently: it returns 0 here and lets the engine's stability
      // decide, which looks sorted and is not.
      return a - b
    })
  }
  return keep
}

// --- The menu --------------------------------------------------------------

export interface Distinct {
  /** first-seen originals, in sort order; `null` last if any row is blank */
  values: unknown[]
  /** the column has MORE distinct values than `cap` and this list is partial */
  truncated: boolean
}

/**
 * How to narrow the list before it is built.
 *
 * `rows` IS THE INTERESTING ONE, and it is the whole of Excel's autofilter
 * semantics in one field: the list a column offers is built from the rows the
 * OTHER columns' filters left, so that after "Region = North" the Stage list
 * holds the stages that occur in the North and not the six that do not. The
 * caller passes the order vector it would get from `buildOrder` with THIS
 * column's own filter dropped — its own filter must not narrow its own list, or
 * unticking a value would delete its box and it could never be ticked back.
 *
 * `match` is the search box, and it exists because of the cap: with 50,000
 * distinct values no list can show them all, and a menu that stops at 1,000
 * tells the reader their value is not in the column. Searching RE-SCANS the
 * column rather than filtering the 1,000 already on screen, so a value at
 * position 40,000 is reachable — which is the difference between a capped list
 * and a broken one.
 */
export interface DistinctOpts {
  /** row indices to consider; absent = every row */
  rows?: number[]
  /** case-insensitive substring the value must contain */
  match?: string
  /**
   * How the list SHOWS a value, when that is not how it is stored (a money
   * column lists £4,300 and stores 4300). A search matches either spelling:
   * the reader types what they can see, and "4,300" finding nothing beside a
   * box that says £4,300 is the same two-spellings problem one step later.
   */
  display?: (v: unknown) => string
}

/**
 * The checkbox list.
 *
 * REPORTS TRUNCATION rather than showing the first `cap` as if they were all of
 * them: a list that quietly stops at a thousand tells the user their value is
 * not in the column when it is, and "tick all" then means something other than
 * all. The cap exists because a near-unique column (an id, a note) has as many
 * entries as it has rows, and no menu can show that.
 *
 * Entries are deduped by `matchKey`, the same key `isOneOf` matches on, so
 * every box in this list ticks its own rows. The value returned is the
 * first-seen ORIGINAL, so the menu shows what is in the column rather than a
 * normalised copy of it.
 *
 * A SEARCH EXCLUDES BLANKS. "(Blanks)" is not a value and contains no
 * substring, so a list narrowed to "nor" that still offered the blank box would
 * be offering something the search did not ask for — and ticking it under a
 * search is how a reader ends up with rows they cannot account for.
 *
 * Measured at 100k rows with 1,000 distinct values: 9 ms to open the menu.
 */
export function distinctValues(
  get: Get,
  col: string,
  rows: number,
  cap = 1000,
  opts: DistinctOpts = {},
): Distinct {
  const seen = new Map<string, unknown>()
  // A MEMO OF RAW VALUES SEEN, and it is what makes this affordable on the
  // sheets dash exists for. `matchKey` trims, lower-cases and concatenates —
  // three allocations per row — and on a 10M-row column with forty distinct
  // values 9,999,960 of those calls re-derive a key that is already in the map.
  // Testing the raw value first hashes the string that is already there and
  // allocates nothing. Measured on 10M rows, forty values: 622 ms → 143 ms.
  //
  // Bounded, because the shape it does NOT help is the near-unique column (an
  // id, a note), where every row is a miss and the memo would grow to one entry
  // per row — a hundred megabytes to answer a question the cap has already
  // given up on. Past the bound it stops growing and stays useful for the
  // values already in it.
  const memoCap = cap * 4
  const memo = new Set<unknown>()
  let blanks = false
  let truncated = false
  // The subset is CLAMPED to the column's length rather than trusted: a stale
  // order vector (a filter built before rows were deleted) would otherwise read
  // past the end and put a phantom blank box in the list.
  const scan = opts.rows ?? null
  const n = scan ? scan.length : rows
  const needle = opts.match ? key(opts.match) : ''
  for (let j = 0; j < n; j++) {
    const i = scan ? scan[j] : j
    if (!(i >= 0 && i < rows)) continue
    const v = get(col, i)
    if (isBlank(v)) {
      // a search asks for values CONTAINING something; a blank contains nothing
      if (needle) continue
      blanks = true
      if (truncated) break
      continue
    }
    if (memo.has(v)) continue
    if (memo.size < memoCap) memo.add(v)
    if (needle && !key(v).includes(needle) &&
      !(opts.display && key(opts.display(v)).includes(needle))) continue
    const k = matchKey(v)
    if (seen.has(k)) continue
    if (seen.size >= cap) {
      truncated = true
      // Past the cap there is one thing left worth learning: whether a blank
      // exists. A list missing its "(Blanks)" box is a filter the user cannot
      // express at all.
      if (blanks || needle) break
      continue
    }
    seen.set(k, v)
  }
  const values = [...seen.values()].sort(compare)
  // "(Blanks)" is always last and never counts against the cap — it is one box
  // however many empty cells there are.
  if (blanks) values.push(null)
  return { values, truncated }
}

export interface Summary {
  /** values PRESENT among the visible rows — the status bar's "Count" */
  count: number
  /** how many of those were numbers: the divisor of `avg`, and the reason a
   *  text column can report a count of 30 and no average */
  numeric: number
  sum: number | null
  avg: number | null
  min: number | null
  max: number | null
  blanks: number
}

/**
 * The status-bar aggregate over the VISIBLE rows — `order`, not the sheet.
 * Summing the whole column while the grid shows a filtered subset is the
 * classic wrong answer here: the number is real, it is just not the number the
 * user selected rows to see.
 *
 * EVERY NUMERIC AGGREGATE IS null WHEN THERE IS NOTHING TO AGGREGATE. The
 * alternatives are all lies with a number's face: `sum` 0 reads as "these add
 * up to nothing", `Math.min()` of an empty list is Infinity, and an average of
 * 0/0 is NaN. A text column has no sum, and saying so is the honest answer.
 *
 * The sum accumulates naively, exactly as formula.ts's SUM does. A status bar
 * that disagrees with the totals row above it — even in the last bits — costs
 * more trust than the drift does, so the two stay identical rather than one
 * being independently more accurate.
 */
export function summarize(get: Get, col: string, order: number[]): Summary {
  let count = 0
  let numeric = 0
  let blanks = 0
  let sum = 0
  let min: number | null = null
  let max: number | null = null
  for (const row of order) {
    const v = get(col, row)
    if (isBlank(v)) { blanks++; continue }
    count++
    const n = asNumber(v)
    if (n === null) continue
    numeric++
    sum += n
    if (min === null || n < min) min = n
    if (max === null || n > max) max = n
  }
  return {
    count,
    numeric,
    sum: numeric ? sum : null,
    avg: numeric ? sum / numeric : null,
    min,
    max,
    blanks,
  }
}
