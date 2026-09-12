// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// WORKLOAD: how much work each person is holding — the estimates on a view's
// pages, added up per bucket.
//
// WHERE THIS LIVES, and why it is a `view` layout rather than a `chart` block:
// argued once, in gantt.ts, because the two shapes landed together and the
// argument is the same argument. The short of it: a workload chart needs
// `source`, `filter` and `groupBy` and nothing else, all three already mean
// exactly this on a view, and an older build renders `layout:'workload'` as a
// board of the same pages rather than as one line of fallback text.
//
// NO FORMAT CHANGE AT ALL. This shape adds no key. It reads `groupBy` (which
// bucket), `source` and `filter` (which pages), and finds the field to add up
// in the schema. That is the whole input.
//
// WHAT IS SUMMED IS DERIVED, NOT NAMED. The field is the first `vt:'number'` in
// the document's own schema — `estimate` in the defaults, and whatever a
// document that declares its own vocabulary calls it. Hardcoding `'estimate'`
// would make this chart blank for every space that renamed the field, and
// fields.ts already refuses that trade twice (`phaseField` derives the phase
// field from the option groups rather than assuming `status`).
//
// A BAR CHART IS A PICTURE OF NUMBERS THAT CAME OUT OF A FILE SOMEBODY MAILED
// YOU. Every arithmetic decision below is about what a wrong number does, and
// the rule is the same each time: it must not throw, and it must not quietly
// make a bar the wrong height. See `workloadModel`.

import type { SpacesDoc } from './model.ts'
import { fieldsOf, fieldByKey, optionOf, type FieldSpec, type IssueRow } from './fields.ts'

/**
 * How many bars, before the tail is folded into one.
 *
 * A workload chart of 400 people is not a chart, it is a smear — and the whole
 * question ("who is holding too much?") is answered by the top of the list.
 * The rest is not dropped: it is summed into one bar, so the total on screen
 * still equals the total in the document. A chart whose bars do not add up to
 * the thing it claims to be about is the misleading picture this file exists to
 * refuse.
 */
export const WORKLOAD_MAX_BARS = 20

/** Labels longer than this are cut for the axis; the full name stays in the model. */
const AXIS_LABEL_MAX = 14

/**
 * The field a workload adds up: the first number field the schema declares.
 *
 * Undefined when there is none, which is a real state — a space of recipes has
 * no estimates and the view says so rather than drawing an empty grid.
 */
export const sumField = (doc: SpacesDoc): FieldSpec | undefined =>
  fieldsOf(doc).find((f) => f?.vt === 'number')

/**
 * The field a workload buckets by, when the block does not say.
 *
 * `groupBy` is ONE key with ONE meaning across every layout — "the field the
 * buckets come from" — so this shape invents nothing. What differs is the
 * default for an ABSENT key, and it differs because absent has always meant
 * "the sensible default for this shape": a board's is the phase field, and a
 * workload chart bucketed by status would not be a workload chart.
 *
 * The person field, then, or the first field that has one distinct value per
 * person-shaped thing. Undefined falls back to the caller's own default.
 */
export const bucketField = (doc: SpacesDoc): FieldSpec | undefined =>
  fieldsOf(doc).find((f) => f?.vt === 'person')

export interface WorkloadBar {
  /** the bucket's own value — a person's name, an option id, or '' for unset */
  id: string
  /** what to call it: an option's label, the raw value, or "Unassigned" */
  label: string
  /** the label as the axis will draw it — truncated, never re-derived downstream */
  short: string
  total: number
  /** how many pages are in this bucket */
  count: number
  /** how many of them carry no number at all */
  blank: number
  color?: string
  /** true for the single folded-tail bar, which is not a bucket */
  other?: boolean
}

export interface WorkloadModel {
  bars: WorkloadBar[]
  /** the field being added up, for the axis name and the empty state */
  sum?: FieldSpec
  /** the field being bucketed by */
  by?: FieldSpec
  /** the sum of every bar — equals the document's total, by construction */
  total: number
  /** values that were not a usable number and were left out. See below. */
  ignored: number
  /** buckets folded into the single "Other" bar */
  folded: number
  /** rows considered */
  rows: number
}

/**
 * One field value read as a quantity of work — or a reason it is not one.
 *
 * `unset` and `bad` are DIFFERENT and are counted separately, because they mean
 * different things to a reader. An issue nobody has estimated is ordinary and
 * expected; an issue whose estimate is `-3` or `"about a week"` or `1e999` is a
 * data problem someone should see.
 *
 * NEGATIVES ARE NOT SUMMED. `Math.max(0, n)` and "just add it" are both wrong
 * in the same way: a −3 sitting in a column silently makes someone's workload
 * three points lighter than the work they are actually holding, and the bar
 * looks perfectly ordinary. It is excluded and counted, and the view says how
 * many were excluded, so a wrong number is visible rather than absorbed.
 *
 * NaN and ±Infinity are the same case for the same reason — `NaN` poisons every
 * later addition to `NaN` (a whole chart of empty bars, no error), and
 * `Infinity` makes exactly one bar and flattens all the others to nothing.
 */
