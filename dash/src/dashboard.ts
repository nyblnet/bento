// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Dashboards: a grid of tiles over one workbook, and CROSS-FILTERING.
//
// A dashboard is the app's output surface, not its subject (docs/DECISIONS.md,
// 2026-08-02 — `dash` is DAta SHeets). What makes one worth building is the
// thing a screenshot of six charts is not: click a bar and every other tile
// re-derives against that selection, click again and it lets go.
//
// THREE RULES HOLD THE WHOLE FILE UP.
//
//   1. THE SELECTION IS VIEWER STATE. It goes through `store.view()` — no
//      checkpoint, no dirty flag, no op (store.ts:544, grid.ts:326 is the
//      precedent). Writing a click as a `commit` is the easy mistake and
//      nobody notices until the file dirties itself every time a reader
//      explores it, autosave rewrites the workbook, and — once collab lands —
//      one reader's exploring moves everybody else's dashboard. The LAYOUT is
//      the opposite: it is what the author arranged, so it is document data
//      and travels in the file.
//
//   2. NOTHING IS CACHED. Series are derived at render (chart.ts:5) precisely
//      so a chart cannot disagree with the table beside it, and a cross-filter
//      is the case where a cache would be most tempting and most wrong: a
//      stale tile under a live selection is a chart that is confidently
//      answering a question nobody asked. `deriveTile` is a pure function of
//      (sheet, tile, rows) and is called again for every paint.
//
//   3. NULL IS A CATEGORY, NOT AN EXEMPTION. See `catOf` below. A row with a
//      blank Region is not swept into "North" and not quietly dropped from the
//      dashboard: it is in the "(blank)" category, which is drawn, clickable
//      and selectable like any other. So the categories of a column PARTITION
//      the sheet, and picking every category in turn accounts for every row.
//      The rig proves that as an equality, because it is the kind of thing
//      that silently stops being true.
//
// A TILE NEVER FILTERS ITSELF. The selection carries the id of the tile the
// click came from and a tile skips its own entries. Without that, clicking
// "North" on a region chart leaves a chart with one bar, and there is no way
// back to "South" except an undo the reader does not have — the selection is
// not in the undo stack, by rule 1. Power BI, Tableau and Looker all made the
// same choice; it is not a nicety, it is the difference between a control and
// a trap.
//
// WHAT IS DERIVED WHERE. The grouping arithmetic is chart.ts's `optionFor`,
// called over a PROJECTED sheet holding just the surviving rows. That is
// deliberate: a dashboard puts a chart and a table side by side, so a second
// group-by implementation in this file would be exactly the disagreement rule
// 2 exists to prevent. The aggregates are filter.ts's `summarize` for the same
// reason — it is what the status bar reports, it divides by the values PRESENT,
// and it answers `null` rather than 0 when there is nothing to aggregate.

import './dashboard.css'
import { optionFor, type ChartBinding } from './chart.ts'
import {
  buildOrder, isBlank, summarize, type ColumnFilter, type Get,
} from './filter.ts'
import { formatValue } from './format.ts'
import { t } from './i18n.ts'
import type { Column, DashDoc, Sheet, TableSheet, View } from './model.ts'
import { readCell, type Store } from './store.ts'

// --- The document shape ----------------------------------------------------
//
// TO BE MOVED TO model.ts. `View` and `Tile` are already there (model.ts:256)
// and already carry `x/y/w/h`, `bind` and an index signature, so everything
// below round-trips through `parseDoc` today — unknown fields survive by
// construction (PLATFORM §3). What the model's types cannot yet express is
// `kind: 'table'`, a tile `id`, and the two extra `bind` keys; those are
// declared here so this file type-checks, and the boundary casts are the only
// place that knows the difference.

/**
 * Tile kinds this build draws. The stored `kind` is a plain string, NOT this
 * union, for the same reason `Step.op` is (model.ts:41): a tile written by a
 * newer dash must survive a round trip through this one, and the type system
 * must not be able to express "only these". An unrecognised kind renders as a
 * labelled placeholder — never as an empty box, which reads as "this chart has
 * no data" when the truth is "this build cannot draw it".
 */
export type KnownTileKind = 'chart' | 'kpi' | 'table' | 'text'

export type ChartKind = 'bar' | 'line' | 'pie'

export interface TileBind {
  sheet: string
  /** chart: the category column. */
  x?: string
  /** table: the column a row click selects on. */
  by?: string
  /** chart: one series per column id. */
  series?: string[]
  /** kpi: the column being aggregated. */
  col?: string
  /** kpi: a NAMED measure (doc.measures). Not evaluated yet — see the report. */
  measure?: string
  agg?: string
  /** table: which columns to show. Absent means the first few. */
  cols?: string[]
}

export interface DashTile {
  /**
   * Tile identity, and load-bearing: it is what a selection remembers so a tile
   * can skip its own entries. Positional identity would break the moment a
   * tile moved, which is a thing authors do.
   */
  id: string
  kind: string
  /** Grid units — see `DashView`. */
  x: number
  y: number
  w: number
  h: number
  title?: string
  bind?: TileBind
  chart?: string
  /**
   * The KPI's comparison.
   *   `all`    — the same aggregate over every row, ignoring the selection.
   *              Reads as "£412k of £1.2m, 34% of all".
   *   `column` — the same aggregate over the same rows, of another column.
   *              Reads as "£412k against a £500k target, −18%".
   */
  compare?: { of: 'all' } | { of: 'column'; col: string }
  [extra: string]: unknown
}

/**
 * A dashboard.
 *
 * `w` and `h` are GRID UNITS — columns and rows — not pixels. The pixel height
 * of a row is chrome and lives in the stylesheet, because a dashboard has to
 * reflow onto a phone and a layout frozen in pixels cannot. Tiles are placed
 * in that unit grid, so the layout means the same thing to every reader, which
 * is the invariant PLATFORM §8 states for document coordinates.
 */
export interface DashView {
  id: string
  name: string
  w: number
  h: number
  tiles: DashTile[]
  [extra: string]: unknown
}

/** Grid columns a dashboard uses when the stored view does not say. */
export const DEFAULT_COLS = 12
/** Rows a table tile paints. Past this the tile says how many it is not showing. */
export const TABLE_ROWS = 200

// --- The selection ---------------------------------------------------------

