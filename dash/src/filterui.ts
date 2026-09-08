// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The column menu: a checklist of the values that are really there, and the
// operators a filter is normally written with.
//
// WHAT THIS REPLACES, and why it is a widening rather than a rewrite. The menu
// this grew out of offered ONE box per column — "Contains" on a text column,
// "Greater than" on a number one. Everything underneath it was already right:
// `filter.ts` has carried sixteen predicates and a deduped distinct-value list
// from the beginning, `store.order[sheetId]` has always been the one view
// vector, and the composition across columns works ("Stage contains Open +
// Value greater than 50000" → "4 of 11 rows", correct). What was missing was
// any way to SAY the other fifteen things. So this module is a surface over an
// engine that was already there, and it writes through exactly the same door:
// `grid.setFilter` → `grid.applyView` → `store.view` → `store.order`. There is
// no second way to hide a row here, which is the one thing that would make the
// footer totals and the grid disagree.
//
// FIVE DECISIONS, each of which is a trap taken the other way:
//
//   1. THE LIST IS BUILT FROM THE ROWS THE OTHER COLUMNS LEAVE, and NOT from
//      the whole sheet. This is Excel's rule and it is the useful one: after
//      "Region = North" the Stage list holds the stages that occur in the
//      North, so ticking one cannot produce an empty grid. The exception is
//      THIS column's own filter, which is dropped before the list is built —
//      include it and unticking a value deletes its own box, and the reader
//      can never tick it back. That asymmetry is the whole subtlety, and it is
//      why `listRows` takes the column it is FOR.
//   2. THE LIST IS COMPUTED ONCE, WHEN THE MENU OPENS, and does not re-derive
//      while it is open. Ticking applies immediately (the status line under the
//      grid answers within the same click), so a live list would delete boxes
//      out from under the pointer as they were unticked.
//   3. A CAP, AND A SEARCH THAT DEFEATS IT. 50,000 distinct values is not a
//      checklist and never can be. The list stops at `LIST_CAP` and SAYS SO,
//      and the search box re-scans the column rather than filtering the visible
//      thousand — so the value at position 40,000 is reachable by typing three
//      letters of it. A capped list that cannot be searched past is a menu that
//      tells the reader their data is not there.
//   4. TICKED IS AN INCLUDE LIST, ALWAYS. `isOneOf` holds what to KEEP, so
//      "everything ticked" is normalised to NO filter (rather than to an
//      `isOneOf` of the whole column, which would be a filter that re-runs a
//      full-column match per row for no effect, and which would light the
//      column's filtered caret for a filter that filters nothing). It also
//      means a truncated list is still usable: tick the three you want.
//   5. ONE FILTER PER COLUMN, because that is what `grid.setFilter` stores and
//      what the story format round-trips. So a condition REPLACES a checklist
//      and vice versa, and the menu says which one is live rather than showing
//      two controls that quietly overwrite each other.
//
// The operator vocabulary is condfmt.ts's `CompareOp`, imported rather than
// re-spelled: `>`, `between`, `startsWith` and the rest already mean these
// things in the conditional-format rules, and two differently-spelled operator
// sets in one application is a translation layer waiting to be got wrong.
// filter.ts's `Predicate` is the other half, and `toPredicate` below is the
// only bridge between them.
//
// EVERYTHING ABOVE `openColumnMenu` IS PURE — no DOM, no store — so the rig can
// drive the decisions rather than the pixels.

import './filter.css'
import { dismissable } from './gridmenu.ts'
import { t } from './i18n.ts'
import type { CompareOp } from './condfmt.ts'
import type { ColumnType, TableSheet } from './model.ts'
import type { ColumnFilter, Predicate } from './filter.ts'
import { BLANK_KEY, buildOrder, distinctValues, matchKey } from './filter.ts'
import { readCell, type Store } from './store.ts'
import {
  autoFitWidth, setHidden, freezeAt, readFrozen, resizeColumn,
} from './rowcol.ts'

