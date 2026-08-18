#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash dashboard + cross-filtering rig.
//
//   node scripts/test-dash-dashboard.ts      (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. A dashboard is the one surface where every failure is
// silent: the tiles still paint, the bars still have heights, and the number
// on screen is a real number — of the wrong population. Six ways that happens,
// and every one of them looks like a working dashboard:
//
//   1. A TILE THAT FILTERS ITSELF. Click "North" on a region chart and the
//      chart becomes one bar — so the reader cannot click "South", cannot
//      click "North" again, and the selection is not in the undo stack because
//      it is view state. A control that traps you is worse than no control.
//   2. A SELECTION THAT DOES NOT COMPOSE. Two clicks on two tiles must mean
//      region = North AND stage = Won. The natural bug — a map keyed by column
//      that is assigned instead of merged — keeps the LAST click, and the tile
//      answers a wider question than it was asked, confidently.
//   3. A BLANK THAT BELONGS TO EVERY CATEGORY, OR TO NONE. Both are wrong and
//      both are invisible: rows counted twice make totals that do not add up,
//      rows counted never make a dashboard whose categories quietly omit part
//      of the sheet. The check here is an EQUALITY — the categories of a
//      column partition the rows — because that is the statement that stops
//      being true when somebody "just" changes how nulls are stringified.
//   4. AN EMPTY RESULT DRAWN AS ZERO. An axis with no bars reads as "we sold
//      nothing", and a KPI of £0 reads as a loss. Both are a lie in the shape
//      of a number, and both are what falling through to the renderer does.
//   5. AN AVERAGE DIVIDED BY ROWS. Dividing by rows rather than by the values
//      PRESENT understates every average in proportion to how patchy the data
//      is — a number that is plausible, stable and wrong.
//   6. A CACHED SERIES. The whole reason dash derives series at render is that
//      a stored one can disagree with the table beside it. A memo keyed by
//      tile id under a live selection is the same bug wearing a performance
//      argument.
//
// Every check below is then RE-RUN against a deliberately broken dependency,
// and the run fails if the break does not trip it. A check that passes for a
// broken implementation is not a check, and the only way to find out is to
// break it on purpose.

import { registerHooks } from 'node:module'

// dashboard.ts imports its stylesheet — Vite's job, not Node's. Stub the
// extension rather than moving the import, which is how every Bento app
// co-locates a surface with its styles.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const {
  catOf, deriveTile, rowList, rowsForTile, selectionFilters, sheetGet,
  toggleSelection, selectionChips, pickedOn, withView, viewsOf, defaultDashboard,
  niceTicks, Dashboard, DEFAULT_COLS,
} = await import('../dash/src/dashboard.ts')
type DashTile = import('../dash/src/dashboard.ts').DashTile
type DashView = import('../dash/src/dashboard.ts').DashView
type CrossSelection = import('../dash/src/dashboard.ts').CrossSelection
type SelectionEntry = import('../dash/src/dashboard.ts').SelectionEntry
type TileData = import('../dash/src/dashboard.ts').TileData

