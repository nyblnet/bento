#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The trail, the periods, and the three charts drawn from them.
//
//   node scripts/test-spaces-trail.ts
//   TZ=Pacific/Kiritimati node scripts/test-spaces-trail.ts
//
// RUN UNDER SEVERAL TIMEZONES, alongside the journal and calc rigs, for the
// reason those two are: a row key is a LOCAL day, and a date bug that only
// appears east of UTC passes every assertion written in UTC. Kiritimati is
// UTC+14 and Niue is UTC-11 — between them they bracket every hour of the day
// where "which day is it" has two answers.
//
// EVERY ASSERTION HERE IS BEHAVIOURAL. This zone has measured, twice, that a
// source-grep assertion passes straight through a live regression: the literal
// stayed in the file while the dispatch changed underneath it, 826/826 green.
// So these build a document, write rows into it, draw the chart, and assert on
// the numbers and the geometry that come back.

import {
  isDay, dayIndex, addDays, daysBetween, weekKey, monthKey, dayRange,
  trailKey, parseTrailKey, trailOf, trailIsForeign, seriesRows, slots,
  writeRow, backfill, clearTrail,
  pruneTrail, trailBytes,
  wasCut, spanOf, countOf, TRAIL_BUDGET, TRAIL_MAX,
  type Trail, type TrailRow,
} from '../spaces/src/trail.ts'
import { foldDottedMapKeys, DOC_MAPS } from '../spaces/src/docmaps.ts'
import { SPACES_FIELDS, SPACES_NOT_EDIT } from '../spaces/src/docclass.ts'
import { HISTORY_BUDGET, recordRevision, historyBytes } from '../spaces/src/history.ts'
import { observe, recordTrail, estimateField } from '../spaces/src/observe.ts'
import {
  periodsOf, periodOf, startPeriod, closePeriod, removePeriod, isLive,
  protectedDays, isPeriod,
} from '../spaces/src/periods.ts'
import { chartData, chartKind, CHART_KINDS } from '../spaces/src/charts.ts'
import { parseDoc, docContentKey, docForExport, FORMAT, type SpacesDoc, type Page } from '../spaces/src/model.ts'
import { extractSpace } from '../spaces/src/portable.ts'
import { DEFAULT_FIELDS } from '../spaces/src/fields.ts'
import { SPEC } from '../spaces/src/blocks.ts'
import { SPACES_SHAPE, SyncState } from '../spaces/src/sync/crdt.ts'
// BUNDLED (scripts/test-spaces.mjs): store.ts imports './model' without an
// extension, which node's strip-only TypeScript loader will not follow.
import { Store } from '../spaces/src/store.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const TZ = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
console.log(`bento/spaces trail   (TZ=${TZ})\n`)

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let seq = 0
const issue = (status: string, estimate?: number): Page => {
  const id = `i${++seq}`
  const blocks: Page['blocks'] = [
    { id: `${id}-s`, type: 'prop', key: 'status', value: status, html: `Status: ${status}` } as never,
  ]
  if (estimate !== undefined) {
    blocks.push({ id: `${id}-e`, type: 'prop', key: 'estimate', value: estimate, html: `Estimate: ${estimate}` } as never)
  }
  return { id, title: `Issue ${id}`, blocks }
}

function docOf(pages: Page[], extra: Partial<SpacesDoc> = {}): SpacesDoc {
  return {
    format: FORMAT,
    version: 1,
    docId: 'doc-rig',
    title: 'Rig space',
    pages,
    theme: { background: '#fff', color: '#000', accent: '#F7A600', fontFamily: 'sans-serif' },
    ...extra,
  } as SpacesDoc
}

/** A tracker: three open, two done, all estimated. */
const tracker = () => {
  seq = 0
  return docOf([
    issue('todo', 3), issue('doing', 5), issue('todo', 2),
    issue('done', 8), issue('cancelled', 1),
  ])
}

// ---------------------------------------------------------------------------
// 1. day arithmetic — the label is the thing, and it has no timezone
// ---------------------------------------------------------------------------
{
  ok(isDay('2026-09-11'), 'a real day is a day')
  ok(!isDay('2026-13-99'), 'a digit-shaped non-date is rejected, not rolled over')
  ok(!isDay('2026-02-30'), 'the 30th of February is rejected')
  ok(!isDay('2026-9-1') && !isDay('') && !isDay(undefined), 'loose shapes are rejected')

  // THE BUG THIS EXISTS TO CATCH: at UTC+14 and at UTC-11, one label must be
  // one number. `new Date('2026-01-01')` is UTC midnight, so anything that
  // round-trips a label through a local Date drifts by a day in half the world.
  ok(dayIndex('1970-01-01') === 0, 'the epoch label is day 0 whatever TZ this is')
  ok(dayIndex('2026-01-01') === 20454, '2026-01-01 is the same ordinal in every timezone')
  ok(addDays('2026-01-01', -1) === '2025-12-31', 'a day before new year is the year before')
  ok(addDays('2026-02-28', 1) === '2026-03-01', '2026 is not a leap year')
  ok(addDays('2024-02-28', 1) === '2024-02-29', '2024 is')
  // DST boundaries: 86,400,000 ms is not a day in Berlin in March, and this
  // must not care.
  ok(addDays('2026-03-28', 1) === '2026-03-29', 'the European DST boundary steps by one')
  ok(addDays('2026-11-01', 1) === '2026-11-02', 'the American one steps by one')
  ok(daysBetween('2026-01-01', '2026-12-31') === 364, 'a non-leap year is 364 steps end to end')
  ok(daysBetween('2026-09-11', '2026-09-10') === -1, 'backwards is negative, not an error')

  ok(weekKey('2026-09-07') === weekKey('2026-09-13'), 'Monday and the Sunday after share an ISO week')
  ok(weekKey('2026-09-13') !== weekKey('2026-09-14'), 'Monday starts a new one')
  ok(monthKey('2026-09-30') === '2026-09' && monthKey('2026-10-01') === '2026-10', 'months split at the 1st')

  ok(dayRange('2026-09-01', '2026-09-03').join(',') === '2026-09-01,2026-09-02,2026-09-03', 'a range is inclusive')
  ok(dayRange('2026-09-03', '2026-09-01').length === 0, 'a backwards range is empty, and does not throw')
  ok(dayRange('nonsense', '2026-09-01').length === 0, 'a malformed range is empty')
}