/**
 * One click, remembered.
 *
 * `v` is the CATEGORY, canonicalised by `catOf` — a string, or `null` for the
 * blank category. It is deliberately not the raw cell value: the categories a
 * chart draws are already strings (chart.ts:64 stringifies the x column), so
 * storing the raw value would mean a bar click and a row click on the same
 * category produce two entries that do not cancel. Matching back to rows goes
 * through filter.ts's `isOneOf`, which canonicalises "10" and 10 to one key —
 * so a ticked category cannot fail to match its own rows (filter.ts:34).
 */
export interface SelectionEntry {
  /** The tile the click came from. A tile never applies its own entries. */
  from: string
  sheet: string
  col: string
  v: string | null
}

export type CrossSelection = SelectionEntry[]

/**
 * The category a value belongs to.
 *
 * BLANK IS A CATEGORY OF ITS OWN, and this one function is why no row is
 * silently dropped or silently kept:
 *
 *   - Every row maps to exactly one category of a column, blanks included, so
 *     the categories partition the sheet. Selecting "North" cannot match a
 *     blank Region; selecting "(blank)" matches exactly those rows.
 *   - `isBlank` is filter.ts's, so "" and "   " land in the same category the
 *     filter menu's "(Blanks)" box selects, and `isOneOf` matches a `null` in
 *     the set against exactly those rows (filter.ts:147 — `matchKey` sends
 *     every blank to one key). One definition of blank across the app, rather
 *     than a chart that offers a category the filter cannot express.
 *
 * The alternative — treating a null as "matches everything" so a selection
 * never hides an unknown — is the seductive wrong answer: the totals then do
 * not add up, because a row is counted under North AND South.
 */
export const catOf = (v: unknown): string | null => (isBlank(v) ? null : String(v))

/** What a category is called on screen. */
export const catLabel = (c: string | null): string => (c === null ? t('(blank)') : c)

/**
 * Add a category to the selection, or take it out if it is already there.
 *
 * PURE, and returns a NEW array: the class assigns the result inside
 * `store.view()`, and a mutation in place would leave the previous value
 * indistinguishable from the next one for anything holding a reference.
 *
 * Within one column, values OR (click North, then South, see both). Across
 * columns they AND (region = North AND stage = Won) — see `selectionFilters`.
 * That is what every BI tool does, and it is the only pair that makes clicking
 * a second bar mean something other than "no rows".
 */
export function toggleSelection(sel: CrossSelection, e: SelectionEntry): CrossSelection {
  const i = sel.findIndex(
    (x) => x.from === e.from && x.sheet === e.sheet && x.col === e.col && x.v === e.v,
  )
  return i >= 0 ? [...sel.slice(0, i), ...sel.slice(i + 1)] : [...sel, e]
}

/**
 * The filters ONE tile derives against.
 *
 * Two exclusions, and both are correctness rather than taste:
 *
 *   - ENTRIES FROM THIS TILE. A chart that filtered itself collapses to the
 *     one bar you clicked, and the other bars — the ones you would click to
 *     change your mind — are gone.
 *   - ENTRIES FROM ANOTHER SHEET. Two sheets sharing a column NAME are not
 *     related; a join is (model.ts:169), and dash has no relationship model
 *     yet. Filtering across sheets on a name coincidence would produce a
 *     number that looks joined and is not, which is the worst failure a
 *     dashboard has. So a selection reaches the tiles bound to its own sheet
 *     and stops there.
 *
 * The result is one `isOneOf` per column: OR inside, AND between, which is
 * exactly how `buildOrder` composes a list of ColumnFilters (filter.ts:341).
 */
export function selectionFilters(sel: CrossSelection, tile: DashTile): ColumnFilter[] {
  const sheet = tile.bind?.sheet
  if (!sheet) return []
  const byCol = new Map<string, Set<unknown>>()
  for (const e of sel) {
    if (e.from === tile.id) continue
    if (e.sheet !== sheet) continue
    let set = byCol.get(e.col)
    if (!set) { set = new Set<unknown>(); byCol.set(e.col, set) }
    // `null` in the set IS the "(Blanks)" box — filter.ts:66 says so, and
    // `matchKey` matches it against every blank in the column.
    set.add(e.v)
  }
  // Map preserves insertion order, so the filter list is deterministic and two
  // readers of one file build the same one.
  return [...byCol].map(([col, set]) => ({ col, pred: { op: 'isOneOf', set } }))
}

/** The categories picked ON this tile — what the tile highlights. */
export function pickedOn(
  sel: CrossSelection, tile: DashTile, col: string | undefined,
): Set<string | null> {
  const out = new Set<string | null>()
  if (!col) return out
  for (const e of sel) if (e.from === tile.id && e.col === col) out.add(e.v)
  return out
}

export interface Chip { entry: SelectionEntry; label: string }

/** The "Region: North ✕" row above the tiles — the only thing that makes a
 *  composed selection legible. A dashboard filtered by three clicks and saying
 *  so nowhere is how a reader ends up quoting a number for the wrong slice. */
export function selectionChips(sel: CrossSelection, doc: DashDoc): Chip[] {
  return sel.map((entry) => {
    const sheet = doc.sheets.find((s: Sheet) => s.id === entry.sheet)
    const col = sheet && sheet.kind === 'table'
      ? sheet.columns.find((c) => c.id === entry.col)
      : undefined
    return { entry, label: `${col?.name ?? entry.col}: ${catLabel(entry.v)}` }
  })
}

// --- Rows ------------------------------------------------------------------

export const rowCount = (s: TableSheet): number => s.rids.reduce((n, [, c]) => n + c, 0)

const expandRids = (s: TableSheet): number[] => {
  const out: number[] = []
  for (const [start, count] of s.rids) for (let i = 0; i < count; i++) out.push(start + i)
  return out
}

/**
 * Read one cell of a sheet, the way the reader sees it.
 *
 * OVERRIDES ARE HONOURED, and that is a fix rather than a flourish: a hand
 * correction (`sheet.cells`) is what the grid paints (grid.ts:398), so a
 * dashboard that read past it would put a number on a tile that disagrees with
 * the cell three inches away. chart.ts's own `colVals` reads the raw column —
 * but every tile here hands its columns to `optionFor` through this accessor
 * (see `deriveChart`), so the chart gets the corrections for free and the two
 * cannot diverge.
 *
 * `computed` is the grid's freshly recalculated formula columns; passing it
 * means a tile can chart a column that is nowhere in the document.
 *
 * The rid table is expanded ONCE per accessor and only when the sheet actually
 * has overrides — walking the run-length runs per cell would be O(runs) on
 * every read, and a full scan calls this once per row per column.
 */
