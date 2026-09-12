#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The timeline and the workload chart — the arithmetic, not the markup.
//
//   node scripts/test-spaces-gantt.ts
//   TZ=Pacific/Kiritimati node scripts/test-spaces-gantt.ts
//   TZ=Pacific/Niue node scripts/test-spaces-gantt.ts
//
// WHY THESE ASSERTIONS ARE ABOUT NUMBERS. A chart is a picture of data that
// came out of a file somebody mailed you, and every way it can be wrong is a
// way it stays SILENT about being wrong: a bar in the wrong month still looks
// like a bar, a bucket that lost a negative estimate still looks like a bucket,
// and a view that quietly drew 300 of 10,000 rows looks exactly like one that
// drew all of them. A source grep sails straight past every one of those. So
// each check below builds a document, runs the model, and asserts on the
// GEOMETRY or the TOTAL it produced.
//
// WHY THE TIMEZONE MATRIX. `new Date('2026-01-01')` is UTC midnight by spec and
// therefore the previous day for every reader west of Greenwich; `+ 86400000`
// is not a day on the two DST boundaries each year. Kiritimati is UTC+14 and
// Niue is UTC−11 — the two ends of the inhabited range, and between them they
// catch a date bug in either direction. test-spaces-journal.ts exists for the
// same reason and CI runs it the same way.

import {
  dayNumber, isoFromDay, asDate, ganttFields, ganttModel, GANTT_MAX_BARS,
} from '../spaces/src/gantt.ts'
import {
  workloadModel, workloadOption, quantity, sumField, bucketField, WORKLOAD_MAX_BARS,
} from '../spaces/src/workload.ts'
import { DEFAULT_FIELDS, viewRows, passesFilter, layoutOf, nextLayout, VIEW_LAYOUTS } from '../spaces/src/fields.ts'
import type { IssueRow } from '../spaces/src/fields.ts'
import type { SpacesDoc, Page } from '../spaces/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const TZ = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
console.log(`bento/spaces timeline + workload   (TZ=${TZ})\n`)

// A document with the default schema and no pages: everything below supplies
// its own rows, because `viewRows` is already covered by the model rig and what
// is under test here is what happens to the rows AFTER it.
const doc = (fields = DEFAULT_FIELDS): SpacesDoc =>
  ({ pages: [], fields } as unknown as SpacesDoc)

let seq = 0
const row = (values: Record<string, unknown>, title = `p${++seq}`): IssueRow => ({
  page: { id: `id-${title}`, title, blocks: [] } as unknown as Page,
  values: new Map(Object.entries(values)),
})

// ---- day numbers are arithmetic, in every timezone -------------------------
{
  ok(dayNumber('1970-01-01') === 0, 'the epoch is day zero')
  ok(dayNumber('1970-01-02') - dayNumber('1970-01-01') === 1, 'consecutive days differ by one')
  ok(dayNumber('2026-03-01') - dayNumber('2026-02-28') === 1, '2026 is not a leap year')
  ok(dayNumber('2024-03-01') - dayNumber('2024-02-28') === 2, '2024 is')
  ok(dayNumber('2000-03-01') - dayNumber('2000-02-28') === 2, 'and so is 2000, the century that is')
  ok(dayNumber('1900-03-01') - dayNumber('1900-02-28') === 1, '…while 1900 is not, which is the rule a naive %4 gets wrong')

  // THE CONTROL. This is what the obvious implementation would have produced,
  // and in a UTC+14 or UTC−11 process it is off by a day. The assertion above
  // does not construct a Date at all, so it cannot be.
  const naive = Math.round((new Date('2026-03-01').getTime() - new Date('1970-01-01').getTime()) / 86400000)
  console.log(`        (Date-based day number for 2026-03-01: ${naive}; arithmetic: ${dayNumber('2026-03-01')})`)
  ok(dayNumber('2026-03-01') === 20513, 'the arithmetic answer is the same number under every TZ')

  // DST: America/Los_Angeles springs forward on 2026-03-08 and back on
  // 2026-11-01. Those are the two days `+86_400_000` is not one day.
  ok(dayNumber('2026-03-09') - dayNumber('2026-03-08') === 1, 'a 23-hour day is still one day')
  ok(dayNumber('2026-11-02') - dayNumber('2026-11-01') === 1, 'and so is a 25-hour one')

  for (const iso of ['1970-01-01', '2026-01-31', '2024-02-29', '1900-03-01', '2026-12-31']) {
    ok(isoFromDay(dayNumber(iso)) === iso, `${iso} round-trips through day number and back`)
  }
}