// ---------------------------------------------------------------------------
// 2. keys
// ---------------------------------------------------------------------------
{
  ok(trailKey('2026-09-11') === '2026-09-11', 'the default series is a bare date')
  ok(trailKey('2026-09-11', 'apollo') === 'apollo/2026-09-11', 'a series prefixes the key')
  const a = parseTrailKey('apollo/2026-09-11')
  ok(a?.series === 'apollo' && a.day === '2026-09-11', 'a series key parses back')
  const b = parseTrailKey('2026-09-11')
  ok(b?.series === '' && b.day === '2026-09-11', 'a bare key is the default series')
  ok(parseTrailKey('2026-13-99') === null, 'a key that is not a day is not a key')
  ok(parseTrailKey('a/b/2026-09-11') === null, 'a shape from a newer build is left alone')
}

// ---------------------------------------------------------------------------
// 3. observation — one counting rule, the board's
// ---------------------------------------------------------------------------
{
  const doc = tracker()
  const obs = observe(doc)!
  ok(!!obs, 'a space with a status field is observed')
  ok(obs.n.todo === 2 && obs.n.doing === 1 && obs.n.done === 1 && obs.n.cancelled === 1,
    'counts are per status OPTION id, not per phase group')
  ok(obs.e?.todo === 5 && obs.e?.done === 8, 'estimates are summed per option')
  ok(obs.x === undefined, 'no unestimated issues, so no x')

  // ARCHIVED PAGES ARE EXCLUDED — because viewRows excludes them, which is the
  // whole point of using the board's own counter.
  const arch = tracker()
  arch.pages[0].archived = true
  ok(observe(arch)!.n.todo === 1, 'an archived issue leaves the count')

  // UNESTIMATED
  const mixed = docOf([issue('todo', 3), issue('todo')])
  const m = observe(mixed)!
  ok(m.n.todo === 2 && m.e?.todo === 3 && m.x === 1, 'an unestimated issue is counted in n and in x')

  // NOT A TRACKER. `fieldsOf` falls back to DEFAULT_FIELDS while `doc.fields`
  // is absent, so the phase field is found — and the observation is EMPTY,
  // because a notes space has no issues. That is what makes tracking implicit
  // without turning itself on: no issues, no counts, no row (asserted below).
  const notes = docOf([{ id: 'p1', title: 'Notes', blocks: [{ id: 'b1', type: 'p', html: 'hello' }] }])
  ok(Object.keys(observe(notes)!.n).length === 0, 'a space with no issues observes nothing')
  // a document that DECLARES a schema with no phased field has no notion of
  // open at all, and is not observed
  const unphased = docOf([issue('todo', 1)], { fields: [{ key: 'tag', label: 'Tag', vt: 'text' }] } as never)
  ok(observe(unphased) === null, 'a schema that declares no phase field is not observed at all')

  // an unknown status counts under its own literal
  const future = docOf([issue('shipped')])
  ok(observe(future)!.n.shipped === 1, "a status this build does not know is counted literally")

  ok(estimateField(tracker())?.key === 'estimate', 'the estimate field is derived from the schema')
  ok(DEFAULT_FIELDS.some((f) => f.key === 'status'), 'the default schema still declares status')
}

// ---------------------------------------------------------------------------
// 4. writing — idempotent within a day, and never on open
// ---------------------------------------------------------------------------
{
  const doc = tracker()
  ok(doc.trail === undefined, 'a fresh tracker carries no trail key at all')

  recordTrail(doc, { today: '2026-09-11' })
  recordTrail(doc, { today: '2026-09-11' })
  recordTrail(doc, { today: '2026-09-11' })
  ok(Object.keys(trailOf(doc)).length === 1, 'three writes on one day produce exactly one key')
  ok(trailOf(doc)['2026-09-11'].n.todo === 2, 'and it holds the observation')

  // the LAST observation of the day wins
  ;(doc.pages[0].blocks[0] as { value: string }).value = 'done'
  recordTrail(doc, { today: '2026-09-11' })
  ok(trailOf(doc)['2026-09-11'].n.todo === 1, "a day's row is the LAST observation of that day")

  // NOT A TRACKER, NO ROWS
  const notes = docOf([{ id: 'p1', title: 'Notes', blocks: [{ id: 'b1', type: 'p', html: 'x' }] }])
  recordTrail(notes, { today: '2026-09-11' })
  ok(notes.trail === undefined, 'a notes space writes no rows and gains no key')

  // A FOREIGN TRAIL IS NEVER WRITTEN OVER
  const foreign = tracker()
  ;(foreign as Record<string, unknown>).trail = 'something a newer build meant'
  ok(trailIsForeign(foreign), 'a non-object trail is foreign')
  recordTrail(foreign, { today: '2026-09-11' })
  ok(foreign.trail === 'something a newer build meant', 'and it is left exactly as it was found')
}