/**
 * The menu's operators: condfmt's twelve, plus the three a FILTER has that a
 * highlight does not.
 *
 * `notContains` is filter.ts's spelling (condfmt has no such rule); `topN` and
 * `bottomN` are filter.ts's too, and are the same two things condfmt calls a
 * `TopNRule` with a `bottom` flag. Where the two vocabularies already agree —
 * `contains`, `startsWith`, `endsWith`, `between`, `blank`, `notBlank` — the
 * word is shared and means the same thing on both sides.
 */
export type FilterOp = CompareOp | 'notContains' | 'topN' | 'bottomN'

/** How many boxes a list may hold before it admits it is partial. */
export const LIST_CAP = 1000

/** Ops whose operand is a SUBSTRING, taken verbatim and never read as a number. */
const TEXTUAL = new Set<FilterOp>(['contains', 'notContains', 'startsWith', 'endsWith'])

/**
 * How many operand boxes an op needs: 0, 1, or 2.
 *
 * A menu that draws a box for `is empty` invites a value that will be ignored,
 * which is the same defect the bounce test found in the number-pattern panel:
 * a control that accepts input and does nothing with it.
 */
export function opArity(op: FilterOp): 0 | 1 | 2 {
  if (op === 'blank' || op === 'notBlank') return 0
  return op === 'between' ? 2 : 1
}

/**
 * The operators offered for a column, MOST LIKELY FIRST.
 *
 * Every op is offered on every column and that is deliberate: a `text` column
 * full of digits is the single most common shape in an imported sheet (finding
 * 1 of the bounce test), and hiding "greater than" from it because the header
 * says `text` would hide the operator from the column that needs it most.
 * `filter.ts`'s comparisons are type-aware by INSPECTION for exactly this
 * reason. What the column type changes is the ORDER, which is the honest use
 * of a declared type: it is a good guess about what will be asked, and a bad
 * rule about what may be.
 */
export function opsFor(type: ColumnType): FilterOp[] {
  const numeric: FilterOp[] = ['>', '>=', '<', '<=', 'between', 'topN', 'bottomN']
  const textual: FilterOp[] = ['contains', 'notContains', 'startsWith', 'endsWith']
  const common: FilterOp[] = ['=', '<>']
  const empty: FilterOp[] = ['blank', 'notBlank']
  // A date is an ordering column whose ordering reads as a RANGE: "between" is
  // what a date filter is for, and it leads. ISO dates sort chronologically as
  // text (import.ts stores them that way on purpose), so `between` over two
  // typed dates is a real date range and not a coincidence.
  // "the five latest" is a real question about a date column, so the rank ops
  // come with the ordering ones rather than being treated as arithmetic.
  if (type === 'date') {
    return ['between', '>=', '<=', '>', '<', 'topN', 'bottomN', ...common, ...textual, ...empty]
  }
  if (type === 'number' || type === 'money' || type === 'percent') {
    return [...numeric, ...common, ...textual, ...empty]
  }
  return [...common, ...textual, ...numeric, ...empty]
}

/**
 * The dropdown's words.
 *
 * A LITERAL t() per label rather than one over a lookup table, for the reason
 * condfmtui.ts states at its own `opLabel`: the extraction rig sweeps literal
 * calls out of the source, and a t() whose argument is a table lookup is
 * invisible to it. The twelve shared with condfmtui are spelled IDENTICALLY —
 * same key, same catalog entry, one translation.
 */
export function filterOpLabel(op: FilterOp): string {
  switch (op) {
    case '>': return t('greater than')
    case '>=': return t('greater than or equal to')
    case '<': return t('less than')
    case '<=': return t('less than or equal to')
    case '=': return t('equal to')
    case '<>': return t('not equal to')
    case 'between': return t('between')
    case 'contains': return t('contains')
    case 'notContains': return t('does not contain')
    case 'startsWith': return t('starts with')
    case 'endsWith': return t('ends with')
    case 'blank': return t('is empty')
    case 'notBlank': return t('is not empty')
    case 'topN': return t('is in the top')
    default: return t('is in the bottom')
  }
}

/** Currency glyphs and spaces a person types and does not mean. */
const MONEY = /[£$€¥₹\s]/g
const PERCENT = /^([+-]?[\d.,]+)\s*%$/

