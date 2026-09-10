// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The CALENDAR layout: a view laid out by date.
//
// ONE ENTRY IN THE CYCLE, TWO SHAPES BEHIND IT. A month grid and a timeline are
// genuinely different pictures — a grid answers "what is this week like" and
// fails completely on data spread over years (thirty-six mostly-empty months to
// page through), while a timeline answers "what happened, in order" and cannot
// show you a shape of a month at all. Both are needed, because this app holds
// both kinds of dated page: journals are dense and daily, a reading list's
// dates are sparse and span years.
//
// They are still not PEERS of board/list/table/gallery. Those four answer four
// different questions; these two answer ONE question ("when?") at two
// densities. And the layout control is a CYCLE, whose cost is linear: a sixth
// shape makes getting back to the board from the middle worse than the shape is
// worth. So the cycle gains one entry, `calendar`, and the month/timeline
// choice is a second control that appears only while you are in it — exactly
// how `groupBy` already works, a board-only parameter with its own button that
// the renderer hides for every other shape.
//
// WHICH DATE A PAGE SORTS BY, and it is a fixed rule rather than a setting:
//
//   1. `page.journal`, when it is a real ISO date. The page IS a day; nothing
//      about that is ambiguous.
//   2. otherwise the first `date`-typed field IN SCHEMA ORDER that this page
//      carries a real ISO value for. Not "the first date field" — a page with
//      an empty Due and a filled Published is dated by Published, or the rule
//      would drop it for carrying the wrong empty box.
//   3. otherwise it has NO DATE, and it is shown saying so. Never dropped: a
//      view that silently holds fewer pages than its own count is the failure
//      this whole file exists to avoid.
//
// The rule is not configurable and the UI says what it is, in words, above the
// grid. A `dateBy` key would be a permanent format field bought to express a
// preference nobody has yet asked for.
//
// TIMEZONES. Every date here is built from COMPONENTS in the reader's own
// timezone — `new Date(y, m - 1, d)` — and never parsed from an ISO string.
// `new Date('2026-01-01')` is UTC midnight by spec, which is 31 December for
// every reader west of Greenwich, so it would put a journal entry in the wrong
// month for a third of the world. journal.ts carries the long version of this
// argument; the rigs run under Kiritimati (+14) and Niue (-11) because that is
// where the bug shows.
//
// The ONE place UTC is correct is `daysApart`, which subtracts two calendar
// dates: built with `Date.UTC` precisely so that no daylight-saving boundary
// sits between them and a difference in milliseconds is an exact whole number
// of days. Local `Date`s would be 23 or 25 hours apart twice a year.
//
// LOCALE. Month names, weekday names and the reader's first day of the week all
// come from `Intl`, never from a table in this file. Two reasons and both are
// load-bearing: a hand-written month map is untranslatable (the extractor
// sweeps `t()` LITERALS, so `t(MONTHS[m])` reaches no catalog while the packer
// reports 100%), and the week does not start on the same day everywhere — the
// grid is shifted, not just relabelled.

import type { SpacesDoc } from './model.ts'
import { fieldsOf, type FieldSpec, type IssueRow } from './fields.ts'
import { isISO, journalLabel, todayISO } from './journal.ts'
import { t } from './i18n.ts'

// ---- the two shapes --------------------------------------------------------

/**
 * The shapes the calendar layout can take, and the order its button cycles.
 *
 * `month` is the ABSENT key, exactly as `board` is for the layout itself: a
 * view toggled to the timeline and back is byte-identical to one nobody
 * touched. A STRING rather than a boolean because `week` and `year` are the
 * obvious next two, and widening a boolean afterwards cannot be done at all.
 */
export const CAL_SPANS = ['month', 'timeline'] as const
export type CalSpan = (typeof CAL_SPANS)[number]

/**
 * The shape a calendar is ACTUALLY in, whatever its block claims.
 *
 * The same discipline `layoutOf` is written in, for the same reason: a view
 * block is plain JSON in a file someone sent you, and `SPAN['toString']` on an
 * object literal is a truthy native function whose string form is
 * `function toString() { [native code] }` — which is what the layout button
 * once rendered as its own label. A membership test on the tuple can never
 * reach `Object.prototype`; a lookup can.
 */