// ---- a value is a date, or it is absent ------------------------------------
{
  ok(asDate('2026-08-06') === '2026-08-06', 'a real ISO day is a date')
  ok(asDate('2026-13-99') === undefined, 'a digit-shaped non-day is NOT a date — it would roll over into another month')
  ok(asDate('2026-02-30') === undefined, '…nor is 30 February')
  ok(asDate('soon') === undefined && asDate('') === undefined, 'prose is not a date')
  ok(asDate(20260806) === undefined, 'a number is not a date')
  ok(asDate({ y: 2026 }) === undefined && asDate(['2026-08-06']) === undefined,
    'an object out of a mailed file is not a date and does not throw')
}

// ---- the two date fields come from the schema ------------------------------
{
  const f = ganttFields(doc())
  ok(f.start?.key === 'start' && f.end?.key === 'due', 'the defaults give start and due')

  const own = doc([
    { key: 'status', label: 'S', vt: 'select', options: [{ id: 'a', label: 'A', group: 'started' }] },
    { key: 'kickoff', label: 'Kickoff', vt: 'date' },
    { key: 'ship', label: 'Ship', vt: 'date' },
  ] as never)
  const g = ganttFields(own)
  ok(g.start?.key === 'kickoff' && g.end?.key === 'ship',
    'a document that names its own date fields gets its own, in declared order')

  const oneDate = doc([{ key: 'when', label: 'When', vt: 'date' }] as never)
  const o = ganttFields(oneDate)
  ok(o.end?.key === 'when' && o.start === undefined,
    'one date field is a milestone chart, not a broken Gantt')

  ok(Object.keys(ganttFields(doc([{ key: 'name', label: 'N', vt: 'text' }] as never))).length === 0,
    'no date field at all is reported, not guessed at')
  ok(ganttModel(doc([{ key: 'name', label: 'N', vt: 'text' }] as never), [row({})], '2026-08-06').noDateField,
    '…and the model says so rather than drawing an empty grid')
}

// ---- a bar spans start..due, inclusive -------------------------------------
{
  const m = ganttModel(doc(), [
    row({ start: '2026-01-01', due: '2026-01-10' }, 'ten'),
    row({ start: '2026-01-01', due: '2026-01-01' }, 'one'),
  ], '2026-01-05')
  ok(m.days === 10, 'the span is ten days inclusive')
  const ten = m.bars.find((b) => b.title === 'ten')!
  const one = m.bars.find((b) => b.title === 'one')!
  ok(ten.x === 0 && Math.abs(ten.w - 1) < 1e-9, 'the ten-day bar fills the chart')
  ok(one.x === 0 && Math.abs(one.w - 0.1) < 1e-9,
    `a ONE-day task is one day wide, not zero (w=${one.w})`)
  ok(!one.milestone && !ten.milestone, 'both have two dates, so neither is a milestone')
  ok(m.from === '2026-01-01' && m.to === '2026-01-10', 'the span is the union of the bars')
}

