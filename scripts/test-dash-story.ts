#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash data-story rig.
//
//   node scripts/test-dash-story.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Everything visible about a story — the overlay, the dots,
// the fullscreen — is a thing you can look at. What is NOT visible is whether
// the animation between two steps is telling the truth, and every failure below
// produces a smooth, confident, wrong picture:
//
//   1. A GAP THAT GROWS OUT OF THE FLOOR. A category with no value is `null`
//      (chart.ts: "a gap, never a zero"). Interpolate that as 0 and the bar
//      rises from the axis, which is a claim that the value USED TO BE ZERO.
//      Nothing in the data ever said so, and there is no frame of the animation
//      where a reader could tell. The whole point of the module is this one
//      rule, so it gets the most checks.
//   2. A BAR THAT CHANGES WHAT IT MEANS. Two steps rarely have the same
//      categories or the same series — that is what a story IS. Align them by
//      POSITION rather than by name and "Revenue" tweens into "Cost" while the
//      legend keeps saying Revenue.
//   3. A FILTER THAT REACHES THE CHART HALFWAY. The step's filter narrows the
//      chart by handing `optionFor` the visible slice of every bound column.
//      Hand it the slice for SOME columns and it zips a four-row x axis against
//      a six-row series: every label carries a number from a different row, and
//      the chart looks entirely normal.
//   4. A STORY THAT DOES NOT SURVIVE THE FILE. A filter's checkbox list is a
//      `Set`, and `JSON.stringify(new Set([1]))` is `{}` — the step would come
//      back matching nothing, which reads as "the data vanished" rather than as
//      a broken round trip. And a step field this build has never heard of has
//      to come back out unchanged (PLATFORM §3): there is no server to migrate
//      the files already on disk.
//   5. A SETTING THAT WILL NOT SWITCH OFF. `filters`, `sorts` and `caption` are
//      additive fields where ABSENT means none. Storing `[]` or `""` leaves the
//      document changed after a round trip; every reader diffs it, and collab
//      ships an op for a document that is back where it started. Same rule
//      panels.ts follows for `totals` and `frozen`.
//
// The last section runs ELEVEN NEGATIVE CONTROLS: each one is a plausible
// implementation of something above, and each has to be caught by a check that
// the real implementation passes. A rig where every mutation still passes is a
// rig that proves nothing.

import { registerHooks } from 'node:module'

// story.ts imports its stylesheet, which is Vite's job and not Node's — the
// same stub test-dash-panels.ts uses, and for the same reason: `import
// './story.css'` is how every Bento module co-locates a surface with its
// styles, and a rig is not a reason to break the pattern.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const {
  normalizeStory, readStory, toPredicate, fromPredicate, toFilters, fromFilters,
  stepOrder, viewColumns, stepOption, mergeCats, alignOptions, canMorph, morphOption,
  captureStep, moveStep, addStep, removeStep, editStep, storyPatch, sheetOf, STORY_OP,
} = await import('../dash/src/story.ts')

type Story = import('../dash/src/story.ts').Story
type StoryStep = import('../dash/src/story.ts').StoryStep
type StoredFilter = import('../dash/src/story.ts').StoredFilter

const { optionFor } = await import('../dash/src/chart.ts')
type ChartBinding = import('../dash/src/chart.ts').ChartBinding

type TableSheet = import('../dash/src/model.ts').TableSheet
type DashDoc = import('../dash/src/model.ts').DashDoc
type ColumnFilter = import('../dash/src/filter.ts').ColumnFilter

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string): void {
  checks++
  if (!cond) { failures++; console.error(`  ✗ ${msg}`) }
}
function section(name: string): void {
  console.log(`\n${name}`)
}

type Opt = Record<string, any>

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// --- the fixture -------------------------------------------------------------
//
// Six rows over four regions, with West holding no number at all — so the
// derived chart carries a REAL gap produced by chart.ts's own aggregate path,
// not one this rig invented to make a point.