/**
 * What the reader typed, as a value the predicate can compare.
 *
 * TWO THINGS ARE WRONG IN THE OBVIOUS VERSION, and the menu this replaces had
 * both:
 *
 *   · `Number(v.replace(/[,\s£$€¥%]/g, ''))` strips the percent sign and keeps
 *     the digits, so "50%" arrives as 50 — and a percent column STORES THE
 *     FRACTION (import.ts:281), so every comparison in that column came out
 *     wrong by a factor of a hundred while looking perfectly reasonable. Here a
 *     percent is DIVIDED, and a bare number typed against a percent column is
 *     divided too, because the column shows "50%" and 50 is what the reader
 *     reads off the screen.
 *   · `Number('')` is 0 and `Number('n/a')` is NaN. An empty box must not
 *     become "greater than 0" (a filter nobody asked for) and a NaN bound must
 *     not become a comparison that silently matches nothing. Empty returns `''`
 *     and the caller reads that as "no filter"; unparseable text is handed back
 *     AS TEXT, where filter.ts's kind check refuses it against a number column
 *     rather than inventing an answer.
 */
export function parseOperand(raw: string, type: ColumnType): unknown {
  const s = raw.trim()
  if (s === '') return ''
  const pct = PERCENT.exec(s)
  if (pct) {
    const n = Number(pct[1].replace(/,/g, ''))
    if (Number.isFinite(n)) return n / 100
  }
  const bare = s.replace(MONEY, '').replace(/,/g, '')
  const n = Number(bare)
  if (bare !== '' && Number.isFinite(n)) return type === 'percent' ? n / 100 : n
  return s
}

/**
 * The condition half of the menu, as a predicate — or null for "not a filter".
 *
 * NULL IS AN ANSWER, not a failure: an op with an empty operand is a filter
 * still being written, and the caller clears the column rather than applying
 * something. The alternative is what filter.ts warns about at `between` — a
 * half-typed bound that empties the grid and reads as a broken application.
 *
 * `topN` REFUSES a non-positive or fractional n. "Top 0" is nothing and "top
 * 2.5" is not a question; both would otherwise reach `rankFilter`, which
 * answers the first with an empty grid.
 */
export function buildPredicate(
  op: FilterOp, a: string, b: string, type: ColumnType,
): Predicate | null {
  if (op === 'blank') return { op: 'isBlank' }
  if (op === 'notBlank') return { op: 'notBlank' }
  if (TEXTUAL.has(op)) {
    const v = a.trim()
    if (v === '') return null
    return { op: op as 'contains' | 'notContains' | 'startsWith' | 'endsWith', v }
  }
  if (op === 'topN' || op === 'bottomN') {
    const n = Number(a.trim())
    if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) return null
    return { op, n }
  }
  if (op === 'between') {
    const lo = parseOperand(a, type)
    const hi = parseOperand(b, type)
    // both ends open is not a filter; ONE end open is (filter.ts treats a blank
    // bound as unbounded on that side, which is how "after March" is written)
    if (lo === '' && hi === '') return null
    return { op: 'between', lo: lo === '' ? null : lo, hi: hi === '' ? null : hi }
  }
  const v = parseOperand(a, type)
  if (v === '') return null
  switch (op) {
    case '=': return { op: 'equals', v }
    case '<>': return { op: 'notEquals', v }
    case '>': return { op: 'greater', v }
    case '>=': return { op: 'greaterOrEqual', v }
    case '<': return { op: 'less', v }
    default: return { op: 'lessOrEqual', v }
  }
}

/**
 * The reverse, for re-opening a menu onto a filter that is already applied.
 *
 * A menu that always opens on "greater than, empty" is a menu that cannot be
 * ADJUSTED: the reader has to remember what they set and retype it, and the
 * commonest filter edit — nudge the threshold — becomes a re-authoring.
 * Returns null for the predicates the condition half does not draw
 * (`isOneOf` is the checklist; those are shown as ticks, not as an op).
 */
