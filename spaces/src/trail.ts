// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE TRAIL: what was true on a day, written down because the day is over.
//
// THE RULE THIS FILE IS THE EXCEPTION-THAT-IS-NOT-ONE TO. `calc.ts` opens by
// refusing to store an answer, `fields.ts viewRows` refuses to store the rows
// ("a database that keeps its own copy of the rows is a database that disagrees
// with the document"), and `model.ts tableOf` normalises at read time rather
// than by rewriting. The rule underneath all three is narrower than "everything
// derives", and this is it:
//
//     Never store what the current document already implies.
//     Do store an observation it cannot reproduce.
//
// The past is not a function of the present state. No recomputation over
// today's pages answers "how many points were open on 3 September", because the
// only artefact that ever knew is gone. Four members of that class are already
// in the format — `page.created`/`page.edited`, `Comment.at`, `Page.journal`
// (the date a page IS) and, when it lands, `doc.revisions`. Every one is a
// timestamped observation nobody can recompute. (docs/DECISIONS.md, 2026-09-11)
//
// THE FALSIFIABLE HALF, which the charts hold to: the TODAY point is derived
// from live state, and only strictly-earlier days are read from here. Change an
// estimate now and today's point moves immediately, exactly as calc.ts
// promises. The trail is consulted only for days that have closed, where there
// is nothing left to disagree with.
//
// WHAT A ROW MUST NEVER CONTAIN, and this is a budget rule and a privacy rule
// at once: no page ids, no assignee breakdown, no per-issue anything. A "who
// closed what, when" series is the surveillance shape of this feature, it grows
// with the team, and it is excluded ON PURPOSE so a later session does not add
// it as the obvious next step. What a trail DOES disclose, said plainly because
// the field name does not suggest it: the CADENCE. Which days the file was
// touched, which weeks nothing moved, work on a Sunday. That is why a reading
// copy carries none of it (`stripRecord`).
//
// THIS FILE IS A LEAF: types only, no runtime imports. `model.ts` calls
// `foldDottedMapKeys` from inside `parseDoc`, so anything this module imported
// at runtime would be imported by the parser, and the fold is the one piece
// that has to run before anybody else sees the document.
//
// DAY ARITHMETIC IS TIMEZONE-FREE HERE, deliberately and unlike `journal.ts`.
// A row key is a LOCAL day LABEL, minted once at the call site from
// `journal.todayISO()` — the reader's own wall-clock day. Once it is a label,
// turning it back into a local `Date` would reintroduce exactly the ambiguity
// the label exists to have settled (and `new Date('2026-01-01')` is UTC
// midnight, i.e. the previous day for half the planet). So every calculation
// below goes through `dayIndex`, which is UTC ordinal arithmetic on the label
// and cannot drift by a timezone, a DST boundary or a locale.

import type { SpacesDoc } from './model'

/**
 * One day's observation.
 *
 * Keyed by STATUS OPTION ID, not by phase group. There are four groups and six
 * default options; a CFD's bands are the board's columns, which are options —
 * recording groups makes the CFD unbuildable, while recording options keeps it
 * AND keeps burndown, because `FieldOption.group` derives a group from an
 * option at render time. The reverse does not exist. Costs about 1.5× and buys
 * the third chart.
 *
 * Consequence said out loud: the schema can change. An option deleted next
 * month leaves a band in old rows with no label. The chart falls back to the
 * raw id and says it does not know it — the rule `ViewFilter` already states
 * for a value this build has never heard of.
 */
export interface TrailRow {
  /** issues per status option id. Zero-valued options are omitted. */
  n: Record<string, number>
  /** summed estimate per status option id. Absent when nothing is estimated. */
  e?: Record<string, number>
  /** issues counted that carried no estimate, so a points chart can say so. */
  x?: number
  /** days this row stands for after thinning. Absent = 1 = a single day. */
  s?: number
  /** this is the oldest surviving row and older ones were dropped. */
  cut?: true
}

