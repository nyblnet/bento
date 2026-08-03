// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The workbook a fresh bento/dash file opens with.
//
// It has to teach the app in one screen, so it is deliberately not empty and
// deliberately not a lorem-ipsum grid: it is a small, real-shaped table with
// every column type dash knows, a totals row, and a provenance step — because
// those three are what distinguish this from a spreadsheet, and none of them is
// discoverable from an empty document.

import { FORMAT, FORMAT_VERSION, type DashDoc, type TableSheet } from './model.ts'

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

export function starterSheet(): TableSheet {
  return {
    id: 'sheet-pipeline',
    name: 'Pipeline',
    kind: 'table',
    rids: [[1, REGION.length]],
    columns: [
      { id: 'region', name: 'Region', type: 'text', role: 'label', w: 120 },
      { id: 'owner', name: 'Owner', type: 'text', w: 120 },
      { id: 'stage', name: 'Stage', type: 'text', w: 110 },
      { id: 'value', name: 'Value', type: 'money', unit: 'GBP', format: '£#,##0', w: 130 },
      { id: 'closed', name: 'Closed', type: 'date', parsed: 'iso', w: 130 },
      { id: 'prob', name: 'Probability', type: 'percent', format: '0%', w: 130 },
    ],
    data: {
      // repetitive columns dictionary-encode; the numeric ones stay raw —
      // the same choice the importer makes, so the starter is shaped like
      // something you could actually have imported
      region: { enc: 'dict', dict: ['North', 'South', 'East'], idx: REGION.map((r) => ['North', 'South', 'East'].indexOf(r)) },
      owner: { enc: 'dict', dict: ['Priya', 'Sam', 'Lee'], idx: OWNER.map((o) => ['Priya', 'Sam', 'Lee'].indexOf(o)) },
      stage: { enc: 'dict', dict: ['Won', 'Open', 'Lost'], idx: STAGE.map((s) => ['Won', 'Open', 'Lost'].indexOf(s)) },
      value: { enc: 'raw', v: VALUE },
      closed: { enc: 'raw', v: CLOSED },
      prob: { enc: 'raw', v: PROB },
    },
    // The totals row is the Excel *table* total, not =SUM(D2:D9): it cannot
    // fall out of range when somebody appends a row, which the range form does
    // silently and constantly.
    totals: { value: 'sum', prob: 'avg' },
    // steps[0] is ALWAYS the provenance record. Here it says the rows were
    // typed rather than imported, which is true and is the point: a dash file
    // always answers "where did this come from?".
    steps: [{ op: 'import', from: 'the starter workbook', at: '', rows: REGION.length, note: 'Typed in, not imported — replace it with your own data.' }],
  }
}

export function starterDoc(): DashDoc {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    policy: 'bento-dash-1',
    docId: uid('doc'),
    title: 'Untitled workbook',
    sheets: [starterSheet()],
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
