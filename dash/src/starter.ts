// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The workbook a fresh bento/dash file opens with.
//
// THIS IS THE FIRST TEN SECONDS, and for most people it is also the last. It
// ships inside the shell, so it is what bento.page/dash shows and what every
// downloaded copy opens with before anybody has typed anything.
//
// It used to be ONE table of eight sales rows. That was honest and it taught
// nothing: a reader saw a grid, concluded "a worse Excel", and had no way to
// find out otherwise. Everything dash does that a spreadsheet does not — two
// kinds of sheet, a formula that is one expression rather than one per row, a
// total that cannot fall out of range, a sheet that says where its rows came
// from — was invisible in the one view a stranger ever sees.
//
// So it opens with ONE OF EACH KIND, and the difference is the lesson:
//
//   · `Pipeline` is a DATASET (`kind:'table'`) — typed by COLUMN, exactly the
//     rows there are. It carries a column formula, a totals row that is a
//     property rather than a range, a validation list, a conditional format,
//     and a provenance step.
//   · `Scratch` is a SPREADSHEET (`kind:'canvas'`) — typed by CELL, unbounded,
//     `=SUM(` anywhere. It reads ACROSS to the dataset, which is the part that
//     shows the two kinds are one workbook and not two apps.
//
// TEACHING BY DOING, NOT BY LABELLING. Every feature here is doing a job a
// person would actually want done. The one concession is a single line of prose
// on the Scratch sheet, which is a cell holding a sentence — the idiom a
// spreadsheet already has, not chrome bolted on.
//
// DELIBERATELY ABSENT: chart, pivot, dashboard, story, 3D and SQL. Each is real
// and each would make this a demo reel. A starter has to be something you can
// delete a row from and keep using, and the two sheets below survive being
// edited by somebody who does not care what we were trying to show them.
//
// IT MUST STAY SMALL. This is bytes in every shell, and boot was fought from
// 952ms down to 93ms. Two small sheets cost almost nothing; a fixture with a
// thousand rows would cost every reader forever.

import { FORMAT, FORMAT_VERSION, type CanvasSheet, type DashDoc, type TableSheet } from './model.ts'

const uid = (p: string): string =>
  `${p}-${(typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.floor(Date.now() % 1e8).toString(36))}`

const REGION = ['North', 'South', 'North', 'East', 'South', 'North', 'East', 'South']
const OWNER = ['Priya', 'Sam', 'Priya', 'Lee', 'Sam', 'Lee', 'Priya', 'Sam']
const STAGE = ['Won', 'Open', 'Won', 'Open', 'Lost', 'Won', 'Open', 'Won']
const VALUE = [12400, 8200, 15600, 4300, 9100, 22750, 6400, 18300]
const CLOSED = [
  '2026-01-14', '2026-02-03', '2026-02-19', '2026-03-02',
  '2026-03-11', '2026-03-24', '2026-04-08', '2026-04-21',
]
const PROB = [1, 0.4, 1, 0.25, 0, 1, 0.6, 1]

const dict = (values: string[], of: string[]) =>
  ({ enc: 'dict' as const, dict: of, idx: values.map((v) => of.indexOf(v)) })

/**
 * The DATASET half. Typed by column, and every column says what it is.
 *
 * Column order is load-bearing for the Scratch sheet: A1 addressing on a
 * dataset walks the VISIBLE columns, so `value` must stay the fourth (D) and
 * `weighted` the last (G) or the cross-sheet sums over there quietly point at
 * the wrong data. `test-dash-starter.ts` pins both by NAME rather than trusting
 * this comment.
 */
export function starterSheet(): TableSheet {
  return {
    id: 'sheet-pipeline',
    name: 'Pipeline',
    kind: 'table',
    rids: [[1, REGION.length]],
    columns: [
      { id: 'region', name: 'Region', type: 'text', role: 'label', w: 120 },
      { id: 'owner', name: 'Owner', type: 'text', w: 110 },
      // A VALIDATION LIST, because a shared workbook is where this earns its
      // keep: three people typing "won", "Won" and "WON" is the reason a Stage
      // column is worth constraining. `warn` rather than `reject` — see
      // datavalid.ts on why a reject that ran on apply could discard a peer's
      // committed edit.
      {
        id: 'stage', name: 'Stage', type: 'text', w: 110,
        validate: { kind: 'list', list: ['Won', 'Open', 'Lost'], on: 'warn' },
      },
      { id: 'value', name: 'Value', type: 'money', unit: 'GBP', format: '£#,##0', w: 120 },
      { id: 'closed', name: 'Closed', type: 'date', parsed: 'iso', w: 120 },
      { id: 'prob', name: 'Probability', type: 'percent', format: '0%', w: 110 },
      // THE HEADLINE DIFFERENCE, and the reason this column exists at all.
      // Excel needs `=D2*F2` written once and filled down eight times, and it
      // falls out of step the moment somebody inserts a row. This is ONE
      // expression for the column: one stored string, one graph node, one
      // vectorised pass, and a new row is computed because it is a row.
      {
        id: 'weighted', name: 'Weighted', type: 'money', unit: 'GBP',
        format: '£#,##0', w: 120, formula: 'value * prob',
      },
    ],
    data: {
      // repetitive columns dictionary-encode; the numeric ones stay raw —
      // the same choice the importer makes, so the starter is shaped like
      // something you could actually have imported
      region: dict(REGION, ['North', 'South', 'East']),
      owner: dict(OWNER, ['Priya', 'Sam', 'Lee']),
      stage: dict(STAGE, ['Won', 'Open', 'Lost']),
      // COPIED, not referenced. These are module-level constants, so handing
      // the arrays themselves out made every starter share one set of values:
      // edit one workbook and the next `starterDoc()` came back already
      // edited. The app builds one starter per boot so a reader never saw it,
      // but a rig that builds two and mutates the first is then measuring the
      // second through the first's changes — a false result that looks like a
      // finding, which is the worst kind.
      value: { enc: 'raw', v: [...VALUE] },
      closed: { enc: 'raw', v: [...CLOSED] },
      prob: { enc: 'raw', v: [...PROB] },
      // `weighted` has NO stored data on purpose: a computed column keeps its
      // expression and nothing else, which is what makes it impossible for the
      // bytes and the declaration to disagree.
    },
    // The totals row is the Excel *table* total, not =SUM(D2:D9): it cannot
    // fall out of range when somebody appends a row, which the range form does
    // silently and constantly. It also follows the FILTER — filter to Open and
    // the number under the column is the open pipeline, which is Excel's own
    // table semantics (`SUBTOTAL(109,…)`) rather than a deviation from them.
    totals: { value: 'sum', weighted: 'sum', prob: 'avg' },
    // One conditional format, on the column somebody would actually scan.
    // Four of the six rule kinds had no UI until recently; this is the most
    // used format in the world and it is here so it is visibly a thing dash
    // does, not a thing dash could do.
    condfmt: {
      value: [{
        kind: 'cellValue', op: '>', value: 15000,
        style: { bg: '#e7f5ec', color: '#14532d' },
      }],
    },
    // steps[0] is ALWAYS the provenance record. Here it says the rows were
    // typed rather than imported, which is true and is the point: a dash file
    // always answers "where did this come from?".
    steps: [{
      op: 'import', from: 'the starter workbook', at: '', rows: REGION.length,
      note: 'Typed in, not imported — replace it with your own data.',
    }],
  } as TableSheet
}