// ---- ABSENT START IS A MILESTONE, NOT A ZERO-WIDTH BAR ---------------------
// The additivity rule, made visible: `start` did not exist before this build,
// so every issue in every file already written is exactly this case.
{
  const m = ganttModel(doc(), [
    row({ due: '2026-01-10' }, 'legacy'),
    row({ start: '2026-01-01', due: '2026-01-10' }, 'dated'),
  ], '2026-01-05')
  const legacy = m.bars.find((b) => b.title === 'legacy')!
  ok(legacy.milestone === true, 'an issue with only a due date is a MILESTONE')
  ok(legacy.w === 0, '…with no width, because a date has no duration')
  ok(legacy.x > 0.9 && legacy.x < 1,
    `…positioned at its due date, at the centre of that day (x=${legacy.x})`)
  ok(m.bars.every((b) => b.x >= 0 && b.x <= 1 && b.w >= 0 && b.x + b.w <= 1 + 1e-9),
    'nothing is drawn outside the chart')

  // symmetric: a start with no due is a thing that began and has no deadline
  const s = ganttModel(doc(), [row({ start: '2026-02-02' }, 'open-ended')], '2026-02-02')
  ok(s.bars[0].milestone && s.bars[0].from === '2026-02-02',
    'a start with no due is a milestone too, at the start')
}

// ---- due BEFORE start: drawn, flagged, never swapped silently --------------
{
  const m = ganttModel(doc(), [row({ start: '2026-03-20', due: '2026-03-10' }, 'backwards')], '2026-03-15')
  const b = m.bars[0]
  ok(b.invalid === true, 'a due date before the start is FLAGGED')
  ok(b.w > 0, `…and still drawn with a positive width (w=${b.w}), never a negative rectangle`)
  ok(b.from === '2026-03-10' && b.to === '2026-03-20',
    'the bar spans the two dates that are actually in the file, earliest to latest')
  ok(m.days === 11, 'and the span is real, not negative')
}

// ---- a malformed date is an ABSENT date ------------------------------------
{
  const m = ganttModel(doc(), [
    row({ start: '2026-13-99', due: '2026-04-10' }, 'junk-start'),
    row({ start: 'next tuesday', due: 'whenever' }, 'all-junk'),
  ], '2026-04-05')
  ok(m.bars.length === 1 && m.bars[0].title === 'junk-start',
    'a page whose dates are both nonsense is not drawn')
  ok(m.bars[0].milestone === true,
    'a nonsense start is treated as absent — a milestone, not a bar from year 2026 month 13')
  ok(m.undated === 1, 'and the page that was left out is COUNTED, not swallowed')
}

// ---- today is marked, and only when it is really there ---------------------
{
  const inside = ganttModel(doc(), [row({ start: '2026-01-01', due: '2026-01-31' })], '2026-01-16')
  ok(inside.todayX !== null && inside.todayX! > 0.4 && inside.todayX! < 0.6,
    `today in the middle of the span is marked in the middle (x=${inside.todayX})`)

  const after = ganttModel(doc(), [row({ start: '2019-01-01', due: '2019-01-31' })], '2026-01-16')
  ok(after.todayX === null,
    'today outside the span is NOT clamped to the edge — a line at the edge would read as "the project ends today"')
  ok(after.days === 31, '…and the span is not stretched seven years to reach it')

  const edge = ganttModel(doc(), [row({ start: '2026-01-01', due: '2026-01-31' })], '2026-01-31')
  ok(edge.todayX !== null, 'the last day of the span IS in the span')
}

// ---- overdue is about the end AND the phase --------------------------------
{
  const m = ganttModel(doc(), [
    row({ status: 'doing', start: '2026-01-01', due: '2026-01-10' }, 'late'),
    row({ status: 'done', start: '2026-01-01', due: '2026-01-10' }, 'shipped'),
    row({ status: 'cancelled', start: '2026-01-01', due: '2026-01-10' }, 'dropped'),
    row({ status: 'from-a-newer-build', start: '2026-01-01', due: '2026-01-10' }, 'unknown'),
    row({ status: 'doing', start: '2026-01-01', due: '2026-12-31' }, 'ongoing'),
  ], '2026-06-01')
  const by = (t2: string) => m.bars.find((b) => b.title === t2)!
  ok(by('late').overdue === true, 'an open issue past its due date is overdue')
  ok(by('shipped').overdue === false, 'a DONE issue past its due date is not overdue, it is done')
  ok(by('dropped').overdue === false, '…nor is a cancelled one')
  ok(by('unknown').overdue === true,
    'a status this build cannot read counts as OPEN — hiding work because the status is newer is the silent loss')
  ok(by('ongoing').overdue === false, 'a due date in the future is not overdue')
}