// ---------------------------------------------------------------------------
// 5. EDITING THE PAST DOES NOT REWRITE IT
// ---------------------------------------------------------------------------
{
  const doc = tracker()
  recordTrail(doc, { today: '2026-09-09' })
  recordTrail(doc, { today: '2026-09-10' })
  const before = JSON.stringify(trailOf(doc)['2026-09-09'])
  const before10 = JSON.stringify(trailOf(doc)['2026-09-10'])

  // change an estimate, close an issue, add an issue — everything a day of work
  // does — and then write today.
  ;(doc.pages[0].blocks[1] as { value: number }).value = 99
  ;(doc.pages[1].blocks[0] as { value: string }).value = 'done'
  doc.pages.push(issue('todo', 13))
  recordTrail(doc, { today: '2026-09-11' })

  ok(JSON.stringify(trailOf(doc)['2026-09-09']) === before, "yesterday's row is byte-identical after today's edits")
  ok(JSON.stringify(trailOf(doc)['2026-09-10']) === before10, 'and so is the day before that')
  ok(trailOf(doc)['2026-09-11'].e!.todo === 114, "today's row moved, because today is what changed")

  // BACKFILL REFUSES TO OVERWRITE
  const row: TrailRow = { n: { todo: 1 } }
  ok(backfill(doc, '2026-09-09', row) === false, 'backfill refuses a key that is already there')
  ok(JSON.stringify(trailOf(doc)['2026-09-09']) === before, 'and changed nothing when it refused')
  ok(backfill(doc, '2026-09-01', row) === true, 'backfill writes an absent past key')
}

// ---------------------------------------------------------------------------
// 6. GAPS DRAW AS GAPS — the load-bearing assertion
// ---------------------------------------------------------------------------
{
  const doc = tracker()
  const trail: Trail = {
    '2026-09-01': { n: { todo: 4 } },
    '2026-09-02': { n: { todo: 3 } },
    // 03, 04, 05 NOT RECORDED — nobody opened the file
    '2026-09-06': { n: { todo: 1 } },
  }
  doc.trail = trail

  const s = slots(trail, '2026-09-01', '2026-09-06')
  ok(s.length === 6, 'six days, six slots')
  ok(s[2].kind === 'gap' && s[3].kind === 'gap' && s[4].kind === 'gap', 'the three unrecorded days are gaps')
  ok(s[2].row === undefined, 'a gap carries no row — there is nothing to carry')
  ok(s[0].kind === 'day' && s[0].anchor, 'an observed day is a day')

  const period = { label: 'Sprint', from: '2026-09-01', to: '2026-09-06' }
  // today is AFTER the window, so nothing is derived live and the whole chart
  // comes from the record
  const data = chartData(doc, period, 'burndown', '2026-09-20')
  ok(data.runs.length === 2, 'a gap BREAKS the line: two runs, not one')
  ok(data.runs[0].length === 2 && data.runs[1].length === 1, 'two points before the gap, one after')
  ok(data.gaps.length === 1 && data.gaps[0][0] === '2026-09-03' && data.gaps[0][1] === '2026-09-05',
    'the gap is reported as its own range, for the hatched band')

  // THE FAILURE THIS RIG EXISTS FOR: an absent day must never become a zero.
  const values = data.runs.flat().map((p) => p.v[0])
  ok(!values.includes(0), 'no zero point was invented for an unrecorded day')
  ok(values.length === 3, 'exactly three points — one per recorded day, none per gap')
  ok(data.runs.every((r) => r.every((p) => p.kind === 'day')),
    'nothing was carried forward: every point is a day someone observed')

  // ABSENT IS NOT ZERO, and they must be distinguishable
  const withZero = { ...trail, '2026-09-04': { n: {} } as TrailRow }
  const zdata = chartData(docOf(doc.pages, { trail: withZero }), period, 'burndown', '2026-09-20')
  ok(zdata.runs.flat().some((p) => p.v[0] === 0), 'a day with nothing open IS a point at zero')
  ok(zdata.gaps.length === 2, 'and the days either side of it are still two separate gaps')
}

// ---------------------------------------------------------------------------
// 7. THINNED ROWS ARE A THIRD STATE
// ---------------------------------------------------------------------------
{
  const doc = tracker()
  const trail: Trail = {
    '2026-09-01': { n: { todo: 9 } },
    '2026-09-08': { n: { todo: 5 }, s: 8 },   // stands for 09-01..09-08
    '2026-09-09': { n: { todo: 4 } },
  }
  doc.trail = trail
  const s = slots(trail, '2026-09-01', '2026-09-09')
  ok(s[1].kind === 'sample' && !s[1].anchor, 'a covered day is a sample, and not a point')
  ok(s[7].kind === 'sample' && s[7].anchor, 'the sample row anchors on its own day')
  ok(s.every((x) => x.kind !== 'gap'), 'a span covers its days: no gap inside it')
  ok(s[0].anchor && s[0].kind === 'day', 'a span never buries a day that was observed in its own right')

  const data = chartData(doc, { label: 's', from: '2026-09-01', to: '2026-09-09' }, 'burndown', '2026-09-30')
  ok(data.runs.length === 1, 'a covered span does not break the line')
  ok(data.runs[0].map((p) => p.kind).join(',') === 'day,sample,day',
    'the sample point is marked as one, so its segment can be drawn dashed')
}