export function spanOf(raw: unknown): CalSpan {
  const s = String(raw ?? 'month')
  return (CAL_SPANS as readonly string[]).includes(s) ? (s as CalSpan) : 'month'
}

/** The next shape: month → timeline → month. */
export function nextSpan(raw: unknown): CalSpan {
  const here = spanOf(raw)
  return CAL_SPANS[(CAL_SPANS.indexOf(here) + 1) % CAL_SPANS.length]
}

// ---- which date ------------------------------------------------------------

/** Every `date`-typed field the schema declares, in its declared order. */
export const dateFieldsOf = (doc: SpacesDoc): FieldSpec[] =>
  fieldsOf(doc).filter((f) => f.vt === 'date')

/**
 * The date this row sits on — `''` when it has none.
 *
 * See the header for the rule. A value that is not a real ISO date is UNDATED
 * rather than guessed at: `2026-13-99` is digit-shaped and is not a day, and
 * every Date-based formatter would roll it confidently into some other real
 * date. Showing it in the "No date" bucket is visible and true; showing it on
 * 9 January 2027 is neither.
 */
export function dateOf(doc: SpacesDoc, row: IssueRow): string {
  const j = row.page.journal
  if (typeof j === 'string' && isISO(j)) return j
  for (const f of dateFieldsOf(doc)) {
    const v = row.values.get(f.key)
    if (typeof v === 'string' && isISO(v)) return v
  }
  return ''
}

/** The rows this view holds, split into days and the ones with no date. */
export interface DateSplit {
  /** ISO day → the rows on it, in the order they arrived */
  days: Map<string, IssueRow[]>
  /** rows the rule found no date for. Shown, never dropped. */
  undated: IssueRow[]
}

export function splitByDate(doc: SpacesDoc, rows: readonly IssueRow[]): DateSplit {
  // A Map, not an object: the keys come from a document someone sent you, and
  // `days['__proto__'] = []` on an object literal writes nowhere and reads back
  // as the prototype. A Map has no prototype keys to collide with.
  const days = new Map<string, IssueRow[]>()
  const undated: IssueRow[] = []
  for (const r of rows) {
    const iso = dateOf(doc, r)
    if (!iso) { undated.push(r); continue }
    const at = days.get(iso)
    if (at) at.push(r)
    else days.set(iso, [r])
  }
  return { days, undated }
}

// ---- calendar arithmetic ---------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')
const isoOf = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`

/** The month an ISO day belongs to, as `YYYY-MM`. `''` for a non-date. */
export const monthOf = (iso: string): string => (isISO(iso) ? iso.slice(0, 7) : '')

const MONTH_SHAPE = /^\d{4}-\d{2}$/

/** Is this a `YYYY-MM` naming a real month? */
export const isMonth = (v: unknown): boolean =>
  typeof v === 'string' && MONTH_SHAPE.test(v) && Number(v.slice(5)) >= 1 && Number(v.slice(5)) <= 12

/**
 * The month `n` months from `ym`, on the CALENDAR.
 *
 * Through the Date constructor so December + 1 is next January and the year
 * carries, rather than `12 + 1 = 13`. Day 1 is safe here in a way day 31 would
 * not be: `new Date(2026, 0, 31 + 1 month)` is 3 March.
 */
export function stepMonth(ym: string, n: number): string {
  if (!isMonth(ym)) return ym
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5))
  const at = new Date(y, m - 1 + n, 1)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}`
}

/**
 * Whole days from `a` to `b`.
 *
 * `Date.UTC`, deliberately, and it is the only UTC in this file. Two local
 * midnights either side of a daylight-saving change are 23 or 25 hours apart,
 * so dividing their difference by 86,400,000 gives 0.958 or 1.042 and rounds
 * wrong. Two UTC midnights are always an exact multiple of a day, and since
 * both inputs are calendar dates rather than instants, no timezone applies to
 * either.
 */