export function sheetGet(sheet: TableSheet, computed?: Map<string, unknown[]>): Get {
  const over = sheet.cells
  const rids = over && Object.keys(over).length > 0 ? expandRids(sheet) : null
  return (col, row) => {
    const c = computed?.get(col)
    if (c) return c[row]
    if (rids) {
      const o = over![`${col}:${rids[row]}`]
      if (o && 'v' in o) return o.v
    }
    return readCell(sheet.data[col], row)
  }
}

/**
 * The rows a tile derives over: 0-based positions in the sheet's own order.
 *
 * `null` means EVERY row and is a fast path, not a special case — with no
 * filters `buildOrder` would allocate the identity vector for a 250k-row sheet
 * on every paint of every tile. The rig asserts the two agree, because a fast
 * path that quietly disagrees with the slow one is how a tile ends up showing
 * a different population from the tile beside it.
 *
 * Sorting is deliberately not applied: tiles group, and a group-by does not
 * care what order its input arrived in. A table tile shows sheet order, which
 * is the order the author put the rows in — grid sorting is that reader's view
 * of the grid, not a property of the dashboard.
 */
export function rowsForTile(
  sheet: TableSheet, get: Get, filters: ColumnFilter[],
): number[] | null {
  if (!filters.length) return null
  return buildOrder(rowCount(sheet), get, filters, [])
}

/** Materialise a row list. `null` (every row) becomes 0..n-1. */
export const rowList = (sheet: TableSheet, rows: number[] | null): number[] =>
  rows ?? Array.from({ length: rowCount(sheet) }, (_, i) => i)

// --- Derived tile data -----------------------------------------------------

export type EmptyReason =
  /** the selection left this tile with nothing */
  | 'no-rows'
  /** rows, but nothing numeric to plot */
  | 'no-values'
  /** the tile names a sheet that is not in this workbook */
  | 'no-sheet'
  /** the tile is not bound to columns yet */
  | 'no-binding'
  /** a tile kind this build does not draw */
  | 'unknown-kind'

export interface Series { name: string; data: Array<number | null> }

export type TileData =
  | { kind: 'empty'; reason: EmptyReason; note?: string }
  | {
      kind: 'chart'; chart: ChartKind; cats: Array<string | null>
      series: Series[]; colors: string[]; rows: number; note?: string
    }
  | {
      kind: 'kpi'; value: number | null; column?: Column; agg: Agg; rows: number
      /** which comparison was asked for — the RENDERER MUST BRANCH ON THIS and
       *  never on `baselineLabel`, which is a translated string: a branch on
       *  displayed text works in English and silently takes the wrong arm in
       *  every other locale (PLATFORM §8 — model values stay English words,
       *  and this is not even a model value). */
      compare: 'all' | 'column' | null
      baseline: number | null; baselineLabel?: string; baselineColumn?: Column
      /** value − baseline */
      delta: number | null
      /** delta / |baseline| — `null` when the baseline is 0 or absent */
      pct: number | null
      /** value / baseline — `null` when the baseline is 0 or absent */
      share: number | null
      note?: string
    }
  | { kind: 'table'; cols: Column[]; rows: number[]; total: number; by?: string }
  | { kind: 'text'; text: string }

const AGGS = ['sum', 'avg', 'min', 'max', 'count'] as const
export type Agg = (typeof AGGS)[number]

const aggOf = (s: string | undefined): Agg =>
  (AGGS as readonly string[]).includes(s ?? '') ? (s as Agg) : 'sum'

/** chart.ts groups with these four and no others; anything else means `sum`. */
const chartAggOf = (s: string | undefined): NonNullable<ChartBinding['aggregate']> =>
  s === 'avg' || s === 'count' || s === 'none' ? s : 'sum'

const chartKindOf = (s: unknown): ChartKind =>
  s === 'line' || s === 'pie' ? s : 'bar'

const tableOf = (doc: DashDoc, id: string | undefined): TableSheet | undefined => {
  const s = doc.sheets.find((x: Sheet) => x.id === id)
  return s && s.kind === 'table' ? s : undefined
}

/**
 * Everything a tile needs to paint, and nothing about how it looks.
 *
 * Pure, and re-run on every paint — see rule 2 in the header. The whole
 * cross-filter is this function called with a different `rows`.
 */
export function deriveTile(
  doc: DashDoc, tile: DashTile, rows: number[] | null,
  computed?: Map<string, unknown[]>,
): TileData {
  if (tile.kind === 'text') return { kind: 'text', text: String(tile.text ?? tile.title ?? '') }
  if (tile.kind !== 'chart' && tile.kind !== 'kpi' && tile.kind !== 'table') {
    return { kind: 'empty', reason: 'unknown-kind' }
  }
  const sheet = tableOf(doc, tile.bind?.sheet)
  if (!sheet) return { kind: 'empty', reason: 'no-sheet' }
  const list = rowList(sheet, rows)
  // NOTHING LEFT IS ITS OWN ANSWER. Falling through to the renderer would draw
  // an axis with no bars, and an empty bar chart reads as ZERO — which is a
  // number, which is a lie (model.ts:174 states the same rule for unresolved
  // transform steps).
  if (!list.length) return { kind: 'empty', reason: 'no-rows' }

  if (tile.kind === 'chart') return deriveChart(sheet, tile, list, computed)
  if (tile.kind === 'kpi') return deriveKpi(sheet, tile, list, computed)
  return deriveTable(sheet, tile, list)
}

