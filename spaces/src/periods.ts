// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE PERIOD: the window a chart is about, and the scope it was committed to.
//
// ATTACHED TO THE DOCUMENT, not to a view and not to a page.
//
//  · NOT A BLOCK. A sprint is not a property of one board. Two charts and three
//    views can be about the same sprint, and if the period lived on a block
//    each would carry its own copy and they would disagree about when the
//    sprint started. That is exactly the argument `fields.ts` makes for the
//    schema not being a value: "putting the status list on every issue would
//    copy it into every page and let two pages disagree about what Todo means."
//  · NOT A PAGE. Delete the page and the sprint's committed baseline dies with
//    it, retroactively falsifying every chart that referenced it.
//  · A MAP, not an array, for the reason `doc.trail` is one: two people
//    defining or closing different periods in one week must both keep theirs.
//    A fully-populated period is under 200 bytes and a period is never pruned,
//    so the budget question does not arise.
//
// SCOPE COMMITTED, WITHOUT DUPLICATING EVERY PAGE ID. `base` is a pair of
// TOTALS — the issue count, the summed estimate and the unestimated count as
// they were when the period was committed. That is the whole content of "scope
// at commit time" for the chart that needs it: a burnup draws work completed
// against total scope, and the gap between scope now and scope committed is the
// scope-creep story. A line needs a number, not a membership list.
//
// What storing ids would add is knowing WHICH issues arrived mid-sprint, which
// nobody asks a burnup for; what it would cost is ~14 bytes per issue per
// period, a second copy of membership that can disagree with the pages, and
// per-task data inside a mailed file, which the trail's privacy rule already
// forbids. Said out loud, because it is a real loss: there is no per-issue
// added/removed attribution, ever. If that turns out to matter, the honest
// place for it is a scope-change EVENT somebody records deliberately, not a set
// the app snapshots behind their back.
//
// THE SCOPE DEFINITION IS A FROZEN COPY of `ViewSource` + `ViewFilter`. Reusing
// those two means no new selector language ships (the thing `fields.ts` warns
// grows without limit and can never shrink), the chart's counting code is the
// board's counting code, and freezing them at commit means editing a view next
// month cannot retroactively redefine last month's sprint.

import type { SpacesDoc } from './model'
import type { ViewSource, ViewFilter } from './fields.ts'
import { observe, type Scope } from './observe.ts'
import { isDay, daysBetween, backfill, type TrailRow } from './trail.ts'

export interface PeriodBase {
  /** the day the baseline was ACTUALLY taken, which is not always `from` */
  at: string
  n: number
  e?: number
  x?: number
}

export interface Period {
  label: string
  /** inclusive local day labels */
  from: string
  to: string
  /** FROZEN copies of the view selectors — the scope definition */
  source?: ViewSource
  filter?: ViewFilter
  /** the trail series this period is charted from; absent = the default */
  series?: string
  /** scope AS COMMITTED. Totals only — never a list of page ids. */
  base?: PeriodBase
  closed?: true
}

export type Periods = Record<string, Period>

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** A `periods` that is not an object is left alone and never written over —
 *  the rule additivity requires for a field this build cannot read. */
export const periodsAreForeign = (doc: SpacesDoc): boolean =>
  doc.periods !== undefined && !isObj(doc.periods)

/**
 * A period this build can draw.
 *
 * A period whose `to` precedes its `from`, whose dates are not days, or whose
 * label is not a string arrives from a file somebody mailed you. None of them
 * may throw and none may draw something misleading, so none of them is a
 * period: `periodsOf` simply does not return it, and the chart that named it
 * says its period is gone.
 */
export function isPeriod(v: unknown): v is Period {
  if (!isObj(v)) return false
  const { from, to } = v as { from?: unknown; to?: unknown }
  if (!isDay(from) || !isDay(to)) return false
  if (daysBetween(from, to) < 0) return false
  return typeof v.label === 'string' || v.label === undefined
}

/** Every readable period, by id. Never creates the key by asking. */
export function periodsOf(doc: SpacesDoc): Periods {
  const raw = doc.periods
  if (!isObj(raw)) return {}
  const out: Periods = {}
  for (const k of Object.keys(raw)) {
    const p = raw[k]
    if (isPeriod(p)) out[k] = { ...(p as Period), label: String((p as Period).label ?? '') }
  }
  return out
}

/** One period by id, or undefined — including for an id that is in the file but
 *  is not a period this build can read. */
export const periodOf = (doc: SpacesDoc, id: string): Period | undefined => {
  const all = periodsOf(doc)
  return Object.hasOwn(all, id) ? all[id] : undefined
}

