// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// DATA STORY MODE — a workbook that presents itself.
//
// This is slides' MORPH idea, moved onto data. In slides both frames of a
// transition live in the document, so a shape animates from one slide to the
// next MODEL-driven, with no DOM measuring (slides/src/present.ts). Here both
// frames of a chart live in the document too — not as two copies of the
// numbers, but as two SAVED VIEWS of one dataset. A step names a sheet, a
// filter, a sort, a chart binding, a camera and a caption; the series are
// derived from the sheet at render, exactly as chart.ts derives them. Stepping
// from one to the next interpolates the two derived options, so bars grow and
// shrink to their real new values and the categories slide into their new
// order.
//
// The pitch is the file: Tableau needs a server to do this and Excel has
// nothing like it, and the whole thing runs offline from an attachment someone
// emailed you.
//
// FOUR RULES SHAPE EVERY DECISION BELOW.
//
// 1. A STEP IS DOCUMENT DATA; THE READER'S POSITION IS NOT. The steps travel in
//    the file so everyone sees the same story. Which step you are ON is
//    per-viewer state and lives in the player's closure — the same split
//    store.ts draws between `commit` (document) and `view` (order vector), and
//    the same split slides draws for reduced motion (a VIEWER preference in
//    localStorage, never in the doc — a document whose appearance depends on
//    who opened it is a format-level bug, PLATFORM §8).
//
// 2. SERIES ARE DERIVED, NEVER STORED. chart.ts promoted slides' painful
//    `syncLinkedChart` lesson to a rule: there is no code path that writes
//    series data into the document. A story would be the obvious place to break
//    it — "just snapshot the numbers for each step" — and that is exactly how a
//    presentation ends up disagreeing with the table behind it. Every step
//    re-derives from the sheet through `optionFor`, so editing a cell moves
//    every step of the story at once.
//
// 3. A NUMBER NEVER ANIMATES THROUGH A VALUE THAT IS NOT IN THE DATA. Zero is
//    such a value. `morphOption` interpolates numeric leaves and CUTS
//    everything else, so a gap (null) stays a gap for the whole tween and never
//    slides to or from the axis. See the long note on `morphOption`, and the
//    MEASURED renderer limitation recorded on `canMorph` — which is why a
//    line chart refuses a morph that a bar chart accepts.
//
// 4. PRESENTING MUTATES NOTHING. The player computes its own order vectors and
//    its own options; it never calls `store.commit`, never writes
//    `store.order`, and never touches the grid. Closing the overlay leaves the
//    workbook byte-identical to how it opened.
//
// WHAT DOES NOT PRESENT YET, and why, is recorded at the bottom of this file
// under KNOWN GAPS rather than left for someone to discover.

import './story.css'
import { anim } from '../../kernel/src/anim.ts'
import { chartSnapshotSvg, mountChart } from '../../kernel/src/charts.ts'
import { optionFor, type ChartBinding } from './chart.ts'
import { buildOrder, type ColumnFilter, type Predicate } from './filter.ts'
import { buildScene, mountViz3d, type Viz3dBinding } from './viz3d.ts'
import type { DashDoc, TableSheet, Story, StoryStep, StoredFilter, StoredPredicate, StoryCamera, SortKey } from './model.ts'
import { readCell, type Store } from './store.ts'
import { t } from './i18n.ts'

type Opt = Record<string, unknown>

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// --- the model ---------------------------------------------------------------
//
// DECLARED HERE, TO BE MOVED INTO model.ts. `doc.story` is an ADDITIVE
// top-level field: `parseDoc` spreads the raw object at every level, so a build
// that has never heard of a story preserves one through parse → serialize, and
// this build preserves unknown fields inside a story through `normalizeStory`.
// That is PLATFORM §3 and it is not negotiable — there is no server to migrate
// the files already on disk.

/** Longest a transition may run. Past this the reader is waiting, not reading. */
const MAX_DURATION = 5
const DEFAULT_DURATION = 0.7

/**
 * Data points above which a morph CUTS instead.
 *
 * The morph re-renders the whole chart every frame (that is what makes it
 * model-driven rather than a DOM trick), and each frame serializes an SVG. At
 * a few thousand points that stops fitting in a frame, and a morph that
 * stutters reads as a broken app — worse than the cut it was trying to improve
 * on. Measured budget, not a guess about correctness.
 */
const MORPH_POINT_BUDGET = 4000

let stepSeq = 0
/** Authoring-time only, so randomness is fine (unlike model.ts's id repair,
 *  which must be identical for two readers of one file). */
