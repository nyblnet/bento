#!/usr/bin/env node
// Table views — kanban, calendar, gallery — as projections of the same rows.
//
//   node scripts/test-dash-views.ts
//
// docs/dash-unified.md. Each view starts from the grid's own filtered, sorted
// order; moves are applied with the store's own `applyPatch` and read back,
// so "the card moved" is checked from storage.

import { applyPatch, readCell } from '../dash/src/store.ts'
import { calendarMonth, galleryCards, kanbanLanes, moveCard, moveToDay, viewOrder } from '../dash/src/views.ts'
import type { DashDoc, TableSheet, TableView } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const J = JSON.stringify

function tasks(): TableSheet {
  return {
    id: 'tasks', name: 'Tasks', kind: 'table', rids: [[1, 5]], nextRid: 6, steps: [],
    columns: [
      { id: 'title', name: 'Title', type: 'text' },
      { id: 'stage', name: 'Stage', type: 'enum', options: ['Todo', 'Doing', 'Done'] },
      { id: 'due', name: 'Due', type: 'date' },
      { id: 'pts', name: 'Points', type: 'number' },
      { id: 'pic', name: 'Picture', type: 'text', kind: 'attachment' },
    ],
    data: {
      title: { enc: 'raw', v: ['Write', 'Test', 'Ship', 'Plan', 'Rest'] },
      stage: { enc: 'raw', v: ['Doing', 'Todo', 'Doing', null, 'Blocked'] },
      due: { enc: 'raw', v: ['2026-10-05', '2026-10-31', '2026-11-02', '2026-10-05', null] },
      pts: { enc: 'raw', v: [3, 1, 5, 2, 8] },
      pic: { enc: 'raw', v: [['img-write'], null, ['img-ship', 'img-2'], null, null] },
    },
  } as unknown as TableSheet
}
const getOf = (t: TableSheet) => (c: string, r: number) => readCell(t.data[c], r)
const titles = (t: TableSheet, rows: number[]) => rows.map((r) => readCell(t.data.title, r))

console.log('\nevery view starts from the grid\'s own filtered, sorted order')
{
  const t = tasks()
  const v: TableView = { id: 'v', name: 'Big', kind: 'grid', filter: [{ col: 'pts', pred: { op: 'greater', v: 1 } }], sort: [{ col: 'pts', dir: 'desc' }] }
  ok(J(titles(t, viewOrder(t, v, getOf(t)))) === '["Rest","Ship","Write","Plan"]', 'filter pts > 1, sort by pts descending')
  const stale: TableView = { id: 's', name: 'S', kind: 'grid', filter: [{ col: 'gone', pred: { op: 'isBlank' } }] }
  ok(viewOrder(t, stale, getOf(t)).length === 5, 'a filter on a deleted column is dropped, not allowed to hide every row')
}

console.log('\nkanban lanes')
{
  const t = tasks()
  const v: TableView = { id: 'k', name: 'Board', kind: 'kanban', by: 'stage', sort: [{ col: 'pts', dir: 'desc' }] }
  const lanes = kanbanLanes(t, v, getOf(t))!
  ok(J(lanes.map((l) => l.label)) === '["Todo","Doing","Done","Blocked",""]',
    `declared options first (even an empty one), then other values, then the no-value lane last (got ${J(lanes.map((l) => l.label))})`)
  ok(J(lanes.map((l) => titles(t, l.rows))) === '[["Test"],["Ship","Write"],[],["Rest"],["Plan"]]', 'cards land in their lanes, keeping the view sort (points descending — Ship 5 before Write 3, the reverse of stored order)')
  ok(kanbanLanes(t, { ...v, by: 'nope' }, getOf(t)) === null, 'a board on a missing column is refused, not empty')
}

console.log('\nmoving a card writes its by-cell and nothing else')
{
  const d = { sheets: [tasks()] } as unknown as DashDoc
  const t = d.sheets[0] as TableSheet
  const before = J(t.data.title)
  const p = moveCard(t, { id: 'k', name: 'B', kind: 'kanban', by: 'stage' }, 1, 'Done')!
  applyPatch(d, p as never)
  ok(readCell(t.data.stage, 1) === 'Done', 'Test is now Done in storage')
  ok(J(t.data.title) === before && readCell(t.data.stage, 0) === 'Doing', 'no other cell changed')
  applyPatch(d, moveCard(t, { id: 'k', name: 'B', kind: 'kanban', by: 'stage' }, 1, null)! as never)
  ok(readCell(t.data.stage, 1) === null, 'dragging to the no-value lane clears it')
}

console.log('\ncalendar months')
{
  const t = tasks()
  const m = calendarMonth(t, { id: 'c', name: 'Cal', kind: 'calendar', by: 'due' }, getOf(t), 2026, 10)!
  ok(m.weeks[0][0] === null && m.weeks[0][3] === '2026-10-01', 'October 2026 starts on a Thursday, Monday-first')
  ok(m.weeks.every((w) => w.length === 7) && m.weeks.flat().filter(Boolean).length === 31, 'whole weeks, 31 days')
  ok(J(titles(t, m.byDay.get('2026-10-05') ?? [])) === '["Write","Plan"]', 'two records on the 5th')
  ok(!m.byDay.has('2026-11-02'), 'November\'s record is not in October')
  ok(J(titles(t, m.undated)) === '["Rest"]', 'the undated record is listed beside the month, never lost')
  const d = { sheets: [tasks()] } as unknown as DashDoc
  const tt = d.sheets[0] as TableSheet
  applyPatch(d, moveToDay(tt, { id: 'c', name: 'C', kind: 'calendar', by: 'due' }, 4, '2026-10-20')! as never)
  ok(readCell(tt.data.due, 4) === '2026-10-20', 'dropping a record on a day writes that date')
  ok(moveToDay(tt, { id: 'c', name: 'C', kind: 'calendar', by: 'due' }, 4, '20/10/2026') === null, 'a day that is not ISO is refused')
}

console.log('\ngallery cards')
{
  const t = tasks()
  const cards = galleryCards(t, { id: 'g', name: 'Gal', kind: 'gallery', cover: 'pic', hidden: ['due'] }, getOf(t))
  ok(cards[0].title === 'Write' && cards[0].cover === 'img-write', 'title from the first shown column, cover from the attachment')
  ok(cards[2].cover === 'img-ship', 'a multi-image attachment covers with its first')
  ok(J(cards[0].fields.map((f) => f.name)) === '["Stage","Points"]', 'hidden and cover columns are not repeated as fields')
  ok(!('cover' in cards[1]), 'no attachment, no cover')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