function fixture(): TableSheet {
  return {
    id: 'sales',
    name: 'Sales',
    kind: 'table',
    rids: [[1, 6]],
    columns: [
      { id: 'region', name: 'Region', type: 'text' },
      { id: 'amount', name: 'Amount', type: 'number' },
      { id: 'cost', name: 'Cost', type: 'number' },
    ],
    data: {
      region: { enc: 'raw', v: ['North', 'South', 'East', 'North', 'South', 'West'] },
      amount: { enc: 'raw', v: [10, 20, 30, 40, 50, null] },
      cost: { enc: 'raw', v: [5, 8, 12, 15, 20, 3] },
    },
    steps: [],
  } as unknown as TableSheet
}

const doc = (): DashDoc => ({
  format: 'bento/dash', version: 1, docId: 'd-test', title: 'T', sheets: [fixture()],
} as unknown as DashDoc)

const BAR: ChartBinding = { x: 'region', series: ['amount'], kind: 'bar', aggregate: 'sum' }

const step = (over: Partial<StoryStep> = {}): StoryStep =>
  ({ id: 's1', sheet: 'sales', chart: BAR, ...over }) as StoryStep

const dataOf = (opt: Opt, i = 0): Array<number | null> => opt.series[i].data
const catsOf = (opt: Opt): string[] => opt.xAxis.data

// --- 1. the document field ---------------------------------------------------

section('the step model is additive')
{
  const raw = {
    steps: [
      { id: 'a', sheet: 'sales', caption: 'One', chart: BAR, hologram: { spin: 3 } },
      { id: 'b', sheet: 'sales', transition: 'kaleidoscope', duration: 1.2 },
    ],
    // A whole story-level field from a build that does not exist yet.
    soundtrack: 'asset:mp3',
  }
  const s = normalizeStory(structuredClone(raw))
  ok(eq(s, raw), 'a story round-trips through normalizeStory byte-identically, unknown fields and all')
  ok((s.steps[0] as any).hologram.spin === 3, 'an unknown STEP field survives')
  ok((s as any).soundtrack === 'asset:mp3', 'an unknown STORY field survives')
  ok(s.steps[1].transition === 'kaleidoscope', 'an unknown transition parses rather than throwing')

  const minted = normalizeStory({ steps: [{ sheet: 'sales' }] })
  ok(typeof minted.steps[0].id === 'string' && minted.steps[0].id.length > 0,
    'a step with no id gets one — the step is somebody work, the id is bookkeeping')

  ok(readStory({ sheets: [] } as unknown as DashDoc) === null, 'a document with no story reads as null')
  ok(readStory({ sheets: [], story: { steps: [] } } as unknown as DashDoc)?.steps.length === 0,
    'a document with an empty story reads as an empty story, not null')

  ok(normalizeStory({ steps: 'nope' as unknown as [] }).steps.length === 0,
    'a malformed steps field degrades to no steps rather than throwing in front of an audience')
  ok(normalizeStory({ steps: [1, null, { sheet: 'x' }] as unknown as [] }).steps.length === 1,
    'non-object entries in steps are dropped')
}

section('the patch the store still needs')
{
  const p = storyPatch({ steps: [step()] })
  ok(p.op === STORY_OP && eq(Object.keys(p.props), ['story']), 'a story writes as one document-level prop')
  const clear = storyPatch({ steps: [] })
  ok(eq(clear.drop, ['story']) && eq(clear.props, {}),
    'clearing the last step DROPS the key by name — `props:{story:undefined}` would vanish in JSON and reach every replica as a no-op')
}

// --- 2. filters survive JSON -------------------------------------------------