function deriveChart(
  sheet: TableSheet, tile: DashTile, list: number[], computed?: Map<string, unknown[]>,
): TileData {
  const b = tile.bind
  const series = (b?.series ?? []).filter((id) => typeof id === 'string')
  if (!b?.x || !series.length) return { kind: 'empty', reason: 'no-binding' }

  const get = sheetGet(sheet, computed)
  // THE PROJECTION. `optionFor` takes a sheet and an optional map of
  // already-computed columns; hand it the SURVIVING rows in that map and a
  // sheet whose row count matches, and the app's one grouping implementation
  // does the cross-filtered arithmetic unchanged. Every bound column is in the
  // map, so `optionFor` never reads the raw encoding — which is also how the
  // chart inherits `sheetGet`'s cell overrides.
  const sub = new Map<string, unknown[]>()
  for (const id of series) sub.set(id, list.map((i) => get(id, i)))
  // THE CATEGORY COLUMN GOES THROUGH `catOf` FIRST, and this is what makes the
  // bars and the selection the same thing. chart.ts groups by `String(v)`, so
  // `null`, `''` and `'  '` are THREE categories — three bars all labelled
  // "(blank)", each selecting all the others' rows, because filter.ts sends
  // every blank to one key. Canonicalising before the group-by collapses them
  // into the one category the filter can express, so the categories a tile
  // draws are exactly the classes a click selects, and they partition the
  // sheet. (A number canonicalises to its own digits — "10" — which `isOneOf`
  // matches back to the cell holding 10; filter.ts:146 does that round trip.)
  const xcol = b.x
  sub.set(xcol, list.map((i) => catOf(get(xcol, i))))
  const projected = { ...sheet, rids: [[0, list.length]] as Array<[number, number]> }

  const kind = chartKindOf(tile.chart)
  const opt = optionFor(projected, {
    x: b.x, series, kind, aggregate: chartAggOf(b.agg),
  }, sub)
  const colors = Array.isArray(opt.color) ? (opt.color as string[]) : []
  const note = tile.chart === 'scatter'
    // A scatter point is a ROW; the dashboard's unit of picking is a CATEGORY,
    // so there is nothing to click. Drawn as a bar rather than refused, and
    // said out loud rather than silently substituted.
    ? t('Shown as bars — a scatter has no category to select.')
    : undefined

  if (kind === 'pie') {
    const data = (((opt.series as unknown[])[0] as { data?: unknown[] })?.data ?? []) as
      Array<{ name?: unknown; value?: unknown }>
    const cats = data.map((d) => catOf(d.name))
    const vals = data.map((d) => (typeof d.value === 'number' && Number.isFinite(d.value) ? d.value : null))
    const first = sheet.columns.find((c) => c.id === series[0])
    return {
      kind: 'chart', chart: 'pie', cats, colors, rows: list.length,
      series: [{ name: first?.name ?? series[0], data: vals }],
      note: series.length > 1 ? t('A pie shows one series; the rest are in the legend of the bar view.') : note,
    }
  }

  const cats = (((opt.xAxis as { data?: unknown[] })?.data ?? []) as unknown[]).map(catOf)
  const out = ((opt.series ?? []) as Array<{ name?: unknown; data?: unknown[] }>).map((s) => ({
    name: String(s.name ?? ''),
    data: ((s.data ?? []) as unknown[]).map((v) =>
      typeof v === 'number' && Number.isFinite(v) ? v : null),
  }))
  return { kind: 'chart', chart: kind, cats, series: out, colors, rows: list.length, note }
}

/**
 * One number, and what it is being compared with.
 *
 * The aggregate is filter.ts's `summarize` over the surviving rows, which is
 * the same call the status bar makes — so a KPI and a selection summary can
 * never disagree, and three of its properties are load-bearing here:
 *
 *   - IT DIVIDES BY THE VALUES PRESENT. An average over a column with blanks
 *     divides by the numbers, not by the rows; dividing by rows quietly
 *     understates every average in proportion to how patchy the data is.
 *   - IT ANSWERS null, NOT 0, when there is nothing to aggregate. A sum of
 *     nothing shown as £0 is a lie with a number's face.
 *   - `count` is the count of values PRESENT, not of rows. Same definition as
 *     the status bar's Count; a KPI that counted blanks would disagree with
 *     the number in the footer for the same selection.
 */
function deriveKpi(
  sheet: TableSheet, tile: DashTile, list: number[], computed?: Map<string, unknown[]>,
): TileData {
  const col = tile.bind?.col
  if (!col) {
    return {
      kind: 'empty', reason: 'no-binding',
      // A named measure carries an EXPRESSION (model.ts:240) and dash has no
      // aggregate evaluator yet. Saying so beats rendering a plausible number
      // derived from something else.
      note: tile.bind?.measure ? t('Named measures need the measure engine.') : undefined,
    }
  }
  const get = sheetGet(sheet, computed)
  const agg = aggOf(tile.bind?.agg)
  const pick = (c: string, rows: number[]): number | null => {
    const s = summarize(get, c, rows)
    return agg === 'count' ? s.count
      : agg === 'avg' ? s.avg
        : agg === 'min' ? s.min
          : agg === 'max' ? s.max
            : s.sum
  }

  const value = pick(col, list)
  const column = sheet.columns.find((c) => c.id === col)

  let baseline: number | null = null
  let baselineLabel: string | undefined
  let baselineColumn: Column | undefined
  const cmp = tile.compare
  if (cmp?.of === 'all') {
    // Deliberately the WHOLE sheet, selection and all — that is the point of
    // this comparison: "how much of everything is this?".
    baseline = pick(col, rowList(sheet, null))
    baselineLabel = t('of all rows')
  } else if (cmp?.of === 'column' && cmp.col) {
    baseline = pick(cmp.col, list)
    baselineColumn = sheet.columns.find((c) => c.id === cmp.col)
    baselineLabel = baselineColumn?.name ?? cmp.col
  }

  // A RATIO AGAINST NOTHING IS NOT A RATIO. `value / 0` is Infinity and `0 / 0`
  // is NaN, and both render as a confident string on a dashboard tile
  // ("Infinity%" above a target of zero). A missing baseline and a zero
  // baseline both answer null, which the renderer shows as "—".
  const usable = baseline !== null && Number.isFinite(baseline) && baseline !== 0
  const delta = value !== null && baseline !== null ? value - baseline : null
  return {
    kind: 'kpi', value, column, agg, rows: list.length,
    compare: cmp?.of === 'all' ? 'all' : cmp?.of === 'column' && cmp.col ? 'column' : null,
    baseline, baselineLabel, baselineColumn,
    delta,
    pct: usable && delta !== null ? delta / Math.abs(baseline as number) : null,
    share: usable && value !== null ? value / (baseline as number) : null,
    note: value === null && list.length
      ? t('No numeric values in this column for the current selection.')
      : undefined,
  }
}

function deriveTable(sheet: TableSheet, tile: DashTile, list: number[]): TileData {
  const want = tile.bind?.cols
  const cols = want?.length
    ? want.map((id) => sheet.columns.find((c) => c.id === id)).filter((c): c is Column => !!c)
    : sheet.columns.slice(0, 6)
  return { kind: 'table', cols, rows: list, total: rowCount(sheet), by: tile.bind?.by }
}

// --- Views in the document -------------------------------------------------