export function daysApart(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

/**
 * WHICH MONTH THE GRID OPENS ON.
 *
 * Today's month when anything at all falls in it — that is the month a reader
 * of a journal wants and the one they would otherwise have to navigate to every
 * single time. Otherwise the month of the dated row NEAREST today, so a space
 * whose entries are all in 2019 opens on 2019 instead of on an empty grid with
 * no clue that the data is elsewhere. Ties go to the later of the two, because
 * "the next thing" beats "the last thing" when both are equally far off.
 */
export function defaultMonth(isos: readonly string[], today: string): string {
  const here = monthOf(today) || monthOf(todayISO())
  const dated = isos.filter((d) => isISO(d))
  if (!dated.length) return here
  if (dated.some((d) => monthOf(d) === here)) return here
  let best = dated[0]
  let bestGap = Math.abs(daysApart(best, today))
  for (const d of dated) {
    const gap = Math.abs(daysApart(d, today))
    if (gap < bestGap || (gap === bestGap && d > best)) { best = d; bestGap = gap }
  }
  return monthOf(best)
}

/**
 * The reader's first day of the week, `0` = Sunday … `6` = Saturday.
 *
 * The week does not start on Monday everywhere — Sunday in the US, Japan and
 * Brazil, Saturday across much of the Middle East — and this SHIFTS THE GRID
 * rather than relabelling it, so getting it wrong puts every entry in the wrong
 * column. `Intl.Locale`'s week info is the only place a browser knows this;
 * it arrived as a method (`getWeekInfo()`) and shipped in some engines as a
 * property (`weekInfo`), and older ones have neither, so all three cases are
 * handled and the floor is Monday (ISO 8601).
 */
export function firstWeekday(loc?: string): number {
  try {
    const L = new Intl.Locale(loc || 'en') as unknown as {
      getWeekInfo?: () => { firstDay?: number }
      weekInfo?: { firstDay?: number }
    }
    const fd = (typeof L.getWeekInfo === 'function' ? L.getWeekInfo()?.firstDay : undefined)
      ?? L.weekInfo?.firstDay
    // 1 = Monday … 7 = Sunday in the spec; 7 % 7 === 0 puts Sunday first.
    if (typeof fd === 'number' && fd >= 1 && fd <= 7) return fd % 7
  } catch {
    // an engine with no Intl.Locale at all, or a tag it will not parse
  }
  return 1
}

/**
 * The seven column headings, in the reader's own order and language.
 *
 * From Intl and a KNOWN WEEK, never a table of English words: 1 January 2024
 * was a Monday, so 7 January 2024 was a Sunday and `+ weekday` walks the week
 * from there. Built local-midnight, so no timezone can shift a name by a day.
 */
export function weekdayNames(loc?: string): string[] {
  const start = firstWeekday(loc)
  const out: string[] = []
  for (let i = 0; i < 7; i++) {
    const at = new Date(2024, 0, 7 + ((start + i) % 7))
    try {
      out.push(new Intl.DateTimeFormat(loc, { weekday: 'short' }).format(at))
    } catch {
      out.push(['S', 'M', 'T', 'W', 'T', 'F', 'S'][(start + i) % 7])
    }
  }
  return out
}

/** "August 2026", in the reader's language. Falls back to the raw `YYYY-MM`. */
export function monthLabel(ym: string, loc?: string): string {
  if (!isMonth(ym)) return ym
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5))
  try {
    return new Intl.DateTimeFormat(loc, { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1))
  } catch {
    return ym
  }
}

export interface CalCell {
  iso: string
  /** the day number as it is printed */
  day: number
  /** false for the days of the neighbouring months that fill out the weeks */
  inMonth: boolean
}

/**
 * The cells of one month's grid, in reading order, WHOLE WEEKS.
 *
 * The classic failure is a fixed cell count. A month grid is 28, 35 or 42 cells
 * depending on the month and on where the reader's week starts — February 2026
 * is exactly four weeks if your week starts on Sunday and five if it starts on
 * Monday, and August 2026 is six either way. Hard-coding 42 leaves a trailing
 * empty week most months; hard-coding 35 silently LOSES the last days of a
 * six-week month. So the count is derived, and the rig counts cells.
 *
 * The neighbouring months' days are real cells rather than blanks, and entries
 * on them are drawn: a grid whose corners are holes reads as broken, and an
 * entry on the 1st of next month is exactly what somebody looking at the last
 * week of this one wants to see.
 */