// ---------------------------------------------------------------------------
// 8. the budget — tiers, never fails, never averages
// ---------------------------------------------------------------------------
{
  // THE TRAIL'S OWN CEILING, beside history's. 128 KB + 32 KB = the 160 KB
  // joint ceiling that was ruled acceptable; each side tiers on its own.
  ok(TRAIL_BUDGET === 32 * 1024, `TRAIL_BUDGET is 32 KB (${TRAIL_BUDGET} B)`)
  ok(HISTORY_BUDGET + TRAIL_BUDGET <= 160 * 1024,
    `history + trail ceilings sum to at most 160 KB (${(HISTORY_BUDGET + TRAIL_BUDGET) / 1024} KB)`)

  // a year of daily rows, measured
  //
  // THE COUNTS VARY PER DAY, and that is not decoration. With a uniform
  // fixture the "never averages" assertion below passes VACUOUSLY — the mean
  // of two identical rows is that row — and this rig watched a deliberate
  // averaging sabotage sail straight through it before the numbers were made
  // to move. An assertion nobody has seen fail is not evidence.
  const year: Trail = {}
  for (let i = 0; i < 365; i++) {
    year[addDays('2026-01-01', i)] = {
      n: { backlog: 12 + (i % 7), todo: 9 + (i % 5), doing: 4 + (i % 3), review: 2, done: 31 + i, cancelled: 3 },
      e: { backlog: 40 + i, todo: 27 + (i % 11), doing: 13, review: 5, done: 96 + i, cancelled: 8 },
      x: 4,
    }
  }
  const yearBytes = JSON.stringify(year).length
  console.log(`        · a year of full daily rows: ${yearBytes} bytes (${(yearBytes / 1024).toFixed(1)} KB), ` +
    `${Math.round(yearBytes / 365)} bytes/row`)
  const countOnly: Trail = {}
  for (const k of Object.keys(year)) countOnly[k] = { n: year[k].n }
  console.log(`        · counts only: ${JSON.stringify(countOnly).length} bytes ` +
    `(${(JSON.stringify(countOnly).length / 1024).toFixed(1)} KB)`)

  // TIERING: over the allowance, resolution goes from the distant past first.
  const pruned = pruneTrail(year, 20 * 1024)
  ok(JSON.stringify(pruned).length <= 20 * 1024, 'pruning brings the trail under its allowance')
  ok(Object.keys(pruned).length > 0, 'and it tiers rather than failing to nothing')
  ok(Object.keys(pruned).length < 365, 'rows were dropped')

  // NEVER AVERAGES: every surviving row's counts equal some original row's.
  const originals = new Set(Object.values(year).map((r) => JSON.stringify(r.n)))
  const invented = Object.values(pruned).filter((r) => !originals.has(JSON.stringify(r.n)))
  ok(invented.length === 0, 'every surviving row is an observation somebody made, never an average')

  // the dropped-from-the-front flag
  ok(wasCut(pruned), 'the oldest survivor is stamped cut, so the chart says "recording starts here"')
  const cutCount = Object.values(pruned).filter((r) => r.cut).length
  ok(cutCount === 1, 'exactly one row carries it')

  // spans are stamped and are truthful: a row never claims to cover a day
  // before the earliest row it replaced
  const kept = seriesRows(pruned)
  let truthful = true
  for (let i = 1; i < kept.length; i++) {
    const back = spanOf(kept[i].row) - 1
    if (daysBetween(kept[i - 1].day, kept[i].day) < back) truthful = false
  }
  ok(truthful, 'no span reaches back over another surviving row')

  // MONOTONIC: a tighter allowance is never bigger
  const sizes = [40 * 1024, 20 * 1024, 8 * 1024, 2 * 1024]
    .map((b) => JSON.stringify(pruneTrail(year, b)).length)
  ok(sizes.every((v, i) => i === 0 || v <= sizes[i - 1]), 'a tighter allowance never produces a bigger trail')

  // THE ROW CAP
  ok(Object.keys(pruneTrail(year, 10 * 1024 * 1024, 30)).length <= 30, 'the row cap holds however roomy the budget')
  ok(TRAIL_MAX === 400, 'and the default cap is 400 rows')

  // A LIVE PERIOD IS NOT THINNED UNDERNEATH ITSELF
  const live = new Set(dayRange('2026-12-01', '2026-12-31'))
  const guarded = pruneTrail(year, 4 * 1024, TRAIL_MAX, (d) => live.has(d))
  const keptLive = Object.keys(guarded).filter((k) => live.has(k))
  ok(keptLive.length === 31, "every day of a running period survives, at full resolution")
  ok(keptLive.every((k) => guarded[k].s === undefined), 'and none of them was turned into a sample')
}

