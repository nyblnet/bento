// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A GANTT: one bar per page, from its start date to its due date.
//
// ── WHERE A CHART LIVES IN THIS APP, decided here because every chart that
//    comes after inherits it ──────────────────────────────────────────────
//
// There were two candidates: a new `chart` BLOCK, or another `view` LAYOUT.
// Both of the shapes this file and workload.ts add are `view` layouts, and the
// argument is not "views are close enough":
//
//  1. THE INPUT IS ALREADY SPELLED. Both shapes need exactly `source` (which
//     pages), `filter` (which of them), `sort` (in what order) and `groupBy`
//     (bucketed how). A `chart` block would have to grow four keys with those
//     same four meanings. The format is permanent, so that is not a duplicate
//     that can be tidied up later — it is two vocabularies for one question, in
//     every file ever saved, forever. fields.ts already refuses to grow a
//     second ordering mechanism beside `sort` for exactly this reason (see the
//     Page-column comment in render.ts).
//
//  2. AN OLDER BUILD DEGRADES WELL, and this is the half that is measurable.
//     `layoutOf()` maps a layout it does not know to 'board' — so a build that
//     predates this one meets `layout:'gantt'`, renders a BOARD of the same
//     pages, and round-trips the key untouched. That is shipped, tested
//     behaviour, not a hope. A `chart` block would fall to the unknown-type
//     path and render its `html` — one line of text where a schedule was.
//
//  3. THE COUNTER-ARGUMENT IS REAL AND IT LOSES ON SCOPE. A Gantt is honestly
//     a layout of pages (one page, one bar). A workload chart is honestly an
//     AGGREGATE — it has fewer bars than rows, and no bar is a page. If those
//     two wanted different homes the honest answer would be to say so. They do
//     not, because the aggregation is a property of the OUTPUT and every input
//     key means what it already meant: `groupBy` is "the field the buckets come
//     from", which is what it means on a board too. A board with summed columns
//     is what a workload chart is.
//
//     What DOES want a `chart` block one day is a chart of data that is not
//     pages at all — a `table` block's numbers, say. That has no `source`, no
//     `filter` and no rows, so it shares nothing with a view but the engine.
//     When it arrives it should be its own block type. This decision is about
//     AGGREGATES OVER PAGES, and it does not reach further than that.
//
// ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────
//
// DEPENDENCIES AND CRITICAL PATH. Both need a typed page REFERENCE, and this
// app has exactly one way to point at a page today (`#p/<id>` in prose) which
// is not a field value. Inventing a second one here would be permanent and
// would collide with the relation field being designed elsewhere. So: not
// built, and no field invented.
//
// What is left FOR them, at no format cost: `GanttModel.bars` is a flat list
// keyed by `pageId`, each carrying its own resolved `x`/`w` on a shared 0..1
// axis. An arrow between two bars is a lookup of two ids in that list and two
// numbers; a critical path is a walk over the same list. Neither needs this
// module to change shape, and neither needs a key on the `view` block — the
// edges will live on the PAGES, wherever the relation type puts them.
//
// ── DATES ────────────────────────────────────────────────────────────────
//
// Every date here is an ISO `YYYY-MM-DD` string and every comparison is on
// INTEGER DAY NUMBERS computed arithmetically (`dayNumber`, days-from-civil).
// No `Date` is constructed for arithmetic anywhere in this file. That is not
// caution for its own sake — `new Date('2026-01-01')` is UTC midnight by spec
// and therefore the PREVIOUS DAY for every reader west of Greenwich, and
// `+ 86_400_000` is not a day on the two DST boundaries each year. journal.ts
// carries the same discipline and its rig runs under five timezones.
//
// A `Date` IS built for one thing — asking Intl for a month name — and it is
// built component-wise (`new Date(y, m - 1, d)`), which is local noon-ish and
// cannot roll over.

import type { SpacesDoc } from './model.ts'
import {
  fieldsOf, optionOf, fieldByKey, phaseField, isOpenPhase,
  type FieldSpec, type IssueRow,
} from './fields.ts'
import { isISO } from './journal.ts'