export function quantity(v: unknown): { n: number } | { unset: true } | { bad: true } {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return { unset: true }
  // Number([]) is 0 and Number([7]) is 7 — an array is not a quantity however
  // it coerces, and a file can hold one in any field.
  if (typeof v === 'object') return { bad: true }
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return { bad: true }
  return { n }
}

/**
 * The chart, as numbers.
 *
 * PURE — no DOM, no clock, no locale beyond the labels already in the document
 * — so every assertion about it is an assertion about arithmetic and can be
 * made in node. The painter is render.ts and the picture is charts-lite's.
 *
 * `unassignedLabel` is passed in rather than looked up, because a t() call in a
 * module that a rig loads under node would reach the i18n facade for a word the
 * rig does not care about; the caller is the one that has a locale.
 */
export function workloadModel(
  doc: SpacesDoc,
  rows: IssueRow[],
  groupKey: string | undefined,
  unassignedLabel: string,
  otherLabel: (n: number) => string,
): WorkloadModel {
  const sum = sumField(doc)
  const by = (groupKey ? fieldByKey(doc, groupKey) : undefined) ?? bucketField(doc)
  if (!sum || !by) return { bars: [], sum, by, total: 0, ignored: 0, folded: 0, rows: rows.length }

  // A MAP, not an object accumulator. Bucket keys are values out of a mailed
  // file: `{}["constructor"]` is a function and `"__proto__"` is not an own key
  // at all, so a plain-object tally can be poisoned by a name somebody typed.
  // A Map has no prototype chain to fall through and needs no `Object.hasOwn`
  // guard around every read — which is the same reason fields.ts `valuesOf`
  // returns one.
  const acc = new Map<string, WorkloadBar>()
  let ignored = 0

  for (const r of rows) {
    const raw = r.values.get(by.key)
    const id = Array.isArray(raw) ? raw.map(String).join(', ') : String(raw ?? '')
    let bar = acc.get(id)
    if (!bar) {
      const opt = optionOf(by, id)
      const label = id === '' ? unassignedLabel : (opt?.label ?? id)
      bar = { id, label, short: shorten(label), total: 0, count: 0, blank: 0, color: opt?.color }
      acc.set(id, bar)
    }
    bar.count++
    const q = quantity(r.values.get(sum.key))
    if ('n' in q) bar.total += q.n
    else if ('bad' in q) ignored++
    else bar.blank++
  }

  // DETERMINISTIC ORDER: biggest first, ties broken by the label. Without the
  // tie-break the bars would come out in Map insertion order, which is page
  // order — so two people with the same total would swap places when an
  // unrelated page moved, and the chart would look like it had changed.
  const all = [...acc.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
  const total = all.reduce((s, b) => s + b.total, 0)

  if (all.length <= WORKLOAD_MAX_BARS) {
    return { bars: all, sum, by, total, ignored, folded: 0, rows: rows.length }
  }
  const head = all.slice(0, WORKLOAD_MAX_BARS - 1)
  const tail = all.slice(WORKLOAD_MAX_BARS - 1)
  const label = otherLabel(tail.length)
  head.push({
    id: '', label, short: shorten(label), other: true,
    total: tail.reduce((s, b) => s + b.total, 0),
    count: tail.reduce((s, b) => s + b.count, 0),
    blank: tail.reduce((s, b) => s + b.blank, 0),
  })
  return { bars: head, sum, by, total, ignored, folded: tail.length, rows: rows.length }
}

const shorten = (s: string): string =>
  s.length <= AXIS_LABEL_MAX ? s : `${s.slice(0, AXIS_LABEL_MAX - 1)}…`

/**
 * The chart engine's option for this model — PURE JSON, no functions.
 *
 * kernel/src/charts.ts is the engine (shared, and imported from outside slides
 * already — dash does the same), so this app draws no chart of its own. It
 * reads the ECharts option SHAPE; every formatter here is a template string
 * (`{value}`), never a callback, because the option is data and must survive
 * being serialised.
 *
 * `barColor` comes from the caller: the accent is a theme value the renderer
 * knows and this module does not.
 */
export function workloadOption(m: WorkloadModel, barColor: string): Record<string, unknown> {
  return {
    // ITEM, not axis. An axis tooltip on a single-series bar chart names the
    // category twice and reads as a bug.
    tooltip: { trigger: 'item' },
    grid: { left: 48, right: 14, top: 16, bottom: 64 },
    xAxis: {
      type: 'category',
      data: m.bars.map((b) => b.short),
      axisLabel: { fontSize: 11 },
    },
    yAxis: { type: 'value', min: 0, axisLabel: { fontSize: 11 } },
    series: [{
      type: 'bar',
      name: m.sum?.label ?? '',
      itemStyle: { color: barColor },
      // PLAIN NUMBERS. charts-lite coerces an `{value, itemStyle}` item object
      // to 0 for a bar series (its own docs say so), so a per-bar colour is not
      // available here and asking for one would silently zero the chart. One
      // colour for the one series, which is what a single-series chart wants
      // anyway.
      data: m.bars.map((b) => b.total),
    }],
  }
}