section('filters survive the file')
{
  const live: ColumnFilter[] = [
    { col: 'region', pred: { op: 'isOneOf', set: new Set(['North', 'South', null]) } },
    { col: 'amount', pred: { op: 'greater', v: 15 } },
    { col: 'amount', pred: { op: 'between', lo: 1, hi: 99 } },
    { col: 'amount', pred: { op: 'topN', n: 2 } },
    { col: 'region', pred: { op: 'notBlank' } },
  ]
  const stored = fromFilters(live)
  const json = JSON.parse(JSON.stringify(stored)) as StoredFilter[]
  ok(eq((json[0].pred as any).values, ['North', 'South', null]),
    'the checkbox list stores as an ARRAY — a Set stringifies to {} and the step would come back matching nothing')
  const back = toFilters(json)
  const set = (back[0].pred as { op: 'isOneOf'; set: Set<unknown> }).set
  ok(set.has('North') && set.has(null) && set.size === 3, 'and comes back as a Set with the blanks box intact')
  ok(eq(fromFilters(back), stored), 'live → stored → live → stored is a fixed point')

  ok(toPredicate({ op: 'wormhole', v: 1 } as never) === null,
    'a predicate op this build cannot evaluate is dropped AT USE')
  const kept = normalizeStory({ steps: [{ id: 'a', sheet: 's', filters: [{ col: 'c', pred: { op: 'wormhole', v: 1 } }] }] })
  ok((kept.steps[0].filters as any)[0].pred.op === 'wormhole',
    '…and KEPT in the document — dropping it at use is not the same as deleting it')
  ok(toFilters(kept.steps[0].filters).length === 0, 'so the unknown filter narrows nothing rather than everything')

  ok(toPredicate({ op: 'topN', n: 'lots' } as never) === null, 'a non-numeric topN is refused, not coerced to NaN')
  ok(eq(fromPredicate({ op: 'contains', v: 'th' }), { op: 'contains', v: 'th' }),
    'every predicate that is already JSON passes through untouched')
}

// --- 3. deriving a step ------------------------------------------------------

section('a step derives its numbers from the sheet, every time')
{
  const sheet = fixture()
  const all = stepOption(sheet, step())!
  ok(eq(catsOf(all), ['North', 'South', 'East', 'West']),
    'categories are first-seen order, matching chart.ts — alphabetical would give Apr, Aug, Dec')
  ok(eq(dataOf(all), [50, 70, 30, null]),
    'the sums are right and West — which has no number at all — is a GAP, not a zero')

  const filtered = stepOption(sheet, step({
    filters: [{ col: 'region', pred: { op: 'contains', v: 'th' } }],
  }))!
  ok(eq(catsOf(filtered), ['North', 'South']), "a step's filter reaches the chart")
  ok(eq(dataOf(filtered), [50, 70]), 'and the surviving numbers are unchanged by it')

  const sorted = stepOption(sheet, step({ sorts: [{ col: 'amount', dir: 'desc' }] }))!
  ok(eq(catsOf(sorted), ['South', 'North', 'East', 'West']),
    'a sort reorders the CATEGORIES, because aggregate order is first-seen over the visible rows')
  ok(eq(dataOf(sorted), [70, 50, 30, null]), 'and every bar keeps its own number through the reorder')

  ok(stepOrder(sheet, step()).length === 6, 'no filter and no sort is every row')
  ok(eq(stepOrder(sheet, step({ filters: [{ col: 'amount', pred: { op: 'greater', v: 25 } }] })), [2, 3, 4]),
    'the order vector is row POSITIONS, and a blank never satisfies "greater than"')

  // The zip hazard: every bound column or none.
  const order = stepOrder(sheet, step({ filters: [{ col: 'region', pred: { op: 'contains', v: 'th' } }] }))
  const view = viewColumns(sheet, order, ['region', 'amount'])
  ok(view.get('region')!.length === 4 && view.get('amount')!.length === 4,
    'viewColumns narrows EVERY bound column to the same length')
  ok(eq(view.get('amount'), [10, 20, 40, 50]), 'and carries the visible rows values, in view order')

  ok(stepOption(sheet, step({ chart: undefined })) === null, 'a step with no binding has no option, rather than an empty one')
  ok(stepOption(sheet, step({ chart: { x: 'region', series: [], kind: 'bar' } })) === null,
    'a binding with no series is refused too — an empty chart reads as "no data", which is a claim')

  ok(sheetOf(doc(), 'sales')?.id === 'sales' && sheetOf(doc(), 'nope') === null,
    'a step naming a deleted sheet resolves to null, never to whichever sheet is first')
}

// --- 4. alignment ------------------------------------------------------------