// ---- ten thousand pages: no throw, a capped chart, an honest count ----------
{
  const many: IssueRow[] = []
  for (let i = 0; i < 10_000; i++) {
    many.push(row({ start: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, due: '2026-12-31' }, `t${i}`))
  }
  const t0 = Date.now()
  const m = ganttModel(doc(), many, '2026-06-01')
  const ms = Date.now() - t0
  ok(m.bars.length === GANTT_MAX_BARS, `10,000 rows draw ${GANTT_MAX_BARS} bars, not 10,000`)
  ok(m.dropped === 10_000 - GANTT_MAX_BARS,
    `…and the ${m.dropped} that were cut are COUNTED — a chart that is silently a subset is the misleading picture`)
  ok(ms < 2000, `and it is not slow (${ms}ms)`)
  ok(m.bars.every((b) => Number.isFinite(b.x) && Number.isFinite(b.w)),
    'every coordinate is a finite number')
}

// ---- a span cannot divide by zero ------------------------------------------
{
  const m = ganttModel(doc(), [row({ due: '2026-05-05' })], '2026-05-05')
  ok(m.days === 1, 'a single-day span is one day, never zero')
  ok(Number.isFinite(m.bars[0].x) && Number.isFinite(m.todayX ?? 0), 'so nothing is Infinity or NaN')
}

// ---- gridlines: a handful, in the reader's language, never hand-written ----
{
  const short = ganttModel(doc(), [row({ start: '2026-01-01', due: '2026-01-20' })], '2026-01-10')
  ok(short.ticks.length >= 2 && short.ticks.length <= 6, `a three-week span gets ${short.ticks.length} ticks`)

  const year = ganttModel(doc(), [row({ start: '2026-01-01', due: '2026-12-31' })], '2026-06-01')
  ok(year.ticks.length === 12, `a calendar year gets one tick per month (${year.ticks.length})`)
  ok(year.ticks[0].iso === '2026-01-01', 'the first is the first of January')

  // Nine thousand years: nothing in the format forbids it, and one gridline per
  // year would be nine thousand <line> elements.
  const epic = ganttModel(doc(), [row({ start: '0001-01-01', due: '9999-12-31' })], '2026-06-01')
  ok(epic.ticks.length <= 13, `a ten-thousand-year span still gets a readable axis (${epic.ticks.length} ticks)`)
  ok(epic.ticks.every((tk) => tk.x >= 0 && tk.x <= 1), 'and every tick is inside the chart')

  // The labels come from Intl. Under a C/POSIX-ish locale Intl still answers in
  // English; what is asserted is that a label EXISTS and is not the raw ISO
  // string, which is what the fallback would give.
  ok(year.ticks.every((tk) => tk.label && tk.label !== tk.iso),
    'every tick is labelled by Intl, not by a hand-written month map')
}

// ---- WORKLOAD: what a number is, and what it is not ------------------------
{
  ok('n' in quantity(3) && (quantity(3) as { n: number }).n === 3, '3 is three')
  ok('n' in quantity('4') && (quantity('4') as { n: number }).n === 4, '"4" is four')
  ok('n' in quantity(0), 'zero is a number, not an absence')
  ok('unset' in quantity(undefined) && 'unset' in quantity('') && 'unset' in quantity(null),
    'an unestimated issue is UNSET, which is ordinary')
  ok('bad' in quantity(-3), 'a NEGATIVE estimate is not summed — it would make somebody lighter than the work they hold')
  ok('bad' in quantity('about a week'), 'prose is not a quantity')
  ok('bad' in quantity(Infinity) && 'bad' in quantity(NaN),
    'Infinity flattens every other bar and NaN poisons the whole sum — neither is summed')
  ok('bad' in quantity([7]), 'an array coerces to 7 and is still not a quantity')
}