export function monthGrid(ym: string, loc?: string): CalCell[] {
  if (!isMonth(ym)) return []
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5))
  const lead = (new Date(y, m - 1, 1).getDay() - firstWeekday(loc) + 7) % 7
  // day 0 of the NEXT month is the last day of this one — the standard way to
  // ask a Date how long a month is, leap years included
  const days = new Date(y, m, 0).getDate()
  const total = Math.ceil((lead + days) / 7) * 7
  const cells: CalCell[] = []
  for (let i = 0; i < total; i++) {
    // the constructor rolls a negative or over-long day into the neighbouring
    // month for us, which is the whole reason the loop can be this short
    const at = new Date(y, m - 1, 1 - lead + i)
    cells.push({
      iso: isoOf(at),
      day: at.getDate(),
      inMonth: at.getMonth() === m - 1 && at.getFullYear() === y,
    })
  }
  return cells
}

/**
 * The days a timeline lists, NEWEST FIRST.
 *
 * One direction, chosen rather than configured. Newest-first is the order this
 * app already reads dated pages in (`journalsOf`), the dominant dated content
 * in a space is journal entries, and the end you want without scrolling is the
 * recent one — a five-year journal opened oldest-first is five years of
 * scrolling to reach today.
 */
export const timelineDays = (days: Map<string, IssueRow[]>): string[] =>
  [...days.keys()].sort((a, b) => b.localeCompare(a))

// ---- what the header says --------------------------------------------------

/**
 * The sentence above the grid saying WHICH DATE it used.
 *
 * Said out loud because the rule is fixed: a reader looking at a page in the
 * wrong week needs to know the view is reading `Due` and not the thing they
 * were thinking of. Whole sentences with one interpolated list, not a sentence
 * assembled from fragments — the fragments do not agree in gender or order
 * across the eight catalogs.
 */
export function dateHint(doc: SpacesDoc): string {
  const fields = dateFieldsOf(doc)
  if (!fields.length) return t('Dated by the journal date.')
  return t('Dated by the journal date, then {fields}.', {
    fields: fields.map((f) => (typeof f.label === 'string' && f.label ? f.label : f.key)).join(', '),
  })
}

// ---- the DOM ---------------------------------------------------------------

/**
 * WHICH MONTH EACH VIEW IS SHOWING — viewer state, never the document.
 *
 * The same call the reduce-motion preference and the locale make: where you
 * have scrolled to is not a property of the document, and writing it there
 * would make paging a month a document edit — an undo entry, a dirty flag, a
 * collaboration op, and a file that differs from the one you were sent because
 * you looked at March.
 *
 * Keyed by block id and held for the session, so the editor's full repaint
 * (every view control commits and calls `paintPage`) does not throw the month
 * away underneath you.
 */
const SHOWN = new Map<string, string>()

/** Test seam: forget every remembered month. */
export const forgetMonths = (): void => { SHOWN.clear() }

export interface CalendarCtx {
  doc: SpacesDoc
  rows: readonly IssueRow[]
  blockId: string
  span: CalSpan
  locale?: string
  /** false in reading view, on paper, and in a locked space */
  editable?: boolean
  /** the view's own card builder, so a timeline entry is the same card a list draws */
  card: (row: IssueRow) => HTMLElement
  /** for the rigs — what "today" is, so a fixture is not a different test tomorrow */
  today?: string
}

/** A link to a page, or a plain label when nothing here is clickable. */
function pageLink(row: IssueRow, editable: boolean | undefined, cls: string): HTMLElement {
  const el = document.createElement(editable === false ? 'span' : 'a')
  el.className = cls
  if (el instanceof HTMLAnchorElement) el.href = `#p/${row.page.id}`
  el.dataset.page = row.page.id
  el.textContent = row.page.title || t('Untitled')
  return el
}

/**
 * The whole layout, drawn into `host`.
 *
 * `host` is emptied and rebuilt by the month arrows IN PLACE, which is why the
 * grid's own entries are plain links and carry no controls: the editor wires
 * `[data-set-field]` buttons once per repaint (`wireBoard`), so a control this
 * function re-created between repaints would be dead. A cell is too small for
 * a status picker anyway. The TIMELINE has room and no in-place re-render, so
 * it uses the view's real card.
 */