section('two steps are aligned before they are tweened')
{
  ok(eq(mergeCats(['a', 'b', 'c'], ['a', 'b', 'c']), ['a', 'b', 'c']), 'identical axes merge to themselves')
  ok(eq(mergeCats(['a', 'b', 'c'], ['a', 'c']), ['a', 'b', 'c']),
    'a category only the FROM side has is kept, in the place it was standing')
  ok(eq(mergeCats(['a', 'c'], ['a', 'b', 'c']), ['a', 'b', 'c']), 'a category only the TO side has is kept')
  ok(eq(mergeCats(['c', 'a'], ['a', 'c']), ['a', 'c']),
    "the destination's order wins for shared categories, because that is where the reader is going")
  ok(eq(mergeCats([], ['a']), ['a']) && eq(mergeCats(['a'], []), ['a']), 'an empty side is not a wipe')

  const sheet = fixture()
  const wide = stepOption(sheet, step())!
  const narrow = stepOption(sheet, step({
    filters: [{ col: 'region', pred: { op: 'contains', v: 'th' } }],
  }))!

  const a = alignOptions(wide, narrow)
  ok(a.refused === '', 'two bar options align')
  ok(eq(catsOf(a.from), catsOf(a.to)), 'both sides end up on ONE category axis')
  ok(eq(catsOf(a.to), ['North', 'South', 'East', 'West']), 'which is the union, in a stable order')
  ok(eq(dataOf(a.from), [50, 70, 30, null]), 'the from side keeps every number it had')
  ok(eq(dataOf(a.to), [50, 70, null, null]),
    'and the categories the filter removed are NULL on the to side — not 0, which would be a bar shrinking to the axis')
  ok(a.introduced === true, 'alignment reports that it introduced gaps, so canMorph can judge the renderer risk')
  ok(!dataOf(a.from).includes(0 as never) && !dataOf(a.to).includes(0 as never),
    'NO ALIGNED POSITION HOLDS ZERO — zero is a number, and no step of this story contains it')

  // series matched by name, not by index
  const twoSeries = optionFor(sheet, { x: 'region', series: ['amount', 'cost'], kind: 'bar', aggregate: 'sum' })
  const oneSeries = optionFor(sheet, { x: 'region', series: ['cost'], kind: 'bar', aggregate: 'sum' })
  const b = alignOptions(twoSeries as Opt, oneSeries as Opt)
  ok(b.from.series.length === b.to.series.length, 'both sides carry the same series list')
  const names = (o: Opt) => o.series.map((s: Opt) => s.name)
  ok(eq(names(b.from), names(b.to)), 'in the same order')
  const costFrom = b.from.series[names(b.from).indexOf('Cost')].data
  const costTo = b.to.series[names(b.to).indexOf('Cost')].data
  ok(eq(costFrom, costTo), 'Cost lines up with Cost, so the bars that stay put do not move')
  const amountTo = b.to.series[names(b.to).indexOf('Amount')].data
  ok(amountTo.every((v: unknown) => v === null), 'a series the destination lacks is all gaps, never all zeroes')
  ok(b.to.series.every((s: Opt) => s.type === 'bar'), 'a borrowed series still has a TYPE, or nothing can tween')

  // refusals
  const pie = optionFor(sheet, { x: 'region', series: ['amount'], kind: 'pie', aggregate: 'sum' })
  ok(alignOptions(wide, pie as Opt).refused === 'pie', 'a pie is refused — its data is not on a category axis at all')
  const perRow = optionFor(sheet, { x: 'region', series: ['amount'], kind: 'bar', aggregate: 'none' })
  ok(alignOptions(perRow as Opt, wide).refused === 'duplicate categories',
    'duplicate x labels (aggregate:none is one bar per ROW) are refused, because matching by label would swap two bars silently')
  ok(alignOptions({ series: [] }, wide).refused === 'no category axis', 'an option with no category axis is refused')
}