export function readPredicate(
  pred: Predicate,
): { op: FilterOp; a: string; b: string } | null {
  const s = (v: unknown): string => (v == null ? '' : String(v))
  switch (pred.op) {
    case 'isBlank': return { op: 'blank', a: '', b: '' }
    case 'notBlank': return { op: 'notBlank', a: '', b: '' }
    case 'contains': case 'notContains': case 'startsWith': case 'endsWith':
      return { op: pred.op, a: pred.v, b: '' }
    case 'equals': return { op: '=', a: s(pred.v), b: '' }
    case 'notEquals': return { op: '<>', a: s(pred.v), b: '' }
    case 'greater': return { op: '>', a: s(pred.v), b: '' }
    case 'greaterOrEqual': return { op: '>=', a: s(pred.v), b: '' }
    case 'less': return { op: '<', a: s(pred.v), b: '' }
    case 'lessOrEqual': return { op: '<=', a: s(pred.v), b: '' }
    case 'between': return { op: 'between', a: s(pred.lo), b: s(pred.hi) }
    case 'topN': case 'bottomN': return { op: pred.op, a: String(pred.n), b: '' }
    default: return null
  }
}

/**
 * The checklist half, as a predicate — or null for "everything is ticked, so
 * this is not a filter".
 *
 * `known` maps every key the menu has ever shown to its original value, and it
 * accumulates ACROSS SEARCHES: tick "North" under the search "nor", type
 * "sou", tick "South", and both are still ticked and both are still applyable.
 * A menu that rebuilt its state from the visible rows would silently drop the
 * first one, which is a filter the reader watched themselves build.
 *
 * The normalisation to null is guarded on `complete`: a list narrowed by a
 * search or cut off by the cap is NOT the whole column, so "every visible box
 * is ticked" says nothing about the column and must not be read as "no filter".
 */
export function checklistPredicate(
  ticked: Set<string>,
  known: Map<string, unknown>,
  full: { keys: Set<string>; complete: boolean },
): Predicate | null {
  if (full.complete) {
    let all = ticked.size >= full.keys.size
    if (all) for (const k of full.keys) if (!ticked.has(k)) { all = false; break }
    if (all) return null
  }
  const set = new Set<unknown>()
  // `known.get` rather than the key itself: `isOneOf` matches by re-keying the
  // ORIGINAL values, so a set holding the canonical string "n:10" would match
  // the cell holding the text "n:10" and nothing else.
  for (const k of ticked) set.add(known.has(k) ? known.get(k) : k)
  return { op: 'isOneOf', set }
}

/**
 * One line naming the filter that is live on this column — the banner at the
 * top of the menu, so that "why is this column showing four rows" is answered
 * where it is asked rather than in the status bar under the grid.
 */
export function describeFilter(pred: Predicate): string {
  if (pred.op === 'isOneOf') {
    return t('{n} values ticked').replace('{n}', String(pred.set.size))
  }
  if (pred.op === 'topN') return t('Top {n}').replace('{n}', String(pred.n))
  if (pred.op === 'bottomN') return t('Bottom {n}').replace('{n}', String(pred.n))
  const r = readPredicate(pred)
  if (!r) return ''
  const label = filterOpLabel(r.op)
  if (opArity(r.op) === 0) return label
  if (r.op === 'between') return `${label} ${r.a || '…'} ${t('and')} ${r.b || '…'}`
  return `${label} ${r.a}`
}

/**
 * The rows a column's value list is built from: what the OTHER columns' filters
 * leave showing.
 *
 * Returns null for "every row", which is not the same as an array of every
 * index — the caller passes it straight to `distinctValues`, and null saves
 * materialising a 10-million-element array to say "no narrowing". That is the
 * whole reason this is columnar: at no point does a row exist as an object.
 *
 * Sorts are deliberately NOT applied. The list is sorted by value for display,
 * so the sheet's row order is irrelevant to it, and running the comparator
 * would cost an O(n log n) pass to produce a permutation nothing here reads.
 */
export function listRows(
  rows: number,
  get: (col: string, row: number) => unknown,
  filters: ColumnFilter[],
  forCol: string,
): number[] | null {
  const others = filters.filter((f) => f.col !== forCol)
  if (!others.length) return null
  return buildOrder(rows, get, others, [])
}

// --- the menu ----------------------------------------------------------------