const { parseDoc } = await import('../dash/src/model.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc
type TableSheet = import('../dash/src/model.ts').TableSheet

const { Store } = await import('../dash/src/store.ts')
const { starterDoc } = await import('../dash/src/starter.ts')
type ColumnFilter = import('../dash/src/filter.ts').ColumnFilter

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string): void {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** Inside a check: a broken dependency has to make one of these throw. */
class CheckFailed extends Error {}
function must(cond: boolean, msg: string): void {
  if (!cond) throw new CheckFailed(msg)
}

/**
 * A NEGATIVE CONTROL. Run a check against a broken dependency and require it
 * to trip. `ok` reports the mutation, not the check — so the transcript reads
 * as "this break was caught", which is the only thing a negative control is
 * evidence of.
 */
function mutated(name: string, run: () => void): void {
  let thrown: unknown
  try { run() } catch (e) { thrown = e }
  ok(thrown instanceof CheckFailed,
    `MUTANT — ${name} — is caught${thrown && !(thrown instanceof CheckFailed) ? ` (by a crash, not a check: ${(thrown as Error).message})` : ''}`)
}

// --------------------------------------------------------------- fixtures

/**
 * Seven rows, and every awkward case is deliberate:
 *   - row 4 has a BLANK region: the category that must exist, must be
 *     clickable, and must not be swept into North.
 *   - rows 3 and 5 have a blank VALUE: what `avg` must not divide by and what
 *     a bar must draw as a gap rather than as a zero.
 *   - row 5 (East) has no value at all: a category whose bar is absent and
 *     which still has to be selectable.
 *   - `zero` is all zeroes: the baseline that makes a percentage undefined.
 */
const FIXTURE = {
  format: 'bento/dash',
  version: 1,
  policy: 'bento-dash-1',
  docId: 'doc-fixture',
  title: 'pipeline',
  sheets: [{
    id: 'sales',
    name: 'Sales',
    kind: 'table',
    rids: [[1, 7]],
    columns: [
      { id: 'region', name: 'Region', type: 'text' },
      { id: 'stage', name: 'Stage', type: 'text' },
      { id: 'value', name: 'Value', type: 'money' },
      { id: 'target', name: 'Target', type: 'money' },
      { id: 'zero', name: 'Zero', type: 'number' },
    ],
    data: {
      region: { enc: 'raw', v: ['North', 'North', 'South', 'South', null, 'East', 'North'] },
      stage: { enc: 'raw', v: ['Won', 'Open', 'Won', 'Lost', 'Won', 'Open', 'Won'] },
      value: { enc: 'raw', v: [100, 200, 300, null, 400, null, 50] },
      target: { enc: 'raw', v: [120, 150, 200, 50, 100, null, 10] },
      zero: { enc: 'raw', v: [0, 0, 0, 0, 0, 0, 0] },
    },
    steps: [{ op: 'import', from: 'fixture', at: '2026-08-05T00:00:00Z', rows: 7 }],
  }],
}

const fresh = (): DashDoc => {
  const r = parseDoc(JSON.stringify(FIXTURE))
  if (!r.ok) throw new Error('fixture does not parse')
  return r.doc
}

const sheetOf = (d: DashDoc): TableSheet => d.sheets[0] as TableSheet

const CHART: DashTile = {
  id: 'chart-region', kind: 'chart', x: 0, y: 0, w: 6, h: 3, chart: 'bar',
  title: 'Value by region',
  bind: { sheet: 'sales', x: 'region', series: ['value'], agg: 'sum' },
}
const KPI: DashTile = {
  id: 'kpi-value', kind: 'kpi', x: 6, y: 0, w: 3, h: 1,
  bind: { sheet: 'sales', col: 'value', agg: 'sum' },
}
const TABLE: DashTile = {
  id: 'table-rows', kind: 'table', x: 0, y: 3, w: 12, h: 3,
  bind: { sheet: 'sales', by: 'region' },
}

const pick = (from: string, col: string, v: string | null): SelectionEntry =>
  ({ from, sheet: 'sales', col, v })

/** The composition under test: filters → rows → derived tile. */
type FilterFn = (sel: CrossSelection, tile: DashTile) => ColumnFilter[]

function rowsOf(doc: DashDoc, tile: DashTile, sel: CrossSelection, filters: FilterFn): number[] {
  const sheet = sheetOf(doc)
  return rowList(sheet, rowsForTile(sheet, sheetGet(sheet), filters(sel, tile)))
}

function tileOf(
  doc: DashDoc, tile: DashTile, sel: CrossSelection, filters: FilterFn,
): TileData {
  const sheet = sheetOf(doc)
  return deriveTile(doc, tile, rowsForTile(sheet, sheetGet(sheet), filters(sel, tile)))
}

const asChart = (td: TileData): Extract<TileData, { kind: 'chart' }> => {
  if (td.kind !== 'chart') throw new CheckFailed(`expected a chart, got ${td.kind}`)
  return td
}
const asKpi = (td: TileData): Extract<TileData, { kind: 'kpi' }> => {
  if (td.kind !== 'kpi') throw new CheckFailed(`expected a kpi, got ${td.kind}`)
  return td
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// ==================================================== the selection algebra

console.log('\nthe selection is an algebra, and it composes')
{
  const a = pick('t1', 'region', 'North')
  const sel0: CrossSelection = []
  const sel1 = toggleSelection(sel0, a)
  const sel2 = toggleSelection(sel1, { ...a })
  ok(sel1.length === 1 && sel2.length === 0,
    'clicking a category selects it and clicking it again lets go — the toggle is the whole interaction')
  ok(sel0.length === 0 && sel1.length === 1,
    'toggle is PURE: the array handed in is untouched, so the value assigned inside store.view() is a new one')

  const two = toggleSelection(toggleSelection([], a), pick('t2', 'region', 'North'))
  ok(two.length === 2,
    'the same category picked on two tiles is two entries — a selection remembers WHERE it came from, or a tile cannot skip its own')

  const composed = toggleSelection(toggleSelection([], pick('t1', 'region', 'North')), pick('t2', 'stage', 'Won'))
  const f = selectionFilters(composed, KPI)
  ok(f.length === 2 && f.map((x) => x.col).join() === 'region,stage',
    'two columns become two filters — buildOrder ANDs them, which is what region=North AND stage=Won means')

  const ored = toggleSelection(toggleSelection([], pick('t1', 'region', 'North')), pick('t2', 'region', 'South'))
  const fo = selectionFilters(ored, KPI)
  const set = fo[0].pred.op === 'isOneOf' ? [...fo[0].pred.set] : []
  ok(fo.length === 1 && set.length === 2,
    'two categories of ONE column become one isOneOf of two values — inside a column values OR, or clicking a second bar would mean "no rows"')
}

console.log('\na tile never filters itself, and never reaches across sheets')
{
  const sel = [pick(CHART.id, 'region', 'North')]
  ok(selectionFilters(sel, CHART).length === 0,
    "a tile's own entries are not in its own filters")
  ok(selectionFilters(sel, KPI).length === 1,
    'the same entry does filter every OTHER tile — that is the feature')

  const foreign = [{ from: 't9', sheet: 'other-sheet', col: 'region', v: 'North' }]
  ok(selectionFilters(foreign, KPI).length === 0,
    'a selection on another sheet does not reach this one — two sheets sharing a column NAME are not related, and a join is')
}

// ============================================== re-derivation under selection

console.log('\ntiles re-derive against the selection')
{
  const doc = fresh()
  const base = asChart(tileOf(doc, CHART, [], selectionFilters))
  ok(same(base.cats, ['North', 'South', null, 'East']),
    'unfiltered, the region chart has four categories INCLUDING the blank one')
  ok(same(base.series[0].data, [350, 300, 400, null]),
    'and the sums are the hand-computed ones — East has no values at all, which is a GAP (null), never a zero')

  const won = [pick('other', 'stage', 'Won')]
  const filtered = asChart(tileOf(doc, CHART, won, selectionFilters))
  ok(same(filtered.cats, ['North', 'South', null]) && same(filtered.series[0].data, [150, 300, 400]),
    'selecting stage=Won on another tile re-derives this one: 150/300/400, and East disappears because it has no Won rows')

  const kpi = asKpi(tileOf(doc, KPI, won, selectionFilters))
  ok(kpi.value === 850 && kpi.rows === 4,
    'the KPI beside it re-derives to the same population — 850 over 4 rows')

  const self = asChart(tileOf(doc, CHART, [pick(CHART.id, 'region', 'North')], selectionFilters))
  ok(same(self.cats, base.cats) && same(self.series[0].data, base.series[0].data),
    'the SOURCE tile is unchanged by its own click — every other bar is still there to click')
}

console.log('\nnothing is cached: a tile re-derives from the document it is given')
{
  const doc = fresh()
  const store = new Store(doc)
  const before = asChart(deriveTile(store.doc, CHART, null))
  store.commit({ op: 'setCells', sheet: 'sales', col: 'value', rids: [1], v: [999] })
  const after = asChart(deriveTile(store.doc, CHART, null))
  ok(before.series[0].data[0] === 350 && after.series[0].data[0] === 1249,
    'editing a cell moves the tile on the next derive — 350 becomes 1249, with no invalidation call anywhere')
}

// ================================================== the blank rule (§3)

console.log('\nnull is a category, not an exemption')
{
  const doc = fresh()
  const cats: Array<string | null> = ['North', 'South', null, 'East']
  const got = cats.map((c) => rowsOf(doc, KPI, [pick('t', 'region', c)], selectionFilters))
  ok(same(got[0], [0, 1, 6]), 'selecting North selects the North rows — and NOT the blank-region row')
  ok(same(got[2], [4]), 'selecting the blank category selects exactly the blank-region row')
  const union = got.flat().sort((a, b) => a - b)
  ok(same(union, [0, 1, 2, 3, 4, 5, 6]),
    'the four categories PARTITION the sheet: every row is in exactly one, so no row is silently dropped and none is counted twice')

  const b = parseDoc(JSON.stringify({
    ...FIXTURE,
    sheets: [{
      ...FIXTURE.sheets[0], id: 'sales', rids: [[1, 4]],
      data: {
        region: { enc: 'raw', v: ['', '   ', null, 'North'] },
        stage: { enc: 'raw', v: ['a', 'b', 'c', 'd'] },
        value: { enc: 'raw', v: [1, 2, 4, 8] },
        target: { enc: 'raw', v: [1, 1, 1, 1] },
        zero: { enc: 'raw', v: [0, 0, 0, 0] },
      },
    }],
  }))
  if (!b.ok) throw new Error('blank fixture does not parse')
  const bc = asChart(deriveTile(b.doc, CHART, null))
  ok(same(bc.cats, [null, 'North']) && same(bc.series[0].data, [7, 8]),
    '"", "   " and null are ONE blank category, not three bars all labelled (blank) — the categories are the classes the filter can express')
  const sheetB = b.doc.sheets[0] as TableSheet
  const rowsB = rowList(sheetB, rowsForTile(sheetB, sheetGet(sheetB), selectionFilters([pick('t', 'region', null)], KPI)))
  ok(same(rowsB, [0, 1, 2]),
    'and clicking that one bar selects all three spellings of blank — the bar and the filter agree by construction')
}

// ================================================== the empty case

console.log('\nan empty result says so; it never draws a zero')
{
  const doc = fresh()
  const impossible = [pick('a', 'region', 'East'), pick('b', 'stage', 'Won')]
  const c = tileOf(doc, CHART, impossible, selectionFilters)
  ok(c.kind === 'empty' && c.reason === 'no-rows',
    'a chart with no surviving rows is an EMPTY tile, not an axis with no bars — an empty bar chart reads as zero')
  const k = tileOf(doc, KPI, impossible, selectionFilters)
  ok(k.kind === 'empty' && k.reason === 'no-rows',
    'and so is the KPI — £0 for "we could not compute this" is the most expensive wrong number a dashboard prints')

  const textKpi = deriveTile(doc, { ...KPI, bind: { sheet: 'sales', col: 'stage', agg: 'sum' } }, null)
  ok(textKpi.kind === 'kpi' && textKpi.value === null,
    'summing a text column answers null, not 0 — filter.ts summarize refuses to invent a number and this passes that through')

  const unknown = deriveTile(doc, { ...CHART, id: 'x', kind: 'sunburst' }, null)
  ok(unknown.kind === 'empty' && unknown.reason === 'unknown-kind',
    'a tile kind this build cannot draw says so — an empty box reads as "no data", which is a different and wrong statement')

  const noSheet = deriveTile(doc, { ...KPI, id: 'y', bind: { sheet: 'gone', col: 'value' } }, null)
  ok(noSheet.kind === 'empty' && noSheet.reason === 'no-sheet',
    'a tile pointing at a sheet that is not here says THAT, rather than rendering a blank')
}

// ================================================== aggregation

console.log('\naggregates divide by the values present')
{
  const doc = fresh()
  const avg = asKpi(deriveTile(doc, { ...KPI, id: 'avg', bind: { sheet: 'sales', col: 'value', agg: 'avg' } }, null))
  ok(avg.value === 210,
    'the average of 100/200/300/400/50 over seven rows is 210 — divided by the five values PRESENT, not by the rows')
  const count = asKpi(deriveTile(doc, { ...KPI, id: 'n', bind: { sheet: 'sales', col: 'value', agg: 'count' } }, null))
  ok(count.value === 5,
    'count counts values present, the same definition the status bar uses — a KPI that counted blanks would disagree with the footer')

  const zero = asKpi(deriveTile(doc, { ...KPI, id: 'z', compare: { of: 'column', col: 'zero' } }, null))
  ok(zero.baseline === 0 && zero.pct === null && zero.share === null && zero.delta === 1050,
    'a percentage against a zero baseline is null, not Infinity — the delta is still real and is still shown')

  const won = [pick('other', 'stage', 'Won')]
  const share = asKpi(tileOf(doc, { ...KPI, id: 's', compare: { of: 'all' } }, won, selectionFilters))
  ok(share.value === 850 && share.baseline === 1050,
    'compare:"all" deliberately ignores the selection — that comparison is "how much of everything is this?"')
  const plain = asKpi(deriveTile(doc, KPI, null))
  ok(share.compare === 'all' && zero.compare === 'column' && plain.compare === null,
    'a KPI states WHICH comparison it made as a model word — the renderer branches on that and never on a translated label, which would take the wrong arm outside English')
}

// ================================================== the picking round trip

console.log('\nwhat a click means is the same everywhere')
{
  const doc = fresh()
  const sheet = sheetOf(doc)
  const get = sheetGet(sheet)
  const chart = asChart(deriveTile(doc, CHART, null))
  // A ROW click and a BAR click have to produce the same entry, or a table and
  // the chart above it toggle each other's selections instead of cancelling.
  const rowCat = catOf(get('region', 4))
  ok(rowCat === null && chart.cats[2] === null,
    'the blank row and the blank bar canonicalise to the same category, so a row click and a bar click cancel each other')
  const numeric = catOf(10)
  ok(numeric === '10',
    'a numeric category canonicalises to its digits — filter.ts isOneOf matches "10" back to the cell holding 10')

  const on = pickedOn([pick(CHART.id, 'region', 'North'), pick('other', 'region', 'South')], CHART, 'region')
  ok(on.size === 1 && on.has('North'),
    'a tile highlights only what was picked ON it — the highlight is the source, the filter is everyone else')

  const chips = selectionChips([pick('t', 'region', null)], doc)
  ok(chips[0].label === 'Region: (blank)',
    'the selection is legible: the chip names the column and the category, blank included')
}

// ================================================== view state, not document

console.log('\nthe selection goes through store.view(): no checkpoint, no dirty flag, no op')
{
  const doc = fresh()
  const store = new Store(doc)
  const seen: string[] = []
  store.on('doc', () => seen.push('doc'))
  store.on('view', () => seen.push('view'))

  // A minimal host: the class only ever touches classList/style/innerHTML plus
  // the listeners, so a plain object is enough to run the real code path in
  // node — which is the point, since a hand-rolled imitation of `pick` would
  // prove nothing about `pick`.
  const el = {
    classList: { add(): void {} },
    style: { setProperty(): void {} },
    addEventListener(): void {},
    removeEventListener(): void {},
    innerHTML: '',
  } as unknown as HTMLElement

  const dash = new Dashboard({ el, store })
  const before = JSON.stringify(store.doc)
  dash.pick(pick('kpi-total', 'region', 'North'))

  ok(JSON.stringify(store.doc) === before,
    'a click changes NOTHING in the document — not a field, not `modified`')
  ok(store.canUndo === false,
    'and takes no undo checkpoint: exploring a dashboard must not fill the undo stack a reader would then have to walk back')
  ok(seen.includes('view') && !seen.includes('doc'),
    'it emits `view` and never `doc` — the invalidation tier that does not dirty the file or mint a collab op')
  ok(dash.selection.length === 1, 'and the selection landed')

  dash.pick(pick('kpi-total', 'region', 'North'))
  ok(dash.selection.length === 0, 'clicking the same category again clears it')

  dash.pick(pick('kpi-total', 'region', 'East'))
  dash.pick(pick('kpi-total', 'stage', 'Won'))
  const html = String((el as unknown as { innerHTML: string }).innerHTML)
  ok(html.includes('No rows match the current selection'),
    'and a selection that empties a tile paints the sentence, not an axis — the empty state reaches the DOM, not just the derivation')
  ok(html.includes('Filtered by') && html.includes('Region: East'),
    'the chips say what the dashboard is filtered by, so a number is never quoted for a slice nobody can see')
}

// ================================================== the layout is document data

console.log('\nthe layout travels in the file, additively')
{
  const view: DashView = {
    id: 'v1', name: 'Overview', w: 12, h: 6,
    tiles: [
      { ...CHART },
      { id: 'future', kind: 'sunburst', x: 6, y: 0, w: 6, h: 3, depth: 4 } as DashTile,
    ],
    legend: 'right',
  }
  const json = JSON.stringify({ ...FIXTURE, views: [view] })
  const r = parseDoc(json)
  ok(r.ok, 'a workbook carrying a dashboard parses')
  if (r.ok) {
    ok(JSON.stringify(r.doc) === json,
      'and round-trips BYTE-identical: an unknown tile kind, an unknown tile field and an unknown view field all survive (PLATFORM §3)')
    const back = viewsOf(r.doc)
    ok(back.length === 1 && back[0].tiles.length === 2 && back[0].tiles[1].depth === 4,
      'the reader sees them too — additivity is not just "the bytes survived", it is "nothing dropped them on the way in"')
  }

  const doc = fresh()
  const one = withView(doc, view)
  const two = withView(one, { ...view, name: 'Renamed' })
  ok(viewsOf(doc).length === 0 && viewsOf(one).length === 1 && viewsOf(two).length === 1,
    'withView is pure and replaces by id — a second dashboard with the same id is an edit, not a duplicate')
  ok(viewsOf(two)[0].name === 'Renamed', 'and the edit landed')
}

console.log('\na workbook with no dashboard gets a sensible one, and it is ephemeral')
{
  const doc = starterDoc()
  const v = defaultDashboard(doc)
  ok(!!v && v.tiles.length >= 4, 'the starter workbook mints a dashboard with KPIs, a chart and a table')
  if (v) {
    const ids = new Set(v.tiles.map((tile) => tile.id))
    ok(ids.size === v.tiles.length, 'tile ids are unique — the selection is keyed by them')
    ok(v.tiles.every((tile) => tile.x >= 0 && tile.x + tile.w <= (v.w || DEFAULT_COLS)),
      'and every tile fits inside the declared column count')
    ok(v.tiles.every((tile) => !tile.bind || doc.sheets.some((s) => s.id === tile.bind!.sheet)),
      'every tile names a sheet that exists')
    const kpi = deriveTile(doc, v.tiles[0], null)
    ok(kpi.kind === 'kpi' && kpi.value === 97050,
      'and it derives: the starter pipeline totals £97,050')
  }
  ok(viewsOf(doc).length === 0,
    'minting it did NOT write it into the document — a dashboard nobody arranged must not dirty a file just for being looked at')
}

console.log('\nodds and ends')
{
  const doc = fresh()
  const sheet = sheetOf(doc)
  ok(rowsForTile(sheet, sheetGet(sheet), []) === null,
    'no filters is the null fast path — the identity vector is not allocated per tile per paint')
  const slow = rowsForTile(sheet, sheetGet(sheet), [{ col: 'region', pred: { op: 'notBlank' } }])
  ok(same(rowList(sheet, null), [0, 1, 2, 3, 4, 5, 6]) && same(slow, [0, 1, 2, 3, 5, 6]),
    'and the fast path agrees with the slow one on the population it stands for')

  const table = deriveTile(doc, TABLE, [1, 2])
  ok(table.kind === 'table' && table.rows.length === 2 && table.total === 7,
    'a table tile reports BOTH numbers — 2 of 7 — because "2 rows" under a filter is how a subtotal gets quoted as a total')

  ok(same(niceTicks(0, 350), [0, 100, 200, 300, 400]), 'axis ticks are the ones a person would have chosen')
  ok(same(niceTicks(5, 5), [5]), 'and a flat series does not divide by a zero range')

  const overridden = fresh()
  const s = sheetOf(overridden)
  s.cells = { 'value:1': { v: 1000, why: 'corrected' } }
  const k = asKpi(deriveTile(overridden, KPI, null))
  ok(k.value === 1950,
    'a hand correction in sheet.cells is what the tile totals — the grid paints the override, so a tile that read past it would contradict the cell three inches away')
  const c = asChart(deriveTile(overridden, CHART, null))
  ok(c.series[0].data[0] === 1250,
    'and the CHART sees it too, because every bound column reaches optionFor through the same accessor')
}

// ==================================================== NEGATIVE CONTROLS
//
// Each mutation below is a plausible implementation of this feature, not a
// strawman: they are the six failures in the header, plus the two boundary
// bugs the fast path and the round trip invite. Every one is fed through the
// REAL derivation wherever a dependency can carry the fault, so what is being
// tested is the check, on the code path it guards.

console.log('\nnegative controls: each break must trip a check')

/** The check that the source tile keeps its other categories. */
function checkSelfExemption(filters: FilterFn): void {
  const doc = fresh()
  const td = asChart(tileOf(doc, CHART, [pick(CHART.id, 'region', 'North')], filters))
  must(td.cats.length === 4, `source tile lost its categories: ${JSON.stringify(td.cats)}`)
  must(td.series[0].data[0] === 350, 'source tile re-derived against its own click')
}

/** The check that two clicks on two tiles AND together. */
function checkCompose(filters: FilterFn): void {
  const doc = fresh()
  const sel = [pick('a', 'region', 'North'), pick('b', 'stage', 'Won')]
  const rows = rowsOf(doc, KPI, sel, filters)
  must(same(rows, [0, 6]), `region=North AND stage=Won is rows 0,6; got ${JSON.stringify(rows)}`)
}

/** The check that the categories of a column partition the sheet. */
function checkPartition(cat: (v: unknown) => string | null, filters: FilterFn): void {
  const doc = fresh()
  const sheet = sheetOf(doc)
  const get = sheetGet(sheet)
  const cats = [...new Set([0, 1, 2, 3, 4, 5, 6].map((i) => cat(get('region', i))))]
  const sets = cats.map((c) => rowsOf(doc, KPI, [pick('t', 'region', c)], filters))
  const union = sets.flat().sort((a, b) => a - b)
  // Disjointness first, so an over-covering break reports itself as one rather
  // than as a coverage failure with a confusing list.
  must(union.length === new Set(union).size,
    `a row is in two categories at once: ${JSON.stringify(union)}`)
  must(same(union, [0, 1, 2, 3, 4, 5, 6]),
    `the categories do not cover the sheet: ${JSON.stringify(union)}`)
}

/** The check that an emptied tile is empty rather than zero. */
function checkEmpty(td: TileData): void {
  must(td.kind === 'empty', `an emptied tile derived as ${td.kind} — an axis with no bars reads as zero`)
}

/** The check that an average divides by the values present. */
function checkAvg(v: number | null): void {
  must(v === 210, `average is ${v}: divided by rows, not by the values present`)
}

/** The check that a tile re-derives after an edit. */
function checkNoCache(derive: (doc: DashDoc, tile: DashTile) => TileData): void {
  const store = new Store(fresh())
  const a = asChart(derive(store.doc, CHART))
  store.commit({ op: 'setCells', sheet: 'sales', col: 'value', rids: [1], v: [999] })
  const b = asChart(derive(store.doc, CHART))
  must(a.series[0].data[0] !== b.series[0].data[0], 'the tile did not move when the data did')
}

/**
 * The check that a stored dashboard round-trips byte-identical.
 *
 * Parameterised by the PARSER, not by the json: mutating the input would only
 * prove that a smaller document is still itself. The fault has to sit in the
 * thing that reads the file, which is where it would really sit.
 */
type Parse = (json: string) => DashDoc

const ROUNDTRIP_JSON = JSON.stringify({
  ...FIXTURE,
  views: [{ id: 'v', name: 'n', w: 12, h: 2, legend: 'right', tiles: [{ ...CHART, depth: 4 }] }],
})

function checkRoundTrip(parse: Parse): void {
  const doc = parse(ROUNDTRIP_JSON)
  must(JSON.stringify(doc) === ROUNDTRIP_JSON, 'a dashboard field was dropped on the way in')
}

const realParse: Parse = (json) => {
  const r = parseDoc(json)
  if (!r.ok) throw new CheckFailed('the workbook did not parse')
  return r.doc
}

// --- the mutants -----------------------------------------------------------

/** M1: the exemption is forgotten — the naive "apply every entry" filter. */
const noExemption: FilterFn = (sel, tile) =>
  selectionFilters(sel.map((e) => ({ ...e, from: '' })), tile)

/** M2: `byCol` is ASSIGNED rather than merged — the last click wins. */
const lastWins: FilterFn = (sel, tile) => {
  const byCol = new Map<string, Set<unknown>>()
  for (const e of sel) {
    if (e.from === tile.id || e.sheet !== tile.bind?.sheet) continue
    byCol.set(e.col, new Set([e.v]))
  }
  const all = [...byCol]
  return all.length ? [{ col: all[all.length - 1][0], pred: { op: 'isOneOf', set: all[all.length - 1][1] } }] : []
}

/** M3: the naive stringify — `null` becomes the string "null", which is a
 *  category no row is in, so the blank rows fall out of the dashboard. */
const naiveCat = (v: unknown): string | null => String(v)

/** M4: blanks match every selection — "an unknown region is everywhere". */
const blanksMatchAll: FilterFn = (sel, tile) => {
  const f = selectionFilters(sel, tile)
  return f.map((x) => (x.pred.op === 'isOneOf'
    ? { col: x.col, pred: { op: 'isOneOf', set: new Set([...x.pred.set, null]) } as ColumnFilter['pred'] }
    : x))
}

/** M5: the fast path leaks — one selected value is treated as "no filter". */
const leakyFastPath: FilterFn = (sel, tile) => {
  const f = selectionFilters(sel, tile)
  return f.filter((x) => !(x.pred.op === 'isOneOf' && x.pred.set.size === 1))
}

/** M6: the memo, keyed by tile id, that a profiler talks you into. */
const memo = new Map<string, TileData>()
const cachedDerive = (doc: DashDoc, tile: DashTile): TileData => {
  const hit = memo.get(tile.id)
  if (hit) return hit
  const td = deriveTile(doc, tile, null)
  memo.set(tile.id, td)
  return td
}

mutated('a tile that applies its own click', () => checkSelfExemption(noExemption))
mutated('a byCol map assigned instead of merged (last click wins)', () => checkCompose(lastWins))
mutated('String(v) categories, so blanks belong to no category', () => checkPartition(naiveCat, selectionFilters))
mutated('blanks added to every selection, so a row is in two categories', () => checkPartition(catOf, blanksMatchAll))
mutated('a single-value filter dropped as if it were no filter', () => checkCompose(leakyFastPath))
mutated('an emptied chart falling through to the renderer', () => checkEmpty({
  kind: 'chart', chart: 'bar', cats: [], series: [{ name: 'Value', data: [] }], colors: [], rows: 0,
}))
mutated('an emptied KPI rendered as 0', () => checkEmpty({
  kind: 'kpi', value: 0, agg: 'sum', rows: 0, baseline: null, delta: null, pct: null, share: null,
}))
mutated('an average divided by rows rather than by values present', () => checkAvg(1050 / 7))
mutated('a series memoised by tile id', () => checkNoCache(cachedDerive))
/** M7: the parser that "tidies" a tile down to the keys this build knows —
 *  which is precisely how a file written by a newer dash loses half of itself
 *  the first time an older one saves it (PLATFORM §3). */
const tidyingParse: Parse = (json) => {
  const doc = realParse(json)
  const views = viewsOf(doc).map((v) => ({
    id: v.id, name: v.name, w: v.w, h: v.h,
    tiles: v.tiles.map((tl) => ({ id: tl.id, kind: tl.kind, x: tl.x, y: tl.y, w: tl.w, h: tl.h, bind: tl.bind })),
  }))
  return { ...doc, views: views as never }
}

mutated('a parser that tidies unknown tile and view fields away', () => checkRoundTrip(tidyingParse))

console.log('\nand the real implementation passes every one of them')
{
  const run = (name: string, fn: () => void): void => {
    try { fn(); ok(true, name) } catch (e) { ok(false, `${name} — ${(e as Error).message}`) }
  }
  run('self-exemption', () => checkSelfExemption(selectionFilters))
  run('composition', () => checkCompose(selectionFilters))
  run('partition', () => checkPartition(catOf, selectionFilters))
  run('empty', () => checkEmpty(tileOf(fresh(), CHART, [pick('a', 'region', 'East'), pick('b', 'stage', 'Won')], selectionFilters)))
  run('average', () => checkAvg(asKpi(deriveTile(fresh(), { ...KPI, bind: { sheet: 'sales', col: 'value', agg: 'avg' } }, null)).value))
  run('no cache', () => checkNoCache((doc, tile) => deriveTile(doc, tile, null)))
  run('round trip', () => checkRoundTrip(realParse))
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