// ---------------------------------------------------------------------------
// 9. periods
// ---------------------------------------------------------------------------
{
  const doc = tracker()
  const id = startPeriod(doc, 'pd-1', {
    label: 'Sprint 12', from: '2026-09-07', to: '2026-09-20', today: '2026-09-11',
  })
  ok(id === 'pd-1', 'a period is committed under the id it was given')
  const p = periodOf(doc, 'pd-1')!
  ok(p.base!.n === 5, 'the baseline is a TOTAL, not a list of page ids')
  ok(p.base!.e === 19, 'and the summed estimate')
  ok(p.base!.at === '2026-09-11', 'base.at records the day the baseline was ACTUALLY taken')
  ok(JSON.stringify(p).indexOf('i1') < 0, 'no page id appears anywhere in a period')
  ok(trailOf(doc)['2026-09-11'] !== undefined, "committing inside the window writes today's row")
  ok(trailOf(doc)['2026-09-07'] === undefined, 'and fabricates no past key — the days before are gaps')

  // malformed periods are not periods
  ok(startPeriod(doc, 'pd-x', { label: 'x', from: '2026-09-20', to: '2026-09-07', today: '2026-09-11' }) === null,
    'a period whose `to` precedes its `from` is refused')
  ok(!isPeriod({ label: 'x', from: '2026-13-99', to: '2026-09-07' }), 'and one with a non-date is not a period')
  ok(!isPeriod(null) && !isPeriod('x') && !isPeriod([]), 'neither is anything that is not an object')
  const junk = docOf([], { periods: { bad: { from: '2026-09-20', to: '2026-09-01', label: 'x' } } as never })
  ok(Object.keys(periodsOf(junk)).length === 0, 'an unreadable period is simply not returned')
  ok(junk.periods !== undefined, 'and is left in the file untouched')

  ok(isLive(p, '2026-09-25'), 'a period is live while it runs')
  ok(isLive(p, '2026-10-10'), 'and for thirty days after')
  ok(!isLive(p, '2026-11-30'), 'and not forever')
  closePeriod(doc, 'pd-1')
  ok(!isLive(periodOf(doc, 'pd-1')!, '2026-09-08'), 'closing one ends it immediately')

  const guard = protectedDays(doc, '2026-09-11')
  ok(!guard('2026-09-08'), 'a closed period protects nothing')
  startPeriod(doc, 'pd-2', { label: 'now', from: '2026-09-07', to: '2026-09-20', today: '2026-09-11' })
  const guard2 = protectedDays(doc, '2026-09-11')
  ok(guard2('2026-09-08') && !guard2('2026-08-08'), 'a live one protects its own window and nothing else')

  removePeriod(doc, 'pd-1')
  removePeriod(doc, 'pd-2')
  ok(doc.periods === undefined, 'removing the last period deletes the key — never an empty object')
}

// ---------------------------------------------------------------------------
// 10. the charts
// ---------------------------------------------------------------------------
{
  const doc = tracker()
  const period = { label: 'S', from: '2026-09-01', to: '2026-09-10', base: { at: '2026-09-01', n: 5, e: 19 } }
  doc.trail = {
    '2026-09-01': { n: { todo: 3, done: 1 }, e: { todo: 10, done: 8 } },
    '2026-09-02': { n: { todo: 2, done: 2 }, e: { todo: 6, done: 12 } },
  }

  const burn = chartData(doc, period, 'burndown', '2026-09-30')
  ok(burn.units === 'points', 'rows carrying estimates are charted in points')
  ok(burn.runs[0][0].v[0] === 10 && burn.runs[0][1].v[0] === 6, 'a burndown draws the OPEN work remaining')
  ok(burn.ideal === 19, 'the ideal line starts at the committed baseline')
  ok(burn.bands.length === 1, 'one line')

  const up = chartData(doc, period, 'burnup', '2026-09-30')
  ok(up.bands.length === 2, 'a burnup draws two lines')
  ok(up.runs[0][0].v[0] === 8 && up.runs[0][0].v[1] === 18, 'completed, and total scope')
  ok(up.committed?.v === 19 && up.committed.at === '2026-09-01', 'plus the committed scope, and when it was committed')

  const cfd = chartData(doc, period, 'cfd', '2026-09-30')
  ok(cfd.bands.length === 6, 'a CFD has a band per declared status option')
  ok(cfd.bands.map((b) => b.id).join(',') === 'backlog,todo,doing,review,done,cancelled',
    'in the schema order the board declares')
  ok(cfd.runs[0][0].v[cfd.bands.findIndex((b) => b.id === 'todo')] === 10, 'each band carries its own option')

  // counts, when nothing is estimated
  const plain = docOf(doc.pages, { trail: { '2026-09-01': { n: { todo: 3, done: 1 } } } })
  ok(chartData(plain, period, 'burndown', '2026-09-30').units === 'issues',
    'rows with no estimates are charted as issue counts')

  // AN OPTION THE SCHEMA NO LONGER DECLARES
  const drifted = docOf(doc.pages, { trail: { '2026-09-01': { n: { blocked: 2 } } } })
  const d = chartData(drifted, period, 'cfd', '2026-09-30')
  ok(d.bands.some((b) => b.unknown && b.id === 'blocked'), 'a band whose option is gone is kept and marked unknown')

  // TODAY IS DERIVED, NOT READ
  const live = tracker()
  live.trail = { '2026-09-11': { n: { todo: 999 }, e: { todo: 999 } } }
  const before = chartData(live, { label: 'S', from: '2026-09-10', to: '2026-09-12' }, 'burndown', '2026-09-11')
  const todayPoint = before.runs.flat().find((p) => p.day === '2026-09-11')!
  ok(todayPoint.live === true, "today's point is marked derived")
  ok(todayPoint.v[0] === 10, 'and it is counted from live state, not read from the stored 999')
  ;(live.pages[0].blocks[1] as { value: number }).value = 100
  const after = chartData(live, { label: 'S', from: '2026-09-10', to: '2026-09-12' }, 'burndown', '2026-09-11')
  ok(after.runs.flat().find((p) => p.day === '2026-09-11')!.v[0] === 107,
    'change an estimate now and today moves immediately — the falsifiable half of the rule')

  // the future is not drawn
  ok(!after.runs.flat().some((p) => p.day > '2026-09-11'), 'a burndown does not draw the future')

  // a period whose window holds nothing
  const empty = chartData(tracker(), { label: 'S', from: '2026-01-01', to: '2026-01-10' }, 'burndown', '2026-09-11')
  ok(empty.empty === true, 'a window with no observation says so instead of drawing an empty graph')

  // MALFORMED ROWS MUST NOT THROW AND MUST NOT MISLEAD
  const nasty = docOf(doc.pages, {
    trail: {
      '2026-09-01': { n: { todo: -5, doing: NaN as never, done: 'x' as never } },
      '2026-09-02': { n: { todo: 2 }, s: -3 },
    },
  })
  let threw = false
  let nastyData: ReturnType<typeof chartData> | null = null
  try { nastyData = chartData(nasty, period, 'cfd', '2026-09-30') } catch { threw = true }
  ok(!threw, 'negative, NaN and non-numeric counts do not throw')
  ok(nastyData!.runs.flat().every((p) => p.v.every((v) => Number.isFinite(v) && v >= 0)),
    'and none of them draws a misleading value')
  ok(countOf({ n: { todo: -5 } }, 'todo') === 0, 'a negative count reads as zero')
  ok(countOf({ n: {} }, 'toString') === 0, 'a prototype key is not a count')

  ok(CHART_KINDS.length === 3 && chartKind('nonsense') === 'burndown', 'an unknown kind falls back rather than blanking')
  ok(SPEC.get('chart')?.custom === true, 'the chart block is registered and renders custom')
  ok(SPEC.get('chart')?.text !== true, "and carries no inline host — its html is the readable fallback")
}