/** Periods in the order a chooser offers them: newest window first. */
export function periodList(doc: SpacesDoc): Array<{ id: string; period: Period }> {
  return Object.entries(periodsOf(doc))
    .map(([id, period]) => ({ id, period }))
    .sort((a, b) => (a.period.from < b.period.from ? 1 : a.period.from > b.period.from ? -1 : 0))
}

/** The scope a period was committed to. */
export const scopeOf = (p: Period): Scope => ({
  ...(p.source ? { source: p.source } : {}),
  ...(p.filter ? { filter: p.filter } : {}),
})

/**
 * Is this period still live — still running, or finished recently enough that
 * its chart is still being read?
 *
 * This is what `pruneTrail` protects. A sprint that is still running must not
 * have its own chart thinned underneath it, and neither must last sprint's
 * retro. Thirty days after `to`, its rows are ordinary history.
 */
export function isLive(p: Period, today: string): boolean {
  if (p.closed) return false
  if (!isDay(today)) return true
  return daysBetween(p.to, today) <= 30
}

/**
 * The days no prune may thin: every day inside a live period's window.
 *
 * Returned as a PREDICATE rather than a set, because a window is a range and
 * materialising a year of day strings to answer a question about one is waste.
 */
export function protectedDays(doc: SpacesDoc, today: string): (day: string) => boolean {
  const live = Object.values(periodsOf(doc)).filter((p) => isLive(p, today))
  if (!live.length) return () => false
  return (day: string) =>
    live.some((p) => daysBetween(p.from, day) >= 0 && daysBetween(day, p.to) >= 0)
}

export interface StartOpts {
  label: string
  from: string
  to: string
  /** the LOCAL day, from journal.todayISO() */
  today: string
  scope?: Scope
  series?: string
}

/**
 * Commit a period, in place. Returns its id, or null when the window is not one.
 *
 * `base` is computed from LIVE STATE right now, and `base.at` records the day
 * that actually happened on. If `from` is in the past — somebody sets the chart
 * up on day 4 — the chart labels the committed line "committed on 4 Sept"
 * rather than pretending it was the 1st, and NO PAST TRAIL KEY IS FABRICATED.
 * The days before the trail existed are gaps, and they are drawn as gaps.
 *
 * The one past key it may write is `from` itself, and only through `backfill`,
 * which refuses to overwrite: a period committed today whose window starts
 * today gets its first point immediately instead of an empty chart.
 */
export function startPeriod(doc: SpacesDoc, id: string, opts: StartOpts): string | null {
  if (periodsAreForeign(doc)) return null
  if (!isDay(opts.from) || !isDay(opts.to) || daysBetween(opts.from, opts.to) < 0) return null

  const obs = observe(doc, opts.scope ?? {})
  const period: Period = {
    label: opts.label,
    from: opts.from,
    to: opts.to,
    ...(opts.scope?.source ? { source: opts.scope.source } : {}),
    ...(opts.scope?.filter ? { filter: opts.scope.filter } : {}),
    ...(opts.series ? { series: opts.series } : {}),
  }
  if (obs) {
    let n = 0
    for (const k of Object.keys(obs.n)) n += obs.n[k]
    let e: number | undefined
    if (obs.e) { e = 0; for (const k of Object.keys(obs.e)) e += obs.e[k] }
    period.base = {
      at: isDay(opts.today) ? opts.today : opts.from,
      n,
      ...(e !== undefined ? { e } : {}),
      ...(obs.x ? { x: obs.x } : {}),
    }
    // today's own row, if today is inside the window and nothing is there yet
    if (isDay(opts.today) && daysBetween(opts.from, opts.today) >= 0 && daysBetween(opts.today, opts.to) >= 0) {
      backfill(doc, opts.today, obs as TrailRow, opts.series)
    }
  }

  const map: Periods = isObj(doc.periods) ? (doc.periods as Periods) : {}
  map[id] = period
  doc.periods = map
  return id
}

/** Close a period: no further baseline recomputation, and its rows stop being
 *  protected from thinning. */
export function closePeriod(doc: SpacesDoc, id: string): boolean {
  if (periodsAreForeign(doc)) return false
  const map = doc.periods as Periods | undefined
  if (!isObj(map) || !Object.hasOwn(map, id) || !isPeriod(map[id])) return false
  map[id] = { ...map[id], closed: true }
  return true
}

/** Remove one period. The last one removed deletes the key outright — a space
 *  that had periods and then had none is byte-identical to one that never did. */
export function removePeriod(doc: SpacesDoc, id: string): boolean {
  if (periodsAreForeign(doc)) return false
  const map = doc.periods as Periods | undefined
  if (!isObj(map) || !Object.hasOwn(map, id)) return false
  delete map[id]
  if (!Object.keys(map).length) delete doc.periods
  return true
}