{
  const uLabel = 'Unassigned'
  const other = (n: number) => `Other (${n})`
  const m = workloadModel(doc(), [
    row({ assignee: 'Ada', estimate: 3 }),
    row({ assignee: 'Ada', estimate: 5 }),
    row({ assignee: 'Bo', estimate: 2 }),
    row({ assignee: 'Bo' }),
    row({ estimate: 4 }),
  ], undefined, uLabel, other)
  ok(m.sum?.key === 'estimate', 'the field being summed is derived from the schema')
  ok(m.by?.key === 'assignee', 'and the bucket field is the person field')
  const ada = m.bars.find((b) => b.label === 'Ada')!
  ok(ada.total === 8, `Ada holds 8 (${ada.total})`)
  ok(m.bars[0].label === 'Ada', 'the biggest bar is first')

  // TIES ARE BROKEN BY THE LABEL, and this needs its own check: without the
  // tie-break the bars come out in Map insertion order, which is PAGE order —
  // so two people holding the same amount would swap places whenever an
  // unrelated page moved, and a chart that had not changed would look as though
  // it had. A sabotage of the tie-break passed every other assertion here.
  const tied = (order: string[]) => workloadModel(doc(),
    order.map((who) => row({ assignee: who, estimate: 4 })),
    undefined, uLabel, other).bars.map((b) => b.label).join(',')
  ok(tied(['Zoe', 'Ada', 'Mo']) === 'Ada,Mo,Zoe', `equal totals sort by label (${tied(['Zoe', 'Ada', 'Mo'])})`)
  ok(tied(['Mo', 'Zoe', 'Ada']) === tied(['Zoe', 'Ada', 'Mo']),
    'and the same three in a different page order give the SAME chart')
  const bo = m.bars.find((b) => b.label === 'Bo')!
  ok(bo.total === 2 && bo.count === 2 && bo.blank === 1,
    'an unestimated issue counts toward the person and adds nothing to the bar')
  ok(m.bars.find((b) => b.label === uLabel)?.total === 4,
    'work nobody is holding is its own bar, not a hole')
  ok(m.total === 14 && m.bars.reduce((s, b) => s + b.total, 0) === 14,
    'the bars add up to the document')
}

// ---- a negative estimate is excluded AND reported --------------------------
{
  const m = workloadModel(doc(), [
    row({ assignee: 'Ada', estimate: 5 }),
    row({ assignee: 'Ada', estimate: -3 }),
  ], undefined, 'Unassigned', (n) => `Other (${n})`)
  ok(m.bars[0].total === 5, `a −3 does not reduce the bar to 2 (${m.bars[0].total})`)
  ok(m.ignored === 1, '…and it is COUNTED, so the view can say the number is short')
  ok(Number.isFinite(m.total), 'the total is a real number')
}

{
  const m = workloadModel(doc(), [
    row({ assignee: 'Ada', estimate: 5 }),
    row({ assignee: 'Ada', estimate: NaN }),
    row({ assignee: 'Bo', estimate: Infinity }),
  ], undefined, 'Unassigned', (n) => `Other (${n})`)
  ok(m.bars.every((b) => Number.isFinite(b.total)), 'no bar is NaN or Infinity')
  ok(m.bars.find((b) => b.label === 'Bo')!.total === 0, 'an Infinity bar is zero, not the whole chart')
  ok(m.ignored === 2, 'both were reported')
}