export const mintStepId = (): string =>
  `st-${Date.now().toString(36)}${(stepSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

// --- reading and writing the field -------------------------------------------

/**
 * Normalise a story out of a document, KEEPING every field this build does not
 * know — at the story level and at the step level. That spread is the whole
 * additivity guarantee, and the rig asserts it because it is one careless
 * object literal away from being lost forever.
 */
export function normalizeStory(raw: Record<string, unknown>): Story {
  const steps = Array.isArray(raw.steps)
    ? (raw.steps as unknown[]).filter(isObj).map(normalizeStep)
    : []
  return { ...raw, steps }
}

function normalizeStep(raw: Record<string, unknown>): StoryStep {
  return {
    ...raw,
    // A step with no id cannot be reordered or referred to; mint one rather
    // than drop the step, because the step is somebody's work and the id is
    // bookkeeping.
    id: typeof raw.id === 'string' && raw.id ? raw.id : mintStepId(),
    sheet: typeof raw.sheet === 'string' ? raw.sheet : '',
  }
}

export function readStory(doc: DashDoc): Story | null {
  const raw = (doc as DashDoc).story
  return isObj(raw) ? normalizeStory(raw as unknown as Record<string, unknown>) : null
}

/**
 * THE PATCH OP THIS MODULE NEEDS AND DOES NOT HAVE.
 *
 * `Patch` (store.ts) can write a column, a sheet, a measure and the title —
 * there is nothing that writes a top-level document field. `setSheetProps`
 * exists for exactly this shape one level down, deletes spelled as a listed
 * `drop` rather than `{k: undefined}` because JSON.stringify drops an undefined
 * value and the delete would reach every other replica as a no-op. The
 * document-level twin is the same op with the sheet argument removed.
 *
 * Until it lands, `writeStory` falls back (see there). The factory is exported
 * now so the call sites do not move when the op arrives.
 */
export const STORY_OP = 'setDocProps'

export interface SetDocPropsPatch {
  op: typeof STORY_OP
  props: Record<string, unknown>
  drop?: string[]
}

export const storyPatch = (story: Story | null): SetDocPropsPatch =>
  story && story.steps.length
    ? { op: STORY_OP, props: { story } }
    : { op: STORY_OP, props: {}, drop: ['story'] }

/**
 * Write the story into the document as ONE undoable change.
 *
 * INTERIM. `applyPatch` refuses an op it does not implement — loudly, and
 * before it mutates anything, which is what makes the catch below safe for a
 * single-patch commit. The fallback mutates the field directly and then commits
 * a no-op `setTitle` purely to raise the `doc` event: that is the same
 * checkpoint-boundary idiom main.ts uses after pushing an imported sheet, and
 * it is what keeps the dirty flag and autosave honest. The cost is that one
 * undo after editing a caption restores the title rather than the caption; it
 * disappears the moment `setDocProps` exists.
 */
export function writeStory(store: Store, story: Story | null): void {
  if (store.readOnly) return
  const doc = store.doc as DashDoc
  try {
    store.commit(storyPatch(story) as never)
    return
  } catch {
    if (story && story.steps.length) doc.story = story
    else delete doc.story
    store.commit({ op: 'setTitle', title: doc.title })
  }
}

// --- filters: the JSON bridge ------------------------------------------------

/** Stored → live. Returns null for an op this build cannot evaluate. */
export function toPredicate(p: StoredPredicate): Predicate | null {
  switch (p.op) {
    case 'equals': case 'notEquals':
    case 'greater': case 'less': case 'greaterOrEqual': case 'lessOrEqual':
      return { op: p.op, v: (p as { v: unknown }).v } as Predicate
    case 'contains': case 'notContains': case 'startsWith': case 'endsWith':
      return { op: p.op, v: String((p as { v: unknown }).v ?? '') } as Predicate
    case 'between':
      return { op: 'between', lo: (p as { lo: unknown }).lo, hi: (p as { hi: unknown }).hi }
    case 'isBlank': case 'notBlank':
      return { op: p.op }
    case 'isOneOf': {
      const values = (p as { values?: unknown }).values
      return { op: 'isOneOf', set: new Set(Array.isArray(values) ? values : []) }
    }
    case 'topN': case 'bottomN': {
      const n = Number((p as { n?: unknown }).n)
      return Number.isFinite(n) ? { op: p.op, n } : null
    }
    default:
      // Kept in the document by `normalizeStep`'s spread, not applied here.
      return null
  }
}

/** Live → stored. The `Set` is the only thing that actually changes shape. */
export function fromPredicate(p: Predicate): StoredPredicate {
  if (p.op === 'isOneOf') return { op: 'isOneOf', values: [...p.set] }
  return p as unknown as StoredPredicate
}

export const toFilters = (stored: StoredFilter[] | undefined): ColumnFilter[] =>
  (stored ?? [])
    .map((f) => ({ col: f.col, pred: toPredicate(f.pred) }))
    .filter((f): f is ColumnFilter => f.pred !== null)

export const fromFilters = (live: ColumnFilter[]): StoredFilter[] =>
  live.map((f) => ({ col: f.col, pred: fromPredicate(f.pred) }))

// --- deriving a step ---------------------------------------------------------

export const sheetOf = (doc: DashDoc, id: string): TableSheet | null => {
  const s = doc.sheets.find((x) => x.id === id)
  return s && s.kind === 'table' ? s : null
}

const rowsOf = (sheet: TableSheet): number => sheet.rids.reduce((a, [, c]) => a + c, 0)

/**
 * The visible rows for one step, in order.
 *
 * VIEW state, computed on demand and thrown away — the player never writes
 * `store.order`, because the reader watching a story and the author editing the
 * grid behind it must not fight over one vector.
 */
export function stepOrder(
  sheet: TableSheet,
  step: StoryStep,
  computed?: Map<string, unknown[]>,
): number[] {
  const rows = rowsOf(sheet)
  const get = (col: string, row: number): unknown => {
    const c = computed?.get(col)
    return c ? c[row] : readCell(sheet.data[col], row)
  }
  return buildOrder(rows, get, toFilters(step.filters), step.sorts ?? [])
}

/**
 * The bound columns, restricted to the visible rows.
 *
 * This is how a step's filter reaches the chart WITHOUT chart.ts growing an
 * order argument: `optionFor` already reads a column through `computed` if the
 * caller supplies one, so supplying the filtered slice for every bound column
 * derives the series from exactly the rows the step shows.
 *
 * EVERY BOUND COLUMN OR NONE. `optionFor` zips the x column against each series
 * column by index; if one of them came through this map (k rows) and another
 * came from the sheet (n rows), the chart pairs the wrong label with the wrong
 * number and looks entirely plausible doing it. `stepOption` is the only caller
 * and it passes the full binding, which is what makes that unrepresentable.
 */
export function viewColumns(
  sheet: TableSheet,
  order: number[],
  cols: string[],
  computed?: Map<string, unknown[]>,
): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>()
  for (const col of cols) {
    if (!col || out.has(col)) continue
    const c = computed?.get(col)
    out.set(col, order.map((row) => (c ? c[row] : readCell(sheet.data[col], row))))
  }
  return out
}

/**
 * A step's chart option — derived, every time, from the sheet.
 *
 * `computed` is the grid's freshly recalculated formula columns, handed through
 * unchanged from chart.ts's contract: a story about a computed column must show
 * the numbers on screen, not the raw column underneath them.
 */
export function stepOption(
  sheet: TableSheet,
  step: StoryStep,
  computed?: Map<string, unknown[]>,
): Opt | null {
  const bind = step.chart
  if (!bind || !bind.x || !bind.series?.length) return null
  const order = stepOrder(sheet, step, computed)
  const view = viewColumns(sheet, order, [bind.x, ...bind.series], computed)
  return optionFor(sheet, bind, view)
}

// --- alignment ---------------------------------------------------------------
//
// Two steps of one story almost never produce the same-shaped option: that is
// the POINT — a filter drops categories, a sort reorders them, a new binding
// adds a series. Interpolating requires a common frame, so alignment rewrites
// both options over the union of their categories and series, filling the
// absences with `null`.
//
// `null` and not `0`, and that distinction is the whole reason this function
// exists rather than a `JSON.stringify` comparison. See `morphOption`.

const catsOf = (opt: Opt): string[] | null => {
  const x = opt.xAxis as { data?: unknown } | undefined
  return Array.isArray(x?.data) ? (x.data as unknown[]).map((v) => String(v)) : null
}

const seriesOf = (opt: Opt): Opt[] =>
  Array.isArray(opt.series) ? (opt.series as Opt[]).filter(isObj) : []

const hasDupes = (xs: string[]): boolean => new Set(xs).size !== xs.length

/**
 * The union of two category axes, keeping BOTH orders.
 *
 * `to`'s order is the spine, because that is where the reader is going. A
 * category that only `from` has is emitted just before the `from`-neighbour
 * that survived, so a bar about to disappear does not jump across the chart on
 * its way out — it leaves from where it was standing.
 */
export function mergeCats(a: string[], b: string[]): string[] {
  const inB = new Set(b)
  const out: string[] = []
  const seen = new Set<string>()
  let ai = 0
  const drainA = (until: number) => {
    for (; ai < until; ai++) {
      const c = a[ai]
      if (!inB.has(c) && !seen.has(c)) { out.push(c); seen.add(c) }
    }
  }
  for (const c of b) {
    const at = a.indexOf(c)
    if (at >= 0) drainA(at)
    if (!seen.has(c)) { out.push(c); seen.add(c) }
    if (at >= 0) ai = Math.max(ai, at + 1)
  }
  drainA(a.length)
  return out
}

export interface Aligned {
  from: Opt
  to: Opt
  /** true when the union put a `null` where a source option had a value at
   *  every position — i.e. a category or series exists at only one end. */
  introduced: boolean
  /** why alignment was refused, for the caller's cut path. '' when it worked. */
  refused: string
}

/**
 * Rewrite two cartesian options over a common category axis and series list.
 *
 * REFUSES rather than guesses:
 *  - a pie (its data is `{name,value}` objects on a different axis entirely);
 *  - an option with no category axis;
 *  - DUPLICATE CATEGORIES. With `aggregate: 'none'` there is one bar per ROW,
 *    so two rows may carry the same x label — and then matching by label is
 *    ambiguous and would swap two bars' values silently. A cut is right here;
 *    an arbitrary pairing is not.
 * A refusal is not a failure: the caller cuts, which is honest and instant.
 */
export function alignOptions(from: Opt, to: Opt): Aligned {
  const fail = (why: string): Aligned => ({ from, to, introduced: false, refused: why })
  const fs = seriesOf(from)
  const ts = seriesOf(to)
  if (fs.some((s) => s.type === 'pie') || ts.some((s) => s.type === 'pie')) return fail('pie')
  const fc = catsOf(from)
  const tc = catsOf(to)
  if (!fc || !tc) return fail('no category axis')
  if (hasDupes(fc) || hasDupes(tc)) return fail('duplicate categories')

  const cats = mergeCats(fc, tc)
  let introduced = false

  // Series are matched by NAME, which is the column's display name — the one
  // thing a reader can see. Matching by index would pair "Revenue" with "Cost"
  // the moment a step drops a series, and the bars would tween between two
  // different measures.
  const names: string[] = []
  const push = (n: string) => { if (!names.includes(n)) names.push(n) }
  for (const s of ts) push(String(s.name ?? ''))
  for (const s of fs) push(String(s.name ?? ''))

  const remap = (side: Opt[], sideCats: string[], name: string): { s: Opt | null; data: Array<number | null> } => {
    const s = side.find((x) => String(x.name ?? '') === name) ?? null
    if (!s) return { s: null, data: cats.map(() => null) }
    const at = new Map(sideCats.map((c, i) => [c, i]))
    const src = Array.isArray(s.data) ? (s.data as Array<number | null>) : []
    return {
      s,
      data: cats.map((c) => {
        const i = at.get(c)
        if (i === undefined) return null
        const v = src[i]
        return typeof v === 'number' && Number.isFinite(v) ? v : null
      }),
    }
  }

  const build = (side: Opt[], sideCats: string[], other: Opt[], base: Opt): Opt => {
    const series = names.map((name) => {
      const mine = remap(side, sideCats, name)
      const theirs = other.find((x) => String(x.name ?? '') === name)
      // A series only one side has still needs a TYPE, or the two options have
      // different shapes and nothing can tween. Borrow the other side's.
      const proto = mine.s ?? theirs ?? {}
      // A series only one side has is entirely gaps on the other — the same
      // "introduced null" as a category the union added, and it has to be
      // reported for the same reason (see canMorph). Nulls the SOURCE already
      // carried are not introduced: chart.ts emits them for an empty aggregate
      // bucket, and they are the honest answer, not this function's doing.
      if (!mine.s) introduced = true
      return { ...proto, name, data: mine.data }
    })
    return {
      ...base,
      xAxis: { ...(base.xAxis as Opt | undefined), type: 'category', data: cats },
      series,
    }
  }

  const outFrom = build(fs, fc, ts, from)
  const outTo = build(ts, tc, fs, to)
  // A category the union added is a null on the side that lacks it, whether or
  // not the loop above noticed it through a series' own data.
  if (cats.length !== fc.length || cats.length !== tc.length) introduced = true
  return { from: outFrom, to: outTo, introduced, refused: '' }
}

const typeSig = (opt: Opt): string => seriesOf(opt).map((s) => String(s.type ?? '')).join(',')

const optionPoints = (opt: Opt): number =>
  seriesOf(opt).reduce((n, s) => n + (Array.isArray(s.data) ? s.data.length : 0), 0)

/**
 * Can these two options be tweened, or must the step cut?
 *
 * The second half of this is a MEASURED renderer limitation and the single
 * most surprising thing in this file. charts-lite reads every cartesian series
 * value through `num(v, 0)` (kernel/src/charts.ts, the bar, line and scatter
 * paths alike). For BARS that is harmless — a null becomes a zero-height rect,
 * which is what "absent" looks like anyway. For a LINE or a SCATTER it is the
 * exact lie this whole module is built to avoid: the polyline dives to the axis
 * and back, and a reader sees a month where sales collapsed.
 *
 * So a morph that would INTRODUCE a null — a filter that drops a category, a
 * step that adds a series — is refused for anything but bars, and the step
 * cuts. Bars morph; lines cut, until the kernel learns to break a polyline at a
 * gap. Refusing the animation is a smaller cost than animating a fiction.
 */
export function canMorph(a: Aligned): boolean {
  if (a.refused) return false
  if (typeSig(a.from) !== typeSig(a.to)) return false
  if (optionPoints(a.to) > MORPH_POINT_BUDGET || optionPoints(a.from) > MORPH_POINT_BUDGET) return false
  if (a.introduced) {
    const nonBar = [...seriesOf(a.from), ...seriesOf(a.to)].some((s) => s.type !== 'bar')
    if (nonBar) return false
  }
  return true
}

/**
 * One frame of a morph, at `t` in [0, 1].
 *
 * Numeric leaves interpolate. EVERYTHING ELSE CUTS, and the fallback is
 * `t < 1 ? a : b` rather than the kernel's `t < 1 ? a ?? b : b` — the one
 * character that separates this from a lie.
 *
 * With `a ?? b`, a category that does not exist yet (`null` on the from side)
 * takes the destination's number for the whole tween: a bar that stands at its
 * final height before its data exists. With `t < 1 ? a : b`, a gap stays a gap
 * until the transition ends and then appears at its true value. Neither
 * spelling ever produces a number BETWEEN a gap and a value, which is the rule
 * that matters: `morphOption(null, 100, 0.5)` is `null`, never `50` and never
 * `0`. A bar that grows out of the floor is a claim that the value used to be
 * zero, and the data never said that.
 *
 * The same fallback is what makes category labels, colours and axis types cut
 * cleanly instead of half-interpolating into nonsense.
 */
export function morphOption(a: unknown, b: unknown, t: number): unknown {
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * t : (t < 1 ? a : b)
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return b.map((v, i) => morphOption(a[i], v, t))
  }
  if (isObj(a) && isObj(b)) {
    const out: Record<string, unknown> = { ...b }
    for (const k of Object.keys(b)) if (k in a) out[k] = morphOption(a[k], b[k], t)
    return out
  }
  return t < 1 ? a : b
}

// --- authoring ---------------------------------------------------------------

export interface CaptureSource {
  sheet: string
  filters?: ColumnFilter[]
  sorts?: SortKey[]
  chart?: ChartBinding | null
  viz?: Viz3dBinding | null
  camera?: StoryCamera | null
  caption?: string
}

/**
 * The current view, frozen as a step.
 *
 * Empty collections are OMITTED rather than stored as `[]`. An additive field
 * where absent means "none" has to be absent when there is none, or every
 * reader diffs a document that is semantically unchanged — the same rule
 * panels.ts follows for `totals` and `frozen`, and the reason the rig's
 * round-trip check is byte-exact.
 */
export function captureStep(src: CaptureSource): StoryStep {
  const step: StoryStep = { id: mintStepId(), sheet: src.sheet }
  if (src.caption) step.caption = src.caption
  const filters = fromFilters(src.filters ?? [])
  if (filters.length) step.filters = filters
  if (src.sorts?.length) step.sorts = src.sorts.map((s) => ({ col: s.col, dir: s.dir }))
  // A 3D binding wins: the two cannot both be on screen, and `viz` is the one
  // the author was looking at when they pressed capture.
  if (src.viz) step.viz = { ...src.viz }
  else if (src.chart) step.chart = { ...src.chart, series: [...src.chart.series] }
  if (src.camera) step.camera = { ...src.camera }
  return step
}

/** Move a step. Out-of-range indices are a no-op, never a silent reshuffle. */
export function moveStep(story: Story, from: number, to: number): Story {
  const steps = story.steps
  if (from < 0 || from >= steps.length || to < 0 || to >= steps.length || from === to) return story
  const next = steps.slice()
  const [s] = next.splice(from, 1)
  next.splice(to, 0, s)
  return { ...story, steps: next }
}

export const addStep = (story: Story | null, step: StoryStep, at?: number): Story => {
  const steps = (story?.steps ?? []).slice()
  steps.splice(at ?? steps.length, 0, step)
  return { ...(story ?? {}), steps }
}

export const removeStep = (story: Story, id: string): Story =>
  ({ ...story, steps: story.steps.filter((s) => s.id !== id) })

export const editStep = (story: Story, id: string, patch: Partial<StoryStep>): Story => ({
  ...story,
  steps: story.steps.map((s) => {
    if (s.id !== id) return s
    const next: StoryStep = { ...s, ...patch }
    // An empty caption is an ABSENT caption, for the same reason an empty
    // filter list is absent: a key holding "" is a document that differs from
    // one that never had the key.
    for (const k of Object.keys(patch) as Array<keyof StoryStep>) {
      const v = next[k]
      if (v === undefined || v === '') delete next[k]
    }
    return next
  }),
})

// --- reduced motion (a VIEWER preference, never in the document) -------------
//
// Same localStorage key as slides — `bento-reduce-motion` — because it is one
// PERSON's preference about motion, not one app's setting, and a reader who
// turned motion off in a deck should not have to find the switch again in a
// workbook. Defaults to the OS `prefers-reduced-motion`; an explicit toggle
// overrides it and persists per browser. It never enters the format
// (PLATFORM §8): a document whose appearance depends on the viewer is a
// format-level bug.

const MOTION_KEY = 'bento-reduce-motion'

export function readMotionPref(): boolean | null {
  try {
    const v = localStorage.getItem(MOTION_KEY)
    return v === 'on' ? true : v === 'off' ? false : null
  } catch { return null }
}

export function reduceMotionNow(): boolean {
  const explicit = readMotionPref()
  if (explicit !== null) return explicit
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

export function setMotionPref(on: boolean): void {
  try { localStorage.setItem(MOTION_KEY, on ? 'on' : 'off') } catch { /* private mode */ }
}

// --- the player --------------------------------------------------------------

export interface PresentOpts {
  store: Store
  story: Story
  /** where to start; clamped */
  from?: number
  /** the grid's freshly recalculated formula columns for a sheet, if it has any */
  computed?: (sheetId: string) => Map<string, unknown[]> | undefined
}

export interface StoryPlayer {
  close(): void
  next(): void
  prev(): void
  goTo(i: number): void
  readonly index: number
}

const clampDuration = (v: unknown): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_DURATION
  return Math.min(MAX_DURATION, Math.max(0.05, n))
}

const esc = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Present the story full screen.
 *
 * Returns null when there is nothing to present — a caller must not have to
 * open an empty black rectangle to discover that.
 *
 * NOTHING IN HERE COMMITS. The player derives its own order vectors and options
 * and drops them on close; the workbook it was reading is byte-identical
 * afterwards.
 */
export function presentStory(opts: PresentOpts): StoryPlayer | null {
  const { store, story } = opts
  const steps = story.steps.filter((s) => sheetOf(store.doc, s.sheet))
  if (!steps.length) return null

  let index = Math.min(Math.max(opts.from ?? 0, 0), steps.length - 1)
  let reduce = reduceMotionNow()

  const overlay = document.createElement('div')
  overlay.className = 'ds-overlay'
  overlay.tabIndex = -1
  overlay.innerHTML =
    `<div class="ds-stage"></div>` +
    `<div class="ds-caption"><div class="ds-cap-text"></div><div class="ds-chips"></div></div>` +
    `<div class="ds-bar">` +
    `<button class="ds-btn" data-nav="prev" title="${esc(t('Previous'))}">‹</button>` +
    `<div class="ds-dots"></div>` +
    `<button class="ds-btn" data-nav="next" title="${esc(t('Next'))}">›</button>` +
    `<span class="ds-count"></span>` +
    `<button class="ds-btn" data-nav="motion" title="${esc(t('Reduced motion (M)'))}">⏸</button>` +
    `<button class="ds-btn" data-nav="close" title="${esc(t('Close (Esc)'))}">✕</button>` +
    `</div>`
  document.body.appendChild(overlay)
  overlay.classList.toggle('reduce-motion', reduce)

  const stage = overlay.querySelector<HTMLElement>('.ds-stage')!
  const capText = overlay.querySelector<HTMLElement>('.ds-cap-text')!
  const chips = overlay.querySelector<HTMLElement>('.ds-chips')!
  const dots = overlay.querySelector<HTMLElement>('.ds-dots')!
  const count = overlay.querySelector<HTMLElement>('.ds-count')!

  // Real fullscreen if the browser allows it; a denied request degrades to a
  // fixed overlay filling the tab, which is the same bargain slides makes and
  // is a perfectly good sharing/testing mode.
  void overlay.requestFullscreen?.().catch(() => {})

  const clock = { t: 0 }
  let teardown: (() => void) | null = null
  /** the option currently on screen, for the next transition to morph FROM */
  let showing: Opt | null = null
  let closed = false

  const size = () => ({ w: stage.clientWidth || 960, h: stage.clientHeight || 540 })

  const paintFrame = (opt: Opt) => {
    const { w, h } = size()
    stage.innerHTML = chartSnapshotSvg({ w, h, option: opt })
  }

  /** Land on an option: a LIVE chart, so tooltips and wheel-zoom work at rest. */
  const settle = (opt: Opt, fromOpt?: Opt) => {
    teardown?.()
    const { w, h } = size()
    teardown = mountChart({ w, h, option: opt }, stage, fromOpt)
    showing = opt
  }

  const settle3d = (sheet: TableSheet, step: StoryStep) => {
    teardown?.()
    const computed = opts.computed?.(sheet.id)
    // The 3D scene reads the whole sheet: `buildScene` takes columns, not an
    // order vector, so a step's filter cannot narrow it. Recorded under KNOWN
    // GAPS rather than faked by pre-filtering into a synthetic sheet, which
    // would be a second copy of the data — rule 2.
    const scene = buildScene(sheet, step.viz!, computed)
    teardown = mountViz3d(stage, scene, {
      azimuth: step.camera?.azimuth,
      elevation: step.camera?.elevation,
      background: '#0e1420',
    })
    showing = null
  }

  const render = (animate: boolean) => {
    const step = steps[index]
    const sheet = sheetOf(store.doc, step.sheet)!
    anim.killTweensOf(clock)

    capText.textContent = step.caption ?? ''
    capText.classList.toggle('empty', !step.caption)
    chips.innerHTML = (step.highlight?.values ?? [])
      .map((v) => `<span class="ds-chip">${esc(v == null ? t('(blank)') : String(v))}</span>`)
      .join('')
    count.textContent = `${index + 1} / ${steps.length}`
    dots.innerHTML = steps
      .map((_, i) => `<i class="ds-dot${i === index ? ' on' : ''}" data-go="${i}"></i>`)
      .join('')

    if (step.viz) { settle3d(sheet, step); return }

    const to = stepOption(sheet, step, opts.computed?.(sheet.id))
    if (!to) {
      teardown?.(); teardown = null
      showing = null
      stage.innerHTML = `<div class="ds-empty">${esc(t('This step has no chart binding.'))}</div>`
      return
    }

    const wantsMorph = animate && !reduce && (step.transition ?? 'morph') === 'morph' && showing
    if (!wantsMorph) { settle(to); return }

    const aligned = alignOptions(showing!, to)
    if (!canMorph(aligned)) {
      // A shape the interpolator refuses — a pie, a type change, too many
      // points, or a null a line chart would draw as a plunge to zero. Hand
      // both options to the kernel, which cross-fades and sweeps the new type
      // in without ever claiming a number.
      settle(to, showing!)
      return
    }
    clock.t = 0
    const a = aligned.from
    const b = aligned.to
    anim.to(clock, {
      t: 1,
      duration: clampDuration(step.duration),
      ease: 'power2.inOut',
      onUpdate: () => { if (!closed) paintFrame(morphOption(a, b, clock.t) as Opt) },
      onComplete: () => { if (!closed) settle(to) },
    })
  }

  const goTo = (i: number) => {
    if (closed) return
    const n = Math.min(Math.max(i, 0), steps.length - 1)
    if (n === index) return
    index = n
    render(true)
  }

  const onKey = (e: KeyboardEvent) => {
    const k = e.key
    if (k === 'Escape') { e.preventDefault(); close(); return }
    if (k === 'ArrowRight' || k === ' ' || k === 'PageDown') { e.preventDefault(); goTo(index + 1); return }
    if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); goTo(index - 1); return }
    if (k === 'Home') { e.preventDefault(); goTo(0); return }
    if (k === 'End') { e.preventDefault(); goTo(steps.length - 1); return }
    if (k === 'm' || k === 'M') { e.preventDefault(); toggleMotion() }
  }

  const toggleMotion = () => {
    reduce = !reduce
    setMotionPref(reduce)
    overlay.classList.toggle('reduce-motion', reduce)
    // Re-settle: a killed tween would otherwise strand the chart mid-morph, at
    // numbers that are in no step of the story. slides re-settles for exactly
    // this reason (present.ts setReduceMotion).
    anim.killTweensOf(clock)
    render(false)
  }

  overlay.addEventListener('click', (e) => {
    const el = e.target as HTMLElement
    const nav = el.closest<HTMLElement>('[data-nav]')?.dataset.nav
    if (nav === 'next') goTo(index + 1)
    else if (nav === 'prev') goTo(index - 1)
    else if (nav === 'close') close()
    else if (nav === 'motion') toggleMotion()
    const go = el.closest<HTMLElement>('[data-go]')?.dataset.go
    if (go !== undefined) goTo(Number(go))
  })

  // A resize changes the chart's pixel box, and every rendered frame is sized
  // to it. Re-settling without animation is right: the reader did not ask for a
  // transition by dragging a window edge.
  const onResize = () => { if (!closed) render(false) }
  window.addEventListener('resize', onResize)
  document.addEventListener('keydown', onKey, true)

  const onFsChange = () => {
    // Leaving fullscreen ENDS the show, the way it does in slides — dropping
    // silently into a tab-filling overlay leaves the reader in a mode nobody
    // asked for.
    if (!document.fullscreenElement && !closed) close()
  }
  document.addEventListener('fullscreenchange', onFsChange)

  function close(): void {
    if (closed) return
    closed = true
    anim.killTweensOf(clock)
    teardown?.()
    teardown = null
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('fullscreenchange', onFsChange)
    window.removeEventListener('resize', onResize)
    if (document.fullscreenElement === overlay) void document.exitFullscreen?.().catch(() => {})
    overlay.remove()
  }

  render(false)
  overlay.focus()

  return {
    close,
    next: () => goTo(index + 1),
    prev: () => goTo(index - 1),
    goTo,
    get index() { return index },
  }
}

// --- authoring UI ------------------------------------------------------------

export interface StorySource {
  store: Store
  /** the sheet the grid is showing */
  sheetId: () => string
  filters: () => ColumnFilter[]
  sorts: () => SortKey[]
  /** the 2D binding on screen, if any */
  chart: () => ChartBinding | null
  /** the 3D binding on screen, if any */
  viz?: () => Viz3dBinding | null
  computed?: (sheetId: string) => Map<string, unknown[]> | undefined
}

/**
 * The story panel: capture, reorder, caption, present.
 *
 * DELIBERATELY MODEST. Presenting is the feature; this is the four verbs that
 * make presenting reachable. Every edit goes through `writeStory`, so the story
 * is document data and rides in the file like everything else.
 */
export function openStoryEditor(src: StorySource): HTMLElement {
  document.querySelector('.ds-editor')?.remove()
  const el = document.createElement('div')
  el.className = 'ds-editor'
  document.body.appendChild(el)

  const read = (): Story => readStory(src.store.doc) ?? { steps: [] }

  const draw = () => {
    const story = read()
    const rows = story.steps.map((s, i) => {
      const sheet = sheetOf(src.store.doc, s.sheet)
      const what = s.viz ? `3D ${esc(String(s.viz.kind))}` : s.chart ? esc(String(s.chart.kind)) : t('no chart')
      const bits = [
        sheet ? esc(sheet.name) : `<b class="ds-warn">${esc(t('missing sheet'))}</b>`,
        what,
        s.filters?.length ? `${s.filters.length}f` : '',
        s.sorts?.length ? `${s.sorts.length}↕` : '',
      ].filter(Boolean).join(' · ')
      return (
        `<li class="ds-step" data-id="${esc(s.id)}">` +
        `<span class="ds-n">${i + 1}</span>` +
        `<div class="ds-fields">` +
        `<input class="ds-cap-in" placeholder="${esc(t('Caption'))}" value="${esc(s.caption ?? '')}">` +
        `<span class="ds-meta">${bits}</span>` +
        `</div>` +
        `<button class="ds-btn" data-act="up" title="${esc(t('Move up'))}">↑</button>` +
        `<button class="ds-btn" data-act="down" title="${esc(t('Move down'))}">↓</button>` +
        `<button class="ds-btn" data-act="del" title="${esc(t('Remove step'))}">✕</button>` +
        `</li>`
      )
    }).join('')

    el.innerHTML =
      `<div class="ds-ed-head"><b>${esc(t('Data story'))}</b>` +
      `<button class="ds-btn" data-act="shut">✕</button></div>` +
      (story.steps.length
        ? `<ol class="ds-steps">${rows}</ol>`
        : `<p class="ds-hint">${esc(t('Filter, sort and chart the sheet, then capture it as the first step.'))}</p>`) +
      `<div class="ds-ed-foot">` +
      `<button class="ds-btn ds-primary" data-act="capture">${esc(t('Capture current view'))}</button>` +
      `<button class="ds-btn" data-act="present"${story.steps.length ? '' : ' disabled'}>${esc(t('Present ▸'))}</button>` +
      `</div>`
  }

  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
    if (!btn) return
    const act = btn.dataset.act
    const id = btn.closest<HTMLElement>('.ds-step')?.dataset.id
    const story = read()
    const at = id ? story.steps.findIndex((s) => s.id === id) : -1

    if (act === 'shut') { el.remove(); return }
    if (act === 'capture') {
      writeStory(src.store, addStep(story, captureStep({
        sheet: src.sheetId(),
        filters: src.filters(),
        sorts: src.sorts(),
        chart: src.chart(),
        viz: src.viz?.() ?? null,
      })))
      draw()
      return
    }
    if (act === 'present') {
      el.remove()
      presentStory({ store: src.store, story: read(), computed: src.computed })
      return
    }
    if (at < 0) return
    if (act === 'up') writeStory(src.store, moveStep(story, at, at - 1))
    else if (act === 'down') writeStory(src.store, moveStep(story, at, at + 1))
    else if (act === 'del') writeStory(src.store, removeStep(story, id!))
    draw()
  })

  // Captions commit on change, not on every keystroke: the store's typing run
  // covers a CELL, and a document-level write per character would push an undo
  // entry per character with it.
  el.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement
    if (!input.classList.contains('ds-cap-in')) return
    const id = input.closest<HTMLElement>('.ds-step')?.dataset.id
    if (!id) return
    writeStory(src.store, editStep(read(), id, { caption: input.value.trim() }))
  })

  draw()
  return el
}

/** Wire a topbar button. Returns a detach, for symmetry with the rest of dash. */
export function installStory(src: StorySource & { button: HTMLElement }): () => void {
  const onClick = () => { openStoryEditor(src) }
  src.button.addEventListener('click', onClick)
  return () => src.button.removeEventListener('click', onClick)
}

// --- KNOWN GAPS --------------------------------------------------------------
//
// Written down rather than left to be discovered:
//
//  * THE 3D CAMERA CUTS; IT DOES NOT FLY. `mountViz3d` builds its camera
//    internally (`frameCamera(scene, opts)`) and returns only a teardown, so
//    there is no handle to tween. A step's `camera` is applied at mount, which
//    is a cut. Flying it needs viz3d.ts to hand back the `Orbit` and a redraw
//    request; remounting per frame would recompile shaders and rebuild every
//    buffer sixty times a second, which is not a transition, it is a stall.
//  * A 3D STEP IGNORES ITS FILTER. `buildScene` reads the sheet's columns
//    whole. Narrowing it honestly needs the same `computed`-map trick the 2D
//    path uses, which needs `buildScene` to accept an order vector.
//  * HIGHLIGHT IS NAMED, NOT PAINTED. charts-lite colours by SERIES, not by
//    item, so a subset cannot be tinted inside one series. The two workarounds
//    are both worse than saying so: splitting into two series halves every bar
//    (grouped-bar layout reserves a slot per series) and, for a line or
//    scatter, writes nulls that the renderer draws as a plunge to zero. So the
//    highlighted values are listed under the caption and the chart is left
//    truthful.
//  * LINE AND SCATTER STEPS CUT when a filter changes the categories. See
//    `canMorph`.
