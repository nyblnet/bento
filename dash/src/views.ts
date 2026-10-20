// Table views — grid, kanban, gallery, calendar — as pure projections.
//
// docs/dash-unified.md. A view is a saved way of looking at the SAME rows:
// every kind starts from one filtered, sorted row order (filter.ts's
// `buildOrder`, the grid's own), and then arranges it. Moving a card on a
// kanban writes the card's `by` cell and nothing else, so the grid, every other
// view and every collaborator see the same edit.
//
// Values are read through a `Get` the caller supplies, so a calculated column
// or a lookup reads as it does in the grid without this module knowing how
// either is computed.

import { buildOrder, toFilters, isBlank, matchKey, type Get } from './filter.ts'
import type { Column, TableSheet, TableView } from './model.ts'
import type { Patch } from './store.ts'
import { formatValue } from './format.ts'

/** The rid at a row position. */
function ridAt(t: TableSheet, row: number): number {
  let i = row
  for (const [start, count] of t.rids) {
    if (i < count) return start + i
    i -= count
  }
  return -1
}

const rowsOf = (t: TableSheet): number => t.rids.reduce((n, [, k]) => n + k, 0)

/** The view's row order: positions, filtered then sorted. Filters naming a
 *  column the table no longer has are dropped rather than hiding every row. */
export function viewOrder(t: TableSheet, view: TableView | undefined, get: Get): number[] {
  const known = new Set(t.columns.map((c) => c.id))
  const filters = toFilters(view?.filter).filter((f) => known.has(f.col))
  const sorts = (view?.sort ?? []).filter((s) => known.has(s.col))
  return buildOrder(rowsOf(t), get, filters, sorts)
}

/** The columns a view shows, in table order. */
export const shownColumns = (t: TableSheet, view: TableView | undefined): Column[] =>
  t.columns.filter((c) => !view?.hidden?.includes(c.id))

// --- kanban ------------------------------------------------------------------

export interface Lane {
  /** the value cards in this lane hold; null = the "no value" lane */
  value: unknown
  label: string
  rows: number[]
}

/**
 * Lanes for a kanban view: one per category, in the column's declared
 * `options` order, then any other values in first-seen order, then the
 * no-value lane LAST (Airtable's "Uncategorized"), always present so a card
 * can be dragged out of every lane. Cards keep the view's sort within a lane.
 */
export function kanbanLanes(t: TableSheet, view: TableView, get: Get): Lane[] | null {
  const by = t.columns.find((c) => c.id === view.by)
  if (!by) return null
  const lanes = new Map<string, Lane>()
  const lane = (v: unknown): Lane => {
    const k = isBlank(v) ? '\u0000blank' : matchKey(v)
    let l = lanes.get(k)
    if (!l) {
      l = { value: isBlank(v) ? null : v, label: isBlank(v) ? '' : formatValue(v, by), rows: [] }
      lanes.set(k, l)
    }
    return l
  }
  const opts = (by as { options?: unknown }).options
  for (const o of Array.isArray(opts) ? opts : []) lane(o)
  for (const r of viewOrder(t, view, get)) lane(get(by.id, r)).rows.push(r)
  const out = [...lanes.values()].filter((l) => l.value !== null)
  out.push(lanes.get('\u0000blank') ?? { value: null, label: '', rows: [] })
  return out
}

/** The patch that moves card `row` to the lane holding `value`. */
export function moveCard(t: TableSheet, view: TableView, row: number, value: unknown): Patch | null {
  const by = t.columns.find((c) => c.id === view.by)
  const rid = ridAt(t, row)
  if (!by || rid < 0) return null
  return { op: 'setCells', sheet: t.id, col: by.id, rids: [rid], v: [isBlank(value) ? null : value] }
}

// --- calendar ----------------------------------------------------------------

/** `YYYY-MM-DD` of a stored date, or null. Dates are stored as ISO strings. */
export function dayOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

export interface CalendarMonth {
  /** weeks of 7 days, Monday first; each day `YYYY-MM-DD`, or null outside the month */
  weeks: Array<Array<string | null>>
  /** day → the rows on it, in view order */
  byDay: Map<string, number[]>
  /** rows with no date — shown beside the month so they are never lost */
  undated: number[]
}

/** One month of a calendar view. `month` is 1–12. */
export function calendarMonth(t: TableSheet, view: TableView, get: Get, year: number, month: number): CalendarMonth | null {
  const by = t.columns.find((c) => c.id === view.by)
  if (!by) return null
  const byDay = new Map<string, number[]>()
  const undated: number[] = []
  const prefix = `${year}-${String(month).padStart(2, '0')}-`
  for (const r of viewOrder(t, view, get)) {
    const d = dayOf(get(by.id, r))
    if (!d) { undated.push(r); continue }
    if (!d.startsWith(prefix)) continue
    const list = byDay.get(d) ?? []
    list.push(r)
    byDay.set(d, list)
  }
  // Monday-first weeks. Date.UTC so a viewer's time zone can never move a day.
  const first = new Date(Date.UTC(year, month - 1, 1))
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const lead = (first.getUTCDay() + 6) % 7
  const cells: Array<string | null> = Array(lead).fill(null)
  for (let d = 1; d <= days; d++) cells.push(`${prefix}${String(d).padStart(2, '0')}`)
  while (cells.length % 7) cells.push(null)
  const weeks: Array<Array<string | null>> = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return { weeks, byDay, undated }
}

/** The patch that moves record `row` to `day` (`YYYY-MM-DD`). */
export function moveToDay(t: TableSheet, view: TableView, row: number, day: string): Patch | null {
  const by = t.columns.find((c) => c.id === view.by)
  const rid = ridAt(t, row)
  if (!by || rid < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  return { op: 'setCells', sheet: t.id, col: by.id, rids: [rid], v: [day] }
}

// --- gallery -----------------------------------------------------------------

export interface Card {
  row: number
  rid: number
  title: string
  /** the cover attachment's first asset key, if the view names one */
  cover?: string
  fields: Array<{ name: string; text: string }>
}

/** Cards for a gallery view: title from the first shown column, the rest as fields. */
export function galleryCards(t: TableSheet, view: TableView, get: Get): Card[] {
  const cols = shownColumns(t, view).filter((c) => c.id !== view.cover)
  const [head, ...rest] = cols
  return viewOrder(t, view, get).map((row) => {
    const cover = view.cover ? get(view.cover, row) : undefined
    const first = Array.isArray(cover) ? cover.find((x) => typeof x === 'string') : typeof cover === 'string' ? cover : undefined
    return {
      row,
      rid: ridAt(t, row),
      title: head ? formatValue(get(head.id, row), head) : '',
      ...(first ? { cover: first as string } : {}),
      fields: rest
        .map((c) => ({ name: c.name, text: formatValue(get(c.id, row), c) }))
        .filter((f) => f.text !== ''),
    }
  })
}