// ---- the tail is folded, never dropped -------------------------------------
{
  const rows: IssueRow[] = []
  for (let i = 0; i < 100; i++) rows.push(row({ assignee: `person-${i}`, estimate: 1 }))
  const m = workloadModel(doc(), rows, undefined, 'Unassigned', (n) => `Other (${n})`)
  ok(m.bars.length === WORKLOAD_MAX_BARS, `100 people give ${WORKLOAD_MAX_BARS} bars`)
  ok(m.folded === 100 - (WORKLOAD_MAX_BARS - 1), `${m.folded} of them are folded into one`)
  ok(m.bars[m.bars.length - 1].other === true, 'the last bar is the fold, and says so')
  ok(m.bars.reduce((s, b) => s + b.total, 0) === 100,
    'THE BARS STILL ADD UP TO 100 — a chart whose visible bars do not sum to the total it claims is the failure')
  ok(m.total === 100, 'and the model agrees')
}

// ---- a prototype key out of a mailed file cannot poison the tally ----------
{
  const m = workloadModel(doc(), [
    row({ assignee: '__proto__', estimate: 2 }),
    row({ assignee: 'constructor', estimate: 3 }),
    row({ assignee: 'toString', estimate: 4 }),
  ], undefined, 'Unassigned', (n) => `Other (${n})`)
  ok(m.bars.length === 3, 'three buckets, one per name — no prototype key is swallowed or duplicated')
  ok(m.bars.every((b) => Number.isFinite(b.total)) && m.total === 9,
    `and the tally is exact (${m.total})`)
  ok(m.bars.find((b) => b.label === 'toString')?.total === 4,
    'a bucket called "toString" holds a number, not a native function')
}

// ---- ten thousand pages, again ---------------------------------------------
{
  const rows: IssueRow[] = []
  for (let i = 0; i < 10_000; i++) rows.push(row({ assignee: `p${i % 7}`, estimate: 2 }))
  const t0 = Date.now()
  const m = workloadModel(doc(), rows, undefined, 'Unassigned', (n) => `Other (${n})`)
  const ms = Date.now() - t0
  ok(m.bars.length === 7 && m.total === 20_000, `10,000 rows collapse to 7 bars totalling ${m.total}`)
  ok(ms < 2000, `and it is not slow (${ms}ms)`)
}

// ---- a space with no number field says so ----------------------------------
{
  const recipes = doc([
    { key: 'cuisine', label: 'Cuisine', vt: 'text' },
    { key: 'cook', label: 'Cook', vt: 'person' },
  ] as never)
  ok(sumField(recipes) === undefined, 'a space of recipes has nothing to add up')
  const m = workloadModel(recipes, [row({ cook: 'Ada' })], undefined, 'Unassigned', (n) => `Other (${n})`)
  ok(!m.sum && m.bars.length === 0, '…and the model reports it rather than drawing an empty grid')
  ok(bucketField(recipes)?.key === 'cook', 'but the bucket field is still found')
}

// ---- bucketing by something other than a person ----------------------------
{
  const m = workloadModel(doc(), [
    row({ status: 'doing', estimate: 3 }),
    row({ status: 'doing', estimate: 2 }),
    row({ status: 'done', estimate: 8 }),
  ], 'status', 'Unassigned', (n) => `Other (${n})`)
  ok(m.by?.key === 'status', 'a stored groupBy is honoured, in every layout')
  ok(m.bars.find((b) => b.label === 'In progress')?.total === 5,
    'a select bucket is labelled by its OPTION, not by the id the model stores')
  ok(m.bars.find((b) => b.label === 'In progress')?.color === '#F7A600',
    '…and carries the option colour')
}