/** The dashboards a workbook carries. Absent is normal, not an error. */
export const viewsOf = (doc: DashDoc): DashView[] =>
  (Array.isArray(doc.views) ? doc.views : []) as unknown as DashView[]

/**
 * A document with this dashboard in it, replacing any view with the same id.
 *
 * NOT A MUTATION, and not a `commit` either: the store's Patch union has no op
 * that writes a top-level document field other than the title, so persisting a
 * layout needs `setView` (see the report). Until then this is the honest path —
 * `store.replaceDoc(withView(doc, v))` — which is undoable-as-a-whole and does
 * not pretend to be finer-grained than it is.
 */
export function withView(doc: DashDoc, view: DashView): DashDoc {
  const views = viewsOf(doc)
  const at = views.findIndex((v) => v.id === view.id)
  const next = at >= 0
    ? [...views.slice(0, at), view, ...views.slice(at + 1)]
    : [...views, view]
  return { ...doc, views: next as unknown as View[] }
}

/**
 * A dashboard for a workbook that has none: a KPI row, a bar chart, a pie and
 * the rows underneath. It is EPHEMERAL until something writes it into the
 * document — a dashboard nobody arranged should not dirty the file just for
 * being looked at.
 *
 * Returns null when the sheet has nothing to put on one, rather than an empty
 * grid of empty tiles.
 */
export function defaultDashboard(doc: DashDoc): DashView | null {
  const sheet = doc.sheets.find((s: Sheet): s is TableSheet => s.kind === 'table')
  if (!sheet || !sheet.columns.length) return null
  const label = sheet.columns.find((c) => c.type === 'text' || c.type === 'enum')
  const nums = sheet.columns.filter((c) => c.type === 'money' || c.type === 'number')
  const pcts = sheet.columns.filter((c) => c.type === 'percent')
  const measure = nums[0] ?? pcts[0]
  if (!measure) return null
  const second = sheet.columns.find(
    (c) => (c.type === 'text' || c.type === 'enum') && c.id !== label?.id,
  )
  const s = sheet.id

  const tiles: DashTile[] = [
    {
      id: 'kpi-total', kind: 'kpi', x: 0, y: 0, w: 3, h: 1,
      title: `${t('Total')} ${measure.name}`,
      bind: { sheet: s, col: measure.id, agg: 'sum' }, compare: { of: 'all' },
    },
    {
      id: 'kpi-avg', kind: 'kpi', x: 3, y: 0, w: 3, h: 1,
      title: `${t('Average')} ${measure.name}`,
      bind: { sheet: s, col: measure.id, agg: 'avg' },
    },
    {
      id: 'kpi-rows', kind: 'kpi', x: 6, y: 0, w: 3, h: 1,
      title: t('Rows'),
      bind: { sheet: s, col: measure.id, agg: 'count' }, compare: { of: 'all' },
    },
    ...(pcts[0] && pcts[0].id !== measure.id
      ? [{
        id: 'kpi-pct', kind: 'kpi', x: 9, y: 0, w: 3, h: 1,
        title: `${t('Average')} ${pcts[0].name}`,
        bind: { sheet: s, col: pcts[0].id, agg: 'avg' },
      } as DashTile]
      : []),
  ]

  if (label) {
    tiles.push({
      id: 'chart-by-label', kind: 'chart', x: 0, y: 1, w: 7, h: 3,
      title: `${measure.name} ${t('by')} ${label.name}`, chart: 'bar',
      bind: { sheet: s, x: label.id, series: [measure.id], agg: 'sum' },
    })
  }
  if (second) {
    tiles.push({
      id: 'chart-by-second', kind: 'chart', x: label ? 7 : 0, y: 1, w: 5, h: 3,
      title: `${measure.name} ${t('by')} ${second.name}`, chart: 'pie',
      bind: { sheet: s, x: second.id, series: [measure.id], agg: 'sum' },
    })
  }
  tiles.push({
    id: 'table-rows', kind: 'table', x: 0, y: 4, w: 12, h: 3,
    title: sheet.name,
    bind: { sheet: s, by: label?.id ?? second?.id },
  })

  return {
    id: `view-${sheet.id}`, name: t('Dashboard'), w: DEFAULT_COLS,
    h: tiles.reduce((n, tile) => Math.max(n, tile.y + tile.h), 0), tiles,
  }
}

// --- Drawing ---------------------------------------------------------------
//
// The tiles paint their own SVG rather than mounting charts-lite, and the
// reason is picking: `mountChart` (kernel/src/charts.ts:741) draws marks with
// no identity and offers no click callback, so there is no way to ask it which
// bar was pressed. Guessing the plot rectangle from the outside and overlaying
// hit strips would tie this file to charts-lite's internal margins — a silent
// break the first time they change. The ARITHMETIC still comes from
// `optionFor`; only the painting is local, and every mark carries the category
// it stands for. (The hook that would collapse this is in the report.)

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

const CW = 400
const CH = 210
const PAD = { l: 46, r: 10, t: 14, b: 26 }

/** Axis ticks a person would have chosen. */
export function niceTicks(min: number, max: number, want = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0]
  if (!(max > min)) return [min]
  const raw = (max - min) / Math.max(1, want)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag
  const out: number[] = []
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  for (let v = lo; v <= hi + step / 1e6; v += step) out.push(Math.abs(v) < step / 1e6 ? 0 : v)
  return out
}

/** Axis labels have ~40px; 12,400,000 does not fit and 12.4M does. */
function short(n: number): string {
  const a = Math.abs(n)
  const [d, suffix] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'k'] : [1, '']
  const v = n / d
  return (Math.abs(v) < 10 && v % 1 !== 0 ? v.toFixed(1) : Math.round(v).toString()) + suffix
}

const clip = (s: string, n = 12): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

interface PickAttrs { tile: string; col: string }

/** The attributes that make a mark pickable. `data-blank` is how a null
 *  category survives an HTML attribute round trip — an absent `data-cat` and a
 *  `data-cat=""` are the same string on the way back, and one of them means
 *  the blank category while the other means a bug. */
const pickAttr = (p: PickAttrs, cat: string | null): string =>
  `data-tile="${esc(p.tile)}" data-col="${esc(p.col)}" ` +
  (cat === null ? 'data-blank="1"' : `data-cat="${esc(cat)}"`)