/**
 * `doc.trail`: observation key → what was true that day. A MAP, not an array.
 *
 * A MAP for three reasons, the first of which is not negotiable:
 *
 *  1. COLLABORATION. An array is one last-writer-wins register (the limitation
 *     `table.rows` documents), so two people working on the same day means one
 *     of them loses. A doc-level map declared in `DOC_MAPS` is merged PER KEY
 *     by the CRDT, so Monday's row and Tuesday's row are separate registers and
 *     both survive any interleaving. The SAME day still resolves last-writer-
 *     wins, and that is acceptable here and only here: a row is not authored
 *     content, both replicas are counting over nearly the same document, so LWW
 *     picks one truthful sample rather than losing an edit.
 *  2. "One row per day" becomes an invariant of the SHAPE rather than a rule
 *     somebody has to enforce. A second write on a day overwrites the first, so
 *     a day's row is the last observation of that day — which is also the one a
 *     burndown wants.
 *  3. A row is addressable, so a write is idempotent.
 *
 * KEY: `YYYY-MM-DD`, or `<seriesId>/<YYYY-MM-DD>` when a period charts its own
 * scope. The bare form IS the default series. Shipped now rather than later
 * because the trail is PRE-AGGREGATED: the series is the only mechanism by
 * which two different scopes can ever be charted, and retrofitting it would
 * make every existing bare key mean "the default series" by archaeology.
 */
export type Trail = Record<string, TrailRow>

/**
 * Doc-level keys that are MAPS — merged per key by the CRDT, and folded back
 * out of a dotted top-level key by the parser.
 *
 * ONE list, read by `sync/crdt.ts` (which hands it to the kernel's `shape()`)
 * and by `model.ts parseDoc` (which repairs what a peer running an older shape
 * wrote). Two copies of it is precisely how the mitigation and the hazard drift
 * apart.
 */
export const DOC_MAPS = ['trail', 'periods'] as const

// ---- days -----------------------------------------------------------------

const SHAPE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A REAL day label, not merely a digit-shaped string.
 *
 * `2026-13-99` matches the shape and is not a day; every formatter rolls it
 * over into some OTHER real day and shows a confident wrong answer. The round
 * trip is the check. UTC, not local — see the timezone note at the top: this is
 * arithmetic on a label, and a label has no timezone.
 */
export function isDay(v: unknown): v is string {
  if (typeof v !== 'string' || !SHAPE.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d))
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d
}

const DAY_MS = 86400000

/** Days since the epoch, from the LABEL. Pure, and the same number in Kiritimati
 *  and in Niue — which is the whole point. */