// ---- the chart option is plain JSON ----------------------------------------
{
  const m = workloadModel(doc(), [row({ assignee: 'Ada', estimate: 3 })], undefined, 'Unassigned', (n) => `Other (${n})`)
  const opt = workloadOption(m, '#5B8DEF')
  ok(JSON.parse(JSON.stringify(opt)) !== null, 'the option survives a JSON round trip')
  ok(JSON.stringify(opt).indexOf('function') < 0, 'and holds no functions — charts-lite takes template strings, never callbacks')
  const series = (opt as { series: Array<{ data: unknown[] }> }).series[0]
  ok(series.data.every((v) => typeof v === 'number'),
    'bar data is PLAIN NUMBERS — charts-lite coerces an item object to 0 for a bar series')
  const cats = (opt as { xAxis: { data: string[] } }).xAxis.data
  ok(cats.length === series.data.length, 'one category per value')

  const long = workloadModel(doc(), [row({ assignee: 'A very long name indeed', estimate: 1 })],
    undefined, 'Unassigned', (n) => `Other (${n})`)
  ok(long.bars[0].label === 'A very long name indeed' && long.bars[0].short.length <= 14,
    'the axis label is cut and the full name is kept beside it')
}

// ---- the layout cycle still holds ------------------------------------------
{
  ok(layoutOf('gantt') === 'gantt' && layoutOf('workload') === 'workload',
    'the two new shapes resolve to themselves')
  ok(layoutOf('mosaic') === 'board' && layoutOf('toString') === 'board',
    'AN OLDER BUILD MEETING layout:"gantt" DRAWS A BOARD — this is the additivity claim, and it is what layoutOf already did')
  let at: string = 'board'
  for (let i = 0; i < VIEW_LAYOUTS.length; i++) at = nextLayout(at)
  ok(at === 'board', `${VIEW_LAYOUTS.length} steps come back to the board`)
  ok(new Set(VIEW_LAYOUTS.map((l) => nextLayout(l))).size === VIEW_LAYOUTS.length,
    'and no two shapes lead to the same place')
}

// ---- the view's own source and filter reach the chart ----------------------
// "Workload for this project" has to be expressible, and it is expressible
// because the chart takes the rows the view already derived — no second
// selector language, which is the whole argument for these being layouts.
{
  const pages: Page[] = [
    { id: 'proj', title: 'Project', blocks: [] },
    { id: 'a', title: 'A', parent: 'proj', blocks: [
      { id: 'a1', type: 'prop', key: 'status', value: 'doing' },
      { id: 'a2', type: 'prop', key: 'assignee', value: 'Ada' },
      { id: 'a3', type: 'prop', key: 'estimate', value: 5 },
    ] },
    { id: 'b', title: 'B', parent: 'proj', blocks: [
      { id: 'b1', type: 'prop', key: 'status', value: 'done' },
      { id: 'b2', type: 'prop', key: 'assignee', value: 'Ada' },
      { id: 'b3', type: 'prop', key: 'estimate', value: 100 },
    ] },
    { id: 'c', title: 'C', blocks: [
      { id: 'c1', type: 'prop', key: 'status', value: 'doing' },
      { id: 'c2', type: 'prop', key: 'assignee', value: 'Ada' },
      { id: 'c3', type: 'prop', key: 'estimate', value: 7 },
    ] },
  ] as unknown as Page[]
  const d = { pages, fields: DEFAULT_FIELDS } as unknown as SpacesDoc

  const all = workloadModel(d, viewRows(d), undefined, 'Unassigned', (n) => `Other (${n})`)
  ok(all.total === 112, `unscoped, Ada holds everything (${all.total})`)

  const scoped = viewRows(d, { under: 'proj' })
  const proj = workloadModel(d, scoped, undefined, 'Unassigned', (n) => `Other (${n})`)
  ok(proj.total === 105, `"workload for this project" is the view's own source (${proj.total})`)

  const open = workloadModel(d, scoped.filter((r) => passesFilter(d, r.values, { open: true })),
    undefined, 'Unassigned', (n) => `Other (${n})`)
  ok(open.total === 5, `…and "open only" narrows it further (${open.total}) with no new key anywhere`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