// ---------------------------------------------------------------------------
// 11. additivity — a round trip changes nothing
// ---------------------------------------------------------------------------
{
  const doc = tracker()
  recordTrail(doc, { today: '2026-09-11' })
  startPeriod(doc, 'pd-1', { label: 'S', from: '2026-09-01', to: '2026-09-20', today: '2026-09-11' })
  // a field from a NEWER build, inside a row
  ;(trailOf(doc)['2026-09-11'] as Record<string, unknown>).futureThing = { deep: [1, 2] }

  const json = JSON.stringify(doc)
  const res = parseDoc(json)
  ok(res.ok, 'a trail-carrying document parses')
  if (res.ok) {
    ok(JSON.stringify(res.doc.trail) === JSON.stringify(doc.trail), 'the trail round-trips byte-identically')
    ok(JSON.stringify(res.doc.periods) === JSON.stringify(doc.periods), 'and so do the periods')
    ok(JSON.stringify((res.doc.trail as Trail)['2026-09-11']).includes('futureThing'),
      'including a row field this build has never heard of')
  }

  // THE DOTTED-KEY HAZARD, and its fold — for `periods`, the one doc-level
  // map spaces declares. `trail` is not a map and never synced, so no peer can
  // ever send `trail.<day>`; a literal key of that name is an unknown field
  // like any other and is left exactly where it is.
  const damaged = JSON.parse(json) as Record<string, unknown>
  damaged['periods.pd-2'] = { label: 'from an older peer', from: '2026-09-01', to: '2026-09-02' }
  damaged['trail.2026-09-10'] = { n: { todo: 7 } }
  damaged['not.a.map'] = 'left alone'
  const folded = parseDoc(JSON.stringify(damaged))
  ok(folded.ok, 'a document damaged by an older peer still parses')
  if (folded.ok) {
    ok(periodOf(folded.doc, 'pd-2')?.label === 'from an older peer', 'the dotted periods key is folded back into the map')
    ok(folded.doc['periods.pd-2'] === undefined, 'and the junk key is gone')
    ok(folded.doc['trail.2026-09-10'] !== undefined && trailOf(folded.doc)['2026-09-10'] === undefined,
      'a dotted trail key is NOT folded — trail is not a synced map')
    ok(folded.doc['not.a.map'] === 'left alone', 'a dotted key that is not a declared map is untouched')
  }
  // the fold never clobbers
  const both = { periods: { 'pd-1': { label: 'placed' } }, 'periods.pd-1': { label: 'stray' } } as Record<string, unknown>
  foldDottedMapKeys(both)
  ok((both.periods as Record<string, { label: string }>)['pd-1'].label === 'placed',
    'a folded key never overwrites one already in place')
  // nor overwrites a `periods` some newer build gave another shape
  const foreign = { periods: 'a newer shape', 'periods.pd-1': { label: 'stray' } } as Record<string, unknown>
  foldDottedMapKeys(foreign)
  ok(foreign.periods === 'a newer shape' && foreign['periods.pd-1'] !== undefined,
    'a foreign periods value is never folded over')

  // THE SHAPE: periods per key, trail not at all
  ok(DOC_MAPS.length === 1 && DOC_MAPS[0] === 'periods', 'DOC_MAPS is exactly [periods]')
  ok(SPACES_SHAPE.maps.has('periods') && !SPACES_SHAPE.maps.has('trail'),
    'the sync shape merges periods per key, and does not map trail')
  ok(SPACES_SHAPE.skipDoc.has('trail') && SPACES_SHAPE.skipDoc.has('revisions'),
    'the sync shape skips trail (and revisions) outright')
  ok(SPACES_SHAPE.maps.has('assets'), 'and still declares the maps it always did')
}

