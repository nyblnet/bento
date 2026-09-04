#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash document-validation rig.
//
//   node scripts/test-dash-validate.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES, and why it takes two directions to prove anything at all.
// A validator that reports nothing on a corrupt document and a validator that
// reports everything on a healthy one are equally useless, and only checking
// BOTH tells them apart. So:
//
//   · one HEALTHY workbook — table, canvas and pivot sheets, a formula column,
//     a per-cell formula, an override, totals, conditional formatting, a
//     measure, a dashboard tile and a story step — must produce EXACTLY ZERO
//     findings. Every check added later has to keep passing this, which is the
//     only defence against a validator that nags;
//   · then ONE corruption at a time, from a fresh copy of that workbook, each
//     asserted by CODE and by LOCATION. "Something was reported" is not the
//     claim — "row 4 of column amount" is.
//
// Two of the checks below exist to prove a NON-check, and they are the ones
// worth reading. `rids` runs are NOT globally ascending in a healthy file (an
// insert at the top of a sheet produces `[[4,1],[1,3]]`), and a sheet kind or
// column encoding this build has never heard of is ADDITIVE (PLATFORM §3), not
// damage. A validator that flagged either would be teaching authors to break
// their own files.
//
// NEGATIVE CONTROLS: the last section re-implements four checks the plausible-
// but-wrong way and requires each mutant to be CAUGHT — plus, out of band, each
// real check was broken in `validate.ts` and this rig was re-run to confirm its
// own assertion fails (recorded in the PR notes, not here).