export function dayIndex(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The label `n` days after `iso`. */
export function addDays(iso: string, n: number): string {
  return fromIndex(dayIndex(iso) + n)
}

export function fromIndex(i: number): string {
  const at = new Date(i * DAY_MS)
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
}

/** Inclusive day count from `a` to `b`; negative when `b` precedes `a`. */
export const daysBetween = (a: string, b: string): number => dayIndex(b) - dayIndex(a)

/** Every day label from `from` to `to`, inclusive. Empty when `to` precedes
 *  `from` — a period whose `to` precedes its `from` must not throw and must not
 *  draw something misleading, so it draws nothing. Capped, because the range
 *  comes out of a file somebody mailed you. */
export function dayRange(from: string, to: string, cap = 4000): string[] {
  if (!isDay(from) || !isDay(to)) return []
  const n = daysBetween(from, to)
  if (n < 0) return []
  const out: string[] = []
  for (let i = 0; i <= Math.min(n, cap - 1); i++) out.push(addDays(from, i))
  return out
}

/** The ISO-8601 week a day sits in, as a sortable `YYYY-Www` bucket key.
 *  Monday-based, because that is what "one row per week" means everywhere the
 *  sprint word is used. */
export function weekKey(iso: string): string {
  const i = dayIndex(iso)
  // 1970-01-01 was a Thursday: (i + 3) makes Monday 0.
  const monday = i - ((((i + 3) % 7) + 7) % 7)
  return `w${monday}`
}

/** The month a day sits in. */
export const monthKey = (iso: string): string => iso.slice(0, 7)

// ---- keys ------------------------------------------------------------------

/** The key a row is filed under. */
export const trailKey = (day: string, series?: string): string =>
  series ? `${series}/${day}` : day

export interface TrailAddr { series: string; day: string }

/**
 * A key back into its parts, or null when it is not one this build can read.
 *
 * A key from a NEWER build (a second slash, a shape nobody here knows) is not
 * an error and is never rewritten — it is simply not drawn, and it round-trips
 * untouched like every other unknown thing in this format.
 */
export function parseTrailKey(k: string): TrailAddr | null {
  const at = k.lastIndexOf('/')
  const day = at < 0 ? k : k.slice(at + 1)
  const series = at < 0 ? '' : k.slice(0, at)
  if (!isDay(day)) return null
  if (series.includes('/')) return null
  return { series, day }
}

// ---- reading ---------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * A `trail` that is not an object — some future build gave the name a different
 * shape. It is LEFT ALONE and never written over, which is the rule history
 * states for `revisions` and the rule additivity requires: a field this build
 * cannot read is a field it must not destroy.
 */
export const trailIsForeign = (doc: SpacesDoc): boolean =>
  doc.trail !== undefined && !isObj(doc.trail)

/** The trail in force. `{}` when there is none, and never a key created as a
 *  side effect of asking. */
export function trailOf(doc: SpacesDoc): Trail {
  const raw = doc.trail
  if (!isObj(raw)) return {}
  const out: Trail = {}
  for (const k of Object.keys(raw)) {
    const row = raw[k]
    // `Object.hasOwn` semantics by construction: Object.keys is own-enumerable
    // only, so `trail.toString` from a hand-edited file is never reached.
    if (isObj(row) && isObj(row.n)) out[k] = row as TrailRow
  }
  return out
}

/** One row's total issue count. Malformed and negative entries count as zero —
 *  a row out of a mailed file may say anything, and none of it may throw. */
export function rowTotal(row: TrailRow): number {
  let n = 0
  for (const k of Object.keys(row.n ?? {})) {
    const v = row.n[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) n += v
  }
  return n
}

/** A row's count for one option id, clamped to a real, non-negative number. */
export const countOf = (row: TrailRow, option: string): number => {
  const m = row.n ?? {}
  if (!Object.hasOwn(m, option)) return 0
  const v = m[option]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** A row's summed estimate for one option id, or undefined when this row holds
 *  no estimates at all — which is different from an estimate of zero. */
export function estimateOf(row: TrailRow, option: string): number | undefined {
  const m = row.e
  if (!isObj(m)) return undefined
  if (!Object.hasOwn(m, option)) return 0
  const v = (m as Record<string, unknown>)[option]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** Does this row carry estimates at all? */
export const hasEstimates = (row: TrailRow): boolean => isObj(row.e)

/** How many days a row stands for. Absent = 1. */
export function spanOf(row: TrailRow): number {
  const s = row.s
  return typeof s === 'number' && Number.isFinite(s) && s >= 1 ? Math.floor(s) : 1
}

/** Every row of one series, oldest first. */
export function seriesRows(trail: Trail, series = ''): Array<{ day: string; row: TrailRow }> {
  const out: Array<{ day: string; row: TrailRow }> = []
  for (const k of Object.keys(trail)) {
    const addr = parseTrailKey(k)
    if (!addr || addr.series !== series) continue
    out.push({ day: addr.day, row: trail[k] })
  }
  out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  return out
}

/** The series ids present in a trail. '' is the default series. */
export function seriesIds(trail: Trail): string[] {
  const seen = new Set<string>()
  for (const k of Object.keys(trail)) {
    const addr = parseTrailKey(k)
    if (addr) seen.add(addr.series)
  }
  return [...seen].sort()
}

// ---- writing ---------------------------------------------------------------

/**
 * Write one day's row, in place. Returns false when nothing was written.
 *
 * ONLY EVER TODAY'S KEY. There is no code path here that recomputes a past key
 * — not "recompute the last 7 days", not "repair inconsistent rows". That is
 * the guarantee behind "editing the past does not rewrite it": change an
 * estimate today and yesterday's row cannot move, because nothing addresses it.
 * The one other way a past key is created is `backfill`, below, which refuses
 * to overwrite.
 */
export function writeRow(doc: SpacesDoc, day: string, row: TrailRow, series?: string): boolean {
  if (trailIsForeign(doc) || !isDay(day)) return false
  const trail: Trail = isObj(doc.trail) ? (doc.trail as Trail) : {}
  trail[trailKey(day, series)] = row
  doc.trail = trail
  return true
}

/**
 * Write a PAST key, only if it is absent. Returns false when one was already
 * there.
 *
 * A row, once written, is immutable for the rest of the file's life. The only
 * callers are committing a period whose `from` is in the past and (if
 * `doc.revisions` ever lands) a one-time import from it.
 */
export function backfill(doc: SpacesDoc, day: string, row: TrailRow, series?: string): boolean {
  if (trailIsForeign(doc) || !isDay(day)) return false
  const trail = trailOf(doc)
  if (Object.hasOwn(trail, trailKey(day, series))) return false
  return writeRow(doc, day, row, series)
}

/**
 * Remove the trail. NO KEY, never `trail: {}`.
 *
 * A space that was tracked and then cleared is byte-identical to one that never
 * was — the rule `ViewFilter`, `ViewSource` and the view layout all follow, and
 * the reason "Clear trail" can be offered as a real control rather than as a
 * hide.
 */
export function clearTrail(doc: SpacesDoc): void {
  delete doc.trail
}

/**
 * Take the working record out of a copy that is about to be published.
 *
 * STRIPPED, not offered behind a checkbox. The asymmetry decides it: adding an
 * opt-in later is safe, and un-leaking a team's cadence from files already sent
 * is impossible. A reading copy already loses comments and every collaboration
 * secret on exactly this reasoning; cadence — which days the file was touched,
 * which weeks nothing moved, the stall before the deadline — is the same kind
 * of thing, travelling under a field name nobody would think to look at.
 *
 * DERIVED FROM `DOC_MAPS`, so a third record map added later is covered here
 * without anyone remembering to act. Same discipline as `stripCollabSecrets`.
 */
export function stripRecord(doc: SpacesDoc): void {
  for (const k of DOC_MAPS) delete (doc as Record<string, unknown>)[k]
}

/**
 * Fold a dotted top-level key back into the map it belongs to, in place.
 *
 * THE MIXED-VERSION HAZARD, and its mitigation. A peer running a build whose
 * `DocShape.maps` does not list `trail` receives `set k="trail.2026-09-03"`,
 * fails the kernel's `mapKey()` lookup, and writes a literal top-level key
 * named `"trail.2026-09-03"`. Additivity would then preserve that junk forever.
 * Six lines in a file we own is a better answer than a kernel handshake change:
 * it is cheap, deterministic, self-healing, and it repairs files that were
 * damaged before the fix existed.
 *
 * NEVER OVERWRITES a key the map already holds — the folded value is the one
 * this build could not place, and the placed one is at least as new.
 */
export function foldDottedMapKeys(raw: Record<string, unknown>): number {
  let folded = 0
  for (const k of Object.keys(raw)) {
    const at = k.indexOf('.')
    if (at <= 0) continue
    const field = k.slice(0, at)
    if (!(DOC_MAPS as readonly string[]).includes(field)) continue
    const entry = k.slice(at + 1)
    if (!entry) continue
    const map = isObj(raw[field]) ? (raw[field] as Record<string, unknown>) : {}
    if (!Object.hasOwn(map, entry)) map[entry] = raw[k]
    raw[field] = map
    delete raw[k]
    folded++
  }
  return folded
}

// ---- the budget ------------------------------------------------------------
//
// THE RECORD NEVER OUTWEIGHS WHAT IT IS A RECORD OF.
//
// Two fixed byte ceilings do not scale with the document. 32 KB of trail beside
// 128 KB of history is 160 KB of record: absurd in a 37 KB space, unremarkable
// in a 2 MB one. So there is ONE budget for the whole record, computed from the
// document's own content, and the trail and the history tier independently
// within it.
//
// CONTENT, not file size: `title`, `home`, `theme` and `pages` — the same four
// fields history covers, and deliberately NOT `assets`. One embedded photograph
// is bigger than any ceiling here, and a space with a picture in it has not
// thereby earned more room to record cadence in. What the record is a record OF
// is the pages.

/** The floor: a small space still gets enough room to be worth charting. */
export const RECORD_FLOOR = 64 * 1024
/** The share of its own content a document may spend on recording itself. */
export const RECORD_SHARE = 0.25
/** The cap: past this, more record buys nothing a reader can use. */
export const RECORD_CAP = 256 * 1024
/** Rows kept however small the budget gets — a series nobody can read past is
 *  not a chart. */
export const TRAIL_MAX = 400

const bytes = (v: unknown): number => (v === undefined ? 0 : JSON.stringify(v).length)

/** The size of what the record is a record of. */
export function contentBytes(doc: SpacesDoc): number {
  return bytes({ title: doc.title, home: doc.home, theme: doc.theme, pages: doc.pages })
}

/** The whole record's ceiling for this document. */
export function recordBudget(doc: SpacesDoc): number {
  return Math.min(RECORD_CAP, Math.max(RECORD_FLOOR, Math.floor(contentBytes(doc) * RECORD_SHARE)))
}

/**
 * What the record currently costs, by part.
 *
 * `history` is read off `doc.revisions` GENERICALLY — this build does not know
 * what a revision is (that is `origin/spaces-history`, unmerged) and does not
 * need to. It needs the bytes. When history lands, the shared ceiling is
 * already in force with no change to either side; on a build where only the
 * trail exists, `history` is 0 and the trail simply has the whole budget.
 */
export function recordBytes(doc: SpacesDoc): { trail: number; history: number; total: number } {
  const trail = bytes(doc.trail)
  const history = bytes((doc as { revisions?: unknown }).revisions)
  return { trail, history, total: trail + history }
}

/**
 * The trail's allowance: the shared budget, less what history is already using.
 *
 * TRAIL THINS FIRST. The trail can be thinned without losing a day's meaning
 * (a weekly sample is still an observation somebody made); folding two
 * revisions together loses the ability to restore to the point between them.
 * So the trail yields first and history is only asked afterwards — which is
 * what "each tiers independently within one budget" comes to in practice.
 */
export function trailAllowance(doc: SpacesDoc): number {
  return Math.max(0, recordBudget(doc) - recordBytes(doc).history)
}

// ---- pruning ---------------------------------------------------------------

/**
 * Bring a trail back under its allowance, TIERING rather than failing —
 * following PREVIEW_BUDGET and HISTORY_BUDGET.
 *
 *   Tier 1  under both ceilings: every day kept, full resolution.
 *   Tier 2  thin the oldest rows to one per ISO week.
 *   Tier 3  thin the oldest rows to one per month.
 *   Tier 4  drop the oldest outright, and stamp `cut` on the new oldest.
 *
 * Resolution goes from the DISTANT PAST first: this quarter stays daily while
 * last spring becomes weekly.
 *
 * THINNING SELECTS, IT NEVER AVERAGES. An averaged row is a number nobody
 * observed — the same lie as interpolating a gap, written to disk. The survivor
 * of a bucket is its LAST row, stamped `s` with the span it now stands for:
 * from the earliest row it replaced through its own day. Days outside that span
 * were never observed and stay gaps, so thinning cannot invent coverage.
 *
 * `protect` names days that must not be thinned — the rows of a period that is
 * still running. A sprint must not have its own chart thinned underneath it.
 */
export function pruneTrail(
  trail: Trail,
  allowance: number,
  max = TRAIL_MAX,
  protect: (day: string) => boolean = () => false,
): Trail {
  let out: Trail = { ...trail }
  const over = (t: Trail): boolean =>
    bytes(t) > allowance || Object.keys(t).length > max
  if (!over(out)) return out

  for (const bucket of [weekKey, monthKey] as const) {
    out = thin(out, bucket, protect)
    if (!over(out)) return out
  }

  // Tier 4 — drop the oldest outright, per series, oldest first.
  const keys = Object.keys(out)
    .map((k) => ({ k, addr: parseTrailKey(k) }))
    .filter((e): e is { k: string; addr: TrailAddr } => !!e.addr)
    .sort((a, b) => (a.addr.day < b.addr.day ? -1 : a.addr.day > b.addr.day ? 1 : 0))
  let cutAny = false
  for (const e of keys) {
    if (!over(out)) break
    if (protect(e.addr.day)) continue
    // never drop the last row of a series: a chart with no point at all says
    // less than one with a single point and a "recording starts here" edge
    if (seriesRows(out, e.addr.series).length <= 1) continue
    delete out[e.k]
    cutAny = true
  }
  if (cutAny) out = stampCut(out)
  return out
}

/** Collapse each bucket to its last row, oldest bucket first, stopping as soon
 *  as the trail fits. */
function thin(trail: Trail, bucket: (day: string) => string, protect: (day: string) => boolean): Trail {
  const out: Trail = { ...trail }
  for (const series of seriesIds(out)) {
    const rows = seriesRows(out, series)
    const groups = new Map<string, Array<{ day: string; row: TrailRow }>>()
    for (const r of rows) {
      const b = bucket(r.day)
      const list = groups.get(b)
      if (list) list.push(r)
      else groups.set(b, [r])
    }
    for (const [, list] of groups) {
      if (list.length < 2) continue
      if (list.some((r) => protect(r.day))) continue
      const keep = list[list.length - 1]
      const first = list[0]
      for (const r of list) if (r !== keep) delete out[trailKey(r.day, series || undefined)]
      // the span it now stands for: from the earliest row it replaced through
      // its own day, never further. Anything either side stays a gap.
      const span = Math.max(spanOf(keep.row), daysBetween(first.day, keep.day) + spanOf(first.row))
      const next: TrailRow = { ...keep.row }
      if (span > 1) next.s = span
      out[trailKey(keep.day, series || undefined)] = next
    }
  }
  return stampCut(out)
}

/** `cut` marks the oldest surviving row of each series, so a chart draws its
 *  left edge as "recording starts here" instead of implying the project began
 *  at that value. Re-derived, never accumulated: a row that stops being the
 *  oldest loses the flag. */
function stampCut(trail: Trail): Trail {
  const out: Trail = { ...trail }
  for (const series of seriesIds(out)) {
    const rows = seriesRows(out, series)
    rows.forEach((r, i) => {
      const key = trailKey(r.day, series || undefined)
      const wantCut = i === 0 && rows.length > 0
      const had = r.row.cut === true
      if (wantCut === had) return
      const next = { ...r.row }
      if (wantCut) next.cut = true
      else delete next.cut
      out[key] = next
    })
  }
  return out
}

/** Was anything ever dropped from the front of this series? */
export const wasCut = (trail: Trail, series = ''): boolean =>
  seriesRows(trail, series)[0]?.row.cut === true

// ---- drawing slots ---------------------------------------------------------

/**
 * WHAT A DAY IS, for anything that draws the trail.
 *
 *   'day'    observed on that day, at full resolution.
 *   'sample' covered by a thinned row that stands for a span ending later.
 *   'gap'    NOT RECORDED. Nobody opened the file; the weekend; a build that
 *            predates the feature.
 *
 * A GAP IS DRAWN AS A GAP. No interpolation, no carry-forward, no zero — a
 * carried value is the worst of the three because it looks like data, and
 * an interpolated weekend shows work happening on Sunday. Absent and zero must
 * be visually distinct: a day with zero issues in `doing` is a point at zero, a
 * day nobody opened the file is nothing at all.
 */
export type SlotKind = 'day' | 'sample' | 'gap'

export interface Slot {
  day: string
  kind: SlotKind
  /** the row this day reads from — absent for a gap */
  row?: TrailRow
  /** true on the day the row was actually keyed to (a sample's own day) */
  anchor: boolean
}

/**
 * One slot per day between `from` and `to`, inclusive.
 *
 * A thinned row covers the `s` days ending on its own key, and no more. The
 * days it covers are 'sample'; its own day is the anchor, which is where a
 * point is drawn.
 */
export function slots(trail: Trail, from: string, to: string, series = ''): Slot[] {
  const days = dayRange(from, to)
  if (!days.length) return []
  const cover = new Map<string, { row: TrailRow; anchor: boolean; kind: SlotKind }>()
  for (const { day, row } of seriesRows(trail, series)) {
    const span = spanOf(row)
    const kind: SlotKind = span > 1 ? 'sample' : 'day'
    for (let back = 0; back < span; back++) {
      const d = addDays(day, -back)
      // a span never buries a day that was observed in its own right. Thinning
      // deletes the rows it replaces so this cannot arise from our own writes,
      // but the trail arrives in a file anyone can hand-edit.
      if (back > 0 && cover.get(d)?.anchor) continue
      cover.set(d, { row, anchor: back === 0, kind })
    }
  }
  return days.map((day) => {
    const c = cover.get(day)
    return c
      ? { day, kind: c.kind, row: c.row, anchor: c.anchor }
      : { day, kind: 'gap' as const, anchor: false }
  })
}