// ---------------------------------------------------------------------------
// 12. clearing and stripping
// ---------------------------------------------------------------------------
{
  const doc = tracker()
  recordTrail(doc, { today: '2026-09-11' })
  clearTrail(doc)
  ok(doc.trail === undefined, 'clearing deletes the key — never trail: {}')
  ok(!('trail' in doc), 'a cleared space is byte-identical to one that never recorded')

  // THE CLASSES. No builder strips the trail by hand: the kernel's copy table
  // does, from the field map (scripts/test-spaces-copytiers.ts holds every
  // tier and sweeps the builders for hand strips).
  ok(SPACES_FIELDS.trail === 'history', 'trail is classed history')
  ok(SPACES_FIELDS.periods === 'content', 'periods is classed content')
  ok(!SPACES_NOT_EDIT.has('trail'), 'trail is NOT in SPACES_NOT_EDIT: it is written while editing')

  const shared = tracker()
  recordTrail(shared, { today: '2026-09-11' })
  startPeriod(shared, 'pd-1', { label: 'S', from: '2026-09-01', to: '2026-09-20', today: '2026-09-11' })
  const copy = docForExport(shared)
  ok(copy.trail === undefined, 'Copy document JSON carries no trail')
  ok(copy.periods !== undefined, 'but keeps the periods — content the chart blocks name')
  ok(shared.trail !== undefined, 'and the original is untouched')

  // the page extract drops the history class too
  const ex = extractSpace(shared, shared.pages[0].id, { docId: 'doc-x', subtree: false, now: '2026-09-11T00:00:00Z' })
  ok(ex.doc.trail === undefined, 'a page extract carries no trail')
}

// ---------------------------------------------------------------------------
// 13. two replicas, one day
// ---------------------------------------------------------------------------
{
  const base = tracker()
  recordTrail(base, { today: '2026-09-09' })
  const json = JSON.stringify(base)

  const a = new SyncState('actor-a')
  const b = new SyncState('actor-b')
  const docA = JSON.parse(json) as SpacesDoc
  const docB = JSON.parse(json) as SpacesDoc
  a.adopt(docA as never)
  b.adopt(docB as never)

  // A TRAIL ROW MINTS NO OPS. Each replica keeps its own record of what it saw.
  const beforeA = JSON.parse(JSON.stringify(docA)) as SpacesDoc
  recordTrail(docA, { today: '2026-09-10' })
  const opsA = a.diff(beforeA as never, docA as never)
  ok(opsA.length === 0, `a trail-only change diffs to zero ops (${opsA.length})`)
  b.apply(docB as never, opsA)
  ok(trailOf(docB)['2026-09-10'] === undefined, "and B's file never receives A's row")

  // a content edit beside a trail row: only the content travels
  const before2A = JSON.parse(JSON.stringify(docA)) as SpacesDoc
  ;(docA.pages[0].blocks[0] as { value: string }).value = 'done'
  recordTrail(docA, { today: '2026-09-11' })
  const ops2A = a.diff(before2A as never, docA as never)
  ok(ops2A.length > 0 && ops2A.every((o) => !JSON.stringify(o).includes('2026-09-11')),
    'an edit syncs; the row recorded beside it does not')
  b.apply(docB as never, ops2A)
  ok((docB.pages[0].blocks[0] as { value: string }).value === 'done', 'B has the edit')
  ok(trailOf(docB)['2026-09-11'] === undefined, 'and not the row')

  // PERIODS ARE A PER-KEY MAP: two people starting different periods both keep theirs
  const bpA = JSON.parse(JSON.stringify(docA)) as SpacesDoc
  startPeriod(docA, 'pd-a', { label: 'A', from: '2026-09-11', to: '2026-09-24', today: '2026-09-11' })
  const pA = a.diff(bpA as never, docA as never)
  const bpB = JSON.parse(JSON.stringify(docB)) as SpacesDoc
  startPeriod(docB, 'pd-b', { label: 'B', from: '2026-09-11', to: '2026-09-24', today: '2026-09-11' })
  const pB = b.diff(bpB as never, docB as never)
  a.apply(docA as never, pB)
  b.apply(docB as never, pA)
  ok(periodOf(docA, 'pd-a') !== undefined && periodOf(docA, 'pd-b') !== undefined, 'concurrent periods: both survive on A')
  ok(periodOf(docB, 'pd-a') !== undefined && periodOf(docB, 'pd-b') !== undefined, 'and on B — per key, not one register')
  ok(pA.every((o) => !JSON.stringify(o).includes('"trail')), "the period's backfilled row did not ride along")
}