/**
 * What the menu needs from the grid, and no more.
 *
 * A structural type rather than an import of the `Grid` class: grid.ts is a
 * 3,000-line module that owns the canvas, and a menu that named the class would
 * make every rig that drives this menu mount a grid. A real `Grid` satisfies
 * this, so the rig can hand over a real one when what it is proving is that the
 * ROWS change.
 */
export interface GridLike {
  readonly sheet: TableSheet
  readonly canvas: unknown
  computed: Map<string, { length: number } & Record<number, unknown>>
  filters: ColumnFilter[]
  sorts: Array<{ col: string; dir: 'asc' | 'desc' }>
  setFilter(colId: string, f: ColumnFilter | null): void
  addSort(colId: string, dir: 'asc' | 'desc'): void
  clearView(): void
}

export interface ColumnMenuOpts {
  store: Store
  grid: GridLike
  colId: string
  x: number
  y: number
  /** test seam: where the menu mounts. Defaults to `document.body`. */
  root?: HTMLElement
}

const esc = (s: string): string => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const rowsOf = (sheet: TableSheet): number => sheet.rids.reduce((n, [, c]) => n + c, 0)

/**
 * Why this menu cannot open here — `''` when it can.
 *
 * A SPREADSHEET CANNOT BE FILTERED, and this is a refusal with a reason rather
 * than a gap. `kind: 'canvas'` is typed per cell and unbounded: it has no
 * columns to filter BY (every cell in a column may be a different kind of
 * thing), and `A4` in a formula means the fourth row by POSITION — so permuting
 * or hiding rows underneath the addresses would make one reader's `=SUM(B2:B9)`
 * cover different cells than another's. grid.ts's `applyView` already refuses
 * to give a canvas sheet a view vector at all (grid.ts:951) and its header row
 * draws letters with no filter caret, so this is unreachable through the UI —
 * it is here so that a caller reaching it another way is TOLD, in the same
 * shape `tabs.ts actionReason` says it. There is deliberately no `ACTIONS` id
 * for filtering: it is not a toolbar action, it is a column's own menu, and an
 * entry there would be a disabled button for a control that is not on screen.
 */
export function columnMenuReason(grid: GridLike): string {
  if (!grid.canvas) return ''
  return t('Filtering and sorting reorder the rows of a dataset. A spreadsheet has rows of cells, not of records — so there is nothing here to filter by.')
}

/**
 * Open the column menu. Returns the element, or null if it refused.
 *
 * Everything it can change is VIEW state except the three column-chrome items
 * at the foot (hide, fit, freeze), which commit as they always did. Filtering
 * writes no patch, takes no checkpoint and does not dirty the file.
 */
