// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// COUNTING THE BOARD, and writing the count down once a day.
//
// ONE COUNTING RULE, NOT TWO. Rows are produced by the SAME code path the board
// uses — `viewRows(doc, source)` and then the `ViewFilter` evaluator — so the
// chart and the board can never disagree about what an issue is, and archived
// pages are excluded from both because `viewRows` already excludes them. A
// second counter here would be a second answer to a question the app has
// already answered, and the two would drift the way two copies of one fact
// always do.
//
// WHEN A ROW IS WRITTEN: on CHANGE, and NEVER ON OPEN.
//
// Writing on open is the tempting answer and it is wrong four separate ways.
// Opening a file to read it must not modify it: a reading copy is sealed, the
// static preview renders with JS off, a thumbnailer renders it, and
// `doc.readonly` exists precisely so a file can be opened without being
// touched. An open-writes trail would dirty a document nobody edited, prompt a
// save, mint collaboration ops for merely looking, and add a row on a day the
// team did no work — which is a lie in the shape of data.
//
// So: the first document change of the local day writes today's row, and every
// later change of that day rewrites the same key. Two rows for one day is
// unrepresentable, because the key IS the day; the second write overwrites the
// first, so a day's row is the LAST observation of that day, which is also the
// one a burndown wants. Save is not the trigger — but a save is a change, so an
// ordinary session produces a row either way, and a live collaboration session
// where nobody presses ⌘S still gets one.
//
// IMPLICIT: a space with no phase field writes no rows, so an ordinary notes
// space is entirely unaffected and nothing turns itself on until somebody makes
// their first issue.

import type { SpacesDoc } from './model'
import {
  fieldsOf, phaseField, viewRows, passesFilter,
  type FieldSpec, type ViewSource, type ViewFilter,
} from './fields.ts'
import {
  type TrailRow, isDay, trailIsForeign, trailOf, writeRow, pruneTrail,
  trailAllowance, TRAIL_MAX, trailKey,
} from './trail.ts'

/** What the trail is counted over. Frozen onto a period at commit, so editing a
 *  view next month cannot retroactively redefine last month's sprint. */
export interface Scope {
  source?: ViewSource
  filter?: ViewFilter
}

/**
 * THE ESTIMATE FIELD — derived from the schema, never hardcoded.
 *
 * A document declares its own fields (`doc.fields`), so the number field a
 * points burndown is about is whatever the schema says it is. `estimate` wins
 * when it is a number field, because that is the default schema's name for it
 * and a document that renamed something else to `estimate` deserves to be
 * believed; otherwise the FIRST number field is it. No number field at all
 * means a count burndown, which is a real answer rather than an empty chart.
 */
export function estimateField(doc: SpacesDoc): FieldSpec | undefined {
  const fields = fieldsOf(doc)
  const named = fields.find((f) => f?.key === 'estimate' && f.vt === 'number')
  return named ?? fields.find((f) => f?.vt === 'number')
}

/** One day's counts, before they are filed under a key. */
export interface Observation {
  n: Record<string, number>
  e?: Record<string, number>
  x?: number
}

/**
 * Count the board as it is RIGHT NOW.
 *
 * `null` when this space is not a tracker — no phase field, nothing to count,
 * no row. That is also what makes today's point on every chart derived rather
 * than read: this is the function the charts call for today.
 *
 * A status value this build does not know is counted under its own literal
 * string, the rule `ViewFilter` already states — a newer build's option must
 * not vanish from the count because this one cannot name it.
 */
export function observe(doc: SpacesDoc, scope: Scope = {}): Observation | null {
  const pf = phaseField(doc)
  if (!pf) return null
  const ef = estimateField(doc)
  const n: Record<string, number> = {}
  const e: Record<string, number> = {}
  let unestimated = 0
  let anyEstimate = false

  for (const row of viewRows(doc, scope.source)) {
    if (!passesFilter(doc, row.values, scope.filter)) continue
    const raw = row.values.get(pf.key)
    // an issue with no status at all is still an issue; it is counted under the
    // field's own default when it declares one, and otherwise under '' — which
    // renders as "No status" rather than disappearing from the total.
    const id = String(raw ?? pf.def ?? '')
    n[id] = (n[id] ?? 0) + 1
    if (!ef) continue
    const v = Number(row.values.get(ef.key))
    if (Number.isFinite(v)) { e[id] = (e[id] ?? 0) + v; anyEstimate = true }
    else unestimated++
  }

  if (!Object.keys(n).length) return { n: {} }
  return {
    n,
    // ABSENT when nothing is estimated, so a count-only board costs no bytes
    // for a column of zeroes.
    ...(anyEstimate ? { e } : {}),
    // The count of issues with NO estimate. A points burndown drawn over a
    // backlog where a third of the issues are unestimated is a picture of
    // nothing — today you can see that, and on 3 September you could not.
    ...(anyEstimate && unestimated ? { x: unestimated } : {}),
  }
}

/** An observation as a row. Separate from `observe` so a period's baseline can
 *  be taken from the same numbers without minting a row. */
export const rowOf = (obs: Observation): TrailRow => ({ ...obs })

export interface RecordOpts extends Scope {
  /** the LOCAL day, from journal.todayISO(). Injected so a rig is not at the
   *  mercy of a clock, and so the one place local time enters the trail is a
   *  call site rather than a library. */
  today: string
  /** the series this row belongs to; absent = the default series */
  series?: string
  /** days a prune must not thin — a period that is still running */
  protect?: (day: string) => boolean
}

/**
 * Write today's row and bring the trail back under its allowance.
 *
 * Returns the row written, or null when nothing was (not a tracker, a foreign
 * `trail`, a day this build cannot read, or a read-only document — the caller
 * owns that last check).
 *
 * IDEMPOTENT WITHIN A DAY: N writes on one day produce exactly one key holding
 * the last observation.
 */
export function recordTrail(doc: SpacesDoc, opts: RecordOpts): TrailRow | null {
  if (trailIsForeign(doc) || !isDay(opts.today)) return null
  const obs = observe(doc, opts)
  if (!obs || !Object.keys(obs.n).length) return null

  // keep whatever the existing row said about its own span: rewriting today
  // after a thinning pass must not silently promote a sample back to a day.
  const key = trailKey(opts.today, opts.series)
  const prev = trailOf(doc)[key]
  const row: TrailRow = rowOf(obs)
  if (prev?.cut) row.cut = true

  if (!writeRow(doc, opts.today, row, opts.series)) return null

  const kept = pruneTrail(trailOf(doc), trailAllowance(doc), TRAIL_MAX, opts.protect ?? (() => false))
  if (Object.keys(kept).length) doc.trail = kept
  else delete doc.trail
  return (doc.trail as Record<string, TrailRow> | undefined)?.[key] ?? row
}