/**
 * How many bars a Gantt will draw.
 *
 * A view is a query over a whole space, and a space is a file somebody mailed
 * you: 10,000 pages is not a hypothetical, it is what an imported wiki looks
 * like. 10,000 `<rect>`s is a locked tab, and a 10,000-row image is not a
 * schedule anybody can read either — so the cap is a READABILITY limit that
 * happens to also be a safety one.
 *
 * The rows are cut AFTER the view's own sort, so which 300 you get is the
 * author's stated order and is stable across reloads and machines. The count
 * that was dropped is reported rather than swallowed: a chart that is silently
 * a subset is the misleading picture this whole file is trying not to draw.
 */
export const GANTT_MAX_BARS = 300

/**
 * Days from 1970-01-01, arithmetically. Howard Hinnant's days-from-civil.
 *
 * No `Date`, so no timezone, no DST and no UTC-midnight trap can reach it: this
 * is integer arithmetic over the proleptic Gregorian calendar and gives the
 * same answer in Kiritimati and in Niue. `dayNumber('1970-01-01') === 0`.
 */
export function dayNumber(iso: string): number {
  const [y0, m, d] = iso.split('-').map(Number)
  const y = m <= 2 ? y0 - 1 : y0
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** The inverse of `dayNumber` — civil-from-days, same source, same arithmetic. */
export function isoFromDay(n: number): string {
  const z = Math.trunc(n) + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp + (mp < 10 ? 3 : -9)
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0)
  return `${y}-${pad(m)}-${pad(d)}`
}

/**
 * A field value read as a date, or nothing.
 *
 * `isISO` and not a shape test: `2026-13-99` is digit-shaped and is not a day,
 * and every Date-based formatter rolls it over into some OTHER real day — so a
 * nonsense value out of a mailed file would be drawn as a confident bar in the
 * wrong month. Anything that is not a real ISO day is ABSENT, which is a state
 * this chart already draws honestly.
 */
export function asDate(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  return isISO(v) ? v : undefined
}

/**
 * The two date fields a schedule is drawn from.
 *
 * DERIVED FROM THE SCHEMA, never hardcoded — the same rule `phaseField`
 * follows. A document that declares its own vocabulary has its own names for
 * these, and a document that declares none gets `start` and `due` from
 * DEFAULT_FIELDS. `start` is looked for by key first because that is what this
 * build's defaults call it; falling back to declared ORDER is what makes a
 * foreign schema work at all.
 *
 * Returns `end` alone when the schema has exactly one date field. That is not a
 * degraded Gantt — it is a milestone chart, which is the correct picture of a
 * list of deadlines.
 */
export function ganttFields(doc: SpacesDoc): { start?: FieldSpec; end?: FieldSpec } {
  const dates = fieldsOf(doc).filter((f) => f?.vt === 'date')
  if (!dates.length) return {}
  const end = dates.find((f) => f.key === 'due') ?? dates[dates.length - 1]
  const start = dates.find((f) => f.key === 'start') ?? dates.find((f) => f !== end)
  return { start, end }
}

export interface GanttBar {
  pageId: string
  title: string
  /** the left edge, ISO */
  from: string
  /** the right edge, ISO — inclusive, so a one-day task is one day wide */
  to: string
  /** no span: one date only, drawn as a diamond rather than a hairline bar */
  milestone: boolean
  /** the two dates are in the wrong order — drawn, and flagged. See below. */
  invalid: boolean
  /** finished after today, and the page's phase is still open */
  overdue: boolean
  /** the bucket colour, from the grouping field's option */
  color?: string
  /** 0..1 across the chart's span */
  x: number
  /** 0..1; zero for a milestone, which has a position and no width */
  w: number
}

export interface GanttTick {
  x: number
  iso: string
  label: string
}

export interface GanttModel {
  bars: GanttBar[]
  ticks: GanttTick[]
  /** the span drawn, inclusive */
  from: string
  to: string
  /** inclusive day count of the span; always >= 1 */
  days: number
  today: string
  /** 0..1, or null when today is not in the span — see below */
  todayX: number | null
  /** rows carrying neither date: not drawn, counted */
  undated: number
  /** rows cut by GANTT_MAX_BARS */
  dropped: number
  /** the schema has no date field at all */
  noDateField: boolean
}

const EMPTY: GanttModel = {
  bars: [], ticks: [], from: '', to: '', days: 1, today: '',
  todayX: null, undated: 0, dropped: 0, noDateField: false,
}