function cartesianSvg(
  td: Extract<TileData, { kind: 'chart' }>, pick: PickAttrs, on: Set<string | null>,
): string {
  const vals = td.series.flatMap((s) => s.data).filter((v): v is number => v !== null)
  if (!vals.length) return ''
  const line = td.chart === 'line'
  // A BAR'S BASELINE IS ZERO. Cropping the axis to the data makes a 2% spread
  // look like a doubling, which is the oldest chart lie there is. A LINE may
  // crop — it is read as a trend, not as an area.
  const lo = Math.min(...vals, line ? Infinity : 0)
  const hi = Math.max(...vals, line ? -Infinity : 0)
  const ticks = niceTicks(lo, hi === lo ? lo + 1 : hi)
  const y0 = ticks[0]
  const y1 = ticks[ticks.length - 1]
  const pw = CW - PAD.l - PAD.r
  const ph = CH - PAD.t - PAD.b
  const yOf = (v: number): number => PAD.t + ph - ((v - y0) / (y1 - y0 || 1)) * ph
  const band = pw / Math.max(1, td.cats.length)
  const dim = on.size > 0

  const parts: string[] = []
  for (const tv of ticks) {
    const y = yOf(tv)
    parts.push(`<line class="dbx-grid" x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${CW - PAD.r}" y2="${y.toFixed(1)}"/>`)
    parts.push(`<text class="dbx-ytick" x="${PAD.l - 6}" y="${(y + 3.5).toFixed(1)}">${esc(short(tv))}</text>`)
  }

  const every = Math.ceil(td.cats.length / 9)
  td.cats.forEach((cat, i) => {
    const x = PAD.l + i * band
    const sel = on.has(cat)
    if (sel) {
      parts.push(`<rect class="dbx-band-on" x="${x.toFixed(1)}" y="${PAD.t}" width="${band.toFixed(1)}" height="${ph}"/>`)
    }
    if (i % every === 0) {
      parts.push(`<text class="dbx-xtick" x="${(x + band / 2).toFixed(1)}" y="${CH - PAD.b + 14}">${esc(clip(catLabel(cat)))}</text>`)
    }
    // The hit target is the whole BAND, not the bar: a 6px bar is not a click
    // target, and a category whose value is null has no bar at all — but it is
    // still a category, and refusing to let it be picked would put rows beyond
    // reach of the reader.
    parts.push(
      `<rect class="dbx-hit" ${pickAttr(pick, cat)} x="${x.toFixed(1)}" y="${PAD.t}" ` +
      `width="${band.toFixed(1)}" height="${ph}"><title>${esc(catLabel(cat))}</title></rect>`,
    )
  })

  if (line) {
    td.series.forEach((s, si) => {
      const color = td.colors[si % Math.max(1, td.colors.length)] ?? '#888'
      let run: string[] = []
      const flush = (): void => {
        if (run.length > 1) parts.push(`<polyline class="dbx-line" points="${run.join(' ')}" stroke="${esc(color)}"/>`)
        run = []
      }
      s.data.forEach((v, i) => {
        // A GAP, NEVER A ZERO (chart.ts:16): the line breaks where the data is
        // missing rather than diving to the axis and back.
        if (v === null) { flush(); return }
        const x = PAD.l + i * band + band / 2
        run.push(`${x.toFixed(1)},${yOf(v).toFixed(1)}`)
        parts.push(
          `<circle class="dbx-dot${dim && !on.has(td.cats[i]) ? ' dbx-dim' : ''}" ` +
          `cx="${x.toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="3" fill="${esc(color)}"/>`,
        )
      })
      flush()
    })
  } else {
    const inner = band * 0.72
    const bw = inner / Math.max(1, td.series.length)
    td.series.forEach((s, si) => {
      const color = td.colors[si % Math.max(1, td.colors.length)] ?? '#888'
      s.data.forEach((v, i) => {
        if (v === null) return
        const x = PAD.l + i * band + (band - inner) / 2 + si * bw
        const yv = yOf(v)
        const yz = yOf(Math.min(Math.max(0, y0), y1))
        const top = Math.min(yv, yz)
        const h = Math.max(1, Math.abs(yz - yv))
        parts.push(
          `<rect class="dbx-bar${dim && !on.has(td.cats[i]) ? ' dbx-dim' : ''}" ` +
          `x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" ` +
          `height="${h.toFixed(1)}" fill="${esc(color)}"/>`,
        )
      })
    })
  }

  parts.push(`<line class="dbx-axis" x1="${PAD.l}" y1="${yOf(Math.min(Math.max(0, y0), y1)).toFixed(1)}" x2="${CW - PAD.r}" y2="${yOf(Math.min(Math.max(0, y0), y1)).toFixed(1)}"/>`)
  return parts.join('')
}

function pieSvg(
  td: Extract<TileData, { kind: 'chart' }>, pick: PickAttrs, on: Set<string | null>,
): string {
  // A PIE OF NEGATIVE NUMBERS IS NOT A PIE. A slice is a share of a whole, and
  // a negative share has no angle; drawing |v| would silently show a loss as a
  // gain. They are dropped and counted, and the tile says how many.
  const slices = td.cats
    .map((cat, i) => ({ cat, v: td.series[0]?.data[i] ?? null }))
    .filter((s): s is { cat: string | null; v: number } => s.v !== null && s.v > 0)
  const total = slices.reduce((n, s) => n + s.v, 0)
  if (!slices.length || !(total > 0)) return ''

  const cx = 118
  const cy = CH / 2
  const r = 78
  const dim = on.size > 0
  const parts: string[] = []
  let a = -Math.PI / 2
  slices.forEach((s, i) => {
    const color = td.colors[i % Math.max(1, td.colors.length)] ?? '#888'
    const sweep = (s.v / total) * Math.PI * 2
    const cls = `dbx-slice${dim && !on.has(s.cat) ? ' dbx-dim' : ''}${on.has(s.cat) ? ' dbx-slice-on' : ''}`
    if (slices.length === 1) {
      // One slice is a whole circle, and an arc from an angle back to itself
      // draws nothing at all.
      parts.push(`<circle class="${cls}" ${pickAttr(pick, s.cat)} cx="${cx}" cy="${cy}" r="${r}" fill="${esc(color)}"><title>${esc(catLabel(s.cat))}</title></circle>`)
    } else {
      const x0 = cx + r * Math.cos(a)
      const y0 = cy + r * Math.sin(a)
      const x1 = cx + r * Math.cos(a + sweep)
      const y1 = cy + r * Math.sin(a + sweep)
      parts.push(
        `<path class="${cls}" ${pickAttr(pick, s.cat)} fill="${esc(color)}" ` +
        `d="M${cx} ${cy}L${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ` +
        `${x1.toFixed(1)} ${y1.toFixed(1)}Z"><title>${esc(catLabel(s.cat))}</title></path>`,
      )
    }
    a += sweep
  })

  slices.slice(0, 7).forEach((s, i) => {
    const color = td.colors[i % Math.max(1, td.colors.length)] ?? '#888'
    const y = 26 + i * 22
    parts.push(
      `<g class="dbx-key${dim && !on.has(s.cat) ? ' dbx-dim' : ''}" ${pickAttr(pick, s.cat)}>` +
      `<rect class="dbx-swatch" x="228" y="${y - 9}" width="10" height="10" fill="${esc(color)}"/>` +
      `<text class="dbx-keytext" x="244" y="${y}">${esc(clip(catLabel(s.cat), 16))} · ` +
      `${esc(Math.round((s.v / total) * 100))}%</text></g>`,
    )
  })
  return parts.join('')
}