import { validateDoc, type Finding, type Severity } from '../dash/src/validate.ts'
import type { DashDoc } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string): void {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const section = (s: string): void => { console.log(`\n${s}`) }

// --- the healthy workbook ----------------------------------------------------
//
// Deliberately exercises every surface the validator reaches. A fixture with one
// bare table sheet would let half the checks pass by never running.

const workbook = (): Record<string, unknown> => ({
  format: 'bento/dash',
  version: 1,
  policy: 'bento-dash-1',
  docId: 'doc-1',
  title: 'Q3',
  sheets: [
    {
      id: 'sales',
      name: 'Sales',
      kind: 'table',
      rids: [[1, 4]],
      nextRid: 5,
      columns: [
        { id: 'region', name: 'Region', type: 'text' },
        { id: 'amount', name: 'Amount', type: 'number' },
        // a formula column: no stored data, by design
        { id: 'margin', name: 'Margin', type: 'number', formula: 'amount * 0.3' },
      ],
      data: {
        region: { enc: 'dict', dict: ['North', 'South'], idx: [0, 1, 0, 1] },
        amount: { enc: 'raw', v: [10, 20, 30, 40] },
      },
      cells: { 'amount:2': { v: 21, why: 'agreed with finance', f: '=B2*1.05' } },
      totals: { amount: 'sum' },
      condfmt: { amount: [{ kind: 'cellValue', op: '>', value: 25, style: { bold: true } }] },
      steps: [{ op: 'import', from: 'q3.csv', at: '2026-08-03T00:00:00Z', rows: 4 }],
    },
    { id: 'notes', name: 'Notes', kind: 'canvas', cells: { A1: { v: 'hello' }, B2: { f: '=SUM(A1:A3)' } } },
    {
      id: 'pv', name: 'Pivot', kind: 'pivot',
      pivot: { from: 'sales', rows: ['region'], cols: [], values: [{ col: 'amount', fn: 'sum' }] },
    },
  ],
  measures: { rev: { name: 'Revenue', expr: 'SUM(amount)', grain: 'sales', additive: true } },
  views: [{
    id: 'v1', name: 'Dash', w: 12, h: 8,
    tiles: [{ id: 't1', kind: 'chart', x: 0, y: 0, w: 6, h: 4, chart: 'bar', bind: { sheet: 'sales', x: 'region', series: ['amount'] } }],
  }],
  story: {
    steps: [{
      id: 's1', sheet: 'sales',
      chart: { x: 'region', series: ['amount'], kind: 'bar' },
      filters: [{ col: 'region', pred: { op: 'contains', v: 'th' } }],
      sorts: [{ col: 'amount', dir: 'desc' }],
    }],
  },
})

type Doc = Record<string, any>
const sheetOf = (d: Doc, id: string): Doc => d.sheets.find((s: Doc) => s.id === id)

/** Corrupt a fresh copy and report what the validator saw. */
function run(mutate: (d: Doc) => void): Finding[] {
  const d = JSON.parse(JSON.stringify(workbook())) as Doc
  mutate(d)
  return validateDoc(d as unknown as DashDoc).findings
}

interface Where { sheet?: string; column?: string; rid?: number; path?: string; severity?: Severity }

const matches = (f: Finding, code: string, w: Where): boolean =>
  f.code === code
  && (w.sheet === undefined || f.sheet === w.sheet)
  && (w.column === undefined || f.column === w.column)
  && (w.rid === undefined || f.rid === w.rid)
  && (w.path === undefined || f.path === w.path)
  && (w.severity === undefined || f.severity === w.severity)

/**
 * One corruption, caught by code AND by location.
 *
 * `says` is checked against the message because a finding whose sentence does
 * not name the offending value is a finding somebody still has to debug.
 */
function caught(
  name: string, mutate: (d: Doc) => void, code: string, w: Where = {}, says?: string,
): Finding[] {
  const fs = run(mutate)
  const hit = fs.filter((f) => matches(f, code, w))
  ok(hit.length > 0, `${name} → ${code}${w.sheet ? ` @${w.sheet}` : ''}${w.column ? `.${w.column}` : ''}${w.path ? ` ${w.path}` : ''}`)
  if (hit.length && says) {
    ok(hit.some((f) => f.message.includes(says)),
      `  …and the message names ${JSON.stringify(says)}`)
  }
  if (!hit.length) console.log(`        saw: ${fs.map((f) => f.code).join(', ') || '(nothing)'}`)
  return fs
}

// ============================================================ THE HEALTHY CASE

section('a healthy workbook is silent')
{
  const r = validateDoc(workbook() as unknown as DashDoc)
  ok(r.findings.length === 0,
    `a workbook that is right about itself produces NO findings (saw ${r.findings.length}: ${r.findings.map((f) => `${f.code}:${f.message.slice(0, 60)}`).join(' | ')})`)
  ok(r.ok === true, 'and reports ok')
  ok(r.counts.fatal === 0 && r.counts.repairable === 0 && r.counts.suspicious === 0,
    'with every counter at zero')
}

// A NON-CHECK, and the one the columnar brief most invites getting wrong.
// Rows are positional and rids are minted monotonically, so inserting a row at
// the TOP of a sheet leaves `[[4,1],[1,3]]`. Checking "runs ascend" would flag
// an ordinary file the moment anyone inserted a row anywhere but the end.
{
  const fs = run((d) => {
    const s = sheetOf(d, 'sales')
    s.rids = [[5, 1], [1, 3]]
    s.nextRid = 6
    s.data.region.idx = [0, 1, 0, 1]
    s.data.amount.v = [50, 10, 20, 30]
  })
  ok(fs.length === 0,
    `descending run order is HEALTHY (an insert at the top), not a finding (saw ${fs.map((f) => f.code).join(', ') || 'nothing'})`)
}

// PLATFORM §3. A sheet kind from a later build round-trips whole; reporting it
// as damage would teach authors to delete what this build is too old to read.
{
  const fs = run((d) => { d.sheets.push({ id: 'fut', name: 'F', kind: 'from-the-future', mystery: { a: 1 } }) })
  ok(fs.length === 0, 'a sheet kind this build has never heard of is additive, not a finding')
}

// ================================================== THE COLUMNAR CORRUPTIONS

section('the columnar corruptions — silent, and the reason this file exists')

caught('a column one entry SHORT', (d) => { sheetOf(d, 'sales').data.amount.v = [10, 20, 30] },
  'column-length', { sheet: 'sales', column: 'amount', severity: 'fatal' }, '3 value(s) but the sheet has 4')
caught('a column one entry LONG', (d) => { sheetOf(d, 'sales').data.amount.v.push(50) },
  'column-length', { sheet: 'sales', column: 'amount', severity: 'fatal' }, '5 value(s)')
caught('a dictionary column short', (d) => { sheetOf(d, 'sales').data.region.idx = [0, 1, 0] },
  'column-length', { sheet: 'sales', column: 'region', severity: 'fatal' })
caught('no data entry at all', (d) => { delete sheetOf(d, 'sales').data.region },
  'missing-column-data', { sheet: 'sales', column: 'region', severity: 'fatal' })
caught('data under a key no column claims', (d) => { sheetOf(d, 'sales').data.ghost = { enc: 'raw', v: [1, 2, 3, 4] } },
  'orphan-column-data', { sheet: 'sales', column: 'ghost', severity: 'suspicious' })
caught('a dictionary index past the end of its dict',
  (d) => { sheetOf(d, 'sales').data.region.idx = [0, 1, 5, null] },
  'dict-index', { sheet: 'sales', column: 'region', severity: 'fatal' }, 'row(s) 2')
caught('a negative dictionary index',
  (d) => { sheetOf(d, 'sales').data.region.idx = [0, -1, 0, 1] },
  'dict-index', { sheet: 'sales', column: 'region', severity: 'fatal' })
caught('a dictionary column with no dict',
  (d) => { delete sheetOf(d, 'sales').data.region.dict },
  'bad-column-data', { sheet: 'sales', column: 'region', severity: 'fatal' })
caught('a formula column that ALSO stores values',
  (d) => { sheetOf(d, 'sales').data.margin = { enc: 'raw', v: [1, 2, 3, 4] } },
  'formula-column-data', { sheet: 'sales', column: 'margin', severity: 'suspicious' })

// Additive, not damage: a column encoding a later build introduced.
{
  const fs = run((d) => { sheetOf(d, 'sales').data.amount = { enc: 'zstd', b64: 'xxx', n: 4 } })
  ok(fs.some((f) => f.code === 'unknown-encoding' && f.severity === 'suspicious'),
    'an unknown column ENCODING is reported as unreadable-here, not as corrupt')
  ok(!fs.some((f) => f.severity === 'fatal'),
    'and it is not fatal — the column round-trips untouched (PLATFORM §3)')
  ok(!fs.some((f) => f.code === 'column-length'),
    'and its length is not guessed at')
}

// ============================================================== ROW IDENTITY

section('row identity: runs, overlaps, and the watermark')

caught('a run with a zero count', (d) => { sheetOf(d, 'sales').rids = [[1, 0]] },
  'rid-run-shape', { sheet: 'sales', severity: 'fatal' })
caught('a run that is not a pair', (d) => { sheetOf(d, 'sales').rids = [[1]] },
  'rid-run-shape', { sheet: 'sales', severity: 'fatal' })
caught('a fractional rid', (d) => { sheetOf(d, 'sales').rids = [[1.5, 4]] },
  'rid-run-shape', { sheet: 'sales', severity: 'fatal' })
caught('no rids array at all', (d) => { delete sheetOf(d, 'sales').rids },
  'rid-run-shape', { sheet: 'sales', path: 'rids', severity: 'fatal' })
caught('two runs that overlap — one rid naming two rows',
  (d) => { const s = sheetOf(d, 'sales'); s.rids = [[1, 3], [3, 2]]; s.data.amount.v = [1, 2, 3, 4, 5]; s.data.region.idx = [0, 0, 0, 0, 0] },
  'duplicate-rid', { sheet: 'sales', severity: 'fatal' }, 'runs starting 1 and 3')
caught('a watermark below a live rid',
  (d) => { sheetOf(d, 'sales').nextRid = 3 },
  'rid-watermark', { sheet: 'sales', path: 'nextRid', severity: 'fatal' }, 'rid 4 is already in use')
caught('a watermark that ignores a rid only an OVERRIDE names',
  (d) => { sheetOf(d, 'sales').cells['amount:9'] = { v: 1 } },
  'rid-watermark', { sheet: 'sales', severity: 'fatal' }, 'rid 9 is already in use')

// ================================================================ OVERRIDES

section('the sparse overlay')

caught('an override key that does not split',
  (d) => { sheetOf(d, 'sales').cells.amountX = { v: 1 } },
  'bad-override-key', { sheet: 'sales', severity: 'suspicious' }, 'amountX')
caught('an override on a column that is gone',
  (d) => { sheetOf(d, 'sales').cells['ghost:1'] = { v: 1 } },
  'orphan-override', { sheet: 'sales', severity: 'suspicious' }, 'ghost:1')
{
  // The watermark raised past it, so ONLY the orphan is reported: a stranded
  // override is harmless exactly while rids are never reused, and the pairing
  // of the two findings is what says whether it can come back.
  const fs = run((d) => { const s = sheetOf(d, 'sales'); s.cells['amount:99'] = { v: 1 }; s.nextRid = 100 })
  ok(fs.some((f) => f.code === 'orphan-override' && f.message.includes('amount:99')),
    'an override on a row that is gone → orphan-override')
  ok(!fs.some((f) => f.code === 'rid-watermark'),
    'and with the watermark above it, no watermark finding — the two are reported independently')
}

// ================================================================= FORMULAS

section('formulas — column expressions and per-cell formulas resolve DIFFERENTLY')

caught('a column formula naming a column that does not exist',
  (d) => { sheetOf(d, 'sales').columns[2].formula = 'amont * 0.3' },
  'unknown-formula-ref', { sheet: 'sales', column: 'margin', severity: 'suspicious' }, '"amont"')
caught('a column formula calling a function this build lacks',
  (d) => { sheetOf(d, 'sales').columns[2].formula = 'XLOOKUPX(amount, region, amount)' },
  'unknown-function', { sheet: 'sales', column: 'margin', severity: 'suspicious' }, 'XLOOKUPX')
caught('an empty formula', (d) => { sheetOf(d, 'sales').columns[2].formula = '   ' },
  'empty-formula', { sheet: 'sales', column: 'margin', severity: 'suspicious' })
caught('two formula columns that depend on each other',
  (d) => {
    const s = sheetOf(d, 'sales')
    s.columns[2].formula = 'other + 1'
    s.columns.push({ id: 'other', name: 'Other', type: 'number', formula: 'margin + 1' })
  },
  'formula-cycle', { sheet: 'sales', severity: 'suspicious' }, 'margin')
caught('a column formula that references itself',
  (d) => { sheetOf(d, 'sales').columns[2].formula = 'margin + 1' },
  'formula-cycle', { sheet: 'sales' }, 'margin')

// A COLUMN formula has no A1 addressing at all (recalc binds column ids and
// names and nothing else), so `Q1` there is a missing COLUMN…
{
  const fs = run((d) => { sheetOf(d, 'sales').columns[2].formula = 'Q1 * 2' })
  ok(fs.some((f) => f.code === 'unknown-formula-ref' && f.message.includes('"Q1"')),
    'in a COLUMN formula, Q1 is a column that does not exist')
  ok(!fs.some((f) => f.code === 'cell-ref-out-of-range'),
    'and never a cell address — a column formula has no A1 addressing')
}
// …while in a CELL formula the same text is the cell in column Q, because
// cellformula.ts binds addresses first. Getting this backwards would either
// miss every broken cell reference or invent one for every working column ref.
{
  const fs = run((d) => { sheetOf(d, 'sales').cells['amount:2'].f = '=Q1*2' })
  ok(fs.some((f) => f.code === 'cell-ref-out-of-range' && f.rid === 2),
    'in a CELL formula, Q1 is an address — and column Q is past a 3-column sheet')
  ok(!fs.some((f) => f.code === 'unknown-formula-ref'),
    'and it is not reported as a missing column')
}
caught('a cell formula pointing off the bottom of the sheet',
  (d) => { sheetOf(d, 'sales').cells['amount:2'].f = '=A99*2' },
  'cell-ref-out-of-range', { sheet: 'sales', column: 'amount', rid: 2, severity: 'suspicious' },
  'row 99')
caught('a cell formula naming a bracketed column that is gone',
  (d) => { sheetOf(d, 'sales').cells['amount:2'].f = '=[nope] * 2' },
  'unknown-formula-ref', { sheet: 'sales', column: 'amount', rid: 2 }, '"nope"')
caught('a cell formula still carrying #REF! from a structural edit',
  (d) => { sheetOf(d, 'sales').cells['amount:2'].f = '=#REF!*2' },
  'broken-ref', { sheet: 'sales', rid: 2, severity: 'suspicious' })
caught('a cell formula calling a function this build lacks',
  (d) => { sheetOf(d, 'sales').cells['amount:2'].f = '=FROBNICATE(B2)' },
  'unknown-function', { sheet: 'sales', rid: 2 }, 'FROBNICATE')
// A string literal is text somebody wrote, not a call.
{
  const fs = run((d) => { sheetOf(d, 'sales').cells['amount:2'].f = '="TOTALS(" & B2' })
  ok(!fs.some((f) => f.code === 'unknown-function'),
    'a function-shaped word inside a STRING is not a call')
}

// ================================================== TOTALS AND FORMATTING

section('totals and conditional formatting')

caught('a total on a column that is gone', (d) => { sheetOf(d, 'sales').totals.ghost = 'sum' },
  'orphan-total', { sheet: 'sales', column: 'ghost', severity: 'suspicious' })
caught('a total function that does not exist', (d) => { sheetOf(d, 'sales').totals.amount = 'stddev' },
  'unknown-total', { sheet: 'sales', column: 'amount', severity: 'suspicious' })
{
  const fs = run((d) => { sheetOf(d, 'sales').totals.amount = { f: 'SUM(amount) / 2' } })
  ok(!fs.length, 'a {f:"…"} total is legal and silent')
}
caught('formatting rules for a column that is gone',
  (d) => { sheetOf(d, 'sales').condfmt.ghost = [{ kind: 'duplicates', style: {} }] },
  'orphan-condfmt', { sheet: 'sales', column: 'ghost', severity: 'suspicious' })
caught('a formatting rule kind this build does not know',
  (d) => { sheetOf(d, 'sales').condfmt.amount = [{ kind: 'rainbow', style: {} }] },
  'unknown-condfmt-rule', { sheet: 'sales', column: 'amount', path: 'condfmt.amount[0]' })
caught('a formula rule naming neither value nor a column',
  (d) => { sheetOf(d, 'sales').condfmt.amount = [{ kind: 'formula', expr: 'value > targt', style: {} }] },
  'unknown-formula-ref', { sheet: 'sales', column: 'amount', path: 'condfmt.amount[0]' }, '"targt"')
{
  const fs = run((d) => { sheetOf(d, 'sales').condfmt.amount = [{ kind: 'formula', expr: 'value > AVERAGE(amount)', style: {} }] })
  ok(!fs.length, 'a formula rule over `value` and a real column is silent')
}

// ====================================================== IDS AND THE ENVELOPE

section('identity, format and the frozen case')

caught('no docId', (d) => { delete d.docId },
  'missing-doc-id', { severity: 'repairable' })
caught('two sheets with one id',
  (d) => { d.sheets.push({ id: 'sales', name: 'Copy', kind: 'table', rids: [], columns: [], data: {}, steps: [] }) },
  'duplicate-sheet-id', { sheet: 'sales', severity: 'repairable' })
caught('two columns with one id',
  (d) => { sheetOf(d, 'sales').columns.push({ id: 'amount', name: 'Amount 2', type: 'number' }) },
  'duplicate-column-id', { sheet: 'sales', column: 'amount', severity: 'repairable' })
caught('not a dash document at all', (d) => { d.format = 'bento/slides' },
  'bad-format', { severity: 'fatal' }, 'bento/slides')
caught('no sheets array', (d) => { delete d.sheets },
  'no-sheets', { severity: 'fatal' })
caught('a version from the future', (d) => { d.version = 99 },
  'future-version', { severity: 'suspicious' })
caught('a version that is not a version', (d) => { d.version = 'two' },
  'bad-version', { severity: 'suspicious' })
caught('a policy this build does not have', (d) => { d.policy = 'martian-1' },
  'unknown-policy', { severity: 'suspicious' })

// THE FROZEN CASE. parseDoc will not rewrite an id in a document whose rules it
// does not have, so the repair that makes a duplicate id survivable does not
// happen — and the same corruption is then fatal rather than repairable.
{
  const fs = run((d) => {
    d.policy = 'martian-1'
    d.sheets.push({ id: 'sales', name: 'Copy', kind: 'table', rids: [], columns: [], data: {}, steps: [] })
  })
  ok(fs.some((f) => f.code === 'duplicate-sheet-id' && f.severity === 'fatal'),
    'in a FROZEN workbook a duplicate id is fatal — the repair is deliberately disabled')
  ok(run((d) => { d.sheets.push({ id: 'sales', name: 'Copy', kind: 'table', rids: [], columns: [], data: {}, steps: [] }) })
    .some((f) => f.code === 'duplicate-sheet-id' && f.severity === 'repairable'),
  'and repairable in an ordinary one — the severity is a fact about parseDoc, not a mood')
}

// ============================================================ THE REFERENCES

section('everything that NAMES a sheet or a column')

caught('a derived sheet whose source is gone', (d) => { sheetOf(d, 'sales').from = 'imported' },
  'orphan-derived-from', { sheet: 'sales', severity: 'suspicious' }, 'imported')

caught('a tile bound to a sheet that is gone',
  (d) => { d.views[0].tiles[0].bind.sheet = 'gone' },
  'tile-missing-sheet', { path: 'views[0].tiles[0]', severity: 'suspicious' })
caught('a tile bound to a sheet that is not a table',
  (d) => { d.views[0].tiles[0].bind.sheet = 'pv' },
  'tile-missing-sheet', { path: 'views[0].tiles[0]' }, 'pivot sheet')
caught('a tile plotting a column that is gone',
  (d) => { d.views[0].tiles[0].bind.series = ['amount', 'profit'] },
  'tile-missing-column', { path: 'views[0].tiles[0].bind.series[1]', column: 'profit', sheet: 'sales' })
caught('a tile showing a measure that is gone',
  (d) => { d.views[0].tiles[0].bind.measure = 'ebitda' },
  'tile-missing-measure', { path: 'views[0].tiles[0]' }, 'ebitda')
caught('a WebGL tile with no fallback',
  (d) => { d.views[0].tiles[0].kind = 'gl' },
  'gl-no-fallback', { path: 'views[0].tiles[0]' })
caught('two dashboards with one id',
  (d) => { d.views.push({ id: 'v1', name: 'Other', w: 4, h: 4, tiles: [] }) },
  'duplicate-view-id', { path: 'views[1]' })

caught('a story step whose sheet is gone', (d) => { d.story.steps[0].sheet = 'gone' },
  'story-missing-sheet', { path: 'story.steps[0]', severity: 'suspicious' })
caught('a story step charting a column that is gone',
  (d) => { d.story.steps[0].chart.series = ['profit'] },
  'story-missing-column', { path: 'story.steps[0].chart.series[0]', column: 'profit' })
caught('a story step filtering on a column that is gone',
  (d) => { d.story.steps[0].filters[0].col = 'gone' },
  'story-missing-column', { path: 'story.steps[0].filters[0].col' })
caught('a story step sorting by a column that is gone',
  (d) => { d.story.steps[0].sorts[0].col = 'gone' },
  'story-missing-column', { path: 'story.steps[0].sorts[0].col' })
caught('a 3D story step binding a column that is gone',
  (d) => { d.story.steps[0].viz = { kind: 'scatter', x: 'amount', y: 'amount', z: 'height' } },
  'story-missing-column', { path: 'story.steps[0].viz.z', column: 'height' })
caught('two story steps with one id',
  (d) => { d.story.steps.push({ id: 's1', sheet: 'sales' }) },
  'duplicate-story-step', { path: 'story.steps[1]' })

caught('a measure whose grain sheet is gone', (d) => { d.measures.rev.grain = 'gone' },
  'measure-missing-grain', { path: 'measures.rev', severity: 'suspicious' })
caught('a measure naming a column its grain sheet does not have',
  (d) => { d.measures.rev.expr = 'SUM(revenue)' },
  'unknown-formula-ref', { path: 'measures.rev' }, '"revenue"')

caught('a pivot over a sheet that is gone', (d) => { sheetOf(d, 'pv').pivot.from = 'gone' },
  'pivot-missing-sheet', { sheet: 'pv', severity: 'suspicious' })
caught('a pivot grouping by a column that is gone',
  (d) => { sheetOf(d, 'pv').pivot.rows = ['district'] },
  'pivot-missing-column', { sheet: 'pv', column: 'district' })
caught('a pivot value aggregating with a function that does not exist',
  (d) => { sheetOf(d, 'pv').pivot.values[0].fn = 'mode' },
  'unknown-agg', { sheet: 'pv', path: 'pivot.values[0].fn' })
caught('a pivot sheet with no spec', (d) => { delete sheetOf(d, 'pv').pivot },
  'bad-pivot', { sheet: 'pv', severity: 'fatal' })

// ================================================================== CANVAS

section('canvas sheets')

caught('a canvas cell key that is not an address',
  (d) => { sheetOf(d, 'notes').cells['total row'] = { v: 1 } },
  'bad-canvas-key', { sheet: 'notes', severity: 'suspicious' }, 'total row')
caught('a canvas formula calling a function this build lacks',
  (d) => { sheetOf(d, 'notes').cells.B2.f = '=FROBNICATE(A1)' },
  'unknown-function', { sheet: 'notes', path: 'cells.B2' })
caught('a canvas sheet with no cells map', (d) => { delete sheetOf(d, 'notes').cells },
  'bad-canvas-cells', { sheet: 'notes', severity: 'fatal' })
{
  const fs = run((d) => {
    const cells: Record<string, unknown> = {}
    for (let i = 1; i <= 50_001; i++) cells[`A${i}`] = { v: i }
    sheetOf(d, 'notes').cells = cells
  })
  ok(fs.some((f) => f.code === 'canvas-too-large' && f.sheet === 'notes'),
    'a canvas sheet past the sparse-map budget is flagged — it should have been a table sheet')
}

// ============================================================== THE VERDICT

section('the verdict')
{
  const suspicious = validateDoc(
    { ...workbook(), story: { steps: [{ id: 's1', sheet: 'gone' }] } } as unknown as DashDoc,
  )
  ok(suspicious.counts.suspicious > 0 && suspicious.ok === true,
    'suspicious findings do not make a workbook not-ok — it loads, and the caller decides')
  const fatal = validateDoc({ ...workbook(), format: 'x' } as unknown as DashDoc)
  ok(fatal.ok === false && fatal.counts.fatal > 0, 'a fatal finding does')
  ok(validateDoc({} as unknown as DashDoc).findings.length > 0,
    'an empty object is answered rather than thrown on')
  ok(validateDoc(null as unknown as DashDoc).findings[0]?.code === 'bad-document',
    'and so is a null — the signature says DashDoc, the bytes promise nothing')
}

// The document is never touched. A validator that repaired what it found would
// be a second, unreviewed parser.
{
  const before = JSON.stringify(workbook())
  const doc = JSON.parse(before)
  validateDoc(doc)
  ok(JSON.stringify(doc) === before, 'validateDoc does not mutate the document')
}

// ====================================================== NEGATIVE CONTROLS
//
// Each mutant is a PLAUSIBLE implementation of a check above. Each has to be
// caught by an assertion the real implementation passes — a mutant that survives
// means the check it stands in for is decorative.

section('negative controls: each plausible-but-wrong implementation must be caught')

let mutants = 0
let survived = 0
/**
 * `stillPasses` runs the ASSERTION this rig makes against the BROKEN
 * implementation. True means the broken code satisfies it too — the assertion
 * proves nothing and the mutant survived.
 */
function mutant(name: string, stillPasses: () => boolean): void {
  mutants++
  let alive: boolean
  try { alive = stillPasses() } catch { alive = false }
  if (alive) { survived++; console.log(`  ✗ SURVIVED: ${name}`) }
  else console.log(`  ✓ caught:   ${name}`)
}

// M1 — count rows as the number of RUNS rather than the sum of their counts.
// Assertion: a healthy 4-value column against `[[1,4]]` reports no length
// mismatch, i.e. the row count reads 4.
const brokenRows = (rids: Array<[number, number]>): number => rids.length
mutant('row count = rids.length: one run of four rows reads as one row',
  () => brokenRows([[1, 4]]) === 4)

// M2 — sample the dictionary indexes instead of checking every one. Assertion:
// idx [0,1,5,null] against a 2-entry dict is REPORTED.
const sampledDictClean = (idx: Array<number | null>, dictLen: number): boolean =>
  idx.slice(0, 2).every((k) => k === null || (k >= 0 && k < dictLen))
mutant('sampling the first rows of a dict column: a bad index further down is missed',
  () => sampledDictClean([0, 1, 5, null], 2) === false)

// M3 — the ascending-runs check the columnar brief invites. Assertion:
// `[[5,1],[1,3]]` — an ordinary insert at the top — is SILENT.
const runsAscend = (rids: Array<[number, number]>): boolean =>
  rids.every((r, i) => i === 0 || r[0] > rids[i - 1][0])
mutant('requiring ascending runs: a normal top insert is called damage',
  () => runsAscend([[5, 1], [1, 3]]) === true)

// M4 — take "rids in use" from the runs alone. Assertion: an override naming rid
// 9 with nextRid 5 is fatal, because rowcol.ts's own floor counts override rids.
const usedFromRunsOnly = (rids: Array<[number, number]>, _cells: string[]): number =>
  rids.reduce((m, [s, c]) => Math.max(m, s + c - 1), 0)
mutant('reading rids-in-use from the runs alone: a rid only an override names is missed',
  () => usedFromRunsOnly([[1, 4]], ['amount:9']) >= 9)

// M5 — treat an override key as valid whenever it contains a colon. Assertion:
// `ghost:1` on a sheet with no `ghost` column is reported.
const laxKeyClean = (k: string): boolean => k.includes(':')
mutant('accepting any key with a colon: an override on a deleted column is invisible',
  () => laxKeyClean('ghost:1') === false)

// M6 — classify cell-formula references from `dependencies()` alone, which
// cannot tell `[Q1]` (a column) from `Q1` (a cell): the brackets are gone by the
// time it sees a ref node. Assertion: the two are classified DIFFERENTLY.
const naiveRef = (src: string): string =>
  src.replace(/[[\]]/g, '').split(/[^A-Za-z0-9_]+/).filter(Boolean)[0]
mutant('classifying cell refs without a1.ts: [Q1] is indistinguishable from Q1',
  () => naiveRef('[Q1]*2') !== naiveRef('Q1*2'))

console.log(`\n${mutants - survived}/${mutants} mutants caught`)
if (survived) failures += survived

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