section('canMorph refuses what the renderer would draw as a lie')
{
  const sheet = fixture()
  const wide = stepOption(sheet, step())!
  const narrow = stepOption(sheet, step({ filters: [{ col: 'region', pred: { op: 'contains', v: 'th' } }] }))!
  ok(canMorph(alignOptions(wide, narrow)), 'bars morph across a filter: a null renders as a zero-height rect, which is what absent looks like')

  const lineWide = optionFor(sheet, { x: 'region', series: ['amount'], kind: 'line', aggregate: 'sum' })
  const lineNarrow = optionFor(sheet, {
    x: 'region', series: ['amount'], kind: 'line', aggregate: 'sum',
  }, viewColumns(sheet, stepOrder(sheet, step({ filters: [{ col: 'region', pred: { op: 'contains', v: 'th' } }] })), ['region', 'amount']))
  const la = alignOptions(lineWide as Opt, lineNarrow as Opt)
  ok(la.introduced, 'the same filter introduces gaps on a line chart')
  ok(!canMorph(la),
    'and the morph is REFUSED — charts-lite reads a line value through num(v,0), so the polyline would dive to the axis and back')

  const lineSame = alignOptions(lineWide as Opt, lineWide as Opt)
  ok(!lineSame.introduced && canMorph(lineSame), 'a line whose categories do not change still morphs')

  const barOpt = stepOption(sheet, step())!
  const lineOpt = lineWide as Opt
  ok(!canMorph(alignOptions(barOpt, lineOpt)),
    'a bar → line step is refused by the type signature, and takes the cross-type sweep instead')

  const huge = { xAxis: { type: 'category', data: [] as string[] }, series: [{ type: 'bar', name: 'A', data: [] as number[] }] }
  for (let i = 0; i < 5000; i++) { huge.xAxis.data.push(`c${i}`); huge.series[0].data.push(i) }
  ok(!canMorph(alignOptions(huge, huge)),
    'past the point budget a morph CUTS — a transition that misses frames reads as a broken app')
}

// --- 5. the interpolation ----------------------------------------------------

section('the interpolation never invents a number')
{
  ok(morphOption(10, 20, 0) === 10 && morphOption(10, 20, 1) === 20, 'the ends are exact')
  ok(morphOption(10, 20, 0.5) === 15, 'numbers interpolate')
  ok(morphOption(-10, 10, 0.5) === 0, 'a real crossing through zero is fine — the data goes there')

  // THE RULE.
  for (const t of [0, 0.01, 0.25, 0.5, 0.75, 0.99]) {
    ok(morphOption(null, 100, t) === null, `a gap entering stays a gap at t=${t} — never 0, never 100`)
    ok(morphOption(100, null, t) === 100, `a gap leaving holds its true value at t=${t}`)
  }
  ok(morphOption(null, 100, 1) === 100, 'and the gap resolves at the end of the transition')
  ok(morphOption(100, null, 1) === null, 'as does the departure')

  const frames = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1].map((t) => morphOption(null, 100, t))
  ok(frames.every((v) => v === null || v === 100),
    'EVERY frame of an entering gap is either absent or the true value — there is no in-between to misread')

  // A non-finite number CUTS. `NaN + (10 - NaN) * t` is NaN for every frame,
  // and a NaN reaching charts-lite's `num(v, 0)` comes out as a bar at zero —
  // the exact lie, arriving through arithmetic rather than through a gap.
  ok(Number.isNaN(morphOption(NaN, 10, 0.5) as number),
    'a non-finite from-value holds rather than poisoning every frame with NaN')
  ok(morphOption(NaN, 10, 1) === 10, 'and still lands on the destination')

  // arrays and objects
  ok(eq(morphOption([1, 2], [3, 4], 0.5), [2, 3]), 'arrays interpolate element-wise')
  ok(eq(morphOption([1, 2, 3], [3, 4], 0.5), [1, 2, 3]),
    'arrays of different lengths CUT — a length mismatch means the two frames are not the same chart, and that is what alignment is for')
  ok(eq(morphOption([1, 2, 3], [3, 4], 1), [3, 4]), '…and land on the destination')
  ok(eq(morphOption({ a: 1, b: 'x' }, { a: 3, b: 'y' }, 0.5), { a: 2, b: 'x' }),
    'numeric leaves interpolate and strings cut, so an axis type never half-changes')
  ok(eq(morphOption({ a: 1 }, { a: 3, c: 9 }, 0.5), { a: 2, c: 9 }),
    'a key only the destination has arrives whole rather than growing from nothing')

  // end to end: the frames of a real transition
  const sheet = fixture()
  const wide = stepOption(sheet, step())!
  const narrow = stepOption(sheet, step({ filters: [{ col: 'region', pred: { op: 'contains', v: 'th' } }] }))!
  const al = alignOptions(wide, narrow)
  const mid = morphOption(al.from, al.to, 0.5) as Opt
  ok(eq(catsOf(mid), ['North', 'South', 'East', 'West']), 'mid-transition the axis is the union')
  ok(eq(dataOf(mid), [50, 70, 30, null]),
    'North and South hold, East holds its LAST TRUE VALUE until the cut, and West is still a gap')
  const end = morphOption(al.from, al.to, 1) as Opt
  ok(eq(dataOf(end), [50, 70, null, null]), 'and the final frame is exactly the destination step')

  const allFrames = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => dataOf(morphOption(al.from, al.to, t) as Opt))
  ok(allFrames.every((row) => row.every((v) => v === null || (typeof v === 'number' && v > 0))),
    'NO FRAME OF THE WHOLE TRANSITION CONTAINS A ZERO — not one bar ever touches the axis')
}