export function openColumnMenu(o: ColumnMenuOpts): HTMLElement | null {
  if (columnMenuReason(o.grid)) return null
  // CAPTURED ONCE, at the moment the caret was clicked — the menu is about THIS
  // sheet's column, and ctrl+PgDn switches sheets without dismissing a popover.
  // Re-reading `grid.sheet` when an item is picked is a throw on a spreadsheet
  // and the wrong sheet's column on another dataset, silently.
  const sheet = o.grid.sheet
  const col = sheet.columns.find((c) => c.id === o.colId)
  if (!col) return null
  const type: ColumnType = col.type ?? 'text'
  const rows = rowsOf(sheet)
  const get = (c: string, row: number): unknown => {
    const comp = o.grid.computed.get(c)
    return comp ? comp[row] : readCell(sheet.data[c], row)
  }

  // --- state -----------------------------------------------------------------

  const live = o.grid.filters.find((f) => f.col === o.colId)?.pred ?? null
  // ONE narrowing pass, at open. See decision 1: this column's own filter is
  // dropped, every other column's is honoured.
  //
  // AND WHEN THIS COLUMN IS NOT FILTERED, THAT PASS IS ALREADY DONE. The view
  // vector IS "the rows the filters leave", and with none of them belonging to
  // this column it is exactly the set wanted — so the common case (open a menu
  // on a fresh column while two others are filtered) re-derives nothing. It is
  // only valid under that condition: reuse it while this column has a filter of
  // its own and the list is narrowed by itself, which is the one-way door
  // decision 1 exists to prevent. Sorting is irrelevant here — `store.order` is
  // a permutation and the list is sorted by value anyway.
  const base = o.grid.filters.some((f) => f.col === o.colId)
    ? listRows(rows, get, o.grid.filters, o.colId)
    : (o.store.order[sheet.id] ?? null)
  const full = distinctValues(get, o.colId, rows, LIST_CAP, { rows: base ?? undefined })
  const fullKeys = new Set(full.values.map(matchKey))
  const known = new Map<string, unknown>()
  for (const v of full.values) known.set(matchKey(v), v)
  // Opening onto an existing checklist shows it as it is; opening onto anything
  // else (a condition, or no filter) shows everything ticked, because that is
  // what the column is currently showing.
  //
  // EXCEPT WHEN THE LIST IS TRUNCATED, and this is the trap in the whole
  // feature. Pre-ticking the 1,000 boxes that fit a 50,000-value column reads
  // as "everything is showing" — and it is, until the first untick, which
  // applies an `isOneOf` of the 999 REMAINING VISIBLE values and silently hides
  // the 49,000 that were never on screen. One click, tens of thousands of rows
  // gone, and a status line the reader has no reason to disbelieve. So a
  // truncated list starts EMPTY and says so: ticking is then an explicit
  // "keep these", which is the only thing a partial list can honestly mean.
  const ticked = new Set<string>(
    live && live.op === 'isOneOf'
      ? [...live.set].map(matchKey)
      : (full.truncated ? [] : fullKeys),
  )
  let shown = full
  let query = ''
  const cond = live ? readPredicate(live) : null
  let op: FilterOp = cond?.op ?? opsFor(type)[0]

  // --- chrome ----------------------------------------------------------------

  const root = o.root ?? document.body
  root.querySelector('.dx-pop')?.remove()
  const el = document.createElement('div')
  el.className = 'dx-pop dfx'
  // `innerWidth` is undefined outside a browser; the rig mounts this menu and
  // does not lay it out.
  const vw = typeof innerWidth === 'number' ? innerWidth : 1280
  const vh = typeof innerHeight === 'number' ? innerHeight : 800
  el.style.left = `${Math.max(4, Math.min(o.x, vw - 300))}px`
  el.style.top = `${Math.max(4, Math.min(o.y, vh - 80))}px`
  root.appendChild(el)

  // The four ways out — Escape, a click outside, an item, a replacement — from
  // gridmenu, so the two things wearing `.dx-pop` behave the same. This built
  // its own element and therefore took the styling of a popover and none of
  // the behaviour: Escape did nothing on the column menu while working on
  // every other menu in the app. Found in a browser; neither rig could see it,
  // because each only knew about its own menu.
  dismissable(el)

  const close = (): void => { el.remove() }

  // --- painting --------------------------------------------------------------

  const listHtml = (): string => {
    const items = shown.values.map((v) => {
      const k = matchKey(v)
      // keyed, not `v === null`: the blank box is the one entry whose label is
      // not its value, and BLANK_KEY is the single spelling of which one it is
      const label = k === BLANK_KEY ? t('(Blanks)') : String(v)
      return `<label class="dfx-item"><input type="checkbox" data-k="${esc(k)}"` +
        `${ticked.has(k) ? ' checked' : ''}><span>${esc(label)}</span></label>`
    }).join('')
    if (!items) {
      return `<div class="dfx-none">${esc(t('Nothing in this column matches that search.'))}</div>`
    }
    return items
  }

  const noteHtml = (): string => {
    if (shown.truncated) {
      return `<div class="dfx-note">${esc(t('Only the first {n} values fit this list. Tick the ones to keep, search to reach the rest, or use a condition below.')
        .replace('{n}', String(LIST_CAP)))}</div>`
    }
    if (base) {
      return `<div class="dfx-note">${esc(t('The values in the rows the other columns’ filters leave showing.'))}</div>`
    }
    return ''
  }

  const opsHtml = (): string => opsFor(type).map((x) =>
    `<option value="${esc(x)}"${x === op ? ' selected' : ''}>${esc(filterOpLabel(x))}</option>`).join('')

  const arity = opArity(op)
  el.innerHTML =
    `<button data-a="asc">${esc(t('Sort A → Z'))}</button>` +
    `<button data-a="desc">${esc(t('Sort Z → A'))}</button>` +
    `<div class="dx-pop-sep"></div>` +
    (live
      ? `<div class="dfx-live"><span>${esc(t('Filtering: {what}').replace('{what}', describeFilter(live)))}</span></div>`
      : '') +
    `<div class="dfx-h">${esc(t('Values'))}</div>` +
    `<input class="dx-pop-in dfx-q" spellcheck="false" placeholder="${esc(t('Search these values'))}" ` +
      `aria-label="${esc(t('Search these values'))}">` +
    `<label class="dfx-item dfx-all"><input type="checkbox" data-all="1"><span>${esc(t('(Select all)'))}</span></label>` +
    `<div class="dfx-list">${listHtml()}</div>` +
    `<div class="dfx-noteslot">${noteHtml()}</div>` +
    `<div class="dx-pop-sep"></div>` +
    `<div class="dfx-h">${esc(t('Condition'))}</div>` +
    `<select class="dx-pop-in dfx-op" aria-label="${esc(t('Condition'))}">${opsHtml()}</select>` +
    `<input class="dx-pop-in dfx-a" spellcheck="false" aria-label="${esc(t('Value'))}"${arity ? '' : ' hidden'}>` +
    `<div class="dfx-and"${arity === 2 ? '' : ' hidden'}>${esc(t('and'))}</div>` +
    `<input class="dx-pop-in dfx-b" spellcheck="false" aria-label="${esc(t('Value'))}"${arity === 2 ? '' : ' hidden'}>` +
    `<button data-a="apply">${esc(t('Apply filter'))}</button>` +
    `<div class="dx-pop-sep"></div>` +
    `<button data-a="clearcol">${esc(t('Clear this column’s filter'))}</button>` +
    `<button data-a="clear">${esc(t('Clear filters and sorts'))}</button>` +
    `<div class="dx-pop-sep"></div>` +
    `<button data-a="hide">${esc(t('Hide this column'))}</button>` +
    `<button data-a="fit">${esc(t('Fit width to content'))}</button>` +
    `<button data-a="freeze">${esc(frozenTo(sheet, o.colId) ? t('Unfreeze columns') : t('Freeze up to this column'))}</button>`

  const listEl = el.querySelector<HTMLElement>('.dfx-list')!
  const noteEl = el.querySelector<HTMLElement>('.dfx-noteslot')!
  const qEl = el.querySelector<HTMLInputElement>('.dfx-q')!
  const allEl = el.querySelector<HTMLInputElement>('[data-all]')!
  const opEl = el.querySelector<HTMLSelectElement>('.dfx-op')!
  const aEl = el.querySelector<HTMLInputElement>('.dfx-a')!
  const andEl = el.querySelector<HTMLElement>('.dfx-and')!
  const bEl = el.querySelector<HTMLInputElement>('.dfx-b')!
  if (cond) { aEl.value = cond.a; bEl.value = cond.b }

  /**
   * Reflect `ticked` onto the boxes.
   *
   * The DOM is a VIEW of the Set and never the other way round: reading state
   * back out of `input.checked` is what makes a search — which rebuilds the
   * list — forget every tick that scrolled out of it.
   */
  const syncBoxes = (): void => {
    listEl.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((b) => {
      b.checked = ticked.has(b.dataset.k!)
    })
    let all = shown.values.length > 0
    for (const v of shown.values) if (!ticked.has(matchKey(v))) { all = false; break }
    allEl.checked = all
  }

  const applyTicks = (): void => {
    o.grid.setFilter(o.colId, predToFilter(o.colId,
      checklistPredicate(ticked, known, { keys: fullKeys, complete: !full.truncated })))
  }

  const repaintList = (): void => {
    shown = distinctValues(get, o.colId, rows, LIST_CAP,
      { rows: base ?? undefined, match: query || undefined })
    for (const v of shown.values) known.set(matchKey(v), v)
    listEl.innerHTML = listHtml()
    noteEl.innerHTML = noteHtml()
    syncBoxes()
  }

  // --- wiring ----------------------------------------------------------------

  // Delegated, because the list is rebuilt on every keystroke of the search and
  // per-box handlers would have to be re-attached with it.
  listEl.addEventListener('click', (e) => {
    const box = (e.target as HTMLElement | null)?.closest?.('input[data-k]') as HTMLInputElement | null
    if (!box) return
    const k = box.dataset.k!
    if (ticked.has(k)) ticked.delete(k); else ticked.add(k)
    syncBoxes()
    applyTicks()
  })

  allEl.addEventListener('click', () => {
    // "Select all" is about the VISIBLE list, which under a search is the
    // searched subset — ticking it must not silently tick 900 values the reader
    // cannot see. Untick clears only those too, for the same reason.
    let all = shown.values.length > 0
    for (const v of shown.values) if (!ticked.has(matchKey(v))) { all = false; break }
    for (const v of shown.values) {
      const k = matchKey(v)
      if (all) ticked.delete(k); else ticked.add(k)
    }
    syncBoxes()
    applyTicks()
  })

  let timer: ReturnType<typeof setTimeout> | null = null
  qEl.addEventListener('input', () => {
    // Debounced: each search is a full column scan (that is what makes a value
    // past the cap reachable), and a 10-million-row column should be scanned
    // once per pause and not once per letter.
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => { query = qEl.value.trim(); repaintList() }, 120)
  })

  opEl.addEventListener('change', () => {
    op = opEl.value as FilterOp
    const n = opArity(op)
    aEl.hidden = n === 0
    andEl.hidden = n !== 2
    bEl.hidden = n !== 2
  })

  el.querySelectorAll<HTMLElement>('button').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.a
      if (a === 'asc' || a === 'desc') o.grid.addSort(o.colId, a)
      else if (a === 'apply') {
        o.grid.setFilter(o.colId,
          predToFilter(o.colId, buildPredicate(op, aEl.value, bEl.value, type)))
      } else if (a === 'clearcol') o.grid.setFilter(o.colId, null)
      else if (a === 'clear') o.grid.clearView()
      else if (a === 'hide') o.store.commit(setHidden(sheet, o.colId, true) as never)
      else if (a === 'freeze') {
        // "up to this column" counts VISIBLE position, which is what the reader
        // pointed at; a hidden column between them would otherwise freeze one
        // more column than the menu item named.
        const at = sheet.columns.filter((c) => !c.hidden).findIndex((c) => c.id === o.colId)
        o.store.commit(freezeAt(sheet, 0, frozenTo(sheet, o.colId) ? 0 : at + 1) as never)
      } else if (a === 'fit') {
        const comp = o.grid.computed.get(o.colId)
        o.store.commit(resizeColumn(sheet, o.colId, autoFitWidth(
          (row) => (comp ? comp[row] : readCell(sheet.data[o.colId], row)), col, rows)) as never)
      }
      // The three view items keep the menu OPEN: sorting then filtering, or
      // ticking a second value, is one gesture in the reader's head and two
      // trips through a menu that closed itself is the friction the bounce test
      // measured. The chrome items close, because their control is now gone.
      if (a !== 'asc' && a !== 'desc' && a !== 'apply' && a !== 'clearcol') close()
    }
  })

  syncBoxes()
  // Dismiss on a click outside, next tick — the click that OPENED the menu is
  // still travelling.
  setTimeout(() => {
    const off = (e: MouseEvent): void => {
      if (!el.contains(e.target as Node)) { close(); document.removeEventListener('mousedown', off) }
    }
    document.addEventListener('mousedown', off)
  }, 0)
  el.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') close() })
  qEl.focus()
  return el
}

const predToFilter = (col: string, pred: Predicate | null): ColumnFilter | null =>
  (pred ? { col, pred } : null)

/** Is the freeze already exactly at this column? Then the item offers to undo it. */
const frozenTo = (sheet: TableSheet, colId: string): boolean => {
  const at = sheet.columns.filter((c) => !c.hidden).findIndex((c) => c.id === colId)
  return readFrozen(sheet).cols === at + 1
}