function chartSvg(
  td: Extract<TileData, { kind: 'chart' }>, pick: PickAttrs, on: Set<string | null>,
): string {
  const body = td.chart === 'pie' ? pieSvg(td, pick, on) : cartesianSvg(td, pick, on)
  if (!body) return `<div class="dbx-empty">${esc(t('Nothing numeric to plot for this selection.'))}</div>`
  const legend = td.chart !== 'pie' && td.series.length > 1
    ? `<div class="dbx-legend">${td.series.map((s, i) =>
      `<span><i style="background:${esc(td.colors[i % Math.max(1, td.colors.length)] ?? '#888')}"></i>${esc(s.name)}</span>`).join('')}</div>`
    : ''
  return `${legend}<svg class="dbx-svg" viewBox="0 0 ${CW} ${CH}" preserveAspectRatio="xMidYMid meet" role="img">${body}</svg>`
}

// --- The surface -----------------------------------------------------------

export interface DashboardHost {
  el: HTMLElement
  store: Store
  /** Which stored view to show. Absent means the first one. */
  viewId?: string
}

export class Dashboard {
  private host: HTMLElement
  private store: Store
  private offs: Array<() => void> = []
  /** A dashboard minted for a workbook that carries none. Ephemeral: it is
   *  never written to the document by being looked at. */
  private fallback: DashView | null = null
  private fallbackFor = ''

  viewId?: string
  /** VIEWER state. Never in the document, never synced, never undoable — the
   *  same tier as the grid's sort and the reduce-motion flag in slides. */
  selection: CrossSelection = []
  /**
   * The grid's recalculated formula columns, so a tile can chart a column that
   * is nowhere in the document.
   *
   * A CALLBACK, not a Map: `Grid.paint` REPLACES `grid.computed` on every
   * recalculation rather than mutating it, so a field holding the map would
   * hold last recalculation's copy — a tile quietly plotting a formula column
   * as it was two edits ago, which is exactly the staleness deriving at render
   * exists to prevent. Reading it through a function cannot go stale.
   */
  computed?: () => Map<string, unknown[]> | undefined
  onSelectionChange?: (sel: CrossSelection) => void

  constructor(opts: DashboardHost) {
    this.host = opts.el
    this.store = opts.store
    this.viewId = opts.viewId
    this.host.classList.add('dbx')
    this.host.addEventListener('click', this.onClick)
    // Both events: 'doc' because a cell edit must move every tile, 'view'
    // because that is what a pick emits.
    this.offs.push(this.store.on('doc', this.render))
    this.offs.push(this.store.on('view', this.render))
    this.render()
  }

  destroy(): void {
    this.host.removeEventListener('click', this.onClick)
    for (const off of this.offs) off()
    this.offs = []
    this.host.innerHTML = ''
  }

  /** The dashboard being shown: the document's, or a minted one. */
  get view(): DashView | null {
    const views = viewsOf(this.store.doc)
    const stored = this.viewId ? views.find((v) => v.id === this.viewId) : views[0]
    if (stored) return stored
    // Re-mint when the workbook changes identity (a load, a replaceDoc), and
    // not on every paint — a fresh object each frame would throw away the tile
    // ids the selection is keyed by.
    const key = `${this.store.doc.docId}:${this.store.doc.sheets.map((s: Sheet) => s.id).join(',')}`
    if (this.fallbackFor !== key) {
      this.fallback = defaultDashboard(this.store.doc)
      this.fallbackFor = key
    }
    return this.fallback
  }

  /**
   * Pick a category, or let it go.
   *
   * THROUGH `store.view()`: no checkpoint, no dirty flag, no op. This one call
   * is the difference between a dashboard you can explore and a file that
   * rewrites itself while you do.
   */
  pick(entry: SelectionEntry): void {
    this.store.view(() => { this.selection = toggleSelection(this.selection, entry) })
    this.onSelectionChange?.(this.selection)
  }

  clearSelection(): void {
    if (!this.selection.length) return
    this.store.view(() => { this.selection = [] })
    this.onSelectionChange?.(this.selection)
  }