/**
 * The schedule, as geometry.
 *
 * PURE, and separate from the drawing, for two reasons. The obvious one is that
 * every number here can then be asserted in node under any `TZ` — a Gantt's
 * bugs are arithmetic and a source grep would sail straight past all of them.
 * The other is that print, the file-manager still and the editor must draw the
 * SAME picture, and the only way to guarantee that is one model with one
 * painter (render.ts) rather than a snapshot path that drifts.
 *
 * `today` is a parameter with no default. Nothing here may ask what day it is:
 * a function that reads the clock cannot be tested, and "today" is the reader's
 * own day (journal.ts `todayISO`), which is the caller's to know.
 */
export function ganttModel(
  doc: SpacesDoc,
  rows: IssueRow[],
  today: string,
  groupKey?: string,
): GanttModel {
  const { start: startF, end: endF } = ganttFields(doc)
  if (!endF) return { ...EMPTY, today, noDateField: true }

  const group = groupKey ? fieldByKey(doc, groupKey) : undefined
  const phase = phaseField(doc)

  interface Raw { pageId: string; title: string; a: string; b: string; milestone: boolean; invalid: boolean; open: boolean; color?: string }
  const raw: Raw[] = []
  let undated = 0

  for (const r of rows) {
    const s = startF ? asDate(r.values.get(startF.key)) : undefined
    const e = asDate(r.values.get(endF.key))
    if (!s && !e) { undated++; continue }

    // ONE DATE IS A MILESTONE, NOT A ZERO-WIDTH BAR. This is the additivity
    // rule showing through: `start` did not exist until this build, so every
    // issue in every file already written has a due date and no start. Drawing
    // those as hairlines would make every existing tracker look broken; drawing
    // them as a bar from some invented start would be a schedule nobody typed.
    // A diamond at the one date the author DID give is the only honest picture,
    // and it is the standard one — a milestone is a date with no duration.
    //
    // It is symmetric on purpose: a start with no due is a thing that began and
    // has no deadline, and a diamond says exactly that too.
    if (!s || !e) {
      const at = (s ?? e) as string
      raw.push({
        pageId: r.page.id, title: r.page.title, a: at, b: at,
        milestone: true, invalid: false,
        open: isOpenPhase(phase, r.values.get(phase?.key ?? '')),
        color: optionOf(group, r.values.get(group?.key ?? ''))?.color,
      })
      continue
    }

    // DUE BEFORE START. Not swapped, not dropped, not zero-width.
    //
    //  · Swapping draws a confident schedule the author never typed, and the
    //    picture would look correct, which is the worst of the three.
    //  · Dropping hides a page because its data is wrong — the reader then
    //    cannot see the row that needs fixing.
    //
    // So the bar spans the two dates that are actually in the file, earliest to
    // latest, and carries `invalid` so the painter can mark it and say why.
    const invalid = dayNumber(e) < dayNumber(s)
    const a = invalid ? e : s
    const b = invalid ? s : e
    raw.push({
      pageId: r.page.id, title: r.page.title, a, b,
      milestone: false, invalid,
      open: isOpenPhase(phase, r.values.get(phase?.key ?? '')),
      color: optionOf(group, r.values.get(group?.key ?? ''))?.color,
    })
  }

  const dropped = Math.max(0, raw.length - GANTT_MAX_BARS)
  const kept = dropped ? raw.slice(0, GANTT_MAX_BARS) : raw
  if (!kept.length) return { ...EMPTY, today, undated, dropped }

  let lo = dayNumber(kept[0].a)
  let hi = dayNumber(kept[0].b)
  for (const k of kept) {
    lo = Math.min(lo, dayNumber(k.a))
    hi = Math.max(hi, dayNumber(k.b))
  }
  const from = isoFromDay(lo)
  const to = isoFromDay(hi)
  // INCLUSIVE: a chart of one single-day task is one day wide, not zero. Every
  // x/w below is a fraction of this, so `days` can never be 0 and no division
  // here can produce Infinity.
  const days = hi - lo + 1

  const bars: GanttBar[] = kept.map((k) => {
    const a = dayNumber(k.a), b = dayNumber(k.b)
    return {
      pageId: k.pageId,
      title: k.title,
      from: k.a,
      to: k.b,
      milestone: k.milestone,
      invalid: k.invalid,
      // OVERDUE IS ABOUT THE END AND THE PHASE, both. A finished task whose due
      // date has passed is not overdue, it is done; and `isOpenPhase` treats a
      // status this build cannot read as open, so a newer status never hides
      // work by accident (fields.ts).
      overdue: b < dayNumber(today) && k.open,
      color: k.color,
      // a milestone sits at the CENTRE of its day, so the diamond is not half
      // outside the chart when its date is the first or the last in the span
      x: k.milestone ? (a - lo + 0.5) / days : (a - lo) / days,
      w: k.milestone ? 0 : (b - a + 1) / days,
    }
  })

  const todayN = dayNumber(today)
  // TODAY IS MARKED ONLY WHEN IT IS IN THE SPAN, and the span is never stretched
  // to reach it. A project finished in 2019 would otherwise be squashed into a
  // sliver at the far left of seven blank years; clamping the marker to the edge
  // would be worse still, because a line at the right-hand edge reads as "today
  // is the last day of this project" rather than "today is not on this chart".
  // Null, and the view says so in words.
  const todayX = todayN >= lo && todayN <= hi ? (todayN - lo + 0.5) / days : null

  return {
    bars, ticks: ticksFor(from, to, lo, days), from, to, days,
    today, todayX, undated, dropped, noDateField: false,
  }
}