// --- 6. authoring ------------------------------------------------------------

section('authoring: capture, order, caption')
{
  const captured = captureStep({
    sheet: 'sales',
    filters: [{ col: 'region', pred: { op: 'isOneOf', set: new Set(['North']) } }],
    sorts: [{ col: 'amount', dir: 'desc' }],
    chart: BAR,
  })
  ok(captured.sheet === 'sales' && captured.chart?.kind === 'bar', 'capture takes the view on screen')
  ok(eq((captured.filters as any)[0].pred, { op: 'isOneOf', values: ['North'] }),
    'and stores the filter in its JSON spelling')
  ok(captured.chart !== BAR && captured.chart!.series !== BAR.series,
    'the binding is COPIED — a captured step that aliased the live binding would rewrite itself when the author changed the chart')

  const bare = captureStep({ sheet: 'sales' })
  ok(!('filters' in bare) && !('sorts' in bare) && !('caption' in bare),
    'empty collections are ABSENT, not [] — absent is what "none" means in an additive field')
  ok(eq(Object.keys(bare).sort(), ['id', 'sheet']), 'so a bare step is two keys')

  const viz3d = captureStep({ sheet: 'sales', chart: BAR, viz: { kind: 'scatter', x: 'a', y: 'b', z: 'c' } })
  ok(!!viz3d.viz && !viz3d.chart, 'a 3D binding wins — the two cannot both be on screen')

  const s0: Story = { steps: [step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c' })] }
  ok(eq(moveStep(s0, 0, 2).steps.map((s) => s.id), ['b', 'c', 'a']), 'a step moves forward')
  ok(eq(moveStep(s0, 2, 0).steps.map((s) => s.id), ['c', 'a', 'b']), 'and backward')
  ok(eq(moveStep(s0, 1, 1).steps.map((s) => s.id), ['a', 'b', 'c']), 'moving onto itself is a no-op')
  ok(moveStep(s0, 0, -1) === s0 && moveStep(s0, 0, 9) === s0,
    'an out-of-range move is a no-op, never a silent reshuffle')
  ok(eq(s0.steps.map((s) => s.id), ['a', 'b', 'c']), 'and none of it mutated the story it was given')

  ok(eq(addStep(null, step({ id: 'x' })).steps.map((s) => s.id), ['x']), 'the first capture makes the story')
  ok(eq(addStep(s0, step({ id: 'x' }), 1).steps.map((s) => s.id), ['a', 'x', 'b', 'c']), 'and a later one inserts')
  ok(eq(removeStep(s0, 'b').steps.map((s) => s.id), ['a', 'c']), 'a step is removed by id, not by position')
  ok(eq(removeStep(s0, 'nope').steps.map((s) => s.id), ['a', 'b', 'c']), 'removing a stranger removes nothing')

  const cap = editStep(s0, 'b', { caption: 'The dip' })
  ok(cap.steps[1].caption === 'The dip', 'a caption writes')
  const uncap = editStep(cap, 'b', { caption: '' })
  ok(!('caption' in uncap.steps[1]),
    'and clearing it REMOVES the key — a key holding "" is a document that differs from one that never had it')
  ok(eq(uncap.steps[1], step({ id: 'b' })), 'so caption → clear is a true round trip')

  const story: Story = { steps: [captured] }
  ok(eq(normalizeStory(JSON.parse(JSON.stringify(story))), story),
    'a captured story survives the file byte-identically')
}

// --- 7. NEGATIVE CONTROLS ----------------------------------------------------
//
// Each mutation is a plausible implementation. Each has to be CAUGHT by a check
// the real code passes — a mutation that survives means the check above it is
// decorative.

section('negative controls')

let mutations = 0
let survived = 0
function mutant(name: string, broken: () => boolean): void {
  mutations++
  // `broken()` returns true when the CHECK still passes on the broken code,
  // i.e. the mutation went undetected.
  let undetected: boolean
  try { undetected = broken() } catch { undetected = false }
  if (undetected) {
    survived++
    console.error(`  ✗ SURVIVED: ${name}`)
  } else {
    console.log(`  ✓ caught: ${name}`)
  }
}

const sheet = fixture()
const wide = stepOption(sheet, step())!
const narrow = stepOption(sheet, step({ filters: [{ col: 'region', pred: { op: 'contains', v: 'th' } }] }))!
const aligned = alignOptions(wide, narrow)

// M1 — the kernel's leaf fallback (`a ?? b`), which is what mountChart uses.
function morphKernelFallback(a: any, b: any, t: number): any {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return b.map((v, i) => morphKernelFallback(a[i], v, t))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out: any = { ...b }
    for (const k of Object.keys(b)) if (k in a) out[k] = morphKernelFallback(a[k], b[k], t)
    return out
  }
  return t < 1 ? a ?? b : b
}
mutant('leaf fallback `a ?? b`: an entering gap shows its destination value for the whole tween',
  () => morphKernelFallback(null, 100, 0.5) === null)

// M2 — the classic: treat a gap as a zero and lerp it.
function morphNullIsZero(a: any, b: any, t: number): any {
  const n = (v: any) => (typeof v === 'number' ? v : v === null ? 0 : null)
  const na = n(a); const nb = n(b)
  if (na !== null && nb !== null) return na + (nb - na) * t
  return t < 1 ? a : b
}
mutant('null coerced to 0 before lerping: the bar grows out of the floor',
  () => [0, 0.25, 0.5, 0.75].every((t) => morphNullIsZero(null, 100, t) === null))

// M3 — a merge that keeps only the destination's categories.
const mergeToOnly = (_a: string[], b: string[]): string[] => b.slice()
mutant('mergeCats keeps only the destination axis: a departing bar teleports off screen',
  () => eq(mergeToOnly(['North', 'South', 'East', 'West'], ['North', 'South']), ['North', 'South', 'East', 'West']))

// M4 — fill the absences with 0 instead of null.
const zeroFilled = JSON.parse(JSON.stringify(aligned.to)) as Opt
zeroFilled.series[0].data = zeroFilled.series[0].data.map((v: number | null) => (v === null ? 0 : v))
mutant('alignment fills absences with 0: every removed category shrinks to the axis',
  () => !zeroFilled.series[0].data.includes(0))

// M5 — match series by position instead of by name.
function alignByIndex(from: Opt, to: Opt): { from: Opt; to: Opt } {
  const n = Math.max(from.series.length, to.series.length)
  const pick = (o: Opt, i: number) => o.series[i] ?? { type: 'bar', name: '', data: [] }
  return {
    from: { ...from, series: Array.from({ length: n }, (_, i) => pick(from, i)) },
    to: { ...to, series: Array.from({ length: n }, (_, i) => pick(to, i)) },
  }
}
{
  const two = optionFor(sheet, { x: 'region', series: ['amount', 'cost'], kind: 'bar', aggregate: 'sum' }) as Opt
  const one = optionFor(sheet, { x: 'region', series: ['cost'], kind: 'bar', aggregate: 'sum' }) as Opt
  const byIdx = alignByIndex(two, one)
  mutant('series matched by index: Amount tweens into Cost while the legend still says Amount',
    () => byIdx.from.series.every((s: Opt, i: number) => s.name === byIdx.to.series[i].name))
}

// M6 — ignore the introduced-null rule, so a line chart morphs.
const canMorphNoNullRule = (a: { refused: string }): boolean => a.refused === ''
{
  const lineWide = optionFor(sheet, { x: 'region', series: ['amount'], kind: 'line', aggregate: 'sum' }) as Opt
  const order = stepOrder(sheet, step({ filters: [{ col: 'region', pred: { op: 'contains', v: 'th' } }] }))
  const lineNarrow = optionFor(sheet, { x: 'region', series: ['amount'], kind: 'line', aggregate: 'sum' },
    viewColumns(sheet, order, ['region', 'amount'])) as Opt
  const la = alignOptions(lineWide, lineNarrow)
  mutant('canMorph ignores introduced nulls: a filtered LINE dives to the axis and back',
    () => !canMorphNoNullRule(la))
}

// M7 — store empty collections rather than omitting them.
const captureKeepsEmpty = (sheetId: string): StoryStep =>
  ({ id: 'x', sheet: sheetId, caption: '', filters: [], sorts: [] })
mutant('capture stores filters: [] and caption: "": a semantically unchanged document diffs on every reader',
  () => eq(Object.keys(captureKeepsEmpty('sales')).sort(), ['id', 'sheet']))

// M8 — insert before removing, so a backward move lands one place off.
function moveNaive(s: Story, from: number, to: number): Story {
  const next = s.steps.slice()
  next.splice(to, 0, next[from])
  next.splice(from > to ? from + 1 : from, 1)
  // the classic off-by-one: the removal index is not adjusted for a forward move
  return { ...s, steps: next }
}
{
  const s = { steps: [step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c' })] }
  mutant('moveStep splices before removing: a forward move silently reorders the wrong pair',
    () => eq(moveNaive(s, 0, 2).steps.map((x) => x.id), ['b', 'c', 'a']))
}

// M9 — keep the empty caption key.
const editKeepsEmpty = (s: Story, id: string, caption: string): Story =>
  ({ ...s, steps: s.steps.map((x) => (x.id === id ? { ...x, caption } : x)) })
mutant('clearing a caption leaves caption: "": the step no longer round-trips',
  () => !('caption' in editKeepsEmpty({ steps: [step({ id: 'b' })] }, 'b', '').steps[0]))

// M10 — narrow only SOME of the bound columns.
{
  const order = stepOrder(sheet, step({ filters: [{ col: 'region', pred: { op: 'contains', v: 'th' } }] }))
  const partial = new Map<string, unknown[]>()
  partial.set('region', viewColumns(sheet, order, ['region']).get('region')!)
  const opt = optionFor(sheet, BAR, partial) as Opt
  // region is 4 long, amount is read whole (6) — every label now carries some
  // other row's number, and the chart looks entirely normal.
  mutant('only the x column is narrowed: labels are zipped against the wrong rows',
    () => eq(opt.series[0].data, [50, 70]))
}

// M11 — serialise the checkbox Set directly.
const storeSetRaw = (f: ColumnFilter): unknown => JSON.parse(JSON.stringify(f))
mutant('the checkbox list is stored as a Set: it comes back as {} and matches nothing',
  () => {
    const back = storeSetRaw({ col: 'region', pred: { op: 'isOneOf', set: new Set(['North']) } }) as any
    return Array.isArray(back.pred.values) && back.pred.values.length === 1
  })

// --- report ------------------------------------------------------------------

console.log(`\n${checks} checks, ${failures} failed`)
console.log(`${mutations} mutations, ${survived} survived`)
if (failures || survived) process.exit(1)
console.log('data story: ok')