  private onClick = (ev: MouseEvent): void => {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-tile]')
    if (el) {
      const tile = el.dataset.tile!
      const col = el.dataset.col!
      const sheet = el.closest<HTMLElement>('.dbx-tile')?.dataset.sheet
        ?? this.view?.tiles.find((x) => x.id === tile)?.bind?.sheet
      if (!sheet) return
      const cat = el.hasAttribute('data-blank') ? null : (el.dataset.cat ?? '')
      this.pick({ from: tile, sheet, col, v: cat })
      return
    }
    const chip = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-chip]')
    if (chip) {
      const i = Number(chip.dataset.chip)
      const e = this.selection[i]
      if (e) this.pick(e)
      return
    }
    if ((ev.target as HTMLElement | null)?.closest('[data-clear]')) this.clearSelection()
  }

  render = (): void => {
    const doc = this.store.doc
    const view = this.view
    if (!view) {
      this.host.innerHTML = `<div class="dbx-blank">${esc(t('This workbook has no dashboard yet.'))}</div>`
      return
    }
    const chips = selectionChips(this.selection, doc)
    const bar = chips.length
      ? `<div class="dbx-chips"><span class="dbx-chips-label">${esc(t('Filtered by'))}</span>` +
        chips.map((c, i) =>
          `<button class="dbx-chip" data-chip="${i}" title="${esc(t('Remove this filter'))}">${esc(c.label)} ✕</button>`).join('') +
        `<button class="dbx-chip dbx-chip-clear" data-clear="1">${esc(t('Clear all'))}</button></div>`
      : `<div class="dbx-chips dbx-chips-idle">${esc(t('Click a bar, a slice or a row to filter every tile.'))}</div>`

    const tiles = view.tiles.map((tile) => this.tileHtml(doc, tile)).join('')
    this.host.style.setProperty('--dbx-cols', String(Math.max(1, view.w || DEFAULT_COLS)))
    this.host.innerHTML = `${bar}<div class="dbx-grid-wrap">${tiles}</div>`
  }

  private tileHtml(doc: DashDoc, tile: DashTile): string {
    const sheet = tableOf(doc, tile.bind?.sheet)
    // EVERY PAINT RE-DERIVES (rule 2): the filters, the rows and the numbers.
    const filters = selectionFilters(this.selection, tile)
    const computed = this.computed?.()
    const rows = sheet ? rowsForTile(sheet, sheetGet(sheet, computed), filters) : null
    const td = deriveTile(doc, tile, rows, computed)

    const style = `grid-column:${tile.x + 1}/span ${Math.max(1, tile.w)};` +
      `grid-row:${tile.y + 1}/span ${Math.max(1, tile.h)}`
    const head = tile.title
      ? `<div class="dbx-head"><span class="dbx-title">${esc(tile.title)}</span>` +
        (filters.length ? `<span class="dbx-filtered" title="${esc(t('This tile is filtered by another tile'))}">▼</span>` : '') +
        `</div>`
      : ''
    return `<section class="dbx-tile dbx-${esc(tile.kind)}" data-sheet="${esc(tile.bind?.sheet ?? '')}" style="${style}">` +
      `${head}<div class="dbx-body">${this.bodyHtml(tile, td)}</div></section>`
  }

  private bodyHtml(tile: DashTile, td: TileData): string {
    const note = (s: string | undefined): string => (s ? `<div class="dbx-note">${esc(s)}</div>` : '')
    switch (td.kind) {
      case 'empty':
        return `<div class="dbx-empty">${esc(EMPTY_TEXT[td.reason]())}</div>${note(td.note)}`
      case 'text':
        return `<div class="dbx-text">${esc(td.text)}</div>`
      case 'chart': {
        const col = tile.bind?.x ?? ''
        return chartSvg(td, { tile: tile.id, col }, pickedOn(this.selection, tile, col)) + note(td.note)
      }
      case 'kpi':
        return this.kpiHtml(td) + note(td.note)
      case 'table':
        return this.tableHtml(tile, td)
    }
  }

  private kpiHtml(td: Extract<TileData, { kind: 'kpi' }>): string {
    // "—", NEVER "0". A KPI showing zero for "we could not compute this" is the
    // single most expensive wrong number a dashboard can print.
    const asText = (v: number | null, col?: Column): string =>
      v === null ? '—'
        : td.agg === 'count' ? v.toLocaleString()
          : formatValue(v, col ?? { type: 'number' })
    const value = asText(td.value, td.column)
    let sub: string
    if (td.compare === 'all' && td.baseline !== null) {
      // "of all" is a SHARE, never a delta: a filtered slice being smaller than
      // the whole is not a fall, and colouring it red would say it was.
      sub = `${td.share === null ? '—' : `${Math.round(td.share * 100)}%`} ${td.baselineLabel ?? ''}` +
        ` · ${asText(td.baseline, td.column)}`
    } else if (td.compare === 'column' && td.baseline !== null) {
      const pct = td.pct === null ? '—' : `${td.pct > 0 ? '+' : ''}${Math.round(td.pct * 100)}%`
      sub = `${pct} ${t('vs')} ${td.baselineLabel ?? ''} ${asText(td.baseline, td.baselineColumn)}`
    } else {
      sub = `${td.rows.toLocaleString()} ${td.rows === 1 ? t('row') : t('rows')}`
    }
    const dir = td.compare !== 'column' || td.delta === null || td.delta === 0
      ? '' : td.delta > 0 ? ' dbx-up' : ' dbx-down'
    return `<div class="dbx-value">${esc(value)}</div><div class="dbx-sub${dir}">${esc(sub)}</div>`
  }

  private tableHtml(tile: DashTile, td: Extract<TileData, { kind: 'table' }>): string {
    const doc = this.store.doc
    const sheet = tableOf(doc, tile.bind?.sheet)!
    const get = sheetGet(sheet, this.computed?.())
    const by = td.by
    const on = pickedOn(this.selection, tile, by)
    const shown = td.rows.slice(0, TABLE_ROWS)
    const head = `<tr>${td.cols.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr>`
    const body = shown.map((r) => {
      const cat = by ? catOf(get(by, r)) : undefined
      const attrs = by ? ` ${pickAttr({ tile: tile.id, col: by }, cat ?? null)}` : ''
      const cls = by && on.has(cat ?? null) ? ' class="dbx-row-on"' : ''
      return `<tr${cls}${attrs}>${td.cols.map((c) =>
        `<td>${esc(formatValue(get(c.id, r), c))}</td>`).join('')}</tr>`
    }).join('')
    // The footer states BOTH numbers. "200 rows" under a filtered table is how
    // a reader quotes a subtotal as a total.
    const foot = `<div class="dbx-note">${esc(
      td.rows.length === td.total
        ? t('{n} rows').replace('{n}', td.total.toLocaleString())
        : t('{k} of {n} rows').replace('{k}', td.rows.length.toLocaleString()).replace('{n}', td.total.toLocaleString()),
    )}${td.rows.length > shown.length ? esc(` · ${t('showing the first {k}').replace('{k}', String(TABLE_ROWS))}`) : ''}</div>`
    return `<div class="dbx-scroll"><table class="dbx-table">${head}${body}</table></div>${foot}`
  }
}

/**
 * Why a tile is empty, said in words.
 *
 * Functions, not a frozen record: `t()` must never be called at module scope
 * (PLATFORM §8 — the catalog is not loaded yet and the string freezes in
 * English forever).
 */
const EMPTY_TEXT: Record<EmptyReason, () => string> = {
  'no-rows': () => t('No rows match the current selection.'),
  'no-values': () => t('Nothing numeric to plot for this selection.'),
  'no-sheet': () => t('This tile points at a sheet that is not in this workbook.'),
  'no-binding': () => t('This tile is not bound to any columns yet.'),
  'unknown-kind': () => t('This tile needs a newer version of dash.'),
}

export const _internals = { esc, short, clip, chartSvg, cartesianSvg, pieSvg, CW, CH }