export function renderCalendar(host: HTMLElement, ctx: CalendarCtx): void {
  const today = ctx.today ?? todayISO()
  const split = splitByDate(ctx.doc, ctx.rows)

  const hint = document.createElement('p')
  hint.className = 'sp-cal-hint'
  hint.textContent = dateHint(ctx.doc)
  host.appendChild(hint)

  const body = document.createElement('div')
  body.className = 'sp-cal'
  host.appendChild(body)

  const draw = (): void => {
    body.replaceChildren()
    if (ctx.span === 'timeline') drawTimeline(body, ctx, split)
    else drawMonth(body, ctx, split, today, draw)
    drawUndated(body, ctx, split)
  }
  draw()
}

function drawMonth(
  body: HTMLElement, ctx: CalendarCtx, split: DateSplit, today: string, redraw: () => void,
): void {
  const shown = SHOWN.get(ctx.blockId)
    ?? defaultMonth([...split.days.keys()], today)
  SHOWN.set(ctx.blockId, shown)

  const bar = document.createElement('div')
  bar.className = 'sp-cal-bar'
  const step = (n: number, label: string, glyph: string): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'sp-btn sp-cal-step'
    b.textContent = glyph
    b.title = label
    b.setAttribute('aria-label', label)
    b.addEventListener('click', () => { SHOWN.set(ctx.blockId, stepMonth(shown, n)); redraw() })
    return b
  }
  const title = document.createElement('span')
  title.className = 'sp-cal-month'
  title.textContent = monthLabel(shown, ctx.locale)
  const now = document.createElement('button')
  now.type = 'button'
  now.className = 'sp-btn sp-cal-step'
  now.textContent = t('Today')
  now.addEventListener('click', () => { SHOWN.set(ctx.blockId, monthOf(today)); redraw() })
  bar.append(step(-1, t('Previous month'), '‹'), title, step(1, t('Next month'), '›'), now)
  body.appendChild(bar)

  const grid = document.createElement('div')
  grid.className = 'sp-cal-grid'
  for (const name of weekdayNames(ctx.locale)) {
    const h = document.createElement('div')
    h.className = 'sp-cal-wd'
    h.textContent = name
    grid.appendChild(h)
  }

  for (const cell of monthGrid(shown, ctx.locale)) {
    const box = document.createElement('div')
    box.className = 'sp-cal-cell' + (cell.inMonth ? '' : ' sp-cal-out')
    box.dataset.day = cell.iso
    if (cell.iso === today) {
      box.classList.add('sp-cal-today')
      box.title = t('Today')
    }
    const n = document.createElement('div')
    n.className = 'sp-cal-num'
    n.textContent = String(cell.day)
    box.appendChild(n)
    for (const row of split.days.get(cell.iso) ?? []) {
      box.appendChild(pageLink(row, ctx.editable, 'sp-cal-entry'))
    }
    grid.appendChild(box)
  }
  body.appendChild(grid)
}

function drawTimeline(body: HTMLElement, ctx: CalendarCtx, split: DateSplit): void {
  const line = document.createElement('div')
  line.className = 'sp-cal-line'
  for (const iso of timelineDays(split.days)) {
    const day = document.createElement('div')
    day.className = 'sp-cal-day'
    const h = document.createElement('div')
    h.className = 'sp-cal-dayhead'
    h.textContent = journalLabel(iso, ctx.locale)
    day.appendChild(h)
    for (const row of split.days.get(iso) ?? []) day.appendChild(ctx.card(row))
    line.appendChild(day)
  }
  body.appendChild(line)
}

/**
 * The pages the rule found no date for.
 *
 * VISIBLE, and that is the point. A calendar that quietly holds fewer pages
 * than the count beside its own title is a view lying about what it contains —
 * and the pages it drops are exactly the ones somebody forgot to date, which is
 * the thing they most need to see.
 */
function drawUndated(body: HTMLElement, ctx: CalendarCtx, split: DateSplit): void {
  if (!split.undated.length) return
  const box = document.createElement('div')
  box.className = 'sp-cal-undated'
  const h = document.createElement('div')
  h.className = 'sp-cal-dayhead'
  h.textContent = `${t('No date')} · ${split.undated.length}`
  box.appendChild(h)
  const ul = document.createElement('div')
  ul.className = 'sp-cal-undated-list'
  for (const row of split.undated) ul.appendChild(pageLink(row, ctx.editable, 'sp-cal-entry'))
  box.appendChild(ul)
  body.appendChild(box)
}