// ---------------------------------------------------------------------------
// 14. undo — a record is not an editing step, a period is
// ---------------------------------------------------------------------------
{
  const doc = tracker()
  const store = new Store(doc)
  store.checkpoint()

  // a row written OUTSIDE a commit, the way the autosave debounce writes it
  recordTrail(store.doc, { today: '2026-09-11' })
  ok(trailOf(store.doc)['2026-09-11'] !== undefined, 'a row lands outside any commit')

  store.commit(() => { store.doc.title = 'Renamed' })
  recordTrail(store.doc, { today: '2026-09-12' })
  store.undo()
  ok(store.doc.title === 'Rig space', 'undo takes back the edit')
  ok(trailOf(store.doc)['2026-09-11'] !== undefined && trailOf(store.doc)['2026-09-12'] !== undefined,
    'and takes back NEITHER row — a record is not an editing step')

  // A PERIOD IS one. It is authored, inside a commit, and ⌘Z must reach it.
  store.commit(() => {
    startPeriod(store.doc, 'pd-undo', { label: 'S', from: '2026-09-11', to: '2026-09-24', today: '2026-09-11' })
  })
  ok(periodOf(store.doc, 'pd-undo') !== undefined, 'starting a period is a commit')
  store.undo()
  ok(periodOf(store.doc, 'pd-undo') === undefined, 'and ⌘Z takes it back, like any other edit')
  ok(trailOf(store.doc)['2026-09-11'] !== undefined, 'while the rows it wrote stand')

  // REDO keeps the live trail too
  store.redo()
  ok(periodOf(store.doc, 'pd-undo') !== undefined, 'redo brings the period back')
  recordTrail(store.doc, { today: '2026-09-13' })
  store.undo(); store.redo()
  ok(trailOf(store.doc)['2026-09-13'] !== undefined, 'a row recorded after a redo survives another undo/redo')

  // REPLACE FROM JSON with Copy document JSON's output (which drops trail by the
  // copy table) must not wipe the trail
  const rows = Object.keys(trailOf(store.doc)).sort().join(',')
  const pasted = docForExport(store.doc)
  ok(pasted.trail === undefined, 'Copy document JSON carries no trail')
  store.replaceDoc(JSON.parse(JSON.stringify(pasted)) as SpacesDoc)
  ok(Object.keys(trailOf(store.doc)).sort().join(',') === rows,
    'replaceDoc keeps the LIVE trail — Replace from JSON does not wipe it')
  // and a pasted doc carrying a DIFFERENT trail cannot overwrite the live one
  const forged = JSON.parse(JSON.stringify(store.doc)) as SpacesDoc
  forged.trail = { '2020-01-01': { n: { todo: 999 } } }
  store.replaceDoc(forged)
  ok(trailOf(store.doc)['2020-01-01'] === undefined && Object.keys(trailOf(store.doc)).sort().join(',') === rows,
    'a restored or pasted trail never replaces the live record')
}

// ---------------------------------------------------------------------------
// 14b. the recovery key — a row recorded while editing is unsaved work
// ---------------------------------------------------------------------------
{
  const doc = tracker()
  const before = docContentKey(doc)
  recordTrail(doc, { today: '2026-09-11' })
  ok(docContentKey(doc) !== before, 'an edit-time trail row raises the recovery key')
  // a row change on its own — no content edit beside it — still moves the key
  const k1 = docContentKey(doc)
  writeRow(doc, '2026-09-11', { n: { todo: 1 } })
  ok(docContentKey(doc) !== k1, 'a trail change alone moves the recovery key')
  const same = JSON.parse(JSON.stringify(doc)) as SpacesDoc
  ok(docContentKey(same) === docContentKey(doc), 'an identical document keys identically')
}

// ---------------------------------------------------------------------------
// 15. the joint ceiling — history and trail, both at their budgets
// ---------------------------------------------------------------------------
{
  // A REAL fixture, not arithmetic on the constants: a tracker saved many
  // times with large paragraph rewrites (history.ts tiers it to HISTORY_BUDGET)
  // and recorded every day for well over a year (trail.ts tiers it to
  // TRAIL_BUDGET). The record the file carries about itself must stay inside
  // the 160 KB that was ruled acceptable.
  const doc = tracker()
  doc.pages[0].blocks.push({ id: 'para', type: 'p', html: 'start' } as never)
  const statuses = ['todo', 'doing', 'review', 'done']
  for (let i = 0; i < 500; i++) {
    const day = addDays('2025-06-01', i)
    for (let j = 0; j < doc.pages.length; j++) {
      ;(doc.pages[j].blocks[0] as { value: string }).value = statuses[(i + j) % statuses.length]
      const est = doc.pages[j].blocks.find((b) => (b as { key?: string }).key === 'estimate')
      if (est) (est as { value: number }).value = 1 + ((i * 7 + j) % 13)
    }
    ;(doc.pages[0].blocks.find((b) => b.id === 'para') as { html: string }).html =
      `day ${i}: ` + Array.from({ length: 160 }, (_, w) => `word${(i * 31 + w) % 997}`).join(' ')
    recordTrail(doc, { today: day })
    recordRevision(doc)
  }
  const hb = historyBytes(doc)
  const tb = trailBytes(doc)
  console.log(`        · after 500 days: history ${(hb / 1024).toFixed(1)} KB, trail ${(tb / 1024).toFixed(1)} KB, ` +
    `${Object.keys(trailOf(doc)).length} rows`)
  ok(hb <= HISTORY_BUDGET, `history stays within HISTORY_BUDGET (${hb} B)`)
  ok(tb <= TRAIL_BUDGET, `the trail stays within TRAIL_BUDGET (${tb} B)`)
  ok(hb + tb <= 160 * 1024, `history + trail stay within the 160 KB joint ceiling (${((hb + tb) / 1024).toFixed(1)} KB)`)
  ok(hb > HISTORY_BUDGET * 0.5 && tb > TRAIL_BUDGET * 0.5,
    'and both actually used their budgets, so the ceiling was exercised')
  ok(wasCut(trailOf(doc)) || Object.values(trailOf(doc)).some((r) => (r.s ?? 1) > 1),
    'the trail tiered (thinned or cut) to get there rather than failing')
}


console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