/**
 * Where the gridlines go, and what they are called.
 *
 * Three tiers, chosen by how long the span is, so the axis has a handful of
 * labels rather than three or three hundred. Every label comes from `Intl` —
 * month and weekday names are NEVER a hand-written map here, because a map is
 * English (or eight copies of English) and this app renders in the reader's own
 * locale, from the same document (PLATFORM §8).
 *
 * The locale is deliberately NOT a parameter: `Intl.DateTimeFormat(undefined,…)`
 * resolves the reader's own, which is the rule the journal's labels already
 * follow. Language never enters the document.
 */
function ticksFor(from: string, to: string, lo: number, days: number): GanttTick[] {
  const out: GanttTick[] = []
  const push = (iso: string, opts: Intl.DateTimeFormatOptions) => {
    const n = dayNumber(iso)
    if (n < lo || n >= lo + days) return
    out.push({ x: (n - lo) / days, iso, label: intlDay(iso, opts) })
  }

  if (days <= 35) {
    // WEEKS, counted from the span's own first day rather than from a Monday.
    // Which day a week starts on is a locale question with no answer that is
    // right everywhere, and a gridline is not a calendar — the reader needs
    // evenly spaced dates, not a claim about Mondays.
    for (let n = lo; n < lo + days; n += 7) push(isoFromDay(n), { month: 'short', day: 'numeric' })
    return out
  }

  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  const months = (ty - fy) * 12 + (tm - fm)
  if (months <= 18) {
    for (let y = fy, m = fm, guard = 0; (y < ty || (y === ty && m <= tm)) && guard < 24; guard++) {
      // JANUARY CARRIES THE YEAR. A run of month names across a year boundary
      // says "Nov Dec Jan Feb" and is ambiguous about which January; the year
      // on the one label that needs it costs nothing and removes the question.
      push(`${y}-${pad(m)}-01`, m === 1 ? { month: 'short', year: 'numeric' } : { month: 'short' })
      m++
      if (m > 12) { m = 1; y++ }
    }
    return out
  }

  // YEARS, thinned so the axis never grows without limit. A file can hold a
  // page dated 0001-01-01 beside one dated 9999-12-31 — nothing in the format
  // forbids it, and one gridline per year would then be ten thousand <line>
  // elements for a picture with two bars in it.
  const step = Math.max(1, Math.ceil((ty - fy + 1) / 12))
  for (let y = fy; y <= ty; y += step) push(`${y}-01-01`, { year: 'numeric' })
  return out
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * A date in the reader's own language.
 *
 * The `Date` is built COMPONENT-WISE. `new Date('2026-03-01')` is UTC midnight
 * by spec, so `Intl` formatting it in Los Angeles says "Feb 28" — a gridline
 * labelled with the wrong month, in the half of the world this app is not
 * written in. Falls back to the ISO string, which is wrong in nobody's language
 * rather than misleading in one (journal.ts makes the same trade).
 */
export function intlDay(iso: string, opts: Intl.DateTimeFormatOptions): string {
  const [y, m, d] = iso.split('-').map(Number)
  try {
    return new Intl.DateTimeFormat(undefined, opts).format(new Date(y, m - 1, d))
  } catch {
    return iso
  }
}