/**
 * The SPREADSHEET half — and the reason the workbook has two sheets.
 *
 * Nothing here could live on the dataset, and that is the lesson. It is typed
 * per CELL, so a label sits beside a number and a percentage sits under a
 * total; it is unbounded, so `=SUM(` goes below the numbers where a hand
 * naturally puts it; and it reaches ACROSS with `Pipeline!D1:D8`, which is what
 * makes the two kinds one workbook rather than two applications.
 *
 * The A1 rule, settled in docs/dash-sheet-kinds.md: a row number is the row
 * that sheet paints in its own gutter. A dataset's gutter counts DATA rows —
 * the header is chrome — so `Pipeline!D1:D8` is the eight deals and not seven
 * of them plus a heading.
 */
export function starterScratch(): CanvasSheet {
  return {
    id: 'sheet-scratch',
    name: 'Scratch',
    kind: 'canvas',
    cols: { A: 150, B: 130, C: 30, D: 340 },
    // Row 1 is tall because the sentence in D1 WRAPS. It was one long line and
    // it clipped — "put anything anywhere…" — which is a poor advertisement for
    // a cell that is explaining the app. Wrapping rather than trimming, because
    // the sentence has to survive seven translations of the surrounding UI and a
    // reader who has bumped their font size; a length tuned to this font in this
    // locale is a clip waiting to happen.
    rows: { '1': 56 },
    cells: {
      A1: { v: 'Scratch', bold: true },
      // The one line of prose, and it is a cell like any other — select it and
      // the formula bar shows a sentence, which is itself the point being made.
      D1: {
        v: 'Typed by CELL: put anything anywhere, and =SUM( below the numbers. '
          + 'The Pipeline tab is typed by COLUMN — it knows exactly which rows exist.',
        color: '#5B6B80', wrap: true,
      },

      A3: { v: 'From the Pipeline', bold: true },
      A4: { v: 'Total value' },
      B4: { f: '=SUM(Pipeline!D1:D8)', format: '£#,##0' },
      A5: { v: 'Weighted' },
      B5: { f: '=SUM(Pipeline!G1:G8)', format: '£#,##0' },
      A6: { v: 'Confidence' },
      B6: { f: '=B5/B4', format: '0%' },

      A8: { v: 'What if', bold: true },
      A9: { v: 'Target' },
      // 100k against a weighted 77k. Chosen so the gap is POSITIVE and the
      // sheet says something a person would say — "we need another 23k". At
      // 60k the weighted pipeline already beat the target and the row read
      // "Gap to target −£17,245", which is arithmetically right and reads as a
      // mistake in the first ten seconds.
      B9: { v: 100000, format: '£#,##0' },
      A10: { v: 'Gap to target' },
      // The gesture the whole frontier decision was about: a formula UNDER the
      // numbers, in a cell nobody created first.
      B10: { f: '=B9-B5', format: '£#,##0', bold: true, bg: '#FFF4D6' },
    },
  }
}

export function starterDoc(): DashDoc {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    policy: 'bento-dash-1',
    docId: uid('doc'),
    title: 'Untitled workbook',
    // Pipeline FIRST: it is what the file-manager thumbnail renders (preview.ts
    // draws page one), and a grid of real numbers says more at 200px than a
    // sheet of labels does.
    sheets: [starterSheet(), starterScratch()],
    measures: {
      'Weighted pipeline': {
        name: 'Weighted pipeline',
        expr: 'SUM(value * prob)',
        grain: 'sheet-pipeline',
        additive: true,
        unit: 'GBP',
        desc: 'Open value discounted by probability. Won counts in full; lost counts nothing.',
      },
    },
    theme: {
      background: '#FFFFFF',
      color: '#1E2A3A',
      accent: '#F7A600',
      fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    },
  }
}
